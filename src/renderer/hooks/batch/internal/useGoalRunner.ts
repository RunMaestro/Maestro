import { useCallback } from 'react';
import type { MutableRefObject } from 'react';
import type {
	BatchRunState,
	BatchRunConfig,
	Session,
	HistoryEntry,
	UsageStats,
	Group,
} from '../../../types';
import type { AgentSpawnErrorKind } from '../../agent/useAgentExecution';
import type {
	GoalIterationRecord,
	GoalExitReason,
	GoalRunConfig,
} from '../../../../shared/goalDriven/types';
import { GOAL_RUN_HARD_ITERATION_CAP } from '../../../../shared/goalDriven/types';
import { isLimitError } from '../../../../shared/types';
import { parseGoalMarkers, stripMaestroMarkers } from '../../../../shared/goalDriven/goalMarkers';
import { evaluateGoalExit } from '../../../../shared/goalDriven/goalExitEvaluator';
import { formatGoalRunDocumentPath } from '../../../../shared/goalDriven/goalRunLabel';
import {
	GOAL_SYNOPSIS_REQUEST_PROMPT,
	formatPredecessorHandoff,
	sanitizeHandoffBlurb,
} from '../../../../shared/goalDriven/goalHandoff';
import { hasCapabilityCached } from '../../agent/useAgentCapabilities';
import { formatElapsedTime, truncateCommand } from '../../../../shared/formatters';
import {
	substituteTemplateVariables,
	type TemplateContext,
} from '../../../utils/templateVariables';
import { prependNewSessionMessage } from '../../../../shared/newSessionMessage';
import { gitService } from '../../../services/git';
import { logger } from '../../../utils/logger';
import { notifyToast } from '../../../stores/notificationStore';
import { useSessionStore, selectSessionById } from '../../../stores/sessionStore';
import { useSettingsStore } from '../../../stores/settingsStore';
import type { BatchAction } from '../batchReducer';
import type { ErrorResolutionAction, ErrorResolutionEntry } from './useBatchControlActions';
import { claimFlushState, type AutoRunFlushStateRefs } from './batchFlushState';
import type { BatchCompleteInfo } from '../useBatchProcessor';
import type { UseTimeTrackingReturn } from '../useTimeTracking';

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

/**
 * Resume an existing provider session and run a prompt against it (used to ask a
 * finished iteration for a handoff note). Matches `spawnBackgroundSynopsis` from
 * `useAgentExecution` - the same primitive the document runner uses for its
 * exit-synopsis - so SSH and per-session config are honored on the resume.
 */
type SpawnBackgroundSynopsisFn = (
	sessionId: string,
	cwd: string,
	resumeAgentSessionId: string,
	prompt: string,
	toolType?: Session['toolType'],
	sessionConfig?: {
		customPath?: string;
		customArgs?: string;
		customEnvVars?: Record<string, string>;
		customModel?: string;
		customContextWindow?: number;
		enableMaestroP?: boolean;
		maestroPMode?: 'interactive' | 'dynamic';
		maestroPPath?: string;
		sessionSshRemoteConfig?: {
			enabled: boolean;
			remoteId: string | null;
			workingDirOverride?: string;
		};
	}
) => Promise<{
	success: boolean;
	response?: string;
	agentSessionId?: string;
	usageStats?: UsageStats;
	contextUsage?: number;
}>;

