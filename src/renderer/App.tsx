import React, { useState, useEffect, useRef, useMemo, useCallback, lazy, Suspense } from 'react';
import { useFocusAfterRender } from './hooks/utils/useFocusAfterRender';
// SettingsModal is now lazy-loaded inside AppStandaloneModals
import { SessionList } from './components/SessionList';
import { RightPanel, RightPanelHandle } from './components/RightPanel';
import { slashCommands } from './slashCommands';
import { AppModals, type PRDetails, type FlatFileItem } from './components/AppModals';
import { AppStandaloneModals } from './components/AppStandaloneModals';
import { initializeRendererPrompts } from './services/promptInit';
import { ErrorBoundary } from './components/ErrorBoundary';
import { MainPanel, type MainPanelHandle } from './components/MainPanel';
// AppOverlays, PlaygroundPanel, DebugWizardModal, DebugPackageModal, WindowsWarningModal,
// GistPublishModal, MaestroWizard, WizardResumeModal, TourOverlay are now rendered
// inside AppStandaloneModals
import { useWizard, type SerializableWizardState, type WizardStep } from './components/Wizard';
// CONDUCTOR_BADGES moved to useAutoRunAchievements hook
import { EmptyStateView } from './components/EmptyStateView';
// DeleteAgentConfirmModal, MarketplaceModal, SymphonyModal, DocumentGraphView,
// DirectorNotesModal, CueModal, CueYamlEditor are now lazy-loaded inside AppStandaloneModals

// Lazy-loaded components for performance (rarely-used heavy views)
const LogViewer = lazy(() =>
	import('./components/LogViewer').then((m) => ({ default: m.LogViewer }))
);

import { captureException } from './utils/sentry';

// SymphonyContributionData type moved to useSymphonyContribution hook

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
	useForkConversation,
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
	useAppRemoteEventListeners,
	// UI
	useThemeStyles,
	useAppHandlers,
	// Auto Run
	useAutoRunHandlers,
	// Tab handlers
	useTabHandlers,
	useTerminalTabHandlers,
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
	// Tour actions (right panel control from tour overlay)
	useTourActions,
	// Idle notification (fires command when all agents/batches finish)
	useIdleNotification,
	// Queue handlers (queue browser UI operations)
	useQueueHandlers,
	// Queue processing (execution queue processing + startup recovery)
	useQueueProcessing,
	// Tab export handlers (copy context, export HTML, publish gist)
	useTabExportHandlers,
	// Auto Run achievements (progress tracking, peak stats)
	useAutoRunAchievements,
	// Auto Run document loader (list, tree, task counts, file watching)
	useAutoRunDocumentLoader,
	// Prompt Composer modal handlers
	usePromptComposerHandlers,
	// Quick Actions modal handlers (Cmd+K)
	useQuickActionsHandlers,
	// Session cycling (Cmd+Shift+[/])
	useCycleSession,
	// Input mode toggle (Tier 3A)
	useInputMode,
	// Live mode management (Tier 3B)
	useLiveMode,
	// Session switching callbacks (navigate to session/tab from various UI surfaces)
	useSessionSwitchCallbacks,
} from './hooks';
import { useMainPanelProps, useSessionListProps, useRightPanelProps } from './hooks/props';
import { useAgentListeners } from './hooks/agent/useAgentListeners';
import { useSymphonyContribution } from './hooks/symphony/useSymphonyContribution';
import { useCueAutoDiscovery } from './hooks/useCueAutoDiscovery';

// Import contexts
import { useLayerStack } from './contexts/LayerStackContext';
import { notifyToast } from './stores/notificationStore';
import { useModalActions, useModalStore } from './stores/modalStore';
import { GitStatusProvider } from './contexts/GitStatusContext';
import { InputProvider, useInputContext } from './contexts/InputContext';
import { useGroupChatStore } from './stores/groupChatStore';
import { useBatchStore } from './stores/batchStore';
// All session state is read directly from useSessionStore in MaestroConsoleInner.
import {
	useSessionStore,
	selectActiveSession,
	updateSessionWith,
	updateAiTab,
} from './stores/sessionStore';
import { useActiveSession } from './hooks/session/useActiveSession';
// useAgentStore moved to useQueueProcessing hook
import { InlineWizardProvider, useInlineWizardContext } from './contexts/InlineWizardContext';
import { ToastContainer } from './components/Toast';

// Import services
// gitService — now used in useModalHandlers (Tier 3C)

