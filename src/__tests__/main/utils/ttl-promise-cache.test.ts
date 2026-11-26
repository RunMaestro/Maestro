import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTtlPromiseCache } from '../../../main/utils/ttl-promise-cache';

describe('createTtlPromiseCache', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('shares one load between concurrent callers and keeps it for the window', async () => {
		vi.useFakeTimers();
		const cache = createTtlPromiseCache<number>(1000);
		const load = vi.fn(async () => 7);

		const [a, b] = await Promise.all([cache.get('k', load), cache.get('k', load)]);
		expect([a, b]).toEqual([7, 7]);
		await cache.get('k', load);
		expect(load).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(1000);
		await cache.get('k', load);
		expect(load).toHaveBeenCalledTimes(2);
	});

	it('drops a result keep() rejects, and a rejected load, so the next caller tries again', async () => {
		const cache = createTtlPromiseCache<number | null>(60_000, (value) => value !== null);
		const failing = vi.fn(async () => null);
		expect(await cache.get('k', failing)).toBeNull();
		expect(await cache.get('k', failing)).toBeNull();
		expect(failing).toHaveBeenCalledTimes(2);

		const throwing = vi.fn(async (): Promise<number | null> => {
			throw new Error('down');
		});
		await expect(cache.get('t', throwing)).rejects.toThrow('down');
		await expect(cache.get('t', throwing)).rejects.toThrow('down');
		expect(throwing).toHaveBeenCalledTimes(2);
	});

	it('keeps a failure for failureTtlMs from when it settled, then tries again', async () => {
		vi.useFakeTimers();
		const cache = createTtlPromiseCache<number | null>(60_000, (value) => value !== null, {
			failureTtlMs: 1000,
		});
		const failing = vi.fn(async () => null);
		expect(await cache.get('k', failing)).toBeNull();
		vi.advanceTimersByTime(999);
		expect(await cache.get('k', failing)).toBeNull();
		expect(failing).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(1);
		await cache.get('k', failing);
		expect(failing).toHaveBeenCalledTimes(2);

		const throwing = vi.fn(async (): Promise<number | null> => {
			throw new Error('down');
		});
		await expect(cache.get('t', throwing)).rejects.toThrow('down');
		await expect(cache.get('t', throwing)).rejects.toThrow('down');
		expect(throwing).toHaveBeenCalledTimes(1);
	});

	it('keeps keys apart', async () => {
		const cache = createTtlPromiseCache<string>(60_000);
		expect(await cache.get('a', async () => 'A')).toBe('A');
		expect(await cache.get('b', async () => 'B')).toBe('B');
		expect(await cache.get('a', async () => 'other')).toBe('A');
	});
});
