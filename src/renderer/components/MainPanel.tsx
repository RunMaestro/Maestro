import React, { useState, useEffect, useRef, useCallback, useMemo, forwardRef, useImperativeHandle } from 'react';
import { Wand2, ExternalLink, Columns, Copy, Loader2, GitBranch, ArrowUp, ArrowDown, FileEdit, List, AlertCircle, X } from 'lucide-react';
import { LogViewer } from './LogViewer';
import { TerminalOutput } from './TerminalOutput';
import { InputArea } from './InputArea';
import { FilePreview } from './FilePreview';
import { ErrorBoundary } from './ErrorBoundary';
import { GitStatusWidget } from './GitStatusWidget';
import { AgentSessionsBrowser } from './AgentSessionsBrowser';
import { TabBar } from './TabBar';
import { gitService } from '../services/git';
import { useGitStatus } from '../contexts/GitStatusContext';
import { getActiveTab, getBusyTabs } from '../utils/tabHelpers';
import { formatShortcutKeys } from '../utils/shortcutFormatter';
import { useAgentCapabilities } from '../hooks/useAgentCapabilities';
import type { Session, Theme, Shortcut, FocusArea, BatchRunState } from '../types';

interface SlashCommand {
  command: string;
  description: string;
}

/**
 * Handle for MainPanel component to expose methods to parent.
 */
export interface MainPanelHandle {
  /** Refresh git info (branch, ahead/behind, uncommitted changes) */
  refreshGitInfo: () => Promise<void>;
}

interface MainPanelProps {
  // State
  logViewerOpen: boolean;
  agentSessionsOpen: boolean;
  activeAgentSessionId: string | null;
  activeSession: Session | null;
  sessions: Session[]; // All sessions for InputArea's ThinkingStatusPill
  theme: Theme;
  fontFamily: string;
  isMobileLandscape?: boolean;
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
  // Tab completion props
  tabCompletionOpen?: boolean;
  tabCompletionSuggestions?: import('../hooks/useTabCompletion').TabCompletionSuggestion[];
  selectedTabCompletionIndex?: number;
  tabCompletionFilter?: import('../hooks/useTabCompletion').TabCompletionFilter;
  // @ mention completion props (AI mode)
  atMentionOpen?: boolean;
  atMentionFilter?: string;
  atMentionStartIndex?: number;
  atMentionSuggestions?: Array<{ value: string; type: 'file' | 'folder'; displayText: string; fullPath: string }>;
  selectedAtMentionIndex?: number;
  previewFile: { name: string; content: string; path: string } | null;
  markdownEditMode: boolean;
  shortcuts: Record<string, Shortcut>;
  rightPanelOpen: boolean;
  maxOutputLines: number;
  gitDiffPreview: string | null;
  fileTreeFilterOpen: boolean;
  logLevel?: string; // Current log level setting for LogViewer
  logViewerSelectedLevels: string[]; // Persisted filter selections for LogViewer
  setLogViewerSelectedLevels: (levels: string[]) => void;

  // Setters
  setGitDiffPreview: (preview: string | null) => void;
  setLogViewerOpen: (open: boolean) => void;
  setAgentSessionsOpen: (open: boolean) => void;
  setActiveAgentSessionId: (id: string | null) => void;
  onResumeAgentSession: (agentSessionId: string, messages: import('../types').LogEntry[], sessionName?: string, starred?: boolean, usageStats?: import('../types').UsageStats) => void;
  onNewAgentSession: () => void;
  setActiveFocus: (focus: FocusArea) => void;
  setOutputSearchOpen: (open: boolean) => void;
  setOutputSearchQuery: (query: string) => void;
  setInputValue: (value: string) => void;
  setEnterToSendAI: (value: boolean) => void;
  setEnterToSendTerminal: (value: boolean) => void;
  setStagedImages: (images: string[]) => void;
  setLightboxImage: (image: string | null, contextImages?: string[], source?: 'staged' | 'history') => void;
  setCommandHistoryOpen: (open: boolean) => void;
  setCommandHistoryFilter: (filter: string) => void;
  setCommandHistorySelectedIndex: (index: number) => void;
  setSlashCommandOpen: (open: boolean) => void;
  setSelectedSlashCommandIndex: (index: number) => void;
  // Tab completion setters
  setTabCompletionOpen?: (open: boolean) => void;
  setSelectedTabCompletionIndex?: (index: number) => void;
  setTabCompletionFilter?: (filter: import('../hooks/useTabCompletion').TabCompletionFilter) => void;
  // @ mention completion setters
  setAtMentionOpen?: (open: boolean) => void;
  setAtMentionFilter?: (filter: string) => void;
  setAtMentionStartIndex?: (index: number) => void;
  setSelectedAtMentionIndex?: (index: number) => void;
  setPreviewFile: (file: { name: string; content: string; path: string } | null) => void;
  setMarkdownEditMode: (mode: boolean) => void;
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
  toggleInputMode: () => void;
  processInput: () => void;
  handleInterrupt: () => void;
  handleInputKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  handlePaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  handleDrop: (e: React.DragEvent<HTMLDivElement>) => void;
  getContextColor: (usage: number, theme: Theme) => string;
  setActiveSessionId: (id: string) => void;
  onDeleteLog?: (logId: string) => void;
  onRemoveQueuedItem?: (itemId: string) => void;
  onOpenQueueBrowser?: () => void;

