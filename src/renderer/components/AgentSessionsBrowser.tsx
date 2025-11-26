import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Search, Clock, MessageSquare, HardDrive, Play, ChevronLeft, Loader2, Plus, X, List, Database, BarChart3, ChevronDown, User, Bot, DollarSign } from 'lucide-react';
import type { Theme, Session, LogEntry } from '../types';
import { useLayerStack } from '../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';

type SearchMode = 'title' | 'user' | 'assistant' | 'all';

interface SearchResult {
  sessionId: string;
  matchType: 'title' | 'user' | 'assistant';
  matchPreview: string;
  matchCount: number;
}

interface ClaudeSession {
  sessionId: string;
  projectPath: string;
  timestamp: string;
  modifiedAt: string;
  firstMessage: string;
  messageCount: number;
  sizeBytes: number;
  costUsd: number;
}

interface SessionMessage {
  type: string;
  role?: string;
  content: string;
  timestamp: string;
  uuid: string;
  toolUse?: any;
}

interface AgentSessionsBrowserProps {
  theme: Theme;
  activeSession: Session | undefined;
  activeClaudeSessionId: string | null;
  onClose: () => void;
  onResumeSession: (claudeSessionId: string, messages: LogEntry[]) => void;
  onNewSession: () => void;
}

export function AgentSessionsBrowser({
  theme,
  activeSession,
  activeClaudeSessionId,
  onClose,
  onResumeSession,
  onNewSession,
}: AgentSessionsBrowserProps) {
  const [sessions, setSessions] = useState<ClaudeSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [searchMode, setSearchMode] = useState<SearchMode>('title');
  const [searchModeDropdownOpen, setSearchModeDropdownOpen] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [viewingSession, setViewingSession] = useState<ClaudeSession | null>(null);
  const [messages, setMessages] = useState<SessionMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [totalMessages, setTotalMessages] = useState(0);
  const [messagesOffset, setMessagesOffset] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const selectedItemRef = useRef<HTMLButtonElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const searchModeDropdownRef = useRef<HTMLDivElement>(null);
  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const layerIdRef = useRef<string>();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const viewingSessionRef = useRef(viewingSession);
  viewingSessionRef.current = viewingSession;
  const autoJumpedRef = useRef<string | null>(null); // Track which session we've auto-jumped to

  const { registerLayer, unregisterLayer, updateLayerHandler } = useLayerStack();

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
        if (viewingSessionRef.current) {
          setViewingSession(null);
          setMessages([]);
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
  }, [registerLayer, unregisterLayer]);

  // Update handler when viewingSession changes
  useEffect(() => {
    if (layerIdRef.current) {
      updateLayerHandler(layerIdRef.current, () => {
        if (viewingSessionRef.current) {
          setViewingSession(null);
          setMessages([]);
        } else {
          onCloseRef.current();
        }
      });
    }
  }, [viewingSession, updateLayerHandler]);

  // Load sessions on mount
  useEffect(() => {
    const loadSessions = async () => {
      if (!activeSession?.cwd) {
        setLoading(false);
        return;
      }

      try {
        const result = await window.maestro.claude.listSessions(activeSession.cwd);
        setSessions(result);
      } catch (error) {
        console.error('Failed to load sessions:', error);
      } finally {
        setLoading(false);
      }
    };

    loadSessions();
  }, [activeSession?.cwd]);

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
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (searchModeDropdownRef.current && !searchModeDropdownRef.current.contains(e.target as Node)) {
        setSearchModeDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

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
        const results = await window.maestro.claude.searchSessions(
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
  }, [search, searchMode, activeSession?.cwd]);

  // Load messages when viewing a session
  const loadMessages = useCallback(async (session: ClaudeSession, offset: number = 0) => {
    if (!activeSession?.cwd) return;

    setMessagesLoading(true);
    try {
      const result = await window.maestro.claude.readSessionMessages(
        activeSession.cwd,
        session.sessionId,
        { offset, limit: 20 }
      );

      if (offset === 0) {
        setMessages(result.messages);
        // Scroll to bottom after initial load and focus the container for keyboard nav
        requestAnimationFrame(() => {
          if (messagesContainerRef.current) {
            messagesContainerRef.current.scrollTop = messagesContainerRef.current.scrollHeight;
            messagesContainerRef.current.focus();
          }
        });
      } else {
        // Prepend older messages
        setMessages(prev => [...result.messages, ...prev]);
      }
      setTotalMessages(result.total);
      setHasMoreMessages(result.hasMore);
      setMessagesOffset(offset + result.messages.length);
    } catch (error) {
      console.error('Failed to load messages:', error);
    } finally {
      setMessagesLoading(false);
    }
  }, [activeSession?.cwd]);

  // Handle viewing a session
  const handleViewSession = useCallback((session: ClaudeSession) => {
    setViewingSession(session);
    setMessages([]);
    setMessagesOffset(0);
    loadMessages(session, 0);
  }, [loadMessages]);

  // Handle loading more messages (scroll to top)
  const handleLoadMore = useCallback(() => {
    if (viewingSession && hasMoreMessages && !messagesLoading) {
      loadMessages(viewingSession, messagesOffset);
    }
  }, [viewingSession, hasMoreMessages, messagesLoading, messagesOffset, loadMessages]);

  // Handle scroll for lazy loading
  const handleMessagesScroll = useCallback(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    // Load more when scrolled near top
    if (container.scrollTop < 100 && hasMoreMessages && !messagesLoading) {
      const prevScrollHeight = container.scrollHeight;
      handleLoadMore();

      // Maintain scroll position after loading
      requestAnimationFrame(() => {
        if (container) {
          container.scrollTop = container.scrollHeight - prevScrollHeight;
        }
      });
    }
  }, [hasMoreMessages, messagesLoading, handleLoadMore]);

  // Calculate stats from all sessions
  const stats = useMemo(() => {
    const totalSessions = sessions.length;
    const totalMessages = sessions.reduce((sum, s) => sum + s.messageCount, 0);
    const totalSize = sessions.reduce((sum, s) => sum + s.sizeBytes, 0);
    const totalCost = sessions.reduce((sum, s) => sum + (s.costUsd || 0), 0);
    const oldestSession = sessions.length > 0
      ? new Date(Math.min(...sessions.map(s => new Date(s.timestamp).getTime())))
      : null;
    return { totalSessions, totalMessages, totalSize, totalCost, oldestSession };
  }, [sessions]);

  // Filter sessions by search - use different strategies based on search mode
  const filteredSessions = useMemo(() => {
    if (!search.trim()) {
      return sessions;
    }

    // For title search, filter locally (fast)
    if (searchMode === 'title') {
      const searchLower = search.toLowerCase();
      return sessions.filter(s =>
        s.firstMessage.toLowerCase().includes(searchLower) ||
        s.sessionId.toLowerCase().includes(searchLower)
      );
    }

    // For content searches, use backend results to filter sessions
    if (searchResults.length > 0) {
      const matchingIds = new Set(searchResults.map(r => r.sessionId));
      return sessions.filter(s => matchingIds.has(s.sessionId));
    }

    // If searching but no results yet, return empty (or all if still loading)
    return isSearching ? sessions : [];
  }, [sessions, search, searchMode, searchResults, isSearching]);

  // Get search result info for a session (for display purposes)
  const getSearchResultInfo = useCallback((sessionId: string): SearchResult | undefined => {
    return searchResults.find(r => r.sessionId === sessionId);
  }, [searchResults]);

  // Reset selected index when search changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [search]);

  // Keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (viewingSession) {
      if (e.key === 'Escape') {
        e.preventDefault();
        setViewingSession(null);
        setMessages([]);
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
      onResumeSession(viewingSession.sessionId, logEntries);
      onClose();
    }
  }, [viewingSession, messages, onResumeSession, onClose]);

  // Format file size
  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  // Format relative time
  const formatRelativeTime = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  };

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
                onClick={() => {
                  setViewingSession(null);
                  setMessages([]);
                }}
                className="p-1.5 rounded hover:bg-white/10 transition-colors"
                style={{ color: theme.colors.textDim }}
              >
                <ChevronLeft className="w-5 h-5" />
              </button>
              <div className="flex flex-col min-w-0">
                <div className="text-sm font-medium truncate max-w-md" style={{ color: theme.colors.textMain }}>
                  {viewingSession.firstMessage || `Session ${viewingSession.sessionId.slice(0, 8)}...`}
                </div>
                <div className="text-xs" style={{ color: theme.colors.textDim }}>
                  {totalMessages} messages • {formatRelativeTime(viewingSession.modifiedAt)}
                </div>
              </div>
            </>
          ) : (
            <>
              <List className="w-5 h-5" style={{ color: theme.colors.textDim }} />
              <span className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
                Claude Sessions for {activeSession?.name || 'Agent'}
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
                color: theme.colors.accentText,
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
                color: theme.colors.accentText,
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
                  color: msg.type === 'user' ? theme.colors.accentText : theme.colors.textMain,
                }}
              >
                <div className="whitespace-pre-wrap break-words">
                  {msg.content || (msg.toolUse ? `[Tool: ${msg.toolUse[0]?.name || 'unknown'}]` : '[No content]')}
                </div>
                <div
                  className="text-[10px] mt-2 opacity-60"
                  style={{ color: msg.type === 'user' ? theme.colors.accentText : theme.colors.textDim }}
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
                <span className="text-xs font-medium" style={{ color: theme.colors.textDim }}>
                  {stats.totalSessions} {stats.totalSessions === 1 ? 'session' : 'sessions'}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <MessageSquare className="w-4 h-4" style={{ color: theme.colors.success }} />
                <span className="text-xs font-medium" style={{ color: theme.colors.textDim }}>
                  {stats.totalMessages.toLocaleString()} messages
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Database className="w-4 h-4" style={{ color: theme.colors.warning }} />
                <span className="text-xs font-medium" style={{ color: theme.colors.textDim }}>
                  {formatSize(stats.totalSize)}
                </span>
              </div>
              {stats.totalCost > 0 && (
                <div className="flex items-center gap-2">
                  <DollarSign className="w-4 h-4" style={{ color: theme.colors.success }} />
                  <span className="text-xs font-medium font-mono" style={{ color: theme.colors.success }}>
                    ${stats.totalCost.toFixed(2)}
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
            </div>
          )}

          {/* Search bar */}
          <div className="p-4 border-b" style={{ borderColor: theme.colors.border }}>
            <div
              className="flex items-center gap-3 px-4 py-2.5 rounded-lg"
              style={{ backgroundColor: theme.colors.bgActivity }}
            >
              <Search className="w-4 h-4" style={{ color: theme.colors.textDim }} />
              <input
                ref={inputRef}
                className="flex-1 bg-transparent outline-none text-sm"
                placeholder={`Search ${searchMode === 'title' ? 'titles' : searchMode === 'user' ? 'your messages' : searchMode === 'assistant' ? 'AI responses' : 'all content'}...`}
                style={{ color: theme.colors.textMain }}
                value={search}
                onChange={e => setSearch(e.target.value)}
                onKeyDown={handleKeyDown}
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
              {/* Search mode dropdown */}
              <div className="relative" ref={searchModeDropdownRef}>
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
          <div className="flex-1 overflow-y-auto scrollbar-thin">
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-6 h-6 animate-spin" style={{ color: theme.colors.textDim }} />
              </div>
            ) : filteredSessions.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 px-4">
                <List className="w-12 h-12 mb-4 opacity-30" style={{ color: theme.colors.textDim }} />
                <p className="text-sm text-center" style={{ color: theme.colors.textDim }}>
                  {sessions.length === 0
                    ? 'No Claude sessions found for this project'
                    : 'No sessions match your search'}
                </p>
              </div>
            ) : (
              <div className="py-2">
                {filteredSessions.map((session, i) => {
                  const searchResultInfo = getSearchResultInfo(session.sessionId);
                  return (
                    <button
                      key={session.sessionId}
                      ref={i === selectedIndex ? selectedItemRef : null}
                      onClick={() => handleViewSession(session)}
                      className="w-full text-left px-6 py-4 flex items-start gap-4 hover:bg-white/5 transition-colors border-b"
                      style={{
                        backgroundColor: i === selectedIndex ? theme.colors.accent + '15' : 'transparent',
                        borderColor: theme.colors.border + '50',
                      }}
                    >
                      <div className="flex-1 min-w-0">
                        {/* Line 1: Title/first message */}
                        <div
                          className="font-medium truncate text-sm mb-1.5"
                          style={{ color: theme.colors.textMain }}
                        >
                          {session.firstMessage || `Session ${session.sessionId.slice(0, 8)}...`}
                        </div>
                        {/* Line 2: Session ID pill + stats + match info */}
                        <div className="flex items-center gap-3 text-xs" style={{ color: theme.colors.textDim }}>
                          {/* Session ID pill */}
                          <span
                            className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded"
                            style={{ backgroundColor: theme.colors.border, color: theme.colors.textDim }}
                          >
                            {session.sessionId.startsWith('agent-')
                              ? `AGENT-${session.sessionId.split('-')[1]?.toUpperCase() || ''}`
                              : session.sessionId.split('-')[0].toUpperCase()}
                          </span>
                          {/* Stats */}
                          <span className="flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            {formatRelativeTime(session.modifiedAt)}
                          </span>
                          <span className="flex items-center gap-1">
                            <MessageSquare className="w-3 h-3" />
                            {session.messageCount}
                          </span>
                          <span className="flex items-center gap-1">
                            <HardDrive className="w-3 h-3" />
                            {formatSize(session.sizeBytes)}
                          </span>
                          {/* Cost per session */}
                          {session.costUsd > 0 && (
                            <span className="flex items-center gap-1 font-mono" style={{ color: theme.colors.success }}>
                              <DollarSign className="w-3 h-3" />
                              {session.costUsd.toFixed(2)}
                            </span>
                          )}
                          {/* Show match count for content searches */}
                          {searchResultInfo && searchResultInfo.matchCount > 0 && searchMode !== 'title' && (
                            <span
                              className="flex items-center gap-1 px-1.5 py-0.5 rounded"
                              style={{ backgroundColor: theme.colors.accent + '20', color: theme.colors.accent }}
                            >
                              <Search className="w-3 h-3" />
                              {searchResultInfo.matchCount}
                            </span>
                          )}
                          {/* Show match preview for content searches */}
                          {searchResultInfo && searchResultInfo.matchPreview && searchMode !== 'title' && (
                            <span
                              className="truncate italic max-w-[200px]"
                              style={{ color: theme.colors.accent }}
                            >
                              "{searchResultInfo.matchPreview}"
                            </span>
                          )}
                        </div>
                      </div>
                      {activeClaudeSessionId === session.sessionId && (
                        <span
                          className="text-[10px] px-2 py-0.5 rounded-full shrink-0"
                          style={{ backgroundColor: theme.colors.success + '20', color: theme.colors.success }}
                        >
                          ACTIVE
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
