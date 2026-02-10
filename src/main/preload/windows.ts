/**
 * Preload API for multi-window support
 *
 * Provides the window.maestro.windows namespace for:
 * - Spawning primary/secondary BrowserWindows
 * - Moving sessions between windows
 * - Querying window metadata and persisted bounds state
 */

import { ipcRenderer } from 'electron';
import type { Rectangle } from 'electron';

import type { WindowInfo, WindowSessionMovedEvent, WindowState } from '../../shared/types/window';

type WindowBounds = Partial<Pick<Rectangle, 'x' | 'y' | 'width' | 'height'>>;
type WindowStateUpdate = Partial<Pick<WindowState, 'leftPanelCollapsed' | 'rightPanelCollapsed'>>;

/**
 * Options for creating a new window via IPC
 */
export interface CreateWindowOptions {
	sessionIds?: string[];
	bounds?: WindowBounds;
}

/**
 * Parameters for moving a session between windows
 */
export interface MoveSessionOptions {
	sessionId: string;
	toWindowId: string;
	fromWindowId?: string;
}

/**
 * Creates the windows API object for preload exposure
 */
export function createWindowsApi() {
	return {
		/**
		 * Create a new BrowserWindow optionally scoped to provided sessions
		 */
		create: (options?: CreateWindowOptions): Promise<{ windowId: string }> =>
			ipcRenderer.invoke('windows:create', options),

		/**
		 * Close an existing window (primary window protected in main process)
		 */
		close: (windowId: string): Promise<boolean> =>
			ipcRenderer.invoke('windows:close', windowId),

		/**
		 * List high-level metadata for all windows
		 */
		list: (): Promise<WindowInfo[]> => ipcRenderer.invoke('windows:list'),

		/**
		 * Get the window ID for a session if assigned
		 */
		getForSession: (sessionId: string): Promise<string | null> =>
			ipcRenderer.invoke('windows:getForSession', sessionId),

		/**
		 * Move a session between windows
		 */
		moveSession: (options: MoveSessionOptions): Promise<boolean> =>
			ipcRenderer.invoke('windows:moveSession', options),

		/**
		 * Focus and show the specified window
		 */
		focusWindow: (windowId: string): Promise<boolean> =>
			ipcRenderer.invoke('windows:focusWindow', windowId),

		/**
		 * Get persisted state for the current BrowserWindow
		 */
		getState: (): Promise<WindowState | null> => ipcRenderer.invoke('windows:getState'),

		/**
		 * Listen for session move events across windows
		 */
		onSessionMoved: (callback: (event: WindowSessionMovedEvent) => void) => {
			const handler = (_event: Electron.IpcRendererEvent, event: WindowSessionMovedEvent) =>
				callback(event);
			ipcRenderer.on('windows:sessionMoved', handler);
			return () => ipcRenderer.removeListener('windows:sessionMoved', handler);
		},

		/**
		 * Persist partial window state updates (e.g., panel collapse state)
		 */
		updateState: (updates: WindowStateUpdate): Promise<boolean> =>
			ipcRenderer.invoke('windows:updateState', updates),
	};
}

/**
 * TypeScript type for the windows API
 */
export type WindowsApi = ReturnType<typeof createWindowsApi>;
