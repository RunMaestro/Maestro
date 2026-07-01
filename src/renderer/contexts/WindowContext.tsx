/**
 * WindowContext
 *
 * Teaches the renderer that it is one of several windows. Every window learns
 * its own identity (`windowId` / `isMainWindow`) and the set of agents
 * (sessions) whose tab strips belong to it (`sessionIds` / `activeSessionId`).
 *
 * Identity comes from two sources:
 *   - `isMainWindow` and the initial `windowId` are read synchronously from the
 *     `?windowId=` query param the main process appends to a secondary window's
 *     entry URL (`buildEntryUrl` in `app-lifecycle/window-manager.ts`). The
 *     primary window loads the bare URL with no param, so a missing param means
 *     "this is the primary window".
 *   - Owned agents are hydrated from the main-process {@link WindowRegistry} via
 *     `window.maestro.windows.getState()`.
 *
 * Single-window-per-agent invariant: an agent lives in exactly one window.
 * `openSession` therefore focuses the owning window instead of stealing an
 * agent that already lives elsewhere.
 *
 * Staying in sync: the main process broadcasts `windows:sessionMoved` to every
 * window whenever session ownership changes (`WindowRegistry.moveSession` /
 * `setSessionsForWindow`). This provider subscribes via
 * `window.maestro.windows.onSessionMoved` and re-runs `hydrate` on each
 * broadcast, so a window's scoped agents and the Left Bar's cross-window badges
 * follow an agent entering or leaving any window.
 */

import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
	type ReactNode,
} from 'react';
import { formatWindowTitle, type WindowInfo } from '../../shared/window-types';
import { useSessionStore } from '../stores/sessionStore';
import { notifyToast } from '../stores/notificationStore';

/**
 * Reads the `windowId` query param from the renderer URL. Returns `null` for
 * the primary window (which loads without the param) or when there is no DOM.
 */
function readWindowIdParam(): string | null {
	if (typeof window === 'undefined') return null;
	try {
		return new URLSearchParams(window.location.search).get('windowId');
	} catch {
		return null;
	}
}

/**
 * The agents scoped to a window plus which one is focused. Kept as one piece of
 * state so the active agent always stays consistent with the owned set (e.g.
 * when a tab closes).
 */
interface WindowScope {
	sessionIds: string[];
	activeSessionId: string | null;
}

