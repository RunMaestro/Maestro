import { useMemo, useCallback } from 'react';
import type {
	Session,
	AITab,
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
	closeFileTab as closeFileTabHelper,
	addAiTabToUnifiedHistory,
	getActiveTab,
	getInitialRenameValue,
	hasActiveWizard,
} from '../../utils/tabHelpers';
import { generateId } from '../../utils/ids';
import { useSessionStore, selectActiveSession } from '../../stores/sessionStore';
import { useModalStore } from '../../stores/modalStore';
import { useSettingsStore } from '../../stores/settingsStore';

// ============================================================================
// Types
// ============================================================================

export interface CloseCurrentTabResult {
	type: 'file' | 'ai' | 'prevented' | 'none';
	tabId?: string;
	isWizardTab?: boolean;
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
	handleOpenFileTab: (file: FileTabOpenParams, options?: { openInNewTab?: boolean }) => void;
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
	const unifiedTabs = useMemo((): UnifiedTab[] => {
		if (!activeSession) return [];

		const { aiTabs, filePreviewTabs, unifiedTabOrder } = activeSession;
		const aiTabMap = new Map(aiTabs.map((tab) => [tab.id, tab]));
		const fileTabMap = new Map(filePreviewTabs.map((tab) => [tab.id, tab]));

		return unifiedTabOrder
			.map((ref): UnifiedTab | null => {
				if (ref.type === 'ai') {
					const tab = aiTabMap.get(ref.id);
					return tab ? { type: 'ai', id: ref.id, data: tab } : null;
				} else {
					const tab = fileTabMap.get(ref.id);
					return tab ? { type: 'file', id: ref.id, data: tab } : null;
				}
			})
			.filter((tab): tab is UnifiedTab => tab !== null);
	}, [activeSession?.aiTabs, activeSession?.filePreviewTabs, activeSession?.unifiedTabOrder]);

