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
import type { StatsTimeRange } from '../../hooks/stats/useStats';
import { captureException } from '../../utils/sentry';
import {
	DEFAULT_AUTORUN_ANALYTICS_FILTERS,
	formatAgentStrategyLong,
	formatPromptProfileLong,
	formatSchedulerMode,
	formatWorktreeModeLong,
	hasActiveAutoRunFilters,
	type AutoRunAnalyticsFilters,
} from './autoRunFilters';

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
	playbookName?: string;
	promptProfile?: 'full' | 'compact-code' | 'compact-doc';
	agentStrategy?: 'single' | 'plan-execute-verify';
	worktreeMode?: 'disabled' | 'managed' | 'existing-open' | 'existing-closed' | 'create-new';
	schedulerMode?: 'sequential' | 'dag';
	maxParallelism?: number;
}

interface AutoRunTask {
	id: string;
	autoRunSessionId: string;
	verifierVerdict?: 'PASS' | 'WARN' | 'FAIL';
	schedulerOutcome?: 'completed' | 'failed' | 'timed_out';
}

interface AutoRunStatsProps {
	/** Current time range for filtering */
	timeRange: StatsTimeRange;
	/** Current theme for styling */
	theme: Theme;
	/** Number of columns for responsive layout (default: 6) */
	columns?: number;
	/** Shared Auto Run filters for linked dashboard views */
	filters?: AutoRunAnalyticsFilters;
	/** Callback for linked Execution Mix filter interactions */
	onFiltersChange?: (filters: AutoRunAnalyticsFilters) => void;
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
 * Group sessions by local date and sum tasksCompleted for the bar chart.
 * Uses session-level tasksCompleted (actual checkboxes) rather than task records
 * (agent invocations), which can batch multiple checkboxes per invocation.
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
		.filter((entry) => entry.count > 0)
		.sort((a, b) => a.date.localeCompare(b.date));
}

