/**
 * Deferred, cached store writes.
 *
 * `maestro-sessions.json` is the app's hottest store file and by far its
 * largest - one entry per agent, each carrying its tabs and the tail of every
 * tab's transcript. A user with dozens of agents runs a 5-10 MB file, and the
 * renderer flushes it every 2 s for the whole duration of any streaming turn
 * (see `useDebouncedPersistence`).
 *
 * electron-store makes that flush brutally expensive, and all of it lands on
 * the main process UI thread - the same thread that dispatches window input
 * events. One `sessions:setMany` costs:
 *
 *   1. `store.get('sessions')`  -> readFileSync + JSON.parse of the WHOLE file
 *   2. `store.set('sessions')`  -> readFileSync + JSON.parse again (conf reads
 *                                  the current document back before merging),
 *                                  then JSON.stringify + writeFileSync
 *
 * That is two full reads, two full parses, one full serialize and one
 * synchronous write per flush. On a 6 MB file that measured 69 ms on an idle
 * machine and 253 ms under load, repeating every couple of seconds. Keystrokes
 * are simply not delivered while it runs, which is why the app becomes
 * un-typeable during streaming while the mouse stays responsive (issue #1501).
 *
 * This module removes all four costs:
 *
 *   - **Read-through cache.** The document is parsed from disk once and kept in
 *     memory. Both reads and both parses disappear.
 *   - **Per-session serialization cache.** Sessions are serialized individually
 *     and memoized in a `WeakMap` keyed by the session OBJECT. The renderer and
 *     every main-process mutator update sessions immutably, so a changed
 *     session arrives as a fresh reference (cache miss) while untouched ones
 *     keep theirs (cache hit). The serialize cost becomes proportional to what
 *     actually changed rather than to the whole file.
 *   - **Async, coalesced write.** Writes are batched behind a short timer and
 *     go out as an async atomic write (temp file + rename), off the UI thread.
 *
 * Safe to cache because the main process is the sole writer of this file: the
 * app takes a single-instance lock, `maestro-sessions.json` is not watched, and
 * maestro-cli only ever READS it (it writes settings and agent-configs, which
 * are deliberately left on the synchronous path).
 *
 * The on-disk format is unchanged - the serializer reproduces conf's
 * tab-indented output byte for byte, so an existing file round-trips
 * identically and anything reading it by hand sees what it saw before.
 */

import fs from 'fs';
import fsp from 'fs/promises';
import type Store from 'electron-store';

import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';

/** Distinguishes temp files created by successive writes. */
let writeSequence = 0;

/** Return a unique sibling temp path for one atomic write. */
function tempPathFor(filePath: string): string {
	return `${filePath}.${process.pid}.${++writeSequence}.tmp`;
}

/**
 * Write `content` to `filePath` atomically: write a sibling temp file, then
 * rename over the target. A crash mid-write leaves the previous document intact
 * rather than a truncated, unparseable store file. Mirrors
 * `writeCueYamlAtomicSync`; kept local so this module owns no dependency conf
 * happens to pull in.
 */
async function writeFileAtomic(
	filePath: string,
	content: string,
	shouldCommit: () => boolean
): Promise<boolean> {
	const tmpPath = tempPathFor(filePath);
	try {
		await fsp.writeFile(tmpPath, content, 'utf-8');
		if (!shouldCommit()) {
			await fsp.unlink(tmpPath).catch(() => {
				// Stale temp cleanup must not turn a newer durable write into failure.
			});
			return false;
		}
		// Keep the commit itself synchronous and on the main thread. rename is a
		// tiny metadata operation, and this makes the revision check + commit one
		// indivisible step with respect to flushSync(): shutdown can either run
		// before this block (and invalidate it) or after it (and overwrite it), but
		// an older async snapshot can never rename over the shutdown snapshot.
		fs.renameSync(tmpPath, filePath);
		return true;
	} catch (err) {
		await fsp.unlink(tmpPath).catch(() => {
			// ignore - the original file is still intact
		});
		throw err;
	}
}

