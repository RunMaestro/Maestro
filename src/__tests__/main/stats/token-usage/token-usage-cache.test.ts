/**
 * Tests for the Cost & Tokens per-session cache: fingerprint-keyed get/set,
 * pruning of sessions deleted on disk, disk round-trip, and version-mismatch
 * invalidation. The cache is what makes a cold restart cheap - unchanged
 * sessions are served without re-deriving their transcript.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SessionTokenBreakdown } from '../../../../shared/tokenUsage';

// Mock electron.app.getPath before importing the cache so its default-path
// constructor branch never touches the real userData dir.
const TMP_BASE = path.join(os.tmpdir(), `maestro-token-usage-cache-test-${process.pid}`);

vi.mock('electron', () => ({
	app: {
		getPath: vi.fn(() => TMP_BASE),
	},
}));

import {
	TokenUsageCache,
	TOKEN_USAGE_CACHE_VERSION,
	tokenCacheKey,
	sessionFingerprint,
	getTokenUsageCache,
	setTokenUsageCacheForTest,
} from '../../../../main/stats/token-usage/token-usage-cache';

function makeBreakdown(overrides: Partial<SessionTokenBreakdown> = {}): SessionTokenBreakdown {
	return {
		sessionId: 'sess-1',
		agentType: 'claude-code',
		projectPath: '/proj',
		timestampMs: 1_700_000_000_000,
		byModel: [],
		inputTokens: 100,
		outputTokens: 20,
		cacheReadTokens: 0,
		cacheCreationTokens: 0,
		costUsd: 0.5,
		costEstimated: true,
		coverage: 'full',
		...overrides,
	};
}

let tmpDir: string;

beforeEach(() => {
	fs.mkdirSync(TMP_BASE, { recursive: true });
	tmpDir = fs.mkdtempSync(path.join(TMP_BASE, 'run-'));
	setTokenUsageCacheForTest(null);
});

afterEach(() => {
	setTokenUsageCacheForTest(null);
	fs.rmSync(TMP_BASE, { recursive: true, force: true });
});

describe('key + fingerprint helpers', () => {
	it('namespaces the cache key by agent type', () => {
		expect(tokenCacheKey('claude-code', 'abc')).toBe('claude-code:abc');
		expect(tokenCacheKey('codex', 'abc')).not.toBe(tokenCacheKey('claude-code', 'abc'));
	});

	it('changes the fingerprint when modifiedAt or size changes', () => {
		const base = sessionFingerprint('2026-01-01T00:00:00Z', 100);
		expect(sessionFingerprint('2026-01-01T00:00:00Z', 100)).toBe(base);
		expect(sessionFingerprint('2026-01-02T00:00:00Z', 100)).not.toBe(base);
		expect(sessionFingerprint('2026-01-01T00:00:00Z', 101)).not.toBe(base);
	});
});

describe('TokenUsageCache', () => {
	it('returns undefined on a cold get and hits after set with a matching fingerprint', () => {
		const cache = new TokenUsageCache(path.join(tmpDir, 'c.json'));
		expect(cache.get('k', 'fp')).toBeUndefined();

		const bd = makeBreakdown();
		cache.set('k', 'fp', bd);
		expect(cache.get('k', 'fp')).toEqual(bd);
	});

	it('misses when the fingerprint no longer matches (session changed on disk)', () => {
		const cache = new TokenUsageCache(path.join(tmpDir, 'c.json'));
		cache.set('k', 'fp-old', makeBreakdown());
		expect(cache.get('k', 'fp-new')).toBeUndefined();
	});

	it('prunes entries whose key is not in the live set', () => {
		const cache = new TokenUsageCache(path.join(tmpDir, 'c.json'));
		cache.set('a', 'fp', makeBreakdown({ sessionId: 'a' }));
		cache.set('b', 'fp', makeBreakdown({ sessionId: 'b' }));
		cache.set('c', 'fp', makeBreakdown({ sessionId: 'c' }));

		const pruned = cache.prune(new Set(['a', 'c']));
		expect(pruned).toBe(1);
		expect(cache.get('b', 'fp')).toBeUndefined();
		expect(cache.get('a', 'fp')).toBeDefined();
		expect(cache.get('c', 'fp')).toBeDefined();
	});

	it('persists to disk and reloads into a fresh instance', async () => {
		const file = path.join(tmpDir, 'c.json');
		const cache = new TokenUsageCache(file);
		cache.set('k', 'fp', makeBreakdown({ costUsd: 1.25 }));
		await cache.persist();
		expect(fs.existsSync(file)).toBe(true);

		const reloaded = new TokenUsageCache(file);
		await reloaded.load();
		expect(reloaded.get('k', 'fp')?.costUsd).toBe(1.25);
	});

	it('does not write a file when nothing changed', async () => {
		const file = path.join(tmpDir, 'c.json');
		const cache = new TokenUsageCache(file);
		await cache.persist();
		expect(fs.existsSync(file)).toBe(false);
	});

	it('starts empty when the persisted version does not match', async () => {
		const file = path.join(tmpDir, 'c.json');
		fs.writeFileSync(
			file,
			JSON.stringify({
				version: TOKEN_USAGE_CACHE_VERSION + 1,
				savedAt: Date.now(),
				sessions: { k: { fingerprint: 'fp', breakdown: makeBreakdown() } },
			})
		);
		const cache = new TokenUsageCache(file);
		await cache.load();
		expect(cache.get('k', 'fp')).toBeUndefined();
	});

	it('tolerates a missing cache file on first run', async () => {
		const cache = new TokenUsageCache(path.join(tmpDir, 'does-not-exist.json'));
		await expect(cache.load()).resolves.toBeUndefined();
		expect(cache.get('k', 'fp')).toBeUndefined();
	});
});

describe('getTokenUsageCache singleton', () => {
	it('returns the same instance across calls and can be reset for tests', () => {
		const a = getTokenUsageCache();
		const b = getTokenUsageCache();
		expect(a).toBe(b);
		setTokenUsageCacheForTest(null);
		expect(getTokenUsageCache()).not.toBe(a);
	});
});
