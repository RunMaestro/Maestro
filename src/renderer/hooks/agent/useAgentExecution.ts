import { useCallback, useRef } from 'react';
import { getClaudeTokenSourceFields } from '../../../shared/claudeTokenMode';
import type { Session, SessionState, UsageStats, QueuedItem, ToolType } from '../../types';
import {
	getActiveTab,
	markTabRunningQueuedItem,
	resolveQueuedItemTarget,
} from '../../utils/tabHelpers';
import { filterYoloArgs } from '../../utils/agentArgs';
import { prepareMaestroSystemPrompt } from '../../utils/spawnHelpers';
import {
	hasRunnableQueueItem,
	nextRunnableQueueItem,
	takeNextRunnableQueueItem,
} from '../../utils/executionQueue';
import { estimateContextUsage } from '../../utils/contextUsage';
import { usageStatsToTurnFields } from '../../services/turnUsageLedger';
import { cheapTurnSettings } from '../../../shared/modelTiers';
import {
	FALLBACK_CONTEXT_WINDOW,
	getModelContextWindowOverride,
} from '../../../shared/agentConstants';
import { isFailedSynopsisResponse } from '../../../shared/synopsis';
import { stripAnsiCodes } from '../../../shared/stringUtils';
import { useSettingsStore } from '../../stores/settingsStore';
import { logger } from '../../utils/logger';

/**
 * Result from agent spawn operations.
 */
export interface AgentSpawnResult {
	success: boolean;
	response?: string;
	agentSessionId?: string;
	usageStats?: UsageStats;
	/** Context usage percentage estimated from the last usage event (not accumulated) */
	contextUsage?: number;
	/** Optional error detail when the run fails */
	error?: string;
	/** Structured error category for downstream handling */
	errorKind?: AgentSpawnErrorKind;
}

/**
 * Per-spawn options for `spawnAgentForSession`.
 *
 * The model/effort overrides are run-scoped: an Auto Run can use a different
 * model than the agent's configured default without writing anything back to
 * the session. They win over `session.customModel` / `session.customEffort`
 * because the Auto Run spawn path has no active tab to consult.
 */
export interface SpawnAgentOptions {
	isAutoRun?: boolean;
	/** Overrides session.customModel for this spawn only */
	modelOverride?: string;
	/** Overrides session.customEffort for this spawn only */
	effortOverride?: string;
}

/**
 * The subset of spawn options the batch/goal runners forward from a
 * `BatchRunConfig`. `isAutoRun` is supplied by the wiring layer, not the runner.
 */
export type SpawnAgentRunOverrides = Pick<SpawnAgentOptions, 'modelOverride' | 'effortOverride'>;

export type AgentSpawnErrorKind =
	| 'watchdog-stalled'
	| 'watchdog-timeout'
	| 'process-exit'
	| 'process-exit-unknown'
	| 'spawn-failed';

const BATCH_WATCHDOG_CHECK_MS = 15 * 1000; // Check every 15 seconds

/**
 * Dependencies for the useAgentExecution hook.
 */
export interface UseAgentExecutionDeps {
	/** Active session id (null if none selected). Session fields are read from sessionsRef at call time. */
	activeSessionId: string | null;
	/** Ref to sessions for accessing latest state without re-renders */
	sessionsRef: React.MutableRefObject<Session[]>;
	/** Session state setter */
	setSessions: React.Dispatch<React.SetStateAction<Session[]>>;
	/** Ref to processQueuedItem function for processing queue after agent exit */
	processQueuedItemRef: React.MutableRefObject<
		((sessionId: string, item: QueuedItem) => Promise<void>) | null
	>;
	/** Flash notification setter (bottom-right) */
	setFlashNotification: (message: string | null) => void;
	/** Success flash notification setter (center screen) */
	setSuccessFlashNotification: (message: string | null) => void;
}

/**
 * Return type for useAgentExecution hook.
 */
