import type { UsageStats } from '../types';
import type { Shortcut } from '../shortcut-types';

/** Serializable session usage summary exposed to web clients. */
export type SessionUsageStats = Partial<UsageStats>;

/** Serializable AI-tab state shared by main, preload, and web clients. */
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

/** Truncated response preview included in session snapshots. */
export interface LastResponsePreview {
	text: string;
	timestamp: number;
	source: 'stdout' | 'stderr' | 'system';
	fullLength: number;
}

/** Transport-safe session snapshot. Runtime-only session state stays in main. */
export interface SessionData {
	id: string;
	name: string;
	toolType: string;
	state: string;
	inputMode: string;
	cwd: string;
	groupId?: string | null;
	groupName?: string | null;
	groupEmoji?: string | null;
	usageStats?: SessionUsageStats | null;
	lastResponse?: LastResponsePreview | null;
	agentSessionId?: string | null;
	thinkingStartTime?: number | null;
	aiTabs?: AITabData[];
	activeTabId?: string;
	bookmarked?: boolean;
	parentSessionId?: string | null;
	worktreeBranch?: string | null;
	isGitRepo?: boolean;
	worktreeBasePath?: string | null;
	autoRunFolderPath?: string | null;
}

/** State for an Auto Run task sequence. */
export interface AutoRunState {
	isRunning: boolean;
	totalTasks: number;
	completedTasks: number;
	currentTaskIndex: number;
	isStopping?: boolean;
	totalDocuments?: number;
	currentDocumentIndex?: number;
	totalTasksAcrossAllDocs?: number;
	completedTasksAcrossAllDocs?: number;
	errorPaused?: boolean;
	errorMessage?: string;
	errorType?: string;
	errorRecoverable?: boolean;
	errorDocumentIndex?: number;
	errorTaskDescription?: string;
	goalMode?: boolean;
	goalProgress?: number;
	goalRationale?: string;
	goalIteration?: number;
}

/** User-configured command surfaced in web clients. */
export interface CustomAICommand {
	id: string;
	command: string;
	description: string;
	prompt: string;
}

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
	maxOutputLines: number | null;
	shortcuts: Record<string, Shortcut>;
}

export interface GroupData {
	id: string;
	name: string;
	emoji: string | null;
	parentGroupId?: string;
	sessionIds: string[];
}

export interface AutoRunDocument {
	filename: string;
	path: string;
	taskCount: number;
	completedCount: number;
	folder?: string;
}

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

export interface GroupChatMessage {
	id: string;
	participantId: string;
	participantName: string;
	content: string;
	timestamp: number;
	role: 'user' | 'assistant';
}

export interface GroupChatState {
	id: string;
	topic: string;
	participants: Array<{ sessionId: string; name: string; toolType: string }>;
	messages: GroupChatMessage[];
	isActive: boolean;
	currentTurn?: string;
}
