/**
 * PromptCadenceStats - how often the user prompts an agent through Maestro.
 *
 * A prompt is an interactive turn (Auto Run excluded), which is NOT what the
 * dashboard's "Queries" counts: that is every agent turn. Tiles up top
 * (average, median, min, max, streaks, cadence), then prompts per day with the
 * window's average and a 7-day rolling average, then when in the day and week
 * the prompting happens, then the full per-day and time-between-prompts
 * distributions.
 *
 * Every number comes from `data.prompts` (`src/shared/promptCadence.ts`),
 * computed in the main process so `maestro-cli stats` reports the same figures.
 * This component only lays them out.
 */

import { memo, useMemo, useState } from 'react';
import {
	CalendarDays,
	Clock,
	Flame,
	MessageSquare,
	Sigma,
	Timer,
	TrendingDown,
	TrendingUp,
} from 'lucide-react';
import type { Theme } from '../../types';
import {
	PROMPT_STRETCH_BREAK_MS,
	type PromptCadence,
	type PromptDay,
} from '../../../shared/promptCadence';
import {
	formatCalendarDay,
	formatDurationHuman,
	formatHourOfDay,
	formatNumber,
} from '../../../shared/formatters';
import { MetricCard } from './MetricCard';
import { PercentilesCard } from './PercentilesCard';
import { chunkIntoEqualGroups, computeAxisLabelIndices, PHONE_AXIS_LABELS } from './chartUtils';
import { formatHourShort } from './tasksByHourUtils';
import { parseYmd } from './delegationTrendUtils';
import { usePhoneLayout } from '../../hooks/ui/useViewportBreakpoint';
import { elevatedSurfaceStyle } from '../../utils/elevatedSurface';

interface PromptCadenceStatsProps {
	cadence: PromptCadence;
	theme: Theme;
}

const CHART_HEIGHT = 160;
const MAX_BARS = 120;
const ROLLING_WINDOW_DAYS = 7;
const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** One drawn bar: a day, or an equal run of days on a long range. */
interface PromptBucket {
	date: string;
	endDate: string;
	days: number;
	total: number;
	/** Prompts per day across the bucket, so grouped bars share the daily scale. */
	perDay: number;
	/** Trailing 7-day average ending on the bucket's last day. */
	rolling: number;
}

/** Up to one decimal, dropped when it is zero: 12, 12.4. */
function formatRate(value: number): string {
	return value >= 100 || Number.isInteger(value)
		? formatNumber(Math.round(value))
		: value.toFixed(1);
}

function shortDay(ymd: string): string {
	return parseYmd(ymd)?.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) ?? ymd;
}

function bucketLabel(bucket: PromptBucket): string {
	return bucket.days <= 1
		? shortDay(bucket.date)
		: `${shortDay(bucket.date)} - ${shortDay(bucket.endDate)}`;
}

function buildBuckets(days: PromptDay[]): PromptBucket[] {
	let windowSum = 0;
	const rolling = days.map((day, i) => {
		windowSum += day.count;
		if (i >= ROLLING_WINDOW_DAYS) windowSum -= days[i - ROLLING_WINDOW_DAYS].count;
		return windowSum / Math.min(i + 1, ROLLING_WINDOW_DAYS);
	});
	const indexed = days.map((day, i) => ({ ...day, rolling: rolling[i] }));
	return chunkIntoEqualGroups(indexed, MAX_BARS).map((slice) => {
		const total = slice.reduce((sum, day) => sum + day.count, 0);
		const last = slice[slice.length - 1];
		return {
			date: slice[0].date,
			endDate: last.date,
			days: slice.length,
			total,
			perDay: total / slice.length,
			rolling: last.rolling,
		};
	});
}

