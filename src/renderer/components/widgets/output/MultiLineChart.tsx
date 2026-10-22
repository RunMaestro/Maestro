/**
 * MultiLineChart
 *
 * Part of the shared output-widget library: theme-aware, presentational-only
 * (no IPC, no store reads), independent of any Encore flag.
 *
 * Several series drawn as lines over one shared x axis, for comparing a RATE
 * across groups (tokens per second per model, say) where stacking would be
 * meaningless because the values do not sum.
 *
 * - `null` is a gap, not a zero: a series with no data in a slot breaks its
 *   line there instead of diving to the axis and implying the rate collapsed.
 *   A point with no neighbours is drawn as a dot so it is not lost.
 * - The legend doubles as the control that hides a series; a hidden series also
 *   leaves the y scale, which is the only way to read a small series beside a
 *   large one. The last visible series cannot be hidden.
 * - The SVG scales with its container (`viewBox` + non-scaling strokes), so the
 *   chart needs no width measurement; labels live in an HTML layer so text is
 *   never stretched.
 */

import { memo, useMemo, useState, type MouseEvent } from 'react';
import type { WidgetProps } from '../types';
import { ChartTooltip } from './ChartTooltip';

export interface LineSeries {
	key: string;
	label: string;
	color: string;
	/** One value per x slot; `null` where the series has no data. */
	values: Array<number | null>;
	/** Draw dashed, e.g. for a peak line beside an average. */
	dashed?: boolean;
}

export interface MultiLineChartProps extends WidgetProps {
	/** One label per x slot, shown on the axis (thinned) and in the tooltip. */
	xLabels: string[];
	series: LineSeries[];
	/** Plot height in px (default 160). */
	height?: number;
	/** Formats y values for the axis and tooltip (default: rounded integer). */
	formatValue?: (value: number) => string;
	/** Accessible name for the chart image. */
	ariaLabel: string;
	/** Hide the legend (e.g. when the surface draws its own). */
	showLegend?: boolean;
	/** Most axis labels to show before thinning (default 6). */
	maxXLabels?: number;
	testId?: string;
}

/** SVG user units; the drawing scales to the container via `viewBox`. */
const VIEW_WIDTH = 1000;

function defaultFormat(value: number): string {
	return Math.round(value).toLocaleString();
}

/** Indices of the axis labels to show: evenly spread, always first and last. */
function axisLabelIndices(count: number, maxLabels: number): number[] {
	if (count <= maxLabels) return Array.from({ length: count }, (_, i) => i);
	const step = (count - 1) / (maxLabels - 1);
	const picked = new Set<number>();
	for (let i = 0; i < maxLabels; i++) picked.add(Math.round(i * step));
	return [...picked];
}

/** Split a series into runs of consecutive non-null points. */
function segments(values: Array<number | null>): Array<Array<{ i: number; v: number }>> {
	const runs: Array<Array<{ i: number; v: number }>> = [];
	let run: Array<{ i: number; v: number }> = [];
	values.forEach((v, i) => {
		if (v === null || !Number.isFinite(v)) {
			if (run.length) runs.push(run);
			run = [];
		} else {
			run.push({ i, v });
		}
	});
	if (run.length) runs.push(run);
	return runs;
}

