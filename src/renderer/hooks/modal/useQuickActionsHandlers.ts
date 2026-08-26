/**
 * useQuickActionsHandlers - extracted from App.tsx
 *
 * Provides stable callbacks for the Quick Actions modal (Cmd+K):
 *   - Toggle read-only mode
 *   - Toggle thinking mode
 *   - Refresh git/file state
 *   - Debug release queued item
 *   - Toggle markdown edit mode
 *   - Summarize and continue
 *   - Auto Run reset tasks
 *
 * Reads from: sessionStore, settingsStore, uiStore
 */

import { useCallback } from 'react';
import { generateId } from '../../utils/ids';
import { takeNextRunnableQueueItem } from '../../utils/executionQueue';
import {
	moveActiveUnifiedTabToEdge,
	resolveQueuedItemTarget,
	toggleReadOnlyModeFields,
} from '../../utils/tabHelpers';
import type { Session, ThinkingMode } from '../../types';
import { useSessionStore, selectActiveSession } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useUIStore } from '../../stores/uiStore';
import type { MainPanelHandle } from '../../components/MainPanel';
import type { RightPanelHandle } from '../../components/RightPanel';

// ============================================================================
// Dependencies interface
// ============================================================================

export interface UseQuickActionsHandlersDeps {
	/** Refresh file tree and git state for a session */
	refreshGitFileState: (sessionId: string) => Promise<void>;
	/** Scan worktree directories for additions and removals */
	refreshWorktreeState: () => Promise<void>;
	/** Ref to main panel component */
	mainPanelRef: React.RefObject<MainPanelHandle | null>;
	/** Ref to right panel component */
	rightPanelRef: React.RefObject<RightPanelHandle | null>;
	/** Summarize and continue handler */
	handleSummarizeAndContinue: () => void;
	/** Process a queued execution item */
	processQueuedItem: (sessionId: string, item: any) => Promise<void>;
	/** Close the current tab */
	handleCloseCurrentTab: () => void;
	/** Copy tab context to clipboard */
	handleCopyContext: (tabId: string) => void;
	/** Export tab as HTML */
	handleExportHtml: (tabId: string) => Promise<void>;
	/** Publish tab as GitHub Gist */
	handlePublishTabGist: (tabId: string) => void;
}

// ============================================================================
// Return type
// ============================================================================

export interface UseQuickActionsHandlersReturn {
	/** Toggle read-only mode on the active tab */
	handleQuickActionsToggleReadOnlyMode: () => void;
	/** Toggle enter-to-send mode on the active AI tab (overrides global default) */
	handleQuickActionsToggleTabEnterToSend: () => void;
	/** Cycle thinking mode on the active tab */
	handleQuickActionsToggleTabShowThinking: () => void;
	/** Refresh git, file tree, and history */
	handleQuickActionsRefreshGitFileState: () => Promise<void>;
	/** Debug: release the next queued item for processing */
	handleQuickActionsDebugReleaseQueuedItem: () => void;
	/** Toggle markdown edit mode or chat raw text mode */
	handleQuickActionsToggleMarkdownEditMode: () => void;
	/** Trigger summarize and continue */
	handleQuickActionsSummarizeAndContinue: () => void;
	/** Open Auto Run reset tasks modal */
	handleQuickActionsAutoRunResetTasks: () => void;
	/** Toggle the Auto Run Expanded Preview modal */
	handleQuickActionsToggleAutoRunExpanded: () => void;
	/** Clear the active terminal xterm buffer */
	handleQuickActionsClearActiveTerminal: () => void;
	/** Scroll the active tab header into view and focus it */
	handleQuickActionsFocusActiveTab: () => void;
	/** Close the current tab */
	handleQuickActionsCloseCurrentTab: () => void;
	/** Move current tab to first position */
	handleQuickActionsMoveTabToFirst: () => void;
	/** Move current tab to last position */
	handleQuickActionsMoveTabToLast: () => void;
	/** Copy active tab context to clipboard */
	handleQuickActionsCopyTabContext: (tabId: string) => void;
	/** Export active tab as HTML */
	handleQuickActionsExportTabHtml: (tabId: string) => Promise<void>;
	/** Publish active tab as GitHub Gist */
	handleQuickActionsPublishTabGist: (tabId: string) => void;
}

// ============================================================================
// Hook implementation
// ============================================================================

