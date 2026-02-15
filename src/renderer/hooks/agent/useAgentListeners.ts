/**
 * useAgentListeners - Extracts IPC process event listeners from App.tsx
 *
 * This hook registers all window.maestro.process.onXxx listeners that route
 * agent lifecycle events (data, exit, error, usage, etc.) to the correct
 * session and tab state. It's a direct extraction of the ~1500-line useEffect
 * that previously lived in App.tsx (lines 1970-3493).
 *
 * Design decisions:
 * - Reads sessionStore directly (no sessionsRef proxy needed)
 * - Reads modalStore directly for openModal('agentError', ...)
 * - Imports utility functions directly (parseSessionId, estimateContextUsage, etc.)
 * - Owns thinkingChunkBuffer/RAF refs internally (only used here)
 * - Receives callback refs from App.tsx for cross-cutting concerns (toasts, history, batch)
 * - Single useEffect with [] deps (runs once on mount, same as original)
 */

import { useEffect, useRef } from 'react';
import type {
	ToolType,
	SessionState,
	LogEntry,
	QueuedItem,
	BatchRunState,
	AgentError,
	GroupChatMessage,
	UsageStats,
	GlobalStats,
} from '../../types';
import type { Toast } from '../../contexts/ToastContext';
import type { HistoryEntryInput } from './useAgentSessionManagement';
import { useSessionStore } from '../../stores/sessionStore';
import { useModalStore } from '../../stores/modalStore';
import { gitService } from '../../services/git';
import { generateId } from '../../utils/ids';
import {
	parseSessionId,
	parseGroupChatSessionId,
	isSynopsisSession,
	isBatchSession,
} from '../../utils/sessionIdParser';
import {
	estimateContextUsage,
	estimateAccumulatedGrowth,
	DEFAULT_CONTEXT_WINDOWS,
} from '../../utils/contextUsage';
import { isLikelyConcatenatedToolNames, getSlashCommandDescription } from '../../constants/app';
import { getActiveTab, getWriteModeTab } from '../../utils/tabHelpers';
import { formatRelativeTime } from '../../../shared/formatters';
import { parseSynopsis } from '../../../shared/synopsis';
import { autorunSynopsisPrompt } from '../../../prompts';
import type { RightPanelHandle } from '../../components/RightPanel';
import { useGroupChatStore } from '../../stores/groupChatStore';

// ============================================================================
// Types
// ============================================================================

/** Batched updater interface (subset used by IPC listeners) */
export interface BatchedUpdater {
	appendLog: (
		sessionId: string,
		tabId: string | null,
		isAi: boolean,
		data: string,
		isStderr?: boolean
	) => void;
	markDelivered: (sessionId: string, tabId: string) => void;
	markUnread: (sessionId: string, tabId: string, unread: boolean) => void;
	updateUsage: (sessionId: string, tabId: string | null, usage: UsageStats) => void;
	updateContextUsage: (sessionId: string, percentage: number) => void;
	updateCycleBytes: (sessionId: string, bytes: number) => void;
	updateCycleTokens: (sessionId: string, tokens: number) => void;
}

/** Dependencies passed from App.tsx to the hook */
export interface UseAgentListenersDeps {
	/** Batched updater for high-frequency log/usage updates */
	batchedUpdater: BatchedUpdater;

	// --- Callback refs (populated after hook call, read in useEffect) ---

	/** Toast notification callback */
	addToastRef: React.RefObject<((toast: Omit<Toast, 'id' | 'timestamp'>) => void) | null>;
	/** History entry callback (from useAgentSessionManagement) */
	addHistoryEntryRef: React.RefObject<((entry: HistoryEntryInput) => Promise<void>) | null>;
	/** Background synopsis spawner (from useAgentExecution) */
	spawnBackgroundSynopsisRef: React.RefObject<
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
		  ) => Promise<{
				success: boolean;
				response?: string;
				agentSessionId?: string;
				usageStats?: UsageStats;
		  }>)
		| null
	>;
	/** Batch state lookup for Auto Run integration */
	getBatchStateRef: React.RefObject<((sessionId: string) => BatchRunState) | null>;
	/** Pause batch on error for Auto Run integration */
	pauseBatchOnErrorRef: React.RefObject<
		((sessionId: string, error: AgentError, docIndex: number, context?: string) => void) | null
	>;
	/** Global stats updater */
	updateGlobalStatsRef: React.RefObject<((stats: Partial<GlobalStats>) => void) | null>;
	/** Right panel ref for refreshing history */
	rightPanelRef: React.RefObject<RightPanelHandle | null>;
	/** Process queued item callback */
	processQueuedItemRef: React.RefObject<
		((sessionId: string, item: QueuedItem) => Promise<void>) | null
	>;

	// --- Settings ---

	/** Yellow threshold for context warning (from contextManagementSettings) */
	contextWarningYellowThreshold: number;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Get a human-readable title for an agent error type.
 * Used for toast notifications and history entries.
 */
