import { useCallback, useRef } from 'react';
import type {
	Session,
	SessionState,
	UsageStats,
	QueuedItem,
	LogEntry,
	ToolType,
} from '../../types';
import { getActiveTab } from '../../utils/tabHelpers';
import { generateId } from '../../utils/ids';

/**
 * Result from agent spawn operations.
 */
export interface AgentSpawnResult {
	success: boolean;
	response?: string;
	agentSessionId?: string;
	usageStats?: UsageStats;
}

/**
 * Dependencies for the useAgentExecution hook.
 */
export interface UseAgentExecutionDeps {
	/** Current active session (null if none selected) */
	activeSession: Session | null;
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
		cwdOverride?: string
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
		activeSession,
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
		async (sessionId: string, prompt: string, cwdOverride?: string): Promise<AgentSpawnResult> => {
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
					console.error(`[spawnAgentForSession] Agent not found for toolType: ${session.toolType}`);
					return { success: false };
				}

				// For batch processing, use a unique session ID per task run to avoid contaminating the main AI terminal
				// This prevents batch output from appearing in the interactive AI terminal
				const targetSessionId = `${sessionId}-batch-${Date.now()}`;

				// Note: We intentionally do NOT set the session or tab state to 'busy' here.
				// Batch operations run in isolation and should not affect the main UI state.
				// The batch progress is tracked separately via BatchRunState in useBatchProcessor.

