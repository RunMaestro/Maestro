/**
 * Preload API for multi-window operations
 *
 * Provides the window.maestro.windows namespace for:
 * - Creating new windows
 * - Closing windows
 * - Listing windows
 * - Moving sessions between windows
 * - Focusing windows
 * - Getting window state
 *
 * Implements GitHub issue #133 - multi-window support.
 */

import { ipcRenderer } from 'electron';
import type {
	WindowState,
	WindowInfo,
	CreateWindowRequest,
	CreateWindowResponse,
	MoveSessionRequest,
} from '../../shared/types/window';

/**
 * Session change event data sent when sessions are moved between windows.
 */
export interface SessionsChangedEvent {
	/** The window ID that had sessions change */
	windowId: string;
	/** The updated list of session IDs in this window */
	sessionIds: string[];
	/** The active session ID in this window */
	activeSessionId?: string;
}

/**
 * Session moved event data broadcast to ALL windows when a session moves.
 * This allows any window to update its UI (e.g., SessionList showing window badges).
 */
export interface SessionMovedEvent {
	/** The session ID that was moved */
	sessionId: string;
	/** The window ID the session moved from (empty if not specified) */
	fromWindowId: string;
	/** The window ID the session moved to */
	toWindowId: string;
}

/**
 * Drop zone highlight event data sent to a window during tab drag-out.
 * Used to highlight the target window's tab bar.
 */
export interface DropZoneHighlightEvent {
	/** Whether to highlight the drop zone */
	highlight: boolean;
}

/**
 * Creates the windows API object for preload exposure.
 * Exposes window.maestro.windows.* methods.
 */
