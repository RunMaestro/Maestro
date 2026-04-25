/**
 * Shared type definitions for the web server module.
 * All web server components should import types from this file to avoid duplication.
 */

import type { WebSocket } from 'ws';
import type { Theme } from '../../shared/theme-types';
import type { Shortcut } from '../../shared/shortcut-types';

// Re-export Theme for convenience
export type { Theme } from '../../shared/theme-types';

// =============================================================================
// Core Types
// =============================================================================

/**
 * Usage stats type for session cost/token tracking.
 */
export interface SessionUsageStats {
	inputTokens?: number;
	outputTokens?: number;
	cacheReadInputTokens?: number;
	cacheCreationInputTokens?: number;
	totalCostUsd?: number;
	contextWindow?: number;
}

/**
 * Last response type for mobile preview (truncated to save bandwidth).
 */
export interface LastResponsePreview {
	/** First 3 lines or ~500 chars of the last AI response */
	text: string;
	timestamp: number;
	source: 'stdout' | 'stderr' | 'system';
	/** Total length of the original response */
	fullLength: number;
}

/**
 * AI Tab type for multi-tab support within a Maestro session.
 */
export interface AITabData {
	id: string;
	agentSessionId: string | null;
	name: string | null;
	starred: boolean;
	inputValue: string;
	usageStats?: SessionUsageStats | null;
	createdAt: number;
	state: 'idle' | 'busy';
	thinkingStartTime?: number | null;
	hasUnread?: boolean;
}

/**
 * Live session info for tracking live-enabled sessions.
 */
export interface LiveSessionInfo {
	sessionId: string;
	agentSessionId?: string;
	enabledAt: number;
}

/**
 * Custom AI command definition.
 */
export interface CustomAICommand {
	id: string;
	command: string;
	description: string;
	prompt: string;
}

/**
 * Rate limiting configuration for web server endpoints.
 */
export interface RateLimitConfig {
	/** Maximum requests per time window */
	max: number;
	/** Time window in milliseconds */
	timeWindow: number;
	/** Maximum requests for POST endpoints (typically lower) */
	maxPost: number;
	/** Enable/disable rate limiting */
	enabled: boolean;
}

// =============================================================================
// Session Types
// =============================================================================

/**
 * Session data returned by getSessions callback.
 */
export interface SessionData {
	id: string;
	name: string;
	toolType: string;
	state: string;
	inputMode: string;
	cwd: string;
	groupId: string | null;
	groupName: string | null;
	groupEmoji: string | null;
	usageStats?: SessionUsageStats | null;
	lastResponse?: LastResponsePreview | null;
	agentSessionId?: string | null;
	/** Timestamp when AI started thinking (for elapsed time display) */
	thinkingStartTime?: number | null;
	aiTabs?: AITabData[];
	activeTabId?: string;
	/** Whether session is bookmarked (shows in Bookmarks group) */
	bookmarked?: boolean;
}

/**
 * Session detail type for single session endpoint.
 */
export interface SessionDetail {
	id: string;
	name: string;
	toolType: string;
	state: string;
	inputMode: string;
	cwd: string;
	aiLogs?: Array<{ timestamp: number; content: string; type?: string }>;
	shellLogs?: Array<{ timestamp: number; content: string; type?: string }>;
	usageStats?: {
		inputTokens?: number;
		outputTokens?: number;
		totalCost?: number;
	};
	agentSessionId?: string;
	isGitRepo?: boolean;
	activeTabId?: string;
}

/**
 * Session data for broadcast messages.
 */
export interface SessionBroadcastData {
	id: string;
	name: string;
	toolType: string;
	state: string;
	inputMode: string;
	cwd: string;
	groupId?: string | null;
	groupName?: string | null;
	groupEmoji?: string | null;
	/** Worktree subagent support */
	parentSessionId?: string | null;
	worktreeBranch?: string | null;
}

// =============================================================================
// AutoRun Types
// =============================================================================

/**
 * Auto Run state for broadcast messages.
 */
export interface AutoRunState {
	isRunning: boolean;
	totalTasks: number;
	completedTasks: number;
	currentTaskIndex: number;
	isStopping?: boolean;
	/** Total number of documents in the run (multi-document progress) */
	totalDocuments?: number;
	/** Current document being processed (0-based, multi-document progress) */
	currentDocumentIndex?: number;
	/** Total tasks across all documents (multi-document progress) */
	totalTasksAcrossAllDocs?: number;
	/** Completed tasks across all documents (multi-document progress) */
	completedTasksAcrossAllDocs?: number;
}

/**
 * CLI activity data for session state broadcasts.
 */
export interface CliActivity {
	playbookId: string;
	playbookName: string;
	startedAt: number;
}

// =============================================================================
// WebSocket Client Types
// =============================================================================

