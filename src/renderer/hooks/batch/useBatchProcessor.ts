import { useState, useCallback, useRef, useReducer, useEffect, useMemo } from 'react';
import type {
	BatchRunState,
	BatchRunConfig,
	Session,
	HistoryEntry,
	UsageStats,
	Group,
	AutoRunStats,
	AgentError,
} from '../../types';
import {
	getBadgeForTime,
	getNextBadge,
	formatTimeRemaining,
} from '../../constants/conductorBadges';
import { formatElapsedTime } from '../../../shared/formatters';
import { gitService } from '../../services/git';
// Extracted batch processing modules
import { countUnfinishedTasks, uncheckAllTasks } from './batchUtils';
import { useSessionDebounce } from './useSessionDebounce';
import { batchReducer, DEFAULT_BATCH_STATE } from './batchReducer';
import { useTimeTracking } from './useTimeTracking';
import { useWorktreeManager } from './useWorktreeManager';
import { useDocumentProcessor } from './useDocumentProcessor';

// Debounce delay for batch state updates (Quick Win 1)
const BATCH_STATE_DEBOUNCE_MS = 200;

// Regex to match checked markdown checkboxes for reset-on-completion
// Matches both [x] and [X] with various checkbox formats (standard and GitHub-style)
// Note: countUnfinishedTasks, countCheckedTasks, uncheckAllTasks are now imported from ./batch/batchUtils

interface BatchCompleteInfo {
	sessionId: string;
	sessionName: string;
	completedTasks: number;
	totalTasks: number;
	wasStopped: boolean;
	elapsedTimeMs: number;
}

interface PRResultInfo {
	sessionId: string;
	sessionName: string;
	success: boolean;
	prUrl?: string;
	error?: string;
}

