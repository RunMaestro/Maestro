import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { X, RotateCcw, Play, Variable, ChevronDown, ChevronRight, Save, GripVertical, Plus, Repeat, FolderOpen, Bookmark, GitBranch, AlertTriangle, Loader2, Maximize2, Download, Upload, RefreshCw } from 'lucide-react';
import type { Theme, BatchDocumentEntry, BatchRunConfig, Playbook, PlaybookDocumentEntry, WorktreeConfig } from '../types';
import { useLayerStack } from '../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { TEMPLATE_VARIABLES } from '../utils/templateVariables';
import { PlaybookDeleteConfirmModal } from './PlaybookDeleteConfirmModal';
import { PlaybookNameModal } from './PlaybookNameModal';
import { AgentPromptComposerModal } from './AgentPromptComposerModal';

// Default batch processing prompt
export const DEFAULT_BATCH_PROMPT = `# Context

Your name is **{{AGENT_NAME}}**, a Maestro-managed AI agent working on the **{{PROJECT_NAME}}** project.

- **Project Path:** {{PROJECT_PATH}}
- **Git Branch:** {{GIT_BRANCH}}
- **Auto Run Folder:** {{AUTORUN_FOLDER}}
- **Loop Iteration:** {{LOOP_NUMBER}}

---

## Instructions

1. Project Orientation
    Begin by reviewing CLAUDE.md (when available) in this folder to understand the project's structure, conventions, and workflow expectations.

2. Task Selection
    Process the FIRST unchecked task (- [ ]) from top to bottom. Note that there may be relevant images associated with the task, analyze them, and include in your final synopsis back how many images you analyzed in preparation for solving the task.

    IMPORTANT: You will only work on this single task. If it appears to have logical subtasks, treat them as one cohesive unit—but do not move on to the next top-level task.

3. Task Evaluation
    - Fully understand the task and inspect the relevant code.
    - If you determine the task should not be executed, mark it as completed anyway and record a concise explanation of why it was skipped directly in the document.
    - If upon examining the code carefully you decide there is a better approach, take it, and document record a detailed explanation of why directly in the document.

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
    For any code or documentation changes, if we're in a Github repo:
    - Commit using a descriptive message prefixed with MAESTRO:.
    - Push to GitHub.
    - Update CLAUDE.md, README.md, or any other top-level documentation if appropriate.

7. Exit Immediately
    After completing (or skipping) the single task, EXIT. Do not proceed to additional tasks—another agent instance will handle them.

NOTE: If you see a clear issue tag like a little moniker or some short form in front of the task, then your synopsis message should start with that exact token because we're clearly using it as a unique identifier.

If there are no remaining open tasks, exit immediately and state that there is nothing left to do.

---

## Tasks

Process tasks from this document:

{{DOCUMENT_PATH}}

Save changes directly in that file.`;

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
  onRefreshDocuments: () => Promise<void>; // Refresh document list from folder
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
    onRefreshDocuments,
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
  const [docSelectorRefreshing, setDocSelectorRefreshing] = useState(false);
  const [docSelectorRefreshMessage, setDocSelectorRefreshMessage] = useState<string | null>(null);
  const [prevDocCount, setPrevDocCount] = useState(allDocuments.length);

  // Loop mode state
  const [loopEnabled, setLoopEnabled] = useState(false);
  const [maxLoops, setMaxLoops] = useState<number | null>(null); // null = infinite
  const [showMaxLoopsSlider, setShowMaxLoopsSlider] = useState(false);

  // Prompt state
  const [prompt, setPrompt] = useState(initialPrompt || DEFAULT_BATCH_PROMPT);
  const [variablesExpanded, setVariablesExpanded] = useState(false);
  const [savedPrompt, setSavedPrompt] = useState(initialPrompt || '');
  const [promptComposerOpen, setPromptComposerOpen] = useState(false);
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
  const [prTargetBranch, setPrTargetBranch] = useState('main');
  const [availableBranches, setAvailableBranches] = useState<string[]>([]);
  const [showBranchDropdown, setShowBranchDropdown] = useState(false);
  const branchDropdownRef = useRef<HTMLDivElement>(null);
  const [ghCliStatus, setGhCliStatus] = useState<{ installed: boolean; authenticated: boolean } | null>(null);

  // Worktree validation state
  const [worktreeValidation, setWorktreeValidation] = useState<{
    checking: boolean;
    exists: boolean;
    isWorktree: boolean;
    currentBranch?: string;
    branchMismatch: boolean;
    sameRepo: boolean;
    hasUncommittedChanges?: boolean;
    error?: string;
  }>({ checking: false, exists: false, isWorktree: false, branchMismatch: false, sameRepo: true });

  const { registerLayer, unregisterLayer, updateLayerHandler } = useLayerStack();
  const layerIdRef = useRef<string>();

  // Use ref for getDocumentTaskCount to avoid dependency issues
  const getDocumentTaskCountRef = useRef(getDocumentTaskCount);
  getDocumentTaskCountRef.current = getDocumentTaskCount;

  // Load task counts for all documents (only when document list changes)
  useEffect(() => {
    const loadTaskCounts = async () => {
      setLoadingTaskCounts(true);
      const counts: Record<string, number> = {};

      for (const doc of allDocuments) {
        try {
          counts[doc] = await getDocumentTaskCountRef.current(doc);
        } catch {
          counts[doc] = 0;
        }
      }

      setTaskCounts(counts);
      setLoadingTaskCounts(false);
    };

    loadTaskCounts();
  }, [allDocuments]);

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
        const isRepo = result === true;
        setIsGitRepo(isRepo);

        // If it's a git repo, fetch available branches and check gh CLI
        if (isRepo) {
          const [branchResult, ghResult] = await Promise.all([
            window.maestro.git.branches(sessionCwd),
            window.maestro.git.checkGhCli()
          ]);

          if (branchResult.branches && branchResult.branches.length > 0) {
            setAvailableBranches(branchResult.branches);
            // Set default target branch to 'main' or 'master' if available
            if (branchResult.branches.includes('main')) {
              setPrTargetBranch('main');
            } else if (branchResult.branches.includes('master')) {
              setPrTargetBranch('master');
            } else {
              setPrTargetBranch(branchResult.branches[0]);
            }
          }

          setGhCliStatus(ghResult);
        }
      } catch (error) {
        console.error('Failed to check if git repo:', error);
        setIsGitRepo(false);
      }
      setCheckingGitRepo(false);
    };

    checkGitRepo();
  }, [sessionCwd]);

  // Validate worktree path when it changes (debounced 500ms)
  useEffect(() => {
    // Reset validation state when worktree is disabled or path is empty
    if (!worktreeEnabled || !worktreePath) {
      setWorktreeValidation({
        checking: false,
        exists: false,
        isWorktree: false,
        branchMismatch: false,
        sameRepo: true,
        hasUncommittedChanges: false
      });
      return;
    }

    // Set checking state immediately
    setWorktreeValidation(prev => ({ ...prev, checking: true }));

    // Debounce the validation check
    const timeoutId = setTimeout(async () => {
      try {
        // Check if the path exists and get worktree info
        const worktreeInfoResult = await window.maestro.git.worktreeInfo(worktreePath);

        if (!worktreeInfoResult.success) {
          setWorktreeValidation({
            checking: false,
            exists: false,
            isWorktree: false,
            branchMismatch: false,
            sameRepo: true,
            hasUncommittedChanges: false,
            error: worktreeInfoResult.error
          });
          return;
        }

        // If the path doesn't exist, that's fine - it will be created
        if (!worktreeInfoResult.exists) {
          setWorktreeValidation({
            checking: false,
            exists: false,
            isWorktree: false,
            branchMismatch: false,
            sameRepo: true,
            hasUncommittedChanges: false
          });
          return;
        }

        // Path exists - check if it's part of the same repo
        const mainRepoRootResult = await window.maestro.git.getRepoRoot(sessionCwd);
        const sameRepo = mainRepoRootResult.success &&
          worktreeInfoResult.repoRoot === mainRepoRootResult.root;

        // Check for branch mismatch (only if branch name is provided)
        const branchMismatch = branchName !== '' &&
          worktreeInfoResult.currentBranch !== branchName;

        // If there's a branch mismatch and it's the same repo, check for uncommitted changes
        // This helps warn users that checkout will fail if there are uncommitted changes
        let hasUncommittedChanges = false;
        if (branchMismatch && sameRepo) {
          try {
            // Use git status to check for uncommitted changes in the worktree
            const statusResult = await window.maestro.git.status(worktreePath);
            // If there's any output from git status --porcelain, there are changes
            hasUncommittedChanges = statusResult.stdout.trim().length > 0;
          } catch {
            // If we can't check, assume no uncommitted changes
            hasUncommittedChanges = false;
          }
        }

        setWorktreeValidation({
          checking: false,
          exists: true,
          isWorktree: worktreeInfoResult.isWorktree || false,
          currentBranch: worktreeInfoResult.currentBranch,
          branchMismatch,
          sameRepo,
          hasUncommittedChanges,
          error: !sameRepo ? 'This path contains a worktree for a different repository' : undefined
        });
      } catch (error) {
        console.error('Failed to validate worktree path:', error);
        setWorktreeValidation({
          checking: false,
          exists: false,
          isWorktree: false,
          branchMismatch: false,
          sameRepo: true,
          hasUncommittedChanges: false,
          error: 'Failed to validate worktree path'
        });
      }
    }, 500); // 500ms debounce

    // Cleanup timeout on unmount or when dependencies change
    return () => clearTimeout(timeoutId);
  }, [worktreePath, branchName, worktreeEnabled, sessionCwd]);

  // Calculate total tasks across selected documents (excluding missing documents)
  const totalTaskCount = documents.reduce((sum, doc) => {
    // Don't count tasks from missing documents
    if (doc.isMissing) return sum;
    return sum + (taskCounts[doc.filename] || 0);
  }, 0);
  const hasNoTasks = totalTaskCount === 0;

  // Count missing documents for warning display
  const missingDocCount = documents.filter(doc => doc.isMissing).length;
  const hasMissingDocs = missingDocCount > 0;

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

    // Compare maxLoops setting
    const savedMaxLoops = loadedPlaybook.maxLoops ?? null;
    if (maxLoops !== savedMaxLoops) return true;

    // Compare prompt
    if (prompt !== loadedPlaybook.prompt) return true;

    // Compare worktree settings
    const savedWorktree = loadedPlaybook.worktreeSettings;
    if (savedWorktree) {
      // Playbook has worktree settings - check if current state differs
      if (!worktreeEnabled) return true;
      if (branchName !== savedWorktree.branchNameTemplate) return true;
      if (createPROnCompletion !== savedWorktree.createPROnCompletion) return true;
      if (savedWorktree.prTargetBranch && prTargetBranch !== savedWorktree.prTargetBranch) return true;
    } else {
      // Playbook doesn't have worktree settings - modified if worktree is now enabled with a branch
      if (worktreeEnabled && branchName) return true;
    }

    return false;
  }, [documents, loopEnabled, maxLoops, prompt, loadedPlaybook, worktreeEnabled, branchName, createPROnCompletion, prTargetBranch]);

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

    // Filter out missing documents before starting batch run
    const validDocuments = documents.filter(doc => !doc.isMissing);

    // Build config with optional worktree settings
    const config: BatchRunConfig = {
      documents: validDocuments,
      prompt,
      loopEnabled,
      maxLoops: loopEnabled ? maxLoops : null
    };

    // Add worktree config if enabled and valid
    if (worktreeEnabled && isGitRepo && worktreePath && branchName) {
      config.worktree = {
        enabled: true,
        path: worktreePath,
        branchName,
        createPROnCompletion,
        prTargetBranch
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

  // Handle refresh in the document selector modal
  const handleDocSelectorRefresh = useCallback(async () => {
    const countBefore = allDocuments.length;
    setDocSelectorRefreshing(true);
    setDocSelectorRefreshMessage(null);

    await onRefreshDocuments();

    // The parent will update allDocuments - we need to calculate the diff
    // after the refresh completes. Use a small timeout to let the prop update.
    setTimeout(() => {
      setDocSelectorRefreshing(false);
    }, 500);
  }, [onRefreshDocuments, allDocuments.length]);

  // Track document count changes for refresh notification
  useEffect(() => {
    if (docSelectorRefreshing === false && prevDocCount !== allDocuments.length) {
      const diff = allDocuments.length - prevDocCount;
      let message: string;
      if (diff > 0) {
        message = `Found ${diff} new document${diff === 1 ? '' : 's'}`;
      } else if (diff < 0) {
        message = `${Math.abs(diff)} document${Math.abs(diff) === 1 ? '' : 's'} removed`;
      } else {
        message = 'No changes';
      }
      setDocSelectorRefreshMessage(message);
      setPrevDocCount(allDocuments.length);

      // Clear message after 3 seconds
      const timer = setTimeout(() => setDocSelectorRefreshMessage(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [allDocuments.length, prevDocCount, docSelectorRefreshing]);

  // Handle loading a playbook
  const handleLoadPlaybook = useCallback((playbook: Playbook) => {
    // Convert stored entries to BatchDocumentEntry with IDs
    // Also detect missing documents (documents in playbook that don't exist in allDocuments)
    const allDocsSet = new Set(allDocuments);

    const entries: BatchDocumentEntry[] = playbook.documents.map((doc, index) => ({
      id: crypto.randomUUID(),
      filename: doc.filename,
      resetOnCompletion: doc.resetOnCompletion,
      // Mark as duplicate if same filename appears earlier
      isDuplicate: playbook.documents.slice(0, index).some(d => d.filename === doc.filename),
      // Mark as missing if document doesn't exist in the folder
      isMissing: !allDocsSet.has(doc.filename)
    }));

    setDocuments(entries);
    setLoopEnabled(playbook.loopEnabled);
    setMaxLoops(playbook.maxLoops ?? null);
    setShowMaxLoopsSlider(playbook.maxLoops != null);
    setPrompt(playbook.prompt);
    setLoadedPlaybook(playbook);
    setShowPlaybookDropdown(false);

    // Restore worktree settings if present
    if (playbook.worktreeSettings) {
      setWorktreeEnabled(true);
      setBranchName(playbook.worktreeSettings.branchNameTemplate);
      setCreatePROnCompletion(playbook.worktreeSettings.createPROnCompletion);
      if (playbook.worktreeSettings.prTargetBranch) {
        setPrTargetBranch(playbook.worktreeSettings.prTargetBranch);
      }
    } else {
      // Clear worktree settings if playbook doesn't have them
      setWorktreeEnabled(false);
      setBranchName('');
      setCreatePROnCompletion(false);
    }
  }, [allDocuments]);

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

  // Handle exporting a playbook
  const handleExportPlaybook = useCallback(async (playbook: Playbook) => {
    try {
      const result = await window.maestro.playbooks.export(sessionId, playbook.id, folderPath);
      if (!result.success && result.error !== 'Export cancelled') {
        console.error('Failed to export playbook:', result.error);
      }
    } catch (error) {
      console.error('Failed to export playbook:', error);
    }
  }, [sessionId, folderPath]);

  // Handle importing a playbook
  const handleImportPlaybook = useCallback(async () => {
    try {
      const result = await window.maestro.playbooks.import(sessionId, folderPath);
      if (result.success && result.playbook) {
        // Add to local playbooks list
        setPlaybooks(prev => [...prev, result.playbook]);
        // Load the imported playbook
        handleLoadPlaybook(result.playbook);
      } else if (result.error && result.error !== 'Import cancelled') {
        console.error('Failed to import playbook:', result.error);
      }
    } catch (error) {
      console.error('Failed to import playbook:', error);
    }
  }, [sessionId, folderPath, handleLoadPlaybook]);

  // Handle saving a new playbook
  const handleSaveAsPlaybook = useCallback(async (name: string) => {
    if (savingPlaybook) return;

    setSavingPlaybook(true);
    try {
      // Build playbook data, including worktree settings if enabled
      const playbookData: Parameters<typeof window.maestro.playbooks.create>[1] = {
        name,
        documents: documents.map(d => ({
          filename: d.filename,
          resetOnCompletion: d.resetOnCompletion
        })),
        loopEnabled,
        maxLoops,
        prompt
      };

      // Include worktree settings if worktree is enabled
      // Note: We store branchName as the template - users can modify it when loading
      if (worktreeEnabled && branchName) {
        playbookData.worktreeSettings = {
          branchNameTemplate: branchName,
          createPROnCompletion,
          prTargetBranch
        };
      }

      const result = await window.maestro.playbooks.create(sessionId, playbookData);

      if (result.success) {
        setPlaybooks(prev => [...prev, result.playbook]);
        setLoadedPlaybook(result.playbook);
        setShowSavePlaybookModal(false);
      }
    } catch (error) {
      console.error('Failed to save playbook:', error);
    }
    setSavingPlaybook(false);
  }, [sessionId, documents, loopEnabled, maxLoops, prompt, worktreeEnabled, branchName, createPROnCompletion, prTargetBranch, savingPlaybook]);

  // Handle updating an existing playbook
  const handleSaveUpdate = useCallback(async () => {
    if (!loadedPlaybook || savingPlaybook) return;

    setSavingPlaybook(true);
    try {
      // Build update data, including worktree settings if enabled
      const updateData: Parameters<typeof window.maestro.playbooks.update>[2] = {
        documents: documents.map(d => ({
          filename: d.filename,
          resetOnCompletion: d.resetOnCompletion
        })),
        loopEnabled,
        maxLoops,
        prompt,
        updatedAt: Date.now()
      };

      // Include worktree settings if worktree is enabled, otherwise clear them
      if (worktreeEnabled && branchName) {
        updateData.worktreeSettings = {
          branchNameTemplate: branchName,
          createPROnCompletion,
          prTargetBranch
        };
      } else {
        // Explicitly set to undefined to clear previous worktree settings
        updateData.worktreeSettings = undefined;
      }

      const result = await window.maestro.playbooks.update(sessionId, loadedPlaybook.id, updateData);

      if (result.success) {
        setLoadedPlaybook(result.playbook);
        setPlaybooks(prev => prev.map(p => p.id === result.playbook.id ? result.playbook : p));
      }
    } catch (error) {
      console.error('Failed to update playbook:', error);
    }
    setSavingPlaybook(false);
  }, [sessionId, loadedPlaybook, documents, loopEnabled, maxLoops, prompt, worktreeEnabled, branchName, createPROnCompletion, prTargetBranch, savingPlaybook]);

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

  // Close branch dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (branchDropdownRef.current && !branchDropdownRef.current.contains(e.target as Node)) {
        setShowBranchDropdown(false);
      }
    };

    if (showBranchDropdown) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showBranchDropdown]);

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
          <h2 className="text-sm font-bold" style={{ color: theme.colors.textMain }}>
            Auto Run Configuration
          </h2>
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
            {/* Load Playbook Dropdown - only show when playbooks exist or one is loaded */}
            {(playbooks.length > 0 || loadedPlaybook) ? (
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
                            onClick={(e) => {
                              e.stopPropagation();
                              handleExportPlaybook(pb);
                            }}
                            className="p-1 rounded hover:bg-white/10 transition-colors shrink-0"
                            style={{ color: theme.colors.textDim }}
                            title="Export playbook"
                          >
                            <Download className="w-3 h-3" />
                          </button>
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
                    {/* Import playbook button */}
                    <div
                      className="border-t px-3 py-2"
                      style={{ borderColor: theme.colors.border }}
                    >
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleImportPlaybook();
                        }}
                        className="flex items-center gap-2 w-full px-2 py-1.5 rounded hover:bg-white/5 transition-colors text-sm"
                        style={{ color: theme.colors.accent }}
                      >
                        <Upload className="w-3.5 h-3.5" />
                        Import Playbook
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div /> /* Empty placeholder to maintain flex layout */
            )}

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

              {/* Save Update, Save as New, and Discard buttons - shown when playbook is loaded and modified */}
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
                    onClick={() => setShowSavePlaybookModal(true)}
                    disabled={savingPlaybook}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border hover:bg-white/5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
                    title="Save as a new playbook with a different name"
                  >
                    <Bookmark className="w-3.5 h-3.5" />
                    <span className="text-sm">Save as New</span>
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
                <div className="divide-y" style={{ borderColor: theme.colors.border }}>
                  {documents.map((doc) => {
                    const docTaskCount = taskCounts[doc.filename] ?? 0;
                    const isBeingDragged = draggedId === doc.id;
                    const isDragTarget = dragOverId === doc.id;

                    return (
                      <div
                        key={doc.id}
                        draggable={!doc.isMissing} // Don't allow dragging missing docs
                        onDragStart={(e) => !doc.isMissing && handleDragStart(e, doc.id)}
                        onDragOver={(e) => handleDragOver(e, doc.id)}
                        onDragEnd={handleDragEnd}
                        className={`flex items-center gap-3 px-3 py-2 transition-all ${
                          isBeingDragged ? 'opacity-50' : ''
                        } ${isDragTarget ? 'bg-white/10' : 'hover:bg-white/5'} ${
                          doc.isMissing ? 'opacity-60' : ''
                        }`}
                        style={{
                          borderColor: theme.colors.border,
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
                          // Check if this document has duplicates (other entries with same filename)
                          const hasDuplicates = documents.filter(d => d.filename === doc.filename).length > 1;
                          const canDisableReset = !hasDuplicates;

                          let tooltipText: string;
                          if (doc.resetOnCompletion) {
                            if (canDisableReset) {
                              tooltipText = 'Reset enabled: uncompleted tasks will be re-checked when done. Click to disable.';
                            } else {
                              tooltipText = 'Reset enabled: uncompleted tasks will be re-checked when done. Remove duplicates to disable.';
                            }
                          } else {
                            tooltipText = 'Enable reset: uncompleted tasks will be re-checked when this document completes';
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
                    );
                  })}
                </div>
              )}
              </div>
            </div>

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
                            setMaxLoops(5); // Default to 5 loops
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
                  onClick={() => ghCliStatus?.installed && setWorktreeEnabled(!worktreeEnabled)}
                  disabled={!ghCliStatus?.installed}
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border transition-colors ${
                    !ghCliStatus?.installed
                      ? 'opacity-50 cursor-not-allowed'
                      : worktreeEnabled
                        ? 'border-accent'
                        : 'border-border hover:bg-white/5'
                  }`}
                  style={{
                    borderColor: worktreeEnabled && ghCliStatus?.installed ? theme.colors.accent : theme.colors.border,
                    backgroundColor: worktreeEnabled && ghCliStatus?.installed ? theme.colors.accent + '15' : 'transparent'
                  }}
                >
                  <div
                    className={`w-4 h-4 rounded border flex items-center justify-center ${
                      worktreeEnabled && ghCliStatus?.installed ? 'bg-accent border-accent' : ''
                    }`}
                    style={{
                      borderColor: worktreeEnabled && ghCliStatus?.installed ? theme.colors.accent : theme.colors.border,
                      backgroundColor: worktreeEnabled && ghCliStatus?.installed ? theme.colors.accent : 'transparent'
                    }}
                  >
                    {worktreeEnabled && ghCliStatus?.installed && (
                      <svg className="w-3 h-3 text-white" viewBox="0 0 12 12" fill="none">
                        <path d="M2 6L5 9L10 3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </div>
                  <span
                    className="text-sm font-medium"
                    style={{ color: worktreeEnabled && ghCliStatus?.installed ? theme.colors.accent : theme.colors.textMain }}
                  >
                    Enable Worktree
                  </span>
                </button>

                {/* GitHub CLI not installed warning - shown inline with disabled toggle */}
                {ghCliStatus !== null && !ghCliStatus.installed && (
                  <div className="flex items-center gap-2 text-xs" style={{ color: theme.colors.textDim }}>
                    <AlertTriangle className="w-4 h-4 shrink-0" style={{ color: theme.colors.warning }} />
                    <span>
                      Install{' '}
                      <a
                        href="https://cli.github.com"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline hover:opacity-80"
                        style={{ color: theme.colors.accent }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        GitHub CLI
                      </a>
                      {' '}to enable worktree features
                    </span>
                  </div>
                )}

                {/* Still checking gh CLI status */}
                {ghCliStatus === null && (
                  <div className="flex items-center gap-2 text-xs" style={{ color: theme.colors.textDim }}>
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Checking GitHub CLI...
                  </div>
                )}
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

                  {/* Info: Existing worktree with same branch (no mismatch) */}
                  {!worktreeValidation.checking && worktreeValidation.exists && !worktreeValidation.branchMismatch && worktreeValidation.sameRepo && worktreeValidation.currentBranch && (
                    <div
                      className="flex items-center gap-2 p-3 rounded border"
                      style={{
                        backgroundColor: theme.colors.accent + '10',
                        borderColor: theme.colors.accent + '40'
                      }}
                    >
                      <GitBranch
                        className="w-4 h-4 shrink-0"
                        style={{ color: theme.colors.accent }}
                      />
                      <p className="text-sm" style={{ color: theme.colors.textMain }}>
                        Existing worktree on branch "{worktreeValidation.currentBranch}"
                      </p>
                    </div>
                  )}

                  {/* Warning: Worktree exists with different branch */}
                  {!worktreeValidation.checking && worktreeValidation.exists && worktreeValidation.branchMismatch && worktreeValidation.sameRepo && (
                    <div
                      className="flex items-start gap-2 p-3 rounded border"
                      style={{
                        backgroundColor: worktreeValidation.hasUncommittedChanges
                          ? theme.colors.error + '10'
                          : theme.colors.warning + '10',
                        borderColor: worktreeValidation.hasUncommittedChanges
                          ? theme.colors.error
                          : theme.colors.warning
                      }}
                    >
                      <AlertTriangle
                        className="w-4 h-4 mt-0.5 shrink-0"
                        style={{
                          color: worktreeValidation.hasUncommittedChanges
                            ? theme.colors.error
                            : theme.colors.warning
                        }}
                      />
                      <div className="text-sm">
                        <p style={{
                          color: worktreeValidation.hasUncommittedChanges
                            ? theme.colors.error
                            : theme.colors.warning
                        }}>
                          Worktree exists with branch "{worktreeValidation.currentBranch}"
                        </p>
                        <p style={{ color: theme.colors.textDim }}>
                          Will checkout to "{branchName}"
                          {worktreeValidation.hasUncommittedChanges && (
                            <span style={{ color: theme.colors.error }}>
                              {' '}(uncommitted changes will block checkout)
                            </span>
                          )}
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
                  <div className="pt-2 border-t" style={{ borderColor: theme.colors.border }}>
                    {!ghCliStatus?.authenticated ? (
                      // gh CLI installed but not authenticated
                      <div className="flex items-center gap-2 text-xs" style={{ color: theme.colors.textDim }}>
                        <AlertTriangle className="w-4 h-4 shrink-0" style={{ color: theme.colors.warning }} />
                        <span>
                          Run <code className="px-1 py-0.5 rounded" style={{ backgroundColor: theme.colors.bgActivity }}>gh auth login</code> to enable automatic PR creation
                        </span>
                      </div>
                    ) : (
                      // gh CLI installed and authenticated - show the checkbox
                      <div className="flex items-center gap-3">
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
                        {/* Target branch selector */}
                        <div className="relative" ref={branchDropdownRef}>
                          <button
                            onClick={() => setShowBranchDropdown(!showBranchDropdown)}
                            className="flex items-center gap-1 text-xs px-2 py-1 rounded hover:bg-white/10 transition-colors"
                            style={{ color: theme.colors.textDim }}
                            title="Select target branch for PR"
                          >
                            <span>→</span>
                            <span style={{ color: theme.colors.textMain }}>{prTargetBranch}</span>
                            <ChevronDown className="w-3 h-3" />
                          </button>
                          {showBranchDropdown && availableBranches.length > 0 && (
                            <div
                              className="absolute bottom-full left-0 mb-1 w-48 max-h-48 overflow-y-auto rounded-lg border shadow-xl"
                              style={{ backgroundColor: theme.colors.bgSidebar, borderColor: theme.colors.border }}
                            >
                              {availableBranches.map((branch) => (
                                <button
                                  key={branch}
                                  onClick={() => {
                                    setPrTargetBranch(branch);
                                    setShowBranchDropdown(false);
                                  }}
                                  className={`w-full text-left px-3 py-2 text-xs hover:bg-white/10 transition-colors ${
                                    branch === prTargetBranch ? 'bg-white/5' : ''
                                  }`}
                                  style={{
                                    color: branch === prTargetBranch ? theme.colors.accent : theme.colors.textMain
                                  }}
                                >
                                  {branch}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    )}
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
              <div className="flex items-center gap-3">
                <label className="text-xs font-bold uppercase" style={{ color: theme.colors.textDim }}>
                  Agent Prompt
                </label>
                {isModified && (
                  <span
                    className="text-[10px] px-2 py-0.5 rounded-full"
                    style={{ backgroundColor: theme.colors.accent + '20', color: theme.colors.accent }}
                  >
                    CUSTOMIZED
                  </span>
                )}
              </div>
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
              This prompt is sent to the AI agent for each document in the queue.{' '}
              {isModified && lastModifiedAt && (
                <span style={{ color: theme.colors.textMain }}>
                  Last modified {formatLastModified(lastModifiedAt)}.
                </span>
              )}
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
            <div className="relative">
              <textarea
                ref={textareaRef}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                className="w-full p-4 pr-10 rounded border bg-transparent outline-none resize-none font-mono text-sm"
                style={{
                  borderColor: theme.colors.border,
                  color: theme.colors.textMain,
                  minHeight: '200px'
                }}
                placeholder="Enter the prompt for the batch agent..."
              />
              <button
                onClick={() => setPromptComposerOpen(true)}
                className="absolute top-2 right-2 p-1.5 rounded hover:bg-white/10 transition-colors"
                style={{ color: theme.colors.textDim }}
                title="Expand editor"
              >
                <Maximize2 className="w-4 h-4" />
              </button>
            </div>
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
            disabled={hasNoTasks || documents.length === 0 || documents.length === missingDocCount}
            className="flex items-center gap-2 px-4 py-2 rounded text-white font-bold disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ backgroundColor: (hasNoTasks || documents.length === 0 || documents.length === missingDocCount) ? theme.colors.textDim : theme.colors.accent }}
            title={
              documents.length === 0 ? 'No documents selected' :
              documents.length === missingDocCount ? 'All selected documents are missing' :
              hasNoTasks ? 'No unchecked tasks in documents' :
              'Run batch processing'
            }
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
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-bold" style={{ color: theme.colors.textMain }}>
                  Select Documents
                </h3>
                {docSelectorRefreshMessage && (
                  <span
                    className="text-xs px-2 py-0.5 rounded animate-in fade-in"
                    style={{
                      backgroundColor: theme.colors.success + '20',
                      color: theme.colors.success
                    }}
                  >
                    {docSelectorRefreshMessage}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={handleDocSelectorRefresh}
                  disabled={docSelectorRefreshing}
                  className="p-1 rounded hover:bg-white/10 transition-colors disabled:opacity-50"
                  style={{ color: theme.colors.textDim }}
                  title="Refresh document list"
                >
                  <RefreshCw className={`w-4 h-4 ${docSelectorRefreshing ? 'animate-spin' : ''}`} />
                </button>
                <button onClick={() => setShowDocSelector(false)} className="p-1 rounded hover:bg-white/10 transition-colors" style={{ color: theme.colors.textDim }}>
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

      {/* Agent Prompt Composer Modal */}
      <AgentPromptComposerModal
        isOpen={promptComposerOpen}
        onClose={() => setPromptComposerOpen(false)}
        theme={theme}
        initialValue={prompt}
        onSubmit={(value) => setPrompt(value)}
      />
    </div>
  );
}
