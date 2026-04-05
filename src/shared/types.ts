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
 * - 'off': Thinking is suppressed (not shown)
 * - 'on': Thinking is shown while streaming, cleared when final response arrives
 * - 'sticky': Thinking is shown and remains visible after the final response
 */
export type ThinkingMode = 'off' | 'on' | 'sticky';

// Session group
export interface Group {
	id: string;
	name: string;
	emoji: string;
	collapsed: boolean;
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
	customModel?: string;
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
	worktree?: WorktreeConfig;
	worktreeTarget?: WorktreeRunTarget;
}

// ============================================================================
// Agent Capabilities
// ============================================================================

/**
 * Capability flags that determine what features are available for each agent.
 * This is the single canonical definition - all other files should import from here.
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

	/** How images should be handled on resume when -i flag is not available.
	 * 'prompt-embed': Save images to temp files and embed file paths in the prompt text.
	 * undefined: Use default image handling (or no special resume handling needed). */
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
};

// ============================================================================
// Agent Configuration Types
// ============================================================================

/**
 * Simplified agent configuration option (IPC-safe, no discriminated union).
 * The main process uses a richer discriminated union in definitions.ts.
 * This is the single canonical definition for cross-process usage.
 */
export interface AgentConfigOption {
	key: string;
	type: 'checkbox' | 'text' | 'number' | 'select';
	label: string;
	description: string;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	default: any;
	options?: string[];
}

/**
 * Agent configuration - serializable fields that can cross the IPC boundary.
 * This is the single canonical definition - all other files should import from here.
 *
 * The main process extends this with function-typed arg builders in definitions.ts.
 * The renderer and preload import this type directly.
 */
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
	configOptions?: AgentConfigOption[];
	hidden?: boolean;
	capabilities?: AgentCapabilities;
	// Serializable arg config arrays (no functions)
	batchModePrefix?: string[];
	batchModeArgs?: string[];
	jsonOutputArgs?: string[];
	readOnlyArgs?: string[];
	yoloModeArgs?: string[];
	noPromptSeparator?: boolean;
	defaultEnvVars?: Record<string, string>;
	readOnlyEnvOverrides?: Record<string, string>;
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

	/** Sync history entries to .maestro/history/ on the remote host (default: true) */
	syncHistory?: boolean;
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

/**
 * IPC-level process spawn configuration
 * Sent from renderer through preload to main process.
 * Note: main/process-manager/types.ts has a separate ProcessConfig with internal fields.
 */
export interface ProcessConfig {
	sessionId: string;
	toolType: string;
	cwd: string;
	command?: string;
	args?: string[];
	prompt?: string;
	shell?: string;
	images?: string[];
	// Agent-specific spawn options (used to build args via agent config)
	agentSessionId?: string;
	readOnlyMode?: boolean;
	modelId?: string;
	yoloMode?: boolean;
	// Per-session overrides (take precedence over agent-level config)
	sessionCustomPath?: string;
	sessionCustomArgs?: string;
	sessionCustomEnvVars?: Record<string, string>;
	sessionCustomModel?: string;
	sessionCustomContextWindow?: number;
	// Per-session SSH remote config
	sessionSshRemoteConfig?: {
		enabled: boolean;
		remoteId: string | null;
		workingDirOverride?: string;
		syncHistory?: boolean;
	};
	// System prompt delivery
	appendSystemPrompt?: string;
	// Stdin-based prompt delivery
	sendPromptViaStdin?: boolean;
	sendPromptViaStdinRaw?: boolean;
	// Stats tracking options
	querySource?: 'user' | 'auto';
	tabId?: string;
}

/**
 * Parsed SSH config host entry
 */
export interface SshConfigHost {
	host: string;
	hostName?: string;
	port?: number;
	user?: string;
	identityFile?: string;
	proxyJump?: string;
}

/**
 * Shell information from system shell detection
 */
export interface ShellInfo {
	id: string;
	name: string;
	available: boolean;
	path?: string;
}

/**
 * Update status communicated from main process to renderer
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
	progress?: {
		percent: number;
		bytesPerSecond: number;
		total: number;
		transferred: number;
		delta?: number;
	};
	error?: string;
}

/**
 * Directory entry from filesystem listing
 */
export interface DirectoryEntry {
	name: string;
	isDirectory: boolean;
	isFile: boolean;
	path: string;
}

// ============================================================================
// Session Message Types (cross-process, used by preload/IPC)
// ============================================================================

/**
 * A single message in a conversation.
 * Used by session storage implementations and IPC communication.
 */
export interface SessionMessage {
	type: string;
	role?: string;
	content: string;
	timestamp: string;
	uuid: string;
	toolUse?: unknown;
}

/**
 * Session messages result with pagination info.
 * Returned by readMessages IPC calls and session storage.
 */
export interface SessionMessagesResult {
	messages: SessionMessage[];
	total: number;
	hasMore: boolean;
}
