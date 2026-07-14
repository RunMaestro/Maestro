import React, {
	useState,
	useEffect,
	useRef,
	useMemo,
	useCallback,
	lazy,
	Suspense,
	type ReactNode,
} from 'react';
import { useFocusAfterRender } from './hooks/utils/useFocusAfterRender';
import { isWebDesktop } from './utils/runtimeContext';
import { isCoarsePointer } from './utils/touch';
import { slashCommands } from './slashCommands';
import { AppModals } from './components/AppModals';
import { AppStandaloneModals } from './components/AppStandaloneModals';
import { AppShell } from './components/AppShell';
import { initializeRendererPrompts } from './services/promptInit';
import { useWizard, type SerializableWizardState, type WizardStep } from './components/Wizard';
import type { MainPanelHandle } from './components/MainPanel';
import type { RightPanelHandle } from './components/RightPanel';
import { AccountSwitchModal } from './components/AccountSwitchModal';
import { VirtuososModal } from './components/VirtuososModal';
import { SwitchProviderModal } from './components/SwitchProviderModal';
import { UnarchiveConflictModal } from './components/UnarchiveConflictModal';
import { useProviderSwitch } from './hooks/agent/useProviderSwitch';
import { getAgentDisplayName } from '../shared/agentMetadata';

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
	useWindowScopedActiveSession,
	useWindowState,
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
	useTilingShortcuts,
	useTextEditorUndo,
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
	useViewportBreakpoint,
	useKeyboardVisibility,
	useSwipeGestures,
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
	// Deferred update-restart (installs downloaded update on idle transition)
	useRestartWhenIdle,
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
	// Starred Sessions list + activation (shared by Left Bar render and cycling)
	useStarredItems,
	// Input mode toggle (Tier 3A)
	useInputMode,
	// Live mode management (Tier 3B)
	useLiveMode,
	// Session switching callbacks (navigate to session/tab from various UI surfaces)
	useSessionSwitchCallbacks,
} from './hooks';
import { useChatFileDropZone } from './hooks/ui/useChatFileDropZone';
import { useMainPanelProps, useSessionListProps, useRightPanelProps } from './hooks/props';
import { useAgentListeners } from './hooks/agent/useAgentListeners';
import { useSessionRecovery } from './hooks/agent/useSessionRecovery';
import { useAutoResumeCoordinator } from './hooks/agent/useAutoResumeCoordinator';
import { useSymphonyContribution } from './hooks/symphony/useSymphonyContribution';
import { useCueAutoDiscovery } from './hooks/useCueAutoDiscovery';
import { useCueVisibilityWiring } from './hooks/cue/useCueVisibilityWiring';

// Import contexts
import { useLayerStack } from './contexts/LayerStackContext';
import { notifyToast } from './stores/notificationStore';
import { useModalActions, useModalStore } from './stores/modalStore';
import { GitStatusProvider } from './contexts/GitStatusContext';
import { WindowProvider, useWindowContextOptional } from './contexts/WindowContext';
import { InputProvider, useInputContext } from './contexts/InputContext';
import { useGroupChatStore, isGroupChatVisibleInWindow } from './stores/groupChatStore';
import { useBatchStore } from './stores/batchStore';
import { registerBatchResumer, cancelRetry } from './stores/retryStore';
// All session state is read directly from useSessionStore in MaestroConsoleInner.
import {
	useSessionStore,
	selectActiveSession,
	updateSessionWith,
	updateAiTab,
} from './stores/sessionStore';
import { useStoreWithEqualityFn } from 'zustand/traditional';
import {
	sidebarSessionEquality,
	gitPollSessionEquality,
	projectRootSessionEquality,
} from './stores/sessionEquality';
import { useActiveSession } from './hooks/session/useActiveSession';
import { useOwnedSessionGate } from './hooks/agent/internal/useOwnedSessionGate';
import { usePianolaAgent } from './hooks/session/usePianolaAgent';
// useAgentStore moved to useQueueProcessing hook
import { InlineWizardProvider, useInlineWizardContext } from './contexts/InlineWizardContext';
import { useQuitWhenIdle } from './hooks/useQuitWhenIdle';
import { usePluginCommandBridge } from './hooks/usePluginCommandBridge';
import { usePluginKeybindings } from './hooks/usePluginKeybindings';

// Import services
// gitService - now used in useModalHandlers (Tier 3C)

