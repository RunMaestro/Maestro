import type { MutableRefObject } from 'react';

/**
 * Snapshot of an in-flight Auto Run, used to flush stats + history when the
 * run is force-killed. Whoever deletes the entry first (the loop's natural
 * cleanup OR `killBatchRun`) is responsible for writing the final history
 * entry and calling `endAutoRun`.
 *
 * This guards against the case where `killBatchRun` calls
 * `timeTracking.stopTracking` (which zeros the tracker) before the loop's
 * cleanup reads it, resulting in a 0 ms duration being recorded.
 */
export interface AutoRunFlushState {
	statsAutoRunId: string | null;
	sessionName: string;
	projectPath: string;
	getCompletedTasks: () => number;
	getTotalTasks: () => number;
	getInputTokens: () => number;
	getOutputTokens: () => number;
	getTotalCost: () => number;
	getDocumentsProcessed: () => number;
}

export type AutoRunFlushStateRefs = MutableRefObject<Record<string, AutoRunFlushState>>;

/**
 * Atomically claim the flush-state entry for `sessionId`: read the current
 * value, delete the slot, return the entry (or `null` if no entry was
 * registered).
 *
 * Both the natural-completion path inside `startBatchRun` and the
 * `killBatchRun` path race for this entry. Centralising the read-and-delete
 * pattern guarantees both call sites use identical semantics, so the
 * "who writes the final history entry / calls endAutoRun / fires onComplete"
 * arbitration cannot drift.
 */
export function claimFlushState(
	refs: AutoRunFlushStateRefs,
	sessionId: string
): AutoRunFlushState | null {
	const entry = refs.current[sessionId] ?? null;
	delete refs.current[sessionId];
	return entry;
}
