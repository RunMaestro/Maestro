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

/**
 * Is the execution queue frozen by an Agent Resilience retry?
 *
 * A pending retry means the provider just refused a turn and we are waiting out
 * its quota/backoff. Dispatching into that wall is wrong two ways: the item
 * fails against the same limit, AND the dispatch supersedes the pending retry
 * (see `retryStore.noteDispatch`), silently discarding the prompt that retry was
 * holding. So the queue holds and drains in order once the retry lands.
 *
 * Checks BOTH tabs, because they can differ:
 *  - the EXITING tab, whose outage means this agent's provider is refusing work
 *    right now, so the next item would just burn a call rediscovering the wall;
 *  - the queued item's OWN target tab, which may be a different tab sitting in
 *    its own outage. Dispatching there supersedes THAT tab's retry and loses its
 *    prompt - the exiting tab finishing cleanly says nothing about whether the
 *    target tab is ready.
 *
 * Exported so the onExit reducer applies the identical rule rather than
 * re-deriving it: if the two disagree, a tab is marked busy for a spawn that
 * never happens (or an item dequeues with nothing running it).
 */
export function queueIsHeldByRetry(
	session: Pick<Session, 'executionQueue'> | undefined,
	exitingTabId: string | undefined,
	isRetryPending: (tabId: string) => boolean
): boolean {
	if (exitingTabId && isRetryPending(exitingTabId)) return true;
	const nextItem = session ? nextRunnableQueueItem(session.executionQueue) : undefined;
	return !!nextItem?.tabId && isRetryPending(nextItem.tabId);
}

export function chooseNextQueuedItem(
	session: Pick<Session, 'executionQueue' | 'state' | 'agentError' | 'aiTabs'>,
	exitingTabId: string | undefined,
	/**
	 * Does this tab have an Agent Resilience retry counting down? (see
	 * `retryStore.hasPendingRetry`). Injected as a predicate rather than read off
	 * the session so this helper stays pure - and so it can be asked about BOTH
	 * the exiting tab and the queued item's own target tab, which are not always
	 * the same tab.
	 */
	isRetryPending: (tabId: string) => boolean = () => false
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

	// Agent Resilience holds the queue while a retry is counting down; see
	// queueIsHeldByRetry above for which tabs it checks and why.
	if (queueIsHeldByRetry(session, exitingTabId, isRetryPending)) {
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
