import { useCallback } from 'react';
import type { MutableRefObject } from 'react';
import type { AgentError, BatchRunState } from '../../../types';
import { useBatchStore } from '../../../stores/batchStore';
import type { BatchAction } from '../batchReducer';

export type ErrorResolutionAction = 'resume' | 'skip-document' | 'abort';

export interface ErrorResolutionEntry {
	promise: Promise<ErrorResolutionAction>;
	resolve: (action: ErrorResolutionAction) => void;
}

export interface UseBatchControlActionsDeps {
	broadcastAutoRunState: (sessionId: string, state: BatchRunState | null) => void;
	dispatch: (action: BatchAction) => void;
	errorResolutionRefs: MutableRefObject<Record<string, ErrorResolutionEntry>>;
	stopRequestedRefs: MutableRefObject<Record<string, boolean>>;
	isMountedRef: MutableRefObject<boolean>;
}

export interface UseBatchControlActionsReturn {
	stopBatchRun: (sessionId: string) => void;
	pauseBatchOnError: (
		sessionId: string,
		error: AgentError,
		documentIndex: number,
		taskDescription?: string
	) => void;
	skipCurrentDocument: (sessionId: string) => void;
	resumeAfterError: (sessionId: string) => void;
	abortBatchOnError: (sessionId: string) => void;
}

/**
 * External lifecycle controls: stop the run, or resolve the in-flight
 * error-resolution promise that the runner awaits when an agent error
 * pauses execution mid-task.
 *
 * All five actions share the `errorResolutionRefs` registry and dispatch
 * `SET_STOPPING` / `SET_ERROR` / `CLEAR_ERROR` actions directly (not via
 * the debounced UPDATE_PROGRESS path), so they live in one hook.
 */
