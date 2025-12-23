/**
 * MobileHistoryPanel component for Maestro mobile web interface
 *
 * A full-screen view displaying history entries from the desktop app.
 * This view shows all AUTO and USER entries in a list format, with the ability
 * to tap on an entry to see full details.
 *
 * Features:
 * - List view of all history entries
 * - Filter by AUTO/USER type
 * - Tap to view full details
 * - Read-only (no resume functionality on mobile)
 */

import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useThemeColors } from '../components/ThemeProvider';
import { triggerHaptic, HAPTIC_PATTERNS } from './constants';
import { buildApiUrl } from '../utils/config';
import { webLogger } from '../utils/logger';
import { HistoryEntry } from '../../shared/types';
import { stripAnsiCodes } from '../../shared/stringUtils';
import { formatElapsedTime } from '../../shared/formatters';
import { useSwipeGestures } from '../hooks/useSwipeGestures';

/**
 * Format timestamp for display
 */
function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();

  if (isToday) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } else {
    return (
      date.toLocaleDateString([], { month: 'short', day: 'numeric' }) +
      ' ' +
      date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    );
  }
}

/**
 * History entry card component
 */
interface HistoryCardProps {
  entry: HistoryEntry;
  onSelect: (entry: HistoryEntry) => void;
}

function HistoryCard({ entry, onSelect }: HistoryCardProps) {
  const colors = useThemeColors();

  // Get pill color based on type
  const getPillColor = () => {
    if (entry.type === 'AUTO') {
      return { bg: colors.warning + '20', text: colors.warning, border: colors.warning + '40' };
    }
    return { bg: colors.accent + '20', text: colors.accent, border: colors.accent + '40' };
  };

  const pillColors = getPillColor();

  const handleClick = useCallback(() => {
    triggerHaptic(HAPTIC_PATTERNS.tap);
    onSelect(entry);
  }, [entry, onSelect]);

  return (
    <button
      onClick={handleClick}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        padding: '14px 16px',
        borderRadius: '12px',
        border: `1px solid ${colors.border}`,
        backgroundColor: colors.bgSidebar,
        color: colors.textMain,
        width: '100%',
        textAlign: 'left',
        cursor: 'pointer',
        transition: 'all 0.15s ease',
        touchAction: 'manipulation',
        WebkitTapHighlightColor: 'transparent',
        outline: 'none',
        userSelect: 'none',
        WebkitUserSelect: 'none',
      }}
      aria-label={`${entry.type} entry from ${formatTime(entry.timestamp)}`}
    >
      {/* Top row: Type pill, success indicator (for AUTO), and timestamp */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          width: '100%',
        }}
      >
        {/* Success/Failure Indicator for AUTO entries */}
        {entry.type === 'AUTO' && entry.success !== undefined && (
          <span
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '20px',
              height: '20px',
              borderRadius: '50%',
              backgroundColor: entry.success ? colors.success + '20' : colors.error + '20',
              border: `1px solid ${entry.success ? colors.success + '40' : colors.error + '40'}`,
              flexShrink: 0,
            }}
            title={entry.success ? 'Task completed successfully' : 'Task failed'}
          >
            {entry.success ? (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={colors.success} strokeWidth="3">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={colors.error} strokeWidth="3">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            )}
          </span>
        )}

        {/* Type pill */}
        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            padding: '3px 8px',
            borderRadius: '12px',
            backgroundColor: pillColors.bg,
            color: pillColors.text,
            border: `1px solid ${pillColors.border}`,
            fontSize: '10px',
            fontWeight: 600,
            textTransform: 'uppercase',
            flexShrink: 0,
          }}
        >
          {entry.type === 'AUTO' ? (
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 8V4H8" />
              <rect x="8" y="8" width="8" height="12" rx="1" />
              <path d="M12 8v12" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
          )}
          {entry.type}
        </span>

        {/* Claude session ID octet (if available) */}
        {entry.agentSessionId && (
          <span
            style={{
              fontSize: '10px',
              color: colors.accent,
              fontFamily: 'monospace',
              backgroundColor: colors.accent + '20',
              padding: '2px 6px',
              borderRadius: '4px',
              flexShrink: 0,
            }}
          >
            {entry.agentSessionId.split('-')[0].toUpperCase()}
          </span>
        )}

        <div style={{ flex: 1 }} />

        {/* Timestamp */}
        <span
          style={{
            fontSize: '11px',
            color: colors.textDim,
            flexShrink: 0,
          }}
        >
          {formatTime(entry.timestamp)}
        </span>
      </div>

      {/* Summary - 3 lines max */}
      <p
        style={{
          fontSize: '13px',
          lineHeight: 1.5,
          color: colors.textMain,
          margin: 0,
          overflow: 'hidden',
          display: '-webkit-box',
          WebkitLineClamp: 3,
          WebkitBoxOrient: 'vertical' as const,
        }}
      >
        {entry.summary || 'No summary available'}
      </p>

      {/* Bottom row: Elapsed time and cost (if available) */}
      {(entry.elapsedTimeMs !== undefined || entry.usageStats?.totalCostUsd) && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            fontSize: '11px',
            color: colors.textDim,
          }}
        >
          {entry.elapsedTimeMs !== undefined && (
            <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
              {formatElapsedTime(entry.elapsedTimeMs)}
            </span>
          )}
          {entry.usageStats?.totalCostUsd !== undefined && entry.usageStats.totalCostUsd > 0 && (
            <span
              style={{
                color: '#22c55e',
                fontFamily: 'monospace',
              }}
            >
              ${entry.usageStats.totalCostUsd.toFixed(2)}
            </span>
          )}
        </div>
      )}
    </button>
  );
}

