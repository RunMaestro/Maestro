/**
 * TasksByHourChart
 *
 * When Auto Run's agent turns start through the day: one bar per local hour,
 * the three busiest highlighted. A TURN is one agent invocation on a document,
 * whether or not it ticked a checkbox (the tiles above count checkboxes), so
 * stalled turns show up here too.
 *
 * Data: `stats.getAutoRunTurnsByHour(range)`, one grouped query in main.
 */

import { memo, useMemo } from 'react';
import type { Theme } from '../../types';
import type { AutoRunTurnsByHour, StatsTimeRange } from '../../../shared/stats-types';
import { formatHourOfDay, formatNumber } from '../../../shared/formatters';
import { ChartTooltip } from '../widgets';
import { getMaxHourlyTaskCount, getPeakHours } from './tasksByHourUtils';
import { DashboardPanelState } from './DashboardPanelState';
import { useBarChartFocus } from './useBarChartFocus';
import { useDashboardResource } from './useDashboardResource';

interface TasksByHourChartProps {
	/** Current time range for filtering */
	timeRange: StatsTimeRange;
	/** Current theme for styling */
	theme: Theme;
}

const NO_HOURS: AutoRunTurnsByHour[] = [];
const AXIS_HOURS = [0, 6, 12, 18, 23];

function describeHour(hour: AutoRunTurnsByHour): string {
	const turns = `${formatNumber(hour.count)} turn${hour.count === 1 ? '' : 's'}`;
	if (hour.count === 0) return `${formatHourOfDay(hour.hour)}: no turns`;
	return `${formatHourOfDay(hour.hour)}: ${turns}, ${Math.round((hour.successCount / hour.count) * 100)}% succeeded`;
}

export const TasksByHourChart = memo(function TasksByHourChart({
	timeRange,
	theme,
}: TasksByHourChartProps) {
	const { data, loading, error, refresh } = useDashboardResource(
		`autorun-turns-by-hour:${timeRange}`,
		() => window.maestro.stats.getAutoRunTurnsByHour(timeRange),
		'fetchTasksByHour',
		{ tables: ['auto_run'] }
	);
	const hourlyData = data ?? NO_HOURS;
	const maxCount = useMemo(() => getMaxHourlyTaskCount(hourlyData), [hourlyData]);
	const peakHours = useMemo(() => getPeakHours(hourlyData), [hourlyData]);
	const totalTurns = useMemo(() => hourlyData.reduce((sum, h) => sum + h.count, 0), [hourlyData]);
	const { activeIndex, anchor, containerProps, barProps } = useBarChartFocus(hourlyData.length);
	const active = activeIndex !== null ? hourlyData[activeIndex] : null;

	return (
		<div
			className="p-4 rounded-lg"
			style={{ backgroundColor: theme.colors.bgMain }}
			data-testid="tasks-by-hour-chart"
		>
			<h3 className="text-sm font-medium mb-1" style={{ color: theme.colors.textMain }}>
				Agent Turns by Time of Day
			</h3>
			<p className="text-xs mb-4" style={{ color: theme.colors.textDim }}>
				Every agent invocation an Auto Run made, including ones that ticked no checkbox.
			</p>

			<DashboardPanelState
				theme={theme}
				loading={loading}
				error={error}
				empty={totalTurns === 0}
				emptyMessage="No Auto Run agent turns in this time range"
				onRetry={() => void refresh()}
				testId="tasks-by-hour"
			>
				<div
					{...containerProps}
					className="flex items-end gap-0.5 h-24 outline-none rounded focus-visible:ring-2"
					role="group"
					aria-label={`Auto Run agent turns by hour of day, ${formatNumber(totalTurns)} in total`}
					data-testid="tasks-by-hour-bars"
				>
					{hourlyData.map((hourData, i) => {
						const height = maxCount > 0 ? (hourData.count / maxCount) * 100 : 0;
						const isPeak = peakHours.includes(hourData.hour);
						const isActive = activeIndex === i;
						return (
							<div
								key={hourData.hour}
								{...barProps(i)}
								className="flex-1 rounded-t cursor-default transition-all duration-150"
								style={{
									height: `${Math.max(height, 2)}%`,
									backgroundColor: isPeak ? theme.colors.accent : theme.colors.border,
									opacity: isActive ? 1 : isPeak ? 0.9 : 0.5,
								}}
								data-testid={`tasks-by-hour-bar-${hourData.hour}`}
							/>
						);
					})}
				</div>

				<div className="flex justify-between mt-2 text-2xs" style={{ color: theme.colors.textDim }}>
					{AXIS_HOURS.map((hour) => (
						<span key={hour}>{formatHourOfDay(hour)}</span>
					))}
				</div>

				{peakHours.length > 0 && (
					<div
						className="mt-4 pt-3 border-t text-xs"
						style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
					>
						Peak hours:{' '}
						{peakHours.map((h) => (
							<span
								key={h}
								className="inline-block px-1.5 py-0.5 rounded mx-0.5"
								style={{
									backgroundColor: `${theme.colors.accent}20`,
									color: theme.colors.accent,
								}}
							>
								{formatHourOfDay(h)}
							</span>
						))}
					</div>
				)}

				<span className="sr-only" aria-live="polite">
					{active ? describeHour(active) : ''}
				</span>
				{active && (
					<ChartTooltip anchor={anchor} theme={theme} testId="tasks-by-hour-tooltip">
						<div className="font-medium mb-1">{formatHourOfDay(active.hour)}</div>
						<div style={{ color: theme.colors.textDim }}>
							<div>
								{formatNumber(active.count)} turn{active.count === 1 ? '' : 's'}
							</div>
							{active.count > 0 && (
								<div>{Math.round((active.successCount / active.count) * 100)}% succeeded</div>
							)}
						</div>
					</ChartTooltip>
				)}
			</DashboardPanelState>
		</div>
	);
});
