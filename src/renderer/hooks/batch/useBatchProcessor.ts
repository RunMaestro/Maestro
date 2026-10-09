import { useCallback, useRef, useEffect } from 'react';
import type {
	BatchRunState,
	BatchRunConfig,
	Session,
	HistoryEntry,
	Group,
	AutoRunStats,
	AgentError,
} from '../../types';
// Extracted batch processing modules
import { countUnfinishedTasks, uncheckAllTasks } from './batchUtils';
import { useBatchStore } from '../../stores/batchStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useTimeTracking } from './useTimeTracking';
import { useWorktreeManager } from './useWorktreeManager';
import { useDocumentProcessor } from './useDocumentProcessor';
import type { AutoRunSpawnAgentFn } from './useDocumentProcessor';
// Decomposed internal hooks (see ./internal/)
import type { BatchAction } from './batchReducer';
import { type AutoRunFlushState } from './internal/batchFlushState';
import { useBatchSelectors } from './internal/useBatchSelectors';
import { useBatchBroadcast } from './internal/useBatchBroadcast';
import { useAutoRunStateMirror } from './useAutoRunStateMirror';
import {
	useBatchControlActions,
	type ErrorResolutionEntry,
} from './internal/useBatchControlActions';
import { useBatchKillAction } from './internal/useBatchKillAction';
import { useBatchRunner } from './internal/useBatchRunner';
import { useGoalRunner, type UseGoalRunnerDeps } from './internal/useGoalRunner';
import { isWebDesktop } from '../../utils/runtimeContext';
import { notifyToast } from '../../stores/notificationStore';
import type { AutoRunRemoteControl } from '../../../shared/autoRunRemote';

export interface BatchCompleteInfo {
	sessionId: string;
	sessionName: string;
	completedTasks: number;
	totalTasks: number;
	wasStopped: boolean;
	elapsedTimeMs: number;
	/** Total input tokens consumed across all tasks */
	inputTokens: number;
	/** Total output tokens consumed across all tasks */
	outputTokens: number;
	/** Total estimated cost in USD across all tasks */
	totalCostUsd: number;
	/** Number of documents processed */
	documentsProcessed: number;
}

export interface PRResultInfo {
	sessionId: string;
	sessionName: string;
	success: boolean;
	prUrl?: string;
	error?: string;
}

export interface UseBatchProcessorProps {
	groups: Group[];
	onUpdateSession: (sessionId: string, updates: Partial<Session>) => void;
	onSpawnAgent: AutoRunSpawnAgentFn;
	/**
	 * Resume an existing provider session and run a prompt (used by the goal
	 * runner to fetch a handoff note between iterations). Same primitive the
	 * document runner uses for its exit synopsis.
	 */
	spawnBackgroundSynopsis: UseGoalRunnerDeps['spawnBackgroundSynopsis'];
	onAddHistoryEntry: (entry: Omit<HistoryEntry, 'id'>) => void | Promise<void>;
	onComplete?: (info: BatchCompleteInfo) => void;
	// Callback for PR creation results (success or failure)
	onPRResult?: (info: PRResultInfo) => void;
	// TTS settings for speaking synopsis after each task
	audioFeedbackEnabled?: boolean;
	audioFeedbackCommand?: string;
	// Auto Run stats for achievement progress in final summary
	autoRunStats?: AutoRunStats;
	// Callback to process queued items after batch completion/stop
	// This ensures pending user messages are processed after Auto Run ends
	onProcessQueueAfterCompletion?: (sessionId: string) => void;
}

