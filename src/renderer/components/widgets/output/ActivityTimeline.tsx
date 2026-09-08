/**
 * ActivityTimeline
 *
 * Part of the shared output-widget library: theme-aware, presentational-only
 * (no IPC, no store reads), independent of any Encore flag. A compact stacked
 * bar timeline that renders AUTO/USER/CUE/AGENT counts per time slice as
 * stacked segments, with a legend. Colors follow the unified-history graph
 * language (AUTO = warning/yellow, USER = accent, CUE = cyan, AGENT = magenta)
 * and can be overridden via props for colorblind palettes. All data arrives
 * through props.
 *
 * The legend doubles as a filter: clicking an entry hides that series and
 * ghosts its swatch. Hidden series drop out of the stack, the tooltip, and the
 * max used to scale the columns, so one dominant source (usually CUE) cannot
 * flatten everything else into an invisible sliver. Which series start hidden
 * is the caller's call via `defaultHiddenSeries`; the toggles themselves are
 * local view state and reset when the widget unmounts.
 */

import { memo, useCallback, useState } from 'react';
import { CUE_COLOR } from '../../../../shared/cue-pipeline-types';
import { AGENT_COLOR } from '../../../../shared/crossAgentTypes';
import type { TimelineBucket, WidgetProps } from '../types';

/** The four stacked sources, in legend order. */
export type TimelineSeries = 'user' | 'auto' | 'cue' | 'agent';

const SERIES_ORDER: { key: TimelineSeries; label: string }[] = [
	{ key: 'user', label: 'User' },
	{ key: 'auto', label: 'Auto' },
	{ key: 'cue', label: 'Cue' },
	{ key: 'agent', label: 'Agent' },
];

/** Tooltip keeps the historical Auto/User/Cue/Agent reading order. */
const TOOLTIP_ORDER: { key: TimelineSeries; label: string }[] = [
	SERIES_ORDER[1],
	SERIES_ORDER[0],
	SERIES_ORDER[2],
	SERIES_ORDER[3],
];

interface ActivityTimelineProps extends WidgetProps {
	/** Ordered time slices (oldest -> newest). */
	buckets: TimelineBucket[];
	/** Segment colors. Defaults to the unified-history language. */
	colors?: { auto: string; user: string; cue: string; agent?: string };
	/** Height of the bar area in px (default 96). */
	height?: number;
	/** Show the AUTO/USER/CUE/AGENT legend (default true). */
	showLegend?: boolean;
	/** Series hidden on first render. The user can toggle any of them back on. */
	defaultHiddenSeries?: TimelineSeries[];
}

function LegendToggle({
	color,
	label,
	hidden,
	dimColor,
	onToggle,
}: {
	color: string;
	label: string;
	hidden: boolean;
	dimColor: string;
	onToggle: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onToggle}
			aria-pressed={!hidden}
			title={hidden ? `Show ${label}` : `Hide ${label}`}
			className="inline-flex items-center gap-1.5 cursor-pointer bg-transparent border-0 p-0 transition-opacity hover:opacity-100"
			style={{ opacity: hidden ? 0.4 : 1, color: 'inherit' }}
		>
			<span
				className="inline-block w-2.5 h-2.5 rounded-sm"
				style={{
					backgroundColor: hidden ? 'transparent' : color,
					border: hidden ? `1px solid ${dimColor}` : undefined,
				}}
			/>
			<span style={{ textDecoration: hidden ? 'line-through' : undefined }}>{label}</span>
		</button>
	);
}

export const ActivityTimeline = memo(function ActivityTimeline({
	theme,
	buckets,
	colors,
	height = 96,
	showLegend = true,
	defaultHiddenSeries,
}: ActivityTimelineProps) {
	// Seeded once from the prop: later prop changes do not clobber a choice the
	// user has already made in this session.
	const [hidden, setHidden] = useState<Set<TimelineSeries>>(
		() => new Set(defaultHiddenSeries ?? [])
	);

	const toggle = useCallback((key: TimelineSeries) => {
		setHidden((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	}, []);

	const palette: Record<TimelineSeries, string> = {
		auto: colors?.auto ?? theme.colors.warning,
		user: colors?.user ?? theme.colors.accent,
		cue: colors?.cue ?? CUE_COLOR,
		agent: colors?.agent ?? AGENT_COLOR,
	};

	const counts = buckets.map((b) => ({
		user: b.user,
		auto: b.auto,
		cue: b.cue,
		agent: b.agent ?? 0,
	}));

	const visible = SERIES_ORDER.filter((s) => !hidden.has(s.key));
	const totals = counts.map((c) => visible.reduce((sum, s) => sum + c[s.key], 0));
	const max = Math.max(1, ...totals);
	const hasActivity = totals.some((t) => t > 0);
	const allHidden = visible.length === 0;

	return (
		<div className="flex flex-col gap-3">
			{hasActivity ? (
				<div className="flex items-end gap-0.5" style={{ height }}>
					{counts.map((count, i) => {
						const total = totals[i];
						const colHeightPct = (total / max) * 100;
						// Tooltip mirrors what is drawn: a hidden series is not in the
						// column, so quoting its count here would misread the bar.
						const title = TOOLTIP_ORDER.filter((s) => !hidden.has(s.key))
							.map((s) => `${s.label} ${count[s.key]}`)
							.join(' · ');
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
									{/* Stack order is fixed (cue, agent, user, auto) so hiding a
									    series never reshuffles the ones that remain. */}
									{(['cue', 'agent', 'user', 'auto'] as TimelineSeries[]).map((key) =>
										!hidden.has(key) && count[key] > 0 ? (
											<div
												key={key}
												style={{ flexGrow: count[key], backgroundColor: palette[key] }}
											/>
										) : null
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
					{allHidden
						? 'All sources hidden - click a legend entry to show one'
						: 'No activity in this window'}
				</div>
			)}

			{showLegend && (
				<div
					className="flex items-center gap-4 text-xs-plus select-none"
					style={{ color: theme.colors.textDim }}
				>
					{SERIES_ORDER.map((s) => (
						<LegendToggle
							key={s.key}
							color={palette[s.key]}
							label={s.label}
							hidden={hidden.has(s.key)}
							dimColor={theme.colors.textDim}
							onToggle={() => toggle(s.key)}
						/>
					))}
				</div>
			)}
		</div>
	);
});

export default ActivityTimeline;
