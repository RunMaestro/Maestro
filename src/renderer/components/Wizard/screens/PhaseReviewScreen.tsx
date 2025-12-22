/**
 * PhaseReviewScreen.tsx
 *
 * Fifth screen of the onboarding wizard - displays generated documents
 * with markdown editor, preview mode, and launch options.
 *
 * Features:
 * - Document selector dropdown to switch between generated documents
 * - Full markdown editor with edit/preview toggle (matching Auto Run interface)
 * - Image attachment support (paste, upload, drag-drop)
 * - Auto-save with debounce
 * - Task count display
 * - "I'm Ready to Go" and "Walk Me Through" action buttons
 * - Keyboard navigation support
 */

import { useEffect, useCallback, useRef, useState, useMemo } from 'react';
import { useClickOutside } from '../../../hooks';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import {
  Eye,
  Edit,
  Image,
  Loader2,
  Rocket,
  Compass,
  ChevronDown,
  ChevronRight,
  X,
} from 'lucide-react';
import type { Theme } from '../../../types';
import { useWizard, type GeneratedDocument } from '../WizardContext';
import { AUTO_RUN_FOLDER_NAME } from '../services/phaseGenerator';
import { MermaidRenderer } from '../../MermaidRenderer';
import { ScreenReaderAnnouncement } from '../ScreenReaderAnnouncement';

// Memoize remarkPlugins array - it never changes
const REMARK_PLUGINS = [remarkGfm];

// Auto-save debounce delay in milliseconds
const AUTO_SAVE_DELAY = 2000;

interface PhaseReviewScreenProps {
  theme: Theme;
  onLaunchSession: (wantsTour: boolean) => Promise<void>;
  /** Analytics callback: Called when wizard completes successfully */
  onWizardComplete?: (
    durationMs: number,
    conversationExchanges: number,
    phasesGenerated: number,
    tasksGenerated: number
  ) => void;
  /** Start time of the wizard for duration calculation */
  wizardStartTime?: number;
}

/**
 * Document selector dropdown for switching between generated documents
 * Styled to match the Auto Run panel's document selector
 */
