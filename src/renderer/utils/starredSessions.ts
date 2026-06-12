/**
 * starredSessions.ts - shared helpers for persisting a tab's starred state and
 * broadcasting star changes so views that cache starred sessions (the Left Bar
 * "Starred Sessions" section) can refresh immediately.
 *
 * Why a bus: the Left Bar loads closed/named starred sessions from disk into a
 * local cache. Without a signal, that cache only refreshed when the agent count
 * changed, so starring/unstarring an open tab left a stale closed twin behind.
 * Every place that toggles a star calls persistTabStarred (or, for closed
 * sessions, notifyStarredSessionsChanged directly) so the cache stays in sync.
 */

import type { Session, AITab } from '../types';
import { captureException } from './sentry';

/** Window event fired whenever any session's starred state changes. */
const STARRED_CHANGED_EVENT = 'maestro:starredSessionsChanged';

/** Broadcast that a session's starred state changed (after the disk write resolves). */
export function notifyStarredSessionsChanged(): void {
	if (typeof window === 'undefined') return;
	window.dispatchEvent(new CustomEvent(STARRED_CHANGED_EVENT));
}

/** Subscribe to star changes. Returns an unsubscribe function. */
export function onStarredSessionsChanged(handler: () => void): () => void {
	if (typeof window === 'undefined') return () => {};
	const listener = () => handler();
	window.addEventListener(STARRED_CHANGED_EVENT, listener);
	return () => window.removeEventListener(STARRED_CHANGED_EVENT, listener);
}

/**
 * Persist a tab's starred state to its provider's session storage and notify
 * listeners once the write resolves. Centralizes the claude-vs-generic branch
 * that was duplicated across the desktop toggle, the tab context menu, and the
 * remote (web) handler. No-op when the tab has no agentSessionId.
 */
export function persistTabStarred(session: Session, tab: AITab, starred: boolean): void {
	if (!tab.agentSessionId) return;
	const agentId = session.toolType || 'claude-code';
	const persist =
		agentId === 'claude-code'
			? window.maestro.claude.updateSessionStarred(session.projectRoot, tab.agentSessionId, starred)
			: window.maestro.agentSessions.setSessionStarred(
					agentId,
					session.projectRoot,
					tab.agentSessionId,
					starred
				);

	persist
		.then(() => notifyStarredSessionsChanged())
		.catch((err) => {
			captureException(err, {
				extra: {
					sessionId: session.id,
					agentSessionId: tab.agentSessionId,
					agentType: agentId,
					operation: 'persist-tab-starred',
				},
			});
		});
}
