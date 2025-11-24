import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  Terminal, Cpu, Plus, Settings, ChevronRight, ChevronDown, ChevronUp, Activity, Folder,
  FileCode, FilePlus, FileDiff, Trash2, Sidebar, Key, FileText,
  Wand2, Edit2, FolderPlus, X, Save, Eye, Columns, Keyboard, Image as ImageIcon,
  Search, Zap, Moon, Sun, Monitor, Globe, Radio, Network, Share2, PanelLeftClose, PanelLeftOpen,
  PanelRightClose, PanelRightOpen, ExternalLink, Wifi, ArrowUp, CornerDownLeft, Info
} from 'lucide-react';
import { NewInstanceModal } from './components/NewInstanceModal';
import { SettingsModal } from './components/SettingsModal';
import { Scratchpad } from './components/Scratchpad';
import { FilePreview } from './components/FilePreview';
import { SessionList } from './components/SessionList';
import { RightPanel } from './components/RightPanel';
import { TerminalOutput } from './components/TerminalOutput';
import { InputArea } from './components/InputArea';
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

// Import custom hooks
import { useSettings, useSessionManager, useFileExplorer } from './hooks';

// Import types and constants
import type {
  ToolType, SessionState, FileChangeType, RightPanelTab, ScratchPadMode,
  ThemeId, FocusArea, LLMProvider, Theme, Shortcut, FileArtifact,
  LogEntry, WorkLogItem, Session, Group
} from './types';
import { THEMES } from './constants/themes';
import { DEFAULT_SHORTCUTS } from './constants/shortcuts';
import { generateId } from './utils/ids';
import { getContextColor, getStatusColor, getFileIcon } from './utils/theme';
import { fuzzyMatch } from './utils/search';
import { shouldOpenExternally, loadFileTree, getAllFolderPaths, flattenTree } from './utils/fileExplorer';

