/**
 * ActivityHeatmap
 *
 * GitHub-style contribution heatmap showing AI usage activity.
 * For day/week view: shows hours (0-23) on Y-axis, days on X-axis.
 * For month/year/all view: GitHub-style grid with weeks as columns, days of week as rows.
 *
 * Features:
 * - GitHub-style layout for month+ views (weeks as columns, Mon-Sun as rows)
 * - Color intensity toggle between query count and duration
 * - Tooltip on hover showing exact date and count/duration
 * - Theme-aware gradient colors (bgSecondary → accent)
 * - Fits within viewport width for year-long data
 * - Month labels above the grid for navigation
 */

import React, { useState, useMemo, useCallback } from 'react';
import { format, subDays, startOfWeek, addDays, getDay } from 'date-fns';
import type { Theme } from '../../types';
import type { StatsTimeRange, StatsAggregation } from '../../hooks/useStats';
import { COLORBLIND_HEATMAP_SCALE } from '../../constants/colorblindPalettes';

// Metric display mode
type MetricMode = 'count' | 'duration';

interface HourData {
  date: Date;
  hour: number; // 0-23
  dateString: string; // yyyy-MM-dd
  hourKey: string; // yyyy-MM-dd-HH
  count: number;
  duration: number;
  intensity: number; // 0-4 scale for color intensity
}

interface DayColumn {
  date: Date;
  dateString: string;
  dayLabel: string;
  hours: HourData[];
}

// GitHub-style data structures
interface DayCell {
  date: Date;
  dateString: string;
  dayOfWeek: number; // 0 = Sunday, 6 = Saturday
  count: number;
  duration: number;
  intensity: number;
  isPlaceholder?: boolean; // For empty cells before start date
}

interface WeekColumn {
  weekStart: Date;
  days: DayCell[];
}

interface MonthLabel {
  month: string;
  colSpan: number;
  startCol: number;
}

interface ActivityHeatmapProps {
  /** Aggregated stats data from the API */
  data: StatsAggregation;
  /** Current time range selection */
  timeRange: StatsTimeRange;
  /** Current theme for styling */
  theme: Theme;
  /** Enable colorblind-friendly colors */
  colorBlindMode?: boolean;
}

/**
 * Get the number of days to display based on time range
 */
function getDaysForRange(timeRange: StatsTimeRange): number {
  switch (timeRange) {
    case 'day':
      return 1;
    case 'week':
      return 7;
    case 'month':
      return 30;
    case 'year':
      return 365;
    case 'all':
      return 365; // Show last year for "all time"
    default:
      return 7;
  }
}

/**
 * Check if we should use single-day mode (one pixel per day, no hour breakdown)
 * Used for month+ time ranges where AM/PM split would be too cramped
 */
function shouldUseSingleDayMode(timeRange: StatsTimeRange): boolean {
  return timeRange === 'month' || timeRange === 'year' || timeRange === 'all';
}

/**
 * Format duration in milliseconds to human-readable string
 */