export interface WindowContextValue {
	/** This window's stable ID. `null` only briefly before the first hydrate. */
	windowId: string | null;
	/** True for the primary window (loaded without a `windowId` param). */
	isMainWindow: boolean;
	/**
	 * This window's own 1-based number in registry order (primary = 1), matching
	 * the Left Bar's WindowBadge numbering. Drives the OS window-title badge so
	 * users can tell windows apart in Cmd+Tab / Mission Control. `null` only
	 * briefly before the first hydrate populates the window list (a secondary
	 * knows it is not the primary but not yet its position).
	 */
	windowNumber: number | null;
	/** Agent (session) IDs whose tab strips belong to THIS window. */
	sessionIds: string[];
	/** The agent currently focused in this window, or `null` when it owns none. */
	activeSessionId: string | null;
	/**
	 * Whether THIS window should surface the given agent's tab strip. The primary
	 * window is the catch-all owner (every agent no secondary window has claimed);
	 * a secondary window owns exactly the agents in its scoped `sessionIds`. The
	 * main tab bar uses this to scope which agent's tabs it renders.
	 */
	ownsSession: (sessionId: string) => boolean;
	/**
	 * If the given agent is currently surfaced by a DIFFERENT window than this
	 * one, returns that window's id plus its human-facing number (1-based, primary
	 * = 1, in registry order). Returns `null` when this window already surfaces the
	 * agent (or nothing is hydrated yet). Drives the Left Bar's "open in window N"
	 * badge and routes a row click to focus that window instead of stealing the
	 * agent (single-window-per-agent).
	 */
	getSessionWindow: (sessionId: string) => { windowId: string; windowNumber: number } | null;
	/**
	 * Open/focus an agent in THIS window. If the agent already lives in another
	 * window, focuses that window instead of stealing it (single-window-per-agent).
	 */
	openSession: (sessionId: string) => Promise<void>;
	/**
	 * Claim a just-created agent for THIS window so its tab strip surfaces here on
	 * the very next render and it is never momentarily shown by the primary
	 * window's catch-all (spawn flicker). Call this when an agent is created from
	 * this window's UI, before its process starts emitting output. The primary
	 * window already surfaces any unclaimed agent, so it only focuses locally; a
	 * secondary window additionally records ownership in the registry so the
	 * primary excludes the agent and the layout persists to it.
	 */
	registerNewSession: (sessionId: string) => Promise<void>;
	/** Remove an agent's tab strip from this window (does not delete the agent). */
	closeTab: (sessionId: string) => void;
	/**
	 * Detach an agent into a brand-new window, leaving this one. Pass `bounds` to
	 * position the new window (e.g. at a tab drag-out drop point); omit it to let
	 * the main process pick a default position (the right-click "Move to New
	 * Window" path).
	 */
	moveSessionToNewWindow: (sessionId: string, bounds?: { x: number; y: number }) => Promise<void>;
	/**
	 * Dock an agent into an EXISTING window (the tab drag-out drop target),
	 * leaving this one. The destination surfaces the agent in its tab bar and
	 * activates it via the `windows:sessionMoved` broadcast; this just transfers
	 * registry ownership and drops the agent from this window's scope. No-op when
	 * the target is this window or this window has no id yet.
	 */
	moveSessionToWindow: (sessionId: string, targetWindowId: string) => Promise<void>;
	/**
	 * True while a tab from ANOTHER window is being dragged over THIS window as a
	 * candidate dock target. The main process pushes the toggle on
	 * `windows:highlightDropZone` (sent only to the hovered window); the tab bar
	 * reads this to light up its drop zone. False whenever no cross-window drag is
	 * hovering this window.
	 */
	isDropTarget: boolean;
}

const WindowContext = createContext<WindowContextValue | null>(null);

/**
 * Pick the agent to focus after `removed` leaves the window. Mirrors the usual
 * tab-close behaviour: prefer the neighbour to the left, else the new first
 * tab, else nothing. A no-op (returns `current`) when the removed agent was not
 * the active one.
 */
function pickNextActive(
	sessionIds: string[],
	removed: string,
	current: string | null
): string | null {
	if (current !== removed) return current;
	const idx = sessionIds.indexOf(removed);
	const remaining = sessionIds.filter((id) => id !== removed);
	if (remaining.length === 0) return null;
	const nextIdx = Math.min(Math.max(0, idx - 1), remaining.length - 1);
	return remaining[nextIdx] ?? null;
}

/** Drop an agent from a window scope, re-pointing the active agent if needed. */
function removeFromScope(prev: WindowScope, sessionId: string): WindowScope {
	if (!prev.sessionIds.includes(sessionId)) return prev;
	return {
		sessionIds: prev.sessionIds.filter((id) => id !== sessionId),
		activeSessionId: pickNextActive(prev.sessionIds, sessionId, prev.activeSessionId),
	};
}

