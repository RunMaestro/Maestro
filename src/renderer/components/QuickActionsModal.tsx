import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Search } from 'lucide-react';
import type { Session, Group, Theme, Shortcut, RightPanelTab, SettingsTab } from '../types';
import type { GroupChat } from '../../shared/group-chat-types';
import { useLayerStack } from '../contexts/LayerStackContext';
import { useToast } from '../contexts/ToastContext';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { gitService } from '../services/git';
import { formatShortcutKeys } from '../utils/shortcutFormatter';
import type { WizardStep } from './Wizard/WizardContext';
import { useListNavigation } from '../hooks';

interface QuickAction {
  id: string;
  label: string;
  action: () => void;
  subtext?: string;
  shortcut?: Shortcut;
}

interface QuickActionsModalProps {
  theme: Theme;
  sessions: Session[];
  setSessions: React.Dispatch<React.SetStateAction<Session[]>>;
  activeSessionId: string;
  groups: Group[];
  setGroups: React.Dispatch<React.SetStateAction<Group[]>>;
  shortcuts: Record<string, Shortcut>;
  initialMode?: 'main' | 'move-to-group';
  setQuickActionOpen: (open: boolean) => void;
  setActiveSessionId: (id: string) => void;
  setRenameInstanceModalOpen: (open: boolean) => void;
  setRenameInstanceValue: (value: string) => void;
  setRenameGroupModalOpen: (open: boolean) => void;
  setRenameGroupId: (id: string) => void;
  setRenameGroupValue: (value: string) => void;
  setRenameGroupEmoji: (emoji: string) => void;
  setCreateGroupModalOpen: (open: boolean) => void;
  setLeftSidebarOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  setRightPanelOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  setActiveRightTab: (tab: RightPanelTab) => void;
  toggleInputMode: () => void;
  deleteSession: (id: string) => void;
  addNewSession: () => void;
  setSettingsModalOpen: (open: boolean) => void;
  setSettingsTab: (tab: SettingsTab) => void;
  setShortcutsHelpOpen: (open: boolean) => void;
  setAboutModalOpen: (open: boolean) => void;
  setLogViewerOpen: (open: boolean) => void;
  setProcessMonitorOpen: (open: boolean) => void;
  setAgentSessionsOpen: (open: boolean) => void;
  setActiveAgentSessionId: (id: string | null) => void;
  setGitDiffPreview: (diff: string | null) => void;
  setGitLogOpen: (open: boolean) => void;
  onRenameTab?: () => void;
  onToggleReadOnlyMode?: () => void;
  onToggleTabShowThinking?: () => void;
  onOpenTabSwitcher?: () => void;
  tabShortcuts?: Record<string, Shortcut>;
  isAiMode?: boolean;
  setPlaygroundOpen?: (open: boolean) => void;
  onRefreshGitFileState?: () => Promise<void>;
  onDebugReleaseQueuedItem?: () => void;
  markdownEditMode?: boolean;
  onToggleMarkdownEditMode?: () => void;
  setUpdateCheckModalOpen?: (open: boolean) => void;
  openWizard?: () => void;
  wizardGoToStep?: (step: WizardStep) => void;
  setDebugWizardModalOpen?: (open: boolean) => void;
  setDebugPackageModalOpen?: (open: boolean) => void;
  startTour?: () => void;
  setFuzzyFileSearchOpen?: (open: boolean) => void;
  onEditAgent?: (session: Session) => void;
  // Group Chat
  groupChats?: GroupChat[];
  onNewGroupChat?: () => void;
  onOpenGroupChat?: (id: string) => void;
  onCloseGroupChat?: () => void;
  onDeleteGroupChat?: (id: string) => void;
  activeGroupChatId?: string | null;
  hasActiveSessionCapability?: (capability: 'supportsSessionStorage' | 'supportsSlashCommands' | 'supportsContextMerge') => boolean;
  // Merge session
  onOpenMergeSession?: () => void;
  // Send to agent
  onOpenSendToAgent?: () => void;
  // Remote control
  onToggleRemoteControl?: () => void;
  // Worktree PR creation
  onOpenCreatePR?: (session: Session) => void;
  // Summarize and continue
  onSummarizeAndContinue?: () => void;
  canSummarizeActiveTab?: boolean;
  // Auto Run reset tasks
  autoRunSelectedDocument?: string | null;
  autoRunCompletedTaskCount?: number;
  onAutoRunResetTasks?: () => void;
}

