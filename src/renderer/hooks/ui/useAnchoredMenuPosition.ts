/**
 * useAnchoredMenuPosition - place a portaled dropdown beneath an anchor element.
 *
 * Dropdowns anchored inside the Main Panel header can't be positioned with
 * `absolute top-full`: the header wraps its left cluster in `overflow-hidden`
 * boxes that are only as tall as the pill, so anything hanging below is clipped
 * to nothing. `position: fixed` alone doesn't save you either, because
 * `.header-container` sets `container-type: inline-size` (implying
 * `contain: layout`), which makes the header a containing block for fixed
 * descendants. The fix is to portal the menu to document.body and position it
 * from the anchor's measured rect - which is what this hook computes.
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

/** Default gap between the bottom of the anchor and the top of the menu. */
const DEFAULT_GAP_PX = 6;

export interface AnchoredMenuPosition {
	left: number;
	top: number;
	/** False until the menu has been measured; render at opacity 0 until true. */
	ready: boolean;
}

/**
 * @param menuRef  The portaled menu element, measured to keep it on screen.
 * @param anchorRef The element the menu hangs beneath (pill, button, widget).
 * @param gap      Pixels between anchor bottom and menu top.
 */
export function useAnchoredMenuPosition(
	menuRef: RefObject<HTMLElement | null>,
	anchorRef: RefObject<HTMLElement | null>,
	gap: number = DEFAULT_GAP_PX
): AnchoredMenuPosition {
	// Measure during the first render when the anchor is already mounted, which
	// is the normal case: these menus open in response to a click or hover on an
	// anchor that has been on screen for a while. Reading it here avoids
	// painting a frame at the wrong spot.
	const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(() =>
		measure(anchorRef, gap)
	);

	// Fallback for the case where the anchor mounts in the same commit as the
	// menu - refs aren't attached yet during render, so measure after layout.
	useLayoutEffect(() => {
		if (anchor) return;
		const measured = measure(anchorRef, gap);
		if (measured) setAnchor(measured);
	}, [anchor, anchorRef, gap]);

	// Clamps into the viewport - the same helper the right-click menus use.
	const position = useContextMenuPosition(menuRef, anchor?.x ?? 0, anchor?.y ?? 0);

	// Stay "not ready" until the anchor is known, so callers keep the menu at
	// opacity 0 rather than flashing it in the top-left corner.
	return anchor ? position : { ...position, ready: false };
}

function measure(
	anchorRef: RefObject<HTMLElement | null>,
	gap: number
): { x: number; y: number } | null {
	const rect = anchorRef.current?.getBoundingClientRect();
	return rect ? { x: rect.left, y: rect.bottom + gap } : null;
}