	// Get the active file preview tab (if a file tab is active)
	const activeFileTab = useMemo((): FilePreviewTab | null => {
		if (!activeSession?.activeFileTabId) return null;
		return (
			activeSession.filePreviewTabs.find((tab) => tab.id === activeSession.activeFileTabId) ?? null
		);
	}, [activeSession?.activeFileTabId, activeSession?.filePreviewTabs]);

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
			}
		) => {
			const openInNewTab = options?.openInNewTab ?? true;
			const { setSessions } = useSessionStore.getState();
			const activeSessionId = useSessionStore.getState().activeSessionId;

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
							activeTabId: s.activeTabId,
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
			const { sessions, activeSessionId } = useSessionStore.getState();
			const currentSession = sessions.find((s) => s.id === activeSessionId);
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
		const { sessions, activeSessionId } = useSessionStore.getState();
		const currentSession = sessions.find((s) => s.id === activeSessionId);
		if (!currentSession) return;

		const fileTab = currentSession.filePreviewTabs.find((tab) => tab.id === tabId);
		if (!fileTab) return;

		try {
			const [content, stat] = await Promise.all([
				window.maestro.fs.readFile(fileTab.path, fileTab.sshRemoteId),
				window.maestro.fs.stat(fileTab.path, fileTab.sshRemoteId),
			]);
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
			console.debug('[handleReloadFileTab] Failed to reload:', error);
		}
	}, []);

	/**
	 * Select a file preview tab. If fileTabAutoRefreshEnabled, checks if file changed on disk.
	 */
	const handleSelectFileTab = useCallback(async (tabId: string) => {
		const { sessions, activeSessionId, setSessions } = useSessionStore.getState();
		const currentSession = sessions.find((s) => s.id === activeSessionId);
		if (!currentSession) return;

		const fileTab = currentSession.filePreviewTabs.find((tab) => tab.id === tabId);
		if (!fileTab) return;

		// Set the tab as active immediately
		setSessions((prev: Session[]) =>
			prev.map((s) => {
				if (s.id !== activeSessionId) return s;
				return { ...s, activeFileTabId: tabId };
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
				console.debug('[handleSelectFileTab] Auto-refresh failed:', error);
			}
		}
	}, []);

	const handleUnifiedTabReorder = useCallback((fromIndex: number, toIndex: number) => {
		const { setSessions, activeSessionId } = useSessionStore.getState();
		setSessions((prev: Session[]) =>
			prev.map((s) => {
				if (s.id !== activeSessionId) return s;
				if (
					fromIndex < 0 ||
					fromIndex >= s.unifiedTabOrder.length ||
					toIndex < 0 ||
					toIndex >= s.unifiedTabOrder.length ||
					fromIndex === toIndex
				) {
					return s;
				}
				const newOrder = [...s.unifiedTabOrder];
				const [movedRef] = newOrder.splice(fromIndex, 1);
				newOrder.splice(toIndex, 0, movedRef);
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
			const { sessions, activeSessionId } = useSessionStore.getState();
			const session = sessions.find((s) => s.id === activeSessionId);
			const tab = session?.aiTabs.find((t) => t.id === tabId);

			if (tab && hasActiveWizard(tab)) {
				useModalStore.getState().openModal('confirm', {
					message: 'Close this wizard? Your progress will be lost and cannot be restored.',
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

	const handleCloseAllTabs = useCallback(() => {
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

	const handleCloseOtherTabs = useCallback(() => {
		const { setSessions, activeSessionId } = useSessionStore.getState();
		setSessions((prev: Session[]) =>
			prev.map((s) => {
				if (s.id !== activeSessionId) return s;

				const activeUnifiedId = s.activeFileTabId ?? s.activeTabId;
				const activeUnifiedType = s.activeFileTabId ? 'file' : 'ai';

				const tabsToClose = s.unifiedTabOrder.filter(
					(ref) => !(ref.type === activeUnifiedType && ref.id === activeUnifiedId)
				);

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
	}, []);

	const handleCloseTabsLeft = useCallback(() => {
		const { setSessions, activeSessionId } = useSessionStore.getState();
		setSessions((prev: Session[]) =>
			prev.map((s) => {
				if (s.id !== activeSessionId) return s;

				const activeUnifiedId = s.activeFileTabId ?? s.activeTabId;
				const activeUnifiedType = s.activeFileTabId ? 'file' : 'ai';

				const activeIndex = s.unifiedTabOrder.findIndex(
					(ref) => ref.type === activeUnifiedType && ref.id === activeUnifiedId
				);
				if (activeIndex <= 0) return s;

				const tabsToClose = s.unifiedTabOrder.slice(0, activeIndex);

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
	}, []);

	const handleCloseTabsRight = useCallback(() => {
		const { setSessions, activeSessionId } = useSessionStore.getState();
		setSessions((prev: Session[]) =>
			prev.map((s) => {
				if (s.id !== activeSessionId) return s;

				const activeUnifiedId = s.activeFileTabId ?? s.activeTabId;
				const activeUnifiedType = s.activeFileTabId ? 'file' : 'ai';

				const activeIndex = s.unifiedTabOrder.findIndex(
					(ref) => ref.type === activeUnifiedType && ref.id === activeUnifiedId
				);
				if (activeIndex < 0 || activeIndex >= s.unifiedTabOrder.length - 1) return s;

				const tabsToClose = s.unifiedTabOrder.slice(activeIndex + 1);

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
	}, []);

	const handleCloseCurrentTab = useCallback((): CloseCurrentTabResult => {
		const { sessions, activeSessionId, setSessions } = useSessionStore.getState();
		const session = sessions.find((s) => s.id === activeSessionId);
		if (!session) return { type: 'none' };

		// Check if a file tab is active first
		if (session.activeFileTabId) {
			const tabId = session.activeFileTabId;
			setSessions((prev: Session[]) =>
				prev.map((s) => {
					if (s.id !== activeSessionId) return s;
					const result = closeFileTabHelper(s, tabId);
					if (!result) return s;
					return result.session;
				})
			);
			return { type: 'file', tabId };
		}

		// AI tab is active
		if (session.activeTabId) {
			if (session.aiTabs.length <= 1) {
				return { type: 'prevented' };
			}

			const tabId = session.activeTabId;
			const tab = session.aiTabs.find((t) => t.id === tabId);
			const isWizardTab = tab ? hasActiveWizard(tab) : false;

			return { type: 'ai', tabId, isWizardTab };
		}

		return { type: 'none' };
	}, []);

	// ========================================================================
	// Log Deletion
	// ========================================================================

	const handleDeleteLog = useCallback((logId: string): number | null => {
		const { sessions, activeSessionId, setSessions } = useSessionStore.getState();
		const currentSession = sessions.find((s) => s.id === activeSessionId);
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
							console.warn('[handleDeleteLog] Failed to delete from Claude session:', result.error);
						}
					})
					.catch((err) => {
						console.error('[handleDeleteLog] Error deleting from Claude session:', err);
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
		const { sessions, activeSessionId, setSessions } = useSessionStore.getState();
		const session = sessions.find((s) => s.id === activeSessionId);
		if (!session) return;
		const tab = session.aiTabs?.find((t) => t.id === tabId);
		if (tab) {
			if (tab.isGeneratingName) {
				setSessions((prev: Session[]) =>
					prev.map((s) => {
						if (s.id !== activeSessionId) return s;
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
		const { sessions, activeSessionId, setSessions } = useSessionStore.getState();
		const session = sessions.find((s) => s.id === activeSessionId);
		if (!session) return;
		const tabToStar = session.aiTabs.find((t) => t.id === tabId);
		if (!tabToStar?.agentSessionId) return;

		setSessions((prev: Session[]) =>
			prev.map((s) => {
				if (s.id !== activeSessionId) return s;
				const tab = s.aiTabs.find((t) => t.id === tabId);
				if (tab?.agentSessionId) {
					const agentId = s.toolType || 'claude-code';
					if (agentId === 'claude-code') {
						window.maestro.claude
							.updateSessionStarred(s.projectRoot, tab.agentSessionId, starred)
							.catch((err) => console.error('Failed to persist tab starred:', err));
					} else {
						window.maestro.agentSessions
							.setSessionStarred(agentId, s.projectRoot, tab.agentSessionId, starred)
							.catch((err) => console.error('Failed to persist tab starred:', err));
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
		const { sessions, activeSessionId, setSessions } = useSessionStore.getState();
		const session = sessions.find((s) => s.id === activeSessionId);
		if (!session) return;
		const currentActiveTab = getActiveTab(session);
		if (!currentActiveTab) return;
		setSessions((prev: Session[]) =>
			prev.map((s) => {
				if (s.id !== activeSessionId) return s;
				return {
					...s,
					aiTabs: s.aiTabs.map((tab) =>
						tab.id === currentActiveTab.id ? { ...tab, readOnlyMode: !tab.readOnlyMode } : tab
					),
				};
			})
		);
	}, []);

	const handleToggleTabSaveToHistory = useCallback(() => {
		const { sessions, activeSessionId, setSessions } = useSessionStore.getState();
		const session = sessions.find((s) => s.id === activeSessionId);
		if (!session) return;
		const currentActiveTab = getActiveTab(session);
		if (!currentActiveTab) return;
		setSessions((prev: Session[]) =>
			prev.map((s) => {
				if (s.id !== activeSessionId) return s;
				return {
					...s,
					aiTabs: s.aiTabs.map((tab) =>
						tab.id === currentActiveTab.id ? { ...tab, saveToHistory: !tab.saveToHistory } : tab
					),
				};
			})
		);
	}, []);

	const handleToggleTabShowThinking = useCallback(() => {
		const { sessions, activeSessionId, setSessions } = useSessionStore.getState();
		const session = sessions.find((s) => s.id === activeSessionId);
		if (!session) return;
		const currentActiveTab = getActiveTab(session);
		if (!currentActiveTab) return;

		const cycleThinkingMode = (current: ThinkingMode | undefined): ThinkingMode => {
			if (!current || current === 'off') return 'on';
			if (current === 'on') return 'sticky';
			return 'off';
		};

		setSessions((prev: Session[]) =>
			prev.map((s) => {
				if (s.id !== activeSessionId) return s;
				return {
					...s,
					aiTabs: s.aiTabs.map((tab) => {
						if (tab.id !== currentActiveTab.id) return tab;
						const newMode = cycleThinkingMode(tab.showThinking);
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
	}, []);

	// ========================================================================
	// Scroll State
	// ========================================================================

	const handleScrollPositionChange = useCallback((scrollTop: number) => {
		const { sessions, activeSessionId, setSessions } = useSessionStore.getState();
		const session = sessions.find((s) => s.id === activeSessionId);
		if (!session) return;
		if (session.inputMode === 'ai') {
			const currentActiveTab = getActiveTab(session);
			if (!currentActiveTab) return;
			setSessions((prev: Session[]) =>
				prev.map((s) => {
					if (s.id !== activeSessionId) return s;
					return {
						...s,
						aiTabs: s.aiTabs.map((tab) =>
							tab.id === currentActiveTab.id ? { ...tab, scrollTop } : tab
						),
					};
				})
			);
		} else {
			setSessions((prev: Session[]) =>
				prev.map((s) => (s.id === activeSessionId ? { ...s, terminalScrollTop: scrollTop } : s))
			);
		}
	}, []);

	const handleAtBottomChange = useCallback((isAtBottom: boolean) => {
		const { sessions, activeSessionId, setSessions } = useSessionStore.getState();
		const session = sessions.find((s) => s.id === activeSessionId);
		if (!session) return;
		if (session.inputMode === 'ai') {
			const currentActiveTab = getActiveTab(session);
			if (!currentActiveTab) return;
			setSessions((prev: Session[]) =>
				prev.map((s) => {
					if (s.id !== activeSessionId) return s;
					return {
						...s,
						aiTabs: s.aiTabs.map((tab) =>
							tab.id === currentActiveTab.id
								? {
										...tab,
										isAtBottom,
										hasUnread: isAtBottom ? false : tab.hasUnread,
									}
								: tab
						),
					};
				})
			);
		}
	}, []);

	// ========================================================================
	// File Tab Navigation
	// ========================================================================

	const handleClearFilePreviewHistory = useCallback(() => {
		const { sessions, activeSessionId, setSessions } = useSessionStore.getState();
		const currentSession = sessions.find((s) => s.id === activeSessionId);
		if (!currentSession) return;
		setSessions((prev: Session[]) =>
			prev.map((s) =>
				s.id === currentSession.id
					? { ...s, filePreviewHistory: [], filePreviewHistoryIndex: -1 }
					: s
			)
		);
	}, []);

	const handleFileTabNavigateBack = useCallback(async () => {
		const { sessions, activeSessionId, setSessions } = useSessionStore.getState();
		const currentSession = sessions.find((s) => s.id === activeSessionId);
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
				console.error('Failed to navigate back:', error);
			}
		}
	}, []);

	const handleFileTabNavigateForward = useCallback(async () => {
		const { sessions, activeSessionId, setSessions } = useSessionStore.getState();
		const currentSession = sessions.find((s) => s.id === activeSessionId);
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
				console.error('Failed to navigate forward:', error);
			}
		}
	}, []);

	const handleFileTabNavigateToIndex = useCallback(async (index: number) => {
		const { sessions, activeSessionId, setSessions } = useSessionStore.getState();
		const currentSession = sessions.find((s) => s.id === activeSessionId);
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
				console.error('Failed to navigate to index:', error);
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

		// Scroll/log handlers
		handleScrollPositionChange,
		handleAtBottomChange,
		handleDeleteLog,
	};
}
