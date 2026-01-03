// Type definitions for Maestro renderer

// Re-export context merge types
export * from './contextMerge';

// Re-export theme types from shared location
export type { Theme, ThemeId, ThemeMode, ThemeColors } from '../../shared/theme-types';
export { isValidThemeId } from '../../shared/theme-types';

// Re-export types from shared location
export type {
  AgentError,
  AgentErrorType,
  AgentErrorRecovery,
  ToolType,
  Group,
  UsageStats,
  BatchDocumentEntry,
  PlaybookDocumentEntry,
  Playbook,
} from '../../shared/types';
// Import for extension in this file
import type {
  WorktreeConfig as BaseWorktreeConfig,
  BatchDocumentEntry,
  UsageStats,
  ToolType,
} from '../../shared/types';

// Re-export group chat types from shared location
export type {
  GroupChat,
  GroupChatParticipant,
  GroupChatMessage,
  GroupChatState,
  GroupChatHistoryEntry,
  GroupChatHistoryEntryType,
  ModeratorConfig,
} from '../../shared/group-chat-types';
// Import AgentError for use within this file
import type { AgentError } from '../../shared/types';

export type SessionState = 'idle' | 'busy' | 'waiting_input' | 'connecting' | 'error';
export type FileChangeType = 'modified' | 'added' | 'deleted';
export type RightPanelTab = 'files' | 'history' | 'autorun';
export type SettingsTab = 'general' | 'shortcuts' | 'theme' | 'notifications' | 'aicommands';
// Note: ScratchPadMode was removed as part of the Scratchpad → Auto Run migration
export type FocusArea = 'sidebar' | 'main' | 'right';
export type LLMProvider = 'openrouter' | 'anthropic' | 'ollama';

// Inline wizard types for per-session/per-tab wizard state
export type WizardMode = 'new' | 'iterate' | null;

/**
 * Message in an inline wizard conversation.
 * Stores conversation history for the /wizard command.
 */
export interface WizardMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  /** Parsed confidence from assistant responses */
  confidence?: number;
  /** Parsed ready flag from assistant responses */
  ready?: boolean;
}

/**
 * Previous UI state to restore when wizard ends.
 * These settings are temporarily overridden during wizard mode.
 */
export interface WizardPreviousUIState {
  readOnlyMode: boolean;
  saveToHistory: boolean;
  showThinking: boolean;
}

/**
 * Generated document from wizard.
 * Stores document content and metadata for display and editing.
 */
export interface WizardGeneratedDocument {
  /** Filename (e.g., "phase-01.md") */
  filename: string;
  /** Document content (markdown) */
  content: string;
  /** Number of tasks in the document */
  taskCount: number;
  /** Absolute path after saving */
  savedPath?: string;
}

/**
 * Per-session/per-tab wizard state.
 * Keeps track of inline wizard state for the /wizard command.
 */
export interface SessionWizardState {
  /** Whether wizard is currently active */
  isActive: boolean;
  /** Whether waiting for AI response */
  isWaiting?: boolean;
  /** Current wizard mode: 'new' for creating documents, 'iterate' for modifying existing */
  mode: WizardMode;
  /** Goal for iterate mode (what the user wants to add/change) */
  goal?: string;
  /** Confidence level from agent responses (0-100) */
  confidence: number;
  /** Whether the AI is ready to proceed with document generation */
  ready?: boolean;
  /** Conversation history for this wizard session */
  conversationHistory: WizardMessage[];
  /** Previous UI state to restore when wizard ends */
  previousUIState: WizardPreviousUIState;

  // Error handling state
  /** Error message if an error occurred during wizard conversation */
  error?: string | null;

