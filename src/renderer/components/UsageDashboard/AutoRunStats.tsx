/**
 * AutoRunStats
 *
 * Displays Auto Run specific metrics for the Usage Dashboard.
 * Shows batch processing statistics including sessions, tasks, and success rates.
 *
 * Features:
 * - Summary metrics in card format
 * - Mini bar chart showing tasks completed over time
 * - Theme-aware styling with inline styles
 * - Formatted values for readability
 * - Tooltip on hover for the bar chart
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Play,
  CheckSquare,
  ListChecks,
  Target,
  Clock,
  Timer,
} from 'lucide-react';
import type { Theme } from '../../types';
import type { StatsTimeRange } from '../../hooks/useStats';

/**
 * Auto Run session data shape from the API
 */
interface AutoRunSession {
  id: string;
  sessionId: string;
  agentType: string;
  documentPath?: string;
  startTime: number;
  duration: number;
  tasksTotal?: number;
  tasksCompleted?: number;
  projectPath?: string;
}

/**
 * Auto Run task data shape from the API
 */
interface AutoRunTask {
  id: string;
  autoRunSessionId: string;
  sessionId: string;
  agentType: string;
  taskIndex: number;
  taskContent?: string;
  startTime: number;
  duration: number;
  success: boolean;
}

interface AutoRunStatsProps {
  /** Current time range for filtering */
  timeRange: StatsTimeRange;
  /** Current theme for styling */
  theme: Theme;
}

/**
 * Format duration in milliseconds to human-readable string
 * Examples: "12h 34m", "5m 30s", "45s"
 */
function formatDuration(ms: number): string {
  if (ms === 0) return '0s';

  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

/**
 * Format large numbers with K/M suffixes for readability
 * Examples: "1.2K", "3.5M", "42"
 */
function formatNumber(num: number): string {
  if (num >= 1000000) {
    return `${(num / 1000000).toFixed(1)}M`;
  }
  if (num >= 1000) {
    return `${(num / 1000).toFixed(1)}K`;
  }
  return num.toString();
}

/**
 * Single metric card component
 */
interface MetricCardProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  subValue?: string;
  theme: Theme;
}

