/**
 * AutoRunStats
 *
 * Auto Run figures for the Usage Dashboard: run counts, checkboxes ticked of
 * checkboxes attempted, and run times, then a per-day bar chart of tasks
 * completed over the whole range.
 *
 * What counts where is spelled out in `src/shared/autoRunMetrics.ts`: goal runs are
 * counted on their own (they have no checkboxes), and runs that never recorded
 * an end stay out of averages and the success rate.
 */

import { memo, useMemo } from 'react';
import { Play, CheckSquare, ListChecks, Target, Clock, Timer, Hourglass } from 'lucide-react';
import type { Theme } from '../../types';
import type { StatsTimeRange, AutoRunSession } from '../../../shared/stats-types';
import { formatCalendarDay, formatDurationHuman, formatNumber } from '../../../shared/formatters';
import { ChartTooltip, StatCardGrid } from '../widgets';
import type { StatCardDatum } from '../widgets';
import {
	computeAutoRunMetrics,
	getAutoRunChartMax,
	groupSessionsByDate,
	type AutoRunDayData,
} from '../../../shared/autoRunMetrics';
import { DashboardPanelState } from './DashboardPanelState';
import { buildAutoRunSummary } from './footerSummary';
import { usePublishFooterSummary } from './useFooterSummary';
import { useBarChartFocus } from './useBarChartFocus';
import { useAutoRunSessions } from './useAutoRunSessions';

interface AutoRunStatsProps {
	/** Current time range for filtering */
	timeRange: StatsTimeRange;
	/** Current theme for styling */
	theme: Theme;
}

const NO_SESSIONS: AutoRunSession[] = [];

function successPercent(day: AutoRunDayData): number {
	return day.count > 0 ? Math.min(100, Math.round((day.successCount / day.count) * 100)) : 0;
}

function describeDay(day: AutoRunDayData): string {
	return `${formatCalendarDay(day.date)}: ${formatNumber(day.successCount)} of ${formatNumber(day.count)} tasks done`;
}

