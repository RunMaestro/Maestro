/**
 * PeakHoursChart
 *
 * Bar chart showing activity distribution across hours of the day.
 * Helps users understand their work patterns and peak productivity times.
 *
 * Features:
 * - 24-hour bar chart (0-23)
 * - Toggle between count and duration views
 * - Highlights the peak hour
 * - Theme-aware colors
 * - Hover tooltips
 */

import React, { useState, useMemo } from 'react';
import type { Theme } from '../../types';
import type { StatsAggregation } from '../../hooks/useStats';

type MetricMode = 'count' | 'duration';

interface PeakHoursChartProps {
	/** Aggregated stats data from the API */
	data: StatsAggregation;
	/** Current theme for styling */
	theme: Theme;
	/** Enable colorblind-friendly colors */
	colorBlindMode?: boolean;
}

/**
 * Format hour to 12-hour format with AM/PM
 */
function formatHour(hour: number): string {
	if (hour === 0) return '12am';
	if (hour === 12) return '12pm';
	if (hour < 12) return `${hour}am`;
	return `${hour - 12}pm`;
}

/**
 * Format duration in milliseconds to human-readable string
 */
function formatDuration(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);

	if (hours > 0) {
		return `${hours}h ${minutes}m`;
	}
	if (minutes > 0) {
		return `${minutes}m`;
	}
	return `${totalSeconds}s`;
}

export function PeakHoursChart({
	data,
	theme,
	colorBlindMode: _colorBlindMode = false,
}: PeakHoursChartProps) {
	const [metricMode, setMetricMode] = useState<MetricMode>('count');
	const [hoveredHour, setHoveredHour] = useState<number | null>(null);

	// Build complete 24-hour data with zeros for missing hours
	const hourlyData = useMemo(() => {
		const byHourMap = new Map<number, { count: number; duration: number }>();

		// Initialize all hours with zeros
		for (let h = 0; h < 24; h++) {
			byHourMap.set(h, { count: 0, duration: 0 });
		}

		// Fill in actual data
		for (const entry of data.byHour ?? []) {
			byHourMap.set(entry.hour, { count: entry.count, duration: entry.duration });
		}

		return Array.from(byHourMap.entries())
			.sort((a, b) => a[0] - b[0])
			.map(([hour, values]) => ({
				hour,
				...values,
			}));
	}, [data.byHour]);

	// Calculate max value for scaling
	const maxValue = useMemo(() => {
		const values = hourlyData.map((h) => (metricMode === 'count' ? h.count : h.duration));
		return Math.max(...values, 1);
	}, [hourlyData, metricMode]);

	// Find peak hour
	const peakHour = useMemo(() => {
		let peak = { hour: 0, value: 0 };
		for (const h of hourlyData) {
			const value = metricMode === 'count' ? h.count : h.duration;
			if (value > peak.value) {
				peak = { hour: h.hour, value };
			}
		}
		return peak.hour;
	}, [hourlyData, metricMode]);

	// Check if there's any data
	const hasData = hourlyData.some((h) => h.count > 0);

	// Chart dimensions
	const chartHeight = 120;
	const barWidth = 100 / 24; // percentage width per bar

	return (
		<div
			className="p-4 rounded-lg"
			style={{ backgroundColor: theme.colors.bgMain }}
			role="figure"
			aria-label="Peak hours chart showing activity distribution across hours of the day"
		>
			{/* Header */}
			<div className="flex items-center justify-between mb-3">
				<h3 className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
					Peak Hours
				</h3>
				<div className="flex items-center gap-2">
					<span className="text-xs" style={{ color: theme.colors.textDim }}>
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
									metricMode === 'count' ? `${theme.colors.accent}20` : 'transparent',
								color: metricMode === 'count' ? theme.colors.accent : theme.colors.textDim,
							}}
							aria-pressed={metricMode === 'count'}
						>
							Count
						</button>
						<button
							onClick={() => setMetricMode('duration')}
							className="px-2 py-1 text-xs transition-colors"
							style={{
								backgroundColor:
									metricMode === 'duration' ? `${theme.colors.accent}20` : 'transparent',
								color: metricMode === 'duration' ? theme.colors.accent : theme.colors.textDim,
								borderLeft: `1px solid ${theme.colors.border}`,
							}}
							aria-pressed={metricMode === 'duration'}
						>
							Duration
						</button>
					</div>
				</div>
			</div>

			{/* Chart */}
			{!hasData ? (
				<div
					className="flex items-center justify-center"
					style={{ height: chartHeight, color: theme.colors.textDim }}
				>
					<span className="text-sm">No hourly data available</span>
				</div>
			) : (
				<div className="relative">
					{/* Bars */}
					<div className="flex items-end gap-px" style={{ height: chartHeight }}>
						{hourlyData.map((h) => {
							const value = metricMode === 'count' ? h.count : h.duration;
							const height = maxValue > 0 ? (value / maxValue) * 100 : 0;
							const isPeak = h.hour === peakHour && value > 0;
							const isHovered = hoveredHour === h.hour;

							return (
								<div
									key={h.hour}
									className="relative flex-1 flex flex-col justify-end cursor-default"
									style={{ minWidth: 0 }}
									onMouseEnter={() => setHoveredHour(h.hour)}
									onMouseLeave={() => setHoveredHour(null)}
								>
									{/* Bar */}
									<div
										className="w-full rounded-t transition-all duration-200"
										style={{
											height: `${Math.max(height, value > 0 ? 2 : 0)}%`,
											backgroundColor: isPeak
												? theme.colors.accent
												: isHovered
													? `${theme.colors.accent}90`
													: `${theme.colors.accent}50`,
											transform: isHovered ? 'scaleY(1.05)' : 'scaleY(1)',
											transformOrigin: 'bottom',
										}}
									/>

									{/* Tooltip on hover */}
									{isHovered && value > 0 && (
										<div
											className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 rounded text-xs whitespace-nowrap z-10"
											style={{
												backgroundColor: theme.colors.bgActivity,
												color: theme.colors.textMain,
												border: `1px solid ${theme.colors.border}`,
												boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
											}}
										>
											<div className="font-medium">{formatHour(h.hour)}</div>
											<div style={{ color: theme.colors.textDim }}>
												{metricMode === 'count' ? `${h.count} queries` : formatDuration(h.duration)}
											</div>
										</div>
									)}
								</div>
							);
						})}
					</div>

					{/* X-axis labels (show every 4 hours) */}
					<div className="flex mt-1">
						{[0, 4, 8, 12, 16, 20].map((hour) => (
							<div
								key={hour}
								className="text-xs"
								style={{
									width: `${barWidth * 4}%`,
									color: theme.colors.textDim,
								}}
							>
								{formatHour(hour)}
							</div>
						))}
					</div>

					{/* Peak indicator */}
					{hasData && (
						<div
							className="mt-2 text-xs flex items-center gap-1"
							style={{ color: theme.colors.textDim }}
						>
							<span>Peak:</span>
							<span style={{ color: theme.colors.accent, fontWeight: 500 }}>
								{formatHour(peakHour)}
							</span>
						</div>
					)}
				</div>
			)}
		</div>
	);
}

export default PeakHoursChart;
