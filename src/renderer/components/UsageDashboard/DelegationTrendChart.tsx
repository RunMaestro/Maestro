/**
 * DelegationTrendChart
 *
 * Stacked bars, one per day (or per equal group of days on a long range),
 * splitting each day's AI work into interactive time and delegated time
 * (Auto Run + Cue). Toggles between Time and Queries; Time leads, because the
 * delegation story is about hours that ran without you, not turn counts.
 *
 * Stacked rather than side-by-side on purpose: the question is what SHARE of a
 * day ran unattended, and a stack answers that at a glance while still showing
 * how big the day was. The delegated half is drawn on top so the growing part
 * is the part that moves.
 */

import { memo, useMemo, useState } from 'react';
import type { Theme } from '../../types';
import type { DelegationDay } from '../../../shared/delegation';
import { formatDurationHuman, formatNumber } from '../../../shared/formatters';
import { MetricModeToggle, type ChartMetricMode } from './MetricModeToggle';
import { computeAxisLabelIndices } from './chartUtils';
import { delegationColors } from './delegationColors';
import {
	buildDelegationSeries,
	bucketDelegatedPercent,
	bucketDelegatedValue,
	bucketInteractiveValue,
	parseYmd,
	type DelegationBucket,
} from './delegationTrendUtils';

interface DelegationTrendChartProps {
	/** Per-day split from `stats.getDelegationByDay`. Empty while loading. */
	days: DelegationDay[];
	theme: Theme;
	colorBlindMode?: boolean;
	loading?: boolean;
}

/** Only 'count' and 'duration' apply here - there is no per-source token split. */
type TrendMode = Extract<ChartMetricMode, 'count' | 'duration'>;

const CHART_HEIGHT = 160;

function formatValue(mode: TrendMode, value: number): string {
	return mode === 'duration' ? formatDurationHuman(value) : formatNumber(value);
}

function formatBucketLabel(bucket: DelegationBucket): string {
	const start = parseYmd(bucket.date);
	if (!start) return bucket.date;
	const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
	if (bucket.days <= 1) return start.toLocaleDateString(undefined, opts);
	const end = parseYmd(bucket.endDate);
	if (!end) return start.toLocaleDateString(undefined, opts);
	return `${start.toLocaleDateString(undefined, opts)} - ${end.toLocaleDateString(undefined, opts)}`;
}

