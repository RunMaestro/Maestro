import { useCallback } from 'react';
import type { MutableRefObject } from 'react';
import type {
	BatchRunState,
	BatchRunConfig,
	Session,
	HistoryEntry,
	UsageStats,
	Group,
	AutoRunStats,
	AgentError,
} from '../../../types';
import type { AgentSpawnErrorKind } from '../../agent/useAgentExecution';
import { gitService } from '../../../services/git';
import { logger } from '../../../utils/logger';
import { notifyToast } from '../../../stores/notificationStore';
import { useBatchStore } from '../../../stores/batchStore';
import { useSessionStore, selectSessionById } from '../../../stores/sessionStore';
import { useSettingsStore } from '../../../stores/settingsStore';
import { countUnfinishedTasks, findPendingHitlGate, uncheckAllTasks } from '../batchUtils';
import { detectHaltMarker } from '../../../../shared/autorun/haltMarker';
import { DEFAULT_BATCH_STATE, type BatchAction } from '../batchReducer';
import { createLoopSummaryEntry } from './batchLoopSummary';
import {
	aggregateAutoRunHistoryTotals,
	buildFinalSummary,
	mergeFinalSummaryTotals,
} from './batchFinalSummary';
import { createProgressPoll } from './batchProgressPoll';
import { claimFlushState, type AutoRunFlushStateRefs } from './batchFlushState';
import type { ErrorResolutionEntry } from './useBatchControlActions';
import type { BatchCompleteInfo, PRResultInfo } from '../useBatchProcessor';
import type { UseTimeTrackingReturn } from '../useTimeTracking';
import type { UseWorktreeManagerReturn } from '../useWorktreeManager';
import type { UseDocumentProcessorReturn } from '../useDocumentProcessor';

const AUTO_RUN_PROGRESS_POLL_INTERVAL_MS = 20000;

type UpdateBatchStateFn = (
	sessionId: string,
	updater: (prev: Record<string, BatchRunState>) => Record<string, BatchRunState>,
	immediate?: boolean
) => void;

type SpawnAgentFn = (
	sessionId: string,
	prompt: string,
	cwdOverride?: string
) => Promise<{
	success: boolean;
	response?: string;
	agentSessionId?: string;
	usageStats?: UsageStats;
	contextUsage?: number;
	error?: string;
	errorKind?: AgentSpawnErrorKind;
}>;

export interface UseBatchRunnerDeps {
	// Refs
	sessionsRef: MutableRefObject<Session[]>;
	audioFeedbackEnabledRef: MutableRefObject<boolean | undefined>;
	audioFeedbackCommandRef: MutableRefObject<string | undefined>;
	autoRunFlushStateRefs: AutoRunFlushStateRefs;
	errorResolutionRefs: MutableRefObject<Record<string, ErrorResolutionEntry>>;
	stopRequestedRefs: MutableRefObject<Record<string, boolean>>;
	isMountedRef: MutableRefObject<boolean>;
	updateBatchStateAndBroadcastRef: MutableRefObject<UpdateBatchStateFn | null>;
	// Hook outputs
	broadcastAutoRunState: (sessionId: string, state: BatchRunState | null) => void;
	flushDebouncedUpdate: (sessionId: string) => void;
	dispatch: (action: BatchAction) => void;
	pauseBatchOnError: (
		sessionId: string,
		error: AgentError,
		documentIndex: number,
		taskDescription?: string
	) => void;
	timeTracking: UseTimeTrackingReturn;
	worktreeManager: UseWorktreeManagerReturn;
	documentProcessor: UseDocumentProcessorReturn;
	// Coordinator props
	groups: Group[];
	autoRunStats?: AutoRunStats;
	onUpdateSession: (sessionId: string, updates: Partial<Session>) => void;
	onSpawnAgent: SpawnAgentFn;
	onAddHistoryEntry: (entry: Omit<HistoryEntry, 'id'>) => void | Promise<void>;
	onComplete?: (info: BatchCompleteInfo) => void;
	onPRResult?: (info: PRResultInfo) => void;
	onProcessQueueAfterCompletion?: (sessionId: string) => void;
}

export interface UseBatchRunnerReturn {
	startBatchRun: (sessionId: string, config: BatchRunConfig, folderPath: string) => Promise<void>;
}

/**
 * The Auto Run orchestrator. Owns `startBatchRun` — initial validation,
 * worktree setup, the per-document/per-task loop, stall detection, progress
 * polling, history recording, the natural-completion final-summary path
 * (claiming the flush state via `claimFlushState`), `onComplete`, and the
 * post-run cleanup.
 *
 * All per-session refs and shared hook outputs flow in through `deps` so
 * the runner can be unit-tested in isolation. `updateBatchStateAndBroadcastRef`
 * remains a ref so the long-running async loop survives HMR re-renders.
 */
