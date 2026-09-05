/**
 * Tests for deferred, cached store writes.
 *
 * Two properties matter here and both are easy to break silently:
 *
 * 1. **The bytes on disk do not change.** The serializer reproduces conf's
 *    `JSON.stringify(data, undefined, '\t')` output exactly, so an existing
 *    `maestro-sessions.json` round-trips identically. A drift here would not
 *    fail at runtime (the file still parses) - it would just quietly reformat
 *    every user's store, so it is asserted byte for byte.
 *
 * 2. **Writes stop blocking the UI thread.** Reads come from cache (no
 *    readFileSync / JSON.parse per call) and writes are coalesced and async.
 *    That is what issue #1501 was about: a 6 MB sessions file re-read, re-
 *    parsed, re-serialized and written synchronously on every streaming flush
 *    made the app un-typeable.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import type Store from 'electron-store';

import { deferStoreWrites, serializeWithMemoizedArray } from '../../../main/stores/deferred-writes';

vi.mock('../../../main/utils/logger', () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));

/** How conf itself serializes a store document. */
const confSerialize = (value: unknown): string => JSON.stringify(value, undefined, '\t');

describe('serializeWithMemoizedArray', () => {
	const cases: Array<[string, unknown]> = [
		['empty document', {}],
		['empty sessions array', { sessions: [] }],
		['one session', { sessions: [{ id: 'a', name: 'Agent A' }] }],
		['sessions plus sibling keys', { sessions: [{ id: 'a' }, { id: 'b' }], activeSessionId: 'a' }],
		[
			'deeply nested session',
			{
				sessions: [
					{
						id: 'a',
						aiTabs: [{ id: 't1', logs: [{ type: 'stdout', content: 'line\twith\ttabs' }] }],
						nested: { deep: { deeper: [1, 2, { three: true }] } },
					},
				],
				activeSessionId: 'a',
			},
		],
		['sibling key before sessions', { activeSessionId: 'a', sessions: [{ id: 'a' }] }],
		['null and primitive elements', { sessions: [null, 1, 'two', true] }],
		['unicode and escapes', { sessions: [{ id: 'a', name: 'quote " backslash \\ \n newline' }] }],
		['nested empty array and object', { sessions: [{ id: 'a', tabs: [], meta: {} }] }],
	];

	it.each(cases)('matches conf byte for byte: %s', (_label, value) => {
		expect(serializeWithMemoizedArray(value, 'sessions')).toBe(confSerialize(value));
	});

	it('round-trips through JSON.parse', () => {
		const doc = { sessions: [{ id: 'a', n: 1 }], activeSessionId: 'a' };
		expect(JSON.parse(serializeWithMemoizedArray(doc, 'sessions'))).toEqual(doc);
	});

	it('drops keys whose value is not serializable, like JSON.stringify', () => {
		const doc = { sessions: [{ id: 'a' }], gone: undefined, alsoGone: () => {} };
		expect(serializeWithMemoizedArray(doc, 'sessions')).toBe(confSerialize(doc));
	});

	it('renders non-serializable array elements as null, like JSON.stringify', () => {
		const doc = { sessions: [{ id: 'a' }, undefined] };
		expect(serializeWithMemoizedArray(doc, 'sessions')).toBe(confSerialize(doc));
	});

	it('falls back to a plain stringify when the memo key is not an array', () => {
		const doc = { sessions: { notAnArray: true }, other: 1 };
		expect(serializeWithMemoizedArray(doc, 'sessions')).toBe(confSerialize(doc));
	});

	it('falls back to a plain stringify when the memo key is absent', () => {
		const doc = { other: 1 };
		expect(serializeWithMemoizedArray(doc, 'sessions')).toBe(confSerialize(doc));
	});

	it('reuses memoized JSON when a session object keeps its identity', () => {
		// A session that is not touched must not be re-serialized. Proven by
		// mutating it in place after the first pass: the memo is keyed by
		// reference, so the stale (pre-mutation) JSON is what comes back out. Real
		// callers update immutably, which is exactly why this is safe.
		const session: Record<string, unknown> = { id: 'a', name: 'before' };
		const first = serializeWithMemoizedArray({ sessions: [session] }, 'sessions');
		expect(first).toContain('before');

		session.name = 'after';
		expect(serializeWithMemoizedArray({ sessions: [session] }, 'sessions')).toBe(first);

		// A fresh object (what an immutable update produces) misses the memo.
		const updated = { ...session };
		expect(serializeWithMemoizedArray({ sessions: [updated] }, 'sessions')).toContain('after');
	});
});