/**
 * History detail view component (full-screen)
 * Supports swipe left/right navigation on mobile and arrow key navigation on desktop/iPad
 */
interface HistoryDetailViewProps {
  entry: HistoryEntry;
  onClose: () => void;
  /** Current index in the filtered list (0-based) */
  currentIndex: number;
  /** Total number of entries in the filtered list */
  totalCount: number;
  /** Navigate to a specific index */
  onNavigate: (index: number) => void;
}

function HistoryDetailView({ entry, onClose, currentIndex, totalCount, onNavigate }: HistoryDetailViewProps) {
  const colors = useThemeColors();

  const canGoNext = currentIndex < totalCount - 1;
  const canGoPrev = currentIndex > 0;

  // Swipe gestures for mobile navigation
  const { handlers: swipeHandlers, offsetX, isSwiping } = useSwipeGestures({
    onSwipeLeft: canGoNext ? () => {
      triggerHaptic(HAPTIC_PATTERNS.tap);
      onNavigate(currentIndex + 1);
    } : undefined,
    onSwipeRight: canGoPrev ? () => {
      triggerHaptic(HAPTIC_PATTERNS.tap);
      onNavigate(currentIndex - 1);
    } : undefined,
    trackOffset: true,
    threshold: 50,
  });

  // Get pill color based on type
  const getPillColor = () => {
    if (entry.type === 'AUTO') {
      return { bg: colors.warning + '20', text: colors.warning, border: colors.warning + '40' };
    }
    return { bg: colors.accent + '20', text: colors.accent, border: colors.accent + '40' };
  };

  const pillColors = getPillColor();

  // Clean up the response for display - remove ANSI codes
  const rawResponse = entry.fullResponse || entry.summary || '';
  const cleanResponse = stripAnsiCodes(rawResponse);

  // Handle keyboard navigation (Escape to close, Arrow keys to navigate)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === 'ArrowLeft' && canGoPrev) {
        triggerHaptic(HAPTIC_PATTERNS.tap);
        onNavigate(currentIndex - 1);
      } else if (e.key === 'ArrowRight' && canGoNext) {
        triggerHaptic(HAPTIC_PATTERNS.tap);
        onNavigate(currentIndex + 1);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose, onNavigate, currentIndex, canGoPrev, canGoNext]);

  const handleClose = useCallback(() => {
    triggerHaptic(HAPTIC_PATTERNS.tap);
    onClose();
  }, [onClose]);

  const handlePrev = useCallback(() => {
    if (canGoPrev) {
      triggerHaptic(HAPTIC_PATTERNS.tap);
      onNavigate(currentIndex - 1);
    }
  }, [canGoPrev, currentIndex, onNavigate]);

  const handleNext = useCallback(() => {
    if (canGoNext) {
      triggerHaptic(HAPTIC_PATTERNS.tap);
      onNavigate(currentIndex + 1);
    }
  }, [canGoNext, currentIndex, onNavigate]);

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: colors.bgMain,
        zIndex: 210, // Higher than MobileHistoryPanel (200) to overlay it
        display: 'flex',
        flexDirection: 'column',
        animation: 'slideUp 0.25s ease-out',
      }}
    >
      {/* Header - entry info only */}
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 16px',
          paddingTop: 'max(12px, env(safe-area-inset-top))',
          borderBottom: `1px solid ${colors.border}`,
          backgroundColor: colors.bgSidebar,
          minHeight: '56px',
          flexShrink: 0,
          gap: '8px',
        }}
      >
        {/* Entry info */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1, minWidth: 0 }}>
          {/* Success/Failure Indicator for AUTO entries */}
          {entry.type === 'AUTO' && entry.success !== undefined && (
            <span
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '24px',
                height: '24px',
                borderRadius: '50%',
                backgroundColor: entry.success ? colors.success + '20' : colors.error + '20',
                border: `1px solid ${entry.success ? colors.success + '40' : colors.error + '40'}`,
                flexShrink: 0,
              }}
            >
              {entry.success ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={colors.success} strokeWidth="3">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={colors.error} strokeWidth="3">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              )}
            </span>
          )}

          {/* Type pill */}
          <span
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              padding: '4px 10px',
              borderRadius: '12px',
              backgroundColor: pillColors.bg,
              color: pillColors.text,
              border: `1px solid ${pillColors.border}`,
              fontSize: '11px',
              fontWeight: 600,
              textTransform: 'uppercase',
              flexShrink: 0,
            }}
          >
            {entry.type}
          </span>

          {/* Claude session ID */}
          {entry.agentSessionId && (
            <span
              style={{
                fontSize: '11px',
                color: colors.accent,
                fontFamily: 'monospace',
                backgroundColor: colors.accent + '20',
                padding: '3px 8px',
                borderRadius: '6px',
                flexShrink: 0,
              }}
            >
              {entry.agentSessionId.split('-')[0].toUpperCase()}
            </span>
          )}

          {/* Timestamp */}
          <span
            style={{
              fontSize: '12px',
              color: colors.textDim,
            }}
          >
            {formatTime(entry.timestamp)}
          </span>
        </div>

        <button
          onClick={handleClose}
          style={{
            padding: '8px 16px',
            borderRadius: '8px',
            backgroundColor: colors.bgMain,
            border: `1px solid ${colors.border}`,
            color: colors.textMain,
            fontSize: '14px',
            fontWeight: 500,
            cursor: 'pointer',
            touchAction: 'manipulation',
            WebkitTapHighlightColor: 'transparent',
            flexShrink: 0,
          }}
          aria-label="Close detail view"
        >
          Done
        </button>
      </header>

      {/* Stats panel (if available) */}
      {(entry.usageStats || entry.contextUsage !== undefined || entry.elapsedTimeMs) && (
        <div
          style={{
            padding: '12px 16px',
            borderBottom: `1px solid ${colors.border}`,
            backgroundColor: colors.bgSidebar,
            display: 'flex',
            flexWrap: 'wrap',
            gap: '16px',
            flexShrink: 0,
          }}
        >
          {/* Context usage */}
          {entry.contextUsage !== undefined && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '10px', color: colors.textDim, fontWeight: 600, textTransform: 'uppercase' }}>
                Context
              </span>
              <span
                style={{
                  fontSize: '12px',
                  fontFamily: 'monospace',
                  fontWeight: 600,
                  color: entry.contextUsage >= 90 ? colors.error : entry.contextUsage >= 70 ? colors.warning : colors.success,
                }}
              >
                {entry.contextUsage}%
              </span>
            </div>
          )}

          {/* Elapsed time */}
          {entry.elapsedTimeMs !== undefined && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={colors.textDim} strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
              <span style={{ fontSize: '12px', fontFamily: 'monospace', fontWeight: 600, color: colors.textMain }}>
                {formatElapsedTime(entry.elapsedTimeMs)}
              </span>
            </div>
          )}

          {/* Cost */}
          {entry.usageStats && entry.usageStats.totalCostUsd > 0 && (
            <span
              style={{
                fontSize: '12px',
                fontFamily: 'monospace',
                fontWeight: 600,
                color: '#22c55e',
                backgroundColor: '#22c55e20',
                padding: '2px 8px',
                borderRadius: '4px',
              }}
            >
              ${entry.usageStats.totalCostUsd.toFixed(2)}
            </span>
          )}

          {/* Tokens */}
          {entry.usageStats && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', fontFamily: 'monospace' }}>
              <span style={{ color: colors.accent }}>
                In: {entry.usageStats.inputTokens.toLocaleString()}
              </span>
              <span style={{ color: colors.success }}>
                Out: {entry.usageStats.outputTokens.toLocaleString()}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Content - with swipe gestures for navigation */}
      <div
        {...swipeHandlers}
        style={{
          flex: 1,
          overflowY: 'auto',
          overflowX: 'hidden',
          padding: '16px',
          transform: `translateX(${offsetX}px)`,
          transition: isSwiping ? 'none' : 'transform 0.2s ease-out',
          touchAction: 'pan-y', // Allow vertical scrolling, capture horizontal swipes
        }}
      >
        <pre
          style={{
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            fontFamily: 'monospace',
            fontSize: '13px',
            lineHeight: 1.6,
            color: colors.textMain,
            margin: 0,
          }}
        >
          {cleanResponse}
        </pre>
      </div>

      {/* Swipe hint overlays */}
      {isSwiping && offsetX > 20 && canGoPrev && (
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: '50%',
            transform: 'translateY(-50%)',
            padding: '16px',
            color: colors.accent,
            opacity: Math.min(1, offsetX / 50),
          }}
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </div>
      )}
      {isSwiping && offsetX < -20 && canGoNext && (
        <div
          style={{
            position: 'absolute',
            right: 0,
            top: '50%',
            transform: 'translateY(-50%)',
            padding: '16px',
            color: colors.accent,
            opacity: Math.min(1, Math.abs(offsetX) / 50),
          }}
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </div>
      )}

      {/* Bottom navigation bar */}
      <footer
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '16px',
          padding: '12px 16px',
          paddingBottom: 'max(12px, env(safe-area-inset-bottom))',
          borderTop: `1px solid ${colors.border}`,
          backgroundColor: colors.bgSidebar,
          flexShrink: 0,
        }}
      >
        <button
          onClick={handlePrev}
          disabled={!canGoPrev}
          style={{
            padding: '10px 20px',
            borderRadius: '8px',
            backgroundColor: canGoPrev ? colors.bgMain : 'transparent',
            border: canGoPrev ? `1px solid ${colors.border}` : `1px solid ${colors.border}40`,
            color: canGoPrev ? colors.textMain : colors.textDim + '40',
            cursor: canGoPrev ? 'pointer' : 'default',
            touchAction: 'manipulation',
            WebkitTapHighlightColor: 'transparent',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '6px',
            fontSize: '14px',
            fontWeight: 500,
          }}
          aria-label="Previous entry"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          Prev
        </button>

        {/* Position indicator */}
        <span
          style={{
            fontSize: '13px',
            color: colors.textDim,
            fontFamily: 'monospace',
            minWidth: '70px',
            textAlign: 'center',
          }}
        >
          {currentIndex + 1} / {totalCount}
        </span>

        <button
          onClick={handleNext}
          disabled={!canGoNext}
          style={{
            padding: '10px 20px',
            borderRadius: '8px',
            backgroundColor: canGoNext ? colors.bgMain : 'transparent',
            border: canGoNext ? `1px solid ${colors.border}` : `1px solid ${colors.border}40`,
            color: canGoNext ? colors.textMain : colors.textDim + '40',
            cursor: canGoNext ? 'pointer' : 'default',
            touchAction: 'manipulation',
            WebkitTapHighlightColor: 'transparent',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '6px',
            fontSize: '14px',
            fontWeight: 500,
          }}
          aria-label="Next entry"
        >
          Next
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
      </footer>

      {/* Animation keyframes */}
      <style>{`
        @keyframes slideUp {
          from {
            opacity: 0;
            transform: translateY(20px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
      `}</style>
    </div>
  );
}

