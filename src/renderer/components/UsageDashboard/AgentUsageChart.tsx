/**
 * AgentUsageChart
 *
 * Line chart showing provider usage over time with one line per provider.
 * Displays query counts and duration for each provider (claude-code, codex, opencode).
 *
 * Features:
 * - One line per provider
 * - Dual Y-axes: queries (left) and time (right)
 * - Provider-specific colors
 * - Hover tooltips with exact values
 * - Responsive SVG rendering
 * - Theme-aware styling
 */

import React, { useState, useMemo, useCallback } from 'react';
import { format, parseISO } from 'date-fns';
import type { Theme } from '../../types';
import type { StatsTimeRange, StatsAggregation } from '../../hooks/useStats';
import {
	COLORBLIND_AGENT_PALETTE,
	COLORBLIND_LINE_COLORS,
} from '../../constants/colorblindPalettes';

// Provider colors (matching AgentComparisonChart)
const PROVIDER_COLORS: Record<string, string> = {
	'claude-code': '#a78bfa', // violet
	codex: '#34d399', // emerald
	opencode: '#60a5fa', // blue
};

// Data point for a single provider on a single day
interface ProviderDayData {
	date: string;
	formattedDate: string;
	count: number;
	duration: number;
}

// All providers' data for a single day
interface DayData {
	date: string;
	formattedDate: string;
	providers: Record<string, { count: number; duration: number }>;
}

interface AgentUsageChartProps {
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
	if (ms === 0) return '0';

