import React, { useCallback, useEffect, useState, useRef, useMemo } from 'react';
import { GripVertical, Plus, Repeat, RotateCcw, X, AlertTriangle, RefreshCw, ChevronDown, ChevronRight, Folder, CheckSquare } from 'lucide-react';
import type { Theme, BatchDocumentEntry } from '../types';
import { generateId } from '../utils/ids';

// Platform detection helper (userAgentData is newer but not in all TS types yet)
const isMacPlatform = (): boolean => {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return nav.userAgentData?.platform?.toLowerCase().includes('mac')
    ?? navigator.platform.toLowerCase().includes('mac');
};

// Tree node type for folder structure
export interface DocTreeNode {
  name: string;
  type: 'file' | 'folder';
  path: string;
  children?: DocTreeNode[];
}

interface DocumentsPanelProps {
  theme: Theme;
  documents: BatchDocumentEntry[];
  setDocuments: React.Dispatch<React.SetStateAction<BatchDocumentEntry[]>>;
  taskCounts: Record<string, number>;
  loadingTaskCounts: boolean;
  loopEnabled: boolean;
  setLoopEnabled: (enabled: boolean) => void;
  maxLoops: number | null;
  setMaxLoops: (maxLoops: number | null) => void;
  allDocuments: string[];
  documentTree?: DocTreeNode[];
  onRefreshDocuments: () => Promise<void>;
}

// Document selector modal component
interface DocumentSelectorModalProps {
  theme: Theme;
  allDocuments: string[];
  documentTree?: DocTreeNode[];
  taskCounts: Record<string, number>;
  loadingTaskCounts: boolean;
  documents: BatchDocumentEntry[];
  onClose: () => void;
  onAdd: (selectedDocs: Set<string>) => void;
  onRefresh: () => Promise<void>;
}

