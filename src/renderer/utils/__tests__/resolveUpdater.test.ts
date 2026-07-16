import { describe, expect, it, vi } from 'vitest';
import { resolveUpdater } from '../resolveUpdater';

describe('resolveUpdater', () => {
	it('returns a direct value by reference', () => {
		const previous = { id: 'previous' };
		const direct = { id: 'direct' };

		expect(resolveUpdater(direct, previous)).toBe(direct);
	});

	it('invokes an updater exactly once with the previous value', () => {
		const previous = { count: 1 };
		const next = { count: 2 };
		const updater = vi.fn((value: typeof previous) => {
			expect(value).toBe(previous);
			return next;
		});

		expect(resolveUpdater(updater, previous)).toBe(next);
		expect(updater).toHaveBeenCalledTimes(1);
	});

	it('preserves an updater error', () => {
		const error = new Error('updater failed');

		expect(() =>
			resolveUpdater(() => {
				throw error;
			}, 'previous')
		).toThrow(error);
	});
});
