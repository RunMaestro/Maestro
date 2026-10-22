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
 *
 * The system prompt's inputs are read by one function, for a chat turn and for a turn with no
 * tab alike (a group chat participant, a consult), so the same agent is told the same thing
 * however its turn was started.
 */

import * as fs from 'fs';
import { computerHistoryDir } from '../../computer-history/paths';
import { readMaestroRunReadyPath } from '../../maestro-run/state-file';
import { systemPromptSectionsFor } from '../../maestroSystemPrompt';
import { PROMPT_IDS } from '../../promptDefinitions';
import { logger } from '../host';
import { getShellPath } from '../launch/getShellPath';
import type { BinaryDetectionResult } from '../launch/path-prober';
import type { MaestroPaths } from '../paths/resolve';
import { readGitBranch } from '../runtime/git';
import { createPromptLoaderFor, type PromptLoader } from '../prompts/load';
import { getAgentCapabilities } from '../providers/capabilities';
import { getAgentDefinition, type AgentConfig } from '../providers/definitions';
import { readAgentConfigsStore, readSettingsStore } from '../store/read-stores';
import { historyFilePath } from '../store/read-history';
import type { TurnAgent, TurnContext } from './assemble';
import { locateProviderBinary } from './provider-binary';
import { isPianolaEnabled } from '../../agentVisibility';
import {
	buildAgentSystemPrompt,
	buildPluginSectionsSystemPrompt,
	type SystemPromptContext,
	type TurnCommand,
} from './prompt';

const LOG_CONTEXT = '[TurnContext]';

/** Where the inputs of Maestro's system prompt are read from. */
export interface SystemPromptSources {
	paths: Pick<MaestroPaths, 'userDataDir' | 'settingsFile' | 'historyDir'>;
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
	/**
	 * The MaestroRun launcher, from a host that inspects it itself and found it ready. Absent:
	 * the answer the desktop app last recorded in the data directory, which is all a process with
	 * no MaestroRun service can know (the CLI reads the same file). No record reads as not ready,
	 * and the section stays out.
	 */
	maestroRunPath?: string;
	/** The Computer History store, from a host that keeps it elsewhere. Absent: `<userData>/computer-history`. */
	computerHistoryDir?: string;
	now?: () => Date;
	/** Test seam. */
	readGitBranch?(cwd: string): Promise<string | undefined>;
}

