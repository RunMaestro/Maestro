/**
 * Tests for the history bucket cache + builder.
 *
 * Covers two layers:
 *
 * 1. `buildBucketAggregate` — pure function that turns a flat entry array
 *    into a fixed-count bucket aggregate spanning the entries' time range.
 *    The activity-graph view feeds this into the renderer.
 *
 * 2. `HistoryBucketCache` — disk-backed, fingerprint-keyed cache so the
 *    aggregate doesn't have to be recomputed on every interaction. The
 *    fingerprint is the underlying source file's `mtime+size` (single
 *    file) or a SHA over many such fingerprints (unified view).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { HistoryEntry } from '../../../shared/types';

// Mock electron.app.getPath BEFORE importing the cache module so its
// constructor uses the temp dir we control.
const TMP_BASE = path.join(os.tmpdir(), `maestro-bucket-cache-test-${process.pid}`);

vi.mock('electron', () => ({
	app: {
		getPath: vi.fn(() => TMP_BASE),
	},
}));

import {
	HistoryBucketCache,
	HISTORY_BUCKET_CACHE_VERSION,
	getHistoryBucketCache,
	setHistoryBucketCacheForTest,
	fileFingerprint,
	multiFileFingerprint,
} from '../../../main/utils/history-bucket-cache';
import { buildBucketAggregate } from '../../../main/utils/history-bucket-builder';

function makeEntry(overrides: Partial<HistoryEntry>): HistoryEntry {
	return {
		id: 'e',
		type: 'USER',
		timestamp: 0,
		summary: '',
		projectPath: '/p',
		...overrides,
	} as HistoryEntry;
}

describe('buildBucketAggregate', () => {
	it('returns zero-filled buckets for an empty entry array', () => {
		const result = buildBucketAggregate([], 5);
		expect(result.buckets).toHaveLength(5);
		expect(result.buckets.every((b) => b.auto === 0 && b.user === 0 && b.cue === 0)).toBe(true);
		expect(result.totalCount).toBe(0);
		expect(result.autoCount).toBe(0);
		expect(result.userCount).toBe(0);
		expect(result.cueCount).toBe(0);
	});

	it('coerces non-positive bucket counts to a single bucket', () => {
		const result = buildBucketAggregate([], 0);
		expect(result.buckets).toHaveLength(1);
	});

	it('places entries in their correct buckets based on timestamp', () => {
		const start = 1_000_000;
		const end = 1_000_000 + 10_000;
		const entries: HistoryEntry[] = [
			makeEntry({ id: '1', type: 'AUTO', timestamp: start }),
			makeEntry({ id: '2', type: 'USER', timestamp: start + 5_000 }),
			makeEntry({ id: '3', type: 'CUE', timestamp: end }),
		];
		const result = buildBucketAggregate(entries, 10);

		expect(result.totalCount).toBe(3);
		expect(result.autoCount).toBe(1);
		expect(result.userCount).toBe(1);
		expect(result.cueCount).toBe(1);
		expect(result.earliestTimestamp).toBe(start);
		expect(result.latestTimestamp).toBe(end);

		// First bucket has the earliest entry; last bucket has the latest.
		expect(result.buckets[0].auto).toBe(1);
		expect(result.buckets[result.buckets.length - 1].cue).toBe(1);
		// Middle entry lands somewhere strictly in between.
		const middleHit = result.buckets.slice(1, -1).reduce((acc, b) => acc + b.user, 0);
		expect(middleHit).toBe(1);
	});

	it('survives a single-entry input (zero-width range)', () => {
		const entries = [makeEntry({ id: '1', type: 'USER', timestamp: 5_000 })];
		const result = buildBucketAggregate(entries, 4);
		// All counts go to the first bucket because the range collapses to one ms.
		const total = result.buckets.reduce((acc, b) => acc + b.user, 0);
		expect(total).toBe(1);
	});

	describe('with lookback window', () => {
		it('drops entries outside the lookback window', () => {
			const now = 10_000_000;
			const lookbackMs = 1_000; // 1 second
			const entries: HistoryEntry[] = [
				makeEntry({ id: 'old', type: 'USER', timestamp: now - 5_000 }), // outside
				makeEntry({ id: 'in', type: 'USER', timestamp: now - 500 }), // inside
				makeEntry({ id: 'edge', type: 'AUTO', timestamp: now }), // inside
			];
			const result = buildBucketAggregate(entries, 4, { lookbackMs, endTime: now });
			expect(result.totalCount).toBe(2);
			expect(result.userCount).toBe(1);
			expect(result.autoCount).toBe(1);
			// Range matches the window, not the observed entries.
			expect(result.earliestTimestamp).toBe(now - lookbackMs);
			expect(result.latestTimestamp).toBe(now);
		});

		it('returns the window range even when no entries fall inside it', () => {
			const now = 10_000_000;
			const lookbackMs = 1_000;
			const entries = [makeEntry({ id: 'old', type: 'USER', timestamp: now - 100_000 })];
			const result = buildBucketAggregate(entries, 6, { lookbackMs, endTime: now });
			expect(result.totalCount).toBe(0);
			expect(result.buckets).toHaveLength(6);
			expect(result.earliestTimestamp).toBe(now - lookbackMs);
			expect(result.latestTimestamp).toBe(now);
		});
	});
});

describe('fileFingerprint', () => {
	let tmpFile: string;

	beforeEach(() => {
		tmpFile = path.join(os.tmpdir(), `bucket-cache-fp-${Date.now()}-${Math.random()}.json`);
	});

	afterEach(() => {
		try {
			if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
		} catch {
			// Ignore cleanup errors — the OS will reap eventually.
		}
	});

	it('returns "missing" when the file does not exist', () => {
		expect(fileFingerprint('/definitely/does/not/exist.json')).toBe('missing');
	});

	it('changes when the file is rewritten with different content', () => {
		fs.writeFileSync(tmpFile, '{"a":1}', 'utf-8');
		const fp1 = fileFingerprint(tmpFile);
		// Sleep just enough to bump mtime on coarse-grained filesystems.
		const start = Date.now();
		while (Date.now() - start < 20) {
			/* spin */
		}
		fs.writeFileSync(tmpFile, '{"a":1,"b":2}', 'utf-8');
		const fp2 = fileFingerprint(tmpFile);
		expect(fp1).not.toBe(fp2);
	});
});