function DocumentSelector({
  documents,
  selectedIndex,
  onSelect,
  theme,
}: {
  documents: GeneratedDocument[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  theme: Theme;
}): JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Close dropdown when clicking outside
  useClickOutside(dropdownRef, () => setIsOpen(false), isOpen);

  // Close dropdown on Escape - stop propagation to prevent modal from closing
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && isOpen) {
        event.preventDefault();
        event.stopPropagation();
        setIsOpen(false);
        buttonRef.current?.focus();
      }
    }
    if (isOpen) {
      // Use capture phase to intercept before modal's escape handler
      document.addEventListener('keydown', handleKeyDown, true);
      return () => document.removeEventListener('keydown', handleKeyDown, true);
    }
  }, [isOpen]);

  const selectedDoc = documents[selectedIndex];

  return (
    <div ref={dropdownRef} className="relative flex-1 min-w-0">
      <button
        ref={buttonRef}
        onClick={() => setIsOpen(!isOpen)}
        className="w-full min-w-0 flex items-center justify-between px-3 py-2 rounded text-sm transition-colors hover:opacity-90"
        style={{
          backgroundColor: theme.colors.bgActivity,
          color: theme.colors.textMain,
          border: `1px solid ${theme.colors.border}`,
        }}
      >
        <span className="truncate min-w-0 flex-1">
          {selectedDoc?.filename || 'Select document...'}
        </span>
        <ChevronDown
          className={`w-4 h-4 ml-2 shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`}
          style={{ color: theme.colors.textDim }}
        />
      </button>

      {/* Dropdown Menu */}
      {isOpen && (
        <div
          className="absolute top-full left-0 right-0 mt-1 rounded shadow-lg overflow-hidden z-50"
          style={{
            backgroundColor: theme.colors.bgSidebar,
            border: `1px solid ${theme.colors.border}`,
            maxHeight: '300px',
            overflowY: 'auto',
          }}
        >
          {documents.length === 0 ? (
            <div
              className="px-3 py-2 text-sm"
              style={{ color: theme.colors.textDim }}
            >
              No documents generated
            </div>
          ) : (
            documents.map((doc, index) => (
              <button
                key={doc.filename}
                onClick={() => {
                  onSelect(index);
                  setIsOpen(false);
                }}
                className="w-full text-left px-3 py-2 text-sm transition-colors hover:bg-white/5"
                style={{
                  color: index === selectedIndex ? theme.colors.accent : theme.colors.textMain,
                  backgroundColor: index === selectedIndex ? theme.colors.bgActivity : 'transparent',
                }}
              >
                {doc.filename}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Image preview thumbnail for staged images
 */
function ImagePreview({
  src,
  filename,
  theme,
  onRemove,
}: {
  src: string;
  filename: string;
  theme: Theme;
  onRemove: () => void;
}): JSX.Element {
  return (
    <div className="relative inline-block group" style={{ margin: '4px' }}>
      <img
        src={src}
        alt={filename}
        className="w-20 h-20 object-cover rounded hover:opacity-80 transition-opacity"
        style={{ border: `1px solid ${theme.colors.border}` }}
      />
      <button
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        className="absolute -top-2 -right-2 w-5 h-5 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
        style={{
          backgroundColor: theme.colors.error,
          color: 'white',
        }}
        title="Remove image"
      >
        <X className="w-3 h-3" />
      </button>
      <div
        className="absolute bottom-0 left-0 right-0 px-1 py-0.5 text-[9px] truncate rounded-b"
        style={{
          backgroundColor: 'rgba(0,0,0,0.6)',
          color: 'white',
        }}
      >
        {filename}
      </div>
    </div>
  );
}

/**
 * Custom image component for markdown preview
 */
function MarkdownImage({
  src,
  alt,
  folderPath,
  theme,
}: {
  src?: string;
  alt?: string;
  folderPath: string;
  theme: Theme;
}): JSX.Element | null {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!src) {
      setLoading(false);
      return;
    }

    if (src.startsWith('images/') && folderPath) {
      const absolutePath = `${folderPath}/${src}`;
      window.maestro.fs
        .readFile(absolutePath)
        .then((result: string) => {
          if (result.startsWith('data:')) {
            setDataUrl(result);
          } else {
            setError('Invalid image data');
          }
          setLoading(false);
        })
        .catch((err: Error) => {
          setError(`Failed to load: ${err.message}`);
          setLoading(false);
        });
    } else if (src.startsWith('data:') || src.startsWith('http')) {
      setDataUrl(src);
      setLoading(false);
    } else {
      setLoading(false);
    }
  }, [src, folderPath]);

  if (loading) {
    return (
      <span
        className="inline-flex items-center gap-2 px-3 py-2 rounded"
        style={{ backgroundColor: theme.colors.bgActivity }}
      >
        <Loader2
          className="w-4 h-4 animate-spin"
          style={{ color: theme.colors.textDim }}
        />
        <span className="text-xs" style={{ color: theme.colors.textDim }}>
          Loading...
        </span>
      </span>
    );
  }

  if (error || !dataUrl) {
    return null;
  }

  return (
    <img
      src={dataUrl}
      alt={alt || ''}
      className="rounded border my-2"
      style={{
        maxHeight: '200px',
        maxWidth: '100%',
        objectFit: 'contain',
        borderColor: theme.colors.border,
      }}
    />
  );
}

/**
 * Document editor component with edit/preview modes
 */
function DocumentEditor({
  content,
  onContentChange,
  mode,
  onModeChange,
  folderPath,
  selectedFile,
  attachments,
  onAddAttachment,
  onRemoveAttachment,
  theme,
  isLocked,
  textareaRef,
  previewRef,
  documents,
  selectedDocIndex,
  onDocumentSelect,
  statsText,
}: {
  content: string;
  onContentChange: (content: string) => void;
  mode: 'edit' | 'preview';
  onModeChange: (mode: 'edit' | 'preview') => void;
  folderPath: string;
  selectedFile: string;
  attachments: Array<{ filename: string; dataUrl: string }>;
  onAddAttachment: (filename: string, dataUrl: string) => void;
  onRemoveAttachment: (filename: string) => void;
  theme: Theme;
  isLocked: boolean;
  textareaRef: React.RefObject<HTMLTextAreaElement>;
  previewRef: React.RefObject<HTMLDivElement>;
  documents: GeneratedDocument[];
  selectedDocIndex: number;
  onDocumentSelect: (index: number) => void;
  statsText: string;
}): JSX.Element {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [attachmentsExpanded, setAttachmentsExpanded] = useState(true);

  // Handle image paste
  const handlePaste = useCallback(
    async (e: React.ClipboardEvent) => {
      if (isLocked || !folderPath || !selectedFile) return;

      const items = e.clipboardData?.items;
      if (!items) return;

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.type.startsWith('image/')) {
          e.preventDefault();

          const file = item.getAsFile();
          if (!file) continue;

          const reader = new FileReader();
          reader.onload = async (event) => {
            const base64Data = event.target?.result as string;
            if (!base64Data) return;

            const base64Content = base64Data.replace(
              /^data:image\/\w+;base64,/,
              ''
            );
            const extension = item.type.split('/')[1] || 'png';

            const result = await window.maestro.autorun.saveImage(
              folderPath,
              selectedFile,
              base64Content,
              extension
            );

            if (result.success && result.relativePath) {
              const filename =
                result.relativePath.split('/').pop() || result.relativePath;
              onAddAttachment(result.relativePath, base64Data);

              // Insert markdown reference at cursor
              const textarea = textareaRef.current;
              if (textarea) {
                const cursorPos = textarea.selectionStart;
                const textBefore = content.substring(0, cursorPos);
                const textAfter = content.substring(cursorPos);
                const imageMarkdown = `![${filename}](${result.relativePath})`;

                let prefix = '';
                let suffix = '';
                if (textBefore.length > 0 && !textBefore.endsWith('\n')) {
                  prefix = '\n';
                }
                if (textAfter.length > 0 && !textAfter.startsWith('\n')) {
                  suffix = '\n';
                }

                const newContent =
                  textBefore + prefix + imageMarkdown + suffix + textAfter;
                onContentChange(newContent);

                const newCursorPos =
                  cursorPos +
                  prefix.length +
                  imageMarkdown.length +
                  suffix.length;
                setTimeout(() => {
                  textarea.setSelectionRange(newCursorPos, newCursorPos);
                  textarea.focus();
                }, 0);
              }
            }
          };
          reader.readAsDataURL(file);
          break;
        }
      }
    },
    [content, folderPath, selectedFile, isLocked, onContentChange, onAddAttachment]
  );

  // Handle file input for manual image upload
  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file || !folderPath || !selectedFile) return;

      const reader = new FileReader();
      reader.onload = async (event) => {
        const base64Data = event.target?.result as string;
        if (!base64Data) return;

        const base64Content = base64Data.replace(
          /^data:image\/\w+;base64,/,
          ''
        );
        const extension = file.name.split('.').pop() || 'png';

        const result = await window.maestro.autorun.saveImage(
          folderPath,
          selectedFile,
          base64Content,
          extension
        );

        if (result.success && result.relativePath) {
          const filename =
            result.relativePath.split('/').pop() || result.relativePath;
          onAddAttachment(result.relativePath, base64Data);

          const imageMarkdown = `\n![${filename}](${result.relativePath})\n`;
          const newContent = content + imageMarkdown;
          onContentChange(newContent);
        }
      };
      reader.readAsDataURL(file);
      e.target.value = '';
    },
    [content, folderPath, selectedFile, onContentChange, onAddAttachment]
  );

  // Handle key events
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Insert tab character
    if (e.key === 'Tab') {
      e.preventDefault();
      const textarea = e.currentTarget;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const newContent =
        content.substring(0, start) + '\t' + content.substring(end);
      onContentChange(newContent);
      requestAnimationFrame(() => {
        textarea.selectionStart = start + 1;
        textarea.selectionEnd = start + 1;
      });
      return;
    }

    // Toggle mode with Cmd+E
    if ((e.metaKey || e.ctrlKey) && e.key === 'e') {
      e.preventDefault();
      e.stopPropagation();
      onModeChange(mode === 'edit' ? 'preview' : 'edit');
      return;
    }

    // Insert checkbox with Cmd+L
    if ((e.metaKey || e.ctrlKey) && e.key === 'l') {
      e.preventDefault();
      e.stopPropagation();
      const textarea = e.currentTarget;
      const cursorPos = textarea.selectionStart;
      const textBeforeCursor = content.substring(0, cursorPos);
      const textAfterCursor = content.substring(cursorPos);

      const lastNewline = textBeforeCursor.lastIndexOf('\n');
      const lineStart = lastNewline === -1 ? 0 : lastNewline + 1;
      const textOnCurrentLine = textBeforeCursor.substring(lineStart);

      let newContent: string;
      let newCursorPos: number;

      if (textOnCurrentLine.length === 0) {
        newContent = textBeforeCursor + '- [ ] ' + textAfterCursor;
        newCursorPos = cursorPos + 6;
      } else {
        newContent = textBeforeCursor + '\n- [ ] ' + textAfterCursor;
        newCursorPos = cursorPos + 7;
      }

      onContentChange(newContent);
      setTimeout(() => {
        if (textareaRef.current) {
          textareaRef.current.setSelectionRange(newCursorPos, newCursorPos);
        }
      }, 0);
      return;
    }

    // Handle Enter in lists
    if (e.key === 'Enter' && !e.shiftKey) {
      const textarea = e.currentTarget;
      const cursorPos = textarea.selectionStart;
      const textBeforeCursor = content.substring(0, cursorPos);
      const textAfterCursor = content.substring(cursorPos);
      const currentLineStart = textBeforeCursor.lastIndexOf('\n') + 1;
      const currentLine = textBeforeCursor.substring(currentLineStart);

      const taskListMatch = currentLine.match(/^(\s*)- \[([ x])\]\s+/);
      const unorderedListMatch = currentLine.match(/^(\s*)([-*])\s+/);

      if (taskListMatch) {
        const indent = taskListMatch[1];
        e.preventDefault();
        const newContent =
          textBeforeCursor + '\n' + indent + '- [ ] ' + textAfterCursor;
        onContentChange(newContent);
        setTimeout(() => {
          if (textareaRef.current) {
            const newPos = cursorPos + indent.length + 7;
            textareaRef.current.setSelectionRange(newPos, newPos);
          }
        }, 0);
      } else if (unorderedListMatch) {
        const indent = unorderedListMatch[1];
        const marker = unorderedListMatch[2];
        e.preventDefault();
        const newContent =
          textBeforeCursor + '\n' + indent + marker + ' ' + textAfterCursor;
        onContentChange(newContent);
        setTimeout(() => {
          if (textareaRef.current) {
            const newPos = cursorPos + indent.length + 3;
            textareaRef.current.setSelectionRange(newPos, newPos);
          }
        }, 0);
      }
    }
  };

  // Prose styles for markdown preview - scoped to .phase-review to avoid CSS conflicts
  const proseStyles = useMemo(
    () => `
    .phase-review .prose h1 { color: ${theme.colors.textMain}; font-size: 2em; font-weight: bold; margin: 0.67em 0; }
    .phase-review .prose h2 { color: ${theme.colors.textMain}; font-size: 1.5em; font-weight: bold; margin: 0.75em 0; }
    .phase-review .prose h3 { color: ${theme.colors.textMain}; font-size: 1.17em; font-weight: bold; margin: 0.83em 0; }
    .phase-review .prose p { color: ${theme.colors.textMain}; margin: 0.5em 0; }
    .phase-review .prose ul, .phase-review .prose ol { color: ${theme.colors.textMain}; margin: 0.5em 0; padding-left: 1.5em; }
    .phase-review .prose ul { list-style-type: disc; }
    .phase-review .prose li { margin: 0.25em 0; display: list-item; }
    .phase-review .prose code { background-color: ${theme.colors.bgActivity}; color: ${theme.colors.textMain}; padding: 0.2em 0.4em; border-radius: 3px; font-size: 0.9em; }
    .phase-review .prose pre { background-color: ${theme.colors.bgActivity}; color: ${theme.colors.textMain}; padding: 1em; border-radius: 6px; overflow-x: auto; }
    .phase-review .prose pre code { background: none; padding: 0; }
    .phase-review .prose blockquote { border-left: 4px solid ${theme.colors.border}; padding-left: 1em; margin: 0.5em 0; color: ${theme.colors.textDim}; }
    .phase-review .prose a { color: ${theme.colors.accent}; text-decoration: underline; }
    .phase-review .prose strong { font-weight: bold; }
    .phase-review .prose em { font-style: italic; }
    .phase-review .prose input[type="checkbox"] {
      appearance: none;
      -webkit-appearance: none;
      width: 16px;
      height: 16px;
      border: 2px solid ${theme.colors.accent};
      border-radius: 3px;
      background-color: transparent;
      cursor: pointer;
      vertical-align: middle;
      margin-right: 8px;
      position: relative;
    }
    .phase-review .prose input[type="checkbox"]:checked {
      background-color: ${theme.colors.accent};
      border-color: ${theme.colors.accent};
    }
    .phase-review .prose input[type="checkbox"]:checked::after {
      content: '';
      position: absolute;
      left: 4px;
      top: 1px;
      width: 5px;
      height: 9px;
      border: solid ${theme.colors.bgMain};
      border-width: 0 2px 2px 0;
      transform: rotate(45deg);
    }
    .phase-review .prose li:has(> input[type="checkbox"]) {
      list-style-type: none;
      margin-left: -1.5em;
    }
  `,
    [theme]
  );

  // Markdown components
  const markdownComponents = useMemo(
    () => ({
      code: ({ inline, className, children, ...props }: any) => {
        const match = (className || '').match(/language-(\w+)/);
        const language = match ? match[1] : 'text';
        const codeContent = String(children).replace(/\n$/, '');

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
      img: ({ src, alt, ...props }: any) => (
        <MarkdownImage
          src={src}
          alt={alt}
          folderPath={folderPath}
          theme={theme}
          {...props}
        />
      ),
    }),
    [theme, folderPath]
  );

  // Calculate dropdown width based on longest filename
  // Approximate: ~8px per character + padding (40px for icon + padding)
  const longestFilename = useMemo(() => {
    if (documents.length === 0) return '';
    return documents.reduce((longest, doc) =>
      doc.filename.length > longest.length ? doc.filename : longest
    , '');
  }, [documents]);

  // Min 280px, max 500px, scale with filename length
  const dropdownWidth = useMemo(() => {
    const charWidth = 7.5; // approximate px per character in the font
    const padding = 60; // padding + chevron icon space
    const calculatedWidth = longestFilename.length * charWidth + padding;
    return Math.min(500, Math.max(280, calculatedWidth));
  }, [longestFilename]);

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Toolbar row: Document selector + Edit/Preview buttons - centered */}
      <div className="flex items-center justify-center gap-3 mb-2">
        {/* Document selector - width based on longest filename */}
        <div className="min-w-0" style={{ width: dropdownWidth }}>
          <DocumentSelector
            documents={documents}
            selectedIndex={selectedDocIndex}
            onSelect={onDocumentSelect}
            theme={theme}
          />
        </div>

        {/* Edit/Preview toggle */}
        <div className="flex gap-2">
          <button
            onClick={() => !isLocked && onModeChange('edit')}
            disabled={isLocked}
            className={`flex items-center gap-2 px-3 py-1.5 rounded text-xs transition-colors ${
              mode === 'edit' && !isLocked ? 'font-semibold' : ''
            } ${isLocked ? 'opacity-50 cursor-not-allowed' : ''}`}
            style={{
              backgroundColor:
                mode === 'edit' && !isLocked
                  ? theme.colors.bgActivity
                  : 'transparent',
              color: isLocked
                ? theme.colors.textDim
                : mode === 'edit'
                ? theme.colors.textMain
                : theme.colors.textDim,
              border: `1px solid ${
                mode === 'edit' && !isLocked
                  ? theme.colors.accent
                  : theme.colors.border
              }`,
            }}
            title="Edit document (⌘E)"
          >
            <Edit className="w-3.5 h-3.5" />
            Edit
          </button>
          <button
            onClick={() => onModeChange('preview')}
            className={`flex items-center gap-2 px-3 py-1.5 rounded text-xs transition-colors ${
              mode === 'preview' ? 'font-semibold' : ''
            }`}
            style={{
              backgroundColor:
                mode === 'preview' ? theme.colors.bgActivity : 'transparent',
              color:
                mode === 'preview' ? theme.colors.textMain : theme.colors.textDim,
              border: `1px solid ${
                mode === 'preview' ? theme.colors.accent : theme.colors.border
              }`,
            }}
            title="Preview document (⌘E)"
          >
            <Eye className="w-3.5 h-3.5" />
            Preview
          </button>
        </div>
      </div>

      {/* Stats text centered below toolbar */}
      <div className="text-center mb-3">
        <span
          className="text-xs"
          style={{ color: theme.colors.textDim }}
        >
          {statsText}
        </span>
      </div>

      {/* Attached Images Preview (edit mode) */}
      {mode === 'edit' && attachments.length > 0 && (
        <div
          className="px-2 py-2 mb-2 rounded"
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
            Attached Images ({attachments.length})
          </button>
          {attachmentsExpanded && (
            <div className="flex flex-wrap gap-1 mt-2">
              {attachments.map((att) => (
                <ImagePreview
                  key={att.filename}
                  src={att.dataUrl}
                  filename={att.filename}
                  theme={theme}
                  onRemove={() => onRemoveAttachment(att.filename)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Content area - uses flex-1 to fill remaining space */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {mode === 'edit' ? (
          <textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => !isLocked && onContentChange(e.target.value)}
            onKeyDown={!isLocked ? handleKeyDown : undefined}
            onPaste={handlePaste}
            readOnly={isLocked}
            placeholder="Your task document will appear here..."
            className={`w-full h-full border rounded p-4 bg-transparent outline-none resize-none font-mono text-sm overflow-y-auto ${
              isLocked ? 'cursor-not-allowed opacity-70' : ''
            }`}
            style={{
              borderColor: theme.colors.border,
              color: theme.colors.textMain,
            }}
          />
        ) : (
          <div
            ref={previewRef}
            className="phase-review h-full overflow-y-auto border rounded p-4 prose prose-sm max-w-none outline-none"
            tabIndex={0}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'e') {
                e.preventDefault();
                e.stopPropagation();
                onModeChange('edit');
              }
            }}
            style={{
              borderColor: theme.colors.border,
              color: theme.colors.textMain,
              fontSize: '13px',
            }}
          >
            <style>{proseStyles}</style>
            <ReactMarkdown
              remarkPlugins={REMARK_PLUGINS}
              components={markdownComponents}
            >
              {content || '*No content yet.*'}
            </ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Count tasks in markdown content
 */
function countTasks(content: string): number {
  const matches = content.match(/^- \[([ x])\]/gm);
  return matches ? matches.length : 0;
}

/**
 * Main content display after documents are generated
 */
function DocumentReview({
  theme,
  onLaunchSession,
  onWizardComplete,
  wizardStartTime,
}: {
  theme: Theme;
  onLaunchSession: (wantsTour: boolean) => Promise<void>;
  onWizardComplete?: (
    durationMs: number,
    conversationExchanges: number,
    phasesGenerated: number,
    tasksGenerated: number
  ) => void;
  wizardStartTime?: number;
}): JSX.Element {
  const {
    state,
    setEditedPhase1Content,
    getPhase1Content,
    setWantsTour,
    setCurrentDocumentIndex,
  } = useWizard();

  const { generatedDocuments, directoryPath, currentDocumentIndex } = state;
  const currentDoc = generatedDocuments[currentDocumentIndex] || generatedDocuments[0];
  const folderPath = `${directoryPath}/${AUTO_RUN_FOLDER_NAME}`;

  // Local content state for editing - tracks current document
  const [localContent, setLocalContent] = useState(
    currentDocumentIndex === 0 ? getPhase1Content() : currentDoc?.content || ''
  );
  const [mode, setMode] = useState<'edit' | 'preview'>('preview');
  const [attachments, setAttachments] = useState<
    Array<{ filename: string; dataUrl: string }>
  >([]);
  // Track which button is launching: 'ready', 'tour', or null (not launching)
  const [launchingButton, setLaunchingButton] = useState<'ready' | 'tour' | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);

  // Refs for button focus and editor content
  const readyButtonRef = useRef<HTMLButtonElement>(null);
  const tourButtonRef = useRef<HTMLButtonElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  // Auto-save timer ref
  const autoSaveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastSavedContentRef = useRef<string>(localContent);
  const isSavingRef = useRef<boolean>(false);
  const pendingSaveContentRef = useRef<string | null>(null);
  // Track previous document index to detect actual document switches
  const prevDocumentIndexRef = useRef<number>(currentDocumentIndex);

  // Update local content when switching documents
  useEffect(() => {
    const newContent = currentDocumentIndex === 0
      ? getPhase1Content()
      : generatedDocuments[currentDocumentIndex]?.content || '';
    setLocalContent(newContent);
    lastSavedContentRef.current = newContent;
    // Only reset to preview when actually switching documents, not on every effect run
    if (prevDocumentIndexRef.current !== currentDocumentIndex) {
      setMode('preview');
      prevDocumentIndexRef.current = currentDocumentIndex;
    }
  }, [currentDocumentIndex, generatedDocuments, getPhase1Content]);

  // Handle document selection change
  const handleDocumentSelect = useCallback((index: number) => {
    setCurrentDocumentIndex(index);
  }, [setCurrentDocumentIndex]);

  // Auto-focus the ready button on mount
  useEffect(() => {
    setTimeout(() => {
      readyButtonRef.current?.focus();
    }, 100);
  }, []);

  // Auto-save with debounce and locking to prevent race conditions
  useEffect(() => {
    if (localContent === lastSavedContentRef.current) return;

    if (autoSaveTimeoutRef.current) {
      clearTimeout(autoSaveTimeoutRef.current);
    }

    autoSaveTimeoutRef.current = setTimeout(async () => {
      // If already saving, queue this content for after current save completes
      if (isSavingRef.current) {
        pendingSaveContentRef.current = localContent;
        return;
      }

      if (localContent !== lastSavedContentRef.current && currentDoc) {
        isSavingRef.current = true;
        try {
          await window.maestro.autorun.writeDoc(
            folderPath,
            currentDoc.filename,
            localContent
          );
          lastSavedContentRef.current = localContent;
          // Only update Phase 1 edited content for first document
          if (currentDocumentIndex === 0) {
            setEditedPhase1Content(localContent);
          }
        } catch (err) {
          console.error('Auto-save failed:', err);
        } finally {
          isSavingRef.current = false;

          // Check if there's pending content to save
          if (
            pendingSaveContentRef.current !== null &&
            pendingSaveContentRef.current !== lastSavedContentRef.current
          ) {
            const pendingContent = pendingSaveContentRef.current;
            pendingSaveContentRef.current = null;
            // Trigger another save for pending content
            try {
              isSavingRef.current = true;
              await window.maestro.autorun.writeDoc(
                folderPath,
                currentDoc.filename,
                pendingContent
              );
              lastSavedContentRef.current = pendingContent;
              if (currentDocumentIndex === 0) {
                setEditedPhase1Content(pendingContent);
              }
            } catch (err) {
              console.error('Auto-save (pending) failed:', err);
            } finally {
              isSavingRef.current = false;
            }
          }
        }
      }
    }, AUTO_SAVE_DELAY);

    return () => {
      if (autoSaveTimeoutRef.current) {
        clearTimeout(autoSaveTimeoutRef.current);
      }
    };
  }, [localContent, folderPath, currentDoc, currentDocumentIndex, setEditedPhase1Content]);

  // Handle content change
  const handleContentChange = useCallback((newContent: string) => {
    setLocalContent(newContent);
  }, []);

  // Handle mode change with focus management
  const handleModeChange = useCallback((newMode: 'edit' | 'preview') => {
    setMode(newMode);
    // Focus the appropriate element after mode change
    setTimeout(() => {
      if (newMode === 'edit') {
        textareaRef.current?.focus();
      } else {
        previewRef.current?.focus();
      }
    }, 50);
  }, []);

  // Handle adding attachment
  const handleAddAttachment = useCallback(
    (filename: string, dataUrl: string) => {
      setAttachments((prev) => [...prev, { filename, dataUrl }]);
    },
    []
  );

  // Handle removing attachment
  const handleRemoveAttachment = useCallback(
    async (filename: string) => {
      setAttachments((prev) => prev.filter((a) => a.filename !== filename));

      // Remove from disk
      await window.maestro.autorun.deleteImage(folderPath, filename);

      // Remove markdown reference
      const escapedPath = filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const fname = filename.split('/').pop() || filename;
      const escapedFilename = fname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(
        `!\\[${escapedFilename}\\]\\(${escapedPath}\\)\\n?`,
        'g'
      );
      setLocalContent((prev) => prev.replace(regex, ''));
    },
    [folderPath]
  );

  // Handle launch
  const handleLaunch = useCallback(
    async (wantsTour: boolean) => {
      setLaunchingButton(wantsTour ? 'tour' : 'ready');
      setLaunchError(null);
      setWantsTour(wantsTour);

      try {
        // Save final content before launching
        if (currentDoc && localContent !== lastSavedContentRef.current) {
          await window.maestro.autorun.writeDoc(
            folderPath,
            currentDoc.filename,
            localContent
          );
          if (currentDocumentIndex === 0) {
            setEditedPhase1Content(localContent);
          }
        }

        // Record wizard completion for analytics
        if (onWizardComplete) {
          // Calculate wizard duration
          const durationMs = wizardStartTime
            ? Date.now() - wizardStartTime
            : 0;

          // Count conversation exchanges (user messages in the conversation)
          const conversationExchanges = state.conversationHistory.filter(
            (msg) => msg.role === 'user'
          ).length;

          // Count phases and tasks generated
          const phasesGenerated = generatedDocuments.length;
          const tasksGenerated = generatedDocuments.reduce(
            (total, doc) => total + countTasks(doc.content),
            0
          );

          onWizardComplete(
            durationMs,
            conversationExchanges,
            phasesGenerated,
            tasksGenerated
          );
        }

        await onLaunchSession(wantsTour);
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : 'Failed to launch session';
        setLaunchError(errorMessage);
        setLaunchingButton(null);
      }
    },
    [
      currentDoc,
      currentDocumentIndex,
      localContent,
      folderPath,
      setEditedPhase1Content,
      setWantsTour,
      onLaunchSession,
      onWizardComplete,
      wizardStartTime,
      state.conversationHistory,
      generatedDocuments,
    ]
  );

  // Handle keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Global ⌘E to toggle edit/preview mode
      if ((e.metaKey || e.ctrlKey) && e.key === 'e') {
        e.preventDefault();
        e.stopPropagation();
        handleModeChange(mode === 'edit' ? 'preview' : 'edit');
        return;
      }

      // Tab between buttons
      if (e.key === 'Tab') {
        const focusedElement = document.activeElement;
        if (focusedElement === readyButtonRef.current && !e.shiftKey) {
          e.preventDefault();
          tourButtonRef.current?.focus();
        } else if (focusedElement === tourButtonRef.current && e.shiftKey) {
          e.preventDefault();
          readyButtonRef.current?.focus();
        }
      }
      // Enter to activate focused button
      if (e.key === 'Enter' && !launchingButton) {
        const focusedElement = document.activeElement;
        if (focusedElement === readyButtonRef.current) {
          handleLaunch(false);
        } else if (focusedElement === tourButtonRef.current) {
          handleLaunch(true);
        }
      }
    },
    [handleLaunch, handleModeChange, launchingButton, mode]
  );

  // Task count
  const taskCount = countTasks(localContent);
  const totalTasks = generatedDocuments.reduce(
    (sum, doc) => sum + doc.taskCount,
    0
  );

  if (!currentDoc) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p style={{ color: theme.colors.textDim }}>No documents generated</p>
      </div>
    );
  }

  // Build stats text
  const statsText = generatedDocuments.length > 1
    ? `${totalTasks} total tasks • ${generatedDocuments.length} documents • ${taskCount} tasks in this document`
    : `${taskCount} tasks ready to run`;

  return (
    <div
      ref={containerRef}
      className="flex flex-col flex-1 min-h-0 outline-none"
      tabIndex={-1}
      onKeyDown={handleKeyDown}
    >
      {/* Document editor - flex to fill available space */}
      <div className="flex-1 min-h-0 flex flex-col px-6 py-4">
        <DocumentEditor
          content={localContent}
          onContentChange={handleContentChange}
          mode={mode}
          onModeChange={handleModeChange}
          folderPath={folderPath}
          selectedFile={currentDoc.filename.replace(/\.md$/, '')}
          attachments={attachments}
          onAddAttachment={handleAddAttachment}
          onRemoveAttachment={handleRemoveAttachment}
          theme={theme}
          isLocked={launchingButton !== null}
          textareaRef={textareaRef}
          previewRef={previewRef}
          documents={generatedDocuments}
          selectedDocIndex={currentDocumentIndex}
          onDocumentSelect={handleDocumentSelect}
          statsText={statsText}
        />
      </div>

      {/* Error message */}
      {launchError && (
        <div
          className="mx-6 mb-2 px-4 py-2 rounded-lg flex items-center gap-2"
          style={{
            backgroundColor: `${theme.colors.error}20`,
            borderColor: theme.colors.error,
            border: '1px solid',
          }}
        >
          <svg
            className="w-4 h-4 shrink-0"
            fill="none"
            stroke={theme.colors.error}
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
          <span className="text-sm" style={{ color: theme.colors.error }}>
            {launchError}
          </span>
          <button
            onClick={() => setLaunchError(null)}
            className="ml-auto p-1 hover:opacity-80"
            style={{ color: theme.colors.error }}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Action buttons */}
      <div
        className="px-6 py-4 border-t"
        style={{
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.bgSidebar,
        }}
      >
        <div className="flex flex-col sm:flex-row gap-3">
          {/* Primary button - Ready to Go */}
          <button
            ref={readyButtonRef}
            onClick={() => handleLaunch(false)}
            disabled={launchingButton !== null}
            className={`flex-1 flex items-center justify-center gap-2 px-6 py-3.5 rounded-lg font-semibold text-base transition-all ${
              launchingButton !== null ? 'opacity-70 cursor-not-allowed' : 'hover:scale-[1.02]'
            }`}
            style={{
              backgroundColor: theme.colors.accent,
              color: theme.colors.accentForeground,
              boxShadow: `0 4px 14px ${theme.colors.accent}40`,
            }}
          >
            {launchingButton === 'ready' ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <Rocket className="w-5 h-5" />
            )}
            {launchingButton === 'ready' ? 'Launching...' : "I'm Ready to Go"}
          </button>

          {/* Secondary button - Walk Me Through */}
          <button
            ref={tourButtonRef}
            onClick={() => handleLaunch(true)}
            disabled={launchingButton !== null}
            className={`flex-1 flex items-center justify-center gap-2 px-6 py-3.5 rounded-lg font-medium text-base transition-all ${
              launchingButton !== null ? 'opacity-70 cursor-not-allowed' : 'hover:scale-[1.02]'
            }`}
            style={{
              backgroundColor: theme.colors.bgActivity,
              color: theme.colors.textMain,
              border: `2px solid ${theme.colors.border}`,
            }}
          >
            {launchingButton === 'tour' ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <Compass className="w-5 h-5" />
            )}
            {launchingButton === 'tour' ? 'Launching...' : "Walk Me Through the Interface"}
          </button>
        </div>

        {/* Keyboard hints */}
        <div className="mt-4 flex justify-center gap-6">
          <span
            className="text-xs flex items-center gap-1"
            style={{ color: theme.colors.textDim }}
          >
            <kbd
              className="px-1.5 py-0.5 rounded text-xs"
              style={{ backgroundColor: theme.colors.border }}
            >
              ⌘E
            </kbd>
            Toggle Edit/Preview
          </span>
          <span
            className="text-xs flex items-center gap-1"
            style={{ color: theme.colors.textDim }}
          >
            <kbd
              className="px-1.5 py-0.5 rounded text-xs"
              style={{ backgroundColor: theme.colors.border }}
            >
              Tab
            </kbd>
            Switch buttons
          </span>
          <span
            className="text-xs flex items-center gap-1"
            style={{ color: theme.colors.textDim }}
          >
            <kbd
              className="px-1.5 py-0.5 rounded text-xs"
              style={{ backgroundColor: theme.colors.border }}
            >
              Enter
            </kbd>
            Select
          </span>
          <span
            className="text-xs flex items-center gap-1"
            style={{ color: theme.colors.textDim }}
          >
            <kbd
              className="px-1.5 py-0.5 rounded text-xs"
              style={{ backgroundColor: theme.colors.border }}
            >
              Esc
            </kbd>
            Go back
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * PhaseReviewScreen - Document review and launch
 *
 * This screen handles:
 * 1. Displaying and editing generated documents
 * 2. Document selector for switching between documents
 * 3. Launching session with or without tour
 *
 * Note: Document generation is handled by PreparingPlanScreen (step 4)
 */
export function PhaseReviewScreen({
  theme,
  onLaunchSession,
  onWizardComplete,
  wizardStartTime,
}: PhaseReviewScreenProps): JSX.Element {
  const { state, previousStep } = useWizard();

  // Screen reader announcement state
  const [announcement, setAnnouncement] = useState('');
  const [announcementKey, setAnnouncementKey] = useState(0);

  // Announce when documents are ready
  useEffect(() => {
    if (state.generatedDocuments.length > 0) {
      const totalTasks = state.generatedDocuments.reduce(
        (sum, doc) => sum + doc.taskCount,
        0
      );
      setAnnouncement(
        `${state.generatedDocuments.length} action plans ready with ${totalTasks} tasks total. Review and edit your plans, then choose how to proceed.`
      );
      setAnnouncementKey((prev) => prev + 1);
    }
  }, [state.generatedDocuments]);

  const announcementElement = (
    <ScreenReaderAnnouncement
      message={announcement}
      announceKey={announcementKey}
      politeness="polite"
    />
  );

  // If no documents, go back to preparing step
  if (state.generatedDocuments.length === 0) {
    previousStep();
    return (
      <div className="flex-1 flex items-center justify-center">
        <p style={{ color: theme.colors.textDim }}>Redirecting...</p>
      </div>
    );
  }

  return (
    <>
      {announcementElement}
      <DocumentReview
        theme={theme}
        onLaunchSession={onLaunchSession}
        onWizardComplete={onWizardComplete}
        wizardStartTime={wizardStartTime}
      />
    </>
  );
}