export interface UseGoalRunnerDeps {
	// Refs (shared with useBatchRunner so lifecycle behavior stays consistent)
	getSessions: () => Session[];
	audioFeedbackEnabledRef: MutableRefObject<boolean | undefined>;
	audioFeedbackCommandRef: MutableRefObject<string | undefined>;
	autoRunFlushStateRefs: AutoRunFlushStateRefs;
	stopRequestedRefs: MutableRefObject<Record<string, boolean>>;
	isMountedRef: MutableRefObject<boolean>;
	// Shared error-resolution registry (same instance the spec-driven runner and
	// the UI controls use). A limit pause awaits the promise here; `resumeAfterError`
	// (or the Phase 3 coordinator) resolves it to unblock the loop.
	errorResolutionRefs: MutableRefObject<Record<string, ErrorResolutionEntry>>;
	updateBatchStateAndBroadcastRef: MutableRefObject<UpdateBatchStateFn | null>;
	// Hook outputs
	broadcastAutoRunState: (sessionId: string, state: BatchRunState | null) => void;
	flushDebouncedUpdate: (sessionId: string) => void;
	dispatch: (action: BatchAction) => void;
	timeTracking: UseTimeTrackingReturn;
	// Coordinator props
	groups: Group[];
	onSpawnAgent: SpawnAgentFn;
	/**
	 * Resume a finished iteration's session to capture a handoff note for the next
	 * (fresh-context) iteration. Same primitive the document runner uses for its
	 * exit synopsis; SSH + agent-config overrides are honored on the resume.
	 */
	spawnBackgroundSynopsis: SpawnBackgroundSynopsisFn;
	onAddHistoryEntry: (entry: Omit<HistoryEntry, 'id'>) => void | Promise<void>;
	onComplete?: (info: BatchCompleteInfo) => void;
	onProcessQueueAfterCompletion?: (sessionId: string) => void;
}

export interface UseGoalRunnerReturn {
	startGoalRun: (sessionId: string, config: BatchRunConfig, folderPath: string) => Promise<void>;
}

/**
 * Extract a concise, human-readable synopsis from an agent's iteration output.
 *
 * Mirrors the first-paragraph heuristic in `useDocumentProcessor.processTask`:
 * the goal prompt instructs the agent to start with a synopsis, so we take the
 * first paragraph's first sentence (stripping the progress marker and markdown
 * noise) rather than making a separate summarization call.
 */
