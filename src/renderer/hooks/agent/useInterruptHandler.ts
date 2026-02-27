/**
 * useInterruptHandler — extracted from App.tsx
 *
 * Handles interrupting/stopping running AI processes:
 *   - Sends SIGINT to active process (AI or terminal mode)
 *   - Cancels pending synopsis before interrupting
 *   - Cleans up thinking/tool logs from interrupted tabs
 *   - Processes execution queue after interruption
 *   - Falls back to force-kill if graceful interrupt fails
 *
 * Reads from: sessionStore (activeSession, sessions)
 */

import { useCallback } from 'react';
import type { Session, LogEntry, QueuedItem, SessionState } from '../../types';
import { useSessionStore, selectActiveSession } from '../../stores/sessionStore';
import { generateId } from '../../utils/ids';
import { getActiveTab } from '../../utils/tabHelpers';

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
	const { sessionsRef, cancelPendingSynopsis, processQueuedItem } = deps;

	// --- Reactive subscriptions ---
	const activeSession = useSessionStore(selectActiveSession);

	// --- Store actions (stable via getState) ---
	const { setSessions } = useSessionStore.getState();

	// ========================================================================
	// handleInterrupt — interrupt the active process
	// ========================================================================
	const handleInterrupt = useCallback(async () => {
		if (!activeSession) return;

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
			console.warn('[useInterruptHandler] Failed to cancel pending synopsis:', synopsisErr);
		}

		try {
			// Send interrupt signal (Ctrl+C)
			await (window as any).maestro.process.interrupt(targetSessionId);

			// Check if there are queued items to process after interrupt
			const currentSession = sessionsRef.current?.find((s) => s.id === activeSession.id);
			let queuedItemToProcess: {
				sessionId: string;
				item: QueuedItem;
			} | null = null;

			if (currentSession && currentSession.executionQueue.length > 0) {
				queuedItemToProcess = {
					sessionId: activeSession.id,
					item: currentSession.executionQueue[0],
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

					// If there are queued items, start processing the next one
					if (s.executionQueue.length > 0) {
						const [nextItem, ...remainingQueue] = s.executionQueue;
						const targetTab = s.aiTabs.find((tab) => tab.id === nextItem.tabId) || getActiveTab(s);

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

						// Set the interrupted tab to idle, and the target tab for queued item to busy
						// Also add the canceled log to the interrupted tab
						let updatedAiTabs = s.aiTabs.map((tab) => {
							if (tab.id === targetTab.id) {
								return {
									...tab,
									state: 'busy' as const,
									thinkingStartTime: Date.now(),
								};
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

						// For message items, add a log entry to the target tab
						if (nextItem.type === 'message' && nextItem.text) {
							const logEntry: LogEntry = {
								id: generateId(),
								timestamp: Date.now(),
								source: 'user',
								text: nextItem.text,
								images: nextItem.images,
							};
							updatedAiTabs = updatedAiTabs.map((tab) =>
								tab.id === targetTab.id ? { ...tab, logs: [...tab.logs, logEntry] } : tab
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
						(err) => console.error('[useInterruptHandler] Failed to process queued item:', err)
					);
				}, 0);
			}
		} catch (error) {
			console.error('Failed to interrupt process:', error);

			// If interrupt fails, offer to kill the process
			const shouldKill = confirm(
				'Failed to interrupt the process gracefully. Would you like to force kill it?\n\n' +
					'Warning: This may cause data loss or leave the process in an inconsistent state.'
			);

			if (shouldKill) {
				try {
					await (window as any).maestro.process.kill(targetSessionId);

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

					if (currentSessionForKill && currentSessionForKill.executionQueue.length > 0) {
						queuedItemAfterKill = {
							sessionId: activeSession.id,
							item: currentSessionForKill.executionQueue[0],
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
								updatedSession.shellLogs = [...s.shellLogs, killLog];
							}

							// If there are queued items, start processing the next one
							if (s.executionQueue.length > 0) {
								const [nextItem, ...remainingQueue] = s.executionQueue;
								const targetTab =
									s.aiTabs.find((tab) => tab.id === nextItem.tabId) || getActiveTab(s);

								if (!targetTab) {
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

								// Set tabs appropriately and clear thinking/tool logs from interrupted tabs
								let updatedAiTabs = updatedSession.aiTabs.map((tab) => {
									if (tab.id === targetTab.id) {
										return {
											...tab,
											state: 'busy' as const,
											thinkingStartTime: Date.now(),
										};
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

								// For message items, add a log entry to the target tab
								if (nextItem.type === 'message' && nextItem.text) {
									const logEntry: LogEntry = {
										id: generateId(),
										timestamp: Date.now(),
										source: 'user',
										text: nextItem.text,
										images: nextItem.images,
									};
									updatedAiTabs = updatedAiTabs.map((tab) =>
										tab.id === targetTab.id ? { ...tab, logs: [...tab.logs, logEntry] } : tab
									);
								}

								return {
									...updatedSession,
									state: 'busy' as SessionState,
									busySource: 'ai',
									aiTabs: updatedAiTabs,
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
									console.error(
										'[useInterruptHandler] Failed to process queued item after kill:',
										err
									)
							);
						}, 0);
					}
				} catch (killError: unknown) {
					console.error('Failed to kill process:', killError);
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
								shellLogs: [...s.shellLogs, errorLog],
								state: 'idle',
								busySource: undefined,
								thinkingStartTime: undefined,
							};
						})
					);
				}
			}
		}
	}, [activeSession, setSessions, cancelPendingSynopsis, sessionsRef, processQueuedItem]);

	return { handleInterrupt };
}