				// Create a promise that resolves when the agent completes
				return new Promise((resolve) => {
					let agentSessionId: string | undefined;
					let responseText = '';
					let taskUsageStats: UsageStats | undefined;

					// Array to collect cleanup functions as listeners are registered
					const cleanupFns: (() => void)[] = [];

					const cleanup = () => {
						cleanupFns.forEach((fn) => fn());
					};

					// Set up listeners for this specific agent run
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

					// Capture usage stats for this specific task
					cleanupFns.push(
						window.maestro.process.onUsage((sid: string, usageStats) => {
							if (sid === targetSessionId) {
								// Accumulate usage stats for this task (there may be multiple usage events per task)
								taskUsageStats = accumulateUsageStats(taskUsageStats, usageStats);
							}
						})
					);

					cleanupFns.push(
						window.maestro.process.onExit((sid: string) => {
							if (sid === targetSessionId) {
								// Clean up listeners
								cleanup();

								// Check for queued items BEFORE updating state (using sessionsRef for latest state)
								const currentSession = sessionsRef.current.find((s) => s.id === sessionId);
								let queuedItemToProcess: { sessionId: string; item: QueuedItem } | null = null;
								const hasQueuedItems = currentSession && currentSession.executionQueue.length > 0;

								if (hasQueuedItems) {
									queuedItemToProcess = {
										sessionId: sessionId,
										item: currentSession!.executionQueue[0],
									};
								}

								// Update state - if there are queued items, keep busy and process next
								setSessions((prev) =>
									prev.map((s) => {
										if (s.id !== sessionId) return s;

										if (s.executionQueue.length > 0) {
											const [nextItem, ...remainingQueue] = s.executionQueue;
											const targetTab =
												s.aiTabs.find((tab) => tab.id === nextItem.tabId) || getActiveTab(s);

											if (!targetTab) {
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

											// For message items, add a log entry to the target tab
											let updatedAiTabs = s.aiTabs;
											if (nextItem.type === 'message' && nextItem.text) {
												const logEntry: LogEntry = {
													id: generateId(),
													timestamp: Date.now(),
													source: 'user',
													text: nextItem.text,
													images: nextItem.images,
												};
												updatedAiTabs = s.aiTabs.map((tab) =>
													tab.id === targetTab.id ? { ...tab, logs: [...tab.logs, logEntry] } : tab
												);
											}

											return {
												...s,
												state: 'busy' as SessionState,
												busySource: 'ai',
												aiTabs: updatedAiTabs,
												activeTabId: targetTab.id,
												executionQueue: remainingQueue,
												thinkingStartTime: Date.now(),
												currentCycleTokens: 0,
												currentCycleBytes: 0,
												pendingAICommandForSynopsis: undefined,
											};
										}

										// No queued items - set to idle
										// Set ALL busy tabs to 'idle' for write-mode tracking
										const updatedAiTabs =
											s.aiTabs?.length > 0
												? s.aiTabs.map((tab) =>
														tab.state === 'busy'
															? { ...tab, state: 'idle' as const, thinkingStartTime: undefined }
															: tab
													)
												: s.aiTabs;

										return {
											...s,
											state: 'idle' as SessionState,
											busySource: undefined,
											thinkingStartTime: undefined,
											pendingAICommandForSynopsis: undefined,
											aiTabs: updatedAiTabs,
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
										const checkSession = sessionsRef.current.find((s) => s.id === sessionId);
										if (
											!checkSession ||
											checkSession.state === 'idle' ||
											checkSession.executionQueue.length === 0
										) {
											// Queue drained or session idle - safe to continue batch
											resolve({
												success: true,
												response: responseText,
												agentSessionId,
												usageStats: taskUsageStats,
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
									resolve({
										success: true,
										response: responseText,
										agentSessionId,
										usageStats: taskUsageStats,
									});
								}
							}
						})
					);

					// Spawn the agent for batch processing
					// Use effectiveCwd which may be a worktree path for parallel execution
					const commandToUse = agent.path || agent.command;
					// Batch processing (Auto Run) should NOT use read-only mode - it needs to make changes
					window.maestro.process
						.spawn({
							sessionId: targetSessionId,
							toolType: session.toolType,
							cwd: effectiveCwd,
							command: commandToUse,
							args: agent.args || [],
							prompt,
							readOnlyMode: false, // Auto Run needs to make changes, not plan
							// Per-session config overrides (if set)
							sessionCustomPath: session.customPath,
							sessionCustomArgs: session.customArgs,
							sessionCustomEnvVars: session.customEnvVars,
							sessionCustomModel: session.customModel,
							sessionCustomContextWindow: session.customContextWindow,
							// Per-session SSH remote config (takes precedence over agent-level SSH config)
							sessionSshRemoteConfig: session.sessionSshRemoteConfig,
						})
						.catch(() => {
							cleanup();
							resolve({ success: false });
						});
				});
			} catch (error) {
				console.error('Error spawning agent:', error);
				return { success: false };
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
			if (!activeSession) return { success: false };
			return spawnAgentForSession(activeSession.id, prompt);
		},
		[activeSession, spawnAgentForSession]
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
				customContextWindow?: number;
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
					console.error(`[spawnBackgroundSynopsis] Agent not found for toolType: ${toolType}`);
					return { success: false };
				}

				// Use a unique target ID for background synopsis
				const targetSessionId = `${sessionId}-synopsis-${Date.now()}`;

				return new Promise((resolve) => {
					let agentSessionId: string | undefined;
					let responseText = '';
					let synopsisUsageStats: UsageStats | undefined;

					// Array to collect cleanup functions as listeners are registered
					const cleanupFns: (() => void)[] = [];

					const cleanup = () => {
						cleanupFns.forEach((fn) => fn());
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
							}
						})
					);

					cleanupFns.push(
						window.maestro.process.onExit((sid: string) => {
							if (sid === targetSessionId) {
								cleanup();
								resolve({
									success: true,
									response: responseText,
									agentSessionId,
									usageStats: synopsisUsageStats,
								});
							}
						})
					);

					// Spawn with session resume - the IPC handler will use the agent's resumeArgs builder
					const commandToUse = sessionConfig?.customPath || agent.path || agent.command;
					window.maestro.process
						.spawn({
							sessionId: targetSessionId,
							toolType,
							cwd,
							command: commandToUse,
							args: agent.args || [],
							prompt,
							agentSessionId: resumeAgentSessionId, // This triggers the agent's resume mechanism
							// Per-session config overrides (if set)
							sessionCustomPath: sessionConfig?.customPath,
							sessionCustomArgs: sessionConfig?.customArgs,
							sessionCustomEnvVars: sessionConfig?.customEnvVars,
							sessionCustomModel: sessionConfig?.customModel,
							sessionCustomContextWindow: sessionConfig?.customContextWindow,
							// Per-session SSH remote config (takes precedence over agent-level SSH config)
							sessionSshRemoteConfig: sessionConfig?.sessionSshRemoteConfig,
						})
						.catch(() => {
							cleanup();
							resolve({ success: false });
						});
				});
			} catch (error) {
				console.error('Error spawning background synopsis:', error);
				return { success: false };
			}
		},
		[accumulateUsageStats]
	);

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
	};
}
