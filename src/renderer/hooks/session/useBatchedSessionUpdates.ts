/**
 * useBatchedSessionUpdates.ts
 *
 * A hook that batches session state updates to reduce React re-renders.
 * During AI streaming, IPC handlers can trigger 100+ state updates per second.
 * This hook accumulates updates in a ref and flushes them on a fixed cadence.
 *
 * Features:
 * - Configurable flush interval (default 200ms)
 * - Support for multiple update types: appendLog, setStatus, updateUsage, etc.
 * - Proper ordering of updates within each flush
 * - Immediate flush capability for critical moments (user input, session switch)
 * - Automatic flush on unmount
 */

import { useRef, useCallback, useEffect, useMemo } from 'react';
import type { Session, SessionState, UsageStats, LogEntry } from '../../types';
import { useSessionStore } from '../../stores/sessionStore';
import { logger } from '../../utils/logger';

// Default flush interval in milliseconds. 200ms is the sweet spot we landed on:
// - 150ms collided with high-throughput streams (jitter from setInterval drift
//   produced visible micro-stutters during peak agent output)
// - 250ms is perceptibly laggy for users typing in the input area
// - 200ms keeps streaming smooth without measurable input latency
export const DEFAULT_BATCH_FLUSH_INTERVAL = 200;

/**
 * Accumulated log data for efficient string concatenation
 */
interface LogAccumulator {
	sessionId: string;
	tabId: string | null;
	isAi: boolean;
	isStderr: boolean;
	sequence: number;
	chunks: string[];
	timestamp: number;
}

/**
 * State accumulated for a single session between flushes
 */
interface SessionAccumulator {
	// Log accumulation (for efficient string concatenation)
	logAccumulators: Map<string, LogAccumulator>; // key = `${tabId || 'shell'}-${isStderr ? 'stderr' : 'stdout'}`
	nextLogSequence: number;
	// Latest status (only last one matters)
	status?: SessionState;
	tabStatuses?: Map<string, 'idle' | 'busy'>;
	// Usage stats (accumulated)
	usageDeltas?: Map<string | null, UsageStats>; // key = tabId or null for session-level
	// Context percentage (always uses latest value)
	contextUsage?: number;
	// Tabs to mark as delivered
	deliveredTabs?: Set<string>;
	// Cycle metrics (accumulated)
	cycleBytesDelta?: number;
	cycleTokensDelta?: number;
	// Unread state per tab
	unreadTabs?: Map<string, boolean>;
}

/**
 * Public interface returned by the hook
 */
export interface BatchedUpdater {
	/** Append stdout/stderr data to logs (batched) */
	appendLog: (
		sessionId: string,
		tabId: string | null,
		isAi: boolean,
		data: string,
		isStderr?: boolean
	) => void;
	/** Set session status (batched, last wins) */
	setStatus: (sessionId: string, status: SessionState) => void;
	/** Set individual tab status (batched, last wins) */
	setTabStatus: (sessionId: string, tabId: string, status: 'idle' | 'busy') => void;
	/** Update usage stats (batched, accumulated) */
	updateUsage: (sessionId: string, tabId: string | null, usage: UsageStats) => void;
	/** Update context window percentage (batched, high water mark - never decreases) */
	updateContextUsage: (sessionId: string, percentage: number) => void;
	/** Reset context window percentage to a specific value (bypasses high water mark) */
	resetContextUsage: (sessionId: string, percentage: number) => void;
	/** Mark user message as delivered (batched) */
	markDelivered: (sessionId: string, tabId: string) => void;
	/** Update bytes received in current cycle (batched, accumulated) */
	updateCycleBytes: (sessionId: string, bytes: number) => void;
	/** Update tokens in current cycle (batched, accumulated) */
	updateCycleTokens: (sessionId: string, tokens: number) => void;
	/** Mark tab as read/unread (batched, last wins) */
	markUnread: (sessionId: string, tabId: string, unread: boolean) => void;
	/** Force immediate flush of all pending updates */
	flushNow: () => void;
}

export interface UseBatchedSessionUpdatesReturn extends BatchedUpdater {
	/** Whether there are pending updates waiting to be flushed */
	hasPending: boolean;
}

