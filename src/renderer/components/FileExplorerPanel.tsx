import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronRight, ChevronDown, ChevronUp, Folder, RefreshCw, Check, Eye, EyeOff } from 'lucide-react';
import type { Session, Theme } from '../types';
import type { FileTreeChanges } from '../utils/fileExplorer';
import { getFileIcon } from '../utils/theme';
import { useLayerStack } from '../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';

// Auto-refresh interval options in seconds
const AUTO_REFRESH_OPTIONS = [
  { label: 'Every 5 seconds', value: 5 },
  { label: 'Every 20 seconds', value: 20 },
  { label: 'Every 60 seconds', value: 60 },
  { label: 'Every 3 minutes', value: 180 },
];

interface FileNode {
  name: string;
  type: 'file' | 'folder';
  children?: FileNode[];
}

// Flattened node for virtualization
interface FlattenedNode {
  node: FileNode;
  path: string;
  depth: number;
  globalIndex: number;
}

interface FileExplorerPanelProps {
  session: Session;
  theme: Theme;
  fileTreeFilter: string;
  setFileTreeFilter: (filter: string) => void;
  fileTreeFilterOpen: boolean;
  setFileTreeFilterOpen: (open: boolean) => void;
  filteredFileTree: FileNode[];
  selectedFileIndex: number;
  setSelectedFileIndex: (index: number) => void;
  activeFocus: string;
  activeRightTab: string;
  previewFile: {name: string; content: string; path: string} | null;
  setActiveFocus: (focus: string) => void;
  fileTreeContainerRef?: React.RefObject<HTMLDivElement>;
  fileTreeFilterInputRef?: React.RefObject<HTMLInputElement>;
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
}

