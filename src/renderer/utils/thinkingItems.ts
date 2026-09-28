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
import { getBusyTabs } from './tabHelpers';

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

		// Closed tabs count only while BUSY. A closed tab also stays parked in
		// `orphanedThinkingTabs` (idle) when it still owns queued items, so it
		// survives as a dispatch target: items waiting on another tab, or items the
		// user HELD. No process runs for it, so listing it here would show
		// "Thinking..." (and a Stop button) for a tab that is doing nothing - and a
		// held item parks it indefinitely.
		const busyOrphans = (session.orphanedThinkingTabs ?? []).filter((tab) => tab.state === 'busy');
		if (session.state === 'busy' && session.busySource === 'ai') {
			const busyTabs = getBusyTabs(session);
			for (const tab of busyTabs) {
				items.push({ session, tab });
			}
			// Legacy: the agent is busy but no tab carries the state.
			if (busyTabs.length === 0 && busyOrphans.length === 0) {
				items.push({ session, tab: null });
			}
		}
		// Closed-but-still-thinking tabs stay on the pill until their process
		// exits, independent of the agent-level state. The exit/error listeners
		// remove entries from orphanedThinkingTabs when the underlying process is gone.
		for (const orphan of busyOrphans) {
			items.push({ session, tab: orphan });
		}
	}
	return items;
}
