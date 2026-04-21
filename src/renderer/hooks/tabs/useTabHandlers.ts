import { useMemo, useCallback } from 'react';
import type {
	Session,
	AITab,
	BrowserTab,
	FilePreviewTab,
	UnifiedTab,
	UnifiedTabRef,
	FilePreviewHistoryEntry,
} from '../../types';
import type { ThinkingMode } from '../../../shared/types';
import {
	setActiveTab,
	createTab,
	closeTab,
	closeBrowserTab as closeBrowserTabHelper,
	closeFileTab as closeFileTabHelper,
	addAiTabToUnifiedHistory,
	getActiveTab,
	getInitialRenameValue,
	hasActiveWizard,
	hasDraft,
	buildUnifiedTabs,
	ensureInUnifiedTabOrder,
} from '../../utils/tabHelpers';
import {
	closeTerminalTab as closeTerminalTabHelper,
	getTerminalSessionId,
} from '../../utils/terminalTabHelpers';
import {
	DEFAULT_BROWSER_TAB_TITLE,
	DEFAULT_BROWSER_TAB_URL,
	getBrowserTabPartition,
	getBrowserTabTitle,
	normalizeBrowserTabUrl,
} from '../../utils/browserTabPersistence';
import { generateId } from '../../utils/ids';
import { useSessionStore, selectActiveSession, updateAiTab } from '../../stores/sessionStore';
import { useModalStore } from '../../stores/modalStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useTabStore } from '../../stores/tabStore';
import { logger } from '../../utils/logger';

// ============================================================================
// Helpers
// ============================================================================

/** Resolve the active tab's unified ref, accounting for terminal, file, and AI tabs. */
function getActiveUnifiedRef(s: Session): { type: UnifiedTabRef['type']; id: string } | null {
	if (s.inputMode === 'terminal' && s.activeTerminalTabId) {
		return { type: 'terminal', id: s.activeTerminalTabId };
	}
	if (s.activeFileTabId) {
		return { type: 'file', id: s.activeFileTabId };
	}
	if (s.activeBrowserTabId) {
		return { type: 'browser', id: s.activeBrowserTabId };
	}
	if (s.activeTabId) {
		return { type: 'ai', id: s.activeTabId };
	}
	return null;
}

// ============================================================================
// Types
// ============================================================================

export interface CloseCurrentTabResult {
	type: 'file' | 'browser' | 'ai' | 'terminal' | 'prevented' | 'none';
	tabId?: string;
	isWizardTab?: boolean;
	hasDraft?: boolean;
}

interface FileTabOpenParams {
	path: string;
	name: string;
	content: string;
	sshRemoteId?: string;
	lastModified?: number;
}

export interface TabHandlersReturn {
	// Derived state
	activeTab: AITab | undefined;
	unifiedTabs: UnifiedTab[];
	activeFileTab: FilePreviewTab | null;
	activeBrowserTab: BrowserTab | null;
	isResumingSession: boolean;
	fileTabBackHistory: FilePreviewHistoryEntry[];
	fileTabForwardHistory: FilePreviewHistoryEntry[];
	fileTabCanGoBack: boolean;
	fileTabCanGoForward: boolean;
	activeFileTabNavIndex: number;

	// Internal helpers (needed by keyboard handler)
	performTabClose: (tabId: string) => void;

	// AI Tab handlers
	handleNewAgentSession: () => void;
	handleTabSelect: (tabId: string) => void;
	handleTabClose: (tabId: string) => void;
	handleNewTab: () => void;
	handleTabReorder: (fromIndex: number, toIndex: number) => void;
	handleUnifiedTabReorder: (fromIndex: number, toIndex: number) => void;
	handleCloseAllTabs: () => void;
	handleCloseOtherTabs: () => void;
	handleCloseTabsLeft: () => void;
	handleCloseTabsRight: () => void;
	handleCloseCurrentTab: () => CloseCurrentTabResult;
	handleRequestTabRename: (tabId: string) => void;
	handleUpdateTabByClaudeSessionId: (
		agentSessionId: string,
		updates: { name?: string | null; starred?: boolean }
	) => void;
	handleTabStar: (tabId: string, starred: boolean) => void;
	handleTabMarkUnread: (tabId: string) => void;
	handleToggleTabReadOnlyMode: () => void;
	handleToggleTabSaveToHistory: () => void;
	handleToggleTabShowThinking: () => void;

	// File Tab handlers
	handleOpenFileTab: (
		file: FileTabOpenParams,
		options?: { openInNewTab?: boolean; targetSessionId?: string }
	) => void;
	handleSelectFileTab: (tabId: string) => Promise<void>;
	handleCloseFileTab: (tabId: string) => void;
	handleFileTabEditModeChange: (tabId: string, editMode: boolean) => void;
	handleFileTabEditContentChange: (
		tabId: string,
		editContent: string | undefined,
		savedContent?: string
	) => void;
	handleFileTabScrollPositionChange: (tabId: string, scrollTop: number) => void;
	handleFileTabSearchQueryChange: (tabId: string, searchQuery: string) => void;
	handleReloadFileTab: (tabId: string) => Promise<void>;
	handleFileTabNavigateBack: () => Promise<void>;
	handleFileTabNavigateForward: () => Promise<void>;
	handleFileTabNavigateToIndex: (index: number) => Promise<void>;
	handleClearFilePreviewHistory: () => void;
	handleNewFileTab: () => void;

	// Browser Tab handlers
	handleNewBrowserTab: () => void;
	handleSelectBrowserTab: (tabId: string) => void;
	handleCloseBrowserTab: (tabId: string) => void;
	handleUpdateBrowserTab: (sessionId: string, tabId: string, updates: Partial<BrowserTab>) => void;

	// Scroll/log handlers
	handleScrollPositionChange: (scrollTop: number) => void;
	handleAtBottomChange: (isAtBottom: boolean) => void;
	handleDeleteLog: (logId: string) => number | null;
}

// ============================================================================
// Hook
// ============================================================================

