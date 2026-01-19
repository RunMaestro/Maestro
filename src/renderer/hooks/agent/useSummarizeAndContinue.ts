/**
 * useSummarizeAndContinue Hook
 *
 * React hook for managing the "Summarize & Continue" workflow.
 * This hook handles:
 * - Extracting context from the source tab
 * - Running the summarization process
 * - Creating a new compacted tab with the summarized context
 * - Tracking progress and errors throughout the process
 * - Per-tab state tracking (allows other tabs to remain interactive)
 *
 * The new tab is created immediately to the right of the source tab
 * with the name format: "{original name} Compacted YYYY-MM-DD"
 */

import { useState, useRef, useCallback, useMemo } from 'react';
import type { Session, LogEntry } from '../../types';
import type { SummarizeProgress, SummarizeResult } from '../../types/contextMerge';
import { contextSummarizationService } from '../../services/contextSummarizer';
import { createTabAtPosition } from '../../utils/tabHelpers';

/**
 * State type for the summarization process.
 */
export type SummarizeState = 'idle' | 'summarizing' | 'complete' | 'error';

/**
 * Per-tab summarization state
 */
export interface TabSummarizeState {
	state: SummarizeState;
	progress: SummarizeProgress | null;
	result: SummarizeResult | null;
	error: string | null;
	startTime: number;
}

/**
 * Result of the useSummarizeAndContinue hook.
 */
export interface UseSummarizeAndContinueResult {
	/** Current state of the summarization process (for the active tab) */
	summarizeState: SummarizeState;
	/** Progress information during summarization (for the active tab) */
	progress: SummarizeProgress | null;
	/** Result after successful summarization (for the active tab) */
	result: SummarizeResult | null;
	/** Error message if summarization failed (for the active tab) */
	error: string | null;
	/** Start time for elapsed time display */
	startTime: number;
	/** Get summarization state for a specific tab */
	getTabSummarizeState: (tabId: string) => TabSummarizeState | null;
	/** Check if any tab is currently summarizing */
	isAnySummarizing: boolean;
	/** Start the summarization process for a specific tab */
	startSummarize: (sourceTabId: string) => Promise<{
		newTabId: string;
		updatedSession: Session;
		systemLogEntry: LogEntry;
	} | null>;
	/** Cancel the current summarization operation for a specific tab */
	cancelTab: (tabId: string) => void;
	/** Cancel all summarization operations */
	cancel: () => void;
	/** Clear the state for a specific tab (call after handling completion) */
	clearTabState: (tabId: string) => void;
	/** Check if summarization is allowed based on context usage or log size */
	canSummarize: (contextUsage: number, logs?: LogEntry[]) => boolean;
	/** Get the minimum context usage percentage required for summarization */
	minContextUsagePercent: number;
}

/**
 * Hook for managing the "Summarize & Continue" workflow.
 *
 * Tracks per-tab state to allow non-blocking operations. While one tab is
 * summarizing, other tabs remain fully interactive.
 *
 * @param session - The Maestro session containing the tabs
 * @returns Object with summarization state and control functions
 *
 * @example
 * function MyComponent({ session }) {
 *   const {
 *     summarizeState,
 *     progress,
 *     result,
 *     error,
 *     startSummarize,
 *     canSummarize,
 *     getTabSummarizeState,
 *   } = useSummarizeAndContinue(session);
 *
 *   const handleSummarize = async () => {
 *     const activeTab = getActiveTab(session);
 *     if (activeTab && canSummarize(session.contextUsage)) {
 *       const result = await startSummarize(activeTab.id);
 *       if (result) {
 *         // Update session and add system log entry
 *         onSessionUpdate(result.updatedSession);
 *       }
 *     }
 *   };
 *
 *   // Check if current tab is summarizing
 *   const tabState = getTabSummarizeState(session.activeTabId);
 *   const isTabSummarizing = tabState?.state === 'summarizing';
 *
 *   return (
 *     <button onClick={handleSummarize} disabled={isTabSummarizing}>
 *       {isTabSummarizing ? `${tabState.progress?.progress}%` : 'Summarize & Continue'}
 *     </button>
 *   );
 * }
 */
