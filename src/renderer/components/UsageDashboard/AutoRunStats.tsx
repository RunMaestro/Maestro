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

import React, { memo, useState, useEffect, useMemo, useCallback } from 'react';
import { Play, CheckSquare, ListChecks, Target, Clock, Timer } from 'lucide-react';
import type { Theme } from '../../types';
import type { StatsTimeRange, AutoRunSession } from '../../../shared/stats-types';
import { captureException } from '../../utils/sentry';
import { formatDurationHuman as formatDuration, formatNumber } from '../../../shared/formatters';
import { ChartTooltip } from './ChartTooltip';

interface AutoRunStatsProps {
	/** Current time range for filtering */
	timeRange: StatsTimeRange;
	/** Current theme for styling */
	theme: Theme;
	/** Number of columns for responsive layout (default: 6) */
	columns?: number;
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
			role="group"
			aria-label={`${label}: ${value}${subValue ? `, ${subValue}` : ''}`}
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
					<div className="text-xs mt-1" style={{ color: theme.colors.textDim }}>
						{subValue}
					</div>
				)}
			</div>
		</div>
	);
}

/**
 * Group sessions by local date for the "Tasks Completed Over Time" chart.
 *
 * `count` here is **attempted** task total (kept for the tooltip's "%
 * successful" math) and `successCount` is the actual number of completed
 * checkboxes. We drop a day only when *both* are zero — earlier we filtered
 * on `count > 0`, which silently hid recent days where `tasksTotal` was 0/
 * null (e.g. ad-hoc autoruns added mid-session) even when work was completed.
 */
function groupSessionsByDate(
	sessions: AutoRunSession[]
): { date: string; count: number; successCount: number }[] {
	const grouped: Record<string, { count: number; successCount: number }> = {};

	sessions.forEach((session) => {
		// Use local date string to match what users see in labels/tooltips
		const d = new Date(session.startTime);
		const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
		if (!grouped[date]) {
			grouped[date] = { count: 0, successCount: 0 };
		}
		grouped[date].count += session.tasksTotal ?? 0;
		grouped[date].successCount += session.tasksCompleted ?? 0;
	});

	return Object.entries(grouped)
		.map(([date, stats]) => ({ date, ...stats }))
		.filter((entry) => entry.count > 0 || entry.successCount > 0)
		.sort((a, b) => a.date.localeCompare(b.date));
}