  // Document generation state
  /** Whether documents are currently being generated (triggers takeover view) */
  isGeneratingDocs?: boolean;
  /** Generated documents */
  generatedDocuments?: WizardGeneratedDocument[];
  /** Currently selected document index */
  currentDocumentIndex?: number;
  /** Streaming content for document being generated */
  streamingContent?: string;
  /** Progress message during generation */
  progressMessage?: string;
  /** Index of document currently being generated (for progress indicator) */
  currentGeneratingIndex?: number;
  /** Total number of documents to generate (for progress indicator) */
  totalDocuments?: number;
  /** Folder path for Auto Run docs */
  autoRunFolderPath?: string;
  /** The Claude agent session ID (from session_id in output) - used to switch tab after wizard completes */
  agentSessionId?: string;
}

export interface Shortcut {
  id: string;
  label: string;
  keys: string[];
}

export interface FileArtifact {
  path: string;
  type: FileChangeType;
  linesAdded?: number;
  linesRemoved?: number;
}

export interface LogEntry {
  id: string;
  timestamp: number;
  source: 'stdout' | 'stderr' | 'system' | 'user' | 'ai' | 'error' | 'thinking' | 'tool';
  text: string;
  interactive?: boolean;
  options?: string[];
  images?: string[];
  // For custom AI commands - stores the command metadata for display
  aiCommand?: {
    command: string;      // e.g., '/commit'
    description: string;  // e.g., 'Commit outstanding changes and push up'
  };
  // For user messages - tracks if message was successfully delivered to the agent
  delivered?: boolean;
  // For user messages - tracks if message was sent in read-only mode
  readOnly?: boolean;
  // For error entries - stores the full AgentError for "View Details" functionality
  agentError?: AgentError;
  // For tool execution entries - stores tool state and details
  metadata?: {
    toolState?: {
      status?: 'running' | 'completed' | 'error';
      input?: unknown;
      output?: unknown;
    };
  };
}

// Queued item for the session-level execution queue
// Supports both messages and slash commands, processed sequentially
export type QueuedItemType = 'message' | 'command';

export interface QueuedItem {
  id: string;                        // Unique item ID
  timestamp: number;                 // When it was queued (for ordering)
  tabId: string;                     // Target tab for this item
  type: QueuedItemType;              // 'message' or 'command'
  // For messages
  text?: string;                     // Message text
  images?: string[];                 // Attached images (base64)
  // For commands
  command?: string;                  // Slash command (e.g., '/commit')
  commandDescription?: string;       // Command description for display
  // Display metadata
  tabName?: string;                  // Tab name at time of queuing (for display)
  // Read-only mode tracking (for parallel execution bypass)
  readOnlyMode?: boolean;            // True if queued from a read-only tab
}

export interface WorkLogItem {
  id: string;
  title: string;
  description: string;
  timestamp: number;
  relatedFiles?: number;
}

// History entry types for the History panel
// Re-export from shared types for convenience
export type { HistoryEntryType } from '../../shared/types';

// Import base HistoryEntry from shared types
import { HistoryEntry as BaseHistoryEntry } from '../../shared/types';

// Renderer-specific HistoryEntry extends the shared base with UI-specific fields
export interface HistoryEntry extends BaseHistoryEntry {
  achievementAction?: 'openAbout'; // If set, this entry has an action button to open the About/achievements panel
}

// Renderer-specific WorktreeConfig extends the shared base with UI-specific fields
export interface WorktreeConfig extends BaseWorktreeConfig {
  ghPath?: string;               // Custom path to gh CLI binary (optional, UI-specific)
}

// Worktree path validation state (used by useWorktreeValidation hook)
export interface WorktreeValidationState {
  checking: boolean;              // Currently validating the path
  exists: boolean;                // Path exists on disk
  isWorktree: boolean;            // Path is an existing git worktree
  currentBranch?: string;         // Current branch if it's a git repo
  branchMismatch: boolean;        // Target branch differs from current branch
  sameRepo: boolean;              // Worktree belongs to the same repository
  hasUncommittedChanges?: boolean; // Has uncommitted changes (blocks checkout)
  error?: string;                 // Validation error message
}

// GitHub CLI status for worktree PR creation
export interface GhCliStatus {
  installed: boolean;             // gh CLI is installed
  authenticated: boolean;         // gh CLI is authenticated
}

