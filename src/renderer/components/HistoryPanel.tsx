import React, { useState, useEffect, useRef, useCallback, useImperativeHandle, forwardRef, useMemo } from 'react';
import { Bot, User, ExternalLink, Check, X, Clock, HelpCircle, RefreshCw } from 'lucide-react';
import type { Session, Theme, HistoryEntry, HistoryEntryType } from '../types';
import { HistoryDetailModal } from './HistoryDetailModal';
import { HistoryHelpModal } from './HistoryHelpModal';

// Double checkmark SVG component for validated entries
const DoubleCheck = ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
  <svg className={className} style={style} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="15 6 6 17 1 12" />
    <polyline points="23 6 14 17 11 14" />
  </svg>
);

// Format elapsed time in human-readable format
const formatElapsedTime = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
};

// 24-hour activity bar graph component with sliding time window
interface ActivityGraphProps {
  entries: HistoryEntry[];
  theme: Theme;
  referenceTime?: number; // The "end" of the 24-hour window (defaults to now)
  onBarClick?: (bucketStartTime: number, bucketEndTime: number) => void;
}

const ActivityGraph: React.FC<ActivityGraphProps> = ({ entries, theme, referenceTime, onBarClick }) => {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  // Use referenceTime as the end of our window, or current time if not provided
  const endTime = referenceTime || Date.now();

  // Group entries by hour for the 24-hour window ending at referenceTime
  const hourlyData = useMemo(() => {
    const msPerHour = 60 * 60 * 1000;
    const hours24Ago = endTime - (24 * msPerHour);

    // Initialize 24 buckets (index 0 = 24 hours before endTime, index 23 = endTime hour)
    const buckets: { auto: number; user: number }[] = Array.from({ length: 24 }, () => ({ auto: 0, user: 0 }));

    // Filter to the 24-hour window and bucket by hour
    entries.forEach(entry => {
      if (entry.timestamp >= hours24Ago && entry.timestamp <= endTime) {
        const hoursAgo = Math.floor((endTime - entry.timestamp) / msPerHour);
        const bucketIndex = 23 - hoursAgo; // Convert to 0-indexed from oldest to newest
        if (bucketIndex >= 0 && bucketIndex < 24) {
          if (entry.type === 'AUTO') {
            buckets[bucketIndex].auto++;
          } else if (entry.type === 'USER') {
            buckets[bucketIndex].user++;
          }
        }
      }
    });

    return buckets;
  }, [entries, endTime]);

  // Find max value for scaling
  const maxValue = useMemo(() => {
    return Math.max(1, ...hourlyData.map(h => h.auto + h.user));
  }, [hourlyData]);

  // Total counts for summary tooltip
  const totalAuto = useMemo(() => hourlyData.reduce((sum, h) => sum + h.auto, 0), [hourlyData]);
  const totalUser = useMemo(() => hourlyData.reduce((sum, h) => sum + h.user, 0), [hourlyData]);

  // Hour labels positioned at: 24 (start), 16, 8, 0 (end/reference time)
  const hourLabels = [
    { hour: 24, index: 0 },
    { hour: 16, index: 8 },
    { hour: 8, index: 16 },
    { hour: 0, index: 23 }
  ];

  // Get time range label for tooltip (e.g., "2PM - 3PM")
  const getTimeRangeLabel = (index: number) => {
    const refDate = new Date(endTime);
    const hoursAgo = 23 - index;

    // Calculate the start hour of this bucket relative to endTime
    const bucketEnd = new Date(refDate.getTime() - (hoursAgo * 60 * 60 * 1000));
    const bucketStart = new Date(bucketEnd.getTime() - (60 * 60 * 1000));

    const formatHour = (date: Date) => {
      const hour = date.getHours();
      const ampm = hour >= 12 ? 'PM' : 'AM';
      const hour12 = hour % 12 || 12;
      return `${hour12}${ampm}`;
    };

    return `${formatHour(bucketStart)} - ${formatHour(bucketEnd)}`;
  };

  // Get bucket time range as timestamps for click handling
  const getBucketTimeRange = (index: number): { start: number; end: number } => {
    const hoursAgo = 23 - index;
    const bucketEnd = endTime - (hoursAgo * 60 * 60 * 1000);
    const bucketStart = bucketEnd - (60 * 60 * 1000);
    return { start: bucketStart, end: bucketEnd };
  };

  // Handle bar click
  const handleBarClick = (index: number) => {
    const total = hourlyData[index].auto + hourlyData[index].user;
    if (total > 0 && onBarClick) {
      const { start, end } = getBucketTimeRange(index);
      onBarClick(start, end);
    }
  };

  // Format the reference time for display (shows what time point we're viewing)
  const formatReferenceTime = () => {
    const now = Date.now();
    const diffMs = now - endTime;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);

    if (diffMins < 1) return 'Now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    return new Date(endTime).toLocaleDateString([], { month: 'short', day: 'numeric' });
  };

  // Check if we're viewing historical data (not "now")
  const isHistorical = referenceTime && (Date.now() - referenceTime) > 60000; // More than 1 minute ago

  return (
    <div
      className="flex-1 min-w-0 flex flex-col relative mt-0.5"
      title={hoveredIndex === null ? `${isHistorical ? `Viewing: ${formatReferenceTime()} • ` : ''}24h window: ${totalAuto} auto, ${totalUser} user` : undefined}
    >
      {/* Hover tooltip - positioned below the graph */}
      {hoveredIndex !== null && (
        <div
          className="absolute top-full mt-1 px-2 py-1.5 rounded text-[10px] font-mono whitespace-nowrap z-20 pointer-events-none"
          style={{
            backgroundColor: theme.colors.bgSidebar,
            border: `1px solid ${theme.colors.border}`,
            color: theme.colors.textMain,
            left: `${(hoveredIndex / 23) * 100}%`,
            transform: hoveredIndex < 4 ? 'translateX(0)' : hoveredIndex > 19 ? 'translateX(-100%)' : 'translateX(-50%)'
          }}
        >
          <div className="font-bold mb-1" style={{ color: theme.colors.textMain }}>
            {getTimeRangeLabel(hoveredIndex)}
            {isHistorical && (
              <span className="ml-2 font-normal" style={{ color: theme.colors.accent }}>
                {formatReferenceTime()}
              </span>
            )}
          </div>
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center justify-between gap-3">
              <span style={{ color: theme.colors.warning }}>Auto</span>
              <span className="font-bold" style={{ color: theme.colors.warning }}>{hourlyData[hoveredIndex].auto}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span style={{ color: theme.colors.accent }}>User</span>
              <span className="font-bold" style={{ color: theme.colors.accent }}>{hourlyData[hoveredIndex].user}</span>
            </div>
          </div>
        </div>
      )}

      {/* Graph container with border */}
      <div
        className="flex items-end gap-px h-6 rounded border px-1 pt-1"
        style={{ borderColor: theme.colors.border }}
      >
        {hourlyData.map((hour, index) => {
          const total = hour.auto + hour.user;
          const heightPercent = total > 0 ? (total / maxValue) * 100 : 0;
          const autoPercent = total > 0 ? (hour.auto / total) * 100 : 0;
          const userPercent = total > 0 ? (hour.user / total) * 100 : 0;
          const isHovered = hoveredIndex === index;

          return (
            <div
              key={index}
              className="flex-1 min-w-0 flex flex-col justify-end rounded-t-sm overflow-visible cursor-pointer"
              style={{
                height: '100%',
                opacity: total > 0 ? 1 : 0.15,
                transform: isHovered ? 'scaleX(1.5)' : 'scaleX(1)',
                zIndex: isHovered ? 10 : 1,
                transition: 'transform 0.1s ease-out',
                cursor: total > 0 ? 'pointer' : 'default'
              }}
              onMouseEnter={() => setHoveredIndex(index)}
              onMouseLeave={() => setHoveredIndex(null)}
              onClick={() => handleBarClick(index)}
            >
              <div
                className="w-full rounded-t-sm overflow-hidden flex flex-col justify-end"
                style={{
                  height: `${Math.max(heightPercent, total > 0 ? 15 : 8)}%`,
                  minHeight: total > 0 ? '3px' : '1px'
                }}
              >
                {/* Auto portion (bottom) - warning color */}
                {hour.auto > 0 && (
                  <div
                    style={{
                      height: `${autoPercent}%`,
                      backgroundColor: theme.colors.warning,
                      minHeight: '1px'
                    }}
                  />
                )}
                {/* User portion (top) - accent color */}
                {hour.user > 0 && (
                  <div
                    style={{
                      height: `${userPercent}%`,
                      backgroundColor: theme.colors.accent,
                      minHeight: '1px'
                    }}
                  />
                )}
                {/* Empty bar placeholder */}
                {total === 0 && (
                  <div
                    style={{
                      height: '100%',
                      backgroundColor: theme.colors.border
                    }}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
      {/* Hour labels below */}
      <div className="relative h-3 mt-0.5">
        {hourLabels.map(({ hour, index }) => (
          <span
            key={hour}
            className="absolute text-[8px] font-mono"
            style={{
              color: theme.colors.textDim,
              left: index === 0 ? '0' : index === 23 ? 'auto' : `${(index / 23) * 100}%`,
              right: index === 23 ? '0' : 'auto',
              transform: index > 0 && index < 23 ? 'translateX(-50%)' : 'none'
            }}
          >
            {hour}h
          </span>
        ))}
      </div>
    </div>
  );
};

interface HistoryPanelProps {
  session: Session;
  theme: Theme;
  onJumpToClaudeSession?: (claudeSessionId: string) => void;
  onResumeSession?: (claudeSessionId: string) => void;
  onOpenSessionAsTab?: (claudeSessionId: string) => void;
}

export interface HistoryPanelHandle {
  focus: () => void;
  refreshHistory: () => void;
}

// Constants for history pagination
const MAX_HISTORY_IN_MEMORY = 500;  // Maximum entries to keep in memory
const INITIAL_DISPLAY_COUNT = 50;   // Initial entries to render
const LOAD_MORE_COUNT = 50;         // Entries to add when scrolling

export const HistoryPanel = React.memo(forwardRef<HistoryPanelHandle, HistoryPanelProps>(function HistoryPanel({ session, theme, onJumpToClaudeSession, onResumeSession, onOpenSessionAsTab }, ref) {
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[]>([]);
  const [activeFilters, setActiveFilters] = useState<Set<HistoryEntryType>>(new Set(['AUTO', 'USER', 'LOOP']));
  const [isLoading, setIsLoading] = useState(true);
  const [selectedIndex, setSelectedIndex] = useState<number>(-1);
  const [detailModalEntry, setDetailModalEntry] = useState<HistoryEntry | null>(null);
  const [searchFilter, setSearchFilter] = useState('');
  const [searchFilterOpen, setSearchFilterOpen] = useState(false);
  const [displayCount, setDisplayCount] = useState(INITIAL_DISPLAY_COUNT);
  const [graphReferenceTime, setGraphReferenceTime] = useState<number | undefined>(undefined);
  const [helpModalOpen, setHelpModalOpen] = useState(false);

  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Load history entries function - reusable for initial load and refresh
  const loadHistory = useCallback(async () => {
    setIsLoading(true);
    try {
      // Pass sessionId to filter: only show entries from this session or legacy entries without sessionId
      const entries = await window.maestro.history.getAll(session.cwd, session.id);
      // Ensure entries is an array, limit to MAX_HISTORY_IN_MEMORY
      const validEntries = Array.isArray(entries) ? entries : [];
      setHistoryEntries(validEntries.slice(0, MAX_HISTORY_IN_MEMORY));
      // Reset display count when reloading
      setDisplayCount(INITIAL_DISPLAY_COUNT);
    } catch (error) {
      console.error('Failed to load history:', error);
      setHistoryEntries([]);
    } finally {
      setIsLoading(false);
    }
  }, [session.cwd, session.id]);

  // Expose focus and refreshHistory methods to parent
  useImperativeHandle(ref, () => ({
    focus: () => {
      listRef.current?.focus();
      // Select first item if none selected
      if (selectedIndex < 0 && historyEntries.length > 0) {
        setSelectedIndex(0);
      }
    },
    refreshHistory: () => {
      loadHistory();
    }
  }), [selectedIndex, historyEntries.length, loadHistory]);

  // Load history entries on mount and when session changes
  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  // Toggle a filter
  const toggleFilter = (type: HistoryEntryType) => {
    setActiveFilters(prev => {
      const newFilters = new Set(prev);
      if (newFilters.has(type)) {
        newFilters.delete(type);
      } else {
        newFilters.add(type);
      }
      return newFilters;
    });
  };

  // Filter entries based on active filters and search text
  const allFilteredEntries = useMemo(() => historyEntries.filter(entry => {
    if (!entry || !entry.type) return false;
    if (!activeFilters.has(entry.type)) return false;

    // Apply text search filter
    if (searchFilter) {
      const searchLower = searchFilter.toLowerCase();
      const summaryMatch = entry.summary?.toLowerCase().includes(searchLower);
      const responseMatch = entry.fullResponse?.toLowerCase().includes(searchLower);
      const promptMatch = entry.prompt?.toLowerCase().includes(searchLower);
      // Search by session ID (full ID or short octet form)
      const sessionIdMatch = entry.claudeSessionId?.toLowerCase().includes(searchLower);
      const sessionNameMatch = entry.sessionName?.toLowerCase().includes(searchLower);
      if (!summaryMatch && !responseMatch && !promptMatch && !sessionIdMatch && !sessionNameMatch) return false;
    }

    return true;
  }), [historyEntries, activeFilters, searchFilter]);

  // Slice to only display up to displayCount for performance
  const filteredEntries = useMemo(() =>
    allFilteredEntries.slice(0, displayCount),
    [allFilteredEntries, displayCount]
  );

  // Check if there are more entries to load
  const hasMore = allFilteredEntries.length > displayCount;

  // Handle graph bar click - scroll to first entry in that time range
  const handleGraphBarClick = useCallback((bucketStart: number, bucketEnd: number) => {
    // Find entries within this time bucket (entries are sorted newest first)
    const entriesInBucket = historyEntries.filter(
      entry => entry.timestamp >= bucketStart && entry.timestamp < bucketEnd
    );

    if (entriesInBucket.length === 0) return;

    // Get the most recent entry in the bucket (first one since sorted by timestamp desc)
    const targetEntry = entriesInBucket[0];

    // Find its index in the filtered list
    // We need to look at allFilteredEntries (not just currently displayed ones)
    // and potentially expand displayCount to show it
    const indexInAllFiltered = allFilteredEntries.findIndex(e => e.id === targetEntry.id);

    if (indexInAllFiltered === -1) {
      // Entry exists but is filtered out - try finding any entry from the bucket in filtered list
      const anyMatch = allFilteredEntries.findIndex(e =>
        e.timestamp >= bucketStart && e.timestamp < bucketEnd
      );
      if (anyMatch === -1) return;

      // Expand display count if needed
      if (anyMatch >= displayCount) {
        setDisplayCount(Math.min(anyMatch + LOAD_MORE_COUNT, allFilteredEntries.length));
      }

      // Set selection and scroll after a brief delay for state to update
      setTimeout(() => {
        setSelectedIndex(anyMatch);
        const itemEl = itemRefs.current[anyMatch];
        if (itemEl) {
          itemEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
      }, 50);
    } else {
      // Expand display count if needed
      if (indexInAllFiltered >= displayCount) {
        setDisplayCount(Math.min(indexInAllFiltered + LOAD_MORE_COUNT, allFilteredEntries.length));
      }

      // Set selection and scroll after a brief delay for state to update
      setTimeout(() => {
        setSelectedIndex(indexInAllFiltered);
        const itemEl = itemRefs.current[indexInAllFiltered];
        if (itemEl) {
          itemEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
      }, 50);
    }
  }, [historyEntries, allFilteredEntries, displayCount]);

  // Handle scroll to load more entries AND update graph reference time
  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const target = e.currentTarget;
    const scrollBottom = target.scrollHeight - target.scrollTop - target.clientHeight;

    // Load more when within 100px of bottom
    if (scrollBottom < 100 && hasMore) {
      setDisplayCount(prev => Math.min(prev + LOAD_MORE_COUNT, allFilteredEntries.length));
    }

    // Find the topmost visible entry to update the graph's reference time
    // This creates the "sliding window" effect as you scroll through history
    const containerRect = target.getBoundingClientRect();
    let topmostVisibleEntry: HistoryEntry | null = null;

    for (let i = 0; i < filteredEntries.length; i++) {
      const itemEl = itemRefs.current[i];
      if (itemEl) {
        const itemRect = itemEl.getBoundingClientRect();
        // Check if this item is at or below the top of the container
        if (itemRect.top >= containerRect.top - 20) {
          topmostVisibleEntry = filteredEntries[i];
          break;
        }
      }
    }

    // Update the graph reference time to the topmost visible entry's timestamp
    // If at the very top (no scrolling), use undefined to show "now"
    if (target.scrollTop < 10) {
      setGraphReferenceTime(undefined);
    } else if (topmostVisibleEntry) {
      setGraphReferenceTime(topmostVisibleEntry.timestamp);
    }
  }, [hasMore, allFilteredEntries.length, filteredEntries]);

  // Reset selected index, display count, and graph reference time when filters change
  useEffect(() => {
    setSelectedIndex(-1);
    setDisplayCount(INITIAL_DISPLAY_COUNT);
    setGraphReferenceTime(undefined); // Reset to "now" when filters change
  }, [activeFilters, searchFilter]);

  // Scroll selected item into view
  useEffect(() => {
    if (selectedIndex >= 0) {
      const itemEl = itemRefs.current[selectedIndex];
      if (itemEl) {
        itemEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
  }, [selectedIndex]);

  // Keyboard navigation handler
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Open search filter with / key
    if (e.key === '/' && !searchFilterOpen) {
      e.preventDefault();
      setSearchFilterOpen(true);
      // Focus the search input after state update
      setTimeout(() => searchInputRef.current?.focus(), 0);
      return;
    }

    if (filteredEntries.length === 0) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex(prev => {
          const next = prev < filteredEntries.length - 1 ? prev + 1 : prev;
          return next;
        });
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex(prev => {
          const next = prev > 0 ? prev - 1 : 0;
          return next;
        });
        break;
      case 'Enter':
        e.preventDefault();
        if (selectedIndex >= 0 && selectedIndex < filteredEntries.length) {
          setDetailModalEntry(filteredEntries[selectedIndex]);
        }
        break;
      case 'Escape':
        // Only handle if modal is not open (modal handles its own escape)
        if (!detailModalEntry) {
          setSelectedIndex(-1);
        }
        break;
    }
  }, [filteredEntries, selectedIndex, detailModalEntry, searchFilterOpen]);

  // Open detail modal for an entry
  const openDetailModal = useCallback((entry: HistoryEntry, index: number) => {
    setSelectedIndex(index);
    setDetailModalEntry(entry);
  }, []);

  // Close detail modal and restore focus
  const closeDetailModal = useCallback(() => {
    setDetailModalEntry(null);
    // Restore focus to the list
    listRef.current?.focus();
  }, []);

  // Delete a history entry
  const handleDeleteEntry = useCallback(async (entryId: string) => {
    try {
      const success = await window.maestro.history.delete(entryId);
      if (success) {
        // Remove from local state
        setHistoryEntries(prev => prev.filter(entry => entry.id !== entryId));
        // Reset selection if needed
        setSelectedIndex(-1);
      }
    } catch (error) {
      console.error('Failed to delete history entry:', error);
    }
  }, []);

  // Format timestamp
  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp);
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();

    if (isToday) {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } else {
      return date.toLocaleDateString([], { month: 'short', day: 'numeric' }) +
        ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
  };

  // Get pill color based on type
  const getPillColor = (type: HistoryEntryType) => {
    switch (type) {
      case 'AUTO':
        return { bg: theme.colors.warning + '20', text: theme.colors.warning, border: theme.colors.warning + '40' };
      case 'USER':
        return { bg: theme.colors.accent + '20', text: theme.colors.accent, border: theme.colors.accent + '40' };
      case 'LOOP':
        return { bg: theme.colors.success + '20', text: theme.colors.success, border: theme.colors.success + '40' };
      default:
        return { bg: theme.colors.bgActivity, text: theme.colors.textDim, border: theme.colors.border };
    }
  };

  // Get icon for entry type
  const getEntryIcon = (type: HistoryEntryType) => {
    switch (type) {
      case 'AUTO':
        return Bot;
      case 'USER':
        return User;
      case 'LOOP':
        return RefreshCw;
      default:
        return Bot;
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Filter Pills + Activity Graph + Help Button */}
      <div className="flex items-start gap-3 mb-4 pt-2">
        {/* Left-justified filter pills */}
        <div className="flex gap-2 flex-shrink-0">
          {/* Only show LOOP pill if there are LOOP entries */}
          {(['AUTO', 'USER', 'LOOP'] as HistoryEntryType[])
            .filter(type => type !== 'LOOP' || historyEntries.some(e => e.type === 'LOOP'))
            .map(type => {
              const isActive = activeFilters.has(type);
              const colors = getPillColor(type);
              const Icon = getEntryIcon(type);

              return (
                <button
                  key={type}
                  onClick={() => toggleFilter(type)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold uppercase transition-all ${
                    isActive ? 'opacity-100' : 'opacity-40'
                  }`}
                  style={{
                    backgroundColor: isActive ? colors.bg : 'transparent',
                    color: isActive ? colors.text : theme.colors.textDim,
                    border: `1px solid ${isActive ? colors.border : theme.colors.border}`
                  }}
                >
                  <Icon className="w-3 h-3" />
                  {type}
                </button>
              );
            })}
        </div>

        {/* 24-hour activity bar graph */}
        <ActivityGraph entries={historyEntries} theme={theme} referenceTime={graphReferenceTime} onBarClick={handleGraphBarClick} />

        {/* Help button */}
        <button
          onClick={() => setHelpModalOpen(true)}
          className="flex-shrink-0 p-1.5 rounded-full transition-colors hover:bg-white/10"
          style={{ color: theme.colors.textDim }}
          title="History panel help"
        >
          <HelpCircle className="w-4 h-4" />
        </button>
      </div>

      {/* Search Filter */}
      {searchFilterOpen && (
        <div className="mb-3">
          <input
            ref={searchInputRef}
            autoFocus
            type="text"
            placeholder="Filter history..."
            value={searchFilter}
            onChange={(e) => setSearchFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setSearchFilterOpen(false);
                setSearchFilter('');
                // Return focus to the list
                listRef.current?.focus();
              } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                // Move focus to list and select first item
                listRef.current?.focus();
                if (filteredEntries.length > 0) {
                  setSelectedIndex(0);
                }
              }
            }}
            className="w-full px-3 py-2 rounded border bg-transparent outline-none text-sm"
            style={{ borderColor: theme.colors.accent, color: theme.colors.textMain }}
          />
          {searchFilter && (
            <div className="text-[10px] mt-1 text-right" style={{ color: theme.colors.textDim }}>
              {allFilteredEntries.length} result{allFilteredEntries.length !== 1 ? 's' : ''}
            </div>
          )}
        </div>
      )}

      {/* History List */}
      <div
        ref={listRef}
        className="flex-1 overflow-y-auto space-y-3 outline-none scrollbar-thin"
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onScroll={handleScroll}
      >
        {isLoading ? (
          <div className="text-center py-8 text-xs opacity-50">Loading history...</div>
        ) : filteredEntries.length === 0 ? (
          <div className="text-center py-8 text-xs opacity-50">
            {historyEntries.length === 0
              ? 'No history yet. Run batch tasks or use /synopsis to add entries.'
              : searchFilter
                ? `No entries match "${searchFilter}"`
                : 'No entries match the selected filters.'}
          </div>
        ) : (
          <>
          {filteredEntries.map((entry, index) => {
            const colors = getPillColor(entry.type);
            const Icon = getEntryIcon(entry.type);
            const isSelected = index === selectedIndex;

            return (
              <div
                key={entry.id || `entry-${index}`}
                ref={(el) => {
                  itemRefs.current[index] = el;
                }}
                onClick={() => openDetailModal(entry, index)}
                className="p-3 rounded border transition-colors cursor-pointer hover:bg-white/5"
                style={{
                  borderColor: isSelected ? theme.colors.accent : theme.colors.border,
                  backgroundColor: isSelected ? theme.colors.accent + '10' : 'transparent',
                  outline: isSelected ? `2px solid ${theme.colors.accent}` : 'none',
                  outlineOffset: '1px'
                }}
              >
                {/* Header Row */}
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    {/* Success/Failure Indicator for AUTO entries */}
                    {entry.type === 'AUTO' && entry.success !== undefined && (
                      <span
                        className="flex items-center justify-center w-5 h-5 rounded-full"
                        style={{
                          backgroundColor: entry.success
                            ? theme.colors.success + (entry.validated ? '40' : '20')
                            : theme.colors.error + '20',
                          border: `1px solid ${entry.success
                            ? theme.colors.success + (entry.validated ? '60' : '40')
                            : theme.colors.error + '40'}`
                        }}
                        title={entry.success
                          ? (entry.validated ? 'Task completed successfully and human-validated' : 'Task completed successfully')
                          : 'Task failed'}
                      >
                        {entry.success ? (
                          entry.validated ? (
                            <DoubleCheck className="w-3 h-3" style={{ color: theme.colors.success }} />
                          ) : (
                            <Check className="w-3 h-3" style={{ color: theme.colors.success }} />
                          )
                        ) : (
                          <X className="w-3 h-3" style={{ color: theme.colors.error }} />
                        )}
                      </span>
                    )}

                    {/* Type Pill */}
                    <span
                      className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase"
                      style={{
                        backgroundColor: colors.bg,
                        color: colors.text,
                        border: `1px solid ${colors.border}`
                      }}
                    >
                      <Icon className="w-2.5 h-2.5" />
                      {entry.type}
                    </span>

                    {/* Session Name or ID Octet (clickable) - opens session as new tab */}
                    {entry.claudeSessionId && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenSessionAsTab?.(entry.claudeSessionId!);
                        }}
                        className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold transition-colors hover:opacity-80 ${entry.sessionName ? '' : 'font-mono uppercase'}`}
                        style={{
                          backgroundColor: theme.colors.accent + '20',
                          color: theme.colors.accent,
                          border: `1px solid ${theme.colors.accent}40`
                        }}
                        title={`Open session ${entry.sessionName || entry.claudeSessionId.split('-')[0]} as new tab`}
                      >
                        {entry.sessionName || entry.claudeSessionId.split('-')[0].toUpperCase()}
                        <ExternalLink className="w-2.5 h-2.5" />
                      </button>
                    )}
                  </div>

                  {/* Timestamp */}
                  <span className="text-[10px]" style={{ color: theme.colors.textDim }}>
                    {formatTime(entry.timestamp)}
                  </span>
                </div>

                {/* Summary - 3 lines max */}
                <p
                  className="text-xs leading-relaxed overflow-hidden"
                  style={{
                    color: theme.colors.textMain,
                    display: '-webkit-box',
                    WebkitLineClamp: 3,
                    WebkitBoxOrient: 'vertical' as const
                  }}
                >
                  {entry.summary || 'No summary available'}
                </p>

                {/* Footer Row - Time and Cost */}
                {(entry.elapsedTimeMs !== undefined || (entry.usageStats && entry.usageStats.totalCostUsd > 0)) && (
                  <div className="flex items-center gap-3 mt-2 pt-2 border-t" style={{ borderColor: theme.colors.border }}>
                    {/* Elapsed Time */}
                    {entry.elapsedTimeMs !== undefined && (
                      <div className="flex items-center gap-1">
                        <Clock className="w-3 h-3" style={{ color: theme.colors.textDim }} />
                        <span className="text-[10px] font-mono" style={{ color: theme.colors.textDim }}>
                          {formatElapsedTime(entry.elapsedTimeMs)}
                        </span>
                      </div>
                    )}
                    {/* Cost */}
                    {entry.usageStats && entry.usageStats.totalCostUsd > 0 && (
                      <span
                        className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded-full"
                        style={{
                          backgroundColor: theme.colors.success + '15',
                          color: theme.colors.success,
                          border: `1px solid ${theme.colors.success}30`
                        }}
                      >
                        ${entry.usageStats.totalCostUsd.toFixed(2)}
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {/* Load more indicator */}
          {hasMore && (
            <div
              className="text-center py-4 text-xs"
              style={{ color: theme.colors.textDim }}
            >
              Showing {filteredEntries.length} of {allFilteredEntries.length} entries. Scroll for more...
            </div>
          )}
          </>
        )}
      </div>

      {/* Detail Modal */}
      {detailModalEntry && (
        <HistoryDetailModal
          theme={theme}
          entry={detailModalEntry}
          onClose={closeDetailModal}
          onJumpToClaudeSession={onJumpToClaudeSession}
          onResumeSession={onResumeSession}
          onDelete={handleDeleteEntry}
          onUpdate={async (entryId, updates) => {
            const success = await window.maestro.history.update(entryId, updates);
            if (success) {
              // Update local state
              setHistoryEntries(prev => prev.map(e =>
                e.id === entryId ? { ...e, ...updates } : e
              ));
              // Update the modal entry state
              setDetailModalEntry(prev => prev ? { ...prev, ...updates } : null);
            }
            return success;
          }}
          // Navigation props - use allFilteredEntries (respects filters)
          filteredEntries={allFilteredEntries}
          currentIndex={selectedIndex}
          onNavigate={(entry, index) => {
            setSelectedIndex(index);
            setDetailModalEntry(entry);
            // Ensure the entry is visible in the list (expand displayCount if needed)
            if (index >= displayCount) {
              setDisplayCount(Math.min(index + LOAD_MORE_COUNT, allFilteredEntries.length));
            }
          }}
        />
      )}

      {/* Help Modal */}
      {helpModalOpen && (
        <HistoryHelpModal
          theme={theme}
          onClose={() => setHelpModalOpen(false)}
        />
      )}
    </div>
  );
}));