export function useSummarizeAndContinue(session: Session | null): UseSummarizeAndContinueResult {
	// Per-tab state tracking: Map<tabId, TabSummarizeState>
	const [tabStates, setTabStates] = useState<Map<string, TabSummarizeState>>(new Map());
	const cancelRefs = useRef<Map<string, boolean>>(new Map());

	// Get state for the active tab (for backwards compatibility)
	const activeTabId = session?.activeTabId;
	const activeTabState = activeTabId ? tabStates.get(activeTabId) : null;

	/**
	 * Get summarization state for a specific tab
	 */
	const getTabSummarizeState = useCallback(
		(tabId: string): TabSummarizeState | null => {
			return tabStates.get(tabId) || null;
		},
		[tabStates]
	);

	/**
	 * Check if any tab is currently summarizing
	 */
	const isAnySummarizing = useMemo(() => {
		for (const state of tabStates.values()) {
			if (state.state === 'summarizing') return true;
		}
		return false;
	}, [tabStates]);

	/**
	 * Create a system log entry for the chat history
	 */
	const createSystemLogEntry = useCallback(
		(message: string, result?: SummarizeResult): LogEntry => {
			let text = message;
			if (result && result.success) {
				text = `${message}\n\nToken reduction: ${result.reductionPercent}% (~${result.originalTokens.toLocaleString()} → ~${result.compactedTokens.toLocaleString()} tokens)`;
			}
			return {
				id: `system-summarize-${Date.now()}`,
				timestamp: Date.now(),
				source: 'system',
				text,
			};
		},
		[]
	);

	/**
	 * Start the summarization process for a specific tab.
	 */
	const startSummarize = useCallback(
		async (
			sourceTabId: string
		): Promise<{ newTabId: string; updatedSession: Session; systemLogEntry: LogEntry } | null> => {
			if (!session) {
				return null;
			}

			const sourceTab = session.aiTabs.find((t) => t.id === sourceTabId);
			if (!sourceTab) {
				return null;
			}

			// Check if context is large enough to warrant summarization (by usage % or log size)
			if (!contextSummarizationService.canSummarize(session.contextUsage, sourceTab.logs)) {
				return null;
			}

			// Check if this tab is already summarizing
			const existingState = tabStates.get(sourceTabId);
			if (existingState?.state === 'summarizing') {
				return null;
			}

			const startTime = Date.now();

			// Initialize tab state
			setTabStates((prev) => {
				const next = new Map(prev);
				next.set(sourceTabId, {
					state: 'summarizing',
					progress: null,
					result: null,
					error: null,
					startTime,
				});
				return next;
			});
			cancelRefs.current.set(sourceTabId, false);

			try {
				// Run the summarization
				const summarizeResult = await contextSummarizationService.summarizeContext(
					{
						sourceSessionId: session.id,
						sourceTabId,
						projectRoot: session.projectRoot,
						agentType: session.toolType,
					},
					sourceTab.logs,
					(p) => {
						if (!cancelRefs.current.get(sourceTabId)) {
							setTabStates((prev) => {
								const next = new Map(prev);
								const existing = next.get(sourceTabId);
								if (existing) {
									next.set(sourceTabId, { ...existing, progress: p });
								}
								return next;
							});
						}
					}
				);

				if (cancelRefs.current.get(sourceTabId)) {
					return null;
				}

				if (!summarizeResult) {
					throw new Error('Summarization returned no result');
				}

				// Create the new compacted tab
				const compactedTabName = contextSummarizationService.formatCompactedTabName(sourceTab.name);

				const tabResult = createTabAtPosition(session, {
					afterTabId: sourceTabId,
					name: compactedTabName,
					logs: summarizeResult.summarizedLogs,
					saveToHistory: sourceTab.saveToHistory,
				});

				if (!tabResult) {
					throw new Error('Failed to create compacted tab');
				}

				// Calculate final result
				const finalResult: SummarizeResult = {
					success: true,
					newTabId: tabResult.tab.id,
					originalTokens: summarizeResult.originalTokens,
					compactedTokens: summarizeResult.compactedTokens,
					reductionPercent: Math.round(
						(1 - summarizeResult.compactedTokens / summarizeResult.originalTokens) * 100
					),
				};

				// Update tab state to complete
				setTabStates((prev) => {
					const next = new Map(prev);
					next.set(sourceTabId, {
						state: 'complete',
						progress: {
							stage: 'complete',
							progress: 100,
							message: 'Complete!',
						},
						result: finalResult,
						error: null,
						startTime,
					});
					return next;
				});

				// Create system log entry for the chat history
				const systemLogEntry = createSystemLogEntry(
					`Context summarized and continued in new tab "${compactedTabName}"`,
					finalResult
				);

				return {
					newTabId: tabResult.tab.id,
					updatedSession: {
						...tabResult.session,
						activeTabId: tabResult.tab.id, // Switch to the new tab
					},
					systemLogEntry,
				};
			} catch (err) {
				if (!cancelRefs.current.get(sourceTabId)) {
					const errorMessage = err instanceof Error ? err.message : 'Summarization failed';
					const errorResult: SummarizeResult = {
						success: false,
						originalTokens: 0,
						compactedTokens: 0,
						reductionPercent: 0,
						error: errorMessage,
					};

					setTabStates((prev) => {
						const next = new Map(prev);
						next.set(sourceTabId, {
							state: 'error',
							progress: null,
							result: errorResult,
							error: errorMessage,
							startTime,
						});
						return next;
					});
				}
				return null;
			}
		},
		[session, tabStates, createSystemLogEntry]
	);

	/**
	 * Cancel the summarization operation for a specific tab.
	 */
	const cancelTab = useCallback((tabId: string) => {
		cancelRefs.current.set(tabId, true);
		contextSummarizationService.cancelSummarization();
		setTabStates((prev) => {
			const next = new Map(prev);
			next.delete(tabId);
			return next;
		});
	}, []);

	/**
	 * Cancel all summarization operations.
	 */
	const cancel = useCallback(() => {
		for (const tabId of tabStates.keys()) {
			cancelRefs.current.set(tabId, true);
		}
		contextSummarizationService.cancelSummarization();
		setTabStates(new Map());
	}, [tabStates]);

	/**
	 * Clear the state for a specific tab (call after handling completion)
	 */
	const clearTabState = useCallback((tabId: string) => {
		setTabStates((prev) => {
			const next = new Map(prev);
			next.delete(tabId);
			return next;
		});
		cancelRefs.current.delete(tabId);
	}, []);

	/**
	 * Check if summarization is allowed based on context usage or log size.
	 */
	const canSummarize = useCallback((contextUsage: number, logs?: LogEntry[]): boolean => {
		return contextSummarizationService.canSummarize(contextUsage, logs);
	}, []);

	return {
		// Active tab state (backwards compatibility)
		summarizeState: activeTabState?.state || 'idle',
		progress: activeTabState?.progress || null,
		result: activeTabState?.result || null,
		error: activeTabState?.error || null,
		startTime: activeTabState?.startTime || 0,
		// Per-tab state access
		getTabSummarizeState,
		isAnySummarizing,
		// Actions
		startSummarize,
		cancelTab,
		cancel,
		clearTabState,
		canSummarize,
		minContextUsagePercent: contextSummarizationService.getMinContextUsagePercent(),
	};
}

export default useSummarizeAndContinue;