// Import types and constants
// Note: GroupChat, GroupChatState are imported from types (re-exported from shared)
import type { RightPanelTab, Session, QueuedItem, CustomAICommand, ThinkingItem } from './types';
import { THEMES } from './constants/themes';
import { generateId } from './utils/ids';
import { getContextColor } from './utils/theme';
// safeClipboardWrite moved to AppStandaloneModals (GistPublishModal handler)
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
	navigateToClosestTerminalTab,
	hasActiveWizard,
	findNextUnreadSession,
	getTabDisplayName,
} from './utils/tabHelpers';
// validateNewSession moved to useSymphonyContribution, useSessionCrud hooks
// formatLogsForClipboard moved to useTabExportHandlers hook
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
		// settingsTab — now self-sourced in AppStandaloneModals
		setSettingsTab,
		// New Instance Modal
		newInstanceModalOpen,
		duplicatingSessionId,
		// Edit Agent Modal
		setEditAgentModalOpen,
		editAgentSession,
		setEditAgentSession,
		// Delete Agent Modal — open state and session now self-sourced in AppStandaloneModals
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
		feedbackModalOpen,
		setFeedbackModalOpen,
		// Update Check Modal
		setUpdateCheckModalOpen,
		// standingOvationData, firstRunCelebrationData — now self-sourced in AppOverlays (Tier 1A)
		// Log Viewer
		logViewerOpen,
		setLogViewerOpen,
		// Process Monitor
		processMonitorOpen,
		setProcessMonitorOpen,
		// Usage Dashboard
		setUsageDashboardOpen,
		// pendingKeyboardMasteryLevel — now self-sourced in AppOverlays (Tier 1A)
		// Playground Panel — playgroundOpen now self-sourced in AppStandaloneModals
		setPlaygroundOpen,
		// Debug Wizard Modal — debugWizardModalOpen now self-sourced in AppStandaloneModals
		setDebugWizardModalOpen,
		// Debug Package Modal — debugPackageModalOpen now self-sourced in AppStandaloneModals
		setDebugPackageModalOpen,
		// Windows Warning Modal — windowsWarningModalOpen now self-sourced in AppStandaloneModals
		// Confirmation Modal
		confirmModalOpen,
		setConfirmModalOpen,
		confirmModalMessage,
		setConfirmModalMessage,
		confirmModalOnConfirm,
		setConfirmModalOnConfirm,
		confirmModalTitle,
		confirmModalDestructive,
		// Rename Instance Modal
		renameInstanceModalOpen,
		setRenameInstanceModalOpen,
		renameInstanceValue,
		setRenameInstanceValue,
		renameInstanceSessionId,
		// Rename Tab Modal
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
		// Memory Viewer (Claude Code per-project memory)
		memoryViewerOpen,
		setMemoryViewerOpen,
		// Batch Runner Modal
		setBatchRunnerModalOpen,
		// Auto Run Setup Modal
		setAutoRunSetupModalOpen,
		// Marketplace Modal — marketplaceModalOpen now self-sourced in AppStandaloneModals
		setMarketplaceModalOpen,
		// Wizard Resume Modal — open state and resume state now self-sourced in AppStandaloneModals
		// setWizardResumeModalOpen, setWizardResumeState — now used in useWizardHandlers (Tier 3D)
		// Agent Error Modal
		// Worktree Modals
		createWorktreeSession,
		createPRSession,
		setCreatePRSession,
		deleteWorktreeSession,
		// Tab Switcher Modal
		setTabSwitcherOpen,
		// Fuzzy File Search Modal
		setFuzzyFileSearchOpen,
		// Prompt Composer Modal
		setPromptComposerOpen,
		// Merge Session Modal
		setMergeSessionModalOpen,
		// Send to Agent Modal
		setSendToAgentModalOpen,
		// Group Chat Modals
		setShowNewGroupChatModal,
		showDeleteGroupChatModal,
		showRenameGroupChatModal,
		showEditGroupChatModal,
		// Git Diff Viewer
		gitDiffPreview,
		setGitDiffPreview,
		// Git Log Viewer
		gitLogOpen,
		setGitLogOpen,
		// Tour Overlay — tourOpen, tourFromWizard now self-sourced in AppStandaloneModals
		// setTourFromWizard now used in useWizardHandlers via getModalActions()
		// Symphony Modal — symphonyModalOpen now self-sourced in AppStandaloneModals
		setSymphonyModalOpen,
		// Director's Notes Modal — directorNotesOpen now self-sourced in AppStandaloneModals
		setDirectorNotesOpen,
		// Maestro Cue Modal — cueModalOpen now self-sourced in AppStandaloneModals
		setCueModalOpen,
		// Maestro Cue YAML Editor — open state, sessionId, projectRoot self-sourced in AppStandaloneModals
		closeCueYamlEditor,
	} = useModalActions();

	// --- MOBILE LANDSCAPE MODE (reading-only view) ---
	const isMobileLandscape = useMobileLandscape();

	// --- NAVIGATION HISTORY (back/forward through sessions and tabs) ---
	const { pushNavigation, navigateBack, navigateForward } = useNavigationHistory();

	// --- WIZARD (onboarding wizard for new users) ---
	const {
		state: wizardState,
		openWizard: _baseOpenWizardModal,
		restoreState: restoreWizardState,
		loadResumeState: _loadResumeState,
		clearResumeState,
		completeWizard,
		closeWizard: _closeWizardModal,
		goToStep: wizardGoToStep,
	} = useWizard();

	// Wrapper for openWizard that checks for resume state
	const openWizardModal = useCallback(async () => {
		try {
			const saved = await window.maestro.settings.get('wizardResumeState');
			// Validate saved state has a resumable step before casting
			// These are the steps where we can resume the wizard (not agent-selection)
			const resumableSteps: WizardStep[] = [
				'directory-selection',
				'conversation',
				'preparing-plan',
				'phase-review',
			];
			if (
				saved &&
				typeof saved === 'object' &&
				'currentStep' in saved &&
				typeof saved.currentStep === 'string' &&
				resumableSteps.includes(saved.currentStep as WizardStep)
			) {
				useModalStore
					.getState()
					.openModal('wizardResume', { state: saved as SerializableWizardState });
				return;
			}
		} catch (e) {
			captureException(e, { extra: { context: 'openWizardModal', setting: 'wizardResumeState' } });
			console.error('[App] Failed to check wizard resume state:', e);
		}
		_baseOpenWizardModal();
	}, [_baseOpenWizardModal]);
	// --- SETTINGS (from useSettings hook) ---
	const settings = useSettings();
	const {
		conductorProfile,
		fontFamily,
		fontSize,
		activeThemeId,
		customThemeColors,
		enterToSendAI,
		setEnterToSendAI,
		enterToSendAIExpanded,
		defaultSaveToHistory,
		defaultShowThinking,
		rightPanelWidth,
		setRightPanelWidth,
		markdownEditMode,
		setMarkdownEditMode,
		chatRawTextMode,
		setChatRawTextMode,
		showHiddenFiles: _showHiddenFiles,
		setShowHiddenFiles: _setShowHiddenFiles,
		logLevel,
		logViewerSelectedLevels,
		setLogViewerSelectedLevels,
		maxOutputLines,
		enableBetaUpdates,
		setEnableBetaUpdates,
		shortcuts,
		tabShortcuts,
		customAICommands,
		totalActiveTimeMs,
		addTotalActiveTimeMs,
		autoRunStats,
		usageStats,
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
		colorBlindMode,
		defaultStatsTimeRange,
		documentGraphShowExternalLinks,
		documentGraphMaxNodes,
		documentGraphPreviewCharLimit,
		documentGraphLayoutType,

		// Rendering settings
		disableConfetti: _disableConfetti,

		// File tab refresh settings
		fileTabAutoRefreshEnabled,
		useNativeTitleBar,
		setSuppressWindowsWarning,
		encoreFeatures,
	} = settings;

	// Reset modal-open flags when their Encore Feature toggle is disabled
	useEffect(() => {
		if (!encoreFeatures.symphony) setSymphonyModalOpen(false);
	}, [encoreFeatures.symphony, setSymphonyModalOpen]);

	useEffect(() => {
		if (!encoreFeatures.usageStats) setUsageDashboardOpen(false);
	}, [encoreFeatures.usageStats, setUsageDashboardOpen]);

	useEffect(() => {
		if (!encoreFeatures.maestroCue) {
			setCueModalOpen(false);
			closeCueYamlEditor();
		}
	}, [encoreFeatures.maestroCue, setCueModalOpen, closeCueYamlEditor]);

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
	// sessionsLoaded moved to useQueueProcessing hook
	const activeSession = useActiveSession();

	// Actions — stable references from store, never trigger re-renders
	const {
		setSessions,
		setGroups,
		setActiveSessionId: storeSetActiveSessionId,
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
	// groupChatsExpanded moved to useCycleSession hook
	const showUnreadOnly = useUIStore((s) => s.showUnreadOnly);
	const showUnreadAgentsOnly = useUIStore((s) => s.showUnreadAgentsOnly);
	const fileTreeFilter = useFileExplorerStore((s) => s.fileTreeFilter);
	const fileTreeFilterOpen = useFileExplorerStore((s) => s.fileTreeFilterOpen);
	const editingGroupId = useUIStore((s) => s.editingGroupId);
	const editingSessionId = useUIStore((s) => s.editingSessionId);
	const draggingSessionId = useUIStore((s) => s.draggingSessionId);
	// flashNotification, successFlashNotification — now self-sourced in AppStandaloneModals
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

	const {
		setSelectedFileIndex: _setSelectedFileIndex,
		setFileTreeFilter: _setFileTreeFilter,
		setFileTreeFilterOpen,
	} = useFileExplorerStore.getState();

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
		setActiveGroupChatId,
		setGroupChatStagedImages,
		setGroupChatReadOnlyMode,
		setGroupChatRightTab,
		setGroupChatParticipantColors,
	} = useGroupChatStore.getState();

	// --- APP INITIALIZATION (extracted hook, Phase 2G) ---
	const {
		ghCliAvailable,
		sshRemoteConfigs,
		speckitCommands,
		openspecCommands,
		bmadCommands,
		saveFileGistUrl,
	} = useAppInitialization();

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
	// isGraphViewOpen, graphFocusFilePath — now self-sourced in AppStandaloneModals
	const lastGraphFocusFilePath = useFileExplorerStore((s) => s.lastGraphFocusFilePath);

	const [gistPublishModalOpen, setGistPublishModalOpen] = useState(false);
	// tabGistContent — now self-sourced in AppStandaloneModals
	const fileGistUrls = useTabStore((s) => s.fileGistUrls);

	// Note: Delete Agent Modal State is now self-sourced in AppStandaloneModals

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

	// Global Live Mode — extracted to useLiveMode hook (Tier 3B)
	const { isLiveMode, webInterfaceUrl, toggleGlobalLive, restartWebServer } = useLiveMode();

	// Auto Run document management state (from batchStore)
	// Content is per-session in session.autoRunContent
	const autoRunDocumentList = useBatchStore((s) => s.documentList);
	const autoRunDocumentTree = useBatchStore((s) => s.documentTree);
	const {
		setDocumentList: setAutoRunDocumentList,
		setDocumentTree: setAutoRunDocumentTree,
		setIsLoadingDocuments: setAutoRunIsLoadingDocuments,
	} = useBatchStore.getState();

	// handleProcessMonitorNavigateToSession - now in useSessionSwitchCallbacks hook

	// Startup effects (splash, GitHub CLI, Windows warning, gist URLs, beta updates,
	// update check, leaderboard sync, SpecKit/OpenSpec/BMAD loading, SSH configs, stats DB check,
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
	const bmadCommandsRef = useRef(bmadCommands);
	const fileTabAutoRefreshEnabledRef = useRef(fileTabAutoRefreshEnabled);
	customAICommandsRef.current = customAICommands;
	speckitCommandsRef.current = speckitCommands;
	openspecCommandsRef.current = openspecCommands;
	bmadCommandsRef.current = bmadCommands;
	fileTabAutoRefreshEnabledRef.current = fileTabAutoRefreshEnabled;

	// Note: spawnBackgroundSynopsisRef and spawnAgentWithPromptRef are now provided by useAgentExecution hook
	// Note: addHistoryEntryRef is now provided by useAgentSessionManagement hook
	// Ref for processQueuedMessage - allows batch exit handler to process queued messages
	const processQueuedItemRef = useRef<
		((sessionId: string, item: QueuedItem) => Promise<void>) | null
	>(null);
	// Ref for handleResumeSession - bridges ordering gap between useModalHandlers and useAgentSessionManagement
	const handleResumeSessionRef = useRef<((agentSessionId: string) => void) | null>(null);

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

	// --- CUE AUTO-DISCOVERY (gated by Encore Feature) ---
	useCueAutoDiscovery(sessions, encoreFeatures);

	// --- TAB HANDLERS (extracted hook) ---
	const {
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
		handleNewFileTab,
		handleNewBrowserTab,
		handleSelectBrowserTab,
		handleCloseBrowserTab,
		handleUpdateBrowserTab,
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

	// --- TERMINAL TAB HANDLERS ---
	const { handleOpenTerminalTab, handleSelectTerminalTab, handleCloseTerminalTab } =
		useTerminalTabHandlers();

	// Opens the rename modal for a terminal tab (1-arg wrapper for useMainPanelProps)
	const handleRequestTerminalTabRename = useCallback(
		(tabId: string) => {
			const session = selectActiveSession(useSessionStore.getState());
			if (!session) return;
			const tab = session.terminalTabs?.find((t) => t.id === tabId);
			if (!tab) return;
			setRenameTabId(tabId);
			setRenameTabInitialName(tab.name ?? '');
			setRenameTabModalOpen(true);
		},
		[setRenameTabId, setRenameTabInitialName, setRenameTabModalOpen]
	);

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
		handleDeleteAllArchivedGroupChats,
		handleProcessMonitorNavigateToGroupChat,
		handleOpenModeratorSession,
		handleJumpToGroupChatMessage,
		handleGroupChatRightTabChange,
		handleSendGroupChatMessage,
		handleGroupChatDraftChange,
		handleRemoveGroupChatQueueItem,
		handleReorderGroupChatQueueItems,
		handleStopAll: handleGroupChatStopAll,
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
		effectiveAgentError,
		recoveryActions,
		handleCloseGitDiff,
		handleCloseGitLog,
		handleCloseSettings,
		handleCloseDebugPackage,
		handleCloseShortcutsHelp,
		handleCloseAboutModal,
		handleCloseFeedbackModal,
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
		handleOpenFeedbackModal,
		handleOpenBatchRunner,
		handleOpenMarketplace,
		handleEditAgent,
		handleOpenCreatePRSession,
		handleConfigureCue,
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
		handleViewGitDiff,
		handleDirectorNotesResumeSession,
	} = useModalHandlers(inputRef, terminalOutputRef, handleResumeSessionRef);

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
		refreshWorktreeState,
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

	// Auto-focus the AI input box when switching from terminal to AI mode
	const prevInputModeRef = useRef(activeSession?.inputMode);
	const shouldFocusOnModeSwitch =
		prevInputModeRef.current === 'terminal' && activeSession?.inputMode === 'ai';
	useFocusAfterRender(inputRef, shouldFocusOnModeSwitch, 0);
	useEffect(() => {
		prevInputModeRef.current = activeSession?.inputMode;
	}, [activeSession?.inputMode]);

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
	useCliActivityMonitoring({ setSessions });

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

	// Fork conversation hook - creates a new tab in the current session from a point in conversation history
	const handleForkConversation = useForkConversation(sessions, setSessions, activeSessionId);

	// Summarize & Continue hook for context compaction (non-blocking, per-tab)
	const {
		summarizeState,
		progress: summarizeProgress,
		result: summarizeResult,
		error: _summarizeError,
		startTime,
		cancelTab,
		canSummarize,
		handleSummarizeAndContinue,
	} = useSummarizeAndContinue(activeSession ?? null);

	// Combine custom AI commands with bundled methodology commands for input processing.
	const allCustomCommands = useMemo((): CustomAICommand[] => {
		const speckitAsCustom: CustomAICommand[] = speckitCommands.map((cmd) => ({
			id: `speckit-${cmd.id}`,
			command: cmd.command,
			description: cmd.description,
			prompt: cmd.prompt,
			isBuiltIn: true,
		}));
		const openspecAsCustom: CustomAICommand[] = openspecCommands.map((cmd) => ({
			id: `openspec-${cmd.id}`,
			command: cmd.command,
			description: cmd.description,
			prompt: cmd.prompt,
			isBuiltIn: true,
		}));
		const bmadAsCustom: CustomAICommand[] = bmadCommands.map((cmd) => ({
			id: `bmad-${cmd.id}`,
			command: cmd.command,
			description: cmd.description,
			prompt: cmd.prompt,
			isBuiltIn: true,
		}));
		return [...customAICommands, ...speckitAsCustom, ...openspecAsCustom, ...bmadAsCustom];
	}, [customAICommands, speckitCommands, openspecCommands, bmadCommands]);

	// Combine built-in slash commands with custom AI commands, bundled methodology
	// commands, and agent-specific commands for autocomplete.
	const allSlashCommands = useMemo(() => {
		const customCommandsAsSlash = customAICommands.map((cmd) => ({
			command: cmd.command,
			description: cmd.description,
			aiOnly: true,
			prompt: cmd.prompt,
		}));
		const speckitCommandsAsSlash = speckitCommands.map((cmd) => ({
			command: cmd.command,
			description: cmd.description,
			aiOnly: true,
			prompt: cmd.prompt,
		}));
		const openspecCommandsAsSlash = openspecCommands.map((cmd) => ({
			command: cmd.command,
			description: cmd.description,
			aiOnly: true,
			prompt: cmd.prompt,
		}));
		const bmadCommandsAsSlash = bmadCommands.map((cmd) => ({
			command: cmd.command,
			description: cmd.description,
			aiOnly: true,
			prompt: cmd.prompt,
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
			...bmadCommandsAsSlash,
			...agentCommands,
		];
	}, [
		customAICommands,
		speckitCommands,
		openspecCommands,
		bmadCommands,
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
			showFlash: showSuccessFlash,
		});

	// handleDirectorNotesResumeSession — extracted to useModalHandlers (Tier 3C)
	// Bridge: keep handleResumeSessionRef in sync for useModalHandlers
	handleResumeSessionRef.current = handleResumeSession;

	// --- SESSION SWITCH CALLBACKS (navigate to session/tab from various UI surfaces) ---
	const {
		handleProcessMonitorNavigateToSession,
		handleToastSessionClick,
		handleNamedSessionSelect,
		handleUtilityTabSelect,
		handleUtilityFileTabSelect,
	} = useSessionSwitchCallbacks({
		setActiveSessionId,
		handleResumeSession,
		inputRef,
	});

	// --- BATCH HANDLERS (Auto Run processing, quit confirmation, error handling) ---
	const {
		startBatchRun,
		stopBatchRun,
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
		updateSessionWith(activeSessionIdRef.current, (s) => ({
			...s,
			executionQueue: s.executionQueue.filter((item) => item.id !== itemId),
		}));
	}, []);

	// toggleBookmark — provided by useSessionCrud hook

	const handleFocusFileInGraph = useFileExplorerStore.getState().focusFileInGraph;
	const handleOpenLastDocumentGraph = useFileExplorerStore.getState().openLastDocumentGraph;

	// Tab export handlers (copy context, export HTML, publish gist) — extracted to useTabExportHandlers
	const {
		handleCopyContext,
		handleExportHtml,
		handlePublishTabGist,
		handleCopyText,
		handlePublishTextAsGist,
		handleSendTextToAgent,
	} = useTabExportHandlers({
		sessionsRef,
		activeSessionIdRef,
		themeRef,
		setGistPublishModalOpen,
	});

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
		handleWizardResume,
		handleWizardStartFresh,
		handleWizardResumeClose,
	} = useWizardHandlers({
		inlineWizardContext,
		wizardContext: {
			state: wizardState,
			completeWizard,
			clearResumeState,
			openWizard: openWizardModal,
			restoreState: restoreWizardState,
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

	// Force Send: dispatch a queued item immediately with forceParallel=true.
	// Mirrors the user's manual flow (copy text → delete queued → Cmd+Shift+Enter)
	// but as a single click. Only useful when another tab in this agent is busy
	// AND this tab is idle — processInput(forceParallel:true) then sends now.
	const handleForceSendQueuedItem = useCallback(
		(itemId: string) => {
			const sessionId = activeSessionIdRef.current;
			const session = sessionsRef.current.find((s) => s.id === sessionId);
			if (!session) return;
			const item = session.executionQueue.find((i) => i.id === itemId);
			if (!item) return;
			const text = item.type === 'command' ? (item.command ?? '') : (item.text ?? '');
			if (!text) return;

			// Remove the item from the queue first so processInput doesn't see a duplicate.
			updateSessionWith(sessionId, (s) => ({
				...s,
				executionQueue: s.executionQueue.filter((i) => i.id !== itemId),
			}));

			// Preserve the item's attached images through the send path.
			// stagedImages lives on the active tab; processInput reads it below.
			if (item.images && item.images.length > 0) {
				setStagedImages(item.images);
			}

			// Dispatch with forceParallel — same code path as Cmd+Shift+Enter.
			processInput(text, { forceParallel: true });
		},
		[processInput, setStagedImages]
	);

	// Build (tab→busy summary) lookup used by the Force Send button to decide
	// visibility and to populate the confirmation modal's "other tabs working"
	// list. Computed from the current session's tab states at call time.
	const getForceSendContext = useCallback((item: QueuedItem) => {
		const session = sessionsRef.current.find((s) => s.id === activeSessionIdRef.current);
		if (!session) return null;
		const targetTab = session.aiTabs.find((t) => t.id === item.tabId);
		const targetTabBusy = targetTab?.state === 'busy';
		const otherBusyTabs = session.aiTabs
			.filter((t) => t.id !== item.tabId && t.state === 'busy')
			.map((t) => ({ id: t.id, displayName: getTabDisplayName(t) }));
		return { targetTabBusy, otherBusyTabs };
	}, []);

	// This is used by context transfer to automatically send the transferred context to the agent
	useEffect(() => {
		if (!activeSession) return;

		const activeTab = getActiveTab(activeSession);
		if (!activeTab?.autoSendOnActivate) return;

		// Capture intended targets so we can verify they haven't changed after the delay
		const targetSessionId = activeSession.id;
		const targetTabId = activeTab.id;

		// Clear the flag first to prevent multiple sends
		updateAiTab(targetSessionId, targetTabId, (tab) => ({ ...tab, autoSendOnActivate: false }));

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

	// Auto Run achievement tracking (progress intervals, peak usage stats)
	useAutoRunAchievements({ activeBatchSessionIds });

	// Handler for switching to autorun tab - shows setup modal if no folder configured
	const handleSetActiveRightTab = useCallback(
		(tab: RightPanelTab) => {
			if (tab === 'autorun' && settings.autoRunDisabled) return;
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
			updateSessionWith(activeSession.id, (s) => ({ ...s, fileTreeAutoRefreshInterval: interval }));
		},
		[activeSession]
	);

	// handleToastSessionClick, deep link navigation - now in useSessionSwitchCallbacks hook

	// --- SESSION SORTING ---
	// Extracted hook for sorted and visible session lists (ignores leading emojis for alphabetization)
	const { sortedSessions, visibleSessions, navSessions, bookmarkNavSize, navIndexMap } =
		useSortedSessions({
			sessions,
			groups,
			bookmarksCollapsed,
			showUnreadAgentsOnly,
			activeSessionId,
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
		navSessions,
		bookmarkNavSize,
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
		handleAutoNameTab,
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

	// Auto Run document loading (list, tree, task counts, file watching)
	useAutoRunDocumentLoader();

	// NOTE: Auto Run document loading and file watching are now handled by useAutoRunDocumentLoader hook

	// --- ACTIONS ---
	// cycleSession — provided by useCycleSession hook
	const { cycleSession } = useCycleSession({ sortedSessions, handleOpenGroupChat });

	// goToNextUnreadTab — jump to the next agent with unread tabs, clearing current agent's unreads
	const goToNextUnreadTab = useCallback(() => {
		const currentActiveId = useSessionStore.getState().activeSessionId;
		const result = findNextUnreadSession(sortedSessions, currentActiveId);

		// Clear current agent's unread tabs
		if (result.clearedCurrent) {
			setSessions((prev) =>
				prev.map((s) => {
					if (s.id !== currentActiveId) return s;
					return {
						...s,
						aiTabs: s.aiTabs.map((t) => (t.hasUnread ? { ...t, hasUnread: false } : t)),
					};
				})
			);
		}

		if (result.jumped && result.targetSessionId) {
			setActiveSessionId(result.targetSessionId);
			const targetTabId = result.targetTabId;
			if (targetTabId) {
				setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== result.targetSessionId) return s;
						return { ...s, activeTabId: targetTabId };
					})
				);
			}
		} else {
			showSuccessFlash('No unread or draft tabs');
		}
	}, [sortedSessions, setSessions, setActiveSessionId, showSuccessFlash]);

	// showConfirmation, performDeleteSession — provided by useSessionLifecycle hook (Phase 2H)
	// deleteSession, deleteWorktreeGroup — provided by useSessionCrud hook

	// addNewSession, createNewSession — provided by useSessionCrud hook

	// handleWizardLaunchSession now in useWizardHandlers hook

	// toggleInputMode — extracted to useInputMode hook (Tier 3A)
	const { toggleInputMode } = useInputMode({ setTabCompletionOpen, setSlashCommandOpen });

	// toggleUnreadFilter, toggleTabStar, toggleTabUnread — provided by useSessionLifecycle hook (Phase 2H)

	// toggleGlobalLive, restartWebServer — extracted to useLiveMode hook (Tier 3B)

	// --- REMOTE HANDLERS (remote command processing, SSH name mapping) ---
	const { handleQuickActionsToggleRemoteControl, sessionSshRemoteNames } = useRemoteHandlers({
		sessionsRef,
		customAICommandsRef,
		speckitCommandsRef,
		openspecCommandsRef,
		bmadCommandsRef,
		toggleGlobalLive,
		isLiveMode,
		sshRemoteConfigs,
	});

	// handleViewGitDiff — extracted to useModalHandlers (Tier 3C)

	// startRenamingSession, finishRenamingSession — provided by useSessionCrud hook

	// handleDragStart, handleDragOver — provided by useSessionCrud hook

	// Note: processInput has been extracted to useInputProcessing hook (see line ~2128)

	// Note: handleRemoteCommand effect extracted to useRemoteHandlers hook (Phase 2K)

	// Tour actions (right panel control from tour overlay) — extracted to useTourActions hook
	useTourActions();

	// Idle notification — fires configured command when all agents/batches finish
	useIdleNotification();

	// Queue processing (execution, startup recovery) — extracted to useQueueProcessing hook
	const { processQueuedItem } = useQueueProcessing({
		conductorProfile,
		customAICommandsRef,
		speckitCommandsRef,
		openspecCommandsRef,
		bmadCommandsRef,
	});
	// Bridge: keep the original processQueuedItemRef in sync
	processQueuedItemRef.current = processQueuedItem;

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

	// --- REMOTE EVENT LISTENERS (extracted to useAppRemoteEventListeners hook) ---
	useAppRemoteEventListeners({
		sessionsRef,
		setActiveSessionId,
		setSessions,
		setGroups,
		handleOpenFileTab,
		refreshFileTree,
		handleAutoRunRefresh,
		startBatchRun,
		stopBatchRun,
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
				sessionId: session?.id,
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
			updateSessionWith(activeSession.id, (s) => ({
				...s,
				batchRunnerPrompt: prompt,
				batchRunnerPromptModifiedAt: Date.now(),
			}));
		},
		[activeSession]
	);
	// handleUtilityTabSelect, handleUtilityFileTabSelect, handleNamedSessionSelect
	// - now in useSessionSwitchCallbacks hook
	const handleFileSearchSelect = useCallback(
		(file: FlatFileItem) => {
			// Preview the file directly (handleFileClick expects relative path)
			if (!file.isFolder) {
				handleFileClick({ name: file.name, type: 'file' }, file.fullPath);
			}
		},
		[handleFileClick]
	);
	// Prompt Composer modal handlers — extracted to usePromptComposerHandlers hook
	const {
		handlePromptComposerSubmit,
		handlePromptComposerSend,
		handlePromptToggleTabSaveToHistory,
		handlePromptToggleTabReadOnlyMode,
		handlePromptToggleTabShowThinking,
		handlePromptToggleEnterToSend,
	} = usePromptComposerHandlers({
		handleSendGroupChatMessage,
		processInput,
		setInputValue,
	});

	// Quick Actions modal handlers — extracted to useQuickActionsHandlers hook
	const {
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
	} = useQuickActionsHandlers({
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
	});

	// Queue browser handlers — extracted to useQueueHandlers hook
	const { handleRemoveQueueItem, handleSwitchQueueSession, handleReorderQueueItems } =
		useQueueHandlers();

	// Symphony contribution handler — extracted to useSymphonyContribution hook
	const { handleStartContribution } = useSymphonyContribution({
		startBatchRun,
		inputRef,
	});

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
		setSessions,
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
		setMemoryViewerOpen,
		setLogViewerOpen,
		setProcessMonitorOpen,
		setUsageDashboardOpen,
		logsEndRef,
		inputRef,
		terminalOutputRef,
		sidebarContainerRef,
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
		navigateToClosestTerminalTab,
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
		setCueModalOpen,
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

		// Terminal tab handlers for keyboard shortcuts (Phase 9)
		handleOpenTerminalTab,
		handleSelectTerminalTab,
		handleCloseTerminalTab,
		mainPanelRef,

		// File tab handler for keyboard shortcut (Alt+N)
		handleNewFileTab,

		// Browser tab handler for keyboard shortcut (Cmd+B)
		handleNewBrowserTab,

		// Session bookmark toggle
		toggleBookmark,

		// Unread agents filter toggle
		toggleShowUnreadAgentsOnly: useUIStore.getState().toggleShowUnreadAgentsOnly,

		// Next unread tab navigation
		goToNextUnreadTab,
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

	const handleOpenOutputSearch = useCallback(() => {
		useUIStore.getState().setOutputSearchOpen(true);
	}, []);

	const mainPanelProps = useMainPanelProps({
		// Core state
		logViewerOpen,
		agentSessionsOpen,
		memoryViewerOpen,
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
		setMemoryViewerOpen,
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
		handleForceSendQueuedItem,
		forcedParallelEnabled: settings.forcedParallelExecution,
		getForceSendContext,
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
		handleOpenOutputSearch,
		handleCloseAllTabs,
		handleCloseOtherTabs,
		handleCloseTabsLeft,
		handleCloseTabsRight,

		// Unified tab system (Phase 4)
		unifiedTabs,
		activeFileTabId: activeSession?.activeFileTabId ?? null,
		activeFileTab,
		activeBrowserTabId: activeSession?.activeBrowserTabId ?? null,
		activeBrowserTab,
		handleFileTabSelect: handleSelectFileTab,
		handleFileTabClose: handleCloseFileTab,
		handleNewFileTab,
		handleNewBrowserTab,
		handleBrowserTabSelect: handleSelectBrowserTab,
		handleBrowserTabClose: handleCloseBrowserTab,
		handleBrowserTabUpdate: handleUpdateBrowserTab,

		// Terminal tab callbacks (Phase 8)
		handleOpenTerminalTab,
		handleTerminalTabSelect: handleSelectTerminalTab,
		handleTerminalTabClose: handleCloseTerminalTab,
		handleTerminalTabRename: handleRequestTerminalTabRename,
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
		handleForkConversation,
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
		handleCopyText,
		handlePublishTextAsGist,
		handleSendTextToAgent,
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
		navIndexMap,

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
		handleConfigureCue,
		openWizardModal,
		handleOpenFeedbackModal,
		handleStartTour,

		// Group Chat handlers
		handleOpenGroupChat,
		handleNewGroupChat,
		handleEditGroupChat,
		handleOpenRenameGroupChatModal,
		handleOpenDeleteGroupChatModal,
		handleArchiveGroupChat,
		handleDeleteAllArchivedGroupChats,
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
					// Common props (sessions/groups/groupChats + modal booleans self-sourced from stores — Tier 1B)
					theme={theme}
					shortcuts={shortcuts}
					tabShortcuts={tabShortcuts}
					// AppInfoModals props
					onCloseShortcutsHelp={handleCloseShortcutsHelp}
					hasNoAgents={hasNoAgents}
					keyboardMasteryStats={keyboardMasteryStats}
					onCloseAboutModal={handleCloseAboutModal}
					feedbackModalOpen={feedbackModalOpen}
					onCloseFeedbackModal={handleCloseFeedbackModal}
					autoRunStats={autoRunStats}
					usageStats={usageStats}
					handsOnTimeMs={totalActiveTimeMs}
					onOpenLeaderboardRegistration={handleOpenLeaderboardRegistrationFromAbout}
					onSwitchToSession={setActiveSessionId}
					isLeaderboardRegistered={isLeaderboardRegistered}
					onCloseUpdateCheckModal={handleCloseUpdateCheckModal}
					onCloseProcessMonitor={handleCloseProcessMonitor}
					onNavigateToSession={handleProcessMonitorNavigateToSession}
					onNavigateToGroupChat={handleProcessMonitorNavigateToGroupChat}
					onCloseUsageDashboard={() => setUsageDashboardOpen(false)}
					defaultStatsTimeRange={defaultStatsTimeRange}
					colorBlindMode={colorBlindMode}
					// AppConfirmModals props
					confirmModalMessage={confirmModalMessage}
					confirmModalOnConfirm={confirmModalOnConfirm}
					confirmModalTitle={confirmModalTitle}
					confirmModalDestructive={confirmModalDestructive}
					onCloseConfirmModal={handleCloseConfirmModal}
					onConfirmQuit={handleConfirmQuit}
					onCancelQuit={handleCancelQuit}
					activeBatchSessionIds={activeBatchSessionIds}
					// AppSessionModals props
					onCloseNewInstanceModal={handleCloseNewInstanceModal}
					onCreateSession={createNewSession}
					existingSessions={sessionsForValidation}
					duplicatingSessionId={duplicatingSessionId}
					onCloseEditAgentModal={handleCloseEditAgentModal}
					onSaveEditAgent={handleSaveEditAgent}
					editAgentSession={editAgentSession}
					renameSessionValue={renameInstanceValue}
					setRenameSessionValue={setRenameInstanceValue}
					onCloseRenameSessionModal={handleCloseRenameSessionModal}
					renameSessionTargetId={renameInstanceSessionId}
					onAfterRename={flushSessionPersistence}
					renameTabId={renameTabId}
					renameTabInitialName={renameTabInitialName}
					onCloseRenameTabModal={handleCloseRenameTabModal}
					onRenameTab={handleRenameTab}
					onAutoNameTab={handleAutoNameTab}
					// AppGroupModals props
					createGroupModalOpen={createGroupModalOpen}
					onCloseCreateGroupModal={handleCloseCreateGroupModal}
					onGroupCreated={handleGroupCreated}
					renameGroupId={renameGroupId}
					renameGroupValue={renameGroupValue}
					setRenameGroupValue={setRenameGroupValue}
					renameGroupEmoji={renameGroupEmoji}
					setRenameGroupEmoji={setRenameGroupEmoji}
					onCloseRenameGroupModal={handleCloseRenameGroupModal}
					// AppWorktreeModals props
					onCloseWorktreeConfigModal={handleCloseWorktreeConfigModal}
					onSaveWorktreeConfig={handleSaveWorktreeConfig}
					onCreateWorktreeFromConfig={handleCreateWorktreeFromConfig}
					onDisableWorktreeConfig={handleDisableWorktreeConfig}
					createWorktreeSession={createWorktreeSession}
					onCloseCreateWorktreeModal={handleCloseCreateWorktreeModal}
					onCreateWorktree={handleCreateWorktree}
					createPRSession={createPRSession}
					onCloseCreatePRModal={handleCloseCreatePRModal}
					onPRCreated={handlePRCreated}
					deleteWorktreeSession={deleteWorktreeSession}
					onCloseDeleteWorktreeModal={handleCloseDeleteWorktreeModal}
					onConfirmDeleteWorktree={handleConfirmDeleteWorktree}
					onConfirmAndDeleteWorktreeOnDisk={handleConfirmAndDeleteWorktreeOnDisk}
					// AppUtilityModals props
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
					setFeedbackModalOpen={setFeedbackModalOpen}
					setLogViewerOpen={setLogViewerOpen}
					setProcessMonitorOpen={setProcessMonitorOpen}
					setUsageDashboardOpen={encoreFeatures.usageStats ? setUsageDashboardOpen : undefined}
					setActiveRightTab={setActiveRightTab}
					setAgentSessionsOpen={setAgentSessionsOpen}
					setMemoryViewerOpen={setMemoryViewerOpen}
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
					hasActiveSessionCapability={hasActiveSessionCapability}
					onOpenMergeSession={handleQuickActionsOpenMergeSession}
					onOpenSendToAgent={handleQuickActionsOpenSendToAgent}
					onQuickCreateWorktree={handleQuickCreateWorktree}
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
					onClearActiveTerminal={handleQuickActionsClearActiveTerminal}
					onCloseCurrentTab={handleQuickActionsCloseCurrentTab}
					onMoveTabToFirst={handleQuickActionsMoveTabToFirst}
					onMoveTabToLast={handleQuickActionsMoveTabToLast}
					onCopyTabContext={handleQuickActionsCopyTabContext}
					onExportTabHtml={handleQuickActionsExportTabHtml}
					onPublishTabGist={handleQuickActionsPublishTabGist}
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
					onCloseGitLog={handleCloseGitLog}
					onCloseAutoRunSetup={handleCloseAutoRunSetup}
					onAutoRunFolderSelected={handleAutoRunFolderSelected}
					onCloseBatchRunner={handleCloseBatchRunner}
					onStartBatchRun={handleStartBatchRun}
					onSaveBatchPrompt={handleSaveBatchPrompt}
					showConfirmation={showConfirmation}
					autoRunDocumentList={autoRunDocumentList}
					autoRunDocumentTree={autoRunDocumentTree}
					getDocumentTaskCount={getDocumentTaskCount}
					onAutoRunRefresh={handleAutoRunRefresh}
					onOpenMarketplace={handleOpenMarketplace}
					onOpenSymphony={encoreFeatures.symphony ? () => setSymphonyModalOpen(true) : undefined}
					onOpenDirectorNotes={
						encoreFeatures.directorNotes ? () => setDirectorNotesOpen(true) : undefined
					}
					onOpenMaestroCue={encoreFeatures.maestroCue ? () => setCueModalOpen(true) : undefined}
					onConfigureCue={encoreFeatures.maestroCue ? handleConfigureCue : undefined}
					onCloseTabSwitcher={handleCloseTabSwitcher}
					onTabSelect={handleUtilityTabSelect}
					onFileTabSelect={handleUtilityFileTabSelect}
					onTerminalTabSelect={handleSelectTerminalTab}
					onBrowserTabSelect={handleSelectBrowserTab}
					onNamedSessionSelect={handleNamedSessionSelect}
					filteredFileTree={filteredFileTree}
					fileExplorerExpanded={activeSession?.fileExplorerExpanded}
					onCloseFileSearch={handleCloseFileSearch}
					onFileSearchSelect={handleFileSearchSelect}
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
					promptEnterToSend={enterToSendAIExpanded}
					onPromptToggleEnterToSend={handlePromptToggleEnterToSend}
					onCloseQueueBrowser={handleCloseQueueBrowser}
					onRemoveQueueItem={handleRemoveQueueItem}
					onSwitchQueueSession={handleSwitchQueueSession}
					onReorderQueueItems={handleReorderQueueItems}
					// AppGroupChatModals props
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
					groupChatMessages={groupChatMessages}
					onCloseGroupChatInfo={handleCloseGroupChatInfo}
					onOpenModeratorSession={handleOpenModeratorSession}
					// AppAgentModals props
					onCloseLeaderboardRegistration={handleCloseLeaderboardRegistration}
					leaderboardRegistration={leaderboardRegistration}
					onSaveLeaderboardRegistration={handleSaveLeaderboardRegistration}
					onLeaderboardOptOut={handleLeaderboardOptOut}
					onSyncAutoRunStats={handleSyncAutoRunStats}
					errorSession={errorSession}
					effectiveAgentError={effectiveAgentError}
					recoveryActions={recoveryActions}
					onDismissAgentError={handleCloseAgentErrorModal}
					groupChatError={groupChatError}
					groupChatRecoveryActions={groupChatRecoveryActions}
					onClearGroupChatError={handleClearGroupChatError}
					onCloseMergeSession={handleCloseMergeSession}
					onMerge={handleMerge}
					transferState={transferState}
					transferProgress={transferProgress}
					transferSourceAgent={transferSourceAgent}
					transferTargetAgent={transferTargetAgent}
					onCancelTransfer={handleCancelTransfer}
					onCompleteTransfer={handleCompleteTransfer}
					onCloseSendToAgent={handleCloseSendToAgent}
					onSendToAgent={handleSendToAgent}
				/>

				{/* --- STANDALONE MODALS (debug, marketplace, wizard, settings, etc.) --- */}
				{/* Self-sources modal open states from modalStore, sessionStore, fileExplorerStore, tabStore */}
				<AppStandaloneModals
					theme={theme}
					// Debug / Playground
					onCloseDebugPackage={handleCloseDebugPackage}
					setSuppressWindowsWarning={setSuppressWindowsWarning}
					enableBetaUpdates={enableBetaUpdates}
					setEnableBetaUpdates={setEnableBetaUpdates}
					// AppOverlays
					autoRunStats={autoRunStats}
					onStandingOvationClose={handleStandingOvationClose}
					onOpenLeaderboardRegistration={handleOpenLeaderboardRegistration}
					isLeaderboardRegistered={isLeaderboardRegistered}
					onFirstRunCelebrationClose={handleFirstRunCelebrationClose}
					onKeyboardMasteryCelebrationClose={handleKeyboardMasteryCelebrationClose}
					// Marketplace
					onMarketplaceImportComplete={handleMarketplaceImportComplete}
					// Symphony
					sessions={sessions}
					setActiveSessionId={setActiveSessionId}
					onStartContribution={handleStartContribution}
					encoreFeatures={encoreFeatures}
					// Director's Notes
					onDirectorNotesResumeSession={handleDirectorNotesResumeSession}
					onFileClick={handleFileClick}
					// Cue
					shortcuts={shortcuts}
					// GistPublish
					gistPublishModalOpen={gistPublishModalOpen}
					setGistPublishModalOpen={setGistPublishModalOpen}
					activeFileTab={activeFileTab}
					saveFileGistUrl={saveFileGistUrl}
					fileGistUrls={fileGistUrls}
					// DocumentGraph
					onOpenFileTab={handleOpenFileTab}
					mainPanelRef={mainPanelRef}
					documentGraphShowExternalLinks={documentGraphShowExternalLinks}
					onExternalLinksChange={settings.setDocumentGraphShowExternalLinks}
					documentGraphMaxNodes={documentGraphMaxNodes}
					documentGraphPreviewCharLimit={documentGraphPreviewCharLimit}
					onPreviewCharLimitChange={settings.setDocumentGraphPreviewCharLimit}
					documentGraphLayoutType={documentGraphLayoutType}
					onLayoutTypeChange={settings.setDocumentGraphLayoutType}
					// DeleteAgent
					onPerformDeleteSession={performDeleteSession}
					onCloseDeleteAgentModal={handleCloseDeleteAgentModal}
					// Settings
					onCloseSettings={handleCloseSettings}
					hasNoAgents={hasNoAgents}
					setFlashNotification={setFlashNotification}
					// Wizard
					wizardIsOpen={wizardState.isOpen}
					onWizardLaunchSession={handleWizardLaunchSession}
					recordWizardStart={recordWizardStart}
					recordWizardResume={recordWizardResume}
					recordWizardAbandon={recordWizardAbandon}
					recordWizardComplete={recordWizardComplete}
					onWizardResume={handleWizardResume}
					onWizardStartFresh={handleWizardStartFresh}
					onWizardResumeClose={handleWizardResumeClose}
					// Tour
					setTourCompleted={setTourCompleted}
					tabShortcuts={tabShortcuts}
					recordTourStart={recordTourStart}
					recordTourComplete={recordTourComplete}
					recordTourSkip={recordTourSkip}
				/>

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
								onSessionClick={(sessionId, tabId) => {
									handleCloseLogViewer();
									handleToastSessionClick(sessionId, tabId);
								}}
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
									onStopAll={handleGroupChatStopAll}
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
									ghCliAvailable={ghCliAvailable}
									onPublishMessageGist={(text: string) => {
										if (!text.trim()) return;
										const filename = `group_chat_response_${Date.now()}.md`;
										useTabStore.getState().setTabGistContent({ filename, content: text });
										setGistPublishModalOpen(true);
									}}
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

				{/* NOTE: Settings, Wizard, Tour, and flash notifications are now rendered via AppStandaloneModals */}

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
 * InputProvider - centralized input state management
 * InlineWizardProvider - inline /wizard command state management
 */
export default function MaestroConsole() {
	const [promptsReady, setPromptsReady] = useState(false);

	useEffect(() => {
		initializeRendererPrompts()
			.then(() => setPromptsReady(true))
			.catch((err) => {
				captureException(err instanceof Error ? err : new Error(String(err)), {
					extra: { context: 'MaestroConsole.initializeRendererPrompts' },
				});
				setPromptsReady(true); // Allow app to render; features degrade gracefully
			});
	}, []);

	if (!promptsReady) {
		return null;
	}

	return (
		<InlineWizardProvider>
			<InputProvider>
				<MaestroConsoleInner />
			</InputProvider>
		</InlineWizardProvider>
	);
}
