/**
 * `assembleTurn`: the final prompt and launch request for one message to one tab.
 *
 * A desktop chat turn is shaped by about thirty inputs spread over three processes (the
 * renderer builds the user prompt and the system prompt, the main process builds the
 * arguments and the environment, the process manager places the prompt). This is the same
 * assembly as one pure function, so a turn started from the TUI is the same agent as one
 * started from the desktop: same system prompt text, same arguments, same environment.
 * `Plans/maestro-tui-prompt-assembly.md` maps every input and records the decisions
 * (PA1 to PA17) this follows.
 *
 * Pure: no I/O, no clock beyond `context.now`, no `process.env`. Everything that has to be
 * read (prompts, settings, git branch, binary) is gathered by `loadTurnContext`; everything
 * with a side effect (the Windows temp file, SSH wrapping, process start) belongs to
 * `runAgentTurn`.
 */

import * as path from 'path';
import { buildCallerIdentityEnv } from '../../agentDelegation';
import { resolveTabPermissionMode } from '../../agentMetadata';
import { substituteTemplateVariables } from '../../templateVariables';
import type { AdditionalDirectory, AgentSshRemoteConfig } from '../../types';
import { filterYoloArgs, getContextWindowValue } from '../launch/agent-args';
import type { AgentLaunchInput } from '../launch/launch-plan';
import type { SystemPromptDelivery } from '../launch/prompt-delivery';
import type { AgentConfig } from '../providers/definitions';
import { applyCopilotPreamble, applySystemPromptDelivery, buildTurnArgs } from './args';
import {
	appendNudgeMessage,
	buildMaestroSystemPrompt,
	buildMessagePrompt,
	expandCommandArguments,
	prependMergedContext,
} from './prompt';

/** The environment variable that names the data directory a process should use. */
const USER_DATA_ENV_VAR = 'MAESTRO_USER_DATA';

/** The agent fields assembly reads. A renderer `Session` and a validated `AgentRecord` both fit. */
export interface TurnAgent {
	id: string;
	name: string;
	toolType: string;
	cwd: string;
	projectRoot?: string;
	fullPath?: string;
	groupId?: string;
	autoRunFolderPath?: string;
	additionalDirectories?: AdditionalDirectory[];
	worktreeConfig?: { basePath?: string };
	isGitRepo?: boolean;
	contextUsage?: number;
	/** Deprecated agent-level id. Read for `{{AGENT_SESSION_ID}}` only, as the desktop does (F6). */
	agentSessionId?: string;
	isPianola?: boolean;
	nudgeMessage?: string;
	newSessionMessage?: string;
	customPath?: string;
	customArgs?: string;
	customEnvVars?: Record<string, string>;
	customModel?: string;
	customEffort?: string;
	customContextWindow?: number;
	sessionSshRemoteConfig?: AgentSshRemoteConfig | null;
	/** Commands the provider discovered that carry a prompt (`resolveSlashCommand`). */
	agentCommands?: { command: string; description?: string; prompt?: string }[];
}

export interface TurnTab {
	id: string;
	agentSessionId?: string | null;
	customModel?: string;
	customEffort?: string;
	readOnlyMode?: boolean;
	permissionMode?: 'full' | 'standard' | 'readonly';
	pendingMergedContext?: string;
}

export interface TurnMessage {
	/** What the person sent, after the composer's own escapes. */
	text: string;
	images?: readonly string[];
	/** Set when the text named a Maestro command (`resolveSlashCommand`). */
	command?: { command: string; description?: string; prompt: string; args: string };
	/** Frozen when the message was queued. Absent: read the live tab. */
	turnSettings?: { model?: string; effort?: string };
	/** The queue item was read-only when it was queued. */
	readOnly?: boolean;
}

export interface TurnContext {
	/** The provider with its capabilities (`AgentConfig`: definition, capabilities, path). */
	provider: AgentConfig;
	/** The binary to run on this machine: the agent's valid custom path, the provider's, or the probed one. */
	command: string;
	/** `maestro-agent-configs.json` `configs[toolType]`. */
	providerConfig: Readonly<Record<string, unknown>>;
	/** Settings -> Environment (`shellEnvVars`). */
	globalEnvVars?: Readonly<Record<string, string>>;
	conductorProfile?: string;
	prompts: {
		/** Absent when it could not be loaded: the turn goes without one, as on desktop. */
		maestroSystem?: string;
		pianolaSystem?: string;
		imageOnlyDefault: string;
		copilotPreamble?: string;
	};
	/** Read only when `agent.isGitRepo`, local agents only (PA5). */
	gitBranch?: string;
	/** The agent's history file when it exists. Ignored for SSH. */
	historyFilePath?: string;
	/** The `maestro-cli.js` script agents should call (PA6). */
	maestroCliPath?: string;
	/** The data dir the host serves, stamped as `MAESTRO_USER_DATA` (PA8). */
	userDataDir?: string;
	/** An Auto Run on this agent holds its working tree. Always false until L6 (PA13). */
	autoRunHoldsTree?: boolean;
	/** The person forced this send past the queue. */
	forceParallel?: boolean;
	isWindowsHost: boolean;
	/** Clock for date variables. */
	now: Date;
}