function buildCounts(
	values: Array<string | undefined>,
	formatLabel?: (value: string) => string
): Array<{ value: string; label: string; count: number }> {
	const counts = new Map<string, number>();

	for (const value of values) {
		if (!value) continue;
		counts.set(value, (counts.get(value) ?? 0) + 1);
	}

	return [...counts.entries()]
		.map(([value, count]) => ({
			value,
			label: formatLabel ? formatLabel(value) : value,
			count,
		}))
		.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

export const AutoRunStats = memo(function AutoRunStats({
	timeRange,
	theme,
	columns = 6,
	filters = DEFAULT_AUTORUN_ANALYTICS_FILTERS,
	onFiltersChange,
}: AutoRunStatsProps) {
	const [sessions, setSessions] = useState<AutoRunSession[]>([]);
	const [tasksBySession, setTasksBySession] = useState<Record<string, AutoRunTask[]>>({});
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
			const taskEntries = await Promise.all(
				autoRunSessions.map(
					async (session) =>
						[
							session.id,
							(await window.maestro.stats.getAutoRunTasks(session.id)) as AutoRunTask[],
						] as const
				)
			);
			setTasksBySession(Object.fromEntries(taskEntries));
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

	const analyticsBreakdown = useMemo(() => {
		const allTasks = Object.values(tasksBySession).flat();
		return {
			playbooks: buildCounts(sessions.map((session) => session.playbookName)),
			profiles: buildCounts(
				sessions.map((session) => session.promptProfile),
				(value) => formatPromptProfileLong(value as AutoRunSession['promptProfile'])
			),
			strategies: buildCounts(
				sessions.map((session) => session.agentStrategy),
				(value) => formatAgentStrategyLong(value as AutoRunSession['agentStrategy'])
			),
			worktrees: buildCounts(
				sessions.map((session) => session.worktreeMode),
				(value) => formatWorktreeModeLong(value as AutoRunSession['worktreeMode'])
			),
			schedulers: buildCounts(
				sessions.map((session) => session.schedulerMode),
				(value) => formatSchedulerMode(value as AutoRunSession['schedulerMode'])
			),
			verdicts: buildCounts(allTasks.map((task) => task.verifierVerdict)),
		};
	}, [sessions, tasksBySession]);

	const hasLinkedFilters = Boolean(onFiltersChange);
	const hasActiveFilters = hasActiveAutoRunFilters(filters);

	const handleFilterToggle = useCallback(
		(
			key: keyof AutoRunAnalyticsFilters,
			value: AutoRunAnalyticsFilters[keyof AutoRunAnalyticsFilters]
		) => {
			if (!onFiltersChange || !value) return;
			onFiltersChange({
				...filters,
				[key]: filters[key] === value ? '' : value,
			});
		},
		[filters, onFiltersChange]
	);

	// Max count for bar height calculation
	const maxCount = useMemo(() => {
		if (tasksByDate.length === 0) return 0;
		return Math.max(...tasksByDate.map((d) => d.count));
	}, [tasksByDate]);

	// Handle mouse events for tooltip
	const handleMouseEnter = useCallback(
		(
			data: { date: string; count: number; successCount: number },
			event: React.MouseEvent<HTMLDivElement>
		) => {
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
				<h3 className="text-sm font-medium mb-4" style={{ color: theme.colors.textMain }}>
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
											opacity: isHovered ? 1 : 0.7 + successRatio * 0.3,
										}}
										onMouseEnter={(e) => handleMouseEnter(day, e)}
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

						{/* X-axis labels (show first, middle, last) */}
						<div
							className="flex justify-between mt-2 text-xs"
							style={{ color: theme.colors.textDim }}
						>
							{tasksByDate.length > 0 && (
								<>
									<span>{formatDateLabel(tasksByDate[0].date)}</span>
									{tasksByDate.length > 2 && (
										<span>
											{formatDateLabel(tasksByDate[Math.floor(tasksByDate.length / 2)].date)}
										</span>
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
									<div>
										{hoveredBar.successCount} successful (
										{Math.round((hoveredBar.successCount / hoveredBar.count) * 100)}%)
									</div>
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

			<div
				className="p-4 rounded-lg"
				style={{ backgroundColor: theme.colors.bgMain }}
				data-testid="autorun-analytics-breakdown"
			>
				<div className="flex items-center justify-between gap-3 mb-4">
					<div>
						<h3 className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
							Execution Mix
						</h3>
						{hasLinkedFilters && (
							<div className="text-xs mt-1" style={{ color: theme.colors.textDim }}>
								Click a row to sync filters with the table below.
							</div>
						)}
					</div>
					{hasLinkedFilters && hasActiveFilters && (
						<button
							type="button"
							onClick={() => onFiltersChange?.(DEFAULT_AUTORUN_ANALYTICS_FILTERS)}
							className="px-2.5 py-1 rounded text-xs font-medium border"
							style={{
								color: theme.colors.accent,
								borderColor: `${theme.colors.accent}55`,
								backgroundColor: `${theme.colors.accent}10`,
							}}
						>
							Clear Filters
						</button>
					)}
				</div>
				<div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
					{[
						{
							title: 'Playbooks',
							items: analyticsBreakdown.playbooks,
							filterKey: 'playbookName' as const,
						},
						{
							title: 'Prompt Profiles',
							items: analyticsBreakdown.profiles,
							filterKey: 'promptProfile' as const,
						},
						{
							title: 'Strategies',
							items: analyticsBreakdown.strategies,
							filterKey: 'agentStrategy' as const,
						},
						{
							title: 'Worktree Modes',
							items: analyticsBreakdown.worktrees,
							filterKey: 'worktreeMode' as const,
						},
						{
							title: 'Schedulers',
							items: analyticsBreakdown.schedulers,
							filterKey: 'schedulerMode' as const,
						},
						{
							title: 'Verifier Verdicts',
							items: analyticsBreakdown.verdicts,
						},
					].map((section) => (
						<div
							key={section.title}
							className="rounded-lg border p-3"
							style={{
								borderColor: theme.colors.border,
								backgroundColor: theme.colors.bgActivity,
							}}
						>
							<div
								className="text-xs font-bold uppercase mb-2"
								style={{ color: theme.colors.textDim }}
							>
								{section.title}
							</div>
							<div className="space-y-2">
								{section.items.length > 0 ? (
									section.items.slice(0, 4).map((item) => {
										const isInteractive = Boolean(section.filterKey && hasLinkedFilters);
										const isActive = Boolean(
											section.filterKey && filters[section.filterKey] === item.value
										);

										if (!isInteractive) {
											return (
												<div key={item.value} className="flex items-center justify-between gap-3">
													<span
														className="text-sm truncate"
														style={{ color: theme.colors.textMain }}
													>
														{item.label}
													</span>
													<span
														className="text-xs font-mono px-2 py-0.5 rounded-full"
														style={{
															color: theme.colors.accent,
															backgroundColor: `${theme.colors.accent}15`,
														}}
													>
														{item.count}
													</span>
												</div>
											);
										}

										return (
											<button
												key={item.value}
												type="button"
												onClick={() => handleFilterToggle(section.filterKey!, item.value)}
												className="w-full flex items-center justify-between gap-3 rounded px-2 py-1 text-left transition-colors"
												style={{
													color: theme.colors.textMain,
													backgroundColor: isActive ? `${theme.colors.accent}15` : 'transparent',
													outline: isActive ? `1px solid ${theme.colors.accent}55` : 'none',
												}}
												aria-pressed={isActive}
											>
												<span className="text-sm truncate">{item.label}</span>
												<span
													className="text-xs font-mono px-2 py-0.5 rounded-full"
													style={{
														color: isActive ? theme.colors.bgMain : theme.colors.accent,
														backgroundColor: isActive
															? theme.colors.accent
															: `${theme.colors.accent}15`,
													}}
												>
													{item.count}
												</span>
											</button>
										);
									})
								) : (
									<div className="text-sm" style={{ color: theme.colors.textDim }}>
										No data
									</div>
								)}
							</div>
						</div>
					))}
				</div>
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
