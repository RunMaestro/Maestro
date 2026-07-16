// Shared type definitions for Maestro CLI and Electron app
// These types are used by both the CLI tool and the renderer process
import type { AgentId } from './agentRegistry';

// Agent ID types are sourced from the shared registry. Runtime registry values
// must be imported from `shared/agentRegistry` to keep this type module acyclic.
export type { AgentId } from './agentRegistry';

/**
 * Union type of all valid built-in agent IDs.
 * Derived from the authoritative shared agent registry.
 */
export type ToolType = AgentId;

/**
 * ThinkingMode controls how AI reasoning/thinking content is displayed.
 *
 * - 'off': Thinking is suppressed (parsers do not append `source: 'thinking'`
 *   or `source: 'tool'` log entries in the first place).
 * - 'on' (temporary): Thinking and tool-execution cells are visible while the
 *   agent is busy. Two clearing points apply:
 *     1. Inline: when a new assistant `stdout`/`stderr` chunk arrives, prior
 *        `thinking`/`tool` log entries are dropped (see
 *        `useBatchedSessionUpdates.ts`).
 *     2. On exit: when the agent process exits, any remaining `thinking`/
 *        `tool` log entries are dropped (see `useAgentListeners.ts`
 *        → `cleanupExitedTabLogs`).
 * - 'sticky' (pinned): Thinking and tool cells persist across BOTH of the
 *   above clearing points so the user can review reasoning indefinitely.
 *
 * **Provider contract:** Any agent parser that surfaces reasoning or tool
 * activity MUST tag its renderer log entries with `source: 'thinking'` or
 * `source: 'tool'`. The clearing logic keys off `log.source` alone, so new
 * agent integrations inherit consistent behavior automatically.
 */
export type ThinkingMode = 'off' | 'on' | 'sticky';

/**
 * Capability flags that determine what features are available for each agent.
 *
 * This is the single canonical definition. All other AgentCapabilities types
 * across the codebase must import from here to avoid drift and type-shadowing
 * bugs.
 */
export interface AgentCapabilities {
	/** Agent supports resuming existing sessions (e.g., --resume flag) */
	supportsResume: boolean;

	/** Agent supports read-only/plan mode (e.g., --permission-mode plan) */
	supportsReadOnlyMode: boolean;

	/**
	 * Agent supports the `standard` permission mode with a working live
	 * permission relay (interactive allow/deny). Optional: only set true for
	 * agents whose relay is implemented and verified (currently Claude Code).
	 * When false/undefined, the UI hides `standard` from the permission toggle
	 * rather than expose a non-functional option (it would abort/auto-deny).
	 */
	supportsStandardPermissionMode?: boolean;

	/** Agent outputs JSON-formatted responses (for parsing) */
	supportsJsonOutput: boolean;

	/** Agent provides a session ID for conversation continuity */
	supportsSessionId: boolean;

	/** Agent can accept image inputs (screenshots, diagrams, etc.) */
	supportsImageInput: boolean;

	/** Agent can accept image inputs when resuming an existing session */
	supportsImageInputOnResume: boolean;

	/** Agent supports slash commands (e.g., /help, /compact) */
	supportsSlashCommands: boolean;

	/** Agent stores session history in a discoverable location */
	supportsSessionStorage: boolean;

	/** Agent provides cost/pricing information */
	supportsCostTracking: boolean;

	/** Agent provides token usage statistics */
	supportsUsageStats: boolean;

	/** Agent supports batch/headless mode (non-interactive) */
	supportsBatchMode: boolean;

	/** Agent requires a prompt to start (no eager spawn on session creation) */
	requiresPromptToStart: boolean;

	/** Agent streams responses in real-time */
	supportsStreaming: boolean;

	/** Agent provides distinct "result" messages when done */
	supportsResultMessages: boolean;

	/** Agent supports selecting different models (e.g., --model flag) */
	supportsModelSelection: boolean;

	/** Agent supports --input-format stream-json for image input via stdin */
	supportsStreamJsonInput: boolean;

	/** Agent emits streaming thinking/reasoning content that can be displayed */
	supportsThinkingDisplay: boolean;

