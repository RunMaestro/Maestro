/**
 * TokenSpeedStats - the Tokens tab's speed section: how fast tokens moved, over
 * time, per provider, per model, and by hour of day.
 *
 * Every chart here reads ONE metric at a time (output, input, or total) chosen
 * from the section's toggle. Input runs two to three orders of magnitude above
 * output (it counts cache reads), so plotting them on one axis would flatten
 * output into the baseline, which is the number most people came to read.
 *
 * Averages are token-weighted and peaks are the fastest model-hour with at least
 * `TOKEN_SPEED_PEAK_MIN_BUCKET_MS` of call time; see `shared/tokenSpeed.ts` for why.
 */

import { memo, useMemo, useState } from 'react';
import { format } from 'date-fns';
import type { Theme } from '../../types';
import {
	TOKEN_SPEED_PEAK_MIN_BUCKET_MS,
	type TokenSpeedGranularity,
	type TokenSpeedGroup,
	type TokenSpeedPoint,
	type TokenSpeedStats as SpeedStats,
	type TokenSpeedSummary,
} from '../../../shared/tokenSpeed';
import { formatNumber, formatTokensPerSecond } from '../../../shared/formatters';
import { getAgentDisplayName } from '../../../shared/agentMetadata';
import { MultiLineChart, type LineSeries } from '../widgets';
import { SegmentedControl } from '../ui/SegmentedControl';
import { SortableTh } from '../ui/SortableTh';
import { useTableSort } from '../../hooks/ui/useTableSort';
import { usePersistedChoice } from '../../hooks/ui/usePersistedChoice';
import { ChartErrorBoundary } from './ChartErrorBoundary';
import { ChartTooltip } from './ChartTooltip';
import { TokenSpeedCards } from './TokenSpeedCards';
import { getSeriesColor } from './chartUtils';

type SpeedMetric = 'output' | 'input' | 'total';

const METRIC_OPTIONS: ReadonlyArray<{ value: SpeedMetric; label: string }> = [
	{ value: 'output', label: 'Output' },
	{ value: 'input', label: 'Input' },
	{ value: 'total', label: 'Total' },
];
const METRIC_VALUES = METRIC_OPTIONS.map((o) => o.value);

function avgOf(stats: SpeedStats, metric: SpeedMetric): number {
	return metric === 'output'
		? stats.avgOutputTps
		: metric === 'input'
			? stats.avgInputTps
			: stats.avgTotalTps;
}

function peakOf(stats: SpeedStats, metric: SpeedMetric): number {
	return metric === 'output'
		? stats.peakOutputTps
		: metric === 'input'
			? stats.peakInputTps
			: stats.peakTotalTps;
}

/** A measured rate, or a gap in the line when the slot had no calls. */
function rateOrGap(value: number, calls: number): number | null {
	return calls > 0 && value > 0 ? value : null;
}

function sliceLabel(startMs: number, granularity: TokenSpeedGranularity): string {
	switch (granularity) {
		case 'hour':
			return format(startMs, 'EEE h a');
		case 'day':
			return format(startMs, 'MMM d');
		case 'week':
			return `Wk ${format(startMs, 'MMM d')}`;
		case 'month':
			return format(startMs, 'MMM yyyy');
	}
}

function hourLabel(hour: number): string {
	if (hour === 0) return '12a';
	if (hour === 12) return '12p';
	return hour < 12 ? `${hour}a` : `${hour - 12}p`;
}

/** Index a set of points by slice start, for aligning series to one x axis. */
function byStart(points: readonly TokenSpeedPoint[]): Map<number, TokenSpeedPoint> {
	return new Map(points.map((p) => [p.startMs, p]));
}

/** One average line per group, aligned to the overall timeline's slices. */
function groupSeries(
	groups: readonly TokenSpeedGroup[],
	timelines: Record<string, TokenSpeedPoint[]>,
	starts: readonly number[],
	metric: SpeedMetric,
	colorAt: (index: number) => string
): LineSeries[] {
	return groups
		.filter((g) => timelines[g.key])
		.map((g, idx) => {
			const points = byStart(timelines[g.key]);
			return {
				key: g.key,
				label: g.label,
				color: colorAt(idx),
				values: starts.map((ms) => {
					const p = points.get(ms);
					return p ? rateOrGap(avgOf(p, metric), p.calls) : null;
				}),
			};
		});
}

