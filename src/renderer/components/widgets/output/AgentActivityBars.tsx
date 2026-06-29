/**
 * AgentActivityBars
 *
 * Part of the shared output-widget library: theme-aware, presentational-only
 * (no IPC, no store reads), independent of any Encore flag. Renders horizontal
 * bars for labeled counts (e.g. per-agent history entries), sorted descending,
 * capped at a top-N with a summarized overflow row so a long tail never blows
 * out the layout. All data arrives through props.
 */

import { memo, useMemo } from 'react';
import { formatNumber } from '../../../../shared/formatters';
import type { BarDatum, WidgetProps } from '../types';

interface AgentActivityBarsProps extends WidgetProps {
	/** Bars to render (unsorted is fine; sorted descending internally). */
	data: BarDatum[];
	/** Maximum rows before collapsing the remainder into an overflow row (default 8). */
	topN?: number;
	/** Empty-state message (default "No agent activity in this window"). */
	emptyLabel?: string;
}

export const AgentActivityBars = memo(function AgentActivityBars({
	theme,
	data,
	topN = 8,
	emptyLabel = 'No agent activity in this window',
}: AgentActivityBarsProps) {
	const { rows, overflowCount, overflowValue, max } = useMemo(() => {
		const sorted = [...data].filter((d) => d.value > 0).sort((a, b) => b.value - a.value);
		const top = sorted.slice(0, topN);
		const rest = sorted.slice(topN);
		const overflow = rest.reduce((sum, d) => sum + d.value, 0);
		const peak = Math.max(1, ...sorted.map((d) => d.value));
		return { rows: top, overflowCount: rest.length, overflowValue: overflow, max: peak };
	}, [data, topN]);

	if (rows.length === 0) {
		return (
			<div className="text-xs py-2" style={{ color: theme.colors.textDim }}>
				{emptyLabel}
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-2">
			{rows.map((row) => {
				const widthPct = Math.max(2, (row.value / max) * 100);
				return (
					<div key={row.label} className="flex items-center gap-3 text-xs">
						<span
							className="w-32 truncate shrink-0"
							style={{ color: theme.colors.textMain }}
							title={row.label}
						>
							{row.label}
						</span>
						<div
							className="flex-1 h-2.5 rounded-full overflow-hidden"
							style={{ backgroundColor: theme.colors.border }}
						>
							<div
								className="h-full rounded-full"
								style={{ width: `${widthPct}%`, backgroundColor: row.color ?? theme.colors.accent }}
							/>
						</div>
						<span
							className="w-10 text-right tabular-nums shrink-0"
							style={{ color: theme.colors.textDim }}
						>
							{formatNumber(row.value)}
						</span>
					</div>
				);
			})}
			{overflowCount > 0 && (
				<div
					className="flex items-center gap-3 text-xs pt-1"
					style={{ color: theme.colors.textDim }}
				>
					<span className="w-32 truncate shrink-0">
						+{overflowCount} more {overflowCount === 1 ? 'agent' : 'agents'}
					</span>
					<div className="flex-1" />
					<span className="w-10 text-right tabular-nums shrink-0">
						{formatNumber(overflowValue)}
					</span>
				</div>
			)}
		</div>
	);
});

export default AgentActivityBars;
