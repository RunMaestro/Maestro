import React, {
	useState,
	useEffect,
	useRef,
	useMemo,
	useCallback,
	useDeferredValue,
	lazy,
	Suspense,
} from 'react';
// SettingsModal is lazy-loaded for performance (large component, only loaded when settings opened)
const SettingsModal = lazy(() =>
	import('./components/SettingsModal').then((m) => ({ default: m.SettingsModal }))
);
import { SessionList } from './components/SessionList';
import { RightPanel, RightPanelHandle } from './components/RightPanel';
import { slashCommands } from './slashCommands';
import {
	AppModals,
	type PRDetails,
	type FlatFileItem,
	type MergeOptions,
	type SendToAgentOptions,
} from './components/AppModals';
import { DEFAULT_BATCH_PROMPT } from './components/BatchRunnerModal';
import { ErrorBoundary } from './components/ErrorBoundary';
import { MainPanel, type MainPanelHandle } from './components/MainPanel';
import { AppOverlays } from './components/AppOverlays';
import { PlaygroundPanel } from './components/PlaygroundPanel';
import { DebugWizardModal } from './components/DebugWizardModal';
import { DebugPackageModal } from './components/DebugPackageModal';
import { WindowsWarningModal } from './components/WindowsWarningModal';
import { GistPublishModal } from './components/GistPublishModal';
import {
	MaestroWizard,
	useWizard,
	WizardResumeModal,
	AUTO_RUN_FOLDER_NAME,
} from './components/Wizard';
import { TourOverlay } from './components/Wizard/tour';
import { CONDUCTOR_BADGES, getBadgeForTime } from './constants/conductorBadges';
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
	useBatchProcessor,
	useBatchedSessionUpdates,
	type PreviousUIState,
	// Settings
	useSettings,
	useDebouncedPersistence,
	useDebouncedValue,
	// Session management
	useActivityTracker,
	useHandsOnTimeTracker,
	useNavigationHistory,
	useSessionNavigation,
	useSortedSessions,
	compareNamesIgnoringEmojis,
	useGroupManagement,
	// Input processing
	useInputSync,
	useTabCompletion,
	useAtMentionCompletion,
	useInputProcessing,
	// Keyboard handling
	useKeyboardShortcutHelpers,
	useKeyboardNavigation,
	useMainKeyboardHandler,
	// Agent
	useAgentSessionManagement,
	useAgentExecution,
	useAgentCapabilities,
	useMergeSessionWithSessions,
	useSendToAgentWithSessions,
	useSummarizeAndContinue,
	// Git
	useFileTreeManagement,
	// Remote
	useRemoteIntegration,
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
	useInputKeyDown,
	// App initialization effects
	useAppInitialization,
} from './hooks';
import type { TabCompletionSuggestion } from './hooks';
import { useMainPanelProps, useSessionListProps, useRightPanelProps } from './hooks/props';
import { useAgentListeners } from './hooks/agent/useAgentListeners';
import { useEncoreRegistry } from './hooks/useEncoreRegistry';

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

// Import prompts and synopsis parsing
import { autorunSynopsisPrompt, maestroSystemPrompt } from '../prompts';
import { parseSynopsis } from '../shared/synopsis';
import { formatRelativeTime } from '../shared/formatters';

