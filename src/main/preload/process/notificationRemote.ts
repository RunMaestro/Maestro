import type {
	NotificationInboxRequest,
	NotificationInboxResult,
} from '../../../shared/notificationInbox';
import { ipcRenderer } from 'electron';
import type { ToastClickAction } from '../../../shared/toastClickAction';

export function createNotificationRemoteApi() {
	return {
		/** Subscribe to inbox operations and acknowledge the resulting live-store snapshot. */
		onRemoteNotificationInbox: (
			callback: (
				request: NotificationInboxRequest
			) => NotificationInboxResult | Promise<NotificationInboxResult>
		): (() => void) => {
			const handler = async (
				_: unknown,
				request: NotificationInboxRequest,
				responseChannel: string
			) => {
				try {
					ipcRenderer.send(responseChannel, await callback(request));
				} catch (error) {
					ipcRenderer.send(responseChannel, {
						success: false,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			};
			ipcRenderer.on('remote:notificationInbox', handler);
			return () => ipcRenderer.removeListener('remote:notificationInbox', handler);
		},

		/**
		 * Subscribe to remote toast notifications from CLI/web interface.
		 * Color is one of the 5 canonical Toast/Center Flash colors.
		 * `dismissible: true` makes the toast sticky (no auto-dismiss, click-to-close).
		 */
		onRemoteNotifyToast: (
			callback: (params: {
				title: string;
				message: string;
				color: 'green' | 'yellow' | 'orange' | 'red' | 'theme';
				duration?: number;
				dismissible?: boolean;
				sessionId?: string;
				tabId?: string;
				actionUrl?: string;
				actionLabel?: string;
				clickAction?: ToastClickAction;
			}) => void
		): (() => void) => {
			const handler = (_: unknown, params: Parameters<typeof callback>[0]) => callback(params);
			ipcRenderer.on('remote:notifyToast', handler);
			return () => ipcRenderer.removeListener('remote:notifyToast', handler);
		},

		/**
		 * Subscribe to remote center-flash notifications from CLI/web interface.
		 * Color is one of the 5 canonical Center Flash colors.
		 */
		onRemoteNotifyCenterFlash: (
			callback: (params: {
				message: string;
				detail?: string;
				color: 'green' | 'yellow' | 'orange' | 'red' | 'theme';
				duration?: number;
			}) => void
		): (() => void) => {
			const handler = (_: unknown, params: Parameters<typeof callback>[0]) => callback(params);
			ipcRenderer.on('remote:notifyCenterFlash', handler);
			return () => ipcRenderer.removeListener('remote:notifyCenterFlash', handler);
		},
	};
}
