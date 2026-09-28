/**
 * useDragAutoScroll - scroll a container while an HTML5 drag hovers its edge.
 *
 * A scrollable strip (the tab bar, a long list) can hold more items than fit on
 * screen. Without this, a reorder drag can only ever reach the items that are
 * already visible: the pointer hits the edge of the container and the drop
 * target simply stops moving, so the user has to drop, scroll, and drag again.
 *
 * While `active` is true the hook watches `dragover` on the container, and any
 * time the pointer sits inside an edge band it scrolls that way on a rAF loop.
 * Speed ramps with how deep into the band the pointer is, so a nudge creeps and
 * pinning the edge moves fast.
 *
 * Both edges can be inset. A tab bar has sticky controls painted over the
 * scrolling content at each end, so the band has to start where the content is
 * actually visible rather than at the container's own border.
 *
 * ```tsx
 * const ref = useRef<HTMLDivElement>(null);
 * useDragAutoScroll(ref, { active: draggingTabId !== null, startInset: () => 40 });
 * ```
 */

import { useEffect, useRef, type RefObject } from 'react';

export interface UseDragAutoScrollOptions {
	/** Scroll only while a drag this hook cares about is in flight. */
	active: boolean;
	/** Scroll axis. Defaults to horizontal. */
	axis?: 'horizontal' | 'vertical';
	/** Depth of the hot band at each edge, in px. */
	edgeSize?: number;
	/** Top speed at the very edge, in px per second. */
	maxSpeed?: number;
	/** Px of the leading edge covered by sticky content (evaluated per frame). */
	startInset?: () => number;
	/** Px of the trailing edge covered by sticky content (evaluated per frame). */
	endInset?: () => number;
}

/** Drop the pointer if the platform stops reporting it (drag left the window). */
const STALE_POINTER_MS = 600;

export function useDragAutoScroll(
	ref: RefObject<HTMLElement | null>,
	{
		active,
		axis = 'horizontal',
		edgeSize = 64,
		maxSpeed = 900,
		startInset,
		endInset,
	}: UseDragAutoScrollOptions
): void {
	// Options land in refs so a caller passing inline closures does not tear the
	// rAF loop down and rebuild it on every render mid-drag.
	const optionsRef = useRef({ axis, edgeSize, maxSpeed, startInset, endInset });
	optionsRef.current = { axis, edgeSize, maxSpeed, startInset, endInset };

	useEffect(() => {
		const element = ref.current;
		if (!active || !element) return;

		let pointer: { x: number; y: number; at: number } | null = null;
		let frame: number | null = null;
		// null, not 0: a test clock (or a page whose timeline genuinely starts at
		// zero) would otherwise read the first frame as "no baseline yet" twice and
		// swallow a frame of movement.
		let lastFrameAt: number | null = null;

		const onDragOver = (e: DragEvent) => {
			pointer = { x: e.clientX, y: e.clientY, at: performance.now() };
		};

		const step = (now: number) => {
			frame = requestAnimationFrame(step);
			const elapsed = lastFrameAt === null ? 0 : now - lastFrameAt;
			lastFrameAt = now;
			if (!pointer || elapsed <= 0) return;

			// A drag that left the window stops delivering dragover. Without this
			// the last known position would keep the strip scrolling forever.
			if (now - pointer.at > STALE_POINTER_MS) {
				pointer = null;
				return;
			}

			const { axis: a, edgeSize: band, maxSpeed: speed, startInset, endInset } = optionsRef.current;
			const rect = element.getBoundingClientRect();
			const horizontal = a === 'horizontal';

			// Ignore a pointer that has wandered off the strip on the cross axis:
			// it is over some other surface, not asking us to scroll.
			const cross = horizontal ? pointer.y : pointer.x;
			const crossMin = horizontal ? rect.top : rect.left;
			const crossMax = horizontal ? rect.bottom : rect.right;
			if (cross < crossMin || cross > crossMax) return;

			const position = horizontal ? pointer.x : pointer.y;
			const start = (horizontal ? rect.left : rect.top) + (startInset?.() ?? 0);
			const end = (horizontal ? rect.right : rect.bottom) - (endInset?.() ?? 0);
			if (end - start <= 0) return;

			// Bands never overlap, so a narrow strip still has a neutral middle.
			const reach = Math.min(band, (end - start) / 2);
			let direction = 0;
			let intensity = 0;
			if (position < start + reach) {
				direction = -1;
				intensity = (start + reach - position) / reach;
			} else if (position > end - reach) {
				direction = 1;
				intensity = (position - (end - reach)) / reach;
			}
			if (direction === 0) return;

			// Clamp rather than extrapolate: past the edge is full speed, not more.
			intensity = Math.min(1, Math.max(0, intensity));
			const delta = direction * speed * intensity * (elapsed / 1000);
			if (horizontal) {
				element.scrollLeft += delta;
			} else {
				element.scrollTop += delta;
			}
		};

		element.addEventListener('dragover', onDragOver);
		frame = requestAnimationFrame(step);

		return () => {
			element.removeEventListener('dragover', onDragOver);
			if (frame !== null) cancelAnimationFrame(frame);
		};
	}, [ref, active]);
}
