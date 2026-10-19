/**
 * usePoppedOutTabGuard - keeps the owner window off tabs that are popped out
 * into a tab window (Tab Windows, D4).
 *
 * The invariant: in the window that owns an agent, no active pointer names a
 * popped tab. Two things can break it, and this guard re-picks the owner's tab
 * after either:
 *   1. The popped set changes. Popping out the tab the user is looking at does
 *      not touch the `Session`, so only the `tab-window-changed` mirror sees it.
 *   2. A session write lands a pointer on a popped tab. Navigation that targets
 *      a popped tab is redirected to its tab window at the call site; this is
 *      the safety net for a path that missed the redirect.
 *
 * The re-pick itself is {@link repickPoppedOutActiveTab}, which uses the same
 * left-neighbor rule as `closeTab`. Only owned agents are touched: the owner is
 * the single writer of its agents (D1).
 */

import { useEffect, useRef } from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import { useTabWindowStore } from '../../stores/tabWindowStore';
import { repickPoppedOutActiveTab } from '../../utils/tabHelpers';

/**
 * One pass of the guard: re-pick the active tab of every owned agent whose
 * pointer names a popped tab. Writes the session store only when an agent
 * changed, so running it from a session-store subscription settles in one
 * extra pass.
 *
 * @param ownsSession - Whether this window owns an agent. Omit outside a
 *                      window-scoped app (every agent is owned).
 */
export function reconcilePoppedOutActiveTabs(ownsSession?: (sessionId: string) => boolean): void {
	const poppedByAgent = useTabWindowStore.getState().poppedByAgent;
	if (Object.keys(poppedByAgent).length === 0) return;
	const { sessions, setSessions } = useSessionStore.getState();
	let changed = false;
	const next = sessions.map((session) => {
		if (!poppedByAgent[session.id]) return session;
		if (ownsSession && !ownsSession(session.id)) return session;
		const repicked = repickPoppedOutActiveTab(session);
		if (repicked !== session) changed = true;
		return repicked;
	});
	if (changed) setSessions(next);
}

/** Mount once in App.tsx, inside the WindowProvider. */
export function usePoppedOutTabGuard(ownsSession?: (sessionId: string) => boolean): void {
	const ownsSessionRef = useRef(ownsSession);
	ownsSessionRef.current = ownsSession;

	useEffect(() => {
		const run = () => reconcilePoppedOutActiveTabs(ownsSessionRef.current);
		const unsubscribeWindows = useTabWindowStore.subscribe((state, prev) => {
			if (state.poppedByAgent !== prev.poppedByAgent) run();
		});
		const unsubscribeSessions = useSessionStore.subscribe((state, prev) => {
			if (state.sessions !== prev.sessions) run();
		});
		run();
		return () => {
			unsubscribeWindows();
			unsubscribeSessions();
		};
	}, []);

	// Ownership moves (an agent moved into this window) can hand this window an
	// agent whose pointer already names a popped tab.
	useEffect(() => {
		reconcilePoppedOutActiveTabs(ownsSession);
	}, [ownsSession]);
}