export const AutoRunStats = memo(function AutoRunStats({
	timeRange,
	theme,
	columns = 6,
}: AutoRunStatsProps) {
	const [sessions, setSessions] = useState<AutoRunSession[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [hoveredBar, setHoveredBar] = useState<{
		date: string;
		count: number;
		successCount: number;
	} | null>(null);
	const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);

	// Fetch Auto Run sessions (metrics and chart both derive from session-level data)
	const fetchData = useCallback(async () => {
		setLoading(true);
		setError(null);

		try {
			const autoRunSessions = await window.maestro.stats.getAutoRunSessions(timeRange);
			setSessions(autoRunSessions);
		} catch (err) {
			captureException(err);
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

	// Calculate metrics from session-level data (tasksCompleted = checkboxes, not agent invocations)
	const metrics = useMemo(() => {
		const totalSessions = sessions.length;
		const totalTasksCompleted = sessions.reduce((sum, s) => sum + (s.tasksCompleted ?? 0), 0);
		const totalTasksAttempted = sessions.reduce((sum, s) => sum + (s.tasksTotal ?? 0), 0);

		// Average tasks per session (completed checkboxes per session)
		const avgTasksPerSession =
			totalSessions > 0 ? (totalTasksCompleted / totalSessions).toFixed(1) : '0';

		// Success rate (completed / attempted checkboxes)
		const successRate =
			totalTasksAttempted > 0 ? Math.round((totalTasksCompleted / totalTasksAttempted) * 100) : 0;

		// Average session duration
		const totalSessionDuration = sessions.reduce((sum, s) => sum + s.duration, 0);
		const avgSessionDuration = totalSessions > 0 ? totalSessionDuration / totalSessions : 0;

		// Average task duration (session time / checkboxes completed)
		const avgTaskDuration =
			totalTasksCompleted > 0 ? totalSessionDuration / totalTasksCompleted : 0;

		return {
			totalSessions,
			totalTasksCompleted,
			totalTasksAttempted,
			avgTasksPerSession,
			successRate,
			avgSessionDuration,
			avgTaskDuration,
		};
	}, [sessions]);

	// Group sessions by date for chart (uses session-level tasksCompleted)
	const tasksByDate = useMemo(() => {
		return groupSessionsByDate(sessions);
	}, [sessions]);

	// Max for bar height calculation — driven by tasks completed (the chart's
	// titular metric), not tasks attempted, so days where `tasksTotal` is 0
	// but real completions exist still scale correctly.
	const maxCount = useMemo(() => {
		if (tasksByDate.length === 0) return 0;
		return Math.max(...tasksByDate.map((d) => Math.max(d.successCount, d.count)));
	}, [tasksByDate]);

	// Handle mouse events for tooltip. Anchor to the cursor (not the bar's
	// bounding rect) so the tooltip stays close to the user's pointer — short
	// bars used to leave the tooltip stranded near the chart's bottom edge.
	const handleMouseEnter = useCallback(
		(
			data: { date: string; count: number; successCount: number },
			event: React.MouseEvent<HTMLDivElement>
		) => {
			setHoveredBar(data);
			setTooltipPos({ x: event.clientX, y: event.clientY });
		},
		[]
	);
	const handleMouseMove = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
		setTooltipPos({ x: event.clientX, y: event.clientY });
	}, []);

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
						<p className="text-xs">Run some batch tasks to see your stats!</p>
					</div>
				</div>
			</div>
		);
	}

	return (
		<div
			className="space-y-4"
			data-testid="autorun-stats"
			role="region"
			aria-label="Auto Run statistics"
		>
			{/* Metrics Cards */}
			<div
				className="grid gap-4"
				style={{
					gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
				}}
				data-testid="autorun-metrics"
				role="region"
				aria-label="Auto Run summary metrics"
			>
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
				role="figure"
				aria-label={`Tasks completed over time chart. ${tasksByDate.length} days of data.`}
			>
				<h3
					className="text-sm font-medium mb-4"
					style={{ color: theme.colors.textMain, animation: 'card-enter 0.4s ease both' }}
				>
					Tasks Completed Over Time
				</h3>

				{tasksByDate.length > 0 ? (
					<div className="relative">
						<div
							className="flex items-end gap-1 h-32"
							role="list"
							aria-label="Tasks completed by date"
						>
							{tasksByDate.map((day) => {
								// Bar height tracks the tasks-completed value the chart claims to
								// show. Fall back to attempted when no completion data exists so
								// runs that errored out still surface a bar.
								const barValue = day.successCount > 0 ? day.successCount : day.count;
								const height = maxCount > 0 ? (barValue / maxCount) * 100 : 0;
								const successRatio = day.count > 0 ? day.successCount / day.count : 0;
								const isHovered = hoveredBar?.date === day.date;

								return (
									<div
										key={day.date}
										className="flex-1 min-w-[16px] max-w-[40px] rounded-t cursor-pointer transition-all duration-200"
										style={{
											height: `${Math.max(height, 4)}%`,
											backgroundColor: theme.colors.accent,
											opacity: isHovered ? 1 : 0.7 + successRatio * 0.3,
										}}
										onMouseEnter={(e) => handleMouseEnter(day, e)}
										onMouseMove={handleMouseMove}
										onMouseLeave={handleMouseLeave}
										onKeyDown={(e) => {
											if (e.key === 'Enter' || e.key === ' ') {
												e.preventDefault();
												setHoveredBar((prev) => (prev?.date === day.date ? null : day));
											}
											if (e.key === 'Escape') {
												handleMouseLeave();
											}
										}}
										onBlur={handleMouseLeave}
										data-testid={`task-bar-${day.date}`}
										role="listitem"
										aria-label={`${formatFullDate(day.date)}: ${day.count} tasks attempted, ${day.successCount} successful (${day.count > 0 ? Math.round((day.successCount / day.count) * 100) : 0}%)`}
										tabIndex={0}
									/>
								);
							})}
						</div>

						{/* X-axis labels — must mirror the bar grid (flex-1 + max-w-[40px] +
						    gap-1) so each label slot lines up with its bar. We previously
						    used `flex justify-between` across the full container width,
						    which floated the middle/last labels into the empty space on
						    the right when bars hit their `max-w-[40px]` cap. */}
						<div
							className="flex gap-1 mt-2 text-xs"
							style={{ color: theme.colors.textDim }}
							aria-hidden="true"
						>
							{tasksByDate.map((day, i) => {
								const isFirst = i === 0;
								const isLast = i === tasksByDate.length - 1;
								const isMiddle = tasksByDate.length > 2 && i === Math.floor(tasksByDate.length / 2);
								const showLabel = isFirst || isLast || isMiddle;
								// Anchor first/last labels to their bar's outer edge so the
								// label text doesn't drift past the bar; middle stays centered.
								const textAlign = isFirst ? 'left' : isLast ? 'right' : 'center';
								return (
									<div
										key={day.date}
										className="flex-1 min-w-[16px] max-w-[40px]"
										style={{
											textAlign,
											overflow: 'visible',
											whiteSpace: 'nowrap',
										}}
									>
										{showLabel ? formatDateLabel(day.date) : ''}
									</div>
								);
							})}
						</div>

						{hoveredBar && (
							<ChartTooltip anchor={tooltipPos} theme={theme} testId="task-bar-tooltip">
								<div className="font-medium mb-1">{formatFullDate(hoveredBar.date)}</div>
								<div style={{ color: theme.colors.textDim }}>
									<div>{hoveredBar.count} tasks attempted</div>
									<div>
										{hoveredBar.successCount} successful (
										{hoveredBar.count > 0
											? Math.round((hoveredBar.successCount / hoveredBar.count) * 100)
											: 0}
										%)
									</div>
								</div>
							</ChartTooltip>
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
});

/**
 * Parse a local YYYY-MM-DD date string without UTC shift.
 * new Date("2026-02-13") parses as UTC midnight, which shifts to the previous
 * day in negative UTC offsets. Appending T00:00 forces local-time parsing.
 */
function parseLocalDate(dateStr: string): Date {
	return new Date(dateStr + 'T00:00');
}

/**
 * Format date for X-axis labels (short format)
 */
function formatDateLabel(dateStr: string): string {
	return parseLocalDate(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Format date for tooltip (full format)
 */
function formatFullDate(dateStr: string): string {
	return parseLocalDate(dateStr).toLocaleDateString('en-US', {
		weekday: 'short',
		month: 'short',
		day: 'numeric',
		year: 'numeric',
	});
}

export default AutoRunStats;
