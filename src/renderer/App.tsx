import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { SettingsModal } from './components/SettingsModal';
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
import { LogViewer } from './components/LogViewer';
import { AppOverlays } from './components/AppOverlays';
import { PlaygroundPanel } from './components/PlaygroundPanel';
import { DebugWizardModal } from './components/DebugWizardModal';
import { DebugPackageModal } from './components/DebugPackageModal';
import { GistPublishModal } from './components/GistPublishModal';
import { MaestroWizard, useWizard, WizardResumeModal, AUTO_RUN_FOLDER_NAME } from './components/Wizard';
import { TourOverlay } from './components/Wizard/tour';
import { CONDUCTOR_BADGES, getBadgeForTime } from './constants/conductorBadges';
import { EmptyStateView } from './components/EmptyStateView';
import { MarketplaceModal } from './components/MarketplaceModal';
import { DocumentGraphView } from './components/DocumentGraph/DocumentGraphView';

// Group Chat Components
import { GroupChatPanel } from './components/GroupChatPanel';
import { GroupChatRightPanel, type GroupChatRightTab } from './components/GroupChatRightPanel';

// Import custom hooks
import {
  // Batch processing
  useBatchProcessor,
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
  useInputSync,
  useTabCompletion,
  useAtMentionCompletion,
  useInputProcessing,
  DEFAULT_IMAGE_ONLY_PROMPT,
  // Keyboard handling
  useKeyboardShortcutHelpers,
  useKeyboardNavigation,
  useMainKeyboardHandler,
  // Agent
  useAgentSessionManagement,
  useAgentExecution,
  useAgentErrorRecovery,
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
} from './hooks';
import type { TabCompletionSuggestion, TabCompletionFilter } from './hooks';

// Import contexts
import { useLayerStack } from './contexts/LayerStackContext';
import { useToast } from './contexts/ToastContext';
import { useModalContext } from './contexts/ModalContext';
import { GitStatusProvider } from './contexts/GitStatusContext';
import { InputProvider, useInputContext } from './contexts/InputContext';
import { GroupChatProvider, useGroupChat } from './contexts/GroupChatContext';
import { AutoRunProvider, useAutoRun } from './contexts/AutoRunContext';
import { SessionProvider, useSession } from './contexts/SessionContext';
import { ToastContainer } from './components/Toast';

// Import services
import { gitService } from './services/git';
import { getSpeckitCommands } from './services/speckit';
import { getOpenSpecCommands } from './services/openspec';

// Import prompts and synopsis parsing
import { autorunSynopsisPrompt, maestroSystemPrompt } from '../prompts';
import { parseSynopsis } from '../shared/synopsis';
import { formatRelativeTime } from '../shared/formatters';

// Import types and constants
// Note: GroupChat, GroupChatState are now imported via GroupChatContext; GroupChatMessage still used locally
import type {
  ToolType, SessionState, RightPanelTab,
  FocusArea, LogEntry, Session, AITab, UsageStats, QueuedItem, BatchRunConfig,
  AgentError, BatchRunState, GroupChatMessage,
  SpecKitCommand, OpenSpecCommand, LeaderboardRegistration, CustomAICommand
} from './types';
import { THEMES } from './constants/themes';
import { generateId } from './utils/ids';
import { getContextColor } from './utils/theme';
import { setActiveTab, createTab, closeTab, reopenClosedTab, getActiveTab, getWriteModeTab, navigateToNextTab, navigateToPrevTab, navigateToTabByIndex, navigateToLastTab, getInitialRenameValue } from './utils/tabHelpers';
import { shouldOpenExternally, flattenTree } from './utils/fileExplorer';
import type { FileNode } from './types/fileTree';
import { substituteTemplateVariables } from './utils/templateVariables';
import { validateNewSession } from './utils/sessionValidation';
import { estimateContextUsage } from './utils/contextUsage';
import { formatLogsForClipboard } from './utils/contextExtractor';
import { isLikelyConcatenatedToolNames, getSlashCommandDescription } from './constants/app';

// Note: DEFAULT_IMAGE_ONLY_PROMPT is now imported from useInputProcessing hook

/**
 * Get a human-readable title for an agent error type.
 * Used for toast notifications and history entries.
 */
function getErrorTitleForType(type: AgentError['type']): string {
  switch (type) {
    case 'auth_expired':
      return 'Authentication Required';
    case 'token_exhaustion':
      return 'Context Limit Reached';
    case 'rate_limited':
      return 'Rate Limit Exceeded';
    case 'network_error':
      return 'Connection Error';
    case 'agent_crashed':
      return 'Agent Error';
    case 'permission_denied':
      return 'Permission Denied';
    case 'session_not_found':
      return 'Session Not Found';
    default:
      return 'Error';
  }
}

