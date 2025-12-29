/**
 * UsageDashboardModal
 *
 * Main modal container for the Usage Dashboard with Recharts visualizations.
 * Displays AI usage patterns across all sessions and agents with time-based filtering.
 *
 * Features:
 * - Time range selector (Day, Week, Month, Year, All Time)
 * - View mode tabs for different visualization focuses
 * - Summary stats cards
 * - Activity heatmap, agent comparison, source distribution charts
 * - Responsive grid layout (2 columns on wide screens, 1 on narrow)
 * - Theme-aware styling
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { X, BarChart3, Calendar, Download, RefreshCw, Database } from 'lucide-react';
import { SummaryCards } from './SummaryCards';
import { ActivityHeatmap } from './ActivityHeatmap';
import { AgentComparisonChart } from './AgentComparisonChart';
import { SourceDistributionChart } from './SourceDistributionChart';
import { DurationTrendsChart } from './DurationTrendsChart';
import { AutoRunStats } from './AutoRunStats';
import { EmptyState } from './EmptyState';
import type { Theme } from '../../types';
import { useLayerStack } from '../../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';

// Stats time range type matching the backend API
type StatsTimeRange = 'day' | 'week' | 'month' | 'year' | 'all';

// Aggregation data shape from the stats API
interface StatsAggregation {
  totalQueries: number;
  totalDuration: number;
  avgDuration: number;
  byAgent: Record<string, { count: number; duration: number }>;
  bySource: { user: number; auto: number };
  byDay: Array<{ date: string; count: number; duration: number }>;
}

// View mode options for the dashboard
type ViewMode = 'overview' | 'agents' | 'activity' | 'autorun';

interface UsageDashboardModalProps {
  isOpen: boolean;
  onClose: () => void;
  theme: Theme;
}

/**
 * Format database size in human-readable format
 * @param bytes - Size in bytes
 * @returns Formatted string (e.g., "1.5 MB")
 */
function formatDatabaseSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  } else if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  } else if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  } else {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
}

// Time range options for the dropdown
const TIME_RANGE_OPTIONS: { value: StatsTimeRange; label: string }[] = [
  { value: 'day', label: 'Today' },
  { value: 'week', label: 'This Week' },
  { value: 'month', label: 'This Month' },
  { value: 'year', label: 'This Year' },
  { value: 'all', label: 'All Time' },
];

// View mode tabs
const VIEW_MODE_TABS: { value: ViewMode; label: string }[] = [
  { value: 'overview', label: 'Overview' },
  { value: 'agents', label: 'Agents' },
  { value: 'activity', label: 'Activity' },
  { value: 'autorun', label: 'Auto Run' },
];

