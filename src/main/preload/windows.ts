/**
 * Preload API for the multi-window system.
 *
 * Provides the `window.maestro.windows` namespace, mirroring the `windows:*` IPC
 * handlers in `src/main/ipc/handlers/windows.ts`. Lets the renderer enumerate,
 * create, focus, and close windows, and inspect/move the agents (sessions) each
 * window owns.
 */

import { ipcRenderer } from 'electron';
import type {
	WindowBounds,
	WindowHighlightDropZonePayload,
	WindowInfo,
	WindowPanelState,
	WindowSessionMovedPayload,
	WindowState,
} from '../../shared/window-types';

export type { WindowBounds };

/**
 * Creates the windows API object for preload exposure.
 */
export function createWindowsApi() {
	return {
		/**
		 * Open a new secondary window.
		 * @param sessionIds - Agent IDs the new window should own (default: none)
		 * @param bounds - Optional initial bounds / maximize state
		 * @returns The created window's info, or null if it could not be tracked
		 */
		create: (sessionIds?: string[], bounds?: Partial<WindowState>): Promise<WindowInfo | null> =>
			ipcRenderer.invoke('windows:create', sessionIds, bounds),

		/**
		 * Close a window by ID. The primary window cannot be closed this way.
		 * @param windowId - ID of the window to close
		 */
		close: (windowId: string): Promise<{ closed: boolean; error?: string }> =>
			ipcRenderer.invoke('windows:close', windowId),

		/** List every open window. */
		list: (): Promise<WindowInfo[]> => ipcRenderer.invoke('windows:list'),

		/**
		 * Find which window owns a given agent (session).
		 * @param sessionId - Agent ID to look up
		 * @returns The owning window's ID, or null if no window owns it
		 */
		getForSession: (sessionId: string): Promise<string | null> =>
			ipcRenderer.invoke('windows:getForSession', sessionId),

		/**
		 * Move an agent from one window to another.
		 * @param sessionId - Agent ID to move
		 * @param fromWindowId - Source window ID
		 * @param toWindowId - Destination window ID
		 */
		moveSession: (
			sessionId: string,
			fromWindowId: string,
			toWindowId: string
		): Promise<{ moved: boolean; error?: string }> =>
			ipcRenderer.invoke('windows:moveSession', sessionId, fromWindowId, toWindowId),

		/**
		 * Bring a window to the foreground.
		 * @param windowId - ID of the window to focus
		 */
		focusWindow: (windowId: string): Promise<{ focused: boolean; error?: string }> =>
			ipcRenderer.invoke('windows:focusWindow', windowId),

		/** The calling window's full state (bounds + owned agents + panel collapse). */
		getState: (): Promise<WindowState | null> => ipcRenderer.invoke('windows:getState'),

		/**
		 * Claim a freshly-created agent for the CALLING window so it surfaces here
		 * immediately and is never momentarily shown by the primary window's
		 * catch-all (spawn flicker). Called at agent-creation time, before the
		 * agent's process starts emitting output.
		 * @param sessionId - The newly-created agent's ID
		 */
		registerSession: (sessionId: string): Promise<{ registered: boolean }> =>
			ipcRenderer.invoke('windows:registerSession', sessionId),

		/**
		 * Persist the calling window's panel-collapse UI state. Per-window (keyed to
		 * the calling window in the main process), not a global setting, so each
		 * window remembers its own collapsed side panels. Only the provided fields
		 * change (partial merge).
		 * @param panel - Collapse flags to write (omit a field to leave it unchanged)
		 */
		setPanelState: (panel: Partial<WindowPanelState>): Promise<void> =>
			ipcRenderer.invoke('windows:setPanelState', panel),

		/**
		 * On-screen bounds of a window. Defaults to the calling window.
		 * @param windowId - Optional window ID to query a specific window
		 */
		getBounds: (windowId?: string): Promise<WindowBounds | null> =>
			ipcRenderer.invoke('windows:getBounds', windowId),

		/**
		 * Find the window whose screen bounds contain a point.
		 * @param screenX - Screen X coordinate
		 * @param screenY - Screen Y coordinate
		 * @returns The window's ID, or null if no window contains the point
		 */
		findWindowAtPoint: (screenX: number, screenY: number): Promise<string | null> =>
			ipcRenderer.invoke('windows:findWindowAtPoint', screenX, screenY),

		/**
		 * Subscribe to `windows:sessionMoved` broadcasts. The main process emits one
		 * to every window whenever session ownership changes (an agent moves between
		 * windows or a window's owned set is replaced), so each renderer can refresh
		 * which agents it surfaces and its cross-window badges.
		 * @param callback - Invoked with the change payload on every broadcast
		 * @returns An unsubscribe function
		 */
		onSessionMoved: (callback: (payload: WindowSessionMovedPayload) => void): (() => void) => {
			const handler = (_event: unknown, payload: WindowSessionMovedPayload) => callback(payload);
			ipcRenderer.on('windows:sessionMoved', handler);
			return () => {
				ipcRenderer.removeListener('windows:sessionMoved', handler);
			};
		},

		/**
		 * Toggle the drop-zone highlight on a target window's tab bar while a tab is
		 * dragged over it from another window (Phase 3 tab drag-out feedback). Called
		 * by the source window's drag-out tracking as the cursor enters/leaves a
		 * candidate window.
		 * @param windowId - The window whose tab bar should (un)highlight
		 * @param active - True to light it up, false to clear it
		 */
		highlightDropZone: (windowId: string, active: boolean): Promise<void> =>
			ipcRenderer.invoke('windows:highlightDropZone', windowId, active),

		/**
		 * Subscribe to `windows:highlightDropZone` pushes for THIS window. The main
		 * process sends one only to the window being hovered as a drop target, so the
		 * renderer can light up / clear its tab-bar drop zone.
		 * @param callback - Invoked with `{ windowId, active }` on every push
		 * @returns An unsubscribe function
		 */
		onHighlightDropZone: (
			callback: (payload: WindowHighlightDropZonePayload) => void
		): (() => void) => {
			const handler = (_event: unknown, payload: WindowHighlightDropZonePayload) =>
				callback(payload);
			ipcRenderer.on('windows:highlightDropZone', handler);
			return () => {
				ipcRenderer.removeListener('windows:highlightDropZone', handler);
			};
		},
	};
}

/**
 * TypeScript type for the windows API.
 */
export type WindowsApi = ReturnType<typeof createWindowsApi>;
