/**
 * iOSLogViewer - Displays iOS simulator system logs with filtering and search.
 *
 * Features:
 * - Log level filtering (error, fault, warning, info, debug)
 * - Full-text search across log messages
 * - Expandable log entries with full details
 * - Color-coded log levels
 * - Copy log entry to clipboard
 */

import React, { useState, useCallback, useMemo, memo, useRef, useEffect } from 'react';
import {
  Search,
  Filter,
  AlertCircle,
  AlertTriangle,
  Info,
  Bug,
  ChevronDown,
  ChevronRight,
  Copy,
  Check,
  XCircle,
  FileText,
} from 'lucide-react';
import type { Theme } from '../../types';

// iOS Log entry type (matches ios-tools/types.ts LogEntry)
export interface iOSLogEntry {
  timestamp: Date;
  process: string;
  pid?: number;
  level: 'default' | 'info' | 'debug' | 'error' | 'fault';
  message: string;
  subsystem?: string;
  category?: string;
}

// Log counts by level
export interface LogCounts {
  error: number;
  fault: number;
  warning: number;
  info: number;
  debug: number;
}

export interface iOSLogViewerProps {
  /** Log entries to display */
  entries: iOSLogEntry[];
  /** Log counts by level */
  counts?: LogCounts;
  /** Path to full log file */
  logFilePath?: string;
  /** Theme for styling */
  theme: Theme;
  /** Maximum height of the log viewer */
  maxHeight?: number;
}

// Log level configuration
const LOG_LEVEL_CONFIG: Record<string, { icon: React.FC<any>; label: string; colorKey: 'error' | 'warning' | 'accent' | 'textDim' }> = {
  error: { icon: XCircle, label: 'Error', colorKey: 'error' },
  fault: { icon: AlertCircle, label: 'Fault', colorKey: 'error' },
  warning: { icon: AlertTriangle, label: 'Warning', colorKey: 'warning' },
  info: { icon: Info, label: 'Info', colorKey: 'accent' },
  debug: { icon: Bug, label: 'Debug', colorKey: 'textDim' },
  default: { icon: FileText, label: 'Default', colorKey: 'textDim' },
};

/**
 * Get the color for a log level from theme
 */
function getLevelColor(level: string, theme: Theme): string {
  const config = LOG_LEVEL_CONFIG[level] || LOG_LEVEL_CONFIG.default;
  return theme.colors[config.colorKey];
}

/**
 * Format timestamp for display
 */
function formatTimestamp(date: Date): string {
  const timeStr = date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  // Add milliseconds manually
  const ms = date.getMilliseconds().toString().padStart(3, '0');
  return `${timeStr}.${ms}`;
}

/**
 * Single log entry component
 */