function formatDuration(ms: number): string {
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
 * Calculate intensity level (0-4) from a value and max value
 * Level 0 = no activity, 1-4 = increasing activity
 */
function calculateIntensity(value: number, maxValue: number): number {
  if (value === 0) return 0;
  if (maxValue === 0) return 0;

  const ratio = value / maxValue;
  if (ratio <= 0.25) return 1;
  if (ratio <= 0.5) return 2;
  if (ratio <= 0.75) return 3;
  return 4;
}

/**
 * Build GitHub-style week columns for the heatmap
 * Returns weeks as columns with 7 days each (Sun-Sat or Mon-Sun based on locale)
 */
function buildGitHubGrid(
  numDays: number,
  dayDataMap: Map<string, { count: number; duration: number }>,
  metricMode: MetricMode
): { weeks: WeekColumn[]; monthLabels: MonthLabel[]; maxCount: number; maxDuration: number } {
  const today = new Date();
  const startDate = subDays(today, numDays - 1);

  // Find the Sunday before or on the start date (week starts on Sunday like GitHub)
  const gridStart = startOfWeek(startDate, { weekStartsOn: 0 });

  const weeks: WeekColumn[] = [];
  const monthLabels: MonthLabel[] = [];
  let maxCount = 0;
  let maxDuration = 0;

  let currentDate = gridStart;
  let currentWeek: DayCell[] = [];
  let lastMonth = '';

  // Build grid until we pass today
  let weekIndex = 0;
  while (currentDate <= today || currentWeek.length > 0) {
    const dateString = format(currentDate, 'yyyy-MM-dd');
    const dayOfWeek = getDay(currentDate); // 0 = Sunday
    const isBeforeStart = currentDate < startDate;
    const isAfterEnd = currentDate > today;

    // Track month changes for labels
    const monthStr = format(currentDate, 'MMM');
    if (monthStr !== lastMonth && !isBeforeStart && !isAfterEnd) {
      // Start of a new month
      if (lastMonth !== '') {
        // Close out the previous month label
        const lastLabel = monthLabels[monthLabels.length - 1];
        if (lastLabel) {
          lastLabel.colSpan = weekIndex - lastLabel.startCol;
        }
      }
      monthLabels.push({
        month: monthStr,
        colSpan: 1, // Will be updated when month ends
        startCol: weekIndex,
      });
      lastMonth = monthStr;
    }

    const dayStats = dayDataMap.get(dateString) || { count: 0, duration: 0 };

    if (!isBeforeStart && !isAfterEnd) {
      maxCount = Math.max(maxCount, dayStats.count);
      maxDuration = Math.max(maxDuration, dayStats.duration);
    }

    currentWeek.push({
      date: new Date(currentDate),
      dateString,
      dayOfWeek,
      count: isBeforeStart || isAfterEnd ? 0 : dayStats.count,
      duration: isBeforeStart || isAfterEnd ? 0 : dayStats.duration,
      intensity: 0, // Calculated later
      isPlaceholder: isBeforeStart || isAfterEnd,
    });

    // When we complete a week (Saturday = day 6)
    if (dayOfWeek === 6) {
      weeks.push({
        weekStart: startOfWeek(currentDate, { weekStartsOn: 0 }),
        days: currentWeek,
      });
      currentWeek = [];
      weekIndex++;
    }

    currentDate = addDays(currentDate, 1);

    // Stop if we've gone past today and completed the week
    if (isAfterEnd && dayOfWeek === 6) {
      break;
    }
  }

  // Handle partial last week
  if (currentWeek.length > 0) {
    // Fill remaining days as placeholders
    while (currentWeek.length < 7) {
      const nextDate = addDays(currentWeek[currentWeek.length - 1].date, 1);
      currentWeek.push({
        date: nextDate,
        dateString: format(nextDate, 'yyyy-MM-dd'),
        dayOfWeek: getDay(nextDate),
        count: 0,
        duration: 0,
        intensity: 0,
        isPlaceholder: true,
      });
    }
    weeks.push({
      weekStart: startOfWeek(currentWeek[0].date, { weekStartsOn: 0 }),
      days: currentWeek,
    });
  }

  // Close out the last month label
  if (monthLabels.length > 0) {
    const lastLabel = monthLabels[monthLabels.length - 1];
    lastLabel.colSpan = weeks.length - lastLabel.startCol;
  }

  // Calculate intensities
  const maxVal = metricMode === 'count' ? Math.max(maxCount, 1) : Math.max(maxDuration, 1);
  weeks.forEach((week) => {
    week.days.forEach((day) => {
      if (!day.isPlaceholder) {
        const value = metricMode === 'count' ? day.count : day.duration;
        day.intensity = calculateIntensity(value, maxVal);
      }
    });
  });

  return { weeks, monthLabels, maxCount, maxDuration };
}

/**
 * Get color for a given intensity level
 */
function getIntensityColor(intensity: number, theme: Theme, colorBlindMode?: boolean): string {
  // Use colorblind-safe palette when colorblind mode is enabled
  if (colorBlindMode) {
    const clampedIntensity = Math.max(0, Math.min(4, Math.round(intensity)));
    return COLORBLIND_HEATMAP_SCALE[clampedIntensity];
  }

  const accent = theme.colors.accent;
  const bgSecondary = theme.colors.bgActivity;

  // Parse the accent color to get RGB values for interpolation
  let accentRgb: { r: number; g: number; b: number } | null = null;

  if (accent.startsWith('#')) {
    const hex = accent.slice(1);
    accentRgb = {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
    };
  } else if (accent.startsWith('rgb')) {
    const match = accent.match(/\d+/g);
    if (match && match.length >= 3) {
      accentRgb = {
        r: parseInt(match[0]),
        g: parseInt(match[1]),
        b: parseInt(match[2]),
      };
    }
  }

  // Fallback to accent with varying opacity if parsing fails
  if (!accentRgb) {
    const opacities = [0.1, 0.3, 0.5, 0.7, 1.0];
    return `${accent}${Math.round(opacities[intensity] * 255).toString(16).padStart(2, '0')}`;
  }

  // Generate colors for each intensity level
  switch (intensity) {
    case 0:
      return bgSecondary;
    case 1:
      return `rgba(${accentRgb.r}, ${accentRgb.g}, ${accentRgb.b}, 0.2)`;
    case 2:
      return `rgba(${accentRgb.r}, ${accentRgb.g}, ${accentRgb.b}, 0.4)`;
    case 3:
      return `rgba(${accentRgb.r}, ${accentRgb.g}, ${accentRgb.b}, 0.6)`;
    case 4:
      return `rgba(${accentRgb.r}, ${accentRgb.g}, ${accentRgb.b}, 0.9)`;
    default:
      return bgSecondary;
  }
}


export function ActivityHeatmap({ data, timeRange, theme, colorBlindMode = false }: ActivityHeatmapProps) {
  const [metricMode, setMetricMode] = useState<MetricMode>('count');
  const [hoveredCell, setHoveredCell] = useState<HourData | DayCell | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);

  const useGitHubLayout = shouldUseSingleDayMode(timeRange);

  // Convert byDay data to a lookup map
  const dayDataMap = useMemo(() => {
    const map = new Map<string, { count: number; duration: number }>();
    for (const day of data.byDay) {
      map.set(day.date, { count: day.count, duration: day.duration });
    }
    return map;
  }, [data.byDay]);

  // GitHub-style grid data for month/year/all views
  const gitHubGrid = useMemo(() => {
    if (!useGitHubLayout) return null;
    const numDays = getDaysForRange(timeRange);
    return buildGitHubGrid(numDays, dayDataMap, metricMode);
  }, [useGitHubLayout, timeRange, dayDataMap, metricMode]);

  // Generate hour-based data for the heatmap (day/week views)
  const { dayColumns, hourLabels } = useMemo(() => {
    if (useGitHubLayout) {
      return { dayColumns: [], hourLabels: [] };
    }

    const numDays = getDaysForRange(timeRange);
    const today = new Date();
    const columns: DayColumn[] = [];

    // Determine hour rows based on mode
    const hours = Array.from({ length: 24 }, (_, i) => i);
    const labels = ['12a', '1a', '2a', '3a', '4a', '5a', '6a', '7a', '8a', '9a', '10a', '11a', '12p', '1p', '2p', '3p', '4p', '5p', '6p', '7p', '8p', '9p', '10p', '11p'];

    // Track max values for intensity calculation
    let maxCount = 0;
    let maxDuration = 0;

    // Generate days from (numDays-1) days ago to today
    for (let dayOffset = numDays - 1; dayOffset >= 0; dayOffset--) {
      const date = subDays(today, dayOffset);
      const dateString = format(date, 'yyyy-MM-dd');
      const dayStats = dayDataMap.get(dateString) || { count: 0, duration: 0 };

      const hourData: HourData[] = hours.map((hour) => {
        // Distribute evenly across hours (simplified - real data would have hourly breakdown)
        let count = Math.floor(dayStats.count / 24);
        let duration = Math.floor(dayStats.duration / 24);
        // Distribute remainder to typical work hours (9-17)
        if (hour >= 9 && hour <= 17) {
          count += Math.floor((dayStats.count % 24) / 9);
          duration += Math.floor((dayStats.duration % 24) / 9);
        }

        maxCount = Math.max(maxCount, count);
        maxDuration = Math.max(maxDuration, duration);

        return {
          date,
          hour,
          dateString,
          hourKey: `${dateString}-${hour.toString().padStart(2, '0')}`,
          count,
          duration,
          intensity: 0,
        };
      });

      columns.push({
        date,
        dateString,
        dayLabel: format(date, numDays <= 7 ? 'EEE' : 'd'),
        hours: hourData,
      });
    }

    // Now calculate intensities with known max values
    const maxVal = metricMode === 'count' ? Math.max(maxCount, 1) : Math.max(maxDuration, 1);
    columns.forEach((col) => {
      col.hours.forEach((hourData) => {
        const value = metricMode === 'count' ? hourData.count : hourData.duration;
        hourData.intensity = calculateIntensity(value, maxVal);
      });
    });

    return {
      dayColumns: columns,
      hourLabels: labels,
    };
  }, [dayDataMap, metricMode, timeRange, useGitHubLayout]);

  // Handle mouse events for tooltip (HourData for day/week, DayCell for month+)
  const handleMouseEnterHour = useCallback(
    (cell: HourData, event: React.MouseEvent<HTMLDivElement>) => {
      setHoveredCell(cell);
      const rect = event.currentTarget.getBoundingClientRect();
      setTooltipPos({
        x: rect.left + rect.width / 2,
        y: rect.top,
      });
    },
    []
  );

  const handleMouseEnterDay = useCallback(
    (cell: DayCell, event: React.MouseEvent<HTMLDivElement>) => {
      if (cell.isPlaceholder) return;
      setHoveredCell(cell);
      const rect = event.currentTarget.getBoundingClientRect();
      setTooltipPos({
        x: rect.left + rect.width / 2,
        y: rect.top,
      });
    },
    []
  );

  const handleMouseLeave = useCallback(() => {
    setHoveredCell(null);
    setTooltipPos(null);
  }, []);

  // Day of week labels for GitHub layout (Sun-Sat)
  const dayOfWeekLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  return (
    <div
      className="p-4 rounded-lg"
      style={{ backgroundColor: theme.colors.bgMain }}
      role="figure"
      aria-label={`Activity heatmap showing ${metricMode === 'count' ? 'query activity' : 'duration'} over ${getDaysForRange(timeRange)} days.`}
    >
      {/* Header with title and metric toggle */}
      <div className="flex items-center justify-between mb-4">
        <h3
          className="text-sm font-medium"
          style={{ color: theme.colors.textMain }}
        >
          Activity Heatmap
        </h3>
        <div className="flex items-center gap-2">
          <span
            className="text-xs"
            style={{ color: theme.colors.textDim }}
          >
            Show:
          </span>
          <div
            className="flex rounded overflow-hidden border"
            style={{ borderColor: theme.colors.border }}
          >
            <button
              onClick={() => setMetricMode('count')}
              className="px-2 py-1 text-xs transition-colors"
              style={{
                backgroundColor:
                  metricMode === 'count'
                    ? `${theme.colors.accent}20`
                    : 'transparent',
                color:
                  metricMode === 'count'
                    ? theme.colors.accent
                    : theme.colors.textDim,
              }}
              aria-pressed={metricMode === 'count'}
              aria-label="Show query count"
            >
              Count
            </button>
            <button
              onClick={() => setMetricMode('duration')}
              className="px-2 py-1 text-xs transition-colors"
              style={{
                backgroundColor:
                  metricMode === 'duration'
                    ? `${theme.colors.accent}20`
                    : 'transparent',
                color:
                  metricMode === 'duration'
                    ? theme.colors.accent
                    : theme.colors.textDim,
                borderLeft: `1px solid ${theme.colors.border}`,
              }}
              aria-pressed={metricMode === 'duration'}
              aria-label="Show total duration"
            >
              Duration
            </button>
          </div>
        </div>
      </div>

      {/* GitHub-style heatmap for month/year/all views */}
      {useGitHubLayout && gitHubGrid && (
        <div className="flex gap-2">
          {/* Day of week labels (Y-axis) */}
          <div className="flex flex-col flex-shrink-0" style={{ width: 32, paddingTop: 20 }}>
            {dayOfWeekLabels.map((label, idx) => (
              <div
                key={idx}
                className="text-xs text-right flex items-center justify-end pr-1"
                style={{
                  color: theme.colors.textDim,
                  height: 13,
                }}
              >
                {/* Only show Mon, Wed, Fri for cleaner look */}
                {idx % 2 === 1 ? label : ''}
              </div>
            ))}
          </div>

          {/* Grid container */}
          <div className="flex-1 overflow-x-auto">
            {/* Month labels row */}
            <div className="flex" style={{ marginBottom: 4, height: 16 }}>
              {gitHubGrid.monthLabels.map((monthLabel, idx) => (
                <div
                  key={`${monthLabel.month}-${idx}`}
                  className="text-xs"
                  style={{
                    color: theme.colors.textDim,
                    width: monthLabel.colSpan * 13, // 11px cell + 2px gap
                    paddingLeft: 2,
                    flexShrink: 0,
                  }}
                >
                  {monthLabel.colSpan >= 3 ? monthLabel.month : ''}
                </div>
              ))}
            </div>

            {/* Week columns */}
            <div className="flex gap-[2px]">
              {gitHubGrid.weeks.map((week, weekIdx) => (
                <div
                  key={weekIdx}
                  className="flex flex-col gap-[2px]"
                  style={{ width: 11, flexShrink: 0 }}
                >
                  {week.days.map((day) => (
                    <div
                      key={day.dateString}
                      className="rounded-sm cursor-default"
                      style={{
                        width: 11,
                        height: 11,
                        backgroundColor: day.isPlaceholder
                          ? 'transparent'
                          : getIntensityColor(day.intensity, theme, colorBlindMode),
                        outline:
                          hoveredCell && 'dateString' in hoveredCell && hoveredCell.dateString === day.dateString && !day.isPlaceholder
                            ? `2px solid ${theme.colors.accent}`
                            : 'none',
                        outlineOffset: -1,
                        transition: 'background-color 0.3s ease, outline 0.15s ease',
                      }}
                      onMouseEnter={(e) => handleMouseEnterDay(day, e)}
                      onMouseLeave={handleMouseLeave}
                      role="gridcell"
                      aria-label={day.isPlaceholder ? '' : `${format(day.date, 'MMM d, yyyy')}: ${day.count} ${day.count === 1 ? 'query' : 'queries'}${day.duration > 0 ? `, ${formatDuration(day.duration)}` : ''}`}
                      tabIndex={day.isPlaceholder ? -1 : 0}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Original hourly heatmap for day/week views */}
      {!useGitHubLayout && (
        <div className="flex gap-2">
          {/* Hour labels (Y-axis) */}
          <div className="flex flex-col flex-shrink-0" style={{ width: 28, paddingTop: 18 }}>
            {hourLabels.map((label, idx) => (
              <div
                key={idx}
                className="text-xs text-right flex items-center justify-end"
                style={{
                  color: theme.colors.textDim,
                  height: 16,
                }}
              >
                {/* Only show labels for even hours (0, 2, 4, etc.) */}
                {idx % 2 === 0 ? label : ''}
              </div>
            ))}
          </div>

          {/* Grid of cells */}
          <div className="flex-1">
            <div className="flex gap-[3px]">
              {dayColumns.map((col) => (
                <div
                  key={col.dateString}
                  className="flex flex-col gap-[2px] flex-1"
                  style={{ minWidth: 20 }}
                >
                  {/* Day label */}
                  <div
                    className="text-xs text-center truncate h-[16px] flex items-center justify-center"
                    style={{ color: theme.colors.textDim }}
                    title={format(col.date, 'EEEE, MMM d')}
                  >
                    {col.dayLabel}
                  </div>
                  {/* Hour cells */}
                  {col.hours.map((hourData) => (
                    <div
                      key={hourData.hourKey}
                      className="rounded-sm cursor-default"
                      style={{
                        height: 14,
                        backgroundColor: getIntensityColor(
                          hourData.intensity,
                          theme,
                          colorBlindMode
                        ),
                        outline:
                          hoveredCell && 'hourKey' in hoveredCell && hoveredCell.hourKey === hourData.hourKey
                            ? `2px solid ${theme.colors.accent}`
                            : 'none',
                        outlineOffset: -1,
                        transition: 'background-color 0.3s ease, outline 0.15s ease',
                      }}
                      onMouseEnter={(e) => handleMouseEnterHour(hourData, e)}
                      onMouseLeave={handleMouseLeave}
                      role="gridcell"
                      aria-label={`${format(hourData.date, 'MMM d')} ${hourData.hour}:00: ${hourData.count} ${hourData.count === 1 ? 'query' : 'queries'}${hourData.duration > 0 ? `, ${formatDuration(hourData.duration)}` : ''}`}
                      tabIndex={0}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Legend */}
      <div className="flex items-center justify-end gap-2 mt-3" role="list" aria-label="Activity intensity scale from less to more">
        <span
          className="text-xs"
          style={{ color: theme.colors.textDim }}
          aria-hidden="true"
        >
          Less
        </span>
        {[0, 1, 2, 3, 4].map((level) => (
          <div
            key={level}
            className="rounded-sm"
            style={{
              width: 12,
              height: 12,
              backgroundColor: getIntensityColor(level, theme, colorBlindMode),
            }}
            role="listitem"
            aria-label={`Intensity level ${level}: ${level === 0 ? 'No activity' : level === 1 ? 'Low' : level === 2 ? 'Medium-low' : level === 3 ? 'Medium-high' : 'High'} activity`}
          />
        ))}
        <span
          className="text-xs"
          style={{ color: theme.colors.textDim }}
          aria-hidden="true"
        >
          More
        </span>
      </div>

      {/* Tooltip */}
      {hoveredCell && tooltipPos && (() => {
        const tooltipWidth = 180;
        const tooltipHeight = 50;
        const viewportWidth = window.innerWidth;
        const margin = 12;

        // Calculate horizontal position with edge detection
        let left = tooltipPos.x;
        let transformX = '-50%'; // Default: centered

        // Check right edge overflow
        if (tooltipPos.x + tooltipWidth / 2 > viewportWidth - margin) {
          left = viewportWidth - margin;
          transformX = '-100%';
        }
        // Check left edge overflow
        else if (tooltipPos.x - tooltipWidth / 2 < margin) {
          left = margin;
          transformX = '0%';
        }

        // Check if tooltip would overflow top - if so, show below
        const wouldOverflowTop = tooltipPos.y - tooltipHeight - margin < 0;

        // Determine if this is a DayCell or HourData
        const isDayCell = 'dayOfWeek' in hoveredCell;

        return (
          <div
            className="fixed z-50 px-2 py-1.5 rounded text-xs whitespace-nowrap pointer-events-none shadow-lg"
            style={{
              left,
              top: wouldOverflowTop ? tooltipPos.y + 20 : tooltipPos.y - 8,
              transform: `translate(${transformX}, ${wouldOverflowTop ? '0%' : '-100%'})`,
              backgroundColor: theme.colors.bgActivity,
              color: theme.colors.textMain,
              border: `1px solid ${theme.colors.border}`,
            }}
          >
            <div className="font-medium mb-0.5">
              {format(hoveredCell.date, 'EEEE, MMM d, yyyy')}
              {!isDayCell && 'hour' in hoveredCell && ` at ${hoveredCell.hour}:00`}
            </div>
            <div style={{ color: theme.colors.textDim }}>
              {hoveredCell.count} {hoveredCell.count === 1 ? 'query' : 'queries'}
              {hoveredCell.duration > 0 && (
                <span> • {formatDuration(hoveredCell.duration)}</span>
              )}
            </div>
          </div>
        );
      })()}
    </div>
  );
}

export default ActivityHeatmap;