// Configuration for starting a batch run
export interface BatchRunConfig {
  documents: BatchDocumentEntry[];  // Ordered list of docs to run
  prompt: string;
  loopEnabled: boolean;    // Loop back to first doc when done
  maxLoops?: number | null;  // Max loop iterations (null/undefined = infinite)
  worktree?: WorktreeConfig;     // Optional worktree configuration
}

// Import BatchProcessingState for state machine integration
import type { BatchProcessingState } from '../hooks/batch/batchStateMachine';

// Batch processing state
export interface BatchRunState {
  isRunning: boolean;
  isStopping: boolean; // Waiting for current task to finish before stopping

  // State machine integration (Phase 11)
  // Tracks explicit processing state for invariant checking and debugging
  processingState?: BatchProcessingState;

  // Document-level progress (multi-document support)
  documents: string[];           // Ordered list of document filenames to process
  lockedDocuments: string[];     // Documents that should be read-only during this run (subset of documents)
  currentDocumentIndex: number;  // Which document we're on (0-based)

  // Task-level progress within current document
  currentDocTasksTotal: number;     // Total tasks in current document
  currentDocTasksCompleted: number; // Completed tasks in current document

  // Overall progress (grows as reset docs add tasks back)
  totalTasksAcrossAllDocs: number;
  completedTasksAcrossAllDocs: number;

  // Loop mode
  loopEnabled: boolean;
  loopIteration: number;  // How many times we've looped (0 = first pass)
  maxLoops?: number | null;  // Max loop iterations (null/undefined = infinite)

  // Folder path for file operations
  folderPath: string;

  // Worktree tracking
  worktreeActive: boolean;       // Currently running in a worktree
  worktreePath?: string;         // Path to the active worktree
  worktreeBranch?: string;       // Branch name in the worktree

  // Legacy fields (kept for backwards compatibility during migration)
  totalTasks: number;
  completedTasks: number;
  currentTaskIndex: number;
  scratchpadPath?: string; // Path to temp file
  originalContent: string; // Original scratchpad content for sync back

  // Prompt configuration
  customPrompt?: string; // User's custom prompt if modified
  sessionIds: string[]; // Claude session IDs from each iteration
  startTime?: number; // Timestamp when batch run started
  cumulativeTaskTimeMs?: number; // Sum of actual task durations (most accurate work time measure)
  accumulatedElapsedMs?: number; // Accumulated active elapsed time (excludes sleep/suspend time)
  lastActiveTimestamp?: number; // Last timestamp when actively tracking (for pause/resume calculation)

  // Error handling state (Phase 5.10)
  error?: AgentError;                // Current error if batch is paused due to agent error
  errorPaused?: boolean;             // True if batch is paused waiting for error resolution
  errorDocumentIndex?: number;       // Which document had the error (for skip functionality)
  errorTaskDescription?: string;     // Description of the task that failed (for UI display)
}

// Persistent global statistics (survives app restarts)
export interface GlobalStats {
  totalSessions: number;
  totalMessages: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalCostUsd: number;
  totalActiveTimeMs: number;
}

// Badge unlock record for history tracking
export interface BadgeUnlockRecord {
  level: number;
  unlockedAt: number;  // Timestamp when badge was unlocked
}

// Auto-run achievement statistics (survives app restarts)
export interface AutoRunStats {
  cumulativeTimeMs: number;       // Total cumulative AutoRun time across all sessions
  longestRunMs: number;           // Longest single AutoRun session
  longestRunTimestamp: number;    // When the longest run occurred
  totalRuns: number;              // Total number of AutoRun sessions completed
  currentBadgeLevel: number;      // Current badge level (1-11)
  lastBadgeUnlockLevel: number;   // Last badge level that triggered unlock notification
  lastAcknowledgedBadgeLevel: number; // Last badge level user clicked "Take a Bow" on
  badgeHistory: BadgeUnlockRecord[]; // History of badge unlocks with timestamps
}

