/** Shared warning for failed history writes, including a clear that could not be saved. */
export const NOTIFICATION_HISTORY_PERSISTENCE_ERROR =
	'Notification history could not be saved. Changes may be lost after restart.';

/** Operations on the desktop client's notification history, shared across the CLI bridge. */
export const NOTIFICATION_INBOX_ACTIONS = [
	'list',
	'open',
	'close',
	'read',
	'read-all',
	'clear',
	'dismiss',
	'activate',
	'link',
	'detail',
	'collapse',
] as const;
export type NotificationInboxAction = (typeof NOTIFICATION_INBOX_ACTIONS)[number];
export interface NotificationInboxRequest {
	action: NotificationInboxAction;
	id?: string;
	unread?: boolean;
}
/** Serializable snapshot, without renderer callbacks or transient toast settings. */
export interface NotificationInboxEntry {
	id: string;
	title: string;
	message: string;
	timestamp: number;
	read: boolean;
	project?: string;
	group?: string;
	tabName?: string;
	actionUrl?: string;
	actionLabel?: string;
}
export interface NotificationInboxResult {
	success: boolean;
	error?: string;
	open?: boolean;
	expandedId?: string | null;
	unreadCount?: number;
	historyPersistenceFailed?: boolean;
	notifications?: NotificationInboxEntry[];
}
