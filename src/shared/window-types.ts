/**
 * Type definitions for the multi-window system.
 *
 * These types are shared between the main process (window registry, window
 * manager, window-state store) and the renderer (which self-identifies its
 * window and reflects per-window panel/session state).
 *
 * Throughout these types, `sessionIds` are agent IDs - what Maestro surfaces
 * to users as "sessions" (the entries in the Left Bar). Exactly one window in
 * a `MultiWindowState` is the primary window (`isMain` / `primaryWindowId`);
 * closing it quits the app, secondary windows do not.
 */

/**
 * Persisted state for a single window: its on-screen bounds, maximize/fullscreen
 * flags, which agents (sessions) it owns, which one is active, and the collapsed
 * state of its side panels.
 *
 * `sessionIds` are agent IDs owned by this window; `activeSessionId` is the
 * currently focused agent (or `null` when the window owns no agents).
 */
export interface WindowState {
	id: string;
	x: number;
	y: number;
	width: number;
	height: number;
	isMaximized: boolean;
	isFullScreen: boolean;
	sessionIds: string[];
	activeSessionId: string | null;
	leftPanelCollapsed: boolean;
	rightPanelCollapsed: boolean;
}

/**
 * The collapsed state of a window's two side panels. This is the per-window UI
 * slice the renderer reads on mount and writes back through
 * `window.maestro.windows.setPanelState`, so each window remembers its own
 * collapsed panels rather than sharing one global setting.
 */
export interface WindowPanelState {
	leftPanelCollapsed: boolean;
	rightPanelCollapsed: boolean;
}

/**
 * Top-level persisted multi-window state: every known window plus a pointer to
 * the primary window. Exactly one of `windows` has `id === primaryWindowId`.
 */
export interface MultiWindowState {
	windows: WindowState[];
	primaryWindowId: string;
}

/**
 * Lightweight, runtime view of a window returned over IPC (e.g. `windows:list`).
 * Unlike `WindowState` this omits bounds/panel state and instead reports whether
 * the window is the primary (`isMain`) one.
 *
 * `sessionIds` are agent IDs owned by the window; exactly one window across the
 * app is `isMain`.
 */
export interface WindowInfo {
	id: string;
	isMain: boolean;
	sessionIds: string[];
	activeSessionId: string | null;
}

/**
 * Payload pushed to every window on the `windows:sessionMoved` broadcast channel
 * whenever window<->session ownership changes in the main-process registry.
 * Carries which mutation fired (`session-moved` from `moveSession`,
 * `sessions-changed` from `setSessionsForWindow`) plus the affected window/agent
 * ids. Renderers react by re-reading their scoped agents and the window list, so
 * the fields are advisory context rather than a strict diff to apply.
 */
export interface WindowSessionMovedPayload {
	type: 'session-moved' | 'sessions-changed';
	windowId?: string;
	sessionId?: string;
	fromWindowId?: string;
	toWindowId?: string;
}
