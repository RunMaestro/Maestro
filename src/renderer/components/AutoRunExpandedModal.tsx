import { useEffect, useRef, useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Minimize2, Eye, Edit, Play, Square, Loader2, Image, Save, RotateCcw } from 'lucide-react';
import type { Theme, BatchRunState, SessionState, Shortcut } from '../types';
import { useLayerStack } from '../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { AutoRun, AutoRunHandle } from './AutoRun';
import type { DocumentTaskCount } from './AutoRunDocumentSelector';
import { formatShortcutKeys } from '../utils/shortcutFormatter';

interface AutoRunExpandedModalProps {
  theme: Theme;
  onClose: () => void;
  // Pass through all AutoRun props
  sessionId: string;
  folderPath: string | null;
  selectedFile: string | null;
  documentList: string[];
  documentTree?: Array<{ name: string; type: 'file' | 'folder'; path: string; children?: unknown[] }>;
  content: string;
  onContentChange: (content: string) => void;
  contentVersion?: number;
  // Optional external draft content management (for sharing between panel and expanded modal)
  externalLocalContent?: string;
  onExternalLocalContentChange?: (content: string) => void;
  externalSavedContent?: string;
  onExternalSavedContentChange?: (content: string) => void;
  mode: 'edit' | 'preview';
  onModeChange: (mode: 'edit' | 'preview') => void;
  initialCursorPosition?: number;
  initialEditScrollPos?: number;
  initialPreviewScrollPos?: number;
  onStateChange?: (state: {
    mode: 'edit' | 'preview';
    cursorPosition: number;
    editScrollPos: number;
    previewScrollPos: number;
  }) => void;
  onOpenSetup: () => void;
  onRefresh: () => void;
  onSelectDocument: (filename: string) => void;
  onCreateDocument: (filename: string) => Promise<boolean>;
  isLoadingDocuments?: boolean;
  documentTaskCounts?: Map<string, DocumentTaskCount>;  // Task counts per document
  batchRunState?: BatchRunState;
  onOpenBatchRunner?: () => void;
  onStopBatchRun?: () => void;
  // Error handling callbacks (Phase 5.10)
  onSkipCurrentDocument?: () => void;
  onAbortBatchOnError?: () => void;
  onResumeAfterError?: () => void;
  sessionState?: SessionState;
  shortcuts?: Record<string, Shortcut>;
}

