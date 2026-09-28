import { useCallback } from 'react';
import { useBatchStore } from '../../stores/batchStore';

/**
 * Whether the run for `sessionId` is parked waiting on the user.
 *
 * Two situations share this flag: an agent error the user has to resolve, and
 * a `MAESTRO:HITL` review gate (the gate pauses through `pauseBatchOnError` so
 * it reuses the same banner). In both the engine is idle until Resume is
 * clicked, so the run is NOT driving the document - it is asking for input.
 *
 * Subscribes to the store rather than reading the `batchRunState` prop: the
 * prop chain (store -> useBatchProcessor -> useBatchHandlers -> App ->
 * RightPanel -> AutoRun) drops `errorPaused` updates via
 * `updateBatchStateAndBroadcast`/`UPDATE_PROGRESS`.
 */
export function useAutoRunErrorPaused(sessionId: string): boolean {
	return useBatchStore(
		useCallback((s) => s.batchRunStates[sessionId]?.errorPaused ?? false, [sessionId])
	);
}
