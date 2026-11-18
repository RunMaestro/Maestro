/**
 * Shared utilities for UsageDashboard chart components.
 *
 * Worktree differentiation helpers let charts visually distinguish
 * worktree child agents from regular agents and parent agents. A provider row
 * is labeled with `getAgentDisplayName()` (src/shared/agentMetadata.ts), never
 * with one agent's name.
 */

import type { CSSProperties } from 'react';
import type { Session, Theme } from '../../types';
import { COLORBLIND_AGENT_PALETTE } from '../../constants/colorblindPalettes';

// `clampTooltipToViewport` was relocated into the shared widget library (so the
// library's ChartTooltip primitive owns its geometry without depending back on
// UsageDashboard). Re-export it here to keep the historical chartUtils API
// stable for any existing importer.
export { clampTooltipToViewport } from '../widgets/output/tooltipGeometry';

/** Colors for series after the first, which takes the theme accent. */
const SERIES_COLORS = [
	'#10b981',
	'#8b5cf6',
	'#ef4444',
	'#06b6d4',
	'#ec4899',
	'#f59e0b',
	'#84cc16',
	'#6366f1',
];

/**
 * Color for the Nth series of a chart (a provider, an agent, a model). One
 * mapping for every dashboard chart, so the same index reads as the same color
 * when two charts sit side by side.
 */
export function getSeriesColor(index: number, theme: Theme, colorBlindMode?: boolean): string {
	if (colorBlindMode) {
		return COLORBLIND_AGENT_PALETTE[index % COLORBLIND_AGENT_PALETTE.length];
	}
	if (index === 0) return theme.colors.accent;
	return SERIES_COLORS[(index - 1) % SERIES_COLORS.length];
}

/**
 * Providers ordered by query count, busiest first (ties broken by key so the
 * order is stable). The ONE ordering every provider chart reads: the index a
 * provider has here is the index it passes to `getSeriesColor`, so Provider
 * Comparison and Provider Trends paint the same provider the same color, and
 * the Overview's "Top Provider" card names the first entry.
 */
export function rankProvidersByCount(
	byAgent: Readonly<Record<string, { count: number }>> | undefined
): string[] {
	return Object.entries(byAgent ?? {})
		.sort(([keyA, a], [keyB, b]) => b.count - a.count || keyA.localeCompare(keyB))
		.map(([key]) => key);
}

/**
 * Returns true if the session is a worktree child (was spawned from a parent agent).
 */
export function isWorktreeAgent(session: Session): boolean {
	return !!session.parentSessionId;
}

/**
 * Returns true if the agent is a worktree PARENT: at least one live agent in
 * `sessions` was spawned from it. A `worktreeConfig` alone (a worktree folder
 * configured, nothing spawned yet) does not make an agent a parent, and an
 * agent with no worktrees is not one either, so "parent" counts never fold in
 * every standalone agent.
 */
export function isParentAgent(session: Session, sessions: readonly Session[]): boolean {
	return sessions.some((other) => other.parentSessionId === session.id);
}

/**
 * Axis-label budget for a phone-width chart.
 *
 * The default seven labels assume a desktop axis: seven `Aug 20`-sized dates
 * need roughly 300px, and a phone gives a chart about 340px total, so they
 * printed on top of each other and every date read as a smear. Four fit.
 */
export const PHONE_AXIS_LABELS = 4;

/**
 * Pick which x-axis tick indices should carry a label.
 *
 * Every time-series chart on the dashboard wants roughly seven labels and always
 * wants the final one, so the axis ends on the real end date. Naively forcing
 * that last label is what caused overlapping text at the right edge: when the
 * series length isn't a multiple of the interval, the forced label lands one or
 * two slots after the previous one and the two strings collide (e.g. "Jul 25"
 * printed on top of "Jul 26").
 *
 * Here the last label still always wins, but the preceding label is dropped when
 * it would sit closer than a full interval - so labels are never spaced tighter
 * than the interval the chart already deemed readable.
 *
 * @param count - number of ticks on the axis
 * @returns the set of indices to label
 */
export function computeAxisLabelIndices(count: number, maxLabels = 7): Set<number> {
	if (count <= 0) return new Set();

	// Same density heuristic the charts used individually: ~7 labels max.
	// `maxLabels` is how a caller says its axis is narrower than that assumes -
	// seven "Aug 20"-sized labels need about 300px, so on a phone they printed
	// on top of each other and every date read as a four-digit smear.
	const budget = Math.max(2, maxLabels);
	const interval = count > 2 * budget ? Math.ceil(count / budget) : count > budget ? 2 : 1;

	const indices: number[] = [];
	for (let i = 0; i < count; i += interval) indices.push(i);

	const last = count - 1;
	const previous = indices[indices.length - 1];
	if (previous !== last) {
		if (last - previous < interval) indices.pop();
		indices.push(last);
	}

	return new Set(indices);
}