const LogEntryRow = memo(function LogEntryRow({
  entry,
  theme,
  isExpanded,
  onToggle,
}: {
  entry: iOSLogEntry;
  theme: Theme;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const config = LOG_LEVEL_CONFIG[entry.level] || LOG_LEVEL_CONFIG.default;
  const LevelIcon = config.icon;
  const levelColor = getLevelColor(entry.level, theme);

  // Copy log entry to clipboard
  const handleCopy = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const text = `[${entry.level.toUpperCase()}] ${formatTimestamp(entry.timestamp)} ${entry.process}: ${entry.message}`;
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [entry]);

  return (
    <div
      className="border-b last:border-b-0"
      style={{ borderColor: theme.colors.border }}
    >
      {/* Header row - always visible */}
      <div
        className="flex items-start gap-2 px-3 py-2 cursor-pointer hover:bg-white/5 transition-colors"
        onClick={onToggle}
      >
        {/* Expand/collapse chevron */}
        <button
          className="flex-shrink-0 mt-0.5"
          style={{ color: theme.colors.textDim }}
        >
          {isExpanded ? (
            <ChevronDown className="w-3 h-3" />
          ) : (
            <ChevronRight className="w-3 h-3" />
          )}
        </button>

        {/* Level icon */}
        <span className="flex-shrink-0 mt-0.5" style={{ color: levelColor }}>
          <LevelIcon className="w-3.5 h-3.5" />
        </span>

        {/* Timestamp */}
        <span
          className="flex-shrink-0 text-[10px] font-mono mt-0.5"
          style={{ color: theme.colors.textDim }}
        >
          {formatTimestamp(entry.timestamp)}
        </span>

        {/* Process name */}
        <span
          className="flex-shrink-0 text-xs font-medium truncate max-w-[120px]"
          style={{ color: theme.colors.accent }}
          title={entry.process}
        >
          {entry.process}
        </span>

        {/* Message (truncated) */}
        <span
          className="flex-1 text-xs truncate"
          style={{ color: theme.colors.textMain }}
        >
          {entry.message}
        </span>

        {/* Copy button */}
        <button
          onClick={handleCopy}
          className="flex-shrink-0 p-1 rounded hover:bg-white/10 transition-colors"
          style={{ color: copied ? theme.colors.success : theme.colors.textDim }}
          title="Copy log entry"
        >
          {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
        </button>
      </div>

      {/* Expanded details */}
      {isExpanded && (
        <div
          className="px-8 pb-3 space-y-1"
          style={{ backgroundColor: theme.colors.bgActivity }}
        >
          {/* Full message */}
          <div>
            <span className="text-[10px] uppercase font-bold" style={{ color: theme.colors.textDim }}>
              Message:
            </span>
            <p
              className="text-xs mt-0.5 font-mono break-all whitespace-pre-wrap"
              style={{ color: theme.colors.textMain }}
            >
              {entry.message}
            </p>
          </div>

          {/* Subsystem */}
          {entry.subsystem && (
            <div className="flex items-center gap-2">
              <span className="text-[10px] uppercase font-bold" style={{ color: theme.colors.textDim }}>
                Subsystem:
              </span>
              <span className="text-xs font-mono" style={{ color: theme.colors.textMain }}>
                {entry.subsystem}
              </span>
            </div>
          )}

          {/* Category */}
          {entry.category && (
            <div className="flex items-center gap-2">
              <span className="text-[10px] uppercase font-bold" style={{ color: theme.colors.textDim }}>
                Category:
              </span>
              <span className="text-xs font-mono" style={{ color: theme.colors.textMain }}>
                {entry.category}
              </span>
            </div>
          )}

          {/* PID */}
          {entry.pid && (
            <div className="flex items-center gap-2">
              <span className="text-[10px] uppercase font-bold" style={{ color: theme.colors.textDim }}>
                PID:
              </span>
              <span className="text-xs font-mono" style={{ color: theme.colors.textMain }}>
                {entry.pid}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
});

/**
 * iOS Log Viewer component
 */
export const IOSLogViewer = memo(function IOSLogViewer({
  entries,
  counts,
  logFilePath,
  theme,
  maxHeight = 400,
}: iOSLogViewerProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilters, setActiveFilters] = useState<Set<string>>(new Set(['error', 'fault', 'warning', 'info', 'debug', 'default']));
  const [expandedEntries, setExpandedEntries] = useState<Set<number>>(new Set());
  const [showFilters, setShowFilters] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Toggle a log level filter
  const toggleFilter = useCallback((level: string) => {
    setActiveFilters((prev) => {
      const next = new Set(prev);
      if (next.has(level)) {
        next.delete(level);
      } else {
        next.add(level);
      }
      return next;
    });
  }, []);

  // Toggle entry expansion
  const toggleEntry = useCallback((index: number) => {
    setExpandedEntries((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  }, []);

  // Filter and search entries
  const filteredEntries = useMemo(() => {
    return entries.filter((entry) => {
      // Level filter
      if (!activeFilters.has(entry.level)) {
        return false;
      }

      // Search filter
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        return (
          entry.message.toLowerCase().includes(query) ||
          entry.process.toLowerCase().includes(query) ||
          entry.subsystem?.toLowerCase().includes(query) ||
          entry.category?.toLowerCase().includes(query)
        );
      }

      return true;
    });
  }, [entries, activeFilters, searchQuery]);

  // Focus search on Cmd+F
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Empty state
  if (entries.length === 0) {
    return (
      <div
        className="flex flex-col items-center justify-center py-8 rounded border"
        style={{
          backgroundColor: theme.colors.bgActivity,
          borderColor: theme.colors.border,
        }}
      >
        <FileText className="w-12 h-12 mb-3" style={{ color: theme.colors.textDim }} />
        <p className="text-sm" style={{ color: theme.colors.textDim }}>
          No log entries captured
        </p>
        <p className="text-xs mt-1" style={{ color: theme.colors.textDim }}>
          Run /ios.snapshot to capture recent logs
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Summary stats */}
      {counts && (
        <div className="flex items-center gap-3 flex-wrap">
          {Object.entries(counts).map(([level, count]) => {
            if (count === 0) return null;
            const config = LOG_LEVEL_CONFIG[level] || LOG_LEVEL_CONFIG.default;
            const LevelIcon = config.icon;
            const color = getLevelColor(level, theme);
            const isActive = activeFilters.has(level);

            return (
              <button
                key={level}
                onClick={() => toggleFilter(level)}
                className={`flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-bold uppercase transition-all ${
                  isActive ? 'opacity-100' : 'opacity-40'
                }`}
                style={{
                  backgroundColor: isActive ? color + '20' : 'transparent',
                  color: isActive ? color : theme.colors.textDim,
                  border: `1px solid ${isActive ? color + '40' : theme.colors.border}`,
                }}
              >
                <LevelIcon className="w-3 h-3" />
                <span>{count}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Search and filter controls */}
      <div className="flex items-center gap-2">
        {/* Search input */}
        <div className="flex-1 relative">
          <Search
            className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4"
            style={{ color: theme.colors.textDim }}
          />
          <input
            ref={searchInputRef}
            type="text"
            placeholder="Search logs... (Cmd+F)"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-3 py-2 rounded border bg-transparent outline-none text-sm"
            style={{
              borderColor: searchQuery ? theme.colors.accent : theme.colors.border,
              color: theme.colors.textMain,
            }}
          />
        </div>

        {/* Filter toggle */}
        <button
          onClick={() => setShowFilters(!showFilters)}
          className="flex items-center gap-1.5 px-3 py-2 rounded border transition-colors hover:bg-white/5"
          style={{
            borderColor: showFilters ? theme.colors.accent : theme.colors.border,
            color: showFilters ? theme.colors.accent : theme.colors.textDim,
          }}
        >
          <Filter className="w-4 h-4" />
          <span className="text-xs">Filters</span>
        </button>
      </div>

      {/* Filter pills (when expanded) */}
      {showFilters && (
        <div className="flex items-center gap-2 flex-wrap pb-2">
          {Object.entries(LOG_LEVEL_CONFIG).map(([level, config]) => {
            const LevelIcon = config.icon;
            const color = getLevelColor(level, theme);
            const isActive = activeFilters.has(level);

            return (
              <button
                key={level}
                onClick={() => toggleFilter(level)}
                className={`flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-bold uppercase transition-all ${
                  isActive ? 'opacity-100' : 'opacity-40'
                }`}
                style={{
                  backgroundColor: isActive ? color + '20' : 'transparent',
                  color: isActive ? color : theme.colors.textDim,
                  border: `1px solid ${isActive ? color + '40' : theme.colors.border}`,
                }}
              >
                <LevelIcon className="w-3 h-3" />
                <span>{config.label}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Results count */}
      <div className="text-xs" style={{ color: theme.colors.textDim }}>
        Showing {filteredEntries.length} of {entries.length} entries
        {searchQuery && ` matching "${searchQuery}"`}
      </div>

      {/* Log entries list */}
      <div
        className="rounded border overflow-hidden overflow-y-auto scrollbar-thin"
        style={{
          borderColor: theme.colors.border,
          maxHeight,
        }}
      >
        {filteredEntries.length === 0 ? (
          <div
            className="flex items-center justify-center py-8"
            style={{ color: theme.colors.textDim }}
          >
            <p className="text-sm">No entries match the current filters</p>
          </div>
        ) : (
          filteredEntries.map((entry, index) => (
            <LogEntryRow
              key={index}
              entry={entry}
              theme={theme}
              isExpanded={expandedEntries.has(index)}
              onToggle={() => toggleEntry(index)}
            />
          ))
        )}
      </div>

      {/* Log file path */}
      {logFilePath && (
        <div
          className="flex items-center gap-2 px-2 py-1 text-[10px] font-mono truncate"
          style={{ color: theme.colors.textDim }}
          title={logFilePath}
        >
          <FileText className="w-3 h-3 flex-shrink-0" />
          <span className="truncate">{logFilePath}</span>
        </div>
      )}
    </div>
  );
});

export default IOSLogViewer;
