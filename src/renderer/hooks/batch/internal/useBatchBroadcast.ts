import { useCallback } from 'react';
import type { BatchRunState } from '../../../types';
import { useBatchStore } from '../../../stores/batchStore';
import { DEFAULT_BATCH_STATE, type BatchAction } from '../batchReducer';
import { useSessionDebounce } from '../useSessionDebounce';
import { logger } from '../../../utils/logger';

const BATCH_STATE_DEBOUNCE_MS = 200;

export interface UseBatchBroadcastDeps {
	dispatch: (action: BatchAction) => void;
}

export interface UseBatchBroadcastReturn {
	broadcastAutoRunState: (sessionId: string, state: BatchRunState | null) => void;
	updateBatchStateAndBroadcast: (
		sessionId: string,
		updater: (prev: Record<string, BatchRunState>) => Record<string, BatchRunState>,
		immediate?: boolean
	) => void;
	flushDebouncedUpdate: (sessionId: string) => void;
}

/**
 * Owns the web/mobile bridge: synchronous state broadcasts plus the
 * debounced `updateBatchStateAndBroadcast` wrapper used by the runner.
 *
 * Critical state changes (isRunning, errors) bypass the debounce via the
 * `immediate` flag; rapid progress updates are coalesced by
 * `BATCH_STATE_DEBOUNCE_MS` to keep React re-renders manageable during
 * task-heavy bursts.
 */