/**
 * Web client connection info.
 */
export interface WebClient {
	socket: WebSocket;
	id: string;
	connectedAt: number;
	subscribedSessionId?: string;
}

/**
 * Web client message interface.
 */
export interface WebClientMessage {
	type: string;
	sessionId?: string;
	tabId?: string;
	command?: string;
	mode?: 'ai' | 'terminal';
	inputMode?: 'ai' | 'terminal';
	newName?: string;
	[key: string]: unknown;
}

// =============================================================================
// Callback Types
// =============================================================================

/**
 * Callback type for fetching sessions data.
 */
export type GetSessionsCallback = () => SessionData[];

/**
 * Callback type for fetching single session details.
 * Optional tabId allows fetching logs for a specific tab (avoids race conditions).
 */
export type GetSessionDetailCallback = (sessionId: string, tabId?: string) => SessionDetail | null;

/**
 * Callback type for sending commands to a session.
 * Returns true if successful, false if session not found or write failed.
 */
export type WriteToSessionCallback = (sessionId: string, data: string) => boolean;

/**
 * Callback type for executing a command through the desktop's existing logic.
 * This forwards the command to the renderer which handles spawn, state, and broadcasts.
 * Returns true if command was accepted (session not busy).
 * inputMode is optional - if provided, the renderer will use it instead of querying session state.
 */
export type ExecuteCommandCallback = (
	sessionId: string,
	command: string,
	inputMode?: 'ai' | 'terminal'
) => Promise<boolean>;

/**
 * Callback type for interrupting a session through the desktop's existing logic.
 * This forwards to the renderer which handles state updates and broadcasts.
 */
export type InterruptSessionCallback = (sessionId: string) => Promise<boolean>;

/**
 * Callback type for switching session input mode through the desktop's existing logic.
 * This forwards to the renderer which handles state updates and broadcasts.
 */
export type SwitchModeCallback = (sessionId: string, mode: 'ai' | 'terminal') => Promise<boolean>;

/**
 * Callback type for selecting/switching to a session in the desktop app.
 * This forwards to the renderer which handles state updates and broadcasts.
 * Optional tabId to also switch to a specific tab within the session.
 */
export type SelectSessionCallback = (
	sessionId: string,
	tabId?: string,
	focus?: boolean
) => Promise<boolean>;

/**
 * Tab operation callbacks for multi-tab support.
 */
export type SelectTabCallback = (sessionId: string, tabId: string) => Promise<boolean>;
export type NewTabCallback = (sessionId: string) => Promise<{ tabId: string } | null>;
export type CloseTabCallback = (sessionId: string, tabId: string) => Promise<boolean>;
export type RenameTabCallback = (
	sessionId: string,
	tabId: string,
	newName: string
) => Promise<boolean>;
export type StarTabCallback = (
	sessionId: string,
	tabId: string,
	starred: boolean
) => Promise<boolean>;
export type ReorderTabCallback = (
	sessionId: string,
	fromIndex: number,
	toIndex: number
) => Promise<boolean>;
export type ToggleBookmarkCallback = (sessionId: string) => Promise<boolean>;
export type OpenFileTabCallback = (sessionId: string, filePath: string) => Promise<boolean>;
export type RefreshFileTreeCallback = (sessionId: string) => Promise<boolean>;
export type NewAITabWithPromptCallback = (sessionId: string, prompt: string) => Promise<boolean>;
export type OpenBrowserTabCallback = (sessionId: string, url: string) => Promise<boolean>;
export interface OpenTerminalTabConfig {
	cwd?: string;
	shell?: string;
	name?: string | null;
}
export type OpenTerminalTabCallback = (
	sessionId: string,
	config: OpenTerminalTabConfig
) => Promise<boolean>;
export type RefreshAutoRunDocsCallback = (sessionId: string) => Promise<boolean>;
export type ConfigureAutoRunCallback = (
	sessionId: string,
	config: {
		documents: Array<{ filename: string; resetOnCompletion?: boolean }>;
		prompt?: string;
		loopEnabled?: boolean;
		maxLoops?: number;
		saveAsPlaybook?: string;
		launch?: boolean;
		worktree?: {
			enabled: boolean;
			path: string;
			branchName: string;
			createPROnCompletion: boolean;
			prTargetBranch: string;
		};
	}
) => Promise<{ success: boolean; playbookId?: string; error?: string }>;

/**
 * Callback type for fetching current theme.
 */
export type GetThemeCallback = () => Theme | null;

/**
 * Callback type for fetching the current global Bionify reading-mode setting.
 */
export type GetBionifyReadingModeCallback = () => boolean;

/**
 * Callback type for fetching custom AI commands.
 */
export type GetCustomCommandsCallback = () => CustomAICommand[];

/**
 * Callback type for fetching history entries.
 * Uses HistoryEntry from shared/types.ts as the canonical type.
 */