	const totalSeconds = Math.floor(ms / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor(totalSeconds / 60);

	if (hours > 0) {
		return `${hours}h`;
	}
	if (minutes > 0) {
		return `${minutes}m`;
	}
	return `${totalSeconds}s`;
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

/**
 * Get provider color, with colorblind mode support
 */
function getProviderColor(provider: string, index: number, colorBlindMode: boolean): string {
	if (colorBlindMode) {
		return COLORBLIND_AGENT_PALETTE[index % COLORBLIND_AGENT_PALETTE.length];
	}
	return PROVIDER_COLORS[provider] || COLORBLIND_LINE_COLORS.primary;
}

export function AgentUsageChart({
	data,
	timeRange,
	theme,
	colorBlindMode = false,
}: AgentUsageChartProps) {
	const [hoveredDay, setHoveredDay] = useState<{ dayIndex: number; provider?: string } | null>(
		null
	);
	const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);
	const [metricMode, setMetricMode] = useState<'count' | 'duration'>('count');

	// Chart dimensions
	const chartWidth = 600;
	const chartHeight = 220;
	const padding = { top: 20, right: 50, bottom: 40, left: 50 };
	const innerWidth = chartWidth - padding.left - padding.right;
	const innerHeight = chartHeight - padding.top - padding.bottom;

	// Get list of providers and their data
	const { providers, chartData, allDates } = useMemo(() => {
		const byAgentByDay = data.byAgentByDay || {};
		const providerList = Object.keys(byAgentByDay).sort();

		// Collect all unique dates
		const dateSet = new Set<string>();
		for (const provider of providerList) {
			for (const day of byAgentByDay[provider]) {
				dateSet.add(day.date);
			}
		}
		const sortedDates = Array.from(dateSet).sort();

		// Build per-provider arrays aligned to all dates
		const providerData: Record<string, ProviderDayData[]> = {};
		for (const provider of providerList) {
			const dayMap = new Map<string, { count: number; duration: number }>();
			for (const day of byAgentByDay[provider]) {
				dayMap.set(day.date, { count: day.count, duration: day.duration });
			}

			providerData[provider] = sortedDates.map((date) => ({
				date,
				formattedDate: format(parseISO(date), 'EEEE, MMM d, yyyy'),
				count: dayMap.get(date)?.count || 0,
				duration: dayMap.get(date)?.duration || 0,
			}));
		}

		// Build combined day data for tooltips
		const combinedData: DayData[] = sortedDates.map((date) => {
			const providers: Record<string, { count: number; duration: number }> = {};
			for (const provider of providerList) {
				const dayData = providerData[provider].find((d) => d.date === date);
				if (dayData) {
					providers[provider] = { count: dayData.count, duration: dayData.duration };
				}
			}
			return {
				date,
				formattedDate: format(parseISO(date), 'EEEE, MMM d, yyyy'),
				providers,
			};
		});

		return {
			providers: providerList,
			chartData: providerData,
			allDates: combinedData,
		};
	}, [data.byAgentByDay]);

	// Calculate scales
	const { xScale, yScale, yTicks } = useMemo(() => {
		if (allDates.length === 0) {
			return {
				xScale: (_: number) => padding.left,
				yScale: (_: number) => chartHeight - padding.bottom,
				yTicks: [0],
			};
		}

		// Find max value across all providers
		let maxValue = 1;
		for (const provider of providers) {
			const providerMax = Math.max(
				...chartData[provider].map((d) => (metricMode === 'count' ? d.count : d.duration))
			);
			maxValue = Math.max(maxValue, providerMax);
		}

		// Add 10% padding
		const yMax = metricMode === 'count' ? Math.ceil(maxValue * 1.1) : maxValue * 1.1;

		// X scale
		const xScaleFn = (index: number) =>
			padding.left + (index / Math.max(allDates.length - 1, 1)) * innerWidth;

		// Y scale
		const yScaleFn = (value: number) => chartHeight - padding.bottom - (value / yMax) * innerHeight;

		// Y ticks
		const tickCount = 5;
		const yTicksArr =
			metricMode === 'count'
				? Array.from({ length: tickCount }, (_, i) => Math.round((yMax / (tickCount - 1)) * i))
				: Array.from({ length: tickCount }, (_, i) => (yMax / (tickCount - 1)) * i);

		return { xScale: xScaleFn, yScale: yScaleFn, yTicks: yTicksArr };
	}, [allDates, providers, chartData, metricMode, chartHeight, innerWidth, innerHeight, padding]);

	// Generate line paths for each provider
	const linePaths = useMemo(() => {
		const paths: Record<string, string> = {};
		for (const provider of providers) {
			const providerDays = chartData[provider];
			if (providerDays.length === 0) continue;

			paths[provider] = providerDays
				.map((day, idx) => {
					const x = xScale(idx);
					const y = yScale(metricMode === 'count' ? day.count : day.duration);
					return `${idx === 0 ? 'M' : 'L'} ${x} ${y}`;
				})
				.join(' ');
		}
		return paths;
	}, [providers, chartData, xScale, yScale, metricMode]);

	// Handle mouse events
	const handleMouseEnter = useCallback(
		(dayIndex: number, provider: string, event: React.MouseEvent<SVGCircleElement>) => {
			setHoveredDay({ dayIndex, provider });
			const rect = event.currentTarget.getBoundingClientRect();
			setTooltipPos({
				x: rect.left + rect.width / 2,
				y: rect.top,
			});
		},
		[]
	);

	const handleMouseLeave = useCallback(() => {
		setHoveredDay(null);
		setTooltipPos(null);
	}, []);

	return (
		<div
			className="p-4 rounded-lg"
			style={{ backgroundColor: theme.colors.bgMain }}
			role="figure"
			aria-label={`Provider usage chart showing ${metricMode === 'count' ? 'query counts' : 'duration'} over time. ${providers.length} providers displayed.`}
		>
			{/* Header with title and metric toggle */}
			<div className="flex items-center justify-between mb-4">
				<h3 className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
					Agent Usage Over Time
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
								backgroundColor: metricMode === 'count' ? theme.colors.accent : 'transparent',
								color: metricMode === 'count' ? theme.colors.bgMain : theme.colors.textDim,
							}}
						>
							Queries
						</button>
						<button
							onClick={() => setMetricMode('duration')}
							className="px-2 py-1 text-xs transition-colors"
							style={{
								backgroundColor: metricMode === 'duration' ? theme.colors.accent : 'transparent',
								color: metricMode === 'duration' ? theme.colors.bgMain : theme.colors.textDim,
							}}
						>
							Time
						</button>
					</div>
				</div>
			</div>

