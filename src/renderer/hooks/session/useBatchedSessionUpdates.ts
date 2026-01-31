/**
 * useBatchedSessionUpdates.ts
 *
 * A hook that batches session state updates to reduce React re-renders.
 * During AI streaming, IPC handlers can trigger 100+ state updates per second.
 * This hook accumulates updates in a ref and flushes them every 150ms.
 *
 * Features:
 * - Configurable flush interval (default 150ms)
 * - Support for multiple update types: appendLog, setStatus, updateUsage, etc.
 * - Proper ordering of updates within each flush
 * - Immediate flush capability for critical moments (user input, session switch)
 * - Automatic flush on unmount
 */

import { useRef, useCallback, useEffect, useMemo } from 'react';
import type { Session, SessionState, UsageStats, LogEntry } from '../../types';

// Default flush interval in milliseconds (imperceptible to users)
export const DEFAULT_BATCH_FLUSH_INTERVAL = 150;

/**
 * Types of updates that can be batched
 */
type _UpdateType =
	| {
			type: 'appendLog';
			sessionId: string;
			tabId: string | null;
			isAi: boolean;
			data: string;
			isStderr?: boolean;
	  }
	| { type: 'setStatus'; sessionId: string; tabId: string | null; status: SessionState }
	| { type: 'setTabStatus'; sessionId: string; tabId: string; status: 'idle' | 'busy' }
	| { type: 'updateUsage'; sessionId: string; tabId: string | null; usage: UsageStats }
	| { type: 'updateContextUsage'; sessionId: string; percentage: number }
	| { type: 'markDelivered'; sessionId: string; tabId: string }
	| { type: 'updateCycleBytes'; sessionId: string; bytes: number }
	| { type: 'updateCycleTokens'; sessionId: string; tokens: number }
	| { type: 'markUnread'; sessionId: string; tabId: string; unread: boolean };

/**
 * Accumulated log data for efficient string concatenation
 */
interface LogAccumulator {
	sessionId: string;
	tabId: string | null;
	isAi: boolean;
	isStderr: boolean;
	chunks: string[];
	timestamp: number;
}

/**
 * State accumulated for a single session between flushes
 */
interface SessionAccumulator {
	// Log accumulation (for efficient string concatenation)
	logAccumulators: Map<string, LogAccumulator>; // key = `${tabId || 'shell'}-${isStderr ? 'stderr' : 'stdout'}`
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
 * @param setSessions - The React setState function for sessions
 * @param flushInterval - How often to flush accumulated updates (default 150ms)
 * @returns BatchedUpdater with methods to queue updates and flush them
 */
export function useBatchedSessionUpdates(
	setSessions: React.Dispatch<React.SetStateAction<Session[]>>,
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
			acc = { logAccumulators: new Map() };
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

		setSessions((prev) => {
			return prev.map((session) => {
				const acc = updates.get(session.id);
				if (!acc) return session;

				let updatedSession = { ...session };

				// Apply log accumulations
				if (acc.logAccumulators.size > 0) {
					// Process AI tab logs
					const aiTabLogs = new Map<
						string,
						{ data: string; isStderr: boolean; timestamp: number }
					>();
					let shellStdout = '';
					let shellStderr = '';
					let shellStdoutTimestamp = 0;
					let shellStderrTimestamp = 0;

					for (const [_key, logAcc] of acc.logAccumulators) {
						const combinedData = logAcc.chunks.join('');
						if (!combinedData) continue;

						if (logAcc.isAi && logAcc.tabId) {
							// AI tab log
							const existing = aiTabLogs.get(logAcc.tabId);
							if (existing) {
								existing.data += combinedData;
								existing.timestamp = Math.max(existing.timestamp, logAcc.timestamp);
							} else {
								aiTabLogs.set(logAcc.tabId, {
									data: combinedData,
									isStderr: logAcc.isStderr,
									timestamp: logAcc.timestamp,
								});
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
						updatedSession = {
							...updatedSession,
							aiTabs: updatedSession.aiTabs.map((tab) => {
								const logData = aiTabLogs.get(tab.id);
								if (!logData) return tab;

								// Clear thinking/tool entries when new AI output arrives (final result replaces thinking)
								// BUT: if showThinking is 'sticky', preserve both thinking and tool logs
								const existingLogs = tab.logs.filter((log) => {
									if (log.source === 'thinking' || log.source === 'tool') {
										// Only preserve thinking/tool logs in sticky mode
										return tab.showThinking === 'sticky';
									}
									return true;
								});
								const lastLog = existingLogs[existingLogs.length - 1];

								// Determine the source based on stderr flag
								const logSource = logData.isStderr ? 'stderr' : 'stdout';

								// Time-based grouping for AI output (500ms window) - only group same source types
								const shouldGroup =
									lastLog &&
									lastLog.source === logSource &&
									logData.timestamp - lastLog.timestamp < 500;

								let updatedLogs: LogEntry[];
								if (shouldGroup) {
									updatedLogs = [...existingLogs];
									updatedLogs[updatedLogs.length - 1] = {
										...lastLog,
										text: lastLog.text + logData.data,
									};
								} else {
									const newLog: LogEntry = {
										id: generateId(),
										timestamp: logData.timestamp,
										source: logSource,
										text: logData.data,
									};
									updatedLogs = [...existingLogs, newLog];
								}

								return { ...tab, logs: updatedLogs };
							}),
						};
					}

					// Apply shell logs
					if (shellStdout || shellStderr) {
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
								return {
									...tab,
									usageStats: {
										inputTokens: tabUsageDelta.inputTokens, // Current (not accumulated)
										cacheReadInputTokens: tabUsageDelta.cacheReadInputTokens,
										cacheCreationInputTokens: tabUsageDelta.cacheCreationInputTokens,
										contextWindow: tabUsageDelta.contextWindow,
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
		});
	}, [setSessions]);

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