	/** Agent can receive merged context from other sessions/tabs */
	supportsContextMerge: boolean;

	/** Agent can export its context for transfer to other sessions/agents */
	supportsContextExport: boolean;

	/** Agent supports inline wizard structured output conversations */
	supportsWizard: boolean;

	/** Agent can serve as a group chat moderator */
	supportsGroupChatModeration: boolean;

	/** Agent uses JSON line (JSONL) output format in CLI batch mode */
	usesJsonLineOutput: boolean;

	/** Agent uses a combined input+output context window (vs separate limits) */
	usesCombinedContextWindow: boolean;

	/** Agent supports --append-system-prompt for separate system prompt delivery */
	supportsAppendSystemPrompt: boolean;

	/**
	 * Agent maintains a per-project persistent memory store on disk that Maestro
	 * can browse and edit. Claude Code does this at ~/.claude/projects/<path>/memory/.
	 */
	supportsProjectMemory: boolean;

	/**
	 * Agent's CLI can grant access to directories outside the working directory
	 * (e.g. `--add-dir`), so Maestro's Additional Directories are enforced by the
	 * provider rather than by instructions alone.
	 *
	 * When true, the definition MUST also supply `additionalDirArgs` - the
	 * completeness test fails otherwise. When false, the grants still reach the
	 * agent through the `{{ADDITIONAL_DIRECTORIES}}` block in the system prompt;
	 * they're just advisory. See `src/shared/additionalDirectories.ts`.
	 */
	supportsAdditionalDirectories: boolean;

	/**
	 * How images should be handled on resume when -i flag is not available.
	 * 'prompt-embed': Save images to temp files and embed file paths in the prompt text.
	 * undefined: Use default image handling (or no special resume handling needed).
	 */
	imageResumeMode?: 'prompt-embed';
}

/**
 * Default capabilities - safe defaults for unknown agents.
 * All capabilities disabled by default (conservative approach).
 */
export const DEFAULT_CAPABILITIES: AgentCapabilities = {
	supportsResume: false,
	supportsReadOnlyMode: false,
	supportsJsonOutput: false,
	supportsSessionId: false,
	supportsImageInput: false,
	supportsImageInputOnResume: false,
	supportsSlashCommands: false,
	supportsSessionStorage: false,
	supportsCostTracking: false,
	supportsUsageStats: false,
	supportsBatchMode: false,
	requiresPromptToStart: false,
	supportsStreaming: false,
	supportsResultMessages: false,
	supportsModelSelection: false,
	supportsStreamJsonInput: false,
	supportsThinkingDisplay: false,
	supportsContextMerge: false,
	supportsContextExport: false,
	supportsWizard: false,
	supportsGroupChatModeration: false,
	usesJsonLineOutput: false,
	usesCombinedContextWindow: false,
	supportsAppendSystemPrompt: false,
	supportsProjectMemory: false,
	supportsAdditionalDirectories: false,
};

// Session group
export interface Group {
	id: string;
	name: string;
	emoji: string;
	kind?: 'user' | 'worktree';
	icon?: string;
	color?: string;
	parentGroupId?: string;
	collapsed: boolean;
}

export function isWorktreeGroup(group: Group): boolean {
	return group.kind === 'worktree' || group.emoji === '🌳';
}

/**
 * Cli activity attached to a Session when the CLI is running a playbook on
 * that session. Single source of truth for both the renderer's Session type
 * (`renderer/types/index.ts`) and the main-process persistence diff
 * comparator (`main/ipc/handlers/persistence.ts:cliActivityChanged`).
 *
 * Producer: `useCliActivityMonitoring` in
 * `renderer/hooks/remote/useCliActivityMonitoring.ts`. If a new field is added
 * here, the comparator must compare it too - TypeScript will flag the omission
 * because both sites depend on this exact shape.
 */
export interface SessionCliActivity {
	playbookId: string;
	playbookName: string;
	startedAt: number;
}

