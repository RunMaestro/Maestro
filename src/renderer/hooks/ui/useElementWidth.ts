/**
 * useElementWidth - track an element's rendered width via ResizeObserver.
 *
 * For layout that has to be computed in JS rather than CSS: an inline SVG chart
 * needs a real pixel width for its viewBox, and a responsive breakpoint that
 * switches column counts needs a number to compare. Anything expressible in CSS
 * should stay in CSS.
 *
 * Returns 0 until the first measurement lands, so callers should treat 0 as
 * "not measured yet" and skip rendering width-dependent content on that frame
 * rather than drawing a zero-width chart.
 *
 * ```tsx
 * const ref = useRef<HTMLDivElement>(null);
 * const width = useElementWidth(ref);
 * return <div ref={ref}>{width > 0 && <Sparkline width={width} ... />}</div>;
 * ```
 */

import { useEffect, useState, type RefObject } from 'react';

export function useElementWidth(ref: RefObject<HTMLElement | null>, enabled = true): number {
	const [width, setWidth] = useState(0);

	useEffect(() => {
		const element = ref.current;
		if (!enabled || !element) {
			return;
		}

		const measure = () => setWidth(element.offsetWidth);
		measure();

		// jsdom has no layout engine and no ResizeObserver by default; bail out
		// rather than throwing so component tests can render without a polyfill.
		if (typeof ResizeObserver === 'undefined') {
			return;
		}

		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref, enabled]);

	return width;
}

/**
 * useFreeWidthInFlexRow - how much room a flex child has LEFT, measured from
 * its parent rather than from itself.
 *
 * Reach for this instead of `useElementWidth` when the element's own width is
 * the thing being decided. Measuring yourself in order to choose your own size
 * is circular: you render at some size, measure it, conclude it fits (it is
 * your own width, so it always does), and never move. Squeeze the row and the
 * loop runs the other way, each measurement feeding the next choice, which
 * oscillates.
 *
 * The parent breaks the loop because nothing here depends on the child. The
 * figure returned is the parent's content box minus its other children and the
 * gaps between all of them, so it answers "what is left for me" without ever
 * consulting what the child currently renders as.
 *
 * The child should still be allowed to shrink (`min-w-0` with flex-shrink left
 * at its default) so an answer this hook has not caught up with yet costs a
 * clipped child rather than a row that pushes its neighbours out of view.
 *
 * Siblings are observed alongside the parent, since a row can be squeezed
 * either by the container narrowing or by a neighbour growing.
 */
export function useFreeWidthInFlexRow(ref: RefObject<HTMLElement | null>, enabled = true): number {
	const [free, setFree] = useState(0);

	useEffect(() => {
		const element = ref.current;
		const parent = element?.parentElement;
		if (!enabled || !element || !parent) {
			return;
		}

		const measure = () => {
			const style = getComputedStyle(parent);
			const children = Array.from(parent.children) as HTMLElement[];
			const siblingsWidth = children.reduce(
				(sum, child) => (child === element ? sum : sum + child.offsetWidth),
				0
			);
			// clientWidth includes the parent's padding, so take it back off.
			const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
			const gap = parseFloat(style.columnGap);
			const gaps = Number.isFinite(gap) ? gap * Math.max(0, children.length - 1) : 0;
			setFree(
				Math.max(
					0,
					parent.clientWidth - (Number.isFinite(padding) ? padding : 0) - siblingsWidth - gaps
				)
			);
		};
		measure();

		// jsdom has no layout engine and no ResizeObserver by default; bail out
		// rather than throwing so component tests can render without a polyfill.
		if (typeof ResizeObserver === 'undefined') {
			return;
		}

		const observer = new ResizeObserver(measure);
		observer.observe(parent);
		for (const child of Array.from(parent.children)) {
			if (child !== element) observer.observe(child);
		}
		return () => observer.disconnect();
	}, [ref, enabled]);

	return free;
}
