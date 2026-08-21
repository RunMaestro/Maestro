/**
 * Debug package service.
 *
 * Single entry point for generating a support package. It exists so the Auto
 * Run snapshot is captured in one place: that state lives only in the
 * renderer's in-memory `batchStore`, so a call site that goes straight to
 * `window.maestro.debug.createPackage` silently ships a package with no Auto
 * Run diagnostics at all. Call this instead.
 */

import { useBatchStore } from '../stores/batchStore';
import type { AutoRunDebugSnapshot, DebugPackageOptions } from '../../shared/debugPackage';

/**
 * Capture the current Auto Run state for every agent, as counters and flags.
 *
 * Deliberately omits `documents` (filenames), `folderPath`, worktree paths,
 * `customPrompt`, `errorTaskDescription`, and the error message: a support
 * package must not carry document content or paths.
 */
export function captureAutoRunSnapshots(): AutoRunDebugSnapshot[] {
	const states = useBatchStore.getState().batchRunStates;

	return Object.entries(states).map(([sessionId, state]) => ({
		sessionId,
		isRunning: state.isRunning,
		isStopping: state.isStopping,
		processingState: state.processingState,

		documentCount: state.documents?.length ?? 0,
		currentDocumentIndex: state.currentDocumentIndex,

		currentDocTasksTotal: state.currentDocTasksTotal,
		currentDocTasksCompleted: state.currentDocTasksCompleted,
		totalTasksAcrossAllDocs: state.totalTasksAcrossAllDocs,
		completedTasksAcrossAllDocs: state.completedTasksAcrossAllDocs,

		loopEnabled: state.loopEnabled,
		loopIteration: state.loopIteration,
		maxLoops: state.maxLoops,

		worktreeActive: state.worktreeActive,

		hasError: !!state.error,
		errorType: state.error?.type,
		errorPaused: !!state.errorPaused,
		errorDocumentIndex: state.errorDocumentIndex,

		startTime: state.startTime,
		cumulativeTaskTimeMs: state.cumulativeTaskTimeMs,
		accumulatedElapsedMs: state.accumulatedElapsedMs,
		lastActiveTimestamp: state.lastActiveTimestamp,
	}));
}

/**
 * Generate a debug package, attaching the live Auto Run snapshot.
 */
export function createDebugPackage(
	options?: Omit<DebugPackageOptions, 'autoRunSnapshots'>
): ReturnType<typeof window.maestro.debug.createPackage> {
	return window.maestro.debug.createPackage({
		...options,
		autoRunSnapshots: captureAutoRunSnapshots(),
	});
}