export function useBatchBroadcast({ dispatch }: UseBatchBroadcastDeps): UseBatchBroadcastReturn {
	/**
	 * Broadcast Auto Run state to web interface immediately (synchronously).
	 * This bypasses React's render cycle so mobile clients receive updates
	 * without waiting for a re-render.
	 */
	const broadcastAutoRunState = useCallback((sessionId: string, state: BatchRunState | null) => {
		if (
			state &&
			(state.isRunning || state.completedTasks > 0 || state.completedTasksAcrossAllDocs > 0)
		) {
			window.maestro.web.broadcastAutoRunState(sessionId, {
				isRunning: state.isRunning,
				totalTasks: state.totalTasks,
				completedTasks: state.completedTasks,
				currentTaskIndex: state.currentTaskIndex,
				isStopping: state.isStopping,
				totalDocuments: state.documents?.length ?? 0,
				currentDocumentIndex: state.currentDocumentIndex,
				totalTasksAcrossAllDocs: state.totalTasksAcrossAllDocs,
				completedTasksAcrossAllDocs: state.completedTasksAcrossAllDocs,
				errorPaused: state.errorPaused,
				errorMessage: state.error?.message,
				errorType: state.error?.type,
				errorRecoverable: state.error?.recoverable,
				errorDocumentIndex: state.errorDocumentIndex,
				errorTaskDescription: state.errorTaskDescription,
				// Goal-Driven mode - web/mobile render goal percent + iteration in
				// place of task counts when goalMode is true.
				goalMode: state.goalMode,
				goalProgress: state.goalProgress,
				goalRationale: state.goalRationale,
				goalIteration: state.goalIteration,
			});
		} else {
			window.maestro.web.broadcastAutoRunState(sessionId, null);
		}
	}, []);

	const { scheduleUpdate: scheduleDebouncedUpdate, flushUpdate: flushDebouncedUpdate } =
		useSessionDebounce<Record<string, BatchRunState>>({
			delayMs: BATCH_STATE_DEBOUNCE_MS,
			onUpdate: useCallback(
				(
					sessionId: string,
					updater: (prev: Record<string, BatchRunState>) => Record<string, BatchRunState>
				) => {
					let newStateForSession: BatchRunState | null = null;

					try {
						const currentState = useBatchStore.getState().batchRunStates;
						const newState = updater(currentState);
						newStateForSession = newState[sessionId] || null;

						if (newStateForSession) {
							const prevSessionState = currentState[sessionId] || DEFAULT_BATCH_STATE;

							dispatch({
								type: 'UPDATE_PROGRESS',
								sessionId,
								payload: {
									currentDocumentIndex:
										newStateForSession.currentDocumentIndex !==
										prevSessionState.currentDocumentIndex
											? newStateForSession.currentDocumentIndex
											: undefined,
									currentDocTasksTotal:
										newStateForSession.currentDocTasksTotal !==
										prevSessionState.currentDocTasksTotal
											? newStateForSession.currentDocTasksTotal
											: undefined,
									currentDocTasksCompleted:
										newStateForSession.currentDocTasksCompleted !==
										prevSessionState.currentDocTasksCompleted
											? newStateForSession.currentDocTasksCompleted
											: undefined,
									totalTasksAcrossAllDocs:
										newStateForSession.totalTasksAcrossAllDocs !==
										prevSessionState.totalTasksAcrossAllDocs
											? newStateForSession.totalTasksAcrossAllDocs
											: undefined,
									completedTasksAcrossAllDocs:
										newStateForSession.completedTasksAcrossAllDocs !==
										prevSessionState.completedTasksAcrossAllDocs
											? newStateForSession.completedTasksAcrossAllDocs
											: undefined,
									totalTasks:
										newStateForSession.totalTasks !== prevSessionState.totalTasks
											? newStateForSession.totalTasks
											: undefined,
									completedTasks:
										newStateForSession.completedTasks !== prevSessionState.completedTasks
											? newStateForSession.completedTasks
											: undefined,
									currentTaskIndex:
										newStateForSession.currentTaskIndex !== prevSessionState.currentTaskIndex
											? newStateForSession.currentTaskIndex
											: undefined,
									sessionIds:
										newStateForSession.sessionIds !== prevSessionState.sessionIds
											? newStateForSession.sessionIds
											: undefined,
									accumulatedElapsedMs:
										newStateForSession.accumulatedElapsedMs !==
										prevSessionState.accumulatedElapsedMs
											? newStateForSession.accumulatedElapsedMs
											: undefined,
									lastActiveTimestamp:
										newStateForSession.lastActiveTimestamp !== prevSessionState.lastActiveTimestamp
											? newStateForSession.lastActiveTimestamp
											: undefined,
									loopIteration:
										newStateForSession.loopIteration !== prevSessionState.loopIteration
											? newStateForSession.loopIteration
											: undefined,
									// Goal-Driven mode fields (only ever change in goal mode)
									goalMode:
										newStateForSession.goalMode !== prevSessionState.goalMode
											? newStateForSession.goalMode
											: undefined,
									goalProgress:
										newStateForSession.goalProgress !== prevSessionState.goalProgress
											? newStateForSession.goalProgress
											: undefined,
									goalRationale:
										newStateForSession.goalRationale !== prevSessionState.goalRationale
											? newStateForSession.goalRationale
											: undefined,
									goalIteration:
										newStateForSession.goalIteration !== prevSessionState.goalIteration
											? newStateForSession.goalIteration
											: undefined,
									goalExitReason:
										newStateForSession.goalExitReason !== prevSessionState.goalExitReason
											? newStateForSession.goalExitReason
											: undefined,
								},
							});
						}

						broadcastAutoRunState(sessionId, newStateForSession);
					} catch (error) {
						logger.error('[BatchProcessor:onUpdate] ERROR in debounce callback:', undefined, error);
					}
				},
				[broadcastAutoRunState, dispatch]
			),
		});

	const updateBatchStateAndBroadcast = useCallback(
		(
			sessionId: string,
			updater: (prev: Record<string, BatchRunState>) => Record<string, BatchRunState>,
			immediate: boolean = false
		) => {
			scheduleDebouncedUpdate(sessionId, updater, immediate);
		},
		[scheduleDebouncedUpdate]
	);

	return {
		broadcastAutoRunState,
		updateBatchStateAndBroadcast,
		flushDebouncedUpdate,
	};
}
