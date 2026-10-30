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
 *
 * State lives in operationStore (Zustand); this hook owns orchestration only.
 */

import { useRef, useCallback } from 'react';
import type { Session, LogEntry } from '../../types';
import type { SummarizeProgress, SummarizeResult } from '../../types/contextMerge';
import { contextSummarizationService } from '../../services/contextSummarizer';
import { createTabAtPosition } from '../../utils/tabHelpers';
import { useOperationStore, selectIsAnySummarizing } from '../../stores/operationStore';
import { useSessionStore, selectActiveSession, selectSessionById } from '../../stores/sessionStore';
import { notifyToast } from '../../stores/notificationStore';
import type { SummarizeState, TabSummarizeState } from '../../stores/operationStore';
import { logger } from '../../utils/logger';
import { getClaudeTokenSourceFields } from '../../../shared/claudeTokenMode';
import type { TabContextOpResult } from '../../../shared/tabContextOps';

// Re-export types from the canonical store location
export type { SummarizeState, TabSummarizeState } from '../../stores/operationStore';

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
	/**
	 * Start the summarization process for a specific tab of `sessionId`
	 * (default: the active agent).
	 */
	startSummarize: (
		sourceTabId: string,
		sessionId?: string
	) => Promise<{
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
	/** High-level handler: validates, summarizes, updates session, shows toast (Tier 3E) */
	handleSummarizeAndContinue: (tabId?: string) => void;
	/**
	 * Context: Compact for one tab of any agent - the body behind
	 * `handleSummarizeAndContinue`, also run by `maestro-cli tab compact`.
	 * Resolves once the compacted tab exists (or the attempt failed); never throws.
	 * `background` keeps the source tab selected and skips the success toast.
	 */
	summarizeTab: (
		sessionId: string,
		tabId: string,
		options?: { background?: boolean }
	) => Promise<TabContextOpResult>;
}

/**
 * Hook for managing the "Summarize & Continue" workflow.
 *
 * Tracks per-tab state to allow non-blocking operations. While one tab is
 * summarizing, other tabs remain fully interactive.
 *
 * Takes no arguments. The active session is not a prop or param: reactive UI
 * (the active tab's summarize chrome) subscribes to `activeTabId` alone, and
 * imperative work (`startSummarize`, `handleSummarizeAndContinue`) resolves
 * the session fresh via `selectActiveSession(useSessionStore.getState())` at
 * call time, so callers never act on a stale closure value.
 *
 * @returns Object with summarization state and control functions
 *
 * @example
 * function MyComponent() {
 *   const {
 *     summarizeState,
 *     progress,
 *     result,
 *     error,
 *     startSummarize,
 *     canSummarize,
 *     getTabSummarizeState,
 *   } = useSummarizeAndContinue();
 *
 *   const handleSummarize = async () => {
 *     const session = selectActiveSession(useSessionStore.getState());
 *     const activeTab = session && getActiveTab(session);
 *     if (session && activeTab && canSummarize(session.contextUsage)) {
 *       const result = await startSummarize(activeTab.id);
 *       if (result) {
 *         // Update session and add system log entry
 *         onSessionUpdate(result.updatedSession);
 *       }
 *     }
 *   };
 *
 *   // Check if current tab is summarizing
 *   const tabState = getTabSummarizeState(activeTabId);
 *   const isTabSummarizing = tabState?.state === 'summarizing';
 *
 *   return (
 *     <button onClick={handleSummarize} disabled={isTabSummarizing}>
 *       {isTabSummarizing ? `${tabState.progress?.progress}%` : 'Summarize & Continue'}
 *     </button>
 *   );
 * }
 */
