import React, { memo, useState, useEffect, useRef, useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { Session } from '../../types';
import type { QuickAction, QuickActionsModalProps } from './types';
import { useModalLayer } from '../../hooks/ui/useModalLayer';
import { useFocusAfterRender } from '../../hooks/utils/useFocusAfterRender';
import { notifyToast } from '../../stores/notificationStore';
import { notifyCenterFlash } from '../../stores/centerFlashStore';
import { flashCopiedToClipboard } from '../../utils/flashCopiedToClipboard';
import { captureException } from '../../utils/sentry';
import { useModalStore } from '../../stores/modalStore';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { gitService } from '../../services/git';
import { useGitDetail } from '../../contexts/GitStatusContext';
import { safeClipboardWrite } from '../../utils/clipboard';
import { getOpenInLabel } from '../../utils/platformUtils';
import { useListNavigation } from '../../hooks';
import { useUIStore } from '../../stores/uiStore';
import { useSettingsStore, selectIsLeaderboardRegistered } from '../../stores/settingsStore';
import { useBatchStore, selectActiveBatchSessionIds } from '../../stores/batchStore';
import { useFileExplorerStore } from '../../stores/fileExplorerStore';
import { useFeedbackDraftStore } from '../../stores/feedbackDraftStore';
import { openUrl } from '../../utils/openUrl';
import { outputSearchKeyFor } from '../../utils/outputSearch';
import { logger } from '../../utils/logger';
import { useOptionalWindowContext } from '../../contexts/WindowContext';
import { getActiveTabInfo } from './utils/activeTabInfo';
import {
	filterAndSortQuickActions,
	shouldShowAgentBucketHeaders,
} from './utils/quickActionSorting';
import { QuickActionsList } from './components/QuickActionsList';
import { QuickActionsSearchBar } from './components/QuickActionsSearchBar';
import { buildAgentPanelCommands } from './commands/agentPanelCommands';
import { buildAgentSwitcherCommands } from './commands/agentSwitcherCommands';
import { buildActiveTabContextCommands } from './commands/contextCommands';
import { buildDebugCommands } from './commands/debugCommands';
import { buildFeatureCommands } from './commands/featureCommands';
import { buildGitWorktreeCommands } from './commands/gitWorktreeCommands';
import { buildGroupChatCommands, buildGroupChatJumpCommands } from './commands/groupChatCommands';
import { buildMoveToGroupCommands } from './commands/moveToGroupCommands';
import { buildNavigationCommands } from './commands/navigationCommands';
import { buildRightPanelCommands } from './commands/rightPanelCommands';
import { buildSearchCommands } from './commands/searchCommands';
import {
	buildSessionJumpCommands,
	buildSessionManagementCommands,
} from './commands/sessionCommands';
import { buildSupportCommands } from './commands/supportCommands';
import { buildNewTabCommands, buildTabCommands } from './commands/tabCommands';

export const QuickActionsModal = memo(function QuickActionsModal(props: QuickActionsModalProps) {
	const {
		theme,
		sessions,
		setSessions,
		activeSessionId,
		groups,
		setGroups,
		shortcuts,
		initialMode = 'main',
		setQuickActionOpen,
		setActiveSessionId,
		setRenameInstanceModalOpen,
		setRenameInstanceValue,
		setRenameGroupModalOpen,
		setRenameGroupId,
		setRenameGroupValue,
		setRenameGroupEmoji,
		setCreateGroupModalOpen,
		setLeftSidebarOpen,
		setRightPanelOpen,
		setActiveRightTab,
		toggleInputMode,
		deleteSession,
		addNewSession,
		setSettingsModalOpen,
		setSettingsTab,
		setShortcutsHelpOpen,
		setAboutModalOpen,
		setFeedbackModalOpen,
		setLogViewerOpen,
		setProcessMonitorOpen,
		setUsageDashboardOpen,
		setAgentSessionsOpen,
		setMemoryViewerOpen,
		setActiveAgentSessionId,
		setGitDiffPreview,
		setGitLogOpen,
		onRenameTab,
		onToggleReadOnlyMode,
		onToggleTabShowThinking,
		onToggleTabEnterToSend,
		onOpenTabSwitcher,
		tabShortcuts,
		isAiMode,
		setPlaygroundOpen,
		onRefreshGitFileState,
		onDebugReleaseQueuedItem,
		markdownEditMode,
		onToggleMarkdownEditMode,
		setUpdateCheckModalOpen,
		openWizard,
		wizardGoToStep: _wizardGoToStep,
		setDebugPackageModalOpen,
		setDebugApplicationStatsOpen,
		startTour,
		setFuzzyFileSearchOpen,
		onEditAgent,
		groupChats,
		onNewGroupChat,
		onOpenGroupChat,
		onCloseGroupChat,
		onDeleteGroupChat,
		activeGroupChatId,
		hasActiveSessionCapability,
		onOpenMergeSession,
		onOpenSendToAgent,
		onQuickCreateWorktree,
		onOpenCreatePR,
		onSummarizeAndContinue,
		canSummarizeActiveTab,
		autoRunSelectedDocument,
		autoRunCompletedTaskCount,
		onAutoRunResetTasks,
		onToggleAutoRunExpanded,
		onClearActiveTerminal,
		onCloseAllTabs,
		onCloseOtherTabs,
		onCloseTabsLeft,
		onCloseTabsRight,
		onCloseCurrentTab,
		onMoveTabToFirst,
		onMoveTabToLast,
		onFocusActiveTab,
		onCopyTabContext,
		onExportTabHtml,
		onPublishTabGist,
		mainPanelRef,
		isFilePreviewOpen,
		ghCliAvailable,
		onPublishGist,
		onOpenPlaybookExchange,
		lastGraphFocusFile,
		onOpenLastDocumentGraph,
		currentGraphFile,
		onOpenCurrentFileInGraph,
		onOpenSymphony,
		onOpenDirectorNotes,
		onOpenMaestroCue,
		onConfigureCue,
		onOpenQueueBrowser,
		onNewTab,
		onNewFileTab,
		onNewBrowserTab,
		onNewTerminalTab,
		onGoToNextUnread,
		onNavBack,
		onNavForward,
	} = props;

	// Git status refresh — used to re-sync polling cache when `git diff` comes
	// back empty despite the widget advertising changes (e.g. files were
	// reverted or committed since the last poll).
	const { refreshGitStatus } = useGitDetail();

	// UI store actions for search commands (avoid threading more props through 3-layer chain)
	const setActiveFocus = useUIStore((s) => s.setActiveFocus);
	// Sourced from the modal store directly to skip the 3-layer prop chain.
	const openModal = useModalStore((s) => s.openModal);
	const closeModal = useModalStore((s) => s.closeModal);
	const setDebugAgentProbeOpen = useCallback(
		(open: boolean) => (open ? openModal('debugAgentProbe') : closeModal('debugAgentProbe')),
		[openModal, closeModal]
	);
	const storeSetSessionFilterOpen = useUIStore((s) => s.setSessionFilterOpen);
	const storeSetOutputSearchOpen = useUIStore((s) => s.setOutputSearchOpen);
	const storeSetFileTreeFilterOpen = useFileExplorerStore((s) => s.setFileTreeFilterOpen);
	const audioFeedbackEnabled = useSettingsStore((s) => s.audioFeedbackEnabled);
	const setAudioFeedbackEnabled = useSettingsStore((s) => s.setAudioFeedbackEnabled);
	const idleNotificationEnabled = useSettingsStore((s) => s.idleNotificationEnabled);
	const setIdleNotificationEnabled = useSettingsStore((s) => s.setIdleNotificationEnabled);
	const bionifyReadingMode = useSettingsStore((s) => s.bionifyReadingMode);
	const setBionifyReadingMode = useSettingsStore((s) => s.setBionifyReadingMode);
	const showStarredSessionsSection = useSettingsStore((s) => s.showStarredSessionsSection);
	const setShowStarredSessionsSection = useSettingsStore((s) => s.setShowStarredSessionsSection);
	const enterToSendAI = useSettingsStore((s) => s.enterToSendAI);
	const storeSetHistorySearchFilterOpen = useUIStore((s) => s.setHistorySearchFilterOpen);
	const setSuccessFlashNotification = useUIStore((s) => s.setSuccessFlashNotification);
	const bookmarksCollapsed = useUIStore((s) => s.bookmarksCollapsed);
	const setBookmarksCollapsed = useUIStore((s) => s.setBookmarksCollapsed);
	const ungroupedCollapsed = useSettingsStore((s) => s.ungroupedCollapsed);
	const setUngroupedCollapsed = useSettingsStore((s) => s.setUngroupedCollapsed);
	const groupChatsExpanded = useSettingsStore((s) => s.groupChatsExpanded);
	const setGroupChatsExpanded = useSettingsStore((s) => s.setGroupChatsExpanded);
	const isLeaderboardRegistered = useSettingsStore(selectIsLeaderboardRegistered);
	const activeBatchSessionIds = useBatchStore(useShallow(selectActiveBatchSessionIds));
	const windowContext = useOptionalWindowContext();

	const [search, setSearch] = useState('');
	const [mode, setMode] = useState<'main' | 'move-to-group' | 'agents'>(initialMode);
	const [renamingSession, setRenamingSession] = useState(false);
	const [renameValue, setRenameValue] = useState('');
	const [firstVisibleIndex, setFirstVisibleIndex] = useState(0);
	// Re-render once a second while the agent jumper has running agents so the
	// elapsed-time labels tick in place. We only run the interval when needed.
	const [now, setNow] = useState(() => Date.now());
	const hasRunningAgent = mode === 'agents' && sessions.some((s) => s.state !== 'idle');
	useEffect(() => {
		if (!hasRunningAgent) return;
		setNow(Date.now());
		const id = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(id);
	}, [hasRunningAgent]);

	// Performance profiling status. The main process owns the source of truth
	// (contentTracing is a process-global singleton); we mirror it into the
	// uiStore so the Left Bar wand can animate, and reconcile on palette open.
	const profilingActive = useUIStore((s) => s.profilingActive);
	const setProfilingActive = useUIStore((s) => s.setProfilingActive);
	useEffect(() => {
		let cancelled = false;
		// Optional-chained: this runs on every palette open, so tolerate a bridge
		// that isn't ready rather than throwing out of the effect.
		const statusPromise = window.maestro?.debug?.getProfilingStatus?.();
		if (!statusPromise) return;
		statusPromise
			.then((res) => {
				if (!cancelled && res?.success) setProfilingActive(res.active);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [setProfilingActive]);
	const handleStartProfiling = useCallback(async () => {
		try {
			const res = await window.maestro.debug.startProfiling();
			if (res?.success && res.active) {
				setProfilingActive(true);
				notifyCenterFlash({
					message: 'Performance profiling started',
					color: 'green',
					detail: 'Reproduce the lag, then run "End Performance Profiling"',
				});
			} else {
				notifyToast({
					color: 'red',
					title: 'Profiling',
					message: res?.error || 'Failed to start profiling',
				});
			}
		} catch (err) {
			notifyToast({ color: 'red', title: 'Profiling', message: 'Failed to start profiling' });
			captureException(err);
		}
	}, [setProfilingActive]);
	// Stopping is slow (flush + zip compression can take tens of seconds), so we
	// hand off to the ProfilingCaptureModal, which owns the whole stop-and-bundle
	// flow, shows live progress, and clears the wand indicator when it finishes.
	const handleStopProfiling = useCallback(() => {
		openModal('profilingCapture');
	}, [openModal]);

	const inputRef = useRef<HTMLInputElement>(null);
	const selectedItemRef = useRef<HTMLButtonElement>(null);
	const scrollContainerRef = useRef<HTMLDivElement>(null);
	const modalRef = useRef<HTMLDivElement>(null);
	const resetSelectionToFirstRef = useRef<() => void>(() => {});
	const resetSelectionToFirst = useCallback(() => resetSelectionToFirstRef.current(), []);
	const activeSession = sessions.find((s) => s.id === activeSessionId);
	// Output search is scoped per agent+AI-tab; open the active window's slot so
	// the Find bar doesn't follow the user to other agents/tabs.
	const openActiveOutputSearch = useCallback(
		(open: boolean) => {
			if (activeSession) {
				storeSetOutputSearchOpen(
					outputSearchKeyFor(activeSession.id, activeSession.activeTabId),
					open
				);
			}
		},
		[storeSetOutputSearchOpen, activeSession]
	);

	const activeTabInfo = getActiveTabInfo(activeSession, isAiMode);
	const activeTabType = activeTabInfo.activeTabType;

	// Register layer on mount - escape behavior depends on current mode.
	// Only fall back to the main menu if the user actually came from there;
	// when the modal was opened directly into move-to-group via a hotkey,
	// escape should dismiss it entirely rather than reveal the cmd+k menu.
	useModalLayer(MODAL_PRIORITIES.QUICK_ACTION, 'Quick Actions', () => {
		if (mode === 'move-to-group' && initialMode === 'main') {
			setMode('main');
			// Note: Selection will be reset by the search/mode change useEffect
		} else {
			setQuickActionOpen(false);
		}
	});

	useFocusAfterRender(inputRef, true, 50);

	// Track scroll position to determine which items are visible.
	// Items have variable height (subtext / runningInfo presence, plus LIVE/IDLE
	// section headers that interleave with — but aren't part of — `filtered`),
	// so a magic itemHeight constant drifts. Measure real button positions
	// against the container's viewport instead.
	const handleScroll = () => {
		const container = scrollContainerRef.current;
		if (!container) return;
		const containerTop = container.getBoundingClientRect().top;
		const buttons = container.querySelectorAll<HTMLButtonElement>(':scope > button');
		let visibleIndex = Math.max(0, buttons.length - 1);
		for (let i = 0; i < buttons.length; i++) {
			if (buttons[i].getBoundingClientRect().bottom > containerTop) {
				visibleIndex = i;
				break;
			}
		}
		setFirstVisibleIndex(visibleIndex);
	};

	const handleRenameSession = () => {
		if (renameValue.trim()) {
			const updatedSessions = sessions.map((s) =>
				s.id === activeSessionId ? { ...s, name: renameValue.trim() } : s
			);
			setSessions(updatedSessions);
			setQuickActionOpen(false);
		}
	};

	const handleMoveToGroup = (groupId: string) => {
		const normalizedGroupId = groupId || undefined;
		const updatedSessions = sessions.map((s) => {
			if (s.id === activeSessionId) return { ...s, groupId: normalizedGroupId };
			// Also update worktree children to keep groupId in sync
			if (s.parentSessionId === activeSessionId) return { ...s, groupId: normalizedGroupId };
			return s;
		});
		setSessions(updatedSessions);
		setQuickActionOpen(false);
	};

	const handleCreateGroup = () => {
		setCreateGroupModalOpen(true);
		setQuickActionOpen(false);
	};

	// Reveal a jumped-to agent without unnecessarily expanding sections.
	// - Not bookmarked: expand the parent group if collapsed (existing behavior).
	// - Bookmarked: prefer whichever section the agent is already visible in. If
	//   neither bookmarks nor the parent group is open, expand bookmarks (the
	//   pinned bookmark row is the lighter-weight reveal of the two).
	const revealJumpTarget = useCallback(
		(s: Session) => {
			if (!s.bookmarked) {
				if (s.groupId) {
					setGroups((prev) =>
						prev.map((g) => (g.id === s.groupId && g.collapsed ? { ...g, collapsed: false } : g))
					);
				}
				return;
			}
			const groupOpen = s.groupId ? !groups.find((g) => g.id === s.groupId)?.collapsed : false;
			if (bookmarksCollapsed && !groupOpen) {
				setBookmarksCollapsed(false);
			}
		},
		[bookmarksCollapsed, groups, setBookmarksCollapsed, setGroups]
	);

	const handleJumpToSession = useCallback(
		async (session: Session) => {
			if (!windowContext?.windowId) {
				setActiveSessionId(session.id);
				revealJumpTarget(session);
				return;
			}

			if (windowContext.sessionIds.includes(session.id)) {
				await windowContext.openSession(session.id);
				setActiveSessionId(session.id);
				revealJumpTarget(session);
				return;
			}

			const ownerWindowId = await window.maestro.windows.getForSession(session.id);
			if (ownerWindowId && ownerWindowId !== windowContext.windowId) {
				await window.maestro.windows.focusWindow(ownerWindowId);
				return;
			}

			await windowContext.openSession(session.id);
			setActiveSessionId(session.id);
			revealJumpTarget(session);
		},
		[revealJumpTarget, setActiveSessionId, windowContext]
	);

	const sessionActions = buildSessionJumpCommands({
		sessions,
		handleJumpToSession,
	});

	const groupChatActions = buildGroupChatJumpCommands({
		groupChats,
		onOpenGroupChat,
		setQuickActionOpen,
	});

	const mainActions: QuickAction[] = [
		...sessionActions,
		...groupChatActions,
		...buildNavigationCommands({
			activeSession,
			activeSessionId,
			setQuickActionOpen,
			setLeftSidebarOpen,
			setRightPanelOpen,
			addNewSession,
			deleteSession,
			openWizard,
			getOpenInLabel,
			platform: window.maestro?.platform || 'darwin',
			openPath: window.maestro?.shell?.openPath,
			onGoToNextUnread,
			onNavBack,
			onNavForward,
			shortcuts: {
				newInstance: shortcuts.newInstance,
				openWizard: shortcuts.openWizard,
				toggleSidebar: shortcuts.toggleSidebar,
				toggleRightPanel: shortcuts.toggleRightPanel,
				nextUnreadTab: shortcuts.nextUnreadTab,
				killInstance: shortcuts.killInstance,
				navBack: shortcuts.navBack,
				navForward: shortcuts.navForward,
			},
		}),
		...buildNewTabCommands({
			activeSession,
			onNewTab,
			onNewFileTab,
			onNewBrowserTab,
			onNewTerminalTab,
			setQuickActionOpen,
			newTabShortcut: tabShortcuts?.newTab,
			newFileTabShortcut: tabShortcuts?.newFileTab,
			newBrowserTabShortcut: tabShortcuts?.newBrowserTab,
		}),
		...buildSessionManagementCommands({
			activeSession,
			activeSessionId,
			sessions,
			setSessions,
			setQuickActionOpen,
			setRenameInstanceModalOpen,
			setRenameInstanceValue,
			onEditAgent,
			agentSettingsShortcut: shortcuts.agentSettings,
			toggleBookmarkShortcut: shortcuts.toggleBookmark,
			deleteSession,
			killShortcut: shortcuts.killInstance,
			openClearBookmarksConfirm: (bookmarkedCount) => {
				useModalStore.getState().openModal('confirm', {
					title: 'Clear All Bookmarks',
					message: `Remove bookmarks from ${bookmarkedCount} agent${
						bookmarkedCount === 1 ? '' : 's'
					}?`,
					destructive: true,
					onConfirm: () => {
						setSessions((prev) =>
							prev.map((session) =>
								session.bookmarked ? { ...session, bookmarked: false } : session
							)
						);
					},
				});
			},
		}).filter((action) => action.id !== 'kill'),
		...buildAgentPanelCommands({
			activeSession,
			groups,
			sessions,
			setGroups,
			setSessions,
			setQuickActionOpen,
			setRenameGroupModalOpen,
			setRenameGroupId,
			setRenameGroupValue,
			setRenameGroupEmoji,
			setCreateGroupModalOpen,
			setRightPanelOpen,
			setActiveRightTab,
			setMode,
			resetSelectionToFirst,
			moveToGroupShortcut: shortcuts.moveToGroup,
			ungroupedCollapsed,
			setUngroupedCollapsed,
			bookmarksCollapsed,
			setBookmarksCollapsed,
			groupChatsExpanded,
			setGroupChatsExpanded,
		}),
		...buildTabCommands({
			activeSession,
			isAiMode,
			activeTabInfo,
			enterToSendAI,
			markdownEditMode,
			onOpenTabSwitcher,
			onRenameTab,
			onToggleReadOnlyMode,
			onToggleTabShowThinking,
			onToggleTabEnterToSend,
			onToggleMarkdownEditMode,
			onFocusActiveTab,
			onCloseAllTabs,
			onCloseOtherTabs,
			onCloseTabsLeft,
			onCloseTabsRight,
			onCloseCurrentTab,
			onMoveTabToFirst,
			onMoveTabToLast,
			onClearActiveTerminal,
			setQuickActionOpen,
			shortcuts: {
				toggleMode: shortcuts.toggleMode,
				toggleMarkdownMode: shortcuts.toggleMarkdownMode,
				focusActiveTab: shortcuts.focusActiveTab,
				clearTerminal: shortcuts.clearTerminal,
			},
			tabShortcuts,
			toggleInputMode,
		}),
		...buildFeatureCommands({
			activeSession,
			activeTabType,
			canSummarizeActiveTab,
			markdownEditMode,
			isFilePreviewOpen,
			ghCliAvailable,
			lastGraphFocusFile,
			currentGraphFile,
			hasActiveSessionCapability,
			setQuickActionOpen,
			setSuccessFlashNotification,
			setAgentSessionsOpen,
			setActiveAgentSessionId,
			setMemoryViewerOpen,
			setFuzzyFileSearchOpen,
			setUsageDashboardOpen,
			onSummarizeAndContinue,
			onOpenMergeSession,
			onOpenSendToAgent,
			onOpenQueueBrowser,
			onOpenPlaybookExchange,
			onOpenSymphony,
			onOpenDirectorNotes,
			onOpenMaestroCue,
			onConfigureCue,
			onOpenLastDocumentGraph,
			onOpenCurrentFileInGraph,
			onPublishGist,
			bionifyReadingMode,
			setBionifyReadingMode,
			audioFeedbackEnabled,
			setAudioFeedbackEnabled,
			idleNotificationEnabled,
			setIdleNotificationEnabled,
			showStarredSessionsSection,
			setShowStarredSessionsSection,
			shortcuts: {
				usageDashboard: shortcuts.usageDashboard,
				agentSessions: shortcuts.agentSessions,
				openMemoryViewer: shortcuts.openMemoryViewer,
				mergeSession: shortcuts.mergeSession,
				sendToAgent: shortcuts.sendToAgent,
				openSymphony: shortcuts.openSymphony,
				directorNotes: shortcuts.directorNotes,
				maestroCue: shortcuts.maestroCue,
				fuzzyFileSearch: shortcuts.fuzzyFileSearch,
				editClipboardImage: shortcuts.editClipboardImage,
			},
			tabShortcuts,
		}),
		...buildActiveTabContextCommands({
			activeSession,
			activeSessionId,
			activeTabType,
			ghCliAvailable,
			setSessions,
			setQuickActionOpen,
			safeClipboardWrite,
			flashCopiedToClipboard,
			onCopyTabContext,
			onExportTabHtml,
			onPublishTabGist,
			mainPanelRef,
			toggleTabStarShortcut: shortcuts.toggleTabStar,
			toggleTabUnreadShortcut: tabShortcuts?.toggleTabUnread,
		}),
		...buildSupportCommands({
			setQuickActionOpen,
			setSettingsModalOpen,
			setSettingsTab,
			setShortcutsHelpOpen,
			setAboutModalOpen,
			onOpenLeaderboardRegistration: () => openModal('leaderboard'),
			isLeaderboardRegistered,
			setFeedbackModalOpen,
			setLogViewerOpen,
			setProcessMonitorOpen,
			setUpdateCheckModalOpen,
			setDebugPackageModalOpen,
			startTour,
			getFeedbackDraft: () => useFeedbackDraftStore.getState(),
			createDebugPackage: () => window.maestro.debug.createPackage(),
			notifyToast,
			openUrl,
			toggleDevtools: () => window.maestro.devtools.toggle(),
			shortcuts: {
				settings: shortcuts.settings,
				help: shortcuts.help,
				systemLogs: shortcuts.systemLogs,
				processMonitor: shortcuts.processMonitor,
			},
		}),
		...buildGitWorktreeCommands({
			activeSession,
			sessions,
			setGitDiffPreview,
			setGitLogOpen,
			setQuickActionOpen,
			onQuickCreateWorktree,
			onOpenCreatePR,
			onRefreshGitFileState,
			onRefreshGitStatus: refreshGitStatus,
			shortcuts: {
				viewGitDiff: shortcuts.viewGitDiff,
				viewGitLog: shortcuts.viewGitLog,
			},
			gitService,
			notifyCenterFlash,
			notifyToast,
			openUrl,
			logger,
		}),
		...buildRightPanelCommands({
			autoRunDisabled: useSettingsStore.getState().autoRunDisabled,
			autoRunSelectedDocument,
			autoRunCompletedTaskCount,
			setRightPanelOpen,
			setActiveRightTab,
			setQuickActionOpen,
			onToggleAutoRunExpanded,
			onAutoRunResetTasks,
			shortcuts: {
				goToFiles: shortcuts.goToFiles,
				goToHistory: shortcuts.goToHistory,
				goToAutoRun: shortcuts.goToAutoRun,
				toggleAutoRunExpanded: shortcuts.toggleAutoRunExpanded,
			},
		}),
		...buildSearchCommands({
			setQuickActionOpen,
			setLeftSidebarOpen,
			setRightPanelOpen,
			setActiveRightTab,
			setActiveFocus,
			setSessionFilterOpen: storeSetSessionFilterOpen,
			setOutputSearchOpen: openActiveOutputSearch,
			setFileTreeFilterOpen: storeSetFileTreeFilterOpen,
			setHistorySearchFilterOpen: storeSetHistorySearchFilterOpen,
		}),
		...buildGroupChatCommands({
			sessions,
			groupChats,
			activeGroupChatId,
			onNewGroupChat,
			onCloseGroupChat,
			onDeleteGroupChat,
			setQuickActionOpen,
			newGroupChatShortcut: shortcuts.newGroupChat,
			killShortcut: shortcuts.killInstance,
		}),
		...buildDebugCommands({
			activeSession,
			activeSessionId,
			sessions,
			setSessions,
			setQuickActionOpen,
			setPlaygroundOpen,
			setDebugApplicationStatsOpen,
			setDebugAgentProbeOpen,
			onDebugReleaseQueuedItem,
			profilingActive,
			onStartProfiling: handleStartProfiling,
			onStopProfiling: handleStopProfiling,
			getInstallationId: () => window.maestro.leaderboard.getInstallationId(),
			safeClipboardWrite,
			flashCopiedToClipboard,
			notifyToast,
			logger,
		}),
	];

	const groupActions = buildMoveToGroupCommands({
		initialMode,
		groups,
		handleMoveToGroup,
		handleCreateGroup,
		setMode,
		resetSelectionToFirst,
	});

	const agentActions = buildAgentSwitcherCommands({
		sessions,
		activeBatchSessionIds,
		handleJumpToSession,
	});

	const actions = mode === 'agents' ? agentActions : mode === 'main' ? mainActions : groupActions;

	const filtered = filterAndSortQuickActions(actions, search, mode);

	// Use a ref for filtered actions so the onSelect callback stays stable
	const filteredRef = useRef(filtered);
	filteredRef.current = filtered;

	// LIVE/IDLE bucket headers only earn their pixels in agents mode when both
	// buckets are present — a single-bucket list doesn't need a label above it.
	const showBucketHeaders = shouldShowAgentBucketHeaders(filtered, mode);

	// Callback for when an item is selected (by Enter key or number hotkey)
	const handleSelectByIndex = useCallback(
		(index: number) => {
			const selectedAction = filteredRef.current[index];
			if (!selectedAction) return;

			// Don't close modal if action switches modes
			const switchesModes = selectedAction.id === 'moveToGroup' || selectedAction.id === 'back';
			selectedAction.action();
			if (!renamingSession && (mode === 'main' || mode === 'agents') && !switchesModes) {
				setQuickActionOpen(false);
			}
		},
		[renamingSession, mode, setQuickActionOpen]
	);

	// Use hook for list navigation (arrow keys, number hotkeys, Enter)
	const {
		selectedIndex,
		setSelectedIndex,
		handleKeyDown: listHandleKeyDown,
		resetSelection,
	} = useListNavigation({
		listLength: filtered.length,
		onSelect: handleSelectByIndex,
		enableNumberHotkeys: true,
		firstVisibleIndex,
		enabled: !renamingSession, // Disable navigation when renaming
	});
	resetSelectionToFirstRef.current = () => setSelectedIndex(0);

	// Scroll selected item into view
	useEffect(() => {
		selectedItemRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
	}, [selectedIndex]);

	// Reset selection when search or mode changes.
	// resetSelection is intentionally excluded from deps — it changes when filtered.length
	// changes, but we only want to reset on user-driven search/mode changes, not on every
	// list length fluctuation from parent re-renders (which causes infinite update loops).
	useEffect(() => {
		resetSelection();
		setFirstVisibleIndex(0);
	}, [search, mode]);

	// Clear search when switching to move-to-group mode
	useEffect(() => {
		if (mode === 'move-to-group') {
			setSearch('');
		}
	}, [mode]);

	const handleKeyDown = (e: React.KeyboardEvent) => {
		// Handle rename mode separately
		if (renamingSession) {
			if (e.key === 'Enter') {
				e.preventDefault();
				handleRenameSession();
			} else if (e.key === 'Escape') {
				e.preventDefault();
				setRenamingSession(false);
			}
			return;
		}

		// Delegate to list navigation hook
		listHandleKeyDown(e);

		// Add stopPropagation for Enter to prevent event bubbling
		if (e.key === 'Enter') {
			e.stopPropagation();
		}
	};

	return (
		<div
			className="fixed inset-0 modal-overlay flex items-start justify-center pt-32 z-[9999] animate-in fade-in duration-100"
			onMouseDown={(e) => {
				// Dismiss when clicking outside the modal content (backdrop only).
				if (e.target === e.currentTarget && !renamingSession) {
					setQuickActionOpen(false);
				}
			}}
		>
			<div
				ref={modalRef}
				role="dialog"
				aria-modal="true"
				aria-label={mode === 'agents' ? 'Switch Agent' : 'Quick Actions'}
				tabIndex={-1}
				className="modal-w-md rounded-xl shadow-2xl border overflow-hidden flex flex-col max-h-[min(680px,calc(100vh-10rem))] outline-none"
				style={{ backgroundColor: theme.colors.bgActivity, borderColor: theme.colors.border }}
			>
				<QuickActionsSearchBar
					theme={theme}
					mode={mode}
					activeSession={activeSession}
					renamingSession={renamingSession}
					search={search}
					setSearch={setSearch}
					renameValue={renameValue}
					setRenameValue={setRenameValue}
					inputRef={inputRef}
					onKeyDown={handleKeyDown}
				/>
				{!renamingSession && (
					<QuickActionsList
						filtered={filtered}
						selectedIndex={selectedIndex}
						firstVisibleIndex={firstVisibleIndex}
						showBucketHeaders={showBucketHeaders}
						now={now}
						theme={theme}
						scrollContainerRef={scrollContainerRef}
						selectedItemRef={selectedItemRef}
						onScroll={handleScroll}
						onActionClick={(action) => {
							const switchesModes = action.id === 'moveToGroup' || action.id === 'back';
							action.action();
							if ((mode === 'main' || mode === 'agents') && !switchesModes)
								setQuickActionOpen(false);
						}}
					/>
				)}
			</div>
		</div>
	);
});
