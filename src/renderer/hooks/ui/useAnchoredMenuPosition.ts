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
 * Usage:
 *   const menuRef = useRef<HTMLDivElement>(null);
 *   const { left, top, ready } = useAnchoredMenuPosition(menuRef, anchorRef);
 *   return createPortal(
 *     <div ref={menuRef} className="fixed" style={{ left, top, opacity: ready ? 1 : 0 }} />,
 *     document.body
 *   );
 */

import { useLayoutEffect, useState, type RefObject } from 'react';
import { useContextMenuPosition } from './useContextMenuPosition';

/** Default gap between the anchor and the menu. */
const DEFAULT_GAP_PX = 6;

/** Which side of the anchor the menu grows from. */
export type AnchoredMenuPlacement = 'below' | 'above';
/** Which edges line up: `start` matches left edges, `end` matches right edges. */
export type AnchoredMenuAlign = 'start' | 'end';

export interface AnchoredMenuOptions {
	/** Pixels between the anchor edge and the menu. */
	gap?: number;
	placement?: AnchoredMenuPlacement;
	align?: AnchoredMenuAlign;
}

export interface AnchoredMenuPosition {
	left: number;
	top: number;
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
	const { gap = DEFAULT_GAP_PX, placement = 'below', align = 'start' } = resolved;

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
	// nothing but the anchor, so that case still lands on the first paint.
	const needsMenuSize = placement === 'above' || align === 'end';
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
	const x = anchor ? (align === 'end' ? anchor.right - size.width : anchor.left) : 0;
	const y = anchor
		? placement === 'above'
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