interface UseBatchProcessorProps {
	sessions: Session[];
	groups: Group[];
	onUpdateSession: (sessionId: string, updates: Partial<Session>) => void;
	onSpawnAgent: (
		sessionId: string,
		prompt: string,
		cwdOverride?: string
	) => Promise<{
		success: boolean;
		response?: string;
		agentSessionId?: string;
		usageStats?: UsageStats;
	}>;
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

type ErrorResolutionAction = 'resume' | 'skip-document' | 'abort';

interface ErrorResolutionEntry {
	promise: Promise<ErrorResolutionAction>;
	resolve: (action: ErrorResolutionAction) => void;
}

/**
 * Create a loop summary history entry
 */
interface LoopSummaryParams {
	loopIteration: number;
	loopTasksCompleted: number;
	loopStartTime: number;
	loopTotalInputTokens: number;
	loopTotalOutputTokens: number;
	loopTotalCost: number;
	sessionCwd: string;
	sessionId: string;
	isFinal: boolean;
	exitReason?: string;
}

function createLoopSummaryEntry(params: LoopSummaryParams): Omit<HistoryEntry, 'id'> {
	const {
		loopIteration,
		loopTasksCompleted,
		loopStartTime,
		loopTotalInputTokens,
		loopTotalOutputTokens,
		loopTotalCost,
		sessionCwd,
		sessionId,
		isFinal,
		exitReason,
	} = params;

	const loopElapsedMs = Date.now() - loopStartTime;
	const loopNumber = loopIteration + 1;
	const summaryPrefix = isFinal ? `Loop ${loopNumber} (final)` : `Loop ${loopNumber}`;
	const loopSummary = `${summaryPrefix} completed: ${loopTasksCompleted} task${loopTasksCompleted !== 1 ? 's' : ''} accomplished`;

	const loopDetails = [
		`**${summaryPrefix} Summary**`,
		'',
		`- **Tasks Accomplished:** ${loopTasksCompleted}`,
		`- **Duration:** ${formatElapsedTime(loopElapsedMs)}`,
		loopTotalInputTokens > 0 || loopTotalOutputTokens > 0
			? `- **Tokens:** ${(loopTotalInputTokens + loopTotalOutputTokens).toLocaleString()} (${loopTotalInputTokens.toLocaleString()} in / ${loopTotalOutputTokens.toLocaleString()} out)`
			: '',
		loopTotalCost > 0 ? `- **Cost:** $${loopTotalCost.toFixed(4)}` : '',
		exitReason ? `- **Exit Reason:** ${exitReason}` : '',
	]
		.filter((line) => line !== '')
		.join('\n');

	return {
		type: 'AUTO',
		timestamp: Date.now(),
		summary: loopSummary,
		fullResponse: loopDetails,
		projectPath: sessionCwd,
		sessionId: sessionId,
		success: true,
		elapsedTimeMs: loopElapsedMs,
		usageStats:
			loopTotalInputTokens > 0 || loopTotalOutputTokens > 0
				? {
						inputTokens: loopTotalInputTokens,
						outputTokens: loopTotalOutputTokens,
						cacheReadInputTokens: 0,
						cacheCreationInputTokens: 0,
						totalCostUsd: loopTotalCost,
						contextWindow: 0,
					}
				: undefined,
	};
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
	sessions,
	groups,
	onUpdateSession,
	onSpawnAgent,
	onAddHistoryEntry,
	onComplete,
	onPRResult,
	audioFeedbackEnabled,
	audioFeedbackCommand,
	autoRunStats,
	onProcessQueueAfterCompletion,
}: UseBatchProcessorProps): UseBatchProcessorReturn {
	// Batch states per session using reducer pattern for predictable state transitions
	const [batchRunStates, dispatchRaw] = useReducer(batchReducer, {});

	// Wrap dispatch to update ref synchronously, fixing race condition where
	// debounced callbacks read stale ref state before React re-renders
	const dispatch = useCallback((action: Parameters<typeof batchReducer>[1]) => {
		const prevRef = batchRunStatesRef.current;
		dispatchRaw(action);
		// Synchronously update ref with the new state so debounced callbacks see it
		// This must happen after dispatch since the reducer computes the new state
		// Note: We apply the reducer directly to compute what the new state will be
		batchRunStatesRef.current = batchReducer(batchRunStatesRef.current, action);

		// DEBUG: Log dispatch to trace state updates
		if (
			action.type === 'START_BATCH' ||
			action.type === 'UPDATE_PROGRESS' ||
			action.type === 'SET_STOPPING' ||
			action.type === 'COMPLETE_BATCH'
		) {
			const sessionId = action.sessionId;
			console.log('[BatchProcessor:dispatch]', action.type, {
				sessionId,
				prevIsRunning: prevRef[sessionId]?.isRunning,
				newIsRunning: batchRunStatesRef.current[sessionId]?.isRunning,
				prevIsStopping: prevRef[sessionId]?.isStopping,
				newIsStopping: batchRunStatesRef.current[sessionId]?.isStopping,
				prevCompleted: prevRef[sessionId]?.completedTasksAcrossAllDocs,
				newCompleted: batchRunStatesRef.current[sessionId]?.completedTasksAcrossAllDocs,
			});
		}
	}, []);

	// Custom prompts per session
	const [customPrompts, setCustomPrompts] = useState<Record<string, string>>({});

	// Refs for tracking stop requests per session
	const stopRequestedRefs = useRef<Record<string, boolean>>({});

	// Ref to always have access to latest sessions (fixes stale closure in startBatchRun)
	const sessionsRef = useRef(sessions);
	sessionsRef.current = sessions;

	// Ref to track latest batchRunStates for time tracking callback
	// NOTE: Do NOT auto-sync with batchRunStates on every render!
	// The dispatch wrapper updates this ref synchronously after each action.
	// Auto-syncing can reset the ref to stale React state when batches are pending,
	// causing the "0 of N tasks completed" regression. See commit 01eca193.
	const batchRunStatesRef = useRef<Record<string, BatchRunState>>(batchRunStates);

	// Ref to track latest updateBatchStateAndBroadcast for async callbacks (fixes HMR stale closure)
	const updateBatchStateAndBroadcastRef = useRef<typeof updateBatchStateAndBroadcast | null>(null);

	// Error resolution promises to pause batch processing until user action (per session)
	const errorResolutionRefs = useRef<Record<string, ErrorResolutionEntry>>({});

	// Track whether the component is still mounted to prevent state updates after unmount
	const isMountedRef = useRef(false);

	// Mount/unmount effect: set isMountedRef on mount, clear on unmount
	// This handles React 18 StrictMode double-render and ensures ref is always correct
	useEffect(() => {
		isMountedRef.current = true;
		console.log('[BatchProcessor] Mounted, isMountedRef set to true');
		return () => {
			isMountedRef.current = false;
			console.log('[BatchProcessor] Unmounting, isMountedRef set to false');

			// Reject all pending error resolution promises with 'abort' to unblock any waiting async code
			// This prevents memory leaks from promises that would never resolve
			Object.entries(errorResolutionRefs.current).forEach(([, entry]) => {
				entry.resolve('abort');
			});
			// Clear the refs to allow garbage collection
			errorResolutionRefs.current = {};

			// Clear stop requested refs (though they should already be cleaned up per-session)
			stopRequestedRefs.current = {};
		};
	}, []);

	/**
	 * Broadcast Auto Run state to web interface immediately (synchronously).
	 * This replaces the previous useEffect-based approach to ensure mobile clients
	 * receive state updates without waiting for React's render cycle.
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
				// Multi-document progress fields
				totalDocuments: state.documents?.length ?? 0,
				currentDocumentIndex: state.currentDocumentIndex,
				totalTasksAcrossAllDocs: state.totalTasksAcrossAllDocs,
				completedTasksAcrossAllDocs: state.completedTasksAcrossAllDocs,
			});
		} else {
			// When not running and no completed tasks, broadcast null to clear the state
			window.maestro.web.broadcastAutoRunState(sessionId, null);
		}
	}, []);

	// Use extracted debounce hook for batch state updates (replaces manual debounce logic)
	const { scheduleUpdate: scheduleDebouncedUpdate, flushUpdate: flushDebouncedUpdate } =
		useSessionDebounce<Record<string, BatchRunState>>({
			delayMs: BATCH_STATE_DEBOUNCE_MS,
			onUpdate: useCallback(
				(
					sessionId: string,
					updater: (prev: Record<string, BatchRunState>) => Record<string, BatchRunState>
				) => {
					// Apply the updater and get the new state for broadcasting
					// Note: We use a ref to capture the new state since dispatch doesn't return it
					let newStateForSession: BatchRunState | null = null;

					try {
						// For reducer, we need to convert the updater to an action
						// Since the updater pattern doesn't map directly to actions, we wrap it
						// by reading current state and computing the new state
						const currentState = batchRunStatesRef.current;
						const newState = updater(currentState);
						newStateForSession = newState[sessionId] || null;

						// DEBUG: Log to trace progress updates
						console.log('[BatchProcessor:onUpdate] Debounce fired:', {
							sessionId,
							refHasSession: !!currentState[sessionId],
							refCompletedTasks: currentState[sessionId]?.completedTasksAcrossAllDocs,
							newCompletedTasks: newStateForSession?.completedTasksAcrossAllDocs,
						});

						// Dispatch UPDATE_PROGRESS with the computed changes
						// For complex state changes, we extract the session's new state and dispatch appropriately
						if (newStateForSession) {
							const prevSessionState = currentState[sessionId] || DEFAULT_BATCH_STATE;

							// Dispatch UPDATE_PROGRESS with any changed fields
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
								},
							});
						}

						broadcastAutoRunState(sessionId, newStateForSession);
					} catch (error) {
						console.error('[BatchProcessor:onUpdate] ERROR in debounce callback:', error);
					}
				},
				[broadcastAutoRunState]
			),
		});

	// Use extracted time tracking hook (replaces manual visibility-based time tracking)
	const timeTracking = useTimeTracking({
		getActiveSessionIds: useCallback(() => {
			return Object.entries(batchRunStatesRef.current)
				.filter(([_, state]) => state.isRunning)
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
						lastActiveTimestamp: activeTimestamp ?? undefined,
					},
				});
			},
			[]
		),
	});

	// Use extracted worktree manager hook for git worktree operations
	const worktreeManager = useWorktreeManager();

	// Use extracted document processor hook for document processing
	const documentProcessor = useDocumentProcessor();

	// Helper to get batch state for a session
	// Note: This reads from React state (not the ref) because consumers need React
	// to trigger re-renders when state changes. The ref is used internally for
	// synchronous access in debounced callbacks.
	const getBatchState = useCallback(
		(sessionId: string): BatchRunState => {
			return batchRunStates[sessionId] || DEFAULT_BATCH_STATE;
		},
		[batchRunStates]
	);

	// Check if any session has an active batch (memoized to prevent re-renders on unrelated state changes)
	const hasAnyActiveBatch = useMemo(
		() => Object.values(batchRunStates).some((state) => state.isRunning),
		[batchRunStates]
	);

	// Get list of session IDs with active batches (memoized to prevent new array references)
	const activeBatchSessionIds = useMemo(
		() =>
			Object.entries(batchRunStates)
				.filter(([, state]) => state.isRunning)
				.map(([sessionId]) => sessionId),
		[batchRunStates]
	);

	// Get list of session IDs that are in stopping state (memoized to prevent new array references)
	const stoppingBatchSessionIds = useMemo(
		() =>
			Object.entries(batchRunStates)
				.filter(([, state]) => state.isRunning && state.isStopping)
				.map(([sessionId]) => sessionId),
		[batchRunStates]
	);

	// Set custom prompt for a session
	const setCustomPrompt = useCallback((sessionId: string, prompt: string) => {
		setCustomPrompts((prev) => ({ ...prev, [sessionId]: prompt }));
	}, []);

	/**
	 * Update batch state AND broadcast to web interface with debouncing.
	 * This wrapper uses the extracted useSessionDebounce hook to batch rapid-fire
	 * state updates and reduce React re-renders during intensive task processing.
	 *
	 * Critical updates (isRunning changes, errors) are processed immediately,
	 * while progress updates are debounced by BATCH_STATE_DEBOUNCE_MS.
	 */
	const updateBatchStateAndBroadcast = useCallback(
		(
			sessionId: string,
			updater: (prev: Record<string, BatchRunState>) => Record<string, BatchRunState>,
			immediate: boolean = false
		) => {
			// DEBUG: Bypass debouncing entirely to test if that's the issue
			// Apply update directly without debouncing
			const currentState = batchRunStatesRef.current;
			const newState = updater(currentState);
			const newStateForSession = newState[sessionId] || null;

			console.log('[BatchProcessor:updateBatchStateAndBroadcast] DIRECT update (no debounce)', {
				sessionId,
				prevCompleted: currentState[sessionId]?.completedTasksAcrossAllDocs,
				newCompleted: newStateForSession?.completedTasksAcrossAllDocs,
			});

			if (newStateForSession) {
				const prevSessionState = currentState[sessionId] || DEFAULT_BATCH_STATE;

				dispatch({
					type: 'UPDATE_PROGRESS',
					sessionId,
					payload: {
						currentDocumentIndex:
							newStateForSession.currentDocumentIndex !== prevSessionState.currentDocumentIndex
								? newStateForSession.currentDocumentIndex
								: undefined,
						currentDocTasksTotal:
							newStateForSession.currentDocTasksTotal !== prevSessionState.currentDocTasksTotal
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
							newStateForSession.accumulatedElapsedMs !== prevSessionState.accumulatedElapsedMs
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
					},
				});
			}

			broadcastAutoRunState(sessionId, newStateForSession);
		},
		[broadcastAutoRunState]
	);

	// Update ref to always have latest updateBatchStateAndBroadcast (fixes HMR stale closure)
	updateBatchStateAndBroadcastRef.current = updateBatchStateAndBroadcast;

	// Use readDocAndCountTasks from the extracted documentProcessor hook
	// This replaces the previous inline helper function
	const readDocAndCountTasks = documentProcessor.readDocAndCountTasks;

	/**
	 * Start a batch processing run for a specific session with multi-document support
	 */
	const startBatchRun = useCallback(
		async (sessionId: string, config: BatchRunConfig, folderPath: string) => {
			window.maestro.logger.log('info', 'startBatchRun called', 'BatchProcessor', {
				sessionId,
				folderPath,
				documentsCount: config.documents.length,
				worktreeEnabled: config.worktree?.enabled,
			});

			// Use sessionsRef to get latest sessions (handles case where session was just created)
			const session = sessionsRef.current.find((s) => s.id === sessionId);
			if (!session) {
				window.maestro.logger.log(
					'error',
					'Session not found for batch processing',
					'BatchProcessor',
					{ sessionId }
				);
				return;
			}

			const { documents, prompt, loopEnabled, maxLoops, worktree } = config;

			if (documents.length === 0) {
				window.maestro.logger.log(
					'warn',
					'No documents provided for batch processing',
					'BatchProcessor',
					{ sessionId }
				);
				return;
			}

			// Track batch start time for completion notification
			const batchStartTime = Date.now();

			// Initialize visibility-based time tracking for this session using the extracted hook
			timeTracking.startTracking(sessionId);

			// Reset stop flag for this session
			stopRequestedRefs.current[sessionId] = false;
			delete errorResolutionRefs.current[sessionId];

			// Set up worktree if enabled using extracted hook
			// Inject sshRemoteId from session into worktree config for remote worktree operations
			// Note: sshRemoteId is only set after AI agent spawns. For terminal-only SSH sessions,
			// we must fall back to sessionSshRemoteConfig.remoteId. See CLAUDE.md "SSH Remote Sessions".
			const sshRemoteId =
				session.sshRemoteId || session.sessionSshRemoteConfig?.remoteId || undefined;
			const worktreeWithSsh = worktree ? { ...worktree, sshRemoteId } : undefined;
			const worktreeResult = await worktreeManager.setupWorktree(session.cwd, worktreeWithSsh);
			if (!worktreeResult.success) {
				window.maestro.logger.log('error', 'Worktree setup failed', 'BatchProcessor', {
					sessionId,
					error: worktreeResult.error,
				});
				return;
			}

			const { effectiveCwd, worktreeActive, worktreePath, worktreeBranch } = worktreeResult;

			// Get git branch for template variable substitution
			let gitBranch: string | undefined;
			if (session.isGitRepo) {
				try {
					const status = await gitService.getStatus(effectiveCwd);
					gitBranch = status.branch;
				} catch {
					// Ignore git errors - branch will be empty string
				}
			}

			// Find group name for this session (sessions have groupId, groups have id)
			const sessionGroup = session.groupId ? groups.find((g) => g.id === session.groupId) : null;
			const groupName = sessionGroup?.name;

			// Calculate initial total tasks across all documents
			let initialTotalTasks = 0;
			for (const doc of documents) {
				const { taskCount } = await readDocAndCountTasks(folderPath, doc.filename, sshRemoteId);
				initialTotalTasks += taskCount;
			}

			if (initialTotalTasks === 0) {
				window.maestro.logger.log(
					'warn',
					'No unchecked tasks found across all documents',
					'BatchProcessor',
					{ sessionId }
				);
				return;
			}

			// Initialize batch run state using START_BATCH action directly
			// (not updateBatchStateAndBroadcast which only supports UPDATE_PROGRESS)
			const lockedDocuments = documents.map((d) => d.filename);
			dispatch({
				type: 'START_BATCH',
				sessionId,
				payload: {
					documents: documents.map((d) => d.filename),
					lockedDocuments,
					totalTasksAcrossAllDocs: initialTotalTasks,
					loopEnabled,
					maxLoops,
					folderPath,
					worktreeActive,
					worktreePath,
					worktreeBranch,
					customPrompt: prompt !== '' ? prompt : undefined,
					startTime: batchStartTime,
					// Time tracking
					cumulativeTaskTimeMs: 0, // Sum of actual task durations (most accurate)
					accumulatedElapsedMs: 0, // Visibility-based time (excludes sleep/suspend)
					lastActiveTimestamp: batchStartTime,
				},
			});
			// Broadcast state change
			broadcastAutoRunState(sessionId, {
				isRunning: true,
				isStopping: false,
				documents: documents.map((d) => d.filename),
				lockedDocuments,
				currentDocumentIndex: 0,
				currentDocTasksTotal: 0,
				currentDocTasksCompleted: 0,
				totalTasksAcrossAllDocs: initialTotalTasks,
				completedTasksAcrossAllDocs: 0,
				loopEnabled,
				loopIteration: 0,
				maxLoops,
				folderPath,
				worktreeActive,
				worktreePath,
				worktreeBranch,
				totalTasks: initialTotalTasks,
				completedTasks: 0,
				currentTaskIndex: 0,
				originalContent: '',
				customPrompt: prompt !== '' ? prompt : undefined,
				sessionIds: [],
				startTime: batchStartTime,
				accumulatedElapsedMs: 0,
				lastActiveTimestamp: batchStartTime,
			});

			// AUTORUN LOG: Start
			window.maestro.logger.autorun(`Auto Run started`, session.name, {
				documents: documents.map((d) => d.filename),
				totalTasks: initialTotalTasks,
				loopEnabled,
				maxLoops: maxLoops ?? 'unlimited',
			});

			// Add initial history entry when using worktree
			if (worktreeActive && worktreePath && worktreeBranch) {
				const worktreeStartSummary = `Auto Run started in worktree`;
				const worktreeStartDetails = [
					`**Worktree Auto Run Started**`,
					``,
					`- **Branch:** \`${worktreeBranch}\``,
					`- **Worktree Path:** \`${worktreePath}\``,
					`- **Main Repo:** \`${session.cwd}\``,
					`- **Documents:** ${documents.map((d) => d.filename).join(', ')}`,
					`- **Total Tasks:** ${initialTotalTasks}`,
					loopEnabled ? `- **Loop Mode:** Enabled${maxLoops ? ` (max ${maxLoops})` : ''}` : '',
				]
					.filter((line) => line !== '')
					.join('\n');

				onAddHistoryEntry({
					type: 'AUTO',
					timestamp: Date.now(),
					summary: worktreeStartSummary,
					fullResponse: worktreeStartDetails,
					projectPath: effectiveCwd,
					sessionId: sessionId,
					success: true,
				});
			}

			// Store custom prompt for persistence
			setCustomPrompts((prev) => ({ ...prev, [sessionId]: prompt }));

			// State machine: INITIALIZING -> RUNNING (initialization complete)
			dispatch({ type: 'SET_RUNNING', sessionId });

			// Prevent system sleep while Auto Run is active
			window.maestro.power.addReason(`autorun:${sessionId}`);

			// Start stats tracking for this Auto Run session
			let statsAutoRunId: string | null = null;
			try {
				statsAutoRunId = await window.maestro.stats.startAutoRun({
					sessionId: sessionId,
					agentType: session.toolType,
					documentPath: documents.map((d) => d.filename).join(', '),
					startTime: batchStartTime,
					tasksTotal: initialTotalTasks,
					projectPath: session.cwd,
				});
			} catch (statsError) {
				// Don't fail the batch if stats tracking fails
				console.warn('[BatchProcessor] Failed to start stats tracking:', statsError);
			}

			// Collect Claude session IDs and track completion
			const agentSessionIds: string[] = [];
			let totalCompletedTasks = 0;
			let loopIteration = 0;

			// Per-loop tracking for loop summary
			let loopStartTime = Date.now();
			let loopTasksCompleted = 0;
			let loopTotalInputTokens = 0;
			let loopTotalOutputTokens = 0;
			let loopTotalCost = 0;

			// Cumulative tracking for final Auto Run summary (across all loops)
			let totalInputTokens = 0;
			let totalOutputTokens = 0;
			let totalCost = 0;

			// Track consecutive runs where document content didn't change to detect stalling
			// If the document hash is identical before/after a run (and no tasks checked), the LLM is stuck
			// Note: This counter is reset per-document, so stalling one document doesn't affect others
			let consecutiveNoChangeCount = 0;
			const MAX_CONSECUTIVE_NO_CHANGES = 2; // Skip document after 2 consecutive runs with no changes

			// Track stalled documents (document filename -> stall reason)
			const stalledDocuments: Map<string, string> = new Map();

			// Track working copies for reset-on-completion documents (original filename -> working copy path)
			// Working copies are stored in /Runs/ and serve as audit logs
			const workingCopies: Map<string, string> = new Map();

			// Helper to add final loop summary (defined here so it has access to tracking vars)
			const addFinalLoopSummary = (exitReason: string) => {
				// AUTORUN LOG: Exit
				window.maestro.logger.autorun(`Auto Run exiting: ${exitReason}`, session.name, {
					reason: exitReason,
					totalTasksCompleted: totalCompletedTasks,
					loopsCompleted: loopIteration + 1,
				});

				if (loopEnabled && (loopTasksCompleted > 0 || loopIteration > 0)) {
					onAddHistoryEntry(
						createLoopSummaryEntry({
							loopIteration,
							loopTasksCompleted,
							loopStartTime,
							loopTotalInputTokens,
							loopTotalOutputTokens,
							loopTotalCost,
							sessionCwd: session.cwd,
							sessionId,
							isFinal: true,
							exitReason,
						})
					);
				}
			};

			// Main processing loop (handles loop mode)
			while (true) {
				// Check for stop request
				if (stopRequestedRefs.current[sessionId]) {
					addFinalLoopSummary('Stopped by user');
					break;
				}

				// Track if any tasks were processed in this iteration
				let anyTasksProcessedThisIteration = false;

				// Process each document in order
				for (let docIndex = 0; docIndex < documents.length; docIndex++) {
					// Check for stop request before each document
					if (stopRequestedRefs.current[sessionId]) {
						break;
					}

					const docEntry = documents[docIndex];

					// Read document and count tasks
					let {
						taskCount: remainingTasks,
						content: docContent,
						checkedCount: docCheckedCount,
					} = await readDocAndCountTasks(folderPath, docEntry.filename, sshRemoteId);
					let docTasksTotal = remainingTasks;

					// Handle documents with no unchecked tasks
					if (remainingTasks === 0) {
						// For reset-on-completion documents, check if there are checked tasks that need resetting
						if (docEntry.resetOnCompletion && loopEnabled) {
							// Use docCheckedCount from readDocAndCountTasks instead of calling countCheckedTasks again
							if (docCheckedCount > 0) {
								const resetContent = uncheckAllTasks(docContent);
								await window.maestro.autorun.writeDoc(
									folderPath,
									docEntry.filename + '.md',
									resetContent,
									sshRemoteId
								);
								// Update task count in state
								const resetTaskCount = countUnfinishedTasks(resetContent);
								updateBatchStateAndBroadcastRef.current!(sessionId, (prev) => ({
									...prev,
									[sessionId]: {
										...prev[sessionId],
										totalTasksAcrossAllDocs:
											prev[sessionId].totalTasksAcrossAllDocs + resetTaskCount,
										totalTasks: prev[sessionId].totalTasks + resetTaskCount,
									},
								}));
							}
						}
						continue;
					}

					// Reset stall detection counter for each new document
					consecutiveNoChangeCount = 0;

					// The actual filename to process (may be working copy for reset-on-completion docs)
					let effectiveFilename = docEntry.filename;

					// Create working copy for reset-on-completion documents
					// Working copies are stored in /Runs/ and the original is never modified
					if (docEntry.resetOnCompletion) {
						try {
							const { workingCopyPath } = await window.maestro.autorun.createWorkingCopy(
								folderPath,
								docEntry.filename,
								loopIteration + 1 // 1-indexed loop number
							);
							workingCopies.set(docEntry.filename, workingCopyPath);
							effectiveFilename = workingCopyPath;

							// Re-read the working copy for task counting
							const workingCopyResult = await readDocAndCountTasks(
								folderPath,
								effectiveFilename,
								sshRemoteId
							);
							remainingTasks = workingCopyResult.taskCount;
							docContent = workingCopyResult.content;
							docCheckedCount = workingCopyResult.checkedCount;
							docTasksTotal = remainingTasks;
						} catch (err) {
							console.error(
								`[BatchProcessor] Failed to create working copy for ${docEntry.filename}:`,
								err
							);
							// Continue with original document as fallback
						}
					}

					// AUTORUN LOG: Document processing
					window.maestro.logger.autorun(`Processing document: ${docEntry.filename}`, session.name, {
						document: docEntry.filename,
						tasksRemaining: remainingTasks,
						loopNumber: loopIteration + 1,
					});

					// Update state to show current document
					updateBatchStateAndBroadcastRef.current!(sessionId, (prev) => ({
						...prev,
						[sessionId]: {
							...prev[sessionId],
							currentDocumentIndex: docIndex,
							currentDocTasksTotal: docTasksTotal,
							currentDocTasksCompleted: 0,
						},
					}));

					let docTasksCompleted = 0;
					let skipCurrentDocumentAfterError = false;

					// Process tasks in this document until none remain
					while (remainingTasks > 0) {
						// Check for stop request before each task
						if (stopRequestedRefs.current[sessionId]) {
							break;
						}

						// Pause processing until the user resolves the error state
						const errorResolution = errorResolutionRefs.current[sessionId];
						if (errorResolution) {
							const action = await errorResolution.promise;
							delete errorResolutionRefs.current[sessionId];

							if (action === 'abort') {
								stopRequestedRefs.current[sessionId] = true;
								break;
							}

							if (action === 'skip-document') {
								skipCurrentDocumentAfterError = true;
								break;
							}
						}

						// Use extracted document processor hook for task processing
						// This handles: template substitution, document expansion, agent spawning,
						// session registration, re-reading document, and synopsis generation
						try {
							const taskResult = await documentProcessor.processTask(
								{
									folderPath,
									session,
									gitBranch,
									groupName,
									loopIteration: loopIteration + 1, // 1-indexed
									effectiveCwd,
									customPrompt: prompt,
									sshRemoteId,
								},
								effectiveFilename, // Use working copy path for reset-on-completion docs
								docCheckedCount,
								remainingTasks,
								docContent,
								{
									onSpawnAgent,
								}
							);

							// Track agent session IDs
							if (taskResult.agentSessionId) {
								agentSessionIds.push(taskResult.agentSessionId);
							}

							anyTasksProcessedThisIteration = true;

							// Extract results from processTask
							const {
								tasksCompletedThisRun,
								addedUncheckedTasks,
								totalTasksChange,
								newRemainingTasks,
								documentChanged,
								newCheckedCount,
								shortSummary,
								fullSynopsis,
								usageStats,
								elapsedTimeMs,
								agentSessionId,
								success,
							} = taskResult;

							// Detect stalling: if document content is unchanged and no tasks were checked off
							if (!documentChanged && tasksCompletedThisRun === 0) {
								consecutiveNoChangeCount++;
							} else {
								// Reset counter on any document change or task completion
								consecutiveNoChangeCount = 0;
							}

							// Update counters
							docTasksCompleted += tasksCompletedThisRun;
							totalCompletedTasks += tasksCompletedThisRun;
							loopTasksCompleted += tasksCompletedThisRun;

							// Record this task in stats database (if stats tracking is active)
							if (statsAutoRunId && tasksCompletedThisRun > 0) {
								try {
									await window.maestro.stats.recordAutoTask({
										autoRunSessionId: statsAutoRunId,
										sessionId: sessionId,
										agentType: session.toolType,
										taskIndex: totalCompletedTasks - 1, // 0-indexed
										taskContent: shortSummary || undefined,
										startTime: Date.now() - elapsedTimeMs,
										duration: elapsedTimeMs,
										success: success,
									});
								} catch (statsError) {
									// Don't fail the batch if stats tracking fails
									console.warn('[BatchProcessor] Failed to record task stats:', statsError);
								}
							}

							// Track token usage for loop summary and cumulative totals
							if (usageStats) {
								loopTotalInputTokens += usageStats.inputTokens || 0;
								loopTotalOutputTokens += usageStats.outputTokens || 0;
								loopTotalCost += usageStats.totalCostUsd || 0;
								// Also track cumulative totals for final summary
								totalInputTokens += usageStats.inputTokens || 0;
								totalOutputTokens += usageStats.outputTokens || 0;
								totalCost += usageStats.totalCostUsd || 0;
							}

							// Track non-reset document completions for loop exit logic
							// (This tracking is intentionally a no-op for now - kept for future loop mode enhancements)
							void (!docEntry.resetOnCompletion ? tasksCompletedThisRun : 0);

							// Update progress state for current document
							if (addedUncheckedTasks > 0) {
								docTasksTotal += addedUncheckedTasks;
							}

							updateBatchStateAndBroadcastRef.current!(sessionId, (prev) => {
								const prevState = prev[sessionId] || DEFAULT_BATCH_STATE;
								// Use totalTasksChange for accurate overall tracking
								// This correctly accounts for both completed tasks and newly added tasks
								const nextTotalAcrossAllDocs = Math.max(
									0,
									prevState.totalTasksAcrossAllDocs + totalTasksChange
								);
								const nextTotalTasks = Math.max(0, prevState.totalTasks + totalTasksChange);

								return {
									...prev,
									[sessionId]: {
										...prevState,
										currentDocTasksCompleted: docTasksCompleted,
										currentDocTasksTotal: docTasksTotal,
										completedTasksAcrossAllDocs: totalCompletedTasks,
										totalTasksAcrossAllDocs: nextTotalAcrossAllDocs,
										// Accumulate actual task duration (most accurate work time tracking)
										cumulativeTaskTimeMs: (prevState.cumulativeTaskTimeMs || 0) + elapsedTimeMs,
										// Legacy fields
										completedTasks: totalCompletedTasks,
										totalTasks: nextTotalTasks,
										currentTaskIndex: totalCompletedTasks,
										sessionIds: [...(prevState?.sessionIds || []), agentSessionId || ''],
									},
								};
							});

							// Add history entry
							// Use effectiveCwd for projectPath so clicking the session link looks in the right place
							onAddHistoryEntry({
								type: 'AUTO',
								timestamp: Date.now(),
								summary: shortSummary,
								fullResponse: fullSynopsis,
								agentSessionId,
								projectPath: effectiveCwd,
								sessionId: sessionId,
								success,
								usageStats,
								elapsedTimeMs,
							});

							// Speak the synopsis via TTS if audio feedback is enabled
							if (audioFeedbackEnabled && audioFeedbackCommand && shortSummary) {
								window.maestro.notification
									.speak(shortSummary, audioFeedbackCommand)
									.catch((err) => {
										console.error('[BatchProcessor] Failed to speak synopsis:', err);
									});
							}

							// Check if we've hit the stalling threshold for this document
							if (consecutiveNoChangeCount >= MAX_CONSECUTIVE_NO_CHANGES) {
								const stallReason = `${consecutiveNoChangeCount} consecutive runs with no progress`;

								// Track this document as stalled
								stalledDocuments.set(docEntry.filename, stallReason);

								// AUTORUN LOG: Document stalled
								window.maestro.logger.autorun(
									`Document stalled: ${docEntry.filename}`,
									session.name,
									{
										document: docEntry.filename,
										reason: stallReason,
										remainingTasks: newRemainingTasks,
										loopNumber: loopIteration + 1,
									}
								);

								// Add a history entry specifically for this stalled document
								const stallExplanation = [
									`**Document Stalled: ${docEntry.filename}**`,
									'',
									`The AI agent ran ${consecutiveNoChangeCount} times on this document but made no progress:`,
									`- No tasks were checked off`,
									`- No changes were made to the document content`,
									'',
									`**What this means:**`,
									`The remaining tasks in this document may be:`,
									`- Already complete (but not checked off)`,
									`- Unclear or ambiguous for the AI to act on`,
									`- Dependent on external factors or manual intervention`,
									`- Outside the scope of what the AI can accomplish`,
									'',
									`**Remaining unchecked tasks:** ${newRemainingTasks}`,
									'',
									documents.length > 1
										? `Skipping to the next document in the playbook...`
										: `No more documents to process.`,
								].join('\n');

								onAddHistoryEntry({
									type: 'AUTO',
									timestamp: Date.now(),
									summary: `Document stalled: ${docEntry.filename} (${newRemainingTasks} tasks remaining)`,
									fullResponse: stallExplanation,
									projectPath: effectiveCwd,
									sessionId: sessionId,
									success: false, // Mark as unsuccessful since we couldn't complete
								});

								// Skip to the next document instead of breaking the entire batch
								break; // Break out of the inner while loop for this document
							}

							docCheckedCount = newCheckedCount;
							remainingTasks = newRemainingTasks;
							docContent = taskResult.contentAfterTask;
						} catch (error) {
							console.error(
								`[BatchProcessor] Error running task in ${docEntry.filename} for session ${sessionId}:`,
								error
							);
							// Continue to next task on error
							remainingTasks--;
						}
					}

					// Check for stop request before moving to next document
					if (stopRequestedRefs.current[sessionId]) {
						break;
					}

					// Skip document handling if this document stalled (it didn't complete normally)
					if (stalledDocuments.has(docEntry.filename)) {
						// Working copy approach: stalled working copy stays in /Runs/ as audit log
						// Original document is untouched, so nothing to restore
						workingCopies.delete(docEntry.filename);
						// Reset consecutive no-change counter for next document
						consecutiveNoChangeCount = 0;
						continue;
					}

					if (skipCurrentDocumentAfterError) {
						// Working copy approach: errored working copy stays in /Runs/ as audit log
						// Original document is untouched, so nothing to restore
						workingCopies.delete(docEntry.filename);
						continue;
					}

					// Document complete - for reset-on-completion docs, original is untouched
					// Working copy in /Runs/ serves as the audit log of this loop's work
					if (docEntry.resetOnCompletion && docTasksCompleted > 0) {
						// AUTORUN LOG: Document loop completed
						window.maestro.logger.autorun(
							`Document loop completed: ${docEntry.filename}`,
							session.name,
							{
								document: docEntry.filename,
								workingCopy: workingCopies.get(docEntry.filename),
								tasksCompleted: docTasksCompleted,
								loopNumber: loopIteration + 1,
							}
						);

						// For loop mode, re-count tasks in the original document for next iteration
						// (original is unchanged, so it still has all unchecked tasks)
						if (loopEnabled) {
							const { taskCount: resetTaskCount } = await readDocAndCountTasks(
								folderPath,
								docEntry.filename,
								sshRemoteId
							);
							updateBatchStateAndBroadcastRef.current!(sessionId, (prev) => ({
								...prev,
								[sessionId]: {
									...prev[sessionId],
									totalTasksAcrossAllDocs: prev[sessionId].totalTasksAcrossAllDocs + resetTaskCount,
									totalTasks: prev[sessionId].totalTasks + resetTaskCount,
								},
							}));
						}

						// Clear tracking - working copy stays in /Runs/ as audit log
						workingCopies.delete(docEntry.filename);
					} else if (docEntry.resetOnCompletion) {
						// Document had reset enabled but no tasks were completed
						// Working copy still serves as record of the attempt
						workingCopies.delete(docEntry.filename);
					}
				}

				// Note: We no longer break immediately when a document stalls.
				// Individual documents that stall are skipped, and we continue processing other documents.
				// The stalledDocuments map tracks which documents stalled for the final summary.

				// Check if we should continue looping
				if (!loopEnabled) {
					// No loop mode - we're done after one pass
					// AUTORUN LOG: Exit (non-loop mode)
					window.maestro.logger.autorun(`Auto Run completed (single pass)`, session.name, {
						reason: 'Single pass completed',
						totalTasksCompleted: totalCompletedTasks,
						loopsCompleted: 1,
					});
					break;
				}

				// Check if we've hit the max loop limit
				if (maxLoops !== null && maxLoops !== undefined && loopIteration + 1 >= maxLoops) {
					addFinalLoopSummary(`Reached max loop limit (${maxLoops})`);
					break;
				}

				// Check for stop request after full pass
				if (stopRequestedRefs.current[sessionId]) {
					addFinalLoopSummary('Stopped by user');
					break;
				}

				// Safety check: if we didn't process ANY tasks this iteration, exit to avoid infinite loop
				if (!anyTasksProcessedThisIteration) {
					addFinalLoopSummary('No tasks processed this iteration');
					break;
				}

				// Loop mode: check if we should continue looping
				// Check if there are any non-reset documents in the playbook
				const hasAnyNonResetDocs = documents.some((doc) => !doc.resetOnCompletion);

				if (hasAnyNonResetDocs) {
					// If we have non-reset docs, only continue if they have remaining tasks
					let anyNonResetDocsHaveTasks = false;
					for (const doc of documents) {
						if (doc.resetOnCompletion) continue;

						const { taskCount } = await readDocAndCountTasks(folderPath, doc.filename, sshRemoteId);
						if (taskCount > 0) {
							anyNonResetDocsHaveTasks = true;
							break;
						}
					}

					if (!anyNonResetDocsHaveTasks) {
						addFinalLoopSummary('All tasks completed');
						break;
					}
				}
				// If all documents are reset docs, we continue looping (maxLoops check above will stop us)

				// Re-scan all documents to get fresh task counts for next loop (tasks may have been added/removed)
				let newTotalTasks = 0;
				for (const doc of documents) {
					const { taskCount } = await readDocAndCountTasks(folderPath, doc.filename, sshRemoteId);
					newTotalTasks += taskCount;
				}

				// Calculate loop elapsed time
				const loopElapsedMs = Date.now() - loopStartTime;

				// Add loop summary history entry
				const loopSummary = `Loop ${loopIteration + 1} completed: ${loopTasksCompleted} task${loopTasksCompleted !== 1 ? 's' : ''} accomplished`;
				const loopDetails = [
					`**Loop ${loopIteration + 1} Summary**`,
					'',
					`- **Tasks Accomplished:** ${loopTasksCompleted}`,
					`- **Duration:** ${formatElapsedTime(loopElapsedMs)}`,
					loopTotalInputTokens > 0 || loopTotalOutputTokens > 0
						? `- **Tokens:** ${(loopTotalInputTokens + loopTotalOutputTokens).toLocaleString()} (${loopTotalInputTokens.toLocaleString()} in / ${loopTotalOutputTokens.toLocaleString()} out)`
						: '',
					loopTotalCost > 0 ? `- **Cost:** $${loopTotalCost.toFixed(4)}` : '',
					`- **Tasks Discovered for Next Loop:** ${newTotalTasks}`,
				]
					.filter((line) => line !== '')
					.join('\n');

				onAddHistoryEntry({
					type: 'AUTO',
					timestamp: Date.now(),
					summary: loopSummary,
					fullResponse: loopDetails,
					projectPath: session.cwd,
					sessionId: sessionId,
					success: true,
					elapsedTimeMs: loopElapsedMs,
					usageStats:
						loopTotalInputTokens > 0 || loopTotalOutputTokens > 0
							? {
									inputTokens: loopTotalInputTokens,
									outputTokens: loopTotalOutputTokens,
									cacheReadInputTokens: 0,
									cacheCreationInputTokens: 0,
									totalCostUsd: loopTotalCost,
									contextWindow: 0,
								}
							: undefined,
				});

				// Reset per-loop tracking for next iteration
				loopStartTime = Date.now();
				loopTasksCompleted = 0;
				loopTotalInputTokens = 0;
				loopTotalOutputTokens = 0;
				loopTotalCost = 0;

				// AUTORUN LOG: Loop completion
				window.maestro.logger.autorun(`Loop ${loopIteration + 1} completed`, session.name, {
					loopNumber: loopIteration + 1,
					tasksCompleted: loopTasksCompleted,
					tasksForNextLoop: newTotalTasks,
				});

				// Continue looping
				loopIteration++;

				updateBatchStateAndBroadcastRef.current!(sessionId, (prev) => ({
					...prev,
					[sessionId]: {
						...prev[sessionId],
						loopIteration,
						totalTasksAcrossAllDocs: newTotalTasks + prev[sessionId].completedTasksAcrossAllDocs,
						totalTasks: newTotalTasks + prev[sessionId].completedTasks,
					},
				}));
			}

			// Working copy approach: no cleanup needed
			// - Original documents are never modified
			// - Working copies in /Runs/ serve as audit logs and are kept
			// - User can delete them manually if desired

			// Create PR if worktree was used, PR creation is enabled, and not stopped
			const wasStopped = stopRequestedRefs.current[sessionId] || false;
			const sessionName = session.name || session.cwd.split('/').pop() || 'Unknown';
			if (
				worktreeActive &&
				worktree?.createPROnCompletion &&
				!wasStopped &&
				totalCompletedTasks > 0 &&
				worktreePath
			) {
				const prResult = await worktreeManager.createPR({
					worktreePath,
					mainRepoCwd: session.cwd,
					worktree,
					documents,
					totalCompletedTasks,
				});

				if (onPRResult) {
					onPRResult({
						sessionId,
						sessionName,
						success: prResult.success,
						prUrl: prResult.prUrl,
						error: prResult.error,
					});
				}
			}

			// Add final Auto Run summary entry
			// Calculate visibility-aware elapsed time using the extracted time tracking hook
			// (excludes time when laptop was sleeping/suspended)
			const totalElapsedMs = timeTracking.getElapsedTime(sessionId);
			const loopsCompleted = loopEnabled ? loopIteration + 1 : 1;

			// Determine status based on stalled documents and completion
			const stalledCount = stalledDocuments.size;
			const allDocsStalled = stalledCount === documents.length;
			const someDocsStalled = stalledCount > 0 && stalledCount < documents.length;
			const statusText = wasStopped
				? 'stopped'
				: allDocsStalled
					? 'stalled'
					: someDocsStalled
						? 'completed with stalls'
						: 'completed';

			// Calculate achievement progress for the summary
			// Note: We use the stats BEFORE this run is recorded (the parent will call recordAutoRunComplete after)
			// So we need to add totalElapsedMs to get the projected cumulative time
			const projectedCumulativeTime = (autoRunStats?.cumulativeTimeMs || 0) + totalElapsedMs;
			const currentBadge = getBadgeForTime(projectedCumulativeTime);
			const nextBadge = getNextBadge(currentBadge);
			const levelProgressText = nextBadge
				? `Level ${currentBadge?.level || 0} → ${nextBadge.level}: ${formatTimeRemaining(projectedCumulativeTime, nextBadge)}`
				: currentBadge
					? `Level ${currentBadge.level} (${currentBadge.name}) - Maximum level achieved!`
					: 'Level 0 → 1: ' + formatTimeRemaining(0, getBadgeForTime(0));

			// Build summary with stall info if applicable
			const stalledSuffix = stalledCount > 0 ? ` (${stalledCount} stalled)` : '';
			const finalSummary = `Auto Run ${statusText}: ${totalCompletedTasks} task${totalCompletedTasks !== 1 ? 's' : ''} in ${formatElapsedTime(totalElapsedMs)}${stalledSuffix}`;

			// Build status message with detailed info
			let statusMessage: string;
			if (wasStopped) {
				statusMessage = 'Stopped by user';
			} else if (allDocsStalled) {
				statusMessage = `Stalled - All ${stalledCount} document(s) stopped making progress`;
			} else if (someDocsStalled) {
				statusMessage = `Completed with ${stalledCount} stalled document(s)`;
			} else {
				statusMessage = 'Completed';
			}

			// Build stalled documents section if any documents stalled
			const stalledDocsSection: string[] = [];
			if (stalledCount > 0) {
				stalledDocsSection.push('');
				stalledDocsSection.push('**Stalled Documents**');
				stalledDocsSection.push('');
				stalledDocsSection.push(
					'The following documents stopped making progress after multiple attempts:'
				);
				for (const [docName, reason] of stalledDocuments) {
					stalledDocsSection.push(`- **${docName}**: ${reason}`);
				}
				stalledDocsSection.push('');
				stalledDocsSection.push(
					'*Tasks in stalled documents may need manual review or clarification.*'
				);
			}

			const finalDetails = [
				`**Auto Run Summary**`,
				'',
				`- **Status:** ${statusMessage}`,
				`- **Tasks Completed:** ${totalCompletedTasks}`,
				`- **Total Duration:** ${formatElapsedTime(totalElapsedMs)}`,
				loopEnabled ? `- **Loops Completed:** ${loopsCompleted}` : '',
				totalInputTokens > 0 || totalOutputTokens > 0
					? `- **Total Tokens:** ${(totalInputTokens + totalOutputTokens).toLocaleString()} (${totalInputTokens.toLocaleString()} in / ${totalOutputTokens.toLocaleString()} out)`
					: '',
				totalCost > 0 ? `- **Total Cost:** $${totalCost.toFixed(4)}` : '',
				'',
				`- **Documents:** ${documents.map((d) => d.filename).join(', ')}`,
				...stalledDocsSection,
				'',
				`**Achievement Progress**`,
				`- ${levelProgressText}`,
			]
				.filter((line) => line !== '')
				.join('\n');

			// Success is true if not stopped and at least some documents completed without stalling
			const isSuccess = !wasStopped && !allDocsStalled;

			try {
				await onAddHistoryEntry({
					type: 'AUTO',
					timestamp: Date.now(),
					summary: finalSummary,
					fullResponse: finalDetails,
					projectPath: session.cwd,
					sessionId, // Include sessionId so the summary appears in session's history
					success: isSuccess,
					elapsedTimeMs: totalElapsedMs,
					usageStats:
						totalInputTokens > 0 || totalOutputTokens > 0
							? {
									inputTokens: totalInputTokens,
									outputTokens: totalOutputTokens,
									cacheReadInputTokens: 0,
									cacheCreationInputTokens: 0,
									totalCostUsd: totalCost,
									contextWindow: 0,
								}
							: undefined,
					achievementAction: 'openAbout', // Enable clickable link to achievements panel
				});
			} catch {
				// Ignore history errors
			}

			// End stats tracking for this Auto Run session
			if (statsAutoRunId) {
				try {
					await window.maestro.stats.endAutoRun(
						statsAutoRunId,
						totalElapsedMs,
						totalCompletedTasks
					);
				} catch (statsError) {
					// Don't fail cleanup if stats tracking fails
					console.warn('[BatchProcessor] Failed to end stats tracking:', statsError);
				}
			}

			// Critical: Always flush debounced updates and dispatch COMPLETE_BATCH to clean up state.
			// These operations are safe regardless of mount state - React handles reducer dispatches gracefully,
			// and broadcasts are external calls that don't affect React state.
			console.log(
				'[BatchProcessor:startBatchRun] Flushing debounced updates before COMPLETE_BATCH'
			);
			flushDebouncedUpdate(sessionId);

			// Reset state for this session using COMPLETE_BATCH action
			// (not updateBatchStateAndBroadcast which only supports UPDATE_PROGRESS)
			dispatch({
				type: 'COMPLETE_BATCH',
				sessionId,
				finalSessionIds: agentSessionIds,
			});
			// Broadcast state change to web clients
			broadcastAutoRunState(sessionId, null);

			// Call completion callback if provided (only if still mounted to avoid warnings)
			if (isMountedRef.current && onComplete) {
				onComplete({
					sessionId,
					sessionName: session.name || session.cwd.split('/').pop() || 'Unknown',
					completedTasks: totalCompletedTasks,
					totalTasks: initialTotalTasks,
					wasStopped,
					elapsedTimeMs: totalElapsedMs,
				});
			}

			// Process any queued items that were waiting during batch run
			// This ensures pending user messages are processed after Auto Run ends
			if (isMountedRef.current && onProcessQueueAfterCompletion) {
				// Use setTimeout to let state updates settle before processing queue
				setTimeout(() => {
					onProcessQueueAfterCompletion(sessionId);
				}, 0);
			}

			// Clean up time tracking, error resolution, and stop request flag
			// Clearing stopRequestedRefs here (not just at start) ensures proper cleanup
			// regardless of how the batch ended (normal completion, stopped, or error)
			// Note: These cleanup operations are safe even after unmount (they only affect refs)
			timeTracking.stopTracking(sessionId);
			delete errorResolutionRefs.current[sessionId];
			delete stopRequestedRefs.current[sessionId];

			// Allow system to sleep now that Auto Run is complete
			window.maestro.power.removeReason(`autorun:${sessionId}`);
			// Note: updateBatchStateAndBroadcast is accessed via ref to avoid stale closure in long-running async
			// flushDebouncedUpdate is stable (empty deps in useSessionDebounce) so adding it doesn't cause re-renders
		},
		[
			onUpdateSession,
			onSpawnAgent,
			onAddHistoryEntry,
			onComplete,
			onPRResult,
			audioFeedbackEnabled,
			audioFeedbackCommand,
			timeTracking,
			onProcessQueueAfterCompletion,
			flushDebouncedUpdate,
		]
	);

	/**
	 * Request to stop the batch run for a specific session after current task completes
	 * Note: No isMountedRef check here - stop requests should always be honored.
	 * All operations are safe: ref updates, reducer dispatch (React handles gracefully), and broadcasts.
	 */
	const stopBatchRun = useCallback(
		(sessionId: string) => {
			console.log('[BatchProcessor:stopBatchRun] Called with sessionId:', sessionId);
			stopRequestedRefs.current[sessionId] = true;
			const errorResolution = errorResolutionRefs.current[sessionId];
			if (errorResolution) {
				errorResolution.resolve('abort');
				delete errorResolutionRefs.current[sessionId];
			}
			// Use SET_STOPPING action directly (not updateBatchStateAndBroadcast which only supports UPDATE_PROGRESS)
			dispatch({ type: 'SET_STOPPING', sessionId });
			// Broadcast state change
			const newState = batchRunStatesRef.current[sessionId];
			if (newState) {
				broadcastAutoRunState(sessionId, { ...newState, isStopping: true });
			}
		},
		[broadcastAutoRunState]
	);

	/**
	 * Pause the batch run due to an agent error (Phase 5.10)
	 * Called externally when agent error is detected
	 */
	const pauseBatchOnError = useCallback(
		(sessionId: string, error: AgentError, documentIndex: number, taskDescription?: string) => {
			if (!isMountedRef.current) return;

			// Log detailed error to system logs with full context
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

			// Use SET_ERROR action directly (not updateBatchStateAndBroadcast which only supports UPDATE_PROGRESS)
			dispatch({
				type: 'SET_ERROR',
				sessionId,
				payload: { error, documentIndex, taskDescription },
			});
			// Broadcast state change
			const currentState = batchRunStatesRef.current[sessionId];
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
		[broadcastAutoRunState]
	);

	/**
	 * Skip the current document that caused an error and continue with the next one (Phase 5.10)
	 */
	const skipCurrentDocument = useCallback(
		(sessionId: string) => {
			if (!isMountedRef.current) return;

			window.maestro.logger.autorun(`Skipping document after error`, sessionId, {});

			// Use CLEAR_ERROR action directly (not updateBatchStateAndBroadcast which only supports UPDATE_PROGRESS)
			dispatch({ type: 'CLEAR_ERROR', sessionId });
			// Broadcast state change
			const currentState = batchRunStatesRef.current[sessionId];
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

			// Signal to skip the current document in the processing loop
		},
		[broadcastAutoRunState]
	);

	/**
	 * Resume the batch run after an error has been resolved (Phase 5.10)
	 * This clears the error state and allows the batch to continue
	 */
	const resumeAfterError = useCallback(
		(sessionId: string) => {
			if (!isMountedRef.current) return;

			window.maestro.logger.autorun(`Resuming Auto Run after error resolution`, sessionId, {});

			// Use CLEAR_ERROR action directly (not updateBatchStateAndBroadcast which only supports UPDATE_PROGRESS)
			dispatch({ type: 'CLEAR_ERROR', sessionId });
			// Broadcast state change
			const currentState = batchRunStatesRef.current[sessionId];
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
		[broadcastAutoRunState]
	);

	/**
	 * Abort the batch run completely due to an unrecoverable error (Phase 5.10)
	 */
	const abortBatchOnError = useCallback(
		(sessionId: string) => {
			if (!isMountedRef.current) return;

			window.maestro.logger.autorun(`Auto Run aborted due to error`, sessionId, {});

			// Request stop and clear error state
			stopRequestedRefs.current[sessionId] = true;
			const errorResolution = errorResolutionRefs.current[sessionId];
			if (errorResolution) {
				errorResolution.resolve('abort');
				delete errorResolutionRefs.current[sessionId];
			}
			updateBatchStateAndBroadcast(
				sessionId,
				(prev) => ({
					...prev,
					[sessionId]: {
						...prev[sessionId],
						isStopping: true,
						error: undefined,
						errorPaused: false,
						errorDocumentIndex: undefined,
						errorTaskDescription: undefined,
					},
				}),
				true
			); // immediate: critical state change (aborting)
		},
		[updateBatchStateAndBroadcast]
	);

	return {
		batchRunStates,
		getBatchState,
		hasAnyActiveBatch,
		activeBatchSessionIds,
		stoppingBatchSessionIds,
		startBatchRun,
		stopBatchRun,
		customPrompts,
		setCustomPrompt,
		// Error handling (Phase 5.10)
		pauseBatchOnError,
		skipCurrentDocument,
		resumeAfterError,
		abortBatchOnError,
	};
}
