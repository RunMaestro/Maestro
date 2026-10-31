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

import {
	deferStoreWrites,
	serializeWithMemoizedArray,
	sweepOrphanTempFiles,
} from '../../../main/stores/deferred-writes';
import { encodeWithMemoizedArray } from '../../../shared/memoizedJsonSerialize';

vi.mock('../../../main/utils/logger', () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));

/** How conf itself serializes a store document. */
const confSerialize = (value: unknown): string => JSON.stringify(value, undefined, '\t');

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
	[
		'multi-byte text across elements',
		{
			sessions: [
				{ id: 'a', name: '🎭 Virtual' },
				{ id: 'b', name: '日本語 ünï' },
			],
			note: '✓',
		},
	],
];

describe('serializeWithMemoizedArray', () => {
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

	it('indents identically on a memo hit as on a memo miss', () => {
		// The memo stores the ALREADY-INDENTED element so a repeat write does not
		// re-run the split/join. That makes indentation part of what is cached, so
		// a hit and a miss can now disagree - and only the second write of an
		// unchanged multi-line session would show it. Serialize twice and hold both
		// against conf's own output.
		const session = {
			id: 'a',
			aiTabs: [{ id: 't1', logs: [{ content: 'line one' }, { content: 'line two' }] }],
		};
		const doc = { sessions: [session], activeSessionId: 'a' };

		const miss = serializeWithMemoizedArray(doc, 'sessions');
		const hit = serializeWithMemoizedArray(doc, 'sessions');

		expect(miss).toBe(confSerialize(doc));
		expect(hit).toBe(confSerialize(doc));
	});
});

