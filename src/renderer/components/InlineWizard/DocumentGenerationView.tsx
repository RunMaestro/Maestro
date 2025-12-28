/**
 * DocumentGenerationView.tsx
 *
 * The main takeover component for document generation in the inline wizard.
 * Takes over the AI terminal area (not a modal) when confidence reaches threshold
 * and user proceeds. Displays:
 * - Document selector dropdown at top
 * - Main content area showing streaming preview or final document
 * - Austin facts rotating in corner during generation
 * - Completion overlay with confetti when generation finishes
 *
 * This component is extracted/shared with PhaseReviewScreen.tsx to maintain consistency.
 */

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import {
  Eye,
  Edit,
  ChevronDown,
  ChevronRight,
  X,
  Loader2,
} from 'lucide-react';
import type { Theme } from '../../types';
import type { GeneratedDocument } from '../Wizard/WizardContext';
import { MermaidRenderer } from '../MermaidRenderer';
import { useClickOutside } from '../../hooks';
import { AustinFactsDisplay } from './AustinFactsDisplay';
import { StreamingDocumentPreview } from './StreamingDocumentPreview';

// Memoize remarkPlugins array - it never changes
const REMARK_PLUGINS = [remarkGfm];

// Auto-save debounce delay in milliseconds
const AUTO_SAVE_DELAY = 2000;

/**
 * Props for DocumentGenerationView
 */
export interface DocumentGenerationViewProps {
  /** Theme for styling */
  theme: Theme;
  /** Array of generated documents */
  documents: GeneratedDocument[];
  /** Index of the currently selected document */
  currentDocumentIndex: number;
  /** Whether documents are still being generated */
  isGenerating: boolean;
  /** Streaming content being generated (shown during generation) */
  streamingContent?: string;
  /** Called when generation completes and user clicks Done */
  onComplete: () => void;
  /** Called when user selects a different document */
  onDocumentSelect: (index: number) => void;
  /** Folder path for Auto Run docs */
  folderPath?: string;
  /** Called when document content changes (for editing) */
  onContentChange?: (content: string, docIndex: number) => void;
  /** Progress message to show during generation */
  progressMessage?: string;
  /** Current document being generated (for progress indicator) */
  currentGeneratingIndex?: number;
  /** Total number of documents to generate (for progress indicator) */
  totalDocuments?: number;
}

/**
 * Document selector dropdown for switching between generated documents
 */
