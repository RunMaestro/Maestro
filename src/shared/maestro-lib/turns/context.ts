/**
 * Everything `assembleTurn` needs that has to be READ: the prompts, the settings, the
 * provider config, the git branch, the history file, and the binary.
 *
 * `assembleTurn` is pure so a parity test can run it twice and get the same text. The
 * desktop gathers these inputs through IPC (`prompts:get`, `git:branch`,
 * `history:getFilePath`, `agents:get`); a library client has no IPC, so this reads the
 * same sources from the data directory. It runs once per turn, so an edit made in the
 * desktop (a prompt, the conductor profile, a provider setting) applies to the next TUI
 * turn.
 */

import * as fs from 'fs';
import { PROMPT_IDS } from '../../promptDefinitions';
import { logger } from '../host';
import { getShellPath } from '../launch/getShellPath';
import {
	checkBinaryExists,
	checkCustomPath,
	type BinaryDetectionResult,
} from '../launch/path-prober';
import type { MaestroPaths } from '../paths/resolve';
import { readGitBranch } from '../runtime/git';
import { createPromptLoaderFor } from '../prompts/load';
import { getAgentCapabilities } from '../providers/capabilities';
import { getAgentDefinition, type AgentConfig } from '../providers/definitions';
import { readAgentConfigsStore, readSettingsStore } from '../store/read-stores';
import { historyFilePath } from '../store/read-history';
import type { TurnAgent, TurnContext } from './assemble';
import type { TurnCommand } from './prompt';

const LOG_CONTEXT = '[TurnContext]';

export interface TurnContextSources {
	paths: Pick<MaestroPaths, 'userDataDir' | 'settingsFile' | 'agentConfigsFile' | 'historyDir'>;
	/**
	 * The directory holding the bundled `.md` prompts. Found by probing from
	 * `moduleDirectory` when omitted.
	 */
	bundledPromptsDir?: string;
	/**
	 * The directory of the running bundle, which the bundled-prompt probe is relative to.
	 * Defaults to the directory of the entry script. Not `__dirname`: the TUI is an ES
	 * module, which has none.
	 */
	moduleDirectory?: string;
	/** The `maestro-cli.js` script agents should call (a bare path). */
	maestroCliPath?: string;
	isWindowsHost?: boolean;
	now?: () => Date;
	/** Test seams. */
	probeBinary?(binaryName: string, customPath?: string): Promise<BinaryDetectionResult>;
	readGitBranch?(cwd: string): Promise<string | undefined>;
}