export function WindowProvider({ children }: { children: ReactNode }) {
	// isMainWindow and the initial windowId are known synchronously from the URL,
	// so the very first render already reflects the correct window identity.
	const paramWindowId = useMemo(() => readWindowIdParam(), []);
	const isMainWindow = paramWindowId === null;
	const [windowId, setWindowId] = useState<string | null>(paramWindowId);
	const [scope, setScope] = useState<WindowScope>({ sessionIds: [], activeSessionId: null });
	// Every open window, in registry order (primary first). This is the single
	// source for cross-window ownership: which window surfaces an agent and its
	// 1-based number. Empty (single-window common case) until the first hydrate.
	const [windows, setWindows] = useState<WindowInfo[]>([]);
	// True while a tab from another window is being dragged over this one as a
	// dock target (driven by the `windows:highlightDropZone` push). Transient
	// drag-feedback state; cleared by the source window on drag end.
	const [isDropTarget, setIsDropTarget] = useState(false);

	/**
	 * Pull this window's owned agents + active agent from the main-process
	 * registry, plus the full window list (for cross-window ownership). Reused on
	 * mount and (later Phase 2 task) when a `windows:sessionMoved` broadcast says
	 * ownership changed.
	 */
	const hydrate = useCallback(async () => {
		const [state, allWindows] = await Promise.all([
			window.maestro.windows.getState(),
			window.maestro.windows.list(),
		]);
		if (!state) return;
		// The primary window has no URL param, so adopt the registry's id for it.
		setWindowId((prev) => prev ?? state.id);
		setScope({ sessionIds: state.sessionIds, activeSessionId: state.activeSessionId });
		setWindows(allWindows ?? []);
	}, []);

	useEffect(() => {
		void hydrate();
	}, [hydrate]);

	// Refresh on every `windows:sessionMoved` broadcast so this window follows an
	// agent entering or leaving any window. We subscribe through the preload
	// callback rather than `useEventListener`: under contextIsolation a main->
	// renderer IPC broadcast surfaces as a callback (the codebase's own bridge in
	// `useRemoteIntegration` does the IPC->DOM re-dispatch in a renderer hook, not
	// the preload), and WindowContext is the single, root-level consumer here, so
	// a direct subscription with cleanup is the simplest reliable wiring. Any
	// ownership change can shift this window's cross-window badges, so we always
	// re-hydrate (the full registry read) instead of diffing the payload.
	useEffect(() => {
		const unsubscribe = window.maestro.windows.onSessionMoved(() => {
			void hydrate();
		});
		return unsubscribe;
	}, [hydrate]);

	// Light up this window's tab-bar drop zone while a tab from another window is
	// dragged over it. The main process sends the toggle only to the hovered
	// window; we still compare against our own id defensively. Null-safe so a
	// preload without the channel (web build / isolation tests) simply never
	// highlights instead of throwing.
	useEffect(() => {
		const subscribe = window.maestro?.windows?.onHighlightDropZone;
		if (!subscribe) return;
		const unsubscribe = subscribe((payload) => {
			if (windowId && payload.windowId && payload.windowId !== windowId) return;
			setIsDropTarget(payload.active);
		});
		return unsubscribe;
	}, [windowId]);

	// Agents claimed by OTHER windows. The primary window is the catch-all owner,
	// so it needs to know which agents a secondary window has taken over to scope
	// its tab bar correctly. Derived from the window list so there is one source.
	const sessionsOwnedElsewhere = useMemo(() => {
		const set = new Set<string>();
		for (const win of windows) {
			if (win.id === windowId) continue;
			for (const sid of win.sessionIds) set.add(sid);
		}
		return set;
	}, [windows, windowId]);

	// This window's own 1-based number, derived from its position in the registry
	// order (primary first) so it always matches the Left Bar's cross-window
	// badge. Before the first hydrate the window list is empty: the primary is
	// known to be #1 from the URL, while a secondary's position is not yet known.
	const windowNumber = useMemo<number | null>(() => {
		if (windowId && windows.length > 0) {
			const idx = windows.findIndex((win) => win.id === windowId);
			if (idx !== -1) return idx + 1;
		}
		return isMainWindow ? 1 : null;
	}, [windowId, windows, isMainWindow]);

	// Reflect a secondary window's number in its OS title ("Maestro [2]") so users
	// can tell windows apart in Cmd+Tab / Mission Control. Only secondary windows
	// get the badge; the primary keeps its descriptive HTML title untouched. The
	// number tracks registry order, so the title re-renders whenever a hydrate
	// (e.g. a window opening/closing) shifts this window's position.
	useEffect(() => {
		if (typeof document === 'undefined') return;
		if (isMainWindow || windowNumber === null) return;
		document.title = formatWindowTitle(windowNumber);
	}, [isMainWindow, windowNumber]);

	const ownsSession = useCallback(
		(sessionId: string): boolean =>
			// The primary window surfaces every agent that no secondary window has
			// explicitly claimed; a secondary window owns exactly its scoped set.
			isMainWindow ? !sessionsOwnedElsewhere.has(sessionId) : scope.sessionIds.includes(sessionId),
		[isMainWindow, sessionsOwnedElsewhere, scope.sessionIds]
	);

	const getSessionWindow = useCallback(
		(sessionId: string): { windowId: string; windowNumber: number } | null => {
			if (windows.length === 0) return null;
			// A secondary window's explicit claim wins; otherwise the primary window
			// is the catch-all owner. Window number is the 1-based position in the
			// registry's window list (primary first).
			let ownerIdx = -1;
			let primaryIdx = -1;
			for (let i = 0; i < windows.length; i++) {
				const win = windows[i];
				if (win.isMain) primaryIdx = i;
				if (!win.isMain && win.sessionIds.includes(sessionId)) {
					ownerIdx = i;
					break;
				}
			}
			const idx = ownerIdx !== -1 ? ownerIdx : primaryIdx;
			if (idx === -1) return null;
			const owner = windows[idx];
			// No badge for an agent this window already surfaces.
			if (owner.id === windowId) return null;
			return { windowId: owner.id, windowNumber: idx + 1 };
		},
		[windows, windowId]
	);

	const openSession = useCallback(
		async (sessionId: string) => {
			const ownerWindowId = await window.maestro.windows.getForSession(sessionId);
			if (ownerWindowId && ownerWindowId !== windowId) {
				// Lives in another window - focus it rather than stealing the agent.
				await window.maestro.windows.focusWindow(ownerWindowId);
				return;
			}
			// Owned here, or owned by no window yet: open/focus it locally.
			setScope((prev) => ({
				sessionIds: prev.sessionIds.includes(sessionId)
					? prev.sessionIds
					: [...prev.sessionIds, sessionId],
				activeSessionId: sessionId,
			}));
		},
		[windowId]
	);

	const closeTab = useCallback((sessionId: string) => {
		setScope((prev) => removeFromScope(prev, sessionId));
	}, []);

	const registerNewSession = useCallback(
		async (sessionId: string) => {
			// Surface the agent in THIS window immediately. The scope update is
			// synchronous, so the creating window's tab strip shows the agent on the
			// next render with no async gap (the source of spawn flicker).
			setScope((prev) => ({
				sessionIds: prev.sessionIds.includes(sessionId)
					? prev.sessionIds
					: [...prev.sessionIds, sessionId],
				activeSessionId: sessionId,
			}));
			// The primary window is the catch-all owner: it already surfaces any
			// unclaimed agent, so no registry write is needed (and none of the saved
			// primary sessionIds drive its ownership). A secondary window must record
			// the claim so the primary's catch-all excludes the agent and the layout
			// persists the agent to this window.
			if (isMainWindow) return;
			await window.maestro.windows.registerSession(sessionId);
		},
		[isMainWindow]
	);

	/**
	 * Guard against emptying the primary window. The primary is the catch-all
	 * owner, so it must always surface at least one agent; moving the last agent
	 * out of it is blocked (with a toast) rather than leaving the user with no
	 * primary tab strip. Secondary windows are NOT guarded - they may be emptied
	 * and auto-close (Phase 6).
	 *
	 * The primary's agent count is the set of sessions no secondary window has
	 * claimed, read live from the session store at gesture time (this runs on a
	 * user move, so a snapshot read is correct and needs no reactivity). The move
	 * empties the primary only when the agent leaving is the single agent it still
	 * owns; an agent the store doesn't track (e.g. isolation tests) fails open so a
	 * legitimate move is never wrongly blocked.
	 *
	 * Returns `true` when the move was blocked (and the toast fired) so callers can
	 * bail before mutating any window state.
	 */
	const blocksEmptyingPrimary = useCallback(
		(sessionId: string): boolean => {
			if (!isMainWindow) return false;
			const primaryAgents = useSessionStore
				.getState()
				.sessions.filter((session) => !sessionsOwnedElsewhere.has(session.id));
			const isLastInPrimary =
				primaryAgents.length <= 1 && primaryAgents.some((session) => session.id === sessionId);
			if (!isLastInPrimary) return false;
			notifyToast({
				color: 'yellow',
				title: "Can't empty the primary window",
				message: 'This is the last agent in the primary window. Keep at least one agent here.',
			});
			return true;
		},
		[isMainWindow, sessionsOwnedElsewhere]
	);

	const moveSessionToNewWindow = useCallback(
		async (sessionId: string, bounds?: { x: number; y: number }) => {
			if (!windowId) return;
			if (blocksEmptyingPrimary(sessionId)) return;
			const created = await window.maestro.windows.create([sessionId], bounds);
			if (!created) return;
			// The new window already owns the agent; this transfer just removes it
			// from THIS window's registry ownership (enforcing single-window-per-agent)
			// and emits the move so other windows can refresh.
			await window.maestro.windows.moveSession(sessionId, windowId, created.id);
			setScope((prev) => removeFromScope(prev, sessionId));
		},
		[windowId, blocksEmptyingPrimary]
	);

	const moveSessionToWindow = useCallback(
		async (sessionId: string, targetWindowId: string) => {
			// No identity yet, or a "move" onto this same window: nothing to do.
			if (!windowId || targetWindowId === windowId) return;
			if (blocksEmptyingPrimary(sessionId)) return;
			const result = await window.maestro.windows.moveSession(sessionId, windowId, targetWindowId);
			// Only drop the agent from this window once the registry confirms the move,
			// so a failed transfer never strands the agent (owned by no window).
			if (!result?.moved) return;
			setScope((prev) => removeFromScope(prev, sessionId));
		},
		[windowId, blocksEmptyingPrimary]
	);

	const value = useMemo<WindowContextValue>(
		() => ({
			windowId,
			isMainWindow,
			windowNumber,
			sessionIds: scope.sessionIds,
			activeSessionId: scope.activeSessionId,
			ownsSession,
			getSessionWindow,
			openSession,
			registerNewSession,
			closeTab,
			moveSessionToNewWindow,
			moveSessionToWindow,
			isDropTarget,
		}),
		[
			windowId,
			isMainWindow,
			windowNumber,
			scope.sessionIds,
			scope.activeSessionId,
			ownsSession,
			getSessionWindow,
			openSession,
			registerNewSession,
			closeTab,
			moveSessionToNewWindow,
			moveSessionToWindow,
			isDropTarget,
		]
	);

	return <WindowContext.Provider value={value}>{children}</WindowContext.Provider>;
}