export interface TurnUserEntry {
	/** The transcript's user entry (CH-5): what was sent, never the hidden layers. */
	text: string;
	images?: string[];
	readOnly?: true;
	aiCommand?: { command: string; description?: string };
}

export interface AssembledTurn {
	/** The provider the turn runs on, with its capabilities: what `runAgentTurn` reads about it. */
	provider: AgentConfig;
	entry: TurnUserEntry;
	/**
	 * The prompt before the system prompt and the Copilot preamble are folded in: every
	 * hidden layer of the message (nudge, new-session message, read-only instruction,
	 * merged context). The desktop's renderer hands the spawn exactly this as `prompt`.
	 */
	userPrompt: string;
	/** The prompt the provider receives: `userPrompt` with the embedded system prompt and the Copilot preamble. */
	prompt: string;
	/** Maestro's system prompt after substitution. */
	systemPrompt?: string;
	systemPromptDelivery: SystemPromptDelivery;
	/** What the turn is attributed to (turn setting pills), frozen at send. */
	settings: { provider: string; model?: string; effort?: string };
	readOnly: boolean;
	permissionMode: 'full' | 'standard' | 'readonly';
	resumeSessionId?: string;
	/** `tab.pendingMergedContext` went into `prompt`: clear it when the turn starts (PA17). */
	consumedMergedContext: boolean;
	/** For usage reports. */
	contextWindow: number;
	/**
	 * Everything `buildAgentLaunchPlan` needs except `sshStore`, which `runAgentTurn`
	 * supplies from the stored settings. For `file` delivery the caller writes the
	 * system prompt and appends `--append-system-prompt-file <path>` to `args`.
	 */
	launch: Omit<AgentLaunchInput, 'sshStore'>;
}

export type AssembleTurnResult =
	| { ok: true; turn: AssembledTurn }
	| { ok: false; reason: 'empty' | 'no-batch-mode'; message: string };

