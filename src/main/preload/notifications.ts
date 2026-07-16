/**
 * Preload API for notifications
 *
 * Provides the window.maestro.notification namespace for:
 * - Showing OS notifications
 * - Custom notification commands (e.g., TTS, logging, etc.)
 * - Notification command completion events
 */

import { ipcRenderer } from 'electron';
import { subscribeIpc } from './ipcSubscription';

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
 * Optional Maestro context forwarded to the custom notification command as
 * environment variables. Lets a user's command reference which agent/tab
 * finished (e.g. to include it in a message). Passing metadata via env instead
 * of string interpolation keeps it safe from shell injection, and unset fields
 * simply don't appear in the child's environment.
 */
export interface NotificationCommandVars {
	/** Agent name (the Left Bar entity / session name) -> MAESTRO_NOTIFY_AGENT */
	agent?: string;
	/** AI tab name within the agent -> MAESTRO_NOTIFY_TAB */
	tab?: string;
	/** Group the agent belongs to -> MAESTRO_NOTIFY_GROUP */
	group?: string;
	/** Originating task/prompt title -> MAESTRO_NOTIFY_TASK */
	task?: string;
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
		show: (
			title: string,
			body: string,
			sessionId?: string,
			tabId?: string
		): Promise<NotificationShowResponse> =>
			ipcRenderer.invoke('notification:show', title, body, sessionId, tabId),

		/**
		 * Execute a custom notification command (e.g., TTS, logging)
		 * @param text - Text to pass to the command via stdin
		 * @param command - Command to execute (default: 'say' on macOS)
		 * @param vars - Optional Maestro context exposed to the command as
		 *   MAESTRO_NOTIFY_* environment variables (agent, tab, group, task)
		 */
		speak: (
			text: string,
			command?: string,
			vars?: NotificationCommandVars
		): Promise<NotificationCommandResponse> =>
			// Only append `vars` when provided so the wire call stays 3-arg for
			// existing callers (and their tests) that don't pass context.
			vars === undefined
				? ipcRenderer.invoke('notification:speak', text, command)
				: ipcRenderer.invoke('notification:speak', text, command, vars),

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
		onCommandCompleted: (handler: (notificationId: number) => void): (() => void) =>
			subscribeIpc('notification:commandCompleted', handler),

		/** @deprecated Use onCommandCompleted instead */
		onTtsCompleted: (handler: (notificationId: number) => void): (() => void) =>
			subscribeIpc('notification:commandCompleted', handler),
	};
}

/**
 * TypeScript type for the notification API
 */
export type NotificationApi = ReturnType<typeof createNotificationApi>;
