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

import type { QueuedItem } from '../types';

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
