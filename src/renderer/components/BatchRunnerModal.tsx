import { useState, useEffect, useRef, useCallback } from 'react';
import { X, RotateCcw, Play, Variable, ChevronDown, ChevronRight, Save, FolderOpen, Bookmark, Maximize2, Download, Upload } from 'lucide-react';
import type { Theme, BatchDocumentEntry, BatchRunConfig } from '../types';
import { useLayerStack } from '../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { TEMPLATE_VARIABLES } from '../utils/templateVariables';
import { PlaybookDeleteConfirmModal } from './PlaybookDeleteConfirmModal';
import { PlaybookNameModal } from './PlaybookNameModal';
import { AgentPromptComposerModal } from './AgentPromptComposerModal';
import { DocumentsPanel } from './DocumentsPanel';
import { usePlaybookManagement } from '../hooks';
import { autorunDefaultPrompt } from '../../prompts';
import { generateId } from '../utils/ids';

// Platform detection helper (userAgentData is newer but not in all TS types yet)
const isMacPlatform = (): boolean => {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return nav.userAgentData?.platform?.toLowerCase().includes('mac')
    ?? navigator.platform.toLowerCase().includes('mac');
};

// Default batch processing prompt
export const DEFAULT_BATCH_PROMPT = autorunDefaultPrompt;

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
  documentTree?: Array<{ name: string; type: 'file' | 'folder'; path: string; children?: unknown[] }>; // Tree structure for folder selection
  getDocumentTaskCount: (filename: string) => Promise<number>; // Get task count for a document
  onRefreshDocuments: () => Promise<void>; // Refresh document list from folder
  // Session ID for playbook storage
  sessionId: string;
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
    documentTree,
    getDocumentTaskCount,
    onRefreshDocuments,
    sessionId,
  } = props;

  // Document list state
  const [documents, setDocuments] = useState<BatchDocumentEntry[]>(() => {
    // Initialize with current document
    if (currentDocument) {
      return [{
        id: generateId(),
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

  // Loop mode state
  const [loopEnabled, setLoopEnabled] = useState(false);
  const [maxLoops, setMaxLoops] = useState<number | null>(null); // null = infinite

  // Prompt state
  const [prompt, setPrompt] = useState(initialPrompt || DEFAULT_BATCH_PROMPT);
  const [variablesExpanded, setVariablesExpanded] = useState(false);
  const [savedPrompt, setSavedPrompt] = useState(initialPrompt || '');
  const [promptComposerOpen, setPromptComposerOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Playbook management callback to apply loaded playbook configuration
  const handleApplyPlaybook = useCallback((data: {
    documents: BatchDocumentEntry[];
    loopEnabled: boolean;
    maxLoops: number | null;
    prompt: string;
  }) => {
    setDocuments(data.documents);
    setLoopEnabled(data.loopEnabled);
    setMaxLoops(data.maxLoops);
    setPrompt(data.prompt);
  }, []);

  // Playbook management hook
  const {
    playbooks,
    loadedPlaybook,
    loadingPlaybooks,
    savingPlaybook,
    isPlaybookModified,
    showPlaybookDropdown,
    setShowPlaybookDropdown,
    showSavePlaybookModal,
    setShowSavePlaybookModal,
    showDeleteConfirmModal,
    playbookToDelete,
    playbackDropdownRef,
    handleLoadPlaybook,
    handleDeletePlaybook,
    handleConfirmDeletePlaybook,
    handleCancelDeletePlaybook,
    handleExportPlaybook,
    handleImportPlaybook,
    handleSaveAsPlaybook,
    handleSaveUpdate,
    handleDiscardChanges,
  } = usePlaybookManagement({
    sessionId,
    folderPath,
    allDocuments,
    config: {
      documents,
      loopEnabled,
      maxLoops,
      prompt,
    },
    onApplyPlaybook: handleApplyPlaybook,
  });

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

  // Register layer on mount
  useEffect(() => {
    const id = registerLayer({
      type: 'modal',
      priority: MODAL_PRIORITIES.BATCH_RUNNER,
      blocksLowerLayers: true,
      capturesFocus: true,
      focusTrap: 'strict',
      onEscape: () => {
        if (showDeleteConfirmModal) {
          handleCancelDeletePlaybook();
        } else if (showSavePlaybookModal) {
          setShowSavePlaybookModal(false);
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
  }, [registerLayer, unregisterLayer, showSavePlaybookModal, showDeleteConfirmModal, handleCancelDeletePlaybook]);

  // Update handler when dependencies change
  useEffect(() => {
    if (layerIdRef.current) {
      updateLayerHandler(layerIdRef.current, () => {
        if (showDeleteConfirmModal) {
          handleCancelDeletePlaybook();
        } else if (showSavePlaybookModal) {
          setShowSavePlaybookModal(false);
        } else {
          onClose();
        }
      });
    }
  }, [onClose, updateLayerHandler, showSavePlaybookModal, showDeleteConfirmModal, handleCancelDeletePlaybook]);

  // Focus textarea on mount
  useEffect(() => {
    setTimeout(() => textareaRef.current?.focus(), 100);
  }, []);

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

    // Build config (worktree configuration is now managed separately via WorktreeConfigModal)
    const config: BatchRunConfig = {
      documents: validDocuments,
      prompt,
      loopEnabled,
      maxLoops: loopEnabled ? maxLoops : null
    };

    console.log('[BatchRunnerModal] handleGo - calling onGo with config:', config);
    window.maestro.logger.log('info', 'Go button clicked', 'BatchRunnerModal', {
      documentsCount: validDocuments.length,
    });

    onGo(config);
    onClose();
  };

  const isModified = prompt !== DEFAULT_BATCH_PROMPT;
  const hasUnsavedChanges = prompt !== savedPrompt && prompt !== DEFAULT_BATCH_PROMPT;

  return (
    <div
      className="fixed inset-0 modal-overlay flex items-center justify-center z-[9999] animate-in fade-in duration-200"
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
                    className="absolute top-full left-0 mt-1 min-w-64 max-w-[calc(700px-48px)] w-max rounded-lg border shadow-lg z-10 overflow-hidden"
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
                            className="flex-1 text-sm"
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
          <DocumentsPanel
            theme={theme}
            documents={documents}
            setDocuments={setDocuments}
            taskCounts={taskCounts}
            loadingTaskCounts={loadingTaskCounts}
            loopEnabled={loopEnabled}
            setLoopEnabled={setLoopEnabled}
            maxLoops={maxLoops}
            setMaxLoops={setMaxLoops}
            allDocuments={allDocuments}
            documentTree={documentTree as import('./DocumentsPanel').DocTreeNode[] | undefined}
            onRefreshDocuments={onRefreshDocuments}
          />

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
                onKeyDown={(e) => {
                  // Insert actual tab character instead of moving focus
                  if (e.key === 'Tab') {
                    e.preventDefault();
                    const textarea = e.currentTarget;
                    const start = textarea.selectionStart;
                    const end = textarea.selectionEnd;
                    const newValue = prompt.substring(0, start) + '\t' + prompt.substring(end);
                    setPrompt(newValue);
                    // Restore cursor position after the tab
                    requestAnimationFrame(() => {
                      textarea.selectionStart = start + 1;
                      textarea.selectionEnd = start + 1;
                    });
                  }
                }}
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
        <div className="p-4 border-t flex items-center justify-between shrink-0" style={{ borderColor: theme.colors.border }}>
          {/* Left side: Hint */}
          <div className="flex items-center gap-2 text-xs" style={{ color: theme.colors.textDim }}>
            <span className="px-1.5 py-0.5 rounded border text-[10px] font-mono" style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgActivity }}>
              {isMacPlatform() ? '⌘' : 'Ctrl'} + Drag
            </span>
            <span>to copy document</span>
          </div>

          {/* Right side: Buttons */}
          <div className="flex items-center gap-2">
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
      </div>

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