describe('multiFileFingerprint', () => {
	it('is stable under input reordering', () => {
		const a = path.join(os.tmpdir(), `fp-a-${Date.now()}.json`);
		const b = path.join(os.tmpdir(), `fp-b-${Date.now()}.json`);
		const fp1 = multiFileFingerprint([a, b]);
		const fp2 = multiFileFingerprint([b, a]);
		expect(fp1).toBe(fp2);
	});

	it('changes when any constituent file changes', () => {
		const a = path.join(os.tmpdir(), `fp-stable-${Date.now()}.json`);
		fs.writeFileSync(a, 'one', 'utf-8');
		const fp1 = multiFileFingerprint([a]);
		const start = Date.now();
		while (Date.now() - start < 20) {
			/* spin */
		}
		fs.writeFileSync(a, 'two', 'utf-8');
		const fp2 = multiFileFingerprint([a]);
		expect(fp1).not.toBe(fp2);
		try {
			fs.unlinkSync(a);
		} catch {
			// best-effort cleanup
		}
	});
});

describe('HistoryBucketCache', () => {
	let cacheDir: string;
	let cache: HistoryBucketCache;

	beforeEach(() => {
		cacheDir = path.join(os.tmpdir(), `bucket-cache-${Date.now()}-${Math.random()}`);
		cache = new HistoryBucketCache(cacheDir);
		setHistoryBucketCacheForTest(null); // reset singleton for parallel safety
	});

	afterEach(() => {
		try {
			if (fs.existsSync(cacheDir)) {
				for (const f of fs.readdirSync(cacheDir)) {
					fs.unlinkSync(path.join(cacheDir, f));
				}
				fs.rmdirSync(cacheDir);
			}
		} catch {
			// Cleanup failures are non-fatal in tests.
		}
	});

	const sampleEntry = (key: string) => ({
		version: HISTORY_BUCKET_CACHE_VERSION,
		cacheKey: key,
		sourceFingerprint: 'fp-1',
		bucketCount: 3,
		buckets: [
			{ auto: 1, user: 0, cue: 0 },
			{ auto: 0, user: 2, cue: 0 },
			{ auto: 0, user: 0, cue: 3 },
		],
		earliestTimestamp: 100,
		latestTimestamp: 999,
		totalCount: 6,
		autoCount: 1,
		userCount: 2,
		cueCount: 3,
		computedAt: Date.now(),
	});

	it('round-trips an entry through disk', () => {
		const entry = sampleEntry('round-trip');
		cache.set(entry);

		// New cache instance points at same dir — must hit disk.
		const fresh = new HistoryBucketCache(cacheDir);
		const hit = fresh.get('round-trip', 'fp-1');
		expect(hit).not.toBeNull();
		expect(hit?.totalCount).toBe(6);
		expect(hit?.buckets[2].cue).toBe(3);
	});

	it('returns null when the fingerprint does not match (cache miss)', () => {
		cache.set(sampleEntry('mismatch'));
		expect(cache.get('mismatch', 'different-fp')).toBeNull();
	});

	it('invalidate removes the entry from both memory and disk', () => {
		const entry = sampleEntry('invalidate-me');
		cache.set(entry);
		expect(cache.get('invalidate-me', 'fp-1')).not.toBeNull();

		cache.invalidate('invalidate-me');
		expect(cache.get('invalidate-me', 'fp-1')).toBeNull();
		const fresh = new HistoryBucketCache(cacheDir);
		expect(fresh.get('invalidate-me', 'fp-1')).toBeNull();
	});

	it('clear removes every entry on disk', () => {
		cache.set(sampleEntry('a'));
		cache.set(sampleEntry('b'));
		cache.clear();
		const fresh = new HistoryBucketCache(cacheDir);
		expect(fresh.get('a', 'fp-1')).toBeNull();
		expect(fresh.get('b', 'fp-1')).toBeNull();
	});

	it('getHistoryBucketCache returns a singleton instance', () => {
		setHistoryBucketCacheForTest(null);
		const a = getHistoryBucketCache();
		const b = getHistoryBucketCache();
		expect(a).toBe(b);
		setHistoryBucketCacheForTest(null);
	});
});
