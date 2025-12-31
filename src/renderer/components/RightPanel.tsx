import React, { useRef, useEffect, useImperativeHandle, forwardRef, useState, useCallback, memo } from 'react';
import { PanelRightClose, PanelRightOpen, Loader2, GitBranch } from 'lucide-react';
import type { Session, Theme, RightPanelTab, Shortcut, BatchRunState, FocusArea } from '../types';
import type { FileTreeChanges } from '../utils/fileExplorer';
import { FileExplorerPanel } from './FileExplorerPanel';
import { HistoryPanel, HistoryPanelHandle } from './HistoryPanel';
import { AutoRun, AutoRunHandle } from './AutoRun';
import type { DocumentTaskCount } from './AutoRunDocumentSelector';
import { AutoRunExpandedModal } from './AutoRunExpandedModal';
import { formatShortcutKeys } from '../utils/shortcutFormatter';

export interface RightPanelHandle {
  refreshHistoryPanel: () => void;
  focusAutoRun: () => void;
  toggleAutoRunExpanded: () => void;
  openAutoRunResetTasksModal: () => void;
  getAutoRunCompletedTaskCount: () => number;
}

interface RightPanelProps {
  // Session & Theme
  session: Session | null;
  theme: Theme;
  shortcuts: Record<string, Shortcut>;

  // Panel state
  rightPanelOpen: boolean;
  setRightPanelOpen: (open: boolean) => void;
  rightPanelWidth: number;
  setRightPanelWidthState: (width: number) => void;

  // Tab state
  activeRightTab: RightPanelTab;
  setActiveRightTab: (tab: RightPanelTab) => void;

  // Focus management
  activeFocus: FocusArea;
  setActiveFocus: (focus: FocusArea) => void;

  // File explorer state & handlers
  fileTreeFilter: string;
  setFileTreeFilter: (filter: string) => void;
  fileTreeFilterOpen: boolean;
  setFileTreeFilterOpen: (open: boolean) => void;
  filteredFileTree: any[];
  selectedFileIndex: number;
  setSelectedFileIndex: (index: number) => void;
  previewFile: {name: string; content: string; path: string} | null;
  fileTreeContainerRef: React.RefObject<HTMLDivElement>;
  fileTreeFilterInputRef: React.RefObject<HTMLInputElement>;

  // File explorer handlers
  toggleFolder: (path: string, activeSessionId: string, setSessions: React.Dispatch<React.SetStateAction<Session[]>>) => void;
  handleFileClick: (node: any, path: string, activeSession: Session) => Promise<void>;
  expandAllFolders: (activeSessionId: string, activeSession: Session, setSessions: React.Dispatch<React.SetStateAction<Session[]>>) => void;
  collapseAllFolders: (activeSessionId: string, setSessions: React.Dispatch<React.SetStateAction<Session[]>>) => void;
  updateSessionWorkingDirectory: (activeSessionId: string, setSessions: React.Dispatch<React.SetStateAction<Session[]>>) => Promise<void>;
  refreshFileTree: (sessionId: string) => Promise<FileTreeChanges | undefined>;
  setSessions: React.Dispatch<React.SetStateAction<Session[]>>;
  onAutoRefreshChange?: (interval: number) => void;
  onShowFlash?: (message: string) => void;
  showHiddenFiles: boolean;
  setShowHiddenFiles: (value: boolean) => void;

  // Auto Run handlers
  autoRunDocumentList: string[];        // List of document filenames (without .md)
  autoRunDocumentTree?: Array<{ name: string; type: 'file' | 'folder'; path: string; children?: unknown[] }>;  // Tree structure for subfolders
  autoRunContent: string;               // Content of currently selected document
  autoRunContentVersion?: number;       // Version counter for external file changes (forces sync)
  autoRunIsLoadingDocuments: boolean;   // Loading state
  autoRunDocumentTaskCounts?: Map<string, DocumentTaskCount>;  // Task counts per document
  onAutoRunContentChange: (content: string) => void;
  onAutoRunModeChange: (mode: 'edit' | 'preview') => void;
  onAutoRunStateChange: (state: {
    mode: 'edit' | 'preview';
    cursorPosition: number;
    editScrollPos: number;
    previewScrollPos: number;
  }) => void;
  onAutoRunSelectDocument: (filename: string) => void;
  onAutoRunCreateDocument: (filename: string) => Promise<boolean>;
  onAutoRunRefresh: () => void;
  onAutoRunOpenSetup: () => void;

