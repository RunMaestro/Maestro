/**
 * Batch State Collector
 *
 * Collects Auto Run / batch processing state.
 * - No document content or prompts included
 */

import Store from 'electron-store';

export interface BatchStateInfo {
	activeSessions: Array<{
		sessionId: string;
		isRunning: boolean;
		isStopping: boolean;
		documentCount: number;
		currentDocumentIndex: number;
		loopEnabled: boolean;
		loopIteration: number;
		worktreeActive: boolean;
		hasError: boolean;
		errorType?: string;
		startTime?: number;
		elapsedMs?: number;
	}>;
}

/**
 * Collect batch/Auto Run state from sessions.
 */
export function collectBatchState(sessionsStore: Store<any>): BatchStateInfo {
	const result: BatchStateInfo = {
		activeSessions: [],
	};

	const sessions = sessionsStore.get('sessions', []) as any[];

	for (const session of sessions) {
		// Check if this session has batch/Auto Run state
		const batchState = session.batchRunState;
		if (batchState) {
			result.activeSessions.push({
				sessionId: session.id || 'unknown',
				isRunning: !!batchState.isRunning,
				isStopping: !!batchState.isStopping,
				documentCount: batchState.documentCount || 0,
				currentDocumentIndex: batchState.currentDocumentIndex || 0,
				loopEnabled: !!batchState.loopEnabled,
				loopIteration: batchState.loopIteration || 0,
				worktreeActive: !!batchState.worktreeActive,
				hasError: !!batchState.error,
				errorType: batchState.error?.type,
				startTime: batchState.startTime,
				elapsedMs: batchState.startTime ? Date.now() - batchState.startTime : undefined,
			});
		}
	}

	return result;
}