// Import types and constants
// Note: GroupChat, GroupChatState are imported from types (re-exported from shared)
import type { RightPanelTab, Session, QueuedItem, CustomAICommand, ToolType } from './types';
import { useResolvedTheme } from './hooks/ui/useResolvedTheme';
import { getActiveOutputSearchKey } from './utils/outputSearch';
import { reorderQueueItem } from './utils/executionQueue';
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
	isSoleAiTabReplacement,
} from './utils/tabHelpers';
import { getStdinFlags, prepareMaestroSystemPrompt } from './utils/spawnHelpers';
import { buildThinkingItems } from './utils/thinkingItems';
// validateNewSession moved to useSymphonyContribution, useSessionCrud hooks
// formatLogsForClipboard moved to useTabExportHandlers hook
// getSlashCommandDescription moved to useWizardHandlers
import { useUIStore } from './stores/uiStore';
import { useSettingsStore } from './stores/settingsStore';
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
		// settingsTab - now self-sourced in AppStandaloneModals
		setSettingsTab,
		// New Instance Modal
		newInstanceModalOpen,
		duplicatingSessionId,
		newInstancePresetGroupId,
		// Edit Agent Modal
		setEditAgentModalOpen,
		editAgentSession,
		setEditAgentSession,
		// Delete Agent Modal - open state and session now self-sourced in AppStandaloneModals
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
		// standingOvationData, firstRunCelebrationData - now self-sourced in AppOverlays (Tier 1A)
		// Log Viewer
		logViewerOpen,
		setLogViewerOpen,
		// Process Monitor
		processMonitorOpen,
		setProcessMonitorOpen,
		// Usage Dashboard
		setUsageDashboardOpen,
		setAgentRunDashboardOpen,
		// pendingKeyboardMasteryLevel - now self-sourced in AppOverlays (Tier 1A)
		// Playground Panel - playgroundOpen now self-sourced in AppStandaloneModals
		setPlaygroundOpen,
		// Debug Package Modal - debugPackageModalOpen now self-sourced in AppStandaloneModals
		setDebugPackageModalOpen,
		// Debug Application Stats Modal - self-sourced in AppStandaloneModals
		setDebugApplicationStatsOpen,
		// Windows Warning Modal - windowsWarningModalOpen now self-sourced in AppStandaloneModals
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
		renameGroupIcon,
		setRenameGroupIcon,
		renameGroupColor,
		setRenameGroupColor,
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
		// Marketplace Modal - marketplaceModalOpen now self-sourced in AppStandaloneModals
		setMarketplaceModalOpen,
		// Wizard Resume Modal - open state and resume state now self-sourced in AppStandaloneModals
		// setWizardResumeModalOpen, setWizardResumeState - now used in useWizardHandlers (Tier 3D)
		// Agent Error Modal
		// Worktree Modals
		createWorktreeSession,
		createPRSession,
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
		// Tour Overlay - tourOpen, tourFromWizard now self-sourced in AppStandaloneModals
		// setTourFromWizard now used in useWizardHandlers via getModalActions()
		// Symphony Modal - symphonyModalOpen now self-sourced in AppStandaloneModals
		setSymphonyModalOpen,
		// Director's Notes Modal - directorNotesOpen now self-sourced in AppStandaloneModals
		setDirectorNotesOpen,
		// Maestro Cue Modal - cueModalOpen now self-sourced in AppStandaloneModals
		setCueModalOpen,
		// Pianola Modal - pianolaModalOpen now self-sourced in AppStandaloneModals
		setPianolaModalOpen,
		// Maestro Cue YAML Editor - open state, sessionId, projectRoot self-sourced in AppStandaloneModals
		closeCueYamlEditor,
		// Virtuosos Modal
		virtuososOpen,
		setVirtuososOpen,
	} = useModalActions();

	// --- MOBILE LANDSCAPE MODE (reading-only view) ---
	const isMobileLandscape = useMobileLandscape();

	// --- RESPONSIVE BREAKPOINT (drives drawer-mode sidebars on narrow viewports) ---
	const { isNarrow: isNarrowViewport, isMdDown: isMdDownViewport } = useViewportBreakpoint();
	// Auto-collapse / mutual-exclusion effects live further down, after
	// leftSidebarOpen / rightPanelOpen are pulled from the UI store.

	// --- VIRTUAL KEYBOARD (lift the bottom input above the on-screen keyboard) ---
	// Only the web-desktop bundle runs on phones/tablets with a virtual keyboard;
	// the Electron desktop app never sees a keyboard offset (Visual Viewport stays
	// full height), so `--keyboard-offset` resolves to 0px there and is a no-op.
	const { keyboardOffset, isKeyboardVisible } = useKeyboardVisibility();
	const keyboardShellOffset = isWebDesktop() && isKeyboardVisible ? keyboardOffset : 0;

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

	useEffect(() => {
		if (!encoreFeatures.pianola) setPianolaModalOpen(false);
	}, [encoreFeatures.pianola, setPianolaModalOpen]);

	// --- KEYBOARD SHORTCUT HELPERS ---
	const { isShortcut, isTabShortcut, isPaneShortcut } = useKeyboardShortcutHelpers({
		shortcuts,
		tabShortcuts,
	});

	// --- SESSION STATE (migrated from useSession() to direct useSessionStore selectors) ---
	// Reactive values - each selector triggers re-render only when its specific value changes
	// PERF: Do NOT subscribe to the full `sessions` array here. Streaming log/token
	// updates would re-render the entire console shell. Event-time readers use
	// sessionsRef / getState(); paint leaves self-source with narrow selectors.
	// Sidebar-stable view for the sort/navigation pipeline.
	// `sidebarSessionEquality` ignores log/usage/cycle counters, so the array
	// reference only flips when something the left bar actually displays
	// changes. Plumbed into `useSortedSessions` so `sortedSessions` (and the
	// SessionList tree) stops re-rendering on every 200ms streaming flush.
	const sessionsForSidebar = useStoreWithEqualityFn(
		useSessionStore,
		(s) => s.sessions,
		sidebarSessionEquality
	);
	const hasSessions = useSessionStore((s) => s.sessions.length > 0);
	const hasNoAgents = !hasSessions;
	const groups = useSessionStore((s) => s.groups);
	const activeSessionId = useSessionStore((s) => s.activeSessionId);
	// Whether the initial agent list has finished loading. On desktop the splash
	// covers startup until this flips true; on Web Desktop (no splash) we use it
	// to show a loading spinner instead of flashing the empty "create your first
	// agent" state while sessions stream in over the WebSocket bridge.
	const sessionsLoaded = useSessionStore((s) => s.sessionsLoaded);
	const activeSession = useActiveSession();

	// Actions - stable references from store, never trigger re-renders
	const {
		setSessions,
		setGroups,
		setActiveSessionId: storeSetActiveSessionId,
		setRemovedWorktreePaths,
	} = useMemo(() => useSessionStore.getState(), []);

	// batchedUpdater - React hook for timer lifecycle (reads store directly)
	const batchedUpdater = useBatchedSessionUpdates();
	const batchedUpdaterRef = useRef(batchedUpdater);
	batchedUpdaterRef.current = batchedUpdater;

	// setActiveSessionId wrapper - flushes batched updates before switching
	const setActiveSessionIdFromContext = useCallback(
		(id: string) => {
			batchedUpdaterRef.current.flushNow();
			storeSetActiveSessionId(id);
		},
		[storeSetActiveSessionId]
	);

	// Ref-like getters - read current state from store without stale closures
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

	// initialLoadComplete - provided by useSessionRestoration hook

	// cyclePositionRef - Proxy bridges ref API to store number
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

	// Auto-collapse both sidebars when the viewport is narrow (fresh load OR
	// transition). MainPanel needs the full width. Users can still toggle
	// either drawer open; on narrow widths opening one auto-closes the other
	// (the mutual-exclusion effect right below).
	useEffect(() => {
		if (isNarrowViewport) {
			useUIStore.getState().setLeftSidebarOpen(false);
			useUIStore.getState().setRightPanelOpen(false);
		}
	}, [isNarrowViewport]);

	// Mutual exclusion on narrow: opening one drawer closes the OTHER one.
	// Track previous values so we react to the transition that just opened a
	// drawer, not the steady state. The old "if both open, close right" version
	// was biased: opening the right while the left was already open would
	// immediately re-close the right.
	const prevLeftSidebarOpenRef = useRef(leftSidebarOpen);
	const prevRightPanelOpenRef = useRef(rightPanelOpen);
	useEffect(() => {
		const leftJustOpened = !prevLeftSidebarOpenRef.current && leftSidebarOpen;
		const rightJustOpened = !prevRightPanelOpenRef.current && rightPanelOpen;
		if (isNarrowViewport && leftJustOpened && rightPanelOpen) {
			useUIStore.getState().setRightPanelOpen(false);
		} else if (isNarrowViewport && rightJustOpened && leftSidebarOpen) {
			useUIStore.getState().setLeftSidebarOpen(false);
		}
		prevLeftSidebarOpenRef.current = leftSidebarOpen;
		prevRightPanelOpenRef.current = rightPanelOpen;
	}, [isNarrowViewport, leftSidebarOpen, rightPanelOpen]);
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
	// flashNotification, successFlashNotification - now self-sourced in AppStandaloneModals
	const selectedSidebarIndex = useUIStore((s) => s.selectedSidebarIndex);
	const sidebarExtraSelection = useUIStore((s) => s.sidebarExtraSelection);

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
		setSidebarExtraSelection,
	} = useUIStore.getState();

	// --- EDGE-SWIPE DRAWERS (phones on the web-desktop bundle) ---
	// Gated on coarse pointer so a narrow *desktop* browser window (mouse) never
	// gets invisible edge zones that would swallow clicks in the outer 24px. The
	// opener zones are thin fixed strips at the screen edges (see JSX), so drawer
	// gestures can only START at the edge - horizontal scrolling inside the
	// terminal, tab bar, or tables is untouched. Closing swipes ride the mobile
	// backdrop, which only exists while a drawer is open.
	const drawerSwipeEnabled = isNarrowViewport && isWebDesktop() && isCoarsePointer();
	const leftEdgeSwipe = useSwipeGestures({
		onSwipeRight: () => setLeftSidebarOpen(true),
		enabled: drawerSwipeEnabled && !leftSidebarOpen && !rightPanelOpen,
	});
	const rightEdgeSwipe = useSwipeGestures({
		onSwipeLeft: () => setRightPanelOpen(true),
		enabled: drawerSwipeEnabled && !rightPanelOpen && !leftSidebarOpen,
	});
	// Backdrop closer: the left drawer closes by pushing it back left, the right
	// drawer by pushing it back right. Only one drawer is open at a time (mutual
	// exclusion above), and the setters are idempotent, so unconditional calls
	// are safe.
	const drawerCloseSwipe = useSwipeGestures({
		onSwipeLeft: () => setLeftSidebarOpen(false),
		onSwipeRight: () => setRightPanelOpen(false),
		enabled: drawerSwipeEnabled && (leftSidebarOpen || rightPanelOpen),
	});

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
	const groupChatInitiatorWindowId = useGroupChatStore((s) => s.initiatorWindowId);

	// Multi-window: which window initiated the active group chat. The panel renders
	// only there (gated below via isGroupChatVisibleInWindow). Optional context, so
	// the single-window app / web / isolation tests fall back to "show here".
	const windowCtx = useWindowContextOptional();
	const currentWindowId = windowCtx?.windowId ?? null;
	const ownedSessionGate = useOwnedSessionGate();

	// Stable actions from groupChatStore (non-reactive)
	const {
		setActiveGroupChatId,
		setGroupChatStagedImages,
		setGroupChatReadOnlyMode,
		setGroupChatRightTab,
		setGroupChatParticipantColors,
		setInitiatorWindowId,
	} = useGroupChatStore.getState();

	// Multi-window: stamp the initiating window on this window's group-chat store
	// when a chat opens, and clear it on close. Because each window has its own
	// store, the only window that sets activeGroupChatId is the one the user
	// opened the chat in, so initiatorWindowId records that window. The render
	// gate below then shows the panel only there, even though every window holds
	// the same groupChats list and a participant agent may live in another window.
	useEffect(() => {
		if (!activeGroupChatId) {
			if (groupChatInitiatorWindowId !== null) setInitiatorWindowId(null);
			return;
		}
		// Wait for window identity to hydrate (null windowId on the primary window
		// pre-hydrate); the gate treats a null initiatorWindowId as "show here".
		if (currentWindowId && groupChatInitiatorWindowId === null) {
			setInitiatorWindowId(currentWindowId);
		}
	}, [activeGroupChatId, currentWindowId, groupChatInitiatorWindowId, setInitiatorWindowId]);

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
		atMentionCategory,
		setAtMentionCategory,
		commandHistoryOpen,
		setCommandHistoryOpen,
		commandHistoryFilter,
		setCommandHistoryFilter,
		commandHistorySelectedIndex,
		setCommandHistorySelectedIndex,
	} = useInputContext();

	// File Explorer State (reads from fileExplorerStore)
	// isGraphViewOpen, graphFocusFilePath - now self-sourced in AppStandaloneModals
	const lastGraphFocusFilePath = useFileExplorerStore((s) => s.lastGraphFocusFilePath);

	const [gistPublishModalOpen, setGistPublishModalOpen] = useState(false);
	// tabGistContent - now self-sourced in AppStandaloneModals
	const fileGistUrls = useTabStore((s) => s.fileGistUrls);

	// Note: Delete Agent Modal State is now self-sourced in AppStandaloneModals

	// Account Switch Prompt Modal State
	const [switchPromptData, setSwitchPromptData] = useState<{
		sessionId: string;
		fromAccountId: string;
		fromAccountName: string;
		toAccountId: string;
		toAccountName: string;
		reason: string;
		tokensAtThrottle?: number;
		usagePercent?: number;
	} | null>(null);

	// Provider Switch state (Virtuosos vertical swapping)
	const [switchProviderSession, setSwitchProviderSession] = useState<Session | null>(null);

	// Unarchive conflict state (restoring a provider-switch-archived agent)
	const [unarchiveConflictState, setUnarchiveConflictState] = useState<{
		archivedSession: Session;
		conflictingSession: Session;
	} | null>(null);

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

	// Global Live Mode - extracted to useLiveMode hook (Tier 3B)
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
	// notification settings sync, playground debug) - provided by useAppInitialization hook

	// Expose debug helpers to window for console access
	// No dependency array - always keep functions fresh
	(window as any).__maestroDebug = {
		openCommandK: () => setQuickActionOpen(true),
		openWizard: () => openWizardModal(),
		openSettings: () => setSettingsModalOpen(true),
	};
	usePluginCommandBridge();

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
	const groupChatDraftFlushRef = useRef<(() => void) | null>(null);

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
	// Ref for resumeAfterError - populated after useBatchHandlers so the account
	// recovery listener (declared earlier) can auto-resume paused Auto Runs.
	const resumeAfterErrorRef = useRef<((sessionId: string) => void) | null>(null);

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

	// Subscribe to account limit warning/reached events for toast notifications
	useEffect(() => {
		if (!encoreFeatures.virtuosos) return;
		const unsubWarning = window.maestro.accounts.onLimitWarning((data) => {
			notifyToast({
				type: 'warning',
				title: 'Virtuoso Limit Warning',
				message: `Virtuoso ${data.accountName} is at ${Math.round(data.usagePercent)}% of its token limit`,
				duration: 10_000,
			});
		});

		const unsubReached = window.maestro.accounts.onLimitReached((data) => {
			notifyToast({
				type: 'error',
				title: 'Virtuoso Limit Reached',
				message: `Virtuoso ${data.accountName} has reached its token limit (${Math.round(data.usagePercent)}%)`,
				duration: 0, // Do NOT auto-dismiss
			});
		});

		return () => {
			unsubWarning();
			unsubReached();
		};
	}, [encoreFeatures.virtuosos]);

	// Subscribe to account recovery events for auto-resume of paused Auto Runs
	useEffect(() => {
		if (!encoreFeatures.virtuosos) return;
		const unsubRecovery = window.maestro.accounts.onRecoveryAvailable((data) => {
			notifyToast({
				type: 'success',
				title: 'Virtuoso Recovered',
				message:
					data.recoveredCount === 1
						? 'Virtuoso is available again'
						: `${data.recoveredCount} virtuosos are available again`,
				duration: 8_000,
			});

			// Auto-resume any Auto Runs that are paused due to rate limiting
			const currentSessions = sessionsRef.current;
			for (const session of currentSessions) {
				const batchState = getBatchStateRef.current?.(session.id);
				if (!batchState?.isRunning || batchState.processingState !== 'PAUSED_ERROR') continue;
				if (!batchState.error) continue;

				// Check if the pause was due to rate limiting
				const isRateLimitPause =
					batchState.error.type === 'rate_limited' ||
					(batchState.error.message?.includes('rate') ?? false) ||
					(batchState.error.message?.includes('throttle') ?? false) ||
					(batchState.error.message?.includes('All virtuosos') ?? false);

				if (isRateLimitPause) {
					const recoveredForThis = data.recoveredAccountIds.includes(session.accountId || '');
					if (recoveredForThis || data.recoveredAccountIds.length > 0) {
						resumeAfterErrorRef.current?.(session.id);

						notifyToast({
							type: 'info',
							title: 'Auto Run Resuming',
							message: 'Resuming after virtuoso recovery',
							duration: 5_000,
						});
					}
				}
			}
		});

		return () => unsubRecovery();
	}, [encoreFeatures.virtuosos]);

	// Subscribe to all-accounts-exhausted throttle events for Auto Run pause
	useEffect(() => {
		if (!encoreFeatures.virtuosos) return;
		const unsubThrottled = window.maestro.accounts.onThrottled((data) => {
			if (!data.noAlternatives) return; // Only handle the exhausted case

			const sessionId = data.sessionId as string;
			if (!sessionId) return;

			// Check if this session has an active Auto Run
			const batchState = getBatchStateRef.current?.(sessionId);
			if (!batchState?.isRunning || batchState.errorPaused) return;

			// Pause the batch with a specific rate_limited error so recovery can auto-resolve it
			pauseBatchOnErrorRef.current?.(
				sessionId,
				{
					type: 'rate_limited',
					message: 'All virtuosos have been rate-limited. Waiting for automatic recovery...',
					recoverable: true,
					agentId: (data.agentId as string) || 'claude-code',
					timestamp: Date.now(),
				},
				batchState.currentDocumentIndex,
				'Waiting for virtuoso recovery'
			);
		});

		return () => unsubThrottled();
	}, [encoreFeatures.virtuosos]);

	// Subscribe to auth recovery lifecycle events. Recovery runs entirely in the
	// main process (kill → claude login → respawn + resume); without these the
	// renderer would show a stale auth_expired error modal over a session that
	// already recovered.
	useEffect(() => {
		if (!encoreFeatures.virtuosos) return;
		const unsubStarted = window.maestro.accounts.onAuthRecoveryStarted((data) => {
			notifyToast({
				type: 'info',
				title: 'Re-authenticating Virtuoso',
				message: `Auth expired for ${data.accountName} - attempting automatic re-login`,
				duration: 8_000,
			});
		});

		const unsubCompleted = window.maestro.accounts.onAuthRecoveryCompleted((data) => {
			// Clear the stale auth_expired error from the recovered session (both
			// the session-level fields the error modal reads and the per-tab banner)
			const session = sessionsRef.current.find((s) => data.sessionId.startsWith(s.id));
			if (session) {
				setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== session.id) return s;
						const clearSessionError = s.agentError?.type === 'auth_expired';
						return {
							...s,
							...(clearSessionError
								? { agentError: undefined, agentErrorTabId: undefined, agentErrorPaused: undefined }
								: {}),
							aiTabs: s.aiTabs.map((t) =>
								t.agentError?.type === 'auth_expired' ? { ...t, agentError: undefined } : t
							),
						};
					})
				);
			}
			notifyToast({
				type: 'success',
				title: 'Virtuoso Re-authenticated',
				message: `${data.accountName} logged in again - agent resumed`,
				duration: 5_000,
			});
		});

		const unsubFailed = window.maestro.accounts.onAuthRecoveryFailed((data) => {
			notifyToast({
				type: 'error',
				title: 'Virtuoso Re-authentication Failed',
				message: data.error || 'Automatic re-login failed. Run "claude login" manually.',
				duration: 0, // requires acknowledgment
			});
		});

		return () => {
			unsubStarted();
			unsubCompleted();
			unsubFailed();
		};
	}, [encoreFeatures.virtuosos]);

	// Subscribe to account assignment events (update session state when main process assigns an account)
	useEffect(() => {
		if (!encoreFeatures.virtuosos) return;
		const unsubAssigned = window.maestro.accounts.onAssigned((data) => {
			setSessions((prev) =>
				prev.map((s) => {
					if (!data.sessionId.startsWith(s.id)) return s;
					return { ...s, accountId: data.accountId, accountName: data.accountName };
				})
			);
		});
		return () => unsubAssigned();
	}, [encoreFeatures.virtuosos]);

	// Subscribe to account switch events (respawn agent with new account after switch)
	useEffect(() => {
		if (!encoreFeatures.virtuosos) return;
		const unsubRespawn = window.maestro.accounts.onSwitchRespawn(async (data) => {
			const {
				sessionId: switchSessionId,
				toAccountId,
				toAccountName,
				configDir,
				lastPrompt,
				reason,
			} = data;
			if (!ownedSessionGate.current?.(switchSessionId)) return;

			const eventImages =
				'images' in data && Array.isArray(data.images)
					? data.images.filter((image): image is string => typeof image === 'string')
					: undefined;

			// Find the session that needs respawning, preferring the longest matching id.
			const session = sessionsRef.current
				.filter((s) => switchSessionId === s.id || switchSessionId.startsWith(`${s.id}-ai-`))
				.sort((a, b) => b.id.length - a.id.length)[0];
			if (!session) {
				console.error('[AccountSwitch] Session not found for respawn:', switchSessionId);
				return;
			}

			// Agent Resilience coordination: the switch respawn re-sends the last
			// prompt itself, so cancel any pending auto-retry for this session's
			// tabs. Without this, the retry timer (min 30s backoff) fires after the
			// respawn and sends the SAME prompt a second time on the new account.
			for (const tab of session.aiTabs ?? []) {
				cancelRetry(session.id, tab.id);
			}

			// Update session with new account info and CLAUDE_CONFIG_DIR.
			setSessions((prev) =>
				prev.map((s) => {
					if (s.id !== session.id) return s;
					return {
						...s,
						accountId: toAccountId,
						accountName: toAccountName,
						customEnvVars: {
							...s.customEnvVars,
							CLAUDE_CONFIG_DIR: configDir,
						},
					};
				})
			);

			// Manual switches never auto-respawn: the previous prompt already
			// completed (or the user chose to abandon it) and re-executing it on
			// the new account could repeat side effects. The next user message
			// picks up the new account via session.accountId + CLAUDE_CONFIG_DIR.
			// Automatic switches (throttle / auth recovery) resume the interrupted
			// turn, but only when there is a recorded prompt to resume.
			if (reason === 'manual' || !lastPrompt) {
				notifyToast({
					type: 'info',
					title: 'Account Switched',
					message: `Switched to account ${toAccountName} (${reason})`,
					duration: 5_000,
				});
				return;
			}

			try {
				const agent = await window.maestro.agents.get(session.toolType);
				if (!agent) {
					console.error('[AccountSwitch] Agent not found for respawn:', session.toolType);
					return;
				}

				const tabPrefix = `${session.id}-ai-`;
				const throttledTabId = switchSessionId.startsWith(tabPrefix)
					? switchSessionId.slice(tabPrefix.length)
					: undefined;
				const throttledTab = throttledTabId
					? session.aiTabs?.find((candidate) => candidate.id === throttledTabId)
					: undefined;
				const tab = throttledTab ?? getActiveTab(session);
				const tabAgentSessionId = tab?.agentSessionId;
				const commandToUse = agent.path ?? agent.command ?? '';
				const agentArgs = agent.args ?? [];
				const interruptedImages = eventImages ?? tab?.stagedImages;
				const hasImages = !!interruptedImages?.length;
				const appendSystemPrompt = await prepareMaestroSystemPrompt({
					session,
					activeTabId: tab?.id,
				});
				const { sendPromptViaStdin, sendPromptViaStdinRaw } = getStdinFlags({
					isSshSession: !!session.sshRemoteId || !!session.sessionSshRemoteConfig?.enabled,
					supportsStreamJsonInput: agent.capabilities?.supportsStreamJsonInput ?? false,
					hasImages,
				});

				// Switch events do not currently include images. Reuse staged tab images
				// when available so an interrupted image turn retains its attachments.
				const targetSessionId = `${session.id}-ai-${tab?.id || 'default'}`;
				await window.maestro.process.spawn({
					sessionId: targetSessionId,
					toolType: session.toolType,
					cwd: session.cwd,
					command: commandToUse,
					args: agentArgs,
					prompt: lastPrompt,
					images: hasImages ? interruptedImages : undefined,
					appendSystemPrompt,
					agentSessionId: tabAgentSessionId ?? undefined,
					permissionMode: tab?.permissionMode,
					readOnlyMode: tab?.readOnlyMode === true || tab?.permissionMode === 'readonly',
					sessionCustomPath: session.customPath,
					sessionCustomArgs: session.customArgs,
					sessionCustomEnvVars: {
						...session.customEnvVars,
						CLAUDE_CONFIG_DIR: configDir,
					},
					sessionCustomModel: tab?.customModel ?? session.customModel,
					sessionCustomEffort: tab?.customEffort ?? session.customEffort,
					sessionCustomContextWindow: session.customContextWindow,
					accountId: toAccountId,
					sessionSshRemoteConfig: session.sessionSshRemoteConfig,
					sendPromptViaStdin,
					sendPromptViaStdinRaw,
				});

				notifyToast({
					type: 'info',
					title: 'Account Switched',
					message: `Switched to account ${toAccountName} (${reason}): resuming interrupted turn`,
					duration: 5_000,
				});
			} catch (error) {
				console.error('[AccountSwitch] Failed to respawn agent:', error);
				notifyToast({
					type: 'error',
					title: 'Account Switch Failed',
					message: `Failed to respawn agent after account switch: ${String(error)}`,
					duration: 0,
				});
			}
		});

		const unsubSwitchFailed = window.maestro.accounts.onSwitchFailed((data) => {
			notifyToast({
				type: 'error',
				title: 'Account Switch Failed',
				message: `Failed to switch account: ${data.error || 'Unknown error'}`,
				duration: 0,
			});
		});

		const unsubSwitchExecute = window.maestro.accounts.onSwitchExecute(async (data) => {
			// Auto-switch mode: execute the switch immediately.
			const { sessionId, fromAccountId, toAccountId, reason } = data;
			if (
				typeof sessionId !== 'string' ||
				typeof fromAccountId !== 'string' ||
				typeof toAccountId !== 'string'
			) {
				return;
			}
			if (!ownedSessionGate.current?.(sessionId)) return;

			try {
				await window.maestro.accounts.executeSwitch({
					sessionId,
					fromAccountId,
					toAccountId,
					reason: typeof reason === 'string' ? reason : 'throttled',
					automatic: true,
				});
			} catch (error) {
				console.error('[AccountSwitch] Auto-switch execution failed:', error);
			}
		});

		return () => {
			unsubRespawn();
			unsubSwitchFailed();
			unsubSwitchExecute();
		};
	}, [encoreFeatures.virtuosos, ownedSessionGate]);

	// Subscribe to account switch prompt events (user confirmation needed)
	useEffect(() => {
		if (!encoreFeatures.virtuosos) return;
		const unsubSwitchPrompt = window.maestro.accounts.onSwitchPrompt((data: any) => {
			setSwitchPromptData({
				sessionId: data.sessionId,
				fromAccountId: data.fromAccountId,
				fromAccountName: data.fromAccountName ?? data.fromAccountId,
				toAccountId: data.toAccountId,
				toAccountName: data.toAccountName ?? data.toAccountId,
				reason: data.reason ?? 'throttled',
				tokensAtThrottle: data.tokensAtThrottle,
				usagePercent: data.usagePercent,
			});
		});

		const unsubSwitchCompleted = window.maestro.accounts.onSwitchCompleted((data: any) => {
			notifyToast({
				type: 'success',
				title: 'Account Switched',
				message: `Switched from ${data.fromAccountName ?? data.fromAccountId} to ${data.toAccountName ?? data.toAccountId}`,
				duration: 5_000,
			});
		});

		return () => {
			unsubSwitchPrompt();
			unsubSwitchCompleted();
		};
	}, [encoreFeatures.virtuosos]);

	// Keyboard navigation state
	// Note: selectedSidebarIndex/setSelectedSidebarIndex are destructured from useUIStore() above
	// Note: activeTab is memoized later at line ~3795 - use that for all tab operations

	// Slash command discovery now in useWizardHandlers hook

	// --- SESSION RESTORATION (extracted hook, Phase 2E) ---
	const { initialLoadComplete } = useSessionRestoration();

	// --- CUE AUTO-DISCOVERY (gated by Encore Feature) ---
	useCueAutoDiscovery(encoreFeatures);

	// --- PIANOLA AGENT (pinned manager agent, gated by Encore Feature) ---
	// Ensures the single pinned Pianola agent exists once sessions are loaded and
	// the pianola flag is on. Does not steal focus from the active agent.
	usePianolaAgent(encoreFeatures);

	// --- CUE VISIBILITY WIRING (PR-B 1.4) ---
	// Forwards document visibility to the main-process Cue scanner
	// subsystem so it pauses background work when the window is hidden.
	useCueVisibilityWiring();

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
		handleToggleTabEnterToSend,
		handleOpenFileTab,
		handleSelectFileTab,
		handleCloseFileTab,
		handleNewFileTab,
		handleNewBrowserTab,
		handleOpenBrowserTabAt,
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

	// Opens the rename modal for a browser tab. Pre-fills with any existing
	// user-assigned name (empty when the tab is still using the page-set title).
	const handleRequestBrowserTabRename = useCallback(
		(tabId: string) => {
			const session = selectActiveSession(useSessionStore.getState());
			if (!session) return;
			const tab = session.browserTabs?.find((t) => t.id === tabId);
			if (!tab) return;
			setRenameTabId(tabId);
			setRenameTabInitialName(tab.customTitle ?? '');
			setRenameTabModalOpen(true);
		},
		[setRenameTabId, setRenameTabInitialName, setRenameTabModalOpen]
	);

	// Clears a browser tab's user-assigned name, letting the website set the
	// tab title again on the next navigation/title update.
	const handleResetBrowserTabName = useCallback((tabId: string) => {
		const session = selectActiveSession(useSessionStore.getState());
		if (!session) return;
		useSessionStore.getState().setSessions((prev) =>
			prev.map((s) =>
				s.id === session.id
					? {
							...s,
							browserTabs: (s.browserTabs || []).map((t) =>
								t.id === tabId ? { ...t, customTitle: undefined } : t
							),
						}
					: s
			)
		);
	}, []);

	// Opens the startup-command modal for a terminal tab. Captures sessionId at
	// open time so the save action targets the correct session even if the user
	// switches agents while the modal is up.
	const handleRequestTerminalTabConfigureStartupCommand = useCallback((tabId: string) => {
		const session = selectActiveSession(useSessionStore.getState());
		if (!session) return;
		const tab = session.terminalTabs?.find((t) => t.id === tabId);
		if (!tab) return;
		const defaultCwd = session.cwd || session.projectRoot || '';
		useModalStore.getState().openModal('terminalStartupCommand', {
			sessionId: session.id,
			tabId,
			initialCommand: tab.startupCommand ?? '',
			initialCwd: tab.startupCommandCwd ?? '',
			defaultCwd,
		});
	}, []);

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

	const handleToggleGroupChatMarkdownMode = useCallback(() => {
		const { chatRawTextMode: currentMode, setChatRawTextMode: setCurrentMode } =
			useSettingsStore.getState();
		setCurrentMode(!currentMode);
	}, []);

	const handleGroupChatFlashNotification = useCallback((message: string) => {
		setSuccessFlashNotification(message);
		setTimeout(() => setSuccessFlashNotification(null), 2000);
	}, []);

	const handlePublishGroupChatMessageGist = useCallback((text: string, messageId?: string) => {
		if (!text.trim()) return;
		const filename = `group_chat_response_${Date.now()}.md`;
		useTabStore.getState().setTabGistContent({ filename, content: text, messageId });
		setGistPublishModalOpen(true);
	}, []);

	// --- MODAL HANDLERS (open/close, error recovery, lightbox, celebrations) ---
	const {
		errorSession,
		effectiveAgentError,
		recoveryActions,
		handleJumpToFailingAgent,
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
		handleQuitWhenIdle,
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
		handleUpdateLightboxImage,
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
		handlePRCreated,
	} = useWorktreeHandlers({ rightPanelRef });

	// --- APP HANDLERS (drag, file, folder operations) ---
	// NOTE: file-drop attach is now scoped per-region (useChatFileDropZone for the
	// main panel / group chat; the Files panel for tree imports). useAppHandlers
	// still owns the document-level dragover/drop preventDefault that keeps the
	// inert regions (left bar, History/Auto Run) from navigating to a file:// URL,
	// plus session-drag lifecycle. setIsDraggingFile/dragCounterRef are still
	// threaded into useInputHandlers' handleDrop for defensive reset.
	const {
		setIsDraggingFile,
		dragCounterRef,
		handleFileClick,
		updateSessionWorkingDirectory,
		toggleFolder,
		toggleFolderRecursive,
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

	// Resolve the active Theme (custom / built-in / plugin theme, dracula fallback)
	// via the shared resolver - same hook the cadenza HUD root uses.
	const theme = useResolvedTheme();

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

	// Open a file path clicked in the Git Log / Git Diff viewers as a preview tab.
	// The viewer dismisses itself first (via its own onClose); here we just read
	// and open the file. The path arrives absolute (resolved against the viewer's
	// cwd) so handleFileClick uses it verbatim and still honors SSH remotes.
	const handleOpenGitFile = useCallback(
		(absolutePath: string, fileName: string) => {
			void handleFileClick({ name: fileName, type: 'file' }, absolutePath);
		},
		[handleFileClick]
	);

	// Auto-focus the AI input box when switching from terminal to AI mode
	const prevInputModeRef = useRef(activeSession?.inputMode);
	const shouldFocusOnModeSwitch =
		prevInputModeRef.current === 'terminal' && activeSession?.inputMode === 'ai';
	useFocusAfterRender(inputRef, shouldFocusOnModeSwitch, 0);
	useEffect(() => {
		prevInputModeRef.current = activeSession?.inputMode;
	}, [activeSession?.inputMode]);

	// Auto-focus the AI input when closing the last tab spawns a fresh chat tab.
	// closeTab() replaces the sole remaining AI tab with a new empty one, so the
	// session still has one tab but its id changed; land the caret in the input
	// just like a manual new tab does (the close paths don't reach inputRef).
	const prevFocusSessionIdRef = useRef(activeSession?.id);
	const prevAiTabIdsRef = useRef<string[]>(
		activeSession ? activeSession.aiTabs.map((t) => t.id) : []
	);
	const shouldFocusOnLastTabReplaced = isSoleAiTabReplacement(
		prevFocusSessionIdRef.current,
		prevAiTabIdsRef.current,
		activeSession
	);
	useFocusAfterRender(inputRef, shouldFocusOnLastTabReplaced, 0);
	useEffect(() => {
		prevFocusSessionIdRef.current = activeSession?.id;
		prevAiTabIdsRef.current = activeSession ? activeSession.aiTabs.map((t) => t.id) : [];
	}, [activeSession?.id, activeSession?.aiTabs]);

	// PERF: NewInstanceModal validation reads from the store when open (see AppSessionModals).
	// Avoid keeping a reactive full-array slice at App level.

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
	const handleForkConversation = useForkConversation();

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
	const { handleNavBack, handleNavForward } = useSessionNavigation({
		navigateBack,
		navigateForward,
		setActiveSessionId, // Uses the wrapper that also dismisses active group chat
		setSessions,
		cyclePositionRef,
		onNavigateToGroupChat: handleOpenGroupChat,
	});

	// Multi-window: gate on WindowContext.ownsSession so a window's pill / cycling never
	// surfaces an agent owned by another window. Outside a WindowProvider (web /
	// isolation tests) ownsSession is undefined.
	const ownsSession = windowCtx?.ownsSession;

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

	// handleDirectorNotesResumeSession - extracted to useModalHandlers (Tier 3C)
	// Bridge: keep handleResumeSessionRef in sync for useModalHandlers
	handleResumeSessionRef.current = handleResumeSession;

	// --- SESSION SWITCH CALLBACKS (navigate to session/tab from various UI surfaces) ---
	const {
		handleProcessMonitorNavigateToSession,
		handleToastSessionClick,
		handleNamedSessionSelect,
		handleJumpToStarredSession,
		handleUtilityTabSelect,
		handleUtilityFileTabSelect,
		handleFileSearchSelect,
	} = useSessionSwitchCallbacks({
		setActiveSessionId,
		handleResumeSession,
		inputRef,
		handleFileClick,
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
		resumeAfterError: resumeAutoRunAfterError,
		skipCurrentDocument: skipCurrentAutoRunDocument,
		abortBatchOnError: abortAutoRunBatchOnError,
		activeBatchSessionIds,
		currentSessionBatchState,
		activeBatchRunState,
		pauseBatchOnErrorRef,
		getBatchStateRef,
		handleSyncAutoRunStats,
		handleSaveBatchPrompt,
	} = useBatchHandlers({
		spawnAgentForSession,
		spawnBackgroundSynopsis,
		rightPanelRef,
		processQueuedItemRef,
		handleClearAgentError,
	});
	// Keep the account-recovery listener's resume hook current (declared above
	// the hook because the listener effect is registered earlier in the file).
	resumeAfterErrorRef.current = resumeAutoRunAfterError;

	// Agent Resilience: give the retry engine a way to resume a parked Auto Run
	// batch so batch turns can auto-continue after transient upstream/quota errors.
	useEffect(() => {
		registerBatchResumer(resumeAutoRunAfterError);
		return () => registerBatchResumer(null);
	}, [resumeAutoRunAfterError]);

	// --- PROVIDER SWITCHING (Virtuosos vertical swapping) ---
	const { switchProvider, reset: resetProviderSwitch } = useProviderSwitch();

	const handleSwitchProvider = useCallback((sessionId: string) => {
		const session = sessionsRef.current.find((s) => s.id === sessionId);
		if (session && session.toolType !== 'terminal') {
			setSwitchProviderSession(session);
		}
	}, []);

	const handleConfirmProviderSwitch = useCallback(
		async (request: {
			targetProvider: ToolType;
			groomContext: boolean;
			archiveSource: boolean;
			mergeBackInto?: Session;
		}) => {
			if (!switchProviderSession) return;

			const activeTab = getActiveTab(switchProviderSession);
			if (!activeTab) return;

			const result = await switchProvider({
				sourceSession: switchProviderSession,
				sourceTabId: activeTab.id,
				targetProvider: request.targetProvider,
				groomContext: request.groomContext,
				mergeBackInto: request.mergeBackInto,
			});

			if (result.success && result.newSession) {
				if (result.mergedBack && request.mergeBackInto) {
					// Merge-back: replace the archived session with the reactivated one
					setSessions((prev) =>
						prev.map((s) => (s.id === request.mergeBackInto!.id ? result.newSession! : s))
					);
				} else {
					// Always-new: add the new session to state
					setSessions((prev) => [...prev, result.newSession!]);
				}

				// Mark source as archived if requested
				if (request.archiveSource) {
					setSessions((prev) =>
						prev.map((s) =>
							s.id === switchProviderSession.id
								? {
										...s,
										archivedByMigration: true,
										migratedToSessionId: result.newSessionId,
									}
								: s
						)
					);
				}

				// Clear provider error tracking for the source session
				window.maestro.providers.clearSessionErrors(switchProviderSession.id).catch(() => {});

				// Navigate to the new/reactivated session
				setActiveSessionId(result.newSessionId!);

				const action = result.mergedBack ? 'Merged back to' : 'Switched to';
				notifyToast({
					type: 'success',
					title: 'Provider Switched',
					message: `${action} ${getAgentDisplayName(request.targetProvider)}`,
					duration: 5_000,
				});
			}

			setSwitchProviderSession(null);
		},
		[switchProviderSession, switchProvider, setActiveSessionId, setSessions]
	);

	// Unarchive a provider-switch-archived agent, resolving name/provider clashes
	const handleUnarchive = useCallback(
		(sessionId: string) => {
			const session = sessionsRef.current.find((s) => s.id === sessionId);
			if (!session || !session.archivedByMigration) return;

			// Conflict: another live session with the same name AND provider
			const conflicting = sessionsRef.current.find(
				(s) =>
					s.id !== sessionId &&
					s.toolType === session.toolType &&
					s.name === session.name &&
					!s.archivedByMigration
			);

			if (conflicting) {
				setUnarchiveConflictState({ archivedSession: session, conflictingSession: conflicting });
			} else {
				setSessions((prev) =>
					prev.map((s) =>
						s.id === sessionId
							? { ...s, archivedByMigration: false, migratedToSessionId: undefined }
							: s
					)
				);
				notifyToast({
					type: 'success',
					title: 'Agent Unarchived',
					message: `${session.name || 'Agent'} has been restored`,
					duration: 3_000,
				});
			}
		},
		[setSessions]
	);

	const handleUnarchiveWithArchiveConflict = useCallback(() => {
		if (!unarchiveConflictState) return;
		const { archivedSession, conflictingSession } = unarchiveConflictState;

		setSessions((prev) =>
			prev.map((s) => {
				if (s.id === archivedSession.id) {
					return { ...s, archivedByMigration: false, migratedToSessionId: undefined };
				}
				if (s.id === conflictingSession.id) {
					return { ...s, archivedByMigration: true };
				}
				return s;
			})
		);

		notifyToast({
			type: 'success',
			title: 'Agent Unarchived',
			message: `${archivedSession.name || 'Agent'} restored, ${conflictingSession.name || 'agent'} archived`,
			duration: 5_000,
		});

		setUnarchiveConflictState(null);
	}, [unarchiveConflictState, setSessions]);

	const handleUnarchiveWithDeleteConflict = useCallback(() => {
		if (!unarchiveConflictState) return;
		const { archivedSession, conflictingSession } = unarchiveConflictState;

		setSessions((prev) =>
			prev
				.filter((s) => s.id !== conflictingSession.id)
				.map((s) =>
					s.id === archivedSession.id
						? { ...s, archivedByMigration: false, migratedToSessionId: undefined }
						: s
				)
		);

		// Kill process for deleted session if running
		window.maestro.process.kill(conflictingSession.id).catch(() => {});

		notifyToast({
			type: 'success',
			title: 'Agent Unarchived',
			message: `${archivedSession.name || 'Agent'} restored, ${conflictingSession.name || 'agent'} removed`,
			duration: 5_000,
		});

		setUnarchiveConflictState(null);
	}, [unarchiveConflictState, setSessions]);

	// Subscribe to provider failover suggestion events (ProviderErrorTracker).
	// Gated on the Virtuosos Encore flag so accountless installs never see it.
	useEffect(() => {
		if (!encoreFeatures.virtuosos) return;

		const cleanup = window.maestro.providers.onFailoverSuggest((suggestion) => {
			const session = sessionsRef.current.find((s) => s.id === suggestion.sessionId);
			if (!session) return;

			notifyToast({
				type: 'warning',
				title: 'Provider Issues Detected',
				message: `${getAgentDisplayName(suggestion.currentProvider)} had ${suggestion.errorCount} errors in a row. Suggesting a provider switch.`,
				duration: 8_000,
			});

			// Open SwitchProviderModal for confirmation (the modal pre-selects the
			// suggested fallback provider).
			setSwitchProviderSession(session);
		});

		return cleanup;
	}, [encoreFeatures.virtuosos]);

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

	// --- AUTO-RESUME ON LIMIT (Phase 3) ---
	// Renderer singleton: on the autoResumeCheckIntervalHours interval, probe
	// every limit-paused agent and resume the ones whose provider window has
	// reopened. Reads its own settings from the store; early-returns + clears
	// the timer when autoResumeOnLimit is off. `resumeAutoRunAfterError` is the
	// shared entry point that unblocks both spec- and goal-driven Auto Runs.
	useAutoResumeCoordinator({ resumeAutoRunAfterError });

	const handleRemoveQueuedItem = useCallback((itemId: string) => {
		updateSessionWith(activeSessionIdRef.current, (s) => ({
			...s,
			executionQueue: s.executionQueue.filter((item) => item.id !== itemId),
		}));
	}, []);

	const handleToggleQueuedItemPause = useCallback((itemId: string) => {
		updateSessionWith(activeSessionIdRef.current, (s) => ({
			...s,
			executionQueue: s.executionQueue.map((item) =>
				item.id === itemId ? { ...item, paused: !item.paused } : item
			),
		}));
	}, []);

	// Edit a queued message's prompt text and attached images in place.
	const handleEditQueuedItem = useCallback(
		(itemId: string, patch: { text: string; images: string[] }) => {
			updateSessionWith(activeSessionIdRef.current, (s) => ({
				...s,
				executionQueue: s.executionQueue.map((item) =>
					item.id === itemId ? { ...item, text: patch.text, images: patch.images } : item
				),
			}));
		},
		[]
	);

	// Reorder a queued item within the active session's inline chat list. The
	// inline list is filtered to a single tab, so fromIndex/toIndex address that
	// tab's items; reorderQueueItem rearranges them while keeping other tabs'
	// queued items in their absolute positions (see the helper for details).
	const handleReorderQueuedItem = useCallback(
		(fromIndex: number, toIndex: number, tabId?: string) => {
			updateSessionWith(activeSessionIdRef.current, (s) => ({
				...s,
				executionQueue: reorderQueueItem(s.executionQueue, fromIndex, toIndex, tabId),
			}));
		},
		[]
	);

	// toggleBookmark - provided by useSessionCrud hook

	const handleFocusFileInGraph = useFileExplorerStore.getState().focusFileInGraph;
	const handleOpenLastDocumentGraph = useFileExplorerStore.getState().openLastDocumentGraph;

	// Tab export handlers (copy context, export HTML, publish gist) - extracted to useTabExportHandlers
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

	// Inline wizard context - hook needs the full context, App.tsx retains pass-through refs
	const inlineWizardContext = useInlineWizardContext();
	const {
		clearError: clearInlineWizardError,
		retryLastMessage: retryInlineWizardMessage,
		generateDocuments: generateInlineWizardDocuments,
		endWizard: endInlineWizard,
		isWizardActiveForTab,
	} = inlineWizardContext;

	// --- WIZARD HANDLERS (extracted hook) ---
	// Refs for circular deps - set after useInputHandlers/useAutoRunHandlers
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
		handleWizardCompleteAndStartAutoRun,
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
		setInputValue,
		stagedImages,
		setStagedImages,
		processInput,
		processInputRef,
		handleInputKeyDown,
		handleMainPanelInputBlur,
		handleReplayMessage,
		handlePaste,
		handleDrop,
		tabCompletionSuggestions,
		atMentionItems,
		atMentionCounts,
	} = useInputHandlers({
		inputRef,
		terminalOutputRef,
		fileTreeKeyboardNavRef,
		dragCounterRef,
		setIsDraggingFile,
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
		spawnBackgroundSynopsis,
	});

	const flushGroupChatDraft = useCallback(() => {
		groupChatDraftFlushRef.current?.();
	}, []);

	const handleOpenGroupChatPromptComposer = useCallback(() => {
		flushGroupChatDraft();
		setPromptComposerOpen(true);
	}, [flushGroupChatDraft, setPromptComposerOpen]);

	const handleGroupChatDrop = useCallback(
		(e: React.DragEvent) => {
			flushGroupChatDraft();
			handleDrop(e);
		},
		[flushGroupChatDraft, handleDrop]
	);

	// In-place recovery from session_not_found errors. The hook drives the
	// inline SessionRecoveryCard surfaced by useAgentErrorListener - it grooms
	// (or passes raw) the tab's prior conversation, sets pendingMergedContext,
	// and re-sends the failed prompt via processInputRef so the existing
	// spawn path stands up a fresh session on the same tab.
	const {
		startRecovery: handleSessionRecover,
		isRecovering: isRecoveringSession,
		recoveryError: sessionRecoveryError,
	} = useSessionRecovery({ processInputRef });

	// Force Send: dispatch a queued item immediately with forceParallel=true.
	// Mirrors the user's manual flow (copy text → delete queued → Cmd+Shift+Enter)
	// but as a single click. Only useful when another tab in this agent is busy
	// AND this tab is idle - processInput(forceParallel:true) then sends now.
	const handleForceSendQueuedItem = useCallback(
		(itemId: string) => {
			const sessionId = activeSessionIdRef.current;
			const session = sessionsRef.current.find((s) => s.id === sessionId);
			if (!session) return;
			const item = session.executionQueue.find((i) => i.id === itemId);
			if (!item) return;
			const text = item.type === 'command' ? (item.command ?? '') : (item.text ?? '');
			const images = item.images && item.images.length > 0 ? item.images : undefined;
			// Image-only messages have empty text but should still dispatch.
			// processInput's own emptiness check (line ~207) requires text OR images.
			if (!text && !images) return;

			// Remove the item from the queue first so processInput doesn't see a duplicate.
			updateSessionWith(sessionId, (s) => ({
				...s,
				executionQueue: s.executionQueue.filter((i) => i.id !== itemId),
			}));

			// Pass the queued item's images directly through processInput options.
			// Routing them via setStagedImages would race with processInput's stale
			// closure of stagedImages (deps include it), causing images to drop on the
			// floor in both the chat log entry and the agent spawn payload.
			processInput(text, { forceParallel: true, images });
		},
		[processInput]
	);

	// Run a plugin command macro: send its templated prompt to the active agent
	// through the same input path as a typed message. Empty/whitespace prompts are
	// ignored by processInput's own emptiness check.
	const handleRunPromptMacro = useCallback(
		(prompt: string) => {
			processInput(prompt);
		},
		[processInput]
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

	// Multi-window: keep this window's active agent to one it owns, so a restored
	// window never shows the false "No agents" empty state while it holds agents.
	useWindowScopedActiveSession();

	// Multi-window: hydrate this window's left/right panel-collapse state from its
	// persisted per-window record on mount, and persist changes back (debounced),
	// so each window's collapsed panels survive an app restart.
	useWindowState();

	// Initialize global hands-on time tracker (persists to settings)
	// Tracks total time user spends actively using Maestro (5-minute idle timeout)
	useHandsOnTimeTracker(addTotalActiveTimeMs);

	// Auto Run achievement tracking (progress intervals, peak usage stats)
	useAutoRunAchievements({ activeBatchSessionIds });

	// "Quit when idle" watcher - quits the app once all operations finish once armed
	useQuitWhenIdle();

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
			// Use the sidebar-stable projection so log streaming doesn't recompute
			// the sort/navigation tree every 200ms.
			sessions: sessionsForSidebar,
			groups,
			bookmarksCollapsed,
			showUnreadAgentsOnly,
			activeSessionId,
		});

	// --- KEYBOARD NAVIGATION ---
	// NOTE: useKeyboardNavigation is called further down, after useStarredItems,
	// so arrow-key navigation can traverse the Starred Sessions + Group Chats
	// sections (which depend on starredItems / activateStarredItem).

	// --- MAIN KEYBOARD HANDLER ---
	// Extracted hook for main keyboard event listener (empty deps, uses ref pattern)
	const { keyboardHandlerRef, showSessionJumpNumbers } = useMainKeyboardHandler();
	usePluginKeybindings();

	// Cmd+Z / Cmd+Shift+Z fallback for text inputs (Edit menu omits the undo
	// role so the image annotator can claim Cmd+Z; this restores native
	// textarea/input undo in Electron on macOS).
	useTextEditorUndo();

	// Persist sessions to electron-store using debounced persistence (reduces disk writes from 100+/sec to <1/sec during streaming)
	// The hook handles: debouncing, flush-on-unmount, flush-on-visibility-change, flush-on-beforeunload
	const { flushNow: flushSessionPersistence } = useDebouncedPersistence(initialLoadComplete);

	// Session lifecycle operations (rename, delete, star, unread, groups persistence, nav tracking)
	// - provided by useSessionLifecycle hook (Phase 2H)
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

	// Navigation history tracking - provided by useSessionLifecycle hook (Phase 2H)

	// Auto Run document loading (list, tree, task counts, file watching)
	useAutoRunDocumentLoader();

	// NOTE: Auto Run document loading and file watching are now handled by useAutoRunDocumentLoader hook

	// --- ACTIONS ---
	// Starred Sessions list + activation - single owner shared by the Left Bar
	// render (SessionList) and Cmd+[ / Cmd+] cycling so both traverse the same rows.
	const { starredItems, activateStarredItem } = useStarredItems({
		onJumpToStarredSession: handleJumpToStarredSession,
		showConfirmation,
		// Multi-window: scope the Starred section to agents this window owns (same
		// ownsSession the thinking pill / cycling use). Undefined outside a
		// WindowProvider, so single-window/web behaviour is unchanged.
		ownsSession,
	});

	// cycleSession: event-time getState() via useCycleSession (no store subscriptions)
	const { cycleSession } = useCycleSession({
		sortedSessions,
		handleOpenGroupChat,
		starredItems,
		activateStarredItem,
		navIndexMap,
		// Multi-window: scope Cmd+[/] cycling to agents THIS window owns. Reuses the
		// same ownsSession predicate the thinking pill uses (line ~1422); undefined
		// outside a WindowProvider, so single-window/web cycling is unchanged.
		ownsSession,
	});

	// Tab tiling (split panes): Ctrl+Cmd pane focus / split / close / zoom /
	// rebalance handlers. All act only on the active window's active tab group and
	// no-op when nothing is tiled. Dispatched by the main keyboard handler.
	const tilingShortcuts = useTilingShortcuts(activeSession);

	// --- KEYBOARD NAVIGATION ---
	// Sidebar arrow-key navigation, panel focus, Enter-to-activate. Placed after
	// useStarredItems so it can traverse the Starred Sessions (top) and Group
	// Chats (bottom) sections in addition to the agent list.
	const groupChatsExpanded = useSettingsStore((s) => s.groupChatsExpanded);
	const groupChatSortAlphabetical = useSettingsStore((s) => s.groupChatSortAlphabetical);
	const starredSessionsCollapsed = useSettingsStore((s) => s.starredSessionsCollapsed);
	const { setGroupChatsExpanded, setStarredSessionsCollapsed } = useSettingsStore.getState();
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
		sidebarExtraSelection,
		setSidebarExtraSelection,
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
		starredItems,
		activateStarredItem,
		starredSectionCollapsed: starredSessionsCollapsed,
		setStarredSectionCollapsed: setStarredSessionsCollapsed,
		groupChats,
		handleOpenGroupChat,
		groupChatsExpanded,
		setGroupChatsExpanded,
		groupChatSortAlphabetical,
		showUnreadAgentsOnly,
	});

	// goToNextUnreadTab - jump to the next agent with unread tabs, clearing current agent's unreads
	const goToNextUnreadTab = useCallback(() => {
		const currentActiveId = useSessionStore.getState().activeSessionId;
		// Treat a tab with an active inline wizard as a draft target: an unfinished
		// wizard is meant to be completed into an Auto Run doc, so the navigation
		// should stop on it just like any other draft.
		const result = findNextUnreadSession(sortedSessions, currentActiveId, isWizardActiveForTab);

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
	}, [sortedSessions, setSessions, setActiveSessionId, showSuccessFlash, isWizardActiveForTab]);

	// showConfirmation, performDeleteSession - provided by useSessionLifecycle hook (Phase 2H)
	// deleteSession, deleteWorktreeGroup - provided by useSessionCrud hook

	// addNewSession, createNewSession - provided by useSessionCrud hook

	// handleWizardLaunchSession now in useWizardHandlers hook

	// toggleInputMode - extracted to useInputMode hook (Tier 3A)
	const { toggleInputMode } = useInputMode({ setTabCompletionOpen, setSlashCommandOpen });

	// toggleUnreadFilter, toggleTabStar, toggleTabUnread - provided by useSessionLifecycle hook (Phase 2H)

	// toggleGlobalLive, restartWebServer - extracted to useLiveMode hook (Tier 3B)

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

	// handleViewGitDiff - extracted to useModalHandlers (Tier 3C)

	// startRenamingSession, finishRenamingSession - provided by useSessionCrud hook

	// handleDragStart, handleDragOver - provided by useSessionCrud hook

	// Note: processInput has been extracted to useInputProcessing hook (see line ~2128)

	// Note: handleRemoteCommand effect extracted to useRemoteHandlers hook (Phase 2K)

	// Tour actions (right panel control from tour overlay) - extracted to useTourActions hook
	useTourActions();

	// Idle notification - fires configured command when all agents/batches finish
	useIdleNotification();

	// Restart-when-idle - installs a downloaded update once the app is idle
	useRestartWhenIdle();

	// Queue processing uses a narrow idle-queue signature so streaming updates do not re-render MaestroConsoleInner.
	const { processQueuedItem } = useQueueProcessing({
		conductorProfile,
		customAICommandsRef,
		speckitCommandsRef,
		openspecCommandsRef,
		bmadCommandsRef,
	});
	// Bridge: keep the original processQueuedItemRef in sync
	processQueuedItemRef.current = processQueuedItem;

	// handleInterrupt - provided by useInterruptHandler hook
	const { handleInterrupt } = useInterruptHandler({
		sessionsRef,
		cancelPendingSynopsis,
		processQueuedItem,
	});

	// --- FILE TREE MANAGEMENT ---
	// Extracted hook for file tree operations (refresh, git state, filtering)
	const { refreshFileTree, refreshGitFileState, cancelFileTreeLoad, filteredFileTree } =
		useFileTreeManagement({
			sessionsRef,
			setSessions,
			activeSessionId,
			activeSession,
			rightPanelRef,
			sshRemoteIgnorePatterns: settings.sshRemoteIgnorePatterns,
			sshRemoteHonorGitignore: settings.sshRemoteHonorGitignore,
			localIgnorePatterns: settings.localIgnorePatterns,
			localHonorGitignore: settings.localHonorGitignore,
			fileExplorerMaxDepth: settings.fileExplorerMaxDepth,
			fileExplorerMaxEntries: settings.fileExplorerMaxEntries,
			sshReduceEntryCapEnabled: settings.sshReduceEntryCapEnabled,
			sshReduceEntryCapFraction: settings.sshReduceEntryCapFraction,
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
		resumeAfterError: resumeAutoRunAfterError,
		skipCurrentDocument: skipCurrentAutoRunDocument,
		abortBatchOnError: abortAutoRunBatchOnError,
	});

	// --- GROUP MANAGEMENT ---
	// Extracted hook for group CRUD operations (toggle, rename, create, drag-drop)
	const {
		toggleGroup,
		startRenamingGroup,
		finishRenamingGroup,
		createNewGroup,
		setGroupParent,
		handleCloseCreateGroupModal,
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
	const { createGroupModalOpen, createGroupParentId, setCreateGroupModalOpen } = groupModalState;

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
		clearPendingMoveToGroup,
	} = useSessionCrud({
		flushSessionPersistence,
		setRemovedWorktreePaths,
		showConfirmation,
		inputRef,
		setCreateGroupModalOpen,
	});

	const handleCloseGroupCreation = useCallback(() => {
		clearPendingMoveToGroup();
		handleCloseCreateGroupModal();
	}, [clearPendingMoveToGroup, handleCloseCreateGroupModal]);

	// Prompt Composer modal handlers - extracted to usePromptComposerHandlers hook
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

	// Quick Actions modal handlers - extracted to useQuickActionsHandlers hook
	const {
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

	// Queue browser handlers - extracted to useQueueHandlers hook
	const {
		handleRemoveQueueItem,
		handleSwitchQueueSession,
		handleReorderQueueItems,
		handleTogglePauseQueueItem,
		handleEditQueueItem,
	} = useQueueHandlers();

	// Symphony contribution handler - extracted to useSymphonyContribution hook
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
		handleOpenBatchRunner,
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
		fileTreeFilterInputRef,
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
		isPaneShortcut,
		tilingShortcuts,
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
		flushGroupChatDraft,
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

		// Execution queue browser (Cmd+Shift+X)
		handleOpenQueueBrowser,

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
		// Output search is scoped per agent+AI-tab; open the active window's slot.
		const key = getActiveOutputSearchKey();
		if (key) useUIStore.getState().setOutputSearchOpen(key, true);
	}, []);

	const mainPanelProps = useMainPanelProps({
		// Core state
		logViewerOpen,
		agentSessionsOpen,
		memoryViewerOpen,
		activeAgentSessionId,
		activeSession,
		theme,
		isMobileLandscape,
		stagedImages,
		commandHistoryOpen,
		commandHistoryFilter,
		commandHistorySelectedIndex,
		slashCommandOpen,
		slashCommands: allSlashCommands,
		selectedSlashCommandIndex,

		// Tab completion state
		tabCompletionOpen,
		tabCompletionSuggestions,
		selectedTabCompletionIndex,
		tabCompletionFilter,

		// @ mention completion state (unified picker: files + dirs + agents + groups)
		atMentionOpen,
		atMentionFilter,
		atMentionStartIndex,
		atMentionItems,
		atMentionCounts,
		atMentionCategory,
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
		setAtMentionCategory,
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
		handleToggleQueuedItemPause,
		handleEditQueuedItem,
		handleReorderQueuedItem,
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
		handleToggleTabEnterToSend,
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
		handleBrowserTabRename: handleRequestBrowserTabRename,
		handleBrowserTabResetName: handleResetBrowserTabName,
		handleBrowserTabUpdate: handleUpdateBrowserTab,

		// Terminal tab callbacks (Phase 8)
		handleOpenTerminalTab,
		handleTerminalTabSelect: handleSelectTerminalTab,
		handleTerminalTabClose: handleCloseTerminalTab,
		handleTerminalTabRename: handleRequestTerminalTabRename,
		handleTerminalTabConfigureStartupCommand: handleRequestTerminalTabConfigureStartupCommand,
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
		handleSessionRecover,
		isRecoveringSession,
		sessionRecoveryError,
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

		// "Open in Maestro Browser" toolbar button on FilePreview routes through
		// the same handler the file-tree context menu uses.
		handleOpenBrowserTabAt,

		// Wizard callbacks
		generateInlineWizardDocuments,
		retryInlineWizardMessage,
		clearInlineWizardError,
		endInlineWizard,
		handleAutoRunRefresh,

		// Complex wizard handlers
		onWizardComplete: handleWizardComplete,
		onWizardCompleteAndStartAutoRun: handleWizardCompleteAndStartAutoRun,
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

		// Starred Sessions (shared with Cmd+[ / Cmd+] cycling via useStarredItems)
		starredItems,
		activateStarredItem,

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
		setGroupParent,
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
		maestroCueEnabled: encoreFeatures.maestroCue,
		// Virtuosos: provider switching entry points (gated on the Encore flag)
		handleSwitchProvider: encoreFeatures.virtuosos ? handleSwitchProvider : undefined,
		handleUnarchive: encoreFeatures.virtuosos ? handleUnarchive : undefined,
		handleJumpToStarredSession,
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
		toggleFolderRecursive,
		handleFileClick,
		expandAllFolders,
		collapseAllFolders,
		updateSessionWorkingDirectory,
		refreshFileTree,
		cancelFileTreeLoad,
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

		// Browser tab handler (used by file-tree "Open in Maestro Browser")
		handleOpenBrowserTabAt,
	});

	// Chat-attach drop zone for the group chat view (parity with the main panel).
	// Scoped to the group chat container so only that region reacts.
	const groupChatDropZone = useChatFileDropZone(theme, handleGroupChatDrop);

	const handleCloseDrawers = useCallback(() => {
		setLeftSidebarOpen(false);
		setRightPanelOpen(false);
	}, [setLeftSidebarOpen, setRightPanelOpen]);

	// Narrow map for GroupChatRightPanel: participant id → projectRoot.
	// Dedicated equality (not sidebar): sidebar ignores projectRoot, so a
	// directory change would otherwise leave this map stale.
	const sessionsForProjectRoots = useStoreWithEqualityFn(
		useSessionStore,
		(s) => s.sessions,
		projectRootSessionEquality
	);
	const participantSessionPaths = useMemo(() => {
		if (!activeGroupChatId) return new Map<string, string>();
		const chat = groupChats.find((c) => c.id === activeGroupChatId);
		if (!chat) return new Map<string, string>();
		const ids = new Set(chat.participants.map((p) => p.sessionId));
		return new Map(
			sessionsForProjectRoots.filter((s) => ids.has(s.id)).map((s) => [s.id, s.projectRoot])
		);
	}, [activeGroupChatId, groupChats, sessionsForProjectRoots]);

	return (
		<>
			<AppShell
				theme={theme}
				fontFamily={fontFamily}
				fontSize={fontSize}
				keyboardShellOffset={keyboardShellOffset}
				isMobileLandscape={isMobileLandscape}
				useNativeTitleBar={useNativeTitleBar}
				isMdDownViewport={isMdDownViewport}
				concertoEnabled={encoreFeatures.concerto === true}
				activeGroupChatId={activeGroupChatId}
				groupChats={groupChats}
				groups={groups}
				activeSession={activeSession}
				hasSessions={hasSessions}
				sessionsLoaded={sessionsLoaded}
				emptyStateProps={{
					shortcuts,
					onNewAgent: addNewSession,
					onOpenWizard: openWizardModal,
					onOpenSettings: () => setSettingsModalOpen(true),
					onOpenShortcutsHelp: () => setShortcutsHelpOpen(true),
					onOpenAbout: () => setAboutModalOpen(true),
					onCheckForUpdates: () => setUpdateCheckModalOpen(true),
				}}
				sessionListProps={sessionListProps}
				mainPanelRef={mainPanelRef}
				mainPanelProps={mainPanelProps}
				rightPanelRef={rightPanelRef}
				rightPanelProps={rightPanelProps}
				isNarrowViewport={isNarrowViewport}
				leftSidebarOpen={leftSidebarOpen}
				rightPanelOpen={rightPanelOpen}
				onCloseDrawers={handleCloseDrawers}
				drawerCloseSwipeHandlers={drawerCloseSwipe.handlers}
				drawerSwipeEnabled={drawerSwipeEnabled}
				leftEdgeSwipeHandlers={leftEdgeSwipe.handlers}
				rightEdgeSwipeHandlers={rightEdgeSwipe.handlers}
				logViewerOpen={logViewerOpen}
				onToastSessionClick={handleToastSessionClick}
				logViewer={
					logViewerOpen ? (
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
					) : null
				}
				groupChatView={
					!logViewerOpen &&
					activeGroupChatId &&
					isGroupChatVisibleInWindow(groupChatInitiatorWindowId, currentWindowId) &&
					groupChats.find((c) => c.id === activeGroupChatId) ? (
						<>
							<div
								className="flex-1 flex flex-col min-w-0"
								style={{ backgroundColor: theme.colors.bgMain }}
							>
								{groupChatDropZone.overlay}
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
										const anyParticipantMissingCost = participants.some(
											(p) => p.totalCost === undefined || p.totalCost === null
										);
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
									onDraftChange={handleGroupChatDraftChange}
									onOpenPromptComposer={handleOpenGroupChatPromptComposer}
									draftFlushRef={groupChatDraftFlushRef}
									stagedImages={groupChatStagedImages}
									setStagedImages={setGroupChatStagedImages}
									readOnlyMode={groupChatReadOnlyMode}
									setReadOnlyMode={setGroupChatReadOnlyMode}
									inputRef={groupChatInputRef}
									handlePaste={handlePaste}
									handleDrop={handleGroupChatDrop}
									onOpenLightbox={handleSetLightboxImage}
									executionQueue={groupChatExecutionQueue.filter(
										(item) => item.tabId === activeGroupChatId
									)}
									onRemoveQueuedItem={handleRemoveGroupChatQueueItem}
									onReorderQueuedItems={handleReorderGroupChatQueueItems}
									markdownEditMode={chatRawTextMode}
									onToggleMarkdownEditMode={handleToggleGroupChatMarkdownMode}
									maxOutputLines={maxOutputLines}
									enterToSendAI={enterToSendAI}
									setEnterToSendAI={setEnterToSendAI}
									showFlashNotification={handleGroupChatFlashNotification}
									participantColors={groupChatParticipantColors}
									messagesRef={groupChatMessagesRef}
									ghCliAvailable={ghCliAvailable}
									onPublishMessageGist={handlePublishGroupChatMessageGist}
								/>
							</div>
							<GroupChatRightPanel
								theme={theme}
								groupChatId={activeGroupChatId}
								participants={
									groupChats.find((c) => c.id === activeGroupChatId)?.participants || []
								}
								participantStates={participantStates}
								participantSessionPaths={participantSessionPaths}
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
					) : null
				}
				modals={
					<AppModals
						// Common props (sessions/groups/groupChats + modal booleans self-sourced from stores - Tier 1B)
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
						onCloseAgentRunDashboard={() => setAgentRunDashboardOpen(false)}
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
						onQuitWhenIdle={handleQuitWhenIdle}
						activeBatchSessionIds={activeBatchSessionIds}
						// AppSessionModals props
						onCloseNewInstanceModal={handleCloseNewInstanceModal}
						onCreateSession={createNewSession}
						duplicatingSessionId={duplicatingSessionId}
						newInstancePresetGroupId={newInstancePresetGroupId}
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
						createGroupParentId={createGroupParentId}
						onCloseCreateGroupModal={handleCloseGroupCreation}
						onGroupCreated={handleGroupCreated}
						renameGroupId={renameGroupId}
						renameGroupValue={renameGroupValue}
						setRenameGroupValue={setRenameGroupValue}
						renameGroupEmoji={renameGroupEmoji}
						setRenameGroupEmoji={setRenameGroupEmoji}
						renameGroupIcon={renameGroupIcon}
						setRenameGroupIcon={setRenameGroupIcon}
						renameGroupColor={renameGroupColor}
						setRenameGroupColor={setRenameGroupColor}
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
						setRenameGroupIconForQuickActions={setRenameGroupIcon}
						setRenameGroupColorForQuickActions={setRenameGroupColor}
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
						setAgentRunDashboardOpen={setAgentRunDashboardOpen}
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
						onQuickActionsToggleTabEnterToSend={handleQuickActionsToggleTabEnterToSend}
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
						setDebugPackageModalOpen={setDebugPackageModalOpen}
						setDebugApplicationStatsOpen={setDebugApplicationStatsOpen}
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
						onRunPromptMacro={handleRunPromptMacro}
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
						onToggleAutoRunExpanded={handleQuickActionsToggleAutoRunExpanded}
						onClearActiveTerminal={handleQuickActionsClearActiveTerminal}
						onCloseCurrentTab={handleQuickActionsCloseCurrentTab}
						onMoveTabToFirst={handleQuickActionsMoveTabToFirst}
						onMoveTabToLast={handleQuickActionsMoveTabToLast}
						onFocusActiveTab={handleQuickActionsFocusActiveTab}
						onCopyTabContext={handleQuickActionsCopyTabContext}
						onExportTabHtml={handleQuickActionsExportTabHtml}
						onPublishTabGist={handleQuickActionsPublishTabGist}
						mainPanelRef={mainPanelRef}
						isFilePreviewOpen={!!activeSession?.activeFileTabId}
						ghCliAvailable={ghCliAvailable}
						onPublishGist={() => setGistPublishModalOpen(true)}
						lastGraphFocusFile={lastGraphFocusFilePath}
						onOpenLastDocumentGraph={handleOpenLastDocumentGraph}
						currentGraphFile={
							activeFileTab && /\.(md|markdown)$/i.test(activeFileTab.name)
								? activeFileTab.name
								: undefined
						}
						onOpenCurrentFileInGraph={mainPanelProps.onOpenInGraph}
						lightboxImage={lightboxImage}
						lightboxImages={lightboxImages}
						stagedImages={stagedImages}
						onCloseLightbox={handleCloseLightbox}
						onNavigateLightbox={handleNavigateLightbox}
						onDeleteLightboxImage={lightboxAllowDelete ? handleDeleteLightboxImage : undefined}
						onUpdateLightboxImage={lightboxAllowDelete ? handleUpdateLightboxImage : undefined}
						gitDiffPreview={gitDiffPreview}
						gitViewerCwd={gitViewerCwd}
						onCloseGitDiff={handleCloseGitDiff}
						onCloseGitLog={handleCloseGitLog}
						onOpenGitFile={handleOpenGitFile}
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
						onOpenPianola={encoreFeatures.pianola ? () => setPianolaModalOpen(true) : undefined}
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
						onOpenQueueBrowser={handleOpenQueueBrowser}
						onCloseQueueBrowser={handleCloseQueueBrowser}
						onQuickActionsNewTab={handleNewTab}
						onQuickActionsNewFileTab={handleNewFileTab}
						onQuickActionsNewBrowserTab={handleNewBrowserTab}
						onQuickActionsNewTerminalTab={handleOpenTerminalTab}
						onGoToNextUnread={goToNextUnreadTab}
						onNavBack={handleNavBack}
						onNavForward={handleNavForward}
						onRemoveQueueItem={handleRemoveQueueItem}
						onSwitchQueueSession={handleSwitchQueueSession}
						onReorderQueueItems={handleReorderQueueItems}
						onTogglePauseQueueItem={handleTogglePauseQueueItem}
						onEditQueueItem={handleEditQueueItem}
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
						onJumpToAgent={handleJumpToFailingAgent}
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
				}
				standaloneModals={
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
				}
			/>
			{/* Account Switch Confirmation Modal */}
			{switchPromptData && (
				<AccountSwitchModal
					theme={theme}
					isOpen={true}
					onClose={() => setSwitchPromptData(null)}
					switchData={switchPromptData}
					onConfirmSwitch={async () => {
						await window.maestro.accounts.executeSwitch({
							sessionId: switchPromptData.sessionId,
							fromAccountId: switchPromptData.fromAccountId,
							toAccountId: switchPromptData.toAccountId,
							reason: switchPromptData.reason,
							automatic: false,
						});
						setSwitchPromptData(null);
					}}
					onViewDashboard={() => {
						setSwitchPromptData(null);
						setVirtuososOpen(true);
					}}
				/>
			)}
			{/* Virtuosos Modal */}
			{encoreFeatures.virtuosos === true && (
				<VirtuososModal
					isOpen={virtuososOpen}
					onClose={() => setVirtuososOpen(false)}
					theme={theme}
					sessions={sessionsForSidebar}
					onSelectSession={(sessionId) => {
						setVirtuososOpen(false);
						setActiveSessionId(sessionId);
					}}
				/>
			)}
			{/* Provider Switch Modal (Virtuosos vertical swapping) */}
			{switchProviderSession && (
				<SwitchProviderModal
					theme={theme}
					isOpen={true}
					onClose={() => {
						setSwitchProviderSession(null);
						resetProviderSwitch();
					}}
					sourceSession={switchProviderSession}
					sourceTabId={getActiveTab(switchProviderSession)?.id || ''}
					sessions={sessionsForSidebar}
					onConfirmSwitch={handleConfirmProviderSwitch}
				/>
			)}
			{/* Unarchive Conflict Modal */}
			{unarchiveConflictState && (
				<UnarchiveConflictModal
					theme={theme}
					archivedSession={unarchiveConflictState.archivedSession}
					conflictingSession={unarchiveConflictState.conflictingSession}
					onArchiveConflicting={handleUnarchiveWithArchiveConflict}
					onDeleteConflicting={handleUnarchiveWithDeleteConflict}
					onClose={() => setUnarchiveConflictState(null)}
				/>
			)}
		</>
	);
}