export function useBatchRunner({
	sessionsRef,
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
}: UseBatchRunnerDeps): UseBatchRunnerReturn {
	const readDocAndCountTasks = documentProcessor.readDocAndCountTasks;

	/**
	 * Start a batch processing run for a specific session with multi-document support.
	 * Note: sessionId and folderPath can belong to different sessions when running
	 * in a worktree — the parent session owns the Auto Run documents (folderPath)
	 * while the worktree agent (sessionId) executes the tasks.
	 */
	const startBatchRun = useCallback(
		async (sessionId: string, config: BatchRunConfig, folderPath: string) => {
			// Check global Auto Run kill switch
			if (useSettingsStore.getState().autoRunDisabled) {
				window.maestro.logger.log(
					'warn',
					'Auto Run is disabled via autoRunDisabled setting',
					'BatchProcessor',
					{ sessionId }
				);
				notifyToast({
					type: 'warning',
					title: 'Auto Run Disabled',
					message: 'Auto Run is disabled. Enable it in Settings to use this feature.',
				});
				return;
			}

			window.maestro.logger.log('info', 'startBatchRun called', 'BatchProcessor', {
				sessionId,
				folderPath,
				documentsCount: config.documents.length,
				worktreeEnabled: config.worktree?.enabled,
			});

			// Use sessionsRef first, then fall back to Zustand store for sessions just created
			// (sessionsRef updates on React re-render, but Zustand store updates synchronously)
			const session =
				sessionsRef.current.find((s) => s.id === sessionId) ||
				selectSessionById(sessionId)(useSessionStore.getState());
			if (!session) {
				const worktreeInfo = config.worktreeTarget
					? ` (worktree mode: ${config.worktreeTarget.mode}, path: ${
							config.worktreeTarget.mode === 'existing-closed'
								? config.worktreeTarget.worktreePath
								: config.worktreeTarget.mode === 'create-new'
									? config.worktreeTarget.newBranchName
									: config.worktreeTarget.sessionId
						})`
					: '';
				window.maestro.logger.log(
					'error',
					`Session not found for batch processing${worktreeInfo}`,
					'BatchProcessor',
					{
						sessionId,
						worktreeTargetMode: config.worktreeTarget?.mode,
						availableSessionIds: sessionsRef.current.map((s) => s.id),
					}
				);
				return;
			}

			const { documents, prompt, loopEnabled, maxLoops, taskSelectionMode, worktree } = config;

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

			// Set up worktree if enabled using extracted hook.
			// Note: sshRemoteId is only set after AI agent spawns. For terminal-only SSH sessions,
			// we must fall back to sessionSshRemoteConfig.remoteId. See CLAUDE.md "SSH Remote Sessions".
			const sshRemoteId =
				session.sshRemoteId || session.sessionSshRemoteConfig?.remoteId || undefined;

			let effectiveCwd: string;
			let worktreeActive: boolean;
			let worktreePath: string | undefined;
			let worktreeBranch: string | undefined;

			if (config.worktreeTarget) {
				// Worktree dispatch was already handled by useAutoRunHandlers
				// (spawnWorktreeAgentAndDispatch created the worktree and session).
				// Skip setupWorktree — calling it again would fail because the session's
				// CWD is already a worktree, not the main repo, causing a
				// "belongs to a different repository" false positive.
				effectiveCwd = session.cwd;
				worktreeActive = true;
				worktreePath = session.cwd;
				worktreeBranch = session.worktreeBranch || config.worktree?.branchName;
			} else {
				// Normal path: set up worktree from scratch if config.worktree is enabled
				const worktreeWithSsh = worktree ? { ...worktree, sshRemoteId } : undefined;
				const worktreeResult = await worktreeManager.setupWorktree(session.cwd, worktreeWithSsh);
				if (!worktreeResult.success) {
					window.maestro.logger.log('error', 'Worktree setup failed', 'BatchProcessor', {
						sessionId,
						error: worktreeResult.error,
					});
					// Stop the tracker we initialised above so it doesn't leak into the
					// next run's elapsed time.
					timeTracking.stopTracking(sessionId);
					return;
				}
				effectiveCwd = worktreeResult.effectiveCwd;
				worktreeActive = worktreeResult.worktreeActive;
				worktreePath = worktreeResult.worktreePath;
				worktreeBranch = worktreeResult.worktreeBranch;
			}

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

			// Calculate initial total tasks across all documents (checked + unchecked)
			let initialTotalTasks = 0;
			let initialCheckedTasks = 0;
			for (const doc of documents) {
				const { taskCount, checkedCount } = await readDocAndCountTasks(
					folderPath,
					doc.filename,
					sshRemoteId
				);
				initialTotalTasks += taskCount + checkedCount;
				initialCheckedTasks += checkedCount;
			}
			// Track unchecked count for the "no tasks" early exit check
			const initialUncheckedTasks = initialTotalTasks - initialCheckedTasks;

			if (initialUncheckedTasks === 0) {
				window.maestro.logger.log(
					'warn',
					'No unchecked tasks found across all documents',
					'BatchProcessor',
					{ sessionId }
				);
				// Stop the tracker we initialised above so it doesn't leak into the
				// next run's elapsed time.
				timeTracking.stopTracking(sessionId);
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
					completedTasksAcrossAllDocs: initialCheckedTasks,
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
			// Broadcast state change. Mirrors the START_BATCH payload above so mobile
			// /web clients see the same pre-checked count the reducer just stored
			// (avoids a brief "0/N" flicker before the next progress update arrives).
			// `completedTasks` is intentionally 0 — the reducer also hardcodes the
			// legacy field to 0 in START_BATCH.
			broadcastAutoRunState(sessionId, {
				isRunning: true,
				isStopping: false,
				documents: documents.map((d) => d.filename),
				lockedDocuments,
				currentDocumentIndex: 0,
				currentDocTasksTotal: 0,
				currentDocTasksCompleted: 0,
				totalTasksAcrossAllDocs: initialTotalTasks,
				completedTasksAcrossAllDocs: initialCheckedTasks,
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

			// Notify user that Auto Run has started
			notifyToast({
				type: 'info',
				title: 'Auto Run Started',
				message: `${initialTotalTasks} ${initialTotalTasks === 1 ? 'task' : 'tasks'} across ${documents.length} ${documents.length === 1 ? 'document' : 'documents'}`,
				project: session.name,
				sessionId,
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
			useBatchStore.getState().setCustomPrompt(sessionId, prompt);

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
				logger.warn('[BatchProcessor] Failed to start stats tracking:', undefined, statsError);
			}

			// Collect Claude session IDs and track completion
			const agentSessionIds: string[] = [];
			let totalCompletedTasks = 0;
			let loopIteration = 0;

			// Register this Auto Run for emergency stats/history flush on force-kill.
			// Populated even if startAutoRun failed (statsAutoRunId null) so killBatchRun can
			// still write a history entry with the elapsed time the user actually spent.
			autoRunFlushStateRefs.current[sessionId] = {
				statsAutoRunId,
				sessionName: session.name || session.cwd.split('/').pop() || 'Unknown',
				projectPath: session.cwd,
				getCompletedTasks: () => totalCompletedTasks,
				getTotalTasks: () => initialTotalTasks,
				getInputTokens: () => totalInputTokens,
				getOutputTokens: () => totalOutputTokens,
				getTotalCost: () => totalCost,
				getDocumentsProcessed: () => documents.length,
			};

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

			// Track consecutive runs with no task-level progress (nothing checked off, no tasks
			// added or removed). Content-level comparison is unreliable because the agent can
			// mutate the doc (append addenda/explanation text) without doing actual work, which
			// would reset a content-based counter and hide the stall indefinitely.
			// Note: This counter is reset per-document, so stalling one document doesn't affect others
			let consecutiveNoChangeCount = 0;
			const MAX_CONSECUTIVE_NO_CHANGES = 3; // Skip document after 3 consecutive runs with no task-level progress

			// Track stalled documents (document filename -> stall reason)
			const stalledDocuments: Map<string, string> = new Map();

			// Set when an agent writes a `<!-- maestro:halt: reason -->` marker into a
			// document mid-run. A halt aborts the whole playbook immediately: no more
			// tasks in the current document, no remaining documents, no further loop
			// iterations. Mirrors the CLI batch processor so desktop Auto Run honors
			// the same agent-driven early-exit contract. (#231)
			let haltRequest: { document: string; reason: string } | null = null;

			// Track the line of the currently-active HITL gate (null when none).
			// Used to (a) dedupe the sticky toast on Resume-without-tick —
			// pauseBatchOnError fires every iteration that re-detects the same
			// marker, but the user should only see one notification per real
			// gate; and (b) flag that a returning 'resume' action came from a
			// HITL pause so the doc re-read is HITL-scoped and doesn't alter
			// the pre-existing agent_crashed/permission_denied/etc. resume
			// paths.
			let activeHitlGateLine: number | null = null;

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
								loopIteration + 1, // 1-indexed loop number
								sshRemoteId
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
							logger.error(
								`[BatchProcessor] Failed to create working copy for ${docEntry.filename}:`,
								undefined,
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

							// HITL-scoped resume: when the pause we're resuming from was a
							// HITL gate, re-read the document so the next iteration's gate
							// check (and processTask) see whatever the user did during
							// the pause — most importantly, ticking the human-approval
							// checkbox. Without this the in-memory `docContent` still
							// contains the unchecked task and we'd re-pause forever.
							//
							// Other resume types (agent_crashed, permission_denied, …)
							// keep their pre-PR behavior of continuing with in-memory
							// content, and an I/O failure here (file deleted, SSH
							// dropped) is logged but doesn't crash the run.
							if (activeHitlGateLine !== null) {
								try {
									const {
										taskCount: resumedRemaining,
										checkedCount: resumedChecked,
										content: resumedContent,
									} = await readDocAndCountTasks(folderPath, effectiveFilename, sshRemoteId);
									remainingTasks = resumedRemaining;
									docCheckedCount = resumedChecked;
									docContent = resumedContent;
								} catch (rereadErr) {
									logger.warn(
										`[BatchProcessor] HITL resume re-read failed for ${effectiveFilename}; continuing with in-memory content:`,
										undefined,
										rereadErr
									);
								}
								if (remainingTasks === 0) break;
							}
						}

						// HITL gate detection: if the document has a HITL marker positioned
						// before the next unchecked task with no intervening checked task,
						// pause the run via the existing error-resolution infrastructure.
						// Re-uses `pauseBatchOnError` so the AutoRunErrorBanner ("Resume" /
						// "Abort Run") just works without new UI plumbing.
						const hitlGate = findPendingHitlGate(docContent);
						if (hitlGate) {
							const hitlError: AgentError = {
								type: 'hitl_gate',
								message: hitlGate.artifact
									? `${hitlGate.reason} (artifact: ${hitlGate.artifact})`
									: hitlGate.reason,
								recoverable: true,
								agentId: session.toolType,
								sessionId,
								timestamp: Date.now(),
							};
							pauseBatchOnError(sessionId, hitlError, docIndex);

							// Dedupe: only fire the user-facing toast the first time we
							// pause at a given gate. Resume-without-tick re-runs this
							// detection on the next iteration, but the user already has
							// the same banner up — stacking another sticky toast each
							// time would force them to clear N notifications.
							const isNewGate = activeHitlGateLine !== hitlGate.line;
							activeHitlGateLine = hitlGate.line;

							if (isNewGate) {
								window.maestro.logger.autorun(
									`HITL gate reached: ${hitlGate.reason}`,
									session.name,
									{
										document: docEntry.filename,
										reason: hitlGate.reason,
										artifact: hitlGate.artifact,
										markerLine: hitlGate.line,
									}
								);

								// Sticky toast — the user must acknowledge a review gate,
								// so it should not auto-dismiss. Click jumps to the agent
								// so the user can see the AutoRunErrorBanner with the
								// Resume/Abort buttons.
								notifyToast({
									type: 'info',
									title: 'Auto Run paused for review',
									message: hitlGate.artifact
										? `${docEntry.filename}: ${hitlGate.reason} — review ${hitlGate.artifact}`
										: `${docEntry.filename}: ${hitlGate.reason}`,
									project: session.name,
									sessionId,
									dismissible: true,
								});
							}

							// Next loop iteration's await-on-errorResolution block handles
							// the actual wait — keeps the pause control flow in one place.
							continue;
						}

						// No pending gate — clear the active-gate marker so a future
						// gate on a different line is treated as a fresh notification.
						activeHitlGateLine = null;

						// Use extracted document processor hook for task processing
						// This handles: template substitution, document expansion, agent spawning,
						// session registration, re-reading document, and synopsis generation

						// Poll only the currently-processing document. Other documents in the
						// playbook can't change during this task — the agent is working on
						// docEntry — so snapshot their counts once and reuse them across ticks.
						const progressPoll = createProgressPoll({
							documents,
							docEntry,
							folderPath,
							sshRemoteId,
							sessionId,
							intervalMs: AUTO_RUN_PROGRESS_POLL_INTERVAL_MS,
							readDocAndCountTasks,
							updateBatchState: (sid, updater, immediate) =>
								updateBatchStateAndBroadcastRef.current!(sid, updater, immediate),
							getSessions: () => sessionsRef.current,
							onUpdateSession,
						});
						await progressPoll.start();

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
									taskSelectionMode,
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

							progressPoll.stop();

							// Track agent session IDs
							if (taskResult.agentSessionId) {
								agentSessionIds.push(taskResult.agentSessionId);
							}

							anyTasksProcessedThisIteration = true;

							// Extract results from processTask
							const {
								tasksCompletedThisRun,
								addedUncheckedTasks,
								newRemainingTasks,
								documentChanged,
								newCheckedCount,
								shortSummary,
								fullSynopsis,
								usageStats,
								contextUsage,
								elapsedTimeMs,
								agentSessionId,
								success,
								errorKind,
							} = taskResult;

							// Detect stalling via task-count invariance: if no tasks were checked off AND
							// the set of tasks didn't change (none added, none removed), the agent made
							// no real progress this iteration. This ignores prose/addendum churn in the
							// document — an agent writing "why I did nothing" into the file doesn't
							// count as progress.
							const prevCheckedCount = docCheckedCount;
							const prevUncheckedCount = remainingTasks;
							const checkedCountChanged = newCheckedCount !== prevCheckedCount;
							const uncheckedCountChanged = newRemainingTasks !== prevUncheckedCount;
							const taskSetChanged = checkedCountChanged || uncheckedCountChanged;
							const prevNoChangeCount = consecutiveNoChangeCount;
							const beforeLen = docContent?.length ?? 0;
							const afterLen = taskResult.contentAfterTask?.length ?? 0;
							const byteDelta = afterLen - beforeLen;

							// Watchdog failures indicate the agent hung or blew past its time budget,
							// so skip the heuristic and terminate this document immediately.
							const isWatchdogFailure =
								errorKind === 'watchdog-stalled' || errorKind === 'watchdog-timeout';
							if (isWatchdogFailure) {
								consecutiveNoChangeCount = MAX_CONSECUTIVE_NO_CHANGES;
							} else if (tasksCompletedThisRun === 0 && !taskSetChanged) {
								consecutiveNoChangeCount++;
							} else {
								consecutiveNoChangeCount = 0;
							}

							// AUTORUN LOG: stall detection trace — logged every iteration so field
							// reports can reconstruct why the counter did or did not increment.
							// `appendOnlyNoProgress` flags the "agent appended explanation text instead
							// of doing work" pattern: doc bytes grew but the task set is unchanged.
							window.maestro.logger.autorun(
								`Stall trace: ${docEntry.filename} iter=${loopIteration + 1} counter=${prevNoChangeCount}->${consecutiveNoChangeCount}/${MAX_CONSECUTIVE_NO_CHANGES}`,
								session.name,
								{
									document: docEntry.filename,
									loopNumber: loopIteration + 1,
									documentChanged,
									tasksCompletedThisRun,
									prevCheckedCount,
									newCheckedCount,
									prevUncheckedCount,
									newUncheckedCount: newRemainingTasks,
									checkedCountChanged,
									uncheckedCountChanged,
									taskSetChanged,
									contentLenBefore: beforeLen,
									contentLenAfter: afterLen,
									byteDelta,
									counterBefore: prevNoChangeCount,
									counterAfter: consecutiveNoChangeCount,
									maxNoChange: MAX_CONSECUTIVE_NO_CHANGES,
									appendOnlyNoProgress:
										documentChanged &&
										tasksCompletedThisRun === 0 &&
										!taskSetChanged &&
										byteDelta > 0,
									success,
								}
							);

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
									logger.warn(
										'[BatchProcessor] Failed to record task stats:',
										undefined,
										statsError
									);
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

							// Update Symphony contribution with real-time progress
							if (session.symphonyMetadata?.isSymphonySession) {
								window.maestro.symphony
									.updateStatus({
										contributionId: session.symphonyMetadata.contributionId,
										progress: {
											totalDocuments: documents.length,
											completedDocuments: docIndex,
											totalTasks: initialTotalTasks,
											completedTasks: totalCompletedTasks,
											currentDocument: docEntry.filename,
										},
										tokenUsage: {
											inputTokens: totalInputTokens,
											outputTokens: totalOutputTokens,
											estimatedCost: totalCost,
										},
										timeSpent: timeTracking.getElapsedTime(sessionId),
									})
									.catch((err: unknown) => {
										logger.warn(
											'[BatchProcessor] Failed to update Symphony progress:',
											undefined,
											err
										);
									});
							}

							// Track non-reset document completions for loop exit logic
							// (This tracking is intentionally a no-op for now - kept for future loop mode enhancements)
							void (!docEntry.resetOnCompletion ? tasksCompletedThisRun : 0);

							// Update progress state for current document
							if (addedUncheckedTasks > 0) {
								docTasksTotal += addedUncheckedTasks;
							}

							// Recount all documents to get accurate total
							// Tasks in one document can create tasks in other documents,
							// so delta-based tracking on just the current doc is insufficient
							let recountedTotal = 0;
							let recountedChecked = 0;
							for (const doc of documents) {
								const { taskCount, checkedCount } = await readDocAndCountTasks(
									folderPath,
									doc.filename,
									sshRemoteId
								);
								recountedTotal += taskCount + checkedCount;
								recountedChecked += checkedCount;
							}

							updateBatchStateAndBroadcastRef.current!(sessionId, (prev) => {
								const prevState = prev[sessionId] || DEFAULT_BATCH_STATE;
								const nextTotalAcrossAllDocs = Math.max(0, recountedTotal);
								const nextTotalTasks = Math.max(0, recountedTotal);

								return {
									...prev,
									[sessionId]: {
										...prevState,
										currentDocTasksCompleted: docTasksCompleted,
										currentDocTasksTotal: docTasksTotal,
										completedTasksAcrossAllDocs: recountedChecked,
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

							// Add history entry. Await the write so the final cumulative
							// aggregation sees the latest task before writing the summary.
							try {
								await onAddHistoryEntry({
									type: 'AUTO',
									timestamp: Date.now(),
									summary: shortSummary,
									fullResponse: fullSynopsis,
									agentSessionId,
									projectPath: effectiveCwd,
									sessionId: sessionId,
									success,
									usageStats,
									contextUsage,
									elapsedTimeMs,
									completedTaskCount: tasksCompletedThisRun,
								});
							} catch (historyError) {
								logger.warn('[BatchProcessor] Failed to add task history entry:', undefined, {
									sessionId,
									error: historyError,
								});
							}

							// Speak the synopsis via TTS if audio feedback is enabled
							// Use refs to get latest setting values (user may toggle mid-run)
							if (
								audioFeedbackEnabledRef.current &&
								audioFeedbackCommandRef.current &&
								shortSummary
							) {
								window.maestro.notification
									.speak(shortSummary, audioFeedbackCommandRef.current)
									.catch((err) => {
										logger.error('[BatchProcessor] Failed to speak synopsis:', undefined, err);
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

								// Whether another playbook document follows this one. `documents.length > 1`
								// was wrong for the last doc in a multi-doc run — it would tell the
								// user we were skipping to the next document when the batch was
								// actually about to end.
								const hasNextDocument = docIndex < documents.length - 1;

								// Add a history entry specifically for this stalled document
								const stallExplanation = [
									`**Document Stalled: ${docEntry.filename}**`,
									'',
									`The AI agent ran ${consecutiveNoChangeCount} times on this document but made no task-level progress:`,
									`- No tasks were checked off`,
									`- No tasks were added or removed`,
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
									hasNextDocument
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

								// Surface the stall in a toast so the user sees it without having to
								// open the history panel — pre-toast, silent stalls (token exhaustion,
								// watchdog timeouts, agents that loop writing "I did nothing" notes)
								// could go unnoticed for hours. Yellow/warning conveys "we noticed
								// something is wrong and stopped this doc," click jumps to the session.
								notifyToast({
									type: 'warning',
									title: isWatchdogFailure ? 'Auto Run agent stalled' : 'Auto Run document stalled',
									message: hasNextDocument
										? `${docEntry.filename}: ${newRemainingTasks} task${newRemainingTasks === 1 ? '' : 's'} remaining. Skipping to next document.`
										: `${docEntry.filename}: ${newRemainingTasks} task${newRemainingTasks === 1 ? '' : 's'} remaining. No more documents to process.`,
									project: session.name,
									sessionId,
								});

								// Skip to the next document instead of breaking the entire batch
								break; // Break out of the inner while loop for this document
							}

							docCheckedCount = newCheckedCount;
							remainingTasks = newRemainingTasks;
							docContent = taskResult.contentAfterTask;

							// Halt marker: the agent can write `<!-- maestro:halt: reason -->`
							// into the document to stop the whole run now. Checked on the
							// post-task content (after the synopsis/history for this task was
							// already recorded above) so the work that led to the halt is still
							// captured. Breaks the task loop; the document and outer loops below
							// pick up `haltRequest` and finalize. (#231)
							const haltMarker = detectHaltMarker(taskResult.contentAfterTask);
							if (haltMarker.halted) {
								haltRequest = {
									document: docEntry.filename,
									reason: haltMarker.reason || 'Halted by agent',
								};
								window.maestro.logger.autorun('Auto Run halted by agent', session.name, {
									document: docEntry.filename,
									reason: haltRequest.reason,
									loopNumber: loopIteration + 1,
								});
								break;
							}
						} catch (error) {
							progressPoll.stop();
							logger.error(
								`[BatchProcessor] Error running task in ${docEntry.filename} for session ${sessionId}:`,
								undefined,
								error
							);

							// Check if an error resolution promise was created (e.g., by onAgentError → pauseBatchOnError)
							// This handles the case where the agent error (e.g., context limit) triggered a pause,
							// but processTask threw before the next loop iteration could check for it.
							const postTaskErrorResolution = errorResolutionRefs.current[sessionId];
							if (postTaskErrorResolution) {
								const action = await postTaskErrorResolution.promise;
								delete errorResolutionRefs.current[sessionId];

								if (action === 'abort') {
									stopRequestedRefs.current[sessionId] = true;
									break;
								}

								if (action === 'skip-document') {
									skipCurrentDocumentAfterError = true;
									break;
								}

								// 'resume' — re-read document to get accurate task count before continuing
								const {
									taskCount,
									checkedCount,
									content: freshContent,
								} = await readDocAndCountTasks(folderPath, effectiveFilename, sshRemoteId);
								remainingTasks = taskCount;
								docCheckedCount = checkedCount;
								docContent = freshContent;
								continue;
							}

							// No error resolution pending — continue to next task on error
							remainingTasks--;
						}
					}

					// Check for stop request before moving to next document
					if (stopRequestedRefs.current[sessionId]) {
						break;
					}

					// An agent halted the run from inside this document - skip any remaining
					// documents and let the outer loop finalize. (#231)
					if (haltRequest) {
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

				// An agent halted the run from inside a document - stop looping entirely,
				// record the terminal reason in run history, and surface a toast so the
				// user sees why Auto Run ended without opening the History panel. (#231)
				if (haltRequest) {
					addFinalLoopSummary(`Halted by agent: ${haltRequest.reason}`);
					notifyToast({
						color: 'theme',
						title: 'Auto Run halted by agent',
						message: haltRequest.reason,
						project: session.name,
						sessionId,
					});
					break;
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

				// Capture completed-loop metrics before resetting counters
				const completedLoopNumber = loopIteration + 1;
				const completedLoopTasks = loopTasksCompleted;

				// Add loop summary history entry via the shared helper, augmented
				// with the next-loop recount so the format stays in sync with the
				// final-loop entry produced by addFinalLoopSummary above.
				onAddHistoryEntry(
					createLoopSummaryEntry({
						loopIteration,
						loopTasksCompleted: completedLoopTasks,
						loopStartTime,
						loopTotalInputTokens,
						loopTotalOutputTokens,
						loopTotalCost,
						sessionCwd: session.cwd,
						sessionId,
						isFinal: false,
						tasksDiscoveredForNextLoop: newTotalTasks,
					})
				);

				// Reset per-loop tracking for next iteration
				loopStartTime = Date.now();
				loopTasksCompleted = 0;
				loopTotalInputTokens = 0;
				loopTotalOutputTokens = 0;
				loopTotalCost = 0;

				// AUTORUN LOG: Loop completion
				window.maestro.logger.autorun(`Loop ${completedLoopNumber} completed`, session.name, {
					loopNumber: completedLoopNumber,
					tasksCompleted: completedLoopTasks,
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
				// For worktree-dispatched runs, the main repo is the parent session's cwd
				const mainRepoCwd = config.worktreeTarget
					? sessionsRef.current.find((s) => s.id === session.parentSessionId)?.cwd || session.cwd
					: session.cwd;

				const prResult = await worktreeManager.createPR({
					worktreePath,
					mainRepoCwd,
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

				// Record PR result in history so it's visible in the worktree agent's history panel
				onAddHistoryEntry({
					type: 'AUTO',
					timestamp: Date.now(),
					summary: prResult.success
						? `PR created: ${prResult.prUrl}`
						: `PR creation failed: ${prResult.error || 'Unknown error'}`,
					fullResponse: prResult.success
						? `**Pull Request Created**\n\n- **URL:** ${prResult.prUrl}\n- **Branch:** \`${worktreeBranch}\`\n- **Target:** \`${prResult.targetBranch || 'unknown'}\`\n- **Tasks Completed:** ${totalCompletedTasks}`
						: `**Pull Request Creation Failed**\n\n- **Error:** ${prResult.error || 'Unknown error'}\n- **Branch:** \`${worktreeBranch}\`\n- **Target:** \`${prResult.targetBranch || 'unknown'}\``,
					projectPath: worktreePath,
					sessionId,
					success: prResult.success,
				});
			}

			// Add final Auto Run summary entry
			// Calculate visibility-aware elapsed time using the extracted time tracking hook
			// (excludes time when laptop was sleeping/suspended)
			const totalElapsedMs = timeTracking.getElapsedTime(sessionId);
			let finalTotals = {
				totalCompletedTasks,
				totalElapsedMs,
				totalInputTokens,
				totalOutputTokens,
				totalCost,
			};

			try {
				const historyEntries = await window.maestro.history.getAll(undefined, sessionId);
				finalTotals = mergeFinalSummaryTotals(
					finalTotals,
					aggregateAutoRunHistoryTotals(historyEntries)
				);
			} catch (historyError) {
				logger.warn('[BatchProcessor] Failed to aggregate Auto Run history totals:', undefined, {
					sessionId,
					error: historyError,
				});
			}

			const {
				summary: finalSummary,
				details: finalDetails,
				isSuccess,
			} = buildFinalSummary({
				wasStopped,
				totalCompletedTasks: finalTotals.totalCompletedTasks,
				totalElapsedMs: finalTotals.totalElapsedMs,
				stalledDocuments,
				documents,
				loopEnabled,
				loopIteration,
				totalInputTokens: finalTotals.totalInputTokens,
				totalOutputTokens: finalTotals.totalOutputTokens,
				totalCost: finalTotals.totalCost,
				autoRunStats,
			});

			// Claim the flush state: if killBatchRun already flushed, skip the history + stats
			// writes here to avoid clobbering recorded duration with a stale/zero value.
			const alreadyFlushed = claimFlushState(autoRunFlushStateRefs, sessionId) === null;

			if (!alreadyFlushed) {
				try {
					await onAddHistoryEntry({
						type: 'AUTO',
						timestamp: Date.now(),
						summary: finalSummary,
						fullResponse: finalDetails,
						projectPath: session.cwd,
						sessionId, // Include sessionId so the summary appears in session's history
						success: isSuccess,
						elapsedTimeMs: finalTotals.totalElapsedMs,
						usageStats:
							finalTotals.totalInputTokens > 0 || finalTotals.totalOutputTokens > 0
								? {
										inputTokens: finalTotals.totalInputTokens,
										outputTokens: finalTotals.totalOutputTokens,
										cacheReadInputTokens: 0,
										cacheCreationInputTokens: 0,
										totalCostUsd: finalTotals.totalCost,
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
							finalTotals.totalElapsedMs,
							finalTotals.totalCompletedTasks
						);
					} catch (statsError) {
						// Don't fail cleanup if stats tracking fails
						logger.warn('[BatchProcessor] Failed to end stats tracking:', undefined, statsError);
					}
				}
			}

			// Critical: Always flush debounced updates and dispatch COMPLETE_BATCH to clean up state.
			// These operations are safe regardless of mount state - React handles reducer dispatches gracefully,
			// and broadcasts are external calls that don't affect React state.
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

			// Call completion callback if provided (only if still mounted to avoid warnings).
			// Skip when alreadyFlushed: killBatchRun owns the onComplete call in that case
			// (it captured the elapsed time before stopTracking zeroed it). Invoking here
			// would double-fire the toast and submit elapsedTimeMs:0 to the leaderboard.
			if (!alreadyFlushed && isMountedRef.current && onComplete) {
				onComplete({
					sessionId,
					sessionName: session.name || session.cwd.split('/').pop() || 'Unknown',
					completedTasks: finalTotals.totalCompletedTasks,
					totalTasks: Math.max(initialTotalTasks, finalTotals.totalCompletedTasks),
					wasStopped,
					elapsedTimeMs: finalTotals.totalElapsedMs,
					inputTokens: finalTotals.totalInputTokens,
					outputTokens: finalTotals.totalOutputTokens,
					totalCostUsd: finalTotals.totalCost,
					documentsProcessed: documents.length,
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
		// Note: audioFeedbackEnabled/audioFeedbackCommand are read from refs to allow
		// mid-run setting changes to take effect immediately
		[
			audioFeedbackCommandRef,
			audioFeedbackEnabledRef,
			autoRunFlushStateRefs,
			autoRunStats,
			broadcastAutoRunState,
			dispatch,
			documentProcessor,
			errorResolutionRefs,
			flushDebouncedUpdate,
			groups,
			isMountedRef,
			onAddHistoryEntry,
			onComplete,
			onPRResult,
			onProcessQueueAfterCompletion,
			onSpawnAgent,
			onUpdateSession,
			pauseBatchOnError,
			readDocAndCountTasks,
			sessionsRef,
			stopRequestedRefs,
			timeTracking,
			updateBatchStateAndBroadcastRef,
			worktreeManager,
		]
	);

	return { startBatchRun };
}
