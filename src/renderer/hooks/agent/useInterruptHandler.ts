/**
 * useInterruptHandler - extracted from App.tsx
 *
 * Handles interrupting/stopping running AI processes:
 *   - Sends SIGINT to active process (AI or terminal mode)
 *   - Cancels pending synopsis before interrupting
 *   - Cleans up thinking/tool logs from interrupted tabs
 *   - Processes execution queue after interruption
 *   - Falls back to force-kill if graceful interrupt fails
 *
 * PERF: Reads activeSession via getState() at interrupt time so App does not
 * re-render when the active session / session list changes. Non-store deps are
 * kept in a ref so handleInterrupt keeps a stable identity.
 *
 * Reads from: sessionStore (activeSession, sessions) at event time
 */

import { useCallback, useRef } from 'react';
import type { Session, LogEntry, QueuedItem, SessionState } from '../../types';
import { useSessionStore, selectActiveSession } from '../../stores/sessionStore';
import { generateId } from '../../utils/ids';
import {
	getActiveTab,
	markTabRunningQueuedItem,
	resolveQueuedItemTarget,
} from '../../utils/tabHelpers';
import { nextRunnableQueueItem, takeNextRunnableQueueItem } from '../../utils/executionQueue';
import { logger } from '../../utils/logger';

// ============================================================================
// Dependencies interface
// ============================================================================

export interface UseInterruptHandlerDeps {
	/** Ref to latest sessions array (avoids stale closure) */
	sessionsRef: React.RefObject<Session[]>;
	/** Cancel any pending synopsis processes for a session */
	cancelPendingSynopsis: (sessionId: string) => Promise<void>;
	/** Process next queued execution item */
	processQueuedItem: (sessionId: string, item: QueuedItem) => Promise<void>;
}

// ============================================================================
// Return type
// ============================================================================

export interface UseInterruptHandlerReturn {
	/** Interrupt the active session's running process */
	handleInterrupt: () => Promise<void>;
}

// ============================================================================
// Hook implementation
// ============================================================================

