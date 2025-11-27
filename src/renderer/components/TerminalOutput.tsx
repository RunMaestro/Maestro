import React, { useRef, useEffect, useMemo, forwardRef, useState, useCallback } from 'react';
import { Activity, X, ChevronDown, ChevronUp, Filter, PlusCircle, MinusCircle, Trash2, Copy, Volume2 } from 'lucide-react';
import type { Session, Theme, LogEntry } from '../types';
import Convert from 'ansi-to-html';
import DOMPurify from 'dompurify';
import { useLayerStack } from '../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';

interface TerminalOutputProps {
  session: Session;
  theme: Theme;
  fontFamily: string;
  activeFocus: string;
  outputSearchOpen: boolean;
  outputSearchQuery: string;
  setOutputSearchOpen: (open: boolean) => void;
  setOutputSearchQuery: (query: string) => void;
  setActiveFocus: (focus: string) => void;
  setLightboxImage: (image: string | null, contextImages?: string[]) => void;
  inputRef: React.RefObject<HTMLTextAreaElement>;
  logsEndRef: React.RefObject<HTMLDivElement>;
  maxOutputLines: number;
  onDeleteLog?: (logId: string) => number | null; // Returns the index to scroll to after deletion
  onRemoveQueuedMessage?: (messageId: string) => void; // Callback to remove a queued message
  onInterrupt?: () => void; // Callback to interrupt the current process
  audioFeedbackCommand?: string; // TTS command for speech synthesis
}

