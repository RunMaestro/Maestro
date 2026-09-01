import { useCallback } from 'react';
import {
	selectActiveSession,
	updateFileTab,
	updateSessionWith,
	useSessionStore,
} from '../../../stores/sessionStore';
import type { FilePreviewTab, Session, UnifiedTabRef } from '../../../types';
import {
	closeFileTab as closeFileTabHelper,
	ensureInUnifiedTabOrder,
	findGroupPaneForTab,
} from '../../../utils/tabHelpers';
import { fileTabFocusFields } from '../../../utils/tabFocusFields';
import { generateId } from '../../../utils/ids';
import { insertAfterActiveInUnifiedTabOrder } from '../../../utils/unifiedTabOrderUtils';
import { logger } from '../../../utils/logger';
import { useModalStore } from '../../../stores/modalStore';
import { useSettingsStore } from '../../../stores/settingsStore';
import { useMediaPlaybackStore } from '../../../stores/mediaPlaybackStore';
import { useUIStore } from '../../../stores/uiStore';
import { getOpenedMediaKind } from '../../../utils/mediaItems';
import {
	buildReplacementNavigationHistory,
	createUntitledFileTab,
	getFileNameParts,
} from './filePreviewTabHelpers';
import type { FilePreviewTabHandlersReturn, FileTabOpenParams, MediaOpenMode } from './types';

