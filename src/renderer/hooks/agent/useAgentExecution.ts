import { useCallback, useEffect, useRef } from 'react';
import type { Session, UsageStats, QueuedItem, ToolType } from '../../types';
import { getActiveTab } from '../../utils/tabHelpers';
import { filterYoloArgs } from '../../utils/agentArgs';
import { getStdinFlags, prepareMaestroSystemPrompt } from '../../utils/spawnHelpers';
import { generateId } from '../../utils/ids';
import { hasRunnableQueueItem, nextRunnableQueueItem } from '../../utils/executionQueue';
import { notifyCenterFlash } from '../../stores/centerFlashStore';
import { estimateContextUsage } from '../../utils/contextUsage';
import { useSettingsStore } from '../../stores/settingsStore';
import { logger } from '../../utils/logger';
import {
	classifyCancelledExecution,
	classifyProcessExit,
	classifySpawnFailure,
	type AgentSpawnErrorKind,
} from './internal/agentExecutionErrorPolicy';
import { reduceAgentQueueAfterExit } from './internal/agentExecutionQueueReducer';
import {
	createBatchAgentSpawnConfig,
	createSynopsisAgentSpawnConfig,
	type SynopsisSessionConfig,
} from './internal/agentExecutionSpawnAdapter';
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

export type { AgentSpawnErrorKind } from './internal/agentExecutionErrorPolicy';

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
		options?: {
			isAutoRun?: boolean;
		}
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
		sessionConfig?: SynopsisSessionConfig
	) => Promise<AgentSpawnResult>;
	/** Ref to spawnBackgroundSynopsis for use in callbacks that need latest version */
	spawnBackgroundSynopsisRef: React.MutableRefObject<
		| ((
				sessionId: string,
				cwd: string,
				resumeAgentSessionId: string,
				prompt: string,
				toolType?: ToolType,
				sessionConfig?: SynopsisSessionConfig
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
	const { activeSessionId, sessionsRef, setSessions, processQueuedItemRef } = deps;

	// Refs for functions that need to be accessed from other callbacks
	const spawnBackgroundSynopsisRef = useRef<
		UseAgentExecutionReturn['spawnBackgroundSynopsis'] | null
	>(null);
	const spawnAgentWithPromptRef = useRef<((prompt: string) => Promise<AgentSpawnResult>) | null>(
		null
	);

	// Each execution owns exactly one cancellation callback. The callback removes
	// its subscriptions before resolving, so exit and unmount cannot clean up twice.
	const activeRunCancelsRef = useRef<Map<string, () => void>>(new Map());
	// Map: maestroSessionId -> (synopsis process session ID -> its cancellation owner).
	const activeSynopsisSessionsRef = useRef<Map<string, Map<string, () => void>>>(new Map());
	useEffect(
		() => () => {
			for (const cancel of Array.from(activeRunCancelsRef.current.values())) cancel();
		},
		[]
	);
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
	 */
	const spawnAgentForSession = useCallback(
		async (
			sessionId: string,
			prompt: string,
			cwdOverride?: string,
			options?: {
				isAutoRun?: boolean;
			}
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
						activeRunCancelsRef.current.delete(targetSessionId);
					};

					const resolveOnce = (result: AgentSpawnResult) => {
						if (settled) return;
						settled = true;
						cleanup();
						resolve(result);
					};

					activeRunCancelsRef.current.set(targetSessionId, () => {
						if (settled) return;
						window.maestro.process.kill(targetSessionId).catch(() => {});
						resolveOnce({
							...classifyCancelledExecution(),
							response: responseText,
							agentSessionId,
							usageStats: taskUsageStats,
						});
					});

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
									})
									.catch((err) => {
										// Don't fail the batch flow if stats recording fails
										logger.warn(
											'[spawnAgentForSession] Failed to record query stats:',
											undefined,
											err
										);
									});

								const exit = classifyProcessExit(code);

								// Estimate context usage from the last single-turn event (not accumulated totals)
								const taskContextUsage = lastUsageEvent
									? (estimateContextUsage(lastUsageEvent, session.toolType) ?? undefined)
									: undefined;
								const completedResult: AgentSpawnResult = {
									...exit,
									response: responseText,
									agentSessionId,
									usageStats: taskUsageStats,
									contextUsage: taskContextUsage,
								};

								// Select before scheduling state work so the subsequent side effect
								// dispatches the same first runnable item that the reducer removes.
								const currentSession = sessionsRef.current.find((s) => s.id === sessionId);
								const nextRunnable = currentSession
									? nextRunnableQueueItem(currentSession.executionQueue)
									: undefined;
								const queuedItemToProcess = nextRunnable ? { sessionId, item: nextRunnable } : null;
								const hasQueuedItems = !!nextRunnable;

								setSessions((prev) =>
									prev.map((s) =>
										s.id === sessionId
											? reduceAgentQueueAfterExit(s, Date.now(), generateId).session
											: s
									)
								);

								if (queuedItemToProcess && processQueuedItemRef.current) {
									setTimeout(() => {
										processQueuedItemRef.current!(
											queuedItemToProcess.sessionId,
											queuedItemToProcess.item
										);
									}, 0);
								}

								// For batch processing (Auto Run): if there are queued items from manual writes,
								// wait for the queue to drain before resolving. This ensures batch tasks don't
								// race with queued manual writes. Worktree mode can skip this since it operates
								// in a separate directory with no file conflicts.
								if (hasQueuedItems && !cwdOverride) {
									const waitForQueueDrain = () => {
										if (settled) return;
										const checkSession = sessionsRef.current.find((s) => s.id === sessionId);
										if (
											!checkSession ||
											checkSession.state === 'idle' ||
											!hasRunnableQueueItem(checkSession.executionQueue)
										) {
											resolveOnce(completedResult);
										} else {
											setTimeout(waitForQueueDrain, 100);
										}
									};
									setTimeout(waitForQueueDrain, 50);
								} else {
									resolveOnce(completedResult);
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

					// Spawn the agent for batch processing
					// Use effectiveCwd which may be a worktree path for parallel execution
					const { sendPromptViaStdin, sendPromptViaStdinRaw } = getStdinFlags({
						isSshSession: !!session.sshRemoteId || !!session.sessionSshRemoteConfig?.enabled,
						supportsStreamJsonInput: agent.capabilities?.supportsStreamJsonInput ?? false,
						hasImages: false, // Batch/Auto Run does not send images
					});

					// The adapter retains every process option while keeping this lifecycle
					// responsible only for listener ownership, watchdogs, and completion.
					window.maestro.process
						.spawn(
							createBatchAgentSpawnConfig({
								targetSessionId,
								session,
								command: commandToUse,
								agent,
								cwd: effectiveCwd,
								prompt,
								appendSystemPrompt,
								sendPromptViaStdin,
								sendPromptViaStdinRaw,
							})
						)
						.catch((err: unknown) => resolveOnce(classifySpawnFailure(err)));
				});
			} catch (error) {
				logger.error('Error spawning agent:', undefined, error);
				return classifySpawnFailure(error);
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
			sessionConfig?: SynopsisSessionConfig
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

				// Use a unique target ID for background synopsis
				const targetSessionId = `${sessionId}-synopsis-${Date.now()}`;

				return new Promise((resolve) => {
					let agentSessionId: string | undefined;
					let responseText = '';
					let synopsisUsageStats: UsageStats | undefined;
					let lastSynopsisUsageEvent: UsageStats | undefined;
					let settled = false;
					const cleanupFns: (() => void)[] = [];

					const cleanup = () => {
						cleanupFns.forEach((fn) => fn());
						activeRunCancelsRef.current.delete(targetSessionId);
						const sessionRuns = activeSynopsisSessionsRef.current.get(sessionId);
						sessionRuns?.delete(targetSessionId);
						if (sessionRuns?.size === 0) activeSynopsisSessionsRef.current.delete(sessionId);
					};
					const resolveOnce = (result: AgentSpawnResult) => {
						if (settled) return;
						settled = true;
						cleanup();
						resolve(result);
					};
					const cancel = () => {
						if (settled) return;
						window.maestro.process.kill(targetSessionId).catch(() => {});
						resolveOnce({
							...classifyCancelledExecution(),
							response: responseText,
							agentSessionId,
							usageStats: synopsisUsageStats,
						});
					};
					activeRunCancelsRef.current.set(targetSessionId, cancel);
					let sessionRuns = activeSynopsisSessionsRef.current.get(sessionId);
					if (!sessionRuns) {
						sessionRuns = new Map();
						activeSynopsisSessionsRef.current.set(sessionId, sessionRuns);
					}
					sessionRuns.set(targetSessionId, cancel);

					cleanupFns.push(
						window.maestro.process.onData((sid: string, data: string) => {
							if (sid === targetSessionId) responseText += data;
						})
					);
					cleanupFns.push(
						window.maestro.process.onSessionId((sid: string, capturedId: string) => {
							if (sid === targetSessionId) agentSessionId = capturedId;
						})
					);
					cleanupFns.push(
						window.maestro.process.onUsage((sid: string, usageStats) => {
							if (sid === targetSessionId) {
								synopsisUsageStats = accumulateUsageStats(synopsisUsageStats, usageStats);
								lastSynopsisUsageEvent = usageStats;
							}
						})
					);
					cleanupFns.push(
						window.maestro.process.onExit((sid: string) => {
							if (sid !== targetSessionId) return;
							const contextUsage = lastSynopsisUsageEvent
								? (estimateContextUsage(lastSynopsisUsageEvent, toolType) ?? undefined)
								: undefined;
							resolveOnce({
								success: true,
								response: responseText,
								agentSessionId,
								usageStats: synopsisUsageStats,
								contextUsage,
							});
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
					const { sendPromptViaStdin, sendPromptViaStdinRaw } = getStdinFlags({
						isSshSession: !!effectiveSessionSshRemoteConfig?.enabled,
						supportsStreamJsonInput: agent.capabilities?.supportsStreamJsonInput ?? false,
						hasImages: false, // Resume path does not send images
					});
					// The synopsis must never acquire a workspace lock, so its adapter
					// receives permission-bypass flags only after filtering.
					window.maestro.process
						.spawn(
							createSynopsisAgentSpawnConfig({
								targetSessionId,
								toolType,
								cwd,
								command: commandToUse,
								args: filterYoloArgs(agent.args || [], agent),
								prompt,
								agentSessionId: resumeAgentSessionId,
								sessionConfig,
								sessionSshRemoteConfig: effectiveSessionSshRemoteConfig,
								sendPromptViaStdin,
								sendPromptViaStdinRaw,
							})
						)
						.catch((error: unknown) => resolveOnce(classifySpawnFailure(error)));
				});
			} catch (error) {
				logger.error('Error spawning background synopsis:', undefined, error);
				return classifySpawnFailure(error);
			}
		},
		[accumulateUsageStats, sessionsRef]
	);

	/**
	 * Cancel all pending synopsis processes for a given maestro session ID.
	 * Called when user clicks Stop to prevent synopsis from running after interruption.
	 */
	const cancelPendingSynopsis = useCallback(async (maestroSessionId: string): Promise<void> => {
		const synopsisRuns = activeSynopsisSessionsRef.current.get(maestroSessionId);
		if (!synopsisRuns?.size) return;

		logger.info('[cancelPendingSynopsis] Cancelling synopsis sessions for', undefined, [
			maestroSessionId,
			{ count: synopsisRuns.size, sessionIds: Array.from(synopsisRuns.keys()) },
		]);

		// The run owns both its kill and its listener cleanup. Snapshotting the
		// callbacks prevents map mutation during cleanup from skipping a sibling.
		for (const cancel of Array.from(synopsisRuns.values())) cancel();
	}, []);

	/** Emits a 2-second yellow center flash through the shared timer owner. */
	const showFlashNotification = useCallback((message: string) => {
		notifyCenterFlash({ message, color: 'yellow', duration: 2000 });
	}, []);

	/** Emits a 2-second themed center flash through the shared timer owner. */
	const showSuccessFlash = useCallback((message: string) => {
		notifyCenterFlash({ message, color: 'theme', duration: 2000 });
	}, []);

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
