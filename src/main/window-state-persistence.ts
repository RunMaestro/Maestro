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
import { isSingleTabRef, tabRefKey, type SingleTabRef } from '../shared/unifiedTabRef';

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
	const state: WindowState = {
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
		name: entry.name,
	};
	// A tab window also records which agent's tabs it holds (TW-10).
	if (entry.kind === 'tab') {
		state.kind = 'tab';
		state.agentId = entry.agentId;
		state.tabRefs = (entry.tabRefs ?? []).map((ref) => ({ type: ref.type, id: ref.id }));
		state.activeTabRef = entry.activeTabRef
			? { type: entry.activeTabRef.type, id: entry.activeTabRef.id }
			: null;
	}
	return state;
}

/**
 * Snapshot every live registered window into a {@link MultiWindowState}.
 *
 * Destroyed windows are skipped (their `BrowserWindow` getters throw). The
 * primary window's id becomes `primaryWindowId`; if no window is flagged primary
 * (should not happen) the first window stands in so restoration always has a
 * resolvable primary pointer.
 *
 * Tab windows go into `tabWindows` (TW-10). A tab window with no tab left is
 * on its way to closing, so it is not saved.
 */
export function buildMultiWindowState(registry: WindowRegistry): MultiWindowState {
	const windows: WindowState[] = [];
	let primaryWindowId = '';
	// Only persist session-owning app windows here; feature windows like the
	// cadenza HUD must not be snapshotted and replayed as a normal window on restart.
	for (const entry of registry.getAppWindows()) {
		if (entry.browserWindow.isDestroyed()) continue;
		windows.push(registeredWindowToWindowState(entry));
		if (entry.isMain) primaryWindowId = entry.id;
	}
	if (!primaryWindowId && windows.length > 0) {
		primaryWindowId = windows[0].id;
	}
	const tabWindows: WindowState[] = [];
	for (const entry of registry.getTabWindows()) {
		if (entry.browserWindow.isDestroyed() || (entry.tabRefs?.length ?? 0) === 0) continue;
		tabWindows.push(registeredWindowToWindowState(entry));
	}
	return { windows, primaryWindowId, tabWindows };
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
 * Snapshots the whole live registry rather than merging the one window into the
 * previously persisted blob: a merge would leave last session's dead windows in
 * the saved list, whereas a full snapshot captures every currently-open window's
 * state and drops the rest. (Restored windows now keep their saved id - see the
 * restore path - so id-keyed state like a custom name reconnects; a full snapshot
 * stays correct either way.) Like {@link saveAllWindowStates}, this never throws.
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
 * Save the layout on the registry changes that fire no window move or resize,
 * so they survive even an abrupt exit:
 *
 * - A window rename or a panel-collapse toggle. {@link saveWindowState}
 *   snapshots the whole live registry, so the affected window's id is enough.
 * - A tab window's tabs changing (pop out, dock, active tab), TW-10. This one
 *   snapshots without the per-window guard: a tab window destroyed without
 *   'close' docks its tabs after it is destroyed, and that last change must
 *   still drop it from the saved layout.
 *
 * Returns the unsubscribe function.
 */
export function wireWindowStateSaveOnChange(
	store: Store<WindowStateStoreData>,
	registry: WindowRegistry
): () => void {
	return registry.onChange((change) => {
		if ((change.type === 'name-changed' || change.type === 'panel-changed') && change.windowId) {
			saveWindowState(store, registry, change.windowId);
		} else if (change.type === 'tab-window-changed') {
			saveAllWindowStates(store, registry);
		}
	});
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
 * Read which tabs each agent has in the sessions store, keyed by agent id, as
 * {@link tabRefKey} strings. The tab window restore uses it to drop the record
 * of a deleted agent and the refs of tabs that are gone (TW-10).
 *
 * Hidden consult AI tabs are left out: they never pop out (TW-14). The store
 * holds what the renderer saved, and the renderer can still drop a saved tab
 * while it loads (a terminal tab with no startup command), so a ref found here
 * can still be missing in the owner window; the owner docks those itself.
 * Like {@link readExistingAgentIds}, this runs at startup and never throws.
 */
export function readExistingAgentTabs(
	sessionsStore: Pick<Store<SessionsData>, 'get'>
): Map<string, Set<string>> {
	const sessions = sessionsStore.get('sessions', []) as unknown;
	const tabsByAgent = new Map<string, Set<string>>();
	if (!Array.isArray(sessions)) return tabsByAgent;
	const tabArrays: Array<[SingleTabRef['type'], string]> = [
		['ai', 'aiTabs'],
		['file', 'filePreviewTabs'],
		['terminal', 'terminalTabs'],
		['browser', 'browserTabs'],
	];
	for (const session of sessions as Array<Record<string, unknown> | null>) {
		if (typeof session?.id !== 'string') continue;
		const keys = new Set<string>();
		for (const [type, field] of tabArrays) {
			const tabs = session[field];
			if (!Array.isArray(tabs)) continue;
			for (const tab of tabs as Array<{ id?: unknown; hidden?: unknown } | null>) {
				if (typeof tab?.id !== 'string') continue;
				if (type === 'ai' && tab.hidden === true) continue;
				keys.add(tabRefKey({ type, id: tab.id }));
			}
		}
		tabsByAgent.set(session.id, keys);
	}
	return tabsByAgent;
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

/** One tab window to recreate on startup, after the app windows exist (TW-10). */
export interface TabWindowRestoreSpec {
	agentId: string;
	/** The surviving tabs, in strip order. Never empty. */
	tabRefs: SingleTabRef[];
	/** The saved active tab when it survived, else null (the first tab shows). */
	activeTabRef: SingleTabRef | null;
	/** Saved bounds and id. The window manager clamps them onto a present display. */
	bounds: WindowState;
}

/**
 * Plan the tab windows to recreate from a persisted {@link MultiWindowState}.
 *
 * `existingTabs` is {@link readExistingAgentTabs}: an agent missing from it no
 * longer exists, so its record is dropped; a ref missing from its set is a tab
 * that is gone, so the ref is dropped. A record left with no tab is dropped. A
 * second record for an agent already planned is dropped too (TW-4).
 */
export function planTabWindowRestore(
	state: MultiWindowState | undefined,
	existingTabs: ReadonlyMap<string, ReadonlySet<string>>
): TabWindowRestoreSpec[] {
	const records = state?.tabWindows;
	if (!Array.isArray(records)) return [];

	const specs: TabWindowRestoreSpec[] = [];
	const plannedAgents = new Set<string>();
	for (const record of records) {
		const agentId = record?.agentId;
		if (typeof agentId !== 'string' || plannedAgents.has(agentId)) continue;
		const agentTabs = existingTabs.get(agentId);
		if (!agentTabs) continue;

		const tabRefs: SingleTabRef[] = [];
		const kept = new Set<string>();
		for (const ref of Array.isArray(record.tabRefs) ? record.tabRefs : []) {
			if (!isSingleTabRef(ref)) continue;
			const key = tabRefKey(ref);
			if (kept.has(key) || !agentTabs.has(key)) continue;
			kept.add(key);
			tabRefs.push({ type: ref.type, id: ref.id });
		}
		if (tabRefs.length === 0) continue;

		const savedActive = record.activeTabRef;
		const activeTabRef =
			isSingleTabRef(savedActive) && kept.has(tabRefKey(savedActive))
				? { type: savedActive.type, id: savedActive.id }
				: null;
		plannedAgents.add(agentId);
		specs.push({ agentId, tabRefs, activeTabRef, bounds: record });
	}
	return specs;
}

/**
 * Pick which restored window should receive focus on startup: the one that owns
 * the globally-active agent (the Left Bar highlight), so the user lands on the
 * agent they were last using instead of whichever window happened to be created
 * last (a secondary stacked on the primary would otherwise steal focus and open
 * onto the wrong - or empty - view).
 *
 * A secondary window that explicitly owns the active agent wins; otherwise the
 * primary window is the catch-all owner. Falls back to the primary when there is
 * no active agent, or it no longer lives in any restored window. Returns
 * `undefined` only for an empty spec list (nothing to focus).
 */
export function pickFocusWindowSpec(
	specs: WindowRestoreSpec[],
	activeSessionId: string | null | undefined
): WindowRestoreSpec | undefined {
	if (specs.length === 0) return undefined;
	const primary = specs.find((spec) => spec.isPrimary) ?? specs[0];
	if (!activeSessionId) return primary;
	const owner = specs.find((spec) => !spec.isPrimary && spec.sessionIds.includes(activeSessionId));
	return owner ?? primary;
}
