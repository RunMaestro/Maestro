import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Wand2, Radio, ExternalLink, Columns, Copy, List, Loader2, Clock, GitBranch, ArrowUp, ArrowDown, FileEdit, Play, Star, Edit2, Check, X } from 'lucide-react';
import { LogViewer } from './LogViewer';
import { TerminalOutput } from './TerminalOutput';
import { InputArea } from './InputArea';
import { FilePreview } from './FilePreview';
import { ErrorBoundary } from './ErrorBoundary';
import { GitStatusWidget } from './GitStatusWidget';
import { AgentSessionsBrowser } from './AgentSessionsBrowser';
import { gitService } from '../services/git';
import { formatActiveTime } from '../utils/theme';
import type { Session, Theme, Shortcut, FocusArea, BatchRunState } from '../types';

// Recent Claude session for quick access
interface RecentClaudeSession {
  sessionId: string;
  firstMessage: string;
  timestamp: string;
}

interface SlashCommand {
  command: string;
  description: string;
}

interface MainPanelProps {
  // State
  logViewerOpen: boolean;
  agentSessionsOpen: boolean;
  activeClaudeSessionId: string | null;
  activeSession: Session | null;
  theme: Theme;
  fontFamily: string;
  activeFocus: FocusArea;
  outputSearchOpen: boolean;
  outputSearchQuery: string;
  inputValue: string;
  enterToSendAI: boolean;
  enterToSendTerminal: boolean;
  stagedImages: string[];
  commandHistoryOpen: boolean;
  commandHistoryFilter: string;
  commandHistorySelectedIndex: number;
  slashCommandOpen: boolean;
  slashCommands: SlashCommand[];
  selectedSlashCommandIndex: number;
  previewFile: { name: string; content: string; path: string } | null;
  markdownRawMode: boolean;
  shortcuts: Record<string, Shortcut>;
  rightPanelOpen: boolean;
  maxOutputLines: number;
  gitDiffPreview: string | null;
  fileTreeFilterOpen: boolean;

  // Setters
  setGitDiffPreview: (preview: string | null) => void;
  setLogViewerOpen: (open: boolean) => void;
  setAgentSessionsOpen: (open: boolean) => void;
  setActiveClaudeSessionId: (id: string | null) => void;
  onResumeClaudeSession: (claudeSessionId: string, messages: import('../types').LogEntry[]) => void;
  onNewClaudeSession: () => void;
  setActiveFocus: (focus: FocusArea) => void;
  setOutputSearchOpen: (open: boolean) => void;
  setOutputSearchQuery: (query: string) => void;
  setInputValue: (value: string) => void;
  setEnterToSendAI: (value: boolean) => void;
  setEnterToSendTerminal: (value: boolean) => void;
  setStagedImages: (images: string[]) => void;
  setLightboxImage: (image: string | null, contextImages?: string[]) => void;
  setCommandHistoryOpen: (open: boolean) => void;
  setCommandHistoryFilter: (filter: string) => void;
  setCommandHistorySelectedIndex: (index: number) => void;
  setSlashCommandOpen: (open: boolean) => void;
  setSelectedSlashCommandIndex: (index: number) => void;
  setPreviewFile: (file: { name: string; content: string; path: string } | null) => void;
  setMarkdownRawMode: (mode: boolean) => void;
  setAboutModalOpen: (open: boolean) => void;
  setRightPanelOpen: (open: boolean) => void;
  setGitLogOpen: (open: boolean) => void;

  // Refs
  inputRef: React.RefObject<HTMLTextAreaElement>;
  logsEndRef: React.RefObject<HTMLDivElement>;
  terminalOutputRef: React.RefObject<HTMLDivElement>;
  fileTreeContainerRef: React.RefObject<HTMLDivElement>;
  fileTreeFilterInputRef: React.RefObject<HTMLInputElement>;

  // Functions
  toggleTunnel: (sessionId: string) => void;
  toggleInputMode: () => void;
  processInput: () => void;
  handleInterrupt: () => void;
  handleInputKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  handlePaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  handleDrop: (e: React.DragEvent<HTMLDivElement>) => void;
  getContextColor: (usage: number, theme: Theme) => string;
  setActiveSessionId: (id: string) => void;
  onDeleteLog?: (logId: string) => void;
  onRemoveQueuedMessage?: (messageId: string) => void;

  // Auto mode props
  batchRunState?: BatchRunState;
  onStopBatchRun?: () => void;
  showConfirmation?: (message: string, onConfirm: () => void) => void;

  // TTS settings
  audioFeedbackCommand?: string;

  // Recent Claude sessions for quick access
  recentClaudeSessions: RecentClaudeSession[];
  onResumeRecentSession: (sessionId: string) => void;
}

