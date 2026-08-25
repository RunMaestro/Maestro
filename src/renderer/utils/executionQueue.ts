/**
 * Helpers for the per-session AI execution queue, centralizing the "skip paused
 * items" rule so every dispatch path treats held items identically.
 *
 * A queued item with `paused: true` is held by the user: it stays in the queue
 * (preserving its position) but is invisible to dispatch. Auto-run, on-exit
 * dequeue, interrupt/kill re-dispatch, batch progression, and the manual
 * "process next" action all run the first *non-paused* item instead of blindly
 * taking index 0, and treat a queue with no runnable items as drained.
 */

import type { QueuedItem, Session, SessionState } from '../types';
import { getTabDisplayName, markTabRunningQueuedItem, resolveQueuedItemTarget } from './tabHelpers';

/** A queued item is runnable when it is not held/paused by the user. */
export function isRunnableQueueItem(item: QueuedItem): boolean {
	return !item.paused;
}

/** The first item that would actually run, or undefined if all are held/empty. */
export function nextRunnableQueueItem(queue: QueuedItem[]): QueuedItem | undefined {
	return queue.find(isRunnableQueueItem);
}

/** Whether the queue has at least one item that would run (not all held). */
export function hasRunnableQueueItem(queue: QueuedItem[]): boolean {
	return queue.some(isRunnableQueueItem);
}

/**
 * Remove the first runnable (non-paused) item from the queue, preserving the
 * order of everything else (including any paused items ahead of it). Returns
 * the dequeued item plus the remaining queue. When nothing is runnable, `item`
 * is null and `remaining` is the queue unchanged.
 */
export function takeNextRunnableQueueItem(queue: QueuedItem[]): {
	item: QueuedItem | null;
	remaining: QueuedItem[];
} {
	const index = queue.findIndex(isRunnableQueueItem);
	if (index === -1) {
		return { item: null, remaining: queue };
	}
	return {
		item: queue[index],
		remaining: [...queue.slice(0, index), ...queue.slice(index + 1)],
	};
}

/**
 * Move a queued item to a new position and return the resulting queue.
 *
 * `fromIndex`/`toIndex` follow Array.splice semantics (remove at fromIndex,
 * insert at toIndex). When `tabId` is given, the indices address only that tab's
 * items as shown in the filtered inline chat list: those items are reordered
 * among themselves and written back to their original slots, so queued items
 * belonging to other tabs keep their absolute positions. Without `tabId` the
 * whole queue is reordered. Out-of-range or no-op moves return the queue
 * unchanged (same reference).
 */
export function reorderQueueItem(
	queue: QueuedItem[],
	fromIndex: number,
	toIndex: number,
	tabId?: string
): QueuedItem[] {
	if (!tabId) {
		const len = queue.length;
		if (
			fromIndex === toIndex ||
			fromIndex < 0 ||
			fromIndex >= len ||
			toIndex < 0 ||
			toIndex >= len
		) {
			return queue;
		}
		const next = [...queue];
		const [removed] = next.splice(fromIndex, 1);
		next.splice(toIndex, 0, removed);
		return next;
	}

	// Tab-scoped reorder: collect this tab's items and the slots they occupy.
	const slots: number[] = [];
	const items: QueuedItem[] = [];
	queue.forEach((item, i) => {
		if (item.tabId === tabId) {
			slots.push(i);
			items.push(item);
		}
	});
	const len = items.length;
	if (fromIndex === toIndex || fromIndex < 0 || fromIndex >= len || toIndex < 0 || toIndex >= len) {
		return queue;
	}
	const reordered = [...items];
	const [removed] = reordered.splice(fromIndex, 1);
	reordered.splice(toIndex, 0, removed);
	const next = [...queue];
	slots.forEach((pos, idx) => {
		next[pos] = reordered[idx];
	});
	return next;
}

/**
 * The label to show for a queued item's target tab.
 *
 * `item.tabName` is a SNAPSHOT frozen when the item was queued, so an item
 * queued into a brand-new tab keeps reading "New" forever - including after
 * auto-naming gave that tab a real title, and even next to a LATER item on the
 * same tab that does carry the name. The queue is exactly where the user decides
 * what to reorder, so two entries for one tab must not look like two tabs.
 *
 * Resolution mirrors {@link resolveQueuedItemTarget}: the live tab first, then a
 * closed-but-still-draining orphan, and only then the snapshot - which by that
 * point is the last thing we ever knew about a tab that is gone.
 */
export function resolveQueuedItemTabName(
	session: Session,
	item: Pick<QueuedItem, 'tabId' | 'tabName'>
): string | undefined {
	if (item.tabId) {
		const tab =
			session.aiTabs?.find((t) => t.id === item.tabId) ??
			session.orphanedThinkingTabs?.find((t) => t.id === item.tabId);
		if (tab) return getTabDisplayName(tab);
	}
	return item.tabName;
}

// ============================================================================
// Force Send - dispatching one specific queued item out of turn
// ============================================================================

/** Minimal identity of a tab that is mid-turn, for Force Send copy. */
export interface BusyTabSummary {
	id: string;
	displayName: string;
}

