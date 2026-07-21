/**
 * AgentActivityBars
 *
 * Part of the shared output-widget library: theme-aware, presentational-only
 * (no IPC, no store reads), independent of any Encore flag. Renders horizontal
 * bars for labeled counts (e.g. per-agent history entries), sorted descending,
 * capped at a top-N with a summarized overflow row so a long tail never blows
 * out the layout. All data arrives through props.
 */

import React, { memo, useMemo } from 'react';
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
		// Grid so every row shares one label column: it hugs the longest agent
		// name (names right-justified, sitting right up against the bars) and is
		// capped at half the widget so a pathological name can't starve the bars.
		<div
			className="grid items-center gap-x-3 gap-y-2 text-xs"
			style={{ gridTemplateColumns: 'fit-content(50%) minmax(0, 1fr) auto' }}
		>
			{rows.map((row) => {
				const widthPct = Math.max(2, (row.value / max) * 100);
				return (
					<React.Fragment key={row.label}>
						<span className="text-right break-words" style={{ color: theme.colors.textMain }}>
							{row.label}
						</span>
						<div
							className="h-2.5 rounded-full overflow-hidden"
							style={{ backgroundColor: theme.colors.border }}
						>
							<div
								className="h-full rounded-full"
								style={{ width: `${widthPct}%`, backgroundColor: row.color ?? theme.colors.accent }}
							/>
						</div>
						<span className="text-right tabular-nums" style={{ color: theme.colors.textDim }}>
							{formatNumber(row.value)}
						</span>
					</React.Fragment>
				);
			})}
			{overflowCount > 0 && (
				<>
					<span className="text-right pt-1" style={{ color: theme.colors.textDim }}>
						+{overflowCount} more {overflowCount === 1 ? 'agent' : 'agents'}
					</span>
					<div />
					<span className="text-right tabular-nums pt-1" style={{ color: theme.colors.textDim }}>
						{formatNumber(overflowValue)}
					</span>
				</>
			)}
		</div>
	);
});

export default AgentActivityBars;
