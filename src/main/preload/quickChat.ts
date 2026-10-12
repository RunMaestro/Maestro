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
	QuickChatFontScaleRequest,
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

		/** Grow the window to fill its display while a diagram is open full screen, or put it back. */
		setFullView: (on: boolean): void => ipcRenderer.send('quickChat:setFullView', on),

		/** Whether the window floats above other windows. */
		getPinned: (): Promise<boolean> => ipcRenderer.invoke('quickChat:getPinned'),

		/** Float the window above other windows, or let it fall behind them. Resolves with the new state. */
		setPinned: (pinned: boolean): Promise<boolean> =>
			ipcRenderer.invoke('quickChat:setPinned', pinned),

		/** The conversation's text zoom (1 = normal). */
		getFontScale: (): Promise<number> => ipcRenderer.invoke('quickChat:getFontScale'),

		/** Step, set, or reset the conversation's text zoom. Resolves with the new zoom. */
		setFontScale: (request: QuickChatFontScaleRequest): Promise<number> =>
			ipcRenderer.invoke('quickChat:setFontScale', request),

		/** Fired when the text zoom changes, including from `maestro-cli quick-chat font`. */
		onFontScale: (callback: (fontScale: number) => void): (() => void) => {
			const handler = (_event: Electron.IpcRendererEvent, fontScale: number) => callback(fontScale);
			ipcRenderer.on('quickChat:fontScale', handler);
			return () => ipcRenderer.removeListener('quickChat:fontScale', handler);
		},

		/** Fired when the pin changes from outside the window (`maestro-cli quick-chat pin`). */
		onPinned: (callback: (pinned: boolean) => void): (() => void) => {
			const handler = (_event: Electron.IpcRendererEvent, pinned: boolean) => callback(pinned);
			ipcRenderer.on('quickChat:pinned', handler);
			return () => ipcRenderer.removeListener('quickChat:pinned', handler);
		},

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