export function createWindowsApi() {
	return {
		/**
		 * Create a new window with optional sessions and bounds.
		 *
		 * @param request - Optional configuration for the new window
		 * @returns Promise resolving to the new window's ID
		 */
		create: (request?: CreateWindowRequest): Promise<CreateWindowResponse> =>
			ipcRenderer.invoke('windows:create', request),

		/**
		 * Close a window by ID.
		 * Note: The primary window cannot be closed.
		 *
		 * @param windowId - The ID of the window to close
		 * @returns Promise resolving to success status
		 */
		close: (windowId: string): Promise<{ success: boolean; error?: string }> =>
			ipcRenderer.invoke('windows:close', windowId),

		/**
		 * List all open windows with their information.
		 *
		 * @returns Promise resolving to array of WindowInfo objects
		 */
		list: (): Promise<WindowInfo[]> => ipcRenderer.invoke('windows:list'),

		/**
		 * Get the window ID containing a specific session.
		 *
		 * @param sessionId - The session ID to find
		 * @returns Promise resolving to the window ID or null if not found
		 */
		getForSession: (sessionId: string): Promise<string | null> =>
			ipcRenderer.invoke('windows:getForSession', sessionId),

		/**
		 * Move a session from one window to another.
		 *
		 * @param request - The move request with sessionId, fromWindowId, and toWindowId
		 * @returns Promise resolving to success status
		 */
		moveSession: (request: MoveSessionRequest): Promise<{ success: boolean; error?: string }> =>
			ipcRenderer.invoke('windows:moveSession', request),

		/**
		 * Bring a window to the front and focus it.
		 * Also restores the window if it's minimized.
		 *
		 * @param windowId - The ID of the window to focus
		 * @returns Promise resolving to success status
		 */
		focusWindow: (windowId: string): Promise<{ success: boolean; error?: string }> =>
			ipcRenderer.invoke('windows:focusWindow', windowId),

		/**
		 * Get the current state of the calling window.
		 *
		 * @returns Promise resolving to WindowState or null if window not found
		 */
		getState: (): Promise<WindowState | null> => ipcRenderer.invoke('windows:getState'),

		/**
		 * Get the window ID of the calling window.
		 *
		 * @returns Promise resolving to the window ID or null if not found
		 */
		getWindowId: (): Promise<string | null> => ipcRenderer.invoke('windows:getWindowId'),

		/**
		 * Set the sessions for a specific window.
		 * Used by renderer to sync state with the main process.
		 *
		 * @param windowId - The window ID
		 * @param sessionIds - Array of session IDs to set
		 * @param activeSessionId - Optional active session ID
		 * @returns Promise resolving to success status
		 */
		setSessionsForWindow: (
			windowId: string,
			sessionIds: string[],
			activeSessionId?: string
		): Promise<{ success: boolean; error?: string }> =>
			ipcRenderer.invoke('windows:setSessionsForWindow', windowId, sessionIds, activeSessionId),

		/**
		 * Set the active session for a specific window.
		 *
		 * @param windowId - The window ID
		 * @param sessionId - The session ID to make active
		 * @returns Promise resolving to success status
		 */
		setActiveSession: (
			windowId: string,
			sessionId: string
		): Promise<{ success: boolean; error?: string }> =>
			ipcRenderer.invoke('windows:setActiveSession', windowId, sessionId),

		/**
		 * Listen for session change events.
		 * Fired when sessions are moved to/from this window.
		 *
		 * @param callback - Function to call when sessions change
		 * @returns Cleanup function to remove the listener
		 */
		onSessionsChanged: (callback: (event: SessionsChangedEvent) => void): (() => void) => {
			const handler = (_: unknown, event: SessionsChangedEvent) => callback(event);
			ipcRenderer.on('windows:sessionsChanged', handler);
			return () => ipcRenderer.removeListener('windows:sessionsChanged', handler);
		},

		/**
		 * Listen for session moved events.
		 * Fired to ALL windows when a session moves between windows.
		 * This allows windows to update their UI (e.g., session list badges).
		 *
		 * @param callback - Function to call when a session is moved
		 * @returns Cleanup function to remove the listener
		 */
		onSessionMoved: (callback: (event: SessionMovedEvent) => void): (() => void) => {
			const handler = (_: unknown, event: SessionMovedEvent) => callback(event);
			ipcRenderer.on('windows:sessionMoved', handler);
			return () => ipcRenderer.removeListener('windows:sessionMoved', handler);
		},

		/**
		 * Get the panel collapse state for the calling window.
		 * Used to persist and restore window-specific UI state.
		 *
		 * @returns Promise resolving to panel state or null if window not found
		 */
		getPanelState: (): Promise<{
			leftPanelCollapsed: boolean;
			rightPanelCollapsed: boolean;
		} | null> => ipcRenderer.invoke('windows:getPanelState'),

		/**
		 * Set the panel collapse state for the calling window.
		 * Persists the state to the multi-window store.
		 *
		 * @param panelState - Object with optional leftPanelCollapsed and rightPanelCollapsed values
		 * @returns Promise resolving to success status
		 */
		setPanelState: (panelState: {
			leftPanelCollapsed?: boolean;
			rightPanelCollapsed?: boolean;
		}): Promise<{ success: boolean; error?: string }> =>
			ipcRenderer.invoke('windows:setPanelState', panelState),

		/**
		 * Get the screen bounds of the calling window.
		 * Used for detecting when a drag operation exits the window bounds.
		 *
		 * @returns Promise resolving to window bounds in screen coordinates or null if window not found
		 */
		getWindowBounds: (): Promise<{ x: number; y: number; width: number; height: number } | null> =>
			ipcRenderer.invoke('windows:getWindowBounds'),

		/**
		 * Find a Maestro window at the given screen coordinates.
		 * Used during tab drag-drop to detect if the drop location is over another Maestro window.
		 * Excludes the calling window from the search results.
		 *
		 * @param screenX - The X coordinate in screen space
		 * @param screenY - The Y coordinate in screen space
		 * @returns Promise resolving to the window info at that point, or null if no window found
		 */
		findWindowAtPoint: (
			screenX: number,
			screenY: number
		): Promise<{ windowId: string; isMain: boolean } | null> =>
			ipcRenderer.invoke('windows:findWindowAtPoint', screenX, screenY),

		/**
		 * Send drop zone highlight signal to a specific window.
		 * Used during tab drag-out to highlight the target window's tab bar.
		 *
		 * @param windowId - The ID of the window to highlight
		 * @param highlight - Whether to highlight (true) or unhighlight (false) the drop zone
		 * @returns Promise resolving to success status
		 */
		highlightDropZone: (windowId: string, highlight: boolean): Promise<{ success: boolean }> =>
			ipcRenderer.invoke('windows:highlightDropZone', windowId, highlight),

		/**
		 * Listen for drop zone highlight events.
		 * Fired when another window is dragging a tab over this window.
		 *
		 * @param callback - Function to call when drop zone highlight changes
		 * @returns Cleanup function to remove the listener
		 */
		onDropZoneHighlight: (callback: (event: DropZoneHighlightEvent) => void): (() => void) => {
			const handler = (_: unknown, event: DropZoneHighlightEvent) => callback(event);
			ipcRenderer.on('windows:dropZoneHighlight', handler);
			return () => ipcRenderer.removeListener('windows:dropZoneHighlight', handler);
		},
	};
}

export type WindowsApi = ReturnType<typeof createWindowsApi>;