  // Auto mode props
  batchRunState?: BatchRunState;  // For display (may be from any session with active batch)
  currentSessionBatchState?: BatchRunState | null;  // For current session only (input highlighting)
  onStopBatchRun?: () => void;
  showConfirmation?: (message: string, onConfirm: () => void) => void;

  // TTS settings
  audioFeedbackCommand?: string;

  // Tab management for AI sessions
  onTabSelect?: (tabId: string) => void;
  onTabClose?: (tabId: string) => void;
  onNewTab?: () => void;
  onTabRename?: (tabId: string, newName: string) => void;
  onRequestTabRename?: (tabId: string) => void;
  onTabReorder?: (fromIndex: number, toIndex: number) => void;
  onCloseOtherTabs?: (tabId: string) => void;
  onTabStar?: (tabId: string, starred: boolean) => void;
  onTabMarkUnread?: (tabId: string) => void;
  onUpdateTabByClaudeSessionId?: (agentSessionId: string, updates: { name?: string | null; starred?: boolean }) => void;
  onToggleTabReadOnlyMode?: () => void;
  onToggleTabSaveToHistory?: () => void;
  showUnreadOnly?: boolean;
  onToggleUnreadFilter?: () => void;
  onOpenTabSearch?: () => void;
  // Scroll position persistence
  onScrollPositionChange?: (scrollTop: number) => void;
  // Scroll bottom state change handler (for hasUnread logic)
  onAtBottomChange?: (isAtBottom: boolean) => void;
  // Input blur handler for persisting AI input state
  onInputBlur?: () => void;
  // Prompt composer modal
  onOpenPromptComposer?: () => void;
  // Replay a user message (AI mode)
  onReplayMessage?: (text: string, images?: string[]) => void;
  // File tree for linking file references in AI responses
  fileTree?: import('../types/fileTree').FileNode[];
  // Callback when a file link is clicked in AI response
  onFileClick?: (relativePath: string) => void;
  // File preview navigation
  canGoBack?: boolean;
  canGoForward?: boolean;
  onNavigateBack?: () => void;
  onNavigateForward?: () => void;
  backHistory?: {name: string; content: string; path: string}[];
  forwardHistory?: {name: string; content: string; path: string}[];
  currentHistoryIndex?: number;
  onNavigateToIndex?: (index: number) => void;

  // Agent error handling
  onClearAgentError?: () => void;
  onShowAgentErrorModal?: () => void;
  // Flash notification callback
  showFlashNotification?: (message: string) => void;
}