export interface UseAgentExecutionReturn {
	/** Spawn an agent for a specific session and wait for completion */
	spawnAgentForSession: (
		sessionId: string,
		prompt: string,
		cwdOverride?: string,
		options?: SpawnAgentOptions
	) => Promise<AgentSpawnResult>;
	/** Spawn an agent with a prompt for the active session */
	spawnAgentWithPrompt: (prompt: string) => Promise<AgentSpawnResult>;
	/** Spawn a background synopsis agent (resumes an old agent session) */
	spawnBackgroundSynopsis: (
		sessionId: string,
		cwd: string,
		resumeAgentSessionId: string,
		prompt: string,
		toolType?: ToolType,
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
	) => Promise<AgentSpawnResult>;
	/** Ref to spawnBackgroundSynopsis for use in callbacks that need latest version */
	spawnBackgroundSynopsisRef: React.MutableRefObject<
		| ((
				sessionId: string,
				cwd: string,
				resumeAgentSessionId: string,
				prompt: string,
				toolType?: ToolType,
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
		  ) => Promise<AgentSpawnResult>)
		| null
	>;
	/** Ref to spawnAgentWithPrompt for use in callbacks that need latest version */
	spawnAgentWithPromptRef: React.MutableRefObject<
		((prompt: string) => Promise<AgentSpawnResult>) | null
	>;
	/** Show flash notification (auto-dismisses after 2 seconds) */
	showFlashNotification: (message: string) => void;
	/** Show success flash notification (center screen, auto-dismisses after 2 seconds) */
	showSuccessFlash: (message: string) => void;
	/** Cancel all pending synopsis processes for a given maestro session ID */
	cancelPendingSynopsis: (maestroSessionId: string) => Promise<void>;
}

/**
 * Hook for agent execution and spawning operations.
 *
 * Handles:
 * - Spawning agents for batch processing
 * - Spawning agents with prompts
 * - Background synopsis generation (resuming old sessions)
 * - Flash notifications for user feedback
 *
 * @param deps - Hook dependencies
 * @returns Agent execution functions and refs
 */
