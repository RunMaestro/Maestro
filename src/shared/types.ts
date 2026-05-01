// Shared type definitions for Maestro CLI and Electron app
// These types are used by both the CLI tool and the renderer process

// Re-export agent ID constants and types from the single source of truth
export { AGENT_IDS, isValidAgentId } from './agentIds';
export type { AgentId } from './agentIds';

/**
 * Union type of all valid agent IDs.
 * Derived from AGENT_IDS — the single source of truth in agentIds.ts.
 */
export type ToolType = import('./agentIds').AgentId;

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
};

// Session group
export interface Group {
	id: string;
	name: string;
	emoji: string;
	collapsed: boolean;
}

/**
 * Cli activity attached to a Session when the CLI is running a playbook on
 * that session. Single source of truth for both the renderer's Session type
 * (`renderer/types/index.ts`) and the main-process persistence diff
 * comparator (`main/ipc/handlers/persistence.ts:cliActivityChanged`).
 *
 * Producer: `useCliActivityMonitoring` in
 * `renderer/hooks/remote/useCliActivityMonitoring.ts`. If a new field is added
 * here, the comparator must compare it too — TypeScript will flag the omission
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
	/** Per-session model override (wins over agent-level `model` config option). */
	customModel?: string;
	/** Per-session effort/reasoning override (wins over agent-level config). */
	customEffort?: string;
	/** Per-session extra CLI args appended to the spawn. Space-separated, shell-quote aware. */
	customArgs?: string;
	/** Per-session env vars merged over agent-level customEnvVars and agent defaults. */
	customEnvVars?: Record<string, string>;
	/** Per-session SSH remote config — when enabled, CLI spawns via SSH. */
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
	 * Reasoning/thinking tokens (separate from outputTokens)
	 * Some models like OpenAI o3/o4-mini report reasoning tokens separately.
	 * These are already included in outputTokens but tracked separately for UI display.
	 */
	reasoningTokens?: number;
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
	validated?: boolean;
	cueTriggerName?: string;
	cueEventType?: string;
	cueSourceSession?: string;
	/** Hostname of the machine that created this entry (for shared history) */
	hostname?: string;
}

// Document entry within a playbook
export interface PlaybookDocumentEntry {
	filename: string;
	resetOnCompletion: boolean;
}

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

// Git worktree configuration for Auto Run
export interface WorktreeConfig {
	enabled: boolean;
	path: string;
	branchName: string;
	createPROnCompletion: boolean;
	prTargetBranch: string;
}

// Work Graph metadata attached to an Auto Run dispatch.
export interface WorkGraphDispatchContext {
	workItemId: string;
	claimId?: string;
	itemTitle?: string;
	projectPath?: string;
	gitPath?: string;
	repository?: string;
	issueNumber?: number;
	source?: 'manual' | 'symphony' | 'agent-dispatch' | 'delivery-planner' | 'living-wiki' | 'mcp';
}

// Target specification for dispatching Auto Run to a worktree agent
export interface WorktreeRunTarget {
	mode: 'existing-open' | 'existing-closed' | 'create-new';
	agentId?: string;
	/** @deprecated Use agentId. Kept for existing stored configs and callers. */
	sessionId?: string;
	worktreePath?: string;
	baseBranch?: string;
	newBranchName?: string;
	createPROnCompletion: boolean;
	workGraph?: WorkGraphDispatchContext;
}

// Configuration for starting a batch run
export interface BatchRunConfig {
	documents: BatchDocumentEntry[];
	prompt: string;
	loopEnabled: boolean;
	maxLoops?: number | null;
	worktree?: WorktreeConfig;
	worktreeTarget?: WorktreeRunTarget;
	workGraph?: WorkGraphDispatchContext;
}

// ============================================================================
// Agent Capabilities
// ============================================================================

/**
 * Capability flags that determine what features are available for each agent.
 * Canonical definition - import from here, not from capabilities.ts or preload.
 */
export interface AgentCapabilities {
	/** Agent supports resuming existing sessions (e.g., --resume flag) */
	supportsResume: boolean;
	/** Agent supports read-only/plan mode (e.g., --permission-mode plan) */
	supportsReadOnlyMode: boolean;
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
	/** How images should be handled on resume when -i flag is not available. */
	imageResumeMode?: 'prompt-embed';
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
	readOnlyCliEnforced?: boolean;
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
	 * by another Maestro instance over SSH — the controller reads the project's
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
	action: 'focus' | 'session' | 'group';
	/** Maestro session ID (for action: 'session') */
	sessionId?: string;
	/** Tab ID within the session (for action: 'session') */
	tabId?: string;
	/** Group ID (for action: 'group') */
	groupId?: string;
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