export function UsageDashboardModal({
  isOpen,
  onClose,
  theme,
}: UsageDashboardModalProps) {
  const [timeRange, setTimeRange] = useState<StatsTimeRange>('week');
  const [viewMode, setViewMode] = useState<ViewMode>('overview');
  const [data, setData] = useState<StatsAggregation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [containerWidth, setContainerWidth] = useState(0);
  const [showNewDataIndicator, setShowNewDataIndicator] = useState(false);
  const [databaseSize, setDatabaseSize] = useState<number | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const { registerLayer, unregisterLayer } = useLayerStack();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Register with layer stack for proper Escape handling
  useEffect(() => {
    if (isOpen) {
      const id = registerLayer({
        type: 'modal',
        priority: MODAL_PRIORITIES.USAGE_DASHBOARD,
        blocksLowerLayers: true,
        capturesFocus: true,
        focusTrap: 'lenient',
        onEscape: () => onCloseRef.current(),
      });
      return () => unregisterLayer(id);
    }
  }, [isOpen, registerLayer, unregisterLayer]);

  // Fetch stats data when range changes
  const fetchStats = useCallback(async (showRefresh = false) => {
    if (showRefresh) {
      setIsRefreshing(true);
    } else {
      setLoading(true);
    }
    setError(null);

    try {
      // Fetch stats and database size in parallel
      const [stats, dbSize] = await Promise.all([
        window.maestro.stats.getAggregation(timeRange),
        window.maestro.stats.getDatabaseSize(),
      ]);
      setData(stats);
      setDatabaseSize(dbSize);
    } catch (err) {
      console.error('Failed to fetch usage stats:', err);
      setError(err instanceof Error ? err.message : 'Failed to load stats');
    } finally {
      setLoading(false);
      if (showRefresh) {
        // Keep refresh spinner visible briefly for visual feedback
        setTimeout(() => setIsRefreshing(false), 300);
        // Show "new data" indicator for real-time updates
        setShowNewDataIndicator(true);
        setTimeout(() => setShowNewDataIndicator(false), 3000);
      }
    }
  }, [timeRange]);

  // Initial fetch and real-time updates subscription
  useEffect(() => {
    if (!isOpen) return;

    fetchStats();

    // Subscribe to stats updates with debounce
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = window.maestro.stats.onStatsUpdate(() => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        fetchStats(true);
      }, 1000); // 1 second debounce
    });

    return () => {
      unsubscribe();
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  }, [isOpen, fetchStats]);

  // Focus container on open
  useEffect(() => {
    if (isOpen) {
      containerRef.current?.focus();
    }
  }, [isOpen]);

  // Track container width for responsive layout
  useEffect(() => {
    if (!isOpen || !contentRef.current) return;

    const updateWidth = () => {
      if (contentRef.current) {
        setContainerWidth(contentRef.current.offsetWidth);
      }
    };

    // Initial measurement
    updateWidth();

    // Use ResizeObserver to detect width changes
    const resizeObserver = new ResizeObserver(updateWidth);
    resizeObserver.observe(contentRef.current);

    return () => resizeObserver.disconnect();
  }, [isOpen]);

  // Determine responsive breakpoints based on container width
  const layout = useMemo(() => {
    // Breakpoints: narrow < 600px, medium 600-900px, wide > 900px
    const isNarrow = containerWidth > 0 && containerWidth < 600;
    const isMedium = containerWidth >= 600 && containerWidth < 900;
    const isWide = containerWidth >= 900;

    return {
      isNarrow,
      isMedium,
      isWide,
      // Chart grid: 1 col on narrow, 2 cols on medium/wide
      chartGridCols: isNarrow ? 1 : 2,
      // Summary cards: 2 cols on narrow, 3 on medium, 5 on wide
      summaryCardsCols: isNarrow ? 2 : isMedium ? 3 : 5,
      // AutoRun stats: 2 cols on narrow, 3 on medium, 6 on wide
      autoRunStatsCols: isNarrow ? 2 : isMedium ? 3 : 6,
    };
  }, [containerWidth]);

  // Handle export to CSV
  const handleExport = async () => {
    setIsExporting(true);
    try {
      // Show save dialog to let user choose file location
      const defaultFilename = `maestro-usage-${timeRange}-${new Date().toISOString().split('T')[0]}.csv`;
      const filePath = await window.maestro.dialog.saveFile({
        defaultPath: defaultFilename,
        filters: [{ name: 'CSV Files', extensions: ['csv'] }],
        title: 'Export Usage Data',
      });

      // User cancelled the dialog
      if (!filePath) {
        return;
      }

      // Get CSV data and write to selected file
      const csv = await window.maestro.stats.exportCsv(timeRange);
      await window.maestro.fs.writeFile(filePath, csv);
    } catch (err) {
      console.error('Failed to export CSV:', err);
    } finally {
      setIsExporting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 modal-overlay flex items-center justify-center z-[9999] animate-in fade-in duration-100"
      onClick={onClose}
    >
      <div
        ref={containerRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Usage Dashboard"
        className="rounded-xl shadow-2xl border overflow-hidden flex flex-col outline-none"
        style={{
          backgroundColor: theme.colors.bgActivity,
          borderColor: theme.colors.border,
          width: '80vw',
          maxWidth: '1400px',
          height: '85vh',
          maxHeight: '900px',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="px-6 py-4 border-b flex items-center justify-between flex-shrink-0"
          style={{ borderColor: theme.colors.border }}
        >
          <div className="flex items-center gap-3">
            <BarChart3 className="w-5 h-5" style={{ color: theme.colors.accent }} />
            <h2 className="text-lg font-semibold" style={{ color: theme.colors.textMain }}>
              Usage Dashboard
            </h2>
            {/* New Data Indicator - appears briefly when real-time data arrives */}
            {showNewDataIndicator && (
              <div
                className="flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium"
                style={{
                  backgroundColor: `${theme.colors.accent}20`,
                  color: theme.colors.accent,
                  animation: 'pulse-fade 3s ease-out forwards',
                }}
                data-testid="new-data-indicator"
              >
                <span
                  className="w-2 h-2 rounded-full"
                  style={{
                    backgroundColor: theme.colors.accent,
                    animation: 'pulse-dot 1s ease-in-out 3',
                  }}
                />
                Updated
              </div>
            )}
          </div>

          <div className="flex items-center gap-3">
            {/* Time Range Dropdown */}
            <div className="flex items-center gap-2">
              <Calendar className="w-4 h-4" style={{ color: theme.colors.textDim }} />
              <select
                value={timeRange}
                onChange={(e) => setTimeRange(e.target.value as StatsTimeRange)}
                className="px-3 py-1.5 rounded text-sm border cursor-pointer outline-none"
                style={{
                  backgroundColor: theme.colors.bgMain,
                  borderColor: theme.colors.border,
                  color: theme.colors.textMain,
                }}
              >
                {TIME_RANGE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Refresh Button */}
            <button
              onClick={() => fetchStats(true)}
              className="p-1.5 rounded hover:bg-opacity-10 transition-colors"
              style={{ color: theme.colors.textDim }}
              onMouseEnter={(e) => e.currentTarget.style.backgroundColor = `${theme.colors.accent}20`}
              onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
              title="Refresh"
              disabled={isRefreshing}
            >
              <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            </button>

            {/* Export Button */}
            <button
              onClick={handleExport}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded text-sm hover:bg-opacity-10 transition-colors"
              style={{
                color: theme.colors.textMain,
                backgroundColor: `${theme.colors.accent}15`,
              }}
              onMouseEnter={(e) => e.currentTarget.style.backgroundColor = `${theme.colors.accent}25`}
              onMouseLeave={(e) => e.currentTarget.style.backgroundColor = `${theme.colors.accent}15`}
              disabled={isExporting}
            >
              <Download className={`w-4 h-4 ${isExporting ? 'animate-pulse' : ''}`} />
              Export CSV
            </button>

            {/* Close Button */}
            <button
              onClick={onClose}
              className="p-1.5 rounded hover:bg-opacity-10 transition-colors"
              style={{ color: theme.colors.textDim }}
              onMouseEnter={(e) => e.currentTarget.style.backgroundColor = `${theme.colors.accent}20`}
              onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
              title="Close (Esc)"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* View Mode Tabs */}
        <div
          className="px-6 py-2 border-b flex items-center gap-1 flex-shrink-0"
          style={{ borderColor: theme.colors.border }}
        >
          {VIEW_MODE_TABS.map((tab) => (
            <button
              key={tab.value}
              onClick={() => setViewMode(tab.value)}
              className="px-4 py-2 rounded-lg text-sm font-medium transition-colors"
              style={{
                backgroundColor: viewMode === tab.value ? `${theme.colors.accent}20` : 'transparent',
                color: viewMode === tab.value ? theme.colors.accent : theme.colors.textDim,
              }}
              onMouseEnter={(e) => {
                if (viewMode !== tab.value) {
                  e.currentTarget.style.backgroundColor = `${theme.colors.accent}10`;
                }
              }}
              onMouseLeave={(e) => {
                if (viewMode !== tab.value) {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Main Content */}
        <div ref={contentRef} className="flex-1 overflow-y-auto scrollbar-thin p-6">
          {loading && !data ? (
            <div
              className="h-full flex items-center justify-center"
              style={{ color: theme.colors.textDim }}
            >
              <RefreshCw className="w-6 h-6 animate-spin mr-2" />
              Loading usage data...
            </div>
          ) : error ? (
            <div
              className="h-full flex flex-col items-center justify-center gap-4"
              style={{ color: theme.colors.textDim }}
            >
              <p>Failed to load usage data</p>
              <button
                onClick={() => fetchStats()}
                className="px-4 py-2 rounded text-sm"
                style={{
                  backgroundColor: theme.colors.accent,
                  color: theme.colors.bgMain,
                }}
              >
                Retry
              </button>
            </div>
          ) : !data || (data.totalQueries === 0 && data.bySource.user === 0 && data.bySource.auto === 0) ? (
            /* Empty State Component */
            <EmptyState theme={theme} />
          ) : (
            <div className="space-y-6" data-testid="usage-dashboard-content">
              {/* View-specific content based on viewMode */}
              {viewMode === 'overview' && (
                <>
                  {/* Summary Stats Cards - Horizontal row at top, responsive */}
                  <SummaryCards
                    data={data}
                    theme={theme}
                    columns={layout.summaryCardsCols}
                  />

                  {/* Charts Grid - 2 columns on wide, 1 on narrow */}
                  <div
                    className="grid gap-6"
                    style={{
                      gridTemplateColumns: `repeat(${layout.chartGridCols}, minmax(0, 1fr))`,
                    }}
                  >
                    {/* Agent Comparison Chart */}
                    <div style={{ minHeight: '300px' }}>
                      <AgentComparisonChart data={data} theme={theme} />
                    </div>

                    {/* Source Distribution Chart */}
                    <div style={{ minHeight: '300px' }}>
                      <SourceDistributionChart data={data} theme={theme} />
                    </div>
                  </div>

                  {/* Activity Heatmap - Full width */}
                  <div style={{ minHeight: '200px' }}>
                    <ActivityHeatmap
                      data={data}
                      timeRange={timeRange}
                      theme={theme}
                    />
                  </div>

                  {/* Duration Trends Chart - Full width */}
                  <div style={{ minHeight: '280px' }}>
                    <DurationTrendsChart
                      data={data}
                      timeRange={timeRange}
                      theme={theme}
                    />
                  </div>
                </>
              )}

              {viewMode === 'agents' && (
                <>
                  {/* Agent-focused view */}
                  <div style={{ minHeight: '400px' }}>
                    <AgentComparisonChart data={data} theme={theme} />
                  </div>
                </>
              )}

              {viewMode === 'activity' && (
                <>
                  {/* Activity-focused view */}
                  <div style={{ minHeight: '300px' }}>
                    <ActivityHeatmap
                      data={data}
                      timeRange={timeRange}
                      theme={theme}
                    />
                  </div>
                  <div style={{ minHeight: '280px' }}>
                    <DurationTrendsChart
                      data={data}
                      timeRange={timeRange}
                      theme={theme}
                    />
                  </div>
                </>
              )}

              {viewMode === 'autorun' && (
                <>
                  {/* Auto Run-focused view */}
                  <AutoRunStats
                    timeRange={timeRange}
                    theme={theme}
                    columns={layout.autoRunStatsCols}
                  />
                </>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          className="px-6 py-3 border-t flex items-center justify-between text-xs flex-shrink-0"
          style={{
            borderColor: theme.colors.border,
            color: theme.colors.textDim,
          }}
        >
          <div className="flex items-center gap-4">
            <span>
              {data && data.totalQueries > 0
                ? `Showing ${TIME_RANGE_OPTIONS.find(o => o.value === timeRange)?.label.toLowerCase()} data`
                : 'No data for selected time range'}
            </span>
            {/* Database size indicator */}
            {databaseSize !== null && (
              <span
                className="flex items-center gap-1"
                style={{ opacity: 0.7 }}
                title="Stats database size"
                data-testid="database-size-indicator"
              >
                <Database className="w-3 h-3" />
                {formatDatabaseSize(databaseSize)}
              </span>
            )}
          </div>
          <span style={{ opacity: 0.7 }}>Press Esc to close</span>
        </div>
      </div>
    </div>
  );
}
