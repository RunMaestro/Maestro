/**
 * Atomic file writes: a temp file in the same directory, then a rename.
 *
 * `rename()` is atomic on POSIX and effectively atomic on NTFS, so every reader
 * sees the whole old file or the whole new file, never a truncated one, and a
 * crash between the temp write and the rename leaves the original intact. That
 * holds across processes, which matters because the desktop, `maestro-cli`, and
 * a headless runtime all write files that the others read.
 *
 * This is the canonical home of the pattern. `src/main/utils/atomic-json-store.ts`
 * re-exports it, so every main-process caller keeps its existing import. It lives
 * in the library because the headless runtime writes store files with no desktop
 * present (the same hoist, for the same reason, as `keyedWriteQueue`).
 */

import * as fs from 'fs/promises';

import { assertSerializedJsonIsSafe } from '../../jsonUtils';

/** Rename retries on a transient Windows lock: 3 retries at 100, 200, 400 ms. */
const RENAME_MAX_RETRIES = 3;
const RENAME_BASE_DELAY_MS = 100;

let tempSequence = 0;

/**
 * A temp path no other write can be using: unique per process (pid) and per
 * call (sequence), so two writers aimed at the same target never share one.
 *
 * A fixed `${filePath}.tmp` is NOT safe for concurrent writers. Two callers
 * both write the same temp file, the first `rename` moves it into place, and
 * the second `rename` finds nothing to move and throws ENOENT. That is what
 * the history JSONL migration did in the field (MAESTRO-15K): two overlapping
 * `getAllEntriesPaginated` calls each migrated every legacy session at once.
 * The second process matters too: `maestro-cli` writes the same files. Same
 * naming as `tempPathFor` in `src/main/stores/deferred-writes.ts`.
 */
function uniqueTempPath(filePath: string): string {
	return `${filePath}.${process.pid}.${++tempSequence}.tmp`;
}

/**
 * Atomically write JSON to `filePath` via a temp file + rename. Retries the
 * rename on EPERM/EBUSY (transient Windows file locks from OneDrive/antivirus).
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
 * non-JSON payloads (TOML, comment-preserving JSON) or JSON whose exact bytes
 * the caller has already produced (a store file in electron-store's format).
 *
 * Also the write path for line-oriented stores (JSONL history), where the
 * payload is many independent records rather than one document. Callers own
 * validation: unlike `atomicWriteJson` there is no parse-back gate, because the
 * content is not a single parseable value. Never hand this an empty string when
 * the target holds data you care about.
 */
export async function atomicWriteFile(
	filePath: string,
	contents: string | Buffer,
	options?: { mode?: number; durable?: boolean }
): Promise<void> {
	const tmp = uniqueTempPath(filePath);
	try {
		await fs.writeFile(
			tmp,
			contents,
			options?.mode !== undefined || options?.durable
				? { encoding: 'utf-8', mode: options.mode, flush: options.durable ?? false }
				: 'utf-8'
		);
		for (let attempt = 0; attempt <= RENAME_MAX_RETRIES; attempt++) {
			try {
				await fs.rename(tmp, filePath);
				return;
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code;
				if ((code === 'EPERM' || code === 'EBUSY') && attempt < RENAME_MAX_RETRIES) {
					await new Promise((resolve) => setTimeout(resolve, RENAME_BASE_DELAY_MS * 2 ** attempt));
					continue;
				}
				throw err;
			}
		}
	} catch (err) {
		// A unique name is never reused, so a temp file left behind by a failed
		// write would sit there forever. Best effort: the original error is the
		// one worth reporting.
		await fs.unlink(tmp).catch(() => {});
		throw err;
	}
}
