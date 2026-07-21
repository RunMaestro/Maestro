/**
 * Atomic JSON file I/O + per-key write serialization.
 *
 * Two failure modes plague the app's many per-entity JSON stores (history,
 * group-chat metadata, ...), both stemming from concurrent writers racing on a
 * single file with a plain `fs.writeFile`:
 *
 *  1. Partial / concatenated reads. `writeFile` truncates then streams bytes,
 *     so a reader (or a second writer's read-modify-write) that lands mid-write
 *     sees a truncated or `}{`-concatenated file. Parsing fails, and the
 *     caller's recovery path typically discards the file - silently destroying
 *     the accumulated data.
 *  2. Lost updates. Two read-modify-write callers read the same base, each
 *     appends its own entry, and the later writer clobbers the earlier one.
 *
 * `atomicWriteJson` fixes (1): write to a temp file, then `rename` over the
 * target. rename() is atomic on POSIX and effectively atomic on NTFS, so every
 * reader sees either the whole old file or the whole new file - never a partial
 * one. This holds across processes too, which matters because both the desktop
 * app and `maestro-cli` write the same history files.
 *
 * `createKeyedWriteQueue` fixes (2) within a process: it serializes every
 * mutation for a given key (e.g. a session id) so read-modify-write sequences
 * never interleave.
 *
 * This is the canonical home for the pattern that previously lived inline in
 * `group-chat-storage.ts`.
 */

import * as fs from 'fs/promises';
import * as fsSync from 'fs';

/**
 * Guard a serialized JSON payload before it can replace an on-disk file.
 * `JSON.stringify` returns `undefined` for `undefined`/functions/symbols, which
 * `writeFile` would persist as the literal string "undefined" - unparseable,
 * and a silent way to clobber good data. We also reject the empty string. The
 * round-trip `JSON.parse` is a cheap final integrity check.
 */
function assertSerializedJsonIsSafe(serialized: string | undefined, filePath: string): void {
	if (serialized === undefined || serialized.length === 0) {
		throw new Error(`Refusing to write empty/undefined JSON to ${filePath}`);
	}
	try {
		JSON.parse(serialized);
	} catch (err) {
		throw new Error(`Refusing to write unparseable JSON to ${filePath}: ${err}`);
	}
}

/**
 * Atomically write JSON to `filePath` via a temp file + rename. Prevents
 * partial/corrupt reads if the process crashes or another reader/writer lands
 * mid-write. Retries the rename on EPERM/EBUSY (transient Windows file locks
 * from OneDrive/antivirus).
 *
 * Safety gate: the serialized payload is validated (non-empty, parses back)
 * BEFORE the temp file is created, so a `JSON.stringify` that produces
 * `undefined` (e.g. passing `undefined`) or otherwise unparseable output can
 * never be renamed over an existing good file. We refuse the write instead of
 * destroying data.
 */
export async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
	const serialized = JSON.stringify(data, null, 2);
	assertSerializedJsonIsSafe(serialized, filePath);
	await atomicWriteFile(filePath, serialized);
}

/**
 * Atomically write arbitrary string contents to `filePath` via a temp file +
 * rename, with the same EPERM/EBUSY retry behavior as atomicWriteJson. Use for
 * non-JSON payloads (TOML, comment-preserving JSON) where the caller has already
 * produced the exact bytes to persist. A crash mid-write leaves the original
 * file intact instead of truncating it.
 */
export async function atomicWriteFile(
	filePath: string,
	contents: string,
	options?: { mode?: number }
): Promise<void> {
	const tmp = `${filePath}.tmp`;
	await fs.writeFile(
		tmp,
		contents,
		options?.mode !== undefined ? { encoding: 'utf-8', mode: options.mode } : 'utf-8'
	);
	const maxRetries = 3;
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			await fs.rename(tmp, filePath);
			return;
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if ((code === 'EPERM' || code === 'EBUSY') && attempt < maxRetries) {
				await new Promise((resolve) => setTimeout(resolve, 100 * Math.pow(2, attempt)));
				continue;
			}
			throw err;
		}
	}
}

/**
 * Synchronous twin of {@link atomicWriteFile}: write `contents` to a sibling
 * `.tmp` file, then `renameSync` over the target. A crash (or a concurrent
 * reader) mid-write sees either the whole old file or the whole new file, never
 * a truncated one. On failure the temp file is removed on a best-effort basis
 * and the error is rethrown so the caller can surface it - the original file is
 * left intact either way.
 *
 * Exists because several stores (`.maestro/cue.yaml`, `.maestro/board.yaml`,
 * `.maestro/profiles.yaml`) are read and written synchronously by the CLI, the
 * dispatcher, and IPC alike; making them async would cascade through those
 * call chains for no correctness gain.
 */
export function atomicWriteFileSync(filePath: string, contents: string): void {
	const tmpPath = `${filePath}.tmp`;
	try {
		fsSync.writeFileSync(tmpPath, contents, 'utf-8');
		fsSync.renameSync(tmpPath, filePath);
	} catch (err) {
		try {
			fsSync.unlinkSync(tmpPath);
		} catch {
			// ignore - the original file is still intact
		}
		throw err;
	}
}

/** Enqueue an async callback, serialized against others sharing the same key. */
export interface KeyedWriteQueue {
	enqueue<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

/**
 * Create an independent per-key write queue. Each key (e.g. a session id) gets
 * its own promise chain, so callers mutating the same file run strictly one at
 * a time while different keys still run concurrently. Queue entries are cleaned
 * up once settled to keep the backing Map bounded in long-lived processes.
 */
export function createKeyedWriteQueue(): KeyedWriteQueue {
	const queues = new Map<string, Promise<void>>();

	function enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
		const prev = queues.get(key) ?? Promise.resolve();
		// Run fn regardless of whether the prior write resolved or rejected.
		const next = prev.then(fn, fn);
		const settled = next.then(
			() => {},
			() => {}
		);
		queues.set(key, settled);
		settled.then(() => {
			if (queues.get(key) === settled) {
				queues.delete(key);
			}
		});
		return next;
	}

	return { enqueue };
}
