/**
 * AgentUsageChart
 *
 * Line chart showing Maestro agent (session) usage over time with one line per agent.
 * Displays query counts and duration for each agent that was used during the time period.
 *
 * Features:
 * - One line per Maestro agent (named session from left panel)
 * - Toggle between query count and time metrics
 * - Session ID to name mapping when names are available
 * - Hover tooltips with exact values
 * - Responsive SVG rendering
 * - Theme-aware styling
 * - Limits display to top 10 agents by query count
 */

import React, { memo, useState, useMemo, useCallback, useRef, useLayoutEffect } from 'react';
import { format, parseISO } from 'date-fns';
import type { Theme, Session } from '../../types';
import type { StatsTimeRange, StatsAggregation } from '../../hooks/stats/useStats';
import { COLORBLIND_AGENT_PALETTE } from '../../constants/colorblindPalettes';
import { formatDurationHuman as formatDuration } from '../../../shared/formatters';
import { buildNameMap, clampTooltipToViewport } from './chartUtils';

// 10 distinct colors for agents
const AGENT_COLORS = [
	'#a78bfa', // violet
	'#34d399', // emerald
	'#60a5fa', // blue
	'#f472b6', // pink
	'#fbbf24', // amber
	'#fb923c', // orange
	'#4ade80', // green
	'#38bdf8', // sky
	'#c084fc', // purple
	'#f87171', // red
];

// Data point for a single agent on a single day
interface AgentDayData {
	date: string;
	formattedDate: string;
	count: number;
	duration: number;
}

// All agents' data for a single day
interface DayData {
	date: string;
	formattedDate: string;
	agents: Record<string, { count: number; duration: number }>;
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
	/** Current sessions for mapping IDs to names */
	sessions?: Session[];
	/** Drill-down click handler — fires with the legend item's session key + display name. */
	onAgentClick?: (key: string, displayName: string) => void;
	/**
	 * Active drill-down filter key. When set, the matching line is rendered with
	 * a thicker stroke and the legend item is highlighted; non-matching lines
	 * dim to 15% stroke opacity. `null`/undefined means no filter is active.
	 */
	activeFilterKey?: string | null;
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
		case 'quarter':
			return format(date, 'MMM d'); // Show month and day for quarter
		case 'year':
			return format(date, 'MMM');
		case 'all':
			return format(date, 'MMM yyyy');
		default:
			return format(date, 'MMM d');
	}
}

/**
 * Get agent color based on index, with colorblind mode support
 */
function getAgentColor(index: number, colorBlindMode: boolean): string {
	if (colorBlindMode) {
		return COLORBLIND_AGENT_PALETTE[index % COLORBLIND_AGENT_PALETTE.length];
	}
	return AGENT_COLORS[index % AGENT_COLORS.length];
}