/** Synchronous counterpart of {@link writeFileAtomic}, for the quit path. */
function writeFileAtomicSync(filePath: string, content: string): void {
	const tmpPath = tempPathFor(filePath);
	try {
		fs.writeFileSync(tmpPath, content, 'utf-8');
		fs.renameSync(tmpPath, filePath);
	} catch (err) {
		try {
			fs.unlinkSync(tmpPath);
		} catch {
			// ignore - the original file is still intact
		}
		throw err;
	}
}

/**
 * How long a write sits pending before it goes to disk. Long enough to collapse
 * a burst (`sessions:setMany` immediately followed by `setActiveSessionId`)
 * into one write, short enough that a hard kill loses nothing a user would
 * notice - the renderer's own debounce ahead of this is already 2 s.
 */
const WRITE_COALESCE_MS = 250;

/** Backoff before retrying a write that failed with a recoverable errno. */
const WRITE_RETRY_MS = 5_000;

/** Filesystem errors that a later retry can plausibly recover from. */
const RECOVERABLE_WRITE_CODES = new Set(['ENOSPC', 'ENFILE', 'EMFILE', 'EBUSY', 'EAGAIN']);

/**
 * Memoized JSON for a single session, keyed by the session object itself.
 *
 * Keyed by reference rather than by id on purpose: an id-keyed cache would go
 * stale the moment a session changed, and would need every mutator to
 * invalidate it. Reference identity gets that for free - a mutated session is a
 * different object, so it simply misses. A WeakMap also lets removed sessions
 * fall out with no bookkeeping.
 *
 * Module-scoped so a re-wrapped store (tests) keeps the memo.
 */
const serializedByValue = new WeakMap<object, string>();

export interface DeferredWriteStore<T extends Record<string, any>> {
	/** The wrapped store. Same instance - `get`/`set` are patched in place. */
	store: Store<T>;
	/** True while any revision is scheduled, in flight, or not yet durable. */
	hasPendingWrite(): boolean;
	/** Write any pending document synchronously. For the quit path. */
	flushSync(): void;
	/** Write pending revisions now and resolve when durable. For IPC and tests. */
	flushAsync(): Promise<void>;
}

/** Indent every line of `json` after the first by `depth` tabs. */
function indentJson(json: string, depth: number): string {
	if (depth <= 0) return json;
	const pad = '\t'.repeat(depth);
	return json.split('\n').join(`\n${pad}`);
}

/** Serialize one array element, reusing the memo when the object is unchanged. */
function serializeElement(value: unknown): string | undefined {
	// Only objects can be WeakMap keys. Primitives are cheap anyway.
	if (typeof value !== 'object' || value === null) {
		return JSON.stringify(value, undefined, '\t');
	}
	const cached = serializedByValue.get(value);
	if (cached !== undefined) return cached;
	const json = JSON.stringify(value, undefined, '\t');
	// `undefined` (a non-serializable value) is not cacheable and JSON.stringify
	// renders such array slots as `null` anyway - let the caller handle it.
	if (json === undefined) return undefined;
	serializedByValue.set(value, json);
	return json;
}

/**
 * Serialize `data` exactly as conf would (`JSON.stringify(data, undefined,
 * '\t')`), but reusing memoized JSON for the elements of `memoKey`'s array.
 *
 * Falls back to a plain stringify whenever the shape is not the one this
 * optimization understands, so a surprising document is never mis-serialized.
 */
export function serializeWithMemoizedArray(data: unknown, memoKey: string): string {
	if (typeof data !== 'object' || data === null || Array.isArray(data)) {
		return JSON.stringify(data, undefined, '\t');
	}
	const record = data as Record<string, unknown>;
	const items = record[memoKey];
	if (!Array.isArray(items)) {
		return JSON.stringify(data, undefined, '\t');
	}

	const parts: string[] = [];
	for (const [key, value] of Object.entries(record)) {
		let json: string | undefined;
		if (key === memoKey) {
			// Array elements sit at depth 2; `undefined` elements render as `null`,
			// matching JSON.stringify's array behaviour.
			const elements = items.map((item) => {
				const element = serializeElement(item);
				return `\t\t${indentJson(element ?? 'null', 2)}`;
			});
			json = elements.length === 0 ? '[]' : `[\n${elements.join(',\n')}\n\t]`;
		} else {
			const plain = JSON.stringify(value, undefined, '\t');
			// A key whose value is not serializable (undefined, a function) is
			// omitted from the object entirely - same as JSON.stringify.
			if (plain === undefined) continue;
			json = indentJson(plain, 1);
		}
		parts.push(`\t${JSON.stringify(key)}: ${json}`);
	}

	return parts.length === 0 ? '{}' : `{\n${parts.join(',\n')}\n}`;
}

