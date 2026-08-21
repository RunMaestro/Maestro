/**
 * useHorizontalScroll - drive a horizontally scrolling strip.
 *
 * Returns which directions still have content off-screen, so a strip can render
 * an honest affordance (edge fade, arrow button) instead of leaving the user to
 * guess that more exists past the edge, plus a `scrollByPage` that advances
 * roughly one visible width at a time.
 *
 * It also maps vertical wheel deltas onto the horizontal axis, because a strip
 * with no vertical overflow otherwise swallows the gesture and does nothing on
 * a mouse wheel or a trackpad flick.
 *
 * ```tsx
 * const ref = useRef<HTMLDivElement>(null);
 * const { canScrollLeft, canScrollRight, scrollByPage } = useHorizontalScroll(ref);
 * ```
 */

import { useCallback, useEffect, useState, type RefObject } from 'react';

/** Absorbs fractional scrollLeft values so an end-stop reads as "at the end". */
const EDGE_SLACK_PX = 2;

export interface HorizontalScrollState {
	/** Content exists to the left of the viewport. */
	canScrollLeft: boolean;
	/** Content exists to the right of the viewport. */
	canScrollRight: boolean;
	/** Scroll roughly one visible width in the given direction. */
	scrollByPage: (direction: 'left' | 'right') => void;
}

export function useHorizontalScroll(
	ref: RefObject<HTMLElement | null>,
	/** Re-measure when this changes (item count, filter, etc.). */
	resetKey?: unknown
): HorizontalScrollState {
	const [canScrollLeft, setCanScrollLeft] = useState(false);
	const [canScrollRight, setCanScrollRight] = useState(false);

	useEffect(() => {
		const element = ref.current;
		if (!element) return;

		const measure = () => {
			const maxScrollLeft = element.scrollWidth - element.clientWidth;
			setCanScrollLeft(element.scrollLeft > EDGE_SLACK_PX);
			setCanScrollRight(element.scrollLeft < maxScrollLeft - EDGE_SLACK_PX);
		};
		measure();

		element.addEventListener('scroll', measure, { passive: true });

		// A strip has no vertical overflow of its own, so a wheel gesture over it
		// would otherwise scroll an ancestor (or nothing at all).
		const onWheel = (event: WheelEvent) => {
			const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
			if (delta === 0) return;
			const maxScrollLeft = element.scrollWidth - element.clientWidth;
			if (maxScrollLeft <= 0) return;
			event.preventDefault();
			element.scrollLeft = Math.max(0, Math.min(maxScrollLeft, element.scrollLeft + delta));
		};
		element.addEventListener('wheel', onWheel, { passive: false });

		// jsdom has no layout engine and no ResizeObserver by default; skip the
		// observer rather than throwing so component tests render without a polyfill.
		const observer =
			typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => measure());
		observer?.observe(element);

		return () => {
			element.removeEventListener('scroll', measure);
			element.removeEventListener('wheel', onWheel);
			observer?.disconnect();
		};
	}, [ref, resetKey]);

	const scrollByPage = useCallback(
		(direction: 'left' | 'right') => {
			const element = ref.current;
			if (!element) return;
			const distance = Math.max(element.clientWidth * 0.8, 1);
			element.scrollBy({
				left: direction === 'left' ? -distance : distance,
				behavior: 'smooth',
			});
		},
		[ref]
	);

	return { canScrollLeft, canScrollRight, scrollByPage };
}
