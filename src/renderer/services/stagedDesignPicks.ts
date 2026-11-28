/**
 * Read, edit and remove the Design Mode chips staged on an AI tab, by id,
 * from the live session store.
 *
 * These live apart from `designModePick.ts` on purpose: the send path
 * (`useInputProcessing`) needs them, and `agentStore` imports that hook, so
 * anything this module imports joins the import graph of every store. Keep it
 * to the session store and types; `designModePick.ts` (which reaches the
 * composer, navigation and modal stores) builds on top of it.
 */

import { updateAiTab, useSessionStore } from '../stores/sessionStore';
import type { StagedDesignPick } from '../types';

/**
 * The chips staged on `sessionId`'s AI tab `tabId`, in order, from the live
 * store rather than a render-time snapshot. Empty when there are none or the
 * tab is gone.
 */
export function getStagedDesignPicks(sessionId: string, tabId: string): StagedDesignPick[] {
	const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
	return session?.aiTabs.find((t) => t.id === tabId)?.stagedDesignPicks ?? [];
}

/** The chip `pickId` on `sessionId`'s AI tab `tabId`, from the live store. */
function findStagedDesignPick(
	sessionId: string,
	tabId: string,
	pickId: string
): StagedDesignPick | undefined {
	return getStagedDesignPicks(sessionId, tabId).find((p) => p.id === pickId);
}

/**
 * Replace the note on one staged chip, trimmed the way a delivered note is.
 * Writes nothing when the note is unchanged. Returns false when the chip is
 * not on that tab (it was sent or removed meanwhile).
 */
export function setStagedDesignPickNote(
	sessionId: string,
	tabId: string,
	pickId: string,
	note: string
): boolean {
	const pick = findStagedDesignPick(sessionId, tabId, pickId);
	if (!pick) return false;
	const trimmed = note.trim();
	if (trimmed === pick.note) return true;
	updateAiTab(sessionId, tabId, (tab) => ({
		...tab,
		stagedDesignPicks: (tab.stagedDesignPicks ?? []).map((p) =>
			p.id === pickId ? { ...p, note: trimmed } : p
		),
	}));
	return true;
}

/**
 * Take staged chips off their tab by id, screenshots and all: the chips a
 * sent message expanded, or one the user removed. Chips with other ids stay,
 * so one staged after a send read its chips is left for the next message.
 * Returns how many were taken; 0 writes nothing.
 */
export function removeStagedDesignPicks(
	sessionId: string,
	tabId: string,
	pickIds: readonly string[]
): number {
	const ids = new Set(pickIds);
	const taken = getStagedDesignPicks(sessionId, tabId).filter((p) => ids.has(p.id)).length;
	if (taken === 0) return 0;
	updateAiTab(sessionId, tabId, (tab) => ({
		...tab,
		stagedDesignPicks: (tab.stagedDesignPicks ?? []).filter((p) => !ids.has(p.id)),
	}));
	return taken;
}

/**
 * Take one staged chip off its tab, screenshot and all. Returns false when the
 * chip is not on that tab.
 */
export function removeStagedDesignPick(sessionId: string, tabId: string, pickId: string): boolean {
	return removeStagedDesignPicks(sessionId, tabId, [pickId]) > 0;
}