// Maestro usage peak statistics (survives app restarts)
// These track maximum usage peaks for achievement display
export interface MaestroUsageStats {
  maxAgents: number;                  // Maximum number of agents active at once
  maxDefinedAgents: number;           // Maximum number of defined agents (ever configured)
  maxSimultaneousAutoRuns: number;    // Maximum concurrent Auto Run sessions
  maxSimultaneousQueries: number;     // Maximum concurrent AI queries
  maxQueueDepth: number;              // Maximum number of queued queries at once
}

// Onboarding analytics statistics (survives app restarts)
// These are stored locally only - no data is sent externally
export interface OnboardingStats {
  // Wizard statistics
  wizardStartCount: number;              // Number of times wizard was started
  wizardCompletionCount: number;         // Number of times wizard was completed
  wizardAbandonCount: number;            // Number of times wizard was abandoned (exited before completion)
  wizardResumeCount: number;             // Number of times wizard was resumed from saved state
  averageWizardDurationMs: number;       // Average time to complete wizard (0 if none completed)
  totalWizardDurationMs: number;         // Total cumulative wizard duration
  lastWizardCompletedAt: number;         // Timestamp of last wizard completion (0 if never)

  // Tour statistics
  tourStartCount: number;                // Number of times tour was started
  tourCompletionCount: number;           // Number of times tour was completed (all steps)
  tourSkipCount: number;                 // Number of times tour was skipped before completion
  tourStepsViewedTotal: number;          // Total tour steps viewed across all tours
  averageTourStepsViewed: number;        // Average steps viewed per tour (completed + skipped)

  // Conversation statistics
  totalConversationExchanges: number;    // Total user<->AI exchanges across all wizards
  averageConversationExchanges: number;  // Average exchanges per completed wizard
  totalConversationsCompleted: number;   // Number of wizard conversations that reached ready state

  // Auto Run document generation statistics
  totalPhasesGenerated: number;          // Total Auto Run documents generated
  averagePhasesPerWizard: number;        // Average documents per completed wizard
  totalTasksGenerated: number;           // Total tasks generated across all documents
  averageTasksPerPhase: number;          // Average tasks per document
}

// AI Tab for multi-tab support within a Maestro session
// Each tab represents a separate AI agent conversation (Claude Code, OpenCode, etc.)
export interface AITab {
  id: string;                      // Unique tab ID (generated UUID)
  agentSessionId: string | null;   // Agent session UUID (null for new tabs)
  name: string | null;             // User-defined name (null = show UUID octet)
  starred: boolean;                // Whether session is starred (for pill display)
  logs: LogEntry[];                // Conversation history
  agentError?: AgentError;         // Tab-specific agent error (shown in banner)
  inputValue: string;              // Pending input text for this tab
  stagedImages: string[];          // Staged images (base64) for this tab
  usageStats?: UsageStats;         // Token usage for this tab
  createdAt: number;               // Timestamp for ordering
  state: 'idle' | 'busy';          // Tab-level state for write-mode tracking
  readOnlyMode?: boolean;          // When true, agent operates in plan/read-only mode
  saveToHistory?: boolean;         // When true, synopsis is requested after each completion and saved to History
  lastSynopsisTime?: number;       // Timestamp of last synopsis generation (for time-window context in prompts)
  showThinking?: boolean;          // When true, show streaming thinking/reasoning content in real-time
  awaitingSessionId?: boolean;     // True when this tab sent a message and is awaiting its session ID
  thinkingStartTime?: number;      // Timestamp when tab started thinking (for elapsed time display)
  scrollTop?: number;              // Saved scroll position for this tab's output view
  hasUnread?: boolean;             // True when tab has new messages user hasn't seen
  isAtBottom?: boolean;            // True when user is scrolled to bottom of output
  pendingMergedContext?: string;   // Context from merge that needs to be sent with next message
}

