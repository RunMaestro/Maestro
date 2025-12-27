import React, { useRef, useEffect, useMemo, forwardRef, useState, useCallback, memo } from 'react';
import { ChevronDown, ChevronUp, Trash2, Copy, Volume2, Square, Check, ArrowDown, Eye, FileText, RotateCcw, AlertCircle } from 'lucide-react';
import type { Session, Theme, LogEntry, FocusArea } from '../types';
import type { FileNode } from '../types/fileTree';
import Convert from 'ansi-to-html';
import DOMPurify from 'dompurify';
import { useLayerStack } from '../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { getActiveTab } from '../utils/tabHelpers';
import { useDebouncedValue, useThrottledCallback } from '../hooks';
import {
  processLogTextHelper,
  filterTextByLinesHelper,
  getCachedAnsiHtml,
  stripMarkdown
} from '../utils/textProcessing';
import { MarkdownRenderer } from './MarkdownRenderer';
import { QueuedItemsList } from './QueuedItemsList';
import { LogFilterControls } from './LogFilterControls';
import { generateTerminalProseStyles } from '../utils/markdownConfig';

// ============================================================================
// LogItem - Memoized component for individual log entries
// ============================================================================

interface LogItemProps {
  log: LogEntry;
  index: number;
  isTerminal: boolean;
  isAIMode: boolean;
  theme: Theme;
  fontFamily: string;
  maxOutputLines: number;
  outputSearchQuery: string;
  lastUserCommand?: string;
  // Expansion state
  isExpanded: boolean;
  onToggleExpanded: (logId: string) => void;
  // Local filter state
  localFilterQuery: string;
  filterMode: { mode: 'include' | 'exclude'; regex: boolean };
  activeLocalFilter: string | null;
  onToggleLocalFilter: (logId: string) => void;
  onSetLocalFilterQuery: (logId: string, query: string) => void;
  onSetFilterMode: (logId: string, update: (current: { mode: 'include' | 'exclude'; regex: boolean }) => { mode: 'include' | 'exclude'; regex: boolean }) => void;
  onClearLocalFilter: (logId: string) => void;
  // Delete state
  deleteConfirmLogId: string | null;
  onDeleteLog?: (logId: string) => number | null;
  onSetDeleteConfirmLogId: (logId: string | null) => void;
  scrollContainerRef: React.RefObject<HTMLDivElement>;
  // Other callbacks
  setLightboxImage: (image: string | null, contextImages?: string[], source?: 'staged' | 'history') => void;
  copyToClipboard: (text: string) => void;
  speakText?: (text: string, logId: string) => void;
  stopSpeaking?: () => void;
  speakingLogId: string | null;
  audioFeedbackCommand?: string;
  // ANSI converter
  ansiConverter: Convert;
  // Markdown rendering mode for AI responses (when true, shows raw text)
  markdownEditMode: boolean;
  onToggleMarkdownEditMode: () => void;
  // Replay message callback (AI mode only)
  onReplayMessage?: (text: string, images?: string[]) => void;
  // File linking support
  fileTree?: FileNode[];
  cwd?: string;
  projectRoot?: string;
  onFileClick?: (path: string) => void;
  // Error details callback
  onShowErrorDetails?: () => void;
}

