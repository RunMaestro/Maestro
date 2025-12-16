import React, { useState, useRef, useEffect, useLayoutEffect, useCallback, memo, useMemo, forwardRef, useImperativeHandle } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Eye, Edit, Play, Square, HelpCircle, Loader2, Image, X, Search, ChevronDown, ChevronRight, FolderOpen, FileText, RefreshCw, Maximize2 } from 'lucide-react';
import type { BatchRunState, SessionState, Theme, Shortcut } from '../types';
import { AutoRunnerHelpModal } from './AutoRunnerHelpModal';
import { MermaidRenderer } from './MermaidRenderer';
import { AutoRunDocumentSelector, DocumentTaskCount } from './AutoRunDocumentSelector';
import { AutoRunLightbox } from './AutoRunLightbox';
import { AutoRunSearchBar } from './AutoRunSearchBar';
import { useTemplateAutocomplete } from '../hooks/useTemplateAutocomplete';
import { useAutoRunUndo } from '../hooks/useAutoRunUndo';
import { useAutoRunImageHandling, imageCache } from '../hooks/useAutoRunImageHandling';
import { TemplateAutocompleteDropdown } from './TemplateAutocompleteDropdown';
import { generateAutoRunProseStyles, createMarkdownComponents } from '../utils/markdownConfig';
import { formatShortcutKeys } from '../utils/shortcutFormatter';

// Memoize remarkPlugins array - it never changes
const REMARK_PLUGINS = [remarkGfm];

interface AutoRunProps {
  theme: Theme;
  sessionId: string; // Maestro session ID for per-session attachment storage

  // Folder & document state
  folderPath: string | null;
  selectedFile: string | null;
  documentList: string[];  // Filenames without .md
  documentTree?: Array<{ name: string; type: 'file' | 'folder'; path: string; children?: unknown[] }>;  // Tree structure for subfolders

  // Content state
  content: string;
  onContentChange: (content: string) => void;
  contentVersion?: number;  // Incremented on external file changes to force-sync

  // Optional external draft content management (for sharing between panel and expanded modal)
  // When provided, the component uses these instead of internal localContent state
  externalLocalContent?: string;
  onExternalLocalContentChange?: (content: string) => void;
  externalSavedContent?: string;
  onExternalSavedContentChange?: (content: string) => void;

  // Mode state
  mode: 'edit' | 'preview';
  onModeChange: (mode: 'edit' | 'preview') => void;

  // Scroll/cursor state
  initialCursorPosition?: number;
  initialEditScrollPos?: number;
  initialPreviewScrollPos?: number;
  onStateChange?: (state: {
    mode: 'edit' | 'preview';
    cursorPosition: number;
    editScrollPos: number;
    previewScrollPos: number;
  }) => void;

  // Actions
  onOpenSetup: () => void;
  onRefresh: () => void;
  onSelectDocument: (filename: string) => void;
  onCreateDocument: (filename: string) => Promise<boolean>;
  isLoadingDocuments?: boolean;
  documentTaskCounts?: Map<string, DocumentTaskCount>;  // Task counts per document path

  // Batch processing props
  batchRunState?: BatchRunState;
  onOpenBatchRunner?: () => void;
  onStopBatchRun?: () => void;

  // Session state for disabling Run when agent is busy
  sessionState?: SessionState;

  // Expand to modal callback
  onExpand?: () => void;

  // Shortcuts for displaying hotkey hints
  shortcuts?: Record<string, Shortcut>;

  // Hide top controls (when rendered in expanded modal with controls in header)
  hideTopControls?: boolean;

  // Legacy prop for backwards compatibility
  onChange?: (content: string) => void;
}

export interface AutoRunHandle {
  focus: () => void;
  switchMode: (mode: 'edit' | 'preview') => void;
  isDirty: () => boolean;
  save: () => Promise<void>;
  revert: () => void;
}

// Custom image component that loads images from the Auto Run folder or external URLs
function AttachmentImage({
  src,
  alt,
  folderPath,
  theme,
  onImageClick
}: {
  src?: string;
  alt?: string;
  folderPath: string | null;
  theme: any;
  onImageClick?: (filename: string) => void;
}) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filename, setFilename] = useState<string | null>(null);

  useEffect(() => {
    if (!src) {
      setLoading(false);
      return;
    }

    // Check if this is a relative path (e.g., images/{docName}-{timestamp}.{ext})
    if (src.startsWith('images/') && folderPath) {
      const fname = src.split('/').pop() || src;
      setFilename(fname);
      const cacheKey = `${folderPath}:${src}`;

      // Check cache first
      if (imageCache.has(cacheKey)) {
        setDataUrl(imageCache.get(cacheKey)!);
        setLoading(false);
        return;
      }

      // Load from folder using absolute path
      const absolutePath = `${folderPath}/${src}`;
      window.maestro.fs.readFile(absolutePath)
        .then((result) => {
          if (result.startsWith('data:')) {
            imageCache.set(cacheKey, result);
            setDataUrl(result);
          } else {
            setError('Invalid image data');
          }
          setLoading(false);
        })
        .catch((err) => {
          setError(`Failed to load image: ${err.message || 'Unknown error'}`);
          setLoading(false);
        });
    } else if (src.startsWith('data:')) {
      // Already a data URL
      setDataUrl(src);
      setFilename(null);
      setLoading(false);
    } else if (src.startsWith('http://') || src.startsWith('https://')) {
      // External URL - just use it directly
      setDataUrl(src);
      setFilename(null);
      setLoading(false);
    } else if (src.startsWith('/')) {
      // Absolute file path - load via IPC
      setFilename(src.split('/').pop() || null);
      window.maestro.fs.readFile(src)
        .then((result) => {
          if (result.startsWith('data:')) {
            setDataUrl(result);
          } else {
            setError('Invalid image data');
          }
          setLoading(false);
        })
        .catch((err) => {
          setError(`Failed to load image: ${err.message || 'Unknown error'}`);
          setLoading(false);
        });
    } else {
      // Other relative path - try to load as file from folderPath if available
      setFilename(src.split('/').pop() || null);
      const pathToLoad = folderPath ? `${folderPath}/${src}` : src;
      window.maestro.fs.readFile(pathToLoad)
        .then((result) => {
          if (result.startsWith('data:')) {
            setDataUrl(result);
          } else {
            setError('Invalid image data');
          }
          setLoading(false);
        })
        .catch((err) => {
          setError(`Failed to load image: ${err.message || 'Unknown error'}`);
          setLoading(false);
        });
    }
  }, [src, folderPath]);

  if (loading) {
    return (
      <div
        className="inline-flex items-center gap-2 px-3 py-2 rounded"
        style={{ backgroundColor: theme.colors.bgActivity }}
      >
        <Loader2 className="w-4 h-4 animate-spin" style={{ color: theme.colors.textDim }} />
        <span className="text-xs" style={{ color: theme.colors.textDim }}>Loading image...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div
        className="inline-flex items-center gap-2 px-3 py-2 rounded"
        style={{ backgroundColor: theme.colors.bgActivity, borderColor: theme.colors.error, border: '1px solid' }}
      >
        <Image className="w-4 h-4" style={{ color: theme.colors.error }} />
        <span className="text-xs" style={{ color: theme.colors.error }}>{error}</span>
      </div>
    );
  }

  if (!dataUrl) {
    return null;
  }

  return (
    <span
      className="inline-block align-middle mx-1 my-1 cursor-pointer group relative"
      onClick={() => onImageClick?.(filename || src || '')}
      title={filename ? `Click to enlarge: ${filename}` : 'Click to enlarge'}
    >
      <img
        src={dataUrl}
        alt={alt || ''}
        className="rounded border hover:opacity-90 transition-all hover:shadow-lg"
        style={{
          maxHeight: '120px',
          maxWidth: '200px',
          objectFit: 'contain',
          borderColor: theme.colors.border,
        }}
      />
      {/* Zoom hint overlay */}
      <span
        className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity rounded"
        style={{ backgroundColor: 'rgba(0,0,0,0.4)' }}
      >
        <Search className="w-5 h-5 text-white" />
      </span>
    </span>
  );
}

