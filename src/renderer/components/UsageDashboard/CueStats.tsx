/**
 * CueStats
 *
 * Renders the "Cue" tab of the Usage Dashboard. Consumes
 * `window.maestro.cueStats.getAggregation()` and surfaces totals plus a set of
 * focused diagnostic panels: failure spotlight, time-series, hour-of-day,
 * trigger-type, pipeline, agent, and slowest-runs.
 *
 * The component is responsible only for read+display — gating lives in the
 * parent dashboard (tab is hidden when `encoreFeatures.maestroCue` is off)
 * and in the IPC handler (throws `'CueStatsDisabled'` when either Encore
 * flag is off, which we render as a friendly note as defense in depth).
 */

import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { AlertTriangle, CheckCircle2, Clock, Coins, TimerReset, XCircle, Zap } from 'lucide-react';
// AlertTriangle still used by `DisabledNote`; CoverageWarningsBanner was removed.
import type { Theme } from '../../types';
import type { StatsTimeRange } from '../../../shared/stats-types';
import type {
	CueChain,
	CueHourBucket,
	CueStatsAggregation,
	CueStatsByGroup,
	CueStatsTotals,
	CueTimeBucket,
} from '../../../shared/cue-stats-types';
import {
	formatCost,
	formatDurationHuman,
	formatNumber,
	formatTokensCompact,
} from '../../../shared/formatters';
import { getAgentDisplayName } from '../../../shared/agentMetadata';
import { COLORBLIND_AGENT_PALETTE } from '../../constants/colorblindPalettes';
import { logger } from '../../utils/logger';
import { captureException } from '../../utils/sentry';
import { ChartErrorBoundary } from './ChartErrorBoundary';
import { EmptyState } from './EmptyState';
import {
	AgentComparisonChartSkeleton,
	DurationTrendsChartSkeleton,
	SummaryCardsSkeleton,
} from './ChartSkeletons';
import { MetricCard } from './SummaryCards';

interface CueStatsProps {
	timeRange: StatsTimeRange;
	theme: Theme;
	colorBlindMode?: boolean;
}

function totalTokens(t: CueStatsTotals): number {
	return t.totalInputTokens + t.totalOutputTokens;
}

function successRate(t: CueStatsTotals): number {
	const tracked = t.successCount + t.failureCount;
	return tracked === 0 ? 0 : t.successCount / tracked;
}

function formatPercent(ratio: number): string {
	return `${Math.round(ratio * 100)}%`;
}

/* ----------------------------- Summary cards ----------------------------- */

const SUMMARY_SPARKLINE_LIMIT = 14;

/**
 * Right-aligned slice of the time-series buckets used to draw a 7–14 point
 * sparkline beneath each summary card. We pad with leading zeros if the range
 * has fewer buckets so geometry stays stable.
 */
function lastBucketCounts(buckets: CueTimeBucket[], pick: (b: CueTimeBucket) => number): number[] {
	const slice = buckets.slice(-SUMMARY_SPARKLINE_LIMIT).map(pick);
	if (slice.length >= SUMMARY_SPARKLINE_LIMIT) return slice;
	return [...new Array(SUMMARY_SPARKLINE_LIMIT - slice.length).fill(0), ...slice];
}

const SummaryCardsRow = memo(function SummaryCardsRow({
	totals,
	timeSeries,
	theme,
	hasTokenData,
}: {
	totals: CueStatsTotals;
	timeSeries: CueTimeBucket[];
	theme: Theme;
	/** When false, the Total Tokens card is hidden and the grid shrinks to 3 columns. */
	hasTokenData: boolean;
}) {
	const successPct = formatPercent(successRate(totals));
	const tokens = totalTokens(totals);

	const occurrenceSparkline = useMemo(
		() => lastBucketCounts(timeSeries, (b) => b.occurrences),
		[timeSeries]
	);
	const tokenSparkline = useMemo(
		() => lastBucketCounts(timeSeries, (b) => b.inputTokens + b.outputTokens),
		[timeSeries]
	);
	const successSparkline = useMemo(
		() =>
			lastBucketCounts(timeSeries, (b) => {
				const tracked = b.successCount + b.failureCount;
				return tracked === 0 ? 0 : Math.round((b.successCount / tracked) * 100);
			}),
		[timeSeries]
	);

	const sublabelStyle: React.CSSProperties = {
		fontSize: '10px',
		color: theme.colors.textDim,
		marginTop: 2,
	};

	const cardCount = hasTokenData ? 4 : 3;

	return (
		<div
			className="grid gap-4"
			style={{ gridTemplateColumns: `repeat(${cardCount}, minmax(0, 1fr))` }}
			data-testid="cue-stats-summary-cards"
		>
			<MetricCard
				theme={theme}
				icon={<Zap className="w-4 h-4" />}
				label="Occurrences"
				value={formatNumber(totals.occurrences)}
				animationIndex={0}
				sparklineData={occurrenceSparkline}
			/>
			<MetricCard
				theme={theme}
				icon={<CheckCircle2 className="w-4 h-4" />}
				label="Success Rate"
				value={successPct}
				animationIndex={1}
				sparklineData={successSparkline}
				sparklineColor={theme.colors.success}
				extra={
					<div style={sublabelStyle}>
						{formatNumber(totals.successCount)} ok / {formatNumber(totals.failureCount)} failed
					</div>
				}
			/>
			<MetricCard
				theme={theme}
				icon={<Clock className="w-4 h-4" />}
				label="Total Duration"
				value={formatDurationHuman(totals.totalDurationMs)}
				animationIndex={2}
			/>
			{hasTokenData && (
				<MetricCard
					theme={theme}
					icon={<Coins className="w-4 h-4" />}
					label="Total Tokens"
					value={formatTokensCompact(tokens)}
					animationIndex={3}
					sparklineData={tokenSparkline}
					extra={
						totals.totalCostUsd != null && totals.totalCostUsd > 0 ? (
							<div style={sublabelStyle}>{formatCost(totals.totalCostUsd)}</div>
						) : undefined
					}
				/>
			)}
		</div>
	);
});