export const AgentUsageChart = memo(function AgentUsageChart({
	data,
	timeRange,
	theme,
	colorBlindMode = false,
	sessions,
	onAgentClick,
	activeFilterKey = null,
}: AgentUsageChartProps) {
	const [hoveredDay, setHoveredDay] = useState<{ dayIndex: number; agent?: string } | null>(null);
	const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);
	const [metricMode, setMetricMode] = useState<'count' | 'duration'>('count');
	// Measure the actual rendered tooltip so the viewport clamp uses real
	// width/height — the static estimates below are starting points and the
	// `whitespace-nowrap` content can grow wider with long agent names.
	const tooltipRef = useRef<HTMLDivElement>(null);
	const [tooltipDims, setTooltipDims] = useState<{ width: number; height: number } | null>(null);

	// Chart dimensions
	const chartWidth = 600;
	const chartHeight = 220;
	const padding = { top: 20, right: 50, bottom: 40, left: 50 };
	const innerWidth = chartWidth - padding.left - padding.right;
	const innerHeight = chartHeight - padding.top - padding.bottom;

	// Get list of agents and their data (limited to top 10 by total queries)
	const { agents, chartData, allDates, agentDisplayNames, worktreeAgents } = useMemo(() => {
		const bySessionByDay = data.bySessionByDay || {};

		// Calculate total queries per session to rank them
		const sessionTotals: Array<{ sessionId: string; totalQueries: number }> = [];
		for (const sessionId of Object.keys(bySessionByDay)) {
			const totalQueries = bySessionByDay[sessionId].reduce((sum, day) => sum + day.count, 0);
			sessionTotals.push({ sessionId, totalQueries });
		}

		// Sort by total queries descending and take top 10
		sessionTotals.sort((a, b) => b.totalQueries - a.totalQueries);
		const topSessions = sessionTotals.slice(0, 10);
		const agentList = topSessions.map((s) => s.sessionId);

		// Resolve session IDs to user-facing display names via the shared
		// `buildNameMap` utility — keeps name resolution consistent with the
		// other dashboard charts. Worktree sessions still get a " (WT)" text
		// suffix on top of the visual dashed-line indicator so they're
		// distinguishable in tooltips where the line marker isn't visible.
		const nameMap = buildNameMap(agentList, sessions);
		const displayNames: Record<string, string> = {};
		const worktreeSet = new Set<string>();
		for (const sessionId of agentList) {
			const resolved = nameMap.get(sessionId);
			if (!resolved) continue;
			displayNames[sessionId] = resolved.isWorktree ? `${resolved.name} (WT)` : resolved.name;
			if (resolved.isWorktree) {
				worktreeSet.add(sessionId);
			}
		}

		// Collect all unique dates from selected agents
		const dateSet = new Set<string>();
		for (const sessionId of agentList) {
			for (const day of bySessionByDay[sessionId]) {
				dateSet.add(day.date);
			}
		}
		const sortedDates = Array.from(dateSet).sort();

		// Build per-agent arrays aligned to all dates
		const agentData: Record<string, AgentDayData[]> = {};
		for (const sessionId of agentList) {
			const dayMap = new Map<string, { count: number; duration: number }>();
			for (const day of bySessionByDay[sessionId]) {
				dayMap.set(day.date, { count: day.count, duration: day.duration });
			}

			agentData[sessionId] = sortedDates.map((date) => ({
				date,
				formattedDate: format(parseISO(date), 'EEEE, MMM d, yyyy'),
				count: dayMap.get(date)?.count || 0,
				duration: dayMap.get(date)?.duration || 0,
			}));
		}

		// Build combined day data for tooltips
		const combinedData: DayData[] = sortedDates.map((date) => {
			const agents: Record<string, { count: number; duration: number }> = {};
			for (const sessionId of agentList) {
				const dayData = agentData[sessionId].find((d) => d.date === date);
				if (dayData) {
					agents[sessionId] = { count: dayData.count, duration: dayData.duration };
				}
			}
			return {
				date,
				formattedDate: format(parseISO(date), 'EEEE, MMM d, yyyy'),
				agents,
			};
		});

		return {
			agents: agentList,
			chartData: agentData,
			allDates: combinedData,
			agentDisplayNames: displayNames,
			worktreeAgents: worktreeSet,
		};
	}, [data.bySessionByDay, sessions]);

	// Calculate scales
	const { xScale, yScale, yTicks } = useMemo(() => {
		if (allDates.length === 0) {
			return {
				xScale: (_: number) => padding.left,
				yScale: (_: number) => chartHeight - padding.bottom,
				yTicks: [0],
			};
		}

		// Find max value across all agents
		let maxValue = 1;
		for (const agent of agents) {
			const agentMax = Math.max(
				...chartData[agent].map((d) => (metricMode === 'count' ? d.count : d.duration))
			);
			maxValue = Math.max(maxValue, agentMax);
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
	}, [allDates, agents, chartData, metricMode, chartHeight, innerWidth, innerHeight, padding]);

	// Generate line paths for each agent
	const linePaths = useMemo(() => {
		const paths: Record<string, string> = {};
		for (const agent of agents) {
			const agentDays = chartData[agent];
			if (agentDays.length === 0) continue;

			paths[agent] = agentDays
				.map((day, idx) => {
					const x = xScale(idx);
					const y = yScale(metricMode === 'count' ? day.count : day.duration);
					return `${idx === 0 ? 'M' : 'L'} ${x} ${y}`;
				})
				.join(' ');
		}
		return paths;
	}, [agents, chartData, xScale, yScale, metricMode]);

	// Handle mouse events
	const handleMouseEnter = useCallback(
		(dayIndex: number, agent: string, event: React.MouseEvent<SVGCircleElement>) => {
			setHoveredDay({ dayIndex, agent });
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

	// Measure the tooltip after each render and feed the result back into the
	// clamp so wide content (long agent names + counts) doesn't push the
	// tooltip past the right edge of the viewport. `useLayoutEffect` runs
	// before paint, so the correctly clamped position is what the user sees.
	useLayoutEffect(() => {
		if (!hoveredDay || !tooltipPos) {
			if (tooltipDims !== null) setTooltipDims(null);
			return;
		}
		const node = tooltipRef.current;
		if (!node) return;
		const r = node.getBoundingClientRect();
		if (
			!tooltipDims ||
			Math.abs(tooltipDims.width - r.width) > 0.5 ||
			Math.abs(tooltipDims.height - r.height) > 0.5
		) {
			setTooltipDims({ width: r.width, height: r.height });
		}
	}, [hoveredDay, tooltipPos, tooltipDims]);

	// Forward legend clicks to the dashboard's drill-down handler. Toggle
	// behavior (clicking the active legend item clears the filter) is owned by
	// the dashboard; this component just reports which agent was clicked.
	const handleAgentClick = useCallback(
		(agentKey: string, displayName: string) => {
			if (!onAgentClick) return;
			onAgentClick(agentKey, displayName);
		},
		[onAgentClick]
	);

	return (
		<div
			className="p-4 rounded-lg"
			style={{ backgroundColor: theme.colors.bgMain }}
			role="figure"
			aria-label={`Agent usage chart showing ${metricMode === 'count' ? 'query counts' : 'duration'} over time. ${agents.length} agents displayed.`}
		>
			{/* Header with title and metric toggle */}
			<div className="flex items-center justify-between mb-4">
				<h3
					className="text-sm font-medium"
					style={{ color: theme.colors.textMain, animation: 'card-enter 0.4s ease both' }}
				>
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
				{allDates.length === 0 || agents.length === 0 ? (
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
						aria-label={`Line chart showing ${metricMode === 'count' ? 'query counts' : 'duration'} per agent over time`}
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

						{/* Lines for each agent */}
						{agents.map((agent, agentIdx) => {
							const color = getAgentColor(agentIdx, colorBlindMode);
							const isWorktree = worktreeAgents.has(agent);
							const isFiltered = activeFilterKey != null;
							const isSelected = isFiltered && activeFilterKey === agent;
							const isDimmed = isFiltered && !isSelected;
							return (
								<path
									key={`line-${agent}`}
									d={linePaths[agent]}
									fill="none"
									stroke={color}
									strokeWidth={isSelected ? 2.5 : 2}
									strokeOpacity={isDimmed ? 0.15 : 1}
									strokeLinecap="round"
									strokeLinejoin="round"
									strokeDasharray={isWorktree ? '5 3' : undefined}
									style={{
										transition:
											'd 0.5s cubic-bezier(0.4, 0, 0.2, 1), stroke-opacity 0.2s ease, stroke-width 0.2s ease',
									}}
								/>
							);
						})}

						{/* Data points for each agent */}
						{agents.map((agent, agentIdx) => {
							const color = getAgentColor(agentIdx, colorBlindMode);
							const isFiltered = activeFilterKey != null;
							const isSelected = isFiltered && activeFilterKey === agent;
							const isDimmed = isFiltered && !isSelected;
							return chartData[agent].map((day, dayIdx) => {
								const x = xScale(dayIdx);
								const y = yScale(metricMode === 'count' ? day.count : day.duration);
								const isHovered = hoveredDay?.dayIndex === dayIdx && hoveredDay?.agent === agent;

								return (
									<circle
										key={`point-${agent}-${dayIdx}`}
										cx={x}
										cy={y}
										r={isHovered ? 6 : 4}
										fill={isHovered ? color : theme.colors.bgMain}
										stroke={color}
										strokeWidth={2}
										opacity={isDimmed ? 0.15 : 1}
										style={{
											cursor: 'pointer',
											transition: 'r 0.15s ease, opacity 0.2s ease',
										}}
										onMouseEnter={(e) => handleMouseEnter(dayIdx, agent, e)}
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

				{/* Tooltip — clamped to viewport so points near the chart edges don't
				    push the tooltip off-screen. The first paint uses size estimates;
				    `useLayoutEffect` then measures the real rendered rect and re-clamps
				    before the browser paints, so dynamic content (long agent labels,
				    many lines) stays fully on-screen. */}
				{hoveredDay &&
					tooltipPos &&
					allDates[hoveredDay.dayIndex] &&
					(() => {
						const visibleAgents = agents.filter((agent) => {
							const dayData = allDates[hoveredDay.dayIndex].agents[agent];
							return dayData && (dayData.count > 0 || dayData.duration > 0);
						});
						const fallbackWidth = 280;
						const fallbackHeight = 32 + visibleAgents.length * 18;
						const { left, top } = clampTooltipToViewport({
							anchorX: tooltipPos.x,
							anchorY: tooltipPos.y - 8,
							width: tooltipDims?.width ?? fallbackWidth,
							height: tooltipDims?.height ?? fallbackHeight,
							transform: 'top-center',
						});
						return (
							<div
								ref={tooltipRef}
								className="fixed z-50 px-3 py-2 rounded text-xs whitespace-nowrap pointer-events-none shadow-lg"
								style={{
									left,
									top,
									backgroundColor: theme.colors.bgActivity,
									color: theme.colors.textMain,
									border: `1px solid ${theme.colors.border}`,
								}}
							>
								<div className="font-medium mb-1">
									{allDates[hoveredDay.dayIndex].formattedDate}
								</div>
								<div style={{ color: theme.colors.textDim }}>
									{agents.map((agent, idx) => {
										const dayData = allDates[hoveredDay.dayIndex].agents[agent];
										if (!dayData || (dayData.count === 0 && dayData.duration === 0)) return null;
										const color = getAgentColor(idx, colorBlindMode);
										return (
											<div key={agent} className="flex items-center gap-2">
												<span className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
												<span>{agentDisplayNames[agent]}:</span>
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
						);
					})()}
			</div>

			{/* Legend — clickable when `onAgentClick` is wired (drill-down filter). */}
			<div
				className="flex items-center justify-center gap-4 mt-3 pt-3 border-t flex-wrap"
				style={{ borderColor: theme.colors.border }}
			>
				{agents.map((agent, idx) => {
					const color = getAgentColor(idx, colorBlindMode);
					const isWorktree = worktreeAgents.has(agent);
					const displayName = agentDisplayNames[agent];
					const isClickable = !!onAgentClick;
					const isFiltered = activeFilterKey != null;
					const isSelected = isFiltered && activeFilterKey === agent;
					const isDimmed = isFiltered && !isSelected;
					return (
						<div
							key={agent}
							className="flex items-center gap-1.5 rounded"
							style={{
								padding: isClickable ? '2px 6px' : undefined,
								margin: isClickable ? '-2px -6px' : undefined,
								cursor: isClickable ? 'pointer' : undefined,
								backgroundColor: isSelected ? `${theme.colors.accent}26` : undefined,
								opacity: isDimmed ? 0.5 : 1,
								transition: 'background-color 0.2s ease, opacity 0.2s ease',
							}}
							onClick={isClickable ? () => handleAgentClick(agent, displayName) : undefined}
							onKeyDown={
								isClickable
									? (e) => {
											if (e.key === 'Enter' || e.key === ' ') {
												e.preventDefault();
												handleAgentClick(agent, displayName);
											}
										}
									: undefined
							}
							role={isClickable ? 'button' : undefined}
							tabIndex={isClickable ? 0 : undefined}
							aria-pressed={isClickable ? isSelected : undefined}
							aria-label={isClickable ? `${displayName}. Click to filter dashboard.` : undefined}
						>
							{isWorktree ? (
								<svg width={12} height={2} aria-hidden="true">
									<line
										x1={0}
										y1={1}
										x2={12}
										y2={1}
										stroke={color}
										strokeWidth={2}
										strokeDasharray="3 2"
									/>
								</svg>
							) : (
								<div className="w-3 h-0.5 rounded" style={{ backgroundColor: color }} />
							)}
							<span className="text-xs" style={{ color: theme.colors.textDim }}>
								{displayName}
							</span>
						</div>
					);
				})}
			</div>
		</div>
	);
});

export default AgentUsageChart;
