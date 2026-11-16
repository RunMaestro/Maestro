/**
 * ProviderTrendsChart
 *
 * Stacked bars showing how provider usage shifts across the selected range.
 * The x axis is a real time axis: every day of the range's window gets a slot,
 * idle days included, so a quiet week reads as a gap rather than vanishing.
 * Long windows are grouped into equal runs of days so a bar never gets thinner
 * than the chart can draw.
 */

import React, { memo, useMemo, useState, useCallback } from 'react';
import { format } from 'date-fns';
import type { Theme } from '../../types';
import type { StatsTimeRange, StatsAggregation } from '../../hooks/stats/useStats';
import { getAgentDisplayName } from '../../../shared/agentMetadata';
import { formatNumber } from '../../../shared/formatters';
import { humanizeDuration, DURATION_LADDER_HOURS } from '../../../shared/duration';
import { localDaysBetween } from '../../../shared/daySeries';
import { parseLocalYmd } from '../../../shared/localDay';
import {
	chunkIntoEqualGroups,
	computeAxisLabelIndices,
	PHONE_AXIS_LABELS,
	getSeriesColor,
	rankProvidersByCount,
} from './chartUtils';
import { usePhoneLayout } from '../../hooks/ui/useViewportBreakpoint';
import { ChartTooltip } from '../widgets';
import { ChartLoadingOverlay } from './ChartLoadingOverlay';
import {
	MetricModeToggle,
	OVERVIEW_METRIC_LABELS,
	formatMetricValue,
	metricModeNoun,
	type ChartMetricMode,
} from './MetricModeToggle';
import { useTokenSeries } from './TokenSeriesContext';
import { usePersistedChoice } from '../../hooks/ui/usePersistedChoice';

const METRIC_MODES: readonly ChartMetricMode[] = ['count', 'duration', 'tokens'];
const METRIC_STORAGE_KEY = 'usageDashboard.providerTrends.metric';
/** Most bars the 534px plot area draws before days are grouped. */
const MAX_BARS = 120;

interface ProviderTrendsChartProps {
	data: StatsAggregation;
	timeRange: StatsTimeRange;
	theme: Theme;
	colorBlindMode?: boolean;
}

type Measures = { count: number; duration: number; tokens: number };

/** One bar: a single day, or a run of days on long ranges. */
interface Bucket {
	days: string[];
	perProvider: Record<string, Measures>;
}

function dayDate(ymd: string): Date {
	return parseLocalYmd(ymd) ?? new Date();
}

function formatXAxisDate(ymd: string, timeRange: StatsTimeRange): string {
	const date = dayDate(ymd);
	switch (timeRange) {
		case 'week':
			return format(date, 'EEE');
		case 'year':
			return format(date, 'MMM');
		case 'all':
			return format(date, 'MMM yyyy');
		default:
			return format(date, 'MMM d');
	}
}

function formatBucketTitle(bucket: Bucket): string {
	const first = dayDate(bucket.days[0]);
	if (bucket.days.length === 1) return format(first, 'EEEE, MMM d, yyyy');
	const last = dayDate(bucket.days[bucket.days.length - 1]);
	return `${format(first, 'MMM d')} - ${format(last, 'MMM d, yyyy')}`;
}

/** One unit only, so tick labels stay narrow; a zero tick is bare "0". */
function formatYAxisDuration(ms: number): string {
	if (ms === 0) return '0';
	return humanizeDuration(ms, { units: DURATION_LADDER_HOURS, maxUnits: 1 });
}

function formatTooltipValue(mode: ChartMetricMode, value: number): string {
	if (mode === 'count') return `${formatNumber(value)} ${value === 1 ? 'query' : 'queries'}`;
	if (mode === 'tokens') return `${formatMetricValue('tokens', value)} tokens`;
	return formatMetricValue('duration', value);
}

