/**
 * RadialActivityChart
 *
 * Polar / radial bar chart for showing temporal activity distribution.
 * Two preset modes: 24-hour clock dial (`hours`) and day-of-week wheel
 * (`weekday`).
 *
 * The visual: each slice's outward extent is proportional to its count, the
 * peak slice gets the theme accent at full opacity, and the center renders
 * a hero label (e.g. "17" / "peak hr") so the chart works as a glanceable
 * stat card on its own. Replaces the flat PeakHoursChart bar layout.
 */

import { memo, useMemo, useState } from 'react';
import type { Theme } from '../../types';
import type { StatsAggregation } from '../../hooks/stats/useStats';
import { formatDurationHuman as formatDuration, formatNumber } from '../../../shared/formatters';
import { COLORBLIND_LINE_COLORS } from '../../constants/colorblindPalettes';
import { clampTooltipToViewport } from './chartUtils';

type RadialMode = 'hours' | 'weekday';

interface RadialActivityChartProps {
	mode: RadialMode;
	data: StatsAggregation;
	theme: Theme;
	colorBlindMode?: boolean;
}

const HOUR_LABELS: Array<{ angleSlot: number; label: string }> = [
	{ angleSlot: 0, label: '12a' },
	{ angleSlot: 6, label: '6a' },
	{ angleSlot: 12, label: '12p' },
	{ angleSlot: 18, label: '6p' },
];

const WEEKDAY_FULL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

interface SliceDatum {
	index: number;
	label: string;
	count: number;
	duration: number;
}

/**
 * 12-hour clock-style hour formatter — matches the inner-ring callout
 * label "17" by exposing both the 24h slot (used internally) and the
 * 12h-with-suffix presentation (used in tooltips and the center hero).
 */
function formatHour12(hour24: number): string {
	const suffix = hour24 >= 12 ? 'PM' : 'AM';
	const displayHour = hour24 % 12 || 12;
	return `${displayHour} ${suffix}`;
}

/**
 * Compute day-of-week buckets from `byDay`. The aggregation doesn't expose
 * a pre-rolled-up weekday breakdown, so we walk `byDay` and bucket each
 * date into its local-day-of-week. Local parsing avoids the UTC shift trap
 * that bites every other "parse a YYYY-MM-DD string" call site.
 */
function bucketWeekdays(
	byDay: StatsAggregation['byDay']
): Array<{ count: number; duration: number }> {
	const buckets: Array<{ count: number; duration: number }> = WEEKDAY_FULL.map(() => ({
		count: 0,
		duration: 0,
	}));
	for (const day of byDay) {
		const parts = day.date.split('-').map(Number);
		if (parts.length !== 3 || parts.some(Number.isNaN)) continue;
		const [y, m, d] = parts;
		const dow = new Date(y, m - 1, d).getDay(); // 0=Sun
		buckets[dow].count += day.count;
		buckets[dow].duration += day.duration;
	}
	return buckets;
}

