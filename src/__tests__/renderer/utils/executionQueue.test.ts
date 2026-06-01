import { describe, it, expect } from 'vitest';
import {
	isRunnableQueueItem,
	nextRunnableQueueItem,
	hasRunnableQueueItem,
	takeNextRunnableQueueItem,
} from '../../../renderer/utils/executionQueue';
import type { QueuedItem } from '../../../renderer/types';

function item(id: string, paused = false): QueuedItem {
	return { id, timestamp: 0, tabId: 'tab-1', type: 'message', text: id, paused };
}

describe('executionQueue helpers', () => {
	it('isRunnableQueueItem treats only non-paused items as runnable', () => {
		expect(isRunnableQueueItem(item('a'))).toBe(true);
		expect(isRunnableQueueItem(item('b', true))).toBe(false);
	});

	it('nextRunnableQueueItem returns the first non-paused item', () => {
		const q = [item('a', true), item('b'), item('c')];
		expect(nextRunnableQueueItem(q)?.id).toBe('b');
		expect(nextRunnableQueueItem([item('a', true)])).toBeUndefined();
		expect(nextRunnableQueueItem([])).toBeUndefined();
	});

	it('hasRunnableQueueItem reflects whether any item can run', () => {
		expect(hasRunnableQueueItem([item('a', true), item('b')])).toBe(true);
		expect(hasRunnableQueueItem([item('a', true), item('b', true)])).toBe(false);
		expect(hasRunnableQueueItem([])).toBe(false);
	});

	it('takeNextRunnableQueueItem removes the first runnable item, preserving order of the rest', () => {
		const q = [item('a', true), item('b'), item('c')];
		const { item: taken, remaining } = takeNextRunnableQueueItem(q);
		expect(taken?.id).toBe('b');
		// The paused item ahead of it stays in place; 'c' keeps its order.
		expect(remaining.map((i) => i.id)).toEqual(['a', 'c']);
	});

	it('takeNextRunnableQueueItem returns null + unchanged queue when all items are paused', () => {
		const q = [item('a', true), item('b', true)];
		const { item: taken, remaining } = takeNextRunnableQueueItem(q);
		expect(taken).toBeNull();
		expect(remaining).toBe(q);
	});
});
