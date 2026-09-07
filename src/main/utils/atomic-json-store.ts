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
 * never interleave. Its implementation lives in `src/shared/keyedWriteQueue.ts`
 * (the renderer serializes work too and cannot import `fs/promises`) and is
 * re-exported below, so this stays the import site every main-process caller
 * already uses.
 *
 * This is the canonical home for the pattern that previously lived inline in
 * `group-chat-storage.ts`.
 */

import * as fs from 'fs/promises';
import { assertSerializedJsonIsSafe } from '../../shared/jsonUtils';

/**
 * Atomically write JSON to `filePath` via a temp file + rename. Prevents
 * partial/corrupt reads if the process crashes or another reader/writer lands
 * mid-write. Retries the rename on EPERM/EBUSY (transient Windows file locks
 * from OneDrive/antivirus).
 *
 * Safety gate: `assertSerializedJsonIsSafe` validates the payload BEFORE the
 * temp file is created, so a `JSON.stringify` that produces `undefined` (e.g.
 * passing `undefined`) can never be renamed over an existing good file. We
 * refuse the write instead of destroying data.
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

export { createKeyedWriteQueue, type KeyedWriteQueue } from '../../shared/keyedWriteQueue';
