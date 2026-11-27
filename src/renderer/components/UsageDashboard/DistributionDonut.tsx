/**
 * DistributionDonut
 *
 * The donut + legend + hover tooltip both Overview distribution charts (Query
 * Source and Query Location) draw. The two charts used to be line-for-line
 * copies of this markup; they now only decide WHAT the slices are.
 *
 * Presentational: slices arrive with their values and colors. Zero-value
 * slices are dropped here, so a category with no activity in range is not
 * drawn as a sliver.
 */

import { memo, useMemo, useState, type MouseEvent } from 'react';
import type { Theme } from '../../types';
import { ChartTooltip } from '../widgets';
import { DONUT_CHART, describeDonutArc } from './chartUtils';

export interface DonutSliceDatum {
	key: string;
	label: string;
	value: number;
	color: string;
}

interface DistributionDonutProps {
	slices: DonutSliceDatum[];
	theme: Theme;
	/** Formats a slice value and the center total. */
	formatValue: (value: number) => string;
	/** Line under the center total (e.g. "queries", "time"). */
	centerCaption: string;
	/** Prefix of the SVG's accessible name; the slice shares are appended. */
	ariaLabel: string;
	testId?: string;
}

export const DistributionDonut = memo(function DistributionDonut({
	slices,
	theme,
	formatValue,
	centerCaption,
	ariaLabel,
	testId,
}: DistributionDonutProps) {
	const [hovered, setHovered] = useState<string | null>(null);
	const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);

	const { visible, total } = useMemo(() => {
		const nonZero = slices.filter((slice) => slice.value > 0);
		const sum = nonZero.reduce((acc, slice) => acc + slice.value, 0);
		let angle = 0;
		const withArcs = nonZero.map((slice) => {
			const percentage = sum > 0 ? (slice.value / sum) * 100 : 0;
			const startAngle = angle;
			angle += (percentage / 100) * 360;
			return { ...slice, percentage, startAngle, endAngle: angle };
		});
		return { visible: withArcs, total: sum };
	}, [slices]);

	const { size, outerRadius, innerRadius, hoverExpansion, centerLabelWidth } = DONUT_CHART;
	const center = size / 2;
	const hoveredSlice = visible.find((slice) => slice.key === hovered) ?? null;

	const enter = (key: string, event: MouseEvent) => {
		setHovered(key);
		setAnchor({ x: event.clientX, y: event.clientY });
	};
	const move = (event: MouseEvent) => setAnchor({ x: event.clientX, y: event.clientY });
	const leave = () => {
		setHovered(null);
		setAnchor(null);
	};

	return (
		<div className="flex flex-wrap items-center justify-center gap-8" data-testid={testId}>
			<div className="relative">
				<svg
					width={size}
					height={size}
					viewBox={`0 0 ${size} ${size}`}
					role="img"
					aria-label={`${ariaLabel}: ${visible
						.map((slice) => `${slice.label} ${slice.percentage.toFixed(1)}%`)
						.join(', ')}`}
				>
					{visible.map((slice) => (
						<path
							key={slice.key}
							d={describeDonutArc(
								center,
								center,
								hovered === slice.key ? outerRadius + hoverExpansion : outerRadius,
								innerRadius,
								slice.startAngle,
								slice.endAngle
							)}
							fill={slice.color}
							opacity={hovered === null || hovered === slice.key ? 1 : 0.5}
							style={{ transition: 'd 0.5s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.2s ease' }}
							onMouseEnter={(event) => enter(slice.key, event)}
							onMouseMove={move}
							onMouseLeave={leave}
							data-testid={`donut-slice-${slice.key}`}
						/>
					))}
				</svg>
				<div
					className="absolute inset-0 flex flex-col items-center justify-center"
					style={{ pointerEvents: 'none' }}
				>
					<span
						className="text-lg font-semibold leading-tight text-center truncate"
						style={{ color: theme.colors.textMain, maxWidth: centerLabelWidth }}
					>
						{formatValue(total)}
					</span>
					<span className="text-xs" style={{ color: theme.colors.textDim }}>
						{centerCaption}
					</span>
				</div>
			</div>

			{/* The legend carries every value in text, so nothing here is hover-only. */}
			<div className="flex flex-col gap-3" role="list" aria-label="Chart legend">
				{visible.map((slice) => (
					<div
						key={slice.key}
						className="flex items-center gap-3"
						onMouseEnter={(event) => enter(slice.key, event)}
						onMouseMove={move}
						onMouseLeave={leave}
						role="listitem"
						aria-label={`${slice.label}: ${slice.percentage.toFixed(1)}%, ${formatValue(slice.value)}`}
					>
						<div
							className="w-3 h-3 rounded-sm flex-shrink-0"
							style={{ backgroundColor: slice.color }}
						/>
						<div className="flex flex-col">
							<span
								className="text-sm font-medium"
								style={{
									color: hovered === slice.key ? theme.colors.textMain : theme.colors.textDim,
								}}
							>
								{slice.label}
							</span>
							<span className="text-xs" style={{ color: theme.colors.textDim }}>
								{slice.percentage.toFixed(1)}% - {formatValue(slice.value)}
							</span>
						</div>
					</div>
				))}
			</div>

			{hoveredSlice && (
				<ChartTooltip anchor={anchor} theme={theme} width={200} height={52} testId="donut-tooltip">
					<div className="font-medium mb-1 flex items-center gap-2">
						<span className="w-2 h-2 rounded-sm" style={{ backgroundColor: hoveredSlice.color }} />
						{hoveredSlice.label}
					</div>
					<div style={{ color: theme.colors.textDim }}>
						{formatValue(hoveredSlice.value)} ({hoveredSlice.percentage.toFixed(1)}%)
					</div>
				</ChartTooltip>
			)}
		</div>
	);
});

export default DistributionDonut;