export const ProviderTrendsChart = memo(function ProviderTrendsChart({
	data,
	timeRange,
	theme,
	colorBlindMode = false,
}: ProviderTrendsChartProps) {
	const { value: metricMode, setValue: setMetricMode } = usePersistedChoice(
		METRIC_STORAGE_KEY,
		METRIC_MODES,
		'count'
	);
	const [hovered, setHovered] = useState<number | null>(null);
	const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);
	const {
		series: tokenSeries,
		loading: tokensLoading,
		error: tokensError,
	} = useTokenSeries(metricMode === 'tokens');

	const { providers, providerColors, buckets } = useMemo(() => {
		const byAgentByDay = data.byAgentByDay ?? {};
		const tokensByAgentByDay = tokenSeries?.byAgentByDay ?? {};
		// The shared provider order (by query count) drives both the stacking
		// order and the color index, matching Provider Comparison.
		const ranked = rankProvidersByCount(data.byAgent);
		const extra = Object.keys(byAgentByDay).filter((p) => !ranked.includes(p));
		const ordered = [...ranked, ...extra];
		const colors: Record<string, string> = {};
		ordered.forEach((p, i) => {
			colors[p] = getSeriesColor(i, theme, colorBlindMode);
		});

		const perDay = new Map<string, Record<string, Measures>>();
		for (const p of ordered) {
			for (const row of byAgentByDay[p] ?? []) {
				const day = perDay.get(row.date) ?? {};
				day[p] = {
					count: row.count,
					duration: row.duration,
					tokens: tokensByAgentByDay[p]?.[row.date] ?? 0,
				};
				perDay.set(row.date, day);
			}
		}

		const days = data.window ? localDaysBetween(data.window.startYmd, data.window.endYmd) : [];
		const grouped = chunkIntoEqualGroups(days, MAX_BARS).map((group): Bucket => {
			const perProvider: Record<string, Measures> = {};
			for (const day of group) {
				for (const [p, m] of Object.entries(perDay.get(day) ?? {})) {
					const acc = (perProvider[p] ??= { count: 0, duration: 0, tokens: 0 });
					acc.count += m.count;
					acc.duration += m.duration;
					acc.tokens += m.tokens;
				}
			}
			return { days: group, perProvider };
		});

		return { providers: ordered, providerColors: colors, buckets: grouped };
	}, [data.byAgentByDay, data.byAgent, data.window, tokenSeries, theme, colorBlindMode]);

	const chartWidth = 600;
	const chartHeight = 220;
	const padding = { top: 10, right: 16, bottom: 32, left: 50 };
	const innerWidth = chartWidth - padding.left - padding.right;
	const innerHeight = chartHeight - padding.top - padding.bottom;

	const { yMax, yTicks, grandTotal } = useMemo(() => {
		let max = 0;
		let sum = 0;
		for (const bucket of buckets) {
			const total = providers.reduce(
				(acc, p) => acc + (bucket.perProvider[p]?.[metricMode] ?? 0),
				0
			);
			sum += total;
			if (total > max) max = total;
		}
		if (max === 0) return { yMax: 1, yTicks: [0], grandTotal: sum };
		// Counts and tokens are whole units; only duration keeps fractional ticks.
		const padded = metricMode === 'duration' ? max * 1.1 : Math.ceil(max * 1.1);
		const tickCount = 5;
		const ticks = Array.from({ length: tickCount }, (_, i) => (padded / (tickCount - 1)) * i);
		return {
			yMax: padded,
			yTicks: metricMode === 'duration' ? ticks : ticks.map((t) => Math.round(t)),
			grandTotal: sum,
		};
	}, [buckets, providers, metricMode]);

	const phone = usePhoneLayout();
	const xLabelIndices = useMemo(
		() => computeAxisLabelIndices(buckets.length, phone ? PHONE_AXIS_LABELS : undefined),
		[buckets.length, phone]
	);

	const barWidth = buckets.length > 0 ? innerWidth / buckets.length : 0;
	const barInner = Math.max(1, barWidth * 0.7);
	const barOffset = (barWidth - barInner) / 2;
	const yScale = (v: number) => padding.top + (1 - v / yMax) * innerHeight;
	const xForIndex = (i: number) => padding.left + i * barWidth;

	const handleMouseEnter = useCallback((idx: number, e: React.MouseEvent) => {
		setHovered(idx);
		setTooltipPos({ x: e.clientX, y: e.clientY });
	}, []);
	const handleMouseMove = useCallback((e: React.MouseEvent) => {
		setTooltipPos({ x: e.clientX, y: e.clientY });
	}, []);
	const handleMouseLeave = useCallback(() => {
		setHovered(null);
		setTooltipPos(null);
	}, []);

	const showTokenError = metricMode === 'tokens' && !tokensLoading && !!tokensError;
	const hoveredBucket = hovered !== null ? buckets[hovered] : undefined;
	const hoveredProviders = hoveredBucket
		? providers.filter((p) => (hoveredBucket.perProvider[p]?.[metricMode] ?? 0) > 0)
		: [];

	return (
		<div
			className="p-4 rounded-lg"
			style={{ backgroundColor: theme.colors.bgMain }}
			role="figure"
			aria-label={`Provider trends over time, stacked bar chart of ${metricModeNoun(metricMode)}. ${providers.length} providers across ${buckets.length} bars.`}
		>
			<div className="flex flex-wrap items-center justify-between gap-2 mb-4">
				<h3 className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
					Provider Trends Over Time
				</h3>
				<MetricModeToggle
					mode={metricMode}
					onChange={setMetricMode}
					theme={theme}
					labels={OVERVIEW_METRIC_LABELS}
					tokensLoading={tokensLoading}
				/>
			</div>

			<div className="relative">
				<ChartLoadingOverlay visible={tokensLoading} theme={theme} />
				{showTokenError ? (
					<div
						className="flex items-center justify-center text-sm text-center"
						style={{ height: chartHeight, color: theme.colors.error }}
						data-testid="provider-trends-token-error"
					>
						Could not load token usage: {tokensError}
					</div>
				) : grandTotal === 0 ? (
					<div
						className="flex items-center justify-center"
						style={{ height: chartHeight, color: theme.colors.textDim }}
					>
						<span className="text-sm">No queries in this range</span>
					</div>
				) : (
					<svg
						width="100%"
						viewBox={`0 0 ${chartWidth} ${chartHeight}`}
						preserveAspectRatio="xMidYMid meet"
						role="img"
						aria-label={`Stacked bar chart showing ${metricModeNoun(metricMode)} per provider per day`}
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
									{metricMode === 'duration'
										? formatYAxisDuration(t)
										: formatMetricValue(metricMode, t)}
								</text>
							</g>
						))}

						{buckets.map((bucket, idx) => {
							let cumulative = 0;
							const xCol = xForIndex(idx);
							const isOtherHovered = hovered !== null && hovered !== idx;
							return (
								<g
									key={`bar-${bucket.days[0]}`}
									onMouseEnter={(e) => handleMouseEnter(idx, e)}
									onMouseMove={handleMouseMove}
									onMouseLeave={handleMouseLeave}
									data-testid="provider-trend-bar"
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
										const v = bucket.perProvider[p]?.[metricMode] ?? 0;
										if (v <= 0) return null;
										const yTop = yScale(cumulative + v);
										cumulative += v;
										return (
											<rect
												key={p}
												x={xCol + barOffset}
												y={yTop}
												width={barInner}
												height={Math.max(0, (v / yMax) * innerHeight)}
												fill={providerColors[p]}
												opacity={isOtherHovered ? 0.45 : 0.9}
												style={{ transition: 'opacity 0.15s ease' }}
											/>
										);
									})}
								</g>
							);
						})}

						{buckets.map((bucket, idx) =>
							xLabelIndices.has(idx) ? (
								<text
									key={`x-${idx}`}
									x={xForIndex(idx) + barWidth / 2}
									y={chartHeight - padding.bottom + 18}
									textAnchor="middle"
									fontSize={10}
									fill={theme.colors.textDim}
								>
									{formatXAxisDate(bucket.days[0], timeRange)}
								</text>
							) : null
						)}
					</svg>
				)}

				{hoveredBucket && hoveredProviders.length > 0 && (
					<ChartTooltip
						anchor={tooltipPos}
						theme={theme}
						width={260}
						height={32 + hoveredProviders.length * 18}
					>
						<div className="font-medium mb-1">{formatBucketTitle(hoveredBucket)}</div>
						<div style={{ color: theme.colors.textDim }}>
							{hoveredProviders.map((p) => (
								<div key={p} className="flex items-center gap-2">
									<span
										className="w-2 h-2 rounded-sm"
										style={{ backgroundColor: providerColors[p] }}
									/>
									<span>{getAgentDisplayName(p)}:</span>
									<span style={{ color: theme.colors.textMain }}>
										{formatTooltipValue(metricMode, hoveredBucket.perProvider[p][metricMode])}
									</span>
								</div>
							))}
						</div>
					</ChartTooltip>
				)}
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
								{getAgentDisplayName(p)}
							</span>
						</div>
					))}
				</div>
			)}
		</div>
	);
});

export default ProviderTrendsChart;
