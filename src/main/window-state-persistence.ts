// src/main/window-state-persistence.ts

/**
 * Window-state persistence helpers.
 *
 * Bridges the live {@link WindowRegistry} (the in-memory source of truth for
 * window<->session ownership and per-window panel state) and the persisted
 * {@link MultiWindowState} stored in the window-state store.
 *
 * This is the single place that converts a registered window into its persisted
 * shape, so the IPC layer (`windows:getState`), the quit handler (save-all on
 * shutdown), and the later debounced per-window saves all agree on what a
 * window's persisted state looks like. Do not re-derive this conversion
 * elsewhere - import from here.
 */

import type Store from 'electron-store';
import type { MultiWindowState, WindowState } from '../shared/window-types';
import type { WindowState as WindowStateStoreData, SessionsData } from './stores/types';
import type { RegisteredWindow, WindowRegistry } from './window-registry';
import { logger } from './utils/logger';

const LOG_CONTEXT = 'WindowState';

/**
 * Debounce window for per-window state saves driven by `move`/`resize`/maximize/
 * fullscreen events. Held in the 300-500ms band so a drag or live-resize that
 * fires dozens of events collapses into a single store write once the user
 * settles, rather than a write storm.
 */
export const WINDOW_STATE_SAVE_DEBOUNCE_MS = 400;

/**
 * Build the persisted {@link WindowState} for one registered window from its
 * live `BrowserWindow` bounds plus the registry's session ownership and
 * per-window panel-collapse state.
 *
 * `activeSessionId` is renderer-driven state the registry does not track yet, so
 * it is reported as `null`; later phases thread the active agent through. Bounds
 * come from `getBounds()` (the on-screen rectangle), matching what the renderer
 * reads via `windows:getState`.
 */
export function registeredWindowToWindowState(entry: RegisteredWindow): WindowState {
	const { browserWindow } = entry;
	const bounds = browserWindow.getBounds();
	return {
		id: entry.id,
		x: bounds.x,
		y: bounds.y,
		width: bounds.width,
		height: bounds.height,
		isMaximized: browserWindow.isMaximized(),
		isFullScreen: browserWindow.isFullScreen(),
		sessionIds: [...entry.sessionIds],
		activeSessionId: null,
		leftPanelCollapsed: entry.leftPanelCollapsed,
		rightPanelCollapsed: entry.rightPanelCollapsed,
	};
}

/**
 * Snapshot every live registered window into a {@link MultiWindowState}.
 *
 * Destroyed windows are skipped (their `BrowserWindow` getters throw). The
 * primary window's id becomes `primaryWindowId`; if no window is flagged primary
 * (should not happen) the first window stands in so restoration always has a
 * resolvable primary pointer.
 */
export function buildMultiWindowState(registry: WindowRegistry): MultiWindowState {
	const windows: WindowState[] = [];
	let primaryWindowId = '';
	for (const entry of registry.getAll()) {
		if (entry.browserWindow.isDestroyed()) continue;
		windows.push(registeredWindowToWindowState(entry));
		if (entry.isMain) primaryWindowId = entry.id;
	}
	if (!primaryWindowId && windows.length > 0) {
		primaryWindowId = windows[0].id;
	}
	return { windows, primaryWindowId };
}

/**
 * Persist the current multi-window layout (every window's bounds, display mode,
 * owned agents, and panel-collapse state) to the window-state store under the
 * `multiWindow` key.
 *
 * Called from the quit handler's cleanup so a relaunch can restore the exact
 * layout. NEVER throws: persistence must not block or break shutdown. When no
 * live windows are registered (e.g. the app idled with every window closed on
 * macOS) the last-known layout is left untouched rather than wiped.
 */
export function saveAllWindowStates(
	store: Store<WindowStateStoreData>,
	registry: WindowRegistry
): void {
	try {
		const state = buildMultiWindowState(registry);
		if (state.windows.length === 0) {
			// Nothing live to snapshot - keep the previously persisted layout.
			return;
		}
		store.set('multiWindow', state);
		logger.info(`Saved multi-window state - ${state.windows.length} window(s)`, LOG_CONTEXT);
	} catch (error) {
		logger.error('Failed to save multi-window state', LOG_CONTEXT, error);
	}
}

