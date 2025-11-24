import { useState, useEffect, useMemo } from 'react';
import type { Session, Group, ToolType, LogEntry } from '../types';
import { generateId } from '../utils/ids';

export interface UseSessionManagerReturn {
  // State
  sessions: Session[];
  groups: Group[];
  activeSessionId: string;
  activeSession: Session | null;
  sortedSessions: Session[];
  draggingSessionId: string | null;

  // Session operations
  setSessions: React.Dispatch<React.SetStateAction<Session[]>>;
  setActiveSessionId: (id: string) => void;
  createNewSession: (agentId: string, workingDir: string, name: string) => void;
  deleteSession: (id: string, showConfirmation: (message: string, onConfirm: () => void) => void) => void;
  toggleInputMode: () => void;
  toggleTunnel: (sessId: string, tunnelProvider: string) => void;
  updateScratchPad: (content: string) => void;
  updateScratchPadState: (state: {
    mode: 'edit' | 'preview';
    cursorPosition: number;
    editScrollPos: number;
    previewScrollPos: number;
  }) => void;
  startRenamingSession: (sessId: string) => void;
  finishRenamingSession: (sessId: string, newName: string) => void;

  // Group operations
  setGroups: React.Dispatch<React.SetStateAction<Group[]>>;
  toggleGroup: (groupId: string) => void;
  startRenamingGroup: (groupId: string) => void;
  finishRenamingGroup: (groupId: string, newName: string) => void;
  createNewGroup: (name: string, emoji: string, moveSessionToNewGroup?: boolean, activeSessionId?: string) => void;

  // Drag and drop
  handleDragStart: (sessionId: string) => void;
  handleDragOver: (e: React.DragEvent) => void;
  handleDropOnGroup: (groupId: string) => void;
  handleDropOnUngrouped: () => void;
  setDraggingSessionId: (id: string | null) => void;
}

export function useSessionManager(): UseSessionManagerReturn {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>('');
  const [draggingSessionId, setDraggingSessionId] = useState<string | null>(null);

  // Load sessions and groups from electron-store on mount (with localStorage migration)
  useEffect(() => {
    const loadSessionsAndGroups = async () => {
      try {
        // Try to load from electron-store first
        const savedSessions = await window.maestro.sessions.getAll();
        const savedGroups = await window.maestro.groups.getAll();

        // Handle sessions
        if (savedSessions && savedSessions.length > 0) {
          setSessions(savedSessions);
          // Set active session to first one if we have sessions
          if (savedSessions.length > 0) {
            setActiveSessionId(savedSessions[0].id);
          }
        } else {
          // Try to migrate from localStorage
          try {
            const localStorageSessions = localStorage.getItem('maestro_sessions');
            if (localStorageSessions) {
              const parsed = JSON.parse(localStorageSessions);
              setSessions(parsed);
              if (parsed.length > 0) {
                setActiveSessionId(parsed[0].id);
              }
              // Save to electron-store for future
              await window.maestro.sessions.setAll(parsed);
              // Clean up localStorage
              localStorage.removeItem('maestro_sessions');
            } else {
              setSessions([]);
            }
          } catch (e) {
            console.error('Failed to migrate sessions from localStorage:', e);
            setSessions([]);
          }
        }

        // Handle groups
        if (savedGroups && savedGroups.length > 0) {
          setGroups(savedGroups);
        } else {
          // Try to migrate from localStorage
          try {
            const localStorageGroups = localStorage.getItem('maestro_groups');
            if (localStorageGroups) {
              const parsed = JSON.parse(localStorageGroups);
              setGroups(parsed);
              await window.maestro.groups.setAll(parsed);
              localStorage.removeItem('maestro_groups');
            } else {
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

  // Persist sessions and groups to electron-store whenever they change
  useEffect(() => {
    window.maestro.sessions.setAll(sessions);
  }, [sessions]);

  useEffect(() => {
    window.maestro.groups.setAll(groups);
  }, [groups]);

  // Compute active session
  const activeSession = sessions.find(s => s.id === activeSessionId) || sessions[0] || null;

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

  // Session operations
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

  const deleteSession = (id: string, showConfirmation: (message: string, onConfirm: () => void) => void) => {
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

  const toggleInputMode = () => {
    setSessions(prev => prev.map(s => {
      if (s.id !== activeSessionId) return s;
      return { ...s, inputMode: s.inputMode === 'ai' ? 'terminal' : 'ai' };
    }));
  };

  const toggleTunnel = (sessId: string, tunnelProvider: string) => {
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

  const startRenamingSession = (sessId: string) => {
    // This state is managed in App.tsx, so we'll just return the function
    // The actual state (editingSessionId) needs to remain in App or be extracted to another hook
  };

  const finishRenamingSession = (sessId: string, newName: string) => {
    setSessions(prev => prev.map(s => s.id === sessId ? { ...s, name: newName } : s));
  };

  // Group operations
  const toggleGroup = (groupId: string) => {
    setGroups(prev => prev.map(g => g.id === groupId ? { ...g, collapsed: !g.collapsed } : g));
  };

  const startRenamingGroup = (groupId: string) => {
    // This state is managed in App.tsx, similar to startRenamingSession
  };

  const finishRenamingGroup = (groupId: string, newName: string) => {
    setGroups(prev => prev.map(g => g.id === groupId ? { ...g, name: newName.toUpperCase() } : g));
  };

  const createNewGroup = (
    name: string,
    emoji: string,
    moveSessionToNewGroup: boolean = false,
    currentActiveSessionId?: string
  ) => {
    if (name.trim()) {
      const newGroup: Group = {
        id: `group-${Date.now()}`,
        name: name.trim().toUpperCase(),
        emoji: emoji,
        collapsed: false
      };
      setGroups([...groups, newGroup]);

      // If we should move the session to the new group
      if (moveSessionToNewGroup && currentActiveSessionId) {
        setSessions(prev => prev.map(s =>
          s.id === currentActiveSessionId ? { ...s, groupId: newGroup.id } : s
        ));
      }
    }
  };

  // Drag and drop handlers
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

  return {
    sessions,
    groups,
    activeSessionId,
    activeSession,
    sortedSessions,
    draggingSessionId,
    setSessions,
    setActiveSessionId,
    createNewSession,
    deleteSession,
    toggleInputMode,
    toggleTunnel,
    updateScratchPad,
    updateScratchPadState,
    startRenamingSession,
    finishRenamingSession,
    setGroups,
    toggleGroup,
    startRenamingGroup,
    finishRenamingGroup,
    createNewGroup,
    handleDragStart,
    handleDragOver,
    handleDropOnGroup,
    handleDropOnUngrouped,
    setDraggingSessionId,
  };
}