interface TokenSpeedStatsProps {
	speed: TokenSpeedSummary;
	theme: Theme;
	colorBlindMode?: boolean;
}

export const TokenSpeedStats = memo(function TokenSpeedStats({
	speed,
	theme,
	colorBlindMode = false,
}: TokenSpeedStatsProps) {
	const { value: metric, setValue: setMetric } = usePersistedChoice<SpeedMetric>(
		'usageDashboard.tokens.speedMetric',
		METRIC_VALUES,
		'output'
	);

	const starts = useMemo(() => speed.timeline.map((p) => p.startMs), [speed.timeline]);
	const xLabels = useMemo(
		() => starts.map((ms) => sliceLabel(ms, speed.granularity)),
		[starts, speed.granularity]
	);
	const fmt = formatTokensPerSecond;

	const overallSeries = useMemo<LineSeries[]>(
		() => [
			{
				key: 'avg',
				label: 'Average',
				color: getSeriesColor(0, theme, colorBlindMode),
				values: speed.timeline.map((p) => rateOrGap(avgOf(p, metric), p.calls)),
			},
			{
				key: 'peak',
				label: 'Peak model-hour',
				color: getSeriesColor(1, theme, colorBlindMode),
				values: speed.timeline.map((p) => rateOrGap(peakOf(p, metric), p.calls)),
				dashed: true,
			},
		],
		[speed.timeline, metric, theme, colorBlindMode]
	);

	const agentSeries = useMemo(
		() =>
			groupSeries(speed.byAgent, speed.timelineByAgent, starts, metric, (idx) =>
				getSeriesColor(idx, theme, colorBlindMode)
			),
		[speed.byAgent, speed.timelineByAgent, starts, metric, theme, colorBlindMode]
	);
	const modelSeries = useMemo(
		() =>
			groupSeries(speed.byModel, speed.timelineByModel, starts, metric, (idx) =>
				getSeriesColor(idx, theme, colorBlindMode)
			),
		[speed.byModel, speed.timelineByModel, starts, metric, theme, colorBlindMode]
	);

	if (speed.overall.calls === 0) {
		return (
			<section data-testid="token-speed-stats">
				<h3 className="text-sm font-semibold mb-2" style={{ color: theme.colors.textMain }}>
					Token Speed
				</h3>
				<TokenSpeedCards speed={speed} theme={theme} />
			</section>
		);
	}

	const metricLabel = METRIC_OPTIONS.find((o) => o.value === metric)?.label ?? '';
	const chartTitle = (title: string) => (
		<h4 className="text-xs font-semibold mb-2" style={{ color: theme.colors.textMain }}>
			{title}
		</h4>
	);

	return (
		<section className="flex flex-col gap-6" data-testid="token-speed-stats">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div>
					<h3 className="text-sm font-semibold" style={{ color: theme.colors.textMain }}>
						Token Speed
					</h3>
					<p className="text-xs mt-0.5" style={{ color: theme.colors.textDim }}>
						Tokens per second of API call time, from request sent to response finished. A peak is
						the fastest single model-hour with {TOKEN_SPEED_PEAK_MIN_BUCKET_MS / 60_000}+ minutes of
						calls.
					</p>
				</div>
				<SegmentedControl
					value={metric}
					onChange={setMetric}
					options={METRIC_OPTIONS}
					theme={theme}
					ariaLabel="Speed metric"
					testId="token-speed-metric"
				/>
			</div>

			<TokenSpeedCards speed={speed} theme={theme} />

			<ChartErrorBoundary theme={theme} chartName="Token Speed Over Time">
				<div data-testid="token-speed-timeline">
					{chartTitle(`${metricLabel} tokens per second over time`)}
					<MultiLineChart
						theme={theme}
						ariaLabel={`${metricLabel} tokens per second over time`}
						xLabels={xLabels}
						series={overallSeries}
						formatValue={fmt}
					/>
				</div>
			</ChartErrorBoundary>

			<div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
				<ChartErrorBoundary theme={theme} chartName="Token Speed by Provider">
					<div data-testid="token-speed-by-agent-chart">
						{chartTitle(`${metricLabel} speed by provider`)}
						<MultiLineChart
							theme={theme}
							ariaLabel={`${metricLabel} tokens per second by provider over time`}
							xLabels={xLabels}
							series={agentSeries}
							formatValue={fmt}
						/>
					</div>
				</ChartErrorBoundary>

				<ChartErrorBoundary theme={theme} chartName="Token Speed by Model">
					<div data-testid="token-speed-by-model-chart">
						{chartTitle(`${metricLabel} speed by model`)}
						<MultiLineChart
							theme={theme}
							ariaLabel={`${metricLabel} tokens per second by model over time`}
							xLabels={xLabels}
							series={modelSeries}
							formatValue={fmt}
						/>
					</div>
				</ChartErrorBoundary>
			</div>

			<ChartErrorBoundary theme={theme} chartName="Token Speed by Hour of Day">
				<HourOfDayBars
					hours={speed.byHourOfDay}
					metric={metric}
					metricLabel={metricLabel}
					theme={theme}
					color={getSeriesColor(0, theme, colorBlindMode)}
				/>
			</ChartErrorBoundary>

			<SpeedTable
				title="By Provider"
				groups={speed.byAgent}
				theme={theme}
				testId="token-speed-by-agent"
				labelFor={(g) => g.label || getAgentDisplayName(g.key)}
			/>
			<SpeedTable
				title="By Model"
				groups={speed.byModel}
				theme={theme}
				testId="token-speed-by-model"
				labelFor={(g) => g.label}
			/>
		</section>
	);
});

