import { describe, it, expect } from 'vitest';
import {
	collectBoundShortcuts,
	countUsedBoundShortcuts,
} from '../../../renderer/constants/keyboardMastery';
import type { Shortcut } from '../../../renderer/types';

function shortcut(id: string, keys: string[]): Shortcut {
	return { id, label: id, keys, category: 'general' } as Shortcut;
}

describe('collectBoundShortcuts', () => {
	it('drops shortcuts with no chord bound', () => {
		const bound = collectBoundShortcuts({
			a: shortcut('a', ['Meta', 'A']),
			b: shortcut('b', []),
		});
		expect(bound.map((s) => s.id)).toEqual(['a']);
	});

	it('lets a later map override an earlier one by id', () => {
		const bound = collectBoundShortcuts(
			{ a: shortcut('a', ['Meta', 'A']) },
			{ a: shortcut('a', []) }
		);
		expect(bound).toEqual([]);
	});

	it('ignores undefined maps', () => {
		const bound = collectBoundShortcuts(undefined, { a: shortcut('a', ['Meta', 'A']) });
		expect(bound.map((s) => s.id)).toEqual(['a']);
	});
});

describe('countUsedBoundShortcuts', () => {
	const bound = [shortcut('a', ['Meta', 'A']), shortcut('b', ['Meta', 'B'])];

	it('counts only the used ones', () => {
		expect(countUsedBoundShortcuts(bound, ['a'])).toBe(1);
	});

	it('ignores used ids that are no longer bound, so it cannot exceed the total', () => {
		expect(countUsedBoundShortcuts(bound, ['a', 'b', 'retired', 'unbound'])).toBe(2);
	});
});
