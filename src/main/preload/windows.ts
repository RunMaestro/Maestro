/**
 * Preload API for multi-window operations
 *
 * Provides the window.maestro.windows namespace for:
 * - Creating and closing secondary windows
 * - Listing and focusing windows
 * - Looking up and moving sessions between windows
 * - Reading the current window state
 */

import { ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import type {
	WindowBounds,
	WindowInfo,
	WindowSessionMovedEvent,
	WindowState,
	WindowStateUpdate,
} from '../../shared/types/window';

export interface WindowCreateBounds {
	x?: number;
	y?: number;
	width?: number;
	height?: number;
}

export interface WindowCloseResult {
	closed: boolean;
	reason?: 'primary-window' | 'not-found';
}

/**
 * Creates the windows API object for preload exposure
 */
export function createWindowsApi() {
	return {
		create: (sessionIds: string[] = [], bounds: WindowCreateBounds = {}): Promise<WindowInfo> =>
			ipcRenderer.invoke('windows:create', sessionIds, bounds),
		close: (windowId: string): Promise<WindowCloseResult> =>
			ipcRenderer.invoke('windows:close', windowId),
		list: (): Promise<WindowInfo[]> => ipcRenderer.invoke('windows:list'),
		getForSession: (sessionId: string): Promise<string | null> =>
			ipcRenderer.invoke('windows:getForSession', sessionId),
		moveSession: (sessionId: string, fromWindowId: string, toWindowId: string): Promise<boolean> =>
			ipcRenderer.invoke('windows:moveSession', sessionId, fromWindowId, toWindowId),
		focusWindow: (windowId: string): Promise<boolean> =>
			ipcRenderer.invoke('windows:focusWindow', windowId),
		getWindowBounds: (): Promise<WindowBounds> => ipcRenderer.invoke('windows:getWindowBounds'),
		getState: (): Promise<WindowState> => ipcRenderer.invoke('windows:getState'),
		updateState: (update: WindowStateUpdate): Promise<WindowState> =>
			ipcRenderer.invoke('windows:updateState', update),
		onSessionMoved: (handler: (event: WindowSessionMovedEvent) => void) => {
			const wrappedHandler = (_event: IpcRendererEvent, payload: WindowSessionMovedEvent) =>
				handler(payload);
			ipcRenderer.on('windows:sessionMoved', wrappedHandler);
			return () => ipcRenderer.removeListener('windows:sessionMoved', wrappedHandler);
		},
	};
}

export type WindowsApi = ReturnType<typeof createWindowsApi>;