// Import types and constants
// Note: GroupChat, GroupChatState are imported from types (re-exported from shared)
import type {
	ToolType,
	SessionState,
	RightPanelTab,
	LogEntry,
	Session,
	AITab,
	QueuedItem,
	BatchRunConfig,
	AgentError,
	BatchRunState,
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
import { shouldOpenExternally, flattenTree } from './utils/fileExplorer';
import type { FileNode } from './types/fileTree';
import { substituteTemplateVariables } from './utils/templateVariables';
import { validateNewSession } from './utils/sessionValidation';
import { formatLogsForClipboard } from './utils/contextExtractor';
import { getSlashCommandDescription } from './constants/app';
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
		setNewInstanceModalOpen,
		duplicatingSessionId,
		setDuplicatingSessionId,
		// Edit Agent Modal
		editAgentModalOpen,
		setEditAgentModalOpen,
		editAgentSession,
		setEditAgentSession,
		// Delete Agent Modal
		deleteAgentModalOpen,
		deleteAgentSession,
		setDeleteAgentSession,
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
		setFirstRunCelebrationData,
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
		setQuitConfirmModalOpen,
		// Rename Instance Modal
		renameInstanceModalOpen,
		setRenameInstanceModalOpen,
		renameInstanceValue,
		setRenameInstanceValue,
		renameInstanceSessionId,
		setRenameInstanceSessionId,
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
		setTourFromWizard,
		// Symphony Modal
		symphonyModalOpen,
		setSymphonyModalOpen,
		// Director's Notes Modal
		directorNotesOpen,
		setDirectorNotesOpen,
	} = useModalActions();

	// --- PLUGIN REGISTRY ---
	const encoreRegistry = useEncoreRegistry();

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
		leftSidebarWidth,
		setLeftSidebarWidth,
		rightPanelWidth,
		setRightPanelWidth,
		markdownEditMode,
		setMarkdownEditMode,
		chatRawTextMode,
		setChatRawTextMode,
		showHiddenFiles,
		setShowHiddenFiles,
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
		globalStats,
		updateGlobalStats,
		autoRunStats,
		setAutoRunStats,
		recordAutoRunComplete,
		updateAutoRunProgress,
		usageStats,
		updateUsageStats,
		tourCompleted: _tourCompleted,
		setTourCompleted,
		firstAutoRunCompleted,
		setFirstAutoRunCompleted,
		recordWizardStart,
		recordWizardComplete,
		recordWizardAbandon,
		recordWizardResume,
		recordTourStart,
		recordTourComplete,
		recordTourSkip,
		leaderboardRegistration,
		setLeaderboardRegistration,
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

		// Tab naming settings
		automaticTabNamingEnabled,

		// File tab refresh settings
		fileTabAutoRefreshEnabled,

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
	const selectedFileIndex = useFileExplorerStore((s) => s.selectedFileIndex);
	const fileTreeFilter = useFileExplorerStore((s) => s.fileTreeFilter);
	const fileTreeFilterOpen = useFileExplorerStore((s) => s.fileTreeFilterOpen);
	const editingGroupId = useUIStore((s) => s.editingGroupId);
	const editingSessionId = useUIStore((s) => s.editingSessionId);
	const draggingSessionId = useUIStore((s) => s.draggingSessionId);
	const outputSearchOpen = useUIStore((s) => s.outputSearchOpen);
	const outputSearchQuery = useUIStore((s) => s.outputSearchQuery);
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
		setGroupChatsExpanded,
		setShowUnreadOnly,
		setEditingGroupId,
		setEditingSessionId,
		setDraggingSessionId,
		setOutputSearchOpen,
		setOutputSearchQuery,
		setFlashNotification,
		setSuccessFlashNotification,
		setSelectedSidebarIndex,
	} = useUIStore.getState();

	const { setSelectedFileIndex, setFileTreeFilter, setFileTreeFilterOpen, setFlatFileList } =
		useFileExplorerStore.getState();

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
	const groupChatStates = useGroupChatStore((s) => s.groupChatStates);
	const allGroupChatParticipantStates = useGroupChatStore((s) => s.allGroupChatParticipantStates);
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

	// Compute map of session names to SSH remote names (for group chat participant cards)
	const sessionSshRemoteNames = useMemo(() => {
		const map = new Map<string, string>();
		for (const session of sessions) {
			if (session.sessionSshRemoteConfig?.enabled && session.sessionSshRemoteConfig.remoteId) {
				const sshConfig = sshRemoteConfigs.find(
					(c) => c.id === session.sessionSshRemoteConfig?.remoteId
				);
				if (sshConfig) {
					map.set(session.name, sshConfig.name);
				}
			}
		}
		return map;
	}, [sessions, sshRemoteConfigs]);

	// Wrapper for setActiveSessionId that also dismisses active group chat
	const setActiveSessionId = useCallback(
		(id: string) => {
			setActiveGroupChatId(null); // Dismiss group chat when selecting an agent
			setActiveSessionIdFromContext(id);
		},
		[setActiveSessionIdFromContext, setActiveGroupChatId]
	);

	// Input State - PERFORMANCE CRITICAL: Input values stay in App.tsx local state
	// to avoid context re-renders on every keystroke. Only completion states are in context.
	const [terminalInputValue, setTerminalInputValue] = useState('');
	const [aiInputValueLocal, setAiInputValueLocal] = useState('');

	// PERF: Refs to access current input values without triggering re-renders in memoized callbacks
	const terminalInputValueRef = useRef(terminalInputValue);
	const aiInputValueLocalRef = useRef(aiInputValueLocal);
	useEffect(() => {
		terminalInputValueRef.current = terminalInputValue;
	}, [terminalInputValue]);
	useEffect(() => {
		aiInputValueLocalRef.current = aiInputValueLocal;
	}, [aiInputValueLocal]);

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
	const flatFileList = useFileExplorerStore((s) => s.flatFileList);
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
	const autoRunIsLoadingDocuments = useBatchStore((s) => s.isLoadingDocuments);
	const autoRunDocumentTaskCounts = useBatchStore((s) => s.documentTaskCounts);
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
	const fileTreeKeyboardNavRef = useRef(false); // Track if selection change came from keyboard
	const rightPanelRef = useRef<RightPanelHandle>(null);
	const mainPanelRef = useRef<MainPanelHandle>(null);

	// Refs for accessing latest values in event handlers
	const updateGlobalStatsRef = useRef(updateGlobalStats);
	const customAICommandsRef = useRef(customAICommands);
	const speckitCommandsRef = useRef(speckitCommands);
	const openspecCommandsRef = useRef(openspecCommands);
	const fileTabAutoRefreshEnabledRef = useRef(fileTabAutoRefreshEnabled);
	updateGlobalStatsRef.current = updateGlobalStats;
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

	// Refs for batch processor error handling (Phase 5.10)
	// These are populated after useBatchProcessor is called and used in the agent error handler
	const pauseBatchOnErrorRef = useRef<
		| ((
				sessionId: string,
				error: AgentError,
				documentIndex: number,
				taskDescription?: string
		  ) => void)
		| null
	>(null);
	const getBatchStateRef = useRef<((sessionId: string) => BatchRunState) | null>(null);

	// Note: thinkingChunkBufferRef and thinkingChunkRafIdRef moved into useAgentListeners hook

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

	// Discover slash commands when a session becomes active and doesn't have them yet
	// Fetches custom Claude commands from .claude/commands/ directories (fast, file system read)
	// Also spawns Claude briefly to get built-in commands from init message (slower)
	useEffect(() => {
		if (!activeSession) return;
		if (activeSession.toolType !== 'claude-code') return;
		// Skip if we already have commands
		if (activeSession.agentCommands && activeSession.agentCommands.length > 0) return;

		// Capture session ID to prevent race conditions when switching sessions
		const sessionId = activeSession.id;
		const projectRoot = activeSession.projectRoot;
		let cancelled = false;

		// Helper to merge commands without duplicates
		const mergeCommands = (
			existing: { command: string; description: string }[],
			newCmds: { command: string; description: string }[]
		) => {
			const merged = [...existing];
			for (const cmd of newCmds) {
				if (!merged.some((c) => c.command === cmd.command)) {
					merged.push(cmd);
				}
			}
			return merged;
		};

		// Fetch custom Claude commands immediately (fast - just reads files)
		const fetchCustomCommands = async () => {
			try {
				const customClaudeCommands = await window.maestro.claude.getCommands(projectRoot);
				if (cancelled) return;

				// Custom Claude commands already have command and description from the handler
				const customCommandObjects = (customClaudeCommands || []).map((cmd) => ({
					command: cmd.command,
					description: cmd.description,
				}));

				if (customCommandObjects.length > 0) {
					setSessions((prev) =>
						prev.map((s) => {
							if (s.id !== sessionId) return s;
							const existingCommands = s.agentCommands || [];
							return {
								...s,
								agentCommands: mergeCommands(existingCommands, customCommandObjects),
							};
						})
					);
				}
			} catch (error) {
				if (!cancelled) {
					console.error('[SlashCommandDiscovery] Failed to fetch custom commands:', error);
				}
			}
		};

		// Discover built-in agent slash commands in background (slower - spawns Claude)
		const discoverAgentCommands = async () => {
			try {
				const agentSlashCommands = await window.maestro.agents.discoverSlashCommands(
					activeSession.toolType,
					activeSession.cwd,
					activeSession.customPath
				);
				if (cancelled) return;

				// Convert agent slash commands to command objects
				const agentCommandObjects = (agentSlashCommands || []).map((cmd) => ({
					command: cmd.startsWith('/') ? cmd : `/${cmd}`,
					description: getSlashCommandDescription(cmd),
				}));

				if (agentCommandObjects.length > 0) {
					setSessions((prev) =>
						prev.map((s) => {
							if (s.id !== sessionId) return s;
							const existingCommands = s.agentCommands || [];
							return {
								...s,
								agentCommands: mergeCommands(existingCommands, agentCommandObjects),
							};
						})
					);
				}
			} catch (error) {
				if (!cancelled) {
					console.error('[SlashCommandDiscovery] Failed to discover agent commands:', error);
				}
			}
		};

		// Start both in parallel but don't wait for each other
		fetchCustomCommands();
		discoverAgentCommands();

		return () => {
			cancelled = true;
		};
	}, [
		activeSession?.id,
		activeSession?.toolType,
		activeSession?.cwd,
		activeSession?.customPath,
		activeSession?.agentCommands,
		activeSession?.projectRoot,
	]);

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

	// Tab completion hook for terminal mode
	const { getSuggestions: getTabCompletionSuggestions } = useTabCompletion(activeSession);

	// @ mention completion hook for AI mode
	const { getSuggestions: getAtMentionSuggestions } = useAtMentionCompletion(activeSession);

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

	// Quit confirmation handler - shows modal when trying to quit with busy agents or active auto-runs
	useEffect(() => {
		// Guard against window.maestro not being defined yet (production timing)
		if (!window.maestro?.app?.onQuitConfirmationRequest) {
			return;
		}
		const unsubscribe = window.maestro.app.onQuitConfirmationRequest(() => {
			// Get all busy AI sessions (agents that are actively thinking)
			const busyAgents = sessions.filter(
				(s) => s.state === 'busy' && s.busySource === 'ai' && s.toolType !== 'terminal'
			);

			// Check for active auto-runs (batch processor may be between tasks with agent idle)
			const hasActiveAutoRuns = sessions.some((s) => {
				const batchState = getBatchStateRef.current?.(s.id);
				return batchState?.isRunning;
			});

			if (busyAgents.length === 0 && !hasActiveAutoRuns) {
				// No busy agents and no active auto-runs, confirm quit immediately
				window.maestro.app.confirmQuit();
			} else {
				// Show quit confirmation modal
				setQuitConfirmModalOpen(true);
			}
		});

		return unsubscribe;
	}, [sessions]);

	// Theme styles hook - manages CSS variables and scrollbar fade animations
	useThemeStyles({
		themeColors: theme.colors,
	});

	// Get capabilities for the active session's agent type
	const { hasCapability: hasActiveSessionCapability } = useAgentCapabilities(
		activeSession?.toolType
	);

	// Merge session hook for context merge operations (non-blocking, per-tab)
	const {
		mergeState,
		progress: mergeProgress,
		error: _mergeError,
		startTime: mergeStartTime,
		sourceName: mergeSourceName,
		targetName: mergeTargetName,
		executeMerge,
		cancelTab: cancelMergeTab,
		cancelMerge: _cancelMerge,
		clearTabState: clearMergeTabState,
		reset: resetMerge,
	} = useMergeSessionWithSessions({
		sessions,
		setSessions,
		activeTabId: activeSession?.activeTabId,
		onSessionCreated: (info) => {
			// Navigate to the newly created merged session
			setActiveSessionId(info.sessionId);
			setMergeSessionModalOpen(false);

			// Build informative message with token info
			const tokenInfo = info.estimatedTokens
				? ` (~${info.estimatedTokens.toLocaleString()} tokens)`
				: '';
			const savedInfo =
				info.tokensSaved && info.tokensSaved > 0
					? ` Saved ~${info.tokensSaved.toLocaleString()} tokens.`
					: '';
			const sourceInfo =
				info.sourceSessionName && info.targetSessionName
					? `"${info.sourceSessionName}" + "${info.targetSessionName}"`
					: info.sessionName;

			// Show toast notification in the UI
			notifyToast({
				type: 'success',
				title: 'Session Merged',
				message: `Created "${info.sessionName}" from ${sourceInfo}${tokenInfo}.${savedInfo}`,
				sessionId: info.sessionId,
			});

			// Show desktop notification for visibility when app is not focused
			window.maestro.notification.show(
				'Session Merged',
				`Created "${info.sessionName}" with merged context`
			);

			// Clear the merge state for the source tab after a short delay
			if (activeSession?.activeTabId) {
				setTimeout(() => {
					clearMergeTabState(activeSession.activeTabId);
				}, 1000);
			}
		},
		onMergeComplete: (sourceTabId, result) => {
			// For merge into existing tab, navigate to target and show toast
			if (activeSession && result.success && result.targetSessionId) {
				const tokenInfo = result.estimatedTokens
					? ` (~${result.estimatedTokens.toLocaleString()} tokens)`
					: '';
				const savedInfo =
					result.tokensSaved && result.tokensSaved > 0
						? ` Saved ~${result.tokensSaved.toLocaleString()} tokens.`
						: '';

				// Navigate to the target session/tab so autoSendOnActivate will trigger
				// This ensures the merged context is immediately sent to the agent
				setActiveSessionId(result.targetSessionId);
				if (result.targetTabId) {
					const targetTabId = result.targetTabId; // Extract to satisfy TypeScript narrowing
					setSessions((prev) =>
						prev.map((s) => {
							if (s.id !== result.targetSessionId) return s;
							return { ...s, activeTabId: targetTabId };
						})
					);
				}

				notifyToast({
					type: 'success',
					title: 'Context Merged',
					message: `"${result.sourceSessionName || 'Current Session'}" → "${
						result.targetSessionName || 'Selected Session'
					}"${tokenInfo}.${savedInfo}`,
				});

				// Clear the merge state for the source tab
				setTimeout(() => {
					clearMergeTabState(sourceTabId);
				}, 1000);
			}
		},
	});

	// Send to Agent hook for cross-agent context transfer operations
	// Track the source/target agents for the transfer progress modal
	const [transferSourceAgent, setTransferSourceAgent] = useState<ToolType | null>(null);
	const [transferTargetAgent, setTransferTargetAgent] = useState<ToolType | null>(null);
	const {
		transferState,
		progress: transferProgress,
		error: _transferError,
		executeTransfer: _executeTransfer,
		cancelTransfer,
		reset: resetTransfer,
	} = useSendToAgentWithSessions({
		sessions,
		setSessions,
		onSessionCreated: (sessionId, sessionName) => {
			// Navigate to the newly created transferred session
			setActiveSessionId(sessionId);
			setSendToAgentModalOpen(false);

			// Show toast notification in the UI
			notifyToast({
				type: 'success',
				title: 'Context Transferred',
				message: `Created "${sessionName}" with transferred context`,
			});

			// Show desktop notification for visibility when app is not focused
			window.maestro.notification.show(
				'Context Transferred',
				`Created "${sessionName}" with transferred context`
			);

			// Reset the transfer state after a short delay to allow progress modal to show "Complete"
			setTimeout(() => {
				resetTransfer();
				setTransferSourceAgent(null);
				setTransferTargetAgent(null);
			}, 1500);
		},
	});

	// --- STABLE HANDLERS FOR APP AGENT MODALS ---

	// Sync autorun stats from server (for new device installations)
	const handleSyncAutoRunStats = useCallback(
		(stats: {
			cumulativeTimeMs: number;
			totalRuns: number;
			currentBadgeLevel: number;
			longestRunMs: number;
			longestRunTimestamp: number;
		}) => {
			setAutoRunStats({
				...autoRunStats,
				cumulativeTimeMs: stats.cumulativeTimeMs,
				totalRuns: stats.totalRuns,
				currentBadgeLevel: stats.currentBadgeLevel,
				longestRunMs: stats.longestRunMs,
				longestRunTimestamp: stats.longestRunTimestamp,
				// Also update badge tracking to match synced level
				lastBadgeUnlockLevel: stats.currentBadgeLevel,
				lastAcknowledgedBadgeLevel: stats.currentBadgeLevel,
			});
		},
		[autoRunStats, setAutoRunStats]
	);

	// MergeSessionModal handlers
	const handleCloseMergeSession = useCallback(() => {
		setMergeSessionModalOpen(false);
		resetMerge();
	}, [resetMerge]);

	const handleMerge = useCallback(
		async (targetSessionId: string, targetTabId: string | undefined, options: MergeOptions) => {
			// Close the modal - merge will show in the input area overlay
			setMergeSessionModalOpen(false);

			// Execute merge using the hook (callbacks handle toasts and navigation)
			const result = await executeMerge(
				activeSession!,
				activeSession!.activeTabId,
				targetSessionId,
				targetTabId,
				options
			);

			if (!result.success) {
				notifyToast({
					type: 'error',
					title: 'Merge Failed',
					message: result.error || 'Failed to merge contexts',
				});
			}
			// Note: Success toasts are handled by onSessionCreated (for new sessions)
			// and onMergeComplete (for merging into existing sessions) callbacks

			return result;
		},
		[activeSession, executeMerge]
	);

	// TransferProgressModal handlers
	const handleCancelTransfer = useCallback(() => {
		cancelTransfer();
		setTransferSourceAgent(null);
		setTransferTargetAgent(null);
	}, [cancelTransfer]);

	const handleCompleteTransfer = useCallback(() => {
		resetTransfer();
		setTransferSourceAgent(null);
		setTransferTargetAgent(null);
	}, [resetTransfer]);

	const handleSendToAgent = useCallback(
		async (targetSessionId: string, options: SendToAgentOptions) => {
			// Find the target session
			const targetSession = sessions.find((s) => s.id === targetSessionId);
			if (!targetSession) {
				return { success: false, error: 'Target session not found' };
			}

			// Store source and target agents for progress modal display
			setTransferSourceAgent(activeSession!.toolType);
			setTransferTargetAgent(targetSession.toolType);

			// Close the selection modal - progress modal will take over
			setSendToAgentModalOpen(false);

			// Get source tab context
			const sourceTab = activeSession!.aiTabs.find((t) => t.id === activeSession!.activeTabId);
			if (!sourceTab) {
				return { success: false, error: 'Source tab not found' };
			}

			// Format the context as text to be sent to the agent
			// Only include user messages and AI responses, not system messages
			const formattedContext = sourceTab.logs
				.filter(
					(log) =>
						log.text &&
						log.text.trim() &&
						(log.source === 'user' || log.source === 'ai' || log.source === 'stdout')
				)
				.map((log) => {
					const role = log.source === 'user' ? 'User' : 'Assistant';
					return `${role}: ${log.text}`;
				})
				.join('\n\n');

			const sourceName =
				activeSession!.name || activeSession!.projectRoot.split('/').pop() || 'Unknown';
			const sourceAgentName = activeSession!.toolType;

			// Create the context message to be sent directly to the agent
			const contextMessage = formattedContext
				? `# Context from Previous Session

The following is a conversation from another session ("${sourceName}" using ${sourceAgentName}). Review this context to understand the prior work and decisions made.

---

${formattedContext}

---

# Your Task

You are taking over this conversation. Based on the context above, provide a brief summary of where things left off and ask what the user would like to focus on next.`
				: 'No context available from the previous session.';

			// Transfer context to the target session's active tab
			// Create a new tab in the target session and immediately send context to agent
			const newTabId = `tab-${Date.now()}`;
			const transferNotice: LogEntry = {
				id: `transfer-notice-${Date.now()}`,
				timestamp: Date.now(),
				source: 'system',
				text: `Context transferred from "${sourceName}" (${sourceAgentName})${
					options.groomContext ? ' - cleaned to reduce size' : ''
				}`,
			};

			// Create user message entry for the context being sent
			const userContextMessage: LogEntry = {
				id: `user-context-${Date.now()}`,
				timestamp: Date.now(),
				source: 'user',
				text: contextMessage,
			};

			const newTab: AITab = {
				id: newTabId,
				name: `From: ${sourceName}`,
				logs: [transferNotice, userContextMessage],
				agentSessionId: null,
				starred: false,
				inputValue: '',
				stagedImages: [],
				createdAt: Date.now(),
				state: 'busy', // Start in busy state since we're spawning immediately
				thinkingStartTime: Date.now(),
				awaitingSessionId: true, // Mark as awaiting session ID
			};

			// Add the new tab to the target session and set it as active
			setSessions((prev) =>
				prev.map((s) => {
					if (s.id === targetSessionId) {
						return {
							...s,
							state: 'busy',
							busySource: 'ai',
							thinkingStartTime: Date.now(),
							aiTabs: [...s.aiTabs, newTab],
							activeTabId: newTabId,
						};
					}
					return s;
				})
			);

			// Navigate to the target session
			setActiveSessionId(targetSessionId);

			// Calculate estimated tokens for the toast
			const estimatedTokens = sourceTab.logs
				.filter((log) => log.text && log.source !== 'system')
				.reduce((sum, log) => sum + Math.round((log.text?.length || 0) / 4), 0);
			const tokenInfo = estimatedTokens > 0 ? ` (~${estimatedTokens.toLocaleString()} tokens)` : '';

			// Show success toast
			notifyToast({
				type: 'success',
				title: 'Context Sent',
				message: `"${sourceName}" → "${targetSession.name}"${tokenInfo}`,
				sessionId: targetSessionId,
				tabId: newTabId,
			});

			// Reset transfer state
			resetTransfer();
			setTransferSourceAgent(null);
			setTransferTargetAgent(null);

			// Spawn the agent with the context - do this after state updates
			(async () => {
				try {
					// Get agent configuration
					const agent = await window.maestro.agents.get(targetSession.toolType);
					if (!agent) throw new Error(`${targetSession.toolType} agent not found`);

					const baseArgs = agent.args ?? [];
					const commandToUse = agent.path || agent.command;

					// Build the full prompt with Maestro system prompt for new sessions
					let effectivePrompt = contextMessage;

					// Get git branch for template substitution
					let gitBranch: string | undefined;
					if (targetSession.isGitRepo) {
						try {
							const status = await gitService.getStatus(targetSession.cwd);
							gitBranch = status.branch;
						} catch {
							// Ignore git errors
						}
					}

					// Prepend Maestro system prompt since this is a new session
					if (maestroSystemPrompt) {
						const substitutedSystemPrompt = substituteTemplateVariables(maestroSystemPrompt, {
							session: targetSession,
							gitBranch,
							conductorProfile,
						});
						effectivePrompt = `${substitutedSystemPrompt}\n\n---\n\n# User Request\n\n${effectivePrompt}`;
					}

					// Spawn agent
					const spawnSessionId = `${targetSessionId}-ai-${newTabId}`;
					await window.maestro.process.spawn({
						sessionId: spawnSessionId,
						toolType: targetSession.toolType,
						cwd: targetSession.cwd,
						command: commandToUse,
						args: [...baseArgs],
						prompt: effectivePrompt,
						// Per-session config overrides (if set)
						sessionCustomPath: targetSession.customPath,
						sessionCustomArgs: targetSession.customArgs,
						sessionCustomEnvVars: targetSession.customEnvVars,
						sessionCustomModel: targetSession.customModel,
						sessionCustomContextWindow: targetSession.customContextWindow,
						sessionSshRemoteConfig: targetSession.sessionSshRemoteConfig,
					});
				} catch (error) {
					console.error('Failed to spawn agent for context transfer:', error);
					const errorLog: LogEntry = {
						id: `error-${Date.now()}`,
						timestamp: Date.now(),
						source: 'system',
						text: `Error: Failed to spawn agent - ${(error as Error).message}`,
					};
					setSessions((prev) =>
						prev.map((s) => {
							if (s.id !== targetSessionId) return s;
							return {
								...s,
								state: 'idle',
								busySource: undefined,
								thinkingStartTime: undefined,
								aiTabs: s.aiTabs.map((tab) =>
									tab.id === newTabId
										? {
												...tab,
												state: 'idle' as const,
												thinkingStartTime: undefined,
												logs: [...tab.logs, errorLog],
											}
										: tab
								),
							};
						})
					);
				}
			})();

			return { success: true, newSessionId: targetSessionId, newTabId };
		},
		[activeSession, sessions, setSessions, setActiveSessionId, resetTransfer]
	);

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

	// Derive current input value and setter based on active session mode
	// For AI mode: use active tab's inputValue (stored per-tab)
	// For terminal mode: use local state (shared across tabs)
	const isAiMode = activeSession?.inputMode === 'ai';
	const canAttachImages = useMemo(() => {
		if (!activeSession || activeSession.inputMode !== 'ai') return false;
		return isResumingSession
			? hasActiveSessionCapability('supportsImageInputOnResume')
			: hasActiveSessionCapability('supportsImageInput');
	}, [activeSession, isResumingSession, hasActiveSessionCapability]);
	// Track previous active tab to detect tab switches
	const prevActiveTabIdRef = useRef<string | undefined>(activeTab?.id);

	// Track previous active session to detect session switches (for terminal draft persistence)
	const prevActiveSessionIdRef = useRef<string | undefined>(activeSession?.id);

	// Sync local AI input with tab's persisted value when switching tabs
	// Also clear the hasUnread indicator when a tab becomes active
	useEffect(() => {
		if (activeTab && activeTab.id !== prevActiveTabIdRef.current) {
			const prevTabId = prevActiveTabIdRef.current;

			// Save the current AI input to the PREVIOUS tab before loading new tab's input
			// This ensures we don't lose draft input when clicking directly on another tab
			// Also ensures clearing the input (empty string) is persisted when switching away
			if (prevTabId) {
				setSessions((prev) =>
					prev.map((s) => ({
						...s,
						aiTabs: s.aiTabs.map((tab) =>
							tab.id === prevTabId ? { ...tab, inputValue: aiInputValueLocal } : tab
						),
					}))
				);
			}

			// Tab changed - load the new tab's persisted input value
			setAiInputValueLocal(activeTab.inputValue ?? '');
			prevActiveTabIdRef.current = activeTab.id;

			// Clear hasUnread indicator on the newly active tab
			// This is the central place that handles all tab switches regardless of how they happen
			// (click, keyboard shortcut, programmatic, etc.)
			if (activeTab.hasUnread && activeSession) {
				setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== activeSession.id) return s;
						return {
							...s,
							aiTabs: s.aiTabs.map((t) => (t.id === activeTab.id ? { ...t, hasUnread: false } : t)),
						};
					})
				);
			}
		}
		// Note: We intentionally only depend on activeTab?.id, NOT activeTab?.inputValue
		// The inputValue changes when we blur (syncAiInputToSession), but we don't want
		// to read it back into local state - that would cause a feedback loop.
		// We only need to load inputValue when switching TO a different tab.
	}, [activeTab?.id]);

	// Input sync handlers (extracted to useInputSync hook)
	const { syncAiInputToSession, syncTerminalInputToSession } = useInputSync(activeSession, {
		setSessions,
	});

	// Session navigation handlers (extracted to useSessionNavigation hook)
	const { handleNavBack, handleNavForward } = useSessionNavigation(sessions, {
		navigateBack,
		navigateForward,
		setActiveSessionId: setActiveSessionIdInternal,
		setSessions,
		cyclePositionRef,
	});

	// Sync terminal input when switching sessions
	// Save current terminal input to old session, load from new session
	useEffect(() => {
		if (activeSession && activeSession.id !== prevActiveSessionIdRef.current) {
			const prevSessionId = prevActiveSessionIdRef.current;

			// Save terminal input to the previous session (if there was one and we have input)
			if (prevSessionId && terminalInputValue) {
				setSessions((prev) =>
					prev.map((s) =>
						s.id === prevSessionId ? { ...s, terminalDraftInput: terminalInputValue } : s
					)
				);
			}

			// Load terminal input from the new session
			setTerminalInputValue(activeSession.terminalDraftInput ?? '');

			// Update ref to current session
			prevActiveSessionIdRef.current = activeSession.id;
		}
	}, [activeSession?.id]);

	// Use local state for responsive typing - no session state update on every keystroke
	const inputValue = isAiMode ? aiInputValueLocal : terminalInputValue;

	// PERF: useDeferredValue allows React to defer re-renders of expensive components
	// that consume the input value for filtering/preview purposes. InputArea uses inputValue
	// directly for responsive typing, while non-critical consumers like slash command filtering
	// and prompt composer can use the deferred value to avoid blocking keystrokes.
	const deferredInputValue = useDeferredValue(inputValue);

	// PERF: Memoize setInputValue to maintain stable reference - prevents child re-renders
	// when this callback is passed as a prop. The conditional selection based on isAiMode
	// was creating new function references on every render.
	const setInputValue = useCallback(
		(value: string | ((prev: string) => string)) => {
			if (activeSession?.inputMode === 'ai') {
				setAiInputValueLocal(value);
			} else {
				setTerminalInputValue(value);
			}
		},
		[activeSession?.inputMode]
	);

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

	// Images are stored per-tab and only used in AI mode
	// Get staged images from the active tab
	// PERF: Use memoized activeTab instead of calling getActiveTab again
	const stagedImages = useMemo(() => {
		if (!activeSession || activeSession.inputMode !== 'ai') return [];
		return activeTab?.stagedImages || [];
	}, [activeTab?.stagedImages, activeSession?.inputMode]);

	// Set staged images on the active tab
	const setStagedImages = useCallback(
		(imagesOrUpdater: string[] | ((prev: string[]) => string[])) => {
			if (!activeSession) return;
			setSessions((prev) =>
				prev.map((s) => {
					if (s.id !== activeSession.id) return s;
					return {
						...s,
						aiTabs: s.aiTabs.map((tab) => {
							if (tab.id !== s.activeTabId) return tab;
							const currentImages = tab.stagedImages || [];
							const newImages =
								typeof imagesOrUpdater === 'function'
									? imagesOrUpdater(currentImages)
									: imagesOrUpdater;
							return { ...tab, stagedImages: newImages };
						}),
					};
				})
			);
		},
		[activeSession]
	);

	// Log entry helpers - delegates to sessionStore action
	const addLogToTab = useSessionStore.getState().addLogToTab;
	const addLogToActiveTab = addLogToTab; // without tabId = active tab (same function)

	// PERF: Extract only the properties we need to avoid re-memoizing on every session change
	// Note: activeSessionId already exists as state; we just need inputMode
	const activeSessionInputMode = activeSession?.inputMode;

	// Tab completion suggestions (must be after inputValue is defined)
	// PERF: Only debounce when menu is open to avoid unnecessary state updates during normal typing
	const debouncedInputForTabCompletion = useDebouncedValue(tabCompletionOpen ? inputValue : '', 50);
	const tabCompletionSuggestions = useMemo(() => {
		if (!tabCompletionOpen || !activeSessionId || activeSessionInputMode !== 'terminal') {
			return [];
		}
		return getTabCompletionSuggestions(debouncedInputForTabCompletion, tabCompletionFilter);
	}, [
		tabCompletionOpen,
		activeSessionId,
		activeSessionInputMode,
		debouncedInputForTabCompletion,
		tabCompletionFilter,
		getTabCompletionSuggestions,
	]);

	// @ mention suggestions for AI mode
	// PERF: Only debounce when menu is open to avoid unnecessary state updates during normal typing
	// When menu is closed, pass empty string to skip debounce hook overhead entirely
	const debouncedAtMentionFilter = useDebouncedValue(atMentionOpen ? atMentionFilter : '', 100);
	const atMentionSuggestions = useMemo(() => {
		if (!atMentionOpen || !activeSessionId || activeSessionInputMode !== 'ai') {
			return [];
		}
		return getAtMentionSuggestions(debouncedAtMentionFilter);
	}, [
		atMentionOpen,
		activeSessionId,
		activeSessionInputMode,
		debouncedAtMentionFilter,
		getAtMentionSuggestions,
	]);

	// Sync file tree selection to match tab completion suggestion
	// This highlights the corresponding file/folder in the right panel when navigating tab completion
	const syncFileTreeToTabCompletion = useCallback(
		(suggestion: TabCompletionSuggestion | undefined) => {
			if (!suggestion || suggestion.type === 'history' || flatFileList.length === 0) return;

			// Strip trailing slash from folder paths to match flatFileList format
			const targetPath = suggestion.value.replace(/\/$/, '');

			// Also handle paths with command prefix (e.g., "cd src/" -> "src")
			const pathOnly = targetPath.split(/\s+/).pop() || targetPath;

			const matchIndex = flatFileList.findIndex((item) => item.fullPath === pathOnly);

			if (matchIndex >= 0) {
				fileTreeKeyboardNavRef.current = true; // Scroll to matched file
				setSelectedFileIndex(matchIndex);
				// Ensure Files tab is visible to show the highlight
				if (activeRightTab !== 'files') {
					setActiveRightTab('files');
				}
			}
		},
		[flatFileList, activeRightTab]
	);

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
		updateGlobalStatsRef,
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

	/**
	 * Toggle bookmark state for a session.
	 * Used by keyboard shortcut (Cmd+Shift+B) and UI actions.
	 */
	const toggleBookmark = useCallback((sessionId: string) => {
		setSessions((prev) =>
			prev.map((s) => (s.id === sessionId ? { ...s, bookmarked: !s.bookmarked } : s))
		);
	}, []);

	const handleMainPanelInputBlur = useCallback(() => {
		// Access current values via refs to avoid dependencies
		const currentIsAiMode =
			sessionsRef.current.find((s) => s.id === activeSessionIdRef.current)?.inputMode === 'ai';
		if (currentIsAiMode) {
			syncAiInputToSession(aiInputValueLocalRef.current);
		} else {
			syncTerminalInputToSession(terminalInputValueRef.current);
		}
	}, [syncAiInputToSession, syncTerminalInputToSession]);

	// PERF: Ref to access processInput without dependency - will be set after processInput is defined
	const processInputRef = useRef<(text?: string) => void>(() => {});

	const handleReplayMessage = useCallback(
		(text: string, images?: string[]) => {
			if (images && images.length > 0) {
				setStagedImages(images);
			}
			setTimeout(() => processInputRef.current(text), 0);
		},
		[setStagedImages]
	);

	const handleFocusFileInGraph = useFileExplorerStore.getState().focusFileInGraph;
	const handleOpenLastDocumentGraph = useFileExplorerStore.getState().openLastDocumentGraph;

	// PERF: Memoized callbacks for MainPanel file preview navigation
	// These were inline arrow functions causing MainPanel re-renders on every keystroke
	// Updated to use file tabs (handleOpenFileTab) instead of legacy preview overlay
	const handleMainPanelFileClick = useCallback(
		async (relativePath: string, options?: { openInNewTab?: boolean }) => {
			const currentSession = sessionsRef.current.find((s) => s.id === activeSessionIdRef.current);
			if (!currentSession) return;
			const filename = relativePath.split('/').pop() || relativePath;

			// Get SSH remote ID
			const sshRemoteId =
				currentSession.sshRemoteId || currentSession.sessionSshRemoteConfig?.remoteId || undefined;

			// Check if file should be opened externally (PDF, etc.)
			if (!sshRemoteId && shouldOpenExternally(filename)) {
				const fullPath = `${currentSession.fullPath}/${relativePath}`;
				window.maestro.shell.openExternal(`file://${fullPath}`);
				return;
			}

			try {
				const fullPath = `${currentSession.fullPath}/${relativePath}`;
				// Fetch content and stat in parallel for efficiency
				const [content, stat] = await Promise.all([
					window.maestro.fs.readFile(fullPath, sshRemoteId),
					window.maestro.fs.stat(fullPath, sshRemoteId).catch(() => null), // stat is optional, don't fail if unavailable
				]);
				const lastModified = stat?.modifiedAt ? new Date(stat.modifiedAt).getTime() : undefined;
				// Open file in a tab:
				// - openInNewTab=true (Cmd/Ctrl+Click): create new tab adjacent to current
				// - openInNewTab=false (regular click): replace current tab content
				handleOpenFileTab(
					{
						path: fullPath,
						name: filename,
						content,
						sshRemoteId,
						lastModified,
					},
					{ openInNewTab: options?.openInNewTab ?? false } // Default to replacing current tab for in-content links
				);
				setActiveFocus('main');
			} catch (error) {
				console.error('[onFileClick] Failed to read file:', error);
			}
		},
		[handleOpenFileTab]
	);

	const handleMergeWith = useCallback((tabId: string) => {
		const currentSession = sessionsRef.current.find((s) => s.id === activeSessionIdRef.current);
		if (currentSession) {
			setSessions((prev) =>
				prev.map((s) => (s.id === currentSession.id ? { ...s, activeTabId: tabId } : s))
			);
		}
		setMergeSessionModalOpen(true);
	}, []);

	const handleOpenSendToAgentModal = useCallback((tabId: string) => {
		const currentSession = sessionsRef.current.find((s) => s.id === activeSessionIdRef.current);
		if (currentSession) {
			setSessions((prev) =>
				prev.map((s) => (s.id === currentSession.id ? { ...s, activeTabId: tabId } : s))
			);
		}
		setSendToAgentModalOpen(true);
	}, []);

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

	// Initialize batch processor (supports parallel batches per session)
	const {
		batchRunStates: _batchRunStates,
		getBatchState,
		activeBatchSessionIds,
		startBatchRun,
		stopBatchRun,
		killBatchRun,
		// Error handling (Phase 5.10)
		pauseBatchOnError,
		skipCurrentDocument,
		resumeAfterError,
		abortBatchOnError,
	} = useBatchProcessor({
		sessions,
		groups,
		onUpdateSession: (sessionId, updates) => {
			setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, ...updates } : s)));
		},
		onSpawnAgent: spawnAgentForSession,
		onAddHistoryEntry: async (entry) => {
			await window.maestro.history.add({
				...entry,
				id: generateId(),
			});
			// Refresh history panel to show the new entry
			rightPanelRef.current?.refreshHistoryPanel();
		},
		// TTS settings for speaking synopsis after each auto-run task
		audioFeedbackEnabled,
		audioFeedbackCommand,
		// Pass autoRunStats for achievement progress in final summary
		autoRunStats,
		onComplete: (info) => {
			// Find group name for the session
			const session = sessions.find((s) => s.id === info.sessionId);
			const sessionGroup = session?.groupId ? groups.find((g) => g.id === session.groupId) : null;
			const groupName = sessionGroup?.name || 'Ungrouped';

			// Determine toast type and message based on completion status
			const toastType = info.wasStopped
				? 'warning'
				: info.completedTasks === info.totalTasks
					? 'success'
					: 'info';

			// Build message
			let message: string;
			if (info.wasStopped) {
				message = `Stopped after completing ${info.completedTasks} of ${info.totalTasks} tasks`;
			} else if (info.completedTasks === info.totalTasks) {
				message = `All ${info.totalTasks} ${
					info.totalTasks === 1 ? 'task' : 'tasks'
				} completed successfully`;
			} else {
				message = `Completed ${info.completedTasks} of ${info.totalTasks} tasks`;
			}

			notifyToast({
				type: toastType,
				title: 'Auto-Run Complete',
				message,
				group: groupName,
				project: info.sessionName,
				taskDuration: info.elapsedTimeMs,
				sessionId: info.sessionId,
			});

			// Record achievement and check for badge unlocks
			if (info.elapsedTimeMs > 0) {
				const { newBadgeLevel, isNewRecord } = recordAutoRunComplete(info.elapsedTimeMs);

				// Check for first Auto Run celebration (takes priority over standing ovation)
				if (!firstAutoRunCompleted) {
					// This is the user's first Auto Run completion!
					setFirstAutoRunCompleted(true);
					// Small delay to let the toast appear first
					setTimeout(() => {
						setFirstRunCelebrationData({
							elapsedTimeMs: info.elapsedTimeMs,
							completedTasks: info.completedTasks,
							totalTasks: info.totalTasks,
						});
					}, 500);
				}
				// Show Standing Ovation overlay for new badges or records (only if not showing first run)
				else if (newBadgeLevel !== null || isNewRecord) {
					const badge =
						newBadgeLevel !== null
							? CONDUCTOR_BADGES.find((b) => b.level === newBadgeLevel)
							: CONDUCTOR_BADGES.find((b) => b.level === autoRunStats.currentBadgeLevel);

					if (badge) {
						// Small delay to let the toast appear first
						setTimeout(() => {
							setStandingOvationData({
								badge,
								isNewRecord,
								recordTimeMs: isNewRecord ? info.elapsedTimeMs : autoRunStats.longestRunMs,
							});
						}, 500);
					}
				}

				// Submit to leaderboard if registered and email confirmed
				if (isLeaderboardRegistered && leaderboardRegistration) {
					// Calculate updated stats after this run (simulating what recordAutoRunComplete updated)
					const updatedCumulativeTimeMs = autoRunStats.cumulativeTimeMs + info.elapsedTimeMs;
					const updatedTotalRuns = autoRunStats.totalRuns + 1;
					const updatedLongestRunMs = Math.max(autoRunStats.longestRunMs || 0, info.elapsedTimeMs);
					const updatedBadge = getBadgeForTime(updatedCumulativeTimeMs);
					const updatedBadgeLevel = updatedBadge?.level || 0;
					const updatedBadgeName = updatedBadge?.name || 'No Badge Yet';

					// Format longest run date
					let longestRunDate: string | undefined;
					if (isNewRecord) {
						longestRunDate = new Date().toISOString().split('T')[0];
					} else if (autoRunStats.longestRunTimestamp > 0) {
						longestRunDate = new Date(autoRunStats.longestRunTimestamp).toISOString().split('T')[0];
					}

					// Submit to leaderboard in background (only if we have an auth token)
					if (!leaderboardRegistration.authToken) {
						console.warn('Leaderboard submission skipped: no auth token');
					} else {
						// Auto Run completion submission: Use delta mode for multi-device aggregation
						// API behavior:
						// - If deltaMs > 0 is present: Server adds deltaMs to running total (delta mode)
						// - If only cumulativeTimeMs (no deltaMs): Server replaces value (legacy mode)
						// We send deltaMs to trigger delta mode, ensuring proper aggregation across devices.
						window.maestro.leaderboard
							.submit({
								email: leaderboardRegistration.email,
								displayName: leaderboardRegistration.displayName,
								githubUsername: leaderboardRegistration.githubUsername,
								twitterHandle: leaderboardRegistration.twitterHandle,
								linkedinHandle: leaderboardRegistration.linkedinHandle,
								badgeLevel: updatedBadgeLevel,
								badgeName: updatedBadgeName,
								// Legacy fields (server ignores when deltaMs is present)
								cumulativeTimeMs: updatedCumulativeTimeMs,
								totalRuns: updatedTotalRuns,
								longestRunMs: updatedLongestRunMs,
								longestRunDate,
								currentRunMs: info.elapsedTimeMs,
								theme: activeThemeId,
								authToken: leaderboardRegistration.authToken,
								// Delta mode: Server adds these to running totals
								deltaMs: info.elapsedTimeMs,
								deltaRuns: 1,
								// Client's local total for discrepancy detection
								clientTotalTimeMs: updatedCumulativeTimeMs,
							})
							.then((result) => {
								if (result.success) {
									// Update last submission timestamp
									setLeaderboardRegistration({
										...leaderboardRegistration,
										lastSubmissionAt: Date.now(),
										emailConfirmed: !result.requiresConfirmation,
									});

									// Show ranking notification if available
									if (result.ranking) {
										const { cumulative, longestRun } = result.ranking;
										let message = '';

										// Build cumulative ranking message
										if (cumulative.previousRank === null) {
											// New entry
											message = `You're ranked #${cumulative.rank} of ${cumulative.total}!`;
										} else if (cumulative.improved) {
											// Moved up
											const spotsUp = cumulative.previousRank - cumulative.rank;
											message = `You moved up ${spotsUp} spot${
												spotsUp > 1 ? 's' : ''
											}! Now #${cumulative.rank} (was #${cumulative.previousRank})`;
										} else if (cumulative.rank === cumulative.previousRank) {
											// Holding steady
											message = `You're holding steady at #${cumulative.rank}`;
										} else {
											// Dropped (shouldn't happen often, but handle it)
											message = `You're now #${cumulative.rank} of ${cumulative.total}`;
										}

										// Add longest run info if it's a new record or improved
										if (longestRun && isNewRecord) {
											message += ` | New personal best! #${longestRun.rank} on longest runs!`;
										}

										notifyToast({
											type: 'success',
											title: 'Leaderboard Updated',
											message,
										});
									}

									// Sync local stats from server response (Gap 1 fix for multi-device aggregation)
									if (result.serverTotals) {
										const serverCumulativeMs = result.serverTotals.cumulativeTimeMs;
										// Only update if server has more data (aggregated from other devices)
										if (serverCumulativeMs > updatedCumulativeTimeMs) {
											handleSyncAutoRunStats({
												cumulativeTimeMs: serverCumulativeMs,
												totalRuns: result.serverTotals.totalRuns,
												// Recalculate badge level from server cumulative time
												currentBadgeLevel: getBadgeForTime(serverCumulativeMs)?.level ?? 0,
												// Keep local longest run (server might not return this in submit response)
												longestRunMs: updatedLongestRunMs,
												longestRunTimestamp: autoRunStats.longestRunTimestamp,
											});
										}
									}
								}
								// Silent failure - don't bother the user if submission fails
							})
							.catch(() => {
								// Silent failure - leaderboard submission is not critical
							});
					}
				}
			}
		},
		onPRResult: (info) => {
			// Find group name for the session
			const session = sessions.find((s) => s.id === info.sessionId);
			const sessionGroup = session?.groupId ? groups.find((g) => g.id === session.groupId) : null;
			const groupName = sessionGroup?.name || 'Ungrouped';

			if (info.success) {
				// PR created successfully - show success toast with PR URL
				notifyToast({
					type: 'success',
					title: 'PR Created',
					message: info.prUrl || 'Pull request created successfully',
					group: groupName,
					project: info.sessionName,
					sessionId: info.sessionId,
				});
			} else {
				// PR creation failed - show warning (not error, since the auto-run itself succeeded)
				notifyToast({
					type: 'warning',
					title: 'PR Creation Failed',
					message: info.error || 'Failed to create pull request',
					group: groupName,
					project: info.sessionName,
					sessionId: info.sessionId,
				});
			}
		},
		// Process queued items after batch completion/stop
		// This ensures pending user messages are processed after Auto Run ends
		onProcessQueueAfterCompletion: (sessionId) => {
			const session = sessionsRef.current.find((s) => s.id === sessionId);
			if (session && session.executionQueue.length > 0 && processQueuedItemRef.current) {
				// Pop first item and process it
				const [nextItem, ...remainingQueue] = session.executionQueue;

				// Update session state: set to busy, pop first item from queue
				setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== sessionId) return s;

						const targetTab = s.aiTabs.find((tab) => tab.id === nextItem.tabId) || getActiveTab(s);
						if (!targetTab) {
							return {
								...s,
								state: 'busy' as SessionState,
								busySource: 'ai',
								executionQueue: remainingQueue,
								thinkingStartTime: Date.now(),
							};
						}

						// For message items, add a log entry to the target tab
						let updatedAiTabs = s.aiTabs;
						if (nextItem.type === 'message' && nextItem.text) {
							const logEntry: LogEntry = {
								id: generateId(),
								timestamp: Date.now(),
								source: 'user',
								text: nextItem.text,
								images: nextItem.images,
							};
							updatedAiTabs = s.aiTabs.map((tab) =>
								tab.id === targetTab.id
									? {
											...tab,
											logs: [...tab.logs, logEntry],
											state: 'busy' as const,
										}
									: tab
							);
						}

						return {
							...s,
							state: 'busy' as SessionState,
							busySource: 'ai',
							aiTabs: updatedAiTabs,
							activeTabId: targetTab.id,
							executionQueue: remainingQueue,
							thinkingStartTime: Date.now(),
						};
					})
				);

				// Process the item after state update
				processQueuedItemRef.current(sessionId, nextItem);
			}
		},
	});

	// Update refs for batch processor error handling (Phase 5.10)
	// These are used by the agent error handler which runs in a useEffect with empty deps
	pauseBatchOnErrorRef.current = pauseBatchOnError;
	getBatchStateRef.current = getBatchState;

	// Get batch state for the current session - used for locking the AutoRun editor
	// This is session-specific so users can edit docs in other sessions while one runs
	// Quick Win 4: Memoized to prevent unnecessary re-calculations
	const currentSessionBatchState = useMemo(() => {
		return activeSession ? getBatchState(activeSession.id) : null;
	}, [activeSession, getBatchState]);

	// Get batch state for display - prioritize the session with an active batch run,
	// falling back to the active session's state. This ensures AutoRun progress is
	// displayed correctly regardless of which tab/session the user is viewing.
	// Quick Win 4: Memoized to prevent unnecessary re-calculations
	const activeBatchRunState = useMemo(() => {
		if (activeBatchSessionIds.length > 0) {
			return getBatchState(activeBatchSessionIds[0]);
		}
		return activeSession ? getBatchState(activeSession.id) : getBatchState('');
	}, [activeBatchSessionIds, activeSession, getBatchState]);

	// Inline wizard context for /wizard command
	// This manages the state for the inline wizard that creates/iterates on Auto Run documents
	const {
		startWizard: startInlineWizard,
		endWizard: endInlineWizard,
		clearError: clearInlineWizardError,
		retryLastMessage: retryInlineWizardMessage,
		generateDocuments: generateInlineWizardDocuments,
		sendMessage: sendInlineWizardMessage,
		// State for syncing to session.wizardState
		isWizardActive: inlineWizardActive,
		isWaiting: _inlineWizardIsWaiting,
		wizardMode: _inlineWizardMode,
		wizardGoal: _inlineWizardGoal,
		confidence: _inlineWizardConfidence,
		ready: _inlineWizardReady,
		conversationHistory: _inlineWizardConversationHistory,
		error: _inlineWizardError,
		isGeneratingDocs: _inlineWizardIsGeneratingDocs,
		generatedDocuments: _inlineWizardGeneratedDocuments,
		streamingContent: _inlineWizardStreamingContent,
		generationProgress: _inlineWizardGenerationProgress,
		state: _inlineWizardState,
		wizardTabId: inlineWizardTabId,
		agentSessionId: _inlineWizardAgentSessionId,
		// Per-tab wizard state accessors
		getStateForTab: getInlineWizardStateForTab,
		isWizardActiveForTab: _isInlineWizardActiveForTab,
	} = useInlineWizardContext();

	// Wrapper for sendInlineWizardMessage that adds thinking content callback
	// This extracts thinking content from the streaming response and stores it in wizardState
	const sendWizardMessageWithThinking = useCallback(
		async (content: string) => {
			// Clear previous thinking content and tool executions when starting a new message
			if (activeSession) {
				const activeTab = getActiveTab(activeSession);
				if (activeTab?.wizardState) {
					setSessions((prev) =>
						prev.map((s) => {
							if (s.id !== activeSession.id) return s;
							return {
								...s,
								aiTabs: s.aiTabs.map((tab) => {
									if (tab.id !== activeTab.id) return tab;
									if (!tab.wizardState) return tab;
									return {
										...tab,
										wizardState: {
											...tab.wizardState,
											thinkingContent: '', // Clear previous thinking
											toolExecutions: [], // Clear previous tool executions
										},
									};
								}),
							};
						})
					);
				}
			}

			// Send message with thinking callback
			// Capture session and tab IDs at call time to avoid stale closure issues
			const sessionId = activeSession?.id;
			const tabId = activeSession ? getActiveTab(activeSession)?.id : undefined;

			await sendInlineWizardMessage(content, {
				onThinkingChunk: (chunk) => {
					// Early return if session/tab IDs weren't captured
					if (!sessionId || !tabId) {
						return;
					}

					// Skip JSON-looking content (the structured response) to avoid brief flash of JSON
					// The wizard expects JSON responses like {"confidence": 80, "ready": true, "message": "..."}
					const trimmed = chunk.trim();
					if (
						trimmed.startsWith('{"') &&
						(trimmed.includes('"confidence"') || trimmed.includes('"message"'))
					) {
						return; // Skip structured response JSON
					}

					// Accumulate thinking content in the session state
					// All checks happen inside the updater to use fresh state
					setSessions((prev) =>
						prev.map((s) => {
							if (s.id !== sessionId) return s;
							const tab = s.aiTabs.find((t) => t.id === tabId);

							// Only accumulate if showWizardThinking is enabled
							if (!tab?.wizardState?.showWizardThinking) {
								return s;
							}

							return {
								...s,
								aiTabs: s.aiTabs.map((t) => {
									if (t.id !== tabId) return t;
									if (!t.wizardState) return t;
									return {
										...t,
										wizardState: {
											...t.wizardState,
											thinkingContent: (t.wizardState.thinkingContent || '') + chunk,
										},
									};
								}),
							};
						})
					);
				},
				onToolExecution: (toolEvent) => {
					// Early return if session/tab IDs weren't captured
					if (!sessionId || !tabId) {
						return;
					}

					// Accumulate tool executions in the session state
					// This is crucial for showThinking mode since batch mode doesn't stream assistant messages
					setSessions((prev) =>
						prev.map((s) => {
							if (s.id !== sessionId) return s;
							const tab = s.aiTabs.find((t) => t.id === tabId);

							// Only accumulate if showWizardThinking is enabled
							if (!tab?.wizardState?.showWizardThinking) {
								return s;
							}

							return {
								...s,
								aiTabs: s.aiTabs.map((t) => {
									if (t.id !== tabId) return t;
									if (!t.wizardState) return t;
									return {
										...t,
										wizardState: {
											...t.wizardState,
											toolExecutions: [...(t.wizardState.toolExecutions || []), toolEvent],
										},
									};
								}),
							};
						})
					);
				},
			});
		},
		[activeSession, sendInlineWizardMessage, setSessions]
	);

	// Sync inline wizard context state to activeTab.wizardState (per-tab wizard state)
	// This bridges the gap between the context-based state and tab-based UI rendering
	// Each tab maintains its own independent wizard state
	useEffect(() => {
		if (!activeSession) return;

		const activeTab = getActiveTab(activeSession);
		const activeTabId = activeTab?.id;
		if (!activeTabId) return;

		// Get the wizard state for the CURRENT tab using the per-tab accessor
		const tabWizardState = getInlineWizardStateForTab(activeTabId);
		const hasWizardOnThisTab = tabWizardState?.isActive || tabWizardState?.isGeneratingDocs;
		const currentTabWizardState = activeTab?.wizardState;

		if (!hasWizardOnThisTab && !currentTabWizardState) {
			// Neither active nor has state on this tab - nothing to do
			return;
		}

		if (!hasWizardOnThisTab && currentTabWizardState) {
			// Wizard was deactivated on this tab - clear the tab's wizard state
			setSessions((prev) =>
				prev.map((s) => {
					if (s.id !== activeSession.id) return s;
					return {
						...s,
						aiTabs: s.aiTabs.map((tab) =>
							tab.id === activeTabId ? { ...tab, wizardState: undefined } : tab
						),
					};
				})
			);
			return;
		}

		if (!tabWizardState) {
			// No wizard state for this tab - nothing to sync
			return;
		}

		// Sync the wizard state to this specific tab
		// IMPORTANT: showWizardThinking and thinkingContent are preserved from the LATEST state
		// inside the setSessions updater to avoid stale closure issues. These are managed by
		// the toggle and onThinkingChunk callback, not by the hook.
		setSessions((prev) =>
			prev.map((s) => {
				if (s.id !== activeSession.id) return s;

				// Read the LATEST wizard state from prev, not from captured currentTabWizardState
				// This prevents stale closure issues when the toggle or callback updates state
				const latestTab = s.aiTabs.find((tab) => tab.id === activeTabId);
				const latestWizardState = latestTab?.wizardState;

				const newWizardState = {
					isActive: tabWizardState.isActive,
					isWaiting: tabWizardState.isWaiting,
					mode: tabWizardState.mode === 'ask' ? 'new' : tabWizardState.mode, // Map 'ask' to 'new' for session state
					goal: tabWizardState.goal ?? undefined,
					confidence: tabWizardState.confidence,
					ready: tabWizardState.ready,
					conversationHistory: tabWizardState.conversationHistory.map((msg) => ({
						id: msg.id,
						role: msg.role,
						content: msg.content,
						timestamp: msg.timestamp,
						confidence: msg.confidence,
						ready: msg.ready,
					})),
					previousUIState: tabWizardState.previousUIState ?? {
						readOnlyMode: false,
						saveToHistory: true,
						showThinking: 'off',
					},
					error: tabWizardState.error,
					isGeneratingDocs: tabWizardState.isGeneratingDocs,
					generatedDocuments: tabWizardState.generatedDocuments.map((doc) => ({
						filename: doc.filename,
						content: doc.content,
						taskCount: doc.taskCount,
						savedPath: doc.savedPath,
					})),
					streamingContent: tabWizardState.streamingContent,
					currentDocumentIndex: tabWizardState.currentDocumentIndex,
					currentGeneratingIndex: tabWizardState.generationProgress?.current,
					totalDocuments: tabWizardState.generationProgress?.total,
					autoRunFolderPath: tabWizardState.projectPath
						? `${tabWizardState.projectPath}/Auto Run Docs`
						: undefined,
					// Full path to subfolder where documents are saved (e.g., "/path/Auto Run Docs/Maestro-Marketing")
					subfolderPath: tabWizardState.subfolderPath ?? undefined,
					agentSessionId: tabWizardState.agentSessionId ?? undefined,
					// Track the subfolder name for tab naming after wizard completes
					subfolderName: tabWizardState.subfolderName ?? undefined,
					// Preserve thinking state from LATEST state (inside updater) to avoid stale closure
					showWizardThinking: latestWizardState?.showWizardThinking ?? false,
					thinkingContent: latestWizardState?.thinkingContent ?? '',
				};

				return {
					...s,
					aiTabs: s.aiTabs.map((tab) =>
						tab.id === activeTabId ? { ...tab, wizardState: newWizardState } : tab
					),
				};
			})
		);
	}, [
		activeSession?.id,
		activeSession?.activeTabId,
		// getInlineWizardStateForTab changes when tabStates Map changes (new wizard state for any tab)
		// This ensures we re-sync when the active tab's wizard state changes
		getInlineWizardStateForTab,
		setSessions,
	]);

	// Handler for the built-in /history command
	// Requests a synopsis from the current agent session and saves to history
	const handleHistoryCommand = useCallback(async () => {
		if (!activeSession) {
			console.warn('[handleHistoryCommand] No active session');
			return;
		}

		const activeTab = getActiveTab(activeSession);
		const agentSessionId = activeTab?.agentSessionId;

		if (!agentSessionId) {
			// No agent session yet - show error log
			const errorLog: LogEntry = {
				id: generateId(),
				timestamp: Date.now(),
				source: 'system',
				text: 'No active agent session. Start a conversation first before using /history.',
			};
			addLogToActiveTab(activeSession.id, errorLog);
			return;
		}

		// Show a pending log entry while synopsis is being generated
		const pendingLog: LogEntry = {
			id: generateId(),
			timestamp: Date.now(),
			source: 'system',
			text: 'Generating history synopsis...',
		};
		addLogToActiveTab(activeSession.id, pendingLog);

		try {
			// Build dynamic prompt based on whether there's a previous synopsis timestamp
			// This ensures the AI only summarizes work since the last synopsis
			let synopsisPrompt: string;
			if (activeTab.lastSynopsisTime) {
				const timeAgo = formatRelativeTime(activeTab.lastSynopsisTime);
				synopsisPrompt = `${autorunSynopsisPrompt}\n\nIMPORTANT: Only synopsize work done since the last synopsis (${timeAgo}). Do not repeat previous work.`;
			} else {
				synopsisPrompt = autorunSynopsisPrompt;
			}
			const synopsisTime = Date.now(); // Capture time for updating lastSynopsisTime

			// Request synopsis from the agent
			const result = await spawnBackgroundSynopsis(
				activeSession.id,
				activeSession.cwd,
				agentSessionId,
				synopsisPrompt,
				activeSession.toolType,
				{
					customPath: activeSession.customPath,
					customArgs: activeSession.customArgs,
					customEnvVars: activeSession.customEnvVars,
					customModel: activeSession.customModel,
					customContextWindow: activeSession.customContextWindow,
					sessionSshRemoteConfig: activeSession.sessionSshRemoteConfig,
				}
			);

			if (result.success && result.response) {
				// Parse the synopsis response
				const parsed = parseSynopsis(result.response);

				// Check if AI indicated nothing meaningful to report
				if (parsed.nothingToReport) {
					// Update the pending log to indicate nothing to report
					setSessions((prev) =>
						prev.map((s) => {
							if (s.id !== activeSession.id) return s;
							return {
								...s,
								aiTabs: s.aiTabs.map((tab) => {
									if (tab.id !== activeTab.id) return tab;
									return {
										...tab,
										logs: tab.logs.map((log) =>
											log.id === pendingLog.id
												? {
														...log,
														text: 'Nothing to report - no history entry created.',
													}
												: log
										),
									};
								}),
							};
						})
					);
					return;
				}

				// Get group info for the history entry
				const group = groups.find((g) => g.id === activeSession.groupId);
				const groupName = group?.name || 'Ungrouped';

				// Calculate elapsed time since last synopsis (or tab creation if no previous synopsis)
				const elapsedTimeMs = activeTab.lastSynopsisTime
					? synopsisTime - activeTab.lastSynopsisTime
					: synopsisTime - activeTab.createdAt;

				// Add to history
				addHistoryEntry({
					type: 'AUTO',
					summary: parsed.shortSummary,
					fullResponse: parsed.fullSynopsis,
					agentSessionId: agentSessionId,
					sessionId: activeSession.id,
					projectPath: activeSession.cwd,
					sessionName: activeTab.name || undefined,
					usageStats: result.usageStats,
					elapsedTimeMs,
				});

				// Update the pending log with success AND set lastSynopsisTime
				setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== activeSession.id) return s;
						return {
							...s,
							aiTabs: s.aiTabs.map((tab) => {
								if (tab.id !== activeTab.id) return tab;
								return {
									...tab,
									lastSynopsisTime: synopsisTime, // Track when this synopsis was generated
									logs: tab.logs.map((log) =>
										log.id === pendingLog.id
											? {
													...log,
													text: `Synopsis saved to history: ${parsed.shortSummary}`,
												}
											: log
									),
								};
							}),
						};
					})
				);

				// Show toast
				notifyToast({
					type: 'success',
					title: 'History Entry Added',
					message: parsed.shortSummary,
					group: groupName,
					project: activeSession.name,
					sessionId: activeSession.id,
					tabId: activeTab.id,
					tabName: activeTab.name || undefined,
				});
			} else {
				// Synopsis generation failed
				setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== activeSession.id) return s;
						return {
							...s,
							aiTabs: s.aiTabs.map((tab) => {
								if (tab.id !== activeTab.id) return tab;
								return {
									...tab,
									logs: tab.logs.map((log) =>
										log.id === pendingLog.id
											? {
													...log,
													text: 'Failed to generate history synopsis. Try again.',
												}
											: log
									),
								};
							}),
						};
					})
				);
			}
		} catch (error) {
			console.error('[handleHistoryCommand] Error:', error);
			// Update the pending log with error
			setSessions((prev) =>
				prev.map((s) => {
					if (s.id !== activeSession.id) return s;
					return {
						...s,
						aiTabs: s.aiTabs.map((tab) => {
							if (tab.id !== activeTab.id) return tab;
							return {
								...tab,
								logs: tab.logs.map((log) =>
									log.id === pendingLog.id
										? {
												...log,
												text: `Error generating synopsis: ${(error as Error).message}`,
											}
										: log
								),
							};
						}),
					};
				})
			);
		}
	}, [activeSession, groups, spawnBackgroundSynopsis, addHistoryEntry, setSessions]);

	// Handler for the built-in /skills command (Claude Code only)
	// Lists available skills from .claude/skills/ directories
	const handleSkillsCommand = useCallback(async () => {
		if (!activeSession) {
			console.warn('[handleSkillsCommand] No active session');
			return;
		}

		if (activeSession.toolType !== 'claude-code') {
			console.warn('[handleSkillsCommand] Skills command only available for Claude Code');
			return;
		}

		const activeTab = getActiveTab(activeSession);
		if (!activeTab) {
			console.warn('[handleSkillsCommand] No active tab');
			return;
		}

		try {
			// Add user log entry showing the /skills command was requested
			const userLog: LogEntry = {
				id: generateId(),
				timestamp: Date.now(),
				source: 'user',
				text: '/skills',
			};
			addLogToActiveTab(activeSession.id, userLog);

			// Fetch skills from the IPC handler
			const skills = await window.maestro.claude.getSkills(activeSession.projectRoot);

			// Format skills as a markdown table
			let skillsMessage: string;
			if (skills.length === 0) {
				skillsMessage =
					'## Skills\n\nNo Claude Code skills were found in this project.\n\nTo add skills, create `.claude/skills/<skill-name>/skill.md` files in your project.';
			} else {
				const formatTokenCount = (tokens: number): string => {
					if (tokens >= 1000) {
						return `~${(tokens / 1000).toFixed(1)}k`;
					}
					return `~${tokens}`;
				};

				const projectSkills = skills.filter((s) => s.source === 'project');
				const userSkills = skills.filter((s) => s.source === 'user');

				const lines: string[] = [
					`## Skills`,
					'',
					`${skills.length} skill${skills.length !== 1 ? 's' : ''} available`,
					'',
				];

				if (projectSkills.length > 0) {
					lines.push('### Project Skills');
					lines.push('');
					lines.push('| Skill | Tokens | Description |');
					lines.push('|-------|--------|-------------|');
					for (const skill of projectSkills) {
						const desc =
							skill.description && skill.description !== 'No description' ? skill.description : '—';
						lines.push(`| **${skill.name}** | ${formatTokenCount(skill.tokenCount)} | ${desc} |`);
					}
					lines.push('');
				}

				if (userSkills.length > 0) {
					lines.push('### User Skills');
					lines.push('');
					lines.push('| Skill | Tokens | Description |');
					lines.push('|-------|--------|-------------|');
					for (const skill of userSkills) {
						const desc =
							skill.description && skill.description !== 'No description' ? skill.description : '—';
						lines.push(`| **${skill.name}** | ${formatTokenCount(skill.tokenCount)} | ${desc} |`);
					}
				}

				skillsMessage = lines.join('\n');
			}

			// Add the skills listing as a system log entry
			const skillsLog: LogEntry = {
				id: generateId(),
				timestamp: Date.now(),
				source: 'system',
				text: skillsMessage,
			};
			addLogToActiveTab(activeSession.id, skillsLog);
		} catch (error) {
			console.error('[handleSkillsCommand] Error:', error);
			const errorLog: LogEntry = {
				id: generateId(),
				timestamp: Date.now(),
				source: 'system',
				text: `Error listing skills: ${(error as Error).message}`,
			};
			addLogToActiveTab(activeSession.id, errorLog);
		}
	}, [activeSession]);

	// Handler for the built-in /wizard command
	// Starts the inline wizard for creating/iterating on Auto Run documents
	const handleWizardCommand = useCallback(
		(args: string) => {
			if (!activeSession) {
				console.warn('[handleWizardCommand] No active session');
				return;
			}

			const activeTab = getActiveTab(activeSession);
			if (!activeTab) {
				console.warn('[handleWizardCommand] No active tab');
				return;
			}

			// Capture current UI state for restoration when wizard ends
			const currentUIState: PreviousUIState = {
				readOnlyMode: activeTab.readOnlyMode ?? false,
				saveToHistory: activeTab.saveToHistory ?? true,
				showThinking: activeTab.showThinking ?? 'off',
			};

			// Start the inline wizard with the argument text (natural language input)
			// The wizard will use the intent parser to determine mode (new/iterate/ask)
			startInlineWizard(
				args || undefined,
				currentUIState,
				activeSession.projectRoot || activeSession.cwd, // Project path for Auto Run folder detection
				activeSession.toolType, // Agent type for AI conversation
				activeSession.name, // Session/project name
				activeTab.id, // Tab ID for per-tab isolation
				activeSession.id, // Session ID for playbook creation
				activeSession.autoRunFolderPath, // User-configured Auto Run folder path (if set)
				activeSession.sessionSshRemoteConfig, // SSH remote config for remote execution
				conductorProfile, // Conductor profile (user's About Me from settings)
				{
					customPath: activeSession.customPath,
					customArgs: activeSession.customArgs,
					customEnvVars: activeSession.customEnvVars,
					customModel: activeSession.customModel,
				}
			);

			// Rename the tab to "Wizard" immediately when wizard starts
			// This provides visual feedback that wizard mode is active
			// The tab will be renamed again on completion if a subfolder is chosen
			setSessions((prev) =>
				prev.map((s) => {
					if (s.id !== activeSession.id) return s;
					return {
						...s,
						aiTabs: s.aiTabs.map((tab) =>
							tab.id === activeTab.id ? { ...tab, name: 'Wizard' } : tab
						),
					};
				})
			);

			// Show a system log entry indicating wizard started
			const wizardLog: LogEntry = {
				id: generateId(),
				timestamp: Date.now(),
				source: 'system',
				text: args
					? `Starting wizard with: "${args}"`
					: 'Starting wizard for Auto Run documents...',
			};
			addLogToActiveTab(activeSession.id, wizardLog);
		},
		[activeSession, startInlineWizard, conductorProfile]
	);

	// Launch wizard in a new tab - triggered from Auto Run panel button
	const handleLaunchWizardTab = useCallback(() => {
		if (!activeSession) {
			console.warn('[handleLaunchWizardTab] No active session');
			return;
		}

		// Create a new tab first
		const result = createTab(activeSession, {
			name: 'Wizard',
			saveToHistory: defaultSaveToHistory,
			showThinking: defaultShowThinking,
		});
		if (!result) {
			console.warn('[handleLaunchWizardTab] Failed to create new tab');
			return;
		}

		const newTab = result.tab;
		const updatedSession = result.session;

		// Update sessions with new tab and switch to it
		setSessions((prev) =>
			prev.map((s) => {
				if (s.id !== activeSession.id) return s;
				return {
					...updatedSession,
					activeTabId: newTab.id,
				};
			})
		);

		// Capture UI state for the new tab (defaults since it's a fresh tab)
		const currentUIState: PreviousUIState = {
			readOnlyMode: false,
			saveToHistory: defaultSaveToHistory,
			showThinking: defaultShowThinking,
		};

		// Start the inline wizard in the new tab
		// Use setTimeout to ensure state is updated before starting wizard
		setTimeout(() => {
			startInlineWizard(
				undefined, // No args - start fresh
				currentUIState,
				activeSession.projectRoot || activeSession.cwd,
				activeSession.toolType,
				activeSession.name,
				newTab.id,
				activeSession.id,
				activeSession.autoRunFolderPath, // User-configured Auto Run folder path (if set)
				activeSession.sessionSshRemoteConfig, // SSH remote config for remote execution
				conductorProfile, // Conductor profile (user's About Me from settings)
				{
					customPath: activeSession.customPath,
					customArgs: activeSession.customArgs,
					customEnvVars: activeSession.customEnvVars,
					customModel: activeSession.customModel,
				}
			);

			// Show a system log entry
			const wizardLog = {
				source: 'system' as const,
				text: 'Starting wizard for Auto Run documents...',
			};
			addLogToTab(activeSession.id, wizardLog, newTab.id);
		}, 0);
	}, [
		activeSession,
		createTab,
		defaultSaveToHistory,
		defaultShowThinking,
		startInlineWizard,
		conductorProfile,
	]);

	// Determine if wizard is active for the current tab
	// We need to check both the context state and that we're on the wizard's tab
	// IMPORTANT: Include activeSession?.activeTabId in deps to recompute when user switches tabs
	const isWizardActiveForCurrentTab = useMemo(() => {
		if (!activeSession || !inlineWizardActive) return false;
		const activeTab = getActiveTab(activeSession);
		return activeTab?.id === inlineWizardTabId;
	}, [activeSession, activeSession?.activeTabId, inlineWizardActive, inlineWizardTabId]);

	// Input processing hook - handles sending messages and commands
	const { processInput, processInputRef: _hookProcessInputRef } = useInputProcessing({
		activeSession,
		activeSessionId,
		setSessions,
		inputValue,
		setInputValue,
		stagedImages,
		setStagedImages,
		inputRef,
		customAICommands: allCustomCommands, // Use combined custom + speckit commands
		setSlashCommandOpen,
		syncAiInputToSession,
		syncTerminalInputToSession,
		isAiMode,
		sessionsRef,
		getBatchState,
		activeBatchRunState,
		processQueuedItemRef,
		flushBatchedUpdates: batchedUpdater.flushNow,
		onHistoryCommand: handleHistoryCommand,
		onWizardCommand: handleWizardCommand,
		onWizardSendMessage: sendWizardMessageWithThinking,
		isWizardActive: isWizardActiveForCurrentTab,
		onSkillsCommand: handleSkillsCommand,
		automaticTabNamingEnabled,
		conductorProfile,
	});

	// Auto-send context when a tab with autoSendOnActivate becomes active
	// PERF: Sync processInputRef from hook to our local ref for use in memoized callbacks
	useEffect(() => {
		processInputRef.current = processInput;
	}, [processInput]);

	// This is used by context transfer to automatically send the transferred context to the agent
	useEffect(() => {
		if (!activeSession) return;

		const activeTab = getActiveTab(activeSession);
		if (!activeTab?.autoSendOnActivate) return;

		// Clear the flag first to prevent multiple sends
		setSessions((prev) =>
			prev.map((s) => {
				if (s.id !== activeSession.id) return s;
				return {
					...s,
					aiTabs: s.aiTabs.map((tab) =>
						tab.id === activeTab.id ? { ...tab, autoSendOnActivate: false } : tab
					),
				};
			})
		);

		// Trigger the send after a short delay to ensure state is settled
		// The inputValue and pendingMergedContext are already set on the tab
		setTimeout(() => {
			processInput();
		}, 100);
	}, [activeSession?.id, activeSession?.activeTabId]);

	// Initialize activity tracker for per-session time tracking
	useActivityTracker(activeSessionId, setSessions);

	// Initialize global hands-on time tracker (persists to settings)
	// Tracks total time user spends actively using Maestro (5-minute idle timeout)
	useHandsOnTimeTracker(updateGlobalStats);

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

	// Handler to stop batch run (with confirmation)
	// If targetSessionId is provided, stops that specific session's batch run.
	// Otherwise, falls back to active session, then first active batch run.
	const handleStopBatchRun = useCallback(
		(targetSessionId?: string) => {
			// Use provided targetSessionId, or fall back to active session, or first active batch
			const sessionId =
				targetSessionId ??
				activeSession?.id ??
				(activeBatchSessionIds.length > 0 ? activeBatchSessionIds[0] : undefined);
			console.log(
				'[App:handleStopBatchRun] targetSessionId:',
				targetSessionId,
				'resolved sessionId:',
				sessionId
			);
			if (!sessionId) return;
			const session = sessions.find((s) => s.id === sessionId);
			const agentName = session?.name || 'this session';
			useModalStore.getState().openModal('confirm', {
				message: `Stop Auto Run for "${agentName}" after the current task completes?`,
				onConfirm: () => {
					console.log(
						'[App:handleStopBatchRun] Confirmation callback executing for sessionId:',
						sessionId
					);
					stopBatchRun(sessionId);
				},
			});
		},
		[activeBatchSessionIds, activeSession, sessions, stopBatchRun]
	);

	// Handler to force kill a batch run (process killed immediately, no waiting)
	// Confirmation is handled by the calling component's own modal
	const handleKillBatchRun = useCallback(
		async (sessionId: string) => {
			console.log('[App:handleKillBatchRun] Force killing sessionId:', sessionId);
			await killBatchRun(sessionId);
		},
		[killBatchRun]
	);

	// Error handling callbacks for Auto Run (Phase 5.10)
	const handleSkipCurrentDocument = useCallback(() => {
		const sessionId =
			activeBatchSessionIds.length > 0 ? activeBatchSessionIds[0] : activeSession?.id;
		if (!sessionId) return;
		skipCurrentDocument(sessionId);
		// Clear the session error state as well
		handleClearAgentError(sessionId);
	}, [activeBatchSessionIds, activeSession, skipCurrentDocument, handleClearAgentError]);

	const handleResumeAfterError = useCallback(() => {
		const sessionId =
			activeBatchSessionIds.length > 0 ? activeBatchSessionIds[0] : activeSession?.id;
		if (!sessionId) return;
		resumeAfterError(sessionId);
		// Clear the session error state as well
		handleClearAgentError(sessionId);
	}, [activeBatchSessionIds, activeSession, resumeAfterError, handleClearAgentError]);

	const handleAbortBatchOnError = useCallback(() => {
		const sessionId =
			activeBatchSessionIds.length > 0 ? activeBatchSessionIds[0] : activeSession?.id;
		if (!sessionId) return;
		abortBatchOnError(sessionId);
		// Clear the session error state as well
		handleClearAgentError(sessionId);
	}, [activeBatchSessionIds, activeSession, abortBatchOnError, handleClearAgentError]);

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

	// AppSessionModals handlers that depend on flushSessionPersistence
	const handleSaveEditAgent = useCallback(
		(
			sessionId: string,
			name: string,
			nudgeMessage?: string,
			customPath?: string,
			customArgs?: string,
			customEnvVars?: Record<string, string>,
			customModel?: string,
			customContextWindow?: number,
			sessionSshRemoteConfig?: {
				enabled: boolean;
				remoteId: string | null;
				workingDirOverride?: string;
			}
		) => {
			setSessions((prev) =>
				prev.map((s) => {
					if (s.id !== sessionId) return s;
					return {
						...s,
						name,
						nudgeMessage,
						customPath,
						customArgs,
						customEnvVars,
						customModel,
						customContextWindow,
						sessionSshRemoteConfig,
					};
				})
			);
		},
		[]
	);

	const handleRenameTab = useCallback(
		(newName: string) => {
			if (!activeSession || !renameTabId) return;
			setSessions((prev) =>
				prev.map((s) => {
					if (s.id !== activeSession.id) return s;
					// Find the tab to get its agentSessionId for persistence
					const tab = s.aiTabs.find((t) => t.id === renameTabId);
					const oldName = tab?.name;

					window.maestro.logger.log(
						'info',
						`Tab renamed: "${oldName || '(auto)'}" → "${newName || '(cleared)'}"`,
						'TabNaming',
						{
							tabId: renameTabId,
							sessionId: activeSession.id,
							agentSessionId: tab?.agentSessionId,
							oldName,
							newName: newName || null,
						}
					);

					if (tab?.agentSessionId) {
						// Persist name to agent session metadata (async, fire and forget)
						// Use projectRoot (not cwd) for consistent session storage access
						const agentId = s.toolType || 'claude-code';
						if (agentId === 'claude-code') {
							window.maestro.claude
								.updateSessionName(s.projectRoot, tab.agentSessionId, newName || '')
								.catch((err) => {
									window.maestro.logger.log(
										'error',
										'Failed to persist tab name to Claude session storage',
										'TabNaming',
										{
											tabId: renameTabId,
											agentSessionId: tab.agentSessionId,
											error: String(err),
										}
									);
								});
						} else {
							window.maestro.agentSessions
								.setSessionName(agentId, s.projectRoot, tab.agentSessionId, newName || null)
								.catch((err) => {
									window.maestro.logger.log(
										'error',
										'Failed to persist tab name to agent session storage',
										'TabNaming',
										{
											tabId: renameTabId,
											agentSessionId: tab.agentSessionId,
											agentType: agentId,
											error: String(err),
										}
									);
								});
						}
						// Also update past history entries with this agentSessionId
						window.maestro.history
							.updateSessionName(tab.agentSessionId, newName || '')
							.catch((err) => {
								window.maestro.logger.log(
									'warn',
									'Failed to update history session names',
									'TabNaming',
									{
										agentSessionId: tab.agentSessionId,
										error: String(err),
									}
								);
							});
					} else {
						window.maestro.logger.log(
							'info',
							'Tab renamed (no agentSessionId, skipping persistence)',
							'TabNaming',
							{
								tabId: renameTabId,
							}
						);
					}
					return {
						...s,
						aiTabs: s.aiTabs.map((tab) =>
							// Clear isGeneratingName to cancel any in-progress automatic naming
							tab.id === renameTabId
								? { ...tab, name: newName || null, isGeneratingName: false }
								: tab
						),
					};
				})
			);
		},
		[activeSession, renameTabId]
	);

	// Persist groups directly (groups change infrequently, no need to debounce)
	useEffect(() => {
		if (initialLoadComplete.current) {
			window.maestro.groups.setAll(groups);
		}
	}, [groups]);

	// NOTE: Theme CSS variables and scrollbar fade animations are now handled by useThemeStyles hook
	// NOTE: Main keyboard handler is now provided by useMainKeyboardHandler hook
	// NOTE: Sync selectedSidebarIndex with activeSessionId is now handled by useKeyboardNavigation hook

	// Restore file tree scroll position when switching sessions
	useEffect(() => {
		if (
			activeSession &&
			fileTreeContainerRef.current &&
			activeSession.fileExplorerScrollPos !== undefined
		) {
			fileTreeContainerRef.current.scrollTop = activeSession.fileExplorerScrollPos;
		}
	}, [activeSessionId]); // Only restore on session switch, not on scroll position changes

	// Track navigation history when session or AI tab changes
	useEffect(() => {
		if (activeSession) {
			pushNavigation({
				sessionId: activeSession.id,
				tabId:
					activeSession.inputMode === 'ai' && activeSession.aiTabs?.length > 0
						? activeSession.activeTabId
						: undefined,
			});
		}
	}, [activeSessionId, activeSession?.activeTabId]); // Track session and tab changes

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

	// PERF: Memoize to prevent breaking React.memo on MainPanel
	const showConfirmation = useCallback((message: string, onConfirm: () => void) => {
		// Use openModal with data in a single call to avoid race condition where
		// updateModalData fails because the modal hasn't been opened yet (no existing data)
		useModalStore.getState().openModal('confirm', { message, onConfirm });
	}, []);

	const deleteSession = (id: string) => {
		const session = sessions.find((s) => s.id === id);
		if (!session) return;

		// Open the delete agent modal (setDeleteAgentSession opens the modal with session data)
		setDeleteAgentSession(session);
	};

	// Internal function to perform the actual session deletion
	const performDeleteSession = useCallback(
		async (session: Session, eraseWorkingDirectory: boolean) => {
			const id = session.id;

			// Record session closure for Usage Dashboard (before cleanup)
			window.maestro.stats.recordSessionClosed(id, Date.now());

			// Kill both processes for this session
			try {
				await window.maestro.process.kill(`${id}-ai`);
			} catch (error) {
				console.error('Failed to kill AI process:', error);
			}

			try {
				await window.maestro.process.kill(`${id}-terminal`);
			} catch (error) {
				console.error('Failed to kill terminal process:', error);
			}

			// Delete associated playbooks
			try {
				await window.maestro.playbooks.deleteAll(id);
			} catch (error) {
				console.error('Failed to delete playbooks:', error);
			}

			// If this is a worktree session, track its path to prevent re-discovery
			if (session.worktreeParentPath && session.cwd) {
				setRemovedWorktreePaths((prev) => new Set([...prev, session.cwd]));
			}

			// Optionally erase the working directory (move to trash)
			if (eraseWorkingDirectory && session.cwd) {
				try {
					await window.maestro.shell.trashItem(session.cwd);
				} catch (error) {
					console.error('Failed to move working directory to trash:', error);
					// Show a toast notification about the failure
					notifyToast({
						title: 'Failed to Erase Directory',
						message: error instanceof Error ? error.message : 'Unknown error',
						type: 'error',
					});
				}
			}

			const newSessions = sessions.filter((s) => s.id !== id);
			setSessions(newSessions);
			// Flush immediately for critical operation (session deletion)
			// Note: flushSessionPersistence will pick up the latest state via ref
			setTimeout(() => flushSessionPersistence(), 0);
			if (newSessions.length > 0) {
				setActiveSessionId(newSessions[0].id);
			} else {
				setActiveSessionId('');
			}
		},
		[sessions, setSessions, setActiveSessionId, flushSessionPersistence, setRemovedWorktreePaths]
	);

	// Delete an entire worktree group and all its agents
	const deleteWorktreeGroup = (groupId: string) => {
		const group = groups.find((g) => g.id === groupId);
		if (!group) return;

		const groupSessions = sessions.filter((s) => s.groupId === groupId);
		const sessionCount = groupSessions.length;

		showConfirmation(
			`Are you sure you want to remove the group "${group.name}" and all ${sessionCount} agent${
				sessionCount !== 1 ? 's' : ''
			} in it? This action cannot be undone.`,
			async () => {
				// Kill processes and delete playbooks for each session
				for (const session of groupSessions) {
					try {
						await window.maestro.process.kill(`${session.id}-ai`);
					} catch (error) {
						console.error('Failed to kill AI process:', error);
					}

					try {
						await window.maestro.process.kill(`${session.id}-terminal`);
					} catch (error) {
						console.error('Failed to kill terminal process:', error);
					}

					try {
						await window.maestro.playbooks.deleteAll(session.id);
					} catch (error) {
						console.error('Failed to delete playbooks:', error);
					}
				}

				// Track all removed paths to prevent re-discovery
				const pathsToTrack = groupSessions
					.filter((s) => s.worktreeParentPath && s.cwd)
					.map((s) => s.cwd);

				if (pathsToTrack.length > 0) {
					setRemovedWorktreePaths((prev) => new Set([...prev, ...pathsToTrack]));
				}

				// Remove all sessions in the group
				const sessionIdsToRemove = new Set(groupSessions.map((s) => s.id));
				const newSessions = sessions.filter((s) => !sessionIdsToRemove.has(s.id));
				setSessions(newSessions);

				// Remove the group
				setGroups((prev) => prev.filter((g) => g.id !== groupId));

				// Flush immediately for critical operation
				setTimeout(() => flushSessionPersistence(), 0);

				// Switch to another session if needed
				if (sessionIdsToRemove.has(activeSessionId) && newSessions.length > 0) {
					setActiveSessionId(newSessions[0].id);
				} else if (newSessions.length === 0) {
					setActiveSessionId('');
				}

				notifyToast({
					type: 'success',
					title: 'Group Removed',
					message: `Removed "${group.name}" and ${sessionCount} agent${
						sessionCount !== 1 ? 's' : ''
					}`,
				});
			}
		);
	};

	const addNewSession = () => {
		setNewInstanceModalOpen(true);
	};

	const createNewSession = async (
		agentId: string,
		workingDir: string,
		name: string,
		nudgeMessage?: string,
		customPath?: string,
		customArgs?: string,
		customEnvVars?: Record<string, string>,
		customModel?: string,
		customContextWindow?: number,
		customProviderPath?: string,
		sessionSshRemoteConfig?: {
			enabled: boolean;
			remoteId: string | null;
			workingDirOverride?: string;
		}
	) => {
		// Get agent definition to get correct command
		const agent = await window.maestro.agents.get(agentId);
		if (!agent) {
			console.error(`Agent not found: ${agentId}`);
			return;
		}

		try {
			// Always create a single session for the selected directory
			// Worktree scanning/creation is now handled explicitly via the worktree config modal
			// Validate uniqueness before creating
			const validation = validateNewSession(name, workingDir, agentId as ToolType, sessions);
			if (!validation.valid) {
				console.error(`Session validation failed: ${validation.error}`);
				notifyToast({
					type: 'error',
					title: 'Session Creation Failed',
					message: validation.error || 'Cannot create duplicate session',
				});
				return;
			}

			const newId = generateId();
			const aiPid = 0;

			// For SSH sessions, defer git check until onSshRemote fires (SSH connection established)
			// For local sessions, check git repo status immediately
			const isRemoteSession = sessionSshRemoteConfig?.enabled && sessionSshRemoteConfig.remoteId;
			let isGitRepo = false;
			let gitBranches: string[] | undefined;
			let gitTags: string[] | undefined;
			let gitRefsCacheTime: number | undefined;

			if (!isRemoteSession) {
				// Local session - check git repo status now
				isGitRepo = await gitService.isRepo(workingDir);
				if (isGitRepo) {
					[gitBranches, gitTags] = await Promise.all([
						gitService.getBranches(workingDir),
						gitService.getTags(workingDir),
					]);
					gitRefsCacheTime = Date.now();
				}
			}
			// For SSH sessions: isGitRepo stays false until onSshRemote callback fires
			// and rechecks with the established SSH connection

			// Create initial fresh tab for new sessions
			const initialTabId = generateId();
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
				showThinking: defaultShowThinking,
			};

			const newSession: Session = {
				id: newId,
				name,
				toolType: agentId as ToolType,
				state: 'idle',
				cwd: workingDir,
				fullPath: workingDir,
				projectRoot: workingDir, // Store the initial directory (never changes)
				isGitRepo,
				gitBranches,
				gitTags,
				gitRefsCacheTime,
				aiLogs: [], // Deprecated - logs are now in aiTabs
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
				inputMode: agentId === 'terminal' ? 'terminal' : 'ai',
				// AI process PID (terminal uses runCommand which spawns fresh shells)
				// For agents that requiresPromptToStart, this starts as 0 and gets set on first message
				aiPid,
				terminalPid: 0,
				port: 3000 + Math.floor(Math.random() * 100),
				isLive: false,
				changedFiles: [],
				fileTree: [],
				fileExplorerExpanded: [],
				fileExplorerScrollPos: 0,
				fileTreeAutoRefreshInterval: 180, // Default: auto-refresh every 3 minutes
				shellCwd: workingDir,
				aiCommandHistory: [],
				shellCommandHistory: [],
				executionQueue: [],
				activeTimeMs: 0,
				// Tab management - start with a fresh empty tab
				aiTabs: [initialTab],
				activeTabId: initialTabId,
				closedTabHistory: [],
				// File preview tabs - start empty, unified tab order starts with initial AI tab
				filePreviewTabs: [],
				activeFileTabId: null,
				unifiedTabOrder: [{ type: 'ai' as const, id: initialTabId }],
				unifiedClosedTabHistory: [],
				// Nudge message - appended to every interactive user message
				nudgeMessage,
				// Per-agent config (path, args, env vars, model)
				customPath,
				customArgs,
				customEnvVars,
				customModel,
				customContextWindow,
				customProviderPath,
				// Per-session SSH remote config (takes precedence over agent-level SSH config)
				sessionSshRemoteConfig,
				// Default Auto Run folder path (user can change later)
				autoRunFolderPath: `${workingDir}/${AUTO_RUN_FOLDER_NAME}`,
			};
			setSessions((prev) => [...prev, newSession]);
			setActiveSessionId(newId);
			// Track session creation in global stats
			updateGlobalStats({ totalSessions: 1 });
			// Record session lifecycle for Usage Dashboard
			window.maestro.stats.recordSessionCreated({
				sessionId: newId,
				agentType: agentId,
				projectPath: workingDir,
				createdAt: Date.now(),
				isRemote: !!isRemoteSession,
			});
			// Auto-focus the input so user can start typing immediately
			// Use a small delay to ensure the modal has closed and the UI has updated
			setActiveFocus('main');
			setTimeout(() => inputRef.current?.focus(), 50);
		} catch (error) {
			console.error('Failed to create session:', error);
			// TODO: Show error to user
		}
	};

	/**
	 * Handle wizard completion - create session with Auto Run configured
	 * Called when user clicks "I'm Ready to Go" or "Walk Me Through the Interface"
	 */
	const handleWizardLaunchSession = useCallback(
		async (wantsTour: boolean) => {
			// Get wizard state
			const {
				selectedAgent,
				directoryPath,
				agentName,
				generatedDocuments,
				customPath,
				customArgs,
				customEnvVars,
				sessionSshRemoteConfig,
			} = wizardState;

			if (!selectedAgent || !directoryPath) {
				console.error('Wizard launch failed: missing agent or directory');
				throw new Error('Missing required wizard data');
			}

			// Create the session
			const newId = generateId();
			const sessionName = agentName || `${selectedAgent} Session`;

			// Validate uniqueness before creating
			const validation = validateNewSession(
				sessionName,
				directoryPath,
				selectedAgent as ToolType,
				sessions
			);
			if (!validation.valid) {
				console.error(`Wizard session validation failed: ${validation.error}`);
				notifyToast({
					type: 'error',
					title: 'Session Creation Failed',
					message: validation.error || 'Cannot create duplicate session',
				});
				throw new Error(validation.error || 'Session validation failed');
			}

			// Get agent definition and capabilities
			const agent = await window.maestro.agents.get(selectedAgent);
			if (!agent) {
				throw new Error(`Agent not found: ${selectedAgent}`);
			}
			// Don't eagerly spawn AI processes from wizard:
			// - Batch mode agents (Claude Code, OpenCode, Codex) spawn per message in useInputProcessing
			// - Terminal uses runCommand (fresh shells per command)
			// aiPid stays at 0 until user sends their first message
			const aiPid = 0;

			// Check git repo status (with SSH support if configured)
			const wizardSshRemoteId = sessionSshRemoteConfig?.remoteId || undefined;
			const isGitRepo = await gitService.isRepo(directoryPath, wizardSshRemoteId);
			let gitBranches: string[] | undefined;
			let gitTags: string[] | undefined;
			let gitRefsCacheTime: number | undefined;
			if (isGitRepo) {
				[gitBranches, gitTags] = await Promise.all([
					gitService.getBranches(directoryPath, wizardSshRemoteId),
					gitService.getTags(directoryPath, wizardSshRemoteId),
				]);
				gitRefsCacheTime = Date.now();
			}

			// Create initial tab
			const initialTabId = generateId();
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
				showThinking: defaultShowThinking,
			};

			// Build Auto Run folder path
			const autoRunFolderPath = `${directoryPath}/${AUTO_RUN_FOLDER_NAME}`;
			const firstDoc = generatedDocuments[0];
			const autoRunSelectedFile = firstDoc ? firstDoc.filename.replace(/\.md$/, '') : undefined;

			// Create the session with Auto Run configured
			const newSession: Session = {
				id: newId,
				name: sessionName,
				toolType: selectedAgent as ToolType,
				state: 'idle',
				cwd: directoryPath,
				fullPath: directoryPath,
				projectRoot: directoryPath,
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
				aiPid,
				terminalPid: 0,
				port: 3000 + Math.floor(Math.random() * 100),
				isLive: false,
				changedFiles: [],
				fileTree: [],
				fileExplorerExpanded: [],
				fileExplorerScrollPos: 0,
				fileTreeAutoRefreshInterval: 180,
				shellCwd: directoryPath,
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
				// Auto Run configuration from wizard
				autoRunFolderPath,
				autoRunSelectedFile,
				// Per-session agent configuration from wizard
				customPath,
				customArgs,
				customEnvVars,
				// Per-session SSH remote config (takes precedence over agent-level SSH config)
				sessionSshRemoteConfig,
			};

			// Add session and make it active
			setSessions((prev) => [...prev, newSession]);
			setActiveSessionId(newId);
			updateGlobalStats({ totalSessions: 1 });
			// Record session lifecycle for Usage Dashboard
			window.maestro.stats.recordSessionCreated({
				sessionId: newId,
				agentType: selectedAgent,
				projectPath: directoryPath,
				createdAt: Date.now(),
				isRemote: !!sessionSshRemoteConfig?.enabled,
			});

			// Clear wizard resume state since we completed successfully
			clearResumeState();

			// Complete and close the wizard
			completeWizard(newId);

			// Switch to Auto Run tab so user sees their generated docs
			setActiveRightTab('autorun');

			// Start tour if requested
			if (wantsTour) {
				// Small delay to let the UI settle before starting tour
				setTimeout(() => {
					setTourFromWizard(true);
					setTourOpen(true);
				}, 300);
			}

			// Focus input
			setActiveFocus('main');
			setTimeout(() => inputRef.current?.focus(), 100);

			// Auto-start the batch run with the first document that has tasks
			// This is the core purpose of the onboarding wizard - get the user's first Auto Run going
			const firstDocWithTasks = generatedDocuments.find((doc) => doc.taskCount > 0);
			if (firstDocWithTasks && autoRunFolderPath) {
				// Create batch config for single document run
				const batchConfig: BatchRunConfig = {
					documents: [
						{
							id: generateId(),
							filename: firstDocWithTasks.filename.replace(/\.md$/, ''),
							resetOnCompletion: false,
							isDuplicate: false,
						},
					],
					prompt: DEFAULT_BATCH_PROMPT,
					loopEnabled: false,
				};

				// Small delay to ensure session state is fully propagated before starting batch
				setTimeout(() => {
					console.log(
						'[Wizard] Auto-starting batch run with first document:',
						firstDocWithTasks.filename
					);
					startBatchRun(newId, batchConfig, autoRunFolderPath);
				}, 500);
			}
		},
		[
			wizardState,
			defaultSaveToHistory,
			setSessions,
			setActiveSessionId,
			updateGlobalStats,
			clearResumeState,
			completeWizard,
			setActiveRightTab,
			setTourOpen,
			setActiveFocus,
			startBatchRun,
			sessions,
		]
	);

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

	// Toggle unread tabs filter with save/restore of active tab
	const toggleUnreadFilter = useCallback(() => {
		if (!showUnreadOnly) {
			// Entering filter mode: save current active tab
			useUIStore.getState().setPreFilterActiveTabId(activeSession?.activeTabId || null);
		} else {
			// Exiting filter mode: restore previous active tab if it still exists
			const preFilterActiveTabId = useUIStore.getState().preFilterActiveTabId;
			if (preFilterActiveTabId && activeSession) {
				const tabStillExists = activeSession.aiTabs.some((t) => t.id === preFilterActiveTabId);
				if (tabStillExists) {
					setSessions((prev) =>
						prev.map((s) => {
							if (s.id !== activeSession.id) return s;
							return { ...s, activeTabId: preFilterActiveTabId };
						})
					);
				}
				useUIStore.getState().setPreFilterActiveTabId(null);
			}
		}
		setShowUnreadOnly((prev: boolean) => !prev);
	}, [showUnreadOnly, activeSession]);

	// Toggle star on the current active tab
	const toggleTabStar = useCallback(() => {
		if (!activeSession) return;
		const tab = getActiveTab(activeSession);
		if (!tab) return;

		const newStarred = !tab.starred;
		setSessions((prev) =>
			prev.map((s) => {
				if (s.id !== activeSession.id) return s;
				// Persist starred status to session metadata (async, fire and forget)
				// Use projectRoot (not cwd) for consistent session storage access
				if (tab.agentSessionId) {
					const agentId = s.toolType || 'claude-code';
					if (agentId === 'claude-code') {
						window.maestro.claude
							.updateSessionStarred(s.projectRoot, tab.agentSessionId, newStarred)
							.catch((err) => console.error('Failed to persist tab starred:', err));
					} else {
						window.maestro.agentSessions
							.setSessionStarred(agentId, s.projectRoot, tab.agentSessionId, newStarred)
							.catch((err) => console.error('Failed to persist tab starred:', err));
					}
				}
				return {
					...s,
					aiTabs: s.aiTabs.map((t) => (t.id === tab.id ? { ...t, starred: newStarred } : t)),
				};
			})
		);
	}, [activeSession]);

	// Toggle unread status on the current active tab
	const toggleTabUnread = useCallback(() => {
		if (!activeSession) return;
		const tab = getActiveTab(activeSession);
		if (!tab) return;

		setSessions((prev) =>
			prev.map((s) => {
				if (s.id !== activeSession.id) return s;
				return {
					...s,
					aiTabs: s.aiTabs.map((t) => (t.id === tab.id ? { ...t, hasUnread: !t.hasUnread } : t)),
				};
			})
		);
	}, [activeSession]);

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

	// startRenamingSession now accepts a unique key (e.g., 'bookmark-id', 'group-gid-id', 'ungrouped-id')
	// to support renaming the same session from different UI locations (bookmarks vs groups)
	const startRenamingSession = (editKey: string) => {
		setEditingSessionId(editKey);
	};

	const finishRenamingSession = (sessId: string, newName: string) => {
		setSessions((prev) => {
			const updated = prev.map((s) => (s.id === sessId ? { ...s, name: newName } : s));
			// Sync the session name to agent session storage for searchability
			// Use projectRoot (not cwd) for consistent session storage access
			const session = updated.find((s) => s.id === sessId);
			if (session?.agentSessionId && session.projectRoot) {
				const agentId = session.toolType || 'claude-code';
				if (agentId === 'claude-code') {
					window.maestro.claude
						.updateSessionName(session.projectRoot, session.agentSessionId, newName)
						.catch((err) =>
							console.warn('[finishRenamingSession] Failed to sync session name:', err)
						);
				} else {
					window.maestro.agentSessions
						.setSessionName(agentId, session.projectRoot, session.agentSessionId, newName)
						.catch((err) =>
							console.warn('[finishRenamingSession] Failed to sync session name:', err)
						);
				}
			}
			return updated;
		});
		setEditingSessionId(null);
	};

	// Drag and Drop Handlers
	const handleDragStart = (sessionId: string) => {
		setDraggingSessionId(sessionId);
	};

	const handleDragOver = (e: React.DragEvent) => {
		e.preventDefault();
	};

	// Note: processInput has been extracted to useInputProcessing hook (see line ~2128)

	// Listen for remote commands from web interface
	// This event is triggered by the remote command handler with command data in detail
	useEffect(() => {
		const handleRemoteCommand = async (event: Event) => {
			const customEvent = event as CustomEvent<{
				sessionId: string;
				command: string;
				inputMode?: 'ai' | 'terminal';
			}>;
			const { sessionId, command, inputMode: webInputMode } = customEvent.detail;

			console.log('[Remote] Processing remote command via event:', {
				sessionId,
				command: command.substring(0, 50),
				webInputMode,
			});

			// Find the session directly from sessionsRef (not from React state which may be stale)
			const session = sessionsRef.current.find((s) => s.id === sessionId);
			if (!session) {
				console.log('[Remote] ERROR: Session not found in sessionsRef:', sessionId);
				return;
			}

			// Use web's inputMode if provided, otherwise fall back to session state
			const effectiveInputMode = webInputMode || session.inputMode;

			console.log('[Remote] Found session:', {
				id: session.id,
				agentSessionId: session.agentSessionId || 'none',
				state: session.state,
				sessionInputMode: session.inputMode,
				effectiveInputMode,
				toolType: session.toolType,
			});

			// Handle terminal mode commands
			if (effectiveInputMode === 'terminal') {
				console.log('[Remote] Terminal mode - using runCommand for clean output');

				// Add user message to shell logs and set state to busy
				setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== sessionId) return s;
						return {
							...s,
							state: 'busy' as SessionState,
							busySource: 'terminal',
							shellLogs: [
								...s.shellLogs,
								{
									id: generateId(),
									timestamp: Date.now(),
									source: 'user',
									text: command,
								},
							],
						};
					})
				);

				// Use runCommand for clean stdout/stderr capture (same as desktop)
				// This spawns a fresh shell with -l -c to run the command
				// When SSH is enabled for the session, the command runs on the remote host
				// For SSH sessions, use remoteCwd; for local, use shellCwd
				const isRemote = !!session.sshRemoteId || !!session.sessionSshRemoteConfig?.enabled;
				const commandCwd = isRemote
					? session.remoteCwd || session.sessionSshRemoteConfig?.workingDirOverride || session.cwd
					: session.shellCwd || session.cwd;
				try {
					await window.maestro.process.runCommand({
						sessionId: sessionId, // Plain session ID (not suffixed)
						command: command,
						cwd: commandCwd,
						// Pass SSH config if the session has SSH enabled
						sessionSshRemoteConfig: session.sessionSshRemoteConfig,
					});
					console.log('[Remote] Terminal command completed successfully');
				} catch (error: unknown) {
					console.error('[Remote] Terminal command failed:', error);
					const errorMessage = error instanceof Error ? error.message : 'Unknown error';
					setSessions((prev) =>
						prev.map((s) => {
							if (s.id !== sessionId) return s;
							return {
								...s,
								state: 'idle' as SessionState,
								busySource: undefined,
								thinkingStartTime: undefined,
								shellLogs: [
									...s.shellLogs,
									{
										id: generateId(),
										timestamp: Date.now(),
										source: 'system',
										text: `Error: Failed to run command - ${errorMessage}`,
									},
								],
							};
						})
					);
				}
				return;
			}

			// Handle AI mode for batch-mode agents (Claude Code, Codex, OpenCode)
			const supportedBatchAgents: ToolType[] = ['claude-code', 'codex', 'opencode'];
			if (!supportedBatchAgents.includes(session.toolType)) {
				console.log('[Remote] Not a batch-mode agent, skipping');
				return;
			}

			// Check if session is busy
			if (session.state === 'busy') {
				console.log('[Remote] Session is busy, cannot process command');
				return;
			}

			// Check for slash commands (built-in and custom)
			let promptToSend = command;
			let commandMetadata: { command: string; description: string } | undefined;

			// Handle slash commands (custom AI commands only - built-in commands have been removed)
			if (command.trim().startsWith('/')) {
				const commandText = command.trim();
				console.log('[Remote] Detected slash command:', commandText);

				// Look up in custom AI commands
				const matchingCustomCommand = customAICommandsRef.current.find(
					(cmd) => cmd.command === commandText
				);

				// Look up in spec-kit commands
				const matchingSpeckitCommand = speckitCommandsRef.current.find(
					(cmd) => cmd.command === commandText
				);

				// Look up in openspec commands
				const matchingOpenspecCommand = openspecCommandsRef.current.find(
					(cmd) => cmd.command === commandText
				);

				const matchingCommand =
					matchingCustomCommand || matchingSpeckitCommand || matchingOpenspecCommand;

				if (matchingCommand) {
					console.log(
						'[Remote] Found matching command:',
						matchingCommand.command,
						matchingSpeckitCommand
							? '(spec-kit)'
							: matchingOpenspecCommand
								? '(openspec)'
								: '(custom)'
					);

					// Get git branch for template substitution
					let gitBranch: string | undefined;
					if (session.isGitRepo) {
						try {
							const status = await gitService.getStatus(session.cwd);
							gitBranch = status.branch;
						} catch {
							// Ignore git errors
						}
					}

					// Substitute template variables
					promptToSend = substituteTemplateVariables(matchingCommand.prompt, {
						session,
						gitBranch,
						conductorProfile,
					});
					commandMetadata = {
						command: matchingCommand.command,
						description: matchingCommand.description,
					};

					console.log(
						'[Remote] Substituted prompt (first 100 chars):',
						promptToSend.substring(0, 100)
					);
				} else {
					// Unknown slash command - show error and don't send to AI
					console.log('[Remote] Unknown slash command:', commandText);
					addLogToActiveTab(sessionId, {
						source: 'system',
						text: `Unknown command: ${commandText}`,
					});
					return;
				}
			}

			try {
				// Get agent configuration for this session's tool type
				const agent = await window.maestro.agents.get(session.toolType);
				if (!agent) {
					console.log(`[Remote] ERROR: Agent not found for toolType: ${session.toolType}`);
					return;
				}

				// Get the ACTIVE TAB's agentSessionId for session continuity
				// (not the deprecated session-level one)
				const activeTab = getActiveTab(session);
				const tabAgentSessionId = activeTab?.agentSessionId;
				const isReadOnly = activeTab?.readOnlyMode;

				// Filter out YOLO/skip-permissions flags when read-only mode is active
				// (they would override the read-only mode we're requesting)
				// - Claude Code: --dangerously-skip-permissions
				// - Codex: --dangerously-bypass-approvals-and-sandbox
				const agentArgs = agent.args ?? [];
				const spawnArgs = isReadOnly
					? agentArgs.filter(
							(arg) =>
								arg !== '--dangerously-skip-permissions' &&
								arg !== '--dangerously-bypass-approvals-and-sandbox'
						)
					: [...agentArgs];

				// Note: agentSessionId and readOnlyMode are passed to spawn() config below.
				// The main process uses agent-specific argument builders (resumeArgs, readOnlyArgs)
				// to construct the correct CLI args for each agent type.

				// Include tab ID in targetSessionId for proper output routing
				const targetSessionId = `${sessionId}-ai-${activeTab?.id || 'default'}`;
				const commandToUse = agent.path ?? agent.command;

				console.log('[Remote] Spawning agent:', {
					maestroSessionId: sessionId,
					targetSessionId,
					activeTabId: activeTab?.id,
					tabAgentSessionId: tabAgentSessionId || 'NEW SESSION',
					isResume: !!tabAgentSessionId,
					command: commandToUse,
					args: spawnArgs,
					prompt: promptToSend.substring(0, 100),
				});

				// Add user message to active tab's logs and set state to busy
				// For custom commands, show the substituted prompt with command metadata
				const userLogEntry: LogEntry = {
					id: generateId(),
					timestamp: Date.now(),
					source: 'user',
					text: promptToSend,
					...(commandMetadata && { aiCommand: commandMetadata }),
				};

				setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== sessionId) return s;

						// Update active tab: add log entry and set state to 'busy' for write-mode tracking
						const activeTab = getActiveTab(s);
						const updatedAiTabs =
							s.aiTabs?.length > 0
								? s.aiTabs.map((tab) =>
										tab.id === s.activeTabId
											? {
													...tab,
													state: 'busy' as const,
													logs: [...tab.logs, userLogEntry],
												}
											: tab
									)
								: s.aiTabs;

						if (!activeTab) {
							// No tabs exist - this is a bug, sessions must have aiTabs
							console.error(
								'[runAICommand] No active tab found - session has no aiTabs, this should not happen'
							);
							return s;
						}

						return {
							...s,
							state: 'busy' as SessionState,
							busySource: 'ai',
							thinkingStartTime: Date.now(),
							currentCycleTokens: 0,
							currentCycleBytes: 0,
							// Track AI command usage
							...(commandMetadata && {
								aiCommandHistory: Array.from(
									new Set([...(s.aiCommandHistory || []), command.trim()])
								).slice(-50),
							}),
							aiTabs: updatedAiTabs,
						};
					})
				);

				// Spawn agent with the prompt (original or substituted)
				await window.maestro.process.spawn({
					sessionId: targetSessionId,
					toolType: session.toolType,
					cwd: session.cwd,
					command: commandToUse,
					args: spawnArgs,
					prompt: promptToSend,
					// Generic spawn options - main process builds agent-specific args
					agentSessionId: tabAgentSessionId ?? undefined,
					readOnlyMode: isReadOnly,
					// Per-session config overrides (if set)
					sessionCustomPath: session.customPath,
					sessionCustomArgs: session.customArgs,
					sessionCustomEnvVars: session.customEnvVars,
					sessionCustomModel: session.customModel,
					sessionCustomContextWindow: session.customContextWindow,
					// Per-session SSH remote config (takes precedence over agent-level SSH config)
					sessionSshRemoteConfig: session.sessionSshRemoteConfig,
				});

				console.log(`[Remote] ${session.toolType} spawn initiated successfully`);
			} catch (error: unknown) {
				console.error('[Remote] Failed to spawn Claude:', error);
				const errorMessage = error instanceof Error ? error.message : String(error);
				const errorLogEntry: LogEntry = {
					id: generateId(),
					timestamp: Date.now(),
					source: 'system',
					text: `Error: Failed to process remote command - ${errorMessage}`,
				};
				setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== sessionId) return s;
						// Reset active tab's state to 'idle' and add error log
						const activeTab = getActiveTab(s);
						const updatedAiTabs =
							s.aiTabs?.length > 0
								? s.aiTabs.map((tab) =>
										tab.id === s.activeTabId
											? {
													...tab,
													state: 'idle' as const,
													thinkingStartTime: undefined,
													logs: [...tab.logs, errorLogEntry],
												}
											: tab
									)
								: s.aiTabs;

						if (!activeTab) {
							// No tabs exist - this is a bug, sessions must have aiTabs
							console.error(
								'[runAICommand error] No active tab found - session has no aiTabs, this should not happen'
							);
							return s;
						}

						return {
							...s,
							state: 'idle' as SessionState,
							busySource: undefined,
							thinkingStartTime: undefined,
							aiTabs: updatedAiTabs,
						};
					})
				);
			}
		};
		window.addEventListener('maestro:remoteCommand', handleRemoteCommand);
		return () => window.removeEventListener('maestro:remoteCommand', handleRemoteCommand);
	}, []);

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
			setTimeout(() => {
				sessionsWithQueuedItems.forEach((session) => {
					const firstItem = session.executionQueue[0];
					console.log(
						`[App] Processing leftover queued item for session ${session.id}:`,
						firstItem
					);

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
					processQueuedItem(session.id, firstItem);
				});
			}, 500); // Small delay to ensure everything is initialized
		}
	}, [sessionsLoaded, sessions]);

	const handleInterrupt = async () => {
		if (!activeSession) return;

		const currentMode = activeSession.inputMode;
		const activeTab = getActiveTab(activeSession);
		const targetSessionId =
			currentMode === 'ai'
				? `${activeSession.id}-ai-${activeTab?.id || 'default'}`
				: `${activeSession.id}-terminal`;

		try {
			// Cancel any pending synopsis processes for this session
			// This prevents synopsis from running after the user clicks Stop
			await cancelPendingSynopsis(activeSession.id);

			// Send interrupt signal (Ctrl+C)
			await window.maestro.process.interrupt(targetSessionId);

			// Check if there are queued items to process after interrupt
			const currentSession = sessionsRef.current.find((s) => s.id === activeSession.id);
			let queuedItemToProcess: { sessionId: string; item: QueuedItem } | null = null;

			if (currentSession && currentSession.executionQueue.length > 0) {
				queuedItemToProcess = {
					sessionId: activeSession.id,
					item: currentSession.executionQueue[0],
				};
			}

			// Create canceled log entry for AI mode interrupts
			const canceledLog: LogEntry | null =
				currentMode === 'ai'
					? {
							id: generateId(),
							timestamp: Date.now(),
							source: 'system',
							text: 'Canceled by user',
						}
					: null;

			// Set state to idle with full cleanup, or process next queued item
			setSessions((prev) =>
				prev.map((s) => {
					if (s.id !== activeSession.id) return s;

					// If there are queued items, start processing the next one
					if (s.executionQueue.length > 0) {
						const [nextItem, ...remainingQueue] = s.executionQueue;
						const targetTab = s.aiTabs.find((tab) => tab.id === nextItem.tabId) || getActiveTab(s);

						if (!targetTab) {
							return {
								...s,
								state: 'busy' as SessionState,
								busySource: 'ai',
								executionQueue: remainingQueue,
								thinkingStartTime: Date.now(),
								currentCycleTokens: 0,
								currentCycleBytes: 0,
							};
						}

						// Set the interrupted tab to idle, and the target tab for queued item to busy
						// Also add the canceled log to the interrupted tab
						let updatedAiTabs = s.aiTabs.map((tab) => {
							if (tab.id === targetTab.id) {
								return {
									...tab,
									state: 'busy' as const,
									thinkingStartTime: Date.now(),
								};
							}
							// Set any other busy tabs to idle (they were interrupted) and add canceled log
							// Also clear any thinking/tool logs since the process was interrupted
							if (tab.state === 'busy') {
								const logsWithoutThinkingOrTools = tab.logs.filter(
									(log) => log.source !== 'thinking' && log.source !== 'tool'
								);
								const updatedLogs = canceledLog
									? [...logsWithoutThinkingOrTools, canceledLog]
									: logsWithoutThinkingOrTools;
								return {
									...tab,
									state: 'idle' as const,
									thinkingStartTime: undefined,
									logs: updatedLogs,
								};
							}
							return tab;
						});

						// For message items, add a log entry to the target tab
						if (nextItem.type === 'message' && nextItem.text) {
							const logEntry: LogEntry = {
								id: generateId(),
								timestamp: Date.now(),
								source: 'user',
								text: nextItem.text,
								images: nextItem.images,
							};
							updatedAiTabs = updatedAiTabs.map((tab) =>
								tab.id === targetTab.id ? { ...tab, logs: [...tab.logs, logEntry] } : tab
							);
						}

						return {
							...s,
							state: 'busy' as SessionState,
							busySource: 'ai',
							aiTabs: updatedAiTabs,
							executionQueue: remainingQueue,
							thinkingStartTime: Date.now(),
							currentCycleTokens: 0,
							currentCycleBytes: 0,
						};
					}

					// No queued items, just go to idle and add canceled log to the active tab
					// Also clear any thinking/tool logs since the process was interrupted
					const activeTabForCancel = getActiveTab(s);
					const updatedAiTabsForIdle =
						canceledLog && activeTabForCancel
							? s.aiTabs.map((tab) => {
									if (tab.id === activeTabForCancel.id) {
										const logsWithoutThinkingOrTools = tab.logs.filter(
											(log) => log.source !== 'thinking' && log.source !== 'tool'
										);
										return {
											...tab,
											logs: [...logsWithoutThinkingOrTools, canceledLog],
											state: 'idle' as const,
											thinkingStartTime: undefined,
										};
									}
									return tab;
								})
							: s.aiTabs.map((tab) => {
									if (tab.state === 'busy') {
										const logsWithoutThinkingOrTools = tab.logs.filter(
											(log) => log.source !== 'thinking' && log.source !== 'tool'
										);
										return {
											...tab,
											state: 'idle' as const,
											thinkingStartTime: undefined,
											logs: logsWithoutThinkingOrTools,
										};
									}
									return tab;
								});

					return {
						...s,
						state: 'idle',
						busySource: undefined,
						thinkingStartTime: undefined,
						aiTabs: updatedAiTabsForIdle,
					};
				})
			);

			// Process the queued item after state update
			if (queuedItemToProcess) {
				setTimeout(() => {
					processQueuedItem(queuedItemToProcess!.sessionId, queuedItemToProcess!.item);
				}, 0);
			}
		} catch (error) {
			console.error('Failed to interrupt process:', error);

			// If interrupt fails, offer to kill the process
			const shouldKill = confirm(
				'Failed to interrupt the process gracefully. Would you like to force kill it?\n\n' +
					'Warning: This may cause data loss or leave the process in an inconsistent state.'
			);

			if (shouldKill) {
				try {
					await window.maestro.process.kill(targetSessionId);

					const killLog: LogEntry = {
						id: generateId(),
						timestamp: Date.now(),
						source: 'system',
						text: 'Process forcefully terminated',
					};

					// Check if there are queued items to process after kill
					const currentSessionForKill = sessionsRef.current.find((s) => s.id === activeSession.id);
					let queuedItemAfterKill: {
						sessionId: string;
						item: QueuedItem;
					} | null = null;

					if (currentSessionForKill && currentSessionForKill.executionQueue.length > 0) {
						queuedItemAfterKill = {
							sessionId: activeSession.id,
							item: currentSessionForKill.executionQueue[0],
						};
					}

					setSessions((prev) =>
						prev.map((s) => {
							if (s.id !== activeSession.id) return s;

							// Add kill log to the appropriate place and clear thinking/tool logs
							const updatedSession = { ...s };
							if (currentMode === 'ai') {
								const tab = getActiveTab(s);
								if (tab) {
									updatedSession.aiTabs = s.aiTabs.map((t) => {
										if (t.id === tab.id) {
											const logsWithoutThinkingOrTools = t.logs.filter(
												(log) => log.source !== 'thinking' && log.source !== 'tool'
											);
											return {
												...t,
												logs: [...logsWithoutThinkingOrTools, killLog],
											};
										}
										return t;
									});
								}
							} else {
								updatedSession.shellLogs = [...s.shellLogs, killLog];
							}

							// If there are queued items, start processing the next one
							if (s.executionQueue.length > 0) {
								const [nextItem, ...remainingQueue] = s.executionQueue;
								const targetTab =
									s.aiTabs.find((tab) => tab.id === nextItem.tabId) || getActiveTab(s);

								if (!targetTab) {
									return {
										...updatedSession,
										state: 'busy' as SessionState,
										busySource: 'ai',
										executionQueue: remainingQueue,
										thinkingStartTime: Date.now(),
										currentCycleTokens: 0,
										currentCycleBytes: 0,
									};
								}

								// Set tabs appropriately and clear thinking/tool logs from interrupted tabs
								let updatedAiTabs = updatedSession.aiTabs.map((tab) => {
									if (tab.id === targetTab.id) {
										return {
											...tab,
											state: 'busy' as const,
											thinkingStartTime: Date.now(),
										};
									}
									if (tab.state === 'busy') {
										const logsWithoutThinkingOrTools = tab.logs.filter(
											(log) => log.source !== 'thinking' && log.source !== 'tool'
										);
										return {
											...tab,
											state: 'idle' as const,
											thinkingStartTime: undefined,
											logs: logsWithoutThinkingOrTools,
										};
									}
									return tab;
								});

								// For message items, add a log entry to the target tab
								if (nextItem.type === 'message' && nextItem.text) {
									const logEntry: LogEntry = {
										id: generateId(),
										timestamp: Date.now(),
										source: 'user',
										text: nextItem.text,
										images: nextItem.images,
									};
									updatedAiTabs = updatedAiTabs.map((tab) =>
										tab.id === targetTab.id ? { ...tab, logs: [...tab.logs, logEntry] } : tab
									);
								}

								return {
									...updatedSession,
									state: 'busy' as SessionState,
									busySource: 'ai',
									aiTabs: updatedAiTabs,
									executionQueue: remainingQueue,
									thinkingStartTime: Date.now(),
									currentCycleTokens: 0,
									currentCycleBytes: 0,
								};
							}

							// No queued items, just go to idle and clear thinking logs
							if (currentMode === 'ai') {
								const tab = getActiveTab(s);
								if (!tab)
									return {
										...updatedSession,
										state: 'idle',
										busySource: undefined,
										thinkingStartTime: undefined,
									};
								return {
									...updatedSession,
									state: 'idle',
									busySource: undefined,
									thinkingStartTime: undefined,
									aiTabs: updatedSession.aiTabs.map((t) => {
										if (t.id === tab.id) {
											const logsWithoutThinkingOrTools = t.logs.filter(
												(log) => log.source !== 'thinking' && log.source !== 'tool'
											);
											return {
												...t,
												state: 'idle' as const,
												thinkingStartTime: undefined,
												logs: logsWithoutThinkingOrTools,
											};
										}
										return t;
									}),
								};
							}
							return {
								...updatedSession,
								state: 'idle',
								busySource: undefined,
								thinkingStartTime: undefined,
							};
						})
					);

					// Process the queued item after state update
					if (queuedItemAfterKill) {
						setTimeout(() => {
							processQueuedItem(queuedItemAfterKill!.sessionId, queuedItemAfterKill!.item);
						}, 0);
					}
				} catch (killError: unknown) {
					console.error('Failed to kill process:', killError);
					const killErrorMessage =
						killError instanceof Error ? killError.message : String(killError);
					const errorLog: LogEntry = {
						id: generateId(),
						timestamp: Date.now(),
						source: 'system',
						text: `Error: Failed to terminate process - ${killErrorMessage}`,
					};
					setSessions((prev) =>
						prev.map((s) => {
							if (s.id !== activeSession.id) return s;
							if (currentMode === 'ai') {
								const tab = getActiveTab(s);
								if (!tab)
									return {
										...s,
										state: 'idle',
										busySource: undefined,
										thinkingStartTime: undefined,
									};
								return {
									...s,
									state: 'idle',
									busySource: undefined,
									thinkingStartTime: undefined,
									aiTabs: s.aiTabs.map((t) => {
										if (t.id === tab.id) {
											// Clear thinking/tool logs even on error
											const logsWithoutThinkingOrTools = t.logs.filter(
												(log) => log.source !== 'thinking' && log.source !== 'tool'
											);
											return {
												...t,
												state: 'idle' as const,
												thinkingStartTime: undefined,
												logs: [...logsWithoutThinkingOrTools, errorLog],
											};
										}
										return t;
									}),
								};
							}
							return {
								...s,
								shellLogs: [...s.shellLogs, errorLog],
								state: 'idle',
								busySource: undefined,
								thinkingStartTime: undefined,
							};
						})
					);
				}
			}
		}
	};

	// handleInputKeyDown — provided by useInputKeyDown hook (Phase 2F)
	const { handleInputKeyDown } = useInputKeyDown({
		inputValue,
		setInputValue,
		tabCompletionSuggestions,
		atMentionSuggestions,
		allSlashCommands,
		syncFileTreeToTabCompletion,
		processInput,
		getTabCompletionSuggestions,
		inputRef,
		terminalOutputRef,
	});

	// Image Handlers
	const handlePaste = (e: React.ClipboardEvent) => {
		// Allow image pasting in group chat or direct AI mode
		const isGroupChatActive = !!activeGroupChatId;
		const isDirectAIMode = activeSession && activeSession.inputMode === 'ai';

		const items = e.clipboardData.items;
		const hasImage = Array.from(items).some((item) => item.type.startsWith('image/'));

		// Handle text paste with whitespace trimming (for direct input only - GroupChatInput handles its own)
		if (!hasImage && !isGroupChatActive) {
			const text = e.clipboardData.getData('text/plain');
			if (text) {
				const trimmedText = text.trim();
				// Only intercept if trimming actually changed the text
				if (trimmedText !== text) {
					e.preventDefault();
					const target = e.target as HTMLTextAreaElement;
					const start = target.selectionStart ?? 0;
					const end = target.selectionEnd ?? 0;
					const currentValue = target.value;
					const newValue = currentValue.slice(0, start) + trimmedText + currentValue.slice(end);
					setInputValue(newValue);
					// Set cursor position after the pasted text
					requestAnimationFrame(() => {
						target.selectionStart = target.selectionEnd = start + trimmedText.length;
					});
				}
			}
			return;
		}

		// Image handling requires AI mode or group chat
		if (!isGroupChatActive && !isDirectAIMode) return;

		for (let i = 0; i < items.length; i++) {
			if (items[i].type.indexOf('image') !== -1) {
				e.preventDefault();
				const blob = items[i].getAsFile();
				if (blob) {
					const reader = new FileReader();
					reader.onload = (event) => {
						if (event.target?.result) {
							const imageData = event.target!.result as string;
							if (isGroupChatActive) {
								setGroupChatStagedImages((prev) => {
									if (prev.includes(imageData)) {
										setSuccessFlashNotification('Duplicate image ignored');
										setTimeout(() => setSuccessFlashNotification(null), 2000);
										return prev;
									}
									return [...prev, imageData];
								});
							} else {
								setStagedImages((prev) => {
									if (prev.includes(imageData)) {
										setSuccessFlashNotification('Duplicate image ignored');
										setTimeout(() => setSuccessFlashNotification(null), 2000);
										return prev;
									}
									return [...prev, imageData];
								});
							}
						}
					};
					reader.readAsDataURL(blob);
				}
			}
		}
	};

	const handleDrop = (e: React.DragEvent) => {
		e.preventDefault();
		dragCounterRef.current = 0;
		setIsDraggingImage(false);

		// Allow image dropping in group chat or direct AI mode
		const isGroupChatActive = !!activeGroupChatId;
		const isDirectAIMode = activeSession && activeSession.inputMode === 'ai';

		if (!isGroupChatActive && !isDirectAIMode) return;

		const files = e.dataTransfer.files;

		for (let i = 0; i < files.length; i++) {
			if (files[i].type.startsWith('image/')) {
				const reader = new FileReader();
				reader.onload = (event) => {
					if (event.target?.result) {
						const imageData = event.target!.result as string;
						if (isGroupChatActive) {
							setGroupChatStagedImages((prev) => {
								if (prev.includes(imageData)) {
									setSuccessFlashNotification('Duplicate image ignored');
									setTimeout(() => setSuccessFlashNotification(null), 2000);
									return prev;
								}
								return [...prev, imageData];
							});
						} else {
							setStagedImages((prev) => {
								if (prev.includes(imageData)) {
									setSuccessFlashNotification('Duplicate image ignored');
									setTimeout(() => setSuccessFlashNotification(null), 2000);
									return prev;
								}
								return [...prev, imageData];
							});
						}
					}
				};
				reader.readAsDataURL(files[i]);
			}
		}
	};

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

	// State to track session that should be moved to newly created group
	const [pendingMoveToGroupSessionId, setPendingMoveToGroupSessionId] = useState<string | null>(
		null
	);

	// Group Modal Handlers (stable callbacks for AppGroupModals)
	// Must be defined after groupModalState destructure since setCreateGroupModalOpen comes from there
	const handleCloseCreateGroupModal = useCallback(() => {
		setCreateGroupModalOpen(false);
		setPendingMoveToGroupSessionId(null); // Clear pending move on close
	}, [setCreateGroupModalOpen]);
	// Handler for when a new group is created - move pending session to it
	const handleGroupCreated = useCallback(
		(groupId: string) => {
			if (pendingMoveToGroupSessionId) {
				setSessions((prev) =>
					prev.map((s) => (s.id === pendingMoveToGroupSessionId ? { ...s, groupId } : s))
				);
				setPendingMoveToGroupSessionId(null);
			}
		},
		[pendingMoveToGroupSessionId, setSessions]
	);

	// Handler for "Create New Group" from context menu - sets pending session and opens modal
	const handleCreateGroupAndMove = useCallback(
		(sessionId: string) => {
			setPendingMoveToGroupSessionId(sessionId);
			setCreateGroupModalOpen(true);
		},
		[setCreateGroupModalOpen]
	);

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
	const handleUtilityFileTabSelect = useCallback(
		(tabId: string) => {
			if (!activeSession) return;
			// Set activeFileTabId, keep activeTabId as-is (for when returning to AI tabs)
			setSessions((prev) =>
				prev.map((s) => (s.id === activeSession.id ? { ...s, activeFileTabId: tabId } : s))
			);
		},
		[activeSession]
	);
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
	const handleQuickActionsToggleRemoteControl = useCallback(async () => {
		await toggleGlobalLive();
		// Show flash notification based on the NEW state (opposite of current)
		if (isLiveMode) {
			// Was live, now offline
			setSuccessFlashNotification('Remote Control: OFFLINE — See indicator at top of left panel');
		} else {
			// Was offline, now live
			setSuccessFlashNotification(
				'Remote Control: LIVE — See LIVE indicator at top of left panel for QR code'
			);
		}
		setTimeout(() => setSuccessFlashNotification(null), 4000);
	}, [toggleGlobalLive, isLiveMode, setSuccessFlashNotification]);
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
		// Summarize and continue
		canSummarizeActiveTab: (() => {
			if (!activeSession || !activeSession.activeTabId) return false;
			const activeTab = activeSession.aiTabs.find((t) => t.id === activeSession.activeTabId);
			return canSummarize(activeSession.contextUsage, activeTab?.logs);
		})(),
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

	// Update flat file list when active session's tree, expanded folders, filter, or hidden files setting changes
	useEffect(() => {
		if (!activeSession || !activeSession.fileExplorerExpanded) {
			setFlatFileList([]);
			return;
		}
		const expandedSet = new Set(activeSession.fileExplorerExpanded);

		// Apply hidden files filter to match FileExplorerPanel's display
		const filterHiddenFiles = (nodes: FileNode[]): FileNode[] => {
			if (showHiddenFiles) return nodes;
			return nodes
				.filter((node) => !node.name.startsWith('.'))
				.map((node) => ({
					...node,
					children: node.children ? filterHiddenFiles(node.children) : undefined,
				}));
		};

		// Use filteredFileTree when available (it returns the full tree when no filter is active)
		// Then apply hidden files filter to match what FileExplorerPanel displays
		const displayTree = filterHiddenFiles(filteredFileTree);
		const newFlatList = flattenTree(displayTree, expandedSet);

		// Preserve selection identity: track the selected item by path, not index.
		// When folders expand/collapse, the flat list shifts — re-locate the selected item.
		const { flatFileList: oldList, selectedFileIndex: oldIndex } = useFileExplorerStore.getState();
		const selectedPath = oldList[oldIndex]?.fullPath;
		if (selectedPath) {
			const newIndex = newFlatList.findIndex((item) => item.fullPath === selectedPath);
			if (newIndex >= 0) {
				setSelectedFileIndex(newIndex);
			} else {
				// Item no longer visible (inside collapsed folder) — clamp to valid range
				setSelectedFileIndex(Math.min(oldIndex, Math.max(0, newFlatList.length - 1)));
			}
		}

		setFlatFileList(newFlatList);
	}, [activeSession?.fileExplorerExpanded, filteredFileTree, showHiddenFiles]);

	// Handle pending jump path from /jump command
	useEffect(() => {
		if (!activeSession || activeSession.pendingJumpPath === undefined || flatFileList.length === 0)
			return;

		const jumpPath = activeSession.pendingJumpPath;

		// Find the target index
		let targetIndex = 0;

		if (jumpPath === '') {
			// Jump to root - select first item
			targetIndex = 0;
		} else {
			// Find the folder in the flat list and select it directly
			const folderIndex = flatFileList.findIndex(
				(item) => item.fullPath === jumpPath && item.isFolder
			);

			if (folderIndex !== -1) {
				// Select the folder itself (not its first child)
				targetIndex = folderIndex;
			}
			// If folder not found, stay at 0
		}

		fileTreeKeyboardNavRef.current = true; // Scroll to jumped file
		setSelectedFileIndex(targetIndex);

		// Clear the pending jump path
		setSessions((prev) =>
			prev.map((s) => (s.id === activeSession.id ? { ...s, pendingJumpPath: undefined } : s))
		);
	}, [activeSession?.pendingJumpPath, flatFileList, activeSession?.id]);

	// Scroll to selected file item when selection changes via keyboard
	useEffect(() => {
		// Only scroll when selection changed via keyboard navigation, not mouse click
		if (!fileTreeKeyboardNavRef.current) return;
		fileTreeKeyboardNavRef.current = false; // Reset flag after handling

		// Allow scroll when:
		// 1. Right panel is focused on files tab (normal keyboard navigation)
		// 2. Tab completion is open and files tab is visible (sync from tab completion)
		const shouldScroll =
			(activeFocus === 'right' && activeRightTab === 'files') ||
			(tabCompletionOpen && activeRightTab === 'files');
		if (!shouldScroll) return;

		// Use requestAnimationFrame to ensure DOM is updated
		requestAnimationFrame(() => {
			const container = fileTreeContainerRef.current;
			if (!container) return;

			// Find the selected element
			const selectedElement = container.querySelector(
				`[data-file-index="${selectedFileIndex}"]`
			) as HTMLElement;

			if (selectedElement) {
				// Use scrollIntoView with center alignment to avoid sticky header overlap
				selectedElement.scrollIntoView({
					behavior: 'auto', // Immediate scroll
					block: 'center', // Center in viewport to avoid sticky header at top
					inline: 'nearest',
				});
			}
		});
	}, [selectedFileIndex, activeFocus, activeRightTab, flatFileList, tabCompletionOpen]);

	// File Explorer keyboard navigation
	useEffect(() => {
		const handleFileExplorerKeys = (e: KeyboardEvent) => {
			// Skip when a modal is open (let textarea/input in modal handle arrow keys)
			if (hasOpenModal()) return;

			// Only handle when right panel is focused and on files tab
			if (activeFocus !== 'right' || activeRightTab !== 'files' || flatFileList.length === 0)
				return;

			const expandedFolders = new Set(activeSession?.fileExplorerExpanded || []);

			// Cmd+Arrow: jump to top/bottom
			if ((e.metaKey || e.ctrlKey) && e.key === 'ArrowUp') {
				e.preventDefault();
				fileTreeKeyboardNavRef.current = true;
				setSelectedFileIndex(0);
			} else if ((e.metaKey || e.ctrlKey) && e.key === 'ArrowDown') {
				e.preventDefault();
				fileTreeKeyboardNavRef.current = true;
				setSelectedFileIndex(flatFileList.length - 1);
			}
			// Option+Arrow: page up/down (move by 10 items)
			else if (e.altKey && e.key === 'ArrowUp') {
				e.preventDefault();
				fileTreeKeyboardNavRef.current = true;
				setSelectedFileIndex((prev) => Math.max(0, prev - 10));
			} else if (e.altKey && e.key === 'ArrowDown') {
				e.preventDefault();
				fileTreeKeyboardNavRef.current = true;
				setSelectedFileIndex((prev) => Math.min(flatFileList.length - 1, prev + 10));
			}
			// Regular Arrow: move one item
			else if (e.key === 'ArrowUp') {
				e.preventDefault();
				fileTreeKeyboardNavRef.current = true;
				setSelectedFileIndex((prev) => Math.max(0, prev - 1));
			} else if (e.key === 'ArrowDown') {
				e.preventDefault();
				fileTreeKeyboardNavRef.current = true;
				setSelectedFileIndex((prev) => Math.min(flatFileList.length - 1, prev + 1));
			} else if (e.key === 'ArrowLeft') {
				e.preventDefault();
				const selectedItem = flatFileList[selectedFileIndex];
				if (selectedItem?.isFolder && expandedFolders.has(selectedItem.fullPath)) {
					// If selected item is an expanded folder, collapse it
					toggleFolder(selectedItem.fullPath, activeSessionId, setSessions);
				} else if (selectedItem) {
					// If selected item is a file or collapsed folder, collapse parent folder
					const parentPath = selectedItem.fullPath.substring(
						0,
						selectedItem.fullPath.lastIndexOf('/')
					);
					if (parentPath && expandedFolders.has(parentPath)) {
						toggleFolder(parentPath, activeSessionId, setSessions);
						// Move selection to parent folder
						const parentIndex = flatFileList.findIndex((item) => item.fullPath === parentPath);
						if (parentIndex >= 0) {
							fileTreeKeyboardNavRef.current = true;
							setSelectedFileIndex(parentIndex);
						}
					}
				}
			} else if (e.key === 'ArrowRight') {
				e.preventDefault();
				const selectedItem = flatFileList[selectedFileIndex];
				if (selectedItem?.isFolder && !expandedFolders.has(selectedItem.fullPath)) {
					toggleFolder(selectedItem.fullPath, activeSessionId, setSessions);
				}
			} else if (e.key === 'Enter') {
				e.preventDefault();
				const selectedItem = flatFileList[selectedFileIndex];
				if (selectedItem) {
					if (selectedItem.isFolder) {
						toggleFolder(selectedItem.fullPath, activeSessionId, setSessions);
					} else {
						handleFileClick(selectedItem, selectedItem.fullPath);
					}
				}
			}
		};

		window.addEventListener('keydown', handleFileExplorerKeys);
		return () => window.removeEventListener('keydown', handleFileExplorerKeys);
	}, [
		activeFocus,
		activeRightTab,
		flatFileList,
		selectedFileIndex,
		activeSession?.fileExplorerExpanded,
		activeSessionId,
		setSessions,
		toggleFolder,
		handleFileClick,
		hasOpenModal,
	]);

	// ============================================================================
	// MEMOIZED WIZARD HANDLERS FOR PROPS HOOKS
	// ============================================================================

	// Wizard complete handler - converts wizard tab to normal session with context
	const handleWizardComplete = useCallback(() => {
		if (!activeSession) return;
		const activeTabLocal = getActiveTab(activeSession);
		const wizardState = activeTabLocal?.wizardState;
		if (!wizardState) return;

		// Convert wizard conversation history to log entries
		const wizardLogEntries: LogEntry[] = wizardState.conversationHistory.map((msg) => ({
			id: `wizard-${msg.id}`,
			timestamp: msg.timestamp,
			source: msg.role === 'user' ? 'user' : 'ai',
			text: msg.content,
			delivered: true,
		}));

		// Create summary message with next steps
		const generatedDocs = wizardState.generatedDocuments || [];
		const totalTasks = generatedDocs.reduce((sum, doc) => sum + doc.taskCount, 0);
		const docNames = generatedDocs.map((d) => d.filename).join(', ');

		const summaryMessage: LogEntry = {
			id: `wizard-summary-${Date.now()}`,
			timestamp: Date.now(),
			source: 'ai',
			text:
				`## Wizard Complete\n\n` +
				`Created ${generatedDocs.length} document${
					generatedDocs.length !== 1 ? 's' : ''
				} with ${totalTasks} task${totalTasks !== 1 ? 's' : ''}:\n` +
				`${docNames}\n\n` +
				`**Next steps:**\n` +
				`1. Open the **Auto Run** tab in the right panel to view your playbook\n` +
				`2. Review and edit tasks as needed\n` +
				`3. Click **Run** to start executing tasks automatically\n\n` +
				`You can continue chatting to iterate on your playbook - the AI has full context of what was created.`,
			delivered: true,
		};

		const subfolderName = wizardState.subfolderName || '';
		const tabName = subfolderName || 'Wizard';
		const wizardAgentSessionId = wizardState.agentSessionId;
		const activeTabId = activeTabLocal.id;

		setSessions((prev) =>
			prev.map((s) => {
				if (s.id !== activeSession.id) return s;
				const updatedTabs = s.aiTabs.map((tab) => {
					if (tab.id !== activeTabId) return tab;
					return {
						...tab,
						logs: [...tab.logs, ...wizardLogEntries, summaryMessage],
						agentSessionId: wizardAgentSessionId || tab.agentSessionId,
						name: tabName,
						wizardState: undefined,
					};
				});
				return { ...s, aiTabs: updatedTabs };
			})
		);

		endInlineWizard();
		handleAutoRunRefresh();
		setInputValue('');
	}, [
		activeSession,
		getActiveTab,
		setSessions,
		endInlineWizard,
		handleAutoRunRefresh,
		setInputValue,
	]);

	// Wizard lets go handler - generates documents for active tab
	const handleWizardLetsGo = useCallback(() => {
		const activeTabLocal = activeSession ? getActiveTab(activeSession) : null;
		if (activeTabLocal) {
			generateInlineWizardDocuments(undefined, activeTabLocal.id);
		}
	}, [activeSession, getActiveTab, generateInlineWizardDocuments]);

	// Wizard toggle thinking handler
	const handleToggleWizardShowThinking = useCallback(() => {
		if (!activeSession) return;
		const activeTabLocal = getActiveTab(activeSession);
		if (!activeTabLocal?.wizardState) return;
		setSessions((prev) =>
			prev.map((s) => {
				if (s.id !== activeSession.id) return s;
				return {
					...s,
					aiTabs: s.aiTabs.map((tab) => {
						if (tab.id !== activeTabLocal.id) return tab;
						if (!tab.wizardState) return tab;
						return {
							...tab,
							wizardState: {
								...tab.wizardState,
								showWizardThinking: !tab.wizardState.showWizardThinking,
								thinkingContent: !tab.wizardState.showWizardThinking
									? ''
									: tab.wizardState.thinkingContent,
							},
						};
					}),
				};
			})
		);
	}, [activeSession, getActiveTab, setSessions]);

	// ============================================================================
	// PROPS HOOKS FOR MAJOR COMPONENTS
	// These hooks memoize the props objects for MainPanel, SessionList, and RightPanel
	// to prevent re-evaluating 50-100+ props on every state change.
	// ============================================================================

	// Stable fileTree reference - prevents FilePreview re-renders during agent activity.
	// Without this, activeSession?.fileTree || [] creates a new empty array on every render
	// when fileTree is undefined, and a new reference whenever activeSession updates.
	const stableFileTree = useMemo(() => activeSession?.fileTree || [], [activeSession?.fileTree]);

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
		fontFamily,
		isMobileLandscape,
		activeFocus,
		outputSearchOpen,
		outputSearchQuery,
		inputValue,
		enterToSendAI,
		enterToSendTerminal,
		stagedImages,
		commandHistoryOpen,
		commandHistoryFilter,
		commandHistorySelectedIndex,
		slashCommandOpen,
		slashCommands: allSlashCommands,
		selectedSlashCommandIndex,
		filePreviewLoading,
		markdownEditMode,
		chatRawTextMode,
		autoScrollAiMode,
		setAutoScrollAiMode,
		userMessageAlignment,
		shortcuts,
		rightPanelOpen,
		maxOutputLines,
		gitDiffPreview,
		fileTreeFilterOpen,
		logLevel,
		logViewerSelectedLevels,

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
		activeBatchRunState: activeBatchRunState ?? undefined,
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

		// Context management settings
		contextWarningsEnabled: contextManagementSettings.contextWarningsEnabled,
		contextWarningYellowThreshold: contextManagementSettings.contextWarningYellowThreshold,
		contextWarningRedThreshold: contextManagementSettings.contextWarningRedThreshold,

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

		// Unread filter
		showUnreadOnly,

		// Accessibility
		colorBlindMode,

		// Setters
		setLogViewerSelectedLevels,
		setGitDiffPreview,
		setLogViewerOpen,
		setAgentSessionsOpen,
		setActiveAgentSessionId,
		setActiveFocus,
		setOutputSearchOpen,
		setOutputSearchQuery,
		setInputValue,
		setEnterToSendAI,
		setEnterToSendTerminal,
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
		setMarkdownEditMode,
		setChatRawTextMode,
		setAboutModalOpen,
		setRightPanelOpen,
		setGitLogOpen,

		// Refs
		inputRef,
		logsEndRef,
		terminalOutputRef,
		fileTreeContainerRef,
		fileTreeFilterInputRef,

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
		showConfirmation,
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
		// Core state
		theme,
		sessions,
		groups,
		sortedSessions,
		activeSessionId,
		leftSidebarOpen,
		leftSidebarWidth,
		activeFocus,
		selectedSidebarIndex,
		editingGroupId,
		editingSessionId,
		draggingSessionId,
		shortcuts,

		// Global Live Mode
		isLiveMode,
		webInterfaceUrl,

		// Web Interface Port Settings
		webInterfaceUseCustomPort: settings.webInterfaceUseCustomPort,
		webInterfaceCustomPort: settings.webInterfaceCustomPort,

		// Folder states
		bookmarksCollapsed,
		ungroupedCollapsed: settings.ungroupedCollapsed,

		// Auto mode
		activeBatchSessionIds,

		// Session jump shortcuts
		showSessionJumpNumbers,
		visibleSessions,

		// Achievement system
		autoRunStats,

		// Group Chat state
		groupChats,
		activeGroupChatId,
		groupChatsExpanded,
		groupChatState,
		participantStates,
		groupChatStates,
		allGroupChatParticipantStates,

		// Setters
		setWebInterfaceUseCustomPort: settings.setWebInterfaceUseCustomPort,
		setWebInterfaceCustomPort: settings.setWebInterfaceCustomPort,
		setBookmarksCollapsed,
		setUngroupedCollapsed: settings.setUngroupedCollapsed,
		setActiveFocus,
		setActiveSessionId,
		setLeftSidebarOpen,
		setLeftSidebarWidth,
		setShortcutsHelpOpen,
		setSettingsModalOpen,
		setSettingsTab,
		setAboutModalOpen,
		setUpdateCheckModalOpen,
		setLogViewerOpen,
		setProcessMonitorOpen,
		setUsageDashboardOpen,
		setSymphonyModalOpen,
		setDirectorNotesOpen: encoreFeatures.directorNotes ? setDirectorNotesOpen : undefined,
		setGroups,
		setSessions,
		setRenameInstanceModalOpen,
		setRenameInstanceValue,
		setRenameInstanceSessionId,
		setDuplicatingSessionId,
		setGroupChatsExpanded,
		setQuickActionOpen,

		// Handlers
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

		// Context warning thresholds
		contextWarningYellowThreshold: contextManagementSettings.contextWarningYellowThreshold,
		contextWarningRedThreshold: contextManagementSettings.contextWarningRedThreshold,

		// Ref
		sidebarContainerRef,
	});

	const rightPanelProps = useRightPanelProps({
		// Session & Theme
		activeSession,
		theme,
		shortcuts,

		// Panel state
		rightPanelOpen,
		rightPanelWidth,

		// Tab state
		activeRightTab,

		// Focus management
		activeFocus,

		// File explorer state
		fileTreeFilter,
		fileTreeFilterOpen,
		filteredFileTree,
		selectedFileIndex,
		showHiddenFiles,

		// Auto Run state
		autoRunDocumentList,
		autoRunDocumentTree,
		autoRunIsLoadingDocuments,
		autoRunDocumentTaskCounts,

		// Batch processing (convert null to undefined for component props)
		activeBatchRunState: activeBatchRunState ?? undefined,
		currentSessionBatchState: currentSessionBatchState ?? undefined,

		// Document Graph
		lastGraphFocusFilePath: lastGraphFocusFilePath || undefined,

		// Refs
		fileTreeContainerRef,
		fileTreeFilterInputRef,

		// Setters
		setRightPanelOpen,
		setRightPanelWidth,
		setActiveFocus,
		setFileTreeFilter,
		setFileTreeFilterOpen,
		setSelectedFileIndex,
		setShowHiddenFiles,
		setSessions,

		// Handlers
		handleSetActiveRightTab,
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

		// Batch processing handlers
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
					isMobileLandscape ? 'pt-0' : 'pt-10'
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

				{/* --- DRAGGABLE TITLE BAR (hidden in mobile landscape) --- */}
				{!isMobileLandscape && (
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
					handsOnTimeMs={globalStats.totalActiveTimeMs}
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
										title: 'Session Creation Failed',
										message: validation.error || 'Cannot create duplicate session',
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
								updateGlobalStats({ totalSessions: 1 });
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
						<RightPanel ref={rightPanelRef} {...rightPanelProps} encoreTabs={encoreRegistry.getEncoreTabs()} encoreList={encoreRegistry.encores} />
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
							encoreRegistry={encoreRegistry}
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