export type GetHistoryCallback = (
	projectPath?: string,
	sessionId?: string
) => import('../../shared/types').HistoryEntry[];

/**
 * Callback to get all connected web clients.
 */
export type GetWebClientsCallback = () => Map<string, WebClient>;

// =============================================================================
// Web UX Parity Types
// =============================================================================

/**
 * Union type for setting values exposed to web.
 */
export type SettingValue = string | number | boolean | null;

/**
 * Curated subset of settings exposed to the web interface.
 */
export interface WebSettings {
	theme: string;
	fontSize: number;
	enterToSendAI: boolean;
	defaultSaveToHistory: boolean;
	defaultShowThinking: string;
	autoScroll: boolean;
	notificationsEnabled: boolean;
	audioFeedbackEnabled: boolean;
	colorBlindMode: string;
	conductorProfile: string;
	/** User-customized keyboard shortcuts (partial overrides of DEFAULT_SHORTCUTS). */
	shortcuts: Record<string, Shortcut>;
}

/**
 * Group info for web.
 */
export interface GroupData {
	id: string;
	name: string;
	emoji: string | null;
	sessionIds: string[];
}

/**
 * Auto Run document metadata.
 */
export interface AutoRunDocument {
	filename: string;
	path: string;
	taskCount: number;
	completedCount: number;
}

/**
 * File tree entry.
 */
export interface FileTreeNode {
	name: string;
	path: string;
	isDirectory: boolean;
	children?: FileTreeNode[];
	size?: number;
}

/**
 * File content response.
 */
export interface FileContentResult {
	content: string;
	language: string;
	size: number;
	truncated: boolean;
}

/**
 * Git status entry.
 */
export interface GitStatusFile {
	path: string;
	status: string;
	staged: boolean;
}

/**
 * Git status response.
 */
export interface GitStatusResult {
	branch: string;
	files: GitStatusFile[];
	ahead: number;
	behind: number;
}

/**
 * Git diff response.
 */
export interface GitDiffResult {
	diff: string;
	files: string[];
}

/**
 * Notification preferences configuration.
 */
export interface NotificationPreferences {
	agentComplete: boolean;
	agentError: boolean;
	autoRunComplete: boolean;
	autoRunTaskComplete: boolean;
	contextWarning: boolean;
	soundEnabled: boolean;
}

/**
 * Notification broadcast payload.
 */
export interface NotificationEvent {
	eventType:
		| 'agent_complete'
		| 'agent_error'
		| 'autorun_complete'
		| 'autorun_task_complete'
		| 'context_warning';
	sessionId: string;
	sessionName: string;
	message: string;
	severity: 'info' | 'warning' | 'error';
}

// =============================================================================
// Web UX Parity Callback Types
// =============================================================================

export type GetSettingsCallback = () => WebSettings;
export type SetSettingCallback = (key: string, value: SettingValue) => Promise<boolean>;
export type GetGroupsCallback = () => GroupData[];
export type CreateGroupCallback = (name: string, emoji?: string) => Promise<{ id: string } | null>;
export type RenameGroupCallback = (groupId: string, name: string) => Promise<boolean>;
export type DeleteGroupCallback = (groupId: string) => Promise<boolean>;
export type MoveSessionToGroupCallback = (
	sessionId: string,
	groupId: string | null
) => Promise<boolean>;
/**
 * Optional configuration fields for session creation via CLI/web.
 * These map 1:1 to the optional params of createNewSession in useSessionCrud.ts.
 */
export interface CreateSessionConfig {
	nudgeMessage?: string;
	newSessionMessage?: string;
	customPath?: string;
	customArgs?: string;
	customEnvVars?: Record<string, string>;
	customModel?: string;
	customEffort?: string;
	customContextWindow?: number;
	customProviderPath?: string;
	sessionSshRemoteConfig?: {
		enabled: boolean;
		remoteId: string | null;
		workingDirOverride?: string;
	};
	autoRunFolderPath?: string;
}

export type CreateSessionCallback = (
	name: string,
	toolType: string,
	cwd: string,
	groupId?: string,
	config?: CreateSessionConfig
) => Promise<{ sessionId: string } | null>;
export type DeleteSessionCallback = (sessionId: string) => Promise<boolean>;
export type RenameSessionCallback = (sessionId: string, newName: string) => Promise<boolean>;
export type GetAutoRunDocsCallback = (sessionId: string) => Promise<AutoRunDocument[]>;
export type GetAutoRunDocContentCallback = (sessionId: string, filename: string) => Promise<string>;
export type SaveAutoRunDocCallback = (
	sessionId: string,
	filename: string,
	content: string
) => Promise<boolean>;
export type StopAutoRunCallback = (sessionId: string) => Promise<boolean>;
export type GetFileTreeCallback = (sessionId: string, subPath?: string) => Promise<FileTreeNode[]>;
export type GetFileContentCallback = (
	sessionId: string,
	filePath: string
) => Promise<FileContentResult>;
export type GetGitStatusCallback = (sessionId: string) => Promise<GitStatusResult>;
export type GetGitDiffCallback = (sessionId: string, filePath?: string) => Promise<GitDiffResult>;