export function useTabHandlers(): TabHandlersReturn {
	// --- Reactive subscriptions for derived state ---
	const activeSession = useSessionStore(selectActiveSession);

	// --- Derived state (useMemo) ---

	// Per-tab navigation history for the active file tab
	const activeFileTabHistory = useMemo(() => {
		if (!activeSession?.activeFileTabId) return [];
		const tab = activeSession.filePreviewTabs.find((t) => t.id === activeSession.activeFileTabId);
		return tab?.navigationHistory ?? [];
	}, [activeSession?.activeFileTabId, activeSession?.filePreviewTabs]);

	const activeFileTabNavIndex = useMemo(() => {
		if (!activeSession?.activeFileTabId) return -1;
		const tab = activeSession.filePreviewTabs.find((t) => t.id === activeSession.activeFileTabId);
		return tab?.navigationIndex ?? (tab?.navigationHistory?.length ?? 0) - 1;
	}, [activeSession?.activeFileTabId, activeSession?.filePreviewTabs]);

	// Per-tab back/forward history arrays
	const fileTabBackHistory = useMemo(
		() => activeFileTabHistory.slice(0, activeFileTabNavIndex),
		[activeFileTabHistory, activeFileTabNavIndex]
	);
	const fileTabForwardHistory = useMemo(
		() => activeFileTabHistory.slice(activeFileTabNavIndex + 1),
		[activeFileTabHistory, activeFileTabNavIndex]
	);

	// Can navigate back/forward in the current file tab
	const fileTabCanGoBack = activeFileTabNavIndex > 0;
	const fileTabCanGoForward = activeFileTabNavIndex < activeFileTabHistory.length - 1;

	const activeTab = useMemo(
		() => (activeSession ? getActiveTab(activeSession) : undefined),
		[activeSession?.aiTabs, activeSession?.activeTabId]
	);

	// UNIFIED TAB SYSTEM: Combine aiTabs and filePreviewTabs according to unifiedTabOrder
	// Uses shared buildUnifiedTabs which also appends orphaned tabs as a safety net
	const unifiedTabs = useMemo((): UnifiedTab[] => {
		if (!activeSession) return [];
		return buildUnifiedTabs(activeSession);
	}, [
		activeSession?.aiTabs,
		activeSession?.filePreviewTabs,
		activeSession?.terminalTabs,
		activeSession?.browserTabs,
		activeSession?.unifiedTabOrder,
	]);

	// Get the active file preview tab (if a file tab is active)
	const activeFileTab = useMemo((): FilePreviewTab | null => {
		if (!activeSession?.activeFileTabId) return null;
		return (
			activeSession.filePreviewTabs.find((tab) => tab.id === activeSession.activeFileTabId) ?? null
		);
	}, [activeSession?.activeFileTabId, activeSession?.filePreviewTabs]);

	const activeBrowserTab = useMemo((): BrowserTab | null => {
		if (!activeSession?.activeBrowserTabId) return null;
		return (
			activeSession.browserTabs?.find((tab) => tab.id === activeSession.activeBrowserTabId) ?? null
		);
	}, [activeSession?.activeBrowserTabId, activeSession?.browserTabs]);

	const isResumingSession = !!activeTab?.agentSessionId;

	// ========================================================================
	// File Tab Creation
	// ========================================================================

	/**
	 * Open a file preview tab. If a tab with the same path already exists, select it.
	 * Otherwise, create a new FilePreviewTab, add it to filePreviewTabs and unifiedTabOrder,
	 * and set it as the active file tab (deselecting any active AI tab).
	 *
	 * For SSH remote files, pass sshRemoteId so content can be re-fetched if needed.
	 */
	const handleOpenFileTab = useCallback(
		(
			file: FileTabOpenParams,
			options?: {
				/** If true, create new tab adjacent to current file tab. If false, replace current file tab content. Default: true (create new tab) */
				openInNewTab?: boolean;
				/** Override which session the tab is created in (defaults to current active session) */
				targetSessionId?: string;
			}
		) => {
			const openInNewTab = options?.openInNewTab ?? true;
			const { setSessions } = useSessionStore.getState();
			const activeSessionId =
				options?.targetSessionId || useSessionStore.getState().activeSessionId;

			setSessions((prev: Session[]) =>
				prev.map((s) => {
					if (s.id !== activeSessionId) return s;

					// Check if a tab with this path already exists
					const existingTab = s.filePreviewTabs.find((tab) => tab.path === file.path);
					if (existingTab) {
						// Tab exists - update content and lastModified if provided and select it
						const updatedTabs = s.filePreviewTabs.map((tab) =>
							tab.id === existingTab.id
								? {
										...tab,
										content: file.content,
										lastModified: file.lastModified ?? tab.lastModified,
										isLoading: false,
									}
								: tab
						);
						return {
							...s,
							filePreviewTabs: updatedTabs,
							activeFileTabId: existingTab.id,
							activeTerminalTabId: null,
							inputMode: 'ai' as const,
							activeTabId: s.activeTabId,
							unifiedTabOrder: ensureInUnifiedTabOrder(s.unifiedTabOrder, 'file', existingTab.id),
						};
					}

					// If not opening in new tab and there's an active file tab, replace its content
					if (!openInNewTab && s.activeFileTabId) {
						const currentTabId = s.activeFileTabId;
						const currentTab = s.filePreviewTabs.find((tab) => tab.id === currentTabId);
						const extension = file.name.includes('.') ? '.' + file.name.split('.').pop() : '';
						const nameWithoutExtension = extension
							? file.name.slice(0, -extension.length)
							: file.name;

						// Replace current tab's content with new file and update navigation history
						const updatedTabs = s.filePreviewTabs.map((tab) => {
							if (tab.id !== currentTabId) return tab;

							// Build updated navigation history
							const currentHistory = tab.navigationHistory ?? [];
							const currentIndex = tab.navigationIndex ?? currentHistory.length - 1;

							// Save current file to history before replacing
							// Truncate forward history if we're not at the end
							const truncatedHistory =
								currentIndex >= 0 && currentIndex < currentHistory.length - 1
									? currentHistory.slice(0, currentIndex + 1)
									: currentHistory;

							// Add current file to history if it exists and isn't already the last entry
							let newHistory = truncatedHistory;
							if (
								currentTab &&
								currentTab.path &&
								(truncatedHistory.length === 0 ||
									truncatedHistory[truncatedHistory.length - 1].path !== currentTab.path)
							) {
								newHistory = [
									...truncatedHistory,
									{
										path: currentTab.path,
										name: currentTab.name,
										scrollTop: currentTab.scrollTop,
									},
								];
							}

							// Add the new file to history
							const finalHistory = [
								...newHistory,
								{
									path: file.path,
									name: nameWithoutExtension,
									scrollTop: 0,
								},
							];

							return {
								...tab,
								path: file.path,
								name: nameWithoutExtension,
								extension,
								content: file.content,
								scrollTop: 0,
								searchQuery: '',
								editMode: false,
								editContent: undefined,
								lastModified: file.lastModified ?? Date.now(),
								sshRemoteId: file.sshRemoteId,
								isLoading: false,
								navigationHistory: finalHistory,
								navigationIndex: finalHistory.length - 1,
							};
						});
						return {
							...s,
							filePreviewTabs: updatedTabs,
						};
					}

					// Create a new file preview tab
					const newTabId = generateId();
					const extension = file.name.includes('.') ? '.' + file.name.split('.').pop() : '';
					const nameWithoutExtension = extension
						? file.name.slice(0, -extension.length)
						: file.name;

					const newFileTab: FilePreviewTab = {
						id: newTabId,
						path: file.path,
						name: nameWithoutExtension,
						extension,
						content: file.content,
						scrollTop: 0,
						searchQuery: '',
						editMode: false,
						editContent: undefined,
						createdAt: Date.now(),
						lastModified: file.lastModified ?? Date.now(),
						sshRemoteId: file.sshRemoteId,
						isLoading: false,
						navigationHistory: [{ path: file.path, name: nameWithoutExtension, scrollTop: 0 }],
						navigationIndex: 0,
					};

					// Create the unified tab reference
					const newTabRef: UnifiedTabRef = { type: 'file', id: newTabId };

					// If opening in new tab and there's an active file tab, insert adjacent to it
					let updatedUnifiedTabOrder: UnifiedTabRef[];
					if (openInNewTab && s.activeFileTabId) {
						const currentIndex = s.unifiedTabOrder.findIndex(
							(ref) => ref.type === 'file' && ref.id === s.activeFileTabId
						);
						if (currentIndex !== -1) {
							updatedUnifiedTabOrder = [
								...s.unifiedTabOrder.slice(0, currentIndex + 1),
								newTabRef,
								...s.unifiedTabOrder.slice(currentIndex + 1),
							];
						} else {
							updatedUnifiedTabOrder = [...s.unifiedTabOrder, newTabRef];
						}
					} else {
						updatedUnifiedTabOrder = [...s.unifiedTabOrder, newTabRef];
					}

					return {
						...s,
						filePreviewTabs: [...s.filePreviewTabs, newFileTab],
						unifiedTabOrder: updatedUnifiedTabOrder,
						activeFileTabId: newTabId,
						activeTerminalTabId: null,
						inputMode: 'ai' as const,
					};
				})
			);
		},
		[]
	);

	// ========================================================================
	// AI Tab Operations
	// ========================================================================

	const handleNewAgentSession = useCallback(() => {
		const { setSessions } = useSessionStore.getState();
		const activeSessionId = useSessionStore.getState().activeSessionId;
		const { defaultSaveToHistory, defaultShowThinking } = useSettingsStore.getState();

		setSessions((prev: Session[]) => {
			const currentSession = prev.find((s) => s.id === activeSessionId);
			if (!currentSession) return prev;
			return prev.map((s) => {
				if (s.id !== currentSession.id) return s;
				const result = createTab(s, {
					saveToHistory: defaultSaveToHistory,
					showThinking: defaultShowThinking,
				});
				if (!result) return s;
				return result.session;
			});
		});
		useModalStore.getState().closeModal('agentSessions');
	}, []);

	const handleTabSelect = useCallback((tabId: string) => {
		const { setSessions, activeSessionId } = useSessionStore.getState();
		setSessions((prev: Session[]) =>
			prev.map((s) => {
				if (s.id !== activeSessionId) return s;
				const result = setActiveTab(s, tabId);
				return result ? result.session : s;
			})
		);
	}, []);

	// ========================================================================
	// File Tab Operations
	// ========================================================================

	/**
	 * Force close a file preview tab without confirmation.
	 */
	const forceCloseFileTab = useCallback((tabId: string) => {
		const { setSessions, activeSessionId } = useSessionStore.getState();
		setSessions((prev: Session[]) =>
			prev.map((s) => {
				if (s.id !== activeSessionId) return s;
				const result = closeFileTabHelper(s, tabId);
				if (!result) return s;
				return result.session;
			})
		);
	}, []);

	/**
	 * Close a file preview tab with unsaved changes check.
	 */
	const handleCloseFileTab = useCallback(
		(tabId: string) => {
			const currentSession = selectActiveSession(useSessionStore.getState());
			if (!currentSession) {
				forceCloseFileTab(tabId);
				return;
			}

			const tabToClose = currentSession.filePreviewTabs.find((tab) => tab.id === tabId);
			if (!tabToClose) {
				forceCloseFileTab(tabId);
				return;
			}

			if (tabToClose.editContent !== undefined) {
				useModalStore.getState().openModal('confirm', {
					message: `"${tabToClose.name}${tabToClose.extension}" has unsaved changes. Are you sure you want to close it?`,
					onConfirm: () => {
						forceCloseFileTab(tabId);
					},
				});
			} else {
				forceCloseFileTab(tabId);
			}
		},
		[forceCloseFileTab]
	);

	const handleFileTabEditModeChange = useCallback((tabId: string, editMode: boolean) => {
		const { setSessions, activeSessionId } = useSessionStore.getState();
		setSessions((prev: Session[]) =>
			prev.map((s) => {
				if (s.id !== activeSessionId) return s;
				const updatedFileTabs = s.filePreviewTabs.map((tab) => {
					if (tab.id !== tabId) return tab;
					return { ...tab, editMode };
				});
				return { ...s, filePreviewTabs: updatedFileTabs };
			})
		);
	}, []);

	const handleFileTabEditContentChange = useCallback(
		(tabId: string, editContent: string | undefined, savedContent?: string) => {
			const { setSessions, activeSessionId } = useSessionStore.getState();
			setSessions((prev: Session[]) =>
				prev.map((s) => {
					if (s.id !== activeSessionId) return s;
					const updatedFileTabs = s.filePreviewTabs.map((tab) => {
						if (tab.id !== tabId) return tab;
						if (savedContent !== undefined) {
							return { ...tab, editContent, content: savedContent };
						}
						return { ...tab, editContent };
					});
					return { ...s, filePreviewTabs: updatedFileTabs };
				})
			);
		},
		[]
	);

	const handleFileTabScrollPositionChange = useCallback((tabId: string, scrollTop: number) => {
		const { setSessions, activeSessionId } = useSessionStore.getState();
		setSessions((prev: Session[]) =>
			prev.map((s) => {
				if (s.id !== activeSessionId) return s;
				const updatedFileTabs = s.filePreviewTabs.map((tab) => {
					if (tab.id !== tabId) return tab;

					let updatedHistory = tab.navigationHistory;
					if (updatedHistory && updatedHistory.length > 0) {
						const currentIndex = tab.navigationIndex ?? updatedHistory.length - 1;
						if (currentIndex >= 0 && currentIndex < updatedHistory.length) {
							updatedHistory = updatedHistory.map((entry, idx) =>
								idx === currentIndex ? { ...entry, scrollTop } : entry
							);
						}
					}
					return { ...tab, scrollTop, navigationHistory: updatedHistory };
				});
				return { ...s, filePreviewTabs: updatedFileTabs };
			})
		);
	}, []);

	const handleFileTabSearchQueryChange = useCallback((tabId: string, searchQuery: string) => {
		const { setSessions, activeSessionId } = useSessionStore.getState();
		setSessions((prev: Session[]) =>
			prev.map((s) => {
				if (s.id !== activeSessionId) return s;
				const updatedFileTabs = s.filePreviewTabs.map((tab) => {
					if (tab.id !== tabId) return tab;
					return { ...tab, searchQuery };
				});
				return { ...s, filePreviewTabs: updatedFileTabs };
			})
		);
	}, []);

	const handleReloadFileTab = useCallback(async (tabId: string) => {
		const currentSession = selectActiveSession(useSessionStore.getState());
		if (!currentSession) return;

		const fileTab = currentSession.filePreviewTabs.find((tab) => tab.id === tabId);
		if (!fileTab) return;

		try {
			const [content, stat] = await Promise.all([
				window.maestro.fs.readFile(fileTab.path, fileTab.sshRemoteId),
				window.maestro.fs.stat(fileTab.path, fileTab.sshRemoteId),
			]);
			if (content === null) return;
			const newMtime = stat?.modifiedAt ? new Date(stat.modifiedAt).getTime() : Date.now();

			useSessionStore.getState().setSessions((prev: Session[]) =>
				prev.map((s) => {
					if (s.id !== useSessionStore.getState().activeSessionId) return s;
					return {
						...s,
						filePreviewTabs: s.filePreviewTabs.map((tab) =>
							tab.id === tabId
								? {
										...tab,
										content,
										lastModified: newMtime,
										editContent: undefined,
									}
								: tab
						),
					};
				})
			);
		} catch (error) {
			logger.debug('[handleReloadFileTab] Failed to reload:', undefined, error);
		}
	}, []);

	/**
	 * Select a file preview tab. If fileTabAutoRefreshEnabled, checks if file changed on disk.
	 */
	const handleSelectFileTab = useCallback(async (tabId: string) => {
		const { setSessions } = useSessionStore.getState();
		const currentSession = selectActiveSession(useSessionStore.getState());
		if (!currentSession) return;

		const fileTab = currentSession.filePreviewTabs.find((tab) => tab.id === tabId);
		if (!fileTab) return;

		// Set the tab as active immediately, and reset inputMode/activeTerminalTabId in case
		// we're switching away from terminal mode (clicking a file tab while terminal is active).
		setSessions((prev: Session[]) =>
			prev.map((s) => {
				if (s.id !== currentSession.id) return s;
				return {
					...s,
					activeFileTabId: tabId,
					activeBrowserTabId: null,
					activeTerminalTabId: null,
					inputMode: 'ai',
				};
			})
		);

		// Auto-refresh if enabled and tab has no pending edits
		const { fileTabAutoRefreshEnabled } = useSettingsStore.getState();
		if (fileTabAutoRefreshEnabled && !fileTab.editContent) {
			try {
				const stat = await window.maestro.fs.stat(fileTab.path, fileTab.sshRemoteId);
				if (!stat || !stat.modifiedAt) return;

				const currentMtime = new Date(stat.modifiedAt).getTime();

				if (currentMtime > fileTab.lastModified) {
					const content = await window.maestro.fs.readFile(fileTab.path, fileTab.sshRemoteId);
					if (content === null) return;
					useSessionStore.getState().setSessions((prev: Session[]) =>
						prev.map((s) => {
							if (s.id !== useSessionStore.getState().activeSessionId) return s;
							return {
								...s,
								filePreviewTabs: s.filePreviewTabs.map((tab) =>
									tab.id === tabId ? { ...tab, content, lastModified: currentMtime } : tab
								),
							};
						})
					);
				}
			} catch (error) {
				logger.debug('[handleSelectFileTab] Auto-refresh failed:', undefined, error);
			}
		}
	}, []);

	const handleNewFileTab = useCallback(() => {
		const { setSessions, activeSessionId } = useSessionStore.getState();
		setSessions((prev: Session[]) =>
			prev.map((s) => {
				if (s.id !== activeSessionId) return s;

				const newTabId = generateId();
				const newFileTab: FilePreviewTab = {
					id: newTabId,
					path: '',
					name: 'Untitled',
					extension: '',
					content: '',
					scrollTop: 0,
					searchQuery: '',
					editMode: true,
					editContent: '',
					createdAt: Date.now(),
					lastModified: Date.now(),
					isLoading: false,
					navigationHistory: [],
					navigationIndex: -1,
				};

				const newTabRef: UnifiedTabRef = { type: 'file', id: newTabId };

				// Insert adjacent to current file tab if one is active
				let updatedUnifiedTabOrder: UnifiedTabRef[];
				if (s.activeFileTabId) {
					const currentIndex = s.unifiedTabOrder.findIndex(
						(ref) => ref.type === 'file' && ref.id === s.activeFileTabId
					);
					if (currentIndex !== -1) {
						updatedUnifiedTabOrder = [
							...s.unifiedTabOrder.slice(0, currentIndex + 1),
							newTabRef,
							...s.unifiedTabOrder.slice(currentIndex + 1),
						];
					} else {
						updatedUnifiedTabOrder = [...s.unifiedTabOrder, newTabRef];
					}
				} else {
					updatedUnifiedTabOrder = [...s.unifiedTabOrder, newTabRef];
				}

				return {
					...s,
					filePreviewTabs: [...s.filePreviewTabs, newFileTab],
					unifiedTabOrder: updatedUnifiedTabOrder,
					activeFileTabId: newTabId,
					activeBrowserTabId: null,
					activeTerminalTabId: null,
					inputMode: 'ai' as const,
				};
			})
		);
	}, []);

	const handleNewBrowserTab = useCallback(() => {
		const { setSessions, activeSessionId } = useSessionStore.getState();
		const homeUrl = useSettingsStore.getState().browserHomeUrl || DEFAULT_BROWSER_TAB_URL;
		setSessions((prev: Session[]) =>
			prev.map((s) => {
				if (s.id !== activeSessionId) return s;

				const url = homeUrl;
				const newBrowserTab: BrowserTab = {
					id: generateId(),
					url,
					title: url === DEFAULT_BROWSER_TAB_URL ? DEFAULT_BROWSER_TAB_TITLE : url,
					createdAt: Date.now(),
					partition: getBrowserTabPartition(s.id),
					canGoBack: false,
					canGoForward: false,
					isLoading: url !== DEFAULT_BROWSER_TAB_URL,
					favicon: null,
				};

				return {
					...s,
					browserTabs: [...(s.browserTabs || []), newBrowserTab],
					activeFileTabId: null,
					activeBrowserTabId: newBrowserTab.id,
					activeTerminalTabId: null,
					inputMode: 'ai',
					unifiedTabOrder: ensureInUnifiedTabOrder(
						s.unifiedTabOrder || [],
						'browser',
						newBrowserTab.id
					),
				};
			})
		);
	}, []);

	const handleSelectBrowserTab = useCallback((tabId: string) => {
		const { setSessions, activeSessionId } = useSessionStore.getState();
		setSessions((prev: Session[]) =>
			prev.map((s) => {
				if (s.id !== activeSessionId) return s;
				if (!(s.browserTabs || []).some((tab) => tab.id === tabId)) return s;
				return {
					...s,
					activeFileTabId: null,
					activeBrowserTabId: tabId,
					activeTerminalTabId: null,
					inputMode: 'ai',
					unifiedTabOrder: ensureInUnifiedTabOrder(s.unifiedTabOrder || [], 'browser', tabId),
				};
			})
		);
	}, []);

	const forceCloseBrowserTab = useCallback((tabId: string) => {
		const { setSessions, activeSessionId } = useSessionStore.getState();
		setSessions((prev: Session[]) =>
			prev.map((s) => {
				if (s.id !== activeSessionId) return s;
				const result = closeBrowserTabHelper(s, tabId);
				return result ? result.session : s;
			})
		);
	}, []);

	const handleCloseBrowserTab = useCallback(
		(tabId: string) => {
			forceCloseBrowserTab(tabId);
		},
		[forceCloseBrowserTab]
	);

	const handleUpdateBrowserTab = useCallback(
		(sessionId: string, tabId: string, updates: Partial<BrowserTab>) => {
			const { setSessions } = useSessionStore.getState();
			setSessions((prev: Session[]) =>
				prev.map((s) => {
					if (s.id !== sessionId) return s;
					return {
						...s,
						browserTabs: (s.browserTabs || []).map((tab) => {
							if (tab.id !== tabId) return tab;
							const nextUrl =
								typeof updates.url === 'string' ? normalizeBrowserTabUrl(updates.url) : tab.url;
							return {
								...tab,
								...updates,
								url: nextUrl,
								title: getBrowserTabTitle(nextUrl, updates.title ?? tab.title),
							};
						}),
					};
				})
			);
		},
		[]
	);

	const handleUnifiedTabReorder = useCallback((fromIndex: number, toIndex: number) => {
		const { setSessions, activeSessionId } = useSessionStore.getState();
		setSessions((prev: Session[]) =>
			prev.map((s) => {
				if (s.id !== activeSessionId) return s;
				logger.debug('[useTabHandlers] handleUnifiedTabReorder', undefined, {
					fromIndex,
					toIndex,
					orderLength: s.unifiedTabOrder.length,
					order: s.unifiedTabOrder.map((r) => `${r.type}:${r.id.slice(0, 8)}`),
				});
				if (
					fromIndex < 0 ||
					fromIndex >= s.unifiedTabOrder.length ||
					toIndex < 0 ||
					toIndex >= s.unifiedTabOrder.length ||
					fromIndex === toIndex
				) {
					logger.debug(
						'[useTabHandlers] handleUnifiedTabReorder: bounds check failed, returning unchanged'
					);
					return s;
				}
				const newOrder = [...s.unifiedTabOrder];
				const [movedRef] = newOrder.splice(fromIndex, 1);
				newOrder.splice(toIndex, 0, movedRef);
				logger.debug('[useTabHandlers] handleUnifiedTabReorder: reordered', undefined, {
					movedRef,
					newOrder: newOrder.map((r) => `${r.type}:${r.id.slice(0, 8)}`),
				});
				return { ...s, unifiedTabOrder: newOrder };
			})
		);
	}, []);

	// ========================================================================
	// Tab Close Operations
	// ========================================================================

	/**
	 * Internal tab close handler that performs the actual close.
	 */
	const performTabClose = useCallback((tabId: string) => {
		const { setSessions, activeSessionId } = useSessionStore.getState();
		setSessions((prev: Session[]) =>
			prev.map((s) => {
				if (s.id !== activeSessionId) return s;
				const tab = s.aiTabs.find((t) => t.id === tabId);
				const isWizardTab = tab && hasActiveWizard(tab);
				const unifiedIndex = s.unifiedTabOrder.findIndex(
					(ref) => ref.type === 'ai' && ref.id === tabId
				);
				const result = closeTab(s, tabId, false, { skipHistory: isWizardTab });
				if (!result) return s;
				if (!isWizardTab && tab) {
					return addAiTabToUnifiedHistory(result.session, tab, unifiedIndex);
				}
				return result.session;
			})
		);
	}, []);

	const handleTabClose = useCallback(
		(tabId: string) => {
			const session = selectActiveSession(useSessionStore.getState());
			const tab = session?.aiTabs.find((t) => t.id === tabId);

			if (tab && hasActiveWizard(tab)) {
				useModalStore.getState().openModal('confirm', {
					message: 'Close this wizard? Your progress will be lost and cannot be restored.',
					onConfirm: () => performTabClose(tabId),
				});
			} else if (tab && hasDraft(tab)) {
				useModalStore.getState().openModal('confirm', {
					message: 'This tab has an unsent draft. Are you sure you want to close it?',
					onConfirm: () => performTabClose(tabId),
				});
			} else {
				performTabClose(tabId);
			}
		},
		[performTabClose]
	);

	const handleNewTab = useCallback(() => {
		const { setSessions, activeSessionId } = useSessionStore.getState();
		const { defaultSaveToHistory, defaultShowThinking } = useSettingsStore.getState();
		setSessions((prev: Session[]) =>
			prev.map((s) => {
				if (s.id !== activeSessionId) return s;
				const result = createTab(s, {
					saveToHistory: defaultSaveToHistory,
					showThinking: defaultShowThinking,
				});
				if (!result) return s;
				return result.session;
			})
		);
	}, []);

	const performCloseAllTabs = useCallback(() => {
		const { setSessions, activeSessionId } = useSessionStore.getState();
		setSessions((prev: Session[]) =>
			prev.map((s) => {
				if (s.id !== activeSessionId) return s;
				let updatedSession = s;
				const tabIds = s.aiTabs.map((t) => t.id);
				for (const tabId of tabIds) {
					const tab = updatedSession.aiTabs.find((t) => t.id === tabId);
					const result = closeTab(updatedSession, tabId, false, {
						skipHistory: tab ? hasActiveWizard(tab) : false,
					});
					if (result) {
						updatedSession = result.session;
					}
				}
				return updatedSession;
			})
		);
	}, []);

	const handleCloseAllTabs = useCallback(() => {
		const session = selectActiveSession(useSessionStore.getState());
		if (!session) return;

		const hasAnyDraft = session.aiTabs.some((tab) => hasDraft(tab));
		if (hasAnyDraft) {
			useModalStore.getState().openModal('confirm', {
				message: 'Some tabs have unsent drafts. Are you sure you want to close all tabs?',
				onConfirm: performCloseAllTabs,
			});
		} else {
			performCloseAllTabs();
		}
	}, [performCloseAllTabs]);

	const performCloseOtherTabs = useCallback(() => {
		const { sessions, setSessions, activeSessionId } = useSessionStore.getState();
		const session = sessions.find((s) => s.id === activeSessionId);
		if (!session) return;

		const activeRef = getActiveUnifiedRef(session);
		if (!activeRef) return;

		const tabsToClose = session.unifiedTabOrder.filter(
			(ref) => !(ref.type === activeRef.type && ref.id === activeRef.id)
		);
		const terminalTabIds = tabsToClose.filter((r) => r.type === 'terminal').map((r) => r.id);

		setSessions((prev: Session[]) =>
			prev.map((s) => {
				if (s.id !== activeSessionId) return s;

				let updatedSession = s;

				for (const tabRef of tabsToClose) {
					if (tabRef.type === 'ai') {
						const tab = updatedSession.aiTabs.find((t) => t.id === tabRef.id);
						if (tab) {
							const result = closeTab(updatedSession, tab.id, false, {
								skipHistory: hasActiveWizard(tab),
							});
							if (result) {
								updatedSession = result.session;
							}
						}
					} else if (tabRef.type === 'terminal') {
						updatedSession = closeTerminalTabHelper(updatedSession, tabRef.id);
					} else if (tabRef.type === 'browser') {
						const result = closeBrowserTabHelper(updatedSession, tabRef.id);
						if (result) {
							updatedSession = result.session;
						}
					} else {
						updatedSession = {
							...updatedSession,
							filePreviewTabs: updatedSession.filePreviewTabs.filter((t) => t.id !== tabRef.id),
							unifiedTabOrder: updatedSession.unifiedTabOrder.filter(
								(ref) => !(ref.type === 'file' && ref.id === tabRef.id)
							),
						};
					}
				}

				return updatedSession;
			})
		);

		for (const tabId of terminalTabIds) {
			window.maestro.process.kill(getTerminalSessionId(session.id, tabId));
		}
	}, []);

	const handleCloseOtherTabs = useCallback(() => {
		const session = selectActiveSession(useSessionStore.getState());
		if (!session) return;

		const activeTabId = session.activeFileTabId ?? session.activeTabId;
		const otherAiTabs = session.aiTabs.filter((t) => t.id !== activeTabId);
		const hasAnyDraft = otherAiTabs.some((tab) => hasDraft(tab));
		if (hasAnyDraft) {
			useModalStore.getState().openModal('confirm', {
				message: 'Some tabs have unsent drafts. Are you sure you want to close them?',
				onConfirm: performCloseOtherTabs,
			});
		} else {
			performCloseOtherTabs();
		}
	}, [performCloseOtherTabs]);

	const performCloseTabsLeft = useCallback(() => {
		const { sessions, setSessions, activeSessionId } = useSessionStore.getState();
		const session = sessions.find((s) => s.id === activeSessionId);
		if (!session) return;

		const activeRef = getActiveUnifiedRef(session);
		if (!activeRef) return;

		const activeIndex = session.unifiedTabOrder.findIndex(
			(ref) => ref.type === activeRef.type && ref.id === activeRef.id
		);
		if (activeIndex <= 0) return;

		const tabsToClose = session.unifiedTabOrder.slice(0, activeIndex);
		const terminalTabIds = tabsToClose.filter((r) => r.type === 'terminal').map((r) => r.id);

		setSessions((prev: Session[]) =>
			prev.map((s) => {
				if (s.id !== activeSessionId) return s;

				let updatedSession = s;

				for (const tabRef of tabsToClose) {
					if (tabRef.type === 'ai') {
						const tab = updatedSession.aiTabs.find((t) => t.id === tabRef.id);
						if (tab) {
							const result = closeTab(updatedSession, tab.id, false, {
								skipHistory: hasActiveWizard(tab),
							});
							if (result) {
								updatedSession = result.session;
							}
						}
					} else if (tabRef.type === 'terminal') {
						updatedSession = closeTerminalTabHelper(updatedSession, tabRef.id);
					} else if (tabRef.type === 'browser') {
						const result = closeBrowserTabHelper(updatedSession, tabRef.id);
						if (result) {
							updatedSession = result.session;
						}
					} else {
						updatedSession = {
							...updatedSession,
							filePreviewTabs: updatedSession.filePreviewTabs.filter((t) => t.id !== tabRef.id),
							unifiedTabOrder: updatedSession.unifiedTabOrder.filter(
								(ref) => !(ref.type === 'file' && ref.id === tabRef.id)
							),
						};
					}
				}

				return updatedSession;
			})
		);

		for (const tabId of terminalTabIds) {
			window.maestro.process.kill(getTerminalSessionId(session.id, tabId));
		}
	}, []);

	const handleCloseTabsLeft = useCallback(() => {
		const session = selectActiveSession(useSessionStore.getState());
		if (!session) return;

		const activeRef = getActiveUnifiedRef(session);
		if (!activeRef) return;
		const activeIndex = session.unifiedTabOrder.findIndex(
			(ref) => ref.type === activeRef.type && ref.id === activeRef.id
		);
		if (activeIndex <= 0) return;

		const tabRefsToClose = session.unifiedTabOrder.slice(0, activeIndex);
		const aiTabIds = new Set(tabRefsToClose.filter((r) => r.type === 'ai').map((r) => r.id));
		const hasAnyDraft = session.aiTabs
			.filter((t) => aiTabIds.has(t.id))
			.some((tab) => hasDraft(tab));
		if (hasAnyDraft) {
			useModalStore.getState().openModal('confirm', {
				message: 'Some tabs have unsent drafts. Are you sure you want to close them?',
				onConfirm: performCloseTabsLeft,
			});
		} else {
			performCloseTabsLeft();
		}
	}, [performCloseTabsLeft]);

	const performCloseTabsRight = useCallback(() => {
		const { sessions, setSessions, activeSessionId } = useSessionStore.getState();
		const session = sessions.find((s) => s.id === activeSessionId);
		if (!session) return;

		const activeRef = getActiveUnifiedRef(session);
		if (!activeRef) return;

		const activeIndex = session.unifiedTabOrder.findIndex(
			(ref) => ref.type === activeRef.type && ref.id === activeRef.id
		);
		if (activeIndex < 0 || activeIndex >= session.unifiedTabOrder.length - 1) return;

		const tabsToClose = session.unifiedTabOrder.slice(activeIndex + 1);
		const terminalTabIds = tabsToClose.filter((r) => r.type === 'terminal').map((r) => r.id);

		setSessions((prev: Session[]) =>
			prev.map((s) => {
				if (s.id !== activeSessionId) return s;

				let updatedSession = s;

				for (const tabRef of tabsToClose) {
					if (tabRef.type === 'ai') {
						const tab = updatedSession.aiTabs.find((t) => t.id === tabRef.id);
						if (tab) {
							const result = closeTab(updatedSession, tab.id, false, {
								skipHistory: hasActiveWizard(tab),
							});
							if (result) {
								updatedSession = result.session;
							}
						}
					} else if (tabRef.type === 'terminal') {
						updatedSession = closeTerminalTabHelper(updatedSession, tabRef.id);
					} else if (tabRef.type === 'browser') {
						const result = closeBrowserTabHelper(updatedSession, tabRef.id);
						if (result) {
							updatedSession = result.session;
						}
					} else {
						updatedSession = {
							...updatedSession,
							filePreviewTabs: updatedSession.filePreviewTabs.filter((t) => t.id !== tabRef.id),
							unifiedTabOrder: updatedSession.unifiedTabOrder.filter(
								(ref) => !(ref.type === 'file' && ref.id === tabRef.id)
							),
						};
					}
				}

				return updatedSession;
			})
		);

		for (const tabId of terminalTabIds) {
			window.maestro.process.kill(getTerminalSessionId(session.id, tabId));
		}
	}, []);

	const handleCloseTabsRight = useCallback(() => {
		const session = selectActiveSession(useSessionStore.getState());
		if (!session) return;

		const activeRef = getActiveUnifiedRef(session);
		if (!activeRef) return;
		const activeIndex = session.unifiedTabOrder.findIndex(
			(ref) => ref.type === activeRef.type && ref.id === activeRef.id
		);
		if (activeIndex < 0 || activeIndex >= session.unifiedTabOrder.length - 1) return;

		const tabRefsToClose = session.unifiedTabOrder.slice(activeIndex + 1);
		const aiTabIds = new Set(tabRefsToClose.filter((r) => r.type === 'ai').map((r) => r.id));
		const hasAnyDraft = session.aiTabs
			.filter((t) => aiTabIds.has(t.id))
			.some((tab) => hasDraft(tab));
		if (hasAnyDraft) {
			useModalStore.getState().openModal('confirm', {
				message: 'Some tabs have unsent drafts. Are you sure you want to close them?',
				onConfirm: performCloseTabsRight,
			});
		} else {
			performCloseTabsRight();
		}
	}, [performCloseTabsRight]);

	const handleCloseCurrentTab = useCallback((): CloseCurrentTabResult => {
		const { setSessions } = useSessionStore.getState();
		const session = selectActiveSession(useSessionStore.getState());
		if (!session) return { type: 'none' };

		// Terminal tab is active — close it (unless it's the only tab of any type)
		if (session.inputMode === 'terminal' && session.activeTerminalTabId) {
			const tabId = session.activeTerminalTabId;
			// Allow closing terminal tabs as long as there are other tabs to fall back to.
			// closeTerminalTabHelper handles selecting the adjacent tab (which may be AI or file).
			const totalTabs =
				(session.aiTabs?.length || 0) +
				(session.filePreviewTabs?.length || 0) +
				(session.browserTabs?.length || 0) +
				(session.terminalTabs?.length || 0);
			if (totalTabs <= 1) {
				return { type: 'prevented' };
			}
			return { type: 'terminal', tabId };
		}

		// Check if a file tab is active — delegate to handleCloseFileTab
		// which shows an unsaved-changes confirmation modal when needed
		if (session.activeFileTabId) {
			const tabId = session.activeFileTabId;
			handleCloseFileTab(tabId);
			return { type: 'file', tabId };
		}

		if (session.activeBrowserTabId) {
			const tabId = session.activeBrowserTabId;
			setSessions((prev: Session[]) =>
				prev.map((s) => {
					if (s.id !== session.id) return s;
					const result = closeBrowserTabHelper(s, tabId);
					return result ? result.session : s;
				})
			);
			return { type: 'browser', tabId };
		}

		// AI tab is active
		if (session.activeTabId) {
			const tabId = session.activeTabId;
			const tab = session.aiTabs.find((t) => t.id === tabId);
			const isWizardTab = tab ? hasActiveWizard(tab) : false;
			const tabHasDraft = tab ? hasDraft(tab) : false;

			return { type: 'ai', tabId, isWizardTab, hasDraft: tabHasDraft };
		}

		return { type: 'none' };
	}, [handleCloseFileTab]);

	// ========================================================================
	// Log Deletion
	// ========================================================================

	const handleDeleteLog = useCallback((logId: string): number | null => {
		const { setSessions } = useSessionStore.getState();
		const currentSession = selectActiveSession(useSessionStore.getState());
		if (!currentSession) return null;

		const isAIMode = currentSession.inputMode === 'ai';
		const currentActiveTab = isAIMode ? getActiveTab(currentSession) : null;
		const logs = isAIMode ? currentActiveTab?.logs || [] : currentSession.shellLogs;

		const logIndex = logs.findIndex((log) => log.id === logId);
		if (logIndex === -1) return null;

		const log = logs[logIndex];
		if (log.source !== 'user') return null;

		let endIndex = logs.length;
		for (let i = logIndex + 1; i < logs.length; i++) {
			if (logs[i].source === 'user') {
				endIndex = i;
				break;
			}
		}

		const newLogs = [...logs.slice(0, logIndex), ...logs.slice(endIndex)];

		let nextUserCommandIndex: number | null = null;
		for (let i = logIndex; i < newLogs.length; i++) {
			if (newLogs[i].source === 'user') {
				nextUserCommandIndex = i;
				break;
			}
		}
		if (nextUserCommandIndex === null) {
			for (let i = logIndex - 1; i >= 0; i--) {
				if (newLogs[i].source === 'user') {
					nextUserCommandIndex = i;
					break;
				}
			}
		}

		if (isAIMode && currentActiveTab) {
			const agentSessionId = currentActiveTab.agentSessionId;
			if (agentSessionId && currentSession.cwd) {
				window.maestro.claude
					.deleteMessagePair(currentSession.cwd, agentSessionId, logId, log.text)
					.then((result) => {
						if (!result.success) {
							logger.warn(
								'[handleDeleteLog] Failed to delete from Claude session:',
								undefined,
								result.error
							);
						}
					})
					.catch((err) => {
						logger.error('[handleDeleteLog] Error deleting from Claude session:', undefined, err);
					});
			}

			const commandText = log.text.trim();

			setSessions((prev: Session[]) =>
				prev.map((s) => {
					if (s.id !== currentSession.id) return s;
					const newAICommandHistory = (s.aiCommandHistory || []).filter(
						(cmd) => cmd !== commandText
					);
					return {
						...s,
						aiCommandHistory: newAICommandHistory,
						aiTabs: s.aiTabs.map((tab) =>
							tab.id === currentActiveTab.id ? { ...tab, logs: newLogs } : tab
						),
					};
				})
			);
		} else {
			const commandText = log.text.trim();

			setSessions((prev: Session[]) =>
				prev.map((s) => {
					if (s.id !== currentSession.id) return s;
					const newShellCommandHistory = (s.shellCommandHistory || []).filter(
						(cmd) => cmd !== commandText
					);
					return {
						...s,
						shellLogs: newLogs,
						shellCommandHistory: newShellCommandHistory,
					};
				})
			);
		}

		return nextUserCommandIndex;
	}, []);

	// ========================================================================
	// Tab Properties
	// ========================================================================

	const handleRequestTabRename = useCallback((tabId: string) => {
		logger.info('[DEBUG renameTab] handleRequestTabRename called', undefined, { tabId });
		const { setSessions } = useSessionStore.getState();
		const session = selectActiveSession(useSessionStore.getState());
		if (!session) {
			logger.info('[DEBUG renameTab] no session found');
			return;
		}
		const tab = session.aiTabs?.find((t) => t.id === tabId);
		logger.info('[DEBUG renameTab] tab found:', undefined, [
			!!tab,
			{
				aiTabCount: session.aiTabs?.length,
				tabId,
			},
		]);
		if (tab) {
			if (tab.isGeneratingName) {
				setSessions((prev: Session[]) =>
					prev.map((s) => {
						if (s.id !== session.id) return s;
						return {
							...s,
							aiTabs: s.aiTabs.map((t) => (t.id === tabId ? { ...t, isGeneratingName: false } : t)),
						};
					})
				);
			}
			useModalStore.getState().openModal('renameTab', {
				tabId,
				initialName: getInitialRenameValue(tab),
			});
		}
	}, []);

	const handleTabReorder = useCallback((fromIndex: number, toIndex: number) => {
		const { setSessions, activeSessionId } = useSessionStore.getState();
		setSessions((prev: Session[]) =>
			prev.map((s) => {
				if (s.id !== activeSessionId || !s.aiTabs) return s;
				const tabs = [...s.aiTabs];
				const [movedTab] = tabs.splice(fromIndex, 1);
				tabs.splice(toIndex, 0, movedTab);
				return { ...s, aiTabs: tabs };
			})
		);
	}, []);

	const handleUpdateTabByClaudeSessionId = useCallback(
		(agentSessionId: string, updates: { name?: string | null; starred?: boolean }) => {
			const { setSessions, activeSessionId } = useSessionStore.getState();
			setSessions((prev: Session[]) =>
				prev.map((s) => {
					if (s.id !== activeSessionId) return s;
					const tabIndex = s.aiTabs.findIndex((tab) => tab.agentSessionId === agentSessionId);
					if (tabIndex === -1) return s;
					return {
						...s,
						aiTabs: s.aiTabs.map((tab) =>
							tab.agentSessionId === agentSessionId
								? {
										...tab,
										...(updates.name !== undefined ? { name: updates.name } : {}),
										...(updates.starred !== undefined ? { starred: updates.starred } : {}),
									}
								: tab
						),
					};
				})
			);
		},
		[]
	);

	const handleTabStar = useCallback((tabId: string, starred: boolean) => {
		const { setSessions } = useSessionStore.getState();
		const session = selectActiveSession(useSessionStore.getState());
		if (!session) return;
		const tabToStar = session.aiTabs.find((t) => t.id === tabId);
		if (!tabToStar?.agentSessionId) return;

		setSessions((prev: Session[]) =>
			prev.map((s) => {
				if (s.id !== session.id) return s;
				const tab = s.aiTabs.find((t) => t.id === tabId);
				if (tab?.agentSessionId) {
					const agentId = s.toolType || 'claude-code';
					if (agentId === 'claude-code') {
						window.maestro.claude
							.updateSessionStarred(s.projectRoot, tab.agentSessionId, starred)
							.catch((err) => logger.error('Failed to persist tab starred:', undefined, err));
					} else {
						window.maestro.agentSessions
							.setSessionStarred(agentId, s.projectRoot, tab.agentSessionId, starred)
							.catch((err) => logger.error('Failed to persist tab starred:', undefined, err));
					}
				}
				return {
					...s,
					aiTabs: s.aiTabs.map((t) => (t.id === tabId ? { ...t, starred } : t)),
				};
			})
		);
	}, []);

	const handleTabMarkUnread = useCallback((tabId: string) => {
		const { setSessions, activeSessionId } = useSessionStore.getState();
		setSessions((prev: Session[]) =>
			prev.map((s) => {
				if (s.id !== activeSessionId) return s;
				return {
					...s,
					aiTabs: s.aiTabs.map((t) => (t.id === tabId ? { ...t, hasUnread: true } : t)),
				};
			})
		);
	}, []);

	const handleToggleTabReadOnlyMode = useCallback(() => {
		const session = selectActiveSession(useSessionStore.getState());
		if (!session) return;
		const currentActiveTab = getActiveTab(session);
		if (!currentActiveTab) return;
		updateAiTab(session.id, currentActiveTab.id, (tab) => ({
			...tab,
			readOnlyMode: !tab.readOnlyMode,
		}));
	}, []);

	const handleToggleTabSaveToHistory = useCallback(() => {
		const session = selectActiveSession(useSessionStore.getState());
		if (!session) return;
		const currentActiveTab = getActiveTab(session);
		if (!currentActiveTab) return;
		updateAiTab(session.id, currentActiveTab.id, (tab) => ({
			...tab,
			saveToHistory: !tab.saveToHistory,
		}));
	}, []);

	const handleToggleTabShowThinking = useCallback(() => {
		const session = selectActiveSession(useSessionStore.getState());
		if (!session) return;
		const currentActiveTab = getActiveTab(session);
		if (!currentActiveTab) return;

		const cycleThinkingMode = (current: ThinkingMode | undefined): ThinkingMode => {
			if (!current || current === 'off') return 'on';
			if (current === 'on') return 'sticky';
			return 'off';
		};

		updateAiTab(session.id, currentActiveTab.id, (tab) => {
			const newMode = cycleThinkingMode(tab.showThinking);
			if (newMode === 'off') {
				return {
					...tab,
					showThinking: 'off',
					logs: tab.logs.filter((l) => l.source !== 'thinking' && l.source !== 'tool'),
				};
			}
			return { ...tab, showThinking: newMode };
		});
	}, []);

	// ========================================================================
	// Scroll State
	// ========================================================================

	const handleScrollPositionChange = useCallback((scrollTop: number) => {
		const session = selectActiveSession(useSessionStore.getState());
		if (!session) return;
		if (session.inputMode === 'ai') {
			const currentActiveTab = getActiveTab(session);
			if (!currentActiveTab) return;
			updateAiTab(session.id, currentActiveTab.id, (tab) => ({ ...tab, scrollTop }));
		} else {
			useSessionStore.getState().updateSession(session.id, { terminalScrollTop: scrollTop });
		}
	}, []);

	const handleAtBottomChange = useCallback((isAtBottom: boolean) => {
		const session = selectActiveSession(useSessionStore.getState());
		if (!session) return;
		if (session.inputMode === 'ai') {
			const currentActiveTab = getActiveTab(session);
			if (!currentActiveTab) return;
			updateAiTab(session.id, currentActiveTab.id, (tab) => ({
				...tab,
				isAtBottom,
				hasUnread: isAtBottom ? false : tab.hasUnread,
			}));
		}
	}, []);

	// ========================================================================
	// File Tab Navigation
	// ========================================================================

	const handleClearFilePreviewHistory = useCallback(() => {
		const currentSession = selectActiveSession(useSessionStore.getState());
		if (!currentSession) return;
		useSessionStore
			.getState()
			.updateSession(currentSession.id, { filePreviewHistory: [], filePreviewHistoryIndex: -1 });
	}, []);

	const handleFileTabNavigateBack = useCallback(async () => {
		const { setSessions } = useSessionStore.getState();
		const currentSession = selectActiveSession(useSessionStore.getState());
		if (!currentSession?.activeFileTabId) return;

		const currentTab = currentSession.filePreviewTabs.find(
			(tab) => tab.id === currentSession.activeFileTabId
		);
		if (!currentTab) return;

		const history = currentTab.navigationHistory ?? [];
		const currentIndex = currentTab.navigationIndex ?? history.length - 1;

		if (currentIndex > 0) {
			const newIndex = currentIndex - 1;
			const historyEntry = history[newIndex];

			try {
				const sshRemoteId = currentTab.sshRemoteId;
				const content = await window.maestro.fs.readFile(historyEntry.path, sshRemoteId);
				if (!content) return;

				setSessions((prev: Session[]) =>
					prev.map((s) => {
						if (s.id !== currentSession.id) return s;
						return {
							...s,
							filePreviewTabs: s.filePreviewTabs.map((tab) =>
								tab.id === currentTab.id
									? {
											...tab,
											path: historyEntry.path,
											name: historyEntry.name,
											content,
											scrollTop: historyEntry.scrollTop ?? 0,
											navigationIndex: newIndex,
										}
									: tab
							),
						};
					})
				);
			} catch (error) {
				logger.error('Failed to navigate back:', undefined, error);
			}
		}
	}, []);

	const handleFileTabNavigateForward = useCallback(async () => {
		const { setSessions } = useSessionStore.getState();
		const currentSession = selectActiveSession(useSessionStore.getState());
		if (!currentSession?.activeFileTabId) return;

		const currentTab = currentSession.filePreviewTabs.find(
			(tab) => tab.id === currentSession.activeFileTabId
		);
		if (!currentTab) return;

		const history = currentTab.navigationHistory ?? [];
		const currentIndex = currentTab.navigationIndex ?? history.length - 1;

		if (currentIndex < history.length - 1) {
			const newIndex = currentIndex + 1;
			const historyEntry = history[newIndex];

			try {
				const sshRemoteId = currentTab.sshRemoteId;
				const content = await window.maestro.fs.readFile(historyEntry.path, sshRemoteId);
				if (!content) return;

				setSessions((prev: Session[]) =>
					prev.map((s) => {
						if (s.id !== currentSession.id) return s;
						return {
							...s,
							filePreviewTabs: s.filePreviewTabs.map((tab) =>
								tab.id === currentTab.id
									? {
											...tab,
											path: historyEntry.path,
											name: historyEntry.name,
											content,
											scrollTop: historyEntry.scrollTop ?? 0,
											navigationIndex: newIndex,
										}
									: tab
							),
						};
					})
				);
			} catch (error) {
				logger.error('Failed to navigate forward:', undefined, error);
			}
		}
	}, []);

	const handleFileTabNavigateToIndex = useCallback(async (index: number) => {
		const { setSessions } = useSessionStore.getState();
		const currentSession = selectActiveSession(useSessionStore.getState());
		if (!currentSession?.activeFileTabId) return;

		const currentTab = currentSession.filePreviewTabs.find(
			(tab) => tab.id === currentSession.activeFileTabId
		);
		if (!currentTab) return;

		const history = currentTab.navigationHistory ?? [];

		if (index >= 0 && index < history.length) {
			const historyEntry = history[index];

			try {
				const sshRemoteId = currentTab.sshRemoteId;
				const content = await window.maestro.fs.readFile(historyEntry.path, sshRemoteId);
				if (!content) return;

				setSessions((prev: Session[]) =>
					prev.map((s) => {
						if (s.id !== currentSession.id) return s;
						return {
							...s,
							filePreviewTabs: s.filePreviewTabs.map((tab) =>
								tab.id === currentTab.id
									? {
											...tab,
											path: historyEntry.path,
											name: historyEntry.name,
											content,
											scrollTop: historyEntry.scrollTop ?? 0,
											navigationIndex: index,
										}
									: tab
							),
						};
					})
				);
			} catch (error) {
				logger.error('Failed to navigate to index:', undefined, error);
			}
		}
	}, []);

	// ========================================================================
	// Return
	// ========================================================================

	return {
		// Derived state
		activeTab,
		unifiedTabs,
		activeFileTab,
		activeBrowserTab,
		isResumingSession,
		fileTabBackHistory,
		fileTabForwardHistory,
		fileTabCanGoBack,
		fileTabCanGoForward,
		activeFileTabNavIndex,

		// Internal helpers (needed by keyboard handler)
		performTabClose,

		// AI Tab handlers
		handleNewAgentSession,
		handleTabSelect,
		handleTabClose,
		handleNewTab,
		handleTabReorder,
		handleUnifiedTabReorder,
		handleCloseAllTabs,
		handleCloseOtherTabs,
		handleCloseTabsLeft,
		handleCloseTabsRight,
		handleCloseCurrentTab,
		handleRequestTabRename,
		handleUpdateTabByClaudeSessionId,
		handleTabStar,
		handleTabMarkUnread,
		handleToggleTabReadOnlyMode,
		handleToggleTabSaveToHistory,
		handleToggleTabShowThinking,

		// File Tab handlers
		handleOpenFileTab,
		handleSelectFileTab,
		handleCloseFileTab,
		handleFileTabEditModeChange,
		handleFileTabEditContentChange,
		handleFileTabScrollPositionChange,
		handleFileTabSearchQueryChange,
		handleReloadFileTab,
		handleFileTabNavigateBack,
		handleFileTabNavigateForward,
		handleFileTabNavigateToIndex,
		handleClearFilePreviewHistory,
		handleNewFileTab,

		// Browser Tab handlers
		handleNewBrowserTab,
		handleSelectBrowserTab,
		handleCloseBrowserTab,
		handleUpdateBrowserTab,

		// Scroll/log handlers
		handleScrollPositionChange,
		handleAtBottomChange,
		handleDeleteLog,
	};
}

