/**
 * SparklineStyle - the Throughput Gauge's trend style.
 *
 * The current reading large on top, and under it the last
 * `THROUGHPUT_HISTORY_LENGTH` readings (fifteen seconds at four a second) as a
 * filled line, with a dashed mark at the peak. Draws through the shared
 * `Sparkline` widget, on the card's shared scale (`domain` 0..`max`) so the
 * three charts of the "All three" layout are comparable and the line does not
 * re-normalize itself every tick.
 *
 * The chart is sized to its box in real pixels, so it fills the card at any
 * size rather than letterboxing a fixed aspect.
 */

import { memo, useRef } from 'react';
import { readableTextOn } from '../../../../shared/colorContrast';
import { useElementHeight, useElementWidth } from '../../../hooks/ui/useElementWidth';
import { Sparkline } from '../../widgets/output/Sparkline';
import { GaugeLegend } from './GaugeLegend';
import { formatGaugeRate, GAUGE_UNIT, type GaugeStyleProps } from './types';

/**
 * Chart size before the first measurement lands (and in jsdom, which never
 * measures). One frame at this size is better than a chart that pops in late.
 */
const FALLBACK_CHART = { width: 160, height: 56 } as const;

export const SparklineStyle = memo(function SparklineStyle({
	theme,
	value,
	peak,
	max,
	label,
	caption,
	history,
	compact,
}: GaugeStyleProps) {
	const { colors } = theme;
	const chartRef = useRef<HTMLDivElement>(null);
	const measuredWidth = useElementWidth(chartRef);
	const measuredHeight = useElementHeight(chartRef);
	const chartWidth = measuredWidth || FALLBACK_CHART.width;
	const chartHeight = measuredHeight || FALLBACK_CHART.height;

	const reading = formatGaugeRate(value);
	const peakReading = formatGaugeRate(peak);
	const peakColor = readableTextOn(colors.warning, [colors.bgSidebar]);
	// The number grows with the card, within reason.
	const readingSize = Math.round(
		Math.min(compact ? 22 : 30, Math.max(14, chartWidth / (compact ? 6 : 7)))
	);

	return (
		<div
			className="w-full h-full min-w-0 min-h-0 flex flex-col gap-1 px-1"
			data-testid="throughput-style-sparkline"
			data-gauge-max={max}
			role="meter"
			aria-label={`${label} throughput ${reading} ${GAUGE_UNIT}`}
			aria-valuemin={0}
			aria-valuemax={max}
			aria-valuenow={Math.round(value)}
		>
			<div className="shrink-0 flex items-baseline gap-1 min-w-0">
				<span
					className="font-semibold leading-none tabular-nums"
					style={{ color: colors.textMain, fontSize: readingSize }}
					data-testid="throughput-gauge-reading"
				>
					{reading}
				</span>
				<span className="text-2xs" style={{ color: colors.textDim }}>
					{GAUGE_UNIT}
				</span>
				<span
					className="ml-auto text-2xs tabular-nums truncate"
					style={{ color: peakColor }}
					title={`Peak ${peakReading} ${GAUGE_UNIT}`}
					data-testid="throughput-gauge-peak"
				>
					{`PEAK ${peakReading}`}
				</span>
			</div>
			<div ref={chartRef} className="flex-1 min-h-0 w-full overflow-hidden">
				<Sparkline
					data={history}
					width={chartWidth}
					height={chartHeight}
					color={colors.accent}
					fillOpacity={0.2}
					strokeWidth={compact ? 1.25 : 1.5}
					domain={{ min: 0, max }}
					reference={
						peak > 0
							? { value: peak, color: peakColor, label: `Peak ${peakReading} ${GAUGE_UNIT}` }
							: undefined
					}
				/>
			</div>
			<GaugeLegend theme={theme} label={label} caption={caption} />
		</div>
	);
});
