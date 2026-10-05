/**
 * The shapes a group chat is stored as.
 *
 * `metadata.json` holds a `GroupChat`; the desktop and the headless runtime read
 * and write the same file, so these are the on-disk contract rather than a
 * view model. `src/shared/group-chat-types.ts` carries the renderer-facing
 * types (two fields differ, see `Plans/maestro-tui-group-chat.md` W8); this
 * module is the storage side and is re-exported by the desktop's
 * `group-chat-storage.ts`.
 */

import type {
	GroupChatHistoryEntry,
	GroupChatMessage as GroupChatRoomMessage,
	GroupChatState,
	ModeratorConfig,
} from '../../group-chat-types';
import type { AgentSshRemoteConfig } from '../../types';
import type { ClaudeTokenMode } from '../../claudeTokenMode';
import type { SshRemoteSettingsStore } from '../launch/ssh-remote-resolver';
import type { AgentConfig } from '../providers/definitions';

/**
 * Group chat participant
 * Note: This should stay in sync with shared/group-chat-types.ts
 */
export interface GroupChatParticipant {
	name: string;
	agentId: string;
	/** Internal process session ID (used for routing) */
	sessionId: string;
	/** Agent's session ID (e.g., Claude Code's session GUID for continuity) */
	agentSessionId?: string;
	addedAt: number;
	lastActivity?: number;
	lastSummary?: string;
	contextUsage?: number;
	// Color for this participant (assigned on join)
	color?: string;
	// Stats tracking
	tokenCount?: number;
	messageCount?: number;
	processingTimeMs?: number;
	/** Total cost in USD (optional, depends on provider) */
	totalCost?: number;
	/** SSH remote name (displayed as pill when running on SSH remote) */
	sshRemoteName?: string;
}

/**
 * Group chat metadata
 */
export interface GroupChat {
	id: string;
	name: string;
	createdAt: number;
	updatedAt: number;
	moderatorAgentId: string;
	/** Internal session ID prefix used for routing (e.g., 'group-chat-{id}-moderator') */
	moderatorSessionId: string;
	/** Claude Code agent session UUID (set after first message is processed) */
	moderatorAgentSessionId?: string;
	/** Custom configuration for the moderator agent */
	moderatorConfig?: ModeratorConfig;
	participants: GroupChatParticipant[];
	logPath: string;
	imagesDir: string;
	archived?: boolean;
	/**
	 * When true (the default), the moderator only hands work to an agent whose
	 * Maestro agent is idle. Undefined means enabled - read it through
	 * `requiresIdleParticipants()` in shared/group-chat-types.
	 */
	requireIdleParticipants?: boolean;
}

/**
 * Partial update for group chat metadata
 */
export type GroupChatUpdate = Partial<
	Pick<
		GroupChat,
		| 'name'
		| 'moderatorSessionId'
		| 'moderatorAgentSessionId'
		| 'moderatorAgentId'
		| 'moderatorConfig'
		| 'participants'
		| 'updatedAt'
		| 'archived'
		| 'requireIdleParticipants'
	>
>;

export interface ParticipantRemovalResult {
	chat: GroupChat;
	removed: boolean;
}

/**
 * Partial update for a participant
 */
export type ParticipantUpdate = Partial<
	Pick<
		GroupChatParticipant,
		| 'lastActivity'
		| 'lastSummary'
		| 'contextUsage'
		| 'tokenCount'
		| 'messageCount'
		| 'processingTimeMs'
		| 'agentSessionId'
		| 'totalCost'
	>
>;

// ---------------------------------------------------------------------------
// The engine's ports (`Plans/maestro-tui-group-chat.md` 5.3)
//
// The engine (`router.ts`) owns rounds: routing, delegation, synthesis,
// recovery, watchdogs. Everything it reaches outside itself for is one of
// these, so the desktop and the headless runtime can each answer them.
// ---------------------------------------------------------------------------

/**
 * Session info for matching @mentions to available Maestro agents.
 */
export interface GroupChatSessionInfo {
	id: string;
	name: string;
	toolType: string;
	cwd: string;
	customArgs?: string;
	customEnvVars?: Record<string, string>;
	customModel?: string;
	/** Claude token-source opt-in (Claude Code participants only). See getClaudeTokenMode. */
	enableMaestroP?: boolean;
	/** Refines enableMaestroP: 'interactive' (always TUI) vs 'dynamic' (auto-switch). */
	maestroPMode?: 'interactive' | 'dynamic';
	/** Optional maestro-p script override. */
	maestroPPath?: string;
	/** SSH remote name for display in participant card */
	sshRemoteName?: string;
	/** Full SSH remote config for remote execution */
	sshRemoteConfig?: {
		enabled: boolean;
		remoteId: string | null;
		workingDirOverride?: string;
	};
	/** Auto Run folder path for this session */
	autoRunFolderPath?: string;
	/**
	 * True when this agent is running a turn right now (any AI tab, or a CLI
	 * playbook). Computed live by the provider callback - the persisted session
	 * record always reads idle, so it can never answer this. Group chats with
	 * "only engage idle agents" on hold the delegation until this reads false.
	 */
	isBusy?: boolean;
}

