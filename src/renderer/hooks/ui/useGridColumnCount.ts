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
 * Returns 1 when there is nothing to measure - no element yet, an empty grid,
 * or an environment with no layout engine (jsdom). One column is the safe
 * degenerate case: grid navigation collapses to plain list navigation rather
 * than jumping by a made-up row width.
 */

import { useEffect, useState, type RefObject } from 'react';

/** Count the used tracks in a resolved `grid-template-columns` value. */
function countTracks(el: HTMLElement): number {
	const template = getComputedStyle(el).gridTemplateColumns;
	if (!template || template === 'none') return 1;
	const tracks = template.trim().split(/\s+/).filter(Boolean);
	return Math.max(1, tracks.length);
}

/**
 * @param ref - the grid container
 * @param itemCount - re-measure when the item count changes (`auto-fill` track
 *   counts move with content, and the observer alone would not see it)
 */
export function useGridColumnCount(ref: RefObject<HTMLElement | null>, itemCount: number): number {
	const [columns, setColumns] = useState(1);

	useEffect(() => {
		const el = ref.current;
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
	}, [ref, itemCount]);

	return columns;
}
