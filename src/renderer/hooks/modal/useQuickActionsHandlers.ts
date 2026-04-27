/**
 * useQuickActionsHandlers — extracted from App.tsx
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
import type { Session, ThinkingMode, UnifiedTabRef } from '../../types';
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
	/** Reorder unified tabs (AI + file + terminal tabs) */
	handleUnifiedTabReorder: (fromIndex: number, toIndex: number) => void;
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
	/** Clear the active terminal xterm buffer */
	handleQuickActionsClearActiveTerminal: () => void;
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

/** Returns the UnifiedTabRef for the currently active tab (AI, file, terminal, or browser). */
function getActiveUnifiedRef(session: Session): UnifiedTabRef | null {
	if (session.inputMode === 'terminal' && session.activeTerminalTabId) {
		return { type: 'terminal', id: session.activeTerminalTabId };
	}
	if (session.activeFileTabId) {
		return { type: 'file', id: session.activeFileTabId };
	}
	if (session.activeBrowserTabId) {
		return { type: 'browser', id: session.activeBrowserTabId };
	}
	if (session.activeTabId) {
		return { type: 'ai', id: session.activeTabId };
	}
	return null;
}

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
		handleUnifiedTabReorder,
		handleCopyContext,
		handleExportHtml,
		handlePublishTabGist,
	} = deps;

	// --- Reactive subscriptions ---
	const activeSession = useSessionStore(selectActiveSession);
	const activeSessionId = useSessionStore((s) => s.activeSessionId);
	const markdownEditMode = useSettingsStore((s) => s.markdownEditMode);
	const chatRawTextMode = useSettingsStore((s) => s.chatRawTextMode);

	// --- Store actions (stable via getState) ---
	const { setSessions } = useSessionStore.getState();
	const { setMarkdownEditMode, setChatRawTextMode } = useSettingsStore.getState();
	const { setSuccessFlashNotification } = useUIStore.getState();

	const handleQuickActionsToggleReadOnlyMode = useCallback(() => {
		if (activeSession?.inputMode === 'ai' && activeSession.activeTabId) {
			setSessions((prev) =>
				prev.map((s) => {
					if (s.id !== activeSession.id) return s;
					return {
						...s,
						aiTabs: s.aiTabs.map((tab) =>
							tab.id === s.activeTabId ? { ...tab, readOnlyMode: !tab.readOnlyMode } : tab
						),
					};
				})
			);
		}
	}, [activeSession]);

	const handleQuickActionsToggleTabShowThinking = useCallback(() => {
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
							// When turning OFF, clear any thinking/tool logs
							if (newMode === 'off') {
								return {
									...tab,
									showThinking: 'off',
									logs: tab.logs.filter((l) => l.source !== 'thinking' && l.source !== 'tool'),
								};
							}
							return { ...tab, showThinking: newMode };
						}),
					};
				})
			);
		}
	}, [activeSession]);

	const handleQuickActionsRefreshGitFileState = useCallback(async () => {
		if (activeSessionId) {
			await Promise.all([refreshGitFileState(activeSessionId), refreshWorktreeState()]);
			await mainPanelRef.current?.refreshGitInfo();
			setSuccessFlashNotification('Files, Git, History Refreshed');
			setTimeout(() => setSuccessFlashNotification(null), 2000);
		}
	}, [activeSessionId, refreshGitFileState, refreshWorktreeState]);

	const handleQuickActionsDebugReleaseQueuedItem = useCallback(() => {
		if (!activeSession || activeSession.executionQueue.length === 0) return;
		const [nextItem, ...remainingQueue] = activeSession.executionQueue;
		// Update state to remove item from queue and surface the user log entry
		// for message items (mirrors what useAgentListeners onExit / useInterruptHandler
		// do for their dequeue paths). processQueuedItem itself does not add the log.
		setSessions((prev) =>
			prev.map((s) => {
				if (s.id !== activeSessionId) return s;
				if (nextItem.type !== 'message' || !nextItem.text) {
					return { ...s, executionQueue: remainingQueue };
				}
				const targetTabId = nextItem.tabId || s.activeTabId;
				const updatedAiTabs = s.aiTabs.map((tab) =>
					tab.id === targetTabId
						? {
								...tab,
								logs: [
									...tab.logs,
									{
										id: generateId(),
										timestamp: Date.now(),
										source: 'user' as const,
										text: nextItem.text!,
										images: nextItem.images,
										...(nextItem.forceParallel && { forceParallel: true }),
										...(nextItem.readOnlyMode && { readOnly: true }),
									},
								],
							}
						: tab
				);
				return { ...s, executionQueue: remainingQueue, aiTabs: updatedAiTabs };
			})
		);
		// Process the item
		processQueuedItem(activeSessionId!, nextItem);
	}, [activeSession, activeSessionId, processQueuedItem]);

	const handleQuickActionsToggleMarkdownEditMode = useCallback(() => {
		// Toggle the appropriate mode based on context:
		// - If file tab is active: toggle file edit mode (markdownEditMode)
		// - If no file tab: toggle chat raw text mode (chatRawTextMode)
		if (activeSession?.activeFileTabId) {
			setMarkdownEditMode(!markdownEditMode);
		} else {
			setChatRawTextMode(!chatRawTextMode);
		}
	}, [activeSession?.activeFileTabId, markdownEditMode, chatRawTextMode]);

	const handleQuickActionsSummarizeAndContinue = useCallback(
		() => handleSummarizeAndContinue(),
		[handleSummarizeAndContinue]
	);

	const handleQuickActionsAutoRunResetTasks = useCallback(() => {
		rightPanelRef.current?.openAutoRunResetTasksModal();
	}, []);

	const handleQuickActionsClearActiveTerminal = useCallback(() => {
		mainPanelRef.current?.clearActiveTerminal();
	}, []);

	const handleQuickActionsCloseCurrentTab = useCallback(() => {
		handleCloseCurrentTab();
	}, [handleCloseCurrentTab]);

	const handleQuickActionsMoveTabToFirst = useCallback(() => {
		if (!activeSession) return;
		// Find the active tab's index in the unified tab order (supports AI, file, and terminal tabs)
		const activeRef = getActiveUnifiedRef(activeSession);
		if (!activeRef) return;
		const idx = activeSession.unifiedTabOrder.findIndex(
			(ref) => ref.type === activeRef.type && ref.id === activeRef.id
		);
		if (idx > 0) {
			handleUnifiedTabReorder(idx, 0);
		}
	}, [activeSession, handleUnifiedTabReorder]);

	const handleQuickActionsMoveTabToLast = useCallback(() => {
		if (!activeSession) return;
		const activeRef = getActiveUnifiedRef(activeSession);
		if (!activeRef) return;
		const idx = activeSession.unifiedTabOrder.findIndex(
			(ref) => ref.type === activeRef.type && ref.id === activeRef.id
		);
		if (idx >= 0 && idx < activeSession.unifiedTabOrder.length - 1) {
			handleUnifiedTabReorder(idx, activeSession.unifiedTabOrder.length - 1);
		}
	}, [activeSession, handleUnifiedTabReorder]);

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
		handleQuickActionsToggleTabShowThinking,
		handleQuickActionsRefreshGitFileState,
		handleQuickActionsDebugReleaseQueuedItem,
		handleQuickActionsToggleMarkdownEditMode,
		handleQuickActionsSummarizeAndContinue,
		handleQuickActionsAutoRunResetTasks,
		handleQuickActionsClearActiveTerminal,
		handleQuickActionsCloseCurrentTab,
		handleQuickActionsMoveTabToFirst,
		handleQuickActionsMoveTabToLast,
		handleQuickActionsCopyTabContext,
		handleQuickActionsExportTabHtml,
		handleQuickActionsPublishTabGist,
	};
}
