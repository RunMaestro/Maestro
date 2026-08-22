/**
 * Pure decision helper: should the next queued item dequeue when a tab exits?
 *
 * Rule (extracted verbatim from the original onExit logic):
 * - Empty queue → 'none'
 * - Session is in error state with an agentError → 'none'
 * - Agent Resilience has a retry counting down for the exiting tab → 'wait'
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
	exitingTabId: string | undefined,
	/**
	 * Agent Resilience has a retry counting down for the exiting tab (see
	 * `retryStore.hasPendingRetry`). Passed in rather than read off the session
	 * so this helper stays pure.
	 */
	retryPending = false
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

	// A pending retry means the provider just refused this turn and we are
	// waiting it out. Draining the queue into it would fail every queued item
	// against the same wall - and worse, each dispatch supersedes the previous
	// item's scheduled retry (see `retryStore.noteDispatch`), so a queue of N
	// messages would silently discard the first N-1 prompts. Hold the queue; it
	// drains in order once the retry lands.
	if (retryPending) {
		return { action: 'wait', item: nextItem };
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
