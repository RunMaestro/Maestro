/**
 * useBatchHandlers — extracted from App.tsx (Phase 2I)
 *
 * Orchestrates batch/Auto Run processing by:
 *   - Initializing useBatchProcessor with configuration callbacks
 *   - Providing handler callbacks for stop, kill, skip, resume, abort
 *   - Managing refs for async batch state access (error handling, quit confirmation)
 *   - Computing memoized batch state for the UI
 *   - Owning the quit confirmation effect (prevents quit during active runs)
 *   - Providing handleSyncAutoRunStats for leaderboard server sync
 *
 * Reads from: sessionStore, settingsStore, modalStore
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import type {
	SessionState,
	LogEntry,
	BatchRunState,
	BatchRunConfig,
	QueuedItem,
	AgentError,
} from '../../types';
import { useSessionStore, selectActiveSession } from '../../stores/sessionStore';
import { useSettingsStore, selectIsLeaderboardRegistered } from '../../stores/settingsStore';
import { useModalStore, getModalActions } from '../../stores/modalStore';
import { notifyToast } from '../../stores/notificationStore';
import { CONDUCTOR_BADGES, getBadgeForTime } from '../../constants/conductorBadges';
import { getActiveTab } from '../../utils/tabHelpers';
import { generateId } from '../../utils/ids';
import { useBatchProcessor } from './useBatchProcessor';
import type { RightPanelHandle } from '../../components/RightPanel';
import type { AgentSpawnResult } from '../agent/useAgentExecution';
import * as Sentry from '@sentry/electron/renderer';

// ============================================================================
// Dependencies interface
// ============================================================================

export interface UseBatchHandlersDeps {
	/** Spawn an agent for a session (from useAgentExecution) */
	spawnAgentForSession: (
		sessionId: string,
		prompt: string,
		cwdOverride?: string
	) => Promise<AgentSpawnResult>;
	/** Ref to RightPanel for refreshing history after batch tasks */
	rightPanelRef: React.RefObject<RightPanelHandle | null>;
	/** Ref to processQueuedItem for processing queued messages after batch ends */
	processQueuedItemRef: React.MutableRefObject<
		((sessionId: string, item: QueuedItem) => Promise<void>) | null
	>;
	/** Clear agent error for a session (from useModalHandlers) */
	handleClearAgentError: (sessionId: string, tabId?: string) => void;
}

// ============================================================================
// Return type
// ============================================================================

export interface UseBatchHandlersReturn {
	/** Start a batch run for a session */
	startBatchRun: (sessionId: string, config: BatchRunConfig, folderPath: string) => Promise<void>;
	/** Get batch state for a specific session */
	getBatchState: (sessionId: string) => BatchRunState;
	/** Stop batch run with confirmation dialog */
	handleStopBatchRun: (targetSessionId?: string) => void;
	/** Force kill a batch run immediately */
	handleKillBatchRun: (sessionId: string) => Promise<void>;
	/** Skip the current errored document and continue */
	handleSkipCurrentDocument: () => void;
	/** Resume batch processing after an error */
	handleResumeAfterError: () => void;
	/** Abort the entire batch on unrecoverable error */
	handleAbortBatchOnError: () => void;
	/** Session IDs with active batch runs */
	activeBatchSessionIds: string[];
	/** Batch state for the current/active session */
	currentSessionBatchState: BatchRunState | null;
	/** Display batch state (prioritizes active batch session) */
	activeBatchRunState: BatchRunState;
	/** Ref to pauseBatchOnError (for agent error handler) */
	pauseBatchOnErrorRef: React.MutableRefObject<
		| ((
				sessionId: string,
				error: AgentError,
				documentIndex: number,
				taskDescription?: string
		  ) => void)
		| null
	>;
	/** Ref to getBatchState (for quit confirmation and async access) */
	getBatchStateRef: React.MutableRefObject<((sessionId: string) => BatchRunState) | null>;
	/** Sync auto-run stats from server (for leaderboard multi-device sync) */
	handleSyncAutoRunStats: (stats: {
		cumulativeTimeMs: number;
		totalRuns: number;
		currentBadgeLevel: number;
		longestRunMs: number;
		longestRunTimestamp: number;
	}) => void;
}

