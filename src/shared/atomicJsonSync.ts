/**
 * Synchronous atomic JSON write - NODE ONLY (imports `fs`).
 *
 * The synchronous twin of `atomicWriteJson` in
 * `src/main/utils/atomic-json-store.ts`, for the stores that are read and
 * written inside a synchronous critical section (`withDirectoryLock` in
 * `src/shared/directoryLock.ts`) and by `maestro-cli`, which has no event loop
 * to spare for a queue.
 *
 * Write to a temp file, then `rename` over the target. `rename` is atomic on
 * POSIX and effectively atomic on NTFS, so a reader in ANY process sees the
 * whole old file or the whole new one, never a truncated one. It does not stop
 * a lost update between two read-modify-write callers: that needs the lock.
 */

import * as fs from 'fs';
import { sleepSync } from './directoryLock';
import { assertSerializedJsonIsSafe } from './jsonUtils';

/** Transient Windows file locks (antivirus, a sync client) clear in well under a second. */
const RENAME_RETRIES = 3;
const RENAME_RETRY_BASE_MS = 50;

export interface AtomicJsonSyncOptions {
	/** `JSON.stringify` indent. Omit for a single line. */
	indent?: string | number;
	/** End the file with a newline. */
	trailingNewline?: boolean;
	/**
	 * Produce the JSON text in place of `JSON.stringify`, for a caller that can
	 * do it cheaper (a memoized serializer over a large array). It decides the
	 * whole text, so `indent` is not applied to it. The result is checked like
	 * any other payload before it can replace the file.
	 */
	serialize?: (value: unknown) => string;
}

/**
 * Atomically replace `filePath` with `value` serialized as JSON. The parent
 * directory must exist.
 *
 * The payload is checked BEFORE the temp file is created
 * (`assertSerializedJsonIsSafe`), so a value that serializes to nothing can
 * never be renamed over a good file. The temp name carries the pid and the
 * time, so two processes writing the same target never share a temp file.
 */
export function atomicWriteJsonSync(
	filePath: string,
	value: unknown,
	options: AtomicJsonSyncOptions = {}
): void {
	const serialized = options.serialize
		? options.serialize(value)
		: JSON.stringify(value, null, options.indent);
	assertSerializedJsonIsSafe(serialized, filePath);
	const content = options.trailingNewline ? `${serialized}\n` : serialized;
	const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	fs.writeFileSync(tempPath, content, 'utf-8');
	for (let attempt = 0; ; attempt++) {
		try {
			fs.renameSync(tempPath, filePath);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if ((code === 'EPERM' || code === 'EBUSY') && attempt < RENAME_RETRIES) {
				sleepSync(RENAME_RETRY_BASE_MS * Math.pow(2, attempt));
				continue;
			}
			try {
				fs.rmSync(tempPath, { force: true });
			} catch {
				// The temp file is litter at worst; the rename failure is the error to report.
			}
			throw error;
		}
	}
}
