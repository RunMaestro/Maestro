/** Shared entry activation and CLI history operations over the live notification store. */
import { NOTIFICATION_HISTORY_PERSISTENCE_ERROR } from '../../shared/notificationInbox';
import type {
	NotificationInboxRequest,
	NotificationInboxResult,
} from '../../shared/notificationInbox';
import {
	notifyToast,
	selectUnreadNotificationCount,
	useNotificationStore,
	type NotificationRecord,
} from '../stores/notificationStore';
import { jumpToAgent } from './agentNavigation';
import { runToastClick } from './toastClickActions';
import { openUrl } from '../utils/openUrl';

/** Report a stale source even when the user has disabled floating toasts. */
function jumpToNotificationSource(sessionId: string, tabId?: string): void {
	if (jumpToAgent(sessionId, { tabId })) return;
	notifyToast({
		color: 'yellow',
		title: 'Agent Not Found',
		message: 'The agent this notification came from no longer exists.',
		skipHistory: useNotificationStore.getState().config.defaultDuration !== -1,
	});
}

/** Mark the entry read and run the same body action as its floating toast. */
export function activateNotification(record: NotificationRecord): void {
	const store = useNotificationStore.getState();
	store.markNotificationRead(record.id);
	if (runToastClick(record, { onSessionClick: jumpToNotificationSource }))
		store.setNotificationCenterOpen(false);
}

/** Inline links are independent of the notification's body action. */
export function openNotificationLink(record: NotificationRecord): void {
	if (!record.actionUrl) return;
	useNotificationStore.getState().markNotificationRead(record.id);
	openUrl(record.actionUrl);
}

/** Execute against the UI's store and return the resulting state, rather than delivery acknowledgement. */
export function performNotificationInboxAction(
	request: NotificationInboxRequest
): NotificationInboxResult {
	const store = useNotificationStore.getState();
	const record = request.id ? store.history.find((n) => n.id === request.id) : undefined;
	if (['read', 'activate', 'link'].includes(request.action) && !record)
		return { success: false, error: 'Notification not found' };
	switch (request.action) {
		case 'open':
			store.setNotificationCenterOpen(true);
			break;
		case 'close':
			store.setNotificationCenterOpen(false);
			break;
		case 'read':
			store.markNotificationRead(record!.id);
			break;
		case 'read-all':
			store.markAllNotificationsRead();
			break;
		case 'clear':
			store.clearNotificationHistory();
			break;
		case 'dismiss':
			store.clearToasts();
			break;
		case 'activate':
			activateNotification(record!);
			break;
		case 'link':
			if (!record!.actionUrl) return { success: false, error: 'Notification has no inline link' };
			openNotificationLink(record!);
			break;
		case 'list':
			break;
		default:
			return { success: false, error: 'Unknown notification action' };
	}
	const current = useNotificationStore.getState();
	const persistenceFailed =
		current.historyPersistenceFailed &&
		['read', 'read-all', 'clear', 'dismiss'].includes(request.action);
	return {
		success: !persistenceFailed,
		error: persistenceFailed ? NOTIFICATION_HISTORY_PERSISTENCE_ERROR : undefined,
		historyPersistenceFailed: current.historyPersistenceFailed,
		open: current.notificationCenterOpen,
		unreadCount: selectUnreadNotificationCount(current),
		notifications: current.history
			.filter((n) => !request.unread || !n.read)
			.map(
				({
					id,
					title,
					message,
					timestamp,
					read,
					project,
					group,
					tabName,
					actionUrl,
					actionLabel,
				}) => ({
					id,
					title,
					message,
					timestamp,
					read,
					project,
					group,
					tabName,
					actionUrl,
					actionLabel,
				})
			),
	};
}
