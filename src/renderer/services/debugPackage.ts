/**
 * Debug package service.
 *
 * Single entry point for generating a support package. It exists so the Auto
 * Run snapshot is captured in one place: that state lives only in the
 * renderer's in-memory `batchStore`, so a call site that goes straight to
 * `window.maestro.debug.createPackage` silently ships a package with no Auto
 * Run diagnostics at all. Call this instead.
 *
 * It is also where the secret screen's confirmation lives. The main process
 * screens the collected package before it asks where to save it; on a finding
 * this asks the user, and "Create anyway" repeats the request with
 * `allowSecrets`. A no comes back as `cancelled`, the same as a dismissed save
 * dialog, so no caller has to learn a third outcome.
 */

import { useBatchStore } from '../stores/batchStore';
import type { AutoRunDebugSnapshot, DebugPackageOptions } from '../../shared/debugPackage';
import { withSecretScreenConfirm } from './secretScreen';

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
export async function createDebugPackage(
	options?: Omit<DebugPackageOptions, 'autoRunSnapshots' | 'allowSecrets'>
): ReturnType<typeof window.maestro.debug.createPackage> {
	const autoRunSnapshots = captureAutoRunSnapshots();
	const { result, declined } = await withSecretScreenConfirm(
		(allowSecrets) =>
			window.maestro.debug.createPackage({ ...options, autoRunSnapshots, allowSecrets }),
		{ subject: 'this support package', confirmLabel: 'Create anyway' }
	);
	return declined ? { ...result, cancelled: true } : result;
}
