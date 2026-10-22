/**
 * AnalogDial - the Throughput Gauge's speedometer style.
 *
 * A 270 degree arc with the open side at the bottom, a needle, tick labels, a
 * peak mark, and the reading in numbers underneath. The arc runs 0..`max`,
 * where `max` is the card's shared scale (`niceGaugeMax`).
 *
 * Readings arrive four times a second, so the needle and the value arc ease
 * between them with a CSS transition rather than jumping. The compact variant
 * (three dials on one card) drops the tick numbers, which would be unreadably
 * small there.
 */

import { memo } from 'react';
import { formatNumber } from '../../../../shared/formatters';
import { readableTextOn, transparentize } from '../../../../shared/colorContrast';
import { gaugeFraction } from '../gaugeScale';
import { GaugeLegend } from './GaugeLegend';
import { formatGaugeRate, GAUGE_UNIT, type GaugeStyleProps } from './types';

/** Sweep geometry, in SVG degrees (0 = +x, clockwise because y points down). */
const START_DEG = 135;
const SWEEP_DEG = 270;
const MAJOR_DIVISIONS = 5;

const VIEW_WIDTH = 200;
const VIEW_HEIGHT = 174;
const CX = 100;
const CY = 96;
const ARC_RADIUS = 78;
const ARC_WIDTH = 8;
const LABEL_RADIUS = 56;
const NEEDLE_LENGTH = 64;

/** Normalized path length, so the value arc is a plain dash of 0-100. */
const ARC_PATH_LENGTH = 100;

/** How long the needle eases between readings; matches the 250ms publish tick. */
const NEEDLE_TRANSITION = 'transform 240ms ease-out, stroke-dasharray 240ms ease-out';

function polar(deg: number, radius: number): { x: number; y: number } {
	const rad = (deg * Math.PI) / 180;
	return { x: CX + radius * Math.cos(rad), y: CY + radius * Math.sin(rad) };
}

const arcStart = polar(START_DEG, ARC_RADIUS);
const arcEnd = polar(START_DEG + SWEEP_DEG, ARC_RADIUS);
/** The whole track. Large-arc flag 1: the sweep is more than half a circle. */
const ARC_PATH = `M ${arcStart.x} ${arcStart.y} A ${ARC_RADIUS} ${ARC_RADIUS} 0 1 1 ${arcEnd.x} ${arcEnd.y}`;

function angleOf(fraction: number): number {
	return START_DEG + SWEEP_DEG * fraction;
}

