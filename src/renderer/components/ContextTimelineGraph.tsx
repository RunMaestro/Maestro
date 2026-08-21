/**
 * ContextTimelineGraph - the x/y view of the Context Timeline (Task 5b, idea
 * credited to Pedram).
 *
 * The bar list shows each turn's context in isolation; this shows the TREND
 * across a conversation. X is turn order OLDEST TO NEWEST (left to right) -
 * deliberately the opposite direction from the bar list, which renders
 * newest-first because a list reads top-down while a trend reads left-to-right.
 *
 * Y is the same per-point value the bar's width comes from: `fillFraction` out
 * of `computeOverLimitDisplay(tokens, window, scaleMax)`, the shared helper from
 * finding R1. Both views therefore divide by the same per-panel headroom scale
 * and can never disagree, and the 100% reference line sits at `window /
 * scaleMax` exactly like the bar track's tick - as a STEP line following each
 * turn's own stored window, so a mid-session window change moves the limit
 * rather than judging older turns against a newer one.
 *
 * Not built on the shared `Sparkline` widget: that primitive auto-normalizes to
 * its own data's min/max, has no fixed reference line, cannot break a series,
 * and exposes no per-point hover - all four are requirements here. It stays the
 * right primitive for trend glyphs inside stat cards.
 */

import { memo, useMemo, useState } from 'react';
import type { Theme } from '../types';
import type { ContextTimelinePoint } from '../stores/contextTimelineStore';
import { computeOverLimitDisplay } from '../utils/contextUsage';
import { getContextColor } from '../utils/theme';
import { formatTokensCompact } from '../../shared/formatters';

interface ContextTimelineGraphProps {
	/** Turns oldest to newest - the store's natural order, NOT the reversed list. */
	points: ContextTimelinePoint[];
	/** Shared per-panel track maximum (max of the window and the peak tokens). */
	scaleMax: number;
	theme: Theme;
}

/** Plot area in user units; the SVG stretches to the panel width. */
const VIEW_W = 100;
const VIEW_H = 100;

interface PlotPoint {
	index: number;
	x: number;
	y: number;
	/** False for a turn with no window at all: nothing to divide by, so no y. */
	plottable: boolean;
	label: string;
	color: string;
	title: string;
}

/**
 * Split the series into the runs of consecutive plottable points. A turn with no
 * context window at all leaves a GAP (decision 3 of the S1 record) rather than
 * being interpolated or plotted at zero: the bar list renders that same turn as
 * "~", and inventing a value exactly where the measurement is missing would be
 * dishonest. Note this case is narrower than a null `percentage`: since R1, an
 * over-limit turn has a true percentage and IS plotted, above the 100% line.
 */
function toSegments(plot: PlotPoint[]): PlotPoint[][] {
	const segments: PlotPoint[][] = [];
	let current: PlotPoint[] = [];
	for (const p of plot) {
		if (p.plottable) {
			current.push(p);
		} else if (current.length) {
			segments.push(current);
			current = [];
		}
	}
	if (current.length) segments.push(current);
	return segments;
}