			{/* Chart container */}
			<div className="relative">
				{allDates.length === 0 || providers.length === 0 ? (
					<div
						className="flex items-center justify-center"
						style={{ height: chartHeight, color: theme.colors.textDim }}
					>
						<span className="text-sm">No usage data available</span>
					</div>
				) : (
					<svg
						width="100%"
						viewBox={`0 0 ${chartWidth} ${chartHeight}`}
						preserveAspectRatio="xMidYMid meet"
						role="img"
						aria-label={`Line chart showing ${metricMode === 'count' ? 'query counts' : 'duration'} per provider over time`}
					>
						{/* Grid lines */}
						{yTicks.map((tick, idx) => (
							<line
								key={`grid-${idx}`}
								x1={padding.left}
								y1={yScale(tick)}
								x2={chartWidth - padding.right}
								y2={yScale(tick)}
								stroke={theme.colors.border}
								strokeOpacity={0.3}
								strokeDasharray="4,4"
							/>
						))}

						{/* Y-axis labels */}
						{yTicks.map((tick, idx) => (
							<text
								key={`y-${idx}`}
								x={padding.left - 8}
								y={yScale(tick)}
								textAnchor="end"
								dominantBaseline="middle"
								fontSize={10}
								fill={theme.colors.textDim}
							>
								{metricMode === 'count' ? tick : formatYAxisDuration(tick)}
							</text>
						))}

						{/* X-axis labels */}
						{allDates.map((day, idx) => {
							const labelInterval =
								allDates.length > 14 ? Math.ceil(allDates.length / 7) : allDates.length > 7 ? 2 : 1;

							if (idx % labelInterval !== 0 && idx !== allDates.length - 1) {
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
									{formatXAxisDate(day.date, timeRange)}
								</text>
							);
						})}

						{/* Lines for each provider */}
						{providers.map((provider, providerIdx) => {
							const color = getProviderColor(provider, providerIdx, colorBlindMode);
							return (
								<path
									key={`line-${provider}`}
									d={linePaths[provider]}
									fill="none"
									stroke={color}
									strokeWidth={2}
									strokeLinecap="round"
									strokeLinejoin="round"
									style={{ transition: 'd 0.5s cubic-bezier(0.4, 0, 0.2, 1)' }}
								/>
							);
						})}

						{/* Data points for each provider */}
						{providers.map((provider, providerIdx) => {
							const color = getProviderColor(provider, providerIdx, colorBlindMode);
							return chartData[provider].map((day, dayIdx) => {
								const x = xScale(dayIdx);
								const y = yScale(metricMode === 'count' ? day.count : day.duration);
								const isHovered =
									hoveredDay?.dayIndex === dayIdx && hoveredDay?.provider === provider;

								return (
									<circle
										key={`point-${provider}-${dayIdx}`}
										cx={x}
										cy={y}
										r={isHovered ? 6 : 4}
										fill={isHovered ? color : theme.colors.bgMain}
										stroke={color}
										strokeWidth={2}
										style={{
											cursor: 'pointer',
											transition: 'r 0.15s ease',
										}}
										onMouseEnter={(e) => handleMouseEnter(dayIdx, provider, e)}
										onMouseLeave={handleMouseLeave}
									/>
								);
							});
						})}

						{/* Y-axis title */}
						<text
							x={12}
							y={chartHeight / 2}
							textAnchor="middle"
							dominantBaseline="middle"
							fontSize={11}
							fill={theme.colors.textDim}
							transform={`rotate(-90, 12, ${chartHeight / 2})`}
						>
							{metricMode === 'count' ? 'Queries' : 'Time'}
						</text>
					</svg>
				)}

				{/* Tooltip */}
				{hoveredDay && tooltipPos && allDates[hoveredDay.dayIndex] && (
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
						<div className="font-medium mb-1">{allDates[hoveredDay.dayIndex].formattedDate}</div>
						<div style={{ color: theme.colors.textDim }}>
							{providers.map((provider, idx) => {
								const dayData = allDates[hoveredDay.dayIndex].providers[provider];
								if (!dayData || (dayData.count === 0 && dayData.duration === 0)) return null;
								const color = getProviderColor(provider, idx, colorBlindMode);
								return (
									<div key={provider} className="flex items-center gap-2">
										<span className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
										<span>{provider}:</span>
										<span style={{ color: theme.colors.textMain }}>
											{metricMode === 'count'
												? `${dayData.count} ${dayData.count === 1 ? 'query' : 'queries'}`
												: formatDuration(dayData.duration)}
										</span>
									</div>
								);
							})}
						</div>
					</div>
				)}
			</div>

			{/* Legend */}
			<div
				className="flex items-center justify-center gap-4 mt-3 pt-3 border-t flex-wrap"
				style={{ borderColor: theme.colors.border }}
			>
				{providers.map((provider, idx) => {
					const color = getProviderColor(provider, idx, colorBlindMode);
					return (
						<div key={provider} className="flex items-center gap-1.5">
							<div className="w-3 h-0.5 rounded" style={{ backgroundColor: color }} />
							<span className="text-xs" style={{ color: theme.colors.textDim }}>
								{provider}
							</span>
						</div>
					);
				})}
			</div>
		</div>
	);
}

export default AgentUsageChart;