function extractGoalSynopsis(response: string | undefined, iteration: number): string {
	const fallback = `Iteration ${iteration} completed`;
	if (!response) return fallback;

	// Drop the maestro markers so they never leak into the synopsis line.
	const withoutMarkers = response.replace(/<!--\s*maestro:[\s\S]*?-->/g, '').trim();
	if (!withoutMarkers) return fallback;

	const firstParagraph = withoutMarkers.split(/\n\n+/)[0]?.trim() ?? '';
	const cleaned = firstParagraph
		.replace(/^\*\*Summary:\*\*\s*/i, '')
		.replace(/^#+\s*/, '')
		.replace(/\*\*/g, '')
		.trim();

	if (cleaned.length <= 10) return fallback;

	const firstSentence = cleaned.match(/^.+?[.!?](?=\s+[A-Z]|\s*\n|\s*$)/);
	if (firstSentence) return firstSentence[0].trim();
	return cleaned.length > 150 ? `${cleaned.slice(0, 150)}...` : cleaned;
}

/**
 * Human-readable label for the History final-summary entry.
 */
function exitReasonLabel(reason: GoalExitReason): string {
	switch (reason) {
		case 'completed':
			return 'Goal completed';
		case 'deadlock':
			return 'Goal run hit a deadlock';
		case 'max-iterations':
			return 'Goal run reached its iteration limit';
		case 'stalled':
			return 'Goal run stalled';
		case 'stopped-by-user':
			return 'Goal run stopped by user';
	}
}

/**
 * The Goal-Driven Auto Run orchestrator. Mirrors the lifecycle scaffolding of
 * `useBatchRunner` (time tracking, power-save inhibit, stats hooks, history
 * entries, web broadcast, the flush-state kill guard) but drives a goal loop
 * instead of a document/task loop.
 *
 * Each iteration spawns the agent via the injected `onSpawnAgent` (which already
 * honors SSH and agent-config overrides — do NOT bypass it), parses the agent's
 * self-reported `<!-- maestro:... -->` markers, feeds the running history into the
 * pure `evaluateGoalExit` decision function, and stops on
 * completion / deadlock / max-iterations / stall / user-stop.
 */
export function useGoalRunner({
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
}: UseGoalRunnerDeps): UseGoalRunnerReturn {
	const startGoalRun = useCallback(
		async (sessionId: string, config: BatchRunConfig, folderPath: string) => {
			// Global Auto Run kill switch — same gate as the document runner.
			if (useSettingsStore.getState().autoRunDisabled) {
				window.maestro.logger.log(
					'warn',
					'Auto Run is disabled via autoRunDisabled setting',
					'GoalRunner',
					{ sessionId }
				);
				notifyToast({
					type: 'warning',
					title: 'Auto Run Disabled',
					message: 'Auto Run is disabled. Enable it in Settings to use this feature.',
				});
				return;
			}

			const goalConfig: GoalRunConfig | undefined = config.goalConfig;
			if (!goalConfig) {
				// The router only delegates here when goalConfig is present; guard anyway.
				window.maestro.logger.log('error', 'startGoalRun called without goalConfig', 'GoalRunner', {
					sessionId,
				});
				return;
			}

			// Prefer getSessions(), then the store for just-created sessions.
			const session =
				getSessions().find((s) => s.id === sessionId) ||
				selectSessionById(sessionId)(useSessionStore.getState());
			if (!session) {
				window.maestro.logger.log('error', 'Session not found for goal run', 'GoalRunner', {
					sessionId,
					availableSessionIds: getSessions().map((s) => s.id),
				});
				return;
			}

			const sessionName = session.name || session.cwd.split('/').pop() || 'Unknown';
			const goalStartTime = Date.now();

			// Load the goal-driven system prompt template up front. Failing here means
			// we cannot build a meaningful per-iteration prompt, so bail before any
			// lifecycle state is created.
			let goalPromptTemplate: string;
			try {
				const promptResult = await window.maestro.prompts.get('autorun-goal');
				if (!promptResult.success) {
					throw new Error(promptResult.error || 'unknown error');
				}
				goalPromptTemplate = promptResult.content ?? '';
			} catch (err) {
				window.maestro.logger.log('error', 'Failed to load autorun-goal prompt', 'GoalRunner', {
					sessionId,
					error: String(err),
				});
				notifyToast({
					type: 'error',
					title: 'Goal Run Failed',
					message: 'Could not load the Goal-Driven Auto Run prompt.',
					project: sessionName,
					sessionId,
				});
				return;
			}

			// Initialize visibility-based time tracking and reset the stop flag.
			timeTracking.startTracking(sessionId);
			stopRequestedRefs.current[sessionId] = false;

			// Goal mode has no worktree — the agent runs in its own cwd. SSH remains
			// honored inside onSpawnAgent regardless of the cwd override.
			const effectiveCwd = session.cwd;

			// Git branch for the {{GIT_BRANCH}} template variable (best-effort).
			let gitBranch: string | undefined;
			if (session.isGitRepo) {
				try {
					const status = await gitService.getStatus(effectiveCwd);
					gitBranch = status.branch;
				} catch {
					// Ignore git errors — branch stays empty.
				}
			}

			const sessionGroup = session.groupId ? groups.find((g) => g.id === session.groupId) : null;
			const groupName = sessionGroup?.name;

			// Goal mode expresses progress as a percent, so we model it as 100 "tasks".
			// Empty documents/lockedDocuments arrays mark this as a document-less run.
			dispatch({
				type: 'START_BATCH',
				sessionId,
				payload: {
					documents: [],
					lockedDocuments: [],
					totalTasksAcrossAllDocs: 100,
					completedTasksAcrossAllDocs: 0,
					loopEnabled: false,
					maxLoops: goalConfig.maxIterations,
					folderPath,
					worktreeActive: false,
					worktreePath: undefined,
					worktreeBranch: undefined,
					customPrompt: undefined,
					startTime: goalStartTime,
					cumulativeTaskTimeMs: 0,
					accumulatedElapsedMs: 0,
					lastActiveTimestamp: goalStartTime,
				},
			});

			// Flag goal mode + seed progress. immediate=true so the desktop store and
			// web clients reflect the running goal state without waiting on the debounce.
			updateBatchStateAndBroadcastRef.current!(
				sessionId,
				(prev) => ({
					...prev,
					[sessionId]: {
						...prev[sessionId],
						goalMode: true,
						goalProgress: 0,
						goalIteration: 0,
						goalRationale: undefined,
						goalExitReason: undefined,
					},
				}),
				true
			);

			window.maestro.logger.autorun('Goal-Driven Auto Run started', session.name, {
				goal: goalConfig.goal,
				maxIterations: goalConfig.maxIterations ?? 'unlimited',
			});

			// Keep the toast compact: goals / exit criteria can be many paragraphs,
			// and the toast message has no line clamp, so the raw text would run
			// off-screen. Show a short preview of each (newlines collapsed, capped) -
			// the full prompts live in the start History entry written below.
			const goalPreview = truncateCommand(goalConfig.goal, 140);
			const exitPreview = goalConfig.exitCriteria.trim()
				? truncateCommand(goalConfig.exitCriteria, 140)
				: '';
			notifyToast({
				type: 'info',
				title: 'Goal-Driven Auto Run Started',
				message: exitPreview ? `Goal: ${goalPreview} · Exit: ${exitPreview}` : goalPreview,
				project: session.name,
				sessionId,
			});

			// Immediate "run started" marker in History: stamps the start time and
			// records the two driving prompts (goal + exit criteria) up front, so the
			// run's inputs are captured even if it's killed before the first iteration
			// finishes. No success flag - this is a start marker, not a pass/fail.
			const trimmedExitCriteria = goalConfig.exitCriteria.trim();
			void onAddHistoryEntry({
				type: 'AUTO',
				timestamp: goalStartTime,
				summary: 'Goal-Driven Auto Run started',
				fullResponse: [
					`**Goal-Driven Auto Run Started**`,
					``,
					`- **Goal:** ${goalConfig.goal}`,
					`- **Exit Criteria:** ${trimmedExitCriteria || '_(none specified)_'}`,
					`- **Iteration Limit:** ${goalConfig.maxIterations ?? 'Infinite'}`,
					`- **Started:** ${new Date(goalStartTime).toLocaleString()}`,
				].join('\n'),
				projectPath: effectiveCwd,
				sessionId,
			});

			// State machine: INITIALIZING -> RUNNING.
			dispatch({ type: 'SET_RUNNING', sessionId });

			// Prevent system sleep while the goal run is active.
			window.maestro.power.addReason(`autorun:${sessionId}`);

			// Cumulative tracking (mutated by the loop; read by the flush state getters).
			const agentSessionIds: string[] = [];
			let totalInputTokens = 0;
			let totalOutputTokens = 0;
			let totalCost = 0;
			let finalProgress = 0;
			let iteration = 0;
			// Handoff note carried from the previous iteration's session into the next
			// (fresh-context) iteration's prompt. Empty for the first iteration.
			let predecessorBlurb = '';

			// Start stats tracking. Record the goal as the document path behind a
			// `Goal: ` prefix (trimmed to a readable length) so the run is
			// recognizable — and distinguishable from document runs — in the Usage
			// Dashboard; progress maps onto the 0–100 task scale.
			let statsAutoRunId: string | null = null;
			try {
				statsAutoRunId = await window.maestro.stats.startAutoRun({
					sessionId,
					agentType: session.toolType,
					documentPath: formatGoalRunDocumentPath(goalConfig.goal),
					startTime: goalStartTime,
					tasksTotal: 100,
					projectPath: session.cwd,
				});
			} catch (statsError) {
				logger.warn('[GoalRunner] Failed to start stats tracking:', undefined, statsError);
			}

			// Register for emergency stats/history flush on force-kill. Getters read the
			// live cumulative counters above so killBatchRun records accurate numbers.
			autoRunFlushStateRefs.current[sessionId] = {
				statsAutoRunId,
				sessionName,
				projectPath: session.cwd,
				getCompletedTasks: () => finalProgress,
				getTotalTasks: () => 100,
				getInputTokens: () => totalInputTokens,
				getOutputTokens: () => totalOutputTokens,
				getTotalCost: () => totalCost,
				getDocumentsProcessed: () => 0,
			};

			const history: GoalIterationRecord[] = [];
			let exitReason: GoalExitReason = 'stopped-by-user';
			let exitDetail = 'Stopped by user.';

			// Main goal loop. A finite maxIterations is enforced by the evaluator; an
			// infinite (null) run relies on completion/deadlock/stall to stop, with the
			// hard cap below as a last-resort safety net (see GOAL_RUN_HARD_ITERATION_CAP).
			while (true) {
				// Check for a stop request before each spawn (same contract as the doc loop).
				if (stopRequestedRefs.current[sessionId]) {
					exitReason = 'stopped-by-user';
					exitDetail = 'Stopped by user.';
					break;
				}

				// Absolute safety bound for infinite runs: a buggy/adversarial agent can
				// defeat stall detection indefinitely without ever completing or
				// deadlocking, which would otherwise spin forever. `iteration` here is the
				// count already completed, so this stops after exactly the cap.
				if (goalConfig.maxIterations === null && iteration >= GOAL_RUN_HARD_ITERATION_CAP) {
					exitReason = 'max-iterations';
					exitDetail = `Safety limit reached: stopped after ${GOAL_RUN_HARD_ITERATION_CAP} iterations without completion, deadlock, or stall.`;
					break;
				}

				iteration++;

				// Build the per-iteration prompt by substituting the goal template.
				const templateContext: TemplateContext = {
					session,
					gitBranch,
					groupName,
					groupId: session.groupId,
					activeTabId: session.activeTabId,
					autoRunFolder: folderPath,
					loopNumber: iteration,
					goal: goalConfig.goal,
					goalExitCriteria: goalConfig.exitCriteria,
					predecessorHandoff: formatPredecessorHandoff(predecessorBlurb),
				};
				// Each goal iteration spawns a fresh provider session, so prefix the
				// agent's New Session Message onto every spawn (matches interactive behavior).
				const prompt = prependNewSessionMessage(
					substituteTemplateVariables(goalPromptTemplate, templateContext),
					session.newSessionMessage
				);

				const iterationStart = Date.now();
				let result: Awaited<ReturnType<SpawnAgentFn>>;
				try {
					result = await onSpawnAgent(
						sessionId,
						prompt,
						effectiveCwd !== session.cwd ? effectiveCwd : undefined
					);
				} catch (error) {
					logger.error('[GoalRunner] Agent spawn threw:', undefined, error);
					result = { success: false, error: String(error) };
				}
				const elapsedTimeMs = Date.now() - iterationStart;

				// Limit pause: if this iteration's spawn hit a token/API/credit or rate
				// limit, do NOT consume the iteration. The agent-error listener has
				// already stamped the session into the paused state (agentError +
				// agentErrorPaused); here we mirror the spec-driven runner by awaiting an
				// unblock signal on the shared errorResolution promise. On resume we retry
				// the SAME iteration with the same prompt. Restart durability is out of
				// scope (Phase 4): the loop is still alive in memory, it just parks here.
				if (!result.success) {
					// The limit error arrives via a separate IPC event (agent-error) that
					// the listener commits to the store. That event and this spawn's invoke
					// reply race; if the reply settled first, the store isn't stamped yet.
					// Re-read across a few short ticks before concluding this wasn't a limit
					// pause, so detection is order-independent. Guard on the timestamp so a
					// stale agentError from an earlier iteration can't be mistaken for this
					// spawn's failure. Bounded so a genuine non-limit failure still falls
					// through quickly to regular failure handling.
					const readLimitError = () => {
						const paused = selectSessionById(sessionId)(useSessionStore.getState());
						const err = paused?.agentError;
						return err && isLimitError(err) && err.timestamp >= iterationStart ? err : undefined;
					};
					let pausedError = readLimitError();
					for (let attempt = 0; !pausedError && attempt < 5; attempt++) {
						await new Promise((resolve) => setTimeout(resolve, 10));
						pausedError = readLimitError();
					}
					if (pausedError) {
						// Ensure an unblock promise exists. The agent-error listener usually
						// creates it via pauseBatchOnError (the goal batch is "running"), but
						// create it here too in case we observed the failure first.
						if (!errorResolutionRefs.current[sessionId]) {
							let resolveFn: (action: ErrorResolutionAction) => void = () => {};
							const promise = new Promise<ErrorResolutionAction>((resolve) => {
								resolveFn = resolve;
							});
							errorResolutionRefs.current[sessionId] = { promise, resolve: resolveFn };
						}

						window.maestro.logger.autorun(
							`Goal run paused on ${pausedError.type}; awaiting resume`,
							session.name,
							{ iteration, errorType: pausedError.type }
						);

						const action = await errorResolutionRefs.current[sessionId].promise;
						delete errorResolutionRefs.current[sessionId];

						if (action === 'abort' || action === 'skip-document') {
							exitReason = 'stopped-by-user';
							exitDetail = 'Stopped by user.';
							break;
						}

						// Resume: retry the SAME iteration. Revert the counter so the limited
						// attempt is not counted, then loop back to re-spawn the same prompt.
						iteration--;
						continue;
					}
				}

				if (result.agentSessionId) {
					agentSessionIds.push(result.agentSessionId);
					// Register origin so the spawned session can be located later.
					window.maestro.agentSessions
						.registerSessionOrigin(effectiveCwd, result.agentSessionId, 'auto')
						.catch((err) =>
							logger.error('[GoalRunner] Failed to register session origin:', undefined, err)
						);
				}
				if (result.usageStats) {
					totalInputTokens += result.usageStats.inputTokens || 0;
					totalOutputTokens += result.usageStats.outputTokens || 0;
					totalCost += result.usageStats.totalCostUsd || 0;
				}

				// Parse the agent's self-reported markers. A missing progress report
				// carries the previous iteration's RAW value forward (0 on the first).
				const markers = parseGoalMarkers(result.response ?? '');
				const reportedProgress =
					markers.progress ?? (history.length > 0 ? history[history.length - 1].progress : 0);

				// Monotonic high-water mark for everything the USER sees. The agent's
				// self-assessment is noisy and routinely regresses between iterations
				// (e.g. 55% then 35%); a progress bar that slides backward is confusing
				// and wrong, so the displayed percent only ever climbs. Exit/stall
				// detection below deliberately uses the RAW value instead, so a single
				// overconfident spike can't freeze the bar or trigger a false stall while
				// the agent is genuinely still moving underneath its earlier peak.
				const displayProgress = Math.max(finalProgress, reportedProgress);
				finalProgress = displayProgress;

				history.push({
					iteration,
					// Raw self-report - feeds the exit evaluator's stall/completion logic,
					// which relies on real upward movement to reset a stall window.
					progress: reportedProgress,
					rationale: markers.rationale,
					complete: markers.complete,
					deadlock: markers.deadlock,
					deadlockReason: markers.deadlockReason,
				});

				// Update batch state via the broadcast updater so desktop + web stay in sync.
				// The legacy completedTasks fields mirror progress so existing progress UI
				// (which reads completed/total) renders the percent without goal-specific code.
				updateBatchStateAndBroadcastRef.current!(
					sessionId,
					(prev) => ({
						...prev,
						[sessionId]: {
							...prev[sessionId],
							goalProgress: displayProgress,
							goalRationale: markers.rationale ?? undefined,
							goalIteration: iteration,
							completedTasksAcrossAllDocs: displayProgress,
							completedTasks: displayProgress,
							loopIteration: iteration,
						},
					}),
					true
				);

				// Per-iteration history entry. The headline leads with the goal percent
				// and the agent's rationale (falling back to its synopsis when no
				// rationale was reported); the body keeps the agent's full output, which
				// begins with its synopsis. Strip the internal `<!-- maestro:... -->`
				// control markers before storing so they never enter history and can't
				// leak into any render surface (desktop list/modal, mobile, drawer).
				const synopsis = result.success
					? extractGoalSynopsis(result.response, iteration)
					: `Iteration ${iteration} failed`;
				const rawFullResponse = result.success
					? result.response || synopsis
					: result.error || result.response || synopsis;
				const fullResponse = stripMaestroMarkers(rawFullResponse);
				const rationaleText = markers.rationale?.trim();
				const iterationSummary = `Goal progress: ${displayProgress}% — ${rationaleText || synopsis}`;
				onAddHistoryEntry({
					type: 'AUTO',
					timestamp: Date.now(),
					summary: iterationSummary,
					fullResponse,
					agentSessionId: result.agentSessionId,
					projectPath: effectiveCwd,
					sessionId,
					success: result.success,
					usageStats: result.usageStats,
					contextUsage: result.contextUsage,
					elapsedTimeMs,
				});

				// Speak the synopsis via TTS if audio feedback is enabled (refs = latest setting).
				if (audioFeedbackEnabledRef.current && audioFeedbackCommandRef.current && synopsis) {
					window.maestro.notification
						.speak(synopsis, audioFeedbackCommandRef.current)
						.catch((err) => logger.error('[GoalRunner] Failed to speak synopsis:', undefined, err));
				}

				window.maestro.logger.autorun(`Goal iteration ${iteration} complete`, session.name, {
					iteration,
					progress: displayProgress,
					reportedProgress,
					complete: markers.complete,
					deadlock: markers.deadlock,
				});

				// Checkpoint each iteration in git so every increment of work is a
				// recoverable commit. Best-effort: a clean tree is a quiet no-op, and a
				// failed commit (missing git identity, failing hooks) is logged but never
				// aborts the run. SSH sessions commit on the remote host.
				if (session.isGitRepo) {
					const sshRemoteId =
						session.sshRemoteId || session.sessionSshRemoteConfig?.remoteId || undefined;
					const commitRationale = markers.rationale?.trim();
					const commitMessage = `Maestro Auto Run (goal) iteration ${iteration} - ${
						commitRationale || `progress ${displayProgress}%`
					}`;
					try {
						const commit = await gitService.commitAll(effectiveCwd, commitMessage, sshRemoteId);
						if (commit.committed) {
							window.maestro.logger.autorun(
								`Goal iteration ${iteration} committed ${commit.commitHash ?? ''}`.trim(),
								session.name,
								{ iteration, commitHash: commit.commitHash }
							);
						} else if (!commit.success) {
							logger.warn(
								`[GoalRunner] Auto-commit failed on iteration ${iteration}:`,
								undefined,
								commit.error
							);
						}
					} catch (err) {
						logger.warn(
							`[GoalRunner] Auto-commit threw on iteration ${iteration}:`,
							undefined,
							err
						);
					}
				}

				// Feed the running history into the pure exit evaluator.
				const decision = evaluateGoalExit(history, goalConfig);
				if (decision.action === 'stop') {
					exitReason = decision.reason;
					exitDetail = decision.detail;
					break;
				}

				// Continuing: resume this iteration's session to capture a handoff note
				// for the next (fresh-context) iteration. Gated on the agent supporting
				// resume - without it the resumed "session" has no context and the note
				// would be worthless, so we'd rather carry nothing forward. Mirrors the
				// CLI runner (src/cli/services/goal-runner.ts) exactly.
				if (
					result.success &&
					result.agentSessionId &&
					hasCapabilityCached(session.toolType, 'supportsResume')
				) {
					try {
						const handoff = await spawnBackgroundSynopsis(
							sessionId,
							effectiveCwd,
							result.agentSessionId,
							GOAL_SYNOPSIS_REQUEST_PROMPT,
							session.toolType,
							{
								customPath: session.customPath,
								customArgs: session.customArgs,
								customEnvVars: session.customEnvVars,
								customModel: session.customModel,
								customContextWindow: session.customContextWindow,
								enableMaestroP: session.enableMaestroP,
								maestroPMode: session.maestroPMode,
								maestroPPath: session.maestroPPath,
								sessionSshRemoteConfig: session.sessionSshRemoteConfig,
							}
						);
						if (handoff.usageStats) {
							totalInputTokens += handoff.usageStats.inputTokens || 0;
							totalOutputTokens += handoff.usageStats.outputTokens || 0;
							totalCost += handoff.usageStats.totalCostUsd || 0;
						}
						// Only overwrite when we got something usable; otherwise keep the
						// previous note rather than blanking the next iteration's handoff.
						const blurb = handoff.success ? sanitizeHandoffBlurb(handoff.response) : '';
						if (blurb) {
							predecessorBlurb = blurb;
						}
					} catch (err) {
						logger.warn('[GoalRunner] Handoff synopsis request failed', undefined, err);
					}
				}
			}

			// Record the exit reason in state (broadcast to web before the COMPLETE_BATCH reset).
			updateBatchStateAndBroadcastRef.current!(
				sessionId,
				(prev) => ({
					...prev,
					[sessionId]: {
						...prev[sessionId],
						goalExitReason: exitReason,
					},
				}),
				true
			);

			window.maestro.logger.autorun(`Goal-Driven Auto Run exiting: ${exitReason}`, session.name, {
				reason: exitReason,
				detail: exitDetail,
				finalProgress,
				iterations: iteration,
			});

			const totalElapsedMs = timeTracking.getElapsedTime(sessionId);
			const wasStopped = exitReason === 'stopped-by-user';
			const isSuccess = exitReason === 'completed';

			const finalSummary = `${exitReasonLabel(exitReason)} (${finalProgress}%)`;
			const finalDetails = [
				`**Goal-Driven Auto Run Summary**`,
				``,
				`- **Status:** ${exitReasonLabel(exitReason)}`,
				`- **Reason:** ${exitDetail}`,
				`- **Final Progress:** ${finalProgress}%`,
				`- **Iterations:** ${iteration}`,
				`- **Total Duration:** ${formatElapsedTime(totalElapsedMs)}`,
				`- **Goal:** ${goalConfig.goal}`,
			].join('\n');

			// Claim the flush state: if killBatchRun already flushed, skip the history +
			// stats writes here so we don't clobber the recorded duration with a stale value.
			const alreadyFlushed = claimFlushState(autoRunFlushStateRefs, sessionId) === null;

			if (!alreadyFlushed) {
				try {
					await onAddHistoryEntry({
						type: 'AUTO',
						timestamp: Date.now(),
						summary: finalSummary,
						fullResponse: finalDetails,
						projectPath: session.cwd,
						sessionId,
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
						achievementAction: 'openAbout',
					});
				} catch (historyError) {
					// A failed final-history write shouldn't abort cleanup, but it also
					// shouldn't vanish silently - log it (matching the stats catch below).
					logger.warn('[GoalRunner] Failed to write final history entry:', undefined, historyError);
				}

				if (statsAutoRunId) {
					try {
						await window.maestro.stats.endAutoRun(statsAutoRunId, totalElapsedMs, finalProgress);
					} catch (statsError) {
						logger.warn('[GoalRunner] Failed to end stats tracking:', undefined, statsError);
					}
				}
			}

			// Always flush debounced updates and dispatch COMPLETE_BATCH to clean up state.
			flushDebouncedUpdate(sessionId);
			dispatch({ type: 'COMPLETE_BATCH', sessionId, finalSessionIds: agentSessionIds });
			broadcastAutoRunState(sessionId, null);

			// Skip onComplete when alreadyFlushed: killBatchRun owns it in that case
			// (it captured elapsed time before stopTracking zeroed the tracker).
			if (!alreadyFlushed && isMountedRef.current && onComplete) {
				onComplete({
					sessionId,
					sessionName,
					completedTasks: finalProgress,
					totalTasks: 100,
					wasStopped,
					elapsedTimeMs: totalElapsedMs,
					inputTokens: totalInputTokens,
					outputTokens: totalOutputTokens,
					totalCostUsd: totalCost,
					documentsProcessed: 0,
				});
			}

			// Process any items queued during the run.
			if (isMountedRef.current && onProcessQueueAfterCompletion) {
				setTimeout(() => onProcessQueueAfterCompletion(sessionId), 0);
			}

			// Clean up tracking and the stop flag, then allow the system to sleep.
			timeTracking.stopTracking(sessionId);
			delete stopRequestedRefs.current[sessionId];
			window.maestro.power.removeReason(`autorun:${sessionId}`);
		},
		[
			audioFeedbackCommandRef,
			audioFeedbackEnabledRef,
			autoRunFlushStateRefs,
			broadcastAutoRunState,
			dispatch,
			errorResolutionRefs,
			flushDebouncedUpdate,
			groups,
			isMountedRef,
			onAddHistoryEntry,
			onComplete,
			onProcessQueueAfterCompletion,
			onSpawnAgent,
			spawnBackgroundSynopsis,
			getSessions,
			stopRequestedRefs,
			timeTracking,
			updateBatchStateAndBroadcastRef,
		]
	);

	return { startGoalRun };
}
