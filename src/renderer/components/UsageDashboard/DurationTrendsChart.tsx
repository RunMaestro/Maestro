/**
 * DurationTrendsChart
 *
 * How long a query takes, over the selected window: the mean query duration
 * per day (per week on windows longer than `WEEKLY_AFTER_DAYS`), drawn on the
 * shared `MultiLineChart`.
 *
 * - Every mean is WEIGHTED by query count (total duration / total queries in
 *   the slot), so a day with one query cannot pull the line as hard as a day
 *   with two hundred. The stats payload carries per-day sums, not per-query
 *   durations, so a per-day median is not available; the Overview's duration
 *   percentiles cover the distribution.
 * - The axis is the whole calendar window (`byDay` is gap-filled); a day with
 *   no queries is a gap in the line, not a zero.
 * - Smoothing adds a TRAILING average (the last 7 days, or 4 weeks), never a
 *   centered one, so a point never borrows from days after it.
 */

import { memo, useMemo } from 'react';
import type { Theme } from '../../types';
import type { StatsAggregation } from '../../../shared/stats-types';
import { COLORBLIND_LINE_COLORS } from '../../constants/colorblindPalettes';
import { formatDurationHuman } from '../../../shared/formatters';
import { fillDaySeries } from '../../../shared/daySeries';
import { parseLocalYmd } from '../../../shared/localDay';
import { usePersistedToggle } from '../../hooks/ui/usePersistedToggle';
import { MultiLineChart, type LineSeries } from '../widgets';
import { heatmapWindow } from './activityHeatmapUtils';

/** Windows longer than this are drawn per week instead of per day. */
export const WEEKLY_AFTER_DAYS = 120;
/** Trailing-average length, in slots: 7 days, or 4 weeks. */
const TRAILING_DAYS = 7;
const TRAILING_WEEKS = 4;

export const DURATION_SMOOTHING_KEY = 'usageDashboard.activity.durationSmoothing';

interface DurationTrendsChartProps {
	/** Aggregated stats for the selected range (uses `window` and `byDay`). */
	data: StatsAggregation;
	theme: Theme;
	colorBlindMode?: boolean;
}

/** One x slot: a day, or a run of up to seven days. */
export interface DurationSlot {
	startYmd: string;
	endYmd: string;
	count: number;
	duration: number;
}

function shortDay(ymd: string): string {
	return (
		parseLocalYmd(ymd)?.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) ?? ymd
	);
}

export function slotLabel(slot: DurationSlot): string {
	return slot.startYmd === slot.endYmd
		? shortDay(slot.startYmd)
		: `${shortDay(slot.startYmd)} - ${shortDay(slot.endYmd)}`;
}

/** The window's days as slots: one per day, or runs of seven past `WEEKLY_AFTER_DAYS`. */
export function buildDurationSlots(
	data: Pick<StatsAggregation, 'byDay'> & Partial<Pick<StatsAggregation, 'window'>>
): { slots: DurationSlot[]; weekly: boolean } {
	const span = heatmapWindow(data);
	const days = fillDaySeries(data.byDay, span.startYmd, span.endYmd, (date) => ({
		date,
		count: 0,
		duration: 0,
	}));
	const weekly = days.length > WEEKLY_AFTER_DAYS;
	if (!weekly) {
		return {
			slots: days.map((d) => ({
				startYmd: d.date,
				endYmd: d.date,
				count: d.count,
				duration: d.duration,
			})),
			weekly,
		};
	}
	const slots: DurationSlot[] = [];
	for (let i = 0; i < days.length; i += 7) {
		const run = days.slice(i, i + 7);
		slots.push({
			startYmd: run[0].date,
			endYmd: run[run.length - 1].date,
			count: run.reduce((sum, d) => sum + d.count, 0),
			duration: run.reduce((sum, d) => sum + d.duration, 0),
		});
	}
	return { slots, weekly };
}

/** Weighted mean duration per slot; null where the slot had no queries. */
export function slotMeans(slots: readonly DurationSlot[]): Array<number | null> {
	return slots.map((slot) => (slot.count > 0 ? slot.duration / slot.count : null));
}

/**
 * Trailing weighted mean over the last `size` slots (this one included): total
 * duration over total queries in that run. Null when the run had no queries.
 */
