/**
 * Helpers for the AI chat "Find" bar, whose state is scoped per agent+AI-tab in
 * uiStore (`outputSearchByKey`). The key identifies one chat window so a search
 * opened in one agent/tab doesn't leak its open flag or term into others.
 *
 * This module imports both stores but neither store imports it, so it stays a
 * leaf and avoids the uiStore <-> sessionStore cycle.
 */
import { selectActiveSession, useSessionStore } from '../stores/sessionStore';
import { useUIStore } from '../stores/uiStore';

/** Build the per-window key for a given agent + active AI tab. */
export function outputSearchKeyFor(sessionId: string, tabId: string | null | undefined): string {
	return `${sessionId}::${tabId ?? ''}`;
}

/** Key for the currently active agent+tab, or null when there's no active agent. */
export function getActiveOutputSearchKey(): string | null {
	const session = selectActiveSession(useSessionStore.getState());
	return session ? outputSearchKeyFor(session.id, session.activeTabId) : null;
}

/** Whether the Find bar is open for the currently active chat window. */
export function isActiveOutputSearchOpen(): boolean {
	const key = getActiveOutputSearchKey();
	if (!key) return false;
	return useUIStore.getState().outputSearchByKey[key]?.open ?? false;
}