export type TurnContextResult =
	| { ok: true; context: TurnContext; commands: TurnCommand[] }
	| { ok: false; reason: 'unknown-provider' | 'not-installed'; message: string };

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function stringRecord(value: unknown): Record<string, string> | undefined {
	const entries = Object.entries(asRecord(value)).filter(
		(entry): entry is [string, string] => typeof entry[1] === 'string'
	);
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

async function defaultProbe(
	binaryName: string,
	customPath?: string
): Promise<BinaryDetectionResult> {
	return customPath ? checkCustomPath(customPath) : checkBinaryExists(binaryName);
}

/**
 * Read what a turn on `agent` needs. Refuses, before anything is written, a provider this
 * build does not know and a binary that is not on this machine (the desktop fails the same
 * turn later, at spawn, with ENOENT).
 */
export async function loadTurnContext(
	agent: TurnAgent,
	sources: TurnContextSources
): Promise<TurnContextResult> {
	const definition = getAgentDefinition(agent.toolType);
	if (!definition) {
		return {
			ok: false,
			reason: 'unknown-provider',
			message: `Unknown provider "${agent.toolType}"`,
		};
	}
	const capabilities = getAgentCapabilities(agent.toolType);
	const probe = sources.probeBinary ?? defaultProbe;
	const sshEnabled = agent.sessionSshRemoteConfig?.enabled === true;

	// Provider config and the global settings: a file that is missing is "nothing set", and
	// one that is corrupt is reported and treated the same, so one torn file does not stop a turn.
	const configs = readAgentConfigsStore(sources.paths.agentConfigsFile);
	if (configs.status === 'corrupt' || configs.status === 'unreadable') {
		logger.warn(`Agent configs are ${configs.status}: ${configs.reason}`, LOG_CONTEXT);
	}
	const providerConfig = asRecord(
		configs.status === 'ok' ? asRecord(configs.data.configs)[agent.toolType] : undefined
	);
	const settings = readSettingsStore(sources.paths.settingsFile);
	if (settings.status === 'corrupt' || settings.status === 'unreadable') {
		logger.warn(`Settings are ${settings.status}: ${settings.reason}`, LOG_CONTEXT);
	}
	const settingsData = settings.status === 'ok' ? settings.data : {};

	// The binary. A turn on an SSH remote runs the remote's own binary, so nothing is probed here.
	let command: string;
	if (sshEnabled) {
		command = agent.customPath || definition.binaryName;
	} else {
		let detected: BinaryDetectionResult | undefined;
		if (agent.customPath) {
			detected = await probe(definition.binaryName, agent.customPath);
			if (!detected.exists || !detected.path) {
				logger.warn(
					`Ignoring invalid local custom path for ${agent.toolType}: ${agent.customPath}`,
					LOG_CONTEXT
				);
				detected = undefined;
			}
		}
		const providerCustomPath =
			typeof providerConfig.customPath === 'string' ? providerConfig.customPath : undefined;
		if (!detected && providerCustomPath) {
			const viaProvider = await probe(definition.binaryName, providerCustomPath);
			if (viaProvider.exists && viaProvider.path) detected = viaProvider;
		}
		if (!detected) {
			const onPath = await probe(definition.binaryName);
			if (onPath.exists && onPath.path) detected = onPath;
		}
		if (!detected?.path) {
			return {
				ok: false,
				reason: 'not-installed',
				message: `${definition.name} (${definition.binaryName}) was not found on this machine`,
			};
		}
		command = detected.path;
	}

	// Prompts. No bundled directory means no prompt can load: the turn goes without Maestro's
	// system prompt, as a desktop turn does when the template did not load.
	const loader = createPromptLoaderFor({
		userDataDir: sources.paths.userDataDir,
		...(sources.bundledPromptsDir ? { bundledPromptsDir: sources.bundledPromptsDir } : {}),
		...(sources.moduleDirectory ? { moduleDirectory: sources.moduleDirectory } : {}),
	});

	// Git branch and history path are local reads: for an SSH agent they would describe a path on
	// this machine that is not the one the agent works in (F7).
	let gitBranch: string | undefined;
	let historyPath: string | undefined;
	if (!sshEnabled) {
		if (agent.isGitRepo) {
			try {
				gitBranch = await (sources.readGitBranch ?? readGitBranch)(agent.cwd);
			} catch {
				// A branch that cannot be read is an empty variable, not a failed turn.
			}
		}
		const file = historyFilePath(sources.paths.historyDir, agent.id);
		if (fs.existsSync(file)) historyPath = file;
	}

	// The login-shell PATH is cached by the first call; `buildSpawnPath` reads the cache later.
	await getShellPath().catch(() => '');

	const provider: AgentConfig = {
		...definition,
		available: true,
		path: sshEnabled ? undefined : command,
		capabilities,
	};

	const commands: TurnCommand[] = Array.isArray(settingsData.customAICommands)
		? (settingsData.customAICommands as unknown[]).flatMap((entry) => {
				const record = asRecord(entry);
				return typeof record.command === 'string' && typeof record.prompt === 'string'
					? [
							{
								command: record.command,
								prompt: record.prompt,
								...(typeof record.description === 'string'
									? { description: record.description }
									: {}),
							},
						]
					: [];
			})
		: [];

	const pianolaLoaded = agent.isPianola ? loader?.get(PROMPT_IDS.PIANOLA_SYSTEM) : undefined;
	const copilotPreamble =
		agent.toolType === 'copilot-cli' ? loader?.get(PROMPT_IDS.COPILOT_PREAMBLE) : undefined;

	return {
		ok: true,
		commands,
		context: {
			provider,
			command,
			providerConfig,
			globalEnvVars: stringRecord(settingsData.shellEnvVars),
			conductorProfile:
				typeof settingsData.conductorProfile === 'string'
					? settingsData.conductorProfile
					: undefined,
			prompts: {
				maestroSystem: loader?.get(PROMPT_IDS.MAESTRO_SYSTEM_PROMPT),
				pianolaSystem: pianolaLoaded,
				imageOnlyDefault: loader?.get(PROMPT_IDS.IMAGE_ONLY_DEFAULT) ?? '',
				copilotPreamble,
			},
			gitBranch,
			historyFilePath: historyPath,
			maestroCliPath: sources.maestroCliPath,
			userDataDir: sources.paths.userDataDir,
			autoRunHoldsTree: false,
			isWindowsHost: sources.isWindowsHost ?? process.platform === 'win32',
			now: (sources.now ?? (() => new Date()))(),
		},
	};
}