function stringRecord(value: unknown): Record<string, string> | undefined {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
	const entries = Object.entries(value).filter(
		(entry): entry is [string, string] => typeof entry[1] === 'string'
	);
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/**
 * Assemble one turn. Refuses a provider that cannot run a single turn without a terminal,
 * and a message with nothing in it (no text, no image, no command).
 */
export function assembleTurn(
	agent: TurnAgent,
	tab: TurnTab,
	message: TurnMessage,
	context: TurnContext
): AssembleTurnResult {
	const provider = context.provider;
	if (!provider.capabilities.supportsBatchMode) {
		return {
			ok: false,
			reason: 'no-batch-mode',
			message: `${provider.name} cannot run a single turn without a terminal`,
		};
	}
	const images = message.images ? [...message.images] : [];
	const hasImages = images.length > 0;
	if (!message.text.trim() && !hasImages && !message.command) {
		return { ok: false, reason: 'empty', message: 'There is nothing to send' };
	}

	const sshEnabled = agent.sessionSshRemoteConfig?.enabled === true;

	// Read-only: the message, the tab, or an Auto Run holding the working tree.
	const readOnly =
		message.readOnly === true ||
		tab.readOnlyMode === true ||
		tab.permissionMode === 'readonly' ||
		(context.autoRunHoldsTree === true && context.forceParallel !== true);
	const permissionMode = readOnly ? 'readonly' : resolveTabPermissionMode(tab);

	// Model and effort: frozen at queue time when the message carries them, even where a field
	// inside is undefined (the agent default was chosen then); else the live tab, then the agent.
	const model = message.turnSettings
		? message.turnSettings.model
		: (tab.customModel ?? agent.customModel);
	const effort = message.turnSettings
		? message.turnSettings.effort
		: (tab.customEffort ?? agent.customEffort);
	const resumeSessionId = tab.agentSessionId || undefined;

	// The user prompt.
	let userPrompt: string;
	let consumedMergedContext = false;
	let entry: TurnUserEntry;
	if (message.command) {
		// A Maestro command follows the desktop's command path: arguments expanded, then template
		// variables (without the history path, F13). No nudge, no new-session message, no merged
		// context, and no read-only instruction.
		userPrompt = substituteTemplateVariables(
			expandCommandArguments(message.command.prompt, message.command.args),
			{
				session: agent,
				gitBranch: sshEnabled ? undefined : context.gitBranch,
				groupId: agent.groupId,
				activeTabId: tab.id,
				conductorProfile: context.conductorProfile,
				maestroCliPath: context.maestroCliPath,
				now: context.now,
			}
		);
		entry = {
			text: userPrompt,
			aiCommand: {
				command: message.command.command,
				...(message.command.description ? { description: message.command.description } : {}),
			},
		};
	} else {
		const layered = buildMessagePrompt({
			text: appendNudgeMessage(message.text, agent.nudgeMessage),
			hasImages,
			imageOnlyDefault: context.prompts.imageOnlyDefault,
			hasProviderSession: !!resumeSessionId,
			newSessionMessage: agent.newSessionMessage,
			readOnly,
		});
		userPrompt = prependMergedContext(layered, tab.pendingMergedContext);
		consumedMergedContext = !!tab.pendingMergedContext;
		entry = { text: message.text };
	}
	if (hasImages) entry.images = images;
	if (readOnly) entry.readOnly = true;

	// The system prompt. The template not loading means the turn goes without one.
	const systemPrompt = context.prompts.maestroSystem
		? buildMaestroSystemPrompt({
				template: context.prompts.maestroSystem,
				session: agent,
				gitBranch: sshEnabled ? undefined : context.gitBranch,
				groupId: agent.groupId,
				activeTabId: tab.id,
				historyFilePath: sshEnabled ? undefined : context.historyFilePath,
				conductorProfile: context.conductorProfile,
				maestroCliPath: context.maestroCliPath,
				now: context.now,
				pianolaPrompt: agent.isPianola ? context.prompts.pianolaSystem : undefined,
			})
		: undefined;

	// Arguments: the provider's own, minus bypass flags when read-only, then the system prompt.
	const providerArgs = provider.args ?? [];
	const turnArgs = buildTurnArgs({
		provider,
		baseArgs: readOnly ? filterYoloArgs(providerArgs, provider) : [...providerArgs],
		prompt: userPrompt,
		cwd: agent.cwd,
		readOnly,
		permissionMode,
		resumeSessionId,
		additionalDirectories: agent.additionalDirectories,
		providerConfig: context.providerConfig,
		sessionCustomModel: model,
		sessionCustomEffort: effort,
		sessionCustomArgs: agent.customArgs,
		sessionCustomEnvVars: agent.customEnvVars,
	});
	const placement = applySystemPromptDelivery({
		systemPrompt,
		args: turnArgs.args,
		prompt: userPrompt,
		supportsAppendSystemPrompt: !!provider.capabilities.supportsAppendSystemPrompt,
		isResume: !!resumeSessionId,
		isWindowsHost: context.isWindowsHost,
		sshRemote: sshEnabled,
	});
	const finalPrompt =
		applyCopilotPreamble(provider.id, placement.prompt, context.prompts.copilotPreamble) ??
		userPrompt;

	// What Maestro states about this spawn.
	const maestroEnvVars: Record<string, string> = {
		...buildCallerIdentityEnv(agent.id, tab.id),
		...(agent.isPianola && context.maestroCliPath
			? { MAESTRO_CLI_JS: context.maestroCliPath, MAESTRO_AGENT_ID: agent.id }
			: {}),
		...(context.userDataDir ? { [USER_DATA_ENV_VAR]: context.userDataDir } : {}),
	};

	const extraPathDirs =
		!sshEnabled && path.isAbsolute(context.command) ? [path.dirname(context.command)] : undefined;

	return {
		ok: true,
		turn: {
			provider,
			entry,
			userPrompt,
			prompt: finalPrompt,
			systemPrompt,
			systemPromptDelivery: placement.delivery,
			settings: { provider: agent.toolType, model, effort },
			readOnly,
			permissionMode,
			resumeSessionId,
			consumedMergedContext,
			contextWindow: getContextWindowValue(
				provider,
				context.providerConfig as Record<string, unknown>,
				agent.customContextWindow
			),
			launch: {
				surface: 'desktop',
				agent: provider,
				command: context.command,
				remoteCommand: agent.customPath || provider.binaryName,
				args: placement.args,
				cwd: agent.cwd,
				prompt: finalPrompt,
				hasImages,
				globalShellEnvVars: context.globalEnvVars ? { ...context.globalEnvVars } : undefined,
				agentCustomEnvVars: stringRecord(context.providerConfig.customEnvVars),
				sessionCustomEnvVars: agent.customEnvVars,
				readOnlyMode: readOnly,
				maestroEnvVars,
				isResuming: !!resumeSessionId,
				querySource: 'user',
				extraPathDirs,
				sshRemoteConfig: agent.sessionSshRemoteConfig,
				isWindowsHost: context.isWindowsHost,
			},
		},
	};
}