/**
 * Split a dense per-day series into at most `maxGroups` runs of equal length
 * (the last run may be shorter), for a long range that would otherwise draw
 * more bars than the chart has pixels for. Returns one single-item group per
 * day when the series already fits.
 *
 * Grouping is by a fixed number of consecutive days rather than by calendar
 * week: the buckets stay equal width, which is what makes neighbouring bars
 * comparable, and a partial week at either end can't render as a dip that never
 * happened.
 */
export function chunkIntoEqualGroups<T>(items: readonly T[], maxGroups: number): T[][] {
	const limit = Math.max(1, maxGroups);
	if (items.length <= limit) return items.map((item) => [item]);
	const groupSize = Math.ceil(items.length / limit);
	const groups: T[][] = [];
	for (let i = 0; i < items.length; i += groupSize) groups.push(items.slice(i, i + groupSize));
	return groups;
}

/**
 * Layout for the dashboard's horizontal bar charts (Agent Efficiency, Agent
 * Comparison, By Agent Type, the token cost breakdowns): one CSS grid whose
 * first column is the name, second the bar, third the trailing value.
 *
 * The name column is sized by the browser to the widest label it actually
 * renders (`fit-content`), so every label reads in full and every bar starts
 * at the same x. The bar column takes what is left. This replaced a per-chart
 * width ESTIMATED from character count, which came out short of the real text
 * ("Claude Co..." beside a bar with hundreds of spare pixels) and could never
 * account for the user's font or zoom. The 50% ceiling keeps one pathological
 * user-assigned agent name from erasing the bars; past it the label ellipsizes
 * and the row's `title` carries the full name.
 *
 * Each row spreads `BAR_CHART_ROW_STYLE` so it stays one box (hover, click,
 * focus, role all still live on the row) while its three children sit in the
 * parent's shared columns via subgrid. The trailing column is shared too, so
 * a row with a longer value does not shorten its own bar.
 */
export const BAR_CHART_GRID_CLASS = 'grid gap-x-3 gap-y-2';

export const BAR_CHART_GRID_STYLE: CSSProperties = {
	gridTemplateColumns: 'fit-content(50%) minmax(0, 1fr) auto',
};

export const BAR_CHART_ROW_STYLE: CSSProperties = {
	display: 'grid',
	gridTemplateColumns: 'subgrid',
	gridColumn: '1 / -1',
	alignItems: 'center',
};

/**
 * Geometry shared by the dashboard's donut charts (Query Source and Query
 * Location, both drawn by `DistributionDonut`) so they stay visually
 * identical and the center label always has room for its longest value.
 *
 * `centerLabelWidth` is the widest a center label may be drawn: a chord of the
 * hole rather than its full diameter, so a long string ("1,234h 56m") stops
 * before it reaches the ring instead of painting over it.
 */
export const DONUT_CHART = {
	size: 200,
	outerRadius: 88,
	innerRadius: 62,
	/** Extra radius the hovered slice pops out by. */
	hoverExpansion: 4,
	centerLabelWidth: 106,
} as const;

/**
 * SVG arc path generator for donut chart segments.
 *
 * Angles are degrees clockwise from 12 o'clock. A sweep of (near) 360 degrees
 * is drawn as two half arcs, because a single arc whose start and end points
 * coincide renders as nothing.
 */
export function describeDonutArc(
	x: number,
	y: number,
	outerRadius: number,
	innerRadius: number,
	startAngle: number,
	endAngle: number
): string {
	if (endAngle - startAngle >= 359.99) {
		const midAngle = startAngle + 180;
		return `
      ${describeDonutArc(x, y, outerRadius, innerRadius, startAngle, midAngle)}
      ${describeDonutArc(x, y, outerRadius, innerRadius, midAngle, endAngle)}
    `;
	}

	const startRad = (startAngle - 90) * (Math.PI / 180);
	const endRad = (endAngle - 90) * (Math.PI / 180);

	const startOuterX = x + outerRadius * Math.cos(startRad);
	const startOuterY = y + outerRadius * Math.sin(startRad);
	const endOuterX = x + outerRadius * Math.cos(endRad);
	const endOuterY = y + outerRadius * Math.sin(endRad);

	const startInnerX = x + innerRadius * Math.cos(startRad);
	const startInnerY = y + innerRadius * Math.sin(startRad);
	const endInnerX = x + innerRadius * Math.cos(endRad);
	const endInnerY = y + innerRadius * Math.sin(endRad);

	const largeArcFlag = endAngle - startAngle > 180 ? 1 : 0;

	return `
    M ${startOuterX} ${startOuterY}
    A ${outerRadius} ${outerRadius} 0 ${largeArcFlag} 1 ${endOuterX} ${endOuterY}
    L ${endInnerX} ${endInnerY}
    A ${innerRadius} ${innerRadius} 0 ${largeArcFlag} 0 ${startInnerX} ${startInnerY}
    Z
  `;
}