// Closed tab entry for undo functionality (Cmd+Shift+T)
// Stores tab data with original position for restoration
export interface ClosedTab {
  tab: AITab;                      // The closed tab data
  index: number;                   // Original position in the tab array
  closedAt: number;                // Timestamp when closed
}

export interface Session {
  id: string;
  groupId?: string;
  name: string;
  toolType: ToolType;
  state: SessionState;
  cwd: string;
  fullPath: string;
  projectRoot: string; // The initial working directory (never changes, used for Claude session storage)
  aiLogs: LogEntry[];
  shellLogs: LogEntry[];
  workLog: WorkLogItem[];
  contextUsage: number;
  // Usage statistics from AI responses
  usageStats?: UsageStats;
  inputMode: 'terminal' | 'ai';
  // AI process PID (for non-batch agents like Aider)
  // For Claude batch mode, this is 0 since processes spawn per-message
  aiPid: number;
  // Terminal uses runCommand() which spawns fresh shells per command
  // This field is kept for backwards compatibility but is always 0
  terminalPid: number;
  port: number;
  // Live mode - makes session accessible via web interface
  isLive: boolean;
  liveUrl?: string;
  changedFiles: FileArtifact[];
  isGitRepo: boolean;
  // Git branches and tags cache (for tab completion)
  gitBranches?: string[];
  gitTags?: string[];
  gitRefsCacheTime?: number;  // Timestamp when branches/tags were last fetched
  // Worktree configuration (only set on parent sessions that manage worktrees)
  worktreeConfig?: {
    basePath: string;           // Directory where worktrees are stored
    watchEnabled: boolean;      // Whether to watch for new worktrees via chokidar
  };
  // Worktree child indicator (only set on worktree child sessions)
  parentSessionId?: string;     // Links back to parent agent session
  worktreeBranch?: string;      // The git branch this worktree is checked out to
  // Whether worktree children are expanded in the sidebar (only on parent sessions)
  worktreesExpanded?: boolean;
  // Legacy: Worktree parent path for auto-discovery (will be migrated to worktreeConfig)
  // TODO: Remove after migration to new parent/child model
  worktreeParentPath?: string;
  // File Explorer per-session state
  fileTree: any[];
  fileExplorerExpanded: string[];
  fileExplorerScrollPos: number;
  fileTreeError?: string;
  /** Timestamp when file tree should be retried after an error (for backoff) */
  fileTreeRetryAt?: number;
  fileTreeStats?: {
    fileCount: number;
    folderCount: number;
    totalSize: number;
  };
  // Shell state tracking
  shellCwd?: string;
  // Command history (separate for each mode)
  aiCommandHistory?: string[];
  shellCommandHistory?: string[];
  // Agent session ID for conversation continuity
  // DEPRECATED: Use aiTabs[activeIndex].agentSessionId instead
  agentSessionId?: string;
  // Pending jump path for /jump command (relative path within file tree)
  pendingJumpPath?: string;
  // Custom status message for the thinking indicator (e.g., "Agent is synopsizing...")
  statusMessage?: string;
  // Timestamp when agent started processing (for elapsed time display)
  thinkingStartTime?: number;
  // Token count for current thinking cycle (reset when new request starts)
  currentCycleTokens?: number;
  // Bytes received during current thinking cycle (for real-time progress display)
  currentCycleBytes?: number;
  // Tracks which mode (ai/terminal) triggered the busy state
  // Used to show the correct busy indicator message when user switches modes
  busySource?: 'ai' | 'terminal';
  // Execution queue for sequential processing within this session
  // All messages and commands are queued here and processed one at a time
  executionQueue: QueuedItem[];
  // Active time tracking - cumulative milliseconds of active use
  activeTimeMs: number;
  // Agent slash commands available for this session (fetched per session based on cwd)
  agentCommands?: { command: string; description: string; }[];
  // Bookmark flag - bookmarked sessions appear in a dedicated section at the top
  bookmarked?: boolean;
  // Pending AI command that will trigger a synopsis on completion (e.g., '/commit')
  pendingAICommandForSynopsis?: string;
  // Custom batch runner prompt (persisted per session)
  batchRunnerPrompt?: string;
  // Timestamp when the batch runner prompt was last modified
  batchRunnerPromptModifiedAt?: number;
  // CLI activity - present when CLI is running a playbook on this session
  cliActivity?: {
    playbookId: string;
    playbookName: string;
    startedAt: number;
  };

