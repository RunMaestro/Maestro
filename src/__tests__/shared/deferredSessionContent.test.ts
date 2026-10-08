import { describe, it, expect } from 'vitest';
import { mergeDeferredItems } from '../../shared/deferredSessionContent';

type Item = { id?: string; v: number };
const keyOf = (item: Item) => item.id;

describe('mergeDeferredItems', () => {
	it('keeps stored order, replaces matching keys in place, and appends new ones', () => {
		const merged = mergeDeferredItems<Item>(
			[
				{ id: 'a', v: 1 },
				{ id: 'b', v: 1 },
			],
			[
				{ id: 'b', v: 2 },
				{ id: 'c', v: 1 },
			],
			keyOf
		);
		expect(merged).toEqual([
			{ id: 'a', v: 1 },
			{ id: 'b', v: 2 },
			{ id: 'c', v: 1 },
		]);
	});

	it('appends keyless items rather than collapsing them', () => {
		expect(mergeDeferredItems<Item>([{ v: 1 }], [{ v: 2 }], keyOf)).toEqual([{ v: 1 }, { v: 2 }]);
	});

	it('keeps the newest entries when a limit applies', () => {
		const merged = mergeDeferredItems(['a', 'b'], ['c'], (s) => s, 2);
		expect(merged).toEqual(['b', 'c']);
	});

	it('treats missing sides as empty', () => {
		expect(mergeDeferredItems<Item>(undefined, undefined, keyOf)).toEqual([]);
	});
});