export function FileExplorerPanel(props: FileExplorerPanelProps) {
  const {
    session, theme, fileTreeFilter, setFileTreeFilter, fileTreeFilterOpen, setFileTreeFilterOpen,
    filteredFileTree, selectedFileIndex, setSelectedFileIndex, activeFocus, activeRightTab,
    previewFile, setActiveFocus, fileTreeContainerRef, fileTreeFilterInputRef, toggleFolder, handleFileClick, expandAllFolders,
    collapseAllFolders, updateSessionWorkingDirectory, refreshFileTree, setSessions, onAutoRefreshChange, onShowFlash,
    showHiddenFiles, setShowHiddenFiles
  } = props;

  const { registerLayer, unregisterLayer, updateLayerHandler } = useLayerStack();
  const layerIdRef = useRef<string>();
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Refresh overlay state
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [overlayPosition, setOverlayPosition] = useState<{ top: number; left: number } | null>(null);
  const refreshButtonRef = useRef<HTMLButtonElement>(null);
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isOverOverlayRef = useRef(false);
  const autoRefreshTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Get current auto-refresh interval from session
  const autoRefreshInterval = session.fileTreeAutoRefreshInterval || 0;

  // Handle refresh with animation and flash notification
  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);

    try {
      const changes = await refreshFileTree(session.id);

      // Show center screen flash notification with change count
      if (changes && onShowFlash) {
        const message = changes.totalChanges === 0
          ? 'No changes detected'
          : `Detected ${changes.totalChanges} change${changes.totalChanges === 1 ? '' : 's'}`;
        onShowFlash(message);
      }
    } finally {
      // Keep spinner visible for at least 500ms for visual feedback
      setTimeout(() => setIsRefreshing(false), 500);
    }
  }, [refreshFileTree, session.id, onShowFlash]);

  // Silent refresh for auto-refresh (no flash notification)
  const silentRefresh = useCallback(async () => {
    await refreshFileTree(session.id);
  }, [refreshFileTree, session.id]);

  // Auto-refresh timer
  useEffect(() => {
    // Clear existing timer
    if (autoRefreshTimerRef.current) {
      clearInterval(autoRefreshTimerRef.current);
      autoRefreshTimerRef.current = null;
    }

    // Start new timer if interval is set
    if (autoRefreshInterval > 0) {
      autoRefreshTimerRef.current = setInterval(() => {
        silentRefresh();
      }, autoRefreshInterval * 1000);
    }

    // Cleanup on unmount or interval change
    return () => {
      if (autoRefreshTimerRef.current) {
        clearInterval(autoRefreshTimerRef.current);
        autoRefreshTimerRef.current = null;
      }
    };
  }, [autoRefreshInterval, silentRefresh]);

  // Hover handlers for refresh button overlay
  const handleRefreshMouseEnter = useCallback(() => {
    hoverTimeoutRef.current = setTimeout(() => {
      if (refreshButtonRef.current) {
        const rect = refreshButtonRef.current.getBoundingClientRect();
        setOverlayPosition({ top: rect.bottom + 4, left: rect.right });
      }
      setOverlayOpen(true);
    }, 400);
  }, []);

  const handleRefreshMouseLeave = useCallback(() => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
    // Delay closing to allow mouse to reach overlay
    hoverTimeoutRef.current = setTimeout(() => {
      if (!isOverOverlayRef.current) {
        setOverlayOpen(false);
      }
    }, 100);
  }, []);

  const handleOverlayMouseEnter = useCallback(() => {
    isOverOverlayRef.current = true;
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
  }, []);

  const handleOverlayMouseLeave = useCallback(() => {
    isOverOverlayRef.current = false;
    setOverlayOpen(false);
  }, []);

  const handleIntervalSelect = useCallback((interval: number) => {
    onAutoRefreshChange?.(interval);
    setOverlayOpen(false);
  }, [onAutoRefreshChange]);

  // Register layer when filter is open
  useEffect(() => {
    if (fileTreeFilterOpen) {
      const id = registerLayer({
        type: 'overlay',
        priority: MODAL_PRIORITIES.FILE_TREE_FILTER,
        blocksLowerLayers: false,
        capturesFocus: true,
        focusTrap: 'none',
        onEscape: () => {
          setFileTreeFilterOpen(false);
          setFileTreeFilter('');
        },
        allowClickOutside: true,
        ariaLabel: 'File Tree Filter'
      });
      layerIdRef.current = id;
      return () => unregisterLayer(id);
    }
  }, [fileTreeFilterOpen, registerLayer, unregisterLayer]);

  // Update handler when dependencies change
  useEffect(() => {
    if (fileTreeFilterOpen && layerIdRef.current) {
      updateLayerHandler(layerIdRef.current, () => {
        setFileTreeFilterOpen(false);
        setFileTreeFilter('');
      });
    }
  }, [fileTreeFilterOpen, setFileTreeFilterOpen, setFileTreeFilter, updateLayerHandler]);

  // Filter hidden files from the tree based on showHiddenFiles setting
  const filterHiddenFiles = useCallback((nodes: FileNode[]): FileNode[] => {
    if (!nodes) return [];
    if (showHiddenFiles) return nodes;
    return nodes
      .filter(node => !node.name.startsWith('.'))
      .map(node => ({
        ...node,
        children: node.children ? filterHiddenFiles(node.children) : undefined
      }));
  }, [showHiddenFiles]);

  // Apply hidden file filtering to the already-filtered tree
  const displayTree = useMemo(() => {
    return filterHiddenFiles(filteredFileTree || []);
  }, [filteredFileTree, filterHiddenFiles]);

  // Flatten tree for virtualization - only includes visible nodes (respects expanded state)
  // When filtering, auto-expand all folders to show matches
  const flattenedTree = useMemo(() => {
    const expandedSet = new Set(session.fileExplorerExpanded || []);
    const isFiltering = fileTreeFilter.length > 0;
    const result: FlattenedNode[] = [];
    let globalIndex = 0;

    const flatten = (nodes: FileNode[], currentPath = '', depth = 0) => {
      for (const node of nodes) {
        const fullPath = currentPath ? `${currentPath}/${node.name}` : node.name;
        result.push({ node, path: fullPath, depth, globalIndex });
        globalIndex++;

        // When filtering, auto-expand all folders to reveal matches
        // Otherwise, only include children if folder is manually expanded
        const shouldShowChildren = node.type === 'folder' && node.children &&
          (isFiltering || expandedSet.has(fullPath));

        if (shouldShowChildren) {
          flatten(node.children!, fullPath, depth + 1);
        }
      }
    };

    flatten(displayTree);
    return result;
  }, [displayTree, session.fileExplorerExpanded, fileTreeFilter]);

  // Virtualization setup
  const parentRef = useRef<HTMLDivElement>(null);
  const ROW_HEIGHT = 28; // Height of each tree row in pixels

  const virtualizer = useVirtualizer({
    count: flattenedTree.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10, // Render 10 extra items above/below viewport for smooth scrolling
  });

  // Memoized row renderer
  const TreeRow = useCallback(({ item, virtualRow }: { item: FlattenedNode; virtualRow: { index: number; start: number; size: number } }) => {
    const { node, path: fullPath, depth, globalIndex } = item;
    const absolutePath = `${session.fullPath}/${fullPath}`;
    const change = session.changedFiles?.find(f => f.path.includes(node.name));
    const isFolder = node.type === 'folder';
    const expandedSet = new Set(session.fileExplorerExpanded || []);
    const isExpanded = expandedSet.has(fullPath);
    const isSelected = previewFile?.path === absolutePath;
    const isKeyboardSelected = activeFocus === 'right' && activeRightTab === 'files' && globalIndex === selectedFileIndex;

    // Generate indent guides for each depth level
    const indentGuides = [];
    for (let i = 0; i < depth; i++) {
      indentGuides.push(
        <div
          key={i}
          className="absolute top-0 bottom-0 w-px"
          style={{
            left: `${12 + i * 16}px`,
            backgroundColor: theme.colors.border,
          }}
        />
      );
    }

    return (
      <div
        data-file-index={globalIndex}
        className={`absolute top-0 left-0 w-full flex items-center gap-2 py-1 text-xs cursor-pointer hover:bg-white/5 px-2 rounded transition-colors border-l-2 select-none min-w-0 ${isSelected ? 'bg-white/10' : ''}`}
        style={{
          height: `${virtualRow.size}px`,
          transform: `translateY(${virtualRow.start}px)`,
          paddingLeft: `${8 + depth * 16}px`,
          color: change ? theme.colors.textMain : theme.colors.textDim,
          borderLeftColor: isKeyboardSelected ? theme.colors.accent : 'transparent',
          backgroundColor: isKeyboardSelected ? theme.colors.bgActivity : (isSelected ? 'rgba(255,255,255,0.1)' : 'transparent')
        }}
        onMouseDown={(e) => {
          // Prevent focus from leaving the filter input when filtering
          if (fileTreeFilter.length > 0) {
            e.preventDefault();
          }
        }}
        onClick={() => {
          if (isFolder) {
            toggleFolder(fullPath, session.id, setSessions);
          } else {
            setSelectedFileIndex(globalIndex);
            // Only change focus if not filtering
            if (fileTreeFilter.length === 0) {
              setActiveFocus('right');
            }
          }
        }}
        onDoubleClick={() => {
          if (!isFolder) {
            handleFileClick(node, fullPath, session);
          }
        }}
      >
        {indentGuides}
        {isFolder && (
          isExpanded ? <ChevronDown className="w-3 h-3 flex-shrink-0" /> : <ChevronRight className="w-3 h-3 flex-shrink-0" />
        )}
        <span className="flex-shrink-0">{isFolder ? <Folder className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} /> : getFileIcon(change?.type, theme)}</span>
        <span className={`truncate min-w-0 flex-1 ${change ? 'font-medium' : ''}`} title={node.name}>{node.name}</span>
        {change && (
          <span
            className="flex-shrink-0 text-[9px] px-1 rounded uppercase"
            style={{
              backgroundColor: change.type === 'added' ? theme.colors.success + '20' : change.type === 'deleted' ? theme.colors.error + '20' : theme.colors.warning + '20',
              color: change.type === 'added' ? theme.colors.success : change.type === 'deleted' ? theme.colors.error : theme.colors.warning
            }}
          >
            {change.type}
          </span>
        )}
      </div>
    );
  }, [session.fullPath, session.changedFiles, session.fileExplorerExpanded, session.id, previewFile?.path, activeFocus, activeRightTab, selectedFileIndex, theme, toggleFolder, setSessions, setSelectedFileIndex, setActiveFocus, handleFileClick, fileTreeFilter]);

  return (
    <div className="space-y-2 relative">
      {/* File Tree Filter */}
      {fileTreeFilterOpen && (
        <div className="mb-3 pt-4">
          <input
            ref={fileTreeFilterInputRef}
            autoFocus
            type="text"
            placeholder="Filter files..."
            value={fileTreeFilter}
            onChange={(e) => setFileTreeFilter(e.target.value)}
            className="w-full px-3 py-2 rounded border bg-transparent outline-none text-sm"
            style={{ borderColor: theme.colors.accent, color: theme.colors.textMain }}
          />
        </div>
      )}

      {/* Header with CWD and controls */}
      <div
        className="sticky top-0 z-10 flex items-center justify-between gap-2 text-xs font-bold pt-4 pb-2 mb-2 min-w-0"
        style={{
          backgroundColor: theme.colors.bgSidebar
        }}
      >
        <span className="opacity-50 truncate min-w-0 flex-1" title={session.cwd}>{session.cwd}</span>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            ref={refreshButtonRef}
            onClick={handleRefresh}
            onMouseEnter={handleRefreshMouseEnter}
            onMouseLeave={handleRefreshMouseLeave}
            className="p-1 rounded hover:bg-white/10 transition-colors"
            title={autoRefreshInterval > 0 ? `Auto-refresh every ${autoRefreshInterval}s` : "Refresh file tree"}
            style={{
              color: autoRefreshInterval > 0 ? theme.colors.accent : theme.colors.textDim,
              backgroundColor: autoRefreshInterval > 0 ? `${theme.colors.accent}20` : 'transparent'
            }}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={() => expandAllFolders(session.id, session, setSessions)}
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
            onClick={() => collapseAllFolders(session.id, setSessions)}
            className="p-1 rounded hover:bg-white/10 transition-colors"
            title="Collapse all folders"
            style={{ color: theme.colors.textDim }}
          >
            <div className="flex flex-col items-center -space-y-1.5">
              <ChevronDown className="w-3.5 h-3.5" />
              <ChevronUp className="w-3.5 h-3.5" />
            </div>
          </button>
          <button
            onClick={() => setShowHiddenFiles(!showHiddenFiles)}
            className="p-1 rounded hover:bg-white/10 transition-colors"
            title={showHiddenFiles ? "Hide dotfiles" : "Show dotfiles"}
            style={{
              color: showHiddenFiles ? theme.colors.accent : theme.colors.textDim,
              backgroundColor: showHiddenFiles ? `${theme.colors.accent}20` : 'transparent'
            }}
          >
            {showHiddenFiles ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {/* File tree content - virtualized */}
      {session.fileTreeError ? (
        <div className="flex flex-col items-center justify-center gap-3 py-8">
          <div className="text-xs text-center" style={{ color: theme.colors.error }}>
            {session.fileTreeError}
          </div>
          <button
            onClick={() => updateSessionWorkingDirectory(session.id, setSessions)}
            className="flex items-center gap-2 px-3 py-2 rounded border hover:bg-white/5 transition-colors text-xs"
            style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
          >
            <Folder className="w-4 h-4" />
            Select New Directory
          </button>
        </div>
      ) : (
        <>
          {(!session.fileTree || session.fileTree.length === 0) && (
            <div className="text-xs opacity-50 italic">Loading files...</div>
          )}
          {flattenedTree.length > 0 && (
            <div
              ref={parentRef}
              className="flex-1 overflow-auto"
              style={{ height: 'calc(100vh - 200px)' }}
            >
              <div
                style={{
                  height: `${virtualizer.getTotalSize()}px`,
                  width: '100%',
                  position: 'relative',
                }}
              >
                {virtualizer.getVirtualItems().map((virtualRow) => {
                  const item = flattenedTree[virtualRow.index];
                  return (
                    <TreeRow
                      key={item.path}
                      item={item}
                      virtualRow={virtualRow}
                    />
                  );
                })}
              </div>
            </div>
          )}
          {fileTreeFilter && flattenedTree.length === 0 && (
            <div className="text-xs opacity-50 italic text-center py-4">No files match your search</div>
          )}
        </>
      )}

      {/* Auto-refresh overlay - rendered via portal */}
      {overlayOpen && overlayPosition && createPortal(
        <div
          className="fixed z-[100] rounded-lg shadow-xl border overflow-hidden"
          style={{
            backgroundColor: theme.colors.bgSidebar,
            borderColor: theme.colors.border,
            minWidth: '180px',
            top: overlayPosition.top,
            left: overlayPosition.left,
            transform: 'translateX(-100%)'
          }}
          onMouseEnter={handleOverlayMouseEnter}
          onMouseLeave={handleOverlayMouseLeave}
        >
          {/* Header */}
          <div
            className="px-3 py-2 text-xs font-medium border-b"
            style={{
              backgroundColor: theme.colors.bgActivity,
              borderColor: theme.colors.border,
              color: theme.colors.textMain
            }}
          >
            Auto-refresh
          </div>

          {/* Options */}
          <div className="p-1">
            {AUTO_REFRESH_OPTIONS.map((option) => (
              <button
                key={option.value}
                onClick={() => handleIntervalSelect(option.value)}
                className="w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
                style={{
                  color: autoRefreshInterval === option.value ? theme.colors.accent : theme.colors.textMain,
                  backgroundColor: autoRefreshInterval === option.value ? `${theme.colors.accent}15` : 'transparent'
                }}
              >
                <span>{option.label}</span>
                {autoRefreshInterval === option.value && (
                  <Check className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />
                )}
              </button>
            ))}

            {/* Disable option - only shown when auto-refresh is active */}
            {autoRefreshInterval > 0 && (
              <>
                <div
                  className="my-1 border-t"
                  style={{ borderColor: theme.colors.border }}
                />
                <button
                  onClick={() => handleIntervalSelect(0)}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
                  style={{ color: theme.colors.textDim }}
                >
                  Disable auto-refresh
                </button>
              </>
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
