/**
 * StatCardGrid
 *
 * Part of the shared output-widget library: theme-aware, presentational-only
 * (no IPC, no store reads), independent of any Encore flag. A responsive grid
 * that lays out a set of `StatCard`s, auto-fitting columns to the available
 * width. Receives its card data via props and renders deterministically.
 */

import { memo } from 'react';
import { StatCard } from './StatCard';
import type { StatCardDatum, WidgetProps } from '../types';

interface StatCardGridProps extends WidgetProps {
	/** Cards to render. Each is keyed by its `label`. */
	cards: StatCardDatum[];
	/** Minimum column width in px before the grid wraps (default 160). */
	minColumnWidth?: number;
}

export const StatCardGrid = memo(function StatCardGrid({
	theme,
	cards,
	minColumnWidth = 160,
}: StatCardGridProps) {
	if (cards.length === 0) return null;
	return (
		<div
			className="grid gap-3"
			style={{ gridTemplateColumns: `repeat(auto-fit, minmax(${minColumnWidth}px, 1fr))` }}
		>
			{cards.map((card) => (
				<StatCard key={card.label} theme={theme} {...card} />
			))}
		</div>
	);
});

export default StatCardGrid;
