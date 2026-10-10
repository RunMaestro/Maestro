/**
 * Cross-process lock for the agent-run store (F0 write-safety).
 *
 * The store's mutating operations are read-modify-write on shared JSON/JSONL
 * files that BOTH the Electron main process and the CLI (`pianola orchestrate`,
 * `send`, batch) touch. `atomicWriteJson` guarantees no partial file, but two
 * processes interleaving read-then-write still lose the loser's update. This
 * lock serializes every mutation across processes so the last-write-wins race
 * cannot drop a record.
 *
 * Mechanism: an atomic `mkdir` of a lock directory (POSIX + Windows atomic,
 * unlike an `open(O_CREAT|O_EXCL)` file which some network FSes botch). The
 * holder writes its pid + acquire time inside so a crashed holder's stale lock
 * can be detected and stolen. Acquisition is a bounded synchronous spin because
 * the store API is synchronous; the spin sleeps via `Atomics.wait` on a private
 * SharedArrayBuffer (the only portable synchronous sleep in Node).
 *
 * Runtime: `src/cli/` is allowed fs. The pure shared core stays untouched.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getConfigDirectory } from './storage';

const LOCK_DIR_NAME = 'maestro-agent-store.lock';
const DEFAULT_TIMEOUT_MS = 5000;
const RETRY_INTERVAL_MS = 15;
/** A lock older than this is treated as abandoned by a crashed holder. */
const STALE_LOCK_MS = 30_000;

/** Synchronous sleep, the only portable one in Node (no busy CPU spin). */
function sleepSync(ms: number): void {
	if (ms <= 0) return;
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function ensureConfigDirectory(): void {
	const dir = getConfigDirectory();
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
}

/** True when an existing lock is older than the stale threshold. */
function isStale(dir: string): boolean {
	try {
		const stat = fs.statSync(dir);
		return Date.now() - stat.mtimeMs > STALE_LOCK_MS;
	} catch {
		// The lock vanished between the EEXIST and the stat; treat as gone.
		return false;
	}
}

export interface StoreLockOptions {
	timeoutMs?: number;
}

/**
 * Run `fn` while holding the exclusive agent-run store lock. Releases the lock
 * even if `fn` throws. Throws if the lock cannot be acquired within the timeout.
 */
export function withStoreLock<T>(fn: () => T, options: StoreLockOptions = {}): T {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	ensureConfigDirectory();
	const dir = path.join(getConfigDirectory(), LOCK_DIR_NAME);
	const holderPath = path.join(dir, 'holder');
	// Unique per acquisition so a holder that was declared stale and stolen by
	// another process does not delete the thief's lock in its own finally.
	const token = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
	const deadline = Date.now() + timeoutMs;

	for (;;) {
		try {
			fs.mkdirSync(dir);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
				throw error;
			}
			if (isStale(dir)) {
				try {
					fs.rmSync(dir, { recursive: true, force: true });
				} catch {
					// Another process stole it first; loop and re-contend.
				}
				continue;
			}
			if (Date.now() >= deadline) {
				throw new Error(`agent-run store lock timeout after ${timeoutMs}ms`);
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
				fs.rmSync(dir, { recursive: true, force: true });
			} catch {
				// Already released or stolen; nothing to do.
			}
		}
	}
}
