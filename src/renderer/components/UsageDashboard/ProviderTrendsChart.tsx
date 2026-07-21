/**
 * ProviderTrendsChart
 *
 * Stacked bar chart showing how provider usage shifts over the lookback window.
 * Each bar is one day, segmented per provider, so drift between providers
 * (e.g. Claude Code → Codex) shows up as a visible change in segment heights.
 */

import React, { memo, useMemo, useState, useCallback } from 'react';
import { format, parseISO } from 'date-fns';
import type { Theme, Session } from '../../types';
import type { StatsTimeRange, StatsAggregation } from '../../hooks/stats/useStats';
import { COLORBLIND_AGENT_PALETTE } from '../../constants/colorblindPalettes';
import { formatDurationHuman as formatDuration, formatNumber } from '../../../shared/formatters';
import { buildNameMap } from './chartUtils';
import { ChartTooltip } from './ChartTooltip';

interface ProviderTrendsChartProps {
	data: StatsAggregation;
	timeRange: StatsTimeRange;
	theme: Theme;
	colorBlindMode?: boolean;
	sessions?: Session[];
}

// Mirrors `getAgentColor` in AgentComparisonChart so the two charts use the
// same color per provider - important when reading them side-by-side.
function getProviderColor(index: number, theme: Theme, colorBlindMode: boolean): string {
	if (colorBlindMode) {
		return COLORBLIND_AGENT_PALETTE[index % COLORBLIND_AGENT_PALETTE.length];
	}
	if (index === 0) return theme.colors.accent;
	const palette = [
		'#10b981',
		'#8b5cf6',
		'#ef4444',
		'#06b6d4',
		'#ec4899',
		'#f59e0b',
		'#84cc16',
		'#6366f1',
	];
	return palette[(index - 1) % palette.length];
}

function formatXAxisDate(dateStr: string, timeRange: StatsTimeRange): string {
	const date = parseISO(dateStr);
	switch (timeRange) {
		case 'day':
			return format(date, 'HH:mm');
		case 'week':
			return format(date, 'EEE');
		case 'month':
		case 'quarter':
			return format(date, 'MMM d');
		case 'year':
			return format(date, 'MMM');
		case 'all':
			return format(date, 'MMM yyyy');
		default:
			return format(date, 'MMM d');
	}
}