export function useQuickActionsHandlers(
	deps: UseQuickActionsHandlersDeps
): UseQuickActionsHandlersReturn {
	const {
		refreshGitFileState,
		refreshWorktreeState,
		mainPanelRef,
		rightPanelRef,
		handleSummarizeAndContinue,
		processQueuedItem,
		handleCloseCurrentTab,
		handleCopyContext,
		handleExportHtml,
		handlePublishTabGist,
	} = deps;

	// PERF: Never useSessionStore(selectActiveSession). Streamed logs/tokens would
	// wake App via this hook. All Quick Actions handlers resolve the active
	// agent at event time via getState().
	const markdownEditMode = useSettingsStore((s) => s.markdownEditMode);
	const chatRawTextMode = useSettingsStore((s) => s.chatRawTextMode);

	// --- Store actions (stable via getState) ---
	const { setSessions } = useSessionStore.getState();
	const { setMarkdownEditMode, setChatRawTextMode } = useSettingsStore.getState();
	const { setSuccessFlashNotification } = useUIStore.getState();

	const handleQuickActionsToggleReadOnlyMode = useCallback(() => {
		const activeSession = selectActiveSession(useSessionStore.getState());
		if (activeSession?.inputMode === 'ai' && activeSession.activeTabId) {
			setSessions((prev) =>
				prev.map((s) => {
					if (s.id !== activeSession.id) return s;
					return {
						...s,
						aiTabs: s.aiTabs.map((tab) =>
							tab.id === s.activeTabId ? { ...tab, ...toggleReadOnlyModeFields(tab) } : tab
						),
					};
				})
			);
		}
	}, []);

	const handleQuickActionsToggleTabEnterToSend = useCallback(() => {
		const activeSession = selectActiveSession(useSessionStore.getState());
		if (activeSession?.inputMode !== 'ai' || !activeSession.activeTabId) return;
		const globalDefault = useSettingsStore.getState().enterToSendAI;
		setSessions((prev) =>
			prev.map((s) => {
				if (s.id !== activeSession.id) return s;
				return {
					...s,
					aiTabs: s.aiTabs.map((tab) =>
						tab.id === s.activeTabId
							? { ...tab, enterToSend: !(tab.enterToSend ?? globalDefault) }
							: tab
					),
				};
			})
		);
	}, []);

	const handleQuickActionsToggleTabShowThinking = useCallback(() => {
		const activeSession = selectActiveSession(useSessionStore.getState());
		if (activeSession?.inputMode === 'ai' && activeSession.activeTabId) {
			// Cycle through: off -> on -> sticky -> off
			const cycleThinkingMode = (current: ThinkingMode | undefined): ThinkingMode => {
				if (!current || current === 'off') return 'on';
				if (current === 'on') return 'sticky';
				return 'off';
			};
			setSessions((prev) =>
				prev.map((s) => {
					if (s.id !== activeSession.id) return s;
					return {
						...s,
						aiTabs: s.aiTabs.map((tab) => {
							if (tab.id !== s.activeTabId) return tab;
							const newMode = cycleThinkingMode(tab.showThinking);
							// When turning OFF, clear thinking logs; tool logs are render-gated.
							if (newMode === 'off') {
								return {
									...tab,
									showThinking: 'off',
									logs: tab.logs.filter((l) => l.source !== 'thinking'),
								};
							}
							return { ...tab, showThinking: newMode };
						}),
					};
				})
			);
		}
	}, []);

	const handleQuickActionsRefreshGitFileState = useCallback(async () => {
		const activeSessionId = useSessionStore.getState().activeSessionId;
		if (activeSessionId) {
			await Promise.all([refreshGitFileState(activeSessionId), refreshWorktreeState()]);
			await mainPanelRef.current?.refreshGitInfo();
			setSuccessFlashNotification('Files, Git, History Refreshed');
			setTimeout(() => setSuccessFlashNotification(null), 2000);
		}
	}, [refreshGitFileState, refreshWorktreeState]);

	const handleQuickActionsDebugReleaseQueuedItem = useCallback(() => {
		const { activeSessionId } = useSessionStore.getState();
		const activeSession = selectActiveSession(useSessionStore.getState());
		if (!activeSession || !activeSessionId) return;
		const { item: nextItem, remaining: remainingQueue } = takeNextRunnableQueueItem(
			activeSession.executionQueue
		);
		if (!nextItem) return;
		// Update state to remove item from queue and surface the user log entry
		// for message items (mirrors what useAgentListeners onExit / useInterruptHandler
		// do for their dequeue paths). processQueuedItem itself does not add the log.
		setSessions((prev) =>
			prev.map((s) => {
				if (s.id !== activeSessionId) return s;
				if (nextItem.type !== 'message' || !nextItem.text) {
					return { ...s, executionQueue: remainingQueue };
				}
				// Route the user log to the item's target tab orphan-aware: a message
				// queued on a since-closed tab lives in orphanedThinkingTabs, so append
				// the log there rather than leaking it onto the active tab.
				const target = resolveQueuedItemTarget(s, nextItem);
				const logEntry = {
					id: generateId(),
					timestamp: Date.now(),
					source: 'user' as const,
					text: nextItem.text!,
					images: nextItem.images,
					...(nextItem.forceParallel && { forceParallel: true }),
					...(nextItem.readOnlyMode && { readOnly: true }),
				};
				if (target?.location === 'orphan' && s.orphanedThinkingTabs) {
					return {
						...s,
						executionQueue: remainingQueue,
						orphanedThinkingTabs: s.orphanedThinkingTabs.map((tab) =>
							tab.id === target.tabId ? { ...tab, logs: [...tab.logs, logEntry] } : tab
						),
					};
				}
				const targetTabId = target?.tabId ?? s.activeTabId;
				const updatedAiTabs = s.aiTabs.map((tab) =>
					tab.id === targetTabId ? { ...tab, logs: [...tab.logs, logEntry] } : tab
				);
				return { ...s, executionQueue: remainingQueue, aiTabs: updatedAiTabs };
			})
		);
		// Process the item
		processQueuedItem(activeSessionId, nextItem);
	}, [processQueuedItem]);

	const handleQuickActionsToggleMarkdownEditMode = useCallback(() => {
		// Toggle the appropriate mode based on context:
		// - If file tab is active: toggle file edit mode (markdownEditMode)
		// - If no file tab: toggle chat raw text mode (chatRawTextMode)
		const activeSession = selectActiveSession(useSessionStore.getState());
		if (activeSession?.activeFileTabId) {
			setMarkdownEditMode(!markdownEditMode);
		} else {
			setChatRawTextMode(!chatRawTextMode);
		}
	}, [markdownEditMode, chatRawTextMode]);

	const handleQuickActionsSummarizeAndContinue = useCallback(
		() => handleSummarizeAndContinue(),
		[handleSummarizeAndContinue]
	);

	const handleQuickActionsAutoRunResetTasks = useCallback(() => {
		rightPanelRef.current?.openAutoRunResetTasksModal();
	}, []);

	const handleQuickActionsToggleAutoRunExpanded = useCallback(() => {
		rightPanelRef.current?.toggleAutoRunExpanded();
	}, []);

	const handleQuickActionsClearActiveTerminal = useCallback(() => {
		mainPanelRef.current?.clearActiveTerminal();
	}, []);

	const handleQuickActionsFocusActiveTab = useCallback(() => {
		mainPanelRef.current?.focusActiveTab();
	}, []);

	const handleQuickActionsCloseCurrentTab = useCallback(() => {
		handleCloseCurrentTab();
	}, [handleCloseCurrentTab]);

	// Move the active tab to the strip's first / last slot. Same helper the
	// Cmd+Shift+Left / Right shortcuts use, so the palette and the keyboard cannot
	// disagree about where the tab lands (supports AI, file, browser, and terminal
	// tabs, since it operates on unifiedTabOrder).
	const moveActiveTabToEdge = useCallback((edge: 'start' | 'end') => {
		const { setSessions, activeSessionId } = useSessionStore.getState();
		if (!activeSessionId) return;
		setSessions((prev: Session[]) =>
			prev.map((s) => (s.id === activeSessionId ? moveActiveUnifiedTabToEdge(s, edge) : s))
		);
	}, []);

	const handleQuickActionsMoveTabToFirst = useCallback(
		() => moveActiveTabToEdge('start'),
		[moveActiveTabToEdge]
	);

	const handleQuickActionsMoveTabToLast = useCallback(
		() => moveActiveTabToEdge('end'),
		[moveActiveTabToEdge]
	);

	const handleQuickActionsCopyTabContext = useCallback(
		(tabId: string) => handleCopyContext(tabId),
		[handleCopyContext]
	);

	const handleQuickActionsExportTabHtml = useCallback(
		(tabId: string) => handleExportHtml(tabId),
		[handleExportHtml]
	);

	const handleQuickActionsPublishTabGist = useCallback(
		(tabId: string) => handlePublishTabGist(tabId),
		[handlePublishTabGist]
	);

	return {
		handleQuickActionsToggleReadOnlyMode,
		handleQuickActionsToggleTabEnterToSend,
		handleQuickActionsToggleTabShowThinking,
		handleQuickActionsRefreshGitFileState,
		handleQuickActionsDebugReleaseQueuedItem,
		handleQuickActionsToggleMarkdownEditMode,
		handleQuickActionsSummarizeAndContinue,
		handleQuickActionsAutoRunResetTasks,
		handleQuickActionsToggleAutoRunExpanded,
		handleQuickActionsClearActiveTerminal,
		handleQuickActionsFocusActiveTab,
		handleQuickActionsCloseCurrentTab,
		handleQuickActionsMoveTabToFirst,
		handleQuickActionsMoveTabToLast,
		handleQuickActionsCopyTabContext,
		handleQuickActionsExportTabHtml,
		handleQuickActionsPublishTabGist,
	};
}
