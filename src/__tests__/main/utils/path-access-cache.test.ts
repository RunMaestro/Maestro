/**
 * Tests for {@link PathAccessCache} - short-TTL cache over a boolean
 * file-access predicate. Used by the SSH modules to avoid re-stat'ing the
 * same identity files on rapid retries.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	PathAccessCache,
	DEFAULT_PATH_ACCESS_TTL_MS,
	getPathAccessCache,
	setPathAccessCacheForTest,
	defaultReadableProbe,
} from '../../../main/utils/path-access-cache';

describe('PathAccessCache', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		// Anchor fake clock to a real-ish timestamp so Date.now() math is sane.
		vi.setSystemTime(new Date('2026-05-04T00:00:00Z'));
	});

	afterEach(() => {
		vi.useRealTimers();
		setPathAccessCacheForTest(null);
	});

	it('first call invokes accessFn and caches true result', () => {
		const cache = new PathAccessCache(30_000);
		const accessFn = vi.fn().mockReturnValue(true);

		const result = cache.check('/path/to/key', accessFn);

		expect(result).toBe(true);
		expect(accessFn).toHaveBeenCalledTimes(1);
		expect(accessFn).toHaveBeenCalledWith('/path/to/key');
	});

	it('second call within TTL returns cached true without invoking accessFn', () => {
		const cache = new PathAccessCache(30_000);
		const accessFn = vi.fn().mockReturnValue(true);

		cache.check('/path/to/key', accessFn);
		vi.advanceTimersByTime(15_000); // Within TTL window
		const result = cache.check('/path/to/key', accessFn);

		expect(result).toBe(true);
		expect(accessFn).toHaveBeenCalledTimes(1);
	});

	it('call after TTL expiry re-invokes accessFn', () => {
		const cache = new PathAccessCache(30_000);
		const accessFn = vi.fn().mockReturnValue(true);

		cache.check('/path/to/key', accessFn);
		vi.advanceTimersByTime(31_000); // Past TTL
		cache.check('/path/to/key', accessFn);

		expect(accessFn).toHaveBeenCalledTimes(2);
	});

	it('different paths are cached independently', () => {
		const cache = new PathAccessCache(30_000);
		const accessFn = vi.fn().mockReturnValue(true);

		cache.check('/path/a', accessFn);
		cache.check('/path/b', accessFn);
		cache.check('/path/a', accessFn);
		cache.check('/path/b', accessFn);

		// Each path checked once on first call, hit cache on second
		expect(accessFn).toHaveBeenCalledTimes(2);
		expect(accessFn).toHaveBeenCalledWith('/path/a');
		expect(accessFn).toHaveBeenCalledWith('/path/b');
	});

	it('false results are NOT cached - re-invokes accessFn on second call', () => {
		const cache = new PathAccessCache(30_000);
		const accessFn = vi.fn().mockReturnValue(false);

		const first = cache.check('/missing/key', accessFn);
		const second = cache.check('/missing/key', accessFn);

		expect(first).toBe(false);
		expect(second).toBe(false);
		expect(accessFn).toHaveBeenCalledTimes(2);
	});

	it('a previously-true path that becomes false drops the cache entry', () => {
		const cache = new PathAccessCache(30_000);
		const accessFn = vi
			.fn()
			.mockReturnValueOnce(true) // First check: file exists
			.mockReturnValueOnce(false) // Second (after TTL): user removed it
			.mockReturnValueOnce(false); // Third (immediate): must NOT see stale true

		cache.check('/path/to/key', accessFn);
		vi.advanceTimersByTime(31_000); // Past TTL
		const second = cache.check('/path/to/key', accessFn);
		// Immediately retry - must re-invoke (false isn't cached)
		const third = cache.check('/path/to/key', accessFn);

		expect(second).toBe(false);
		expect(third).toBe(false);
		expect(accessFn).toHaveBeenCalledTimes(3);
	});

	it('clear() resets the cache; subsequent calls re-invoke accessFn', () => {
		const cache = new PathAccessCache(30_000);
		const accessFn = vi.fn().mockReturnValue(true);

		cache.check('/path/to/key', accessFn);
		cache.clear();
		cache.check('/path/to/key', accessFn);

		expect(accessFn).toHaveBeenCalledTimes(2);
	});

	it('default TTL constant matches the documented 30s window', () => {
		expect(DEFAULT_PATH_ACCESS_TTL_MS).toBe(30_000);
	});
});

describe('getPathAccessCache singleton', () => {
	afterEach(() => {
		setPathAccessCacheForTest(null);
	});

	it('returns the same instance across calls', () => {
		const a = getPathAccessCache();
		const b = getPathAccessCache();
		expect(a).toBe(b);
	});

	it('setPathAccessCacheForTest(null) drops the singleton so the next get rebuilds', () => {
		const a = getPathAccessCache();
		setPathAccessCacheForTest(null);
		const b = getPathAccessCache();
		expect(a).not.toBe(b);
	});

	it('setPathAccessCacheForTest(custom) installs the test cache', () => {
		const custom = new PathAccessCache(1_000);
		setPathAccessCacheForTest(custom);
		expect(getPathAccessCache()).toBe(custom);
	});
});

describe('defaultReadableProbe', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-probe-test-'));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it('returns true for a readable file', () => {
		const filePath = path.join(tempDir, 'readable.txt');
		fs.writeFileSync(filePath, 'hello');
		expect(defaultReadableProbe(filePath)).toBe(true);
	});

	it('returns false for a missing path (ENOENT swallowed)', () => {
		const filePath = path.join(tempDir, 'does-not-exist.txt');
		expect(defaultReadableProbe(filePath)).toBe(false);
	});

	it('returns true for a readable directory (R_OK probe)', () => {
		expect(defaultReadableProbe(tempDir)).toBe(true);
	});
});
