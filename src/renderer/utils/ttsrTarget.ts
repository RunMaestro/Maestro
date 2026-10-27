/** Resolve a TTSR push to its existing AI tab, including forced-parallel IDs. */
import type { AITab, Session } from '../types';
import { parseSessionId } from './sessionIdParser';

export interface TtsrTarget {
	session: Session;
	tab: AITab;
}

/**
 * Find the agent + tab a TTSR push payload belongs to.
 *
 * Goes through the shared session-id parser so the forced-parallel `-fp-<ts>`
 * suffix is handled the same way every other listener handles it. Returns null
 * when the tab is gone (session closed while the abort was in flight).
 *
 * Takes the id structurally rather than a whole `ttsr:triggered` payload: the
 * `ttsr:matched` listener resolves the same way, and only `sessionId` is read.
 */
export function resolveTtsrTarget(
	sessions: Session[],
	payload: { sessionId: string }
): TtsrTarget | null {
	const parsed = parseSessionId(payload.sessionId);
	if (parsed.type !== 'ai-tab' || !parsed.tabId) return null;

	const session = sessions.find((candidate) => candidate.id === parsed.actualSessionId);
	const tab = session?.aiTabs?.find((candidate) => candidate.id === parsed.tabId);
	return session && tab ? { session, tab } : null;
}
