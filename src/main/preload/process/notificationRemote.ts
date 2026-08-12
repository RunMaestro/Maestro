import { ipcRenderer } from 'electron';

export function createNotificationRemoteApi() {
	return {
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
				clickAction?:
					| { kind: 'jump-session'; sessionId: string; tabId?: string }
					| { kind: 'open-file'; sessionId: string; path: string }
					| { kind: 'open-url'; url: string };
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
