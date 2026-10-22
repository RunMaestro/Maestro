import { parseToastClickAction, type ToastClickAction } from './toastClickAction';

/**
 * Five canonical Toast colors - same design language as Center Flash.
 * `theme` adapts to the active Maestro theme.
 *
 *   green  - succeeded
 *   yellow - heads-up / soft warning
 *   orange - more emphatic warning
 *   red    - failed / blocked
 *   theme  - default; matches the active theme's accent color (no semantic)
 */
export type ToastColor = 'green' | 'yellow' | 'orange' | 'red' | 'theme';

/**
 * @deprecated Legacy semantic alias. Prefer `ToastColor` via `color`.
 *   success → green, info → theme, warning → yellow, error → red
 */
export type ToastType = 'success' | 'info' | 'warning' | 'error';

export interface ToastData {
	id: string;
	/** Resolved color used for icon, accent, and progress bar. */
	color: ToastColor;
	/**
	 * @deprecated kept on the rendered Toast for back-compat with consumers
	 * (e.g. ToastContainer renders both fields). New code should read `color`.
	 */
	type: ToastType;
	title: string;
	message: string;
	group?: string; // Maestro group name
	project?: string; // Maestro session name (the agent name in Left Bar)
	/**
	 * Auto-dismiss in ms. 0 = no auto-dismiss (sticky). Ignored when
	 * `dismissible: true`, which forces no auto-dismiss.
	 */
	duration?: number;
	/**
	 * Sticky toast - no auto-dismiss timer, requires the user to click the
	 * close button (or the toast itself, if it has session navigation) to
	 * dismiss. Use for critical messages the user must see.
	 */
	dismissible?: boolean;
	taskDuration?: number; // How long the task took in ms
	agentSessionId?: string; // Claude Code session UUID for traceability
	tabName?: string; // Tab name or short UUID for display
	timestamp: number;
	// Session navigation - allows clicking toast to jump to session
	sessionId?: string; // Maestro session ID for navigation
	tabId?: string; // Tab ID within the session for navigation
	// Action link - clickable URL shown below message (e.g., PR URL)
	actionUrl?: string; // URL to open when clicked
	actionLabel?: string; // Label for the action link (defaults to URL)
	// Skip custom notification command for this toast (used for synopsis messages)
	skipCustomNotification?: boolean;
	// Skip the OS/device notification for this toast. Two callers want it: the
	// toast that is itself the fallback for a failed web-desktop notification
	// (so it does not re-enter showOsNotification() and loop), and in-app-only
	// feedback such as the Settings preview of the toast width, which would be
	// noise in Notification Center.
	skipOsNotification?: boolean;
	// Keep this toast out of the notification center's history. Use for UI
	// previews that report nothing the user could want to come back to.
	skipHistory?: boolean;
	/** Record in the inbox without a popup, OS notification, custom command, or timer. */
	historyOnly?: boolean;
	// Data-driven click intent - preferred for externally-fired toasts since it
	// crosses the IPC boundary. If both `onClick` and `clickAction` are set,
	// `onClick` wins (it can do anything; `clickAction` is the limited subset
	// that survives serialization).
	clickAction?: ToastClickAction;
}

/** Serializable durable notification data, shared by main and every renderer. */
export interface NotificationHistoryRecord extends ToastData {
	read: boolean;
}
export const NOTIFICATION_HISTORY_LIMIT = 200;
export const NOTIFICATION_HISTORY_STORAGE_KEY = 'maestro.notificationHistory';
export type NotificationHistoryChange =
	| { action: 'append'; record: NotificationHistoryRecord }
	| { action: 'migrate'; records: NotificationHistoryRecord[] }
	| { action: 'read'; ids?: string[] }
	| { action: 'clear' };
export interface NotificationHistorySnapshot {
	success: boolean;
	records?: NotificationHistoryRecord[];
	revision?: number;
	error?: string;
}

/** Validate durable records and normalize actions before replaying them. */
function isNotificationRecord(value: unknown): value is NotificationHistoryRecord {
	if (!value || typeof value !== 'object') return false;
	const v = value as Record<string, unknown>;
	return (
		typeof v.id === 'string' &&
		typeof v.title === 'string' &&
		typeof v.message === 'string' &&
		typeof v.timestamp === 'number' &&
		Number.isFinite(v.timestamp) &&
		['green', 'yellow', 'orange', 'red', 'theme'].includes(v.color as string) &&
		['success', 'info', 'warning', 'error'].includes(v.type as string) &&
		['sessionId', 'tabId', 'actionUrl', 'actionLabel', 'group', 'project', 'tabName'].every(
			(key) => v[key] === undefined || typeof v[key] === 'string'
		) &&
		v.onClick === undefined &&
		!parseToastClickAction(v.clickAction).error &&
		typeof v.read === 'boolean'
	);
}

/** Read only valid, bounded records, newest first. */
export function parseNotificationHistory(value: unknown): NotificationHistoryRecord[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter(isNotificationRecord)
		.slice(0, NOTIFICATION_HISTORY_LIMIT)
		.map((record) => ({
			...record,
			clickAction: parseToastClickAction(record.clickAction).action,
		}));
}

/** Apply one mutation to the authoritative state, never a client's stale full array. */
export function applyNotificationHistoryChange(
	records: NotificationHistoryRecord[],
	change: NotificationHistoryChange
): NotificationHistoryRecord[] {
	switch (change.action) {
		case 'clear':
			return [];
		case 'read': {
			const ids = change.ids ? new Set(change.ids) : null;
			return records.map((record) =>
				!record.read && (!ids || ids.has(record.id)) ? { ...record, read: true } : record
			);
		}
		case 'append':
			return [
				{ ...change.record, read: false },
				...records.filter((n) => n.id !== change.record.id),
			].slice(0, NOTIFICATION_HISTORY_LIMIT);
		case 'migrate': {
			const existing = new Set(records.map((n) => n.id));
			return [...records, ...change.records.filter((n) => !existing.has(n.id))]
				.sort((a, b) => b.timestamp - a.timestamp)
				.slice(0, NOTIFICATION_HISTORY_LIMIT);
		}
	}
}

/** Validate mutations at the IPC boundary before touching durable state. */
export function isNotificationHistoryChange(value: unknown): value is NotificationHistoryChange {
	if (!value || typeof value !== 'object') return false;
	const v = value as Record<string, unknown>;
	switch (v.action) {
		case 'clear':
			return true;
		case 'read':
			return (
				v.ids === undefined ||
				(Array.isArray(v.ids) &&
					v.ids.length <= NOTIFICATION_HISTORY_LIMIT &&
					v.ids.every((id) => typeof id === 'string'))
			);
		case 'append':
			return isNotificationRecord(v.record);
		case 'migrate':
			return (
				Array.isArray(v.records) &&
				v.records.length <= NOTIFICATION_HISTORY_LIMIT &&
				v.records.every(isNotificationRecord)
			);
		default:
			return false;
	}
}