const LogItemComponent = memo(({
  log,
  index,
  isTerminal,
  isAIMode,
  theme,
  fontFamily,
  maxOutputLines,
  outputSearchQuery,
  lastUserCommand,
  isExpanded,
  onToggleExpanded,
  localFilterQuery,
  filterMode,
  activeLocalFilter,
  onToggleLocalFilter,
  onSetLocalFilterQuery,
  onSetFilterMode,
  onClearLocalFilter,
  deleteConfirmLogId,
  onDeleteLog,
  onSetDeleteConfirmLogId,
  scrollContainerRef,
  setLightboxImage,
  copyToClipboard,
  speakText,
  stopSpeaking,
  speakingLogId,
  audioFeedbackCommand,
  ansiConverter,
  markdownEditMode,
  onToggleMarkdownEditMode,
  onReplayMessage,
  fileTree,
  cwd,
  projectRoot,
  onFileClick,
  onShowErrorDetails,
}: LogItemProps) => {
  // Ref for the log item container - used for scroll-into-view on expand
  const logItemRef = useRef<HTMLDivElement>(null);

  // Handle expand toggle with scroll adjustment
  const handleExpandToggle = useCallback(() => {
    const wasExpanded = isExpanded;
    onToggleExpanded(log.id);

    // After expanding, scroll to ensure the bottom of the item is visible
    if (!wasExpanded) {
      // Use setTimeout to wait for the DOM to update after expansion
      setTimeout(() => {
        const logItem = logItemRef.current;
        const container = scrollContainerRef.current;
        if (logItem && container) {
          const itemRect = logItem.getBoundingClientRect();
          const containerRect = container.getBoundingClientRect();

          // Check if the bottom of the item is below the visible area
          const itemBottom = itemRect.bottom;
          const containerBottom = containerRect.bottom;

          if (itemBottom > containerBottom) {
            // Scroll to show the bottom of the item with some padding
            const scrollAmount = itemBottom - containerBottom + 20; // 20px padding
            container.scrollBy({ top: scrollAmount, behavior: 'smooth' });
          }
        }
      }, 50); // Small delay to allow React to re-render
    }
  }, [isExpanded, log.id, onToggleExpanded, scrollContainerRef]);

  // Helper function to highlight search matches in text
  const highlightMatches = (text: string, query: string): React.ReactNode => {
    if (!query) return text;

    const parts: React.ReactNode[] = [];
    let lastIndex = 0;
    const lowerText = text.toLowerCase();
    const lowerQuery = query.toLowerCase();
    let searchIndex = 0;

    while (searchIndex < lowerText.length) {
      const idx = lowerText.indexOf(lowerQuery, searchIndex);
      if (idx === -1) break;

      if (idx > lastIndex) {
        parts.push(text.substring(lastIndex, idx));
      }

      parts.push(
        <span
          key={`match-${idx}`}
          style={{
            backgroundColor: theme.colors.warning,
            color: theme.mode === 'light' ? '#fff' : '#000',
            padding: '1px 2px',
            borderRadius: '2px'
          }}
        >
          {text.substring(idx, idx + query.length)}
        </span>
      );

      lastIndex = idx + query.length;
      searchIndex = lastIndex;
    }

    if (lastIndex < text.length) {
      parts.push(text.substring(lastIndex));
    }

    return parts.length > 0 ? parts : text;
  };

  // Helper function to add search highlighting markers to text (before ANSI conversion)
  const addHighlightMarkers = (text: string, query: string): string => {
    if (!query) return text;

    let result = '';
    let lastIndex = 0;
    const lowerText = text.toLowerCase();
    const lowerQuery = query.toLowerCase();
    let searchIndex = 0;

    while (searchIndex < lowerText.length) {
      const idx = lowerText.indexOf(lowerQuery, searchIndex);
      if (idx === -1) break;

      result += text.substring(lastIndex, idx);
      result += `<mark style="background-color: ${theme.colors.warning}; color: ${theme.mode === 'light' ? '#fff' : '#000'}; padding: 1px 2px; border-radius: 2px;">`;
      result += text.substring(idx, idx + query.length);
      result += '</mark>';

      lastIndex = idx + query.length;
      searchIndex = lastIndex;
    }

    result += text.substring(lastIndex);
    return result;
  };

  // Strip command echo from terminal output
  let textToProcess = log.text;
  if (isTerminal && log.source !== 'user' && lastUserCommand) {
    if (textToProcess.startsWith(lastUserCommand)) {
      textToProcess = textToProcess.slice(lastUserCommand.length);
      if (textToProcess.startsWith('\r\n')) {
        textToProcess = textToProcess.slice(2);
      } else if (textToProcess.startsWith('\n') || textToProcess.startsWith('\r')) {
        textToProcess = textToProcess.slice(1);
      }
    }
  }

  const processedText = processLogTextHelper(textToProcess, isTerminal && log.source !== 'user');

  // Skip rendering stderr entries that have no actual content
  if (log.source === 'stderr' && !processedText.trim()) {
    return null;
  }

  // Separate stdout and stderr for terminal output
  const separated = log.source === 'stderr'
    ? { stdout: '', stderr: processedText }
    : { stdout: processedText, stderr: '' };

  // Apply local filter if active for this log entry
  const filteredStdout = localFilterQuery && log.source !== 'user'
    ? filterTextByLinesHelper(separated.stdout, localFilterQuery, filterMode.mode, filterMode.regex)
    : separated.stdout;
  const filteredStderr = localFilterQuery && log.source !== 'user'
    ? filterTextByLinesHelper(separated.stderr, localFilterQuery, filterMode.mode, filterMode.regex)
    : separated.stderr;

  // Check if filter returned no results
  const hasNoMatches = localFilterQuery && !filteredStdout.trim() && !filteredStderr.trim() && log.source !== 'user';

  // For stderr entries, use stderr content; for all others, use stdout content
  const contentToDisplay = log.source === 'stderr' ? filteredStderr : filteredStdout;

  // Apply search highlighting before ANSI conversion for terminal output
  const contentWithHighlights = isTerminal && log.source !== 'user' && outputSearchQuery
    ? addHighlightMarkers(contentToDisplay, outputSearchQuery)
    : contentToDisplay;

  // PERF: Convert ANSI codes to HTML, using cache when no search highlighting is applied
  // When search is active, highlighting markers change the text so we can't use cache
  const htmlContent = isTerminal && log.source !== 'user'
    ? (outputSearchQuery
        ? DOMPurify.sanitize(ansiConverter.toHtml(contentWithHighlights))
        : getCachedAnsiHtml(contentToDisplay, theme.id, ansiConverter))
    : contentToDisplay;

  const filteredText = contentToDisplay;

  // Count lines in the filtered text
  const lineCount = filteredText.split('\n').length;
  const shouldCollapse = lineCount > maxOutputLines && maxOutputLines !== Infinity;

  // Truncate text if collapsed
  const displayText = shouldCollapse && !isExpanded
    ? filteredText.split('\n').slice(0, maxOutputLines).join('\n')
    : filteredText;

  // Apply highlighting to truncated text as well
  const displayTextWithHighlights = shouldCollapse && !isExpanded && isTerminal && log.source !== 'user' && outputSearchQuery
    ? addHighlightMarkers(displayText, outputSearchQuery)
    : displayText;

  // PERF: Sanitize with DOMPurify, using cache when no search highlighting
  const displayHtmlContent = shouldCollapse && !isExpanded && isTerminal && log.source !== 'user'
    ? (outputSearchQuery
        ? DOMPurify.sanitize(ansiConverter.toHtml(displayTextWithHighlights))
        : getCachedAnsiHtml(displayText, theme.id, ansiConverter))
    : htmlContent;

  const isUserMessage = log.source === 'user';

  return (
    <div ref={logItemRef} className={`flex gap-4 group ${isUserMessage ? 'flex-row-reverse' : ''} px-6 py-2`} data-log-index={index}>
      <div className={`w-16 shrink-0 text-[10px] pt-2 ${isUserMessage ? 'text-right' : 'text-left'}`}
           style={{ fontFamily, color: theme.colors.textDim, opacity: 0.6 }}>
        {(() => {
          const logDate = new Date(log.timestamp);
          const today = new Date();
          const isToday = logDate.toDateString() === today.toDateString();
          const time = logDate.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
          if (isToday) {
            return time;
          }
          // Format: YYYY-MM-DD on first line, time on second
          const year = logDate.getFullYear();
          const month = String(logDate.getMonth() + 1).padStart(2, '0');
          const day = String(logDate.getDate()).padStart(2, '0');
          return (
            <>
              <div>{year}-{month}-{day}</div>
              <div>{time}</div>
            </>
          );
        })()}
      </div>
      <div className={`flex-1 min-w-0 p-4 pb-10 rounded-xl border ${isUserMessage ? 'rounded-tr-none' : 'rounded-tl-none'} relative overflow-hidden`}
           style={{
             backgroundColor: isUserMessage
               ? isAIMode
                 ? `color-mix(in srgb, ${theme.colors.accent} 20%, ${theme.colors.bgSidebar})`
                 : `color-mix(in srgb, ${theme.colors.accent} 15%, ${theme.colors.bgActivity})`
               : log.source === 'stderr' || log.source === 'error'
                 ? `color-mix(in srgb, ${theme.colors.error} 8%, ${theme.colors.bgActivity})`
                 : isAIMode ? theme.colors.bgActivity : 'transparent',
             borderColor: isUserMessage && isAIMode
               ? theme.colors.accent + '40'
               : (log.source === 'stderr' || log.source === 'error') ? theme.colors.error : theme.colors.border
           }}>
        {/* Local filter icon for system output only */}
        {log.source !== 'user' && isTerminal && (
          <div className="absolute top-2 right-2 flex items-center gap-2">
            <LogFilterControls
              logId={log.id}
              fontFamily={fontFamily}
              theme={theme}
              filterQuery={localFilterQuery}
              filterMode={filterMode}
              isActive={activeLocalFilter === log.id}
              onToggleFilter={onToggleLocalFilter}
              onSetFilterQuery={onSetLocalFilterQuery}
              onSetFilterMode={onSetFilterMode}
              onClearFilter={onClearLocalFilter}
            />
          </div>
        )}
        {log.images && log.images.length > 0 && (
          <div className="flex gap-2 mb-2 overflow-x-auto scrollbar-thin" style={{ overscrollBehavior: 'contain' }}>
            {log.images.map((img, imgIdx) => (
              <img
                key={imgIdx}
                src={img}
                className="h-20 rounded border cursor-zoom-in shrink-0"
                style={{ objectFit: 'contain', maxWidth: '200px' }}
                onClick={() => setLightboxImage(img, log.images, 'history')}
              />
            ))}
          </div>
        )}
        {log.source === 'stderr' && (
          <div className="mb-2">
            <span
              className="px-2 py-1 rounded text-xs font-bold uppercase tracking-wide"
              style={{
                backgroundColor: theme.colors.error,
                color: '#fff'
              }}
            >
              STDERR
            </span>
          </div>
        )}
        {/* Special rendering for error log entries */}
        {log.source === 'error' && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <AlertCircle className="w-5 h-5" style={{ color: theme.colors.error }} />
              <span className="text-sm font-medium" style={{ color: theme.colors.error }}>
                Error
              </span>
            </div>
            <p className="text-sm" style={{ color: theme.colors.textMain }}>
              {log.text}
            </p>
            {!!log.agentError?.parsedJson && onShowErrorDetails && (
              <button
                onClick={onShowErrorDetails}
                className="self-start flex items-center gap-2 px-3 py-1.5 text-xs rounded border hover:opacity-80 transition-opacity"
                style={{
                  backgroundColor: theme.colors.error + '15',
                  borderColor: theme.colors.error + '40',
                  color: theme.colors.error,
                }}
              >
                <Eye className="w-3 h-3" />
                View Details
              </button>
            )}
          </div>
        )}
        {/* Special rendering for thinking/streaming content (AI reasoning in real-time) */}
        {log.source === 'thinking' && (
          <div
            className="px-4 py-2 text-sm font-mono border-l-2"
            style={{
              color: theme.colors.textDim,
              borderColor: theme.colors.accent,
            }}
          >
            <div className="flex items-center gap-2 mb-1">
              <span
                className="text-[10px] px-1.5 py-0.5 rounded"
                style={{
                  backgroundColor: `${theme.colors.accent}30`,
                  color: theme.colors.accent,
                }}
              >
                thinking
              </span>
            </div>
            <div className="whitespace-pre-wrap" style={{ opacity: 0.7 }}>{log.text}</div>
          </div>
        )}
        {/* Special rendering for tool execution events (shown alongside thinking) */}
        {log.source === 'tool' && (() => {
          // Extract tool input details for display
          const toolInput = log.metadata?.toolState?.input as Record<string, unknown> | undefined;
          const toolDetail = toolInput
            ? (toolInput.command as string) || (toolInput.pattern as string) || (toolInput.file_path as string) || (toolInput.query as string) || null
            : null;

          return (
            <div
              className="px-4 py-1.5 text-xs font-mono border-l-2"
              style={{
                color: theme.colors.textDim,
                borderColor: theme.colors.accent,
              }}
            >
              <div className="flex items-start gap-2">
                <span
                  className="px-1.5 py-0.5 rounded shrink-0"
                  style={{
                    backgroundColor: `${theme.colors.accent}30`,
                    color: theme.colors.accent,
                  }}
                >
                  {log.text}
                </span>
                {log.metadata?.toolState?.status === 'running' && (
                  <span className="animate-pulse shrink-0 pt-0.5" style={{ color: theme.colors.warning }}>●</span>
                )}
                {log.metadata?.toolState?.status === 'completed' && (
                  <span className="shrink-0 pt-0.5" style={{ color: theme.colors.success }}>✓</span>
                )}
                {toolDetail && (
                  <span
                    className="opacity-70 break-all whitespace-pre-wrap"
                    style={{ color: theme.colors.textMain }}
                  >
                    {toolDetail}
                  </span>
                )}
              </div>
            </div>
          );
        })()}
        {log.source !== 'error' && log.source !== 'thinking' && log.source !== 'tool' && (hasNoMatches ? (
          <div className="flex items-center justify-center py-8 text-sm" style={{ color: theme.colors.textDim }}>
            <span>No matches found for filter</span>
          </div>
        ) : shouldCollapse && !isExpanded ? (
          <div>
            <div
              className={`${isTerminal && log.source !== 'user' ? 'whitespace-pre text-sm' : 'whitespace-pre-wrap text-sm break-all'}`}
              style={{
                maxHeight: `${maxOutputLines * 1.5}em`,
                overflow: isTerminal && log.source !== 'user' ? 'hidden' : 'hidden',
                color: theme.colors.textMain,
                fontFamily,
                wordBreak: isTerminal && log.source !== 'user' ? undefined : 'break-all'
              }}
            >
              {isTerminal && log.source !== 'user' ? (
                // Content sanitized with DOMPurify above
                // Horizontal scroll for terminal output to preserve column alignment
                <div className="overflow-x-auto scrollbar-thin" dangerouslySetInnerHTML={{ __html: displayHtmlContent }} />
              ) : isAIMode && !markdownEditMode ? (
                // Collapsed markdown preview with rendered markdown
                <MarkdownRenderer
                  content={displayText}
                  theme={theme}
                  onCopy={copyToClipboard}
                  fileTree={fileTree}
                  cwd={cwd}
                  projectRoot={projectRoot}
                  onFileClick={onFileClick}
                />
              ) : (
                displayText
              )}
            </div>
            <button
              onClick={handleExpandToggle}
              className="flex items-center gap-2 mt-2 text-xs px-3 py-1.5 rounded border hover:opacity-70 transition-opacity"
              style={{
                borderColor: theme.colors.border,
                backgroundColor: theme.colors.bgActivity,
                color: theme.colors.accent
              }}
            >
              <ChevronDown className="w-3 h-3" />
              Show all {lineCount} lines
            </button>
          </div>
        ) : shouldCollapse && isExpanded ? (
          <div>
            <div
              className={`${isTerminal && log.source !== 'user' ? 'whitespace-pre text-sm scrollbar-thin' : 'whitespace-pre-wrap text-sm break-all'}`}
              style={{
                maxHeight: '600px',
                overflow: 'auto',
                overscrollBehavior: 'contain',
                color: theme.colors.textMain,
                fontFamily,
                wordBreak: isTerminal && log.source !== 'user' ? undefined : 'break-all'
              }}
              onWheel={(e) => {
                // Prevent scroll from propagating to parent when this container can scroll
                const el = e.currentTarget;
                const { scrollTop, scrollHeight, clientHeight } = el;
                const atTop = scrollTop <= 0;
                const atBottom = scrollTop + clientHeight >= scrollHeight - 1;

                // Only stop propagation if we're not at the boundary we're scrolling towards
                if ((e.deltaY < 0 && !atTop) || (e.deltaY > 0 && !atBottom)) {
                  e.stopPropagation();
                }
              }}
            >
              {isTerminal && log.source !== 'user' ? (
                // Content sanitized with DOMPurify above
                // Horizontal scroll for terminal output to preserve column alignment
                <div dangerouslySetInnerHTML={{ __html: displayHtmlContent }} />
              ) : log.source === 'user' && isTerminal ? (
                <div style={{ fontFamily }}>
                  <span style={{ color: theme.colors.accent }}>$ </span>
                  {highlightMatches(filteredText, outputSearchQuery)}
                </div>
              ) : log.aiCommand ? (
                <div className="space-y-3">
                  <div
                    className="flex items-center gap-2 px-3 py-2 rounded-lg border"
                    style={{
                      backgroundColor: theme.colors.accent + '15',
                      borderColor: theme.colors.accent + '30'
                    }}
                  >
                    <span className="font-mono font-bold text-sm" style={{ color: theme.colors.accent }}>
                      {log.aiCommand.command}:
                    </span>
                    <span className="text-sm" style={{ color: theme.colors.textMain }}>
                      {log.aiCommand.description}
                    </span>
                  </div>
                  <div>{highlightMatches(filteredText, outputSearchQuery)}</div>
                </div>
              ) : isAIMode && !markdownEditMode ? (
                // Expanded markdown rendering
                <MarkdownRenderer
                  content={filteredText}
                  theme={theme}
                  onCopy={copyToClipboard}
                  fileTree={fileTree}
                  cwd={cwd}
                  projectRoot={projectRoot}
                  onFileClick={onFileClick}
                />
              ) : (
                <div>{highlightMatches(filteredText, outputSearchQuery)}</div>
              )}
            </div>
            <button
              onClick={handleExpandToggle}
              className="flex items-center gap-2 mt-2 text-xs px-3 py-1.5 rounded border hover:opacity-70 transition-opacity"
              style={{
                borderColor: theme.colors.border,
                backgroundColor: theme.colors.bgActivity,
                color: theme.colors.accent
              }}
            >
              <ChevronUp className="w-3 h-3" />
              Show less
            </button>
          </div>
        ) : (
          <>
            {isTerminal && log.source !== 'user' ? (
              // Content sanitized with DOMPurify above
              <div
                className="whitespace-pre text-sm overflow-x-auto scrollbar-thin"
                style={{ color: theme.colors.textMain, fontFamily, overscrollBehavior: 'contain' }}
                dangerouslySetInnerHTML={{ __html: displayHtmlContent }}
              />
            ) : log.source === 'user' && isTerminal ? (
              <div className="whitespace-pre-wrap text-sm break-all" style={{ color: theme.colors.textMain, fontFamily }}>
                <span style={{ color: theme.colors.accent }}>$ </span>
                {highlightMatches(filteredText, outputSearchQuery)}
              </div>
            ) : log.aiCommand ? (
              <div className="space-y-3">
                <div
                  className="flex items-center gap-2 px-3 py-2 rounded-lg border"
                  style={{
                    backgroundColor: theme.colors.accent + '15',
                    borderColor: theme.colors.accent + '30'
                  }}
                >
                  <span className="font-mono font-bold text-sm" style={{ color: theme.colors.accent }}>
                    {log.aiCommand.command}:
                  </span>
                  <span className="text-sm" style={{ color: theme.colors.textMain }}>
                    {log.aiCommand.description}
                  </span>
                </div>
                <div className="whitespace-pre-wrap text-sm break-all" style={{ color: theme.colors.textMain }}>
                  {highlightMatches(filteredText, outputSearchQuery)}
                </div>
              </div>
            ) : isAIMode && !markdownEditMode ? (
              // Rendered markdown for AI responses
              <MarkdownRenderer
                content={filteredText}
                theme={theme}
                onCopy={copyToClipboard}
                fileTree={fileTree}
                cwd={cwd}
                projectRoot={projectRoot}
                onFileClick={onFileClick}
              />
            ) : (
              // Plain text mode (strip markdown formatting for readability)
              <div className="whitespace-pre-wrap text-sm break-all" style={{ color: theme.colors.textMain }}>
                {highlightMatches(isAIMode ? stripMarkdown(filteredText) : filteredText, outputSearchQuery)}
              </div>
            )}
          </>
        ))}
        {/* Action buttons - bottom right corner */}
        <div
          className="absolute bottom-2 right-2 flex items-center gap-1"
          style={{ transition: 'opacity 0.15s ease-in-out' }}
        >
          {/* Markdown toggle button for AI responses */}
          {log.source !== 'user' && isAIMode && (
            <button
              onClick={onToggleMarkdownEditMode}
              className="p-1.5 rounded opacity-0 group-hover:opacity-50 hover:!opacity-100"
              style={{ color: markdownEditMode ? theme.colors.accent : theme.colors.textDim }}
              title={markdownEditMode ? "Show formatted (⌘E)" : "Show plain text (⌘E)"}
            >
              {markdownEditMode ? <Eye className="w-4 h-4" /> : <FileText className="w-4 h-4" />}
            </button>
          )}
          {/* Speak/Stop Button - only show for non-user messages when TTS is configured */}
          {audioFeedbackCommand && log.source !== 'user' && (
            speakingLogId === log.id ? (
              <button
                onClick={stopSpeaking}
                className="p-1.5 rounded opacity-100"
                style={{ color: theme.colors.error }}
                title="Stop speaking"
              >
                <Square className="w-3.5 h-3.5" fill="currentColor" />
              </button>
            ) : (
              <button
                onClick={() => speakText?.(log.text, log.id)}
                className="p-1.5 rounded opacity-0 group-hover:opacity-50 hover:!opacity-100"
                style={{ color: theme.colors.textDim }}
                title="Speak text"
              >
                <Volume2 className="w-3.5 h-3.5" />
              </button>
            )
          )}
          {/* Replay button for user messages in AI mode */}
          {isUserMessage && isAIMode && onReplayMessage && (
            <button
              onClick={() => onReplayMessage(log.text, log.images)}
              className="p-1.5 rounded opacity-0 group-hover:opacity-50 hover:!opacity-100"
              style={{ color: theme.colors.textDim }}
              title="Replay message"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
          )}
          {/* Copy to Clipboard Button */}
          <button
            onClick={() => copyToClipboard(log.text)}
            className="p-1.5 rounded opacity-0 group-hover:opacity-50 hover:!opacity-100"
            style={{ color: theme.colors.textDim }}
            title="Copy to clipboard"
          >
            <Copy className="w-3.5 h-3.5" />
          </button>
          {/* Delete button for user messages (both AI and terminal modes) */}
          {log.source === 'user' && onDeleteLog && (
            deleteConfirmLogId === log.id ? (
              <div className="flex items-center gap-1 p-1 rounded border" style={{ backgroundColor: theme.colors.bgSidebar, borderColor: theme.colors.error }}>
                <span className="text-xs px-1" style={{ color: theme.colors.error }}>Delete?</span>
                <button
                  onClick={() => {
                    const nextIndex = onDeleteLog(log.id);
                    onSetDeleteConfirmLogId(null);
                    if (nextIndex !== null && nextIndex >= 0) {
                      setTimeout(() => {
                        const container = scrollContainerRef.current;
                        const items = container?.querySelectorAll('[data-log-index]');
                        const targetItem = items?.[nextIndex] as HTMLElement;
                        if (targetItem && container) {
                          container.scrollTop = targetItem.offsetTop;
                        }
                      }, 50);
                    }
                  }}
                  className="px-2 py-0.5 rounded text-xs font-medium hover:opacity-80"
                  style={{ backgroundColor: theme.colors.error, color: '#fff' }}
                >
                  Yes
                </button>
                <button
                  onClick={() => onSetDeleteConfirmLogId(null)}
                  className="px-2 py-0.5 rounded text-xs hover:opacity-80"
                  style={{ color: theme.colors.textDim }}
                >
                  No
                </button>
              </div>
            ) : (
              <button
                onClick={() => onSetDeleteConfirmLogId(log.id)}
                className="p-1.5 rounded opacity-0 group-hover:opacity-50 hover:!opacity-100 transition-opacity"
                style={{ color: theme.colors.textDim }}
                title={isAIMode ? "Delete message and response" : "Delete command and output"}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )
          )}
          {/* Delivery checkmark for user messages in AI mode - positioned at the end */}
          {isUserMessage && isAIMode && log.delivered && (
            <span title="Message delivered" className="flex items-center">
              <Check
                className="w-3.5 h-3.5"
                style={{ color: theme.colors.success, opacity: 0.6 }}
              />
            </span>
          )}
        </div>
      </div>
    </div>
  );
}, (prevProps, nextProps) => {
  // Custom comparison - only re-render if these specific props change
  // IMPORTANT: Include ALL props that affect visual rendering
  return (
    prevProps.log.id === nextProps.log.id &&
    prevProps.log.text === nextProps.log.text &&
    prevProps.log.delivered === nextProps.log.delivered &&
    prevProps.log.readOnly === nextProps.log.readOnly &&
    prevProps.isExpanded === nextProps.isExpanded &&
    prevProps.localFilterQuery === nextProps.localFilterQuery &&
    prevProps.filterMode.mode === nextProps.filterMode.mode &&
    prevProps.filterMode.regex === nextProps.filterMode.regex &&
    prevProps.activeLocalFilter === nextProps.activeLocalFilter &&
    prevProps.deleteConfirmLogId === nextProps.deleteConfirmLogId &&
    prevProps.speakingLogId === nextProps.speakingLogId &&
    prevProps.outputSearchQuery === nextProps.outputSearchQuery &&
    prevProps.theme === nextProps.theme &&
    prevProps.maxOutputLines === nextProps.maxOutputLines &&
    prevProps.markdownEditMode === nextProps.markdownEditMode &&
    prevProps.fontFamily === nextProps.fontFamily
  );
});

