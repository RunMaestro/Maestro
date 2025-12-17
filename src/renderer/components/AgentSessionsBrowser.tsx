import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Search, Clock, MessageSquare, HardDrive, Play, ChevronLeft, Loader2, Plus, X, List, Database, BarChart3, ChevronDown, User, Bot, DollarSign, Star, Zap, Timer, Hash, ArrowDownToLine, ArrowUpFromLine, Edit3 } from 'lucide-react';
import type { Theme, Session, LogEntry } from '../types';
import { useLayerStack } from '../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { SessionActivityGraph, type ActivityEntry } from './SessionActivityGraph';
import { SessionListItem } from './SessionListItem';
import { formatSize, formatNumber, formatTokens, formatRelativeTime } from '../utils/formatters';
import { useSessionViewer, type ClaudeSession } from '../hooks/useSessionViewer';
import { useSessionPagination } from '../hooks/useSessionPagination';
import { useFilteredAndSortedSessions } from '../hooks/useFilteredAndSortedSessions';
import { useClickOutside } from '../hooks';

type SearchMode = 'title' | 'user' | 'assistant' | 'all';

interface SearchResult {
  sessionId: string;
  matchType: 'title' | 'user' | 'assistant';
  matchPreview: string;
  matchCount: number;
}

interface AgentSessionsBrowserProps {
  theme: Theme;
  activeSession: Session | undefined;
  activeClaudeSessionId: string | null;
  onClose: () => void;
  onResumeSession: (agentSessionId: string, messages: LogEntry[], sessionName?: string, starred?: boolean) => void;
  onNewSession: () => void;
  onUpdateTab?: (agentSessionId: string, updates: { name?: string | null; starred?: boolean }) => void;
}

