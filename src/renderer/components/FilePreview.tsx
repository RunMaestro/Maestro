import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { FileCode, X, Copy, FileText, Eye, ChevronUp, ChevronDown, ChevronLeft, ChevronRight, Clipboard, Loader2, Image, Globe, Save, Edit, FolderOpen, AlertTriangle } from 'lucide-react';
import { visit } from 'unist-util-visit';
import { useLayerStack } from '../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { Modal, ModalFooter } from './ui/Modal';
import { MermaidRenderer } from './MermaidRenderer';
import { getEncoding } from 'js-tiktoken';
import { formatShortcutKeys } from '../utils/shortcutFormatter';
import { remarkFileLinks } from '../utils/remarkFileLinks';
import remarkFrontmatter from 'remark-frontmatter';
import { remarkFrontmatterTable } from '../utils/remarkFrontmatterTable';
import type { FileNode } from '../types/fileTree';
import { isImageFile } from '../../shared/gitUtils';

interface FileStats {
  size: number;
  createdAt: string;
  modifiedAt: string;
}

interface FilePreviewProps {
  file: { name: string; content: string; path: string } | null;
  onClose: () => void;
  theme: any;
  markdownEditMode: boolean;
  setMarkdownEditMode: (value: boolean) => void;
  onSave?: (path: string, content: string) => Promise<void>;
  shortcuts: Record<string, any>;
  /** File tree for linking file references */
  fileTree?: FileNode[];
  /** Current working directory for proximity-based matching */
  cwd?: string;
  /** Callback when a file link is clicked */
  onFileClick?: (path: string) => void;
  /** Whether back navigation is available */
  canGoBack?: boolean;
  /** Whether forward navigation is available */
  canGoForward?: boolean;
  /** Navigate back in history */
  onNavigateBack?: () => void;
  /** Navigate forward in history */
  onNavigateForward?: () => void;
  /** Navigation history for back breadcrumbs (items before current) */
  backHistory?: {name: string; content: string; path: string}[];
  /** Navigation history for forward breadcrumbs (items after current) */
  forwardHistory?: {name: string; content: string; path: string}[];
  /** Navigate to a specific index in history */
  onNavigateToIndex?: (index: number) => void;
  /** Current index in history */
  currentHistoryIndex?: number;
  /** Callback to open fuzzy file search (available in preview mode, not edit mode) */
  onOpenFuzzySearch?: () => void;
}

// Get language from filename extension
const getLanguageFromFilename = (filename: string): string => {
  const ext = filename.split('.').pop()?.toLowerCase();
  const languageMap: Record<string, string> = {
    'ts': 'typescript',
    'tsx': 'tsx',
    'js': 'javascript',
    'jsx': 'jsx',
    'json': 'json',
    'md': 'markdown',
    'py': 'python',
    'rb': 'ruby',
    'go': 'go',
    'rs': 'rust',
    'java': 'java',
    'c': 'c',
    'cpp': 'cpp',
    'cs': 'csharp',
    'php': 'php',
    'html': 'html',
    'css': 'css',
    'scss': 'scss',
    'sql': 'sql',
    'sh': 'bash',
    'yaml': 'yaml',
    'yml': 'yaml',
    'toml': 'toml',
    'xml': 'xml',
  };
  return languageMap[ext || ''] || 'text';
};

// Check if content appears to be binary (contains null bytes or high concentration of non-printable chars)
const isBinaryContent = (content: string): boolean => {
  // Check for null bytes (definitive binary indicator)
  if (content.includes('\0')) return true;

  // Sample the first 8KB for performance (binary files are usually obvious early)
  const sample = content.slice(0, 8192);
  if (sample.length === 0) return false;

  // Count non-printable characters (excluding common whitespace)
  let nonPrintableCount = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    // Allow: tab (9), newline (10), carriage return (13), and printable ASCII (32-126)
    // Also allow common extended ASCII and Unicode
    if (code < 9 || (code > 13 && code < 32) || (code >= 127 && code < 160)) {
      nonPrintableCount++;
    }
  }

  // If more than 10% of characters are non-printable, treat as binary
  return nonPrintableCount / sample.length > 0.1;
};

// Check if file extension indicates a known binary format
const isBinaryExtension = (filename: string): boolean => {
  const ext = filename.split('.').pop()?.toLowerCase();
  const binaryExtensions = [
    // macOS/iOS specific
    'icns', 'car', 'actool',
    // Design files
    'psd', 'ai', 'sketch', 'fig', 'xd',
    // Compiled/object files
    'o', 'a', 'so', 'dylib', 'dll', 'class', 'pyc', 'pyo', 'wasm',
    // Database files
    'db', 'sqlite', 'sqlite3',
    // Fonts
    'ttf', 'otf', 'woff', 'woff2', 'eot',
    // Archives (if somehow not opened externally)
    'zip', 'tar', 'gz', '7z', 'rar', 'bz2', 'xz', 'tgz',
    // Other binary
    'exe', 'bin', 'dat', 'pak'
  ];
  return binaryExtensions.includes(ext || '');
};

// Format file size in human-readable format
const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
};

// Format date/time for display
const formatDateTime = (isoString: string): string => {
  const date = new Date(isoString);
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
};