// Simplified session interface for CLI (subset of full Session)
export interface SessionInfo {
	id: string;
	groupId?: string;
	name: string;
	toolType: ToolType;
	cwd: string;
	projectRoot: string;
	autoRunFolderPath?: string;
	/** Extra directories granted beyond the working directory (prompt-level grants). */
	additionalDirectories?: AdditionalDirectory[];
	/** Per-session model override (wins over agent-level `model` config option). */
	customModel?: string;
	/** Per-session effort/reasoning override (wins over agent-level config). */
	customEffort?: string;
	/** Per-session extra CLI args appended to the spawn. Space-separated, shell-quote aware. */
	customArgs?: string;
	/** Per-session env vars merged over agent-level customEnvVars and agent defaults. */
	customEnvVars?: Record<string, string>;
	/** Prefixed to the first message of every new session (not shown in chat). */
	newSessionMessage?: string;
	/** Appended to every message sent to the agent (not shown in chat). */
	nudgeMessage?: string;
	/** Per-session override of the agent binary path. */
	customPath?: string;
	/** Per-session context window size in tokens. */
	customContextWindow?: number;
	/** Claude token-source opt-in: drives the maestro-p TUI (Max quota) when on. */
	enableMaestroP?: boolean;
	/** Refines {@link enableMaestroP}: 'interactive' = always TUI, 'dynamic' = TUI then API fallback. */
	maestroPMode?: 'interactive' | 'dynamic';
	/** Per-session override of the maestro-p binary path. */
	maestroPPath?: string;
	/**
	 * Agent Resilience: auto-resend the failed prompt on transient upstream
	 * availability errors (Overloaded / 529 / 5xx / throttling) using exponential
	 * backoff (30s→30m). Defaults ON - treat `undefined` as enabled via
	 * {@link resilienceEnabled}. Set explicitly `false` to opt out.
	 */
	retryOnAvailabilityErrors?: boolean;
	/**
	 * Agent Resilience: auto-resend the failed prompt when the plan quota is
	 * exhausted (usage/quota limit). Waits until the parsed reset time, or 1h if
	 * unknown, then retries hourly. Defaults ON - treat `undefined` as enabled
	 * via {@link resilienceEnabled}. Set explicitly `false` to opt out.
	 */
	retryOnTokenExhaustion?: boolean;
	/** Per-session SSH remote config - when enabled, CLI spawns via SSH. */
	sessionSshRemoteConfig?: AgentSshRemoteConfig;
}

// Usage statistics from AI agent CLI (Claude Code, Codex, etc.)
export interface UsageStats {
	inputTokens: number;
	outputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	totalCostUsd: number;
	contextWindow: number;
	/**
	 * True when `contextWindow` is an authoritative, runtime-resolved value (the
	 * model's real window discovered from the provider's own catalog) rather than
	 * a static per-agent default/fallback. Consumers use this to let the real
	 * window win over the agent-level configured fallback while still honoring an
	 * explicit per-session override. Set by providers whose window is model-
	 * dependent and reported per turn (currently Oh My Pi); undefined otherwise.
	 */
	contextWindowResolved?: boolean;
	/**
	 * Reasoning/thinking tokens (separate from outputTokens)
	 * Some models like OpenAI o3/o4-mini report reasoning tokens separately.
	 * These are already included in outputTokens but tracked separately for UI display.
	 */
	reasoningTokens?: number;
	/**
	 * Pre-normalization absolute token totals, set ONLY for providers whose CLI
	 * reports cumulative session usage that we delta-normalize before emitting
	 * (currently Codex - see normalizeUsageToDelta in StdoutHandler). For those
	 * providers the top-level fields above are per-turn DELTAS, which are correct
	 * for token accumulation but wrong for context-fill display: the cumulative
	 * total is what actually occupies the model window. Consumers that plot
	 * context occupancy (the Context Timeline inspector) read from here when
	 * present and fall back to the top-level fields otherwise. Undefined for
	 * per-call providers (Claude, Copilot, OpenCode), whose top-level fields are
	 * already absolute for the current turn.
	 */
	absoluteUsage?: {
		inputTokens: number;
		outputTokens: number;
		cacheReadInputTokens: number;
		cacheCreationInputTokens: number;
		reasoningTokens: number;
	};
}

