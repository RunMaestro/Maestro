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
 * The mechanism (an atomic `mkdir`, stale-lock steal, owner-token release) is
 * `withDirectoryLock` in `src/shared/directoryLock.ts`. This module only binds
 * it to the store's lock directory.
 */

import * as fs from 'fs';
import * as path from 'path';
import { withDirectoryLock } from '../../shared/directoryLock';
import { getConfigDirectory } from './storage';

const LOCK_DIR_NAME = 'maestro-agent-store.lock';

function ensureConfigDirectory(): void {
	const dir = getConfigDirectory();
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
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
	ensureConfigDirectory();
	return withDirectoryLock(path.join(getConfigDirectory(), LOCK_DIR_NAME), fn, {
		timeoutMs: options.timeoutMs,
		label: 'agent-run store',
	});
}
