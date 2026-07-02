/**
 * TasksByHourChart
 *
 * Shows when Auto Run tasks are typically triggered throughout the day.
 * Uses task startTime data to build an hourly distribution.
 *
 * Features:
 * - 24-hour bar chart showing task distribution
 * - Highlights peak hours
 * - Shows success rate per hour
 * - Theme-aware styling
 */

import { memo, useState, useEffect, useMemo, useCallback } from 'react';
import type { Theme } from '../../types';
import type { StatsTimeRange, AutoRunTask } from '../../../shared/stats-types';
import { captureException } from '../../utils/sentry';
import {
	buildHourlyTaskData,
	formatHourFull,
	formatHourShort,
	getMaxHourlyTaskCount,
	getPeakHours,
} from './tasksByHourUtils';

interface TasksByHourChartProps {
	/** Current time range for filtering */
	timeRange: StatsTimeRange;
	/** Current theme for styling */
	theme: Theme;
}

export const TasksByHourChart = memo(function TasksByHourChart({
	timeRange,
	theme,
}: TasksByHourChartProps) {
	const [tasks, setTasks] = useState<AutoRunTask[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [hoveredHour, setHoveredHour] = useState<number | null>(null);

	// Fetch Auto Run tasks
	const fetchTasks = useCallback(async () => {
		setLoading(true);
		setError(null);

		try {
			// Get all Auto Run sessions for the time range
			const sessions = await window.maestro.stats.getAutoRunSessions(timeRange);

			// Fetch tasks for all sessions
			const taskPromises = sessions.map((session) =>
				window.maestro.stats.getAutoRunTasks(session.id)
			);
			const taskResults = await Promise.all(taskPromises);
			setTasks(taskResults.flat());
		} catch (err) {
			captureException(err);
			setError(err instanceof Error ? err.message : 'Failed to load tasks');
		} finally {
			setLoading(false);
		}
	}, [timeRange]);

	useEffect(() => {
		fetchTasks();

		// Subscribe to stats updates
		const unsubscribe = window.maestro.stats.onStatsUpdate(() => {
			fetchTasks();
		});

		return () => unsubscribe();
	}, [fetchTasks]);

	// Group tasks by hour
	const hourlyData = useMemo(() => {
		return buildHourlyTaskData(tasks);
	}, [tasks]);

	// Find max count for scaling
	const maxCount = useMemo(() => {
		return getMaxHourlyTaskCount(hourlyData);
	}, [hourlyData]);

	// Find peak hours (top 3)
	const peakHours = useMemo(() => {
		return getPeakHours(hourlyData);
	}, [hourlyData]);

	// Total tasks
	const totalTasks = useMemo(() => tasks.length, [tasks]);

	if (loading) {
		return (
			<div className="p-4 rounded-lg" style={{ backgroundColor: theme.colors.bgMain }}>
				<h3
					className="text-sm font-medium mb-4"
					style={{ color: theme.colors.textMain, animation: 'card-enter 0.4s ease both' }}
				>
					Tasks by Time of Day
				</h3>
				<div
					className="h-32 flex items-center justify-center"
					style={{ color: theme.colors.textDim }}
				>
					<span className="text-sm">Loading...</span>
				</div>
			</div>
		);
	}

	if (error) {
		return (
			<div className="p-4 rounded-lg" style={{ backgroundColor: theme.colors.bgMain }}>
				<h3
					className="text-sm font-medium mb-4"
					style={{ color: theme.colors.textMain, animation: 'card-enter 0.4s ease both' }}
				>
					Tasks by Time of Day
				</h3>
				<div
					className="h-32 flex flex-col items-center justify-center gap-2"
					style={{ color: theme.colors.textDim }}
				>
					<span className="text-sm">Failed to load data</span>
					<button
						onClick={fetchTasks}
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

	if (totalTasks === 0) {
		return (
			<div className="p-4 rounded-lg" style={{ backgroundColor: theme.colors.bgMain }}>
				<h3
					className="text-sm font-medium mb-4"
					style={{ color: theme.colors.textMain, animation: 'card-enter 0.4s ease both' }}
				>
					Tasks by Time of Day
				</h3>
				<div
					className="h-32 flex items-center justify-center"
					style={{ color: theme.colors.textDim }}
				>
					<span className="text-sm">No Auto Run tasks in this time range</span>
				</div>
			</div>
		);
	}

	const hoveredData = hoveredHour !== null ? hourlyData[hoveredHour] : null;

	return (
		<div
			className="p-4 rounded-lg"
			style={{ backgroundColor: theme.colors.bgMain }}
			data-testid="tasks-by-hour-chart"
		>
			<h3 className="text-sm font-medium mb-4" style={{ color: theme.colors.textMain }}>
				Tasks by Time of Day
			</h3>

			{/* Chart */}
			<div className="relative">
				{/* Tooltip */}
				{hoveredData && (
					<div
						className="absolute z-10 px-3 py-2 rounded text-xs whitespace-nowrap pointer-events-none shadow-lg"
						style={{
							left: `${(hoveredHour! / 24) * 100}%`,
							bottom: '100%',
							transform: 'translateX(-50%)',
							marginBottom: '8px',
							backgroundColor: theme.colors.bgActivity,
							color: theme.colors.textMain,
							border: `1px solid ${theme.colors.border}`,
						}}
					>
						<div className="font-medium mb-1">{formatHourFull(hoveredHour!)}</div>
						<div style={{ color: theme.colors.textDim }}>
							<div>{hoveredData.count} tasks</div>
							{hoveredData.count > 0 && (
								<div>
									{Math.round((hoveredData.successCount / hoveredData.count) * 100)}% success
								</div>
							)}
						</div>
					</div>
				)}

				{/* Bars */}
				<div className="flex items-end gap-0.5 h-24" role="img" aria-label="Tasks by hour of day">
					{hourlyData.map((hourData) => {
						const height = maxCount > 0 ? (hourData.count / maxCount) * 100 : 0;
						const isPeak = peakHours.includes(hourData.hour);
						const isHovered = hoveredHour === hourData.hour;

						return (
							<div
								key={hourData.hour}
								className="flex-1 rounded-t cursor-pointer transition-all duration-150"
								style={{
									height: `${Math.max(height, 2)}%`,
									backgroundColor: isPeak ? theme.colors.accent : theme.colors.border,
									opacity: isHovered ? 1 : isPeak ? 0.9 : 0.5,
								}}
								onMouseEnter={() => setHoveredHour(hourData.hour)}
								onMouseLeave={() => setHoveredHour(null)}
								title={`${formatHourFull(hourData.hour)}: ${hourData.count} tasks`}
							/>
						);
					})}
				</div>

				{/* X-axis labels */}
				<div
					className="flex justify-between mt-2 text-[10px]"
					style={{ color: theme.colors.textDim }}
				>
					<span>{formatHourShort(0)}</span>
					<span>{formatHourShort(6)}</span>
					<span>{formatHourShort(12)}</span>
					<span>{formatHourShort(18)}</span>
					<span>{formatHourShort(23)}</span>
				</div>
			</div>

			{/* Peak hours summary */}
			{peakHours.length > 0 && hourlyData[peakHours[0]].count > 0 && (
				<div
					className="mt-4 pt-3 border-t text-xs"
					style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
				>
					Peak hours:{' '}
					{peakHours
						.filter((h) => hourlyData[h].count > 0)
						.map((h) => (
							<span
								key={h}
								className="inline-block px-1.5 py-0.5 rounded mx-0.5"
								style={{
									backgroundColor: `${theme.colors.accent}20`,
									color: theme.colors.accent,
								}}
							>
								{formatHourFull(h)}
							</span>
						))}
				</div>
			)}
		</div>
	);
});

export default TasksByHourChart;