// History entry types for the History panel
export type HistoryEntryType = 'AUTO' | 'USER' | 'CUE';

export interface HistoryEntry {
	id: string;
	type: HistoryEntryType;
	timestamp: number;
	summary: string;
	fullResponse?: string;
	agentSessionId?: string;
	sessionName?: string;
	projectPath: string;
	sessionId?: string;
	contextUsage?: number;
	usageStats?: UsageStats;
	success?: boolean;
	elapsedTimeMs?: number;
	completedTaskCount?: number;
	validated?: boolean;
	cueTriggerName?: string;
	cueEventType?: string;
	cueSourceSession?: string;
	/**
	 * Cross-agent attribution: the display name of the agent that consulted this
	 * one via an `@mention`. Set on the history entry the TARGET agent keeps so it
	 * "remembers who consulted it" (mirrors GroupChatHistoryEntry.participantName).
	 */
	sourceAgentName?: string;
	/** Hostname of the machine that created this entry (for shared history) */
	hostname?: string;
	/**
	 * Claude-only, per-turn: which interface spent the quota for this turn.
	 * `interactive` = maestro-p TUI (Max plan), `api` = `claude --print` (per-token).
	 * Captured per entry because a Dynamic-mode agent flips between the two across turns.
	 */
	tokenSource?: 'interactive' | 'api';
	/**
	 * Claude-only, per-turn: why the token source was chosen. `auto` = user/usage
	 * selected, `limit` = forced API fallback because the Max plan quota was exhausted.
	 */
	tokenSourceReason?: 'auto' | 'limit';
}

// Document entry within a playbook
export interface PlaybookDocumentEntry {
	filename: string;
	resetOnCompletion: boolean;
}

// Controls whether each Auto Run agent invocation processes a single task or the
// whole document. Resolves `{{TASK_SELECTION_BLOCK}}` inside the autorun prompt.
// Omitted on legacy playbooks → treated as 'task' (the historical behavior).
export type TaskSelectionMode = 'task' | 'document';

// A saved Playbook configuration
export interface Playbook {
	id: string;
	name: string;
	createdAt: number;
	updatedAt: number;
	documents: PlaybookDocumentEntry[];
	loopEnabled: boolean;
	maxLoops?: number | null;
	prompt: string;
	taskSelectionMode?: TaskSelectionMode;
	worktreeSettings?: {
		branchNameTemplate: string;
		createPROnCompletion: boolean;
		prTargetBranch?: string;
	};
}

// Document entry in the batch run queue (runtime version with IDs)
export interface BatchDocumentEntry {
	id: string;
	filename: string;
	resetOnCompletion: boolean;
	isDuplicate: boolean;
	isMissing?: boolean;
}

/**
 * An extra directory an agent may touch beyond its working directory.
 *
 * Enforcement is prompt-level: the grants are rendered into the Maestro system
 * prompt as {{ADDITIONAL_DIRECTORIES}} and the agent is instructed to honor
 * them. Nothing sandboxes the agent process, so a grant is a statement of
 * intent, not a hard boundary.
 *
 * `read` and `write` are independent - a directory can be read-only (reference
 * material), write-only (a drop box the agent should never read back), or both.
 * An entry with neither flag set is inert and is omitted from the prompt.
 */
export interface AdditionalDirectory {
	path: string;
	read: boolean;
	write: boolean;
}

// Git worktree configuration for Auto Run
export interface WorktreeConfig {
	enabled: boolean;
	path: string;
	branchName: string;
	createPROnCompletion: boolean;
	prTargetBranch: string;
}

// Target specification for dispatching Auto Run to a worktree agent
export interface WorktreeRunTarget {
	mode: 'existing-open' | 'existing-closed' | 'create-new';
	sessionId?: string;
	worktreePath?: string;
	baseBranch?: string;
	newBranchName?: string;
	createPROnCompletion: boolean;
}

// Configuration for starting a batch run
export interface BatchRunConfig {
	documents: BatchDocumentEntry[];
	prompt: string;
	loopEnabled: boolean;
	maxLoops?: number | null;
	taskSelectionMode?: TaskSelectionMode;
	worktree?: WorktreeConfig;
	worktreeTarget?: WorktreeRunTarget;
}

