/**
 * Preload API for notifications
 *
 * Provides the window.maestro.notification namespace for:
 * - Showing OS notifications
 * - Custom notification commands (e.g., TTS, logging, etc.)
 * - Notification command completion events
 */

import { ipcRenderer } from 'electron';

/**
 * Response from showing a notification
 */
export interface NotificationShowResponse {
	success: boolean;
	error?: string;
}

/**
 * Response from notification command operations
 */
export interface NotificationCommandResponse {
	success: boolean;
	notificationId?: number;
	error?: string;
}

/**
 * Creates the notification API object for preload exposure
 */
export function createNotificationApi() {
	return {
		/**
		 * Show an OS notification
		 * @param title - Notification title
		 * @param body - Notification body text
		 * @param sessionId - Optional session ID for click-to-navigate
		 * @param tabId - Optional tab ID for click-to-navigate
		 */
		show: (title: string, body: string, sessionId?: string, tabId?: string): Promise<NotificationShowResponse> =>
			ipcRenderer.invoke('notification:show', title, body, sessionId, tabId),

		/**
		 * Execute a custom notification command (e.g., TTS, logging)
		 * @param text - Text to pass to the command via stdin
		 * @param command - Command to execute (default: 'say' on macOS)
		 */
		speak: (text: string, command?: string): Promise<NotificationCommandResponse> =>
			ipcRenderer.invoke('notification:speak', text, command),

		/**
		 * Stop a running notification command process
		 * @param notificationId - ID of the notification process to stop
		 */
		stopSpeak: (notificationId: number): Promise<NotificationCommandResponse> =>
			ipcRenderer.invoke('notification:stopSpeak', notificationId),

		/**
		 * Subscribe to notification command completion events
		 * @param handler - Callback when a notification command completes
		 * @returns Cleanup function to unsubscribe
		 */
		onCommandCompleted: (handler: (notificationId: number) => void): (() => void) => {
			const wrappedHandler = (_event: Electron.IpcRendererEvent, notificationId: number) =>
				handler(notificationId);
			ipcRenderer.on('notification:commandCompleted', wrappedHandler);
			return () => ipcRenderer.removeListener('notification:commandCompleted', wrappedHandler);
		},

		/** @deprecated Use onCommandCompleted instead */
		onTtsCompleted: (handler: (notificationId: number) => void): (() => void) => {
			const wrappedHandler = (_event: Electron.IpcRendererEvent, notificationId: number) =>
				handler(notificationId);
			ipcRenderer.on('notification:commandCompleted', wrappedHandler);
			return () => ipcRenderer.removeListener('notification:commandCompleted', wrappedHandler);
		},
	};
}

/**
 * TypeScript type for the notification API
 */
export type NotificationApi = ReturnType<typeof createNotificationApi>;