// ============================================================================
// Terminal Tab Handlers
// ============================================================================

export interface TerminalTabHandlersReturn {
	handleOpenTerminalTab: (options?: { shell?: string; cwd?: string; name?: string | null }) => void;
	handleCloseTerminalTab: (tabId: string) => void;
	handleSelectTerminalTab: (tabId: string) => void;
	handleRenameTerminalTab: (tabId: string, name: string) => void;
}

/**
 * Thin wrapper hook exposing terminal tab operations via the tabStore.
 * Components call this hook to manipulate terminal tabs without directly
 * importing the store.
 */
export function useTerminalTabHandlers(): TerminalTabHandlersReturn {
	const { createTerminalTab, closeTerminalTab, selectTerminalTab, renameTerminalTab } =
		useTabStore();

	const handleOpenTerminalTab = useCallback(
		(options?: { shell?: string; cwd?: string; name?: string | null }) => {
			createTerminalTab(options);
		},
		[createTerminalTab]
	);

	const handleCloseTerminalTab = useCallback(
		(tabId: string) => {
			closeTerminalTab(tabId);
		},
		[closeTerminalTab]
	);

	const handleSelectTerminalTab = useCallback(
		(tabId: string) => {
			selectTerminalTab(tabId);
		},
		[selectTerminalTab]
	);

	const handleRenameTerminalTab = useCallback(
		(tabId: string, name: string) => {
			renameTerminalTab(tabId, name);
		},
		[renameTerminalTab]
	);

	return {
		handleOpenTerminalTab,
		handleCloseTerminalTab,
		handleSelectTerminalTab,
		handleRenameTerminalTab,
	};
}