/** Moderator usage for the moderator card. */
export interface ModeratorUsage {
	contextUsage: number;
	totalCost: number;
	tokenCount: number;
}

/** A participant's working state, for its card. */
export type ParticipantState = 'idle' | 'working';

/** The prompts a group chat reads (`src/prompts/group-chat-*.md`). */
export type GroupChatPromptId =
	| 'group-chat-moderator-system'
	| 'group-chat-moderator-synthesis'
	| 'group-chat-participant'
	| 'group-chat-participant-request'
	| 'group-chat-participant-continuation';

/**
 * One spawn as the router describes it. The runner turns it into a process
 * (SSH wrap, Claude spawn mode, Windows shell, then the process manager on the
 * desktop or the run layer headless).
 */
export interface GroupChatSpawn {
	/** Process id; the shapes are in `session-ids.ts`. */
	processId: string;
	providerId: string;
	agent: AgentConfig;
	command?: string;
	args: string[];
	cwd: string;
	prompt?: string;
	customEnvVars?: Record<string, string>;
	agentConfigValues?: Record<string, unknown>;
	sshRemoteConfig?: AgentSshRemoteConfig | null;
	tokenMode?: ClaudeTokenMode;
	maestroPPath?: string;
	readOnlyMode?: boolean;
	/** Label for debug logs (e.g. 'moderator', 'participant: Alice'). */
	debugLabel?: string;
	/** The silence budget a maestro-p run is told, in seconds (`--max-wait`). */
	maxWaitSeconds?: number;
}

/** Starts and stops the processes a round is made of. */
export interface GroupChatTurnRunner {
	/** Start one turn. `success: false` is a refusal: nothing runs and no end will be reported. */
	start(spawn: GroupChatSpawn): Promise<{ success: boolean; pid?: number; error?: string }>;
	/** Stop a turn by its FULL process id. Unknown ids are ignored. */
	stop(processId: string): void;
}

/**
 * What a per-call entry point needs to start a turn. Absent: no turn starts
 * (the message is logged and nothing runs), which is the router's existing
 * "no process manager" branch.
 */
export interface GroupChatLauncher {
	runner: GroupChatTurnRunner;
	/** Resolve a provider to the agent definition a spawn needs, or null when it is not installed. */
	resolveAgent(providerId: string): Promise<AgentConfig | null>;
}

/** Where the engine finds agents, their settings, and the host's shell and SSH setup. */
export interface GroupChatAgentDirectory {
	/** Every agent a mention could resolve to. Empty when the host has none registered. */
	list(): GroupChatSessionInfo[];
	/** The provider's own configuration values (model, effort, context window). */
	providerConfig(providerId: string): Record<string, unknown>;
	/** Environment variables configured for the provider. */
	providerEnvVars(providerId: string): Record<string, string> | undefined;
	/** The conductor profile substituted into the moderator's system prompt. */
	conductorProfile(): string;
	/** The SSH remote store, or null when the host has none. */
	sshStore(): SshRemoteSettingsStore | null;
}

/** The ten UI updates a round raises. Each may be a no-op on a host that renders none of them. */
export interface GroupChatEventSink {
	message(chatId: string, message: GroupChatRoomMessage): void;
	stateChange(chatId: string, state: GroupChatState): void;
	participantsChanged(chatId: string, participants: GroupChatParticipant[]): void;
	moderatorUsage(chatId: string, usage: ModeratorUsage): void;
	historyEntry(chatId: string, entry: GroupChatHistoryEntry): void;
	participantState(chatId: string, name: string, state: ParticipantState): void;
	moderatorSessionIdChanged(chatId: string, sessionId: string): void;
	autoRunTriggered(chatId: string, name: string, filename?: string): void;
	autoRunBatchComplete(chatId: string, name: string): void;
	participantLiveOutput(chatId: string, name: string, chunk: string): void;
}

/**
 * How a finished turn is reported to the engine (`turnEnded`).
 *
 * The exit code is carried for logs only: a participant that returned text has
 * responded whatever the code was, and one that returned none is closed out
 * silently (B1, B2). The engine never branches on it.
 */
export interface GroupChatTurnEnd {
	/** The process id; the engine parses role, chat, and participant from it. */
	processId: string;
	/** The reply text, already read. A runtime reads it from the turn's answer. */
	text?: string;
	/**
	 * Reads the reply text once the engine knows the provider. The desktop reads
	 * its buffered stream-json, whose parser depends on the agent, and the agent
	 * is only known after the chat loads (which the engine does, with its retry).
	 * Ignored when `text` is given.
	 */
	readText?: (providerId: string | undefined) => string;
	/**
	 * What session-not-found detection reads (B5): the desktop's buffered output,
	 * or a runtime's answer plus the stdout and stderr tails. Empty or absent
	 * means the process produced no output at all.
	 */
	rawOutput?: string;
	exitCode?: number | null;
}