// ---------------------------------------------------------------------------
// Hour of day
// ---------------------------------------------------------------------------

interface HourOfDayBarsProps {
	hours: SpeedStats[];
	metric: SpeedMetric;
	metricLabel: string;
	theme: Theme;
	color: string;
}

/** Average speed per local clock hour; empty hours keep their slot so 24 bars always line up. */
const HourOfDayBars = memo(function HourOfDayBars({
	hours,
	metric,
	metricLabel,
	theme,
	color,
}: HourOfDayBarsProps) {
	const [hovered, setHovered] = useState<{ hour: number; x: number; y: number } | null>(null);
	const values = hours.map((h) => avgOf(h, metric));
	const max = Math.max(...values, 0);
	const measured = values.filter((v) => v > 0);
	const fastest = measured.length ? values.indexOf(Math.max(...measured)) : -1;
	const slowest = measured.length ? values.indexOf(Math.min(...measured)) : -1;

	return (
		<div data-testid="token-speed-by-hour">
			<div className="flex items-baseline justify-between mb-2 gap-3">
				<h4 className="text-xs font-semibold" style={{ color: theme.colors.textMain }}>
					{metricLabel} speed by hour of day
				</h4>
				{fastest >= 0 && (
					<span className="text-xs" style={{ color: theme.colors.textDim }}>
						Fastest {hourLabel(fastest)} ({formatTokensPerSecond(values[fastest])}), slowest{' '}
						{hourLabel(slowest)} ({formatTokensPerSecond(values[slowest])})
					</span>
				)}
			</div>
			<div className="flex items-end gap-0.5 h-28">
				{values.map((v, hour) => (
					<div
						key={hour}
						className="flex-1 h-full flex flex-col justify-end min-w-0"
						onMouseEnter={(e) => setHovered({ hour, x: e.clientX, y: e.clientY })}
						onMouseMove={(e) => setHovered({ hour, x: e.clientX, y: e.clientY })}
						onMouseLeave={() => setHovered(null)}
					>
						<div
							className="w-full rounded-t-sm transition-opacity"
							style={{
								height: `${max > 0 ? (v / max) * 100 : 0}%`,
								minHeight: v > 0 ? 2 : 0,
								backgroundColor: color,
								opacity: hovered && hovered.hour !== hour ? 0.5 : 1,
							}}
						/>
					</div>
				))}
			</div>
			<div className="flex justify-between mt-1 text-2xs" style={{ color: theme.colors.textDim }}>
				{[0, 6, 12, 18, 23].map((h) => (
					<span key={h}>{hourLabel(h)}</span>
				))}
			</div>
			{hovered && (
				<ChartTooltip anchor={{ x: hovered.x, y: hovered.y }} theme={theme}>
					<div className="font-semibold mb-1">
						{hourLabel(hovered.hour)} - {hourLabel((hovered.hour + 1) % 24)}
					</div>
					<div>Average: {formatTokensPerSecond(avgOf(hours[hovered.hour], metric))} tok/s</div>
					<div>
						Peak model-hour: {formatTokensPerSecond(peakOf(hours[hovered.hour], metric))} tok/s
					</div>
					<div>Calls: {formatNumber(hours[hovered.hour].calls)}</div>
				</ChartTooltip>
			)}
		</div>
	);
});

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

