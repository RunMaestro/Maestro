/**
 * Multi-Window Type Definitions
 *
 * Shared type definitions for multi-window support in Maestro.
 * These types are used by both the main process and renderer process.
 *
 * Implements GitHub issue #133 - allowing tabs to be dragged out into separate windows.
 */

/**
 * Represents the serializable state of a single window.
 * Used for persisting and restoring window layouts across app restarts.
 */
export interface WindowState {
	/** Unique identifier for the window */
	id: string;

	/** Window X position on screen */
	x: number;

	/** Window Y position on screen */
	y: number;

	/** Window width in pixels */
	width: number;

	/** Window height in pixels */
	height: number;

	/** Whether the window is maximized */
	isMaximized: boolean;

	/** Whether the window is in full-screen mode */
	isFullScreen: boolean;

	/** IDs of sessions open in this window */
	sessionIds: string[];

	/** ID of the currently active session in this window */
	activeSessionId?: string;

	/** Whether the left panel (session list) is collapsed */
	leftPanelCollapsed: boolean;

	/** Whether the right panel (files, history, auto run) is collapsed */
	rightPanelCollapsed: boolean;
}

/**
 * Represents the complete multi-window state for the application.
 * Used for persisting the entire window layout on app quit and restoring on restart.
 */
export interface MultiWindowState {
	/** Array of all window states */
	windows: WindowState[];

	/** ID of the primary (main) window that cannot be closed */
	primaryWindowId: string;
}

/**
 * Lightweight window information for IPC communication.
 * Contains essential data about a window without the full persistence state.
 * Used by renderer to know about other windows and their sessions.
 */
export interface WindowInfo {
	/** Unique identifier for the window */
	id: string;

	/** Whether this is the primary (main) window */
	isMain: boolean;

	/** IDs of sessions open in this window */
	sessionIds: string[];

	/** ID of the currently active session in this window */
	activeSessionId?: string;
}

/**
 * Options for creating a new window via IPC.
 * Subset of CreateWindowOptions from window-registry for renderer use.
 */
export interface CreateWindowRequest {
	/** Session IDs to open in the new window */
	sessionIds?: string[];

	/** ID of the session to make active */
	activeSessionId?: string;

	/** Optional window bounds */
	bounds?: {
		x?: number;
		y?: number;
		width?: number;
		height?: number;
	};
}

/**
 * Result from creating a new window via IPC.
 */
export interface CreateWindowResponse {
	/** The unique window ID */
	windowId: string;
}

/**
 * Request to move a session between windows via IPC.
 */
export interface MoveSessionRequest {
	/** The session ID to move */
	sessionId: string;

	/** The source window ID (can be undefined to just add to target) */
	fromWindowId?: string;

	/** The target window ID */
	toWindowId: string;
}

/**
 * Default window bounds for new windows.
 * Used when creating secondary windows without explicit bounds.
 */
export const DEFAULT_WINDOW_BOUNDS = {
	width: 1200,
	height: 800,
} as const;

/**
 * Minimum window dimensions.
 */
export const MIN_WINDOW_BOUNDS = {
	width: 800,
	height: 600,
} as const;
