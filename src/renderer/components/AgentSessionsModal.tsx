import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Search, Clock, MessageSquare, HardDrive, Play, ChevronLeft, Loader2, Star } from 'lucide-react';
import type { Theme, Session } from '../types';
import { useLayerStack } from '../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { formatSize, formatRelativeTime } from '../utils/formatters';

interface ClaudeSession {
  sessionId: string;
  projectPath: string;
  timestamp: string;
  modifiedAt: string;
  firstMessage: string;
  messageCount: number;
  sizeBytes: number;
  sessionName?: string; // Named session from Maestro
}

interface SessionMessage {
  type: string;
  role?: string;
  content: string;
  timestamp: string;
  uuid: string;
  toolUse?: any;
}

interface AgentSessionsModalProps {
  theme: Theme;
  activeSession: Session | undefined;
  onClose: () => void;
  onResumeSession: (claudeSessionId: string) => void;
}

export function AgentSessionsModal({
  theme,
  activeSession,
  onClose,
  onResumeSession,
}: AgentSessionsModalProps) {
  const [sessions, setSessions] = useState<ClaudeSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [viewingSession, setViewingSession] = useState<ClaudeSession | null>(null);
  const [messages, setMessages] = useState<SessionMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [totalMessages, setTotalMessages] = useState(0);
  const [messagesOffset, setMessagesOffset] = useState(0);
  const [starredSessions, setStarredSessions] = useState<Set<string>>(new Set());

  // Pagination state for sessions list
  const [hasMoreSessions, setHasMoreSessions] = useState(false);
  const [isLoadingMoreSessions, setIsLoadingMoreSessions] = useState(false);
  const [totalSessionCount, setTotalSessionCount] = useState(0);
  const nextCursorRef = useRef<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const selectedItemRef = useRef<HTMLButtonElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const sessionsContainerRef = useRef<HTMLDivElement>(null);
  const layerIdRef = useRef<string>();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const { registerLayer, unregisterLayer, updateLayerHandler } = useLayerStack();

  // Register layer on mount
  useEffect(() => {
    layerIdRef.current = registerLayer({
      type: 'modal',
      priority: MODAL_PRIORITIES.AGENT_SESSIONS,
      blocksLowerLayers: true,
      capturesFocus: true,
      focusTrap: 'strict',
      ariaLabel: 'Agent Sessions',
      onEscape: () => {
        if (viewingSession) {
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
        if (viewingSession) {
          setViewingSession(null);
          setMessages([]);
        } else {
          onCloseRef.current();
        }
      });
    }
  }, [viewingSession, updateLayerHandler]);

  // Load sessions on mount and reset to list view
  useEffect(() => {
    // Always reset to list view when modal opens
    setViewingSession(null);
    setMessages([]);
    setMessagesOffset(0);
    setSessions([]);
    setHasMoreSessions(false);
    setTotalSessionCount(0);
    nextCursorRef.current = null;

    const loadSessions = async () => {
      if (!activeSession?.cwd) {
        console.log('AgentSessionsModal: No activeSession.cwd');
        setLoading(false);
        return;
      }

      console.log('AgentSessionsModal: Loading sessions for cwd:', activeSession.cwd);
      try {
        // Load starred sessions for this project
        const starredKey = `starredClaudeSessions:${activeSession.cwd}`;
        const savedStarred = await window.maestro.settings.get(starredKey);
        if (savedStarred && Array.isArray(savedStarred)) {
          setStarredSessions(new Set(savedStarred));
        }

        // Use paginated API for better performance with many sessions
        const result = await window.maestro.claude.listSessionsPaginated(activeSession.cwd, { limit: 100 });
        console.log('AgentSessionsModal: Got sessions:', result.sessions.length, 'of', result.totalCount);
        setSessions(result.sessions);
        setHasMoreSessions(result.hasMore);
        setTotalSessionCount(result.totalCount);
        nextCursorRef.current = result.nextCursor;
      } catch (error) {
        console.error('Failed to load sessions:', error);
      } finally {
        setLoading(false);
      }
    };

    loadSessions();
  }, [activeSession?.cwd]);

  // Load more sessions when scrolling near bottom
  const loadMoreSessions = useCallback(async () => {
    if (!activeSession?.cwd || !hasMoreSessions || isLoadingMoreSessions || !nextCursorRef.current) return;

    setIsLoadingMoreSessions(true);
    try {
      const result = await window.maestro.claude.listSessionsPaginated(activeSession.cwd, {
        cursor: nextCursorRef.current,
        limit: 100,
      });

      // Append new sessions, avoiding duplicates
      setSessions(prev => {
        const existingIds = new Set(prev.map(s => s.sessionId));
        const newSessions = result.sessions.filter(s => !existingIds.has(s.sessionId));
        return [...prev, ...newSessions];
      });
      setHasMoreSessions(result.hasMore);
      nextCursorRef.current = result.nextCursor;
    } catch (error) {
      console.error('Failed to load more sessions:', error);
    } finally {
      setIsLoadingMoreSessions(false);
    }
  }, [activeSession?.cwd, hasMoreSessions, isLoadingMoreSessions]);

  // Handle scroll for sessions list pagination - load more at 70% scroll
  const handleSessionsScroll = useCallback(() => {
    const container = sessionsContainerRef.current;
    if (!container) return;

    const { scrollTop, scrollHeight, clientHeight } = container;
    const scrollPercentage = (scrollTop + clientHeight) / scrollHeight;
    const atSeventyPercent = scrollPercentage >= 0.7;

    if (atSeventyPercent && hasMoreSessions && !isLoadingMoreSessions) {
      loadMoreSessions();
    }
  }, [hasMoreSessions, isLoadingMoreSessions, loadMoreSessions]);

  // Toggle star status for a session
  const toggleStar = useCallback(async (sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation(); // Don't trigger session view

    const newStarred = new Set(starredSessions);
    if (newStarred.has(sessionId)) {
      newStarred.delete(sessionId);
    } else {
      newStarred.add(sessionId);
    }
    setStarredSessions(newStarred);

    // Persist to settings
    if (activeSession?.cwd) {
      const starredKey = `starredClaudeSessions:${activeSession.cwd}`;
      await window.maestro.settings.set(starredKey, Array.from(newStarred));
    }
  }, [starredSessions, activeSession?.cwd]);

  // Focus input on mount
  useEffect(() => {
    const timer = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(timer);
  }, []);

  // Scroll selected item into view
  useEffect(() => {
    selectedItemRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selectedIndex]);

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

  // Filter sessions by search and sort starred to top
  const filteredSessions = sessions
    .filter(s =>
      (s.sessionName?.toLowerCase().includes(search.toLowerCase())) ||
      s.firstMessage.toLowerCase().includes(search.toLowerCase()) ||
      s.sessionId.toLowerCase().includes(search.toLowerCase())
    )
    .sort((a, b) => {
      const aStarred = starredSessions.has(a.sessionId);
      const bStarred = starredSessions.has(b.sessionId);
      if (aStarred && !bStarred) return -1;
      if (!aStarred && bStarred) return 1;
      // Within same starred status, sort by most recent
      return new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime();
    });

  // Reset selected index when search changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [search]);

  // Keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (viewingSession) {
      // In message view, only handle Escape (handled by layer stack)
      return;
    }

    if (e.key === 'ArrowDown') {
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

  // Handle resume session
  const handleResume = useCallback(() => {
    if (viewingSession) {
      onResumeSession(viewingSession.sessionId);
      onClose();
    }
  }, [viewingSession, onResumeSession, onClose]);

  // formatSize and formatRelativeTime imported from ../utils/formatters

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-start justify-center pt-24 z-[9999] animate-in fade-in duration-100">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Agent Sessions"
        tabIndex={-1}
        className="w-[700px] rounded-xl shadow-2xl border overflow-hidden flex flex-col max-h-[600px] outline-none"
        style={{ backgroundColor: theme.colors.bgActivity, borderColor: theme.colors.border }}
      >
        {/* Header */}
        <div className="p-4 border-b flex items-center gap-3" style={{ borderColor: theme.colors.border }}>
          {viewingSession ? (
            <>
              <button
                onClick={() => {
                  setViewingSession(null);
                  setMessages([]);
                }}
                className="p-1 rounded hover:bg-white/10 transition-colors"
                style={{ color: theme.colors.textDim }}
              >
                <ChevronLeft className="w-5 h-5" />
              </button>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate" style={{ color: theme.colors.textMain }}>
                  {viewingSession.sessionName || viewingSession.firstMessage || 'Session Preview'}
                </div>
                <div className="text-xs" style={{ color: theme.colors.textDim }}>
                  {totalMessages} messages • {formatRelativeTime(viewingSession.modifiedAt)}
                </div>
              </div>
              <button
                onClick={handleResume}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors"
                style={{
                  backgroundColor: theme.colors.accent,
                  color: theme.colors.accentForeground,
                }}
              >
                <Play className="w-4 h-4" />
                Resume
              </button>
            </>
          ) : (
            <>
              <Search className="w-5 h-5" style={{ color: theme.colors.textDim }} />
              <input
                ref={inputRef}
                className="flex-1 bg-transparent outline-none text-lg placeholder-opacity-50"
                placeholder={`Search ${activeSession?.name || 'agent'} sessions...`}
                style={{ color: theme.colors.textMain }}
                value={search}
                onChange={e => setSearch(e.target.value)}
                onKeyDown={handleKeyDown}
              />
              <div
                className="px-2 py-0.5 rounded text-xs font-bold"
                style={{ backgroundColor: theme.colors.bgMain, color: theme.colors.textDim }}
              >
                ESC
              </div>
            </>
          )}
        </div>

        {/* Content */}
        {viewingSession ? (
          <div
            ref={messagesContainerRef}
            className="flex-1 overflow-y-auto p-4 space-y-4 scrollbar-thin"
            onScroll={handleMessagesScroll}
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
                  className="max-w-[85%] rounded-lg px-4 py-2 text-sm"
                  style={{
                    backgroundColor: msg.type === 'user' ? theme.colors.accent : theme.colors.bgMain,
                    color: msg.type === 'user' ? (theme.mode === 'light' ? '#fff' : '#000') : theme.colors.textMain,
                  }}
                >
                  <div className="whitespace-pre-wrap break-words">
                    {msg.content || (msg.toolUse ? `[Tool: ${msg.toolUse[0]?.name || 'unknown'}]` : '[No content]')}
                  </div>
                  <div
                    className="text-[10px] mt-1 opacity-60"
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
        ) : (
          <div
            ref={sessionsContainerRef}
            className="overflow-y-auto py-2 flex-1 scrollbar-thin"
            onScroll={handleSessionsScroll}
          >
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-6 h-6 animate-spin" style={{ color: theme.colors.textDim }} />
              </div>
            ) : filteredSessions.length === 0 ? (
              <div className="px-4 py-8 text-center" style={{ color: theme.colors.textDim }}>
                {sessions.length === 0 ? 'No Claude sessions found for this project' : 'No sessions match your search'}
              </div>
            ) : (
              <>
                {filteredSessions.map((session, i) => {
                  const isStarred = starredSessions.has(session.sessionId);
                  return (
                    <button
                      key={session.sessionId}
                      ref={i === selectedIndex ? selectedItemRef : null}
                      onClick={() => handleViewSession(session)}
                      className="w-full text-left px-4 py-3 flex items-start gap-3 hover:bg-opacity-10 transition-colors group"
                      style={{
                        backgroundColor: i === selectedIndex ? theme.colors.accent : 'transparent',
                        color: theme.colors.textMain,
                      }}
                    >
                      {/* Star button */}
                      <button
                        onClick={(e) => toggleStar(session.sessionId, e)}
                        className="p-1 -ml-1 rounded hover:bg-white/10 transition-colors shrink-0"
                        title={isStarred ? 'Remove from favorites' : 'Add to favorites'}
                      >
                        <Star
                          className="w-4 h-4"
                          style={{
                            color: isStarred ? theme.colors.warning : theme.colors.textDim,
                            fill: isStarred ? theme.colors.warning : 'transparent',
                          }}
                        />
                      </button>
                      <div className="flex-1 min-w-0">
                        <div className="font-medium truncate text-sm">
                          {session.sessionName || session.firstMessage || `Session ${session.sessionId.slice(0, 8)}...`}
                        </div>
                        <div className="flex items-center gap-3 mt-1 text-xs" style={{ color: theme.colors.textDim }}>
                          <span className="flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            {formatRelativeTime(session.modifiedAt)}
                          </span>
                          <span className="flex items-center gap-1">
                            <MessageSquare className="w-3 h-3" />
                            {session.messageCount} msgs
                          </span>
                          <span className="flex items-center gap-1">
                            <HardDrive className="w-3 h-3" />
                            {formatSize(session.sizeBytes)}
                          </span>
                        </div>
                      </div>
                    </button>
                  );
                })}
                {/* Pagination indicator */}
                {(isLoadingMoreSessions || hasMoreSessions) && !search && (
                  <div className="py-3 flex justify-center items-center">
                    {isLoadingMoreSessions ? (
                      <div className="flex items-center gap-2">
                        <Loader2 className="w-4 h-4 animate-spin" style={{ color: theme.colors.accent }} />
                        <span className="text-xs" style={{ color: theme.colors.textDim }}>
                          Loading more sessions...
                        </span>
                      </div>
                    ) : (
                      <span className="text-[10px]" style={{ color: theme.colors.textDim }}>
                        {sessions.length} of {totalSessionCount} sessions loaded
                      </span>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
