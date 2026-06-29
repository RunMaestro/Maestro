/**
 * ActivityTimeline
 *
 * Part of the shared output-widget library: theme-aware, presentational-only
 * (no IPC, no store reads), independent of any Encore flag. A compact stacked
 * bar timeline that renders AUTO/USER/CUE counts per time slice as stacked
 * segments, with a legend. Colors follow the unified-history graph language
 * (AUTO = warning/yellow, USER = accent, CUE = cyan) and can be overridden via
 * props for colorblind palettes. All data arrives through props.
 */

import { memo } from 'react';
import { CUE_COLOR } from '../../../../shared/cue-pipeline-types';
import type { TimelineBucket, WidgetProps } from '../types';

interface ActivityTimelineProps extends WidgetProps {
	/** Ordered time slices (oldest -> newest). */
	buckets: TimelineBucket[];
	/** Segment colors. Defaults to the unified-history language. */
	colors?: { auto: string; user: string; cue: string };
	/** Height of the bar area in px (default 96). */
	height?: number;
	/** Show the AUTO/USER/CUE legend (default true). */
	showLegend?: boolean;
}

function LegendDot({ color, label }: { color: string; label: string }) {
	return (
		<span className="inline-flex items-center gap-1.5">
			<span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: color }} />
			{label}
		</span>
	);
}

export const ActivityTimeline = memo(function ActivityTimeline({
	theme,
	buckets,
	colors,
	height = 96,
	showLegend = true,
}: ActivityTimelineProps) {
	const palette = {
		auto: colors?.auto ?? theme.colors.warning,
		user: colors?.user ?? theme.colors.accent,
		cue: colors?.cue ?? CUE_COLOR,
	};

	const totals = buckets.map((b) => b.auto + b.user + b.cue);
	const max = Math.max(1, ...totals);
	const hasActivity = totals.some((t) => t > 0);

	return (
		<div className="flex flex-col gap-3">
			{hasActivity ? (
				<div className="flex items-end gap-0.5" style={{ height }}>
					{buckets.map((bucket, i) => {
						const total = totals[i];
						const colHeightPct = (total / max) * 100;
						const title = `Auto ${bucket.auto} · User ${bucket.user} · Cue ${bucket.cue}`;
						return (
							<div
								key={i}
								className="flex-1 flex flex-col justify-end"
								style={{ height: '100%' }}
								title={title}
							>
								<div
									className="flex flex-col rounded-sm overflow-hidden"
									style={{ height: `${colHeightPct}%`, minHeight: total > 0 ? 2 : 0 }}
								>
									{bucket.cue > 0 && (
										<div style={{ flexGrow: bucket.cue, backgroundColor: palette.cue }} />
									)}
									{bucket.user > 0 && (
										<div style={{ flexGrow: bucket.user, backgroundColor: palette.user }} />
									)}
									{bucket.auto > 0 && (
										<div style={{ flexGrow: bucket.auto, backgroundColor: palette.auto }} />
									)}
								</div>
							</div>
						);
					})}
				</div>
			) : (
				<div
					className="flex items-center justify-center text-xs"
					style={{ height, color: theme.colors.textDim }}
				>
					No activity in this window
				</div>
			)}

			{showLegend && (
				<div
					className="flex items-center gap-4 text-[11px]"
					style={{ color: theme.colors.textDim }}
				>
					<LegendDot color={palette.user} label="User" />
					<LegendDot color={palette.auto} label="Auto" />
					<LegendDot color={palette.cue} label="Cue" />
				</div>
			)}
		</div>
	);
});

export default ActivityTimeline;