type SpeedColumn =
	| 'label'
	| 'calls'
	| 'avgInputTps'
	| 'avgOutputTps'
	| 'avgTotalTps'
	| 'peakInputTps'
	| 'peakOutputTps'
	| 'peakTotalTps';

const SPEED_COLUMNS: ReadonlyArray<{ key: SpeedColumn; label: string; title: string }> = [
	{ key: 'label', label: 'Name', title: 'Sort by name' },
	{ key: 'calls', label: 'Calls', title: 'Timed API calls' },
	{ key: 'avgInputTps', label: 'Avg In', title: 'Average input tokens per second' },
	{ key: 'avgOutputTps', label: 'Avg Out', title: 'Average output tokens per second' },
	{ key: 'avgTotalTps', label: 'Avg Total', title: 'Average input + output tokens per second' },
	{ key: 'peakInputTps', label: 'Peak In', title: 'Fastest call, input tokens per second' },
	{ key: 'peakOutputTps', label: 'Peak Out', title: 'Fastest call, output tokens per second' },
	{ key: 'peakTotalTps', label: 'Peak Total', title: 'Fastest call, total tokens per second' },
];

const defaultDirectionFor = (key: SpeedColumn) => (key === 'label' ? 'asc' : 'desc');

interface SpeedTableProps {
	title: string;
	groups: TokenSpeedGroup[];
	theme: Theme;
	testId: string;
	labelFor: (group: TokenSpeedGroup) => string;
}

const SpeedTable = memo(function SpeedTable({
	title,
	groups,
	theme,
	testId,
	labelFor,
}: SpeedTableProps) {
	const { sortKey, direction, isDescending, toggleSort } = useTableSort<SpeedColumn>(
		'avgOutputTps',
		{ defaultDirectionFor }
	);

	const rows = useMemo(() => {
		const sorted = [...groups].sort((a, b) => {
			const diff =
				sortKey === 'label'
					? labelFor(a).localeCompare(labelFor(b))
					: (a[sortKey] as number) - (b[sortKey] as number);
			return isDescending ? -diff : diff;
		});
		return sorted;
	}, [groups, sortKey, isDescending, labelFor]);

	if (groups.length === 0) return null;

	return (
		<div data-testid={testId}>
			<h4 className="text-xs font-semibold mb-2" style={{ color: theme.colors.textMain }}>
				{title}
			</h4>
			<div className="overflow-x-auto">
				<table
					className="w-full text-sm"
					style={{ borderCollapse: 'separate', borderSpacing: 0 }}
					aria-label={`Token speed ${title.toLowerCase()}`}
				>
					<thead>
						<tr>
							{SPEED_COLUMNS.map((column) => (
								<SortableTh
									key={column.key}
									columnKey={column.key}
									label={column.label}
									sortKey={sortKey}
									direction={direction}
									onSort={toggleSort}
									theme={theme}
									align={column.key === 'label' ? 'left' : 'right'}
									title={column.title}
									className={`text-xs font-medium uppercase tracking-wider px-3 py-2 border-b select-none whitespace-nowrap ${
										column.key === 'label' ? 'text-left' : 'text-right'
									}`}
									style={{ borderColor: theme.colors.border }}
									testId={`${testId}-sort-${column.key}`}
								/>
							))}
						</tr>
					</thead>
					<tbody>
						{rows.map((g) => (
							<tr key={g.key} data-testid={`${testId}-row`}>
								<td
									className="px-3 py-1.5 truncate max-w-[220px]"
									style={{ color: theme.colors.textMain }}
									title={g.key}
								>
									{labelFor(g)}
								</td>
								{SPEED_COLUMNS.slice(1).map((column) => {
									const value = g[column.key] as number;
									const active = sortKey === column.key;
									return (
										<td
											key={column.key}
											className={`px-3 py-1.5 text-right tabular-nums whitespace-nowrap${active ? ' font-semibold' : ''}`}
											style={{
												color: active
													? theme.colors.accent
													: value > 0
														? theme.colors.textMain
														: theme.colors.textDim,
											}}
										>
											{column.key === 'calls' ? formatNumber(value) : formatTokensPerSecond(value)}
										</td>
									);
								})}
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	);
});