function formatYAxisDuration(ms: number): string {
	if (ms === 0) return '0';
	const totalSeconds = Math.floor(ms / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor(totalSeconds / 60);
	if (hours > 0) return `${hours}h`;
	if (minutes > 0) return `${minutes}m`;
	return `${totalSeconds}s`;
}

export const ProviderTrendsChart = memo(function ProviderTrendsChart({
	data,
	timeRange,
	theme,
	colorBlindMode = false,
	sessions,
}: ProviderTrendsChartProps) {
	const [metricMode, setMetricMode] = useState<'count' | 'duration'>('count');
	const [hoveredDay, setHoveredDay] = useState<number | null>(null);
	const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);

	const { providers, providerNames, providerColors, dates, perDayValues } = useMemo(() => {
		const byAgentByDay = data.byAgentByDay || {};
		const providerKeys = Object.keys(byAgentByDay);

		const totals: Record<string, number> = {};
		for (const p of providerKeys) {
			totals[p] = byAgentByDay[p].reduce((sum, d) => sum + d.count, 0);
		}
		const sorted = [...providerKeys].sort((a, b) => totals[b] - totals[a]);

		const nameMap = buildNameMap(sorted, sessions);
		const names: Record<string, string> = {};
		const colors: Record<string, string> = {};
		sorted.forEach((p, i) => {
			names[p] = nameMap.get(p)?.name ?? p;
			colors[p] = getProviderColor(i, theme, colorBlindMode);
		});

		const dateSet = new Set<string>();
		for (const p of sorted) {
			for (const d of byAgentByDay[p]) dateSet.add(d.date);
		}
		const sortedDates = Array.from(dateSet).sort();

		const lookup: Record<string, Record<string, { count: number; duration: number }>> = {};
		for (const p of sorted) {
			for (const d of byAgentByDay[p]) {
				if (!lookup[d.date]) lookup[d.date] = {};
				lookup[d.date][p] = { count: d.count, duration: d.duration };
			}
		}

		return {
			providers: sorted,
			providerNames: names,
			providerColors: colors,
			dates: sortedDates,
			perDayValues: lookup,
		};
	}, [data.byAgentByDay, sessions, theme, colorBlindMode]);

	const chartWidth = 600;
	const chartHeight = 220;
	const padding = { top: 10, right: 16, bottom: 32, left: 50 };
	const innerWidth = chartWidth - padding.left - padding.right;
	const innerHeight = chartHeight - padding.top - padding.bottom;

	const { yMax, yTicks } = useMemo(() => {
		let max = 0;
		for (const date of dates) {
			const day = perDayValues[date] || {};
			const total = providers.reduce((sum, p) => sum + (day[p]?.[metricMode] ?? 0), 0);
			if (total > max) max = total;
		}
		if (max === 0) return { yMax: 1, yTicks: [0] };
		const padded = metricMode === 'count' ? Math.ceil(max * 1.1) : max * 1.1;
		const tickCount = 5;
		const ticks = Array.from({ length: tickCount }, (_, i) => (padded / (tickCount - 1)) * i);
		return {
			yMax: padded,
			yTicks: metricMode === 'count' ? ticks.map((t) => Math.round(t)) : ticks,
		};
	}, [dates, perDayValues, providers, metricMode]);

	const barWidth = dates.length > 0 ? innerWidth / dates.length : 0;
	const barInner = Math.max(1, barWidth * 0.7);
	const barOffset = (barWidth - barInner) / 2;

	const yScale = useCallback(
		(v: number) => padding.top + (1 - v / yMax) * innerHeight,
		[yMax, padding.top, innerHeight]
	);
	const xForIndex = useCallback(
		(i: number) => padding.left + i * barWidth,
		[padding.left, barWidth]
	);

	const handleMouseEnter = useCallback((idx: number, e: React.MouseEvent) => {
		setHoveredDay(idx);
		setTooltipPos({ x: e.clientX, y: e.clientY });
	}, []);
	const handleMouseMove = useCallback((e: React.MouseEvent) => {
		setTooltipPos({ x: e.clientX, y: e.clientY });
	}, []);
	const handleMouseLeave = useCallback(() => {
		setHoveredDay(null);
		setTooltipPos(null);
	}, []);

	return (
		<div
			className="p-4 rounded-lg"
			style={{ backgroundColor: theme.colors.bgMain }}
			role="figure"
			aria-label={`Provider trends over time, stacked bar chart. ${providers.length} providers across ${dates.length} days.`}
		>
			<div className="flex items-center justify-between mb-4">
				<h3
					className="text-sm font-medium"
					style={{ color: theme.colors.textMain, animation: 'card-enter 0.4s ease both' }}
				>
					Provider Trends Over Time
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

			<div className="relative">
				{dates.length === 0 || providers.length === 0 ? (
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
						aria-label={`Stacked bar chart showing ${metricMode === 'count' ? 'query counts' : 'duration'} per provider per day`}
					>
						{yTicks.map((t, i) => (
							<g key={`tick-${i}`}>
								<line
									x1={padding.left}
									y1={yScale(t)}
									x2={chartWidth - padding.right}
									y2={yScale(t)}
									stroke={theme.colors.border}
									strokeOpacity={0.3}
									strokeDasharray="4,4"
								/>
								<text
									x={padding.left - 8}
									y={yScale(t)}
									textAnchor="end"
									dominantBaseline="middle"
									fontSize={10}
									fill={theme.colors.textDim}
								>
									{metricMode === 'count' ? t : formatYAxisDuration(t)}
								</text>
							</g>
						))}

						{dates.map((date, dayIdx) => {
							const day = perDayValues[date] || {};
							let cumulative = 0;
							const xCol = xForIndex(dayIdx);
							const xBar = xCol + barOffset;
							const isOtherHovered = hoveredDay !== null && hoveredDay !== dayIdx;
							return (
								<g
									key={`bar-${date}`}
									onMouseEnter={(e) => handleMouseEnter(dayIdx, e)}
									onMouseMove={handleMouseMove}
									onMouseLeave={handleMouseLeave}
									style={{ cursor: 'pointer' }}
								>
									{/* Hit area covers full column width so thin bars are easy to hover. */}
									<rect
										x={xCol}
										y={padding.top}
										width={barWidth}
										height={innerHeight}
										fill="transparent"
									/>
									{providers.map((p) => {
										const v = day[p]?.[metricMode] ?? 0;
										if (v <= 0) return null;
										const segHeight = (v / yMax) * innerHeight;
										const yTop = yScale(cumulative + v);
										cumulative += v;
										return (
											<rect
												key={p}
												x={xBar}
												y={yTop}
												width={barInner}
												height={Math.max(0, segHeight)}
												fill={providerColors[p]}
												opacity={isOtherHovered ? 0.45 : 0.9}
												style={{ transition: 'opacity 0.15s ease' }}
											/>
										);
									})}
								</g>
							);
						})}

						{dates.map((date, dayIdx) => {
							const labelInterval =
								dates.length > 14 ? Math.ceil(dates.length / 7) : dates.length > 7 ? 2 : 1;
							if (dayIdx % labelInterval !== 0 && dayIdx !== dates.length - 1) return null;
							return (
								<text
									key={`x-${dayIdx}`}
									x={xForIndex(dayIdx) + barWidth / 2}
									y={chartHeight - padding.bottom + 18}
									textAnchor="middle"
									fontSize={10}
									fill={theme.colors.textDim}
								>
									{formatXAxisDate(date, timeRange)}
								</text>
							);
						})}
					</svg>
				)}

				{hoveredDay !== null &&
					dates[hoveredDay] &&
					(() => {
						const date = dates[hoveredDay];
						const day = perDayValues[date] || {};
						const visible = providers.filter((p) => (day[p]?.[metricMode] ?? 0) > 0);
						if (visible.length === 0) return null;
						return (
							<ChartTooltip
								anchor={tooltipPos}
								theme={theme}
								width={260}
								height={32 + visible.length * 18}
							>
								<div className="font-medium mb-1">
									{format(parseISO(date), 'EEEE, MMM d, yyyy')}
								</div>
								<div style={{ color: theme.colors.textDim }}>
									{visible.map((p) => {
										const v = day[p]?.[metricMode] ?? 0;
										return (
											<div key={p} className="flex items-center gap-2">
												<span
													className="w-2 h-2 rounded-sm"
													style={{ backgroundColor: providerColors[p] }}
												/>
												<span>{providerNames[p]}:</span>
												<span style={{ color: theme.colors.textMain }}>
													{metricMode === 'count'
														? `${formatNumber(v)} ${v === 1 ? 'query' : 'queries'}`
														: formatDuration(v)}
												</span>
											</div>
										);
									})}
								</div>
							</ChartTooltip>
						);
					})()}
			</div>

			{providers.length > 0 && (
				<div
					className="flex flex-wrap items-center gap-3 mt-3 pt-3 border-t"
					style={{ borderColor: theme.colors.border }}
					role="list"
					aria-label="Chart legend"
				>
					{providers.map((p) => (
						<div key={p} className="flex items-center gap-1.5" role="listitem">
							<div
								className="w-2.5 h-2.5 rounded-sm"
								style={{ backgroundColor: providerColors[p] }}
							/>
							<span className="text-xs" style={{ color: theme.colors.textDim }}>
								{providerNames[p]}
							</span>
						</div>
					))}
				</div>
			)}
		</div>
	);
});

export default ProviderTrendsChart;