/**
 * Props for MobileHistoryPanel component
 */
export interface MobileHistoryPanelProps {
  /** Callback to close the history panel */
  onClose: () => void;
  /** Current active session's project path (for filtering) */
  projectPath?: string;
  /** Current active session ID (for filtering) */
  sessionId?: string;
  /** Initial filter state */
  initialFilter?: 'all' | 'AUTO' | 'USER';
  /** Initial search query */
  initialSearchQuery?: string;
  /** Initial search open state */
  initialSearchOpen?: boolean;
  /** Callback when filter changes */
  onFilterChange?: (filter: 'all' | 'AUTO' | 'USER') => void;
  /** Callback when search query changes */
  onSearchChange?: (query: string, isOpen: boolean) => void;
}

/**
 * Filter type for history entries
 */
type HistoryFilter = 'all' | 'AUTO' | 'USER';

/**
 * MobileHistoryPanel component
 *
 * Full-screen view showing history entries with filtering and detail views.
 */
export function MobileHistoryPanel({
  onClose,
  projectPath,
  sessionId,
  initialFilter = 'all',
  initialSearchQuery = '',
  initialSearchOpen = false,
  onFilterChange,
  onSearchChange,
}: MobileHistoryPanelProps) {
  const colors = useThemeColors();
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<HistoryFilter>(initialFilter);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState(initialSearchQuery);
  const [isSearchOpen, setIsSearchOpen] = useState(initialSearchOpen);
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Fetch history entries on mount
  useEffect(() => {
    const fetchHistory = async () => {
      setIsLoading(true);
      setError(null);
      try {
        // Build query params
        const params = new URLSearchParams();
        if (projectPath) params.set('projectPath', projectPath);
        if (sessionId) params.set('sessionId', sessionId);

        const queryString = params.toString();
        const apiUrl = buildApiUrl(`/history${queryString ? `?${queryString}` : ''}`);

        const response = await fetch(apiUrl);
        if (!response.ok) {
          throw new Error(`Failed to fetch history: ${response.statusText}`);
        }
        const data = await response.json();
        setEntries(data.entries || []);
        webLogger.debug(`Fetched ${data.entries?.length || 0} history entries`, 'MobileHistory');
      } catch (err: any) {
        webLogger.error('Failed to fetch history', 'MobileHistory', err);
        setError(err.message || 'Failed to load history');
      } finally {
        setIsLoading(false);
      }
    };

    fetchHistory();
  }, [projectPath, sessionId]);

  // Filter entries based on selected filter and search query
  const filteredEntries = useMemo(() => {
    let result = entries;

    // Apply type filter
    if (filter !== 'all') {
      result = result.filter((entry) => entry.type === filter);
    }

    // Apply search filter
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase().trim();
      result = result.filter((entry) => {
        const summary = (entry.summary || '').toLowerCase();
        const fullResponse = (entry.fullResponse || '').toLowerCase();
        return summary.includes(query) || fullResponse.includes(query);
      });
    }

    return result;
  }, [entries, filter, searchQuery]);

  // Handle filter change
  const handleFilterChange = useCallback((newFilter: HistoryFilter) => {
    triggerHaptic(HAPTIC_PATTERNS.tap);
    setFilter(newFilter);
    onFilterChange?.(newFilter);
  }, [onFilterChange]);

  // Handle search toggle
  const handleToggleSearch = useCallback(() => {
    triggerHaptic(HAPTIC_PATTERNS.tap);
    setIsSearchOpen((prev) => {
      const newState = !prev;
      if (newState) {
        // Focus input after opening
        setTimeout(() => searchInputRef.current?.focus(), 50);
      } else {
        // Clear search when closing
        setSearchQuery('');
        onSearchChange?.('', false);
      }
      onSearchChange?.(searchQuery, newState);
      return newState;
    });
  }, [searchQuery, onSearchChange]);

  // Handle search input change
  const handleSearchChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    setSearchQuery(newValue);
    onSearchChange?.(newValue, isSearchOpen);
  }, [isSearchOpen, onSearchChange]);

  // Handle clearing search
  const handleClearSearch = useCallback(() => {
    triggerHaptic(HAPTIC_PATTERNS.tap);
    setSearchQuery('');
    onSearchChange?.('', isSearchOpen);
    searchInputRef.current?.focus();
  }, [isSearchOpen, onSearchChange]);

  // Handle entry selection - find the index in filtered entries
  const handleSelectEntry = useCallback((entry: HistoryEntry) => {
    const index = filteredEntries.findIndex(e => e.id === entry.id);
    if (index !== -1) {
      setSelectedIndex(index);
    }
  }, [filteredEntries]);

  // Handle closing detail view
  const handleCloseDetail = useCallback(() => {
    setSelectedIndex(null);
  }, []);

  // Handle navigating to a specific index
  const handleNavigate = useCallback((index: number) => {
    if (index >= 0 && index < filteredEntries.length) {
      setSelectedIndex(index);
    }
  }, [filteredEntries.length]);

  // Handle close button
  const handleClose = useCallback(() => {
    triggerHaptic(HAPTIC_PATTERNS.tap);
    onClose();
  }, [onClose]);

  // Get the currently selected entry
  const selectedEntry = selectedIndex !== null ? filteredEntries[selectedIndex] : null;

  // Close on escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && selectedIndex === null) {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose, selectedIndex]);

  // Count entries by type
  const autoCount = entries.filter((e) => e.type === 'AUTO').length;
  const userCount = entries.filter((e) => e.type === 'USER').length;

  return (
    <>
      <div
        ref={containerRef}
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: colors.bgMain,
          zIndex: 200, // Higher than CommandInputBar (100) to fully cover the screen including input box
          display: 'flex',
          flexDirection: 'column',
          animation: 'slideUp 0.25s ease-out',
        }}
      >
        {/* Header */}
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 16px',
            paddingTop: 'max(12px, env(safe-area-inset-top))',
            borderBottom: `1px solid ${colors.border}`,
            backgroundColor: colors.bgSidebar,
            minHeight: '56px',
            flexShrink: 0,
          }}
        >
          <h1
            style={{
              fontSize: '18px',
              fontWeight: 600,
              margin: 0,
              color: colors.textMain,
            }}
          >
            History
          </h1>
          <button
            onClick={handleClose}
            style={{
              padding: '8px 16px',
              borderRadius: '8px',
              backgroundColor: colors.bgMain,
              border: `1px solid ${colors.border}`,
              color: colors.textMain,
              fontSize: '14px',
              fontWeight: 500,
              cursor: 'pointer',
              touchAction: 'manipulation',
              WebkitTapHighlightColor: 'transparent',
            }}
            aria-label="Close history"
          >
            Done
          </button>
        </header>

        {/* Filter pills and search */}
        <div
          style={{
            padding: '12px 16px',
            borderBottom: `1px solid ${colors.border}`,
            backgroundColor: colors.bgSidebar,
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
            flexShrink: 0,
          }}
        >
          {/* Filter row with search button */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
            }}
          >
            {/* Search button */}
            <button
              onClick={handleToggleSearch}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '36px',
                height: '36px',
                borderRadius: '18px',
                backgroundColor: isSearchOpen ? colors.accent + '20' : colors.bgMain,
                border: `1px solid ${isSearchOpen ? colors.accent + '40' : colors.border}`,
                color: isSearchOpen ? colors.accent : colors.textDim,
                cursor: 'pointer',
                touchAction: 'manipulation',
                WebkitTapHighlightColor: 'transparent',
                flexShrink: 0,
                transition: 'all 0.15s ease',
              }}
              aria-label="Search history"
              aria-pressed={isSearchOpen}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
            </button>

            {/* Filter pills */}
            {(['all', 'AUTO', 'USER'] as HistoryFilter[]).map((filterType) => {
              const isActive = filter === filterType;
              const count = filterType === 'all'
                ? entries.length
                : filterType === 'AUTO'
                  ? autoCount
                  : userCount;
              const displayLabel = filterType === 'all' ? 'All' : filterType;

              let bgColor = colors.bgMain;
              let textColor = colors.textDim;
              let borderColor = colors.border;

              if (isActive) {
                if (filterType === 'AUTO') {
                  bgColor = colors.warning + '20';
                  textColor = colors.warning;
                  borderColor = colors.warning + '40';
                } else if (filterType === 'USER') {
                  bgColor = colors.accent + '20';
                  textColor = colors.accent;
                  borderColor = colors.accent + '40';
                } else {
                  bgColor = colors.accent + '20';
                  textColor = colors.accent;
                  borderColor = colors.accent + '40';
                }
              }

              return (
                <button
                  key={filterType}
                  onClick={() => handleFilterChange(filterType)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '8px 14px',
                    borderRadius: '20px',
                    backgroundColor: bgColor,
                    border: `1px solid ${borderColor}`,
                    color: textColor,
                    fontSize: '12px',
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    cursor: 'pointer',
                    touchAction: 'manipulation',
                    WebkitTapHighlightColor: 'transparent',
                    opacity: isActive ? 1 : 0.6,
                    transition: 'all 0.15s ease',
                  }}
                  aria-pressed={isActive}
                >
                  {displayLabel}
                  <span
                    style={{
                      fontSize: '10px',
                      backgroundColor: isActive ? `${textColor}20` : `${colors.textDim}20`,
                      padding: '2px 6px',
                      borderRadius: '8px',
                      minWidth: '20px',
                      textAlign: 'center',
                    }}
                  >
                    {count}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Search input (shown when search is open) */}
          {isSearchOpen && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
              }}
            >
              <div
                style={{
                  flex: 1,
                  display: 'flex',
                  alignItems: 'center',
                  position: 'relative',
                }}
              >
                <input
                  ref={searchInputRef}
                  type="text"
                  value={searchQuery}
                  onChange={handleSearchChange}
                  placeholder="Search history..."
                  style={{
                    width: '100%',
                    padding: '10px 36px 10px 14px',
                    borderRadius: '10px',
                    backgroundColor: colors.bgMain,
                    border: `1px solid ${colors.border}`,
                    color: colors.textMain,
                    fontSize: '14px',
                    outline: 'none',
                  }}
                />
                {searchQuery && (
                  <button
                    onClick={handleClearSearch}
                    style={{
                      position: 'absolute',
                      right: '8px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: '24px',
                      height: '24px',
                      borderRadius: '12px',
                      backgroundColor: colors.textDim + '30',
                      border: 'none',
                      color: colors.textDim,
                      cursor: 'pointer',
                      touchAction: 'manipulation',
                      WebkitTapHighlightColor: 'transparent',
                    }}
                    aria-label="Clear search"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                )}
              </div>
              {/* Results count when searching */}
              {searchQuery && (
                <span
                  style={{
                    fontSize: '12px',
                    color: filteredEntries.length > 0 ? colors.textDim : colors.error,
                    whiteSpace: 'nowrap',
                    flexShrink: 0,
                  }}
                >
                  {filteredEntries.length} found
                </span>
              )}
            </div>
          )}
        </div>

        {/* Entry list */}
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            overflowX: 'hidden',
            padding: '16px',
            paddingBottom: 'max(16px, env(safe-area-inset-bottom))',
          }}
        >
          {isLoading ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '40px 20px',
                textAlign: 'center',
              }}
            >
              <p style={{ fontSize: '14px', color: colors.textDim }}>Loading history...</p>
            </div>
          ) : error ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '40px 20px',
                textAlign: 'center',
              }}
            >
              <p style={{ fontSize: '14px', color: colors.error, marginBottom: '8px' }}>
                {error}
              </p>
              <p style={{ fontSize: '13px', color: colors.textDim }}>
                Make sure the desktop app is running
              </p>
            </div>
          ) : filteredEntries.length === 0 ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '40px 20px',
                textAlign: 'center',
              }}
            >
              <p style={{ fontSize: '15px', color: colors.textMain, marginBottom: '8px' }}>
                {searchQuery ? 'No matching entries' : 'No history entries'}
              </p>
              <p style={{ fontSize: '13px', color: colors.textDim }}>
                {searchQuery
                  ? `No entries found matching "${searchQuery}".`
                  : filter !== 'all'
                    ? `No ${filter} entries found. Try changing the filter.`
                    : 'Run batch tasks or use /history to add entries.'}
              </p>
            </div>
          ) : (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '10px',
              }}
            >
              {filteredEntries.map((entry) => (
                <HistoryCard key={entry.id} entry={entry} onSelect={handleSelectEntry} />
              ))}
            </div>
          )}
        </div>

        {/* Animation keyframes */}
        <style>{`
          @keyframes slideUp {
            from {
              opacity: 0;
              transform: translateY(20px);
            }
            to {
              opacity: 1;
              transform: translateY(0);
            }
          }
        `}</style>
      </div>

      {/* Detail view (overlays the list) */}
      {selectedEntry && selectedIndex !== null && (
        <HistoryDetailView
          entry={selectedEntry}
          onClose={handleCloseDetail}
          currentIndex={selectedIndex}
          totalCount={filteredEntries.length}
          onNavigate={handleNavigate}
        />
      )}
    </>
  );
}

export default MobileHistoryPanel;
