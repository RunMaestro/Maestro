/**
 * Thinking-item construction for the ThinkingStatusPill.
 *
 * A "thinking item" is one (session, tab) pair representing a single busy AI
 * tab. The pill renders one entry per busy tab across the agents it should
 * surface, plus closed-but-still-thinking ("orphaned") tabs that are kept on the
 * pill until the underlying process actually exits.
 *
 * Multi-window scoping: the main process BROADCASTS every agent's state to every
 * window (see the MULTI-WINDOW INVARIANT in `safe-send.ts`), so each renderer's
 * session store holds ALL agents regardless of which window owns them. Pass
 * `ownsSession` (from `WindowContext.ownsSession`) to drop agents whose tab strip
 * lives in another window - otherwise a window's pill would surface another
 * window's running/AutoRun agent. Omit it (single-window app / web / isolation
 * tests, where there is no WindowProvider) to include every session unchanged.
 */

import type { Session, ThinkingItem } from '../types';

/**
 * Build the flat list of thinking items that drives the ThinkingStatusPill.
 *
 * @param sessions All agents known to this renderer.
 * @param ownsSession Optional ownership predicate; when provided, only agents it
 *   accepts contribute thinking items (window scoping). When omitted, every
 *   session is included.
 */
export function buildThinkingItems(
	sessions: Session[],
	ownsSession?: (sessionId: string) => boolean
): ThinkingItem[] {
	const items: ThinkingItem[] = [];
	for (const session of sessions) {
		// Multi-window: skip agents whose tab strip lives in another window so this
		// window's pill never surfaces an agent it does not own.
		if (ownsSession && !ownsSession(session.id)) continue;

		if (session.state === 'busy' && session.busySource === 'ai') {
			const busyTabs = session.aiTabs?.filter((t) => t.state === 'busy');
			if (busyTabs && busyTabs.length > 0) {
				for (const tab of busyTabs) {
					items.push({ session, tab });
				}
			} else if (!session.orphanedThinkingTabs?.length) {
				// Legacy: session is busy but no individual tab-level tracking.
				items.push({ session, tab: null });
			}
		}
		// Closed-but-still-thinking tabs: keep showing them on the pill until the
		// agent process actually exits. The exit/error listeners remove entries from
		// orphanedThinkingTabs when the underlying process is gone.
		for (const orphan of session.orphanedThinkingTabs ?? []) {
			items.push({ session, tab: orphan });
		}
	}
	return items;
}