function DocumentSelectorModal({
  theme,
  allDocuments,
  documentTree,
  taskCounts,
  loadingTaskCounts,
  documents,
  onClose,
  onAdd,
  onRefresh
}: DocumentSelectorModalProps) {
  // Pre-select currently added documents
  const [selectedDocs, setSelectedDocs] = useState<Set<string>>(() => {
    return new Set(documents.map(d => d.filename));
  });
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState<string | null>(null);
  const [prevDocCount, setPrevDocCount] = useState(allDocuments.length);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());

  // Toggle document selection
  const toggleDoc = useCallback((filename: string) => {
    setSelectedDocs(prev => {
      const next = new Set(prev);
      if (next.has(filename)) {
        next.delete(filename);
      } else {
        next.add(filename);
      }
      return next;
    });
  }, []);

  // Select all documents
  const selectAll = useCallback(() => {
    setSelectedDocs(new Set(allDocuments));
  }, [allDocuments]);

  // Deselect all documents
  const deselectAll = useCallback(() => {
    setSelectedDocs(new Set());
  }, []);

  // Toggle folder expansion
  const toggleFolder = useCallback((folderPath: string) => {
    setExpandedFolders(prev => {
      const next = new Set(prev);
      if (next.has(folderPath)) {
        next.delete(folderPath);
      } else {
        next.add(folderPath);
      }
      return next;
    });
  }, []);

  // Get all file paths under a folder (recursive)
  const getFilesInFolder = useCallback((node: DocTreeNode): string[] => {
    if (node.type === 'file') {
      return [node.path];
    }
    if (node.children) {
      return node.children.flatMap(child => getFilesInFolder(child));
    }
    return [];
  }, []);

  // Check if all files in a folder are selected
  const isFolderFullySelected = useCallback((node: DocTreeNode): boolean => {
    const files = getFilesInFolder(node);
    return files.length > 0 && files.every(f => selectedDocs.has(f));
  }, [getFilesInFolder, selectedDocs]);

  // Check if some (but not all) files in a folder are selected
  const isFolderPartiallySelected = useCallback((node: DocTreeNode): boolean => {
    const files = getFilesInFolder(node);
    const selectedCount = files.filter(f => selectedDocs.has(f)).length;
    return selectedCount > 0 && selectedCount < files.length;
  }, [getFilesInFolder, selectedDocs]);

  // Toggle all files in a folder
  const toggleFolder_ = useCallback((node: DocTreeNode) => {
    const files = getFilesInFolder(node);
    const allSelected = files.every(f => selectedDocs.has(f));

    setSelectedDocs(prev => {
      const next = new Set(prev);
      if (allSelected) {
        // Deselect all
        files.forEach(f => next.delete(f));
      } else {
        // Select all
        files.forEach(f => next.add(f));
      }
      return next;
    });
  }, [getFilesInFolder, selectedDocs]);

  // Get total task count for files in a folder
  const getFolderTaskCount = useCallback((node: DocTreeNode): number => {
    const files = getFilesInFolder(node);
    return files.reduce((sum, f) => sum + (taskCounts[f] ?? 0), 0);
  }, [getFilesInFolder, taskCounts]);

  // Get total task count for all documents
  const totalTaskCount = useMemo(() => {
    return allDocuments.reduce((sum, f) => sum + (taskCounts[f] ?? 0), 0);
  }, [allDocuments, taskCounts]);

  // Handle refresh
  const handleRefresh = useCallback(async () => {
    const countBefore = allDocuments.length;
    setRefreshing(true);
    setRefreshMessage(null);

    await onRefresh();

    // Use a small timeout to let the prop update
    setTimeout(() => {
      setRefreshing(false);
    }, 500);
  }, [onRefresh, allDocuments.length]);

  // Track document count changes for refresh notification
  useEffect(() => {
    if (refreshing === false && prevDocCount !== allDocuments.length) {
      const diff = allDocuments.length - prevDocCount;
      let message: string;
      if (diff > 0) {
        message = `Found ${diff} new document${diff === 1 ? '' : 's'}`;
      } else if (diff < 0) {
        message = `${Math.abs(diff)} document${Math.abs(diff) === 1 ? '' : 's'} removed`;
      } else {
        message = 'No changes';
      }
      setRefreshMessage(message);
      setPrevDocCount(allDocuments.length);

      // Clear message after 3 seconds
      const timer = setTimeout(() => setRefreshMessage(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [allDocuments.length, prevDocCount, refreshing]);

  // Render a tree node recursively with checkboxes
  const renderTreeNode = (node: DocTreeNode, depth: number = 0): React.ReactNode => {
    const paddingLeft = depth * 20 + 12;

    if (node.type === 'folder') {
      const isExpanded = expandedFolders.has(node.path);
      const isFullySelected = isFolderFullySelected(node);
      const isPartiallySelected = isFolderPartiallySelected(node);
      const filesInFolder = getFilesInFolder(node);

      return (
        <div key={node.path}>
          <div
            className={`w-full flex items-center gap-2 py-1.5 rounded transition-colors ${
              isFullySelected ? 'bg-white/10' : 'hover:bg-white/5'
            }`}
            style={{ paddingLeft }}
          >
            {/* Expand/Collapse button */}
            <button
              onClick={() => toggleFolder(node.path)}
              className="p-0.5 rounded hover:bg-white/10 shrink-0"
              style={{ color: theme.colors.textDim }}
            >
              {isExpanded ? (
                <ChevronDown className="w-3 h-3" />
              ) : (
                <ChevronRight className="w-3 h-3" />
              )}
            </button>

            {/* Folder checkbox */}
            <button
              onClick={() => toggleFolder_(node)}
              className="flex items-center gap-2 flex-1 min-w-0"
            >
              <div
                className="w-4 h-4 rounded border flex items-center justify-center shrink-0"
                style={{
                  borderColor: isFullySelected || isPartiallySelected ? theme.colors.accent : theme.colors.border,
                  backgroundColor: isFullySelected ? theme.colors.accent : 'transparent'
                }}
              >
                {isFullySelected && (
                  <svg className="w-3 h-3 text-white" viewBox="0 0 12 12" fill="none">
                    <path d="M2 6L5 9L10 3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
                {isPartiallySelected && (
                  <div
                    className="w-2 h-2 rounded-sm"
                    style={{ backgroundColor: theme.colors.accent }}
                  />
                )}
              </div>

              <Folder className="w-3.5 h-3.5 shrink-0" style={{ color: theme.colors.accent }} />
              <span className="text-sm truncate" style={{ color: theme.colors.textMain }}>
                {node.name}
              </span>
            </button>

            {/* File count badge */}
            <span
              className="text-xs px-2 py-0.5 rounded shrink-0"
              style={{
                backgroundColor: theme.colors.textDim + '20',
                color: theme.colors.textDim
              }}
            >
              {filesInFolder.length} {filesInFolder.length === 1 ? 'file' : 'files'}
            </span>

            {/* Task count badge */}
            {(() => {
              const folderTaskCount = getFolderTaskCount(node);
              return (
                <span
                  className="text-xs px-2 py-0.5 rounded shrink-0 mr-3"
                  style={{
                    backgroundColor: folderTaskCount === 0 ? theme.colors.textDim + '20' : theme.colors.success + '20',
                    color: folderTaskCount === 0 ? theme.colors.textDim : theme.colors.success
                  }}
                >
                  {loadingTaskCounts ? '...' : `${folderTaskCount} ${folderTaskCount === 1 ? 'task' : 'tasks'}`}
                </span>
              );
            })()}
          </div>

          {/* Children */}
          {isExpanded && node.children && (
            <div>
              {node.children.map(child => renderTreeNode(child, depth + 1))}
            </div>
          )}
        </div>
      );
    }

    // File node
    const isSelected = selectedDocs.has(node.path);
    const docTaskCount = taskCounts[node.path] ?? 0;

    return (
      <button
        key={node.path}
        onClick={() => toggleDoc(node.path)}
        className={`w-full flex items-center gap-3 py-1.5 rounded transition-colors ${
          isSelected ? 'bg-white/10' : 'hover:bg-white/5'
        }`}
        style={{ paddingLeft: paddingLeft + 20 }} // Extra indent for files
      >
        {/* Checkbox */}
        <div
          className="w-4 h-4 rounded border flex items-center justify-center shrink-0"
          style={{
            borderColor: isSelected ? theme.colors.accent : theme.colors.border,
            backgroundColor: isSelected ? theme.colors.accent : 'transparent'
          }}
        >
          {isSelected && (
            <svg className="w-3 h-3 text-white" viewBox="0 0 12 12" fill="none">
              <path d="M2 6L5 9L10 3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </div>

        {/* Filename */}
        <span
          className="flex-1 text-sm text-left truncate"
          style={{ color: theme.colors.textMain }}
        >
          {node.name}.md
        </span>

        {/* Task Count */}
        <span
          className="text-xs px-2 py-0.5 rounded shrink-0 mr-3"
          style={{
            backgroundColor: docTaskCount === 0 ? theme.colors.textDim + '20' : theme.colors.success + '20',
            color: docTaskCount === 0 ? theme.colors.textDim : theme.colors.success
          }}
        >
          {loadingTaskCounts ? '...' : `${docTaskCount} ${docTaskCount === 1 ? 'task' : 'tasks'}`}
        </span>
      </button>
    );
  };

  const allSelected = selectedDocs.size === allDocuments.length && allDocuments.length > 0;
  const someSelected = selectedDocs.size > 0;

  // Calculate task count for selected documents
  const selectedTaskCount = useMemo(() => {
    let count = 0;
    selectedDocs.forEach(doc => {
      count += taskCounts[doc] ?? 0;
    });
    return count;
  }, [selectedDocs, taskCounts]);

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-[10000]"
      onClick={onClose}
    >
      <div
        className="w-[550px] max-h-[70vh] border rounded-lg shadow-2xl overflow-hidden flex flex-col"
        style={{ backgroundColor: theme.colors.bgSidebar, borderColor: theme.colors.border }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Selector Header */}
        <div className="p-4 border-b flex items-center justify-between shrink-0" style={{ borderColor: theme.colors.border }}>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-bold" style={{ color: theme.colors.textMain }}>
              Select Documents
            </h3>
            {/* Total task count badge */}
            <span
              className="text-xs px-2 py-0.5 rounded"
              style={{
                backgroundColor: totalTaskCount === 0 ? theme.colors.textDim + '20' : theme.colors.success + '20',
                color: totalTaskCount === 0 ? theme.colors.textDim : theme.colors.success
              }}
            >
              {loadingTaskCounts ? '...' : `${totalTaskCount} ${totalTaskCount === 1 ? 'task' : 'tasks'}`}
            </span>
            {refreshMessage && (
              <span
                className="text-xs px-2 py-0.5 rounded animate-in fade-in"
                style={{
                  backgroundColor: theme.colors.success + '20',
                  color: theme.colors.success
                }}
              >
                {refreshMessage}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            {/* Select All / Deselect All button */}
            <button
              onClick={allSelected ? deselectAll : selectAll}
              className="flex items-center gap-1 px-2 py-1 rounded text-xs hover:bg-white/10 transition-colors"
              style={{ color: theme.colors.accent }}
              title={allSelected ? 'Deselect all documents' : 'Select all documents'}
            >
              <CheckSquare className="w-3.5 h-3.5" />
              {allSelected ? 'Deselect All' : 'Select All'}
            </button>
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              className="p-1 rounded hover:bg-white/10 transition-colors disabled:opacity-50"
              style={{ color: theme.colors.textDim }}
              title="Refresh document list"
            >
              <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
            </button>
            <button onClick={onClose} className="p-1 rounded hover:bg-white/10 transition-colors" style={{ color: theme.colors.textDim }}>
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Document Checkboxes */}
        <div className="flex-1 overflow-y-auto p-2">
          {allDocuments.length === 0 ? (
            <div className="p-4 text-center" style={{ color: theme.colors.textDim }}>
              <p className="text-sm">No documents found in folder</p>
            </div>
          ) : documentTree && documentTree.length > 0 ? (
            // Render tree structure with folder checkboxes
            <div className="space-y-0.5">
              {documentTree.map(node => renderTreeNode(node))}
            </div>
          ) : (
            // Fallback to flat list
            <div className="space-y-1">
              {allDocuments.map((filename) => {
                const isSelected = selectedDocs.has(filename);
                const docTaskCount = taskCounts[filename] ?? 0;

                return (
                  <button
                    key={filename}
                    onClick={() => toggleDoc(filename)}
                    className={`w-full flex items-center gap-3 px-3 py-2 rounded transition-colors ${
                      isSelected ? 'bg-white/10' : 'hover:bg-white/5'
                    }`}
                  >
                    {/* Checkbox */}
                    <div
                      className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${
                        isSelected ? 'bg-accent border-accent' : ''
                      }`}
                      style={{
                        borderColor: isSelected ? theme.colors.accent : theme.colors.border,
                        backgroundColor: isSelected ? theme.colors.accent : 'transparent'
                      }}
                    >
                      {isSelected && (
                        <svg className="w-3 h-3 text-white" viewBox="0 0 12 12" fill="none">
                          <path d="M2 6L5 9L10 3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </div>

                    {/* Filename */}
                    <span
                      className="flex-1 text-sm text-left truncate"
                      style={{ color: theme.colors.textMain }}
                    >
                      {filename}.md
                    </span>

                    {/* Task Count */}
                    <span
                      className="text-xs px-2 py-0.5 rounded shrink-0"
                      style={{
                        backgroundColor: docTaskCount === 0 ? theme.colors.textDim + '20' : theme.colors.success + '20',
                        color: docTaskCount === 0 ? theme.colors.textDim : theme.colors.success
                      }}
                    >
                      {loadingTaskCounts ? '...' : `${docTaskCount} ${docTaskCount === 1 ? 'task' : 'tasks'}`}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Selector Footer */}
        <div className="p-4 border-t flex justify-end gap-2 shrink-0" style={{ borderColor: theme.colors.border }}>
          <button
            onClick={onClose}
            className="px-4 py-2 rounded border hover:bg-white/5 transition-colors"
            style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
          >
            Cancel
          </button>
          <button
            onClick={() => onAdd(selectedDocs)}
            className="px-4 py-2 rounded text-white font-bold"
            style={{ backgroundColor: theme.colors.accent }}
          >
            Add {selectedDocs.size} {selectedDocs.size === 1 ? 'file' : 'files'} · {loadingTaskCounts ? '...' : `${selectedTaskCount} ${selectedTaskCount === 1 ? 'task' : 'tasks'}`}
          </button>
        </div>
      </div>
    </div>
  );
}

export function DocumentsPanel({
  theme,
  documents,
  setDocuments,
  taskCounts,
  loadingTaskCounts,
  loopEnabled,
  setLoopEnabled,
  maxLoops,
  setMaxLoops,
  allDocuments,
  documentTree,
  onRefreshDocuments
}: DocumentsPanelProps) {
  // Document selector modal state
  const [showDocSelector, setShowDocSelector] = useState(false);

  // Loop mode state
  const [showMaxLoopsSlider, setShowMaxLoopsSlider] = useState(maxLoops != null);

  // Drag state for reordering
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null); // Index where item will be inserted (shown as line)
  const [isCopyDrag, setIsCopyDrag] = useState(false);
  const [cursorPosition, setCursorPosition] = useState<{ x: number; y: number } | null>(null);

  // Refs to access current values in event handlers (avoids stale closure issues)
  const draggedIdRef = useRef(draggedId);
  const dropTargetIndexRef = useRef(dropTargetIndex);
  const isCopyDragRef = useRef(isCopyDrag);
  const dropPerformedRef = useRef(false); // Prevents double execution if both handleDrop and handleDragEnd fire
  draggedIdRef.current = draggedId;
  dropTargetIndexRef.current = dropTargetIndex;
  isCopyDragRef.current = isCopyDrag;

  // Calculate counts
  const totalTaskCount = documents.reduce((sum, doc) => {
    if (doc.isMissing) return sum;
    return sum + (taskCounts[doc.filename] || 0);
  }, 0);
  const missingDocCount = documents.filter(doc => doc.isMissing).length;
  const hasMissingDocs = missingDocCount > 0;

  // Document list handlers
  const handleRemoveDocument = useCallback((id: string) => {
    setDocuments(prev => prev.filter(d => d.id !== id));
  }, [setDocuments]);

  const handleToggleReset = useCallback((id: string) => {
    setDocuments(prev => prev.map(d =>
      d.id === id ? { ...d, resetOnCompletion: !d.resetOnCompletion } : d
    ));
  }, [setDocuments]);

  const handleDuplicateDocument = useCallback((id: string) => {
    setDocuments(prev => {
      const index = prev.findIndex(d => d.id === id);
      if (index === -1) return prev;

      const original = prev[index];
      const duplicate: BatchDocumentEntry = {
        id: generateId(),
        filename: original.filename,
        resetOnCompletion: original.resetOnCompletion,
        isDuplicate: true
      };

      return [
        ...prev.slice(0, index + 1),
        duplicate,
        ...prev.slice(index + 1)
      ];
    });
  }, [setDocuments]);

  const handleOpenDocSelector = useCallback(() => {
    setShowDocSelector(true);
  }, []);

  const handleAddSelectedDocs = useCallback((selectedDocs: Set<string>) => {
    const existingFilenames = new Set(documents.map(d => d.filename));

    const newDocs: BatchDocumentEntry[] = [];
    selectedDocs.forEach(filename => {
      if (!existingFilenames.has(filename)) {
        newDocs.push({
          id: generateId(),
          filename,
          resetOnCompletion: false,
          isDuplicate: false
        });
      }
    });

    const filteredDocs = documents.filter(d => selectedDocs.has(d.filename));
    setDocuments([...filteredDocs, ...newDocs]);
    setShowDocSelector(false);
  }, [documents, setDocuments]);

  // Drag and drop handlers
  const handleDragStart = useCallback((e: React.DragEvent, id: string) => {
    dropPerformedRef.current = false; // Reset for new drag operation
    const isCopy = e.ctrlKey || e.metaKey;
    setDraggedId(id);
    setIsCopyDrag(isCopy);
    e.dataTransfer.effectAllowed = isCopy ? 'copy' : 'move';
    setCursorPosition({ x: e.clientX, y: e.clientY });
  }, []);

  const handleDrag = useCallback((e: React.DragEvent) => {
    // Update cursor position during drag (for the floating plus icon)
    if (e.clientX !== 0 || e.clientY !== 0) {
      setCursorPosition({ x: e.clientX, y: e.clientY });
    }
    // Update copy state based on current modifier keys
    setIsCopyDrag(e.ctrlKey || e.metaKey);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, _id: string, index: number) => {
    e.preventDefault();
    const isCopy = e.ctrlKey || e.metaKey;
    setIsCopyDrag(isCopy);
    e.dataTransfer.dropEffect = isCopy ? 'copy' : 'move';

    const currentDraggedId = draggedIdRef.current;
    if (!currentDraggedId) return;

    // Determine drop position based on cursor position relative to element midpoint
    const rect = e.currentTarget.getBoundingClientRect();
    const dropIndex = e.clientY < rect.top + rect.height / 2 ? index : index + 1;

    // For copy mode, always show indicator. For move mode, only if position changes.
    if (isCopy) {
      setDropTargetIndex(dropIndex);
    } else {
      const draggedIndex = documents.findIndex(d => d.id === currentDraggedId);
      const isNewPosition = dropIndex !== draggedIndex && dropIndex !== draggedIndex + 1;
      setDropTargetIndex(isNewPosition ? dropIndex : null);
    }
  }, [documents]);

  // Note: We intentionally don't clear dropTargetIndex in dragLeave.
  // The browser fires dragleave events during normal operations including right before drop.
  // Cleanup happens in handleDrop or handleDragEnd.
  const handleDragLeave = useCallback(() => {}, []);

  // Shared logic for performing the drop operation (copy or move)
  const performDropOperation = useCallback(() => {
    const currentDraggedId = draggedIdRef.current;
    const currentDropTargetIndex = dropTargetIndexRef.current;
    const currentIsCopyDrag = isCopyDragRef.current;

    if (currentDraggedId && currentDropTargetIndex !== null && !dropPerformedRef.current) {
      dropPerformedRef.current = true;
      setDocuments(prev => {
        const draggedIndex = prev.findIndex(d => d.id === currentDraggedId);
        if (draggedIndex === -1) return prev;

        const items = [...prev];
        if (currentIsCopyDrag) {
          const original = items[draggedIndex];
          items.splice(currentDropTargetIndex, 0, {
            id: generateId(),
            filename: original.filename,
            resetOnCompletion: true,
            isDuplicate: true
          });
        } else {
          const [removed] = items.splice(draggedIndex, 1);
          const adjustedIndex = draggedIndex < currentDropTargetIndex
            ? currentDropTargetIndex - 1
            : currentDropTargetIndex;
          items.splice(adjustedIndex, 0, removed);
        }
        return items;
      });
    }
  }, [setDocuments]);

  const resetDragState = useCallback(() => {
    setDraggedId(null);
    setDropTargetIndex(null);
    setIsCopyDrag(false);
    setCursorPosition(null);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    performDropOperation();
    resetDragState();
  }, [performDropOperation, resetDragState]);

  const handleDragEnd = useCallback(() => {
    // Fallback: perform operation if handleDrop didn't fire (browser quirk)
    performDropOperation();
    resetDragState();
  }, [performDropOperation, resetDragState]);

  // Sync showMaxLoopsSlider when maxLoops prop changes externally
  useEffect(() => {
    setShowMaxLoopsSlider(maxLoops != null);
  }, [maxLoops]);

  return (
    <div className="mb-6">
      <div className="flex items-center justify-between mb-3">
        <label className="text-xs font-bold uppercase" style={{ color: theme.colors.textDim }}>
          Documents to Run
        </label>
        <button
          onClick={handleOpenDocSelector}
          className="flex items-center gap-1 text-xs px-2 py-1 rounded hover:bg-white/10 transition-colors"
          style={{ color: theme.colors.accent }}
        >
          <Plus className="w-3 h-3" />
          Add Docs
        </button>
      </div>

      {/* Document List with Loop Indicator */}
      <div className={`relative ${loopEnabled && documents.length > 1 ? 'ml-7' : ''}`}>
        {/* Loop path - right-angled lines from bottom around left to top */}
        {loopEnabled && documents.length > 1 && (
          <>
            {/* Left vertical line */}
            <div
              className="absolute pointer-events-none"
              style={{
                left: -24,
                top: 8,
                bottom: 8,
                width: 3,
                backgroundColor: theme.colors.accent,
                borderRadius: 1.5
              }}
            />
            {/* Top horizontal line - stops before document */}
            <div
              className="absolute pointer-events-none"
              style={{
                left: -24,
                top: 8,
                width: 18,
                height: 3,
                backgroundColor: theme.colors.accent,
                borderRadius: 1.5
              }}
            />
            {/* Bottom horizontal line - stops before document */}
            <div
              className="absolute pointer-events-none"
              style={{
                left: -24,
                bottom: 8,
                width: 18,
                height: 3,
                backgroundColor: theme.colors.accent,
                borderRadius: 1.5
              }}
            />
            {/* Arrow head pointing right (toward top doc) */}
            <div
              className="absolute pointer-events-none"
              style={{
                left: -10,
                top: 2,
                width: 0,
                height: 0,
                borderTop: '6px solid transparent',
                borderBottom: '6px solid transparent',
                borderLeft: `9px solid ${theme.colors.accent}`
              }}
            />
          </>
        )}
        <div
          className="rounded-lg border overflow-hidden"
          style={{ backgroundColor: theme.colors.bgMain, borderColor: theme.colors.border }}
        >
        {documents.length === 0 ? (
          <div className="p-4 text-center" style={{ color: theme.colors.textDim }}>
            <p className="text-sm">No documents selected</p>
            <p className="text-xs mt-1">Click "+ Add Docs" to select documents to run</p>
          </div>
        ) : (
          <div onDragLeave={handleDragLeave} onDrop={handleDrop} onDragOver={(e) => e.preventDefault()}>
            {documents.map((doc, index) => {
              const docTaskCount = taskCounts[doc.filename] ?? 0;
              const isBeingDragged = draggedId === doc.id;
              const showDropIndicatorBefore = dropTargetIndex === index && draggedId !== null;
              const showDropIndicatorAfter = dropTargetIndex === index + 1 && index === documents.length - 1 && draggedId !== null;

              return (
                <div key={doc.id} className="relative" style={index > 0 ? { borderTop: `1px solid ${theme.colors.border}22` } : undefined}>
                  {/* Drop Indicator Line - Before */}
                  {showDropIndicatorBefore && (
                    <div
                      className="absolute left-0 right-0 top-0 h-0.5 z-20 pointer-events-none"
                      style={{ backgroundColor: isCopyDrag ? theme.colors.success : theme.colors.accent }}
                    >
                      {/* Left circle */}
                      <div
                        className="absolute -left-1 -top-[3px] w-2 h-2 rounded-full"
                        style={{ backgroundColor: isCopyDrag ? theme.colors.success : theme.colors.accent }}
                      />
                      {/* Right circle */}
                      <div
                        className="absolute -right-1 -top-[3px] w-2 h-2 rounded-full"
                        style={{ backgroundColor: isCopyDrag ? theme.colors.success : theme.colors.accent }}
                      />
                    </div>
                  )}

                  <div
                    draggable={!doc.isMissing}
                    onDragStart={(e) => !doc.isMissing && handleDragStart(e, doc.id)}
                    onDrag={handleDrag}
                    onDragOver={(e) => handleDragOver(e, doc.id, index)}
                    onDrop={handleDrop}
                    onDragEnd={handleDragEnd}
                    className={`flex items-center gap-3 px-3 py-2 transition-all ${
                      isBeingDragged ? 'opacity-50' : ''
                    } hover:bg-white/5 ${
                      doc.isMissing ? 'opacity-60' : ''
                    }`}
                    style={{
                      backgroundColor: doc.isMissing ? theme.colors.error + '08' : undefined
                    }}
                  >
                    {/* Drag Handle */}
                    <GripVertical
                      className={`w-4 h-4 shrink-0 ${doc.isMissing ? 'cursor-not-allowed' : 'cursor-grab active:cursor-grabbing'}`}
                      style={{ color: doc.isMissing ? theme.colors.error + '60' : theme.colors.textDim }}
                    />

                    {/* Document Name */}
                    <span
                      className={`flex-1 text-sm font-medium truncate ${doc.isMissing ? 'line-through' : ''}`}
                      style={{ color: doc.isMissing ? theme.colors.error : theme.colors.textMain }}
                    >
                      {doc.filename}.md
                    </span>

                    {/* Missing Indicator */}
                    {doc.isMissing && (
                      <span
                        className="text-[10px] px-1.5 py-0.5 rounded shrink-0 uppercase font-bold"
                        style={{
                          backgroundColor: theme.colors.error + '20',
                          color: theme.colors.error
                        }}
                        title="This document no longer exists in the folder"
                      >
                        Missing
                      </span>
                    )}

                  {/* Task Count Badge (invisible placeholder for missing docs) */}
                  {!doc.isMissing ? (
                    <span
                      className="text-xs px-2 py-0.5 rounded shrink-0"
                      style={{
                        backgroundColor: docTaskCount === 0 ? theme.colors.error + '20' : theme.colors.success + '20',
                        color: docTaskCount === 0 ? theme.colors.error : theme.colors.success
                      }}
                    >
                      {loadingTaskCounts ? '...' : `${docTaskCount} ${docTaskCount === 1 ? 'task' : 'tasks'}`}
                    </span>
                  ) : (
                    <span className="text-xs px-2 py-0.5 shrink-0 invisible">0 tasks</span>
                  )}

                  {/* Reset Toggle Button (invisible placeholder for missing docs) */}
                  {!doc.isMissing ? (() => {
                    const hasDuplicates = documents.filter(d => d.filename === doc.filename).length > 1;
                    const canDisableReset = !hasDuplicates;

                    const modifierKey = isMacPlatform() ? '⌘' : 'Ctrl';
                    let tooltipText: string;
                    if (doc.resetOnCompletion) {
                      if (canDisableReset) {
                        tooltipText = 'Reset enabled: uncompleted tasks will be re-checked when done. Click to disable.';
                      } else {
                        tooltipText = 'Reset enabled: uncompleted tasks will be re-checked when done. Remove duplicates to disable.';
                      }
                    } else {
                      tooltipText = `Enable reset, or ${modifierKey}+drag to copy`;
                    }

                    return (
                      <button
                        onClick={() => {
                          if (!doc.resetOnCompletion || canDisableReset) {
                            handleToggleReset(doc.id);
                          }
                        }}
                        className={`p-1 rounded transition-colors shrink-0 ${
                          doc.resetOnCompletion
                            ? (canDisableReset ? 'hover:bg-white/10' : 'cursor-not-allowed')
                            : 'hover:bg-white/10'
                        }`}
                        style={{
                          backgroundColor: doc.resetOnCompletion ? theme.colors.accent + '20' : 'transparent',
                          color: doc.resetOnCompletion ? theme.colors.accent : theme.colors.textDim,
                          opacity: doc.resetOnCompletion && !canDisableReset ? 0.7 : 1
                        }}
                        title={tooltipText}
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                      </button>
                    );
                  })() : (
                    <span className="p-1 shrink-0 invisible"><RotateCcw className="w-3.5 h-3.5" /></span>
                  )}

                  {/* Duplicate Button (invisible placeholder when not applicable) */}
                  {doc.resetOnCompletion && !doc.isMissing ? (
                    <button
                      onClick={() => handleDuplicateDocument(doc.id)}
                      className="p-1 rounded hover:bg-white/10 transition-colors shrink-0"
                      style={{ color: theme.colors.textDim }}
                      title="Duplicate document"
                    >
                      <Plus className="w-3.5 h-3.5" />
                    </button>
                  ) : (
                    <span className="p-1 shrink-0 invisible"><Plus className="w-3.5 h-3.5" /></span>
                  )}

                  {/* Remove Button (invisible placeholder when not applicable) */}
                  {(doc.isDuplicate || documents.length > 1 || doc.isMissing) ? (
                    <button
                      onClick={() => handleRemoveDocument(doc.id)}
                      className="p-1 rounded hover:bg-white/10 transition-colors shrink-0"
                      style={{ color: doc.isMissing ? theme.colors.error : theme.colors.textDim }}
                      title={doc.isMissing ? 'Remove missing document' : 'Remove document'}
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  ) : (
                    <span className="p-1 shrink-0 invisible"><X className="w-3.5 h-3.5" /></span>
                  )}
                  </div>

                  {/* Drop Indicator Line - After (only for last item) */}
                  {showDropIndicatorAfter && (
                    <div
                      className="absolute left-0 right-0 bottom-0 h-0.5 z-20 pointer-events-none"
                      style={{ backgroundColor: isCopyDrag ? theme.colors.success : theme.colors.accent }}
                    >
                      {/* Left circle */}
                      <div
                        className="absolute -left-1 -top-[3px] w-2 h-2 rounded-full"
                        style={{ backgroundColor: isCopyDrag ? theme.colors.success : theme.colors.accent }}
                      />
                      {/* Right circle */}
                      <div
                        className="absolute -right-1 -top-[3px] w-2 h-2 rounded-full"
                        style={{ backgroundColor: isCopyDrag ? theme.colors.success : theme.colors.accent }}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        </div>
      </div>

      {/* Hint for enabling loop mode */}
      {documents.length === 1 && (
        <p className="mt-1.5 text-xs text-center" style={{ color: theme.colors.textDim }}>
          You can enable loops with two or more documents
        </p>
      )}

      {/* Missing Documents Warning */}
      {hasMissingDocs && (
        <div
          className="mt-2 flex items-center gap-2 p-2 rounded border text-xs"
          style={{
            backgroundColor: theme.colors.warning + '10',
            borderColor: theme.colors.warning + '40',
            color: theme.colors.warning
          }}
        >
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span>
            {missingDocCount} document{missingDocCount > 1 ? 's' : ''} no longer exist{missingDocCount === 1 ? 's' : ''} in the folder and will be skipped
          </span>
        </div>
      )}

      {/* Total Summary with Loop Button */}
      {documents.length > 1 && (
        <div className="mt-2 flex items-center justify-between">
          {/* Loop Mode Toggle with Max Loops Control */}
          <div className="flex items-center gap-2">
            {/* Loop Toggle Button */}
            <button
              onClick={() => setLoopEnabled(!loopEnabled)}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border transition-colors ${
                loopEnabled ? 'border-accent' : 'border-border hover:bg-white/5'
              }`}
              style={{
                borderColor: loopEnabled ? theme.colors.accent : theme.colors.border,
                backgroundColor: loopEnabled ? theme.colors.accent + '15' : 'transparent'
              }}
              title="Loop back to first document when finished"
            >
              <Repeat
                className="w-3.5 h-3.5"
                style={{ color: loopEnabled ? theme.colors.accent : theme.colors.textDim }}
              />
              <span
                className="text-xs font-medium"
                style={{ color: loopEnabled ? theme.colors.accent : theme.colors.textMain }}
              >
                Loop
              </span>
            </button>

            {/* Max Loops Control - only shown when loop is enabled */}
            {loopEnabled && (
              <div
                className="flex items-center rounded-lg border overflow-hidden"
                style={{ borderColor: theme.colors.border }}
              >
                {/* Infinity Toggle */}
                <button
                  onClick={() => {
                    setShowMaxLoopsSlider(false);
                    setMaxLoops(null);
                  }}
                  className={`px-2.5 py-1 text-xs font-medium transition-colors ${
                    !showMaxLoopsSlider ? 'bg-white/10' : 'hover:bg-white/5'
                  }`}
                  style={{
                    color: !showMaxLoopsSlider ? theme.colors.accent : theme.colors.textDim
                  }}
                  title="Loop forever until all tasks complete"
                >
                  <span className="text-xl leading-none">∞</span>
                </button>
                {/* Max Toggle */}
                <button
                  onClick={() => {
                    setShowMaxLoopsSlider(true);
                    if (maxLoops === null) {
                      setMaxLoops(5);
                    }
                  }}
                  className={`px-2.5 py-1 text-xs font-medium transition-colors border-l ${
                    showMaxLoopsSlider ? 'bg-white/10' : 'hover:bg-white/5'
                  }`}
                  style={{
                    color: showMaxLoopsSlider ? theme.colors.accent : theme.colors.textDim,
                    borderColor: theme.colors.border
                  }}
                  title="Set maximum loop iterations"
                >
                  max
                </button>
              </div>
            )}

            {/* Slider for max loops - shown when max is selected */}
            {loopEnabled && showMaxLoopsSlider && (
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min="1"
                  max="25"
                  value={maxLoops ?? 5}
                  onChange={(e) => setMaxLoops(parseInt(e.target.value))}
                  className="w-32 h-1 rounded-lg appearance-none cursor-pointer"
                  style={{
                    background: `linear-gradient(to right, ${theme.colors.accent} 0%, ${theme.colors.accent} ${((maxLoops ?? 5) / 25) * 100}%, ${theme.colors.border} ${((maxLoops ?? 5) / 25) * 100}%, ${theme.colors.border} 100%)`
                  }}
                />
                <span
                  className="text-xs font-mono w-6 text-center"
                  style={{ color: theme.colors.accent }}
                >
                  {maxLoops}
                </span>
              </div>
            )}
          </div>
          <span className="text-xs" style={{ color: theme.colors.textDim }}>
            Total: {loadingTaskCounts ? '...' : totalTaskCount} tasks across {documents.length - missingDocCount} {hasMissingDocs ? 'available ' : ''}document{documents.length - missingDocCount !== 1 ? 's' : ''}
            {hasMissingDocs && ` (${missingDocCount} missing)`}
          </span>
        </div>
      )}

      {/* Document Selector Modal */}
      {showDocSelector && (
        <DocumentSelectorModal
          theme={theme}
          allDocuments={allDocuments}
          documentTree={documentTree}
          taskCounts={taskCounts}
          loadingTaskCounts={loadingTaskCounts}
          documents={documents}
          onClose={() => setShowDocSelector(false)}
          onAdd={handleAddSelectedDocs}
          onRefresh={onRefreshDocuments}
        />
      )}

      {/* Floating Plus Icon (follows cursor during copy drag) */}
      {isCopyDrag && cursorPosition && (
        <div
          className="fixed pointer-events-none z-[10001] flex items-center justify-center"
          style={{
            left: cursorPosition.x + 16,
            top: cursorPosition.y + 16,
            width: 24,
            height: 24,
            borderRadius: '50%',
            backgroundColor: theme.colors.success,
            boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
          }}
        >
          <Plus className="w-4 h-4 stroke-2" style={{ color: theme.colors.bgMain }} />
        </div>
      )}
    </div>
  );
}