  // Tab management for AI mode (multi-tab Claude Code sessions)
  // Each tab represents a separate Claude Code conversation
  aiTabs: AITab[];
  // Currently active tab ID
  activeTabId: string;
  // Stack of recently closed tabs for undo (max 25, runtime-only, not persisted)
  closedTabHistory: ClosedTab[];
  // Saved scroll position for terminal/shell output view
  terminalScrollTop?: number;
  // Draft input for terminal mode (persisted across session switches)
  terminalDraftInput?: string;

  // Auto Run panel state (file-based document runner)
  autoRunFolderPath?: string;           // Persisted folder path for Runner Docs
  autoRunSelectedFile?: string;          // Currently selected markdown filename
  autoRunContent?: string;              // Document content (per-session to prevent cross-contamination)
  autoRunContentVersion?: number;       // Incremented on external file changes to force-sync
  autoRunMode?: 'edit' | 'preview';      // Current editing mode
  autoRunEditScrollPos?: number;         // Scroll position in edit mode
  autoRunPreviewScrollPos?: number;      // Scroll position in preview mode
  autoRunCursorPosition?: number;        // Cursor position in edit mode

  // File tree auto-refresh interval in seconds (0 = disabled)
  fileTreeAutoRefreshInterval?: number;

  // File preview navigation history (per-session to prevent cross-agent navigation)
  filePreviewHistory?: {name: string; content: string; path: string}[];
  filePreviewHistoryIndex?: number;

  // Nudge message - appended to every interactive user message (max 1000 chars)
  // Not visible in UI, but sent to the agent with each message
  nudgeMessage?: string;

  // Agent error state - set when an agent error is detected
  // Cleared when user dismisses the error or takes recovery action
  agentError?: AgentError;
  // Tab ID where the agent error originated (used for tab-scoped banners)
  agentErrorTabId?: string;

  // Whether operations are paused due to an agent error
  // When true, new messages are blocked until the error is resolved
  agentErrorPaused?: boolean;

  // SSH Remote execution status
  // Tracks the SSH remote being used for this session's agent execution
  sshRemote?: {
    id: string;          // SSH remote config ID
    name: string;        // Display name for UI
    host: string;        // Remote host for tooltip
  };

  // SSH Remote context (session-wide, for all operations - file explorer, git, auto run, etc.)
  sshRemoteId?: string;           // ID of SSH remote config being used (flattened from sshRemote.id)
  remoteCwd?: string;             // Current working directory on remote host

  // Inline wizard state for /wizard command
  // Keeps per-session/per-tab wizard state for creating or iterating on Auto Run documents
  wizardState?: SessionWizardState;

  // Per-session agent configuration overrides
  // These override the global agent-level settings for this specific session
  customPath?: string;           // Custom path to agent binary (overrides agent-level)
  customArgs?: string;           // Custom CLI arguments (overrides agent-level)
  customEnvVars?: Record<string, string>; // Custom environment variables (overrides agent-level)
  customModel?: string;          // Custom model ID (overrides agent-level)
  customProviderPath?: string;   // Custom provider path (overrides agent-level)
  customContextWindow?: number;  // Custom context window size (overrides agent-level)
  // Per-session SSH remote configuration (overrides agent-level SSH config)
  // When set, this session uses the specified SSH remote; when not set, runs locally
  sessionSshRemoteConfig?: {
    enabled: boolean;            // Whether SSH is enabled for this session
    remoteId: string | null;     // SSH remote config ID to use
    workingDirOverride?: string; // Override remote working directory
  };

  // SSH connection status - runtime only, not persisted
  // Set when background SSH operations fail (e.g., git info fetch on startup)
  sshConnectionFailed?: boolean;
}

