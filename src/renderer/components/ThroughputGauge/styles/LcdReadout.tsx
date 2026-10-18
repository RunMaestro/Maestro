/**
 * LcdReadout - the Throughput Gauge's digital display style.
 *
 * A tinted panel with the reading in big fixed-pitch digits, dim "ghost" 8s
 * behind them the way an unlit seven-segment display shows every segment
 * faintly, the metric name as a small caption in the corner, and the peak on a
 * smaller line underneath.
 *
 * The digits use the user's own fixed-pitch font (`useFixedPitchFont`), so the
 * ghosts line up under the lit digits character for character. The digit count
 * follows the scale, not the reading, so the display does not change width as
 * the reading crosses a power of ten.
 */

import { memo } from 'react';
import { readableTextOn, transparentize } from '../../../../shared/colorContrast';
import { useFixedPitchFont } from '../../../hooks/ui/useFixedPitchFont';
import { useSurfaceFontFamily } from '../../../hooks/ui/useSurfaceTypography';
import { GaugeLegend } from './GaugeLegend';
import { GAUGE_UNIT, type GaugeStyleProps } from './types';

/** Fewest digit cells the display shows, so an idle gauge is not a single 0. */
const MIN_DIGITS = 3;
/** Width of one fixed-pitch character, as a fraction of the font size. */
const CHAR_ADVANCE = 0.62;

const VIEW_HEIGHT = 112;
const VIEW_WIDTH = { full: 200, compact: 140 } as const;
const PANEL_INSET = 3;
const PADDING = 10;
const MAX_DIGIT_SIZE = 46;

/** A rate as the display prints it: a whole number, never abbreviated. */
export function lcdDigits(rate: number): string {
	return String(Math.max(0, Math.round(Number.isFinite(rate) ? rate : 0)));
}

/** How many digit cells a display needs to show any reading up to `max`. */
export function lcdCellCount(max: number): number {
	return Math.max(MIN_DIGITS, lcdDigits(max).length);
}

export const LcdReadout = memo(function LcdReadout({
	theme,
	value,
	peak,
	max,
	label,
	caption,
	compact,
}: GaugeStyleProps) {
	const { colors } = theme;
	const monoFont = useFixedPitchFont(useSurfaceFontFamily('terminal'));

	const panel = transparentize(colors.accent, colors.bgMain, 0.08);
	const panelBorder = transparentize(colors.accent, colors.bgMain, 0.3);
	const segmentOn = readableTextOn(colors.accent, [panel]);
	const segmentGhost = transparentize(segmentOn, panel, 0.1);
	const segmentDim = transparentize(segmentOn, panel, 0.6);

	const reading = lcdDigits(value);
	const peakReading = lcdDigits(peak);
	const cells = Math.max(lcdCellCount(max), reading.length, peakReading.length);
	const ghost = '8'.repeat(cells);

	const width = compact ? VIEW_WIDTH.compact : VIEW_WIDTH.full;
	const right = width - PANEL_INSET - PADDING;
	const digitSize = Math.min(
		MAX_DIGIT_SIZE,
		(width - 2 * (PANEL_INSET + PADDING)) / (cells * CHAR_ADVANCE)
	);
	const peakSize = Math.min(14, digitSize * 0.4);
	const textStyle = { fontFamily: monoFont, fontVariantNumeric: 'tabular-nums' } as const;

	return (
		<div
			className="w-full h-full min-w-0 min-h-0 flex flex-col items-center gap-0.5"
			data-testid="throughput-style-lcd"
			data-gauge-max={max}
		>
			<svg
				viewBox={`0 0 ${width} ${VIEW_HEIGHT}`}
				className="block w-full flex-1 min-h-0"
				role="meter"
				aria-label={`${label} throughput ${reading} ${GAUGE_UNIT}`}
				aria-valuemin={0}
				aria-valuemax={max}
				aria-valuenow={Math.round(value)}
			>
				<rect
					x={PANEL_INSET}
					y={PANEL_INSET}
					width={width - 2 * PANEL_INSET}
					height={VIEW_HEIGHT - 2 * PANEL_INSET}
					rx={6}
					fill={panel}
					stroke={panelBorder}
					strokeWidth={1}
				/>

				<text
					x={PANEL_INSET + PADDING}
					y={PANEL_INSET + PADDING + 5}
					fill={segmentDim}
					fontSize={9}
					letterSpacing={1}
					style={textStyle}
					data-testid="throughput-gauge-label"
				>
					{label.toUpperCase()}
				</text>
				<text
					x={right}
					y={PANEL_INSET + PADDING + 5}
					fill={segmentDim}
					fontSize={9}
					letterSpacing={1}
					textAnchor="end"
					style={textStyle}
				>
					{GAUGE_UNIT.toUpperCase()}
				</text>

				{/* Ghosts and lit digits share one right edge and one font, so each
				    lit digit lands on the ghost cell behind it. */}
				<text
					x={right}
					y={70}
					fill={segmentGhost}
					fontSize={digitSize}
					textAnchor="end"
					style={textStyle}
					aria-hidden
				>
					{ghost}
				</text>
				<text
					x={right}
					y={70}
					fill={segmentOn}
					fontSize={digitSize}
					textAnchor="end"
					style={textStyle}
					data-testid="throughput-gauge-reading"
				>
					{reading}
				</text>

				<text
					x={PANEL_INSET + PADDING}
					y={VIEW_HEIGHT - PANEL_INSET - PADDING}
					fill={segmentDim}
					fontSize={9}
					letterSpacing={1}
					style={textStyle}
				>
					PEAK
				</text>
				<text
					x={right}
					y={VIEW_HEIGHT - PANEL_INSET - PADDING}
					fill={segmentGhost}
					fontSize={peakSize}
					textAnchor="end"
					style={textStyle}
					aria-hidden
				>
					{ghost}
				</text>
				<text
					x={right}
					y={VIEW_HEIGHT - PANEL_INSET - PADDING}
					fill={segmentOn}
					fontSize={peakSize}
					textAnchor="end"
					style={textStyle}
					data-testid="throughput-gauge-peak"
				>
					{peakReading}
				</text>
			</svg>
			<GaugeLegend theme={theme} caption={caption} />
		</div>
	);
});