// ============================================================================
// Agent Configuration Options
// ============================================================================

/**
 * Configuration option for agent-specific settings (checkboxes, text, number, select).
 */
export interface AgentConfigOption {
	key: string;
	type: 'checkbox' | 'text' | 'number' | 'select';
	label: string;
	description: string;
	default: any;
	options?: string[];
	dynamic?: boolean; // If true, options are fetched at runtime via agents:getConfigOptions IPC
}

// Agent configuration (serializable subset shared across processes)
export interface AgentConfig {
	id: string;
	name: string;
	binaryName?: string;
	command?: string;
	args?: string[];
	available: boolean;
	path?: string;
	customPath?: string;
	requiresPty?: boolean;
	hidden?: boolean;
	configOptions?: AgentConfigOption[];
	capabilities?: AgentCapabilities;
	yoloModeArgs?: string[];
	fullAccessArgs?: string[]; // Same as yoloModeArgs - preferred name. Args added in 'full' permission mode.
	readOnlyCliEnforced?: boolean;
	/**
	 * Latest persisted capability snapshot for this agent in the requested
	 * environment (local or per-SSH-remote). Attached by the IPC handlers
	 * after stripping non-serializable agent fields. May be absent on first
	 * boot before any detection has run.
	 */
	snapshot?: import('./agentCapabilities').AgentCapabilitiesSnapshot;
}

// ============================================================================
// Agent Error Handling Types
// ============================================================================

/**
 * Types of errors that agents can encounter.
 * Used to determine appropriate recovery actions and UI display.
 */
export type AgentErrorType =
	| 'auth_expired' // API key invalid, token expired, login required
	| 'token_exhaustion' // Context window full, max tokens reached
	| 'rate_limited' // Too many requests, quota exceeded
	| 'network_error' // Connection failed, timeout
	| 'agent_crashed' // Process exited unexpectedly
	| 'permission_denied' // Agent lacks required permissions
	| 'session_not_found' // Session was deleted or doesn't exist
	| 'hitl_gate' // Playbook reached a human-in-the-loop review marker
	| 'unknown'; // Unrecognized error

/**
 * Structured error information from an AI agent.
 * Contains details needed for error display and recovery.
 */
export interface AgentError {
	/** The category of error */
	type: AgentErrorType;

	/** Human-readable error message for display */
	message: string;

	/** Whether the error can be recovered from (vs. requiring user intervention) */
	recoverable: boolean;

	/** The agent that encountered the error (e.g., 'claude-code', 'opencode') */
	agentId: string;

	/** The session ID where the error occurred (if applicable) */
	sessionId?: string;

	/**
	 * Stable UUID of the SSH remote this error fired against, when the
	 * spawning session was an SSH-backed session. Used by listeners (notably
	 * `capabilitySnapshots.markAuthRequired`) so that per-remote status pills
	 * flip independently of the local snapshot. Absent on local-spawn errors.
	 */
	sshRemoteId?: string;

	/** Timestamp when the error occurred */
	timestamp: number;

	/** Original error data for debugging (stderr, exit code, etc.) */
	raw?: {
		exitCode?: number;
		stderr?: string;
		stdout?: string;
		errorLine?: string;
	};

	/** Parsed JSON error details (if the error contains structured JSON) */
	parsedJson?: unknown;

	/**
	 * For limit/credit/rate-limit errors: epoch ms when the provider window is
	 * expected to reopen. Used by auto-resume to schedule the next probe. May be
	 * undefined when the reset time is unknown (probe on the fixed interval instead).
	 */
	limitResetAt?: number;

	/**
	 * Number of resume attempts made for this paused agent so far. Used for
	 * backoff and to enforce the give-up window after repeated limits.
	 */
	resumeAttemptCount?: number;

	/**
	 * Epoch ms marking when auto-resume first observed this limit pause. The
	 * coordinator stamps it once (seeded from `timestamp`, the moment the limit
	 * fired) and never overwrites it while the pause persists. Phase 4's give-up
	 * decision is time-based off this stamp and the `autoResumeGiveUpDays`
	 * setting, NOT a raw attempt count.
	 */
	limitPausedAt?: number;
}