export function getErrorTitleForType(type: AgentError['type']): string {
	switch (type) {
		case 'auth_expired':
			return 'Authentication Required';
		case 'token_exhaustion':
			return 'Context Limit Reached';
		case 'rate_limited':
			return 'Rate Limit Exceeded';
		case 'network_error':
			return 'Connection Error';
		case 'agent_crashed':
			return 'Agent Error';
		case 'permission_denied':
			return 'Permission Denied';
		case 'session_not_found':
			return 'Session Not Found';
		default:
			return 'Error';
	}
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Registers all IPC process event listeners for agent lifecycle management.
 *
 * Handles: onData, onExit, onSessionId, onSlashCommands, onStderr,
 * onCommandExit, onUsage, onAgentError, onThinkingChunk, onSshRemote,
 * onToolExecution.
 *
 * Call once in App.tsx. Empty dependency array — runs on mount, cleans up on unmount.
 */
export function useAgentListeners(deps: UseAgentListenersDeps): void {
	// Internal refs — only used by IPC listeners, not needed outside this hook
	const thinkingChunkBufferRef = useRef<Map<string, string>>(new Map());
	const thinkingChunkRafIdRef = useRef<number | null>(null);

	useEffect(() => {
		// Copy ref value to local variable for cleanup (React ESLint rule)
		const thinkingChunkBuffer = thinkingChunkBufferRef.current;

		// Stable references from stores (Zustand actions are referentially stable)
		const setSessions = useSessionStore.getState().setSessions;
		const { openModal } = useModalStore.getState();

		// Shorthand for reading current state (always fresh — called per-event)
		const getSessions = () => useSessionStore.getState().sessions;
		const getGroups = () => useSessionStore.getState().groups;
		const getActiveSessionId = () => useSessionStore.getState().activeSessionId;

		// ================================================================
		// onData — Handle process output data (BATCHED for performance)
		// ================================================================
		const unsubscribeData = window.maestro.process.onData((sessionId: string, data: string) => {
			// Parse sessionId to determine which process this is from
			let actualSessionId: string;
			let isFromAi: boolean;
			let tabIdFromSession: string | undefined;

			// Format: sessionId-ai-tabId
			const aiTabMatch = sessionId.match(/^(.+)-ai-(.+)$/);
			if (aiTabMatch) {
				actualSessionId = aiTabMatch[1];
				tabIdFromSession = aiTabMatch[2];
				isFromAi = true;
			} else if (sessionId.endsWith('-terminal')) {
				return;
			} else if (sessionId.includes('-batch-')) {
				return;
			} else {
				actualSessionId = sessionId;
				isFromAi = false;
			}

			// Filter out empty stdout for terminal commands
			if (!isFromAi && !data.trim()) return;

			// For terminal output, use batched append to shell logs
			if (!isFromAi) {
				deps.batchedUpdater.appendLog(actualSessionId, null, false, data);
				return;
			}

			// For AI output, determine target tab ID
			let targetTabId = tabIdFromSession;
			if (!targetTabId) {
				const session = getSessions().find((s) => s.id === actualSessionId);
				if (session) {
					const targetTab = getWriteModeTab(session) || getActiveTab(session);
					if (targetTab) {
						targetTabId = targetTab.id;
					}
				}
			}

			if (!targetTabId) {
				console.error(
					'[onData] No target tab found - session has no aiTabs, this should not happen'
				);
				return;
			}

			// Batch the log append, delivery mark, unread mark, and byte tracking
			deps.batchedUpdater.appendLog(actualSessionId, targetTabId, true, data);
			deps.batchedUpdater.markDelivered(actualSessionId, targetTabId);
			deps.batchedUpdater.updateCycleBytes(actualSessionId, data.length);

			// Clear error state if session had an error but is now receiving successful data
			const sessionForErrorCheck = getSessions().find((s) => s.id === actualSessionId);
			if (sessionForErrorCheck?.agentError) {
				setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== actualSessionId) return s;
						const updatedAiTabs = s.aiTabs.map((tab) =>
							tab.id === targetTabId ? { ...tab, agentError: undefined } : tab
						);
						return {
							...s,
							agentError: undefined,
							agentErrorTabId: undefined,
							agentErrorPaused: false,
							state: 'busy' as SessionState,
							aiTabs: updatedAiTabs,
						};
					})
				);
				window.maestro.agentError.clearError(actualSessionId).catch((err) => {
					console.error('Failed to clear agent error on successful data:', err);
				});
			}

			// Determine if tab should be marked as unread
			const session = getSessions().find((s) => s.id === actualSessionId);
			if (session) {
				const targetTab = session.aiTabs?.find((t) => t.id === targetTabId);
				if (targetTab) {
					const isTargetTabActive = targetTab.id === session.activeTabId;
					const isThisSessionActive = session.id === getActiveSessionId();
					const isUserAtBottom = targetTab.isAtBottom !== false;
					const shouldMarkUnread = !isTargetTabActive || !isThisSessionActive || !isUserAtBottom;
					deps.batchedUpdater.markUnread(actualSessionId, targetTabId, shouldMarkUnread);
				}
			}
		});

		// ================================================================
		// onExit — Handle process exit
		// ================================================================
		const unsubscribeExit = window.maestro.process.onExit(
			async (sessionId: string, code: number) => {
				console.log('[onExit] Process exit event received:', {
					rawSessionId: sessionId,
					exitCode: code,
					timestamp: new Date().toISOString(),
				});

				let actualSessionId: string;
				let isFromAi: boolean;
				let tabIdFromSession: string | undefined;

				const aiTabMatch = sessionId.match(/^(.+)-ai-(.+)$/);
				if (aiTabMatch) {
					actualSessionId = aiTabMatch[1];
					tabIdFromSession = aiTabMatch[2];
					isFromAi = true;
				} else if (sessionId.endsWith('-terminal')) {
					actualSessionId = sessionId.slice(0, -9);
					isFromAi = false;
				} else if (sessionId.includes('-batch-')) {
					return;
				} else {
					actualSessionId = sessionId;
					isFromAi = false;
				}

				// SAFETY CHECK: Verify the process is actually gone
				if (isFromAi) {
					try {
						const activeProcesses = await window.maestro.process.getActiveProcesses();
						const processStillRunning = activeProcesses.some((p) => p.sessionId === sessionId);
						if (processStillRunning) {
							console.warn('[onExit] Process still running despite exit event, ignoring:', {
								sessionId,
								activeProcesses: activeProcesses.map((p) => p.sessionId),
							});
							return;
						}
					} catch (error) {
						console.error('[onExit] Failed to verify process status:', error);
					}
				}

				// For AI exits, gather toast data BEFORE state update
				let toastData: {
					title: string;
					summary: string;
					groupName: string;
					projectName: string;
					duration: number;
					agentSessionId?: string;
					tabName?: string;
					usageStats?: UsageStats;
					prompt?: string;
					response?: string;
					sessionSizeKB?: string;
					sessionId?: string;
					tabId?: string;
					agentType?: string;
					projectPath?: string;
					startTime?: number;
					isRemote?: boolean;
				} | null = null;
				let queuedItemToProcess: {
					sessionId: string;
					item: QueuedItem;
				} | null = null;
				let synopsisData: {
					sessionId: string;
					cwd: string;
					agentSessionId: string;
					command: string;
					groupName: string;
					projectName: string;
					tabName?: string;
					tabId?: string;
					lastSynopsisTime?: number;
					taskDuration?: number;
					toolType?: ToolType;
					sessionConfig?: {
						customPath?: string;
						customArgs?: string;
						customEnvVars?: Record<string, string>;
						customModel?: string;
						customContextWindow?: number;
					};
				} | null = null;

				if (isFromAi) {
					const currentSession = getSessions().find((s) => s.id === actualSessionId);
					if (currentSession) {
						if (
							currentSession.executionQueue.length > 0 &&
							!(currentSession.state === 'error' && currentSession.agentError)
						) {
							queuedItemToProcess = {
								sessionId: actualSessionId,
								item: currentSession.executionQueue[0],
							};
						}

						const completedTab = tabIdFromSession
							? currentSession.aiTabs?.find((tab) => tab.id === tabIdFromSession)
							: getActiveTab(currentSession);
						const logs = completedTab?.logs || [];
						const lastUserLog = logs.filter((log) => log.source === 'user').pop();
						const lastAiLog = logs
							.filter((log) => log.source === 'stdout' || log.source === 'ai')
							.pop();
						const completedTabData = currentSession.aiTabs?.find(
							(tab) => tab.id === tabIdFromSession
						);
						const duration = completedTabData?.thinkingStartTime
							? Date.now() - completedTabData.thinkingStartTime
							: currentSession.thinkingStartTime
								? Date.now() - currentSession.thinkingStartTime
								: 0;

						const sessionSizeBytes = logs.reduce((sum, log) => sum + (log.text?.length || 0), 0);
						const sessionSizeKB = (sessionSizeBytes / 1024).toFixed(1);

						const sessionGroup = currentSession.groupId
							? getGroups().find((g) => g.id === currentSession.groupId)
							: null;
						const groupName = sessionGroup?.name || 'Ungrouped';
						const projectName =
							currentSession.name || currentSession.cwd.split('/').pop() || 'Unknown';

						let title = 'Task Complete';
						if (lastUserLog?.text) {
							const userText = lastUserLog.text.trim();
							title = userText.length > 50 ? userText.substring(0, 47) + '...' : userText;
						}

						let summary = '';
						if (lastAiLog?.text) {
							const text = lastAiLog.text.trim();
							if (text.length > 10) {
								const sentences = text.match(/[^.!?\n]+[.!?]+/g) || [];
								const fillerPattern =
									/^(excellent|perfect|great|awesome|wonderful|fantastic|good|nice|cool|done|ok|okay|alright|sure|yes|yeah|absolutely|certainly|definitely|looks?\s+good|all\s+(set|done|ready)|got\s+it|understood|will\s+do|on\s+it|no\s+problem|no\s+worries|happy\s+to\s+help)[!.\s]*$/i;
								const meaningfulSentence = sentences.find((s) => !fillerPattern.test(s.trim()));
								const firstSentence = meaningfulSentence?.trim() || text.substring(0, 120);
								summary =
									firstSentence.length < text.length
										? firstSentence
										: text.substring(0, 120) + (text.length > 120 ? '...' : '');
							}
						}
						if (!summary) {
							summary = 'Completed successfully';
						}

						const agentSessionId = completedTab?.agentSessionId || currentSession.agentSessionId;
						const tabName =
							completedTab?.name ||
							(agentSessionId ? agentSessionId.substring(0, 8).toUpperCase() : undefined);

						toastData = {
							title,
							summary,
							groupName,
							projectName,
							duration,
							agentSessionId: agentSessionId || undefined,
							tabName,
							usageStats: currentSession.usageStats,
							prompt: lastUserLog?.text,
							response: lastAiLog?.text,
							sessionSizeKB,
							sessionId: actualSessionId,
							tabId: completedTab?.id,
							agentType: currentSession.toolType,
							projectPath: currentSession.cwd,
							startTime: completedTabData?.thinkingStartTime || currentSession.thinkingStartTime,
							isRemote: !!(
								currentSession.sshRemoteId || currentSession.sessionSshRemoteConfig?.enabled
							),
						};

						const shouldSynopsis =
							currentSession.executionQueue.length === 0 &&
							(completedTab?.agentSessionId || currentSession.agentSessionId) &&
							(completedTab?.saveToHistory || currentSession.pendingAICommandForSynopsis);

						if (shouldSynopsis) {
							synopsisData = {
								sessionId: actualSessionId,
								cwd: currentSession.cwd,
								agentSessionId: completedTab?.agentSessionId || currentSession.agentSessionId!,
								command: currentSession.pendingAICommandForSynopsis || 'Save to History',
								groupName,
								projectName,
								tabName,
								tabId: completedTab?.id,
								lastSynopsisTime: completedTab?.lastSynopsisTime,
								taskDuration: duration,
								toolType: currentSession.toolType,
								sessionConfig: {
									customPath: currentSession.customPath,
									customArgs: currentSession.customArgs,
									customEnvVars: currentSession.customEnvVars,
									customModel: currentSession.customModel,
									customContextWindow: currentSession.customContextWindow,
								},
							};
						}
					}
				}

				// Update state (pure function - no side effects)
				setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== actualSessionId) return s;

						if (isFromAi) {
							if (s.state === 'error' && s.agentError) {
								const updatedAiTabs =
									s.aiTabs?.length > 0
										? s.aiTabs.map((tab) => {
												if (tabIdFromSession) {
													return tab.id === tabIdFromSession
														? {
																...tab,
																state: 'idle' as const,
																thinkingStartTime: undefined,
															}
														: tab;
												} else {
													return tab.state === 'busy'
														? {
																...tab,
																state: 'idle' as const,
																thinkingStartTime: undefined,
															}
														: tab;
												}
											})
										: s.aiTabs;

								return {
									...s,
									state: 'error' as SessionState,
									busySource: undefined,
									thinkingStartTime: undefined,
									aiTabs: updatedAiTabs,
								};
							}

							if (s.executionQueue.length > 0) {
								const [nextItem, ...remainingQueue] = s.executionQueue;

								const targetTab =
									s.aiTabs.find((tab) => tab.id === nextItem.tabId) || getActiveTab(s);

								if (!targetTab) {
									return {
										...s,
										state: 'busy' as SessionState,
										busySource: 'ai',
										executionQueue: remainingQueue,
										thinkingStartTime: Date.now(),
										currentCycleTokens: 0,
										currentCycleBytes: 0,
									};
								}

								let updatedAiTabs = s.aiTabs.map((tab) => {
									if (tab.id === targetTab.id) {
										return {
											...tab,
											state: 'busy' as const,
											thinkingStartTime: Date.now(),
										};
									}
									if (tabIdFromSession && tab.id === tabIdFromSession) {
										return {
											...tab,
											state: 'idle' as const,
										};
									}
									return tab;
								});

								if (nextItem.type === 'message' && nextItem.text) {
									const logEntry: LogEntry = {
										id: generateId(),
										timestamp: Date.now(),
										source: 'user',
										text: nextItem.text,
										images: nextItem.images,
									};
									updatedAiTabs = updatedAiTabs.map((tab) =>
										tab.id === targetTab.id
											? {
													...tab,
													logs: [...tab.logs, logEntry],
												}
											: tab
									);
								}

								return {
									...s,
									state: 'busy' as SessionState,
									busySource: 'ai',
									aiTabs: updatedAiTabs,
									executionQueue: remainingQueue,
									thinkingStartTime: Date.now(),
									currentCycleTokens: 0,
									currentCycleBytes: 0,
								};
							}

							const updatedAiTabs =
								s.aiTabs?.length > 0
									? s.aiTabs.map((tab) => {
											if (tabIdFromSession) {
												return tab.id === tabIdFromSession
													? {
															...tab,
															state: 'idle' as const,
															thinkingStartTime: undefined,
														}
													: tab;
											} else {
												return tab.state === 'busy'
													? {
															...tab,
															state: 'idle' as const,
															thinkingStartTime: undefined,
														}
													: tab;
											}
										})
									: s.aiTabs;

							const anyTabStillBusy = updatedAiTabs.some((tab) => tab.state === 'busy');
							const newState =
								s.state === 'error' && s.agentError
									? ('error' as SessionState)
									: anyTabStillBusy
										? ('busy' as SessionState)
										: ('idle' as SessionState);
							const newBusySource = anyTabStillBusy ? s.busySource : undefined;

							console.log('[onExit] Session state transition:', {
								sessionId: s.id.substring(0, 8),
								tabIdFromSession: tabIdFromSession?.substring(0, 8),
								previousState: s.state,
								newState,
								previousBusySource: s.busySource,
								newBusySource,
								anyTabStillBusy,
								tabStates: updatedAiTabs.map((t) => ({
									id: t.id.substring(0, 8),
									state: t.state,
								})),
							});

							return {
								...s,
								state: newState,
								busySource: newBusySource,
								thinkingStartTime: anyTabStillBusy ? s.thinkingStartTime : undefined,
								pendingAICommandForSynopsis: undefined,
								aiTabs: updatedAiTabs,
							};
						}

						// Terminal exit
						const exitLog: LogEntry = {
							id: generateId(),
							timestamp: Date.now(),
							source: 'system',
							text: `Terminal process exited with code ${code}`,
						};

						const anyAiTabBusy = s.aiTabs?.some((tab) => tab.state === 'busy') || false;

						return {
							...s,
							state: anyAiTabBusy ? s.state : ('idle' as SessionState),
							busySource: anyAiTabBusy ? s.busySource : undefined,
							shellLogs: [...s.shellLogs, exitLog],
						};
					})
				);

				// Refresh git branches/tags after terminal command completes
				if (!isFromAi) {
					const currentSession = getSessions().find((s) => s.id === actualSessionId);
					if (currentSession?.isGitRepo) {
						const userLogs = currentSession.shellLogs.filter((log) => log.source === 'user');
						const lastCommand = userLogs[userLogs.length - 1]?.text?.trim().toLowerCase() || '';

						const gitRefCommands = [
							'git branch',
							'git checkout',
							'git switch',
							'git fetch',
							'git pull',
							'git tag',
							'git merge',
							'git rebase',
							'git reset',
						];
						const shouldRefresh = gitRefCommands.some((cmd) => lastCommand.startsWith(cmd));

						if (shouldRefresh) {
							(async () => {
								const sshRemoteId =
									currentSession.sshRemoteId ||
									currentSession.sessionSshRemoteConfig?.remoteId ||
									undefined;
								const [gitBranches, gitTags] = await Promise.all([
									gitService.getBranches(currentSession.cwd, sshRemoteId),
									gitService.getTags(currentSession.cwd, sshRemoteId),
								]);
								setSessions((prev) =>
									prev.map((s) =>
										s.id === actualSessionId
											? {
													...s,
													gitBranches,
													gitTags,
													gitRefsCacheTime: Date.now(),
												}
											: s
									)
								);
							})();
						}
					}
				}

				// Fire side effects AFTER state update
				if (toastData?.startTime && toastData?.agentType) {
					const sessionIdForStats = toastData.sessionId || actualSessionId;
					const isAutoRunQuery = deps.getBatchStateRef.current
						? deps.getBatchStateRef.current(sessionIdForStats).isRunning
						: false;

					window.maestro.stats
						.recordQuery({
							sessionId: sessionIdForStats,
							agentType: toastData.agentType,
							source: isAutoRunQuery ? 'auto' : 'user',
							startTime: toastData.startTime,
							duration: toastData.duration,
							projectPath: toastData.projectPath,
							tabId: toastData.tabId,
							isRemote: toastData.isRemote,
						})
						.catch((err) => {
							console.warn('[onProcessExit] Failed to record query stats:', err);
						});
				}

				if (queuedItemToProcess) {
					setTimeout(() => {
						deps.processQueuedItemRef.current?.(
							queuedItemToProcess!.sessionId,
							queuedItemToProcess!.item
						);
					}, 0);
				} else if (toastData) {
					setTimeout(() => {
						window.maestro.logger.log('info', 'Agent process completed', 'App', {
							agentSessionId: toastData!.agentSessionId,
							group: toastData!.groupName,
							project: toastData!.projectName,
							durationMs: toastData!.duration,
							sessionSizeKB: toastData!.sessionSizeKB,
							prompt:
								toastData!.prompt?.substring(0, 200) +
								(toastData!.prompt && toastData!.prompt.length > 200 ? '...' : ''),
							response:
								toastData!.response?.substring(0, 500) +
								(toastData!.response && toastData!.response.length > 500 ? '...' : ''),
							inputTokens: toastData!.usageStats?.inputTokens,
							outputTokens: toastData!.usageStats?.outputTokens,
							cacheReadTokens: toastData!.usageStats?.cacheReadInputTokens,
							totalCostUsd: toastData!.usageStats?.totalCostUsd,
						});

						const currentActiveSession = getSessions().find((s) => s.id === getActiveSessionId());
						const isViewingCompletedTab =
							currentActiveSession?.id === actualSessionId &&
							(!tabIdFromSession || currentActiveSession.activeTabId === tabIdFromSession);

						if (!isViewingCompletedTab) {
							deps.addToastRef.current?.({
								type: 'success',
								title: toastData!.title,
								message: toastData!.summary,
								group: toastData!.groupName,
								project: toastData!.projectName,
								taskDuration: toastData!.duration,
								agentSessionId: toastData!.agentSessionId,
								tabName: toastData!.tabName,
								sessionId: toastData!.sessionId,
								tabId: toastData!.tabId,
							});
						}
					}, 0);
				}

				// Run synopsis in parallel if this was a custom AI command
				if (
					synopsisData &&
					deps.spawnBackgroundSynopsisRef.current &&
					deps.addHistoryEntryRef.current
				) {
					let SYNOPSIS_PROMPT: string;
					if (synopsisData.lastSynopsisTime) {
						const timeAgo = formatRelativeTime(synopsisData.lastSynopsisTime);
						SYNOPSIS_PROMPT = `${autorunSynopsisPrompt}\n\nIMPORTANT: Only synopsize work done since the last synopsis (${timeAgo}). Do not repeat previous work.`;
					} else {
						SYNOPSIS_PROMPT = autorunSynopsisPrompt;
					}
					const startTime = Date.now();
					const synopsisTime = Date.now();

					deps.spawnBackgroundSynopsisRef
						.current(
							synopsisData.sessionId,
							synopsisData.cwd,
							synopsisData.agentSessionId,
							SYNOPSIS_PROMPT,
							synopsisData.toolType,
							synopsisData.sessionConfig
						)
						.then((result) => {
							const duration = Date.now() - startTime;

							if (result.success && result.response && deps.addHistoryEntryRef.current) {
								const parsed = parseSynopsis(result.response);

								if (parsed.nothingToReport) {
									console.log(
										'[onProcessExit] Synopsis returned NOTHING_TO_REPORT - skipping history entry',
										{
											sessionId: synopsisData!.sessionId,
											agentSessionId: synopsisData!.agentSessionId,
										}
									);
									return;
								}

								deps.addHistoryEntryRef.current({
									type: 'USER',
									summary: parsed.shortSummary,
									fullResponse: parsed.fullSynopsis,
									agentSessionId: synopsisData!.agentSessionId,
									usageStats: result.usageStats,
									sessionId: synopsisData!.sessionId,
									projectPath: synopsisData!.cwd,
									sessionName: synopsisData!.tabName,
									elapsedTimeMs: synopsisData!.taskDuration,
								});

								setSessions((prev) =>
									prev.map((s) => {
										if (s.id !== synopsisData!.sessionId) return s;
										return {
											...s,
											aiTabs: s.aiTabs.map((tab) => {
												if (tab.id !== synopsisData!.tabId) return tab;
												return {
													...tab,
													lastSynopsisTime: synopsisTime,
												};
											}),
										};
									})
								);

								deps.addToastRef.current?.({
									type: 'info',
									title: 'Synopsis',
									message: parsed.shortSummary,
									group: synopsisData!.groupName,
									project: synopsisData!.projectName,
									taskDuration: duration,
									sessionId: synopsisData!.sessionId,
									tabId: synopsisData!.tabId,
									tabName: synopsisData!.tabName,
									skipCustomNotification: true,
								});

								if (deps.rightPanelRef.current) {
									deps.rightPanelRef.current.refreshHistoryPanel();
								}
							} else if (!result.success) {
								console.warn(
									'[onProcessExit] Synopsis generation failed - no history entry created',
									{
										sessionId: synopsisData!.sessionId,
										agentSessionId: synopsisData!.agentSessionId,
										hasResponse: !!result.response,
									}
								);
							}
						})
						.catch((err) => {
							console.error('[onProcessExit] Synopsis failed:', err);
						});
				}
			}
		);

		// ================================================================
		// onSessionId — Handle Claude session ID capture
		// ================================================================
		const unsubscribeSessionId = window.maestro.process.onSessionId(
			async (sessionId: string, agentSessionId: string) => {
				if (isBatchSession(sessionId)) {
					return;
				}

				const parsed = parseSessionId(sessionId);
				const actualSessionId = parsed.actualSessionId;
				const tabId = parsed.tabId ?? undefined;

				setSessions((prev) => {
					const session = prev.find((s) => s.id === actualSessionId);
					if (!session) return prev;

					window.maestro.agentSessions
						.registerSessionOrigin(session.projectRoot, agentSessionId, 'user')
						.catch((err) => console.error('[onSessionId] Failed to register session origin:', err));

					return prev.map((s) => {
						if (s.id !== actualSessionId) return s;

						let targetTab;
						if (tabId) {
							targetTab = s.aiTabs?.find((tab) => tab.id === tabId);
						}

						if (!targetTab) {
							const awaitingTab = s.aiTabs?.find(
								(tab) => tab.awaitingSessionId && !tab.agentSessionId
							);
							targetTab = awaitingTab || getActiveTab(s);
						}

						if (!targetTab) {
							console.error(
								'[onSessionId] No target tab found - session has no aiTabs, storing at session level only'
							);
							return { ...s, agentSessionId };
						}

						if (targetTab.agentSessionId && targetTab.agentSessionId !== agentSessionId) {
							return s;
						}

						const updatedAiTabs = s.aiTabs.map((tab) => {
							if (tab.id !== targetTab.id) return tab;
							const newName = tab.name && tab.name !== 'New Session' ? tab.name : null;
							return {
								...tab,
								agentSessionId,
								awaitingSessionId: false,
								name: newName,
							};
						});

						return {
							...s,
							aiTabs: updatedAiTabs,
							agentSessionId,
						};
					});
				});
			}
		);

		// ================================================================
		// onSlashCommands — Handle slash commands from Claude Code init
		// ================================================================
		const unsubscribeSlashCommands = window.maestro.process.onSlashCommands(
			(sessionId: string, slashCommands: string[]) => {
				const actualSessionId = parseSessionId(sessionId).baseSessionId;

				const commands = slashCommands.map((cmd) => ({
					command: cmd.startsWith('/') ? cmd : `/${cmd}`,
					description: getSlashCommandDescription(cmd),
				}));

				setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== actualSessionId) return s;
						return { ...s, agentCommands: commands };
					})
				);
			}
		);

		// ================================================================
		// onStderr — Handle stderr from processes (BATCHED)
		// ================================================================
		const unsubscribeStderr = window.maestro.process.onStderr((sessionId: string, data: string) => {
			if (!data.trim()) return;

			let actualSessionId: string;
			let tabIdFromSession: string | undefined;
			let isFromAi = false;

			const aiTabMatch = sessionId.match(/^(.+)-ai-(.+)$/);
			if (aiTabMatch) {
				actualSessionId = aiTabMatch[1];
				tabIdFromSession = aiTabMatch[2];
				isFromAi = true;
			} else if (sessionId.includes('-batch-')) {
				return;
			} else {
				actualSessionId = sessionId;
			}

			if (isFromAi && tabIdFromSession) {
				deps.batchedUpdater.appendLog(actualSessionId, tabIdFromSession, true, data, true);
			} else {
				deps.batchedUpdater.appendLog(actualSessionId, null, false, data, true);
			}
		});

		// ================================================================
		// onCommandExit — Handle command exit from runCommand
		// ================================================================
		const unsubscribeCommandExit = window.maestro.process.onCommandExit(
			(sessionId: string, code: number) => {
				const actualSessionId = sessionId;

				setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== actualSessionId) return s;

						const anyAiTabBusy = s.aiTabs?.some((tab) => tab.state === 'busy') || false;

						const newState = anyAiTabBusy ? ('busy' as SessionState) : ('idle' as SessionState);
						const newBusySource = anyAiTabBusy ? ('ai' as const) : undefined;

						if (code !== 0) {
							const exitLog: LogEntry = {
								id: generateId(),
								timestamp: Date.now(),
								source: 'system',
								text: `Command exited with code ${code}`,
							};
							return {
								...s,
								state: newState,
								busySource: newBusySource,
								shellLogs: [...s.shellLogs, exitLog],
							};
						}

						return {
							...s,
							state: newState,
							busySource: newBusySource,
						};
					})
				);
			}
		);

		// ================================================================
		// onUsage — Handle usage statistics (BATCHED)
		// ================================================================
		const unsubscribeUsage = window.maestro.process.onUsage((sessionId: string, usageStats) => {
			const parsed = parseSessionId(sessionId);
			const { actualSessionId, tabId, baseSessionId } = parsed;

			const sessionForUsage = getSessions().find((s) => s.id === baseSessionId);
			const agentToolType = sessionForUsage?.toolType;
			const contextPercentage = estimateContextUsage(usageStats, agentToolType);

			deps.batchedUpdater.updateUsage(actualSessionId, tabId, usageStats);
			deps.batchedUpdater.updateUsage(actualSessionId, null, usageStats);
			if (contextPercentage !== null) {
				deps.batchedUpdater.updateContextUsage(actualSessionId, contextPercentage);
			} else {
				const currentUsage = sessionForUsage?.contextUsage ?? 0;
				if (currentUsage > 0) {
					const effectiveWindow =
						usageStats.contextWindow > 0
							? usageStats.contextWindow
							: agentToolType && agentToolType in DEFAULT_CONTEXT_WINDOWS
								? DEFAULT_CONTEXT_WINDOWS[agentToolType as keyof typeof DEFAULT_CONTEXT_WINDOWS]
								: 200000;
					const estimated = estimateAccumulatedGrowth(
						currentUsage,
						usageStats.outputTokens,
						usageStats.cacheReadInputTokens || 0,
						effectiveWindow
					);
					const yellowThreshold = deps.contextWarningYellowThreshold;
					const maxEstimate = yellowThreshold - 5;
					deps.batchedUpdater.updateContextUsage(actualSessionId, Math.min(estimated, maxEstimate));
				}
			}
			deps.batchedUpdater.updateCycleTokens(actualSessionId, usageStats.outputTokens);

			deps.updateGlobalStatsRef.current?.({
				totalInputTokens: usageStats.inputTokens,
				totalOutputTokens: usageStats.outputTokens,
				totalCacheReadTokens: usageStats.cacheReadInputTokens,
				totalCacheCreationTokens: usageStats.cacheCreationInputTokens,
				totalCostUsd: usageStats.totalCostUsd,
			});
		});

		// ================================================================
		// onAgentError — Handle agent errors
		// ================================================================
		const unsubscribeAgentError = window.maestro.process.onAgentError(
			(sessionId: string, error) => {
				const agentError: AgentError = {
					type: error.type as AgentError['type'],
					message: error.message,
					recoverable: error.recoverable,
					agentId: error.agentId,
					sessionId: error.sessionId,
					timestamp: error.timestamp,
					raw: error.raw,
					parsedJson: error.parsedJson,
				};

				// Check if this is a group chat error
				const groupChatParsed = parseGroupChatSessionId(sessionId);
				if (groupChatParsed.isGroupChat) {
					const groupChatId = groupChatParsed.groupChatId!;
					const isModeratorError = groupChatParsed.isModerator ?? false;
					const participantOrModerator = isModeratorError
						? 'moderator'
						: groupChatParsed.participantName!;

					console.log('[onAgentError] Group chat error received:', {
						rawSessionId: sessionId,
						groupChatId,
						participantName: isModeratorError ? 'Moderator' : participantOrModerator,
						errorType: error.type,
						message: error.message,
						recoverable: error.recoverable,
					});

					if (agentError.type === 'session_not_found') {
						console.log(
							'[onAgentError] Suppressing session_not_found for group chat - exit-listener will handle recovery:',
							{
								groupChatId,
								participantName: isModeratorError ? 'Moderator' : participantOrModerator,
							}
						);
						return;
					}

					const gcStore = useGroupChatStore.getState();
					gcStore.setGroupChatError({
						groupChatId,
						error: agentError,
						participantName: isModeratorError ? 'Moderator' : participantOrModerator,
					});

					const errorMessage: GroupChatMessage = {
						timestamp: new Date(agentError.timestamp).toISOString(),
						from: 'system',
						content: `⚠️ ${
							isModeratorError ? 'Moderator' : participantOrModerator
						} error: ${agentError.message}`,
					};
					gcStore.setGroupChatMessages((prev) => [...prev, errorMessage]);

					gcStore.setGroupChatState('idle');
					gcStore.setGroupChatStates((prev) => {
						const next = new Map(prev);
						next.set(groupChatId, 'idle');
						return next;
					});
					return;
				}

				// Synopsis processes — ignore errors
				if (isSynopsisSession(sessionId)) {
					console.log('[onAgentError] Ignoring synopsis process error:', {
						rawSessionId: sessionId,
						errorType: error.type,
						message: error.message,
					});
					return;
				}

				const parsed = parseSessionId(sessionId);
				const actualSessionId = parsed.baseSessionId;
				const tabIdFromSession = parsed.tabId ?? undefined;

				console.log('[onAgentError] Agent error received:', {
					rawSessionId: sessionId,
					actualSessionId,
					errorType: error.type,
					message: error.message,
					recoverable: error.recoverable,
				});

				const isSessionNotFound = agentError.type === 'session_not_found';

				const errorLogEntry: LogEntry = {
					id: generateId(),
					timestamp: agentError.timestamp,
					source: isSessionNotFound ? 'system' : 'error',
					text: agentError.message,
					agentError: isSessionNotFound ? undefined : agentError,
				};

				setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== actualSessionId) return s;

						const targetTab = tabIdFromSession
							? s.aiTabs.find((tab) => tab.id === tabIdFromSession)
							: getActiveTab(s);
						const updatedAiTabs = targetTab
							? s.aiTabs.map((tab) =>
									tab.id === targetTab.id
										? {
												...tab,
												logs: [...tab.logs, errorLogEntry],
												agentError: isSessionNotFound ? undefined : agentError,
											}
										: tab
								)
							: s.aiTabs;

						if (isSessionNotFound) {
							return {
								...s,
								aiTabs: updatedAiTabs,
							};
						}

						return {
							...s,
							agentError,
							agentErrorTabId: targetTab?.id,
							agentErrorPaused: true,
							state: 'error' as SessionState,
							aiTabs: updatedAiTabs,
						};
					})
				);

				// Check if there's an active batch run and pause it
				if (deps.getBatchStateRef.current && deps.pauseBatchOnErrorRef.current) {
					const batchState = deps.getBatchStateRef.current(actualSessionId);
					if (batchState.isRunning && !batchState.errorPaused) {
						console.log('[onAgentError] Pausing active batch run due to error:', actualSessionId);
						const currentDoc = batchState.documents[batchState.currentDocumentIndex];
						deps.pauseBatchOnErrorRef.current(
							actualSessionId,
							agentError,
							batchState.currentDocumentIndex,
							currentDoc ? `Processing ${currentDoc}` : undefined
						);

						const session = getSessions().find((s) => s.id === actualSessionId);

						if (deps.addHistoryEntryRef.current && session) {
							const errorTitle = getErrorTitleForType(agentError.type);
							const errorExplanation = [
								`**Auto Run Error: ${errorTitle}**`,
								'',
								`Auto Run encountered an error while processing:`,
								currentDoc ? `- Document: ${currentDoc}` : '',
								`- Error: ${agentError.message}`,
								'',
								'**What to do:**',
								agentError.type === 'auth_expired'
									? '- Re-authenticate with the provider (e.g., run `claude login` in terminal)'
									: agentError.type === 'token_exhaustion'
										? '- Start a new session to reset the context window'
										: agentError.type === 'rate_limited'
											? '- Wait a few minutes before retrying'
											: agentError.type === 'network_error'
												? '- Check your internet connection and try again'
												: '- Review the error message and take appropriate action',
								'',
								'After resolving the issue, you can resume, skip, or abort the Auto Run.',
							]
								.filter(Boolean)
								.join('\n');

							deps.addHistoryEntryRef.current({
								type: 'AUTO',
								summary: `Auto Run error: ${errorTitle}${currentDoc ? ` (${currentDoc})` : ''}`,
								fullResponse: errorExplanation,
								projectPath: session.cwd,
								sessionId: actualSessionId,
								success: false,
							});
						}

						if (deps.addToastRef.current) {
							const errorTitle = getErrorTitleForType(agentError.type);
							deps.addToastRef.current({
								type: 'error',
								title: `Auto Run: ${errorTitle}`,
								message: agentError.message,
								sessionId: actualSessionId,
							});
						}
					}
				}

				// Show the error modal (skip for informational session_not_found)
				if (!isSessionNotFound) {
					openModal('agentError', { sessionId: actualSessionId });
				}
			}
		);

		// ================================================================
		// onThinkingChunk — Handle thinking/streaming content (RAF-throttled)
		// ================================================================
		const unsubscribeThinkingChunk = window.maestro.process.onThinkingChunk?.(
			(sessionId: string, content: string) => {
				const aiTabMatch = sessionId.match(/^(.+)-ai-(.+)$/);
				if (!aiTabMatch) return;

				const actualSessionId = aiTabMatch[1];
				const tabId = aiTabMatch[2];
				const bufferKey = `${actualSessionId}:${tabId}`;

				const existingContent = thinkingChunkBufferRef.current.get(bufferKey) || '';
				thinkingChunkBufferRef.current.set(bufferKey, existingContent + content);

				if (thinkingChunkRafIdRef.current === null) {
					thinkingChunkRafIdRef.current = requestAnimationFrame(() => {
						const buffer = thinkingChunkBufferRef.current;
						if (buffer.size === 0) {
							thinkingChunkRafIdRef.current = null;
							return;
						}

						const chunksToProcess = new Map(buffer);
						buffer.clear();
						thinkingChunkRafIdRef.current = null;

						setSessions((prev) =>
							prev.map((s) => {
								let hasChanges = false;
								for (const [key] of chunksToProcess) {
									if (key.startsWith(s.id + ':')) {
										hasChanges = true;
										break;
									}
								}
								if (!hasChanges) return s;

								let updatedTabs = s.aiTabs;
								for (const [key, bufferedContent] of chunksToProcess) {
									const [chunkSessionId, chunkTabId] = key.split(':');
									if (chunkSessionId !== s.id) continue;

									const targetTab = updatedTabs.find((t) => t.id === chunkTabId);
									if (!targetTab) continue;

									if (!targetTab.showThinking || targetTab.showThinking === 'off') continue;

									if (isLikelyConcatenatedToolNames(bufferedContent)) {
										console.warn(
											'[App] Skipping malformed thinking chunk (concatenated tool names):',
											bufferedContent.substring(0, 100)
										);
										continue;
									}

									const lastLog = targetTab.logs[targetTab.logs.length - 1];
									if (lastLog?.source === 'thinking') {
										const combinedText = lastLog.text + bufferedContent;
										if (isLikelyConcatenatedToolNames(combinedText)) {
											console.warn(
												'[App] Detected malformed thinking content, replacing instead of appending'
											);
											updatedTabs = updatedTabs.map((tab) =>
												tab.id === chunkTabId
													? {
															...tab,
															logs: [
																...tab.logs.slice(0, -1),
																{
																	...lastLog,
																	text: bufferedContent,
																},
															],
														}
													: tab
											);
										} else {
											updatedTabs = updatedTabs.map((tab) =>
												tab.id === chunkTabId
													? {
															...tab,
															logs: [
																...tab.logs.slice(0, -1),
																{
																	...lastLog,
																	text: combinedText,
																},
															],
														}
													: tab
											);
										}
									} else {
										const newLog: LogEntry = {
											id: generateId(),
											timestamp: Date.now(),
											source: 'thinking',
											text: bufferedContent,
										};
										updatedTabs = updatedTabs.map((tab) =>
											tab.id === chunkTabId
												? {
														...tab,
														logs: [...tab.logs, newLog],
													}
												: tab
										);
									}
								}

								return updatedTabs === s.aiTabs ? s : { ...s, aiTabs: updatedTabs };
							})
						);
					});
				}
			}
		);

		// ================================================================
		// onSshRemote — Handle SSH remote status events
		// ================================================================
		const unsubscribeSshRemote = window.maestro.process.onSshRemote?.(
			(sessionId: string, sshRemote: { id: string; name: string; host: string } | null) => {
				let actualSessionId: string;
				const aiTabMatch = sessionId.match(/^(.+)-ai-(.+)$/);
				if (aiTabMatch) {
					actualSessionId = aiTabMatch[1];
				} else if (sessionId.endsWith('-ai') || sessionId.endsWith('-terminal')) {
					actualSessionId = sessionId.replace(/-ai$|-terminal$/, '');
				} else {
					actualSessionId = sessionId;
				}

				setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== actualSessionId) return s;
						const currentRemoteId = s.sshRemote?.id;
						const newRemoteId = sshRemote?.id;
						if (currentRemoteId === newRemoteId) return s;
						return {
							...s,
							sshRemote: sshRemote ?? undefined,
							sshRemoteId: sshRemote?.id,
						};
					})
				);

				if (sshRemote?.id) {
					const session = getSessions().find((s) => s.id === actualSessionId);
					if (session && !session.isGitRepo) {
						const remoteCwd = session.sessionSshRemoteConfig?.workingDirOverride || session.cwd;
						(async () => {
							try {
								const isGitRepo = await gitService.isRepo(remoteCwd, sshRemote.id);
								if (isGitRepo) {
									const [gitBranches, gitTags] = await Promise.all([
										gitService.getBranches(remoteCwd, sshRemote.id),
										gitService.getTags(remoteCwd, sshRemote.id),
									]);
									const gitRefsCacheTime = Date.now();

									setSessions((prev) =>
										prev.map((s) => {
											if (s.id !== actualSessionId) return s;
											if (s.isGitRepo) return s;
											return {
												...s,
												isGitRepo: true,
												gitBranches,
												gitTags,
												gitRefsCacheTime,
											};
										})
									);
								}
							} catch (err) {
								console.error(`[SSH] Failed to check git repo status for ${actualSessionId}:`, err);
							}
						})();
					}
				}
			}
		);

		// ================================================================
		// onToolExecution — Handle tool execution events
		// ================================================================
		const unsubscribeToolExecution = window.maestro.process.onToolExecution?.(
			(
				sessionId: string,
				toolEvent: {
					toolName: string;
					state?: unknown;
					timestamp: number;
				}
			) => {
				const aiTabMatch = sessionId.match(/^(.+)-ai-(.+)$/);
				if (!aiTabMatch) return;

				const actualSessionId = aiTabMatch[1];
				const tabId = aiTabMatch[2];

				setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== actualSessionId) return s;

						const targetTab = s.aiTabs.find((t) => t.id === tabId);
						if (!targetTab?.showThinking || targetTab.showThinking === 'off') return s;

						const toolLog: LogEntry = {
							id: `tool-${Date.now()}-${toolEvent.toolName}`,
							timestamp: toolEvent.timestamp,
							source: 'tool',
							text: toolEvent.toolName,
							metadata: {
								toolState: toolEvent.state as NonNullable<LogEntry['metadata']>['toolState'],
							},
						};

						return {
							...s,
							aiTabs: s.aiTabs.map((tab) =>
								tab.id === tabId
									? {
											...tab,
											logs: [...tab.logs, toolLog],
										}
									: tab
							),
						};
					})
				);
			}
		);

		// ================================================================
		// Cleanup — unsubscribe all listeners on unmount
		// ================================================================
		return () => {
			unsubscribeData();
			unsubscribeExit();
			unsubscribeSessionId();
			unsubscribeSlashCommands();
			unsubscribeStderr();
			unsubscribeCommandExit();
			unsubscribeUsage();
			unsubscribeAgentError();
			unsubscribeThinkingChunk?.();
			unsubscribeSshRemote?.();
			unsubscribeToolExecution?.();
			// Cancel any pending thinking chunk RAF and clear buffer
			if (thinkingChunkRafIdRef.current !== null) {
				cancelAnimationFrame(thinkingChunkRafIdRef.current);
				thinkingChunkRafIdRef.current = null;
			}
			thinkingChunkBuffer.clear();
		};
	}, []);
}