export interface QueueBusyContext {
	/** The item's own target tab is already running a turn. */
	targetTabBusy: boolean;
	/** Other tabs in the same agent that are mid-turn right now. */
	otherBusyTabs: BusyTabSummary[];
}

/**
 * Busy-state snapshot for one queued item: whether its own tab is mid-turn, and
 * which OTHER tabs of the same agent are. Both Force Send surfaces (the inline
 * chat list and the Execution Queue browser) derive eligibility from this, so
 * they cannot drift on what "safe to send right now" means.
 */
export function getQueueBusyContext(
	session: Session,
	item: Pick<QueuedItem, 'tabId'>
): QueueBusyContext {
	const tabs = session.aiTabs ?? [];
	const targetTab = tabs.find((t) => t.id === item.tabId);
	return {
		targetTabBusy: targetTab?.state === 'busy',
		otherBusyTabs: tabs
			.filter((t) => t.id !== item.tabId && t.state === 'busy')
			.map((t) => ({ id: t.id, displayName: getTabDisplayName(t) })),
	};
}

/** Why a queued item cannot be force sent right now. */
export type ForceSendBlockedReason = 'no-target-tab' | 'target-tab-busy' | 'needs-forced-parallel';

export interface ForceSendEligibility extends QueueBusyContext {
	/** Sending now means running alongside another tab's in-flight turn. */
	requiresParallel: boolean;
	canForce: boolean;
	blockedReason?: ForceSendBlockedReason;
}

/**
 * Whether a queued item can be dispatched out of turn, and what that would mean.
 *
 * A tab runs at most one turn at a time, so an item whose own tab is busy can
 * never be forced. Sending while a *different* tab of the same agent is working
 * breaks the sequential-per-agent rule that keeps two turns off the same files,
 * so that case stays gated behind the Forced Parallel Execution setting. Every
 * other case (jumping the queue order, releasing a held item) is always allowed.
 */
export function getForceSendEligibility(
	session: Session,
	item: Pick<QueuedItem, 'tabId'>,
	opts: { forcedParallelEnabled: boolean }
): ForceSendEligibility {
	const busy = getQueueBusyContext(session, item);
	const requiresParallel = busy.otherBusyTabs.length > 0;
	const blockedReason: ForceSendBlockedReason | undefined = !resolveQueuedItemTarget(session, item)
		? 'no-target-tab'
		: busy.targetTabBusy
			? 'target-tab-busy'
			: requiresParallel && !opts.forcedParallelEnabled
				? 'needs-forced-parallel'
				: undefined;
	return { ...busy, requiresParallel, canForce: !blockedReason, blockedReason };
}

/**
 * The tooltip a Force Send control shows, given its eligibility.
 *
 * Both surfaces that offer Force Send - the Execution Queue modal and the
 * inline QUEUED card in the AI chat - must say the same thing about the same
 * state, so the copy lives with the decision rather than beside each button. A
 * blocked button whose tooltip does not explain the block is just a dead
 * control, which is the failure this whole path is fixing.
 */
export function getForceSendTitle(eligibility: ForceSendEligibility): string {
	const otherBusyCount = eligibility.otherBusyTabs.length;
	switch (eligibility.blockedReason) {
		case 'target-tab-busy':
			return 'This tab is already working - the message runs when the current turn finishes';
		case 'needs-forced-parallel':
			return 'Another tab in this agent is working. Turn on Forced Parallel Execution in Settings to send anyway.';
		case 'no-target-tab':
			return 'This message has no tab left to run on';
		default:
			return eligibility.requiresParallel
				? `Send now, running in parallel with ${otherBusyCount} other working tab${otherBusyCount === 1 ? '' : 's'}`
				: 'Send this message now, ahead of the rest of the queue';
	}
}

/**
 * State transition for dispatching ONE specific queued item now: drop it from the
 * queue, mark its target tab busy (which appends the user-visible log entry), and
 * put the agent in the busy/ai state. Returns the session untouched when the item
 * is already gone or has no tab left to run on.
 *
 * The target is resolved orphan-aware, so an item queued on a since-closed tab
 * still lands on that tab's background transcript rather than the active one.
 */
export function applyQueuedItemDispatch(session: Session, item: QueuedItem): Session {
	if (!session.executionQueue?.some((i) => i.id === item.id)) return session;
	const target = resolveQueuedItemTarget(session, item);
	if (!target) return session;

	const aiTabs = session.aiTabs.map((tab) =>
		tab.id === target.tabId ? markTabRunningQueuedItem(tab, item, session) : tab
	);
	const orphans =
		target.location === 'orphan' && session.orphanedThinkingTabs
			? session.orphanedThinkingTabs.map((tab) =>
					tab.id === target.tabId ? markTabRunningQueuedItem(tab, item, session) : tab
				)
			: session.orphanedThinkingTabs;

	return {
		...session,
		state: 'busy' as SessionState,
		busySource: 'ai',
		thinkingStartTime: Date.now(),
		currentCycleTokens: 0,
		currentCycleBytes: 0,
		executionQueue: session.executionQueue.filter((i) => i.id !== item.id),
		aiTabs,
		...(orphans !== session.orphanedThinkingTabs && { orphanedThinkingTabs: orphans }),
	};
}
