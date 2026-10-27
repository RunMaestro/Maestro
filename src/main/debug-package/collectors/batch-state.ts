/**
 * Batch State Collector
 *
 * Collects Auto Run / batch processing state.
 * - No document content, filenames, paths, or prompts included
 *
 * The state itself is captured in the renderer: Auto Run's live state is
 * in-memory in each app window's `batchStore` and is intentionally not
 * persisted, so there is nothing in any main-process store for this collector
 * to read. The desktop's Create Debug Package passes the clicked window's
 * snapshots in; a package main builds on its own (`maestro-cli
 * support-package`, Feedback's support package) asks every app window first,
 * through `requestAutoRunSnapshots()`, and passes the result here. When no
 * window can answer, the section records why.
 */

import type { AutoRunDebugSnapshot } from '../../../shared/debugPackage';
import type { AutoRunSnapshotResult, AutoRunSnapshotUnavailableReason } from '../autorun-snapshots';

/**
 * Why the section holds no renderer state. `not-requested` is a build that had
 * neither snapshots nor a way to ask for them (a direct
 * `window.maestro.debug.createPackage()` call that bypasses the service).
 */
export type BatchStateUnavailableReason = AutoRunSnapshotUnavailableReason | 'not-requested';

const NOT_REQUESTED_DETAIL =
	'The package was built without asking a Maestro window for Auto Run state.';

export interface BatchStateInfo {
	/**
	 * False when the caller could not supply renderer state (for example a
	 * package generated without a live window). Distinguishes "no Auto Run was
	 * active" from "we could not tell", which is the difference that made the
	 * previous empty section so misleading.
	 */
	snapshotAvailable: boolean;
	/** Set when `snapshotAvailable` is false. */
	unavailableReason?: BatchStateUnavailableReason;
	/** A sentence for a human reader, set with `unavailableReason`. */
	unavailableDetail?: string;
	/**
	 * Set when some app windows answered and others did not: runs owned by the
	 * silent windows are missing from `activeSessions`.
	 */
	windowsUnanswered?: number;
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
 * Collect batch/Auto Run state from renderer-supplied snapshots, or from the
 * result of asking the app windows for them.
 *
 * Sessions with no Auto Run activity are filtered out: a run that never started
 * and has no progress is noise in a support package.
 */
export function collectBatchState(
	source?: AutoRunDebugSnapshot[] | AutoRunSnapshotResult
): BatchStateInfo {
	if (!source) {
		return {
			snapshotAvailable: false,
			unavailableReason: 'not-requested',
			unavailableDetail: NOT_REQUESTED_DETAIL,
			activeSessions: [],
		};
	}
	if (!Array.isArray(source) && !source.available) {
		return {
			snapshotAvailable: false,
			unavailableReason: source.reason,
			unavailableDetail: source.detail,
			activeSessions: [],
		};
	}

	const snapshots = Array.isArray(source) ? source : source.snapshots;
	const windowsUnanswered = Array.isArray(source)
		? 0
		: source.windowsAsked - source.windowsAnswered;

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

	return {
		snapshotAvailable: true,
		...(windowsUnanswered > 0 && { windowsUnanswered }),
		activeSessions,
	};
}