/**
 * Patch `store` so reads are served from memory and writes are batched to disk
 * asynchronously.
 *
 * `get` and `set` are replaced with own properties on the instance, shadowing
 * conf's prototype methods for this store only - the same technique
 * `trackStoreWrites` uses. Every other conf method keeps working against the
 * real file; none of the mutators beyond `set` are used on this store, and
 * `delete`/`clear` are patched too so the cache cannot drift if one ever is.
 *
 * @param memoKey Property whose array elements get per-element serialization
 *                memoization (`'sessions'`).
 */
export function deferStoreWrites<T extends Record<string, any>>(
	store: Store<T>,
	memoKey: string
): DeferredWriteStore<T> {
	const target = store as unknown as Record<string, unknown>;
	const originalGet = store.get.bind(store);

	// Seed from disk once. `store.store` is conf's full-document read; from here
	// on it is never called again, so the file is parsed exactly once per boot.
	let document: Record<string, unknown> = { ...(store.store as Record<string, unknown>) };

	let writeTimer: NodeJS.Timeout | null = null;
	let writeTimerDelayMs = 0;
	let writeTimerReady: Promise<void> | null = null;
	let resolveWriteTimer: (() => void) | null = null;
	let documentRevision = 0;
	let durableRevision = 0;
	let writeInFlight: Promise<void> | null = null;

	/** Mark the current revision dirty and arrange a future ordered drain. */
	function scheduleWrite(delayMs: number = WRITE_COALESCE_MS): void {
		if (writeTimer) return;
		writeTimerDelayMs = delayMs;
		writeTimerReady = new Promise<void>((resolve) => {
			resolveWriteTimer = resolve;
		});
		writeTimer = setTimeout(() => {
			writeTimer = null;
			writeTimerDelayMs = 0;
			const resolveTimer = resolveWriteTimer;
			resolveWriteTimer = null;
			writeTimerReady = null;
			// Errors are logged inside the drain. A detached timer has nobody to
			// report them to; explicit flushAsync callers receive the rejection.
			const write = runWrite();
			resolveTimer?.();
			void write.catch(() => {});
		}, delayMs);
		// Never hold the event loop open just to flush a store.
		writeTimer.unref?.();
	}

	/** Cancel a scheduled timer and release callers waiting for its turn. */
	function cancelWriteTimer(): void {
		if (!writeTimer) return;
		clearTimeout(writeTimer);
		writeTimer = null;
		writeTimerDelayMs = 0;
		const resolveTimer = resolveWriteTimer;
		resolveWriteTimer = null;
		writeTimerReady = null;
		resolveTimer?.();
	}

	/** Serialize the current document. Throws only on a genuinely broken value. */
	function serialize(): string {
		return serializeWithMemoizedArray(document, memoKey);
	}

	/** Log a failed write and schedule a retry when the errno may recover. */
	function handleWriteError(err: unknown): void {
		const code = (err as NodeJS.ErrnoException)?.code;
		if (code && RECOVERABLE_WRITE_CODES.has(code)) {
			// Transient - the disk is full or fds are exhausted. Keep the document
			// dirty and retry; the renderer's next flush would re-dirty it anyway,
			// but an idle app must not silently drop the last write.
			logger.warn(`Deferred store write failed (${code}), retrying`, 'Sessions');
			scheduleWrite(WRITE_RETRY_MS);
			return;
		}
		// Unexpected. Per CLAUDE.md this belongs in Sentry rather than a swallow,
		// but it must not take the app down from a detached timer callback.
		logger.error(`Deferred store write failed: ${(err as Error)?.message}`, 'Sessions', err);
		void captureException(err, { store: store.path });
	}

	/**
	 * Drain dirty revisions through one promise, in snapshot order. Mutations
	 * arriving during an await are picked up by the next loop iteration instead
	 * of starting a concurrent atomic write.
	 */
	function runWrite(): Promise<void> {
		if (writeInFlight) return writeInFlight;

		const drain = (async () => {
			while (durableRevision < documentRevision) {
				const snapshotRevision = documentRevision;
				let data: string;
				try {
					data = serialize();
				} catch (err) {
					handleWriteError(err);
					throw err;
				}

				try {
					const committed = await writeFileAtomic(
						store.path,
						data,
						() => snapshotRevision > durableRevision
					);
					if (committed) durableRevision = snapshotRevision;
				} catch (err) {
					handleWriteError(err);
					throw err;
				}
			}
		})();

		writeInFlight = drain;
		// Clear the shared pointer on either outcome without creating an unhandled
		// rejected promise (which `.finally()` would do when its return is ignored).
		void drain.then(
			() => {
				if (writeInFlight === drain) writeInFlight = null;
			},
			() => {
				if (writeInFlight === drain) writeInFlight = null;
			}
		);
		return drain;
	}

	/** Persist the newest document synchronously, including during an async write. */
	function flushSync(): void {
		cancelWriteTimer();
		if (durableRevision >= documentRevision && !writeInFlight) return;
		const snapshotRevision = documentRevision;
		try {
			writeFileAtomicSync(store.path, serialize());
			// This also invalidates any older async snapshot whose temp-file write
			// is still in flight; its guarded commit will discard that temp file.
			durableRevision = snapshotRevision;
		} catch (err) {
			// Nothing left to retry with - the process is on its way out.
			logger.error(
				`Failed to flush ${store.path} on shutdown: ${(err as Error)?.message}`,
				'Sessions',
				err
			);
		}
	}

	/**
	 * Resolve only after the latest revision lands. The ordinary coalescing
	 * delay is deliberately preserved so an IPC acknowledgement does not move
	 * serialization back into the caller's event-loop turn. A long retry delay
	 * is skipped when a caller explicitly asks for another durability attempt.
	 */
	async function flushAsync(): Promise<void> {
		const timerReady = writeTimerReady;
		if (timerReady && writeTimerDelayMs <= WRITE_COALESCE_MS) {
			await timerReady;
		} else {
			cancelWriteTimer();
		}
		await runWrite();
	}

	/** Replace one electron-store method on this instance only. */
	function patch(name: string, value: (...args: never[]) => unknown): void {
		Object.defineProperty(target, name, { value, writable: true, configurable: true });
	}

	patch('get', (key: string, defaultValue?: unknown) => {
		if (typeof key !== 'string') return originalGet(key as never, defaultValue as never);
		const value = document[key];
		if (value === undefined) return defaultValue;
		// Hand out a shallow copy of arrays so a caller that sorts or splices the
		// result in place cannot corrupt the cache. Element identity is preserved,
		// which is what the serialization memo keys on.
		return Array.isArray(value) ? [...value] : value;
	});

	patch('set', (keyOrObject: string | Record<string, unknown>, value?: unknown) => {
		if (typeof keyOrObject === 'object' && keyOrObject !== null) {
			document = { ...document, ...keyOrObject };
		} else if (typeof keyOrObject === 'string') {
			document = { ...document, [keyOrObject]: value };
		} else {
			throw new TypeError(
				`Expected \`key\` to be of type \`string\` or \`object\`, got ${typeof keyOrObject}`
			);
		}
		documentRevision += 1;
		scheduleWrite();
	});

	patch('delete', (key: string) => {
		if (!(key in document)) return;
		const next = { ...document };
		delete next[key];
		document = next;
		documentRevision += 1;
		scheduleWrite();
	});

	patch('clear', () => {
		document = {};
		documentRevision += 1;
		scheduleWrite();
	});

	patch('has', (key: string) => key in document);

	return {
		store,
		hasPendingWrite: () =>
			durableRevision < documentRevision || writeTimer !== null || writeInFlight !== null,
		flushSync,
		flushAsync,
	};
}
