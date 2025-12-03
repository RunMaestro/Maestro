import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { X, RotateCcw, Play, Variable, ChevronDown, ChevronRight, Save, GripVertical, Plus, Repeat, FolderOpen, Bookmark, GitBranch, AlertTriangle } from 'lucide-react';
import type { Theme, BatchDocumentEntry, BatchRunConfig, Playbook, PlaybookDocumentEntry, WorktreeConfig } from '../types';
import { useLayerStack } from '../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { TEMPLATE_VARIABLES } from '../utils/templateVariables';
import { PlaybookDeleteConfirmModal } from './PlaybookDeleteConfirmModal';
import { PlaybookNameModal } from './PlaybookNameModal';

// Default batch processing prompt
export const DEFAULT_BATCH_PROMPT = `CRITICAL: You must complete EXACTLY ONE task and then exit. Do not attempt multiple tasks.

Your responsibilities are as follows:

1. Project Orientation
    Begin by reviewing claude.md in this folder to understand the project's structure, conventions, and workflow expectations.

2. Task Selection
    Navigate to $$SCRATCHPAD$$ and select the FIRST unchecked task (- [ ]) from top to bottom. Note that there may be relevant images associated with the task, analyze them, and include in your final synopsis back how many images you analyzed in preparation for solving the task.

    IMPORTANT: You will only work on this single task. If it appears to have logical subtasks, treat them as one cohesive unit—but do not move on to the next top-level task.

3. Task Evaluation
    - Fully understand the task and inspect the relevant code.
    - If you determine the task should not be executed, mark it as completed anyway and record a concise explanation of why it was skipped.

4. Task Implementation
    Implement the task according to the project's established style, architecture, and coding norms.

5. Completion + Reporting
    - Mark the task as completed in the scratchpad by changing - [ ] to - [x].
    - CRITICAL: Your FIRST sentence MUST be a specific synopsis of what you accomplished (e.g., "Added pagination to the user list component" or "Refactored auth middleware to use JWT tokens"). Never start with generic phrases like "Task completed successfully" - always lead with the specific work done.
    - Follow with any relevant details about:
      - Implementation approach or key decisions made
      - Why the task was intentionally skipped (if applicable)
      - If implementation failed, explain the failure and do NOT check off the item.

6. Version Control
    For any code or documentation changes:
    - Commit using a descriptive message prefixed with MAESTRO:.
    - Push to GitHub.
    - Update claude.md, README.md, or any other top-level documentation if appropriate.

7. Exit Immediately
    After completing (or skipping) the single task, EXIT. Do not proceed to additional tasks—another agent instance will handle them.

NOTE: If you see a clear issue tag like a little moniker or some short form in front of the task, then your synopsis message should start with that exact token because we're clearly using it as a unique identifier.

If there are no remaining open tasks, exit immediately and state that there is nothing left to do.`;

interface BatchRunnerModalProps {
  theme: Theme;
  onClose: () => void;
  onGo: (config: BatchRunConfig) => void;
  onSave: (prompt: string) => void;
  initialPrompt?: string;
  lastModifiedAt?: number;
  showConfirmation: (message: string, onConfirm: () => void) => void;
  // Multi-document support
  folderPath: string;
  currentDocument: string;
  allDocuments: string[]; // All available docs in folder (without .md)
  getDocumentTaskCount: (filename: string) => Promise<number>; // Get task count for a document
  // Session ID for playbook storage
  sessionId: string;
  // Session cwd for git worktree support
  sessionCwd: string;
}

// Helper function to count unchecked tasks in scratchpad content
function countUncheckedTasks(content: string): number {
  if (!content) return 0;
  const matches = content.match(/^-\s*\[\s*\]/gm);
  return matches ? matches.length : 0;
}

// Helper function to format the last modified date
function formatLastModified(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    return `today at ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  } else if (diffDays === 1) {
    return `yesterday at ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  } else if (diffDays < 7) {
    return `${diffDays} days ago`;
  } else {
    return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  }
}

