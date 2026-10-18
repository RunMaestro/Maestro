/** Shared entry activation and CLI history operations over the live notification store. */
import {
	NOTIFICATION_CENTER_DISABLED_ERROR,
	NOTIFICATION_HISTORY_PERSISTENCE_ERROR,
} from '../../shared/notificationInbox';
import type {
	NotificationInboxRequest,
	NotificationInboxResult,
} from '../../shared/notificationInbox';
import {
	flushNotificationHistoryWrites,
	notifyToast,
	selectUnreadNotificationCount,
	useNotificationStore,
	type NotificationRecord,
} from '../stores/notificationStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useSessionStore } from '../stores/sessionStore';
import { isWebDesktop } from '../utils/runtimeContext';
import { logger } from '../utils/logger';
import { jumpToAgent } from './agentNavigation';
import { runToastClick } from './toastClickActions';
import { openUrl } from '../utils/openUrl';
import { areToastsEnabled } from '../../shared/toastDuration';

/** Report a stale source even when the user has disabled floating toasts. */
function jumpToNotificationSource(sessionId: string, tabId?: string): boolean {
	if (jumpToAgent(sessionId, { tabId })) return true;
	notifyToast({
		color: 'yellow',
		title: 'Agent Not Found',
		message: 'The agent this notification came from no longer exists.',
		skipHistory: areToastsEnabled(useNotificationStore.getState().config.defaultDuration),
	});
	return false;
}

/**
 * Mark the entry read and run the same body action as its floating toast.
 * @returns Whether activation succeeded; a failed source keeps the inbox open.
 */
export async function activateNotification(record: NotificationRecord): Promise<boolean> {
	const store = useNotificationStore.getState();
	store.markNotificationRead(record.id);
	const action = record.clickAction;
	const sessionId =
		action && 'sessionId' in action ? action.sessionId : !action ? record.sessionId : undefined;
	if (
		!record.onClick &&
		sessionId &&
		!isWebDesktop() &&
		window.maestro.notification.navigateToSource &&
		useSessionStore.getState().sessions.some((s) => s.id === sessionId)
	) {
		try {
			const result = await window.maestro.notification.navigateToSource(
				sessionId,
				action?.kind === 'jump-session' ? action.tabId : record.tabId,
				action
			);
			if (!result.success) throw new Error('Notification source could not be focused');
			store.setNotificationCenterOpen(false);
			return true;
		} catch (error) {
			logger.error('Notification source could not be focused', 'NotificationInbox', error);
			notifyToast({
				color: 'yellow',
				title: 'Notification source unavailable',
				message: 'The originating window or tab could not be opened.',
			});
			return false;
		}
	}

	let sourceAvailable = true;
	const dispatched = runToastClick(record, {
		onSessionClick: (sourceId, tabId) => {
			sourceAvailable = jumpToNotificationSource(sourceId, tabId);
		},
	});
	const activated = dispatched && sourceAvailable;
	if (activated) store.setNotificationCenterOpen(false);
	return activated;
}

/** Inline links are independent of the notification's body action. */
export function openNotificationLink(record: NotificationRecord): void {
	if (!record.actionUrl) return;
	useNotificationStore.getState().markNotificationRead(record.id);
	openUrl(record.actionUrl);
}

/** Execute against the UI's store and return the resulting state, rather than delivery acknowledgement. */
export async function performNotificationInboxAction(
	request: NotificationInboxRequest
): Promise<NotificationInboxResult> {
	// Dismissing every visible toast is a toast operation, not an inbox one, so
	// it still works with the inbox off. Everything else needs the inbox.
	const toastOnly = request.action === 'dismiss' && request.id === undefined;
	if (!toastOnly && !useSettingsStore.getState().notificationCenterEnabled)
		return { success: false, error: NOTIFICATION_CENTER_DISABLED_ERROR };
	const store = useNotificationStore.getState();
	const record = request.id ? store.history.find((n) => n.id === request.id) : undefined;
	if (
		(['read', 'activate', 'link', 'detail'].includes(request.action) ||
			(request.action === 'dismiss' && request.id !== undefined)) &&
		!record
	)
		return { success: false, error: 'Notification not found' };
	let activationSucceeded = true;
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
			if (record) {
				store.markNotificationRead(record.id);
				store.removeToast(record.id);
			} else {
				store.clearToasts();
			}
			break;
		case 'detail':
			if (!useSettingsStore.getState().notificationCenterDetails)
				return {
					success: false,
					error: 'Enable notificationCenterDetails to expand entries in the inbox',
				};
			store.setNotificationCenterExpandedId(record!.id);
			store.setNotificationCenterOpen(true);
			break;
		case 'collapse':
			store.setNotificationCenterExpandedId(null);
			break;
		case 'activate':
			activationSucceeded = await activateNotification(record!);
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
	await flushNotificationHistoryWrites();
	const current = useNotificationStore.getState();
	const persistenceFailed =
		current.historyPersistenceFailed &&
		['read', 'read-all', 'clear', 'dismiss', 'activate', 'link'].includes(request.action);
	return {
		success: !persistenceFailed && activationSucceeded,
		error: persistenceFailed
			? NOTIFICATION_HISTORY_PERSISTENCE_ERROR
			: !activationSucceeded
				? 'Notification activation failed'
				: undefined,
		historyPersistenceFailed: current.historyPersistenceFailed,
		open: current.notificationCenterOpen,
		expandedId: current.notificationCenterExpandedId,
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
