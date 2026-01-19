/**
 * DurationTrendsChart
 *
 * Line chart showing average response duration over time.
 * Displays duration trends with optional smoothing/moving average.
 *
 * Features:
 * - X-axis: time (grouped by day/week depending on range)
 * - Y-axis: duration in seconds
 * - Smoothing/moving average toggle
 * - Tooltip showing exact values on hover
 * - Theme-aware line color and grid
 */

import React, { useState, useMemo, useCallback } from 'react';
import { format, parseISO } from 'date-fns';
import type { Theme } from '../../types';
import type { StatsTimeRange, StatsAggregation } from '../../hooks/useStats';
import { COLORBLIND_LINE_COLORS } from '../../constants/colorblindPalettes';

// Data point for the chart
interface DataPoint {
	date: string;
	formattedDate: string;
	rawDuration: number; // Raw average duration in ms
	smoothedDuration: number; // Smoothed/moving average duration in ms
	displayDuration: number; // Currently displayed duration (raw or smoothed)
	count: number; // Query count for this period
}

interface DurationTrendsChartProps {
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
 * Calculate moving average for smoothing
 * @param values - Array of values to smooth
 * @param windowSize - Size of the moving average window
 */
function calculateMovingAverage(values: number[], windowSize: number): number[] {
	const result: number[] = [];

	for (let i = 0; i < values.length; i++) {
		const start = Math.max(0, i - Math.floor(windowSize / 2));
		const end = Math.min(values.length, i + Math.floor(windowSize / 2) + 1);
		const window = values.slice(start, end);
		const avg = window.reduce((sum, val) => sum + val, 0) / window.length;
		result.push(avg);
	}

	return result;
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

/**
 * Format duration for Y-axis labels (shorter format)
 */
function formatYAxisDuration(ms: number): string {
	if (ms === 0) return '0s';

	const totalSeconds = Math.floor(ms / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;

	if (minutes >= 60) {
		return `${Math.floor(minutes / 60)}h`;
	}
	if (minutes > 0) {
		return `${minutes}m`;
	}
	return `${seconds}s`;
}

/**
 * Get the moving average window size based on time range
 */
function getWindowSize(timeRange: StatsTimeRange): number {
	switch (timeRange) {
		case 'day':
			return 3; // Small window for day
		case 'week':
			return 3;
		case 'month':
			return 5;
		case 'year':
			return 7;
		case 'all':
			return 7;
		default:
			return 5;
	}
}

/**
 * Format date for X-axis based on time range
 */
function formatXAxisDate(dateStr: string, timeRange: StatsTimeRange): string {
	const date = parseISO(dateStr);

	switch (timeRange) {
		case 'day':
			return format(date, 'HH:mm');
		case 'week':
			return format(date, 'EEE');
		case 'month':
			return format(date, 'MMM d');
		case 'year':
			return format(date, 'MMM');
		case 'all':
			return format(date, 'MMM yyyy');
		default:
			return format(date, 'MMM d');
	}
}

export function DurationTrendsChart({
	data,
	timeRange,
	theme,
	colorBlindMode = false,
}: DurationTrendsChartProps) {
	const [showSmoothed, setShowSmoothed] = useState(false);
	const [hoveredPoint, setHoveredPoint] = useState<DataPoint | null>(null);
	const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);

	// Chart dimensions
	const chartWidth = 600;
	const chartHeight = 200;
	const padding = { top: 20, right: 40, bottom: 40, left: 60 };
	const innerWidth = chartWidth - padding.left - padding.right;
	const innerHeight = chartHeight - padding.top - padding.bottom;

	// Process data for the chart
	const chartData = useMemo((): DataPoint[] => {
		if (data.byDay.length === 0) return [];

		// Calculate average duration per day (duration / count)
		const rawDurations = data.byDay.map((day) => (day.count > 0 ? day.duration / day.count : 0));

		// Calculate smoothed values
		const windowSize = getWindowSize(timeRange);
		const smoothedDurations = calculateMovingAverage(rawDurations, windowSize);

		return data.byDay.map((day, idx) => ({
			date: day.date,
			formattedDate: format(parseISO(day.date), 'EEEE, MMM d, yyyy'),
			rawDuration: rawDurations[idx],
			smoothedDuration: smoothedDurations[idx],
			displayDuration: showSmoothed ? smoothedDurations[idx] : rawDurations[idx],
			count: day.count,
		}));
	}, [data.byDay, timeRange, showSmoothed]);

	// Calculate scales
	const { xScale, yScale, yTicks } = useMemo(() => {
		if (chartData.length === 0) {
			return {
				xScale: (_: number) => padding.left,
				yScale: (_: number) => chartHeight - padding.bottom,
				yTicks: [0],
			};
		}

		const maxDuration = Math.max(
			...chartData.map((d) => d.displayDuration),
			1 // Ensure we have at least some range
		);

		// Add 10% padding to max
		const yMax = maxDuration * 1.1;

		// X scale - linear across data points
		const xScaleFn = (index: number) =>
			padding.left + (index / Math.max(chartData.length - 1, 1)) * innerWidth;

		// Y scale - inverted for SVG coordinates
		const yScaleFn = (value: number) => chartHeight - padding.bottom - (value / yMax) * innerHeight;

		// Generate nice Y-axis ticks
		const tickCount = 5;
		const yTicksArr = Array.from({ length: tickCount }, (_, i) => (yMax / (tickCount - 1)) * i);

		return { xScale: xScaleFn, yScale: yScaleFn, yTicks: yTicksArr };
	}, [chartData, chartHeight, innerWidth, innerHeight, padding]);

	// Generate line path
	const linePath = useMemo(() => {
		if (chartData.length === 0) return '';

		return chartData
			.map((point, idx) => {
				const x = xScale(idx);
				const y = yScale(point.displayDuration);
				return `${idx === 0 ? 'M' : 'L'} ${x} ${y}`;
			})
			.join(' ');
	}, [chartData, xScale, yScale]);

	// Generate area path (for gradient fill)
	const areaPath = useMemo(() => {
		if (chartData.length === 0) return '';

		const pathStart = chartData
			.map((point, idx) => {
				const x = xScale(idx);
				const y = yScale(point.displayDuration);
				return `${idx === 0 ? 'M' : 'L'} ${x} ${y}`;
			})
			.join(' ');

		// Close the path back to the baseline
		const lastX = xScale(chartData.length - 1);
		const firstX = xScale(0);
		const baseline = chartHeight - padding.bottom;

		return `${pathStart} L ${lastX} ${baseline} L ${firstX} ${baseline} Z`;
	}, [chartData, xScale, yScale, chartHeight, padding.bottom]);

	// Handle mouse events for tooltip
	const handleMouseEnter = useCallback(
		(point: DataPoint, event: React.MouseEvent<SVGCircleElement>) => {
			setHoveredPoint(point);
			const rect = event.currentTarget.getBoundingClientRect();
			setTooltipPos({
				x: rect.left + rect.width / 2,
				y: rect.top,
			});
		},
		[]
	);

	const handleMouseLeave = useCallback(() => {
		setHoveredPoint(null);
		setTooltipPos(null);
	}, []);

	// Get the primary chart color (colorblind-safe or theme accent)
	const primaryColor = useMemo(() => {
		return colorBlindMode ? COLORBLIND_LINE_COLORS.primary : theme.colors.accent;
	}, [colorBlindMode, theme.colors.accent]);

	// Parse primary color for gradient
	const accentRgb = useMemo(() => {
		const accent = primaryColor;
		if (accent.startsWith('#')) {
			const hex = accent.slice(1);
			return {
				r: parseInt(hex.slice(0, 2), 16),
				g: parseInt(hex.slice(2, 4), 16),
				b: parseInt(hex.slice(4, 6), 16),
			};
		}
		if (accent.startsWith('rgb')) {
			const match = accent.match(/\d+/g);
			if (match && match.length >= 3) {
				return {
					r: parseInt(match[0]),
					g: parseInt(match[1]),
					b: parseInt(match[2]),
				};
			}
		}
		return { r: 100, g: 149, b: 237 }; // Default blue
	}, [primaryColor]);

	// Generate unique ID for gradient
	const gradientId = useMemo(
		() => `duration-gradient-${Math.random().toString(36).slice(2, 9)}`,
		[]
	);

	return (
		<div
			className="p-4 rounded-lg"
			style={{ backgroundColor: theme.colors.bgMain }}
			role="figure"
			aria-label={`Duration trends chart showing ${showSmoothed ? 'smoothed ' : ''}average response duration over time. ${chartData.length} data points displayed.`}
		>
			{/* Header with title and smoothing toggle */}
			<div className="flex items-center justify-between mb-4">
				<h3 className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
					Duration Trends
				</h3>
				<div className="flex items-center gap-2">
					<label
						className="flex items-center gap-2 cursor-pointer"
						style={{ color: theme.colors.textDim }}
					>
						<span className="text-xs">Smoothing:</span>
						<button
							onClick={() => setShowSmoothed((prev) => !prev)}
							className="relative w-9 h-5 rounded-full transition-colors"
							style={{
								backgroundColor: showSmoothed ? primaryColor : `${theme.colors.border}80`,
							}}
							aria-label={showSmoothed ? 'Disable smoothing' : 'Enable smoothing'}
						>
							<span
								className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform shadow-sm"
								style={{
									transform: showSmoothed ? 'translateX(16px)' : 'translateX(0)',
								}}
							/>
						</button>
					</label>
				</div>
			</div>

			{/* Chart container */}
			<div className="relative">
				{chartData.length === 0 ? (
					<div
						className="flex items-center justify-center"
						style={{ height: chartHeight, color: theme.colors.textDim }}
					>
						<span className="text-sm">No duration data available</span>
					</div>
				) : (
					<svg
						width="100%"
						viewBox={`0 0 ${chartWidth} ${chartHeight}`}
						preserveAspectRatio="xMidYMid meet"
						role="img"
						aria-label={`Line chart of duration trends. ${chartData.length > 0 ? `Range from ${formatDuration(Math.min(...chartData.map((d) => d.displayDuration)))} to ${formatDuration(Math.max(...chartData.map((d) => d.displayDuration)))}` : 'No data available'}`}
					>
						{/* Gradient definition */}
						<defs>
							<linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
								<stop
									offset="0%"
									stopColor={`rgba(${accentRgb.r}, ${accentRgb.g}, ${accentRgb.b}, 0.3)`}
								/>
								<stop
									offset="100%"
									stopColor={`rgba(${accentRgb.r}, ${accentRgb.g}, ${accentRgb.b}, 0)`}
								/>
							</linearGradient>
						</defs>

						{/* Grid lines */}
						{yTicks.map((tick, idx) => (
							<g key={`tick-${idx}`}>
								{/* Horizontal grid line */}
								<line
									x1={padding.left}
									y1={yScale(tick)}
									x2={chartWidth - padding.right}
									y2={yScale(tick)}
									stroke={theme.colors.border}
									strokeOpacity={0.3}
									strokeDasharray="4,4"
								/>
								{/* Y-axis label */}
								<text
									x={padding.left - 8}
									y={yScale(tick)}
									textAnchor="end"
									dominantBaseline="middle"
									fontSize={10}
									fill={theme.colors.textDim}
								>
									{formatYAxisDuration(tick)}
								</text>
							</g>
						))}

						{/* X-axis labels */}
						{chartData.map((point, idx) => {
							// Show fewer labels for longer time ranges
							const labelInterval =
								chartData.length > 14
									? Math.ceil(chartData.length / 7)
									: chartData.length > 7
										? 2
										: 1;

							if (idx % labelInterval !== 0 && idx !== chartData.length - 1) {
								return null;
							}

							return (
								<text
									key={`x-label-${idx}`}
									x={xScale(idx)}
									y={chartHeight - padding.bottom + 20}
									textAnchor="middle"
									fontSize={10}
									fill={theme.colors.textDim}
								>
									{formatXAxisDate(point.date, timeRange)}
								</text>
							);
						})}

						{/* Area fill under the line */}
						<path
							d={areaPath}
							fill={`url(#${gradientId})`}
							style={{
								transition: 'd 0.5s cubic-bezier(0.4, 0, 0.2, 1)',
							}}
						/>

						{/* Main line */}
						<path
							d={linePath}
							fill="none"
							stroke={primaryColor}
							strokeWidth={2}
							strokeLinecap="round"
							strokeLinejoin="round"
							style={{
								transition: 'd 0.5s cubic-bezier(0.4, 0, 0.2, 1)',
							}}
						/>

						{/* Data points */}
						{chartData.map((point, idx) => {
							const x = xScale(idx);
							const y = yScale(point.displayDuration);
							const isHovered = hoveredPoint?.date === point.date;

							return (
								<circle
									key={`point-${idx}`}
									cx={x}
									cy={y}
									r={isHovered ? 6 : 4}
									fill={isHovered ? primaryColor : theme.colors.bgMain}
									stroke={primaryColor}
									strokeWidth={2}
									style={{
										cursor: 'pointer',
										transition:
											'cx 0.5s cubic-bezier(0.4, 0, 0.2, 1), cy 0.5s cubic-bezier(0.4, 0, 0.2, 1), r 0.15s ease',
									}}
									onMouseEnter={(e) => handleMouseEnter(point, e)}
									onMouseLeave={handleMouseLeave}
									role="graphics-symbol"
									aria-label={`${point.formattedDate}: Average duration ${formatDuration(point.displayDuration)}, ${point.count} ${point.count === 1 ? 'query' : 'queries'}`}
									tabIndex={0}
								/>
							);
						})}

						{/* Y-axis label */}
						<text
							x={15}
							y={chartHeight / 2}
							textAnchor="middle"
							dominantBaseline="middle"
							fontSize={11}
							fill={theme.colors.textDim}
							transform={`rotate(-90, 15, ${chartHeight / 2})`}
						>
							Duration
						</text>
					</svg>
				)}

				{/* Tooltip */}
				{hoveredPoint && tooltipPos && (
					<div
						className="fixed z-50 px-3 py-2 rounded text-xs whitespace-nowrap pointer-events-none shadow-lg"
						style={{
							left: tooltipPos.x,
							top: tooltipPos.y - 8,
							transform: 'translate(-50%, -100%)',
							backgroundColor: theme.colors.bgActivity,
							color: theme.colors.textMain,
							border: `1px solid ${theme.colors.border}`,
						}}
					>
						<div className="font-medium mb-1">{hoveredPoint.formattedDate}</div>
						<div style={{ color: theme.colors.textDim }}>
							<div>
								Avg Duration:{' '}
								<span style={{ color: theme.colors.textMain }}>
									{formatDuration(hoveredPoint.displayDuration)}
								</span>
							</div>
							{showSmoothed && hoveredPoint.rawDuration !== hoveredPoint.smoothedDuration && (
								<div>
									Raw:{' '}
									<span style={{ color: theme.colors.textMain }}>
										{formatDuration(hoveredPoint.rawDuration)}
									</span>
								</div>
							)}
							<div>
								Queries: <span style={{ color: theme.colors.textMain }}>{hoveredPoint.count}</span>
							</div>
						</div>
					</div>
				)}
			</div>

			{/* Legend */}
			<div
				className="flex items-center justify-end gap-4 mt-3 pt-3 border-t"
				style={{ borderColor: theme.colors.border }}
			>
				<div className="flex items-center gap-1.5">
					<div className="w-4 h-0.5 rounded" style={{ backgroundColor: primaryColor }} />
					<span className="text-xs" style={{ color: theme.colors.textDim }}>
						{showSmoothed ? 'Moving Average' : 'Avg Duration'}
					</span>
				</div>
				{showSmoothed && (
					<span className="text-xs" style={{ color: theme.colors.textDim }}>
						Window: {getWindowSize(timeRange)} periods
					</span>
				)}
			</div>
		</div>
	);
}

export default DurationTrendsChart;
