import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCacheCheckpointer } from '../../../main/utils/cache-checkpointer';

describe('createCacheCheckpointer', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('saves at most once per interval', () => {
		const save = vi.fn().mockResolvedValue(undefined);
		const checkpoint = createCacheCheckpointer(save, 1000);

		checkpoint.maybe();
		expect(save).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1000);
		checkpoint.maybe();
		checkpoint.maybe();
		expect(save).toHaveBeenCalledTimes(1);
	});

	it('never starts a second save while one is in flight, and settle waits for it', async () => {
		let finish!: () => void;
		const save = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				})
		);
		const checkpoint = createCacheCheckpointer(save, 1000);

		vi.advanceTimersByTime(1000);
		checkpoint.maybe();
		vi.advanceTimersByTime(5000);
		checkpoint.maybe();
		expect(save).toHaveBeenCalledTimes(1);

		let settled = false;
		const settling = checkpoint.settle().then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		finish();
		await settling;
		expect(settled).toBe(true);
	});

	it('settles immediately when nothing is in flight', async () => {
		const checkpoint = createCacheCheckpointer(vi.fn().mockResolvedValue(undefined));
		await expect(checkpoint.settle()).resolves.toBeUndefined();
	});
});