/**
 * Access the current window's identity and scoped agents. Throws if used
 * outside a {@link WindowProvider}.
 */
export function useWindowContext(): WindowContextValue {
	const context = useContext(WindowContext);
	if (!context) {
		throw new Error('useWindowContext must be used within a WindowProvider');
	}
	return context;
}

/**
 * Like {@link useWindowContext} but returns `null` instead of throwing when used
 * outside a {@link WindowProvider}. For components that mount both inside the
 * window-aware app and standalone (e.g. in isolation tests) - they degrade to
 * "no window scoping" rather than crashing.
 */
export function useWindowContextOptional(): WindowContextValue | null {
	return useContext(WindowContext);
}

/**
 * Whether THIS window should surface (render) the given agent. A thin, null-safe
 * convenience over {@link WindowContextValue.ownsSession} for the common case of
 * gating an agent-scoped view on ownership:
 *   - Outside a {@link WindowProvider} (single-window app / isolation tests) it
 *     returns `true`, so callers keep today's unscoped behaviour.
 *   - When `sessionId` is null/undefined it returns `true` - there is no agent to
 *     gate, so the caller's own "no active agent" branch handles that case.
 *
 * The main tab bar, {@link MainPanel}, and {@link RightPanel} use this to fall
 * back to a clean empty state for an agent this window no longer owns (e.g. after
 * the agent moved to another window) instead of showing a stale view.
 */
export function useWindowOwnsSession(sessionId: string | null | undefined): boolean {
	const ctx = useWindowContextOptional();
	return !ctx || !sessionId || ctx.ownsSession(sessionId);
}