/**
 * Persist the layout after one window changed (moved, resized, or toggled
 * maximize/fullscreen). `windowId` identifies the window that triggered the save
 * so a stale event from an already-removed or destroyed window is ignored.
 *
 * Window ids are minted fresh each launch (`generateUUID`), so a targeted
 * merge into the previously persisted blob would key off ids that no longer
 * match and resurrect last session's dead windows. Snapshotting the whole live
 * registry instead is always correct and self-healing - the moved window's new
 * bounds are captured along with every other open window's current state. Like
 * {@link saveAllWindowStates}, this never throws.
 */
export function saveWindowState(
	store: Store<WindowStateStoreData>,
	registry: WindowRegistry,
	windowId: string
): void {
	const entry = registry.get(windowId);
	if (!entry || entry.browserWindow.isDestroyed()) return;
	saveAllWindowStates(store, registry);
}

/**
 * Read the agent (session) IDs that currently exist from the sessions store.
 *
 * Both the startup restore (which prunes each saved window's owned agents
 * against this set) and the legacy single-window migration (which seeds the
 * migrated primary window with every previously-open agent) need the same
 * "agents that still exist" list, so they share one reader rather than each
 * re-deriving it. A non-array value (corrupt store, or a stub that ignores the
 * fallback) yields an empty list, and non-string ids are skipped defensively -
 * this runs at startup outside any try/catch, so it must never throw.
 */
export function readExistingAgentIds(sessionsStore: Pick<Store<SessionsData>, 'get'>): string[] {
	const sessions = sessionsStore.get('sessions', []) as unknown;
	if (!Array.isArray(sessions)) return [];
	const ids: string[] = [];
	for (const session of sessions as Array<{ id?: unknown }>) {
		if (typeof session?.id === 'string') ids.push(session.id);
	}
	return ids;
}

/**
 * One window to recreate on startup: whether it is the primary, the agents it
 * owns (already pruned of deleted agents), and the bounds/display mode and
 * panel-collapse state to restore it with.
 */
export interface WindowRestoreSpec {
	isPrimary: boolean;
	sessionIds: string[];
	bounds: WindowState;
}

/**
 * Plan the windows to recreate from a persisted {@link MultiWindowState},
 * dropping any owned agents that no longer exist.
 *
 * This is the read-side inverse of {@link buildMultiWindowState}: it turns the
 * persisted blob back into an ordered list of window-creation specs the window
 * manager can replay. Each saved window contributes one spec carrying its
 * surviving agents (pruned against `existingAgentIds`) and its bounds. The
 * primary window (the one whose id matches `primaryWindowId`, or the first
 * window when that pointer is dangling) is flagged `isPrimary` and placed first
 * so callers create it before any secondary.
 *
 * Returns an empty array when there is nothing to restore - no state at all, or
 * a state that tracks zero windows (a fresh install seeds `{ windows: [] }`).
 * Callers treat that as "fall back to a single primary window".
 */
export function planWindowRestore(
	state: MultiWindowState | undefined,
	existingAgentIds: ReadonlySet<string>
): WindowRestoreSpec[] {
	if (!state || state.windows.length === 0) return [];

	const primary =
		state.windows.find((window) => window.id === state.primaryWindowId) ?? state.windows[0];
	const pruneSessions = (sessionIds: string[]): string[] =>
		sessionIds.filter((id) => existingAgentIds.has(id));

	// Primary first so the caller can create it (and anchor `mainWindow`) before
	// any secondary window; the remaining windows keep their saved order.
	const specs: WindowRestoreSpec[] = [
		{ isPrimary: true, sessionIds: pruneSessions(primary.sessionIds), bounds: primary },
	];
	for (const window of state.windows) {
		if (window.id === primary.id) continue;
		specs.push({ isPrimary: false, sessionIds: pruneSessions(window.sessionIds), bounds: window });
	}
	return specs;
}