export const RadialActivityChart = memo(function RadialActivityChart({
	mode,
	data,
	theme,
	colorBlindMode = false,
}: RadialActivityChartProps) {
	const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
	const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);

	const accent = colorBlindMode ? COLORBLIND_LINE_COLORS.primary : theme.colors.accent;

	const slices = useMemo<SliceDatum[]>(() => {
		if (mode === 'hours') {
			const byHourMap = new Map<number, { count: number; duration: number }>();
			for (let h = 0; h < 24; h++) byHourMap.set(h, { count: 0, duration: 0 });
			for (const entry of data.byHour ?? []) {
				byHourMap.set(entry.hour, { count: entry.count, duration: entry.duration });
			}
			return Array.from({ length: 24 }, (_, i) => {
				const stats = byHourMap.get(i)!;
				return { index: i, label: formatHour12(i), count: stats.count, duration: stats.duration };
			});
		}
		// weekday mode
		const buckets = bucketWeekdays(data.byDay ?? []);
		return WEEKDAY_FULL.map((label, i) => ({
			index: i,
			label,
			count: buckets[i].count,
			duration: buckets[i].duration,
		}));
	}, [mode, data.byHour, data.byDay]);

	const peak = useMemo(() => {
		let best: SliceDatum | null = null;
		for (const slice of slices) {
			if (slice.count > 0 && (!best || slice.count > best.count)) best = slice;
		}
		return best;
	}, [slices]);

	const totalCount = useMemo(() => slices.reduce((sum, s) => sum + s.count, 0), [slices]);

	// Geometry. SVG uses a 0-360° polar layout; slot 0 is at 12 o'clock,
	// proceeding clockwise. The math is the same for both modes — only the
	// slot count changes.
	const slotCount = slices.length;
	const sliceAngle = 360 / slotCount;
	const innerRadius = mode === 'hours' ? 72 : 60;
	const outerRadius = 130;
	const maxBarLength = outerRadius - innerRadius - 6;
	const maxCount = Math.max(1, ...slices.map((s) => s.count));
	const viewBoxSize = (outerRadius + 24) * 2;
	const cx = viewBoxSize / 2;
	const cy = viewBoxSize / 2;

	const sectorPath = (index: number, value: number): string => {
		const lengthRatio = value / maxCount;
		const length = Math.max(2, lengthRatio * maxBarLength);
		const r = innerRadius + length;
		// Center the slice on its slot so the 0-slot points straight up.
		const startAngle = index * sliceAngle - sliceAngle / 2 - 90;
		const endAngle = startAngle + sliceAngle;
		const startRad = (startAngle * Math.PI) / 180;
		const endRad = (endAngle * Math.PI) / 180;
		const sx1 = cx + innerRadius * Math.cos(startRad);
		const sy1 = cy + innerRadius * Math.sin(startRad);
		const sx2 = cx + r * Math.cos(startRad);
		const sy2 = cy + r * Math.sin(startRad);
		const ex1 = cx + r * Math.cos(endRad);
		const ey1 = cy + r * Math.sin(endRad);
		const ex2 = cx + innerRadius * Math.cos(endRad);
		const ey2 = cy + innerRadius * Math.sin(endRad);
		// Two-arc path: outer rim CCW from start to end, then back along the inner rim.
		// `0` for largeArcFlag is fine here since each slice is < 180°.
		return [
			`M ${sx1} ${sy1}`,
			`L ${sx2} ${sy2}`,
			`A ${r} ${r} 0 0 1 ${ex1} ${ey1}`,
			`L ${ex2} ${ey2}`,
			`A ${innerRadius} ${innerRadius} 0 0 0 ${sx1} ${sy1}`,
			'Z',
		].join(' ');
	};

	const labelPosition = (slot: number) => {
		const angle = slot * sliceAngle - 90;
		const rad = (angle * Math.PI) / 180;
		const r = outerRadius + 12;
		return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
	};

	// Center hero text — bottom line of metric / "peak hr" / "peak day" label.
	const heroValue = peak ? (mode === 'hours' ? String(peak.index % 12 || 12) : peak.label) : '—';
	const heroSuffix = mode === 'hours' ? 'peak hr' : 'peak day';

	const hovered = hoveredIndex != null ? slices[hoveredIndex] : null;

	const handleMouseEnter = (index: number, e: React.MouseEvent<SVGPathElement>) => {
		setHoveredIndex(index);
		const rect = e.currentTarget.getBoundingClientRect();
		setTooltipPos({ x: rect.left + rect.width / 2, y: rect.top });
	};
	const handleMouseLeave = () => {
		setHoveredIndex(null);
		setTooltipPos(null);
	};

	// Footer summary — different per mode.
	const footer = peak ? (
		mode === 'hours' ? (
			<>
				Peak:{' '}
				<strong style={{ color: theme.colors.textMain }}>
					{formatHour12(peak.index)}–{formatHour12((peak.index + 1) % 24)}
				</strong>{' '}
				<span style={{ color: theme.colors.textDim }}>({formatNumber(peak.count)} events)</span>
			</>
		) : (
			<>
				Most active: <strong style={{ color: theme.colors.textMain }}>{peak.label}</strong>{' '}
				<span style={{ color: theme.colors.textDim }}>({formatNumber(peak.count)} events)</span>
			</>
		)
	) : (
		<span style={{ color: theme.colors.textDim }}>No data in this range</span>
	);

	return (
		<div
			className="p-4 rounded-lg"
			style={{ backgroundColor: theme.colors.bgMain }}
			role="figure"
			aria-label={
				mode === 'hours'
					? 'Activity distribution across the 24-hour clock'
					: 'Activity distribution across days of the week'
			}
		>
			<h3
				className="text-xs font-medium uppercase tracking-wide mb-2"
				style={{ color: theme.colors.textDim, animation: 'card-enter 0.4s ease both' }}
			>
				{mode === 'hours' ? 'Activity by Hour (Local Time)' : 'Activity by Day of Week'}
			</h3>
			<div className="relative flex items-center justify-center">
				{totalCount === 0 ? (
					<div className="h-48 flex items-center justify-center">
						<span className="text-sm" style={{ color: theme.colors.textDim }}>
							No data in this range
						</span>
					</div>
				) : (
					<svg
						width="100%"
						viewBox={`0 0 ${viewBoxSize} ${viewBoxSize}`}
						style={{ maxWidth: 320 }}
						role="img"
						aria-label={`${mode === 'hours' ? 'Hourly' : 'Weekday'} activity radial chart`}
					>
						{/* Background rim — gives structure when most slots are near zero. */}
						<circle
							cx={cx}
							cy={cy}
							r={outerRadius}
							fill="none"
							stroke={theme.colors.border}
							strokeOpacity={0.25}
							strokeDasharray="2 4"
						/>

						{slices.map((slice) => {
							const isPeak = peak && slice.index === peak.index;
							const isHovered = hoveredIndex === slice.index;
							const opacity = slice.count === 0 ? 0.15 : isPeak ? 1 : isHovered ? 0.95 : 0.55;
							return (
								<path
									key={slice.index}
									d={sectorPath(slice.index, slice.count)}
									fill={accent}
									opacity={opacity}
									onMouseEnter={(e) => handleMouseEnter(slice.index, e)}
									onMouseLeave={handleMouseLeave}
									style={{ transition: 'opacity 0.2s ease', cursor: 'pointer' }}
								/>
							);
						})}

						{/* Outer slot labels. Hours show only N/E/S/W cardinals to avoid clutter; weekdays show all 7. */}
						{(mode === 'hours'
							? HOUR_LABELS
							: WEEKDAY_FULL.map((label, i) => ({ angleSlot: i, label }))
						).map((entry) => {
							const pos = labelPosition(entry.angleSlot);
							return (
								<text
									key={entry.label}
									x={pos.x}
									y={pos.y}
									textAnchor="middle"
									dominantBaseline="middle"
									fontSize={11}
									fill={theme.colors.textDim}
								>
									{entry.label}
								</text>
							);
						})}

						{/* Center disc + hero callout. */}
						<circle
							cx={cx}
							cy={cy}
							r={innerRadius - 4}
							fill={theme.colors.bgActivity}
							stroke={theme.colors.border}
							strokeOpacity={0.3}
						/>
						<text
							x={cx}
							y={cy - 4}
							textAnchor="middle"
							dominantBaseline="middle"
							fontSize={mode === 'hours' ? 32 : 20}
							fontWeight={700}
							fill={accent}
						>
							{heroValue}
						</text>
						<text
							x={cx}
							y={cy + 18}
							textAnchor="middle"
							dominantBaseline="middle"
							fontSize={10}
							fill={theme.colors.textDim}
							style={{ letterSpacing: '0.04em' }}
						>
							{heroSuffix}
						</text>
					</svg>
				)}

				{hovered &&
					tooltipPos &&
					(() => {
						const tooltipWidth = 220;
						const tooltipHeight = 60;
						const { left, top } = clampTooltipToViewport({
							anchorX: tooltipPos.x,
							anchorY: tooltipPos.y - 8,
							width: tooltipWidth,
							height: tooltipHeight,
							transform: 'top-center',
						});
						return (
							<div
								className="fixed z-50 px-3 py-2 rounded text-xs whitespace-nowrap pointer-events-none shadow-lg"
								style={{
									left,
									top,
									backgroundColor: theme.colors.bgActivity,
									color: theme.colors.textMain,
									border: `1px solid ${theme.colors.border}`,
								}}
							>
								<div className="font-medium mb-1">
									{mode === 'hours'
										? `${formatHour12(hovered.index)}–${formatHour12((hovered.index + 1) % 24)}`
										: WEEKDAY_FULL[hovered.index]}
								</div>
								<div style={{ color: theme.colors.textDim }}>
									<div>{formatNumber(hovered.count)} events</div>
									{hovered.duration > 0 && <div>{formatDuration(hovered.duration)} total</div>}
								</div>
							</div>
						);
					})()}
			</div>
			<div
				className="mt-3 pt-3 border-t text-xs text-center"
				style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
			>
				{footer}
			</div>
		</div>
	);
});

export default RadialActivityChart;
