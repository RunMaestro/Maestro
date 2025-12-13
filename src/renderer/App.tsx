import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { NewInstanceModal } from './components/NewInstanceModal';
import { SettingsModal } from './components/SettingsModal';
import { SessionList } from './components/SessionList';
import { RightPanel, RightPanelHandle } from './components/RightPanel';
import { QuickActionsModal } from './components/QuickActionsModal';
import { LightboxModal } from './components/LightboxModal';
import { ShortcutsHelpModal } from './components/ShortcutsHelpModal';
import { slashCommands } from './slashCommands';
import { AboutModal } from './components/AboutModal';
import { UpdateCheckModal } from './components/UpdateCheckModal';
import { CreateGroupModal } from './components/CreateGroupModal';
import { RenameSessionModal } from './components/RenameSessionModal';
import { RenameTabModal } from './components/RenameTabModal';
import { RenameGroupModal } from './components/RenameGroupModal';
import { ConfirmModal } from './components/ConfirmModal';
import { ErrorBoundary } from './components/ErrorBoundary';
import { MainPanel } from './components/MainPanel';
import { ProcessMonitor } from './components/ProcessMonitor';
import { GitDiffViewer } from './components/GitDiffViewer';
import { GitLogViewer } from './components/GitLogViewer';
import { BatchRunnerModal, DEFAULT_BATCH_PROMPT } from './components/BatchRunnerModal';
import { TabSwitcherModal } from './components/TabSwitcherModal';
import { PromptComposerModal } from './components/PromptComposerModal';
import { ExecutionQueueBrowser } from './components/ExecutionQueueBrowser';
import { StandingOvationOverlay } from './components/StandingOvationOverlay';
import { FirstRunCelebration } from './components/FirstRunCelebration';
import { LeaderboardRegistrationModal } from './components/LeaderboardRegistrationModal';
import { PlaygroundPanel } from './components/PlaygroundPanel';
import { AutoRunSetupModal } from './components/AutoRunSetupModal';
import { DebugWizardModal } from './components/DebugWizardModal';
import { MaestroWizard, useWizard, WizardResumeModal, SerializableWizardState, AUTO_RUN_FOLDER_NAME } from './components/Wizard';
import { TourOverlay } from './components/Wizard/tour';
import { CONDUCTOR_BADGES } from './constants/conductorBadges';
import { EmptyStateView } from './components/EmptyStateView';

// Import custom hooks
import { useBatchProcessor } from './hooks/useBatchProcessor';
import { useSettings, useActivityTracker, useMobileLandscape, useNavigationHistory, useAutoRunHandlers, useInputSync, useSessionNavigation } from './hooks';
import type { AutoRunTreeNode } from './hooks';
import { useTabCompletion, TabCompletionSuggestion, TabCompletionFilter } from './hooks/useTabCompletion';
import { useAtMentionCompletion } from './hooks/useAtMentionCompletion';

// Import contexts
import { useLayerStack } from './contexts/LayerStackContext';
import { useToast } from './contexts/ToastContext';
import { ToastContainer } from './components/Toast';

// Import services
import { gitService } from './services/git';

// Import types and constants
import type {
  ToolType, SessionState, RightPanelTab,
  FocusArea, LogEntry, Session, Group, AITab, UsageStats, QueuedItem, BatchRunConfig
} from './types';
import { THEMES } from './constants/themes';
import { generateId } from './utils/ids';
import { getContextColor } from './utils/theme';
import { fuzzyMatch } from './utils/search';
import { setActiveTab, createTab, closeTab, reopenClosedTab, getActiveTab, getWriteModeTab, navigateToNextTab, navigateToPrevTab, navigateToTabByIndex, navigateToLastTab } from './utils/tabHelpers';
import { TAB_SHORTCUTS } from './constants/shortcuts';
import { shouldOpenExternally, loadFileTree, getAllFolderPaths, flattenTree, compareFileTrees, FileTreeChanges } from './utils/fileExplorer';
import { substituteTemplateVariables } from './utils/templateVariables';
import { validateNewSession } from './utils/sessionValidation';

// Strip leading emojis from a string for alphabetical sorting
// Matches common emoji patterns at the start of the string
const stripLeadingEmojis = (str: string): string => {
  // Match emojis at the start: emoji characters, variation selectors, ZWJ sequences, etc.
  const emojiRegex = /^(?:\p{Emoji_Presentation}|\p{Emoji}\uFE0F?|\p{Emoji_Modifier_Base}\p{Emoji_Modifier}?)+\s*/gu;
  return str.replace(emojiRegex, '').trim();
};

// Compare two names, ignoring leading emojis for alphabetization
const compareNamesIgnoringEmojis = (a: string, b: string): number => {
  const aStripped = stripLeadingEmojis(a);
  const bStripped = stripLeadingEmojis(b);
  return aStripped.localeCompare(bStripped);
};

// Get description for Claude Code slash commands
// Built-in commands have known descriptions, custom ones use a generic description
const CLAUDE_BUILTIN_COMMANDS: Record<string, string> = {
  'compact': 'Summarize conversation to reduce context usage',
  'context': 'Show current context window usage',
  'cost': 'Show session cost and token usage',
  'init': 'Initialize CLAUDE.md with codebase info',
  'pr-comments': 'Address PR review comments',
  'release-notes': 'Generate release notes from changes',
  'todos': 'Find and list TODO comments in codebase',
  'review': 'Review code changes',
  'security-review': 'Review code for security issues',
  'plan': 'Create an implementation plan',
};

const getSlashCommandDescription = (cmd: string): string => {
  // Remove leading slash if present
  const cmdName = cmd.startsWith('/') ? cmd.slice(1) : cmd;

  // Check for built-in command
  if (CLAUDE_BUILTIN_COMMANDS[cmdName]) {
    return CLAUDE_BUILTIN_COMMANDS[cmdName];
  }

  // For plugin commands (e.g., "plugin-name:command"), use the full name as description hint
  if (cmdName.includes(':')) {
    const [plugin, command] = cmdName.split(':');
    return `${command} (${plugin})`;
  }

  // Generic description for unknown commands
  return 'Claude Code command';
};

// Default prompt to use when user sends only an image without text
// This instructs the AI to analyze the image and infer the user's intent from context
const DEFAULT_IMAGE_ONLY_PROMPT = 'Examine the attached picture and best determine based on available and existing context, what the user wants done next.';