/**
 * GitStatusProviderFromStore - reads sessions/activeSessionId from the store
 * so GitStatusProvider can sit ABOVE MaestroConsoleInner. Required because
 * useModalHandlers (called inside MaestroConsoleInner) consumes useGitDetail,
 * and a context provider must wrap its consumer.
 *
 * PERF: Uses gitPollSessionEquality so streaming log/token updates do not
 * re-render MaestroConsoleInner via this parent.
 */
function GitStatusProviderFromStore({ children }: { children: ReactNode }) {
	const sessions = useStoreWithEqualityFn(
		useSessionStore,
		(s) => s.sessions,
		gitPollSessionEquality
	);
	const activeSessionId = useSessionStore((s) => s.activeSessionId);
	return (
		<GitStatusProvider sessions={sessions} activeSessionId={activeSessionId}>
			{children}
		</GitStatusProvider>
	);
}

/**
 * MaestroConsole - Main application component with context providers
 *
 * Wraps MaestroConsoleInner with context providers for centralized state management.
 * WindowProvider - per-window identity (windowId/isMainWindow) and the agents
 *   scoped to this window. Outermost so every descendant can read its window
 *   identity; additive, so the primary window behaves exactly as before when
 *   only one window exists.
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
		<WindowProvider>
			<InlineWizardProvider>
				<InputProvider>
					<GitStatusProviderFromStore>
						<MaestroConsoleInner />
					</GitStatusProviderFromStore>
				</InputProvider>
			</InlineWizardProvider>
		</WindowProvider>
	);
}