export const AnalogDial = memo(function AnalogDial({
	theme,
	value,
	peak,
	max,
	label,
	caption,
	compact,
}: GaugeStyleProps) {
	const { colors } = theme;
	const valueFraction = gaugeFraction(value, max);
	const peakFraction = gaugeFraction(peak, max);

	const trackColor = transparentize(colors.textDim, colors.bgSidebar, 0.25);
	const minorTickColor = transparentize(colors.textDim, colors.bgSidebar, 0.5);

	const majorTicks = Array.from({ length: MAJOR_DIVISIONS + 1 }, (_, index) => {
		const fraction = index / MAJOR_DIVISIONS;
		const angle = angleOf(fraction);
		return {
			key: index,
			outer: polar(angle, ARC_RADIUS - ARC_WIDTH / 2 - 2),
			inner: polar(angle, ARC_RADIUS - ARC_WIDTH / 2 - 9),
			label: polar(angle, LABEL_RADIUS),
			text: formatNumber((max * index) / MAJOR_DIVISIONS),
		};
	});
	const minorTicks = Array.from({ length: MAJOR_DIVISIONS }, (_, index) => {
		const angle = angleOf((index + 0.5) / MAJOR_DIVISIONS);
		return {
			key: index,
			outer: polar(angle, ARC_RADIUS - ARC_WIDTH / 2 - 2),
			inner: polar(angle, ARC_RADIUS - ARC_WIDTH / 2 - 6),
		};
	});

	const peakAngle = angleOf(peakFraction);
	const peakOuter = polar(peakAngle, ARC_RADIUS + ARC_WIDTH / 2 + 3);
	const peakInner = polar(peakAngle, ARC_RADIUS - ARC_WIDTH / 2 - 1);

	const reading = formatGaugeRate(value);
	const peakReading = formatGaugeRate(peak);
	const peakText = readableTextOn(colors.warning, [colors.bgSidebar]);

	return (
		<div
			className="w-full h-full min-w-0 min-h-0 flex flex-col items-center"
			data-testid="throughput-style-dial"
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
				<path
					d={ARC_PATH}
					fill="none"
					stroke={trackColor}
					strokeWidth={ARC_WIDTH}
					strokeLinecap="round"
				/>
				{/* The filled portion is the same path dashed to the reading, so it eases
				    with the needle instead of being rebuilt as a new arc each tick. */}
				<path
					d={ARC_PATH}
					fill="none"
					stroke={colors.accent}
					strokeWidth={ARC_WIDTH}
					strokeLinecap="round"
					pathLength={ARC_PATH_LENGTH}
					strokeDasharray={`${valueFraction * ARC_PATH_LENGTH} ${ARC_PATH_LENGTH}`}
					opacity={valueFraction > 0 ? 1 : 0}
					style={{ transition: NEEDLE_TRANSITION }}
				/>

				{!compact &&
					minorTicks.map((tick) => (
						<line
							key={`minor-${tick.key}`}
							x1={tick.outer.x}
							y1={tick.outer.y}
							x2={tick.inner.x}
							y2={tick.inner.y}
							stroke={minorTickColor}
							strokeWidth={1}
						/>
					))}
				{majorTicks.map((tick) => (
					<g key={`major-${tick.key}`}>
						<line
							x1={tick.outer.x}
							y1={tick.outer.y}
							x2={tick.inner.x}
							y2={tick.inner.y}
							stroke={colors.textDim}
							strokeWidth={1.5}
						/>
						{!compact && (
							<text
								x={tick.label.x}
								y={tick.label.y}
								fill={colors.textDim}
								fontSize={9}
								textAnchor="middle"
								dominantBaseline="middle"
							>
								{tick.text}
							</text>
						)}
					</g>
				))}

				{peakFraction > 0 && (
					<line
						data-testid="throughput-dial-peak"
						x1={peakOuter.x}
						y1={peakOuter.y}
						x2={peakInner.x}
						y2={peakInner.y}
						stroke={colors.warning}
						strokeWidth={2.5}
						strokeLinecap="round"
					>
						<title>{`Peak ${peakReading} ${GAUGE_UNIT}`}</title>
					</line>
				)}

				{/* Drawn pointing at 0 degrees and rotated, so a reading change is one
				    transform the browser can ease. */}
				<g
					style={{
						transform: `rotate(${angleOf(valueFraction)}deg)`,
						transformOrigin: `${CX}px ${CY}px`,
						transformBox: 'view-box',
						transition: NEEDLE_TRANSITION,
					}}
				>
					<line
						x1={CX - 10}
						y1={CY}
						x2={CX + NEEDLE_LENGTH}
						y2={CY}
						stroke={colors.textMain}
						strokeWidth={2.5}
						strokeLinecap="round"
					/>
				</g>
				<circle cx={CX} cy={CY} r={5.5} fill={colors.accent} />
				<circle cx={CX} cy={CY} r={2} fill={colors.bgSidebar} />

				<text
					x={CX}
					y={CY + 42}
					fill={colors.textMain}
					fontSize={22}
					fontWeight={600}
					textAnchor="middle"
					data-testid="throughput-gauge-reading"
				>
					{reading}
				</text>
				<text x={CX} y={CY + 56} fill={colors.textDim} fontSize={9} textAnchor="middle">
					{GAUGE_UNIT}
				</text>
				<text
					x={CX}
					y={CY + 70}
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