export const ContextTimelineGraph = memo(function ContextTimelineGraph({
	points,
	scaleMax,
	theme,
}: ContextTimelineGraphProps) {
	const [activeIndex, setActiveIndex] = useState<number | null>(null);

	const plot = useMemo<PlotPoint[]>(() => {
		const count = points.length;
		return points.map((p, i) => {
			// ONE derivation, shared with the bar rows.
			const display = computeOverLimitDisplay(p.contextTokens, p.contextWindow, scaleMax);
			const hasWindow = p.contextWindow > 0;
			return {
				index: i,
				x: count <= 1 ? VIEW_W / 2 : (i / (count - 1)) * VIEW_W,
				y: VIEW_H - display.fillFraction * VIEW_H,
				plottable: hasWindow,
				// Same figures as the bar row's label.
				label: `${hasWindow ? `${display.truePercentage}%` : '~'} · ${formatTokensCompact(p.contextTokens)}${
					hasWindow ? ` / ${formatTokensCompact(p.contextWindow)}` : ''
				}`,
				color: getContextColor(display.truePercentage, theme),
				title: hasWindow
					? display.overLimit
						? `Over the context limit: ${formatTokensCompact(p.contextTokens)} against a ${formatTokensCompact(p.contextWindow)} window`
						: `${display.truePercentage}% of the context window`
					: 'No context window reported for this turn',
			};
		});
	}, [points, scaleMax, theme]);

	const segments = useMemo(() => toSegments(plot), [plot]);

	// The 100% boundary. A single flat gridline drawn from the LATEST window put
	// earlier turns on the wrong side of their own limit whenever the window
	// changed mid-session (review of PR #1365) - a turn at 80% of a 1M window
	// appeared above a line representing a later 200k one. The limit is a
	// property of each turn, so it is drawn as a STEP line following each point's
	// own stored window. With one window throughout - the overwhelmingly common
	// case - this is visually identical to the flat line it replaces.
	const limitPath = useMemo(() => {
		if (scaleMax <= 0) return null;
		const withWindow = plot.filter((p) => p.plottable);
		if (!withWindow.length) return null;
		const yFor = (w: number) => VIEW_H - (Math.min(w, scaleMax) / scaleMax) * VIEW_H;
		let d = '';
		let prevY = 0;
		withWindow.forEach((p, i) => {
			const y = yFor(points[p.index].contextWindow);
			if (i === 0) {
				// Start at the left edge so the first turn's limit is visible even
				// when that turn is not at x=0.
				d += `M 0 ${y} L ${p.x} ${y}`;
			} else {
				// Step: hold the previous limit up to this turn, then jump.
				d += ` L ${p.x} ${prevY} L ${p.x} ${y}`;
			}
			prevY = y;
			// Extend the last segment to the right edge.
			if (i === withWindow.length - 1) d += ` L ${VIEW_W} ${y}`;
		});
		return d;
	}, [plot, points, scaleMax]);

	const active = activeIndex !== null ? plot[activeIndex] : null;
	const readout = active ?? plot[plot.length - 1];
	// One hit column per turn, so hovering anywhere above a turn selects it.
	const columnWidth = plot.length > 1 ? VIEW_W / (plot.length - 1) : VIEW_W;

	return (
		<div className="flex flex-col gap-1" data-testid="timeline-graph">
			<svg
				viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
				preserveAspectRatio="none"
				className="w-full"
				style={{ height: 140, backgroundColor: theme.colors.bgActivity, borderRadius: 6 }}
				role="img"
				aria-label="Context usage per turn, oldest on the left"
				onMouseLeave={() => setActiveIndex(null)}
			>
				{limitPath !== null && (
					<path
						data-testid="timeline-graph-limit-line"
						d={limitPath}
						fill="none"
						stroke={theme.colors.textMain}
						strokeWidth={1}
						strokeDasharray="3 3"
						opacity={0.5}
						vectorEffect="non-scaling-stroke"
					/>
				)}
				{segments.map((segment, i) => (
					<polyline
						key={i}
						data-testid="timeline-graph-segment"
						points={segment.map((p) => `${p.x},${p.y}`).join(' ')}
						fill="none"
						stroke={theme.colors.accent}
						strokeWidth={1.5}
						strokeLinecap="round"
						strokeLinejoin="round"
						vectorEffect="non-scaling-stroke"
					/>
				))}
				{/* A single plottable turn has no line to draw, so mark it. */}
				{plot
					.filter((p) => p.plottable && p.index === activeIndex)
					.map((p) => (
						<line
							key={`guide-${p.index}`}
							x1={p.x}
							y1={0}
							x2={p.x}
							y2={VIEW_H}
							stroke={p.color}
							strokeWidth={1}
							vectorEffect="non-scaling-stroke"
							opacity={0.7}
						/>
					))}
				{plot.map((p) => (
					<rect
						key={`hit-${p.index}`}
						data-testid="timeline-graph-hit"
						x={Math.max(0, p.x - columnWidth / 2)}
						y={0}
						width={columnWidth}
						height={VIEW_H}
						fill="transparent"
						tabIndex={0}
						aria-label={p.label}
						onMouseEnter={() => setActiveIndex(p.index)}
						onFocus={() => setActiveIndex(p.index)}
						onBlur={() => setActiveIndex(null)}
					>
						<title>{p.title}</title>
					</rect>
				))}
			</svg>
			<div className="flex items-center justify-between gap-2 text-[10px]">
				<span style={{ color: theme.colors.textDim }}>
					turn {(readout?.index ?? 0) + 1} of {plot.length}
					{active ? '' : ' (latest)'}
				</span>
				<span
					className="font-mono tabular-nums"
					data-testid="timeline-graph-readout"
					style={{ color: readout?.color ?? theme.colors.textDim }}
				>
					{readout?.label ?? ''}
				</span>
			</div>
			<div className="text-[10px]" style={{ color: theme.colors.textDim }}>
				Oldest turn on the left. The dashed line is 100% of the window.
			</div>
		</div>
	);
});

export default ContextTimelineGraph;