export interface AgentConfigOption {
  key: string;
  type: 'checkbox' | 'text' | 'number' | 'select';
  label: string;
  description: string;
  default: any;
  options?: string[];
  argBuilder?: (value: any) => string[];
}

export interface AgentCapabilities {
  supportsResume: boolean;
  supportsReadOnlyMode: boolean;
  supportsJsonOutput: boolean;
  supportsSessionId: boolean;
  supportsImageInput: boolean;
  supportsImageInputOnResume: boolean;
  supportsSlashCommands: boolean;
  supportsSessionStorage: boolean;
  supportsCostTracking: boolean;
  supportsUsageStats: boolean;
  supportsBatchMode: boolean;
  requiresPromptToStart: boolean;
  supportsStreaming: boolean;
  supportsResultMessages: boolean;
  supportsModelSelection?: boolean;
  supportsStreamJsonInput?: boolean;
  supportsThinkingDisplay?: boolean;
  supportsContextMerge?: boolean;
  supportsContextExport?: boolean;
}

export interface AgentConfig {
  id: string;
  name: string;
  binaryName?: string;
  available: boolean;
  path?: string;
  customPath?: string; // User-specified custom path (shown in UI even if not available)
  command?: string;
  args?: string[];
  hidden?: boolean; // If true, agent is hidden from UI (internal use only)
  configOptions?: AgentConfigOption[]; // Agent-specific configuration options
  yoloModeArgs?: string[]; // Args for YOLO/full-access mode (e.g., ['--dangerously-skip-permissions'])
  capabilities?: AgentCapabilities; // Agent capabilities (added at runtime)
}

// Process spawning configuration
export interface ProcessConfig {
  sessionId: string;
  toolType: string;
  cwd: string;
  command: string;
  args: string[];
  prompt?: string; // For batch mode agents like Claude (passed as CLI argument)
  shell?: string; // Shell to use for terminal sessions (e.g., 'zsh', 'bash', 'fish')
  images?: string[]; // Base64 data URLs for images
  // Agent-specific spawn options (used to build args via agent config)
  agentSessionId?: string; // For session resume (uses agent's resumeArgs builder)
  readOnlyMode?: boolean; // For read-only/plan mode (uses agent's readOnlyArgs)
  modelId?: string; // For model selection (uses agent's modelArgs builder)
  yoloMode?: boolean; // For YOLO/full-access mode (uses agent's yoloModeArgs)
  // Per-session overrides (take precedence over agent-level config)
  sessionCustomPath?: string;
  sessionCustomArgs?: string;
  sessionCustomEnvVars?: Record<string, string>;
  sessionCustomModel?: string;
  sessionCustomContextWindow?: number;
  // Per-session SSH remote config (takes precedence over agent-level SSH config)
  sessionSshRemoteConfig?: {
    enabled: boolean;
    remoteId: string | null;
    workingDirOverride?: string;
  };
}

// Directory entry from fs:readDir
export interface DirectoryEntry {
  name: string;
  isDirectory: boolean;
  path: string;
}

// Shell information from shells:detect
export interface ShellInfo {
  id: string;
  name: string;
  available: boolean;
  path?: string;
}

// Custom AI command definition for user-configurable slash commands
export interface CustomAICommand {
  id: string;
  command: string; // The slash command (e.g., '/commit')
  description: string; // Short description shown in autocomplete
  prompt: string; // The actual prompt sent to the AI agent
  isBuiltIn?: boolean; // If true, cannot be deleted (only edited)
}

// Spec Kit command definition (bundled from github/spec-kit)
export interface SpecKitCommand {
  id: string; // e.g., 'constitution'
  command: string; // e.g., '/speckit.constitution'
  description: string;
  prompt: string;
  isCustom: boolean; // true only for 'implement' (our Maestro-specific version)
  isModified: boolean; // true if user has edited
}