export interface TurnContextSources extends SystemPromptSources {
	paths: Pick<MaestroPaths, 'userDataDir' | 'settingsFile' | 'agentConfigsFile' | 'historyDir'>;
	isWindowsHost?: boolean;
	/** Test seam. */
	probeBinary?(binaryName: string, customPath?: string): Promise<BinaryDetectionResult>;
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

/**
 * The global settings. A file that is missing is "nothing set", and one that is corrupt is
 * reported and treated the same, so one torn file does not stop a turn.
 */
function readSettingsData(settingsFile: string): Record<string, unknown> {
	const settings = readSettingsStore(settingsFile);
	if (settings.status === 'corrupt' || settings.status === 'unreadable') {
		logger.warn(`Settings are ${settings.status}: ${settings.reason}`, LOG_CONTEXT);
	}
	return settings.status === 'ok' ? settings.data : {};
}

/**
 * The prompt loader. No bundled directory means no prompt can load: the turn goes without
 * Maestro's system prompt, as a desktop turn does when the template did not load.
 */
function promptLoaderOf(sources: SystemPromptSources): PromptLoader | undefined {
	return createPromptLoaderFor({
		userDataDir: sources.paths.userDataDir,
		...(sources.bundledPromptsDir ? { bundledPromptsDir: sources.bundledPromptsDir } : {}),
		...(sources.moduleDirectory ? { moduleDirectory: sources.moduleDirectory } : {}),
	});
}

/**
 * The part of the system prompt no agent decides: the enabled plugin sections and the variables
 * they name. The MaestroRun launcher and the Computer History store are on this machine, so a
 * turn on an SSH remote is told about neither, and its `localOnly` sections are not loaded.
 */
function readPluginSectionContext(
	isSsh: boolean,
	sources: SystemPromptSources,
	settingsData: Record<string, unknown>,
	loader: PromptLoader | undefined,
	sectionsOnly = false
): SystemPromptContext & { prompts: { pluginSections: string[] }; now: Date } {
	const maestroRunPath = isSsh
		? undefined
		: (sources.maestroRunPath ?? readMaestroRunReadyPath(sources.paths.userDataDir));
	// A section whose prompt does not load (an older bundle than the app that enabled it) is
	// skipped, so it never costs the agent the rest of its system prompt.
	const pluginSections = systemPromptSectionsFor(settingsData.encoreFeatures, {
		isSsh,
		readyFlags: maestroRunPath ? ['maestroRun'] : [],
		sectionsOnly,
	})
		.map((ref) => loader?.get(ref.promptId))
		.filter((text): text is string => !!text && !!text.trim());
	return {
		prompts: { pluginSections },
		conductorProfile:
			typeof settingsData.conductorProfile === 'string' ? settingsData.conductorProfile : undefined,
		maestroCliPath: sources.maestroCliPath,
		computerHistoryDir: isSsh
			? undefined
			: (sources.computerHistoryDir ?? computerHistoryDir(sources.paths.userDataDir)),
		maestroRunPath,
		now: (sources.now ?? (() => new Date()))(),
	};
}

/** Everything `buildAgentSystemPrompt` reads for `agent`, from settings and a loader already in hand. */
async function readSystemPromptContext(
	agent: TurnAgent,
	sources: SystemPromptSources,
	settingsData: Record<string, unknown>,
	loader: PromptLoader | undefined
): Promise<SystemPromptContext & { now: Date }> {
	const sshEnabled = agent.sessionSshRemoteConfig?.enabled === true;

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

	const shared = readPluginSectionContext(sshEnabled, sources, settingsData, loader);
	return {
		...shared,
		prompts: {
			maestroSystem: loader?.get(PROMPT_IDS.MAESTRO_SYSTEM_PROMPT),
			// Only while the `pianola` flag is on: a dormant Pianola gets no manager role.
			pianolaSystem:
				agent.isPianola && isPianolaEnabled(settingsData.encoreFeatures)
					? loader?.get(PROMPT_IDS.PIANOLA_SYSTEM)
					: undefined,
			pluginSections: shared.prompts.pluginSections,
		},
		gitBranch,
		historyFilePath: historyPath,
	};
}

/**
 * The full Maestro system prompt of a stored agent, for a turn that has no tab: a group chat
 * participant standing for the agent, or a consult put to it. The text the agent's own chat turn
 * carries, less the tab id. Undefined when the template did not load.
 */
export async function loadAgentSystemPrompt(
	agent: TurnAgent,
	sources: SystemPromptSources
): Promise<string | undefined> {
	const context = await readSystemPromptContext(
		agent,
		sources,
		readSettingsData(sources.paths.settingsFile),
		promptLoaderOf(sources)
	);
	return buildAgentSystemPrompt(agent, undefined, context);
}

/**
 * Just the enabled plugin sections, for a turn with no Maestro agent behind it (the Group Chat
 * moderator and its synthesis turn). Synchronous, as the engine's moderator port is. Undefined
 * when no section applies.
 */
export function loadPluginSectionsSystemPrompt(
	sources: SystemPromptSources,
	opts: { isSsh: boolean }
): string | undefined {
	return buildPluginSectionsSystemPrompt(
		readPluginSectionContext(
			opts.isSsh,
			sources,
			readSettingsData(sources.paths.settingsFile),
			promptLoaderOf(sources),
			true
		)
	);
}

/**
 * The system prompt of a turn that stands for a stored agent but has no tab of its own: a group
 * chat participant, or a consult put to the agent. The agent's full prompt, else (no stored agent
 * matches, or its template did not load) the plugin sections alone, as the desktop's group chat
 * builds it. `fallback.isSsh` says where that turn runs when there is no agent to ask.
 */
export async function loadStandInSystemPrompt(
	agent: TurnAgent | undefined,
	sources: SystemPromptSources,
	fallback: { isSsh: boolean }
): Promise<string | undefined> {
	const full = agent ? await loadAgentSystemPrompt(agent, sources) : undefined;
	return full ?? loadPluginSectionsSystemPrompt(sources, fallback);
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
	const sshEnabled = agent.sessionSshRemoteConfig?.enabled === true;

	// Provider config: a file that is missing is "nothing set", and one that is corrupt is
	// reported and treated the same, so one torn file does not stop a turn.
	const configs = readAgentConfigsStore(sources.paths.agentConfigsFile);
	if (configs.status === 'corrupt' || configs.status === 'unreadable') {
		logger.warn(`Agent configs are ${configs.status}: ${configs.reason}`, LOG_CONTEXT);
	}
	const providerConfig = asRecord(
		configs.status === 'ok' ? asRecord(configs.data.configs)[agent.toolType] : undefined
	);
	const settingsData = readSettingsData(sources.paths.settingsFile);

	// The binary. A turn on an SSH remote runs the remote's own binary, so nothing is probed here.
	const command = await locateProviderBinary(definition, {
		agentCustomPath: agent.customPath,
		providerCustomPath:
			typeof providerConfig.customPath === 'string' ? providerConfig.customPath : undefined,
		sshEnabled,
		probe: sources.probeBinary,
	});
	if (!command) {
		return {
			ok: false,
			reason: 'not-installed',
			message: `${definition.name} (${definition.binaryName}) was not found on this machine`,
		};
	}

	// Prompts, and what the system prompt's variables are filled from.
	const loader = promptLoaderOf(sources);
	const system = await readSystemPromptContext(agent, sources, settingsData, loader);

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
			...system,
			prompts: {
				...system.prompts,
				imageOnlyDefault: loader?.get(PROMPT_IDS.IMAGE_ONLY_DEFAULT) ?? '',
				copilotPreamble,
			},
			userDataDir: sources.paths.userDataDir,
			pianolaEnabled: isPianolaEnabled(settingsData.encoreFeatures),
			autoRunHoldsTree: false,
			isWindowsHost: sources.isWindowsHost ?? process.platform === 'win32',
		},
	};
}
