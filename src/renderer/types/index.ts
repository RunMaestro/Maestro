// Type definitions for Maestro renderer

// Re-export theme types from shared location
export type { Theme, ThemeId, ThemeMode, ThemeColors } from '../../shared/theme-types';
export { isValidThemeId } from '../../shared/theme-types';

// Re-export error types from shared location
export type { AgentError, AgentErrorType, AgentErrorRecovery } from '../../shared/types';

// Re-export group chat types from shared location
export type {
  GroupChat,
  GroupChatParticipant,
  GroupChatMessage,
  GroupChatState,
  ModeratorConfig,
} from '../../shared/group-chat-types';
// Import AgentError for use within this file
import type { AgentError } from '../../shared/types';

export type ToolType = 'claude' | 'claude-code' | 'aider' | 'opencode' | 'codex' | 'terminal';
export type SessionState = 'idle' | 'busy' | 'waiting_input' | 'connecting' | 'error';
export type FileChangeType = 'modified' | 'added' | 'deleted';
export type RightPanelTab = 'files' | 'history' | 'autorun';
// Note: ScratchPadMode was removed as part of the Scratchpad → Auto Run migration
export type FocusArea = 'sidebar' | 'main' | 'right';
export type LLMProvider = 'openrouter' | 'anthropic' | 'ollama';

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
  source: 'stdout' | 'stderr' | 'system' | 'user' | 'ai' | 'error';
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

// Document entry in the batch run queue (supports duplicates)
export interface BatchDocumentEntry {
  id: string;              // Unique ID for this entry (for drag-drop and duplicates)
  filename: string;        // The actual document filename (without .md)
  resetOnCompletion: boolean;  // Uncheck all boxes when done
  isDuplicate: boolean;    // True if this is a duplicate (can be removed)
  isMissing?: boolean;     // True if this document no longer exists in the folder (for playbook loading)
}

// Git worktree configuration for Auto Run
export interface WorktreeConfig {
  enabled: boolean;              // Whether to use a worktree
  path: string;                  // Absolute path for the worktree
  branchName: string;            // Branch name to use/create
  createPROnCompletion: boolean; // Create PR when Auto Run finishes
  prTargetBranch: string;        // Target branch for the PR (e.g., 'main')
  ghPath?: string;               // Custom path to gh CLI binary (optional)
}

// Configuration for starting a batch run
export interface BatchRunConfig {
  documents: BatchDocumentEntry[];  // Ordered list of docs to run
  prompt: string;
  loopEnabled: boolean;    // Loop back to first doc when done
  maxLoops?: number | null;  // Max loop iterations (null/undefined = infinite)
  worktree?: WorktreeConfig;     // Optional worktree configuration
}

// Batch processing state
export interface BatchRunState {
  isRunning: boolean;
  isStopping: boolean; // Waiting for current task to finish before stopping

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
  accumulatedElapsedMs?: number; // Accumulated active elapsed time (excludes sleep/suspend time)
  lastActiveTimestamp?: number; // Last timestamp when actively tracking (for pause/resume calculation)

  // Error handling state (Phase 5.10)
  error?: AgentError;                // Current error if batch is paused due to agent error
  errorPaused?: boolean;             // True if batch is paused waiting for error resolution
  errorDocumentIndex?: number;       // Which document had the error (for skip functionality)
  errorTaskDescription?: string;     // Description of the task that failed (for UI display)
}

// Document entry within a playbook (similar to BatchDocumentEntry but for storage)
export interface PlaybookDocumentEntry {
  filename: string;                  // Document filename (without .md)
  resetOnCompletion: boolean;
  // Note: isDuplicate is not stored - duplicates are just repeated entries
}

// A saved Playbook configuration
export interface Playbook {
  id: string;                        // Unique ID (UUID)
  name: string;                      // User-defined name
  createdAt: number;                 // Timestamp
  updatedAt: number;                 // Timestamp

  // Configuration
  documents: PlaybookDocumentEntry[];  // Ordered list of documents
  loopEnabled: boolean;
  maxLoops?: number | null;          // Max loop iterations (null/undefined = infinite)
  prompt: string;                    // Custom agent prompt

  // Optional worktree settings (path not stored - user selects each time)
  worktreeSettings?: {
    branchNameTemplate: string;    // e.g., "autorun-{playbook}-{timestamp}"
    createPROnCompletion: boolean;
    prTargetBranch?: string;       // Target branch for PR (e.g., 'main')
  };
}

// Usage statistics from AI agent CLI (Claude Code, Codex, etc.)
export interface UsageStats {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  totalCostUsd: number;
  contextWindow: number; // e.g., 400000 for Claude/GPT-5.2, 128000 for GPT-4o
  /**
   * Reasoning/thinking tokens (separate from outputTokens)
   * Some models like OpenAI o3/o4-mini report reasoning tokens separately.
   * These are already included in outputTokens but tracked separately for UI display.
   */
  reasoningTokens?: number;
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
  awaitingSessionId?: boolean;     // True when this tab sent a message and is awaiting its session ID
  thinkingStartTime?: number;      // Timestamp when tab started thinking (for elapsed time display)
  scrollTop?: number;              // Saved scroll position for this tab's output view
  hasUnread?: boolean;             // True when tab has new messages user hasn't seen
  isAtBottom?: boolean;            // True when user is scrolled to bottom of output
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
  // File Explorer per-session state
  fileTree: any[];
  fileExplorerExpanded: string[];
  fileExplorerScrollPos: number;
  fileTreeError?: string;
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

  // Per-session agent configuration overrides
  // These override the global agent-level settings for this specific session
  customPath?: string;           // Custom path to agent binary (overrides agent-level)
  customArgs?: string;           // Custom CLI arguments (overrides agent-level)
  customEnvVars?: Record<string, string>; // Custom environment variables (overrides agent-level)
  customModel?: string;          // Custom model ID (overrides agent-level)
  customProviderPath?: string;   // Custom provider path (overrides agent-level)
  customContextWindow?: number;  // Custom context window size (overrides agent-level)
}

export interface Group {
  id: string;
  name: string;
  emoji: string;
  collapsed: boolean;
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

// Leaderboard registration data for runmaestro.ai integration
export interface LeaderboardRegistration {
  // Required fields
  email: string;                 // User's email (will be confirmed)
  displayName: string;           // Display name on leaderboard
  // Optional social handles (without @)
  twitterHandle?: string;        // X/Twitter handle
  githubUsername?: string;       // GitHub username
  linkedinHandle?: string;       // LinkedIn handle
  // Registration state
  registeredAt: number;          // Timestamp when registered
  emailConfirmed: boolean;       // Whether email has been confirmed
  lastSubmissionAt?: number;     // Last successful submission timestamp
  // Authentication
  clientToken?: string;          // Client-generated token for polling auth status
  authToken?: string;            // 64-character token received after email confirmation
}

// Ranking info for a single leaderboard category
export interface LeaderboardRankingInfo {
  rank: number;           // User's position (1 = first place)
  total: number;          // Total entries on leaderboard
  previousRank: number | null;  // Previous position (null if new entry)
  improved: boolean;      // Did they move up?
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
