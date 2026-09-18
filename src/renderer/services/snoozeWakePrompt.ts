/**
 * snoozeWakePrompt - run a snooze's wake prompt the instant its tab is back.
 *
 * A snooze can carry a prompt as well as a note. The note tells the USER why
 * they came back; the prompt tells the AGENT to get started without them. The
 * two are independent, and a snooze may carry either, both, or neither.
 *
 * It fires on both ways a tab returns - the scheduler's wake and an early
 * "Unsnooze now" - because the user wrote the prompt against the tab COMING
 * BACK, not against the clock. A dismissed snooze restores nothing, so nothing
 * is dispatched there.
 *
 * The prompt goes through the execution queue rather than straight to a spawn.
 * That is what makes it safe to call in the same tick the tab was restored in:
 * the queue re-resolves its target at drain time, so it does not depend on
 * React having re-rendered, and an agent that is already mid-turn finishes that
 * turn first instead of having the wake refused.
 */

import type { SnoozedGroupMember, SnoozedTabEntry } from '../types';
import { resolveWakePromptTabId } from '../utils/snoozeHelpers';
import { enqueuePromptForTab } from './queuedPrompt';
import { logger } from '../utils/logger';

/**
 * Dispatch `entry.wakePrompt` into the tab that just came back.
 *
 * @param sessionId - Agent that owns the restored tab
 * @param entry - The snooze that resolved
 * @param restoredTabId - Tab the wake landed on
 * @param isMemberRestored - For a parked group, whether that pane came back
 * @returns True when a prompt was queued.
 */
export function runSnoozeWakePrompt(
	sessionId: string,
	entry: SnoozedTabEntry,
	restoredTabId: string,
	isMemberRestored?: (member: SnoozedGroupMember) => boolean
): boolean {
	const prompt = entry.wakePrompt?.trim();
	if (!prompt) return false;

	const tabId = resolveWakePromptTabId(entry, restoredTabId, isMemberRestored);
	if (!tabId) {
		// Reachable when a group's only AI pane was dropped on the way back (its
		// file is gone). Worth a line: the user asked for a turn that will not
		// happen, and silence here looks like the prompt was never saved.
		logger.info(
			`[snooze] wake prompt for ${entry.id} has no AI tab to run in - skipping`,
			undefined,
			{ sessionId, type: entry.type }
		);
		return false;
	}

	const item = enqueuePromptForTab({ sessionId, tabId, text: prompt });
	if (!item) {
		logger.warn(`[snooze] wake prompt for ${entry.id} could not be queued`, undefined, {
			sessionId,
			tabId,
		});
		return false;
	}

	logger.info(`[snooze] queued wake prompt for ${entry.id} on tab ${tabId}`);
	return true;
}

/**
 * `runSnoozeWakePrompt` for a wake that already knows which group panes were
 * dropped. Convenience over the predicate form so the scheduler does not build
 * a membership set for the common single-tab case.
 */
export function runSnoozeWakePromptAfterGroupWake(
	sessionId: string,
	entry: SnoozedTabEntry,
	restoredTabId: string,
	droppedMembers: SnoozedGroupMember[]
): boolean {
	const droppedTabIds = new Set(droppedMembers.map((member) => member.tab.id));
	return runSnoozeWakePrompt(
		sessionId,
		entry,
		restoredTabId,
		(member) => !droppedTabIds.has(member.tab.id)
	);
}