export function AgentSessionsBrowser({
  theme,
  activeSession,
  activeClaudeSessionId,
  onClose,
  onResumeSession,
  onNewSession,
  onUpdateTab,
}: AgentSessionsBrowserProps) {
  // Get agentId from the active session's toolType
  const agentId = activeSession?.toolType || 'claude-code';

  // Session viewer hook for detail view state and handlers
  const {
    viewingSession,
    messages,
    messagesLoading,
    hasMoreMessages,
    totalMessages,
    messagesContainerRef,
    handleViewSession,
    handleLoadMore,
    handleMessagesScroll,
    clearViewingSession,
    setViewingSession,
  } = useSessionViewer({ cwd: activeSession?.cwd, agentId });

  // Starred sessions state (needs to be before pagination hook for callback)
  const [starredSessions, setStarredSessions] = useState<Set<string>>(new Set());

  // Session pagination hook for paginated loading
  const {
    sessions,
    loading,
    hasMoreSessions,
    isLoadingMoreSessions,
    totalSessionCount,
    handleSessionsScroll,
    sessionsContainerRef,
    updateSession,
  } = useSessionPagination({
    cwd: activeSession?.cwd,
    agentId,
    onStarredSessionsLoaded: setStarredSessions,
  });

  const [search, setSearch] = useState('');
  const [searchMode, setSearchMode] = useState<SearchMode>('all');
  const [showAllSessions, setShowAllSessions] = useState(false);
  const [namedOnly, setNamedOnly] = useState(false);
  const [searchModeDropdownOpen, setSearchModeDropdownOpen] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  // Activity graph vs search toggle state - default to search since graph needs data to load first
  const [showSearchPanel, setShowSearchPanel] = useState(true);
  const [graphLookbackHours, setGraphLookbackHours] = useState<number | null>(null); // null = all time (default)

  // Aggregate stats for ALL sessions (calculated progressively)
  const [aggregateStats, setAggregateStats] = useState<{
    totalSessions: number;
    totalMessages: number;
    totalCostUsd: number;
    totalSizeBytes: number;
    totalTokens: number;
    oldestTimestamp: string | null;
    isComplete: boolean;
  }>({ totalSessions: 0, totalMessages: 0, totalCostUsd: 0, totalSizeBytes: 0, totalTokens: 0, oldestTimestamp: null, isComplete: false });

  const inputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const selectedItemRef = useRef<HTMLButtonElement>(null);
  const searchModeDropdownRef = useRef<HTMLDivElement>(null);
  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const layerIdRef = useRef<string>();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const viewingSessionRef = useRef(viewingSession);
  viewingSessionRef.current = viewingSession;
  const autoJumpedRef = useRef<string | null>(null); // Track which session we've auto-jumped to

  const { registerLayer, unregisterLayer, updateLayerHandler } = useLayerStack();

  // Reset to list view on mount - ensures we always start with list view when opening
  useEffect(() => {
    clearViewingSession();
  }, [clearViewingSession]);

  // Register layer on mount for Escape key handling
  useEffect(() => {
    layerIdRef.current = registerLayer({
      type: 'modal',
      priority: MODAL_PRIORITIES.AGENT_SESSIONS,
      blocksLowerLayers: true,
      capturesFocus: true,
      focusTrap: 'lenient',
      ariaLabel: 'Agent Sessions Browser',
      onEscape: () => {
        // If viewing a session detail, go back to list; otherwise close the panel
        if (viewingSessionRef.current) {
          clearViewingSession();
        } else {
          onCloseRef.current();
        }
      },
    });

    return () => {
      if (layerIdRef.current) {
        unregisterLayer(layerIdRef.current);
      }
    };
  }, [registerLayer, unregisterLayer, clearViewingSession]);

  // Update handler when viewingSession changes
  useEffect(() => {
    if (layerIdRef.current) {
      updateLayerHandler(layerIdRef.current, () => {
        if (viewingSessionRef.current) {
          clearViewingSession();
        } else {
          onCloseRef.current();
        }
      });
    }
  }, [viewingSession, updateLayerHandler, clearViewingSession]);

  // Restore focus and scroll position when returning from detail view to list view
  const prevViewingSessionRef = useRef<ClaudeSession | null>(null);
  useEffect(() => {
    // If we just transitioned from viewing a session to list view
    if (prevViewingSessionRef.current && !viewingSession) {
      // Focus the search input and scroll to selected item after a short delay to ensure UI is ready
      const timer = setTimeout(() => {
        inputRef.current?.focus();
        selectedItemRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }, 50);
      return () => clearTimeout(timer);
    }
    prevViewingSessionRef.current = viewingSession;
  }, [viewingSession]);

  // Reset aggregate stats when cwd changes (session loading is handled by useSessionPagination)
  useEffect(() => {
    setAggregateStats({ totalSessions: 0, totalMessages: 0, totalCostUsd: 0, totalSizeBytes: 0, totalTokens: 0, oldestTimestamp: null, isComplete: false });
  }, [activeSession?.cwd]);

  // Listen for progressive stats updates
  useEffect(() => {
    if (!activeSession?.cwd) return;

    const unsubscribe = window.maestro.claude.onProjectStatsUpdate((stats) => {
      // Only update if this is for our project
      if (stats.projectPath === activeSession.cwd) {
        setAggregateStats({
          totalSessions: stats.totalSessions,
          totalMessages: stats.totalMessages,
          totalCostUsd: stats.totalCostUsd,
          totalSizeBytes: stats.totalSizeBytes,
          totalTokens: stats.totalTokens ?? 0,
          oldestTimestamp: stats.oldestTimestamp,
          isComplete: stats.isComplete,
        });
      }
    });

    return unsubscribe;
  }, [activeSession?.cwd]);

  // Toggle star status for a session
  const toggleStar = useCallback(async (sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation(); // Don't trigger session view

    const newStarred = new Set(starredSessions);
    const isNowStarred = !newStarred.has(sessionId);
    if (isNowStarred) {
      newStarred.add(sessionId);
    } else {
      newStarred.delete(sessionId);
    }
    setStarredSessions(newStarred);

    // Persist to Claude session origins
    if (activeSession?.cwd) {
      await window.maestro.claude.updateSessionStarred(
        activeSession.cwd,
        sessionId,
        isNowStarred
      );
    }

    // Update the tab if this session is open as a tab
    onUpdateTab?.(sessionId, { starred: isNowStarred });
  }, [starredSessions, activeSession?.cwd, onUpdateTab]);

  // Start renaming a session
  const startRename = useCallback((session: ClaudeSession, e: React.MouseEvent) => {
    e.stopPropagation(); // Don't trigger session view
    setRenamingSessionId(session.sessionId);
    setRenameValue(session.sessionName || '');
    // Focus input after render
    setTimeout(() => renameInputRef.current?.focus(), 50);
  }, []);

  // Cancel rename
  const cancelRename = useCallback(() => {
    setRenamingSessionId(null);
    setRenameValue('');
  }, []);

  // Submit rename
  const submitRename = useCallback(async (sessionId: string) => {
    if (!activeSession?.cwd) return;

    const trimmedName = renameValue.trim();
    try {
      // Update claudeSessionOriginsStore (single source of truth for session names)
      await window.maestro.claude.updateSessionName(
        activeSession.cwd,
        sessionId,
        trimmedName
      );

      // Update local state using the hook's updateSession function
      updateSession(sessionId, { sessionName: trimmedName || undefined });

      // Also update viewingSession if we're renaming the currently viewed session
      if (viewingSession?.sessionId === sessionId) {
        setViewingSession(prev => prev ? { ...prev, sessionName: trimmedName || undefined } : null);
      }

      // Update the tab if this session is open as a tab
      onUpdateTab?.(sessionId, { name: trimmedName || null });
    } catch (error) {
      console.error('Failed to rename session:', error);
    }

    cancelRename();
  }, [activeSession?.cwd, renameValue, viewingSession?.sessionId, cancelRename, onUpdateTab, updateSession]);

  // Auto-view session when activeClaudeSessionId is provided (e.g., from history panel click)
  useEffect(() => {
    // Only auto-jump once per activeClaudeSessionId
    if (!loading && sessions.length > 0 && activeClaudeSessionId && !viewingSession && autoJumpedRef.current !== activeClaudeSessionId) {
      const targetSession = sessions.find(s => s.sessionId === activeClaudeSessionId);
      if (targetSession) {
        autoJumpedRef.current = activeClaudeSessionId;
        handleViewSession(targetSession);
      }
    }
  }, [loading, sessions, activeClaudeSessionId, viewingSession, handleViewSession]);

  // Focus input on mount
  useEffect(() => {
    const timer = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(timer);
  }, []);

  // Scroll selected item into view
  useEffect(() => {
    selectedItemRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selectedIndex]);

  // Close search mode dropdown when clicking outside
  useClickOutside(searchModeDropdownRef, () => setSearchModeDropdownOpen(false), searchModeDropdownOpen);

  // Perform search when query or mode changes (with debounce for non-title searches)
  useEffect(() => {
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }

    // For title search, filter immediately (it's fast)
    if (searchMode === 'title' || !search.trim()) {
      setSearchResults([]);
      setIsSearching(false);
      return;
    }

    // For content searches, debounce and call backend
    setIsSearching(true);
    searchTimeoutRef.current = setTimeout(async () => {
      if (!activeSession?.cwd || !search.trim()) {
        setSearchResults([]);
        setIsSearching(false);
        return;
      }

      try {
        // Use generic agentSessions API with agentId parameter
        const results = await window.maestro.agentSessions.search(
          agentId,
          activeSession.cwd,
          search,
          searchMode
        );
        setSearchResults(results);
      } catch (error) {
        console.error('Search failed:', error);
        setSearchResults([]);
      } finally {
        setIsSearching(false);
      }
    }, 300);

    return () => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }
    };
  }, [search, searchMode, activeSession?.cwd, agentId]);

  // Use hook for filtering and sorting sessions
  const {
    filteredSessions,
    getSearchResultInfo,
  } = useFilteredAndSortedSessions({
    sessions,
    search,
    searchMode,
    searchResults,
    isSearching,
    starredSessions,
    showAllSessions,
    namedOnly,
  });

  // Stats always show totals for ALL sessions (fetched progressively from backend)
  const stats = useMemo(() => {
    return {
      totalSessions: aggregateStats.totalSessions,
      totalMessages: aggregateStats.totalMessages,
      totalSize: aggregateStats.totalSizeBytes,
      totalCost: aggregateStats.totalCostUsd,
      totalTokens: aggregateStats.totalTokens,
      oldestSession: aggregateStats.oldestTimestamp
        ? new Date(aggregateStats.oldestTimestamp)
        : null,
      isComplete: aggregateStats.isComplete,
    };
  }, [aggregateStats]);

  // Reset selected index when search changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [search]);

  // Keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (viewingSession) {
      if (e.key === 'Escape') {
        e.preventDefault();
        clearViewingSession();
      } else if (e.key === 'Enter') {
        // Enter in session details view resumes the session
        e.preventDefault();
        handleResume();
      }
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(prev => Math.min(prev + 1, filteredSessions.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(prev => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const selected = filteredSessions[selectedIndex];
      if (selected) {
        handleViewSession(selected);
      }
    }
  };

  // Handle resuming a session
  const handleResume = useCallback(() => {
    if (viewingSession) {
      // Convert messages to LogEntry format for AI terminal
      const logEntries: LogEntry[] = messages.map((msg, idx) => ({
        id: msg.uuid || `${viewingSession.sessionId}-${idx}`,
        timestamp: new Date(msg.timestamp).getTime(),
        source: msg.type === 'user' ? 'user' as const : 'stdout' as const,
        text: msg.content || (msg.toolUse ? `[Tool: ${msg.toolUse[0]?.name || 'unknown'}]` : '[No content]'),
      }));
      // Pass session name and starred status for the new tab
      const isStarred = starredSessions.has(viewingSession.sessionId);
      onResumeSession(viewingSession.sessionId, logEntries, viewingSession.sessionName, isStarred);
      onClose();
    }
  }, [viewingSession, messages, onResumeSession, onClose, starredSessions]);

  // Handle quick resume from the list view (without going to detail view)
  const handleQuickResume = useCallback((session: ClaudeSession, e: React.MouseEvent) => {
    e.stopPropagation(); // Don't trigger session view
    const isStarred = starredSessions.has(session.sessionId);
    // Pass empty messages array - the history will be loaded when the session is resumed
    onResumeSession(session.sessionId, [], session.sessionName, isStarred);
    onClose();
  }, [starredSessions, onResumeSession, onClose]);

  // Activity entries for the graph - cached in state to prevent re-renders during pagination
  // Only updates when: switching TO graph view, or filters change while graph is visible
  const [activityEntries, setActivityEntries] = useState<ActivityEntry[]>([]);
  const prevFiltersRef = useRef({ namedOnly, showAllSessions, showSearchPanel });

  useEffect(() => {
    const filtersChanged =
      prevFiltersRef.current.namedOnly !== namedOnly ||
      prevFiltersRef.current.showAllSessions !== showAllSessions;
    const switchingToGraph = prevFiltersRef.current.showSearchPanel && !showSearchPanel;

    prevFiltersRef.current = { namedOnly, showAllSessions, showSearchPanel };

    // Update graph entries when:
    // 1. Switching TO graph view (from search panel)
    // 2. Filters change while graph is visible
    // 3. Initial load when graph is visible and we have data
    const shouldUpdate =
      (switchingToGraph && filteredSessions.length > 0) ||
      (filtersChanged && !showSearchPanel && filteredSessions.length > 0) ||
      (!showSearchPanel && activityEntries.length === 0 && filteredSessions.length > 0);

    if (shouldUpdate) {
      setActivityEntries(filteredSessions.map(s => ({ timestamp: s.modifiedAt })));
    }
  }, [showSearchPanel, namedOnly, showAllSessions, filteredSessions, activityEntries.length]);

  // Handle activity graph bar click - scroll to first session in that time range
  const handleGraphBarClick = useCallback((bucketStart: number, bucketEnd: number) => {
    // Find the first session in this time bucket (sessions are sorted by modifiedAt desc)
    const sessionInBucket = filteredSessions.find(s => {
      const timestamp = new Date(s.modifiedAt).getTime();
      return timestamp >= bucketStart && timestamp < bucketEnd;
    });

    if (sessionInBucket) {
      // Find its index and scroll to it
      const index = filteredSessions.findIndex(s => s.sessionId === sessionInBucket.sessionId);
      if (index !== -1) {
        setSelectedIndex(index);
        // Scroll the item into view after state update
        setTimeout(() => {
          selectedItemRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }, 50);
      }
    }
  }, [filteredSessions]);

  // Handle Cmd+F to open search panel
  const handleGlobalKeyDown = useCallback((e: KeyboardEvent) => {
    // Only handle when not viewing a session and search panel is not already open
    if (!viewingSession && !showSearchPanel && (e.metaKey || e.ctrlKey) && e.key === 'f') {
      e.preventDefault();
      setShowSearchPanel(true);
      // Focus the search input after state update
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [viewingSession, showSearchPanel]);

  // Add global keyboard listener for Cmd+F
  useEffect(() => {
    document.addEventListener('keydown', handleGlobalKeyDown);
    return () => document.removeEventListener('keydown', handleGlobalKeyDown);
  }, [handleGlobalKeyDown]);

  return (
    <div className="flex-1 flex flex-col h-full" style={{ backgroundColor: theme.colors.bgMain }}>
      {/* Header */}
      <div
        className="h-16 border-b flex items-center justify-between px-6 shrink-0"
        style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }}
      >
        <div className="flex items-center gap-4">
          {viewingSession ? (
            <>
              <button
                onClick={clearViewingSession}
                className="p-1.5 rounded hover:bg-white/10 transition-colors"
                style={{ color: theme.colors.textDim }}
              >
                <ChevronLeft className="w-5 h-5" />
              </button>
              {/* Star button for detail view */}
              <button
                onClick={(e) => toggleStar(viewingSession.sessionId, e)}
                className="p-1.5 rounded hover:bg-white/10 transition-colors"
                title={starredSessions.has(viewingSession.sessionId) ? 'Remove from favorites' : 'Add to favorites'}
              >
                <Star
                  className="w-5 h-5"
                  style={{
                    color: starredSessions.has(viewingSession.sessionId) ? theme.colors.warning : theme.colors.textDim,
                    fill: starredSessions.has(viewingSession.sessionId) ? theme.colors.warning : 'transparent',
                  }}
                />
              </button>
              <div className="flex flex-col min-w-0">
                {/* Session name with edit button */}
                {renamingSessionId === viewingSession.sessionId ? (
                  <div className="flex items-center gap-1.5">
                    <input
                      ref={renameInputRef}
                      type="text"
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          submitRename(viewingSession.sessionId);
                        } else if (e.key === 'Escape') {
                          e.preventDefault();
                          cancelRename();
                        }
                      }}
                      onBlur={() => submitRename(viewingSession.sessionId)}
                      placeholder="Enter session name..."
                      className="bg-transparent outline-none text-sm font-semibold px-2 py-0.5 rounded border"
                      style={{
                        color: theme.colors.accent,
                        borderColor: theme.colors.accent,
                        backgroundColor: theme.colors.bgActivity,
                      }}
                      autoFocus
                    />
                  </div>
                ) : viewingSession.sessionName ? (
                  <div className="flex items-center gap-1.5">
                    <span
                      className="text-sm font-semibold truncate max-w-md"
                      style={{ color: theme.colors.accent }}
                    >
                      {viewingSession.sessionName}
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setRenamingSessionId(viewingSession.sessionId);
                        setRenameValue(viewingSession.sessionName || '');
                        setTimeout(() => renameInputRef.current?.focus(), 50);
                      }}
                      className="p-0.5 rounded hover:bg-white/10 transition-colors"
                      title="Rename session"
                    >
                      <Edit3 className="w-3 h-3" style={{ color: theme.colors.accent }} />
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5">
                    {/* Show full UUID as primary when no custom name */}
                    <span
                      className="text-sm font-mono font-medium truncate max-w-md"
                      style={{ color: theme.colors.textMain }}
                    >
                      {viewingSession.sessionId.toUpperCase()}
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setRenamingSessionId(viewingSession.sessionId);
                        setRenameValue('');
                        setTimeout(() => renameInputRef.current?.focus(), 50);
                      }}
                      className="p-0.5 rounded hover:bg-white/10 transition-colors"
                      title="Add session name"
                    >
                      <Edit3 className="w-3 h-3" style={{ color: theme.colors.textDim }} />
                    </button>
                  </div>
                )}
                {/* Show UUID underneath the custom name */}
                {viewingSession.sessionName && (
                  <div className="text-xs font-mono truncate max-w-md" style={{ color: theme.colors.textDim }}>
                    {viewingSession.sessionId.toUpperCase()}
                  </div>
                )}
                {/* Stats row with relative time and started timestamp */}
                <div className="text-xs flex items-center gap-1" style={{ color: theme.colors.textDim }}>
                  <span>{totalMessages} messages</span>
                  <span>•</span>
                  <span
                    className="relative group cursor-default"
                    title={new Date(viewingSession.timestamp).toLocaleString()}
                  >
                    {formatRelativeTime(viewingSession.modifiedAt)}
                    <span
                      className="absolute left-0 top-0 opacity-0 group-hover:opacity-100 transition-opacity px-1 rounded whitespace-nowrap"
                      style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textMain }}
                    >
                      {new Date(viewingSession.timestamp).toLocaleString()}
                    </span>
                  </span>
                </div>
              </div>
            </>
          ) : (
            <>
              <List className="w-5 h-5" style={{ color: theme.colors.textDim }} />
              <span className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
                {agentId === 'claude-code' ? 'Claude' : 'Agent'} Sessions for {activeSession?.name || 'Agent'}
              </span>
              {activeClaudeSessionId && (
                <span
                  className="text-xs px-2 py-0.5 rounded-full"
                  style={{ backgroundColor: theme.colors.accent + '20', color: theme.colors.accent }}
                >
                  Active: {activeClaudeSessionId.slice(0, 8)}...
                </span>
              )}
            </>
          )}
        </div>

        <div className="flex items-center gap-2">
          {viewingSession ? (
            <button
              onClick={handleResume}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors hover:opacity-80"
              style={{
                backgroundColor: theme.colors.accent,
                color: theme.colors.accentForeground,
              }}
            >
              <Play className="w-4 h-4" />
              Resume
            </button>
          ) : (
            <button
              onClick={onNewSession}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors hover:opacity-80"
              style={{
                backgroundColor: theme.colors.accent,
                color: theme.colors.accentForeground,
              }}
            >
              <Plus className="w-4 h-4" />
              New Session
            </button>
          )}
          <button
            onClick={onClose}
            className="p-2 rounded hover:bg-white/5 transition-colors"
            style={{ color: theme.colors.textDim }}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Content */}
      {viewingSession ? (
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Session Stats Panel */}
          <div
            className="px-6 py-4 border-b shrink-0"
            style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgActivity + '30' }}
          >
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {/* Cost */}
              <div className="flex flex-col">
                <div className="flex items-center gap-2 mb-1">
                  <DollarSign className="w-4 h-4" style={{ color: theme.colors.success }} />
                  <span className="text-xs font-medium uppercase tracking-wider" style={{ color: theme.colors.textDim }}>
                    Cost
                  </span>
                </div>
                <span className="text-lg font-mono font-semibold" style={{ color: theme.colors.success }}>
                  ${viewingSession.costUsd.toFixed(2)}
                </span>
              </div>

              {/* Duration */}
              <div className="flex flex-col">
                <div className="flex items-center gap-2 mb-1">
                  <Timer className="w-4 h-4" style={{ color: theme.colors.warning }} />
                  <span className="text-xs font-medium uppercase tracking-wider" style={{ color: theme.colors.textDim }}>
                    Duration
                  </span>
                </div>
                <span className="text-lg font-mono font-semibold" style={{ color: theme.colors.textMain }}>
                  {viewingSession.durationSeconds < 60
                    ? `${viewingSession.durationSeconds}s`
                    : viewingSession.durationSeconds < 3600
                    ? `${Math.floor(viewingSession.durationSeconds / 60)}m ${viewingSession.durationSeconds % 60}s`
                    : `${Math.floor(viewingSession.durationSeconds / 3600)}h ${Math.floor((viewingSession.durationSeconds % 3600) / 60)}m`}
                </span>
              </div>

              {/* Context Window with visual gauge */}
              <div className="flex flex-col">
                <div className="flex items-center gap-2 mb-1">
                  <Zap className="w-4 h-4" style={{ color: theme.colors.accent }} />
                  <span className="text-xs font-medium uppercase tracking-wider" style={{ color: theme.colors.textDim }}>
                    Total Tokens
                  </span>
                </div>
                {(() => {
                  const totalTokens = viewingSession.inputTokens + viewingSession.outputTokens;
                  const contextUsage = Math.min(100, (totalTokens / 200000) * 100);
                  const getContextColor = (usage: number) => {
                    if (usage >= 90) return theme.colors.error;
                    if (usage >= 70) return theme.colors.warning;
                    return theme.colors.accent;
                  };
                  return (
                    <>
                      <span className="text-lg font-mono font-semibold" style={{ color: theme.colors.textMain }}>
                        {formatNumber(totalTokens)}
                      </span>
                      <div className="flex items-center gap-2 mt-1">
                        <div className="w-24 h-2 rounded-full overflow-hidden" style={{ backgroundColor: theme.colors.border }}>
                          <div
                            className="h-full transition-all duration-500 ease-out"
                            style={{
                              width: `${contextUsage}%`,
                              backgroundColor: getContextColor(contextUsage)
                            }}
                          />
                        </div>
                        <span className="text-[10px] font-mono font-bold" style={{ color: getContextColor(contextUsage) }}>
                          {contextUsage.toFixed(1)}%
                        </span>
                      </div>
                      <span className="text-[10px] mt-0.5" style={{ color: theme.colors.textDim }}>
                        of 200k context
                      </span>
                    </>
                  );
                })()}
              </div>

              {/* Messages */}
              <div className="flex flex-col">
                <div className="flex items-center gap-2 mb-1">
                  <MessageSquare className="w-4 h-4" style={{ color: theme.colors.textDim }} />
                  <span className="text-xs font-medium uppercase tracking-wider" style={{ color: theme.colors.textDim }}>
                    Messages
                  </span>
                </div>
                <span className="text-lg font-mono font-semibold" style={{ color: theme.colors.textMain }}>
                  {viewingSession.messageCount}
                </span>
              </div>
            </div>

            {/* Token Breakdown */}
            <div className="mt-4 pt-3 border-t flex flex-wrap gap-x-6 gap-y-2" style={{ borderColor: theme.colors.border + '50' }}>
              <div className="flex items-center gap-2">
                <ArrowDownToLine className="w-3 h-3" style={{ color: theme.colors.textDim }} />
                <span className="text-xs" style={{ color: theme.colors.textDim }}>
                  Input: <span className="font-mono font-medium" style={{ color: theme.colors.textMain }}>{formatNumber(viewingSession.inputTokens)}</span>
                </span>
              </div>
              <div className="flex items-center gap-2">
                <ArrowUpFromLine className="w-3 h-3" style={{ color: theme.colors.textDim }} />
                <span className="text-xs" style={{ color: theme.colors.textDim }}>
                  Output: <span className="font-mono font-medium" style={{ color: theme.colors.textMain }}>{formatNumber(viewingSession.outputTokens)}</span>
                </span>
              </div>
              {viewingSession.cacheReadTokens > 0 && (
                <div className="flex items-center gap-2">
                  <Database className="w-3 h-3" style={{ color: theme.colors.success }} />
                  <span className="text-xs" style={{ color: theme.colors.textDim }}>
                    Cache Read: <span className="font-mono font-medium" style={{ color: theme.colors.success }}>{formatNumber(viewingSession.cacheReadTokens)}</span>
                  </span>
                </div>
              )}
              {viewingSession.cacheCreationTokens > 0 && (
                <div className="flex items-center gap-2">
                  <Hash className="w-3 h-3" style={{ color: theme.colors.warning }} />
                  <span className="text-xs" style={{ color: theme.colors.textDim }}>
                    Cache Write: <span className="font-mono font-medium" style={{ color: theme.colors.warning }}>{formatNumber(viewingSession.cacheCreationTokens)}</span>
                  </span>
                </div>
              )}
              <div className="flex items-center gap-2">
                <HardDrive className="w-3 h-3" style={{ color: theme.colors.textDim }} />
                <span className="text-xs" style={{ color: theme.colors.textDim }}>
                  Size: <span className="font-mono font-medium" style={{ color: theme.colors.textMain }}>{formatSize(viewingSession.sizeBytes)}</span>
                </span>
              </div>
            </div>
          </div>

          {/* Messages Container */}
          <div
            ref={messagesContainerRef}
            className="flex-1 overflow-y-auto p-6 space-y-4 outline-none scrollbar-thin"
            onScroll={handleMessagesScroll}
            onKeyDown={handleKeyDown}
            tabIndex={0}
          >
            {/* Load more indicator */}
            {hasMoreMessages && (
            <div className="text-center py-2">
              {messagesLoading ? (
                <Loader2 className="w-5 h-5 animate-spin mx-auto" style={{ color: theme.colors.textDim }} />
              ) : (
                <button
                  onClick={handleLoadMore}
                  className="text-sm hover:underline"
                  style={{ color: theme.colors.accent }}
                >
                  Load earlier messages...
                </button>
              )}
            </div>
          )}

          {/* Messages */}
          {messages.map((msg, idx) => (
            <div
              key={msg.uuid || idx}
              className={`flex ${msg.type === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className="max-w-[75%] rounded-lg px-4 py-3 text-sm"
                style={{
                  backgroundColor: msg.type === 'user' ? theme.colors.accent : theme.colors.bgActivity,
                  color: msg.type === 'user' ? (theme.mode === 'light' ? '#fff' : '#000') : theme.colors.textMain,
                }}
              >
                <div className="whitespace-pre-wrap break-words">
                  {msg.content || (msg.toolUse ? `[Tool: ${msg.toolUse[0]?.name || 'unknown'}]` : '[No content]')}
                </div>
                <div
                  className="text-[10px] mt-2 opacity-60"
                  style={{ color: msg.type === 'user' ? (theme.mode === 'light' ? '#fff' : '#000') : theme.colors.textDim }}
                >
                  {formatRelativeTime(msg.timestamp)}
                </div>
              </div>
            </div>
          ))}

          {messagesLoading && messages.length === 0 && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin" style={{ color: theme.colors.textDim }} />
            </div>
          )}
          </div>
        </div>
      ) : (
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Stats Panel */}
          {!loading && sessions.length > 0 && (
            <div
              className="px-6 py-3 border-b flex items-center gap-6"
              style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgActivity + '50' }}
            >
              <div className="flex items-center gap-2">
                <BarChart3 className="w-4 h-4" style={{ color: theme.colors.accent }} />
                <span className={`text-xs font-medium ${!stats.isComplete ? 'animate-pulse' : ''}`} style={{ color: theme.colors.textDim }}>
                  {stats.totalSessions.toLocaleString()} {stats.totalSessions === 1 ? 'session' : 'sessions'}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <MessageSquare className="w-4 h-4" style={{ color: theme.colors.success }} />
                <span className={`text-xs font-medium ${!stats.isComplete ? 'animate-pulse' : ''}`} style={{ color: theme.colors.textDim }}>
                  {stats.totalMessages.toLocaleString()} messages
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Database className="w-4 h-4" style={{ color: theme.colors.warning }} />
                <span className={`text-xs font-medium ${!stats.isComplete ? 'animate-pulse' : ''}`} style={{ color: theme.colors.textDim }}>
                  {formatSize(stats.totalSize)}
                </span>
              </div>
              {(stats.totalCost > 0 || !stats.isComplete) && (
                <div className="flex items-center gap-2">
                  <DollarSign className="w-4 h-4" style={{ color: theme.colors.success }} />
                  <span className={`text-xs font-medium font-mono ${!stats.isComplete ? 'animate-pulse' : ''}`} style={{ color: theme.colors.success }}>
                    ${stats.totalCost.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </span>
                </div>
              )}
              {(stats.totalTokens > 0 || !stats.isComplete) && (
                <div className="flex items-center gap-2">
                  <Zap className="w-4 h-4" style={{ color: theme.colors.accent }} />
                  <span className={`text-xs font-medium font-mono ${!stats.isComplete ? 'animate-pulse' : ''}`} style={{ color: theme.colors.textDim }}>
                    {formatTokens(stats.totalTokens)} tokens
                  </span>
                </div>
              )}
              {stats.oldestSession && (
                <div className="flex items-center gap-2">
                  <Clock className="w-4 h-4" style={{ color: theme.colors.textDim }} />
                  <span className="text-xs font-medium" style={{ color: theme.colors.textDim }}>
                    Since {stats.oldestSession.toLocaleDateString()}
                  </span>
                </div>
              )}
              {!stats.isComplete && (
                <Loader2 className="w-3 h-3 animate-spin ml-auto" style={{ color: theme.colors.textDim }} />
              )}
            </div>
          )}

          {/* Search bar / Activity Graph toggle area */}
          <div className="px-4 py-3 border-b" style={{ borderColor: theme.colors.border }}>
            <div
              className="flex items-center gap-3 px-4 py-2.5 rounded-lg"
              style={{ backgroundColor: theme.colors.bgActivity }}
            >
              {/* Toggle button: Search icon when showing graph, BarChart icon when showing search */}
              <button
                onClick={() => {
                  setShowSearchPanel(!showSearchPanel);
                  if (!showSearchPanel) {
                    // Switching to search - focus input after state update
                    setTimeout(() => inputRef.current?.focus(), 50);
                  } else {
                    // Switching to graph - clear search
                    setSearch('');
                  }
                }}
                className="p-1.5 rounded hover:bg-white/10 transition-colors shrink-0"
                style={{ color: theme.colors.textDim }}
                title={showSearchPanel ? 'Show activity graph' : 'Search sessions (⌘F)'}
              >
                {showSearchPanel ? (
                  <BarChart3 className="w-4 h-4" />
                ) : (
                  <Search className="w-4 h-4" />
                )}
              </button>

              {/* Conditional: Search input OR Activity Graph - fixed height container to prevent layout shift */}
              <div className="flex-1 min-w-0 flex items-center" style={{ height: '38px' }}>
                {showSearchPanel ? (
                  /* Search input */
                  <div className="flex-1 flex items-center gap-2">
                    <input
                      ref={inputRef}
                      className="flex-1 bg-transparent outline-none text-sm"
                      placeholder={`Search ${searchMode === 'title' ? 'titles' : searchMode === 'user' ? 'your messages' : searchMode === 'assistant' ? 'AI responses' : 'all content'}...`}
                      style={{ color: theme.colors.textMain }}
                      value={search}
                      onChange={e => setSearch(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') {
                          e.preventDefault();
                          e.stopPropagation();
                          setShowSearchPanel(false);
                          setSearch('');
                        } else {
                          handleKeyDown(e);
                        }
                      }}
                    />
                    {isSearching && (
                      <Loader2 className="w-4 h-4 animate-spin" style={{ color: theme.colors.textDim }} />
                    )}
                    {search && !isSearching && (
                      <button
                        onClick={() => setSearch('')}
                        className="p-0.5 rounded hover:bg-white/10"
                        style={{ color: theme.colors.textDim }}
                      >
                        <X className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                ) : (
                  /* Activity Graph */
                  <SessionActivityGraph
                    entries={activityEntries}
                    theme={theme}
                    onBarClick={handleGraphBarClick}
                    lookbackHours={graphLookbackHours}
                    onLookbackChange={setGraphLookbackHours}
                  />
                )}
              </div>

              {/* Filter controls - always visible */}
              <label
                className="flex items-center gap-1.5 text-xs cursor-pointer select-none shrink-0"
                style={{ color: namedOnly ? theme.colors.accent : theme.colors.textDim }}
                title="Only show sessions with custom names"
              >
                <input
                  type="checkbox"
                  checked={namedOnly}
                  onChange={(e) => setNamedOnly(e.target.checked)}
                  className="w-3.5 h-3.5 rounded cursor-pointer accent-current"
                  style={{ accentColor: theme.colors.accent }}
                />
                <span>Named</span>
              </label>
              <label
                className="flex items-center gap-1.5 text-xs cursor-pointer select-none shrink-0"
                style={{ color: showAllSessions ? theme.colors.accent : theme.colors.textDim }}
                title="Show sessions from all projects"
              >
                <input
                  type="checkbox"
                  checked={showAllSessions}
                  onChange={(e) => setShowAllSessions(e.target.checked)}
                  className="w-3.5 h-3.5 rounded cursor-pointer accent-current"
                  style={{ accentColor: theme.colors.accent }}
                />
                <span>Show All</span>
              </label>
              {/* Search mode dropdown - always visible */}
              <div className="relative shrink-0" ref={searchModeDropdownRef}>
                <button
                  onClick={() => setSearchModeDropdownOpen(!searchModeDropdownOpen)}
                  className="flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium hover:bg-white/10 transition-colors"
                  style={{ color: theme.colors.textDim, border: `1px solid ${theme.colors.border}` }}
                >
                  {searchMode === 'title' && <Search className="w-3 h-3" />}
                  {searchMode === 'user' && <User className="w-3 h-3" />}
                  {searchMode === 'assistant' && <Bot className="w-3 h-3" />}
                  {searchMode === 'all' && <MessageSquare className="w-3 h-3" />}
                  <span className="capitalize">{searchMode === 'all' ? 'All' : searchMode}</span>
                  <ChevronDown className="w-3 h-3" />
                </button>
                {searchModeDropdownOpen && (
                  <div
                    className="absolute right-0 top-full mt-1 w-48 rounded-lg shadow-lg border overflow-hidden z-50"
                    style={{ backgroundColor: theme.colors.bgSidebar, borderColor: theme.colors.border }}
                  >
                    {[
                      { mode: 'title' as SearchMode, icon: Search, label: 'Title Only', desc: 'Search session titles' },
                      { mode: 'user' as SearchMode, icon: User, label: 'My Messages', desc: 'Search your messages' },
                      { mode: 'assistant' as SearchMode, icon: Bot, label: 'AI Responses', desc: 'Search AI responses' },
                      { mode: 'all' as SearchMode, icon: MessageSquare, label: 'All Content', desc: 'Search everything' },
                    ].map(({ mode, icon: Icon, label, desc }) => (
                      <button
                        key={mode}
                        onClick={() => {
                          setSearchMode(mode);
                          setSearchModeDropdownOpen(false);
                        }}
                        className={`w-full flex items-start gap-3 px-3 py-2.5 text-left hover:bg-white/5 transition-colors ${searchMode === mode ? 'bg-white/10' : ''}`}
                      >
                        <Icon className="w-4 h-4 mt-0.5" style={{ color: searchMode === mode ? theme.colors.accent : theme.colors.textDim }} />
                        <div>
                          <div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>{label}</div>
                          <div className="text-xs" style={{ color: theme.colors.textDim }}>{desc}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Session list */}
          <div
            ref={sessionsContainerRef}
            className="flex-1 overflow-y-auto scrollbar-thin"
            onScroll={handleSessionsScroll}
          >
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-6 h-6 animate-spin" style={{ color: theme.colors.textDim }} />
              </div>
            ) : filteredSessions.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 px-4">
                <List className="w-12 h-12 mb-4 opacity-30" style={{ color: theme.colors.textDim }} />
                <p className="text-sm text-center" style={{ color: theme.colors.textDim }}>
                  {sessions.length === 0
                    ? `No ${agentId === 'claude-code' ? 'Claude' : 'agent'} sessions found for this project`
                    : 'No sessions match your search'}
                </p>
              </div>
            ) : (
              <div className="py-2">
                {filteredSessions.map((session, i) => (
                  <SessionListItem
                    key={session.sessionId}
                    session={session}
                    index={i}
                    selectedIndex={selectedIndex}
                    isStarred={starredSessions.has(session.sessionId)}
                    activeClaudeSessionId={activeClaudeSessionId}
                    renamingSessionId={renamingSessionId}
                    renameValue={renameValue}
                    searchMode={searchMode}
                    searchResultInfo={getSearchResultInfo(session.sessionId)}
                    theme={theme}
                    selectedItemRef={selectedItemRef}
                    renameInputRef={renameInputRef}
                    onSessionClick={handleViewSession}
                    onToggleStar={toggleStar}
                    onQuickResume={handleQuickResume}
                    onStartRename={startRename}
                    onRenameChange={setRenameValue}
                    onSubmitRename={submitRename}
                    onCancelRename={cancelRename}
                  />
                ))}
                {/* Pagination indicator */}
                {(isLoadingMoreSessions || hasMoreSessions) && !search && (
                  <div className="py-4 flex justify-center items-center">
                    {isLoadingMoreSessions ? (
                      <div className="flex items-center gap-2">
                        <Loader2 className="w-4 h-4 animate-spin" style={{ color: theme.colors.accent }} />
                        <span className="text-xs" style={{ color: theme.colors.textDim }}>
                          Loading more sessions...
                        </span>
                      </div>
                    ) : (
                      <span className="text-xs" style={{ color: theme.colors.textDim }}>
                        {sessions.length} of {totalSessionCount} sessions loaded
                      </span>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
