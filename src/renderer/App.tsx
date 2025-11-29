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
import { RenameGroupModal } from './components/RenameGroupModal';
import { ConfirmModal } from './components/ConfirmModal';
import { ErrorBoundary } from './components/ErrorBoundary';
import { MainPanel } from './components/MainPanel';
import { ProcessMonitor } from './components/ProcessMonitor';
import { GitDiffViewer } from './components/GitDiffViewer';
import { GitLogViewer } from './components/GitLogViewer';
import { BatchRunnerModal } from './components/BatchRunnerModal';

// Import custom hooks
import { useBatchProcessor } from './hooks/useBatchProcessor';
import { useSettings, useActivityTracker, useMobileLandscape } from './hooks';
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
  ThemeId, FocusArea, LogEntry, Session, Group
} from './types';
import { THEMES } from './constants/themes';
import { generateId } from './utils/ids';
import { getContextColor } from './utils/theme';
import { fuzzyMatch } from './utils/search';
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
  const { addToast, setDefaultDuration: setToastDefaultDuration } = useToast();

  // --- MOBILE LANDSCAPE MODE (reading-only view) ---
  const isMobileLandscape = useMobileLandscape();

  // --- SETTINGS (from useSettings hook) ---
  const settings = useSettings();
  const {
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
  } = settings;

  // --- STATE ---
  const [sessions, setSessions] = useState<Session[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);

  // Track if initial data has been loaded to prevent overwriting on mount
  const initialLoadComplete = useRef(false);

  const [activeSessionId, setActiveSessionId] = useState<string>(sessions[0]?.id || 's1');

  // Input State - separate for AI and terminal modes
  const [aiInputValue, setAiInputValue] = useState('');
  const [terminalInputValue, setTerminalInputValue] = useState('');
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
  const [logViewerOpen, setLogViewerOpen] = useState(false);
  const [processMonitorOpen, setProcessMonitorOpen] = useState(false);
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

  // Rename Group Modal State
  const [renameGroupModalOpen, setRenameGroupModalOpen] = useState(false);

  // Agent Sessions Browser State (main panel view)
  const [agentSessionsOpen, setAgentSessionsOpen] = useState(false);
  const [activeClaudeSessionId, setActiveClaudeSessionId] = useState<string | null>(null);

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

  // Images Staging (only for AI mode - terminal doesn't support images)
  const [aiStagedImages, setAiStagedImages] = useState<string[]>([]);

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

  // Close file preview when switching sessions
  useEffect(() => {
    if (previewFile !== null) {
      setPreviewFile(null);
    }
  }, [activeSessionId]);

  // Restore a persisted session by respawning its process
  const restoreSession = async (session: Session): Promise<Session> => {
    try {
      // Detect and fix inputMode/toolType mismatch
      // The AI agent should never use 'terminal' as toolType
      let correctedSession = { ...session };
      let aiAgentType = correctedSession.toolType;

      // If toolType is 'terminal', use the default agent instead for AI process
      if (aiAgentType === 'terminal') {
        console.warn(`[restoreSession] Session has toolType='terminal', using default agent for AI process`);
        aiAgentType = defaultAgent as ToolType;

        const targetLogKey = 'aiLogs';
        correctedSession[targetLogKey] = [
          ...correctedSession[targetLogKey],
          {
            id: generateId(),
            timestamp: Date.now(),
            source: 'system',
            text: '⚠️ Using default AI agent (Claude Code) for this session.'
          }
        ];
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
        // Only spawn for non-batch-mode agents
        // Use agent.path (full path) if available for better cross-environment compatibility
        aiSpawnResult = await window.maestro.process.spawn({
          sessionId: `${correctedSession.id}-ai`,
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
          aiLogs: correctedSession.aiLogs,  // Preserve existing AI Terminal logs
          shellLogs: correctedSession.shellLogs,  // Preserve existing Command Terminal logs
          messageQueue: correctedSession.messageQueue || [],  // Ensure backwards compatibility
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

  // Load sessions and groups from electron-store on mount (with localStorage migration)
  useEffect(() => {
    const loadSessionsAndGroups = async () => {
      try {
        // Try to load from electron-store first
        const savedSessions = await window.maestro.sessions.getAll();
        const savedGroups = await window.maestro.groups.getAll();

        // Handle sessions
        if (savedSessions && savedSessions.length > 0) {
          // electron-store has data - restore processes for all sessions
          const restoredSessions = await Promise.all(
            savedSessions.map(s => restoreSession(s))
          );
          setSessions(restoredSessions);
          // Set active session to first session if current activeSessionId is invalid
          if (restoredSessions.length > 0 && !restoredSessions.find(s => s.id === activeSessionId)) {
            setActiveSessionId(restoredSessions[0].id);
          }
        } else {
          // Try to migrate from localStorage
          try {
            const localStorageSessions = localStorage.getItem('maestro_sessions');
            if (localStorageSessions) {
              const parsed = JSON.parse(localStorageSessions);
              // Restore processes for migrated sessions too
              const restoredSessions = await Promise.all(
                parsed.map((s: Session) => restoreSession(s))
              );
              setSessions(restoredSessions);
              // Set active session to first session if current activeSessionId is invalid
              if (restoredSessions.length > 0 && !restoredSessions.find(s => s.id === activeSessionId)) {
                setActiveSessionId(restoredSessions[0].id);
              }
              // Save to electron-store for future
              await window.maestro.sessions.setAll(restoredSessions);
              // Clean up localStorage
              localStorage.removeItem('maestro_sessions');
            } else {
              // No data anywhere - explicitly set empty array
              setSessions([]);
            }
          } catch (e) {
            console.error('Failed to migrate sessions from localStorage:', e);
            setSessions([]);
          }
        }

        // Handle groups
        if (savedGroups && savedGroups.length > 0) {
          // electron-store has data, use it
          setGroups(savedGroups);
        } else {
          // Try to migrate from localStorage
          try {
            const localStorageGroups = localStorage.getItem('maestro_groups');
            if (localStorageGroups) {
              const parsed = JSON.parse(localStorageGroups);
              setGroups(parsed);
              // Save to electron-store for future
              await window.maestro.groups.setAll(parsed);
              // Clean up localStorage
              localStorage.removeItem('maestro_groups');
            } else {
              // No data anywhere - explicitly set empty array
              setGroups([]);
            }
          } catch (e) {
            console.error('Failed to migrate groups from localStorage:', e);
            setGroups([]);
          }
        }
      } catch (e) {
        console.error('Failed to load sessions/groups:', e);
        setSessions([]);
        setGroups([]);
      } finally {
        // Mark initial load as complete to enable persistence
        initialLoadComplete.current = true;

        // Hide the splash screen now that the app is ready
        if (typeof window.__hideSplash === 'function') {
          window.__hideSplash();
        }
      }
    };
    loadSessionsAndGroups();
  }, []);

  // Set up process event listeners for real-time output
  useEffect(() => {
    // Handle process output data
    // sessionId will be in format: "{id}-ai", "{id}-terminal", "{id}-batch-{timestamp}", etc.
    const unsubscribeData = window.maestro.process.onData((sessionId: string, data: string) => {
      console.log('[onData] Received data for session:', sessionId, 'Data:', data.substring(0, 100));

      // Parse sessionId to determine which process this is from
      let actualSessionId: string;
      let isFromAi: boolean;

      if (sessionId.endsWith('-ai')) {
        actualSessionId = sessionId.slice(0, -3); // Remove "-ai" suffix
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

        // Route to correct log array based on which process sent the data
        const targetLogKey = isFromAi ? 'aiLogs' : 'shellLogs';
        const existingLogs = s[targetLogKey];
        const lastLog = existingLogs[existingLogs.length - 1];

        // For terminal commands (runCommand), group all stdout while command is running
        // For AI processes, use time-based grouping (500ms window)
        const isTerminalCommand = !isFromAi;
        const shouldGroup = lastLog &&
                           lastLog.source === 'stdout' &&
                           (isTerminalCommand ? s.state === 'busy' : (Date.now() - lastLog.timestamp) < 500);

        // Mark the most recent user message as delivered when we receive AI output
        // This confirms the message was successfully sent to the agent
        let logsWithDelivery = existingLogs;
        if (isFromAi) {
          // Find the most recent undelivered user message and mark it as delivered
          const lastUserIndex = existingLogs.map((log, i) => ({ log, i }))
            .filter(({ log }) => log.source === 'user' && !log.delivered)
            .pop()?.i;
          if (lastUserIndex !== undefined) {
            logsWithDelivery = existingLogs.map((log, i) =>
              i === lastUserIndex ? { ...log, delivered: true } : log
            );
          }
        }

        if (shouldGroup) {
          // Append to existing log entry
          const updatedLogs = [...logsWithDelivery];
          updatedLogs[updatedLogs.length - 1] = {
            ...updatedLogs[updatedLogs.length - 1],
            text: updatedLogs[updatedLogs.length - 1].text + data
          };

          return {
            ...s,
            // For terminal commands, keep busy state (will be set to idle by onCommandExit)
            state: isTerminalCommand ? s.state : 'idle' as SessionState,
            [targetLogKey]: updatedLogs
          };
        } else {
          // Create new log entry
          const newLog: LogEntry = {
            id: generateId(),
            timestamp: Date.now(),
            source: 'stdout',
            text: data
          };

          return {
            ...s,
            // Keep state unchanged - let onExit handler manage state transitions
            // This ensures queued messages work correctly (state stays 'busy' during AI processing)
            [targetLogKey]: [...logsWithDelivery, newLog]
          };
        }
      }));
    });

    // Handle process exit
    const unsubscribeExit = window.maestro.process.onExit((sessionId: string, code: number) => {
      // Parse sessionId to determine which process exited
      let actualSessionId: string;
      let isFromAi: boolean;

      if (sessionId.endsWith('-ai')) {
        actualSessionId = sessionId.slice(0, -3);
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
      let toastData: { title: string; summary: string; groupName: string; projectName: string; duration: number } | null = null;
      let queuedMessageToProcess: { sessionId: string; message: LogEntry } | null = null;
      // Track if we need to run synopsis after completion (for /commit and other AI commands)
      let synopsisData: { sessionId: string; cwd: string; claudeSessionId: string; command: string; groupName: string; projectName: string } | null = null;

      if (isFromAi) {
        const currentSession = sessionsRef.current.find(s => s.id === actualSessionId);
        if (currentSession) {
          // Check if there are queued messages
          if (currentSession.messageQueue.length > 0) {
            queuedMessageToProcess = {
              sessionId: actualSessionId,
              message: currentSession.messageQueue[0]
            };
          } else {
            // Task complete - gather toast notification data
            const lastUserLog = currentSession.aiLogs.filter(log => log.source === 'user').pop();
            const lastAiLog = currentSession.aiLogs.filter(log => log.source === 'stdout' || log.source === 'ai').pop();
            const duration = currentSession.thinkingStartTime ? Date.now() - currentSession.thinkingStartTime : 0;

            // Get group name for this session
            const sessionGroup = groupsRef.current.find((g: any) => g.sessionIds?.includes(actualSessionId));
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

            toastData = { title, summary, groupName, projectName, duration };

            // Check if this was a custom AI command that should trigger synopsis
            if (currentSession.pendingAICommandForSynopsis && currentSession.claudeSessionId) {
              synopsisData = {
                sessionId: actualSessionId,
                cwd: currentSession.cwd,
                claudeSessionId: currentSession.claudeSessionId,
                command: currentSession.pendingAICommandForSynopsis,
                groupName,
                projectName
              };
            }
          }
        }
      }

      // Update state (pure function - no side effects)
      setSessions(prev => prev.map(s => {
        if (s.id !== actualSessionId) return s;

        if (isFromAi) {
          // Check if there are queued messages
          if (s.messageQueue.length > 0) {
            const [nextMessage, ...remainingQueue] = s.messageQueue;
            return {
              ...s,
              state: 'busy' as SessionState,
              busySource: 'ai',
              aiLogs: [...s.aiLogs, nextMessage],
              messageQueue: remainingQueue,
              thinkingStartTime: Date.now()
            };
          }

          // Task complete - also clear pending AI command flag
          return {
            ...s,
            state: 'idle' as SessionState,
            busySource: undefined,
            thinkingStartTime: undefined,
            pendingAICommandForSynopsis: undefined
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
      if (queuedMessageToProcess) {
        setTimeout(() => {
          processQueuedMessage(queuedMessageToProcess!.sessionId, queuedMessageToProcess!.message);
        }, 0);
      } else if (toastData) {
        setTimeout(() => {
          addToastRef.current({
            type: 'success',
            title: toastData!.title,
            message: toastData!.summary,
            group: toastData!.groupName,
            project: toastData!.projectName,
            taskDuration: toastData!.duration,
          });
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

      // Parse sessionId to get actual session ID
      let actualSessionId: string;
      if (sessionId.endsWith('-ai')) {
        actualSessionId = sessionId.slice(0, -3);
      } else {
        actualSessionId = sessionId;
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
        // Also pass the session name so it can be searched in the Claude sessions browser
        window.maestro.claude.registerSessionOrigin(session.cwd, claudeSessionId, 'user', session.name)
          .then(() => console.log('[onSessionId] Registered session origin as user:', claudeSessionId, 'name:', session.name))
          .catch(err => console.error('[onSessionId] Failed to register session origin:', err));

        return prev.map(s => {
          if (s.id !== actualSessionId) return s;
          console.log('[onSessionId] Storing Claude session ID for session:', actualSessionId, 'claudeSessionId:', claudeSessionId);
          return { ...s, claudeSessionId };
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

      // Parse sessionId to get actual session ID (handles -ai suffix)
      let actualSessionId: string;
      if (sessionId.endsWith('-ai')) {
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

        // Accumulate cost if there's already usage stats
        const existingCost = s.usageStats?.totalCostUsd || 0;

        return {
          ...s,
          contextUsage: contextPercentage,
          usageStats: {
            ...usageStats,
            totalCostUsd: existingCost + usageStats.totalCostUsd
          }
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
  groupsRef.current = groups;
  addToastRef.current = addToast;
  sessionsRef.current = sessions;
  updateGlobalStatsRef.current = updateGlobalStats;
  customAICommandsRef.current = customAICommands;

  // Refs for slash command functions (to access latest values in remote command handler)
  const spawnBackgroundSynopsisRef = useRef<typeof spawnBackgroundSynopsis | null>(null);
  const addHistoryEntryRef = useRef<typeof addHistoryEntry | null>(null);
  const spawnAgentWithPromptRef = useRef<typeof spawnAgentWithPrompt | null>(null);
  const startNewClaudeSessionRef = useRef<typeof startNewClaudeSession | null>(null);

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
    const unsubscribeRemote = window.maestro.process.onRemoteCommand((sessionId: string, command: string) => {
      // Verify the session exists
      const targetSession = sessionsRef.current.find(s => s.id === sessionId);

      console.log('[Remote] Received command from web interface:', {
        maestroSessionId: sessionId,
        claudeSessionId: targetSession?.claudeSessionId || 'none',
        state: targetSession?.state || 'NOT_FOUND',
        inputMode: targetSession?.inputMode || 'unknown',
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

      // Switch to the target session (for visual feedback)
      console.log('[Remote] Switching to target session...');
      setActiveSessionId(sessionId);

      // Dispatch event directly - handleRemoteCommand handles all the logic
      // Don't set inputValue - we don't want command text to appear in the input bar
      console.log('[Remote] Dispatching maestro:remoteCommand event');
      window.dispatchEvent(new CustomEvent('maestro:remoteCommand', {
        detail: { sessionId, command }
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

  // Combine built-in slash commands with custom AI commands for autocomplete
  const allSlashCommands = useMemo(() => {
    const customCommandsAsSlash = customAICommands.map(cmd => ({
      command: cmd.command,
      description: cmd.description,
      aiOnly: true, // Custom AI commands are only available in AI mode
      prompt: cmd.prompt, // Include prompt for execution
    }));
    return [...slashCommands, ...customCommandsAsSlash];
  }, [customAICommands]);

  // Derive current input value and setter based on active session mode
  const isAiMode = activeSession?.inputMode === 'ai';
  const inputValue = isAiMode ? aiInputValue : terminalInputValue;
  const setInputValue = isAiMode ? setAiInputValue : setTerminalInputValue;
  // Images are only used in AI mode
  const stagedImages = aiStagedImages;
  const setStagedImages = setAiStagedImages;

  // Tab completion suggestions (must be after inputValue is defined)
  const tabCompletionSuggestions = useMemo(() => {
    if (!tabCompletionOpen || !activeSession || activeSession.inputMode !== 'terminal') {
      return [];
    }
    return getTabCompletionSuggestions(inputValue);
  }, [tabCompletionOpen, activeSession, inputValue, getTabCompletionSuggestions]);

  // --- BATCH PROCESSOR ---
  // Helper to spawn a Claude agent and wait for completion (for a specific session)
  const spawnAgentForSession = useCallback(async (sessionId: string, prompt: string): Promise<{ success: boolean; response?: string; claudeSessionId?: string }> => {
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
      setSessions(prev => prev.map(s =>
        s.id === sessionId ? { ...s, state: 'busy' as SessionState, busySource: 'ai', thinkingStartTime: Date.now() } : s
      ));

      // Create a promise that resolves when the agent completes
      return new Promise((resolve) => {
        let claudeSessionId: string | undefined;
        let responseText = '';

        // Cleanup functions will be set when listeners are registered
        let cleanupData: (() => void) | undefined;
        let cleanupSessionId: (() => void) | undefined;
        let cleanupExit: (() => void) | undefined;

        const cleanup = () => {
          cleanupData?.();
          cleanupSessionId?.();
          cleanupExit?.();
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

        cleanupExit = window.maestro.process.onExit((sid: string) => {
          if (sid === targetSessionId) {
            // Clean up listeners and resolve
            cleanup();

            // Reset session state to idle, but do NOT overwrite the main session's claudeSessionId
            // The batch task's claudeSessionId is separate and returned via resolve() for tracking purposes
            setSessions(prev => prev.map(s =>
              s.id === sessionId ? { ...s, state: 'idle' as SessionState, busySource: undefined, thinkingStartTime: undefined } : s
            ));

            resolve({ success: true, response: responseText, claudeSessionId });
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
  const addHistoryEntry = useCallback(async (entry: { type: 'AUTO' | 'USER'; summary: string; claudeSessionId?: string }) => {
    if (!activeSession) return;

    await window.maestro.history.add({
      id: generateId(),
      type: entry.type,
      timestamp: Date.now(),
      summary: entry.summary,
      claudeSessionId: entry.claudeSessionId,
      projectPath: activeSession.cwd,
      contextUsage: activeSession.contextUsage,
      usageStats: activeSession.usageStats
    });

    // Refresh history panel to show the new entry
    rightPanelRef.current?.refreshHistoryPanel();
  }, [activeSession]);

  // Helper to start a new Claude session
  const startNewClaudeSession = useCallback(() => {
    if (!activeSession) return;

    // Block clearing when there are queued messages
    if (activeSession.messageQueue.length > 0) {
      setSessions(prev => prev.map(s => {
        if (s.id !== activeSession.id) return s;
        return {
          ...s,
          aiLogs: [...s.aiLogs, {
            id: generateId(),
            timestamp: Date.now(),
            source: 'system',
            text: 'Cannot clear session while messages are queued. Remove queued messages first.'
          }]
        };
      }));
      return;
    }

    setSessions(prev => prev.map(s =>
      s.id === activeSession.id ? { ...s, claudeSessionId: undefined, aiLogs: [], state: 'idle' as SessionState } : s
    ));
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
    onAddHistoryEntry: async (entry) => {
      await window.maestro.history.add({
        ...entry,
        id: generateId()
      });
      // Refresh history panel to show the new entry
      rightPanelRef.current?.refreshHistoryPanel();
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

  // Handler to resume a Claude session directly (loads messages into main panel)
  const handleResumeSession = useCallback(async (claudeSessionId: string) => {
    if (!activeSession?.cwd) return;

    try {
      // Load the session messages
      const result = await window.maestro.claude.readSessionMessages(
        activeSession.cwd,
        claudeSessionId,
        { offset: 0, limit: 100 }
      );

      // Convert to log entries
      const messages: LogEntry[] = result.messages.map((msg: { type: string; content: string; timestamp: string; uuid: string }) => ({
        id: msg.uuid || generateId(),
        timestamp: new Date(msg.timestamp).getTime(),
        source: msg.type === 'user' ? 'user' as const : 'stdout' as const,
        text: msg.content || ''
      }));

      // Update the session
      setSessions(prev => prev.map(s => {
        if (s.id !== activeSession.id) return s;
        // Move the session to front of recent list if it exists
        const existingRecent = s.recentClaudeSessions || [];
        const recentSession = existingRecent.find(r => r.sessionId === claudeSessionId);
        const firstMessage = messages.find(m => m.source === 'user')?.text || '';
        const newRecentEntry = {
          sessionId: claudeSessionId,
          firstMessage: firstMessage.slice(0, 100),
          timestamp: new Date().toISOString()
        };
        const filtered = existingRecent.filter(r => r.sessionId !== claudeSessionId);
        const updatedRecent = [recentSession ? { ...recentSession, timestamp: new Date().toISOString() } : newRecentEntry, ...filtered].slice(0, 10);
        return { ...s, claudeSessionId, aiLogs: messages, state: 'idle', inputMode: 'ai', recentClaudeSessions: updatedRecent };
      }));
      setActiveClaudeSessionId(claudeSessionId);
    } catch (error) {
      console.error('Failed to resume session:', error);
    }
  }, [activeSession?.cwd, activeSession?.id]);

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

  // Create visible sessions array (only sessions in expanded groups or ungrouped)
  const visibleSessions = useMemo(() => {
    return sortedSessions.filter(session => {
      if (!session.groupId) return true; // Ungrouped sessions always visible
      const group = groups.find(g => g.id === session.groupId);
      return group && !group.collapsed; // Only show if group is expanded
    });
  }, [sortedSessions, groups]);

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

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
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

      if (hasOpenLayers()) {
        // Allow Tab for accessibility navigation within modals
        if (e.key === 'Tab') return;

        const isCycleShortcut = (e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === '[' || e.key === ']');
        // Allow sidebar toggle shortcuts (Alt+Cmd+Arrow) even when modals are open
        const isLayoutShortcut = e.altKey && (e.metaKey || e.ctrlKey) && (e.key === 'ArrowLeft' || e.key === 'ArrowRight');

        if (hasOpenModal()) {
          // TRUE MODAL is open - block most shortcuts from App.tsx
          // The modal's own handler will handle Cmd+Shift+[] if it supports it
          // BUT allow layout shortcuts (sidebar toggles) to work
          if (!isLayoutShortcut) {
            return;
          }
          // Fall through to handle layout shortcuts below
        } else {
          // Only OVERLAYS are open (FilePreview, LogViewer, etc.)
          // Allow Cmd+Shift+[] to fall through to App.tsx handler
          // (which will cycle right panel tabs when previewFile is set)
          if (!isCycleShortcut && !isLayoutShortcut) {
            return;
          }
          // Fall through to cyclePrev/cycleNext logic below
        }
      }

      // Skip all keyboard handling when editing a session or group name in the sidebar
      if (editingSessionId || editingGroupId) {
        return;
      }

      // Sidebar navigation with arrow keys (works when sidebar has focus)
      if (activeFocus === 'sidebar' && (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === ' ')) {
        e.preventDefault();
        if (sortedSessions.length === 0) return;

        // Get the currently selected session
        const currentSession = sortedSessions[selectedSidebarIndex];

        // Space: Close the current group and jump to nearest visible session
        if (e.key === ' ' && currentSession?.groupId) {
          const currentGroup = groups.find(g => g.id === currentSession.groupId);
          if (currentGroup && !currentGroup.collapsed) {
            // Collapse the group
            setGroups(prev => prev.map(g =>
              g.id === currentGroup.id ? { ...g, collapsed: true } : g
            ));

            // Helper to check if a session will be visible after collapse
            const willBeVisible = (s: Session) => {
              if (s.groupId === currentGroup.id) return false; // In the group being collapsed
              if (!s.groupId) return true; // Ungrouped sessions are always visible
              const g = groups.find(grp => grp.id === s.groupId);
              return g && !g.collapsed; // In an expanded group
            };

            // Find current position in sortedSessions
            const currentIndex = sortedSessions.findIndex(s => s.id === currentSession.id);

            // First, look BELOW (after) the current position
            let nextVisible: Session | undefined;
            for (let i = currentIndex + 1; i < sortedSessions.length; i++) {
              if (willBeVisible(sortedSessions[i])) {
                nextVisible = sortedSessions[i];
                break;
              }
            }

            // If nothing below, look ABOVE (before) the current position
            if (!nextVisible) {
              for (let i = currentIndex - 1; i >= 0; i--) {
                if (willBeVisible(sortedSessions[i])) {
                  nextVisible = sortedSessions[i];
                  break;
                }
              }
            }

            if (nextVisible) {
              const newIndex = sortedSessions.findIndex(s => s.id === nextVisible!.id);
              setSelectedSidebarIndex(newIndex);
              setActiveSessionId(nextVisible.id);
            }
            return;
          }
        }

        // ArrowUp/ArrowDown: Navigate through sessions, expanding collapsed groups as needed
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          const currentIndex = selectedSidebarIndex;
          const totalSessions = sortedSessions.length;

          // Helper to check if a session is in a collapsed group
          const isInCollapsedGroup = (session: Session) => {
            if (!session.groupId) return false;
            const group = groups.find(g => g.id === session.groupId);
            return group?.collapsed ?? false;
          };

          // Helper to get all sessions in a group
          const getGroupSessions = (groupId: string) => {
            return sortedSessions.filter(s => s.groupId === groupId);
          };

          // Find the next session, skipping visible sessions in collapsed groups
          // but stopping when we hit a NEW collapsed group (to expand it)
          let nextIndex = currentIndex;
          let foundCollapsedGroup: string | null = null;

          if (e.key === 'ArrowDown') {
            // Moving down
            for (let i = 1; i <= totalSessions; i++) {
              const candidateIndex = (currentIndex + i) % totalSessions;
              const candidate = sortedSessions[candidateIndex];

              if (!candidate.groupId) {
                // Ungrouped session - can navigate to it
                nextIndex = candidateIndex;
                break;
              }

              const candidateGroup = groups.find(g => g.id === candidate.groupId);
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
                nextIndex = sortedSessions.findIndex(s => s.id === groupSessions[0]?.id);
                break;
              }
              // Same collapsed group, keep looking (shouldn't happen if current is visible)
            }
          } else {
            // Moving up
            for (let i = 1; i <= totalSessions; i++) {
              const candidateIndex = (currentIndex - i + totalSessions) % totalSessions;
              const candidate = sortedSessions[candidateIndex];

              if (!candidate.groupId) {
                // Ungrouped session - can navigate to it
                nextIndex = candidateIndex;
                break;
              }

              const candidateGroup = groups.find(g => g.id === candidate.groupId);
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
                nextIndex = sortedSessions.findIndex(s => s.id === groupSessions[groupSessions.length - 1]?.id);
                break;
              }
              // Same collapsed group, keep looking
            }
          }

          // If we found a collapsed group, expand it
          if (foundCollapsedGroup) {
            setGroups(prev => prev.map(g =>
              g.id === foundCollapsedGroup ? { ...g, collapsed: false } : g
            ));
          }

          setSelectedSidebarIndex(nextIndex);
        }
        return;
      }

      // Enter to load selected session from sidebar
      if (activeFocus === 'sidebar' && e.key === 'Enter') {
        e.preventDefault();
        if (sortedSessions[selectedSidebarIndex]) {
          setActiveSessionId(sortedSessions[selectedSidebarIndex].id);
        }
        return;
      }

      // Tab navigation
      if (e.key === 'Tab') {
        e.preventDefault();
        if (activeFocus === 'sidebar' && !e.shiftKey) {
          // Tab from sidebar goes to main input
          setActiveFocus('main');
          setTimeout(() => inputRef.current?.focus(), 0);
          return;
        }
        const order: FocusArea[] = ['sidebar', 'main', 'right'];
        const currentIdx = order.indexOf(activeFocus);
        if (e.shiftKey) {
           const next = currentIdx === 0 ? order.length - 1 : currentIdx - 1;
           setActiveFocus(order[next]);
        } else {
           const next = currentIdx === order.length - 1 ? 0 : currentIdx + 1;
           setActiveFocus(order[next]);
        }
        return;
      }

      // Escape in main area focuses terminal output
      if (activeFocus === 'main' && e.key === 'Escape' && document.activeElement === inputRef.current) {
        e.preventDefault();
        inputRef.current?.blur();
        terminalOutputRef.current?.focus();
        return;
      }


      // General shortcuts
      if (isShortcut(e, 'toggleSidebar')) setLeftSidebarOpen(p => !p);
      else if (isShortcut(e, 'toggleRightPanel')) setRightPanelOpen(p => !p);
      else if (isShortcut(e, 'newInstance')) addNewSession();
      else if (isShortcut(e, 'killInstance')) deleteSession(activeSessionId);
      else if (isShortcut(e, 'moveToGroup')) {
        if (activeSession) {
          setQuickActionInitialMode('move-to-group');
          setQuickActionOpen(true);
        }
      }
      else if (isShortcut(e, 'cyclePrev')) {
        // If right panel is focused OR file preview is open, cycle through tabs; otherwise cycle sessions
        if (activeFocus === 'right' || previewFile !== null) {
          const tabs: RightPanelTab[] = ['files', 'history', 'scratchpad'];
          const currentIndex = tabs.indexOf(activeRightTab);
          const prevIndex = currentIndex === 0 ? tabs.length - 1 : currentIndex - 1;
          // Skip history tab if in terminal mode
          if (tabs[prevIndex] === 'history' && activeSession && activeSession.inputMode === 'terminal') {
            const prevPrevIndex = prevIndex === 0 ? tabs.length - 1 : prevIndex - 1;
            setActiveRightTab(tabs[prevPrevIndex]);
          } else {
            setActiveRightTab(tabs[prevIndex]);
          }
        } else {
          cycleSession('prev');
        }
      }
      else if (isShortcut(e, 'cycleNext')) {
        // If right panel is focused OR file preview is open, cycle through tabs; otherwise cycle sessions
        if (activeFocus === 'right' || previewFile !== null) {
          const tabs: RightPanelTab[] = ['files', 'history', 'scratchpad'];
          const currentIndex = tabs.indexOf(activeRightTab);
          const nextIndex = (currentIndex + 1) % tabs.length;
          // Skip history tab if in terminal mode
          if (tabs[nextIndex] === 'history' && activeSession && activeSession.inputMode === 'terminal') {
            const nextNextIndex = (nextIndex + 1) % tabs.length;
            setActiveRightTab(tabs[nextNextIndex]);
          } else {
            setActiveRightTab(tabs[nextIndex]);
          }
        } else {
          cycleSession('next');
        }
      }
      else if (isShortcut(e, 'toggleMode')) toggleInputMode();
      else if (isShortcut(e, 'quickAction')) {
        setQuickActionInitialMode('main');
        setQuickActionOpen(true);
      }
      else if (isShortcut(e, 'help')) setShortcutsHelpOpen(true);
      else if (isShortcut(e, 'settings')) { setSettingsModalOpen(true); setSettingsTab('general'); }
      else if (isShortcut(e, 'goToFiles')) { setRightPanelOpen(true); setActiveRightTab('files'); setActiveFocus('right'); }
      else if (isShortcut(e, 'goToHistory')) { setRightPanelOpen(true); setActiveRightTab('history'); setActiveFocus('right'); }
      else if (isShortcut(e, 'goToScratchpad')) { setRightPanelOpen(true); setActiveRightTab('scratchpad'); setActiveFocus('right'); }
      else if (isShortcut(e, 'focusInput')) {
        e.preventDefault();
        setActiveFocus('main');
        setTimeout(() => inputRef.current?.focus(), 0);
      }
      else if (isShortcut(e, 'focusSidebar')) {
        e.preventDefault();
        // Expand sidebar if collapsed
        if (!leftSidebarOpen) {
          setLeftSidebarOpen(true);
        }
        // Focus the sidebar
        setActiveFocus('sidebar');
      }
      else if (isShortcut(e, 'viewGitDiff')) {
        e.preventDefault();
        handleViewGitDiff();
      }
      else if (isShortcut(e, 'viewGitLog')) {
        e.preventDefault();
        if (activeSession?.isGitRepo) {
          setGitLogOpen(true);
        }
      }
      else if (isShortcut(e, 'agentSessions')) {
        e.preventDefault();
        if (activeSession?.toolType === 'claude-code') {
          setActiveClaudeSessionId(null);
          setAgentSessionsOpen(true);
        }
      }

      // Forward slash to open file tree filter when file tree has focus
      if (e.key === '/' && activeFocus === 'right' && activeRightTab === 'files') {
        e.preventDefault();
        setFileTreeFilterOpen(true);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [shortcuts, activeFocus, activeRightTab, sessions, selectedSidebarIndex, activeSessionId, quickActionOpen, settingsModalOpen, shortcutsHelpOpen, newInstanceModalOpen, aboutModalOpen, processMonitorOpen, logViewerOpen, createGroupModalOpen, confirmModalOpen, renameInstanceModalOpen, renameGroupModalOpen, activeSession, previewFile, fileTreeFilter, fileTreeFilterOpen, gitDiffPreview, gitLogOpen, lightboxImage, hasOpenLayers, hasOpenModal, visibleSessions, sortedSessions, groups, bookmarksCollapsed, leftSidebarOpen]);

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

  // Auto-switch away from history tab when in terminal mode
  useEffect(() => {
    if (activeSession && activeRightTab === 'history' && activeSession.inputMode === 'terminal') {
      setActiveRightTab('files');
    }
  }, [activeSession?.inputMode, activeRightTab]);

  // Restore file tree scroll position when switching sessions
  useEffect(() => {
    if (activeSession && fileTreeContainerRef.current && activeSession.fileExplorerScrollPos !== undefined) {
      fileTreeContainerRef.current.scrollTop = activeSession.fileExplorerScrollPos;
    }
  }, [activeSessionId, activeSession?.fileExplorerScrollPos]);

  // Reset shortcuts search when modal closes
  useEffect(() => {
    if (!shortcutsHelpOpen) {
      setShortcutsSearchQuery('');
    }
  }, [shortcutsHelpOpen]);

  // Auto-scroll logs
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'instant' });
  }, [activeSession?.aiLogs, activeSession?.shellLogs, activeSession?.inputMode]);

  // --- ACTIONS ---
  const cycleSession = (dir: 'next' | 'prev') => {
    // Check if we should cycle within the bookmarks folder
    // This happens when: sidebar is open, bookmarks folder is open, and current session is bookmarked
    const activeSession = sessions.find(s => s.id === activeSessionId);
    const bookmarkedSessions = sortedSessions.filter(s => s.bookmarked);
    const shouldCycleInBookmarks = leftSidebarOpen &&
      !bookmarksCollapsed &&
      activeSession?.bookmarked &&
      bookmarkedSessions.length > 0;

    if (shouldCycleInBookmarks) {
      // Cycle only through bookmarked sessions
      const currentIndex = bookmarkedSessions.findIndex(s => s.id === activeSessionId);
      let nextIndex;
      if (dir === 'next') {
        nextIndex = currentIndex === bookmarkedSessions.length - 1 ? 0 : currentIndex + 1;
      } else {
        nextIndex = currentIndex === 0 ? bookmarkedSessions.length - 1 : currentIndex - 1;
      }
      setActiveSessionId(bookmarkedSessions[nextIndex].id);
      return;
    }

    // When left sidebar is collapsed, cycle through ALL sessions (groups not visible)
    // When left sidebar is open, only cycle through visible sessions (not in collapsed groups)
    const visibleSessions = leftSidebarOpen
      ? sortedSessions.filter(session => {
          if (!session.groupId) return true; // Ungrouped sessions are always visible
          const group = groups.find(g => g.id === session.groupId);
          return group && !group.collapsed; // Only include if group is not collapsed
        })
      : sortedSessions; // All sessions when sidebar is collapsed

    if (visibleSessions.length === 0) return;

    const currentIndex = visibleSessions.findIndex(s => s.id === activeSessionId);
    let nextIndex;
    if (dir === 'next') {
      nextIndex = currentIndex === visibleSessions.length - 1 ? 0 : currentIndex + 1;
    } else {
      nextIndex = currentIndex === 0 ? visibleSessions.length - 1 : currentIndex - 1;
    }
    setActiveSessionId(visibleSessions[nextIndex].id);
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

      const newSession: Session = {
        id: newId,
        name,
        toolType: agentId as ToolType,
        state: 'idle',
        cwd: workingDir,
        fullPath: workingDir,
        isGitRepo,
        aiLogs: [{ id: generateId(), timestamp: Date.now(), source: 'system', text: `${name} ready.` }],
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
        messageQueue: [],
        activeTimeMs: 0
      };
      setSessions(prev => [...prev, newSession]);
      setActiveSessionId(newId);
      // Track session creation in global stats
      updateGlobalStats({ totalSessions: 1 });
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

  const updateScratchPad = (content: string) => {
    setSessions(prev => prev.map(s => s.id === activeSessionId ? { ...s, scratchPadContent: content } : s));
  };

  const updateScratchPadState = (state: {
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
  };

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

    // Block slash commands when agent is busy (in AI mode)
    if (inputValue.trim().startsWith('/') && activeSession.state === 'busy' && activeSession.inputMode === 'ai') {
      showFlashNotification('Commands disabled while agent is working');
      return;
    }

    // Block slash commands when there are queued messages
    if (inputValue.trim().startsWith('/') && activeSession.messageQueue.length > 0) {
      const targetLogKey = activeSession.inputMode === 'ai' ? 'aiLogs' : 'shellLogs';
      setSessions(prev => prev.map(s => {
        if (s.id !== activeSessionId) return s;
        return {
          ...s,
          [targetLogKey]: [...s[targetLogKey], {
            id: generateId(),
            timestamp: Date.now(),
            source: 'system',
            text: 'Cannot execute commands while messages are queued. Clear the queue first.'
          }]
        };
      }));
      setInputValue('');
      if (inputRef.current) inputRef.current.style.height = 'auto';
      return;
    }

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
        const targetLogKey = activeSession.inputMode === 'ai' ? 'aiLogs' : 'shellLogs';
        setSessions(prev => prev.map(s => {
          if (s.id !== activeSessionId) return s;
          return {
            ...s,
            [targetLogKey]: [...s[targetLogKey], {
              id: generateId(),
              timestamp: Date.now(),
              source: 'system',
              text: `${commandText} is only available in ${modeLabel} mode.`
            }]
          };
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

            // Queue the command if AI is busy (same as regular messages)
            if (activeSession.state === 'busy') {
              const queuedEntry: LogEntry = {
                id: generateId(),
                timestamp: Date.now(),
                source: 'user',
                text: substitutedPrompt,
                aiCommand: {
                  command: matchingCustomCommand.command,
                  description: matchingCustomCommand.description
                }
              };

              setSessions(prev => prev.map(s => {
                if (s.id !== activeSessionId) return s;
                return {
                  ...s,
                  messageQueue: [...s.messageQueue, queuedEntry],
                  aiCommandHistory: Array.from(new Set([...(s.aiCommandHistory || []), commandText])).slice(-50),
                };
              }));
              return;
            }

            // Add user log showing the command with its interpolated prompt
            // Also track this command for automatic synopsis on completion
            setSessions(prev => prev.map(s => {
              if (s.id !== activeSessionId) return s;
              return {
                ...s,
                aiLogs: [...s.aiLogs, {
                  id: generateId(),
                  timestamp: Date.now(),
                  source: 'user',
                  text: substitutedPrompt,
                  aiCommand: {
                    command: matchingCustomCommand.command,
                    description: matchingCustomCommand.description
                  }
                }],
                aiCommandHistory: Array.from(new Set([...(s.aiCommandHistory || []), commandText])).slice(-50),
                // Track this command so we can run synopsis on completion
                pendingAICommandForSynopsis: matchingCustomCommand.command
              };
            }));

            spawnAgentWithPrompt(substitutedPrompt);
          })();
          return;
        }
      }
    }

    const currentMode = activeSession.inputMode;
    const targetLogKey = currentMode === 'ai' ? 'aiLogs' : 'shellLogs';

    // Queue messages when AI is busy (only in AI mode)
    if (activeSession.state === 'busy' && currentMode === 'ai') {
      const queuedEntry: LogEntry = {
        id: generateId(),
        timestamp: Date.now(),
        source: 'user',
        text: inputValue,
        images: [...stagedImages]
      };

      setSessions(prev => prev.map(s => {
        if (s.id !== activeSessionId) return s;
        return {
          ...s,
          messageQueue: [...s.messageQueue, queuedEntry]
        };
      }));

      // Clear input
      setInputValue('');
      setStagedImages([]);
      if (inputRef.current) inputRef.current.style.height = 'auto';
      return;
    }

    console.log('[processInput] Processing input', {
      currentMode,
      inputValue: inputValue.substring(0, 50),
      toolType: activeSession.toolType,
      sessionId: activeSession.id
    });

    const newEntry: LogEntry = {
      id: generateId(),
      timestamp: Date.now(),
      source: 'user',
      text: inputValue,
      images: [...stagedImages]
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

      return {
        ...s,
        [targetLogKey]: [...s[targetLogKey], newEntry],
        state: 'busy',
        busySource: currentMode,
        thinkingStartTime: currentMode === 'ai' ? Date.now() : s.thinkingStartTime,
        contextUsage: Math.min(s.contextUsage + 5, 100),
        shellCwd: newShellCwd,
        [historyKey]: newHistory
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
    const targetSessionId = currentMode === 'ai' ? `${activeSession.id}-ai` : `${activeSession.id}-terminal`;

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

          // Build spawn args with resume if we have a session ID
          const spawnArgs = [...agent.args];
          const isNewSession = !activeSession.claudeSessionId;

          if (activeSession.claudeSessionId) {
            spawnArgs.push('--resume', activeSession.claudeSessionId);
          }

          // Add read-only/plan mode when auto mode is active
          if (activeBatchRunState.isRunning) {
            spawnArgs.push('--permission-mode', 'plan');
          }

          // Spawn Claude with prompt as argument (use captured value)
          // If images are present, they will be passed via stream-json input format
          // Use agent.path (full path) if available, otherwise fall back to agent.command
          const commandToUse = agent.path || agent.command;
          console.log('[processInput] Spawning Claude:', {
            maestroSessionId: activeSession.id,
            targetSessionId,
            claudeSessionId: activeSession.claudeSessionId || 'NEW SESSION',
            isResume: !!activeSession.claudeSessionId,
            command: commandToUse,
            args: spawnArgs,
            prompt: capturedInputValue.substring(0, 100)
          });
          await window.maestro.process.spawn({
            sessionId: targetSessionId,
            toolType: 'claude-code',
            cwd: activeSession.cwd,
            command: commandToUse,
            args: spawnArgs,
            prompt: capturedInputValue,
            images: capturedImages.length > 0 ? capturedImages : undefined
          });
        } catch (error) {
          console.error('Failed to spawn Claude batch process:', error);
          setSessions(prev => prev.map(s => {
            if (s.id !== activeSessionId) return s;
            return {
              ...s,
              state: 'idle',
              [targetLogKey]: [...s[targetLogKey], {
                id: generateId(),
                timestamp: Date.now(),
                source: 'system',
                text: `Error: Failed to spawn Claude process - ${error.message}`
              }]
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
        setSessions(prev => prev.map(s => {
          if (s.id !== activeSessionId) return s;
          return {
            ...s,
            state: 'idle',
            [targetLogKey]: [...s[targetLogKey], {
              id: generateId(),
              timestamp: Date.now(),
              source: 'system',
              text: `Error: Failed to write to process - ${error.message}`
            }]
          };
        }));
      });
    }
  };

  // Listen for remote commands from web interface
  // This event is triggered by the remote command handler with command data in detail
  useEffect(() => {
    const handleRemoteCommand = async (event: Event) => {
      const customEvent = event as CustomEvent<{ sessionId: string; command: string }>;
      const { sessionId, command } = customEvent.detail;

      console.log('[Remote] Processing remote command via event:', { sessionId, command: command.substring(0, 50) });

      // Find the session directly from sessionsRef (not from React state which may be stale)
      const session = sessionsRef.current.find(s => s.id === sessionId);
      if (!session) {
        console.log('[Remote] ERROR: Session not found in sessionsRef:', sessionId);
        return;
      }

      console.log('[Remote] Found session:', {
        id: session.id,
        claudeSessionId: session.claudeSessionId || 'none',
        state: session.state,
        inputMode: session.inputMode,
        toolType: session.toolType
      });

      // Handle terminal mode commands
      if (session.inputMode === 'terminal') {
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
        const isTerminalMode = session.inputMode === 'terminal';
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
          matchingBuiltinCommand.execute({
            activeSessionId: sessionId,
            sessions: sessionsRef.current,
            setSessions,
            currentMode: session.inputMode,
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
          console.log('[Remote] Built-in command exists but not available in', session.inputMode, 'mode');
          setSessions(prev => prev.map(s => {
            if (s.id !== sessionId) return s;
            return {
              ...s,
              aiLogs: [...s.aiLogs, {
                id: generateId(),
                timestamp: Date.now(),
                source: 'system',
                text: `${commandText} is only available in ${modeLabel} mode.`
              }]
            };
          }));
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
          setSessions(prev => prev.map(s => {
            if (s.id !== sessionId) return s;
            return {
              ...s,
              aiLogs: [...s.aiLogs, {
                id: generateId(),
                timestamp: Date.now(),
                source: 'system',
                text: `Unknown command: ${commandText}`
              }]
            };
          }));
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
        const spawnArgs = [...agent.args];
        if (session.claudeSessionId) {
          spawnArgs.push('--resume', session.claudeSessionId);
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

        // Add user message to logs and set state to busy
        // For custom commands, show the substituted prompt with command metadata
        setSessions(prev => prev.map(s => {
          if (s.id !== sessionId) return s;
          return {
            ...s,
            state: 'busy' as SessionState,
            busySource: 'ai',
            thinkingStartTime: Date.now(),
            aiLogs: [...s.aiLogs, {
              id: generateId(),
              timestamp: Date.now(),
              source: 'user',
              text: promptToSend,
              ...(commandMetadata && { aiCommand: commandMetadata })
            }],
            // Track AI command usage
            ...(commandMetadata && {
              aiCommandHistory: Array.from(new Set([...(s.aiCommandHistory || []), command.trim()])).slice(-50)
            })
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
        setSessions(prev => prev.map(s => {
          if (s.id !== sessionId) return s;
          return {
            ...s,
            state: 'idle' as SessionState,
            busySource: undefined,
            aiLogs: [...s.aiLogs, {
              id: generateId(),
              timestamp: Date.now(),
              source: 'system',
              text: `Error: Failed to process remote command - ${error.message}`
            }]
          };
        }));
      }
    };
    window.addEventListener('maestro:remoteCommand', handleRemoteCommand);
    return () => window.removeEventListener('maestro:remoteCommand', handleRemoteCommand);
  }, []);

  // Process a queued message (called from onExit when queue has items)
  const processQueuedMessage = async (sessionId: string, entry: LogEntry) => {
    // Use sessionsRef.current to get the latest session state (avoids stale closure)
    const session = sessionsRef.current.find(s => s.id === sessionId);
    if (!session) {
      console.error('[processQueuedMessage] Session not found:', sessionId);
      return;
    }

    const targetSessionId = `${sessionId}-ai`;

    try {
      // Get agent configuration
      const agent = await window.maestro.agents.get('claude-code');
      if (!agent) throw new Error('Claude Code agent not found');

      // Build spawn args with resume if we have a session ID
      const spawnArgs = [...agent.args];

      if (session.claudeSessionId) {
        spawnArgs.push('--resume', session.claudeSessionId);
      }

      // Spawn Claude with prompt from queued entry
      const commandToUse = agent.path || agent.command;
      console.log('[processQueuedMessage] Spawning Claude for queued message:', { sessionId, text: entry.text.substring(0, 50) });

      await window.maestro.process.spawn({
        sessionId: targetSessionId,
        toolType: 'claude-code',
        cwd: session.cwd,
        command: commandToUse,
        args: spawnArgs,
        prompt: entry.text,
        images: entry.images && entry.images.length > 0 ? entry.images : undefined
      });
    } catch (error) {
      console.error('[processQueuedMessage] Failed to spawn Claude:', error);
      setSessions(prev => prev.map(s => {
        if (s.id !== sessionId) return s;
        return {
          ...s,
          state: 'idle',
          aiLogs: [...s.aiLogs, {
            id: generateId(),
            timestamp: Date.now(),
            source: 'system',
            text: `Error: Failed to process queued message - ${error.message}`
          }]
        };
      }));
    }
  };

  const handleInterrupt = async () => {
    if (!activeSession) return;

    const currentMode = activeSession.inputMode;
    const targetSessionId = currentMode === 'ai' ? `${activeSession.id}-ai` : `${activeSession.id}-terminal`;
    const targetLogKey = currentMode === 'ai' ? 'aiLogs' : 'shellLogs';

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

          setSessions(prev => prev.map(s => {
            if (s.id !== activeSession.id) return s;
            return {
              ...s,
              [targetLogKey]: [...s[targetLogKey], {
                id: generateId(),
                timestamp: Date.now(),
                source: 'system',
                text: 'Process forcefully terminated'
              }],
              state: 'idle'
            };
          }));
        } catch (killError) {
          console.error('Failed to kill process:', killError);
          setSessions(prev => prev.map(s => {
            if (s.id !== activeSession.id) return s;
            return {
              ...s,
              [targetLogKey]: [...s[targetLogKey], {
                id: generateId(),
                timestamp: Date.now(),
                source: 'system',
                text: `Error: Failed to terminate process - ${killError.message}`
              }],
              state: 'idle'
            };
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

              // Add user log showing the command with its interpolated prompt
              setSessions(prev => prev.map(s => {
                if (s.id !== activeSessionId) return s;
                return {
                  ...s,
                  aiLogs: [...s.aiLogs, {
                    id: generateId(),
                    timestamp: Date.now(),
                    source: 'user',
                    text: substitutedPrompt,
                    aiCommand: {
                      command: selectedCommand.command,
                      description: selectedCommand.description
                    }
                  }],
                  aiCommandHistory: Array.from(new Set([...(s.aiCommandHistory || []), selectedCommand.command])).slice(-50)
                };
              }));

              spawnAgentWithPrompt(substitutedPrompt);
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
              // Block clearing when there are queued messages
              if (activeSession.messageQueue.length > 0) {
                setSessions(prev => prev.map(s => {
                  if (s.id !== activeSession.id) return s;
                  return {
                    ...s,
                    aiLogs: [...s.aiLogs, {
                      id: generateId(),
                      timestamp: Date.now(),
                      source: 'system',
                      text: 'Cannot clear session while messages are queued. Remove queued messages first.'
                    }]
                  };
                }));
                return;
              }
              setSessions(prev => prev.map(s =>
                s.id === activeSession.id ? { ...s, claudeSessionId: undefined, aiLogs: [], state: 'idle' } : s
              ));
              setActiveClaudeSessionId(null);
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
          onClose={() => setAboutModalOpen(false)}
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
          />
        </ErrorBoundary>
      )}

      {/* --- CENTER WORKSPACE --- */}
      <MainPanel
        logViewerOpen={logViewerOpen}
        agentSessionsOpen={agentSessionsOpen}
        activeClaudeSessionId={activeClaudeSessionId}
        activeSession={activeSession}
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
        onResumeClaudeSession={(claudeSessionId: string, messages: LogEntry[], sessionName?: string) => {
          // Update the active session with the selected Claude session ID and load messages
          // Also reset state to 'idle' since we're just loading historical messages
          // Switch to AI mode since we're resuming an AI session
          console.log('[onResumeClaudeSession] Resuming session:', claudeSessionId, 'activeSession:', activeSession?.id, activeSession?.claudeSessionId);
          if (activeSession) {
            // Track this session in recent sessions list
            const firstMessage = messages.find(m => m.source === 'user')?.text || '';
            const newRecentSession = {
              sessionId: claudeSessionId,
              firstMessage: firstMessage.slice(0, 100),
              timestamp: new Date().toISOString(),
              sessionName
            };

            setSessions(prev => {
              console.log('[onResumeClaudeSession] Updating sessions, looking for id:', activeSession.id);
              const updated = prev.map(s => {
                if (s.id !== activeSession.id) return s;
                // Update recent sessions: remove if exists, add to front, keep max 10
                const existingRecent = s.recentClaudeSessions || [];
                const filtered = existingRecent.filter(r => r.sessionId !== claudeSessionId);
                const updatedRecent = [newRecentSession, ...filtered].slice(0, 10);
                return { ...s, claudeSessionId, aiLogs: messages, state: 'idle', inputMode: 'ai', recentClaudeSessions: updatedRecent };
              });
              const updatedSession = updated.find(s => s.id === activeSession.id);
              console.log('[onResumeClaudeSession] Updated session claudeSessionId:', updatedSession?.claudeSessionId);
              return updated;
            });
            setActiveClaudeSessionId(claudeSessionId);
          }
        }}
        onNewClaudeSession={() => {
          // Create a fresh AI terminal session by clearing the Claude session ID and AI logs
          if (activeSession) {
            // Block clearing when there are queued messages
            if (activeSession.messageQueue.length > 0) {
              setSessions(prev => prev.map(s => {
                if (s.id !== activeSession.id) return s;
                return {
                  ...s,
                  aiLogs: [...s.aiLogs, {
                    id: generateId(),
                    timestamp: Date.now(),
                    source: 'system',
                    text: 'Cannot clear session while messages are queued. Remove queued messages first.'
                  }]
                };
              }));
              return;
            }
            setSessions(prev => prev.map(s =>
              s.id === activeSession.id ? { ...s, claudeSessionId: undefined, aiLogs: [], state: 'idle' } : s
            ));
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
          const logs = isAIMode ? activeSession.aiLogs : activeSession.shellLogs;

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

          if (isAIMode) {
            // For AI mode, also delete from the Claude session JSONL file
            // This ensures the context is actually removed for future interactions
            if (activeSession.claudeSessionId && activeSession.cwd) {
              // Delete asynchronously - don't block the UI update
              window.maestro.claude.deleteMessagePair(
                activeSession.cwd,
                activeSession.claudeSessionId,
                logId, // This is the UUID if loaded from Claude session
                log.text // Fallback: match by content if UUID doesn't match
              ).then(result => {
                if (result.success) {
                  console.log('[onDeleteLog] Deleted message pair from Claude session', {
                    linesRemoved: result.linesRemoved
                  });
                } else {
                  console.warn('[onDeleteLog] Failed to delete from Claude session:', result.error);
                }
              }).catch(err => {
                console.error('[onDeleteLog] Error deleting from Claude session:', err);
              });
            }

            // Update aiLogs and aiCommandHistory
            const commandText = log.text.trim();
            const newAICommandHistory = (activeSession.aiCommandHistory || []).filter(
              cmd => cmd !== commandText
            );

            setSessions(sessions.map(s =>
              s.id === activeSession.id
                ? { ...s, aiLogs: newLogs, aiCommandHistory: newAICommandHistory }
                : s
            ));
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
        onRemoveQueuedMessage={(messageId: string) => {
          if (!activeSession) return;
          setSessions(prev => prev.map(s => {
            if (s.id !== activeSession.id) return s;
            return {
              ...s,
              messageQueue: s.messageQueue.filter(msg => msg.id !== messageId)
            };
          }));
        }}
        audioFeedbackCommand={audioFeedbackCommand}
        recentClaudeSessions={activeSession?.recentClaudeSessions || []}
        onResumeRecentSession={async (sessionId: string) => {
          // Resume a session from the recent sessions list
          if (!activeSession?.cwd) return;

          try {
            // Load the session messages
            const result = await window.maestro.claude.readSessionMessages(
              activeSession.cwd,
              sessionId,
              { offset: 0, limit: 100 }
            );

            // Convert to log entries
            const messages: LogEntry[] = result.messages.map((msg: { type: string; content: string; timestamp: string; uuid: string }) => ({
              id: msg.uuid || generateId(),
              timestamp: new Date(msg.timestamp).getTime(),
              source: msg.type === 'user' ? 'user' as const : 'stdout' as const,
              text: msg.content || ''
            }));

            // Update the session and move to front of recent list
            setSessions(prev => prev.map(s => {
              if (s.id !== activeSession.id) return s;
              // Move the session to front of recent list
              const existingRecent = s.recentClaudeSessions || [];
              const recentSession = existingRecent.find(r => r.sessionId === sessionId);
              if (!recentSession) {
                // Session not in recent list, just update the session
                return { ...s, claudeSessionId: sessionId, aiLogs: messages, state: 'idle', inputMode: 'ai' };
              }
              const filtered = existingRecent.filter(r => r.sessionId !== sessionId);
              const updatedRecent = [{ ...recentSession, timestamp: new Date().toISOString() }, ...filtered];
              return { ...s, claudeSessionId: sessionId, aiLogs: messages, state: 'idle', inputMode: 'ai', recentClaudeSessions: updatedRecent };
            }));
            setActiveClaudeSessionId(sessionId);
          } catch (error) {
            console.error('Failed to resume session:', error);
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
            // Save the custom prompt to the session (persisted across restarts)
            setSessions(prev => prev.map(s =>
              s.id === activeSession.id ? { ...s, batchRunnerPrompt: prompt } : s
            ));
          }}
          initialPrompt={activeSession.batchRunnerPrompt || ''}
          showConfirmation={showConfirmation}
        />
      )}

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
      <ToastContainer theme={theme} />
      </div>
  );
}