export function QuickActionsModal(props: QuickActionsModalProps) {
  const {
    theme, sessions, setSessions, activeSessionId, groups, setGroups, shortcuts,
    initialMode = 'main',
    setQuickActionOpen, setActiveSessionId, setRenameInstanceModalOpen, setRenameInstanceValue,
    setRenameGroupModalOpen, setRenameGroupId, setRenameGroupValue, setRenameGroupEmoji,
    setCreateGroupModalOpen,
    setLeftSidebarOpen, setRightPanelOpen, setActiveRightTab, toggleInputMode,
    deleteSession, addNewSession, setSettingsModalOpen, setSettingsTab,
    setShortcutsHelpOpen, setAboutModalOpen, setLogViewerOpen, setProcessMonitorOpen,
    setAgentSessionsOpen, setActiveAgentSessionId, setGitDiffPreview, setGitLogOpen,
    onRenameTab, onToggleReadOnlyMode, onToggleTabShowThinking, onOpenTabSwitcher, tabShortcuts, isAiMode, setPlaygroundOpen, onRefreshGitFileState,
    onDebugReleaseQueuedItem, markdownEditMode, onToggleMarkdownEditMode, setUpdateCheckModalOpen, openWizard, wizardGoToStep: _wizardGoToStep, setDebugWizardModalOpen, setDebugPackageModalOpen, startTour, setFuzzyFileSearchOpen, onEditAgent,
    groupChats, onNewGroupChat, onOpenGroupChat, onCloseGroupChat, onDeleteGroupChat, activeGroupChatId,
    hasActiveSessionCapability, onOpenMergeSession, onOpenSendToAgent, onOpenCreatePR,
    onSummarizeAndContinue, canSummarizeActiveTab,
    autoRunSelectedDocument, autoRunCompletedTaskCount, onAutoRunResetTasks
  } = props;

  const [search, setSearch] = useState('');
  const [mode, setMode] = useState<'main' | 'move-to-group'>(initialMode);
  const [renamingSession, setRenamingSession] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [firstVisibleIndex, setFirstVisibleIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const selectedItemRef = useRef<HTMLButtonElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const layerIdRef = useRef<string>();
  const modalRef = useRef<HTMLDivElement>(null);

  const { registerLayer, unregisterLayer, updateLayerHandler } = useLayerStack();
  const { addToast } = useToast();
  const activeSession = sessions.find(s => s.id === activeSessionId);

  // Register layer on mount (handler will be updated by separate effect)
  useEffect(() => {
    layerIdRef.current = registerLayer({
      type: 'modal',
      priority: MODAL_PRIORITIES.QUICK_ACTION,
      blocksLowerLayers: true,
      capturesFocus: true,
      focusTrap: 'strict',
      ariaLabel: 'Quick Actions',
      onEscape: () => setQuickActionOpen(false) // Initial handler, updated below
    });

    return () => {
      if (layerIdRef.current) {
        unregisterLayer(layerIdRef.current);
      }
    };
  }, [registerLayer, unregisterLayer, setQuickActionOpen]);

  // Update handler when mode changes - use a ref-based approach to avoid stale closure
  const handleEscapeRef = useRef<() => void>(() => setQuickActionOpen(false));
  useEffect(() => {
    handleEscapeRef.current = () => {
      // Handle escape based on current mode
      if (mode === 'move-to-group') {
        setMode('main');
        // Note: Selection will be reset by the search/mode change useEffect
      } else {
        setQuickActionOpen(false);
      }
    };
  }, [mode, setQuickActionOpen]);

  useEffect(() => {
    if (layerIdRef.current) {
      updateLayerHandler(layerIdRef.current, () => handleEscapeRef.current());
    }
  }, [updateLayerHandler]);

  // Focus input on mount
  useEffect(() => {
    // Small delay to ensure DOM is ready and layer is registered
    const timer = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(timer);
  }, []);

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
    setCreateGroupModalOpen(true);
    setQuickActionOpen(false);
  };

  const sessionActions: QuickAction[] = sessions.map(s => {
    // For worktree subagents, format as "Jump to $PARENT subagent: $NAME"
    let label: string;
    if (s.parentSessionId) {
      const parentSession = sessions.find(p => p.id === s.parentSessionId);
      const parentName = parentSession?.name || 'Unknown';
      label = `Jump to ${parentName} subagent: ${s.name}`;
    } else {
      label = `Jump to: ${s.name}`;
    }

    return {
      id: `jump-${s.id}`,
      label,
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
    };
  });

  // Group chat jump actions
  const groupChatActions: QuickAction[] = (groupChats && onOpenGroupChat)
    ? groupChats.map(gc => ({
        id: `groupchat-${gc.id}`,
        label: `Group Chat: ${gc.name}`,
        action: () => {
          onOpenGroupChat(gc.id);
          setQuickActionOpen(false);
        },
        subtext: `${gc.participants.length} participant${gc.participants.length !== 1 ? 's' : ''}`
      }))
    : [];

  const mainActions: QuickAction[] = [
    ...sessionActions,
    ...groupChatActions,
    { id: 'new', label: 'Create New Agent', shortcut: shortcuts.newInstance, action: addNewSession },
    ...(openWizard ? [{ id: 'wizard', label: 'New Agent Wizard', shortcut: shortcuts.openWizard, action: () => { openWizard(); setQuickActionOpen(false); } }] : []),
    ...(activeSession ? [{ id: 'rename', label: `Rename Agent: ${activeSession.name}`, action: () => {
      setRenameInstanceValue(activeSession.name);
      setRenameInstanceModalOpen(true);
      setQuickActionOpen(false);
    } }] : []),
    ...(activeSession && onEditAgent ? [{ id: 'editAgent', label: `Edit Agent: ${activeSession.name}`, action: () => {
      onEditAgent(activeSession);
      setQuickActionOpen(false);
    } }] : []),
    ...(activeSession ? [{ id: 'toggleBookmark', label: activeSession.bookmarked ? `Unbookmark: ${activeSession.name}` : `Bookmark: ${activeSession.name}`, action: () => {
      setSessions(prev => prev.map(s =>
        s.id === activeSessionId ? { ...s, bookmarked: !s.bookmarked } : s
      ));
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
    ...(isAiMode && onOpenTabSwitcher ? [{ id: 'tabSwitcher', label: 'Tab Switcher', shortcut: tabShortcuts?.tabSwitcher, action: () => { onOpenTabSwitcher(); setQuickActionOpen(false); } }] : []),
    ...(isAiMode && onRenameTab ? [{ id: 'renameTab', label: 'Rename Tab', shortcut: tabShortcuts?.renameTab, action: () => { onRenameTab(); setQuickActionOpen(false); } }] : []),
    ...(isAiMode && onToggleReadOnlyMode ? [{ id: 'toggleReadOnly', label: 'Toggle Read-Only Mode', shortcut: tabShortcuts?.toggleReadOnlyMode, action: () => { onToggleReadOnlyMode(); setQuickActionOpen(false); } }] : []),
    ...(isAiMode && onToggleTabShowThinking ? [{ id: 'toggleShowThinking', label: 'Toggle Show Thinking', shortcut: tabShortcuts?.toggleShowThinking, action: () => { onToggleTabShowThinking(); setQuickActionOpen(false); } }] : []),
    ...(isAiMode && onToggleMarkdownEditMode ? [{ id: 'toggleMarkdown', label: 'Toggle Edit/Preview', shortcut: shortcuts.toggleMarkdownMode, subtext: markdownEditMode ? 'Currently in edit mode' : 'Currently in preview mode', action: () => { onToggleMarkdownEditMode(); setQuickActionOpen(false); } }] : []),
    ...(activeSession ? [{ id: 'clearTerminal', label: 'Clear Terminal History', action: () => {
      setSessions(prev => prev.map(s =>
        s.id === activeSessionId ? { ...s, shellLogs: [] } : s
      ));
      setQuickActionOpen(false);
    } }] : []),
    ...(activeSession ? [{ id: 'kill', label: `Remove Agent: ${activeSession.name}`, shortcut: shortcuts.killInstance, action: () => deleteSession(activeSessionId) }] : []),
    { id: 'settings', label: 'Settings', shortcut: shortcuts.settings, action: () => { setSettingsModalOpen(true); setQuickActionOpen(false); } },
    { id: 'theme', label: 'Change Theme', action: () => { setSettingsModalOpen(true); setSettingsTab('theme'); setQuickActionOpen(false); } },
    { id: 'shortcuts', label: 'View Shortcuts', shortcut: shortcuts.help, action: () => { setShortcutsHelpOpen(true); setQuickActionOpen(false); } },
    ...(startTour ? [{ id: 'tour', label: 'Start Introductory Tour', subtext: 'Take a guided tour of the interface', action: () => { startTour(); setQuickActionOpen(false); } }] : []),
    { id: 'logs', label: 'View System Logs', shortcut: shortcuts.systemLogs, action: () => { setLogViewerOpen(true); setQuickActionOpen(false); } },
    { id: 'processes', label: 'View System Processes', shortcut: shortcuts.processMonitor, action: () => { setProcessMonitorOpen(true); setQuickActionOpen(false); } },
    ...(activeSession && hasActiveSessionCapability?.('supportsSessionStorage') ? [{ id: 'agentSessions', label: `View Agent Sessions for ${activeSession.name}`, shortcut: shortcuts.agentSessions, action: () => { setActiveAgentSessionId(null); setAgentSessionsOpen(true); setQuickActionOpen(false); } }] : []),
    ...(isAiMode && canSummarizeActiveTab && onSummarizeAndContinue ? [{ id: 'summarizeAndContinue', label: 'Context: Compact', shortcut: tabShortcuts?.summarizeAndContinue, subtext: 'Compact context into a fresh tab', action: () => { onSummarizeAndContinue(); setQuickActionOpen(false); } }] : []),
    ...(activeSession && hasActiveSessionCapability?.('supportsContextMerge') && onOpenMergeSession ? [{ id: 'mergeSession', label: 'Context: Merge Into', shortcut: shortcuts.mergeSession, subtext: 'Merge current context into another session', action: () => { onOpenMergeSession(); setQuickActionOpen(false); } }] : []),
    ...(activeSession && hasActiveSessionCapability?.('supportsContextMerge') && onOpenSendToAgent ? [{ id: 'sendToAgent', label: 'Context: Send to Agent', shortcut: shortcuts.sendToAgent, subtext: 'Transfer context to a different AI agent', action: () => { onOpenSendToAgent(); setQuickActionOpen(false); } }] : []),
    ...(activeSession?.isGitRepo ? [{ id: 'gitDiff', label: 'View Git Diff', shortcut: shortcuts.viewGitDiff, action: async () => {
      const cwd = activeSession.inputMode === 'terminal' ? (activeSession.shellCwd || activeSession.cwd) : activeSession.cwd;
      const diff = await gitService.getDiff(cwd);
      if (diff.diff) {
        setGitDiffPreview(diff.diff);
      }
      setQuickActionOpen(false);
    } }] : []),
    ...(activeSession?.isGitRepo ? [{ id: 'gitLog', label: 'View Git Log', shortcut: shortcuts.viewGitLog, action: () => { setGitLogOpen(true); setQuickActionOpen(false); } }] : []),
    ...(activeSession?.isGitRepo ? [{ id: 'openRepo', label: 'Open Repository in Browser', action: async () => {
      const cwd = activeSession.inputMode === 'terminal' ? (activeSession.shellCwd || activeSession.cwd) : activeSession.cwd;
      const browserUrl = await gitService.getRemoteBrowserUrl(cwd);
      if (browserUrl) {
        window.maestro.shell.openExternal(browserUrl);
      }
      setQuickActionOpen(false);
    } }] : []),
    // Create PR - only for worktree child sessions
    ...(activeSession && activeSession.parentSessionId && activeSession.worktreeBranch && onOpenCreatePR ? [{
      id: 'createPR',
      label: `Create Pull Request: ${activeSession.worktreeBranch}`,
      subtext: 'Open PR from this worktree branch',
      action: () => {
        onOpenCreatePR(activeSession);
        setQuickActionOpen(false);
      }
    }] : []),
    ...(activeSession && onRefreshGitFileState ? [{ id: 'refreshGitFileState', label: 'Refresh Files, Git, History', subtext: 'Reload file tree, git status, and history', action: async () => {
      await onRefreshGitFileState();
      setQuickActionOpen(false);
    } }] : []),
    { id: 'devtools', label: 'Toggle JavaScript Console', action: () => { window.maestro.devtools.toggle(); setQuickActionOpen(false); } },
    { id: 'about', label: 'About Maestro', action: () => { setAboutModalOpen(true); setQuickActionOpen(false); } },
    { id: 'website', label: 'Maestro Website', subtext: 'Open the Maestro website', action: () => { window.maestro.shell.openExternal('https://runmaestro.ai/'); setQuickActionOpen(false); } },
    { id: 'docs', label: 'Documentation and User Guide', subtext: 'Open the Maestro documentation', action: () => { window.maestro.shell.openExternal('https://docs.runmaestro.ai/'); setQuickActionOpen(false); } },
    { id: 'discord', label: 'Join Discord', subtext: 'Join the Maestro community', action: () => { window.maestro.shell.openExternal('https://discord.gg/SrBsykvG'); setQuickActionOpen(false); } },
    ...(setUpdateCheckModalOpen ? [{ id: 'updateCheck', label: 'Check for Updates', action: () => { setUpdateCheckModalOpen(true); setQuickActionOpen(false); } }] : []),
    { id: 'createDebugPackage', label: 'Create Debug Package', subtext: 'Generate a support bundle for bug reporting', action: () => {
      setQuickActionOpen(false);
      if (setDebugPackageModalOpen) {
        setDebugPackageModalOpen(true);
      } else {
        // Fallback to direct API call if modal not available
        addToast({ type: 'info', title: 'Debug Package', message: 'Creating debug package...' });
        window.maestro.debug.createPackage().then(result => {
          if (result.success && result.path) {
            addToast({ type: 'success', title: 'Debug Package Created', message: `Saved to ${result.path}` });
          } else if (result.error !== 'Cancelled by user') {
            addToast({ type: 'error', title: 'Debug Package Failed', message: result.error || 'Unknown error' });
          }
        }).catch(error => {
          addToast({ type: 'error', title: 'Debug Package Failed', message: error instanceof Error ? error.message : 'Unknown error' });
        });
      }
    } },
    { id: 'goToFiles', label: 'Go to Files Tab', shortcut: shortcuts.goToFiles, action: () => { setRightPanelOpen(true); setActiveRightTab('files'); setQuickActionOpen(false); } },
    { id: 'goToHistory', label: 'Go to History Tab', shortcut: shortcuts.goToHistory, action: () => { setRightPanelOpen(true); setActiveRightTab('history'); setQuickActionOpen(false); } },
    { id: 'goToAutoRun', label: 'Go to Auto Run Tab', shortcut: shortcuts.goToAutoRun, action: () => { setRightPanelOpen(true); setActiveRightTab('autorun'); setQuickActionOpen(false); } },
    // Auto Run reset tasks - only show when there are completed tasks in the selected document
    ...(autoRunSelectedDocument && autoRunCompletedTaskCount && autoRunCompletedTaskCount > 0 && onAutoRunResetTasks ? [{
      id: 'resetAutoRunTasks',
      label: `Reset Finished Tasks in ${autoRunSelectedDocument}`,
      subtext: `Uncheck ${autoRunCompletedTaskCount} completed task${autoRunCompletedTaskCount !== 1 ? 's' : ''}`,
      action: () => {
        onAutoRunResetTasks();
        setQuickActionOpen(false);
      }
    }] : []),
    ...(setFuzzyFileSearchOpen ? [{ id: 'fuzzyFileSearch', label: 'Fuzzy File Search', shortcut: shortcuts.fuzzyFileSearch, action: () => { setFuzzyFileSearchOpen(true); setQuickActionOpen(false); } }] : []),
    // Group Chat commands - only show when at least 2 AI agents exist
    ...(onNewGroupChat && sessions.filter(s => s.toolType !== 'terminal').length >= 2 ? [{ id: 'newGroupChat', label: 'New Group Chat', action: () => { onNewGroupChat(); setQuickActionOpen(false); } }] : []),
    ...(activeGroupChatId && onCloseGroupChat ? [{ id: 'closeGroupChat', label: 'Close Group Chat', action: () => { onCloseGroupChat(); setQuickActionOpen(false); } }] : []),
    ...(activeGroupChatId && onDeleteGroupChat && groupChats ? [{ id: 'deleteGroupChat', label: `Remove Group Chat: ${groupChats.find(c => c.id === activeGroupChatId)?.name || 'Group Chat'}`, shortcut: shortcuts.killInstance, action: () => { onDeleteGroupChat(activeGroupChatId); setQuickActionOpen(false); } }] : []),
    // Debug commands - only visible when user types "debug"
    { id: 'debugResetBusy', label: 'Debug: Reset Busy State', subtext: 'Clear stuck thinking/busy state for all sessions', action: () => {
      // Reset all sessions and tabs to idle state
      setSessions(prev => prev.map(s => ({
        ...s,
        state: 'idle' as const,
        busySource: undefined,
        thinkingStartTime: undefined,
        currentCycleTokens: undefined,
        currentCycleBytes: undefined,
        aiTabs: s.aiTabs?.map(tab => ({
          ...tab,
          state: 'idle' as const,
          thinkingStartTime: undefined
        }))
      })));
      console.log('[Debug] Reset busy state for all sessions');
      setQuickActionOpen(false);
    } },
    ...(activeSession ? [{ id: 'debugResetSession', label: 'Debug: Reset Current Session', subtext: `Clear busy state for ${activeSession.name}`, action: () => {
      setSessions(prev => prev.map(s => {
        if (s.id !== activeSessionId) return s;
        return {
          ...s,
          state: 'idle' as const,
          busySource: undefined,
          thinkingStartTime: undefined,
          currentCycleTokens: undefined,
          currentCycleBytes: undefined,
          aiTabs: s.aiTabs?.map(tab => ({
            ...tab,
            state: 'idle' as const,
            thinkingStartTime: undefined
          }))
        };
      }));
      console.log('[Debug] Reset busy state for session:', activeSessionId);
      setQuickActionOpen(false);
    } }] : []),
    { id: 'debugLogSessions', label: 'Debug: Log Session State', subtext: 'Print session state to console', action: () => {
      console.log('[Debug] All sessions:', sessions.map(s => ({
        id: s.id,
        name: s.name,
        state: s.state,
        busySource: s.busySource,
        thinkingStartTime: s.thinkingStartTime,
        tabs: s.aiTabs?.map(t => ({ id: t.id.substring(0, 8), name: t.name, state: t.state, thinkingStartTime: t.thinkingStartTime }))
      })));
      setQuickActionOpen(false);
    } },
    ...(setPlaygroundOpen ? [{ id: 'debugPlayground', label: 'Debug: Playground', subtext: 'Open the developer playground', action: () => {
      setPlaygroundOpen(true);
      setQuickActionOpen(false);
    } }] : []),
    ...(activeSession && activeSession.executionQueue?.length > 0 && onDebugReleaseQueuedItem ? [{
      id: 'debugReleaseQueued',
      label: 'Debug: Release Next Queued Item',
      subtext: `Process next item from queue (${activeSession.executionQueue.length} queued)`,
      action: () => {
        onDebugReleaseQueuedItem();
        setQuickActionOpen(false);
      }
    }] : []),
    ...(setDebugWizardModalOpen ? [{
      id: 'debugWizardPhaseReview',
      label: 'Debug: Wizard → Review Action Plans',
      subtext: 'Jump directly to Phase Review step (requires existing Auto Run docs)',
      action: () => {
        setDebugWizardModalOpen(true);
        setQuickActionOpen(false);
      }
    }] : []),
  ];

  const groupActions: QuickAction[] = [
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

  // Filter actions - hide "Debug:" prefixed commands unless user explicitly types "debug"
  const searchLower = search.toLowerCase();
  const showDebugCommands = searchLower.includes('debug');

  const filtered = actions
    .filter(a => {
      const isDebugCommand = a.label.toLowerCase().startsWith('debug:');
      // Hide debug commands unless user is searching for them
      if (isDebugCommand && !showDebugCommands) {
        return false;
      }
      return a.label.toLowerCase().includes(searchLower);
    })
    .sort((a, b) => a.label.localeCompare(b.label));

  // Callback for when an item is selected (by Enter key or number hotkey)
  const handleSelectByIndex = useCallback((index: number) => {
    const selectedAction = filtered[index];
    if (!selectedAction) return;

    // Don't close modal if action switches modes
    const switchesModes = selectedAction.id === 'moveToGroup' || selectedAction.id === 'back';
    selectedAction.action();
    if (!renamingSession && mode === 'main' && !switchesModes) {
      setQuickActionOpen(false);
    }
  }, [filtered, renamingSession, mode, setQuickActionOpen]);

  // Use hook for list navigation (arrow keys, number hotkeys, Enter)
  const {
    selectedIndex,
    setSelectedIndex,
    handleKeyDown: listHandleKeyDown,
    resetSelection
  } = useListNavigation({
    listLength: filtered.length,
    onSelect: handleSelectByIndex,
    enableNumberHotkeys: true,
    firstVisibleIndex,
    enabled: !renamingSession, // Disable navigation when renaming
  });

  // Scroll selected item into view
  useEffect(() => {
    selectedItemRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selectedIndex]);

  // Reset selection when search or mode changes
  useEffect(() => {
    resetSelection();
    setFirstVisibleIndex(0);
  }, [search, mode, resetSelection]);

  // Clear search when switching to move-to-group mode
  useEffect(() => {
    if (mode === 'move-to-group') {
      setSearch('');
    }
  }, [mode]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Handle rename mode separately
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

    // Delegate to list navigation hook
    listHandleKeyDown(e);

    // Add stopPropagation for Enter to prevent event bubbling
    if (e.key === 'Enter') {
      e.stopPropagation();
    }
  };

  return (
    <div className="fixed inset-0 modal-overlay flex items-start justify-center pt-32 z-[9999] animate-in fade-in duration-100">
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label="Quick Actions"
        tabIndex={-1}
        className="w-[600px] rounded-xl shadow-2xl border overflow-hidden flex flex-col max-h-[550px] outline-none"
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
              placeholder={mode === 'move-to-group' ? `Move ${activeSession?.name || 'session'} to...` : 'Type a command or jump to agent...'}
              style={{ color: theme.colors.textMain }}
              value={search}
              onChange={e => setSearch(e.target.value)}
              onKeyDown={handleKeyDown}
            />
          )}
          <div className="px-2 py-0.5 rounded text-xs font-bold" style={{ backgroundColor: theme.colors.bgMain, color: theme.colors.textDim }}>ESC</div>
        </div>
        {!renamingSession && (
          <div className="overflow-y-auto py-2 scrollbar-thin" ref={scrollContainerRef} onScroll={handleScroll}>
            {filtered.map((a, i) => {
              // Calculate dynamic number badge (1-9, 0) based on first visible item
              // Cap firstVisibleIndex so we always show 10 numbered items when near the end
              const maxFirstIndex = Math.max(0, filtered.length - 10);
              const effectiveFirstIndex = Math.min(firstVisibleIndex, maxFirstIndex);
              const distanceFromFirstVisible = i - effectiveFirstIndex;
              const showNumber = distanceFromFirstVisible >= 0 && distanceFromFirstVisible < 10;
              // 1-9 for positions 1-9, 0 for position 10
              const numberBadge = distanceFromFirstVisible === 9 ? 0 : distanceFromFirstVisible + 1;

              return (
                <button
                  key={a.id}
                  ref={i === selectedIndex ? selectedItemRef : null}
                  onClick={() => {
                    const switchesModes = a.id === 'moveToGroup' || a.id === 'back';
                    a.action();
                    if (mode === 'main' && !switchesModes) setQuickActionOpen(false);
                  }}
                  className={`w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-opacity-10 ${i === selectedIndex ? 'bg-opacity-10' : ''}`}
                  style={{
                    backgroundColor: i === selectedIndex ? theme.colors.accent : 'transparent',
                    color: i === selectedIndex ? theme.colors.accentForeground : theme.colors.textMain
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
                    {a.subtext && <span className="text-[10px] opacity-50">{a.subtext}</span>}
                  </div>
                  {a.shortcut && (
                    <span className="text-xs font-mono opacity-60">
                      {formatShortcutKeys(a.shortcut.keys)}
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
}
