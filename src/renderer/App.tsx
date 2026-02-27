import React, { useState, useEffect, useRef, useMemo, useCallback, lazy, Suspense } from 'react';
// SettingsModal is lazy-loaded for performance (large component, only loaded when settings opened)
const SettingsModal = lazy(() =>
	import('./components/SettingsModal').then((m) => ({ default: m.SettingsModal }))
);
import { SessionList } from './components/SessionList';
import { RightPanel, RightPanelHandle } from './components/RightPanel';
import { slashCommands } from './slashCommands';
import { AppModals, type PRDetails, type FlatFileItem } from './components/AppModals';
import { DEFAULT_BATCH_PROMPT } from './components/BatchRunnerModal';
import { ErrorBoundary } from './components/ErrorBoundary';
import { MainPanel, type MainPanelHandle } from './components/MainPanel';
import { AppOverlays } from './components/AppOverlays';
import { PlaygroundPanel } from './components/PlaygroundPanel';
import { DebugWizardModal } from './components/DebugWizardModal';
import { DebugPackageModal } from './components/DebugPackageModal';
import { WindowsWarningModal } from './components/WindowsWarningModal';
import { GistPublishModal } from './components/GistPublishModal';
import { MaestroWizard, useWizard, WizardResumeModal } from './components/Wizard';
import { TourOverlay } from './components/Wizard/tour';
import { CONDUCTOR_BADGES } from './constants/conductorBadges';
import { EmptyStateView } from './components/EmptyStateView';
import { DeleteAgentConfirmModal } from './components/DeleteAgentConfirmModal';

// Lazy-loaded components for performance (rarely-used heavy modals)
// These are loaded on-demand when the user first opens them
const LogViewer = lazy(() =>
	import('./components/LogViewer').then((m) => ({ default: m.LogViewer }))
);
const MarketplaceModal = lazy(() =>
	import('./components/MarketplaceModal').then((m) => ({ default: m.MarketplaceModal }))
);
const SymphonyModal = lazy(() =>
	import('./components/SymphonyModal').then((m) => ({ default: m.SymphonyModal }))
);
const DocumentGraphView = lazy(() =>
	import('./components/DocumentGraph/DocumentGraphView').then((m) => ({
		default: m.DocumentGraphView,
	}))
);
const DirectorNotesModal = lazy(() =>
	import('./components/DirectorNotes').then((m) => ({ default: m.DirectorNotesModal }))
);

// Re-import the type for SymphonyContributionData (types don't need lazy loading)
import type { SymphonyContributionData } from './components/SymphonyModal';

// Group Chat Components
import { GroupChatPanel } from './components/GroupChatPanel';
import { GroupChatRightPanel } from './components/GroupChatRightPanel';

// Import custom hooks
import {
	// Batch processing
	useBatchHandlers,
	useBatchedSessionUpdates,
	// Settings
	useSettings,
	useDebouncedPersistence,
	// Session management
	useActivityTracker,
	useHandsOnTimeTracker,
	useNavigationHistory,
	useSessionNavigation,
	useSortedSessions,
	compareNamesIgnoringEmojis,
	useGroupManagement,
	// Input processing
	useInputHandlers,
	// Keyboard handling
	useKeyboardShortcutHelpers,
	useKeyboardNavigation,
	useMainKeyboardHandler,
	// Agent
	useAgentSessionManagement,
	useAgentExecution,
	useAgentCapabilities,
	useMergeTransferHandlers,
	useSummarizeAndContinue,
	// Git
	useFileTreeManagement,
	useFileExplorerEffects,
	// Remote
	useRemoteIntegration,
	useRemoteHandlers,
	useWebBroadcasting,
	useCliActivityMonitoring,
	useMobileLandscape,
	// UI
	useThemeStyles,
	useAppHandlers,
	// Auto Run
	useAutoRunHandlers,
	// Tab handlers
	useTabHandlers,
	// Group chat handlers
	useGroupChatHandlers,
	// Modal handlers
	useModalHandlers,
	// Worktree handlers
	useWorktreeHandlers,
	// Session restoration
	useSessionRestoration,
	// Input keyboard handling
	// App initialization effects
	useAppInitialization,
	// Session lifecycle operations
	useSessionLifecycle,
	useSessionCrud,
	// Wizard handlers
	useWizardHandlers,
	// Interrupt handler
	useInterruptHandler,
} from './hooks';
import { useMainPanelProps, useSessionListProps, useRightPanelProps } from './hooks/props';
import { useAgentListeners } from './hooks/agent/useAgentListeners';

// Import contexts
import { useLayerStack } from './contexts/LayerStackContext';
import { notifyToast } from './stores/notificationStore';
import { useModalActions, useModalStore } from './stores/modalStore';
import { GitStatusProvider } from './contexts/GitStatusContext';
import { InputProvider, useInputContext } from './contexts/InputContext';
import { useGroupChatStore } from './stores/groupChatStore';
import { useBatchStore } from './stores/batchStore';
// All session state is read directly from useSessionStore in MaestroConsoleInner.
import { useSessionStore, selectActiveSession } from './stores/sessionStore';
import { useAgentStore } from './stores/agentStore';
import { InlineWizardProvider, useInlineWizardContext } from './contexts/InlineWizardContext';
import { ToastContainer } from './components/Toast';

// Import services
import { gitService } from './services/git';

// Import types and constants
// Note: GroupChat, GroupChatState are imported from types (re-exported from shared)
import type {
	ToolType,
	SessionState,
	RightPanelTab,
	Session,
	AITab,
	QueuedItem,
	BatchRunConfig,
	CustomAICommand,
	ThinkingMode,
	ThinkingItem,
} from './types';
import { THEMES } from './constants/themes';
import { generateId } from './utils/ids';
import { getContextColor } from './utils/theme';
import {
	createTab,
	closeTab,
	reopenUnifiedClosedTab,
	getActiveTab,
	navigateToNextTab,
	navigateToPrevTab,
	navigateToTabByIndex,
	navigateToLastTab,
	navigateToUnifiedTabByIndex,
	navigateToLastUnifiedTab,
	navigateToNextUnifiedTab,
	navigateToPrevUnifiedTab,
	hasActiveWizard,
} from './utils/tabHelpers';
import { validateNewSession } from './utils/sessionValidation';
import { formatLogsForClipboard } from './utils/contextExtractor';
// getSlashCommandDescription moved to useWizardHandlers
import { useUIStore } from './stores/uiStore';
import { useTabStore } from './stores/tabStore';
import { useFileExplorerStore } from './stores/fileExplorerStore';