/**
 * True when an agent error is a provider "limit pause" - a token/API/credit or
 * rate limit the agent can resume from once the window reopens. Both
 * `rate_limited` and `token_exhaustion` count (some providers surface credit
 * exhaustion as the latter). Single source of truth so every call site (error
 * listener, goal runner, auto-resume coordinator) agrees on what to pause on.
 */
export function isLimitError(err: AgentError): boolean {
	return err.type === 'rate_limited' || err.type === 'token_exhaustion';
}

/**
 * Recovery action for an agent error.
 * Provides both the action metadata and the action function.
 */
export interface AgentErrorRecovery {
	/** The error type this recovery addresses */
	type: AgentErrorType;

	/** Button label for the recovery action (e.g., "Re-authenticate", "Start New Session") */
	label: string;

	/** Description of what the recovery action will do */
	description?: string;

	/** Whether this is the recommended/primary action */
	primary?: boolean;

	/** Icon identifier for the action button (optional) */
	icon?: string;
}

// ============================================================================
// Power Management Types
// ============================================================================

/**
 * Status information for the power management system.
 * Returned by power:getStatus IPC handler.
 */
export interface PowerStatus {
	/** Whether sleep prevention is enabled by user preference */
	enabled: boolean;
	/** Whether we are currently blocking sleep (enabled AND have active reasons) */
	blocking: boolean;
	/** List of active reasons for blocking (e.g., "session:abc123", "autorun:batch1") */
	reasons: string[];
	/** Current platform */
	platform: 'darwin' | 'win32' | 'linux';
}

// ============================================================================
// Marketplace Types (re-exported from marketplace-types.ts)
// ============================================================================

export type {
	MarketplaceManifest,
	MarketplacePlaybook,
	MarketplaceDocument,
	MarketplaceCache,
	MarketplaceDocumentContent,
	MarketplaceErrorType,
	MarketplaceError,
	GetManifestResponse,
	GetDocumentResponse,
	GetReadmeResponse,
	ImportPlaybookResponse,
	MarketplaceErrorResponse,
} from './marketplace-types';

export {
	MarketplaceFetchError,
	MarketplaceCacheError,
	MarketplaceImportError,
} from './marketplace-types';

// ============================================================================
// SSH Remote Execution Types
// ============================================================================

/**
 * Configuration for an SSH remote host where agents can be executed.
 * Supports key-based authentication only (no password auth).
 *
 * When useSshConfig is true, the host field becomes the SSH config Host pattern
 * (e.g., "dev-server" from ~/.ssh/config), and username/privateKeyPath can be
 * omitted as they're inherited from the SSH config file.
 */
export interface SshRemoteConfig {
	/** Unique identifier for this remote configuration */
	id: string;

	/** Display name for UI */
	name: string;

	/**
	 * SSH server hostname or IP address.
	 * When useSshConfig is true, this is the Host pattern from ~/.ssh/config
	 * (e.g., "dev-server" instead of "192.168.1.100").
	 */
	host: string;

	/** SSH server port (default: 22). Optional when using SSH config. */
	port: number;

	/**
	 * SSH username. Optional when useSshConfig is true and the SSH config
	 * provides the User directive.
	 */
	username: string;

	/**
	 * Path to private key file. Optional when useSshConfig is true and the
	 * SSH config provides the IdentityFile directive.
	 */
	privateKeyPath: string;

	/** Environment variables to set on remote */
	remoteEnv?: Record<string, string>;

	/** Enable this remote configuration */
	enabled: boolean;

	/**
	 * When true, use the host field as an SSH config Host pattern.
	 * Connection settings (User, IdentityFile, Port, HostName) will be
	 * inherited from ~/.ssh/config. Explicit settings here override config.
	 */
	useSshConfig?: boolean;

	/**
	 * Reference to the SSH config host pattern this was imported from.
	 * Used for display purposes to show where the config came from.
	 */
	sshConfigHost?: string;
}

/**
 * Status of an SSH remote connection from last test.
 */