/** A labeled strip of vertical bars: hour of day, day of week. */
const MiniBars = memo(function MiniBars({
	title,
	values,
	labels,
	axisIndices,
	describe,
	theme,
	testId,
}: {
	title: string;
	values: number[];
	labels: string[];
	/** Which labels to print under the axis; every one when omitted. */
	axisIndices?: Set<number>;
	describe: (index: number) => string;
	theme: Theme;
	testId: string;
}) {
	const [hovered, setHovered] = useState<number | null>(null);
	const max = Math.max(...values, 0);
	const peak = max > 0 ? values.indexOf(max) : -1;

	return (
		<div
			className="p-4 rounded-lg"
			style={{ backgroundColor: theme.colors.bgMain }}
			data-testid={testId}
		>
			<div className="flex items-baseline justify-between gap-2 mb-3">
				<h4 className="text-xs font-medium" style={{ color: theme.colors.textDim }}>
					{title}
				</h4>
				<span className="text-2xs tabular-nums" style={{ color: theme.colors.textDim }}>
					{hovered !== null ? describe(hovered) : peak >= 0 ? `Peak: ${describe(peak)}` : ''}
				</span>
			</div>
			<div className="flex items-end gap-0.5" style={{ height: 72 }} role="img" aria-label={title}>
				{values.map((value, index) => (
					<div
						key={labels[index]}
						className="flex-1 h-full flex flex-col justify-end"
						onMouseEnter={() => setHovered(index)}
						onMouseLeave={() => setHovered(null)}
					>
						<div
							className="w-full rounded-t"
							style={{
								height: `${max > 0 && value > 0 ? Math.max((value / max) * 100, 3) : 0}%`,
								backgroundColor: theme.colors.accent,
								opacity: index === peak || index === hovered ? 1 : 0.5,
								transition: 'opacity 150ms ease',
							}}
						/>
					</div>
				))}
			</div>
			<div
				className="flex gap-0.5 mt-1.5 text-2xs"
				style={{ color: theme.colors.textDim }}
				aria-hidden="true"
			>
				{labels.map((label, index) => (
					<span key={label} className="flex-1 text-center whitespace-nowrap overflow-visible">
						{!axisIndices || axisIndices.has(index) ? label : ''}
					</span>
				))}
			</div>
		</div>
	);
});

const HOUR_LABELS = Array.from({ length: 24 }, (_, hour) => formatHourShort(hour));
const HOUR_AXIS = new Set([0, 6, 12, 18, 23]);

