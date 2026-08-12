/**
 * Tests for the shared session-info parse cache. Uses real fs against temp
 * dirs; the "parse" function is a spy so each test can assert exactly which
 * files were re-read and which were served from cache.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

vi.mock('electron', () => ({
	app: { getPath: vi.fn().mockReturnValue('/should-be-overridden') },
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));

import {
	SessionInfoCache,
	fileFingerprint,
	getSessionInfoCache,
	setSessionInfoCacheForTest,
	SESSION_INFO_CACHE_VERSION,
} from '../../../main/storage/session-info-cache';
import type { AgentSessionInfo } from '../../../main/agents/session-storage';

const SCOPE = '/projects/-Users-me-thing';

function info(sessionId: string, overrides: Partial<AgentSessionInfo> = {}): AgentSessionInfo {
	return {
		sessionId,
		projectPath: '/Users/me/thing',
		timestamp: '2026-01-01T00:00:00.000Z',
		modifiedAt: '2026-01-01T00:00:00.000Z',
		firstMessage: `preview for ${sessionId}`,
		messageCount: 2,
		sizeBytes: 100,
		inputTokens: 1,
		outputTokens: 2,
		cacheReadTokens: 0,
		cacheCreationTokens: 0,
		durationSeconds: 5,
		...overrides,
	};
}

describe('SessionInfoCache', () => {
	let baseDir: string;
	let cache: SessionInfoCache;

	beforeEach(async () => {
		baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'session-info-cache-'));
		cache = new SessionInfoCache('claude-code', baseDir);
	});

	afterEach(async () => {
		await fsp.rm(baseDir, { recursive: true, force: true });
		setSessionInfoCacheForTest('claude-code', null);
	});

	it('parses on a cold cache and serves unchanged files without re-parsing', async () => {
		const refs = [
			{ key: '/a.jsonl', fingerprint: fileFingerprint(100, 1000) },
			{ key: '/b.jsonl', fingerprint: fileFingerprint(200, 2000) },
		];
		const parse = vi.fn(async (ref: { key: string }) => info(path.basename(ref.key, '.jsonl')));

		const first = await cache.resolve(SCOPE, refs, parse);
		expect(first.map((s) => s.sessionId)).toEqual(['a', 'b']);
		expect(parse).toHaveBeenCalledTimes(2);

		parse.mockClear();
		const second = await cache.resolve(SCOPE, refs, parse);
		expect(second.map((s) => s.sessionId)).toEqual(['a', 'b']);
		expect(parse).not.toHaveBeenCalled();
	});

	it('re-parses only the file whose fingerprint changed', async () => {
		const refs = [
			{ key: '/a.jsonl', fingerprint: fileFingerprint(100, 1000) },
			{ key: '/b.jsonl', fingerprint: fileFingerprint(200, 2000) },
		];
		const parse = vi.fn(async (ref: { key: string }) => info(path.basename(ref.key, '.jsonl')));
		await cache.resolve(SCOPE, refs, parse);

		parse.mockClear();
		// b grew - a is byte-for-byte identical.
		const grown = [refs[0], { key: '/b.jsonl', fingerprint: fileFingerprint(999, 3000) }];
		await cache.resolve(SCOPE, grown, parse);

		expect(parse).toHaveBeenCalledTimes(1);
		expect(parse.mock.calls[0][0].key).toBe('/b.jsonl');
	});

	it('survives a restart: a new instance reads the persisted entries', async () => {
		const refs = [{ key: '/a.jsonl', fingerprint: fileFingerprint(100, 1000) }];
		const parse = vi.fn(async () => info('a'));
		await cache.resolve(SCOPE, refs, parse);

		const restarted = new SessionInfoCache('claude-code', baseDir);
		const coldParse = vi.fn(async () => info('a'));
		const sessions = await restarted.resolve(SCOPE, refs, coldParse);

		expect(coldParse).not.toHaveBeenCalled();
		expect(sessions.map((s) => s.sessionId)).toEqual(['a']);
	});

	it('discards persisted entries written by an older cache version', async () => {
		const refs = [{ key: '/a.jsonl', fingerprint: fileFingerprint(100, 1000) }];
		await cache.resolve(SCOPE, refs, async () => info('a'));

		// Rewrite the scope file as if an older build had produced it.
		const dir = path.join(baseDir, 'session-info', 'claude-code');
		const [file] = await fsp.readdir(dir);
		const stored = JSON.parse(await fsp.readFile(path.join(dir, file), 'utf-8'));
		stored.version = SESSION_INFO_CACHE_VERSION - 1;
		await fsp.writeFile(path.join(dir, file), JSON.stringify(stored), 'utf-8');

		const restarted = new SessionInfoCache('claude-code', baseDir);
		const parse = vi.fn(async () => info('a'));
		await restarted.resolve(SCOPE, refs, parse);
		expect(parse).toHaveBeenCalledTimes(1);
	});

	it('prunes entries for files that disappeared, but only when asked', async () => {
		const both = [
			{ key: '/a.jsonl', fingerprint: fileFingerprint(100, 1000) },
			{ key: '/b.jsonl', fingerprint: fileFingerprint(200, 2000) },
		];
		const parse = vi.fn(async (ref: { key: string }) => info(path.basename(ref.key, '.jsonl')));
		await cache.resolve(SCOPE, both, parse);

		// A paginated caller passes a slice: the other entries must survive.
		parse.mockClear();
		await cache.resolve(SCOPE, [both[0]], parse, { prune: false });
		await cache.resolve(SCOPE, both, parse);
		expect(parse).not.toHaveBeenCalled();

		// A full enumeration that no longer sees b evicts it.
		await cache.resolve(SCOPE, [both[0]], parse, { prune: true });
		await cache.resolve(SCOPE, both, parse);
		expect(parse).toHaveBeenCalledTimes(1);
		expect(parse.mock.calls[0][0].key).toBe('/b.jsonl');
	});

	it('omits unparseable files from the result and retries them next time', async () => {
		const refs = [
			{ key: '/a.jsonl', fingerprint: fileFingerprint(100, 1000) },
			{ key: '/bad.jsonl', fingerprint: fileFingerprint(0, 0) },
		];
		const parse = vi.fn(async (ref: { key: string }) =>
			ref.key === '/bad.jsonl' ? null : info('a')
		);

		const sessions = await cache.resolve(SCOPE, refs, parse);
		expect(sessions.map((s) => s.sessionId)).toEqual(['a']);

		parse.mockClear();
		await cache.resolve(SCOPE, refs, parse);
		expect(parse).toHaveBeenCalledTimes(1);
		expect(parse.mock.calls[0][0].key).toBe('/bad.jsonl');
	});

	it('keeps scopes independent so one project cannot evict another', async () => {
		const aRef = [{ key: '/a.jsonl', fingerprint: fileFingerprint(100, 1000) }];
		const bRef = [{ key: '/b.jsonl', fingerprint: fileFingerprint(200, 2000) }];
		const parse = vi.fn(async (ref: { key: string }) => info(path.basename(ref.key, '.jsonl')));

		await cache.resolve('/projects/one', aRef, parse, { prune: true });
		await cache.resolve('/projects/two', bRef, parse, { prune: true });

		parse.mockClear();
		await cache.resolve('/projects/one', aRef, parse);
		expect(parse).not.toHaveBeenCalled();
	});

	it('shares one instance per agent and honors the test seam', () => {
		const injected = new SessionInfoCache('claude-code', baseDir);
		setSessionInfoCacheForTest('claude-code', injected);
		expect(getSessionInfoCache('claude-code')).toBe(injected);

		setSessionInfoCacheForTest('claude-code', null);
		const fresh = getSessionInfoCache('claude-code');
		expect(fresh).not.toBe(injected);
		expect(getSessionInfoCache('claude-code')).toBe(fresh);
	});
});