export function useAgentExecution(deps: UseAgentExecutionDeps): UseAgentExecutionReturn {
	const {
		activeSessionId,
		sessionsRef,
		setSessions,
		processQueuedItemRef,
		setFlashNotification,
		setSuccessFlashNotification,
	} = deps;

	// Refs for functions that need to be accessed from other callbacks
	const spawnBackgroundSynopsisRef = useRef<
		UseAgentExecutionReturn['spawnBackgroundSynopsis'] | null
	>(null);
	const spawnAgentWithPromptRef = useRef<((prompt: string) => Promise<AgentSpawnResult>) | null>(
		null
	);

	// Track active synopsis session IDs for cancellation
	// Map: maestroSessionId -> Set of active synopsis process session IDs
	const activeSynopsisSessionsRef = useRef<Map<string, Set<string>>>(new Map());
	const accumulateUsageStats = useCallback(
		(current: UsageStats | undefined, usageStats: UsageStats): UsageStats => ({
			...usageStats,
			inputTokens: (current?.inputTokens || 0) + usageStats.inputTokens,
			outputTokens: (current?.outputTokens || 0) + usageStats.outputTokens,
			cacheReadInputTokens: (current?.cacheReadInputTokens || 0) + usageStats.cacheReadInputTokens,
			cacheCreationInputTokens:
				(current?.cacheCreationInputTokens || 0) + usageStats.cacheCreationInputTokens,
			totalCostUsd: (current?.totalCostUsd || 0) + usageStats.totalCostUsd,
			reasoningTokens:
				current?.reasoningTokens || usageStats.reasoningTokens
					? (current?.reasoningTokens || 0) + (usageStats.reasoningTokens || 0)
					: undefined,
		}),
		[]
	);

	/**
	 * Spawn a Claude agent for a specific session and wait for completion.
	 * Used for batch processing where we need to track the agent's output.
	 *
	 * @param sessionId - The session ID to spawn the agent for
	 * @param prompt - The prompt to send to the agent
	 * @param cwdOverride - Optional override for working directory (e.g., for worktree mode)
	 * @param options - Per-spawn options, including the run-scoped model/effort overrides
	 */
	const spawnAgentForSession = useCallback(
		async (
			sessionId: string,
			prompt: string,
			cwdOverride?: string,
			/**
			 * `modelOverride` / `effortOverride` carry whatever the caller resolved for
			 * this spawn: an Auto Run document's per-task model hint, else the run-scoped
			 * override from the Auto Run config or `--model`. Absent on every other call
			 * path, in which case the agent's own configured values are used.
			 */
			options?: SpawnAgentOptions
		): Promise<AgentSpawnResult> => {
			// Use sessionsRef to get latest sessions (fixes stale closure when called right after session creation)
			const session = sessionsRef.current.find((s) => s.id === sessionId);
			if (!session) return { success: false };

			// Use override cwd if provided (worktree mode), otherwise use session's cwd
			const effectiveCwd = cwdOverride || session.cwd;

			// This spawns a new agent session and waits for completion
			// Use session's toolType for multi-provider support
			try {
				const agent = await window.maestro.agents.get(session.toolType);
				if (!agent) {
					logger.error(`[spawnAgentForSession] Agent not found for toolType: ${session.toolType}`);
					return { success: false };
				}

				// Validate command before registering listeners to avoid leaked subscriptions
				const commandToUse = agent.path || agent.command;
				if (!commandToUse) {
					throw new Error(`${session.toolType} agent has no command configured`);
				}

				// For batch processing, use a unique session ID per task run to avoid contaminating the main AI terminal
				// This prevents batch output from appearing in the interactive AI terminal
				const targetSessionId = `${sessionId}-batch-${Date.now()}`;

				// Batch tasks always spawn fresh sessions - prepare Maestro system prompt
				const appendSystemPrompt = await prepareMaestroSystemPrompt({
					session,
					activeTabId: getActiveTab(session)?.id,
				});

				// Note: We intentionally do NOT set the session or tab state to 'busy' here.
				// Batch operations run in isolation and should not affect the main UI state.
				// The batch progress is tracked separately via BatchRunState in useBatchProcessor.

				// Create a promise that resolves when the agent completes
				return new Promise((resolve) => {
					let agentSessionId: string | undefined;
					let responseText = '';
					let taskUsageStats: UsageStats | undefined;
					let lastUsageEvent: UsageStats | undefined; // Last (non-accumulated) event for context estimation
					const queryStartTime = Date.now(); // Track start time for stats
					const isBatchProcess = options?.isAutoRun ?? false;
					let lastOutputAt = Date.now();
					let settled = false;
					let inactivityTimer: ReturnType<typeof setInterval> | null = null;

					// Array to collect cleanup functions as listeners are registered
					const cleanupFns: (() => void)[] = [];

					const cleanup = () => {
						cleanupFns.forEach((fn) => fn());
						if (inactivityTimer) {
							clearInterval(inactivityTimer);
							inactivityTimer = null;
						}
					};

					const resolveOnce = (result: AgentSpawnResult) => {
						if (settled) return;
						settled = true;
						cleanup();
						resolve(result);
					};

					// Set up listeners for this specific agent run
					cleanupFns.push(
						window.maestro.process.onData((sid: string, data: string) => {
							if (sid === targetSessionId) {
								lastOutputAt = Date.now();
								responseText += data;
							}
						})
					);

					cleanupFns.push(
						window.maestro.process.onSessionId((sid: string, capturedId: string) => {
							if (sid === targetSessionId) {
								agentSessionId = capturedId;
							}
						})
					);

					// Capture usage stats for this specific task
					cleanupFns.push(
						window.maestro.process.onUsage((sid: string, usageStats) => {
							if (sid === targetSessionId) {
								// Accumulate usage stats for this task (there may be multiple usage events per task)
								taskUsageStats = accumulateUsageStats(taskUsageStats, usageStats);
								// Keep the last event for context estimation (accumulated totals can exceed context window)
								lastUsageEvent = usageStats;
							}
						})
					);

					cleanupFns.push(
						window.maestro.process.onExit((sid: string, code: number | null | undefined) => {
							if (sid === targetSessionId) {
								// Record query stats for Auto Run queries
								const queryDuration = Date.now() - queryStartTime;
								const activeTab = getActiveTab(session);
								window.maestro.stats
									.recordQuery({
										sessionId: sessionId, // Use the original session ID, not the batch ID
										agentType: session.toolType,
										source: 'auto', // Auto Run queries are always 'auto'
										startTime: queryStartTime,
										duration: queryDuration,
										projectPath: effectiveCwd,
										tabId: activeTab?.id,
										isRemote: session.sessionSshRemoteConfig?.enabled ?? false,
										isWorktree: !!session.parentSessionId,
										// `taskUsageStats` is already scoped to this task -
										// it is declared inside the per-task closure and only
										// accumulates that task's usage events - so it is the
										// per-turn delta the row wants, no ledger needed.
										...usageStatsToTurnFields(taskUsageStats),
									})
									.catch((err) => {
										// Don't fail the batch flow if stats recording fails
										logger.warn(
											'[spawnAgentForSession] Failed to record query stats:',
											undefined,
											err
										);
									});

								const didExitCleanly = code === 0;
								const exitErrorKind = didExitCleanly
									? undefined
									: code == null
										? ('process-exit-unknown' as const)
										: ('process-exit' as const);
								const exitError = didExitCleanly
									? undefined
									: code == null
										? 'Agent task exited without a status code'
										: `Agent task exited with code ${code}`;

								// Estimate context usage from the last single-turn event (not accumulated totals)
								const taskContextUsage = lastUsageEvent
									? (estimateContextUsage(lastUsageEvent, session.toolType) ?? undefined)
									: undefined;

								// Check for queued items BEFORE updating state (using sessionsRef for latest state)
								const currentSession = sessionsRef.current.find((s) => s.id === sessionId);
								let queuedItemToProcess: { sessionId: string; item: QueuedItem } | null = null;
								// Skip paused items: only a runnable (non-held) item triggers dispatch.
								const nextRunnable = currentSession
									? nextRunnableQueueItem(currentSession.executionQueue)
									: undefined;
								const hasQueuedItems = !!nextRunnable;

								if (nextRunnable) {
									queuedItemToProcess = {
										sessionId: sessionId,
										item: nextRunnable,
									};
								}

								// Update state - if there are queued items, keep busy and process next
								setSessions((prev) =>
									prev.map((s) => {
										if (s.id !== sessionId) return s;

										const { item: nextItem, remaining: remainingQueue } = takeNextRunnableQueueItem(
											s.executionQueue
										);
										if (nextItem) {
											const target = resolveQueuedItemTarget(s, nextItem);

											if (!target) {
												// Fallback: no tabs exist
												return {
													...s,
													state: 'busy' as SessionState,
													busySource: 'ai',
													executionQueue: remainingQueue,
													thinkingStartTime: Date.now(),
													currentCycleTokens: 0,
													currentCycleBytes: 0,
													pendingAICommandForSynopsis: undefined,
												};
											}

											// Orphan target: the user closed this tab while the message was
											// still queued. Route the busy state + user log to
											// orphanedThinkingTabs and leave the active tab untouched - the
											// send is fire-and-forget.
											if (target.location === 'orphan') {
												return {
													...s,
													state: 'busy' as SessionState,
													busySource: 'ai',
													...(s.orphanedThinkingTabs && {
														orphanedThinkingTabs: s.orphanedThinkingTabs.map((tab) =>
															tab.id === target.tabId
																? markTabRunningQueuedItem(tab, nextItem, s)
																: tab
														),
													}),
													executionQueue: remainingQueue,
													thinkingStartTime: Date.now(),
													currentCycleTokens: 0,
													currentCycleBytes: 0,
													pendingAICommandForSynopsis: undefined,
												};
											}

											// Foreground target: mark the tab busy (so its chip keeps the
											// in-progress indicator while the dequeued turn runs), append the
											// user log, and bring the tab into view. Shares
											// markTabRunningQueuedItem with the other dispatch paths so the
											// busy-state + log construction stays identical.
											const updatedAiTabs = s.aiTabs.map((tab) =>
												tab.id === target.tabId ? markTabRunningQueuedItem(tab, nextItem, s) : tab
											);

											return {
												...s,
												state: 'busy' as SessionState,
												busySource: 'ai',
												aiTabs: updatedAiTabs,
												activeTabId: target.tabId,
												executionQueue: remainingQueue,
												thinkingStartTime: Date.now(),
												currentCycleTokens: 0,
												currentCycleBytes: 0,
												pendingAICommandForSynopsis: undefined,
											};
										}

										// No queued items. This spawn ran under its own `-batch-` process id
										// and deliberately never marked a tab busy (see the spawn site), so
										// its exit must not clear tabs whose own `-ai-{tabId}` agents are
										// still running in parallel - that drops the in-progress indicator
										// from threads that are very much still working. Each of those tabs
										// is cleared by its own onExit handler.
										const anyTabStillBusy = s.aiTabs?.some((tab) => tab.state === 'busy') ?? false;

										return {
											...s,
											state: anyTabStillBusy ? ('busy' as SessionState) : ('idle' as SessionState),
											busySource: anyTabStillBusy ? s.busySource : undefined,
											thinkingStartTime: anyTabStillBusy ? s.thinkingStartTime : undefined,
											pendingAICommandForSynopsis: undefined,
										};
									})
								);

								// Process queued item AFTER state update
								if (queuedItemToProcess && processQueuedItemRef.current) {
									setTimeout(() => {
										processQueuedItemRef.current!(
											queuedItemToProcess!.sessionId,
											queuedItemToProcess!.item
										);
									}, 0);
								}

								// For batch processing (Auto Run): if there are queued items from manual writes,
								// wait for the queue to drain before resolving. This ensures batch tasks don't
								// race with queued manual writes. Worktree mode can skip this since it operates
								// in a separate directory with no file conflicts.
								// Note: cwdOverride is set when worktree is enabled
								if (hasQueuedItems && !cwdOverride) {
									// Wait for queue to drain by polling session state
									// The queue is processed sequentially, so we wait until session becomes idle
									const waitForQueueDrain = () => {
										if (settled) return;
										const checkSession = sessionsRef.current.find((s) => s.id === sessionId);
										if (
											!checkSession ||
											checkSession.state === 'idle' ||
											!hasRunnableQueueItem(checkSession.executionQueue)
										) {
											// Queue drained (or only held items left) or session idle - safe to continue batch
											resolveOnce({
												success: didExitCleanly,
												response: responseText,
												agentSessionId,
												usageStats: taskUsageStats,
												contextUsage: taskContextUsage,
												error: exitError,
												errorKind: exitErrorKind,
											});
										} else {
											// Queue still processing - check again
											setTimeout(waitForQueueDrain, 100);
										}
									};
									// Start polling after a short delay to let state update propagate
									setTimeout(waitForQueueDrain, 50);
								} else {
									// No queued items or worktree mode - resolve immediately
									resolveOnce({
										success: didExitCleanly,
										response: responseText,
										agentSessionId,
										usageStats: taskUsageStats,
										contextUsage: taskContextUsage,
										error: exitError,
										errorKind: exitErrorKind,
									});
								}
							}
						})
					);

					// Watchdog for hung Auto Run batch tasks. Two independent triggers,
					// each with a 0 = "unlimited" sentinel that disables it:
					//   1. Inactivity: force-kill after a stretch of NO output. Catches a
					//      truly silent/hung agent.
					//   2. Max duration: force-kill once total wall-clock runtime exceeds a
					//      cap, regardless of output. Catches a stuck-but-chatty agent that
					//      keeps emitting (resetting lastOutputAt) yet never finishes the
					//      task, which would otherwise defeat the inactivity watchdog and
					//      hang the whole multi-document Auto Run loop forever, since the
					//      per-document loop only advances once processTask resolves.
					// Both resolve the task as a failure so the batch loop terminates this
					// document (see isWatchdogFailure handling in useBatchRunner).
					if (isBatchProcess) {
						const { autoRunInactivityTimeoutMin, autoRunMaxTaskDurationMin } =
							useSettingsStore.getState();
						const inactivityTimeoutMs =
							autoRunInactivityTimeoutMin > 0 ? autoRunInactivityTimeoutMin * 60 * 1000 : 0;
						const maxDurationMs =
							autoRunMaxTaskDurationMin > 0 ? autoRunMaxTaskDurationMin * 60 * 1000 : 0;

						if (inactivityTimeoutMs > 0 || maxDurationMs > 0) {
							inactivityTimer = setInterval(() => {
								if (settled) return;
								const now = Date.now();

								// Absolute wall-clock cap (activity-independent).
								if (maxDurationMs > 0 && now - queryStartTime > maxDurationMs) {
									window.maestro.process.kill(targetSessionId).catch(() => {});
									resolveOnce({
										success: false,
										error: `Agent task exceeded the maximum duration of ${autoRunMaxTaskDurationMin} minutes`,
										errorKind: 'watchdog-timeout',
										response: responseText,
										agentSessionId,
										usageStats: taskUsageStats,
									});
									return;
								}

								// Silence-based inactivity watchdog.
								if (inactivityTimeoutMs > 0 && now - lastOutputAt > inactivityTimeoutMs) {
									window.maestro.process.kill(targetSessionId).catch(() => {});
									resolveOnce({
										success: false,
										error: `Agent task stalled: no output for ${autoRunInactivityTimeoutMin} minutes`,
										errorKind: 'watchdog-stalled',
										response: responseText,
										agentSessionId,
										usageStats: taskUsageStats,
									});
								}
							}, BATCH_WATCHDOG_CHECK_MS);
						}
					}

					// Batch processing (Auto Run) should NOT use read-only mode - it needs to make changes
					window.maestro.process
						.spawn({
							sessionId: targetSessionId,
							toolType: session.toolType,
							cwd: effectiveCwd,
							command: commandToUse,
							args: agent.args || [],
							prompt,
							appendSystemPrompt,
							readOnlyMode: false, // Auto Run needs to make changes, not plan
							// Auto Run runs unattended in --print mode, so it must have full
							// access - the same permission level as an interactive tab set to
							// "full". Without this, agents whose bypass is gated on full access
							// (e.g. Claude Code's --dangerously-skip-permissions in fullAccessArgs)
							// fall back to the default permission model, can't get tool approvals
							// non-interactively, and deadlock the run.
							permissionMode: 'full',
							// Per-session config overrides (if set)
							sessionCustomPath: session.customPath,
							sessionCustomArgs: session.customArgs,
							sessionAdditionalDirectories: session.additionalDirectories,
							sessionCustomEnvVars: session.customEnvVars,
							// A resolved override (document model hint, Auto Run model picker,
							// CLI --model) wins over the session's configured model. There is no
							// active tab in this path, so the override sits directly above
							// session.customModel and never touches the session itself - it dies
							// when the run ends.
							sessionCustomModel: options?.modelOverride ?? session.customModel,
							// Auto Run is session-level (no active tab), so the session's effort
							// is the source. Interactive spawns pass this too; omitting it here
							// dropped the user's configured reasoning effort in Auto Run, which for
							// Codex meant no reasoning summary was streamed (Thought Stream stayed
							// stuck on "Waiting for the agent to start thinking...") - see #1147.
							// It also made the same playbook run at a different effort depending on
							// whether it was launched from the app or maestro-cli, which passed it.
							sessionCustomEffort: options?.effortOverride ?? session.customEffort,
							sessionCustomContextWindow: session.customContextWindow,
							// Per-session SSH remote config (takes precedence over agent-level SSH config)
							sessionSshRemoteConfig: session.sessionSshRemoteConfig,
						})
						.catch((err: unknown) => {
							resolveOnce({
								success: false,
								error: err instanceof Error ? err.message : String(err),
								errorKind: 'spawn-failed',
							});
						});
				});
			} catch (error) {
				logger.error('Error spawning agent:', undefined, error);
				return { success: false, error: error instanceof Error ? error.message : String(error) };
			}
		},
		[accumulateUsageStats, processQueuedItemRef, sessionsRef, setSessions]
	); // Uses sessionsRef for latest sessions

	/**
	 * Wrapper for slash commands that need to spawn an agent with just a prompt.
	 * Uses the active session's ID and working directory.
	 */
	const spawnAgentWithPrompt = useCallback(
		async (prompt: string): Promise<AgentSpawnResult> => {
			if (!activeSessionId) return { success: false };
			return spawnAgentForSession(activeSessionId, prompt, undefined, { isAutoRun: false });
		},
		[activeSessionId, spawnAgentForSession]
	);

	/**
	 * Spawn a background synopsis agent that resumes an old agent session.
	 * Used for generating summaries without affecting main session state.
	 *
	 * @param sessionId - The Maestro session ID (for logging/tracking)
	 * @param cwd - Working directory for the agent
	 * @param resumeAgentSessionId - The agent session ID to resume
	 * @param prompt - The prompt to send to the resumed session
	 * @param toolType - The agent type (defaults to claude-code for backwards compatibility)
	 */
	const spawnBackgroundSynopsis = useCallback(
		async (
			sessionId: string,
			cwd: string,
			resumeAgentSessionId: string,
			prompt: string,
			toolType: ToolType = 'claude-code',
			sessionConfig?: {
				customPath?: string;
				customArgs?: string;
				customEnvVars?: Record<string, string>;
				customModel?: string;
				customEffort?: string;
				customContextWindow?: number;
				// Claude token-source selection. The synopsis spawns under a synthetic
				// sessionId, so the process:spawn handler can't resolve the token mode
				// from the persisted session - forward these fields explicitly instead.
				enableMaestroP?: boolean;
				maestroPMode?: 'interactive' | 'dynamic';
				maestroPPath?: string;
				sessionSshRemoteConfig?: {
					enabled: boolean;
					remoteId: string | null;
					workingDirOverride?: string;
				};
			}
		): Promise<AgentSpawnResult> => {
			try {
				const agent = await window.maestro.agents.get(toolType);
				if (!agent) {
					logger.error(`[spawnBackgroundSynopsis] Agent not found for toolType: ${toolType}`);
					return { success: false };
				}

				// Validate command before registering listeners to avoid leaked subscriptions
				const commandToUse = sessionConfig?.customPath || agent.path || agent.command;
				if (!commandToUse) {
					throw new Error(`${toolType} agent has no command configured`);
				}

				const cheapSynopsis = cheapTurnSettings(toolType);

				// The cheap tier is a MODEL swap, and a model carries a context
				// window with it. Resuming replays the whole transcript, so
				// downgrading an agent running Anthropic's 1M beta (`opus[1m]`)
				// onto a 200k model makes every synopsis of a long conversation
				// fail with "Prompt is too long" - the transcript fit the tab's
				// model and cannot fit the cheap one. Keep the tab's model
				// whenever the downgrade would shrink the window; effort still
				// drops to the bottom rung, since that costs nothing to read.
				const tabContextWindow = getModelContextWindowOverride(sessionConfig?.customModel);
				const cheapContextWindow = getModelContextWindowOverride(cheapSynopsis.model);
				const downgradeShrinksWindow =
					(tabContextWindow ?? FALLBACK_CONTEXT_WINDOW) >
					(cheapContextWindow ?? FALLBACK_CONTEXT_WINDOW);
				const synopsisModel = downgradeShrinksWindow
					? sessionConfig?.customModel
					: (cheapSynopsis.model ?? sessionConfig?.customModel);

				// Use a unique target ID for background synopsis
				const targetSessionId = `${sessionId}-synopsis-${Date.now()}`;

				// Track this synopsis session for potential cancellation
				if (!activeSynopsisSessionsRef.current.has(sessionId)) {
					activeSynopsisSessionsRef.current.set(sessionId, new Set());
				}
				activeSynopsisSessionsRef.current.get(sessionId)!.add(targetSessionId);

				return new Promise((resolve) => {
					let agentSessionId: string | undefined;
					let responseText = '';
					let synopsisUsageStats: UsageStats | undefined;
					let lastSynopsisUsageEvent: UsageStats | undefined;

					// Array to collect cleanup functions as listeners are registered
					const cleanupFns: (() => void)[] = [];

					const cleanup = () => {
						cleanupFns.forEach((fn) => fn());
						// Remove from tracking
						activeSynopsisSessionsRef.current.get(sessionId)?.delete(targetSessionId);
					};

					cleanupFns.push(
						window.maestro.process.onData((sid: string, data: string) => {
							if (sid === targetSessionId) {
								responseText += data;
							}
						})
					);

					cleanupFns.push(
						window.maestro.process.onSessionId((sid: string, capturedId: string) => {
							if (sid === targetSessionId) {
								agentSessionId = capturedId;
							}
						})
					);

					// Capture usage stats for this synopsis request
					cleanupFns.push(
						window.maestro.process.onUsage((sid: string, usageStats) => {
							if (sid === targetSessionId) {
								// Accumulate usage stats (there may be multiple events)
								synopsisUsageStats = accumulateUsageStats(synopsisUsageStats, usageStats);
								// Keep the last event for context estimation
								lastSynopsisUsageEvent = usageStats;
							}
						})
					);

					cleanupFns.push(
						window.maestro.process.onExit((sid: string, code: number | null | undefined) => {
							if (sid === targetSessionId) {
								cleanup();
								const ctx = lastSynopsisUsageEvent
									? (estimateContextUsage(lastSynopsisUsageEvent, toolType) ?? undefined)
									: undefined;
								// A failed synopsis still writes to stdout: the provider
								// prints its error ("Prompt is too long") and exits. Reported
								// as a success, that text is parsed as a summary and lands in
								// History as the record of the turn, AND stamps
								// lastSynopsisTime - so the next synopsis skips everything the
								// agent did before the failure. Report the failure instead and
								// let the caller write nothing.
								const failed =
									(typeof code === 'number' && code !== 0) ||
									isFailedSynopsisResponse(responseText, toolType);
								resolve({
									success: !failed,
									response: responseText,
									agentSessionId,
									usageStats: synopsisUsageStats,
									contextUsage: ctx,
									...(failed
										? {
												error: stripAnsiCodes(responseText).trim() || `exit code ${code}`,
												errorKind: 'process-exit' as const,
											}
										: {}),
								});
							}
						})
					);

					// Spawn with session resume - the IPC handler will use the agent's resumeArgs builder
					// If no sessionConfig or no sessionSshRemoteConfig, try to get it from the main session (by sessionId)
					let effectiveSessionSshRemoteConfig = sessionConfig?.sessionSshRemoteConfig;
					if (!effectiveSessionSshRemoteConfig) {
						// Try to find the main session and use its SSH config
						const mainSession = sessionsRef.current.find((s) => s.id === sessionId);
						if (mainSession && mainSession.sessionSshRemoteConfig) {
							effectiveSessionSshRemoteConfig = mainSession.sessionSshRemoteConfig;
						}
					}
					window.maestro.process
						.spawn({
							sessionId: targetSessionId,
							toolType,
							cwd,
							command: commandToUse,
							// Strip permission-bypass flags (e.g. --dangerously-skip-permissions). A
							// background synopsis only reads the resumed conversation and emits a text
							// summary - it must never acquire the agent's workspace lock. Left unfiltered
							// it holds that lock for its full duration and blocks the NEXT queued send
							// from spawning until it finishes, stalling background queue processing for
							// as long as the synopsis runs. Mirrors tab-naming, which filters for the
							// same reason.
							args: filterYoloArgs(agent.args || [], agent),
							prompt,
							agentSessionId: resumeAgentSessionId, // This triggers the agent's resume mechanism
							// Per-session config overrides (if set)
							sessionCustomPath: sessionConfig?.customPath,
							sessionCustomArgs: sessionConfig?.customArgs,
							sessionCustomEnvVars: sessionConfig?.customEnvVars,
							// A synopsis summarizes a conversation that already happened. It is
							// pinned to the bottom of both ladders rather than inheriting the
							// tab's model, because running a few sentences of prose on the model
							// that just did the engineering is pure waste - one premium turn per
							// completed turn, forever. Falls back to the tab's own model where
							// the provider has no tier mapping, or where the cheap model's
							// context window is smaller than the tab's (see synopsisModel).
							//
							// Safe only because the synopsis is a LEAF: every caller discards the
							// agentSessionId it returns rather than adopting it, so the cheap
							// model cannot follow the conversation into the next real turn. A
							// future caller that adopts that id must revisit this.
							sessionCustomModel: synopsisModel,
							sessionCustomEffort: cheapSynopsis.effort ?? sessionConfig?.customEffort,
							sessionCustomContextWindow: sessionConfig?.customContextWindow,
							// Forward the agent's Claude token source. The synopsis runs under a
							// synthetic sessionId, so the process:spawn handler can't hydrate the
							// token mode from the persisted session - it falls back to these.
							// Shared extractor guarantees the SAME complete triple - no
							// partial/drifting forward possible.
							...getClaudeTokenSourceFields(sessionConfig),
							// Always use effective SSH remote config if available
							sessionSshRemoteConfig: effectiveSessionSshRemoteConfig,
						})
						.catch(() => {
							cleanup();
							resolve({ success: false });
						});
				});
			} catch (error) {
				logger.error('Error spawning background synopsis:', undefined, error);
				return { success: false };
			}
		},
		[accumulateUsageStats, sessionsRef]
	);

	/**
	 * Cancel all pending synopsis processes for a given maestro session ID.
	 * Called when user clicks Stop to prevent synopsis from running after interruption.
	 */
	const cancelPendingSynopsis = useCallback(async (maestroSessionId: string): Promise<void> => {
		const synopsisSessions = activeSynopsisSessionsRef.current.get(maestroSessionId);
		if (!synopsisSessions || synopsisSessions.size === 0) {
			return;
		}

		logger.info('[cancelPendingSynopsis] Cancelling synopsis sessions for', undefined, [
			maestroSessionId,
			{
				count: synopsisSessions.size,
				sessionIds: Array.from(synopsisSessions),
			},
		]);

		// Kill all active synopsis processes for this session
		const killPromises = Array.from(synopsisSessions).map(async (synopsisSessionId) => {
			try {
				await window.maestro.process.kill(synopsisSessionId);
				logger.info(
					'[cancelPendingSynopsis] Killed synopsis session:',
					undefined,
					synopsisSessionId
				);
			} catch (error) {
				// Process may have already exited
				logger.warn('[cancelPendingSynopsis] Failed to kill synopsis session:', undefined, [
					synopsisSessionId,
					error,
				]);
			}
		});

		await Promise.all(killPromises);

		// Clear the tracking set
		activeSynopsisSessionsRef.current.delete(maestroSessionId);
	}, []);

	/**
	 * Show flash notification (bottom-right, auto-dismisses after 2 seconds).
	 */
	const showFlashNotification = useCallback(
		(message: string) => {
			setFlashNotification(message);
			setTimeout(() => setFlashNotification(null), 2000);
		},
		[setFlashNotification]
	);

	/**
	 * Show success flash notification (center screen, auto-dismisses after 2 seconds).
	 */
	const showSuccessFlash = useCallback(
		(message: string) => {
			setSuccessFlashNotification(message);
			setTimeout(() => setSuccessFlashNotification(null), 2000);
		},
		[setSuccessFlashNotification]
	);

	// Update refs for functions that need to be accessed from other callbacks
	spawnBackgroundSynopsisRef.current = spawnBackgroundSynopsis;
	spawnAgentWithPromptRef.current = spawnAgentWithPrompt;

	return {
		spawnAgentForSession,
		spawnAgentWithPrompt,
		spawnBackgroundSynopsis,
		spawnBackgroundSynopsisRef,
		spawnAgentWithPromptRef,
		showFlashNotification,
		showSuccessFlash,
		cancelPendingSynopsis,
	};
}