export default function MaestroConsole() {
  // --- LAYER STACK (for blocking shortcuts when modals are open) ---
  const { hasOpenLayers, hasOpenModal } = useLayerStack();

  // --- TOAST NOTIFICATIONS ---
  const { addToast, setDefaultDuration: setToastDefaultDuration, setAudioFeedback, setOsNotifications } = useToast();

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
    loadResumeState,
    clearResumeState,
    completeWizard,
    closeWizard: closeWizardModal,
    goToStep: wizardGoToStep,
  } = useWizard();

  // --- SETTINGS (from useSettings hook) ---
  const settings = useSettings();
  const {
    settingsLoaded,
    llmProvider, setLlmProvider,
    modelSlug, setModelSlug,
    apiKey, setApiKey,
    defaultAgent, setDefaultAgent,
    defaultShell, setDefaultShell,
    ghPath, setGhPath,
    fontFamily, setFontFamily,
    fontSize, setFontSize,
    activeThemeId, setActiveThemeId,
    enterToSendAI, setEnterToSendAI,
    enterToSendTerminal, setEnterToSendTerminal,
    defaultSaveToHistory, setDefaultSaveToHistory,
    leftSidebarWidth, setLeftSidebarWidth,
    rightPanelWidth, setRightPanelWidth,
    markdownEditMode, setMarkdownEditMode,
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
    shortcuts, setShortcuts,
    customAICommands, setCustomAICommands,
    globalStats, updateGlobalStats,
    autoRunStats, recordAutoRunComplete, updateAutoRunProgress, acknowledgeBadge, getUnacknowledgedBadgeLevel,
    tourCompleted, setTourCompleted,
    firstAutoRunCompleted, setFirstAutoRunCompleted,
    recordWizardStart, recordWizardComplete, recordWizardAbandon, recordWizardResume,
    recordTourStart, recordTourComplete, recordTourSkip,
    leaderboardRegistration, setLeaderboardRegistration, isLeaderboardRegistered,
  } = settings;

  // --- STATE ---
  const [sessions, setSessions] = useState<Session[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);

  // Track if initial data has been loaded to prevent overwriting on mount
  const initialLoadComplete = useRef(false);

  // Track if sessions/groups have been loaded (for splash screen coordination)
  const [sessionsLoaded, setSessionsLoaded] = useState(false);

  const [activeSessionId, setActiveSessionIdInternal] = useState<string>(sessions[0]?.id || 's1');

  // Track current position in visual order for cycling (allows same session to appear twice)
  const cyclePositionRef = useRef<number>(-1);

  // Wrapper that resets cycle position when session is changed via click (not cycling)
  const setActiveSessionId = useCallback((id: string) => {
    cyclePositionRef.current = -1; // Reset so next cycle finds first occurrence
    setActiveSessionIdInternal(id);
  }, []);

  // Input State - both modes use local state for responsive typing
  // AI mode syncs to tab state on blur/submit for persistence
  const [terminalInputValue, setTerminalInputValue] = useState('');
  const [aiInputValueLocal, setAiInputValueLocal] = useState('');
  const [slashCommandOpen, setSlashCommandOpen] = useState(false);
  const [selectedSlashCommandIndex, setSelectedSlashCommandIndex] = useState(0);

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
  const [selectedFileIndex, setSelectedFileIndex] = useState(0);
  const [flatFileList, setFlatFileList] = useState<any[]>([]);
  const [fileTreeFilter, setFileTreeFilter] = useState('');
  const [fileTreeFilterOpen, setFileTreeFilterOpen] = useState(false);

  // Git Diff State
  const [gitDiffPreview, setGitDiffPreview] = useState<string | null>(null);

  // Stable callbacks for memoized modals (prevents re-renders from callback reference changes)
  const handleCloseGitDiff = useCallback(() => setGitDiffPreview(null), []);
  const handleCloseGitLog = useCallback(() => setGitLogOpen(false), []);
  const handleCloseSettings = useCallback(() => setSettingsModalOpen(false), []);

  // Tour Overlay State
  const [tourOpen, setTourOpen] = useState(false);
  const [tourFromWizard, setTourFromWizard] = useState(false);

  // Git Log Viewer State
  const [gitLogOpen, setGitLogOpen] = useState(false);

  // Renaming State
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);

  // Drag and Drop State
  const [draggingSessionId, setDraggingSessionId] = useState<string | null>(null);

  // Modals
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [newInstanceModalOpen, setNewInstanceModalOpen] = useState(false);
  const [shortcutsHelpOpen, setShortcutsHelpOpen] = useState(false);
  const [shortcutsSearchQuery, setShortcutsSearchQuery] = useState('');
  const [quickActionOpen, setQuickActionOpen] = useState(false);
  const [quickActionInitialMode, setQuickActionInitialMode] = useState<'main' | 'move-to-group'>('main');
  const [settingsTab, setSettingsTab] = useState<'general' | 'shortcuts' | 'theme' | 'notifications' | 'aicommands'>('general');
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);
  const [lightboxImages, setLightboxImages] = useState<string[]>([]); // Context images for navigation
  const [aboutModalOpen, setAboutModalOpen] = useState(false);
  const [updateCheckModalOpen, setUpdateCheckModalOpen] = useState(false);
  const [leaderboardRegistrationOpen, setLeaderboardRegistrationOpen] = useState(false);
  const [standingOvationData, setStandingOvationData] = useState<{
    badge: typeof CONDUCTOR_BADGES[number];
    isNewRecord: boolean;
    recordTimeMs?: number;
  } | null>(null);
  const [firstRunCelebrationData, setFirstRunCelebrationData] = useState<{
    elapsedTimeMs: number;
    completedTasks: number;
    totalTasks: number;
  } | null>(null);
  const [logViewerOpen, setLogViewerOpen] = useState(false);
  const [processMonitorOpen, setProcessMonitorOpen] = useState(false);
  const [playgroundOpen, setPlaygroundOpen] = useState(false);
  const [debugWizardModalOpen, setDebugWizardModalOpen] = useState(false);
  const [createGroupModalOpen, setCreateGroupModalOpen] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupEmoji, setNewGroupEmoji] = useState('📂');
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [moveSessionToNewGroup, setMoveSessionToNewGroup] = useState(false);

  // Confirmation Modal State
  const [confirmModalOpen, setConfirmModalOpen] = useState(false);
  const [confirmModalMessage, setConfirmModalMessage] = useState('');
  const [confirmModalOnConfirm, setConfirmModalOnConfirm] = useState<(() => void) | null>(null);

  // Rename Instance Modal State
  const [renameInstanceModalOpen, setRenameInstanceModalOpen] = useState(false);
  const [renameInstanceValue, setRenameInstanceValue] = useState('');
  const [renameInstanceSessionId, setRenameInstanceSessionId] = useState<string | null>(null);

  // Rename Tab Modal State
  const [renameTabModalOpen, setRenameTabModalOpen] = useState(false);
  const [renameTabId, setRenameTabId] = useState<string | null>(null);
  const [renameTabInitialName, setRenameTabInitialName] = useState('');

  // Rename Group Modal State
  const [renameGroupModalOpen, setRenameGroupModalOpen] = useState(false);

  // Agent Sessions Browser State (main panel view)
  const [agentSessionsOpen, setAgentSessionsOpen] = useState(false);
  const [activeClaudeSessionId, setActiveClaudeSessionId] = useState<string | null>(null);

  // Session jump shortcut state (Opt+Cmd+NUMBER to jump to visible session)
  const [showSessionJumpNumbers, setShowSessionJumpNumbers] = useState(false);

  // Execution Queue Browser Modal State
  const [queueBrowserOpen, setQueueBrowserOpen] = useState(false);

  // Batch Runner Modal State
  const [batchRunnerModalOpen, setBatchRunnerModalOpen] = useState(false);

  // Auto Run Setup Modal State
  const [autoRunSetupModalOpen, setAutoRunSetupModalOpen] = useState(false);

  // Wizard Resume Modal State
  const [wizardResumeModalOpen, setWizardResumeModalOpen] = useState(false);
  const [wizardResumeState, setWizardResumeState] = useState<SerializableWizardState | null>(null);

  // Tab Switcher Modal State
  const [tabSwitcherOpen, setTabSwitcherOpen] = useState(false);

  // Prompt Composer Modal State
  const [promptComposerOpen, setPromptComposerOpen] = useState(false);
  const [renameGroupId, setRenameGroupId] = useState<string | null>(null);
  const [renameGroupValue, setRenameGroupValue] = useState('');
  const [renameGroupEmoji, setRenameGroupEmoji] = useState('📂');
  const [renameGroupEmojiPickerOpen, setRenameGroupEmojiPickerOpen] = useState(false);

  // Output Search State
  const [outputSearchOpen, setOutputSearchOpen] = useState(false);
  const [outputSearchQuery, setOutputSearchQuery] = useState('');

  // Command History Modal State
  const [commandHistoryOpen, setCommandHistoryOpen] = useState(false);
  const [commandHistoryFilter, setCommandHistoryFilter] = useState('');
  const [commandHistorySelectedIndex, setCommandHistorySelectedIndex] = useState(0);

  // Tab Completion State (terminal mode only)
  const [tabCompletionOpen, setTabCompletionOpen] = useState(false);
  const [selectedTabCompletionIndex, setSelectedTabCompletionIndex] = useState(0);
  const [tabCompletionFilter, setTabCompletionFilter] = useState<TabCompletionFilter>('all');

  // Flash notification state (for inline notifications like "Commands disabled while agent is working")
  const [flashNotification, setFlashNotification] = useState<string | null>(null);
  // Success flash notification state (for success messages like "Refresh complete")
  const [successFlashNotification, setSuccessFlashNotification] = useState<string | null>(null);

  // @ mention file completion state (AI mode only, desktop only)
  const [atMentionOpen, setAtMentionOpen] = useState(false);
  const [atMentionFilter, setAtMentionFilter] = useState('');
  const [atMentionStartIndex, setAtMentionStartIndex] = useState(-1);  // Position of @ in input
  const [selectedAtMentionIndex, setSelectedAtMentionIndex] = useState(0);

  // Note: Images are now stored per-tab in AITab.stagedImages
  // See stagedImages/setStagedImages computed from active tab below

  // Global Live Mode State (web interface for all sessions)
  const [isLiveMode, setIsLiveMode] = useState(false);
  const [webInterfaceUrl, setWebInterfaceUrl] = useState<string | null>(null);

  // Auto Run document management state
  const [autoRunDocumentList, setAutoRunDocumentList] = useState<string[]>([]);
  const [autoRunDocumentTree, setAutoRunDocumentTree] = useState<AutoRunTreeNode[]>([]);
  const [autoRunContent, setAutoRunContent] = useState<string>('');
  const [autoRunContentVersion, setAutoRunContentVersion] = useState(0);  // Incremented on external file changes
  const [autoRunIsLoadingDocuments, setAutoRunIsLoadingDocuments] = useState(false);

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

  // Close file preview when switching sessions
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

      // If toolType is 'terminal', use the default agent instead for AI process
      if (aiAgentType === 'terminal') {
        console.warn(`[restoreSession] Session has toolType='terminal', using default agent for AI process`);
        aiAgentType = defaultAgent as ToolType;

        // Add warning to the active tab's logs
        const warningLog: LogEntry = {
          id: generateId(),
          timestamp: Date.now(),
          source: 'system',
          text: '⚠️ Using default AI agent (Claude Code) for this session.'
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

      // Spawn AI process (terminal uses runCommand which spawns fresh shells per command)
      const isClaudeBatchMode = aiAgentType === 'claude' || aiAgentType === 'claude-code';
      let aiSpawnResult = { pid: 0, success: true }; // Default for batch mode

      if (!isClaudeBatchMode) {
        // Only spawn for non-batch-mode agents (Codex, Gemini, Qwen, etc.)
        // Include active tab ID in session ID to match batch mode format
        const activeTabId = correctedSession.activeTabId || correctedSession.aiTabs?.[0]?.id || 'default';
        // Use agent.path (full path) if available for better cross-environment compatibility
        const agentCommand = agent.path || agent.command || agent.id;
        aiSpawnResult = await window.maestro.process.spawn({
          sessionId: `${correctedSession.id}-ai-${activeTabId}`,
          toolType: aiAgentType,
          cwd: correctedSession.cwd,
          command: agentCommand,
          args: agent.args || []
        });
      }

      // For batch mode (Claude), aiPid can be 0 since we don't spawn until first message
      const aiSuccess = aiSpawnResult.success && (isClaudeBatchMode || aiSpawnResult.pid > 0);

      if (aiSuccess) {
        // Check if the working directory is a Git repository
        const isGitRepo = await gitService.isRepo(correctedSession.cwd);

        // Fetch git branches and tags if it's a git repo
        let gitBranches: string[] | undefined;
        let gitTags: string[] | undefined;
        let gitRefsCacheTime: number | undefined;
        if (isGitRepo) {
          [gitBranches, gitTags] = await Promise.all([
            gitService.getBranches(correctedSession.cwd),
            gitService.getTags(correctedSession.cwd)
          ]);
          gitRefsCacheTime = Date.now();
        }

        // Session restored - no superfluous messages added to AI Terminal or Command Terminal
        return {
          ...correctedSession,
          aiPid: aiSpawnResult.pid,
          terminalPid: 0,  // Terminal uses runCommand (fresh shells per command)
          state: 'idle' as SessionState,
          isGitRepo,  // Update Git status
          gitBranches,
          gitTags,
          gitRefsCacheTime,
          isLive: false,  // Always start offline on app restart
          liveUrl: undefined,  // Clear any stale URL
          aiLogs: [],  // Deprecated - logs are now in aiTabs
          shellLogs: correctedSession.shellLogs,  // Preserve existing Command Terminal logs
          executionQueue: correctedSession.executionQueue || [],  // Ensure backwards compatibility
          activeTimeMs: correctedSession.activeTimeMs || 0  // Ensure backwards compatibility
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
  useEffect(() => {
    const loadSessionsAndGroups = async () => {
      let hasSessionsLoaded = false;

      try {
        const savedSessions = await window.maestro.sessions.getAll();
        const savedGroups = await window.maestro.groups.getAll();

        // Handle sessions
        if (savedSessions && savedSessions.length > 0) {
          const restoredSessions = await Promise.all(
            savedSessions.map(s => restoreSession(s))
          );
          setSessions(restoredSessions);
          hasSessionsLoaded = true;
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
      } catch (e) {
        console.error('Failed to load sessions/groups:', e);
        setSessions([]);
        setGroups([]);
      } finally {
        // Mark initial load as complete to enable persistence
        initialLoadComplete.current = true;

        // Mark sessions as loaded for splash screen coordination
        setSessionsLoaded(true);

        // If no sessions were loaded, check for wizard resume state or open wizard
        if (!hasSessionsLoaded) {
          // Check if there's a saved wizard state to resume
          const savedResumeState = await loadResumeState();
          if (savedResumeState) {
            // Show resume dialog instead of opening wizard directly
            setWizardResumeState(savedResumeState);
            setWizardResumeModalOpen(true);
          } else {
            // No resume state, start fresh wizard
            openWizardModal();
          }
        }
      }
    };
    loadSessionsAndGroups();
  }, []);

  // Hide splash screen only when both settings and sessions have fully loaded
  // This prevents theme flash on initial render
  useEffect(() => {
    if (settingsLoaded && sessionsLoaded) {
      if (typeof window.__hideSplash === 'function') {
        window.__hideSplash();
      }
    }
  }, [settingsLoaded, sessionsLoaded]);

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
  }, [settingsLoaded, sessionsLoaded]); // Only run once on startup

  // Check for updates on startup if enabled
  useEffect(() => {
    if (settingsLoaded && checkForUpdatesOnStartup) {
      // Delay to let the app fully initialize
      const timer = setTimeout(async () => {
        try {
          const result = await window.maestro.updates.check();
          if (result.updateAvailable && !result.error) {
            setUpdateCheckModalOpen(true);
          }
        } catch (error) {
          console.error('Failed to check for updates on startup:', error);
        }
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [settingsLoaded, checkForUpdatesOnStartup]);

  // Set up process event listeners for real-time output
  useEffect(() => {
    // Handle process output data
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

      setSessions(prev => prev.map(s => {
        if (s.id !== actualSessionId) return s;

        // For terminal output, use shellLogs as before
        if (!isFromAi) {
          const existingLogs = s.shellLogs;
          const lastLog = existingLogs[existingLogs.length - 1];
          const shouldGroup = lastLog &&
                             lastLog.source === 'stdout' &&
                             s.state === 'busy';

          if (shouldGroup) {
            const updatedLogs = [...existingLogs];
            updatedLogs[updatedLogs.length - 1] = {
              ...updatedLogs[updatedLogs.length - 1],
              text: updatedLogs[updatedLogs.length - 1].text + data
            };
            return { ...s, shellLogs: updatedLogs };
          } else {
            const newLog: LogEntry = {
              id: generateId(),
              timestamp: Date.now(),
              source: 'stdout',
              text: data
            };
            return { ...s, shellLogs: [...existingLogs, newLog] };
          }
        }

        // For AI output, route to the specific tab that initiated the request
        // Priority: 1) tab ID from session ID (most reliable), 2) busy tab, 3) active tab
        let targetTab;
        if (tabIdFromSession) {
          // Tab ID encoded in session ID - use it directly
          targetTab = s.aiTabs?.find(tab => tab.id === tabIdFromSession);
        }
        if (!targetTab) {
          // Fallback: find busy tab or active tab
          targetTab = getWriteModeTab(s) || getActiveTab(s);
        }
        if (!targetTab) {
          // No tabs exist - this is a bug, sessions must have aiTabs
          console.error('[onData] No target tab found - session has no aiTabs, this should not happen');
          return s;
        }

        const existingLogs = targetTab.logs;
        const lastLog = existingLogs[existingLogs.length - 1];

        // Time-based grouping for AI output (500ms window)
        const shouldGroup = lastLog &&
                           lastLog.source === 'stdout' &&
                           (Date.now() - lastLog.timestamp) < 500;

        // Mark the most recent user message as delivered when we receive AI output
        let logsWithDelivery = existingLogs;
        const lastUserIndex = existingLogs.map((log, i) => ({ log, i }))
          .filter(({ log }) => log.source === 'user' && !log.delivered)
          .pop()?.i;
        if (lastUserIndex !== undefined) {
          logsWithDelivery = existingLogs.map((log, i) =>
            i === lastUserIndex ? { ...log, delivered: true } : log
          );
        }

        let updatedTabLogs: LogEntry[];
        if (shouldGroup) {
          // Append to existing log entry
          updatedTabLogs = [...logsWithDelivery];
          updatedTabLogs[updatedTabLogs.length - 1] = {
            ...updatedTabLogs[updatedTabLogs.length - 1],
            text: updatedTabLogs[updatedTabLogs.length - 1].text + data
          };
        } else {
          // Create new log entry
          const newLog: LogEntry = {
            id: generateId(),
            timestamp: Date.now(),
            source: 'stdout',
            text: data
          };
          updatedTabLogs = [...logsWithDelivery, newLog];
        }

        // Update the target tab's logs within the aiTabs array
        // Also mark as unread if this is not the active tab
        const isTargetTabActive = targetTab.id === s.activeTabId;
        const updatedAiTabs = s.aiTabs.map(tab =>
          tab.id === targetTab.id
            ? { ...tab, logs: updatedTabLogs, hasUnread: !isTargetTabActive }
            : tab
        );

        return {
          ...s,
          aiTabs: updatedAiTabs,
          // Track bytes received for real-time progress display
          currentCycleBytes: (s.currentCycleBytes || 0) + data.length
        };
      }));
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
        claudeSessionId?: string;
        tabName?: string;
        usageStats?: UsageStats;
        prompt?: string;
        response?: string;
        sessionSizeKB?: string;
        sessionId?: string; // Maestro session ID for toast navigation
        tabId?: string; // Tab ID for toast navigation
      } | null = null;
      let queuedItemToProcess: { sessionId: string; item: QueuedItem } | null = null;
      // Track if we need to run synopsis after completion (for /commit and other AI commands)
      let synopsisData: { sessionId: string; cwd: string; claudeSessionId: string; command: string; groupName: string; projectName: string; tabName?: string; tabId?: string } | null = null;

      if (isFromAi) {
        const currentSession = sessionsRef.current.find(s => s.id === actualSessionId);
        if (currentSession) {
          // Check if there are queued items to process next
          // We still want to show a toast for this tab's completion even if other tabs have work queued
          if (currentSession.executionQueue.length > 0) {
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

          // Get the completed tab's claudeSessionId for traceability
          const claudeSessionId = completedTab?.claudeSessionId || currentSession.claudeSessionId;
          // Get tab name: prefer tab's name, fallback to short UUID from claudeSessionId
          const tabName = completedTab?.name || (claudeSessionId ? claudeSessionId.substring(0, 8).toUpperCase() : undefined);

          toastData = {
            title,
            summary,
            groupName,
            projectName,
            duration,
            claudeSessionId: claudeSessionId || undefined,
            tabName,
            usageStats: currentSession.usageStats,
            prompt: lastUserLog?.text,
            response: lastAiLog?.text,
            sessionSizeKB,
            sessionId: actualSessionId, // For toast navigation
            tabId: completedTab?.id // For toast navigation to specific tab
          };

          // Check if synopsis should be triggered:
          // 1. Tab has saveToHistory enabled, OR
          // 2. This was a custom AI command (pendingAICommandForSynopsis)
          // Only trigger when queue is empty (final task complete) and we have a claudeSessionId
          const shouldSynopsis = currentSession.executionQueue.length === 0 &&
            (completedTab?.claudeSessionId || currentSession.claudeSessionId) &&
            (completedTab?.saveToHistory || currentSession.pendingAICommandForSynopsis);

          if (shouldSynopsis) {
            synopsisData = {
              sessionId: actualSessionId,
              cwd: currentSession.cwd,
              claudeSessionId: completedTab?.claudeSessionId || currentSession.claudeSessionId!,
              command: currentSession.pendingAICommandForSynopsis || 'Save to History',
              groupName,
              projectName,
              tabName,
              tabId: completedTab?.id
            };
          }
        }
      }

      // Update state (pure function - no side effects)
      setSessions(prev => prev.map(s => {
        if (s.id !== actualSessionId) return s;

        if (isFromAi) {
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
          const anyTabStillBusy = updatedAiTabs.some(tab => tab.state === 'busy');
          const newState = anyTabStillBusy ? 'busy' as SessionState : 'idle' as SessionState;
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
              const [gitBranches, gitTags] = await Promise.all([
                gitService.getBranches(currentSession.cwd),
                gitService.getTags(currentSession.cwd)
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
      if (queuedItemToProcess) {
        setTimeout(() => {
          processQueuedItem(queuedItemToProcess!.sessionId, queuedItemToProcess!.item);
        }, 0);
      } else if (toastData) {
        setTimeout(() => {
          // Log agent completion for debugging and traceability
          window.maestro.logger.log('info', 'Agent process completed', 'App', {
            claudeSessionId: toastData!.claudeSessionId,
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
              claudeSessionId: toastData!.claudeSessionId,
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
        const SYNOPSIS_PROMPT = 'Synopsize our recent work in 2-3 sentences max.';
        const startTime = Date.now();

        spawnBackgroundSynopsisRef.current(
          synopsisData.sessionId,
          synopsisData.cwd,
          synopsisData.claudeSessionId,
          SYNOPSIS_PROMPT
        ).then(result => {
          const duration = Date.now() - startTime;
          if (result.success && result.response && addHistoryEntryRef.current) {
            // IMPORTANT: Pass explicit sessionId and projectPath to prevent cross-agent bleed
            // when user switches agents while synopsis is running in background
            addHistoryEntryRef.current({
              type: 'USER',
              summary: result.response,
              claudeSessionId: synopsisData!.claudeSessionId,
              usageStats: result.usageStats,
              sessionId: synopsisData!.sessionId,
              projectPath: synopsisData!.cwd,
              sessionName: synopsisData!.tabName,
            });

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
          }
        }).catch(err => {
          console.error('[onProcessExit] Synopsis failed:', err);
        });
      }
    });

    // Handle Claude session ID capture for interactive sessions only
    const unsubscribeSessionId = window.maestro.process.onSessionId(async (sessionId: string, claudeSessionId: string) => {
      // Ignore batch sessions - they have their own isolated session IDs that should NOT
      // contaminate the interactive session's claudeSessionId
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
        window.maestro.claude.registerSessionOrigin(session.cwd, claudeSessionId, 'user')
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
            const awaitingTab = s.aiTabs?.find(tab => tab.awaitingSessionId && !tab.claudeSessionId);
            targetTab = awaitingTab || getActiveTab(s);
          }

          if (!targetTab) {
            // No tabs exist - this is a bug, sessions must have aiTabs
            // Still store at session-level for web API compatibility
            console.error('[onSessionId] No target tab found - session has no aiTabs, storing at session level only');
            return { ...s, claudeSessionId };
          }

          // Skip if this tab already has a claudeSessionId (prevent overwriting)
          if (targetTab.claudeSessionId && targetTab.claudeSessionId !== claudeSessionId) {
            return s;
          }

          // Update the target tab's claudeSessionId, name (if not already set), and clear awaitingSessionId flag
          // Generate short UUID for display (first 8 chars, uppercase)
          const shortUuid = claudeSessionId.substring(0, 8).toUpperCase();
          const updatedAiTabs = s.aiTabs.map(tab => {
            if (tab.id !== targetTab.id) return tab;
            // Only set name if it's still the default "New Session"
            const newName = (!tab.name || tab.name === 'New Session') ? shortUuid : tab.name;
            return { ...tab, claudeSessionId, awaitingSessionId: false, name: newName };
          });

          return { ...s, aiTabs: updatedAiTabs, claudeSessionId }; // Also keep session-level for backwards compatibility
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
        return { ...s, claudeCommands: commands };
      }));
    });

    // Handle stderr from runCommand (separate from stdout)
    const unsubscribeStderr = window.maestro.process.onStderr((sessionId: string, data: string) => {
      // runCommand uses plain session ID (no suffix)
      const actualSessionId = sessionId;

      // Filter out empty stderr (only whitespace)
      if (!data.trim()) return;

      setSessions(prev => prev.map(s => {
        if (s.id !== actualSessionId) return s;

        const existingLogs = s.shellLogs;
        const lastLog = existingLogs[existingLogs.length - 1];

        // Group all stderr while command is running (state === 'busy')
        const shouldGroup = lastLog &&
                           lastLog.source === 'stderr' &&
                           s.state === 'busy';

        if (shouldGroup) {
          const updatedLogs = [...existingLogs];
          updatedLogs[updatedLogs.length - 1] = {
            ...lastLog,
            text: lastLog.text + data
          };
          return { ...s, shellLogs: updatedLogs };
        } else {
          const newLog: LogEntry = {
            id: generateId(),
            timestamp: Date.now(),
            source: 'stderr',
            text: data
          };
          return { ...s, shellLogs: [...existingLogs, newLog] };
        }
      }));
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

    // Handle usage statistics from AI responses
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

      setSessions(prev => prev.map(s => {
        if (s.id !== actualSessionId) return s;

        // Current cycle tokens = output tokens from this response
        // (These are the NEW tokens added to the context, not the cumulative total)
        const cycleTokens = (s.currentCycleTokens || 0) + usageStats.outputTokens;

        // Update the specific tab's usageStats if we have a tabId
        // Token counts need to be accumulated across exchanges for accurate context window tracking
        // Claude Code CLI reports per-exchange tokens, not cumulative session tokens
        let updatedAiTabs = s.aiTabs;
        if (tabId && s.aiTabs) {
          updatedAiTabs = s.aiTabs.map(tab => {
            if (tab.id !== tabId) return tab;
            // Accumulate cost/output tokens for total tracking, but keep current context tokens
            // This allows proper context display after /compact while still tracking total usage
            const existing = tab.usageStats;
            return {
              ...tab,
              usageStats: {
                // Current context tokens (not accumulated - reflects actual state after compaction)
                inputTokens: usageStats.inputTokens,
                cacheReadInputTokens: usageStats.cacheReadInputTokens,
                cacheCreationInputTokens: usageStats.cacheCreationInputTokens,
                contextWindow: usageStats.contextWindow,
                // Accumulated values for total tracking
                outputTokens: (existing?.outputTokens || 0) + usageStats.outputTokens,
                totalCostUsd: (existing?.totalCostUsd || 0) + usageStats.totalCostUsd,
              }
            };
          });
        }

        // Calculate context window usage percentage from CURRENT reported tokens
        // Claude Code reports the actual context size in each response (inputTokens + cache tokens)
        // This naturally reflects compaction - after /compact, the reported context is smaller
        // We use the raw usageStats (not accumulated) because it represents current context state
        const currentContextTokens = usageStats.inputTokens + usageStats.cacheReadInputTokens + usageStats.cacheCreationInputTokens;
        const contextPercentage = usageStats.contextWindow > 0
          ? Math.min(Math.round((currentContextTokens / usageStats.contextWindow) * 100), 100)
          : 0;

        // Accumulate session-level stats for backwards compatibility
        const existingSessionStats = s.usageStats;

        return {
          ...s,
          contextUsage: contextPercentage,
          currentCycleTokens: cycleTokens,
          usageStats: {
            inputTokens: (existingSessionStats?.inputTokens || 0) + usageStats.inputTokens,
            outputTokens: (existingSessionStats?.outputTokens || 0) + usageStats.outputTokens,
            cacheReadInputTokens: (existingSessionStats?.cacheReadInputTokens || 0) + usageStats.cacheReadInputTokens,
            cacheCreationInputTokens: (existingSessionStats?.cacheCreationInputTokens || 0) + usageStats.cacheCreationInputTokens,
            totalCostUsd: (existingSessionStats?.totalCostUsd || 0) + usageStats.totalCostUsd,
            contextWindow: usageStats.contextWindow
          },
          aiTabs: updatedAiTabs
        };
      }));

      // Update persistent global stats
      updateGlobalStatsRef.current({
        totalInputTokens: usageStats.inputTokens,
        totalOutputTokens: usageStats.outputTokens,
        totalCacheReadTokens: usageStats.cacheReadInputTokens,
        totalCacheCreationTokens: usageStats.cacheCreationInputTokens,
        totalCostUsd: usageStats.totalCostUsd,
      });
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
    };
  }, []);

  // Refs
  const logsEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const terminalOutputRef = useRef<HTMLDivElement>(null);
  const fileTreeContainerRef = useRef<HTMLDivElement>(null);
  const fileTreeFilterInputRef = useRef<HTMLInputElement>(null);
  const fileTreeKeyboardNavRef = useRef(false); // Track if selection change came from keyboard
  const rightPanelRef = useRef<RightPanelHandle>(null);

  // Refs for toast notifications (to access latest values in event handlers)
  const groupsRef = useRef(groups);
  const addToastRef = useRef(addToast);
  const sessionsRef = useRef(sessions);
  const updateGlobalStatsRef = useRef(updateGlobalStats);
  const customAICommandsRef = useRef(customAICommands);
  const activeSessionIdRef = useRef(activeSessionId);
  groupsRef.current = groups;
  addToastRef.current = addToast;
  sessionsRef.current = sessions;
  updateGlobalStatsRef.current = updateGlobalStats;
  customAICommandsRef.current = customAICommands;
  activeSessionIdRef.current = activeSessionId;

  // Refs for slash command functions (to access latest values in remote command handler)
  const spawnBackgroundSynopsisRef = useRef<typeof spawnBackgroundSynopsis | null>(null);
  const addHistoryEntryRef = useRef<typeof addHistoryEntry | null>(null);
  const spawnAgentWithPromptRef = useRef<typeof spawnAgentWithPrompt | null>(null);
  const startNewClaudeSessionRef = useRef<typeof startNewClaudeSession | null>(null);
  // Ref for processQueuedMessage - allows batch exit handler to process queued messages
  const processQueuedItemRef = useRef<((sessionId: string, item: QueuedItem) => Promise<void>) | null>(null);

  // Ref for handling remote commands from web interface
  // This allows web commands to go through the exact same code path as desktop commands
  const pendingRemoteCommandRef = useRef<{ sessionId: string; command: string } | null>(null);

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
  const activeSession = useMemo(() =>
    sessions.find(s => s.id === activeSessionId) || sessions[0] || null,
    [sessions, activeSessionId]
  );
  const theme = THEMES[activeThemeId];

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

  // Tab completion hook for terminal mode
  const { getSuggestions: getTabCompletionSuggestions } = useTabCompletion(activeSession);

  // @ mention completion hook for AI mode
  const { getSuggestions: getAtMentionSuggestions } = useAtMentionCompletion(activeSession);

  // Broadcast active session change to web clients
  useEffect(() => {
    if (activeSessionId && isLiveMode) {
      window.maestro.live.broadcastActiveSession(activeSessionId);
    }
  }, [activeSessionId, isLiveMode]);

  // Handle remote commands from web interface
  // This allows web commands to go through the exact same code path as desktop commands
  useEffect(() => {
    console.log('[Remote] Setting up onRemoteCommand listener...');
    const unsubscribeRemote = window.maestro.process.onRemoteCommand((sessionId: string, command: string, inputMode?: 'ai' | 'terminal') => {
      // Verify the session exists
      const targetSession = sessionsRef.current.find(s => s.id === sessionId);

      console.log('[Remote] Received command from web interface:', {
        maestroSessionId: sessionId,
        claudeSessionId: targetSession?.claudeSessionId || 'none',
        state: targetSession?.state || 'NOT_FOUND',
        sessionInputMode: targetSession?.inputMode || 'unknown',
        webInputMode: inputMode || 'not provided',
        command: command.substring(0, 100)
      });

      if (!targetSession) {
        console.log('[Remote] ERROR: Session not found:', sessionId);
        return;
      }

      // Check if session is busy (should have been checked by web server, but double-check)
      if (targetSession.state === 'busy') {
        console.log('[Remote] REJECTED: Session is busy:', sessionId);
        return;
      }

      // If web provided an inputMode, sync the session state before executing
      // This ensures the renderer uses the same mode the web intended
      if (inputMode && targetSession.inputMode !== inputMode) {
        console.log('[Remote] Syncing inputMode from web:', inputMode, '(was:', targetSession.inputMode, ')');
        setSessions(prev => prev.map(s =>
          s.id === sessionId ? { ...s, inputMode } : s
        ));
      }

      // Switch to the target session (for visual feedback)
      console.log('[Remote] Switching to target session...');
      setActiveSessionId(sessionId);

      // Dispatch event directly - handleRemoteCommand handles all the logic
      // Don't set inputValue - we don't want command text to appear in the input bar
      // Pass the inputMode from web so handleRemoteCommand uses it
      console.log('[Remote] Dispatching maestro:remoteCommand event');
      window.dispatchEvent(new CustomEvent('maestro:remoteCommand', {
        detail: { sessionId, command, inputMode }
      }));
    });

    return () => {
      unsubscribeRemote();
    };
  }, []);

  // Handle remote mode switches from web interface
  // This allows web mode switches to go through the same code path as desktop
  useEffect(() => {
    const unsubscribeSwitchMode = window.maestro.process.onRemoteSwitchMode((sessionId: string, mode: 'ai' | 'terminal') => {
      console.log('[Remote] Received mode switch from web interface:', { sessionId, mode });

      // Find the session and update its mode
      setSessions(prev => {
        const session = prev.find(s => s.id === sessionId);
        if (!session) {
          console.log('[Remote] Session not found for mode switch:', sessionId);
          return prev;
        }

        // Only switch if mode is different
        if (session.inputMode === mode) {
          console.log('[Remote] Session already in mode:', mode);
          return prev;
        }

        console.log('[Remote] Switching session mode:', sessionId, 'to', mode);
        return prev.map(s => {
          if (s.id !== sessionId) return s;
          return { ...s, inputMode: mode };
        });
      });
    });

    return () => {
      unsubscribeSwitchMode();
    };
  }, []);

  // Handle remote interrupts from web interface
  // This allows web interrupts to go through the same code path as desktop (handleInterrupt)
  useEffect(() => {
    const unsubscribeInterrupt = window.maestro.process.onRemoteInterrupt(async (sessionId: string) => {
      console.log('[Remote] Received interrupt from web interface:', { sessionId });

      // Find the session
      const session = sessionsRef.current.find(s => s.id === sessionId);
      if (!session) {
        console.log('[Remote] Session not found for interrupt:', sessionId);
        return;
      }

      // Use the same logic as handleInterrupt
      const currentMode = session.inputMode;
      const targetSessionId = currentMode === 'ai' ? `${session.id}-ai` : `${session.id}-terminal`;

      try {
        // Send interrupt signal (Ctrl+C)
        await window.maestro.process.interrupt(targetSessionId);

        // Set state to idle (same as handleInterrupt)
        setSessions(prev => prev.map(s => {
          if (s.id !== session.id) return s;
          return {
            ...s,
            state: 'idle',
            busySource: undefined,
            thinkingStartTime: undefined
          };
        }));

        console.log('[Remote] Interrupt successful for session:', sessionId);
      } catch (error) {
        console.error('[Remote] Failed to interrupt session:', error);
      }
    });

    return () => {
      unsubscribeInterrupt();
    };
  }, []);

  // Handle remote session selection from web interface
  // This allows web clients to switch the active session in the desktop app
  // If tabId is provided, also switches to that tab within the session
  useEffect(() => {
    const unsubscribeSelectSession = window.maestro.process.onRemoteSelectSession((sessionId: string, tabId?: string) => {
      console.log('[Remote] Received session selection from web interface:', { sessionId, tabId });

      // Check if session exists
      const session = sessionsRef.current.find(s => s.id === sessionId);
      if (!session) {
        console.log('[Remote] Session not found for selection:', sessionId);
        return;
      }

      // Switch to the session (same as clicking in SessionList)
      setActiveSessionId(sessionId);
      console.log('[Remote] Switched to session:', sessionId);

      // If tabId provided, also switch to that tab
      if (tabId) {
        setSessions(prev => prev.map(s => {
          if (s.id !== sessionId) return s;
          // Check if tab exists
          if (!s.aiTabs.some(t => t.id === tabId)) {
            console.log('[Remote] Tab not found for selection:', tabId);
            return s;
          }
          console.log('[Remote] Switched to tab:', tabId);
          return { ...s, activeTabId: tabId };
        }));
      }
    });

    // Handle remote tab selection from web interface
    // This also switches to the session if not already active
    const unsubscribeSelectTab = window.maestro.process.onRemoteSelectTab((sessionId: string, tabId: string) => {
      console.log('[Remote] Received tab selection from web interface:', { sessionId, tabId });

      // First, switch to the session if not already active
      const currentActiveId = activeSessionIdRef.current;
      if (currentActiveId !== sessionId) {
        console.log('[Remote] Switching to session:', sessionId);
        setActiveSessionId(sessionId);
      }

      // Then update the active tab within the session
      setSessions(prev => prev.map(s => {
        if (s.id !== sessionId) return s;
        // Check if tab exists
        if (!s.aiTabs.some(t => t.id === tabId)) {
          console.log('[Remote] Tab not found for selection:', tabId);
          return s;
        }
        return { ...s, activeTabId: tabId };
      }));
    });

    // Handle remote new tab from web interface
    const unsubscribeNewTab = window.maestro.process.onRemoteNewTab((sessionId: string, responseChannel: string) => {
      console.log('[Remote] Received new tab request from web interface:', { sessionId, responseChannel });

      let newTabId: string | null = null;

      setSessions(prev => prev.map(s => {
        if (s.id !== sessionId) return s;

        // Use createTab helper
        const result = createTab(s, { saveToHistory: defaultSaveToHistory });
        newTabId = result.tab.id;
        return result.session;
      }));

      // Send response back with the new tab ID
      if (newTabId) {
        window.maestro.process.sendRemoteNewTabResponse(responseChannel, { tabId: newTabId });
      } else {
        window.maestro.process.sendRemoteNewTabResponse(responseChannel, null);
      }
    });

    // Handle remote close tab from web interface
    const unsubscribeCloseTab = window.maestro.process.onRemoteCloseTab((sessionId: string, tabId: string) => {
      console.log('[Remote] Received close tab request from web interface:', { sessionId, tabId });

      setSessions(prev => prev.map(s => {
        if (s.id !== sessionId) return s;

        // Use closeTab helper (handles last tab by creating a fresh one)
        const result = closeTab(s, tabId);
        return result?.session ?? s;
      }));
    });

    return () => {
      unsubscribeSelectSession();
      unsubscribeSelectTab();
      unsubscribeNewTab();
      unsubscribeCloseTab();
    };
  }, []);

  // Broadcast tab changes to web clients when tabs or activeTabId changes
  // Use a ref to track previous values and only broadcast on actual changes
  const prevTabsRef = useRef<Map<string, { tabCount: number; activeTabId: string }>>(new Map());

  useEffect(() => {
    // Broadcast tab changes for all sessions that have changed
    sessions.forEach(session => {
      if (!session.aiTabs || session.aiTabs.length === 0) return;

      const prev = prevTabsRef.current.get(session.id);
      const current = {
        tabCount: session.aiTabs.length,
        activeTabId: session.activeTabId || session.aiTabs[0]?.id || '',
      };

      // Check if anything changed
      if (!prev || prev.tabCount !== current.tabCount || prev.activeTabId !== current.activeTabId) {
        // Broadcast to web clients
        const tabsForBroadcast = session.aiTabs.map(tab => ({
          id: tab.id,
          claudeSessionId: tab.claudeSessionId,
          name: tab.name,
          starred: tab.starred,
          inputValue: tab.inputValue,
          usageStats: tab.usageStats,
          createdAt: tab.createdAt,
          state: tab.state,
          thinkingStartTime: tab.thinkingStartTime,
        }));

        window.maestro.web.broadcastTabsChange(
          session.id,
          tabsForBroadcast,
          current.activeTabId
        );

        // Update ref
        prevTabsRef.current.set(session.id, current);
      }
    });
  }, [sessions]);

  // Listen for external history changes (e.g., from CLI) and refresh history panel
  useEffect(() => {
    const unsubscribe = window.maestro.history.onExternalChange(async () => {
      console.log('[History] External change detected, reloading from disk and refreshing history panel');
      // Reload from disk before refreshing (to bypass electron-store cache)
      await window.maestro.history.reload();
      rightPanelRef.current?.refreshHistoryPanel();
    });
    return unsubscribe;
  }, []);

  // Listen for CLI activity changes (when CLI is running playbooks)
  // Update session states to show busy when CLI is active
  useEffect(() => {
    const checkCliActivity = async () => {
      try {
        const activities = await window.maestro.cli.getActivity();
        setSessions(prev => prev.map(session => {
          const cliActivity = activities.find(a => a.sessionId === session.id);
          if (cliActivity) {
            // CLI is running a playbook on this session - mark as busy
            // Only update if not already busy (to preserve aiPid-based busy state)
            if (session.state !== 'busy') {
              return {
                ...session,
                state: 'busy' as const,
                cliActivity: {
                  playbookId: cliActivity.playbookId,
                  playbookName: cliActivity.playbookName,
                  startedAt: cliActivity.startedAt,
                },
              };
            }
          } else if (session.cliActivity) {
            // CLI activity ended - set back to idle (unless process is still running)
            if (!session.aiPid) {
              return {
                ...session,
                state: 'idle' as const,
                cliActivity: undefined,
              };
            }
          }
          return session;
        }));
      } catch (error) {
        console.error('[CLI Activity] Error checking activity:', error);
      }
    };

    // Check immediately on mount
    checkCliActivity();

    // Listen for changes
    const unsubscribe = window.maestro.cli.onActivityChange(() => {
      console.log('[CLI Activity] Activity change detected');
      checkCliActivity();
    });
    return unsubscribe;
  }, []);

  // Combine built-in slash commands with custom AI commands AND Claude Code commands for autocomplete
  const allSlashCommands = useMemo(() => {
    const customCommandsAsSlash = customAICommands
      .map(cmd => ({
        command: cmd.command,
        description: cmd.description,
        aiOnly: true, // Custom AI commands are only available in AI mode
        prompt: cmd.prompt, // Include prompt for execution
      }));
    // Include Claude Code commands from the active session
    const claudeCommands = (activeSession?.claudeCommands || []).map(cmd => ({
      command: cmd.command,
      description: cmd.description,
      aiOnly: true, // Claude commands are only available in AI mode
    }));
    return [...slashCommands, ...customCommandsAsSlash, ...claudeCommands];
  }, [customAICommands, activeSession?.claudeCommands]);

  // Derive current input value and setter based on active session mode
  // For AI mode: use active tab's inputValue (stored per-tab)
  // For terminal mode: use local state (shared across tabs)
  const isAiMode = activeSession?.inputMode === 'ai';
  const activeTab = activeSession ? getActiveTab(activeSession) : undefined;

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Tab completion suggestions (must be after inputValue is defined)
  const tabCompletionSuggestions = useMemo(() => {
    if (!tabCompletionOpen || !activeSession || activeSession.inputMode !== 'terminal') {
      return [];
    }
    return getTabCompletionSuggestions(inputValue, tabCompletionFilter);
  }, [tabCompletionOpen, activeSession, inputValue, tabCompletionFilter, getTabCompletionSuggestions]);

  // @ mention suggestions for AI mode
  const atMentionSuggestions = useMemo(() => {
    if (!atMentionOpen || !activeSession || activeSession.inputMode !== 'ai') {
      return [];
    }
    return getAtMentionSuggestions(atMentionFilter);
  }, [atMentionOpen, activeSession, atMentionFilter, getAtMentionSuggestions]);

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

  // --- BATCH PROCESSOR ---
  // Helper to spawn a Claude agent and wait for completion (for a specific session)
  // cwdOverride allows running in a different directory (e.g., for worktree mode)
  const spawnAgentForSession = useCallback(async (sessionId: string, prompt: string, cwdOverride?: string): Promise<{ success: boolean; response?: string; claudeSessionId?: string; usageStats?: UsageStats }> => {
    // Use sessionsRef to get latest sessions (fixes stale closure when called right after session creation)
    const session = sessionsRef.current.find(s => s.id === sessionId);
    if (!session) return { success: false };

    // Use override cwd if provided (worktree mode), otherwise use session's cwd
    const effectiveCwd = cwdOverride || session.cwd;

    // This spawns a new Claude session and waits for completion
    try {
      const agent = await window.maestro.agents.get('claude-code');
      if (!agent) return { success: false };

      // For batch processing, use a unique session ID per task run to avoid contaminating the main AI terminal
      // This prevents batch output from appearing in the interactive AI terminal
      const targetSessionId = `${sessionId}-batch-${Date.now()}`;

      // Note: We intentionally do NOT set the session or tab state to 'busy' here.
      // Batch operations run in isolation and should not affect the main UI state.
      // The batch progress is tracked separately via BatchRunState in useBatchProcessor.

      // Create a promise that resolves when the agent completes
      return new Promise((resolve) => {
        let claudeSessionId: string | undefined;
        let responseText = '';
        let taskUsageStats: UsageStats | undefined;

        // Cleanup functions will be set when listeners are registered
        let cleanupData: (() => void) | undefined;
        let cleanupSessionId: (() => void) | undefined;
        let cleanupExit: (() => void) | undefined;
        let cleanupUsage: (() => void) | undefined;

        const cleanup = () => {
          cleanupData?.();
          cleanupSessionId?.();
          cleanupExit?.();
          cleanupUsage?.();
        };

        // Set up listeners for this specific agent run
        cleanupData = window.maestro.process.onData((sid: string, data: string) => {
          if (sid === targetSessionId) {
            responseText += data;
          }
        });

        cleanupSessionId = window.maestro.process.onSessionId((sid: string, capturedId: string) => {
          if (sid === targetSessionId) {
            claudeSessionId = capturedId;
          }
        });

        // Capture usage stats for this specific task
        cleanupUsage = window.maestro.process.onUsage((sid: string, usageStats) => {
          if (sid === targetSessionId) {
            // Accumulate usage stats for this task (there may be multiple usage events per task)
            if (!taskUsageStats) {
              taskUsageStats = { ...usageStats };
            } else {
              // Accumulate tokens and cost
              taskUsageStats = {
                ...usageStats,
                inputTokens: taskUsageStats.inputTokens + usageStats.inputTokens,
                outputTokens: taskUsageStats.outputTokens + usageStats.outputTokens,
                cacheReadInputTokens: taskUsageStats.cacheReadInputTokens + usageStats.cacheReadInputTokens,
                cacheCreationInputTokens: taskUsageStats.cacheCreationInputTokens + usageStats.cacheCreationInputTokens,
                totalCostUsd: taskUsageStats.totalCostUsd + usageStats.totalCostUsd,
              };
            }
          }
        });

        cleanupExit = window.maestro.process.onExit((sid: string) => {
          if (sid === targetSessionId) {
            // Clean up listeners
            cleanup();

            // Check for queued items BEFORE updating state (using sessionsRef for latest state)
            const currentSession = sessionsRef.current.find(s => s.id === sessionId);
            let queuedItemToProcess: { sessionId: string; item: QueuedItem } | null = null;
            const hasQueuedItems = currentSession && currentSession.executionQueue.length > 0;

            if (hasQueuedItems) {
              queuedItemToProcess = {
                sessionId: sessionId,
                item: currentSession!.executionQueue[0]
              };
            }

            // Update state - if there are queued items, keep busy and process next
            setSessions(prev => prev.map(s => {
              if (s.id !== sessionId) return s;

              if (s.executionQueue.length > 0) {
                const [nextItem, ...remainingQueue] = s.executionQueue;
                const targetTab = s.aiTabs.find(tab => tab.id === nextItem.tabId) || getActiveTab(s);

                if (!targetTab) {
                  // Fallback: no tabs exist
                  return {
                    ...s,
                    state: 'busy' as SessionState,
                    busySource: 'ai',
                    executionQueue: remainingQueue,
                    thinkingStartTime: Date.now(),
                    currentCycleTokens: 0,
                    currentCycleBytes: 0,
                    pendingAICommandForSynopsis: undefined
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
                      ? { ...tab, logs: [...tab.logs, logEntry] }
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
                  currentCycleTokens: 0,
                  currentCycleBytes: 0,
                  pendingAICommandForSynopsis: undefined
                };
              }

              // No queued items - set to idle
              // Set ALL busy tabs to 'idle' for write-mode tracking
              const updatedAiTabs = s.aiTabs?.length > 0
                ? s.aiTabs.map(tab =>
                    tab.state === 'busy' ? { ...tab, state: 'idle' as const, thinkingStartTime: undefined } : tab
                  )
                : s.aiTabs;

              return {
                ...s,
                state: 'idle' as SessionState,
                busySource: undefined,
                thinkingStartTime: undefined,
                pendingAICommandForSynopsis: undefined,
                aiTabs: updatedAiTabs
              };
            }));

            // Process queued item AFTER state update
            if (queuedItemToProcess && processQueuedItemRef.current) {
              setTimeout(() => {
                processQueuedItemRef.current!(queuedItemToProcess!.sessionId, queuedItemToProcess!.item);
              }, 0);
            }

            // For batch processing (Auto Run): if there are queued items from manual writes,
            // wait for the queue to drain before resolving. This ensures batch tasks don't
            // race with queued manual writes. Worktree mode can skip this since it operates
            // in a separate directory with no file conflicts.
            // Note: cwdOverride is set when worktree is enabled
            if (hasQueuedItems && !cwdOverride) {
              // Wait for queue to drain by polling session state
              // The queue is processed sequentially, so we wait until session becomes idle
              const waitForQueueDrain = () => {
                const checkSession = sessionsRef.current.find(s => s.id === sessionId);
                if (!checkSession || checkSession.state === 'idle' || checkSession.executionQueue.length === 0) {
                  // Queue drained or session idle - safe to continue batch
                  resolve({ success: true, response: responseText, claudeSessionId, usageStats: taskUsageStats });
                } else {
                  // Queue still processing - check again
                  setTimeout(waitForQueueDrain, 100);
                }
              };
              // Start polling after a short delay to let state update propagate
              setTimeout(waitForQueueDrain, 50);
            } else {
              // No queued items or worktree mode - resolve immediately
              resolve({ success: true, response: responseText, claudeSessionId, usageStats: taskUsageStats });
            }
          }
        });

        // Spawn the agent with permission-mode plan for batch processing
        // Use effectiveCwd which may be a worktree path for parallel execution
        const commandToUse = agent.path || agent.command;
        const spawnArgs = [...(agent.args || []), '--permission-mode', 'plan'];
        window.maestro.process.spawn({
          sessionId: targetSessionId,
          toolType: 'claude-code',
          cwd: effectiveCwd,
          command: commandToUse,
          args: spawnArgs,
          prompt
        }).catch(() => {
          cleanup();
          resolve({ success: false });
        });
      });
    } catch (error) {
      console.error('Error spawning agent:', error);
      return { success: false };
    }
  }, []); // Uses sessionsRef for latest sessions, no closure dependencies needed

  // Wrapper for slash commands that need to spawn an agent with just a prompt
  const spawnAgentWithPrompt = useCallback(async (prompt: string) => {
    if (!activeSession) return { success: false };
    return spawnAgentForSession(activeSession.id, prompt);
  }, [activeSession, spawnAgentForSession]);

  // Background synopsis function - resumes an old Claude session without affecting main session state
  const spawnBackgroundSynopsis = useCallback(async (
    sessionId: string,
    cwd: string,
    resumeClaudeSessionId: string,
    prompt: string
  ): Promise<{ success: boolean; response?: string; claudeSessionId?: string; usageStats?: UsageStats }> => {
    try {
      const agent = await window.maestro.agents.get('claude-code');
      if (!agent) return { success: false };

      // Use a unique target ID for background synopsis
      const targetSessionId = `${sessionId}-synopsis-${Date.now()}`;

      return new Promise((resolve) => {
        let claudeSessionId: string | undefined;
        let responseText = '';
        let synopsisUsageStats: UsageStats | undefined;

        let cleanupData: (() => void) | undefined;
        let cleanupSessionId: (() => void) | undefined;
        let cleanupExit: (() => void) | undefined;
        let cleanupUsage: (() => void) | undefined;

        const cleanup = () => {
          cleanupData?.();
          cleanupSessionId?.();
          cleanupExit?.();
          cleanupUsage?.();
        };

        cleanupData = window.maestro.process.onData((sid: string, data: string) => {
          if (sid === targetSessionId) {
            responseText += data;
          }
        });

        cleanupSessionId = window.maestro.process.onSessionId((sid: string, capturedId: string) => {
          if (sid === targetSessionId) {
            claudeSessionId = capturedId;
          }
        });

        // Capture usage stats for this synopsis request
        cleanupUsage = window.maestro.process.onUsage((sid: string, usageStats) => {
          if (sid === targetSessionId) {
            // Accumulate usage stats (there may be multiple events)
            if (!synopsisUsageStats) {
              synopsisUsageStats = { ...usageStats };
            } else {
              synopsisUsageStats = {
                ...usageStats,
                inputTokens: synopsisUsageStats.inputTokens + usageStats.inputTokens,
                outputTokens: synopsisUsageStats.outputTokens + usageStats.outputTokens,
                cacheReadInputTokens: synopsisUsageStats.cacheReadInputTokens + usageStats.cacheReadInputTokens,
                cacheCreationInputTokens: synopsisUsageStats.cacheCreationInputTokens + usageStats.cacheCreationInputTokens,
                totalCostUsd: synopsisUsageStats.totalCostUsd + usageStats.totalCostUsd,
              };
            }
          }
        });

        cleanupExit = window.maestro.process.onExit((sid: string) => {
          if (sid === targetSessionId) {
            cleanup();
            resolve({ success: true, response: responseText, claudeSessionId, usageStats: synopsisUsageStats });
          }
        });

        // Spawn with --resume to continue the old session
        const commandToUse = agent.path || agent.command;
        const spawnArgs = [...(agent.args || []), '--resume', resumeClaudeSessionId];
        window.maestro.process.spawn({
          sessionId: targetSessionId,
          toolType: 'claude-code',
          cwd,
          command: commandToUse,
          args: spawnArgs,
          prompt
        }).catch(() => {
          cleanup();
          resolve({ success: false });
        });
      });
    } catch (error) {
      console.error('Error spawning background synopsis:', error);
      return { success: false };
    }
  }, []);

  // Helper to show flash notification (auto-dismisses after 2 seconds)
  const showFlashNotification = useCallback((message: string) => {
    setFlashNotification(message);
    setTimeout(() => setFlashNotification(null), 2000);
  }, []);

  // Helper to show success flash notification (center screen, auto-dismisses after 2 seconds)
  const showSuccessFlash = useCallback((message: string) => {
    setSuccessFlashNotification(message);
    setTimeout(() => setSuccessFlashNotification(null), 2000);
  }, []);

  // Helper to add history entry
  // Note: usageStats should be passed explicitly for per-task tracking (e.g., batch runs)
  // Do NOT use cumulative session stats here - they represent lifetime totals, not per-entry metrics
  // IMPORTANT: For background operations (like synopsis), pass explicit sessionId/projectPath to avoid
  // cross-agent bleed when the user switches agents while the background task is running
  const addHistoryEntry = useCallback(async (entry: {
    type: 'AUTO' | 'USER';
    summary: string;
    fullResponse?: string;
    claudeSessionId?: string;
    usageStats?: UsageStats;
    // Optional overrides for background operations (prevents cross-agent bleed)
    sessionId?: string;
    projectPath?: string;
    sessionName?: string;
  }) => {
    // Use provided values or fall back to activeSession
    const targetSessionId = entry.sessionId || activeSession?.id;
    const targetProjectPath = entry.projectPath || activeSession?.cwd;

    if (!targetSessionId || !targetProjectPath) return;

    // Get session name from entry, or from active tab if using activeSession
    let sessionName = entry.sessionName;
    if (!sessionName && activeSession && !entry.sessionId) {
      const activeTab = getActiveTab(activeSession);
      sessionName = activeTab?.name;
    }

    await window.maestro.history.add({
      id: generateId(),
      type: entry.type,
      timestamp: Date.now(),
      summary: entry.summary,
      fullResponse: entry.fullResponse,
      claudeSessionId: entry.claudeSessionId,
      sessionId: targetSessionId,
      sessionName: sessionName,
      projectPath: targetProjectPath,
      contextUsage: activeSession?.contextUsage,
      // Only include usageStats if explicitly provided (per-task tracking)
      // Never use cumulative session stats - they're lifetime totals
      usageStats: entry.usageStats
    });

    // Refresh history panel to show the new entry
    rightPanelRef.current?.refreshHistoryPanel();
  }, [activeSession]);

  // Helper to start a new Claude session
  const startNewClaudeSession = useCallback(() => {
    if (!activeSession) return;

    // Block clearing when there are queued items
    if (activeSession.executionQueue.length > 0) {
      addLogToActiveTab(activeSession.id, {
        source: 'system',
        text: 'Cannot clear session while items are queued. Remove queued items first.'
      });
      return;
    }

    setSessions(prev => prev.map(s => {
      if (s.id !== activeSession.id) return s;
      // Reset active tab's state to 'idle' for write-mode tracking
      const updatedAiTabs = s.aiTabs?.length > 0
        ? s.aiTabs.map(tab =>
            tab.id === s.activeTabId ? { ...tab, state: 'idle' as const, thinkingStartTime: undefined } : tab
          )
        : s.aiTabs;
      return { ...s, claudeSessionId: undefined, aiLogs: [], state: 'idle' as SessionState, busySource: undefined, thinkingStartTime: undefined, aiTabs: updatedAiTabs };
    }));
    setActiveClaudeSessionId(null);
  }, [activeSession]);

  // Update refs for slash command functions (so remote command handler can access latest versions)
  spawnBackgroundSynopsisRef.current = spawnBackgroundSynopsis;
  addHistoryEntryRef.current = addHistoryEntry;
  spawnAgentWithPromptRef.current = spawnAgentWithPrompt;
  startNewClaudeSessionRef.current = startNewClaudeSession;

  // Initialize batch processor (supports parallel batches per session)
  const {
    batchRunStates,
    getBatchState,
    activeBatchSessionIds,
    startBatchRun,
    stopBatchRun,
  } = useBatchProcessor({
    sessions,
    groups,
    onUpdateSession: (sessionId, updates) => {
      setSessions(prev => prev.map(s =>
        s.id === sessionId ? { ...s, ...updates } : s
      ));
    },
    onSpawnAgent: spawnAgentForSession,
    onSpawnSynopsis: spawnBackgroundSynopsis,
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
          const updatedBadge = CONDUCTOR_BADGES.find(b =>
            b.thresholdMs <= updatedCumulativeTimeMs
          );
          const updatedBadgeLevel = updatedBadge?.level || 0;
          const updatedBadgeName = updatedBadge?.name || 'No Badge Yet';

          // Format longest run date
          let longestRunDate: string | undefined;
          if (isNewRecord) {
            longestRunDate = new Date().toISOString().split('T')[0];
          } else if (autoRunStats.longestRunTimestamp > 0) {
            longestRunDate = new Date(autoRunStats.longestRunTimestamp).toISOString().split('T')[0];
          }

          // Submit to leaderboard in background
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
    }
  });

  // Get batch state for the current session - used for locking the AutoRun editor
  // This is session-specific so users can edit docs in other sessions while one runs
  const currentSessionBatchState = activeSession ? getBatchState(activeSession.id) : null;

  // Get batch state for display - prioritize the session with an active batch run,
  // falling back to the active session's state. This ensures AutoRun progress is
  // displayed correctly regardless of which tab/session the user is viewing.
  const activeBatchRunState = activeBatchSessionIds.length > 0
    ? getBatchState(activeBatchSessionIds[0])
    : (activeSession ? getBatchState(activeSession.id) : getBatchState(''));

  // Initialize activity tracker for time tracking
  useActivityTracker(activeSessionId, setSessions);

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
      const deltaMs = now - autoRunProgressRef.current.lastUpdateTime;
      autoRunProgressRef.current.lastUpdateTime = now;

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

  // Handler to open batch runner modal
  const handleOpenBatchRunner = useCallback(() => {
    setBatchRunnerModalOpen(true);
  }, []);

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
    setAutoRunContent,
    setAutoRunIsLoadingDocuments,
    setAutoRunSetupModalOpen,
    setBatchRunnerModalOpen,
    setActiveRightTab,
    setRightPanelOpen,
    setActiveFocus,
    setSuccessFlashNotification,
    autoRunContent,
    autoRunDocumentList,
    startBatchRun,
  });

  // File tree auto-refresh interval change handler (kept in App.tsx as it's not Auto Run specific)
  const handleAutoRefreshChange = useCallback((interval: number) => {
    if (!activeSession) return;
    setSessions(prev => prev.map(s =>
      s.id === activeSession.id ? { ...s, fileTreeAutoRefreshInterval: interval } : s
    ));
  }, [activeSession]);

  // Handler to stop batch run (with confirmation)
  // Stops the first active batch run, or falls back to active session
  const handleStopBatchRun = useCallback(() => {
    // Use the first session with an active batch run, or fall back to active session
    const sessionId = activeBatchSessionIds.length > 0
      ? activeBatchSessionIds[0]
      : activeSession?.id;
    if (!sessionId) return;
    setConfirmModalMessage('Stop Auto Run after the current task completes?');
    setConfirmModalOnConfirm(() => () => stopBatchRun(sessionId));
    setConfirmModalOpen(true);
  }, [activeBatchSessionIds, activeSession, stopBatchRun]);

  // Handler to jump to a Claude session from history
  const handleJumpToClaudeSession = useCallback((claudeSessionId: string) => {
    // Set the Claude session ID and load its messages
    if (activeSession) {
      setActiveClaudeSessionId(claudeSessionId);
      // Open the agent sessions browser to show the selected session
      setAgentSessionsOpen(true);
    }
  }, [activeSession]);

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

  // Handler to resume a Claude session - opens as a new tab (or switches to existing tab)
  const handleResumeSession = useCallback(async (
    claudeSessionId: string,
    providedMessages?: LogEntry[],
    sessionName?: string,
    starred?: boolean
  ) => {
    if (!activeSession?.cwd) return;

    // Check if a tab with this claudeSessionId already exists
    const existingTab = activeSession.aiTabs?.find(tab => tab.claudeSessionId === claudeSessionId);
    if (existingTab) {
      // Switch to the existing tab instead of creating a duplicate
      setSessions(prev => prev.map(s =>
        s.id === activeSession.id
          ? { ...s, activeTabId: existingTab.id, inputMode: 'ai' }
          : s
      ));
      setActiveClaudeSessionId(claudeSessionId);
      return;
    }

    try {
      // Use provided messages or fetch them
      let messages: LogEntry[];
      if (providedMessages && providedMessages.length > 0) {
        messages = providedMessages;
      } else {
        // Load the session messages
        const result = await window.maestro.claude.readSessionMessages(
          activeSession.cwd,
          claudeSessionId,
          { offset: 0, limit: 100 }
        );

        // Convert to log entries
        messages = result.messages.map((msg: { type: string; content: string; timestamp: string; uuid: string }) => ({
          id: msg.uuid || generateId(),
          timestamp: new Date(msg.timestamp).getTime(),
          source: msg.type === 'user' ? 'user' as const : 'stdout' as const,
          text: msg.content || ''
        }));
      }

      // Look up starred status and session name from stores if not provided
      let isStarred = starred ?? false;
      let name = sessionName ?? null;

      if (!starred && !sessionName) {
        try {
          // Look up session metadata from Claude session origins (name and starred)
          const origins = await window.maestro.claude.getSessionOrigins(activeSession.cwd);
          const originData = origins[claudeSessionId];
          if (originData && typeof originData === 'object') {
            if (originData.sessionName) {
              name = originData.sessionName;
            }
            if (originData.starred !== undefined) {
              isStarred = originData.starred;
            }
          }
        } catch (error) {
          console.warn('[handleResumeSession] Failed to lookup starred/named status:', error);
        }
      }

      // Update the session and switch to AI mode
      // IMPORTANT: Use functional update to get fresh session state and avoid race conditions
      setSessions(prev => prev.map(s => {
        if (s.id !== activeSession.id) return s;

        // Create tab from the CURRENT session state (not stale closure value)
        const { session: updatedSession } = createTab(s, {
          claudeSessionId,
          logs: messages,
          name,
          starred: isStarred,
          saveToHistory: defaultSaveToHistory
        });

        return { ...updatedSession, inputMode: 'ai' };
      }));
      setActiveClaudeSessionId(claudeSessionId);
    } catch (error) {
      console.error('Failed to resume session:', error);
    }
  }, [activeSession?.cwd, activeSession?.id, activeSession?.aiTabs]);

  // Handler to open lightbox with optional context images for navigation
  const handleSetLightboxImage = useCallback((image: string | null, contextImages?: string[]) => {
    setLightboxImage(image);
    setLightboxImages(contextImages || []);
  }, []);

  // Create sorted sessions array that matches visual display order (includes ALL sessions)
  // Note: sorting ignores leading emojis for proper alphabetization
  const sortedSessions = useMemo(() => {
    const sorted: Session[] = [];

    // First, add sessions from sorted groups (ignoring leading emojis)
    const sortedGroups = [...groups].sort((a, b) => compareNamesIgnoringEmojis(a.name, b.name));
    sortedGroups.forEach(group => {
      const groupSessions = sessions
        .filter(s => s.groupId === group.id)
        .sort((a, b) => compareNamesIgnoringEmojis(a.name, b.name));
      sorted.push(...groupSessions);
    });

    // Then, add ungrouped sessions (sorted alphabetically, ignoring leading emojis)
    const ungroupedSessions = sessions
      .filter(s => !s.groupId)
      .sort((a, b) => compareNamesIgnoringEmojis(a.name, b.name));
    sorted.push(...ungroupedSessions);

    return sorted;
  }, [sessions, groups]);

  // Create visible sessions array for session jump shortcuts (Opt+Cmd+NUMBER)
  // Order: Bookmarked sessions first (if bookmarks folder expanded), then groups/ungrouped
  // Note: A session can appear twice if it's both bookmarked and in an expanded group
  const visibleSessions = useMemo(() => {
    const result: Session[] = [];

    // Add bookmarked sessions first (if bookmarks folder is expanded)
    if (!bookmarksCollapsed) {
      const bookmarkedSessions = sessions
        .filter(s => s.bookmarked)
        .sort((a, b) => compareNamesIgnoringEmojis(a.name, b.name));
      result.push(...bookmarkedSessions);
    }

    // Add sessions from expanded groups and ungrouped sessions
    const groupAndUngrouped = sortedSessions.filter(session => {
      if (!session.groupId) return true; // Ungrouped sessions always visible
      const group = groups.find(g => g.id === session.groupId);
      return group && !group.collapsed; // Only show if group is expanded
    });
    result.push(...groupAndUngrouped);

    return result;
  }, [sortedSessions, groups, sessions, bookmarksCollapsed]);

  // Persist sessions and groups to electron-store (only after initial load)
  useEffect(() => {
    if (initialLoadComplete.current) {
      window.maestro.sessions.setAll(sessions);
    }
  }, [sessions]);

  useEffect(() => {
    if (initialLoadComplete.current) {
      window.maestro.groups.setAll(groups);
    }
  }, [groups]);

  // Set CSS variables for theme colors (for scrollbar styling)
  useEffect(() => {
    document.documentElement.style.setProperty('--accent-color', theme.colors.accent);
    document.documentElement.style.setProperty('--highlight-color', theme.colors.accent);
  }, [theme.colors.accent]);

  // Add scroll listeners to highlight scrollbars during active scrolling
  useEffect(() => {
    const scrollTimeouts = new Map<Element, NodeJS.Timeout>();
    const fadeTimeouts = new Map<Element, NodeJS.Timeout>();

    const handleScroll = (e: Event) => {
      const target = e.target as Element;
      if (!target.classList.contains('scrollbar-thin')) return;

      // Cancel any pending fade completion
      const existingFadeTimeout = fadeTimeouts.get(target);
      if (existingFadeTimeout) {
        clearTimeout(existingFadeTimeout);
        fadeTimeouts.delete(target);
      }

      // Add scrolling class, remove fading if present
      target.classList.remove('fading');
      target.classList.add('scrolling');

      // Clear existing timeout for this element
      const existingTimeout = scrollTimeouts.get(target);
      if (existingTimeout) {
        clearTimeout(existingTimeout);
      }

      // Start fade-out after 1 second of no scrolling
      const timeout = setTimeout(() => {
        // Add fading class to trigger CSS transition
        target.classList.add('fading');
        target.classList.remove('scrolling');
        scrollTimeouts.delete(target);

        // Remove fading class after transition completes (500ms)
        const fadeTimeout = setTimeout(() => {
          target.classList.remove('fading');
          fadeTimeouts.delete(target);
        }, 500);
        fadeTimeouts.set(target, fadeTimeout);
      }, 1000);

      scrollTimeouts.set(target, timeout);
    };

    // Add listener to capture scroll events
    document.addEventListener('scroll', handleScroll, true);

    return () => {
      document.removeEventListener('scroll', handleScroll, true);
      scrollTimeouts.forEach(timeout => clearTimeout(timeout));
      scrollTimeouts.clear();
      fadeTimeouts.forEach(timeout => clearTimeout(timeout));
      fadeTimeouts.clear();
    };
  }, []);

  // --- KEYBOARD MANAGEMENT ---
  const isShortcut = (e: KeyboardEvent, actionId: string) => {
    const sc = shortcuts[actionId];
    if (!sc) return false;
    const keys = sc.keys.map(k => k.toLowerCase());

    const metaPressed = e.metaKey || e.ctrlKey;
    const shiftPressed = e.shiftKey;
    const altPressed = e.altKey;
    const key = e.key.toLowerCase();

    const configMeta = keys.includes('meta') || keys.includes('ctrl') || keys.includes('command');
    const configShift = keys.includes('shift');
    const configAlt = keys.includes('alt');

    if (metaPressed !== configMeta) return false;
    if (shiftPressed !== configShift) return false;
    if (altPressed !== configAlt) return false;

    const mainKey = keys[keys.length - 1];
    if (mainKey === '/' && key === '/') return true;
    if (mainKey === 'arrowleft' && key === 'arrowleft') return true;
    if (mainKey === 'arrowright' && key === 'arrowright') return true;
    if (mainKey === 'arrowup' && key === 'arrowup') return true;
    if (mainKey === 'arrowdown' && key === 'arrowdown') return true;
    if (mainKey === 'backspace' && key === 'backspace') return true;
    // Handle Shift+[ producing { and Shift+] producing }
    if (mainKey === '[' && (key === '[' || key === '{')) return true;
    if (mainKey === ']' && (key === ']' || key === '}')) return true;
    // Handle Shift+number producing symbol (US keyboard layout)
    // Shift+1='!', Shift+2='@', Shift+3='#', etc.
    const shiftNumberMap: Record<string, string> = {
      '!': '1', '@': '2', '#': '3', '$': '4', '%': '5',
      '^': '6', '&': '7', '*': '8', '(': '9', ')': '0'
    };
    if (shiftNumberMap[key] === mainKey) return true;

    // For Alt+Meta shortcuts on macOS, e.key produces special characters (e.g., Alt+p = π, Alt+l = ¬)
    // Use e.code to get the physical key pressed instead
    if (altPressed && e.code) {
      const codeKey = e.code.replace('Key', '').toLowerCase();
      return codeKey === mainKey;
    }

    return key === mainKey;
  };

  // Check if a key event matches a tab shortcut (AI mode only)
  // Checks both TAB_SHORTCUTS and editable shortcuts (for prevTab/nextTab)
  const isTabShortcut = (e: KeyboardEvent, actionId: string) => {
    const sc = TAB_SHORTCUTS[actionId] || shortcuts[actionId];
    if (!sc) return false;
    const keys = sc.keys.map(k => k.toLowerCase());

    const metaPressed = e.metaKey || e.ctrlKey;
    const shiftPressed = e.shiftKey;
    const altPressed = e.altKey;
    const key = e.key.toLowerCase();

    const configMeta = keys.includes('meta') || keys.includes('ctrl') || keys.includes('command');
    const configShift = keys.includes('shift');
    const configAlt = keys.includes('alt');

    if (metaPressed !== configMeta) return false;
    if (shiftPressed !== configShift) return false;
    if (altPressed !== configAlt) return false;

    const mainKey = keys[keys.length - 1];
    // Handle Shift+[ producing { and Shift+] producing }
    if (mainKey === '[' && (key === '[' || key === '{')) return true;
    if (mainKey === ']' && (key === ']' || key === '}')) return true;

    // For Alt+Meta shortcuts on macOS, e.key produces special characters (e.g., Alt+t = †)
    // Use e.code to get the physical key pressed instead
    if (altPressed && e.code) {
      const codeKey = e.code.replace('Key', '').toLowerCase();
      return codeKey === mainKey;
    }

    return key === mainKey;
  };

  // Ref to hold all keyboard handler dependencies - avoids re-attaching listener on every state change
  // This is a critical performance optimization: the keyboard handler was being removed and re-added
  // on every state change due to 51+ dependencies, causing memory leaks and event listener bloat
  // NOTE: Initialize with null - the actual value is set synchronously below during render.
  // This avoids referencing functions like addNewSession before they're defined.
  const keyboardHandlerRef = useRef<any>(null);
  // NOTE: keyboardHandlerRef.current is assigned later in the file (after all handler functions are defined)
  // to avoid "Cannot access before initialization" errors with functions like addNewSession

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Block browser refresh (Cmd+R / Ctrl+R / Cmd+Shift+R / Ctrl+Shift+R) globally
      // We override these shortcuts for other purposes, but even in views where that
      // doesn't apply (e.g., file preview), we never want the app to refresh
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'r') {
        e.preventDefault();
      }

      // Read all values from ref - this allows the handler to stay attached while still
      // accessing current state values
      const ctx = keyboardHandlerRef.current;

      // When layers (modals/overlays) are open, we need nuanced shortcut handling:
      // - Escape: handled by LayerStackContext in capture phase
      // - Tab: allowed for accessibility navigation
      // - Cmd+Shift+[/]: depends on layer type (modal vs overlay)
      //
      // TRUE MODALS (Settings, QuickActions, etc.): Block ALL shortcuts except Tab
      //   - These modals have their own internal handlers for Cmd+Shift+[]
      //
      // OVERLAYS (FilePreview, LogViewer): Allow Cmd+Shift+[] for tab cycling
      //   - App.tsx handles this with modified behavior (cycle tabs not sessions)

      if (ctx.hasOpenLayers()) {
        // Allow Tab for accessibility navigation within modals
        if (e.key === 'Tab') return;

        const isCycleShortcut = (e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === '[' || e.key === ']');
        // Allow sidebar toggle shortcuts (Alt+Cmd+Arrow) even when modals are open
        const isLayoutShortcut = e.altKey && (e.metaKey || e.ctrlKey) && (e.key === 'ArrowLeft' || e.key === 'ArrowRight');
        // Allow right panel tab shortcuts (Cmd+Shift+F/H/S) even when overlays are open
        const keyLower = e.key.toLowerCase();
        const isRightPanelShortcut = (e.metaKey || e.ctrlKey) && e.shiftKey && (keyLower === 'f' || keyLower === 'h' || keyLower === 's');
        // Allow jumpToBottom (Cmd+Shift+J) from anywhere - always scroll main panel to bottom
        const isJumpToBottomShortcut = (e.metaKey || e.ctrlKey) && e.shiftKey && keyLower === 'j';
        // Allow system utility shortcuts (Alt+Cmd+L for logs, Alt+Cmd+P for processes) even when modals are open
        // NOTE: Must use e.code for Alt key combos on macOS because e.key produces special characters (e.g., Alt+P = π)
        const codeKeyLower = e.code?.replace('Key', '').toLowerCase() || '';
        const isSystemUtilShortcut = e.altKey && (e.metaKey || e.ctrlKey) && (codeKeyLower === 'l' || codeKeyLower === 'p');
        // Allow session jump shortcuts (Alt+Cmd+NUMBER) even when modals are open
        // NOTE: Must use e.code for Alt key combos on macOS because e.key produces special characters
        const isSessionJumpShortcut = e.altKey && (e.metaKey || e.ctrlKey) && /^Digit[0-9]$/.test(e.code || '');

        if (ctx.hasOpenModal()) {
          // TRUE MODAL is open - block most shortcuts from App.tsx
          // The modal's own handler will handle Cmd+Shift+[] if it supports it
          // BUT allow layout shortcuts (sidebar toggles), system utility shortcuts, session jump, and jumpToBottom to work
          if (!isLayoutShortcut && !isSystemUtilShortcut && !isSessionJumpShortcut && !isJumpToBottomShortcut) {
            return;
          }
          // Fall through to handle layout/system utility/session jump/jumpToBottom shortcuts below
        } else {
          // Only OVERLAYS are open (FilePreview, LogViewer, etc.)
          // Allow Cmd+Shift+[] to fall through to App.tsx handler
          // (which will cycle right panel tabs when previewFile is set)
          // Also allow right panel tab shortcuts to switch tabs while overlay is open
          if (!isCycleShortcut && !isLayoutShortcut && !isRightPanelShortcut && !isSystemUtilShortcut && !isSessionJumpShortcut && !isJumpToBottomShortcut) {
            return;
          }
          // Fall through to cyclePrev/cycleNext logic below
        }
      }

      // Skip all keyboard handling when editing a session or group name in the sidebar
      if (ctx.editingSessionId || ctx.editingGroupId) {
        return;
      }

      // Sidebar navigation with arrow keys (works when sidebar has focus)
      // Skip if Alt+Cmd+Arrow is pressed - that's the sidebar/panel toggle shortcut
      const isToggleLayoutShortcut = e.altKey && (e.metaKey || e.ctrlKey) && (e.key === 'ArrowLeft' || e.key === 'ArrowRight');
      if (ctx.activeFocus === 'sidebar' && !isToggleLayoutShortcut && (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === ' ')) {
        e.preventDefault();
        if (ctx.sortedSessions.length === 0) return;

        // Get the currently selected session
        const currentSession = ctx.sortedSessions[ctx.selectedSidebarIndex];

        // ArrowLeft: Collapse the current group or bookmarks section
        if (e.key === 'ArrowLeft' && currentSession) {
          // Check if session is bookmarked and bookmarks section is expanded
          if (currentSession.bookmarked && !ctx.bookmarksCollapsed) {
            // Collapse bookmarks section
            ctx.setBookmarksCollapsed(true);
            return;
          }

          // Check if session is in a group
          if (currentSession.groupId) {
            const currentGroup = ctx.groups.find(g => g.id === currentSession.groupId);
            if (currentGroup && !currentGroup.collapsed) {
              // Collapse the group
              ctx.setGroups(prev => prev.map(g =>
                g.id === currentGroup.id ? { ...g, collapsed: true } : g
              ));
              return;
            }
          }
          return;
        }

        // ArrowRight: Expand the current group or bookmarks section (if collapsed)
        if (e.key === 'ArrowRight' && currentSession) {
          // Check if session is bookmarked and bookmarks section is collapsed
          if (currentSession.bookmarked && ctx.bookmarksCollapsed) {
            // Expand bookmarks section
            ctx.setBookmarksCollapsed(false);
            return;
          }

          // Check if session is in a collapsed group
          if (currentSession.groupId) {
            const currentGroup = ctx.groups.find(g => g.id === currentSession.groupId);
            if (currentGroup && currentGroup.collapsed) {
              // Expand the group
              ctx.setGroups(prev => prev.map(g =>
                g.id === currentGroup.id ? { ...g, collapsed: false } : g
              ));
              return;
            }
          }
          return;
        }

        // Space: Close the current group and jump to nearest visible session
        if (e.key === ' ' && currentSession?.groupId) {
          const currentGroup = ctx.groups.find(g => g.id === currentSession.groupId);
          if (currentGroup && !currentGroup.collapsed) {
            // Collapse the group
            ctx.setGroups(prev => prev.map(g =>
              g.id === currentGroup.id ? { ...g, collapsed: true } : g
            ));

            // Helper to check if a session will be visible after collapse
            const willBeVisible = (s: Session) => {
              if (s.groupId === currentGroup.id) return false; // In the group being collapsed
              if (!s.groupId) return true; // Ungrouped sessions are always visible
              const g = ctx.groups.find(grp => grp.id === s.groupId);
              return g && !g.collapsed; // In an expanded group
            };

            // Find current position in sortedSessions
            const currentIndex = ctx.sortedSessions.findIndex(s => s.id === currentSession.id);

            // First, look BELOW (after) the current position
            let nextVisible: Session | undefined;
            for (let i = currentIndex + 1; i < ctx.sortedSessions.length; i++) {
              if (willBeVisible(ctx.sortedSessions[i])) {
                nextVisible = ctx.sortedSessions[i];
                break;
              }
            }

            // If nothing below, look ABOVE (before) the current position
            if (!nextVisible) {
              for (let i = currentIndex - 1; i >= 0; i--) {
                if (willBeVisible(ctx.sortedSessions[i])) {
                  nextVisible = ctx.sortedSessions[i];
                  break;
                }
              }
            }

            if (nextVisible) {
              const newIndex = ctx.sortedSessions.findIndex(s => s.id === nextVisible!.id);
              ctx.setSelectedSidebarIndex(newIndex);
              ctx.setActiveSessionId(nextVisible.id);
            }
            return;
          }
        }

        // ArrowUp/ArrowDown: Navigate through sessions, expanding collapsed groups as needed
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          const currentIndex = ctx.selectedSidebarIndex;
          const totalSessions = ctx.sortedSessions.length;

          // Helper to check if a session is in a collapsed group
          const isInCollapsedGroup = (session: Session) => {
            if (!session.groupId) return false;
            const group = ctx.groups.find(g => g.id === session.groupId);
            return group?.collapsed ?? false;
          };

          // Helper to get all sessions in a group
          const getGroupSessions = (groupId: string) => {
            return ctx.sortedSessions.filter(s => s.groupId === groupId);
          };

          // Find the next session, skipping visible sessions in collapsed groups
          // but stopping when we hit a NEW collapsed group (to expand it)
          let nextIndex = currentIndex;
          let foundCollapsedGroup: string | null = null;

          if (e.key === 'ArrowDown') {
            // Moving down
            for (let i = 1; i <= totalSessions; i++) {
              const candidateIndex = (currentIndex + i) % totalSessions;
              const candidate = ctx.sortedSessions[candidateIndex];

              if (!candidate.groupId) {
                // Ungrouped session - can navigate to it
                nextIndex = candidateIndex;
                break;
              }

              const candidateGroup = ctx.groups.find(g => g.id === candidate.groupId);
              if (!candidateGroup?.collapsed) {
                // Session in expanded group - can navigate to it
                nextIndex = candidateIndex;
                break;
              }

              // Session is in a collapsed group
              // Check if this is a different group than we're currently in
              if (candidate.groupId !== currentSession?.groupId) {
                // We've hit a collapsed group - expand it and go to FIRST item
                foundCollapsedGroup = candidate.groupId;
                const groupSessions = getGroupSessions(candidate.groupId);
                nextIndex = ctx.sortedSessions.findIndex(s => s.id === groupSessions[0]?.id);
                break;
              }
              // Same collapsed group, keep looking (shouldn't happen if current is visible)
            }
          } else {
            // Moving up
            for (let i = 1; i <= totalSessions; i++) {
              const candidateIndex = (currentIndex - i + totalSessions) % totalSessions;
              const candidate = ctx.sortedSessions[candidateIndex];

              if (!candidate.groupId) {
                // Ungrouped session - can navigate to it
                nextIndex = candidateIndex;
                break;
              }

              const candidateGroup = ctx.groups.find(g => g.id === candidate.groupId);
              if (!candidateGroup?.collapsed) {
                // Session in expanded group - can navigate to it
                nextIndex = candidateIndex;
                break;
              }

              // Session is in a collapsed group
              // Check if this is a different group than we're currently in
              if (candidate.groupId !== currentSession?.groupId) {
                // We've hit a collapsed group - expand it and go to LAST item
                foundCollapsedGroup = candidate.groupId;
                const groupSessions = getGroupSessions(candidate.groupId);
                nextIndex = ctx.sortedSessions.findIndex(s => s.id === groupSessions[groupSessions.length - 1]?.id);
                break;
              }
              // Same collapsed group, keep looking
            }
          }

          // If we found a collapsed group, expand it
          if (foundCollapsedGroup) {
            ctx.setGroups(prev => prev.map(g =>
              g.id === foundCollapsedGroup ? { ...g, collapsed: false } : g
            ));
          }

          ctx.setSelectedSidebarIndex(nextIndex);
        }
        return;
      }

      // Enter to load selected session from sidebar
      if (ctx.activeFocus === 'sidebar' && e.key === 'Enter') {
        e.preventDefault();
        if (ctx.sortedSessions[ctx.selectedSidebarIndex]) {
          ctx.setActiveSessionId(ctx.sortedSessions[ctx.selectedSidebarIndex].id);
        }
        return;
      }

      // Tab navigation between panels (disabled when input is focused for tab completion)
      if (e.key === 'Tab') {
        // Skip global Tab handling when input is focused - let handleInputKeyDown handle it
        if (document.activeElement === ctx.inputRef.current) {
          return;
        }
        e.preventDefault();
        if (ctx.activeFocus === 'sidebar' && !e.shiftKey) {
          // Tab from sidebar goes to main input
          ctx.setActiveFocus('main');
          setTimeout(() => ctx.inputRef.current?.focus(), 0);
          return;
        }
        const order: FocusArea[] = ['sidebar', 'main', 'right'];
        const currentIdx = order.indexOf(ctx.activeFocus);
        if (e.shiftKey) {
           const next = currentIdx === 0 ? order.length - 1 : currentIdx - 1;
           ctx.setActiveFocus(order[next]);
        } else {
           const next = currentIdx === order.length - 1 ? 0 : currentIdx + 1;
           ctx.setActiveFocus(order[next]);
        }
        return;
      }

      // Escape in main area focuses terminal output
      if (ctx.activeFocus === 'main' && e.key === 'Escape' && document.activeElement === ctx.inputRef.current) {
        e.preventDefault();
        ctx.inputRef.current?.blur();
        ctx.terminalOutputRef.current?.focus();
        return;
      }


      // General shortcuts
      // Only allow collapsing left sidebar when there are sessions (prevent collapse on empty state)
      if (ctx.isShortcut(e, 'toggleSidebar')) {
        if (ctx.sessions.length > 0 || !ctx.leftSidebarOpen) {
          ctx.setLeftSidebarOpen(p => !p);
        }
      }
      else if (ctx.isShortcut(e, 'toggleRightPanel')) ctx.setRightPanelOpen(p => !p);
      else if (ctx.isShortcut(e, 'newInstance')) ctx.addNewSession();
      else if (ctx.isShortcut(e, 'killInstance')) ctx.deleteSession(ctx.activeSessionId);
      else if (ctx.isShortcut(e, 'moveToGroup')) {
        if (ctx.activeSession) {
          ctx.setQuickActionInitialMode('move-to-group');
          ctx.setQuickActionOpen(true);
        }
      }
      else if (ctx.isShortcut(e, 'cyclePrev')) {
        // Cycle to previous Maestro session (global shortcut)
        ctx.cycleSession('prev');
      }
      else if (ctx.isShortcut(e, 'cycleNext')) {
        // Cycle to next Maestro session (global shortcut)
        ctx.cycleSession('next');
      }
      else if (ctx.isShortcut(e, 'navBack')) {
        // Navigate back in history (through sessions and tabs)
        e.preventDefault();
        ctx.handleNavBack();
      }
      else if (ctx.isShortcut(e, 'navForward')) {
        // Navigate forward in history (through sessions and tabs)
        e.preventDefault();
        ctx.handleNavForward();
      }
      else if (ctx.isShortcut(e, 'toggleMode')) ctx.toggleInputMode();
      else if (ctx.isShortcut(e, 'quickAction')) {
        // Only open quick actions if there are agents
        if (ctx.sessions.length > 0) {
          ctx.setQuickActionInitialMode('main');
          ctx.setQuickActionOpen(true);
        }
      }
      else if (ctx.isShortcut(e, 'help')) ctx.setShortcutsHelpOpen(true);
      else if (ctx.isShortcut(e, 'settings')) { ctx.setSettingsModalOpen(true); ctx.setSettingsTab('general'); }
      else if (ctx.isShortcut(e, 'goToFiles')) { e.preventDefault(); ctx.setRightPanelOpen(true); ctx.handleSetActiveRightTab('files'); ctx.setActiveFocus('right'); }
      else if (ctx.isShortcut(e, 'goToHistory')) { e.preventDefault(); ctx.setRightPanelOpen(true); ctx.handleSetActiveRightTab('history'); ctx.setActiveFocus('right'); }
      else if (ctx.isShortcut(e, 'goToAutoRun')) { e.preventDefault(); ctx.setRightPanelOpen(true); ctx.handleSetActiveRightTab('autorun'); ctx.setActiveFocus('right'); }
      else if (ctx.isShortcut(e, 'openImageCarousel')) {
        e.preventDefault();
        if (ctx.stagedImages.length > 0) {
          ctx.handleSetLightboxImage(ctx.stagedImages[0], ctx.stagedImages);
        }
      }
      else if (ctx.isShortcut(e, 'toggleTabStar')) {
        e.preventDefault();
        ctx.toggleTabStar();
      }
      else if (ctx.isShortcut(e, 'openPromptComposer')) {
        e.preventDefault();
        // Only open in AI mode
        if (ctx.activeSession?.inputMode === 'ai') {
          ctx.setPromptComposerOpen(true);
        }
      }
      else if (ctx.isShortcut(e, 'openWizard')) {
        e.preventDefault();
        ctx.openWizardModal();
      }
      else if (ctx.isShortcut(e, 'focusInput')) {
        e.preventDefault();
        ctx.setActiveFocus('main');
        setTimeout(() => ctx.inputRef.current?.focus(), 0);
      }
      else if (ctx.isShortcut(e, 'focusSidebar')) {
        e.preventDefault();
        // Expand sidebar if collapsed
        if (!ctx.leftSidebarOpen) {
          ctx.setLeftSidebarOpen(true);
        }
        // Focus the sidebar
        ctx.setActiveFocus('sidebar');
      }
      else if (ctx.isShortcut(e, 'viewGitDiff')) {
        e.preventDefault();
        ctx.handleViewGitDiff();
      }
      else if (ctx.isShortcut(e, 'viewGitLog')) {
        e.preventDefault();
        if (ctx.activeSession?.isGitRepo) {
          ctx.setGitLogOpen(true);
        }
      }
      else if (ctx.isShortcut(e, 'agentSessions')) {
        e.preventDefault();
        if (ctx.activeSession?.toolType === 'claude-code') {
          ctx.setActiveClaudeSessionId(null);
          ctx.setAgentSessionsOpen(true);
        }
      }
      else if (ctx.isShortcut(e, 'systemLogs')) {
        e.preventDefault();
        ctx.setLogViewerOpen(true);
      }
      else if (ctx.isShortcut(e, 'processMonitor')) {
        e.preventDefault();
        ctx.setProcessMonitorOpen(true);
      }
      else if (ctx.isShortcut(e, 'jumpToBottom')) {
        e.preventDefault();
        // Jump to the bottom of the current main panel output (AI logs or terminal output)
        ctx.logsEndRef.current?.scrollIntoView({ behavior: 'instant' });
      }
      else if (ctx.isShortcut(e, 'toggleMarkdownMode')) {
        // Toggle markdown raw mode for AI message history
        // Skip when in AutoRun panel (it has its own Cmd+E handler for edit/preview toggle)
        // Skip when FilePreview is open (it handles its own Cmd+E)
        const isInAutoRunPanel = ctx.activeFocus === 'right' && ctx.activeRightTab === 'autorun';
        if (!isInAutoRunPanel && !ctx.previewFile) {
          e.preventDefault();
          ctx.setMarkdownEditMode(!ctx.markdownEditMode);
        }
      }

      // Opt+Cmd+NUMBER: Jump to visible session by number (1-9, 0=10th)
      // Use e.code instead of e.key because Option key on macOS produces special characters
      const digitMatch = e.code?.match(/^Digit([0-9])$/);
      if (e.altKey && (e.metaKey || e.ctrlKey) && digitMatch) {
        e.preventDefault();
        const digit = digitMatch[1];
        const num = digit === '0' ? 10 : parseInt(digit, 10);
        const targetIndex = num - 1;
        if (targetIndex >= 0 && targetIndex < ctx.visibleSessions.length) {
          const targetSession = ctx.visibleSessions[targetIndex];
          ctx.setActiveSessionId(targetSession.id);
          // Also expand sidebar if collapsed
          if (!ctx.leftSidebarOpen) {
            ctx.setLeftSidebarOpen(true);
          }
        }
      }

      // Tab shortcuts (AI mode only, requires an explicitly selected session)
      if (ctx.activeSessionId && ctx.activeSession?.inputMode === 'ai' && ctx.activeSession?.aiTabs) {
        if (ctx.isTabShortcut(e, 'tabSwitcher')) {
          e.preventDefault();
          ctx.setTabSwitcherOpen(true);
        }
        if (ctx.isTabShortcut(e, 'newTab')) {
          e.preventDefault();
          const result = ctx.createTab(ctx.activeSession, { saveToHistory: ctx.defaultSaveToHistory });
          ctx.setSessions(prev => prev.map(s =>
            s.id === ctx.activeSession!.id ? result.session : s
          ));
          // Auto-focus the input so user can start typing immediately
          ctx.setActiveFocus('main');
          setTimeout(() => ctx.inputRef.current?.focus(), 50);
        }
        if (ctx.isTabShortcut(e, 'closeTab')) {
          e.preventDefault();
          // Only close if there's more than one tab (closeTab returns null otherwise)
          const result = ctx.closeTab(ctx.activeSession, ctx.activeSession.activeTabId);
          if (result) {
            ctx.setSessions(prev => prev.map(s =>
              s.id === ctx.activeSession!.id ? result.session : s
            ));
          }
        }
        if (ctx.isTabShortcut(e, 'reopenClosedTab')) {
          e.preventDefault();
          // Reopen the most recently closed tab, or switch to existing if duplicate
          const result = ctx.reopenClosedTab(ctx.activeSession);
          if (result) {
            ctx.setSessions(prev => prev.map(s =>
              s.id === ctx.activeSession!.id ? result.session : s
            ));
          }
        }
        if (ctx.isTabShortcut(e, 'renameTab')) {
          e.preventDefault();
          const activeTab = ctx.getActiveTab(ctx.activeSession);
          // Only allow rename if tab has an active Claude session
          if (activeTab?.claudeSessionId) {
            ctx.setRenameTabId(activeTab.id);
            ctx.setRenameTabInitialName(activeTab.name || '');
            ctx.setRenameTabModalOpen(true);
          }
        }
        if (ctx.isTabShortcut(e, 'toggleReadOnlyMode')) {
          e.preventDefault();
          ctx.setSessions(prev => prev.map(s => {
            if (s.id !== ctx.activeSession!.id) return s;
            return {
              ...s,
              aiTabs: s.aiTabs.map(tab =>
                tab.id === s.activeTabId ? { ...tab, readOnlyMode: !tab.readOnlyMode } : tab
              )
            };
          }));
        }
        if (ctx.isTabShortcut(e, 'toggleSaveToHistory')) {
          e.preventDefault();
          ctx.setSessions(prev => prev.map(s => {
            if (s.id !== ctx.activeSession!.id) return s;
            return {
              ...s,
              aiTabs: s.aiTabs.map(tab =>
                tab.id === s.activeTabId ? { ...tab, saveToHistory: !tab.saveToHistory } : tab
              )
            };
          }));
        }
        if (ctx.isTabShortcut(e, 'filterUnreadTabs')) {
          e.preventDefault();
          ctx.toggleUnreadFilter();
        }
        if (ctx.isTabShortcut(e, 'nextTab')) {
          e.preventDefault();
          const result = ctx.navigateToNextTab(ctx.activeSession, ctx.showUnreadOnly);
          if (result) {
            ctx.setSessions(prev => prev.map(s =>
              s.id === ctx.activeSession!.id ? result.session : s
            ));
          }
        }
        if (ctx.isTabShortcut(e, 'prevTab')) {
          e.preventDefault();
          const result = ctx.navigateToPrevTab(ctx.activeSession, ctx.showUnreadOnly);
          if (result) {
            ctx.setSessions(prev => prev.map(s =>
              s.id === ctx.activeSession!.id ? result.session : s
            ));
          }
        }
        // Cmd+1 through Cmd+9: Jump to specific tab by index (disabled in unread-only mode)
        if (!ctx.showUnreadOnly) {
          for (let i = 1; i <= 9; i++) {
            if (ctx.isTabShortcut(e, `goToTab${i}`)) {
              e.preventDefault();
              const result = ctx.navigateToTabByIndex(ctx.activeSession, i - 1);
              if (result) {
                ctx.setSessions(prev => prev.map(s =>
                  s.id === ctx.activeSession!.id ? result.session : s
                ));
              }
              break;
            }
          }
          // Cmd+0: Jump to last tab
          if (ctx.isTabShortcut(e, 'goToLastTab')) {
            e.preventDefault();
            const result = ctx.navigateToLastTab(ctx.activeSession);
            if (result) {
              ctx.setSessions(prev => prev.map(s =>
                s.id === ctx.activeSession!.id ? result.session : s
              ));
            }
          }
        }
      }

      // Cmd+F to open file tree filter when file tree has focus
      if (e.key === 'f' && (e.metaKey || e.ctrlKey) && ctx.activeFocus === 'right' && ctx.activeRightTab === 'files') {
        e.preventDefault();
        ctx.setFileTreeFilterOpen(true);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []); // Empty dependencies - handler reads from ref

  // Track Opt+Cmd modifier keys to show session jump number badges
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Show number badges when Opt+Cmd is held (but no number pressed yet)
      if (e.altKey && (e.metaKey || e.ctrlKey) && !showSessionJumpNumbers) {
        setShowSessionJumpNumbers(true);
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      // Hide number badges when either modifier is released
      if (!e.altKey || (!e.metaKey && !e.ctrlKey)) {
        setShowSessionJumpNumbers(false);
      }
    };

    // Also hide when window loses focus
    const handleBlur = () => {
      setShowSessionJumpNumbers(false);
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
    };
  }, [showSessionJumpNumbers]);

  // Sync selectedSidebarIndex with activeSessionId
  // IMPORTANT: Only sync when activeSessionId changes, NOT when sortedSessions changes
  // This allows keyboard navigation to move the selector independently of the active session
  // The sync happens when user clicks a session or presses Enter to activate
  useEffect(() => {
    const currentIndex = sortedSessions.findIndex(s => s.id === activeSessionId);
    if (currentIndex !== -1) {
      setSelectedSidebarIndex(currentIndex);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId]); // Intentionally excluding sortedSessions - see comment above

  // Restore file tree scroll position when switching sessions
  useEffect(() => {
    if (activeSession && fileTreeContainerRef.current && activeSession.fileExplorerScrollPos !== undefined) {
      fileTreeContainerRef.current.scrollTop = activeSession.fileExplorerScrollPos;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId]); // Only restore on session switch, not on scroll position changes

  // Track navigation history when session or AI tab changes
  useEffect(() => {
    if (activeSession) {
      pushNavigation({
        sessionId: activeSession.id,
        tabId: activeSession.inputMode === 'ai' && activeSession.aiTabs?.length > 0 ? activeSession.activeTabId : undefined
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId, activeSession?.activeTabId]); // Track session and tab changes

  // Reset shortcuts search when modal closes
  useEffect(() => {
    if (!shortcutsHelpOpen) {
      setShortcutsSearchQuery('');
    }
  }, [shortcutsHelpOpen]);

  // Load Auto Run document list and content when session changes or autorun tab becomes active
  useEffect(() => {
    const loadAutoRunData = async () => {
      if (!activeSession?.autoRunFolderPath) {
        setAutoRunDocumentList([]);
        setAutoRunDocumentTree([]);
        setAutoRunContent('');
        return;
      }

      // Load document list
      setAutoRunIsLoadingDocuments(true);
      const listResult = await window.maestro.autorun.listDocs(activeSession.autoRunFolderPath);
      if (listResult.success) {
        setAutoRunDocumentList(listResult.files || []);
        setAutoRunDocumentTree((listResult.tree as Array<{ name: string; type: 'file' | 'folder'; path: string; children?: unknown[] }>) || []);
      }
      setAutoRunIsLoadingDocuments(false);

      // Load content of selected document
      if (activeSession.autoRunSelectedFile) {
        const contentResult = await window.maestro.autorun.readDoc(
          activeSession.autoRunFolderPath,
          activeSession.autoRunSelectedFile + '.md'
        );
        if (contentResult.success) {
          setAutoRunContent(contentResult.content || '');
        } else {
          setAutoRunContent('');
        }
      } else {
        setAutoRunContent('');
      }
    };

    loadAutoRunData();
  }, [activeSessionId, activeSession?.autoRunFolderPath, activeSession?.autoRunSelectedFile]);

  // File watching for Auto Run - watch whenever a folder is configured
  // Updates reflect immediately whether from batch runs, terminal commands, or external editors
  useEffect(() => {
    const folderPath = activeSession?.autoRunFolderPath;
    const selectedFile = activeSession?.autoRunSelectedFile;

    // Only watch if folder is set
    if (!folderPath) return;

    // Start watching the folder
    window.maestro.autorun.watchFolder(folderPath);

    // Listen for file change events
    const unsubscribe = window.maestro.autorun.onFileChanged(async (data) => {
      // Only respond to changes in the current folder
      if (data.folderPath !== folderPath) return;

      // Reload document list for any change (in case files added/removed)
      const listResult = await window.maestro.autorun.listDocs(folderPath);
      if (listResult.success) {
        setAutoRunDocumentList(listResult.files || []);
        setAutoRunDocumentTree((listResult.tree as Array<{ name: string; type: 'file' | 'folder'; path: string; children?: unknown[] }>) || []);
      }

      // If we have a selected document and it matches the changed file, reload its content
      if (selectedFile && data.filename === selectedFile) {
        const contentResult = await window.maestro.autorun.readDoc(
          folderPath,
          selectedFile + '.md'
        );
        if (contentResult.success) {
          setAutoRunContent(contentResult.content || '');
          // Increment version to force AutoRun editor to sync (even if user was editing)
          setAutoRunContentVersion(v => v + 1);
        }
      }
    });

    // Cleanup: stop watching when folder changes or unmount
    return () => {
      window.maestro.autorun.unwatchFolder(folderPath);
      unsubscribe();
    };
  }, [activeSession?.autoRunFolderPath, activeSession?.autoRunSelectedFile]);

  // Auto-scroll logs
  const activeTabLogs = activeSession ? getActiveTab(activeSession)?.logs : undefined;
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'instant' });
  }, [activeTabLogs, activeSession?.shellLogs, activeSession?.inputMode]);

  // --- ACTIONS ---
  const cycleSession = (dir: 'next' | 'prev') => {
    // Build the visual order of sessions as they appear in the sidebar.
    // This matches the actual rendering order in SessionList.tsx:
    // 1. Bookmarks section (if open) - sorted alphabetically
    // 2. Groups (sorted alphabetically) - each with sessions sorted alphabetically
    // 3. Ungrouped sessions - sorted alphabetically
    //
    // A bookmarked session visually appears in BOTH the bookmarks section AND its
    // regular location (group or ungrouped). The same session can appear twice in
    // the visual order. We track the current position with cyclePositionRef to
    // allow cycling through duplicate occurrences correctly.

    const visualOrder: Session[] = [];

    if (leftSidebarOpen) {
      // Bookmarks section (if expanded and has bookmarked sessions)
      if (!bookmarksCollapsed) {
        const bookmarkedSessions = sessions
          .filter(s => s.bookmarked)
          .sort((a, b) => compareNamesIgnoringEmojis(a.name, b.name));
        visualOrder.push(...bookmarkedSessions);
      }

      // Groups (sorted alphabetically), with each group's sessions
      const sortedGroups = [...groups].sort((a, b) => compareNamesIgnoringEmojis(a.name, b.name));
      for (const group of sortedGroups) {
        if (!group.collapsed) {
          const groupSessions = sessions
            .filter(s => s.groupId === group.id)
            .sort((a, b) => compareNamesIgnoringEmojis(a.name, b.name));
          visualOrder.push(...groupSessions);
        }
      }

      // Ungrouped sessions (sorted alphabetically) - only if not collapsed
      if (!settings.ungroupedCollapsed) {
        const ungroupedSessions = sessions
          .filter(s => !s.groupId)
          .sort((a, b) => compareNamesIgnoringEmojis(a.name, b.name));
        visualOrder.push(...ungroupedSessions);
      }
    } else {
      // Sidebar collapsed: cycle through all sessions in their sorted order
      visualOrder.push(...sortedSessions);
    }

    if (visualOrder.length === 0) return;

    // Determine current position in visual order
    // If cyclePositionRef is valid and points to our current session, use it
    // Otherwise, find the first occurrence of our current session
    let currentIndex = cyclePositionRef.current;
    if (currentIndex < 0 || currentIndex >= visualOrder.length ||
        visualOrder[currentIndex].id !== activeSessionId) {
      // Position is invalid or doesn't match current session - find first occurrence
      currentIndex = visualOrder.findIndex(s => s.id === activeSessionId);
    }

    if (currentIndex === -1) {
      // Current session not visible, select first visible session
      cyclePositionRef.current = 0;
      setActiveSessionIdInternal(visualOrder[0].id);
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
    setActiveSessionIdInternal(visualOrder[nextIndex].id);
  };

  const showConfirmation = (message: string, onConfirm: () => void) => {
    setConfirmModalMessage(message);
    setConfirmModalOnConfirm(() => onConfirm);
    setConfirmModalOpen(true);
  };

  const deleteSession = (id: string) => {
    const session = sessions.find(s => s.id === id);
    if (!session) return;

    showConfirmation(
      `Are you sure you want to delete "${session.name}"? This action cannot be undone.`,
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

        const newSessions = sessions.filter(s => s.id !== id);
        setSessions(newSessions);
        if (newSessions.length > 0) {
          setActiveSessionId(newSessions[0].id);
        } else {
          setActiveSessionId('');
        }
      }
    );
  };

  const addNewSession = () => {
    setNewInstanceModalOpen(true);
  };

  const createNewSession = async (agentId: string, workingDir: string, name: string) => {
    // Validate uniqueness before creating
    const validation = validateNewSession(name, workingDir, agentId as ToolType, sessions);
    if (!validation.valid) {
      console.error(`Session validation failed: ${validation.error}`);
      showToast(validation.error || 'Cannot create duplicate session', 'error');
      return;
    }

    const newId = generateId();

    // Get agent definition to get correct command
    const agent = await window.maestro.agents.get(agentId);
    if (!agent) {
      console.error(`Agent not found: ${agentId}`);
      return;
    }

    // Spawn AI process (terminal uses runCommand which spawns fresh shells per command)
    try {
      // Spawn AI agent process
      // Use agent.path (full path) if available for better cross-environment compatibility
      const aiSpawnResult = await window.maestro.process.spawn({
        sessionId: `${newId}-ai`,
        toolType: agentId,
        cwd: workingDir,
        command: agent.path || agent.command,
        args: agent.args || []
      });

      if (!aiSpawnResult.success || aiSpawnResult.pid <= 0) {
        throw new Error('Failed to spawn AI agent process');
      }

      // Terminal processes are spawned lazily when needed (not eagerly)
      // runCommand() spawns a fresh shell for each command, so no persistent PTY needed

      // Check if the working directory is a Git repository
      const isGitRepo = await gitService.isRepo(workingDir);

      // Fetch git branches and tags if it's a git repo
      let gitBranches: string[] | undefined;
      let gitTags: string[] | undefined;
      let gitRefsCacheTime: number | undefined;
      if (isGitRepo) {
        [gitBranches, gitTags] = await Promise.all([
          gitService.getBranches(workingDir),
          gitService.getTags(workingDir)
        ]);
        gitRefsCacheTime = Date.now();
      }

      // Create initial fresh tab for new sessions
      const initialTabId = generateId();
      const initialTab: AITab = {
        id: initialTabId,
        claudeSessionId: null,
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
        aiPid: aiSpawnResult.pid,
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
        closedTabHistory: []
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
    const { selectedAgent, directoryPath, agentName, generatedDocuments } = wizardState;

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
      showToast(validation.error || 'Cannot create duplicate session', 'error');
      throw new Error(validation.error || 'Session validation failed');
    }

    // Get agent definition
    const agent = await window.maestro.agents.get(selectedAgent);
    if (!agent) {
      throw new Error(`Agent not found: ${selectedAgent}`);
    }

    // Spawn AI process
    const aiSpawnResult = await window.maestro.process.spawn({
      sessionId: `${newId}-ai`,
      toolType: selectedAgent,
      cwd: directoryPath,
      command: agent.path || agent.command,
      args: agent.args || []
    });

    if (!aiSpawnResult.success || aiSpawnResult.pid <= 0) {
      throw new Error('Failed to spawn AI agent process');
    }

    // Check git repo status
    const isGitRepo = await gitService.isRepo(directoryPath);
    let gitBranches: string[] | undefined;
    let gitTags: string[] | undefined;
    let gitRefsCacheTime: number | undefined;
    if (isGitRepo) {
      [gitBranches, gitTags] = await Promise.all([
        gitService.getBranches(directoryPath),
        gitService.getTags(directoryPath)
      ]);
      gitRefsCacheTime = Date.now();
    }

    // Create initial tab
    const initialTabId = generateId();
    const initialTab: AITab = {
      id: initialTabId,
      claudeSessionId: null,
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
      aiPid: aiSpawnResult.pid,
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
      // Persist starred status to Claude session metadata (async, fire and forget)
      if (tab.claudeSessionId) {
        window.maestro.claude.updateSessionStarred(
          s.cwd,
          tab.claudeSessionId,
          newStarred
        ).catch(err => console.error('Failed to persist tab starred:', err));
      }
      return {
        ...s,
        aiTabs: s.aiTabs.map(t =>
          t.id === tab.id ? { ...t, starred: newStarred } : t
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
        const result = await window.maestro.live.disableAll();
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

  const handleViewGitDiff = async () => {
    if (!activeSession || !activeSession.isGitRepo) return;

    const cwd = activeSession.inputMode === 'terminal' ? (activeSession.shellCwd || activeSession.cwd) : activeSession.cwd;
    const diff = await gitService.getDiff(cwd);

    if (diff.diff) {
      setGitDiffPreview(diff.diff);
    }
  };

  // Update keyboardHandlerRef synchronously during render (before effects run)
  // This must be placed after all handler functions are defined to avoid TDZ errors
  keyboardHandlerRef.current = {
    shortcuts, activeFocus, activeRightTab, sessions, selectedSidebarIndex, activeSessionId,
    quickActionOpen, settingsModalOpen, shortcutsHelpOpen, newInstanceModalOpen, aboutModalOpen,
    processMonitorOpen, logViewerOpen, createGroupModalOpen, confirmModalOpen, renameInstanceModalOpen,
    renameGroupModalOpen, activeSession, previewFile, fileTreeFilter, fileTreeFilterOpen, gitDiffPreview,
    gitLogOpen, lightboxImage, hasOpenLayers, hasOpenModal, visibleSessions, sortedSessions, groups,
    bookmarksCollapsed, leftSidebarOpen, editingSessionId, editingGroupId, markdownEditMode, defaultSaveToHistory,
    setLeftSidebarOpen, setRightPanelOpen, addNewSession, deleteSession, setQuickActionInitialMode,
    setQuickActionOpen, cycleSession, toggleInputMode, setShortcutsHelpOpen, setSettingsModalOpen,
    setSettingsTab, setActiveRightTab, handleSetActiveRightTab, setActiveFocus, setBookmarksCollapsed, setGroups,
    setSelectedSidebarIndex, setActiveSessionId, handleViewGitDiff, setGitLogOpen, setActiveClaudeSessionId,
    setAgentSessionsOpen, setLogViewerOpen, setProcessMonitorOpen, logsEndRef, inputRef, terminalOutputRef,
    setSessions, createTab, closeTab, reopenClosedTab, getActiveTab, setRenameTabId, setRenameTabInitialName,
    setRenameTabModalOpen, navigateToNextTab, navigateToPrevTab, navigateToTabByIndex, navigateToLastTab,
    setFileTreeFilterOpen, isShortcut, isTabShortcut, handleNavBack, handleNavForward, toggleUnreadFilter,
    setTabSwitcherOpen, showUnreadOnly, stagedImages, handleSetLightboxImage, setMarkdownEditMode,
    toggleTabStar, setPromptComposerOpen, openWizardModal
  };

  const toggleGroup = (groupId: string) => {
    setGroups(prev => prev.map(g => g.id === groupId ? { ...g, collapsed: !g.collapsed } : g));
  };

  const startRenamingGroup = (groupId: string) => {
    setEditingGroupId(groupId);
  };

  const finishRenamingGroup = (groupId: string, newName: string) => {
    setGroups(prev => prev.map(g => g.id === groupId ? { ...g, name: newName.toUpperCase() } : g));
    setEditingGroupId(null);
  };

  // startRenamingSession now accepts a unique key (e.g., 'bookmark-id', 'group-gid-id', 'ungrouped-id')
  // to support renaming the same session from different UI locations (bookmarks vs groups)
  const startRenamingSession = (editKey: string) => {
    setEditingSessionId(editKey);
  };

  const finishRenamingSession = (sessId: string, newName: string) => {
    setSessions(prev => {
      const updated = prev.map(s => s.id === sessId ? { ...s, name: newName } : s);
      // Sync the session name to Claude session storage for searchability
      const session = updated.find(s => s.id === sessId);
      if (session?.claudeSessionId && session.cwd) {
        window.maestro.claude.updateSessionName(session.cwd, session.claudeSessionId, newName)
          .catch(err => console.warn('[finishRenamingSession] Failed to sync session name:', err));
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

  const handleDropOnGroup = (groupId: string) => {
    if (draggingSessionId) {
      setSessions(prev => prev.map(s =>
        s.id === draggingSessionId ? { ...s, groupId } : s
      ));
      setDraggingSessionId(null);
    }
  };

  const handleDropOnUngrouped = () => {
    if (draggingSessionId) {
      setSessions(prev => prev.map(s =>
        s.id === draggingSessionId ? { ...s, groupId: undefined } : s
      ));
      setDraggingSessionId(null);
    }
  };

  const createNewGroup = () => {
    setNewGroupName('');
    setNewGroupEmoji('📂');
    setMoveSessionToNewGroup(false);
    setCreateGroupModalOpen(true);
  };

  const handleCreateGroupConfirm = () => {
    if (newGroupName.trim()) {
      const newGroup: Group = {
        id: `group-${Date.now()}`,
        name: newGroupName.trim().toUpperCase(),
        emoji: newGroupEmoji,
        collapsed: false
      };
      setGroups([...groups, newGroup]);

      // If we should move the session to the new group
      if (moveSessionToNewGroup) {
        setSessions(prev => prev.map(s =>
          s.id === activeSessionId ? { ...s, groupId: newGroup.id } : s
        ));
      }

      setCreateGroupModalOpen(false);
      setNewGroupName('');
      setNewGroupEmoji('📂');
      setEmojiPickerOpen(false);
    }
  };

  const processInput = async (overrideInputValue?: string) => {
    const effectiveInputValue = overrideInputValue ?? inputValue;
    console.log('[processInput] Called with:', {
      overrideInputValue,
      inputValue,
      effectiveInputValue,
      activeSessionId: activeSession?.id,
      inputMode: activeSession?.inputMode,
      stagedImagesCount: stagedImages.length
    });
    if (!activeSession || (!effectiveInputValue.trim() && stagedImages.length === 0)) {
      console.log('[processInput] Early return - no session or empty input');
      return;
    }

    // Handle slash commands (custom AI commands only - built-in commands have been removed)
    // Note: slash commands are queued like regular messages when agent is busy
    if (effectiveInputValue.trim().startsWith('/')) {
      const commandText = effectiveInputValue.trim();
      const isTerminalMode = activeSession.inputMode === 'terminal';

      // Check for custom AI commands (only in AI mode)
      if (!isTerminalMode) {
        const matchingCustomCommand = customAICommands.find(cmd => cmd.command === commandText);
        if (matchingCustomCommand) {
          // Execute the custom AI command by sending its prompt
          setInputValue('');
          setSlashCommandOpen(false);
          syncAiInputToSession('');  // We're in AI mode here (isTerminalMode === false)
          if (inputRef.current) inputRef.current.style.height = 'auto';

          // Substitute template variables and send to the AI agent
          (async () => {
            let gitBranch: string | undefined;
            if (activeSession.isGitRepo) {
              try {
                const status = await gitService.getStatus(activeSession.cwd);
                gitBranch = status.branch;
              } catch {
                // Ignore git errors
              }
            }
            const substitutedPrompt = substituteTemplateVariables(
              matchingCustomCommand.prompt,
              { session: activeSession, gitBranch }
            );

            // ALWAYS queue slash commands - they execute in order like write messages
            // This ensures commands are processed sequentially through the queue
            const activeTab = getActiveTab(activeSession);
            const isReadOnlyMode = activeTab?.readOnlyMode === true;
            const sessionIsIdle = activeSession.state !== 'busy';

            const queuedItem: QueuedItem = {
              id: generateId(),
              timestamp: Date.now(),
              tabId: activeTab?.id || activeSession.activeTabId,
              type: 'command',
              command: matchingCustomCommand.command,
              commandDescription: matchingCustomCommand.description,
              tabName: activeTab?.name || (activeTab?.claudeSessionId ? activeTab.claudeSessionId.split('-')[0].toUpperCase() : 'New'),
              readOnlyMode: isReadOnlyMode
            };

            // If session is idle, we need to set up state and process immediately
            // If session is busy, just add to queue - it will be processed when current item finishes
            if (sessionIsIdle) {
              // Set up session and tab state for immediate processing
              // NOTE: Don't add to executionQueue when processing immediately - it's not actually queued,
              // and adding it would cause duplicate display (once as sent message, once in queue section)
              setSessions(prev => prev.map(s => {
                if (s.id !== activeSessionId) return s;

                // Set the target tab to busy
                const updatedAiTabs = s.aiTabs.map(tab =>
                  tab.id === queuedItem.tabId
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
                  aiTabs: updatedAiTabs,
                  // Don't add to queue - we're processing immediately, not queuing
                  aiCommandHistory: Array.from(new Set([...(s.aiCommandHistory || []), commandText])).slice(-50),
                };
              }));

              // Process immediately after state is set up
              setTimeout(() => {
                processQueuedItem(activeSessionId, queuedItem);
              }, 50);
            } else {
              // Session is busy - just add to queue
              setSessions(prev => prev.map(s => {
                if (s.id !== activeSessionId) return s;
                return {
                  ...s,
                  executionQueue: [...s.executionQueue, queuedItem],
                  aiCommandHistory: Array.from(new Set([...(s.aiCommandHistory || []), commandText])).slice(-50),
                };
              }));
            }
            // Note: Input already cleared synchronously before this async block
          })();
          return;
        }
      }
    }

    const currentMode = activeSession.inputMode;

    // Queue messages when AI is busy (only in AI mode)
    // For read-only mode tabs: only queue if THIS TAB is busy (allows parallel execution)
    // For write mode tabs: queue if ANY tab in session is busy (prevents conflicts)
    // EXCEPTION: Write commands can bypass the queue and run in parallel if ALL busy tabs
    // and ALL queued items are read-only
    if (currentMode === 'ai') {
      const activeTab = getActiveTab(activeSession);
      const isReadOnlyMode = activeTab?.readOnlyMode === true;

      // Check if write command can bypass queue (all running/queued items are read-only)
      const canWriteBypassQueue = (): boolean => {
        if (isReadOnlyMode) return false; // Only applies to write commands
        if (activeSession.state !== 'busy') return false; // Nothing to bypass

        // Check all busy tabs are in read-only mode
        const busyTabs = activeSession.aiTabs.filter(tab => tab.state === 'busy');
        const allBusyTabsReadOnly = busyTabs.every(tab => tab.readOnlyMode === true);
        if (!allBusyTabsReadOnly) return false;

        // Check all queued items are from read-only tabs
        const allQueuedReadOnly = activeSession.executionQueue.every(item => item.readOnlyMode === true);
        if (!allQueuedReadOnly) return false;

        return true;
      };

      // Determine if we should queue this message
      // Read-only tabs can run in parallel - only queue if this specific tab is busy
      // Write mode tabs must wait for any busy tab to finish
      // EXCEPTION: Write commands bypass queue when all running/queued items are read-only
      const shouldQueue = isReadOnlyMode
        ? activeTab?.state === 'busy'  // Read-only: only queue if THIS tab is busy
        : activeSession.state === 'busy' && !canWriteBypassQueue();  // Write mode: queue unless all items are read-only

      if (shouldQueue) {
        const queuedItem: QueuedItem = {
          id: generateId(),
          timestamp: Date.now(),
          tabId: activeTab?.id || activeSession.activeTabId,
          type: 'message',
          text: effectiveInputValue,
          images: [...stagedImages],
          tabName: activeTab?.name || (activeTab?.claudeSessionId ? activeTab.claudeSessionId.split('-')[0].toUpperCase() : 'New'),
          readOnlyMode: isReadOnlyMode
        };

        setSessions(prev => prev.map(s => {
          if (s.id !== activeSessionId) return s;
          return {
            ...s,
            executionQueue: [...s.executionQueue, queuedItem]
          };
        }));

        // Clear input
        setInputValue('');
        setStagedImages([]);
        syncAiInputToSession('');  // Sync empty value to session state
        if (inputRef.current) inputRef.current.style.height = 'auto';
        return;
      }
    }

    // Check if we're in read-only mode for the log entry
    const activeTabForEntry = currentMode === 'ai' ? getActiveTab(activeSession) : null;
    const isReadOnlyEntry = activeTabForEntry?.readOnlyMode === true;

    const newEntry: LogEntry = {
      id: generateId(),
      timestamp: Date.now(),
      source: 'user',
      text: effectiveInputValue,
      images: [...stagedImages],
      ...(isReadOnlyEntry && { readOnly: true })
    };

    // Track shell CWD changes when in terminal mode
    let newShellCwd = activeSession.shellCwd;
    let cwdChanged = false;
    if (currentMode === 'terminal') {
      const trimmedInput = effectiveInputValue.trim();
      // Handle bare "cd" command - go to session's original directory
      if (trimmedInput === 'cd') {
        cwdChanged = true;
        newShellCwd = activeSession.cwd;
      }
      const cdMatch = trimmedInput.match(/^cd\s+(.+)$/);
      if (cdMatch) {
        const targetPath = cdMatch[1].trim().replace(/^['"]|['"]$/g, ''); // Remove quotes
        let candidatePath: string;
        if (targetPath === '~') {
          // Navigate to session's original directory
          candidatePath = activeSession.cwd;
        } else if (targetPath.startsWith('/')) {
          // Absolute path
          candidatePath = targetPath;
        } else if (targetPath === '..') {
          // Go up one directory
          const parts = newShellCwd.split('/').filter(Boolean);
          parts.pop();
          candidatePath = '/' + parts.join('/');
        } else if (targetPath.startsWith('../')) {
          // Relative path going up
          const parts = newShellCwd.split('/').filter(Boolean);
          const upCount = targetPath.split('/').filter(p => p === '..').length;
          for (let i = 0; i < upCount; i++) parts.pop();
          const remainingPath = targetPath.split('/').filter(p => p !== '..').join('/');
          candidatePath = '/' + [...parts, ...remainingPath.split('/').filter(Boolean)].join('/');
        } else {
          // Relative path going down
          candidatePath = newShellCwd + (newShellCwd.endsWith('/') ? '' : '/') + targetPath;
        }

        // Verify the directory exists before updating shellCwd
        try {
          await window.maestro.fs.readDir(candidatePath);
          // Directory exists, update shellCwd
          cwdChanged = true;
          newShellCwd = candidatePath;
        } catch {
          // Directory doesn't exist, keep the current shellCwd
          // The shell will show its own error message
          console.log(`[processInput] cd target "${candidatePath}" does not exist, keeping current cwd`);
        }
      }
    }

    setSessions(prev => prev.map(s => {
      if (s.id !== activeSessionId) return s;

      // Add command to history (separate histories for AI and terminal modes)
      const historyKey = currentMode === 'ai' ? 'aiCommandHistory' : 'shellCommandHistory';
      const currentHistory = currentMode === 'ai' ? (s.aiCommandHistory || []) : (s.shellCommandHistory || []);
      const newHistory = [...currentHistory];
      if (effectiveInputValue.trim() && (newHistory.length === 0 || newHistory[newHistory.length - 1] !== effectiveInputValue.trim())) {
        newHistory.push(effectiveInputValue.trim());
      }

      // For terminal mode, add to shellLogs
      if (currentMode !== 'ai') {
        return {
          ...s,
          shellLogs: [...s.shellLogs, newEntry],
          state: 'busy',
          busySource: currentMode,
          shellCwd: newShellCwd,
          [historyKey]: newHistory
        };
      }

      // For AI mode, add to ACTIVE TAB's logs
      const activeTab = getActiveTab(s);
      if (!activeTab) {
        // No tabs exist - this is a bug, sessions must have aiTabs
        console.error('[processInput] No active tab found - session has no aiTabs, this should not happen');
        return s;
      }

      // Update the active tab's logs and state to 'busy' for write-mode tracking
      // Also mark as awaitingSessionId if this is a new session (no claudeSessionId yet)
      // Set thinkingStartTime on the tab for accurate elapsed time tracking (especially for parallel tabs)
      const isNewSession = !activeTab.claudeSessionId;
      const updatedAiTabs = s.aiTabs.map(tab =>
        tab.id === activeTab.id
          ? {
              ...tab,
              logs: [...tab.logs, newEntry],
              state: 'busy' as const,
              thinkingStartTime: Date.now(),
              // Mark this tab as awaiting session ID so we can assign it correctly
              // when the session ID comes back (prevents cross-tab assignment)
              awaitingSessionId: isNewSession ? true : tab.awaitingSessionId
            }
          : tab
      );

      return {
        ...s,
        state: 'busy',
        busySource: currentMode,
        thinkingStartTime: Date.now(),
        currentCycleTokens: 0,
        contextUsage: Math.min(s.contextUsage + 5, 100),
        shellCwd: newShellCwd,
        [historyKey]: newHistory,
        aiTabs: updatedAiTabs
      };
    }));

    // If directory changed, check if new directory is a Git repository
    if (cwdChanged) {
      (async () => {
        const isGitRepo = await gitService.isRepo(newShellCwd);
        setSessions(prev => prev.map(s =>
          s.id === activeSessionId ? { ...s, isGitRepo } : s
        ));
      })();
    }

    // Capture input value and images before clearing (needed for async batch mode spawn)
    const capturedInputValue = effectiveInputValue;
    const capturedImages = [...stagedImages];

    // Broadcast user input to web clients so they stay in sync
    window.maestro.web.broadcastUserInput(activeSession.id, capturedInputValue, currentMode);

    setInputValue('');
    setStagedImages([]);

    // Sync empty value to session state (prevents stale input restoration on blur)
    if (isAiMode) {
      syncAiInputToSession('');
    } else {
      syncTerminalInputToSession('');
    }

    // Reset height
    if (inputRef.current) inputRef.current.style.height = 'auto';

    // Write to the appropriate process based on inputMode
    // Each session has TWO processes: AI agent and terminal
    const targetPid = currentMode === 'ai' ? activeSession.aiPid : activeSession.terminalPid;
    // For batch mode (Claude), include tab ID in session ID to prevent process collision
    // This ensures each tab's process has a unique identifier
    const activeTabForSpawn = getActiveTab(activeSession);
    const targetSessionId = currentMode === 'ai'
      ? `${activeSession.id}-ai-${activeTabForSpawn?.id || 'default'}`
      : `${activeSession.id}-terminal`;

    // Check if this is Claude Code in batch mode (AI mode with claude/claude-code tool)
    const isClaudeBatchMode = currentMode === 'ai' &&
      (activeSession.toolType === 'claude' || activeSession.toolType === 'claude-code');

    if (isClaudeBatchMode) {
      // Batch mode: Spawn new Claude process with prompt
      (async () => {
        try {
          // Get agent configuration
          const agent = await window.maestro.agents.get('claude-code');
          if (!agent) throw new Error('Claude Code agent not found');

          // IMPORTANT: Get fresh session state from ref to avoid stale closure bug
          // If user switches tabs quickly, activeSession from closure may have wrong activeTabId
          const freshSession = sessionsRef.current.find(s => s.id === activeSessionId);
          if (!freshSession) throw new Error('Session not found');

          // Build spawn args with resume if we have a session ID
          // Use the ACTIVE TAB's claudeSessionId (not the deprecated session-level one)
          const freshActiveTab = getActiveTab(freshSession);
          const tabClaudeSessionId = freshActiveTab?.claudeSessionId;
          const isNewSession = !tabClaudeSessionId;
          const isReadOnly = activeBatchRunState.isRunning || freshActiveTab?.readOnlyMode;

          // Filter out --dangerously-skip-permissions when read-only mode is active
          // (it would override --permission-mode plan)
          const spawnArgs = isReadOnly
            ? agent.args.filter(arg => arg !== '--dangerously-skip-permissions')
            : [...agent.args];

          if (tabClaudeSessionId) {
            spawnArgs.push('--resume', tabClaudeSessionId);
          }

          // Add read-only/plan mode when auto mode is active OR tab has readOnlyMode enabled
          if (isReadOnly) {
            spawnArgs.push('--permission-mode', 'plan');
          }

          // Spawn Claude with prompt as argument (use captured value)
          // If images are present, they will be passed via stream-json input format
          // Use agent.path (full path) if available, otherwise fall back to agent.command
          const commandToUse = agent.path || agent.command;

          // If user sends only an image without text, inject the default image-only prompt
          const hasImages = capturedImages.length > 0;
          const hasNoText = !capturedInputValue.trim();
          const effectivePrompt = (hasImages && hasNoText) ? DEFAULT_IMAGE_ONLY_PROMPT : capturedInputValue;

          await window.maestro.process.spawn({
            sessionId: targetSessionId,
            toolType: 'claude-code',
            cwd: freshSession.cwd,
            command: commandToUse,
            args: spawnArgs,
            prompt: effectivePrompt,
            images: hasImages ? capturedImages : undefined
          });
        } catch (error) {
          console.error('Failed to spawn Claude batch process:', error);
          const errorLog: LogEntry = {
            id: generateId(),
            timestamp: Date.now(),
            source: 'system',
            text: `Error: Failed to spawn Claude process - ${error.message}`
          };
          setSessions(prev => prev.map(s => {
            if (s.id !== activeSessionId) return s;
            // Reset active tab's state to 'idle' and add error log
            const updatedAiTabs = s.aiTabs?.length > 0
              ? s.aiTabs.map(tab =>
                  tab.id === s.activeTabId
                    ? { ...tab, state: 'idle' as const, thinkingStartTime: undefined, logs: [...tab.logs, errorLog] }
                    : tab
                )
              : s.aiTabs;
            return {
              ...s,
              state: 'idle',
              busySource: undefined,
              thinkingStartTime: undefined,
              aiTabs: updatedAiTabs
            };
          }));
        }
      })();
    } else if (currentMode === 'terminal') {
      // Terminal mode: Use runCommand for clean stdout/stderr capture (no PTY noise)
      // This spawns a fresh shell with -l -c to run the command, ensuring aliases work
      window.maestro.process.runCommand({
        sessionId: activeSession.id,  // Plain session ID (not suffixed)
        command: capturedInputValue,
        cwd: activeSession.shellCwd || activeSession.cwd
      }).catch(error => {
        console.error('Failed to run command:', error);
        setSessions(prev => prev.map(s => {
          if (s.id !== activeSessionId) return s;
          return {
            ...s,
            state: 'idle',
            busySource: undefined,
            thinkingStartTime: undefined,
            shellLogs: [...s.shellLogs, {
              id: generateId(),
              timestamp: Date.now(),
              source: 'system',
              text: `Error: Failed to run command - ${error.message}`
            }]
          };
        }));
      });
    } else if (targetPid > 0) {
      // AI mode: Write to stdin
      window.maestro.process.write(targetSessionId, capturedInputValue).catch(error => {
        console.error('Failed to write to process:', error);
        const errorLog: LogEntry = {
          id: generateId(),
          timestamp: Date.now(),
          source: 'system',
          text: `Error: Failed to write to process - ${error.message}`
        };
        setSessions(prev => prev.map(s => {
          if (s.id !== activeSessionId) return s;
          // Reset active tab's state to 'idle' and add error log
          const updatedAiTabs = s.aiTabs?.length > 0
            ? s.aiTabs.map(tab =>
                tab.id === s.activeTabId
                  ? { ...tab, state: 'idle' as const, thinkingStartTime: undefined, logs: [...tab.logs, errorLog] }
                  : tab
              )
            : s.aiTabs;
          return {
            ...s,
            state: 'idle',
            busySource: undefined,
            thinkingStartTime: undefined,
            aiTabs: updatedAiTabs
          };
        }));
      });
    }
  };

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
        claudeSessionId: session.claudeSessionId || 'none',
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
        try {
          await window.maestro.process.runCommand({
            sessionId: sessionId,  // Plain session ID (not suffixed)
            command: command,
            cwd: session.shellCwd || session.cwd
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

      // Handle AI mode for Claude Code
      if (session.toolType !== 'claude' && session.toolType !== 'claude-code') {
        console.log('[Remote] Not Claude Code, skipping');
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

        if (matchingCustomCommand) {
          console.log('[Remote] Found matching custom AI command:', matchingCustomCommand.command);

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
            matchingCustomCommand.prompt,
            { session, gitBranch }
          );
          commandMetadata = {
            command: matchingCustomCommand.command,
            description: matchingCustomCommand.description
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
        // Get agent configuration
        const agent = await window.maestro.agents.get('claude-code');
        if (!agent) {
          console.log('[Remote] ERROR: Claude Code agent not found');
          return;
        }

        // Build spawn args with resume if we have a Claude session ID
        // Use the ACTIVE TAB's claudeSessionId (not the deprecated session-level one)
        const activeTab = getActiveTab(session);
        const tabClaudeSessionId = activeTab?.claudeSessionId;
        const isReadOnly = activeTab?.readOnlyMode;

        // Filter out --dangerously-skip-permissions when read-only mode is active
        // (it would override --permission-mode plan)
        const spawnArgs = isReadOnly
          ? agent.args.filter(arg => arg !== '--dangerously-skip-permissions')
          : [...agent.args];

        if (tabClaudeSessionId) {
          spawnArgs.push('--resume', tabClaudeSessionId);
        }

        // Add read-only/plan mode if the active tab has readOnlyMode enabled
        if (isReadOnly) {
          spawnArgs.push('--permission-mode', 'plan');
        }

        // Include tab ID in targetSessionId for proper output routing
        const targetSessionId = `${sessionId}-ai-${activeTab?.id || 'default'}`;
        const commandToUse = agent.path || agent.command;

        console.log('[Remote] Spawning Claude directly:', {
          maestroSessionId: sessionId,
          targetSessionId,
          activeTabId: activeTab?.id,
          tabClaudeSessionId: tabClaudeSessionId || 'NEW SESSION',
          isResume: !!tabClaudeSessionId,
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

        // Spawn Claude with the prompt (original or substituted)
        await window.maestro.process.spawn({
          sessionId: targetSessionId,
          toolType: 'claude-code',
          cwd: session.cwd,
          command: commandToUse,
          args: spawnArgs,
          prompt: promptToSend
        });

        console.log('[Remote] Claude spawn initiated successfully');
      } catch (error) {
        console.error('[Remote] Failed to spawn Claude:', error);
        const errorLogEntry: LogEntry = {
          id: generateId(),
          timestamp: Date.now(),
          source: 'system',
          text: `Error: Failed to process remote command - ${error.message}`
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
  }, []);

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
      // Get agent configuration
      const agent = await window.maestro.agents.get('claude-code');
      if (!agent) throw new Error('Claude Code agent not found');

      // Build spawn args with resume if we have a session ID
      // Use the TARGET TAB's claudeSessionId (not the active tab or deprecated session-level one)
      const tabClaudeSessionId = targetTab?.claudeSessionId;
      const isReadOnly = item.readOnlyMode || targetTab?.readOnlyMode;

      // Filter out --dangerously-skip-permissions when read-only mode is active
      // (it would override --permission-mode plan)
      const spawnArgs = isReadOnly
        ? (agent.args || []).filter(arg => arg !== '--dangerously-skip-permissions')
        : [...(agent.args || [])];

      if (tabClaudeSessionId) {
        spawnArgs.push('--resume', tabClaudeSessionId);
      }

      // Add read-only/plan mode if the queued item was from a read-only tab
      // or if the target tab currently has readOnlyMode enabled
      if (isReadOnly) {
        spawnArgs.push('--permission-mode', 'plan');
      }

      const commandToUse = agent.path || agent.command;

      // Check if this is a message with images but no text
      const hasImages = item.images && item.images.length > 0;
      const hasText = item.text && item.text.trim();
      const isImageOnlyMessage = item.type === 'message' && hasImages && !hasText;

      if (item.type === 'message' && (hasText || isImageOnlyMessage)) {
        // Process a message - spawn Claude with the message text
        // If user sends only an image without text, inject the default image-only prompt
        const effectivePrompt = isImageOnlyMessage ? DEFAULT_IMAGE_ONLY_PROMPT : item.text!;

        await window.maestro.process.spawn({
          sessionId: targetSessionId,
          toolType: 'claude-code',
          cwd: session.cwd,
          command: commandToUse,
          args: spawnArgs,
          prompt: effectivePrompt,
          images: hasImages ? item.images : undefined
        });
      } else if (item.type === 'command' && item.command) {
        // Process a slash command - find the matching custom AI command
        const matchingCommand = customAICommands.find(cmd => cmd.command === item.command);
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

          // Add user log showing the command with its interpolated prompt
          // Use target tab (from queued item), not active tab
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

          // Spawn Claude with the substituted prompt
          await window.maestro.process.spawn({
            sessionId: targetSessionId,
            toolType: 'claude-code',
            cwd: session.cwd,
            command: commandToUse,
            args: spawnArgs,
            prompt: substitutedPrompt
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
          let updatedAiTabs = s.aiTabs.map(tab => {
            if (tab.id === targetTab.id) {
              return { ...tab, state: 'busy' as const, thinkingStartTime: Date.now() };
            }
            // Set any other busy tabs to idle (they were interrupted)
            if (tab.state === 'busy') {
              return { ...tab, state: 'idle' as const, thinkingStartTime: undefined };
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

        // No queued items, just go to idle
        return {
          ...s,
          state: 'idle',
          busySource: undefined,
          thinkingStartTime: undefined
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

            // Add kill log to the appropriate place
            let updatedSession = { ...s };
            if (currentMode === 'ai') {
              const tab = getActiveTab(s);
              if (tab) {
                updatedSession.aiTabs = s.aiTabs.map(t =>
                  t.id === tab.id ? { ...t, logs: [...t.logs, killLog] } : t
                );
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

              // Set tabs appropriately
              let updatedAiTabs = updatedSession.aiTabs.map(tab => {
                if (tab.id === targetTab.id) {
                  return { ...tab, state: 'busy' as const, thinkingStartTime: Date.now() };
                }
                if (tab.state === 'busy') {
                  return { ...tab, state: 'idle' as const, thinkingStartTime: undefined };
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

            // No queued items, just go to idle
            if (currentMode === 'ai') {
              const tab = getActiveTab(s);
              if (!tab) return { ...updatedSession, state: 'idle', busySource: undefined, thinkingStartTime: undefined };
              return {
                ...updatedSession,
                state: 'idle',
                busySource: undefined,
                thinkingStartTime: undefined,
                aiTabs: updatedSession.aiTabs.map(t =>
                  t.id === tab.id ? { ...t, state: 'idle' as const, thinkingStartTime: undefined } : t
                )
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
        } catch (killError) {
          console.error('Failed to kill process:', killError);
          const errorLog: LogEntry = {
            id: generateId(),
            timestamp: Date.now(),
            source: 'system',
            text: `Error: Failed to terminate process - ${killError.message}`
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
                aiTabs: s.aiTabs.map(t =>
                  t.id === tab.id ? { ...t, state: 'idle' as const, thinkingStartTime: undefined, logs: [...t.logs, errorLog] } : t
                )
              };
            }
            return { ...s, shellLogs: [...s.shellLogs, errorLog], state: 'idle', busySource: undefined, thinkingStartTime: undefined };
          }));
        }
      }
    }
  };

  const handleInputKeyDown = (e: React.KeyboardEvent) => {
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
      const isTerminalMode = activeSession.inputMode === 'terminal';
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
      const currentEnterToSend = activeSession.inputMode === 'terminal' ? enterToSendTerminal : enterToSendAI;

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
      if (activeSession.inputMode === 'terminal') {
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
  const handlePaste = (e: React.ClipboardEvent) => {
    // Only allow image pasting in AI mode
    if (!activeSession || activeSession.inputMode !== 'ai') return;

    const items = e.clipboardData.items;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image') !== -1) {
        e.preventDefault();
        const blob = items[i].getAsFile();
        if (blob) {
          const reader = new FileReader();
          reader.onload = (event) => {
            if (event.target?.result) {
              setStagedImages(prev => [...prev, event.target!.result as string]);
            }
          };
          reader.readAsDataURL(blob);
        }
      }
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();

    // Only allow image dropping in AI mode
    if (!activeSession || activeSession.inputMode !== 'ai') return;

    const files = e.dataTransfer.files;
    for (let i = 0; i < files.length; i++) {
      if (files[i].type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = (event) => {
          if (event.target?.result) {
             setStagedImages(prev => [...prev, event.target!.result as string]);
          }
        };
        reader.readAsDataURL(files[i]);
      }
    }
  };

  // --- RENDER ---

  // Recursive File Tree Renderer

  const handleFileClick = async (node: any, path: string) => {
    if (node.type === 'file') {
      try {
        // Construct full file path
        const fullPath = `${activeSession.fullPath}/${path}`;

        // Check if file should be opened externally
        if (shouldOpenExternally(node.name)) {
          // Show confirmation modal before opening externally
          setConfirmModalMessage(`Open "${node.name}" in external application?`);
          setConfirmModalOnConfirm(() => async () => {
            await window.maestro.shell.openExternal(`file://${fullPath}`);
            setConfirmModalOpen(false);
          });
          setConfirmModalOpen(true);
          return;
        }

        const content = await window.maestro.fs.readFile(fullPath);
        setPreviewFile({
          name: node.name,
          content: content,
          path: fullPath
        });
        setActiveFocus('main');
      } catch (error) {
        console.error('Failed to read file:', error);
      }
    }
  };


  const updateSessionWorkingDirectory = async () => {
    const newPath = await window.maestro.dialog.selectFolder();
    if (!newPath) return;

    setSessions(prev => prev.map(s => {
      if (s.id !== activeSessionId) return s;
      return {
        ...s,
        cwd: newPath,
        fullPath: newPath,
        fileTree: [],
        fileTreeError: undefined
      };
    }));
  };

  const toggleFolder = (path: string, sessionId: string, setSessions: React.Dispatch<React.SetStateAction<Session[]>>) => {
    setSessions(prev => prev.map(s => {
      if (s.id !== sessionId) return s;
      if (!s.fileExplorerExpanded) return s;
      const expanded = new Set(s.fileExplorerExpanded);
      if (expanded.has(path)) {
        expanded.delete(path);
      } else {
        expanded.add(path);
      }
      return { ...s, fileExplorerExpanded: Array.from(expanded) };
    }));
  };

  // Expand all folders in file tree
  const expandAllFolders = (sessionId: string, session: Session, setSessions: React.Dispatch<React.SetStateAction<Session[]>>) => {
    setSessions(prev => prev.map(s => {
      if (s.id !== sessionId) return s;
      if (!s.fileTree) return s;
      const allFolderPaths = getAllFolderPaths(s.fileTree);
      return { ...s, fileExplorerExpanded: allFolderPaths };
    }));
  };

  // Collapse all folders in file tree
  const collapseAllFolders = (sessionId: string, setSessions: React.Dispatch<React.SetStateAction<Session[]>>) => {
    setSessions(prev => prev.map(s => {
      if (s.id !== sessionId) return s;
      return { ...s, fileExplorerExpanded: [] };
    }));
  };

  // Refresh file tree for a session and return the changes detected
  const refreshFileTree = useCallback(async (sessionId: string): Promise<FileTreeChanges | undefined> => {
    // Use sessionsRef to avoid dependency on sessions state (prevents timer reset on every session change)
    const session = sessionsRef.current.find(s => s.id === sessionId);
    if (!session) return undefined;

    try {
      const oldTree = session.fileTree || [];
      const newTree = await loadFileTree(session.cwd);
      const changes = compareFileTrees(oldTree, newTree);

      setSessions(prev => prev.map(s =>
        s.id === sessionId ? { ...s, fileTree: newTree, fileTreeError: undefined } : s
      ));

      return changes;
    } catch (error) {
      console.error('File tree refresh error:', error);
      const errorMsg = (error as Error)?.message || 'Unknown error';
      setSessions(prev => prev.map(s =>
        s.id === sessionId ? {
          ...s,
          fileTree: [],
          fileTreeError: `Cannot access directory: ${session.cwd}\n${errorMsg}`
        } : s
      ));
      return undefined;
    }
  }, []);

  // Refresh both file tree and git state for a session
  const refreshGitFileState = useCallback(async (sessionId: string) => {
    const session = sessions.find(s => s.id === sessionId);
    if (!session) return;

    const cwd = session.inputMode === 'terminal' ? (session.shellCwd || session.cwd) : session.cwd;

    try {
      // Refresh file tree, git repo status, branches, and tags in parallel
      const [tree, isGitRepo] = await Promise.all([
        loadFileTree(cwd),
        gitService.isRepo(cwd)
      ]);

      let gitBranches: string[] | undefined;
      let gitTags: string[] | undefined;
      let gitRefsCacheTime: number | undefined;

      if (isGitRepo) {
        [gitBranches, gitTags] = await Promise.all([
          gitService.getBranches(cwd),
          gitService.getTags(cwd)
        ]);
        gitRefsCacheTime = Date.now();
      }

      setSessions(prev => prev.map(s =>
        s.id === sessionId ? {
          ...s,
          fileTree: tree,
          fileTreeError: undefined,
          isGitRepo,
          gitBranches,
          gitTags,
          gitRefsCacheTime
        } : s
      ));

      // Also refresh history panel (reload from disk first to bypass electron-store cache)
      await window.maestro.history.reload();
      rightPanelRef.current?.refreshHistoryPanel();
    } catch (error) {
      console.error('Git/file state refresh error:', error);
      const errorMsg = (error as Error)?.message || 'Unknown error';
      setSessions(prev => prev.map(s =>
        s.id === sessionId ? {
          ...s,
          fileTree: [],
          fileTreeError: `Cannot access directory: ${cwd}\n${errorMsg}`
        } : s
      ));
    }
  }, [sessions]);

  // Load file tree when active session changes
  useEffect(() => {
    const session = sessions.find(s => s.id === activeSessionId);
    if (!session) return;

    // Only load if file tree is empty
    if (!session.fileTree || session.fileTree.length === 0) {
      loadFileTree(session.cwd).then(tree => {
        setSessions(prev => prev.map(s =>
          s.id === activeSessionId ? { ...s, fileTree: tree, fileTreeError: undefined } : s
        ));
      }).catch(error => {
        console.error('File tree error:', error);
        const errorMsg = error?.message || 'Unknown error';
        setSessions(prev => prev.map(s =>
          s.id === activeSessionId ? {
            ...s,
            fileTree: [],
            fileTreeError: `Cannot access directory: ${session.cwd}\n${errorMsg}`
          } : s
        ));
      });
    }
  }, [activeSessionId, sessions]);

  // Filter file tree based on search query
  const filteredFileTree = useMemo(() => {
    if (!activeSession || !fileTreeFilter || !activeSession.fileTree) {
      return activeSession?.fileTree || [];
    }

    const filterTree = (nodes: any[]): any[] => {
      return nodes.reduce((acc: any[], node) => {
        const matchesFilter = fuzzyMatch(node.name, fileTreeFilter);

        if (node.type === 'folder' && node.children) {
          const filteredChildren = filterTree(node.children);
          // Include folder if it matches or has matching children
          if (matchesFilter || filteredChildren.length > 0) {
            acc.push({
              ...node,
              children: filteredChildren
            });
          }
        } else if (node.type === 'file' && matchesFilter) {
          acc.push(node);
        }

        return acc;
      }, []);
    };

    return filterTree(activeSession.fileTree);
  }, [activeSession?.fileTree, fileTreeFilter]);

  // Update flat file list when active session's tree, expanded folders, or filter changes
  useEffect(() => {
    if (!activeSession || !activeSession.fileExplorerExpanded) {
      setFlatFileList([]);
      return;
    }
    const expandedSet = new Set(activeSession.fileExplorerExpanded);
    // Use filteredFileTree when available (it returns the full tree when no filter is active)
    setFlatFileList(flattenTree(filteredFileTree, expandedSet));
  }, [activeSession?.fileExplorerExpanded, filteredFileTree]);

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
      // Only handle when right panel is focused and on files tab
      if (activeFocus !== 'right' || activeRightTab !== 'files' || flatFileList.length === 0) return;

      const expandedFolders = new Set(activeSession.fileExplorerExpanded || []);

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
  }, [activeFocus, activeRightTab, flatFileList, selectedFileIndex, activeSession?.fileExplorerExpanded, activeSessionId, setSessions, toggleFolder, handleFileClick]);

  return (
      <div className={`flex h-screen w-full font-mono overflow-hidden transition-colors duration-300 ${isMobileLandscape ? 'pt-0' : 'pt-10'}`}
           style={{
             backgroundColor: theme.colors.bgMain,
             color: theme.colors.textMain,
             fontFamily: fontFamily,
             fontSize: `${fontSize}px`
           }}>

      {/* --- DRAGGABLE TITLE BAR (hidden in mobile landscape) --- */}
      {!isMobileLandscape && (
      <div
        className="fixed top-0 left-0 right-0 h-10 flex items-center justify-center"
        style={{
          WebkitAppRegion: 'drag',
        } as React.CSSProperties}
      >
        {activeSession && (
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
                  (activeTab.claudeSessionId ? activeTab.claudeSessionId.split('-')[0].toUpperCase() : null);
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

      {/* --- MODALS --- */}
      {quickActionOpen && (
        <QuickActionsModal
          theme={theme}
          sessions={sessions}
          setSessions={setSessions}
          activeSessionId={activeSessionId}
          groups={groups}
          setGroups={setGroups}
          shortcuts={shortcuts}
          initialMode={quickActionInitialMode}
          setQuickActionOpen={setQuickActionOpen}
          setActiveSessionId={setActiveSessionId}
          addNewSession={addNewSession}
          setRenameInstanceValue={setRenameInstanceValue}
          setRenameInstanceModalOpen={setRenameInstanceModalOpen}
          setRenameGroupId={setRenameGroupId}
          setRenameGroupValue={setRenameGroupValue}
          setRenameGroupEmoji={setRenameGroupEmoji}
          setRenameGroupModalOpen={setRenameGroupModalOpen}
          setNewGroupName={setNewGroupName}
          setMoveSessionToNewGroup={setMoveSessionToNewGroup}
          setCreateGroupModalOpen={setCreateGroupModalOpen}
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
          setActiveRightTab={setActiveRightTab}
          setAgentSessionsOpen={setAgentSessionsOpen}
          setActiveClaudeSessionId={setActiveClaudeSessionId}
          setGitDiffPreview={setGitDiffPreview}
          setGitLogOpen={setGitLogOpen}
          isAiMode={activeSession?.inputMode === 'ai'}
          tabShortcuts={TAB_SHORTCUTS}
          onRenameTab={() => {
            if (activeSession?.inputMode === 'ai' && activeSession.activeTabId) {
              const activeTab = activeSession.aiTabs?.find(t => t.id === activeSession.activeTabId);
              // Only allow rename if tab has an active Claude session
              if (activeTab?.claudeSessionId) {
                setRenameTabId(activeTab.id);
                setRenameTabInitialName(activeTab.name || '');
                setRenameTabModalOpen(true);
              }
            }
          }}
          onToggleReadOnlyMode={() => {
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
          }}
          onOpenTabSwitcher={() => {
            if (activeSession?.inputMode === 'ai' && activeSession.aiTabs) {
              setTabSwitcherOpen(true);
            }
          }}
          setPlaygroundOpen={setPlaygroundOpen}
          onRefreshGitFileState={async () => {
            if (activeSessionId) {
              await refreshGitFileState(activeSessionId);
              setSuccessFlashNotification('Files, Git, History Refreshed');
              setTimeout(() => setSuccessFlashNotification(null), 2000);
            }
          }}
          onDebugReleaseQueuedItem={() => {
            if (!activeSession || activeSession.executionQueue.length === 0) return;
            const [nextItem, ...remainingQueue] = activeSession.executionQueue;
            // Update state to remove item from queue
            setSessions(prev => prev.map(s => {
              if (s.id !== activeSessionId) return s;
              return { ...s, executionQueue: remainingQueue };
            }));
            // Process the item
            processQueuedItem(activeSessionId, nextItem);
            console.log('[Debug] Released queued item:', nextItem);
          }}
          markdownEditMode={markdownEditMode}
          onToggleMarkdownEditMode={() => setMarkdownEditMode(!markdownEditMode)}
          setUpdateCheckModalOpen={setUpdateCheckModalOpen}
          openWizard={openWizardModal}
          wizardGoToStep={wizardGoToStep}
          setDebugWizardModalOpen={setDebugWizardModalOpen}
          startTour={() => {
            setTourFromWizard(false);
            setTourOpen(true);
          }}
        />
      )}
      {lightboxImage && (
        <LightboxModal
          image={lightboxImage}
          stagedImages={lightboxImages.length > 0 ? lightboxImages : stagedImages}
          onClose={() => {
            setLightboxImage(null);
            setLightboxImages([]);
            // Return focus to input after closing carousel
            setTimeout(() => inputRef.current?.focus(), 0);
          }}
          onNavigate={(img) => setLightboxImage(img)}
        />
      )}

      {/* --- GIT DIFF VIEWER --- */}
      {gitDiffPreview && activeSession && (
        <GitDiffViewer
          diffText={gitDiffPreview}
          cwd={gitViewerCwd}
          theme={theme}
          onClose={handleCloseGitDiff}
        />
      )}

      {/* --- GIT LOG VIEWER --- */}
      {gitLogOpen && activeSession && (
        <GitLogViewer
          cwd={gitViewerCwd}
          theme={theme}
          onClose={handleCloseGitLog}
        />
      )}

      {/* --- SHORTCUTS HELP MODAL --- */}
      {shortcutsHelpOpen && (
        <ShortcutsHelpModal
          theme={theme}
          shortcuts={shortcuts}
          onClose={() => setShortcutsHelpOpen(false)}
          hasNoAgents={hasNoAgents}
        />
      )}

      {/* --- ABOUT MODAL --- */}
      {aboutModalOpen && (
        <AboutModal
          theme={theme}
          sessions={sessions}
          autoRunStats={autoRunStats}
          onClose={() => setAboutModalOpen(false)}
          onOpenLeaderboardRegistration={() => {
            setAboutModalOpen(false);
            setLeaderboardRegistrationOpen(true);
          }}
          isLeaderboardRegistered={isLeaderboardRegistered}
        />
      )}

      {/* --- LEADERBOARD REGISTRATION MODAL --- */}
      {leaderboardRegistrationOpen && (
        <LeaderboardRegistrationModal
          theme={theme}
          autoRunStats={autoRunStats}
          existingRegistration={leaderboardRegistration}
          onClose={() => setLeaderboardRegistrationOpen(false)}
          onSave={(registration) => {
            setLeaderboardRegistration(registration);
          }}
        />
      )}

      {/* --- UPDATE CHECK MODAL --- */}
      {updateCheckModalOpen && (
        <UpdateCheckModal
          theme={theme}
          onClose={() => setUpdateCheckModalOpen(false)}
        />
      )}

      {/* --- FIRST RUN CELEBRATION OVERLAY --- */}
      {firstRunCelebrationData && (
        <FirstRunCelebration
          theme={theme}
          elapsedTimeMs={firstRunCelebrationData.elapsedTimeMs}
          completedTasks={firstRunCelebrationData.completedTasks}
          totalTasks={firstRunCelebrationData.totalTasks}
          onClose={() => setFirstRunCelebrationData(null)}
          onOpenLeaderboardRegistration={() => setLeaderboardRegistrationOpen(true)}
          isLeaderboardRegistered={isLeaderboardRegistered}
        />
      )}

      {/* --- STANDING OVATION OVERLAY --- */}
      {standingOvationData && (
        <StandingOvationOverlay
          theme={theme}
          themeMode={theme.mode}
          badge={standingOvationData.badge}
          isNewRecord={standingOvationData.isNewRecord}
          recordTimeMs={standingOvationData.recordTimeMs}
          cumulativeTimeMs={autoRunStats.cumulativeTimeMs}
          onClose={() => {
            // Mark badge as acknowledged when user clicks "Take a Bow"
            acknowledgeBadge(standingOvationData.badge.level);
            setStandingOvationData(null);
          }}
          onOpenLeaderboardRegistration={() => setLeaderboardRegistrationOpen(true)}
          isLeaderboardRegistered={isLeaderboardRegistered}
        />
      )}

      {/* --- PROCESS MONITOR --- */}
      {processMonitorOpen && (
        <ProcessMonitor
          theme={theme}
          sessions={sessions}
          groups={groups}
          onClose={() => setProcessMonitorOpen(false)}
          onNavigateToSession={(sessionId, tabId) => {
            setActiveSessionId(sessionId);
            if (tabId) {
              // Switch to the specific tab within the session
              setSessions(prev => prev.map(s =>
                s.id === sessionId ? { ...s, activeTabId: tabId } : s
              ));
            }
          }}
        />
      )}

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

      {/* --- CREATE GROUP MODAL --- */}
      {createGroupModalOpen && (
        <CreateGroupModal
          theme={theme}
          onClose={() => {
            setCreateGroupModalOpen(false);
            setMoveSessionToNewGroup(false);
          }}
          groups={groups}
          setGroups={setGroups}
          sessions={sessions}
          setSessions={setSessions}
          activeSessionId={activeSessionId}
          moveSessionToNewGroup={moveSessionToNewGroup}
          setMoveSessionToNewGroup={setMoveSessionToNewGroup}
        />
      )}

      {/* --- CONFIRMATION MODAL --- */}
      {confirmModalOpen && (
        <ConfirmModal
          theme={theme}
          message={confirmModalMessage}
          onConfirm={confirmModalOnConfirm}
          onClose={() => setConfirmModalOpen(false)}
        />
      )}

      {/* --- RENAME INSTANCE MODAL --- */}
      {renameInstanceModalOpen && (
        <RenameSessionModal
          theme={theme}
          value={renameInstanceValue}
          setValue={setRenameInstanceValue}
          onClose={() => {
            setRenameInstanceModalOpen(false);
            setRenameInstanceSessionId(null);
          }}
          sessions={sessions}
          setSessions={setSessions}
          activeSessionId={activeSessionId}
          targetSessionId={renameInstanceSessionId || undefined}
        />
      )}

      {/* --- RENAME TAB MODAL --- */}
      {renameTabModalOpen && renameTabId && (
        <RenameTabModal
          theme={theme}
          initialName={renameTabInitialName}
          claudeSessionId={activeSession?.aiTabs?.find(t => t.id === renameTabId)?.claudeSessionId}
          onClose={() => {
            setRenameTabModalOpen(false);
            setRenameTabId(null);
          }}
          onRename={(newName: string) => {
            if (!activeSession || !renameTabId) return;
            setSessions(prev => prev.map(s => {
              if (s.id !== activeSession.id) return s;
              // Find the tab to get its claudeSessionId for persistence
              const tab = s.aiTabs.find(t => t.id === renameTabId);
              if (tab?.claudeSessionId) {
                // Persist name to Claude session metadata (async, fire and forget)
                window.maestro.claude.updateSessionName(
                  s.cwd,
                  tab.claudeSessionId,
                  newName || ''
                ).catch(err => console.error('Failed to persist tab name:', err));
              }
              return {
                ...s,
                aiTabs: s.aiTabs.map(tab =>
                  tab.id === renameTabId ? { ...tab, name: newName || null } : tab
                )
              };
            }));
          }}
        />
      )}

      {/* --- RENAME GROUP MODAL --- */}
      {renameGroupModalOpen && renameGroupId && (
        <RenameGroupModal
          theme={theme}
          groupId={renameGroupId}
          groupName={renameGroupValue}
          setGroupName={setRenameGroupValue}
          groupEmoji={renameGroupEmoji}
          setGroupEmoji={setRenameGroupEmoji}
          onClose={() => setRenameGroupModalOpen(false)}
          groups={groups}
          setGroups={setGroups}
        />
      )}

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
            addNewSession={addNewSession}
            setRenameInstanceModalOpen={setRenameInstanceModalOpen}
            setRenameInstanceValue={setRenameInstanceValue}
            setRenameInstanceSessionId={setRenameInstanceSessionId}
            activeBatchSessionIds={activeBatchSessionIds}
            showSessionJumpNumbers={showSessionJumpNumbers}
            visibleSessions={visibleSessions}
            autoRunStats={autoRunStats}
            openWizard={openWizardModal}
            startTour={() => {
              setTourFromWizard(false);
              setTourOpen(true);
            }}
          />
        </ErrorBoundary>
      )}

      {/* --- CENTER WORKSPACE (hidden when no sessions) --- */}
      {sessions.length > 0 && (
      <MainPanel
        logViewerOpen={logViewerOpen}
        agentSessionsOpen={agentSessionsOpen}
        activeClaudeSessionId={activeClaudeSessionId}
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
        setActiveClaudeSessionId={setActiveClaudeSessionId}
        onResumeClaudeSession={(claudeSessionId: string, messages: LogEntry[], sessionName?: string, starred?: boolean) => {
          // Opens the Claude session as a new tab (or switches to existing tab if duplicate)
          handleResumeSession(claudeSessionId, messages, sessionName, starred);
        }}
        onNewClaudeSession={() => {
          // Create a fresh AI tab
          if (activeSession) {
            setSessions(prev => prev.map(s => {
              if (s.id !== activeSession.id) return s;
              const result = createTab(s, { saveToHistory: defaultSaveToHistory });
              return result.session;
            }));
            setActiveClaudeSessionId(null);
          }
          setAgentSessionsOpen(false);
        }}
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
            // Use the active tab's claudeSessionId, not the deprecated session-level one
            const claudeSessionId = activeTab.claudeSessionId;
            if (claudeSessionId && activeSession.cwd) {
              // Delete asynchronously - don't block the UI update
              window.maestro.claude.deleteMessagePair(
                activeSession.cwd,
                claudeSessionId,
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
        onRemoveQueuedItem={(itemId: string) => {
          if (!activeSession) return;
          setSessions(prev => prev.map(s => {
            if (s.id !== activeSession.id) return s;
            return {
              ...s,
              executionQueue: s.executionQueue.filter(item => item.id !== itemId)
            };
          }));
        }}
        onOpenQueueBrowser={() => setQueueBrowserOpen(true)}
        audioFeedbackCommand={audioFeedbackCommand}
        // Tab management handlers
        onTabSelect={(tabId: string) => {
          if (!activeSession) return;
          // Use functional setState to compute new session from fresh state (avoids stale closure issues)
          setSessions(prev => prev.map(s => {
            if (s.id !== activeSession.id) return s;
            const result = setActiveTab(s, tabId); // Use 's' from prev, not stale 'activeSession'
            return result ? result.session : s;
          }));
        }}
        onTabClose={(tabId: string) => {
          if (!activeSession) return;
          // Use functional setState to compute from fresh state (avoids stale closure issues)
          setSessions(prev => prev.map(s => {
            if (s.id !== activeSession.id) return s;
            const result = closeTab(s, tabId);
            return result ? result.session : s;
          }));
        }}
        onNewTab={() => {
          if (!activeSession) return;
          // Use functional setState to compute from fresh state (avoids stale closure issues)
          setSessions(prev => prev.map(s => {
            if (s.id !== activeSession.id) return s;
            const result = createTab(s, { saveToHistory: defaultSaveToHistory });
            return result.session;
          }));
        }}
        onTabRename={(tabId: string, newName: string) => {
          if (!activeSession) return;
          // Update tab state
          setSessions(prev => prev.map(s => {
            if (s.id !== activeSession.id) return s;
            // Find the tab to get its claudeSessionId for persistence
            const tab = s.aiTabs.find(t => t.id === tabId);
            if (tab?.claudeSessionId) {
              // Persist name to Claude session metadata (async, fire and forget)
              window.maestro.claude.updateSessionName(
                s.cwd,
                tab.claudeSessionId,
                newName || ''
              ).catch(err => console.error('Failed to persist tab name:', err));
            }
            return {
              ...s,
              aiTabs: s.aiTabs.map(t =>
                t.id === tabId ? { ...t, name: newName || null } : t
              )
            };
          }));
        }}
        onRequestTabRename={(tabId: string) => {
          if (!activeSession) return;
          const tab = activeSession.aiTabs?.find(t => t.id === tabId);
          if (tab) {
            setRenameTabId(tabId);
            setRenameTabInitialName(tab.name || '');
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
        onCloseOtherTabs={(tabId: string) => {
          if (!activeSession) return;
          // Use functional setState to compute from fresh state (avoids stale closure issues)
          setSessions(prev => prev.map(s => {
            if (s.id !== activeSession.id || !s.aiTabs) return s;
            const tabToKeep = s.aiTabs.find(t => t.id === tabId);
            if (!tabToKeep) return s;
            return { ...s, aiTabs: [tabToKeep], activeTabId: tabId };
          }));
        }}
        onUpdateTabByClaudeSessionId={(claudeSessionId: string, updates: { name?: string | null; starred?: boolean }) => {
          // Update the AITab that matches this Claude session ID
          // This is called when a session is renamed or starred in the AgentSessionsBrowser
          if (!activeSession) return;
          setSessions(prev => prev.map(s => {
            if (s.id !== activeSession.id) return s;
            const tabIndex = s.aiTabs.findIndex(tab => tab.claudeSessionId === claudeSessionId);
            if (tabIndex === -1) return s; // Session not open as a tab
            return {
              ...s,
              aiTabs: s.aiTabs.map(tab =>
                tab.claudeSessionId === claudeSessionId
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
          setSessions(prev => prev.map(s => {
            if (s.id !== activeSession.id) return s;
            // Find the tab to get its claudeSessionId for persistence
            const tab = s.aiTabs.find(t => t.id === tabId);
            if (tab?.claudeSessionId) {
              // Persist starred status to Claude session metadata (async, fire and forget)
              window.maestro.claude.updateSessionStarred(
                s.cwd,
                tab.claudeSessionId,
                starred
              ).catch(err => console.error('Failed to persist tab starred:', err));
            }
            return {
              ...s,
              aiTabs: s.aiTabs.map(t =>
                t.id === tabId ? { ...t, starred } : t
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
      />
      )}

      {/* --- RIGHT PANEL (hidden in mobile landscape and when no sessions) --- */}
      {!isMobileLandscape && sessions.length > 0 && (
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
            autoRunDocumentList={autoRunDocumentList}
            autoRunDocumentTree={autoRunDocumentTree}
            autoRunContent={autoRunContent}
            autoRunContentVersion={autoRunContentVersion}
            autoRunIsLoadingDocuments={autoRunIsLoadingDocuments}
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
            onJumpToClaudeSession={handleJumpToClaudeSession}
            onResumeSession={handleResumeSession}
            onOpenSessionAsTab={handleResumeSession}
            onOpenAboutModal={() => setAboutModalOpen(true)}
          />
        </ErrorBoundary>
      )}

      {/* --- AUTO RUN SETUP MODAL --- */}
      {autoRunSetupModalOpen && (
        <AutoRunSetupModal
          theme={theme}
          onClose={() => setAutoRunSetupModalOpen(false)}
          onFolderSelected={handleAutoRunFolderSelected}
          currentFolder={activeSession?.autoRunFolderPath}
          sessionName={activeSession?.name}
        />
      )}

      {/* --- BATCH RUNNER MODAL --- */}
      {batchRunnerModalOpen && activeSession && activeSession.autoRunFolderPath && (
        <BatchRunnerModal
          theme={theme}
          onClose={() => setBatchRunnerModalOpen(false)}
          onGo={handleStartBatchRun}
          onSave={(prompt) => {
            // Save the custom prompt and modification timestamp to the session (persisted across restarts)
            setSessions(prev => prev.map(s =>
              s.id === activeSession.id ? { ...s, batchRunnerPrompt: prompt, batchRunnerPromptModifiedAt: Date.now() } : s
            ));
          }}
          initialPrompt={activeSession.batchRunnerPrompt || ''}
          lastModifiedAt={activeSession.batchRunnerPromptModifiedAt}
          showConfirmation={showConfirmation}
          folderPath={activeSession.autoRunFolderPath}
          currentDocument={activeSession.autoRunSelectedFile || ''}
          allDocuments={autoRunDocumentList}
          getDocumentTaskCount={getDocumentTaskCount}
          onRefreshDocuments={handleAutoRunRefresh}
          sessionId={activeSession.id}
          sessionCwd={activeSession.cwd}
          ghPath={ghPath}
        />
      )}

      {/* --- TAB SWITCHER MODAL --- */}
      {tabSwitcherOpen && activeSession?.aiTabs && (
        <TabSwitcherModal
          theme={theme}
          tabs={activeSession.aiTabs}
          activeTabId={activeSession.activeTabId}
          projectRoot={activeSession.projectRoot}
          shortcut={TAB_SHORTCUTS.tabSwitcher}
          onTabSelect={(tabId) => {
            setSessions(prev => prev.map(s =>
              s.id === activeSession.id ? { ...s, activeTabId: tabId } : s
            ));
          }}
          onNamedSessionSelect={(claudeSessionId, _projectPath, sessionName, starred) => {
            // Open a closed named session as a new tab - use handleResumeSession to properly load messages
            handleResumeSession(claudeSessionId, [], sessionName, starred);
            // Focus input so user can start interacting immediately
            setActiveFocus('main');
            setTimeout(() => inputRef.current?.focus(), 50);
          }}
          onClose={() => setTabSwitcherOpen(false)}
        />
      )}

      {/* --- PROMPT COMPOSER MODAL --- */}
      <PromptComposerModal
        isOpen={promptComposerOpen}
        onClose={() => {
          setPromptComposerOpen(false);
          setTimeout(() => inputRef.current?.focus(), 0);
        }}
        theme={theme}
        initialValue={inputValue}
        onSubmit={(value) => setInputValue(value)}
        onSend={(value) => {
          // Set the input value and trigger send
          setInputValue(value);
          // Use setTimeout to ensure state updates before processing
          setTimeout(() => processInput(value), 0);
        }}
        sessionName={activeSession?.name}
        // Image attachment props - share with main input area
        stagedImages={stagedImages}
        setStagedImages={setStagedImages}
        onOpenLightbox={handleSetLightboxImage}
        // Bottom bar toggles - get from active tab
        tabSaveToHistory={activeSession ? getActiveTab(activeSession)?.saveToHistory ?? false : false}
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
        tabReadOnlyMode={activeSession ? getActiveTab(activeSession)?.readOnlyMode ?? false : false}
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
        enterToSend={enterToSendAI}
        onToggleEnterToSend={() => setEnterToSendAI(!enterToSendAI)}
      />

      {/* --- EXECUTION QUEUE BROWSER --- */}
      <ExecutionQueueBrowser
        isOpen={queueBrowserOpen}
        onClose={() => setQueueBrowserOpen(false)}
        sessions={sessions}
        activeSessionId={activeSessionId}
        theme={theme}
        onRemoveItem={(sessionId, itemId) => {
          setSessions(prev => prev.map(s => {
            if (s.id !== sessionId) return s;
            return {
              ...s,
              executionQueue: s.executionQueue.filter(item => item.id !== itemId)
            };
          }));
        }}
        onSwitchSession={(sessionId) => {
          setActiveSessionId(sessionId);
        }}
        onReorderItems={(sessionId, fromIndex, toIndex) => {
          setSessions(prev => prev.map(s => {
            if (s.id !== sessionId) return s;
            const queue = [...s.executionQueue];
            const [removed] = queue.splice(fromIndex, 1);
            queue.splice(toIndex, 0, removed);
            return { ...s, executionQueue: queue };
          }));
        }}
      />

      {/* Old settings modal removed - using new SettingsModal component below */}

      {/* --- NEW INSTANCE MODAL --- */}
      <NewInstanceModal
        isOpen={newInstanceModalOpen}
        onClose={() => setNewInstanceModalOpen(false)}
        onCreate={createNewSession}
        theme={theme}
        defaultAgent={defaultAgent}
        existingSessions={sessionsForValidation}
      />

      {/* --- SETTINGS MODAL (New Component) --- */}
      <SettingsModal
        isOpen={settingsModalOpen}
        onClose={handleCloseSettings}
        theme={theme}
        themes={THEMES}
        activeThemeId={activeThemeId}
        setActiveThemeId={setActiveThemeId}
        llmProvider={llmProvider}
        setLlmProvider={setLlmProvider}
        modelSlug={modelSlug}
        setModelSlug={setModelSlug}
        apiKey={apiKey}
        setApiKey={setApiKey}
        shortcuts={shortcuts}
        setShortcuts={setShortcuts}
        defaultAgent={defaultAgent}
        setDefaultAgent={setDefaultAgent}
        defaultShell={defaultShell}
        setDefaultShell={setDefaultShell}
        ghPath={ghPath}
        setGhPath={setGhPath}
        enterToSendAI={enterToSendAI}
        setEnterToSendAI={setEnterToSendAI}
        enterToSendTerminal={enterToSendTerminal}
        setEnterToSendTerminal={setEnterToSendTerminal}
        defaultSaveToHistory={defaultSaveToHistory}
        setDefaultSaveToHistory={setDefaultSaveToHistory}
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
        customAICommands={customAICommands}
        setCustomAICommands={setCustomAICommands}
        initialTab={settingsTab}
        hasNoAgents={hasNoAgents}
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
  );
}

