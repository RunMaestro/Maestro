import { useCallback } from 'react';
import { selectActiveSession, useSessionStore } from '../../../stores/sessionStore';
import type { FilePreviewTab, Session, UnifiedTabRef } from '../../../types';
import {
	closeFileTab as closeFileTabHelper,
	ensureInUnifiedTabOrder,
} from '../../../utils/tabHelpers';
import { generateId } from '../../../utils/ids';
import { insertAfterActiveInUnifiedTabOrder } from '../../../utils/unifiedTabOrderUtils';
import { logger } from '../../../utils/logger';
import { useModalStore } from '../../../stores/modalStore';
import { useSettingsStore } from '../../../stores/settingsStore';
import { buildReplacementNavigationHistory, getFileNameParts } from './filePreviewTabHelpers';
import type { FilePreviewTabHandlersReturn, FileTabOpenParams } from './types';

export function useFilePreviewTabHandlers(): FilePreviewTabHandlersReturn {
	const handleOpenFileTab = useCallback(
		(
			file: FileTabOpenParams,
			options?: {
				openInNewTab?: boolean;
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

					const existingTab = s.filePreviewTabs.find((tab) => tab.path === file.path);
					if (existingTab) {
						const updatedTabs = s.filePreviewTabs.map((tab) =>
							tab.id === existingTab.id
								? {
										...tab,
										content: file.content,
										lastModified: file.lastModified ?? tab.lastModified,
										isLoading: file.isLoading ?? false,
										loadRequestId: file.isLoading ? file.loadRequestId : undefined,
										pendingScrollToLine:
											file.pendingScrollToLine !== undefined
												? file.pendingScrollToLine
												: tab.pendingScrollToLine,
									}
								: tab
						);
						return {
							...s,
							filePreviewTabs: updatedTabs,
							activeFileTabId: existingTab.id,
							activeBrowserTabId: null,
							activeTerminalTabId: null,
							inputMode: 'ai' as const,
							activeTabId: s.activeTabId,
							unifiedTabOrder: ensureInUnifiedTabOrder(s.unifiedTabOrder, 'file', existingTab.id),
						};
					}

					if (!openInNewTab && s.activeFileTabId) {
						const currentTabId = s.activeFileTabId;
						const currentTab = s.filePreviewTabs.find((tab) => tab.id === currentTabId);
						const { extension, nameWithoutExtension } = getFileNameParts(file.name);

						const updatedTabs = s.filePreviewTabs.map((tab) => {
							if (tab.id !== currentTabId) return tab;

							const finalHistory = buildReplacementNavigationHistory(
								tab,
								currentTab,
								file,
								nameWithoutExtension
							);

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
								isLoading: file.isLoading ?? false,
								loadRequestId: file.isLoading ? file.loadRequestId : undefined,
								navigationHistory: finalHistory,
								navigationIndex: finalHistory.length - 1,
								pendingScrollToLine: file.pendingScrollToLine,
							};
						});
						return {
							...s,
							filePreviewTabs: updatedTabs,
							activeBrowserTabId: null,
							activeTerminalTabId: null,
							inputMode: 'ai' as const,
						};
					}

					const newTabId = generateId();
					const { extension, nameWithoutExtension } = getFileNameParts(file.name);
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
						isLoading: file.isLoading ?? false,
						loadRequestId: file.isLoading ? file.loadRequestId : undefined,
						navigationHistory: [{ path: file.path, name: nameWithoutExtension, scrollTop: 0 }],
						navigationIndex: 0,
						pendingScrollToLine: file.pendingScrollToLine,
					};

					const newTabRef: UnifiedTabRef = { type: 'file', id: newTabId };
					const updatedUnifiedTabOrder = insertAfterActiveInUnifiedTabOrder(s, newTabRef);

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
		},
		[]
	);

	const forceCloseFileTab = useCallback((tabId: string) => {
		const { setSessions, activeSessionId } = useSessionStore.getState();
		const activeSession = useSessionStore
			.getState()
			.sessions.find((s: Session) => s.id === activeSessionId);
		const closingTab = activeSession?.filePreviewTabs.find((t) => t.id === tabId);
		if (closingTab?.isLoading && closingTab.loadRequestId) {
			void window.maestro.fs.cancelReadFile(closingTab.loadRequestId);
		}

		setSessions((prev: Session[]) =>
			prev.map((s) => {
				if (s.id !== activeSessionId) return s;
				const result = closeFileTabHelper(s, tabId);
				if (!result) return s;
				return result.session;
			})
		);
	}, []);

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

	const handleSelectFileTab = useCallback(async (tabId: string) => {
		const { setSessions } = useSessionStore.getState();
		const currentSession = selectActiveSession(useSessionStore.getState());
		if (!currentSession) return;

		const fileTab = currentSession.filePreviewTabs.find((tab) => tab.id === tabId);
		if (!fileTab) return;

		setSessions((prev: Session[]) =>
			prev.map((s) => {
				if (s.id !== currentSession.id) return s;
				return {
					...s,
					activeFileTabId: tabId,
					activeBrowserTabId: null,
					activeTerminalTabId: null,
					inputMode: 'ai',
					// Selecting a standalone file tab leaves any active tiled group.
					activeGroupId: null,
				};
			})
		);

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
				const updatedUnifiedTabOrder = insertAfterActiveInUnifiedTabOrder(s, newTabRef);

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
				if (content === null) return;

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
				if (content === null) return;

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
				if (content === null) return;

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

	return {
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
	};
}
