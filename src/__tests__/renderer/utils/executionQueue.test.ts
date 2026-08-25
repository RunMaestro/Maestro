import { describe, it, expect } from 'vitest';
import {
	isRunnableQueueItem,
	nextRunnableQueueItem,
	hasRunnableQueueItem,
	takeNextRunnableQueueItem,
	reorderQueueItem,
	resolveQueuedItemTabName,
} from '../../../renderer/utils/executionQueue';
import type { AITab, QueuedItem, Session } from '../../../renderer/types';

function item(id: string, paused = false): QueuedItem {
	return { id, timestamp: 0, tabId: 'tab-1', type: 'message', text: id, paused };
}

function tabItem(id: string, tabId: string): QueuedItem {
	return { id, timestamp: 0, tabId, type: 'message', text: id };
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

describe('reorderQueueItem', () => {
	it('moves an item within the whole queue when no tabId is given', () => {
		const q = [item('a'), item('b'), item('c')];
		expect(reorderQueueItem(q, 0, 2).map((i) => i.id)).toEqual(['b', 'c', 'a']);
		expect(reorderQueueItem(q, 2, 0).map((i) => i.id)).toEqual(['c', 'a', 'b']);
	});

	it('returns the same queue reference for no-op or out-of-range moves', () => {
		const q = [item('a'), item('b')];
		expect(reorderQueueItem(q, 1, 1)).toBe(q);
		expect(reorderQueueItem(q, -1, 0)).toBe(q);
		expect(reorderQueueItem(q, 0, 5)).toBe(q);
	});

	it('reorders only the target tab and keeps other tabs in their absolute slots', () => {
		// Interleaved: tab-1 at slots 0 and 2, tab-2 at slot 1.
		const q = [tabItem('a', 'tab-1'), tabItem('x', 'tab-2'), tabItem('c', 'tab-1')];
		// In tab-1's filtered view [a, c], move a (0) after c (1).
		const result = reorderQueueItem(q, 0, 1, 'tab-1');
		// tab-1 items become [c, a] back in slots 0 and 2; tab-2 'x' stays at slot 1.
		expect(result.map((i) => i.id)).toEqual(['c', 'x', 'a']);
	});

	it('treats tab-scoped indices as positions within that tab only', () => {
		const q = [
			tabItem('a', 'tab-1'),
			tabItem('b', 'tab-1'),
			tabItem('x', 'tab-2'),
			tabItem('c', 'tab-1'),
		];
		// tab-1 filtered view [a, b, c]; move c (index 2) to front (index 0).
		const result = reorderQueueItem(q, 2, 0, 'tab-1');
		expect(result.map((i) => i.id)).toEqual(['c', 'a', 'x', 'b']);
	});

	it('returns the same queue reference for out-of-range tab-scoped moves', () => {
		const q = [tabItem('a', 'tab-1'), tabItem('x', 'tab-2')];
		// tab-1 has only one item, so index 1 is out of range for its view.
		expect(reorderQueueItem(q, 0, 1, 'tab-1')).toBe(q);
	});
});

describe('resolveQueuedItemTabName', () => {
	const tab = (id: string, name?: string) => ({ id, name, state: 'idle' }) as unknown as AITab;
	const session = (tabs: AITab[], orphans: AITab[] = []) =>
		({ aiTabs: tabs, orphanedThinkingTabs: orphans }) as unknown as Session;

	it('prefers the live tab name over the snapshot taken when the item was queued', () => {
		const queued = { tabId: 'tab-1', tabName: 'New' };
		expect(resolveQueuedItemTabName(session([tab('tab-1', 'PR #1427')]), queued)).toBe('PR #1427');
	});

	it('gives two items on the same tab the same label once that tab is named', () => {
		const s = session([tab('tab-1', 'PR #1427')]);
		const first = { tabId: 'tab-1', tabName: 'New' };
		const second = { tabId: 'tab-1', tabName: 'PR #1427' };
		expect(resolveQueuedItemTabName(s, first)).toBe(resolveQueuedItemTabName(s, second));
	});

	it('falls back to an orphaned (closed but draining) tab before the snapshot', () => {
		const s = session([], [tab('tab-9', 'Draining Tab')]);
		expect(resolveQueuedItemTabName(s, { tabId: 'tab-9', tabName: 'Stale' })).toBe('Draining Tab');
	});

	it('falls back to the snapshot when the tab is gone entirely', () => {
		expect(resolveQueuedItemTabName(session([]), { tabId: 'gone', tabName: 'Old Name' })).toBe(
			'Old Name'
		);
	});
});
