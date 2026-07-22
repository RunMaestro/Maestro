/**
 * useAgentExitListener - registers `window.maestro.process.onExit`
 *
 * Orchestration only: pure logic lives in `helpers/exitDequeue`,
 * `helpers/exitTabCleanup`, `helpers/exitGitRefresh`, and
 * `helpers/exitSynopsis`. This hook coordinates them in the original
 * sequence:
 *  1. Parse the rawSessionId. Bail on terminal-tab and batch suffixes.
 *  2. Verify the process is actually gone (avoids "ghost" exits).
 *  3. Gather toast + synopsis data BEFORE the state update so the
 *     reducer stays pure.
 *  4. Apply the AI / terminal state transition via `setSessions`.
 *  5. Fire git-refs refresh, query-stats record, queued-item dispatch,
 *     completion toast, and async synopsis spawn (in that order).
 *
 * Receives the shared `activeHiddenToolRef` from the coordinator and
 * deletes the per-tab entry on exit so subsequent tool events don't
 * dangle.
 */

import { useEffect, useRef } from 'react';
import { getClaudeTokenSourceFields } from '../../../../shared/claudeTokenMode';
import { useSessionStore } from '../../../stores/sessionStore';
import { clearRetryIfSettled } from '../../../stores/retryStore';
import { isTtsrAbortPending } from '../../../stores/ttsrStore';
import { useSettingsStore } from '../../../stores/settingsStore';
import { notifyToast, triggerCustomNotification } from '../../../stores/notificationStore';
import { REGEX_AI_TAB } from '../../../utils/sessionIdParser';
import {
	getActiveTab,
	markTabRunningQueuedItem,
	resolveQueuedItemTarget,
} from '../../../utils/tabHelpers';
import { generateId } from '../../../utils/ids';
import { logger } from '../../../utils/logger';
import { cleanupExitedTabLogs } from './helpers/exitTabCleanup';
import { chooseNextQueuedItem } from './helpers/exitDequeue';
import { takeNextRunnableQueueItem } from '../../../utils/executionQueue';
import { refreshGitRefsAfterTerminalExit } from './helpers/exitGitRefresh';
import {
	runExitSynopsis,
	shouldRunSynopsisOnExit,
	turnDidMeaningfulWork,
	type SynopsisData,
	type RunExitSynopsisDeps,
} from './helpers/exitSynopsis';
import { thinkingLogsRecorded } from './helpers/thinkingLogs';
import { getAutorunSynopsisPrompt } from './helpers/autorunSynopsisPrompt';
import { useOwnedSessionGate } from './useOwnedSessionGate';
import type { LogEntry, QueuedItem, Session, SessionState, UsageStats } from '../../../types';
import type { UseAgentListenersDeps, ToolProgressState } from './types';

export interface UseAgentExitListenerDeps {
	getBatchStateRef: UseAgentListenersDeps['getBatchStateRef'];
	processQueuedItemRef: UseAgentListenersDeps['processQueuedItemRef'];
	addHistoryEntryRef: UseAgentListenersDeps['addHistoryEntryRef'];
	spawnBackgroundSynopsisRef: UseAgentListenersDeps['spawnBackgroundSynopsisRef'];
	rightPanelRef: UseAgentListenersDeps['rightPanelRef'];
	batchedUpdater: UseAgentListenersDeps['batchedUpdater'];
	activeHiddenToolRef: React.RefObject<
		Map<string, { toolName: string; toolState?: ToolProgressState }>
	>;
}

