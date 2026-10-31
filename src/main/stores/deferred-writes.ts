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
 *     keep theirs (cache hit). What is cached is the session's UTF-8 BYTES, and
 *     the file goes out as those chunks, so the document is never joined into
 *     one string or re-encoded. The serialize cost becomes proportional to what
 *     actually changed rather than to the whole file.
 *   - **Async, coalesced write.** Writes are batched behind a short timer and
 *     go out as an async atomic write (temp file + rename), off the UI thread.
 *   - **No identical rewrites.** The file is still written whole, which is the
 *     cost at scale (one user's store reached 141 MB across 400 agents). A
 *     revision that serializes to the bytes already on disk is acknowledged
 *     without writing, since peers echo saves the host already holds.
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
import path from 'path';
import type Store from 'electron-store';

import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';
import { isPidAlive } from '../process-manager/utils/childProcessInfo';
import {
	encodeWithMemoizedArray,
	serializeWithMemoizedArray,
} from '../../shared/memoizedJsonSerialize';

// Re-exported for existing importers; the implementation lives in shared/ so
// the CLI's agent-run store can use the same memo.
export { serializeWithMemoizedArray };

/** Distinguishes temp files created by successive writes. */
let writeSequence = 0;

/** Return a unique sibling temp path for one atomic write. */
function tempPathFor(filePath: string): string {
	return `${filePath}.${process.pid}.${++writeSequence}.tmp`;
}

/**
 * Write `chunks` to `filePath` atomically: write a sibling temp file, then
 * rename over the target. A crash mid-write leaves the previous document intact
 * rather than a truncated, unparseable store file. Mirrors
 * `writeCueYamlAtomicSync`; kept local so this module owns no dependency conf
 * happens to pull in.
 */
async function writeFileAtomic(
	filePath: string,
	chunks: Uint8Array[],
	shouldCommit: () => boolean
): Promise<boolean> {
	const tmpPath = tempPathFor(filePath);
	try {
		// An iterable of byte chunks goes out one write at a time on the thread
		// pool. A string here would be UTF-8 encoded in full, synchronously, on
		// this thread before the async write even began.
		await fsp.writeFile(tmpPath, chunks);
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

/** A temp file younger than this may be another machine's write in flight. */
const ORPHAN_TEMP_MIN_AGE_MS = 60 * 60 * 1000;

/**
 * Delete temp files that a killed process left between its write and its
 * rename. Nothing else removes them, and each is a full copy of the store
 * (457 MB of them on one machine). A live pid's file may still be in flight
 * (this process, or a CLI write through `atomicWriteJson`), so only files whose
 * writer is gone are removed.
 *
 * The pid only means something on this machine. The store can live in a synced
 * folder another machine also writes, so a recent file is left alone too: a
 * write still in flight is minutes old at most, while a crash leftover is not.
 */
export async function sweepOrphanTempFiles(filePath: string, now = Date.now()): Promise<number> {
	const dir = path.dirname(filePath);
	const prefix = `${path.basename(filePath)}.`;
	let names: string[];
	try {
		names = await fsp.readdir(dir);
	} catch {
		return 0;
	}
	let removed = 0;
	for (const name of names) {
		if (!name.startsWith(prefix)) continue;
		const pid = Number(/^(\d+)\.\d+\.tmp$/.exec(name.slice(prefix.length))?.[1]);
		if (!pid || pid === process.pid || isPidAlive(pid)) continue;
		const tempPath = path.join(dir, name);
		try {
			if (now - (await fsp.stat(tempPath)).mtimeMs < ORPHAN_TEMP_MIN_AGE_MS) continue;
			await fsp.unlink(tempPath);
			removed += 1;
		} catch {
			// Already gone, or not ours to remove. Either way the store is intact.
		}
	}
	return removed;
}

/** Whether two serializations are byte-identical. Unchanged elements share a chunk. */
function sameChunks(a: Uint8Array[], b: Uint8Array[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i] && Buffer.compare(a[i], b[i]) !== 0) return false;
	}
	return true;
}

/** Synchronous counterpart of {@link writeFileAtomic}, for the quit path. */
function writeFileAtomicSync(filePath: string, chunks: Uint8Array[]): void {
	const tmpPath = tempPathFor(filePath);
	try {
		// One copy on the way out is fine on the quit path; nothing is waiting.
		fs.writeFileSync(tmpPath, Buffer.concat(chunks));
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
	// The bytes of the last committed document. A revision that serializes to the
	// same bytes is already durable: on one 141 MB store, three of every five
	// rewrites were byte-identical (a peer echoing a save the host already had).
	let committedChunks: Uint8Array[] | null = null;

	// Best-effort cleanup; a failure leaves the leftovers for the next launch. A
	// leftover too recent to judge at startup (a relaunch right after a crash) is
	// looked at again once it is old enough, instead of at the next launch.
	const sweep = () =>
		void sweepOrphanTempFiles(store.path).then(
			(removed) => {
				if (removed > 0)
					logger.info(`Removed ${removed} orphaned temp file(s) beside ${store.path}`, 'Sessions');
			},
			() => {}
		);
	sweep();
	setTimeout(sweep, ORPHAN_TEMP_MIN_AGE_MS).unref?.();

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

	/**
	 * Serialize the current document to UTF-8 chunks. Throws only on a genuinely
	 * broken value. Bytes rather than a string: on a large store the full-string
	 * join and its UTF-8 encode were the bulk of every flush's main-thread time.
	 */
	function serialize(): Uint8Array[] {
		return encodeWithMemoizedArray(document, memoKey);
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
				let data: Uint8Array[];
				try {
					data = serialize();
				} catch (err) {
					handleWriteError(err);
					throw err;
				}
				if (committedChunks && sameChunks(committedChunks, data)) {
					durableRevision = snapshotRevision;
					continue;
				}

				try {
					const committed = await writeFileAtomic(
						store.path,
						data,
						() => snapshotRevision > durableRevision
					);
					if (committed) {
						durableRevision = snapshotRevision;
						committedChunks = data;
					}
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
			const data = serialize();
			// Unchanged bytes are on disk unless an async write is mid-flight, and
			// that one may be an older snapshot, so only skip when nothing is.
			if (!(committedChunks && !writeInFlight && sameChunks(committedChunks, data))) {
				writeFileAtomicSync(store.path, data);
				committedChunks = data;
			}
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