export const DelegationTrendChart = memo(function DelegationTrendChart({
	days,
	theme,
	colorBlindMode = false,
	loading = false,
}: DelegationTrendChartProps) {
	const [mode, setMode] = useState<TrendMode>('duration');
	const [hovered, setHovered] = useState<number | null>(null);

	const colors = delegationColors(theme, colorBlindMode);
	const buckets = useMemo(() => buildDelegationSeries(days), [days]);

	const maxTotal = useMemo(
		() =>
			buckets.reduce(
				(max, bucket) =>
					Math.max(max, bucketInteractiveValue(bucket, mode) + bucketDelegatedValue(bucket, mode)),
				0
			),
		[buckets, mode]
	);

	const totals = useMemo(() => {
		let interactive = 0;
		let delegated = 0;
		for (const bucket of buckets) {
			interactive += bucketInteractiveValue(bucket, mode);
			delegated += bucketDelegatedValue(bucket, mode);
		}
		const all = interactive + delegated;
		return { interactive, delegated, percent: all > 0 ? (delegated / all) * 100 : 0 };
	}, [buckets, mode]);

	const labelIndices = useMemo(() => computeAxisLabelIndices(buckets.length), [buckets.length]);
	const hoveredBucket = hovered !== null ? buckets[hovered] : null;

	return (
		<div
			className="p-4 rounded-lg"
			style={{ backgroundColor: theme.colors.bgMain }}
			data-testid="delegation-trend-chart"
			role="figure"
			aria-label={`Interactive versus delegated ${mode === 'duration' ? 'time' : 'queries'} per day`}
		>
			<div className="flex items-center justify-between gap-3 mb-1">
				<h3 className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
					Interactive vs Delegated
				</h3>
				<MetricModeToggle
					mode={mode}
					onChange={(next) => setMode(next as TrendMode)}
					theme={theme}
					modes={['duration', 'count']}
					labels={{ duration: 'Time', count: 'Queries' }}
					variant="subtle"
				/>
			</div>

			<div className="text-xs mb-4" style={{ color: theme.colors.textDim }}>
				{buckets.length === 0 ? (
					loading ? (
						'Loading...'
					) : (
						'No activity in this range'
					)
				) : (
					<>
						<span style={{ color: colors.delegated }}>{Math.round(totals.percent)}% delegated</span>{' '}
						- {formatValue(mode, totals.delegated)} ran without you,{' '}
						{formatValue(mode, totals.interactive)} interactive
					</>
				)}
			</div>

			{buckets.length > 0 && (
				<div className="relative">
					{hoveredBucket && (
						<div
							className="absolute z-10 px-3 py-2 rounded text-xs whitespace-nowrap pointer-events-none shadow-lg"
							style={{
								left: `${((hovered! + 0.5) / buckets.length) * 100}%`,
								bottom: '100%',
								transform: 'translateX(-50%)',
								marginBottom: '8px',
								backgroundColor: theme.colors.bgActivity,
								color: theme.colors.textMain,
								border: `1px solid ${theme.colors.border}`,
							}}
						>
							<div className="font-medium mb-1">{formatBucketLabel(hoveredBucket)}</div>
							<div className="flex flex-col gap-0.5" style={{ color: theme.colors.textDim }}>
								<span>
									Interactive {formatValue(mode, bucketInteractiveValue(hoveredBucket, mode))}
								</span>
								<span>
									Auto Run{' '}
									{formatValue(
										mode,
										mode === 'duration'
											? hoveredBucket.autoRun.durationMs
											: hoveredBucket.autoRun.count
									)}
								</span>
								<span>
									Cue{' '}
									{formatValue(
										mode,
										mode === 'duration' ? hoveredBucket.cue.durationMs : hoveredBucket.cue.count
									)}
								</span>
								<span style={{ color: theme.colors.textMain }}>
									{Math.round(bucketDelegatedPercent(hoveredBucket, mode))}% delegated
								</span>
							</div>
						</div>
					)}

					<div
						className="flex items-end gap-0.5"
						style={{ height: CHART_HEIGHT }}
						role="img"
						aria-label="Stacked bars: interactive time below, delegated time above"
					>
						{buckets.map((bucket, index) => {
							const interactive = bucketInteractiveValue(bucket, mode);
							const delegated = bucketDelegatedValue(bucket, mode);
							const total = interactive + delegated;
							const totalPct = maxTotal > 0 ? (total / maxTotal) * 100 : 0;
							const delegatedShare = total > 0 ? delegated / total : 0;
							const isHovered = hovered === index;

							return (
								<div
									key={bucket.date}
									className="flex-1 h-full flex flex-col justify-end cursor-default"
									onMouseEnter={() => setHovered(index)}
									onMouseLeave={() => setHovered(null)}
									data-testid="delegation-trend-bar"
								>
									<div
										className="w-full rounded-t overflow-hidden flex flex-col"
										style={{
											height: `${total > 0 ? Math.max(totalPct, 1.5) : 0}%`,
											opacity: hovered === null || isHovered ? 1 : 0.55,
											transition: 'opacity 150ms ease',
										}}
									>
										<div
											style={{
												height: `${delegatedShare * 100}%`,
												backgroundColor: colors.delegated,
											}}
										/>
										<div
											style={{
												height: `${(1 - delegatedShare) * 100}%`,
												backgroundColor: colors.interactive,
											}}
										/>
									</div>
								</div>
							);
						})}
					</div>

					{/* Axis labels are absolutely positioned over the bar row rather
					    than living in a per-bar cell. A long range draws 100+ bars, so a
					    cell is a couple of pixels wide and would clip "Mar 14" down to
					    nothing - the labels have to be free to overhang their bar. */}
					<div
						className="relative mt-2 h-4 text-[10px]"
						style={{ color: theme.colors.textDim }}
						aria-hidden="true"
					>
						{buckets.map((bucket, index) =>
							labelIndices.has(index) ? (
								<span
									key={bucket.date}
									className="absolute top-0 whitespace-nowrap"
									style={{
										left: `${((index + 0.5) / buckets.length) * 100}%`,
										// The first and last labels anchor to their edge so they
										// can't run off the chart.
										transform:
											index === 0
												? 'translateX(0)'
												: index === buckets.length - 1
													? 'translateX(-100%)'
													: 'translateX(-50%)',
									}}
								>
									{formatBucketLabel(bucket).split(' - ')[0]}
								</span>
							) : null
						)}
					</div>

					<div
						className="flex items-center gap-4 mt-3 pt-3 border-t text-[10px]"
						style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
					>
						<span className="flex items-center gap-1.5">
							<span
								className="w-2.5 h-2.5 rounded-sm"
								style={{ backgroundColor: colors.delegated }}
								aria-hidden="true"
							/>
							Delegated (Auto Run + Cue)
						</span>
						<span className="flex items-center gap-1.5">
							<span
								className="w-2.5 h-2.5 rounded-sm"
								style={{ backgroundColor: colors.interactive }}
								aria-hidden="true"
							/>
							Interactive
						</span>
					</div>
				</div>
			)}
		</div>
	);
});

export default DelegationTrendChart;