/**
 * Generate a unique ID for log entries
 */
const generateId = (): string => `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

/**
 * Hook that batches session updates to reduce React re-renders.
 *
 * Uses sessionStore.setSessions() directly instead of requiring a React setState
 * function as a parameter. This decouples the batcher from the React component tree,
 * so it no longer needs to be instantiated inside a specific provider.
 *
 * @param flushInterval - How often to flush accumulated updates (default 150ms)
 * @returns BatchedUpdater with methods to queue updates and flush them
 */
export function useBatchedSessionUpdates(
	flushInterval: number = DEFAULT_BATCH_FLUSH_INTERVAL
): UseBatchedSessionUpdatesReturn {
	// Accumulated updates per session
	const accumulatorRef = useRef<Map<string, SessionAccumulator>>(new Map());
	// Timer ID for periodic flushing
	const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
	// Track if there are pending updates
	const hasPendingRef = useRef(false);

	/**
	 * Get or create accumulator for a session
	 */
	const getAccumulator = useCallback((sessionId: string): SessionAccumulator => {
		let acc = accumulatorRef.current.get(sessionId);
		if (!acc) {
			acc = { logAccumulators: new Map(), nextLogSequence: 0 };
			accumulatorRef.current.set(sessionId, acc);
		}
		return acc;
	}, []);

	/**
	 * Apply all accumulated updates to sessions state
	 */
	const flush = useCallback(() => {
		const updates = accumulatorRef.current;
		if (updates.size === 0) {
			hasPendingRef.current = false;
			return;
		}

		// Clear the accumulator before applying updates (to avoid race conditions)
		accumulatorRef.current = new Map();
		hasPendingRef.current = false;

		useSessionStore.getState().setSessions((prev: Session[]) => {
			// PERF: Track whether any session was actually modified.
			// If no session in prev matched an accumulator entry, return prev
			// unchanged to preserve referential identity and skip a React re-render.
			// This avoids ~7 unnecessary re-renders/sec when agents stream data for
			// sessions that were removed between accumulation and flush.
			let anyChanged = false;

			const next = prev.map((session) => {
				const acc = updates.get(session.id);
				if (!acc) return session;

				anyChanged = true;
				let updatedSession = { ...session };

				// Apply log accumulations
				if (acc.logAccumulators.size > 0) {
					// Process AI tab logs
					const aiTabLogs = new Map<
						string,
						{ data: string; isStderr: boolean; timestamp: number; sequence: number }[]
					>();
					let shellStdout = '';
					let shellStderr = '';
					let shellStdoutTimestamp = 0;
					let shellStderrTimestamp = 0;

					for (const [_key, logAcc] of acc.logAccumulators) {
						const combinedData = logAcc.chunks.join('');
						if (!combinedData) continue;

						if (logAcc.isAi && logAcc.tabId) {
							// Each accumulator is already keyed by source. Keep those
							// chunks separate so stderr cannot absorb assistant stdout.
							const logsForTab = aiTabLogs.get(logAcc.tabId);
							const entry = {
								data: combinedData,
								isStderr: logAcc.isStderr,
								timestamp: logAcc.timestamp,
								sequence: logAcc.sequence,
							};
							if (logsForTab) {
								logsForTab.push(entry);
							} else {
								aiTabLogs.set(logAcc.tabId, [entry]);
							}
						} else {
							// Shell log
							if (logAcc.isStderr) {
								shellStderr += combinedData;
								shellStderrTimestamp = Math.max(shellStderrTimestamp, logAcc.timestamp);
							} else {
								shellStdout += combinedData;
								shellStdoutTimestamp = Math.max(shellStdoutTimestamp, logAcc.timestamp);
							}
						}
					}

					// Apply AI tab logs
					if (aiTabLogs.size > 0 && updatedSession.aiTabs) {
						// When the session's resolved Claude mode is interactive, tag
						// non-stderr entries with renderStyle: 'text-stream' so the
						// "Captured via interactive TUI" footer pill renders on them.
						// stderr stays untagged — error frames aren't interactive output.
						const isInteractive = updatedSession.claudeInteractive?.mode === 'interactive';

						updatedSession = {
							...updatedSession,
							aiTabs: updatedSession.aiTabs.map((tab) => {
								const logDataEntries = aiTabLogs.get(tab.id);
								if (!logDataEntries) return tab;

								logDataEntries.sort(
									(first, second) =>
										first.timestamp - second.timestamp || first.sequence - second.sequence
								);
								// ThinkingMode contract — inline clear point.
								// When new assistant text arrives, drop transient thinking/tool entries
								// from prior reasoning so the final answer replaces them. The matching
								// exit-time clear lives in useAgentListeners → cleanupExitedTabLogs.
								// Sticky mode opts out of BOTH clear points.
								const existingLogs = tab.logs.filter((log) => {
									if (log.source === 'thinking' || log.source === 'tool') {
										return tab.showThinking === 'sticky';
									}
									return true;
								});
								let updatedLogs = existingLogs;
								for (const logData of logDataEntries) {
									const lastLog = updatedLogs[updatedLogs.length - 1];
									// Determine the source based on stderr flag
									const logSource = logData.isStderr ? 'stderr' : 'stdout';

									// Defensive: never coalesce streamed output into a non-stream entry
									// (error/system/tool/user/thinking). The source-equality check below already
									// excludes these in theory, but a UI bug exists where assistant text gets
									// concatenated into an error bubble's text. Belt-and-suspenders allowlist
									// + a warn lets us catch the upstream cause if it ever fires.
									const isCoalescableSource =
										lastLog?.source === 'stdout' || lastLog?.source === 'stderr';
									if (lastLog && !isCoalescableSource && lastLog.source === logSource) {
										logger.warn(
											'[useBatchedSessionUpdates] Refusing to coalesce streamed output into non-stream log entry',
											undefined,
											{ tabId: tab.id, lastLogSource: lastLog.source, logSource }
										);
									}

									// Time-based grouping for AI output (500ms window) - only group same source types
									const shouldGroup =
										lastLog &&
										isCoalescableSource &&
										lastLog.source === logSource &&
										logData.timestamp - lastLog.timestamp < 500;

									const shouldTagInteractive = isInteractive && !logData.isStderr;

									if (shouldGroup) {
										updatedLogs = [...updatedLogs];
										updatedLogs[updatedLogs.length - 1] = {
											...lastLog,
											text: lastLog.text + logData.data,
											...(shouldTagInteractive ? { renderStyle: 'text-stream' } : {}),
										};
									} else {
										const newLog: LogEntry = {
											id: generateId(),
											timestamp: logData.timestamp,
											source: logSource,
											text: logData.data,
											...(shouldTagInteractive ? { renderStyle: 'text-stream' } : {}),
										};
										updatedLogs = [...updatedLogs, newLog];
									}
								}

								return { ...tab, logs: updatedLogs };
							}),
						};
					}

					// Apply shell logs (legacy fallback — only when no terminal tabs present)
					// TODO: Remove shellLogs once terminal tabs migration is complete
					if ((shellStdout || shellStderr) && !updatedSession.terminalTabs?.length) {
						const shellLogs = [...updatedSession.shellLogs];

						if (shellStdout) {
							const lastLog = shellLogs[shellLogs.length - 1];
							const shouldGroup =
								lastLog && lastLog.source === 'stdout' && updatedSession.state === 'busy';

							if (shouldGroup) {
								shellLogs[shellLogs.length - 1] = {
									...lastLog,
									text: lastLog.text + shellStdout,
								};
							} else {
								shellLogs.push({
									id: generateId(),
									timestamp: shellStdoutTimestamp || Date.now(),
									source: 'stdout',
									text: shellStdout,
								});
							}
						}

						if (shellStderr) {
							const lastLog = shellLogs[shellLogs.length - 1];
							const shouldGroup =
								lastLog && lastLog.source === 'stderr' && updatedSession.state === 'busy';

							if (shouldGroup) {
								shellLogs[shellLogs.length - 1] = {
									...lastLog,
									text: lastLog.text + shellStderr,
								};
							} else {
								shellLogs.push({
									id: generateId(),
									timestamp: shellStderrTimestamp || Date.now(),
									source: 'stderr',
									text: shellStderr,
								});
							}
						}

						updatedSession = { ...updatedSession, shellLogs };
					}
				}

				// Apply status update
				if (acc.status !== undefined) {
					updatedSession = { ...updatedSession, state: acc.status };
				}

				// Apply tab status updates
				if (acc.tabStatuses && acc.tabStatuses.size > 0 && updatedSession.aiTabs) {
					updatedSession = {
						...updatedSession,
						aiTabs: updatedSession.aiTabs.map((tab) => {
							const newStatus = acc.tabStatuses?.get(tab.id);
							if (newStatus !== undefined) {
								return { ...tab, state: newStatus };
							}
							return tab;
						}),
					};
				}

				// Apply usage stats
				if (acc.usageDeltas && acc.usageDeltas.size > 0) {
					// Session-level usage
					const sessionUsageDelta = acc.usageDeltas.get(null);
					if (sessionUsageDelta) {
						const existing = updatedSession.usageStats;
						updatedSession = {
							...updatedSession,
							usageStats: {
								inputTokens: (existing?.inputTokens || 0) + sessionUsageDelta.inputTokens,
								outputTokens: (existing?.outputTokens || 0) + sessionUsageDelta.outputTokens,
								cacheReadInputTokens:
									(existing?.cacheReadInputTokens || 0) + sessionUsageDelta.cacheReadInputTokens,
								cacheCreationInputTokens:
									(existing?.cacheCreationInputTokens || 0) +
									sessionUsageDelta.cacheCreationInputTokens,
								totalCostUsd: (existing?.totalCostUsd || 0) + sessionUsageDelta.totalCostUsd,
								reasoningTokens:
									(existing?.reasoningTokens || 0) + (sessionUsageDelta.reasoningTokens || 0),
								contextWindow: sessionUsageDelta.contextWindow,
							},
						};
					}

					// Tab-level usage
					if (updatedSession.aiTabs) {
						updatedSession = {
							...updatedSession,
							aiTabs: updatedSession.aiTabs.map((tab) => {
								const tabUsageDelta = acc.usageDeltas?.get(tab.id);
								if (!tabUsageDelta) return tab;

								const existing = tab.usageStats;
								// An "output-only" delta carries new output tokens but zero
								// input/cache. Copilot CLI streams these per-turn (each
								// assistant.message reports only outputTokens; the real
								// input/cache/context snapshot lands once on exit via disk
								// reconciliation). Replacing input/cache with these zeros would
								// wipe the reconciled context-window gauge to 0 the moment the
								// next turn starts producing output. Preserve the prior snapshot
								// for output-only deltas; a real usage report (any input or
								// cache) still replaces it. No legitimate full snapshot consumes
								// zero input AND zero cache while producing output, so this is
								// safe for every agent.
								const isOutputOnlyDelta =
									tabUsageDelta.inputTokens === 0 &&
									tabUsageDelta.cacheReadInputTokens === 0 &&
									tabUsageDelta.cacheCreationInputTokens === 0 &&
									tabUsageDelta.outputTokens > 0;
								return {
									...tab,
									usageStats: {
										inputTokens: isOutputOnlyDelta
											? (existing?.inputTokens ?? 0)
											: tabUsageDelta.inputTokens, // Current (not accumulated)
										cacheReadInputTokens: isOutputOnlyDelta
											? (existing?.cacheReadInputTokens ?? 0)
											: tabUsageDelta.cacheReadInputTokens,
										cacheCreationInputTokens: isOutputOnlyDelta
											? (existing?.cacheCreationInputTokens ?? 0)
											: tabUsageDelta.cacheCreationInputTokens,
										contextWindow: tabUsageDelta.contextWindow || existing?.contextWindow || 0,
										outputTokens: tabUsageDelta.outputTokens, // Current (not accumulated)
										totalCostUsd: (existing?.totalCostUsd || 0) + tabUsageDelta.totalCostUsd,
										reasoningTokens: tabUsageDelta.reasoningTokens,
									},
								};
							}),
						};
					}
				}

				// Apply context usage - always use the latest reported value
				// Context percentage reflects CURRENT context usage from Claude, not historical max
				if (acc.contextUsage !== undefined) {
					updatedSession = { ...updatedSession, contextUsage: acc.contextUsage };
				}

				// Apply delivered markers
				if (acc.deliveredTabs && acc.deliveredTabs.size > 0 && updatedSession.aiTabs) {
					updatedSession = {
						...updatedSession,
						aiTabs: updatedSession.aiTabs.map((tab) => {
							if (!acc.deliveredTabs?.has(tab.id)) return tab;

							// Find the last undelivered user message and mark it delivered
							const lastUserIndex = tab.logs
								.map((log, i) => ({ log, i }))
								.filter(({ log }) => log.source === 'user' && !log.delivered)
								.pop()?.i;

							if (lastUserIndex === undefined) return tab;

							return {
								...tab,
								logs: tab.logs.map((log, i) =>
									i === lastUserIndex ? { ...log, delivered: true } : log
								),
							};
						}),
					};
				}

				// Apply cycle bytes
				if (acc.cycleBytesDelta !== undefined) {
					updatedSession = {
						...updatedSession,
						currentCycleBytes: (updatedSession.currentCycleBytes || 0) + acc.cycleBytesDelta,
					};
				}

				// Apply cycle tokens
				if (acc.cycleTokensDelta !== undefined) {
					updatedSession = {
						...updatedSession,
						currentCycleTokens: (updatedSession.currentCycleTokens || 0) + acc.cycleTokensDelta,
					};
				}

				// Apply unread markers
				if (acc.unreadTabs && acc.unreadTabs.size > 0 && updatedSession.aiTabs) {
					updatedSession = {
						...updatedSession,
						aiTabs: updatedSession.aiTabs.map((tab) => {
							const unread = acc.unreadTabs?.get(tab.id);
							if (unread === undefined) return tab;
							return { ...tab, hasUnread: unread };
						}),
					};
				}

				return updatedSession;
			});

			return anyChanged ? next : prev;
		});
	}, []);

	/**
	 * Start the flush interval timer
	 */
	useEffect(() => {
		timerRef.current = setInterval(() => {
			if (hasPendingRef.current) {
				flush();
			}
		}, flushInterval);

		return () => {
			if (timerRef.current) {
				clearInterval(timerRef.current);
				timerRef.current = null;
			}
			// Flush any pending updates on unmount
			flush();
		};
	}, [flushInterval, flush]);

	/**
	 * Queue methods (memoized for stability)
	 */
	const appendLog = useCallback(
		(
			sessionId: string,
			tabId: string | null,
			isAi: boolean,
			data: string,
			isStderr: boolean = false
		) => {
			if (!data) return;

			const acc = getAccumulator(sessionId);
			const key = `${tabId || 'shell'}-${isStderr ? 'stderr' : 'stdout'}`;

			let logAcc = acc.logAccumulators.get(key);
			if (!logAcc) {
				logAcc = {
					sessionId,
					tabId,
					isAi,
					isStderr,
					chunks: [],
					sequence: acc.nextLogSequence++,
					timestamp: Date.now(),
				};
				acc.logAccumulators.set(key, logAcc);
			}

			logAcc.chunks.push(data);
			logAcc.timestamp = Date.now();
			hasPendingRef.current = true;
		},
		[getAccumulator]
	);

	const setStatus = useCallback(
		(sessionId: string, status: SessionState) => {
			const acc = getAccumulator(sessionId);
			acc.status = status;
			hasPendingRef.current = true;
		},
		[getAccumulator]
	);

	const setTabStatus = useCallback(
		(sessionId: string, tabId: string, status: 'idle' | 'busy') => {
			const acc = getAccumulator(sessionId);
			if (!acc.tabStatuses) {
				acc.tabStatuses = new Map();
			}
			acc.tabStatuses.set(tabId, status);
			hasPendingRef.current = true;
		},
		[getAccumulator]
	);

	const updateUsage = useCallback(
		(sessionId: string, tabId: string | null, usage: UsageStats) => {
			const acc = getAccumulator(sessionId);
			if (!acc.usageDeltas) {
				acc.usageDeltas = new Map();
			}

			const existing = acc.usageDeltas.get(tabId);
			if (existing) {
				// For tab-level: inputTokens etc. are current (not accumulated), but outputTokens and cost are accumulated
				if (tabId !== null) {
					acc.usageDeltas.set(tabId, {
						inputTokens: usage.inputTokens,
						cacheReadInputTokens: usage.cacheReadInputTokens,
						cacheCreationInputTokens: usage.cacheCreationInputTokens,
						contextWindow: usage.contextWindow,
						outputTokens: usage.outputTokens,
						totalCostUsd: existing.totalCostUsd + usage.totalCostUsd,
						reasoningTokens: usage.reasoningTokens,
					});
				} else {
					// Session-level: all values are accumulated
					acc.usageDeltas.set(tabId, {
						inputTokens: existing.inputTokens + usage.inputTokens,
						outputTokens: existing.outputTokens + usage.outputTokens,
						cacheReadInputTokens: existing.cacheReadInputTokens + usage.cacheReadInputTokens,
						cacheCreationInputTokens:
							existing.cacheCreationInputTokens + usage.cacheCreationInputTokens,
						totalCostUsd: existing.totalCostUsd + usage.totalCostUsd,
						reasoningTokens: (existing.reasoningTokens || 0) + (usage.reasoningTokens || 0),
						contextWindow: usage.contextWindow,
					});
				}
			} else {
				acc.usageDeltas.set(tabId, { ...usage });
			}
			hasPendingRef.current = true;
		},
		[getAccumulator]
	);

	const updateContextUsage = useCallback(
		(sessionId: string, percentage: number) => {
			const acc = getAccumulator(sessionId);
			acc.contextUsage = percentage;
			hasPendingRef.current = true;
		},
		[getAccumulator]
	);

	// resetContextUsage now does the same as updateContextUsage since we removed high water mark
	const resetContextUsage = useCallback(
		(sessionId: string, percentage: number) => {
			const acc = getAccumulator(sessionId);
			acc.contextUsage = percentage;
			hasPendingRef.current = true;
		},
		[getAccumulator]
	);

	const markDelivered = useCallback(
		(sessionId: string, tabId: string) => {
			const acc = getAccumulator(sessionId);
			if (!acc.deliveredTabs) {
				acc.deliveredTabs = new Set();
			}
			acc.deliveredTabs.add(tabId);
			hasPendingRef.current = true;
		},
		[getAccumulator]
	);

	const updateCycleBytes = useCallback(
		(sessionId: string, bytes: number) => {
			const acc = getAccumulator(sessionId);
			acc.cycleBytesDelta = (acc.cycleBytesDelta || 0) + bytes;
			hasPendingRef.current = true;
		},
		[getAccumulator]
	);

	const updateCycleTokens = useCallback(
		(sessionId: string, tokens: number) => {
			const acc = getAccumulator(sessionId);
			acc.cycleTokensDelta = (acc.cycleTokensDelta || 0) + tokens;
			hasPendingRef.current = true;
		},
		[getAccumulator]
	);

	const markUnread = useCallback(
		(sessionId: string, tabId: string, unread: boolean) => {
			const acc = getAccumulator(sessionId);
			if (!acc.unreadTabs) {
				acc.unreadTabs = new Map();
			}
			acc.unreadTabs.set(tabId, unread);
			hasPendingRef.current = true;
		},
		[getAccumulator]
	);

	const flushNow = useCallback(() => {
		flush();
	}, [flush]);

	// Return memoized object to prevent unnecessary re-renders in consumers
	return useMemo(
		() => ({
			appendLog,
			setStatus,
			setTabStatus,
			updateUsage,
			updateContextUsage,
			resetContextUsage,
			markDelivered,
			updateCycleBytes,
			updateCycleTokens,
			markUnread,
			flushNow,
			get hasPending() {
				return hasPendingRef.current;
			},
		}),
		[
			appendLog,
			setStatus,
			setTabStatus,
			updateUsage,
			updateContextUsage,
			resetContextUsage,
			markDelivered,
			updateCycleBytes,
			updateCycleTokens,
			markUnread,
			flushNow,
		]
	);
}
