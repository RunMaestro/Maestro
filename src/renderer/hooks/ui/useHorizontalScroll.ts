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
import { useEventListener } from '../utils/useEventListener';

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

	// `useEventListener` takes the element itself, not a ref, and a ref filling in
	// does not re-render. Mirroring it into state gives the listeners a real
	// target on the render after mount, instead of subscribing to null forever.
	const [element, setElement] = useState<HTMLElement | null>(null);
	useEffect(() => {
		setElement(ref.current);
	}, [ref, resetKey]);

	const measure = useCallback(() => {
		if (!element) return;
		const maxScrollLeft = element.scrollWidth - element.clientWidth;
		setCanScrollLeft(element.scrollLeft > EDGE_SLACK_PX);
		setCanScrollRight(element.scrollLeft < maxScrollLeft - EDGE_SLACK_PX);
	}, [element]);

	useEventListener('scroll', measure, { target: element, passive: true });

	// A strip has no vertical overflow of its own, so a wheel gesture over it
	// would otherwise scroll an ancestor (or nothing at all).
	useEventListener(
		'wheel',
		(event) => {
			if (!element) return;
			const wheel = event as WheelEvent;
			const delta = Math.abs(wheel.deltaX) > Math.abs(wheel.deltaY) ? wheel.deltaX : wheel.deltaY;
			if (delta === 0) return;

			const maxScrollLeft = element.scrollWidth - element.clientWidth;
			if (maxScrollLeft <= 0) return;

			// Only claim the gesture when it actually moves this strip. At an end
			// stop, a further scroll in that direction belongs to the surrounding
			// page - swallowing it there traps the user's pointer over a strip that
			// no longer responds while the wizard behind it refuses to scroll.
			const target = Math.max(0, Math.min(maxScrollLeft, element.scrollLeft + delta));
			if (target === element.scrollLeft) return;

			wheel.preventDefault();
			element.scrollLeft = target;
		},
		{ target: element, passive: false }
	);

	useEffect(() => {
		if (!element) return;
		measure();

		// jsdom has no layout engine and no ResizeObserver by default; skip the
		// observer rather than throwing so component tests render without a polyfill.
		if (typeof ResizeObserver === 'undefined') return;
		const observer = new ResizeObserver(() => measure());
		observer.observe(element);
		return () => observer.disconnect();
	}, [element, measure, resetKey]);

	const scrollByPage = useCallback(
		(direction: 'left' | 'right') => {
			if (!element) return;
			const distance = Math.max(element.clientWidth * 0.8, 1);
			element.scrollBy({
				left: direction === 'left' ? -distance : distance,
				behavior: 'smooth',
			});
		},
		[element]
	);

	return { canScrollLeft, canScrollRight, scrollByPage };
}
