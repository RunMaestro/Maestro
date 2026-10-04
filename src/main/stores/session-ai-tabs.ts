/**
 * Pure helpers for removing AI tabs from a stored agent record.
 *
 * Main drops AI tabs from a write in two places - the deferred-content merge
 * (an unloaded browser tab with no stored counterpart) and the closed-tab
 * resurrection guard in `ipc/handlers/persistence.ts` - and both have to leave
 * the record pointing at tabs that still exist.
 */

import type { StoredSession } from './types';

/**
 * Drop the references an agent record holds to AI tabs that are no longer in
 * its `aiTabs`: their slots in `unifiedTabOrder`, and `activeTabId` when it
 * named one of them. The `aiTabs` array itself is the caller's to filter.
 *
 * Tiled groups are left alone: session restoration already normalizes a layout
 * leaf whose tab is gone, on every load.
 */
export function pruneAiTabRefs(
	session: StoredSession,
	removedTabIds: ReadonlySet<string>
): StoredSession {
	if (removedTabIds.size === 0) return session;
	const pruned: StoredSession = { ...session };
	if (Array.isArray(pruned.unifiedTabOrder)) {
		pruned.unifiedTabOrder = pruned.unifiedTabOrder.filter(
			(ref: { type: string; id: string }) => ref.type !== 'ai' || !removedTabIds.has(ref.id)
		);
	}
	if (removedTabIds.has(pruned.activeTabId)) {
		pruned.activeTabId = pruned.aiTabs?.[0]?.id ?? '';
	}
	return pruned;
}

/**
 * The record without the given AI tabs, with every reference to them pruned.
 * Returns the input unchanged when none of them are present.
 */
export function withoutAiTabs(session: StoredSession, tabIds: ReadonlySet<string>): StoredSession {
	const aiTabs: { id: string }[] | undefined = session.aiTabs;
	if (!Array.isArray(aiTabs) || !aiTabs.some((tab) => tabIds.has(tab.id))) return session;
	return pruneAiTabRefs(
		{ ...session, aiTabs: aiTabs.filter((tab) => !tabIds.has(tab.id)) },
		tabIds
	);
}