// Spec Kit metadata for tracking version and refresh status
export interface SpecKitMetadata {
  lastRefreshed: string; // ISO date
  commitSha: string; // Git commit SHA or version tag
  sourceVersion: string; // Semantic version (e.g., '0.0.90')
  sourceUrl: string; // GitHub repo URL
}

// OpenSpec command definition (bundled from Fission-AI/OpenSpec)
export interface OpenSpecCommand {
  id: string; // e.g., 'proposal'
  command: string; // e.g., '/openspec.proposal'
  description: string;
  prompt: string;
  isCustom: boolean; // true for 'help' and 'implement' (Maestro-specific)
  isModified: boolean; // true if user has edited
}

// OpenSpec metadata for tracking version and refresh status
export interface OpenSpecMetadata {
  lastRefreshed: string; // ISO date
  commitSha: string; // Git commit SHA or version tag
  sourceVersion: string; // Semantic version
  sourceUrl: string; // GitHub repo URL
}

// Leaderboard registration data for runmaestro.ai integration
export interface LeaderboardRegistration {
  // Required fields
  email: string;                 // User's email (will be confirmed)
  displayName: string;           // Display name on leaderboard
  // Optional social handles (without @)
  twitterHandle?: string;        // X/Twitter handle
  githubUsername?: string;       // GitHub username
  linkedinHandle?: string;       // LinkedIn handle
  discordUsername?: string;      // Discord username (for @mentions in Discord posts)
  // Registration state
  registeredAt: number;          // Timestamp when registered
  emailConfirmed: boolean;       // Whether email has been confirmed
  lastSubmissionAt?: number;     // Last successful submission timestamp
  // Authentication
  clientToken?: string;          // Client-generated token for polling auth status
  authToken?: string;            // 64-character token received after email confirmation
  // Keyboard mastery data
  keyboardMasteryLevel?: number;       // 0-4 (Beginner to Maestro)
  keyboardMasteryLevelName?: string;   // Level name
  keyboardMasteryPercentage?: number;  // 0-100
}

// Ranking info for a single leaderboard category
export interface LeaderboardRankingInfo {
  rank: number;           // User's position (1 = first place)
  total: number;          // Total entries on leaderboard
  previousRank: number | null;  // Previous position (null if new entry)
  improved: boolean;      // Did they move up?
}

// Keyboard Mastery gamification types
export type KeyboardMasteryLevel = 'beginner' | 'student' | 'performer' | 'virtuoso' | 'maestro';

export interface KeyboardMasteryStats {
  usedShortcuts: string[];        // Array of shortcut IDs that have been used
  currentLevel: number;           // 0-4 (Beginner to Keyboard Maestro)
  lastLevelUpTimestamp: number;   // When user last leveled up
  lastAcknowledgedLevel: number;  // Last level user dismissed celebration for
}

// Response from leaderboard submission API
export interface LeaderboardSubmitResponse {
  success: boolean;
  message: string;
  requiresConfirmation?: boolean;
  confirmationUrl?: string;
  error?: string;
  ranking?: {
    cumulative: LeaderboardRankingInfo;
    longestRun: LeaderboardRankingInfo | null;  // null if no longestRunMs submitted
  };
}

// Context management settings for merge and transfer operations
export interface ContextManagementSettings {
  autoGroomContexts: boolean;              // Automatically groom contexts during transfer (default: true)
  maxContextTokens: number;                // Maximum tokens for context operations (default: 100000)
  showMergePreview: boolean;               // Show preview before merge (default: true)
  groomingTimeout: number;                 // Timeout for grooming operations in ms (default: 60000)
  preferredGroomingAgent: ToolType | 'fastest';  // Which agent to use for grooming (default: 'fastest')
  // Context window warning settings (Phase 6)
  contextWarningsEnabled: boolean;         // Enable context consumption warnings (default: true)
  contextWarningYellowThreshold: number;   // Yellow warning threshold percentage (default: 60)
  contextWarningRedThreshold: number;      // Red warning threshold percentage (default: 80)
}
