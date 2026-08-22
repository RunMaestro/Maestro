/**
 * Batch State Collector
 *
 * Collects Auto Run / batch processing state.
 * - No document content, filenames, paths, or prompts included
 *
 * The state itself is captured in the renderer and passed in: Auto Run's live
 * state is in-memory in `batchStore` and is intentionally not persisted, so
 * there is nothing in any main-process store for this collector to read. It
 * previously read a `session.batchRunState` field that nothing has ever
 * written, so every package shipped an empty section.
 */

import type { AutoRunDebugSnapshot } from '../../../shared/debugPackage';

export interface BatchStateInfo {
	/**
	 * False when the caller could not supply renderer state (for example a
	 * package generated without a live window). Distinguishes "no Auto Run was
	 * active" from "we could not tell", which is the difference that made the
	 * previous empty section so misleading.
	 */
	snapshotAvailable: boolean;
	activeSessions: Array<
		AutoRunDebugSnapshot & {
			/** Wall-clock time since the run started, at collection time. */
			elapsedMs?: number;
			/** Time since the run last reported activity, at collection time. */
			idleMs?: number;
		}
	>;
}

/**
 * Collect batch/Auto Run state from a renderer-supplied snapshot.
 *
 * Sessions with no Auto Run activity are filtered out: a run that never started
 * and has no progress is noise in a support package.
 */
export function collectBatchState(snapshots?: AutoRunDebugSnapshot[]): BatchStateInfo {
	if (!snapshots) {
		return { snapshotAvailable: false, activeSessions: [] };
	}

	const now = Date.now();
	const activeSessions = snapshots
		.filter(
			(s) =>
				s.isRunning ||
				s.isStopping ||
				s.hasError ||
				s.errorPaused ||
				s.completedTasksAcrossAllDocs > 0
		)
		.map((s) => ({
			...s,
			elapsedMs: s.startTime ? now - s.startTime : undefined,
			idleMs: s.lastActiveTimestamp ? now - s.lastActiveTimestamp : undefined,
		}));

	return { snapshotAvailable: true, activeSessions };
}
