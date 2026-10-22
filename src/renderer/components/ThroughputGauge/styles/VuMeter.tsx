/**
 * VuMeter - the Throughput Gauge's segmented bar style.
 *
 * A vertical stack of segments that fills bottom to top, shading from the
 * theme's success color through warning to error as it nears the ceiling, the
 * way a recording meter warns before it clips. The segment holding the peak
 * stays lit after the reading falls away, and the reading prints under the bar.
 *
 * Every color comes from the theme, mixed with `blendColors()`: unlit segments
 * are their own color faded into the card, so the bar keeps its shape at idle.
 */

import { memo } from 'react';
import { blendColors, readableTextOn, transparentize } from '../../../../shared/colorContrast';
import { formatNumber } from '../../../../shared/formatters';
import { gaugeFraction } from '../gaugeScale';
import { GaugeLegend } from './GaugeLegend';
import { formatGaugeRate, GAUGE_UNIT, type GaugeStyleProps } from './types';
import type { ThemeColors } from '../../../types';

/** How many segments the bar is cut into. */
export const VU_SEGMENTS = 20;
/** Fraction of the bar where the segments start turning warning, then error. */
const WARNING_FROM = 0.6;
const ERROR_FROM = 0.85;

const VIEW_WIDTH = 120;
const VIEW_HEIGHT = 196;
const BAR_TOP = 6;
const BAR_BOTTOM = 146;
const SEGMENT_GAP = 1.5;
const SEGMENT_HEIGHT = (BAR_BOTTOM - BAR_TOP - SEGMENT_GAP * (VU_SEGMENTS - 1)) / VU_SEGMENTS;
/** The full meter keeps room for its scale on the right; the compact one drops it and centers the bar. */
const BAR_WIDTH = { full: 34, compact: 40 } as const;

/** Segment color at a point up the bar: success, easing to warning, then to error. */
export function vuSegmentColor(colors: ThemeColors, fraction: number): string {
	if (fraction < WARNING_FROM) return colors.success;
	if (fraction < ERROR_FROM) {
		return blendColors(
			colors.success,
			colors.warning,
			(fraction - WARNING_FROM) / (ERROR_FROM - WARNING_FROM)
		);
	}
	return blendColors(colors.warning, colors.error, (fraction - ERROR_FROM) / (1 - ERROR_FROM));
}

/** How many segments a reading lights, counted from the bottom. */
export function vuLitSegments(value: number, max: number): number {
	return Math.round(gaugeFraction(value, max) * VU_SEGMENTS);
}

/** Index of the segment the peak holds, or -1 with no peak. */
export function vuPeakSegment(peak: number, max: number): number {
	const fraction = gaugeFraction(peak, max);
	if (fraction <= 0) return -1;
	return Math.min(VU_SEGMENTS - 1, Math.ceil(fraction * VU_SEGMENTS) - 1);
}

export const VuMeter = memo(function VuMeter({
	theme,
	value,
	peak,
	max,
	label,
	caption,
	compact,
}: GaugeStyleProps) {
	const { colors } = theme;
	const lit = vuLitSegments(value, max);
	const peakIndex = vuPeakSegment(peak, max);
	const barWidth = compact ? BAR_WIDTH.compact : BAR_WIDTH.full;
	const barX = compact ? (VIEW_WIDTH - barWidth) / 2 : 36;
	const reading = formatGaugeRate(value);
	const peakReading = formatGaugeRate(peak);
	const peakText = readableTextOn(colors.warning, [colors.bgSidebar]);

	const segments = Array.from({ length: VU_SEGMENTS }, (_, index) => {
		const color = vuSegmentColor(colors, (index + 0.5) / VU_SEGMENTS);
		const on = index < lit || index === peakIndex;
		return {
			index,
			y: BAR_BOTTOM - (index + 1) * SEGMENT_HEIGHT - index * SEGMENT_GAP,
			fill: on ? color : transparentize(color, colors.bgSidebar, 0.16),
			isPeak: index === peakIndex,
		};
	});

	const scaleX = barX + barWidth + 6;
	const scaleMarks = compact
		? []
		: [1, 0.5, 0].map((fraction) => ({
				key: fraction,
				y: BAR_BOTTOM - fraction * (BAR_BOTTOM - BAR_TOP),
				text: formatNumber(max * fraction),
			}));

	return (
		<div
			className="w-full h-full min-w-0 min-h-0 flex flex-col items-center"
			data-testid="throughput-style-vu"
			data-gauge-max={max}
		>
			<svg
				viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
				className="block w-full flex-1 min-h-0"
				role="meter"
				aria-label={`${label} throughput ${reading} ${GAUGE_UNIT}`}
				aria-valuemin={0}
				aria-valuemax={max}
				aria-valuenow={Math.round(value)}
			>
				{segments.map((segment) => (
					<rect
						key={segment.index}
						x={barX}
						y={segment.y}
						width={barWidth}
						height={SEGMENT_HEIGHT}
						rx={1}
						fill={segment.fill}
						stroke={segment.isPeak ? colors.textMain : 'none'}
						strokeWidth={segment.isPeak ? 0.75 : 0}
						data-testid={segment.isPeak ? 'throughput-vu-peak-segment' : undefined}
						data-lit={segment.index < lit ? 'true' : undefined}
						style={{ transition: 'fill 120ms linear' }}
					/>
				))}
				{scaleMarks.map((mark) => (
					<text
						key={mark.key}
						x={scaleX}
						y={mark.y}
						fill={colors.textDim}
						fontSize={8}
						dominantBaseline="middle"
					>
						{mark.text}
					</text>
				))}

				<text
					x={VIEW_WIDTH / 2}
					y={BAR_BOTTOM + 22}
					fill={colors.textMain}
					fontSize={20}
					fontWeight={600}
					textAnchor="middle"
					data-testid="throughput-gauge-reading"
				>
					{reading}
				</text>
				<text
					x={VIEW_WIDTH / 2}
					y={BAR_BOTTOM + 34}
					fill={colors.textDim}
					fontSize={9}
					textAnchor="middle"
				>
					{GAUGE_UNIT}
				</text>
				<text
					x={VIEW_WIDTH / 2}
					y={BAR_BOTTOM + 46}
					fill={peakText}
					fontSize={8}
					letterSpacing={0.5}
					textAnchor="middle"
					data-testid="throughput-gauge-peak"
				>
					{`PEAK ${peakReading}`}
				</text>
			</svg>
			<GaugeLegend theme={theme} label={label} caption={caption} />
		</div>
	);
});
