import React, { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Eye, Edit } from 'lucide-react';

interface ScratchpadProps {
  content: string;
  onChange: (content: string) => void;
  theme: any;
  initialMode?: 'edit' | 'preview';
  initialCursorPosition?: number;
  initialEditScrollPos?: number;
  initialPreviewScrollPos?: number;
  onStateChange?: (state: {
    mode: 'edit' | 'preview';
    cursorPosition: number;
    editScrollPos: number;
    previewScrollPos: number;
  }) => void;
}

export function Scratchpad({
  content,
  onChange,
  theme,
  initialMode = 'edit',
  initialCursorPosition = 0,
  initialEditScrollPos = 0,
  initialPreviewScrollPos = 0,
  onStateChange
}: ScratchpadProps) {
  const [mode, setMode] = useState<'edit' | 'preview'>(initialMode);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

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

  // Notify parent when mode changes
  const toggleMode = () => {
    const newMode = mode === 'edit' ? 'preview' : 'edit';
    setMode(newMode);

    if (onStateChange) {
      onStateChange({
        mode: newMode,
        cursorPosition: textareaRef.current?.selectionStart || 0,
        editScrollPos: textareaRef.current?.scrollTop || 0,
        previewScrollPos: previewRef.current?.scrollTop || 0
      });
    }
  };

  // Auto-focus the active element after mode change
  useEffect(() => {
    if (mode === 'edit' && textareaRef.current) {
      textareaRef.current.focus();
    } else if (mode === 'preview' && previewRef.current) {
      previewRef.current.focus();
    }
  }, [mode]);

  // Save cursor position and scroll position when they change
  const handleCursorOrScrollChange = () => {
    if (onStateChange && textareaRef.current) {
      onStateChange({
        mode,
        cursorPosition: textareaRef.current.selectionStart,
        editScrollPos: textareaRef.current.scrollTop,
        previewScrollPos: previewRef.current?.scrollTop || 0
      });
    }
  };

  const handlePreviewScroll = () => {
    if (onStateChange && previewRef.current) {
      onStateChange({
        mode,
        cursorPosition: textareaRef.current?.selectionStart || 0,
        editScrollPos: textareaRef.current?.scrollTop || 0,
        previewScrollPos: previewRef.current.scrollTop
      });
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Command-E to toggle between edit and preview
    if ((e.metaKey || e.ctrlKey) && e.key === 'e') {
      e.preventDefault();
      e.stopPropagation();
      toggleMode();
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      const textarea = e.currentTarget;
      const cursorPos = textarea.selectionStart;
      const textBeforeCursor = content.substring(0, cursorPos);
      const textAfterCursor = content.substring(cursorPos);
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
        const newContent = textBeforeCursor + '\n' + indent + '- [ ] ' + textAfterCursor;
        onChange(newContent);
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
        const newContent = textBeforeCursor + '\n' + indent + marker + ' ' + textAfterCursor;
        onChange(newContent);
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
        const newContent = textBeforeCursor + '\n' + indent + (num + 1) + '. ' + textAfterCursor;
        onChange(newContent);
        setTimeout(() => {
          if (textareaRef.current) {
            const newPos = cursorPos + indent.length + (num + 1).toString().length + 3; // "\n" + indent + num + ". "
            textareaRef.current.setSelectionRange(newPos, newPos);
          }
        }, 0);
      }
    }
  };

  return (
    <div
      ref={containerRef}
      className="h-full flex flex-col outline-none"
      tabIndex={-1}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'e') {
          e.preventDefault();
          toggleMode();
        }
      }}
    >
      {/* Mode Toggle */}
      <div className="flex gap-2 mb-3 justify-center pt-2">
        <button
          onClick={() => setMode('edit')}
          className={`flex items-center gap-2 px-3 py-1.5 rounded text-xs transition-colors ${
            mode === 'edit' ? 'font-semibold' : ''
          }`}
          style={{
            backgroundColor: mode === 'edit' ? theme.colors.bgActivity : 'transparent',
            color: mode === 'edit' ? theme.colors.textMain : theme.colors.textDim,
            border: `1px solid ${mode === 'edit' ? theme.colors.accent : theme.colors.border}`
          }}
        >
          <Edit className="w-3.5 h-3.5" />
          Edit
        </button>
        <button
          onClick={() => setMode('preview')}
          className={`flex items-center gap-2 px-3 py-1.5 rounded text-xs transition-colors ${
            mode === 'preview' ? 'font-semibold' : ''
          }`}
          style={{
            backgroundColor: mode === 'preview' ? theme.colors.bgActivity : 'transparent',
            color: mode === 'preview' ? theme.colors.textMain : theme.colors.textDim,
            border: `1px solid ${mode === 'preview' ? theme.colors.accent : theme.colors.border}`
          }}
        >
          <Eye className="w-3.5 h-3.5" />
          Preview
        </button>
      </div>

      {/* Content Area */}
      <div className="flex-1 overflow-hidden">
        {mode === 'edit' ? (
          <textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onKeyUp={handleCursorOrScrollChange}
            onClick={handleCursorOrScrollChange}
            onScroll={handleCursorOrScrollChange}
            placeholder="Write your notes in markdown..."
            className="w-full h-full border rounded p-4 bg-transparent outline-none resize-none font-mono text-sm"
            style={{
              borderColor: theme.colors.border,
              color: theme.colors.textMain
            }}
          />
        ) : (
          <div
            ref={previewRef}
            className="h-full border rounded p-4 overflow-y-auto prose prose-sm max-w-none outline-none"
            tabIndex={0}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'e') {
                e.preventDefault();
                e.stopPropagation();
                toggleMode();
              }
            }}
            onScroll={handlePreviewScroll}
            style={{
              borderColor: theme.colors.border,
              color: theme.colors.textMain
            }}
          >
            <style>{`
              .prose h1 { color: ${theme.colors.textMain}; font-size: 2em; font-weight: bold; margin: 0.67em 0; }
              .prose h2 { color: ${theme.colors.textMain}; font-size: 1.5em; font-weight: bold; margin: 0.75em 0; }
              .prose h3 { color: ${theme.colors.textMain}; font-size: 1.17em; font-weight: bold; margin: 0.83em 0; }
              .prose h4 { color: ${theme.colors.textMain}; font-size: 1em; font-weight: bold; margin: 1em 0; }
              .prose h5 { color: ${theme.colors.textMain}; font-size: 0.83em; font-weight: bold; margin: 1.17em 0; }
              .prose h6 { color: ${theme.colors.textMain}; font-size: 0.67em; font-weight: bold; margin: 1.33em 0; }
              .prose p { color: ${theme.colors.textMain}; margin: 0.5em 0; }
              .prose ul, .prose ol { color: ${theme.colors.textMain}; margin: 0.5em 0; padding-left: 1.5em; }
              .prose li { margin: 0.25em 0; }
              .prose code { background-color: ${theme.colors.bgActivity}; color: ${theme.colors.textMain}; padding: 0.2em 0.4em; border-radius: 3px; font-size: 0.9em; }
              .prose pre { background-color: ${theme.colors.bgActivity}; color: ${theme.colors.textMain}; padding: 1em; border-radius: 6px; overflow-x: auto; }
              .prose pre code { background: none; padding: 0; }
              .prose blockquote { border-left: 4px solid ${theme.colors.border}; padding-left: 1em; margin: 0.5em 0; color: ${theme.colors.textDim}; }
              .prose a { color: ${theme.colors.accent}; text-decoration: underline; }
              .prose hr { border: none; border-top: 2px solid ${theme.colors.border}; margin: 1em 0; }
              .prose table { border-collapse: collapse; width: 100%; margin: 0.5em 0; }
              .prose th, .prose td { border: 1px solid ${theme.colors.border}; padding: 0.5em; text-align: left; }
              .prose th { background-color: ${theme.colors.bgActivity}; font-weight: bold; }
              .prose strong { font-weight: bold; }
              .prose em { font-style: italic; }
            `}</style>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {content || '*No content yet. Switch to Edit mode to start writing.*'}
            </ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}