  // Batch processing props
  batchRunState?: BatchRunState;  // For progress display (may be from any session)
  currentSessionBatchState?: BatchRunState | null;  // For locking editor (current session only)
  onOpenBatchRunner?: () => void;
  onStopBatchRun?: (sessionId?: string) => void;
  // Error handling callbacks (Phase 5.10)
  onSkipCurrentDocument?: () => void;
  onAbortBatchOnError?: () => void;
  onResumeAfterError?: () => void;
  onJumpToAgentSession?: (agentSessionId: string) => void;
  onResumeSession?: (agentSessionId: string) => void;
  onOpenSessionAsTab?: (agentSessionId: string) => void;
  onOpenAboutModal?: () => void;  // For opening About/achievements panel from history entries
  // File linking callback for history detail modal
  onFileClick?: (path: string) => void;
  // Marketplace modal
  onOpenMarketplace?: () => void;
  /** Callback to open graph view focused on a specific file (relative path to session.cwd) */
  onFocusFileInGraph?: (relativePath: string) => void;
}

export const RightPanel = memo(forwardRef<RightPanelHandle, RightPanelProps>(function RightPanel(props, ref) {
  const {
    session, theme, shortcuts, rightPanelOpen, setRightPanelOpen, rightPanelWidth,
    setRightPanelWidthState, activeRightTab, setActiveRightTab, activeFocus, setActiveFocus,
    fileTreeFilter, setFileTreeFilter, fileTreeFilterOpen, setFileTreeFilterOpen,
    filteredFileTree, selectedFileIndex, setSelectedFileIndex, previewFile, fileTreeContainerRef,
    fileTreeFilterInputRef, toggleFolder, handleFileClick, expandAllFolders, collapseAllFolders,
    updateSessionWorkingDirectory, refreshFileTree, setSessions, onAutoRefreshChange, onShowFlash,
    showHiddenFiles, setShowHiddenFiles,
    autoRunDocumentList, autoRunDocumentTree, autoRunContent, autoRunContentVersion, autoRunIsLoadingDocuments,
    autoRunDocumentTaskCounts,
    onAutoRunContentChange, onAutoRunModeChange, onAutoRunStateChange,
    onAutoRunSelectDocument, onAutoRunCreateDocument, onAutoRunRefresh, onAutoRunOpenSetup,
    currentSessionBatchState, onOpenBatchRunner, onStopBatchRun,
    // Error handling callbacks (Phase 5.10)
    onSkipCurrentDocument, onAbortBatchOnError, onResumeAfterError,
    onJumpToAgentSession, onResumeSession,
    onOpenSessionAsTab, onOpenAboutModal, onFileClick,
    onOpenMarketplace,
    onFocusFileInGraph
  } = props;

  const historyPanelRef = useRef<HistoryPanelHandle>(null);
  const autoRunRef = useRef<AutoRunHandle>(null);

  // Elapsed time for Auto Run display - tracks wall clock time from startTime
  const [elapsedTime, setElapsedTime] = useState<string>('');

  // Shared draft state for Auto Run (shared between panel and expanded modal)
  // This ensures edits in one view are immediately visible in the other
  const [sharedLocalContent, setSharedLocalContent] = useState(autoRunContent);
  const [sharedSavedContent, setSharedSavedContent] = useState(autoRunContent);

  // Sync shared state when the source content changes (e.g., document switch, external file change)
  const prevAutoRunContentRef = useRef(autoRunContent);
  const prevAutoRunContentVersionRef = useRef(autoRunContentVersion);
  const prevSessionIdRef = useRef(session?.id);
  const prevSelectedFileRef = useRef(session?.autoRunSelectedFile);

  useEffect(() => {
    const contentChanged = autoRunContent !== prevAutoRunContentRef.current;
    const versionChanged = autoRunContentVersion !== prevAutoRunContentVersionRef.current;
    const sessionChanged = session?.id !== prevSessionIdRef.current;
    const fileChanged = session?.autoRunSelectedFile !== prevSelectedFileRef.current;

    if (contentChanged || versionChanged || sessionChanged || fileChanged) {
      setSharedLocalContent(autoRunContent);
      setSharedSavedContent(autoRunContent);
      prevAutoRunContentRef.current = autoRunContent;
      prevAutoRunContentVersionRef.current = autoRunContentVersion;
      prevSessionIdRef.current = session?.id;
      prevSelectedFileRef.current = session?.autoRunSelectedFile;
    }
  }, [autoRunContent, autoRunContentVersion, session?.id, session?.autoRunSelectedFile]);

  // Expanded modal state for Auto Run
  const [autoRunExpanded, setAutoRunExpanded] = useState(false);
  const handleExpandAutoRun = useCallback(() => setAutoRunExpanded(true), []);
  const handleCollapseAutoRun = useCallback(() => {
    setAutoRunExpanded(false);
    // Refocus the AutoRun panel after modal closes
    requestAnimationFrame(() => {
      autoRunRef.current?.focus();
    });
  }, []);
  const toggleAutoRunExpanded = useCallback(() => {
    setAutoRunExpanded(prev => {
      const newValue = !prev;
      // If collapsing, refocus the AutoRun panel
      if (!newValue) {
        requestAnimationFrame(() => {
          autoRunRef.current?.focus();
        });
      }
      return newValue;
    });
  }, []);

  // Format elapsed time from milliseconds
  const formatElapsed = useCallback((ms: number) => {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }, []);

  // Update elapsed time display using wall clock time from startTime
  // Uses an interval to update every second while running
  useEffect(() => {
    if (!currentSessionBatchState?.isRunning || !currentSessionBatchState?.startTime) {
      setElapsedTime('');
      return;
    }

    // Calculate elapsed immediately
    const updateElapsed = () => {
      const elapsed = Date.now() - currentSessionBatchState.startTime!;
      setElapsedTime(formatElapsed(elapsed));
    };

    updateElapsed();
    const interval = setInterval(updateElapsed, 1000);

    return () => clearInterval(interval);
  }, [currentSessionBatchState?.isRunning, currentSessionBatchState?.startTime, formatElapsed]);

  // Expose methods to parent
  useImperativeHandle(ref, () => ({
    refreshHistoryPanel: () => {
      historyPanelRef.current?.refreshHistory();
    },
    focusAutoRun: () => {
      autoRunRef.current?.focus();
    },
    toggleAutoRunExpanded,
    openAutoRunResetTasksModal: () => {
      autoRunRef.current?.openResetTasksModal();
    },
    getAutoRunCompletedTaskCount: () => {
      return autoRunRef.current?.getCompletedTaskCount() ?? 0;
    }
  }), [toggleAutoRunExpanded]);

  // Focus the history panel when switching to history tab
  useEffect(() => {
    if (activeRightTab === 'history' && rightPanelOpen && activeFocus === 'right') {
      // Small delay to ensure the panel is rendered
      requestAnimationFrame(() => {
        historyPanelRef.current?.focus();
      });
    }
  }, [activeRightTab, rightPanelOpen, activeFocus]);

  // Focus the auto run panel when switching to autorun tab
  useEffect(() => {
    if (activeRightTab === 'autorun' && rightPanelOpen && activeFocus === 'right') {
      // Small delay to ensure the panel is rendered
      requestAnimationFrame(() => {
        autoRunRef.current?.focus();
      });
    }
  }, [activeRightTab, rightPanelOpen, activeFocus]);

  if (!session) return null;

  // Shared props for AutoRun and AutoRunExpandedModal to avoid duplication
  const autoRunSharedProps = {
    theme,
    sessionId: session.id,
    sshRemoteId: session.sshRemoteId || (session.sessionSshRemoteConfig?.enabled ? session.sessionSshRemoteConfig?.remoteId : undefined) || undefined,
    folderPath: session.autoRunFolderPath || null,
    selectedFile: session.autoRunSelectedFile || null,
    documentList: autoRunDocumentList,
    documentTree: autoRunDocumentTree,
    content: autoRunContent,
    contentVersion: autoRunContentVersion,
    onContentChange: onAutoRunContentChange,
    externalLocalContent: sharedLocalContent,
    onExternalLocalContentChange: setSharedLocalContent,
    externalSavedContent: sharedSavedContent,
    onExternalSavedContentChange: setSharedSavedContent,
    mode: session.autoRunMode || 'edit' as const,
    onModeChange: onAutoRunModeChange,
    initialCursorPosition: session.autoRunCursorPosition || 0,
    initialEditScrollPos: session.autoRunEditScrollPos || 0,
    initialPreviewScrollPos: session.autoRunPreviewScrollPos || 0,
    onStateChange: onAutoRunStateChange,
    onOpenSetup: onAutoRunOpenSetup,
    onRefresh: onAutoRunRefresh,
    onSelectDocument: onAutoRunSelectDocument,
    onCreateDocument: onAutoRunCreateDocument,
    isLoadingDocuments: autoRunIsLoadingDocuments,
    documentTaskCounts: autoRunDocumentTaskCounts,
    batchRunState: currentSessionBatchState || undefined,
    onOpenBatchRunner,
    onStopBatchRun,
    onSkipCurrentDocument,
    onAbortBatchOnError,
    onResumeAfterError,
    sessionState: session.state,
    shortcuts,
    onOpenMarketplace,
  };

  return (
    <div
      tabIndex={0}
      className={`border-l flex flex-col transition-all duration-300 outline-none relative ${rightPanelOpen ? '' : 'w-0 overflow-hidden opacity-0'} ${activeFocus === 'right' ? 'ring-1 ring-inset z-10' : ''}`}
      style={{
        width: rightPanelOpen ? `${rightPanelWidth}px` : '0',
        backgroundColor: theme.colors.bgSidebar,
        borderColor: theme.colors.border,
        '--tw-ring-color': theme.colors.accent
      } as React.CSSProperties}
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
            const startWidth = rightPanelWidth;
            let currentWidth = startWidth;

            const handleMouseMove = (e: MouseEvent) => {
              const delta = startX - e.clientX; // Reversed for right panel
              currentWidth = Math.max(384, Math.min(800, startWidth + delta));
              setRightPanelWidthState(currentWidth);
            };

            const handleMouseUp = () => {
              window.maestro.settings.set('rightPanelWidth', currentWidth);
              document.removeEventListener('mousemove', handleMouseMove);
              document.removeEventListener('mouseup', handleMouseUp);
            };

            document.addEventListener('mousemove', handleMouseMove);
            document.addEventListener('mouseup', handleMouseUp);
          }}
        />
      )}

      {/* Tab Header */}
      <div className="flex border-b h-16" style={{ borderColor: theme.colors.border }}>
        {['files', 'history', 'autorun'].map(tab => (
          <button
            key={tab}
            onClick={() => setActiveRightTab(tab as RightPanelTab)}
            className="flex-1 text-xs font-bold border-b-2 transition-colors"
            style={{
              borderColor: activeRightTab === tab ? theme.colors.accent : 'transparent',
              color: activeRightTab === tab ? theme.colors.textMain : theme.colors.textDim
            }}
            data-tour={`${tab}-tab`}
          >
            {tab === 'autorun' ? 'Auto Run' : tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}

        <button
          onClick={() => setRightPanelOpen(!rightPanelOpen)}
          className="flex items-center justify-center p-2 rounded hover:bg-white/5 transition-colors w-12 shrink-0"
          title={`${rightPanelOpen ? "Collapse" : "Expand"} Right Panel (${formatShortcutKeys(shortcuts.toggleRightPanel.keys)})`}
        >
          {rightPanelOpen ? <PanelRightClose className="w-4 h-4 opacity-50" /> : <PanelRightOpen className="w-4 h-4 opacity-50" />}
        </button>
      </div>

      {/* Tab Content */}
      <div
        ref={fileTreeContainerRef}
        className="flex-1 px-4 pb-4 overflow-y-auto overflow-x-hidden min-w-[24rem] outline-none scrollbar-thin"
        tabIndex={-1}
        onClick={() => {
          setActiveFocus('right');
          // Only focus the container for file explorer, not for autorun (which has its own focus management)
          if (activeRightTab === 'files') {
            fileTreeContainerRef.current?.focus();
          }
        }}
        onScroll={(e) => {
          // Only track scroll position for file explorer tab
          if (activeRightTab === 'files') {
            const scrollTop = e.currentTarget.scrollTop;
            setSessions(prev => prev.map(s =>
              s.id === session.id ? { ...s, fileExplorerScrollPos: scrollTop } : s
            ));
          }
        }}
      >
        {activeRightTab === 'files' && (
          <div data-tour="files-panel" className="h-full">
            <FileExplorerPanel
              session={session}
              theme={theme}
              fileTreeFilter={fileTreeFilter}
              setFileTreeFilter={setFileTreeFilter}
              fileTreeFilterOpen={fileTreeFilterOpen}
              setFileTreeFilterOpen={setFileTreeFilterOpen}
              filteredFileTree={filteredFileTree}
              selectedFileIndex={selectedFileIndex}
              setSelectedFileIndex={setSelectedFileIndex}
              activeFocus={activeFocus}
              activeRightTab={activeRightTab}
              previewFile={previewFile}
              setActiveFocus={setActiveFocus}
              fileTreeFilterInputRef={fileTreeFilterInputRef}
              toggleFolder={toggleFolder}
              handleFileClick={handleFileClick}
              expandAllFolders={expandAllFolders}
              collapseAllFolders={collapseAllFolders}
              updateSessionWorkingDirectory={updateSessionWorkingDirectory}
              refreshFileTree={refreshFileTree}
              setSessions={setSessions}
              onAutoRefreshChange={onAutoRefreshChange}
              onShowFlash={onShowFlash}
              showHiddenFiles={showHiddenFiles}
              setShowHiddenFiles={setShowHiddenFiles}
              onFocusFileInGraph={onFocusFileInGraph}
            />
          </div>
        )}

        {activeRightTab === 'history' && (
          <div data-tour="history-panel" className="h-full">
            <HistoryPanel
              ref={historyPanelRef}
              session={session}
              theme={theme}
              onJumpToAgentSession={onJumpToAgentSession}
              onResumeSession={onResumeSession}
              onOpenSessionAsTab={onOpenSessionAsTab}
              onOpenAboutModal={onOpenAboutModal}
              fileTree={filteredFileTree}
              onFileClick={onFileClick}
            />
          </div>
        )}

        {activeRightTab === 'autorun' && (
          <div data-tour="autorun-panel" className="h-full">
          <AutoRun
            ref={autoRunRef}
            {...autoRunSharedProps}
            onExpand={handleExpandAutoRun}
          />
          </div>
        )}
      </div>

      {/* Auto Run Expanded Modal */}
      {autoRunExpanded && session && (
        <AutoRunExpandedModal
          {...autoRunSharedProps}
          onClose={handleCollapseAutoRun}
        />
      )}

      {/* Batch Run Progress - shown at bottom of all tabs (only for current session) */}
      {currentSessionBatchState && currentSessionBatchState.isRunning && (
        <div
          className="mx-4 mb-4 px-4 py-3 rounded border flex-shrink-0"
          style={{
            backgroundColor: theme.colors.bgActivity,
            borderColor: theme.colors.warning
          }}
        >
          {/* Header with status and elapsed time */}
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" style={{ color: theme.colors.warning }} />
              <span className="text-xs font-bold uppercase" style={{ color: theme.colors.textMain }}>
                {currentSessionBatchState.isStopping ? 'Stopping...' : 'Auto Run Active'}
              </span>
              {currentSessionBatchState.worktreeActive && (
                <span title={`Worktree: ${currentSessionBatchState.worktreeBranch || 'active'}`}>
                  <GitBranch className="w-4 h-4" style={{ color: theme.colors.warning }} />
                </span>
              )}
            </div>
            {/* Elapsed time - wall clock time since run started */}
            {elapsedTime && (
              <span
                className="text-xs font-mono"
                style={{ color: theme.colors.textDim }}
                title="Total elapsed time"
              >
                {elapsedTime}
              </span>
            )}
          </div>

          {/* Current document name - for single document runs */}
          {currentSessionBatchState.documents && currentSessionBatchState.documents.length === 1 && (
            <div className="mb-2">
              <span className="text-xs" style={{ color: theme.colors.textDim }}>
                {currentSessionBatchState.documents[0]}.md
              </span>
            </div>
          )}

          {/* Document progress with inline progress bar - only for multi-document runs */}
          {currentSessionBatchState.documents && currentSessionBatchState.documents.length > 1 && (
            <div className="mb-2">
              {/* Document name with progress bar */}
              <div className="flex items-center gap-2">
                <span
                  className="text-xs font-medium shrink-0"
                  style={{ color: theme.colors.textMain }}
                >
                  Document {currentSessionBatchState.currentDocumentIndex + 1}/{currentSessionBatchState.documents.length}: {currentSessionBatchState.documents[currentSessionBatchState.currentDocumentIndex]}.md
                </span>
                <div
                  className="flex-1 h-1 rounded-full overflow-hidden"
                  style={{ backgroundColor: theme.colors.border }}
                >
                  <div
                    className="h-full transition-all duration-300 ease-out"
                    style={{
                      width: `${
                        currentSessionBatchState.currentDocTasksTotal > 0
                          ? (currentSessionBatchState.currentDocTasksCompleted / currentSessionBatchState.currentDocTasksTotal) * 100
                          : 0
                      }%`,
                      backgroundColor: theme.colors.accent
                    }}
                  />
                </div>
              </div>
            </div>
          )}

          {/* Overall progress bar */}
          <div
            className="h-1.5 rounded-full overflow-hidden"
            style={{ backgroundColor: theme.colors.border }}
          >
            <div
              className="h-full transition-all duration-500 ease-out"
              style={{
                width: `${
                  currentSessionBatchState.totalTasksAcrossAllDocs > 0
                    ? (currentSessionBatchState.completedTasksAcrossAllDocs / currentSessionBatchState.totalTasksAcrossAllDocs) * 100
                    : currentSessionBatchState.totalTasks > 0
                      ? (currentSessionBatchState.completedTasks / currentSessionBatchState.totalTasks) * 100
                      : 0
                }%`,
                backgroundColor: currentSessionBatchState.isStopping ? theme.colors.error : theme.colors.warning
              }}
            />
          </div>

          {/* Overall completed count with loop info */}
          <div className="mt-2 flex items-start justify-between gap-2">
            <span className="text-[10px]" style={{ color: theme.colors.textDim }}>
              {currentSessionBatchState.isStopping
                ? 'Waiting for current task to complete before stopping...'
                : currentSessionBatchState.totalTasksAcrossAllDocs > 0
                  ? `${currentSessionBatchState.completedTasksAcrossAllDocs} of ${currentSessionBatchState.totalTasksAcrossAllDocs} tasks completed`
                  : `${currentSessionBatchState.completedTasks} of ${currentSessionBatchState.totalTasks} tasks completed`
              }
            </span>
            {/* Loop iteration indicator */}
            {currentSessionBatchState.loopEnabled && (
              <span
                className="text-[10px] px-1.5 py-0.5 rounded whitespace-nowrap shrink-0"
                style={{ backgroundColor: theme.colors.accent + '20', color: theme.colors.accent }}
              >
                Loop {currentSessionBatchState.loopIteration + 1} of {currentSessionBatchState.maxLoops ?? '∞'}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}));
