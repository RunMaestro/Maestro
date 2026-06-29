/**
 * TypeBreakdown
 *
 * Part of the shared output-widget library: theme-aware, presentational-only
 * (no IPC, no store reads), independent of any Encore flag. Renders a donut
 * breakdown of labeled slices (e.g. AUTO vs USER vs CUE) with a center total
 * and a legend showing each slice's count and percentage. Built from plain SVG
 * circles via stroke-dasharray; all data arrives through props.
 */

import { memo } from 'react';
import { formatNumber } from '../../../../shared/formatters';
import type { DonutSlice, WidgetProps } from '../types';

interface TypeBreakdownProps extends WidgetProps {
	/** Slices to render. Zero-value slices are kept in the legend but draw no arc. */
	slices: DonutSlice[];
	/** Outer diameter of the donut in px (default 132). */
	size?: number;
	/** Ring thickness in px (default 18). */
	thickness?: number;
}

export const TypeBreakdown = memo(function TypeBreakdown({
	theme,
	slices,
	size = 132,
	thickness = 18,
}: TypeBreakdownProps) {
	const total = slices.reduce((sum, s) => sum + s.value, 0);
	const radius = (size - thickness) / 2;
	const circumference = 2 * Math.PI * radius;
	const center = size / 2;

	// Accumulate the dash offset as we lay each arc end-to-end around the ring.
	let consumed = 0;

	return (
		<div className="flex items-center gap-5 flex-wrap">
			<div className="relative shrink-0" style={{ width: size, height: size }}>
				<svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
					{/* Track ring */}
					<circle
						cx={center}
						cy={center}
						r={radius}
						fill="none"
						stroke={theme.colors.border}
						strokeWidth={thickness}
						opacity={0.4}
					/>
					{/* Slice arcs */}
					{total > 0 &&
						slices.map((slice) => {
							if (slice.value <= 0) return null;
							const fraction = slice.value / total;
							const arcLength = fraction * circumference;
							const dashArray = `${arcLength} ${circumference - arcLength}`;
							const dashOffset = -consumed;
							consumed += arcLength;
							return (
								<circle
									key={slice.label}
									cx={center}
									cy={center}
									r={radius}
									fill="none"
									stroke={slice.color}
									strokeWidth={thickness}
									strokeDasharray={dashArray}
									strokeDashoffset={dashOffset}
									transform={`rotate(-90 ${center} ${center})`}
								/>
							);
						})}
				</svg>
				{/* Center total */}
				<div className="absolute inset-0 flex flex-col items-center justify-center">
					<span className="text-xl font-bold leading-none" style={{ color: theme.colors.textMain }}>
						{formatNumber(total)}
					</span>
					<span
						className="text-[10px] uppercase tracking-wide"
						style={{ color: theme.colors.textDim }}
					>
						Total
					</span>
				</div>
			</div>

			<div className="flex flex-col gap-1.5 min-w-[120px]">
				{slices.map((slice) => {
					const pct = total > 0 ? Math.round((slice.value / total) * 100) : 0;
					return (
						<div key={slice.label} className="flex items-center gap-2 text-xs">
							<span
								className="inline-block w-2.5 h-2.5 rounded-sm shrink-0"
								style={{ backgroundColor: slice.color }}
							/>
							<span className="flex-1" style={{ color: theme.colors.textDim }}>
								{slice.label}
							</span>
							<span style={{ color: theme.colors.textMain, fontWeight: 600 }}>
								{formatNumber(slice.value)}
							</span>
							<span className="tabular-nums w-9 text-right" style={{ color: theme.colors.textDim }}>
								{pct}%
							</span>
						</div>
					);
				})}
			</div>
		</div>
	);
});

export default TypeBreakdown;