function MaestroConsoleInner() {
	// --- LAYER STACK (for blocking shortcuts when modals are open) ---
	const { hasOpenLayers, hasOpenModal } = useLayerStack();

	// --- MODAL STATE (from modalStore, replaces ModalContext) ---
	const {
		// Settings Modal
		settingsModalOpen,
		setSettingsModalOpen,
		settingsTab,
		setSettingsTab,
		// New Instance Modal
		newInstanceModalOpen,
		duplicatingSessionId,
		// Edit Agent Modal
		editAgentModalOpen,
		setEditAgentModalOpen,
		editAgentSession,
		setEditAgentSession,
		// Delete Agent Modal
		deleteAgentModalOpen,
		deleteAgentSession,
		// Shortcuts Help Modal
		shortcutsHelpOpen,
		setShortcutsHelpOpen,
		// Quick Actions Modal
		quickActionOpen,
		setQuickActionOpen,
		quickActionInitialMode,
		setQuickActionInitialMode,
		// Lightbox Modal
		lightboxImage,
		lightboxImages,
		lightboxAllowDelete,
		// About Modal
		aboutModalOpen,
		setAboutModalOpen,
		// Update Check Modal
		updateCheckModalOpen,
		setUpdateCheckModalOpen,
		// Leaderboard Registration Modal
		leaderboardRegistrationOpen,
		// Standing Ovation Overlay
		standingOvationData,
		setStandingOvationData,
		// First Run Celebration
		firstRunCelebrationData,
		// Log Viewer
		logViewerOpen,
		setLogViewerOpen,
		// Process Monitor
		processMonitorOpen,
		setProcessMonitorOpen,
		// Usage Dashboard
		usageDashboardOpen,
		setUsageDashboardOpen,
		// Keyboard Mastery Celebration
		pendingKeyboardMasteryLevel,
		// Playground Panel
		playgroundOpen,
		setPlaygroundOpen,
		// Debug Wizard Modal
		debugWizardModalOpen,
		setDebugWizardModalOpen,
		// Debug Package Modal
		debugPackageModalOpen,
		setDebugPackageModalOpen,
		// Windows Warning Modal
		windowsWarningModalOpen,
		setWindowsWarningModalOpen,
		// Confirmation Modal
		confirmModalOpen,
		setConfirmModalOpen,
		confirmModalMessage,
		setConfirmModalMessage,
		confirmModalOnConfirm,
		setConfirmModalOnConfirm,
		confirmModalTitle,
		confirmModalDestructive,
		// Quit Confirmation Modal
		quitConfirmModalOpen,
		// Rename Instance Modal
		renameInstanceModalOpen,
		setRenameInstanceModalOpen,
		renameInstanceValue,
		setRenameInstanceValue,
		renameInstanceSessionId,
		// Rename Tab Modal
		renameTabModalOpen,
		setRenameTabModalOpen,
		renameTabId,
		setRenameTabId,
		renameTabInitialName,
		setRenameTabInitialName,
		// Rename Group Modal
		renameGroupModalOpen,
		setRenameGroupModalOpen,
		renameGroupId,
		setRenameGroupId,
		renameGroupValue,
		setRenameGroupValue,
		renameGroupEmoji,
		setRenameGroupEmoji,
		// Agent Sessions Browser
		agentSessionsOpen,
		setAgentSessionsOpen,
		activeAgentSessionId,
		setActiveAgentSessionId,
		// Execution Queue Browser Modal
		queueBrowserOpen,
		// Batch Runner Modal
		batchRunnerModalOpen,
		setBatchRunnerModalOpen,
		// Auto Run Setup Modal
		autoRunSetupModalOpen,
		setAutoRunSetupModalOpen,
		// Marketplace Modal
		marketplaceModalOpen,
		setMarketplaceModalOpen,
		// Wizard Resume Modal
		wizardResumeModalOpen,
		setWizardResumeModalOpen,
		wizardResumeState,
		setWizardResumeState,
		// Agent Error Modal
		// Worktree Modals
		worktreeConfigModalOpen,
		createWorktreeModalOpen,
		createWorktreeSession,
		createPRModalOpen,
		createPRSession,
		setCreatePRSession,
		deleteWorktreeModalOpen,
		deleteWorktreeSession,
		// Tab Switcher Modal
		tabSwitcherOpen,
		setTabSwitcherOpen,
		// Fuzzy File Search Modal
		fuzzyFileSearchOpen,
		setFuzzyFileSearchOpen,
		// Prompt Composer Modal
		promptComposerOpen,
		setPromptComposerOpen,
		// Merge Session Modal
		mergeSessionModalOpen,
		setMergeSessionModalOpen,
		// Send to Agent Modal
		sendToAgentModalOpen,
		setSendToAgentModalOpen,
		// Group Chat Modals
		showNewGroupChatModal,
		setShowNewGroupChatModal,
		showDeleteGroupChatModal,
		showRenameGroupChatModal,
		showEditGroupChatModal,
		showGroupChatInfo,
		// Git Diff Viewer
		gitDiffPreview,
		setGitDiffPreview,
		// Git Log Viewer
		gitLogOpen,
		setGitLogOpen,
		// Tour Overlay
		tourOpen,
		setTourOpen,
		tourFromWizard,
		// setTourFromWizard now used in useWizardHandlers via getModalActions()
		// Symphony Modal
		symphonyModalOpen,
		setSymphonyModalOpen,
		// Director's Notes Modal
		directorNotesOpen,
		setDirectorNotesOpen,
	} = useModalActions();

	// --- MOBILE LANDSCAPE MODE (reading-only view) ---
	const isMobileLandscape = useMobileLandscape();

	// --- NAVIGATION HISTORY (back/forward through sessions and tabs) ---
	const { pushNavigation, navigateBack, navigateForward } = useNavigationHistory();

	// --- WIZARD (onboarding wizard for new users) ---
	const {
		state: wizardState,
		openWizard: openWizardModal,
		restoreState: restoreWizardState,
		loadResumeState: _loadResumeState,
		clearResumeState,
		completeWizard,
		closeWizard: _closeWizardModal,
		goToStep: wizardGoToStep,
	} = useWizard();

	// --- SETTINGS (from useSettings hook) ---
	const settings = useSettings();
	const {
		conductorProfile,
		llmProvider,
		setLlmProvider,
		modelSlug,
		setModelSlug,
		apiKey,
		setApiKey,
		defaultShell,
		setDefaultShell,
		customShellPath,
		setCustomShellPath,
		shellArgs,
		setShellArgs,
		shellEnvVars,
		setShellEnvVars,
		ghPath,
		setGhPath,
		fontFamily,
		setFontFamily,
		fontSize,
		setFontSize,
		activeThemeId,
		setActiveThemeId,
		customThemeColors,
		setCustomThemeColors,
		customThemeBaseId,
		setCustomThemeBaseId,
		enterToSendAI,
		setEnterToSendAI,
		enterToSendTerminal,
		setEnterToSendTerminal,
		defaultSaveToHistory,
		setDefaultSaveToHistory,
		defaultShowThinking,
		setDefaultShowThinking,
		rightPanelWidth,
		setRightPanelWidth,
		markdownEditMode,
		setMarkdownEditMode,
		chatRawTextMode,
		setChatRawTextMode,
		terminalWidth,
		setTerminalWidth,
		logLevel,
		setLogLevel,
		logViewerSelectedLevels,
		setLogViewerSelectedLevels,
		maxLogBuffer,
		setMaxLogBuffer,
		maxOutputLines,
		setMaxOutputLines,
		osNotificationsEnabled,
		setOsNotificationsEnabled,
		audioFeedbackEnabled,
		setAudioFeedbackEnabled,
		audioFeedbackCommand,
		setAudioFeedbackCommand,
		toastDuration,
		setToastDuration,
		checkForUpdatesOnStartup,
		setCheckForUpdatesOnStartup,
		enableBetaUpdates,
		setEnableBetaUpdates,
		crashReportingEnabled,
		setCrashReportingEnabled,
		shortcuts,
		setShortcuts,
		tabShortcuts,
		setTabShortcuts,
		customAICommands,
		setCustomAICommands,
		totalActiveTimeMs,
		addTotalActiveTimeMs,
		autoRunStats,
		updateAutoRunProgress,
		usageStats,
		updateUsageStats,
		tourCompleted: _tourCompleted,
		setTourCompleted,
		recordWizardStart,
		recordWizardComplete,
		recordWizardAbandon,
		recordWizardResume,
		recordTourStart,
		recordTourComplete,
		recordTourSkip,
		leaderboardRegistration,
		isLeaderboardRegistered,

		contextManagementSettings,
		updateContextManagementSettings: _updateContextManagementSettings,

		keyboardMasteryStats,
		recordShortcutUsage,

		// Document Graph & Stats settings
		colorBlindMode,
		defaultStatsTimeRange,
		documentGraphShowExternalLinks,
		documentGraphMaxNodes,
		documentGraphPreviewCharLimit,

		// Rendering settings
		disableConfetti,

		// File tab refresh settings
		fileTabAutoRefreshEnabled,

		// Window chrome settings
		useNativeTitleBar,

		// Auto-scroll settings
		autoScrollAiMode,
		setAutoScrollAiMode,

		// Message alignment
		userMessageAlignment,
		setUserMessageAlignment,

		// Windows warning suppression
		setSuppressWindowsWarning,

		// Encore Features
		encoreFeatures,
		setEncoreFeatures,
	} = settings;

	// --- KEYBOARD SHORTCUT HELPERS ---
	const { isShortcut, isTabShortcut } = useKeyboardShortcutHelpers({
		shortcuts,
		tabShortcuts,
	});

	// --- SESSION STATE (migrated from useSession() to direct useSessionStore selectors) ---
	// Reactive values — each selector triggers re-render only when its specific value changes
	const sessions = useSessionStore((s) => s.sessions);
	const groups = useSessionStore((s) => s.groups);
	const activeSessionId = useSessionStore((s) => s.activeSessionId);
	const sessionsLoaded = useSessionStore((s) => s.sessionsLoaded);
	const activeSession = useSessionStore(selectActiveSession);

	// Actions — stable references from store, never trigger re-renders
	const {
		setSessions,
		setGroups,
		setActiveSessionId: storeSetActiveSessionId,
		setActiveSessionIdInternal,
		setRemovedWorktreePaths,
	} = useMemo(() => useSessionStore.getState(), []);

	// batchedUpdater — React hook for timer lifecycle (reads store directly)
	const batchedUpdater = useBatchedSessionUpdates();
	const batchedUpdaterRef = useRef(batchedUpdater);
	batchedUpdaterRef.current = batchedUpdater;

	// setActiveSessionId wrapper — flushes batched updates before switching
	const setActiveSessionIdFromContext = useCallback(
		(id: string) => {
			batchedUpdaterRef.current.flushNow();
			storeSetActiveSessionId(id);
		},
		[storeSetActiveSessionId]
	);

	// Ref-like getters — read current state from store without stale closures
	// Used by 106 callback sites that need current state (e.g., sessionsRef.current)
	const sessionsRef = useMemo(
		() => ({
			get current() {
				return useSessionStore.getState().sessions;
			},
		}),
		[]
	) as React.MutableRefObject<Session[]>;

	const activeSessionIdRef = useMemo(
		() => ({
			get current() {
				return useSessionStore.getState().activeSessionId;
			},
		}),
		[]
	) as React.MutableRefObject<string>;

	// initialLoadComplete — provided by useSessionRestoration hook

	// cyclePositionRef — Proxy bridges ref API to store number
	const cyclePositionRef = useMemo(() => {
		const ref = { current: useSessionStore.getState().cyclePosition };
		return new Proxy(ref, {
			set(_target, prop, value) {
				if (prop === 'current') {
					ref.current = value;
					useSessionStore.getState().setCyclePosition(value);
					return true;
				}
				return false;
			},
			get(target, prop) {
				if (prop === 'current') {
					return useSessionStore.getState().cyclePosition;
				}
				return (target as Record<string | symbol, unknown>)[prop];
			},
		});
	}, []) as React.MutableRefObject<number>;

	// --- UI LAYOUT STATE (from uiStore, replaces UILayoutContext) ---
	// State: individual selectors for granular re-render control
	const leftSidebarOpen = useUIStore((s) => s.leftSidebarOpen);
	const rightPanelOpen = useUIStore((s) => s.rightPanelOpen);
	const activeRightTab = useUIStore((s) => s.activeRightTab);
	const activeFocus = useUIStore((s) => s.activeFocus);
	const bookmarksCollapsed = useUIStore((s) => s.bookmarksCollapsed);
	const groupChatsExpanded = useUIStore((s) => s.groupChatsExpanded);
	const showUnreadOnly = useUIStore((s) => s.showUnreadOnly);
	const fileTreeFilter = useFileExplorerStore((s) => s.fileTreeFilter);
	const fileTreeFilterOpen = useFileExplorerStore((s) => s.fileTreeFilterOpen);
	const editingGroupId = useUIStore((s) => s.editingGroupId);
	const editingSessionId = useUIStore((s) => s.editingSessionId);
	const draggingSessionId = useUIStore((s) => s.draggingSessionId);
	const flashNotification = useUIStore((s) => s.flashNotification);
	const successFlashNotification = useUIStore((s) => s.successFlashNotification);
	const selectedSidebarIndex = useUIStore((s) => s.selectedSidebarIndex);

	// Actions: stable closures created at store init, no hook overhead needed
	const {
		setLeftSidebarOpen,
		setRightPanelOpen,
		setActiveRightTab,
		setActiveFocus,
		setBookmarksCollapsed,
		setEditingGroupId,
		setDraggingSessionId,
		setFlashNotification,
		setSuccessFlashNotification,
		setSelectedSidebarIndex,
	} = useUIStore.getState();

	const { setFileTreeFilterOpen } = useFileExplorerStore.getState();

	// --- GROUP CHAT STATE (now in groupChatStore) ---

	// Reactive reads from groupChatStore (granular subscriptions)
	const groupChats = useGroupChatStore((s) => s.groupChats);
	const activeGroupChatId = useGroupChatStore((s) => s.activeGroupChatId);
	const groupChatMessages = useGroupChatStore((s) => s.groupChatMessages);
	const groupChatState = useGroupChatStore((s) => s.groupChatState);
	const groupChatStagedImages = useGroupChatStore((s) => s.groupChatStagedImages);
	const groupChatReadOnlyMode = useGroupChatStore((s) => s.groupChatReadOnlyMode);
	const groupChatExecutionQueue = useGroupChatStore((s) => s.groupChatExecutionQueue);
	const groupChatRightTab = useGroupChatStore((s) => s.groupChatRightTab);
	const groupChatParticipantColors = useGroupChatStore((s) => s.groupChatParticipantColors);
	const moderatorUsage = useGroupChatStore((s) => s.moderatorUsage);
	const participantStates = useGroupChatStore((s) => s.participantStates);
	const groupChatError = useGroupChatStore((s) => s.groupChatError);

	// Stable actions from groupChatStore (non-reactive)
	const {
		setGroupChats,
		setActiveGroupChatId,
		setGroupChatStagedImages,
		setGroupChatReadOnlyMode,
		setGroupChatRightTab,
		setGroupChatParticipantColors,
	} = useGroupChatStore.getState();

	// --- APP INITIALIZATION (extracted hook, Phase 2G) ---
	const { ghCliAvailable, sshRemoteConfigs, speckitCommands, openspecCommands, saveFileGistUrl } =
		useAppInitialization();

	// Wrapper for setActiveSessionId that also dismisses active group chat
	const setActiveSessionId = useCallback(
		(id: string) => {
			setActiveGroupChatId(null); // Dismiss group chat when selecting an agent
			setActiveSessionIdFromContext(id);
		},
		[setActiveSessionIdFromContext, setActiveGroupChatId]
	);

	// Completion states from InputContext (these change infrequently)
	const {
		slashCommandOpen,
		setSlashCommandOpen,
		selectedSlashCommandIndex,
		setSelectedSlashCommandIndex,
		tabCompletionOpen,
		setTabCompletionOpen,
		selectedTabCompletionIndex,
		setSelectedTabCompletionIndex,
		tabCompletionFilter,
		setTabCompletionFilter,
		atMentionOpen,
		setAtMentionOpen,
		atMentionFilter,
		setAtMentionFilter,
		atMentionStartIndex,
		setAtMentionStartIndex,
		selectedAtMentionIndex,
		setSelectedAtMentionIndex,
		commandHistoryOpen,
		setCommandHistoryOpen,
		commandHistoryFilter,
		setCommandHistoryFilter,
		commandHistorySelectedIndex,
		setCommandHistorySelectedIndex,
	} = useInputContext();

	// File Explorer State (reads from fileExplorerStore)
	const filePreviewLoading = useFileExplorerStore((s) => s.filePreviewLoading);
	const isGraphViewOpen = useFileExplorerStore((s) => s.isGraphViewOpen);
	const graphFocusFilePath = useFileExplorerStore((s) => s.graphFocusFilePath);
	const lastGraphFocusFilePath = useFileExplorerStore((s) => s.lastGraphFocusFilePath);

	const [gistPublishModalOpen, setGistPublishModalOpen] = useState(false);
	// Tab context gist publishing - now backed by tabStore (Zustand)
	const tabGistContent = useTabStore((s) => s.tabGistContent);
	const fileGistUrls = useTabStore((s) => s.fileGistUrls);

	// Note: Delete Agent Modal State is now managed by modalStore (Zustand)
	// See useModalActions() destructuring above for deleteAgentModalOpen / deleteAgentSession

	// Note: Git Diff State, Tour Overlay State, and Git Log Viewer State are from modalStore

	// Note: Renaming state (editingGroupId/editingSessionId) and drag state (draggingSessionId)
	// are now destructured from useUIStore() above

	// Note: All modal states are now managed by modalStore (Zustand)
	// See useModalActions() destructuring above for modal states

	// Note: Modal close/open handlers are now provided by useModalHandlers() hook
	// See the destructured handlers below (handleCloseGitDiff, handleCloseGitLog, etc.)

	// Note: All modal states (confirmation, rename, queue browser, batch runner, etc.)
	// are now managed by modalStore - see useModalActions() destructuring above

	// NOTE: showSessionJumpNumbers state is now provided by useMainKeyboardHandler hook

	// Note: Output search, flash notifications, command history, tab completion, and @ mention
	// states are now destructured from useUIStore() and useInputContext() above

	// Note: Images are now stored per-tab in AITab.stagedImages
	// See stagedImages/setStagedImages computed from active tab below

	// Global Live Mode State (web interface for all sessions)
	const [isLiveMode, setIsLiveMode] = useState(false);
	const [webInterfaceUrl, setWebInterfaceUrl] = useState<string | null>(null);

	// Auto Run document management state (from batchStore)
	// Content is per-session in session.autoRunContent
	const autoRunDocumentList = useBatchStore((s) => s.documentList);
	const autoRunDocumentTree = useBatchStore((s) => s.documentTree);
	const {
		setDocumentList: setAutoRunDocumentList,
		setDocumentTree: setAutoRunDocumentTree,
		setIsLoadingDocuments: setAutoRunIsLoadingDocuments,
		setDocumentTaskCounts: setAutoRunDocumentTaskCounts,
	} = useBatchStore.getState();

	// ProcessMonitor navigation handlers
	const handleProcessMonitorNavigateToSession = useCallback(
		(sessionId: string, tabId?: string) => {
			setActiveSessionId(sessionId);
			if (tabId) {
				// Switch to the specific tab within the session
				setSessions((prev) =>
					prev.map((s) => (s.id === sessionId ? { ...s, activeTabId: tabId } : s))
				);
			}
		},
		[setActiveSessionId, setSessions]
	);

	// Startup effects (splash, GitHub CLI, Windows warning, gist URLs, beta updates,
	// update check, leaderboard sync, SpecKit/OpenSpec loading, SSH configs, stats DB check,
	// notification settings sync, playground debug) — provided by useAppInitialization hook

	// Expose debug helpers to window for console access
	// No dependency array - always keep functions fresh
	(window as any).__maestroDebug = {
		openDebugWizard: () => setDebugWizardModalOpen(true),
		openCommandK: () => setQuickActionOpen(true),
		openWizard: () => openWizardModal(),
		openSettings: () => setSettingsModalOpen(true),
	};

	// Note: Standing ovation and keyboard mastery startup checks are now in useModalHandlers

	// IPC process event listeners are now in useAgentListeners hook (called after useAgentSessionManagement)

	// Group chat event listeners and execution queue are now in useGroupChatHandlers hook
	const logsEndRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const terminalOutputRef = useRef<HTMLDivElement>(null);
	const sidebarContainerRef = useRef<HTMLDivElement>(null);
	const fileTreeContainerRef = useRef<HTMLDivElement>(null);
	const fileTreeFilterInputRef = useRef<HTMLInputElement>(null);
	const fileTreeKeyboardNavRef = useRef(false); // Shared between useInputHandlers and useFileExplorerEffects
	const rightPanelRef = useRef<RightPanelHandle>(null);
	const mainPanelRef = useRef<MainPanelHandle>(null);

	// Refs for accessing latest values in event handlers
	const customAICommandsRef = useRef(customAICommands);
	const speckitCommandsRef = useRef(speckitCommands);
	const openspecCommandsRef = useRef(openspecCommands);
	const fileTabAutoRefreshEnabledRef = useRef(fileTabAutoRefreshEnabled);
	customAICommandsRef.current = customAICommands;
	speckitCommandsRef.current = speckitCommands;
	openspecCommandsRef.current = openspecCommands;
	fileTabAutoRefreshEnabledRef.current = fileTabAutoRefreshEnabled;

	// Note: spawnBackgroundSynopsisRef and spawnAgentWithPromptRef are now provided by useAgentExecution hook
	// Note: addHistoryEntryRef is now provided by useAgentSessionManagement hook
	// Ref for processQueuedMessage - allows batch exit handler to process queued messages
	const processQueuedItemRef = useRef<
		((sessionId: string, item: QueuedItem) => Promise<void>) | null
	>(null);

	// Note: thinkingChunkBufferRef and thinkingChunkRafIdRef moved into useAgentListeners hook
	// Note: pauseBatchOnErrorRef and getBatchStateRef moved into useBatchHandlers hook

	// Expose notifyToast to window for debugging/testing
	useEffect(() => {
		(window as any).__maestroDebug = {
			addToast: (
				type: 'success' | 'info' | 'warning' | 'error',
				title: string,
				message: string
			) => {
				notifyToast({ type, title, message });
			},
			testToast: () => {
				notifyToast({
					type: 'success',
					title: 'Test Notification',
					message: 'This is a test toast notification from the console!',
					group: 'Debug',
					project: 'Test Project',
				});
			},
		};
		return () => {
			delete (window as any).__maestroDebug;
		};
	}, []);

	// Keyboard navigation state
	// Note: selectedSidebarIndex/setSelectedSidebarIndex are destructured from useUIStore() above
	// Note: activeTab is memoized later at line ~3795 - use that for all tab operations

	// Slash command discovery now in useWizardHandlers hook

	// --- SESSION RESTORATION (extracted hook, Phase 2E) ---
	const { initialLoadComplete } = useSessionRestoration();

	// --- TAB HANDLERS (extracted hook) ---
	const {
		activeTab,
		unifiedTabs,
		activeFileTab,
		isResumingSession,
		fileTabBackHistory,
		fileTabForwardHistory,
		fileTabCanGoBack,
		fileTabCanGoForward,
		activeFileTabNavIndex,
		performTabClose,
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
		handleScrollPositionChange,
		handleAtBottomChange,
		handleDeleteLog,
	} = useTabHandlers();

	// --- GROUP CHAT HANDLERS (extracted from App.tsx Phase 2B) ---
	const {
		groupChatInputRef,
		groupChatMessagesRef,
		handleClearGroupChatError,
		groupChatRecoveryActions,
		handleOpenGroupChat,
		handleCloseGroupChat,
		handleCreateGroupChat,
		handleUpdateGroupChat,
		handleArchiveGroupChat,
		deleteGroupChatWithConfirmation,
		handleProcessMonitorNavigateToGroupChat,
		handleOpenModeratorSession,
		handleJumpToGroupChatMessage,
		handleGroupChatRightTabChange,
		handleSendGroupChatMessage,
		handleGroupChatDraftChange,
		handleRemoveGroupChatQueueItem,
		handleReorderGroupChatQueueItems,
		handleNewGroupChat,
		handleEditGroupChat,
		handleOpenRenameGroupChatModal,
		handleOpenDeleteGroupChatModal,
		handleCloseNewGroupChatModal,
		handleCloseDeleteGroupChatModal,
		handleConfirmDeleteGroupChat,
		handleCloseRenameGroupChatModal,
		handleRenameGroupChatFromModal,
		handleCloseEditGroupChatModal,
		handleCloseGroupChatInfo,
	} = useGroupChatHandlers();

	// --- MODAL HANDLERS (open/close, error recovery, lightbox, celebrations) ---
	const {
		errorSession,
		recoveryActions,
		handleCloseGitDiff,
		handleCloseGitLog,
		handleCloseSettings,
		handleCloseDebugPackage,
		handleCloseShortcutsHelp,
		handleCloseAboutModal,
		handleCloseUpdateCheckModal,
		handleCloseProcessMonitor,
		handleCloseLogViewer,
		handleCloseConfirmModal,
		handleCloseDeleteAgentModal,
		handleCloseNewInstanceModal,
		handleCloseEditAgentModal,
		handleCloseRenameSessionModal,
		handleCloseRenameTabModal,
		handleConfirmQuit,
		handleCancelQuit,
		onKeyboardMasteryLevelUp,
		handleKeyboardMasteryCelebrationClose,
		handleStandingOvationClose,
		handleFirstRunCelebrationClose,
		handleOpenLeaderboardRegistration,
		handleOpenLeaderboardRegistrationFromAbout,
		handleCloseLeaderboardRegistration,
		handleSaveLeaderboardRegistration,
		handleLeaderboardOptOut,
		handleCloseAgentErrorModal,
		handleShowAgentErrorModal,
		handleClearAgentError,
		handleOpenQueueBrowser,
		handleOpenTabSearch,
		handleOpenPromptComposer,
		handleOpenFuzzySearch,
		handleOpenCreatePR,
		handleOpenAboutModal,
		handleOpenBatchRunner,
		handleOpenMarketplace,
		handleEditAgent,
		handleOpenCreatePRSession,
		handleStartTour,
		handleSetLightboxImage,
		handleCloseLightbox,
		handleNavigateLightbox,
		handleDeleteLightboxImage,
		handleCloseAutoRunSetup,
		handleCloseBatchRunner,
		handleCloseTabSwitcher,
		handleCloseFileSearch,
		handleClosePromptComposer,
		handleCloseCreatePRModal,
		handleCloseSendToAgent,
		handleCloseQueueBrowser,
		handleCloseRenameGroupModal,
		handleQuickActionsRenameTab,
		handleQuickActionsOpenTabSwitcher,
		handleQuickActionsStartTour,
		handleQuickActionsEditAgent,
		handleQuickActionsOpenMergeSession,
		handleQuickActionsOpenSendToAgent,
		handleQuickActionsOpenCreatePR,
		handleLogViewerShortcutUsed,
	} = useModalHandlers(inputRef, terminalOutputRef);

	const {
		handleOpenWorktreeConfig,
		handleQuickCreateWorktree,
		handleOpenWorktreeConfigSession,
		handleDeleteWorktreeSession,
		handleToggleWorktreeExpanded,
		handleCloseWorktreeConfigModal,
		handleSaveWorktreeConfig,
		handleDisableWorktreeConfig,
		handleCreateWorktreeFromConfig,
		handleCloseCreateWorktreeModal,
		handleCreateWorktree,
		handleCloseDeleteWorktreeModal,
		handleConfirmDeleteWorktree,
		handleConfirmAndDeleteWorktreeOnDisk,
	} = useWorktreeHandlers();

	// --- APP HANDLERS (drag, file, folder operations) ---
	const {
		handleImageDragEnter,
		handleImageDragLeave,
		handleImageDragOver,
		isDraggingImage,
		setIsDraggingImage,
		dragCounterRef,
		handleFileClick,
		updateSessionWorkingDirectory,
		toggleFolder,
		expandAllFolders,
		collapseAllFolders,
	} = useAppHandlers({
		activeSession,
		activeSessionId,
		setSessions,
		setActiveFocus,
		setConfirmModalMessage,
		setConfirmModalOnConfirm,
		setConfirmModalOpen,
		onOpenFileTab: handleOpenFileTab,
	});

	// Use custom colors when custom theme is selected, otherwise use the standard theme
	const theme = useMemo(() => {
		if (activeThemeId === 'custom') {
			return {
				...THEMES.custom,
				colors: customThemeColors,
			};
		}
		return THEMES[activeThemeId];
	}, [activeThemeId, customThemeColors]);

	// Ref for theme (for use in memoized callbacks that need current theme without re-creating)
	const themeRef = useRef(theme);
	themeRef.current = theme;

	// Memoized cwd for git viewers (prevents re-renders from inline computation)
	const gitViewerCwd = useMemo(
		() =>
			activeSession
				? activeSession.inputMode === 'terminal'
					? activeSession.shellCwd || activeSession.cwd
					: activeSession.cwd
				: '',

		[activeSession?.inputMode, activeSession?.shellCwd, activeSession?.cwd]
	);

	// PERF: Memoize sessions for NewInstanceModal validation (only recompute when modal is open)
	// This prevents re-renders of the modal's validation logic on every session state change
	const sessionsForValidation = useMemo(
		() => (newInstanceModalOpen ? sessions : []),
		[newInstanceModalOpen, sessions]
	);

	// PERF: Memoize hasNoAgents check for SettingsModal (only depends on session count)
	const hasNoAgents = useMemo(() => sessions.length === 0, [sessions.length]);

	// Remote integration hook - handles web interface communication
	useRemoteIntegration({
		activeSessionId,
		isLiveMode,
		sessionsRef,
		activeSessionIdRef,
		setSessions,
		setActiveSessionId,
		defaultSaveToHistory,
		defaultShowThinking,
	});

	// Web broadcasting hook - handles external history change notifications
	useWebBroadcasting({
		rightPanelRef,
	});

	// CLI activity monitoring hook - tracks CLI playbook runs and updates session states
	useCliActivityMonitoring({
		setSessions,
	});

	// Note: Quit confirmation effect moved into useBatchHandlers hook

	// Theme styles hook - manages CSS variables and scrollbar fade animations
	useThemeStyles({
		themeColors: theme.colors,
	});

	// Get capabilities for the active session's agent type
	const { hasCapability: hasActiveSessionCapability } = useAgentCapabilities(
		activeSession?.toolType
	);

	// Merge & Transfer handlers (Phase 2.5)
	const {
		mergeState,
		mergeProgress,
		mergeStartTime,
		mergeSourceName,
		mergeTargetName,
		cancelMergeTab,
		transferState,
		transferProgress,
		transferSourceAgent,
		transferTargetAgent,
		handleCloseMergeSession,
		handleMerge,
		handleCancelTransfer,
		handleCompleteTransfer,
		handleSendToAgent,
		handleMergeWith,
		handleOpenSendToAgentModal,
	} = useMergeTransferHandlers({
		sessionsRef,
		activeSessionIdRef,
		setActiveSessionId,
	});

	// Summarize & Continue hook for context compaction (non-blocking, per-tab)
	const {
		summarizeState,
		progress: summarizeProgress,
		result: summarizeResult,
		error: _summarizeError,
		startTime,
		startSummarize,
		cancelTab,
		clearTabState,
		canSummarize,
		minContextUsagePercent,
	} = useSummarizeAndContinue(activeSession ?? null);

	// Handler for starting summarization (non-blocking - UI remains interactive)
	const handleSummarizeAndContinue = useCallback(
		(tabId?: string) => {
			if (!activeSession || activeSession.inputMode !== 'ai') return;

			const targetTabId = tabId || activeSession.activeTabId;
			const targetTab = activeSession.aiTabs.find((t) => t.id === targetTabId);

			if (!targetTab || !canSummarize(activeSession.contextUsage, targetTab.logs)) {
				notifyToast({
					type: 'warning',
					title: 'Cannot Compact',
					message: `Context too small. Need at least ${minContextUsagePercent}% usage, ~2k tokens, or 8+ messages to compact.`,
				});
				return;
			}

			// Store session info for toast navigation
			const sourceSessionId = activeSession.id;
			const sourceSessionName = activeSession.name;

			startSummarize(targetTabId).then((result) => {
				if (result) {
					// Update session with the new tab
					setSessions((prev) =>
						prev.map((s) => (s.id === sourceSessionId ? result.updatedSession : s))
					);

					// Add system log entry to the SOURCE tab's history
					setSessions((prev) =>
						prev.map((s) => {
							if (s.id !== sourceSessionId) return s;
							return {
								...s,
								aiTabs: s.aiTabs.map((tab) =>
									tab.id === targetTabId
										? { ...tab, logs: [...tab.logs, result.systemLogEntry] }
										: tab
								),
							};
						})
					);

					// Show success notification with click-to-navigate
					const reductionPercent = result.systemLogEntry.text.match(/(\d+)%/)?.[1] ?? '0';
					notifyToast({
						type: 'success',
						title: 'Context Compacted',
						message: `Reduced context by ${reductionPercent}%. Click to view the new tab.`,
						sessionId: sourceSessionId,
						tabId: result.newTabId,
						project: sourceSessionName,
					});

					// Clear the summarization state for this tab
					clearTabState(targetTabId);
				}
			});
		},
		[
			activeSession,
			canSummarize,
			minContextUsagePercent,
			startSummarize,
			setSessions,
			clearTabState,
		]
	);

	// Combine custom AI commands with spec-kit and openspec commands for input processing (slash command execution)
	// This ensures speckit and openspec commands are processed the same way as custom commands
	const allCustomCommands = useMemo((): CustomAICommand[] => {
		// Convert speckit commands to CustomAICommand format
		const speckitAsCustom: CustomAICommand[] = speckitCommands.map((cmd) => ({
			id: `speckit-${cmd.id}`,
			command: cmd.command,
			description: cmd.description,
			prompt: cmd.prompt,
			isBuiltIn: true, // Speckit commands are built-in (bundled)
		}));
		// Convert openspec commands to CustomAICommand format
		const openspecAsCustom: CustomAICommand[] = openspecCommands.map((cmd) => ({
			id: `openspec-${cmd.id}`,
			command: cmd.command,
			description: cmd.description,
			prompt: cmd.prompt,
			isBuiltIn: true, // OpenSpec commands are built-in (bundled)
		}));
		return [...customAICommands, ...speckitAsCustom, ...openspecAsCustom];
	}, [customAICommands, speckitCommands, openspecCommands]);

	// Combine built-in slash commands with custom AI commands, spec-kit commands, openspec commands, AND agent-specific commands for autocomplete
	const allSlashCommands = useMemo(() => {
		const customCommandsAsSlash = customAICommands.map((cmd) => ({
			command: cmd.command,
			description: cmd.description,
			aiOnly: true, // Custom AI commands are only available in AI mode
			prompt: cmd.prompt, // Include prompt for execution
		}));
		// Spec Kit commands (bundled from github/spec-kit)
		const speckitCommandsAsSlash = speckitCommands.map((cmd) => ({
			command: cmd.command,
			description: cmd.description,
			aiOnly: true, // Spec-kit commands are only available in AI mode
			prompt: cmd.prompt, // Include prompt for execution
			isSpeckit: true, // Mark as spec-kit command for special handling
		}));
		// OpenSpec commands (bundled from Fission-AI/OpenSpec)
		const openspecCommandsAsSlash = openspecCommands.map((cmd) => ({
			command: cmd.command,
			description: cmd.description,
			aiOnly: true, // OpenSpec commands are only available in AI mode
			prompt: cmd.prompt, // Include prompt for execution
			isOpenspec: true, // Mark as openspec command for special handling
		}));
		// Only include agent-specific commands if the agent supports slash commands
		// This allows built-in and custom commands to be shown for all agents (Codex, OpenCode, etc.)
		const agentCommands = hasActiveSessionCapability('supportsSlashCommands')
			? (activeSession?.agentCommands || []).map((cmd) => ({
					command: cmd.command,
					description: cmd.description,
					aiOnly: true, // Agent commands are only available in AI mode
				}))
			: [];
		// Filter built-in slash commands by agent type (if specified)
		const currentAgentType = activeSession?.toolType;
		const filteredSlashCommands = slashCommands.filter(
			(cmd) => !cmd.agentTypes || (currentAgentType && cmd.agentTypes.includes(currentAgentType))
		);
		return [
			...filteredSlashCommands,
			...customCommandsAsSlash,
			...speckitCommandsAsSlash,
			...openspecCommandsAsSlash,
			...agentCommands,
		];
	}, [
		customAICommands,
		speckitCommands,
		openspecCommands,
		activeSession?.agentCommands,
		activeSession?.toolType,
		hasActiveSessionCapability,
	]);

	const canAttachImages = useMemo(() => {
		if (!activeSession || activeSession.inputMode !== 'ai') return false;
		return isResumingSession
			? hasActiveSessionCapability('supportsImageInputOnResume')
			: hasActiveSessionCapability('supportsImageInput');
	}, [activeSession, isResumingSession, hasActiveSessionCapability]);
	// Session navigation handlers (extracted to useSessionNavigation hook)
	const { handleNavBack, handleNavForward } = useSessionNavigation(sessions, {
		navigateBack,
		navigateForward,
		setActiveSessionId, // Uses the wrapper that also dismisses active group chat
		setSessions,
		cyclePositionRef,
		onNavigateToGroupChat: handleOpenGroupChat,
	});

	// PERF: Memoize thinkingItems at App level to avoid passing full sessions array to children.
	// This prevents InputArea from re-rendering on unrelated session updates (e.g., terminal output).
	// Flat list of (session, tab) pairs — one entry per busy tab across all sessions.
	// This allows the ThinkingStatusPill to show all active work, even when multiple tabs
	// within the same agent are busy in parallel.
	const thinkingItems: ThinkingItem[] = useMemo(() => {
		const items: ThinkingItem[] = [];
		for (const session of sessions) {
			if (session.state !== 'busy' || session.busySource !== 'ai') continue;
			const busyTabs = session.aiTabs?.filter((t) => t.state === 'busy');
			if (busyTabs && busyTabs.length > 0) {
				for (const tab of busyTabs) {
					items.push({ session, tab });
				}
			} else {
				// Legacy: session is busy but no individual tab-level tracking
				items.push({ session, tab: null });
			}
		}
		return items;
	}, [sessions]);

	// addLogToTab/addLogToActiveTab now used directly via store in useWizardHandlers

	// --- AGENT EXECUTION ---
	// Extracted hook for agent spawning and execution operations
	const {
		spawnAgentForSession,
		spawnAgentWithPrompt: _spawnAgentWithPrompt,
		spawnBackgroundSynopsis,
		spawnBackgroundSynopsisRef,
		spawnAgentWithPromptRef: _spawnAgentWithPromptRef,
		showFlashNotification: _showFlashNotification,
		showSuccessFlash,
		cancelPendingSynopsis,
	} = useAgentExecution({
		activeSession,
		sessionsRef,
		setSessions,
		processQueuedItemRef,
		setFlashNotification,
		setSuccessFlashNotification,
	});

	// --- AGENT SESSION MANAGEMENT ---
	// Extracted hook for agent-specific session operations (history, session clear, resume)
	const { addHistoryEntry, addHistoryEntryRef, handleJumpToAgentSession, handleResumeSession } =
		useAgentSessionManagement({
			activeSession,
			setSessions,
			setActiveAgentSessionId,
			setAgentSessionsOpen,
			rightPanelRef,
			defaultSaveToHistory,
			defaultShowThinking,
		});

	// --- DIRECTOR'S NOTES SESSION NAVIGATION ---
	// Handles cross-agent navigation: close modal → switch agent → resume session
	const pendingResumeRef = useRef<{ agentSessionId: string; targetSessionId: string } | null>(null);

	const handleDirectorNotesResumeSession = useCallback(
		(sourceSessionId: string, agentSessionId: string) => {
			// Close the Director's Notes modal
			setDirectorNotesOpen(false);

			// If already on the right agent, resume directly
			if (activeSession?.id === sourceSessionId) {
				handleResumeSession(agentSessionId);
				return;
			}

			// Switch to the target agent and defer resume until activeSession updates
			pendingResumeRef.current = { agentSessionId, targetSessionId: sourceSessionId };
			setActiveSessionId(sourceSessionId);
		},
		[activeSession?.id, handleResumeSession, setActiveSessionId, setDirectorNotesOpen]
	);

	// Effect: process pending resume after agent switch completes
	useEffect(() => {
		if (
			pendingResumeRef.current &&
			activeSession?.id === pendingResumeRef.current.targetSessionId
		) {
			const { agentSessionId } = pendingResumeRef.current;
			pendingResumeRef.current = null;
			handleResumeSession(agentSessionId);
		}
	}, [activeSession?.id, handleResumeSession]);

	// --- BATCH HANDLERS (Auto Run processing, quit confirmation, error handling) ---
	const {
		startBatchRun,
		getBatchState,
		handleStopBatchRun,
		handleKillBatchRun,
		handleSkipCurrentDocument,
		handleResumeAfterError,
		handleAbortBatchOnError,
		activeBatchSessionIds,
		currentSessionBatchState,
		activeBatchRunState,
		pauseBatchOnErrorRef,
		getBatchStateRef,
		handleSyncAutoRunStats,
	} = useBatchHandlers({
		spawnAgentForSession,
		rightPanelRef,
		processQueuedItemRef,
		handleClearAgentError,
	});

	// --- AGENT IPC LISTENERS ---
	// Extracted hook for all window.maestro.process.onXxx listeners
	// (onData, onExit, onSessionId, onSlashCommands, onStderr, onCommandExit,
	// onUsage, onAgentError, onThinkingChunk, onSshRemote, onToolExecution)
	useAgentListeners({
		batchedUpdater,
		addHistoryEntryRef,
		spawnBackgroundSynopsisRef,
		getBatchStateRef,
		pauseBatchOnErrorRef,
		rightPanelRef,
		processQueuedItemRef,
		contextWarningYellowThreshold: contextManagementSettings.contextWarningYellowThreshold,
	});

	const handleRemoveQueuedItem = useCallback((itemId: string) => {
		setSessions((prev) =>
			prev.map((s) => {
				if (s.id !== activeSessionIdRef.current) return s;
				return {
					...s,
					executionQueue: s.executionQueue.filter((item) => item.id !== itemId),
				};
			})
		);
	}, []);

	// toggleBookmark — provided by useSessionCrud hook

	const handleFocusFileInGraph = useFileExplorerStore.getState().focusFileInGraph;
	const handleOpenLastDocumentGraph = useFileExplorerStore.getState().openLastDocumentGraph;

	const handleCopyContext = useCallback((tabId: string) => {
		const currentSession = sessionsRef.current.find((s) => s.id === activeSessionIdRef.current);
		if (!currentSession) return;
		const tab = currentSession.aiTabs.find((t) => t.id === tabId);
		if (!tab || !tab.logs || tab.logs.length === 0) return;

		const text = formatLogsForClipboard(tab.logs);
		navigator.clipboard
			.writeText(text)
			.then(() => {
				notifyToast({
					type: 'success',
					title: 'Context Copied',
					message: 'Conversation copied to clipboard.',
				});
			})
			.catch((err) => {
				console.error('Failed to copy context:', err);
				notifyToast({
					type: 'error',
					title: 'Copy Failed',
					message: 'Failed to copy context to clipboard.',
				});
			});
	}, []);

	// Memoized handler for exporting tab as HTML
	const handleExportHtml = useCallback(async (tabId: string) => {
		const currentSession = sessionsRef.current.find((s) => s.id === activeSessionIdRef.current);
		if (!currentSession) return;
		const tab = currentSession.aiTabs.find((t) => t.id === tabId);
		if (!tab || !tab.logs || tab.logs.length === 0) return;

		try {
			const { downloadTabExport } = await import('./utils/tabExport');
			await downloadTabExport(
				tab,
				{
					name: currentSession.name,
					cwd: currentSession.cwd,
					toolType: currentSession.toolType,
				},
				themeRef.current
			);
			notifyToast({
				type: 'success',
				title: 'Export Complete',
				message: 'Conversation exported as HTML.',
			});
		} catch (err) {
			console.error('Failed to export tab:', err);
			notifyToast({
				type: 'error',
				title: 'Export Failed',
				message: 'Failed to export conversation as HTML.',
			});
		}
	}, []);

	// Memoized handler for publishing tab as GitHub Gist
	const handlePublishTabGist = useCallback((tabId: string) => {
		const currentSession = sessionsRef.current.find((s) => s.id === activeSessionIdRef.current);
		if (!currentSession) return;
		const tab = currentSession.aiTabs.find((t) => t.id === tabId);
		if (!tab || !tab.logs || tab.logs.length === 0) return;

		// Convert logs to markdown-like text format
		const content = formatLogsForClipboard(tab.logs);
		// Generate filename based on tab name or session ID
		const tabName = tab.name || (tab.agentSessionId?.slice(0, 8) ?? 'conversation');
		const filename = `${tabName.replace(/[^a-zA-Z0-9-_]/g, '_')}_context.md`;

		// Set content and open the modal
		useTabStore.getState().setTabGistContent({ filename, content });
		setGistPublishModalOpen(true);
	}, []);

	// Memoized handler for clearing agent error (wraps handleClearAgentError with session/tab context)
	const handleClearAgentErrorForMainPanel = useCallback(() => {
		const currentSession = sessionsRef.current.find((s) => s.id === activeSessionIdRef.current);
		if (!currentSession) return;
		const activeTab = currentSession.aiTabs.find((t) => t.id === currentSession.activeTabId);
		if (!activeTab?.agentError) return;
		handleClearAgentError(currentSession.id, activeTab.id);
	}, [handleClearAgentError]);

	// Note: spawnBackgroundSynopsisRef and spawnAgentWithPromptRef are now updated in useAgentExecution hook

	// Inline wizard context — hook needs the full context, App.tsx retains pass-through refs
	const inlineWizardContext = useInlineWizardContext();
	const {
		clearError: clearInlineWizardError,
		retryLastMessage: retryInlineWizardMessage,
		generateDocuments: generateInlineWizardDocuments,
		endWizard: endInlineWizard,
	} = inlineWizardContext;

	// --- WIZARD HANDLERS (extracted hook) ---
	// Refs for circular deps — set after useInputHandlers/useAutoRunHandlers
	const handleAutoRunRefreshRef = useRef<(() => void) | null>(null);
	const setInputValueRef = useRef<((value: string) => void) | null>(null);

	const {
		sendWizardMessageWithThinking,
		handleHistoryCommand,
		handleSkillsCommand,
		handleWizardCommand,
		handleLaunchWizardTab,
		isWizardActiveForCurrentTab,
		handleWizardComplete,
		handleWizardLetsGo,
		handleToggleWizardShowThinking,
		handleWizardLaunchSession,
	} = useWizardHandlers({
		inlineWizardContext,
		wizardContext: {
			state: wizardState,
			completeWizard,
			clearResumeState,
		},
		spawnBackgroundSynopsis,
		addHistoryEntry,
		startBatchRun,
		handleAutoRunRefreshRef,
		setInputValueRef,
		inputRef,
	});

	// --- INPUT HANDLERS (state, completion, processing, keyboard, paste/drop) ---
	const {
		inputValue,
		deferredInputValue,
		setInputValue,
		stagedImages,
		setStagedImages,
		processInput,
		handleInputKeyDown,
		handleMainPanelInputBlur,
		handleReplayMessage,
		handlePaste,
		handleDrop,
		tabCompletionSuggestions,
		atMentionSuggestions,
	} = useInputHandlers({
		inputRef,
		terminalOutputRef,
		fileTreeKeyboardNavRef,
		dragCounterRef,
		setIsDraggingImage,
		getBatchState,
		activeBatchRunState,
		processQueuedItemRef,
		flushBatchedUpdates: batchedUpdater.flushNow,
		handleHistoryCommand,
		handleWizardCommand,
		sendWizardMessageWithThinking,
		isWizardActiveForCurrentTab,
		handleSkillsCommand,
		allSlashCommands,
		allCustomCommands,
		sessionsRef,
		activeSessionIdRef,
	});

	// This is used by context transfer to automatically send the transferred context to the agent
	useEffect(() => {
		if (!activeSession) return;

		const activeTab = getActiveTab(activeSession);
		if (!activeTab?.autoSendOnActivate) return;

		// Capture intended targets so we can verify they haven't changed after the delay
		const targetSessionId = activeSession.id;
		const targetTabId = activeTab.id;

		// Clear the flag first to prevent multiple sends
		setSessions((prev) =>
			prev.map((s) => {
				if (s.id !== targetSessionId) return s;
				return {
					...s,
					aiTabs: s.aiTabs.map((tab) =>
						tab.id === targetTabId ? { ...tab, autoSendOnActivate: false } : tab
					),
				};
			})
		);

		// Trigger the send after a short delay to ensure state is settled
		// The inputValue and pendingMergedContext are already set on the tab
		const timeoutId = setTimeout(() => {
			// Verify the active session/tab still match the originally intended targets
			const currentSessions = useSessionStore.getState().sessions;
			const currentSession = currentSessions.find((s) => s.id === targetSessionId);
			if (!currentSession) return;
			const currentTab = getActiveTab(currentSession);
			if (currentSession.id !== activeSessionIdRef.current || currentTab?.id !== targetTabId)
				return;

			processInput();
		}, 100);

		return () => clearTimeout(timeoutId);
	}, [activeSession?.id, activeSession?.activeTabId]);

	// Initialize activity tracker for per-session time tracking
	useActivityTracker(activeSessionId, setSessions);

	// Initialize global hands-on time tracker (persists to settings)
	// Tracks total time user spends actively using Maestro (5-minute idle timeout)
	useHandsOnTimeTracker(addTotalActiveTimeMs);

	// Track elapsed time for active auto-runs and update achievement stats every minute
	// This allows badges to be unlocked during an auto-run, not just when it completes
	const autoRunProgressRef = useRef<{ lastUpdateTime: number }>({
		lastUpdateTime: 0,
	});

	useEffect(() => {
		// Only set up timer if there are active batch runs
		if (activeBatchSessionIds.length === 0) {
			autoRunProgressRef.current.lastUpdateTime = 0;
			return;
		}

		// Initialize last update time on first active run
		if (autoRunProgressRef.current.lastUpdateTime === 0) {
			autoRunProgressRef.current.lastUpdateTime = Date.now();
		}

		// Set up interval to update progress every minute
		const intervalId = setInterval(() => {
			const now = Date.now();
			const elapsedMs = now - autoRunProgressRef.current.lastUpdateTime;
			autoRunProgressRef.current.lastUpdateTime = now;

			// Multiply by number of concurrent sessions so each active Auto Run contributes its time
			// e.g., 2 sessions running for 1 minute = 2 minutes toward cumulative achievement time
			const deltaMs = elapsedMs * activeBatchSessionIds.length;

			// Update achievement stats with the delta
			const { newBadgeLevel } = updateAutoRunProgress(deltaMs);

			// If a new badge was unlocked during the run, show standing ovation
			if (newBadgeLevel !== null) {
				const badge = CONDUCTOR_BADGES.find((b) => b.level === newBadgeLevel);
				if (badge) {
					setStandingOvationData({
						badge,
						isNewRecord: false, // Record is determined at completion
						recordTimeMs: autoRunStats.longestRunMs,
					});
				}
			}
		}, 60000); // Every 60 seconds

		return () => {
			clearInterval(intervalId);
		};
	}, [activeBatchSessionIds.length, updateAutoRunProgress, autoRunStats.longestRunMs]);

	// Track peak usage stats for achievements image
	useEffect(() => {
		// Count current active agents (non-terminal sessions)
		const activeAgents = sessions.filter((s) => s.toolType !== 'terminal').length;

		// Count busy sessions (currently processing)
		const busySessions = sessions.filter((s) => s.state === 'busy').length;

		// Count auto-run sessions (sessions with active batch runs)
		const autoRunSessions = activeBatchSessionIds.length;

		// Count total queue depth across all sessions
		const totalQueueDepth = sessions.reduce((sum, s) => sum + (s.executionQueue?.length || 0), 0);

		// Update usage stats (only updates if new values are higher)
		updateUsageStats({
			maxAgents: activeAgents,
			maxDefinedAgents: activeAgents, // Same as active agents for now
			maxSimultaneousAutoRuns: autoRunSessions,
			maxSimultaneousQueries: busySessions,
			maxQueueDepth: totalQueueDepth,
		});
	}, [sessions, activeBatchSessionIds, updateUsageStats]);

	// Handler for switching to autorun tab - shows setup modal if no folder configured
	const handleSetActiveRightTab = useCallback(
		(tab: RightPanelTab) => {
			if (tab === 'autorun' && activeSession && !activeSession.autoRunFolderPath) {
				// No folder configured - show setup modal
				setAutoRunSetupModalOpen(true);
				// Still switch to the tab (it will show an empty state or the modal)
				setActiveRightTab(tab);
			} else {
				setActiveRightTab(tab);
			}
		},
		[activeSession]
	);

	// Auto Run handlers (extracted to useAutoRunHandlers hook)
	const {
		handleAutoRunFolderSelected,
		handleStartBatchRun,
		getDocumentTaskCount,
		handleAutoRunContentChange,
		handleAutoRunModeChange,
		handleAutoRunStateChange,
		handleAutoRunSelectDocument,
		handleAutoRunRefresh,
		handleAutoRunOpenSetup,
		handleAutoRunCreateDocument,
	} = useAutoRunHandlers(activeSession, {
		setSessions,
		setAutoRunDocumentList,
		setAutoRunDocumentTree,
		setAutoRunIsLoadingDocuments,
		setAutoRunSetupModalOpen,
		setBatchRunnerModalOpen,
		setActiveRightTab,
		setRightPanelOpen,
		setActiveFocus,
		setSuccessFlashNotification,
		autoRunDocumentList,
		startBatchRun,
	});

	// Wire up refs for useWizardHandlers (circular dep resolution)
	handleAutoRunRefreshRef.current = handleAutoRunRefresh;
	setInputValueRef.current = setInputValue;

	// Handler for marketplace import completion - refresh document list
	const handleMarketplaceImportComplete = useCallback(
		async (folderName: string) => {
			// Refresh the Auto Run document list to show newly imported documents
			if (activeSession?.autoRunFolderPath) {
				handleAutoRunRefresh();
			}
			notifyToast({
				type: 'success',
				title: 'Playbook Imported',
				message: `Successfully imported playbook to ${folderName}`,
			});
		},
		[activeSession?.autoRunFolderPath, handleAutoRunRefresh]
	);

	// File tree auto-refresh interval change handler (kept in App.tsx as it's not Auto Run specific)
	const handleAutoRefreshChange = useCallback(
		(interval: number) => {
			if (!activeSession) return;
			setSessions((prev) =>
				prev.map((s) =>
					s.id === activeSession.id ? { ...s, fileTreeAutoRefreshInterval: interval } : s
				)
			);
		},
		[activeSession]
	);

	// Handler for toast navigation - switches to session and optionally to a specific tab
	const handleToastSessionClick = useCallback(
		(sessionId: string, tabId?: string) => {
			// Switch to the session
			setActiveSessionId(sessionId);
			// Clear file preview and switch to AI tab (with specific tab if provided)
			// This ensures clicking a toast always shows the AI terminal, not a file preview
			setSessions((prev) =>
				prev.map((s) => {
					if (s.id !== sessionId) return s;
					// If a specific tab ID is provided, check if it exists
					if (tabId && !s.aiTabs?.some((t) => t.id === tabId)) {
						// Tab doesn't exist, just clear file preview
						return { ...s, activeFileTabId: null, inputMode: 'ai' };
					}
					return {
						...s,
						...(tabId && { activeTabId: tabId }),
						activeFileTabId: null,
						inputMode: 'ai',
					};
				})
			);
		},
		[setActiveSessionId]
	);

	// --- SESSION SORTING ---
	// Extracted hook for sorted and visible session lists (ignores leading emojis for alphabetization)
	const { sortedSessions, visibleSessions } = useSortedSessions({
		sessions,
		groups,
		bookmarksCollapsed,
	});

	// --- KEYBOARD NAVIGATION ---
	// Extracted hook for sidebar navigation, panel focus, and related keyboard handlers
	const {
		handleSidebarNavigation,
		handleTabNavigation,
		handleEnterToActivate,
		handleEscapeInMain,
	} = useKeyboardNavigation({
		sortedSessions,
		selectedSidebarIndex,
		setSelectedSidebarIndex,
		activeSessionId,
		setActiveSessionId,
		activeFocus,
		setActiveFocus,
		groups,
		setGroups,
		bookmarksCollapsed,
		setBookmarksCollapsed,
		inputRef,
		terminalOutputRef,
	});

	// --- MAIN KEYBOARD HANDLER ---
	// Extracted hook for main keyboard event listener (empty deps, uses ref pattern)
	const { keyboardHandlerRef, showSessionJumpNumbers } = useMainKeyboardHandler();

	// Persist sessions to electron-store using debounced persistence (reduces disk writes from 100+/sec to <1/sec during streaming)
	// The hook handles: debouncing, flush-on-unmount, flush-on-visibility-change, flush-on-beforeunload
	const { flushNow: flushSessionPersistence } = useDebouncedPersistence(
		sessions,
		initialLoadComplete
	);

	// Session lifecycle operations (rename, delete, star, unread, groups persistence, nav tracking)
	// — provided by useSessionLifecycle hook (Phase 2H)
	const {
		handleSaveEditAgent,
		handleRenameTab,
		performDeleteSession,
		showConfirmation,
		toggleTabStar,
		toggleTabUnread,
		toggleUnreadFilter,
	} = useSessionLifecycle({
		flushSessionPersistence,
		setRemovedWorktreePaths,
		pushNavigation,
	});

	// NOTE: Theme CSS variables and scrollbar fade animations are now handled by useThemeStyles hook
	// NOTE: Main keyboard handler is now provided by useMainKeyboardHandler hook
	// NOTE: Sync selectedSidebarIndex with activeSessionId is now handled by useKeyboardNavigation hook

	// NOTE: File tree scroll restore is now handled by useFileExplorerEffects hook (Phase 2.6)

	// Navigation history tracking — provided by useSessionLifecycle hook (Phase 2H)

	// Helper to count tasks in document content
	const countTasksInContent = useCallback(
		(content: string): { completed: number; total: number } => {
			const completedRegex = /^[\s]*[-*]\s*\[x\]/gim;
			const uncheckedRegex = /^[\s]*[-*]\s*\[\s\]/gim;
			const completedMatches = content.match(completedRegex) || [];
			const uncheckedMatches = content.match(uncheckedRegex) || [];
			const completed = completedMatches.length;
			const total = completed + uncheckedMatches.length;
			return { completed, total };
		},
		[]
	);

	// Load task counts for all documents
	const loadTaskCounts = useCallback(
		async (folderPath: string, documents: string[], sshRemoteId?: string) => {
			const counts = new Map<string, { completed: number; total: number }>();

			// Load content and count tasks for each document in parallel
			await Promise.all(
				documents.map(async (docPath) => {
					try {
						const result = await window.maestro.autorun.readDoc(
							folderPath,
							docPath + '.md',
							sshRemoteId
						);
						if (result.success && result.content) {
							const taskCount = countTasksInContent(result.content);
							if (taskCount.total > 0) {
								counts.set(docPath, taskCount);
							}
						}
					} catch {
						// Ignore errors for individual documents
					}
				})
			);

			return counts;
		},
		[countTasksInContent]
	);

	// Load Auto Run document list and content when session changes
	// Always reload content from disk when switching sessions to ensure fresh data
	useEffect(() => {
		const loadAutoRunData = async () => {
			if (!activeSession?.autoRunFolderPath) {
				setAutoRunDocumentList([]);
				setAutoRunDocumentTree([]);
				setAutoRunDocumentTaskCounts(new Map());
				return;
			}

			// Get SSH remote ID for remote sessions (check both runtime and config values)
			const sshRemoteId =
				activeSession.sshRemoteId || activeSession.sessionSshRemoteConfig?.remoteId || undefined;

			// Load document list
			setAutoRunIsLoadingDocuments(true);
			const listResult = await window.maestro.autorun.listDocs(
				activeSession.autoRunFolderPath,
				sshRemoteId
			);
			if (listResult.success) {
				const files = listResult.files || [];
				setAutoRunDocumentList(files);
				setAutoRunDocumentTree(listResult.tree || []);

				// Load task counts for all documents
				const counts = await loadTaskCounts(activeSession.autoRunFolderPath, files, sshRemoteId);
				setAutoRunDocumentTaskCounts(counts);
			}
			setAutoRunIsLoadingDocuments(false);

			// Always load content from disk when switching sessions
			// This ensures we have fresh data and prevents stale content from showing
			if (activeSession.autoRunSelectedFile) {
				const contentResult = await window.maestro.autorun.readDoc(
					activeSession.autoRunFolderPath,
					activeSession.autoRunSelectedFile + '.md',
					sshRemoteId
				);
				const newContent = contentResult.success ? contentResult.content || '' : '';
				setSessions((prev) =>
					prev.map((s) =>
						s.id === activeSession.id
							? {
									...s,
									autoRunContent: newContent,
									autoRunContentVersion: (s.autoRunContentVersion || 0) + 1,
								}
							: s
					)
				);
			}
		};

		loadAutoRunData();
		// Note: Use primitive values (remoteId) not object refs (sessionSshRemoteConfig) to avoid infinite re-render loops
	}, [
		activeSessionId,
		activeSession?.autoRunFolderPath,
		activeSession?.autoRunSelectedFile,
		activeSession?.sshRemoteId,
		activeSession?.sessionSshRemoteConfig?.remoteId,
		loadTaskCounts,
	]);

	// File watching for Auto Run - watch whenever a folder is configured
	// Updates reflect immediately whether from batch runs, terminal commands, or external editors
	// Note: For SSH remote sessions, file watching via chokidar is not available.
	// The backend returns isRemote: true and the UI should use polling instead.
	useEffect(() => {
		const sessionId = activeSession?.id;
		const folderPath = activeSession?.autoRunFolderPath;
		const selectedFile = activeSession?.autoRunSelectedFile;
		// Get SSH remote ID for remote sessions (check both runtime and config values)
		const sshRemoteId =
			activeSession?.sshRemoteId || activeSession?.sessionSshRemoteConfig?.remoteId || undefined;

		// Only watch if folder is set
		if (!folderPath || !sessionId) return;

		// Start watching the folder (for remote sessions, this returns isRemote: true)
		window.maestro.autorun.watchFolder(folderPath, sshRemoteId);

		// Listen for file change events (only triggered for local sessions)
		const unsubscribe = window.maestro.autorun.onFileChanged(async (data) => {
			// Only respond to changes in the current folder
			if (data.folderPath !== folderPath) return;

			// Reload document list for any change (in case files added/removed)
			const listResult = await window.maestro.autorun.listDocs(folderPath, sshRemoteId);
			if (listResult.success) {
				const files = listResult.files || [];
				setAutoRunDocumentList(files);
				setAutoRunDocumentTree(listResult.tree || []);

				// Reload task counts for all documents
				const counts = await loadTaskCounts(folderPath, files, sshRemoteId);
				setAutoRunDocumentTaskCounts(counts);
			}

			// If we have a selected document and it matches the changed file, reload its content
			// Update in session state (per-session, not global)
			if (selectedFile && data.filename === selectedFile) {
				const contentResult = await window.maestro.autorun.readDoc(
					folderPath,
					selectedFile + '.md',
					sshRemoteId
				);
				if (contentResult.success) {
					// Update content in the specific session that owns this folder
					setSessions((prev) =>
						prev.map((s) =>
							s.id === sessionId
								? {
										...s,
										autoRunContent: contentResult.content || '',
										autoRunContentVersion: (s.autoRunContentVersion || 0) + 1,
									}
								: s
						)
					);
				}
			}
		});

		// Cleanup: stop watching when folder changes or unmount
		return () => {
			window.maestro.autorun.unwatchFolder(folderPath);
			unsubscribe();
		};
		// Note: Use primitive values (remoteId) not object refs (sessionSshRemoteConfig) to avoid infinite re-render loops
	}, [
		activeSession?.id,
		activeSession?.autoRunFolderPath,
		activeSession?.autoRunSelectedFile,
		activeSession?.sshRemoteId,
		activeSession?.sessionSshRemoteConfig?.remoteId,
		loadTaskCounts,
	]);

	// --- ACTIONS ---
	const cycleSession = (dir: 'next' | 'prev') => {
		// Build the visual order of items as they appear in the sidebar.
		// This matches the actual rendering order in SessionList.tsx:
		// 1. Bookmarks section (if open) - sorted alphabetically
		// 2. Groups (sorted alphabetically) - each with sessions sorted alphabetically
		// 3. Ungrouped sessions - sorted alphabetically
		// 4. Group Chats section (if expanded) - sorted alphabetically
		//
		// A bookmarked session visually appears in BOTH the bookmarks section AND its
		// regular location (group or ungrouped). The same session can appear twice in
		// the visual order. We track the current position with cyclePositionRef to
		// allow cycling through duplicate occurrences correctly.

		// Visual order item can be either a session or a group chat
		type VisualOrderItem =
			| { type: 'session'; id: string; name: string }
			| { type: 'groupChat'; id: string; name: string };

		const visualOrder: VisualOrderItem[] = [];

		// Helper to get worktree children for a session
		const getWorktreeChildren = (parentId: string) =>
			sessions
				.filter((s) => s.parentSessionId === parentId)
				.sort((a, b) =>
					compareNamesIgnoringEmojis(a.worktreeBranch || a.name, b.worktreeBranch || b.name)
				);

		// Helper to add session with its worktree children to visual order
		const addSessionWithWorktrees = (session: Session) => {
			// Skip worktree children - they're added with their parent
			if (session.parentSessionId) return;

			visualOrder.push({
				type: 'session' as const,
				id: session.id,
				name: session.name,
			});

			// Add worktree children if expanded
			if (session.worktreesExpanded !== false) {
				const children = getWorktreeChildren(session.id);
				visualOrder.push(
					...children.map((s) => ({
						type: 'session' as const,
						id: s.id,
						name: s.worktreeBranch || s.name,
					}))
				);
			}
		};

		if (leftSidebarOpen) {
			// Bookmarks section (if expanded and has bookmarked sessions)
			if (!bookmarksCollapsed) {
				const bookmarkedSessions = sessions
					.filter((s) => s.bookmarked && !s.parentSessionId)
					.sort((a, b) => compareNamesIgnoringEmojis(a.name, b.name));
				bookmarkedSessions.forEach(addSessionWithWorktrees);
			}

			// Groups (sorted alphabetically), with each group's sessions
			const sortedGroups = [...groups].sort((a, b) => compareNamesIgnoringEmojis(a.name, b.name));
			for (const group of sortedGroups) {
				if (!group.collapsed) {
					const groupSessions = sessions
						.filter((s) => s.groupId === group.id && !s.parentSessionId)
						.sort((a, b) => compareNamesIgnoringEmojis(a.name, b.name));
					groupSessions.forEach(addSessionWithWorktrees);
				}
			}

			// Ungrouped sessions (sorted alphabetically) - only if not collapsed
			if (!settings.ungroupedCollapsed) {
				const ungroupedSessions = sessions
					.filter((s) => !s.groupId && !s.parentSessionId)
					.sort((a, b) => compareNamesIgnoringEmojis(a.name, b.name));
				ungroupedSessions.forEach(addSessionWithWorktrees);
			}

			// Group Chats section (if expanded and has group chats)
			if (groupChatsExpanded && groupChats.length > 0) {
				const sortedGroupChats = [...groupChats].sort((a, b) =>
					a.name.toLowerCase().localeCompare(b.name.toLowerCase())
				);
				visualOrder.push(
					...sortedGroupChats.map((gc) => ({
						type: 'groupChat' as const,
						id: gc.id,
						name: gc.name,
					}))
				);
			}
		} else {
			// Sidebar collapsed: cycle through all sessions in their sorted order
			visualOrder.push(
				...sortedSessions.map((s) => ({
					type: 'session' as const,
					id: s.id,
					name: s.name,
				}))
			);
		}

		if (visualOrder.length === 0) return;

		// Determine what is currently active (session or group chat)
		const currentActiveId = activeGroupChatId || activeSessionId;
		const currentIsGroupChat = activeGroupChatId !== null;

		// Determine current position in visual order
		// If cyclePositionRef is valid and points to our current item, use it
		// Otherwise, find the first occurrence of our current item
		let currentIndex = cyclePositionRef.current;
		if (
			currentIndex < 0 ||
			currentIndex >= visualOrder.length ||
			visualOrder[currentIndex].id !== currentActiveId
		) {
			// Position is invalid or doesn't match current item - find first occurrence
			currentIndex = visualOrder.findIndex(
				(item) =>
					item.id === currentActiveId &&
					(currentIsGroupChat ? item.type === 'groupChat' : item.type === 'session')
			);
		}

		if (currentIndex === -1) {
			// Current item not visible, select first visible item
			cyclePositionRef.current = 0;
			const firstItem = visualOrder[0];
			if (firstItem.type === 'session') {
				setActiveGroupChatId(null);
				setActiveSessionIdInternal(firstItem.id);
			} else {
				// When switching to a group chat via cycling, use handleOpenGroupChat to load messages
				handleOpenGroupChat(firstItem.id);
			}
			return;
		}

		// Move to next/prev in visual order
		let nextIndex;
		if (dir === 'next') {
			nextIndex = currentIndex === visualOrder.length - 1 ? 0 : currentIndex + 1;
		} else {
			nextIndex = currentIndex === 0 ? visualOrder.length - 1 : currentIndex - 1;
		}

		cyclePositionRef.current = nextIndex;
		const nextItem = visualOrder[nextIndex];
		if (nextItem.type === 'session') {
			setActiveGroupChatId(null);
			setActiveSessionIdInternal(nextItem.id);
		} else {
			// When switching to a group chat via cycling, use handleOpenGroupChat to load messages
			handleOpenGroupChat(nextItem.id);
		}
	};

	// showConfirmation, performDeleteSession — provided by useSessionLifecycle hook (Phase 2H)
	// deleteSession, deleteWorktreeGroup — provided by useSessionCrud hook

	// addNewSession, createNewSession — provided by useSessionCrud hook

	// handleWizardLaunchSession now in useWizardHandlers hook

	const toggleInputMode = () => {
		setSessions((prev) =>
			prev.map((s) => {
				if (s.id !== activeSessionId) return s;
				const newMode = s.inputMode === 'ai' ? 'terminal' : 'ai';

				if (newMode === 'terminal') {
					// Switching to terminal mode: save current file tab (if any) and clear it
					useUIStore.getState().setPreTerminalFileTabId(s.activeFileTabId);
					return {
						...s,
						inputMode: newMode,
						activeFileTabId: null,
					};
				} else {
					// Switching to AI mode: restore previous file tab if it still exists
					const savedFileTabId = useUIStore.getState().preTerminalFileTabId;
					const fileTabStillExists =
						savedFileTabId && s.filePreviewTabs?.some((t) => t.id === savedFileTabId);
					useUIStore.getState().setPreTerminalFileTabId(null);
					return {
						...s,
						inputMode: newMode,
						...(fileTabStillExists && { activeFileTabId: savedFileTabId }),
					};
				}
			})
		);
		// Close any open dropdowns when switching modes
		setTabCompletionOpen(false);
		setSlashCommandOpen(false);
	};

	// toggleUnreadFilter, toggleTabStar, toggleTabUnread — provided by useSessionLifecycle hook (Phase 2H)

	// Toggle global live mode (enables web interface for all sessions)
	const toggleGlobalLive = async () => {
		try {
			if (isLiveMode) {
				// Stop tunnel first (if running), then stop web server
				await window.maestro.tunnel.stop();
				await window.maestro.live.disableAll();
				setIsLiveMode(false);
				setWebInterfaceUrl(null);
			} else {
				// Turn on - start the server and get the URL
				const result = await window.maestro.live.startServer();
				if (result.success && result.url) {
					setIsLiveMode(true);
					setWebInterfaceUrl(result.url);
				} else {
					console.error('[toggleGlobalLive] Failed to start server:', result.error);
				}
			}
		} catch (error) {
			console.error('[toggleGlobalLive] Error:', error);
		}
	};

	// Restart web server (used when port settings change while server is running)
	const restartWebServer = async (): Promise<string | null> => {
		if (!isLiveMode) return null;
		try {
			// Stop and restart the server to pick up new port settings
			await window.maestro.live.stopServer();
			const result = await window.maestro.live.startServer();
			if (result.success && result.url) {
				setWebInterfaceUrl(result.url);
				return result.url;
			} else {
				console.error('[restartWebServer] Failed to restart server:', result.error);
				return null;
			}
		} catch (error) {
			console.error('[restartWebServer] Error:', error);
			return null;
		}
	};

	// --- REMOTE HANDLERS (remote command processing, SSH name mapping) ---
	const { handleQuickActionsToggleRemoteControl, sessionSshRemoteNames } = useRemoteHandlers({
		sessionsRef,
		customAICommandsRef,
		speckitCommandsRef,
		openspecCommandsRef,
		toggleGlobalLive,
		isLiveMode,
		sshRemoteConfigs,
	});

	const handleViewGitDiff = async () => {
		if (!activeSession || !activeSession.isGitRepo) return;

		const cwd =
			activeSession.inputMode === 'terminal'
				? activeSession.shellCwd || activeSession.cwd
				: activeSession.cwd;
		const sshRemoteId =
			activeSession.sshRemoteId ||
			(activeSession.sessionSshRemoteConfig?.enabled
				? activeSession.sessionSshRemoteConfig.remoteId
				: undefined) ||
			undefined;
		const diff = await gitService.getDiff(cwd, undefined, sshRemoteId);

		if (diff.diff) {
			setGitDiffPreview(diff.diff);
		}
	};

	// startRenamingSession, finishRenamingSession — provided by useSessionCrud hook

	// handleDragStart, handleDragOver — provided by useSessionCrud hook

	// Note: processInput has been extracted to useInputProcessing hook (see line ~2128)

	// Note: handleRemoteCommand effect extracted to useRemoteHandlers hook (Phase 2K)

	// Listen for tour UI actions to control right panel state
	useEffect(() => {
		const handleTourAction = (event: Event) => {
			const customEvent = event as CustomEvent<{
				type: string;
				value?: string;
			}>;
			const { type, value } = customEvent.detail;

			switch (type) {
				case 'setRightTab':
					if (value === 'files' || value === 'history' || value === 'autorun') {
						setActiveRightTab(value as RightPanelTab);
					}
					break;
				case 'openRightPanel':
					setRightPanelOpen(true);
					break;
				case 'closeRightPanel':
					setRightPanelOpen(false);
					break;
				// hamburger menu actions are handled by SessionList.tsx
				default:
					break;
			}
		};

		window.addEventListener('tour:action', handleTourAction);
		return () => window.removeEventListener('tour:action', handleTourAction);
	}, []);

	// Process a queued item - delegates to agentStore action
	const processQueuedItem = async (sessionId: string, item: QueuedItem) => {
		await useAgentStore.getState().processQueuedItem(sessionId, item, {
			conductorProfile,
			customAICommands: customAICommandsRef.current,
			speckitCommands: speckitCommandsRef.current,
			openspecCommands: openspecCommandsRef.current,
		});
	};

	// Update ref for processQueuedItem so batch exit handler can use it
	processQueuedItemRef.current = processQueuedItem;

	// Process any queued items left over from previous session (after app restart)
	// This ensures queued messages aren't stuck forever when app restarts
	const processedQueuesOnStartup = useRef(false);
	useEffect(() => {
		// Only run once after sessions are loaded
		if (!sessionsLoaded || processedQueuesOnStartup.current) return;
		processedQueuesOnStartup.current = true;

		// Find sessions with queued items that are idle (stuck from previous session)
		const sessionsWithQueuedItems = sessions.filter(
			(s) => s.state === 'idle' && s.executionQueue && s.executionQueue.length > 0
		);

		if (sessionsWithQueuedItems.length > 0) {
			console.log(
				`[App] Found ${sessionsWithQueuedItems.length} session(s) with leftover queued items from previous session`
			);

			// Process the first queued item from each session
			// Delay to ensure all refs and handlers are set up
			const startupTimerId = setTimeout(() => {
				sessionsWithQueuedItems.forEach((session) => {
					const firstItem = session.executionQueue[0];
					console.log(`[App] Processing leftover queued item for session ${session.id}:`, {
						id: firstItem.id,
						tabId: firstItem.tabId,
						queueLength: session.executionQueue.length,
					});

					// Set session to busy and remove item from queue
					setSessions((prev) =>
						prev.map((s) => {
							if (s.id !== session.id) return s;

							const [, ...remainingQueue] = s.executionQueue;
							const targetTab =
								s.aiTabs.find((tab) => tab.id === firstItem.tabId) || getActiveTab(s);

							// Set the target tab to busy
							const updatedAiTabs = s.aiTabs.map((tab) =>
								tab.id === targetTab?.id
									? {
											...tab,
											state: 'busy' as const,
											thinkingStartTime: Date.now(),
										}
									: tab
							);

							return {
								...s,
								state: 'busy' as SessionState,
								busySource: 'ai',
								thinkingStartTime: Date.now(),
								currentCycleTokens: 0,
								currentCycleBytes: 0,
								executionQueue: remainingQueue,
								aiTabs: updatedAiTabs,
							};
						})
					);

					// Process the item
					processQueuedItem(session.id, firstItem).catch((err) => {
						console.error(`[App] Failed to process queued item for session ${session.id}:`, err);
						// Reset session busy state and re-queue the failed item so it isn't lost
						setSessions((prev) =>
							prev.map((s) => {
								if (s.id !== session.id) return s;
								return {
									...s,
									state: 'idle',
									busySource: undefined,
									thinkingStartTime: undefined,
									executionQueue: [firstItem, ...s.executionQueue],
									aiTabs: s.aiTabs.map((tab) =>
										tab.state === 'busy'
											? { ...tab, state: 'idle' as const, thinkingStartTime: undefined }
											: tab
									),
								};
							})
						);
					});
				});
			}, 500); // Small delay to ensure everything is initialized
			return () => clearTimeout(startupTimerId);
		}
	}, [sessionsLoaded, sessions]);

	// handleInterrupt — provided by useInterruptHandler hook
	const { handleInterrupt } = useInterruptHandler({
		sessionsRef,
		cancelPendingSynopsis,
		processQueuedItem,
	});

	// --- FILE TREE MANAGEMENT ---
	// Extracted hook for file tree operations (refresh, git state, filtering)
	const { refreshFileTree, refreshGitFileState, filteredFileTree } = useFileTreeManagement({
		sessions,
		sessionsRef,
		setSessions,
		activeSessionId,
		activeSession,
		rightPanelRef,
		sshRemoteIgnorePatterns: settings.sshRemoteIgnorePatterns,
		sshRemoteHonorGitignore: settings.sshRemoteHonorGitignore,
		localIgnorePatterns: settings.localIgnorePatterns,
		localHonorGitignore: settings.localHonorGitignore,
	});

	// --- FILE EXPLORER EFFECTS ---
	// Extracted hook for file explorer side effects and keyboard navigation (Phase 2.6)
	const { stableFileTree, handleMainPanelFileClick } = useFileExplorerEffects({
		sessionsRef,
		activeSessionIdRef,
		fileTreeContainerRef,
		fileTreeKeyboardNavRef,
		filteredFileTree,
		tabCompletionOpen,
		toggleFolder,
		handleFileClick,
		handleOpenFileTab,
	});

	// --- GROUP MANAGEMENT ---
	// Extracted hook for group CRUD operations (toggle, rename, create, drag-drop)
	const {
		toggleGroup,
		startRenamingGroup,
		finishRenamingGroup,
		createNewGroup,
		handleDropOnGroup,
		handleDropOnUngrouped,
		modalState: groupModalState,
	} = useGroupManagement({
		groups,
		setGroups,
		setSessions,
		draggingSessionId,
		setDraggingSessionId,
		editingGroupId,
		setEditingGroupId,
	});

	// Destructure group modal state for use in JSX
	const { createGroupModalOpen, setCreateGroupModalOpen } = groupModalState;

	// Session CRUD operations (create, delete, rename, bookmark, drag-drop, group-move)
	const {
		addNewSession,
		createNewSession,
		deleteSession,
		deleteWorktreeGroup,
		startRenamingSession,
		finishRenamingSession,
		toggleBookmark,
		handleDragStart,
		handleDragOver,
		handleCreateGroupAndMove,
		handleGroupCreated,
	} = useSessionCrud({
		flushSessionPersistence,
		setRemovedWorktreePaths,
		showConfirmation,
		inputRef,
		setCreateGroupModalOpen,
	});

	// Group Modal Handlers (stable callbacks for AppGroupModals)
	const handleCloseCreateGroupModal = useCallback(() => {
		setCreateGroupModalOpen(false);
	}, [setCreateGroupModalOpen]);

	const handlePRCreated = useCallback(
		async (prDetails: PRDetails) => {
			const session = createPRSession || activeSession;
			notifyToast({
				type: 'success',
				title: 'Pull Request Created',
				message: prDetails.title,
				actionUrl: prDetails.url,
				actionLabel: prDetails.url,
			});
			// Add history entry with PR details
			if (session) {
				await window.maestro.history.add({
					id: generateId(),
					type: 'USER',
					timestamp: Date.now(),
					summary: `Created PR: ${prDetails.title}`,
					fullResponse: [
						`**Pull Request:** [${prDetails.title}](${prDetails.url})`,
						`**Branch:** ${prDetails.sourceBranch} → ${prDetails.targetBranch}`,
						prDetails.description ? `**Description:** ${prDetails.description}` : '',
					]
						.filter(Boolean)
						.join('\n\n'),
					projectPath: session.projectRoot || session.cwd,
					sessionId: session.id,
					sessionName: session.name,
				});
				rightPanelRef.current?.refreshHistoryPanel();
			}
			setCreatePRSession(null);
		},
		[createPRSession, activeSession]
	);

	const handleSaveBatchPrompt = useCallback(
		(prompt: string) => {
			if (!activeSession) return;
			// Save the custom prompt and modification timestamp to the session (persisted across restarts)
			setSessions((prev) =>
				prev.map((s) =>
					s.id === activeSession.id
						? {
								...s,
								batchRunnerPrompt: prompt,
								batchRunnerPromptModifiedAt: Date.now(),
							}
						: s
				)
			);
		},
		[activeSession]
	);
	const handleUtilityTabSelect = useCallback(
		(tabId: string) => {
			if (!activeSession) return;
			// Clear activeFileTabId when selecting an AI tab
			setSessions((prev) =>
				prev.map((s) =>
					s.id === activeSession.id ? { ...s, activeTabId: tabId, activeFileTabId: null } : s
				)
			);
		},
		[activeSession]
	);
	// File tab selection from TabSwitcher - reuse the proper handler which includes auto-refresh
	const handleUtilityFileTabSelect = handleSelectFileTab;
	const handleNamedSessionSelect = useCallback(
		(agentSessionId: string, _projectPath: string, sessionName: string, starred?: boolean) => {
			// Open a closed named session as a new tab - use handleResumeSession to properly load messages
			handleResumeSession(agentSessionId, [], sessionName, starred);
			// Focus input so user can start interacting immediately
			setActiveFocus('main');
			setTimeout(() => inputRef.current?.focus(), 50);
		},
		[handleResumeSession, setActiveFocus]
	);
	const handleFileSearchSelect = useCallback(
		(file: FlatFileItem) => {
			// Preview the file directly (handleFileClick expects relative path)
			if (!file.isFolder) {
				handleFileClick({ name: file.name, type: 'file' }, file.fullPath);
			}
		},
		[handleFileClick]
	);
	const handlePromptComposerSubmit = useCallback(
		(value: string) => {
			if (activeGroupChatId) {
				// Update group chat draft
				setGroupChats((prev) =>
					prev.map((c) => (c.id === activeGroupChatId ? { ...c, draftMessage: value } : c))
				);
			} else {
				setInputValue(value);
			}
		},
		[activeGroupChatId]
	);
	const handlePromptComposerSend = useCallback(
		(value: string) => {
			if (activeGroupChatId) {
				// Send to group chat
				handleSendGroupChatMessage(
					value,
					groupChatStagedImages.length > 0 ? groupChatStagedImages : undefined,
					groupChatReadOnlyMode
				);
				setGroupChatStagedImages([]);
				// Clear draft
				setGroupChats((prev) =>
					prev.map((c) => (c.id === activeGroupChatId ? { ...c, draftMessage: '' } : c))
				);
			} else {
				// Set the input value and trigger send
				setInputValue(value);
				// Use setTimeout to ensure state updates before processing
				setTimeout(() => processInput(value), 0);
			}
		},
		[
			activeGroupChatId,
			groupChatStagedImages,
			groupChatReadOnlyMode,
			handleSendGroupChatMessage,
			processInput,
		]
	);
	const handlePromptToggleTabSaveToHistory = useCallback(() => {
		if (!activeSession) return;
		const activeTab = getActiveTab(activeSession);
		if (!activeTab) return;
		setSessions((prev) =>
			prev.map((s) => {
				if (s.id !== activeSession.id) return s;
				return {
					...s,
					aiTabs: s.aiTabs.map((tab) =>
						tab.id === activeTab.id ? { ...tab, saveToHistory: !tab.saveToHistory } : tab
					),
				};
			})
		);
	}, [activeSession, getActiveTab]);
	const handlePromptToggleTabReadOnlyMode = useCallback(() => {
		if (activeGroupChatId) {
			setGroupChatReadOnlyMode((prev) => !prev);
		} else {
			if (!activeSession) return;
			const activeTab = getActiveTab(activeSession);
			if (!activeTab) return;
			setSessions((prev) =>
				prev.map((s) => {
					if (s.id !== activeSession.id) return s;
					return {
						...s,
						aiTabs: s.aiTabs.map((tab) =>
							tab.id === activeTab.id ? { ...tab, readOnlyMode: !tab.readOnlyMode } : tab
						),
					};
				})
			);
		}
	}, [activeGroupChatId, activeSession, getActiveTab]);
	const handlePromptToggleTabShowThinking = useCallback(() => {
		if (!activeSession) return;
		const activeTab = getActiveTab(activeSession);
		if (!activeTab) return;
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
						if (tab.id !== activeTab.id) return tab;
						const newMode = cycleThinkingMode(tab.showThinking);
						// When turning OFF, clear thinking logs
						if (newMode === 'off') {
							return {
								...tab,
								showThinking: 'off',
								logs: tab.logs.filter((log) => log.source !== 'thinking'),
							};
						}
						return { ...tab, showThinking: newMode };
					}),
				};
			})
		);
	}, [activeSession, getActiveTab]);
	const handlePromptToggleEnterToSend = useCallback(
		() => setEnterToSendAI(!enterToSendAI),
		[enterToSendAI]
	);

	// QuickActionsModal stable callbacks
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
			// Refresh file tree, branches/tags, and history
			await refreshGitFileState(activeSessionId);
			// Also refresh git info in main panel header (branch, ahead/behind, uncommitted)
			await mainPanelRef.current?.refreshGitInfo();
			setSuccessFlashNotification('Files, Git, History Refreshed');
			setTimeout(() => setSuccessFlashNotification(null), 2000);
		}
	}, [activeSessionId, refreshGitFileState, setSuccessFlashNotification]);
	const handleQuickActionsDebugReleaseQueuedItem = useCallback(() => {
		if (!activeSession || activeSession.executionQueue.length === 0) return;
		const [nextItem, ...remainingQueue] = activeSession.executionQueue;
		// Update state to remove item from queue
		setSessions((prev) =>
			prev.map((s) => {
				if (s.id !== activeSessionId) return s;
				return { ...s, executionQueue: remainingQueue };
			})
		);
		// Process the item
		processQueuedItem(activeSessionId, nextItem);
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
	}, [
		activeSession?.activeFileTabId,
		markdownEditMode,
		chatRawTextMode,
		setMarkdownEditMode,
		setChatRawTextMode,
	]);
	const handleQuickActionsSummarizeAndContinue = useCallback(
		() => handleSummarizeAndContinue(),
		[handleSummarizeAndContinue]
	);
	const handleQuickActionsAutoRunResetTasks = useCallback(() => {
		rightPanelRef.current?.openAutoRunResetTasksModal();
	}, []);

	const handleRemoveQueueItem = useCallback((sessionId: string, itemId: string) => {
		setSessions((prev) =>
			prev.map((s) => {
				if (s.id !== sessionId) return s;
				return {
					...s,
					executionQueue: s.executionQueue.filter((item) => item.id !== itemId),
				};
			})
		);
	}, []);
	const handleSwitchQueueSession = useCallback(
		(sessionId: string) => {
			setActiveSessionId(sessionId);
		},
		[setActiveSessionId]
	);
	const handleReorderQueueItems = useCallback(
		(sessionId: string, fromIndex: number, toIndex: number) => {
			setSessions((prev) =>
				prev.map((s) => {
					if (s.id !== sessionId) return s;
					const queue = [...s.executionQueue];
					const [removed] = queue.splice(fromIndex, 1);
					queue.splice(toIndex, 0, removed);
					return { ...s, executionQueue: queue };
				})
			);
		},
		[]
	);

	// Update keyboardHandlerRef synchronously during render (before effects run)
	// This must be placed after all handler functions and state are defined to avoid TDZ errors
	// The ref is provided by useMainKeyboardHandler hook
	keyboardHandlerRef.current = {
		shortcuts,
		activeFocus,
		activeRightTab,
		sessions,
		selectedSidebarIndex,
		activeSessionId,
		quickActionOpen,
		settingsModalOpen,
		shortcutsHelpOpen,
		newInstanceModalOpen,
		aboutModalOpen,
		processMonitorOpen,
		logViewerOpen,
		createGroupModalOpen,
		confirmModalOpen,
		renameInstanceModalOpen,
		renameGroupModalOpen,
		activeSession,
		fileTreeFilter,
		fileTreeFilterOpen,
		gitDiffPreview,
		gitLogOpen,
		lightboxImage,
		hasOpenLayers,
		hasOpenModal,
		visibleSessions,
		sortedSessions,
		groups,
		bookmarksCollapsed,
		leftSidebarOpen,
		editingSessionId,
		editingGroupId,
		markdownEditMode,
		chatRawTextMode,
		defaultSaveToHistory,
		defaultShowThinking,
		setLeftSidebarOpen,
		setRightPanelOpen,
		addNewSession,
		deleteSession,
		setQuickActionInitialMode,
		setQuickActionOpen,
		cycleSession,
		toggleInputMode,
		setShortcutsHelpOpen,
		setSettingsModalOpen,
		setSettingsTab,
		setActiveRightTab,
		handleSetActiveRightTab,
		setActiveFocus,
		setBookmarksCollapsed,
		setGroups,
		setSelectedSidebarIndex,
		setActiveSessionId,
		handleViewGitDiff,
		setGitLogOpen,
		setActiveAgentSessionId,
		setAgentSessionsOpen,
		setLogViewerOpen,
		setProcessMonitorOpen,
		setUsageDashboardOpen,
		logsEndRef,
		inputRef,
		terminalOutputRef,
		sidebarContainerRef,
		setSessions,
		createTab,
		closeTab,
		reopenUnifiedClosedTab,
		getActiveTab,
		setRenameTabId,
		setRenameTabInitialName,
		// Wizard tab close support - for confirmation modal before closing wizard tabs
		hasActiveWizard,
		performTabClose,
		setConfirmModalOpen,
		setConfirmModalMessage,
		setConfirmModalOnConfirm,
		setRenameTabModalOpen,
		navigateToNextTab,
		navigateToPrevTab,
		navigateToTabByIndex,
		navigateToLastTab,
		navigateToUnifiedTabByIndex,
		navigateToLastUnifiedTab,
		navigateToNextUnifiedTab,
		navigateToPrevUnifiedTab,
		setFileTreeFilterOpen,
		isShortcut,
		isTabShortcut,
		handleNavBack,
		handleNavForward,
		toggleUnreadFilter,
		setTabSwitcherOpen,
		showUnreadOnly,
		stagedImages,
		handleSetLightboxImage,
		setMarkdownEditMode,
		setChatRawTextMode,
		toggleTabStar,
		toggleTabUnread,
		setPromptComposerOpen,
		openWizardModal,
		rightPanelRef,
		setFuzzyFileSearchOpen,
		setMarketplaceModalOpen,
		setSymphonyModalOpen,
		setDirectorNotesOpen,
		encoreFeatures,
		setShowNewGroupChatModal,
		deleteGroupChatWithConfirmation,
		// Group chat context
		activeGroupChatId,
		groupChatInputRef,
		groupChatStagedImages,
		setGroupChatRightTab,
		// Navigation handlers from useKeyboardNavigation hook
		handleSidebarNavigation,
		handleTabNavigation,
		handleEnterToActivate,
		handleEscapeInMain,
		// Agent capabilities
		hasActiveSessionCapability,

		// Merge session modal and send to agent modal
		setMergeSessionModalOpen,
		setSendToAgentModalOpen,
		// Summarize and continue (getter: evaluated lazily only when shortcut fires)
		get canSummarizeActiveTab() {
			if (!activeSession || !activeSession.activeTabId) return false;
			const activeTab = activeSession.aiTabs.find((t) => t.id === activeSession.activeTabId);
			return canSummarize(activeSession.contextUsage, activeTab?.logs);
		},
		summarizeAndContinue: handleSummarizeAndContinue,

		// Keyboard mastery gamification
		recordShortcutUsage,
		onKeyboardMasteryLevelUp,

		// Edit agent modal
		setEditAgentSession,
		setEditAgentModalOpen,

		// Auto Run state for keyboard handler
		activeBatchRunState,

		// Bulk tab close handlers
		handleCloseAllTabs,
		handleCloseOtherTabs,
		handleCloseTabsLeft,
		handleCloseTabsRight,

		// Close current tab (Cmd+W) - works with both file and AI tabs
		handleCloseCurrentTab,

		// Session bookmark toggle
		toggleBookmark,

		// Auto-scroll AI mode toggle
		autoScrollAiMode,
		setAutoScrollAiMode,
	};

	// NOTE: File explorer effects (flat file list, pending jump path, scroll, keyboard nav) are
	// now handled by useFileExplorerEffects hook (Phase 2.6)

	// Wizard handlers (handleWizardComplete, handleWizardLetsGo, handleToggleWizardShowThinking)
	// now in useWizardHandlers hook

	// ============================================================================
	// PROPS HOOKS FOR MAJOR COMPONENTS
	// These hooks memoize the props objects for MainPanel, SessionList, and RightPanel
	// to prevent re-evaluating 50-100+ props on every state change.
	// ============================================================================

	// NOTE: stableFileTree is now provided by useFileExplorerEffects hook (Phase 2.6)

	// Bind user's context warning thresholds to getContextColor so the header bar
	// colors match the bottom warning sash thresholds from settings.
	const boundGetContextColor: typeof getContextColor = useCallback(
		(usage, th) =>
			getContextColor(
				usage,
				th,
				contextManagementSettings.contextWarningYellowThreshold,
				contextManagementSettings.contextWarningRedThreshold
			),
		[
			contextManagementSettings.contextWarningYellowThreshold,
			contextManagementSettings.contextWarningRedThreshold,
		]
	);

	const mainPanelProps = useMainPanelProps({
		// Core state
		logViewerOpen,
		agentSessionsOpen,
		activeAgentSessionId,
		activeSession,
		thinkingItems,
		theme,
		isMobileLandscape,
		inputValue,
		stagedImages,
		commandHistoryOpen,
		commandHistoryFilter,
		commandHistorySelectedIndex,
		slashCommandOpen,
		slashCommands: allSlashCommands,
		selectedSlashCommandIndex,
		filePreviewLoading,

		// Tab completion state
		tabCompletionOpen,
		tabCompletionSuggestions,
		selectedTabCompletionIndex,
		tabCompletionFilter,

		// @ mention completion state
		atMentionOpen,
		atMentionFilter,
		atMentionStartIndex,
		atMentionSuggestions,
		selectedAtMentionIndex,

		// Batch run state (convert null to undefined for component props)
		currentSessionBatchState: currentSessionBatchState ?? undefined,

		// File tree
		fileTree: stableFileTree,

		// File preview navigation (per-tab)
		canGoBack: fileTabCanGoBack,
		canGoForward: fileTabCanGoForward,
		backHistory: fileTabBackHistory,
		forwardHistory: fileTabForwardHistory,
		filePreviewHistoryIndex: activeFileTabNavIndex,

		// Active tab for error handling
		activeTab,

		// Worktree
		isWorktreeChild: !!activeSession?.parentSessionId,

		// Summarization progress
		summarizeProgress,
		summarizeResult,
		summarizeStartTime: startTime,
		isSummarizing: summarizeState === 'summarizing',

		// Merge progress
		mergeProgress,
		mergeStartTime,
		isMerging: mergeState === 'merging',
		mergeSourceName,
		mergeTargetName,

		// Gist publishing
		ghCliAvailable,
		hasGist: activeFileTab ? !!fileGistUrls[activeFileTab.path] : false,

		// Setters
		setGitDiffPreview,
		setLogViewerOpen,
		setAgentSessionsOpen,
		setActiveAgentSessionId,
		setInputValue,
		setStagedImages,
		setCommandHistoryOpen,
		setCommandHistoryFilter,
		setCommandHistorySelectedIndex,
		setSlashCommandOpen,
		setSelectedSlashCommandIndex,
		setTabCompletionOpen,
		setSelectedTabCompletionIndex,
		setTabCompletionFilter,
		setAtMentionOpen,
		setAtMentionFilter,
		setAtMentionStartIndex,
		setSelectedAtMentionIndex,
		setGitLogOpen,

		// Refs
		inputRef,
		logsEndRef,
		terminalOutputRef,

		// Handlers
		handleResumeSession,
		handleNewAgentSession,
		toggleInputMode,
		processInput,
		handleInterrupt,
		handleInputKeyDown,
		handlePaste,
		handleDrop,
		getContextColor: boundGetContextColor,
		setActiveSessionId,
		handleStopBatchRun,
		handleDeleteLog,
		handleRemoveQueuedItem,
		handleOpenQueueBrowser,

		// Tab management handlers
		handleTabSelect,
		handleTabClose,
		handleNewTab,
		handleRequestTabRename,
		handleTabReorder,
		handleUnifiedTabReorder,
		handleUpdateTabByClaudeSessionId,
		handleTabStar,
		handleTabMarkUnread,
		handleToggleTabReadOnlyMode,
		handleToggleTabSaveToHistory,
		handleToggleTabShowThinking,
		toggleUnreadFilter,
		handleOpenTabSearch,
		handleCloseAllTabs,
		handleCloseOtherTabs,
		handleCloseTabsLeft,
		handleCloseTabsRight,

		// Unified tab system (Phase 4)
		unifiedTabs,
		activeFileTabId: activeSession?.activeFileTabId ?? null,
		activeFileTab,
		handleFileTabSelect: handleSelectFileTab,
		handleFileTabClose: handleCloseFileTab,
		handleFileTabEditModeChange,
		handleFileTabEditContentChange,
		handleFileTabScrollPositionChange,
		handleFileTabSearchQueryChange,
		handleReloadFileTab,

		handleScrollPositionChange,
		handleAtBottomChange,
		handleMainPanelInputBlur,
		handleOpenPromptComposer,
		handleReplayMessage,
		handleMainPanelFileClick,
		handleNavigateBack: handleFileTabNavigateBack,
		handleNavigateForward: handleFileTabNavigateForward,
		handleNavigateToIndex: handleFileTabNavigateToIndex,
		handleClearFilePreviewHistory,
		handleClearAgentErrorForMainPanel,
		handleShowAgentErrorModal,
		showSuccessFlash,
		handleOpenFuzzySearch,
		handleOpenWorktreeConfig,
		handleOpenCreatePR,
		handleSummarizeAndContinue,
		handleMergeWith,
		handleOpenSendToAgentModal,
		handleCopyContext,
		handleExportHtml,
		handlePublishTabGist,
		cancelTab,
		cancelMergeTab,
		recordShortcutUsage,
		onKeyboardMasteryLevelUp,
		handleSetLightboxImage,

		// Gist publishing
		setGistPublishModalOpen,

		// Document Graph (from fileExplorerStore)
		setGraphFocusFilePath: useFileExplorerStore.getState().focusFileInGraph,
		setLastGraphFocusFilePath: () => {}, // no-op: focusFileInGraph sets both atomically
		setIsGraphViewOpen: useFileExplorerStore.getState().setIsGraphViewOpen,

		// Wizard callbacks
		generateInlineWizardDocuments,
		retryInlineWizardMessage,
		clearInlineWizardError,
		endInlineWizard,
		handleAutoRunRefresh,

		// Complex wizard handlers
		onWizardComplete: handleWizardComplete,
		onWizardLetsGo: handleWizardLetsGo,
		onWizardRetry: retryInlineWizardMessage,
		onWizardClearError: clearInlineWizardError,
		onToggleWizardShowThinking: handleToggleWizardShowThinking,

		// File tree refresh
		refreshFileTree,

		// Open saved file in tab
		onOpenSavedFileInTab: handleOpenFileTab,

		// Helper functions
		getActiveTab,
	});
	const sessionListProps = useSessionListProps({
		// Theme (computed externally from settingsStore + themeId)
		theme,

		// Computed values (not raw store fields)
		sortedSessions,
		isLiveMode,
		webInterfaceUrl,
		showSessionJumpNumbers,
		visibleSessions,

		// Ref
		sidebarContainerRef,

		// Domain handlers
		toggleGlobalLive,
		restartWebServer,
		toggleGroup,
		handleDragStart,
		handleDragOver,
		handleDropOnGroup,
		handleDropOnUngrouped,
		finishRenamingGroup,
		finishRenamingSession,
		startRenamingGroup,
		startRenamingSession,
		showConfirmation,
		createNewGroup,
		handleCreateGroupAndMove,
		addNewSession,
		deleteSession,
		deleteWorktreeGroup,
		handleEditAgent,
		handleOpenCreatePRSession,
		handleQuickCreateWorktree,
		handleOpenWorktreeConfigSession,
		handleDeleteWorktreeSession,
		handleToggleWorktreeExpanded,
		openWizardModal,
		handleStartTour,

		// Group Chat handlers
		handleOpenGroupChat,
		handleNewGroupChat,
		handleEditGroupChat,
		handleOpenRenameGroupChatModal,
		handleOpenDeleteGroupChatModal,
		handleArchiveGroupChat,
	});

	const rightPanelProps = useRightPanelProps({
		// Theme (computed externally from settingsStore + themeId)
		theme,

		// Refs
		fileTreeContainerRef,
		fileTreeFilterInputRef,

		// Tab handler (custom logic: checks autorun folder before switching)
		handleSetActiveRightTab,

		// File explorer handlers
		toggleFolder,
		handleFileClick,
		expandAllFolders,
		collapseAllFolders,
		updateSessionWorkingDirectory,
		refreshFileTree,
		handleAutoRefreshChange,
		showSuccessFlash,

		// Auto Run handlers
		handleAutoRunContentChange,
		handleAutoRunModeChange,
		handleAutoRunStateChange,
		handleAutoRunSelectDocument,
		handleAutoRunCreateDocument,
		handleAutoRunRefresh,
		handleAutoRunOpenSetup,

		// Batch processing (computed by useBatchHandlers, not a raw store field)
		currentSessionBatchState: currentSessionBatchState ?? undefined,
		handleOpenBatchRunner,
		handleStopBatchRun,
		handleKillBatchRun,
		handleSkipCurrentDocument,
		handleAbortBatchOnError,
		handleResumeAfterError,
		handleJumpToAgentSession,
		handleResumeSession,

		// Modal handlers
		handleOpenAboutModal,
		handleOpenMarketplace,
		handleLaunchWizardTab,

		// File linking
		handleMainPanelFileClick,

		// Document Graph handlers
		handleFocusFileInGraph,
		handleOpenLastDocumentGraph,
	});

	return (
		<GitStatusProvider sessions={sessions} activeSessionId={activeSessionId}>
			<div
				className={`flex h-screen w-full font-mono overflow-hidden transition-colors duration-300 ${
					isMobileLandscape || useNativeTitleBar ? 'pt-0' : 'pt-10'
				}`}
				style={{
					backgroundColor: theme.colors.bgMain,
					color: theme.colors.textMain,
					fontFamily: fontFamily,
					fontSize: `${fontSize}px`,
				}}
				onDragEnter={handleImageDragEnter}
				onDragLeave={handleImageDragLeave}
				onDragOver={handleImageDragOver}
				onDrop={handleDrop}
			>
				{/* Image Drop Overlay */}
				{isDraggingImage && (
					<div
						className="fixed inset-0 z-[9999] pointer-events-none flex items-center justify-center"
						style={{ backgroundColor: `${theme.colors.accent}20` }}
					>
						<div
							className="pointer-events-none rounded-xl border-2 border-dashed p-8 flex flex-col items-center gap-4"
							style={{
								borderColor: theme.colors.accent,
								backgroundColor: `${theme.colors.bgMain}ee`,
							}}
						>
							<svg
								className="w-16 h-16"
								style={{ color: theme.colors.accent }}
								fill="none"
								stroke="currentColor"
								viewBox="0 0 24 24"
							>
								<path
									strokeLinecap="round"
									strokeLinejoin="round"
									strokeWidth={2}
									d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
								/>
							</svg>
							<span className="text-lg font-medium" style={{ color: theme.colors.textMain }}>
								Drop image to attach
							</span>
						</div>
					</div>
				)}

				{/* --- DRAGGABLE TITLE BAR (hidden in mobile landscape or when using native title bar) --- */}
				{!isMobileLandscape && !useNativeTitleBar && (
					<div
						className="fixed top-0 left-0 right-0 h-10 flex items-center justify-center"
						style={
							{
								WebkitAppRegion: 'drag',
							} as React.CSSProperties
						}
					>
						{activeGroupChatId ? (
							<span
								className="text-xs select-none opacity-50"
								style={{ color: theme.colors.textDim }}
							>
								Maestro Group Chat:{' '}
								{groupChats.find((c) => c.id === activeGroupChatId)?.name || 'Unknown'}
							</span>
						) : (
							activeSession && (
								<span
									className="text-xs select-none opacity-50"
									style={{ color: theme.colors.textDim }}
								>
									{(() => {
										const parts: string[] = [];
										// Group name (if grouped)
										const group = groups.find((g) => g.id === activeSession.groupId);
										if (group) {
											parts.push(`${group.emoji} ${group.name}`);
										}
										// Agent name (user-given name for this agent instance)
										parts.push(activeSession.name);
										// Active tab name or UUID octet
										const activeTab = activeSession.aiTabs?.find(
											(t) => t.id === activeSession.activeTabId
										);
										if (activeTab) {
											const tabLabel =
												activeTab.name ||
												(activeTab.agentSessionId
													? activeTab.agentSessionId.split('-')[0].toUpperCase()
													: null);
											if (tabLabel) {
												parts.push(tabLabel);
											}
										}
										return parts.join(' | ');
									})()}
								</span>
							)
						)}
					</div>
				)}

				{/* --- UNIFIED MODALS (all modal groups consolidated into AppModals) --- */}
				<AppModals
					// Common props
					theme={theme}
					sessions={sessions}
					setSessions={setSessions}
					activeSessionId={activeSessionId}
					activeSession={activeSession}
					groups={groups}
					setGroups={setGroups}
					groupChats={groupChats}
					shortcuts={shortcuts}
					tabShortcuts={tabShortcuts}
					// AppInfoModals props
					shortcutsHelpOpen={shortcutsHelpOpen}
					onCloseShortcutsHelp={handleCloseShortcutsHelp}
					hasNoAgents={hasNoAgents}
					keyboardMasteryStats={keyboardMasteryStats}
					aboutModalOpen={aboutModalOpen}
					onCloseAboutModal={handleCloseAboutModal}
					autoRunStats={autoRunStats}
					usageStats={usageStats}
					handsOnTimeMs={totalActiveTimeMs}
					onOpenLeaderboardRegistration={handleOpenLeaderboardRegistrationFromAbout}
					isLeaderboardRegistered={isLeaderboardRegistered}
					updateCheckModalOpen={updateCheckModalOpen}
					onCloseUpdateCheckModal={handleCloseUpdateCheckModal}
					processMonitorOpen={processMonitorOpen}
					onCloseProcessMonitor={handleCloseProcessMonitor}
					onNavigateToSession={handleProcessMonitorNavigateToSession}
					onNavigateToGroupChat={handleProcessMonitorNavigateToGroupChat}
					usageDashboardOpen={usageDashboardOpen}
					onCloseUsageDashboard={() => setUsageDashboardOpen(false)}
					defaultStatsTimeRange={defaultStatsTimeRange}
					colorBlindMode={colorBlindMode}
					// AppConfirmModals props
					confirmModalOpen={confirmModalOpen}
					confirmModalMessage={confirmModalMessage}
					confirmModalOnConfirm={confirmModalOnConfirm}
					confirmModalTitle={confirmModalTitle}
					confirmModalDestructive={confirmModalDestructive}
					onCloseConfirmModal={handleCloseConfirmModal}
					quitConfirmModalOpen={quitConfirmModalOpen}
					onConfirmQuit={handleConfirmQuit}
					onCancelQuit={handleCancelQuit}
					activeBatchSessionIds={activeBatchSessionIds}
					// AppSessionModals props
					newInstanceModalOpen={newInstanceModalOpen}
					onCloseNewInstanceModal={handleCloseNewInstanceModal}
					onCreateSession={createNewSession}
					existingSessions={sessionsForValidation}
					duplicatingSessionId={duplicatingSessionId}
					editAgentModalOpen={editAgentModalOpen}
					onCloseEditAgentModal={handleCloseEditAgentModal}
					onSaveEditAgent={handleSaveEditAgent}
					editAgentSession={editAgentSession}
					renameSessionModalOpen={renameInstanceModalOpen}
					renameSessionValue={renameInstanceValue}
					setRenameSessionValue={setRenameInstanceValue}
					onCloseRenameSessionModal={handleCloseRenameSessionModal}
					renameSessionTargetId={renameInstanceSessionId}
					onAfterRename={flushSessionPersistence}
					renameTabModalOpen={renameTabModalOpen}
					renameTabId={renameTabId}
					renameTabInitialName={renameTabInitialName}
					onCloseRenameTabModal={handleCloseRenameTabModal}
					onRenameTab={handleRenameTab}
					// AppGroupModals props
					createGroupModalOpen={createGroupModalOpen}
					onCloseCreateGroupModal={handleCloseCreateGroupModal}
					onGroupCreated={handleGroupCreated}
					renameGroupModalOpen={renameGroupModalOpen}
					renameGroupId={renameGroupId}
					renameGroupValue={renameGroupValue}
					setRenameGroupValue={setRenameGroupValue}
					renameGroupEmoji={renameGroupEmoji}
					setRenameGroupEmoji={setRenameGroupEmoji}
					onCloseRenameGroupModal={handleCloseRenameGroupModal}
					// AppWorktreeModals props
					worktreeConfigModalOpen={worktreeConfigModalOpen}
					onCloseWorktreeConfigModal={handleCloseWorktreeConfigModal}
					onSaveWorktreeConfig={handleSaveWorktreeConfig}
					onCreateWorktreeFromConfig={handleCreateWorktreeFromConfig}
					onDisableWorktreeConfig={handleDisableWorktreeConfig}
					createWorktreeModalOpen={createWorktreeModalOpen}
					createWorktreeSession={createWorktreeSession}
					onCloseCreateWorktreeModal={handleCloseCreateWorktreeModal}
					onCreateWorktree={handleCreateWorktree}
					createPRModalOpen={createPRModalOpen}
					createPRSession={createPRSession}
					onCloseCreatePRModal={handleCloseCreatePRModal}
					onPRCreated={handlePRCreated}
					deleteWorktreeModalOpen={deleteWorktreeModalOpen}
					deleteWorktreeSession={deleteWorktreeSession}
					onCloseDeleteWorktreeModal={handleCloseDeleteWorktreeModal}
					onConfirmDeleteWorktree={handleConfirmDeleteWorktree}
					onConfirmAndDeleteWorktreeOnDisk={handleConfirmAndDeleteWorktreeOnDisk}
					// AppUtilityModals props
					quickActionOpen={quickActionOpen}
					quickActionInitialMode={quickActionInitialMode}
					setQuickActionOpen={setQuickActionOpen}
					setActiveSessionId={setActiveSessionId}
					addNewSession={addNewSession}
					setRenameInstanceValue={setRenameInstanceValue}
					setRenameInstanceModalOpen={setRenameInstanceModalOpen}
					setRenameGroupId={setRenameGroupId}
					setRenameGroupValueForQuickActions={setRenameGroupValue}
					setRenameGroupEmojiForQuickActions={setRenameGroupEmoji}
					setRenameGroupModalOpenForQuickActions={setRenameGroupModalOpen}
					setCreateGroupModalOpenForQuickActions={setCreateGroupModalOpen}
					setLeftSidebarOpen={setLeftSidebarOpen}
					setRightPanelOpen={setRightPanelOpen}
					toggleInputMode={toggleInputMode}
					deleteSession={deleteSession}
					setSettingsModalOpen={setSettingsModalOpen}
					setSettingsTab={setSettingsTab}
					setShortcutsHelpOpen={setShortcutsHelpOpen}
					setAboutModalOpen={setAboutModalOpen}
					setLogViewerOpen={setLogViewerOpen}
					setProcessMonitorOpen={setProcessMonitorOpen}
					setUsageDashboardOpen={setUsageDashboardOpen}
					setActiveRightTab={setActiveRightTab}
					setAgentSessionsOpen={setAgentSessionsOpen}
					setActiveAgentSessionId={setActiveAgentSessionId}
					setGitDiffPreview={setGitDiffPreview}
					setGitLogOpen={setGitLogOpen}
					isAiMode={activeSession?.inputMode === 'ai'}
					onQuickActionsRenameTab={handleQuickActionsRenameTab}
					onQuickActionsToggleReadOnlyMode={handleQuickActionsToggleReadOnlyMode}
					onQuickActionsToggleTabShowThinking={handleQuickActionsToggleTabShowThinking}
					onQuickActionsOpenTabSwitcher={handleQuickActionsOpenTabSwitcher}
					onCloseAllTabs={handleCloseAllTabs}
					onCloseOtherTabs={handleCloseOtherTabs}
					onCloseTabsLeft={handleCloseTabsLeft}
					onCloseTabsRight={handleCloseTabsRight}
					setPlaygroundOpen={setPlaygroundOpen}
					onQuickActionsRefreshGitFileState={handleQuickActionsRefreshGitFileState}
					onQuickActionsDebugReleaseQueuedItem={handleQuickActionsDebugReleaseQueuedItem}
					markdownEditMode={activeSession?.activeFileTabId ? markdownEditMode : chatRawTextMode}
					onQuickActionsToggleMarkdownEditMode={handleQuickActionsToggleMarkdownEditMode}
					setUpdateCheckModalOpenForQuickActions={setUpdateCheckModalOpen}
					openWizard={openWizardModal}
					wizardGoToStep={wizardGoToStep}
					setDebugWizardModalOpen={setDebugWizardModalOpen}
					setDebugPackageModalOpen={setDebugPackageModalOpen}
					startTour={handleQuickActionsStartTour}
					setFuzzyFileSearchOpen={setFuzzyFileSearchOpen}
					onEditAgent={handleQuickActionsEditAgent}
					onNewGroupChat={handleNewGroupChat}
					onOpenGroupChat={handleOpenGroupChat}
					onCloseGroupChat={handleCloseGroupChat}
					onDeleteGroupChat={deleteGroupChatWithConfirmation}
					activeGroupChatId={activeGroupChatId}
					hasActiveSessionCapability={hasActiveSessionCapability}
					onOpenMergeSession={handleQuickActionsOpenMergeSession}
					onOpenSendToAgent={handleQuickActionsOpenSendToAgent}
					onOpenCreatePR={handleQuickActionsOpenCreatePR}
					onSummarizeAndContinue={handleQuickActionsSummarizeAndContinue}
					canSummarizeActiveTab={
						activeSession
							? canSummarize(
									activeSession.contextUsage,
									activeSession.aiTabs.find((t) => t.id === activeSession.activeTabId)?.logs
								)
							: false
					}
					onToggleRemoteControl={handleQuickActionsToggleRemoteControl}
					autoRunSelectedDocument={activeSession?.autoRunSelectedFile ?? null}
					autoRunCompletedTaskCount={rightPanelRef.current?.getAutoRunCompletedTaskCount() ?? 0}
					onAutoRunResetTasks={handleQuickActionsAutoRunResetTasks}
					isFilePreviewOpen={!!activeSession?.activeFileTabId}
					ghCliAvailable={ghCliAvailable}
					onPublishGist={() => setGistPublishModalOpen(true)}
					lastGraphFocusFile={lastGraphFocusFilePath}
					onOpenLastDocumentGraph={handleOpenLastDocumentGraph}
					lightboxImage={lightboxImage}
					lightboxImages={lightboxImages}
					stagedImages={stagedImages}
					onCloseLightbox={handleCloseLightbox}
					onNavigateLightbox={handleNavigateLightbox}
					onDeleteLightboxImage={lightboxAllowDelete ? handleDeleteLightboxImage : undefined}
					gitDiffPreview={gitDiffPreview}
					gitViewerCwd={gitViewerCwd}
					onCloseGitDiff={handleCloseGitDiff}
					gitLogOpen={gitLogOpen}
					onCloseGitLog={handleCloseGitLog}
					autoRunSetupModalOpen={autoRunSetupModalOpen}
					onCloseAutoRunSetup={handleCloseAutoRunSetup}
					onAutoRunFolderSelected={handleAutoRunFolderSelected}
					batchRunnerModalOpen={batchRunnerModalOpen}
					onCloseBatchRunner={handleCloseBatchRunner}
					onStartBatchRun={handleStartBatchRun}
					onSaveBatchPrompt={handleSaveBatchPrompt}
					showConfirmation={showConfirmation}
					autoRunDocumentList={autoRunDocumentList}
					autoRunDocumentTree={autoRunDocumentTree}
					getDocumentTaskCount={getDocumentTaskCount}
					onAutoRunRefresh={handleAutoRunRefresh}
					onOpenMarketplace={handleOpenMarketplace}
					onOpenSymphony={() => setSymphonyModalOpen(true)}
					onOpenDirectorNotes={
						encoreFeatures.directorNotes ? () => setDirectorNotesOpen(true) : undefined
					}
					autoScrollAiMode={autoScrollAiMode}
					setAutoScrollAiMode={setAutoScrollAiMode}
					tabSwitcherOpen={tabSwitcherOpen}
					onCloseTabSwitcher={handleCloseTabSwitcher}
					onTabSelect={handleUtilityTabSelect}
					onFileTabSelect={handleUtilityFileTabSelect}
					onNamedSessionSelect={handleNamedSessionSelect}
					fuzzyFileSearchOpen={fuzzyFileSearchOpen}
					filteredFileTree={filteredFileTree}
					fileExplorerExpanded={activeSession?.fileExplorerExpanded}
					onCloseFileSearch={handleCloseFileSearch}
					onFileSearchSelect={handleFileSearchSelect}
					promptComposerOpen={promptComposerOpen}
					onClosePromptComposer={handleClosePromptComposer}
					promptComposerInitialValue={
						activeGroupChatId
							? groupChats.find((c) => c.id === activeGroupChatId)?.draftMessage || ''
							: deferredInputValue
					}
					onPromptComposerSubmit={handlePromptComposerSubmit}
					onPromptComposerSend={handlePromptComposerSend}
					promptComposerSessionName={
						activeGroupChatId
							? groupChats.find((c) => c.id === activeGroupChatId)?.name
							: activeSession?.name
					}
					promptComposerStagedImages={
						activeGroupChatId ? groupChatStagedImages : canAttachImages ? stagedImages : []
					}
					setPromptComposerStagedImages={
						activeGroupChatId
							? setGroupChatStagedImages
							: canAttachImages
								? setStagedImages
								: undefined
					}
					onPromptOpenLightbox={handleSetLightboxImage}
					promptTabSaveToHistory={activeGroupChatId ? false : (activeTab?.saveToHistory ?? false)}
					onPromptToggleTabSaveToHistory={
						activeGroupChatId ? undefined : handlePromptToggleTabSaveToHistory
					}
					promptTabReadOnlyMode={
						activeGroupChatId ? groupChatReadOnlyMode : (activeTab?.readOnlyMode ?? false)
					}
					onPromptToggleTabReadOnlyMode={handlePromptToggleTabReadOnlyMode}
					promptTabShowThinking={activeGroupChatId ? 'off' : (activeTab?.showThinking ?? 'off')}
					onPromptToggleTabShowThinking={
						activeGroupChatId ? undefined : handlePromptToggleTabShowThinking
					}
					promptSupportsThinking={
						!activeGroupChatId && hasActiveSessionCapability('supportsThinkingDisplay')
					}
					promptEnterToSend={enterToSendAI}
					onPromptToggleEnterToSend={handlePromptToggleEnterToSend}
					queueBrowserOpen={queueBrowserOpen}
					onCloseQueueBrowser={handleCloseQueueBrowser}
					onRemoveQueueItem={handleRemoveQueueItem}
					onSwitchQueueSession={handleSwitchQueueSession}
					onReorderQueueItems={handleReorderQueueItems}
					// AppGroupChatModals props
					showNewGroupChatModal={showNewGroupChatModal}
					onCloseNewGroupChatModal={handleCloseNewGroupChatModal}
					onCreateGroupChat={handleCreateGroupChat}
					showDeleteGroupChatModal={showDeleteGroupChatModal}
					onCloseDeleteGroupChatModal={handleCloseDeleteGroupChatModal}
					onConfirmDeleteGroupChat={handleConfirmDeleteGroupChat}
					showRenameGroupChatModal={showRenameGroupChatModal}
					onCloseRenameGroupChatModal={handleCloseRenameGroupChatModal}
					onRenameGroupChatFromModal={handleRenameGroupChatFromModal}
					showEditGroupChatModal={showEditGroupChatModal}
					onCloseEditGroupChatModal={handleCloseEditGroupChatModal}
					onUpdateGroupChat={handleUpdateGroupChat}
					showGroupChatInfo={showGroupChatInfo}
					groupChatMessages={groupChatMessages}
					onCloseGroupChatInfo={handleCloseGroupChatInfo}
					onOpenModeratorSession={handleOpenModeratorSession}
					// AppAgentModals props
					leaderboardRegistrationOpen={leaderboardRegistrationOpen}
					onCloseLeaderboardRegistration={handleCloseLeaderboardRegistration}
					leaderboardRegistration={leaderboardRegistration}
					onSaveLeaderboardRegistration={handleSaveLeaderboardRegistration}
					onLeaderboardOptOut={handleLeaderboardOptOut}
					onSyncAutoRunStats={handleSyncAutoRunStats}
					errorSession={errorSession}
					recoveryActions={recoveryActions}
					onDismissAgentError={handleCloseAgentErrorModal}
					groupChatError={groupChatError}
					groupChatRecoveryActions={groupChatRecoveryActions}
					onClearGroupChatError={handleClearGroupChatError}
					mergeSessionModalOpen={mergeSessionModalOpen}
					onCloseMergeSession={handleCloseMergeSession}
					onMerge={handleMerge}
					transferState={transferState}
					transferProgress={transferProgress}
					transferSourceAgent={transferSourceAgent}
					transferTargetAgent={transferTargetAgent}
					onCancelTransfer={handleCancelTransfer}
					onCompleteTransfer={handleCompleteTransfer}
					sendToAgentModalOpen={sendToAgentModalOpen}
					onCloseSendToAgent={handleCloseSendToAgent}
					onSendToAgent={handleSendToAgent}
				/>

				{/* --- DEBUG PACKAGE MODAL --- */}
				<DebugPackageModal
					theme={theme}
					isOpen={debugPackageModalOpen}
					onClose={handleCloseDebugPackage}
				/>

				{/* --- WINDOWS WARNING MODAL --- */}
				<WindowsWarningModal
					theme={theme}
					isOpen={windowsWarningModalOpen}
					onClose={() => setWindowsWarningModalOpen(false)}
					onSuppressFuture={setSuppressWindowsWarning}
					onOpenDebugPackage={() => setDebugPackageModalOpen(true)}
					useBetaChannel={enableBetaUpdates}
					onSetUseBetaChannel={setEnableBetaUpdates}
				/>

				{/* --- CELEBRATION OVERLAYS --- */}
				<AppOverlays
					theme={theme}
					standingOvationData={standingOvationData}
					cumulativeTimeMs={autoRunStats.cumulativeTimeMs}
					onCloseStandingOvation={handleStandingOvationClose}
					onOpenLeaderboardRegistration={handleOpenLeaderboardRegistration}
					isLeaderboardRegistered={isLeaderboardRegistered}
					firstRunCelebrationData={firstRunCelebrationData}
					onCloseFirstRun={handleFirstRunCelebrationClose}
					pendingKeyboardMasteryLevel={pendingKeyboardMasteryLevel}
					onCloseKeyboardMastery={handleKeyboardMasteryCelebrationClose}
					shortcuts={shortcuts}
					disableConfetti={disableConfetti}
				/>

				{/* --- DEVELOPER PLAYGROUND --- */}
				{playgroundOpen && (
					<PlaygroundPanel
						theme={theme}
						themeMode={theme.mode}
						onClose={() => setPlaygroundOpen(false)}
					/>
				)}

				{/* --- DEBUG WIZARD MODAL --- */}
				<DebugWizardModal
					theme={theme}
					isOpen={debugWizardModalOpen}
					onClose={() => setDebugWizardModalOpen(false)}
				/>

				{/* --- MARKETPLACE MODAL (lazy-loaded) --- */}
				{activeSession && activeSession.autoRunFolderPath && marketplaceModalOpen && (
					<Suspense fallback={null}>
						<MarketplaceModal
							theme={theme}
							isOpen={marketplaceModalOpen}
							onClose={() => setMarketplaceModalOpen(false)}
							autoRunFolderPath={activeSession.autoRunFolderPath}
							sessionId={activeSession.id}
							sshRemoteId={
								activeSession.sshRemoteId ||
								activeSession.sessionSshRemoteConfig?.remoteId ||
								undefined
							}
							onImportComplete={handleMarketplaceImportComplete}
						/>
					</Suspense>
				)}

				{/* --- SYMPHONY MODAL (lazy-loaded) --- */}
				{symphonyModalOpen && (
					<Suspense fallback={null}>
						<SymphonyModal
							theme={theme}
							isOpen={symphonyModalOpen}
							onClose={() => setSymphonyModalOpen(false)}
							sessions={sessions}
							onSelectSession={(sessionId) => {
								setActiveSessionId(sessionId);
								setSymphonyModalOpen(false);
							}}
							onStartContribution={async (data: SymphonyContributionData) => {
								console.log('[Symphony] Creating session for contribution:', data);

								// Get agent definition
								const agent = await window.maestro.agents.get(data.agentType);
								if (!agent) {
									console.error(`Agent not found: ${data.agentType}`);
									notifyToast({
										type: 'error',
										title: 'Symphony Error',
										message: `Agent not found: ${data.agentType}`,
									});
									return;
								}

								// Validate uniqueness
								const validation = validateNewSession(
									data.sessionName,
									data.localPath,
									data.agentType as ToolType,
									sessions
								);
								if (!validation.valid) {
									console.error(`Session validation failed: ${validation.error}`);
									notifyToast({
										type: 'error',
										title: 'Agent Creation Failed',
										message: validation.error || 'Cannot create duplicate agent',
									});
									return;
								}

								const newId = generateId();
								const initialTabId = generateId();

								// Check git repo status
								const isGitRepo = await gitService.isRepo(data.localPath);
								let gitBranches: string[] | undefined;
								let gitTags: string[] | undefined;
								let gitRefsCacheTime: number | undefined;

								if (isGitRepo) {
									[gitBranches, gitTags] = await Promise.all([
										gitService.getBranches(data.localPath),
										gitService.getTags(data.localPath),
									]);
									gitRefsCacheTime = Date.now();
								}

								// Create initial tab
								const initialTab: AITab = {
									id: initialTabId,
									agentSessionId: null,
									name: null,
									starred: false,
									logs: [],
									inputValue: '',
									stagedImages: [],
									createdAt: Date.now(),
									state: 'idle',
									saveToHistory: defaultSaveToHistory,
								};

								// Create session with Symphony metadata
								const newSession: Session = {
									id: newId,
									name: data.sessionName,
									toolType: data.agentType as ToolType,
									state: 'idle',
									cwd: data.localPath,
									fullPath: data.localPath,
									projectRoot: data.localPath,
									isGitRepo,
									gitBranches,
									gitTags,
									gitRefsCacheTime,
									aiLogs: [],
									shellLogs: [
										{
											id: generateId(),
											timestamp: Date.now(),
											source: 'system',
											text: 'Shell Session Ready.',
										},
									],
									workLog: [],
									contextUsage: 0,
									inputMode: 'ai',
									aiPid: 0,
									terminalPid: 0,
									port: 3000 + Math.floor(Math.random() * 100),
									isLive: false,
									changedFiles: [],
									fileTree: [],
									fileExplorerExpanded: [],
									fileExplorerScrollPos: 0,
									fileTreeAutoRefreshInterval: 180,
									shellCwd: data.localPath,
									aiCommandHistory: [],
									shellCommandHistory: [],
									executionQueue: [],
									activeTimeMs: 0,
									aiTabs: [initialTab],
									activeTabId: initialTabId,
									closedTabHistory: [],
									filePreviewTabs: [],
									activeFileTabId: null,
									unifiedTabOrder: [{ type: 'ai' as const, id: initialTabId }],
									unifiedClosedTabHistory: [],
									// Custom agent config
									customPath: data.customPath,
									customArgs: data.customArgs,
									customEnvVars: data.customEnvVars,
									// Auto Run setup - use autoRunPath from contribution
									autoRunFolderPath: data.autoRunPath,
									// Symphony metadata for tracking
									symphonyMetadata: {
										isSymphonySession: true,
										contributionId: data.contributionId,
										repoSlug: data.repo.slug,
										issueNumber: data.issue.number,
										issueTitle: data.issue.title,
										documentPaths: data.issue.documentPaths.map((d) => d.path),
										status: 'running',
									},
								};

								setSessions((prev) => [...prev, newSession]);
								setActiveSessionId(newId);
								setSymphonyModalOpen(false);

								// Register active contribution in Symphony persistent state
								// This makes it show up in the Active tab of the Symphony modal
								window.maestro.symphony
									.registerActive({
										contributionId: data.contributionId,
										sessionId: newId,
										repoSlug: data.repo.slug,
										repoName: data.repo.name,
										issueNumber: data.issue.number,
										issueTitle: data.issue.title,
										localPath: data.localPath,
										branchName: data.branchName || '',
										totalDocuments: data.issue.documentPaths.length,
										agentType: data.agentType,
										draftPrNumber: data.draftPrNumber,
										draftPrUrl: data.draftPrUrl,
									})
									.catch((err: unknown) => {
										console.error('[Symphony] Failed to register active contribution:', err);
									});

								// Track stats
								window.maestro.stats.recordSessionCreated({
									sessionId: newId,
									agentType: data.agentType,
									projectPath: data.localPath,
									createdAt: Date.now(),
									isRemote: false,
								});

								// Focus input
								setActiveFocus('main');
								setTimeout(() => inputRef.current?.focus(), 50);

								// Switch to Auto Run tab so user sees the documents
								setActiveRightTab('autorun');

								// Auto-start batch run with all contribution documents
								if (data.autoRunPath && data.issue.documentPaths.length > 0) {
									const batchConfig: BatchRunConfig = {
										documents: data.issue.documentPaths.map((doc) => ({
											id: generateId(),
											filename: doc.name.replace(/\.md$/, ''),
											resetOnCompletion: false,
											isDuplicate: false,
										})),
										prompt: DEFAULT_BATCH_PROMPT,
										loopEnabled: false,
									};

									// Small delay to ensure session state is fully propagated
									setTimeout(() => {
										console.log(
											'[Symphony] Auto-starting batch run with',
											batchConfig.documents.length,
											'documents'
										);
										startBatchRun(newId, batchConfig, data.autoRunPath!);
									}, 500);
								}
							}}
						/>
					</Suspense>
				)}

				{/* --- DIRECTOR'S NOTES MODAL (lazy-loaded, Encore Feature) --- */}
				{encoreFeatures.directorNotes && directorNotesOpen && (
					<Suspense fallback={null}>
						<DirectorNotesModal
							theme={theme}
							onClose={() => setDirectorNotesOpen(false)}
							onResumeSession={handleDirectorNotesResumeSession}
							fileTree={activeSession?.fileTree}
							onFileClick={(path: string) =>
								handleFileClick({ name: path.split('/').pop() || path, type: 'file' }, path)
							}
						/>
					</Suspense>
				)}

				{/* --- GIST PUBLISH MODAL --- */}
				{/* Supports both file preview tabs and tab context gist publishing */}
				{gistPublishModalOpen && (activeFileTab || tabGistContent) && (
					<GistPublishModal
						theme={theme}
						filename={
							tabGistContent?.filename ??
							(activeFileTab ? activeFileTab.name + activeFileTab.extension : 'conversation.md')
						}
						content={tabGistContent?.content ?? activeFileTab?.content ?? ''}
						onClose={() => {
							setGistPublishModalOpen(false);
							useTabStore.getState().setTabGistContent(null);
						}}
						onSuccess={(gistUrl, isPublic) => {
							// Save gist URL for the file if it's from file preview tab (not tab context)
							if (activeFileTab && !tabGistContent) {
								saveFileGistUrl(activeFileTab.path, {
									gistUrl,
									isPublic,
									publishedAt: Date.now(),
								});
							}
							// Copy the gist URL to clipboard
							navigator.clipboard.writeText(gistUrl).catch(() => {});
							// Show a toast notification
							notifyToast({
								type: 'success',
								title: 'Gist Published',
								message: `${isPublic ? 'Public' : 'Secret'} gist created! URL copied to clipboard.`,
								duration: 5000,
								actionUrl: gistUrl,
								actionLabel: 'Open Gist',
							});
							// Clear tab gist content after success
							useTabStore.getState().setTabGistContent(null);
						}}
						existingGist={
							activeFileTab && !tabGistContent ? fileGistUrls[activeFileTab.path] : undefined
						}
					/>
				)}

				{/* --- DOCUMENT GRAPH VIEW (Mind Map, lazy-loaded) --- */}
				{/* Only render when a focus file is provided - mind map requires a center document */}
				{graphFocusFilePath && (
					<Suspense fallback={null}>
						<DocumentGraphView
							isOpen={isGraphViewOpen}
							onClose={() => {
								useFileExplorerStore.getState().closeGraphView();
								// Return focus to file preview if it was open
								requestAnimationFrame(() => {
									mainPanelRef.current?.focusFilePreview();
								});
							}}
							theme={theme}
							rootPath={activeSession?.projectRoot || activeSession?.cwd || ''}
							onDocumentOpen={async (filePath) => {
								// Open the document in a file tab (migrated from legacy setPreviewFile overlay)
								const treeRoot = activeSession?.projectRoot || activeSession?.cwd || '';
								const fullPath = `${treeRoot}/${filePath}`;
								const filename = filePath.split('/').pop() || filePath;
								// Note: sshRemoteId is only set after AI agent spawns. For terminal-only SSH sessions,
								// use sessionSshRemoteConfig.remoteId as fallback (see CLAUDE.md SSH Remote Sessions)
								const sshRemoteId =
									activeSession?.sshRemoteId ||
									activeSession?.sessionSshRemoteConfig?.remoteId ||
									undefined;
								try {
									// Fetch content and stat in parallel for efficiency
									const [content, stat] = await Promise.all([
										window.maestro.fs.readFile(fullPath, sshRemoteId),
										window.maestro.fs.stat(fullPath, sshRemoteId).catch(() => null), // stat is optional
									]);
									if (content !== null) {
										const lastModified = stat?.modifiedAt
											? new Date(stat.modifiedAt).getTime()
											: undefined;
										handleOpenFileTab({
											path: fullPath,
											name: filename,
											content,
											sshRemoteId,
											lastModified,
										});
									}
								} catch (error) {
									console.error('[DocumentGraph] Failed to open file:', error);
								}
								useFileExplorerStore.getState().setIsGraphViewOpen(false);
							}}
							onExternalLinkOpen={(url) => {
								// Open external URL in default browser
								window.maestro.shell.openExternal(url);
							}}
							focusFilePath={graphFocusFilePath}
							defaultShowExternalLinks={documentGraphShowExternalLinks}
							onExternalLinksChange={settings.setDocumentGraphShowExternalLinks}
							defaultMaxNodes={documentGraphMaxNodes}
							defaultPreviewCharLimit={documentGraphPreviewCharLimit}
							onPreviewCharLimitChange={settings.setDocumentGraphPreviewCharLimit}
							// Note: sshRemoteId is only set after AI agent spawns. For terminal-only SSH sessions,
							// use sessionSshRemoteConfig.remoteId as fallback (see CLAUDE.md SSH Remote Sessions)
							sshRemoteId={
								activeSession?.sshRemoteId ||
								activeSession?.sessionSshRemoteConfig?.remoteId ||
								undefined
							}
						/>
					</Suspense>
				)}

				{/* NOTE: All modals are now rendered via the unified <AppModals /> component above */}

				{/* Delete Agent Confirmation Modal */}
				{deleteAgentModalOpen && deleteAgentSession && (
					<DeleteAgentConfirmModal
						theme={theme}
						agentName={deleteAgentSession.name}
						workingDirectory={deleteAgentSession.cwd}
						onConfirm={() => performDeleteSession(deleteAgentSession, false)}
						onConfirmAndErase={() => performDeleteSession(deleteAgentSession, true)}
						onClose={handleCloseDeleteAgentModal}
					/>
				)}

				{/* --- EMPTY STATE VIEW (when no sessions) --- */}
				{sessions.length === 0 && !isMobileLandscape ? (
					<EmptyStateView
						theme={theme}
						shortcuts={shortcuts}
						onNewAgent={addNewSession}
						onOpenWizard={openWizardModal}
						onOpenSettings={() => {
							setSettingsModalOpen(true);
							setSettingsTab('general');
						}}
						onOpenShortcutsHelp={() => setShortcutsHelpOpen(true)}
						onOpenAbout={() => setAboutModalOpen(true)}
						onCheckForUpdates={() => setUpdateCheckModalOpen(true)}
						// Don't show tour option when no agents exist - nothing to tour
					/>
				) : null}

				{/* --- LEFT SIDEBAR (hidden in mobile landscape and when no sessions) --- */}
				{!isMobileLandscape && sessions.length > 0 && (
					<ErrorBoundary>
						<SessionList {...sessionListProps} />
					</ErrorBoundary>
				)}

				{/* --- SYSTEM LOG VIEWER (replaces center content when open, lazy-loaded) --- */}
				{logViewerOpen && (
					<div
						className="flex-1 flex flex-col min-w-0"
						style={{ backgroundColor: theme.colors.bgMain }}
					>
						<Suspense fallback={null}>
							<LogViewer
								theme={theme}
								onClose={handleCloseLogViewer}
								logLevel={logLevel}
								savedSelectedLevels={logViewerSelectedLevels}
								onSelectedLevelsChange={setLogViewerSelectedLevels}
								onShortcutUsed={handleLogViewerShortcutUsed}
							/>
						</Suspense>
					</div>
				)}

				{/* --- GROUP CHAT VIEW (shown when a group chat is active, hidden when log viewer open) --- */}
				{!logViewerOpen &&
					activeGroupChatId &&
					groupChats.find((c) => c.id === activeGroupChatId) && (
						<>
							<div className="flex-1 flex flex-col min-w-0">
								<GroupChatPanel
									theme={theme}
									groupChat={groupChats.find((c) => c.id === activeGroupChatId)!}
									messages={groupChatMessages}
									state={groupChatState}
									groups={groups}
									totalCost={(() => {
										const chat = groupChats.find((c) => c.id === activeGroupChatId);
										const participantsCost = (chat?.participants || []).reduce(
											(sum, p) => sum + (p.totalCost || 0),
											0
										);
										const modCost = moderatorUsage?.totalCost || 0;
										return participantsCost + modCost;
									})()}
									costIncomplete={(() => {
										const chat = groupChats.find((c) => c.id === activeGroupChatId);
										const participants = chat?.participants || [];
										// Check if any participant is missing cost data
										const anyParticipantMissingCost = participants.some(
											(p) => p.totalCost === undefined || p.totalCost === null
										);
										// Moderator is also considered - if no usage stats yet, cost is incomplete
										const moderatorMissingCost =
											moderatorUsage?.totalCost === undefined || moderatorUsage?.totalCost === null;
										return anyParticipantMissingCost || moderatorMissingCost;
									})()}
									onSendMessage={handleSendGroupChatMessage}
									onClose={handleCloseGroupChat}
									onRename={() =>
										activeGroupChatId && handleOpenRenameGroupChatModal(activeGroupChatId)
									}
									onShowInfo={() => useModalStore.getState().openModal('groupChatInfo')}
									rightPanelOpen={rightPanelOpen}
									onToggleRightPanel={() => setRightPanelOpen(!rightPanelOpen)}
									shortcuts={shortcuts}
									sessions={sessions}
									onDraftChange={handleGroupChatDraftChange}
									onOpenPromptComposer={() => setPromptComposerOpen(true)}
									stagedImages={groupChatStagedImages}
									setStagedImages={setGroupChatStagedImages}
									readOnlyMode={groupChatReadOnlyMode}
									setReadOnlyMode={setGroupChatReadOnlyMode}
									inputRef={groupChatInputRef}
									handlePaste={handlePaste}
									handleDrop={handleDrop}
									onOpenLightbox={handleSetLightboxImage}
									executionQueue={groupChatExecutionQueue.filter(
										(item) => item.tabId === activeGroupChatId
									)}
									onRemoveQueuedItem={handleRemoveGroupChatQueueItem}
									onReorderQueuedItems={handleReorderGroupChatQueueItems}
									markdownEditMode={chatRawTextMode}
									onToggleMarkdownEditMode={() => setChatRawTextMode(!chatRawTextMode)}
									maxOutputLines={maxOutputLines}
									enterToSendAI={enterToSendAI}
									setEnterToSendAI={setEnterToSendAI}
									showFlashNotification={(message: string) => {
										setSuccessFlashNotification(message);
										setTimeout(() => setSuccessFlashNotification(null), 2000);
									}}
									participantColors={groupChatParticipantColors}
									messagesRef={groupChatMessagesRef}
								/>
							</div>
							<GroupChatRightPanel
								theme={theme}
								groupChatId={activeGroupChatId}
								participants={
									groupChats.find((c) => c.id === activeGroupChatId)?.participants || []
								}
								participantStates={participantStates}
								participantSessionPaths={
									new Map(
										sessions
											.filter((s) =>
												groupChats
													.find((c) => c.id === activeGroupChatId)
													?.participants.some((p) => p.sessionId === s.id)
											)
											.map((s) => [s.id, s.projectRoot])
									)
								}
								sessionSshRemoteNames={sessionSshRemoteNames}
								isOpen={rightPanelOpen}
								onToggle={() => setRightPanelOpen(!rightPanelOpen)}
								width={rightPanelWidth}
								setWidthState={setRightPanelWidth}
								shortcuts={shortcuts}
								moderatorAgentId={
									groupChats.find((c) => c.id === activeGroupChatId)?.moderatorAgentId ||
									'claude-code'
								}
								moderatorSessionId={
									groupChats.find((c) => c.id === activeGroupChatId)?.moderatorSessionId || ''
								}
								moderatorAgentSessionId={
									groupChats.find((c) => c.id === activeGroupChatId)?.moderatorAgentSessionId
								}
								moderatorState={groupChatState === 'moderator-thinking' ? 'busy' : 'idle'}
								moderatorUsage={moderatorUsage}
								activeTab={groupChatRightTab}
								onTabChange={handleGroupChatRightTabChange}
								onJumpToMessage={handleJumpToGroupChatMessage}
								onColorsComputed={setGroupChatParticipantColors}
							/>
						</>
					)}

				{/* --- CENTER WORKSPACE (hidden when no sessions, group chat is active, or log viewer is open) --- */}
				{sessions.length > 0 && !activeGroupChatId && !logViewerOpen && (
					<MainPanel ref={mainPanelRef} {...mainPanelProps} />
				)}

				{/* --- RIGHT PANEL (hidden in mobile landscape, when no sessions, group chat is active, or log viewer is open) --- */}
				{!isMobileLandscape && sessions.length > 0 && !activeGroupChatId && !logViewerOpen && (
					<ErrorBoundary>
						<RightPanel ref={rightPanelRef} {...rightPanelProps} />
					</ErrorBoundary>
				)}

				{/* Old settings modal removed - using new SettingsModal component below */}
				{/* NOTE: NewInstanceModal and EditAgentModal are now rendered via AppSessionModals */}

				{/* --- SETTINGS MODAL (Lazy-loaded for performance) --- */}
				{settingsModalOpen && (
					<Suspense fallback={null}>
						<SettingsModal
							isOpen={settingsModalOpen}
							onClose={handleCloseSettings}
							theme={theme}
							themes={THEMES}
							activeThemeId={activeThemeId}
							setActiveThemeId={setActiveThemeId}
							customThemeColors={customThemeColors}
							setCustomThemeColors={setCustomThemeColors}
							customThemeBaseId={customThemeBaseId}
							setCustomThemeBaseId={setCustomThemeBaseId}
							llmProvider={llmProvider}
							setLlmProvider={setLlmProvider}
							modelSlug={modelSlug}
							setModelSlug={setModelSlug}
							apiKey={apiKey}
							setApiKey={setApiKey}
							shortcuts={shortcuts}
							setShortcuts={setShortcuts}
							tabShortcuts={tabShortcuts}
							setTabShortcuts={setTabShortcuts}
							defaultShell={defaultShell}
							setDefaultShell={setDefaultShell}
							customShellPath={customShellPath}
							setCustomShellPath={setCustomShellPath}
							shellArgs={shellArgs}
							setShellArgs={setShellArgs}
							shellEnvVars={shellEnvVars}
							setShellEnvVars={setShellEnvVars}
							ghPath={ghPath}
							setGhPath={setGhPath}
							enterToSendAI={enterToSendAI}
							setEnterToSendAI={setEnterToSendAI}
							enterToSendTerminal={enterToSendTerminal}
							setEnterToSendTerminal={setEnterToSendTerminal}
							defaultSaveToHistory={defaultSaveToHistory}
							setDefaultSaveToHistory={setDefaultSaveToHistory}
							defaultShowThinking={defaultShowThinking}
							setDefaultShowThinking={setDefaultShowThinking}
							fontFamily={fontFamily}
							setFontFamily={setFontFamily}
							fontSize={fontSize}
							setFontSize={setFontSize}
							terminalWidth={terminalWidth}
							setTerminalWidth={setTerminalWidth}
							logLevel={logLevel}
							setLogLevel={setLogLevel}
							maxLogBuffer={maxLogBuffer}
							setMaxLogBuffer={setMaxLogBuffer}
							maxOutputLines={maxOutputLines}
							setMaxOutputLines={setMaxOutputLines}
							osNotificationsEnabled={osNotificationsEnabled}
							setOsNotificationsEnabled={setOsNotificationsEnabled}
							audioFeedbackEnabled={audioFeedbackEnabled}
							setAudioFeedbackEnabled={setAudioFeedbackEnabled}
							audioFeedbackCommand={audioFeedbackCommand}
							setAudioFeedbackCommand={setAudioFeedbackCommand}
							toastDuration={toastDuration}
							setToastDuration={setToastDuration}
							checkForUpdatesOnStartup={checkForUpdatesOnStartup}
							setCheckForUpdatesOnStartup={setCheckForUpdatesOnStartup}
							enableBetaUpdates={enableBetaUpdates}
							setEnableBetaUpdates={setEnableBetaUpdates}
							crashReportingEnabled={crashReportingEnabled}
							setCrashReportingEnabled={setCrashReportingEnabled}
							customAICommands={customAICommands}
							setCustomAICommands={setCustomAICommands}
							autoScrollAiMode={autoScrollAiMode}
							setAutoScrollAiMode={setAutoScrollAiMode}
							userMessageAlignment={userMessageAlignment}
							setUserMessageAlignment={setUserMessageAlignment}
							encoreFeatures={encoreFeatures}
							setEncoreFeatures={setEncoreFeatures}
							initialTab={settingsTab}
							hasNoAgents={hasNoAgents}
							onThemeImportError={(msg) => setFlashNotification(msg)}
							onThemeImportSuccess={(msg) => setFlashNotification(msg)}
						/>
					</Suspense>
				)}

				{/* --- WIZARD RESUME MODAL (asks if user wants to resume incomplete wizard) --- */}
				{wizardResumeModalOpen && wizardResumeState && (
					<WizardResumeModal
						theme={theme}
						resumeState={wizardResumeState}
						onResume={(options?: { directoryInvalid?: boolean; agentInvalid?: boolean }) => {
							// Close the resume modal
							setWizardResumeModalOpen(false);

							const { directoryInvalid = false, agentInvalid = false } = options || {};

							// If agent is invalid, redirect to agent selection step with error
							// This takes priority since it's the first step
							if (agentInvalid) {
								const modifiedState = {
									...wizardResumeState,
									currentStep: 'agent-selection' as const,
									// Clear the agent selection so user must select a new one
									selectedAgent: null,
									// Keep other state for resume after agent selection
								};
								restoreWizardState(modifiedState);
							} else if (directoryInvalid) {
								// If directory is invalid, redirect to directory selection step with error
								const modifiedState = {
									...wizardResumeState,
									currentStep: 'directory-selection' as const,
									directoryError:
										'The previously selected directory no longer exists. Please choose a new location.',
									// Clear the directory path so user must select a new one
									directoryPath: '',
									isGitRepo: false,
								};
								restoreWizardState(modifiedState);
							} else {
								// Restore the saved wizard state as-is
								restoreWizardState(wizardResumeState);
							}

							// Open the wizard at the restored step
							openWizardModal();
							// Clear the resume state holder
							setWizardResumeState(null);
						}}
						onStartFresh={() => {
							// Close the resume modal
							setWizardResumeModalOpen(false);
							// Clear any saved resume state
							clearResumeState();
							// Open a fresh wizard
							openWizardModal();
							// Clear the resume state holder
							setWizardResumeState(null);
						}}
						onClose={() => {
							// Just close the modal without doing anything
							// The user can open the wizard manually later if they want
							setWizardResumeModalOpen(false);
							setWizardResumeState(null);
						}}
					/>
				)}

				{/* --- MAESTRO WIZARD (onboarding wizard for new users) --- */}
				{/* PERF: Only mount wizard component when open to avoid running hooks/effects */}
				{wizardState.isOpen && (
					<MaestroWizard
						theme={theme}
						onLaunchSession={handleWizardLaunchSession}
						onWizardStart={recordWizardStart}
						onWizardResume={recordWizardResume}
						onWizardAbandon={recordWizardAbandon}
						onWizardComplete={recordWizardComplete}
					/>
				)}

				{/* --- TOUR OVERLAY (onboarding tour for interface guidance) --- */}
				{/* PERF: Only mount tour component when open to avoid running hooks/effects */}
				{tourOpen && (
					<TourOverlay
						theme={theme}
						isOpen={tourOpen}
						fromWizard={tourFromWizard}
						shortcuts={{ ...shortcuts, ...tabShortcuts }}
						onClose={() => {
							setTourOpen(false);
							setTourCompleted(true);
						}}
						onTourStart={recordTourStart}
						onTourComplete={recordTourComplete}
						onTourSkip={recordTourSkip}
					/>
				)}

				{/* --- FLASH NOTIFICATION (centered, auto-dismiss) --- */}
				{flashNotification && (
					<div
						className="fixed top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 px-6 py-4 rounded-lg shadow-2xl text-base font-bold animate-in fade-in zoom-in-95 duration-200 z-[9999]"
						style={{
							backgroundColor: theme.colors.warning,
							color: '#000000',
							textShadow: '0 1px 2px rgba(255, 255, 255, 0.3)',
						}}
					>
						{flashNotification}
					</div>
				)}

				{/* --- SUCCESS FLASH NOTIFICATION (centered, auto-dismiss) --- */}
				{successFlashNotification && (
					<div
						className="fixed top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 px-6 py-4 rounded-lg shadow-2xl text-base font-bold animate-in fade-in zoom-in-95 duration-200 z-[9999]"
						style={{
							backgroundColor: theme.colors.accent,
							color: theme.colors.accentForeground,
							textShadow: '0 1px 2px rgba(0, 0, 0, 0.3)',
						}}
					>
						{successFlashNotification}
					</div>
				)}

				{/* --- TOAST NOTIFICATIONS --- */}
				<ToastContainer theme={theme} onSessionClick={handleToastSessionClick} />
			</div>
		</GitStatusProvider>
	);
}

/**
 * MaestroConsole - Main application component with context providers
 *
 * Wraps MaestroConsoleInner with context providers for centralized state management.
 * Phase 3: InputProvider - centralized input state management
 * Phase 4: Group chat state now lives in groupChatStore (Zustand) — no context wrapper needed
 * Phase 5: Auto Run state now lives in batchStore (Zustand) — no context wrapper needed
 * Phase 6: Session state now lives in sessionStore (Zustand) — no context wrapper needed
 * Phase 7: InlineWizardProvider - inline /wizard command state management
 */
export default function MaestroConsole() {
	return (
		<InlineWizardProvider>
			<InputProvider>
				<MaestroConsoleInner />
			</InputProvider>
		</InlineWizardProvider>
	);
}