LogItemComponent.displayName = 'LogItemComponent';

// ============================================================================
// ElapsedTimeDisplay - Separate component for elapsed time
// ============================================================================

// Separate component for elapsed time to prevent re-renders of the entire list
const ElapsedTimeDisplay = memo(({ thinkingStartTime, textColor }: { thinkingStartTime: number; textColor: string }) => {
  const [elapsedSeconds, setElapsedSeconds] = useState(
    Math.floor((Date.now() - thinkingStartTime) / 1000)
  );

  useEffect(() => {
    // Update every second
    const interval = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - thinkingStartTime) / 1000));
    }, 1000);

    return () => clearInterval(interval);
  }, [thinkingStartTime]);

  // Format elapsed time as mm:ss or hh:mm:ss
  const formatElapsedTime = (seconds: number): string => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <span className="text-sm font-mono" style={{ color: textColor }}>
      {formatElapsedTime(elapsedSeconds)}
    </span>
  );
});

interface TerminalOutputProps {
  session: Session;
  theme: Theme;
  fontFamily: string;
  activeFocus: FocusArea;
  outputSearchOpen: boolean;
  outputSearchQuery: string;
  setOutputSearchOpen: (open: boolean) => void;
  setOutputSearchQuery: (query: string) => void;
  setActiveFocus: (focus: FocusArea) => void;
  setLightboxImage: (image: string | null, contextImages?: string[], source?: 'staged' | 'history') => void;
  inputRef: React.RefObject<HTMLTextAreaElement>;
  logsEndRef: React.RefObject<HTMLDivElement>;
  maxOutputLines: number;
  onDeleteLog?: (logId: string) => number | null; // Returns the index to scroll to after deletion
  onRemoveQueuedItem?: (itemId: string) => void; // Callback to remove a queued item from execution queue
  onInterrupt?: () => void; // Callback to interrupt the current process
  audioFeedbackCommand?: string; // TTS command for speech synthesis
  onScrollPositionChange?: (scrollTop: number) => void; // Callback to save scroll position
  onAtBottomChange?: (isAtBottom: boolean) => void; // Callback when user scrolls to/away from bottom
  initialScrollTop?: number; // Initial scroll position to restore
  markdownEditMode: boolean; // Whether to show raw markdown or rendered markdown for AI responses
  setMarkdownEditMode: (value: boolean) => void; // Toggle markdown mode
  onReplayMessage?: (text: string, images?: string[]) => void; // Replay a user message
  fileTree?: FileNode[]; // File tree for linking file references
  cwd?: string; // Current working directory for proximity-based matching
  projectRoot?: string; // Project root absolute path for converting absolute paths to relative
  onFileClick?: (path: string) => void; // Callback when a file link is clicked
  onShowErrorDetails?: () => void; // Callback to show the error modal (for error log entries)
}

