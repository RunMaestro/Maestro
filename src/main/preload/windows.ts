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

import type {
	WindowDropZoneHighlightEvent,
	WindowInfo,
	WindowSessionMovedEvent,
	WindowSessionsReassignedEvent,
	WindowState,
} from '../../shared/types/window';

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

export interface AssignSessionsOptions {
	sessionIds: string[];
	windowId?: string;
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
		 * Assign one or more sessions to a specific window
		 */
		assignSessions: (options: AssignSessionsOptions): Promise<boolean> =>
			ipcRenderer.invoke('windows:assignSessions', options),

		/**
		 * Focus and show the specified window
		 */
		focusWindow: (windowId: string): Promise<boolean> =>
			ipcRenderer.invoke('windows:focusWindow', windowId),

		/**
		 * Get the current BrowserWindow bounds (screen coordinates)
		 */
		getWindowBounds: (): Promise<Rectangle> =>
			ipcRenderer.invoke('windows:getWindowBounds'),

		/**
		 * Find the window occupying the provided screen coordinates
		 */
		findWindowAtPoint: (screenX: number, screenY: number): Promise<string | null> =>
			ipcRenderer.invoke('windows:findWindowAtPoint', { screenX, screenY }),

		/**
		 * Highlight the drop zone of a target window
		 */
		highlightDropZone: (windowId: string, highlight: boolean): Promise<boolean> =>
			ipcRenderer.invoke('windows:highlightDropZone', { windowId, highlight }),

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
		 * Listen for bulk session reassignment events (e.g., on window close)
		 */
			onSessionsReassigned: (
			callback: (event: WindowSessionsReassignedEvent) => void
			) => {
			const handler = (
				_event: Electron.IpcRendererEvent,
				event: WindowSessionsReassignedEvent
			) => callback(event);
			ipcRenderer.on('windows:sessionsReassigned', handler);
			return () => ipcRenderer.removeListener('windows:sessionsReassigned', handler);
		},

		/**
		 * Listen for drop zone highlight requests coming from other windows
		 */
		onDropZoneHighlight: (
			callback: (event: WindowDropZoneHighlightEvent) => void
		) => {
			const handler = (
				_event: Electron.IpcRendererEvent,
				event: WindowDropZoneHighlightEvent
			) => callback(event);
			ipcRenderer.on('windows:dropZoneHighlight', handler);
			return () => ipcRenderer.removeListener('windows:dropZoneHighlight', handler);
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
