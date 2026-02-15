/**
 * WeekdayComparisonChart
 *
 * Compares AI usage patterns between weekdays and weekends.
 * Uses data from byDay to calculate aggregated metrics.
 *
 * Features:
 * - Visual comparison of weekday vs weekend usage
 * - Shows query counts and average duration for each
 * - Calculates productivity ratio
 * - Colorblind-friendly palette option
 */

import { useMemo } from 'react';
import { Briefcase, Coffee } from 'lucide-react';
import type { Theme } from '../../types';
import type { StatsAggregation } from '../../hooks/stats/useStats';

interface WeekdayComparisonChartProps {
	/** Aggregated stats data from the API */
	data: StatsAggregation;
	/** Current theme for styling */
	theme: Theme;
	/** Enable colorblind-friendly colors */
	colorBlindMode?: boolean;
}

/**
 * Format duration in milliseconds to human-readable string
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

export function WeekdayComparisonChart({
	data,
	theme,
	colorBlindMode = false,
}: WeekdayComparisonChartProps) {
	// Calculate weekday vs weekend statistics
	const comparisonData = useMemo(() => {
		const weekdayStats = { count: 0, duration: 0, days: 0 };
		const weekendStats = { count: 0, duration: 0, days: 0 };

		data.byDay.forEach((day) => {
			const date = new Date(day.date);
			const dayOfWeek = date.getDay();
			const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

			if (isWeekend) {
				weekendStats.count += day.count;
				weekendStats.duration += day.duration;
				weekendStats.days++;
			} else {
				weekdayStats.count += day.count;
				weekdayStats.duration += day.duration;
				weekdayStats.days++;
			}
		});

		// Calculate averages
		const weekdayAvgQueriesPerDay =
			weekdayStats.days > 0 ? weekdayStats.count / weekdayStats.days : 0;
		const weekendAvgQueriesPerDay =
			weekendStats.days > 0 ? weekendStats.count / weekendStats.days : 0;

		const weekdayAvgDuration =
			weekdayStats.count > 0 ? weekdayStats.duration / weekdayStats.count : 0;
		const weekendAvgDuration =
			weekendStats.count > 0 ? weekendStats.duration / weekendStats.count : 0;

		// Calculate which is more productive
		const totalQueries = weekdayStats.count + weekendStats.count;
		const weekdayPercentage = totalQueries > 0 ? (weekdayStats.count / totalQueries) * 100 : 0;
		const weekendPercentage = totalQueries > 0 ? (weekendStats.count / totalQueries) * 100 : 0;

		return {
			weekday: {
				totalQueries: weekdayStats.count,
				totalDuration: weekdayStats.duration,
				avgQueriesPerDay: weekdayAvgQueriesPerDay,
				avgDuration: weekdayAvgDuration,
				days: weekdayStats.days,
				percentage: weekdayPercentage,
			},
			weekend: {
				totalQueries: weekendStats.count,
				totalDuration: weekendStats.duration,
				avgQueriesPerDay: weekendAvgQueriesPerDay,
				avgDuration: weekendAvgDuration,
				days: weekendStats.days,
				percentage: weekendPercentage,
			},
			totalQueries,
		};
	}, [data.byDay]);

	const hasData = comparisonData.totalQueries > 0;

	// Colors for weekday/weekend
	const weekdayColor = colorBlindMode ? '#0077BB' : theme.colors.accent;
	const weekendColor = colorBlindMode ? '#EE7733' : '#8b5cf6';

	if (!hasData) {
		return (
			<div className="p-4 rounded-lg" style={{ backgroundColor: theme.colors.bgMain }}>
				<h3 className="text-sm font-medium mb-4" style={{ color: theme.colors.textMain }}>
					Weekday vs Weekend
				</h3>
				<div
					className="flex items-center justify-center h-24"
					style={{ color: theme.colors.textDim }}
				>
					<span className="text-sm">No daily data available</span>
				</div>
			</div>
		);
	}

	const maxPercentage = Math.max(
		comparisonData.weekday.percentage,
		comparisonData.weekend.percentage
	);

	return (
		<div
			className="p-4 rounded-lg"
			style={{ backgroundColor: theme.colors.bgMain }}
			data-testid="weekday-comparison-chart"
		>
			<h3 className="text-sm font-medium mb-4" style={{ color: theme.colors.textMain }}>
				Weekday vs Weekend
			</h3>

			<div className="grid grid-cols-2 gap-6">
				{/* Weekday Card */}
				<div className="p-4 rounded-lg" style={{ backgroundColor: theme.colors.bgActivity }}>
					<div className="flex items-center gap-2 mb-3">
						<div className="p-2 rounded-md" style={{ backgroundColor: `${weekdayColor}20` }}>
							<Briefcase className="w-4 h-4" style={{ color: weekdayColor }} />
						</div>
						<div>
							<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
								Weekdays
							</div>
							<div className="text-xs" style={{ color: theme.colors.textDim }}>
								Mon - Fri
							</div>
						</div>
					</div>

					{/* Bar */}
					<div
						className="h-3 rounded-full mb-3 overflow-hidden"
						style={{ backgroundColor: `${theme.colors.border}30` }}
					>
						<div
							className="h-full rounded-full transition-all duration-500"
							style={{
								width: `${(comparisonData.weekday.percentage / maxPercentage) * 100}%`,
								backgroundColor: weekdayColor,
							}}
						/>
					</div>

					<div className="space-y-1.5">
						<div className="flex justify-between text-xs">
							<span style={{ color: theme.colors.textDim }}>Total Queries</span>
							<span className="font-medium" style={{ color: theme.colors.textMain }}>
								{comparisonData.weekday.totalQueries.toLocaleString()}
							</span>
						</div>
						<div className="flex justify-between text-xs">
							<span style={{ color: theme.colors.textDim }}>Avg/Day</span>
							<span className="font-medium" style={{ color: theme.colors.textMain }}>
								{comparisonData.weekday.avgQueriesPerDay.toFixed(1)}
							</span>
						</div>
						<div className="flex justify-between text-xs">
							<span style={{ color: theme.colors.textDim }}>Avg Duration</span>
							<span className="font-medium" style={{ color: theme.colors.textMain }}>
								{formatDuration(comparisonData.weekday.avgDuration)}
							</span>
						</div>
						<div className="flex justify-between text-xs">
							<span style={{ color: theme.colors.textDim }}>Share</span>
							<span className="font-medium" style={{ color: weekdayColor }}>
								{comparisonData.weekday.percentage.toFixed(1)}%
							</span>
						</div>
					</div>
				</div>

				{/* Weekend Card */}
				<div className="p-4 rounded-lg" style={{ backgroundColor: theme.colors.bgActivity }}>
					<div className="flex items-center gap-2 mb-3">
						<div className="p-2 rounded-md" style={{ backgroundColor: `${weekendColor}20` }}>
							<Coffee className="w-4 h-4" style={{ color: weekendColor }} />
						</div>
						<div>
							<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
								Weekends
							</div>
							<div className="text-xs" style={{ color: theme.colors.textDim }}>
								Sat - Sun
							</div>
						</div>
					</div>

					{/* Bar */}
					<div
						className="h-3 rounded-full mb-3 overflow-hidden"
						style={{ backgroundColor: `${theme.colors.border}30` }}
					>
						<div
							className="h-full rounded-full transition-all duration-500"
							style={{
								width: `${(comparisonData.weekend.percentage / maxPercentage) * 100}%`,
								backgroundColor: weekendColor,
							}}
						/>
					</div>

					<div className="space-y-1.5">
						<div className="flex justify-between text-xs">
							<span style={{ color: theme.colors.textDim }}>Total Queries</span>
							<span className="font-medium" style={{ color: theme.colors.textMain }}>
								{comparisonData.weekend.totalQueries.toLocaleString()}
							</span>
						</div>
						<div className="flex justify-between text-xs">
							<span style={{ color: theme.colors.textDim }}>Avg/Day</span>
							<span className="font-medium" style={{ color: theme.colors.textMain }}>
								{comparisonData.weekend.avgQueriesPerDay.toFixed(1)}
							</span>
						</div>
						<div className="flex justify-between text-xs">
							<span style={{ color: theme.colors.textDim }}>Avg Duration</span>
							<span className="font-medium" style={{ color: theme.colors.textMain }}>
								{formatDuration(comparisonData.weekend.avgDuration)}
							</span>
						</div>
						<div className="flex justify-between text-xs">
							<span style={{ color: theme.colors.textDim }}>Share</span>
							<span className="font-medium" style={{ color: weekendColor }}>
								{comparisonData.weekend.percentage.toFixed(1)}%
							</span>
						</div>
					</div>
				</div>
			</div>

			{/* Insight */}
			{comparisonData.weekday.days > 0 && comparisonData.weekend.days > 0 && (
				<div
					className="mt-4 pt-3 border-t text-xs"
					style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
				>
					{comparisonData.weekday.avgQueriesPerDay > comparisonData.weekend.avgQueriesPerDay ? (
						<span>
							You're{' '}
							<strong style={{ color: theme.colors.textMain }}>
								{(
									(comparisonData.weekday.avgQueriesPerDay /
										comparisonData.weekend.avgQueriesPerDay) *
										100 -
									100
								).toFixed(0)}
								%
							</strong>{' '}
							more active on weekdays
						</span>
					) : comparisonData.weekend.avgQueriesPerDay > 0 ? (
						<span>
							You're{' '}
							<strong style={{ color: theme.colors.textMain }}>
								{(
									(comparisonData.weekend.avgQueriesPerDay /
										comparisonData.weekday.avgQueriesPerDay) *
										100 -
									100
								).toFixed(0)}
								%
							</strong>{' '}
							more active on weekends
						</span>
					) : (
						<span>Similar activity on weekdays and weekends</span>
					)}
				</div>
			)}
		</div>
	);
}

export default WeekdayComparisonChart;