export function AutoRunExpandedModal({
  theme,
  onClose,
  mode: initialMode,
  onModeChange,
  onStateChange,
  batchRunState,
  onOpenBatchRunner,
  onStopBatchRun,
  // Error handling callbacks (Phase 5.10)
  onSkipCurrentDocument,
  onAbortBatchOnError,
  onResumeAfterError,
  sessionState,
  shortcuts,
  ...autoRunProps
}: AutoRunExpandedModalProps) {
  const { registerLayer, unregisterLayer, updateLayerHandler } = useLayerStack();
  const layerIdRef = useRef<string>();
  const onCloseRef = useRef(onClose);
  const autoRunRef = useRef<AutoRunHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  onCloseRef.current = onClose;

  // Local mode state - independent from the right panel behind the modal
  const [localMode, setLocalMode] = useState<'edit' | 'preview'>(initialMode);

  // Wrap onStateChange to prevent mode from propagating to parent
  // This keeps the expanded modal's mode independent from the right panel
  const handleStateChange = useCallback((state: {
    mode: 'edit' | 'preview';
    cursorPosition: number;
    editScrollPos: number;
    previewScrollPos: number;
  }) => {
    if (onStateChange) {
      // Pass through cursor and scroll positions, but keep the parent's current mode
      onStateChange({
        ...state,
        mode: initialMode, // Don't propagate mode changes to parent
      });
    }
  }, [onStateChange, initialMode]);

  const isLocked = batchRunState?.isRunning || false;
  const isAgentBusy = sessionState === 'busy' || sessionState === 'connecting';
  const isStopping = batchRunState?.isStopping || false;

  // Track dirty state from AutoRun component
  const [isDirty, setIsDirty] = useState(false);

  // Poll dirty state from AutoRun ref
  useEffect(() => {
    const interval = setInterval(() => {
      if (autoRunRef.current) {
        setIsDirty(autoRunRef.current.isDirty());
      }
    }, 100);
    return () => clearInterval(interval);
  }, []);

  // Save handler
  const handleSave = useCallback(async () => {
    if (autoRunRef.current) {
      await autoRunRef.current.save();
      setIsDirty(false);
    }
  }, []);

  // Revert handler
  const handleRevert = useCallback(() => {
    if (autoRunRef.current) {
      autoRunRef.current.revert();
      setIsDirty(false);
    }
  }, []);

  // Register layer on mount
  useEffect(() => {
    const id = registerLayer({
      type: 'modal',
      priority: MODAL_PRIORITIES.AUTORUN_EXPANDED,
      blocksLowerLayers: true,
      capturesFocus: true,
      focusTrap: 'strict',
      onEscape: () => {
        onCloseRef.current();
      }
    });
    layerIdRef.current = id;

    return () => {
      if (layerIdRef.current) {
        unregisterLayer(layerIdRef.current);
      }
    };
  }, [registerLayer, unregisterLayer]);

  // Keep escape handler up to date
  useEffect(() => {
    if (layerIdRef.current) {
      updateLayerHandler(layerIdRef.current, () => {
        onCloseRef.current();
      });
    }
  }, [onClose, updateLayerHandler]);

  // Focus the AutoRun component on mount
  useEffect(() => {
    const timer = setTimeout(() => {
      autoRunRef.current?.focus();
    }, 50);
    return () => clearTimeout(timer);
  }, []);

  // Use the AutoRun's switchMode for scroll sync, falling back to local mode change
  const setMode = useCallback((newMode: 'edit' | 'preview') => {
    if (autoRunRef.current?.switchMode) {
      autoRunRef.current.switchMode(newMode);
    } else {
      setLocalMode(newMode);
      onModeChange(newMode);
    }
  }, [onModeChange]);

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      style={{ backgroundColor: 'rgba(0,0,0,0.7)' }}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      {/* Modal - same size as PromptComposer for consistency */}
      <div
        className="relative w-[90vw] h-[80vh] max-w-5xl overflow-hidden rounded-xl border shadow-2xl flex flex-col"
        style={{
          backgroundColor: theme.colors.bgSidebar,
          borderColor: theme.colors.border
        }}
      >
        {/* Header with controls */}
        <div
          className="flex items-center justify-between px-4 py-3 border-b shrink-0"
          style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgActivity }}
        >
          {/* Left side - Title */}
          <h2 className="text-sm font-semibold" style={{ color: theme.colors.textMain }}>
            Auto Run
          </h2>

          {/* Center - Mode controls */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => !isLocked && setMode('edit')}
              disabled={isLocked}
              className={`flex items-center gap-2 px-3 py-1.5 rounded text-xs transition-colors ${
                localMode === 'edit' && !isLocked ? 'font-semibold' : ''
              } ${isLocked ? 'opacity-50 cursor-not-allowed' : ''}`}
              style={{
                backgroundColor: localMode === 'edit' && !isLocked ? theme.colors.bgMain : 'transparent',
                color: isLocked ? theme.colors.textDim : (localMode === 'edit' ? theme.colors.textMain : theme.colors.textDim),
                border: `1px solid ${localMode === 'edit' && !isLocked ? theme.colors.accent : theme.colors.border}`
              }}
              title={isLocked ? 'Editing disabled while Auto Run active' : 'Edit document'}
            >
              <Edit className="w-3.5 h-3.5" />
              Edit
            </button>
            <button
              onClick={() => setMode('preview')}
              className={`flex items-center gap-2 px-3 py-1.5 rounded text-xs transition-colors ${
                localMode === 'preview' || isLocked ? 'font-semibold' : ''
              }`}
              style={{
                backgroundColor: localMode === 'preview' || isLocked ? theme.colors.bgMain : 'transparent',
                color: localMode === 'preview' || isLocked ? theme.colors.textMain : theme.colors.textDim,
                border: `1px solid ${localMode === 'preview' || isLocked ? theme.colors.accent : theme.colors.border}`
              }}
              title="Preview document"
            >
              <Eye className="w-3.5 h-3.5" />
              Preview
            </button>
            {/* Image upload button - hidden for now, can be re-enabled when needed
            <button
              onClick={() => localMode === 'edit' && !isLocked && fileInputRef.current?.click()}
              disabled={localMode !== 'edit' || isLocked}
              className={`flex items-center justify-center w-8 h-8 rounded text-xs transition-colors ${
                localMode === 'edit' && !isLocked ? 'hover:opacity-80' : 'opacity-30 cursor-not-allowed'
              }`}
              style={{
                backgroundColor: 'transparent',
                color: theme.colors.textDim,
                border: `1px solid ${theme.colors.border}`
              }}
              title={localMode === 'edit' && !isLocked ? 'Add image (or paste from clipboard)' : 'Switch to Edit mode to add images'}
            >
              <Image className="w-3.5 h-3.5" />
            </button>
            */}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
            />
            {/* Save/Revert buttons - shown when dirty */}
            {isDirty && localMode === 'edit' && !isLocked && (
              <>
                <div className="w-px h-4 mx-1" style={{ backgroundColor: theme.colors.border }} />
                <button
                  onClick={handleRevert}
                  className="flex items-center gap-1.5 px-2 py-1 rounded text-xs transition-colors hover:opacity-80"
                  style={{
                    backgroundColor: 'transparent',
                    color: theme.colors.textDim,
                    border: `1px solid ${theme.colors.border}`
                  }}
                  title="Discard changes"
                >
                  <RotateCcw className="w-3 h-3" />
                  Revert
                </button>
                <button
                  onClick={handleSave}
                  className="group relative flex items-center gap-1.5 px-2 py-1 rounded text-xs transition-colors hover:opacity-80"
                  style={{
                    backgroundColor: theme.colors.accent,
                    color: theme.colors.accentForeground,
                    border: `1px solid ${theme.colors.accent}`
                  }}
                  title="Save changes"
                >
                  <Save className="w-3 h-3" />
                  Save
                  {/* Keyboard shortcut overlay on hover */}
                  <span
                    className="absolute -bottom-6 left-1/2 -translate-x-1/2 px-1.5 py-0.5 rounded text-[10px] whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"
                    style={{
                      backgroundColor: theme.colors.bgMain,
                      color: theme.colors.textDim,
                      border: `1px solid ${theme.colors.border}`,
                    }}
                  >
                    ⌘S
                  </span>
                </button>
              </>
            )}
            {/* Run / Stop button */}
            {isLocked ? (
              <button
                onClick={onStopBatchRun}
                disabled={isStopping}
                className={`flex items-center gap-2 px-3 py-1.5 rounded text-xs transition-colors font-semibold ${isStopping ? 'opacity-50 cursor-not-allowed' : ''}`}
                style={{
                  backgroundColor: theme.colors.error,
                  color: 'white',
                  border: `1px solid ${theme.colors.error}`
                }}
                title={isStopping ? 'Stopping after current task...' : 'Stop batch run'}
              >
                {isStopping ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Square className="w-3.5 h-3.5" />
                )}
                {isStopping ? 'Stopping...' : 'Stop'}
              </button>
            ) : (
              <button
                onClick={() => {
                  // Save before opening batch runner if dirty
                  if (isDirty) {
                    handleSave();
                  }
                  onOpenBatchRunner?.();
                }}
                disabled={isAgentBusy}
                className={`flex items-center gap-2 px-3 py-1.5 rounded text-xs transition-colors ${isAgentBusy ? 'opacity-50 cursor-not-allowed' : 'hover:opacity-90'}`}
                style={{
                  backgroundColor: theme.colors.accent,
                  color: theme.colors.accentForeground,
                  border: `1px solid ${theme.colors.accent}`
                }}
                title={isAgentBusy ? "Cannot run while agent is thinking" : "Run batch processing on Auto Run tasks"}
              >
                <Play className="w-3.5 h-3.5" />
                Run
              </button>
            )}
          </div>

          {/* Right side - Collapse/Close */}
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="flex items-center gap-1.5 px-2 py-1 rounded text-xs transition-colors hover:bg-white/10"
              style={{ color: theme.colors.textDim }}
              title={`Collapse${shortcuts?.toggleAutoRunExpanded ? ` (${formatShortcutKeys(shortcuts.toggleAutoRunExpanded.keys)})` : ' (Esc)'}`}
            >
              <Minimize2 className="w-4 h-4" />
              Collapse
            </button>
            <button
              onClick={onClose}
              className="p-1 rounded hover:bg-white/10 transition-colors"
              title="Close (Esc)"
            >
              <X className="w-5 h-5" style={{ color: theme.colors.textDim }} />
            </button>
          </div>
        </div>

        {/* AutoRun Content - hide top controls since they're in header */}
        <div className="flex-1 min-h-0 overflow-hidden p-4">
          <AutoRun
            ref={autoRunRef}
            theme={theme}
            mode={localMode}
            onModeChange={setLocalMode}
            onStateChange={handleStateChange}
            batchRunState={batchRunState}
            onOpenBatchRunner={onOpenBatchRunner}
            onStopBatchRun={onStopBatchRun}
            onSkipCurrentDocument={onSkipCurrentDocument}
            onAbortBatchOnError={onAbortBatchOnError}
            onResumeAfterError={onResumeAfterError}
            sessionState={sessionState}
            hideTopControls
            {...autoRunProps}
          />
        </div>
      </div>
    </div>,
    document.body
  );
}
