import { useCallback, useMemo } from 'react';
import type { BatchRunState } from '../../../types';
import { useBatchStore, selectHasAnyActiveBatch } from '../../../stores/batchStore';
import { DEFAULT_BATCH_STATE } from '../batchReducer';

export interface UseBatchSelectorsReturn {
	batchRunStates: Record<string, BatchRunState>;
	getBatchState: (sessionId: string) => BatchRunState;
	hasAnyActiveBatch: boolean;
	activeBatchSessionIds: string[];
	stoppingBatchSessionIds: string[];
	customPrompts: Record<string, string>;
	setCustomPrompt: (sessionId: string, prompt: string) => void;
}

/**
 * Reactive selectors over the batch store.
 *
 * `getBatchState` reads from React state (not the ref) because consumers
 * need React to trigger re-renders when state changes. The ref is used
 * internally for synchronous access in debounced callbacks.
 *
 * Array selectors use `useMemo` to avoid infinite re-renders - Zustand's
 * `Object.is` comparison treats freshly-derived arrays as changed and
 * would otherwise produce a render loop.
 */
export function useBatchSelectors(): UseBatchSelectorsReturn {
	const batchRunStates = useBatchStore((s) => s.batchRunStates);
	const customPrompts = useBatchStore((s) => s.customPrompts);
	const hasAnyActiveBatch = useBatchStore(selectHasAnyActiveBatch);

	const getBatchState = useCallback(
		(sessionId: string): BatchRunState => {
			return batchRunStates[sessionId] || DEFAULT_BATCH_STATE;
		},
		[batchRunStates]
	);

	const activeBatchSessionIds = useMemo(
		() =>
			Object.entries(batchRunStates)
				.filter(([, state]) => state.isRunning && !state.errorPaused)
				.map(([sessionId]) => sessionId),
		[batchRunStates]
	);

	const stoppingBatchSessionIds = useMemo(
		() =>
			Object.entries(batchRunStates)
				.filter(([, state]) => state.isRunning && state.isStopping)
				.map(([sessionId]) => sessionId),
		[batchRunStates]
	);

	const setCustomPrompt = useCallback((sessionId: string, prompt: string) => {
		useBatchStore.getState().setCustomPrompt(sessionId, prompt);
	}, []);

	return {
		batchRunStates,
		getBatchState,
		hasAnyActiveBatch,
		activeBatchSessionIds,
		stoppingBatchSessionIds,
		customPrompts,
		setCustomPrompt,
	};
}