export function useInterruptHandler(deps: UseInterruptHandlerDeps): UseInterruptHandlerReturn {
	const depsRef = useRef(deps);
	depsRef.current = deps;

	// ========================================================================
	// handleInterrupt - interrupt the active process
	// ========================================================================
	const handleInterrupt = useCallback(async () => {
		const activeSession = selectActiveSession(useSessionStore.getState());
		if (!activeSession) return;

		const { sessionsRef, cancelPendingSynopsis, processQueuedItem } = depsRef.current;
		const { setSessions } = useSessionStore.getState();

		const currentMode = activeSession.inputMode;
		const activeTab = getActiveTab(activeSession);
		const targetSessionId =
			currentMode === 'ai'
				? `${activeSession.id}-ai-${activeTab?.id || 'default'}`
				: `${activeSession.id}-terminal`;

		// Cancel any pending synopsis processes (non-critical, shouldn't block interrupt)
		try {
			await cancelPendingSynopsis(activeSession.id);
		} catch (synopsisErr) {
			logger.warn(
				'[useInterruptHandler] Failed to cancel pending synopsis:',
				undefined,
				synopsisErr
			);
		}

		try {
			// Interrupt the primary process and any forced-parallel processes for this tab.
			// Forced parallel spawns append `-fp-{timestamp}` to the session ID, so we need
			// to find and interrupt those as well.
			const interruptPromises: Promise<void>[] = [
				(window as any).maestro.process.interrupt(targetSessionId),
			];

			if (currentMode === 'ai') {
				try {
					const activeProcesses = await window.maestro.process.getActiveProcesses();
					const fpPrefix = `${targetSessionId}-fp-`;
					const fpProcesses = activeProcesses.filter((p) => p.sessionId.startsWith(fpPrefix));
					for (const fp of fpProcesses) {
						interruptPromises.push((window as any).maestro.process.interrupt(fp.sessionId));
					}
				} catch {
					// Non-critical - forced parallel lookup failure shouldn't block interrupt
				}
			}

			const results = await Promise.allSettled(interruptPromises);
			// If the primary interrupt failed, throw to trigger force-kill fallback.
			// Secondary (forced-parallel) failures are non-critical.
			if (results[0].status === 'rejected') {
				throw results[0].reason;
			}

			// Check if there are queued items to process after interrupt
			const currentSession = sessionsRef.current?.find((s) => s.id === activeSession.id);
			let queuedItemToProcess: {
				sessionId: string;
				item: QueuedItem;
			} | null = null;

			const nextRunnableOnInterrupt = currentSession
				? nextRunnableQueueItem(currentSession.executionQueue)
				: undefined;
			if (nextRunnableOnInterrupt) {
				queuedItemToProcess = {
					sessionId: activeSession.id,
					item: nextRunnableOnInterrupt,
				};
			}

			// Create canceled log entry for AI mode interrupts
			const canceledLog: LogEntry | null =
				currentMode === 'ai'
					? {
							id: generateId(),
							timestamp: Date.now(),
							source: 'system',
							text: 'Canceled by user',
						}
					: null;

			// Set state to idle with full cleanup, or process next queued item
			setSessions((prev) =>
				prev.map((s) => {
					if (s.id !== activeSession.id) return s;

					// If there are runnable (non-held) queued items, start the next one
					const { item: nextItem, remaining: remainingQueue } = takeNextRunnableQueueItem(
						s.executionQueue
					);
					if (nextItem) {
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

						// Set the interrupted tab(s) to idle (with the canceled log) and the
						// queued item's target tab to busy. When the target is an orphan (the
						// user closed it while this message was still queued), it lives in
						// orphanedThinkingTabs - route busy-state + the user log THERE so the
						// background send never leaks onto the active tab.
						const updatedAiTabs = s.aiTabs.map((tab) => {
							if (tab.id === target.tabId) {
								return markTabRunningQueuedItem(tab, nextItem);
							}
							// Set any other busy tabs to idle (they were interrupted) and add canceled log
							// Also clear any thinking/tool logs since the process was interrupted
							if (tab.state === 'busy') {
								const logsWithoutThinkingOrTools = tab.logs.filter(
									(log) => log.source !== 'thinking' && log.source !== 'tool'
								);
								const updatedLogs = canceledLog
									? [...logsWithoutThinkingOrTools, canceledLog]
									: logsWithoutThinkingOrTools;
								return {
									...tab,
									state: 'idle' as const,
									thinkingStartTime: undefined,
									logs: updatedLogs,
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

					// No queued items, just go to idle and add canceled log to the active tab
					// Also clear any thinking/tool logs since the process was interrupted
					const activeTabForCancel = getActiveTab(s);
					const updatedAiTabsForIdle = s.aiTabs.map((tab) => {
						if (tab.id === activeTabForCancel?.id || tab.state === 'busy') {
							const logsWithoutThinkingOrTools = tab.logs.filter(
								(log) => log.source !== 'thinking' && log.source !== 'tool'
							);
							return {
								...tab,
								state: 'idle' as const,
								thinkingStartTime: undefined,
								logs:
									canceledLog && tab.id === activeTabForCancel?.id
										? [...logsWithoutThinkingOrTools, canceledLog]
										: logsWithoutThinkingOrTools,
							};
						}
						return tab;
					});

					return {
						...s,
						state: 'idle',
						busySource: undefined,
						thinkingStartTime: undefined,
						aiTabs: updatedAiTabsForIdle,
					};
				})
			);

			// Process the queued item after state update
			if (queuedItemToProcess) {
				setTimeout(() => {
					processQueuedItem(queuedItemToProcess!.sessionId, queuedItemToProcess!.item).catch(
						(err) =>
							logger.error('[useInterruptHandler] Failed to process queued item:', undefined, err)
					);
				}, 0);
			}
		} catch (error) {
			logger.error('Failed to interrupt process:', undefined, error);

			// If interrupt fails, offer to kill the process
			const shouldKill = confirm(
				'Failed to interrupt the process gracefully. Would you like to force kill it?\n\n' +
					'Warning: This may cause data loss or leave the process in an inconsistent state.'
			);

			if (shouldKill) {
				try {
					// Kill primary process and any forced-parallel processes
					const killPromises: Promise<void>[] = [
						(window as any).maestro.process.kill(targetSessionId),
					];
					if (currentMode === 'ai') {
						try {
							const activeProcesses = await window.maestro.process.getActiveProcesses();
							const fpPrefix = `${targetSessionId}-fp-`;
							for (const fp of activeProcesses.filter((p) => p.sessionId.startsWith(fpPrefix))) {
								killPromises.push((window as any).maestro.process.kill(fp.sessionId));
							}
						} catch {
							// Non-critical
						}
					}
					const killResults = await Promise.allSettled(killPromises);
					// If the primary kill failed, throw to trigger kill error handling.
					// Secondary (forced-parallel) failures are non-critical.
					if (killResults[0].status === 'rejected') {
						throw killResults[0].reason;
					}

					const killLog: LogEntry = {
						id: generateId(),
						timestamp: Date.now(),
						source: 'system',
						text: 'Process forcefully terminated',
					};

					// Check if there are queued items to process after kill
					const currentSessionForKill = sessionsRef.current?.find((s) => s.id === activeSession.id);
					let queuedItemAfterKill: {
						sessionId: string;
						item: QueuedItem;
					} | null = null;

					const nextRunnableAfterKill = currentSessionForKill
						? nextRunnableQueueItem(currentSessionForKill.executionQueue)
						: undefined;
					if (nextRunnableAfterKill) {
						queuedItemAfterKill = {
							sessionId: activeSession.id,
							item: nextRunnableAfterKill,
						};
					}

					setSessions((prev) =>
						prev.map((s) => {
							if (s.id !== activeSession.id) return s;

							// Add kill log to the appropriate place and clear thinking/tool logs
							const updatedSession = { ...s };
							if (currentMode === 'ai') {
								const tab = getActiveTab(s);
								if (tab) {
									updatedSession.aiTabs = s.aiTabs.map((t) => {
										if (t.id === tab.id) {
											const logsWithoutThinkingOrTools = t.logs.filter(
												(log) => log.source !== 'thinking' && log.source !== 'tool'
											);
											return {
												...t,
												logs: [...logsWithoutThinkingOrTools, killLog],
											};
										}
										return t;
									});
								}
							} else {
								// TODO: Remove shellLogs once terminal tabs migration is complete
								if (!s.terminalTabs?.length) {
									updatedSession.shellLogs = [...s.shellLogs, killLog];
								}
							}

							// If there are runnable (non-held) queued items, start the next one
							const { item: nextItem, remaining: remainingQueue } = takeNextRunnableQueueItem(
								s.executionQueue
							);
							if (nextItem) {
								const target = resolveQueuedItemTarget(updatedSession, nextItem);

								if (!target) {
									return {
										...updatedSession,
										state: 'busy' as SessionState,
										busySource: 'ai',
										executionQueue: remainingQueue,
										thinkingStartTime: Date.now(),
										currentCycleTokens: 0,
										currentCycleBytes: 0,
									};
								}

								// Set tabs appropriately and clear thinking/tool logs from interrupted
								// tabs. When the target is an orphan (the user closed it while this
								// message was still queued), route busy-state + the user log to
								// orphanedThinkingTabs so the background send never leaks onto the
								// active tab.
								const updatedAiTabs = updatedSession.aiTabs.map((tab) => {
									if (tab.id === target.tabId) {
										return markTabRunningQueuedItem(tab, nextItem);
									}
									if (tab.state === 'busy') {
										const logsWithoutThinkingOrTools = tab.logs.filter(
											(log) => log.source !== 'thinking' && log.source !== 'tool'
										);
										return {
											...tab,
											state: 'idle' as const,
											thinkingStartTime: undefined,
											logs: logsWithoutThinkingOrTools,
										};
									}
									return tab;
								});

								const updatedOrphans =
									target.location === 'orphan' && updatedSession.orphanedThinkingTabs
										? updatedSession.orphanedThinkingTabs.map((tab) =>
												tab.id === target.tabId ? markTabRunningQueuedItem(tab, nextItem) : tab
											)
										: updatedSession.orphanedThinkingTabs;

								return {
									...updatedSession,
									state: 'busy' as SessionState,
									busySource: 'ai',
									aiTabs: updatedAiTabs,
									...(updatedOrphans !== updatedSession.orphanedThinkingTabs && {
										orphanedThinkingTabs: updatedOrphans,
									}),
									executionQueue: remainingQueue,
									thinkingStartTime: Date.now(),
									currentCycleTokens: 0,
									currentCycleBytes: 0,
								};
							}

							// No queued items, just go to idle and clear thinking logs
							if (currentMode === 'ai') {
								return {
									...updatedSession,
									state: 'idle',
									busySource: undefined,
									thinkingStartTime: undefined,
									aiTabs: updatedSession.aiTabs.map((t) => {
										if (t.state === 'busy') {
											const logsWithoutThinkingOrTools = t.logs.filter(
												(log) => log.source !== 'thinking' && log.source !== 'tool'
											);
											return {
												...t,
												state: 'idle' as const,
												thinkingStartTime: undefined,
												logs: logsWithoutThinkingOrTools,
											};
										}
										return t;
									}),
								};
							}
							return {
								...updatedSession,
								state: 'idle',
								busySource: undefined,
								thinkingStartTime: undefined,
							};
						})
					);

					// Process the queued item after state update
					if (queuedItemAfterKill) {
						setTimeout(() => {
							processQueuedItem(queuedItemAfterKill!.sessionId, queuedItemAfterKill!.item).catch(
								(err) =>
									logger.error(
										'[useInterruptHandler] Failed to process queued item after kill:',
										undefined,
										err
									)
							);
						}, 0);
					}
				} catch (killError: unknown) {
					logger.error('Failed to kill process:', undefined, killError);
					const killErrorMessage =
						killError instanceof Error ? killError.message : String(killError);
					const errorLog: LogEntry = {
						id: generateId(),
						timestamp: Date.now(),
						source: 'system',
						text: `Error: Failed to terminate process - ${killErrorMessage}`,
					};
					setSessions((prev) =>
						prev.map((s) => {
							if (s.id !== activeSession.id) return s;
							if (currentMode === 'ai') {
								const activeTabForError = getActiveTab(s);
								return {
									...s,
									state: 'idle',
									busySource: undefined,
									thinkingStartTime: undefined,
									aiTabs: s.aiTabs.map((t) => {
										if (t.id === activeTabForError?.id || t.state === 'busy') {
											const logsWithoutThinkingOrTools = t.logs.filter(
												(log) => log.source !== 'thinking' && log.source !== 'tool'
											);
											return {
												...t,
												state: 'idle' as const,
												thinkingStartTime: undefined,
												logs:
													t.id === activeTabForError?.id
														? [...logsWithoutThinkingOrTools, errorLog]
														: logsWithoutThinkingOrTools,
											};
										}
										return t;
									}),
								};
							}
							return {
								...s,
								// TODO: Remove shellLogs once terminal tabs migration is complete
								...(!s.terminalTabs?.length && { shellLogs: [...s.shellLogs, errorLog] }),
								state: 'idle',
								busySource: undefined,
								thinkingStartTime: undefined,
							};
						})
					);
				}
			}
		}
	}, []);

	return { handleInterrupt };
}
