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

import { memo, useMemo, useState, type MouseEvent } from 'react';
import type { Theme } from '../../types';
import type { DelegationDay } from '../../../shared/delegation';
import { formatDurationHuman, formatNumber } from '../../../shared/formatters';
import { parseLocalYmd } from '../../../shared/localDay';
import { resolveCueHistoryRetentionDays } from '../../../shared/cue/retention';
import { useSettingsStore } from '../../stores/settingsStore';
import { usePersistedChoice } from '../../hooks/ui/usePersistedChoice';
import { MetricModeToggle, type ChartMetricMode } from './MetricModeToggle';
import { computeAxisLabelIndices, PHONE_AXIS_LABELS } from './chartUtils';
import { usePhoneLayout } from '../../hooks/ui/useViewportBreakpoint';
import { delegationColors } from './delegationColors';
import {
	buildDelegationSeries,
	bucketDelegatedPercent,
	bucketDelegatedValue,
	bucketInteractiveValue,
	type DelegationBucket,
} from './delegationTrendUtils';
import { ChartTooltip } from '../widgets';

interface DelegationTrendChartProps {
	/**
	 * Per-day split from `stats.getDelegationByDay`. Fetched with the rest of the
	 * dashboard payload, so it is present whenever this chart renders.
	 */
	days: DelegationDay[];
	/**
	 * The calendar window of the selected range (`StatsAggregation.window`). The
	 * bars span all of it, so a quiet start or end of the range draws as quiet.
	 * It also decides whether the Cue slice covers the whole window: Cue run
	 * history is pruned to the user's retention setting, so a longer window
	 * draws real interactive and Auto Run bars beside Cue bars that were deleted,
	 * which reads as "I stopped using Cue" rather than "that data is gone". The
	 * chart says so instead.
	 */
	dayWindow?: { startYmd: string; endYmd: string };
	theme: Theme;
	colorBlindMode?: boolean;
}

/** Only 'count' and 'duration' apply here - there is no per-source token split. */
type TrendMode = Extract<ChartMetricMode, 'count' | 'duration'>;
const TREND_MODES: readonly TrendMode[] = ['duration', 'count'];

const CHART_HEIGHT = 160;

function formatValue(mode: TrendMode, value: number): string {
	return mode === 'duration' ? formatDurationHuman(value) : formatNumber(value);
}

function formatBucketLabel(bucket: DelegationBucket): string {
	const start = parseLocalYmd(bucket.date);
	if (!start) return bucket.date;
	const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
	if (bucket.days <= 1) return start.toLocaleDateString(undefined, opts);
	const end = parseLocalYmd(bucket.endDate);
	if (!end) return start.toLocaleDateString(undefined, opts);
	return `${start.toLocaleDateString(undefined, opts)} - ${end.toLocaleDateString(undefined, opts)}`;
}

export const DelegationTrendChart = memo(function DelegationTrendChart({
	days,
	dayWindow,
	theme,
	colorBlindMode = false,
}: DelegationTrendChartProps) {
	const { value: mode, setValue: setMode } = usePersistedChoice<TrendMode>(
		'usageDashboard.activity.delegationMode',
		TREND_MODES,
		'duration'
	);
	const [hovered, setHovered] = useState<number | null>(null);
	const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
	const retentionDays = resolveCueHistoryRetentionDays(
		useSettingsStore((s) => s.cueHistoryRetentionDays)
	);

	const colors = delegationColors(theme, colorBlindMode);
	const buckets = useMemo(
		() =>
			buildDelegationSeries(days, {
				fromDate: dayWindow?.startYmd,
				throughDate: dayWindow?.endYmd,
			}),
		[days, dayWindow?.startYmd, dayWindow?.endYmd]
	);

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
		return { interactive, delegated, all, percent: all > 0 ? (delegated / all) * 100 : 0 };
	}, [buckets, mode]);

	const phone = usePhoneLayout();
	const labelIndices = useMemo(
		() => computeAxisLabelIndices(buckets.length, phone ? PHONE_AXIS_LABELS : undefined),
		[buckets.length, phone]
	);
	const hoveredBucket = hovered !== null ? buckets[hovered] : null;
	const windowDays = buckets.reduce((sum, bucket) => sum + bucket.days, 0);
	const cueTruncated = windowDays > retentionDays;
	const hasActivity = totals.all > 0;
	const hoverBar = (index: number) => (event: MouseEvent) => {
		setHovered(index);
		setAnchor({ x: event.clientX, y: event.clientY });
	};
	const leaveBar = () => {
		setHovered(null);
		setAnchor(null);
	};

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
				{!hasActivity ? (
					'No activity in this range'
				) : (
					<>
						<span style={{ color: colors.delegated }}>{Math.round(totals.percent)}% delegated</span>{' '}
						- {formatValue(mode, totals.delegated)} ran without you,{' '}
						{formatValue(mode, totals.interactive)} interactive
					</>
				)}
			</div>

			{hasActivity && (
				<div className="relative">
					{hoveredBucket && (
						<ChartTooltip anchor={anchor} theme={theme} testId="delegation-trend-tooltip">
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
						</ChartTooltip>
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
									onMouseEnter={hoverBar(index)}
									onMouseMove={hoverBar(index)}
									onMouseLeave={leaveBar}
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
						className="relative mt-2 h-4 text-2xs"
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
						className="flex items-center gap-4 mt-3 pt-3 border-t text-2xs"
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

					{cueTruncated && (
						<div
							className="mt-2 text-2xs"
							style={{ color: theme.colors.textDim }}
							data-testid="delegation-trend-cue-notice"
						>
							Cue runs older than {retentionDays} {retentionDays === 1 ? 'day' : 'days'} are pruned
							(Cue history retention setting), so days before then show Auto Run only. The
							Delegation Score still counts your full Cue time.
						</div>
					)}
				</div>
			)}
		</div>
	);
});

export default DelegationTrendChart;