// =============================================================================
// Group Chat Types
// =============================================================================

/**
 * Group chat message for web interface.
 */
export interface GroupChatMessage {
	id: string;
	participantId: string;
	participantName: string;
	content: string;
	timestamp: number;
	role: 'user' | 'assistant';
}

/**
 * Group chat state for web interface.
 */
export interface GroupChatState {
	id: string;
	topic: string;
	participants: Array<{ sessionId: string; name: string; toolType: string }>;
	messages: GroupChatMessage[];
	isActive: boolean;
	currentTurn?: string;
}

// =============================================================================
// Group Chat Callback Types
// =============================================================================

export type StartGroupChatCallback = (
	topic: string,
	participantIds: string[]
) => Promise<{ chatId: string } | null>;
export type GetGroupChatStateCallback = (chatId: string) => Promise<GroupChatState | null>;
export type StopGroupChatCallback = (chatId: string) => Promise<boolean>;
export type SendGroupChatMessageCallback = (chatId: string, message: string) => Promise<boolean>;
export type GetGroupChatsCallback = () => Promise<GroupChatState[]>;

// =============================================================================
// Context Management Callback Types
// =============================================================================

export type MergeContextCallback = (
	sourceSessionId: string,
	targetSessionId: string
) => Promise<boolean>;
export type TransferContextCallback = (
	sourceSessionId: string,
	targetSessionId: string
) => Promise<boolean>;
export type SummarizeContextCallback = (sessionId: string) => Promise<boolean>;

// =============================================================================
// Cue Automation Types
// =============================================================================

/** Web-specific Cue subscription metadata (simplified from engine types) */
export interface CueSubscriptionInfo {
	id: string;
	name: string;
	eventType: string;
	pattern?: string;
	schedule?: string;
	sessionId: string;
	sessionName: string;
	enabled: boolean;
	lastTriggered?: number;
	triggerCount: number;
}

/** Web-specific Cue activity log entry (simplified from engine types) */
export interface CueActivityEntry {
	id: string;
	subscriptionId: string;
	subscriptionName: string;
	eventType: string;
	sessionId: string;
	timestamp: number;
	status: 'triggered' | 'running' | 'completed' | 'failed';
	result?: string;
	duration?: number;
}

// =============================================================================
// Cue Automation Callback Types
// =============================================================================

export type GetCueSubscriptionsCallback = (sessionId?: string) => Promise<CueSubscriptionInfo[]>;
export type ToggleCueSubscriptionCallback = (
	subscriptionId: string,
	enabled: boolean
) => Promise<boolean>;
export type GetCueActivityCallback = (
	sessionId?: string,
	limit?: number
) => Promise<CueActivityEntry[]>;
export type TriggerCueSubscriptionCallback = (
	subscriptionName: string,
	prompt?: string,
	sourceAgentId?: string
) => Promise<boolean>;

// =============================================================================
// Usage Dashboard Types
// =============================================================================

/** Usage dashboard aggregate data for web interface */
export interface UsageDashboardData {
	totalTokensIn: number;
	totalTokensOut: number;
	totalCost: number;
	sessionBreakdown: Array<{
		sessionId: string;
		sessionName: string;
		tokensIn: number;
		tokensOut: number;
		cost: number;
	}>;
	dailyUsage: Array<{
		date: string;
		tokensIn: number;
		tokensOut: number;
		cost: number;
	}>;
}

/** Achievement data for web interface */
export interface AchievementData {
	id: string;
	name: string;
	description: string;
	unlocked: boolean;
	unlockedAt?: number;
	progress?: number;
	maxProgress?: number;
}

// =============================================================================
// Usage Dashboard Callback Types
// =============================================================================

export type GetUsageDashboardCallback = (
	timeRange: 'day' | 'week' | 'month' | 'all'
) => Promise<UsageDashboardData>;
export type GetAchievementsCallback = () => Promise<AchievementData[]>;

// =============================================================================
// Director's Notes Callback Types
// =============================================================================

export interface DirectorNotesSynopsisResult {
	success: boolean;
	synopsis: string;
	generatedAt?: number;
	stats?: {
		agentCount: number;
		entryCount: number;
		durationMs: number;
	};
	error?: string;
}

export type GenerateDirectorNotesSynopsisCallback = (
	lookbackDays: number,
	provider: string
) => Promise<DirectorNotesSynopsisResult>;