export function useAgentExitListener(deps: UseAgentExitListenerDeps): void {
	// Pending debounced synopses, keyed by `${sessionId}:${tabId}`. When the
	// Synopsis Debounce setting is on, each eligible exit (re)arms a timer here
	// instead of spawning immediately, so rapid-fire turns coalesce into one
	// synopsis. Flushed on unmount so in-flight work still reaches History.
	const debounceTimersRef = useRef<
		Map<string, { timer: ReturnType<typeof setTimeout>; data: SynopsisData; anyWork: boolean }>
	>(new Map());
	const ownedGate = useOwnedSessionGate();

	useEffect(() => {
		const setSessions = useSessionStore.getState().setSessions;
		const getSessions = () => useSessionStore.getState().sessions;
		const getGroups = () => useSessionStore.getState().groups;
		const getActiveSessionId = () => useSessionStore.getState().activeSessionId;

		// Shared deps for every synopsis spawn (immediate or debounced).
		const runSynopsisDeps: RunExitSynopsisDeps = {
			spawnBackgroundSynopsisRef: deps.spawnBackgroundSynopsisRef,
			addHistoryEntryRef: deps.addHistoryEntryRef,
			rightPanelRef: deps.rightPanelRef,
			getAutorunSynopsisPrompt,
			updateLastSynopsisTime: (sId, tId, time) => {
				setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== sId) return s;
						return {
							...s,
							aiTabs: s.aiTabs.map((tab) =>
								tab.id !== tId ? tab : { ...tab, lastSynopsisTime: time }
							),
						};
					})
				);
			},
		};

		/**
		 * Route an eligible synopsis through the activity gate and (optionally) the
		 * debounce window.
		 *
		 * - Activity gate (always on): a turn that did no real work - a plain Q&A
		 *   with no tool use - is dropped. We never pay for a synopsis spawn or a
		 *   History entry on a turn that produced nothing.
		 * - Debounce (opt-in via `synopsisDebounceSeconds`): a work-turn arms or
		 *   resets a per-tab timer; a follow-up turn while one is pending extends
		 *   it. When it fires, a single synopsis covers everything since the last
		 *   recorded synopsis. A pure-Q&A turn with nothing pending arms nothing.
		 */
		const dispatchSynopsis = (data: SynopsisData, didWork: boolean): void => {
			const debounceSec = useSettingsStore.getState().synopsisDebounceSeconds || 0;

			if (debounceSec <= 0) {
				if (didWork) void runExitSynopsis(data, runSynopsisDeps);
				return;
			}

			const timers = debounceTimersRef.current;
			const key = `${data.sessionId}:${data.tabId ?? ''}`;
			const existing = timers.get(key);
			const anyWork = (existing?.anyWork ?? false) || didWork;
			// Don't arm a timer for a conversation that hasn't done any real work yet.
			if (!anyWork) return;

			if (existing) clearTimeout(existing.timer);
			const timer = setTimeout(() => {
				const entry = timers.get(key);
				timers.delete(key);
				if (entry?.anyWork) void runExitSynopsis(entry.data, runSynopsisDeps);
			}, debounceSec * 1000);
			// Always carry the latest turn's data so the synopsis resumes the most
			// recent agent session and reports the freshest duration.
			timers.set(key, { timer, data, anyWork: true });
		};

		const unsubscribe = window.maestro.process.onExit(async (sessionId: string, code: number) => {
			// Window scoping: only the window that owns the agent runs exit side
			// effects (synopsis spawn, git refresh, history entry, queue dequeue).
			// Events are broadcast to every window, so a non-owning window must bail
			// here or those one-shot effects would fire once per open window.
			if (!ownedGate.current?.(sessionId)) return;
			if (sessionId.includes('-terminal-')) return;

			// TTSR aborted this turn deliberately: main signalled the process and is
			// about to hand back a corrective prompt on `ttsr:triggered`. Running the
			// normal exit side effects here would idle the tab, dequeue the next
			// queued item onto the same process id, and log the turn as finished -
			// all of which the corrective respawn would then have to undo.
			if (isTtsrAbortPending(sessionId)) {
				logger.info('[onExit] Suppressed - TTSR abort in flight', undefined, { sessionId });
				return;
			}

			logger.info('[onExit] Process exit event received:', undefined, {
				rawSessionId: sessionId,
				exitCode: code,
				timestamp: new Date().toISOString(),
			});

			let actualSessionId: string;
			let isFromAi: boolean;
			let tabIdFromSession: string | undefined;

			const aiTabMatch = sessionId.match(REGEX_AI_TAB);
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

			// SAFETY CHECK: Verify the process is actually gone before mutating
			// any per-tab state. We hold off on clearing `activeHiddenToolRef`
			// until after this guard so a false-positive exit event doesn't
			// drop bookkeeping for a process that's still alive.
			if (isFromAi) {
				try {
					const activeProcesses = await window.maestro.process.getActiveProcesses();
					const processStillRunning = activeProcesses.some((p) => p.sessionId === sessionId);
					if (processStillRunning) {
						logger.warn('[onExit] Process still running despite exit event, ignoring:', undefined, {
							sessionId,
							activeProcesses: activeProcesses.map((p) => p.sessionId),
						});
						return;
					}
				} catch (error) {
					logger.error('[onExit] Failed to verify process status:', undefined, error);
				}
			}

			if (isFromAi && tabIdFromSession) {
				deps.activeHiddenToolRef.current?.delete(`${actualSessionId}:${tabIdFromSession}`);
				// Agent Resilience: if an auto-retry resend is still 'in-flight' at
				// exit, no retryable error re-scheduled it (agent-error fires before
				// exit), so the resent turn settled - clear the pending retry.
				clearRetryIfSettled(actualSessionId, tabIdFromSession);
			}

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
			let queuedItemToProcess: { sessionId: string; item: QueuedItem } | null = null;
			let synopsisData: SynopsisData | null = null;
			let synopsisDidWork = false;

			if (isFromAi) {
				const currentSession = getSessions().find((s) => s.id === actualSessionId);
				if (currentSession) {
					const queueDecision = chooseNextQueuedItem(currentSession, tabIdFromSession);
					if (queueDecision.action === 'dequeue' && queueDecision.item) {
						queuedItemToProcess = {
							sessionId: actualSessionId,
							item: queueDecision.item,
						};
					}

					// Look up the completed tab in aiTabs first, then in orphanedThinkingTabs -
					// tabs closed mid-thinking land in the orphan list, and their exit still
					// needs to drive toast/synopsis side-effects.
					const completedTab = tabIdFromSession
						? currentSession.aiTabs?.find((tab) => tab.id === tabIdFromSession) ||
							currentSession.orphanedThinkingTabs?.find((tab) => tab.id === tabIdFromSession)
						: getActiveTab(currentSession);
					const logs = completedTab?.logs || [];
					const lastUserLog = logs.filter((log) => log.source === 'user').pop();
					const lastAiLog = logs
						.filter((log) => log.source === 'stdout' || log.source === 'ai')
						.pop();
					const completedTabData =
						currentSession.aiTabs?.find((tab) => tab.id === tabIdFromSession) ||
						currentSession.orphanedThinkingTabs?.find((tab) => tab.id === tabIdFromSession);
					const duration = completedTabData?.thinkingStartTime
						? Date.now() - completedTabData.thinkingStartTime
						: currentSession.thinkingStartTime
							? Date.now() - currentSession.thinkingStartTime
							: 0;

					const sessionSizeBytes = logs.reduce((sum, log) => sum + (log.text?.length || 0), 0);
					const sessionSizeKB = (sessionSizeBytes / 1024).toFixed(1);

					const effectiveGroupId =
						currentSession.groupId ||
						(currentSession.parentSessionId
							? getSessions().find((s) => s.id === currentSession.parentSessionId)?.groupId
							: undefined);
					const sessionGroup = effectiveGroupId
						? getGroups().find((g) => g.id === effectiveGroupId)
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

					if (shouldRunSynopsisOnExit(currentSession, completedTab)) {
						synopsisDidWork = turnDidMeaningfulWork(
							logs,
							!!currentSession.pendingAICommandForSynopsis,
							thinkingLogsRecorded(completedTab?.showThinking)
						);
						synopsisData = {
							sessionId: actualSessionId,
							cwd: currentSession.cwd,
							projectRoot: currentSession.projectRoot,
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
								// Carry the agent's Claude token source into the synopsis spawn so
								// it resolves the same TUI/Dynamic/API mode as a normal turn.
								// Shared extractor guarantees the SAME complete triple - no
								// partial/drifting forward possible.
								...getClaudeTokenSourceFields(currentSession),
							},
						};
					}
				}
			}

			// Update state (pure function - no side effects)
			setSessions((prev) =>
				prev.map((s) => {
					if (s.id !== actualSessionId) return s;

					// If this exit belongs to a tab the user already closed while it was
					// still thinking, the tab is no longer in s.aiTabs - it lives in
					// s.orphanedThinkingTabs purely so the thinking pill can keep
					// surfacing it. Drop it from orphans and recompute session-level
					// busy state. Nothing else (queue, logs, synopsis, toast) needs to
					// touch aiTabs because the tab is gone.
					const orphanIndex =
						tabIdFromSession && s.orphanedThinkingTabs
							? s.orphanedThinkingTabs.findIndex((t) => t.id === tabIdFromSession)
							: -1;
					if (isFromAi && orphanIndex !== -1 && s.orphanedThinkingTabs) {
						// Before retiring the orphan, drain any follow-up the user queued on
						// it: a message queued on a tab keeps sending in the background after
						// the tab is closed (fire-and-forget). The orphan stays parked - it
						// carries the agent session id for continuity and is a valid dispatch
						// target - until its queued work is gone.
						const { item: nextItem, remaining: remainingQueue } = takeNextRunnableQueueItem(
							s.executionQueue
						);
						const otherTabsBusy = s.aiTabs?.some((tab) => tab.state === 'busy') ?? false;
						const runNextOnOrphan =
							!!nextItem &&
							nextItem.tabId === tabIdFromSession &&
							(nextItem.forceParallel || nextItem.readOnlyMode || !otherTabsBusy);

						if (runNextOnOrphan && nextItem) {
							// Keep the orphan, mark it thinking again, and dequeue the item here
							// so it is not re-dispatched. processQueuedItem (queuedItemToProcess,
							// computed above via chooseNextQueuedItem) performs the actual spawn
							// against this same orphan tab id.
							const updatedOrphans = s.orphanedThinkingTabs.map((tab, i) => {
								if (i !== orphanIndex) return tab;
								const refreshed = {
									...tab,
									state: 'busy' as const,
									thinkingStartTime: Date.now(),
								};
								// Record the queued user message on the orphan's own log so a
								// later restore shows the background conversation. (The streamed
								// response only routes back to the UI once the tab is restored.)
								if (nextItem.type === 'message' && nextItem.text) {
									const logEntry: LogEntry = {
										id: generateId(),
										timestamp: Date.now(),
										source: 'user',
										text: nextItem.text,
										images: nextItem.images,
										...(nextItem.forceParallel && { forceParallel: true }),
									};
									refreshed.logs = [...refreshed.logs, logEntry];
								}
								return refreshed;
							});
							return {
								...s,
								orphanedThinkingTabs: updatedOrphans,
								executionQueue: remainingQueue,
								state: 'busy' as SessionState,
								busySource: 'ai',
								thinkingStartTime: Date.now(),
								currentCycleTokens: 0,
								currentCycleBytes: 0,
							};
						}

						// Items queued for this orphan that can't run yet (another tab is
						// busy): keep the orphan parked so it survives to drain once the
						// others finish. The idle-recovery path in useQueueProcessing then
						// dispatches it when the session next goes idle.
						const orphanHasPendingItems = s.executionQueue.some(
							(item) => item.tabId === tabIdFromSession
						);
						if (orphanHasPendingItems) {
							const updatedOrphans = s.orphanedThinkingTabs.map((tab, i) =>
								i === orphanIndex
									? { ...tab, state: 'idle' as const, thinkingStartTime: undefined }
									: tab
							);
							const anyAiTabStillBusy = s.aiTabs?.some((tab) => tab.state === 'busy') ?? false;
							return {
								...s,
								orphanedThinkingTabs: updatedOrphans,
								state: anyAiTabStillBusy ? s.state : ('idle' as SessionState),
								busySource: anyAiTabStillBusy ? s.busySource : undefined,
								thinkingStartTime: anyAiTabStillBusy ? s.thinkingStartTime : undefined,
							};
						}

						// This orphan has no queued work of its own, so it's done draining -
						// retire it. But the queue may still hold a runnable item for ANOTHER
						// tab that the post-reducer dispatch (queuedItemToProcess, decided above
						// by chooseNextQueuedItem) is about to spawn. We MUST dequeue that exact
						// item and mark its target busy here, in lockstep with that spawn.
						// Otherwise it stays queued and re-dispatches when its own process later
						// exits (the message runs twice), and no tab shows busy while it runs
						// (an invisible turn whose reply never routes to a tab). Gating on
						// queuedItemToProcess keeps the reducer and the spawn perfectly in sync.
						const orphansWithoutExited = s.orphanedThinkingTabs.filter((_, i) => i !== orphanIndex);
						const { item: nextRunnable, remaining: remainingAfterNext } = takeNextRunnableQueueItem(
							s.executionQueue
						);
						const dispatchesNext =
							!!queuedItemToProcess &&
							!!nextRunnable &&
							queuedItemToProcess.item.id === nextRunnable.id;

						if (dispatchesNext && nextRunnable) {
							// Resolve against the session WITHOUT the just-retired orphan so the
							// target is the item's real owner (another aiTab or another
							// still-draining orphan); we already know it isn't this orphan.
							const sessionAfterRetire: Session = {
								...s,
								orphanedThinkingTabs: orphansWithoutExited,
							};
							const target = resolveQueuedItemTarget(sessionAfterRetire, nextRunnable);
							if (target) {
								return {
									...s,
									aiTabs: s.aiTabs.map((tab) =>
										tab.id === target.tabId ? markTabRunningQueuedItem(tab, nextRunnable) : tab
									),
									orphanedThinkingTabs:
										orphansWithoutExited.length > 0
											? orphansWithoutExited.map((tab) =>
													tab.id === target.tabId
														? markTabRunningQueuedItem(tab, nextRunnable)
														: tab
												)
											: undefined,
									executionQueue: remainingAfterNext,
									state: 'busy' as SessionState,
									busySource: 'ai',
									thinkingStartTime: Date.now(),
									currentCycleTokens: 0,
									currentCycleBytes: 0,
								};
							}
						}

						// Nothing to dispatch - retire the orphan and recompute thinking state.
						const anyAiTabStillBusy = s.aiTabs?.some((tab) => tab.state === 'busy') ?? false;
						const stillThinking = anyAiTabStillBusy || orphansWithoutExited.length > 0;
						return {
							...s,
							orphanedThinkingTabs:
								orphansWithoutExited.length > 0 ? orphansWithoutExited : undefined,
							state: stillThinking ? s.state : ('idle' as SessionState),
							busySource: stillThinking ? s.busySource : undefined,
							thinkingStartTime: stillThinking ? s.thinkingStartTime : undefined,
						};
					}

					if (isFromAi) {
						if (s.state === 'error' && s.agentError) {
							const updatedAiTabs =
								s.aiTabs?.length > 0
									? s.aiTabs.map((tab) => {
											if (tabIdFromSession) {
												return tab.id === tabIdFromSession
													? {
															...tab,
															logs: cleanupExitedTabLogs(tab.logs, tab.id, tab),
															state: 'idle' as const,
															thinkingStartTime: undefined,
															// Preserve agentSessionId - stale IDs are cleared
															// by onAgentError when session_not_found is detected.
															// Blanket-clearing here breaks tab identity for
															// recoverable errors (rate limits, API errors, etc.)
														}
													: tab;
											} else {
												return tab.state === 'busy'
													? {
															...tab,
															logs: cleanupExitedTabLogs(tab.logs, tab.id, tab),
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

						// Skip paused items: run the first runnable one, holding the rest
						// (including any paused items ahead of it) in place.
						const { item: nextItem, remaining: remainingQueue } = takeNextRunnableQueueItem(
							s.executionQueue
						);
						if (nextItem) {
							// Guard: non-forceParallel, non-readOnly items must wait
							// until ALL other tabs are idle to prevent write conflicts
							const otherTabsBusy = s.aiTabs?.some(
								(tab) => tab.id !== tabIdFromSession && tab.state === 'busy'
							);
							if (!nextItem.forceParallel && !nextItem.readOnlyMode && otherTabsBusy) {
								// Don't dequeue - mark the exiting tab idle and keep session busy
								const updatedAiTabs = s.aiTabs.map((tab) =>
									tabIdFromSession && tab.id === tabIdFromSession
										? {
												...tab,
												logs: cleanupExitedTabLogs(tab.logs, tab.id, tab),
												state: 'idle' as const,
												thinkingStartTime: undefined,
											}
										: tab
								);
								const anyTabStillBusy = updatedAiTabs.some((tab) => tab.state === 'busy');
								return {
									...s,
									state: anyTabStillBusy ? ('busy' as SessionState) : ('idle' as SessionState),
									busySource: anyTabStillBusy ? s.busySource : undefined,
									thinkingStartTime: anyTabStillBusy ? s.thinkingStartTime : undefined,
									aiTabs: updatedAiTabs,
								};
							}

							const target = resolveQueuedItemTarget(s, nextItem);

							if (!target) {
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

							// Route the dequeued item to its target tab. When that tab is an
							// orphan (the user closed it while this message was still queued),
							// it lives in orphanedThinkingTabs - keep the send fire-and-forget
							// and route busy-state + the user log THERE, never onto the
							// active tab. The aiTabs map then only marks the just-exited tab
							// idle (its target branch never matches a live aiTab in that case).
							const updatedAiTabs = s.aiTabs.map((tab) => {
								if (tab.id === target.tabId) {
									return markTabRunningQueuedItem(tab, nextItem);
								}
								if (tabIdFromSession && tab.id === tabIdFromSession) {
									return {
										...tab,
										logs: cleanupExitedTabLogs(tab.logs, tab.id, tab),
										state: 'idle' as const,
									};
								}
								return tab;
							});

							const updatedOrphans =
								target.location === 'orphan' && s.orphanedThinkingTabs
									? s.orphanedThinkingTabs.map((tab) =>
											tab.id === target.tabId ? markTabRunningQueuedItem(tab, nextItem) : tab
										)
									: s.orphanedThinkingTabs;

							return {
								...s,
								state: 'busy' as SessionState,
								busySource: 'ai',
								aiTabs: updatedAiTabs,
								...(updatedOrphans !== s.orphanedThinkingTabs && {
									orphanedThinkingTabs: updatedOrphans,
								}),
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
														logs: cleanupExitedTabLogs(tab.logs, tab.id, tab),
														state: 'idle' as const,
														thinkingStartTime: undefined,
														// Preserve agentSessionId for session resume -
														// stale IDs are cleared by onAgentError when
														// session_not_found is detected
													}
												: tab;
										} else {
											return tab.state === 'busy'
												? {
														...tab,
														logs: cleanupExitedTabLogs(tab.logs, tab.id, tab),
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

						logger.info('[onExit] Session state transition:', undefined, {
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
						// TODO: Remove shellLogs once terminal tabs migration is complete
						...(!s.terminalTabs?.length && { shellLogs: [...s.shellLogs, exitLog] }),
					};
				})
			);

			// Refresh git branches/tags after terminal command completes
			if (!isFromAi) {
				const currentSession = getSessions().find((s) => s.id === actualSessionId);
				if (currentSession) {
					void (async () => {
						const result = await refreshGitRefsAfterTerminalExit(currentSession);
						if (!result) return;
						setSessions((prev) =>
							prev.map((s) =>
								s.id === actualSessionId
									? {
											...s,
											gitBranches: result.gitBranches,
											gitTags: result.gitTags,
											gitRefsCacheTime: Date.now(),
										}
									: s
							)
						);
					})();
				}
			}

			// Fire side effects AFTER state update
			if (toastData?.startTime && toastData?.agentType) {
				const sessionIdForStats = toastData.sessionId || actualSessionId;
				const isAutoRunQuery = deps.getBatchStateRef.current
					? deps.getBatchStateRef.current(sessionIdForStats).isRunning
					: false;
				const sessionForStats = getSessions().find((s) => s.id === sessionIdForStats);

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
						isWorktree: !!sessionForStats?.parentSessionId,
					})
					.catch((err) => {
						logger.warn('[onProcessExit] Failed to record query stats:', undefined, err);
					});
			}

			if (queuedItemToProcess) {
				// Flush any pending batched stdout/stderr chunks before the queued
				// message is dispatched. Otherwise the new user log entry is appended
				// ahead of the trailing chunks from the response that just finished,
				// and those chunks merge into the next response's bubble (issue #1022).
				deps.batchedUpdater.flushNow();
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
						notifyToast({
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
					} else {
						// Viewing the completed tab: the visual toast is suppressed (no need
						// to pop a toast about the tab you're already watching), but the
						// audio/TTS cue must still fire. Otherwise custom notifications are
						// silently dropped whenever you watch an agent finish - the synopsis
						// toast that does appear sets skipCustomNotification, so without this
						// the completion would make no sound at all.
						triggerCustomNotification(toastData!.summary, {
							agent: toastData!.projectName,
							tab: toastData!.tabName,
							group: toastData!.groupName,
							task: toastData!.title,
						});
					}
				}, 0);
			}

			if (synopsisData) {
				dispatchSynopsis(synopsisData, synopsisDidWork);
			}
		});

		return () => {
			unsubscribe();
			// Flush any pending debounced synopses so finished work still reaches
			// History when the listener tears down (navigation, reload, quit).
			const timers = debounceTimersRef.current;
			for (const entry of timers.values()) {
				clearTimeout(entry.timer);
				if (entry.anyWork) void runExitSynopsis(entry.data, runSynopsisDeps);
			}
			timers.clear();
		};
	}, [
		deps.activeHiddenToolRef,
		deps.addHistoryEntryRef,
		deps.getBatchStateRef,
		deps.processQueuedItemRef,
		deps.rightPanelRef,
		deps.spawnBackgroundSynopsisRef,
		ownedGate,
	]);
}