export const MultiLineChart = memo(function MultiLineChart({
	theme,
	xLabels,
	series,
	height = 160,
	formatValue = defaultFormat,
	ariaLabel,
	showLegend = true,
	maxXLabels = 6,
	testId,
}: MultiLineChartProps) {
	const [hidden, setHidden] = useState<Set<string>>(() => new Set());
	const [hover, setHover] = useState<{ idx: number; x: number; y: number } | null>(null);

	const visible = useMemo(() => series.filter((s) => !hidden.has(s.key)), [series, hidden]);
	const count = xLabels.length;

	const max = useMemo(() => {
		let m = 0;
		for (const s of visible) for (const v of s.values) if (v !== null && v > m) m = v;
		return m;
	}, [visible]);

	const xAt = (i: number) => (count <= 1 ? VIEW_WIDTH / 2 : (i / (count - 1)) * VIEW_WIDTH);
	const yAt = (v: number) => (max > 0 ? height - (v / max) * (height - 4) - 2 : height - 2);

	const toggle = (key: string) =>
		setHidden((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else if (visible.length > 1) next.add(key);
			return next;
		});

	const onMove = (e: MouseEvent<HTMLDivElement>) => {
		if (count === 0) return;
		const rect = e.currentTarget.getBoundingClientRect();
		const frac = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0;
		const idx = Math.min(count - 1, Math.max(0, Math.round(frac * (count - 1))));
		setHover({ idx, x: e.clientX, y: e.clientY });
	};

	if (count === 0 || series.length === 0) return null;

	const labelIdx = axisLabelIndices(count, maxXLabels);

	return (
		<div data-testid={testId}>
			{showLegend && (
				<div className="flex flex-wrap items-center gap-1 mb-2">
					{series.map((s) => {
						const on = !hidden.has(s.key);
						const isLastVisible = on && visible.length === 1;
						return (
							<button
								key={s.key}
								type="button"
								onClick={() => toggle(s.key)}
								disabled={isLastVisible}
								aria-pressed={on}
								title={
									isLastVisible
										? 'At least one series has to stay visible'
										: `${on ? 'Hide' : 'Show'} ${s.label}`
								}
								className="flex items-center gap-1.5 rounded px-1.5 py-0.5"
								style={{ opacity: on ? 1 : 0.45, cursor: isLastVisible ? 'default' : 'pointer' }}
								data-testid={testId ? `${testId}-legend-${s.key}` : undefined}
							>
								<span
									className="inline-block w-3 h-0.5 rounded-sm"
									style={{
										backgroundColor: on ? s.color : 'transparent',
										boxShadow: `inset 0 0 0 1px ${s.color}`,
									}}
								/>
								<span
									className="text-xs"
									style={{
										color: theme.colors.textDim,
										textDecoration: on ? undefined : 'line-through',
									}}
								>
									{s.label}
								</span>
							</button>
						);
					})}
				</div>
			)}

			<div className="flex gap-2">
				{/* Y axis: just the scale's ends, which is all a rate comparison needs. */}
				<div
					className="flex flex-col justify-between text-2xs tabular-nums text-right shrink-0"
					style={{ height, color: theme.colors.textDim, minWidth: '2.5rem' }}
				>
					<span>{formatValue(max)}</span>
					<span>{formatValue(max / 2)}</span>
					<span>0</span>
				</div>

				<div
					className="relative flex-1 min-w-0"
					style={{ height }}
					onMouseMove={onMove}
					onMouseLeave={() => setHover(null)}
				>
					<svg
						role="img"
						aria-label={ariaLabel}
						viewBox={`0 0 ${VIEW_WIDTH} ${height}`}
						preserveAspectRatio="none"
						width="100%"
						height={height}
						className="block overflow-visible"
					>
						{[0, 0.5, 1].map((f) => (
							<line
								key={f}
								x1={0}
								x2={VIEW_WIDTH}
								y1={2 + f * (height - 4)}
								y2={2 + f * (height - 4)}
								stroke={theme.colors.border}
								strokeWidth={1}
								vectorEffect="non-scaling-stroke"
								strokeDasharray={f === 1 ? undefined : '2 4'}
							/>
						))}
						{hover && (
							<line
								x1={xAt(hover.idx)}
								x2={xAt(hover.idx)}
								y1={0}
								y2={height}
								stroke={theme.colors.textDim}
								strokeWidth={1}
								vectorEffect="non-scaling-stroke"
								opacity={0.5}
							/>
						)}
						{visible.map((s) =>
							segments(s.values).map((run) =>
								run.length === 1 ? (
									<line
										key={`${s.key}-${run[0].i}`}
										x1={xAt(run[0].i)}
										x2={xAt(run[0].i)}
										y1={yAt(run[0].v)}
										y2={yAt(run[0].v)}
										stroke={s.color}
										strokeWidth={6}
										strokeLinecap="round"
										vectorEffect="non-scaling-stroke"
									/>
								) : (
									<polyline
										key={`${s.key}-${run[0].i}`}
										points={run.map((p) => `${xAt(p.i)},${yAt(p.v)}`).join(' ')}
										fill="none"
										stroke={s.color}
										strokeWidth={2}
										strokeLinejoin="round"
										strokeLinecap="round"
										strokeDasharray={s.dashed ? '6 4' : undefined}
										vectorEffect="non-scaling-stroke"
									/>
								)
							)
						)}
					</svg>
				</div>
			</div>

			<div className="relative h-4 mt-1" style={{ marginLeft: 'calc(2.5rem + 0.5rem)' }}>
				{labelIdx.map((i) => {
					const pct = count <= 1 ? 50 : (i / (count - 1)) * 100;
					const align = i === 0 ? '0%' : i === count - 1 ? '-100%' : '-50%';
					return (
						<span
							key={i}
							className="absolute text-2xs whitespace-nowrap"
							style={{
								left: `${pct}%`,
								transform: `translateX(${align})`,
								color: theme.colors.textDim,
							}}
						>
							{xLabels[i]}
						</span>
					);
				})}
			</div>

			{hover && (
				<ChartTooltip anchor={{ x: hover.x, y: hover.y }} theme={theme}>
					<div className="font-semibold mb-1">{xLabels[hover.idx]}</div>
					{visible.map((s) => {
						const v = s.values[hover.idx];
						return (
							<div key={s.key} className="flex items-center gap-1.5">
								<span
									className="inline-block w-2 h-2 rounded-sm"
									style={{ backgroundColor: s.color }}
								/>
								<span>
									{s.label}: {v === null || v === undefined ? '-' : formatValue(v)}
								</span>
							</div>
						);
					})}
				</ChartTooltip>
			)}
		</div>
	);
});
