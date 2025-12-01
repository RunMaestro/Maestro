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
import { BatchRunnerModal } from './components/BatchRunnerModal';
import { ExecutionQueueBrowser } from './components/ExecutionQueueBrowser';
import { StandingOvationOverlay } from './components/StandingOvationOverlay';
import { PlaygroundPanel } from './components/PlaygroundPanel';
import { CONDUCTOR_BADGES } from './constants/conductorBadges';

// Import custom hooks
import { useBatchProcessor } from './hooks/useBatchProcessor';
import { useSettings, useActivityTracker, useMobileLandscape, useNavigationHistory } from './hooks';
import { useTabCompletion } from './hooks/useTabCompletion';

// Import contexts
import { useLayerStack } from './contexts/LayerStackContext';
import { useToast } from './contexts/ToastContext';
import { ToastContainer } from './components/Toast';

// Import services
import { gitService } from './services/git';

// Import types and constants
import type {
  ToolType, SessionState, RightPanelTab,
  FocusArea, LogEntry, Session, Group, AITab, UsageStats, QueuedItem
} from './types';
import { THEMES } from './constants/themes';
import { generateId } from './utils/ids';
import { getContextColor } from './utils/theme';
import { fuzzyMatch } from './utils/search';
import { setActiveTab, createTab, closeTab, reopenClosedTab, getActiveTab, getWriteModeTab, navigateToNextTab, navigateToPrevTab, navigateToTabByIndex, navigateToLastTab } from './utils/tabHelpers';
import { TAB_SHORTCUTS } from './constants/shortcuts';
import { shouldOpenExternally, loadFileTree, getAllFolderPaths, flattenTree } from './utils/fileExplorer';
import { substituteTemplateVariables } from './utils/templateVariables';

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

  // --- SETTINGS (from useSettings hook) ---
  const settings = useSettings();
  const {
    settingsLoaded,
    llmProvider, setLlmProvider,
    modelSlug, setModelSlug,
    apiKey, setApiKey,
    tunnelProvider, setTunnelProvider,
    tunnelApiKey, setTunnelApiKey,
    defaultAgent, setDefaultAgent,
    defaultShell, setDefaultShell,
    fontFamily, setFontFamily,
    fontSize, setFontSize,
    activeThemeId, setActiveThemeId,
    enterToSendAI, setEnterToSendAI,
    enterToSendTerminal, setEnterToSendTerminal,
    leftSidebarWidth, setLeftSidebarWidth,
    rightPanelWidth, setRightPanelWidth,
    markdownRawMode, setMarkdownRawMode,
    terminalWidth, setTerminalWidth,
    logLevel, setLogLevel,
    maxLogBuffer, setMaxLogBuffer,
    maxOutputLines, setMaxOutputLines,
    osNotificationsEnabled, setOsNotificationsEnabled,
    audioFeedbackEnabled, setAudioFeedbackEnabled,
    audioFeedbackCommand, setAudioFeedbackCommand,
    toastDuration, setToastDuration,
    shortcuts, setShortcuts,
    customAICommands, setCustomAICommands,
    globalStats, updateGlobalStats,
    autoRunStats, recordAutoRunComplete,
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

  // File Explorer State
  const [previewFile, setPreviewFile] = useState<{name: string; content: string; path: string} | null>(null);
  const [selectedFileIndex, setSelectedFileIndex] = useState(0);
  const [flatFileList, setFlatFileList] = useState<any[]>([]);
  const [fileTreeFilter, setFileTreeFilter] = useState('');
  const [fileTreeFilterOpen, setFileTreeFilterOpen] = useState(false);

  // Git Diff State
  const [gitDiffPreview, setGitDiffPreview] = useState<string | null>(null);

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
  const [settingsTab, setSettingsTab] = useState<'general' | 'shortcuts' | 'theme' | 'network'>('general');
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);
  const [lightboxImages, setLightboxImages] = useState<string[]>([]); // Context images for navigation
  const [aboutModalOpen, setAboutModalOpen] = useState(false);
  const [standingOvationData, setStandingOvationData] = useState<{
    badge: typeof CONDUCTOR_BADGES[number];
    isNewRecord: boolean;
    recordTimeMs?: number;
  } | null>(null);
  const [logViewerOpen, setLogViewerOpen] = useState(false);
  const [processMonitorOpen, setProcessMonitorOpen] = useState(false);
  const [playgroundOpen, setPlaygroundOpen] = useState(false);
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

  // Flash notification state (for inline notifications like "Commands disabled while agent is working")
  const [flashNotification, setFlashNotification] = useState<string | null>(null);

  // Note: Images are now stored per-tab in AITab.stagedImages
  // See stagedImages/setStagedImages computed from active tab below

  // Global Live Mode State (web interface for all sessions)
  const [isLiveMode, setIsLiveMode] = useState(false);
  const [webInterfaceUrl, setWebInterfaceUrl] = useState<string | null>(null);

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
      // Sessions must have aiTabs - if missing, this is a data corruption issue
      if (!session.aiTabs || session.aiTabs.length === 0) {
        console.error('[restoreSession] Session has no aiTabs - data corruption, skipping:', session.id);
        return {
          ...session,
          aiPid: -1,
          terminalPid: -1,
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
          terminalPid: -1,
          state: 'error' as SessionState,
          isLive: false,
          liveUrl: undefined
        };
      }

      const terminalAgent = await window.maestro.agents.get('terminal');
      if (!terminalAgent) {
        console.error('Terminal agent not found');
        return {
          ...correctedSession,
          aiPid: -1,
          terminalPid: -1,
          state: 'error' as SessionState,
          isLive: false,
          liveUrl: undefined
        };
      }

      // Spawn BOTH processes for dual-process architecture
      // 1. Spawn AI agent process (skip for Claude batch mode - will spawn on first message)
      const isClaudeBatchMode = aiAgentType === 'claude' || aiAgentType === 'claude-code';
      let aiSpawnResult = { pid: 0, success: true }; // Default for batch mode

      if (!isClaudeBatchMode) {
        // Only spawn for non-batch-mode agents (Aider, etc.)
        // Include active tab ID in session ID to match batch mode format
        const activeTabId = correctedSession.activeTabId || correctedSession.aiTabs?.[0]?.id || 'default';
        // Use agent.path (full path) if available for better cross-environment compatibility
        aiSpawnResult = await window.maestro.process.spawn({
          sessionId: `${correctedSession.id}-ai-${activeTabId}`,
          toolType: aiAgentType,
          cwd: correctedSession.cwd,
          command: agent.path || agent.command,
          args: agent.args || []
        });
      }

      // 2. Spawn terminal process
      // Use terminalAgent.path (full path) if available
      const terminalSpawnResult = await window.maestro.process.spawn({
        sessionId: `${correctedSession.id}-terminal`,
        toolType: 'terminal',
        cwd: correctedSession.cwd,
        command: terminalAgent.path || terminalAgent.command,
        args: terminalAgent.args || []
      });

      // For batch mode (Claude), aiPid can be 0 since we don't spawn until first message
      const aiSuccess = aiSpawnResult.success && (isClaudeBatchMode || aiSpawnResult.pid > 0);

      if (aiSuccess && terminalSpawnResult.success && terminalSpawnResult.pid > 0) {
        // Check if the working directory is a Git repository
        const isGitRepo = await gitService.isRepo(correctedSession.cwd);

        // Session restored - no superfluous messages added to AI Terminal or Command Terminal
        return {
          ...correctedSession,
          aiPid: aiSpawnResult.pid,
          terminalPid: terminalSpawnResult.pid,
          state: 'idle' as SessionState,
          isGitRepo,  // Update Git status
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
          terminalPid: -1,
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
        terminalPid: -1,
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

        // If no sessions were loaded, automatically open the new agent modal
        if (!hasSessionsLoaded) {
          setNewInstanceModalOpen(true);
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

  // Set up process event listeners for real-time output
  useEffect(() => {
    // Handle process output data
    // sessionId will be in format: "{id}-ai-{tabId}", "{id}-terminal", "{id}-batch-{timestamp}", etc.
    const unsubscribeData = window.maestro.process.onData((sessionId: string, data: string) => {
      console.log('[onData] Received data for session:', sessionId, 'DataLen:', data.length, 'Preview:', data.substring(0, 200));

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
          const prevTextLen = updatedTabLogs[updatedTabLogs.length - 1].text.length;
          updatedTabLogs[updatedTabLogs.length - 1] = {
            ...updatedTabLogs[updatedTabLogs.length - 1],
            text: updatedTabLogs[updatedTabLogs.length - 1].text + data
          };
          console.log('[onData] GROUPED to tab:', targetTab.id, 'prevLen:', prevTextLen, 'newLen:', updatedTabLogs[updatedTabLogs.length - 1].text.length);
        } else {
          // Create new log entry
          const newLog: LogEntry = {
            id: generateId(),
            timestamp: Date.now(),
            source: 'stdout',
            text: data
          };
          updatedTabLogs = [...logsWithDelivery, newLog];
          console.log('[onData] NEW ENTRY to tab:', targetTab.id, 'dataLen:', data.length);
        }

        // Update the target tab's logs within the aiTabs array
        // Also mark as unread if this is not the active tab
        const isTargetTabActive = targetTab.id === s.activeTabId;
        const updatedAiTabs = s.aiTabs.map(tab =>
          tab.id === targetTab.id
            ? { ...tab, logs: updatedTabLogs, hasUnread: isTargetTabActive ? tab.hasUnread : true }
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
    const unsubscribeExit = window.maestro.process.onExit((sessionId: string, code: number) => {
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
          // Check if there are queued items in the execution queue
          if (currentSession.executionQueue.length > 0) {
            queuedItemToProcess = {
              sessionId: actualSessionId,
              item: currentSession.executionQueue[0]
            };
          } else {
            // Task complete - gather toast notification data
            // Use the SPECIFIC tab that just completed (from tabIdFromSession), NOT the active tab
            // This is critical for parallel tab execution where multiple tabs complete independently
            const completedTab = tabIdFromSession
              ? currentSession.aiTabs?.find(tab => tab.id === tabIdFromSession)
              : getActiveTab(currentSession);
            const logs = completedTab?.logs || [];
            const lastUserLog = logs.filter(log => log.source === 'user').pop();
            const lastAiLog = logs.filter(log => log.source === 'stdout' || log.source === 'ai').pop();
            const duration = currentSession.thinkingStartTime ? Date.now() - currentSession.thinkingStartTime : 0;

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

            // Check if this was a custom AI command that should trigger synopsis
            if (currentSession.pendingAICommandForSynopsis && currentSession.claudeSessionId) {
              synopsisData = {
                sessionId: actualSessionId,
                cwd: currentSession.cwd,
                claudeSessionId: currentSession.claudeSessionId,
                command: currentSession.pendingAICommandForSynopsis,
                groupName,
                projectName,
                tabName,
                tabId: completedTab?.id
              };
            }
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

            // IMPORTANT: First set the ORIGINAL tab (that just finished) to idle
            // Then set up the TARGET tab (next in queue) for processing
            // Also set target tab to 'busy' so thinking pill can find it via getWriteModeTab()
            let updatedAiTabs = s.aiTabs.map(tab => {
              // Set the original tab (that just finished) to idle
              if (tabIdFromSession && tab.id === tabIdFromSession) {
                console.log('[onExit] Setting original tab to idle before processing queue:', tab.id.substring(0, 8));
                return { ...tab, state: 'idle' as const };
              }
              // Set the target tab (next in queue) to busy with thinkingStartTime
              if (tab.id === targetTab.id) {
                console.log('[onExit] Setting target tab to busy for queue processing:', tab.id.substring(0, 8), 'name:', tab.name);
                return { ...tab, state: 'busy' as const, thinkingStartTime: Date.now() };
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
          console.log('[onExit] Setting tabs to idle:', {
            tabIdFromSession,
            tabIds: s.aiTabs?.map(t => t.id),
            tabStates: s.aiTabs?.map(t => ({ id: t.id.substring(0, 8), state: t.state }))
          });
          const updatedAiTabs = s.aiTabs?.length > 0
            ? s.aiTabs.map(tab => {
                if (tabIdFromSession) {
                  // New format: only update the specific tab
                  const shouldUpdate = tab.id === tabIdFromSession;
                  if (shouldUpdate) {
                    console.log('[onExit] Setting tab to idle:', tab.id.substring(0, 8));
                  }
                  return shouldUpdate ? { ...tab, state: 'idle' as const, thinkingStartTime: undefined } : tab;
                } else {
                  // Legacy format: update all busy tabs
                  return tab.state === 'busy' ? { ...tab, state: 'idle' as const, thinkingStartTime: undefined } : tab;
                }
              })
            : s.aiTabs;

          // Check if ANY other tabs are still busy (for parallel read-only execution)
          // Only set session to idle if no tabs are busy
          const anyTabStillBusy = updatedAiTabs.some(tab => tab.state === 'busy');
          console.log('[onExit] Any tab still busy?', anyTabStillBusy, 'tabs:', updatedAiTabs.map(t => ({ id: t.id.substring(0, 8), state: t.state })));

          // Task complete - also clear pending AI command flag
          return {
            ...s,
            state: anyTabStillBusy ? 'busy' as SessionState : 'idle' as SessionState,
            busySource: anyTabStillBusy ? s.busySource : undefined,
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

        return {
          ...s,
          state: 'idle' as SessionState,
          busySource: undefined,
          shellLogs: [...s.shellLogs, exitLog]
        };
      }));

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
            addHistoryEntryRef.current({
              type: 'USER',
              summary: result.response,
              claudeSessionId: synopsisData!.claudeSessionId
            });

            // Show toast for synopsis completion
            addToastRef.current({
              type: 'info',
              title: `Synopsis (${synopsisData!.command})`,
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
      console.log('[onSessionId] Received Claude session ID:', claudeSessionId, 'for session:', sessionId);

      // Ignore batch sessions - they have their own isolated session IDs that should NOT
      // contaminate the interactive session's claudeSessionId
      if (sessionId.includes('-batch-')) {
        console.log('[onSessionId] Ignoring batch session ID:', sessionId);
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
        console.log('[onSessionId] Parsed - actualSessionId:', actualSessionId, 'tabId:', tabId);
      } else {
        actualSessionId = sessionId;
        console.log('[onSessionId] No format match - using as-is:', actualSessionId);
      }

      // Store Claude session ID in session state and fetch commands if not already cached
      setSessions(prev => {
        const session = prev.find(s => s.id === actualSessionId);
        if (!session) return prev;

        // Check if we need to fetch commands (only on first session establishment)
        const needsCommandFetch = !session.claudeCommands && session.toolType === 'claude';

        if (needsCommandFetch) {
          // Fetch commands asynchronously and update session
          window.maestro.claude.getCommands(session.cwd).then(commands => {
            console.log('[onSessionId] Fetched Claude commands for session:', actualSessionId, commands.length, 'commands');
            setSessions(prevSessions => prevSessions.map(s => {
              if (s.id !== actualSessionId) return s;
              return { ...s, claudeCommands: commands };
            }));
          }).catch(err => {
            console.error('[onSessionId] Failed to fetch Claude commands:', err);
          });
        }

        // Register this as a user-initiated Maestro session (batch sessions are filtered above)
        // Do NOT pass session name - names should only be set when user explicitly renames
        window.maestro.claude.registerSessionOrigin(session.cwd, claudeSessionId, 'user')
          .then(() => console.log('[onSessionId] Registered session origin as user:', claudeSessionId))
          .catch(err => console.error('[onSessionId] Failed to register session origin:', err));

        return prev.map(s => {
          if (s.id !== actualSessionId) return s;

          // Find the target tab - use explicit tab ID from session ID if available
          // This ensures each process's session ID goes to the correct tab
          let targetTab;
          if (tabId) {
            // New format: tab ID is encoded in session ID
            targetTab = s.aiTabs?.find(tab => tab.id === tabId);
            console.log('[onSessionId] Looking for tab by ID:', tabId, 'found:', targetTab?.id, 'allTabIds:', s.aiTabs?.map(t => t.id));
          }

          // Fallback: find awaiting tab or active tab (for legacy format)
          if (!targetTab) {
            const awaitingTab = s.aiTabs?.find(tab => tab.awaitingSessionId && !tab.claudeSessionId);
            targetTab = awaitingTab || getActiveTab(s);
            console.log('[onSessionId] Fallback - awaitingTab:', awaitingTab?.id, 'activeTab:', getActiveTab(s)?.id, 'targetTab:', targetTab?.id);
          }

          if (!targetTab) {
            // No tabs exist - this is a bug, sessions must have aiTabs
            // Still store at session-level for web API compatibility
            console.error('[onSessionId] No target tab found - session has no aiTabs, storing at session level only');
            return { ...s, claudeSessionId };
          }

          // Skip if this tab already has a claudeSessionId (prevent overwriting)
          if (targetTab.claudeSessionId && targetTab.claudeSessionId !== claudeSessionId) {
            console.log('[onSessionId] Tab already has different claudeSessionId, skipping:', targetTab.id, 'existing:', targetTab.claudeSessionId, 'new:', claudeSessionId);
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

          console.log('[onSessionId] Storing Claude session ID on tab:', targetTab.id, 'claudeSessionId:', claudeSessionId, 'fromTabId:', tabId || 'legacy');
          return { ...s, aiTabs: updatedAiTabs, claudeSessionId }; // Also keep session-level for backwards compatibility
        });
      });
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
            state: 'idle' as SessionState,
            busySource: undefined,
            shellLogs: [...s.shellLogs, exitLog]
          };
        }

        return { ...s, state: 'idle' as SessionState, busySource: undefined };
      }));
    });

    // Handle usage statistics from AI responses
    const unsubscribeUsage = window.maestro.process.onUsage((sessionId: string, usageStats) => {
      console.log('[onUsage] Received usage stats:', usageStats, 'for session:', sessionId);

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

        // Calculate context window usage percentage
        // For a conversation, context contains all inputs and outputs
        // inputTokens = full input token count (already includes cache hits)
        // outputTokens = response tokens (become part of context in follow-up turns)
        // Note: cache tokens are about billing optimization, not context size
        // The actual context footprint is input + output tokens
        const contextTokens = usageStats.inputTokens + usageStats.outputTokens;
        const contextPercentage = Math.min(Math.round((contextTokens / usageStats.contextWindow) * 100), 100);

        // Accumulate cost if there's already usage stats (session-level for backwards compat)
        const existingCost = s.usageStats?.totalCostUsd || 0;

        // Current cycle tokens = output tokens from this response
        // (These are the NEW tokens added to the context, not the cumulative total)
        const cycleTokens = (s.currentCycleTokens || 0) + usageStats.outputTokens;

        // Update the specific tab's usageStats if we have a tabId
        let updatedAiTabs = s.aiTabs;
        if (tabId && s.aiTabs) {
          updatedAiTabs = s.aiTabs.map(tab => {
            if (tab.id !== tabId) return tab;
            // Accumulate cost for this specific tab
            const tabExistingCost = tab.usageStats?.totalCostUsd || 0;
            return {
              ...tab,
              usageStats: {
                ...usageStats,
                totalCostUsd: tabExistingCost + usageStats.totalCostUsd
              }
            };
          });
        }

        return {
          ...s,
          contextUsage: contextPercentage,
          currentCycleTokens: cycleTokens,
          usageStats: {
            ...usageStats,
            totalCostUsd: existingCost + usageStats.totalCostUsd
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

  // Tab completion hook for terminal mode
  const { getSuggestions: getTabCompletionSuggestions } = useTabCompletion(activeSession);

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
            state: 'idle'
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
        const result = createTab(s);
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

  // Combine built-in slash commands with custom AI commands for autocomplete
  // Filter out isSystemCommand entries since those are already in slashCommands with execute functions
  const allSlashCommands = useMemo(() => {
    const customCommandsAsSlash = customAICommands
      .filter(cmd => !cmd.isSystemCommand) // System commands are in slashCommands.ts
      .map(cmd => ({
        command: cmd.command,
        description: cmd.description,
        aiOnly: true, // Custom AI commands are only available in AI mode
        prompt: cmd.prompt, // Include prompt for execution
      }));
    return [...slashCommands, ...customCommandsAsSlash];
  }, [customAICommands]);

  // Derive current input value and setter based on active session mode
  // For AI mode: use active tab's inputValue (stored per-tab)
  // For terminal mode: use local state (shared across tabs)
  const isAiMode = activeSession?.inputMode === 'ai';
  const activeTab = activeSession ? getActiveTab(activeSession) : undefined;

  // Track previous active tab to detect tab switches
  const prevActiveTabIdRef = useRef<string | undefined>(activeTab?.id);

  // Sync local AI input with tab's persisted value when switching tabs
  useEffect(() => {
    if (activeTab && activeTab.id !== prevActiveTabIdRef.current) {
      // Tab changed - load the new tab's persisted input value
      setAiInputValueLocal(activeTab.inputValue ?? '');
      prevActiveTabIdRef.current = activeTab.id;
    }
    // Note: We intentionally only depend on activeTab?.id, NOT activeTab?.inputValue
    // The inputValue changes when we blur (syncAiInputToSession), but we don't want
    // to read it back into local state - that would cause a feedback loop.
    // We only need to load inputValue when switching TO a different tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab?.id]);

  // Function to persist AI input to session state (called on blur/submit)
  const syncAiInputToSession = useCallback((value: string) => {
    if (!activeSession) return;
    setSessions(prev => prev.map(s => {
      if (s.id !== activeSession.id) return s;
      const currentActiveTab = getActiveTab(s);
      if (!currentActiveTab) return s;
      return {
        ...s,
        aiTabs: s.aiTabs.map(tab =>
          tab.id === currentActiveTab.id
            ? { ...tab, inputValue: value }
            : tab
        )
      };
    }));
  }, [activeSession]);

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
    return getTabCompletionSuggestions(inputValue);
  }, [tabCompletionOpen, activeSession, inputValue, getTabCompletionSuggestions]);

  // --- BATCH PROCESSOR ---
  // Helper to spawn a Claude agent and wait for completion (for a specific session)
  const spawnAgentForSession = useCallback(async (sessionId: string, prompt: string): Promise<{ success: boolean; response?: string; claudeSessionId?: string; usageStats?: UsageStats }> => {
    const session = sessions.find(s => s.id === sessionId);
    if (!session) return { success: false };

    // This spawns a new Claude session and waits for completion
    try {
      const agent = await window.maestro.agents.get('claude-code');
      if (!agent) return { success: false };

      // For batch processing, use a unique session ID per task run to avoid contaminating the main AI terminal
      // This prevents batch output from appearing in the interactive AI terminal
      const targetSessionId = `${sessionId}-batch-${Date.now()}`;

      // Set session to busy with thinking start time
      // Also update active tab's state to 'busy' for write-mode tracking
      setSessions(prev => prev.map(s => {
        if (s.id !== sessionId) return s;

        const updatedAiTabs = s.aiTabs?.length > 0
          ? s.aiTabs.map(tab =>
              tab.id === s.activeTabId ? { ...tab, state: 'busy' as const } : tab
            )
          : s.aiTabs;

        return {
          ...s,
          state: 'busy' as SessionState,
          busySource: 'ai',
          thinkingStartTime: Date.now(),
          currentCycleTokens: 0,
          currentCycleBytes: 0,
          aiTabs: updatedAiTabs
        };
      }));

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
            // Clean up listeners and resolve
            cleanup();

            // Check for queued items BEFORE updating state (using sessionsRef for latest state)
            const currentSession = sessionsRef.current.find(s => s.id === sessionId);
            let queuedItemToProcess: { sessionId: string; item: QueuedItem } | null = null;

            if (currentSession && currentSession.executionQueue.length > 0) {
              queuedItemToProcess = {
                sessionId: sessionId,
                item: currentSession.executionQueue[0]
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
                    tab.state === 'busy' ? { ...tab, state: 'idle' as const } : tab
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

            resolve({ success: true, response: responseText, claudeSessionId, usageStats: taskUsageStats });
          }
        });

        // Spawn the agent with permission-mode plan for batch processing
        const commandToUse = agent.path || agent.command;
        const spawnArgs = [...(agent.args || []), '--permission-mode', 'plan'];
        window.maestro.process.spawn({
          sessionId: targetSessionId,
          toolType: 'claude-code',
          cwd: session.cwd,
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
  }, [sessions]);

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
  ): Promise<{ success: boolean; response?: string; claudeSessionId?: string }> => {
    try {
      const agent = await window.maestro.agents.get('claude-code');
      if (!agent) return { success: false };

      // Use a unique target ID for background synopsis
      const targetSessionId = `${sessionId}-synopsis-${Date.now()}`;

      return new Promise((resolve) => {
        let claudeSessionId: string | undefined;
        let responseText = '';

        let cleanupData: (() => void) | undefined;
        let cleanupSessionId: (() => void) | undefined;
        let cleanupExit: (() => void) | undefined;

        const cleanup = () => {
          cleanupData?.();
          cleanupSessionId?.();
          cleanupExit?.();
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

        cleanupExit = window.maestro.process.onExit((sid: string) => {
          if (sid === targetSessionId) {
            cleanup();
            resolve({ success: true, response: responseText, claudeSessionId });
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

  // Helper to add history entry
  const addHistoryEntry = useCallback(async (entry: { type: 'AUTO' | 'USER'; summary: string; fullResponse?: string; claudeSessionId?: string }) => {
    if (!activeSession) return;

    // Get session name and usageStats from active tab
    // Use tab-level usageStats to match what's displayed in the UI header
    const activeTab = getActiveTab(activeSession);
    const sessionName = activeTab?.name;
    const usageStats = activeTab?.usageStats || activeSession.usageStats;

    await window.maestro.history.add({
      id: generateId(),
      type: entry.type,
      timestamp: Date.now(),
      summary: entry.summary,
      fullResponse: entry.fullResponse,
      claudeSessionId: entry.claudeSessionId,
      sessionName: sessionName,
      projectPath: activeSession.cwd,
      contextUsage: activeSession.contextUsage,
      usageStats: usageStats
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
            tab.id === s.activeTabId ? { ...tab, state: 'idle' as const } : tab
          )
        : s.aiTabs;
      return { ...s, claudeSessionId: undefined, aiLogs: [], state: 'idle' as SessionState, aiTabs: updatedAiTabs };
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

        // Show Standing Ovation overlay for new badges or records
        if (newBadgeLevel !== null || isNewRecord) {
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
      }
    }
  });

  // Get batch state for the active session
  const activeBatchRunState = activeSession ? getBatchState(activeSession.id) : getBatchState('');

  // Initialize activity tracker for time tracking
  useActivityTracker(activeSessionId, setSessions);

  // Handler to open batch runner modal
  const handleOpenBatchRunner = useCallback(() => {
    setBatchRunnerModalOpen(true);
  }, []);

  // Handler to start batch run from modal
  const handleStartBatchRun = useCallback((prompt: string) => {
    if (!activeSession) return;
    setBatchRunnerModalOpen(false);
    startBatchRun(activeSession.id, activeSession.scratchPadContent, prompt);
  }, [activeSession, startBatchRun]);

  // Handler to stop batch run for active session (with confirmation)
  const handleStopBatchRun = useCallback(() => {
    if (!activeSession) return;
    const sessionId = activeSession.id;
    setConfirmModalMessage('Stop the batch run after the current task completes?');
    setConfirmModalOnConfirm(() => () => stopBatchRun(sessionId));
    setConfirmModalOpen(true);
  }, [activeSession, stopBatchRun]);

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

      // Create a new tab with the session data using the helper function
      const { session: updatedSession } = createTab(activeSession, {
        claudeSessionId,
        logs: messages,
        name,
        starred: isStarred
      });

      // Update the session and switch to AI mode
      setSessions(prev => prev.map(s =>
        s.id === activeSession.id
          ? { ...updatedSession, inputMode: 'ai' }
          : s
      ));
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
        .sort((a, b) => a.name.localeCompare(b.name));
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
    if (mainKey === '{' && key === '[') return true;
    if (mainKey === '}' && key === ']') return true;

    return key === mainKey;
  };

  // Check if a key event matches a tab shortcut (AI mode only)
  const isTabShortcut = (e: KeyboardEvent, actionId: string) => {
    const sc = TAB_SHORTCUTS[actionId];
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
    if (mainKey === '[' && key === '[') return true;
    if (mainKey === ']' && key === ']') return true;

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
        // Allow right panel tab shortcuts (Cmd+Shift+F/H/S/J) even when overlays are open
        const keyLower = e.key.toLowerCase();
        const isRightPanelShortcut = (e.metaKey || e.ctrlKey) && e.shiftKey && (keyLower === 'f' || keyLower === 'h' || keyLower === 's' || keyLower === 'j');
        // Allow system utility shortcuts (Alt+Cmd+L for logs, Alt+Cmd+P for processes) even when modals are open
        const isSystemUtilShortcut = e.altKey && (e.metaKey || e.ctrlKey) && (keyLower === 'l' || keyLower === 'p');
        // Allow session jump shortcuts (Alt+Cmd+NUMBER) even when modals are open
        const isSessionJumpShortcut = e.altKey && (e.metaKey || e.ctrlKey) && /^[0-9]$/.test(e.key);

        if (ctx.hasOpenModal()) {
          // TRUE MODAL is open - block most shortcuts from App.tsx
          // The modal's own handler will handle Cmd+Shift+[] if it supports it
          // BUT allow layout shortcuts (sidebar toggles), system utility shortcuts, and session jump to work
          if (!isLayoutShortcut && !isSystemUtilShortcut && !isSessionJumpShortcut) {
            return;
          }
          // Fall through to handle layout/system utility/session jump shortcuts below
        } else {
          // Only OVERLAYS are open (FilePreview, LogViewer, etc.)
          // Allow Cmd+Shift+[] to fall through to App.tsx handler
          // (which will cycle right panel tabs when previewFile is set)
          // Also allow right panel tab shortcuts to switch tabs while overlay is open
          if (!isCycleShortcut && !isLayoutShortcut && !isRightPanelShortcut && !isSystemUtilShortcut && !isSessionJumpShortcut) {
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
      if (ctx.activeFocus === 'sidebar' && (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === ' ')) {
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

      // Tab navigation
      if (e.key === 'Tab') {
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
      if (ctx.isShortcut(e, 'toggleSidebar')) ctx.setLeftSidebarOpen(p => !p);
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
        ctx.setQuickActionInitialMode('main');
        ctx.setQuickActionOpen(true);
      }
      else if (ctx.isShortcut(e, 'help')) ctx.setShortcutsHelpOpen(true);
      else if (ctx.isShortcut(e, 'settings')) { ctx.setSettingsModalOpen(true); ctx.setSettingsTab('general'); }
      else if (ctx.isShortcut(e, 'goToFiles')) { e.preventDefault(); ctx.setRightPanelOpen(true); ctx.setActiveRightTab('files'); ctx.setActiveFocus('right'); }
      else if (ctx.isShortcut(e, 'goToHistory')) { e.preventDefault(); ctx.setRightPanelOpen(true); ctx.setActiveRightTab('history'); ctx.setActiveFocus('right'); }
      else if (ctx.isShortcut(e, 'goToScratchpad')) { e.preventDefault(); ctx.setRightPanelOpen(true); ctx.setActiveRightTab('scratchpad'); ctx.setActiveFocus('right'); }
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
        if (ctx.isTabShortcut(e, 'newTab')) {
          e.preventDefault();
          const result = ctx.createTab(ctx.activeSession);
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
        if (ctx.isTabShortcut(e, 'nextTab')) {
          e.preventDefault();
          const result = ctx.navigateToNextTab(ctx.activeSession);
          if (result) {
            ctx.setSessions(prev => prev.map(s =>
              s.id === ctx.activeSession!.id ? result.session : s
            ));
          }
        }
        if (ctx.isTabShortcut(e, 'prevTab')) {
          e.preventDefault();
          const result = ctx.navigateToPrevTab(ctx.activeSession);
          if (result) {
            ctx.setSessions(prev => prev.map(s =>
              s.id === ctx.activeSession!.id ? result.session : s
            ));
          }
        }
        // Cmd+1 through Cmd+8: Jump to specific tab by index
        for (let i = 1; i <= 8; i++) {
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
        // Cmd+9: Jump to last tab
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

      // Forward slash to open file tree filter when file tree has focus
      if (e.key === '/' && ctx.activeFocus === 'right' && ctx.activeRightTab === 'files') {
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

      // Ungrouped sessions (sorted alphabetically)
      const ungroupedSessions = sessions
        .filter(s => !s.groupId)
        .sort((a, b) => compareNamesIgnoringEmojis(a.name, b.name));
      visualOrder.push(...ungroupedSessions);
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
    const newId = generateId();

    // Get agent definition to get correct command
    const agent = await window.maestro.agents.get(agentId);
    if (!agent) {
      console.error(`Agent not found: ${agentId}`);
      return;
    }

    // Get terminal agent definition
    const terminalAgent = await window.maestro.agents.get('terminal');
    if (!terminalAgent) {
      console.error('Terminal agent not found');
      return;
    }

    // Spawn BOTH processes - this is the dual-process architecture
    try {
      // 1. Spawn AI agent process
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

      // 2. Spawn terminal process
      // Use terminalAgent.path (full path) if available
      const terminalSpawnResult = await window.maestro.process.spawn({
        sessionId: `${newId}-terminal`,
        toolType: 'terminal',
        cwd: workingDir,
        command: terminalAgent.path || terminalAgent.command,
        args: terminalAgent.args || []
      });

      if (!terminalSpawnResult.success || terminalSpawnResult.pid <= 0) {
        throw new Error('Failed to spawn terminal process');
      }

      // Check if the working directory is a Git repository
      const isGitRepo = await gitService.isRepo(workingDir);

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
        state: 'idle'
      };

      const newSession: Session = {
        id: newId,
        name,
        toolType: agentId as ToolType,
        state: 'idle',
        cwd: workingDir,
        fullPath: workingDir,
        isGitRepo,
        aiLogs: [], // Deprecated - logs are now in aiTabs
        shellLogs: [{ id: generateId(), timestamp: Date.now(), source: 'system', text: 'Shell Session Ready.' }],
        workLog: [],
        scratchPadContent: '',
        contextUsage: 0,
        inputMode: agentId === 'terminal' ? 'terminal' : 'ai',
        // Store both PIDs - each session now has two processes
        aiPid: aiSpawnResult.pid,
        terminalPid: terminalSpawnResult.pid,
        port: 3000 + Math.floor(Math.random() * 100),
        isLive: false,
        changedFiles: [],
        fileTree: [],
        fileExplorerExpanded: [],
        fileExplorerScrollPos: 0,
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

  const toggleInputMode = () => {
    setSessions(prev => prev.map(s => {
      if (s.id !== activeSessionId) return s;
      return { ...s, inputMode: s.inputMode === 'ai' ? 'terminal' : 'ai' };
    }));
    // Close any open dropdowns when switching modes
    setTabCompletionOpen(false);
    setSlashCommandOpen(false);
  };

  // Toggle global live mode (enables web interface for all sessions)
  const toggleGlobalLive = async () => {
    try {
      if (isLiveMode) {
        // Turn off - stop the server and clear state
        const result = await window.maestro.live.disableAll();
        setIsLiveMode(false);
        setWebInterfaceUrl(null);
        console.log('[toggleGlobalLive] Stopped web server, disconnected', result.count, 'sessions');
      } else {
        // Turn on - start the server and get the URL
        const result = await window.maestro.live.startServer();
        if (result.success && result.url) {
          setIsLiveMode(true);
          setWebInterfaceUrl(result.url);
          console.log('[toggleGlobalLive] Started web server:', result.url);
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

  // Navigate back in history (through sessions and tabs)
  const handleNavBack = useCallback(() => {
    const entry = navigateBack();
    if (entry) {
      // Check if session still exists
      const sessionExists = sessions.some(s => s.id === entry.sessionId);
      if (sessionExists) {
        // Navigate to the session
        setActiveSessionIdInternal(entry.sessionId);
        cyclePositionRef.current = -1;

        // If there's a tab ID, also switch to that tab
        if (entry.tabId) {
          setSessions(prev => prev.map(s => {
            if (s.id === entry.sessionId && s.aiTabs?.some(t => t.id === entry.tabId)) {
              return { ...s, activeTabId: entry.tabId };
            }
            return s;
          }));
        }
      }
    }
  }, [navigateBack, sessions]);

  // Navigate forward in history (through sessions and tabs)
  const handleNavForward = useCallback(() => {
    const entry = navigateForward();
    if (entry) {
      // Check if session still exists
      const sessionExists = sessions.some(s => s.id === entry.sessionId);
      if (sessionExists) {
        // Navigate to the session
        setActiveSessionIdInternal(entry.sessionId);
        cyclePositionRef.current = -1;

        // If there's a tab ID, also switch to that tab
        if (entry.tabId) {
          setSessions(prev => prev.map(s => {
            if (s.id === entry.sessionId && s.aiTabs?.some(t => t.id === entry.tabId)) {
              return { ...s, activeTabId: entry.tabId };
            }
            return s;
          }));
        }
      }
    }
  }, [navigateForward, sessions]);

  // Update keyboardHandlerRef synchronously during render (before effects run)
  // This must be placed after all handler functions are defined to avoid TDZ errors
  keyboardHandlerRef.current = {
    shortcuts, activeFocus, activeRightTab, sessions, selectedSidebarIndex, activeSessionId,
    quickActionOpen, settingsModalOpen, shortcutsHelpOpen, newInstanceModalOpen, aboutModalOpen,
    processMonitorOpen, logViewerOpen, createGroupModalOpen, confirmModalOpen, renameInstanceModalOpen,
    renameGroupModalOpen, activeSession, previewFile, fileTreeFilter, fileTreeFilterOpen, gitDiffPreview,
    gitLogOpen, lightboxImage, hasOpenLayers, hasOpenModal, visibleSessions, sortedSessions, groups,
    bookmarksCollapsed, leftSidebarOpen, editingSessionId, editingGroupId,
    setLeftSidebarOpen, setRightPanelOpen, addNewSession, deleteSession, setQuickActionInitialMode,
    setQuickActionOpen, cycleSession, toggleInputMode, setShortcutsHelpOpen, setSettingsModalOpen,
    setSettingsTab, setActiveRightTab, setActiveFocus, setBookmarksCollapsed, setGroups,
    setSelectedSidebarIndex, setActiveSessionId, handleViewGitDiff, setGitLogOpen, setActiveClaudeSessionId,
    setAgentSessionsOpen, setLogViewerOpen, setProcessMonitorOpen, logsEndRef, inputRef, terminalOutputRef,
    setSessions, createTab, closeTab, reopenClosedTab, getActiveTab, setRenameTabId, setRenameTabInitialName,
    setRenameTabModalOpen, navigateToNextTab, navigateToPrevTab, navigateToTabByIndex, navigateToLastTab,
    setFileTreeFilterOpen, isShortcut, isTabShortcut, handleNavBack, handleNavForward
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

  const startRenamingSession = (sessId: string) => {
    setEditingSessionId(sessId);
  };

  const finishRenamingSession = (sessId: string, newName: string) => {
    setSessions(prev => {
      const updated = prev.map(s => s.id === sessId ? { ...s, name: newName } : s);
      // Sync the session name to Claude session storage for searchability
      const session = updated.find(s => s.id === sessId);
      if (session?.claudeSessionId && session.cwd) {
        console.log('[finishRenamingSession] Syncing session name to Claude storage:', {
          claudeSessionId: session.claudeSessionId,
          cwd: session.cwd,
          newName
        });
        window.maestro.claude.updateSessionName(session.cwd, session.claudeSessionId, newName)
          .then(() => console.log('[finishRenamingSession] Successfully synced session name'))
          .catch(err => console.warn('[finishRenamingSession] Failed to sync session name:', err));
      } else {
        console.log('[finishRenamingSession] Cannot sync - missing claudeSessionId or cwd:', {
          sessId,
          claudeSessionId: session?.claudeSessionId,
          cwd: session?.cwd
        });
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

  const updateScratchPad = useCallback((content: string) => {
    setSessions(prev => prev.map(s => s.id === activeSessionId ? { ...s, scratchPadContent: content } : s));
  }, [activeSessionId]);

  const updateScratchPadState = useCallback((state: {
    mode: 'edit' | 'preview';
    cursorPosition: number;
    editScrollPos: number;
    previewScrollPos: number;
  }) => {
    setSessions(prev => prev.map(s => s.id === activeSessionId ? {
      ...s,
      scratchPadMode: state.mode,
      scratchPadCursorPosition: state.cursorPosition,
      scratchPadEditScrollPos: state.editScrollPos,
      scratchPadPreviewScrollPos: state.previewScrollPos
    } : s));
  }, [activeSessionId]);

  const processInput = () => {
    console.log('[processInput] Called with:', {
      hasActiveSession: !!activeSession,
      activeSessionId: activeSession?.id,
      inputValue: inputValue?.substring(0, 50),
      inputValueLength: inputValue?.length,
      stagedImagesCount: stagedImages.length
    });
    if (!activeSession || (!inputValue.trim() && stagedImages.length === 0)) {
      console.log('[processInput] EARLY RETURN - missing activeSession or empty input');
      return;
    }

    // Sync local AI input to session state on submit (will be cleared anyway, but keeps state consistent)
    if (isAiMode) {
      syncAiInputToSession(inputValue);
    }

    // Block slash commands when agent is busy (in AI mode)
    if (inputValue.trim().startsWith('/') && activeSession.state === 'busy' && activeSession.inputMode === 'ai') {
      showFlashNotification('Commands disabled while agent is working');
      return;
    }

    // Note: Slash commands can now be queued (removed blocking logic)

    // Handle slash commands
    if (inputValue.trim().startsWith('/')) {
      const commandText = inputValue.trim();
      const isTerminalMode = activeSession.inputMode === 'terminal';
      const matchingCommand = slashCommands.find(cmd => {
        if (cmd.command !== commandText) return false;
        // Apply mode filtering (same as autocomplete)
        if (cmd.terminalOnly && !isTerminalMode) return false;
        if (cmd.aiOnly && isTerminalMode) return false;
        return true;
      });

      if (matchingCommand) {
        matchingCommand.execute({
          activeSessionId,
          sessions,
          setSessions,
          currentMode: activeSession.inputMode,
          groups,
          setRightPanelOpen,
          setActiveRightTab,
          setActiveFocus,
          setSelectedFileIndex,
          // Batch processing and synopsis context
          sendPromptToAgent: spawnAgentWithPrompt,
          addHistoryEntry,
          startNewClaudeSession,
          spawnBackgroundSynopsis,
          addToast,
          refreshHistoryPanel: () => rightPanelRef.current?.refreshHistoryPanel(),
          addLogToActiveTab,
        });

        setInputValue('');
        setSlashCommandOpen(false);
        if (inputRef.current) inputRef.current.style.height = 'auto';
        return;
      }

      // Check if command exists but isn't available in current mode
      const existingCommand = slashCommands.find(cmd => cmd.command === commandText);
      if (existingCommand) {
        // Command exists but not available in this mode - show error and don't send to AI
        const modeLabel = isTerminalMode ? 'AI' : 'terminal';
        const errorLog: LogEntry = {
          id: generateId(),
          timestamp: Date.now(),
          source: 'system',
          text: `${commandText} is only available in ${modeLabel} mode.`
        };
        setSessions(prev => prev.map(s => {
          if (s.id !== activeSessionId) return s;
          if (activeSession.inputMode === 'ai') {
            // Add to active tab's logs
            const activeTab = getActiveTab(s);
            if (!activeTab) return s;
            return {
              ...s,
              aiTabs: s.aiTabs.map(tab =>
                tab.id === activeTab.id ? { ...tab, logs: [...tab.logs, errorLog] } : tab
              )
            };
          } else {
            return { ...s, shellLogs: [...s.shellLogs, errorLog] };
          }
        }));
        setInputValue('');
        setSlashCommandOpen(false);
        if (inputRef.current) inputRef.current.style.height = 'auto';
        return;
      }

      // Check for custom AI commands (only in AI mode)
      if (!isTerminalMode) {
        const matchingCustomCommand = customAICommands.find(cmd => cmd.command === commandText);
        if (matchingCustomCommand) {
          // Execute the custom AI command by sending its prompt
          setInputValue('');
          setSlashCommandOpen(false);
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
                  // Add to queue - it will be removed by exit handler or stay for display
                  executionQueue: [...s.executionQueue, queuedItem],
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

            setInputValue('');
            setSlashCommandOpen(false);
            if (inputRef.current) inputRef.current.style.height = 'auto';
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
          text: inputValue,
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
        if (inputRef.current) inputRef.current.style.height = 'auto';
        return;
      }
    }

    console.log('[processInput] Processing input', {
      currentMode,
      inputValue: inputValue.substring(0, 50),
      toolType: activeSession.toolType,
      sessionId: activeSession.id
    });

    // Check if we're in read-only mode for the log entry
    const activeTabForEntry = currentMode === 'ai' ? getActiveTab(activeSession) : null;
    const isReadOnlyEntry = activeTabForEntry?.readOnlyMode === true;

    const newEntry: LogEntry = {
      id: generateId(),
      timestamp: Date.now(),
      source: 'user',
      text: inputValue,
      images: [...stagedImages],
      ...(isReadOnlyEntry && { readOnly: true })
    };

    // Track shell CWD changes when in terminal mode
    let newShellCwd = activeSession.shellCwd;
    let cwdChanged = false;
    if (currentMode === 'terminal') {
      const trimmedInput = inputValue.trim();
      // Handle bare "cd" command - go to session's original directory
      if (trimmedInput === 'cd') {
        cwdChanged = true;
        newShellCwd = activeSession.cwd;
      }
      const cdMatch = trimmedInput.match(/^cd\s+(.+)$/);
      if (cdMatch) {
        cwdChanged = true;
        const targetPath = cdMatch[1].trim().replace(/^['"]|['"]$/g, ''); // Remove quotes
        if (targetPath === '~') {
          // Navigate to session's original directory
          newShellCwd = activeSession.cwd;
        } else if (targetPath.startsWith('/')) {
          // Absolute path
          newShellCwd = targetPath;
        } else if (targetPath === '..') {
          // Go up one directory
          const parts = newShellCwd.split('/').filter(Boolean);
          parts.pop();
          newShellCwd = '/' + parts.join('/');
        } else if (targetPath.startsWith('../')) {
          // Relative path going up
          const parts = newShellCwd.split('/').filter(Boolean);
          const upCount = targetPath.split('/').filter(p => p === '..').length;
          for (let i = 0; i < upCount; i++) parts.pop();
          const remainingPath = targetPath.split('/').filter(p => p !== '..').join('/');
          newShellCwd = '/' + [...parts, ...remainingPath.split('/').filter(Boolean)].join('/');
        } else {
          // Relative path going down
          newShellCwd = newShellCwd + (newShellCwd.endsWith('/') ? '' : '/') + targetPath;
        }
      }
    }

    setSessions(prev => prev.map(s => {
      if (s.id !== activeSessionId) return s;

      // Add command to history (separate histories for AI and terminal modes)
      const historyKey = currentMode === 'ai' ? 'aiCommandHistory' : 'shellCommandHistory';
      const currentHistory = currentMode === 'ai' ? (s.aiCommandHistory || []) : (s.shellCommandHistory || []);
      const newHistory = [...currentHistory];
      if (inputValue.trim() && (newHistory.length === 0 || newHistory[newHistory.length - 1] !== inputValue.trim())) {
        newHistory.push(inputValue.trim());
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
    const capturedInputValue = inputValue;
    const capturedImages = [...stagedImages];

    // Broadcast user input to web clients so they stay in sync
    window.maestro.web.broadcastUserInput(activeSession.id, capturedInputValue, currentMode);

    setInputValue('');
    setStagedImages([]);

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
          const spawnArgs = [...agent.args];
          const freshActiveTab = getActiveTab(freshSession);
          const tabClaudeSessionId = freshActiveTab?.claudeSessionId;
          const isNewSession = !tabClaudeSessionId;

          if (tabClaudeSessionId) {
            spawnArgs.push('--resume', tabClaudeSessionId);
          }

          // Add read-only/plan mode when auto mode is active OR tab has readOnlyMode enabled
          if (activeBatchRunState.isRunning || freshActiveTab?.readOnlyMode) {
            spawnArgs.push('--permission-mode', 'plan');
          }

          // Spawn Claude with prompt as argument (use captured value)
          // If images are present, they will be passed via stream-json input format
          // Use agent.path (full path) if available, otherwise fall back to agent.command
          const commandToUse = agent.path || agent.command;
          console.log('[processInput] Spawning Claude:', {
            maestroSessionId: freshSession.id,
            targetSessionId,
            activeTabId: freshActiveTab?.id,
            claudeSessionId: tabClaudeSessionId || 'NEW SESSION',
            isResume: !!tabClaudeSessionId,
            command: commandToUse,
            args: spawnArgs,
            prompt: capturedInputValue.substring(0, 100)
          });
          await window.maestro.process.spawn({
            sessionId: targetSessionId,
            toolType: 'claude-code',
            cwd: freshSession.cwd,
            command: commandToUse,
            args: spawnArgs,
            prompt: capturedInputValue,
            images: capturedImages.length > 0 ? capturedImages : undefined
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
                    ? { ...tab, state: 'idle' as const, logs: [...tab.logs, errorLog] }
                    : tab
                )
              : s.aiTabs;
            return {
              ...s,
              state: 'idle',
              aiTabs: updatedAiTabs
            };
          }));
        }
      })();
    } else if (currentMode === 'terminal') {
      // Terminal mode: Use runCommand for clean stdout/stderr capture (no PTY noise)
      // This spawns a fresh shell with -l -c to run the command, ensuring aliases work
      console.log('[processInput] Terminal mode: calling runCommand', {
        sessionId: activeSession.id,
        command: capturedInputValue,
        cwd: activeSession.shellCwd || activeSession.cwd
      });
      window.maestro.process.runCommand({
        sessionId: activeSession.id,  // Plain session ID (not suffixed)
        command: capturedInputValue,
        cwd: activeSession.shellCwd || activeSession.cwd
      }).then(result => {
        console.log('[processInput] runCommand resolved:', result);
      }).catch(error => {
        console.error('Failed to run command:', error);
        setSessions(prev => prev.map(s => {
          if (s.id !== activeSessionId) return s;
          return {
            ...s,
            state: 'idle',
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
                  ? { ...tab, state: 'idle' as const, logs: [...tab.logs, errorLog] }
                  : tab
              )
            : s.aiTabs;
          return {
            ...s,
            state: 'idle',
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

      if (command.trim().startsWith('/')) {
        const commandText = command.trim();
        console.log('[Remote] Detected slash command:', commandText);

        // First, check for built-in slash commands (like /synopsis, /clear)
        // Use effectiveInputMode (from web) instead of session.inputMode
        const isTerminalMode = effectiveInputMode === 'terminal';
        const matchingBuiltinCommand = slashCommands.find(cmd => {
          if (cmd.command !== commandText) return false;
          // Apply mode filtering
          if (cmd.terminalOnly && !isTerminalMode) return false;
          if (cmd.aiOnly && isTerminalMode) return false;
          return true;
        });

        if (matchingBuiltinCommand) {
          console.log('[Remote] Found matching built-in slash command:', matchingBuiltinCommand.command);

          // Execute the built-in command with full context (using refs for latest function versions)
          // Use effectiveInputMode (from web) instead of session.inputMode
          matchingBuiltinCommand.execute({
            activeSessionId: sessionId,
            sessions: sessionsRef.current,
            setSessions,
            currentMode: effectiveInputMode,
            groups: groupsRef.current,
            setRightPanelOpen,
            setActiveRightTab,
            setActiveFocus,
            setSelectedFileIndex,
            sendPromptToAgent: spawnAgentWithPromptRef.current || undefined,
            addHistoryEntry: addHistoryEntryRef.current || undefined,
            startNewClaudeSession: startNewClaudeSessionRef.current || undefined,
            spawnBackgroundSynopsis: spawnBackgroundSynopsisRef.current || undefined,
            addToast: addToastRef.current,
            refreshHistoryPanel: () => rightPanelRef.current?.refreshHistoryPanel(),
          });

          // Built-in command executed - don't continue to spawn AI
          return;
        }

        // Check if command exists but isn't available in current mode
        const existingBuiltinCommand = slashCommands.find(cmd => cmd.command === commandText);
        if (existingBuiltinCommand) {
          const modeLabel = isTerminalMode ? 'AI' : 'terminal';
          console.log('[Remote] Built-in command exists but not available in', effectiveInputMode, 'mode');
          addLogToActiveTab(sessionId, {
            source: 'system',
            text: `${commandText} is only available in ${modeLabel} mode.`
          });
          return;
        }

        // Next, look up in custom AI commands
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
        const spawnArgs = [...agent.args];
        const activeTab = getActiveTab(session);
        const tabClaudeSessionId = activeTab?.claudeSessionId;
        if (tabClaudeSessionId) {
          spawnArgs.push('--resume', tabClaudeSessionId);
        }

        // Add read-only/plan mode if the active tab has readOnlyMode enabled
        if (activeTab?.readOnlyMode) {
          spawnArgs.push('--permission-mode', 'plan');
        }

        const targetSessionId = `${sessionId}-ai`;
        const commandToUse = agent.path || agent.command;

        console.log('[Remote] Spawning Claude directly:', {
          maestroSessionId: sessionId,
          targetSessionId,
          claudeSessionId: session.claudeSessionId || 'NEW SESSION',
          isResume: !!session.claudeSessionId,
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
                  ? { ...tab, state: 'idle' as const, logs: [...tab.logs, errorLogEntry] }
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
            aiTabs: updatedAiTabs
          };
        }));
      }
    };
    window.addEventListener('maestro:remoteCommand', handleRemoteCommand);
    return () => window.removeEventListener('maestro:remoteCommand', handleRemoteCommand);
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

    console.log('[processQueuedItem] Processing for tab:', targetTab?.id?.substring(0, 8), 'name:', targetTab?.name);

    try {
      // Get agent configuration
      const agent = await window.maestro.agents.get('claude-code');
      if (!agent) throw new Error('Claude Code agent not found');

      // Build spawn args with resume if we have a session ID
      // Use the TARGET TAB's claudeSessionId (not the active tab or deprecated session-level one)
      const spawnArgs = [...(agent.args || [])];
      const tabClaudeSessionId = targetTab?.claudeSessionId;

      if (tabClaudeSessionId) {
        spawnArgs.push('--resume', tabClaudeSessionId);
      }

      // Add read-only/plan mode if the queued item was from a read-only tab
      // or if the target tab currently has readOnlyMode enabled
      if (item.readOnlyMode || targetTab?.readOnlyMode) {
        spawnArgs.push('--permission-mode', 'plan');
      }

      const commandToUse = agent.path || agent.command;

      if (item.type === 'message' && item.text) {
        // Process a message - spawn Claude with the message text
        console.log('[processQueuedItem] Spawning Claude for queued message:', { sessionId, text: item.text.substring(0, 50) });

        await window.maestro.process.spawn({
          sessionId: targetSessionId,
          toolType: 'claude-code',
          cwd: session.cwd,
          command: commandToUse,
          args: spawnArgs,
          prompt: item.text,
          images: item.images && item.images.length > 0 ? item.images : undefined
        });
      } else if (item.type === 'command' && item.command) {
        // Process a slash command
        console.log('[processQueuedItem] Processing queued command:', { sessionId, command: item.command });

        // Find the matching custom AI command
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
          // Set session back to idle
          setSessions(prev => prev.map(s => {
            if (s.id !== sessionId) return s;
            return { ...s, state: 'idle' as SessionState };
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
                ? { ...tab, state: 'idle' as const, logs: [...tab.logs, errorLogEntry] }
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

      // Just set state to idle, no log entry needed
      setSessions(prev => prev.map(s => {
        if (s.id !== activeSession.id) return s;
        return {
          ...s,
          state: 'idle'
        };
      }));
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
          setSessions(prev => prev.map(s => {
            if (s.id !== activeSession.id) return s;
            if (currentMode === 'ai') {
              const tab = getActiveTab(s);
              if (!tab) return { ...s, state: 'idle' };
              return {
                ...s,
                state: 'idle',
                aiTabs: s.aiTabs.map(t =>
                  t.id === tab.id ? { ...t, logs: [...t.logs, killLog] } : t
                )
              };
            }
            return { ...s, shellLogs: [...s.shellLogs, killLog], state: 'idle' };
          }));
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
              if (!tab) return { ...s, state: 'idle' };
              return {
                ...s,
                state: 'idle',
                aiTabs: s.aiTabs.map(t =>
                  t.id === tab.id ? { ...t, logs: [...t.logs, errorLog] } : t
                )
              };
            }
            return { ...s, shellLogs: [...s.shellLogs, errorLog], state: 'idle' };
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
        setSelectedTabCompletionIndex(prev =>
          Math.min(prev + 1, tabCompletionSuggestions.length - 1)
        );
        return;
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedTabCompletionIndex(prev => Math.max(prev - 1, 0));
        return;
      } else if (e.key === 'Tab') {
        e.preventDefault();
        if (tabCompletionSuggestions[selectedTabCompletionIndex]) {
          setInputValue(tabCompletionSuggestions[selectedTabCompletionIndex].value);
        }
        setTabCompletionOpen(false);
        return;
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (tabCompletionSuggestions[selectedTabCompletionIndex]) {
          setInputValue(tabCompletionSuggestions[selectedTabCompletionIndex].value);
        }
        setTabCompletionOpen(false);
        return;
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setTabCompletionOpen(false);
        return;
      }
    }

    // Handle slash command autocomplete
    if (slashCommandOpen) {
      const isTerminalMode = activeSession.inputMode === 'terminal';
      const filteredCommands = allSlashCommands.filter(cmd => {
        // Check if command is only available in terminal mode
        if (cmd.terminalOnly && !isTerminalMode) return false;
        // Check if command is only available in AI mode
        if (cmd.aiOnly && isTerminalMode) return false;
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
      } else if (e.key === 'Tab') {
        // Tab just fills in the command text
        e.preventDefault();
        setInputValue(filteredCommands[selectedSlashCommandIndex]?.command || inputValue);
        setSlashCommandOpen(false);
      } else if (e.key === 'Enter' && filteredCommands.length > 0) {
        // Enter executes the command directly
        e.preventDefault();
        const selectedCommand = filteredCommands[selectedSlashCommandIndex];
        if (selectedCommand) {
          setSlashCommandOpen(false);
          setInputValue('');
          if (inputRef.current) inputRef.current.style.height = 'auto';

          // Check if this is a custom AI command (has prompt but no execute)
          if ('prompt' in selectedCommand && selectedCommand.prompt && !('execute' in selectedCommand)) {
            // Substitute template variables and send to the AI agent
            // Use the same spawn logic as processInput for proper tab-based session ID tracking
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
                selectedCommand.prompt,
                { session: activeSession, gitBranch }
              );

              // Get the active tab for proper targeting
              const activeTab = getActiveTab(activeSession);
              if (!activeTab) {
                console.error('[handleInputKeyDown] No active tab for slash command');
                return;
              }

              // Build target session ID using tab ID (same pattern as processInput)
              const targetSessionId = `${activeSessionId}-ai-${activeTab.id}`;
              const isNewSession = !activeTab.claudeSessionId;

              // Add user log showing the command with its interpolated prompt to active tab
              const newEntry: LogEntry = {
                id: generateId(),
                timestamp: Date.now(),
                source: 'user',
                text: substitutedPrompt,
                aiCommand: {
                  command: selectedCommand.command,
                  description: selectedCommand.description
                }
              };

              // Update session state: add log, set busy, set awaitingSessionId for new sessions
              setSessions(prev => prev.map(s => {
                if (s.id !== activeSessionId) return s;

                // Update the active tab's logs and state
                const updatedAiTabs = s.aiTabs.map(tab =>
                  tab.id === activeTab.id
                    ? {
                        ...tab,
                        logs: [...tab.logs, newEntry],
                        state: 'busy' as const,
                        thinkingStartTime: Date.now(),
                        awaitingSessionId: isNewSession ? true : tab.awaitingSessionId
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
                  aiCommandHistory: Array.from(new Set([...(s.aiCommandHistory || []), selectedCommand.command])).slice(-50),
                  pendingAICommandForSynopsis: selectedCommand.command,
                  aiTabs: updatedAiTabs
                };
              }));

              // Spawn the agent with proper session ID format (same as processInput)
              try {
                const agent = await window.maestro.agents.get('claude-code');
                if (!agent) throw new Error('Claude Code agent not found');

                // Get fresh session state to avoid stale closure
                const freshSession = sessionsRef.current.find(s => s.id === activeSessionId);
                if (!freshSession) throw new Error('Session not found');

                const freshActiveTab = getActiveTab(freshSession);
                const tabClaudeSessionId = freshActiveTab?.claudeSessionId;

                // Build spawn args with resume if we have a session ID
                const spawnArgs = [...(agent.args || [])];
                if (tabClaudeSessionId) {
                  spawnArgs.push('--resume', tabClaudeSessionId);
                }

                // Add read-only mode if tab has it enabled
                if (freshActiveTab?.readOnlyMode) {
                  spawnArgs.push('--permission-mode', 'plan');
                }

                const commandToUse = agent.path || agent.command;
                console.log('[handleInputKeyDown] Spawning Claude for slash command:', {
                  command: selectedCommand.command,
                  targetSessionId,
                  claudeSessionId: tabClaudeSessionId || 'NEW SESSION'
                });

                await window.maestro.process.spawn({
                  sessionId: targetSessionId,
                  toolType: 'claude-code',
                  cwd: freshSession.cwd,
                  command: commandToUse,
                  args: spawnArgs,
                  prompt: substitutedPrompt
                });
              } catch (error: any) {
                console.error('[handleInputKeyDown] Failed to spawn Claude for slash command:', error);
                setSessions(prev => prev.map(s => {
                  if (s.id !== activeSessionId) return s;
                  const errorEntry: LogEntry = {
                    id: generateId(),
                    timestamp: Date.now(),
                    source: 'system',
                    text: `Error: Failed to run ${selectedCommand.command} - ${error.message}`
                  };
                  const updatedAiTabs = s.aiTabs.map(tab =>
                    tab.id === activeTab.id
                      ? { ...tab, state: 'idle' as const, logs: [...tab.logs, errorEntry] }
                      : tab
                  );
                  return {
                    ...s,
                    state: 'idle' as SessionState,
                    busySource: undefined,
                    aiTabs: updatedAiTabs
                  };
                }));
              }
            })();
          } else if ('execute' in selectedCommand && selectedCommand.execute) {
            // Execute the built-in command directly
            selectedCommand.execute({
              activeSessionId,
              sessions,
              setSessions,
              currentMode: activeSession.inputMode,
              groups,
              setRightPanelOpen,
              setActiveRightTab,
              setActiveFocus,
              setSelectedFileIndex,
              sendPromptToAgent: spawnAgentWithPrompt,
              addHistoryEntry,
              startNewClaudeSession,
              spawnBackgroundSynopsis,
              addToast,
            });
          }
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
      // Tab completion only in terminal mode when not showing slash commands
      if (activeSession?.inputMode === 'terminal' && !slashCommandOpen && inputValue.trim()) {
        e.preventDefault();
        // Get suggestions and show dropdown if there are any
        const suggestions = getTabCompletionSuggestions(inputValue);
        if (suggestions.length > 0) {
          // If only one suggestion, auto-complete it
          if (suggestions.length === 1) {
            setInputValue(suggestions[0].value);
          } else {
            // Show dropdown for multiple suggestions
            setSelectedTabCompletionIndex(0);
            setTabCompletionOpen(true);
          }
        }
      }
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

  // Refresh file tree for a session
  const refreshFileTree = useCallback(async (sessionId: string) => {
    const session = sessions.find(s => s.id === sessionId);
    if (!session) return;

    try {
      const tree = await loadFileTree(session.cwd);
      setSessions(prev => prev.map(s =>
        s.id === sessionId ? { ...s, fileTree: tree, fileTreeError: undefined } : s
      ));
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

    setSelectedFileIndex(targetIndex);

    // Clear the pending jump path
    setSessions(prev => prev.map(s =>
      s.id === activeSession.id ? { ...s, pendingJumpPath: undefined } : s
    ));
  }, [activeSession?.pendingJumpPath, flatFileList, activeSession?.id]);

  // Scroll to selected file item when selection changes
  useEffect(() => {
    if (activeFocus !== 'right' || activeRightTab !== 'files') return;

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
  }, [selectedFileIndex, activeFocus, activeRightTab, flatFileList]);

  // File Explorer keyboard navigation
  useEffect(() => {
    const handleFileExplorerKeys = (e: KeyboardEvent) => {
      // Only handle when right panel is focused and on files tab
      if (activeFocus !== 'right' || activeRightTab !== 'files' || flatFileList.length === 0) return;

      const expandedFolders = new Set(activeSession.fileExplorerExpanded || []);

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedFileIndex(prev => Math.max(0, prev - 1));
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
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
        className="fixed top-0 left-0 right-0 h-10"
        style={{
          WebkitAppRegion: 'drag',
        } as React.CSSProperties}
      />
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
          startFreshSession={() => {
            // Create a fresh AI terminal session by clearing the Claude session ID and AI logs
            if (activeSession) {
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
                      tab.id === s.activeTabId ? { ...tab, state: 'idle' as const } : tab
                    )
                  : s.aiTabs;
                return { ...s, claudeSessionId: undefined, aiLogs: [], state: 'idle', aiTabs: updatedAiTabs };
              }));
              setActiveClaudeSessionId(null);
            }
          }}
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
        />
      )}
      {lightboxImage && (
        <LightboxModal
          image={lightboxImage}
          stagedImages={lightboxImages.length > 0 ? lightboxImages : stagedImages}
          onClose={() => { setLightboxImage(null); setLightboxImages([]); }}
          onNavigate={(img) => setLightboxImage(img)}
        />
      )}

      {/* --- GIT DIFF VIEWER --- */}
      {gitDiffPreview && activeSession && (
        <GitDiffViewer
          diffText={gitDiffPreview}
          cwd={activeSession.inputMode === 'terminal' ? (activeSession.shellCwd || activeSession.cwd) : activeSession.cwd}
          theme={theme}
          onClose={() => setGitDiffPreview(null)}
        />
      )}

      {/* --- GIT LOG VIEWER --- */}
      {gitLogOpen && activeSession && (
        <GitLogViewer
          cwd={activeSession.inputMode === 'terminal' ? (activeSession.shellCwd || activeSession.cwd) : activeSession.cwd}
          theme={theme}
          onClose={() => setGitLogOpen(false)}
        />
      )}

      {/* --- SHORTCUTS HELP MODAL --- */}
      {shortcutsHelpOpen && (
        <ShortcutsHelpModal
          theme={theme}
          shortcuts={shortcuts}
          onClose={() => setShortcutsHelpOpen(false)}
        />
      )}

      {/* --- ABOUT MODAL --- */}
      {aboutModalOpen && (
        <AboutModal
          theme={theme}
          sessions={sessions}
          autoRunStats={autoRunStats}
          onClose={() => setAboutModalOpen(false)}
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
          onClose={() => setStandingOvationData(null)}
        />
      )}

      {/* --- PROCESS MONITOR --- */}
      {processMonitorOpen && (
        <ProcessMonitor
          theme={theme}
          sessions={sessions}
          groups={groups}
          onClose={() => setProcessMonitorOpen(false)}
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
          onClose={() => setRenameInstanceModalOpen(false)}
          sessions={sessions}
          setSessions={setSessions}
          activeSessionId={activeSessionId}
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

      {/* --- LEFT SIDEBAR (hidden in mobile landscape) --- */}
      {!isMobileLandscape && (
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
            setActiveFocus={setActiveFocus}
            setActiveSessionId={setActiveSessionId}
            setLeftSidebarOpen={setLeftSidebarOpen}
            setLeftSidebarWidthState={setLeftSidebarWidth}
            setShortcutsHelpOpen={setShortcutsHelpOpen}
            setSettingsModalOpen={setSettingsModalOpen}
            setSettingsTab={setSettingsTab}
            setAboutModalOpen={setAboutModalOpen}
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
            activeBatchSessionIds={activeBatchSessionIds}
            showSessionJumpNumbers={showSessionJumpNumbers}
            visibleSessions={visibleSessions}
            autoRunStats={autoRunStats}
          />
        </ErrorBoundary>
      )}

      {/* --- CENTER WORKSPACE --- */}
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
        markdownRawMode={markdownRawMode}
        shortcuts={shortcuts}
        rightPanelOpen={rightPanelOpen}
        maxOutputLines={maxOutputLines}
        gitDiffPreview={gitDiffPreview}
        fileTreeFilterOpen={fileTreeFilterOpen}
        logLevel={logLevel}
        setGitDiffPreview={setGitDiffPreview}
        setLogViewerOpen={setLogViewerOpen}
        setAgentSessionsOpen={setAgentSessionsOpen}
        setActiveClaudeSessionId={setActiveClaudeSessionId}
        onResumeClaudeSession={(claudeSessionId: string, messages: LogEntry[], sessionName?: string, starred?: boolean) => {
          // Opens the Claude session as a new tab (or switches to existing tab if duplicate)
          handleResumeSession(claudeSessionId, messages, sessionName, starred);
        }}
        onNewClaudeSession={() => {
          // Create a fresh AI terminal session by clearing the Claude session ID and AI logs
          if (activeSession) {
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
                    tab.id === s.activeTabId ? { ...tab, state: 'idle' as const } : tab
                  )
                : s.aiTabs;
              return { ...s, claudeSessionId: undefined, aiLogs: [], state: 'idle', usageStats: undefined, contextUsage: 0, activeTimeMs: 0, aiTabs: updatedAiTabs };
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
        setPreviewFile={setPreviewFile}
        setMarkdownRawMode={setMarkdownRawMode}
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
                if (result.success) {
                  console.log('[onDeleteLog] Deleted message pair from Claude session', {
                    linesRemoved: result.linesRemoved,
                    claudeSessionId
                  });
                } else {
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
            const result = createTab(s);
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
          // Persist AI input to session state on blur (only in AI mode)
          if (isAiMode) {
            syncAiInputToSession(aiInputValueLocal);
          }
        }}
      />

      {/* --- RIGHT PANEL (hidden in mobile landscape) --- */}
      {!isMobileLandscape && (
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
            setActiveRightTab={setActiveRightTab}
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
            updateScratchPad={updateScratchPad}
            updateScratchPadState={updateScratchPadState}
            batchRunState={activeBatchRunState}
            onOpenBatchRunner={handleOpenBatchRunner}
            onStopBatchRun={handleStopBatchRun}
            onJumpToClaudeSession={handleJumpToClaudeSession}
            onResumeSession={handleResumeSession}
            onOpenSessionAsTab={handleResumeSession}
          />
        </ErrorBoundary>
      )}

      {/* --- BATCH RUNNER MODAL --- */}
      {batchRunnerModalOpen && activeSession && (
        <BatchRunnerModal
          theme={theme}
          onClose={() => setBatchRunnerModalOpen(false)}
          onGo={(prompt) => {
            // Start the batch run
            handleStartBatchRun(prompt);
          }}
          onSave={(prompt) => {
            // Save the custom prompt and modification timestamp to the session (persisted across restarts)
            setSessions(prev => prev.map(s =>
              s.id === activeSession.id ? { ...s, batchRunnerPrompt: prompt, batchRunnerPromptModifiedAt: Date.now() } : s
            ));
          }}
          initialPrompt={activeSession.batchRunnerPrompt || ''}
          lastModifiedAt={activeSession.batchRunnerPromptModifiedAt}
          showConfirmation={showConfirmation}
          scratchpadContent={activeSession.scratchPadContent}
        />
      )}

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
      />

      {/* Old settings modal removed - using new SettingsModal component below */}

      {/* --- NEW INSTANCE MODAL --- */}
      <NewInstanceModal
        isOpen={newInstanceModalOpen}
        onClose={() => setNewInstanceModalOpen(false)}
        onCreate={createNewSession}
        theme={theme}
        defaultAgent={defaultAgent}
      />

      {/* --- SETTINGS MODAL (New Component) --- */}
      <SettingsModal
        isOpen={settingsModalOpen}
        onClose={() => setSettingsModalOpen(false)}
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
        tunnelProvider={tunnelProvider}
        setTunnelProvider={setTunnelProvider}
        tunnelApiKey={tunnelApiKey}
        setTunnelApiKey={setTunnelApiKey}
        shortcuts={shortcuts}
        setShortcuts={setShortcuts}
        defaultAgent={defaultAgent}
        setDefaultAgent={setDefaultAgent}
        defaultShell={defaultShell}
        setDefaultShell={setDefaultShell}
        enterToSendAI={enterToSendAI}
        setEnterToSendAI={setEnterToSendAI}
        enterToSendTerminal={enterToSendTerminal}
        setEnterToSendTerminal={setEnterToSendTerminal}
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
        customAICommands={customAICommands}
        setCustomAICommands={setCustomAICommands}
        initialTab={settingsTab}
      />

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

      {/* --- TOAST NOTIFICATIONS --- */}
      <ToastContainer theme={theme} onSessionClick={handleToastSessionClick} />
      </div>
  );
}

