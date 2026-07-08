import { useCallback } from 'react';
import type { MutableRefObject } from 'react';
import type { BatchRunState, HistoryEntry } from '../../../types';
import { formatElapsedTime } from '../../../../shared/formatters';
import { logger } from '../../../utils/logger';
import type { BatchAction } from '../batchReducer';
import { claimFlushState, type AutoRunFlushStateRefs } from './batchFlushState';
import type { ErrorResolutionEntry } from './useBatchControlActions';
import type { BatchCompleteInfo } from '../useBatchProcessor';

interface TimeTrackingApi {
	getElapsedTime: (sessionId: string) => number;
	stopTracking: (sessionId: string) => void;
}

export interface UseBatchKillActionDeps {
	broadcastAutoRunState: (sessionId: string, state: BatchRunState | null) => void;
	flushDebouncedUpdate: (sessionId: string) => void;
	dispatch: (action: BatchAction) => void;
	timeTracking: TimeTrackingApi;
	autoRunFlushStateRefs: AutoRunFlushStateRefs;
	errorResolutionRefs: MutableRefObject<Record<string, ErrorResolutionEntry>>;
	stopRequestedRefs: MutableRefObject<Record<string, boolean>>;
	isMountedRef: MutableRefObject<boolean>;
	onAddHistoryEntry: (entry: Omit<HistoryEntry, 'id'>) => void | Promise<void>;
	onComplete?: (info: BatchCompleteInfo) => void;
}

export interface UseBatchKillActionReturn {
	killBatchRun: (sessionId: string) => Promise<void>;
}

/**
 * Force-kill the running Auto Run for a session.
 *
 * Order of operations matters:
 *  - Atomically claim the flush-state ref BEFORE tearing down `timeTracking`,
 *    so the elapsed-time read sees the live tracker (not the zeroed value).
 *  - Write the final history entry + endAutoRun stats from the captured
 *    snapshot, since the natural-loop cleanup would invoke `onComplete` with
 *    `elapsedTimeMs: 0` after `stopTracking`.
 *  - Kill agent processes, set the stop flag, resolve any pending error
 *    resolution promise, flush debounced state updates, dispatch
 *    `COMPLETE_BATCH`, broadcast null to web clients, then `stopTracking`
 *    and `power.removeReason`.
 *
 * `stopRequestedRefs[sessionId]` is intentionally NOT deleted here - the
 * async loop is mid-iteration and re-checks this flag at boundaries.
 * Deleting it before the loop observes it would let the loop spawn a fresh
 * agent for the next task and the kill would effectively do nothing.
 */
