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
	/**
	 * User-assigned window name (from the Left Bar "Move to Window" submenu's
	 * rename affordance). Undefined for the default generic label ("Window N").
	 * Persisted with the window and reconnected on restart by the window's stable
	 * id (see the restore path threading id + name), so a custom name survives a
	 * relaunch.
	 */
	name?: string;
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
 * On-screen rectangle of a window in screen (DIP) coordinates. Returned by the
 * `windows:getBounds` IPC query and consumed by the Phase 3 tab drag-out
 * hit-testing on both sides of the bridge (renderer drag-exit detection +
 * main-process `findWindowAtPoint`), so they share one rectangle shape.
 */
export interface WindowBounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * Whether a screen point lies within a window's bounds. The left/top edges are
 * inclusive and the right/bottom edges are exclusive, so two adjacent (touching)
 * windows never both claim a shared border pixel.
 *
 * This is the single containment rule shared by the main-process window
 * hit-test ({@link WindowBounds} via `WindowRegistry.findWindowAtPoint`) and the
 * renderer's tab drag-exit detection, guaranteeing both agree on edge cases.
 */
export function isPointInWindowBounds(
	point: { x: number; y: number },
	bounds: WindowBounds
): boolean {
	return (
		point.x >= bounds.x &&
		point.x < bounds.x + bounds.width &&
		point.y >= bounds.y &&
		point.y < bounds.y + bounds.height
	);
}

/** Convenience negation of {@link isPointInWindowBounds}. */
export function isPointOutsideWindowBounds(
	point: { x: number; y: number },
	bounds: WindowBounds
): boolean {
	return !isPointInWindowBounds(point, bounds);
}

/** The product name shown as the base of every window's OS title. */
export const APP_WINDOW_TITLE_BASE = 'Maestro';

/**
 * The OS-level window title for a window given its 1-based number (primary = 1,
 * registry order, matching the Left Bar's WindowBadge numbering). Secondary
 * windows (number >= 2) get a "Maestro [N]" badge so users can tell windows
 * apart in Cmd+Tab / Mission Control; the primary window keeps the bare product
 * name. A defensive fall-through for `1` (or anything lower) returns the bare
 * name so a primary never accidentally renders "[1]".
 */
export function formatWindowTitle(windowNumber: number): string {
	return windowNumber > 1 ? `${APP_WINDOW_TITLE_BASE} [${windowNumber}]` : APP_WINDOW_TITLE_BASE;
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
	/** User-assigned window name; undefined for the default generic label. */
	name?: string;
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
	type: 'session-moved' | 'sessions-changed' | 'name-changed' | 'removed';
	windowId?: string;
	sessionId?: string;
	fromWindowId?: string;
	toWindowId?: string;
}

/**
 * Payload pushed to a window on the `windows:highlightDropZone` channel while a
 * tab is being dragged out of another window and hovers over this one. The
 * source window's drag-out tracking toggles `active` as the cursor enters
 * (`true`) and leaves (`false`) a candidate drop target, so the target's tab bar
 * can light up to advertise "drop here to dock". `windowId` is the window the
 * highlight applies to (the main process sends only to that window; renderers may
 * also compare defensively against their own id).
 */
export interface WindowHighlightDropZonePayload {
	windowId: string;
	active: boolean;
}