// Component for displaying search-highlighted content using safe DOM methods
function SearchHighlightedContent({
  content,
  searchQuery,
  currentMatchIndex,
  theme,
  onMatchesRendered
}: {
  content: string;
  searchQuery: string;
  currentMatchIndex: number;
  theme: any;
  onMatchesRendered?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;

    // Clear existing content
    ref.current.textContent = '';

    if (!searchQuery.trim()) {
      ref.current.textContent = content;
      return;
    }

    const escapedQuery = searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(${escapedQuery})`, 'gi');
    const parts = content.split(regex);
    let matchIndex = 0;

    parts.forEach((part) => {
      if (part.toLowerCase() === searchQuery.toLowerCase()) {
        // This is a match - create a highlighted mark element
        const mark = document.createElement('mark');
        mark.className = 'search-match';
        mark.textContent = part;
        mark.style.padding = '0 2px';
        mark.style.borderRadius = '2px';
        if (matchIndex === currentMatchIndex) {
          mark.style.backgroundColor = theme.colors.accent;
          mark.style.color = '#fff';
          mark.dataset.current = 'true';
        } else {
          mark.style.backgroundColor = '#ffd700';
          mark.style.color = '#000';
        }
        ref.current!.appendChild(mark);
        matchIndex++;
      } else {
        // Regular text - create a text node
        ref.current!.appendChild(document.createTextNode(part));
      }
    });

    // Notify parent that marks are rendered so it can scroll
    if (onMatchesRendered) {
      // Use requestAnimationFrame to ensure DOM is painted
      requestAnimationFrame(() => onMatchesRendered());
    }
  }, [content, searchQuery, currentMatchIndex, theme.colors.accent, onMatchesRendered]);

  return (
    <div
      ref={ref}
      className="font-mono text-sm whitespace-pre-wrap"
      style={{ color: theme.colors.textMain }}
    />
  );
}

// Image preview thumbnail for staged images in edit mode
function ImagePreview({
  src,
  filename,
  theme,
  onRemove,
  onImageClick
}: {
  src: string;
  filename: string;
  theme: any;
  onRemove: () => void;
  onImageClick: (filename: string) => void;
}) {
  return (
    <div
      className="relative inline-block group"
      style={{ margin: '4px' }}
    >
      <img
        src={src}
        alt={filename}
        className="w-20 h-20 object-cover rounded cursor-pointer hover:opacity-80 transition-opacity"
        style={{ border: `1px solid ${theme.colors.border}` }}
        onClick={() => onImageClick(filename)}
      />
      <button
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        className="absolute -top-2 -right-2 w-5 h-5 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
        style={{
          backgroundColor: theme.colors.error,
          color: 'white'
        }}
        title="Remove image"
      >
        <X className="w-3 h-3" />
      </button>
      <div
        className="absolute bottom-0 left-0 right-0 px-1 py-0.5 text-[9px] truncate rounded-b"
        style={{
          backgroundColor: 'rgba(0,0,0,0.6)',
          color: 'white'
        }}
      >
        {filename}
      </div>
    </div>
  );
}

// Inner implementation component
const AutoRunInner = forwardRef<AutoRunHandle, AutoRunProps>(function AutoRunInner({
  theme,
  sessionId,
  folderPath,
  selectedFile,
  documentList,
  documentTree,
  content,
  onContentChange,
  contentVersion = 0,  // Used to force-sync on external file changes
  externalLocalContent,
  onExternalLocalContentChange,
  externalSavedContent,
  onExternalSavedContentChange,
  mode: externalMode,
  onModeChange,
  initialCursorPosition = 0,
  initialEditScrollPos = 0,
  initialPreviewScrollPos = 0,
  onStateChange,
  onOpenSetup,
  onRefresh,
  onSelectDocument,
  onCreateDocument,
  isLoadingDocuments = false,
  documentTaskCounts,
  batchRunState,
  onOpenBatchRunner,
  onStopBatchRun,
  sessionState,
  onExpand,
  shortcuts,
  hideTopControls = false,
  onChange,  // Legacy prop for backwards compatibility
}, ref) {
  // Only lock the editor when Auto Run is running WITHOUT a worktree (directly on main repo)
  // AND only for documents that are part of the current Auto Run
  // Documents not in the Auto Run can still be edited
  const isLocked = (
    batchRunState?.isRunning &&
    !batchRunState?.worktreeActive &&
    selectedFile !== null &&
    batchRunState?.lockedDocuments?.includes(selectedFile)
  ) || false;
  const isAgentBusy = sessionState === 'busy' || sessionState === 'connecting';
  const isStopping = batchRunState?.isStopping || false;

  // Use external mode if provided, otherwise use local state
  const [localMode, setLocalMode] = useState<'edit' | 'preview'>(externalMode || 'edit');
  const mode = externalMode || localMode;
  const setMode = useCallback((newMode: 'edit' | 'preview') => {
    if (onModeChange) {
      onModeChange(newMode);
    } else {
      setLocalMode(newMode);
    }
  }, [onModeChange]);

  // Use onContentChange if provided, otherwise fall back to legacy onChange
  const handleContentChange = onContentChange || onChange || (() => {});

  // Local content state for responsive typing
  // Always use internal state for immediate feedback, but sync with external state when provided
  // On initial mount, prefer external state if provided (for restoring draft from shared state)
  const [internalLocalContent, setInternalLocalContent] = useState(
    externalLocalContent !== undefined ? externalLocalContent : content
  );

  // Use refs for external callbacks to ensure stable callback identity
  const externalLocalContentChangeRef = useRef(onExternalLocalContentChange);
  externalLocalContentChangeRef.current = onExternalLocalContentChange;

  // Sync internal state FROM external state when external state changes
  // This handles: opening expanded modal with existing draft, or panel receiving updates from modal
  const prevExternalLocalContentRef = useRef(externalLocalContent);
  useEffect(() => {
    if (externalLocalContent !== undefined &&
        externalLocalContent !== prevExternalLocalContentRef.current &&
        externalLocalContent !== internalLocalContent) {
      setInternalLocalContent(externalLocalContent);
    }
    prevExternalLocalContentRef.current = externalLocalContent;
  }, [externalLocalContent, internalLocalContent]);

  // Always use internal state for display (provides immediate feedback)
  const localContent = internalLocalContent;

  const setLocalContent = useCallback((newContent: string) => {
    // Always update internal state for immediate feedback
    setInternalLocalContent(newContent);
    // Also propagate to external callback if provided (for sharing with expanded modal)
    if (externalLocalContentChangeRef.current) {
      externalLocalContentChangeRef.current(newContent);
    }
  }, []); // Empty deps - uses ref for external callback

  // Track the saved content to detect dirty state (unsaved changes)
  // On initial mount, prefer external state if provided
  const [internalSavedContent, setInternalSavedContent] = useState(
    externalSavedContent !== undefined ? externalSavedContent : content
  );

  // Use refs for external callbacks to ensure stable callback identity
  const externalSavedContentChangeRef = useRef(onExternalSavedContentChange);
  externalSavedContentChangeRef.current = onExternalSavedContentChange;

  // Sync internal saved state FROM external state when external state changes
  const prevExternalSavedContentRef = useRef(externalSavedContent);
  useEffect(() => {
    if (externalSavedContent !== undefined &&
        externalSavedContent !== prevExternalSavedContentRef.current &&
        externalSavedContent !== internalSavedContent) {
      setInternalSavedContent(externalSavedContent);
    }
    prevExternalSavedContentRef.current = externalSavedContent;
  }, [externalSavedContent, internalSavedContent]);

  // Always use internal state for saved content comparison
  const savedContent = internalSavedContent;

  const setSavedContent = useCallback((newContent: string) => {
    // Always update internal state
    setInternalSavedContent(newContent);
    // Also propagate to external callback if provided
    if (externalSavedContentChangeRef.current) {
      externalSavedContentChangeRef.current(newContent);
    }
  }, []); // Empty deps - uses ref for external callback

  // Dirty state: true when localContent differs from savedContent
  const isDirty = localContent !== savedContent;

  // Track previous session/document to detect switches
  const prevSessionIdRef = useRef(sessionId);
  const prevSelectedFileRef = useRef(selectedFile);
  const prevContentVersionRef = useRef(contentVersion);

  // Sync local content when session/document changes or external file changes
  useEffect(() => {
    const sessionChanged = sessionId !== prevSessionIdRef.current;
    const documentChanged = selectedFile !== prevSelectedFileRef.current;
    const versionChanged = contentVersion !== prevContentVersionRef.current;

    if (sessionChanged || documentChanged || versionChanged) {
      // Reset to the new content from props (discard any unsaved changes)
      setLocalContent(content);
      setSavedContent(content);
      prevSessionIdRef.current = sessionId;
      prevSelectedFileRef.current = selectedFile;
      prevContentVersionRef.current = contentVersion;
    }
  }, [sessionId, selectedFile, contentVersion, content, setLocalContent, setSavedContent]);

  // Save function - writes to disk
  // Note: We do NOT call handleContentChange here because it would update the
  // activeSession's content, which may be a different session than the one we're
  // editing (during rapid session switches). The file watcher will pick up the
  // change and update the correct session's content.
  const handleSave = useCallback(async () => {
    if (!folderPath || !selectedFile || !isDirty) return;

    try {
      await window.maestro.autorun.writeDoc(folderPath, selectedFile + '.md', localContent);
      setSavedContent(localContent);
    } catch (err) {
      console.error('Failed to save:', err);
    }
  }, [folderPath, selectedFile, localContent, isDirty, setSavedContent]);

  // Revert function - discard changes
  const handleRevert = useCallback(() => {
    setLocalContent(savedContent);
  }, [savedContent, setLocalContent]);

  // Track mode before auto-run to restore when it ends
  const modeBeforeAutoRunRef = useRef<'edit' | 'preview' | null>(null);
  const [helpModalOpen, setHelpModalOpen] = useState(false);
  // Search state
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const [totalMatches, setTotalMatches] = useState(0);
  const matchElementsRef = useRef<HTMLElement[]>([]);
  // Refresh animation state for empty state button
  const [isRefreshingEmpty, setIsRefreshingEmpty] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // Track scroll positions in refs to preserve across re-renders
  const previewScrollPosRef = useRef(initialPreviewScrollPos);
  const editScrollPosRef = useRef(initialEditScrollPos);

  // Template variable autocomplete hook
  const {
    autocompleteState,
    handleKeyDown: handleAutocompleteKeyDown,
    handleChange: handleAutocompleteChange,
    selectVariable,
    closeAutocomplete,
    autocompleteRef,
  } = useTemplateAutocomplete({
    textareaRef,
    value: localContent,
    onChange: setLocalContent,
  });

  // Undo/Redo functionality hook
  const {
    pushUndoState,
    scheduleUndoSnapshot,
    handleUndo,
    handleRedo,
    resetUndoHistory,
    lastUndoSnapshotRef,
  } = useAutoRunUndo({
    selectedFile,
    localContent,
    setLocalContent,
    textareaRef,
  });

  // Reset undo history when document changes (session or file change)
  useEffect(() => {
    // Reset undo history snapshot to the new content (so first edit creates a proper undo point)
    resetUndoHistory(content);
  }, [selectedFile, sessionId, content, resetUndoHistory]);

  // Image handling hook (attachments, paste, upload, lightbox)
  const {
    attachmentsList,
    attachmentPreviews,
    attachmentsExpanded,
    setAttachmentsExpanded,
    lightboxFilename,
    lightboxExternalUrl,
    fileInputRef,
    handlePaste,
    handleFileSelect,
    handleRemoveAttachment,
    openLightboxByFilename,
    closeLightbox,
    handleLightboxNavigate,
    handleLightboxDelete,
  } = useAutoRunImageHandling({
    folderPath,
    selectedFile,
    localContent,
    setLocalContent,
    handleContentChange,
    isLocked,
    textareaRef,
    pushUndoState,
    lastUndoSnapshotRef,
  });

  // Switch mode with scroll position synchronization
  const switchMode = useCallback((newMode: 'edit' | 'preview') => {
    if (newMode === mode) return;

    // Calculate scroll percentage from current mode to apply to new mode
    let scrollPercent = 0;
    if (mode === 'edit' && textareaRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = textareaRef.current;
      const maxScroll = scrollHeight - clientHeight;
      scrollPercent = maxScroll > 0 ? scrollTop / maxScroll : 0;
    } else if (mode === 'preview' && previewRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = previewRef.current;
      const maxScroll = scrollHeight - clientHeight;
      scrollPercent = maxScroll > 0 ? scrollTop / maxScroll : 0;
    }

    setMode(newMode);

    // Apply scroll percentage to the new mode after it renders
    requestAnimationFrame(() => {
      if (newMode === 'preview' && previewRef.current) {
        const { scrollHeight, clientHeight } = previewRef.current;
        const maxScroll = scrollHeight - clientHeight;
        const newScrollTop = Math.round(scrollPercent * maxScroll);
        previewRef.current.scrollTop = newScrollTop;
        previewScrollPosRef.current = newScrollTop;
      } else if (newMode === 'edit' && textareaRef.current) {
        const { scrollHeight, clientHeight } = textareaRef.current;
        const maxScroll = scrollHeight - clientHeight;
        const newScrollTop = Math.round(scrollPercent * maxScroll);
        textareaRef.current.scrollTop = newScrollTop;
        editScrollPosRef.current = newScrollTop;
      }
    });

    if (onStateChange) {
      onStateChange({
        mode: newMode,
        cursorPosition: textareaRef.current?.selectionStart || 0,
        editScrollPos: textareaRef.current?.scrollTop || 0,
        previewScrollPos: previewRef.current?.scrollTop || 0
      });
    }
  }, [mode, onStateChange]);

  // Toggle between edit and preview modes
  const toggleMode = useCallback(() => {
    switchMode(mode === 'edit' ? 'preview' : 'edit');
  }, [mode, switchMode]);

  // Expose methods to parent via ref
  useImperativeHandle(ref, () => ({
    focus: () => {
      // Focus the appropriate element based on current mode
      if (mode === 'edit' && textareaRef.current) {
        textareaRef.current.focus();
      } else if (mode === 'preview' && previewRef.current) {
        previewRef.current.focus();
      }
    },
    switchMode,
    isDirty: () => isDirty,
    save: handleSave,
    revert: handleRevert,
  }), [mode, switchMode, isDirty, handleSave, handleRevert]);

  // Auto-switch to preview mode when auto-run starts, restore when it ends
  useEffect(() => {
    if (isLocked) {
      // Auto-run started: save current mode and switch to preview
      modeBeforeAutoRunRef.current = mode;
      if (mode !== 'preview') {
        setMode('preview');
      }
    } else if (modeBeforeAutoRunRef.current !== null) {
      // Auto-run ended: restore previous mode
      setMode(modeBeforeAutoRunRef.current);
      modeBeforeAutoRunRef.current = null;
    }
  }, [isLocked]);

  // Restore cursor and scroll positions when component mounts
  useEffect(() => {
    if (textareaRef.current && initialCursorPosition > 0) {
      textareaRef.current.setSelectionRange(initialCursorPosition, initialCursorPosition);
      textareaRef.current.scrollTop = initialEditScrollPos;
    }
    if (previewRef.current && initialPreviewScrollPos > 0) {
      previewRef.current.scrollTop = initialPreviewScrollPos;
    }
  }, []);

  // Restore scroll position after content changes cause ReactMarkdown to rebuild DOM
  // useLayoutEffect runs synchronously after DOM mutations but before paint
  useLayoutEffect(() => {
    if (mode === 'preview' && previewRef.current && previewScrollPosRef.current > 0) {
      // Use requestAnimationFrame to ensure DOM is fully updated
      requestAnimationFrame(() => {
        if (previewRef.current) {
          previewRef.current.scrollTop = previewScrollPosRef.current;
        }
      });
    }
  }, [localContent, mode, searchOpen, searchQuery]);

  // Auto-focus the active element after mode change
  useEffect(() => {
    if (mode === 'edit' && textareaRef.current) {
      textareaRef.current.focus();
    } else if (mode === 'preview' && previewRef.current) {
      previewRef.current.focus();
    }
  }, [mode]);

  // Handle document selection change - focus the appropriate element
  // Note: Content syncing and editing state reset is handled by the main sync effect above
  // This effect ONLY handles focusing on document change
  const prevFocusSelectedFileRef = useRef(selectedFile);
  useEffect(() => {
    if (!selectedFile) return;

    const isNewDocument = selectedFile !== prevFocusSelectedFileRef.current;
    prevFocusSelectedFileRef.current = selectedFile;

    if (isNewDocument) {
      // Focus on document change
      requestAnimationFrame(() => {
        if (mode === 'edit' && textareaRef.current) {
          textareaRef.current.focus();
        } else if (mode === 'preview' && previewRef.current) {
          previewRef.current.focus();
        }
      });
    }
  }, [selectedFile, mode]);

  // Save cursor position and scroll position when they change
  const handleCursorOrScrollChange = () => {
    if (textareaRef.current) {
      // Save to ref for persistence across re-renders
      editScrollPosRef.current = textareaRef.current.scrollTop;
      if (onStateChange) {
        onStateChange({
          mode,
          cursorPosition: textareaRef.current.selectionStart,
          editScrollPos: textareaRef.current.scrollTop,
          previewScrollPos: previewRef.current?.scrollTop || 0
        });
      }
    }
  };

  const handlePreviewScroll = () => {
    if (previewRef.current) {
      // Save to ref for persistence across re-renders
      previewScrollPosRef.current = previewRef.current.scrollTop;
      if (onStateChange) {
        onStateChange({
          mode,
          cursorPosition: textareaRef.current?.selectionStart || 0,
          editScrollPos: textareaRef.current?.scrollTop || 0,
          previewScrollPos: previewRef.current.scrollTop
        });
      }
    }
  };

  // Handle refresh for empty state with animation
  const handleEmptyStateRefresh = useCallback(async () => {
    setIsRefreshingEmpty(true);
    try {
      await onRefresh();
    } finally {
      // Keep spinner visible for at least 500ms for visual feedback
      setTimeout(() => setIsRefreshingEmpty(false), 500);
    }
  }, [onRefresh]);

  // Open search function
  const openSearch = useCallback(() => {
    setSearchOpen(true);
  }, []);

  // Close search function
  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery('');
    setCurrentMatchIndex(0);
    setTotalMatches(0);
    matchElementsRef.current = [];
    // Refocus appropriate element
    if (mode === 'edit' && textareaRef.current) {
      textareaRef.current.focus();
    } else if (mode === 'preview' && previewRef.current) {
      previewRef.current.focus();
    }
  }, [mode]);

  // Update match count when search query changes
  useEffect(() => {
    if (searchQuery.trim()) {
      const escapedQuery = searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escapedQuery, 'gi');
      const matches = localContent.match(regex);
      const count = matches ? matches.length : 0;
      setTotalMatches(count);
      if (count > 0 && currentMatchIndex >= count) {
        setCurrentMatchIndex(0);
      }
    } else {
      setTotalMatches(0);
      setCurrentMatchIndex(0);
    }
  }, [searchQuery, localContent]);

  // Navigate to next search match
  const goToNextMatch = useCallback(() => {
    if (totalMatches === 0) return;
    const nextIndex = (currentMatchIndex + 1) % totalMatches;
    setCurrentMatchIndex(nextIndex);
  }, [currentMatchIndex, totalMatches]);

  // Navigate to previous search match
  const goToPrevMatch = useCallback(() => {
    if (totalMatches === 0) return;
    const prevIndex = (currentMatchIndex - 1 + totalMatches) % totalMatches;
    setCurrentMatchIndex(prevIndex);
  }, [currentMatchIndex, totalMatches]);

  // Scroll to current match in preview mode - called after marks are rendered
  const scrollToCurrentMatchInPreview = useCallback(() => {
    if (!searchOpen || !searchQuery.trim() || totalMatches === 0) return;
    if (mode !== 'preview' || !previewRef.current) return;

    // Find and scroll to the current match element (marked with data-current)
    const currentMark = previewRef.current.querySelector('mark.search-match[data-current="true"]');
    if (currentMark) {
      currentMark.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [searchOpen, searchQuery, totalMatches, mode]);

  // Scroll to current match in edit mode
  useEffect(() => {
    if (!searchOpen || !searchQuery.trim() || totalMatches === 0) return;
    if (mode !== 'edit' || !textareaRef.current) return;

    // For edit mode, find the match position in the text and scroll
    const escapedQuery = searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escapedQuery, 'gi');
    let matchPosition = -1;

    // Find the nth match position using matchAll
    const matches = Array.from(localContent.matchAll(regex));
    if (currentMatchIndex < matches.length) {
      matchPosition = matches[currentMatchIndex].index!;
    }

    if (matchPosition >= 0 && textareaRef.current) {
      const textarea = textareaRef.current;

      // Create a temporary element to measure text height accurately
      const measureDiv = document.createElement('div');
      measureDiv.style.cssText = window.getComputedStyle(textarea).cssText;
      measureDiv.style.height = 'auto';
      measureDiv.style.position = 'absolute';
      measureDiv.style.visibility = 'hidden';
      measureDiv.style.whiteSpace = 'pre-wrap';
      measureDiv.style.wordWrap = 'break-word';
      measureDiv.style.width = `${textarea.clientWidth}px`;

      // Set content up to the match position
      const textBeforeMatch = localContent.substring(0, matchPosition);
      measureDiv.textContent = textBeforeMatch;
      document.body.appendChild(measureDiv);

      const scrollTarget = Math.max(0, measureDiv.scrollHeight - textarea.clientHeight / 2);
      document.body.removeChild(measureDiv);

      textarea.scrollTop = scrollTarget;

      // Select the match text to highlight it
      textarea.focus();
      textarea.setSelectionRange(matchPosition, matchPosition + searchQuery.length);
    }
  }, [currentMatchIndex, searchOpen, searchQuery, totalMatches, mode, localContent]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Let template autocomplete handle keys first
    if (handleAutocompleteKeyDown(e)) {
      return;
    }

    // Insert actual tab character instead of moving focus
    if (e.key === 'Tab') {
      e.preventDefault();
      const textarea = e.currentTarget;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;

      // Push undo state before modifying content
      pushUndoState();

      const newContent = localContent.substring(0, start) + '\t' + localContent.substring(end);
      setLocalContent(newContent);
      lastUndoSnapshotRef.current = newContent;

      // Restore cursor position after the tab
      requestAnimationFrame(() => {
        textarea.selectionStart = start + 1;
        textarea.selectionEnd = start + 1;
      });
      return;
    }

    // Cmd+Z to undo, Cmd+Shift+Z to redo
    if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) {
        handleRedo();
      } else {
        handleUndo();
      }
      return;
    }

    // Cmd+S to save
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      e.stopPropagation();
      if (isDirty) {
        handleSave();
      }
      return;
    }

    // Command-E to toggle between edit and preview (without Shift)
    // Cmd+Shift+E is allowed to propagate to global handler for "Toggle Auto Run Expanded"
    if ((e.metaKey || e.ctrlKey) && e.key === 'e' && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      toggleMode();
      return;
    }

    // Command-F to open search in edit mode (without Shift)
    // Cmd+Shift+F is allowed to propagate to the global handler for "Go to Files"
    if ((e.metaKey || e.ctrlKey) && e.key === 'f' && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      openSearch();
      return;
    }

    // Command-L to insert a markdown checkbox
    if ((e.metaKey || e.ctrlKey) && e.key === 'l') {
      e.preventDefault();
      e.stopPropagation();
      const textarea = e.currentTarget;
      const cursorPos = textarea.selectionStart;
      const textBeforeCursor = localContent.substring(0, cursorPos);
      const textAfterCursor = localContent.substring(cursorPos);

      // Push undo state before modifying content
      pushUndoState();

      // Check if we're at the start of a line or have text before
      const lastNewline = textBeforeCursor.lastIndexOf('\n');
      const lineStart = lastNewline === -1 ? 0 : lastNewline + 1;
      const textOnCurrentLine = textBeforeCursor.substring(lineStart);

      let newContent: string;
      let newCursorPos: number;

      if (textOnCurrentLine.length === 0) {
        // At start of line, just insert checkbox
        newContent = textBeforeCursor + '- [ ] ' + textAfterCursor;
        newCursorPos = cursorPos + 6; // "- [ ] " is 6 chars
      } else {
        // In middle of line, insert newline then checkbox
        newContent = textBeforeCursor + '\n- [ ] ' + textAfterCursor;
        newCursorPos = cursorPos + 7; // "\n- [ ] " is 7 chars
      }

      setLocalContent(newContent);
      // Update lastUndoSnapshot since we pushed state explicitly
      lastUndoSnapshotRef.current = newContent;
      setTimeout(() => {
        if (textareaRef.current) {
          textareaRef.current.setSelectionRange(newCursorPos, newCursorPos);
        }
      }, 0);
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      const textarea = e.currentTarget;
      const cursorPos = textarea.selectionStart;
      const textBeforeCursor = localContent.substring(0, cursorPos);
      const textAfterCursor = localContent.substring(cursorPos);
      const currentLineStart = textBeforeCursor.lastIndexOf('\n') + 1;
      const currentLine = textBeforeCursor.substring(currentLineStart);

      // Check for list patterns
      const unorderedListMatch = currentLine.match(/^(\s*)([-*])\s+/);
      const orderedListMatch = currentLine.match(/^(\s*)(\d+)\.\s+/);
      const taskListMatch = currentLine.match(/^(\s*)- \[([ x])\]\s+/);

      if (taskListMatch) {
        // Task list: continue with unchecked checkbox
        const indent = taskListMatch[1];
        e.preventDefault();
        // Push undo state before modifying content
        pushUndoState();
        const newContent = textBeforeCursor + '\n' + indent + '- [ ] ' + textAfterCursor;
        setLocalContent(newContent);
        lastUndoSnapshotRef.current = newContent;
        setTimeout(() => {
          if (textareaRef.current) {
            const newPos = cursorPos + indent.length + 7; // "\n" + indent + "- [ ] "
            textareaRef.current.setSelectionRange(newPos, newPos);
          }
        }, 0);
      } else if (unorderedListMatch) {
        // Unordered list: continue with same marker
        const indent = unorderedListMatch[1];
        const marker = unorderedListMatch[2];
        e.preventDefault();
        // Push undo state before modifying content
        pushUndoState();
        const newContent = textBeforeCursor + '\n' + indent + marker + ' ' + textAfterCursor;
        setLocalContent(newContent);
        lastUndoSnapshotRef.current = newContent;
        setTimeout(() => {
          if (textareaRef.current) {
            const newPos = cursorPos + indent.length + 3; // "\n" + indent + marker + " "
            textareaRef.current.setSelectionRange(newPos, newPos);
          }
        }, 0);
      } else if (orderedListMatch) {
        // Ordered list: increment number
        const indent = orderedListMatch[1];
        const num = parseInt(orderedListMatch[2]);
        e.preventDefault();
        // Push undo state before modifying content
        pushUndoState();
        const newContent = textBeforeCursor + '\n' + indent + (num + 1) + '. ' + textAfterCursor;
        setLocalContent(newContent);
        lastUndoSnapshotRef.current = newContent;
        setTimeout(() => {
          if (textareaRef.current) {
            const newPos = cursorPos + indent.length + (num + 1).toString().length + 3; // "\n" + indent + num + ". "
            textareaRef.current.setSelectionRange(newPos, newPos);
          }
        }, 0);
      }
    }
  };

  // Memoize prose CSS styles - only regenerate when theme changes
  // Uses shared utility from markdownConfig.ts
  const proseStyles = useMemo(() => generateAutoRunProseStyles(theme), [theme]);

  // Parse task counts from markdown content
  const taskCounts = useMemo(() => {
    const completedRegex = /^[\s]*[-*]\s*\[x\]/gim;
    const uncheckedRegex = /^[\s]*[-*]\s*\[\s\]/gim;
    const completedMatches = localContent.match(completedRegex) || [];
    const uncheckedMatches = localContent.match(uncheckedRegex) || [];
    const completed = completedMatches.length;
    const total = completed + uncheckedMatches.length;
    return { completed, total };
  }, [localContent]);

  // Memoize ReactMarkdown components - only regenerate when dependencies change
  // Uses shared utility from markdownConfig.ts with custom image renderer
  const markdownComponents = useMemo(() => {
    // Create base components with mermaid support
    const baseComponents = createMarkdownComponents({
      theme,
      customLanguageRenderers: {
        mermaid: ({ code, theme: t }) => <MermaidRenderer chart={code} theme={t} />,
      },
    });

    // Add custom image renderer for AttachmentImage
    return {
      ...baseComponents,
      img: ({ src, alt, ...props }: any) => (
        <AttachmentImage
          src={src}
          alt={alt}
          folderPath={folderPath}
          theme={theme}
          onImageClick={openLightboxByFilename}
          {...props}
        />
      ),
    };
  }, [theme, folderPath, openLightboxByFilename]);

  return (
    <div
      ref={containerRef}
      className="h-full flex flex-col outline-none relative"
      tabIndex={-1}
      onKeyDown={(e) => {
        // CMD+E to toggle edit/preview (without Shift)
        // Cmd+Shift+E is allowed to propagate to global handler for "Toggle Auto Run Expanded"
        if ((e.metaKey || e.ctrlKey) && e.key === 'e' && !e.shiftKey) {
          e.preventDefault();
          e.stopPropagation();
          toggleMode();
        }
        // CMD+F to open search (works in both modes from container)
        // Only intercept Cmd+F (without Shift) - let Cmd+Shift+F propagate to global "Go to Files" handler
        if ((e.metaKey || e.ctrlKey) && e.key === 'f' && !e.shiftKey) {
          e.preventDefault();
          e.stopPropagation();
          openSearch();
        }
      }}
    >
      {/* No folder selected - show centered button only */}
      {!folderPath && (
        <div className="flex-1 flex items-center justify-center">
          <button
            onClick={onOpenSetup}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors hover:opacity-90"
            style={{
              backgroundColor: theme.colors.accent,
              color: theme.colors.accentForeground,
            }}
          >
            <FolderOpen className="w-3.5 h-3.5" />
            Select Auto Run Folder
          </button>
        </div>
      )}

      {/* All controls and content - only shown when folder is selected */}
      {folderPath && !hideTopControls && (
      <div className="flex gap-2 mb-3 justify-center pt-2">
        {/* Expand button */}
        {onExpand && (
          <button
            onClick={onExpand}
            className="flex items-center justify-center w-8 h-8 rounded transition-colors hover:bg-white/10"
            style={{
              color: theme.colors.textDim,
              border: `1px solid ${theme.colors.border}`
            }}
            title={`Expand to full screen${shortcuts?.toggleAutoRunExpanded ? ` (${formatShortcutKeys(shortcuts.toggleAutoRunExpanded.keys)})` : ''}`}
          >
            <Maximize2 className="w-3.5 h-3.5" />
          </button>
        )}
        {/* Image upload button - always visible, ghosted in preview mode */}
        <button
          onClick={() => mode === 'edit' && !isLocked && fileInputRef.current?.click()}
          disabled={mode !== 'edit' || isLocked}
          className={`flex items-center justify-center w-8 h-8 rounded text-xs transition-colors ${
            mode === 'edit' && !isLocked ? 'hover:opacity-80' : 'opacity-30 cursor-not-allowed'
          }`}
          style={{
            backgroundColor: 'transparent',
            color: theme.colors.textDim,
            border: `1px solid ${theme.colors.border}`
          }}
          title={mode === 'edit' && !isLocked ? 'Add image (or paste from clipboard)' : 'Switch to Edit mode to add images'}
        >
          <Image className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => !isLocked && switchMode('edit')}
          disabled={isLocked}
          className={`flex items-center gap-2 px-3 py-1.5 rounded text-xs transition-colors ${
            mode === 'edit' && !isLocked ? 'font-semibold' : ''
          } ${isLocked ? 'opacity-50 cursor-not-allowed' : ''}`}
          style={{
            backgroundColor: mode === 'edit' && !isLocked ? theme.colors.bgActivity : 'transparent',
            color: isLocked ? theme.colors.textDim : (mode === 'edit' ? theme.colors.textMain : theme.colors.textDim),
            border: `1px solid ${mode === 'edit' && !isLocked ? theme.colors.accent : theme.colors.border}`
          }}
          title={isLocked ? 'Editing disabled while Auto Run active' : 'Edit document'}
        >
          <Edit className="w-3.5 h-3.5" />
          Edit
        </button>
        <button
          onClick={() => switchMode('preview')}
          className={`flex items-center gap-2 px-3 py-1.5 rounded text-xs transition-colors ${
            mode === 'preview' || isLocked ? 'font-semibold' : ''
          }`}
          style={{
            backgroundColor: mode === 'preview' || isLocked ? theme.colors.bgActivity : 'transparent',
            color: mode === 'preview' || isLocked ? theme.colors.textMain : theme.colors.textDim,
            border: `1px solid ${mode === 'preview' || isLocked ? theme.colors.accent : theme.colors.border}`
          }}
          title="Preview document"
        >
          <Eye className="w-3.5 h-3.5" />
          Preview
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={handleFileSelect}
          className="hidden"
        />
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
        {/* Help button */}
        <button
          onClick={() => setHelpModalOpen(true)}
          className="flex items-center justify-center w-8 h-8 rounded transition-colors hover:bg-white/10"
          style={{
            color: theme.colors.textDim,
            border: `1px solid ${theme.colors.border}`
          }}
          title="Learn about Auto Runner"
        >
          <HelpCircle className="w-3.5 h-3.5" />
        </button>
      </div>
      )}

      {/* Document Selector */}
      {folderPath && (
        <div className="px-2 mb-2" data-tour="autorun-document-selector">
          <AutoRunDocumentSelector
            theme={theme}
            documents={documentList}
            documentTree={documentTree as import('./AutoRunDocumentSelector').DocTreeNode[] | undefined}
            selectedDocument={selectedFile}
            onSelectDocument={onSelectDocument}
            onRefresh={onRefresh}
            onChangeFolder={onOpenSetup}
            onCreateDocument={onCreateDocument}
            isLoading={isLoadingDocuments}
            documentTaskCounts={documentTaskCounts}
          />
        </div>
      )}

      {/* Attached Images Preview (edit mode) - only when folder selected */}
      {folderPath && mode === 'edit' && attachmentsList.length > 0 && (
        <div
          className="px-2 py-2 mx-2 mb-2 rounded"
          style={{ backgroundColor: theme.colors.bgActivity }}
        >
          <button
            onClick={() => setAttachmentsExpanded(!attachmentsExpanded)}
            className="w-full flex items-center gap-1 text-[10px] uppercase font-semibold hover:opacity-80 transition-opacity"
            style={{ color: theme.colors.textDim }}
          >
            {attachmentsExpanded ? (
              <ChevronDown className="w-3 h-3" />
            ) : (
              <ChevronRight className="w-3 h-3" />
            )}
            Attached Images ({attachmentsList.length})
          </button>
          {attachmentsExpanded && (
            <div className="flex flex-wrap gap-1 mt-2">
              {attachmentsList.map(filename => (
                <ImagePreview
                  key={filename}
                  src={attachmentPreviews.get(filename) || ''}
                  filename={filename}
                  theme={theme}
                  onRemove={() => handleRemoveAttachment(filename)}
                  onImageClick={openLightboxByFilename}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Search Bar */}
      {searchOpen && (
        <AutoRunSearchBar
          theme={theme}
          searchQuery={searchQuery}
          onSearchQueryChange={setSearchQuery}
          currentMatchIndex={currentMatchIndex}
          totalMatches={totalMatches}
          onNextMatch={goToNextMatch}
          onPrevMatch={goToPrevMatch}
          onClose={closeSearch}
        />
      )}

      {/* Content Area - only shown when folder is selected */}
      {folderPath && (
      <div className="flex-1 min-h-0 overflow-y-auto">
        {/* Empty folder state - show when folder is configured but has no documents */}
        {documentList.length === 0 && !isLoadingDocuments ? (
          <div
            className="h-full flex flex-col items-center justify-center text-center px-6"
            style={{ color: theme.colors.textDim }}
          >
            <div
              className="w-16 h-16 rounded-full flex items-center justify-center mb-4"
              style={{ backgroundColor: theme.colors.bgActivity }}
            >
              <FileText className="w-8 h-8" style={{ color: theme.colors.textDim }} />
            </div>
            <h3
              className="text-lg font-semibold mb-2"
              style={{ color: theme.colors.textMain }}
            >
              No Documents Found
            </h3>
            <p className="mb-4 max-w-xs text-sm">
              The selected folder doesn't contain any markdown (.md) files.
            </p>
            <p className="mb-6 max-w-xs text-xs" style={{ color: theme.colors.textDim }}>
              Create a markdown file in the folder to get started, or select a different folder.
            </p>
            <div className="flex gap-3">
              <button
                onClick={handleEmptyStateRefresh}
                className="flex items-center gap-2 px-4 py-2 rounded text-sm transition-colors hover:opacity-90"
                style={{
                  backgroundColor: 'transparent',
                  color: theme.colors.textMain,
                  border: `1px solid ${theme.colors.border}`,
                }}
              >
                <RefreshCw className={`w-4 h-4 ${isRefreshingEmpty ? 'animate-spin' : ''}`} />
                Refresh
              </button>
              <button
                onClick={onOpenSetup}
                className="flex items-center gap-2 px-4 py-2 rounded text-sm transition-colors hover:opacity-90"
                style={{
                  backgroundColor: theme.colors.accent,
                  color: theme.colors.accentForeground,
                }}
              >
                <FolderOpen className="w-4 h-4" />
                Change Auto-run Folder
              </button>
            </div>
          </div>
        ) : mode === 'edit' ? (
          <div className="relative w-full h-full">
            <textarea
              ref={textareaRef}
              value={localContent}
              onChange={(e) => {
                if (!isLocked) {
                  // Schedule undo snapshot with current content before the change
                  const previousContent = localContent;
                  const previousCursor = textareaRef.current?.selectionStart || 0;
                  // Use autocomplete handler to detect "{{" triggers
                  handleAutocompleteChange(e);
                  scheduleUndoSnapshot(previousContent, previousCursor);
                }
              }}
              onFocus={() => { /* no-op, manual save only */ }}
              onKeyDown={!isLocked ? handleKeyDown : undefined}
              onPaste={handlePaste}
              placeholder="Capture notes, images, and tasks in Markdown. (type {{ for variables)"
              readOnly={isLocked}
              className={`w-full h-full border rounded p-4 bg-transparent outline-none resize-none font-mono text-sm ${isLocked ? 'cursor-not-allowed opacity-70' : ''}`}
              style={{
                borderColor: isLocked ? theme.colors.warning : theme.colors.border,
                color: theme.colors.textMain,
                backgroundColor: isLocked ? theme.colors.bgActivity + '30' : 'transparent'
              }}
            />
            {/* Template Variable Autocomplete Dropdown */}
            <TemplateAutocompleteDropdown
              ref={autocompleteRef}
              theme={theme}
              state={autocompleteState}
              onSelect={selectVariable}
            />
          </div>
        ) : (
          <div
            ref={previewRef}
            className="border rounded p-4 prose prose-sm max-w-none outline-none"
            tabIndex={0}
            onKeyDown={(e) => {
              // CMD+E to toggle edit/preview (without Shift)
              // Cmd+Shift+E is allowed to propagate to global handler for "Toggle Auto Run Expanded"
              if ((e.metaKey || e.ctrlKey) && e.key === 'e' && !e.shiftKey) {
                e.preventDefault();
                e.stopPropagation();
                toggleMode();
              }
              // Cmd+F to open search in preview mode (without Shift)
              // Cmd+Shift+F is allowed to propagate to global handler for "Go to Files"
              if (e.key === 'f' && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
                e.preventDefault();
                e.stopPropagation();
                openSearch();
              }
            }}
            onScroll={handlePreviewScroll}
            style={{
              borderColor: theme.colors.border,
              color: theme.colors.textMain,
              fontSize: '13px'
            }}
          >
            <style>{proseStyles}</style>
            {searchOpen && searchQuery.trim() && totalMatches > 0 ? (
              // When searching with matches, show raw text with highlights for easy search navigation
              <SearchHighlightedContent
                content={localContent || '*No content yet.*'}
                searchQuery={searchQuery}
                currentMatchIndex={currentMatchIndex}
                theme={theme}
                onMatchesRendered={scrollToCurrentMatchInPreview}
              />
            ) : (
              <ReactMarkdown
                remarkPlugins={REMARK_PLUGINS}
                components={markdownComponents}
              >
                {localContent || '*No content yet. Switch to Edit mode to start writing.*'}
              </ReactMarkdown>
            )}
          </div>
        )}
      </div>
      )}

      {/* Bottom Panel - shown when folder selected AND (there are tasks OR unsaved changes) */}
      {folderPath && (taskCounts.total > 0 || (isDirty && mode === 'edit' && !isLocked)) && (
        <div
          className="flex-shrink-0 px-3 py-1.5 text-xs border-t flex items-center justify-between"
          style={{
            backgroundColor: theme.colors.bgActivity,
            borderColor: theme.colors.border,
          }}
        >
          {/* Revert button - left side */}
          {isDirty && mode === 'edit' && !isLocked ? (
            <button
              onClick={handleRevert}
              className="px-2 py-0.5 rounded text-xs transition-colors hover:opacity-80"
              style={{
                backgroundColor: 'transparent',
                color: theme.colors.textDim,
                border: `1px solid ${theme.colors.border}`
              }}
              title="Discard changes"
            >
              Revert
            </button>
          ) : (
            <div />
          )}

          {/* Task count - center */}
          {taskCounts.total > 0 ? (
            <span style={{ color: taskCounts.completed === taskCounts.total ? theme.colors.success : theme.colors.textDim }}>
              {taskCounts.completed} of {taskCounts.total} task{taskCounts.total !== 1 ? 's' : ''} completed
            </span>
          ) : (
            <span style={{ color: theme.colors.textDim }}>Unsaved changes</span>
          )}

          {/* Save button - right side */}
          {isDirty && mode === 'edit' && !isLocked ? (
            <button
              onClick={handleSave}
              className="group relative px-2 py-0.5 rounded text-xs transition-colors hover:opacity-80"
              style={{
                backgroundColor: theme.colors.accent,
                color: theme.colors.accentForeground,
                border: `1px solid ${theme.colors.accent}`
              }}
              title="Save changes"
            >
              Save
              {/* Keyboard shortcut overlay on hover */}
              <span
                className="absolute -top-7 left-1/2 -translate-x-1/2 px-1.5 py-0.5 rounded text-[10px] whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"
                style={{
                  backgroundColor: theme.colors.bgMain,
                  color: theme.colors.textDim,
                  border: `1px solid ${theme.colors.border}`,
                }}
              >
                ⌘S
              </span>
            </button>
          ) : (
            <div />
          )}
        </div>
      )}

      {/* Help Modal */}
      {helpModalOpen && (
        <AutoRunnerHelpModal
          theme={theme}
          onClose={() => setHelpModalOpen(false)}
        />
      )}

      {/* Lightbox for viewing images with navigation, copy, and delete */}
      <AutoRunLightbox
        theme={theme}
        attachmentsList={attachmentsList}
        attachmentPreviews={attachmentPreviews}
        lightboxFilename={lightboxFilename}
        lightboxExternalUrl={lightboxExternalUrl}
        onClose={closeLightbox}
        onNavigate={handleLightboxNavigate}
        onDelete={handleLightboxDelete}
      />
    </div>
  );
});

// Memoized AutoRun component with custom comparison to prevent unnecessary re-renders
export const AutoRun = memo(AutoRunInner, (prevProps, nextProps) => {
  // Only re-render when these specific props actually change
  return (
    prevProps.content === nextProps.content &&
    prevProps.sessionId === nextProps.sessionId &&
    prevProps.mode === nextProps.mode &&
    prevProps.theme === nextProps.theme &&
    // Document state
    prevProps.folderPath === nextProps.folderPath &&
    prevProps.selectedFile === nextProps.selectedFile &&
    prevProps.documentList === nextProps.documentList &&
    prevProps.isLoadingDocuments === nextProps.isLoadingDocuments &&
    // Compare batch run state values, not object reference
    prevProps.batchRunState?.isRunning === nextProps.batchRunState?.isRunning &&
    prevProps.batchRunState?.isStopping === nextProps.batchRunState?.isStopping &&
    prevProps.batchRunState?.currentTaskIndex === nextProps.batchRunState?.currentTaskIndex &&
    prevProps.batchRunState?.totalTasks === nextProps.batchRunState?.totalTasks &&
    // Session state affects UI (busy disables Run button)
    prevProps.sessionState === nextProps.sessionState &&
    // Callbacks are typically stable, but check identity
    prevProps.onContentChange === nextProps.onContentChange &&
    prevProps.onModeChange === nextProps.onModeChange &&
    prevProps.onStateChange === nextProps.onStateChange &&
    prevProps.onOpenBatchRunner === nextProps.onOpenBatchRunner &&
    prevProps.onStopBatchRun === nextProps.onStopBatchRun &&
    prevProps.onOpenSetup === nextProps.onOpenSetup &&
    prevProps.onRefresh === nextProps.onRefresh &&
    prevProps.onSelectDocument === nextProps.onSelectDocument &&
    // UI control props
    prevProps.hideTopControls === nextProps.hideTopControls &&
    // External change detection
    prevProps.contentVersion === nextProps.contentVersion
    // Note: initialCursorPosition, initialEditScrollPos, initialPreviewScrollPos
    // are intentionally NOT compared - they're only used on mount
    // Note: documentTree is derived from documentList, comparing documentList is sufficient
  );
});
