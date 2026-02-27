import type { SessionState, ToolType } from './index';

export interface InboxItem {
	sessionId: string;
	tabId: string;
	groupId?: string;
	groupName?: string;
	sessionName: string;
	tabName?: string;
	toolType: ToolType;
	gitBranch?: string;
	contextUsage?: number; // 0-100, undefined = unknown
	lastMessage: string; // truncated to 90 chars
	timestamp: number; // Unix ms, must be validated > 0
	state: SessionState;
	hasUnread: boolean;
	starred?: boolean;
}

/** UI labels: "Newest", "Oldest", "Grouped", "By Agent" */
export type InboxSortMode = 'newest' | 'oldest' | 'grouped' | 'byAgent';

/** UI labels: "All", "Unread", "Read", "Starred" */
export type InboxFilterMode = 'all' | 'unread' | 'read' | 'starred';

/** Human-readable status badges */
export const STATUS_LABELS: Record<SessionState, string> = {
	idle: 'Ready',
	waiting_input: 'Needs Input',
	busy: 'Processing',
	connecting: 'Connecting',
	error: 'Error',
};

// Note: Values are not keyof ThemeColors — 'info' and 'textMuted' are resolved
// through a local colorMap in resolveStatusColor(), not direct ThemeColors keys.
/** Status badge color keys (map to theme.colors.* via resolveStatusColor()) */
export const STATUS_COLORS: Record<SessionState, string> = {
	idle: 'success',
	waiting_input: 'warning',
	busy: 'info',
	connecting: 'textMuted',
	error: 'error',
};

/** View mode inside the AgentInbox modal */
export type InboxViewMode = 'list' | 'focus';

const VALID_FILTER_MODES: readonly InboxFilterMode[] = ['all', 'unread', 'read', 'starred'];
const VALID_SORT_MODES: readonly InboxSortMode[] = ['newest', 'oldest', 'grouped', 'byAgent'];

export function isValidFilterMode(value: unknown): value is InboxFilterMode {
	return typeof value === 'string' && (VALID_FILTER_MODES as readonly string[]).includes(value);
}

export function isValidSortMode(value: unknown): value is InboxSortMode {
	return typeof value === 'string' && (VALID_SORT_MODES as readonly string[]).includes(value);
}