function MaestroConsoleInner() {
  console.error('[MaestroConsoleInner] render start');
  // --- LAYER STACK (for blocking shortcuts when modals are open) ---
  const { hasOpenLayers, hasOpenModal } = useLayerStack();

  // --- TOAST NOTIFICATIONS ---
  const { addToast, setDefaultDuration: setToastDefaultDuration, setAudioFeedback, setOsNotifications } = useToast();

  // --- MODAL STATE (centralized modal state management) ---
  const {
    // Settings Modal
    settingsModalOpen, setSettingsModalOpen, settingsTab, setSettingsTab,
    // New Instance Modal
    newInstanceModalOpen, setNewInstanceModalOpen, duplicatingSessionId, setDuplicatingSessionId,
    // Edit Agent Modal
    editAgentModalOpen, setEditAgentModalOpen, editAgentSession, setEditAgentSession,
    // Shortcuts Help Modal
    shortcutsHelpOpen, setShortcutsHelpOpen, setShortcutsSearchQuery,
    // Quick Actions Modal
    quickActionOpen, setQuickActionOpen, quickActionInitialMode, setQuickActionInitialMode,
    // Lightbox Modal
    lightboxImage, setLightboxImage, lightboxImages, setLightboxImages, setLightboxSource,
    lightboxIsGroupChatRef, lightboxAllowDeleteRef,
    // About Modal
    aboutModalOpen, setAboutModalOpen,
    // Update Check Modal
    updateCheckModalOpen, setUpdateCheckModalOpen,
    // Leaderboard Registration Modal
    leaderboardRegistrationOpen, setLeaderboardRegistrationOpen,
    // Standing Ovation Overlay
    standingOvationData, setStandingOvationData,
    // First Run Celebration
    firstRunCelebrationData, setFirstRunCelebrationData,
    // Log Viewer
    logViewerOpen, setLogViewerOpen,
    // Process Monitor
    processMonitorOpen, setProcessMonitorOpen,
    // Usage Dashboard
    usageDashboardOpen, setUsageDashboardOpen,
    // Keyboard Mastery Celebration
    pendingKeyboardMasteryLevel, setPendingKeyboardMasteryLevel,
    // Playground Panel
    playgroundOpen, setPlaygroundOpen,
    // Debug Wizard Modal
    debugWizardModalOpen, setDebugWizardModalOpen,
    // Debug Package Modal
    debugPackageModalOpen, setDebugPackageModalOpen,
    // Confirmation Modal
    confirmModalOpen, setConfirmModalOpen, confirmModalMessage, setConfirmModalMessage,
    confirmModalOnConfirm, setConfirmModalOnConfirm,
    // Quit Confirmation Modal
    quitConfirmModalOpen, setQuitConfirmModalOpen,
    // Rename Instance Modal
    renameInstanceModalOpen, setRenameInstanceModalOpen, renameInstanceValue, setRenameInstanceValue,
    renameInstanceSessionId, setRenameInstanceSessionId,
    // Rename Tab Modal
    renameTabModalOpen, setRenameTabModalOpen, renameTabId, setRenameTabId,
    renameTabInitialName, setRenameTabInitialName,
    // Rename Group Modal
    renameGroupModalOpen, setRenameGroupModalOpen, renameGroupId, setRenameGroupId,
    renameGroupValue, setRenameGroupValue, renameGroupEmoji, setRenameGroupEmoji,
    // Agent Sessions Browser
    agentSessionsOpen, setAgentSessionsOpen, activeAgentSessionId, setActiveAgentSessionId,
    // Execution Queue Browser Modal
    queueBrowserOpen, setQueueBrowserOpen,
    // Batch Runner Modal
    batchRunnerModalOpen, setBatchRunnerModalOpen,
    // Auto Run Setup Modal
    autoRunSetupModalOpen, setAutoRunSetupModalOpen,
    // Marketplace Modal
    marketplaceModalOpen, setMarketplaceModalOpen,
    // Wizard Resume Modal
    wizardResumeModalOpen, setWizardResumeModalOpen, wizardResumeState, setWizardResumeState,
    // Agent Error Modal
    agentErrorModalSessionId, setAgentErrorModalSessionId,
    // Worktree Modals
    worktreeConfigModalOpen, setWorktreeConfigModalOpen,
    createWorktreeModalOpen, setCreateWorktreeModalOpen, createWorktreeSession, setCreateWorktreeSession,
    createPRModalOpen, setCreatePRModalOpen, createPRSession, setCreatePRSession,
    deleteWorktreeModalOpen, setDeleteWorktreeModalOpen, deleteWorktreeSession, setDeleteWorktreeSession,
    // Tab Switcher Modal
    tabSwitcherOpen, setTabSwitcherOpen,
    // Fuzzy File Search Modal
    fuzzyFileSearchOpen, setFuzzyFileSearchOpen,
    // Prompt Composer Modal
    promptComposerOpen, setPromptComposerOpen,
    // Merge Session Modal
    mergeSessionModalOpen, setMergeSessionModalOpen,
    // Send to Agent Modal
    sendToAgentModalOpen, setSendToAgentModalOpen,
    // Group Chat Modals
    showNewGroupChatModal, setShowNewGroupChatModal,
    showDeleteGroupChatModal, setShowDeleteGroupChatModal,
    showRenameGroupChatModal, setShowRenameGroupChatModal,
    showEditGroupChatModal, setShowEditGroupChatModal,
    showGroupChatInfo, setShowGroupChatInfo,
    // Git Diff Viewer
    gitDiffPreview, setGitDiffPreview,
    // Git Log Viewer
    gitLogOpen, setGitLogOpen,
    // Tour Overlay
    tourOpen, setTourOpen, tourFromWizard, setTourFromWizard,
  } = useModalContext();

  // --- MOBILE LANDSCAPE MODE (reading-only view) ---
  const isMobileLandscape = useMobileLandscape();

  // --- NAVIGATION HISTORY (back/forward through sessions and tabs) ---
  const {
    pushNavigation,
    navigateBack,
    navigateForward,
  } = useNavigationHistory();

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
    settingsLoaded,
    llmProvider, setLlmProvider,
    modelSlug, setModelSlug,
    apiKey, setApiKey,
    defaultShell, setDefaultShell,
    customShellPath, setCustomShellPath,
    shellArgs, setShellArgs,
    shellEnvVars, setShellEnvVars,
    ghPath, setGhPath,
    fontFamily, setFontFamily,
    fontSize, setFontSize,
    activeThemeId, setActiveThemeId,
    customThemeColors, setCustomThemeColors,
    customThemeBaseId, setCustomThemeBaseId,
    enterToSendAI, setEnterToSendAI,
    enterToSendTerminal, setEnterToSendTerminal,
    defaultSaveToHistory, setDefaultSaveToHistory,
    defaultShowThinking, setDefaultShowThinking,
    leftSidebarWidth, setLeftSidebarWidth,
    rightPanelWidth, setRightPanelWidth,
    markdownEditMode, setMarkdownEditMode,
    showHiddenFiles, setShowHiddenFiles,
    terminalWidth, setTerminalWidth,
    logLevel, setLogLevel,
    logViewerSelectedLevels, setLogViewerSelectedLevels,
    maxLogBuffer, setMaxLogBuffer,
    maxOutputLines, setMaxOutputLines,
    osNotificationsEnabled, setOsNotificationsEnabled,
    audioFeedbackEnabled, setAudioFeedbackEnabled,
    audioFeedbackCommand, setAudioFeedbackCommand,
    toastDuration, setToastDuration,
    checkForUpdatesOnStartup, setCheckForUpdatesOnStartup,
    enableBetaUpdates, setEnableBetaUpdates,
    crashReportingEnabled, setCrashReportingEnabled,
    shortcuts, setShortcuts,
    tabShortcuts, setTabShortcuts,
    customAICommands, setCustomAICommands,
    globalStats, updateGlobalStats,
    autoRunStats, setAutoRunStats, recordAutoRunComplete, updateAutoRunProgress, acknowledgeBadge, getUnacknowledgedBadgeLevel,
    usageStats, updateUsageStats,
    tourCompleted: _tourCompleted, setTourCompleted,
    firstAutoRunCompleted, setFirstAutoRunCompleted,
    recordWizardStart, recordWizardComplete, recordWizardAbandon, recordWizardResume,
    recordTourStart, recordTourComplete, recordTourSkip,
    leaderboardRegistration, setLeaderboardRegistration, isLeaderboardRegistered,

    contextManagementSettings, updateContextManagementSettings: _updateContextManagementSettings,

    keyboardMasteryStats, recordShortcutUsage, acknowledgeKeyboardMasteryLevel, getUnacknowledgedKeyboardMasteryLevel,

    // Document Graph & Stats settings
    colorBlindMode,
    defaultStatsTimeRange,
    documentGraphShowExternalLinks,
    documentGraphMaxNodes,

  } = settings;

  // --- KEYBOARD SHORTCUT HELPERS ---
  const { isShortcut, isTabShortcut } = useKeyboardShortcutHelpers({ shortcuts, tabShortcuts });

  // --- SESSION STATE (Phase 6: extracted to SessionContext) ---
  // Use SessionContext for all core session states
  const {
    sessions, setSessions,
    groups, setGroups,
    activeSessionId, setActiveSessionId: setActiveSessionIdFromContext,
    setActiveSessionIdInternal,
    sessionsLoaded, setSessionsLoaded,
    initialLoadComplete,
    sessionsRef, groupsRef, activeSessionIdRef,
    batchedUpdater,
    activeSession,
    cyclePositionRef,
    removedWorktreePaths: _removedWorktreePaths, setRemovedWorktreePaths, removedWorktreePathsRef,
  } = useSession();

  // Spec Kit commands (loaded from bundled prompts)
  const [speckitCommands, setSpeckitCommands] = useState<SpecKitCommand[]>([]);

  // OpenSpec commands (loaded from bundled prompts)
  const [openspecCommands, setOpenspecCommands] = useState<OpenSpecCommand[]>([]);

  // --- GROUP CHAT STATE (Phase 4: extracted to GroupChatContext) ---
  // Note: groupChatsExpanded remains here as it's a UI layout concern (already in UILayoutContext)
  const [groupChatsExpanded, setGroupChatsExpanded] = useState(true);

  // Use GroupChatContext for all group chat states
  const {
    groupChats, setGroupChats,
    activeGroupChatId, setActiveGroupChatId,
    groupChatMessages, setGroupChatMessages,
    groupChatState, setGroupChatState,
    groupChatStagedImages, setGroupChatStagedImages,
    groupChatReadOnlyMode, setGroupChatReadOnlyMode,
    groupChatExecutionQueue, setGroupChatExecutionQueue,
    groupChatRightTab, setGroupChatRightTab,
    groupChatParticipantColors, setGroupChatParticipantColors,
    moderatorUsage, setModeratorUsage,
    participantStates, setParticipantStates,
    groupChatStates, setGroupChatStates,
    allGroupChatParticipantStates, setAllGroupChatParticipantStates,
    groupChatError, setGroupChatError,
    groupChatInputRef,
    groupChatMessagesRef,
    clearGroupChatError: handleClearGroupChatErrorBase,
  } = useGroupChat();

  // SSH Remote configs for looking up SSH remote names (used for participant cards in group chat)
  const [sshRemoteConfigs, setSshRemoteConfigs] = useState<Array<{ id: string; name: string }>>([]);

  // Load SSH configs once on mount
  useEffect(() => {
    window.maestro.sshRemote.getConfigs()
      .then((result) => {
        if (result.success && result.configs) {
          setSshRemoteConfigs(result.configs.map((c: { id: string; name: string }) => ({ id: c.id, name: c.name })));
        }
      })
      .catch(console.error);
  }, []);

  // Compute map of session names to SSH remote names (for group chat participant cards)
  const sessionSshRemoteNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const session of sessions) {
      if (session.sessionSshRemoteConfig?.enabled && session.sessionSshRemoteConfig.remoteId) {
        const sshConfig = sshRemoteConfigs.find(c => c.id === session.sessionSshRemoteConfig?.remoteId);
        if (sshConfig) {
          map.set(session.name, sshConfig.name);
        }
      }
    }
    return map;
  }, [sessions, sshRemoteConfigs]);

  // Wrapper for setActiveSessionId that also dismisses active group chat
  const setActiveSessionId = useCallback((id: string) => {
    setActiveGroupChatId(null); // Dismiss group chat when selecting an agent
    setActiveSessionIdFromContext(id);
  }, [setActiveSessionIdFromContext, setActiveGroupChatId]);

  // Input State - PERFORMANCE CRITICAL: Input values stay in App.tsx local state
  // to avoid context re-renders on every keystroke. Only completion states are in context.
  const [terminalInputValue, setTerminalInputValue] = useState('');
  const [aiInputValueLocal, setAiInputValueLocal] = useState('');

  // Completion states from InputContext (these change infrequently)
  const {
    slashCommandOpen, setSlashCommandOpen,
    selectedSlashCommandIndex, setSelectedSlashCommandIndex,
    tabCompletionOpen, setTabCompletionOpen,
    selectedTabCompletionIndex, setSelectedTabCompletionIndex,
    tabCompletionFilter, setTabCompletionFilter,
    atMentionOpen, setAtMentionOpen,
    atMentionFilter, setAtMentionFilter,
    atMentionStartIndex, setAtMentionStartIndex,
    selectedAtMentionIndex, setSelectedAtMentionIndex,
    commandHistoryOpen, setCommandHistoryOpen,
    commandHistoryFilter, setCommandHistoryFilter,
    commandHistorySelectedIndex, setCommandHistorySelectedIndex,
  } = useInputContext();

  // UI State
  const [leftSidebarOpen, setLeftSidebarOpen] = useState(true);
  const [rightPanelOpen, setRightPanelOpen] = useState(true);
  const [activeRightTab, setActiveRightTab] = useState<RightPanelTab>('files');
  const [activeFocus, setActiveFocus] = useState<FocusArea>('main');
  const [bookmarksCollapsed, setBookmarksCollapsed] = useState(false);
  const [showUnreadOnly, setShowUnreadOnly] = useState(false);
  // Track the active tab ID before entering unread filter mode, so we can restore it when exiting
  const preFilterActiveTabIdRef = useRef<string | null>(null);

  // File Explorer State
  const [previewFile, setPreviewFile] = useState<{name: string; content: string; path: string} | null>(null);
  const [filePreviewLoading, setFilePreviewLoading] = useState<{name: string; path: string} | null>(null);
  const [selectedFileIndex, setSelectedFileIndex] = useState(0);
  const [flatFileList, setFlatFileList] = useState<any[]>([]);
  const [fileTreeFilter, setFileTreeFilter] = useState('');
  const [fileTreeFilterOpen, setFileTreeFilterOpen] = useState(false);
  const [isGraphViewOpen, setIsGraphViewOpen] = useState(false);
  // File path to focus on when opening the Document Graph (relative to session.cwd)
  const [graphFocusFilePath, setGraphFocusFilePath] = useState<string | undefined>(undefined);
  // Track the last opened document graph for quick re-open from command palette
  const [lastGraphFocusFilePath, setLastGraphFocusFilePath] = useState<string | undefined>(undefined);

  // GitHub CLI availability (for gist publishing)
  const [ghCliAvailable, setGhCliAvailable] = useState(false);
  const [gistPublishModalOpen, setGistPublishModalOpen] = useState(false);

  // Note: Git Diff State, Tour Overlay State, and Git Log Viewer State are now from ModalContext

  // Renaming State
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);

  // Drag and Drop State (for session list - image drag handled by useAppHandlers)
  const [draggingSessionId, setDraggingSessionId] = useState<string | null>(null);

  // Note: All modal states are now managed by ModalContext
  // See useModalContext() destructuring above for modal states

  // Stable callbacks for memoized modals (prevents re-renders from callback reference changes)
  // NOTE: These must be declared AFTER the state they reference
  const handleCloseGitDiff = useCallback(() => setGitDiffPreview(null), []);
  const handleCloseGitLog = useCallback(() => setGitLogOpen(false), []);
  const handleCloseSettings = useCallback(() => setSettingsModalOpen(false), []);
  const handleCloseDebugPackage = useCallback(() => setDebugPackageModalOpen(false), []);

  // AppInfoModals stable callbacks
  const handleCloseShortcutsHelp = useCallback(() => setShortcutsHelpOpen(false), []);
  const handleCloseAboutModal = useCallback(() => setAboutModalOpen(false), []);
  const handleCloseUpdateCheckModal = useCallback(() => setUpdateCheckModalOpen(false), []);
  const handleCloseProcessMonitor = useCallback(() => setProcessMonitorOpen(false), []);
  const handleCloseLogViewer = useCallback(() => setLogViewerOpen(false), []);

  // Confirm modal close handler
  const handleCloseConfirmModal = useCallback(() => setConfirmModalOpen(false), []);

  // Quit confirm modal handlers
  const handleConfirmQuit = useCallback(() => {
    setQuitConfirmModalOpen(false);
    window.maestro.app.confirmQuit();
  }, []);

  const handleCancelQuit = useCallback(() => {
    setQuitConfirmModalOpen(false);
    window.maestro.app.cancelQuit();
  }, []);

  // Keyboard mastery level-up callback
  const onKeyboardMasteryLevelUp = useCallback((level: number) => {
    setPendingKeyboardMasteryLevel(level);
  }, []);

  // Handle keyboard mastery celebration close
  const handleKeyboardMasteryCelebrationClose = useCallback(() => {
    if (pendingKeyboardMasteryLevel !== null) {
      acknowledgeKeyboardMasteryLevel(pendingKeyboardMasteryLevel);
    }
    setPendingKeyboardMasteryLevel(null);
  }, [pendingKeyboardMasteryLevel, acknowledgeKeyboardMasteryLevel]);

  // Handle standing ovation close
  const handleStandingOvationClose = useCallback(() => {
    if (standingOvationData) {
      // Mark badge as acknowledged when user clicks "Take a Bow"
      acknowledgeBadge(standingOvationData.badge.level);
    }
    setStandingOvationData(null);
  }, [standingOvationData, acknowledgeBadge]);

  // Handle first run celebration close
  const handleFirstRunCelebrationClose = useCallback(() => {
    setFirstRunCelebrationData(null);
  }, []);

  // Handle open leaderboard registration
  const handleOpenLeaderboardRegistration = useCallback(() => {
    setLeaderboardRegistrationOpen(true);
  }, []);

  // Handle open leaderboard registration from About modal (closes About first)
  const handleOpenLeaderboardRegistrationFromAbout = useCallback(() => {
    setAboutModalOpen(false);
    setLeaderboardRegistrationOpen(true);
  }, []);

  // AppSessionModals stable callbacks
  const handleCloseNewInstanceModal = useCallback(() => {
    setNewInstanceModalOpen(false);
    setDuplicatingSessionId(null);
  }, [setDuplicatingSessionId]);
  const handleCloseEditAgentModal = useCallback(() => {
    setEditAgentModalOpen(false);
    setEditAgentSession(null);
  }, []);
  const handleCloseRenameSessionModal = useCallback(() => {
    setRenameInstanceModalOpen(false);
    setRenameInstanceSessionId(null);
  }, []);
  const handleCloseRenameTabModal = useCallback(() => {
    setRenameTabModalOpen(false);
    setRenameTabId(null);
  }, []);

  // Note: All modal states (confirmation, rename, queue browser, batch runner, etc.)
  // are now managed by ModalContext - see useModalContext() destructuring above

  // NOTE: showSessionJumpNumbers state is now provided by useMainKeyboardHandler hook

  // Output Search State
  const [outputSearchOpen, setOutputSearchOpen] = useState(false);
  const [outputSearchQuery, setOutputSearchQuery] = useState('');

  // Note: Command History, Tab Completion, and @ Mention states are now in InputContext
  // See useInputContext() destructuring above for these states

  // Flash notification state (for inline notifications like "Commands disabled while agent is working")
  const [flashNotification, setFlashNotification] = useState<string | null>(null);
  // Success flash notification state (for success messages like "Refresh complete")
  const [successFlashNotification, setSuccessFlashNotification] = useState<string | null>(null);

  // Note: Images are now stored per-tab in AITab.stagedImages
  // See stagedImages/setStagedImages computed from active tab below

  // Global Live Mode State (web interface for all sessions)
  const [isLiveMode, setIsLiveMode] = useState(false);
  const [webInterfaceUrl, setWebInterfaceUrl] = useState<string | null>(null);

  // Auto Run document management state (Phase 5: now from AutoRunContext)
  // Content is per-session in session.autoRunContent
  const {
    documentList: autoRunDocumentList,
    setDocumentList: setAutoRunDocumentList,
    documentTree: autoRunDocumentTree,
    setDocumentTree: setAutoRunDocumentTree,
    isLoadingDocuments: autoRunIsLoadingDocuments,
    setIsLoadingDocuments: setAutoRunIsLoadingDocuments,
    documentTaskCounts: autoRunDocumentTaskCounts,
    setDocumentTaskCounts: setAutoRunDocumentTaskCounts,
  } = useAutoRun();

  // Restore focus when LogViewer closes to ensure global hotkeys work
  useEffect(() => {
    // When LogViewer closes, restore focus to main container or input
    if (!logViewerOpen) {
      setTimeout(() => {
        // Try to focus input first, otherwise focus document body to ensure hotkeys work
        if (inputRef.current) {
          inputRef.current.focus();
        } else if (terminalOutputRef.current) {
          terminalOutputRef.current.focus();
        } else {
          // Blur any focused element to let global handlers work
          (document.activeElement as HTMLElement)?.blur();
          document.body.focus();
        }
      }, 50);
    }
  }, [logViewerOpen]);

  // ProcessMonitor navigation handlers
  const handleProcessMonitorNavigateToSession = useCallback((sessionId: string, tabId?: string) => {
    setActiveSessionId(sessionId);
    if (tabId) {
      // Switch to the specific tab within the session
      setSessions(prev => prev.map(s =>
        s.id === sessionId ? { ...s, activeTabId: tabId } : s
      ));
    }
  }, [setActiveSessionId, setSessions]);

  const handleProcessMonitorNavigateToGroupChat = useCallback((groupChatId: string) => {
    // Restore state for this group chat when navigating from ProcessMonitor
    setActiveGroupChatId(groupChatId);
    setGroupChatState(groupChatStates.get(groupChatId) ?? 'idle');
    setParticipantStates(allGroupChatParticipantStates.get(groupChatId) ?? new Map());
    setProcessMonitorOpen(false);
  }, [setActiveGroupChatId, setGroupChatState, groupChatStates, setParticipantStates, allGroupChatParticipantStates]);

  // LogViewer shortcut handler
  const handleLogViewerShortcutUsed = useCallback((shortcutId: string) => {
    const result = recordShortcutUsage(shortcutId);
    if (result.newLevel !== null) {
      onKeyboardMasteryLevelUp(result.newLevel);
    }
  }, [recordShortcutUsage, onKeyboardMasteryLevelUp]);

  // Sync toast duration setting to ToastContext
  useEffect(() => {
    setToastDefaultDuration(toastDuration);
  }, [toastDuration, setToastDefaultDuration]);

  // Sync audio feedback settings to ToastContext for TTS on toast notifications
  useEffect(() => {
    setAudioFeedback(audioFeedbackEnabled, audioFeedbackCommand);
  }, [audioFeedbackEnabled, audioFeedbackCommand, setAudioFeedback]);

  // Sync OS notifications setting to ToastContext
  useEffect(() => {
    setOsNotifications(osNotificationsEnabled);
  }, [osNotificationsEnabled, setOsNotifications]);

  // Expose playground() function for developer console
  useEffect(() => {
    (window as unknown as { playground: () => void }).playground = () => {
      setPlaygroundOpen(true);
    };
    return () => {
      delete (window as unknown as { playground?: () => void }).playground;
    };
  }, []);

  // Close file preview when switching sessions (history is now per-session)
  // previewFile intentionally omitted: we only want to clear preview on session change, not when preview itself changes
  useEffect(() => {
    if (previewFile !== null) {
      setPreviewFile(null);
    }
     
  }, [activeSessionId]);

  // Restore a persisted session by respawning its process
  const restoreSession = async (session: Session): Promise<Session> => {
    try {
      // Migration: ensure projectRoot is set (for sessions created before this field was added)
      if (!session.projectRoot) {
        session = { ...session, projectRoot: session.cwd };
      }

      // Sessions must have aiTabs - if missing, this is a data corruption issue
      if (!session.aiTabs || session.aiTabs.length === 0) {
        console.error('[restoreSession] Session has no aiTabs - data corruption, skipping:', session.id);
        return {
          ...session,
          aiPid: -1,
          terminalPid: 0,
          state: 'error' as SessionState,
          isLive: false,
          liveUrl: undefined
        };
      }

      // Detect and fix inputMode/toolType mismatch
      // The AI agent should never use 'terminal' as toolType
      let correctedSession = { ...session };
      let aiAgentType = correctedSession.toolType;

      // If toolType is 'terminal', migrate to claude-code
      // This fixes legacy sessions that were incorrectly saved with toolType='terminal'
      if (aiAgentType === 'terminal') {
        console.warn(`[restoreSession] Session has toolType='terminal', migrating to claude-code`);
        aiAgentType = 'claude-code' as ToolType;
        correctedSession = { ...correctedSession, toolType: 'claude-code' as ToolType };

        // Add warning to the active tab's logs
        const warningLog: LogEntry = {
          id: generateId(),
          timestamp: Date.now(),
          source: 'system',
          text: '⚠️ Session migrated to use Claude Code agent.'
        };
        const activeTabIndex = correctedSession.aiTabs.findIndex(tab => tab.id === correctedSession.activeTabId);
        if (activeTabIndex >= 0) {
          correctedSession.aiTabs = correctedSession.aiTabs.map((tab, i) =>
            i === activeTabIndex ? { ...tab, logs: [...tab.logs, warningLog] } : tab
          );
        }
      }

      // Get agent definitions for both processes
      const agent = await window.maestro.agents.get(aiAgentType);
      if (!agent) {
        console.error(`Agent not found for toolType: ${correctedSession.toolType}`);
        return {
          ...correctedSession,
          aiPid: -1,
          terminalPid: 0,
          state: 'error' as SessionState,
          isLive: false,
          liveUrl: undefined
        };
      }

      // Don't eagerly spawn AI processes on session restore:
      // - Batch mode agents (Claude Code, OpenCode, Codex) spawn per message in useInputProcessing
      // - Terminal uses runCommand (fresh shells per command)
      // This prevents 20+ idle processes when app starts with many saved sessions
      // aiPid stays at 0 until user sends their first message
      const aiSpawnResult = { pid: 0, success: true };
      const aiSuccess = true;

      if (aiSuccess) {
        // Get SSH remote ID for remote git operations
        // Note: sshRemoteId is only set after AI agent spawns. For terminal-only SSH sessions,
        // we must fall back to sessionSshRemoteConfig.remoteId. See CLAUDE.md "SSH Remote Sessions".
        const sshRemoteId = correctedSession.sshRemoteId || correctedSession.sessionSshRemoteConfig?.remoteId || undefined;

        // Check if the working directory is a Git repository (via SSH for remote sessions)
        const isGitRepo = await gitService.isRepo(correctedSession.cwd, sshRemoteId);

        // Fetch git branches and tags if it's a git repo
        let gitBranches: string[] | undefined;
        let gitTags: string[] | undefined;
        let gitRefsCacheTime: number | undefined;
        if (isGitRepo) {
          [gitBranches, gitTags] = await Promise.all([
            gitService.getBranches(correctedSession.cwd, sshRemoteId),
            gitService.getTags(correctedSession.cwd, sshRemoteId)
          ]);
          gitRefsCacheTime = Date.now();
        }

        // Reset all tab states to idle - processes don't survive app restart
        const resetAiTabs = correctedSession.aiTabs.map(tab => ({
          ...tab,
          state: 'idle' as const,
          thinkingStartTime: undefined,
        }));

        // Session restored - no superfluous messages added to AI Terminal or Command Terminal
        return {
          ...correctedSession,
          aiPid: aiSpawnResult.pid,
          terminalPid: 0,  // Terminal uses runCommand (fresh shells per command)
          state: 'idle' as SessionState,
          // Reset runtime-only busy state - processes don't survive app restart
          busySource: undefined,
          thinkingStartTime: undefined,
          currentCycleTokens: undefined,
          currentCycleBytes: undefined,
          statusMessage: undefined,
          isGitRepo,  // Update Git status
          gitBranches,
          gitTags,
          gitRefsCacheTime,
          isLive: false,  // Always start offline on app restart
          liveUrl: undefined,  // Clear any stale URL
          aiLogs: [],  // Deprecated - logs are now in aiTabs
          aiTabs: resetAiTabs,  // Reset tab states
          shellLogs: correctedSession.shellLogs,  // Preserve existing Command Terminal logs
          executionQueue: correctedSession.executionQueue || [],  // Ensure backwards compatibility
          activeTimeMs: correctedSession.activeTimeMs || 0,  // Ensure backwards compatibility
          // Clear runtime-only error state - no agent is running yet so there can't be an error
          agentError: undefined,
          agentErrorPaused: false,
          closedTabHistory: [],  // Runtime-only, reset on load
        };
      } else {
        // Process spawn failed
        console.error(`Failed to restore session ${session.id}`);
        return {
          ...session,
          aiPid: -1,
          terminalPid: 0,
          state: 'error' as SessionState,
          isLive: false,
          liveUrl: undefined
        };
      }
    } catch (error) {
      console.error(`Error restoring session ${session.id}:`, error);
      return {
        ...session,
        aiPid: -1,
        terminalPid: 0,
        state: 'error' as SessionState,
        isLive: false,
        liveUrl: undefined
      };
    }
  };

  // Load sessions and groups from electron-store on mount
  // Use a ref to prevent duplicate execution in React Strict Mode
  const sessionLoadStarted = useRef(false);
  useEffect(() => {
    console.log('[App] Session load useEffect triggered');
    // Guard against duplicate execution in React Strict Mode
    if (sessionLoadStarted.current) {
      console.log('[App] Session load already started, skipping');
      return;
    }
    sessionLoadStarted.current = true;
    console.log('[App] Starting loadSessionsAndGroups');

    const loadSessionsAndGroups = async () => {
      let _hasSessionsLoaded = false;

      try {
        console.log('[App] About to call sessions.getAll()');
        const savedSessions = await window.maestro.sessions.getAll();
        console.log('[App] Got sessions:', savedSessions?.length ?? 0);
        const savedGroups = await window.maestro.groups.getAll();

        // Handle sessions
        if (savedSessions && savedSessions.length > 0) {
          const restoredSessions = await Promise.all(
            savedSessions.map(s => restoreSession(s))
          );
          setSessions(restoredSessions);
          _hasSessionsLoaded = true;
          // Set active session to first session if current activeSessionId is invalid
          if (restoredSessions.length > 0 && !restoredSessions.find(s => s.id === activeSessionId)) {
            setActiveSessionId(restoredSessions[0].id);
          }
        } else {
          setSessions([]);
        }

        // Handle groups
        if (savedGroups && savedGroups.length > 0) {
          setGroups(savedGroups);
        } else {
          setGroups([]);
        }

        // Load group chats
        try {
          const savedGroupChats = await window.maestro.groupChat.list();
          setGroupChats(savedGroupChats || []);
        } catch (gcError) {
          console.error('Failed to load group chats:', gcError);
          setGroupChats([]);
        }
      } catch (e) {
        console.error('Failed to load sessions/groups:', e);
        setSessions([]);
        setGroups([]);
      } finally {
        // Mark initial load as complete to enable persistence
        initialLoadComplete.current = true;

        // Mark sessions as loaded for splash screen coordination
        setSessionsLoaded(true);

        // When no sessions exist, we show EmptyStateView which lets users
        // choose between "New Agent" or "Wizard" - no auto-opening wizard
      }
    };
    loadSessionsAndGroups();
     
  }, []);

  // Hide splash screen only when both settings and sessions have fully loaded
  // This prevents theme flash on initial render
  useEffect(() => {
    console.log('[App] Splash check - settingsLoaded:', settingsLoaded, 'sessionsLoaded:', sessionsLoaded);
    if (settingsLoaded && sessionsLoaded) {
      console.log('[App] Both loaded, hiding splash');
      if (typeof window.__hideSplash === 'function') {
        window.__hideSplash();
      }
    }
  }, [settingsLoaded, sessionsLoaded]);

  // Check GitHub CLI availability for gist publishing
  useEffect(() => {
    window.maestro.git.checkGhCli().then(status => {
      setGhCliAvailable(status.installed && status.authenticated);
    }).catch(() => {
      setGhCliAvailable(false);
    });
  }, []);

  // Expose debug helpers to window for console access
  // No dependency array - always keep functions fresh
  (window as any).__maestroDebug = {
    openDebugWizard: () => setDebugWizardModalOpen(true),
    openCommandK: () => setQuickActionOpen(true),
    openWizard: () => openWizardModal(),
    openSettings: () => setSettingsModalOpen(true),
  };

  // Check for unacknowledged badges on startup (show missed standing ovations)
  useEffect(() => {
    if (settingsLoaded && sessionsLoaded) {
      const unacknowledgedLevel = getUnacknowledgedBadgeLevel();
      if (unacknowledgedLevel !== null) {
        const badge = CONDUCTOR_BADGES.find(b => b.level === unacknowledgedLevel);
        if (badge) {
          // Show the standing ovation overlay for the missed badge
          // Small delay to ensure UI is fully rendered
          setTimeout(() => {
            setStandingOvationData({
              badge,
              isNewRecord: false, // We don't know if it was a record, so default to false
              recordTimeMs: autoRunStats.longestRunMs,
            });
          }, 1000);
        }
      }
    }
  // autoRunStats.longestRunMs and getUnacknowledgedBadgeLevel intentionally omitted -
  // this effect runs once on startup to check for missed badges, not on every stats update
   
  }, [settingsLoaded, sessionsLoaded]);

  // Check for unacknowledged badges when user returns to the app
  // Uses multiple triggers: visibility change, window focus, and mouse activity
  // This catches badges earned during overnight Auto Runs when display was off
  useEffect(() => {
    if (!settingsLoaded || !sessionsLoaded) return;

    // Debounce to avoid showing multiple times
    let checkPending = false;

    const checkForUnacknowledgedBadge = () => {
      // Don't show if there's already an ovation displayed
      if (standingOvationData) return;
      if (checkPending) return;

      const unacknowledgedLevel = getUnacknowledgedBadgeLevel();
      if (unacknowledgedLevel !== null) {
        const badge = CONDUCTOR_BADGES.find(b => b.level === unacknowledgedLevel);
        if (badge) {
          checkPending = true;
          // Small delay to let the UI stabilize
          setTimeout(() => {
            // Double-check in case it was acknowledged in the meantime
            if (!standingOvationData) {
              setStandingOvationData({
                badge,
                isNewRecord: false,
                recordTimeMs: autoRunStats.longestRunMs,
              });
            }
            checkPending = false;
          }, 500);
        }
      }
    };

    const handleVisibilityChange = () => {
      // Only check when becoming visible
      if (!document.hidden) {
        checkForUnacknowledgedBadge();
      }
    };

    const handleWindowFocus = () => {
      // Window gained focus - user is actively looking at the app
      checkForUnacknowledgedBadge();
    };

    // Mouse move handler with heavy debounce - only triggers once per 30 seconds
    let lastMouseCheck = 0;
    const handleMouseMove = () => {
      const now = Date.now();
      if (now - lastMouseCheck > 30000) { // 30 second debounce
        lastMouseCheck = now;
        checkForUnacknowledgedBadge();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleWindowFocus);
    document.addEventListener('mousemove', handleMouseMove, { passive: true });

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleWindowFocus);
      document.removeEventListener('mousemove', handleMouseMove);
    };
  }, [settingsLoaded, sessionsLoaded, standingOvationData, getUnacknowledgedBadgeLevel, autoRunStats.longestRunMs]);

  // Check for unacknowledged keyboard mastery levels on startup
  useEffect(() => {
    if (settingsLoaded && sessionsLoaded) {
      const unacknowledgedLevel = getUnacknowledgedKeyboardMasteryLevel();
      if (unacknowledgedLevel !== null) {
        // Show the keyboard mastery level-up celebration after a short delay
        setTimeout(() => {
          setPendingKeyboardMasteryLevel(unacknowledgedLevel);
        }, 1200); // Slightly longer delay than badge to avoid overlap
      }
    }
  // getUnacknowledgedKeyboardMasteryLevel intentionally omitted -
  // this effect runs once on startup to check for unacknowledged levels, not on function changes
   
  }, [settingsLoaded, sessionsLoaded]);

  // Scan worktree directories on startup for sessions with worktreeConfig
  // This restores worktree sub-agents after app restart
  useEffect(() => {
    if (!sessionsLoaded) return;

    const scanWorktreeConfigsOnStartup = async () => {
      // Find sessions that have worktreeConfig with basePath
      const sessionsWithWorktreeConfig = sessions.filter(s =>
        s.worktreeConfig?.basePath && !s.parentSessionId // Only parent sessions
      );

      if (sessionsWithWorktreeConfig.length === 0) return;

      const newWorktreeSessions: Session[] = [];

      for (const parentSession of sessionsWithWorktreeConfig) {
        try {
          // Get SSH remote ID for remote git operations
          const sshRemoteId = parentSession.sshRemoteId || parentSession.sessionSshRemoteConfig?.remoteId || undefined;
          const scanResult = await window.maestro.git.scanWorktreeDirectory(parentSession.worktreeConfig!.basePath, sshRemoteId);
          const { gitSubdirs } = scanResult;

          for (const subdir of gitSubdirs) {
            // Skip main/master/HEAD branches
            if (subdir.branch === 'main' || subdir.branch === 'master' || subdir.branch === 'HEAD') {
              continue;
            }

            // Check if a session already exists for this worktree
            // Normalize paths for comparison (remove trailing slashes)
            const normalizedSubdirPath = subdir.path.replace(/\/+$/, '');
            const existingSession = sessions.find(s => {
              const normalizedCwd = s.cwd.replace(/\/+$/, '');
              // Check if same path (regardless of parent) or same branch under same parent
              return normalizedCwd === normalizedSubdirPath ||
                (s.parentSessionId === parentSession.id && s.worktreeBranch === subdir.branch);
            });
            if (existingSession) {
              continue;
            }

            // Also check in sessions we're about to add
            if (newWorktreeSessions.some(s => s.cwd.replace(/\/+$/, '') === normalizedSubdirPath)) {
              continue;
            }

            const newId = generateId();
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
              saveToHistory: true
            };

            // Fetch git info (via SSH for remote sessions)
            let gitBranches: string[] | undefined;
            let gitTags: string[] | undefined;
            let gitRefsCacheTime: number | undefined;

            try {
              [gitBranches, gitTags] = await Promise.all([
                gitService.getBranches(subdir.path, sshRemoteId),
                gitService.getTags(subdir.path, sshRemoteId)
              ]);
              gitRefsCacheTime = Date.now();
            } catch {
              // Ignore errors
            }

            const worktreeSession: Session = {
              id: newId,
              name: subdir.branch || subdir.name,
              groupId: parentSession.groupId,  // Inherit group from parent
              toolType: parentSession.toolType,
              state: 'idle',
              cwd: subdir.path,
              fullPath: subdir.path,
              projectRoot: subdir.path,
              isGitRepo: true,
              gitBranches,
              gitTags,
              gitRefsCacheTime,
              parentSessionId: parentSession.id,
              worktreeBranch: subdir.branch || undefined,
              aiLogs: [],
              shellLogs: [{ id: generateId(), timestamp: Date.now(), source: 'system', text: 'Worktree Session Ready.' }],
              workLog: [],
              contextUsage: 0,
              inputMode: parentSession.toolType === 'terminal' ? 'terminal' : 'ai',
              aiPid: 0,
              terminalPid: 0,
              port: 3000 + Math.floor(Math.random() * 100),
              isLive: false,
              changedFiles: [],
              fileTree: [],
              fileExplorerExpanded: [],
              fileExplorerScrollPos: 0,
              fileTreeAutoRefreshInterval: 180,
              shellCwd: subdir.path,
              aiCommandHistory: [],
              shellCommandHistory: [],
              executionQueue: [],
              activeTimeMs: 0,
              aiTabs: [initialTab],
              activeTabId: initialTabId,
              closedTabHistory: [],
              customPath: parentSession.customPath,
              customArgs: parentSession.customArgs,
              customEnvVars: parentSession.customEnvVars,
              customModel: parentSession.customModel,
              customContextWindow: parentSession.customContextWindow,
              nudgeMessage: parentSession.nudgeMessage,
              autoRunFolderPath: parentSession.autoRunFolderPath,
              // Inherit SSH configuration from parent session
              sessionSshRemoteConfig: parentSession.sessionSshRemoteConfig,
            };

            newWorktreeSessions.push(worktreeSession);
          }
        } catch (err) {
          console.error(`[WorktreeStartup] Error scanning ${parentSession.worktreeConfig!.basePath}:`, err);
        }
      }

      if (newWorktreeSessions.length > 0) {
        setSessions(prev => {
          // Double-check to avoid duplicates
          const currentPaths = new Set(prev.map(s => s.cwd));
          const trulyNew = newWorktreeSessions.filter(s => !currentPaths.has(s.cwd));
          if (trulyNew.length === 0) return prev;
          return [...prev, ...trulyNew];
        });

        // Expand worktrees on parent sessions
        const parentIds = new Set(newWorktreeSessions.map(s => s.parentSessionId));
        setSessions(prev => prev.map(s =>
          parentIds.has(s.id) ? { ...s, worktreesExpanded: true } : s
        ));
      }
    };

    // Run once on startup with a small delay to let UI settle
    const timer = setTimeout(scanWorktreeConfigsOnStartup, 500);
    return () => clearTimeout(timer);
   
  }, [sessionsLoaded]); // Only run once when sessions are loaded

  // Sync beta updates setting to electron-updater when it changes
  useEffect(() => {
    if (settingsLoaded) {
      window.maestro.updates.setAllowPrerelease(enableBetaUpdates);
    }
  }, [settingsLoaded, enableBetaUpdates]);

  // Check for updates on startup if enabled
  useEffect(() => {
    if (settingsLoaded && checkForUpdatesOnStartup) {
      // Delay to let the app fully initialize
      const timer = setTimeout(async () => {
        try {
          const result = await window.maestro.updates.check(enableBetaUpdates);
          if (result.updateAvailable && !result.error) {
            setUpdateCheckModalOpen(true);
          }
        } catch (error) {
          console.error('Failed to check for updates on startup:', error);
        }
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [settingsLoaded, checkForUpdatesOnStartup, enableBetaUpdates]);

  // Load spec-kit commands on startup
  useEffect(() => {
    const loadSpeckitCommands = async () => {
      try {
        const commands = await getSpeckitCommands();
        setSpeckitCommands(commands);
      } catch (error) {
        console.error('[SpecKit] Failed to load commands:', error);
      }
    };
    loadSpeckitCommands();
  }, []);

  // Load OpenSpec commands on startup
  useEffect(() => {
    const loadOpenspecCommands = async () => {
      try {
        const commands = await getOpenSpecCommands();
        setOpenspecCommands(commands);
      } catch (error) {
        console.error('[OpenSpec] Failed to load commands:', error);
      }
    };
    loadOpenspecCommands();
  }, []);

  // Set up process event listeners for real-time output
  useEffect(() => {
    // Copy ref value to local variable for cleanup (React ESLint rule)
    const thinkingChunkBuffer = thinkingChunkBufferRef.current;

    // Handle process output data (BATCHED for performance)
    // sessionId will be in format: "{id}-ai-{tabId}", "{id}-terminal", "{id}-batch-{timestamp}", etc.
    const unsubscribeData = window.maestro.process.onData((sessionId: string, data: string) => {
      // Parse sessionId to determine which process this is from
      let actualSessionId: string;
      let isFromAi: boolean;
      let tabIdFromSession: string | undefined;

      // Format: sessionId-ai-tabId
      const aiTabMatch = sessionId.match(/^(.+)-ai-(.+)$/);
      if (aiTabMatch) {
        actualSessionId = aiTabMatch[1];
        tabIdFromSession = aiTabMatch[2];
        isFromAi = true;
      } else if (sessionId.endsWith('-terminal')) {
        // Ignore PTY terminal output - we use runCommand for terminal commands,
        // which emits data with plain session ID (not -terminal suffix)
        return;
      } else if (sessionId.includes('-batch-')) {
        // Ignore batch task output - these are handled separately by spawnAgentForSession
        // and their output goes to history entries, not to the AI terminal
        return;
      } else {
        // Plain session ID = output from runCommand (terminal commands)
        actualSessionId = sessionId;
        isFromAi = false;
      }

      // Filter out empty stdout for terminal commands (AI output should pass through)
      if (!isFromAi && !data.trim()) return;

      // For terminal output, use batched append to shell logs
      if (!isFromAi) {
        batchedUpdater.appendLog(actualSessionId, null, false, data);
        return;
      }

      // For AI output, determine target tab ID
      // Priority: 1) tab ID from session ID (most reliable), 2) busy tab, 3) active tab
      let targetTabId = tabIdFromSession;
      if (!targetTabId) {
        // Fallback: look up session from ref to find busy/active tab
        const session = sessionsRef.current.find(s => s.id === actualSessionId);
        if (session) {
          const targetTab = getWriteModeTab(session) || getActiveTab(session);
          if (targetTab) {
            targetTabId = targetTab.id;
          }
        }
      }

      if (!targetTabId) {
        console.error('[onData] No target tab found - session has no aiTabs, this should not happen');
        return;
      }

      // Batch the log append, delivery mark, unread mark, and byte tracking
      batchedUpdater.appendLog(actualSessionId, targetTabId, true, data);
      batchedUpdater.markDelivered(actualSessionId, targetTabId);
      batchedUpdater.updateCycleBytes(actualSessionId, data.length);

      // Clear error state if session had an error but is now receiving successful data
      // This indicates the user fixed the issue (e.g., re-authenticated) and the agent is working
      const sessionForErrorCheck = sessionsRef.current.find(s => s.id === actualSessionId);
      if (sessionForErrorCheck?.agentError) {
        setSessions(prev => prev.map(s => {
          if (s.id !== actualSessionId) return s;
          // Clear error from session and the specific tab
          const updatedAiTabs = s.aiTabs.map(tab =>
            tab.id === targetTabId ? { ...tab, agentError: undefined } : tab
          );
          return {
            ...s,
            agentError: undefined,
            agentErrorTabId: undefined,
            agentErrorPaused: false,
            state: 'busy' as SessionState, // Keep busy since we're receiving data
            aiTabs: updatedAiTabs,
          };
        }));
        // Notify main process to clear error state
        window.maestro.agentError.clearError(actualSessionId).catch(err => {
          console.error('Failed to clear agent error on successful data:', err);
        });
      }

      // Determine if tab should be marked as unread
      // Mark as unread if user hasn't seen the new message:
      // - The tab is not the active tab in this session, OR
      // - The session is not the active session, OR
      // - The user has scrolled up (not at bottom)
      const session = sessionsRef.current.find(s => s.id === actualSessionId);
      if (session) {
        const targetTab = session.aiTabs?.find(t => t.id === targetTabId);
        if (targetTab) {
          const isTargetTabActive = targetTab.id === session.activeTabId;
          const isThisSessionActive = session.id === activeSessionIdRef.current;
          const isUserAtBottom = targetTab.isAtBottom !== false; // Default to true if undefined
          const shouldMarkUnread = !isTargetTabActive || !isThisSessionActive || !isUserAtBottom;
          batchedUpdater.markUnread(actualSessionId, targetTabId, shouldMarkUnread);
        }
      }
    });

    // Handle process exit
    const unsubscribeExit = window.maestro.process.onExit(async (sessionId: string, code: number) => {
      // Log all exit events to help diagnose thinking pill disappearing prematurely
      console.log('[onExit] Process exit event received:', {
        rawSessionId: sessionId,
        exitCode: code,
        timestamp: new Date().toISOString()
      });

      // Parse sessionId to determine which process exited
      // Format: {id}-ai-{tabId}, {id}-terminal, {id}-batch-{timestamp}
      let actualSessionId: string;
      let isFromAi: boolean;
      let tabIdFromSession: string | undefined;

      // Format: sessionId-ai-tabId
      const aiTabMatch = sessionId.match(/^(.+)-ai-(.+)$/);
      if (aiTabMatch) {
        actualSessionId = aiTabMatch[1];
        tabIdFromSession = aiTabMatch[2];
        isFromAi = true;
      } else if (sessionId.endsWith('-terminal')) {
        actualSessionId = sessionId.slice(0, -9);
        isFromAi = false;
      } else if (sessionId.includes('-batch-')) {
        // Ignore batch task exits - handled separately by spawnAgentForSession's own listener
        return;
      } else {
        actualSessionId = sessionId;
        isFromAi = false;
      }

      // SAFETY CHECK: Verify the process is actually gone before transitioning to idle
      // This prevents the thinking pill from disappearing while the process is still running
      // (which can happen if we receive a stale/duplicate exit event)
      if (isFromAi) {
        try {
          const activeProcesses = await window.maestro.process.getActiveProcesses();
          const processStillRunning = activeProcesses.some(p => p.sessionId === sessionId);
          if (processStillRunning) {
            console.warn('[onExit] Process still running despite exit event, ignoring:', {
              sessionId,
              activeProcesses: activeProcesses.map(p => p.sessionId)
            });
            return;
          }
        } catch (error) {
          console.error('[onExit] Failed to verify process status:', error);
          // Continue with exit handling if we can't verify - better than getting stuck
        }
      }

      // For AI exits, gather toast data BEFORE state update to avoid side effects in updater
      // React 18 StrictMode may call state updater functions multiple times
      let toastData: {
        title: string;
        summary: string;
        groupName: string;
        projectName: string;
        duration: number;
        agentSessionId?: string;
        tabName?: string;
        usageStats?: UsageStats;
        prompt?: string;
        response?: string;
        sessionSizeKB?: string;
        sessionId?: string; // Maestro session ID for toast navigation
        tabId?: string; // Tab ID for toast navigation
        // Stats tracking fields
        agentType?: string;
        projectPath?: string;
        startTime?: number;
        isRemote?: boolean; // Whether this was an SSH remote session
      } | null = null;
      let queuedItemToProcess: { sessionId: string; item: QueuedItem } | null = null;
      // Track if we need to run synopsis after completion (for /commit and other AI commands)
      let synopsisData: { sessionId: string; cwd: string; agentSessionId: string; command: string; groupName: string; projectName: string; tabName?: string; tabId?: string; lastSynopsisTime?: number; toolType?: ToolType; sessionConfig?: { customPath?: string; customArgs?: string; customEnvVars?: Record<string, string>; customModel?: string; customContextWindow?: number; } } | null = null;

      if (isFromAi) {
        const currentSession = sessionsRef.current.find(s => s.id === actualSessionId);
        if (currentSession) {
          // Check if there are queued items to process next
          // We still want to show a toast for this tab's completion even if other tabs have work queued
          // BUT don't process queue if there's an active error - wait for error resolution
          if (currentSession.executionQueue.length > 0 && !(currentSession.state === 'error' && currentSession.agentError)) {
            queuedItemToProcess = {
              sessionId: actualSessionId,
              item: currentSession.executionQueue[0]
            };
          }

          // Gather toast notification data for the completed tab
          // Show toast regardless of queue state - each tab completion deserves notification
          // Use the SPECIFIC tab that just completed (from tabIdFromSession), NOT the active tab
          // This is critical for parallel tab execution where multiple tabs complete independently
          const completedTab = tabIdFromSession
            ? currentSession.aiTabs?.find(tab => tab.id === tabIdFromSession)
            : getActiveTab(currentSession);
          const logs = completedTab?.logs || [];
          const lastUserLog = logs.filter(log => log.source === 'user').pop();
          // Find last AI response: 'stdout' or 'ai' source (note: 'thinking' logs are already excluded since they have a distinct source type)
          const lastAiLog = logs.filter(log => log.source === 'stdout' || log.source === 'ai').pop();
          // Use the completed tab's thinkingStartTime for accurate per-tab duration
          const completedTabData = currentSession.aiTabs?.find(tab => tab.id === tabIdFromSession);
          const duration = completedTabData?.thinkingStartTime
            ? Date.now() - completedTabData.thinkingStartTime
            : (currentSession.thinkingStartTime ? Date.now() - currentSession.thinkingStartTime : 0);

          // Calculate session size in bytes for debugging context issues
          const sessionSizeBytes = logs.reduce((sum, log) => sum + (log.text?.length || 0), 0);
          const sessionSizeKB = (sessionSizeBytes / 1024).toFixed(1);

          // Get group name for this session (sessions have groupId, groups have id)
          const sessionGroup = currentSession.groupId
            ? groupsRef.current.find((g: any) => g.id === currentSession.groupId)
            : null;
          const groupName = sessionGroup?.name || 'Ungrouped';
          const projectName = currentSession.name || currentSession.cwd.split('/').pop() || 'Unknown';

          // Create title from user's request (truncated)
          let title = 'Task Complete';
          if (lastUserLog?.text) {
            const userText = lastUserLog.text.trim();
            title = userText.length > 50 ? userText.substring(0, 47) + '...' : userText;
          }

          // Create a short summary from the last AI response
          let summary = '';
          if (lastAiLog?.text) {
            const text = lastAiLog.text.trim();
            if (text.length > 10) {
              const firstSentence = text.match(/^[^.!?\n]*[.!?]/)?.[0] || text.substring(0, 120);
              summary = firstSentence.length < text.length ? firstSentence : text.substring(0, 120) + (text.length > 120 ? '...' : '');
            }
          }
          if (!summary) {
            summary = 'Completed successfully';
          }

          // Get the completed tab's agentSessionId for traceability
          const agentSessionId = completedTab?.agentSessionId || currentSession.agentSessionId;
          // Get tab name: prefer tab's name, fallback to short UUID from agentSessionId
          const tabName = completedTab?.name || (agentSessionId ? agentSessionId.substring(0, 8).toUpperCase() : undefined);

          toastData = {
            title,
            summary,
            groupName,
            projectName,
            duration,
            agentSessionId: agentSessionId || undefined,
            tabName,
            usageStats: currentSession.usageStats,
            prompt: lastUserLog?.text,
            response: lastAiLog?.text,
            sessionSizeKB,
            sessionId: actualSessionId, // For toast navigation
            tabId: completedTab?.id, // For toast navigation to specific tab
            // Stats tracking fields
            agentType: currentSession.toolType,
            projectPath: currentSession.cwd,
            startTime: completedTabData?.thinkingStartTime || currentSession.thinkingStartTime,
            // SSH remote session tracking: check both sshRemoteId (set after spawn) and sessionSshRemoteConfig (set before spawn)
            isRemote: !!(currentSession.sshRemoteId || currentSession.sessionSshRemoteConfig?.enabled),
          };

          // Check if synopsis should be triggered:
          // 1. Tab has saveToHistory enabled, OR
          // 2. This was a custom AI command (pendingAICommandForSynopsis)
          // Only trigger when queue is empty (final task complete) and we have a agentSessionId
          const shouldSynopsis = currentSession.executionQueue.length === 0 &&
            (completedTab?.agentSessionId || currentSession.agentSessionId) &&
            (completedTab?.saveToHistory || currentSession.pendingAICommandForSynopsis);

          if (shouldSynopsis) {
            synopsisData = {
              sessionId: actualSessionId,
              cwd: currentSession.cwd,
              agentSessionId: completedTab?.agentSessionId || currentSession.agentSessionId!,
              command: currentSession.pendingAICommandForSynopsis || 'Save to History',
              groupName,
              projectName,
              tabName,
              tabId: completedTab?.id,
              lastSynopsisTime: completedTab?.lastSynopsisTime, // Track when last synopsis was generated
              toolType: currentSession.toolType, // Pass tool type for multi-provider support
              sessionConfig: {
                customPath: currentSession.customPath,
                customArgs: currentSession.customArgs,
                customEnvVars: currentSession.customEnvVars,
                customModel: currentSession.customModel,
                customContextWindow: currentSession.customContextWindow,
              }
            };
          }
        }
      }

      // Update state (pure function - no side effects)
      setSessions(prev => prev.map(s => {
        if (s.id !== actualSessionId) return s;

        if (isFromAi) {
          // Don't process queue if session is in error state - preserve error
          // Queue will be processed after error is resolved
          if (s.state === 'error' && s.agentError) {
            // Set the specific tab to idle but preserve session error state
            const updatedAiTabs = s.aiTabs?.length > 0
              ? s.aiTabs.map(tab => {
                  if (tabIdFromSession) {
                    return tab.id === tabIdFromSession ? { ...tab, state: 'idle' as const, thinkingStartTime: undefined } : tab;
                  } else {
                    return tab.state === 'busy' ? { ...tab, state: 'idle' as const, thinkingStartTime: undefined } : tab;
                  }
                })
              : s.aiTabs;

            return {
              ...s,
              state: 'error' as SessionState,  // Preserve error state
              busySource: undefined,
              thinkingStartTime: undefined,
              aiTabs: updatedAiTabs
            };
          }

          // Check if there are queued items in the execution queue
          if (s.executionQueue.length > 0) {
            const [nextItem, ...remainingQueue] = s.executionQueue;

            // Determine which tab this item belongs to
            const targetTab = s.aiTabs.find(tab => tab.id === nextItem.tabId) || getActiveTab(s);

            if (!targetTab) {
              // Fallback: no tabs exist, just update the queue
              return {
                ...s,
                state: 'busy' as SessionState,
                busySource: 'ai',
                executionQueue: remainingQueue,
                thinkingStartTime: Date.now(),
                currentCycleTokens: 0,
                currentCycleBytes: 0
              };
            }

            // IMPORTANT: Set the ORIGINAL tab (that just finished) to idle,
            // UNLESS it's also the target tab for the next queued item.
            // Also set target tab to 'busy' so thinking pill can find it via getWriteModeTab()
            let updatedAiTabs = s.aiTabs.map(tab => {
              // If this tab is the target for the next queued item, set it to busy
              // (takes priority over setting to idle, even if it's the same tab that just finished)
              if (tab.id === targetTab.id) {
                return { ...tab, state: 'busy' as const, thinkingStartTime: Date.now() };
              }
              // Set the original tab (that just finished) to idle, but only if it's different from target
              if (tabIdFromSession && tab.id === tabIdFromSession) {
                return { ...tab, state: 'idle' as const };
              }
              return tab;
            });

            // For message items, add a log entry to the target tab
            // For command items, the log entry will be added when the command is processed
            if (nextItem.type === 'message' && nextItem.text) {
              const logEntry: LogEntry = {
                id: generateId(),
                timestamp: Date.now(),
                source: 'user',
                text: nextItem.text,
                images: nextItem.images
              };
              updatedAiTabs = updatedAiTabs.map(tab =>
                tab.id === targetTab.id
                  ? { ...tab, logs: [...tab.logs, logEntry] }
                  : tab
              );
            }

            // NOTE: Do NOT switch activeTabId - let user control tab switching
            // The queued message processes in the background on its target tab
            return {
              ...s,
              state: 'busy' as SessionState,
              busySource: 'ai',
              aiTabs: updatedAiTabs,
              // activeTabId stays unchanged - user controls tab switching
              executionQueue: remainingQueue,
              thinkingStartTime: Date.now(),
              currentCycleTokens: 0,
              currentCycleBytes: 0
            };
          }

          // Task complete - set the specific tab to 'idle' for write-mode tracking
          // Use tabIdFromSession if available (new format), otherwise set all busy tabs to idle (legacy)
          const updatedAiTabs = s.aiTabs?.length > 0
            ? s.aiTabs.map(tab => {
                if (tabIdFromSession) {
                  // New format: only update the specific tab
                  return tab.id === tabIdFromSession ? { ...tab, state: 'idle' as const, thinkingStartTime: undefined } : tab;
                } else {
                  // Legacy format: update all busy tabs
                  return tab.state === 'busy' ? { ...tab, state: 'idle' as const, thinkingStartTime: undefined } : tab;
                }
              })
            : s.aiTabs;

          // Check if ANY other tabs are still busy (for parallel read-only execution)
          // Only set session to idle if no tabs are busy
          // IMPORTANT: Preserve 'error' state if session has an active agentError - don't overwrite with 'idle'
          const anyTabStillBusy = updatedAiTabs.some(tab => tab.state === 'busy');
          const newState = s.state === 'error' && s.agentError
            ? 'error' as SessionState  // Preserve error state
            : (anyTabStillBusy ? 'busy' as SessionState : 'idle' as SessionState);
          const newBusySource = anyTabStillBusy ? s.busySource : undefined;

          // Log state transition for debugging thinking pill issues
          console.log('[onExit] Session state transition:', {
            sessionId: s.id.substring(0, 8),
            tabIdFromSession: tabIdFromSession?.substring(0, 8),
            previousState: s.state,
            newState,
            previousBusySource: s.busySource,
            newBusySource,
            anyTabStillBusy,
            tabStates: updatedAiTabs.map(t => ({ id: t.id.substring(0, 8), state: t.state }))
          });

          // Task complete - also clear pending AI command flag
          return {
            ...s,
            state: newState,
            busySource: newBusySource,
            thinkingStartTime: anyTabStillBusy ? s.thinkingStartTime : undefined,
            pendingAICommandForSynopsis: undefined,
            aiTabs: updatedAiTabs
          };
        }

        // Terminal exit - show exit code
        const exitLog: LogEntry = {
          id: generateId(),
          timestamp: Date.now(),
          source: 'system',
          text: `Terminal process exited with code ${code}`
        };

        // Check if any AI tabs are still busy - don't clear session state if so
        const anyAiTabBusy = s.aiTabs?.some(tab => tab.state === 'busy') || false;

        return {
          ...s,
          // Only clear session state if no AI tabs are busy
          state: anyAiTabBusy ? s.state : 'idle' as SessionState,
          busySource: anyAiTabBusy ? s.busySource : undefined,
          shellLogs: [...s.shellLogs, exitLog]
        };
      }));

      // Refresh git branches/tags after terminal command completes in git repos
      // Check if the last command was a git command that might modify refs
      if (!isFromAi) {
        const currentSession = sessionsRef.current.find(s => s.id === actualSessionId);
        if (currentSession?.isGitRepo) {
          // Get the last user command from shell logs
          const userLogs = currentSession.shellLogs.filter(log => log.source === 'user');
          const lastCommand = userLogs[userLogs.length - 1]?.text?.trim().toLowerCase() || '';

          // Refresh refs if command might have modified them
          const gitRefCommands = ['git branch', 'git checkout', 'git switch', 'git fetch', 'git pull', 'git tag', 'git merge', 'git rebase', 'git reset'];
          const shouldRefresh = gitRefCommands.some(cmd => lastCommand.startsWith(cmd));

          if (shouldRefresh) {
            (async () => {
              const sshRemoteId = currentSession.sshRemoteId || currentSession.sessionSshRemoteConfig?.remoteId || undefined;
              const [gitBranches, gitTags] = await Promise.all([
                gitService.getBranches(currentSession.cwd, sshRemoteId),
                gitService.getTags(currentSession.cwd, sshRemoteId)
              ]);
              setSessions(prev => prev.map(s =>
                s.id === actualSessionId
                  ? { ...s, gitBranches, gitTags, gitRefsCacheTime: Date.now() }
                  : s
              ));
            })();
          }
        }
      }

      // Fire side effects AFTER state update (outside the updater function)
      // Record stats for any completed query (even if we have queued items to process next)
      if (toastData?.startTime && toastData?.agentType) {
        window.maestro.stats.recordQuery({
          sessionId: toastData.sessionId || actualSessionId,
          agentType: toastData.agentType,
          source: 'user', // Interactive queries are always user-initiated
          startTime: toastData.startTime,
          duration: toastData.duration,
          projectPath: toastData.projectPath,
          tabId: toastData.tabId,
          isRemote: toastData.isRemote,
        }).catch(err => {
          // Don't fail the completion flow if stats recording fails
          console.warn('[onProcessExit] Failed to record query stats:', err);
        });
      }

      if (queuedItemToProcess) {
        setTimeout(() => {
          processQueuedItem(queuedItemToProcess!.sessionId, queuedItemToProcess!.item);
        }, 0);
      } else if (toastData) {
        setTimeout(() => {
          // Log agent completion for debugging and traceability
          window.maestro.logger.log('info', 'Agent process completed', 'App', {
            agentSessionId: toastData!.agentSessionId,
            group: toastData!.groupName,
            project: toastData!.projectName,
            durationMs: toastData!.duration,
            sessionSizeKB: toastData!.sessionSizeKB,
            prompt: toastData!.prompt?.substring(0, 200) + (toastData!.prompt && toastData!.prompt.length > 200 ? '...' : ''),
            response: toastData!.response?.substring(0, 500) + (toastData!.response && toastData!.response.length > 500 ? '...' : ''),
            inputTokens: toastData!.usageStats?.inputTokens,
            outputTokens: toastData!.usageStats?.outputTokens,
            cacheReadTokens: toastData!.usageStats?.cacheReadInputTokens,
            totalCostUsd: toastData!.usageStats?.totalCostUsd,
          });

          // Suppress toast if user is already viewing this tab (they'll see the response directly)
          // Only show toasts for out-of-view completions (different session or different tab)
          const currentActiveSession = sessionsRef.current.find(s => s.id === activeSessionIdRef.current);
          const isViewingCompletedTab = currentActiveSession?.id === actualSessionId
            && (!tabIdFromSession || currentActiveSession.activeTabId === tabIdFromSession);

          if (!isViewingCompletedTab) {
            addToastRef.current({
              type: 'success',
              title: toastData!.title,
              message: toastData!.summary,
              group: toastData!.groupName,
              project: toastData!.projectName,
              taskDuration: toastData!.duration,
              agentSessionId: toastData!.agentSessionId,
              tabName: toastData!.tabName,
              sessionId: toastData!.sessionId,
              tabId: toastData!.tabId,
            });
          }
        }, 0);
      }

      // Run synopsis in parallel if this was a custom AI command (like /commit)
      // This creates a USER history entry to track the work
      if (synopsisData && spawnBackgroundSynopsisRef.current && addHistoryEntryRef.current) {
        // Build dynamic prompt based on whether there's a previous synopsis timestamp
        // This ensures the AI only summarizes work since the last synopsis
        let SYNOPSIS_PROMPT: string;
        if (synopsisData.lastSynopsisTime) {
          const timeAgo = formatRelativeTime(synopsisData.lastSynopsisTime);
          SYNOPSIS_PROMPT = `Synopsize ONLY the work done since the last synopsis (${timeAgo}). Do not repeat previous work. 2-3 sentences max.`;
        } else {
          SYNOPSIS_PROMPT = 'Synopsize our recent work in 2-3 sentences max since the last time we did a synopsis.';
        }
        const startTime = Date.now();
        const synopsisTime = Date.now(); // Capture time for updating lastSynopsisTime

        spawnBackgroundSynopsisRef.current(
          synopsisData.sessionId,
          synopsisData.cwd,
          synopsisData.agentSessionId,
          SYNOPSIS_PROMPT,
          synopsisData.toolType, // Pass tool type for multi-provider support
          synopsisData.sessionConfig // Pass session config for custom env vars, args, etc.
        ).then(result => {
          const duration = Date.now() - startTime;
          if (result.success && result.response && addHistoryEntryRef.current) {
            // IMPORTANT: Pass explicit sessionId and projectPath to prevent cross-agent bleed
            // when user switches agents while synopsis is running in background
            addHistoryEntryRef.current({
              type: 'USER',
              summary: result.response,
              agentSessionId: synopsisData!.agentSessionId,
              usageStats: result.usageStats,
              sessionId: synopsisData!.sessionId,
              projectPath: synopsisData!.cwd,
              sessionName: synopsisData!.tabName,
            });

            // Update lastSynopsisTime on the tab so future synopses know the time window
            setSessions(prev => prev.map(s => {
              if (s.id !== synopsisData!.sessionId) return s;
              return {
                ...s,
                aiTabs: s.aiTabs.map(tab => {
                  if (tab.id !== synopsisData!.tabId) return tab;
                  return { ...tab, lastSynopsisTime: synopsisTime };
                }),
              };
            }));

            // Show toast for synopsis completion
            addToastRef.current({
              type: 'info',
              title: 'Synopsis',
              message: result.response,
              group: synopsisData!.groupName,
              project: synopsisData!.projectName,
              taskDuration: duration,
              sessionId: synopsisData!.sessionId,
              tabId: synopsisData!.tabId,
              tabName: synopsisData!.tabName,
            });

            // Refresh history panel if available
            if (rightPanelRef.current) {
              rightPanelRef.current.refreshHistoryPanel();
            }
          } else if (!result.success) {
            console.warn('[onProcessExit] Synopsis generation failed - no history entry created', {
              sessionId: synopsisData!.sessionId,
              agentSessionId: synopsisData!.agentSessionId,
              hasResponse: !!result.response,
            });
          }
        }).catch(err => {
          console.error('[onProcessExit] Synopsis failed:', err);
        });
      }
    });

    // Handle Claude session ID capture for interactive sessions only
    const unsubscribeSessionId = window.maestro.process.onSessionId(async (sessionId: string, agentSessionId: string) => {
      // Ignore batch sessions - they have their own isolated session IDs that should NOT
      // contaminate the interactive session's agentSessionId
      if (sessionId.includes('-batch-')) {
        return;
      }

      // Parse sessionId to get actual session ID and tab ID
      // Format: ${sessionId}-ai-${tabId}
      let actualSessionId: string;
      let tabId: string | undefined;

      const aiTabMatch = sessionId.match(/^(.+)-ai-(.+)$/);
      if (aiTabMatch) {
        actualSessionId = aiTabMatch[1];
        tabId = aiTabMatch[2];
      } else {
        actualSessionId = sessionId;
      }

      // Store Claude session ID in session state
      // Note: slash commands are now received via onSlashCommands from Claude Code's init message
      setSessions(prev => {
        const session = prev.find(s => s.id === actualSessionId);
        if (!session) return prev;

        // Register this as a user-initiated Maestro session (batch sessions are filtered above)
        // Do NOT pass session name - names should only be set when user explicitly renames
        // Use projectRoot (not cwd) for consistent session storage access
        window.maestro.agentSessions.registerSessionOrigin(session.projectRoot, agentSessionId, 'user')
          .catch(err => console.error('[onSessionId] Failed to register session origin:', err));

        return prev.map(s => {
          if (s.id !== actualSessionId) return s;

          // Find the target tab - use explicit tab ID from session ID if available
          // This ensures each process's session ID goes to the correct tab
          let targetTab;
          if (tabId) {
            // New format: tab ID is encoded in session ID
            targetTab = s.aiTabs?.find(tab => tab.id === tabId);
          }

          // Fallback: find awaiting tab or active tab (for legacy format)
          if (!targetTab) {
            const awaitingTab = s.aiTabs?.find(tab => tab.awaitingSessionId && !tab.agentSessionId);
            targetTab = awaitingTab || getActiveTab(s);
          }

          if (!targetTab) {
            // No tabs exist - this is a bug, sessions must have aiTabs
            // Still store at session-level for web API compatibility
            console.error('[onSessionId] No target tab found - session has no aiTabs, storing at session level only');
            return { ...s, agentSessionId };
          }

          // Skip if this tab already has a agentSessionId (prevent overwriting)
          if (targetTab.agentSessionId && targetTab.agentSessionId !== agentSessionId) {
            return s;
          }

          // Update the target tab's agentSessionId and clear awaitingSessionId flag
          // Keep name as null for auto-generated display (derived from agentSessionId)
          const updatedAiTabs = s.aiTabs.map(tab => {
            if (tab.id !== targetTab.id) return tab;
            // Only preserve existing custom name, don't auto-set to UUID
            const newName = (tab.name && tab.name !== 'New Session') ? tab.name : null;
            return { ...tab, agentSessionId, awaitingSessionId: false, name: newName };
          });

          return { ...s, aiTabs: updatedAiTabs, agentSessionId }; // Also keep session-level for backwards compatibility
        });
      });
    });

    // Handle slash commands from Claude Code init message
    // These are the authoritative source of available commands (built-in + user + plugin)
    const unsubscribeSlashCommands = window.maestro.process.onSlashCommands((sessionId: string, slashCommands: string[]) => {
      // Parse sessionId to get actual session ID (ignore tab ID suffix)
      const aiTabMatch = sessionId.match(/^(.+)-ai-(.+)$/);
      const actualSessionId = aiTabMatch ? aiTabMatch[1] : sessionId;

      // Convert string array to command objects with descriptions
      // Claude Code returns just command names, we'll need to derive descriptions
      const commands = slashCommands.map(cmd => ({
        command: cmd.startsWith('/') ? cmd : `/${cmd}`,
        description: getSlashCommandDescription(cmd),
      }));

      setSessions(prev => prev.map(s => {
        if (s.id !== actualSessionId) return s;
        return { ...s, agentCommands: commands };
      }));
    });

    // Handle stderr from processes (BATCHED - separate from stdout)
    // Supports both AI processes (sessionId format: {id}-ai-{tabId}) and terminal commands (plain sessionId)
    const unsubscribeStderr = window.maestro.process.onStderr((sessionId: string, data: string) => {
      // Filter out empty stderr (only whitespace)
      if (!data.trim()) return;

      // Parse sessionId to determine which process this is from
      // Same logic as onData handler
      let actualSessionId: string;
      let tabIdFromSession: string | undefined;
      let isFromAi = false;

      const aiTabMatch = sessionId.match(/^(.+)-ai-(.+)$/);
      if (aiTabMatch) {
        actualSessionId = aiTabMatch[1];
        tabIdFromSession = aiTabMatch[2];
        isFromAi = true;
      } else if (sessionId.includes('-batch-')) {
        // Ignore batch task stderr
        return;
      } else {
        // Plain session ID = runCommand (terminal commands)
        actualSessionId = sessionId;
      }

      if (isFromAi && tabIdFromSession) {
        // AI process stderr - route to the correct tab with stderr flag for red box styling
        batchedUpdater.appendLog(actualSessionId, tabIdFromSession, true, data, true);
      } else {
        // Terminal command stderr - route to shell logs
        batchedUpdater.appendLog(actualSessionId, null, false, data, true);
      }
    });

    // Handle command exit from runCommand
    const unsubscribeCommandExit = window.maestro.process.onCommandExit((sessionId: string, code: number) => {
      // runCommand uses plain session ID (no suffix)
      const actualSessionId = sessionId;

      setSessions(prev => prev.map(s => {
        if (s.id !== actualSessionId) return s;

        // Check if any AI tabs are still busy
        const anyAiTabBusy = s.aiTabs?.some(tab => tab.state === 'busy') || false;

        // Determine new state:
        // - If AI tabs are busy, session stays busy with busySource 'ai'
        // - Otherwise, session becomes idle
        const newState = anyAiTabBusy ? 'busy' as SessionState : 'idle' as SessionState;
        const newBusySource = anyAiTabBusy ? 'ai' as const : undefined;

        // Only show exit code if non-zero (error)
        if (code !== 0) {
          const exitLog: LogEntry = {
            id: generateId(),
            timestamp: Date.now(),
            source: 'system',
            text: `Command exited with code ${code}`
          };
          return {
            ...s,
            state: newState,
            busySource: newBusySource,
            shellLogs: [...s.shellLogs, exitLog]
          };
        }

        return {
          ...s,
          state: newState,
          busySource: newBusySource
        };
      }));
    });

    // Handle usage statistics from AI responses (BATCHED for performance)
    const unsubscribeUsage = window.maestro.process.onUsage((sessionId: string, usageStats) => {
      // Parse sessionId to get actual session ID and tab ID (handles -ai-tabId and legacy -ai suffix)
      let actualSessionId: string;
      let tabId: string | null = null;
      const aiTabMatch = sessionId.match(/^(.+)-ai-(.+)$/);
      if (aiTabMatch) {
        actualSessionId = aiTabMatch[1];
        tabId = aiTabMatch[2];
      } else if (sessionId.endsWith('-ai')) {
        actualSessionId = sessionId.slice(0, -3);
      } else {
        actualSessionId = sessionId;
      }

      // Calculate context window usage percentage from CURRENT reported tokens.
      // Claude Code reports actual context size as input + cache tokens.
      // Codex/OpenCode cache tokens are subsets or not part of context size, so use input + output.
      const sessionForUsage = sessionsRef.current.find(s => s.id === actualSessionId);
      const agentToolType = sessionForUsage?.toolType;
      const isClaudeUsage = agentToolType === 'claude-code' || agentToolType === 'claude';
      const currentContextTokens = isClaudeUsage
        ? usageStats.inputTokens + usageStats.cacheReadInputTokens + usageStats.cacheCreationInputTokens
        : usageStats.inputTokens + usageStats.outputTokens;

      // Calculate context percentage, falling back to agent-specific defaults if contextWindow not provided
      let contextPercentage: number;
      if (usageStats.contextWindow > 0) {
        contextPercentage = Math.min(Math.round((currentContextTokens / usageStats.contextWindow) * 100), 100);
      } else {
        // Use fallback estimation with agent-specific default context window
        const estimated = estimateContextUsage(usageStats, agentToolType);
        contextPercentage = estimated ?? 0;
      }

      // Batch the usage stats update, context percentage, and cycle tokens
      // The batched updater handles the accumulation logic internally
      batchedUpdater.updateUsage(actualSessionId, tabId, usageStats);
      batchedUpdater.updateUsage(actualSessionId, null, usageStats); // Session-level accumulation
      batchedUpdater.updateContextUsage(actualSessionId, contextPercentage);
      batchedUpdater.updateCycleTokens(actualSessionId, usageStats.outputTokens);

      // Update persistent global stats (not batched - this is a separate concern)
      updateGlobalStatsRef.current({
        totalInputTokens: usageStats.inputTokens,
        totalOutputTokens: usageStats.outputTokens,
        totalCacheReadTokens: usageStats.cacheReadInputTokens,
        totalCacheCreationTokens: usageStats.cacheCreationInputTokens,
        totalCostUsd: usageStats.totalCostUsd,
      });
    });

    // Handle agent errors (auth expired, token exhaustion, rate limits, crashes)
    const unsubscribeAgentError = window.maestro.process.onAgentError((sessionId: string, error) => {
      // Cast error to AgentError type (IPC uses plain object)
      const agentError: AgentError = {
        type: error.type as AgentError['type'],
        message: error.message,
        recoverable: error.recoverable,
        agentId: error.agentId,
        sessionId: error.sessionId,
        timestamp: error.timestamp,
        raw: error.raw,
        parsedJson: error.parsedJson,
      };

      // Check if this is a group chat error (moderator or participant)
      // Pattern: group-chat-{UUID}-moderator-{timestamp} or group-chat-{UUID}-{participantName}-{timestamp}
      // UUIDs look like: 533fad24-3915-4fc6-9edb-ba2292a5b903
      const groupChatModeratorMatch = sessionId.match(/^group-chat-([0-9a-f-]{36})-moderator-(\d+)$/);
      const groupChatParticipantMatch = sessionId.match(/^group-chat-([0-9a-f-]{36})-(.+?)-(\d+)$/);
      const groupChatMatch = groupChatModeratorMatch || groupChatParticipantMatch;
      if (groupChatMatch) {
        const groupChatId = groupChatMatch[1];
        const isModeratorError = groupChatModeratorMatch !== null;
        const participantOrModerator = isModeratorError ? 'moderator' : groupChatMatch[2];

        console.log('[onAgentError] Group chat error received:', {
          rawSessionId: sessionId,
          groupChatId,
          participantName: isModeratorError ? 'Moderator' : participantOrModerator,
          errorType: error.type,
          message: error.message,
          recoverable: error.recoverable,
        });

        // Set the group chat error state - this will show in the group chat UI
        setGroupChatError({
          groupChatId,
          error: agentError,
          participantName: isModeratorError ? 'Moderator' : participantOrModerator,
        });

        // Also add an error message to the group chat messages
        const errorMessage: GroupChatMessage = {
          timestamp: new Date(agentError.timestamp).toISOString(),
          from: 'system',
          content: `⚠️ ${isModeratorError ? 'Moderator' : participantOrModerator} error: ${agentError.message}`,
        };
        setGroupChatMessages(prev => [...prev, errorMessage]);

        // Reset group chat state to idle so user can try again
        setGroupChatState('idle');
        setGroupChatStates(prev => {
          const next = new Map(prev);
          next.set(groupChatId, 'idle');
          return next;
        });
        return;
      }

      // Parse sessionId to get actual session ID (strip -ai-tabId or -ai suffix)
      let actualSessionId: string;
      let tabIdFromSession: string | undefined;
      const aiTabMatch = sessionId.match(/^(.+)-ai(?:-(.+))?$/);
      if (aiTabMatch) {
        actualSessionId = aiTabMatch[1];
        tabIdFromSession = aiTabMatch[2];
      } else if (sessionId.endsWith('-batch')) {
        // Batch process errors - strip -batch suffix
        actualSessionId = sessionId.replace(/-batch.*$/, '');
      } else {
        actualSessionId = sessionId;
      }

      console.log('[onAgentError] Agent error received:', {
        rawSessionId: sessionId,
        actualSessionId,
        errorType: error.type,
        message: error.message,
        recoverable: error.recoverable,
      });

      // Create an error log entry to show in the chat
      const errorLogEntry: LogEntry = {
        id: generateId(),
        timestamp: agentError.timestamp,
        source: 'error',
        text: agentError.message,
        agentError, // Include full error for "View Details" functionality
      };

      // Update session with error state and add error log entry to the originating tab
      setSessions(prev => prev.map(s => {
        if (s.id !== actualSessionId) return s;

        // Prefer explicit tab ID from the sessionId; fall back to active tab
        const targetTab = tabIdFromSession
          ? s.aiTabs.find(tab => tab.id === tabIdFromSession)
          : getActiveTab(s);
        const updatedAiTabs = targetTab
          ? s.aiTabs.map(tab =>
              tab.id === targetTab.id
                ? { ...tab, logs: [...tab.logs, errorLogEntry], agentError }
                : tab
            )
          : s.aiTabs;

        return {
          ...s,
          agentError,
          agentErrorTabId: targetTab?.id,
          agentErrorPaused: true, // Block new operations until resolved
          state: 'error' as SessionState,
          aiTabs: updatedAiTabs,
        };
      }));

      // Phase 5.10: Check if there's an active batch run for this session and pause it
      // Also add history entry and toast for Auto Run errors
      if (getBatchStateRef.current && pauseBatchOnErrorRef.current) {
        const batchState = getBatchStateRef.current(actualSessionId);
        if (batchState.isRunning && !batchState.errorPaused) {
          console.log('[onAgentError] Pausing active batch run due to error:', actualSessionId);
          const currentDoc = batchState.documents[batchState.currentDocumentIndex];
          pauseBatchOnErrorRef.current(
            actualSessionId,
            agentError,
            batchState.currentDocumentIndex,
            currentDoc ? `Processing ${currentDoc}` : undefined
          );

          // Get session for history entry
          const session = sessionsRef.current.find(s => s.id === actualSessionId);

          // Add history entry for Auto Run error (similar to stalled document entries)
          if (addHistoryEntryRef.current && session) {
            const errorTitle = getErrorTitleForType(agentError.type);
            const errorExplanation = [
              `**Auto Run Error: ${errorTitle}**`,
              '',
              `Auto Run encountered an error while processing:`,
              currentDoc ? `- Document: ${currentDoc}` : '',
              `- Error: ${agentError.message}`,
              '',
              '**What to do:**',
              agentError.type === 'auth_expired'
                ? '- Re-authenticate with the provider (e.g., run `claude login` in terminal)'
                : agentError.type === 'token_exhaustion'
                  ? '- Start a new session to reset the context window'
                  : agentError.type === 'rate_limited'
                    ? '- Wait a few minutes before retrying'
                    : agentError.type === 'network_error'
                      ? '- Check your internet connection and try again'
                      : '- Review the error message and take appropriate action',
              '',
              'After resolving the issue, you can resume, skip, or abort the Auto Run.',
            ].filter(Boolean).join('\n');

            addHistoryEntryRef.current({
              type: 'AUTO',
              summary: `Auto Run error: ${errorTitle}${currentDoc ? ` (${currentDoc})` : ''}`,
              fullResponse: errorExplanation,
              projectPath: session.cwd,
              sessionId: actualSessionId,
              success: false,
            });
          }

          // Show toast notification for Auto Run error
          if (addToastRef.current) {
            const errorTitle = getErrorTitleForType(agentError.type);
            addToastRef.current({
              type: 'error',
              title: `Auto Run: ${errorTitle}`,
              message: agentError.message,
              sessionId: actualSessionId,
            });
          }
        }
      }

      // Show the error modal for this session
      setAgentErrorModalSessionId(actualSessionId);
    });

    // Handle thinking/streaming content chunks from AI agents
    // Only appends to logs if the tab has showThinking enabled
    // THROTTLED: Uses requestAnimationFrame to batch rapid chunk arrivals (Phase 6.4)
    const unsubscribeThinkingChunk = window.maestro.process.onThinkingChunk?.((sessionId: string, content: string) => {
      // Parse sessionId to get actual session ID and tab ID (format: {id}-ai-{tabId})
      const aiTabMatch = sessionId.match(/^(.+)-ai-(.+)$/);
      if (!aiTabMatch) return; // Only handle AI tab messages

      const actualSessionId = aiTabMatch[1];
      const tabId = aiTabMatch[2];
      const bufferKey = `${actualSessionId}:${tabId}`;

      // Buffer the chunk - accumulate if there's already content for this session+tab
      const existingContent = thinkingChunkBufferRef.current.get(bufferKey) || '';
      thinkingChunkBufferRef.current.set(bufferKey, existingContent + content);

      // Schedule a single RAF callback to process all buffered chunks
      // This naturally throttles to ~60fps (16.67ms) and batches multiple rapid arrivals
      if (thinkingChunkRafIdRef.current === null) {
        thinkingChunkRafIdRef.current = requestAnimationFrame(() => {
          // Process all buffered chunks in a single setSessions call
          const buffer = thinkingChunkBufferRef.current;
          if (buffer.size === 0) {
            thinkingChunkRafIdRef.current = null;
            return;
          }

          // Take a snapshot and clear the buffer
          const chunksToProcess = new Map(buffer);
          buffer.clear();
          thinkingChunkRafIdRef.current = null;

          setSessions(prev => prev.map(s => {
            // Check if any buffered chunks are for this session
            let hasChanges = false;
            for (const [key] of chunksToProcess) {
              if (key.startsWith(s.id + ':')) {
                hasChanges = true;
                break;
              }
            }
            if (!hasChanges) return s;

            // Process each chunk for this session
            let updatedTabs = s.aiTabs;
            for (const [key, bufferedContent] of chunksToProcess) {
              const [chunkSessionId, chunkTabId] = key.split(':');
              if (chunkSessionId !== s.id) continue;

              const targetTab = updatedTabs.find(t => t.id === chunkTabId);
              if (!targetTab) continue;

              // Only append if thinking is enabled for this tab
              if (!targetTab.showThinking) continue;

              // Skip malformed content that looks like concatenated tool names
              // This can happen if the stream parser receives malformed output
              if (isLikelyConcatenatedToolNames(bufferedContent)) {
                console.warn('[App] Skipping malformed thinking chunk (concatenated tool names):', bufferedContent.substring(0, 100));
                continue;
              }

              // Find the last log entry - if it's a thinking entry, append to it
              const lastLog = targetTab.logs[targetTab.logs.length - 1];
              if (lastLog?.source === 'thinking') {
                // Check if appending would create concatenated tool names
                const combinedText = lastLog.text + bufferedContent;
                if (isLikelyConcatenatedToolNames(combinedText)) {
                  console.warn('[App] Detected malformed thinking content, replacing instead of appending');
                  // Replace with just the new content (likely the start of real text)
                  updatedTabs = updatedTabs.map(tab =>
                    tab.id === chunkTabId
                      ? { ...tab, logs: [...tab.logs.slice(0, -1), { ...lastLog, text: bufferedContent }] }
                      : tab
                  );
                } else {
                  // Normal append to existing thinking block
                  updatedTabs = updatedTabs.map(tab =>
                    tab.id === chunkTabId
                      ? { ...tab, logs: [...tab.logs.slice(0, -1), { ...lastLog, text: combinedText }] }
                      : tab
                  );
                }
              } else {
                // Create new thinking block
                const newLog: LogEntry = {
                  id: generateId(),
                  timestamp: Date.now(),
                  source: 'thinking',
                  text: bufferedContent
                };
                updatedTabs = updatedTabs.map(tab =>
                  tab.id === chunkTabId
                    ? { ...tab, logs: [...tab.logs, newLog] }
                    : tab
                );
              }
            }

            return updatedTabs === s.aiTabs ? s : { ...s, aiTabs: updatedTabs };
          }));
        });
      }
    });

    // Handle SSH remote status events - tracks when sessions are executing on remote hosts
    // Also populates session-wide SSH context (sshRemoteId, remoteCwd) for file explorer, git, auto run, etc.
    // IMPORTANT: When SSH connection is established, we also recheck isGitRepo since the initial
    // check may have failed or been done before SSH was ready.
    const unsubscribeSshRemote = window.maestro.process.onSshRemote?.((sessionId: string, sshRemote: { id: string; name: string; host: string; remoteWorkingDir?: string } | null) => {
      // Parse sessionId to get actual session ID (format: {id}-ai-{tabId} or {id}-terminal)
      let actualSessionId: string;
      const aiTabMatch = sessionId.match(/^(.+)-ai-(.+)$/);
      if (aiTabMatch) {
        actualSessionId = aiTabMatch[1];
      } else if (sessionId.endsWith('-ai') || sessionId.endsWith('-terminal')) {
        actualSessionId = sessionId.replace(/-ai$|-terminal$/, '');
      } else {
        actualSessionId = sessionId;
      }

      // Update session with SSH remote info and session-wide SSH context
      setSessions(prev => prev.map(s => {
        if (s.id !== actualSessionId) return s;
        // Only update if the value actually changed (avoid unnecessary re-renders)
        const currentRemoteId = s.sshRemote?.id;
        const newRemoteId = sshRemote?.id;
        if (currentRemoteId === newRemoteId) return s;
        return {
          ...s,
          sshRemote: sshRemote ?? undefined,
          // Populate session-wide SSH context for all operations (file explorer, git, auto run, etc.)
          sshRemoteId: sshRemote?.id,
          remoteCwd: sshRemote?.remoteWorkingDir,
        };
      }));

      // When SSH connection is established, check isGitRepo with the SSH context
      // For SSH sessions, this is the FIRST git check (deferred from session creation)
      // since we can't check until SSH is connected
      if (sshRemote?.id) {
        const session = sessionsRef.current.find(s => s.id === actualSessionId);
        // Only check if session hasn't been detected as git repo yet
        // (avoids redundant checks if SSH reconnects)
        if (session && !session.isGitRepo) {
          const remoteCwd = sshRemote.remoteWorkingDir || session.sessionSshRemoteConfig?.workingDirOverride || session.cwd;
          (async () => {
            try {
              const isGitRepo = await gitService.isRepo(remoteCwd, sshRemote.id);
              if (isGitRepo) {
                // Fetch git branches and tags now that we know it's a git repo
                const [gitBranches, gitTags] = await Promise.all([
                  gitService.getBranches(remoteCwd, sshRemote.id),
                  gitService.getTags(remoteCwd, sshRemote.id)
                ]);
                const gitRefsCacheTime = Date.now();

                setSessions(prev => prev.map(s => {
                  if (s.id !== actualSessionId) return s;
                  // Only update if still not detected as git repo
                  if (s.isGitRepo) return s;
                  return {
                    ...s,
                    isGitRepo: true,
                    gitBranches,
                    gitTags,
                    gitRefsCacheTime,
                  };
                }));
              }
            } catch (err) {
              console.error(`[SSH] Failed to check git repo status for ${actualSessionId}:`, err);
            }
          })();
        }
      }
    });

    // Handle tool execution events from AI agents
    // Only appends to logs if the tab has showThinking enabled (tools shown alongside thinking)
    const unsubscribeToolExecution = window.maestro.process.onToolExecution?.((sessionId: string, toolEvent: { toolName: string; state?: unknown; timestamp: number }) => {
      // Parse sessionId to get actual session ID and tab ID (format: {id}-ai-{tabId})
      const aiTabMatch = sessionId.match(/^(.+)-ai-(.+)$/);
      if (!aiTabMatch) return; // Only handle AI tab messages

      const actualSessionId = aiTabMatch[1];
      const tabId = aiTabMatch[2];

      setSessions(prev => prev.map(s => {
        if (s.id !== actualSessionId) return s;

        const targetTab = s.aiTabs.find(t => t.id === tabId);
        if (!targetTab?.showThinking) return s; // Only show if thinking enabled

        const toolLog: LogEntry = {
          id: `tool-${Date.now()}-${toolEvent.toolName}`,
          timestamp: toolEvent.timestamp,
          source: 'tool',
          text: toolEvent.toolName,
          metadata: {
            toolState: toolEvent.state as NonNullable<LogEntry['metadata']>['toolState'],
          }
        };

        return {
          ...s,
          aiTabs: s.aiTabs.map(tab =>
            tab.id === tabId
              ? { ...tab, logs: [...tab.logs, toolLog] }
              : tab
          )
        };
      }));
    });

    // Cleanup listeners on unmount
    return () => {
      unsubscribeData();
      unsubscribeExit();
      unsubscribeSessionId();
      unsubscribeSlashCommands();
      unsubscribeStderr();
      unsubscribeCommandExit();
      unsubscribeUsage();
      unsubscribeAgentError();
      unsubscribeThinkingChunk?.();
      unsubscribeSshRemote?.();
      unsubscribeToolExecution?.();
      // Cancel any pending thinking chunk RAF and clear buffer (Phase 6.4)
      if (thinkingChunkRafIdRef.current !== null) {
        cancelAnimationFrame(thinkingChunkRafIdRef.current);
        thinkingChunkRafIdRef.current = null;
      }
      thinkingChunkBuffer.clear();
    };
     
  }, []);

  // --- GROUP CHAT EVENT LISTENERS ---
  // Listen for real-time updates to group chat messages and state
  useEffect(() => {
    const unsubMessage = window.maestro.groupChat.onMessage((id, message) => {
      if (id === activeGroupChatId) {
        setGroupChatMessages(prev => [...prev, message]);
      }
    });

    const unsubState = window.maestro.groupChat.onStateChange((id, state) => {
      // Track state for ALL group chats (for sidebar indicator when not active)
      setGroupChatStates(prev => {
        const next = new Map(prev);
        next.set(id, state);
        return next;
      });
      // Also update the active group chat's state for immediate UI
      if (id === activeGroupChatId) {
        setGroupChatState(state);
      }
    });

    const unsubParticipants = window.maestro.groupChat.onParticipantsChanged((id, participants) => {
      // Update the group chat's participants list
      setGroupChats(prev => prev.map(chat =>
        chat.id === id ? { ...chat, participants } : chat
      ));
    });

    const unsubModeratorUsage = window.maestro.groupChat.onModeratorUsage?.((id, usage) => {
      if (id === activeGroupChatId) {
        setModeratorUsage(usage);
      }
    });

    console.log(`[GroupChat:UI] Setting up onParticipantState listener, activeGroupChatId=${activeGroupChatId}`);
    const unsubParticipantState = window.maestro.groupChat.onParticipantState?.((id, participantName, state) => {
      console.log(`[GroupChat:UI] Received participant state: chatId=${id}, participant=${participantName}, state=${state}, activeGroupChatId=${activeGroupChatId}`);
      // Track participant state for ALL group chats (for sidebar indicator)
      setAllGroupChatParticipantStates(prev => {
        const next = new Map(prev);
        const chatStates = next.get(id) || new Map();
        const updatedChatStates = new Map(chatStates);
        updatedChatStates.set(participantName, state);
        next.set(id, updatedChatStates);
        console.log(`[GroupChat:UI] Updated allGroupChatParticipantStates for ${id}: ${JSON.stringify([...updatedChatStates.entries()])}`);
        return next;
      });
      // Also update the active group chat's participant states for immediate UI
      if (id === activeGroupChatId) {
        console.log(`[GroupChat:UI] Updating participantStates for active chat: ${participantName}=${state}`);
        setParticipantStates(prev => {
          const next = new Map(prev);
          next.set(participantName, state);
          console.log(`[GroupChat:UI] New participantStates: ${JSON.stringify([...next.entries()])}`);
          return next;
        });
      } else {
        console.log(`[GroupChat:UI] Skipping participantStates update - not active chat (${id} vs ${activeGroupChatId})`);
      }
    });

    const unsubModeratorSessionId = window.maestro.groupChat.onModeratorSessionIdChanged?.((id, agentSessionId) => {
      // Update the group chat's moderator agent session ID (the Claude Code session UUID)
      setGroupChats(prev => prev.map(chat =>
        chat.id === id ? { ...chat, moderatorAgentSessionId: agentSessionId } : chat
      ));
    });

    return () => {
      unsubMessage();
      unsubState();
      unsubParticipants();
      unsubModeratorUsage?.();
      unsubParticipantState?.();
      unsubModeratorSessionId?.();
    };
     
  }, [activeGroupChatId]);

  // Process group chat execution queue when state becomes idle
  useEffect(() => {
    if (groupChatState === 'idle' && groupChatExecutionQueue.length > 0 && activeGroupChatId) {
      // Take the first item from the queue
      const [nextItem, ...remainingQueue] = groupChatExecutionQueue;
      setGroupChatExecutionQueue(remainingQueue);

      // Send the queued message - update both active state and per-chat state
      setGroupChatState('moderator-thinking');
      setGroupChatStates(prev => {
        const next = new Map(prev);
        next.set(activeGroupChatId, 'moderator-thinking');
        return next;
      });
      window.maestro.groupChat.sendToModerator(
        activeGroupChatId,
        nextItem.text || '',
        nextItem.images,
        nextItem.readOnlyMode
      );
    }
  }, [groupChatState, groupChatExecutionQueue, activeGroupChatId]);

  // Refs (groupChatInputRef and groupChatMessagesRef are now in GroupChatContext)
  const logsEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const terminalOutputRef = useRef<HTMLDivElement>(null);
  const sidebarContainerRef = useRef<HTMLDivElement>(null);
  const fileTreeContainerRef = useRef<HTMLDivElement>(null);
  const fileTreeFilterInputRef = useRef<HTMLInputElement>(null);
  const fileTreeKeyboardNavRef = useRef(false); // Track if selection change came from keyboard
  const rightPanelRef = useRef<RightPanelHandle>(null);
  const mainPanelRef = useRef<MainPanelHandle>(null);

  // Refs for toast notifications (to access latest values in event handlers)
  // Note: sessionsRef, groupsRef, activeSessionIdRef are now provided by SessionContext
  const addToastRef = useRef(addToast);
  const updateGlobalStatsRef = useRef(updateGlobalStats);
  const customAICommandsRef = useRef(customAICommands);
  const speckitCommandsRef = useRef(speckitCommands);
  const openspecCommandsRef = useRef(openspecCommands);
  addToastRef.current = addToast;
  updateGlobalStatsRef.current = updateGlobalStats;
  customAICommandsRef.current = customAICommands;
  speckitCommandsRef.current = speckitCommands;
  openspecCommandsRef.current = openspecCommands;

  // Note: spawnBackgroundSynopsisRef and spawnAgentWithPromptRef are now provided by useAgentExecution hook
  // Note: addHistoryEntryRef is now provided by useAgentSessionManagement hook
  // Ref for processQueuedMessage - allows batch exit handler to process queued messages
  const processQueuedItemRef = useRef<((sessionId: string, item: QueuedItem) => Promise<void>) | null>(null);

  // Ref for handling remote commands from web interface
  // This allows web commands to go through the exact same code path as desktop commands
  const _pendingRemoteCommandRef = useRef<{ sessionId: string; command: string } | null>(null);

  // Refs for batch processor error handling (Phase 5.10)
  // These are populated after useBatchProcessor is called and used in the agent error handler
  const pauseBatchOnErrorRef = useRef<((sessionId: string, error: AgentError, documentIndex: number, taskDescription?: string) => void) | null>(null);
  const getBatchStateRef = useRef<((sessionId: string) => BatchRunState) | null>(null);

  // Refs for throttled thinking chunk updates (Phase 6.4)
  // Buffer chunks per session+tab and use requestAnimationFrame to batch UI updates
  const thinkingChunkBufferRef = useRef<Map<string, string>>(new Map()); // Key: "sessionId:tabId", Value: accumulated content
  const thinkingChunkRafIdRef = useRef<number | null>(null);

  // Expose addToast to window for debugging/testing
  useEffect(() => {
    (window as any).__maestroDebug = {
      addToast: (type: 'success' | 'info' | 'warning' | 'error', title: string, message: string) => {
        addToastRef.current({ type, title, message });
      },
      testToast: () => {
        addToastRef.current({
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
  const [selectedSidebarIndex, setSelectedSidebarIndex] = useState(0);
  // Note: activeSession is now provided by SessionContext
  const activeTabForError = useMemo(() => (
    activeSession ? getActiveTab(activeSession) : null
  ), [activeSession]);

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
        if (!merged.some(c => c.command === cmd.command)) {
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
        const customCommandObjects = (customClaudeCommands || []).map(cmd => ({
          command: cmd.command,
          description: cmd.description,
        }));

        if (customCommandObjects.length > 0) {
          setSessions(prev => prev.map(s => {
            if (s.id !== sessionId) return s;
            const existingCommands = s.agentCommands || [];
            return { ...s, agentCommands: mergeCommands(existingCommands, customCommandObjects) };
          }));
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
        const agentCommandObjects = (agentSlashCommands || []).map(cmd => ({
          command: cmd.startsWith('/') ? cmd : `/${cmd}`,
          description: getSlashCommandDescription(cmd),
        }));

        if (agentCommandObjects.length > 0) {
          setSessions(prev => prev.map(s => {
            if (s.id !== sessionId) return s;
            const existingCommands = s.agentCommands || [];
            return { ...s, agentCommands: mergeCommands(existingCommands, agentCommandObjects) };
          }));
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
  }, [activeSession?.id, activeSession?.toolType, activeSession?.cwd, activeSession?.customPath, activeSession?.agentCommands, activeSession?.projectRoot]);

  // File preview navigation history - derived from active session (per-agent history)
  const filePreviewHistory = useMemo(() =>
    activeSession?.filePreviewHistory ?? [],
    [activeSession?.filePreviewHistory]
  );
  const filePreviewHistoryIndex = useMemo(() =>
    activeSession?.filePreviewHistoryIndex ?? -1,
    [activeSession?.filePreviewHistoryIndex]
  );

  // Helper to update file preview history for the active session
  const setFilePreviewHistory = useCallback((history: {name: string; content: string; path: string}[]) => {
    if (!activeSessionId) return;
    setSessions(prev => prev.map(s =>
      s.id === activeSessionId
        ? { ...s, filePreviewHistory: history }
        : s
    ));
  }, [activeSessionId]);

  const setFilePreviewHistoryIndex = useCallback((index: number) => {
    if (!activeSessionId) return;
    setSessions(prev => prev.map(s =>
      s.id === activeSessionId
        ? { ...s, filePreviewHistoryIndex: index }
        : s
    ));
  }, [activeSessionId]);

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
    setPreviewFile,
    setFilePreviewLoading,
    filePreviewHistory,
    setFilePreviewHistory,
    filePreviewHistoryIndex,
    setFilePreviewHistoryIndex,
    setConfirmModalMessage,
    setConfirmModalOnConfirm,
    setConfirmModalOpen,
  });

  // Use custom colors when custom theme is selected, otherwise use the standard theme
  const theme = useMemo(() => {
    if (activeThemeId === 'custom') {
      return {
        ...THEMES.custom,
        colors: customThemeColors
      };
    }
    return THEMES[activeThemeId];
  }, [activeThemeId, customThemeColors]);

  // Memoized cwd for git viewers (prevents re-renders from inline computation)
  const gitViewerCwd = useMemo(() =>
    activeSession
      ? (activeSession.inputMode === 'terminal'
          ? (activeSession.shellCwd || activeSession.cwd)
          : activeSession.cwd)
      : '',
     
    [activeSession?.inputMode, activeSession?.shellCwd, activeSession?.cwd]
  );

  // PERF: Memoize sessions for NewInstanceModal validation (only recompute when modal is open)
  // This prevents re-renders of the modal's validation logic on every session state change
  const sessionsForValidation = useMemo(() =>
    newInstanceModalOpen ? sessions : [],
    [newInstanceModalOpen, sessions]
  );

  // PERF: Memoize hasNoAgents check for SettingsModal (only depends on session count)
  const hasNoAgents = useMemo(() => sessions.length === 0, [sessions.length]);

  // Get the session with the active error (for AgentErrorModal)
  const errorSession = useMemo(() =>
    agentErrorModalSessionId ? sessions.find(s => s.id === agentErrorModalSessionId) : null,
    [agentErrorModalSessionId, sessions]
  );

  // Handler to close the agent error modal without clearing the error
  const handleCloseAgentErrorModal = useCallback(() => {
    setAgentErrorModalSessionId(null);
  }, []);

  // Handler to clear agent error and resume operations
  const handleClearAgentError = useCallback((sessionId: string, tabId?: string) => {
    setSessions(prev => prev.map(s => {
      if (s.id !== sessionId) return s;
      const targetTabId = tabId ?? s.agentErrorTabId;
      const updatedAiTabs = targetTabId
        ? s.aiTabs.map(tab =>
            tab.id === targetTabId ? { ...tab, agentError: undefined } : tab
          )
        : s.aiTabs;
      return {
        ...s,
        agentError: undefined,
        agentErrorTabId: undefined,
        agentErrorPaused: false,
        state: 'idle' as SessionState,
        aiTabs: updatedAiTabs,
      };
    }));
    setAgentErrorModalSessionId(null);
    // Notify main process to clear error state
    window.maestro.agentError.clearError(sessionId).catch(err => {
      console.error('Failed to clear agent error:', err);
    });
  }, []);

  // Handler to start a new session (recovery action)
  const handleStartNewSessionAfterError = useCallback((sessionId: string) => {
    const session = sessions.find(s => s.id === sessionId);
    if (!session) return;

    // Clear the error state
    handleClearAgentError(sessionId);

    // Create a new tab in the session to start fresh
    setSessions(prev => prev.map(s => {
      if (s.id !== sessionId) return s;
      const result = createTab(s, { saveToHistory: defaultSaveToHistory, showThinking: defaultShowThinking });
      if (!result) return s;
      return result.session;
    }));

    // Focus the input after creating new tab
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [sessions, handleClearAgentError, defaultSaveToHistory, defaultShowThinking]);

  // Handler to retry after error (recovery action)
  const handleRetryAfterError = useCallback((sessionId: string) => {
    // Clear the error state and let user retry manually
    handleClearAgentError(sessionId);

    // Focus the input for retry
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [handleClearAgentError]);

  // Handler to restart the agent (recovery action for crashes)
  const handleRestartAgentAfterError = useCallback(async (sessionId: string) => {
    const session = sessions.find(s => s.id === sessionId);
    if (!session) return;

    // Clear the error state
    handleClearAgentError(sessionId);

    // Kill any existing processes and respawn
    try {
      await window.maestro.process.kill(`${sessionId}-ai`);
    } catch {
      // Process may not exist
    }

    // The agent will be respawned when user sends next message
    // Focus the input
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [sessions, handleClearAgentError]);

  const handleAuthenticateAfterError = useCallback((sessionId: string) => {
    const session = sessions.find(s => s.id === sessionId);
    if (!session) return;

    handleClearAgentError(sessionId);
    setActiveSessionId(sessionId);
    setSessions(prev => prev.map(s =>
      s.id === sessionId ? { ...s, inputMode: 'terminal' } : s
    ));

    setTimeout(() => inputRef.current?.focus(), 0);
  }, [sessions, handleClearAgentError, setActiveSessionId, setSessions]);

  // Use the agent error recovery hook to get recovery actions
  const { recoveryActions } = useAgentErrorRecovery({
    error: errorSession?.agentError,
    agentId: errorSession?.toolType || 'claude-code',
    sessionId: errorSession?.id || '',
    onNewSession: errorSession ? () => handleStartNewSessionAfterError(errorSession.id) : undefined,
    onRetry: errorSession ? () => handleRetryAfterError(errorSession.id) : undefined,
    onClearError: errorSession ? () => handleClearAgentError(errorSession.id) : undefined,
    onRestartAgent: errorSession ? () => handleRestartAgentAfterError(errorSession.id) : undefined,
    onAuthenticate: errorSession ? () => handleAuthenticateAfterError(errorSession.id) : undefined,
  });

  // Handler to clear group chat error (now uses context's clearGroupChatError)
  const handleClearGroupChatError = handleClearGroupChatErrorBase;

  // Use the agent error recovery hook for group chat errors
  const { recoveryActions: groupChatRecoveryActions } = useAgentErrorRecovery({
    error: groupChatError?.error,
    agentId: 'claude-code', // Group chat moderator is always claude-code for now
    sessionId: groupChatError?.groupChatId || '',
    onRetry: handleClearGroupChatError,
    onClearError: handleClearGroupChatError,
  });

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

  // Quit confirmation handler - shows modal when trying to quit with busy agents
  useEffect(() => {
    const unsubscribe = window.maestro.app.onQuitConfirmationRequest(() => {
      // Get all busy AI sessions (agents that are actively thinking)
      const busyAgents = sessions.filter(
        s => s.state === 'busy' && s.busySource === 'ai' && s.toolType !== 'terminal'
      );

      if (busyAgents.length === 0) {
        // No busy agents, confirm quit immediately
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
  const { hasCapability: hasActiveSessionCapability } = useAgentCapabilities(activeSession?.toolType);

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
      const savedInfo = info.tokensSaved && info.tokensSaved > 0
        ? ` Saved ~${info.tokensSaved.toLocaleString()} tokens.`
        : '';
      const sourceInfo = info.sourceSessionName && info.targetSessionName
        ? `"${info.sourceSessionName}" + "${info.targetSessionName}"`
        : info.sessionName;

      // Show toast notification in the UI
      addToast({
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
      // For merge into existing tab, show toast and clear state
      if (activeSession && result.success && result.targetSessionId) {
        const tokenInfo = result.estimatedTokens
          ? ` (~${result.estimatedTokens.toLocaleString()} tokens)`
          : '';
        const savedInfo = result.tokensSaved && result.tokensSaved > 0
          ? ` Saved ~${result.tokensSaved.toLocaleString()} tokens.`
          : '';

        addToast({
          type: 'success',
          title: 'Context Merged',
          message: `"${result.sourceSessionName || 'Current Session'}" → "${result.targetSessionName || 'Selected Session'}"${tokenInfo}.${savedInfo} Context will be included with your next message.`,
          sessionId: result.targetSessionId,
          tabId: result.targetTabId,
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
      addToast({
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

  // LeaderboardRegistrationModal handlers
  const handleCloseLeaderboardRegistration = useCallback(() => {
    setLeaderboardRegistrationOpen(false);
  }, []);

  const handleSaveLeaderboardRegistration = useCallback((registration: LeaderboardRegistration) => {
    setLeaderboardRegistration(registration);
  }, []);

  const handleLeaderboardOptOut = useCallback(() => {
    setLeaderboardRegistration(null);
  }, []);

  // Sync autorun stats from server (for new device installations)
  const handleSyncAutoRunStats = useCallback((stats: {
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
  }, [autoRunStats, setAutoRunStats]);

  // MergeSessionModal handlers
  const handleCloseMergeSession = useCallback(() => {
    setMergeSessionModalOpen(false);
    resetMerge();
  }, [resetMerge]);

  const handleMerge = useCallback(async (
    targetSessionId: string,
    targetTabId: string | undefined,
    options: MergeOptions
  ) => {
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
      addToast({
        type: 'error',
        title: 'Merge Failed',
        message: result.error || 'Failed to merge contexts',
      });
    }
    // Note: Success toasts are handled by onSessionCreated (for new sessions)
    // and onMergeComplete (for merging into existing sessions) callbacks

    return result;
  }, [activeSession, executeMerge, addToast]);

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

  // SendToAgentModal handlers
  const handleCloseSendToAgent = useCallback(() => {
    setSendToAgentModalOpen(false);
  }, []);

  const handleSendToAgent = useCallback(async (
    targetSessionId: string,
    options: SendToAgentOptions
  ) => {
    // Find the target session
    const targetSession = sessions.find(s => s.id === targetSessionId);
    if (!targetSession) {
      return { success: false, error: 'Target session not found' };
    }

    // Store source and target agents for progress modal display
    setTransferSourceAgent(activeSession!.toolType);
    setTransferTargetAgent(targetSession.toolType);

    // Close the selection modal - progress modal will take over
    setSendToAgentModalOpen(false);

    // Get source tab context
    const sourceTab = activeSession!.aiTabs.find(t => t.id === activeSession!.activeTabId);
    if (!sourceTab) {
      return { success: false, error: 'Source tab not found' };
    }

    // Transfer context to the target session's active tab
    // Create a new tab in the target session with the transferred context
    const newTabId = `tab-${Date.now()}`;
    const transferNotice: LogEntry = {
      id: `transfer-notice-${Date.now()}`,
      timestamp: Date.now(),
      source: 'system',
      text: `Context transferred from "${activeSession!.name}" (${activeSession!.toolType})${options.groomContext ? ' - cleaned to reduce size' : ''}`,
    };

    const newTab: AITab = {
      id: newTabId,
      name: `From: ${activeSession!.name}`,
      logs: [transferNotice, ...sourceTab.logs],
      agentSessionId: null,
      starred: false,
      inputValue: '',
      stagedImages: [],
      createdAt: Date.now(),
      state: 'idle',
    };

    // Add the new tab to the target session
    setSessions(prev => prev.map(s => {
      if (s.id === targetSessionId) {
        return {
          ...s,
          aiTabs: [...s.aiTabs, newTab],
          activeTabId: newTabId,
        };
      }
      return s;
    }));

    // Navigate to the target session
    setActiveSessionId(targetSessionId);

    // Calculate estimated tokens for the message
    const estimatedTokens = sourceTab.logs
      .filter(log => log.text && log.source !== 'system')
      .reduce((sum, log) => sum + Math.round((log.text?.length || 0) / 4), 0);
    const tokenInfo = estimatedTokens > 0
      ? ` (~${estimatedTokens.toLocaleString()} tokens)`
      : '';

    // Show success toast with detailed info
    addToast({
      type: 'success',
      title: 'Context Transferred',
      message: `"${activeSession!.name}" → "${targetSession.name}"${tokenInfo}. Ready in new tab.`,
      sessionId: targetSessionId,
      tabId: newTabId,
    });

    // Reset transfer state
    resetTransfer();
    setTransferSourceAgent(null);
    setTransferTargetAgent(null);

    return { success: true, newSessionId: targetSessionId, newTabId };
  }, [activeSession, sessions, setSessions, setActiveSessionId, addToast, resetTransfer]);

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
  const handleSummarizeAndContinue = useCallback((tabId?: string) => {
    if (!activeSession || activeSession.inputMode !== 'ai') return;

    const targetTabId = tabId || activeSession.activeTabId;
    const targetTab = activeSession.aiTabs.find(t => t.id === targetTabId);

    if (!targetTab || !canSummarize(activeSession.contextUsage)) {
      addToast({
        type: 'warning',
        title: 'Cannot Compact',
        message: `Context usage too low. Need at least ${minContextUsagePercent}% to compact.`,
      });
      return;
    }

    // Store session info for toast navigation
    const sourceSessionId = activeSession.id;
    const sourceSessionName = activeSession.name;

    startSummarize(targetTabId).then((result) => {
      if (result) {
        // Update session with the new tab
        setSessions(prev => prev.map(s =>
          s.id === sourceSessionId ? result.updatedSession : s
        ));

        // Add system log entry to the SOURCE tab's history
        setSessions(prev => prev.map(s => {
          if (s.id !== sourceSessionId) return s;
          return {
            ...s,
            aiTabs: s.aiTabs.map(tab =>
              tab.id === targetTabId
                ? { ...tab, logs: [...tab.logs, result.systemLogEntry] }
                : tab
            )
          };
        }));

        // Show success notification with click-to-navigate
        const reductionPercent = result.systemLogEntry.text.match(/(\d+)%/)?.[1] ?? '0';
        addToast({
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
  }, [activeSession, canSummarize, minContextUsagePercent, startSummarize, setSessions, addToast, clearTabState]);

  // Combine custom AI commands with spec-kit and openspec commands for input processing (slash command execution)
  // This ensures speckit and openspec commands are processed the same way as custom commands
  const allCustomCommands = useMemo((): CustomAICommand[] => {
    // Convert speckit commands to CustomAICommand format
    const speckitAsCustom: CustomAICommand[] = speckitCommands.map(cmd => ({
      id: `speckit-${cmd.id}`,
      command: cmd.command,
      description: cmd.description,
      prompt: cmd.prompt,
      isBuiltIn: true, // Speckit commands are built-in (bundled)
    }));
    // Convert openspec commands to CustomAICommand format
    const openspecAsCustom: CustomAICommand[] = openspecCommands.map(cmd => ({
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
    const customCommandsAsSlash = customAICommands
      .map(cmd => ({
        command: cmd.command,
        description: cmd.description,
        aiOnly: true, // Custom AI commands are only available in AI mode
        prompt: cmd.prompt, // Include prompt for execution
      }));
    // Spec Kit commands (bundled from github/spec-kit)
    const speckitCommandsAsSlash = speckitCommands
      .map(cmd => ({
        command: cmd.command,
        description: cmd.description,
        aiOnly: true, // Spec-kit commands are only available in AI mode
        prompt: cmd.prompt, // Include prompt for execution
        isSpeckit: true, // Mark as spec-kit command for special handling
      }));
    // OpenSpec commands (bundled from Fission-AI/OpenSpec)
    const openspecCommandsAsSlash = openspecCommands
      .map(cmd => ({
        command: cmd.command,
        description: cmd.description,
        aiOnly: true, // OpenSpec commands are only available in AI mode
        prompt: cmd.prompt, // Include prompt for execution
        isOpenspec: true, // Mark as openspec command for special handling
      }));
    // Only include agent-specific commands if the agent supports slash commands
    // This allows built-in and custom commands to be shown for all agents (Codex, OpenCode, etc.)
    const agentCommands = hasActiveSessionCapability('supportsSlashCommands')
      ? (activeSession?.agentCommands || []).map(cmd => ({
          command: cmd.command,
          description: cmd.description,
          aiOnly: true, // Agent commands are only available in AI mode
        }))
      : [];
    return [...slashCommands, ...customCommandsAsSlash, ...speckitCommandsAsSlash, ...openspecCommandsAsSlash, ...agentCommands];
  }, [customAICommands, speckitCommands, openspecCommands, activeSession?.agentCommands, hasActiveSessionCapability]);

  // Derive current input value and setter based on active session mode
  // For AI mode: use active tab's inputValue (stored per-tab)
  // For terminal mode: use local state (shared across tabs)
  const isAiMode = activeSession?.inputMode === 'ai';
  const activeTab = activeSession ? getActiveTab(activeSession) : undefined;
  const isResumingSession = !!activeTab?.agentSessionId;
  const canAttachImages = useMemo(() => {
    if (!activeSession || activeSession.inputMode !== 'ai') return false;
    return isResumingSession
      ? hasActiveSessionCapability('supportsImageInputOnResume')
      : hasActiveSessionCapability('supportsImageInput');
  }, [activeSession, isResumingSession, hasActiveSessionCapability]);
  const blockCodexResumeImages = !!activeSession
    && activeSession.toolType === 'codex'
    && isResumingSession
    && !hasActiveSessionCapability('supportsImageInputOnResume');

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
        setSessions(prev => prev.map(s => ({
          ...s,
          aiTabs: s.aiTabs.map(tab =>
            tab.id === prevTabId ? { ...tab, inputValue: aiInputValueLocal } : tab
          )
        })));
      }

      // Tab changed - load the new tab's persisted input value
      setAiInputValueLocal(activeTab.inputValue ?? '');
      prevActiveTabIdRef.current = activeTab.id;

      // Clear hasUnread indicator on the newly active tab
      // This is the central place that handles all tab switches regardless of how they happen
      // (click, keyboard shortcut, programmatic, etc.)
      if (activeTab.hasUnread && activeSession) {
        setSessions(prev => prev.map(s => {
          if (s.id !== activeSession.id) return s;
          return {
            ...s,
            aiTabs: s.aiTabs.map(t =>
              t.id === activeTab.id ? { ...t, hasUnread: false } : t
            )
          };
        }));
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
        setSessions(prev => prev.map(s =>
          s.id === prevSessionId ? { ...s, terminalDraftInput: terminalInputValue } : s
        ));
      }

      // Load terminal input from the new session
      setTerminalInputValue(activeSession.terminalDraftInput ?? '');

      // Update ref to current session
      prevActiveSessionIdRef.current = activeSession.id;
    }
     
  }, [activeSession?.id]);

  // Use local state for responsive typing - no session state update on every keystroke
  const inputValue = isAiMode ? aiInputValueLocal : terminalInputValue;
  const setInputValue = isAiMode ? setAiInputValueLocal : setTerminalInputValue;

  // Images are stored per-tab and only used in AI mode
  // Get staged images from the active tab
  const stagedImages = useMemo(() => {
    if (!activeSession || activeSession.inputMode !== 'ai') return [];
    const activeTab = getActiveTab(activeSession);
    return activeTab?.stagedImages || [];
     
  }, [activeSession?.aiTabs, activeSession?.activeTabId, activeSession?.inputMode]);

  // Set staged images on the active tab
  const setStagedImages = useCallback((imagesOrUpdater: string[] | ((prev: string[]) => string[])) => {
    if (!activeSession) return;
    setSessions(prev => prev.map(s => {
      if (s.id !== activeSession.id) return s;
      return {
        ...s,
        aiTabs: s.aiTabs.map(tab => {
          if (tab.id !== s.activeTabId) return tab;
          const currentImages = tab.stagedImages || [];
          const newImages = typeof imagesOrUpdater === 'function'
            ? imagesOrUpdater(currentImages)
            : imagesOrUpdater;
          return { ...tab, stagedImages: newImages };
        })
      };
    }));
  }, [activeSession]);

  // Helper to add a log entry to a specific tab's logs (or active tab if no tabId provided)
  // Used for slash commands, system messages, queued items, etc.
  // This centralizes the logic for routing logs to the correct tab
  const addLogToTab = useCallback((
    sessionId: string,
    logEntry: Omit<LogEntry, 'id' | 'timestamp'> & { id?: string; timestamp?: number },
    tabId?: string // Optional: if not provided, uses active tab
  ) => {
    const entry: LogEntry = {
      id: logEntry.id || generateId(),
      timestamp: logEntry.timestamp || Date.now(),
      source: logEntry.source,
      text: logEntry.text,
      ...(logEntry.images && { images: logEntry.images }),
      ...(logEntry.delivered !== undefined && { delivered: logEntry.delivered }),
      ...('aiCommand' in logEntry && logEntry.aiCommand && { aiCommand: logEntry.aiCommand })
    };

    setSessions(prev => prev.map(s => {
      if (s.id !== sessionId) return s;

      // Use specified tab or fall back to active tab
      const targetTab = tabId
        ? s.aiTabs.find(tab => tab.id === tabId)
        : getActiveTab(s);

      if (!targetTab) {
        // No tabs exist - this is a bug, sessions must have aiTabs
        console.error('[addLogToTab] No target tab found - session has no aiTabs, this should not happen');
        return s;
      }

      // Update target tab's logs
      const updatedAiTabs = s.aiTabs.map(tab =>
        tab.id === targetTab.id ? { ...tab, logs: [...tab.logs, entry] } : tab
      );

      return { ...s, aiTabs: updatedAiTabs };
    }));
  }, []);

  // Convenience wrapper that always uses active tab (backward compatibility)
  const addLogToActiveTab = useCallback((
    sessionId: string,
    logEntry: Omit<LogEntry, 'id' | 'timestamp'> & { id?: string; timestamp?: number }
  ) => {
    addLogToTab(sessionId, logEntry);
  }, [addLogToTab]);

  // PERF: Extract only the properties we need to avoid re-memoizing on every session change
  // Note: activeSessionId already exists as state; we just need inputMode
  const activeSessionInputMode = activeSession?.inputMode;

  // Tab completion suggestions (must be after inputValue is defined)
  // PERF: Depend on specific session properties, not the entire activeSession object
  const tabCompletionSuggestions = useMemo(() => {
    if (!tabCompletionOpen || !activeSessionId || activeSessionInputMode !== 'terminal') {
      return [];
    }
    return getTabCompletionSuggestions(inputValue, tabCompletionFilter);
  }, [tabCompletionOpen, activeSessionId, activeSessionInputMode, inputValue, tabCompletionFilter, getTabCompletionSuggestions]);

  // @ mention suggestions for AI mode
  // PERF: Depend on specific session properties, not the entire activeSession object
  const atMentionSuggestions = useMemo(() => {
    if (!atMentionOpen || !activeSessionId || activeSessionInputMode !== 'ai') {
      return [];
    }
    return getAtMentionSuggestions(atMentionFilter);
  }, [atMentionOpen, activeSessionId, activeSessionInputMode, atMentionFilter, getAtMentionSuggestions]);

  // Sync file tree selection to match tab completion suggestion
  // This highlights the corresponding file/folder in the right panel when navigating tab completion
  const syncFileTreeToTabCompletion = useCallback((suggestion: TabCompletionSuggestion | undefined) => {
    if (!suggestion || suggestion.type === 'history' || flatFileList.length === 0) return;

    // Strip trailing slash from folder paths to match flatFileList format
    const targetPath = suggestion.value.replace(/\/$/, '');

    // Also handle paths with command prefix (e.g., "cd src/" -> "src")
    const pathOnly = targetPath.split(/\s+/).pop() || targetPath;

    const matchIndex = flatFileList.findIndex(item => item.fullPath === pathOnly);

    if (matchIndex >= 0) {
      fileTreeKeyboardNavRef.current = true; // Scroll to matched file
      setSelectedFileIndex(matchIndex);
      // Ensure Files tab is visible to show the highlight
      if (activeRightTab !== 'files') {
        setActiveRightTab('files');
      }
    }
  }, [flatFileList, activeRightTab]);

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
  const {
    addHistoryEntry,
    addHistoryEntryRef,
    handleJumpToAgentSession,
    handleResumeSession,
  } = useAgentSessionManagement({
    activeSession,
    setSessions,
    setActiveAgentSessionId,
    setAgentSessionsOpen,
    rightPanelRef,
    defaultSaveToHistory,
    defaultShowThinking,
  });

  // PERFORMANCE: Memoized callback for creating new agent sessions
  // Extracted from inline function to prevent MainPanel re-renders
  const handleNewAgentSession = useCallback(() => {
    // Create a fresh AI tab using functional setState to avoid stale closure
    setSessions(prev => {
      const currentSession = prev.find(s => s.id === activeSessionIdRef.current);
      if (!currentSession) return prev;
      return prev.map(s => {
        if (s.id !== currentSession.id) return s;
        const result = createTab(s, { saveToHistory: defaultSaveToHistory, showThinking: defaultShowThinking });
        if (!result) return s;
        return result.session;
      });
    });
    setActiveAgentSessionId(null);
    setAgentSessionsOpen(false);
  }, [defaultSaveToHistory, defaultShowThinking]);

  // PERFORMANCE: Memoized tab management callbacks
  // Extracted from inline functions to prevent MainPanel re-renders
  const handleTabSelect = useCallback((tabId: string) => {
    setSessions(prev => prev.map(s => {
      if (s.id !== activeSessionIdRef.current) return s;
      const result = setActiveTab(s, tabId);
      return result ? result.session : s;
    }));
  }, []);

  const handleTabClose = useCallback((tabId: string) => {
    setSessions(prev => prev.map(s => {
      if (s.id !== activeSessionIdRef.current) return s;
      // Note: showUnreadOnly is accessed via ref pattern if needed, or we accept this dep
      const result = closeTab(s, tabId, false); // Don't filter for unread during close
      return result ? result.session : s;
    }));
  }, []);

  const handleNewTab = useCallback(() => {
    setSessions(prev => prev.map(s => {
      if (s.id !== activeSessionIdRef.current) return s;
      const result = createTab(s, { saveToHistory: defaultSaveToHistory, showThinking: defaultShowThinking });
      if (!result) return s;
      return result.session;
    }));
  }, [defaultSaveToHistory, defaultShowThinking]);

  const handleRemoveQueuedItem = useCallback((itemId: string) => {
    setSessions(prev => prev.map(s => {
      if (s.id !== activeSessionIdRef.current) return s;
      return {
        ...s,
        executionQueue: s.executionQueue.filter(item => item.id !== itemId)
      };
    }));
  }, []);

  const handleOpenQueueBrowser = useCallback(() => {
    setQueueBrowserOpen(true);
  }, []);

  // Note: spawnBackgroundSynopsisRef and spawnAgentWithPromptRef are now updated in useAgentExecution hook

  // Initialize batch processor (supports parallel batches per session)
  const {
    batchRunStates: _batchRunStates,
    getBatchState,
    activeBatchSessionIds,
    startBatchRun,
    stopBatchRun,
    // Error handling (Phase 5.10)
    pauseBatchOnError,
    skipCurrentDocument,
    resumeAfterError,
    abortBatchOnError,
  } = useBatchProcessor({
    sessions,
    groups,
    onUpdateSession: (sessionId, updates) => {
      setSessions(prev => prev.map(s =>
        s.id === sessionId ? { ...s, ...updates } : s
      ));
    },
    onSpawnAgent: spawnAgentForSession,
    onAddHistoryEntry: async (entry) => {
      await window.maestro.history.add({
        ...entry,
        id: generateId()
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
      const session = sessions.find(s => s.id === info.sessionId);
      const sessionGroup = session?.groupId ? groups.find(g => g.id === session.groupId) : null;
      const groupName = sessionGroup?.name || 'Ungrouped';

      // Determine toast type and message based on completion status
      const _isSuccess = info.completedTasks > 0 && !info.wasStopped;
      const toastType = info.wasStopped ? 'warning' : (info.completedTasks === info.totalTasks ? 'success' : 'info');

      // Build message
      let message: string;
      if (info.wasStopped) {
        message = `Stopped after completing ${info.completedTasks} of ${info.totalTasks} tasks`;
      } else if (info.completedTasks === info.totalTasks) {
        message = `All ${info.totalTasks} ${info.totalTasks === 1 ? 'task' : 'tasks'} completed successfully`;
      } else {
        message = `Completed ${info.completedTasks} of ${info.totalTasks} tasks`;
      }

      addToast({
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
          const badge = newBadgeLevel !== null
            ? CONDUCTOR_BADGES.find(b => b.level === newBadgeLevel)
            : CONDUCTOR_BADGES.find(b => b.level === autoRunStats.currentBadgeLevel);

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
            window.maestro.leaderboard.submit({
              email: leaderboardRegistration.email,
              displayName: leaderboardRegistration.displayName,
              githubUsername: leaderboardRegistration.githubUsername,
              twitterHandle: leaderboardRegistration.twitterHandle,
              linkedinHandle: leaderboardRegistration.linkedinHandle,
              badgeLevel: updatedBadgeLevel,
              badgeName: updatedBadgeName,
              cumulativeTimeMs: updatedCumulativeTimeMs,
              totalRuns: updatedTotalRuns,
              longestRunMs: updatedLongestRunMs,
              longestRunDate,
              currentRunMs: info.elapsedTimeMs,
              theme: activeThemeId,
              authToken: leaderboardRegistration.authToken,
              // Delta mode for multi-device aggregation
              deltaMs: info.elapsedTimeMs,
              deltaRuns: 1,
            }).then(result => {
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
                  message = `You moved up ${spotsUp} spot${spotsUp > 1 ? 's' : ''}! Now #${cumulative.rank} (was #${cumulative.previousRank})`;
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

                addToastRef.current({
                  type: 'success',
                  title: 'Leaderboard Updated',
                  message,
                });
              }
            }
            // Silent failure - don't bother the user if submission fails
            }).catch(() => {
              // Silent failure - leaderboard submission is not critical
            });
          }
        }
      }
    },
    onPRResult: (info) => {
      // Find group name for the session
      const session = sessions.find(s => s.id === info.sessionId);
      const sessionGroup = session?.groupId ? groups.find(g => g.id === session.groupId) : null;
      const groupName = sessionGroup?.name || 'Ungrouped';

      if (info.success) {
        // PR created successfully - show success toast with PR URL
        addToast({
          type: 'success',
          title: 'PR Created',
          message: info.prUrl || 'Pull request created successfully',
          group: groupName,
          project: info.sessionName,
          sessionId: info.sessionId,
        });
      } else {
        // PR creation failed - show warning (not error, since the auto-run itself succeeded)
        addToast({
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
      const session = sessionsRef.current.find(s => s.id === sessionId);
      if (session && session.executionQueue.length > 0 && processQueuedItemRef.current) {
        // Pop first item and process it
        const [nextItem, ...remainingQueue] = session.executionQueue;

        // Update session state: set to busy, pop first item from queue
        setSessions(prev => prev.map(s => {
          if (s.id !== sessionId) return s;

          const targetTab = s.aiTabs.find(tab => tab.id === nextItem.tabId) || getActiveTab(s);
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
              images: nextItem.images
            };
            updatedAiTabs = s.aiTabs.map(tab =>
              tab.id === targetTab.id
                ? { ...tab, logs: [...tab.logs, logEntry], state: 'busy' as const }
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
        }));

        // Process the item after state update
        processQueuedItemRef.current(sessionId, nextItem);
      }
    }
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
        }
      );

      if (result.success && result.response) {
        // Parse the synopsis response
        const parsed = parseSynopsis(result.response);

        // Get group info for the history entry
        const group = groups.find(g => g.id === activeSession.groupId);
        const groupName = group?.name || 'Ungrouped';

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
        });

        // Update the pending log with success AND set lastSynopsisTime
        setSessions(prev => prev.map(s => {
          if (s.id !== activeSession.id) return s;
          return {
            ...s,
            aiTabs: s.aiTabs.map(tab => {
              if (tab.id !== activeTab.id) return tab;
              return {
                ...tab,
                lastSynopsisTime: synopsisTime, // Track when this synopsis was generated
                logs: tab.logs.map(log =>
                  log.id === pendingLog.id
                    ? { ...log, text: `Synopsis saved to history: ${parsed.shortSummary}` }
                    : log
                ),
              };
            }),
          };
        }));

        // Show toast
        addToast({
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
        setSessions(prev => prev.map(s => {
          if (s.id !== activeSession.id) return s;
          return {
            ...s,
            aiTabs: s.aiTabs.map(tab => {
              if (tab.id !== activeTab.id) return tab;
              return {
                ...tab,
                logs: tab.logs.map(log =>
                  log.id === pendingLog.id
                    ? { ...log, text: 'Failed to generate history synopsis. Try again.' }
                    : log
                ),
              };
            }),
          };
        }));
      }
    } catch (error) {
      console.error('[handleHistoryCommand] Error:', error);
      // Update the pending log with error
      setSessions(prev => prev.map(s => {
        if (s.id !== activeSession.id) return s;
        return {
          ...s,
          aiTabs: s.aiTabs.map(tab => {
            if (tab.id !== activeTab.id) return tab;
            return {
              ...tab,
              logs: tab.logs.map(log =>
                log.id === pendingLog.id
                  ? { ...log, text: `Error generating synopsis: ${(error as Error).message}` }
                  : log
              ),
            };
          }),
        };
      }));
    }
  }, [activeSession, groups, spawnBackgroundSynopsis, addHistoryEntry, addLogToActiveTab, setSessions, addToast]);

  // Input processing hook - handles sending messages and commands
  const { processInput, processInputRef: _processInputRef } = useInputProcessing({
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
  });

  // Initialize activity tracker for per-session time tracking
  useActivityTracker(activeSessionId, setSessions);

  // Initialize global hands-on time tracker (persists to settings)
  // Tracks total time user spends actively using Maestro (5-minute idle timeout)
  useHandsOnTimeTracker(updateGlobalStats);

  // Track elapsed time for active auto-runs and update achievement stats every minute
  // This allows badges to be unlocked during an auto-run, not just when it completes
  const autoRunProgressRef = useRef<{ lastUpdateTime: number }>({ lastUpdateTime: 0 });

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
        const badge = CONDUCTOR_BADGES.find(b => b.level === newBadgeLevel);
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
    const activeAgents = sessions.filter(s => s.toolType !== 'terminal').length;

    // Count busy sessions (currently processing)
    const busySessions = sessions.filter(s => s.state === 'busy').length;

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

  // Memoize worktree config key to avoid complex expression in dependency array
  const worktreeConfigKey = useMemo(() =>
    sessions.map(s => `${s.id}:${s.worktreeConfig?.basePath}:${s.worktreeConfig?.watchEnabled}`).join(','),
    [sessions]
  );

  // File watcher for worktree directories - provides immediate detection
  // This is more efficient than polling and gives real-time results
  useEffect(() => {
    // Find sessions that have worktreeConfig with watchEnabled
    const watchableSessions = sessions.filter(s =>
      s.worktreeConfig?.basePath && s.worktreeConfig?.watchEnabled
    );

    // Start watchers for each session
    for (const session of watchableSessions) {
      window.maestro.git.watchWorktreeDirectory(session.id, session.worktreeConfig!.basePath);
    }

    // Set up listener for discovered worktrees
    const cleanup = window.maestro.git.onWorktreeDiscovered(async (data) => {
      const { sessionId, worktree } = data;

      // Skip main/master/HEAD branches (already filtered by main process, but double-check)
      if (worktree.branch === 'main' || worktree.branch === 'master' || worktree.branch === 'HEAD') {
        return;
      }

      // Get current sessions to check for duplicates
      const currentSessions = sessionsRef.current;

      // Find the parent session
      const parentSession = currentSessions.find(s => s.id === sessionId);
      if (!parentSession) return;

      // Check if session already exists for this worktree
      // Normalize paths for comparison (remove trailing slashes)
      const normalizedWorktreePath = worktree.path.replace(/\/+$/, '');
      const existingSession = currentSessions.find(s => {
        const normalizedCwd = s.cwd.replace(/\/+$/, '');
        // Check if same path (regardless of parent) or same branch under same parent
        return normalizedCwd === normalizedWorktreePath ||
          (s.parentSessionId === sessionId && s.worktreeBranch === worktree.branch);
      });
      if (existingSession) return;

      // Create new worktree session
      const newId = generateId();
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
        saveToHistory: defaultSaveToHistory
      };

      // Get SSH remote ID for remote git operations
      const sshRemoteId = parentSession.sshRemoteId || parentSession.sessionSshRemoteConfig?.remoteId || undefined;

      // Fetch git info (via SSH for remote sessions)
      let gitBranches: string[] | undefined;
      let gitTags: string[] | undefined;
      let gitRefsCacheTime: number | undefined;

      try {
        [gitBranches, gitTags] = await Promise.all([
          gitService.getBranches(worktree.path, sshRemoteId),
          gitService.getTags(worktree.path, sshRemoteId)
        ]);
        gitRefsCacheTime = Date.now();
      } catch {
        // Ignore errors
      }

      const worktreeSession: Session = {
        id: newId,
        name: worktree.branch || worktree.name,
        groupId: parentSession.groupId,  // Inherit group from parent
        toolType: parentSession.toolType,
        state: 'idle',
        cwd: worktree.path,
        fullPath: worktree.path,
        projectRoot: worktree.path,
        isGitRepo: true,
        gitBranches,
        gitTags,
        gitRefsCacheTime,
        parentSessionId: sessionId,
        worktreeBranch: worktree.branch || undefined,
        aiLogs: [],
        shellLogs: [{ id: generateId(), timestamp: Date.now(), source: 'system', text: 'Worktree Session Ready.' }],
        workLog: [],
        contextUsage: 0,
        inputMode: parentSession.toolType === 'terminal' ? 'terminal' : 'ai',
        aiPid: 0,
        terminalPid: 0,
        port: 3000 + Math.floor(Math.random() * 100),
        isLive: false,
        changedFiles: [],
        fileTree: [],
        fileExplorerExpanded: [],
        fileExplorerScrollPos: 0,
        fileTreeAutoRefreshInterval: 180,
        shellCwd: worktree.path,
        aiCommandHistory: [],
        shellCommandHistory: [],
        executionQueue: [],
        activeTimeMs: 0,
        aiTabs: [initialTab],
        activeTabId: initialTabId,
        closedTabHistory: [],
        customPath: parentSession.customPath,
        customArgs: parentSession.customArgs,
        customEnvVars: parentSession.customEnvVars,
        customModel: parentSession.customModel,
        customContextWindow: parentSession.customContextWindow,
        nudgeMessage: parentSession.nudgeMessage,
        autoRunFolderPath: parentSession.autoRunFolderPath,
        // Inherit SSH configuration from parent session
        sessionSshRemoteConfig: parentSession.sessionSshRemoteConfig,
      };

      setSessions(prev => {
        // Double-check to avoid duplicates
        if (prev.some(s => s.cwd === worktree.path)) return prev;
        return [...prev, worktreeSession];
      });

      // Expand parent's worktrees
      setSessions(prev => prev.map(s =>
        s.id === sessionId ? { ...s, worktreesExpanded: true } : s
      ));

      addToast({
        type: 'success',
        title: 'New Worktree Discovered',
        message: worktree.branch || worktree.name,
      });
    });

    // Cleanup: stop watchers and remove listener
    return () => {
      cleanup();
      for (const session of watchableSessions) {
        window.maestro.git.unwatchWorktreeDirectory(session.id);
      }
    };
   
  }, [
    // Re-run when worktreeConfig changes on any session
    worktreeConfigKey,
    defaultSaveToHistory
  ]);

  // Legacy: Scanner for sessions using old worktreeParentPath
  // TODO: Remove after migration to new parent/child model (use worktreeConfig with file watchers instead)
  // PERFORMANCE: Only scan on app focus (visibility change) instead of continuous polling
  // This avoids blocking the main thread every 30 seconds during active use
  useEffect(() => {
    // Check if any sessions use the legacy worktreeParentPath model
    const hasLegacyWorktreeSessions = sessions.some(s => s.worktreeParentPath);
    if (!hasLegacyWorktreeSessions) return;

    // Track if we're currently scanning to avoid overlapping scans
    let isScanning = false;

    const scanWorktreeParents = async () => {
      if (isScanning) return;
      isScanning = true;

      try {
        // Find sessions that have worktreeParentPath set (legacy model)
        const worktreeParentSessions = sessionsRef.current.filter(s => s.worktreeParentPath);
        if (worktreeParentSessions.length === 0) return;

        // Collect all new sessions to add in a single batch (avoids stale closure issues)
        const newSessionsToAdd: Session[] = [];
        // Track paths we're about to add to avoid duplicates within this scan
        const pathsBeingAdded = new Set<string>();

        for (const session of worktreeParentSessions) {
          try {
            // Get SSH remote ID for parent session (check both runtime and config)
            const parentSshRemoteId = session.sshRemoteId || session.sessionSshRemoteConfig?.remoteId || undefined;
            const result = await window.maestro.git.scanWorktreeDirectory(session.worktreeParentPath!, parentSshRemoteId);
            const { gitSubdirs } = result;

            for (const subdir of gitSubdirs) {
              // Skip if this path was manually removed by the user (use ref for current value)
              const currentRemovedPaths = removedWorktreePathsRef.current;
              if (currentRemovedPaths.has(subdir.path)) {
                continue;
              }

              // Skip if session already exists (check current sessions via ref)
              const currentSessions = sessionsRef.current;
              const existingSession = currentSessions.find(s => s.cwd === subdir.path || s.projectRoot === subdir.path);
              if (existingSession) {
                continue;
              }

              // Skip if we're already adding this path in this scan batch
              if (pathsBeingAdded.has(subdir.path)) {
                continue;
              }

              // Found a new worktree - prepare session creation
              pathsBeingAdded.add(subdir.path);

              const sessionName = subdir.branch
                ? `${subdir.name} (${subdir.branch})`
                : subdir.name;

              const newId = generateId();
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
                saveToHistory: defaultSaveToHistory
              };

              // Fetch git info (with SSH support)
              let gitBranches: string[] | undefined;
              let gitTags: string[] | undefined;
              let gitRefsCacheTime: number | undefined;

              try {
                [gitBranches, gitTags] = await Promise.all([
                  gitService.getBranches(subdir.path, parentSshRemoteId),
                  gitService.getTags(subdir.path, parentSshRemoteId)
                ]);
                gitRefsCacheTime = Date.now();
              } catch {
                // Ignore errors
              }

              const newSession: Session = {
                id: newId,
                name: sessionName,
                groupId: session.groupId,
                toolType: session.toolType,
                state: 'idle',
                cwd: subdir.path,
                fullPath: subdir.path,
                projectRoot: subdir.path,
                isGitRepo: true,
                gitBranches,
                gitTags,
                gitRefsCacheTime,
                worktreeParentPath: session.worktreeParentPath,
                // Inherit SSH configuration from parent session
                sessionSshRemoteConfig: session.sessionSshRemoteConfig,
                aiLogs: [],
                shellLogs: [{ id: generateId(), timestamp: Date.now(), source: 'system', text: 'Shell Session Ready.' }],
                workLog: [],
                contextUsage: 0,
                inputMode: session.inputMode,
                aiPid: 0,
                terminalPid: 0,
                port: 3000 + Math.floor(Math.random() * 100),
                isLive: false,
                changedFiles: [],
                fileTree: [],
                fileExplorerExpanded: [],
                fileExplorerScrollPos: 0,
                fileTreeAutoRefreshInterval: 180,
                shellCwd: subdir.path,
                aiCommandHistory: [],
                shellCommandHistory: [],
                executionQueue: [],
                activeTimeMs: 0,
                aiTabs: [initialTab],
                activeTabId: initialTabId,
                closedTabHistory: [],
                customPath: session.customPath,
                customArgs: session.customArgs,
                customEnvVars: session.customEnvVars,
                customModel: session.customModel
              };

              newSessionsToAdd.push(newSession);
            }
          } catch (error) {
            console.error(`[WorktreeScanner] Error scanning ${session.worktreeParentPath}:`, error);
          }
        }

        // Add all new sessions in a single update (uses functional update to get fresh state)
        if (newSessionsToAdd.length > 0) {
          setSessions(prev => {
            // Double-check against current state to avoid duplicates
            const currentPaths = new Set(prev.map(s => s.cwd));
            const trulyNew = newSessionsToAdd.filter(s => !currentPaths.has(s.cwd));
            if (trulyNew.length === 0) return prev;
            return [...prev, ...trulyNew];
          });

          for (const session of newSessionsToAdd) {
            addToast({
              type: 'success',
              title: 'New Worktree Discovered',
              message: session.name,
            });
          }
        }
      } finally {
        isScanning = false;
      }
    };

    // Scan once on mount
    scanWorktreeParents();

    // Scan when app regains focus (visibility change) instead of polling
    // This is much more efficient - only scans when user returns to app
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        scanWorktreeParents();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };

  }, [sessions.some(s => s.worktreeParentPath), defaultSaveToHistory]); // Only re-run when legacy sessions exist/don't exist

  // Handler to open batch runner modal
  const handleOpenBatchRunner = useCallback(() => {
    setBatchRunnerModalOpen(true);
  }, []);

  // Handler to open marketplace modal
  const handleOpenMarketplace = useCallback(() => {
    setMarketplaceModalOpen(true);
  }, [setMarketplaceModalOpen]);

  // Handler for switching to autorun tab - shows setup modal if no folder configured
  const handleSetActiveRightTab = useCallback((tab: RightPanelTab) => {
    if (tab === 'autorun' && activeSession && !activeSession.autoRunFolderPath) {
      // No folder configured - show setup modal
      setAutoRunSetupModalOpen(true);
      // Still switch to the tab (it will show an empty state or the modal)
      setActiveRightTab(tab);
    } else {
      setActiveRightTab(tab);
    }
  }, [activeSession]);

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
  const handleMarketplaceImportComplete = useCallback(async (folderName: string) => {
    // Refresh the Auto Run document list to show newly imported documents
    if (activeSession?.autoRunFolderPath) {
      handleAutoRunRefresh();
    }
    addToast({
      type: 'success',
      title: 'Playbook Imported',
      message: `Successfully imported playbook to ${folderName}`,
    });
  }, [activeSession?.autoRunFolderPath, handleAutoRunRefresh, addToast]);

  // File tree auto-refresh interval change handler (kept in App.tsx as it's not Auto Run specific)
  const handleAutoRefreshChange = useCallback((interval: number) => {
    if (!activeSession) return;
    setSessions(prev => prev.map(s =>
      s.id === activeSession.id ? { ...s, fileTreeAutoRefreshInterval: interval } : s
    ));
  }, [activeSession]);

  // Handler to stop batch run (with confirmation)
  // If targetSessionId is provided, stops that specific session's batch run.
  // Otherwise, stops the first active batch run or falls back to active session.
  const handleStopBatchRun = useCallback((targetSessionId?: string) => {
    // Use provided targetSessionId, or fall back to first active batch, or active session
    const sessionId = targetSessionId
      ?? (activeBatchSessionIds.length > 0 ? activeBatchSessionIds[0] : activeSession?.id);
    if (!sessionId) return;
    const session = sessions.find(s => s.id === sessionId);
    const agentName = session?.name || 'this session';
    setConfirmModalMessage(`Stop Auto Run for "${agentName}" after the current task completes?`);
    setConfirmModalOnConfirm(() => () => stopBatchRun(sessionId));
    setConfirmModalOpen(true);
  }, [activeBatchSessionIds, activeSession, sessions, stopBatchRun]);

  // Error handling callbacks for Auto Run (Phase 5.10)
  const handleSkipCurrentDocument = useCallback(() => {
    const sessionId = activeBatchSessionIds.length > 0
      ? activeBatchSessionIds[0]
      : activeSession?.id;
    if (!sessionId) return;
    skipCurrentDocument(sessionId);
    // Clear the session error state as well
    handleClearAgentError(sessionId);
  }, [activeBatchSessionIds, activeSession, skipCurrentDocument, handleClearAgentError]);

  const handleResumeAfterError = useCallback(() => {
    const sessionId = activeBatchSessionIds.length > 0
      ? activeBatchSessionIds[0]
      : activeSession?.id;
    if (!sessionId) return;
    resumeAfterError(sessionId);
    // Clear the session error state as well
    handleClearAgentError(sessionId);
  }, [activeBatchSessionIds, activeSession, resumeAfterError, handleClearAgentError]);

  const handleAbortBatchOnError = useCallback(() => {
    const sessionId = activeBatchSessionIds.length > 0
      ? activeBatchSessionIds[0]
      : activeSession?.id;
    if (!sessionId) return;
    abortBatchOnError(sessionId);
    // Clear the session error state as well
    handleClearAgentError(sessionId);
  }, [activeBatchSessionIds, activeSession, abortBatchOnError, handleClearAgentError]);

  // Handler for toast navigation - switches to session and optionally to a specific tab
  const handleToastSessionClick = useCallback((sessionId: string, tabId?: string) => {
    // Switch to the session
    setActiveSessionId(sessionId);
    // If a tab ID is provided, switch to that tab within the session
    if (tabId) {
      setSessions(prev => prev.map(s => {
        if (s.id !== sessionId) return s;
        // Check if tab exists
        if (!s.aiTabs?.some(t => t.id === tabId)) {
          return s;
        }
        return { ...s, activeTabId: tabId, inputMode: 'ai' };
      }));
    }
  }, [setActiveSessionId]);

  // Handler to open lightbox with optional context images for navigation
  // source: 'staged' allows deletion, 'history' is read-only
  const handleSetLightboxImage = useCallback((image: string | null, contextImages?: string[], source: 'staged' | 'history' = 'history') => {
    // Capture state SYNCHRONOUSLY in refs before any state updates
    // This ensures values are available immediately when the component re-renders
    // React batches state updates, so refs are more reliable for immediate access
    lightboxIsGroupChatRef.current = activeGroupChatId !== null;
    lightboxAllowDeleteRef.current = source === 'staged';

    setLightboxImage(image);
    setLightboxImages(contextImages || []);
    setLightboxSource(source);
  }, [activeGroupChatId]);

  // --- GROUP CHAT HANDLERS ---

  const handleOpenGroupChat = useCallback(async (id: string) => {
    const chat = await window.maestro.groupChat.load(id);
    if (chat) {
      setActiveGroupChatId(id);
      const messages = await window.maestro.groupChat.getMessages(id);
      setGroupChatMessages(messages);

      // Restore the state for this specific chat from the per-chat state map
      // This prevents state from one chat bleeding into another when switching
      setGroupChatState(_prev => {
        const savedState = groupChatStates.get(id);
        return savedState ?? 'idle';
      });

      // Restore participant states for this chat
      const savedParticipantStates = allGroupChatParticipantStates.get(id);
      console.log(`[GroupChat:UI] handleOpenGroupChat: restoring participantStates for ${id}: ${savedParticipantStates ? JSON.stringify([...savedParticipantStates.entries()]) : 'none'}`);
      setParticipantStates(savedParticipantStates ?? new Map());

      // Load saved right tab preference for this group chat
      const savedTab = await window.maestro.settings.get(`groupChatRightTab:${id}`);
      if (savedTab === 'participants' || savedTab === 'history') {
        setGroupChatRightTab(savedTab);
      } else {
        setGroupChatRightTab('participants'); // Default
      }

      // Start moderator if not running - this initializes the session ID prefix
      const moderatorSessionId = await window.maestro.groupChat.startModerator(id);
      // Update the group chat state with the moderator session ID
      if (moderatorSessionId) {
        setGroupChats(prev => prev.map(c =>
          c.id === id ? { ...c, moderatorSessionId } : c
        ));
      }

      // Focus the input after the component renders
      setTimeout(() => {
        setActiveFocus('main');
        groupChatInputRef.current?.focus();
      }, 100);
    }
  }, [groupChatStates, allGroupChatParticipantStates]);

  const handleCloseGroupChat = useCallback(() => {
    setActiveGroupChatId(null);
    setGroupChatMessages([]);
    setGroupChatState('idle');
    setParticipantStates(new Map());
    setGroupChatError(null);
  }, []);

  // Handle right panel tab change with persistence
  const handleGroupChatRightTabChange = useCallback((tab: GroupChatRightTab) => {
    setGroupChatRightTab(tab);
    if (activeGroupChatId) {
      window.maestro.settings.set(`groupChatRightTab:${activeGroupChatId}`, tab);
    }
  }, [activeGroupChatId]);

  // Jump to a message in the group chat by timestamp
  const handleJumpToGroupChatMessage = useCallback((timestamp: number) => {
    // Use the messages ref to scroll to the target message
    groupChatMessagesRef.current?.scrollToMessage(timestamp);
  }, []);

  // Open the moderator session in the direct agent view
  const handleOpenModeratorSession = useCallback((moderatorSessionId: string) => {
    // Find the session that has this agent session ID
    const session = sessions.find(s =>
      s.aiTabs?.some(tab => tab.agentSessionId === moderatorSessionId)
    );

    if (session) {
      // Close group chat
      setActiveGroupChatId(null);
      setGroupChatMessages([]);
      setGroupChatState('idle');
      setParticipantStates(new Map());

      // Set the session as active
      setActiveSessionId(session.id);

      // Find and activate the tab with this agent session ID
      const tab = session.aiTabs?.find(t => t.agentSessionId === moderatorSessionId);
      if (tab) {
        setSessions(prev => prev.map(s =>
          s.id === session.id ? { ...s, activeTabId: tab.id } : s
        ));
      }
    }
  }, [sessions, setActiveSessionId]);

  const handleCreateGroupChat = useCallback(async (
    name: string,
    moderatorAgentId: string,
    moderatorConfig?: { customPath?: string; customArgs?: string; customEnvVars?: Record<string, string> }
  ) => {
    const chat = await window.maestro.groupChat.create(name, moderatorAgentId, moderatorConfig);
    setGroupChats(prev => [chat, ...prev]);
    setShowNewGroupChatModal(false);
    handleOpenGroupChat(chat.id);
  }, [handleOpenGroupChat]);

  const handleDeleteGroupChat = useCallback(async (id: string) => {
    await window.maestro.groupChat.delete(id);
    setGroupChats(prev => prev.filter(c => c.id !== id));
    if (activeGroupChatId === id) {
      handleCloseGroupChat();
    }
    setShowDeleteGroupChatModal(null);
  }, [activeGroupChatId, handleCloseGroupChat]);

  const handleRenameGroupChat = useCallback(async (id: string, newName: string) => {
    await window.maestro.groupChat.rename(id, newName);
    setGroupChats(prev => prev.map(c => c.id === id ? { ...c, name: newName } : c));
    setShowRenameGroupChatModal(null);
  }, []);

  const handleUpdateGroupChat = useCallback(async (
    id: string,
    name: string,
    moderatorAgentId: string,
    moderatorConfig?: { customPath?: string; customArgs?: string; customEnvVars?: Record<string, string> }
  ) => {
    const updated = await window.maestro.groupChat.update(id, {
      name,
      moderatorAgentId,
      moderatorConfig,
    });
    setGroupChats(prev => prev.map(c => c.id === id ? updated : c));
    setShowEditGroupChatModal(null);
  }, []);

  // --- GROUP CHAT MODAL HANDLERS ---
  // Stable callback handlers for AppGroupChatModals component
  const handleCloseNewGroupChatModal = useCallback(() => setShowNewGroupChatModal(false), []);
  const handleCloseDeleteGroupChatModal = useCallback(() => setShowDeleteGroupChatModal(null), []);
  const handleConfirmDeleteGroupChat = useCallback(() => {
    if (showDeleteGroupChatModal) {
      handleDeleteGroupChat(showDeleteGroupChatModal);
    }
  }, [showDeleteGroupChatModal, handleDeleteGroupChat]);
  const handleCloseRenameGroupChatModal = useCallback(() => setShowRenameGroupChatModal(null), []);
  const handleRenameGroupChatFromModal = useCallback((newName: string) => {
    if (showRenameGroupChatModal) {
      handleRenameGroupChat(showRenameGroupChatModal, newName);
    }
  }, [showRenameGroupChatModal, handleRenameGroupChat]);
  const handleCloseEditGroupChatModal = useCallback(() => setShowEditGroupChatModal(null), []);
  const handleCloseGroupChatInfo = useCallback(() => setShowGroupChatInfo(false), []);

  const handleSendGroupChatMessage = useCallback(async (content: string, images?: string[], readOnly?: boolean) => {
    if (!activeGroupChatId) return;

    // If group chat is busy, queue the message instead of sending immediately
    if (groupChatState !== 'idle') {
      const queuedItem: QueuedItem = {
        id: generateId(),
        timestamp: Date.now(),
        tabId: activeGroupChatId, // Use group chat ID as tab ID
        type: 'message',
        text: content,
        images: images ? [...images] : undefined,
        tabName: groupChats.find(c => c.id === activeGroupChatId)?.name || 'Group Chat',
        readOnlyMode: readOnly,
      };
      setGroupChatExecutionQueue(prev => [...prev, queuedItem]);
      return;
    }

    setGroupChatState('moderator-thinking');
    setGroupChatStates(prev => {
      const next = new Map(prev);
      next.set(activeGroupChatId, 'moderator-thinking');
      return next;
    });
    await window.maestro.groupChat.sendToModerator(activeGroupChatId, content, images, readOnly);
  }, [activeGroupChatId, groupChatState, groupChats]);

  // Handle draft message changes - update local state (persisted on switch/close)
  const handleGroupChatDraftChange = useCallback((draft: string) => {
    if (!activeGroupChatId) return;
    setGroupChats(prev => prev.map(c =>
      c.id === activeGroupChatId ? { ...c, draftMessage: draft } : c
    ));
  }, [activeGroupChatId]);

  // Handle removing an item from the group chat execution queue
  const handleRemoveGroupChatQueueItem = useCallback((itemId: string) => {
    setGroupChatExecutionQueue(prev => prev.filter(item => item.id !== itemId));
  }, []);

  // Handle reordering items in the group chat execution queue
  const handleReorderGroupChatQueueItems = useCallback((fromIndex: number, toIndex: number) => {
    setGroupChatExecutionQueue(prev => {
      const queue = [...prev];
      const [removed] = queue.splice(fromIndex, 1);
      queue.splice(toIndex, 0, removed);
      return queue;
    });
  }, []);

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
  const {
    keyboardHandlerRef,
    showSessionJumpNumbers,
  } = useMainKeyboardHandler();

  // Persist sessions to electron-store using debounced persistence (reduces disk writes from 100+/sec to <1/sec during streaming)
  // The hook handles: debouncing, flush-on-unmount, flush-on-visibility-change, flush-on-beforeunload
  const { flushNow: flushSessionPersistence } = useDebouncedPersistence(sessions, initialLoadComplete);

  // AppSessionModals handlers that depend on flushSessionPersistence
  const handleSaveEditAgent = useCallback((
    sessionId: string,
    name: string,
    nudgeMessage?: string,
    customPath?: string,
    customArgs?: string,
    customEnvVars?: Record<string, string>,
    customModel?: string,
    customContextWindow?: number,
    sessionSshRemoteConfig?: { enabled: boolean; remoteId: string | null; workingDirOverride?: string }
  ) => {
    setSessions(prev => prev.map(s => {
      if (s.id !== sessionId) return s;
      return { ...s, name, nudgeMessage, customPath, customArgs, customEnvVars, customModel, customContextWindow, sessionSshRemoteConfig };
    }));
  }, []);

  const handleRenameTab = useCallback((newName: string) => {
    if (!activeSession || !renameTabId) return;
    setSessions(prev => prev.map(s => {
      if (s.id !== activeSession.id) return s;
      // Find the tab to get its agentSessionId for persistence
      const tab = s.aiTabs.find(t => t.id === renameTabId);
      if (tab?.agentSessionId) {
        // Persist name to agent session metadata (async, fire and forget)
        // Use projectRoot (not cwd) for consistent session storage access
        const agentId = s.toolType || 'claude-code';
        if (agentId === 'claude-code') {
          window.maestro.claude.updateSessionName(
            s.projectRoot,
            tab.agentSessionId,
            newName || ''
          ).catch(err => console.error('Failed to persist tab name:', err));
        } else {
          window.maestro.agentSessions.setSessionName(
            agentId,
            s.projectRoot,
            tab.agentSessionId,
            newName || null
          ).catch(err => console.error('Failed to persist tab name:', err));
        }
        // Also update past history entries with this agentSessionId
        window.maestro.history.updateSessionName(
          tab.agentSessionId,
          newName || ''
        ).catch(err => console.error('Failed to update history session names:', err));
      }
      return {
        ...s,
        aiTabs: s.aiTabs.map(tab =>
          tab.id === renameTabId ? { ...tab, name: newName || null } : tab
        )
      };
    }));
  }, [activeSession, renameTabId]);

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
    if (activeSession && fileTreeContainerRef.current && activeSession.fileExplorerScrollPos !== undefined) {
      fileTreeContainerRef.current.scrollTop = activeSession.fileExplorerScrollPos;
    }
   
  }, [activeSessionId]); // Only restore on session switch, not on scroll position changes

  // Track navigation history when session or AI tab changes
  useEffect(() => {
    if (activeSession) {
      pushNavigation({
        sessionId: activeSession.id,
        tabId: activeSession.inputMode === 'ai' && activeSession.aiTabs?.length > 0 ? activeSession.activeTabId : undefined
      });
    }
   
  }, [activeSessionId, activeSession?.activeTabId]); // Track session and tab changes

  // Reset shortcuts search when modal closes
  useEffect(() => {
    if (!shortcutsHelpOpen) {
      setShortcutsSearchQuery('');
    }
  }, [shortcutsHelpOpen]);

  // Helper to count tasks in document content
  const countTasksInContent = useCallback((content: string): { completed: number; total: number } => {
    const completedRegex = /^[\s]*[-*]\s*\[x\]/gim;
    const uncheckedRegex = /^[\s]*[-*]\s*\[\s\]/gim;
    const completedMatches = content.match(completedRegex) || [];
    const uncheckedMatches = content.match(uncheckedRegex) || [];
    const completed = completedMatches.length;
    const total = completed + uncheckedMatches.length;
    return { completed, total };
  }, []);

  // Load task counts for all documents
  const loadTaskCounts = useCallback(async (folderPath: string, documents: string[], sshRemoteId?: string) => {
    const counts = new Map<string, { completed: number; total: number }>();

    // Load content and count tasks for each document in parallel
    await Promise.all(documents.map(async (docPath) => {
      try {
        const result = await window.maestro.autorun.readDoc(folderPath, docPath + '.md', sshRemoteId);
        if (result.success && result.content) {
          const taskCount = countTasksInContent(result.content);
          if (taskCount.total > 0) {
            counts.set(docPath, taskCount);
          }
        }
      } catch {
        // Ignore errors for individual documents
      }
    }));

    return counts;
  }, [countTasksInContent]);

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
      const sshRemoteId = activeSession.sshRemoteId || activeSession.sessionSshRemoteConfig?.remoteId || undefined;

      // Load document list
      setAutoRunIsLoadingDocuments(true);
      const listResult = await window.maestro.autorun.listDocs(activeSession.autoRunFolderPath, sshRemoteId);
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
        const newContent = contentResult.success ? (contentResult.content || '') : '';
        setSessions(prev => prev.map(s =>
          s.id === activeSession.id
            ? { ...s, autoRunContent: newContent, autoRunContentVersion: (s.autoRunContentVersion || 0) + 1 }
            : s
        ));
      }
    };

    loadAutoRunData();
  // Note: Use primitive values (remoteId) not object refs (sessionSshRemoteConfig) to avoid infinite re-render loops
  }, [activeSessionId, activeSession?.autoRunFolderPath, activeSession?.autoRunSelectedFile, activeSession?.sshRemoteId, activeSession?.sessionSshRemoteConfig?.remoteId, loadTaskCounts]);

  // File watching for Auto Run - watch whenever a folder is configured
  // Updates reflect immediately whether from batch runs, terminal commands, or external editors
  // Note: For SSH remote sessions, file watching via chokidar is not available.
  // The backend returns isRemote: true and the UI should use polling instead.
  useEffect(() => {
    const sessionId = activeSession?.id;
    const folderPath = activeSession?.autoRunFolderPath;
    const selectedFile = activeSession?.autoRunSelectedFile;
    // Get SSH remote ID for remote sessions (check both runtime and config values)
    const sshRemoteId = activeSession?.sshRemoteId || activeSession?.sessionSshRemoteConfig?.remoteId || undefined;

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
          setSessions(prev => prev.map(s =>
            s.id === sessionId
              ? {
                  ...s,
                  autoRunContent: contentResult.content || '',
                  autoRunContentVersion: (s.autoRunContentVersion || 0) + 1,
                }
              : s
          ));
        }
      }
    });

    // Cleanup: stop watching when folder changes or unmount
    return () => {
      window.maestro.autorun.unwatchFolder(folderPath);
      unsubscribe();
    };
  // Note: Use primitive values (remoteId) not object refs (sessionSshRemoteConfig) to avoid infinite re-render loops
  }, [activeSession?.id, activeSession?.autoRunFolderPath, activeSession?.autoRunSelectedFile, activeSession?.sshRemoteId, activeSession?.sessionSshRemoteConfig?.remoteId, loadTaskCounts]);

  // Auto-scroll logs
  const activeTabLogs = activeSession ? getActiveTab(activeSession)?.logs : undefined;
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'instant' });
  }, [activeTabLogs, activeSession?.shellLogs, activeSession?.inputMode]);

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
      sessions.filter(s => s.parentSessionId === parentId)
        .sort((a, b) => compareNamesIgnoringEmojis(a.worktreeBranch || a.name, b.worktreeBranch || b.name));

    // Helper to add session with its worktree children to visual order
    const addSessionWithWorktrees = (session: Session) => {
      // Skip worktree children - they're added with their parent
      if (session.parentSessionId) return;

      visualOrder.push({ type: 'session' as const, id: session.id, name: session.name });

      // Add worktree children if expanded
      if (session.worktreesExpanded !== false) {
        const children = getWorktreeChildren(session.id);
        visualOrder.push(...children.map(s => ({ type: 'session' as const, id: s.id, name: s.worktreeBranch || s.name })));
      }
    };

    if (leftSidebarOpen) {
      // Bookmarks section (if expanded and has bookmarked sessions)
      if (!bookmarksCollapsed) {
        const bookmarkedSessions = sessions
          .filter(s => s.bookmarked && !s.parentSessionId)
          .sort((a, b) => compareNamesIgnoringEmojis(a.name, b.name));
        bookmarkedSessions.forEach(addSessionWithWorktrees);
      }

      // Groups (sorted alphabetically), with each group's sessions
      const sortedGroups = [...groups].sort((a, b) => compareNamesIgnoringEmojis(a.name, b.name));
      for (const group of sortedGroups) {
        if (!group.collapsed) {
          const groupSessions = sessions
            .filter(s => s.groupId === group.id && !s.parentSessionId)
            .sort((a, b) => compareNamesIgnoringEmojis(a.name, b.name));
          groupSessions.forEach(addSessionWithWorktrees);
        }
      }

      // Ungrouped sessions (sorted alphabetically) - only if not collapsed
      if (!settings.ungroupedCollapsed) {
        const ungroupedSessions = sessions
          .filter(s => !s.groupId && !s.parentSessionId)
          .sort((a, b) => compareNamesIgnoringEmojis(a.name, b.name));
        ungroupedSessions.forEach(addSessionWithWorktrees);
      }

      // Group Chats section (if expanded and has group chats)
      if (groupChatsExpanded && groupChats.length > 0) {
        const sortedGroupChats = [...groupChats].sort((a, b) =>
          a.name.toLowerCase().localeCompare(b.name.toLowerCase())
        );
        visualOrder.push(...sortedGroupChats.map(gc => ({ type: 'groupChat' as const, id: gc.id, name: gc.name })));
      }
    } else {
      // Sidebar collapsed: cycle through all sessions in their sorted order
      visualOrder.push(...sortedSessions.map(s => ({ type: 'session' as const, id: s.id, name: s.name })));
    }

    if (visualOrder.length === 0) return;

    // Determine what is currently active (session or group chat)
    const currentActiveId = activeGroupChatId || activeSessionId;
    const currentIsGroupChat = activeGroupChatId !== null;

    // Determine current position in visual order
    // If cyclePositionRef is valid and points to our current item, use it
    // Otherwise, find the first occurrence of our current item
    let currentIndex = cyclePositionRef.current;
    if (currentIndex < 0 || currentIndex >= visualOrder.length ||
        visualOrder[currentIndex].id !== currentActiveId) {
      // Position is invalid or doesn't match current item - find first occurrence
      currentIndex = visualOrder.findIndex(item =>
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

  const showConfirmation = (message: string, onConfirm: () => void) => {
    setConfirmModalMessage(message);
    setConfirmModalOnConfirm(() => onConfirm);
    setConfirmModalOpen(true);
  };

  // Delete group chat with confirmation dialog (for keyboard shortcut and CMD+K)
  const deleteGroupChatWithConfirmation = useCallback((id: string) => {
    const chat = groupChats.find(c => c.id === id);
    if (!chat) return;

    showConfirmation(
      `Are you sure you want to delete the group chat "${chat.name}"? This action cannot be undone.`,
      async () => {
        await window.maestro.groupChat.delete(id);
        setGroupChats(prev => prev.filter(c => c.id !== id));
        if (activeGroupChatId === id) {
          handleCloseGroupChat();
        }
      }
    );
  }, [groupChats, activeGroupChatId, handleCloseGroupChat]);

  const deleteSession = (id: string) => {
    const session = sessions.find(s => s.id === id);
    if (!session) return;

    showConfirmation(
      `Are you sure you want to delete the agent "${session.name}"? This action cannot be undone.`,
      async () => {
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
          setRemovedWorktreePaths(prev => new Set([...prev, session.cwd]));
        }

        const newSessions = sessions.filter(s => s.id !== id);
        setSessions(newSessions);
        // Flush immediately for critical operation (session deletion)
        // Note: flushSessionPersistence will pick up the latest state via ref
        setTimeout(() => flushSessionPersistence(), 0);
        if (newSessions.length > 0) {
          setActiveSessionId(newSessions[0].id);
        } else {
          setActiveSessionId('');
        }
      }
    );
  };

  // Delete an entire worktree group and all its agents
  const deleteWorktreeGroup = (groupId: string) => {
    const group = groups.find(g => g.id === groupId);
    if (!group) return;

    const groupSessions = sessions.filter(s => s.groupId === groupId);
    const sessionCount = groupSessions.length;

    showConfirmation(
      `Are you sure you want to remove the group "${group.name}" and all ${sessionCount} agent${sessionCount !== 1 ? 's' : ''} in it? This action cannot be undone.`,
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
          .filter(s => s.worktreeParentPath && s.cwd)
          .map(s => s.cwd);

        if (pathsToTrack.length > 0) {
          setRemovedWorktreePaths(prev => new Set([...prev, ...pathsToTrack]));
        }

        // Remove all sessions in the group
        const sessionIdsToRemove = new Set(groupSessions.map(s => s.id));
        const newSessions = sessions.filter(s => !sessionIdsToRemove.has(s.id));
        setSessions(newSessions);

        // Remove the group
        setGroups(prev => prev.filter(g => g.id !== groupId));

        // Flush immediately for critical operation
        setTimeout(() => flushSessionPersistence(), 0);

        // Switch to another session if needed
        if (sessionIdsToRemove.has(activeSessionId) && newSessions.length > 0) {
          setActiveSessionId(newSessions[0].id);
        } else if (newSessions.length === 0) {
          setActiveSessionId('');
        }

        addToast({
          type: 'success',
          title: 'Group Removed',
          message: `Removed "${group.name}" and ${sessionCount} agent${sessionCount !== 1 ? 's' : ''}`,
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
    sessionSshRemoteConfig?: { enabled: boolean; remoteId: string | null; workingDirOverride?: string }
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
        addToast({
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
            gitService.getTags(workingDir)
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
        saveToHistory: defaultSaveToHistory
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
        shellLogs: [{ id: generateId(), timestamp: Date.now(), source: 'system', text: 'Shell Session Ready.' }],
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
        sessionSshRemoteConfig
      };
      setSessions(prev => [...prev, newSession]);
      setActiveSessionId(newId);
      // Track session creation in global stats
      updateGlobalStats({ totalSessions: 1 });
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
  const handleWizardLaunchSession = useCallback(async (wantsTour: boolean) => {
    // Get wizard state
    const { selectedAgent, directoryPath, agentName, generatedDocuments, customPath, customArgs, customEnvVars, sessionSshRemoteConfig } = wizardState;

    if (!selectedAgent || !directoryPath) {
      console.error('Wizard launch failed: missing agent or directory');
      throw new Error('Missing required wizard data');
    }

    // Create the session
    const newId = generateId();
    const sessionName = agentName || `${selectedAgent} Session`;

    // Validate uniqueness before creating
    const validation = validateNewSession(sessionName, directoryPath, selectedAgent as ToolType, sessions);
    if (!validation.valid) {
      console.error(`Wizard session validation failed: ${validation.error}`);
      addToast({
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
        gitService.getTags(directoryPath, wizardSshRemoteId)
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
      saveToHistory: defaultSaveToHistory
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
      shellLogs: [{ id: generateId(), timestamp: Date.now(), source: 'system', text: 'Shell Session Ready.' }],
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
    setSessions(prev => [...prev, newSession]);
    setActiveSessionId(newId);
    updateGlobalStats({ totalSessions: 1 });

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
    const firstDocWithTasks = generatedDocuments.find(doc => doc.taskCount > 0);
    if (firstDocWithTasks && autoRunFolderPath) {
      // Create batch config for single document run
      const batchConfig: BatchRunConfig = {
        documents: [{
          id: generateId(),
          filename: firstDocWithTasks.filename.replace(/\.md$/, ''),
          resetOnCompletion: false,
          isDuplicate: false,
        }],
        prompt: DEFAULT_BATCH_PROMPT,
        loopEnabled: false,
      };

      // Small delay to ensure session state is fully propagated before starting batch
      setTimeout(() => {
        console.log('[Wizard] Auto-starting batch run with first document:', firstDocWithTasks.filename);
        startBatchRun(newId, batchConfig, autoRunFolderPath);
      }, 500);
    }
  }, [
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
    addToast,
  ]);

  /**
   * Initialize a merged session with context from groomed logs.
   * Spawns the agent process and optionally sends an initial context prompt.
   *
   * This is the second step after createMergedSession() - it integrates the
   * session into app state and spawns the AI process.
   *
   * @param session - The pre-created session from createMergedSession()
   * @param contextSummary - Optional initial prompt to send to establish context
   *                         (e.g., "Here's a summary of our previous conversations...")
   * @returns Promise that resolves when the session is initialized
   */
  const _initializeMergedSession = useCallback(async (
    session: Session,
    contextSummary?: string
  ) => {
    // Add session to app state
    setSessions(prev => [...prev, session]);
    setActiveSessionId(session.id);

    // Track session creation in global stats
    updateGlobalStats({ totalSessions: 1 });

    // Get SSH remote ID for remote git operations
    // Note: sshRemoteId is only set after AI agent spawns. For terminal-only SSH sessions,
    // we must fall back to sessionSshRemoteConfig.remoteId. See CLAUDE.md "SSH Remote Sessions".
    const sshRemoteId = session.sshRemoteId || session.sessionSshRemoteConfig?.remoteId || undefined;

    // Check if this is a git repo and update git info (via SSH for remote sessions)
    const isGitRepo = await gitService.isRepo(session.projectRoot, sshRemoteId);
    if (isGitRepo) {
      try {
        const [gitBranches, gitTags] = await Promise.all([
          gitService.getBranches(session.projectRoot, sshRemoteId),
          gitService.getTags(session.projectRoot, sshRemoteId)
        ]);

        setSessions(prev => prev.map(s => {
          if (s.id !== session.id) return s;
          return {
            ...s,
            isGitRepo: true,
            gitBranches,
            gitTags,
            gitRefsCacheTime: Date.now()
          };
        }));
      } catch {
        // Ignore git info fetch errors
      }
    }

    // If a context summary is provided, queue it as the first message
    // This will be sent when the agent spawns on first user input
    if (contextSummary && contextSummary.trim()) {
      const activeTab = getActiveTab(session);
      if (activeTab) {
        // Add context as a system log entry so it appears in conversation history
        const contextLogEntry: LogEntry = {
          id: generateId(),
          timestamp: Date.now(),
          source: 'system',
          text: `[Merged Context]\n\n${contextSummary}`
        };

        setSessions(prev => prev.map(s => {
          if (s.id !== session.id) return s;
          return {
            ...s,
            aiTabs: s.aiTabs.map(tab => {
              if (tab.id !== activeTab.id) return tab;
              return {
                ...tab,
                logs: [...tab.logs, contextLogEntry]
              };
            })
          };
        }));
      }
    }

    // Focus the input for immediate user interaction
    setActiveFocus('main');
    setTimeout(() => inputRef.current?.focus(), 50);

    // Show success notification
    addToast({
      type: 'success',
      title: 'Session Created',
      message: `Merged context session "${session.name}" is ready`,
    });
  }, [
    setSessions,
    setActiveSessionId,
    updateGlobalStats,
    setActiveFocus,
    addToast
  ]);

  const toggleInputMode = () => {
    setSessions(prev => prev.map(s => {
      if (s.id !== activeSessionId) return s;
      return { ...s, inputMode: s.inputMode === 'ai' ? 'terminal' : 'ai' };
    }));
    // Close any open dropdowns when switching modes
    setTabCompletionOpen(false);
    setSlashCommandOpen(false);
  };

  // Toggle unread tabs filter with save/restore of active tab
  const toggleUnreadFilter = useCallback(() => {
    if (!showUnreadOnly) {
      // Entering filter mode: save current active tab
      preFilterActiveTabIdRef.current = activeSession?.activeTabId || null;
    } else {
      // Exiting filter mode: restore previous active tab if it still exists
      if (preFilterActiveTabIdRef.current && activeSession) {
        const tabStillExists = activeSession.aiTabs.some(t => t.id === preFilterActiveTabIdRef.current);
        if (tabStillExists) {
          setSessions(prev => prev.map(s => {
            if (s.id !== activeSession.id) return s;
            return { ...s, activeTabId: preFilterActiveTabIdRef.current! };
          }));
        }
        preFilterActiveTabIdRef.current = null;
      }
    }
    setShowUnreadOnly(prev => !prev);
  }, [showUnreadOnly, activeSession]);

  // Toggle star on the current active tab
  const toggleTabStar = useCallback(() => {
    if (!activeSession) return;
    const tab = getActiveTab(activeSession);
    if (!tab) return;

    const newStarred = !tab.starred;
    setSessions(prev => prev.map(s => {
      if (s.id !== activeSession.id) return s;
      // Persist starred status to session metadata (async, fire and forget)
      // Use projectRoot (not cwd) for consistent session storage access
      if (tab.agentSessionId) {
        const agentId = s.toolType || 'claude-code';
        if (agentId === 'claude-code') {
          window.maestro.claude.updateSessionStarred(
            s.projectRoot,
            tab.agentSessionId,
            newStarred
          ).catch(err => console.error('Failed to persist tab starred:', err));
        } else {
          window.maestro.agentSessions.setSessionStarred(
            agentId,
            s.projectRoot,
            tab.agentSessionId,
            newStarred
          ).catch(err => console.error('Failed to persist tab starred:', err));
        }
      }
      return {
        ...s,
        aiTabs: s.aiTabs.map(t =>
          t.id === tab.id ? { ...t, starred: newStarred } : t
        )
      };
    }));
  }, [activeSession]);

  // Toggle unread status on the current active tab
  const toggleTabUnread = useCallback(() => {
    if (!activeSession) return;
    const tab = getActiveTab(activeSession);
    if (!tab) return;

    setSessions(prev => prev.map(s => {
      if (s.id !== activeSession.id) return s;
      return {
        ...s,
        aiTabs: s.aiTabs.map(t =>
          t.id === tab.id ? { ...t, hasUnread: !t.hasUnread } : t
        )
      };
    }));
  }, [activeSession]);

  // Toggle global live mode (enables web interface for all sessions)
  const toggleGlobalLive = async () => {
    try {
      if (isLiveMode) {
        // Stop tunnel first (if running), then stop web server
        await window.maestro.tunnel.stop();
        const _result = await window.maestro.live.disableAll();
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

    const cwd = activeSession.inputMode === 'terminal' ? (activeSession.shellCwd || activeSession.cwd) : activeSession.cwd;
    const diff = await gitService.getDiff(cwd);

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
    setSessions(prev => {
      const updated = prev.map(s => s.id === sessId ? { ...s, name: newName } : s);
      // Sync the session name to agent session storage for searchability
      // Use projectRoot (not cwd) for consistent session storage access
      const session = updated.find(s => s.id === sessId);
      if (session?.agentSessionId && session.projectRoot) {
        const agentId = session.toolType || 'claude-code';
        if (agentId === 'claude-code') {
          window.maestro.claude.updateSessionName(session.projectRoot, session.agentSessionId, newName)
            .catch(err => console.warn('[finishRenamingSession] Failed to sync session name:', err));
        } else {
          window.maestro.agentSessions.setSessionName(agentId, session.projectRoot, session.agentSessionId, newName)
            .catch(err => console.warn('[finishRenamingSession] Failed to sync session name:', err));
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
      const customEvent = event as CustomEvent<{ sessionId: string; command: string; inputMode?: 'ai' | 'terminal' }>;
      const { sessionId, command, inputMode: webInputMode } = customEvent.detail;

      console.log('[Remote] Processing remote command via event:', { sessionId, command: command.substring(0, 50), webInputMode });

      // Find the session directly from sessionsRef (not from React state which may be stale)
      const session = sessionsRef.current.find(s => s.id === sessionId);
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
        toolType: session.toolType
      });

      // Handle terminal mode commands
      if (effectiveInputMode === 'terminal') {
        console.log('[Remote] Terminal mode - using runCommand for clean output');

        // Add user message to shell logs and set state to busy
        setSessions(prev => prev.map(s => {
          if (s.id !== sessionId) return s;
          return {
            ...s,
            state: 'busy' as SessionState,
            busySource: 'terminal',
            shellLogs: [...s.shellLogs, {
              id: generateId(),
              timestamp: Date.now(),
              source: 'user',
              text: command
            }]
          };
        }));

        // Use runCommand for clean stdout/stderr capture (same as desktop)
        // This spawns a fresh shell with -l -c to run the command
        // When SSH is enabled for the session, the command runs on the remote host
        // For SSH sessions, use remoteCwd; for local, use shellCwd
        const isRemote = !!session.sshRemoteId || !!session.sessionSshRemoteConfig?.enabled;
        const commandCwd = isRemote
          ? (session.remoteCwd || session.sessionSshRemoteConfig?.workingDirOverride || session.cwd)
          : (session.shellCwd || session.cwd);
        try {
          await window.maestro.process.runCommand({
            sessionId: sessionId,  // Plain session ID (not suffixed)
            command: command,
            cwd: commandCwd,
            // Pass SSH config if the session has SSH enabled
            sessionSshRemoteConfig: session.sessionSshRemoteConfig,
          });
          console.log('[Remote] Terminal command completed successfully');
        } catch (error: unknown) {
          console.error('[Remote] Terminal command failed:', error);
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          setSessions(prev => prev.map(s => {
            if (s.id !== sessionId) return s;
            return {
              ...s,
              state: 'idle' as SessionState,
              busySource: undefined,
              thinkingStartTime: undefined,
              shellLogs: [...s.shellLogs, {
                id: generateId(),
                timestamp: Date.now(),
                source: 'system',
                text: `Error: Failed to run command - ${errorMessage}`
              }]
            };
          }));
        }
        return;
      }

      // Handle AI mode for batch-mode agents (Claude Code, Codex, OpenCode)
      const supportedBatchAgents: ToolType[] = ['claude', 'claude-code', 'codex', 'opencode'];
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
          cmd => cmd.command === commandText
        );

        // Look up in spec-kit commands
        const matchingSpeckitCommand = speckitCommandsRef.current.find(
          cmd => cmd.command === commandText
        );

        // Look up in openspec commands
        const matchingOpenspecCommand = openspecCommandsRef.current.find(
          cmd => cmd.command === commandText
        );

        const matchingCommand = matchingCustomCommand || matchingSpeckitCommand || matchingOpenspecCommand;

        if (matchingCommand) {
          console.log('[Remote] Found matching command:', matchingCommand.command, matchingSpeckitCommand ? '(spec-kit)' : matchingOpenspecCommand ? '(openspec)' : '(custom)');

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
          promptToSend = substituteTemplateVariables(
            matchingCommand.prompt,
            { session, gitBranch }
          );
          commandMetadata = {
            command: matchingCommand.command,
            description: matchingCommand.description
          };

          console.log('[Remote] Substituted prompt (first 100 chars):', promptToSend.substring(0, 100));
        } else {
          // Unknown slash command - show error and don't send to AI
          console.log('[Remote] Unknown slash command:', commandText);
          addLogToActiveTab(sessionId, {
            source: 'system',
            text: `Unknown command: ${commandText}`
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
          ? agentArgs.filter(arg =>
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
          prompt: promptToSend.substring(0, 100)
        });

        // Add user message to active tab's logs and set state to busy
        // For custom commands, show the substituted prompt with command metadata
        const userLogEntry: LogEntry = {
          id: generateId(),
          timestamp: Date.now(),
          source: 'user',
          text: promptToSend,
          ...(commandMetadata && { aiCommand: commandMetadata })
        };

        setSessions(prev => prev.map(s => {
          if (s.id !== sessionId) return s;

          // Update active tab: add log entry and set state to 'busy' for write-mode tracking
          const activeTab = getActiveTab(s);
          const updatedAiTabs = s.aiTabs?.length > 0
            ? s.aiTabs.map(tab =>
                tab.id === s.activeTabId
                  ? { ...tab, state: 'busy' as const, logs: [...tab.logs, userLogEntry] }
                  : tab
              )
            : s.aiTabs;

          if (!activeTab) {
            // No tabs exist - this is a bug, sessions must have aiTabs
            console.error('[runAICommand] No active tab found - session has no aiTabs, this should not happen');
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
              aiCommandHistory: Array.from(new Set([...(s.aiCommandHistory || []), command.trim()])).slice(-50)
            }),
            aiTabs: updatedAiTabs
          };
        }));

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
          text: `Error: Failed to process remote command - ${errorMessage}`
        };
        setSessions(prev => prev.map(s => {
          if (s.id !== sessionId) return s;
          // Reset active tab's state to 'idle' and add error log
          const activeTab = getActiveTab(s);
          const updatedAiTabs = s.aiTabs?.length > 0
            ? s.aiTabs.map(tab =>
                tab.id === s.activeTabId
                  ? { ...tab, state: 'idle' as const, thinkingStartTime: undefined, logs: [...tab.logs, errorLogEntry] }
                  : tab
              )
            : s.aiTabs;

          if (!activeTab) {
            // No tabs exist - this is a bug, sessions must have aiTabs
            console.error('[runAICommand error] No active tab found - session has no aiTabs, this should not happen');
            return s;
          }

          return {
            ...s,
            state: 'idle' as SessionState,
            busySource: undefined,
            thinkingStartTime: undefined,
            aiTabs: updatedAiTabs
          };
        }));
      }
    };
    window.addEventListener('maestro:remoteCommand', handleRemoteCommand);
    return () => window.removeEventListener('maestro:remoteCommand', handleRemoteCommand);
  }, [addLogToActiveTab]);

  // Listen for tour UI actions to control right panel state
  useEffect(() => {
    const handleTourAction = (event: Event) => {
      const customEvent = event as CustomEvent<{ type: string; value?: string }>;
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

  // Process a queued item (called from onExit when queue has items)
  // Handles both 'message' and 'command' types
  const processQueuedItem = async (sessionId: string, item: QueuedItem) => {
    // Use sessionsRef.current to get the latest session state (avoids stale closure)
    const session = sessionsRef.current.find(s => s.id === sessionId);
    if (!session) {
      console.error('[processQueuedItem] Session not found:', sessionId);
      return;
    }

    // Find the TARGET tab for this queued item (NOT the active tab!)
    // The item carries its intended tabId from when it was queued
    const targetTab = session.aiTabs.find(tab => tab.id === item.tabId) || getActiveTab(session);
    const targetSessionId = `${sessionId}-ai-${targetTab?.id || 'default'}`;

    try {
      // Get agent configuration for this session's tool type
      const agent = await window.maestro.agents.get(session.toolType);
      if (!agent) throw new Error(`Agent not found for toolType: ${session.toolType}`);

      // Get the TARGET TAB's agentSessionId for session continuity
      // (not the active tab or deprecated session-level one)
      const tabAgentSessionId = targetTab?.agentSessionId;
      const isReadOnly = item.readOnlyMode || targetTab?.readOnlyMode;

      // Filter out YOLO/skip-permissions flags when read-only mode is active
      // (they would override the read-only mode we're requesting)
      // - Claude Code: --dangerously-skip-permissions
      // - Codex: --dangerously-bypass-approvals-and-sandbox
      const spawnArgs = isReadOnly
        ? (agent.args || []).filter(arg =>
            arg !== '--dangerously-skip-permissions' &&
            arg !== '--dangerously-bypass-approvals-and-sandbox'
          )
        : [...(agent.args || [])];

      // Note: agentSessionId and readOnlyMode are passed to spawn() config below.
      // The main process uses agent-specific argument builders (resumeArgs, readOnlyArgs)
      // to construct the correct CLI args for each agent type.

      const commandToUse = agent.path ?? agent.command;

      // Check if this is a message with images but no text
      const hasImages = item.images && item.images.length > 0;
      const hasText = item.text && item.text.trim();
      const isImageOnlyMessage = item.type === 'message' && hasImages && !hasText;

      if (item.type === 'message' && (hasText || isImageOnlyMessage)) {
        // Process a message - spawn agent with the message text
        // If user sends only an image without text, inject the default image-only prompt
        let effectivePrompt = isImageOnlyMessage ? DEFAULT_IMAGE_ONLY_PROMPT : item.text!;

        // For NEW sessions (no agentSessionId), prepend Maestro system prompt
        // This introduces Maestro and sets directory restrictions for the agent
        const isNewSession = !tabAgentSessionId;
        if (isNewSession && maestroSystemPrompt) {
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

          // Substitute template variables in the system prompt
          const substitutedSystemPrompt = substituteTemplateVariables(maestroSystemPrompt, {
            session,
            gitBranch,
          });

          // Prepend system prompt to user's message
          effectivePrompt = `${substitutedSystemPrompt}\n\n---\n\n# User Request\n\n${effectivePrompt}`;
        }

        console.log('[processQueuedItem] Spawning agent with queued message:', {
          sessionId: targetSessionId,
          toolType: session.toolType,
          prompt: effectivePrompt,
          promptLength: effectivePrompt?.length,
          hasAgentSessionId: !!tabAgentSessionId,
          agentSessionId: tabAgentSessionId,
          isReadOnly,
          argsLength: spawnArgs.length,
          args: spawnArgs,
        });

        await window.maestro.process.spawn({
          sessionId: targetSessionId,
          toolType: session.toolType,
          cwd: session.cwd,
          command: commandToUse,
          args: spawnArgs,
          prompt: effectivePrompt,
          images: hasImages ? item.images : undefined,
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
      } else if (item.type === 'command' && item.command) {
        // Process a slash command - find the matching custom AI command, speckit command, or openspec command
        // Use refs to get latest values and avoid stale closure
        const matchingCommand = customAICommandsRef.current.find(cmd => cmd.command === item.command)
          || speckitCommandsRef.current.find(cmd => cmd.command === item.command)
          || openspecCommandsRef.current.find(cmd => cmd.command === item.command);
        if (matchingCommand) {
          // Substitute template variables
          let gitBranch: string | undefined;
          if (session.isGitRepo) {
            try {
              const status = await gitService.getStatus(session.cwd);
              gitBranch = status.branch;
            } catch {
              // Ignore git errors
            }
          }
          const substitutedPrompt = substituteTemplateVariables(
            matchingCommand.prompt,
            { session, gitBranch }
          );

          // For NEW sessions (no agentSessionId), prepend Maestro system prompt
          // This introduces Maestro and sets directory restrictions for the agent
          // Keep original prompt separate for user log (don't show system prompt in chat)
          const isNewSessionForCommand = !tabAgentSessionId;
          let promptForAgent = substitutedPrompt;
          if (isNewSessionForCommand && maestroSystemPrompt) {
            // Substitute template variables in the system prompt
            const substitutedSystemPrompt = substituteTemplateVariables(maestroSystemPrompt, {
              session,
              gitBranch,
            });

            // Prepend system prompt to command's prompt (for agent only)
            promptForAgent = `${substitutedSystemPrompt}\n\n---\n\n# User Request\n\n${substitutedPrompt}`;
          }

          // Add user log showing the command with its interpolated prompt
          // Use original substitutedPrompt (without system context) for display
          addLogToTab(sessionId, {
            source: 'user',
            text: substitutedPrompt,
            aiCommand: {
              command: matchingCommand.command,
              description: matchingCommand.description
            }
          }, item.tabId);

          // Track this command for automatic synopsis on completion
          setSessions(prev => prev.map(s => {
            if (s.id !== sessionId) return s;
            return {
              ...s,
              pendingAICommandForSynopsis: matchingCommand.command
            };
          }));

          // Spawn agent with the prompt (includes system context for new sessions)
          await window.maestro.process.spawn({
            sessionId: targetSessionId,
            toolType: session.toolType,
            cwd: session.cwd,
            command: commandToUse,
            args: spawnArgs,
            prompt: promptForAgent,
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
        } else {
          // Unknown command - add error log
          const errorLogEntry: LogEntry = {
            id: generateId(),
            timestamp: Date.now(),
            source: 'system',
            text: `Unknown command: ${item.command}`
          };
          addLogToActiveTab(sessionId, errorLogEntry);
          // Set session back to idle with full state cleanup
          setSessions(prev => prev.map(s => {
            if (s.id !== sessionId) return s;
            // Reset the target tab's state too
            const updatedAiTabs = s.aiTabs?.map(tab =>
              tab.id === item.tabId ? { ...tab, state: 'idle' as const, thinkingStartTime: undefined } : tab
            );
            return { ...s, state: 'idle' as SessionState, busySource: undefined, thinkingStartTime: undefined, aiTabs: updatedAiTabs };
          }));
        }
      }
    } catch (error: any) {
      console.error('[processQueuedItem] Failed to process queued item:', error);
      const errorLogEntry: LogEntry = {
        id: generateId(),
        timestamp: Date.now(),
        source: 'system',
        text: `Error: Failed to process queued ${item.type} - ${error.message}`
      };
      setSessions(prev => prev.map(s => {
        if (s.id !== sessionId) return s;
        // Reset active tab's state to 'idle' and add error log
        const activeTab = getActiveTab(s);
        const updatedAiTabs = s.aiTabs?.length > 0
          ? s.aiTabs.map(tab =>
              tab.id === s.activeTabId
                ? { ...tab, state: 'idle' as const, thinkingStartTime: undefined, logs: [...tab.logs, errorLogEntry] }
                : tab
            )
          : s.aiTabs;

        if (!activeTab) {
          // No tabs exist - this is a bug, sessions must have aiTabs
          console.error('[processQueuedItem error] No active tab found - session has no aiTabs, this should not happen');
          return s;
        }

        return {
          ...s,
          state: 'idle',
          busySource: undefined,
          thinkingStartTime: undefined,
          aiTabs: updatedAiTabs
        };
      }));
    }
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
      s => s.state === 'idle' && s.executionQueue && s.executionQueue.length > 0
    );

    if (sessionsWithQueuedItems.length > 0) {
      console.log(`[App] Found ${sessionsWithQueuedItems.length} session(s) with leftover queued items from previous session`);

      // Process the first queued item from each session
      // Delay to ensure all refs and handlers are set up
      setTimeout(() => {
        sessionsWithQueuedItems.forEach(session => {
          const firstItem = session.executionQueue[0];
          console.log(`[App] Processing leftover queued item for session ${session.id}:`, firstItem);

          // Set session to busy and remove item from queue
          setSessions(prev => prev.map(s => {
            if (s.id !== session.id) return s;

            const [, ...remainingQueue] = s.executionQueue;
            const targetTab = s.aiTabs.find(tab => tab.id === firstItem.tabId) || getActiveTab(s);

            // Set the target tab to busy
            const updatedAiTabs = s.aiTabs.map(tab =>
              tab.id === targetTab?.id
                ? { ...tab, state: 'busy' as const, thinkingStartTime: Date.now() }
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
          }));

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
    const targetSessionId = currentMode === 'ai'
      ? `${activeSession.id}-ai-${activeTab?.id || 'default'}`
      : `${activeSession.id}-terminal`;

    try {
      // Send interrupt signal (Ctrl+C)
      await window.maestro.process.interrupt(targetSessionId);

      // Check if there are queued items to process after interrupt
      const currentSession = sessionsRef.current.find(s => s.id === activeSession.id);
      let queuedItemToProcess: { sessionId: string; item: QueuedItem } | null = null;

      if (currentSession && currentSession.executionQueue.length > 0) {
        queuedItemToProcess = {
          sessionId: activeSession.id,
          item: currentSession.executionQueue[0]
        };
      }

      // Create canceled log entry for AI mode interrupts
      const canceledLog: LogEntry | null = currentMode === 'ai' ? {
        id: generateId(),
        timestamp: Date.now(),
        source: 'system',
        text: 'Canceled by user'
      } : null;

      // Set state to idle with full cleanup, or process next queued item
      setSessions(prev => prev.map(s => {
        if (s.id !== activeSession.id) return s;

        // If there are queued items, start processing the next one
        if (s.executionQueue.length > 0) {
          const [nextItem, ...remainingQueue] = s.executionQueue;
          const targetTab = s.aiTabs.find(tab => tab.id === nextItem.tabId) || getActiveTab(s);

          if (!targetTab) {
            return {
              ...s,
              state: 'busy' as SessionState,
              busySource: 'ai',
              executionQueue: remainingQueue,
              thinkingStartTime: Date.now(),
              currentCycleTokens: 0,
              currentCycleBytes: 0
            };
          }

          // Set the interrupted tab to idle, and the target tab for queued item to busy
          // Also add the canceled log to the interrupted tab
          let updatedAiTabs = s.aiTabs.map(tab => {
            if (tab.id === targetTab.id) {
              return { ...tab, state: 'busy' as const, thinkingStartTime: Date.now() };
            }
            // Set any other busy tabs to idle (they were interrupted) and add canceled log
            // Also clear any thinking/tool logs since the process was interrupted
            if (tab.state === 'busy') {
              const logsWithoutThinkingOrTools = tab.logs.filter(log => log.source !== 'thinking' && log.source !== 'tool');
              const updatedLogs = canceledLog ? [...logsWithoutThinkingOrTools, canceledLog] : logsWithoutThinkingOrTools;
              return { ...tab, state: 'idle' as const, thinkingStartTime: undefined, logs: updatedLogs };
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
              images: nextItem.images
            };
            updatedAiTabs = updatedAiTabs.map(tab =>
              tab.id === targetTab.id
                ? { ...tab, logs: [...tab.logs, logEntry] }
                : tab
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
            currentCycleBytes: 0
          };
        }

        // No queued items, just go to idle and add canceled log to the active tab
        // Also clear any thinking/tool logs since the process was interrupted
        const activeTabForCancel = getActiveTab(s);
        const updatedAiTabsForIdle = canceledLog && activeTabForCancel
          ? s.aiTabs.map(tab => {
              if (tab.id === activeTabForCancel.id) {
                const logsWithoutThinkingOrTools = tab.logs.filter(log => log.source !== 'thinking' && log.source !== 'tool');
                return { ...tab, logs: [...logsWithoutThinkingOrTools, canceledLog], state: 'idle' as const, thinkingStartTime: undefined };
              }
              return tab;
            })
          : s.aiTabs.map(tab => {
              if (tab.state === 'busy') {
                const logsWithoutThinkingOrTools = tab.logs.filter(log => log.source !== 'thinking' && log.source !== 'tool');
                return { ...tab, state: 'idle' as const, thinkingStartTime: undefined, logs: logsWithoutThinkingOrTools };
              }
              return tab;
            });

        return {
          ...s,
          state: 'idle',
          busySource: undefined,
          thinkingStartTime: undefined,
          aiTabs: updatedAiTabsForIdle
        };
      }));

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
            text: 'Process forcefully terminated'
          };

          // Check if there are queued items to process after kill
          const currentSessionForKill = sessionsRef.current.find(s => s.id === activeSession.id);
          let queuedItemAfterKill: { sessionId: string; item: QueuedItem } | null = null;

          if (currentSessionForKill && currentSessionForKill.executionQueue.length > 0) {
            queuedItemAfterKill = {
              sessionId: activeSession.id,
              item: currentSessionForKill.executionQueue[0]
            };
          }

          setSessions(prev => prev.map(s => {
            if (s.id !== activeSession.id) return s;

            // Add kill log to the appropriate place and clear thinking/tool logs
            const updatedSession = { ...s };
            if (currentMode === 'ai') {
              const tab = getActiveTab(s);
              if (tab) {
                updatedSession.aiTabs = s.aiTabs.map(t => {
                  if (t.id === tab.id) {
                    const logsWithoutThinkingOrTools = t.logs.filter(log => log.source !== 'thinking' && log.source !== 'tool');
                    return { ...t, logs: [...logsWithoutThinkingOrTools, killLog] };
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
              const targetTab = s.aiTabs.find(tab => tab.id === nextItem.tabId) || getActiveTab(s);

              if (!targetTab) {
                return {
                  ...updatedSession,
                  state: 'busy' as SessionState,
                  busySource: 'ai',
                  executionQueue: remainingQueue,
                  thinkingStartTime: Date.now(),
                  currentCycleTokens: 0,
                  currentCycleBytes: 0
                };
              }

              // Set tabs appropriately and clear thinking/tool logs from interrupted tabs
              let updatedAiTabs = updatedSession.aiTabs.map(tab => {
                if (tab.id === targetTab.id) {
                  return { ...tab, state: 'busy' as const, thinkingStartTime: Date.now() };
                }
                if (tab.state === 'busy') {
                  const logsWithoutThinkingOrTools = tab.logs.filter(log => log.source !== 'thinking' && log.source !== 'tool');
                  return { ...tab, state: 'idle' as const, thinkingStartTime: undefined, logs: logsWithoutThinkingOrTools };
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
                  images: nextItem.images
                };
                updatedAiTabs = updatedAiTabs.map(tab =>
                  tab.id === targetTab.id
                    ? { ...tab, logs: [...tab.logs, logEntry] }
                    : tab
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
                currentCycleBytes: 0
              };
            }

            // No queued items, just go to idle and clear thinking logs
            if (currentMode === 'ai') {
              const tab = getActiveTab(s);
              if (!tab) return { ...updatedSession, state: 'idle', busySource: undefined, thinkingStartTime: undefined };
              return {
                ...updatedSession,
                state: 'idle',
                busySource: undefined,
                thinkingStartTime: undefined,
                aiTabs: updatedSession.aiTabs.map(t => {
                  if (t.id === tab.id) {
                    const logsWithoutThinkingOrTools = t.logs.filter(log => log.source !== 'thinking' && log.source !== 'tool');
                    return { ...t, state: 'idle' as const, thinkingStartTime: undefined, logs: logsWithoutThinkingOrTools };
                  }
                  return t;
                })
              };
            }
            return { ...updatedSession, state: 'idle', busySource: undefined, thinkingStartTime: undefined };
          }));

          // Process the queued item after state update
          if (queuedItemAfterKill) {
            setTimeout(() => {
              processQueuedItem(queuedItemAfterKill!.sessionId, queuedItemAfterKill!.item);
            }, 0);
          }
        } catch (killError: unknown) {
          console.error('Failed to kill process:', killError);
          const killErrorMessage = killError instanceof Error ? killError.message : String(killError);
          const errorLog: LogEntry = {
            id: generateId(),
            timestamp: Date.now(),
            source: 'system',
            text: `Error: Failed to terminate process - ${killErrorMessage}`
          };
          setSessions(prev => prev.map(s => {
            if (s.id !== activeSession.id) return s;
            if (currentMode === 'ai') {
              const tab = getActiveTab(s);
              if (!tab) return { ...s, state: 'idle', busySource: undefined, thinkingStartTime: undefined };
              return {
                ...s,
                state: 'idle',
                busySource: undefined,
                thinkingStartTime: undefined,
                aiTabs: s.aiTabs.map(t => {
                  if (t.id === tab.id) {
                    // Clear thinking/tool logs even on error
                    const logsWithoutThinkingOrTools = t.logs.filter(log => log.source !== 'thinking' && log.source !== 'tool');
                    return { ...t, state: 'idle' as const, thinkingStartTime: undefined, logs: [...logsWithoutThinkingOrTools, errorLog] };
                  }
                  return t;
                })
              };
            }
            return { ...s, shellLogs: [...s.shellLogs, errorLog], state: 'idle', busySource: undefined, thinkingStartTime: undefined };
          }));
        }
      }
    }
  };

  const handleInputKeyDown = (e: React.KeyboardEvent) => {
    // Cmd+F opens output search from input field - handle first, before any modal logic
    if (e.key === 'f' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      setOutputSearchOpen(true);
      return;
    }

    // Handle command history modal
    if (commandHistoryOpen) {
      return; // Let the modal handle keys
    }

    // Handle tab completion dropdown (terminal mode only)
    if (tabCompletionOpen && activeSession?.inputMode === 'terminal') {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const newIndex = Math.min(selectedTabCompletionIndex + 1, tabCompletionSuggestions.length - 1);
        setSelectedTabCompletionIndex(newIndex);
        // Sync file tree to highlight the corresponding file/folder
        syncFileTreeToTabCompletion(tabCompletionSuggestions[newIndex]);
        return;
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const newIndex = Math.max(selectedTabCompletionIndex - 1, 0);
        setSelectedTabCompletionIndex(newIndex);
        // Sync file tree to highlight the corresponding file/folder
        syncFileTreeToTabCompletion(tabCompletionSuggestions[newIndex]);
        return;
      } else if (e.key === 'Tab') {
        e.preventDefault();
        // Tab cycles through filter types (only in git repos, otherwise just accept)
        if (activeSession?.isGitRepo) {
          const filters: TabCompletionFilter[] = ['all', 'history', 'branch', 'tag', 'file'];
          const currentIndex = filters.indexOf(tabCompletionFilter);
          // Shift+Tab goes backwards, Tab goes forwards
          const nextIndex = e.shiftKey
            ? (currentIndex - 1 + filters.length) % filters.length
            : (currentIndex + 1) % filters.length;
          setTabCompletionFilter(filters[nextIndex]);
          setSelectedTabCompletionIndex(0);
        } else {
          // In non-git repos, Tab accepts the selection (like Enter)
          if (tabCompletionSuggestions[selectedTabCompletionIndex]) {
            setInputValue(tabCompletionSuggestions[selectedTabCompletionIndex].value);
            syncFileTreeToTabCompletion(tabCompletionSuggestions[selectedTabCompletionIndex]);
          }
          setTabCompletionOpen(false);
        }
        return;
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (tabCompletionSuggestions[selectedTabCompletionIndex]) {
          setInputValue(tabCompletionSuggestions[selectedTabCompletionIndex].value);
          // Final sync on acceptance
          syncFileTreeToTabCompletion(tabCompletionSuggestions[selectedTabCompletionIndex]);
        }
        setTabCompletionOpen(false);
        return;
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setTabCompletionOpen(false);
        inputRef.current?.focus();
        return;
      }
    }

    // Handle @ mention completion dropdown (AI mode only)
    if (atMentionOpen && activeSession?.inputMode === 'ai') {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedAtMentionIndex(prev => Math.min(prev + 1, atMentionSuggestions.length - 1));
        return;
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedAtMentionIndex(prev => Math.max(prev - 1, 0));
        return;
      } else if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault();
        const selected = atMentionSuggestions[selectedAtMentionIndex];
        if (selected) {
          // Replace the @filter with the selected file path
          const beforeAt = inputValue.substring(0, atMentionStartIndex);
          const afterFilter = inputValue.substring(atMentionStartIndex + 1 + atMentionFilter.length);
          setInputValue(beforeAt + '@' + selected.value + ' ' + afterFilter);
        }
        setAtMentionOpen(false);
        setAtMentionFilter('');
        setAtMentionStartIndex(-1);
        return;
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setAtMentionOpen(false);
        setAtMentionFilter('');
        setAtMentionStartIndex(-1);
        inputRef.current?.focus();
        return;
      }
    }

    // Handle slash command autocomplete
    if (slashCommandOpen) {
      const isTerminalMode = activeSession?.inputMode === 'terminal';
      const filteredCommands = allSlashCommands.filter(cmd => {
        // Check if command is only available in terminal mode
        if ('terminalOnly' in cmd && cmd.terminalOnly && !isTerminalMode) return false;
        // Check if command is only available in AI mode
        if ('aiOnly' in cmd && cmd.aiOnly && isTerminalMode) return false;
        // Check if command matches input
        return cmd.command.toLowerCase().startsWith(inputValue.toLowerCase());
      });

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedSlashCommandIndex(prev =>
          Math.min(prev + 1, filteredCommands.length - 1)
        );
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedSlashCommandIndex(prev => Math.max(prev - 1, 0));
      } else if (e.key === 'Tab' || e.key === 'Enter') {
        // Tab or Enter fills in the command text (user can then press Enter again to execute)
        e.preventDefault();
        if (filteredCommands[selectedSlashCommandIndex]) {
          setInputValue(filteredCommands[selectedSlashCommandIndex].command);
          setSlashCommandOpen(false);
          inputRef.current?.focus();
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setSlashCommandOpen(false);
      }
      return;
    }

    if (e.key === 'Enter') {
      // Use the appropriate setting based on input mode
      const currentEnterToSend = activeSession?.inputMode === 'terminal' ? enterToSendTerminal : enterToSendAI;

      if (currentEnterToSend && !e.shiftKey && !e.metaKey) {
        e.preventDefault();
        processInput();
      } else if (!currentEnterToSend && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        processInput();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      inputRef.current?.blur();
      terminalOutputRef.current?.focus();
    } else if (e.key === 'ArrowUp') {
      // Only show command history in terminal mode, not AI mode
      if (activeSession?.inputMode === 'terminal') {
        e.preventDefault();
        setCommandHistoryOpen(true);
        setCommandHistoryFilter(inputValue);
        setCommandHistorySelectedIndex(0);
      }
    } else if (e.key === 'Tab') {
      // Always prevent default Tab behavior to avoid focus change
      e.preventDefault();

      // Tab completion in terminal mode when not showing slash commands
      if (activeSession?.inputMode === 'terminal' && !slashCommandOpen) {
        // Only show suggestions if there's input
        if (inputValue.trim()) {
          const suggestions = getTabCompletionSuggestions(inputValue);
          if (suggestions.length > 0) {
            // If only one suggestion, auto-complete it
            if (suggestions.length === 1) {
              setInputValue(suggestions[0].value);
            } else {
              // Show dropdown for multiple suggestions
              setSelectedTabCompletionIndex(0);
              setTabCompletionFilter('all'); // Reset filter when opening
              setTabCompletionOpen(true);
            }
          }
        }
      }
      // In AI mode, Tab is already handled by @ mention completion above
      // We just need to prevent default here
    }
  };

  // Image Handlers
  const showImageAttachBlockedNotice = useCallback(() => {
    const message = 'Images are only available in the initial message to Claude. Please start a new session if you want to include an image.';
    setSuccessFlashNotification(message);
    setTimeout(() => setSuccessFlashNotification(null), 4000);
  }, [setSuccessFlashNotification]);

  const handlePaste = (e: React.ClipboardEvent) => {
    // Allow image pasting in group chat or direct AI mode
    const isGroupChatActive = !!activeGroupChatId;
    const isDirectAIMode = activeSession && activeSession.inputMode === 'ai';

    if (!isGroupChatActive && !isDirectAIMode) return;

    const items = e.clipboardData.items;
    const hasImage = Array.from(items).some(item => item.type.startsWith('image/'));

    if (hasImage && isDirectAIMode && !isGroupChatActive && blockCodexResumeImages) {
      e.preventDefault();
      showImageAttachBlockedNotice();
      return;
    }

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
                setGroupChatStagedImages(prev => {
                  if (prev.includes(imageData)) {
                    setSuccessFlashNotification('Duplicate image ignored');
                    setTimeout(() => setSuccessFlashNotification(null), 2000);
                    return prev;
                  }
                  return [...prev, imageData];
                });
              } else {
                setStagedImages(prev => {
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
    const hasImage = Array.from(files).some(file => file.type.startsWith('image/'));

    if (hasImage && isDirectAIMode && !isGroupChatActive && blockCodexResumeImages) {
      showImageAttachBlockedNotice();
      return;
    }

    for (let i = 0; i < files.length; i++) {
      if (files[i].type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = (event) => {
          if (event.target?.result) {
            const imageData = event.target!.result as string;
            if (isGroupChatActive) {
              setGroupChatStagedImages(prev => {
                if (prev.includes(imageData)) {
                  setSuccessFlashNotification('Duplicate image ignored');
                  setTimeout(() => setSuccessFlashNotification(null), 2000);
                  return prev;
                }
                return [...prev, imageData];
              });
            } else {
              setStagedImages(prev => {
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
  const {
    refreshFileTree,
    refreshGitFileState,
    filteredFileTree,
  } = useFileTreeManagement({
    sessions,
    sessionsRef,
    setSessions,
    activeSessionId,
    activeSession,
    fileTreeFilter,
    rightPanelRef,
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
  const {
    createGroupModalOpen,
    setCreateGroupModalOpen,
  } = groupModalState;

  // State to track session that should be moved to newly created group
  const [pendingMoveToGroupSessionId, setPendingMoveToGroupSessionId] = useState<string | null>(null);

  // Group Modal Handlers (stable callbacks for AppGroupModals)
  // Must be defined after groupModalState destructure since setCreateGroupModalOpen comes from there
  const handleCloseCreateGroupModal = useCallback(() => {
    setCreateGroupModalOpen(false);
    setPendingMoveToGroupSessionId(null); // Clear pending move on close
  }, [setCreateGroupModalOpen]);
  const handleCloseRenameGroupModal = useCallback(() => {
    setRenameGroupModalOpen(false);
  }, []);

  // Handler for when a new group is created - move pending session to it
  const handleGroupCreated = useCallback((groupId: string) => {
    if (pendingMoveToGroupSessionId) {
      setSessions(prev => prev.map(s =>
        s.id === pendingMoveToGroupSessionId ? { ...s, groupId } : s
      ));
      setPendingMoveToGroupSessionId(null);
    }
  }, [pendingMoveToGroupSessionId, setSessions]);

  // Handler for "Create New Group" from context menu - sets pending session and opens modal
  const handleCreateGroupAndMove = useCallback((sessionId: string) => {
    setPendingMoveToGroupSessionId(sessionId);
    setCreateGroupModalOpen(true);
  }, [setCreateGroupModalOpen]);

  // Worktree Modal Handlers (stable callbacks for AppWorktreeModals)
  const handleCloseWorktreeConfigModal = useCallback(() => {
    setWorktreeConfigModalOpen(false);
  }, []);

  const handleSaveWorktreeConfig = useCallback(async (config: { basePath: string; watchEnabled: boolean }) => {
    if (!activeSession) return;

    // Save the config first
    setSessions(prev => prev.map(s =>
      s.id === activeSession.id
        ? { ...s, worktreeConfig: config }
        : s
    ));

    // Scan for worktrees and create sub-agent sessions
    // Get SSH remote ID for parent session (check both runtime and config)
    const parentSshRemoteId = activeSession.sshRemoteId || activeSession.sessionSshRemoteConfig?.remoteId || undefined;
    try {
      const scanResult = await window.maestro.git.scanWorktreeDirectory(config.basePath, parentSshRemoteId);
      const { gitSubdirs } = scanResult;

      if (gitSubdirs.length > 0) {
        const newWorktreeSessions: Session[] = [];

        for (const subdir of gitSubdirs) {
          // Skip main/master/HEAD branches - they're typically the main repo
          if (subdir.branch === 'main' || subdir.branch === 'master' || subdir.branch === 'HEAD') {
            continue;
          }

          // Check if a session already exists for this worktree
          const existingSession = sessions.find(s =>
            s.parentSessionId === activeSession.id &&
            s.worktreeBranch === subdir.branch
          );
          if (existingSession) {
            continue;
          }

          // Also check by path
          const existingByPath = sessions.find(s => s.cwd === subdir.path);
          if (existingByPath) {
            continue;
          }

          const newId = generateId();
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
            saveToHistory: true
          };

          // Fetch git info for this subdirectory (with SSH support)
          let gitBranches: string[] | undefined;
          let gitTags: string[] | undefined;
          let gitRefsCacheTime: number | undefined;

          try {
            [gitBranches, gitTags] = await Promise.all([
              gitService.getBranches(subdir.path, parentSshRemoteId),
              gitService.getTags(subdir.path, parentSshRemoteId)
            ]);
            gitRefsCacheTime = Date.now();
          } catch {
            // Ignore errors fetching git info
          }

          const worktreeSession: Session = {
            id: newId,
            name: subdir.branch || subdir.name,
            groupId: activeSession.groupId,
            toolType: activeSession.toolType,
            state: 'idle',
            cwd: subdir.path,
            fullPath: subdir.path,
            projectRoot: subdir.path,
            isGitRepo: true,
            gitBranches,
            gitTags,
            gitRefsCacheTime,
            parentSessionId: activeSession.id,
            worktreeBranch: subdir.branch || undefined,
            // Inherit SSH configuration from parent session
            sessionSshRemoteConfig: activeSession.sessionSshRemoteConfig,
            aiLogs: [],
            shellLogs: [{ id: generateId(), timestamp: Date.now(), source: 'system', text: 'Worktree Session Ready.' }],
            workLog: [],
            contextUsage: 0,
            inputMode: activeSession.toolType === 'terminal' ? 'terminal' : 'ai',
            aiPid: 0,
            terminalPid: 0,
            port: 3000 + Math.floor(Math.random() * 100),
            isLive: false,
            changedFiles: [],
            fileTree: [],
            fileExplorerExpanded: [],
            fileExplorerScrollPos: 0,
            fileTreeAutoRefreshInterval: 180,
            shellCwd: subdir.path,
            aiCommandHistory: [],
            shellCommandHistory: [],
            executionQueue: [],
            activeTimeMs: 0,
            aiTabs: [initialTab],
            activeTabId: initialTabId,
            closedTabHistory: [],
            customPath: activeSession.customPath,
            customArgs: activeSession.customArgs,
            customEnvVars: activeSession.customEnvVars,
            customModel: activeSession.customModel,
            customContextWindow: activeSession.customContextWindow,
            nudgeMessage: activeSession.nudgeMessage,
            autoRunFolderPath: activeSession.autoRunFolderPath
          };

          newWorktreeSessions.push(worktreeSession);
        }

        if (newWorktreeSessions.length > 0) {
          setSessions(prev => [...prev, ...newWorktreeSessions]);
          // Expand worktrees on parent
          setSessions(prev => prev.map(s =>
            s.id === activeSession.id
              ? { ...s, worktreesExpanded: true }
              : s
          ));
          addToast({
            type: 'success',
            title: 'Worktrees Discovered',
            message: `Found ${newWorktreeSessions.length} worktree sub-agent${newWorktreeSessions.length > 1 ? 's' : ''}`,
          });
        }
      }
    } catch (err) {
      console.error('Failed to scan for worktrees:', err);
    }
  }, [activeSession, sessions, addToast]);

  const handleDisableWorktreeConfig = useCallback(() => {
    if (!activeSession) return;
    setSessions(prev => prev.map(s =>
      s.id === activeSession.id
        ? { ...s, worktreeConfig: undefined, worktreeParentPath: undefined }
        : s
    ));
    addToast({
      type: 'success',
      title: 'Worktrees Disabled',
      message: 'Worktree configuration cleared for this agent.',
    });
  }, [activeSession, addToast]);

  const handleCreateWorktreeFromConfig = useCallback(async (branchName: string, basePath: string) => {
    if (!activeSession || !basePath) {
      addToast({ type: 'error', title: 'Error', message: 'No worktree directory configured' });
      return;
    }

    const worktreePath = `${basePath}/${branchName}`;
    console.log('[WorktreeConfig] Create worktree:', branchName, 'at', worktreePath);

    // Get SSH remote ID for remote worktree operations
    // Note: sshRemoteId is only set after AI agent spawns. For terminal-only SSH sessions,
    // we must fall back to sessionSshRemoteConfig.remoteId. See CLAUDE.md "SSH Remote Sessions".
    const sshRemoteId = activeSession.sshRemoteId || activeSession.sessionSshRemoteConfig?.remoteId || undefined;

    try {
      // Create the worktree via git (pass SSH remote ID for remote sessions)
      const result = await window.maestro.git.worktreeSetup(
        activeSession.cwd,
        worktreePath,
        branchName,
        sshRemoteId
      );

      if (!result.success) {
        throw new Error(result.error || 'Failed to create worktree');
      }

      // Create a new session for the worktree, inheriting all config from parent
      const newId = generateId();
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
        saveToHistory: defaultSaveToHistory
      };

      // Fetch git info for the worktree (pass SSH remote ID for remote sessions)
      let gitBranches: string[] | undefined;
      let gitTags: string[] | undefined;
      let gitRefsCacheTime: number | undefined;

      try {
        [gitBranches, gitTags] = await Promise.all([
          gitService.getBranches(worktreePath, sshRemoteId),
          gitService.getTags(worktreePath, sshRemoteId)
        ]);
        gitRefsCacheTime = Date.now();
      } catch {
        // Ignore errors
      }

      const worktreeSession: Session = {
        id: newId,
        name: branchName,
        groupId: activeSession.groupId,
        toolType: activeSession.toolType,
        state: 'idle',
        cwd: worktreePath,
        fullPath: worktreePath,
        projectRoot: worktreePath,
        isGitRepo: true,
        gitBranches,
        gitTags,
        gitRefsCacheTime,
        parentSessionId: activeSession.id,
        worktreeBranch: branchName,
        aiLogs: [],
        shellLogs: [{ id: generateId(), timestamp: Date.now(), source: 'system', text: 'Worktree Session Ready.' }],
        workLog: [],
        contextUsage: 0,
        inputMode: activeSession.toolType === 'terminal' ? 'terminal' : 'ai',
        aiPid: 0,
        terminalPid: 0,
        port: 3000 + Math.floor(Math.random() * 100),
        isLive: false,
        changedFiles: [],
        fileTree: [],
        fileExplorerExpanded: [],
        fileExplorerScrollPos: 0,
        fileTreeAutoRefreshInterval: 180,
        shellCwd: worktreePath,
        aiCommandHistory: [],
        shellCommandHistory: [],
        executionQueue: [],
        activeTimeMs: 0,
        aiTabs: [initialTab],
        activeTabId: initialTabId,
        closedTabHistory: [],
        customPath: activeSession.customPath,
        customArgs: activeSession.customArgs,
        customEnvVars: activeSession.customEnvVars,
        customModel: activeSession.customModel,
        customContextWindow: activeSession.customContextWindow,
        nudgeMessage: activeSession.nudgeMessage,
        autoRunFolderPath: activeSession.autoRunFolderPath,
        // Inherit SSH configuration from parent session
        sessionSshRemoteConfig: activeSession.sessionSshRemoteConfig,
      };

      setSessions(prev => [...prev, worktreeSession]);

      // Expand parent's worktrees
      setSessions(prev => prev.map(s =>
        s.id === activeSession.id ? { ...s, worktreesExpanded: true } : s
      ));

      addToast({
        type: 'success',
        title: 'Worktree Created',
        message: branchName,
      });
    } catch (err) {
      console.error('[WorktreeConfig] Failed to create worktree:', err);
      addToast({
        type: 'error',
        title: 'Failed to Create Worktree',
        message: err instanceof Error ? err.message : String(err),
      });
      throw err; // Re-throw so the modal can show the error
    }
  }, [activeSession, defaultSaveToHistory, addToast]);

  const handleCloseCreateWorktreeModal = useCallback(() => {
    setCreateWorktreeModalOpen(false);
    setCreateWorktreeSession(null);
  }, []);

  const handleCreateWorktree = useCallback(async (branchName: string) => {
    if (!createWorktreeSession) return;

    // Determine base path: use configured path or default to parent directory
    const basePath = createWorktreeSession.worktreeConfig?.basePath ||
      createWorktreeSession.cwd.replace(/\/[^/]+$/, '') + '/worktrees';

    const worktreePath = `${basePath}/${branchName}`;
    console.log('[CreateWorktree] Create worktree:', branchName, 'at', worktreePath);

    // Get SSH remote ID for remote worktree operations
    // Note: sshRemoteId is only set after AI agent spawns. For terminal-only SSH sessions,
    // we must fall back to sessionSshRemoteConfig.remoteId. See CLAUDE.md "SSH Remote Sessions".
    const sshRemoteId = createWorktreeSession.sshRemoteId || createWorktreeSession.sessionSshRemoteConfig?.remoteId || undefined;

    // Create the worktree via git (pass SSH remote ID for remote sessions)
    const result = await window.maestro.git.worktreeSetup(
      createWorktreeSession.cwd,
      worktreePath,
      branchName,
      sshRemoteId
    );

    if (!result.success) {
      throw new Error(result.error || 'Failed to create worktree');
    }

    // Create a new session for the worktree, inheriting all config from parent
    const newId = generateId();
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
      saveToHistory: defaultSaveToHistory
    };

    // Fetch git info for the worktree (pass SSH remote ID for remote sessions)
    let gitBranches: string[] | undefined;
    let gitTags: string[] | undefined;
    let gitRefsCacheTime: number | undefined;

    try {
      [gitBranches, gitTags] = await Promise.all([
        gitService.getBranches(worktreePath, sshRemoteId),
        gitService.getTags(worktreePath, sshRemoteId)
      ]);
      gitRefsCacheTime = Date.now();
    } catch {
      // Ignore errors
    }

    const worktreeSession: Session = {
      id: newId,
      name: branchName,
      groupId: createWorktreeSession.groupId,
      toolType: createWorktreeSession.toolType,
      state: 'idle',
      cwd: worktreePath,
      fullPath: worktreePath,
      projectRoot: worktreePath,
      isGitRepo: true,
      gitBranches,
      gitTags,
      gitRefsCacheTime,
      parentSessionId: createWorktreeSession.id,
      worktreeBranch: branchName,
      aiLogs: [],
      shellLogs: [{ id: generateId(), timestamp: Date.now(), source: 'system', text: 'Worktree Session Ready.' }],
      workLog: [],
      contextUsage: 0,
      inputMode: createWorktreeSession.toolType === 'terminal' ? 'terminal' : 'ai',
      aiPid: 0,
      terminalPid: 0,
      port: 3000 + Math.floor(Math.random() * 100),
      isLive: false,
      changedFiles: [],
      fileTree: [],
      fileExplorerExpanded: [],
      fileExplorerScrollPos: 0,
      fileTreeAutoRefreshInterval: 180,
      shellCwd: worktreePath,
      aiCommandHistory: [],
      shellCommandHistory: [],
      executionQueue: [],
      activeTimeMs: 0,
      aiTabs: [initialTab],
      activeTabId: initialTabId,
      closedTabHistory: [],
      customPath: createWorktreeSession.customPath,
      customArgs: createWorktreeSession.customArgs,
      customEnvVars: createWorktreeSession.customEnvVars,
      customModel: createWorktreeSession.customModel,
      customContextWindow: createWorktreeSession.customContextWindow,
      nudgeMessage: createWorktreeSession.nudgeMessage,
      autoRunFolderPath: createWorktreeSession.autoRunFolderPath,
      // Inherit SSH configuration from parent session
      sessionSshRemoteConfig: createWorktreeSession.sessionSshRemoteConfig,
    };

    setSessions(prev => [...prev, worktreeSession]);

    // Expand parent's worktrees
    setSessions(prev => prev.map(s =>
      s.id === createWorktreeSession.id ? { ...s, worktreesExpanded: true } : s
    ));

    // Save worktree config if not already configured
    if (!createWorktreeSession.worktreeConfig?.basePath) {
      setSessions(prev => prev.map(s =>
        s.id === createWorktreeSession.id
          ? { ...s, worktreeConfig: { basePath, watchEnabled: true } }
          : s
      ));
    }

    addToast({
      type: 'success',
      title: 'Worktree Created',
      message: branchName,
    });
  }, [createWorktreeSession, defaultSaveToHistory, addToast]);

  const handleCloseCreatePRModal = useCallback(() => {
    setCreatePRModalOpen(false);
    setCreatePRSession(null);
  }, []);

  const handlePRCreated = useCallback(async (prDetails: PRDetails) => {
    const session = createPRSession || activeSession;
    addToast({
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
        ].filter(Boolean).join('\n\n'),
        projectPath: session.projectRoot || session.cwd,
        sessionId: session.id,
        sessionName: session.name,
      });
      rightPanelRef.current?.refreshHistoryPanel();
    }
    setCreatePRSession(null);
  }, [createPRSession, activeSession, addToast]);

  const handleCloseDeleteWorktreeModal = useCallback(() => {
    setDeleteWorktreeModalOpen(false);
    setDeleteWorktreeSession(null);
  }, []);

  const handleConfirmDeleteWorktree = useCallback(() => {
    if (!deleteWorktreeSession) return;
    // Remove the session but keep the worktree on disk
    setSessions(prev => prev.filter(s => s.id !== deleteWorktreeSession.id));
  }, [deleteWorktreeSession]);

  const handleConfirmAndDeleteWorktreeOnDisk = useCallback(async () => {
    if (!deleteWorktreeSession) return;
    // Remove the session AND delete the worktree from disk
    const result = await window.maestro.git.removeWorktree(deleteWorktreeSession.cwd, true);
    if (!result.success) {
      throw new Error(result.error || 'Failed to remove worktree');
    }
    setSessions(prev => prev.filter(s => s.id !== deleteWorktreeSession.id));
  }, [deleteWorktreeSession]);

  // AppUtilityModals stable callbacks
  const handleCloseLightbox = useCallback(() => {
    setLightboxImage(null);
    setLightboxImages([]);
    setLightboxSource('history');
    lightboxIsGroupChatRef.current = false;
    lightboxAllowDeleteRef.current = false;
    // Return focus to input after closing carousel
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []);
  const handleNavigateLightbox = useCallback((img: string) => setLightboxImage(img), []);
  const handleDeleteLightboxImage = useCallback((img: string) => {
    // Use ref for group chat check - refs are set synchronously before React batches state updates
    if (lightboxIsGroupChatRef.current) {
      setGroupChatStagedImages(prev => prev.filter(i => i !== img));
    } else {
      setStagedImages(prev => prev.filter(i => i !== img));
    }
  }, []);
  const handleCloseAutoRunSetup = useCallback(() => setAutoRunSetupModalOpen(false), []);
  const handleCloseBatchRunner = useCallback(() => setBatchRunnerModalOpen(false), []);
  const handleSaveBatchPrompt = useCallback((prompt: string) => {
    if (!activeSession) return;
    // Save the custom prompt and modification timestamp to the session (persisted across restarts)
    setSessions(prev => prev.map(s =>
      s.id === activeSession.id ? { ...s, batchRunnerPrompt: prompt, batchRunnerPromptModifiedAt: Date.now() } : s
    ));
  }, [activeSession]);
  const handleCloseTabSwitcher = useCallback(() => setTabSwitcherOpen(false), []);
  const handleUtilityTabSelect = useCallback((tabId: string) => {
    if (!activeSession) return;
    setSessions(prev => prev.map(s =>
      s.id === activeSession.id ? { ...s, activeTabId: tabId } : s
    ));
  }, [activeSession]);
  const handleNamedSessionSelect = useCallback((agentSessionId: string, _projectPath: string, sessionName: string, starred?: boolean) => {
    // Open a closed named session as a new tab - use handleResumeSession to properly load messages
    handleResumeSession(agentSessionId, [], sessionName, starred);
    // Focus input so user can start interacting immediately
    setActiveFocus('main');
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [handleResumeSession, setActiveFocus]);
  const handleCloseFileSearch = useCallback(() => setFuzzyFileSearchOpen(false), []);
  const handleFileSearchSelect = useCallback((file: FlatFileItem) => {
    // Preview the file directly (handleFileClick expects relative path)
    if (!file.isFolder) {
      handleFileClick({ name: file.name, type: 'file' }, file.fullPath);
    }
  }, [handleFileClick]);
  const handleClosePromptComposer = useCallback(() => {
    setPromptComposerOpen(false);
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []);
  const handlePromptComposerSubmit = useCallback((value: string) => {
    if (activeGroupChatId) {
      // Update group chat draft
      setGroupChats(prev => prev.map(c =>
        c.id === activeGroupChatId ? { ...c, draftMessage: value } : c
      ));
    } else {
      setInputValue(value);
    }
  }, [activeGroupChatId]);
  const handlePromptComposerSend = useCallback((value: string) => {
    if (activeGroupChatId) {
      // Send to group chat
      handleSendGroupChatMessage(value, groupChatStagedImages.length > 0 ? groupChatStagedImages : undefined, groupChatReadOnlyMode);
      setGroupChatStagedImages([]);
      // Clear draft
      setGroupChats(prev => prev.map(c =>
        c.id === activeGroupChatId ? { ...c, draftMessage: '' } : c
      ));
    } else {
      // Set the input value and trigger send
      setInputValue(value);
      // Use setTimeout to ensure state updates before processing
      setTimeout(() => processInput(value), 0);
    }
  }, [activeGroupChatId, groupChatStagedImages, groupChatReadOnlyMode, handleSendGroupChatMessage, processInput]);
  const handlePromptToggleTabSaveToHistory = useCallback(() => {
    if (!activeSession) return;
    const activeTab = getActiveTab(activeSession);
    if (!activeTab) return;
    setSessions(prev => prev.map(s => {
      if (s.id !== activeSession.id) return s;
      return {
        ...s,
        aiTabs: s.aiTabs.map(tab =>
          tab.id === activeTab.id ? { ...tab, saveToHistory: !tab.saveToHistory } : tab
        )
      };
    }));
  }, [activeSession, getActiveTab]);
  const handlePromptToggleTabReadOnlyMode = useCallback(() => {
    if (activeGroupChatId) {
      setGroupChatReadOnlyMode(prev => !prev);
    } else {
      if (!activeSession) return;
      const activeTab = getActiveTab(activeSession);
      if (!activeTab) return;
      setSessions(prev => prev.map(s => {
        if (s.id !== activeSession.id) return s;
        return {
          ...s,
          aiTabs: s.aiTabs.map(tab =>
            tab.id === activeTab.id ? { ...tab, readOnlyMode: !tab.readOnlyMode } : tab
          )
        };
      }));
    }
  }, [activeGroupChatId, activeSession, getActiveTab]);
  const handlePromptToggleTabShowThinking = useCallback(() => {
    if (!activeSession) return;
    const activeTab = getActiveTab(activeSession);
    if (!activeTab) return;
    setSessions(prev => prev.map(s => {
      if (s.id !== activeSession.id) return s;
      return {
        ...s,
        aiTabs: s.aiTabs.map(tab => {
          if (tab.id !== activeTab.id) return tab;
          if (tab.showThinking) {
            // Turn off - clear thinking logs
            return {
              ...tab,
              showThinking: false,
              logs: tab.logs.filter(log => log.source !== 'thinking'),
            };
          }
          return { ...tab, showThinking: true };
        })
      };
    }));
  }, [activeSession, getActiveTab]);
  const handlePromptToggleEnterToSend = useCallback(() => setEnterToSendAI(!enterToSendAI), [enterToSendAI]);
  // OpenSpec command injection - sets prompt content into input field
  const handleInjectOpenSpecPrompt = useCallback((prompt: string) => {
    if (activeGroupChatId) {
      // Update group chat draft
      setGroupChats(prev => prev.map(c =>
        c.id === activeGroupChatId ? { ...c, draftMessage: prompt } : c
      ));
    } else {
      setInputValue(prompt);
    }
    // Focus the input so user can edit/send the injected prompt
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [activeGroupChatId, setInputValue]);

  // QuickActionsModal stable callbacks
  const handleQuickActionsRenameTab = useCallback(() => {
    if (activeSession?.inputMode === 'ai' && activeSession.activeTabId) {
      const activeTab = activeSession.aiTabs?.find(t => t.id === activeSession.activeTabId);
      // Only allow rename if tab has an active Claude session
      if (activeTab?.agentSessionId) {
        setRenameTabId(activeTab.id);
        setRenameTabInitialName(getInitialRenameValue(activeTab));
        setRenameTabModalOpen(true);
      }
    }
  }, [activeSession, getInitialRenameValue]);
  const handleQuickActionsToggleReadOnlyMode = useCallback(() => {
    if (activeSession?.inputMode === 'ai' && activeSession.activeTabId) {
      setSessions(prev => prev.map(s => {
        if (s.id !== activeSession.id) return s;
        return {
          ...s,
          aiTabs: s.aiTabs.map(tab =>
            tab.id === s.activeTabId ? { ...tab, readOnlyMode: !tab.readOnlyMode } : tab
          )
        };
      }));
    }
  }, [activeSession]);
  const handleQuickActionsToggleTabShowThinking = useCallback(() => {
    if (activeSession?.inputMode === 'ai' && activeSession.activeTabId) {
      setSessions(prev => prev.map(s => {
        if (s.id !== activeSession.id) return s;
        return {
          ...s,
          aiTabs: s.aiTabs.map(tab => {
            if (tab.id !== s.activeTabId) return tab;
            // When turning OFF, clear any thinking/tool logs
            if (tab.showThinking) {
              return {
                ...tab,
                showThinking: false,
                logs: tab.logs.filter(l => l.source !== 'thinking' && l.source !== 'tool')
              };
            }
            return { ...tab, showThinking: true };
          })
        };
      }));
    }
  }, [activeSession]);
  const handleQuickActionsOpenTabSwitcher = useCallback(() => {
    if (activeSession?.inputMode === 'ai' && activeSession.aiTabs) {
      setTabSwitcherOpen(true);
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
    setSessions(prev => prev.map(s => {
      if (s.id !== activeSessionId) return s;
      return { ...s, executionQueue: remainingQueue };
    }));
    // Process the item
    processQueuedItem(activeSessionId, nextItem);
  }, [activeSession, activeSessionId, processQueuedItem]);
  const handleQuickActionsToggleMarkdownEditMode = useCallback(() => setMarkdownEditMode(!markdownEditMode), [markdownEditMode]);
  const handleQuickActionsStartTour = useCallback(() => {
    setTourFromWizard(false);
    setTourOpen(true);
  }, []);
  const handleQuickActionsEditAgent = useCallback((session: Session) => {
    setEditAgentSession(session);
    setEditAgentModalOpen(true);
  }, []);
  const handleQuickActionsNewGroupChat = useCallback(() => setShowNewGroupChatModal(true), []);
  const handleQuickActionsOpenMergeSession = useCallback(() => setMergeSessionModalOpen(true), []);
  const handleQuickActionsOpenSendToAgent = useCallback(() => setSendToAgentModalOpen(true), []);
  const handleQuickActionsOpenCreatePR = useCallback((session: Session) => {
    setCreatePRSession(session);
    setCreatePRModalOpen(true);
  }, []);
  const handleQuickActionsSummarizeAndContinue = useCallback(() => handleSummarizeAndContinue(), [handleSummarizeAndContinue]);
  const handleQuickActionsToggleRemoteControl = useCallback(async () => {
    await toggleGlobalLive();
    // Show flash notification based on the NEW state (opposite of current)
    if (isLiveMode) {
      // Was live, now offline
      setSuccessFlashNotification('Remote Control: OFFLINE — See indicator at top of left panel');
    } else {
      // Was offline, now live
      setSuccessFlashNotification('Remote Control: LIVE — See LIVE indicator at top of left panel for QR code');
    }
    setTimeout(() => setSuccessFlashNotification(null), 4000);
  }, [toggleGlobalLive, isLiveMode, setSuccessFlashNotification]);
  const handleQuickActionsAutoRunResetTasks = useCallback(() => {
    rightPanelRef.current?.openAutoRunResetTasksModal();
  }, []);

  const handleCloseQueueBrowser = useCallback(() => setQueueBrowserOpen(false), []);
  const handleRemoveQueueItem = useCallback((sessionId: string, itemId: string) => {
    setSessions(prev => prev.map(s => {
      if (s.id !== sessionId) return s;
      return {
        ...s,
        executionQueue: s.executionQueue.filter(item => item.id !== itemId)
      };
    }));
  }, []);
  const handleSwitchQueueSession = useCallback((sessionId: string) => {
    setActiveSessionId(sessionId);
  }, [setActiveSessionId]);
  const handleReorderQueueItems = useCallback((sessionId: string, fromIndex: number, toIndex: number) => {
    setSessions(prev => prev.map(s => {
      if (s.id !== sessionId) return s;
      const queue = [...s.executionQueue];
      const [removed] = queue.splice(fromIndex, 1);
      queue.splice(toIndex, 0, removed);
      return { ...s, executionQueue: queue };
    }));
  }, []);

  // Update keyboardHandlerRef synchronously during render (before effects run)
  // This must be placed after all handler functions and state are defined to avoid TDZ errors
  // The ref is provided by useMainKeyboardHandler hook
  keyboardHandlerRef.current = {
    shortcuts, activeFocus, activeRightTab, sessions, selectedSidebarIndex, activeSessionId,
    quickActionOpen, settingsModalOpen, shortcutsHelpOpen, newInstanceModalOpen, aboutModalOpen,
    processMonitorOpen, logViewerOpen, createGroupModalOpen, confirmModalOpen, renameInstanceModalOpen,
    renameGroupModalOpen, activeSession, previewFile, fileTreeFilter, fileTreeFilterOpen, gitDiffPreview,
    gitLogOpen, lightboxImage, hasOpenLayers, hasOpenModal, visibleSessions, sortedSessions, groups,
    bookmarksCollapsed, leftSidebarOpen, editingSessionId, editingGroupId, markdownEditMode, defaultSaveToHistory, defaultShowThinking,
    setLeftSidebarOpen, setRightPanelOpen, addNewSession, deleteSession, setQuickActionInitialMode,
    setQuickActionOpen, cycleSession, toggleInputMode, setShortcutsHelpOpen, setSettingsModalOpen,
    setSettingsTab, setActiveRightTab, handleSetActiveRightTab, setActiveFocus, setBookmarksCollapsed, setGroups,
    setSelectedSidebarIndex, setActiveSessionId, handleViewGitDiff, setGitLogOpen, setActiveAgentSessionId,
    setAgentSessionsOpen, setLogViewerOpen, setProcessMonitorOpen, setUsageDashboardOpen, logsEndRef, inputRef, terminalOutputRef, sidebarContainerRef,
    setSessions, createTab, closeTab, reopenClosedTab, getActiveTab, setRenameTabId, setRenameTabInitialName,
    setRenameTabModalOpen, navigateToNextTab, navigateToPrevTab, navigateToTabByIndex, navigateToLastTab,
    setFileTreeFilterOpen, isShortcut, isTabShortcut, handleNavBack, handleNavForward, toggleUnreadFilter,
    setTabSwitcherOpen, showUnreadOnly, stagedImages, handleSetLightboxImage, setMarkdownEditMode,
    toggleTabStar, toggleTabUnread, setPromptComposerOpen, openWizardModal, rightPanelRef, setFuzzyFileSearchOpen,
    setMarketplaceModalOpen, setShowNewGroupChatModal, deleteGroupChatWithConfirmation,
    // Group chat context
    activeGroupChatId, groupChatInputRef, groupChatStagedImages, setGroupChatRightTab,
    // Navigation handlers from useKeyboardNavigation hook
    handleSidebarNavigation, handleTabNavigation, handleEnterToActivate, handleEscapeInMain,
    // Agent capabilities
    hasActiveSessionCapability,

    // Merge session modal and send to agent modal
    setMergeSessionModalOpen,
    setSendToAgentModalOpen,
    // Summarize and continue
    canSummarizeActiveTab: (() => {
      if (!activeSession || !activeSession.activeTabId) return false;
      return canSummarize(activeSession.contextUsage);
    })(),
    summarizeAndContinue: handleSummarizeAndContinue,

    // Keyboard mastery gamification
    recordShortcutUsage, onKeyboardMasteryLevelUp,

    // Edit agent modal
    setEditAgentSession, setEditAgentModalOpen

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
        .filter(node => !node.name.startsWith('.'))
        .map(node => ({
          ...node,
          children: node.children ? filterHiddenFiles(node.children) : undefined
        }));
    };

    // Use filteredFileTree when available (it returns the full tree when no filter is active)
    // Then apply hidden files filter to match what FileExplorerPanel displays
    const displayTree = filterHiddenFiles(filteredFileTree);
    setFlatFileList(flattenTree(displayTree, expandedSet));
     
  }, [activeSession?.fileExplorerExpanded, filteredFileTree, showHiddenFiles]);

  // Handle pending jump path from /jump command
  useEffect(() => {
    if (!activeSession || activeSession.pendingJumpPath === undefined || flatFileList.length === 0) return;

    const jumpPath = activeSession.pendingJumpPath;

    // Find the target index
    let targetIndex = 0;

    if (jumpPath === '') {
      // Jump to root - select first item
      targetIndex = 0;
    } else {
      // Find the folder in the flat list and select it directly
      const folderIndex = flatFileList.findIndex(item => item.fullPath === jumpPath && item.isFolder);

      if (folderIndex !== -1) {
        // Select the folder itself (not its first child)
        targetIndex = folderIndex;
      }
      // If folder not found, stay at 0
    }

    fileTreeKeyboardNavRef.current = true; // Scroll to jumped file
    setSelectedFileIndex(targetIndex);

    // Clear the pending jump path
    setSessions(prev => prev.map(s =>
      s.id === activeSession.id ? { ...s, pendingJumpPath: undefined } : s
    ));
     
  }, [activeSession?.pendingJumpPath, flatFileList, activeSession?.id]);

  // Scroll to selected file item when selection changes via keyboard
  useEffect(() => {
    // Only scroll when selection changed via keyboard navigation, not mouse click
    if (!fileTreeKeyboardNavRef.current) return;
    fileTreeKeyboardNavRef.current = false; // Reset flag after handling

    // Allow scroll when:
    // 1. Right panel is focused on files tab (normal keyboard navigation)
    // 2. Tab completion is open and files tab is visible (sync from tab completion)
    const shouldScroll = (activeFocus === 'right' && activeRightTab === 'files') ||
                         (tabCompletionOpen && activeRightTab === 'files');
    if (!shouldScroll) return;

    // Use requestAnimationFrame to ensure DOM is updated
    requestAnimationFrame(() => {
      const container = fileTreeContainerRef.current;
      if (!container) return;

      // Find the selected element
      const selectedElement = container.querySelector(`[data-file-index="${selectedFileIndex}"]`) as HTMLElement;

      if (selectedElement) {
        // Use scrollIntoView with center alignment to avoid sticky header overlap
        selectedElement.scrollIntoView({
          behavior: 'auto',  // Immediate scroll
          block: 'center',  // Center in viewport to avoid sticky header at top
          inline: 'nearest'
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
      if (activeFocus !== 'right' || activeRightTab !== 'files' || flatFileList.length === 0) return;

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
        setSelectedFileIndex(prev => Math.max(0, prev - 10));
      } else if (e.altKey && e.key === 'ArrowDown') {
        e.preventDefault();
        fileTreeKeyboardNavRef.current = true;
        setSelectedFileIndex(prev => Math.min(flatFileList.length - 1, prev + 10));
      }
      // Regular Arrow: move one item
      else if (e.key === 'ArrowUp') {
        e.preventDefault();
        fileTreeKeyboardNavRef.current = true;
        setSelectedFileIndex(prev => Math.max(0, prev - 1));
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        fileTreeKeyboardNavRef.current = true;
        setSelectedFileIndex(prev => Math.min(flatFileList.length - 1, prev + 1));
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        const selectedItem = flatFileList[selectedFileIndex];
        if (selectedItem?.isFolder && expandedFolders.has(selectedItem.fullPath)) {
          // If selected item is an expanded folder, collapse it
          toggleFolder(selectedItem.fullPath, activeSessionId, setSessions);
        } else if (selectedItem) {
          // If selected item is a file or collapsed folder, collapse parent folder
          const parentPath = selectedItem.fullPath.substring(0, selectedItem.fullPath.lastIndexOf('/'));
          if (parentPath && expandedFolders.has(parentPath)) {
            toggleFolder(parentPath, activeSessionId, setSessions);
            // Move selection to parent folder
            const parentIndex = flatFileList.findIndex(item => item.fullPath === parentPath);
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
  }, [activeFocus, activeRightTab, flatFileList, selectedFileIndex, activeSession?.fileExplorerExpanded, activeSessionId, setSessions, toggleFolder, handleFileClick, hasOpenModal]);

  return (
    <GitStatusProvider sessions={sessions} activeSessionId={activeSessionId}>
      <div className={`flex h-screen w-full font-mono overflow-hidden transition-colors duration-300 ${isMobileLandscape ? 'pt-0' : 'pt-10'}`}
           style={{
             backgroundColor: theme.colors.bgMain,
             color: theme.colors.textMain,
             fontFamily: fontFamily,
             fontSize: `${fontSize}px`
           }}
           onDragEnter={handleImageDragEnter}
           onDragLeave={handleImageDragLeave}
           onDragOver={handleImageDragOver}
           onDrop={handleDrop}>

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
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
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
        style={{
          WebkitAppRegion: 'drag',
        } as React.CSSProperties}
      >
        {activeGroupChatId ? (
          <span
            className="text-xs select-none opacity-50"
            style={{ color: theme.colors.textDim }}
          >
            Maestro Group Chat: {groupChats.find(c => c.id === activeGroupChatId)?.name || 'Unknown'}
          </span>
        ) : activeSession && (
          <span
            className="text-xs select-none opacity-50"
            style={{ color: theme.colors.textDim }}
          >
            {(() => {
              const parts: string[] = [];
              // Group name (if grouped)
              const group = groups.find(g => g.id === activeSession.groupId);
              if (group) {
                parts.push(`${group.emoji} ${group.name}`);
              }
              // Agent name (user-given name for this agent instance)
              parts.push(activeSession.name);
              // Active tab name or UUID octet
              const activeTab = activeSession.aiTabs?.find(t => t.id === activeSession.activeTabId);
              if (activeTab) {
                const tabLabel = activeTab.name ||
                  (activeTab.agentSessionId ? activeTab.agentSessionId.split('-')[0].toUpperCase() : null);
                if (tabLabel) {
                  parts.push(tabLabel);
                }
              }
              return parts.join(' | ');
            })()}
          </span>
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
        onCloseConfirmModal={handleCloseConfirmModal}
        quitConfirmModalOpen={quitConfirmModalOpen}
        onConfirmQuit={handleConfirmQuit}
        onCancelQuit={handleCancelQuit}
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
        setPlaygroundOpen={setPlaygroundOpen}
        onQuickActionsRefreshGitFileState={handleQuickActionsRefreshGitFileState}
        onQuickActionsDebugReleaseQueuedItem={handleQuickActionsDebugReleaseQueuedItem}
        markdownEditMode={markdownEditMode}
        onQuickActionsToggleMarkdownEditMode={handleQuickActionsToggleMarkdownEditMode}
        setUpdateCheckModalOpenForQuickActions={setUpdateCheckModalOpen}
        openWizard={openWizardModal}
        wizardGoToStep={wizardGoToStep}
        setDebugWizardModalOpen={setDebugWizardModalOpen}
        setDebugPackageModalOpen={setDebugPackageModalOpen}
        startTour={handleQuickActionsStartTour}
        setFuzzyFileSearchOpen={setFuzzyFileSearchOpen}
        onEditAgent={handleQuickActionsEditAgent}
        onNewGroupChat={handleQuickActionsNewGroupChat}
        onOpenGroupChat={handleOpenGroupChat}
        onCloseGroupChat={handleCloseGroupChat}
        onDeleteGroupChat={deleteGroupChatWithConfirmation}
        activeGroupChatId={activeGroupChatId}
        hasActiveSessionCapability={hasActiveSessionCapability}
        onOpenMergeSession={handleQuickActionsOpenMergeSession}
        onOpenSendToAgent={handleQuickActionsOpenSendToAgent}
        onOpenCreatePR={handleQuickActionsOpenCreatePR}
        onSummarizeAndContinue={handleQuickActionsSummarizeAndContinue}
        canSummarizeActiveTab={activeSession ? canSummarize(activeSession.contextUsage) : false}
        onToggleRemoteControl={handleQuickActionsToggleRemoteControl}
        autoRunSelectedDocument={activeSession?.autoRunSelectedFile ?? null}
        autoRunCompletedTaskCount={rightPanelRef.current?.getAutoRunCompletedTaskCount() ?? 0}
        onAutoRunResetTasks={handleQuickActionsAutoRunResetTasks}
        isFilePreviewOpen={previewFile !== null}
        ghCliAvailable={ghCliAvailable}
        onPublishGist={() => setGistPublishModalOpen(true)}
        onInjectOpenSpecPrompt={handleInjectOpenSpecPrompt}
        lastGraphFocusFile={lastGraphFocusFilePath}
        onOpenLastDocumentGraph={() => {
          if (lastGraphFocusFilePath) {
            setGraphFocusFilePath(lastGraphFocusFilePath);
            setIsGraphViewOpen(true);
          }
        }}
        lightboxImage={lightboxImage}
        lightboxImages={lightboxImages}
        stagedImages={stagedImages}
        onCloseLightbox={handleCloseLightbox}
        onNavigateLightbox={handleNavigateLightbox}
        onDeleteLightboxImage={lightboxAllowDeleteRef.current ? handleDeleteLightboxImage : undefined}
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
        tabSwitcherOpen={tabSwitcherOpen}
        onCloseTabSwitcher={handleCloseTabSwitcher}
        onTabSelect={handleUtilityTabSelect}
        onNamedSessionSelect={handleNamedSessionSelect}
        fuzzyFileSearchOpen={fuzzyFileSearchOpen}
        filteredFileTree={filteredFileTree}
        onCloseFileSearch={handleCloseFileSearch}
        onFileSearchSelect={handleFileSearchSelect}
        promptComposerOpen={promptComposerOpen}
        onClosePromptComposer={handleClosePromptComposer}
        promptComposerInitialValue={activeGroupChatId
          ? (groupChats.find(c => c.id === activeGroupChatId)?.draftMessage || '')
          : inputValue}
        onPromptComposerSubmit={handlePromptComposerSubmit}
        onPromptComposerSend={handlePromptComposerSend}
        promptComposerSessionName={activeGroupChatId
          ? groupChats.find(c => c.id === activeGroupChatId)?.name
          : activeSession?.name}
        promptComposerStagedImages={activeGroupChatId ? groupChatStagedImages : (canAttachImages ? stagedImages : [])}
        setPromptComposerStagedImages={activeGroupChatId ? setGroupChatStagedImages : (canAttachImages ? setStagedImages : undefined)}
        onPromptImageAttachBlocked={activeGroupChatId || !blockCodexResumeImages ? undefined : showImageAttachBlockedNotice}
        onPromptOpenLightbox={handleSetLightboxImage}
        promptTabSaveToHistory={activeGroupChatId ? false : (activeSession ? getActiveTab(activeSession)?.saveToHistory ?? false : false)}
        onPromptToggleTabSaveToHistory={activeGroupChatId ? undefined : handlePromptToggleTabSaveToHistory}
        promptTabReadOnlyMode={activeGroupChatId ? groupChatReadOnlyMode : (activeSession ? getActiveTab(activeSession)?.readOnlyMode ?? false : false)}
        onPromptToggleTabReadOnlyMode={handlePromptToggleTabReadOnlyMode}
        promptTabShowThinking={activeGroupChatId ? false : (activeSession ? getActiveTab(activeSession)?.showThinking ?? false : false)}
        onPromptToggleTabShowThinking={activeGroupChatId ? undefined : handlePromptToggleTabShowThinking}
        promptSupportsThinking={!activeGroupChatId && hasActiveSessionCapability('supportsThinkingDisplay')}
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

      {/* --- MARKETPLACE MODAL --- */}
      {activeSession && activeSession.autoRunFolderPath && (
        <MarketplaceModal
          theme={theme}
          isOpen={marketplaceModalOpen}
          onClose={() => setMarketplaceModalOpen(false)}
          autoRunFolderPath={activeSession.autoRunFolderPath}
          sessionId={activeSession.id}
          sshRemoteId={activeSession.sshRemoteId || activeSession.sessionSshRemoteConfig?.remoteId || undefined}
          onImportComplete={handleMarketplaceImportComplete}
        />
      )}

      {/* --- GIST PUBLISH MODAL --- */}
      {gistPublishModalOpen && previewFile && (
        <GistPublishModal
          theme={theme}
          filename={previewFile.name}
          content={previewFile.content}
          onClose={() => setGistPublishModalOpen(false)}
          onSuccess={(gistUrl, isPublic) => {
            // Copy the gist URL to clipboard
            navigator.clipboard.writeText(gistUrl);
            // Show a toast notification
            addToast({
              type: 'success',
              title: 'Gist Published',
              message: `${isPublic ? 'Public' : 'Secret'} gist created! URL copied to clipboard.`,
              duration: 5000,
              actionUrl: gistUrl,
              actionLabel: 'Open Gist',
            });
          }}
        />
      )}

      {/* --- DOCUMENT GRAPH VIEW (Mind Map) --- */}
      {/* Only render when a focus file is provided - mind map requires a center document */}
      {graphFocusFilePath && (
        <DocumentGraphView
          isOpen={isGraphViewOpen}
          onClose={() => {
            setIsGraphViewOpen(false);
            setGraphFocusFilePath(undefined);
            // Return focus to file preview if it was open
            requestAnimationFrame(() => {
              mainPanelRef.current?.focusFilePreview();
            });
          }}
          theme={theme}
          rootPath={activeSession?.cwd ?? ''}
          onDocumentOpen={(filePath) => {
            // Open the document in file preview
            const fullPath = `${activeSession?.cwd ?? ''}/${filePath}`;
            window.maestro.fs.readFile(fullPath, activeSession?.sshRemoteId).then((content) => {
              if (content !== null) {
                setPreviewFile({ name: filePath.split('/').pop() || filePath, content, path: fullPath });
              }
            });
            setIsGraphViewOpen(false);
          }}
          onExternalLinkOpen={(url) => {
            // Open external URL in default browser
            window.maestro.shell.openExternal(url);
          }}
          focusFilePath={graphFocusFilePath}
          defaultShowExternalLinks={documentGraphShowExternalLinks}
          onExternalLinksChange={settings.setDocumentGraphShowExternalLinks}
          defaultMaxNodes={documentGraphMaxNodes}
          sshRemoteId={activeSession?.sshRemoteId}
        />
      )}

      {/* NOTE: All modals are now rendered via the unified <AppModals /> component above */}

      {/* --- EMPTY STATE VIEW (when no sessions) --- */}
      {sessions.length === 0 && !isMobileLandscape ? (
        <EmptyStateView
          theme={theme}
          shortcuts={shortcuts}
          onNewAgent={addNewSession}
          onOpenWizard={openWizardModal}
          onOpenSettings={() => { setSettingsModalOpen(true); setSettingsTab('general'); }}
          onOpenShortcutsHelp={() => setShortcutsHelpOpen(true)}
          onOpenAbout={() => setAboutModalOpen(true)}
          onCheckForUpdates={() => setUpdateCheckModalOpen(true)}
          // Don't show tour option when no agents exist - nothing to tour
        />
      ) : null}

      {/* --- LEFT SIDEBAR (hidden in mobile landscape and when no sessions) --- */}
      {!isMobileLandscape && sessions.length > 0 && (
        <ErrorBoundary>
          <SessionList
            theme={theme}
            sessions={sessions}
            groups={groups}
            sortedSessions={sortedSessions}
            activeSessionId={activeSessionId}
            leftSidebarOpen={leftSidebarOpen}
            leftSidebarWidthState={leftSidebarWidth}
            activeFocus={activeFocus}
            selectedSidebarIndex={selectedSidebarIndex}
            editingGroupId={editingGroupId}
            editingSessionId={editingSessionId}
            draggingSessionId={draggingSessionId}
            shortcuts={shortcuts}
            isLiveMode={isLiveMode}
            webInterfaceUrl={webInterfaceUrl}
            toggleGlobalLive={toggleGlobalLive}
            webInterfaceUseCustomPort={settings.webInterfaceUseCustomPort}
            setWebInterfaceUseCustomPort={settings.setWebInterfaceUseCustomPort}
            webInterfaceCustomPort={settings.webInterfaceCustomPort}
            setWebInterfaceCustomPort={settings.setWebInterfaceCustomPort}
            restartWebServer={restartWebServer}
            bookmarksCollapsed={bookmarksCollapsed}
            setBookmarksCollapsed={setBookmarksCollapsed}
            ungroupedCollapsed={settings.ungroupedCollapsed}
            setUngroupedCollapsed={settings.setUngroupedCollapsed}
            setActiveFocus={setActiveFocus}
            setActiveSessionId={setActiveSessionId}
            setLeftSidebarOpen={setLeftSidebarOpen}
            setLeftSidebarWidthState={setLeftSidebarWidth}
            setShortcutsHelpOpen={setShortcutsHelpOpen}
            setSettingsModalOpen={setSettingsModalOpen}
            setSettingsTab={setSettingsTab}
            setAboutModalOpen={setAboutModalOpen}
            setUpdateCheckModalOpen={setUpdateCheckModalOpen}
            setLogViewerOpen={setLogViewerOpen}
            setProcessMonitorOpen={setProcessMonitorOpen}
            setUsageDashboardOpen={setUsageDashboardOpen}
            toggleGroup={toggleGroup}
            handleDragStart={handleDragStart}
            handleDragOver={handleDragOver}
            handleDropOnGroup={handleDropOnGroup}
            handleDropOnUngrouped={handleDropOnUngrouped}
            finishRenamingGroup={finishRenamingGroup}
            finishRenamingSession={finishRenamingSession}
            startRenamingGroup={startRenamingGroup}
            startRenamingSession={startRenamingSession}
            showConfirmation={showConfirmation}
            setGroups={setGroups}
            setSessions={setSessions}
            createNewGroup={createNewGroup}
            onCreateGroupAndMove={handleCreateGroupAndMove}
            addNewSession={addNewSession}
            onDeleteSession={deleteSession}
            onDeleteWorktreeGroup={deleteWorktreeGroup}
            setRenameInstanceModalOpen={setRenameInstanceModalOpen}
            setRenameInstanceValue={setRenameInstanceValue}
            setRenameInstanceSessionId={setRenameInstanceSessionId}
            onEditAgent={(session) => {
              setEditAgentSession(session);
              setEditAgentModalOpen(true);
            }}
            onOpenCreatePR={(session) => {
              setCreatePRSession(session);
              setCreatePRModalOpen(true);
            }}
            onQuickCreateWorktree={(session) => {
              setCreateWorktreeSession(session);
              setCreateWorktreeModalOpen(true);
            }}
            onOpenWorktreeConfig={(session) => {
              // Set the active session to the one we're configuring, then open the modal
              setActiveSessionId(session.id);
              setWorktreeConfigModalOpen(true);
            }}
            onDeleteWorktree={(session) => {
              // Show delete worktree modal with options
              setDeleteWorktreeSession(session);
              setDeleteWorktreeModalOpen(true);
            }}
            onToggleWorktreeExpanded={(sessionId) => {
              setSessions(prev => prev.map(s =>
                s.id === sessionId ? { ...s, worktreesExpanded: !(s.worktreesExpanded ?? true) } : s
              ));
            }}
            activeBatchSessionIds={activeBatchSessionIds}
            showSessionJumpNumbers={showSessionJumpNumbers}
            visibleSessions={visibleSessions}
            autoRunStats={autoRunStats}
            openWizard={openWizardModal}
            startTour={() => {
              setTourFromWizard(false);
              setTourOpen(true);
            }}
            // Group Chat Props
            groupChats={groupChats}
            activeGroupChatId={activeGroupChatId}
            onOpenGroupChat={handleOpenGroupChat}
            onNewGroupChat={() => setShowNewGroupChatModal(true)}
            onEditGroupChat={(id) => setShowEditGroupChatModal(id)}
            onRenameGroupChat={(id) => setShowRenameGroupChatModal(id)}
            onDeleteGroupChat={(id) => setShowDeleteGroupChatModal(id)}
            groupChatsExpanded={groupChatsExpanded}
            onGroupChatsExpandedChange={setGroupChatsExpanded}
            groupChatState={groupChatState}
            participantStates={participantStates}
            groupChatStates={groupChatStates}
            allGroupChatParticipantStates={allGroupChatParticipantStates}
            sidebarContainerRef={sidebarContainerRef}
            // Duplicate agent handlers
            onNewAgentSession={addNewSession}
            setDuplicatingSessionId={setDuplicatingSessionId}
          />
        </ErrorBoundary>
      )}

      {/* --- SYSTEM LOG VIEWER (replaces center content when open) --- */}
      {logViewerOpen && (
        <div className="flex-1 flex flex-col min-w-0" style={{ backgroundColor: theme.colors.bgMain }}>
          <LogViewer
            theme={theme}
            onClose={handleCloseLogViewer}
            logLevel={logLevel}
            savedSelectedLevels={logViewerSelectedLevels}
            onSelectedLevelsChange={setLogViewerSelectedLevels}
            onShortcutUsed={handleLogViewerShortcutUsed}
          />
        </div>
      )}

      {/* --- GROUP CHAT VIEW (shown when a group chat is active, hidden when log viewer open) --- */}
      {!logViewerOpen && activeGroupChatId && groupChats.find(c => c.id === activeGroupChatId) && (
        <>
          <div className="flex-1 flex flex-col min-w-0">
            <GroupChatPanel
              theme={theme}
              groupChat={groupChats.find(c => c.id === activeGroupChatId)!}
              messages={groupChatMessages}
              state={groupChatState}
              totalCost={(() => {
                const chat = groupChats.find(c => c.id === activeGroupChatId);
                const participantsCost = (chat?.participants || []).reduce((sum, p) => sum + (p.totalCost || 0), 0);
                const modCost = moderatorUsage?.totalCost || 0;
                return participantsCost + modCost;
              })()}
              costIncomplete={(() => {
                const chat = groupChats.find(c => c.id === activeGroupChatId);
                const participants = chat?.participants || [];
                // Check if any participant is missing cost data
                const anyParticipantMissingCost = participants.some(p => p.totalCost === undefined || p.totalCost === null);
                // Moderator is also considered - if no usage stats yet, cost is incomplete
                const moderatorMissingCost = moderatorUsage?.totalCost === undefined || moderatorUsage?.totalCost === null;
                return anyParticipantMissingCost || moderatorMissingCost;
              })()}
              onSendMessage={handleSendGroupChatMessage}
              onClose={handleCloseGroupChat}
              onRename={() => setShowRenameGroupChatModal(activeGroupChatId)}
              onShowInfo={() => setShowGroupChatInfo(true)}
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
              executionQueue={groupChatExecutionQueue.filter(item => item.tabId === activeGroupChatId)}
              onRemoveQueuedItem={handleRemoveGroupChatQueueItem}
              onReorderQueuedItems={handleReorderGroupChatQueueItems}
              markdownEditMode={markdownEditMode}
              onToggleMarkdownEditMode={() => setMarkdownEditMode(!markdownEditMode)}
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
            participants={groupChats.find(c => c.id === activeGroupChatId)?.participants || []}
            participantStates={participantStates}
            participantSessionPaths={new Map(
              sessions
                .filter(s => groupChats.find(c => c.id === activeGroupChatId)?.participants.some(p => p.sessionId === s.id))
                .map(s => [s.id, s.projectRoot])
            )}
            sessionSshRemoteNames={sessionSshRemoteNames}
            isOpen={rightPanelOpen}
            onToggle={() => setRightPanelOpen(!rightPanelOpen)}
            width={rightPanelWidth}
            setWidthState={setRightPanelWidth}
            shortcuts={shortcuts}
            moderatorAgentId={groupChats.find(c => c.id === activeGroupChatId)?.moderatorAgentId || 'claude-code'}
            moderatorSessionId={groupChats.find(c => c.id === activeGroupChatId)?.moderatorSessionId || ''}
            moderatorAgentSessionId={groupChats.find(c => c.id === activeGroupChatId)?.moderatorAgentSessionId}
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
      <MainPanel
        ref={mainPanelRef}
        logViewerOpen={logViewerOpen}
        agentSessionsOpen={agentSessionsOpen}
        activeAgentSessionId={activeAgentSessionId}
        activeSession={activeSession}
        sessions={sessions}
        theme={theme}
        fontFamily={fontFamily}
        isMobileLandscape={isMobileLandscape}
        activeFocus={activeFocus}
        outputSearchOpen={outputSearchOpen}
        outputSearchQuery={outputSearchQuery}
        inputValue={inputValue}
        enterToSendAI={enterToSendAI}
        enterToSendTerminal={enterToSendTerminal}
        stagedImages={stagedImages}
        commandHistoryOpen={commandHistoryOpen}
        commandHistoryFilter={commandHistoryFilter}
        commandHistorySelectedIndex={commandHistorySelectedIndex}
        slashCommandOpen={slashCommandOpen}
        slashCommands={allSlashCommands}
        selectedSlashCommandIndex={selectedSlashCommandIndex}
        previewFile={previewFile}
        filePreviewLoading={filePreviewLoading}
        markdownEditMode={markdownEditMode}
        shortcuts={shortcuts}
        rightPanelOpen={rightPanelOpen}
        maxOutputLines={maxOutputLines}
        gitDiffPreview={gitDiffPreview}
        fileTreeFilterOpen={fileTreeFilterOpen}
        logLevel={logLevel}
        logViewerSelectedLevels={logViewerSelectedLevels}
        setLogViewerSelectedLevels={setLogViewerSelectedLevels}
        setGitDiffPreview={setGitDiffPreview}
        setLogViewerOpen={setLogViewerOpen}
        setAgentSessionsOpen={setAgentSessionsOpen}
        setActiveAgentSessionId={setActiveAgentSessionId}
        onResumeAgentSession={handleResumeSession}
        onNewAgentSession={handleNewAgentSession}
        setActiveFocus={setActiveFocus}
        setOutputSearchOpen={setOutputSearchOpen}
        setOutputSearchQuery={setOutputSearchQuery}
        setInputValue={setInputValue}
        setEnterToSendAI={setEnterToSendAI}
        setEnterToSendTerminal={setEnterToSendTerminal}
        setStagedImages={setStagedImages}
        setLightboxImage={handleSetLightboxImage}
        setCommandHistoryOpen={setCommandHistoryOpen}
        setCommandHistoryFilter={setCommandHistoryFilter}
        setCommandHistorySelectedIndex={setCommandHistorySelectedIndex}
        setSlashCommandOpen={setSlashCommandOpen}
        setSelectedSlashCommandIndex={setSelectedSlashCommandIndex}
        tabCompletionOpen={tabCompletionOpen}
        setTabCompletionOpen={setTabCompletionOpen}
        tabCompletionSuggestions={tabCompletionSuggestions}
        selectedTabCompletionIndex={selectedTabCompletionIndex}
        setSelectedTabCompletionIndex={setSelectedTabCompletionIndex}
        tabCompletionFilter={tabCompletionFilter}
        setTabCompletionFilter={setTabCompletionFilter}
        atMentionOpen={atMentionOpen}
        setAtMentionOpen={setAtMentionOpen}
        atMentionFilter={atMentionFilter}
        setAtMentionFilter={setAtMentionFilter}
        atMentionStartIndex={atMentionStartIndex}
        setAtMentionStartIndex={setAtMentionStartIndex}
        atMentionSuggestions={atMentionSuggestions}
        selectedAtMentionIndex={selectedAtMentionIndex}
        setSelectedAtMentionIndex={setSelectedAtMentionIndex}
        setPreviewFile={setPreviewFile}
        setMarkdownEditMode={setMarkdownEditMode}
        setAboutModalOpen={setAboutModalOpen}
        setRightPanelOpen={setRightPanelOpen}
        setGitLogOpen={setGitLogOpen}
        inputRef={inputRef}
        logsEndRef={logsEndRef}
        terminalOutputRef={terminalOutputRef}
        fileTreeContainerRef={fileTreeContainerRef}
        fileTreeFilterInputRef={fileTreeFilterInputRef}
        toggleInputMode={toggleInputMode}
        processInput={processInput}
        handleInterrupt={handleInterrupt}
        handleInputKeyDown={handleInputKeyDown}
        handlePaste={handlePaste}
        handleDrop={handleDrop}
        getContextColor={getContextColor}
        setActiveSessionId={setActiveSessionId}
        batchRunState={activeBatchRunState}
        currentSessionBatchState={currentSessionBatchState}
        onStopBatchRun={handleStopBatchRun}
        showConfirmation={showConfirmation}
        onDeleteLog={(logId: string): number | null => {
          if (!activeSession) return null;

          const isAIMode = activeSession.inputMode === 'ai';

          // For AI mode, use the active tab's logs; for terminal mode, use shellLogs
          const activeTab = isAIMode ? getActiveTab(activeSession) : null;
          const logs = isAIMode ? (activeTab?.logs || []) : activeSession.shellLogs;

          // Find the log entry and its index
          const logIndex = logs.findIndex(log => log.id === logId);
          if (logIndex === -1) return null;

          const log = logs[logIndex];
          if (log.source !== 'user') return null; // Only delete user commands/messages

          // Find the next user command index (or end of array)
          let endIndex = logs.length;
          for (let i = logIndex + 1; i < logs.length; i++) {
            if (logs[i].source === 'user') {
              endIndex = i;
              break;
            }
          }

          // Remove logs from logIndex to endIndex (exclusive)
          const newLogs = [
            ...logs.slice(0, logIndex),
            ...logs.slice(endIndex)
          ];

          // Find the index of the next user command in the NEW array
          // This is the command that was at endIndex, now at logIndex position
          let nextUserCommandIndex: number | null = null;
          for (let i = logIndex; i < newLogs.length; i++) {
            if (newLogs[i].source === 'user') {
              nextUserCommandIndex = i;
              break;
            }
          }
          // If no next command, try to find the previous user command
          if (nextUserCommandIndex === null) {
            for (let i = logIndex - 1; i >= 0; i--) {
              if (newLogs[i].source === 'user') {
                nextUserCommandIndex = i;
                break;
              }
            }
          }

          if (isAIMode && activeTab) {
            // For AI mode, also delete from the Claude session JSONL file
            // This ensures the context is actually removed for future interactions
            // Use the active tab's agentSessionId, not the deprecated session-level one
            const agentSessionId = activeTab.agentSessionId;
            if (agentSessionId && activeSession.cwd) {
              // Delete asynchronously - don't block the UI update
              window.maestro.claude.deleteMessagePair(
                activeSession.cwd,
                agentSessionId,
                logId, // This is the UUID if loaded from Claude session
                log.text // Fallback: match by content if UUID doesn't match
              ).then(result => {
                if (!result.success) {
                  console.warn('[onDeleteLog] Failed to delete from Claude session:', result.error);
                }
              }).catch(err => {
                console.error('[onDeleteLog] Error deleting from Claude session:', err);
              });
            }

            // Update the active tab's logs and aiCommandHistory
            const commandText = log.text.trim();
            const newAICommandHistory = (activeSession.aiCommandHistory || []).filter(
              cmd => cmd !== commandText
            );

            setSessions(sessions.map(s => {
              if (s.id !== activeSession.id) return s;
              return {
                ...s,
                aiCommandHistory: newAICommandHistory,
                aiTabs: s.aiTabs.map(tab =>
                  tab.id === activeTab.id
                    ? { ...tab, logs: newLogs }
                    : tab
                )
              };
            }));
          } else {
            // Terminal mode - update shellLogs and shellCommandHistory
            const commandText = log.text.trim();
            const newShellCommandHistory = (activeSession.shellCommandHistory || []).filter(
              cmd => cmd !== commandText
            );

            setSessions(sessions.map(s =>
              s.id === activeSession.id
                ? { ...s, shellLogs: newLogs, shellCommandHistory: newShellCommandHistory }
                : s
            ));
          }

          return nextUserCommandIndex;
        }}
        onRemoveQueuedItem={handleRemoveQueuedItem}
        onOpenQueueBrowser={handleOpenQueueBrowser}
        audioFeedbackCommand={audioFeedbackCommand}
        // Tab management handlers (memoized for performance)
        onTabSelect={handleTabSelect}
        onTabClose={handleTabClose}
        onNewTab={handleNewTab}
        onRequestTabRename={(tabId: string) => {
          if (!activeSession) return;
          const tab = activeSession.aiTabs?.find(t => t.id === tabId);
          if (tab) {
            setRenameTabId(tabId);
            setRenameTabInitialName(getInitialRenameValue(tab));
            setRenameTabModalOpen(true);
          }
        }}
        onTabReorder={(fromIndex: number, toIndex: number) => {
          if (!activeSession) return;
          // Use functional setState to compute from fresh state (avoids stale closure issues)
          setSessions(prev => prev.map(s => {
            if (s.id !== activeSession.id || !s.aiTabs) return s;
            const tabs = [...s.aiTabs];
            const [movedTab] = tabs.splice(fromIndex, 1);
            tabs.splice(toIndex, 0, movedTab);
            return { ...s, aiTabs: tabs };
          }));
        }}
        onUpdateTabByClaudeSessionId={(agentSessionId: string, updates: { name?: string | null; starred?: boolean }) => {
          // Update the AITab that matches this Claude session ID
          // This is called when a session is renamed or starred in the AgentSessionsBrowser
          if (!activeSession) return;
          setSessions(prev => prev.map(s => {
            if (s.id !== activeSession.id) return s;
            const tabIndex = s.aiTabs.findIndex(tab => tab.agentSessionId === agentSessionId);
            if (tabIndex === -1) return s; // Session not open as a tab
            return {
              ...s,
              aiTabs: s.aiTabs.map(tab =>
                tab.agentSessionId === agentSessionId
                  ? {
                      ...tab,
                      ...(updates.name !== undefined ? { name: updates.name } : {}),
                      ...(updates.starred !== undefined ? { starred: updates.starred } : {})
                    }
                  : tab
              )
            };
          }));
        }}
        onTabStar={(tabId: string, starred: boolean) => {
          if (!activeSession) return;
          // Find the tab first to check if it has a session ID
          const tabToStar = activeSession.aiTabs.find(t => t.id === tabId);
          // Don't allow starring tabs without a session ID (new/empty tabs)
          if (!tabToStar?.agentSessionId) return;
          setSessions(prev => prev.map(s => {
            if (s.id !== activeSession.id) return s;
            // Find the tab to get its agentSessionId for persistence
            const tab = s.aiTabs.find(t => t.id === tabId);
            if (tab?.agentSessionId) {
              // Persist starred status to session metadata (async, fire and forget)
              // Use projectRoot (not cwd) since session storage is keyed by initial project path
              const agentId = s.toolType || 'claude-code';
              if (agentId === 'claude-code') {
                window.maestro.claude.updateSessionStarred(
                  s.projectRoot,
                  tab.agentSessionId,
                  starred
                ).catch(err => console.error('Failed to persist tab starred:', err));
              } else {
                window.maestro.agentSessions.setSessionStarred(
                  agentId,
                  s.projectRoot,
                  tab.agentSessionId,
                  starred
                ).catch(err => console.error('Failed to persist tab starred:', err));
              }
            }
            return {
              ...s,
              aiTabs: s.aiTabs.map(t =>
                t.id === tabId ? { ...t, starred } : t
              )
            };
          }));
        }}
        onTabMarkUnread={(tabId: string) => {
          if (!activeSession) return;
          setSessions(prev => prev.map(s => {
            if (s.id !== activeSession.id) return s;
            return {
              ...s,
              aiTabs: s.aiTabs.map(t =>
                t.id === tabId ? { ...t, hasUnread: true } : t
              )
            };
          }));
        }}
        onToggleTabReadOnlyMode={() => {
          if (!activeSession) return;
          const activeTab = getActiveTab(activeSession);
          if (!activeTab) return;
          setSessions(prev => prev.map(s => {
            if (s.id !== activeSession.id) return s;
            return {
              ...s,
              aiTabs: s.aiTabs.map(tab =>
                tab.id === activeTab.id ? { ...tab, readOnlyMode: !tab.readOnlyMode } : tab
              )
            };
          }));
        }}
        showUnreadOnly={showUnreadOnly}
        onToggleUnreadFilter={toggleUnreadFilter}
        onOpenTabSearch={() => setTabSwitcherOpen(true)}
        onToggleTabSaveToHistory={() => {
          if (!activeSession) return;
          const activeTab = getActiveTab(activeSession);
          if (!activeTab) return;
          setSessions(prev => prev.map(s => {
            if (s.id !== activeSession.id) return s;
            return {
              ...s,
              aiTabs: s.aiTabs.map(tab =>
                tab.id === activeTab.id ? { ...tab, saveToHistory: !tab.saveToHistory } : tab
              )
            };
          }));
        }}
        onToggleTabShowThinking={() => {
          if (!activeSession) return;
          const activeTab = getActiveTab(activeSession);
          if (!activeTab) return;
          setSessions(prev => prev.map(s => {
            if (s.id !== activeSession.id) return s;
            return {
              ...s,
              aiTabs: s.aiTabs.map(tab => {
                if (tab.id !== activeTab.id) return tab;
                // When turning OFF, clear any thinking/tool logs
                if (tab.showThinking) {
                  return {
                    ...tab,
                    showThinking: false,
                    logs: tab.logs.filter(l => l.source !== 'thinking' && l.source !== 'tool')
                  };
                }
                return { ...tab, showThinking: true };
              })
            };
          }));
        }}
        onScrollPositionChange={(scrollTop: number) => {
          if (!activeSession) return;
          // Save scroll position for the current view (AI tab or terminal)
          if (activeSession.inputMode === 'ai') {
            // Save to active AI tab's scrollTop
            const activeTab = getActiveTab(activeSession);
            if (!activeTab) return;
            setSessions(prev => prev.map(s => {
              if (s.id !== activeSession.id) return s;
              return {
                ...s,
                aiTabs: s.aiTabs.map(tab =>
                  tab.id === activeTab.id ? { ...tab, scrollTop } : tab
                )
              };
            }));
          } else {
            // Save to session's terminalScrollTop
            setSessions(prev => prev.map(s =>
              s.id === activeSession.id ? { ...s, terminalScrollTop: scrollTop } : s
            ));
          }
        }}
        onAtBottomChange={(isAtBottom: boolean) => {
          if (!activeSession) return;
          // Save isAtBottom state for the current view (AI tab only - terminal auto-scrolls)
          if (activeSession.inputMode === 'ai') {
            const activeTab = getActiveTab(activeSession);
            if (!activeTab) return;
            setSessions(prev => prev.map(s => {
              if (s.id !== activeSession.id) return s;
              return {
                ...s,
                aiTabs: s.aiTabs.map(tab =>
                  tab.id === activeTab.id
                    ? {
                        ...tab,
                        isAtBottom,
                        // Clear hasUnread when user scrolls to bottom
                        hasUnread: isAtBottom ? false : tab.hasUnread
                      }
                    : tab
                )
              };
            }));
          }
        }}
        onInputBlur={() => {
          // Persist input to session state on blur
          if (isAiMode) {
            syncAiInputToSession(aiInputValueLocal);
          } else {
            syncTerminalInputToSession(terminalInputValue);
          }
        }}
        onOpenPromptComposer={() => setPromptComposerOpen(true)}
        onReplayMessage={(text: string, images?: string[]) => {
          // Set staged images if the message had any
          if (images && images.length > 0) {
            setStagedImages(images);
          }
          // Use setTimeout to ensure state updates are applied before processing
          setTimeout(() => processInput(text), 0);
        }}
        fileTree={activeSession?.fileTree}
        onFileClick={async (relativePath: string) => {
          if (!activeSession) return;
          const filename = relativePath.split('/').pop() || relativePath;

          // Check if file should be opened externally (PDF, etc.)
          if (shouldOpenExternally(filename)) {
            const fullPath = `${activeSession.fullPath}/${relativePath}`;
            window.maestro.shell.openExternal(`file://${fullPath}`);
            return;
          }

          try {
            const fullPath = `${activeSession.fullPath}/${relativePath}`;
            const content = await window.maestro.fs.readFile(fullPath, activeSession.sshRemoteId);
            const newFile = {
              name: filename,
              content,
              path: fullPath
            };

            // Only add to history if it's a different file than the current one
            const currentFile = filePreviewHistory[filePreviewHistoryIndex];
            if (!currentFile || currentFile.path !== fullPath) {
              // Add to navigation history (truncate forward history if we're not at the end)
              const newHistory = filePreviewHistory.slice(0, filePreviewHistoryIndex + 1);
              newHistory.push(newFile);
              setFilePreviewHistory(newHistory);
              setFilePreviewHistoryIndex(newHistory.length - 1);
            }

            setPreviewFile(newFile);
            setActiveFocus('main');
          } catch (error) {
            console.error('[onFileClick] Failed to read file:', error);
          }
        }}
        canGoBack={filePreviewHistoryIndex > 0}
        canGoForward={filePreviewHistoryIndex < filePreviewHistory.length - 1}
        onNavigateBack={() => {
          if (filePreviewHistoryIndex > 0) {
            const newIndex = filePreviewHistoryIndex - 1;
            setFilePreviewHistoryIndex(newIndex);
            setPreviewFile(filePreviewHistory[newIndex]);
          }
        }}
        onNavigateForward={() => {
          if (filePreviewHistoryIndex < filePreviewHistory.length - 1) {
            const newIndex = filePreviewHistoryIndex + 1;
            setFilePreviewHistoryIndex(newIndex);
            setPreviewFile(filePreviewHistory[newIndex]);
          }
        }}
        backHistory={filePreviewHistory.slice(0, filePreviewHistoryIndex)}
        forwardHistory={filePreviewHistory.slice(filePreviewHistoryIndex + 1)}
        currentHistoryIndex={filePreviewHistoryIndex}
        onNavigateToIndex={(index: number) => {
          if (index >= 0 && index < filePreviewHistory.length) {
            setFilePreviewHistoryIndex(index);
            setPreviewFile(filePreviewHistory[index]);
          }
        }}
        onClearAgentError={activeTabForError?.agentError && activeSession ? () => handleClearAgentError(activeSession.id, activeTabForError.id) : undefined}
        onShowAgentErrorModal={activeTabForError?.agentError && activeSession ? () => setAgentErrorModalSessionId(activeSession.id) : undefined}
        showFlashNotification={(message: string) => {
          setSuccessFlashNotification(message);
          setTimeout(() => setSuccessFlashNotification(null), 2000);
        }}
        onOpenFuzzySearch={() => setFuzzyFileSearchOpen(true)}
        onOpenWorktreeConfig={() => setWorktreeConfigModalOpen(true)}
        onOpenCreatePR={() => setCreatePRModalOpen(true)}
        isWorktreeChild={!!activeSession?.parentSessionId}
        onSummarizeAndContinue={handleSummarizeAndContinue}
        onMergeWith={(tabId: string) => {
          // First select the tab to make it active, then open merge modal
          if (activeSession) {
            setSessions(prev => prev.map(s =>
              s.id === activeSession.id ? { ...s, activeTabId: tabId } : s
            ));
          }
          setMergeSessionModalOpen(true);
        }}
        onSendToAgent={(tabId: string) => {
          // First select the tab to make it active, then open send modal
          if (activeSession) {
            setSessions(prev => prev.map(s =>
              s.id === activeSession.id ? { ...s, activeTabId: tabId } : s
            ));
          }
          setSendToAgentModalOpen(true);
        }}
        onCopyContext={(tabId: string) => {
          // Copy tab conversation context to clipboard
          if (!activeSession) return;
          const tab = activeSession.aiTabs.find(t => t.id === tabId);
          if (!tab || !tab.logs || tab.logs.length === 0) return;

          const text = formatLogsForClipboard(tab.logs);
          navigator.clipboard.writeText(text).then(() => {
            addToast({
              type: 'success',
              title: 'Context Copied',
              message: 'Conversation copied to clipboard.',
            });
          }).catch((err) => {
            console.error('Failed to copy context:', err);
            addToast({
              type: 'error',
              title: 'Copy Failed',
              message: 'Failed to copy context to clipboard.',
            });
          });
        }}
        onExportHtml={async (tabId: string) => {
          // Export tab conversation as HTML
          if (!activeSession) return;
          const tab = activeSession.aiTabs.find(t => t.id === tabId);
          if (!tab || !tab.logs || tab.logs.length === 0) return;

          try {
            const { downloadTabExport } = await import('./utils/tabExport');
            await downloadTabExport(
              tab,
              { name: activeSession.name, cwd: activeSession.cwd, toolType: activeSession.toolType },
              theme
            );
            addToast({
              type: 'success',
              title: 'Export Complete',
              message: 'Conversation exported as HTML.',
            });
          } catch (err) {
            console.error('Failed to export tab:', err);
            addToast({
              type: 'error',
              title: 'Export Failed',
              message: 'Failed to export conversation as HTML.',
            });
          }
        }}
        // Context warning sash settings (Phase 6)
        contextWarningsEnabled={contextManagementSettings.contextWarningsEnabled}
        contextWarningYellowThreshold={contextManagementSettings.contextWarningYellowThreshold}
        contextWarningRedThreshold={contextManagementSettings.contextWarningRedThreshold}
        // Summarization progress props (non-blocking, per-tab)
        summarizeProgress={summarizeProgress}
        summarizeResult={summarizeResult}
        summarizeStartTime={startTime}
        isSummarizing={summarizeState === 'summarizing'}
        onCancelSummarize={() => {
          if (activeSession?.activeTabId) {
            cancelTab(activeSession.activeTabId);
          }
        }}
        // Merge progress props (non-blocking, per-tab)
        mergeProgress={mergeProgress}
        mergeResult={null}
        mergeStartTime={mergeStartTime}
        isMerging={mergeState === 'merging'}
        mergeSourceName={mergeSourceName}
        mergeTargetName={mergeTargetName}
        onCancelMerge={() => {
          if (activeSession?.activeTabId) {
            cancelMergeTab(activeSession.activeTabId);
          }
        }}
        onShortcutUsed={(shortcutId: string) => {
          const result = recordShortcutUsage(shortcutId);
          if (result.newLevel !== null) {
            onKeyboardMasteryLevelUp(result.newLevel);
          }
        }}
        ghCliAvailable={ghCliAvailable}
        onPublishGist={() => setGistPublishModalOpen(true)}
        onOpenInGraph={() => {
          if (previewFile && activeSession?.fullPath) {
            // Compute relative path from the preview file
            const relativePath = previewFile.path.startsWith(activeSession.fullPath)
              ? previewFile.path.slice(activeSession.fullPath.length + 1)
              : previewFile.name;
            setGraphFocusFilePath(relativePath);
            setLastGraphFocusFilePath(relativePath); // Track for "Last Document Graph" in command palette
            setIsGraphViewOpen(true);
          }
        }}
      />
      )}

      {/* --- RIGHT PANEL (hidden in mobile landscape, when no sessions, group chat is active, or log viewer is open) --- */}
      {!isMobileLandscape && sessions.length > 0 && !activeGroupChatId && !logViewerOpen && (
        <ErrorBoundary>
          <RightPanel
            ref={rightPanelRef}
            session={activeSession}
            theme={theme}
            shortcuts={shortcuts}
            rightPanelOpen={rightPanelOpen}
            setRightPanelOpen={setRightPanelOpen}
            rightPanelWidth={rightPanelWidth}
            setRightPanelWidthState={setRightPanelWidth}
            activeRightTab={activeRightTab}
            setActiveRightTab={handleSetActiveRightTab}
            activeFocus={activeFocus}
            setActiveFocus={setActiveFocus}
            fileTreeFilter={fileTreeFilter}
            setFileTreeFilter={setFileTreeFilter}
            fileTreeFilterOpen={fileTreeFilterOpen}
            setFileTreeFilterOpen={setFileTreeFilterOpen}
            filteredFileTree={filteredFileTree}
            selectedFileIndex={selectedFileIndex}
            setSelectedFileIndex={setSelectedFileIndex}
            previewFile={previewFile}
            fileTreeContainerRef={fileTreeContainerRef}
            fileTreeFilterInputRef={fileTreeFilterInputRef}
            toggleFolder={toggleFolder}
            handleFileClick={handleFileClick}
            expandAllFolders={expandAllFolders}
            collapseAllFolders={collapseAllFolders}
            updateSessionWorkingDirectory={updateSessionWorkingDirectory}
            refreshFileTree={refreshFileTree}
            setSessions={setSessions}
            onAutoRefreshChange={handleAutoRefreshChange}
            onShowFlash={showSuccessFlash}
            showHiddenFiles={showHiddenFiles}
            setShowHiddenFiles={setShowHiddenFiles}
            autoRunDocumentList={autoRunDocumentList}
            autoRunDocumentTree={autoRunDocumentTree}
            autoRunContent={activeSession?.autoRunContent || ''}
            autoRunContentVersion={activeSession?.autoRunContentVersion || 0}
            autoRunIsLoadingDocuments={autoRunIsLoadingDocuments}
            autoRunDocumentTaskCounts={autoRunDocumentTaskCounts}
            onAutoRunContentChange={handleAutoRunContentChange}
            onAutoRunModeChange={handleAutoRunModeChange}
            onAutoRunStateChange={handleAutoRunStateChange}
            onAutoRunSelectDocument={handleAutoRunSelectDocument}
            onAutoRunCreateDocument={handleAutoRunCreateDocument}
            onAutoRunRefresh={handleAutoRunRefresh}
            onAutoRunOpenSetup={handleAutoRunOpenSetup}
            batchRunState={activeBatchRunState}
            currentSessionBatchState={currentSessionBatchState}
            onOpenBatchRunner={handleOpenBatchRunner}
            onStopBatchRun={handleStopBatchRun}
            onSkipCurrentDocument={handleSkipCurrentDocument}
            onAbortBatchOnError={handleAbortBatchOnError}
            onResumeAfterError={handleResumeAfterError}
            onJumpToAgentSession={handleJumpToAgentSession}
            onResumeSession={handleResumeSession}
            onOpenSessionAsTab={handleResumeSession}
            onOpenAboutModal={() => setAboutModalOpen(true)}
            onOpenMarketplace={handleOpenMarketplace}
            onFileClick={async (relativePath: string) => {
              if (!activeSession) return;
              const filename = relativePath.split('/').pop() || relativePath;

              // Check if file should be opened externally (PDF, etc.)
              if (shouldOpenExternally(filename)) {
                const fullPath = `${activeSession.fullPath}/${relativePath}`;
                window.maestro.shell.openExternal(`file://${fullPath}`);
                return;
              }

              try {
                const fullPath = `${activeSession.fullPath}/${relativePath}`;
                const content = await window.maestro.fs.readFile(fullPath, activeSession.sshRemoteId);
                const newFile = {
                  name: filename,
                  content,
                  path: fullPath
                };

                // Only add to history if it's a different file than the current one
                const currentFile = filePreviewHistory[filePreviewHistoryIndex];
                if (!currentFile || currentFile.path !== fullPath) {
                  // Add to navigation history (truncate forward history if we're not at the end)
                  const newHistory = filePreviewHistory.slice(0, filePreviewHistoryIndex + 1);
                  newHistory.push(newFile);
                  setFilePreviewHistory(newHistory);
                  setFilePreviewHistoryIndex(newHistory.length - 1);
                }

                setPreviewFile(newFile);
                setActiveFocus('main');
              } catch (error) {
                console.error('[onFileClick] Failed to read file:', error);
              }
            }}
            onFocusFileInGraph={(relativePath: string) => {
              setGraphFocusFilePath(relativePath);
              setLastGraphFocusFilePath(relativePath); // Track for "Last Document Graph" in command palette
              setIsGraphViewOpen(true);
            }}
            lastGraphFocusFile={lastGraphFocusFilePath}
            onOpenLastDocumentGraph={() => {
              if (lastGraphFocusFilePath) {
                setGraphFocusFilePath(lastGraphFocusFilePath);
                setIsGraphViewOpen(true);
              }
            }}
          />
        </ErrorBoundary>
      )}

      {/* Old settings modal removed - using new SettingsModal component below */}
      {/* NOTE: NewInstanceModal and EditAgentModal are now rendered via AppSessionModals */}

      {/* --- SETTINGS MODAL (New Component) --- */}
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
        initialTab={settingsTab}
        hasNoAgents={hasNoAgents}
        onThemeImportError={(msg) => setFlashNotification(msg)}
        onThemeImportSuccess={(msg) => setFlashNotification(msg)}
      />

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
                directoryError: 'The previously selected directory no longer exists. Please choose a new location.',
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
          shortcuts={shortcuts}
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
            textShadow: '0 1px 2px rgba(255, 255, 255, 0.3)'
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
            textShadow: '0 1px 2px rgba(0, 0, 0, 0.3)'
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
 * Phase 4: GroupChatProvider - centralized group chat state management
 * Phase 5: AutoRunProvider - centralized Auto Run and batch processing state management
 * Phase 6: SessionProvider - centralized session and group state management
 * See refactor-details-2.md for full plan.
 */
export default function MaestroConsole() {
  return (
    <SessionProvider>
      <AutoRunProvider>
        <GroupChatProvider>
          <InputProvider>
            <MaestroConsoleInner />
          </InputProvider>
        </GroupChatProvider>
      </AutoRunProvider>
    </SessionProvider>
  );
}