export const PromptCadenceStats = memo(function PromptCadenceStats({
	cadence,
	theme,
}: PromptCadenceStatsProps) {
	const [hovered, setHovered] = useState<number | null>(null);
	const phone = usePhoneLayout();

	const buckets = useMemo(() => buildBuckets(cadence.days), [cadence.days]);
	const maxValue = useMemo(
		() => buckets.reduce((max, b) => Math.max(max, b.perDay, b.rolling), cadence.avgPerDay),
		[buckets, cadence.avgPerDay]
	);
	const labelIndices = useMemo(
		() => computeAxisLabelIndices(buckets.length, phone ? PHONE_AXIS_LABELS : undefined),
		[buckets.length, phone]
	);
	const grouped = buckets.some((b) => b.days > 1);
	const heightPct = (value: number) => (maxValue > 0 ? (value / maxValue) * 100 : 0);
	// Rolling line in a 0-100 box stretched over the bar row; x at bar centres.
	const rollingPoints = buckets
		.map((b, i) => `${((i + 0.5) / buckets.length) * 100},${100 - heightPct(b.rolling)}`)
		.join(' ');
	const hoveredBucket = hovered !== null ? buckets[hovered] : null;

	const heading = (
		<h3
			className="text-sm font-medium mb-1 flex items-center gap-2"
			style={{ color: theme.colors.textMain }}
		>
			<MessageSquare className="w-4 h-4" style={{ color: theme.colors.accent }} />
			Prompts
		</h3>
	);

	if (cadence.total === 0) {
		return (
			<div
				className="p-4 rounded-lg"
				style={{ backgroundColor: theme.colors.bgMain }}
				data-testid="prompt-cadence-stats"
			>
				{heading}
				<div className="text-sm" style={{ color: theme.colors.textDim }}>
					No prompts in this time range. Every message you send an agent shows up here; Auto Run
					tasks do not.
				</div>
			</div>
		);
	}

	const singleDay = cadence.calendarDays <= 1;

	return (
		<div data-testid="prompt-cadence-stats">
			{heading}
			<div className="text-xs mb-3" style={{ color: theme.colors.textDim }}>
				Messages you sent to agents, Auto Run excluded.{' '}
				{singleDay
					? 'Today so far.'
					: `${formatCalendarDay(cadence.windowStart)} to today, ${formatNumber(cadence.calendarDays)} days. Per-day figures leave out today, which is still in progress.`}
			</div>

			<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
				<MetricCard
					icon={<Sigma className="w-4 h-4" />}
					label="Total Prompts"
					value={formatNumber(cadence.total)}
					subValue={`${cadence.activeDays} of ${cadence.calendarDays} days active`}
					theme={theme}
					testId="prompt-total"
				/>
				<MetricCard
					icon={<CalendarDays className="w-4 h-4" />}
					label="Average / Day"
					value={formatRate(cadence.avgPerDay)}
					subValue={`${formatRate(cadence.avgPerActiveDay)} per active day`}
					theme={theme}
					testId="prompt-average"
				/>
				<MetricCard
					icon={<TrendingUp className="w-4 h-4" />}
					label="Busiest Day"
					value={cadence.busiestDay ? formatNumber(cadence.busiestDay.count) : '-'}
					subValue={cadence.busiestDay ? formatCalendarDay(cadence.busiestDay.date) : undefined}
					theme={theme}
					testId="prompt-max"
				/>
				<MetricCard
					icon={<TrendingDown className="w-4 h-4" />}
					label="Quietest Active Day"
					value={cadence.quietestActiveDay ? formatNumber(cadence.quietestActiveDay.count) : '-'}
					subValue={
						cadence.quietestActiveDay
							? `${formatCalendarDay(cadence.quietestActiveDay.date)}, median day ${formatRate(cadence.perDay.p50)}`
							: undefined
					}
					theme={theme}
					testId="prompt-min"
				/>
				<MetricCard
					icon={<Flame className="w-4 h-4" />}
					label="Current Streak"
					value={`${cadence.currentStreak} ${cadence.currentStreak === 1 ? 'day' : 'days'}`}
					subValue={`longest ${cadence.longestStreak} ${cadence.longestStreak === 1 ? 'day' : 'days'}`}
					theme={theme}
					testId="prompt-streak"
				/>
				<MetricCard
					icon={<Clock className="w-4 h-4" />}
					label="Peak Hour"
					value={cadence.peakHour !== null ? formatHourOfDay(cadence.peakHour) : '-'}
					subValue={
						cadence.busiestHour
							? `record ${cadence.busiestHour.count} in one hour, ${formatCalendarDay(cadence.busiestHour.date)}`
							: undefined
					}
					theme={theme}
					testId="prompt-peak-hour"
				/>
				<MetricCard
					icon={<Timer className="w-4 h-4" />}
					label="Time Between Prompts"
					value={cadence.gapMs.count > 0 ? formatDurationHuman(cadence.gapMs.p50) : '-'}
					subValue="median, while working"
					theme={theme}
					testId="prompt-gap"
				/>
				<MetricCard
					icon={<MessageSquare className="w-4 h-4" />}
					label="Working Stretches"
					value={formatNumber(cadence.stretches)}
					subValue={`${formatRate(cadence.total / Math.max(cadence.stretches, 1))} prompts each`}
					theme={theme}
					testId="prompt-stretches"
				/>
			</div>

			{!singleDay && (
				<div
					className="p-4 rounded-lg mb-4"
					style={{ backgroundColor: theme.colors.bgMain }}
					data-testid="prompt-cadence-chart"
					role="figure"
					aria-label="Prompts per day"
				>
					<div className="flex items-baseline justify-between gap-3 mb-3">
						<h4 className="text-xs font-medium" style={{ color: theme.colors.textDim }}>
							Prompts per Day{grouped ? ' (averaged per bar)' : ''}
						</h4>
						<div
							className="flex items-center gap-3 text-2xs"
							style={{ color: theme.colors.textDim }}
						>
							<span className="flex items-center gap-1.5">
								<span
									className="w-3 border-t border-dashed"
									style={{ borderColor: theme.colors.textDim }}
								/>
								Average {formatRate(cadence.avgPerDay)}
							</span>
							<span className="flex items-center gap-1.5">
								<span className="w-3 border-t-2" style={{ borderColor: theme.colors.warning }} />
								7-day rolling
							</span>
						</div>
					</div>

					<div className="relative">
						{hoveredBucket && (
							<div
								className="absolute z-10 px-3 py-2 rounded text-xs whitespace-nowrap pointer-events-none"
								style={{
									left: `${((hovered! + 0.5) / buckets.length) * 100}%`,
									bottom: '100%',
									transform: 'translateX(-50%)',
									marginBottom: '8px',
									...elevatedSurfaceStyle(theme),
									color: theme.colors.textMain,
								}}
							>
								<div className="font-medium mb-1">{bucketLabel(hoveredBucket)}</div>
								<div className="flex flex-col gap-0.5" style={{ color: theme.colors.textDim }}>
									<span>
										{formatNumber(hoveredBucket.total)}{' '}
										{hoveredBucket.total === 1 ? 'prompt' : 'prompts'}
										{hoveredBucket.days > 1 ? ` (${formatRate(hoveredBucket.perDay)} / day)` : ''}
									</span>
									<span>7-day average {formatRate(hoveredBucket.rolling)}</span>
								</div>
							</div>
						)}

						<div className="relative" style={{ height: CHART_HEIGHT }}>
							<div
								className="absolute inset-0 flex items-end gap-0.5"
								role="img"
								aria-label="Prompts per day bars"
							>
								{buckets.map((bucket, index) => (
									<div
										key={bucket.date}
										className="flex-1 h-full flex flex-col justify-end"
										onMouseEnter={() => setHovered(index)}
										onMouseLeave={() => setHovered(null)}
										data-testid="prompt-cadence-bar"
									>
										<div
											className="w-full rounded-t"
											style={{
												height: `${bucket.perDay > 0 ? Math.max(heightPct(bucket.perDay), 1.5) : 0}%`,
												backgroundColor: theme.colors.accent,
												opacity: hovered === null || hovered === index ? 0.85 : 0.45,
												transition: 'opacity 150ms ease',
											}}
										/>
									</div>
								))}
							</div>
							<svg
								className="absolute inset-0 w-full h-full pointer-events-none"
								viewBox="0 0 100 100"
								preserveAspectRatio="none"
								aria-hidden="true"
							>
								<line
									x1="0"
									x2="100"
									y1={100 - heightPct(cadence.avgPerDay)}
									y2={100 - heightPct(cadence.avgPerDay)}
									stroke={theme.colors.textDim}
									strokeWidth="1"
									strokeDasharray="4 3"
									vectorEffect="non-scaling-stroke"
								/>
								{buckets.length > 1 && (
									<polyline
										points={rollingPoints}
										fill="none"
										stroke={theme.colors.warning}
										strokeWidth="2"
										strokeLinejoin="round"
										vectorEffect="non-scaling-stroke"
									/>
								)}
							</svg>
						</div>

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
											transform:
												index === 0
													? 'translateX(0)'
													: index === buckets.length - 1
														? 'translateX(-100%)'
														: 'translateX(-50%)',
										}}
									>
										{shortDay(bucket.date)}
									</span>
								) : null
							)}
						</div>
					</div>
				</div>
			)}

			<div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mb-4">
				<MiniBars
					title="By Hour of Day"
					values={cadence.byHour}
					labels={HOUR_LABELS}
					axisIndices={HOUR_AXIS}
					describe={(hour) =>
						`${formatHourOfDay(hour)}, ${formatNumber(cadence.byHour[hour])} prompts`
					}
					theme={theme}
					testId="prompt-cadence-by-hour"
				/>
				{!singleDay && (
					<MiniBars
						title="Average by Weekday"
						values={cadence.avgByWeekday}
						labels={WEEKDAY_LABELS}
						describe={(day) =>
							`${WEEKDAY_LABELS[day]}, ${formatRate(cadence.avgByWeekday[day])} / day`
						}
						theme={theme}
						testId="prompt-cadence-by-weekday"
					/>
				)}
			</div>

			<div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
				{!singleDay && (
					<PercentilesCard
						theme={theme}
						title="Prompts per Day"
						distribution={cadence.perDay}
						format={(value) => formatRate(value)}
						unitLabel="days"
					/>
				)}
				<PercentilesCard
					theme={theme}
					title="Time Between Prompts"
					distribution={cadence.gapMs}
					unitLabel={`gaps under ${formatDurationHuman(PROMPT_STRETCH_BREAK_MS)}`}
				/>
			</div>
		</div>
	);
});

export default PromptCadenceStats;