describe('deferStoreWrites', () => {
	let dir: string;
	let filePath: string;

	/** A minimal stand-in for the parts of electron-store this module touches. */
	function makeStore(initial: Record<string, unknown>): Store<Record<string, unknown>> {
		fs.writeFileSync(filePath, confSerialize(initial), 'utf-8');
		const api = {
			path: filePath,
			get store() {
				return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
			},
			get(key: string, defaultValue?: unknown) {
				const doc = this.store as Record<string, unknown>;
				return doc[key] === undefined ? defaultValue : doc[key];
			},
			set(key: string, value: unknown) {
				const doc = this.store as Record<string, unknown>;
				doc[key] = value;
				fs.writeFileSync(filePath, confSerialize(doc), 'utf-8');
			},
		};
		return api as unknown as Store<Record<string, unknown>>;
	}

	const readFile = () => JSON.parse(fs.readFileSync(filePath, 'utf-8'));

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-deferred-'));
		filePath = path.join(dir, 'maestro-sessions.json');
	});

	afterEach(() => {
		vi.restoreAllMocks();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('serves reads from cache without touching the file', async () => {
		const store = makeStore({ sessions: [{ id: 'a' }], activeSessionId: 'a' });
		const writer = deferStoreWrites(store, 'sessions');

		// Delete the backing file - a cached read must not need it. This is the
		// whole point: today every get() is a readFileSync + JSON.parse of the
		// entire multi-megabyte document.
		fs.rmSync(filePath);

		expect(writer.store.get('sessions', [])).toEqual([{ id: 'a' }]);
		expect(writer.store.get('activeSessionId')).toBe('a');
		expect(writer.store.get('missing', 'fallback')).toBe('fallback');
	});

	it('does not write synchronously on set, then lands the write asynchronously', async () => {
		const store = makeStore({ sessions: [] });
		const writer = deferStoreWrites(store, 'sessions');

		writer.store.set('sessions', [{ id: 'a' }]);

		// Still the old document on disk - the set returned without writing.
		expect(readFile()).toEqual({ sessions: [] });
		expect(writer.hasPendingWrite()).toBe(true);

		await writer.flushAsync();

		expect(readFile()).toEqual({ sessions: [{ id: 'a' }] });
		expect(writer.hasPendingWrite()).toBe(false);
	});

	it('coalesces a burst of writes into a single document', async () => {
		const store = makeStore({ sessions: [] });
		const writer = deferStoreWrites(store, 'sessions');

		writer.store.set('sessions', [{ id: 'a' }]);
		writer.store.set('activeSessionId', 'a');
		writer.store.set('sessions', [{ id: 'a' }, { id: 'b' }]);

		await writer.flushAsync();

		expect(readFile()).toEqual({ sessions: [{ id: 'a' }, { id: 'b' }], activeSessionId: 'a' });
	});

	it('preserves the coalescing window while an async flush waits for durability', async () => {
		const store = makeStore({ sessions: [] });
		const writer = deferStoreWrites(store, 'sessions');
		const writeFile = vi.spyOn(fsp, 'writeFile');

		writer.store.set('sessions', [{ id: 'a' }]);
		const flush = writer.flushAsync();
		await new Promise<void>((resolve) => setImmediate(resolve));

		// Awaiting durable persistence must not synchronously cancel the bounded
		// coalescing window and serialize/write in the IPC caller's event-loop turn.
		expect(writeFile).not.toHaveBeenCalled();

		await flush;
		expect(writeFile).toHaveBeenCalledOnce();
		expect(readFile()).toEqual({ sessions: [{ id: 'a' }] });
	});

	it('serializes overlapping flushes so the newest snapshot lands last', async () => {
		const store = makeStore({ sessions: [] });
		const writer = deferStoreWrites(store, 'sessions');
		const firstWriteStarted = Promise.withResolvers<void>();
		const releaseFirstWrite = Promise.withResolvers<void>();
		const originalWriteFile = fsp.writeFile.bind(fsp);
		vi.spyOn(fsp, 'writeFile').mockImplementationOnce(async (...args) => {
			firstWriteStarted.resolve();
			await releaseFirstWrite.promise;
			return originalWriteFile(...args);
		});

		writer.store.set('sessions', [{ id: 'old' }]);
		const firstFlush = writer.flushAsync();
		await firstWriteStarted.promise;

		writer.store.set('sessions', [{ id: 'new' }]);
		const secondFlush = writer.flushAsync();
		releaseFirstWrite.resolve();
		await Promise.all([firstFlush, secondFlush]);

		expect(readFile()).toEqual({ sessions: [{ id: 'new' }] });
		expect(writer.hasPendingWrite()).toBe(false);
	});

	it('reflects writes in subsequent reads before they reach disk', () => {
		const store = makeStore({ sessions: [] });
		const writer = deferStoreWrites(store, 'sessions');

		writer.store.set('sessions', [{ id: 'a' }]);

		// Read-your-writes. Every main-process caller does get -> merge -> set, so
		// a cache that lagged the write would silently drop updates.
		expect(writer.store.get('sessions', [])).toEqual([{ id: 'a' }]);
	});

	it('hands out array copies so a caller cannot corrupt the cache in place', async () => {
		const store = makeStore({ sessions: [{ id: 'a' }] });
		const writer = deferStoreWrites(store, 'sessions');

		const sessions = writer.store.get('sessions', []) as unknown[];
		sessions.push({ id: 'injected' });

		expect(writer.store.get('sessions', [])).toEqual([{ id: 'a' }]);
	});

	it('preserves element identity so the serialization memo still hits', () => {
		const store = makeStore({ sessions: [{ id: 'a' }] });
		const writer = deferStoreWrites(store, 'sessions');

		const first = writer.store.get('sessions', []) as unknown[];
		const second = writer.store.get('sessions', []) as unknown[];

		expect(first).not.toBe(second);
		expect(first[0]).toBe(second[0]);
	});

	it('writes the document conf would have written', async () => {
		const doc = {
			sessions: [
				{ id: 'a', name: 'Agent A', aiTabs: [{ id: 't', logs: [] }] },
				{ id: 'b', name: 'Agent B' },
			],
			activeSessionId: 'b',
		};
		const store = makeStore({ sessions: [] });
		const writer = deferStoreWrites(store, 'sessions');

		writer.store.set(doc);
		await writer.flushAsync();

		expect(fs.readFileSync(filePath, 'utf-8')).toBe(confSerialize(doc));
	});

	it('flushSync lands a pending write, for the quit path', () => {
		const store = makeStore({ sessions: [] });
		const writer = deferStoreWrites(store, 'sessions');

		writer.store.set('sessions', [{ id: 'a' }]);
		writer.flushSync();

		expect(readFile()).toEqual({ sessions: [{ id: 'a' }] });
		expect(writer.hasPendingWrite()).toBe(false);
	});

	it('flushSync supersedes an in-flight async snapshot during shutdown', async () => {
		const store = makeStore({ sessions: [] });
		const writer = deferStoreWrites(store, 'sessions');
		const asyncWriteStarted = Promise.withResolvers<void>();
		const releaseAsyncWrite = Promise.withResolvers<void>();
		const originalWriteFile = fsp.writeFile.bind(fsp);
		vi.spyOn(fsp, 'writeFile').mockImplementationOnce(async (...args) => {
			asyncWriteStarted.resolve();
			await releaseAsyncWrite.promise;
			return originalWriteFile(...args);
		});

		writer.store.set('sessions', [{ id: 'old' }]);
		const asyncFlush = writer.flushAsync();
		await asyncWriteStarted.promise;

		writer.store.set('sessions', [{ id: 'new' }]);
		writer.flushSync();
		expect(readFile()).toEqual({ sessions: [{ id: 'new' }] });

		releaseAsyncWrite.resolve();
		await asyncFlush;
		expect(readFile()).toEqual({ sessions: [{ id: 'new' }] });
		expect(writer.hasPendingWrite()).toBe(false);
	});

	it('flushSync is a no-op when nothing is pending', () => {
		const store = makeStore({ sessions: [{ id: 'a' }] });
		const writer = deferStoreWrites(store, 'sessions');
		const before = fs.statSync(filePath).mtimeMs;

		writer.flushSync();

		expect(fs.statSync(filePath).mtimeMs).toBe(before);
	});

	it('supports delete and has against the cache', async () => {
		const store = makeStore({ sessions: [{ id: 'a' }], activeSessionId: 'a' });
		const writer = deferStoreWrites(store, 'sessions');

		expect(writer.store.has('activeSessionId')).toBe(true);
		writer.store.delete('activeSessionId');
		expect(writer.store.has('activeSessionId')).toBe(false);

		await writer.flushAsync();
		expect(readFile()).toEqual({ sessions: [{ id: 'a' }] });
	});

	it('keeps the previous document intact when a write fails', async () => {
		const store = makeStore({ sessions: [{ id: 'original' }] });
		const writer = deferStoreWrites(store, 'sessions');

		// Point the store at an unwritable path so the atomic write's temp-file
		// step fails. The real file must survive untouched.
		(writer.store as unknown as { path: string }).path = path.join(dir, 'missing-dir', 's.json');

		writer.store.set('sessions', [{ id: 'new' }]);
		await expect(writer.flushAsync()).rejects.toMatchObject({ code: 'ENOENT' });

		expect(readFile()).toEqual({ sessions: [{ id: 'original' }] });
		// A failed write stays dirty so a later flush retries it.
		expect(writer.hasPendingWrite()).toBe(true);
	});

	it('leaves no temp files behind on a successful write', async () => {
		const store = makeStore({ sessions: [] });
		const writer = deferStoreWrites(store, 'sessions');

		writer.store.set('sessions', [{ id: 'a' }]);
		await writer.flushAsync();

		expect(fs.readdirSync(dir)).toEqual(['maestro-sessions.json']);
	});
});