interface UseBatchProcessorReturn {
	// Map of session ID to batch state
	batchRunStates: Record<string, BatchRunState>;
	// Get batch state for a specific session
	getBatchState: (sessionId: string) => BatchRunState;
	// Check if any session has an active batch
	hasAnyActiveBatch: boolean;
	// Get list of session IDs with active batches
	activeBatchSessionIds: string[];
	// Get list of session IDs that are in stopping state
	stoppingBatchSessionIds: string[];
	// Start batch run for a specific session with multi-document support
	startBatchRun: (sessionId: string, config: BatchRunConfig, folderPath: string) => Promise<void>;
	// Stop batch run for a specific session
	stopBatchRun: (sessionId: string) => void;
	// Force kill the running process and immediately end the batch run
	killBatchRun: (sessionId: string) => Promise<void>;
	// Custom prompts per session
	customPrompts: Record<string, string>;
	setCustomPrompt: (sessionId: string, prompt: string) => void;
	// Error handling (Phase 5.10)
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

// Re-export utility functions for backwards compatibility
// (countUnfinishedTasks and uncheckAllTasks are imported from ./batch/batchUtils)
export { countUnfinishedTasks, uncheckAllTasks };

/**
 * Hook for managing batch processing of scratchpad tasks across multiple sessions
 *
 * Memory safety guarantees:
 * - All error resolution promises are rejected with 'abort' on unmount
 * - stopRequestedRefs are cleared when batches complete normally
 * - isMountedRef check prevents all state updates after unmount
 * - Extracted hooks (useSessionDebounce, useTimeTracking) handle their own cleanup
 */
export function useBatchProcessor({
	groups,
	onUpdateSession,
	onSpawnAgent,
	spawnBackgroundSynopsis,
	onAddHistoryEntry,
	onComplete,
	onPRResult,
	audioFeedbackEnabled,
	audioFeedbackCommand,
	autoRunStats,
	onProcessQueueAfterCompletion,
}: UseBatchProcessorProps): UseBatchProcessorReturn {
	// Reactive selectors over the batch store
	const {
		batchRunStates,
		getBatchState,
		hasAnyActiveBatch,
		activeBatchSessionIds,
		stoppingBatchSessionIds,
		customPrompts,
		setCustomPrompt,
	} = useBatchSelectors();

	// Dispatch batch actions through the store. The store applies batchReducer
	// synchronously, eliminating the need for manual ref syncing.
	const dispatch = useCallback((action: BatchAction) => {
		useBatchStore.getState().dispatchBatch(action);
	}, []);

	// Refs for tracking stop requests per session
	const stopRequestedRefs = useRef<Record<string, boolean>>({});

	// PERF: Read sessions at event time via getState() so App (this hook's
	// caller) does not re-render on streaming session updates. Downstream
	// runners already fall back to the store when a session is missing.
	const getSessions = useCallback(() => useSessionStore.getState().sessions, []);

	// Refs to always have access to latest audio feedback settings (fixes stale closure during batch run)
	// Without refs, toggling settings off during a batch run won't take effect until the next run
	const audioFeedbackEnabledRef = useRef(audioFeedbackEnabled);
	audioFeedbackEnabledRef.current = audioFeedbackEnabled;
	const audioFeedbackCommandRef = useRef(audioFeedbackCommand);
	audioFeedbackCommandRef.current = audioFeedbackCommand;

	// Ref to track latest updateBatchStateAndBroadcast for async callbacks (fixes HMR stale closure)
	const updateBatchStateAndBroadcastRef = useRef<typeof updateBatchStateAndBroadcast | null>(null);

	// Error resolution promises to pause batch processing until user action (per session)
	const errorResolutionRefs = useRef<Record<string, ErrorResolutionEntry>>({});

	// Per-session state for emergency stats/history flush on force-kill.
	// Whoever deletes the entry first (the loop's normal cleanup, or killBatchRun) is
	// responsible for writing the final history + endAutoRun. This guards against the
	// case where killBatchRun calls timeTracking.stopTracking (which zeros the tracker)
	// before the loop's cleanup reads it, resulting in a 0ms duration being recorded.
	const autoRunFlushStateRefs = useRef<Record<string, AutoRunFlushState>>({});

	// Track whether the component is still mounted to prevent state updates after unmount
	const isMountedRef = useRef(false);

	// Mount/unmount effect: set isMountedRef on mount, clear on unmount
	// This handles React 18 StrictMode double-render and ensures ref is always correct
	useEffect(() => {
		isMountedRef.current = true;
		return () => {
			isMountedRef.current = false;

			// Reject all pending error resolution promises with 'abort' to unblock any waiting async code
			// This prevents memory leaks from promises that would never resolve
			Object.entries(errorResolutionRefs.current).forEach(([, entry]) => {
				entry.resolve('abort');
			});
			// Clear the refs to allow garbage collection
			errorResolutionRefs.current = {};

			// Clear stop requested refs (though they should already be cleaned up per-session)
			stopRequestedRefs.current = {};

			// Drop any outstanding Auto Run flush state - nothing to flush against after unmount.
			autoRunFlushStateRefs.current = {};
		};
	}, []);

	// Web/mobile bridge: synchronous broadcast + debounced state-update wrapper
	const { broadcastAutoRunState, updateBatchStateAndBroadcast, flushDebouncedUpdate } =
		useBatchBroadcast({ dispatch });

	// The inbound half of that same bridge: render runs OWNED by another Maestro
	// client (web-desktop watching the desktop app). No-op in the Electron build.
	useAutoRunStateMirror();

	// Use extracted time tracking hook (replaces manual visibility-based time tracking)
	const timeTracking = useTimeTracking({
		getActiveSessionIds: useCallback(() => {
			return Object.entries(useBatchStore.getState().batchRunStates)
				.filter(([, state]) => state.isRunning && !state.errorPaused)
				.map(([sessionId]) => sessionId);
		}, []),
		onTimeUpdate: useCallback(
			(sessionId: string, accumulatedMs: number, activeTimestamp: number | null) => {
				// Update batch state with new time tracking values
				dispatch({
					type: 'UPDATE_PROGRESS',
					sessionId,
					payload: {
						accumulatedElapsedMs: accumulatedMs,
						lastActiveTimestamp: activeTimestamp,
					},
				});
			},
			[]
		),
	});

	// External lifecycle controls (stop + pause/skip/resume/abort). Follows
	// `useTimeTracking` because a pause stops the run's clock.
	const {
		stopBatchRun,
		pauseBatchOnError,
		skipCurrentDocument,
		resumeAfterError,
		abortBatchOnError,
	} = useBatchControlActions({
		broadcastAutoRunState,
		dispatch,
		errorResolutionRefs,
		stopRequestedRefs,
		isMountedRef,
		timeTracking,
	});

	// Force-kill action with kill-vs-natural-completion arbitration.
	// Must follow `useTimeTracking` because it captures elapsed time from the
	// live tracker before tearing it down.
	const { killBatchRun } = useBatchKillAction({
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
	});

	// Use extracted worktree manager hook for git worktree operations
	const worktreeManager = useWorktreeManager();

	// Use extracted document processor hook for document processing
	const documentProcessor = useDocumentProcessor();

	// Update ref to always have latest updateBatchStateAndBroadcast (fixes HMR stale closure
	// in long-running async loops; safe across module boundaries because Vite invalidates
	// per-module - keeping the ref in the coordinator is intentional).
	updateBatchStateAndBroadcastRef.current = updateBatchStateAndBroadcast;

	// Document/task-driven Auto Run orchestrator.
	const { startBatchRun: startDocumentBatchRun } = useBatchRunner({
		getSessions,
		audioFeedbackEnabledRef,
		audioFeedbackCommandRef,
		autoRunFlushStateRefs,
		errorResolutionRefs,
		stopRequestedRefs,
		isMountedRef,
		updateBatchStateAndBroadcastRef,
		broadcastAutoRunState,
		flushDebouncedUpdate,
		dispatch,
		pauseBatchOnError,
		timeTracking,
		worktreeManager,
		documentProcessor,
		groups,
		autoRunStats,
		onUpdateSession,
		onSpawnAgent,
		onAddHistoryEntry,
		onComplete,
		onPRResult,
		onProcessQueueAfterCompletion,
	});

	// Goal-Driven Auto Run orchestrator. Shares the same lifecycle dependency
	// surface so stop/kill/pause controls and state behavior stay consistent.
	const { startGoalRun } = useGoalRunner({
		getSessions,
		audioFeedbackEnabledRef,
		audioFeedbackCommandRef,
		autoRunFlushStateRefs,
		stopRequestedRefs,
		isMountedRef,
		errorResolutionRefs,
		updateBatchStateAndBroadcastRef,
		broadcastAutoRunState,
		flushDebouncedUpdate,
		dispatch,
		timeTracking,
		groups,
		onSpawnAgent,
		spawnBackgroundSynopsis,
		onAddHistoryEntry,
		onComplete,
		onProcessQueueAfterCompletion,
	});

	// Single public entry point. The presence of `config.goalConfig` selects goal
	// mode; otherwise we run the existing document/task loop. The signature is
	// unchanged so no caller breaks.
	const startBatchRun = useCallback(
		async (sessionId: string, config: BatchRunConfig, folderPath: string) => {
			if (isWebDesktop()) {
				const result = await window.maestro.web.startAutoRun(sessionId, config, folderPath);
				if (!result.success) throw new Error(result.error || 'Host rejected Auto Run start');
				return;
			}
			if (config.goalConfig) {
				return startGoalRun(sessionId, config, folderPath);
			}
			return startDocumentBatchRun(sessionId, config, folderPath);
		},
		[startGoalRun, startDocumentBatchRun]
	);

	const sendRemoteControl = useCallback(
		async (sessionId: string, control: AutoRunRemoteControl) => {
			const result = await window.maestro.web.controlAutoRun(sessionId, control);
			if (!result.success) throw new Error(result.error || 'Host rejected Auto Run control');
		},
		[]
	);
	const requestRemoteControl = useCallback(
		(sessionId: string, control: AutoRunRemoteControl) => {
			void sendRemoteControl(sessionId, control).catch((error: unknown) => {
				notifyToast({
					type: 'error',
					title: 'Auto Run control failed',
					message: error instanceof Error ? error.message : String(error),
				});
			});
		},
		[sendRemoteControl]
	);

	useEffect(() => {
		if (isWebDesktop()) return;
		return window.maestro.process.onRemoteControlAutoRun?.(
			(sessionId, control, responseChannel) => {
				void (async () => {
					const state = useBatchStore.getState().batchRunStates[sessionId];
					if (!state?.isRunning || state.mirrored)
						throw new Error('No host-owned Auto Run is active for this agent');
					switch (control.action) {
						case 'stop':
							stopBatchRun(sessionId);
							break;
						case 'kill':
							await killBatchRun(sessionId);
							break;
						case 'pause':
							pauseBatchOnError(
								sessionId,
								control.error,
								control.documentIndex,
								control.taskDescription
							);
							break;
						case 'resume':
						case 'skip-document':
						case 'abort':
							if (!state.errorPaused) throw new Error('Auto Run is not paused');
							if (control.action === 'resume') resumeAfterError(sessionId);
							else if (control.action === 'skip-document') skipCurrentDocument(sessionId);
							else abortBatchOnError(sessionId);
							break;
						default:
							throw new Error('Unknown Auto Run control');
					}
					window.maestro.process.sendRemoteAutoRunResponse(responseChannel, { success: true });
				})().catch((error: unknown) => {
					window.maestro.process.sendRemoteAutoRunResponse(responseChannel, {
						success: false,
						error: error instanceof Error ? error.message : String(error),
					});
				});
			}
		);
	}, [
		stopBatchRun,
		killBatchRun,
		pauseBatchOnError,
		resumeAfterError,
		skipCurrentDocument,
		abortBatchOnError,
	]);

	const remoteClient = isWebDesktop();

	return {
		batchRunStates,
		getBatchState,
		hasAnyActiveBatch,
		activeBatchSessionIds,
		stoppingBatchSessionIds,
		startBatchRun,
		stopBatchRun: remoteClient
			? (sessionId) => requestRemoteControl(sessionId, { action: 'stop' })
			: stopBatchRun,
		killBatchRun: remoteClient
			? (sessionId) => sendRemoteControl(sessionId, { action: 'kill' })
			: killBatchRun,
		customPrompts,
		setCustomPrompt,
		// Error handling (Phase 5.10)
		pauseBatchOnError: remoteClient
			? (sessionId, error, documentIndex, taskDescription) =>
					requestRemoteControl(sessionId, {
						action: 'pause',
						error,
						documentIndex,
						taskDescription,
					})
			: pauseBatchOnError,
		skipCurrentDocument: remoteClient
			? (sessionId) => requestRemoteControl(sessionId, { action: 'skip-document' })
			: skipCurrentDocument,
		resumeAfterError: remoteClient
			? (sessionId) => requestRemoteControl(sessionId, { action: 'resume' })
			: resumeAfterError,
		abortBatchOnError: remoteClient
			? (sessionId) => requestRemoteControl(sessionId, { action: 'abort' })
			: abortBatchOnError,
	};
}
