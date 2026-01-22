/**
 * Preload API for notifications
 *
 * Provides the window.maestro.notification namespace for:
 * - Showing OS notifications
 * - Text-to-speech (TTS) functionality
 * - TTS completion events
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
 * Response from TTS operations
 */
export interface TtsResponse {
	success: boolean;
	ttsId?: number;
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
		 */
		show: (title: string, body: string): Promise<NotificationShowResponse> =>
			ipcRenderer.invoke('notification:show', title, body),

		/**
		 * Speak text using system TTS
		 * @param text - Text to speak
		 * @param command - Optional TTS command (default: 'say' on macOS)
		 */
		speak: (text: string, command?: string): Promise<TtsResponse> =>
			ipcRenderer.invoke('notification:speak', text, command),

		/**
		 * Stop a running TTS process
		 * @param ttsId - ID of the TTS process to stop
		 */
		stopSpeak: (ttsId: number): Promise<TtsResponse> =>
			ipcRenderer.invoke('notification:stopSpeak', ttsId),

		/**
		 * Subscribe to TTS completion events
		 * @param handler - Callback when a TTS process completes
		 * @returns Cleanup function to unsubscribe
		 */
		onTtsCompleted: (handler: (ttsId: number) => void): (() => void) => {
			const wrappedHandler = (_event: Electron.IpcRendererEvent, ttsId: number) => handler(ttsId);
			ipcRenderer.on('tts:completed', wrappedHandler);
			return () => ipcRenderer.removeListener('tts:completed', wrappedHandler);
		},
	};
}

/**
 * TypeScript type for the notification API
 */
export type NotificationApi = ReturnType<typeof createNotificationApi>;