export function MainPanel(props: MainPanelProps) {
  const {
    logViewerOpen, agentSessionsOpen, activeClaudeSessionId, activeSession, theme, activeFocus, outputSearchOpen, outputSearchQuery,
    inputValue, enterToSendAI, enterToSendTerminal, stagedImages, commandHistoryOpen, commandHistoryFilter,
    commandHistorySelectedIndex, slashCommandOpen, slashCommands, selectedSlashCommandIndex,
    previewFile, markdownRawMode, shortcuts, rightPanelOpen, maxOutputLines, gitDiffPreview,
    fileTreeFilterOpen, setGitDiffPreview, setLogViewerOpen, setAgentSessionsOpen, setActiveClaudeSessionId,
    onResumeClaudeSession, onNewClaudeSession, setActiveFocus, setOutputSearchOpen, setOutputSearchQuery,
    setInputValue, setEnterToSendAI, setEnterToSendTerminal, setStagedImages, setLightboxImage, setCommandHistoryOpen,
    setCommandHistoryFilter, setCommandHistorySelectedIndex, setSlashCommandOpen,
    setSelectedSlashCommandIndex, setPreviewFile, setMarkdownRawMode,
    setAboutModalOpen, setRightPanelOpen, setGitLogOpen, inputRef, logsEndRef, terminalOutputRef,
    fileTreeContainerRef, fileTreeFilterInputRef, toggleTunnel, toggleInputMode, processInput, handleInterrupt,
    handleInputKeyDown, handlePaste, handleDrop, getContextColor, setActiveSessionId,
    batchRunState, onStopBatchRun, showConfirmation, onRemoveQueuedMessage
  } = props;

  const isAutoModeActive = batchRunState?.isRunning || false;
  const isStopping = batchRunState?.isStopping || false;

  // Tunnel tooltip hover state
  const [tunnelTooltipOpen, setTunnelTooltipOpen] = useState(false);
  // Context window tooltip hover state
  const [contextTooltipOpen, setContextTooltipOpen] = useState(false);
  // Session ID copied notification
  const [showSessionIdCopied, setShowSessionIdCopied] = useState(false);
  // Git pill tooltip hover state
  const [gitTooltipOpen, setGitTooltipOpen] = useState(false);
  // Agent sessions tooltip hover state
  const [sessionsTooltipOpen, setSessionsTooltipOpen] = useState(false);
  // Session ID pill overlay state
  const [sessionPillOverlayOpen, setSessionPillOverlayOpen] = useState(false);
  const [sessionPillRenaming, setSessionPillRenaming] = useState(false);
  const [sessionPillRenameValue, setSessionPillRenameValue] = useState('');
  // Bookmarked and named Claude sessions (stored globally)
  const [bookmarkedSessions, setBookmarkedSessions] = useState<Set<string>>(new Set());
  const [namedSessions, setNamedSessions] = useState<Record<string, string>>({});
  const sessionPillRef = useRef<HTMLDivElement>(null);
  // Panel width for responsive hiding of widgets
  const [panelWidth, setPanelWidth] = useState(Infinity); // Start with Infinity so widgets show by default
  const headerRef = useRef<HTMLDivElement>(null);

  // Extract recent sessions from props
  const { recentClaudeSessions, onResumeRecentSession } = props;

  // Track panel width for responsive widget hiding
  useEffect(() => {
    const header = headerRef.current;
    if (!header) return;

    // Get initial width immediately
    setPanelWidth(header.offsetWidth);

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setPanelWidth(entry.contentRect.width);
      }
    });

    resizeObserver.observe(header);
    return () => resizeObserver.disconnect();
  }, []);

  // Responsive breakpoints for hiding widgets
  const showTimeWidget = panelWidth > 600;
  const showCostWidget = panelWidth > 500;

  // Git info state
  const [gitInfo, setGitInfo] = useState<{
    branch: string;
    remote: string;
    behind: number;
    ahead: number;
    uncommittedChanges: number;
  } | null>(null);

  // Fetch git info when session changes or becomes a git repo
  useEffect(() => {
    if (!activeSession?.isGitRepo) {
      setGitInfo(null);
      return;
    }

    const fetchGitInfo = async () => {
      try {
        const cwd = activeSession.inputMode === 'terminal' ? (activeSession.shellCwd || activeSession.cwd) : activeSession.cwd;
        const info = await window.maestro.git.info(cwd);
        setGitInfo(info);
      } catch (error) {
        console.error('Failed to fetch git info:', error);
        setGitInfo(null);
      }
    };

    fetchGitInfo();
    // Refresh git info every 10 seconds
    const interval = setInterval(fetchGitInfo, 10000);
    return () => clearInterval(interval);
  }, [activeSession?.id, activeSession?.isGitRepo, activeSession?.cwd, activeSession?.shellCwd, activeSession?.inputMode]);

  // Load bookmarked and named Claude sessions from settings
  useEffect(() => {
    const loadSessionMetadata = async () => {
      try {
        const savedBookmarked = await window.maestro.settings.get('bookmarkedClaudeSessions');
        if (savedBookmarked && Array.isArray(savedBookmarked)) {
          setBookmarkedSessions(new Set(savedBookmarked));
        }
        const savedNamed = await window.maestro.settings.get('namedClaudeSessions');
        if (savedNamed && typeof savedNamed === 'object') {
          setNamedSessions(savedNamed as Record<string, string>);
        }
      } catch (error) {
        console.error('Failed to load session metadata:', error);
      }
    };
    loadSessionMetadata();
  }, []);

  // Toggle bookmark for current session
  const toggleBookmark = useCallback(async () => {
    if (!activeSession?.claudeSessionId) return;
    const sessionId = activeSession.claudeSessionId;
    const newBookmarked = new Set(bookmarkedSessions);
    if (newBookmarked.has(sessionId)) {
      newBookmarked.delete(sessionId);
    } else {
      newBookmarked.add(sessionId);
    }
    setBookmarkedSessions(newBookmarked);
    try {
      await window.maestro.settings.set('bookmarkedClaudeSessions', Array.from(newBookmarked));
    } catch (error) {
      console.error('Failed to save bookmarked sessions:', error);
    }
  }, [activeSession?.claudeSessionId, bookmarkedSessions]);

  // Rename current session
  const saveSessionName = useCallback(async () => {
    if (!activeSession?.claudeSessionId) return;
    const sessionId = activeSession.claudeSessionId;
    const name = sessionPillRenameValue.trim();
    const newNamed = { ...namedSessions };
    if (name) {
      newNamed[sessionId] = name;
    } else {
      delete newNamed[sessionId];
    }
    setNamedSessions(newNamed);
    setSessionPillRenaming(false);
    setSessionPillRenameValue('');
    try {
      await window.maestro.settings.set('namedClaudeSessions', newNamed);
    } catch (error) {
      console.error('Failed to save session name:', error);
    }
  }, [activeSession?.claudeSessionId, sessionPillRenameValue, namedSessions]);

  // Close session pill overlay when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (sessionPillOverlayOpen && sessionPillRef.current && !sessionPillRef.current.contains(event.target as Node)) {
        setSessionPillOverlayOpen(false);
        setSessionPillRenaming(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [sessionPillOverlayOpen]);

  // Handler for input focus - select session in sidebar
  const handleInputFocus = () => {
    if (activeSession) {
      setActiveSessionId(activeSession.id);
      setActiveFocus('main');
    }
  };

  // Handler to view git diff
  const handleViewGitDiff = async () => {
    if (!activeSession || !activeSession.isGitRepo) return;

    const cwd = activeSession.inputMode === 'terminal' ? (activeSession.shellCwd || activeSession.cwd) : activeSession.cwd;
    const diff = await gitService.getDiff(cwd);

    if (diff.diff) {
      setGitDiffPreview(diff.diff);
    }
  };

  // Copy to clipboard handler
  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      console.error('Failed to copy to clipboard:', err);
    }
  };

  // Copy session ID to clipboard with notification
  const copySessionIdToClipboard = async () => {
    if (!activeSession?.claudeSessionId) return;
    try {
      await navigator.clipboard.writeText(activeSession.claudeSessionId);
      setShowSessionIdCopied(true);
      setTimeout(() => setShowSessionIdCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy session ID to clipboard:', err);
    }
  };

  // Show log viewer
  if (logViewerOpen) {
    return (
      <div className="flex-1 flex flex-col min-w-0 relative" style={{ backgroundColor: theme.colors.bgMain }}>
        <LogViewer theme={theme} onClose={() => setLogViewerOpen(false)} />
      </div>
    );
  }

  // Show agent sessions browser
  if (agentSessionsOpen) {
    return (
      <div className="flex-1 flex flex-col min-w-0 relative" style={{ backgroundColor: theme.colors.bgMain }}>
        <AgentSessionsBrowser
          theme={theme}
          activeSession={activeSession || undefined}
          activeClaudeSessionId={activeClaudeSessionId}
          onClose={() => setAgentSessionsOpen(false)}
          onResumeSession={onResumeClaudeSession}
          onNewSession={onNewClaudeSession}
        />
      </div>
    );
  }

  // Show empty state when no active session
  if (!activeSession) {
    return (
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
    );
  }

  // Show normal session view
  return (
    <>
      <ErrorBoundary>
        <div
          className={`flex-1 flex flex-col min-w-0 relative ${activeFocus === 'main' ? 'ring-1 ring-inset z-10' : ''}`}
          style={{ backgroundColor: theme.colors.bgMain, ringColor: theme.colors.accent }}
          onClick={() => setActiveFocus('main')}
        >
          {/* Top Bar */}
          <div ref={headerRef} className="h-16 border-b flex items-center justify-between px-6 shrink-0" style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }}>
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2 text-sm font-medium">
                {activeSession.name}
                <div
                  className="relative"
                  onMouseEnter={() => activeSession.isGitRepo && setGitTooltipOpen(true)}
                  onMouseLeave={() => setGitTooltipOpen(false)}
                >
                  <span
                    className={`flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full border cursor-pointer ${activeSession.isGitRepo ? 'border-orange-500/30 text-orange-500 bg-orange-500/10 hover:bg-orange-500/20' : 'border-blue-500/30 text-blue-500 bg-blue-500/10'}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (activeSession.isGitRepo) setGitLogOpen(true);
                    }}
                  >
                    {activeSession.isGitRepo ? (
                      <>
                        <GitBranch className="w-3 h-3" />
                        {gitInfo?.branch || 'GIT'}
                      </>
                    ) : 'LOCAL'}
                  </span>
                  {activeSession.isGitRepo && gitTooltipOpen && gitInfo && (
                    <div
                      className="absolute top-full left-0 pt-2 w-80 z-50 pointer-events-none"
                    >
                      <div
                        className="rounded shadow-xl pointer-events-auto"
                        style={{
                          backgroundColor: theme.colors.bgSidebar,
                          borderColor: theme.colors.border,
                          border: '1px solid'
                        }}
                      >
                      {/* Branch */}
                      <div className="p-3 border-b" style={{ borderColor: theme.colors.border }}>
                        <div className="text-[10px] uppercase font-bold mb-2" style={{ color: theme.colors.textDim }}>Branch</div>
                        <div className="flex items-center gap-2">
                          <GitBranch className="w-4 h-4 text-orange-500" />
                          <span className="text-sm font-mono font-medium" style={{ color: theme.colors.textMain }}>
                            {gitInfo.branch}
                          </span>
                          {(gitInfo.ahead > 0 || gitInfo.behind > 0) && (
                            <div className="flex items-center gap-2 ml-auto">
                              {gitInfo.ahead > 0 && (
                                <span className="flex items-center gap-0.5 text-xs text-green-500">
                                  <ArrowUp className="w-3 h-3" />
                                  {gitInfo.ahead}
                                </span>
                              )}
                              {gitInfo.behind > 0 && (
                                <span className="flex items-center gap-0.5 text-xs text-red-500">
                                  <ArrowDown className="w-3 h-3" />
                                  {gitInfo.behind}
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Remote Origin */}
                      {gitInfo.remote && (
                        <div className="p-3 border-b" style={{ borderColor: theme.colors.border }}>
                          <div className="text-[10px] uppercase font-bold mb-2" style={{ color: theme.colors.textDim }}>Origin</div>
                          <div className="flex items-center gap-2">
                            <ExternalLink className="w-3 h-3 shrink-0" style={{ color: theme.colors.textDim }} />
                            <span
                              className="text-xs font-mono truncate flex-1"
                              style={{ color: theme.colors.textMain }}
                              title={gitInfo.remote}
                            >
                              {gitInfo.remote.replace(/^https?:\/\//, '').replace(/\.git$/, '')}
                            </span>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                copyToClipboard(gitInfo.remote);
                              }}
                              className="p-1 rounded hover:bg-white/10 transition-colors shrink-0"
                              title="Copy remote URL"
                            >
                              <Copy className="w-3 h-3" style={{ color: theme.colors.textDim }} />
                            </button>
                          </div>
                        </div>
                      )}

                      {/* Status Summary */}
                      <div className="p-3">
                        <div className="text-[10px] uppercase font-bold mb-2" style={{ color: theme.colors.textDim }}>Status</div>
                        <div className="flex items-center gap-4 text-xs">
                          {gitInfo.uncommittedChanges > 0 ? (
                            <span className="flex items-center gap-1.5" style={{ color: theme.colors.textMain }}>
                              <FileEdit className="w-3 h-3 text-orange-500" />
                              {gitInfo.uncommittedChanges} uncommitted {gitInfo.uncommittedChanges === 1 ? 'change' : 'changes'}
                            </span>
                          ) : (
                            <span className="flex items-center gap-1.5 text-green-500">
                              Working tree clean
                            </span>
                          )}
                        </div>
                      </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div
                className="relative"
                onMouseEnter={() => activeSession.tunnelActive && setTunnelTooltipOpen(true)}
                onMouseLeave={() => setTunnelTooltipOpen(false)}
              >
                <button
                  onClick={() => toggleTunnel(activeSession.id)}
                  className={`flex items-center gap-2 px-2 py-1 rounded text-xs transition-colors ${activeSession.tunnelActive ? 'bg-green-500/20 text-green-500' : 'text-gray-500 hover:bg-gray-800'}`}
                >
                  <Radio className={`w-3 h-3 ${activeSession.tunnelActive ? 'animate-pulse' : ''}`} />
                  {activeSession.tunnelActive ? 'LIVE' : 'OFFLINE'}
                </button>
                {activeSession.tunnelActive && tunnelTooltipOpen && activeSession.tunnelUrl && (
                  <div className="absolute top-full left-0 pt-2 w-80 z-50">
                    <div
                      className="rounded p-3 shadow-xl"
                      style={{
                        backgroundColor: theme.colors.bgSidebar,
                        border: `1px solid ${theme.colors.border}`
                      }}
                    >
                    <div className="text-[10px] uppercase font-bold mb-2" style={{ color: theme.colors.textDim }}>Web Interface URL</div>
                    <div className="flex items-center justify-between gap-2 mb-3">
                      <div className="flex items-center gap-1 text-xs text-green-400 font-mono select-all flex-1 overflow-hidden">
                        <ExternalLink className="w-3 h-3 shrink-0" />
                        <span className="truncate">{activeSession.tunnelUrl}</span>
                      </div>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          copyToClipboard(activeSession.tunnelUrl || '');
                        }}
                        className="p-1.5 rounded hover:bg-white/10 transition-colors shrink-0"
                        title="Copy URL"
                      >
                        <Copy className="w-3 h-3" style={{ color: theme.colors.textDim }} />
                      </button>
                    </div>
                    {activeSession.tunnelPort && (
                      <>
                        <div className="text-[10px] uppercase font-bold mb-2" style={{ color: theme.colors.textDim }}>Port</div>
                        <div className="text-xs font-mono mb-3" style={{ color: theme.colors.textMain }}>
                          {activeSession.tunnelPort}
                        </div>
                      </>
                    )}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (activeSession.tunnelUrl) {
                          window.maestro.shell.openExternal(activeSession.tunnelUrl);
                        }
                      }}
                      className="w-full py-2 rounded text-sm font-medium transition-colors hover:opacity-90"
                      style={{
                        backgroundColor: theme.colors.accent,
                        color: 'white'
                      }}
                    >
                      Open in Browser
                    </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Git Status Widget */}
              <GitStatusWidget
                cwd={activeSession.inputMode === 'terminal' ? (activeSession.shellCwd || activeSession.cwd) : activeSession.cwd}
                isGitRepo={activeSession.isGitRepo}
                theme={theme}
                onViewDiff={handleViewGitDiff}
              />

              {/* Session ID Pill with Overlay */}
              {activeSession.inputMode === 'ai' && activeSession.claudeSessionId && (
                <div className="relative" ref={sessionPillRef}>
                  <button
                    onClick={() => setSessionPillOverlayOpen(!sessionPillOverlayOpen)}
                    className="flex items-center gap-1 text-[10px] font-mono font-bold px-2 py-0.5 rounded-full border cursor-pointer hover:opacity-80 transition-opacity"
                    style={{ backgroundColor: theme.colors.accent + '20', color: theme.colors.accent, borderColor: theme.colors.accent + '30' }}
                    title={namedSessions[activeSession.claudeSessionId] || `Session: ${activeSession.claudeSessionId}`}
                  >
                    {bookmarkedSessions.has(activeSession.claudeSessionId) && (
                      <Star className="w-2.5 h-2.5 fill-current" />
                    )}
                    {namedSessions[activeSession.claudeSessionId] || activeSession.claudeSessionId.split('-')[0].toUpperCase()}
                  </button>

                  {/* Overlay dropdown */}
                  {sessionPillOverlayOpen && (
                    <div
                      className="absolute top-full left-0 mt-1 z-50 rounded-lg border shadow-xl overflow-hidden"
                      style={{
                        backgroundColor: theme.colors.bgSidebar,
                        borderColor: theme.colors.border,
                        minWidth: '200px'
                      }}
                    >
                      {/* Session ID display */}
                      <div
                        className="px-3 py-2 text-[10px] font-mono border-b"
                        style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
                      >
                        {activeSession.claudeSessionId}
                      </div>

                      {/* Rename input */}
                      {sessionPillRenaming ? (
                        <div className="p-2 border-b" style={{ borderColor: theme.colors.border }}>
                          <div className="flex items-center gap-1">
                            <input
                              type="text"
                              value={sessionPillRenameValue}
                              onChange={(e) => setSessionPillRenameValue(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  saveSessionName();
                                } else if (e.key === 'Escape') {
                                  setSessionPillRenaming(false);
                                  setSessionPillRenameValue('');
                                }
                              }}
                              placeholder="Enter name..."
                              autoFocus
                              className="flex-1 px-2 py-1 text-xs rounded border bg-transparent outline-none"
                              style={{
                                borderColor: theme.colors.border,
                                color: theme.colors.textMain
                              }}
                            />
                            <button
                              onClick={saveSessionName}
                              className="p-1 rounded hover:bg-white/10"
                              style={{ color: theme.colors.success }}
                            >
                              <Check className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => {
                                setSessionPillRenaming(false);
                                setSessionPillRenameValue('');
                              }}
                              className="p-1 rounded hover:bg-white/10"
                              style={{ color: theme.colors.error }}
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      ) : null}

                      {/* Actions */}
                      <div className="py-1">
                        {/* Copy */}
                        <button
                          onClick={() => {
                            copySessionIdToClipboard();
                            setSessionPillOverlayOpen(false);
                          }}
                          className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-white/5 transition-colors"
                          style={{ color: theme.colors.textMain }}
                        >
                          <Copy className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
                          Copy Session ID
                          {showSessionIdCopied && (
                            <span className="ml-auto text-[10px]" style={{ color: theme.colors.success }}>Copied!</span>
                          )}
                        </button>

                        {/* Bookmark */}
                        <button
                          onClick={() => {
                            toggleBookmark();
                          }}
                          className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-white/5 transition-colors"
                          style={{ color: theme.colors.textMain }}
                        >
                          <Star
                            className={`w-3.5 h-3.5 ${bookmarkedSessions.has(activeSession.claudeSessionId!) ? 'fill-current' : ''}`}
                            style={{ color: bookmarkedSessions.has(activeSession.claudeSessionId!) ? theme.colors.warning : theme.colors.textDim }}
                          />
                          {bookmarkedSessions.has(activeSession.claudeSessionId!) ? 'Remove Bookmark' : 'Bookmark Session'}
                        </button>

                        {/* Rename */}
                        <button
                          onClick={() => {
                            setSessionPillRenameValue(namedSessions[activeSession.claudeSessionId!] || '');
                            setSessionPillRenaming(true);
                          }}
                          className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-white/5 transition-colors"
                          style={{ color: theme.colors.textMain }}
                        >
                          <Edit2 className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
                          {namedSessions[activeSession.claudeSessionId!] ? 'Rename Session' : 'Name Session'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Center: AUTO Mode Indicator */}
            {isAutoModeActive && (
              <button
                onClick={() => {
                  if (isStopping) return;
                  showConfirmation?.(
                    'Stop the batch run? The current task will complete before stopping.',
                    () => onStopBatchRun?.()
                  );
                }}
                disabled={isStopping}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg font-bold text-sm transition-all ${isStopping ? 'cursor-not-allowed' : 'hover:opacity-90 cursor-pointer'}`}
                style={{
                  backgroundColor: theme.colors.error,
                  color: 'white'
                }}
                title={isStopping ? 'Stopping after current task...' : 'Click to stop batch run'}
              >
                {isStopping ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  <Wand2 className="w-5 h-5" />
                )}
                <span className="uppercase tracking-wider">
                  {isStopping ? 'Stopping...' : 'Auto'}
                </span>
                {batchRunState && (
                  <span className="text-xs opacity-80">
                    {batchRunState.completedTasks}/{batchRunState.totalTasks}
                  </span>
                )}
              </button>
            )}

            <div className="flex items-center gap-3">
              {/* Time Tracker - styled as pill (hidden when panel is narrow) */}
              {showTimeWidget && activeSession.activeTimeMs > 0 && (
                <span
                  className="flex items-center gap-1 text-xs font-mono font-bold px-2 py-0.5 rounded-full border"
                  style={{ borderColor: theme.colors.accent + '30', color: theme.colors.accent, backgroundColor: theme.colors.accent + '10' }}
                  title={`Active time in this session: ${formatActiveTime(activeSession.activeTimeMs)}`}
                >
                  <Clock className="w-3 h-3" />
                  {formatActiveTime(activeSession.activeTimeMs)}
                </span>
              )}

              {/* Cost Tracker - styled as pill (hidden when panel is narrow) */}
              {showCostWidget && activeSession.inputMode === 'ai' && activeSession.usageStats && activeSession.usageStats.totalCostUsd > 0 && (
                <span className="text-xs font-mono font-bold px-2 py-0.5 rounded-full border border-green-500/30 text-green-500 bg-green-500/10">
                  ${activeSession.usageStats.totalCostUsd.toFixed(2)}
                </span>
              )}

              {/* Context Window Widget with Tooltip */}
              <div
                className="flex flex-col items-end mr-2 relative cursor-pointer"
                onMouseEnter={() => setContextTooltipOpen(true)}
                onMouseLeave={() => setContextTooltipOpen(false)}
              >
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

                {/* Context Window Tooltip */}
                {contextTooltipOpen && activeSession.inputMode === 'ai' && activeSession.usageStats && (
                  <div className="absolute top-full right-0 pt-2 w-64 z-50">
                    <div
                      className="border rounded-lg p-3 shadow-xl"
                      style={{ backgroundColor: theme.colors.bgSidebar, borderColor: theme.colors.border }}
                    >
                      <div className="text-[10px] uppercase font-bold mb-3" style={{ color: theme.colors.textDim }}>Context Details</div>

                      <div className="space-y-2">
                        <div className="flex justify-between items-center">
                          <span className="text-xs" style={{ color: theme.colors.textDim }}>Input Tokens</span>
                          <span className="text-xs font-mono" style={{ color: theme.colors.textMain }}>
                            {activeSession.usageStats.inputTokens.toLocaleString()}
                          </span>
                        </div>
                        <div className="flex justify-between items-center">
                          <span className="text-xs" style={{ color: theme.colors.textDim }}>Output Tokens</span>
                          <span className="text-xs font-mono" style={{ color: theme.colors.textMain }}>
                            {activeSession.usageStats.outputTokens.toLocaleString()}
                          </span>
                        </div>
                        <div className="flex justify-between items-center">
                          <span className="text-xs" style={{ color: theme.colors.textDim }}>Cache Read</span>
                          <span className="text-xs font-mono" style={{ color: theme.colors.textMain }}>
                            {activeSession.usageStats.cacheReadInputTokens.toLocaleString()}
                          </span>
                        </div>
                        <div className="flex justify-between items-center">
                          <span className="text-xs" style={{ color: theme.colors.textDim }}>Cache Write</span>
                          <span className="text-xs font-mono" style={{ color: theme.colors.textMain }}>
                            {activeSession.usageStats.cacheCreationInputTokens.toLocaleString()}
                          </span>
                        </div>

                        <div className="border-t pt-2 mt-2" style={{ borderColor: theme.colors.border }}>
                          <div className="flex justify-between items-center">
                            <span className="text-xs font-bold" style={{ color: theme.colors.textDim }}>Context Tokens</span>
                            <span className="text-xs font-mono font-bold" style={{ color: theme.colors.accent }}>
                              {(
                                activeSession.usageStats.inputTokens +
                                activeSession.usageStats.outputTokens
                              ).toLocaleString()}
                            </span>
                          </div>
                          <div className="flex justify-between items-center mt-1">
                            <span className="text-xs font-bold" style={{ color: theme.colors.textDim }}>Context Size</span>
                            <span className="text-xs font-mono font-bold" style={{ color: theme.colors.textMain }}>
                              {activeSession.usageStats.contextWindow.toLocaleString()}
                            </span>
                          </div>
                          <div className="flex justify-between items-center mt-1">
                            <span className="text-xs font-bold" style={{ color: theme.colors.textDim }}>Usage</span>
                            <span
                              className="text-xs font-mono font-bold"
                              style={{ color: getContextColor(activeSession.contextUsage, theme) }}
                            >
                              {activeSession.contextUsage}%
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Agent Sessions Button with Recent Sessions Hover */}
              <div
                className="relative"
                onMouseEnter={() => setSessionsTooltipOpen(true)}
                onMouseLeave={() => setSessionsTooltipOpen(false)}
              >
                <button
                  onClick={() => setAgentSessionsOpen(true)}
                  className="p-2 rounded hover:bg-white/5"
                  title={`Agent Sessions (${shortcuts.agentSessions.keys.join('+').replace('Meta', 'Cmd').replace('Shift', '\u21E7')})`}
                >
                  <List className="w-4 h-4" />
                </button>

                {/* Recent Sessions Hover Overlay */}
                {sessionsTooltipOpen && recentClaudeSessions.length > 0 && (
                  <div
                    className="absolute top-full right-0 mt-1 w-72 rounded-lg border shadow-xl z-50"
                    style={{ backgroundColor: theme.colors.bgSidebar, borderColor: theme.colors.border }}
                    onMouseEnter={() => setSessionsTooltipOpen(true)}
                    onMouseLeave={() => setSessionsTooltipOpen(false)}
                  >
                    <div
                      className="px-3 py-2 text-xs font-bold uppercase border-b"
                      style={{ color: theme.colors.textDim, borderColor: theme.colors.border }}
                    >
                      Recent Sessions
                    </div>
                    <div className="max-h-64 overflow-y-auto scrollbar-thin">
                      {recentClaudeSessions.slice(0, 5).map((session) => (
                        <button
                          key={session.sessionId}
                          onClick={() => {
                            onResumeRecentSession(session.sessionId);
                            setSessionsTooltipOpen(false);
                          }}
                          className="w-full text-left px-3 py-2 hover:bg-white/5 transition-colors flex items-center gap-2"
                        >
                          <Play className="w-3 h-3 shrink-0" style={{ color: theme.colors.accent }} />
                          <div className="flex-1 min-w-0">
                            <div className="text-xs truncate" style={{ color: theme.colors.textMain }}>
                              {session.firstMessage || `Session ${session.sessionId.slice(0, 8)}...`}
                            </div>
                            <div className="text-[10px]" style={{ color: theme.colors.textDim }}>
                              {(() => {
                                const date = new Date(session.timestamp);
                                const now = new Date();
                                const diffMs = now.getTime() - date.getTime();
                                const diffMins = Math.floor(diffMs / 60000);
                                const diffHours = Math.floor(diffMins / 60);
                                if (diffMins < 1) return 'just now';
                                if (diffMins < 60) return `${diffMins}m ago`;
                                if (diffHours < 24) return `${diffHours}h ago`;
                                return date.toLocaleDateString();
                              })()}
                            </div>
                          </div>
                        </button>
                      ))}
                    </div>
                    <div
                      className="px-3 py-2 text-xs border-t text-center cursor-pointer hover:bg-white/5"
                      style={{ color: theme.colors.accent, borderColor: theme.colors.border }}
                      onClick={() => {
                        setAgentSessionsOpen(true);
                        setSessionsTooltipOpen(false);
                      }}
                    >
                      View all sessions →
                    </div>
                  </div>
                )}
              </div>
              {!rightPanelOpen && (
                <button onClick={() => setRightPanelOpen(true)} className="p-2 rounded hover:bg-white/5" title={`Show right panel (${shortcuts.toggleRightPanel.keys.join('+').replace('Meta', 'Cmd')})`}>
                  <Columns className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>

          {/* Show File Preview in main area when open, otherwise show terminal output and input */}
          {previewFile ? (
            <div className="flex-1 overflow-hidden">
              <FilePreview
                file={previewFile}
                onClose={() => {
                  setPreviewFile(null);
                  setActiveFocus('right');
                  setTimeout(() => {
                    // If file tree filter is open, focus it; otherwise focus the file tree container
                    if (fileTreeFilterOpen && fileTreeFilterInputRef.current) {
                      fileTreeFilterInputRef.current.focus();
                    } else if (fileTreeContainerRef.current) {
                      fileTreeContainerRef.current.focus();
                    }
                  }, 0);
                }}
                theme={theme}
                markdownRawMode={markdownRawMode}
                setMarkdownRawMode={setMarkdownRawMode}
                shortcuts={shortcuts}
              />
            </div>
          ) : (
            <>
              {/* Logs Area */}
              <TerminalOutput
                ref={terminalOutputRef}
                session={activeSession}
                theme={theme}
                fontFamily={props.fontFamily}
                activeFocus={activeFocus}
                outputSearchOpen={outputSearchOpen}
                outputSearchQuery={outputSearchQuery}
                setOutputSearchOpen={setOutputSearchOpen}
                setOutputSearchQuery={setOutputSearchQuery}
                setActiveFocus={setActiveFocus}
                setLightboxImage={setLightboxImage}
                inputRef={inputRef}
                logsEndRef={logsEndRef}
                maxOutputLines={maxOutputLines}
                onDeleteLog={props.onDeleteLog}
                onRemoveQueuedMessage={onRemoveQueuedMessage}
                onInterrupt={handleInterrupt}
                audioFeedbackCommand={props.audioFeedbackCommand}
              />

              {/* Input Area */}
              <InputArea
                session={activeSession}
                theme={theme}
                inputValue={inputValue}
                setInputValue={setInputValue}
                enterToSend={activeSession.inputMode === 'terminal' ? enterToSendTerminal : enterToSendAI}
                setEnterToSend={activeSession.inputMode === 'terminal' ? setEnterToSendTerminal : setEnterToSendAI}
                stagedImages={stagedImages}
                setStagedImages={setStagedImages}
                setLightboxImage={setLightboxImage}
                commandHistoryOpen={commandHistoryOpen}
                setCommandHistoryOpen={setCommandHistoryOpen}
                commandHistoryFilter={commandHistoryFilter}
                setCommandHistoryFilter={setCommandHistoryFilter}
                commandHistorySelectedIndex={commandHistorySelectedIndex}
                setCommandHistorySelectedIndex={setCommandHistorySelectedIndex}
                slashCommandOpen={slashCommandOpen}
                setSlashCommandOpen={setSlashCommandOpen}
                slashCommands={slashCommands}
                selectedSlashCommandIndex={selectedSlashCommandIndex}
                setSelectedSlashCommandIndex={setSelectedSlashCommandIndex}
                inputRef={inputRef}
                handleInputKeyDown={handleInputKeyDown}
                handlePaste={handlePaste}
                handleDrop={handleDrop}
                toggleInputMode={toggleInputMode}
                processInput={processInput}
                handleInterrupt={handleInterrupt}
                onInputFocus={handleInputFocus}
                isAutoModeActive={isAutoModeActive}
              />
            </>
          )}

        </div>

        {/* Session ID Copied Notification Toast */}
        {showSessionIdCopied && (
          <div
            className="fixed top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 px-6 py-4 rounded-lg shadow-2xl text-base font-bold animate-in fade-in zoom-in-95 duration-200 z-50"
            style={{
              backgroundColor: theme.colors.accent,
              color: '#FFFFFF',
              textShadow: '0 1px 2px rgba(0, 0, 0, 0.3)'
            }}
          >
            Session ID Copied to Clipboard
          </div>
        )}
      </ErrorBoundary>
    </>
  );
}