describe('encodeWithMemoizedArray', () => {
	const concat = (chunks: Uint8Array[]): string => Buffer.concat(chunks).toString('utf-8');

	it.each(cases)('matches conf byte for byte: %s', (_label, value) => {
		const chunks = encodeWithMemoizedArray(value, 'sessions');
		expect(Buffer.concat(chunks).equals(Buffer.from(confSerialize(value), 'utf-8'))).toBe(true);
	});

	it('falls back to one plain chunk when the memo key is not an array', () => {
		const doc = { sessions: { notAnArray: true }, other: 1 };
		const chunks = encodeWithMemoizedArray(doc, 'sessions');
		expect(chunks).toHaveLength(1);
		expect(concat(chunks)).toBe(confSerialize(doc));
	});

	it('reuses the same bytes when a session object keeps its identity', () => {
		// The whole point: an unchanged session costs no stringify and no UTF-8
		// encode. Mutating in place after the first pass proves the second pass
		// served the memo rather than re-reading the object.
		const session: Record<string, unknown> = { id: 'a', name: 'before' };
		const first = encodeWithMemoizedArray({ sessions: [session] }, 'sessions');
		session.name = 'after';
		const second = encodeWithMemoizedArray({ sessions: [session] }, 'sessions');

		// Chunk 1 is the element itself (chunk 0 is the text before it).
		expect(second[1]).toBe(first[1]);
		expect(concat(second)).toContain('before');
		expect(concat(encodeWithMemoizedArray({ sessions: [{ ...session }] }, 'sessions'))).toContain(
			'after'
		);
	});

	it('emits about one chunk per element plus the text between them', () => {
		const doc = { sessions: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], activeSessionId: 'a' };
		// Separators and sibling keys merge into the text chunks around each
		// element, so the count tracks the element count, not every separator.
		expect(encodeWithMemoizedArray(doc, 'sessions')).toHaveLength(2 * doc.sessions.length + 1);
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

		vi.useFakeTimers();
		try {
			writer.store.set('sessions', [{ id: 'a' }]);
			const flush = writer.flushAsync();
			await vi.advanceTimersByTimeAsync(249);

			// Awaiting durable persistence must not cancel the bounded coalescing window.
			expect(writeFile).not.toHaveBeenCalled();

			await vi.advanceTimersByTimeAsync(1);
			await flush;
			expect(writeFile).toHaveBeenCalledOnce();
			expect(readFile()).toEqual({ sessions: [{ id: 'a' }] });
		} finally {
			vi.useRealTimers();
		}
	});

	it('hands the async write byte chunks, never a string to encode on this thread', async () => {
		// fs.writeFile UTF-8 encodes a string argument in full, synchronously,
		// before its async write begins. On a 72 MB sessions file that encode was
		// the largest main-process stall in a field trace.
		const store = makeStore({ sessions: [] });
		const writer = deferStoreWrites(store, 'sessions');
		const writeFile = vi.spyOn(fsp, 'writeFile');

		writer.store.set('sessions', [{ id: 'a', name: '🎭' }]);
		await writer.flushAsync();

		const data = writeFile.mock.calls[0][1];
		expect(typeof data).not.toBe('string');
		expect(Array.isArray(data)).toBe(true);
		expect(fs.readFileSync(filePath, 'utf-8')).toBe(
			confSerialize({ sessions: [{ id: 'a', name: '🎭' }] })
		);
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

	it('acknowledges a revision whose bytes are already on disk without rewriting it', async () => {
		const store = makeStore({ sessions: [] });
		const writer = deferStoreWrites(store, 'sessions');
		writer.store.set('sessions', [{ id: 'a', logs: ['one'] }]);
		await writer.flushAsync();
		const writeFile = vi.spyOn(fsp, 'writeFile');
		const writeFileSync = vi.spyOn(fs, 'writeFileSync');

		// A peer echoing what the host already saved: new objects, same bytes.
		writer.store.set('sessions', [{ id: 'a', logs: ['one'] }]);
		await writer.flushAsync();
		writer.store.set('sessions', [{ id: 'a', logs: ['one'] }]);
		writer.flushSync();
		expect(writeFile).not.toHaveBeenCalled();
		expect(writeFileSync).not.toHaveBeenCalled();
		expect(writer.hasPendingWrite()).toBe(false);

		writer.store.set('sessions', [{ id: 'a', logs: ['one', 'two'] }]);
		await writer.flushAsync();
		expect(writeFile).toHaveBeenCalledOnce();
		expect(readFile()).toEqual({ sessions: [{ id: 'a', logs: ['one', 'two'] }] });
	});

	it('removes temp files a dead writer left, and keeps live ones and other stores', async () => {
		// Above every platform's pid ceiling, so no process can hold it.
		const deadPid = 4194305;
		const dead = `maestro-sessions.json.${deadPid}.3.tmp`;
		// A pid from another machine sharing a synced folder reads as dead here,
		// so a recent file may still be that machine's write in flight.
		const recent = `maestro-sessions.json.${deadPid}.4.tmp`;
		const own = `maestro-sessions.json.${process.pid}.1.tmp`;
		const liveCli = `maestro-sessions.json.${process.ppid}.1.tmp`;
		const otherStore = `maestro-groups.json.${deadPid}.1.tmp`;
		fs.writeFileSync(filePath, '{}');
		const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
		for (const name of [dead, recent, own, liveCli, otherStore]) {
			fs.writeFileSync(path.join(dir, name), '');
			if (name !== recent) fs.utimesSync(path.join(dir, name), twoHoursAgo, twoHoursAgo);
		}

		await expect(sweepOrphanTempFiles(filePath)).resolves.toBe(1);

		expect(fs.readdirSync(dir).sort()).toEqual(
			['maestro-sessions.json', recent, own, liveCli, otherStore].sort()
		);
	});

	it('looks again, once it is old enough, at a leftover too recent to judge at startup', async () => {
		// A relaunch right after a crash finds the crash's temp file under an hour
		// old; it must not wait for the next launch.
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
		try {
			const store = makeStore({ sessions: [] });
			const leftover = path.join(dir, 'maestro-sessions.json.4194305.9.tmp');
			fs.writeFileSync(leftover, '');
			const minuteAgo = new Date(Date.now() - 60 * 1000);
			fs.utimesSync(leftover, minuteAgo, minuteAgo);

			deferStoreWrites(store, 'sessions');
			await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
			expect(fs.existsSync(leftover)).toBe(true);

			await vi.advanceTimersByTimeAsync(50 * 60 * 1000);
			await vi.waitFor(() => expect(fs.existsSync(leftover)).toBe(false));
		} finally {
			vi.useRealTimers();
		}
	});
});
