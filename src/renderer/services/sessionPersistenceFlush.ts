/**
 * The one way to force a tracked sessions flush from outside App's hook tree.
 *
 * `useDebouncedPersistence` owns the debounce, the per-session baselines, and
 * the three-way merge with the store. A write that skips it (a raw
 * `sessions.setMany`) leaves the baseline behind, and the next change to the
 * same field can then stop persisting (see the closed-tab design, R1). A
 * service that must answer only after its change is on disk - the CLI's
 * `tab reopen` - goes through here instead. Registered once by App, the same
 * arrangement as `registerBatchResumer`.
 */

import type { Session } from '../types';

type SessionPersistenceFlush = (latestSessions?: Session[]) => Promise<void>;

let flush: SessionPersistenceFlush | null = null;

/** Wire App's `flushNow`. Called with `null` on teardown. */
export function registerSessionPersistenceFlush(fn: SessionPersistenceFlush | null): void {
	flush = fn;
}

/**
 * Persist `latestSessions` (or whatever is pending) now and resolve once the
 * write has finished. Resolves at once when nothing is registered (tests, or
 * before App's effect runs); the debounce then persists the change as usual.
 */
export function flushSessionPersistenceNow(latestSessions?: Session[]): Promise<void> {
	return flush ? flush(latestSessions) : Promise.resolve();
}