/* ---------------------------- Time-series chart -------------------------- */

const TimeSeriesChart = memo(function TimeSeriesChart({
	buckets,
	bucketSizeMs,
	theme,
	colorBlindMode,
}: {
	buckets: CueTimeBucket[];
	bucketSizeMs: number;
	theme: Theme;
	colorBlindMode: boolean;
}) {
	const chartWidth = 600;
	const chartHeight = 220;
	const padding = { top: 20, right: 50, bottom: 40, left: 50 };
	const innerWidth = chartWidth - padding.left - padding.right;
	const innerHeight = chartHeight - padding.top - padding.bottom;

	const tokenColor = colorBlindMode ? COLORBLIND_AGENT_PALETTE[1] : theme.colors.accent;
	const barColor = colorBlindMode ? COLORBLIND_AGENT_PALETTE[0] : `${theme.colors.accent}80`;
	const successColor = theme.colors.success ?? '#22c55e';
	const failureColor = theme.colors.error ?? '#ef4444';

	const { maxOccurrences, maxTokens, occurrenceTicks, tokenTicks } = useMemo(() => {
		const occurrences = buckets.map((b) => b.occurrences);
		const tokens = buckets.map((b) => b.inputTokens + b.outputTokens);
		const maxOcc = Math.max(1, ...occurrences);
		const maxTok = Math.max(1, ...tokens);
		const tickCount = 5;
		const occTicks = Array.from({ length: tickCount }, (_, i) =>
			Math.round((maxOcc / (tickCount - 1)) * i)
		);
		const tokTicks = Array.from({ length: tickCount }, (_, i) => (maxTok / (tickCount - 1)) * i);
		return {
			maxOccurrences: maxOcc,
			maxTokens: maxTok,
			occurrenceTicks: occTicks,
			tokenTicks: tokTicks,
		};
	}, [buckets]);

	const xScale = useCallback(
		(idx: number) => padding.left + (idx + 0.5) * (innerWidth / Math.max(buckets.length, 1)),
		[buckets.length, innerWidth, padding.left]
	);
	const yScaleOcc = useCallback(
		(value: number) => chartHeight - padding.bottom - (value / maxOccurrences) * innerHeight,
		[chartHeight, innerHeight, maxOccurrences, padding.bottom]
	);
	const yScaleTokens = useCallback(
		(value: number) => chartHeight - padding.bottom - (value / maxTokens) * innerHeight,
		[chartHeight, innerHeight, maxTokens, padding.bottom]
	);

	const tokenLinePath = useMemo(() => {
		if (buckets.length === 0) return '';
		return buckets
			.map((b, idx) => {
				const x = xScale(idx);
				const y = yScaleTokens(b.inputTokens + b.outputTokens);
				return `${idx === 0 ? 'M' : 'L'} ${x} ${y}`;
			})
			.join(' ');
	}, [buckets, xScale, yScaleTokens]);

	const isHourly = bucketSizeMs <= 3_600_000;
	const labelFormat = isHourly ? 'MMM d HH:mm' : 'MMM d';

	const barWidth = Math.max(2, innerWidth / Math.max(buckets.length, 1) - 4);

	return (
		<div
			className="p-4 rounded-lg"
			style={{ backgroundColor: theme.colors.bgMain }}
			data-testid="cue-stats-timeseries"
			role="figure"
			aria-label={`Cue occurrences and tokens over time (${buckets.length} buckets).`}
		>
			<div className="flex items-center justify-between mb-3">
				<h3
					className="text-sm font-medium"
					style={{ color: theme.colors.textMain, animation: 'card-enter 0.4s ease both' }}
				>
					Occurrences & Tokens Over Time
				</h3>
				<div className="flex items-center gap-3 text-xs" style={{ color: theme.colors.textDim }}>
					<span className="flex items-center gap-1">
						<span
							className="inline-block w-3 h-3 rounded-sm"
							style={{ backgroundColor: barColor }}
						/>
						Occurrences
					</span>
					<span className="flex items-center gap-1">
						<span className="inline-block w-3 h-0.5" style={{ backgroundColor: tokenColor }} />
						Tokens
					</span>
				</div>
			</div>

			{buckets.length === 0 ? (
				<div
					className="flex items-center justify-center"
					style={{ height: chartHeight, color: theme.colors.textDim }}
				>
					<span className="text-sm">No buckets in this range</span>
				</div>
			) : (
				<svg
					width="100%"
					viewBox={`0 0 ${chartWidth} ${chartHeight}`}
					preserveAspectRatio="xMidYMid meet"
					role="img"
					aria-label="Occurrences bar chart with token count overlay"
				>
					{/* Horizontal grid lines (occurrence ticks) */}
					{occurrenceTicks.map((tick, idx) => (
						<line
							key={`grid-${idx}`}
							x1={padding.left}
							y1={yScaleOcc(tick)}
							x2={chartWidth - padding.right}
							y2={yScaleOcc(tick)}
							stroke={theme.colors.border}
							strokeOpacity={0.3}
							strokeDasharray="4,4"
						/>
					))}

					{/* Left Y-axis: occurrences */}
					{occurrenceTicks.map((tick, idx) => (
						<text
							key={`y-occ-${idx}`}
							x={padding.left - 8}
							y={yScaleOcc(tick)}
							textAnchor="end"
							dominantBaseline="middle"
							fontSize={10}
							fill={theme.colors.textDim}
						>
							{tick}
						</text>
					))}

					{/* Right Y-axis: tokens */}
					{tokenTicks.map((tick, idx) => (
						<text
							key={`y-tok-${idx}`}
							x={chartWidth - padding.right + 8}
							y={yScaleTokens(tick)}
							textAnchor="start"
							dominantBaseline="middle"
							fontSize={10}
							fill={theme.colors.textDim}
						>
							{formatTokensCompact(tick)}
						</text>
					))}

					{/* Bars */}
					{buckets.map((b, idx) => {
						const x = xScale(idx) - barWidth / 2;
						const y = yScaleOcc(b.occurrences);
						const height = chartHeight - padding.bottom - y;
						return (
							<g key={`bar-${b.bucketStartMs}`}>
								<rect
									x={x}
									y={y}
									width={barWidth}
									height={Math.max(0, height)}
									fill={barColor}
									opacity={0.85}
								>
									<title>
										{format(new Date(b.bucketStartMs), labelFormat)}: {b.occurrences} occurrences,{' '}
										{b.successCount} success / {b.failureCount} fail,{' '}
										{formatTokensCompact(b.inputTokens + b.outputTokens)} tokens
									</title>
								</rect>
								{b.failureCount > 0 && b.occurrences > 0 ? (
									<rect
										x={x}
										y={y}
										width={barWidth}
										height={Math.max(0, (height * b.failureCount) / Math.max(b.occurrences, 1))}
										fill={failureColor}
										opacity={0.55}
									/>
								) : null}
								{b.successCount > 0 && b.occurrences > 0 ? (
									<rect
										x={x}
										y={y + (height * b.failureCount) / Math.max(b.occurrences, 1)}
										width={barWidth}
										height={Math.max(0, (height * b.successCount) / Math.max(b.occurrences, 1))}
										fill={successColor}
										opacity={0.4}
									/>
								) : null}
							</g>
						);
					})}

					{/* X-axis labels (every Nth bucket) */}
					{buckets.map((b, idx) => {
						const interval =
							buckets.length > 14 ? Math.ceil(buckets.length / 7) : buckets.length > 7 ? 2 : 1;
						if (idx % interval !== 0 && idx !== buckets.length - 1) return null;
						return (
							<text
								key={`x-${b.bucketStartMs}`}
								x={xScale(idx)}
								y={chartHeight - padding.bottom + 18}
								textAnchor="middle"
								fontSize={10}
								fill={theme.colors.textDim}
							>
								{format(new Date(b.bucketStartMs), labelFormat)}
							</text>
						);
					})}

					{/* Token line */}
					<path
						d={tokenLinePath}
						fill="none"
						stroke={tokenColor}
						strokeWidth={2}
						strokeLinecap="round"
						strokeLinejoin="round"
					/>

					{/* Token markers */}
					{buckets.map((b, idx) => {
						const tokens = b.inputTokens + b.outputTokens;
						return (
							<circle
								key={`tok-${b.bucketStartMs}`}
								cx={xScale(idx)}
								cy={yScaleTokens(tokens)}
								r={3}
								fill={theme.colors.bgMain}
								stroke={tokenColor}
								strokeWidth={2}
							>
								<title>
									{format(new Date(b.bucketStartMs), labelFormat)}: {formatTokensCompact(tokens)}{' '}
									tokens
								</title>
							</circle>
						);
					})}
				</svg>
			)}
		</div>
	);
});