export function trailingMeans(slots: readonly DurationSlot[], size: number): Array<number | null> {
	return slots.map((_, i) => {
		let count = 0;
		let duration = 0;
		for (let j = Math.max(0, i - size + 1); j <= i; j++) {
			count += slots[j].count;
			duration += slots[j].duration;
		}
		return count > 0 ? duration / count : null;
	});
}

export const DurationTrendsChart = memo(function DurationTrendsChart({
	data,
	theme,
	colorBlindMode = false,
}: DurationTrendsChartProps) {
	const smoothing = usePersistedToggle(DURATION_SMOOTHING_KEY, false);
	const primaryColor = colorBlindMode ? COLORBLIND_LINE_COLORS.primary : theme.colors.accent;
	const secondaryColor = colorBlindMode ? COLORBLIND_LINE_COLORS.secondary : theme.colors.warning;

	const { slots, weekly } = useMemo(() => buildDurationSlots(data), [data]);
	const trailingSize = weekly ? TRAILING_WEEKS : TRAILING_DAYS;
	const trailingLabel = weekly ? `${TRAILING_WEEKS}-week average` : `${TRAILING_DAYS}-day average`;
	const totalQueries = slots.reduce((sum, slot) => sum + slot.count, 0);
	// The chart image is one accessible element, so its name carries the range
	// a sighted reader takes from the y axis.
	const measuredMeans = slotMeans(slots).filter((v): v is number => v !== null);
	const rangeText =
		measuredMeans.length > 0
			? ` Range from ${formatDurationHuman(Math.min(...measuredMeans))} to ${formatDurationHuman(Math.max(...measuredMeans))}.`
			: '';

	const xLabels = useMemo(() => slots.map(slotLabel), [slots]);
	const series = useMemo<LineSeries[]>(() => {
		const perSlot: LineSeries = {
			key: 'mean',
			label: weekly ? 'Weekly mean' : 'Daily mean',
			color: primaryColor,
			values: slotMeans(slots),
			dashed: smoothing.value,
		};
		if (!smoothing.value) return [perSlot];
		return [
			perSlot,
			{
				key: 'trailing',
				label: trailingLabel,
				color: secondaryColor,
				values: trailingMeans(slots, trailingSize),
			},
		];
	}, [slots, weekly, smoothing.value, primaryColor, secondaryColor, trailingLabel, trailingSize]);

	return (
		<div
			className="p-4 rounded-lg"
			style={{ backgroundColor: theme.colors.bgMain }}
			role="figure"
			aria-label={`Mean query duration per ${weekly ? 'week' : 'day'}${smoothing.value ? `, with a trailing ${trailingLabel}` : ''}.`}
			data-testid="duration-trends-chart"
		>
			<div className="flex flex-wrap items-center justify-between gap-2 mb-1">
				<h3 className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
					Duration Trends
				</h3>
				<label
					className="flex items-center gap-2 cursor-pointer"
					style={{ color: theme.colors.textDim }}
				>
					<span className="text-xs">{trailingLabel}</span>
					<button
						type="button"
						role="switch"
						aria-checked={smoothing.value}
						onClick={smoothing.toggle}
						className="relative w-9 h-5 rounded-full transition-colors"
						style={{
							backgroundColor: smoothing.value ? primaryColor : `${theme.colors.border}80`,
						}}
						aria-label={`Show the trailing ${trailingLabel}`}
						data-testid="duration-trends-smoothing"
					>
						<span
							className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform shadow-sm"
							style={{ transform: smoothing.value ? 'translateX(16px)' : 'translateX(0)' }}
						/>
					</button>
				</label>
			</div>
			<p className="text-xs mb-3" style={{ color: theme.colors.textDim }}>
				Mean time per query, weighted by query count. Gaps are {weekly ? 'weeks' : 'days'} with no
				queries.
			</p>

			{totalQueries === 0 ? (
				<div
					className="flex items-center justify-center text-sm"
					style={{ height: 160, color: theme.colors.textDim }}
					data-testid="duration-trends-empty"
				>
					No queries in this range
				</div>
			) : (
				<MultiLineChart
					theme={theme}
					ariaLabel={`Mean query duration per ${weekly ? 'week' : 'day'}.${rangeText}`}
					xLabels={xLabels}
					series={series}
					formatValue={formatDurationHuman}
					showLegend={smoothing.value}
					testId="duration-trends"
				/>
			)}
		</div>
	);
});

export default DurationTrendsChart;
