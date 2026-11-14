import { memo, useMemo } from 'react';
import type { Theme } from '../../../types';
import type { CueHourBucket } from '../../../../shared/cue-stats-types';
import { formatHourOfDay, formatNumber } from '../../../../shared/formatters';
import { COLORBLIND_AGENT_PALETTE } from '../../../constants/colorblindPalettes';
import { ChartTooltip } from '../../widgets';
import { useBarChartFocus } from '../useBarChartFocus';

const HOUR_LABEL_INTERVAL = 3; // 0, 3, 6, ... 21 - keeps the strip readable.
const CHART_WIDTH = 600;
const CHART_HEIGHT = 160;
const PADDING = { top: 16, right: 12, bottom: 28, left: 36 };
const INNER_WIDTH = CHART_WIDTH - PADDING.left - PADDING.right;
const INNER_HEIGHT = CHART_HEIGHT - PADDING.top - PADDING.bottom;
const SLOT_WIDTH = INNER_WIDTH / 24;

function describeHour(bucket: CueHourBucket): string {
	const runs = `${formatNumber(bucket.occurrences)} ${bucket.occurrences === 1 ? 'run' : 'runs'}`;
	return `${formatHourOfDay(bucket.hour)}: ${runs}${bucket.failureCount > 0 ? `, ${formatNumber(bucket.failureCount)} failed` : ''}`;
}

/**
 * 24-bar histogram of when Cue runs in the local day. Helps the user spot
 * under-used windows when planning new schedules. Bars are colored by the
 * warning palette when the hour has any failures, so a hot-spot of trouble at
 * 3am is visible without opening a tooltip.
 */
export const HourOfDayChart = memo(function HourOfDayChart({
	buckets,
	theme,
	colorBlindMode,
}: {
	buckets: CueHourBucket[];
	theme: Theme;
	colorBlindMode: boolean;
}) {
	const max = useMemo(() => Math.max(1, ...buckets.map((b) => b.occurrences)), [buckets]);
	const tickCount = 4;
	const yTicks = useMemo(() => {
		const step = Math.max(1, Math.ceil(max / (tickCount - 1)));
		return Array.from({ length: tickCount }, (_, i) => i * step);
	}, [max]);
	const yMax = yTicks[yTicks.length - 1] || 1;
	const yScale = (value: number) => CHART_HEIGHT - PADDING.bottom - (value / yMax) * INNER_HEIGHT;
	const barWidth = Math.max(2, SLOT_WIDTH - 4);
	const baseColor = colorBlindMode ? COLORBLIND_AGENT_PALETTE[0] : theme.colors.accent;
	const failureColor = theme.colors.warning ?? theme.colors.error;
	const currentHour = useMemo(() => new Date().getHours(), []);
	const hasAnyData = buckets.some((b) => b.occurrences > 0);

	const { activeIndex, anchor, containerProps, barProps } = useBarChartFocus(buckets.length, {
		slotCenter: (index, rect) => {
			const scale = rect.width / CHART_WIDTH;
			return {
				x: rect.left + (PADDING.left + SLOT_WIDTH * index + SLOT_WIDTH / 2) * scale,
				y: rect.top + PADDING.top * scale,
			};
		},
	});
	const active = activeIndex !== null ? buckets[activeIndex] : null;

	return (
		<div
			className="p-4 rounded-lg"
			style={{ backgroundColor: theme.colors.bgMain }}
			data-testid="cue-stats-hour-of-day"
		>
			<div className="flex items-center justify-between mb-3">
				<h3 className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
					By Hour of Day
				</h3>
				<span className="text-xs" style={{ color: theme.colors.textDim }}>
					Local time
				</span>
			</div>
			{!hasAnyData ? (
				<div className="text-sm py-2" style={{ color: theme.colors.textDim }}>
					No runs in this range.
				</div>
			) : (
				<svg
					{...containerProps}
					width="100%"
					viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
					preserveAspectRatio="xMidYMid meet"
					role="group"
					aria-label="Cue runs by hour of day in local time"
					className="outline-none rounded focus-visible:ring-2"
				>
					{yTicks.map((tick, idx) => (
						<g key={`y-${idx}`}>
							<line
								x1={PADDING.left}
								y1={yScale(tick)}
								x2={CHART_WIDTH - PADDING.right}
								y2={yScale(tick)}
								stroke={theme.colors.border}
								strokeOpacity={0.3}
								strokeDasharray="4,4"
							/>
							<text
								x={PADDING.left - 8}
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

					{buckets.map((bucket, idx) => {
						const cx = PADDING.left + SLOT_WIDTH * bucket.hour + SLOT_WIDTH / 2;
						const y = yScale(bucket.occurrences);
						const height = CHART_HEIGHT - PADDING.bottom - y;
						const fill = bucket.failureCount > 0 ? failureColor : baseColor;
						const isActive = activeIndex === idx;
						return (
							<g key={`hour-${bucket.hour}`} {...barProps(idx)}>
								<rect
									x={PADDING.left + SLOT_WIDTH * bucket.hour}
									y={PADDING.top}
									width={SLOT_WIDTH}
									height={INNER_HEIGHT}
									fill="transparent"
								/>
								<rect
									x={cx - barWidth / 2}
									y={y}
									width={barWidth}
									height={Math.max(0, height)}
									fill={fill}
									opacity={bucket.occurrences === 0 ? 0.15 : isActive ? 1 : 0.85}
									rx={2}
									data-testid="cue-stats-hour-bar"
									data-hour={bucket.hour}
								/>
								{bucket.hour === currentHour && (
									<line
										x1={cx}
										x2={cx}
										y1={PADDING.top - 4}
										y2={CHART_HEIGHT - PADDING.bottom}
										stroke={theme.colors.accent}
										strokeOpacity={0.6}
										strokeDasharray="2,2"
										pointerEvents="none"
									/>
								)}
							</g>
						);
					})}

					{buckets.map((bucket) =>
						bucket.hour % HOUR_LABEL_INTERVAL === 0 ? (
							<text
								key={`x-${bucket.hour}`}
								x={PADDING.left + SLOT_WIDTH * bucket.hour + SLOT_WIDTH / 2}
								y={CHART_HEIGHT - PADDING.bottom + 16}
								textAnchor="middle"
								fontSize={10}
								fill={theme.colors.textDim}
							>
								{String(bucket.hour).padStart(2, '0')}
							</text>
						) : null
					)}
				</svg>
			)}
			<span className="sr-only" aria-live="polite">
				{active ? describeHour(active) : ''}
			</span>
			{active && (
				<ChartTooltip anchor={anchor} theme={theme} testId="cue-stats-hour-tooltip">
					{describeHour(active)}
				</ChartTooltip>
			)}
		</div>
	);
});