// ============================================================================
// Selectors
// ============================================================================

const selectSessions = (s: ReturnType<typeof useSessionStore.getState>) => s.sessions;
const selectGroups = (s: ReturnType<typeof useSessionStore.getState>) => s.groups;
const selectAudioFeedbackEnabled = (s: ReturnType<typeof useSettingsStore.getState>) =>
	s.audioFeedbackEnabled;
const selectAudioFeedbackCommand = (s: ReturnType<typeof useSettingsStore.getState>) =>
	s.audioFeedbackCommand;
const selectAutoRunStats = (s: ReturnType<typeof useSettingsStore.getState>) => s.autoRunStats;

// ============================================================================
// Hook
// ============================================================================

export function useBatchHandlers(deps: UseBatchHandlersDeps): UseBatchHandlersReturn {
	const { spawnAgentForSession, rightPanelRef, processQueuedItemRef, handleClearAgentError } = deps;

	// --- Store subscriptions (reactive) ---
	const sessions = useSessionStore(selectSessions);
	const groups = useSessionStore(selectGroups);
	const activeSession = useSessionStore(selectActiveSession);
	const audioFeedbackEnabled = useSettingsStore(selectAudioFeedbackEnabled);
	const audioFeedbackCommand = useSettingsStore(selectAudioFeedbackCommand);
	const autoRunStats = useSettingsStore(selectAutoRunStats);

	// --- Refs for async access ---
	const pauseBatchOnErrorRef = useRef<
		| ((
				sessionId: string,
				error: AgentError,
				documentIndex: number,
				taskDescription?: string
		  ) => void)
		| null
	>(null);
	const getBatchStateRef = useRef<((sessionId: string) => BatchRunState) | null>(null);

	// ====================================================================
	// Initialize batch processor
	// ====================================================================

	const {
		batchRunStates: _batchRunStates,
		getBatchState,
		activeBatchSessionIds,
		startBatchRun,
		stopBatchRun,
		killBatchRun,
		// Error handling (Phase 5.10)
		pauseBatchOnError,
		skipCurrentDocument,
		resumeAfterError,
		abortBatchOnError,
	} = useBatchProcessor({
		sessions,
		groups,
		onUpdateSession: (sessionId, updates) => {
			useSessionStore
				.getState()
				.setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, ...updates } : s)));
		},
		onSpawnAgent: spawnAgentForSession,
		onAddHistoryEntry: async (entry) => {
			await window.maestro.history.add({
				...entry,
				id: generateId(),
			});
			// Refresh history panel to show the new entry
			rightPanelRef.current?.refreshHistoryPanel();
		},
		// TTS settings for speaking synopsis after each auto-run task
		audioFeedbackEnabled,
		audioFeedbackCommand,
		// Pass autoRunStats for achievement progress in final summary
		autoRunStats,
		onComplete: (info) => {
			// Read all needed values from stores at call time to avoid stale closures
			const settingsState = useSettingsStore.getState();
			const currentSessions = useSessionStore.getState().sessions;
			const currentGroups = useSessionStore.getState().groups;
			const {
				firstAutoRunCompleted,
				setFirstAutoRunCompleted,
				recordAutoRunComplete: doRecordAutoRunComplete,
				leaderboardRegistration: lbReg,
				setLeaderboardRegistration: setLbReg,
				autoRunStats: currentAutoRunStats,
				activeThemeId,
			} = settingsState;
			const isLbRegistered = selectIsLeaderboardRegistered(settingsState);

			// Find group name for the session
			const session = currentSessions.find((s) => s.id === info.sessionId);
			const sessionGroup = session?.groupId
				? currentGroups.find((g) => g.id === session.groupId)
				: null;
			const groupName = sessionGroup?.name || 'Ungrouped';

			// Determine toast type and message based on completion status
			const toastType = info.wasStopped
				? 'warning'
				: info.completedTasks === info.totalTasks
					? 'success'
					: 'info';

			// Build message
			let message: string;
			if (info.wasStopped) {
				message = `Stopped after completing ${info.completedTasks} of ${info.totalTasks} tasks`;
			} else if (info.completedTasks === info.totalTasks) {
				message = `All ${info.totalTasks} ${
					info.totalTasks === 1 ? 'task' : 'tasks'
				} completed successfully`;
			} else {
				message = `Completed ${info.completedTasks} of ${info.totalTasks} tasks`;
			}

			notifyToast({
				type: toastType,
				title: 'Auto-Run Complete',
				message,
				group: groupName,
				project: info.sessionName,
				taskDuration: info.elapsedTimeMs,
				sessionId: info.sessionId,
			});

			// Record achievement and check for badge unlocks
			if (info.elapsedTimeMs > 0) {
				const { newBadgeLevel, isNewRecord } = doRecordAutoRunComplete(info.elapsedTimeMs);
				const { setFirstRunCelebrationData, setStandingOvationData } = getModalActions();

				// Check for first Auto Run celebration (takes priority over standing ovation)
				if (!firstAutoRunCompleted) {
					// This is the user's first Auto Run completion!
					setFirstAutoRunCompleted(true);
					// Small delay to let the toast appear first
					setTimeout(() => {
						setFirstRunCelebrationData({
							elapsedTimeMs: info.elapsedTimeMs,
							completedTasks: info.completedTasks,
							totalTasks: info.totalTasks,
						});
					}, 500);
				}
				// Show Standing Ovation overlay for new badges or records (only if not showing first run)
				else if (newBadgeLevel !== null || isNewRecord) {
					const badge =
						newBadgeLevel !== null
							? CONDUCTOR_BADGES.find((b) => b.level === newBadgeLevel)
							: CONDUCTOR_BADGES.find((b) => b.level === currentAutoRunStats.currentBadgeLevel);

					if (badge) {
						// Small delay to let the toast appear first
						setTimeout(() => {
							setStandingOvationData({
								badge,
								isNewRecord,
								recordTimeMs: isNewRecord ? info.elapsedTimeMs : currentAutoRunStats.longestRunMs,
							});
						}, 500);
					}
				}

				// Submit to leaderboard if registered and email confirmed
				if (isLbRegistered && lbReg) {
					// Calculate updated stats after this run
					const updatedCumulativeTimeMs = currentAutoRunStats.cumulativeTimeMs + info.elapsedTimeMs;
					const updatedTotalRuns = currentAutoRunStats.totalRuns + 1;
					const updatedLongestRunMs = Math.max(
						currentAutoRunStats.longestRunMs || 0,
						info.elapsedTimeMs
					);
					const updatedBadge = getBadgeForTime(updatedCumulativeTimeMs);
					const updatedBadgeLevel = updatedBadge?.level || 0;
					const updatedBadgeName = updatedBadge?.name || 'No Badge Yet';

					// Format longest run date
					let longestRunDate: string | undefined;
					if (isNewRecord) {
						longestRunDate = new Date().toISOString().split('T')[0];
					} else if (currentAutoRunStats.longestRunTimestamp > 0) {
						longestRunDate = new Date(currentAutoRunStats.longestRunTimestamp)
							.toISOString()
							.split('T')[0];
					}

					// Submit to leaderboard in background (only if we have an auth token)
					if (!lbReg.authToken) {
						console.warn('Leaderboard submission skipped: no auth token');
					} else {
						window.maestro.leaderboard
							.submit({
								email: lbReg.email,
								displayName: lbReg.displayName,
								githubUsername: lbReg.githubUsername,
								twitterHandle: lbReg.twitterHandle,
								linkedinHandle: lbReg.linkedinHandle,
								badgeLevel: updatedBadgeLevel,
								badgeName: updatedBadgeName,
								cumulativeTimeMs: updatedCumulativeTimeMs,
								totalRuns: updatedTotalRuns,
								longestRunMs: updatedLongestRunMs,
								longestRunDate,
								currentRunMs: info.elapsedTimeMs,
								theme: activeThemeId,
								authToken: lbReg.authToken,
								deltaMs: info.elapsedTimeMs,
								deltaRuns: 1,
								clientTotalTimeMs: updatedCumulativeTimeMs,
							})
							.then((result) => {
								if (result.success) {
									// Update last submission timestamp
									setLbReg({
										...lbReg,
										lastSubmissionAt: Date.now(),
										emailConfirmed: !result.requiresConfirmation,
									});

									// Show ranking notification if available
									if (result.ranking) {
										const { cumulative, longestRun } = result.ranking;
										let rankMessage = '';

										if (cumulative.previousRank === null) {
											rankMessage = `You're ranked #${cumulative.rank} of ${cumulative.total}!`;
										} else if (cumulative.improved) {
											const spotsUp = cumulative.previousRank - cumulative.rank;
											rankMessage = `You moved up ${spotsUp} spot${
												spotsUp > 1 ? 's' : ''
											}! Now #${cumulative.rank} (was #${cumulative.previousRank})`;
										} else if (cumulative.rank === cumulative.previousRank) {
											rankMessage = `You're holding steady at #${cumulative.rank}`;
										} else {
											rankMessage = `You're now #${cumulative.rank} of ${cumulative.total}`;
										}

										if (longestRun && isNewRecord) {
											rankMessage += ` | New personal best! #${longestRun.rank} on longest runs!`;
										}

										notifyToast({
											type: 'success',
											title: 'Leaderboard Updated',
											message: rankMessage,
										});
									}

									// Sync local stats from server response
									if (result.serverTotals) {
										const serverCumulativeMs = result.serverTotals.cumulativeTimeMs;
										if (serverCumulativeMs > updatedCumulativeTimeMs) {
											const freshSettings = useSettingsStore.getState();
											freshSettings.setAutoRunStats({
												...freshSettings.autoRunStats,
												cumulativeTimeMs: serverCumulativeMs,
												totalRuns: result.serverTotals.totalRuns,
												currentBadgeLevel: getBadgeForTime(serverCumulativeMs)?.level ?? 0,
												longestRunMs: updatedLongestRunMs,
												longestRunTimestamp: currentAutoRunStats.longestRunTimestamp,
											});
										}
									}
								}
							})
							.catch((error) => {
								Sentry.captureException(error, {
									extra: { operation: 'leaderboard-submit', badgeLevel: updatedBadgeLevel },
								});
							});
					}
				}
			}

			// Symphony auto-finalization: when auto-run completes for a Symphony
			// contribution, automatically push code and mark the PR as ready.
			if (!info.wasStopped && session?.symphonyMetadata?.isSymphonySession) {
				const contributionId = session.symphonyMetadata.contributionId;
				// Delay slightly to let the final task's git operations settle
				setTimeout(async () => {
					try {
						const result = await window.maestro.symphony.complete({
							contributionId,
						});
						if (result.prUrl) {
							notifyToast({
								type: 'success',
								title: 'Symphony: PR Ready for Review',
								message: `PR opened: ${result.prUrl}`,
								sessionId: info.sessionId,
							});
						} else {
							// complete returned but no prUrl — set to completed for manual finalization
							await window.maestro.symphony.updateStatus({
								contributionId,
								status: 'completed',
							});
							notifyToast({
								type: 'warning',
								title: 'Symphony: Manual Finalization Needed',
								message: result.error || 'Could not auto-finalize PR. Open Symphony to finalize.',
								sessionId: info.sessionId,
							});
						}
					} catch (err) {
						// Set status to completed so user can manually finalize via the Symphony modal
						try {
							await window.maestro.symphony.updateStatus({
								contributionId,
								status: 'completed',
							});
						} catch {
							// Best-effort status update
						}
						Sentry.captureException(err, {
							extra: { operation: 'symphony-auto-finalize', contributionId },
						});
						notifyToast({
							type: 'warning',
							title: 'Symphony: Auto-Finalize Failed',
							message: 'PR remains as draft. Open Symphony to finalize manually.',
							sessionId: info.sessionId,
						});
					}
				}, 2000);
			}
		},
		onPRResult: (info) => {
			// Read from stores at call time
			const currentSessions = useSessionStore.getState().sessions;
			const currentGroups = useSessionStore.getState().groups;

			const session = currentSessions.find((s) => s.id === info.sessionId);
			const sessionGroup = session?.groupId
				? currentGroups.find((g) => g.id === session.groupId)
				: null;
			const groupName = sessionGroup?.name || 'Ungrouped';

			if (info.success) {
				notifyToast({
					type: 'success',
					title: 'PR Created',
					message: info.prUrl || 'Pull request created successfully',
					group: groupName,
					project: info.sessionName,
					sessionId: info.sessionId,
				});
			} else {
				notifyToast({
					type: 'warning',
					title: 'PR Creation Failed',
					message: info.error || 'Failed to create pull request',
					group: groupName,
					project: info.sessionName,
					sessionId: info.sessionId,
				});
			}
		},
		onProcessQueueAfterCompletion: (sessionId) => {
			const currentSessions = useSessionStore.getState().sessions;
			const session = currentSessions.find((s) => s.id === sessionId);
			if (session && session.executionQueue.length > 0 && processQueuedItemRef.current) {
				const [nextItem, ...remainingQueue] = session.executionQueue;

				useSessionStore.getState().setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== sessionId) return s;

						const targetTab = s.aiTabs.find((tab) => tab.id === nextItem.tabId) || getActiveTab(s);
						if (!targetTab) {
							return {
								...s,
								state: 'busy' as SessionState,
								busySource: 'ai',
								executionQueue: remainingQueue,
								thinkingStartTime: Date.now(),
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
								tab.id === targetTab.id
									? {
											...tab,
											logs: [...tab.logs, logEntry],
											state: 'busy' as const,
										}
									: tab
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
						};
					})
				);

				// Process the item after state update
				processQueuedItemRef.current(sessionId, nextItem);
			}
		},
	});

	// Update refs for async access (used by agent error handler and quit confirmation)
	pauseBatchOnErrorRef.current = pauseBatchOnError;
	getBatchStateRef.current = getBatchState;

	// ====================================================================
	// Memoized batch states
	// ====================================================================

	// Batch state for the current session - used for locking the AutoRun editor
	const currentSessionBatchState = useMemo(() => {
		return activeSession ? getBatchState(activeSession.id) : null;
	}, [activeSession, getBatchState]);

	// Display batch state - prioritize session with active batch run,
	// falling back to active session's state
	const activeBatchRunState = useMemo(() => {
		if (activeBatchSessionIds.length > 0) {
			return getBatchState(activeBatchSessionIds[0]);
		}
		return activeSession ? getBatchState(activeSession.id) : getBatchState('');
	}, [activeBatchSessionIds, activeSession, getBatchState]);

	// ====================================================================
	// Handler callbacks
	// ====================================================================

	const handleStopBatchRun = useCallback(
		(targetSessionId?: string) => {
			const sessionId =
				targetSessionId ??
				activeSession?.id ??
				(activeBatchSessionIds.length > 0 ? activeBatchSessionIds[0] : undefined);
			console.log(
				'[App:handleStopBatchRun] targetSessionId:',
				targetSessionId,
				'resolved sessionId:',
				sessionId
			);
			if (!sessionId) return;
			const session = sessions.find((s) => s.id === sessionId);
			const agentName = session?.name || 'this session';
			useModalStore.getState().openModal('confirm', {
				message: `Stop Auto Run for "${agentName}" after the current task completes?`,
				onConfirm: () => {
					console.log(
						'[App:handleStopBatchRun] Confirmation callback executing for sessionId:',
						sessionId
					);
					stopBatchRun(sessionId);
				},
			});
		},
		[activeBatchSessionIds, activeSession, sessions, stopBatchRun]
	);

	const handleKillBatchRun = useCallback(
		async (sessionId: string) => {
			console.log('[App:handleKillBatchRun] Force killing sessionId:', sessionId);
			await killBatchRun(sessionId);
		},
		[killBatchRun]
	);

	const handleSkipCurrentDocument = useCallback(() => {
		const sessionId =
			activeBatchSessionIds.length > 0 ? activeBatchSessionIds[0] : activeSession?.id;
		if (!sessionId) return;
		skipCurrentDocument(sessionId);
		handleClearAgentError(sessionId);
	}, [activeBatchSessionIds, activeSession, skipCurrentDocument, handleClearAgentError]);

	const handleResumeAfterError = useCallback(() => {
		const sessionId =
			activeBatchSessionIds.length > 0 ? activeBatchSessionIds[0] : activeSession?.id;
		if (!sessionId) return;
		resumeAfterError(sessionId);
		handleClearAgentError(sessionId);
	}, [activeBatchSessionIds, activeSession, resumeAfterError, handleClearAgentError]);

	const handleAbortBatchOnError = useCallback(() => {
		const sessionId =
			activeBatchSessionIds.length > 0 ? activeBatchSessionIds[0] : activeSession?.id;
		if (!sessionId) return;
		abortBatchOnError(sessionId);
		handleClearAgentError(sessionId);
	}, [activeBatchSessionIds, activeSession, abortBatchOnError, handleClearAgentError]);

	// ====================================================================
	// Sync auto-run stats from server
	// ====================================================================

	const handleSyncAutoRunStats = useCallback(
		(stats: {
			cumulativeTimeMs: number;
			totalRuns: number;
			currentBadgeLevel: number;
			longestRunMs: number;
			longestRunTimestamp: number;
		}) => {
			const { autoRunStats: currentStats, setAutoRunStats } = useSettingsStore.getState();
			setAutoRunStats({
				...currentStats,
				cumulativeTimeMs: stats.cumulativeTimeMs,
				totalRuns: stats.totalRuns,
				currentBadgeLevel: stats.currentBadgeLevel,
				longestRunMs: stats.longestRunMs,
				longestRunTimestamp: stats.longestRunTimestamp,
				// Also update badge tracking to match synced level
				lastBadgeUnlockLevel: stats.currentBadgeLevel,
				lastAcknowledgedBadgeLevel: stats.currentBadgeLevel,
			});
		},
		[]
	);

	// ====================================================================
	// Effects
	// ====================================================================

	// Quit confirmation handler - shows modal when trying to quit with busy agents or active auto-runs
	useEffect(() => {
		if (!window.maestro?.app?.onQuitConfirmationRequest) {
			return;
		}
		const unsubscribe = window.maestro.app.onQuitConfirmationRequest(() => {
			// Get all busy AI sessions (agents that are actively thinking)
			const currentSessions = useSessionStore.getState().sessions;
			const busyAgents = currentSessions.filter(
				(s) => s.state === 'busy' && s.busySource === 'ai' && s.toolType !== 'terminal'
			);

			// Check for active auto-runs (batch processor may be between tasks with agent idle)
			const hasActiveAutoRuns = currentSessions.some((s) => {
				const batchState = getBatchStateRef.current?.(s.id);
				return batchState?.isRunning;
			});

			if (busyAgents.length === 0 && !hasActiveAutoRuns) {
				window.maestro.app.confirmQuit();
			} else {
				getModalActions().setQuitConfirmModalOpen(true);
			}
		});

		return unsubscribe;
	}, []);

	return {
		startBatchRun,
		getBatchState,
		handleStopBatchRun,
		handleKillBatchRun,
		handleSkipCurrentDocument,
		handleResumeAfterError,
		handleAbortBatchOnError,
		activeBatchSessionIds,
		currentSessionBatchState,
		activeBatchRunState,
		pauseBatchOnErrorRef,
		getBatchStateRef,
		handleSyncAutoRunStats,
	};
}
