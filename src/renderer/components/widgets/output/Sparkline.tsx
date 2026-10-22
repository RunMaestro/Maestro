/**
 * Sparkline
 *
 * Part of the shared output-widget library: theme-agnostic, presentational-only
 * (no IPC, no store reads), independent of any Encore flag.
 *
 * Lightweight inline SVG trend chart used inside summary cards, agent
 * overview cards, and worktree analytics. Renders a smooth (quadratic
 * bezier) line plus a tinted area fill, with an optional glowing end
 * dot at the most recent data point.
 *
 * Empty data (or all zeros) collapses to a dashed horizontal baseline
 * so the layout stays stable when there's nothing to plot yet.
 *
 * By default the line is normalized to its own min and max. Pass `domain` to
 * plot against a fixed scale instead (a gauge sharing one scale across several
 * charts), and `reference` to draw a dashed horizontal mark at a value on that
 * scale (a peak, a limit). With a domain, all-zero data is a real reading and
 * draws as a flat line on the floor rather than the empty baseline.
 */

import { memo, useMemo } from 'react';

interface SparklineProps {
	/** Sequential numeric values to plot (oldest → newest) */
	data: readonly number[];
	/** SVG width in px (default 80) */
	width?: number;
	/** SVG height in px (default 24) */
	height?: number;
	/** Stroke + fill base color */
	color: string;
	/** Opacity for the area fill below the line (default 0.15) */
	fillOpacity?: number;
	/** Render a glowing dot at the last data point (default true) */
	showEndDot?: boolean;
	/** Line stroke width (default 1.5) */
	strokeWidth?: number;
	/** Fixed vertical scale. Omit to fit the line to the data's own range. */
	domain?: { min: number; max: number };
	/** Dashed horizontal mark at `value`, on the same scale as the line. */
	reference?: { value: number; color: string; label?: string };
}

const PADDING = 2;

interface Point {
	x: number;
	y: number;
}

/**
 * Build a smooth path string through `points` using quadratic beziers.
 * Each segment's control is the data point itself; each segment ends at
 * the midpoint between consecutive points, with a final `T` smoothing
 * into the last data point.
 */
function buildSmoothPath(points: Point[]): string {
	if (points.length === 0) return '';
	if (points.length === 1) {
		const { x, y } = points[0];
		return `M ${x} ${y}`;
	}
	if (points.length === 2) {
		return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;
	}

	let d = `M ${points[0].x} ${points[0].y}`;
	for (let i = 1; i < points.length - 1; i++) {
		const xc = (points[i].x + points[i + 1].x) / 2;
		const yc = (points[i].y + points[i + 1].y) / 2;
		d += ` Q ${points[i].x} ${points[i].y} ${xc} ${yc}`;
	}
	const last = points[points.length - 1];
	d += ` T ${last.x} ${last.y}`;
	return d;
}

export const Sparkline = memo(function Sparkline({
	data,
	width = 80,
	height = 24,
	color,
	fillOpacity = 0.15,
	showEndDot = true,
	strokeWidth = 1.5,
	domain,
	reference,
}: SparklineProps) {
	const isEmpty = useMemo(
		() => data.length === 0 || (!domain && data.every((v) => v === 0)),
		[data, domain]
	);
	const domainMin = domain?.min;
	const domainMax = domain?.max;

	/** Y of a value on the plotted scale, clamped inside the padding. */
	const yOf = useMemo(() => {
		const innerHeight = Math.max(0, height - PADDING * 2);
		const min = domainMin ?? (data.length ? Math.min(...data) : 0);
		const max = domainMax ?? (data.length ? Math.max(...data) : 0);
		const range = max - min;
		return (value: number) => {
			// Flat data -> center vertically; otherwise normalize so max sits at top.
			const normalized = range === 0 ? 0.5 : Math.min(1, Math.max(0, (value - min) / range));
			return PADDING + (1 - normalized) * innerHeight;
		};
	}, [data, domainMin, domainMax, height]);

	const referenceLine =
		reference && Number.isFinite(reference.value) ? (
			<line
				x1={PADDING}
				y1={yOf(reference.value)}
				x2={width - PADDING}
				y2={yOf(reference.value)}
				stroke={reference.color}
				strokeWidth={1}
				strokeDasharray="3 3"
				data-testid="sparkline-reference"
			>
				{reference.label && <title>{reference.label}</title>}
			</line>
		) : null;

	const { linePath, areaPath, endPoint } = useMemo(() => {
		if (isEmpty || data.length === 0) {
			return { linePath: '', areaPath: '', endPoint: null as Point | null };
		}

		const innerWidth = Math.max(0, width - PADDING * 2);

		const points: Point[] = data.map((value, i) => ({
			x: data.length === 1 ? width / 2 : PADDING + (i / (data.length - 1)) * innerWidth,
			y: yOf(value),
		}));

		const line = buildSmoothPath(points);
		const baseY = height - PADDING;
		const firstX = points[0].x;
		const lastX = points[points.length - 1].x;
		const area = `${line} L ${lastX} ${baseY} L ${firstX} ${baseY} Z`;

		return {
			linePath: line,
			areaPath: area,
			endPoint: points[points.length - 1],
		};
	}, [data, isEmpty, width, height, yOf]);

	if (isEmpty) {
		const midY = height / 2;
		return (
			<svg
				width={width}
				height={height}
				viewBox={`0 0 ${width} ${height}`}
				aria-hidden="true"
				data-testid="sparkline-empty"
			>
				<line
					x1={PADDING}
					y1={midY}
					x2={width - PADDING}
					y2={midY}
					stroke={color}
					strokeWidth={strokeWidth}
					strokeDasharray="4 3"
					strokeLinecap="round"
					opacity={0.5}
				/>
				{referenceLine}
			</svg>
		);
	}

	return (
		<svg
			width={width}
			height={height}
			viewBox={`0 0 ${width} ${height}`}
			aria-hidden="true"
			data-testid="sparkline"
		>
			<path d={areaPath} fill={color} fillOpacity={fillOpacity} stroke="none" />
			{referenceLine}
			<path
				d={linePath}
				fill="none"
				stroke={color}
				strokeWidth={strokeWidth}
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
			{showEndDot && endPoint && (
				<circle
					cx={endPoint.x}
					cy={endPoint.y}
					r={2}
					fill={color}
					style={{ filter: `drop-shadow(0 0 2px ${color})` }}
				/>
			)}
		</svg>
	);
});

export default Sparkline;
