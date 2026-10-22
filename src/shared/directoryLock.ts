/**
 * Cross-process mutual exclusion on a lock directory - NODE ONLY (imports `fs`).
 *
 * `atomicWriteJsonSync` (`src/shared/atomicJsonSync.ts`) guarantees a reader
 * never sees half a file, but it does nothing for a read-modify-write: two
 * processes that read the same base and each write their own change lose the
 * loser's update. Several stores are written by BOTH the desktop app and
 * `maestro-cli` (the agent-run store, the consult budget counter), so the
 * read, the change and the write have to happen under one lock that every
 * process honors.
 *
 * Mechanism: an atomic `mkdir` of a lock directory (atomic on POSIX and on
 * Windows, unlike an `open(O_CREAT|O_EXCL)` file, which some network
 * filesystems botch). The holder writes its pid and a unique token inside, so
 * a lock left by a crashed holder can be recognized as stale and stolen, and a
 * holder whose lock was stolen does not delete the thief's lock on its way
 * out. Acquisition is a bounded synchronous spin because the stores it guards
 * are synchronous.
 *
 * The lock is advisory: it holds only between callers that all go through
 * this function for the same directory.
 */

import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_STALE_MS = 30_000;
const RETRY_INTERVAL_MS = 15;

export interface DirectoryLockOptions {
	/** How long to wait for a held lock before throwing. */
	timeoutMs?: number;
	/**
	 * A lock older than this is treated as abandoned by a crashed holder and
	 * stolen. Keep it well above the longest time the guarded work can take.
	 */
	staleMs?: number;
	/** Names the lock in the timeout error (`<label> lock timeout after ...`). */
	label?: string;
}

/** Synchronous sleep, the only portable one in Node (no busy CPU spin). */
export function sleepSync(ms: number): void {
	if (ms <= 0) return;
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** True when an existing lock is older than the stale threshold. */
function isStale(lockDir: string, staleMs: number): boolean {
	try {
		const stat = fs.statSync(lockDir);
		return Date.now() - stat.mtimeMs > staleMs;
	} catch {
		// The lock vanished between the EEXIST and the stat; treat as gone.
		return false;
	}
}

/**
 * Run `fn` while holding the exclusive lock at `lockDir`. Releases the lock
 * even if `fn` throws. Throws if the lock cannot be acquired within the
 * timeout, without running `fn`.
 *
 * The parent of `lockDir` must exist: creating it is the caller's decision,
 * because for some callers a missing data directory is an error to report
 * rather than something to create.
 */
export function withDirectoryLock<T>(
	lockDir: string,
	fn: () => T,
	options: DirectoryLockOptions = {}
): T {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
	const holderPath = path.join(lockDir, 'holder');
	// Unique per acquisition so a holder that was declared stale and stolen by
	// another process does not delete the thief's lock in its own finally.
	const token = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
	const deadline = Date.now() + timeoutMs;

	for (;;) {
		try {
			fs.mkdirSync(lockDir);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
				throw error;
			}
			if (isStale(lockDir, staleMs)) {
				try {
					fs.rmSync(lockDir, { recursive: true, force: true });
				} catch {
					// Another process stole it first; loop and re-contend.
				}
				continue;
			}
			if (Date.now() >= deadline) {
				throw new Error(`${options.label ?? lockDir} lock timeout after ${timeoutMs}ms`);
			}
			sleepSync(RETRY_INTERVAL_MS);
		}
	}

	// Claim ownership with our unique token immediately after creating the dir.
	try {
		fs.writeFileSync(
			holderPath,
			JSON.stringify({ token, pid: process.pid, acquiredAt: Date.now() }),
			'utf-8'
		);
	} catch {
		// The holder marker is advisory; a write failure only weakens stale detection.
	}

	try {
		return fn();
	} finally {
		// Release ONLY if we still own it. If our lock was declared stale and
		// stolen mid-run, the holder token no longer matches ours and deleting
		// the dir would destroy the new owner's lock.
		let owned = true;
		try {
			const holder = JSON.parse(fs.readFileSync(holderPath, 'utf-8')) as { token?: string };
			owned = holder.token === token;
		} catch {
			// No readable holder marker (never written, or already cleared): best-effort delete.
			owned = true;
		}
		if (owned) {
			try {
				fs.rmSync(lockDir, { recursive: true, force: true });
			} catch {
				// Already released or stolen; nothing to do.
			}
		}
	}
}
