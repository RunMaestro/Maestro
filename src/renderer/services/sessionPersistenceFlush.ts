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

type TranscriptFlush = (sessionId: string, tabId: string, boundaryId: string) => Promise<void>;
let flushTranscript: TranscriptFlush | null = null;

/** The native transcript owner registers its IPC acknowledgment fence. Disk persistence
 * alone cannot attest a submitted user row to NativeCurrentTurns. */
export function registerSessionTranscriptFlush(fn: TranscriptFlush | null): void {
	flushTranscript = fn;
}

export function flushSessionTranscriptNow(
	sessionId: string,
	tabId: string,
	boundaryId: string
): Promise<void> {
	if (!flushTranscript) return Promise.reject(new Error('DispatchTranscriptOwnerUnavailable'));
	return flushTranscript(sessionId, tabId, boundaryId);
}

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

type BatchedOutputFlush = () => void;
let flushOutput: BatchedOutputFlush | null = null;

/** Wire App's batched output updater (`useBatchedSessionUpdates().flushNow`). `null` on teardown. */
export function registerBatchedOutputFlush(fn: BatchedOutputFlush | null): void {
	flushOutput = fn;
}

/**
 * Land agent output still held in the output batch (up to `DEFAULT_BATCH_FLUSH_INTERVAL`) into the
 * store now. A reader that answers another machine from the store calls it first: a host's turn
 * end reaches a Federation client before this window's exit listener flushes, so a transcript
 * read begun at that end would miss the reply (R29). A no-op when nothing is registered.
 */
export function flushBatchedOutputNow(): void {
	flushOutput?.();
}