// Format token count with K/M suffix
const formatTokenCount = (count: number): string => {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`;
  }
  if (count >= 1_000) {
    return `${(count / 1_000).toFixed(1)}K`;
  }
  return count.toLocaleString();
};

// Count markdown tasks (checkboxes)
const countMarkdownTasks = (content: string): { open: number; closed: number } => {
  // Match markdown checkboxes: - [ ] or - [x] (also * [ ] and * [x])
  const openMatches = content.match(/^[\s]*[-*]\s*\[\s*\]/gm);
  const closedMatches = content.match(/^[\s]*[-*]\s*\[[xX]\]/gm);
  return {
    open: openMatches?.length || 0,
    closed: closedMatches?.length || 0
  };
};

// Lazy-loaded tokenizer encoder (cl100k_base is used by Claude/GPT-4)
let encoderPromise: Promise<ReturnType<typeof getEncoding>> | null = null;
const getEncoder = () => {
  if (!encoderPromise) {
    encoderPromise = Promise.resolve(getEncoding('cl100k_base'));
  }
  return encoderPromise;
};

// Helper to resolve image path relative to markdown file directory
const resolveImagePath = (src: string, markdownFilePath: string): string => {
  // If it's already a data URL or http(s) URL, return as-is
  if (src.startsWith('data:') || src.startsWith('http://') || src.startsWith('https://')) {
    return src;
  }

  // Get the directory containing the markdown file
  const markdownDir = markdownFilePath.substring(0, markdownFilePath.lastIndexOf('/'));

  // If the path is absolute, return as-is
  if (src.startsWith('/')) {
    return src;
  }

  // Resolve relative path
  // Handle ./ prefix
  let relativePath = src;
  if (relativePath.startsWith('./')) {
    relativePath = relativePath.substring(2);
  }

  // Simple path resolution (handles ../ by just concatenating - the file system will resolve it)
  return `${markdownDir}/${relativePath}`;
};

// Custom image component for markdown that loads images from file paths
function MarkdownImage({
  src,
  alt,
  markdownFilePath,
  theme,
  showRemoteImages = false,
  isFromFileTree = false,
  projectRoot
}: {
  src?: string;
  alt?: string;
  markdownFilePath: string;
  theme: any;
  showRemoteImages?: boolean;
  isFromFileTree?: boolean; // If true, src is a path relative to project root, not markdown file
  projectRoot?: string; // Project root path for resolving file tree paths
}) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const isRemoteUrl = src?.startsWith('http://') || src?.startsWith('https://');

  useEffect(() => {
    // Reset state when src or showRemoteImages changes
    setError(null);

    if (!src) {
      setDataUrl(null);
      setLoading(false);
      return;
    }

    // If it's already a data URL, use it directly
    if (src.startsWith('data:')) {
      setDataUrl(src);
      setLoading(false);
      return;
    }

    // If it's an HTTP(S) URL, handle based on showRemoteImages setting
    if (src.startsWith('http://') || src.startsWith('https://')) {
      if (showRemoteImages) {
        setDataUrl(src);
      } else {
        // Explicitly clear the dataUrl when hiding remote images
        setDataUrl(null);
      }
      setLoading(false);
      return;
    }

    // For local files, we need to load them
    setLoading(true);

    // Decode URL-encoded characters (e.g., %20 -> space) since file:// URLs encode spaces
    // but the filesystem needs actual spaces
    let decodedSrc = src;
    try {
      decodedSrc = decodeURIComponent(src);
    } catch {
      // If decoding fails, use original src
    }

    // Resolve the path:
    // - If isFromFileTree is true, the src is already a path relative to projectRoot (complete path from file tree)
    // - Otherwise, resolve relative to the markdown file location
    let resolvedPath: string;
    if (isFromFileTree && projectRoot) {
      // Path was found in file tree - combine with projectRoot directly
      resolvedPath = `${projectRoot}/${decodedSrc}`;
    } else {
      // Path is relative to markdown file - use normal resolution
      resolvedPath = resolveImagePath(decodedSrc, markdownFilePath);
    }

    // Load the image via IPC
    window.maestro.fs.readFile(resolvedPath)
      .then((result) => {
        // readFile returns a data URL for images
        if (result.startsWith('data:')) {
          setDataUrl(result);
        } else {
          // If it's not a data URL, something went wrong
          setError('Invalid image data');
        }
        setLoading(false);
      })
      .catch((err) => {
        setError(`Failed to load image: ${err.message || 'Unknown error'}`);
        setLoading(false);
      });
  }, [src, markdownFilePath, showRemoteImages, isFromFileTree, projectRoot]);

  if (loading) {
    return (
      <span
        className="inline-flex items-center gap-2 px-3 py-2 rounded"
        style={{ backgroundColor: theme.colors.bgActivity }}
      >
        <Loader2 className="w-4 h-4 animate-spin" style={{ color: theme.colors.textDim }} />
        <span className="text-xs" style={{ color: theme.colors.textDim }}>Loading image...</span>
      </span>
    );
  }

  if (error) {
    return (
      <span
        className="inline-flex items-center gap-2 px-3 py-2 rounded"
        style={{ backgroundColor: theme.colors.bgActivity, border: `1px solid ${theme.colors.error}` }}
      >
        <Image className="w-4 h-4" style={{ color: theme.colors.error }} />
        <span className="text-xs" style={{ color: theme.colors.error }}>{error}</span>
      </span>
    );
  }

  // Show placeholder for blocked remote images
  if (!dataUrl && isRemoteUrl && !showRemoteImages) {
    return (
      <span
        className="inline-flex items-center gap-2 px-3 py-2 rounded"
        style={{ backgroundColor: theme.colors.bgActivity, border: `1px dashed ${theme.colors.border}` }}
      >
        <Image className="w-4 h-4" style={{ color: theme.colors.textDim }} />
        <span className="text-xs" style={{ color: theme.colors.textDim }}>Remote image blocked</span>
      </span>
    );
  }

  if (!dataUrl) {
    return null;
  }

  return (
    <img
      src={dataUrl}
      alt={alt || ''}
      className="max-w-full rounded my-2 block"
      style={{ border: `1px solid ${theme.colors.border}` }}
    />
  );
}

// Remark plugin to support ==highlighted text== syntax
function remarkHighlight() {
  return (tree: any) => {
    visit(tree, 'text', (node: any, index: number | null | undefined, parent: any) => {
      const text = node.value;
      const regex = /==([^=]+)==/g;

      if (!regex.test(text)) return;
      if (index === null || index === undefined || !parent) return;

      const parts: any[] = [];
      let lastIndex = 0;
      const matches = text.matchAll(/==([^=]+)==/g);

      for (const match of matches) {
        const matchIndex = match.index!;

        // Add text before match
        if (matchIndex > lastIndex) {
          parts.push({
            type: 'text',
            value: text.slice(lastIndex, matchIndex)
          });
        }

        // Add highlighted text
        parts.push({
          type: 'html',
          value: `<mark style="background-color: #ffd700; color: #000; padding: 0 4px; border-radius: 2px;">${match[1]}</mark>`
        });

        lastIndex = matchIndex + match[0].length;
      }

      // Add remaining text
      if (lastIndex < text.length) {
        parts.push({
          type: 'text',
          value: text.slice(lastIndex)
        });
      }

      // Replace the text node with the parts
      if (parts.length > 0) {
        parent.children.splice(index, 1, ...parts);
      }
    });
  };
}

export function FilePreview({ file, onClose, theme, markdownEditMode, setMarkdownEditMode, onSave, shortcuts, fileTree, cwd, onFileClick, canGoBack, canGoForward, onNavigateBack, onNavigateForward, backHistory, forwardHistory, onNavigateToIndex, currentHistoryIndex, onOpenFuzzySearch }: FilePreviewProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [showCopyNotification, setShowCopyNotification] = useState(false);
  const [showBackPopup, setShowBackPopup] = useState(false);
  const [showForwardPopup, setShowForwardPopup] = useState(false);
  const backPopupTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const forwardPopupTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const [totalMatches, setTotalMatches] = useState(0);
  const [fileStats, setFileStats] = useState<FileStats | null>(null);
  const [showStatsBar, setShowStatsBar] = useState(true);
  const [tokenCount, setTokenCount] = useState<number | null>(null);
  const [showRemoteImages, setShowRemoteImages] = useState(false);
  // Edit mode state
  const [editContent, setEditContent] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [showUnsavedChangesModal, setShowUnsavedChangesModal] = useState(false);
  const [copyNotificationMessage, setCopyNotificationMessage] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const codeContainerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const markdownContainerRef = useRef<HTMLDivElement>(null);
  const layerIdRef = useRef<string>();
  const matchElementsRef = useRef<HTMLElement[]>([]);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);

  // Track if content has been modified
  const hasChanges = markdownEditMode && editContent !== file?.content;

  const { registerLayer, unregisterLayer, updateLayerHandler } = useLayerStack();

  // Compute derived values - must be before any early returns but after hooks
  const language = file ? getLanguageFromFilename(file.name) : '';
  const isMarkdown = language === 'markdown';
  const isImage = file ? isImageFile(file.name) : false;

  // Check for binary files - either by extension or by content analysis
  // Memoize to avoid recalculating on every render (content analysis can be expensive)
  const isBinary = useMemo(() => {
    if (!file) return false;
    if (isImage) return false;
    return isBinaryExtension(file.name) || isBinaryContent(file.content);
  }, [isImage, file]);

  // Calculate task counts for markdown files
  const taskCounts = useMemo(() => {
    if (!isMarkdown || !file?.content) return null;
    const counts = countMarkdownTasks(file.content);
    // Only return if there are any tasks
    if (counts.open === 0 && counts.closed === 0) return null;
    return counts;
  }, [isMarkdown, file?.content]);

  // Extract directory path without filename
  const directoryPath = file ? file.path.substring(0, file.path.lastIndexOf('/')) : '';

  // Fetch file stats when file changes
  useEffect(() => {
    if (file?.path) {
      window.maestro.fs.stat(file.path)
        .then(stats => setFileStats({
          size: stats.size,
          createdAt: stats.createdAt,
          modifiedAt: stats.modifiedAt
        }))
        .catch(err => {
          console.error('Failed to get file stats:', err);
          setFileStats(null);
        });
    }
  }, [file?.path]);

  // Count tokens when file content changes (skip for images and binary files)
  useEffect(() => {
    if (!file?.content || isImage || isBinary) {
      setTokenCount(null);
      return;
    }

    getEncoder()
      .then(encoder => {
        const tokens = encoder.encode(file.content);
        setTokenCount(tokens.length);
      })
      .catch(err => {
        console.error('Failed to count tokens:', err);
        setTokenCount(null);
      });
  }, [file?.content, isImage, isBinary]);

  // Sync edit content when file changes or when entering edit mode
  useEffect(() => {
    if (file?.content) {
      setEditContent(file.content);
    }
  }, [file?.content, file?.path]);

  // Focus appropriate element and sync scroll position when mode changes
  const prevMarkdownEditModeRef = useRef(markdownEditMode);
  useEffect(() => {
    const wasEditMode = prevMarkdownEditModeRef.current;
    prevMarkdownEditModeRef.current = markdownEditMode;

    if (markdownEditMode && textareaRef.current) {
      // Entering edit mode - focus textarea and sync scroll from preview
      if (!wasEditMode && contentRef.current) {
        // Calculate scroll percentage from preview mode
        const { scrollTop, scrollHeight, clientHeight } = contentRef.current;
        const maxScroll = scrollHeight - clientHeight;
        const scrollPercent = maxScroll > 0 ? scrollTop / maxScroll : 0;

        // Apply scroll percentage to textarea after it renders
        requestAnimationFrame(() => {
          if (textareaRef.current) {
            const { scrollHeight: textareaScrollHeight, clientHeight: textareaClientHeight } = textareaRef.current;
            const textareaMaxScroll = textareaScrollHeight - textareaClientHeight;
            textareaRef.current.scrollTop = Math.round(scrollPercent * textareaMaxScroll);
          }
        });
      }
      textareaRef.current.focus();
    } else if (!markdownEditMode && wasEditMode && containerRef.current) {
      // Exiting edit mode - focus container and sync scroll from textarea
      if (textareaRef.current && contentRef.current) {
        // Calculate scroll percentage from edit mode
        const { scrollTop, scrollHeight, clientHeight } = textareaRef.current;
        const maxScroll = scrollHeight - clientHeight;
        const scrollPercent = maxScroll > 0 ? scrollTop / maxScroll : 0;

        // Apply scroll percentage to preview after it renders
        requestAnimationFrame(() => {
          if (contentRef.current) {
            const { scrollHeight: previewScrollHeight, clientHeight: previewClientHeight } = contentRef.current;
            const previewMaxScroll = previewScrollHeight - previewClientHeight;
            contentRef.current.scrollTop = Math.round(scrollPercent * previewMaxScroll);
          }
        });
      }
      containerRef.current.focus();
    }
  }, [markdownEditMode]);

  // Save handler
  const handleSave = useCallback(async () => {
    if (!file || !onSave || !hasChanges || isSaving) return;

    setIsSaving(true);
    try {
      await onSave(file.path, editContent);
      setCopyNotificationMessage('File Saved');
      setShowCopyNotification(true);
      setTimeout(() => setShowCopyNotification(false), 2000);
    } catch (err) {
      console.error('Failed to save file:', err);
      setCopyNotificationMessage('Save Failed');
      setShowCopyNotification(true);
      setTimeout(() => setShowCopyNotification(false), 2000);
    } finally {
      setIsSaving(false);
    }
  }, [file, onSave, hasChanges, isSaving, editContent]);

  // Track scroll position to show/hide stats bar
  useEffect(() => {
    const contentEl = contentRef.current;
    if (!contentEl) return;

    const handleScroll = () => {
      // Show stats bar when scrolled to top (within 10px), hide otherwise
      setShowStatsBar(contentEl.scrollTop <= 10);
    };

    contentEl.addEventListener('scroll', handleScroll);
    return () => contentEl.removeEventListener('scroll', handleScroll);
  }, []);

  // Auto-focus on mount and when file changes so keyboard shortcuts work immediately
  useEffect(() => {
    containerRef.current?.focus();
  }, [file?.path]); // Run on mount and when navigating to a different file

  // Helper to handle escape key - shows confirmation modal if there are unsaved changes
  const handleEscapeRequest = useCallback(() => {
    if (searchOpen) {
      setSearchOpen(false);
      setSearchQuery('');
      // Refocus container so keyboard navigation (arrow keys) still works
      containerRef.current?.focus();
    } else if (hasChanges) {
      // Show confirmation modal if there are unsaved changes
      setShowUnsavedChangesModal(true);
    } else {
      onClose();
    }
  }, [searchOpen, hasChanges, onClose]);

  // Register layer on mount
  useEffect(() => {
    layerIdRef.current = registerLayer({
      type: 'overlay',
      priority: MODAL_PRIORITIES.FILE_PREVIEW,
      blocksLowerLayers: true,
      capturesFocus: true,
      focusTrap: 'lenient',
      ariaLabel: 'File Preview',
      onEscape: handleEscapeRequest,
      allowClickOutside: false
    });

    return () => {
      if (layerIdRef.current) {
        unregisterLayer(layerIdRef.current);
      }
    };
  }, [registerLayer, unregisterLayer, handleEscapeRequest]);

  // Update handler when dependencies change
  useEffect(() => {
    if (layerIdRef.current) {
      updateLayerHandler(layerIdRef.current, handleEscapeRequest);
    }
  }, [handleEscapeRequest, updateLayerHandler]);

  // Keep search input focused when search is open
  useEffect(() => {
    if (searchOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [searchOpen, searchQuery]);

  // Highlight search matches in syntax-highlighted code
  useEffect(() => {
    if (!searchQuery.trim() || !codeContainerRef.current || isMarkdown || isImage) {
      setTotalMatches(0);
      setCurrentMatchIndex(0);
      matchElementsRef.current = [];
      return;
    }

    const container = codeContainerRef.current;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];

    // Collect all text nodes
    let node;
    while ((node = walker.nextNode())) {
      textNodes.push(node as Text);
    }

    // Escape regex special characters
    const escapedQuery = searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escapedQuery, 'gi');
    const matchElements: HTMLElement[] = [];

    // Highlight matches using safe DOM methods
    textNodes.forEach(textNode => {
      const text = textNode.textContent || '';
      const matches = text.match(regex);

      if (matches) {
        const fragment = document.createDocumentFragment();
        let lastIndex = 0;

        text.replace(regex, (match, offset) => {
          // Add text before match
          if (offset > lastIndex) {
            fragment.appendChild(document.createTextNode(text.substring(lastIndex, offset)));
          }

          // Add highlighted match
          const mark = document.createElement('mark');
          mark.style.backgroundColor = '#ffd700';
          mark.style.color = '#000';
          mark.style.padding = '0 2px';
          mark.style.borderRadius = '2px';
          mark.className = 'search-match';
          mark.textContent = match;
          fragment.appendChild(mark);
          matchElements.push(mark);

          lastIndex = offset + match.length;
          return match;
        });

        // Add remaining text
        if (lastIndex < text.length) {
          fragment.appendChild(document.createTextNode(text.substring(lastIndex)));
        }

        textNode.parentNode?.replaceChild(fragment, textNode);
      }
    });

    // Store match elements and update count
    matchElementsRef.current = matchElements;
    setTotalMatches(matchElements.length);
    setCurrentMatchIndex(matchElements.length > 0 ? 0 : -1);

    // Highlight first match with different color and scroll to it
    if (matchElements.length > 0) {
      matchElements[0].style.backgroundColor = theme.colors.accent;
      matchElements[0].style.color = '#fff';
      matchElements[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    // Cleanup function to remove highlights
    return () => {
      container.querySelectorAll('mark.search-match').forEach(mark => {
        const parent = mark.parentNode;
        if (parent) {
          parent.replaceChild(document.createTextNode(mark.textContent || ''), mark);
          parent.normalize();
        }
      });
      matchElementsRef.current = [];
    };
  }, [searchQuery, file?.content, isMarkdown, isImage, theme.colors.accent]);

  // Search matches in markdown preview mode - use CSS Custom Highlight API
  useEffect(() => {
    if (!isMarkdown || markdownEditMode || !searchQuery.trim() || !markdownContainerRef.current) {
      if (isMarkdown && !markdownEditMode) {
        setTotalMatches(0);
        setCurrentMatchIndex(0);
        matchElementsRef.current = [];
        // Clear any existing highlights
        if ('highlights' in CSS) {
          (CSS as any).highlights.delete('search-results');
          (CSS as any).highlights.delete('search-current');
        }
      }
      return;
    }

    const container = markdownContainerRef.current;
    const escapedQuery = searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const searchRegex = new RegExp(escapedQuery, 'gi');

    // Check if CSS Custom Highlight API is available
    if ('highlights' in CSS) {
      const allRanges: Range[] = [];
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);

      // Find all text nodes and create ranges for matches
      let textNode;
      while ((textNode = walker.nextNode())) {
        const text = textNode.textContent || '';
        let match;
        const localRegex = new RegExp(escapedQuery, 'gi');
        while ((match = localRegex.exec(text)) !== null) {
          const range = document.createRange();
          range.setStart(textNode, match.index);
          range.setEnd(textNode, match.index + match[0].length);
          allRanges.push(range);
        }
      }

      // Update match count
      setTotalMatches(allRanges.length);
      if (allRanges.length > 0 && currentMatchIndex >= allRanges.length) {
        setCurrentMatchIndex(0);
      }

      // Create highlights
      if (allRanges.length > 0) {
        const targetIndex = Math.max(0, Math.min(currentMatchIndex, allRanges.length - 1));

        // Create highlight for all matches (yellow)
        const allHighlight = new (window as any).Highlight(...allRanges);
        (CSS as any).highlights.set('search-results', allHighlight);

        // Create highlight for current match (accent color)
        const currentHighlight = new (window as any).Highlight(allRanges[targetIndex]);
        (CSS as any).highlights.set('search-current', currentHighlight);

        // Scroll to current match
        const currentRange = allRanges[targetIndex];
        const rect = currentRange.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        const scrollParent = contentRef.current;

        if (scrollParent && rect) {
          // Calculate scroll position to center the match
          const scrollTop = scrollParent.scrollTop + rect.top - containerRect.top - scrollParent.clientHeight / 2 + rect.height / 2;
          scrollParent.scrollTo({ top: scrollTop, behavior: 'smooth' });
        }
      } else {
        (CSS as any).highlights.delete('search-results');
        (CSS as any).highlights.delete('search-current');
      }

      // Cleanup function
      return () => {
        (CSS as any).highlights.delete('search-results');
        (CSS as any).highlights.delete('search-current');
      };
    } else {
      // Fallback: count matches and scroll to location (no highlighting)
      const matches = file?.content?.match(searchRegex);
      const count = matches ? matches.length : 0;
      setTotalMatches(count);

      if (count > 0) {
        const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
        let matchCount = 0;
        const targetIndex = Math.max(0, Math.min(currentMatchIndex, count - 1));

        let textNode;
        while ((textNode = walker.nextNode())) {
          const text = textNode.textContent || '';
          const nodeMatches = text.match(searchRegex);
          if (nodeMatches) {
            for (const _ of nodeMatches) {
              if (matchCount === targetIndex) {
                const parentElement = (textNode as Text).parentElement;
                if (parentElement) {
                  parentElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
                return;
              }
              matchCount++;
            }
          }
        }
      }
    }

    matchElementsRef.current = [];
  }, [searchQuery, file?.content, isMarkdown, markdownEditMode, currentMatchIndex, theme.colors.accent]);

  const copyPathToClipboard = () => {
    if (!file) return;
    navigator.clipboard.writeText(file.path);
    setCopyNotificationMessage('File Path Copied to Clipboard');
    setShowCopyNotification(true);
    setTimeout(() => setShowCopyNotification(false), 2000);
  };

  const copyContentToClipboard = async () => {
    if (!file) return;
    if (isImage) {
      // For images, copy the image to clipboard
      try {
        const response = await fetch(file.content);
        const blob = await response.blob();
        await navigator.clipboard.write([
          new ClipboardItem({ [blob.type]: blob })
        ]);
        setCopyNotificationMessage('Image Copied to Clipboard');
      } catch (err) {
        // Fallback: copy the data URL if image copy fails
        navigator.clipboard.writeText(file.content);
        setCopyNotificationMessage('Image URL Copied to Clipboard');
      }
    } else {
      // For text files, copy the content
      navigator.clipboard.writeText(file.content);
      setCopyNotificationMessage('Content Copied to Clipboard');
    }
    setShowCopyNotification(true);
    setTimeout(() => setShowCopyNotification(false), 2000);
  };

  // Navigate to next search match
  const goToNextMatch = () => {
    if (totalMatches === 0) return;

    // Move to next match (wrap around)
    const nextIndex = (currentMatchIndex + 1) % totalMatches;
    setCurrentMatchIndex(nextIndex);

    // For code files, handle DOM-based highlighting
    const matches = matchElementsRef.current;
    if (matches.length > 0) {
      // Reset previous highlight
      if (matches[currentMatchIndex]) {
        matches[currentMatchIndex].style.backgroundColor = '#ffd700';
        matches[currentMatchIndex].style.color = '#000';
      }
      // Highlight new current match and scroll to it
      if (matches[nextIndex]) {
        matches[nextIndex].style.backgroundColor = theme.colors.accent;
        matches[nextIndex].style.color = '#fff';
        matches[nextIndex].scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
    // For markdown edit mode, the effect will handle selecting text
  };

  // Navigate to previous search match
  const goToPrevMatch = () => {
    if (totalMatches === 0) return;

    // Move to previous match (wrap around)
    const prevIndex = (currentMatchIndex - 1 + totalMatches) % totalMatches;
    setCurrentMatchIndex(prevIndex);

    // For code files, handle DOM-based highlighting
    const matches = matchElementsRef.current;
    if (matches.length > 0) {
      // Reset previous highlight
      if (matches[currentMatchIndex]) {
        matches[currentMatchIndex].style.backgroundColor = '#ffd700';
        matches[currentMatchIndex].style.color = '#000';
      }
      // Highlight new current match and scroll to it
      if (matches[prevIndex]) {
        matches[prevIndex].style.backgroundColor = theme.colors.accent;
        matches[prevIndex].style.color = '#fff';
        matches[prevIndex].scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
    // For markdown edit mode, the effect will handle selecting text
  };

  // Format shortcut keys for display
  const formatShortcut = (shortcutId: string): string => {
    const shortcut = shortcuts[shortcutId];
    if (!shortcut) return '';
    return formatShortcutKeys(shortcut.keys);
  };

  // Handle search in markdown edit mode - jump to and select the match in textarea
  useEffect(() => {
    if (!isMarkdown || !markdownEditMode || !searchQuery.trim() || !textareaRef.current) {
      return;
    }

    const content = editContent;
    const escapedQuery = searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escapedQuery, 'gi');

    // Find all matches and their positions
    const matches: { start: number; end: number }[] = [];
    let matchResult;
    while ((matchResult = regex.exec(content)) !== null) {
      matches.push({ start: matchResult.index, end: matchResult.index + matchResult[0].length });
    }

    setTotalMatches(matches.length);
    if (matches.length === 0) {
      setCurrentMatchIndex(0);
      return;
    }

    // Clamp current match index
    const validIndex = Math.min(currentMatchIndex, matches.length - 1);
    if (validIndex !== currentMatchIndex) {
      setCurrentMatchIndex(validIndex);
      return;
    }

    // Select the current match in the textarea
    const currentMatch = matches[validIndex];
    if (currentMatch) {
      const textarea = textareaRef.current;
      textarea.focus();
      textarea.setSelectionRange(currentMatch.start, currentMatch.end);

      // Scroll to make the selection visible
      // Calculate approximate line number and scroll to it
      const textBeforeMatch = content.substring(0, currentMatch.start);
      const lineNumber = textBeforeMatch.split('\n').length;
      const lineHeight = parseInt(getComputedStyle(textarea).lineHeight) || 24;
      const targetScroll = (lineNumber - 5) * lineHeight; // Leave some lines above
      textarea.scrollTop = Math.max(0, targetScroll);
    }
  }, [searchQuery, currentMatchIndex, isMarkdown, markdownEditMode, editContent]);

  // Helper to check if a shortcut matches
  const isShortcut = (e: React.KeyboardEvent, shortcutId: string) => {
    const shortcut = shortcuts[shortcutId];
    if (!shortcut) return false;

    const hasModifier = (key: string) => {
      if (key === 'Meta') return e.metaKey;
      if (key === 'Ctrl') return e.ctrlKey;
      if (key === 'Alt') return e.altKey;
      if (key === 'Shift') return e.shiftKey;
      return false;
    };

    const modifiers = shortcut.keys.filter((k: string) => ['Meta', 'Ctrl', 'Alt', 'Shift'].includes(k));
    const mainKey = shortcut.keys.find((k: string) => !['Meta', 'Ctrl', 'Alt', 'Shift'].includes(k));

    const modifiersMatch = modifiers.every((m: string) => hasModifier(m));
    const keyMatches = mainKey?.toLowerCase() === e.key.toLowerCase();

    return modifiersMatch && keyMatches;
  };

  // Handle keyboard events
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'f' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      setSearchOpen(true);
      setTimeout(() => searchInputRef.current?.focus(), 0);
    } else if (e.key === 's' && (e.metaKey || e.ctrlKey) && isMarkdown && markdownEditMode) {
      // Cmd+S to save in edit mode
      e.preventDefault();
      e.stopPropagation();
      handleSave();
    } else if (isShortcut(e, 'copyFilePath')) {
      e.preventDefault();
      e.stopPropagation();
      copyPathToClipboard();
    } else if (isMarkdown && isShortcut(e, 'toggleMarkdownMode')) {
      e.preventDefault();
      e.stopPropagation();
      setMarkdownEditMode(!markdownEditMode);
    } else if (e.key === 'ArrowUp') {
      // In edit mode, let the textarea handle arrow keys for cursor movement
      // Only intercept when NOT in edit mode (preview/code view)
      if (isMarkdown && markdownEditMode) return;

      e.preventDefault();
      const container = contentRef.current;
      if (!container) return;

      if (e.metaKey || e.ctrlKey) {
        // Cmd/Ctrl + Up: Jump to top
        container.scrollTop = 0;
      } else if (e.altKey) {
        // Alt + Up: Page up
        container.scrollTop -= container.clientHeight;
      } else {
        // Arrow Up: Scroll up
        container.scrollTop -= 40;
      }
    } else if (e.key === 'ArrowDown') {
      // In edit mode, let the textarea handle arrow keys for cursor movement
      // Only intercept when NOT in edit mode (preview/code view)
      if (isMarkdown && markdownEditMode) return;

      e.preventDefault();
      const container = contentRef.current;
      if (!container) return;

      if (e.metaKey || e.ctrlKey) {
        // Cmd/Ctrl + Down: Jump to bottom
        container.scrollTop = container.scrollHeight;
      } else if (e.altKey) {
        // Alt + Down: Page down
        container.scrollTop += container.clientHeight;
      } else {
        // Arrow Down: Scroll down
        container.scrollTop += 40;
      }
    } else if (e.key === 'ArrowLeft' && (e.metaKey || e.ctrlKey)) {
      // Cmd+Left: Navigate back in history (disabled in edit mode)
      if (isMarkdown && markdownEditMode) return;
      e.preventDefault();
      e.stopPropagation();
      if (canGoBack && onNavigateBack) {
        onNavigateBack();
      }
    } else if (e.key === 'ArrowRight' && (e.metaKey || e.ctrlKey)) {
      // Cmd+Right: Navigate forward in history (disabled in edit mode)
      if (isMarkdown && markdownEditMode) return;
      e.preventDefault();
      e.stopPropagation();
      if (canGoForward && onNavigateForward) {
        onNavigateForward();
      }
    } else if (isShortcut(e, 'fuzzyFileSearch') && onOpenFuzzySearch) {
      // Cmd+G: Open fuzzy file search (only in preview mode, not edit mode)
      if (isMarkdown && markdownEditMode) return;
      e.preventDefault();
      e.stopPropagation();
      onOpenFuzzySearch();
    }
  };

  // Early return if no file - must be after all hooks
  if (!file) return null;

  return (
    <div
      ref={containerRef}
      className="flex flex-col h-full outline-none"
      style={{ backgroundColor: theme.colors.bgMain }}
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      {/* CSS for Custom Highlight API */}
      <style>{`
        ::highlight(search-results) {
          background-color: #ffd700;
          color: #000;
        }
        ::highlight(search-current) {
          background-color: ${theme.colors.accent};
          color: #fff;
        }
      `}</style>

      {/* Header */}
      <div className="shrink-0" style={{ backgroundColor: theme.colors.bgSidebar }}>
        {/* Main header row */}
        <div className="border-b flex items-center justify-between px-6 py-3" style={{ borderColor: theme.colors.border }}>
          <div className="flex items-center gap-3">
            <FileCode className="w-5 h-5 shrink-0" style={{ color: theme.colors.accent }} />
            <div className="min-w-0">
              <div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>{file.name}</div>
              <div className="text-xs opacity-50 truncate" style={{ color: theme.colors.textDim }}>{directoryPath}</div>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {isMarkdown && (
              <>
                {/* Save button - only shown in edit mode with changes */}
                {markdownEditMode && onSave && (
                  <button
                    onClick={handleSave}
                    disabled={!hasChanges || isSaving}
                    className="px-3 py-1.5 rounded text-xs font-medium transition-colors flex items-center gap-1.5"
                    style={{
                      backgroundColor: hasChanges ? theme.colors.accent : theme.colors.bgActivity,
                      color: hasChanges ? theme.colors.accentForeground : theme.colors.textDim,
                      opacity: hasChanges && !isSaving ? 1 : 0.5,
                      cursor: hasChanges && !isSaving ? 'pointer' : 'default',
                    }}
                    title={hasChanges ? "Save changes (⌘S)" : "No changes to save"}
                  >
                    {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                    {isSaving ? 'Saving...' : 'Save'}
                  </button>
                )}
                {/* Show remote images toggle - only in preview mode */}
                {!markdownEditMode && (
                  <button
                    onClick={() => setShowRemoteImages(!showRemoteImages)}
                    className="p-2 rounded hover:bg-white/10 transition-colors"
                    style={{ color: showRemoteImages ? theme.colors.accent : theme.colors.textDim }}
                    title={showRemoteImages ? "Hide remote images" : "Show remote images"}
                  >
                    <Globe className="w-4 h-4" />
                  </button>
                )}
                {/* Toggle between edit and preview mode */}
                <button
                  onClick={() => setMarkdownEditMode(!markdownEditMode)}
                  className="p-2 rounded hover:bg-white/10 transition-colors"
                  style={{ color: markdownEditMode ? theme.colors.accent : theme.colors.textDim }}
                  title={`${markdownEditMode ? "Show preview" : "Edit file"} (${formatShortcut('toggleMarkdownMode')})`}
                >
                  {markdownEditMode ? <Eye className="w-4 h-4" /> : <Edit className="w-4 h-4" />}
                </button>
              </>
            )}
            <button
              onClick={copyContentToClipboard}
              className="p-2 rounded hover:bg-white/10 transition-colors"
              style={{ color: theme.colors.textDim }}
              title={isImage ? "Copy image to clipboard" : "Copy content to clipboard"}
            >
              <Clipboard className="w-4 h-4" />
            </button>
            <button
              onClick={copyPathToClipboard}
              className="p-2 rounded hover:bg-white/10 transition-colors"
              style={{ color: theme.colors.textDim }}
              title="Copy full path to clipboard"
            >
              <FolderOpen className="w-4 h-4" />
            </button>
            <button
              onClick={onClose}
              className="p-2 rounded hover:bg-white/10 transition-colors"
              style={{ color: theme.colors.textDim }}
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>
        {/* File Stats subbar - hidden on scroll */}
        {((fileStats || tokenCount !== null || taskCounts) && showStatsBar) || (canGoBack || canGoForward) ? (
          <div
            className="flex items-center justify-between px-6 py-1.5 border-b transition-all duration-200"
            style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgActivity }}
          >
            <div className="flex items-center gap-4">
              {fileStats && (
                <div className="text-[10px]" style={{ color: theme.colors.textDim }}>
                  <span className="opacity-60">Size:</span>{' '}
                  <span style={{ color: theme.colors.textMain }}>{formatFileSize(fileStats.size)}</span>
                </div>
              )}
              {tokenCount !== null && (
                <div className="text-[10px]" style={{ color: theme.colors.textDim }}>
                  <span className="opacity-60">Tokens:</span>{' '}
                  <span style={{ color: theme.colors.accent }}>{formatTokenCount(tokenCount)}</span>
                </div>
              )}
              {fileStats && (
                <>
                  <div className="text-[10px]" style={{ color: theme.colors.textDim }}>
                    <span className="opacity-60">Modified:</span>{' '}
                    <span style={{ color: theme.colors.textMain }}>{formatDateTime(fileStats.modifiedAt)}</span>
                  </div>
                  <div className="text-[10px]" style={{ color: theme.colors.textDim }}>
                    <span className="opacity-60">Created:</span>{' '}
                    <span style={{ color: theme.colors.textMain }}>{formatDateTime(fileStats.createdAt)}</span>
                  </div>
                </>
              )}
              {taskCounts && (
                <div className="text-[10px]" style={{ color: theme.colors.textDim }}>
                  <span className="opacity-60">Tasks:</span>{' '}
                  <span style={{ color: theme.colors.success }}>{taskCounts.closed}</span>
                  <span style={{ color: theme.colors.textMain }}> of {taskCounts.open + taskCounts.closed}</span>
                </div>
              )}
            </div>
            {/* Navigation buttons - show when either direction is available, disabled in edit mode */}
            {(canGoBack || canGoForward) && !markdownEditMode && (
              <div className="flex items-center gap-1">
                {/* Back button with popup */}
                <div
                  className="relative"
                  onMouseEnter={() => {
                    if (backPopupTimeoutRef.current) {
                      clearTimeout(backPopupTimeoutRef.current);
                      backPopupTimeoutRef.current = null;
                    }
                    if (canGoBack) setShowBackPopup(true);
                  }}
                  onMouseLeave={() => {
                    backPopupTimeoutRef.current = setTimeout(() => {
                      setShowBackPopup(false);
                    }, 150);
                  }}
                >
                  <button
                    onClick={onNavigateBack}
                    disabled={!canGoBack}
                    className="p-1 rounded hover:bg-white/10 transition-colors disabled:opacity-30 disabled:cursor-default"
                    style={{ color: canGoBack ? theme.colors.textMain : theme.colors.textDim }}
                    title="Go back (⌘←)"
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  {/* Back history popup */}
                  {showBackPopup && backHistory && backHistory.length > 0 && (
                    <div
                      className="absolute right-0 top-full py-1 rounded shadow-lg z-50 min-w-[200px] max-w-[300px] max-h-[300px] overflow-y-auto"
                      style={{ backgroundColor: theme.colors.bgSidebar, border: `1px solid ${theme.colors.border}` }}
                    >
                      {backHistory.slice().reverse().map((item, idx) => {
                        const actualIndex = backHistory.length - 1 - idx;
                        return (
                          <button
                            key={`back-${actualIndex}`}
                            className="w-full px-3 py-1.5 text-left text-xs hover:bg-white/10 truncate flex items-center gap-2"
                            style={{ color: theme.colors.textMain }}
                            onClick={() => {
                              onNavigateToIndex?.(actualIndex);
                              setShowBackPopup(false);
                            }}
                          >
                            <span className="opacity-50 shrink-0">{actualIndex + 1}.</span>
                            <span className="truncate">{item.name}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
                {/* Forward button with popup */}
                <div
                  className="relative"
                  onMouseEnter={() => {
                    if (forwardPopupTimeoutRef.current) {
                      clearTimeout(forwardPopupTimeoutRef.current);
                      forwardPopupTimeoutRef.current = null;
                    }
                    if (canGoForward) setShowForwardPopup(true);
                  }}
                  onMouseLeave={() => {
                    forwardPopupTimeoutRef.current = setTimeout(() => {
                      setShowForwardPopup(false);
                    }, 150);
                  }}
                >
                  <button
                    onClick={onNavigateForward}
                    disabled={!canGoForward}
                    className="p-1 rounded hover:bg-white/10 transition-colors disabled:opacity-30 disabled:cursor-default"
                    style={{ color: canGoForward ? theme.colors.textMain : theme.colors.textDim }}
                    title="Go forward (⌘→)"
                  >
                    <ChevronRight className="w-4 h-4" />
                  </button>
                  {/* Forward history popup */}
                  {showForwardPopup && forwardHistory && forwardHistory.length > 0 && (
                    <div
                      className="absolute right-0 top-full py-1 rounded shadow-lg z-50 min-w-[200px] max-w-[300px] max-h-[300px] overflow-y-auto"
                      style={{ backgroundColor: theme.colors.bgSidebar, border: `1px solid ${theme.colors.border}` }}
                    >
                      {forwardHistory.map((item, idx) => {
                        const actualIndex = (currentHistoryIndex ?? 0) + 1 + idx;
                        return (
                          <button
                            key={`forward-${actualIndex}`}
                            className="w-full px-3 py-1.5 text-left text-xs hover:bg-white/10 truncate flex items-center gap-2"
                            style={{ color: theme.colors.textMain }}
                            onClick={() => {
                              onNavigateToIndex?.(actualIndex);
                              setShowForwardPopup(false);
                            }}
                          >
                            <span className="opacity-50 shrink-0">{actualIndex + 1}.</span>
                            <span className="truncate">{item.name}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        ) : null}
      </div>

      {/* Content */}
      <div ref={contentRef} className="flex-1 overflow-y-auto px-6 pt-3 pb-6 scrollbar-thin">
        {/* Floating Search */}
        {searchOpen && (
          <div className="sticky top-0 z-10 pb-4">
            <div className="flex items-center gap-2">
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    setSearchOpen(false);
                    setSearchQuery('');
                    // Refocus container so keyboard navigation still works
                    containerRef.current?.focus();
                  } else if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    goToNextMatch();
                  } else if (e.key === 'Enter' && e.shiftKey) {
                    e.preventDefault();
                    goToPrevMatch();
                  }
                }}
                placeholder="Search in file... (Enter: next, Shift+Enter: prev)"
                className="flex-1 px-3 py-2 rounded border bg-transparent outline-none text-sm"
                style={{ borderColor: theme.colors.accent, color: theme.colors.textMain, backgroundColor: theme.colors.bgSidebar }}
                autoFocus
              />
              {searchQuery.trim() && (
                <>
                  <span className="text-xs whitespace-nowrap" style={{ color: theme.colors.textDim }}>
                    {totalMatches > 0 ? `${currentMatchIndex + 1}/${totalMatches}` : 'No matches'}
                  </span>
                  <button
                    onClick={goToPrevMatch}
                    disabled={totalMatches === 0}
                    className="p-1.5 rounded hover:bg-white/10 transition-colors disabled:opacity-30"
                    style={{ color: theme.colors.textDim }}
                    title="Previous match (Shift+Enter)"
                  >
                    <ChevronUp className="w-4 h-4" />
                  </button>
                  <button
                    onClick={goToNextMatch}
                    disabled={totalMatches === 0}
                    className="p-1.5 rounded hover:bg-white/10 transition-colors disabled:opacity-30"
                    style={{ color: theme.colors.textDim }}
                    title="Next match (Enter)"
                  >
                    <ChevronDown className="w-4 h-4" />
                  </button>
                </>
              )}
            </div>
          </div>
        )}
        {isImage ? (
          <div className="flex items-center justify-center h-full">
            <img
              src={file.content}
              alt={file.name}
              className="max-w-full max-h-full object-contain"
              style={{ imageRendering: 'crisp-edges' }}
            />
          </div>
        ) : isBinary ? (
          <div className="flex flex-col items-center justify-center h-full gap-4">
            <FileCode className="w-16 h-16" style={{ color: theme.colors.textDim }} />
            <div className="text-center">
              <p className="text-lg font-medium" style={{ color: theme.colors.textMain }}>
                Binary File
              </p>
              <p className="text-sm mt-1" style={{ color: theme.colors.textDim }}>
                This file cannot be displayed as text.
              </p>
              <button
                onClick={() => window.maestro.shell.openExternal(`file://${file.path}`)}
                className="mt-4 px-4 py-2 rounded text-sm hover:opacity-80 transition-opacity"
                style={{ backgroundColor: theme.colors.accent, color: theme.colors.accentForeground }}
              >
                Open in Default App
              </button>
            </div>
          </div>
        ) : isMarkdown && markdownEditMode ? (
          // Edit mode - show editable textarea with search highlighting via selection
          <textarea
            ref={textareaRef}
            value={editContent}
            onChange={(e) => setEditContent(e.target.value)}
            className="w-full h-full font-mono text-sm resize-none outline-none bg-transparent"
            style={{
              color: theme.colors.textMain,
              caretColor: theme.colors.accent,
              lineHeight: '1.6',
            }}
            spellCheck={false}
            onKeyDown={(e) => {
              // Handle Cmd+S for save
              if (e.key === 's' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                e.stopPropagation();
                handleSave();
              }
              // Handle Escape to exit edit mode (without save)
              else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setMarkdownEditMode(false);
              }
              // Handle Cmd+Up: Move cursor to beginning of document
              else if (e.key === 'ArrowUp' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                const textarea = e.currentTarget;
                textarea.setSelectionRange(0, 0);
                textarea.scrollTop = 0;
              }
              // Handle Cmd+Down: Move cursor to end of document
              else if (e.key === 'ArrowDown' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                const textarea = e.currentTarget;
                const len = textarea.value.length;
                textarea.setSelectionRange(len, len);
                textarea.scrollTop = textarea.scrollHeight;
              }
              // Handle Opt+Up: Page up (move cursor up by roughly a page)
              else if (e.key === 'ArrowUp' && e.altKey) {
                e.preventDefault();
                const textarea = e.currentTarget;
                const lineHeight = parseInt(getComputedStyle(textarea).lineHeight) || 24;
                const linesPerPage = Math.floor(textarea.clientHeight / lineHeight);
                const lines = textarea.value.substring(0, textarea.selectionStart).split('\n');
                const currentLine = lines.length - 1;
                const targetLine = Math.max(0, currentLine - linesPerPage);
                // Calculate new cursor position
                let newPos = 0;
                for (let i = 0; i < targetLine; i++) {
                  newPos += lines[i].length + 1; // +1 for newline
                }
                // Preserve column position if possible
                const currentCol = lines[currentLine].length - (lines[currentLine].length - (textarea.selectionStart - (newPos - (currentLine > 0 ? 1 : 0))));
                const targetLineText = textarea.value.split('\n')[targetLine] || '';
                newPos = textarea.value.split('\n').slice(0, targetLine).join('\n').length + (targetLine > 0 ? 1 : 0);
                newPos += Math.min(currentCol, targetLineText.length);
                textarea.setSelectionRange(newPos, newPos);
                // Scroll to show the cursor
                textarea.scrollTop -= textarea.clientHeight;
              }
              // Handle Opt+Down: Page down (move cursor down by roughly a page)
              else if (e.key === 'ArrowDown' && e.altKey) {
                e.preventDefault();
                const textarea = e.currentTarget;
                const lineHeight = parseInt(getComputedStyle(textarea).lineHeight) || 24;
                const linesPerPage = Math.floor(textarea.clientHeight / lineHeight);
                const allLines = textarea.value.split('\n');
                const textBeforeCursor = textarea.value.substring(0, textarea.selectionStart);
                const currentLine = textBeforeCursor.split('\n').length - 1;
                const targetLine = Math.min(allLines.length - 1, currentLine + linesPerPage);
                // Calculate column position in current line
                const linesBeforeCurrent = textBeforeCursor.split('\n');
                const currentCol = linesBeforeCurrent[linesBeforeCurrent.length - 1].length;
                // Calculate new cursor position
                let newPos = allLines.slice(0, targetLine).join('\n').length + (targetLine > 0 ? 1 : 0);
                newPos += Math.min(currentCol, allLines[targetLine].length);
                textarea.setSelectionRange(newPos, newPos);
                // Scroll to show the cursor
                textarea.scrollTop += textarea.clientHeight;
              }
            }}
          />
        ) : isMarkdown ? (
          <div ref={markdownContainerRef} className="file-preview-content prose prose-sm max-w-none" style={{ color: theme.colors.textMain }}>
            {/* Scoped prose styles to avoid CSS conflicts with other prose containers */}
            <style>{`
              .file-preview-content.prose h1 { color: ${theme.colors.accent}; font-size: 2em; font-weight: bold; margin: 0.67em 0; }
              .file-preview-content.prose h2 { color: ${theme.colors.success}; font-size: 1.5em; font-weight: bold; margin: 0.75em 0; }
              .file-preview-content.prose h3 { color: ${theme.colors.warning}; font-size: 1.17em; font-weight: bold; margin: 0.83em 0; }
              .file-preview-content.prose h4 { color: ${theme.colors.textMain}; font-size: 1em; font-weight: bold; margin: 1em 0; opacity: 0.9; }
              .file-preview-content.prose h5 { color: ${theme.colors.textMain}; font-size: 0.83em; font-weight: bold; margin: 1.17em 0; opacity: 0.8; }
              .file-preview-content.prose h6 { color: ${theme.colors.textDim}; font-size: 0.67em; font-weight: bold; margin: 1.33em 0; }
              .file-preview-content.prose p { color: ${theme.colors.textMain}; margin: 0.5em 0; }
              .file-preview-content.prose ul, .file-preview-content.prose ol { color: ${theme.colors.textMain}; margin: 0.5em 0; padding-left: 1.5em; }
              .file-preview-content.prose li { margin: 0.25em 0; }
              .file-preview-content.prose li:has(> input[type="checkbox"]) { list-style: none; margin-left: -1.5em; }
              .file-preview-content.prose code { background-color: ${theme.colors.bgActivity}; color: ${theme.colors.textMain}; padding: 0.2em 0.4em; border-radius: 3px; font-size: 0.9em; }
              .file-preview-content.prose pre { background-color: ${theme.colors.bgActivity}; color: ${theme.colors.textMain}; padding: 1em; border-radius: 6px; overflow-x: auto; }
              .file-preview-content.prose pre code { background: none; padding: 0; }
              .file-preview-content.prose blockquote { border-left: 4px solid ${theme.colors.border}; padding-left: 1em; margin: 0.5em 0; color: ${theme.colors.textDim}; }
              .file-preview-content.prose a { color: ${theme.colors.accent}; text-decoration: underline; }
              .file-preview-content.prose hr { border: none; border-top: 2px solid ${theme.colors.border}; margin: 1em 0; }
              .file-preview-content.prose table { border-collapse: collapse; width: 100%; margin: 0.5em 0; }
              .file-preview-content.prose th, .file-preview-content.prose td { border: 1px solid ${theme.colors.border}; padding: 0.5em; text-align: left; }
              .file-preview-content.prose th { background-color: ${theme.colors.bgActivity}; font-weight: bold; }
              .file-preview-content.prose strong { font-weight: bold; }
              .file-preview-content.prose em { font-style: italic; }
              .file-preview-content.prose img { display: block; max-width: 100%; height: auto; }
            `}</style>
            <ReactMarkdown
              remarkPlugins={[
                remarkGfm,
                remarkFrontmatter,
                remarkFrontmatterTable,
                remarkHighlight,
                ...(fileTree && fileTree.length > 0 && cwd !== undefined
                  ? [[remarkFileLinks, { fileTree, cwd }] as any]
                  : [])
              ]}
              rehypePlugins={[rehypeRaw]}
              components={{
                a: ({ node, href, children, ...props }) => {
                  // Check for maestro-file:// protocol OR data-maestro-file attribute
                  // (data attribute is fallback when rehype strips custom protocols)
                  const dataFilePath = (props as any)['data-maestro-file'];
                  const isMaestroFile = href?.startsWith('maestro-file://') || !!dataFilePath;
                  const filePath = dataFilePath || (href?.startsWith('maestro-file://') ? href.replace('maestro-file://', '') : null);

                  return (
                    <a
                      href={href}
                      {...props}
                      onClick={(e) => {
                        e.preventDefault();
                        if (isMaestroFile && filePath && onFileClick) {
                          onFileClick(filePath);
                        } else if (href) {
                          window.maestro.shell.openExternal(href);
                        }
                      }}
                      style={{ color: theme.colors.accent, textDecoration: 'underline', cursor: 'pointer' }}
                    >
                      {children}
                    </a>
                  );
                },
                code: ({ node, inline, className, children, ...props }: any) => {
                  const match = (className || '').match(/language-(\w+)/);
                  const language = match ? match[1] : 'text';
                  const codeContent = String(children).replace(/\n$/, '');

                  // Handle mermaid code blocks
                  if (!inline && language === 'mermaid') {
                    return <MermaidRenderer chart={codeContent} theme={theme} />;
                  }

                  return !inline && match ? (
                    <SyntaxHighlighter
                      language={language}
                      style={vscDarkPlus}
                      customStyle={{
                        margin: '0.5em 0',
                        padding: '1em',
                        background: theme.colors.bgActivity,
                        fontSize: '0.9em',
                        borderRadius: '6px',
                      }}
                      PreTag="div"
                    >
                      {codeContent}
                    </SyntaxHighlighter>
                  ) : (
                    <code className={className} {...props}>
                      {children}
                    </code>
                  );
                },
                img: ({ node, src, alt, ...props }) => {
                  // Check if this image came from file tree (set by remarkFileLinks)
                  const isFromTree = (props as any)['data-maestro-from-tree'] === 'true';
                  // Get the project root from the markdown file path (directory containing the file tree root)
                  // For FilePreview, the file.path is absolute, so we extract the root from it
                  const markdownDir = file.path.substring(0, file.path.lastIndexOf('/'));
                  // If image is from file tree, we need the project root to resolve correctly
                  // The project root would be the common ancestor - we'll derive it from the file path
                  // For now, use the directory where the first folder in cwd would be located
                  let projectRootForImage: string | undefined;
                  if (isFromTree && cwd) {
                    // cwd is relative path like "People" or "OPSWAT/Meetings"
                    // We need to find where in file.path the cwd starts
                    const cwdIndex = file.path.indexOf(`/${cwd}/`);
                    if (cwdIndex !== -1) {
                      projectRootForImage = file.path.substring(0, cwdIndex);
                    } else {
                      // Try to find just the first segment of cwd
                      const firstCwdSegment = cwd.split('/')[0];
                      const segmentIndex = file.path.indexOf(`/${firstCwdSegment}/`);
                      if (segmentIndex !== -1) {
                        projectRootForImage = file.path.substring(0, segmentIndex);
                      }
                    }
                  }
                  return (
                    <MarkdownImage
                      src={src}
                      alt={alt}
                      markdownFilePath={file.path}
                      theme={theme}
                      showRemoteImages={showRemoteImages}
                      isFromFileTree={isFromTree}
                      projectRoot={projectRootForImage}
                    />
                  );
                }
              }}
            >
              {file.content}
            </ReactMarkdown>
          </div>
        ) : (
          <div ref={codeContainerRef}>
            <SyntaxHighlighter
              language={language}
              style={vscDarkPlus}
              customStyle={{
                margin: 0,
                padding: '24px',
                background: 'transparent',
                fontSize: '13px',
              }}
              showLineNumbers
              PreTag="div"
            >
              {file.content}
            </SyntaxHighlighter>
          </div>
        )}
      </div>

      {/* Copy Notification Toast */}
      {showCopyNotification && (
        <div
          className="fixed top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 px-6 py-4 rounded-lg shadow-2xl text-base font-bold animate-in fade-in zoom-in-95 duration-200 z-50"
          style={{
            backgroundColor: theme.colors.accent,
            color: theme.colors.accentForeground,
            textShadow: '0 1px 2px rgba(0, 0, 0, 0.3)'
          }}
        >
          {copyNotificationMessage}
        </div>
      )}

      {/* Unsaved Changes Confirmation Modal */}
      {showUnsavedChangesModal && (
        <Modal
          theme={theme}
          title="Unsaved Changes"
          priority={MODAL_PRIORITIES.CONFIRM}
          onClose={() => setShowUnsavedChangesModal(false)}
          width={450}
          zIndex={10000}
          headerIcon={<AlertTriangle className="w-5 h-5" style={{ color: theme.colors.warning }} />}
          initialFocusRef={cancelButtonRef}
          footer={
            <ModalFooter
              theme={theme}
              onCancel={() => setShowUnsavedChangesModal(false)}
              onConfirm={() => {
                setShowUnsavedChangesModal(false);
                onClose();
              }}
              cancelLabel="No, Stay"
              confirmLabel="Yes, Discard"
              destructive
              cancelButtonRef={cancelButtonRef}
            />
          }
        >
          <p className="text-sm leading-relaxed" style={{ color: theme.colors.textMain }}>
            You have unsaved changes. Are you sure you want to close without saving?
          </p>
        </Modal>
      )}

    </div>
  );
}