export const MainPanel = forwardRef<MainPanelHandle, MainPanelProps>(function MainPanel(props, ref) {
  const {
    logViewerOpen, agentSessionsOpen, activeAgentSessionId, activeSession, sessions, theme, activeFocus, outputSearchOpen, outputSearchQuery,
    inputValue, enterToSendAI, enterToSendTerminal, stagedImages, commandHistoryOpen, commandHistoryFilter,
    commandHistorySelectedIndex, slashCommandOpen, slashCommands, selectedSlashCommandIndex,
    tabCompletionOpen, tabCompletionSuggestions, selectedTabCompletionIndex, tabCompletionFilter,
    setTabCompletionOpen, setSelectedTabCompletionIndex, setTabCompletionFilter,
    atMentionOpen, atMentionFilter, atMentionStartIndex, atMentionSuggestions, selectedAtMentionIndex,
    setAtMentionOpen, setAtMentionFilter, setAtMentionStartIndex, setSelectedAtMentionIndex,
    previewFile, markdownEditMode, shortcuts, rightPanelOpen, maxOutputLines, gitDiffPreview,
    fileTreeFilterOpen, logLevel, setGitDiffPreview, setLogViewerOpen, setAgentSessionsOpen, setActiveAgentSessionId,
    onResumeAgentSession, onNewAgentSession, setActiveFocus, setOutputSearchOpen, setOutputSearchQuery,
    setInputValue, setEnterToSendAI, setEnterToSendTerminal, setStagedImages, setLightboxImage, setCommandHistoryOpen,
    setCommandHistoryFilter, setCommandHistorySelectedIndex, setSlashCommandOpen,
    setSelectedSlashCommandIndex, setPreviewFile, setMarkdownEditMode,
    setAboutModalOpen, setRightPanelOpen, setGitLogOpen, inputRef, logsEndRef, terminalOutputRef,
    fileTreeContainerRef, fileTreeFilterInputRef, toggleInputMode, processInput, handleInterrupt,
    handleInputKeyDown, handlePaste, handleDrop, getContextColor, setActiveSessionId,
    batchRunState, currentSessionBatchState, onStopBatchRun, showConfirmation, onRemoveQueuedItem, onOpenQueueBrowser,
    isMobileLandscape = false,
    showFlashNotification
  } = props;

  // isCurrentSessionAutoMode: THIS session has active batch run (for all UI indicators)
  const isCurrentSessionAutoMode = currentSessionBatchState?.isRunning || false;
  const isCurrentSessionStopping = currentSessionBatchState?.isStopping || false;

  // Context window tooltip hover state
  const [contextTooltipOpen, setContextTooltipOpen] = useState(false);
  const contextTooltipTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Git pill tooltip hover state
  const [gitTooltipOpen, setGitTooltipOpen] = useState(false);
  const gitTooltipTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Panel width for responsive hiding of widgets
  const [panelWidth, setPanelWidth] = useState(Infinity); // Start with Infinity so widgets show by default
  const headerRef = useRef<HTMLDivElement>(null);
  const [configuredContextWindow, setConfiguredContextWindow] = useState(0);

  // Extract tab handlers from props
  const { onTabSelect, onTabClose, onNewTab, onTabRename, onRequestTabRename, onTabReorder, onCloseOtherTabs, onTabStar, onTabMarkUnread, showUnreadOnly, onToggleUnreadFilter, onOpenTabSearch } = props;

  // Get the active tab for header display
  // The header should show the active tab's data (UUID, name, cost, context), not session-level data
  // Directly find the active tab without memoization to ensure it updates on every render
  const activeTab = activeSession?.aiTabs?.find(tab => tab.id === activeSession.activeTabId)
    ?? activeSession?.aiTabs?.[0]
    ?? null;
  const activeTabError = activeTab?.agentError;

  // Resolve the configured context window from session override or agent settings.
  useEffect(() => {
    let isActive = true;

    const loadContextWindow = async () => {
      if (!activeSession) {
        if (isActive) setConfiguredContextWindow(0);
        return;
      }

      if (typeof activeSession.customContextWindow === 'number' && activeSession.customContextWindow > 0) {
        if (isActive) setConfiguredContextWindow(activeSession.customContextWindow);
        return;
      }

      try {
        const config = await window.maestro.agents.getConfig(activeSession.toolType);
        const value = typeof config?.contextWindow === 'number' ? config.contextWindow : 0;
        if (isActive) setConfiguredContextWindow(value);
      } catch (error) {
        console.error('Failed to load agent context window setting', error);
        if (isActive) setConfiguredContextWindow(0);
      }
    };

    loadContextWindow();
    return () => {
      isActive = false;
    };
  }, [activeSession?.toolType, activeSession?.customContextWindow]);

  const activeTabContextWindow = useMemo(() => {
    const configured = configuredContextWindow;
    const reported = activeTab?.usageStats?.contextWindow ?? 0;
    return configured > 0 ? configured : reported;
  }, [configuredContextWindow, activeTab?.usageStats?.contextWindow]);

  // Compute context usage percentage from active tab's usage stats
  const activeTabContextUsage = useMemo(() => {
    if (!activeTab?.usageStats) return 0;
    const { inputTokens, outputTokens } = activeTab.usageStats;
    if (!activeTabContextWindow || activeTabContextWindow === 0) return 0;
    const contextTokens = inputTokens + outputTokens;
    return Math.min(Math.round((contextTokens / activeTabContextWindow) * 100), 100);
  }, [activeTab?.usageStats, activeTabContextWindow]);

  // PERF: Track panel width for responsive widget hiding with throttled updates
  useEffect(() => {
    const header = headerRef.current;
    if (!header) return;

    // Get initial width immediately
    setPanelWidth(header.offsetWidth);

    // Throttle resize updates to avoid layout thrashing during animations
    let rafId: number | null = null;
    let pendingWidth: number | null = null;

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        pendingWidth = entry.contentRect.width;
      }
      // Use requestAnimationFrame to batch updates
      if (rafId === null && pendingWidth !== null) {
        rafId = requestAnimationFrame(() => {
          if (pendingWidth !== null) {
            setPanelWidth(pendingWidth);
          }
          rafId = null;
        });
      }
    });

    resizeObserver.observe(header);
    return () => {
      resizeObserver.disconnect();
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
    };
  }, []);

  // Responsive breakpoints for hiding widgets
  const showCostWidget = panelWidth > 500;

  // Git status from centralized context (replaces local polling)
  // The context handles polling for all sessions and provides detailed data for the active session
  const { getStatus, refreshGitStatus } = useGitStatus();
  const gitStatusData = activeSession ? getStatus(activeSession.id) : undefined;

  // Derive gitInfo format from context data for backward compatibility with existing UI code
  const gitInfo = gitStatusData && activeSession?.isGitRepo ? {
    branch: gitStatusData.branch || '',
    remote: gitStatusData.remote || '',
    behind: gitStatusData.behind,
    ahead: gitStatusData.ahead,
    uncommittedChanges: gitStatusData.fileCount,
  } : null;

  // Copy notification state (centered flash notice)
  const [copyNotification, setCopyNotification] = useState<string | null>(null);

  // Get agent capabilities for conditional feature rendering
  const { hasCapability } = useAgentCapabilities(activeSession?.toolType);

  // Expose methods to parent via ref
  useImperativeHandle(ref, () => ({
    refreshGitInfo: refreshGitStatus
  }), [refreshGitStatus]);

  // Cleanup hover timeouts on unmount
  useEffect(() => {
    return () => {
      if (gitTooltipTimeout.current) {
        clearTimeout(gitTooltipTimeout.current);
      }
      if (contextTooltipTimeout.current) {
        clearTimeout(contextTooltipTimeout.current);
      }
    };
  }, []);

  // Handler for input focus - select session in sidebar
  // Memoized to avoid recreating on every render
  const handleInputFocus = useCallback(() => {
    if (activeSession) {
      setActiveSessionId(activeSession.id);
      setActiveFocus('main');
    }
  }, [activeSession, setActiveSessionId, setActiveFocus]);

  // Memoized session click handler for InputArea's ThinkingStatusPill
  // Avoids creating new function reference on every render
  const handleSessionClick = useCallback((sessionId: string, tabId?: string) => {
    setActiveSessionId(sessionId);
    if (tabId && onTabSelect) {
      onTabSelect(tabId);
    }
  }, [setActiveSessionId, onTabSelect]);

  // Handler to view git diff
  const handleViewGitDiff = async () => {
    if (!activeSession || !activeSession.isGitRepo) return;

    const cwd = activeSession.inputMode === 'terminal' ? (activeSession.shellCwd || activeSession.cwd) : activeSession.cwd;
    const diff = await gitService.getDiff(cwd);

    if (diff.diff) {
      setGitDiffPreview(diff.diff);
    }
  };

  // Copy to clipboard handler with flash notification
  const copyToClipboard = async (text: string, message?: string) => {
    try {
      await navigator.clipboard.writeText(text);
      // Show centered flash notification
      setCopyNotification(message || 'Copied to Clipboard');
      setTimeout(() => setCopyNotification(null), 2000);
    } catch (err) {
      console.error('Failed to copy to clipboard:', err);
    }
  };

  // Show log viewer
  if (logViewerOpen) {
    return (
      <div className="flex-1 flex flex-col min-w-0 relative" style={{ backgroundColor: theme.colors.bgMain }}>
        <LogViewer
          theme={theme}
          onClose={() => setLogViewerOpen(false)}
          logLevel={logLevel}
          savedSelectedLevels={props.logViewerSelectedLevels}
          onSelectedLevelsChange={props.setLogViewerSelectedLevels}
        />
      </div>
    );
  }

  // Show agent sessions browser (only if agent supports session storage)
  if (agentSessionsOpen && hasCapability('supportsSessionStorage')) {
    return (
      <div className="flex-1 flex flex-col min-w-0 relative" style={{ backgroundColor: theme.colors.bgMain }}>
        <AgentSessionsBrowser
          theme={theme}
          activeSession={activeSession || undefined}
          activeAgentSessionId={activeAgentSessionId}
          onClose={() => setAgentSessionsOpen(false)}
          onResumeSession={onResumeAgentSession}
          onNewSession={onNewAgentSession}
          onUpdateTab={props.onUpdateTabByClaudeSessionId}
        />
      </div>
    );
  }

  // Show empty state when no active session
  if (!activeSession) {
    return (
      <div
        className="flex-1 flex flex-col items-center justify-center min-w-0 relative opacity-30"
        style={{ backgroundColor: theme.colors.bgMain }}
      >
        <Wand2 className="w-16 h-16 mb-4" style={{ color: theme.colors.textDim }} />
        <p className="text-sm" style={{ color: theme.colors.textDim }}>No agents. Create one to get started.</p>
      </div>
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
          {/* Top Bar (hidden in mobile landscape for focused reading) */}
          {!isMobileLandscape && (
          <div ref={headerRef} className="h-16 border-b flex items-center justify-between px-6 shrink-0" style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }} data-tour="header-controls">
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2 text-sm font-medium">
                {activeSession.name}
                <div
                  className="relative"
                  onMouseEnter={() => {
                    if (!activeSession.isGitRepo) return;
                    // Clear any pending close timeout
                    if (gitTooltipTimeout.current) {
                      clearTimeout(gitTooltipTimeout.current);
                      gitTooltipTimeout.current = null;
                    }
                    setGitTooltipOpen(true);
                  }}
                  onMouseLeave={() => {
                    // Delay closing to allow mouse to reach the dropdown
                    gitTooltipTimeout.current = setTimeout(() => {
                      setGitTooltipOpen(false);
                    }, 150);
                  }}
                >
                  <span
                    className={`flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full border cursor-pointer ${activeSession.isGitRepo ? 'border-orange-500/30 text-orange-500 bg-orange-500/10 hover:bg-orange-500/20' : 'border-blue-500/30 text-blue-500 bg-blue-500/10'}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (activeSession.isGitRepo) {
                        refreshGitStatus(); // Refresh git info immediately on click
                        setGitLogOpen(true);
                      }
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
                    <>
                      {/* Invisible bridge to prevent hover gap */}
                      <div
                        className="absolute left-0 right-0 h-3 pointer-events-auto"
                        style={{ top: '100%' }}
                        onMouseEnter={() => {
                          if (gitTooltipTimeout.current) {
                            clearTimeout(gitTooltipTimeout.current);
                            gitTooltipTimeout.current = null;
                          }
                          setGitTooltipOpen(true);
                        }}
                      />
                      <div
                        className="absolute top-full left-0 pt-2 w-80 z-50 pointer-events-auto"
                        onMouseEnter={() => {
                          if (gitTooltipTimeout.current) {
                            clearTimeout(gitTooltipTimeout.current);
                            gitTooltipTimeout.current = null;
                          }
                          setGitTooltipOpen(true);
                        }}
                        onMouseLeave={() => {
                          gitTooltipTimeout.current = setTimeout(() => {
                            setGitTooltipOpen(false);
                          }, 150);
                        }}
                      >
                        <div
                          className="rounded shadow-xl"
                          style={{
                            backgroundColor: theme.colors.bgSidebar,
                            border: `1px solid ${theme.colors.border}`
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
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                copyToClipboard(gitInfo.branch, `"${gitInfo.branch}" copied to clipboard`);
                              }}
                              className="p-1 rounded hover:bg-white/10 transition-colors shrink-0"
                              title="Copy branch name"
                            >
                              <Copy className="w-3 h-3" style={{ color: theme.colors.textDim }} />
                            </button>
                          </div>
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
                    </>
                  )}
                </div>
              </div>

              {/* Git Status Widget */}
              <GitStatusWidget
                sessionId={activeSession.id}
                isGitRepo={activeSession.isGitRepo}
                theme={theme}
                onViewDiff={handleViewGitDiff}
              />

            </div>

            {/* Center: AUTO Mode Indicator - only show for current session */}
            {isCurrentSessionAutoMode && (
              <button
                onClick={() => {
                  if (isCurrentSessionStopping) return;
                  // Call onStopBatchRun directly - it handles its own confirmation modal
                  onStopBatchRun?.();
                }}
                disabled={isCurrentSessionStopping}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg font-bold text-sm transition-all ${isCurrentSessionStopping ? 'cursor-not-allowed' : 'hover:opacity-90 cursor-pointer'}`}
                style={{
                  backgroundColor: theme.colors.error,
                  color: 'white'
                }}
                title={isCurrentSessionStopping ? 'Stopping after current task...' : 'Click to stop batch run'}
              >
                {isCurrentSessionStopping ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  <Wand2 className="w-5 h-5" />
                )}
                <span className="uppercase tracking-wider">
                  {isCurrentSessionStopping ? 'Stopping...' : 'Auto'}
                </span>
                {currentSessionBatchState && (
                  <span className="text-xs opacity-80">
                    {currentSessionBatchState.completedTasks}/{currentSessionBatchState.totalTasks}
                  </span>
                )}
                {currentSessionBatchState?.worktreeActive && (
                  <GitBranch className="w-4 h-4 ml-1" title={`Worktree: ${currentSessionBatchState.worktreeBranch || 'active'}`} />
                )}
              </button>
            )}

            <div className="flex items-center gap-3 min-w-[200px] justify-end">
              {/* Session UUID Pill - click to copy full UUID, left-most of session stats */}
              {activeSession.inputMode === 'ai' && activeTab?.agentSessionId && hasCapability('supportsSessionId') && (
                <button
                  className="text-[10px] font-mono font-bold px-2 py-0.5 rounded-full border transition-colors hover:opacity-80"
                  style={{ backgroundColor: theme.colors.accent + '20', color: theme.colors.accent, borderColor: theme.colors.accent + '30' }}
                  title={activeTab.name ? `${activeTab.name}\nClick to copy: ${activeTab.agentSessionId}` : `Click to copy: ${activeTab.agentSessionId}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    copyToClipboard(activeTab.agentSessionId!, 'Session ID Copied to Clipboard');
                  }}
                >
                  {activeTab.agentSessionId.split('-')[0].toUpperCase()}
                </button>
              )}


              {/* Cost Tracker - styled as pill (hidden when panel is narrow or agent doesn't support cost tracking) - shows active tab's cost */}
              {showCostWidget && activeSession.inputMode === 'ai' && (activeTab?.agentSessionId || activeTab?.usageStats) && hasCapability('supportsCostTracking') && (
                <span className="text-xs font-mono font-bold px-2 py-0.5 rounded-full border border-green-500/30 text-green-500 bg-green-500/10">
                  ${(activeTab?.usageStats?.totalCostUsd ?? 0).toFixed(2)}
                </span>
              )}

              {/* Context Window Widget with Tooltip - only show when context window is configured and agent supports usage stats */}
              {activeSession.inputMode === 'ai' && (activeTab?.agentSessionId || activeTab?.usageStats) && hasCapability('supportsUsageStats') && activeTabContextWindow > 0 && (
              <div
                className="flex flex-col items-end mr-2 relative cursor-pointer"
                onMouseEnter={() => {
                  // Clear any pending close timeout
                  if (contextTooltipTimeout.current) {
                    clearTimeout(contextTooltipTimeout.current);
                    contextTooltipTimeout.current = null;
                  }
                  setContextTooltipOpen(true);
                }}
                onMouseLeave={() => {
                  // Delay closing to allow mouse to reach the dropdown
                  contextTooltipTimeout.current = setTimeout(() => {
                    setContextTooltipOpen(false);
                  }, 150);
                }}
              >
                <span className="text-[10px] font-bold uppercase" style={{ color: theme.colors.textDim }}>Context Window</span>
                <div className="w-24 h-1.5 rounded-full mt-1 overflow-hidden" style={{ backgroundColor: theme.colors.border }}>
                  <div
                    className="h-full transition-all duration-500 ease-out"
                    style={{
                      width: `${activeTabContextUsage}%`,
                      backgroundColor: getContextColor(activeTabContextUsage, theme)
                    }}
                  />
                </div>

                {/* Context Window Tooltip */}
                {contextTooltipOpen && activeSession.inputMode === 'ai' && (
                  <>
                    {/* Invisible bridge to prevent hover gap */}
                    <div
                      className="absolute left-0 right-0 h-3 pointer-events-auto"
                      style={{ top: '100%' }}
                      onMouseEnter={() => {
                        if (contextTooltipTimeout.current) {
                          clearTimeout(contextTooltipTimeout.current);
                          contextTooltipTimeout.current = null;
                        }
                        setContextTooltipOpen(true);
                      }}
                    />
                    <div
                      className="absolute top-full right-0 pt-2 w-64 z-50 pointer-events-auto"
                      onMouseEnter={() => {
                        if (contextTooltipTimeout.current) {
                          clearTimeout(contextTooltipTimeout.current);
                          contextTooltipTimeout.current = null;
                        }
                        setContextTooltipOpen(true);
                      }}
                      onMouseLeave={() => {
                        contextTooltipTimeout.current = setTimeout(() => {
                          setContextTooltipOpen(false);
                        }, 150);
                      }}
                    >
                      <div
                        className="border rounded-lg p-3 shadow-xl"
                        style={{ backgroundColor: theme.colors.bgSidebar, borderColor: theme.colors.border }}
                      >
                      <div className="text-[10px] uppercase font-bold mb-3" style={{ color: theme.colors.textDim }}>Context Details</div>

                      <div className="space-y-2">
                        <div className="flex justify-between items-center">
                          <span className="text-xs" style={{ color: theme.colors.textDim }}>Input Tokens</span>
                          <span className="text-xs font-mono" style={{ color: theme.colors.textMain }}>
                            {(activeTab?.usageStats?.inputTokens ?? 0).toLocaleString()}
                          </span>
                        </div>
                        <div className="flex justify-between items-center">
                          <span className="text-xs" style={{ color: theme.colors.textDim }}>Output Tokens</span>
                          <span className="text-xs font-mono" style={{ color: theme.colors.textMain }}>
                            {(activeTab?.usageStats?.outputTokens ?? 0).toLocaleString()}
                          </span>
                        </div>
                        {/* Reasoning tokens - only shown for agents that report them (e.g., Codex o3/o4-mini) */}
                        {(activeTab?.usageStats?.reasoningTokens ?? 0) > 0 && (
                          <div className="flex justify-between items-center">
                            <span className="text-xs" style={{ color: theme.colors.textDim }}>
                              Reasoning Tokens
                              <span className="ml-1 text-[10px] opacity-60">(in output)</span>
                            </span>
                            <span className="text-xs font-mono" style={{ color: theme.colors.textMain }}>
                              {(activeTab?.usageStats?.reasoningTokens ?? 0).toLocaleString()}
                            </span>
                          </div>
                        )}
                        <div className="flex justify-between items-center">
                          <span className="text-xs" style={{ color: theme.colors.textDim }}>Cache Read</span>
                          <span className="text-xs font-mono" style={{ color: theme.colors.textMain }}>
                            {(activeTab?.usageStats?.cacheReadInputTokens ?? 0).toLocaleString()}
                          </span>
                        </div>
                        <div className="flex justify-between items-center">
                          <span className="text-xs" style={{ color: theme.colors.textDim }}>Cache Write</span>
                          <span className="text-xs font-mono" style={{ color: theme.colors.textMain }}>
                            {(activeTab?.usageStats?.cacheCreationInputTokens ?? 0).toLocaleString()}
                          </span>
                        </div>

                        {/* Context usage section - only shown when contextWindow is configured */}
                        {activeTabContextWindow > 0 && (
                          <div className="border-t pt-2 mt-2" style={{ borderColor: theme.colors.border }}>
                            <div className="flex justify-between items-center">
                              <span className="text-xs font-bold" style={{ color: theme.colors.textDim }}>Context Tokens</span>
                              <span className="text-xs font-mono font-bold" style={{ color: theme.colors.accent }}>
                                {(
                                  (activeTab?.usageStats?.inputTokens ?? 0) +
                                  (activeTab?.usageStats?.outputTokens ?? 0)
                                ).toLocaleString()}
                              </span>
                            </div>
                            <div className="flex justify-between items-center mt-1">
                              <span className="text-xs font-bold" style={{ color: theme.colors.textDim }}>Context Size</span>
                              <span className="text-xs font-mono font-bold" style={{ color: theme.colors.textMain }}>
                                {activeTabContextWindow.toLocaleString()}
                              </span>
                            </div>
                            <div className="flex justify-between items-center mt-1">
                              <span className="text-xs font-bold" style={{ color: theme.colors.textDim }}>Usage</span>
                              <span
                                className="text-xs font-mono font-bold"
                                style={{ color: getContextColor(activeTabContextUsage, theme) }}
                              >
                                {activeTabContextUsage}%
                              </span>
                            </div>
                          </div>
                        )}
                      </div>
                      </div>
                    </div>
                  </>
                )}
              </div>
              )}

              {/* Agent Sessions Button - only show if agent supports session storage */}
              {hasCapability('supportsSessionStorage') && (
                <button
                  onClick={() => {
                    setActiveAgentSessionId(null);
                    setAgentSessionsOpen(true);
                  }}
                  className="p-2 rounded hover:bg-white/5"
                  title={`Agent Sessions (${shortcuts.agentSessions?.keys?.join('+').replace('Meta', 'Cmd').replace('Shift', '⇧') || 'Cmd+⇧+L'})`}
                >
                  <List className="w-4 h-4" style={{ color: theme.colors.textDim }} />
                </button>
              )}

              {!rightPanelOpen && (
                <button onClick={() => setRightPanelOpen(true)} className="p-2 rounded hover:bg-white/5" title={`Show right panel (${formatShortcutKeys(shortcuts.toggleRightPanel.keys)})`}>
                  <Columns className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>
          )}

          {/* Tab Bar - only shown in AI mode when we have tabs (hidden during file preview) */}
          {!previewFile && activeSession.inputMode === 'ai' && activeSession.aiTabs && activeSession.aiTabs.length > 0 && onTabSelect && onTabClose && onNewTab && (
            <TabBar
              tabs={activeSession.aiTabs}
              activeTabId={activeSession.activeTabId}
              theme={theme}
              onTabSelect={onTabSelect}
              onTabClose={onTabClose}
              onNewTab={onNewTab}
              onTabRename={onTabRename}
              onRequestRename={onRequestTabRename}
              onTabReorder={onTabReorder}
              onCloseOthers={onCloseOtherTabs}
              onTabStar={onTabStar}
              onTabMarkUnread={onTabMarkUnread}
              showUnreadOnly={showUnreadOnly}
              onToggleUnreadFilter={onToggleUnreadFilter}
              onOpenTabSearch={onOpenTabSearch}
            />
          )}

          {/* Agent Error Banner */}
          {activeTabError && (
            <div
              className="flex items-center gap-3 px-4 py-2 border-b shrink-0"
              style={{
                backgroundColor: theme.colors.error + '15',
                borderColor: theme.colors.error + '40',
              }}
            >
              <AlertCircle className="w-4 h-4 shrink-0" style={{ color: theme.colors.error }} />
              <div className="flex-1 min-w-0">
                <span className="text-sm font-medium" style={{ color: theme.colors.error }}>
                  {activeTabError.message}
                </span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {props.onShowAgentErrorModal && (
                  <button
                    onClick={props.onShowAgentErrorModal}
                    className="px-2 py-1 text-xs font-medium rounded hover:opacity-80 transition-opacity"
                    style={{
                      backgroundColor: theme.colors.error,
                      color: '#ffffff',
                    }}
                  >
                    View Details
                  </button>
                )}
                {props.onClearAgentError && activeTabError.recoverable && (
                  <button
                    onClick={props.onClearAgentError}
                    className="p-1 rounded hover:bg-white/10 transition-colors"
                    title="Dismiss error"
                  >
                    <X className="w-4 h-4" style={{ color: theme.colors.error }} />
                  </button>
                )}
              </div>
            </div>
          )}

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
                markdownEditMode={markdownEditMode}
                setMarkdownEditMode={setMarkdownEditMode}
                onSave={async (path, content) => {
                  await window.maestro.fs.writeFile(path, content);
                  // Update the preview file content after save
                  setPreviewFile({ ...previewFile, content });
                }}
                shortcuts={shortcuts}
                fileTree={props.fileTree}
                cwd={(() => {
                  // Compute relative directory from preview file path for proximity matching
                  if (!activeSession?.fullPath || !previewFile.path.startsWith(activeSession.fullPath)) {
                    return '';
                  }
                  const relativePath = previewFile.path.slice(activeSession.fullPath.length + 1);
                  const lastSlash = relativePath.lastIndexOf('/');
                  return lastSlash > 0 ? relativePath.slice(0, lastSlash) : '';
                })()}
                onFileClick={props.onFileClick}
                canGoBack={props.canGoBack}
                canGoForward={props.canGoForward}
                onNavigateBack={props.onNavigateBack}
                onNavigateForward={props.onNavigateForward}
                backHistory={props.backHistory}
                forwardHistory={props.forwardHistory}
                currentHistoryIndex={props.currentHistoryIndex}
                onNavigateToIndex={props.onNavigateToIndex}
              />
            </div>
          ) : (
            <>
              {/* Logs Area */}
              <div className="flex-1 overflow-hidden flex flex-col" data-tour="main-terminal">
              <TerminalOutput
                key={`${activeSession.id}-${activeSession.activeTabId}`}
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
                onRemoveQueuedItem={onRemoveQueuedItem}
                onInterrupt={handleInterrupt}
                audioFeedbackCommand={props.audioFeedbackCommand}
                onScrollPositionChange={props.onScrollPositionChange}
                onAtBottomChange={props.onAtBottomChange}
                initialScrollTop={
                  activeSession.inputMode === 'ai'
                    ? activeTab?.scrollTop
                    : activeSession.terminalScrollTop
                }
                markdownEditMode={markdownEditMode}
                setMarkdownEditMode={setMarkdownEditMode}
                onReplayMessage={props.onReplayMessage}
                fileTree={props.fileTree}
                cwd={activeSession.cwd.startsWith(activeSession.fullPath)
                  ? activeSession.cwd.slice(activeSession.fullPath.length + 1)
                  : ''}
                projectRoot={activeSession.fullPath}
                onFileClick={props.onFileClick}
                onShowErrorDetails={props.onShowAgentErrorModal}
              />
              </div>

              {/* Input Area (hidden in mobile landscape for focused reading) */}
              {!isMobileLandscape && (
              <div data-tour="input-area">
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
                tabCompletionOpen={tabCompletionOpen}
                setTabCompletionOpen={setTabCompletionOpen}
                tabCompletionSuggestions={tabCompletionSuggestions}
                selectedTabCompletionIndex={selectedTabCompletionIndex}
                setSelectedTabCompletionIndex={setSelectedTabCompletionIndex}
                tabCompletionFilter={tabCompletionFilter}
                setTabCompletionFilter={setTabCompletionFilter}
                atMentionOpen={atMentionOpen}
                setAtMentionOpen={setAtMentionOpen}
                atMentionFilter={atMentionFilter}
                setAtMentionFilter={setAtMentionFilter}
                atMentionStartIndex={atMentionStartIndex}
                setAtMentionStartIndex={setAtMentionStartIndex}
                atMentionSuggestions={atMentionSuggestions}
                selectedAtMentionIndex={selectedAtMentionIndex}
                setSelectedAtMentionIndex={setSelectedAtMentionIndex}
                inputRef={inputRef}
                handleInputKeyDown={handleInputKeyDown}
                handlePaste={handlePaste}
                handleDrop={handleDrop}
                toggleInputMode={toggleInputMode}
                processInput={processInput}
                handleInterrupt={handleInterrupt}
                onInputFocus={handleInputFocus}
                onInputBlur={props.onInputBlur}
                isAutoModeActive={isCurrentSessionAutoMode}
                sessions={sessions}
                onSessionClick={handleSessionClick}
                autoRunState={currentSessionBatchState || undefined}
                onStopAutoRun={onStopBatchRun}
                onOpenQueueBrowser={onOpenQueueBrowser}
                tabReadOnlyMode={activeTab?.readOnlyMode ?? false}
                onToggleTabReadOnlyMode={props.onToggleTabReadOnlyMode}
                tabSaveToHistory={activeTab?.saveToHistory ?? false}
                onToggleTabSaveToHistory={props.onToggleTabSaveToHistory}
                onOpenPromptComposer={props.onOpenPromptComposer}
                showFlashNotification={showFlashNotification}
              />
              </div>
              )}
            </>
          )}

        </div>
      </ErrorBoundary>

      {/* Copy Notification Toast - centered flash notice */}
      {copyNotification && (
        <div
          className="fixed top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 px-6 py-4 rounded-lg shadow-2xl text-base font-bold animate-in fade-in zoom-in-95 duration-200 z-50"
          style={{
            backgroundColor: theme.colors.accent,
            color: theme.colors.accentForeground,
            textShadow: '0 1px 2px rgba(0, 0, 0, 0.3)'
          }}
        >
          {copyNotification}
        </div>
      )}
    </>
  );
});
