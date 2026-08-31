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
 * a mouse wheel or a trackpad flick. A gesture that is ALREADY horizontal is
 * left to the browser, which scrolls it with the platform's own momentum - a
 * hand-written position write cannot reproduce that and only feels worse.
 *
 * ```tsx
 * const ref = useRef<HTMLDivElement>(null);
 * const { canScrollLeft, canScrollRight, scrollByPage } = useHorizontalScroll(ref);
 * ```
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { useEventListener } from '../utils/useEventListener';

/** Absorbs fractional scrollLeft values so an end-stop reads as "at the end". */
const EDGE_SLACK_PX = 2;

/** Assumed line height when a device reports wheel deltas in lines, not pixels. */
const WHEEL_LINE_HEIGHT_PX = 16;

/**
 * Wheel deltas are not always pixels: `deltaMode` says whether the number counts
 * pixels (0), lines (1), or pages (2). Taking the raw value is what makes a
 * line-reporting mouse crawl three pixels per notch, so convert before using it.
 */
function wheelDeltaToPixels(delta: number, deltaMode: number, pageSize: number): number {
	if (deltaMode === 1) return delta * WHEEL_LINE_HEIGHT_PX;
	if (deltaMode === 2) return delta * pageSize;
	return delta;
}

/**
 * Move a scroll box to an absolute horizontal offset.
 *
 * jsdom implements `scrollLeft` but not `scrollTo`, so calling the method
 * unguarded throws anywhere the shared test setup's stub is not installed. The
 * fallback does exactly what an instant `scrollTo` does anyway.
 */
function scrollElementTo(element: HTMLElement, left: number, behavior: ScrollBehavior): void {
	if (typeof element.scrollTo === 'function') {
		element.scrollTo({ left, behavior });
		return;
	}
	element.scrollLeft = left;
}

export interface HorizontalScrollState {
	/** Content exists to the left of the viewport. */
	canScrollLeft: boolean;
	/** Content exists to the right of the viewport. */
	canScrollRight: boolean;
	/** Scroll roughly one visible width in the given direction. */
	scrollByPage: (direction: 'left' | 'right') => void;
	/**
	 * Bring a child fully into view, scrolling the least amount that does it.
	 *
	 * `edgePaddingPx` is dead space to keep clear at each end - pass the width of
	 * whatever the strip floats over its own edges (fades, arrow buttons) so a
	 * child does not come to rest underneath them.
	 */
	scrollIntoView: (child: HTMLElement | null | undefined, edgePaddingPx?: number) => void;
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

	// Coalesce to one measurement per frame. A scroll event fires far faster than
	// the screen repaints, and `measure` reads `scrollWidth`/`clientWidth`, so
	// measuring per event forces a synchronous layout on the main thread for every
	// event in a flick - work the user pays for as stutter and that no one ever sees.
	const measureFrameRef = useRef<number | null>(null);
	const scheduleMeasure = useCallback(() => {
		if (measureFrameRef.current !== null) return;
		measureFrameRef.current = requestAnimationFrame(() => {
			measureFrameRef.current = null;
			measure();
		});
	}, [measure]);

	useEffect(
		() => () => {
			if (measureFrameRef.current !== null) cancelAnimationFrame(measureFrameRef.current);
		},
		[]
	);

	useEventListener('scroll', scheduleMeasure, { target: element, passive: true });

	// A strip has no vertical overflow of its own, so a VERTICAL wheel gesture over
	// it would otherwise scroll an ancestor (or nothing at all).
	useEventListener(
		'wheel',
		(event) => {
			if (!element) return;
			const wheel = event as WheelEvent;

			// A horizontal gesture (trackpad two-finger swipe, tilt wheel) already
			// targets this strip's axis. Hand it back to the browser: the native path
			// carries the platform's momentum and interruption behaviour, and taking
			// it over replaces a fling with a stepped, dead-feeling drag.
			if (Math.abs(wheel.deltaX) > Math.abs(wheel.deltaY)) return;
			if (wheel.deltaY === 0) return;

			const maxScrollLeft = element.scrollWidth - element.clientWidth;
			if (maxScrollLeft <= 0) return;

			const delta = wheelDeltaToPixels(wheel.deltaY, wheel.deltaMode, element.clientWidth);

			// Only claim the gesture when it actually moves this strip. At an end
			// stop, a further scroll in that direction belongs to the surrounding
			// page - swallowing it there traps the user's pointer over a strip that
			// no longer responds while the wizard behind it refuses to scroll.
			const target = Math.max(0, Math.min(maxScrollLeft, element.scrollLeft + delta));
			if (target === element.scrollLeft) return;

			wheel.preventDefault();
			// `'instant'`, not a bare `scrollLeft =` and not `'auto'`: both defer to
			// the element's computed `scroll-behavior`, and on a strip that opts into
			// `scroll-smooth` for its arrow buttons that turns every wheel tick into a
			// fresh ~300ms eased animation started from the position the previous one
			// had reached. A flick queues dozens of them and the strip drifts along
			// behind the gesture instead of tracking it.
			scrollElementTo(element, target, 'instant');
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
			const maxScrollLeft = Math.max(0, element.scrollWidth - element.clientWidth);
			const target = Math.max(
				0,
				Math.min(maxScrollLeft, element.scrollLeft + (direction === 'left' ? -distance : distance))
			);
			scrollElementTo(element, target, 'smooth');
		},
		[element]
	);

	const scrollIntoView = useCallback(
		(child: HTMLElement | null | undefined, edgePaddingPx = 0) => {
			if (!element || !child) return;
			const maxScrollLeft = element.scrollWidth - element.clientWidth;
			if (maxScrollLeft <= 0) return;

			// Measured from rects rather than `offsetLeft`, which is relative to the
			// nearest positioned ancestor - that is the strip's wrapper here, not the
			// strip, so an offset-based version silently drifts by the wrapper's padding.
			const childRect = child.getBoundingClientRect();
			const stripRect = element.getBoundingClientRect();
			const pastLeftEdge = stripRect.left + edgePaddingPx - childRect.left;
			const pastRightEdge = childRect.right - (stripRect.right - edgePaddingPx);

			// Scroll the minimum that reveals the child, and only for the edge it is
			// actually past. A child wider than the viewport overflows BOTH edges, so
			// the left case wins: leading edge visible beats trailing edge visible.
			let delta = 0;
			if (pastLeftEdge > 0) delta = -pastLeftEdge;
			else if (pastRightEdge > 0) delta = pastRightEdge;
			if (delta === 0) return;

			const target = Math.max(0, Math.min(maxScrollLeft, element.scrollLeft + delta));
			if (target === element.scrollLeft) return;
			scrollElementTo(element, target, 'smooth');
		},
		[element]
	);

	return { canScrollLeft, canScrollRight, scrollByPage, scrollIntoView };
}
