/**
 * useAnchoredMenuPosition - place a portaled dropdown against an anchor element.
 *
 * Dropdowns anchored inside the Main Panel header can't be positioned with
 * `absolute top-full`: the header wraps its left cluster in `overflow-hidden`
 * boxes that are only as tall as the pill, so anything hanging below is clipped
 * to nothing. `position: fixed` alone doesn't save you either, because
 * `.header-container` sets `container-type: inline-size` (implying
 * `contain: layout`), which makes the header a containing block for fixed
 * descendants. The same clipping bites any menu inside a small floating frame
 * (the media player widget), which is why `placement: 'above'` lives here too.
 * The fix is to portal the menu to document.body and position it from the
 * anchor's measured rect - which is what this hook computes.
 *
 * The same clip bites a nested context-menu flyout: every context menu is
 * `overflow-y: auto` so a long one scrolls, and CSS computes the other axis to
 * `auto` as soon as one axis is not `visible`, so an `absolute; left: 100%`
 * submenu is clipped out of existence. `placement: 'right' | 'left'` is that
 * case: it places the menu BESIDE the anchor rather than under it.
 *
 * Usage:
 *   const menuRef = useRef<HTMLDivElement>(null);
 *   const { left, top, maxHeight, ready } = useAnchoredMenuPosition(menuRef, anchorRef);
 *   return createPortal(
 *     <div ref={menuRef} className="fixed" style={{ left, top, opacity: ready ? 1 : 0 }} />,
 *     document.body
 *   );
 */

import { useLayoutEffect, useState, type RefObject } from 'react';
import { useContextMenuPosition } from './useContextMenuPosition';

/** Default gap between the anchor and the menu. */
const DEFAULT_GAP_PX = 6;

/**
 * Which side of the anchor the menu grows from. `below`/`above` stack it under
 * or over the anchor (a dropdown); `right`/`left` put it beside the anchor (a
 * nested menu flyout), aligned to the anchor's top edge.
 */
export type AnchoredMenuPlacement = 'below' | 'above' | 'right' | 'left';
/**
 * Which edges line up. For `below`/`above`: `start` matches left edges, `end`
 * matches right edges. For `right`/`left`: `start` matches top edges, `end`
 * matches bottom edges.
 */
export type AnchoredMenuAlign = 'start' | 'end';

export interface AnchoredMenuOptions {
	/** Pixels between the anchor edge and the menu. */
	gap?: number;
	placement?: AnchoredMenuPlacement;
	align?: AnchoredMenuAlign;
	/**
	 * For `right`/`left` placement only: swap to the other side when the menu
	 * does not fit on the preferred one and does fit opposite. Without it a
	 * flyout near the right screen edge is clamped back over its own parent
	 * menu rather than opening leftwards.
	 */
	flip?: boolean;
}

export interface AnchoredMenuPosition {
	left: number;
	top: number;
	/**
	 * Tallest the menu may be and still fit on screen, in px - passed straight
	 * through from `useContextMenuPosition`. Apply it with `overflowY: 'auto'`
	 * on any menu whose content is unbounded; see that hook for why clamping
	 * position alone leaves the overflowing items unreachable.
	 */
	maxHeight: number;
	/** False until the menu has been measured; render at opacity 0 until true. */
	ready: boolean;
}

interface AnchorRect {
	left: number;
	right: number;
	top: number;
	bottom: number;
}

/**
 * @param menuRef  The portaled menu element, measured to keep it on screen.
 * @param anchorRef The element the menu hangs off (pill, button, widget).
 * @param options  Gap/placement/alignment, or a bare number for the gap.
 */
export function useAnchoredMenuPosition(
	menuRef: RefObject<HTMLElement | null>,
	anchorRef: RefObject<HTMLElement | null>,
	options: number | AnchoredMenuOptions = {}
): AnchoredMenuPosition {
	const resolved = typeof options === 'number' ? { gap: options } : options;
	const { gap = DEFAULT_GAP_PX, placement = 'below', align = 'start', flip = false } = resolved;
	// Non-null exactly for the beside-the-anchor placements, which keeps the side
	// narrowed for the flip helper below.
	const sidePlacement = placement === 'right' || placement === 'left' ? placement : null;
	const isSide = sidePlacement !== null;

	// Measure during the first render when the anchor is already mounted, which
	// is the normal case: these menus open in response to a click or hover on an
	// anchor that has been on screen for a while. Reading it here avoids
	// painting a frame at the wrong spot.
	const [anchor, setAnchor] = useState<AnchorRect | null>(() => measureAnchor(anchorRef));

	// Fallback for the case where the anchor mounts in the same commit as the
	// menu - refs aren't attached yet during render, so measure after layout.
	useLayoutEffect(() => {
		if (anchor) return;
		const measured = measureAnchor(anchorRef);
		if (measured) setAnchor(measured);
	}, [anchor, anchorRef]);

	// A menu that grows up or leftwards has to know its own size before it can be
	// placed, so it takes one extra pass at opacity 0. Growing down-right needs
	// nothing but the anchor, so that case still lands on the first paint. A
	// flipping flyout needs the width to decide which side it fits on.
	const needsMenuSize =
		placement === 'above' || placement === 'left' || align === 'end' || (isSide && flip);
	const [menuSize, setMenuSize] = useState<{ width: number; height: number } | null>(null);

	useLayoutEffect(() => {
		if (!needsMenuSize) return;
		const el = menuRef.current;
		if (!el) return;
		const { width, height } = el.getBoundingClientRect();
		// Guarded so a stable size can't drive a re-render loop.
		setMenuSize((prev) =>
			prev && prev.width === width && prev.height === height ? prev : { width, height }
		);
	}, [needsMenuSize, menuRef, anchor]);

	const size = menuSize ?? { width: 0, height: 0 };

	// Side placement resolves to a concrete side first, so x and y below read the
	// same whether or not the flyout flipped.
	const side =
		sidePlacement && flip && anchor
			? resolveSide(sidePlacement, anchor, size.width, gap)
			: sidePlacement;

	const x = anchor
		? isSide
			? side === 'left'
				? anchor.left - gap - size.width
				: anchor.right + gap
			: align === 'end'
				? anchor.right - size.width
				: anchor.left
		: 0;
	const y = anchor
		? isSide
			? align === 'end'
				? anchor.bottom - size.height
				: anchor.top
			: placement === 'above'
				? anchor.top - gap - size.height
				: anchor.bottom + gap
		: 0;

	// Clamps into the viewport - the same helper the right-click menus use.
	const position = useContextMenuPosition(menuRef, x, y);

	// Stay "not ready" until everything the placement depends on is known, so
	// callers keep the menu at opacity 0 rather than flashing it in a corner.
	const ready = position.ready && anchor !== null && (!needsMenuSize || menuSize !== null);
	return ready ? position : { ...position, ready: false };
}

function measureAnchor(anchorRef: RefObject<HTMLElement | null>): AnchorRect | null {
	const rect = anchorRef.current?.getBoundingClientRect();
	return rect ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom } : null;
}

/**
 * Keep the preferred side unless the menu overflows the viewport there and fits
 * on the other one. When neither side fits, the preferred one wins and the
 * viewport clamp takes over.
 */
function resolveSide(
	preferred: 'right' | 'left',
	anchor: AnchorRect,
	width: number,
	gap: number
): 'right' | 'left' {
	const fitsRight = anchor.right + gap + width <= window.innerWidth;
	const fitsLeft = anchor.left - gap - width >= 0;
	if (preferred === 'right') return fitsRight || !fitsLeft ? 'right' : 'left';
	return fitsLeft || !fitsRight ? 'left' : 'right';
}