export function BatchRunnerModal(props: BatchRunnerModalProps) {
  const {
    theme,
    onClose,
    onGo,
    onSave,
    initialPrompt,
    lastModifiedAt,
    showConfirmation,
    folderPath,
    currentDocument,
    allDocuments,
    getDocumentTaskCount,
    sessionId,
    sessionCwd
  } = props;

  // Document list state
  const [documents, setDocuments] = useState<BatchDocumentEntry[]>(() => {
    // Initialize with current document
    if (currentDocument) {
      return [{
        id: crypto.randomUUID(),
        filename: currentDocument,
        resetOnCompletion: false,
        isDuplicate: false
      }];
    }
    return [];
  });

  // Task counts per document (keyed by filename)
  const [taskCounts, setTaskCounts] = useState<Record<string, number>>({});
  const [loadingTaskCounts, setLoadingTaskCounts] = useState(true);

  // Document selector modal state
  const [showDocSelector, setShowDocSelector] = useState(false);
  const [selectedDocsInSelector, setSelectedDocsInSelector] = useState<Set<string>>(new Set());

  // Loop mode state
  const [loopEnabled, setLoopEnabled] = useState(false);

  // Prompt state
  const [prompt, setPrompt] = useState(initialPrompt || DEFAULT_BATCH_PROMPT);
  const [variablesExpanded, setVariablesExpanded] = useState(false);
  const [savedPrompt, setSavedPrompt] = useState(initialPrompt || '');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Drag state for reordering
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  // Playbook state
  const [playbooks, setPlaybooks] = useState<Playbook[]>([]);
  const [loadedPlaybook, setLoadedPlaybook] = useState<Playbook | null>(null);
  const [loadingPlaybooks, setLoadingPlaybooks] = useState(true);
  const [showPlaybookDropdown, setShowPlaybookDropdown] = useState(false);
  const [showSavePlaybookModal, setShowSavePlaybookModal] = useState(false);
  const [savingPlaybook, setSavingPlaybook] = useState(false);
  const [showDeleteConfirmModal, setShowDeleteConfirmModal] = useState(false);
  const [playbookToDelete, setPlaybookToDelete] = useState<Playbook | null>(null);
  const playbackDropdownRef = useRef<HTMLDivElement>(null);

  // Git worktree state - only show worktree section for git repos
  const [isGitRepo, setIsGitRepo] = useState(false);
  const [checkingGitRepo, setCheckingGitRepo] = useState(true);

  // Worktree configuration state
  const [worktreeEnabled, setWorktreeEnabled] = useState(false);
  const [worktreePath, setWorktreePath] = useState('');
  const [branchName, setBranchName] = useState('');
  const [createPROnCompletion, setCreatePROnCompletion] = useState(false);

  // Worktree validation state
  const [worktreeValidation, setWorktreeValidation] = useState<{
    checking: boolean;
    exists: boolean;
    isWorktree: boolean;
    currentBranch?: string;
    branchMismatch: boolean;
    sameRepo: boolean;
    error?: string;
  }>({ checking: false, exists: false, isWorktree: false, branchMismatch: false, sameRepo: true });

  const { registerLayer, unregisterLayer, updateLayerHandler } = useLayerStack();
  const layerIdRef = useRef<string>();

  // Load task counts for all documents
  useEffect(() => {
    const loadTaskCounts = async () => {
      setLoadingTaskCounts(true);
      const counts: Record<string, number> = {};

      for (const doc of allDocuments) {
        try {
          counts[doc] = await getDocumentTaskCount(doc);
        } catch {
          counts[doc] = 0;
        }
      }

      setTaskCounts(counts);
      setLoadingTaskCounts(false);
    };

    loadTaskCounts();
  }, [allDocuments, getDocumentTaskCount]);

  // Load playbooks on mount
  useEffect(() => {
    const loadPlaybooks = async () => {
      setLoadingPlaybooks(true);
      try {
        const result = await window.maestro.playbooks.list(sessionId);
        if (result.success) {
          setPlaybooks(result.playbooks);
        }
      } catch (error) {
        console.error('Failed to load playbooks:', error);
      }
      setLoadingPlaybooks(false);
    };

    loadPlaybooks();
  }, [sessionId]);

  // Check if session cwd is a git repo on mount (for worktree support)
  useEffect(() => {
    const checkGitRepo = async () => {
      setCheckingGitRepo(true);
      try {
        const result = await window.maestro.git.isRepo(sessionCwd);
        setIsGitRepo(result === true);
      } catch (error) {
        console.error('Failed to check if git repo:', error);
        setIsGitRepo(false);
      }
      setCheckingGitRepo(false);
    };

    checkGitRepo();
  }, [sessionCwd]);

  // Calculate total tasks across selected documents
  const totalTaskCount = documents.reduce((sum, doc) => sum + (taskCounts[doc.filename] || 0), 0);
  const hasNoTasks = totalTaskCount === 0;

  // Track if the current configuration differs from the loaded playbook
  const isPlaybookModified = useMemo(() => {
    if (!loadedPlaybook) return false;

    // Compare documents
    const currentDocs = documents.map(d => ({
      filename: d.filename,
      resetOnCompletion: d.resetOnCompletion
    }));
    const savedDocs = loadedPlaybook.documents;

    if (currentDocs.length !== savedDocs.length) return true;
    for (let i = 0; i < currentDocs.length; i++) {
      if (currentDocs[i].filename !== savedDocs[i].filename ||
          currentDocs[i].resetOnCompletion !== savedDocs[i].resetOnCompletion) {
        return true;
      }
    }

    // Compare loop setting
    if (loopEnabled !== loadedPlaybook.loopEnabled) return true;

    // Compare prompt
    if (prompt !== loadedPlaybook.prompt) return true;

    return false;
  }, [documents, loopEnabled, prompt, loadedPlaybook]);

  // Register layer on mount
  useEffect(() => {
    const id = registerLayer({
      type: 'modal',
      priority: MODAL_PRIORITIES.BATCH_RUNNER,
      onEscape: () => {
        if (showDeleteConfirmModal) {
          setShowDeleteConfirmModal(false);
          setPlaybookToDelete(null);
        } else if (showSavePlaybookModal) {
          setShowSavePlaybookModal(false);
        } else if (showDocSelector) {
          setShowDocSelector(false);
        } else {
          onClose();
        }
      }
    });
    layerIdRef.current = id;

    return () => {
      if (layerIdRef.current) {
        unregisterLayer(layerIdRef.current);
      }
    };
  }, [registerLayer, unregisterLayer, showDocSelector, showSavePlaybookModal, showDeleteConfirmModal]);

  // Update handler when dependencies change
  useEffect(() => {
    if (layerIdRef.current) {
      updateLayerHandler(layerIdRef.current, () => {
        if (showDeleteConfirmModal) {
          setShowDeleteConfirmModal(false);
          setPlaybookToDelete(null);
        } else if (showSavePlaybookModal) {
          setShowSavePlaybookModal(false);
        } else if (showDocSelector) {
          setShowDocSelector(false);
        } else {
          onClose();
        }
      });
    }
  }, [onClose, updateLayerHandler, showDocSelector, showSavePlaybookModal, showDeleteConfirmModal]);

  // Focus textarea on mount (if not showing doc selector)
  useEffect(() => {
    if (!showDocSelector) {
      setTimeout(() => textareaRef.current?.focus(), 100);
    }
  }, [showDocSelector]);

  const handleReset = () => {
    showConfirmation(
      'Reset the prompt to the default? Your customizations will be lost.',
      () => {
        setPrompt(DEFAULT_BATCH_PROMPT);
      }
    );
  };

  const handleSave = () => {
    onSave(prompt);
    setSavedPrompt(prompt);
  };

  const handleGo = () => {
    // Also save when running
    onSave(prompt);

    // Build config with optional worktree settings
    const config: BatchRunConfig = {
      documents,
      prompt,
      loopEnabled
    };

    // Add worktree config if enabled and valid
    if (worktreeEnabled && isGitRepo && worktreePath && branchName) {
      config.worktree = {
        enabled: true,
        path: worktreePath,
        branchName,
        createPROnCompletion
      };
    }

    onGo(config);
    onClose();
  };

  // Document list handlers
  const handleRemoveDocument = useCallback((id: string) => {
    setDocuments(prev => prev.filter(d => d.id !== id));
  }, []);

  const handleToggleReset = useCallback((id: string) => {
    setDocuments(prev => prev.map(d =>
      d.id === id ? { ...d, resetOnCompletion: !d.resetOnCompletion } : d
    ));
  }, []);

  const handleDuplicateDocument = useCallback((id: string) => {
    setDocuments(prev => {
      const index = prev.findIndex(d => d.id === id);
      if (index === -1) return prev;

      const original = prev[index];
      const duplicate: BatchDocumentEntry = {
        id: crypto.randomUUID(),
        filename: original.filename,
        resetOnCompletion: original.resetOnCompletion, // Inherit reset setting
        isDuplicate: true
      };

      // Insert duplicate immediately after the original
      return [
        ...prev.slice(0, index + 1),
        duplicate,
        ...prev.slice(index + 1)
      ];
    });
  }, []);

  const handleOpenDocSelector = useCallback(() => {
    // Pre-select currently added documents
    const currentFilenames = new Set(documents.map(d => d.filename));
    setSelectedDocsInSelector(currentFilenames);
    setShowDocSelector(true);
  }, [documents]);

  const handleAddSelectedDocs = useCallback(() => {
    // Get filenames already in the list
    const existingFilenames = new Set(documents.map(d => d.filename));

    // Add new documents that are selected but not already in list
    const newDocs: BatchDocumentEntry[] = [];
    selectedDocsInSelector.forEach(filename => {
      if (!existingFilenames.has(filename)) {
        newDocs.push({
          id: crypto.randomUUID(),
          filename,
          resetOnCompletion: false,
          isDuplicate: false
        });
      }
    });

    // Also remove documents that were deselected
    const filteredDocs = documents.filter(d => selectedDocsInSelector.has(d.filename));

    setDocuments([...filteredDocs, ...newDocs]);
    setShowDocSelector(false);
  }, [documents, selectedDocsInSelector]);

  // Drag and drop handlers
  const handleDragStart = useCallback((e: React.DragEvent, id: string) => {
    setDraggedId(id);
    e.dataTransfer.effectAllowed = 'move';
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, id: string) => {
    e.preventDefault();
    if (draggedId && draggedId !== id) {
      setDragOverId(id);
    }
  }, [draggedId]);

  const handleDragEnd = useCallback(() => {
    if (draggedId && dragOverId && draggedId !== dragOverId) {
      setDocuments(prev => {
        const items = [...prev];
        const draggedIndex = items.findIndex(d => d.id === draggedId);
        const targetIndex = items.findIndex(d => d.id === dragOverId);

        if (draggedIndex !== -1 && targetIndex !== -1) {
          const [removed] = items.splice(draggedIndex, 1);
          items.splice(targetIndex, 0, removed);
        }

        return items;
      });
    }
    setDraggedId(null);
    setDragOverId(null);
  }, [draggedId, dragOverId]);

  const isModified = prompt !== DEFAULT_BATCH_PROMPT;
  const hasUnsavedChanges = prompt !== savedPrompt && prompt !== DEFAULT_BATCH_PROMPT;

  // Toggle document selection in the selector modal
  const toggleDocInSelector = useCallback((filename: string) => {
    setSelectedDocsInSelector(prev => {
      const next = new Set(prev);
      if (next.has(filename)) {
        next.delete(filename);
      } else {
        next.add(filename);
      }
      return next;
    });
  }, []);

  // Handle loading a playbook
  const handleLoadPlaybook = useCallback((playbook: Playbook) => {
    // Convert stored entries to BatchDocumentEntry with IDs
    const entries: BatchDocumentEntry[] = playbook.documents.map((doc, index) => ({
      id: crypto.randomUUID(),
      filename: doc.filename,
      resetOnCompletion: doc.resetOnCompletion,
      // Mark as duplicate if same filename appears earlier
      isDuplicate: playbook.documents.slice(0, index).some(d => d.filename === doc.filename)
    }));

    setDocuments(entries);
    setLoopEnabled(playbook.loopEnabled);
    setPrompt(playbook.prompt);
    setLoadedPlaybook(playbook);
    setShowPlaybookDropdown(false);
  }, []);

  // Handle opening the delete confirmation modal
  const handleDeletePlaybook = useCallback((playbook: Playbook, e: React.MouseEvent) => {
    e.stopPropagation();
    setPlaybookToDelete(playbook);
    setShowDeleteConfirmModal(true);
  }, []);

  // Handle confirming the delete action
  const handleConfirmDeletePlaybook = useCallback(async () => {
    if (!playbookToDelete) return;

    try {
      const result = await window.maestro.playbooks.delete(sessionId, playbookToDelete.id);
      if (result.success) {
        setPlaybooks(prev => prev.filter(p => p.id !== playbookToDelete.id));
        // If the deleted playbook was loaded, clear it
        if (loadedPlaybook?.id === playbookToDelete.id) {
          setLoadedPlaybook(null);
        }
      }
    } catch (error) {
      console.error('Failed to delete playbook:', error);
    }

    setShowDeleteConfirmModal(false);
    setPlaybookToDelete(null);
  }, [sessionId, playbookToDelete, loadedPlaybook]);

  // Handle canceling the delete action
  const handleCancelDeletePlaybook = useCallback(() => {
    setShowDeleteConfirmModal(false);
    setPlaybookToDelete(null);
  }, []);

  // Handle saving a new playbook
  const handleSaveAsPlaybook = useCallback(async (name: string) => {
    if (savingPlaybook) return;

    setSavingPlaybook(true);
    try {
      const result = await window.maestro.playbooks.create(sessionId, {
        name,
        documents: documents.map(d => ({
          filename: d.filename,
          resetOnCompletion: d.resetOnCompletion
        })),
        loopEnabled,
        prompt
      });

      if (result.success) {
        setPlaybooks(prev => [...prev, result.playbook]);
        setLoadedPlaybook(result.playbook);
        setShowSavePlaybookModal(false);
      }
    } catch (error) {
      console.error('Failed to save playbook:', error);
    }
    setSavingPlaybook(false);
  }, [sessionId, documents, loopEnabled, prompt, savingPlaybook]);

  // Handle updating an existing playbook
  const handleSaveUpdate = useCallback(async () => {
    if (!loadedPlaybook || savingPlaybook) return;

    setSavingPlaybook(true);
    try {
      const result = await window.maestro.playbooks.update(sessionId, loadedPlaybook.id, {
        documents: documents.map(d => ({
          filename: d.filename,
          resetOnCompletion: d.resetOnCompletion
        })),
        loopEnabled,
        prompt,
        updatedAt: Date.now()
      });

      if (result.success) {
        setLoadedPlaybook(result.playbook);
        setPlaybooks(prev => prev.map(p => p.id === result.playbook.id ? result.playbook : p));
      }
    } catch (error) {
      console.error('Failed to update playbook:', error);
    }
    setSavingPlaybook(false);
  }, [sessionId, loadedPlaybook, documents, loopEnabled, prompt, savingPlaybook]);

  // Handle discarding changes and reloading original playbook configuration
  const handleDiscardChanges = useCallback(() => {
    if (loadedPlaybook) {
      handleLoadPlaybook(loadedPlaybook);
    }
  }, [loadedPlaybook, handleLoadPlaybook]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (playbackDropdownRef.current && !playbackDropdownRef.current.contains(e.target as Node)) {
        setShowPlaybookDropdown(false);
      }
    };

    if (showPlaybookDropdown) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showPlaybookDropdown]);

  return (
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-[9999] animate-in fade-in duration-200"
      role="dialog"
      aria-modal="true"
      aria-label="Batch Runner"
      tabIndex={-1}
    >
      <div
        className="w-[700px] max-h-[85vh] border rounded-lg shadow-2xl overflow-hidden flex flex-col"
        style={{ backgroundColor: theme.colors.bgSidebar, borderColor: theme.colors.border }}
      >
        {/* Header */}
        <div className="p-4 border-b flex items-center justify-between shrink-0" style={{ borderColor: theme.colors.border }}>
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-3">
              <h2 className="text-sm font-bold" style={{ color: theme.colors.textMain }}>
                Batch Run Configuration
              </h2>
              {isModified && (
                <span
                  className="text-[10px] px-2 py-0.5 rounded-full"
                  style={{ backgroundColor: theme.colors.accent + '20', color: theme.colors.accent }}
                >
                  CUSTOMIZED
                </span>
              )}
            </div>
            {isModified && lastModifiedAt && (
              <span className="text-[10px]" style={{ color: theme.colors.textDim }}>
                Last modified {formatLastModified(lastModifiedAt)}
              </span>
            )}
          </div>
          <div className="flex items-center gap-4">
            {/* Total Task Count Badge */}
            <div
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg"
              style={{
                backgroundColor: hasNoTasks ? theme.colors.error + '20' : theme.colors.success + '20',
                border: `1px solid ${hasNoTasks ? theme.colors.error + '40' : theme.colors.success + '40'}`
              }}
            >
              <span
                className="text-lg font-bold"
                style={{ color: hasNoTasks ? theme.colors.error : theme.colors.success }}
              >
                {loadingTaskCounts ? '...' : totalTaskCount}
              </span>
              <span
                className="text-xs font-medium"
                style={{ color: hasNoTasks ? theme.colors.error : theme.colors.success }}
              >
                {totalTaskCount === 1 ? 'task' : 'tasks'}
              </span>
            </div>
            <button onClick={onClose} style={{ color: theme.colors.textDim }}>
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {/* Playbook Section */}
          <div className="mb-6 flex items-center justify-between">
            {/* Load Playbook Dropdown */}
            <div className="relative" ref={playbackDropdownRef}>
              <button
                onClick={() => setShowPlaybookDropdown(!showPlaybookDropdown)}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg border hover:bg-white/5 transition-colors"
                style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
                disabled={loadingPlaybooks}
              >
                <FolderOpen className="w-4 h-4" style={{ color: theme.colors.accent }} />
                <span className="text-sm">
                  {loadedPlaybook ? loadedPlaybook.name : 'Load Playbook'}
                </span>
                <ChevronDown className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
              </button>

              {/* Dropdown Menu */}
              {showPlaybookDropdown && (
                <div
                  className="absolute top-full left-0 mt-1 w-64 rounded-lg border shadow-lg z-10 overflow-hidden"
                  style={{ backgroundColor: theme.colors.bgSidebar, borderColor: theme.colors.border }}
                >
                  {playbooks.length === 0 ? (
                    <div className="px-4 py-3 text-center" style={{ color: theme.colors.textDim }}>
                      <p className="text-sm">No saved playbooks</p>
                      <p className="text-xs mt-1">Save a configuration to create one</p>
                    </div>
                  ) : (
                    <div className="max-h-48 overflow-y-auto">
                      {playbooks.map((pb) => (
                        <div
                          key={pb.id}
                          className={`flex items-center gap-2 px-3 py-2 hover:bg-white/5 cursor-pointer transition-colors ${
                            loadedPlaybook?.id === pb.id ? 'bg-white/10' : ''
                          }`}
                          onClick={() => handleLoadPlaybook(pb)}
                        >
                          <span
                            className="flex-1 text-sm truncate"
                            style={{ color: theme.colors.textMain }}
                          >
                            {pb.name}
                          </span>
                          <span
                            className="text-[10px] shrink-0"
                            style={{ color: theme.colors.textDim }}
                          >
                            {pb.documents.length} doc{pb.documents.length !== 1 ? 's' : ''}
                          </span>
                          <button
                            onClick={(e) => handleDeletePlaybook(pb, e)}
                            className="p-1 rounded hover:bg-white/10 transition-colors shrink-0"
                            style={{ color: theme.colors.textDim }}
                            title="Delete playbook"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Right side: Save as Playbook OR Save Update/Discard buttons */}
            <div className="flex items-center gap-2">
              {/* Save as Playbook button - shown when >1 doc and no playbook loaded */}
              {documents.length > 1 && !loadedPlaybook && (
                <button
                  onClick={() => setShowSavePlaybookModal(true)}
                  className="flex items-center gap-2 px-3 py-1.5 rounded-lg border hover:bg-white/5 transition-colors"
                  style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
                >
                  <Bookmark className="w-4 h-4" style={{ color: theme.colors.accent }} />
                  <span className="text-sm">Save as Playbook</span>
                </button>
              )}

              {/* Save Update and Discard buttons - shown when playbook is loaded and modified */}
              {loadedPlaybook && isPlaybookModified && (
                <>
                  <button
                    onClick={handleDiscardChanges}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border hover:bg-white/5 transition-colors"
                    style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
                    title="Discard changes and reload original playbook configuration"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    <span className="text-sm">Discard</span>
                  </button>
                  <button
                    onClick={handleSaveUpdate}
                    disabled={savingPlaybook}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border hover:bg-white/5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    style={{ borderColor: theme.colors.accent, color: theme.colors.accent }}
                    title="Save changes to the loaded playbook"
                  >
                    <Save className="w-3.5 h-3.5" />
                    <span className="text-sm">{savingPlaybook ? 'Saving...' : 'Save Update'}</span>
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Documents Section */}
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

            {/* Document List */}
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
                <div className="divide-y" style={{ borderColor: theme.colors.border }}>
                  {documents.map((doc) => {
                    const docTaskCount = taskCounts[doc.filename] ?? 0;
                    const isBeingDragged = draggedId === doc.id;
                    const isDragTarget = dragOverId === doc.id;

                    return (
                      <div
                        key={doc.id}
                        draggable
                        onDragStart={(e) => handleDragStart(e, doc.id)}
                        onDragOver={(e) => handleDragOver(e, doc.id)}
                        onDragEnd={handleDragEnd}
                        className={`flex items-center gap-3 px-3 py-2 transition-all ${
                          isBeingDragged ? 'opacity-50' : ''
                        } ${isDragTarget ? 'bg-white/10' : 'hover:bg-white/5'}`}
                        style={{ borderColor: theme.colors.border }}
                      >
                        {/* Drag Handle */}
                        <GripVertical
                          className="w-4 h-4 cursor-grab active:cursor-grabbing shrink-0"
                          style={{ color: theme.colors.textDim }}
                        />

                        {/* Document Name */}
                        <span
                          className="flex-1 text-sm font-medium truncate"
                          style={{ color: theme.colors.textMain }}
                        >
                          {doc.filename}
                        </span>

                        {/* Reset Indicator (shown when reset is enabled) */}
                        {doc.resetOnCompletion && (
                          <RotateCcw
                            className="w-3.5 h-3.5 shrink-0"
                            style={{ color: theme.colors.accent }}
                            title="Resets on completion"
                          />
                        )}

                        {/* Task Count Badge */}
                        <span
                          className="text-xs px-2 py-0.5 rounded shrink-0"
                          style={{
                            backgroundColor: docTaskCount === 0 ? theme.colors.error + '20' : theme.colors.success + '20',
                            color: docTaskCount === 0 ? theme.colors.error : theme.colors.success
                          }}
                        >
                          {loadingTaskCounts ? '...' : `${docTaskCount} ${docTaskCount === 1 ? 'task' : 'tasks'}`}
                        </span>

                        {/* Reset Toggle Button */}
                        <button
                          onClick={() => handleToggleReset(doc.id)}
                          className={`p-1 rounded transition-colors shrink-0 ${
                            doc.resetOnCompletion ? '' : 'hover:bg-white/10'
                          }`}
                          style={{
                            backgroundColor: doc.resetOnCompletion ? theme.colors.accent + '20' : 'transparent',
                            color: doc.resetOnCompletion ? theme.colors.accent : theme.colors.textDim
                          }}
                          title={doc.resetOnCompletion ? 'Disable reset on completion' : 'Enable reset on completion'}
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                        </button>

                        {/* Duplicate Button (only shown for reset-enabled docs) */}
                        {doc.resetOnCompletion && (
                          <button
                            onClick={() => handleDuplicateDocument(doc.id)}
                            className="p-1 rounded hover:bg-white/10 transition-colors shrink-0"
                            style={{ color: theme.colors.textDim }}
                            title="Duplicate document"
                          >
                            <Plus className="w-3.5 h-3.5" />
                          </button>
                        )}

                        {/* Remove Button (only for duplicates or when multiple docs exist) */}
                        {(doc.isDuplicate || documents.length > 1) && (
                          <button
                            onClick={() => handleRemoveDocument(doc.id)}
                            className="p-1 rounded hover:bg-white/10 transition-colors shrink-0"
                            style={{ color: theme.colors.textDim }}
                            title="Remove document"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Total Summary */}
            {documents.length > 1 && (
              <div className="mt-2 text-xs" style={{ color: theme.colors.textDim }}>
                Total: {loadingTaskCounts ? '...' : totalTaskCount} tasks across {documents.length} documents
              </div>
            )}

            {/* Loop Mode Toggle - only shown when multiple documents exist */}
            {documents.length > 1 && (
              <div className="mt-4 flex items-center gap-3">
                <button
                  onClick={() => setLoopEnabled(!loopEnabled)}
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border transition-colors ${
                    loopEnabled ? 'border-accent' : 'border-border hover:bg-white/5'
                  }`}
                  style={{
                    borderColor: loopEnabled ? theme.colors.accent : theme.colors.border,
                    backgroundColor: loopEnabled ? theme.colors.accent + '15' : 'transparent'
                  }}
                >
                  <Repeat
                    className="w-4 h-4"
                    style={{ color: loopEnabled ? theme.colors.accent : theme.colors.textDim }}
                  />
                  <span
                    className="text-sm font-medium"
                    style={{ color: loopEnabled ? theme.colors.accent : theme.colors.textMain }}
                  >
                    Loop
                  </span>
                </button>
                <span className="text-xs" style={{ color: theme.colors.textDim }}>
                  Loop back to first document when finished
                </span>
              </div>
            )}

            {/* Loop Indicator - curved arrow from last doc back to first */}
            {loopEnabled && documents.length > 1 && (
              <div className="flex justify-center mt-3">
                <svg width="50" height="24" viewBox="0 0 50 24" fill="none">
                  {/* Curved arrow from bottom back to top */}
                  <path
                    d="M5 20 Q 25 28, 45 12 Q 50 8, 45 4"
                    stroke={theme.colors.accent}
                    strokeWidth="2"
                    fill="none"
                    strokeLinecap="round"
                  />
                  {/* Arrow head pointing left (back to start) */}
                  <path
                    d="M45 4 L 40 2 M 45 4 L 42 8"
                    stroke={theme.colors.accent}
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
            )}
          </div>

          {/* Git Worktree Section - only visible for git repos */}
          {isGitRepo && !checkingGitRepo && (
            <div className="mb-6">
              <div className="flex items-center gap-2 mb-3">
                <GitBranch className="w-4 h-4" style={{ color: theme.colors.accent }} />
                <label className="text-xs font-bold uppercase" style={{ color: theme.colors.textDim }}>
                  Git Worktree
                </label>
                <span className="text-[10px] px-2 py-0.5 rounded" style={{ backgroundColor: theme.colors.accent + '20', color: theme.colors.accent }}>
                  enables parallel work
                </span>
              </div>

              {/* Enable Worktree Toggle */}
              <div className="flex items-center gap-3 mb-4">
                <button
                  onClick={() => setWorktreeEnabled(!worktreeEnabled)}
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border transition-colors ${
                    worktreeEnabled ? 'border-accent' : 'border-border hover:bg-white/5'
                  }`}
                  style={{
                    borderColor: worktreeEnabled ? theme.colors.accent : theme.colors.border,
                    backgroundColor: worktreeEnabled ? theme.colors.accent + '15' : 'transparent'
                  }}
                >
                  <div
                    className={`w-4 h-4 rounded border flex items-center justify-center ${
                      worktreeEnabled ? 'bg-accent border-accent' : ''
                    }`}
                    style={{
                      borderColor: worktreeEnabled ? theme.colors.accent : theme.colors.border,
                      backgroundColor: worktreeEnabled ? theme.colors.accent : 'transparent'
                    }}
                  >
                    {worktreeEnabled && (
                      <svg className="w-3 h-3 text-white" viewBox="0 0 12 12" fill="none">
                        <path d="M2 6L5 9L10 3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </div>
                  <span
                    className="text-sm font-medium"
                    style={{ color: worktreeEnabled ? theme.colors.accent : theme.colors.textMain }}
                  >
                    Enable Worktree
                  </span>
                </button>
              </div>

              {/* Worktree Configuration (only shown when enabled) */}
              {worktreeEnabled && (
                <div
                  className="rounded-lg border p-4 space-y-4"
                  style={{ backgroundColor: theme.colors.bgMain, borderColor: theme.colors.border }}
                >
                  {/* Worktree Path */}
                  <div>
                    <label className="text-xs font-medium mb-1.5 block" style={{ color: theme.colors.textDim }}>
                      Worktree Path
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={worktreePath}
                        onChange={(e) => setWorktreePath(e.target.value)}
                        placeholder="/path/to/worktree"
                        className="flex-1 px-3 py-2 rounded border bg-transparent outline-none text-sm"
                        style={{
                          borderColor: theme.colors.border,
                          color: theme.colors.textMain
                        }}
                      />
                      <button
                        onClick={async () => {
                          const result = await window.maestro.dialog.selectFolder();
                          if (result) {
                            setWorktreePath(result);
                          }
                        }}
                        className="px-3 py-2 rounded border hover:bg-white/5 transition-colors text-sm"
                        style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
                      >
                        Browse
                      </button>
                    </div>
                  </div>

                  {/* Branch Name */}
                  <div>
                    <label className="text-xs font-medium mb-1.5 block" style={{ color: theme.colors.textDim }}>
                      Branch Name
                    </label>
                    <input
                      type="text"
                      value={branchName}
                      onChange={(e) => setBranchName(e.target.value)}
                      placeholder="autorun-feature-xyz"
                      className="w-full px-3 py-2 rounded border bg-transparent outline-none text-sm"
                      style={{
                        borderColor: theme.colors.border,
                        color: theme.colors.textMain
                      }}
                    />
                  </div>

                  {/* Validation Warnings */}
                  {worktreeValidation.checking && (
                    <div className="flex items-center gap-2 text-xs" style={{ color: theme.colors.textDim }}>
                      <div className="animate-spin w-3 h-3 border border-current border-t-transparent rounded-full" />
                      Checking worktree...
                    </div>
                  )}

                  {/* Warning: Worktree exists with different branch */}
                  {!worktreeValidation.checking && worktreeValidation.exists && worktreeValidation.branchMismatch && (
                    <div
                      className="flex items-start gap-2 p-3 rounded border"
                      style={{
                        backgroundColor: theme.colors.warning + '10',
                        borderColor: theme.colors.warning
                      }}
                    >
                      <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" style={{ color: theme.colors.warning }} />
                      <div className="text-sm">
                        <p style={{ color: theme.colors.warning }}>
                          Worktree exists with branch "{worktreeValidation.currentBranch}"
                        </p>
                        <p style={{ color: theme.colors.textDim }}>
                          Will checkout to "{branchName}"
                        </p>
                      </div>
                    </div>
                  )}

                  {/* Error: Worktree belongs to different repo */}
                  {!worktreeValidation.checking && worktreeValidation.exists && !worktreeValidation.sameRepo && (
                    <div
                      className="flex items-start gap-2 p-3 rounded border"
                      style={{
                        backgroundColor: theme.colors.error + '10',
                        borderColor: theme.colors.error
                      }}
                    >
                      <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" style={{ color: theme.colors.error }} />
                      <p className="text-sm" style={{ color: theme.colors.error }}>
                        This path contains a worktree for a different repository. Please choose a different path.
                      </p>
                    </div>
                  )}

                  {/* Create PR on Completion */}
                  <div className="flex items-center gap-3 pt-2 border-t" style={{ borderColor: theme.colors.border }}>
                    <button
                      onClick={() => setCreatePROnCompletion(!createPROnCompletion)}
                      className="flex items-center gap-2"
                    >
                      <div
                        className={`w-4 h-4 rounded border flex items-center justify-center ${
                          createPROnCompletion ? 'bg-accent border-accent' : ''
                        }`}
                        style={{
                          borderColor: createPROnCompletion ? theme.colors.accent : theme.colors.border,
                          backgroundColor: createPROnCompletion ? theme.colors.accent : 'transparent'
                        }}
                      >
                        {createPROnCompletion && (
                          <svg className="w-3 h-3 text-white" viewBox="0 0 12 12" fill="none">
                            <path d="M2 6L5 9L10 3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        )}
                      </div>
                      <span className="text-sm" style={{ color: theme.colors.textMain }}>
                        Create PR on completion
                      </span>
                    </button>
                    <span className="text-xs" style={{ color: theme.colors.textDim }}>
                      → main
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Divider */}
          <div className="border-t mb-6" style={{ borderColor: theme.colors.border }} />

          {/* Agent Prompt Section */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-bold uppercase" style={{ color: theme.colors.textDim }}>
                Agent Prompt
              </label>
              <button
                onClick={handleReset}
                disabled={!isModified}
                className="flex items-center gap-1 text-xs px-2 py-1 rounded hover:bg-white/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                style={{ color: theme.colors.textDim }}
                title="Reset to default prompt"
              >
                <RotateCcw className="w-3 h-3" />
                Reset
              </button>
            </div>
            <div className="text-[10px] mb-2" style={{ color: theme.colors.textDim }}>
              Use <code className="px-1 py-0.5 rounded" style={{ backgroundColor: theme.colors.bgActivity }}>$$SCRATCHPAD$$</code> as placeholder for the document file path
            </div>

            {/* Template Variables Documentation */}
            <div
              className="rounded-lg border overflow-hidden mb-2"
              style={{ backgroundColor: theme.colors.bgMain, borderColor: theme.colors.border }}
            >
              <button
                onClick={() => setVariablesExpanded(!variablesExpanded)}
                className="w-full px-3 py-2 flex items-center justify-between hover:bg-white/5 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <Variable className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />
                  <span className="text-xs font-bold uppercase" style={{ color: theme.colors.textDim }}>
                    Template Variables
                  </span>
                </div>
                {variablesExpanded ? (
                  <ChevronDown className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
                )}
              </button>
              {variablesExpanded && (
                <div className="px-3 pb-3 pt-1 border-t" style={{ borderColor: theme.colors.border }}>
                  <p className="text-[10px] mb-2" style={{ color: theme.colors.textDim }}>
                    Use these variables in your prompt. They will be replaced with actual values at runtime.
                  </p>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 max-h-48 overflow-y-auto scrollbar-thin">
                    {TEMPLATE_VARIABLES.map(({ variable, description }) => (
                      <div key={variable} className="flex items-center gap-2 py-0.5">
                        <code
                          className="text-[10px] font-mono px-1 py-0.5 rounded shrink-0"
                          style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.accent }}
                        >
                          {variable}
                        </code>
                        <span className="text-[10px] truncate" style={{ color: theme.colors.textDim }}>
                          {description}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <textarea
              ref={textareaRef}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              className="w-full p-4 rounded border bg-transparent outline-none resize-none font-mono text-sm"
              style={{
                borderColor: theme.colors.border,
                color: theme.colors.textMain,
                minHeight: '200px'
              }}
              placeholder="Enter the prompt for the batch agent..."
            />
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 border-t flex justify-end gap-2 shrink-0" style={{ borderColor: theme.colors.border }}>
          <button
            onClick={onClose}
            className="px-4 py-2 rounded border hover:bg-white/5 transition-colors"
            style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!hasUnsavedChanges}
            className="flex items-center gap-2 px-4 py-2 rounded border hover:bg-white/5 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            style={{ borderColor: theme.colors.border, color: theme.colors.success }}
            title={hasUnsavedChanges ? 'Save prompt for this session' : 'No unsaved changes'}
          >
            <Save className="w-4 h-4" />
            Save
          </button>
          <button
            onClick={handleGo}
            disabled={hasNoTasks || documents.length === 0}
            className="flex items-center gap-2 px-4 py-2 rounded text-white font-bold disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ backgroundColor: (hasNoTasks || documents.length === 0) ? theme.colors.textDim : theme.colors.accent }}
            title={hasNoTasks ? 'No unchecked tasks in documents' : documents.length === 0 ? 'No documents selected' : 'Run batch processing'}
          >
            <Play className="w-4 h-4" />
            Go
          </button>
        </div>
      </div>

      {/* Document Selector Modal */}
      {showDocSelector && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-[10000]"
          onClick={() => setShowDocSelector(false)}
        >
          <div
            className="w-[400px] max-h-[60vh] border rounded-lg shadow-2xl overflow-hidden flex flex-col"
            style={{ backgroundColor: theme.colors.bgSidebar, borderColor: theme.colors.border }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Selector Header */}
            <div className="p-4 border-b flex items-center justify-between shrink-0" style={{ borderColor: theme.colors.border }}>
              <h3 className="text-sm font-bold" style={{ color: theme.colors.textMain }}>
                Select Documents
              </h3>
              <button onClick={() => setShowDocSelector(false)} style={{ color: theme.colors.textDim }}>
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Document Checkboxes */}
            <div className="flex-1 overflow-y-auto p-2">
              {allDocuments.length === 0 ? (
                <div className="p-4 text-center" style={{ color: theme.colors.textDim }}>
                  <p className="text-sm">No documents found in folder</p>
                </div>
              ) : (
                <div className="space-y-1">
                  {allDocuments.map((filename) => {
                    const isSelected = selectedDocsInSelector.has(filename);
                    const docTaskCount = taskCounts[filename] ?? 0;

                    return (
                      <button
                        key={filename}
                        onClick={() => toggleDocInSelector(filename)}
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
                          {filename}
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
                onClick={() => setShowDocSelector(false)}
                className="px-4 py-2 rounded border hover:bg-white/5 transition-colors"
                style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
              >
                Cancel
              </button>
              <button
                onClick={handleAddSelectedDocs}
                className="px-4 py-2 rounded text-white font-bold"
                style={{ backgroundColor: theme.colors.accent }}
              >
                Add ({selectedDocsInSelector.size})
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Save Playbook Modal */}
      {showSavePlaybookModal && (
        <PlaybookNameModal
          theme={theme}
          onSave={handleSaveAsPlaybook}
          onCancel={() => setShowSavePlaybookModal(false)}
          title="Save as Playbook"
          saveButtonText={savingPlaybook ? 'Saving...' : 'Save'}
        />
      )}

      {/* Playbook Delete Confirmation Modal */}
      {showDeleteConfirmModal && playbookToDelete && (
        <PlaybookDeleteConfirmModal
          theme={theme}
          playbookName={playbookToDelete.name}
          onConfirm={handleConfirmDeletePlaybook}
          onCancel={handleCancelDeletePlaybook}
        />
      )}
    </div>
  );
}