export const AutoRunStats = memo(function AutoRunStats({ timeRange, theme }: AutoRunStatsProps) {
	const { data, loading, error, refresh } = useAutoRunSessions(timeRange);
	const sessions = data ?? NO_SESSIONS;

	const metrics = useMemo(() => computeAutoRunMetrics(sessions), [sessions]);
	const tasksByDate = useMemo(
		() => groupSessionsByDate(sessions, timeRange),
		[sessions, timeRange]
	);
	const maxCount = useMemo(() => getAutoRunChartMax(tasksByDate), [tasksByDate]);
	const { activeIndex, anchor, containerProps, barProps } = useBarChartFocus(tasksByDate.length);
	const active = activeIndex !== null ? tasksByDate[activeIndex] : null;

	usePublishFooterSummary(
		'autorun',
		loading
			? null
			: buildAutoRunSummary({
					runs: metrics.totalRuns,
					tasksCompleted: metrics.totalTasksCompleted,
					tasksAttempted: metrics.totalTasksAttempted,
				})
	);

	const runCaption = [
		metrics.goalRuns > 0 ? `${formatNumber(metrics.goalRuns)} goal` : null,
		metrics.unfinishedRuns > 0 ? `${formatNumber(metrics.unfinishedRuns)} unfinished` : null,
	]
		.filter(Boolean)
		.join(' · ');

	const cards: StatCardDatum[] = [
		{
			label: 'Runs',
			icon: Play,
			value: metrics.totalRuns,
			caption: runCaption || undefined,
		},
		{
			label: 'Tasks Done',
			icon: CheckSquare,
			value: metrics.totalTasksCompleted,
			caption: `of ${formatNumber(metrics.totalTasksAttempted)} attempted`,
		},
		{
			label: 'Avg Tasks/Run',
			icon: ListChecks,
			value: Number(metrics.avgTasksPerRun),
			displayValue: metrics.avgTasksPerRun,
			caption: 'finished document runs',
		},
		{
			label: 'Success Rate',
			icon: Target,
			value: metrics.successRate,
			displayValue: `${metrics.successRate}%`,
			caption: 'tasks done of attempted',
		},
		{
			label: 'Avg Run',
			icon: Clock,
			value: metrics.avgRunDuration,
			displayValue: formatDurationHuman(metrics.avgRunDuration),
			caption: `${formatNumber(metrics.finishedRuns)} finished runs`,
		},
		{
			label: 'Avg Time per Task',
			icon: Timer,
			value: metrics.avgTimePerTask,
			displayValue: formatDurationHuman(metrics.avgTimePerTask),
			caption: 'run time per ticked checkbox',
		},
		{
			label: 'Total Auto Run Time',
			icon: Hourglass,
			value: metrics.totalDuration,
			displayValue: formatDurationHuman(metrics.totalDuration),
			caption: `${formatDurationHuman(metrics.goalDrivenDuration)} goal / ${formatDurationHuman(metrics.specDrivenDuration)} spec`,
		},
	];

	return (
		<div data-testid="autorun-stats" role="region" aria-label="Auto Run statistics">
			<DashboardPanelState
				theme={theme}
				loading={loading}
				error={error}
				empty={sessions.length === 0}
				emptyMessage="No Auto Runs in this time range. Run a playbook to see your stats."
				onRetry={() => void refresh()}
				minHeight={192}
				testId="autorun-stats"
			>
				<div className="space-y-4">
					<div data-testid="autorun-metrics" role="region" aria-label="Auto Run summary metrics">
						<StatCardGrid theme={theme} cards={cards} />
					</div>

					<div
						className="p-4 rounded-lg"
						style={{ backgroundColor: theme.colors.bgMain }}
						data-testid="autorun-tasks-chart"
					>
						<h3 className="text-sm font-medium mb-4" style={{ color: theme.colors.textMain }}>
							Tasks Completed Over Time
						</h3>

						{maxCount > 0 ? (
							<>
								<div
									{...containerProps}
									className="flex items-end gap-px h-32 outline-none rounded focus-visible:ring-2"
									role="group"
									aria-label={`Tasks completed per day, ${tasksByDate.length} days`}
									data-testid="autorun-tasks-bars"
								>
									{tasksByDate.map((day, i) => {
										// Bar height tracks tasks completed, the chart's titular
										// metric; the faint backing bar is tasks attempted.
										const height = (day.successCount / maxCount) * 100;
										const isActive = activeIndex === i;
										return (
											<div
												key={day.date}
												{...barProps(i)}
												className="relative flex-1 h-full flex flex-col justify-end cursor-default"
												style={{ minWidth: 1 }}
												data-testid={`task-bar-${day.date}`}
											>
												<div
													className="w-full rounded-t transition-all duration-200"
													style={{
														height: `${day.successCount > 0 ? Math.max(height, 2) : 0}%`,
														backgroundColor: theme.colors.accent,
														opacity: isActive ? 1 : 0.75,
													}}
												/>
											</div>
										);
									})}
								</div>
								<div
									className="flex justify-between mt-2 text-xs"
									style={{ color: theme.colors.textDim }}
									aria-hidden="true"
								>
									<span>{formatCalendarDay(tasksByDate[0].date)}</span>
									{tasksByDate.length > 2 && (
										<span>
											{formatCalendarDay(tasksByDate[Math.floor(tasksByDate.length / 2)].date)}
										</span>
									)}
									{tasksByDate.length > 1 && (
										<span>{formatCalendarDay(tasksByDate[tasksByDate.length - 1].date)}</span>
									)}
								</div>
							</>
						) : (
							<div
								className="h-32 flex items-center justify-center text-sm"
								style={{ color: theme.colors.textDim }}
							>
								No finished document runs in this time range
							</div>
						)}

						<span className="sr-only" aria-live="polite">
							{active ? describeDay(active) : ''}
						</span>
						{active && (
							<ChartTooltip anchor={anchor} theme={theme} testId="task-bar-tooltip">
								<div className="font-medium mb-1">{formatCalendarDay(active.date)}</div>
								<div style={{ color: theme.colors.textDim }}>
									<div>{formatNumber(active.successCount)} tasks done</div>
									<div>
										of {formatNumber(active.count)} attempted ({successPercent(active)}%)
									</div>
								</div>
							</ChartTooltip>
						)}
					</div>
				</div>
			</DashboardPanelState>
		</div>
	);
});