export const TerminalOutput = forwardRef<HTMLDivElement, TerminalOutputProps>((props, ref) => {
  const {
    session, theme, fontFamily, activeFocus, outputSearchOpen, outputSearchQuery,
    setOutputSearchOpen, setOutputSearchQuery, setActiveFocus, setLightboxImage,
    inputRef, logsEndRef, maxOutputLines, onDeleteLog, onRemoveQueuedMessage, onInterrupt,
    audioFeedbackCommand
  } = props;

  // Use the forwarded ref if provided, otherwise create a local one
  const terminalOutputRef = (ref as React.RefObject<HTMLDivElement>) || useRef<HTMLDivElement>(null);

  // Virtuoso ref for programmatic scrolling
  const virtuosoRef = useRef<VirtuosoHandle>(null);

  // Track which log entries are expanded (by log ID)
  const [expandedLogs, setExpandedLogs] = useState<Set<string>>(new Set());
  // Use a ref to access current value without recreating LogItem callback
  const expandedLogsRef = useRef(expandedLogs);
  expandedLogsRef.current = expandedLogs;
  // Counter to force re-render of LogItem when expanded state changes
  const [expandedTrigger, setExpandedTrigger] = useState(0);

  // Track if any log is currently expanded (to disable auto-scroll during expansion)
  const hasExpandedLogs = expandedLogs.size > 0;

  // Track local filters per log entry (log ID -> filter query)
  const [localFilters, setLocalFilters] = useState<Map<string, string>>(new Map());
  // Use refs to access current values without recreating LogItem callback
  const localFiltersRef = useRef(localFilters);
  localFiltersRef.current = localFilters;
  const [activeLocalFilter, setActiveLocalFilter] = useState<string | null>(null);
  const activeLocalFilterRef = useRef(activeLocalFilter);
  activeLocalFilterRef.current = activeLocalFilter;
  // Counter to force re-render when local filter state changes
  const [filterTrigger, setFilterTrigger] = useState(0);

  // Track filter modes per log entry (log ID -> {mode: 'include'|'exclude', regex: boolean})
  const [filterModes, setFilterModes] = useState<Map<string, { mode: 'include' | 'exclude'; regex: boolean }>>(new Map());
  const filterModesRef = useRef(filterModes);
  filterModesRef.current = filterModes;

  // Delete confirmation state
  const [deleteConfirmLogId, setDeleteConfirmLogId] = useState<string | null>(null);
  const deleteConfirmLogIdRef = useRef(deleteConfirmLogId);
  deleteConfirmLogIdRef.current = deleteConfirmLogId;
  // Counter to force re-render when delete confirmation changes
  const [deleteConfirmTrigger, setDeleteConfirmTrigger] = useState(0);

  // Queue removal confirmation state
  const [queueRemoveConfirmId, setQueueRemoveConfirmId] = useState<string | null>(null);

  // Copy to clipboard notification state
  const [showCopiedNotification, setShowCopiedNotification] = useState(false);

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
  const speakText = useCallback(async (text: string) => {
    console.log('[TTS] speakText called, text length:', text.length, 'command:', audioFeedbackCommand);
    if (!audioFeedbackCommand) {
      console.log('[TTS] No audioFeedbackCommand configured, skipping');
      return;
    }
    try {
      const result = await window.maestro.notification.speak(text, audioFeedbackCommand);
      console.log('[TTS] Speak result:', result);
    } catch (err) {
      console.error('[TTS] Failed to speak text:', err);
    }
  }, [audioFeedbackCommand]);

  // Elapsed time for thinking indicator (in seconds)
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  // Update elapsed time when session is busy
  useEffect(() => {
    if (session.state === 'busy' && session.thinkingStartTime) {
      // Set initial elapsed time
      setElapsedSeconds(Math.floor((Date.now() - session.thinkingStartTime) / 1000));

      // Update every second
      const interval = setInterval(() => {
        setElapsedSeconds(Math.floor((Date.now() - session.thinkingStartTime!) / 1000));
      }, 1000);

      return () => clearInterval(interval);
    } else {
      setElapsedSeconds(0);
    }
  }, [session.state, session.thinkingStartTime]);

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

  // Helper function to highlight search matches in text
  const highlightMatches = (text: string, query: string): React.ReactNode => {
    if (!query) return text;

    const parts: React.ReactNode[] = [];
    let lastIndex = 0;
    const lowerText = text.toLowerCase();
    const lowerQuery = query.toLowerCase();
    let searchIndex = 0;

    while (searchIndex < lowerText.length) {
      const index = lowerText.indexOf(lowerQuery, searchIndex);
      if (index === -1) break;

      // Add text before match
      if (index > lastIndex) {
        parts.push(text.substring(lastIndex, index));
      }

      // Add highlighted match
      parts.push(
        <span
          key={`match-${index}`}
          style={{
            backgroundColor: theme.colors.warning,
            color: theme.mode === 'light' ? '#fff' : '#000',
            padding: '1px 2px',
            borderRadius: '2px'
          }}
        >
          {text.substring(index, index + query.length)}
        </span>
      );

      lastIndex = index + query.length;
      searchIndex = lastIndex;
    }

    // Add remaining text
    if (lastIndex < text.length) {
      parts.push(text.substring(lastIndex));
    }

    return parts.length > 0 ? parts : text;
  };

  // Helper function to add search highlighting markers to text (before ANSI conversion)
  // Uses special markers that survive ANSI-to-HTML conversion
  const addHighlightMarkers = (text: string, query: string): string => {
    if (!query) return text;

    let result = '';
    let lastIndex = 0;
    const lowerText = text.toLowerCase();
    const lowerQuery = query.toLowerCase();
    let searchIndex = 0;

    while (searchIndex < lowerText.length) {
      const index = lowerText.indexOf(lowerQuery, searchIndex);
      if (index === -1) break;

      // Add text before match
      result += text.substring(lastIndex, index);

      // Add marked match with special tags
      result += `<mark style="background-color: ${theme.colors.warning}; color: ${theme.mode === 'light' ? '#fff' : '#000'}; padding: 1px 2px; border-radius: 2px;">`;
      result += text.substring(index, index + query.length);
      result += '</mark>';

      lastIndex = index + query.length;
      searchIndex = lastIndex;
    }

    // Add remaining text
    result += text.substring(lastIndex);

    return result;
  };

  // Helper function to filter text by lines containing the query (local filter)
  const filterTextByLines = (text: string, query: string, mode: 'include' | 'exclude', useRegex: boolean): string => {
    if (!query) return text;

    const lines = text.split('\n');

    try {
      if (useRegex) {
        // Use regex matching
        const regex = new RegExp(query, 'i');
        const filteredLines = lines.filter(line => {
          const matches = regex.test(line);
          return mode === 'include' ? matches : !matches;
        });
        return filteredLines.join('\n');
      } else {
        // Use plain text matching
        const lowerQuery = query.toLowerCase();
        const filteredLines = lines.filter(line => {
          const matches = line.toLowerCase().includes(lowerQuery);
          return mode === 'include' ? matches : !matches;
        });
        return filteredLines.join('\n');
      }
    } catch (error) {
      // If regex is invalid, fall back to plain text matching
      const lowerQuery = query.toLowerCase();
      const filteredLines = lines.filter(line => {
        const matches = line.toLowerCase().includes(lowerQuery);
        return mode === 'include' ? matches : !matches;
      });
      return filteredLines.join('\n');
    }
  };

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

  // Process carriage returns to simulate terminal line overwrites
  // When \r appears (not followed by \n), it means "return to start of line"
  // and subsequent text overwrites from the beginning
  const processCarriageReturns = (text: string): string => {
    // Split by newlines first, then process each line for carriage returns
    const lines = text.split('\n');
    const processedLines = lines.map(line => {
      // If line contains \r (but not \r\n which was already converted to \n),
      // split by \r and take the last non-empty segment (the final overwrite)
      if (line.includes('\r')) {
        const segments = line.split('\r');
        // Find the last non-empty segment (the final state of the line)
        for (let i = segments.length - 1; i >= 0; i--) {
          if (segments[i].trim()) {
            return segments[i];
          }
        }
        // If all segments are empty, return empty string
        return '';
      }
      return line;
    });
    return processedLines.join('\n');
  };

  // Filter out bash prompt lines and apply processing
  const processLogText = (text: string, isTerminal: boolean): string => {
    // Always process carriage returns (for AI status lines like "Claude is thinking...")
    let processed = processCarriageReturns(text);

    if (!isTerminal) return processed;

    // Remove bash prompt lines (e.g., "bash-3.2$", "zsh%", "$", "#")
    const lines = processed.split('\n');
    const filteredLines = lines.filter(line => {
      const trimmed = line.trim();
      // Skip empty lines and common prompt patterns
      if (!trimmed) return false;
      if (/^(bash-\d+\.\d+\$|zsh[%#]|\$|#)\s*$/.test(trimmed)) return false;
      return true;
    });

    return filteredLines.join('\n');
  };

  const activeLogs: LogEntry[] = session.inputMode === 'ai' ? session.aiLogs : session.shellLogs;

  // In AI mode, collapse consecutive non-user entries into single response blocks
  // This provides a cleaner view where each user message gets one response
  const collapsedLogs = useMemo(() => {
    // Only collapse in AI mode
    if (session.inputMode !== 'ai') return activeLogs;

    const result: LogEntry[] = [];
    let currentResponseGroup: LogEntry[] = [];

    for (const log of activeLogs) {
      if (log.source === 'user') {
        // Flush any accumulated response group
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
        result.push(log);
      } else {
        // Accumulate non-user entries (AI responses)
        currentResponseGroup.push(log);
      }
    }

    // Flush final response group
    if (currentResponseGroup.length > 0) {
      const combinedText = currentResponseGroup.map(l => l.text).join('');
      result.push({
        ...currentResponseGroup[0],
        text: combinedText,
      });
    }

    return result;
  }, [activeLogs, session.inputMode]);

  // Filter logs based on search query - memoized for performance
  const filteredLogs = useMemo(() => {
    if (!outputSearchQuery) return collapsedLogs;
    return collapsedLogs.filter(log =>
      log.text.toLowerCase().includes(outputSearchQuery.toLowerCase())
    );
  }, [collapsedLogs, outputSearchQuery]);

  // Auto-scroll to bottom when new logs are added (not when deleted)
  // Initialize to 0 so that on first load with existing logs, we scroll to bottom
  const prevLogCountRef = useRef(0);
  useEffect(() => {
    // Don't auto-scroll if user has expanded logs (viewing full content)
    if (hasExpandedLogs) {
      prevLogCountRef.current = filteredLogs.length;
      return;
    }
    // Only scroll when new logs are added, not when deleted
    if (filteredLogs.length > prevLogCountRef.current && filteredLogs.length > 0) {
      // Use setTimeout to ensure scroll happens after render
      setTimeout(() => {
        virtuosoRef.current?.scrollToIndex({
          index: filteredLogs.length - 1,
          align: 'end',
          behavior: 'auto'
        });
      }, 0);
    }
    prevLogCountRef.current = filteredLogs.length;
  }, [filteredLogs.length, hasExpandedLogs]);

  // Auto-scroll to bottom when session becomes busy to show thinking indicator
  const prevBusyStateRef = useRef(session.state === 'busy');
  useEffect(() => {
    // Don't auto-scroll if user has expanded logs (viewing full content)
    if (hasExpandedLogs) {
      prevBusyStateRef.current = session.state === 'busy';
      return;
    }
    const isBusy = session.state === 'busy';
    // Scroll when transitioning to busy state
    if (isBusy && !prevBusyStateRef.current) {
      // Use setTimeout to ensure scroll happens after the Footer renders
      setTimeout(() => {
        virtuosoRef.current?.scrollToIndex({
          index: Math.max(0, filteredLogs.length - 1),
          align: 'end',
          behavior: 'auto'
        });
      }, 50);
    }
    prevBusyStateRef.current = isBusy;
  }, [session.state, filteredLogs.length, hasExpandedLogs]);

  // Auto-scroll to bottom when message queue changes
  const prevQueueLengthRef = useRef(session.messageQueue?.length || 0);
  useEffect(() => {
    // Don't auto-scroll if user has expanded logs (viewing full content)
    if (hasExpandedLogs) {
      prevQueueLengthRef.current = session.messageQueue?.length || 0;
      return;
    }
    const queueLength = session.messageQueue?.length || 0;
    // Scroll when new messages are added to the queue
    if (queueLength > prevQueueLengthRef.current) {
      setTimeout(() => {
        virtuosoRef.current?.scrollToIndex({
          index: Math.max(0, filteredLogs.length - 1),
          align: 'end',
          behavior: 'auto'
        });
      }, 50);
    }
    prevQueueLengthRef.current = queueLength;
  }, [session.messageQueue?.length, filteredLogs.length, hasExpandedLogs]);

  // Render a single log item - used by Virtuoso
  const LogItem = useCallback(({ index, log }: { index: number; log: LogEntry }) => {
    const isTerminal = session.inputMode === 'terminal';

    // Find the most recent user command before this log entry (for echo stripping)
    let lastUserCommand: string | undefined;
    if (isTerminal && log.source !== 'user') {
      for (let i = index - 1; i >= 0; i--) {
        if (filteredLogs[i].source === 'user') {
          lastUserCommand = filteredLogs[i].text;
          break;
        }
      }
    }

    // Strip command echo from terminal output
    let textToProcess = log.text;
    if (isTerminal && log.source !== 'user' && lastUserCommand) {
      // Remove command echo from beginning of output
      if (textToProcess.startsWith(lastUserCommand)) {
        textToProcess = textToProcess.slice(lastUserCommand.length);
        // Remove newline after command
        if (textToProcess.startsWith('\r\n')) {
          textToProcess = textToProcess.slice(2);
        } else if (textToProcess.startsWith('\n') || textToProcess.startsWith('\r')) {
          textToProcess = textToProcess.slice(1);
        }
      }
    }

    const processedText = processLogText(textToProcess, isTerminal && log.source !== 'user');

    // Skip rendering stderr entries that have no actual content
    if (log.source === 'stderr' && !processedText.trim()) {
      return null;
    }

    // Separate stdout and stderr for terminal output
    const separated = log.source === 'stderr'
      ? { stdout: '', stderr: processedText }
      : { stdout: processedText, stderr: '' };

    // Apply local filter if active for this log entry (use refs for stable callback)
    const localFilterQuery = localFiltersRef.current.get(log.id) || '';
    const filterMode = filterModesRef.current.get(log.id) || { mode: 'include', regex: false };
    const filteredStdout = localFilterQuery && log.source !== 'user'
      ? filterTextByLines(separated.stdout, localFilterQuery, filterMode.mode, filterMode.regex)
      : separated.stdout;
    const filteredStderr = localFilterQuery && log.source !== 'user'
      ? filterTextByLines(separated.stderr, localFilterQuery, filterMode.mode, filterMode.regex)
      : separated.stderr;

    // Check if filter returned no results
    const hasNoMatches = localFilterQuery && !filteredStdout.trim() && !filteredStderr.trim() && log.source !== 'user';

    // Apply search highlighting before ANSI conversion for terminal output
    const stdoutWithHighlights = isTerminal && log.source !== 'user' && outputSearchQuery
      ? addHighlightMarkers(filteredStdout, outputSearchQuery)
      : filteredStdout;

    // Convert ANSI codes to HTML for terminal output and sanitize
    const stdoutHtmlContent = isTerminal && log.source !== 'user'
      ? DOMPurify.sanitize(ansiConverter.toHtml(stdoutWithHighlights))
      : filteredStdout;

    const htmlContent = stdoutHtmlContent;
    const filteredText = filteredStdout;

    // Count lines in the filtered text
    const lineCount = filteredText.split('\n').length;
    const shouldCollapse = lineCount > maxOutputLines && maxOutputLines !== Infinity;
    const isExpanded = expandedLogsRef.current.has(log.id);

    // Truncate text if collapsed
    const displayText = shouldCollapse && !isExpanded
      ? filteredText.split('\n').slice(0, maxOutputLines).join('\n')
      : filteredText;

    // Apply highlighting to truncated text as well
    const displayTextWithHighlights = shouldCollapse && !isExpanded && isTerminal && log.source !== 'user' && outputSearchQuery
      ? addHighlightMarkers(displayText, outputSearchQuery)
      : displayText;

    const displayHtmlContent = shouldCollapse && !isExpanded && isTerminal && log.source !== 'user'
      ? DOMPurify.sanitize(ansiConverter.toHtml(displayTextWithHighlights))
      : htmlContent;

    // In AI mode, user messages go right with timestamp on the right
    // In terminal mode, user commands still have the $ prefix style
    const isAIMode = session.inputMode === 'ai';
    const isUserMessage = log.source === 'user';

    return (
      <div className={`flex gap-4 group ${isUserMessage ? 'flex-row-reverse' : ''} px-6 py-2`}>
        <div className={`w-12 shrink-0 text-[10px] pt-2 ${isUserMessage ? 'text-right' : 'text-left'}`}
             style={{ fontFamily, color: theme.colors.textDim, opacity: 0.6 }}>
          {new Date(log.timestamp).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}
        </div>
        <div className={`flex-1 p-4 rounded-xl border ${isUserMessage ? 'rounded-tr-none' : 'rounded-tl-none'} relative`}
             style={{
               backgroundColor: isUserMessage
                 ? isAIMode
                   ? `color-mix(in srgb, ${theme.colors.accent} 20%, ${theme.colors.bgSidebar})`
                   : `color-mix(in srgb, ${theme.colors.accent} 15%, ${theme.colors.bgActivity})`
                 : log.source === 'stderr'
                   ? `color-mix(in srgb, ${theme.colors.error} 8%, ${theme.colors.bgActivity})`
                   : isAIMode ? theme.colors.bgActivity : 'transparent',
               borderColor: isUserMessage && isAIMode
                 ? theme.colors.accent + '40'
                 : log.source === 'stderr' ? theme.colors.error : theme.colors.border
             }}>
          {/* Delete button for user commands */}
          {log.source === 'user' && isTerminal && onDeleteLog && (
            <div className="absolute top-2 right-2 flex items-center gap-2">
              {deleteConfirmLogIdRef.current === log.id ? (
                <div className="flex items-center gap-2 p-1 rounded border" style={{ backgroundColor: theme.colors.bgSidebar, borderColor: theme.colors.error }}>
                  <span className="text-xs px-1" style={{ color: theme.colors.error }}>Delete?</span>
                  <button
                    onClick={() => {
                      const nextIndex = onDeleteLog(log.id);
                      setDeleteConfirmLogId(null);
                      setDeleteConfirmTrigger(t => t + 1);
                      // Scroll to the next user command after deletion
                      if (nextIndex !== null && nextIndex >= 0) {
                        setTimeout(() => {
                          virtuosoRef.current?.scrollToIndex({
                            index: nextIndex,
                            align: 'start',
                            behavior: 'auto'
                          });
                        }, 50);
                      }
                    }}
                    className="px-2 py-0.5 rounded text-xs font-medium hover:opacity-80"
                    style={{ backgroundColor: theme.colors.error, color: '#fff' }}
                  >
                    Yes
                  </button>
                  <button
                    onClick={() => { setDeleteConfirmLogId(null); setDeleteConfirmTrigger(t => t + 1); }}
                    className="px-2 py-0.5 rounded text-xs hover:opacity-80"
                    style={{ color: theme.colors.textDim }}
                  >
                    No
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => { setDeleteConfirmLogId(log.id); setDeleteConfirmTrigger(t => t + 1); }}
                  className="p-1.5 rounded opacity-0 group-hover:opacity-50 hover:!opacity-100 transition-opacity"
                  style={{ color: theme.colors.textDim }}
                  title="Delete command and output"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          )}
          {/* Local filter icon for system output only */}
          {log.source !== 'user' && isTerminal && (
            <div className="absolute top-2 right-2 flex items-center gap-2">
              {activeLocalFilterRef.current === log.id || localFilterQuery ? (
                <div className="flex items-center gap-2 p-2 rounded border" style={{ backgroundColor: theme.colors.bgSidebar, borderColor: theme.colors.border }}>
                  <button
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setFilterModes(prev => {
                        const newMap = new Map(prev);
                        const current = newMap.get(log.id) || { mode: 'include', regex: false };
                        newMap.set(log.id, { ...current, mode: current.mode === 'include' ? 'exclude' : 'include' });
                        return newMap;
                      });
                    }}
                    className="p-1 rounded hover:opacity-70 transition-opacity"
                    style={{ color: filterMode.mode === 'include' ? theme.colors.success : theme.colors.error }}
                    title={filterMode.mode === 'include' ? 'Include matching lines' : 'Exclude matching lines'}
                  >
                    {filterMode.mode === 'include' ? <PlusCircle className="w-3.5 h-3.5" /> : <MinusCircle className="w-3.5 h-3.5" />}
                  </button>
                  <button
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setFilterModes(prev => {
                        const newMap = new Map(prev);
                        const current = newMap.get(log.id) || { mode: 'include', regex: false };
                        newMap.set(log.id, { ...current, regex: !current.regex });
                        return newMap;
                      });
                    }}
                    className="px-2 py-1 rounded hover:opacity-70 transition-opacity text-xs font-bold"
                    style={{ fontFamily, color: filterMode.regex ? theme.colors.accent : theme.colors.textDim }}
                    title={filterMode.regex ? 'Using regex' : 'Using plain text'}
                  >
                    {filterMode.regex ? '.*' : 'Aa'}
                  </button>
                  <input
                    type="text"
                    value={localFilterQuery}
                    onChange={(e) => setLocalFilterQuery(log.id, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        e.stopPropagation();
                        setActiveLocalFilter(null);
                        setLocalFilterQuery(log.id, '');
                        setFilterModes(prev => {
                          const newMap = new Map(prev);
                          newMap.delete(log.id);
                          return newMap;
                        });
                      }
                    }}
                    onBlur={() => {
                      if (!localFilterQuery) {
                        setActiveLocalFilter(null);
                      }
                    }}
                    placeholder={
                      filterMode.mode === 'include'
                        ? (filterMode.regex ? "Include by RegEx" : "Include by keyword")
                        : (filterMode.regex ? "Exclude by RegEx" : "Exclude by keyword")
                    }
                    className="w-40 px-2 py-1 text-xs rounded border bg-transparent outline-none"
                    style={{
                      borderColor: theme.colors.accent,
                      color: theme.colors.textMain,
                      backgroundColor: theme.colors.bgMain
                    }}
                    autoFocus={activeLocalFilterRef.current === log.id}
                  />
                  <button
                    onClick={() => {
                      setActiveLocalFilter(null);
                      setLocalFilterQuery(log.id, '');
                      setFilterModes(prev => {
                        const newMap = new Map(prev);
                        newMap.delete(log.id);
                        return newMap;
                      });
                    }}
                    className="p-1 rounded hover:opacity-70 transition-opacity"
                    style={{ color: theme.colors.textDim }}
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => toggleLocalFilter(log.id)}
                  className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-opacity-10 transition-opacity"
                  style={{
                    color: localFilterQuery ? theme.colors.accent : theme.colors.textDim,
                    backgroundColor: localFilterQuery ? theme.colors.bgActivity : 'transparent'
                  }}
                  title="Filter this output"
                >
                  <Filter className="w-3 h-3" />
                </button>
              )}
            </div>
          )}
          {log.images && log.images.length > 0 && (
            <div className="flex gap-2 mb-2 overflow-x-auto scrollbar-thin">
              {log.images.map((img, imgIdx) => (
                <img key={imgIdx} src={img} className="h-20 rounded border cursor-zoom-in" onClick={() => setLightboxImage(img, log.images)} />
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
          {hasNoMatches ? (
            <div className="flex items-center justify-center py-8 text-sm" style={{ color: theme.colors.textDim }}>
              <span>No matches found for filter</span>
            </div>
          ) : shouldCollapse && !isExpanded ? (
            <div>
              <div
                className={`${isTerminal && log.source !== 'user' ? 'whitespace-pre-wrap text-sm overflow-x-auto' : 'whitespace-pre-wrap text-sm'}`}
                style={{
                  maxHeight: `${maxOutputLines * 1.5}em`,
                  overflow: 'hidden',
                  color: theme.colors.textMain,
                  fontFamily
                }}
              >
                {isTerminal && log.source !== 'user' ? (
                  <div dangerouslySetInnerHTML={{ __html: displayHtmlContent }} />
                ) : (
                  displayText
                )}
              </div>
              <button
                onClick={() => toggleExpanded(log.id)}
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
                className={`${isTerminal && log.source !== 'user' ? 'whitespace-pre-wrap text-sm overflow-x-auto scrollbar-thin' : 'whitespace-pre-wrap text-sm'}`}
                style={{
                  maxHeight: '600px',
                  overflow: 'auto',
                  color: theme.colors.textMain,
                  fontFamily
                }}
              >
                {isTerminal && log.source !== 'user' ? (
                  <div dangerouslySetInnerHTML={{ __html: displayHtmlContent }} />
                ) : log.source === 'user' && isTerminal ? (
                  <div style={{ fontFamily }}>
                    <span style={{ color: theme.colors.accent }}>$ </span>
                    {highlightMatches(filteredText, outputSearchQuery)}
                  </div>
                ) : (
                  <div>{highlightMatches(filteredText, outputSearchQuery)}</div>
                )}
              </div>
              <button
                onClick={() => toggleExpanded(log.id)}
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
                <div
                  className="whitespace-pre-wrap text-sm overflow-x-auto scrollbar-thin"
                  dangerouslySetInnerHTML={{ __html: displayHtmlContent }}
                  style={{ color: theme.colors.textMain, fontFamily }}
                />
              ) : log.source === 'user' && isTerminal ? (
                <div className="whitespace-pre-wrap text-sm" style={{ color: theme.colors.textMain, fontFamily }}>
                  <span style={{ color: theme.colors.accent }}>$ </span>
                  {highlightMatches(filteredText, outputSearchQuery)}
                </div>
              ) : (
                <div className="whitespace-pre-wrap text-sm" style={{ color: theme.colors.textMain }}>
                  {highlightMatches(filteredText, outputSearchQuery)}
                </div>
              )}
            </>
          )}
          {/* Action buttons - bottom right corner */}
          <div
            className="absolute bottom-2 right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100"
            style={{ transition: 'opacity 0.15s ease-in-out' }}
          >
            {/* Speak Button - only show for non-user messages when TTS is configured */}
            {audioFeedbackCommand && log.source !== 'user' && (
              <button
                onClick={() => speakText(log.text)}
                className="p-1.5 rounded opacity-50 hover:opacity-100"
                style={{ color: theme.colors.textDim }}
                title="Speak text"
              >
                <Volume2 className="w-3.5 h-3.5" />
              </button>
            )}
            {/* Copy to Clipboard Button */}
            <button
              onClick={() => copyToClipboard(log.text)}
              className="p-1.5 rounded opacity-50 hover:opacity-100"
              style={{ color: theme.colors.textDim }}
              title="Copy to clipboard"
            >
              <Copy className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>
    );
  // Note: We use refs (expandedLogsRef, localFiltersRef, filterModesRef, deleteConfirmLogIdRef, activeLocalFilterRef)
  // instead of state values in the dependency array to prevent unnecessary re-renders when these change.
  // The refs are updated synchronously before render, so LogItem always has access to current values.
  // We use trigger counters (expandedTrigger, filterTrigger, deleteConfirmTrigger) to force re-renders when needed.
  }, [session.inputMode, filteredLogs, theme, fontFamily, outputSearchQuery, maxOutputLines, onDeleteLog, ansiConverter,
      toggleExpanded, toggleLocalFilter, setLocalFilterQuery, setLightboxImage, highlightMatches,
      addHighlightMarkers, filterTextByLines, processLogText, copyToClipboard, speakText, audioFeedbackCommand,
      expandedTrigger, filterTrigger, deleteConfirmTrigger]);

  return (
    <div
      ref={terminalOutputRef}
      tabIndex={0}
      className="flex-1 flex flex-col overflow-hidden transition-colors outline-none relative"
      style={{ backgroundColor: session.inputMode === 'ai' ? theme.colors.bgMain : theme.colors.bgActivity }}
      onKeyDown={(e) => {
        // / to open search
        if (e.key === '/' && !outputSearchOpen) {
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
        // Arrow key scrolling via Virtuoso (instant, no smooth behavior)
        // Plain arrow keys: scroll by ~100px
        if (e.key === 'ArrowUp' && !e.metaKey && !e.ctrlKey && !e.altKey) {
          e.preventDefault();
          virtuosoRef.current?.scrollBy({ top: -100 });
          return;
        }
        if (e.key === 'ArrowDown' && !e.metaKey && !e.ctrlKey && !e.altKey) {
          e.preventDefault();
          virtuosoRef.current?.scrollBy({ top: 100 });
          return;
        }
        // Option/Alt+Up: page up
        if (e.key === 'ArrowUp' && e.altKey && !e.metaKey && !e.ctrlKey) {
          e.preventDefault();
          const height = terminalOutputRef.current?.clientHeight || 400;
          virtuosoRef.current?.scrollBy({ top: -height });
          return;
        }
        // Option/Alt+Down: page down
        if (e.key === 'ArrowDown' && e.altKey && !e.metaKey && !e.ctrlKey) {
          e.preventDefault();
          const height = terminalOutputRef.current?.clientHeight || 400;
          virtuosoRef.current?.scrollBy({ top: height });
          return;
        }
        // Cmd+Up to jump to top
        if (e.key === 'ArrowUp' && (e.metaKey || e.ctrlKey) && !e.altKey) {
          e.preventDefault();
          virtuosoRef.current?.scrollToIndex({ index: 0, align: 'start' });
          return;
        }
        // Cmd+Down to jump to bottom
        if (e.key === 'ArrowDown' && (e.metaKey || e.ctrlKey) && !e.altKey) {
          e.preventDefault();
          if (filteredLogs.length > 0) {
            virtuosoRef.current?.scrollToIndex({ index: filteredLogs.length - 1, align: 'end' });
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
            placeholder="Filter output... (Esc to close)"
            className="w-full px-3 py-2 rounded border bg-transparent outline-none text-sm"
            style={{ borderColor: theme.colors.accent, color: theme.colors.textMain, backgroundColor: theme.colors.bgSidebar }}
            autoFocus
          />
        </div>
      )}
      {/* Virtualized log list */}
      <Virtuoso
        ref={virtuosoRef}
        data={filteredLogs}
        className="flex-1"
        increaseViewportBy={{ top: 200, bottom: 200 }}
        followOutput={() => {
          // Don't auto-scroll if user has expanded logs (viewing full content)
          if (hasExpandedLogs) return false;
          // Don't follow output - we handle scrolling manually
          return false;
        }}
        computeItemKey={(index, log) => log.id}
        itemContent={(index, log) => <LogItem index={index} log={log} />}
        components={{
          Footer: () => (
            <>
              {/* Busy indicator */}
              {session.state === 'busy' && (
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
                      {session.statusMessage || (session.inputMode === 'ai' ? 'Claude is thinking...' : 'Executing command...')}
                    </span>
                    <span
                      className="text-sm font-mono"
                      style={{ color: theme.colors.textDim }}
                    >
                      {formatElapsedTime(elapsedSeconds)}
                    </span>
                  </div>
                  {session.inputMode === 'ai' && session.usageStats && (
                    <div className="flex items-center gap-4 mt-1 text-xs" style={{ color: theme.colors.textDim }}>
                      <span>In: {session.usageStats.inputTokens.toLocaleString()}</span>
                      <span>Out: {session.usageStats.outputTokens.toLocaleString()}</span>
                      <span>Total: {(session.usageStats.inputTokens + session.usageStats.outputTokens).toLocaleString()}</span>
                    </div>
                  )}
                </div>
              )}

              {/* Queued messages section */}
              {session.messageQueue && session.messageQueue.length > 0 && (
                <>
                  {/* QUEUED separator */}
                  <div className="mx-6 my-3 flex items-center gap-3">
                    <div className="flex-1 h-px" style={{ backgroundColor: theme.colors.border }} />
                    <span
                      className="text-xs font-bold tracking-wider"
                      style={{ color: theme.colors.warning }}
                    >
                      QUEUED
                    </span>
                    <div className="flex-1 h-px" style={{ backgroundColor: theme.colors.border }} />
                  </div>

                  {/* Queued messages */}
                  {session.messageQueue.map((msg) => (
                    <div
                      key={msg.id}
                      className="mx-6 mb-2 p-3 rounded-lg opacity-60 relative group"
                      style={{
                        backgroundColor: theme.colors.accent + '20',
                        borderLeft: `3px solid ${theme.colors.accent}`
                      }}
                    >
                      {/* Remove button */}
                      <button
                        onClick={() => setQueueRemoveConfirmId(msg.id)}
                        className="absolute top-2 right-2 p-1 rounded hover:bg-black/20 transition-colors"
                        style={{ color: theme.colors.textDim }}
                        title="Remove from queue"
                      >
                        <X className="w-4 h-4" />
                      </button>

                      {/* Message content */}
                      <div
                        className="text-sm pr-8 whitespace-pre-wrap break-words"
                        style={{ color: theme.colors.textMain }}
                      >
                        {msg.text.length > 200 ? msg.text.substring(0, 200) + '...' : msg.text}
                      </div>

                      {/* Images indicator */}
                      {msg.images && msg.images.length > 0 && (
                        <div
                          className="mt-1 text-xs"
                          style={{ color: theme.colors.textDim }}
                        >
                          {msg.images.length} image{msg.images.length > 1 ? 's' : ''} attached
                        </div>
                      )}
                    </div>
                  ))}

                  {/* Queue removal confirmation modal */}
                  {queueRemoveConfirmId && (
                    <div
                      className="fixed inset-0 flex items-center justify-center z-50"
                      style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}
                      onClick={() => setQueueRemoveConfirmId(null)}
                    >
                      <div
                        className="p-4 rounded-lg shadow-xl max-w-md mx-4"
                        style={{ backgroundColor: theme.colors.bgMain }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <h3 className="text-lg font-semibold mb-2" style={{ color: theme.colors.textMain }}>
                          Remove Queued Message?
                        </h3>
                        <p className="text-sm mb-4" style={{ color: theme.colors.textDim }}>
                          This message will be removed from the queue and will not be sent.
                        </p>
                        <div className="flex gap-2 justify-end">
                          <button
                            onClick={() => setQueueRemoveConfirmId(null)}
                            className="px-3 py-1.5 rounded text-sm"
                            style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textMain }}
                          >
                            Cancel
                          </button>
                          <button
                            onClick={() => {
                              if (onRemoveQueuedMessage) {
                                onRemoveQueuedMessage(queueRemoveConfirmId);
                              }
                              setQueueRemoveConfirmId(null);
                            }}
                            className="px-3 py-1.5 rounded text-sm"
                            style={{ backgroundColor: theme.colors.error, color: 'white' }}
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </>
              )}

              {/* End ref for scrolling */}
              {session.state !== 'busy' && <div ref={logsEndRef} />}
            </>
          )
        }}
      />

      {/* Copied to Clipboard Notification */}
      {showCopiedNotification && (
        <div
          className="fixed top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 px-6 py-4 rounded-lg shadow-2xl text-base font-bold animate-in fade-in zoom-in-95 duration-200 z-50"
          style={{
            backgroundColor: theme.colors.accent,
            color: '#FFFFFF',
            textShadow: '0 1px 2px rgba(0, 0, 0, 0.3)'
          }}
        >
          Copied to Clipboard
        </div>
      )}
    </div>
  );
});

TerminalOutput.displayName = 'TerminalOutput';
