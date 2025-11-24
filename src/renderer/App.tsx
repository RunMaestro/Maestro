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
import data from '@emoji-mart/data';
import Picker from '@emoji-mart/react';

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
import { getContextColor, getStatusColor } from './utils/theme';
import { fuzzyMatch } from './utils/search';

export default function MaestroConsole() {
  // --- STATE ---
  const [sessions, setSessions] = useState<Session[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);

  const [activeSessionId, setActiveSessionId] = useState<string>(sessions[0]?.id || 's1');
  
  // Input State
  const [inputValue, setInputValue] = useState('');
  const [enterToSend, setEnterToSendState] = useState(true);

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
  const [sessionFilter, setSessionFilter] = useState('');
  const [sessionFilterOpen, setSessionFilterOpen] = useState(false);

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
      const savedLeftSidebarWidth = await window.maestro.settings.get('leftSidebarWidth');
      const savedRightPanelWidth = await window.maestro.settings.get('rightPanelWidth');
      const savedMarkdownRawMode = await window.maestro.settings.get('markdownRawMode');
      const savedShortcuts = await window.maestro.settings.get('shortcuts');

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
      if (savedLeftSidebarWidth !== undefined) setLeftSidebarWidthState(savedLeftSidebarWidth);
      if (savedRightPanelWidth !== undefined) setRightPanelWidthState(savedRightPanelWidth);
      if (savedMarkdownRawMode !== undefined) setMarkdownRawModeState(savedMarkdownRawMode);

      // Merge saved shortcuts with defaults (in case new shortcuts were added)
      if (savedShortcuts !== undefined) {
        setShortcuts({ ...DEFAULT_SHORTCUTS, ...savedShortcuts });
      }
    };
    loadSettings();
  }, []);

  // Load sessions and groups from electron-store on mount (with localStorage migration)
  useEffect(() => {
    const loadSessionsAndGroups = async () => {
      try {
        // Try to load from electron-store first
        const savedSessions = await window.maestro.sessions.getAll();
        const savedGroups = await window.maestro.groups.getAll();

        // Handle sessions
        if (savedSessions && savedSessions.length > 0) {
          // electron-store has data, use it
          setSessions(savedSessions);
        } else {
          // Try to migrate from localStorage
          try {
            const localStorageSessions = localStorage.getItem('maestro_sessions');
            if (localStorageSessions) {
              const parsed = JSON.parse(localStorageSessions);
              setSessions(parsed);
              // Save to electron-store for future
              await window.maestro.sessions.setAll(parsed);
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

  // Persist sessions and groups to electron-store
  useEffect(() => {
    window.maestro.sessions.setAll(sessions);
  }, [sessions]);

  useEffect(() => {
    window.maestro.groups.setAll(groups);
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

  // --- HELPERS ---
  const getFileIcon = (type?: FileChangeType) => {
    switch (type) {
      case 'added': return <FilePlus className="w-3.5 h-3.5" style={{ color: theme.colors.success }} />;
      case 'deleted': return <Trash2 className="w-3.5 h-3.5" style={{ color: theme.colors.error }} />;
      case 'modified': return <FileCode className="w-3.5 h-3.5" style={{ color: theme.colors.warning }} />;
      default: return <FileText className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />;
    }
  };

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

      // Forward slash to open session filter when sidebar has focus
      if (e.key === '/' && activeFocus === 'sidebar') {
        e.preventDefault();
        setSessionFilterOpen(true);
      }

      // Escape key for non-modal elements (preview, lightbox, file tree filter, session filter)
      if (e.key === 'Escape' && !modalOpen) {
        setLightboxImage(null);
        setPreviewFile(null);
        setFileTreeFilterOpen(false);
        setFileTreeFilter('');
        setSessionFilterOpen(false);
        setSessionFilter('');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [shortcuts, activeFocus, activeRightTab, sessions, selectedSidebarIndex, activeSessionId, quickActionOpen, settingsModalOpen, shortcutsHelpOpen, newInstanceModalOpen, aboutModalOpen, activeSession, previewFile, fileTreeFilter, fileTreeFilterOpen, sessionFilter, sessionFilterOpen]);

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
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
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
      () => {
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

  const createNewSession = (agentId: string, workingDir: string, name: string) => {
    const newId = generateId();
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
      inputMode: agentId === 'cli' ? 'terminal' : 'ai',
      pid: Math.floor(Math.random() * 9000) + 1000,
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

    setTimeout(() => {
      setSessions(prev => prev.map(s => {
        if (s.id !== activeSessionId) return s;
        return {
          ...s,
          state: 'idle',
          [targetLogKey]: [...s[targetLogKey], { 
            id: generateId(), 
            timestamp: Date.now(), 
            source: 'stdout', 
            text: currentMode === 'ai' ? 'Received command. Processing...' : `Executed: ${inputValue}`
          }]
        };
      }));
    }, 1000);
  };

  const handleInputKeyDown = (e: React.KeyboardEvent) => {
    // Handle command history modal
    if (commandHistoryOpen) {
      return; // Let the modal handle keys
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

  // --- SUBCOMPONENTS ---

  const QuickActions = () => {
    const [search, setSearch] = useState('');
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [mode, setMode] = useState<'main' | 'move-to-group'>('main');
    const [renamingSession, setRenamingSession] = useState(false);
    const [renameValue, setRenameValue] = useState('');
    const [firstVisibleIndex, setFirstVisibleIndex] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const selectedItemRef = useRef<HTMLButtonElement>(null);
    const scrollContainerRef = useRef<HTMLDivElement>(null);

    useEffect(() => inputRef.current?.focus(), []);

    // Scroll selected item into view
    useEffect(() => {
      selectedItemRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }, [selectedIndex]);

    // Track scroll position to determine which items are visible
    const handleScroll = () => {
      if (scrollContainerRef.current) {
        const scrollTop = scrollContainerRef.current.scrollTop;
        const itemHeight = 52; // Approximate height of each item (py-3 = 12px top + 12px bottom + content)
        const visibleIndex = Math.floor(scrollTop / itemHeight);
        setFirstVisibleIndex(visibleIndex);
      }
    };

    const handleRenameSession = () => {
      if (renameValue.trim()) {
        const updatedSessions = sessions.map(s =>
          s.id === activeSessionId ? { ...s, name: renameValue.trim() } : s
        );
        setSessions(updatedSessions);
        setQuickActionOpen(false);
      }
    };

    const handleMoveToGroup = (groupId: string) => {
      const updatedSessions = sessions.map(s =>
        s.id === activeSessionId ? { ...s, groupId } : s
      );
      setSessions(updatedSessions);
      setQuickActionOpen(false);
    };

    const handleCreateGroup = () => {
      setNewGroupName('');
      setMoveSessionToNewGroup(true); // When creating from Command-K, move session to new group
      setCreateGroupModalOpen(true);
      setQuickActionOpen(false);
    };

    const sessionActions = sessions.map(s => ({
      id: `jump-${s.id}`,
      label: `Jump to: ${s.name}`,
      action: () => {
        setActiveSessionId(s.id);
        // Auto-expand group if it's collapsed
        if (s.groupId) {
          setGroups(prev => prev.map(g =>
            g.id === s.groupId && g.collapsed ? { ...g, collapsed: false } : g
          ));
        }
      },
      subtext: s.state.toUpperCase()
    }));

    const mainActions = [
      ...sessionActions,
      { id: 'new', label: 'New Agent', shortcut: shortcuts.newInstance, action: addNewSession },
      ...(activeSession ? [{ id: 'rename', label: 'Rename Current Agent', action: () => {
        setRenameInstanceValue(activeSession.name);
        setRenameInstanceModalOpen(true);
        setQuickActionOpen(false);
      } }] : []),
      ...(activeSession?.groupId ? [{
        id: 'renameGroup',
        label: 'Rename Group',
        action: () => {
          const group = groups.find(g => g.id === activeSession.groupId);
          if (group) {
            setRenameGroupId(group.id);
            setRenameGroupValue(group.name);
            setRenameGroupEmoji(group.emoji);
            setRenameGroupModalOpen(true);
            setQuickActionOpen(false);
          }
        }
      }] : []),
      ...(activeSession ? [{ id: 'moveToGroup', label: 'Move to Group...', action: () => { setMode('move-to-group'); setSelectedIndex(0); } }] : []),
      { id: 'createGroup', label: 'Create New Group', action: handleCreateGroup },
      { id: 'toggleSidebar', label: 'Toggle Sidebar', shortcut: shortcuts.toggleSidebar, action: () => setLeftSidebarOpen(p => !p) },
      { id: 'toggleRight', label: 'Toggle Right Panel', shortcut: shortcuts.toggleRightPanel, action: () => setRightPanelOpen(p => !p) },
      ...(activeSession ? [{ id: 'switchMode', label: 'Switch AI/Shell Mode', shortcut: shortcuts.toggleMode, action: toggleInputMode }] : []),
      ...(activeSession ? [{ id: 'kill', label: 'Kill Current Agent', shortcut: shortcuts.killInstance, action: () => deleteSession(activeSessionId) }] : []),
      { id: 'settings', label: 'Settings', action: () => { setSettingsModalOpen(true); setQuickActionOpen(false); } },
      { id: 'theme', label: 'Change Theme', action: () => { setSettingsModalOpen(true); setSettingsTab('theme'); setQuickActionOpen(false); } },
      { id: 'shortcuts', label: 'View Shortcuts', shortcut: shortcuts.help, action: () => { setShortcutsHelpOpen(true); setQuickActionOpen(false); } },
      { id: 'devtools', label: 'Toggle JavaScript Console', action: () => { window.maestro.devtools.toggle(); setQuickActionOpen(false); } },
      { id: 'about', label: 'About Maestro', action: () => { setAboutModalOpen(true); setQuickActionOpen(false); } },
      { id: 'goToFiles', label: 'Go to Files Tab', action: () => { setRightPanelOpen(true); setActiveRightTab('files'); setQuickActionOpen(false); } },
      { id: 'goToHistory', label: 'Go to History Tab', action: () => { setRightPanelOpen(true); setActiveRightTab('history'); setQuickActionOpen(false); } },
      { id: 'goToScratchpad', label: 'Go to Scratchpad Tab', action: () => { setRightPanelOpen(true); setActiveRightTab('scratchpad'); setQuickActionOpen(false); } },
    ];

    const groupActions = [
      { id: 'back', label: '← Back to main menu', action: () => { setMode('main'); setSelectedIndex(0); } },
      { id: 'no-group', label: '📁 No Group (Root)', action: () => handleMoveToGroup('') },
      ...groups.map(g => ({
        id: `group-${g.id}`,
        label: `${g.emoji} ${g.name}`,
        action: () => handleMoveToGroup(g.id)
      })),
      { id: 'create-new', label: '+ Create New Group', action: handleCreateGroup }
    ];

    const actions = mode === 'main' ? mainActions : groupActions;
    const filtered = actions.filter(a => a.label.toLowerCase().includes(search.toLowerCase()));

    useEffect(() => {
      setSelectedIndex(0);
      setFirstVisibleIndex(0);
    }, [search, mode]);

    const handleKeyDown = (e: React.KeyboardEvent) => {
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

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex(prev => Math.min(prev + 1, filtered.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex(prev => Math.max(prev - 1, 0));
      } else if (e.key === 'Enter') {
        if (filtered[selectedIndex]) {
          filtered[selectedIndex].action();
          if (!renamingSession && mode === 'main') {
            setQuickActionOpen(false);
          }
        }
      } else if (e.key === 'Escape' && mode === 'move-to-group') {
        e.preventDefault();
        setMode('main');
        setSelectedIndex(0);
      } else if (e.metaKey && ['1', '2', '3', '4', '5', '6', '7', '8'].includes(e.key)) {
        e.preventDefault();
        const number = parseInt(e.key);
        const targetIndex = firstVisibleIndex + number - 1;
        if (filtered[targetIndex]) {
          filtered[targetIndex].action();
          if (!renamingSession && mode === 'main') {
            setQuickActionOpen(false);
          }
        }
      }
    };

    return (
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm flex items-start justify-center pt-32 z-50 animate-in fade-in duration-100">
        <div className="w-[500px] rounded-xl shadow-2xl border overflow-hidden flex flex-col max-h-[550px]"
             style={{ backgroundColor: theme.colors.bgActivity, borderColor: theme.colors.border }}>
          <div className="p-4 border-b flex items-center gap-3" style={{ borderColor: theme.colors.border }}>
            <Search className="w-5 h-5" style={{ color: theme.colors.textDim }} />
            {renamingSession ? (
              <input
                ref={inputRef}
                className="flex-1 bg-transparent outline-none text-lg"
                placeholder="Enter new name..."
                style={{ color: theme.colors.textMain }}
                value={renameValue}
                onChange={e => setRenameValue(e.target.value)}
                onKeyDown={handleKeyDown}
                autoFocus
              />
            ) : (
              <input
                ref={inputRef}
                className="flex-1 bg-transparent outline-none text-lg placeholder-opacity-50"
                placeholder="Type a command or jump to agent..."
                style={{ color: theme.colors.textMain }}
                value={search}
                onChange={e => setSearch(e.target.value)}
                onKeyDown={handleKeyDown}
              />
            )}
            <div className="px-2 py-0.5 rounded text-xs font-bold" style={{ backgroundColor: theme.colors.bgMain, color: theme.colors.textDim }}>ESC</div>
          </div>
          {!renamingSession && (
            <div className="overflow-y-auto py-2" ref={scrollContainerRef} onScroll={handleScroll}>
              {filtered.map((a, i) => {
                // Calculate dynamic number badge (1-8) based on first visible item
                const distanceFromFirstVisible = i - firstVisibleIndex;
                const showNumber = distanceFromFirstVisible >= 0 && distanceFromFirstVisible < 8;
                const numberBadge = distanceFromFirstVisible + 1;

                return (
                  <button
                    key={a.id}
                    ref={i === selectedIndex ? selectedItemRef : null}
                    onClick={() => { a.action(); if (mode === 'main') setQuickActionOpen(false); }}
                    className={`w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-opacity-10 ${i === selectedIndex ? 'bg-opacity-10' : ''}`}
                    style={{
                      backgroundColor: i === selectedIndex ? theme.colors.accent : 'transparent',
                      color: theme.colors.textMain
                    }}
                  >
                    {showNumber ? (
                      <div
                        className="flex-shrink-0 w-5 h-5 rounded flex items-center justify-center text-xs font-bold"
                        style={{ backgroundColor: theme.colors.bgMain, color: theme.colors.textDim }}
                      >
                        {numberBadge}
                      </div>
                    ) : (
                      <div className="flex-shrink-0 w-5 h-5" />
                    )}
                    <div className="flex flex-col flex-1">
                      <span className="font-medium">{a.label}</span>
                      {/* @ts-ignore */}
                      {a.subtext && <span className="text-[10px] opacity-50">{a.subtext}</span>}
                    </div>
                    {/* @ts-ignore */}
                    {a.shortcut && (
                      <span className="text-xs font-mono opacity-60">
                        {/* @ts-ignore */}
                        {a.shortcut.keys.join('+')}
                      </span>
                    )}
                  </button>
                );
              })}
              {filtered.length === 0 && (
                <div className="px-4 py-4 text-center opacity-50 text-sm">No actions found</div>
              )}
            </div>
          )}
        </div>
      </div>
    );
  };

  const ShortcutEditor = () => {
    const [recordingId, setRecordingId] = useState<string | null>(null);

    const handleRecord = (e: React.KeyboardEvent, actionId: string) => {
      e.preventDefault();
      e.stopPropagation();
      const keys = [];
      if (e.metaKey) keys.push('Meta');
      if (e.ctrlKey) keys.push('Ctrl');
      if (e.altKey) keys.push('Alt');
      if (e.shiftKey) keys.push('Shift');
      if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return;
      keys.push(e.key);
      setShortcuts(prev => ({
        ...prev,
        [actionId]: { ...prev[actionId], keys }
      }));
      setRecordingId(null);
    };

    return (
      <div className="space-y-2 max-h-[400px] overflow-y-auto pr-2">
        {Object.values(shortcuts).map(sc => (
          <div key={sc.id} className="flex items-center justify-between p-3 rounded border" style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}>
            <span className="text-sm font-medium" style={{ color: theme.colors.textMain }}>{sc.label}</span>
            <button 
              onClick={() => setRecordingId(sc.id)}
              onKeyDown={(e) => recordingId === sc.id && handleRecord(e, sc.id)}
              className={`px-3 py-1.5 rounded border text-xs font-mono min-w-[80px] text-center transition-colors ${recordingId === sc.id ? 'ring-2' : ''}`}
              style={{ 
                borderColor: recordingId === sc.id ? theme.colors.accent : theme.colors.border,
                backgroundColor: recordingId === sc.id ? theme.colors.accentDim : theme.colors.bgActivity,
                color: recordingId === sc.id ? theme.colors.accent : theme.colors.textDim,
                ringColor: theme.colors.accent
              }}
            >
              {recordingId === sc.id ? 'Press keys...' : sc.keys.join(' + ')}
            </button>
          </div>
        ))}
      </div>
    );
  };

  const ThemePicker = () => {
    const grouped = Object.values(THEMES).reduce((acc, t) => {
      if (!acc[t.mode]) acc[t.mode] = [];
      acc[t.mode].push(t);
      return acc;
    }, {} as Record<string, Theme[]>);

    return (
      <div className="space-y-6">
        {['dark', 'light'].map(mode => (
          <div key={mode}>
            <div className="text-xs font-bold uppercase mb-3 flex items-center gap-2" style={{ color: theme.colors.textDim }}>
              {mode === 'dark' ? <Moon className="w-3 h-3" /> : <Sun className="w-3 h-3" />}
              {mode} Mode
            </div>
            <div className="grid grid-cols-2 gap-3">
              {grouped[mode]?.map(t => (
                 <button
                   key={t.id}
                   onClick={() => setActiveThemeId(t.id)}
                   className={`p-3 rounded-lg border text-left transition-all ${activeThemeId === t.id ? 'ring-2' : ''}`}
                   style={{ 
                     borderColor: theme.colors.border,
                     backgroundColor: t.colors.bgSidebar,
                     ringColor: theme.colors.accent
                   }}
                 >
                    <div className="flex justify-between items-center mb-2">
                      <span className="text-sm font-bold" style={{ color: t.colors.textMain }}>{t.name}</span>
                      {activeThemeId === t.id && <div className="w-2 h-2 rounded-full" style={{ backgroundColor: theme.colors.accent }} />}
                    </div>
                    <div className="flex h-3 rounded overflow-hidden">
                      <div className="flex-1" style={{ backgroundColor: t.colors.bgMain }} />
                      <div className="flex-1" style={{ backgroundColor: t.colors.bgActivity }} />
                      <div className="flex-1" style={{ backgroundColor: t.colors.accent }} />
                    </div>
                 </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  };

  // --- RENDER ---
  const activeLogs = activeSession ? (activeSession.inputMode === 'ai' ? activeSession.aiLogs : activeSession.shellLogs) : [];

  // Recursive File Tree Renderer
  // Check if file should be opened in external app
  const shouldOpenExternally = (filename: string): boolean => {
    const ext = filename.split('.').pop()?.toLowerCase();
    // File types that should open in default system app
    const externalExtensions = [
      'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', // Documents
      'zip', 'tar', 'gz', 'rar', '7z', // Archives
      'exe', 'dmg', 'app', 'deb', 'rpm', // Executables/Installers
      'mp4', 'avi', 'mov', 'mkv', 'mp3', 'wav', 'flac', // Media files
    ];
    return externalExtensions.includes(ext || '');
  };

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

  // Load file tree from directory
  const loadFileTree = async (dirPath: string, maxDepth = 3, currentDepth = 0): Promise<any[]> => {
    if (currentDepth >= maxDepth) return [];

    try {
      const entries = await window.maestro.fs.readDir(dirPath);
      const tree: any[] = [];

      for (const entry of entries) {
        // Skip hidden files and common ignore patterns
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '__pycache__') {
          continue;
        }

        if (entry.isDirectory) {
          const children = await loadFileTree(`${dirPath}/${entry.name}`, maxDepth, currentDepth + 1);
          tree.push({
            name: entry.name,
            type: 'folder',
            children
          });
        } else if (entry.isFile) {
          tree.push({
            name: entry.name,
            type: 'file'
          });
        }
      }

      return tree.sort((a, b) => {
        // Folders first, then alphabetically
        if (a.type === 'folder' && b.type !== 'folder') return -1;
        if (a.type !== 'folder' && b.type === 'folder') return 1;
        return a.name.localeCompare(b.name);
      });
    } catch (error) {
      console.error('Error loading file tree:', error);
      throw error; // Propagate error to be caught in useEffect
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

  const toggleFolder = (path: string) => {
    setSessions(prev => prev.map(s => {
      if (s.id !== activeSessionId) return s;
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
  const expandAllFolders = () => {
    const getAllFolderPaths = (nodes: any[], currentPath = ''): string[] => {
      let paths: string[] = [];
      nodes.forEach((node) => {
        if (node.type === 'folder') {
          const fullPath = currentPath ? `${currentPath}/${node.name}` : node.name;
          paths.push(fullPath);
          if (node.children) {
            paths = paths.concat(getAllFolderPaths(node.children, fullPath));
          }
        }
      });
      return paths;
    };

    setSessions(prev => prev.map(s => {
      if (s.id !== activeSessionId) return s;
      if (!s.fileTree) return s;
      const allFolderPaths = getAllFolderPaths(s.fileTree);
      return { ...s, fileExplorerExpanded: allFolderPaths };
    }));
  };

  // Collapse all folders in file tree
  const collapseAllFolders = () => {
    setSessions(prev => prev.map(s => {
      if (s.id !== activeSessionId) return s;
      return { ...s, fileExplorerExpanded: [] };
    }));
  };

  // Flatten file tree for keyboard navigation
  const flattenTree = (nodes: any[], expandedSet: Set<string>, currentPath = ''): any[] => {
    let result: any[] = [];
    nodes.forEach((node) => {
      const fullPath = currentPath ? `${currentPath}/${node.name}` : node.name;
      const isFolder = node.type === 'folder';
      result.push({ ...node, fullPath, isFolder });

      if (isFolder && expandedSet.has(fullPath) && node.children) {
        result = result.concat(flattenTree(node.children, expandedSet, fullPath));
      }
    });
    return result;
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

  // Update flat file list when active session's tree or expanded folders change
  useEffect(() => {
    if (!activeSession || !activeSession.fileTree || !activeSession.fileExplorerExpanded) {
      setFlatFileList([]);
      return;
    }
    const expandedSet = new Set(activeSession.fileExplorerExpanded);
    setFlatFileList(flattenTree(activeSession.fileTree, expandedSet));
  }, [activeSession?.fileTree, activeSession?.fileExplorerExpanded]);

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

  // Filter sessions based on search query
  const filteredSessions = useMemo(() => {
    if (!sessionFilter) {
      return sessions;
    }
    return sessions.filter(session => fuzzyMatch(session.name, sessionFilter));
  }, [sessions, sessionFilter]);

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
          toggleFolder(selectedItem.fullPath);
        }
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        const selectedItem = flatFileList[selectedFileIndex];
        if (selectedItem?.isFolder && !expandedFolders.has(selectedItem.fullPath)) {
          toggleFolder(selectedItem.fullPath);
        }
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const selectedItem = flatFileList[selectedFileIndex];
        if (selectedItem) {
          if (selectedItem.isFolder) {
            toggleFolder(selectedItem.fullPath);
          } else {
            handleFileClick(selectedItem, selectedItem.fullPath);
          }
        }
      }
    };

    window.addEventListener('keydown', handleFileExplorerKeys);
    return () => window.removeEventListener('keydown', handleFileExplorerKeys);
  }, [activeFocus, activeRightTab, flatFileList, selectedFileIndex, activeSession?.fileExplorerExpanded, toggleFolder, handleFileClick]);

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
                toggleFolder(fullPath);
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
            {isFolder ? <Folder className="w-3.5 h-3.5" style={{ color: theme.colors.accentText }} /> : getFileIcon(change?.type)}
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
      {quickActionOpen && <QuickActions />}
      {lightboxImage && (() => {
        const currentIndex = stagedImages.indexOf(lightboxImage);
        const canNavigate = stagedImages.length > 1;
        const lightboxRef = useRef<HTMLDivElement>(null);

        useEffect(() => {
          // Focus the lightbox when it opens
          lightboxRef.current?.focus();
        }, []);

        const goToPrev = () => {
          if (canNavigate && currentIndex > 0) {
            setLightboxImage(stagedImages[currentIndex - 1]);
          }
        };
        const goToNext = () => {
          if (canNavigate && currentIndex < stagedImages.length - 1) {
            setLightboxImage(stagedImages[currentIndex + 1]);
          }
        };

        return (
          <div
            ref={lightboxRef}
            className="absolute inset-0 z-[100] bg-black/90 flex items-center justify-center"
            onClick={() => setLightboxImage(null)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'ArrowLeft') { e.preventDefault(); goToPrev(); }
              else if (e.key === 'ArrowRight') { e.preventDefault(); goToNext(); }
              else if (e.key === 'Escape') { e.preventDefault(); setLightboxImage(null); }
            }}
            tabIndex={0}
          >
            {canNavigate && currentIndex > 0 && (
              <button
                onClick={(e) => { e.stopPropagation(); goToPrev(); }}
                className="absolute left-4 top-1/2 -translate-y-1/2 bg-white/10 hover:bg-white/20 text-white rounded-full p-3 backdrop-blur-sm transition-colors"
              >
                ←
              </button>
            )}
            <img src={lightboxImage} className="max-w-[90%] max-h-[90%] rounded shadow-2xl" onClick={(e) => e.stopPropagation()} />
            {canNavigate && currentIndex < stagedImages.length - 1 && (
              <button
                onClick={(e) => { e.stopPropagation(); goToNext(); }}
                className="absolute right-4 top-1/2 -translate-y-1/2 bg-white/10 hover:bg-white/20 text-white rounded-full p-3 backdrop-blur-sm transition-colors"
              >
                →
              </button>
            )}
            <div className="absolute bottom-10 text-white text-sm opacity-70">
              {canNavigate ? `Image ${currentIndex + 1} of ${stagedImages.length} • ← → to navigate • ` : ''}ESC to close
            </div>
          </div>
        );
      })()}

      {/* --- SHORTCUTS HELP MODAL --- */}
      {shortcutsHelpOpen && (
        <div className="absolute inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 animate-in fade-in duration-200">
          <div className="w-[400px] border rounded-lg shadow-2xl overflow-hidden" style={{ backgroundColor: theme.colors.bgSidebar, borderColor: theme.colors.border }}>
            <div className="p-4 border-b" style={{ borderColor: theme.colors.border }}>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-bold" style={{ color: theme.colors.textMain }}>Keyboard Shortcuts</h2>
                <button onClick={() => setShortcutsHelpOpen(false)} style={{ color: theme.colors.textDim }}>
                  <X className="w-4 h-4" />
                </button>
              </div>
              <input
                type="text"
                value={shortcutsSearchQuery}
                onChange={(e) => setShortcutsSearchQuery(e.target.value)}
                placeholder="Search shortcuts..."
                className="w-full px-3 py-2 rounded border bg-transparent outline-none text-sm"
                style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
                autoFocus
              />
            </div>
            <div className="p-4 space-y-2 max-h-[400px] overflow-y-auto">
               {Object.values(shortcuts).filter(sc =>
                 fuzzyMatch(sc.label, shortcutsSearchQuery) ||
                 fuzzyMatch(sc.keys.join(' '), shortcutsSearchQuery)
               ).map((sc, i) => (
                 <div key={i} className="flex justify-between items-center text-sm">
                    <span style={{ color: theme.colors.textDim }}>{sc.label}</span>
                    <kbd className="px-2 py-1 rounded border font-mono text-xs font-bold" style={{ backgroundColor: theme.colors.bgActivity, borderColor: theme.colors.border, color: theme.colors.textMain }}>
                      {sc.keys.join(' ')}
                    </kbd>
                 </div>
               ))}
               {Object.values(shortcuts).filter(sc =>
                 fuzzyMatch(sc.label, shortcutsSearchQuery) ||
                 fuzzyMatch(sc.keys.join(' '), shortcutsSearchQuery)
               ).length === 0 && (
                 <div className="text-center text-sm opacity-50" style={{ color: theme.colors.textDim }}>
                   No shortcuts found
                 </div>
               )}
            </div>
          </div>
        </div>
      )}

      {/* --- ABOUT MODAL --- */}
      {aboutModalOpen && (
        <div className="absolute inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 animate-in fade-in duration-200">
          <div className="w-[450px] border rounded-lg shadow-2xl overflow-hidden" style={{ backgroundColor: theme.colors.bgSidebar, borderColor: theme.colors.border }}>
            <div className="p-4 border-b flex items-center justify-between" style={{ borderColor: theme.colors.border }}>
              <h2 className="text-sm font-bold" style={{ color: theme.colors.textMain }}>About Maestro</h2>
              <button onClick={() => setAboutModalOpen(false)} style={{ color: theme.colors.textDim }}>
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-6 space-y-5">
              {/* Logo and Title */}
              <div className="flex items-center gap-4">
                <Wand2 className="w-12 h-12" style={{ color: theme.colors.accent }} />
                <div>
                  <h1 className="text-2xl font-bold tracking-widest" style={{ color: theme.colors.textMain }}>MAESTRO</h1>
                  <p className="text-xs opacity-70" style={{ color: theme.colors.textDim }}>Agent Orchestration Command Center</p>
                </div>
              </div>

              {/* Author Section */}
              <div className="flex items-center gap-4 p-4 rounded border" style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgActivity }}>
                <img
                  src="https://avatars.githubusercontent.com/u/1253573?v=4"
                  alt="Pedram Amini"
                  className="w-16 h-16 rounded-full border-2"
                  style={{ borderColor: theme.colors.accent }}
                />
                <div className="flex-1">
                  <div className="text-sm font-bold" style={{ color: theme.colors.textMain }}>Pedram Amini</div>
                  <div className="text-xs opacity-70 mb-2" style={{ color: theme.colors.textDim }}>Founder, Hacker, Investor, Advisor</div>
                  <div className="flex flex-col gap-1">
                    <button
                      onClick={() => window.maestro.shell.openExternal('https://github.com/pedramamini')}
                      className="inline-flex items-center gap-1 text-xs hover:underline cursor-pointer text-left"
                      style={{ color: theme.colors.accent, background: 'none', border: 'none', padding: 0 }}
                    >
                      <ExternalLink className="w-3 h-3" />
                      GitHub Profile
                    </button>
                    <button
                      onClick={() => window.maestro.shell.openExternal('https://www.linkedin.com/in/pedramamini/')}
                      className="inline-flex items-center gap-1 text-xs hover:underline cursor-pointer text-left"
                      style={{ color: theme.colors.accent, background: 'none', border: 'none', padding: 0 }}
                    >
                      <ExternalLink className="w-3 h-3" />
                      LinkedIn Profile
                    </button>
                  </div>
                </div>
              </div>

              {/* Project Link */}
              <div className="pt-2 border-t" style={{ borderColor: theme.colors.border }}>
                <button
                  onClick={() => window.maestro.shell.openExternal('https://github.com/pedramamini/Maestro')}
                  className="w-full flex items-center justify-between p-3 rounded border hover:bg-white/5 transition-colors"
                  style={{ borderColor: theme.colors.border }}
                >
                  <div className="flex items-center gap-2">
                    <FileCode className="w-4 h-4" style={{ color: theme.colors.accent }} />
                    <span className="text-sm font-medium" style={{ color: theme.colors.textMain }}>View on GitHub</span>
                  </div>
                  <ExternalLink className="w-4 h-4" style={{ color: theme.colors.textDim }} />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* --- CREATE GROUP MODAL --- */}
      {createGroupModalOpen && (
        <div
          className="absolute inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 animate-in fade-in duration-200"
          onKeyDown={(e) => {
            if (e.key !== 'Escape') {
              e.stopPropagation();
            }
          }}
        >
          <div className="w-[400px] border rounded-lg shadow-2xl overflow-hidden" style={{ backgroundColor: theme.colors.bgSidebar, borderColor: theme.colors.border }}>
            <div className="p-4 border-b flex items-center justify-between" style={{ borderColor: theme.colors.border }}>
              <h2 className="text-sm font-bold" style={{ color: theme.colors.textMain }}>Create New Group</h2>
              <button onClick={() => setCreateGroupModalOpen(false)} style={{ color: theme.colors.textDim }}>
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-6">
              <div className="flex gap-4 items-end">
                {/* Emoji Selector - Left Side */}
                <div className="flex flex-col gap-2">
                  <label className="block text-xs font-bold opacity-70 uppercase" style={{ color: theme.colors.textMain }}>
                    Icon
                  </label>
                  <button
                    onClick={() => setEmojiPickerOpen(!emojiPickerOpen)}
                    className="p-3 rounded border bg-transparent text-3xl hover:bg-white/5 transition-colors w-16 h-[52px] flex items-center justify-center"
                    style={{ borderColor: theme.colors.border }}
                    type="button"
                  >
                    {newGroupEmoji}
                  </button>
                </div>

                {/* Group Name Input - Right Side */}
                <div className="flex-1 flex flex-col gap-2">
                  <label className="block text-xs font-bold opacity-70 uppercase" style={{ color: theme.colors.textMain }}>
                    Group Name
                  </label>
                  <input
                    type="text"
                    value={newGroupName}
                    onChange={(e) => setNewGroupName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleCreateGroupConfirm();
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        setCreateGroupModalOpen(false);
                      }
                    }}
                    placeholder="Enter group name..."
                    className="w-full p-3 rounded border bg-transparent outline-none h-[52px]"
                    style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
                    autoFocus={!emojiPickerOpen}
                  />
                </div>
              </div>

              {/* Emoji Picker Overlay */}
              {emojiPickerOpen && (
                <div
                  className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-[60]"
                  onClick={() => setEmojiPickerOpen(false)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      e.stopPropagation();
                      setEmojiPickerOpen(false);
                    }
                  }}
                  tabIndex={0}
                  ref={(el) => el?.focus()}
                >
                  <div
                    className="rounded-lg border-2 shadow-2xl overflow-visible relative"
                    style={{ borderColor: theme.colors.accent, backgroundColor: theme.colors.bgSidebar }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {/* Close button */}
                    <button
                      onClick={() => setEmojiPickerOpen(false)}
                      className="absolute -top-3 -right-3 z-10 p-2 rounded-full shadow-lg hover:scale-110 transition-transform"
                      style={{ backgroundColor: theme.colors.bgSidebar, color: theme.colors.textMain, border: `2px solid ${theme.colors.border}` }}
                    >
                      <X className="w-4 h-4" />
                    </button>
                    <Picker
                      data={data}
                      onEmojiSelect={(emoji: any) => {
                        setNewGroupEmoji(emoji.native);
                        setEmojiPickerOpen(false);
                      }}
                      theme={theme.mode}
                      previewPosition="none"
                      searchPosition="sticky"
                      perLine={9}
                      set="native"
                      autoFocus
                    />
                  </div>
                </div>
              )}
              <div className="mt-4 flex justify-end gap-2">
                <button
                  onClick={() => setCreateGroupModalOpen(false)}
                  className="px-4 py-2 rounded border hover:bg-white/5 transition-colors"
                  style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
                >
                  Cancel
                </button>
                <button
                  onClick={handleCreateGroupConfirm}
                  disabled={!newGroupName.trim()}
                  className="px-4 py-2 rounded text-white disabled:opacity-50 disabled:cursor-not-allowed"
                  style={{ backgroundColor: theme.colors.accent }}
                >
                  Create
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* --- CONFIRMATION MODAL --- */}
      {confirmModalOpen && (
        <div
          className="absolute inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 animate-in fade-in duration-200"
          tabIndex={0}
          ref={(el) => el?.focus()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.stopPropagation();
              if (confirmModalOnConfirm) {
                confirmModalOnConfirm();
              }
              setConfirmModalOpen(false);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              setConfirmModalOpen(false);
            } else {
              e.stopPropagation();
            }
          }}
        >
          <div className="w-[450px] border rounded-lg shadow-2xl overflow-hidden" style={{ backgroundColor: theme.colors.bgSidebar, borderColor: theme.colors.border }}>
            <div className="p-4 border-b flex items-center justify-between" style={{ borderColor: theme.colors.border }}>
              <h2 className="text-sm font-bold" style={{ color: theme.colors.textMain }}>Confirm Action</h2>
              <button onClick={() => setConfirmModalOpen(false)} style={{ color: theme.colors.textDim }}>
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-6">
              <p className="text-sm leading-relaxed" style={{ color: theme.colors.textMain }}>
                {confirmModalMessage}
              </p>
              <div className="mt-6 flex justify-end gap-2">
                <button
                  onClick={() => setConfirmModalOpen(false)}
                  className="px-4 py-2 rounded border hover:bg-white/5 transition-colors"
                  style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    if (confirmModalOnConfirm) {
                      confirmModalOnConfirm();
                    }
                    setConfirmModalOpen(false);
                  }}
                  className="px-4 py-2 rounded text-white"
                  style={{ backgroundColor: theme.colors.error }}
                >
                  Confirm
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* --- RENAME INSTANCE MODAL --- */}
      {renameInstanceModalOpen && (
        <div
          className="absolute inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 animate-in fade-in duration-200"
          onKeyDown={(e) => {
            if (e.key !== 'Escape') {
              e.stopPropagation();
            }
          }}
        >
          <div className="w-[400px] border rounded-lg shadow-2xl overflow-hidden" style={{ backgroundColor: theme.colors.bgSidebar, borderColor: theme.colors.border }}>
            <div className="p-4 border-b flex items-center justify-between" style={{ borderColor: theme.colors.border }}>
              <h2 className="text-sm font-bold" style={{ color: theme.colors.textMain }}>Rename Instance</h2>
              <button onClick={() => setRenameInstanceModalOpen(false)} style={{ color: theme.colors.textDim }}>
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-6">
              <input
                type="text"
                value={renameInstanceValue}
                onChange={(e) => setRenameInstanceValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    if (renameInstanceValue.trim()) {
                      setSessions(prev => prev.map(s =>
                        s.id === activeSessionId ? { ...s, name: renameInstanceValue.trim() } : s
                      ));
                      setRenameInstanceModalOpen(false);
                    }
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    setRenameInstanceModalOpen(false);
                  }
                }}
                placeholder="Enter agent name..."
                className="w-full p-3 rounded border bg-transparent outline-none"
                style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
                autoFocus
              />
              <div className="mt-4 flex justify-end gap-2">
                <button
                  onClick={() => setRenameInstanceModalOpen(false)}
                  className="px-4 py-2 rounded border hover:bg-white/5 transition-colors"
                  style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    if (renameInstanceValue.trim()) {
                      setSessions(prev => prev.map(s =>
                        s.id === activeSessionId ? { ...s, name: renameInstanceValue.trim() } : s
                      ));
                      setRenameInstanceModalOpen(false);
                    }
                  }}
                  disabled={!renameInstanceValue.trim()}
                  className="px-4 py-2 rounded text-white disabled:opacity-50 disabled:cursor-not-allowed"
                  style={{ backgroundColor: theme.colors.accent }}
                >
                  Rename
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* --- RENAME GROUP MODAL --- */}
      {renameGroupModalOpen && (
        <div
          className="absolute inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 animate-in fade-in duration-200"
          onKeyDown={(e) => {
            if (e.key !== 'Escape') {
              e.stopPropagation();
            }
          }}
        >
          <div className="w-[400px] border rounded-lg shadow-2xl overflow-hidden" style={{ backgroundColor: theme.colors.bgSidebar, borderColor: theme.colors.border }}>
            <div className="p-4 border-b flex items-center justify-between" style={{ borderColor: theme.colors.border }}>
              <h2 className="text-sm font-bold" style={{ color: theme.colors.textMain }}>Rename Group</h2>
              <button onClick={() => setRenameGroupModalOpen(false)} style={{ color: theme.colors.textDim }}>
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-6">
              <div className="flex gap-4 items-end">
                {/* Emoji Selector - Left Side */}
                <div className="flex flex-col gap-2">
                  <label className="block text-xs font-bold opacity-70 uppercase" style={{ color: theme.colors.textMain }}>
                    Icon
                  </label>
                  <button
                    onClick={() => setRenameGroupEmojiPickerOpen(!renameGroupEmojiPickerOpen)}
                    className="p-3 rounded border bg-transparent text-3xl hover:bg-white/5 transition-colors w-16 h-[52px] flex items-center justify-center"
                    style={{ borderColor: theme.colors.border }}
                    type="button"
                  >
                    {renameGroupEmoji}
                  </button>
                </div>

                {/* Group Name Input - Right Side */}
                <div className="flex-1 flex flex-col gap-2">
                  <label className="block text-xs font-bold opacity-70 uppercase" style={{ color: theme.colors.textMain }}>
                    Group Name
                  </label>
                  <input
                    type="text"
                    value={renameGroupValue}
                    onChange={(e) => setRenameGroupValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        if (renameGroupValue.trim() && renameGroupId) {
                          setGroups(prev => prev.map(g =>
                            g.id === renameGroupId ? { ...g, name: renameGroupValue.trim().toUpperCase(), emoji: renameGroupEmoji } : g
                          ));
                          setRenameGroupModalOpen(false);
                          setRenameGroupEmojiPickerOpen(false);
                        }
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        setRenameGroupModalOpen(false);
                      }
                    }}
                    placeholder="Enter group name..."
                    className="w-full p-3 rounded border bg-transparent outline-none h-[52px]"
                    style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
                    autoFocus={!renameGroupEmojiPickerOpen}
                  />
                </div>
              </div>

              {/* Emoji Picker Overlay */}
              {renameGroupEmojiPickerOpen && (
                <div
                  className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-[60]"
                  onClick={() => setRenameGroupEmojiPickerOpen(false)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      e.stopPropagation();
                      setRenameGroupEmojiPickerOpen(false);
                    }
                  }}
                  tabIndex={0}
                  ref={(el) => el?.focus()}
                >
                  <div
                    className="rounded-lg border-2 shadow-2xl overflow-visible relative"
                    style={{ borderColor: theme.colors.accent, backgroundColor: theme.colors.bgSidebar }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {/* Close button */}
                    <button
                      onClick={() => setRenameGroupEmojiPickerOpen(false)}
                      className="absolute -top-3 -right-3 z-10 p-2 rounded-full shadow-lg hover:scale-110 transition-transform"
                      style={{ backgroundColor: theme.colors.bgSidebar, color: theme.colors.textMain, border: `2px solid ${theme.colors.border}` }}
                    >
                      <X className="w-4 h-4" />
                    </button>
                    <Picker
                      data={data}
                      onEmojiSelect={(emoji: any) => {
                        setRenameGroupEmoji(emoji.native);
                        setRenameGroupEmojiPickerOpen(false);
                      }}
                      theme={theme.mode}
                      previewPosition="none"
                      searchPosition="sticky"
                      perLine={9}
                      set="native"
                      autoFocus
                    />
                  </div>
                </div>
              )}
              <div className="mt-4 flex justify-end gap-2">
                <button
                  onClick={() => setRenameGroupModalOpen(false)}
                  className="px-4 py-2 rounded border hover:bg-white/5 transition-colors"
                  style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    if (renameGroupValue.trim() && renameGroupId) {
                      setGroups(prev => prev.map(g =>
                        g.id === renameGroupId ? { ...g, name: renameGroupValue.trim().toUpperCase(), emoji: renameGroupEmoji } : g
                      ));
                      setRenameGroupModalOpen(false);
                      setRenameGroupEmojiPickerOpen(false);
                    }
                  }}
                  disabled={!renameGroupValue.trim()}
                  className="px-4 py-2 rounded text-white disabled:opacity-50 disabled:cursor-not-allowed"
                  style={{ backgroundColor: theme.colors.accent }}
                >
                  Rename
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* --- LEFT SIDEBAR --- */}
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

      {/* --- CENTER WORKSPACE --- */}
      {!activeSession ? (
        <>
          <div
            className="flex-1 flex flex-col items-center justify-center min-w-0 relative opacity-30"
            style={{ backgroundColor: theme.colors.bgMain }}
          >
            <Wand2 className="w-16 h-16 mb-4" style={{ color: theme.colors.textDim }} />
            <p className="text-sm" style={{ color: theme.colors.textDim }}>No agents. Create one to get started.</p>
          </div>
          <div
            className="w-96 border-l opacity-30"
            style={{ backgroundColor: theme.colors.bgSidebar, borderColor: theme.colors.border }}
          />
        </>
      ) : (
        <>
          <div
            className={`flex-1 flex flex-col min-w-0 relative ${activeFocus === 'main' ? 'ring-1 ring-inset z-10' : ''}`}
            style={{ backgroundColor: theme.colors.bgMain, ringColor: theme.colors.accent }}
            onClick={() => setActiveFocus('main')}
          >
            {/* Top Bar */}
            <div className="h-16 border-b flex items-center justify-between px-6 shrink-0" style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }}>
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-2 text-sm font-medium">
                  {(activeSession.inputMode === 'terminal' ? (activeSession.shellCwd || activeSession.cwd) : activeSession.cwd).split('/').pop() || '/'} /
                <span className={`text-xs px-2 py-0.5 rounded-full border ${activeSession.isGitRepo ? 'border-orange-500/30 text-orange-500 bg-orange-500/10' : 'border-blue-500/30 text-blue-500 bg-blue-500/10'}`}>
                  {activeSession.isGitRepo ? 'GIT' : 'LOCAL'}
                </span>
              </div>
              
              <div className="relative group">
                 <button 
                   onClick={() => toggleTunnel(activeSessionId)}
                   className={`flex items-center gap-2 px-2 py-1 rounded text-xs transition-colors ${activeSession.tunnelActive ? 'bg-green-500/20 text-green-500' : 'text-gray-500 hover:bg-gray-800'}`}
                 >
                   <Radio className={`w-3 h-3 ${activeSession.tunnelActive ? 'animate-pulse' : ''}`} />
                   {activeSession.tunnelActive ? 'LIVE' : 'OFFLINE'}
                 </button>
                 {activeSession.tunnelActive && (
                   <div className="absolute top-full left-0 mt-2 w-64 bg-black border border-gray-700 rounded p-3 shadow-xl z-50 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                      <div className="text-[10px] uppercase font-bold text-gray-500 mb-2">Public Endpoint</div>
                      <div className="flex items-center gap-1 text-xs text-green-400 font-mono mb-2 select-all">
                         <ExternalLink className="w-3 h-3" /> {activeSession.tunnelUrl}
                      </div>
                      <div className="text-[10px] uppercase font-bold text-gray-500 mb-2">Local Address</div>
                      <div className="flex items-center gap-1 text-xs text-gray-300 font-mono select-all">
                         <Wifi className="w-3 h-3" /> http://192.168.1.42:{activeSession.port}
                      </div>
                   </div>
                 )}
              </div>
           </div>
           <div className="flex items-center gap-3">
              <div className="flex flex-col items-end mr-2">
                <span className="text-[10px] font-bold uppercase" style={{ color: theme.colors.textDim }}>Context Window</span>
                <div className="w-24 h-1.5 rounded-full mt-1 overflow-hidden" style={{ backgroundColor: theme.colors.border }}>
                  <div 
                    className="h-full transition-all duration-500 ease-out" 
                    style={{ 
                      width: `${activeSession.contextUsage}%`, 
                      backgroundColor: getContextColor(activeSession.contextUsage, theme) 
                    }} 
                  />
                </div>
              </div>

              <button onClick={() => setAboutModalOpen(true)} className="p-2 rounded hover:bg-white/5" title="About Maestro">
                <Info className="w-4 h-4" />
              </button>
              {!rightPanelOpen && (
                <button onClick={() => setRightPanelOpen(true)} className="p-2 rounded hover:bg-white/5" title={`Show right panel (${shortcuts.toggleRightPanel.keys.join('+').replace('Meta', 'Cmd')})`}>
                  <Columns className="w-4 h-4" />
                </button>
              )}
           </div>
        </div>

        {/* Logs Area */}
        <div
          ref={terminalOutputRef}
          tabIndex={0}
          className="flex-1 overflow-y-auto p-6 space-y-4 transition-colors outline-none relative"
          style={{ backgroundColor: activeSession.inputMode === 'ai' ? theme.colors.bgMain : theme.colors.bgActivity }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              inputRef.current?.focus();
              setActiveFocus('main');
            }
          }}
        >
           {/* Output Search */}
           {outputSearchOpen && (
             <div className="sticky top-0 z-10 pb-4">
               <input
                 type="text"
                 value={outputSearchQuery}
                 onChange={(e) => setOutputSearchQuery(e.target.value)}
                 onKeyDown={(e) => {
                   if (e.key === 'Escape') {
                     e.stopPropagation();
                     setOutputSearchOpen(false);
                     setOutputSearchQuery('');
                     terminalOutputRef.current?.focus();
                   }
                 }}
                 placeholder="Filter output... (Esc to close)"
                 className="w-full px-3 py-2 rounded border bg-transparent outline-none text-sm"
                 style={{ borderColor: theme.colors.accent, color: theme.colors.textMain, backgroundColor: theme.colors.bgSidebar }}
                 autoFocus
               />
             </div>
           )}
           {activeLogs.filter(log => {
             if (!outputSearchQuery) return true;
             return log.text.toLowerCase().includes(outputSearchQuery.toLowerCase());
           }).map(log => (
             <div key={log.id} className={`flex gap-4 group ${log.source === 'user' ? 'flex-row-reverse' : ''}`}>
                <div className="w-12 shrink-0 text-[10px] opacity-40 pt-2 font-mono text-center">
                  {new Date(log.timestamp).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}
                </div>
                <div className={`max-w-[80%] p-4 rounded-xl border ${log.source === 'user' ? 'rounded-tr-none' : 'rounded-tl-none'}`}
                     style={{ 
                       backgroundColor: log.source === 'user' ? theme.colors.bgActivity : 'transparent',
                       borderColor: theme.colors.border 
                     }}>
                   {log.images && log.images.length > 0 && (
                     <div className="flex gap-2 mb-2 overflow-x-auto">
                        {log.images.map((img, idx) => (
                          <img key={idx} src={img} className="h-20 rounded border cursor-zoom-in" onClick={() => setLightboxImage(img)} />
                        ))}
                     </div>
                   )}
                   <div className="whitespace-pre-wrap text-sm">{log.text}</div>
                </div>
             </div>
           ))}
           {activeSession.state === 'busy' && (
             <div className="flex items-center justify-center gap-2 text-xs opacity-50 animate-pulse py-4">
               <Activity className="w-4 h-4" />
               {activeSession.inputMode === 'ai' ? 'Claude is thinking...' : 'Executing shell command...'}
             </div>
           )}
           <div ref={logsEndRef} />
        </div>

        {/* Input Area (Expanded & Updated) */}
        <div className="relative p-4 border-t" style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }}>
           {stagedImages.length > 0 && (
             <div className="flex gap-2 mb-3 pb-2 overflow-x-auto overflow-y-visible">
                {stagedImages.map((img, idx) => (
                  <div key={idx} className="relative group">
                    <img
                      src={img}
                      className="h-16 rounded border cursor-pointer hover:opacity-80 transition-opacity"
                      style={{ borderColor: theme.colors.border }}
                      onClick={() => setLightboxImage(img)}
                    />
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setStagedImages(p => p.filter((_, i) => i !== idx));
                      }}
                      className="absolute top-0.5 right-0.5 bg-red-500 text-white rounded-full p-1 shadow-md hover:bg-red-600 transition-colors opacity-90 hover:opacity-100"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
             </div>
           )}

           {/* Command History Modal */}
           {commandHistoryOpen && (
             <div
               className="absolute bottom-full left-0 right-0 mb-2 border rounded-lg shadow-2xl max-h-64 overflow-hidden"
               style={{ backgroundColor: theme.colors.bgSidebar, borderColor: theme.colors.border }}
               onKeyDown={(e) => {
                 const history = activeSession.commandHistory || [];
                 const filtered = history.filter(cmd =>
                   cmd.toLowerCase().includes(commandHistoryFilter.toLowerCase())
                 ).reverse().slice(0, 5);

                 if (e.key === 'ArrowDown') {
                   e.preventDefault();
                   setCommandHistorySelectedIndex(Math.min(commandHistorySelectedIndex + 1, filtered.length - 1));
                 } else if (e.key === 'ArrowUp') {
                   e.preventDefault();
                   setCommandHistorySelectedIndex(Math.max(commandHistorySelectedIndex - 1, 0));
                 } else if (e.key === 'Enter') {
                   e.preventDefault();
                   if (filtered[commandHistorySelectedIndex]) {
                     setInputValue(filtered[commandHistorySelectedIndex]);
                     setCommandHistoryOpen(false);
                     setCommandHistoryFilter('');
                     inputRef.current?.focus();
                   }
                 } else if (e.key === 'Escape') {
                   e.preventDefault();
                   setCommandHistoryOpen(false);
                   setCommandHistoryFilter('');
                   inputRef.current?.focus();
                 }
               }}
             >
               <div className="p-2">
                 <input
                   autoFocus
                   type="text"
                   className="w-full bg-transparent outline-none text-sm p-2 border-b"
                   style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
                   placeholder="Filter commands..."
                   value={commandHistoryFilter}
                   onChange={(e) => {
                     setCommandHistoryFilter(e.target.value);
                     setCommandHistorySelectedIndex(0);
                   }}
                 />
               </div>
               <div className="max-h-48 overflow-y-auto">
                 {(activeSession.commandHistory || [])
                   .filter(cmd => cmd.toLowerCase().includes(commandHistoryFilter.toLowerCase()))
                   .reverse()
                   .slice(0, 5)
                   .map((cmd, idx) => (
                     <div
                       key={idx}
                       className={`px-3 py-2 cursor-pointer text-sm font-mono ${idx === commandHistorySelectedIndex ? 'ring-1 ring-inset' : ''}`}
                       style={{
                         backgroundColor: idx === commandHistorySelectedIndex ? theme.colors.bgActivity : 'transparent',
                         ringColor: theme.colors.accent,
                         color: theme.colors.textMain
                       }}
                       onClick={() => {
                         setInputValue(cmd);
                         setCommandHistoryOpen(false);
                         setCommandHistoryFilter('');
                         inputRef.current?.focus();
                       }}
                       onMouseEnter={() => setCommandHistorySelectedIndex(idx)}
                     >
                       {cmd}
                     </div>
                   ))}
                 {(activeSession.commandHistory || []).filter(cmd =>
                   cmd.toLowerCase().includes(commandHistoryFilter.toLowerCase())
                 ).length === 0 && (
                   <div className="px-3 py-4 text-center text-sm opacity-50">No matching commands</div>
                 )}
               </div>
             </div>
           )}

           <div className="flex gap-3">
             <div className="flex-1 relative border rounded-lg bg-opacity-50 flex flex-col" style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}>
               <textarea
                ref={inputRef}
                className="w-full bg-transparent text-sm outline-none p-3 resize-none min-h-[2.5rem] max-h-[8rem] scrollbar-thin"
                style={{ color: theme.colors.textMain }}
                placeholder={activeSession.inputMode === 'terminal' ? "Run shell command..." : "Ask Claude..."}
                value={inputValue}
                onChange={e => {
                  setInputValue(e.target.value);
                  // Auto-grow logic
                  e.target.style.height = 'auto';
                  e.target.style.height = `${Math.min(e.target.scrollHeight, 128)}px`;
                }}
                onKeyDown={handleInputKeyDown}
                onPaste={handlePaste}
                onDrop={handleDrop}
                onDragOver={e => e.preventDefault()}
                rows={1}
               />

               <div className="flex justify-between items-center px-2 pb-2">
                  <div className="flex gap-1 items-center">
                    {activeSession.inputMode === 'terminal' && (
                      <div className="text-[10px] font-mono opacity-50 px-2" style={{ color: theme.colors.textDim }}>
                        {activeSession.cwd?.replace(/^\/Users\/[^\/]+/, '~') || '~'}
                      </div>
                    )}
                    {activeSession.inputMode === 'ai' && (
                      <button
                        onClick={() => document.getElementById('image-file-input')?.click()}
                        className="p-1 hover:bg-white/10 rounded opacity-50 hover:opacity-100"
                        title="Attach Image"
                      >
                        <ImageIcon className="w-4 h-4"/>
                      </button>
                    )}
                    <input
                      id="image-file-input"
                      type="file"
                      accept="image/*"
                      multiple
                      className="hidden"
                      onChange={(e) => {
                        const files = Array.from(e.target.files || []);
                        files.forEach(file => {
                          const reader = new FileReader();
                          reader.onload = (event) => {
                            if (event.target?.result) {
                              setStagedImages(prev => [...prev, event.target!.result as string]);
                            }
                          };
                          reader.readAsDataURL(file);
                        });
                        e.target.value = '';
                      }}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setEnterToSend(!enterToSend)}
                      className="flex items-center gap-1 text-[10px] opacity-50 hover:opacity-100 px-2 py-1 rounded hover:bg-white/5"
                      title={enterToSend ? "Switch to Meta+Enter to send" : "Switch to Enter to send"}
                    >
                      <Keyboard className="w-3 h-3" />
                      {enterToSend ? 'Enter' : '⌘ + Enter'}
                    </button>
                  </div>
               </div>
             </div>

             {/* Mode Toggle & Send Button - Right Side */}
             <div className="flex flex-col gap-2">
               <button
                 onClick={toggleInputMode}
                 className="p-2 rounded border transition-all"
                 style={{
                   backgroundColor: activeSession.inputMode === 'terminal' ? theme.colors.bgActivity : theme.colors.accentDim,
                   borderColor: theme.colors.border,
                   color: activeSession.inputMode === 'terminal' ? theme.colors.textDim : theme.colors.accentText
                 }}
                 title="Toggle Mode (Cmd+J)"
               >
                 {activeSession.inputMode === 'terminal' ? <Terminal className="w-4 h-4" /> : <Cpu className="w-4 h-4" />}
               </button>
               <button
                 onClick={processInput}
                 className="p-2 rounded-md text-white hover:opacity-90 shadow-sm transition-all"
                 style={{ backgroundColor: theme.colors.accent }}
               >
                 <ArrowUp className="w-4 h-4" />
               </button>
             </div>
           </div>
        </div>

        {/* File Preview Overlay */}
        {previewFile && (
          <FilePreview
            file={previewFile}
            onClose={() => {
              setPreviewFile(null);
              setTimeout(() => {
                if (fileTreeContainerRef.current) {
                  fileTreeContainerRef.current.focus();
                }
              }, 0);
            }}
            theme={theme}
            markdownRawMode={markdownRawMode}
            setMarkdownRawMode={setMarkdownRawMode}
            shortcuts={shortcuts}
          />
        )}
      </div>

      {/* --- RIGHT PANEL (Restored) --- */}
      <div
        tabIndex={0}
        className={`border-l flex flex-col transition-all duration-300 outline-none relative ${rightPanelOpen ? '' : 'w-0 overflow-hidden opacity-0'} ${activeFocus === 'right' ? 'ring-1 ring-inset z-10' : ''}`}
        style={{
          width: rightPanelOpen ? `${rightPanelWidthState}px` : '0',
          backgroundColor: theme.colors.bgSidebar,
          borderColor: theme.colors.border,
          ringColor: theme.colors.accent
        }}
        onClick={() => setActiveFocus('right')}
        onFocus={() => setActiveFocus('right')}
      >
        {/* Resize Handle */}
        {rightPanelOpen && (
          <div
            className="absolute top-0 left-0 w-1 h-full cursor-col-resize hover:bg-blue-500 transition-colors z-20"
            onMouseDown={(e) => {
              e.preventDefault();
              const startX = e.clientX;
              const startWidth = rightPanelWidthState;

              const handleMouseMove = (e: MouseEvent) => {
                const delta = startX - e.clientX; // Reversed for right panel
                const newWidth = Math.max(384, Math.min(800, startWidth + delta)); // 384px = w-96 original size
                setRightPanelWidthState(newWidth);
              };

              const handleMouseUp = () => {
                window.maestro.settings.set('rightPanelWidth', rightPanelWidthState);
                document.removeEventListener('mousemove', handleMouseMove);
                document.removeEventListener('mouseup', handleMouseUp);
              };

              document.addEventListener('mousemove', handleMouseMove);
              document.addEventListener('mouseup', handleMouseUp);
            }}
          />
        )}
         <div className="flex border-b h-16" style={{ borderColor: theme.colors.border }}>
            <button
              onClick={() => setRightPanelOpen(!rightPanelOpen)}
              className="flex items-center justify-center p-2 rounded hover:bg-white/5 transition-colors w-12 shrink-0"
              title={`${rightPanelOpen ? "Collapse" : "Expand"} Right Panel (${shortcuts.toggleRightPanel.keys.join('+').replace('Meta', 'Cmd')})`}
            >
              {rightPanelOpen ? <PanelRightClose className="w-4 h-4 opacity-50" /> : <PanelRightOpen className="w-4 h-4 opacity-50" />}
            </button>
            {['files', 'history', 'scratchpad'].map(tab => {
              const isHistoryTab = tab === 'history';
              const isDisabled = isHistoryTab && activeSession.inputMode !== 'ai';

              return (
                <button
                  key={tab}
                  onClick={() => !isDisabled && setActiveRightTab(tab as RightPanelTab)}
                  disabled={isDisabled}
                  className="flex-1 text-xs font-bold border-b-2 capitalize transition-colors disabled:cursor-not-allowed"
                  style={{
                    borderColor: activeRightTab === tab ? theme.colors.accent : 'transparent',
                    color: isDisabled ? theme.colors.textDim + '40' : (activeRightTab === tab ? theme.colors.textMain : theme.colors.textDim),
                    opacity: isDisabled ? 0.3 : 1
                  }}
                  title={isDisabled ? 'History is only available in AI mode' : undefined}
                >
                  {tab}
                </button>
              );
            })}
         </div>
         <div
           ref={fileTreeContainerRef}
           className="flex-1 px-4 pb-4 overflow-y-auto min-w-[24rem] outline-none"
           tabIndex={-1}
           onScroll={(e) => {
             const scrollTop = e.currentTarget.scrollTop;
             setSessions(prev => prev.map(s =>
               s.id === activeSessionId ? { ...s, fileExplorerScrollPos: scrollTop } : s
             ));
           }}
         >
            {/* RE-IMPLEMENTED: FILE TREE */}
            {activeRightTab === 'files' && (
              <div className="space-y-2">
                 {/* File Tree Filter */}
                 {fileTreeFilterOpen && (
                   <div className="mb-3">
                     <input
                       autoFocus
                       type="text"
                       placeholder="Filter files..."
                       value={fileTreeFilter}
                       onChange={(e) => setFileTreeFilter(e.target.value)}
                       onKeyDown={(e) => {
                         if (e.key === 'Escape') {
                           setFileTreeFilterOpen(false);
                           setFileTreeFilter('');
                         }
                       }}
                       className="w-full px-3 py-2 rounded border bg-transparent outline-none text-sm"
                       style={{ borderColor: theme.colors.accent, color: theme.colors.textMain }}
                     />
                   </div>
                 )}
                 <div
                   className="sticky top-0 z-10 flex items-center justify-between text-xs font-bold pt-4 pb-2 mb-2 -mx-4 px-4"
                   style={{ backgroundColor: theme.colors.bgSidebar }}
                 >
                   <span className="opacity-50">{activeSession.cwd}</span>
                   <div className="flex items-center gap-1">
                     <button
                       onClick={expandAllFolders}
                       className="p-1 rounded hover:bg-white/10 transition-colors"
                       title="Expand all folders"
                       style={{ color: theme.colors.textDim }}
                     >
                       <div className="flex flex-col items-center -space-y-1.5">
                         <ChevronUp className="w-3.5 h-3.5" />
                         <ChevronDown className="w-3.5 h-3.5" />
                       </div>
                     </button>
                     <button
                       onClick={collapseAllFolders}
                       className="p-1 rounded hover:bg-white/10 transition-colors"
                       title="Collapse all folders"
                       style={{ color: theme.colors.textDim }}
                     >
                       <div className="flex flex-col items-center -space-y-1.5">
                         <ChevronDown className="w-3.5 h-3.5" />
                         <ChevronUp className="w-3.5 h-3.5" />
                       </div>
                     </button>
                   </div>
                 </div>
                 {activeSession.fileTreeError ? (
                   <div className="flex flex-col items-center justify-center gap-3 py-8">
                     <div className="text-xs text-center" style={{ color: theme.colors.error }}>
                       {activeSession.fileTreeError}
                     </div>
                     <button
                       onClick={updateSessionWorkingDirectory}
                       className="flex items-center gap-2 px-3 py-2 rounded border hover:bg-white/5 transition-colors text-xs"
                       style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
                     >
                       <Folder className="w-4 h-4" />
                       Select New Directory
                     </button>
                   </div>
                 ) : (
                   <>
                     {(!activeSession.fileTree || activeSession.fileTree.length === 0) && <div className="text-xs opacity-50 italic">Loading files...</div>}
                     {filteredFileTree && renderTree(filteredFileTree)}
                     {fileTreeFilter && filteredFileTree && filteredFileTree.length === 0 && (
                       <div className="text-xs opacity-50 italic text-center py-4">No files match your search</div>
                     )}
                   </>
                 )}
              </div>
            )}

            {/* RE-IMPLEMENTED: SEMANTIC HISTORY */}
            {activeRightTab === 'history' && (
              <div className="space-y-4">
                 {activeSession.workLog.length === 0 ? (
                   <div className="text-center py-8 text-xs opacity-50">No semantic logs yet.</div>
                 ) : (
                   activeSession.workLog.map(item => (
                      <div key={item.id} className="relative pl-4 border-l pb-4 last:pb-0" style={{ borderColor: theme.colors.border }}>
                        <div className="absolute -left-[5px] top-0 w-2.5 h-2.5 rounded-full border" style={{ backgroundColor: theme.colors.bgSidebar, borderColor: theme.colors.textDim }}></div>
                        <div className="text-xs font-bold" style={{ color: theme.colors.textMain }}>{item.title}</div>
                        <div className="text-xs mt-1 leading-relaxed opacity-70">{item.description}</div>
                        <div className="text-[10px] mt-2 opacity-50">{new Date(item.timestamp).toLocaleTimeString()}</div>
                      </div>
                   ))
                 )}
              </div>
            )}

            {/* RE-IMPLEMENTED: SCRATCHPAD TOOLBAR */}
            {activeRightTab === 'scratchpad' && (
              <Scratchpad
                content={activeSession.scratchPadContent}
                onChange={updateScratchPad}
                theme={theme}
                initialMode={activeSession.scratchPadMode || 'edit'}
                initialCursorPosition={activeSession.scratchPadCursorPosition || 0}
                initialEditScrollPos={activeSession.scratchPadEditScrollPos || 0}
                initialPreviewScrollPos={activeSession.scratchPadPreviewScrollPos || 0}
                onStateChange={updateScratchPadState}
              />
            )}
         </div>
      </div>
        </>
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
        initialTab={settingsTab}
      />
    </div>
  );
}

