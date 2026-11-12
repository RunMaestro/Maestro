/**
 * Live column count of a CSS grid element.
 *
 * Keyboard navigation over a responsive grid needs to know how many tiles are
 * in a row RIGHT NOW: an `auto-fill` / `minmax()` track list reflows between 1
 * and N columns as the pane resizes, and an ArrowDown that jumps by a stale
 * column count lands on the wrong tile.
 *
 * The count comes from the resolved `grid-template-columns` (the browser hands
 * back the used track sizes, e.g. `"240px 240px 240px"`), so it works for any
 * track syntax without the caller restating its own breakpoints. A
 * ResizeObserver re-measures on reflow.
 *
 * Takes the ELEMENT, not a ref object. A ref's `.current` changing is invisible
 * to React, so a hook keyed on the ref would keep observing a grid that has
 * since unmounted (say, behind a detail pane) and never measure the one that
 * replaced it. Hold the node in state via a callback ref and pass that in, and
 * every mount re-measures and re-observes. Callers already need the node for
 * focus work, so this costs them nothing.
 *
 * Returns 1 when there is nothing to measure - no element, a detached one, an
 * empty grid, or an environment with no layout engine (jsdom). One column is
 * the safe degenerate case: grid navigation collapses to plain list navigation
 * rather than jumping by a made-up row width.
 */

import { useEffect, useState } from 'react';

/** Count the used tracks in a resolved `grid-template-columns` value. */
function countTracks(el: HTMLElement): number {
	// A detached node resolves to nothing. Measuring one is never informative,
	// and treating its empty value as a real answer is how a grid that is merely
	// hidden for a moment reports a single column.
	if (!el.isConnected) return 1;
	const template = getComputedStyle(el).gridTemplateColumns;
	if (!template || template === 'none') return 1;
	const tracks = template.trim().split(/\s+/).filter(Boolean);
	return Math.max(1, tracks.length);
}

/**
 * @param el - the grid container, or null before it mounts
 * @param itemCount - re-measure when the item count changes (`auto-fill` track
 *   counts move with content, and the observer alone would not see it)
 */
export function useGridColumnCount(el: HTMLElement | null, itemCount: number): number {
	const [columns, setColumns] = useState(1);

	useEffect(() => {
		if (!el) {
			setColumns(1);
			return;
		}

		const measure = () => setColumns(countTracks(el));
		measure();

		if (typeof ResizeObserver === 'undefined') return;
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		return () => observer.disconnect();
	}, [el, itemCount]);

	return columns;
}
