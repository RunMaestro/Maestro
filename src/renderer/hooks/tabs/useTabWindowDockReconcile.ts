/**
 * useTabWindowDockReconcile - the owner window's half of docking a tab back
 * from a tab window (Tab Windows, TW-8, TW-10).
 *
 * Two jobs, both for agents this window owns (the single writer, D1):
 *   1. Dock-back. When a `tab-window-changed` read drops a ref, the tab is back
 *      in this window. It never left `unifiedTabOrder`, so it is already at its
 *      old slot; this makes it the owner's active tab.
 *   2. Stale refs. A ref whose tab the owned agent no longer has is docked, so
 *      main drops it and its tab window never keeps a chip for a gone tab (D7).
 *      That covers a popped tab closed or snoozed through the owner (from the
 *      tab window, the CLI, a PTY exit) and a restart: main restores a tab
 *      window from the stored sessions, but the owner drops some tabs while it
 *      loads them (a terminal tab with no startup command).
 *
 * Only an app window mounts this. A tab window shows the popped tabs, so it
 * must not (the same trap as `usePoppedOutTabGuard`).
 */

import { useEffect, useRef } from 'react';
import type { TabWindowInfo, TabWindowTabRef } from '../../../shared/tabWindowTypes';
import { tabRefKey } from '../../../shared/unifiedTabRef';
import { sessionHasTab } from '../../services/tabWindowNavigation';
import { useSessionStore } from '../../stores/sessionStore';
import { isTabPoppedOut, useTabWindowStore } from '../../stores/tabWindowStore';
import { focusFieldsForRef } from '../../utils/tabHelpers';
import { logger } from '../../utils/logger';
import { captureException } from '../../utils/sentry';

type OwnsSession = (sessionId: string) => boolean;

/**
 * agentId -> the docked tab to show, for every agent whose popped tabs shrank
 * between two registry reads. When several tabs docked at once (a tab window
 * closed), the one its tab window was showing wins, else the last in its strip.
 */
export function findDockedTabsToFocus(
	prev: TabWindowInfo[],
	next: TabWindowInfo[]
): Map<string, TabWindowTabRef> {
	const stillPopped = new Map<string, Set<string>>();
	for (const win of next) {
		let keys = stillPopped.get(win.agentId);
		if (!keys) {
			keys = new Set<string>();
			stillPopped.set(win.agentId, keys);
		}
		for (const ref of win.tabRefs) keys.add(tabRefKey(ref));
	}

	const docked = new Map<string, TabWindowTabRef>();
	for (const win of prev) {
		const keys = stillPopped.get(win.agentId);
		const removed = win.tabRefs.filter((ref) => !keys?.has(tabRefKey(ref)));
		if (removed.length === 0) continue;
		const shown = win.activeTabRef;
		const pick =
			shown && removed.some((ref) => tabRefKey(ref) === tabRefKey(shown))
				? shown
				: removed[removed.length - 1];
		docked.set(win.agentId, pick);
	}
	return docked;
}

/**
 * Make each docked tab the active tab of its owned agent. A tab that is gone
 * (closed from the tab window) or popped out again is skipped. Writes the
 * session store only when an agent changed.
 */
export function focusDockedTabs(
	prev: TabWindowInfo[],
	next: TabWindowInfo[],
	ownsSession?: OwnsSession
): void {
	const docked = findDockedTabsToFocus(prev, next);
	if (docked.size === 0) return;
	const { sessions, setSessions } = useSessionStore.getState();
	let changed = false;
	const updated = sessions.map((session) => {
		const ref = docked.get(session.id);
		if (!ref) return session;
		if (ownsSession && !ownsSession(session.id)) return session;
		if (!sessionHasTab(session, ref) || isTabPoppedOut(session.id, ref)) return session;
		changed = true;
		return { ...session, ...focusFieldsForRef(session, ref) };
	});
	if (changed) setSessions(updated);
}

/** Key of one ref in the pending docks of {@link dockStaleTabWindowRefs}. */
function pendingDockKey(agentId: string, ref: TabWindowTabRef): string {
	return `${agentId}\n${tabRefKey(ref)}`;
}

/**
 * Dock every ref whose tab the owned agent no longer has. `pending` holds the
 * docks asked for that the registry does not reflect yet, so each ref is asked
 * once; it is updated in place. A key is forgotten once the registry no longer
 * lists its ref, so the same tab can be docked again after it pops out again.
 * An agent this window does not own (or has not loaded) is left for a later
 * pass. Does nothing until the sessions were read back successfully.
 */
export function dockStaleTabWindowRefs(pending: Set<string>, ownsSession?: OwnsSession): void {
	const api = window.maestro?.tabWindows;
	if (!api) return;
	const { sessions, sessionsLoaded, sessionsReadOk } = useSessionStore.getState();
	if (!sessionsLoaded || !sessionsReadOk) return;
	const windows = useTabWindowStore.getState().windows;
	if (pending.size > 0) {
		const listed = new Set<string>();
		for (const win of windows) {
			for (const ref of win.tabRefs) listed.add(pendingDockKey(win.agentId, ref));
		}
		for (const key of pending) if (!listed.has(key)) pending.delete(key);
	}
	for (const win of windows) {
		const session = sessions.find((s) => s.id === win.agentId);
		if (!session) continue;
		if (ownsSession && !ownsSession(session.id)) continue;
		for (const ref of win.tabRefs) {
			if (sessionHasTab(session, ref)) continue;
			const key = pendingDockKey(win.agentId, ref);
			if (pending.has(key)) continue;
			pending.add(key);
			api
				.dock(win.agentId, ref)
				.then((result) => {
					if (!result.docked) {
						logger.warn(`[TabWindows] Could not dock a stale tab: ${result.error}`, undefined, {
							agentId: win.agentId,
							ref,
						});
					}
				})
				.catch((error: unknown) => {
					logger.error('[TabWindows] Could not dock a stale tab', undefined, error);
					captureException(error instanceof Error ? error : new Error(String(error)), {
						extra: { operation: 'tabWindows.dock', agentId: win.agentId, tabType: ref.type },
					});
				});
		}
	}
}

/** Mount once in App.tsx, inside the WindowProvider, beside the popped-tab guard. */
export function useTabWindowDockReconcile(ownsSession?: OwnsSession): void {
	const ownsSessionRef = useRef(ownsSession);
	ownsSessionRef.current = ownsSession;
	const pendingDocksRef = useRef(new Set<string>());

	useEffect(() => {
		const runStaleCheck = () =>
			dockStaleTabWindowRefs(pendingDocksRef.current, ownsSessionRef.current);
		const unsubscribeWindows = useTabWindowStore.subscribe((state, prev) => {
			if (state.windows === prev.windows) return;
			focusDockedTabs(prev.windows, state.windows, ownsSessionRef.current);
			runStaleCheck();
		});
		const unsubscribeSessions = useSessionStore.subscribe((state, prev) => {
			if (
				state.sessions !== prev.sessions ||
				state.sessionsLoaded !== prev.sessionsLoaded ||
				state.sessionsReadOk !== prev.sessionsReadOk
			) {
				runStaleCheck();
			}
		});
		runStaleCheck();
		return () => {
			unsubscribeWindows();
			unsubscribeSessions();
		};
	}, []);

	// An agent moved into this window may have a tab window with stale refs.
	useEffect(() => {
		dockStaleTabWindowRefs(pendingDocksRef.current, ownsSession);
	}, [ownsSession]);
}
