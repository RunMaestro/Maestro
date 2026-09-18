import { type RefObject, useLayoutEffect, useState } from 'react';

interface ContextMenuPosition {
	left: number;
	top: number;
	/**
	 * Tallest the menu may be and still fit on screen, in px.
	 *
	 * Apply it together with `overflowY: 'auto'`. Without it a menu taller than
	 * the viewport is not merely mispositioned, it is unusable: the clamp below
	 * computes a NEGATIVE `maxTop`, so `top` pins to `padding` and every item
	 * past the bottom edge is unreachable - a context menu does not scroll the
	 * page, and these containers are `overflow-hidden`. The file tree's menu
	 * carries up to ~27 entries, which overflows a phone in portrait and a
	 * laptop in a short window.
	 */
	maxHeight: number;
	/** False until the menu has been measured and repositioned */
	ready: boolean;
}

/**
 * Measures a context menu after render and adjusts its position
 * so it stays fully visible within the viewport.
 *
 * Uses useLayoutEffect to measure before paint, so the user
 * never sees the menu at the wrong position.
 *
 * Usage:
 *   const menuRef = useRef<HTMLDivElement>(null);
 *   const { left, top, maxHeight, ready } = useContextMenuPosition(menuRef, clickX, clickY);
 *   <div ref={menuRef} style={{ left, top, maxHeight, overflowY: 'auto', opacity: ready ? 1 : 0 }} />
 */
export function useContextMenuPosition(
	menuRef: RefObject<HTMLElement | null>,
	x: number,
	y: number,
	padding = 8,
	contentKey?: unknown
): ContextMenuPosition {
	const [position, setPosition] = useState<ContextMenuPosition>({
		left: x,
		top: y,
		maxHeight: Number.POSITIVE_INFINITY,
		ready: false,
	});

	useLayoutEffect(() => {
		const el = menuRef.current;
		if (!el) return;

		const { width, height } = el.getBoundingClientRect();
		const maxLeft = window.innerWidth - width - padding;
		const maxTop = window.innerHeight - height - padding;
		// The budget is measured from where the menu ACTUALLY lands, not from the
		// click: a menu that was pushed up to `padding` has the whole viewport to
		// work with, while one anchored low has only what is below it.
		const top = Math.max(padding, Math.min(y, maxTop));

		setPosition({
			left: Math.max(padding, Math.min(x, maxLeft)),
			top,
			maxHeight: Math.max(0, window.innerHeight - top - padding),
			ready: true,
		});
		// Measuring changes `top`, which would re-run this effect and re-measure
		// forever if `top` were a dependency. It is deliberately derived here and
		// read nowhere else in the effect.
	}, [menuRef, x, y, padding, contentKey]);

	return position;
}