export function useBatchKillAction({
	broadcastAutoRunState,
	flushDebouncedUpdate,
	dispatch,
	timeTracking,
	autoRunFlushStateRefs,
	errorResolutionRefs,
	stopRequestedRefs,
	isMountedRef,
	onAddHistoryEntry,
	onComplete,
}: UseBatchKillActionDeps): UseBatchKillActionReturn {
	const killBatchRun = useCallback(
		async (sessionId: string) => {
			// console.assert is a no-op in production builds and silently continues
			// on failure - use logger.warn so the precondition violation reaches
			// the same telemetry pipeline as the rest of this file.
			if (sessionId.includes('-batch-')) {
				logger.warn(
					'[BatchProcessor:killBatchRun] sessionId must not contain "-batch-"',
					undefined,
					{ sessionId }
				);
			}

			// Set the stop flag synchronously, before any await. The processing loop
			// checks this flag at iteration boundaries; setting it early gives the loop
			// the earliest possible chance to exit during the awaits below (stats,
			// history, process enumeration). Intentionally NOT deleted later - see
			// the comment on the trailing power.removeReason call.
			stopRequestedRefs.current[sessionId] = true;

			// 0. Flush Auto Run stats + history BEFORE we tear down timeTracking below.
			//    stopTracking() deletes the tracker, so elapsed time must be captured now.
			//    Atomically claiming the ref ensures the loop's normal cleanup won't double-write.
			const flushState = claimFlushState(autoRunFlushStateRefs, sessionId);
			if (flushState) {
				const elapsedMs = timeTracking.getElapsedTime(sessionId);
				const completedTasks = flushState.getCompletedTasks();
				if (flushState.statsAutoRunId) {
					try {
						await window.maestro.stats.endAutoRun(
							flushState.statsAutoRunId,
							elapsedMs,
							completedTasks
						);
					} catch (statsError) {
						logger.warn(
							'[BatchProcessor:killBatchRun] Failed to end stats tracking:',
							undefined,
							statsError
						);
					}
				}
				try {
					await onAddHistoryEntry({
						type: 'AUTO',
						timestamp: Date.now(),
						summary: `Auto Run killed: ${completedTasks} task${completedTasks !== 1 ? 's' : ''} in ${formatElapsedTime(elapsedMs)}`,
						fullResponse: [
							'**Auto Run Summary**',
							'',
							'- **Status:** Killed by user',
							`- **Tasks Completed:** ${completedTasks}`,
							`- **Total Duration:** ${formatElapsedTime(elapsedMs)}`,
						].join('\n'),
						projectPath: flushState.projectPath,
						sessionId,
						success: false,
						elapsedTimeMs: elapsedMs,
					});
				} catch (historyError) {
					logger.warn(
						'[BatchProcessor:killBatchRun] Failed to add history entry:',
						undefined,
						historyError
					);
				}

				// Fire onComplete here so the kill path records local stats and submits to
				// the leaderboard. The natural-loop cleanup is unreliable for this: it calls
				// timeTracking.stopTracking before reading getElapsedTime, so it would invoke
				// onComplete with elapsedTimeMs:0, which the handler gates out.
				// Wrapped in try/catch so a callback failure can't block process kill or
				// the COMPLETE_BATCH/broadcast/stopTracking cleanup that follows.
				if (isMountedRef.current && onComplete) {
					try {
						onComplete({
							sessionId,
							sessionName: flushState.sessionName,
							completedTasks,
							totalTasks: flushState.getTotalTasks(),
							wasStopped: true,
							elapsedTimeMs: elapsedMs,
							inputTokens: flushState.getInputTokens(),
							outputTokens: flushState.getOutputTokens(),
							totalCostUsd: flushState.getTotalCost(),
							documentsProcessed: flushState.getDocumentsProcessed(),
						});
					} catch (completeError) {
						logger.error(
							'[BatchProcessor:killBatchRun] onComplete callback threw:',
							undefined,
							completeError
						);
					}
				}
			}

			// 1. Kill all active batch processes for this session and wait for termination before cleanup.
			// Batch process session IDs are generated as: `${sessionId}-batch-${timestamp}`.
			try {
				const activeProcesses = await window.maestro.process.getActiveProcesses();
				const batchProcessIds = activeProcesses
					.filter(
						// Intentional scope: kill the root session process and any descendant
						// auto-run task processes prefixed with `${sessionId}-batch-`.
						(proc) =>
							proc.sessionId === sessionId || proc.sessionId.startsWith(`${sessionId}-batch-`)
					)
					.map((proc) => proc.sessionId);

				// Fallback to legacy direct ID in case process listing is stale.
				if (batchProcessIds.length === 0) {
					batchProcessIds.push(sessionId);
				}

				const killResults = await Promise.allSettled(
					batchProcessIds.map((id) => window.maestro.process.kill(id))
				);
				for (const killResult of killResults) {
					if (killResult.status === 'rejected') {
						logger.error(
							'[BatchProcessor:killBatchRun] Failed to kill process:',
							undefined,
							killResult.reason
						);
					}
				}
			} catch (error) {
				logger.error('[BatchProcessor:killBatchRun] Failed to kill process:', undefined, error);
			}

			// 2. (Stop flag was set synchronously at the top of this function, before any await.)

			// 3. Resolve any pending error state
			const errorResolution = errorResolutionRefs.current[sessionId];
			if (errorResolution) {
				errorResolution.resolve('abort');
				delete errorResolutionRefs.current[sessionId];
			}

			// 4. Flush any debounced state updates
			flushDebouncedUpdate(sessionId);

			// 5. Immediately reset batch state
			dispatch({
				type: 'COMPLETE_BATCH',
				sessionId,
				finalSessionIds: [],
			});

			// 6. Broadcast cleared state to web clients
			broadcastAutoRunState(sessionId, null);

			// 7. Clean up tracking
			timeTracking.stopTracking(sessionId);
			// Intentionally do NOT delete stopRequestedRefs[sessionId] here. The async
			// processing loop is still mid-iteration (its in-flight processTask is about
			// to reject because we just killed the process). It re-checks the stop flag
			// at the next iteration boundary. Deleting the flag synchronously here turns
			// it back into `undefined` (falsy) before the loop observes it, so the loop
			// spawns a fresh agent for the next task and the "kill" effectively does
			// nothing. The loop's natural-completion cleanup at the end of startBatchRun
			// handles the delete once it has actually exited.
			//
			// 8. Allow system to sleep
			window.maestro.power.removeReason(`autorun:${sessionId}`);
		},
		[
			autoRunFlushStateRefs,
			broadcastAutoRunState,
			dispatch,
			errorResolutionRefs,
			flushDebouncedUpdate,
			isMountedRef,
			onAddHistoryEntry,
			onComplete,
			stopRequestedRefs,
			timeTracking,
		]
	);

	return { killBatchRun };
}