export function useSummarizeAndContinue(): UseSummarizeAndContinueResult {
	// Per-tab state lives in operationStore
	const tabStates = useOperationStore((s) => s.summarizeStates);
	const cancelRefs = useRef<Map<string, boolean>>(new Map());

	// Reactive UI only needs the active tab id, not the whole session object.
	const activeTabId = useSessionStore((s) => selectActiveSession(s)?.activeTabId);
	const activeTabState = activeTabId ? tabStates.get(activeTabId) : null;

	// Selector: any tab currently summarizing?
	const isAnySummarizing = useOperationStore(selectIsAnySummarizing);

	/**
	 * Get summarization state for a specific tab
	 */
	const getTabSummarizeState = useCallback((tabId: string): TabSummarizeState | null => {
		return useOperationStore.getState().summarizeStates.get(tabId) || null;
	}, []);

	/**
	 * Create a system log entry for the chat history
	 */
	const createSystemLogEntry = useCallback(
		(message: string, result?: SummarizeResult): LogEntry => {
			let text = message;
			if (result && result.success) {
				text = `${message}\n\nToken reduction: ${result.reductionPercent}% (~${(result.originalTokens ?? 0).toLocaleString()} → ~${(result.compactedTokens ?? 0).toLocaleString()} tokens)`;
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
			sourceTabId: string,
			sessionId?: string
		): Promise<{ newTabId: string; updatedSession: Session; systemLogEntry: LogEntry } | null> => {
			const state = useSessionStore.getState();
			const session = sessionId ? selectSessionById(sessionId)(state) : selectActiveSession(state);
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
			const existingState = useOperationStore.getState().summarizeStates.get(sourceTabId);
			if (existingState?.state === 'summarizing') {
				return null;
			}

			const startTime = Date.now();
			const store = useOperationStore.getState();

			// Initialize tab state
			store.setSummarizeTabState(sourceTabId, {
				state: 'summarizing',
				progress: null,
				result: null,
				error: null,
				startTime,
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
						// Pass SSH remote config if the session uses remote execution
						sshRemoteConfig: session.sessionSshRemoteConfig,
						// Pass custom agent configuration for proper remote execution
						customPath: session.customPath,
						customArgs: session.customArgs,
						customEnvVars: session.customEnvVars,
						claudeTokenSource: getClaudeTokenSourceFields(session),
					},
					sourceTab.logs,
					(p) => {
						if (!cancelRefs.current.get(sourceTabId)) {
							useOperationStore.getState().updateSummarizeTabState(sourceTabId, { progress: p });
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
				useOperationStore.getState().setSummarizeTabState(sourceTabId, {
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

					useOperationStore.getState().setSummarizeTabState(sourceTabId, {
						state: 'error',
						progress: null,
						result: errorResult,
						error: errorMessage,
						startTime,
					});
				}
				return null;
			}
		},
		[createSystemLogEntry]
	);

	/**
	 * Cancel the summarization operation for a specific tab.
	 */
	const cancelTab = useCallback((tabId: string) => {
		cancelRefs.current.set(tabId, true);
		contextSummarizationService.cancelSummarization();
		useOperationStore.getState().clearSummarizeTabState(tabId);
	}, []);

	/**
	 * Cancel all summarization operations.
	 */
	const cancel = useCallback(() => {
		const states = useOperationStore.getState().summarizeStates;
		for (const tabId of states.keys()) {
			cancelRefs.current.set(tabId, true);
		}
		contextSummarizationService.cancelSummarization();
		useOperationStore.getState().clearAllSummarizeStates();
	}, []);

	/**
	 * Clear the state for a specific tab (call after handling completion)
	 */
	const clearTabState = useCallback((tabId: string) => {
		useOperationStore.getState().clearSummarizeTabState(tabId);
		cancelRefs.current.delete(tabId);
	}, []);

	/**
	 * Check if summarization is allowed based on context usage or log size.
	 */
	const canSummarize = useCallback((contextUsage: number, logs?: LogEntry[]): boolean => {
		return contextSummarizationService.canSummarize(contextUsage, logs);
	}, []);

	/**
	 * Compact one tab of one agent: validates, runs summarization, inserts the
	 * compacted tab, shows the toasts. The overlay menu, palette, shortcut and
	 * composer reach it through `handleSummarizeAndContinue`; the CLI calls it
	 * directly with an explicit agent and tab.
	 */
	const summarizeTab = useCallback(
		async (
			sessionId: string,
			targetTabId: string,
			options: { background?: boolean } = {}
		): Promise<TabContextOpResult> => {
			const session = selectSessionById(sessionId)(useSessionStore.getState());
			if (!session) return { success: false, error: `Agent not found: ${sessionId}` };
			const targetTab = session.aiTabs.find((t) => t.id === targetTabId);
			const subject = { sessionId, tabId: targetTabId };

			if (!targetTab || !canSummarize(session.contextUsage, targetTab.logs)) {
				const message = `Context too small. Need at least ${contextSummarizationService.getMinContextUsagePercent()}% usage, ~2k tokens, or 8+ messages to compact.`;
				notifyToast({
					type: 'warning',
					title: 'Cannot Compact',
					message,
					sessionId,
					tabId: targetTabId,
				});
				return {
					success: false,
					error: targetTab ? message : `Tab not found: ${targetTabId}`,
					...subject,
				};
			}

			// Store session info for toast navigation
			const sourceSessionName = session.name;
			const { setSessions } = useSessionStore.getState();

			try {
				const result = await startSummarize(targetTabId, sessionId);
				if (!result) {
					// startSummarize returned null after setting an error state in
					// operationStore. Pull the actual error so the toast can
					// surface it directly instead of pointing users at a "tab"
					// that never renders details.
					const tabState = useOperationStore.getState().summarizeStates.get(targetTabId);
					const detail =
						tabState?.state === 'summarizing'
							? 'This tab is already being compacted.'
							: tabState?.error?.trim();
					const message = detail
						? `Failed to compact context: ${detail}`
						: 'Failed to compact context.';
					notifyToast({
						type: 'error',
						title: 'Compaction Failed',
						message,
						sessionId,
						tabId: targetTabId,
					});
					return { success: false, error: message, ...subject };
				}

				// Apply only deterministic deltas to the live session (avoid stale snapshot spread)
				setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== sessionId) return s;
						// Insert the new tab if not already present
						const newTab = result.updatedSession.aiTabs.find((t) => t.id === result.newTabId);
						const hasNewTab = s.aiTabs.some((t) => t.id === result.newTabId);
						// Find insertion point: right after the source tab
						let updatedTabs = s.aiTabs;
						if (newTab && !hasNewTab) {
							const sourceIdx = s.aiTabs.findIndex((t) => t.id === targetTabId);
							const insertIdx = sourceIdx >= 0 ? sourceIdx + 1 : s.aiTabs.length;
							updatedTabs = [...s.aiTabs.slice(0, insertIdx), newTab, ...s.aiTabs.slice(insertIdx)];
						}
						return {
							...s,
							activeTabId: options.background ? s.activeTabId : result.newTabId,
							aiTabs: updatedTabs.map((tab) =>
								tab.id === targetTabId
									? { ...tab, logs: [...tab.logs, result.systemLogEntry] }
									: tab
							),
						};
					})
				);

				const reductionPercent = Number(result.systemLogEntry.text.match(/(\d+)%/)?.[1] ?? '0');
				if (!options.background) {
					// Show success notification with click-to-navigate
					notifyToast({
						type: 'success',
						title: 'Context Compacted',
						message: `Reduced context by ${reductionPercent}%. Click to view the new tab.`,
						sessionId,
						tabId: result.newTabId,
						project: sourceSessionName,
					});
				}

				// Clear the summarization state for this tab
				clearTabState(targetTabId);
				return { success: true, ...subject, newTabId: result.newTabId, reductionPercent };
			} catch (err) {
				logger.error('[summarizeTab] Unexpected error:', undefined, err);
				const detail = err instanceof Error ? err.message : String(err);
				const message = detail
					? `An unexpected error occurred during compaction: ${detail}`
					: 'An unexpected error occurred during compaction.';
				notifyToast({
					type: 'error',
					title: 'Compaction Failed',
					message,
					sessionId,
					tabId: targetTabId,
				});
				clearTabState(targetTabId);
				return { success: false, error: message, ...subject };
			}
		},
		[canSummarize, startSummarize, clearTabState]
	);

	/**
	 * High-level handler: compacts a tab of the active agent (default: its
	 * active tab). Extracted from App.tsx wrapper (Tier 3E).
	 */
	const handleSummarizeAndContinue = useCallback(
		(tabId?: string) => {
			const session = selectActiveSession(useSessionStore.getState());
			if (!session || session.inputMode !== 'ai') return;
			void summarizeTab(session.id, tabId || session.activeTabId);
		},
		[summarizeTab]
	);

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
		handleSummarizeAndContinue,
		summarizeTab,
	};
}

export default useSummarizeAndContinue;