export interface SshRemoteStatus {
	/** Last connection test result */
	lastTestSuccess: boolean | null;

	/** Last connection test timestamp */
	lastTestAt: number | null;

	/** Error message from last test */
	lastTestError: string | null;
}

/**
 * Result of testing an SSH remote connection.
 */
export interface SshRemoteTestResult {
	/** Whether the connection test succeeded */
	success: boolean;

	/** Error message if test failed */
	error?: string;

	/** Remote host info (hostname, agent version, etc.) */
	remoteInfo?: {
		hostname: string;
		agentVersion?: string;
	};
}

/**
 * Agent-level SSH remote configuration.
 * Allows overriding the global default SSH remote for specific agents.
 */
export interface AgentSshRemoteConfig {
	/** Use SSH remote for this agent */
	enabled: boolean;

	/** Remote config ID to use (references SshRemoteConfig.id) */
	remoteId: string | null;

	/** Override working directory for this agent */
	workingDirOverride?: string;

	/** Sync history entries to .maestro/history/ on the remote host (opt-in, default: false) */
	syncHistory?: boolean;

	/**
	 * Mirror every new history entry for this agent to
	 * <projectRoot>/.maestro/history/history-<hostname>.jsonl on *this* machine's
	 * local filesystem. Meant for agents that run here locally but are controlled
	 * by another Maestro instance over SSH - the controller reads the project's
	 * `.maestro/history/` dir and sees entries generated on this side.
	 * Independent of `enabled` / `syncHistory`.
	 */
	shareHistoryToProjectDir?: boolean;
}

// ============================================================================
// Deep Link Types
// ============================================================================

/**
 * Parsed deep link from a maestro:// URL.
 * Used by both main process (URL parsing) and renderer (navigation dispatch).
 */
export interface ParsedDeepLink {
	/** The type of navigation action */
	action: 'focus' | 'session' | 'group' | 'file';
	/** Maestro session ID (for action: 'session' and 'file') */
	sessionId?: string;
	/** Tab ID within the session (for action: 'session') */
	tabId?: string;
	/** Group ID (for action: 'group') */
	groupId?: string;
	/** Absolute filesystem path (for action: 'file') */
	filePath?: string;
	/** 1-based line number within the file (for action: 'file', optional) */
	line?: number;
}

// ============================================================================
// Global Agent Statistics Types
// ============================================================================

/**
 * Per-provider statistics breakdown
 */
export interface ProviderStats {
	sessions: number;
	messages: number;
	inputTokens: number;
	outputTokens: number;
	costUsd: number;
	hasCostData: boolean;
}

/**
 * Global stats aggregated from all providers.
 * Used by AboutModal and AgentSessions handlers.
 */
export interface GlobalAgentStats {
	totalSessions: number;
	totalMessages: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheReadTokens: number;
	totalCacheCreationTokens: number;
	/** Total cost in USD - only includes providers that support cost tracking */
	totalCostUsd: number;
	/** Whether any provider contributed cost data */
	hasCostData: boolean;
	totalSizeBytes: number;
	/** Whether stats calculation is complete (used for progressive updates) */
	isComplete: boolean;
	/** Per-provider breakdown */
	byProvider: Record<string, ProviderStats>;
}

// ============================================================================
// Shell & Directory Types (shared across preload boundary)
// ============================================================================

/**
 * Detected shell information for terminal sessions.
 */
export interface ShellInfo {
	id: string;
	name: string;
	available: boolean;
	path?: string;
}

/**
 * Directory entry for filesystem browsing.
 */
export interface DirectoryEntry {
	name: string;
	isDirectory: boolean;
	isFile: boolean;
	isSymlink?: boolean;
	path: string;
}

/**
 * Update status from electron-updater (serializable subset for IPC).
 */
export interface UpdateStatus {
	status:
		| 'idle'
		| 'checking'
		| 'available'
		| 'not-available'
		| 'downloading'
		| 'downloaded'
		| 'error';
	info?: { version: string };
	progress?: { percent: number; bytesPerSecond: number; total: number; transferred: number };
	error?: string;
}