// PERFORMANCE: Wrap in React.memo to prevent re-renders when parent re-renders
// but TerminalOutput's props haven't changed. This is critical because TerminalOutput
// can render many log entries and is expensive to re-render.
export const TerminalOutput = memo(forwardRef<HTMLDivElement, TerminalOutputProps>((props, ref) => {
  const {
    session, theme, fontFamily, activeFocus: _activeFocus, outputSearchOpen, outputSearchQuery,
    setOutputSearchOpen, setOutputSearchQuery, setActiveFocus, setLightboxImage,
    inputRef, logsEndRef, maxOutputLines, onDeleteLog, onRemoveQueuedItem, onInterrupt: _onInterrupt,
    audioFeedbackCommand, onScrollPositionChange, onAtBottomChange, initialScrollTop,
    markdownEditMode, setMarkdownEditMode, onReplayMessage,
    fileTree, cwd, projectRoot, onFileClick, onShowErrorDetails
  } = props;

  // Use the forwarded ref if provided, otherwise create a local one
  const localRef = useRef<HTMLDivElement>(null);
  const terminalOutputRef = (ref as React.RefObject<HTMLDivElement>) || localRef;

  // Scroll container ref for native scrolling
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Track which log entries are expanded (by log ID)
  const [expandedLogs, setExpandedLogs] = useState<Set<string>>(new Set());
  // Use a ref to access current value without recreating LogItem callback
  const expandedLogsRef = useRef(expandedLogs);
  expandedLogsRef.current = expandedLogs;
  // Counter to force re-render of LogItem when expanded state changes
  const [_expandedTrigger, setExpandedTrigger] = useState(0);

  // Track local filters per log entry (log ID -> filter query)
  const [localFilters, setLocalFilters] = useState<Map<string, string>>(new Map());
  // Use refs to access current values without recreating LogItem callback
  const localFiltersRef = useRef(localFilters);
  localFiltersRef.current = localFilters;
  const [activeLocalFilter, setActiveLocalFilter] = useState<string | null>(null);
  const activeLocalFilterRef = useRef(activeLocalFilter);
  activeLocalFilterRef.current = activeLocalFilter;
  // Counter to force re-render when local filter state changes
  const [_filterTrigger, setFilterTrigger] = useState(0);

  // Track filter modes per log entry (log ID -> {mode: 'include'|'exclude', regex: boolean})
  const [filterModes, setFilterModes] = useState<Map<string, { mode: 'include' | 'exclude'; regex: boolean }>>(new Map());
  const filterModesRef = useRef(filterModes);
  filterModesRef.current = filterModes;

  // Delete confirmation state
  const [deleteConfirmLogId, setDeleteConfirmLogId] = useState<string | null>(null);
  const deleteConfirmLogIdRef = useRef(deleteConfirmLogId);
  deleteConfirmLogIdRef.current = deleteConfirmLogId;
  // Counter to force re-render when delete confirmation changes
  const [_deleteConfirmTrigger, _setDeleteConfirmTrigger] = useState(0);


  // Copy to clipboard notification state
  const [showCopiedNotification, setShowCopiedNotification] = useState(false);

  // TTS state - track which log is currently speaking and its TTS ID
  const [speakingLogId, setSpeakingLogId] = useState<string | null>(null);
  const [activeTtsId, setActiveTtsId] = useState<number | null>(null);

  // New message indicator state
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [hasNewMessages, setHasNewMessages] = useState(false);
  const [newMessageCount, setNewMessageCount] = useState(0);
  const lastLogCountRef = useRef(0);
  // Track previous isAtBottom to detect changes for callback
  const prevIsAtBottomRef = useRef(true);

  // Track read state per tab - stores the log count when user scrolled to bottom
  const tabReadStateRef = useRef<Map<string, number>>(new Map());

  // Throttle timer ref for scroll position saves
  const scrollSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track if initial scroll restore has been done
  const hasRestoredScrollRef = useRef(false);

  // Get active tab ID for resetting state on tab switch
  const activeTabId = session.inputMode === 'ai' ? session.activeTabId : null;

  // Copy text to clipboard with notification
  const copyToClipboard = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setShowCopiedNotification(true);
      setTimeout(() => setShowCopiedNotification(false), 1500);
    } catch (err) {
      console.error('Failed to copy to clipboard:', err);
    }
  }, []);

  // Speak text using TTS command
  const speakText = useCallback(async (text: string, logId: string) => {
    console.log('[TTS] speakText called, text length:', text.length, 'command:', audioFeedbackCommand, 'logId:', logId);
    if (!audioFeedbackCommand) {
      console.log('[TTS] No audioFeedbackCommand configured, skipping');
      return;
    }
    try {
      // Set the speaking state before starting
      setSpeakingLogId(logId);
      const result = await window.maestro.notification.speak(text, audioFeedbackCommand);
      console.log('[TTS] Speak result:', result);
      if (result.success && result.ttsId) {
        setActiveTtsId(result.ttsId);
      } else {
        // If speak failed, clear the speaking state
        setSpeakingLogId(null);
      }
    } catch (err) {
      console.error('[TTS] Failed to speak text:', err);
      setSpeakingLogId(null);
    }
  }, [audioFeedbackCommand]);

  // Stop the currently speaking TTS
  const stopSpeaking = useCallback(async () => {
    console.log('[TTS] stopSpeaking called, activeTtsId:', activeTtsId);
    if (activeTtsId === null) {
      console.log('[TTS] No active TTS to stop');
      setSpeakingLogId(null);
      return;
    }
    try {
      const result = await window.maestro.notification.stopSpeak(activeTtsId);
      console.log('[TTS] Stop result:', result);
    } catch (err) {
      console.error('[TTS] Failed to stop speaking:', err);
    }
    // Always clear state after stopping
    setSpeakingLogId(null);
    setActiveTtsId(null);
  }, [activeTtsId]);

  // Listen for TTS completion events from main process
  useEffect(() => {
    const cleanup = window.maestro.notification.onTtsCompleted((completedTtsId: number) => {
      console.log('[TTS] TTS completed event received for ID:', completedTtsId);
      // Only clear if this is the currently active TTS
      if (completedTtsId === activeTtsId) {
        setSpeakingLogId(null);
        setActiveTtsId(null);
      }
    });
    return cleanup;
  }, [activeTtsId]);

  // Layer stack integration for search overlay
  const { registerLayer, unregisterLayer, updateLayerHandler } = useLayerStack();
  const layerIdRef = useRef<string>();

  // Register layer when search is open
  useEffect(() => {
    if (outputSearchOpen) {
      layerIdRef.current = registerLayer({
        type: 'overlay',
        priority: MODAL_PRIORITIES.SLASH_AUTOCOMPLETE, // Use same priority as slash autocomplete (low priority)
        blocksLowerLayers: false,
        capturesFocus: true,
        focusTrap: 'none',
        onEscape: () => {
          setOutputSearchOpen(false);
          setOutputSearchQuery('');
          terminalOutputRef.current?.focus();
        },
        allowClickOutside: true,
        ariaLabel: 'Output Search'
      });

      return () => {
        if (layerIdRef.current) {
          unregisterLayer(layerIdRef.current);
        }
      };
    }
  }, [outputSearchOpen, registerLayer, unregisterLayer]);

  // Update the handler when dependencies change
  useEffect(() => {
    if (outputSearchOpen && layerIdRef.current) {
      updateLayerHandler(layerIdRef.current, () => {
        setOutputSearchOpen(false);
        setOutputSearchQuery('');
        terminalOutputRef.current?.focus();
      });
    }
  }, [outputSearchOpen, updateLayerHandler]);

  const toggleExpanded = useCallback((logId: string) => {
    setExpandedLogs(prev => {
      const newSet = new Set(prev);
      if (newSet.has(logId)) {
        newSet.delete(logId);
      } else {
        newSet.add(logId);
      }
      return newSet;
    });
    // Trigger re-render after state update
    setExpandedTrigger(t => t + 1);
  }, []);

  const toggleLocalFilter = useCallback((logId: string) => {
    setActiveLocalFilter(prev => prev === logId ? null : logId);
    setFilterTrigger(t => t + 1);
  }, []);

  const setLocalFilterQuery = useCallback((logId: string, query: string) => {
    setLocalFilters(prev => {
      const newMap = new Map(prev);
      if (query) {
        newMap.set(logId, query);
      } else {
        newMap.delete(logId);
      }
      return newMap;
    });
  }, []);

  // Callback to update filter mode for a log entry
  const setFilterModeForLog = useCallback((logId: string, update: (current: { mode: 'include' | 'exclude'; regex: boolean }) => { mode: 'include' | 'exclude'; regex: boolean }) => {
    setFilterModes(prev => {
      const newMap = new Map(prev);
      const current = newMap.get(logId) || { mode: 'include' as const, regex: false };
      newMap.set(logId, update(current));
      return newMap;
    });
  }, []);

  // Callback to clear local filter for a log entry
  const clearLocalFilter = useCallback((logId: string) => {
    setActiveLocalFilter(null);
    setLocalFilterQuery(logId, '');
    setFilterModes(prev => {
      const newMap = new Map(prev);
      newMap.delete(logId);
      return newMap;
    });
  }, [setLocalFilterQuery]);

  // Callback to toggle markdown mode
  const toggleMarkdownEditMode = useCallback(() => {
    setMarkdownEditMode(!markdownEditMode);
  }, [markdownEditMode, setMarkdownEditMode]);

  // Auto-focus on search input when opened
  useEffect(() => {
    if (outputSearchOpen) {
      terminalOutputRef.current?.querySelector('input')?.focus();
    }
  }, [outputSearchOpen]);

  // Create ANSI converter with theme-aware colors
  const ansiConverter = useMemo(() => {
    return new Convert({
      fg: theme.colors.textMain,
      bg: theme.colors.bgMain,
      newline: false,
      escapeXML: true,
      stream: false,
      colors: {
        0: theme.colors.textMain,   // black -> textMain
        1: theme.colors.error,       // red -> error
        2: theme.colors.success,     // green -> success
        3: theme.colors.warning,     // yellow -> warning
        4: theme.colors.accent,      // blue -> accent
        5: theme.colors.accentDim,   // magenta -> accentDim
        6: theme.colors.accent,      // cyan -> accent
        7: theme.colors.textDim,     // white -> textDim
      }
    });
  }, [theme]);

  // In AI mode, use the active tab's logs
  const activeTab = session.inputMode === 'ai' ? getActiveTab(session) : undefined;
  const activeLogs: LogEntry[] = session.inputMode === 'ai'
    ? (activeTab?.logs ?? [])
    : session.shellLogs;

  // In AI mode, collapse consecutive non-user entries into single response blocks
  // This provides a cleaner view where each user message gets one response
  // Tool and thinking entries are kept separate (not collapsed)
  const collapsedLogs = useMemo(() => {
    // Only collapse in AI mode
    if (session.inputMode !== 'ai') return activeLogs;

    const result: LogEntry[] = [];
    let currentResponseGroup: LogEntry[] = [];

    // Helper to flush accumulated response group
    const flushResponseGroup = () => {
      if (currentResponseGroup.length > 0) {
        // Combine all response entries into one
        const combinedText = currentResponseGroup.map(l => l.text).join('');
        result.push({
          ...currentResponseGroup[0],
          text: combinedText,
          // Keep the first entry's timestamp and id
        });
        currentResponseGroup = [];
      }
    };

    for (const log of activeLogs) {
      if (log.source === 'user') {
        // Flush any accumulated response group before user message
        flushResponseGroup();
        result.push(log);
      } else if (log.source === 'tool' || log.source === 'thinking') {
        // Flush response group before tool/thinking, then add tool/thinking separately
        flushResponseGroup();
        result.push(log);
      } else {
        // Accumulate non-user entries (AI responses)
        currentResponseGroup.push(log);
      }
    }

    // Flush final response group
    flushResponseGroup();

    return result;
  }, [activeLogs, session.inputMode, markdownEditMode]);

  // PERF: Debounce search query to avoid filtering on every keystroke
  const debouncedSearchQuery = useDebouncedValue(outputSearchQuery, 150);

  // Filter logs based on search query - memoized for performance
  // Uses debounced query to reduce CPU usage during rapid typing
  const filteredLogs = useMemo(() => {
    if (!debouncedSearchQuery) return collapsedLogs;
    const lowerQuery = debouncedSearchQuery.toLowerCase();
    return collapsedLogs.filter(log =>
      log.text.toLowerCase().includes(lowerQuery)
    );
  }, [collapsedLogs, debouncedSearchQuery]);

  // PERF: Throttle scroll handler to reduce state updates (16ms = ~60fps)
  // The actual logic is in handleScrollInner, wrapped with useThrottledCallback
  const handleScrollInner = useCallback(() => {
    if (!scrollContainerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current;
    // Consider "at bottom" if within 50px of the bottom
    const atBottom = scrollHeight - scrollTop - clientHeight < 50;
    setIsAtBottom(atBottom);

    // Notify parent when isAtBottom changes (for hasUnread logic)
    if (atBottom !== prevIsAtBottomRef.current) {
      prevIsAtBottomRef.current = atBottom;
      onAtBottomChange?.(atBottom);
    }

    // Clear new message indicator when user scrolls to bottom
    if (atBottom) {
      setHasNewMessages(false);
      setNewMessageCount(0);
      // Save read state for current tab
      if (activeTabId) {
        tabReadStateRef.current.set(activeTabId, filteredLogs.length);
      }
    }

    // Throttled scroll position save (200ms)
    if (onScrollPositionChange) {
      if (scrollSaveTimerRef.current) {
        clearTimeout(scrollSaveTimerRef.current);
      }
      scrollSaveTimerRef.current = setTimeout(() => {
        onScrollPositionChange(scrollTop);
        scrollSaveTimerRef.current = null;
      }, 200);
    }
  }, [activeTabId, filteredLogs.length, onScrollPositionChange, onAtBottomChange]);

  const handleScroll = useThrottledCallback(handleScrollInner, 16);

  // Restore read state when switching tabs
  useEffect(() => {
    if (!activeTabId) {
      // Terminal mode - just reset
      setHasNewMessages(false);
      setNewMessageCount(0);
      setIsAtBottom(true);
      lastLogCountRef.current = filteredLogs.length;
      return;
    }

    // Restore saved read state for this tab
    const savedReadCount = tabReadStateRef.current.get(activeTabId);
    const currentCount = filteredLogs.length;

    if (savedReadCount !== undefined) {
      // Tab was visited before - check for new messages since last read
      const unreadCount = currentCount - savedReadCount;
      if (unreadCount > 0) {
        setHasNewMessages(true);
        setNewMessageCount(unreadCount);
        setIsAtBottom(false);
      } else {
        setHasNewMessages(false);
        setNewMessageCount(0);
        setIsAtBottom(true);
      }
    } else {
      // First visit to this tab - mark all as read
      tabReadStateRef.current.set(activeTabId, currentCount);
      setHasNewMessages(false);
      setNewMessageCount(0);
      setIsAtBottom(true);
    }

    lastLogCountRef.current = currentCount;
  }, [activeTabId]); // Only run when tab changes, not when filteredLogs changes

  // Detect new messages when user is not at bottom (while staying on same tab)
  useEffect(() => {
    const currentCount = filteredLogs.length;
    if (currentCount > lastLogCountRef.current) {
      // Check actual scroll position, not just state (state may be stale)
      const container = scrollContainerRef.current;
      let actuallyAtBottom = isAtBottom;
      if (container) {
        const { scrollTop, scrollHeight, clientHeight } = container;
        actuallyAtBottom = scrollHeight - scrollTop - clientHeight < 50;
      }

      if (!actuallyAtBottom) {
        const newCount = currentCount - lastLogCountRef.current;
        setHasNewMessages(true);
        setNewMessageCount(prev => prev + newCount);
        // Also update isAtBottom state to match reality
        setIsAtBottom(false);
      } else {
        // At bottom, update read state
        if (activeTabId) {
          tabReadStateRef.current.set(activeTabId, currentCount);
        }
      }
    }
    lastLogCountRef.current = currentCount;
  }, [filteredLogs.length, isAtBottom, activeTabId]);

  // Auto-scroll to bottom in terminal mode when new output arrives
  // Terminal mode should always auto-scroll since users expect to see command output immediately
  useEffect(() => {
    if (session.inputMode === 'terminal' && scrollContainerRef.current) {
      // Use requestAnimationFrame to ensure DOM has updated with new content
      requestAnimationFrame(() => {
        if (scrollContainerRef.current) {
          scrollContainerRef.current.scrollTo({
            top: scrollContainerRef.current.scrollHeight,
            behavior: 'smooth'
          });
        }
      });
    }
  }, [session.inputMode, session.shellLogs.length]);

  // Restore scroll position when component mounts or initialScrollTop changes
  // Uses requestAnimationFrame to ensure DOM is ready
  useEffect(() => {
    // Only restore if we have a saved position and haven't restored yet for this mount
    if (initialScrollTop !== undefined && initialScrollTop > 0 && !hasRestoredScrollRef.current) {
      hasRestoredScrollRef.current = true;
      requestAnimationFrame(() => {
        if (scrollContainerRef.current) {
          const { scrollHeight, clientHeight } = scrollContainerRef.current;
          // Clamp to max scrollable area
          const maxScroll = Math.max(0, scrollHeight - clientHeight);
          const targetScroll = Math.min(initialScrollTop, maxScroll);
          scrollContainerRef.current.scrollTop = targetScroll;
        }
      });
    }
  }, [initialScrollTop]);

  // Reset restore flag when session/tab changes (handled by key prop on TerminalOutput)
  useEffect(() => {
    hasRestoredScrollRef.current = false;
  }, [session.id, activeTabId]);

  // Cleanup throttle timer on unmount
  useEffect(() => {
    return () => {
      if (scrollSaveTimerRef.current) {
        clearTimeout(scrollSaveTimerRef.current);
      }
    };
  }, []);

  // Scroll to bottom function
  const scrollToBottom = useCallback(() => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTo({
        top: scrollContainerRef.current.scrollHeight,
        behavior: 'smooth'
      });
      setHasNewMessages(false);
      setNewMessageCount(0);
    }
  }, []);

  // Helper to find last user command for echo stripping in terminal mode
  const getLastUserCommand = useCallback((index: number): string | undefined => {
    for (let i = index - 1; i >= 0; i--) {
      if (filteredLogs[i]?.source === 'user') {
        return filteredLogs[i].text;
      }
    }
    return undefined;
  }, [filteredLogs]);

  // Computed values for rendering
  const isTerminal = session.inputMode === 'terminal';
  const isAIMode = session.inputMode === 'ai';

  // Memoized prose styles - applied once at container level instead of per-log-item
  // IMPORTANT: Scoped to .terminal-output to avoid CSS conflicts with other prose containers (e.g., AutoRun panel)
  const proseStyles = useMemo(
    () => generateTerminalProseStyles(theme, '.terminal-output'),
    [theme]
  );

  return (
    <div
      ref={terminalOutputRef}
      tabIndex={0}
      className="terminal-output flex-1 flex flex-col overflow-hidden transition-colors outline-none relative"
      style={{ backgroundColor: session.inputMode === 'ai' ? theme.colors.bgMain : theme.colors.bgActivity }}
      onKeyDown={(e) => {
        // Cmd+F to open search
        if (e.key === 'f' && (e.metaKey || e.ctrlKey) && !outputSearchOpen) {
          e.preventDefault();
          setOutputSearchOpen(true);
          return;
        }
        // Escape handling removed - delegated to layer stack for search
        // When search is not open, Escape should still focus back to input
        if (e.key === 'Escape' && !outputSearchOpen) {
          e.preventDefault();
          e.stopPropagation();
          // Focus back to text input
          inputRef.current?.focus();
          setActiveFocus('main');
          return;
        }
        // Arrow key scrolling (instant, no smooth behavior)
        // Plain arrow keys: scroll by ~100px
        if (e.key === 'ArrowUp' && !e.metaKey && !e.ctrlKey && !e.altKey) {
          e.preventDefault();
          scrollContainerRef.current?.scrollBy({ top: -100 });
          return;
        }
        if (e.key === 'ArrowDown' && !e.metaKey && !e.ctrlKey && !e.altKey) {
          e.preventDefault();
          scrollContainerRef.current?.scrollBy({ top: 100 });
          return;
        }
        // Option/Alt+Up: page up
        if (e.key === 'ArrowUp' && e.altKey && !e.metaKey && !e.ctrlKey) {
          e.preventDefault();
          const height = terminalOutputRef.current?.clientHeight || 400;
          scrollContainerRef.current?.scrollBy({ top: -height });
          return;
        }
        // Option/Alt+Down: page down
        if (e.key === 'ArrowDown' && e.altKey && !e.metaKey && !e.ctrlKey) {
          e.preventDefault();
          const height = terminalOutputRef.current?.clientHeight || 400;
          scrollContainerRef.current?.scrollBy({ top: height });
          return;
        }
        // Cmd+Up to jump to top
        if (e.key === 'ArrowUp' && (e.metaKey || e.ctrlKey) && !e.altKey) {
          e.preventDefault();
          scrollContainerRef.current?.scrollTo({ top: 0 });
          return;
        }
        // Cmd+Down to jump to bottom
        if (e.key === 'ArrowDown' && (e.metaKey || e.ctrlKey) && !e.altKey) {
          e.preventDefault();
          const container = scrollContainerRef.current;
          if (container) {
            container.scrollTo({ top: container.scrollHeight });
          }
          return;
        }
      }}
    >
      {/* Output Search */}
      {outputSearchOpen && (
        <div className="sticky top-0 z-10 pb-4">
          <input
            type="text"
            value={outputSearchQuery}
            onChange={(e) => setOutputSearchQuery(e.target.value)}
            placeholder={isAIMode ? "Filter output... (Esc to close)" : "Search output... (Esc to close)"}
            className="w-full px-3 py-2 rounded border bg-transparent outline-none text-sm"
            style={{ borderColor: theme.colors.accent, color: theme.colors.textMain, backgroundColor: theme.colors.bgSidebar }}
            autoFocus
          />
        </div>
      )}
      {/* Prose styles for markdown rendering - injected once at container level for performance */}
      <style>{proseStyles}</style>
      {/* Native scroll log list */}
      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-y-auto scrollbar-thin"
        onScroll={handleScroll}
      >
        {/* Log entries */}
        {filteredLogs.map((log, index) => (
          <LogItemComponent
            key={log.id}
            log={log}
            index={index}
            isTerminal={isTerminal}
            isAIMode={isAIMode}
            theme={theme}
            fontFamily={fontFamily}
            maxOutputLines={maxOutputLines}
            outputSearchQuery={outputSearchQuery}
            lastUserCommand={isTerminal && log.source !== 'user' ? getLastUserCommand(index) : undefined}
            isExpanded={expandedLogs.has(log.id)}
            onToggleExpanded={toggleExpanded}
            localFilterQuery={localFilters.get(log.id) || ''}
            filterMode={filterModes.get(log.id) || { mode: 'include', regex: false }}
            activeLocalFilter={activeLocalFilter}
            onToggleLocalFilter={toggleLocalFilter}
            onSetLocalFilterQuery={setLocalFilterQuery}
            onSetFilterMode={setFilterModeForLog}
            onClearLocalFilter={clearLocalFilter}
            deleteConfirmLogId={deleteConfirmLogId}
            onDeleteLog={onDeleteLog}
            onSetDeleteConfirmLogId={setDeleteConfirmLogId}
            scrollContainerRef={scrollContainerRef}
            setLightboxImage={setLightboxImage}
            copyToClipboard={copyToClipboard}
            speakText={speakText}
            stopSpeaking={stopSpeaking}
            speakingLogId={speakingLogId}
            audioFeedbackCommand={audioFeedbackCommand}
            ansiConverter={ansiConverter}
            markdownEditMode={markdownEditMode}
            onToggleMarkdownEditMode={toggleMarkdownEditMode}
            onReplayMessage={onReplayMessage}
            fileTree={fileTree}
            cwd={cwd}
            projectRoot={projectRoot}
            onFileClick={onFileClick}
            onShowErrorDetails={onShowErrorDetails}
          />
        ))}

        {/* Terminal busy indicator - only show for terminal commands (AI thinking moved to ThinkingStatusPill) */}
        {session.state === 'busy' && session.inputMode === 'terminal' && session.busySource === 'terminal' && (
          <div
            className="flex flex-col items-center justify-center gap-2 py-6 mx-6 my-4 rounded-xl border"
            style={{
              backgroundColor: theme.colors.bgActivity,
              borderColor: theme.colors.border
            }}
          >
            <div className="flex items-center gap-3">
              <div
                className="w-2 h-2 rounded-full animate-pulse"
                style={{ backgroundColor: theme.colors.warning }}
              />
              <span className="text-sm" style={{ color: theme.colors.textMain }}>
                {session.statusMessage || 'Executing command...'}
              </span>
              {session.thinkingStartTime && (
                <ElapsedTimeDisplay
                  thinkingStartTime={session.thinkingStartTime}
                  textColor={theme.colors.textDim}
                />
              )}
            </div>
          </div>
        )}

        {/* Queued items section - only show in AI mode, filtered to active tab */}
        {session.inputMode === 'ai' && session.executionQueue && session.executionQueue.length > 0 && (
          <QueuedItemsList
            executionQueue={session.executionQueue}
            theme={theme}
            onRemoveQueuedItem={onRemoveQueuedItem}
            activeTabId={activeTabId || undefined}
          />
        )}

        {/* End ref for scrolling */}
        {session.state !== 'busy' && <div ref={logsEndRef} />}
      </div>

      {/* New Message Indicator - floating arrow button (AI mode only, terminal auto-scrolls) */}
      {hasNewMessages && !isAtBottom && session.inputMode === 'ai' && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-4 right-6 flex items-center gap-2 px-3 py-2 rounded-full shadow-lg transition-all hover:scale-105 z-20"
          style={{
            backgroundColor: theme.colors.accent,
            color: theme.colors.accentForeground,
            animation: 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite'
          }}
          title="Scroll to new messages"
        >
          <ArrowDown className="w-4 h-4" />
          {newMessageCount > 0 && (
            <span className="text-xs font-bold">
              {newMessageCount > 99 ? '99+' : newMessageCount}
            </span>
          )}
        </button>
      )}

      {/* Copied to Clipboard Notification */}
      {showCopiedNotification && (
        <div
          className="fixed top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 px-6 py-4 rounded-lg shadow-2xl text-base font-bold animate-in fade-in zoom-in-95 duration-200 z-50"
          style={{
            backgroundColor: theme.colors.accent,
            color: theme.colors.accentForeground,
            textShadow: '0 1px 2px rgba(0, 0, 0, 0.3)'
          }}
        >
          Copied to Clipboard
        </div>
      )}
    </div>
  );
}));

TerminalOutput.displayName = 'TerminalOutput';
