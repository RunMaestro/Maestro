/**
 * useWindowScopedActiveSession — keep a window's active agent to one it owns.
 *
 * The store's `activeSessionId` is a single, globally-persisted value, but agent
 * ownership is per-window (see {@link WindowContext}). Every window's renderer
 * restores the SAME persisted `activeSessionId` on startup, so a window that
 * doesn't own that agent would render the "No agents. Create one to get started."
 * empty state even while it actually holds agents (e.g. a restored secondary
 * window stacked on the primary: it owns "Maestro" but the global active agent is
 * "Maestro Marketing", owned by the primary).
 *
 * This reconciler fixes that: when the active agent lives in another window, it
 * repoints THIS window at an agent it owns - the window's remembered active agent
 * if it has one, otherwise its first owned agent. A window that genuinely owns
 * nothing is left alone (its empty state is correct). It also self-heals at
 * runtime: if the active agent is dragged out to another window, the window falls
 * back to one it still owns instead of going blank.
 *
 * Uses {@link SessionStore.hydrateActiveSessionId} (a local set with no disk
 * write) so a window pointing itself at an owned agent never clobbers the
 * globally-persisted active session or fights another window over it. Outside a
 * {@link WindowProvider} (single-window desktop / web / isolation tests) there is
 * no scoping, so the hook is a no-op and behaviour is unchanged.
 */

import { useEffect } from 'react';
import { useWindowContextOptional } from '../../contexts/WindowContext';
import { useSessionStore } from '../../stores/sessionStore';

export function useWindowScopedActiveSession(): void {
	const ctx = useWindowContextOptional();
	const ownsSession = ctx?.ownsSession;
	const scopeActiveSessionId = ctx?.activeSessionId ?? null;
	const sessions = useSessionStore((s) => s.sessions);
	const activeSessionId = useSessionStore((s) => s.activeSessionId);
	const sessionsLoaded = useSessionStore((s) => s.sessionsLoaded);

	useEffect(() => {
		// No window scoping in play: the global active agent is the right one to show.
		if (!ownsSession) return;
		// Wait for the agent list before deciding anything.
		if (!sessionsLoaded) return;
		// Already showing an agent this window owns: nothing to reconcile.
		if (activeSessionId && ownsSession(activeSessionId)) return;
		// The active agent lives in another window. Fall back to an agent THIS window
		// owns; if it owns none, leave the (correct) empty state in place.
		const owned = sessions.filter((s) => ownsSession(s.id));
		if (owned.length === 0) return;
		const next =
			scopeActiveSessionId && owned.some((s) => s.id === scopeActiveSessionId)
				? scopeActiveSessionId
				: owned[0].id;
		if (next && next !== activeSessionId) {
			useSessionStore.getState().hydrateActiveSessionId(next);
		}
	}, [ownsSession, scopeActiveSessionId, sessions, activeSessionId, sessionsLoaded]);
}
