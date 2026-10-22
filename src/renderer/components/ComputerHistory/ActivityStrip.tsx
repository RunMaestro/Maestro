/**
 * Computer History - activity histogram.
 *
 * One stacked bar per time step across the selected range, each segment an
 * app's share of foreground time in that step. Clicking a bar narrows the
 * event stream to that step; clicking it again (or the "x" on the focus pill
 * in the header) widens back out. Bars are sized from the strip's measured
 * width, so a 30-day range folds into day bars rather than 2,880 slivers.
 */

import { memo, useMemo, useRef } from 'react';
import type { Theme } from '../../types';
import { useElementWidth } from '../../hooks/ui/useElementWidth';
import { formatDurationCompact } from '../../../shared/duration';
import type { ActivityBucket } from '../../../shared/computer-history/reader';
import { buildHistogram, chooseBarStepMs, clockLabel, dayLabel } from './timelineModel';

const STRIP_HEIGHT = 64;
const AXIS_HEIGHT = 16;
const BAR_GAP = 1;

interface ActivityStripProps {
	theme: Theme;
	buckets: readonly ActivityBucket[];
	sinceMs: number;
	untilMs: number;
	/** App id -> color; apps missing here draw in the "other" color. */
	appColors: ReadonlyMap<string, string>;
	appNames: ReadonlyMap<string, string>;
	focus: { startMs: number; endMs: number } | null;
	onFocus: (focus: { startMs: number; endMs: number } | null) => void;
}

export const ActivityStrip = memo(function ActivityStrip({
	theme,
	buckets,
	sinceMs,
	untilMs,
	appColors,
	appNames,
	focus,
	onFocus,
}: ActivityStripProps) {
	const ref = useRef<HTMLDivElement>(null);
	const width = useElementWidth(ref);
	const span = Math.max(1, untilMs - sinceMs);
	const stepMs = chooseBarStepMs(span, width || 600);
	const bars = useMemo(
		() => buildHistogram(buckets, stepMs, sinceMs, untilMs),
		[buckets, stepMs, sinceMs, untilMs]
	);
	const maxTotal = Math.max(1, ...bars.map((b) => b.total));
	const toX = (ms: number) => ((ms - sinceMs) / span) * width;
	const otherColor = theme.colors.textDim;

	// Up to five axis labels, at bar boundaries.
	const ticks = useMemo(() => {
		if (bars.length === 0) return [];
		const every = Math.max(1, Math.ceil(bars.length / 5));
		const multiDay = span > 36 * 3_600_000;
		return bars
			.filter((_, i) => i % every === 0)
			.map((b) => ({
				ms: b.startMs,
				label: multiDay ? dayLabel(b.startMs, untilMs) : clockLabel(b.startMs),
			}));
	}, [bars, span, untilMs]);

	return (
		<div ref={ref} className="w-full select-none" data-testid="computer-history-strip">
			{width > 0 && (
				<svg width={width} height={STRIP_HEIGHT + AXIS_HEIGHT} role="img" aria-label="Activity">
					<line
						x1={0}
						x2={width}
						y1={STRIP_HEIGHT - 0.5}
						y2={STRIP_HEIGHT - 0.5}
						stroke={theme.colors.border}
					/>
					{bars.map((bar) => {
						const x = Math.max(0, toX(bar.startMs));
						const w = Math.max(1, toX(Math.min(bar.endMs, untilMs)) - x - BAR_GAP);
						const isFocused = focus !== null && focus.startMs === bar.startMs;
						const dimmed = focus !== null && !isFocused;
						const top = Object.entries(bar.byApp)
							.filter(([, v]) => v > 0)
							.sort((a, b) => b[1] - a[1]);
						let y = STRIP_HEIGHT - 1;
						const tooltip = [
							`${dayLabel(bar.startMs, untilMs)} ${clockLabel(bar.startMs)} - ${clockLabel(bar.endMs)}`,
							`${bar.events} event${bar.events === 1 ? '' : 's'}`,
							...top
								.slice(0, 5)
								.map(
									([id, v]) =>
										`${appNames.get(id) ?? id}: ${bar.timed ? formatDurationCompact(v) : `${Math.round((v / bar.total) * 100)}%`}`
								),
						].join('\n');
						return (
							<g
								key={bar.startMs}
								onClick={() =>
									bar.events > 0 &&
									onFocus(isFocused ? null : { startMs: bar.startMs, endMs: bar.endMs })
								}
								style={{ cursor: bar.events > 0 ? 'pointer' : 'default' }}
								opacity={dimmed ? 0.35 : 1}
							>
								<title>{tooltip}</title>
								{/* Full-height hit target, so a thin bar is still easy to click. */}
								<rect x={x} y={0} width={w} height={STRIP_HEIGHT} fill="transparent" />
								{isFocused && (
									<rect
										x={x}
										y={0}
										width={w}
										height={STRIP_HEIGHT}
										fill={theme.colors.accent}
										opacity={0.12}
										rx={2}
									/>
								)}
								{top.map(([id, v]) => {
									const h = (v / maxTotal) * (STRIP_HEIGHT - 6);
									y -= h;
									return (
										<rect
											key={id}
											x={x}
											y={y}
											width={w}
											height={Math.max(h, 0.5)}
											fill={appColors.get(id) ?? otherColor}
											rx={w > 4 ? 1 : 0}
										/>
									);
								})}
							</g>
						);
					})}
					{ticks.map((t) => (
						<text
							key={t.ms}
							x={Math.min(Math.max(toX(t.ms), 0) + 2, width - 40)}
							y={STRIP_HEIGHT + 12}
							fontSize={10}
							fill={theme.colors.textDim}
						>
							{t.label}
						</text>
					))}
				</svg>
			)}
		</div>
	);
});