export default function MaestroConsole() {
  // --- STATE ---
  const [sessions, setSessions] = useState<Session[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);

  // Track if initial data has been loaded to prevent overwriting on mount
  const initialLoadComplete = useRef(false);

  const [activeSessionId, setActiveSessionId] = useState<string>(sessions[0]?.id || 's1');
  
  // Input State
  const [inputValue, setInputValue] = useState('');
  const [enterToSend, setEnterToSendState] = useState(true);
  const [slashCommandOpen, setSlashCommandOpen] = useState(false);
  const [selectedSlashCommandIndex, setSelectedSlashCommandIndex] = useState(0);

  const setEnterToSend = (value: boolean) => {
    setEnterToSendState(value);
    window.maestro.settings.set('enterToSend', value);
  };
  
  // UI State
  const [leftSidebarOpen, setLeftSidebarOpen] = useState(true);
  const [rightPanelOpen, setRightPanelOpen] = useState(true);
  const [activeRightTab, setActiveRightTab] = useState<RightPanelTab>('files');
  const [activeFocus, setActiveFocus] = useState<FocusArea>('main');
  const [leftSidebarWidthState, setLeftSidebarWidthState] = useState(256); // 256px = w-64
  const [rightPanelWidthState, setRightPanelWidthState] = useState(384); // 384px = w-96
  const [markdownRawMode, setMarkdownRawModeState] = useState(false);

  // Wrapper functions for persisting panel widths and markdown mode
  const setLeftSidebarWidth = (width: number) => {
    setLeftSidebarWidthState(width);
    window.maestro.settings.set('leftSidebarWidth', width);
  };

  const setRightPanelWidth = (width: number) => {
    setRightPanelWidthState(width);
    window.maestro.settings.set('rightPanelWidth', width);
  };

  const setMarkdownRawMode = (value: boolean) => {
    setMarkdownRawModeState(value);
    window.maestro.settings.set('markdownRawMode', value);
  };

  // File Explorer State
  const [previewFile, setPreviewFile] = useState<{name: string; content: string; path: string} | null>(null);
  const [selectedFileIndex, setSelectedFileIndex] = useState(0);
  const [flatFileList, setFlatFileList] = useState<any[]>([]);
  const [fileTreeFilter, setFileTreeFilter] = useState('');
  const [fileTreeFilterOpen, setFileTreeFilterOpen] = useState(false);

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
  const [settingsTab, setSettingsTab] = useState<'general' | 'shortcuts' | 'theme' | 'network'>('general');
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);
  const [aboutModalOpen, setAboutModalOpen] = useState(false);
  const [logViewerOpen, setLogViewerOpen] = useState(false);
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

  // Images Staging
  const [stagedImages, setStagedImages] = useState<string[]>([]);

  // Configuration State (Simulating ~/.maestro/settings)
  const [activeThemeId, setActiveThemeId] = useState<ThemeId>('dracula');
  const [shortcuts, setShortcuts] = useState<Record<string, Shortcut>>(DEFAULT_SHORTCUTS);
  
  // LLM Config
  const [llmProvider, setLlmProvider] = useState<LLMProvider>('openrouter');
  const [modelSlug, setModelSlug] = useState('anthropic/claude-3.5-sonnet');
  const [apiKey, setApiKey] = useState('');
  
  // Tunnel Config
  const [tunnelProvider, setTunnelProvider] = useState('ngrok');
  const [tunnelApiKey, setTunnelApiKey] = useState('');

  // Agent Config
  const [defaultAgent, setDefaultAgent] = useState('claude-code');

  // Font Config
  const [fontFamily, setFontFamilyState] = useState('Roboto Mono, Menlo, "Courier New", monospace');
  const [fontSize, setFontSizeState] = useState(14); // Base font size in px
  const [customFonts, setCustomFonts] = useState<string[]>([]);

  // Terminal Config
  const [terminalWidth, setTerminalWidthState] = useState(100); // Terminal columns

  // Logging Config
  const [logLevel, setLogLevelState] = useState('info');

  // Wrapper functions that persist to electron-store
  const setLlmProviderPersist = (value: LLMProvider) => {
    setLlmProvider(value);
    window.maestro.settings.set('llmProvider', value);
  };

  const setModelSlugPersist = (value: string) => {
    setModelSlug(value);
    window.maestro.settings.set('modelSlug', value);
  };

  const setApiKeyPersist = (value: string) => {
    setApiKey(value);
    window.maestro.settings.set('apiKey', value);
  };

  const setTunnelProviderPersist = (value: string) => {
    setTunnelProvider(value);
    window.maestro.settings.set('tunnelProvider', value);
  };

  const setTunnelApiKeyPersist = (value: string) => {
    setTunnelApiKey(value);
    window.maestro.settings.set('tunnelApiKey', value);
  };

  const setDefaultAgentPersist = (value: string) => {
    setDefaultAgent(value);
    window.maestro.settings.set('defaultAgent', value);
  };

  const setFontFamily = (value: string) => {
    setFontFamilyState(value);
    window.maestro.settings.set('fontFamily', value);
  };

  const setFontSize = (value: number) => {
    setFontSizeState(value);
    window.maestro.settings.set('fontSize', value);
  };

  const setTerminalWidth = (value: number) => {
    setTerminalWidthState(value);
    window.maestro.settings.set('terminalWidth', value);
  };

  const setLogLevel = async (value: string) => {
    setLogLevelState(value);
    await window.maestro.logger.setLogLevel(value);
  };

  // Load settings from electron-store on mount
  useEffect(() => {
    const loadSettings = async () => {
      const savedEnterToSend = await window.maestro.settings.get('enterToSend');
      const savedLlmProvider = await window.maestro.settings.get('llmProvider');
      const savedModelSlug = await window.maestro.settings.get('modelSlug');
      const savedApiKey = await window.maestro.settings.get('apiKey');
      const savedTunnelProvider = await window.maestro.settings.get('tunnelProvider');
      const savedTunnelApiKey = await window.maestro.settings.get('tunnelApiKey');
      const savedDefaultAgent = await window.maestro.settings.get('defaultAgent');
      const savedFontSize = await window.maestro.settings.get('fontSize');
      const savedFontFamily = await window.maestro.settings.get('fontFamily');
      const savedCustomFonts = await window.maestro.settings.get('customFonts');
      const savedTerminalWidth = await window.maestro.settings.get('terminalWidth');
      const savedLeftSidebarWidth = await window.maestro.settings.get('leftSidebarWidth');
      const savedRightPanelWidth = await window.maestro.settings.get('rightPanelWidth');
      const savedMarkdownRawMode = await window.maestro.settings.get('markdownRawMode');
      const savedShortcuts = await window.maestro.settings.get('shortcuts');
      const savedLogLevel = await window.maestro.logger.getLogLevel();

      if (savedEnterToSend !== undefined) setEnterToSendState(savedEnterToSend);
      if (savedLlmProvider !== undefined) setLlmProvider(savedLlmProvider);
      if (savedModelSlug !== undefined) setModelSlug(savedModelSlug);
      if (savedApiKey !== undefined) setApiKey(savedApiKey);
      if (savedTunnelProvider !== undefined) setTunnelProvider(savedTunnelProvider);
      if (savedTunnelApiKey !== undefined) setTunnelApiKey(savedTunnelApiKey);
      if (savedDefaultAgent !== undefined) setDefaultAgent(savedDefaultAgent);
      if (savedFontSize !== undefined) setFontSizeState(savedFontSize);
      if (savedFontFamily !== undefined) setFontFamilyState(savedFontFamily);
      if (savedCustomFonts !== undefined) setCustomFonts(savedCustomFonts);
      if (savedTerminalWidth !== undefined) setTerminalWidthState(savedTerminalWidth);
      if (savedLeftSidebarWidth !== undefined) setLeftSidebarWidthState(savedLeftSidebarWidth);
      if (savedRightPanelWidth !== undefined) setRightPanelWidthState(savedRightPanelWidth);
      if (savedMarkdownRawMode !== undefined) setMarkdownRawModeState(savedMarkdownRawMode);
      if (savedLogLevel !== undefined) setLogLevelState(savedLogLevel);

      // Merge saved shortcuts with defaults (in case new shortcuts were added)
      if (savedShortcuts !== undefined) {
        setShortcuts({ ...DEFAULT_SHORTCUTS, ...savedShortcuts });
      }
    };
    loadSettings();
  }, []);

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
          state: 'error' as SessionState
        };
      }

      const terminalAgent = await window.maestro.agents.get('terminal');
      if (!terminalAgent) {
        console.error('Terminal agent not found');
        return {
          ...correctedSession,
          aiPid: -1,
          terminalPid: -1,
          state: 'error' as SessionState
        };
      }

      // Spawn BOTH processes for dual-process architecture
      // 1. Spawn AI agent process (never use 'terminal' as toolType here)
      const aiSpawnResult = await window.maestro.process.spawn({
        sessionId: `${correctedSession.id}-ai`,
        toolType: aiAgentType,  // Use aiAgentType, not correctedSession.toolType
        cwd: correctedSession.cwd,
        command: agent.command,
        args: agent.args || []
      });

      // 2. Spawn terminal process
      const terminalSpawnResult = await window.maestro.process.spawn({
        sessionId: `${correctedSession.id}-terminal`,
        toolType: 'terminal',
        cwd: correctedSession.cwd,
        command: terminalAgent.command,
        args: terminalAgent.args || []
      });

      if (aiSpawnResult.success && aiSpawnResult.pid > 0 &&
          terminalSpawnResult.success && terminalSpawnResult.pid > 0) {
        // Add restoration messages to both log arrays
        const aiRestorationLog: LogEntry = {
          id: generateId(),
          timestamp: Date.now(),
          source: 'system',
          text: 'AI agent restored after app restart'
        };

        const terminalRestorationLog: LogEntry = {
          id: generateId(),
          timestamp: Date.now(),
          source: 'system',
          text: 'Terminal restored after app restart'
        };

        return {
          ...correctedSession,
          aiPid: aiSpawnResult.pid,
          terminalPid: terminalSpawnResult.pid,
          state: 'idle' as SessionState,
          aiLogs: [...correctedSession.aiLogs, aiRestorationLog],
          shellLogs: [...correctedSession.shellLogs, terminalRestorationLog]
        };
      } else {
        // Process spawn failed
        console.error(`Failed to restore session ${session.id}`);
        return {
          ...session,
          aiPid: -1,
          terminalPid: -1,
          state: 'error' as SessionState
        };
      }
    } catch (error) {
      console.error(`Error restoring session ${session.id}:`, error);
      return {
        ...session,
        aiPid: -1,
        terminalPid: -1,
        state: 'error' as SessionState
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
      }
    };
    loadSessionsAndGroups();
  }, []);

  // Apply font size to HTML root element so rem-based Tailwind classes scale
  useEffect(() => {
    document.documentElement.style.fontSize = `${fontSize}px`;
  }, [fontSize]);

  // Persist shortcuts when they change
  useEffect(() => {
    window.maestro.settings.set('shortcuts', shortcuts);
  }, [shortcuts]);

  // Set up process event listeners for real-time output
  useEffect(() => {
    // Handle process output data
    // sessionId will be in format: "{id}-ai" or "{id}-terminal"
    const unsubscribeData = window.maestro.process.onData((sessionId: string, data: string) => {
      console.log('[onData] Received data for session:', sessionId, 'Data:', data);

      // Parse sessionId to determine which process this is from
      let actualSessionId: string;
      let isFromAi: boolean;

      if (sessionId.endsWith('-ai')) {
        actualSessionId = sessionId.slice(0, -3); // Remove "-ai" suffix
        isFromAi = true;
      } else if (sessionId.endsWith('-terminal')) {
        actualSessionId = sessionId.slice(0, -9); // Remove "-terminal" suffix
        isFromAi = false;
      } else {
        // Fallback for old sessions without suffix
        actualSessionId = sessionId;
        isFromAi = false;
      }

      setSessions(prev => prev.map(s => {
        if (s.id !== actualSessionId) return s;

        // Route to correct log array based on which process sent the data
        const targetLogKey = isFromAi ? 'aiLogs' : 'shellLogs';
        const existingLogs = s[targetLogKey];
        const lastLog = existingLogs[existingLogs.length - 1];
        const now = Date.now();

        // Group consecutive stdout outputs within 500ms into the same log entry
        const shouldGroup = lastLog &&
                           lastLog.source === 'stdout' &&
                           (now - lastLog.timestamp) < 500;

        if (shouldGroup) {
          // Append to existing log entry
          const updatedLogs = [...existingLogs];
          updatedLogs[updatedLogs.length - 1] = {
            ...lastLog,
            text: lastLog.text + data
          };

          console.log('[onData] Appending to existing log for', targetLogKey, 'session', actualSessionId);
          return {
            ...s,
            state: 'idle' as SessionState,
            [targetLogKey]: updatedLogs
          };
        } else {
          // Create new log entry
          const newLog: LogEntry = {
            id: generateId(),
            timestamp: now,
            source: 'stdout',
            text: data
          };

          console.log('[onData] Creating new log for', targetLogKey, 'session', actualSessionId);
          return {
            ...s,
            state: 'idle' as SessionState,
            [targetLogKey]: [...existingLogs, newLog]
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
      } else {
        actualSessionId = sessionId;
        isFromAi = false;
      }

      setSessions(prev => prev.map(s => {
        if (s.id !== actualSessionId) return s;

        // Route to correct log array based on which process exited
        const targetLogKey = isFromAi ? 'aiLogs' : 'shellLogs';
        const processType = isFromAi ? 'AI agent' : 'Terminal';
        const exitLog: LogEntry = {
          id: generateId(),
          timestamp: Date.now(),
          source: 'system',
          text: `${processType} process exited with code ${code}`
        };

        return {
          ...s,
          state: 'idle' as SessionState,
          [targetLogKey]: [...s[targetLogKey], exitLog]
        };
      }));
    });

    // Handle Claude session ID capture from batch mode
    const unsubscribeSessionId = window.maestro.process.onSessionId((sessionId: string, claudeSessionId: string) => {
      console.log('[onSessionId] Received Claude session ID:', claudeSessionId, 'for session:', sessionId);

      // Parse sessionId to get actual session ID
      let actualSessionId: string;
      if (sessionId.endsWith('-ai')) {
        actualSessionId = sessionId.slice(0, -3);
      } else {
        actualSessionId = sessionId;
      }

      // Store Claude session ID in session state
      setSessions(prev => prev.map(s => {
        if (s.id !== actualSessionId) return s;

        console.log('[onSessionId] Storing Claude session ID for session:', actualSessionId, 'claudeSessionId:', claudeSessionId);
        return {
          ...s,
          claudeSessionId
        };
      }));
    });

    // Cleanup listeners on unmount
    return () => {
      unsubscribeData();
      unsubscribeExit();
      unsubscribeSessionId();
    };
  }, []);

  // Refs
  const logsEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const terminalOutputRef = useRef<HTMLDivElement>(null);
  const fileTreeContainerRef = useRef<HTMLDivElement>(null);

  // Keyboard navigation state
  const [selectedSidebarIndex, setSelectedSidebarIndex] = useState(0);
  const activeSession = sessions.find(s => s.id === activeSessionId) || sessions[0] || null;
  const theme = THEMES[activeThemeId];
  const anyTunnelActive = sessions.some(s => s.tunnelActive);

  // Create sorted sessions array that matches visual display order
  const sortedSessions = useMemo(() => {
    const sorted: Session[] = [];

    // First, add sessions from sorted groups
    const sortedGroups = [...groups].sort((a, b) => a.name.localeCompare(b.name));
    sortedGroups.forEach(group => {
      const groupSessions = sessions
        .filter(s => s.groupId === group.id)
        .sort((a, b) => a.name.localeCompare(b.name));
      sorted.push(...groupSessions);
    });

    // Then, add ungrouped sessions (sorted alphabetically)
    const ungroupedSessions = sessions
      .filter(s => !s.groupId)
      .sort((a, b) => a.name.localeCompare(b.name));
    sorted.push(...ungroupedSessions);

    return sorted;
  }, [sessions, groups]);

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

  // Set CSS variable for accent color (for scrollbar styling)
  useEffect(() => {
    document.documentElement.style.setProperty('--accent-color', theme.colors.accent);
  }, [theme.colors.accent]);

  // Add scroll listeners to highlight scrollbars during active scrolling
  useEffect(() => {
    const scrollTimeouts = new Map<Element, NodeJS.Timeout>();

    const handleScroll = (e: Event) => {
      const target = e.target as Element;
      if (!target.classList.contains('scrollbar-thin')) return;

      // Add scrolling class
      target.classList.add('scrolling');

      // Clear existing timeout for this element
      const existingTimeout = scrollTimeouts.get(target);
      if (existingTimeout) {
        clearTimeout(existingTimeout);
      }

      // Remove scrolling class after 1 second of no scrolling
      const timeout = setTimeout(() => {
        target.classList.remove('scrolling');
        scrollTimeouts.delete(target);
      }, 1000);

      scrollTimeouts.set(target, timeout);
    };

    // Add listener to capture scroll events
    document.addEventListener('scroll', handleScroll, true);

    return () => {
      document.removeEventListener('scroll', handleScroll, true);
      scrollTimeouts.forEach(timeout => clearTimeout(timeout));
      scrollTimeouts.clear();
    };
  }, []);

  // --- KEYBOARD MANAGEMENT ---
  const isShortcut = (e: KeyboardEvent, actionId: string) => {
    const sc = shortcuts[actionId];
    if (!sc) return false;
    const keys = sc.keys.map(k => k.toLowerCase());
    
    const metaPressed = e.metaKey || e.ctrlKey;
    const shiftPressed = e.shiftKey;
    const key = e.key.toLowerCase();

    const configMeta = keys.includes('meta') || keys.includes('ctrl') || keys.includes('command');
    const configShift = keys.includes('shift');
    
    if (metaPressed !== configMeta) return false;
    if (shiftPressed !== configShift) return false;

    const mainKey = keys[keys.length - 1];
    if (mainKey === '/' && key === '/') return true;
    if (mainKey === 'arrowleft' && key === 'arrowleft') return true;
    if (mainKey === 'arrowright' && key === 'arrowright') return true;
    if (mainKey === 'backspace' && key === 'backspace') return true;
    if (mainKey === '{' && key === '[') return true;
    if (mainKey === '}' && key === ']') return true;

    return key === mainKey;
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't intercept if modals are open
      const modalOpen = quickActionOpen || settingsModalOpen || shortcutsHelpOpen || newInstanceModalOpen || aboutModalOpen || createGroupModalOpen || confirmModalOpen || renameInstanceModalOpen || renameGroupModalOpen;

      // If any modal is open, only handle Escape key here and let modals handle everything else
      if (modalOpen) {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();

          // Close only the topmost modal (in z-index order, highest first)
          if (confirmModalOpen) {
            setConfirmModalOpen(false);
          } else if (renameInstanceModalOpen) {
            setRenameInstanceModalOpen(false);
          } else if (renameGroupModalOpen) {
            setRenameGroupModalOpen(false);
          } else if (createGroupModalOpen) {
            setCreateGroupModalOpen(false);
          } else if (newInstanceModalOpen) {
            setNewInstanceModalOpen(false);
          } else if (quickActionOpen) {
            setQuickActionOpen(false);
          } else if (shortcutsHelpOpen) {
            setShortcutsHelpOpen(false);
          } else if (aboutModalOpen) {
            setAboutModalOpen(false);
          } else if (settingsModalOpen) {
            setSettingsModalOpen(false);
          } else if (lightboxImage) {
            setLightboxImage(null);
          } else if (previewFile) {
            setPreviewFile(null);
          }
        }
        // For tabbed modals, handle Cmd+Shift+[ and ] for tab navigation
        else if (settingsModalOpen && isShortcut(e, 'cyclePrev')) {
          e.preventDefault();
          // This will be handled in SettingsModal component
        }
        else if (settingsModalOpen && isShortcut(e, 'cycleNext')) {
          e.preventDefault();
          // This will be handled in SettingsModal component
        }
        // Don't process any other shortcuts when modals are open
        return;
      }

      // Sidebar navigation with arrow keys (works when sidebar has focus)
      if (activeFocus === 'sidebar' && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && !modalOpen) {
        e.preventDefault();
        const totalSessions = sortedSessions.length;
        if (totalSessions === 0) return;

        if (e.key === 'ArrowDown') {
          setSelectedSidebarIndex(prev => {
            const next = (prev + 1) % totalSessions;
            // Auto-expand group if the selected session belongs to a collapsed group
            const nextSession = sortedSessions[next];
            if (nextSession?.groupId) {
              const group = groups.find(g => g.id === nextSession.groupId);
              if (group?.collapsed) {
                toggleGroup(group.id);
              }
            }
            return next;
          });
        } else {
          setSelectedSidebarIndex(prev => {
            const next = (prev - 1 + totalSessions) % totalSessions;
            // Auto-expand group if the selected session belongs to a collapsed group
            const nextSession = sortedSessions[next];
            if (nextSession?.groupId) {
              const group = groups.find(g => g.id === nextSession.groupId);
              if (group?.collapsed) {
                toggleGroup(group.id);
              }
            }
            return next;
          });
        }
        return;
      }

      // Enter to load selected session from sidebar
      if (activeFocus === 'sidebar' && e.key === 'Enter' && !modalOpen) {
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

      // Terminal output scrolling
      if (document.activeElement === terminalOutputRef.current) {
        // / to open search
        if (e.key === '/' && !outputSearchOpen) {
          e.preventDefault();
          setOutputSearchOpen(true);
          return;
        }
        // Escape handling
        if (e.key === 'Escape') {
          e.preventDefault();
          if (outputSearchOpen) {
            // Close search but stay focused on output
            setOutputSearchOpen(false);
            setOutputSearchQuery('');
          } else {
            // Focus back to text input
            inputRef.current?.focus();
            setActiveFocus('main');
          }
          return;
        }
        if (e.key === 'ArrowUp' && !e.metaKey && !e.ctrlKey) {
          e.preventDefault();
          terminalOutputRef.current?.scrollBy({ top: -40, behavior: 'smooth' });
          return;
        }
        if (e.key === 'ArrowDown' && !e.metaKey && !e.ctrlKey) {
          e.preventDefault();
          terminalOutputRef.current?.scrollBy({ top: 40, behavior: 'smooth' });
          return;
        }
        // Cmd+Up to jump to top
        if (e.key === 'ArrowUp' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          terminalOutputRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
          return;
        }
        // Cmd+Down to jump to bottom
        if (e.key === 'ArrowDown' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          terminalOutputRef.current?.scrollTo({ top: terminalOutputRef.current.scrollHeight, behavior: 'smooth' });
          return;
        }
      }

      // General shortcuts
      if (isShortcut(e, 'toggleSidebar')) setLeftSidebarOpen(p => !p);
      else if (isShortcut(e, 'toggleRightPanel')) setRightPanelOpen(p => !p);
      else if (isShortcut(e, 'newInstance')) addNewSession();
      else if (isShortcut(e, 'killInstance')) deleteSession(activeSessionId);
      else if (isShortcut(e, 'cyclePrev')) {
        // If right panel is focused, cycle through tabs; otherwise cycle sessions
        if (activeFocus === 'right') {
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
        // If right panel is focused, cycle through tabs; otherwise cycle sessions
        if (activeFocus === 'right') {
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
      else if (isShortcut(e, 'quickAction')) setQuickActionOpen(true);
      else if (isShortcut(e, 'help')) setShortcutsHelpOpen(true);
      else if (isShortcut(e, 'settings')) { setSettingsModalOpen(true); setSettingsTab('general'); }
      else if (isShortcut(e, 'goToFiles')) { setRightPanelOpen(true); setActiveRightTab('files'); setActiveFocus('right'); }
      else if (isShortcut(e, 'goToHistory')) { setRightPanelOpen(true); setActiveRightTab('history'); setActiveFocus('right'); }
      else if (isShortcut(e, 'goToScratchpad')) { setRightPanelOpen(true); setActiveRightTab('scratchpad'); setActiveFocus('right'); }

      // Forward slash to open file tree filter when file tree has focus
      if (e.key === '/' && activeFocus === 'right' && activeRightTab === 'files') {
        e.preventDefault();
        setFileTreeFilterOpen(true);
      }

      // Escape key for non-modal elements (preview, lightbox, file tree filter)
      if (e.key === 'Escape' && !modalOpen) {
        setLightboxImage(null);
        setPreviewFile(null);
        setFileTreeFilterOpen(false);
        setFileTreeFilter('');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [shortcuts, activeFocus, activeRightTab, sessions, selectedSidebarIndex, activeSessionId, quickActionOpen, settingsModalOpen, shortcutsHelpOpen, newInstanceModalOpen, aboutModalOpen, activeSession, previewFile, fileTreeFilter, fileTreeFilterOpen]);

  // Sync selectedSidebarIndex with activeSessionId
  useEffect(() => {
    const currentIndex = sortedSessions.findIndex(s => s.id === activeSessionId);
    if (currentIndex !== -1 && currentIndex !== selectedSidebarIndex) {
      setSelectedSidebarIndex(currentIndex);
    }
  }, [activeSessionId, sortedSessions]);

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

  // Handle Escape key for About modal
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && aboutModalOpen) {
        setAboutModalOpen(false);
      }
    };

    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [aboutModalOpen]);

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
    // Only cycle through visible sessions (not in collapsed groups)
    const visibleSessions = sortedSessions.filter(session => {
      if (!session.groupId) return true; // Ungrouped sessions are always visible
      const group = groups.find(g => g.id === session.groupId);
      return group && !group.collapsed; // Only include if group is not collapsed
    });

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
      const aiSpawnResult = await window.maestro.process.spawn({
        sessionId: `${newId}-ai`,
        toolType: agentId,
        cwd: workingDir,
        command: agent.command,
        args: agent.args || []
      });

      if (!aiSpawnResult.success || aiSpawnResult.pid <= 0) {
        throw new Error('Failed to spawn AI agent process');
      }

      // 2. Spawn terminal process
      const terminalSpawnResult = await window.maestro.process.spawn({
        sessionId: `${newId}-terminal`,
        toolType: 'terminal',
        cwd: workingDir,
        command: terminalAgent.command,
        args: terminalAgent.args || []
      });

      if (!terminalSpawnResult.success || terminalSpawnResult.pid <= 0) {
        throw new Error('Failed to spawn terminal process');
      }

      const newSession: Session = {
        id: newId,
        name,
        toolType: agentId as ToolType,
        state: 'idle',
        cwd: workingDir,
        fullPath: workingDir,
        isGitRepo: false,
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
        tunnelActive: false,
        changedFiles: [],
        fileTree: [],
        fileExplorerExpanded: [],
        fileExplorerScrollPos: 0,
        shellCwd: workingDir,
        commandHistory: []
      };
      setSessions(prev => [...prev, newSession]);
      setActiveSessionId(newId);
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
  };

  const toggleTunnel = (sessId: string) => {
    setSessions(prev => prev.map(s => {
       if (s.id !== sessId) return s;
       const isActive = !s.tunnelActive;
       return {
         ...s,
         tunnelActive: isActive,
         tunnelUrl: isActive ? `https://${generateId()}.${tunnelProvider === 'ngrok' ? 'ngrok.io' : 'trycloudflare.com'}` : undefined
       };
    }));
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
    setSessions(prev => prev.map(s => s.id === sessId ? { ...s, name: newName } : s));
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
    if (!activeSession || (!inputValue.trim() && stagedImages.length === 0)) return;

    // Handle slash commands
    if (inputValue.trim().startsWith('/')) {
      const commandText = inputValue.trim();
      const matchingCommand = slashCommands.find(cmd => cmd.command === commandText);

      if (matchingCommand) {
        matchingCommand.execute({
          activeSessionId,
          sessions,
          setSessions,
          currentMode: activeSession.inputMode
        });

        setInputValue('');
        setSlashCommandOpen(false);
        if (inputRef.current) inputRef.current.style.height = 'auto';
        return;
      }
    }

    const currentMode = activeSession.inputMode;
    const targetLogKey = currentMode === 'ai' ? 'aiLogs' : 'shellLogs';

    const newEntry: LogEntry = {
      id: generateId(),
      timestamp: Date.now(),
      source: 'user',
      text: inputValue,
      images: [...stagedImages]
    };

    // Track shell CWD changes when in terminal mode
    let newShellCwd = activeSession.shellCwd;
    if (currentMode === 'terminal') {
      const cdMatch = inputValue.trim().match(/^cd\s+(.+)$/);
      if (cdMatch) {
        const targetPath = cdMatch[1].trim().replace(/^['"]|['"]$/g, ''); // Remove quotes
        if (targetPath === '~') {
          // Navigate to home directory (simplified, could use actual home)
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

      // Add command to history (avoid duplicates of most recent command)
      const newHistory = [...(s.commandHistory || [])];
      if (inputValue.trim() && (newHistory.length === 0 || newHistory[newHistory.length - 1] !== inputValue.trim())) {
        newHistory.push(inputValue.trim());
      }

      return {
        ...s,
        [targetLogKey]: [...s[targetLogKey], newEntry],
        state: 'busy',
        contextUsage: Math.min(s.contextUsage + 5, 100),
        shellCwd: newShellCwd,
        commandHistory: newHistory
      };
    }));

    setInputValue('');
    setStagedImages([]);

    // Reset height
    if (inputRef.current) inputRef.current.style.height = 'auto';

    // Write to the appropriate process based on inputMode
    // Each session has TWO processes: AI agent and terminal
    const targetPid = currentMode === 'ai' ? activeSession.aiPid : activeSession.terminalPid;
    const targetSessionId = currentMode === 'ai' ? `${activeSession.id}-ai` : `${activeSession.id}-terminal`;

    // Check if this is Claude Code in batch mode (AI mode with claude-code tool)
    const isClaudeBatchMode = currentMode === 'ai' && activeSession.toolType === 'claude-code';

    if (isClaudeBatchMode) {
      // Batch mode: Spawn new Claude process with prompt
      (async () => {
        try {
          // Get agent configuration
          const agent = await window.maestro.agents.get('claude-code');
          if (!agent) throw new Error('Claude Code agent not found');

          // Build spawn args with resume if we have a session ID
          const spawnArgs = [...agent.args];
          if (activeSession.claudeSessionId) {
            spawnArgs.push('--resume', activeSession.claudeSessionId);
          }

          // Spawn Claude with prompt as argument
          await window.maestro.process.spawn({
            sessionId: targetSessionId,
            toolType: 'claude-code',
            cwd: activeSession.cwd,
            command: agent.command,
            args: spawnArgs,
            prompt: inputValue
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
    } else if (targetPid > 0) {
      // Interactive mode: Write to stdin
      const dataToSend = currentMode === 'terminal' ? inputValue + '\n' : inputValue;
      window.maestro.process.write(targetSessionId, dataToSend).catch(error => {
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

  const handleInputKeyDown = (e: React.KeyboardEvent) => {
    // Handle command history modal
    if (commandHistoryOpen) {
      return; // Let the modal handle keys
    }

    // Handle slash command autocomplete
    if (slashCommandOpen) {
      const filteredCommands = slashCommands.filter(cmd =>
        cmd.command.toLowerCase().startsWith(inputValue.toLowerCase())
      );

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedSlashCommandIndex(prev =>
          Math.min(prev + 1, filteredCommands.length - 1)
        );
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedSlashCommandIndex(prev => Math.max(prev - 1, 0));
      } else if (e.key === 'Tab' || (e.key === 'Enter' && filteredCommands.length > 0)) {
        e.preventDefault();
        setInputValue(filteredCommands[selectedSlashCommandIndex]?.command || inputValue);
        setSlashCommandOpen(false);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setSlashCommandOpen(false);
      }
      return;
    }

    if (e.key === 'Enter') {
      if (enterToSend && !e.shiftKey && !e.metaKey) {
        e.preventDefault();
        processInput();
      } else if (!enterToSend && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        processInput();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      inputRef.current?.blur();
      terminalOutputRef.current?.focus();
    } else if (e.key === 'ArrowUp') {
      if ((activeSession.commandHistory || []).length > 0) {
        e.preventDefault();
        setCommandHistoryOpen(true);
        setCommandHistoryFilter(inputValue);
        setCommandHistorySelectedIndex(0);
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
          await window.maestro.shell.openExternal(`file://${fullPath}`);
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
          toggleFolder(selectedItem.fullPath, activeSessionId, setSessions);
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

  const renderTree = (nodes: any[], currentPath = '', depth = 0, globalIndex = { value: 0 }) => {
    const expandedSet = new Set(activeSession?.fileExplorerExpanded || []);
    return nodes.map((node, idx) => {
      const fullPath = currentPath ? `${currentPath}/${node.name}` : node.name;
      const change = activeSession?.changedFiles.find(f => f.path.includes(node.name));
      const isFolder = node.type === 'folder';
      const isExpanded = expandedSet.has(fullPath);
      const isSelected = previewFile?.path === fullPath;
      const currentIndex = globalIndex.value;
      const isKeyboardSelected = activeFocus === 'right' && activeRightTab === 'files' && currentIndex === selectedFileIndex;
      globalIndex.value++;

      return (
        <div key={idx} className={depth > 0 ? "ml-3 border-l pl-2" : ""} style={{ borderColor: theme.colors.border }}>
          <div
            className={`flex items-center gap-2 py-1 text-xs cursor-pointer hover:bg-white/5 px-2 rounded transition-colors border-l-2 ${isSelected ? 'bg-white/10' : ''}`}
            style={{
              color: change ? theme.colors.textMain : theme.colors.textDim,
              borderLeftColor: isKeyboardSelected ? theme.colors.accent : 'transparent',
              backgroundColor: isKeyboardSelected ? theme.colors.bgActivity : (isSelected ? 'rgba(255,255,255,0.1)' : 'transparent')
            }}
            onClick={() => {
              if (isFolder) {
                toggleFolder(fullPath, activeSessionId, setSessions);
              } else {
                // Single click on file: just select it and focus the file tree
                setSelectedFileIndex(currentIndex);
                setActiveFocus('right');
              }
            }}
            onDoubleClick={() => {
              if (!isFolder) {
                handleFileClick(node, fullPath);
              }
            }}
          >
            {isFolder && (
              isExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />
            )}
            {isFolder ? <Folder className="w-3.5 h-3.5" style={{ color: theme.colors.accentText }} /> : getFileIcon(change?.type, theme)}
            <span className={change ? 'font-medium' : ''}>{node.name}</span>
            {change && (
              <span
                className="ml-auto text-[9px] px-1 rounded uppercase"
                style={{
                  backgroundColor: change.type === 'added' ? theme.colors.success + '20' : change.type === 'deleted' ? theme.colors.error + '20' : theme.colors.warning + '20',
                  color: change.type === 'added' ? theme.colors.success : change.type === 'deleted' ? theme.colors.error : theme.colors.warning
                }}
              >
                {change.type}
              </span>
            )}
          </div>
          {isFolder && isExpanded && node.children && renderTree(node.children, fullPath, depth + 1, globalIndex)}
        </div>
      );
    });
  };

  return (
    <div className="flex h-screen w-full font-mono overflow-hidden transition-colors duration-300 pt-10"
         style={{
           backgroundColor: theme.colors.bgMain,
           color: theme.colors.textMain,
           fontFamily: fontFamily,
           fontSize: `${fontSize}px`
         }}>

      {/* --- DRAGGABLE TITLE BAR --- */}
      <div
        className="fixed top-0 left-0 right-0 h-10"
        style={{
          WebkitAppRegion: 'drag',
        } as React.CSSProperties}
      />

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
          setActiveRightTab={setActiveRightTab}
        />
      )}
      {lightboxImage && (
        <LightboxModal
          image={lightboxImage}
          stagedImages={stagedImages}
          onClose={() => setLightboxImage(null)}
          onNavigate={(img) => setLightboxImage(img)}
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
          onClose={() => setAboutModalOpen(false)}
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

      {/* --- LEFT SIDEBAR --- */}
      <ErrorBoundary>
        <SessionList
          theme={theme}
          sessions={sessions}
          groups={groups}
          sortedSessions={sortedSessions}
          activeSessionId={activeSessionId}
          leftSidebarOpen={leftSidebarOpen}
          leftSidebarWidthState={leftSidebarWidthState}
          activeFocus={activeFocus}
          selectedSidebarIndex={selectedSidebarIndex}
          editingGroupId={editingGroupId}
          editingSessionId={editingSessionId}
          draggingSessionId={draggingSessionId}
          anyTunnelActive={anyTunnelActive}
          shortcuts={shortcuts}
          setActiveFocus={setActiveFocus}
          setActiveSessionId={setActiveSessionId}
          setLeftSidebarOpen={setLeftSidebarOpen}
          setLeftSidebarWidthState={setLeftSidebarWidthState}
          setShortcutsHelpOpen={setShortcutsHelpOpen}
          setSettingsModalOpen={setSettingsModalOpen}
          setSettingsTab={setSettingsTab}
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
          createNewGroup={createNewGroup}
          addNewSession={addNewSession}
        />
      </ErrorBoundary>

      {/* --- CENTER WORKSPACE --- */}
      <MainPanel
        logViewerOpen={logViewerOpen}
        activeSession={activeSession}
        theme={theme}
        activeFocus={activeFocus}
        outputSearchOpen={outputSearchOpen}
        outputSearchQuery={outputSearchQuery}
        inputValue={inputValue}
        enterToSend={enterToSend}
        stagedImages={stagedImages}
        commandHistoryOpen={commandHistoryOpen}
        commandHistoryFilter={commandHistoryFilter}
        commandHistorySelectedIndex={commandHistorySelectedIndex}
        slashCommandOpen={slashCommandOpen}
        slashCommands={slashCommands}
        selectedSlashCommandIndex={selectedSlashCommandIndex}
        previewFile={previewFile}
        markdownRawMode={markdownRawMode}
        shortcuts={shortcuts}
        rightPanelOpen={rightPanelOpen}
        setLogViewerOpen={setLogViewerOpen}
        setActiveFocus={setActiveFocus}
        setOutputSearchOpen={setOutputSearchOpen}
        setOutputSearchQuery={setOutputSearchQuery}
        setInputValue={setInputValue}
        setEnterToSend={setEnterToSend}
        setStagedImages={setStagedImages}
        setLightboxImage={setLightboxImage}
        setCommandHistoryOpen={setCommandHistoryOpen}
        setCommandHistoryFilter={setCommandHistoryFilter}
        setCommandHistorySelectedIndex={setCommandHistorySelectedIndex}
        setSlashCommandOpen={setSlashCommandOpen}
        setSelectedSlashCommandIndex={setSelectedSlashCommandIndex}
        setPreviewFile={setPreviewFile}
        setMarkdownRawMode={setMarkdownRawMode}
        setAboutModalOpen={setAboutModalOpen}
        setRightPanelOpen={setRightPanelOpen}
        inputRef={inputRef}
        logsEndRef={logsEndRef}
        fileTreeContainerRef={fileTreeContainerRef}
        toggleTunnel={toggleTunnel}
        toggleInputMode={toggleInputMode}
        processInput={processInput}
        handleInputKeyDown={handleInputKeyDown}
        handlePaste={handlePaste}
        handleDrop={handleDrop}
        getContextColor={getContextColor}
      />

      {/* --- RIGHT PANEL --- */}
      <ErrorBoundary>
        <RightPanel
          session={activeSession}
          theme={theme}
          shortcuts={shortcuts}
          rightPanelOpen={rightPanelOpen}
          setRightPanelOpen={setRightPanelOpen}
          rightPanelWidth={rightPanelWidthState}
          setRightPanelWidthState={setRightPanelWidthState}
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
          toggleFolder={toggleFolder}
          handleFileClick={handleFileClick}
          expandAllFolders={expandAllFolders}
          collapseAllFolders={collapseAllFolders}
          updateSessionWorkingDirectory={updateSessionWorkingDirectory}
          setSessions={setSessions}
          updateScratchPad={updateScratchPad}
          updateScratchPadState={updateScratchPadState}
        />
      </ErrorBoundary>

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
        setLlmProvider={setLlmProviderPersist}
        modelSlug={modelSlug}
        setModelSlug={setModelSlugPersist}
        apiKey={apiKey}
        setApiKey={setApiKeyPersist}
        tunnelProvider={tunnelProvider}
        setTunnelProvider={setTunnelProviderPersist}
        tunnelApiKey={tunnelApiKey}
        setTunnelApiKey={setTunnelApiKeyPersist}
        shortcuts={shortcuts}
        setShortcuts={setShortcuts}
        defaultAgent={defaultAgent}
        setDefaultAgent={setDefaultAgentPersist}
        fontFamily={fontFamily}
        setFontFamily={setFontFamily}
        fontSize={fontSize}
        setFontSize={setFontSize}
        terminalWidth={terminalWidth}
        setTerminalWidth={setTerminalWidth}
        logLevel={logLevel}
        setLogLevel={setLogLevel}
        initialTab={settingsTab}
      />
    </div>
  );
}