export function useFilePreviewTabHandlers(): FilePreviewTabHandlersReturn {
	const handleOpenFileTab = useCallback(
		(
			file: FileTabOpenParams,
			options?: {
				openInNewTab?: boolean;
				targetSessionId?: string;
				mediaMode?: MediaOpenMode;
				/**
				 * When false the tab is created but NOT shown: every active-* id and
				 * inputMode are left as they were. Background placement for remote
				 * (CLI / web) opens - see shared/focusPlacement.ts. Default true.
				 */
				activate?: boolean;
			}
		) => {
			const openInNewTab = options?.openInNewTab ?? true;
			const activate = options?.activate !== false;
			const activeSessionId =
				options?.targetSessionId || useSessionStore.getState().activeSessionId;

			// Media never becomes a tab. Audio and video go straight to the floating
			// player, which is the only surface they ever appear on: no entry in the
			// tab bar, no main panel takeover, so a podcast does not cost the user
			// their workspace. This is the single choke point every open path funnels
			// through, which is why the diversion belongs here rather than in each
			// caller. Non-playable media (a remote file, which has no local stream)
			// falls through to the normal binary preview.
			const mediaKind = getOpenedMediaKind(file.name, file.content);
			if (mediaKind) {
				const session = useSessionStore
					.getState()
					.sessions.find((s: Session) => s.id === activeSessionId);
				if (session) {
					const request = {
						path: file.path,
						name: file.name,
						kind: mediaKind,
						sessionId: session.id,
						sessionName: session.name,
					};
					const store = useMediaPlaybackStore.getState();
					// Queue mode is how a multi-file open stays sane: the first file
					// plays and the rest line up behind it, instead of ten opens each
					// stealing the player from the one before.
					if (options?.mediaMode === 'queue') {
						store.enqueueMedia([request]);
					} else {
						store.openMedia(request);
					}
					return;
				}
			}

			updateSessionWith(activeSessionId, (s) => {
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
									// Re-opening the file already in this tab: leave playback
									// alone rather than restarting something mid-listen.
								}
							: tab
					);
					// The file may already be open but tiled INSIDE a group (it lives only as
					// a leaf in tabGroups[].layout, with no standalone chip). In that case,
					// re-opening it must activate its group and focus that pane - not clear
					// activeGroupId and set activeFileTabId, which would strand focus because
					// buildUnifiedTabs excludes group members from the standalone strip.
					// Mirrors the group branch in setActiveTab for AI tabs.
					const groupPane = findGroupPaneForTab(s, 'file', existingTab.id);
					if (groupPane) {
						return {
							...s,
							filePreviewTabs: updatedTabs,
							tabGroups: s.tabGroups.map((g) =>
								g.id === groupPane.groupId ? { ...g, focusedPaneId: groupPane.leafId } : g
							),
							activeGroupId: groupPane.groupId,
							activeFileTabId: existingTab.id,
							activeBrowserTabId: null,
							activeTerminalTabId: null,
							inputMode: 'ai' as const,
							activeTabId: s.activeTabId,
						};
					}
					return {
						...s,
						filePreviewTabs: updatedTabs,
						// A background re-open refreshes the tab's content in place and
						// leaves the view alone; only an activating open brings it forward.
						...(activate ? fileTabFocusFields(existingTab.id) : {}),
						activeTabId: s.activeTabId,
						// Opening a standalone file takes over the panel, so leave any active
						// tiled group.
						activeGroupId: null,
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
						// This branch rewrites the file tab that is ALREADY active, so
						// activation only has to clear the surfaces that outrank it.
						...(activate ? fileTabFocusFields(currentTabId) : {}),
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
					...(activate ? fileTabFocusFields(newTabId) : {}),
				};
			});
		},
		[]
	);

	const forceCloseFileTab = useCallback((tabId: string) => {
		const { activeSessionId } = useSessionStore.getState();
		const activeSession = useSessionStore
			.getState()
			.sessions.find((s: Session) => s.id === activeSessionId);
		const closingTab = activeSession?.filePreviewTabs.find((t) => t.id === tabId);
		if (closingTab?.isLoading && closingTab.loadRequestId) {
			void window.maestro.fs.cancelReadFile(closingTab.loadRequestId);
		}

		updateSessionWith(activeSessionId, (s) => {
			const result = closeFileTabHelper(s, tabId);
			return result ? result.session : s;
		});
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
		const { activeSessionId } = useSessionStore.getState();
		updateFileTab(activeSessionId, tabId, (tab) => ({ ...tab, editMode }));
	}, []);

	const handleFileTabEditContentChange = useCallback(
		(tabId: string, editContent: string | undefined, savedContent?: string) => {
			const { activeSessionId } = useSessionStore.getState();
			updateFileTab(activeSessionId, tabId, (tab) =>
				savedContent !== undefined
					? { ...tab, editContent, content: savedContent }
					: { ...tab, editContent }
			);
		},
		[]
	);

	const handleFileTabScrollPositionChange = useCallback((tabId: string, scrollTop: number) => {
		const { activeSessionId } = useSessionStore.getState();
		updateFileTab(activeSessionId, tabId, (tab) => {
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
	}, []);

	const handleFileTabSearchQueryChange = useCallback((tabId: string, searchQuery: string) => {
		const { activeSessionId } = useSessionStore.getState();
		updateFileTab(activeSessionId, tabId, (tab) => ({ ...tab, searchQuery }));
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

			updateFileTab(useSessionStore.getState().activeSessionId, tabId, (tab) => ({
				...tab,
				content,
				lastModified: newMtime,
				editContent: undefined,
			}));
		} catch (error) {
			logger.debug('[handleReloadFileTab] Failed to reload:', undefined, error);
		}
	}, []);

	const handleSelectFileTab = useCallback(async (tabId: string) => {
		const currentSession = selectActiveSession(useSessionStore.getState());
		if (!currentSession) return;

		const fileTab = currentSession.filePreviewTabs.find((tab) => tab.id === tabId);
		if (!fileTab) return;

		updateSessionWith(currentSession.id, (s) => ({
			...s,
			activeFileTabId: tabId,
			activeBrowserTabId: null,
			activeTerminalTabId: null,
			inputMode: 'ai',
			// Selecting a standalone file tab leaves any active tiled group.
			activeGroupId: null,
		}));

		const { fileTabAutoRefreshEnabled } = useSettingsStore.getState();
		if (fileTabAutoRefreshEnabled && !fileTab.editContent) {
			try {
				const stat = await window.maestro.fs.stat(fileTab.path, fileTab.sshRemoteId);
				if (!stat || !stat.modifiedAt) return;

				const currentMtime = new Date(stat.modifiedAt).getTime();

				if (currentMtime > fileTab.lastModified) {
					const content = await window.maestro.fs.readFile(fileTab.path, fileTab.sshRemoteId);
					if (content === null) return;
					updateFileTab(useSessionStore.getState().activeSessionId, tabId, (tab) => ({
						...tab,
						content,
						lastModified: currentMtime,
					}));
				}
			} catch (error) {
				logger.debug('[handleSelectFileTab] Auto-refresh failed:', undefined, error);
			}
		}
	}, []);

	const handleNewFileTab = useCallback(() => {
		const { activeSessionId } = useSessionStore.getState();
		// Captured inside the updater so focus is only requested for a tab that was
		// actually created (no active session leaves every entry untouched).
		let createdTabId: string | null = null;
		updateSessionWith(activeSessionId, (s) => {
			const newFileTab = createUntitledFileTab();
			const newTabId = newFileTab.id;
			createdTabId = newTabId;

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
				// A newly-created untitled file tab takes over the panel, so it must
				// leave any active tiled group (mirrors handleSelectFileTab).
				activeGroupId: null,
			};
		});
		// A blank file exists to be typed into, so put the caret in the editor rather
		// than leaving it wherever it was. The request retries until CodeMirror (a
		// lazy import) has mounted.
		if (createdTabId) {
			useUIStore.getState().requestTabFocus({ type: 'file', id: createdTabId });
		}
	}, []);

	const handleClearFilePreviewHistory = useCallback(() => {
		const currentSession = selectActiveSession(useSessionStore.getState());
		if (!currentSession) return;
		useSessionStore
			.getState()
			.updateSession(currentSession.id, { filePreviewHistory: [], filePreviewHistoryIndex: -1 });
	}, []);

	/**
	 * Move one file tab to a position in its own visit history, loading that entry's
	 * file. Back / forward / breadcrumb-click were three byte-identical copies of this
	 * body differing only in how they picked the index, so they now all land here.
	 *
	 * `tabId` addresses the tab explicitly. It defaults to the active file tab (the
	 * single view), but a TILED file pane must pass its own id: focusing a file pane
	 * does not set `activeFileTabId`, so the default would navigate a different file.
	 */
	const handleFileTabNavigateToIndex = useCallback(async (index: number, tabId?: string) => {
		const currentSession = selectActiveSession(useSessionStore.getState());
		const targetTabId = tabId ?? currentSession?.activeFileTabId;
		if (!currentSession || !targetTabId) return;

		const currentTab = currentSession.filePreviewTabs.find((tab) => tab.id === targetTabId);
		if (!currentTab) return;

		const history = currentTab.navigationHistory ?? [];
		if (index < 0 || index >= history.length) return;
		const historyEntry = history[index];

		try {
			const content = await window.maestro.fs.readFile(historyEntry.path, currentTab.sshRemoteId);
			if (content === null) return;

			updateFileTab(currentSession.id, currentTab.id, (tab) => ({
				...tab,
				path: historyEntry.path,
				name: historyEntry.name,
				content,
				scrollTop: historyEntry.scrollTop ?? 0,
				navigationIndex: index,
			}));
		} catch (error) {
			logger.error('Failed to navigate file tab history:', undefined, error);
		}
	}, []);

	/** Current position in a file tab's history, or -1 when it has none. */
	const currentNavIndex = (tabId?: string): number => {
		const currentSession = selectActiveSession(useSessionStore.getState());
		const targetTabId = tabId ?? currentSession?.activeFileTabId;
		const tab = currentSession?.filePreviewTabs.find((t) => t.id === targetTabId);
		if (!tab) return -1;
		const history = tab.navigationHistory ?? [];
		return tab.navigationIndex ?? history.length - 1;
	};

	const handleFileTabNavigateBack = useCallback(
		async (tabId?: string) => {
			const index = currentNavIndex(tabId);
			if (index > 0) await handleFileTabNavigateToIndex(index - 1, tabId);
		},
		[handleFileTabNavigateToIndex]
	);

	const handleFileTabNavigateForward = useCallback(
		async (tabId?: string) => {
			// The upper bound is re-checked inside navigateToIndex, so a stale index
			// past the end is a no-op rather than a crash.
			const index = currentNavIndex(tabId);
			if (index >= 0) await handleFileTabNavigateToIndex(index + 1, tabId);
		},
		[handleFileTabNavigateToIndex]
	);

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