function DocumentSelector({
  documents,
  selectedIndex,
  onSelect,
  theme,
  disabled,
}: {
  documents: GeneratedDocument[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  theme: Theme;
  disabled?: boolean;
}): JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Close dropdown when clicking outside
  useClickOutside(dropdownRef, () => setIsOpen(false), isOpen);

  // Close dropdown on Escape
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
      document.addEventListener('keydown', handleKeyDown, true);
      return () => document.removeEventListener('keydown', handleKeyDown, true);
    }
  }, [isOpen]);

  const selectedDoc = documents[selectedIndex];

  return (
    <div ref={dropdownRef} className="relative flex-1 min-w-0">
      <button
        ref={buttonRef}
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
        className={`w-full min-w-0 flex items-center justify-between px-3 py-2 rounded text-sm transition-colors ${
          disabled ? 'opacity-50 cursor-not-allowed' : 'hover:opacity-90'
        }`}
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
      {isOpen && !disabled && (
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
                <div className="flex items-center justify-between">
                  <span>{doc.filename}</span>
                  {doc.taskCount > 0 && (
                    <span
                      className="text-xs px-1.5 py-0.5 rounded"
                      style={{
                        backgroundColor: `${theme.colors.accent}20`,
                        color: theme.colors.accent,
                      }}
                    >
                      {doc.taskCount} tasks
                    </span>
                  )}
                </div>
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
  folderPath?: string;
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
 * GenerationCompleteOverlay - Shown when document generation finishes
 */
export function GenerationCompleteOverlay({
  theme,
  taskCount,
  onDone,
}: {
  theme: Theme;
  taskCount: number;
  onDone: () => void;
}): JSX.Element {
  return (
    <div
      className="absolute inset-0 flex flex-col items-center justify-center"
      style={{
        backgroundColor: `${theme.colors.bgMain}E6`,
        backdropFilter: 'blur(4px)',
      }}
    >
      {/* Celebratory header */}
      <div className="text-center mb-6">
        <h2
          className="text-2xl font-bold mb-2"
          style={{ color: theme.colors.textMain }}
        >
          Your action plan is ready!
        </h2>
        <p
          className="text-sm"
          style={{ color: theme.colors.textDim }}
        >
          {taskCount} {taskCount === 1 ? 'task' : 'tasks'} prepared and ready to run
        </p>
      </div>

      {/* Done button */}
      <button
        onClick={onDone}
        className="px-8 py-3 rounded-lg font-semibold text-lg transition-all hover:scale-105"
        style={{
          backgroundColor: theme.colors.accent,
          color: theme.colors.accentForeground,
          boxShadow: `0 4px 14px ${theme.colors.accent}40`,
        }}
      >
        Done
      </button>
    </div>
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
}: {
  content: string;
  onContentChange: (content: string) => void;
  mode: 'edit' | 'preview';
  onModeChange: (mode: 'edit' | 'preview') => void;
  folderPath?: string;
  selectedFile?: string;
  attachments: Array<{ filename: string; dataUrl: string }>;
  onAddAttachment: (filename: string, dataUrl: string) => void;
  onRemoveAttachment: (filename: string) => void;
  theme: Theme;
  isLocked: boolean;
  textareaRef: React.RefObject<HTMLTextAreaElement>;
  previewRef: React.RefObject<HTMLDivElement>;
}): JSX.Element {
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
    [content, folderPath, selectedFile, isLocked, onContentChange, onAddAttachment, textareaRef]
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

  // Prose styles for markdown preview
  const proseStyles = useMemo(
    () => `
    .doc-gen-view .prose h1 { color: ${theme.colors.textMain}; font-size: 2em; font-weight: bold; margin: 0.67em 0; }
    .doc-gen-view .prose h2 { color: ${theme.colors.textMain}; font-size: 1.5em; font-weight: bold; margin: 0.75em 0; }
    .doc-gen-view .prose h3 { color: ${theme.colors.textMain}; font-size: 1.17em; font-weight: bold; margin: 0.83em 0; }
    .doc-gen-view .prose p { color: ${theme.colors.textMain}; margin: 0.5em 0; }
    .doc-gen-view .prose ul, .doc-gen-view .prose ol { color: ${theme.colors.textMain}; margin: 0.5em 0; padding-left: 1.5em; }
    .doc-gen-view .prose ul { list-style-type: disc; }
    .doc-gen-view .prose li { margin: 0.25em 0; display: list-item; }
    .doc-gen-view .prose code { background-color: ${theme.colors.bgActivity}; color: ${theme.colors.textMain}; padding: 0.2em 0.4em; border-radius: 3px; font-size: 0.9em; }
    .doc-gen-view .prose pre { background-color: ${theme.colors.bgActivity}; color: ${theme.colors.textMain}; padding: 1em; border-radius: 6px; overflow-x: auto; }
    .doc-gen-view .prose pre code { background: none; padding: 0; }
    .doc-gen-view .prose blockquote { border-left: 4px solid ${theme.colors.border}; padding-left: 1em; margin: 0.5em 0; color: ${theme.colors.textDim}; }
    .doc-gen-view .prose a { color: ${theme.colors.accent}; text-decoration: underline; }
    .doc-gen-view .prose strong { font-weight: bold; }
    .doc-gen-view .prose em { font-style: italic; }
    .doc-gen-view .prose input[type="checkbox"] {
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
    .doc-gen-view .prose input[type="checkbox"]:checked {
      background-color: ${theme.colors.accent};
      border-color: ${theme.colors.accent};
    }
    .doc-gen-view .prose input[type="checkbox"]:checked::after {
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
    .doc-gen-view .prose li:has(> input[type="checkbox"]) {
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
      a: ({ href, children }: any) => (
        <a
          href={href}
          onClick={(e) => {
            e.preventDefault();
            if (href) window.maestro.shell.openExternal(href);
          }}
          style={{ color: theme.colors.accent, textDecoration: 'underline', cursor: 'pointer' }}
        >
          {children}
        </a>
      ),
    }),
    [theme, folderPath]
  );

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Toolbar row: Edit/Preview buttons */}
      <div className="flex items-center justify-center gap-2 mb-3">
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

      {/* Content area */}
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
            className="doc-gen-view h-full overflow-y-auto border rounded p-4 prose prose-sm max-w-none outline-none"
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
 * DocumentGenerationView - Main component for document generation takeover
 */
export function DocumentGenerationView({
  theme,
  documents,
  currentDocumentIndex,
  isGenerating,
  streamingContent,
  onComplete,
  onDocumentSelect,
  folderPath,
  onContentChange,
  progressMessage,
  currentGeneratingIndex,
  totalDocuments,
}: DocumentGenerationViewProps): JSX.Element {
  const currentDoc = documents[currentDocumentIndex];
  const [localContent, setLocalContent] = useState(currentDoc?.content || '');
  const [mode, setMode] = useState<'edit' | 'preview'>('preview');
  const [attachments, setAttachments] = useState<
    Array<{ filename: string; dataUrl: string }>
  >([]);
  const [showCompletion, setShowCompletion] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const autoSaveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastSavedContentRef = useRef<string>(localContent);

  // Update local content when document changes
  useEffect(() => {
    if (currentDoc) {
      setLocalContent(currentDoc.content);
      lastSavedContentRef.current = currentDoc.content;
    }
  }, [currentDoc]);

  // Show completion overlay when generation finishes
  useEffect(() => {
    if (!isGenerating && documents.length > 0 && streamingContent === undefined) {
      // Small delay to allow final content to settle
      const timer = setTimeout(() => {
        setShowCompletion(true);
      }, 500);
      return () => clearTimeout(timer);
    } else {
      setShowCompletion(false);
    }
  }, [isGenerating, documents.length, streamingContent]);

  // Auto-save with debounce
  useEffect(() => {
    if (isGenerating || localContent === lastSavedContentRef.current) return;

    if (autoSaveTimeoutRef.current) {
      clearTimeout(autoSaveTimeoutRef.current);
    }

    autoSaveTimeoutRef.current = setTimeout(async () => {
      if (localContent !== lastSavedContentRef.current && currentDoc && folderPath && onContentChange) {
        try {
          await window.maestro.autorun.writeDoc(
            folderPath,
            currentDoc.filename,
            localContent
          );
          lastSavedContentRef.current = localContent;
          onContentChange(localContent, currentDocumentIndex);
        } catch (err) {
          console.error('Auto-save failed:', err);
        }
      }
    }, AUTO_SAVE_DELAY);

    return () => {
      if (autoSaveTimeoutRef.current) {
        clearTimeout(autoSaveTimeoutRef.current);
      }
    };
  }, [localContent, folderPath, currentDoc, currentDocumentIndex, isGenerating, onContentChange]);

  // Handle content change
  const handleContentChange = useCallback((newContent: string) => {
    setLocalContent(newContent);
  }, []);

  // Handle mode change
  const handleModeChange = useCallback((newMode: 'edit' | 'preview') => {
    setMode(newMode);
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

      if (folderPath) {
        await window.maestro.autorun.deleteImage(folderPath, filename);
      }

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

  // Calculate total tasks
  const totalTasks = documents.reduce(
    (sum, doc) => sum + countTasks(doc.content),
    0
  );

  // If generating, show streaming preview
  if (isGenerating && streamingContent !== undefined) {
    return (
      <div
        className="relative flex flex-col h-full"
        style={{ backgroundColor: theme.colors.bgMain }}
      >
        <StreamingDocumentPreview
          theme={theme}
          content={streamingContent}
          filename={progressMessage}
          currentPhase={currentGeneratingIndex}
          totalPhases={totalDocuments}
        />
        <AustinFactsDisplay theme={theme} isVisible={isGenerating} />
      </div>
    );
  }

  // If no documents yet, show loading state
  if (documents.length === 0) {
    return (
      <div
        className="relative flex items-center justify-center h-full"
        style={{ backgroundColor: theme.colors.bgMain }}
      >
        <div className="text-center">
          <Loader2
            className="w-8 h-8 animate-spin mx-auto mb-4"
            style={{ color: theme.colors.accent }}
          />
          <p style={{ color: theme.colors.textDim }}>
            {progressMessage || 'Preparing documents...'}
          </p>
        </div>
        <AustinFactsDisplay theme={theme} isVisible={true} />
      </div>
    );
  }

  // Calculate dropdown width based on longest filename
  const longestFilename = documents.reduce(
    (longest, doc) =>
      doc.filename.length > longest.length ? doc.filename : longest,
    ''
  );
  const charWidth = 7.5;
  const padding = 60;
  const dropdownWidth = Math.min(500, Math.max(280, longestFilename.length * charWidth + padding));

  // Show document editor/viewer
  return (
    <div
      className="relative flex flex-col h-full"
      style={{ backgroundColor: theme.colors.bgMain }}
    >
      {/* Header with document selector */}
      <div
        className="flex items-center justify-center px-4 py-3 border-b"
        style={{
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.bgSidebar,
        }}
      >
        <div style={{ width: dropdownWidth }}>
          <DocumentSelector
            documents={documents}
            selectedIndex={currentDocumentIndex}
            onSelect={onDocumentSelect}
            theme={theme}
            disabled={isGenerating}
          />
        </div>
      </div>

      {/* Stats row */}
      <div className="text-center py-2">
        <span className="text-xs" style={{ color: theme.colors.textDim }}>
          {documents.length > 1
            ? `${totalTasks} total tasks • ${documents.length} documents • ${countTasks(localContent)} tasks in this document`
            : `${totalTasks} tasks ready to run`}
        </span>
      </div>

      {/* Document content */}
      <div className="flex-1 min-h-0 px-4 pb-4">
        <DocumentEditor
          content={localContent}
          onContentChange={handleContentChange}
          mode={mode}
          onModeChange={handleModeChange}
          folderPath={folderPath}
          selectedFile={currentDoc?.filename.replace(/\.md$/, '')}
          attachments={attachments}
          onAddAttachment={handleAddAttachment}
          onRemoveAttachment={handleRemoveAttachment}
          theme={theme}
          isLocked={isGenerating}
          textareaRef={textareaRef}
          previewRef={previewRef}
        />
      </div>

      {/* Austin facts (shown during generation) */}
      <AustinFactsDisplay theme={theme} isVisible={isGenerating} />

      {/* Completion overlay */}
      {showCompletion && (
        <GenerationCompleteOverlay
          theme={theme}
          taskCount={totalTasks}
          onDone={onComplete}
        />
      )}
    </div>
  );
}

// Export individual components for reuse
export { DocumentSelector, DocumentEditor };

// Re-export standalone components from their files
export { AustinFactsDisplay } from './AustinFactsDisplay';
export { StreamingDocumentPreview } from './StreamingDocumentPreview';