export function useBatchControlActions({
	broadcastAutoRunState,
	dispatch,
	errorResolutionRefs,
	stopRequestedRefs,
	isMountedRef,
}: UseBatchControlActionsDeps): UseBatchControlActionsReturn {
	/**
	 * Request to stop the batch run after the current task completes.
	 * No `isMountedRef` check - stop requests should always be honoured.
	 * All operations are safe: ref updates, reducer dispatch, broadcast.
	 */
	const stopBatchRun = useCallback(
		(sessionId: string) => {
			stopRequestedRefs.current[sessionId] = true;
			const errorResolution = errorResolutionRefs.current[sessionId];
			if (errorResolution) {
				errorResolution.resolve('abort');
				delete errorResolutionRefs.current[sessionId];
			}
			dispatch({ type: 'SET_STOPPING', sessionId });
			const newState = useBatchStore.getState().batchRunStates[sessionId];
			if (newState) {
				broadcastAutoRunState(sessionId, { ...newState, isStopping: true });
			}
		},
		[broadcastAutoRunState, dispatch, errorResolutionRefs, stopRequestedRefs]
	);

	/**
	 * Pause the batch run due to an agent error. Idempotent - if a
	 * resolution promise already exists for the session, it's reused.
	 */
	const pauseBatchOnError = useCallback(
		(sessionId: string, error: AgentError, documentIndex: number, taskDescription?: string) => {
			if (!isMountedRef.current) return;

			window.maestro.logger.autorun(
				`Auto Run paused due to ${error.type}: ${error.message}`,
				sessionId,
				{
					errorType: error.type,
					errorMessage: error.message,
					recoverable: error.recoverable,
					documentIndex,
					taskDescription,
					rawError: error.raw,
				}
			);

			dispatch({
				type: 'SET_ERROR',
				sessionId,
				payload: { error, documentIndex, taskDescription },
			});
			const currentState = useBatchStore.getState().batchRunStates[sessionId];
			if (currentState) {
				broadcastAutoRunState(sessionId, {
					...currentState,
					error,
					errorPaused: true,
					errorDocumentIndex: documentIndex,
					errorTaskDescription: taskDescription,
				});
			}

			if (!errorResolutionRefs.current[sessionId]) {
				let resolvePromise: ((action: ErrorResolutionAction) => void) | undefined;
				const promise = new Promise<ErrorResolutionAction>((resolve) => {
					resolvePromise = resolve;
				});
				errorResolutionRefs.current[sessionId] = {
					promise,
					resolve: resolvePromise as (action: ErrorResolutionAction) => void,
				};
			}
		},
		[broadcastAutoRunState, dispatch, errorResolutionRefs, isMountedRef]
	);

	/**
	 * Skip the current document that triggered an error.
	 */
	const skipCurrentDocument = useCallback(
		(sessionId: string) => {
			if (!isMountedRef.current) return;

			window.maestro.logger.autorun(`Skipping document after error`, sessionId, {});

			dispatch({ type: 'CLEAR_ERROR', sessionId });
			const currentState = useBatchStore.getState().batchRunStates[sessionId];
			if (currentState) {
				broadcastAutoRunState(sessionId, {
					...currentState,
					error: undefined,
					errorPaused: false,
					errorDocumentIndex: undefined,
					errorTaskDescription: undefined,
				});
			}

			const errorResolution = errorResolutionRefs.current[sessionId];
			if (errorResolution) {
				errorResolution.resolve('skip-document');
				delete errorResolutionRefs.current[sessionId];
			}
		},
		[broadcastAutoRunState, dispatch, errorResolutionRefs, isMountedRef]
	);

	/**
	 * Resume the batch run after the user resolves an error.
	 *
	 * AUTO-RESUME (Phase 3): this is the resume entry point the auto-resume
	 * coordinator calls for BOTH spec-driven and goal-driven limit pauses. The
	 * runner parks on the in-memory `errorResolution` promise while paused (the
	 * document/task loop in useBatchRunner and the iteration loop in useGoalRunner
	 * both await `errorResolutionRefs.current[sessionId].promise`); resolving it
	 * with `'resume'` here unblocks the loop with its state fully preserved - no
	 * checkpoint reconstruction needed. Spec-driven already preserved resumable
	 * state via `pauseBatchOnError` + this promise; no gap was found.
	 */
	const resumeAfterError = useCallback(
		(sessionId: string) => {
			if (!isMountedRef.current) return;

			window.maestro.logger.autorun(`Resuming Auto Run after error resolution`, sessionId, {});

			dispatch({ type: 'CLEAR_ERROR', sessionId });
			const currentState = useBatchStore.getState().batchRunStates[sessionId];
			if (currentState) {
				broadcastAutoRunState(sessionId, {
					...currentState,
					error: undefined,
					errorPaused: false,
					errorDocumentIndex: undefined,
					errorTaskDescription: undefined,
				});
			}

			const errorResolution = errorResolutionRefs.current[sessionId];
			if (errorResolution) {
				errorResolution.resolve('resume');
				delete errorResolutionRefs.current[sessionId];
			}
		},
		[broadcastAutoRunState, dispatch, errorResolutionRefs, isMountedRef]
	);

	/**
	 * Abort the run from a paused-error state. SET_STOPPING from PAUSED_ERROR
	 * already clears all error fields in the reducer.
	 */
	const abortBatchOnError = useCallback(
		(sessionId: string) => {
			if (!isMountedRef.current) return;

			window.maestro.logger.autorun(`Auto Run aborted due to error`, sessionId, {});

			stopRequestedRefs.current[sessionId] = true;
			const errorResolution = errorResolutionRefs.current[sessionId];
			if (errorResolution) {
				errorResolution.resolve('abort');
				delete errorResolutionRefs.current[sessionId];
			}

			dispatch({ type: 'SET_STOPPING', sessionId });
			const currentState = useBatchStore.getState().batchRunStates[sessionId];
			if (currentState) {
				broadcastAutoRunState(sessionId, currentState);
			}
		},
		[broadcastAutoRunState, dispatch, errorResolutionRefs, isMountedRef, stopRequestedRefs]
	);

	return {
		stopBatchRun,
		pauseBatchOnError,
		skipCurrentDocument,
		resumeAfterError,
		abortBatchOnError,
	};
}
