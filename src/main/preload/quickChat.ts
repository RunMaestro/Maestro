/**
 * Preload API for Quick Chat (`window.maestro.quickChat`).
 *
 * Two audiences share it. The Quick Chat window sends commands and renders
 * snapshots; the app renderer that owns the conversation (the engine, see
 * useQuickChatEngine) answers commands and reports snapshots. The main-process
 * side is src/main/quick-chat/quick-chat-controller.ts.
 */

import { ipcRenderer } from 'electron';
import type {
	QuickChatCommand,
	QuickChatCommandResult,
	QuickChatLayout,
	QuickChatSnapshot,
	QuickChatStatus,
	QuickChatWindowAction,
} from '../../shared/quickChat';

export function createQuickChatApi() {
	return {
		// --- Quick Chat window side ---

		/** Ask the engine to act; resolves with its answer and the new state. */
		command: (command: QuickChatCommand): Promise<QuickChatCommandResult> =>
			ipcRenderer.invoke('quickChat:command', command),

		/** Show, hide, or toggle the Quick Chat window. */
		window: (action: QuickChatWindowAction): Promise<QuickChatStatus> =>
			ipcRenderer.invoke('quickChat:window', action),

		/** The last state the engine reported. */
		getSnapshot: (): Promise<QuickChatSnapshot> => ipcRenderer.invoke('quickChat:getSnapshot'),

		/** Grow the window to show the conversation, or shrink it to the composer. */
		setLayout: (layout: QuickChatLayout): void => ipcRenderer.send('quickChat:setLayout', layout),

		onSnapshot: (callback: (snapshot: QuickChatSnapshot) => void): (() => void) => {
			const handler = (_event: Electron.IpcRendererEvent, snapshot: QuickChatSnapshot) =>
				callback(snapshot);
			ipcRenderer.on('quickChat:snapshot', handler);
			return () => ipcRenderer.removeListener('quickChat:snapshot', handler);
		},

		/** Fired each time the window is shown, so the composer can take focus. */
		onFocusInput: (callback: () => void): (() => void) => {
			const handler = () => callback();
			ipcRenderer.on('quickChat:focusInput', handler);
			return () => ipcRenderer.removeListener('quickChat:focusInput', handler);
		},

		// --- Engine (app renderer) side ---

		/**
		 * Receive commands. The callback's result is sent back on the request's
		 * reply channel, which is how the controller learns the outcome.
		 */
		onCommand: (
			callback: (command: QuickChatCommand) => Promise<QuickChatCommandResult>
		): (() => void) => {
			const handler = (
				_event: Electron.IpcRendererEvent,
				command: QuickChatCommand,
				responseChannel: string
			) => {
				void callback(command).then((result) => ipcRenderer.send(responseChannel, result));
			};
			ipcRenderer.on('quickChat:command', handler);
			return () => ipcRenderer.removeListener('quickChat:command', handler);
		},

		/** Report the conversation's current state. */
		pushSnapshot: (snapshot: QuickChatSnapshot): void =>
			ipcRenderer.send('quickChat:snapshot', snapshot),

		/** The OS or another app refused the Quick Chat hotkey. */
		onHotkeyFailed: (callback: (keys: string[]) => void): (() => void) => {
			const handler = (_event: Electron.IpcRendererEvent, keys: string[]) => callback(keys);
			ipcRenderer.on('quickChat:hotkeyFailed', handler);
			return () => ipcRenderer.removeListener('quickChat:hotkeyFailed', handler);
		},
	};
}

export type QuickChatApi = ReturnType<typeof createQuickChatApi>;
