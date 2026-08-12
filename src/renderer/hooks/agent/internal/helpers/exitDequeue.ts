/**
 * Pure decision helper: should the next queued item dequeue when a tab exits?
 *
 * Rule (extracted verbatim from the original onExit logic):
 * - Empty queue → 'none'
 * - Session is in error state with an agentError → 'none'
 * - The next item is `forceParallel` OR `readOnlyMode` OR all *other* tabs are
 *   already idle → 'dequeue' (the caller proceeds to execute it).
 * - Otherwise (a write-mode item with another tab still busy) → 'wait' (the
 *   caller marks the exiting tab idle but keeps the queue intact so the queued
 *   item runs only after the conflicting tab finishes).
 *
 * Output is a single discriminated union so callers don't replicate the rule.
 */

import type { Session, QueuedItem } from '../../../../types';
import { nextRunnableQueueItem } from '../../../../utils/executionQueue';

export type QueueAction = 'dequeue' | 'wait' | 'none';

export interface QueueDecision {
	action: QueueAction;
	item: QueuedItem | null;
}

export function chooseNextQueuedItem(
	session: Pick<Session, 'executionQueue' | 'state' | 'agentError' | 'aiTabs'>,
	exitingTabId: string | undefined
): QueueDecision {
	// Paused items are held by the user - skip them and run the first runnable
	// item. If everything is held (or the queue is empty), there's nothing to do.
	const nextItem = nextRunnableQueueItem(session.executionQueue);
	if (!nextItem) {
		return { action: 'none', item: null };
	}

	if (session.state === 'error' && session.agentError) {
		return { action: 'none', item: null };
	}
	const otherTabsBusy = !!session.aiTabs?.some(
		(tab) => tab.id !== exitingTabId && tab.state === 'busy'
	);

	const isNextItemSafeToRun = nextItem.forceParallel || nextItem.readOnlyMode || !otherTabsBusy;

	if (!isNextItemSafeToRun) {
		return { action: 'wait', item: nextItem };
	}

	return { action: 'dequeue', item: nextItem };
}
