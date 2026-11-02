import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	checkPathExists,
	pathExistenceKey,
	resetPathExistenceCache,
	subscribePathExistence,
} from '../../../../renderer/utils/fileLinks/pathExistence';

const stat = () => vi.mocked(window.maestro.fs.stat);

/** Lets queued stat promises and their follow-ups settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('pathExistence', () => {
	beforeEach(() => {
		resetPathExistenceCache();
		stat().mockReset();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('answers undefined, checks in the background, then answers from the cache', async () => {
		stat().mockResolvedValue({ isFile: true });
		const landed = vi.fn();
		const unsubscribe = subscribePathExistence(landed);

		expect(checkPathExists('/Volumes/My Drive/a.md')).toBeUndefined();
		await flush();

		expect(landed).toHaveBeenCalledWith(pathExistenceKey('/Volumes/My Drive/a.md'));
		expect(checkPathExists('/Volumes/My Drive/a.md')).toBe(true);
		expect(stat()).toHaveBeenCalledTimes(1);
		unsubscribe();
	});

	it('asks once for a path requested repeatedly while in flight', async () => {
		stat().mockResolvedValue({ isFile: true });
		checkPathExists('/a b/c.md');
		checkPathExists('/a b/c.md');
		checkPathExists('/a b/c.md');
		await flush();
		expect(stat()).toHaveBeenCalledTimes(1);
	});

	it.each([
		['a missing path', () => stat().mockResolvedValue(null)],
		['a stat that fails', () => stat().mockRejectedValue(new Error('ENAMETOOLONG'))],
	])('answers no for %s', async (_label, arrange) => {
		arrange();
		checkPathExists('/a b/c.md');
		await flush();
		expect(checkPathExists('/a b/c.md')).toBe(false);
	});

	it('keys answers by SSH remote', async () => {
		stat().mockImplementation(async (_path: string, remote?: string) =>
			remote === 'host-1' ? { isFile: true } : null
		);
		checkPathExists('/a b/c.md');
		checkPathExists('/a b/c.md', 'host-1');
		await flush();
		expect(stat()).toHaveBeenCalledWith('/a b/c.md', 'host-1');
		expect(checkPathExists('/a b/c.md')).toBe(false);
		expect(checkPathExists('/a b/c.md', 'host-1')).toBe(true);
	});

	it('re-checks a stale "no" while still answering no', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		stat().mockResolvedValue(null);
		checkPathExists('/a b/c.md');
		await flush();
		expect(stat()).toHaveBeenCalledTimes(1);

		vi.setSystemTime(Date.now() + 60_000);
		stat().mockResolvedValue({ isFile: true });
		expect(checkPathExists('/a b/c.md')).toBe(false);
		await flush();
		expect(stat()).toHaveBeenCalledTimes(2);
		expect(checkPathExists('/a b/c.md')).toBe(true);
	});

	it('keeps at most four checks in flight', async () => {
		const resolvers: Array<(value: unknown) => void> = [];
		stat().mockImplementation(() => new Promise((resolve) => resolvers.push(resolve)));
		for (let i = 0; i < 6; i++) checkPathExists(`/a b/${i}.md`);
		expect(stat()).toHaveBeenCalledTimes(4);

		resolvers[0]({ isFile: true });
		await flush();
		expect(stat()).toHaveBeenCalledTimes(5);
	});
});
