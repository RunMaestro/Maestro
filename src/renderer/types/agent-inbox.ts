import type { SessionState } from './index'

export interface InboxItem {
	sessionId: string
	tabId: string
	groupId?: string
	groupName?: string
	sessionName: string
	tabName?: string
	toolType: string
	gitBranch?: string
	contextUsage?: number        // 0-100, undefined = unknown
	lastMessage: string          // truncated to 90 chars
	timestamp: number            // Unix ms, must be validated > 0
	state: SessionState
	hasUnread: boolean
}

/** UI labels: "Newest", "Oldest", "Grouped" */
export type InboxSortMode = 'newest' | 'oldest' | 'grouped'

/** UI labels: "All", "Unread", "Read" */
export type InboxFilterMode = 'all' | 'unread' | 'read'

/** Human-readable status badges */
export const STATUS_LABELS: Record<SessionState, string> = {
	idle: 'Ready',
	waiting_input: 'Needs Input',
	busy: 'Processing',
	connecting: 'Connecting',
	error: 'Error',
}

/** Status badge color keys (map to theme.colors.*) */
export const STATUS_COLORS: Record<SessionState, string> = {
	idle: 'success',
	waiting_input: 'warning',
	busy: 'info',
	connecting: 'textMuted',
	error: 'error',
}