function MetricCard({ icon, label, value, subValue, theme }: MetricCardProps) {
  return (
    <div
      className="p-4 rounded-lg flex items-start gap-3"
      style={{ backgroundColor: theme.colors.bgMain }}
      data-testid="autorun-metric-card"
    >
      <div
        className="flex-shrink-0 p-2 rounded-md"
        style={{
          backgroundColor: `${theme.colors.accent}15`,
          color: theme.colors.accent,
        }}
      >
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div
          className="text-xs uppercase tracking-wide mb-1"
          style={{ color: theme.colors.textDim }}
        >
          {label}
        </div>
        <div
          className="text-2xl font-bold truncate"
          style={{ color: theme.colors.textMain }}
          title={value}
        >
          {value}
        </div>
        {subValue && (
          <div
            className="text-xs mt-1"
            style={{ color: theme.colors.textDim }}
          >
            {subValue}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Group tasks by date for the mini bar chart
 */
function groupTasksByDate(tasks: AutoRunTask[]): { date: string; count: number; successCount: number }[] {
  const grouped: Record<string, { count: number; successCount: number }> = {};

  tasks.forEach((task) => {
    const date = new Date(task.startTime).toISOString().split('T')[0];
    if (!grouped[date]) {
      grouped[date] = { count: 0, successCount: 0 };
    }
    grouped[date].count++;
    if (task.success) {
      grouped[date].successCount++;
    }
  });

  return Object.entries(grouped)
    .map(([date, stats]) => ({ date, ...stats }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function AutoRunStats({ timeRange, theme }: AutoRunStatsProps) {
  const [sessions, setSessions] = useState<AutoRunSession[]>([]);
  const [allTasks, setAllTasks] = useState<AutoRunTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hoveredBar, setHoveredBar] = useState<{ date: string; count: number; successCount: number } | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);

  // Fetch Auto Run sessions and their tasks
  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      // Get all Auto Run sessions for the time range
      const autoRunSessions = await window.maestro.stats.getAutoRunSessions(timeRange);
      setSessions(autoRunSessions);

      // Fetch tasks for all sessions
      const taskPromises = autoRunSessions.map((session) =>
        window.maestro.stats.getAutoRunTasks(session.id)
      );
      const taskResults = await Promise.all(taskPromises);
      const tasks = taskResults.flat();
      setAllTasks(tasks);
    } catch (err) {
      console.error('Failed to fetch Auto Run stats:', err);
      setError(err instanceof Error ? err.message : 'Failed to load Auto Run stats');
    } finally {
      setLoading(false);
    }
  }, [timeRange]);

  // Fetch data on mount and when time range changes
  useEffect(() => {
    fetchData();

    // Subscribe to stats updates
    const unsubscribe = window.maestro.stats.onStatsUpdate(() => {
      fetchData();
    });

    return () => unsubscribe();
  }, [fetchData]);

  // Calculate metrics
  const metrics = useMemo(() => {
    const totalSessions = sessions.length;
    const totalTasksCompleted = allTasks.filter((t) => t.success).length;
    const totalTasksAttempted = allTasks.length;

    // Average tasks per session
    const avgTasksPerSession = totalSessions > 0
      ? (totalTasksCompleted / totalSessions).toFixed(1)
      : '0';

    // Success rate
    const successRate = totalTasksAttempted > 0
      ? Math.round((totalTasksCompleted / totalTasksAttempted) * 100)
      : 0;

    // Average session duration
    const totalSessionDuration = sessions.reduce((sum, s) => sum + s.duration, 0);
    const avgSessionDuration = totalSessions > 0
      ? totalSessionDuration / totalSessions
      : 0;

    // Average task duration
    const totalTaskDuration = allTasks.reduce((sum, t) => sum + t.duration, 0);
    const avgTaskDuration = totalTasksAttempted > 0
      ? totalTaskDuration / totalTasksAttempted
      : 0;

    return {
      totalSessions,
      totalTasksCompleted,
      totalTasksAttempted,
      avgTasksPerSession,
      successRate,
      avgSessionDuration,
      avgTaskDuration,
    };
  }, [sessions, allTasks]);

  // Group tasks by date for chart
  const tasksByDate = useMemo(() => {
    const grouped = groupTasksByDate(allTasks);
    // Return last 14 days max
    return grouped.slice(-14);
  }, [allTasks]);

  // Max count for bar height calculation
  const maxCount = useMemo(() => {
    if (tasksByDate.length === 0) return 0;
    return Math.max(...tasksByDate.map((d) => d.count));
  }, [tasksByDate]);

  // Handle mouse events for tooltip
  const handleMouseEnter = useCallback(
    (data: { date: string; count: number; successCount: number }, event: React.MouseEvent<HTMLDivElement>) => {
      setHoveredBar(data);
      const rect = event.currentTarget.getBoundingClientRect();
      setTooltipPos({
        x: rect.left + rect.width / 2,
        y: rect.top - 8,
      });
    },
    []
  );

  const handleMouseLeave = useCallback(() => {
    setHoveredBar(null);
    setTooltipPos(null);
  }, []);

  if (loading) {
    return (
      <div
        className="p-4 rounded-lg"
        style={{ backgroundColor: theme.colors.bgMain }}
        data-testid="autorun-stats-loading"
      >
        <div
          className="h-48 flex items-center justify-center"
          style={{ color: theme.colors.textDim }}
        >
          Loading Auto Run stats...
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div
        className="p-4 rounded-lg"
        style={{ backgroundColor: theme.colors.bgMain }}
        data-testid="autorun-stats-error"
      >
        <div
          className="h-48 flex flex-col items-center justify-center gap-2"
          style={{ color: theme.colors.textDim }}
        >
          <span>Failed to load Auto Run stats</span>
          <button
            onClick={fetchData}
            className="px-3 py-1 rounded text-sm"
            style={{
              backgroundColor: theme.colors.accent,
              color: theme.colors.bgMain,
            }}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  // Check if there's any data
  const hasData = metrics.totalSessions > 0 || metrics.totalTasksAttempted > 0;

  if (!hasData) {
    return (
      <div
        className="p-4 rounded-lg"
        style={{ backgroundColor: theme.colors.bgMain }}
        data-testid="autorun-stats-empty"
      >
        <div
          className="h-48 flex flex-col items-center justify-center gap-3"
          style={{ color: theme.colors.textDim }}
        >
          <Play className="w-12 h-12 opacity-30" />
          <div className="text-center">
            <p className="text-sm mb-1" style={{ color: theme.colors.textMain }}>
              No Auto Run data yet
            </p>
            <p className="text-xs">
              Run some batch tasks to see your stats!
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="autorun-stats">
      {/* Metrics Cards */}
      <div className="grid grid-cols-6 gap-4" data-testid="autorun-metrics">
        <MetricCard
          icon={<Play className="w-4 h-4" />}
          label="Total Sessions"
          value={formatNumber(metrics.totalSessions)}
          theme={theme}
        />
        <MetricCard
          icon={<CheckSquare className="w-4 h-4" />}
          label="Tasks Done"
          value={formatNumber(metrics.totalTasksCompleted)}
          subValue={`of ${formatNumber(metrics.totalTasksAttempted)} attempted`}
          theme={theme}
        />
        <MetricCard
          icon={<ListChecks className="w-4 h-4" />}
          label="Avg Tasks/Session"
          value={metrics.avgTasksPerSession}
          theme={theme}
        />
        <MetricCard
          icon={<Target className="w-4 h-4" />}
          label="Success Rate"
          value={`${metrics.successRate}%`}
          theme={theme}
        />
        <MetricCard
          icon={<Clock className="w-4 h-4" />}
          label="Avg Session"
          value={formatDuration(metrics.avgSessionDuration)}
          theme={theme}
        />
        <MetricCard
          icon={<Timer className="w-4 h-4" />}
          label="Avg Task"
          value={formatDuration(metrics.avgTaskDuration)}
          theme={theme}
        />
      </div>

      {/* Mini Bar Chart: Tasks over time */}
      <div
        className="p-4 rounded-lg"
        style={{ backgroundColor: theme.colors.bgMain }}
        data-testid="autorun-tasks-chart"
      >
        <h3
          className="text-sm font-medium mb-4"
          style={{ color: theme.colors.textMain }}
        >
          Tasks Completed Over Time
        </h3>

        {tasksByDate.length > 0 ? (
          <div className="relative">
            <div className="flex items-end gap-1 h-32">
              {tasksByDate.map((day) => {
                const height = maxCount > 0 ? (day.count / maxCount) * 100 : 0;
                const successRatio = day.count > 0 ? day.successCount / day.count : 0;
                const isHovered = hoveredBar?.date === day.date;

                return (
                  <div
                    key={day.date}
                    className="flex-1 min-w-[16px] max-w-[40px] rounded-t cursor-pointer transition-all duration-200"
                    style={{
                      height: `${Math.max(height, 4)}%`,
                      backgroundColor: theme.colors.accent,
                      opacity: isHovered ? 1 : 0.7 + (successRatio * 0.3),
                    }}
                    onMouseEnter={(e) => handleMouseEnter(day, e)}
                    onMouseLeave={handleMouseLeave}
                    data-testid={`task-bar-${day.date}`}
                  />
                );
              })}
            </div>

            {/* X-axis labels (show first, middle, last) */}
            <div
              className="flex justify-between mt-2 text-xs"
              style={{ color: theme.colors.textDim }}
            >
              {tasksByDate.length > 0 && (
                <>
                  <span>{formatDateLabel(tasksByDate[0].date)}</span>
                  {tasksByDate.length > 2 && (
                    <span>{formatDateLabel(tasksByDate[Math.floor(tasksByDate.length / 2)].date)}</span>
                  )}
                  {tasksByDate.length > 1 && (
                    <span>{formatDateLabel(tasksByDate[tasksByDate.length - 1].date)}</span>
                  )}
                </>
              )}
            </div>

            {/* Tooltip */}
            {hoveredBar && tooltipPos && (
              <div
                className="fixed z-50 px-3 py-2 rounded text-xs whitespace-nowrap pointer-events-none shadow-lg"
                style={{
                  left: tooltipPos.x,
                  top: tooltipPos.y,
                  transform: 'translate(-50%, -100%)',
                  backgroundColor: theme.colors.bgActivity,
                  color: theme.colors.textMain,
                  border: `1px solid ${theme.colors.border}`,
                }}
                data-testid="task-bar-tooltip"
              >
                <div className="font-medium mb-1">{formatFullDate(hoveredBar.date)}</div>
                <div style={{ color: theme.colors.textDim }}>
                  <div>{hoveredBar.count} tasks completed</div>
                  <div>{hoveredBar.successCount} successful ({Math.round((hoveredBar.successCount / hoveredBar.count) * 100)}%)</div>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div
            className="h-32 flex items-center justify-center"
            style={{ color: theme.colors.textDim }}
          >
            <span className="text-sm">No task data available</span>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Format date for X-axis labels (short format)
 */
function formatDateLabel(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Format date for tooltip (full format)
 */
function formatFullDate(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

export default AutoRunStats;