/* ----------------------------- Group tables ------------------------------ */

type GroupSortKey = 'occurrences' | 'success' | 'avgDuration' | 'tokens' | 'cost';

interface GroupTableProps {
	title: string;
	rows: CueStatsByGroup[];
	theme: Theme;
	testId: string;
	keyLabel: string;
	formatLabel?: (label: string, key: string) => string;
	/** When true, the Total Tokens / Total Cost columns are dropped from the
	 *  table — used when the active range has no token data so we don't
	 *  render columns of zeros and dashes. */
	hideTokenColumns?: boolean;
}

const GroupTable = memo(function GroupTable({
	title,
	rows,
	theme,
	testId,
	keyLabel,
	formatLabel,
	hideTokenColumns = false,
}: GroupTableProps) {
	const [sortKey, setSortKey] = useState<GroupSortKey>('occurrences');
	const [sortDesc, setSortDesc] = useState(true);

	const sorted = useMemo(() => {
		const copy = [...rows];
		copy.sort((a, b) => {
			const aTokens = totalTokens(a.totals);
			const bTokens = totalTokens(b.totals);
			const aAvg = a.totals.occurrences > 0 ? a.totals.totalDurationMs / a.totals.occurrences : 0;
			const bAvg = b.totals.occurrences > 0 ? b.totals.totalDurationMs / b.totals.occurrences : 0;
			let diff = 0;
			switch (sortKey) {
				case 'occurrences':
					diff = a.totals.occurrences - b.totals.occurrences;
					break;
				case 'success':
					diff = successRate(a.totals) - successRate(b.totals);
					break;
				case 'avgDuration':
					diff = aAvg - bAvg;
					break;
				case 'tokens':
					diff = aTokens - bTokens;
					break;
				case 'cost':
					diff = (a.totals.totalCostUsd ?? 0) - (b.totals.totalCostUsd ?? 0);
					break;
			}
			return sortDesc ? -diff : diff;
		});
		return copy;
	}, [rows, sortKey, sortDesc]);

	const setSort = (key: GroupSortKey) => {
		if (key === sortKey) setSortDesc((prev) => !prev);
		else {
			setSortKey(key);
			setSortDesc(true);
		}
	};

	const headerStyle = {
		color: theme.colors.textDim,
		borderColor: theme.colors.border,
	};

	const sortIndicator = (key: GroupSortKey) => (sortKey === key ? (sortDesc ? ' ▼' : ' ▲') : '');

	return (
		<div
			className="p-4 rounded-lg"
			style={{ backgroundColor: theme.colors.bgMain }}
			data-testid={testId}
			role="region"
			aria-label={title}
		>
			<h3
				className="text-sm font-medium mb-3"
				style={{ color: theme.colors.textMain, animation: 'card-enter 0.4s ease both' }}
			>
				{title}
			</h3>
			{rows.length === 0 ? (
				<div className="text-sm py-4" style={{ color: theme.colors.textDim }}>
					No data.
				</div>
			) : (
				<div className="overflow-x-auto">
					<table
						className="w-full text-sm"
						style={{ borderCollapse: 'separate', borderSpacing: 0 }}
					>
						<thead>
							<tr>
								<th
									className="text-left text-xs font-medium uppercase tracking-wider px-3 py-2 border-b"
									style={headerStyle}
								>
									{keyLabel}
								</th>
								{(
									[
										['occurrences', 'Occurrences'],
										['success', 'Success Rate'],
										['avgDuration', 'Avg Duration'],
										['tokens', 'Total Tokens'],
										['cost', 'Total Cost'],
									] as Array<[GroupSortKey, string]>
								)
									.filter(([key]) => (hideTokenColumns ? key !== 'tokens' && key !== 'cost' : true))
									.map(([key, label]) => (
										<th
											key={key}
											className="text-left text-xs font-medium uppercase tracking-wider px-3 py-2 border-b cursor-pointer select-none"
											style={headerStyle}
											onClick={() => setSort(key)}
											role="button"
											aria-sort={sortKey === key ? (sortDesc ? 'descending' : 'ascending') : 'none'}
										>
											{label}
											{sortIndicator(key)}
										</th>
									))}
							</tr>
						</thead>
						<tbody>
							{sorted.map((row, idx) => {
								const tokens = totalTokens(row.totals);
								const avg =
									row.totals.occurrences > 0
										? row.totals.totalDurationMs / row.totals.occurrences
										: 0;
								return (
									<tr
										key={row.key}
										style={{
											backgroundColor: idx % 2 === 0 ? 'transparent' : `${theme.colors.border}10`,
										}}
									>
										<td className="px-3 py-2" style={{ color: theme.colors.textMain }}>
											{formatLabel ? formatLabel(row.label, row.key) : row.label}
										</td>
										<td className="px-3 py-2 font-mono" style={{ color: theme.colors.textMain }}>
											{formatNumber(row.totals.occurrences)}
										</td>
										<td className="px-3 py-2 font-mono" style={{ color: theme.colors.textDim }}>
											{formatPercent(successRate(row.totals))}
										</td>
										<td className="px-3 py-2 font-mono" style={{ color: theme.colors.textDim }}>
											{formatDurationHuman(avg)}
										</td>
										{!hideTokenColumns && (
											<>
												<td className="px-3 py-2 font-mono" style={{ color: theme.colors.textDim }}>
													{formatTokensCompact(tokens)}
												</td>
												<td className="px-3 py-2 font-mono" style={{ color: theme.colors.textDim }}>
													{row.totals.totalCostUsd != null
														? formatCost(row.totals.totalCostUsd)
														: '—'}
												</td>
											</>
										)}
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
});

/* ------------------------------ Agent chart ------------------------------ */

const AgentTokensChart = memo(function AgentTokensChart({
	rows,
	theme,
	colorBlindMode,
}: {
	rows: CueStatsByGroup[];
	theme: Theme;
	colorBlindMode: boolean;
}) {
	const sorted = useMemo(() => {
		return [...rows].sort((a, b) => totalTokens(b.totals) - totalTokens(a.totals));
	}, [rows]);

	const max = useMemo(() => {
		if (sorted.length === 0) return 1;
		return Math.max(1, ...sorted.map((r) => totalTokens(r.totals)));
	}, [sorted]);

	const colorFor = useCallback(
		(idx: number) =>
			colorBlindMode
				? COLORBLIND_AGENT_PALETTE[idx % COLORBLIND_AGENT_PALETTE.length]
				: theme.colors.accent,
		[colorBlindMode, theme.colors.accent]
	);

	return (
		<div
			className="p-4 rounded-lg"
			style={{ backgroundColor: theme.colors.bgMain }}
			data-testid="cue-stats-agent-chart"
			role="figure"
			aria-label="Total tokens by agent"
		>
			<h3
				className="text-sm font-medium mb-3"
				style={{ color: theme.colors.textMain, animation: 'card-enter 0.4s ease both' }}
			>
				Tokens by Agent
			</h3>
			{sorted.length === 0 ? (
				<div className="text-sm py-4" style={{ color: theme.colors.textDim }}>
					No agent data.
				</div>
			) : (
				<div className="space-y-2">
					{sorted.map((row, idx) => {
						const tokens = totalTokens(row.totals);
						const widthPct = (tokens / max) * 100;
						return (
							<div key={row.key} className="flex items-center gap-3" style={{ height: 28 }}>
								<div
									className="text-xs truncate"
									style={{ width: 140, color: theme.colors.textDim }}
									title={row.label}
								>
									{getAgentDisplayName(row.key)}
								</div>
								<div className="flex-1 relative" style={{ height: 20 }}>
									<div
										className="absolute inset-y-0 left-0 rounded"
										style={{ width: `${widthPct}%`, backgroundColor: colorFor(idx) }}
									/>
								</div>
								<div
									className="text-xs font-mono"
									style={{ width: 64, textAlign: 'right', color: theme.colors.textMain }}
								>
									{formatTokensCompact(tokens)}
								</div>
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
});

/* ---------------------------- Failure spotlight -------------------------- */

/**
 * Friendly summary of any subscription that failed at least once in the
 * window. Always renders — when nothing failed, shows a small "all clean"
 * affirmation instead, so the section is discoverable.
 *
 * We deliberately render this as a focused list rather than reusing
 * `GroupTable`. The full subscription table was previously dropped because
 * its content was redundant; this panel exists specifically to surface
 * actionable failures and stays out of the way the rest of the time.
 */
const FailureSpotlight = memo(function FailureSpotlight({
	rows,
	theme,
}: {
	rows: CueStatsByGroup[];
	theme: Theme;
}) {
	const failing = useMemo(() => {
		return rows
			.filter((r) => r.totals.failureCount > 0)
			.sort((a, b) => {
				if (b.totals.failureCount !== a.totals.failureCount) {
					return b.totals.failureCount - a.totals.failureCount;
				}
				// Tie-break with worst success rate, so two subs with the same
				// failure count surface the most-broken one first.
				return successRate(a.totals) - successRate(b.totals);
			});
	}, [rows]);

	const headerStyle: React.CSSProperties = {
		color: theme.colors.textDim,
		borderColor: theme.colors.border,
	};

	return (
		<div
			className="p-4 rounded-lg"
			style={{ backgroundColor: theme.colors.bgMain }}
			data-testid="cue-stats-failure-spotlight"
			role="region"
			aria-label="Cue subscriptions that failed in the selected window"
		>
			<div className="flex items-center gap-2 mb-3">
				{failing.length === 0 ? (
					<CheckCircle2 className="w-4 h-4" style={{ color: theme.colors.success }} />
				) : (
					<AlertTriangle className="w-4 h-4" style={{ color: theme.colors.warning }} />
				)}
				<h3
					className="text-sm font-medium"
					style={{ color: theme.colors.textMain, animation: 'card-enter 0.4s ease both' }}
				>
					{failing.length === 0 ? 'No failures' : 'Needs attention'}
				</h3>
			</div>

			{failing.length === 0 ? (
				<div className="text-sm py-2" style={{ color: theme.colors.textDim }}>
					All Cue runs in this range completed successfully.
				</div>
			) : (
				<div className="overflow-x-auto">
					<table
						className="w-full text-sm"
						style={{ borderCollapse: 'separate', borderSpacing: 0 }}
					>
						<thead>
							<tr>
								<th
									className="text-left text-xs font-medium uppercase tracking-wider px-3 py-2 border-b"
									style={headerStyle}
								>
									Subscription
								</th>
								<th
									className="text-left text-xs font-medium uppercase tracking-wider px-3 py-2 border-b"
									style={headerStyle}
								>
									Failures
								</th>
								<th
									className="text-left text-xs font-medium uppercase tracking-wider px-3 py-2 border-b"
									style={headerStyle}
								>
									Success Rate
								</th>
								<th
									className="text-left text-xs font-medium uppercase tracking-wider px-3 py-2 border-b"
									style={headerStyle}
								>
									Runs
								</th>
								<th
									className="text-left text-xs font-medium uppercase tracking-wider px-3 py-2 border-b"
									style={headerStyle}
								>
									Avg Duration
								</th>
							</tr>
						</thead>
						<tbody>
							{failing.map((row, idx) => {
								const avg =
									row.totals.occurrences > 0
										? row.totals.totalDurationMs / row.totals.occurrences
										: 0;
								return (
									<tr
										key={row.key}
										data-testid="cue-stats-failure-row"
										style={{
											backgroundColor: idx % 2 === 0 ? 'transparent' : `${theme.colors.border}10`,
										}}
									>
										<td className="px-3 py-2" style={{ color: theme.colors.textMain }}>
											{row.label}
										</td>
										<td
											className="px-3 py-2 font-mono font-semibold"
											style={{ color: theme.colors.error }}
										>
											{formatNumber(row.totals.failureCount)}
										</td>
										<td className="px-3 py-2 font-mono" style={{ color: theme.colors.textDim }}>
											{formatPercent(successRate(row.totals))}
										</td>
										<td className="px-3 py-2 font-mono" style={{ color: theme.colors.textDim }}>
											{formatNumber(row.totals.occurrences)}
										</td>
										<td className="px-3 py-2 font-mono" style={{ color: theme.colors.textDim }}>
											{formatDurationHuman(avg)}
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
});

/* ---------------------------- Slowest runs ------------------------------- */

const SLOWEST_RUNS_LIMIT = 10;

interface SlowRun {
	eventId: string;
	subscriptionName: string;
	agentType: string | null;
	startedAtMs: number;
	durationMs: number;
	tokens: number;
}

function collectSlowestRuns(chains: CueChain[], limit: number): SlowRun[] {
	const flat: SlowRun[] = [];
	for (const chain of chains) {
		for (const node of chain.nodes) {
			if (node.durationMs == null) continue;
			flat.push({
				eventId: node.eventId,
				subscriptionName: node.subscriptionName,
				agentType: node.agentType,
				startedAtMs: node.startedAtMs,
				durationMs: node.durationMs,
				tokens: node.inputTokens + node.outputTokens,
			});
		}
	}
	flat.sort((a, b) => b.durationMs - a.durationMs);
	return flat.slice(0, limit);
}

/**
 * Top-N individual chain runs ordered by duration, regardless of which
 * pipeline or chain they came from. Replaces the per-chain tree (dropped)
 * with a flat ranked view that answers "what's slow?" in one glance.
 */
const SlowestRunsTable = memo(function SlowestRunsTable({
	chains,
	theme,
}: {
	chains: CueChain[];
	theme: Theme;
}) {
	const rows = useMemo(() => collectSlowestRuns(chains, SLOWEST_RUNS_LIMIT), [chains]);

	const headerStyle: React.CSSProperties = {
		color: theme.colors.textDim,
		borderColor: theme.colors.border,
	};

	return (
		<div
			className="p-4 rounded-lg"
			style={{ backgroundColor: theme.colors.bgMain }}
			data-testid="cue-stats-slowest-runs"
			role="region"
			aria-label="Slowest Cue runs in the selected window"
		>
			<div className="flex items-center gap-2 mb-3">
				<TimerReset className="w-4 h-4" style={{ color: theme.colors.accent }} />
				<h3
					className="text-sm font-medium"
					style={{ color: theme.colors.textMain, animation: 'card-enter 0.4s ease both' }}
				>
					Slowest Runs
				</h3>
			</div>

			{rows.length === 0 ? (
				<div className="text-sm py-2" style={{ color: theme.colors.textDim }}>
					No completed runs in this range.
				</div>
			) : (
				<div className="overflow-x-auto">
					<table
						className="w-full text-sm"
						style={{ borderCollapse: 'separate', borderSpacing: 0 }}
					>
						<thead>
							<tr>
								<th
									className="text-left text-xs font-medium uppercase tracking-wider px-3 py-2 border-b"
									style={headerStyle}
								>
									Subscription
								</th>
								<th
									className="text-left text-xs font-medium uppercase tracking-wider px-3 py-2 border-b"
									style={headerStyle}
								>
									Agent
								</th>
								<th
									className="text-left text-xs font-medium uppercase tracking-wider px-3 py-2 border-b"
									style={headerStyle}
								>
									Started
								</th>
								<th
									className="text-left text-xs font-medium uppercase tracking-wider px-3 py-2 border-b"
									style={headerStyle}
								>
									Duration
								</th>
								<th
									className="text-left text-xs font-medium uppercase tracking-wider px-3 py-2 border-b"
									style={headerStyle}
								>
									Tokens
								</th>
							</tr>
						</thead>
						<tbody>
							{rows.map((row, idx) => (
								<tr
									key={row.eventId}
									data-testid="cue-stats-slow-run"
									style={{
										backgroundColor: idx % 2 === 0 ? 'transparent' : `${theme.colors.border}10`,
									}}
								>
									<td className="px-3 py-2" style={{ color: theme.colors.textMain }}>
										{row.subscriptionName}
									</td>
									<td className="px-3 py-2" style={{ color: theme.colors.textDim }}>
										{row.agentType ? getAgentDisplayName(row.agentType) : '—'}
									</td>
									<td className="px-3 py-2 font-mono" style={{ color: theme.colors.textDim }}>
										{format(new Date(row.startedAtMs), 'MMM d HH:mm')}
									</td>
									<td
										className="px-3 py-2 font-mono font-semibold"
										style={{ color: theme.colors.textMain }}
									>
										{formatDurationHuman(row.durationMs)}
									</td>
									<td className="px-3 py-2 font-mono" style={{ color: theme.colors.textDim }}>
										{formatTokensCompact(row.tokens)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
});

/* ---------------------------- Trigger types ------------------------------ */

/**
 * Horizontal bar chart of occurrences by trigger type. Tells the user how
 * Cue is actually being used (file watches vs scheduled vs PR polls etc).
 */
const TriggerTypeChart = memo(function TriggerTypeChart({
	rows,
	theme,
	colorBlindMode,
}: {
	rows: CueStatsByGroup[];
	theme: Theme;
	colorBlindMode: boolean;
}) {
	const sorted = useMemo(() => {
		return [...rows].sort((a, b) => b.totals.occurrences - a.totals.occurrences);
	}, [rows]);

	const total = useMemo(() => sorted.reduce((sum, r) => sum + r.totals.occurrences, 0), [sorted]);

	const max = useMemo(() => {
		if (sorted.length === 0) return 1;
		return Math.max(1, ...sorted.map((r) => r.totals.occurrences));
	}, [sorted]);

	const colorFor = useCallback(
		(idx: number) =>
			colorBlindMode
				? COLORBLIND_AGENT_PALETTE[idx % COLORBLIND_AGENT_PALETTE.length]
				: theme.colors.accent,
		[colorBlindMode, theme.colors.accent]
	);

	return (
		<div
			className="p-4 rounded-lg"
			style={{ backgroundColor: theme.colors.bgMain }}
			data-testid="cue-stats-trigger-types"
			role="figure"
			aria-label="Occurrences by Cue trigger type"
		>
			<h3
				className="text-sm font-medium mb-3"
				style={{ color: theme.colors.textMain, animation: 'card-enter 0.4s ease both' }}
			>
				By Trigger Type
			</h3>
			{sorted.length === 0 ? (
				<div className="text-sm py-2" style={{ color: theme.colors.textDim }}>
					No trigger data in this range.
				</div>
			) : (
				<div className="space-y-2">
					{sorted.map((row, idx) => {
						const occ = row.totals.occurrences;
						const widthPct = (occ / max) * 100;
						const sharePct = total > 0 ? Math.round((occ / total) * 100) : 0;
						return (
							<div
								key={row.key}
								className="flex items-center gap-3"
								style={{ height: 28 }}
								data-testid="cue-stats-trigger-row"
							>
								<div
									className="text-xs truncate"
									style={{ width: 140, color: theme.colors.textDim }}
									title={row.label}
								>
									{row.label}
								</div>
								<div className="flex-1 relative" style={{ height: 20 }}>
									<div
										className="absolute inset-y-0 left-0 rounded"
										style={{ width: `${widthPct}%`, backgroundColor: colorFor(idx) }}
									/>
								</div>
								<div
									className="text-xs font-mono"
									style={{ width: 80, textAlign: 'right', color: theme.colors.textMain }}
								>
									{formatNumber(occ)}
									<span className="ml-1" style={{ color: theme.colors.textDim }}>
										({sharePct}%)
									</span>
								</div>
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
});

/* ---------------------------- Hour-of-day chart -------------------------- */

const HOUR_LABEL_INTERVAL = 3; // 0, 3, 6, … 21 — keeps the strip readable.

/**
 * 24-bar histogram showing when Cue runs in the local day. Helps the user
 * spot under-used windows when planning new schedules. Bars are colored by
 * the warning palette when the bucket has any failures, so a hot-spot of
 * trouble at 3am is visible without expanding a tooltip.
 */
const HourOfDayChart = memo(function HourOfDayChart({
	buckets,
	theme,
	colorBlindMode,
}: {
	buckets: CueHourBucket[];
	theme: Theme;
	colorBlindMode: boolean;
}) {
	const chartWidth = 600;
	const chartHeight = 160;
	const padding = { top: 16, right: 12, bottom: 28, left: 36 };
	const innerWidth = chartWidth - padding.left - padding.right;
	const innerHeight = chartHeight - padding.top - padding.bottom;

	const max = useMemo(() => {
		const values = buckets.map((b) => b.occurrences);
		return Math.max(1, ...values);
	}, [buckets]);

	const tickCount = 4;
	const yTicks = useMemo(() => {
		const step = Math.max(1, Math.ceil(max / (tickCount - 1)));
		return Array.from({ length: tickCount }, (_, i) => i * step);
	}, [max]);

	const yMax = yTicks[yTicks.length - 1] || 1;

	const yScale = useCallback(
		(value: number) => chartHeight - padding.bottom - (value / yMax) * innerHeight,
		[chartHeight, innerHeight, padding.bottom, yMax]
	);

	const slotWidth = innerWidth / 24;
	const barWidth = Math.max(2, slotWidth - 4);

	const baseColor = colorBlindMode ? COLORBLIND_AGENT_PALETTE[0] : theme.colors.accent;
	const failureColor = theme.colors.warning ?? theme.colors.error;

	const currentHour = useMemo(() => new Date().getHours(), []);
	const hasAnyData = useMemo(() => buckets.some((b) => b.occurrences > 0), [buckets]);

	return (
		<div
			className="p-4 rounded-lg"
			style={{ backgroundColor: theme.colors.bgMain }}
			data-testid="cue-stats-hour-of-day"
			role="figure"
			aria-label="Cue occurrences by hour of day in local time"
		>
			<div className="flex items-center justify-between mb-3">
				<h3
					className="text-sm font-medium"
					style={{ color: theme.colors.textMain, animation: 'card-enter 0.4s ease both' }}
				>
					By Hour of Day
				</h3>
				<span className="text-xs" style={{ color: theme.colors.textDim }}>
					Local time
				</span>
			</div>
			{!hasAnyData ? (
				<div className="text-sm py-2" style={{ color: theme.colors.textDim }}>
					No occurrences in this range.
				</div>
			) : (
				<svg
					width="100%"
					viewBox={`0 0 ${chartWidth} ${chartHeight}`}
					preserveAspectRatio="xMidYMid meet"
					role="img"
					aria-label="24-hour distribution of Cue occurrences"
				>
					{/* Y grid lines + labels */}
					{yTicks.map((tick, idx) => (
						<g key={`y-${idx}`}>
							<line
								x1={padding.left}
								y1={yScale(tick)}
								x2={chartWidth - padding.right}
								y2={yScale(tick)}
								stroke={theme.colors.border}
								strokeOpacity={0.3}
								strokeDasharray="4,4"
							/>
							<text
								x={padding.left - 8}
								y={yScale(tick)}
								textAnchor="end"
								dominantBaseline="middle"
								fontSize={10}
								fill={theme.colors.textDim}
							>
								{tick}
							</text>
						</g>
					))}

					{/* Bars */}
					{buckets.map((bucket) => {
						const cx = padding.left + slotWidth * bucket.hour + slotWidth / 2;
						const x = cx - barWidth / 2;
						const y = yScale(bucket.occurrences);
						const height = chartHeight - padding.bottom - y;
						const fill = bucket.failureCount > 0 ? failureColor : baseColor;
						const isCurrent = bucket.hour === currentHour;
						return (
							<g key={`hour-${bucket.hour}`}>
								<rect
									x={x}
									y={y}
									width={barWidth}
									height={Math.max(0, height)}
									fill={fill}
									opacity={bucket.occurrences === 0 ? 0.15 : 0.85}
									rx={2}
									data-testid="cue-stats-hour-bar"
									data-hour={bucket.hour}
								>
									<title>
										{`${String(bucket.hour).padStart(2, '0')}:00 — ${formatNumber(
											bucket.occurrences
										)} ${bucket.occurrences === 1 ? 'run' : 'runs'}${
											bucket.failureCount > 0 ? `, ${bucket.failureCount} failed` : ''
										}`}
									</title>
								</rect>
								{isCurrent && (
									<line
										x1={cx}
										x2={cx}
										y1={padding.top - 4}
										y2={chartHeight - padding.bottom}
										stroke={theme.colors.accent}
										strokeOpacity={0.6}
										strokeDasharray="2,2"
									/>
								)}
							</g>
						);
					})}

					{/* X-axis labels every HOUR_LABEL_INTERVAL hours */}
					{buckets.map((bucket) => {
						if (bucket.hour % HOUR_LABEL_INTERVAL !== 0) return null;
						const cx = padding.left + slotWidth * bucket.hour + slotWidth / 2;
						return (
							<text
								key={`x-${bucket.hour}`}
								x={cx}
								y={chartHeight - padding.bottom + 16}
								textAnchor="middle"
								fontSize={10}
								fill={theme.colors.textDim}
							>
								{String(bucket.hour).padStart(2, '0')}
							</text>
						);
					})}
				</svg>
			)}
		</div>
	);
});

/* -------------------------------- Skeleton ------------------------------- */

const CueStatsSkeleton = memo(function CueStatsSkeleton({ theme }: { theme: Theme }) {
	return (
		<div className="space-y-6" data-testid="cue-stats-skeleton">
			<SummaryCardsSkeleton theme={theme} columns={4} />
			<DurationTrendsChartSkeleton theme={theme} />
			<AgentComparisonChartSkeleton theme={theme} />
		</div>
	);
});

/* ---------------------------- Disabled / error --------------------------- */

const DisabledNote = memo(function DisabledNote({ theme }: { theme: Theme }) {
	return (
		<div
			className="p-6 rounded-lg flex flex-col items-center justify-center gap-3 text-center"
			style={{ backgroundColor: theme.colors.bgMain }}
			data-testid="cue-stats-disabled"
		>
			<AlertTriangle className="w-6 h-6" style={{ color: theme.colors.warning }} />
			<div className="text-sm" style={{ color: theme.colors.textMain }}>
				Cue stats are unavailable.
			</div>
			<div className="text-xs" style={{ color: theme.colors.textDim, maxWidth: 420 }}>
				Both <strong>Maestro Cue</strong> and <strong>Usage Dashboard</strong> Encore features must
				be enabled to view Cue analytics. Open Settings → Encore Features to turn them on.
			</div>
		</div>
	);
});

const ErrorNote = memo(function ErrorNote({
	theme,
	message,
	onRetry,
}: {
	theme: Theme;
	message: string;
	onRetry: () => void;
}) {
	return (
		<div
			className="p-6 rounded-lg flex flex-col items-center justify-center gap-3 text-center"
			style={{ backgroundColor: theme.colors.bgMain }}
			data-testid="cue-stats-error"
		>
			<XCircle className="w-6 h-6" style={{ color: theme.colors.error }} />
			<div className="text-sm" style={{ color: theme.colors.textMain }}>
				Failed to load Cue stats
			</div>
			<div className="text-xs" style={{ color: theme.colors.textDim, maxWidth: 420 }}>
				{message}
			</div>
			<button
				type="button"
				onClick={onRetry}
				className="px-4 py-1.5 rounded text-sm"
				style={{ backgroundColor: theme.colors.accent, color: theme.colors.bgMain }}
			>
				Retry
			</button>
		</div>
	);
});

/* -------------------------------- Component ------------------------------ */

export const CueStats = memo(function CueStats({
	timeRange,
	theme,
	colorBlindMode = false,
}: CueStatsProps) {
	const [aggregation, setAggregation] = useState<CueStatsAggregation | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const fetchAggregation = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const result = await window.maestro.cueStats.getAggregation(timeRange);
			setAggregation(result);
		} catch (err) {
			// Preload normalizes the disabled sentinel to a bare 'CueStatsDisabled'
			// message (Electron otherwise wraps thrown errors). Substring check
			// remains as defense-in-depth in case the bridge changes.
			const rawMessage = err instanceof Error ? err.message : String(err);
			const isDisabled = rawMessage.includes('CueStatsDisabled');
			if (!isDisabled) {
				logger.error('Failed to fetch Cue stats:', undefined, err);
				captureException(err, { extra: { timeRange } });
			}
			setError(isDisabled ? 'CueStatsDisabled' : rawMessage);
			setAggregation(null);
		} finally {
			setLoading(false);
		}
	}, [timeRange]);

	useEffect(() => {
		fetchAggregation();
	}, [fetchAggregation]);

	if (loading && !aggregation) {
		return <CueStatsSkeleton theme={theme} />;
	}

	if (error) {
		if (error === 'CueStatsDisabled') {
			return <DisabledNote theme={theme} />;
		}
		return <ErrorNote theme={theme} message={error} onRetry={fetchAggregation} />;
	}

	if (!aggregation || aggregation.totals.occurrences === 0) {
		return (
			<EmptyState
				theme={theme}
				title="No Cue activity"
				message="No Cue runs in this time range. Trigger a subscription to populate stats."
			/>
		);
	}

	// Token sections are noise when no agent in the active range emitted any
	// tokens (typical when none of the running agents have a tokens accessor
	// or before the Cue token pipeline has data). Hide both the agent-tokens
	// chart and the token columns/totals rather than showing 0s everywhere.
	const totalTokensSeen =
		aggregation.totals.totalInputTokens + aggregation.totals.totalOutputTokens;
	const hasTokenData = totalTokensSeen > 0;

	return (
		<div className="space-y-6" data-testid="cue-stats">
			<ChartErrorBoundary theme={theme} chartName="Cue Summary">
				<SummaryCardsRow
					totals={aggregation.totals}
					timeSeries={aggregation.timeSeries}
					theme={theme}
					hasTokenData={hasTokenData}
				/>
			</ChartErrorBoundary>

			<ChartErrorBoundary theme={theme} chartName="Cue Failure Spotlight">
				<FailureSpotlight rows={aggregation.bySubscription} theme={theme} />
			</ChartErrorBoundary>

			<ChartErrorBoundary theme={theme} chartName="Cue Time Series">
				<TimeSeriesChart
					buckets={aggregation.timeSeries}
					bucketSizeMs={aggregation.bucketSizeMs}
					theme={theme}
					colorBlindMode={colorBlindMode}
				/>
			</ChartErrorBoundary>

			<ChartErrorBoundary theme={theme} chartName="Cue Hour of Day">
				<HourOfDayChart
					buckets={aggregation.byHourOfDay}
					theme={theme}
					colorBlindMode={colorBlindMode}
				/>
			</ChartErrorBoundary>

			<ChartErrorBoundary theme={theme} chartName="Cue Trigger Types">
				<TriggerTypeChart
					rows={aggregation.byTriggerType}
					theme={theme}
					colorBlindMode={colorBlindMode}
				/>
			</ChartErrorBoundary>

			<ChartErrorBoundary theme={theme} chartName="Cue By Pipeline">
				<GroupTable
					title="By Pipeline"
					rows={aggregation.byPipeline}
					theme={theme}
					testId="cue-stats-pipeline-table"
					keyLabel="Pipeline"
					hideTokenColumns={!hasTokenData}
				/>
			</ChartErrorBoundary>

			{hasTokenData && (
				<ChartErrorBoundary theme={theme} chartName="Cue By Agent">
					<AgentTokensChart
						rows={aggregation.byAgent}
						theme={theme}
						colorBlindMode={colorBlindMode}
					/>
				</ChartErrorBoundary>
			)}

			<ChartErrorBoundary theme={theme} chartName="Cue Slowest Runs">
				<SlowestRunsTable chains={aggregation.chains} theme={theme} />
			</ChartErrorBoundary>
		</div>
	);
});

export default CueStats;
