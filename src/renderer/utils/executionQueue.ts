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
