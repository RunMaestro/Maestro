import React, { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { FileCode, X, Copy, FileText, Eye } from 'lucide-react';

interface FilePreviewProps {
  file: { name: string; content: string; path: string } | null;
  onClose: () => void;
  theme: any;
  markdownRawMode: boolean;
  setMarkdownRawMode: (value: boolean) => void;
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

// Check if file is an image
const isImageFile = (filename: string): boolean => {
  const ext = filename.split('.').pop()?.toLowerCase();
  const imageExtensions = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico'];
  return imageExtensions.includes(ext || '');
};

export function FilePreview({ file, onClose, theme, markdownRawMode, setMarkdownRawMode }: FilePreviewProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [showCopyNotification, setShowCopyNotification] = useState(false);
  const [hoveredLink, setHoveredLink] = useState<{ url: string; x: number; y: number } | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  if (!file) return null;

  const language = getLanguageFromFilename(file.name);
  const isMarkdown = language === 'markdown';
  const isImage = isImageFile(file.name);

  // Extract directory path without filename
  const directoryPath = file.path.substring(0, file.path.lastIndexOf('/'));

  // Keep search input focused when search is open
  useEffect(() => {
    if (searchOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [searchOpen, searchQuery]);

  const copyPathToClipboard = () => {
    navigator.clipboard.writeText(file.path);
    setShowCopyNotification(true);
    setTimeout(() => setShowCopyNotification(false), 2000);
  };

  // Highlight search matches in content
  const highlightMatches = (content: string): string => {
    if (!searchQuery.trim()) return content;

    const regex = new RegExp(`(${searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    return content.replace(regex, '<mark style="background-color: #ffd700; color: #000;">$1</mark>');
  };

  // Handle keyboard events
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === '/' && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      e.stopPropagation();
      setSearchOpen(true);
      setTimeout(() => searchInputRef.current?.focus(), 0);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (searchOpen) {
        setSearchOpen(false);
        setSearchQuery('');
      } else {
        onClose();
      }
    }
  };

  return (
    <div
      className="absolute inset-0 flex flex-col outline-none"
      style={{ backgroundColor: theme.colors.bgMain, zIndex: 5 }}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      ref={(el) => el?.focus()}
    >
      {/* Header */}
      <div className="h-16 border-b flex items-center justify-between px-6 shrink-0" style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }}>
        <div className="flex items-center gap-2">
          <FileCode className="w-4 h-4" style={{ color: theme.colors.accent }} />
          <div>
            <div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>{file.name}</div>
            <div className="text-xs opacity-50" style={{ color: theme.colors.textDim }}>{directoryPath}</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isMarkdown && (
            <button
              onClick={() => setMarkdownRawMode(!markdownRawMode)}
              className="p-2 rounded hover:bg-white/10 transition-colors"
              style={{ color: markdownRawMode ? theme.colors.accent : theme.colors.textDim }}
              title={markdownRawMode ? "Show rendered markdown" : "Show raw markdown"}
            >
              {markdownRawMode ? <Eye className="w-4 h-4" /> : <FileText className="w-4 h-4" />}
            </button>
          )}
          <button
            onClick={copyPathToClipboard}
            className="p-2 rounded hover:bg-white/10 transition-colors"
            style={{ color: theme.colors.textDim }}
            title="Copy full path to clipboard"
          >
            <Copy className="w-4 h-4" />
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

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {/* Floating Search */}
        {searchOpen && (
          <div className="sticky top-0 z-10 pb-4">
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
                }
              }}
              placeholder="Search in file... (Esc to close)"
              className="w-full px-3 py-2 rounded border bg-transparent outline-none text-sm"
              style={{ borderColor: theme.colors.accent, color: theme.colors.textMain, backgroundColor: theme.colors.bgSidebar }}
              autoFocus
            />
          </div>
        )}
        {isImage ? (
          <div className="flex items-center justify-center h-full">
            <img
              src={`file://${file.path}`}
              alt={file.name}
              className="max-w-full max-h-full object-contain"
              style={{ imageRendering: 'crisp-edges' }}
            />
          </div>
        ) : searchQuery.trim() || (isMarkdown && markdownRawMode) ? (
          // When searching OR in raw markdown mode, show plain text with optional highlights
          <div
            className="font-mono text-sm whitespace-pre-wrap"
            style={{ color: theme.colors.textMain }}
            dangerouslySetInnerHTML={{ __html: searchQuery.trim() ? highlightMatches(file.content) : file.content }}
          />
        ) : isMarkdown ? (
          <div className="prose prose-sm max-w-none" style={{ color: theme.colors.textMain }}>
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
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: ({ node, href, children, ...props }) => (
                  <a
                    href={href}
                    {...props}
                    onClick={(e) => {
                      e.preventDefault();
                      if (href) {
                        window.maestro.shell.openExternal(href);
                      }
                    }}
                    onMouseEnter={(e) => {
                      if (href) {
                        const rect = e.currentTarget.getBoundingClientRect();
                        setHoveredLink({ url: href, x: rect.left, y: rect.bottom });
                      }
                    }}
                    onMouseLeave={() => setHoveredLink(null)}
                    style={{ color: theme.colors.accent, textDecoration: 'underline', cursor: 'pointer' }}
                  >
                    {children}
                  </a>
                )
              }}
            >
              {file.content}
            </ReactMarkdown>
          </div>
        ) : (
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
        )}
      </div>

      {/* Copy Notification Toast */}
      {showCopyNotification && (
        <div
          className="fixed top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 px-6 py-4 rounded-lg shadow-2xl text-base font-bold animate-in fade-in zoom-in-95 duration-200 z-50"
          style={{
            backgroundColor: theme.colors.accent,
            color: '#FFFFFF',
            textShadow: '0 1px 2px rgba(0, 0, 0, 0.3)'
          }}
        >
          File Path Copied to Clipboard
        </div>
      )}

      {/* Link Hover Tooltip */}
      {hoveredLink && (
        <div
          className="fixed px-3 py-2 rounded shadow-lg text-xs font-mono max-w-md break-all z-50"
          style={{
            left: `${hoveredLink.x}px`,
            top: `${hoveredLink.y + 5}px`,
            backgroundColor: theme.colors.bgActivity,
            color: theme.colors.textDim,
            border: `1px solid ${theme.colors.border}`
          }}
        >
          {hoveredLink.url}
        </div>
      )}
    </div>
  );
}
