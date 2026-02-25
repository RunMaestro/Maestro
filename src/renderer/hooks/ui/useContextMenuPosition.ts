import { type RefObject, useLayoutEffect, useState } from 'react';

interface ContextMenuPosition {
	left: number;
	top: number;
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
 *   const { left, top, ready } = useContextMenuPosition(menuRef, clickX, clickY);
 *   <div ref={menuRef} style={{ left, top, opacity: ready ? 1 : 0 }} />
 */
export function useContextMenuPosition(
	menuRef: RefObject<HTMLElement | null>,
	x: number,
	y: number,
	padding = 8,
): ContextMenuPosition {
	const [position, setPosition] = useState<ContextMenuPosition>({
		left: x,
		top: y,
		ready: false,
	});

	useLayoutEffect(() => {
		const el = menuRef.current;
		if (!el) return;

		const { width, height } = el.getBoundingClientRect();
		const maxLeft = window.innerWidth - width - padding;
		const maxTop = window.innerHeight - height - padding;

		setPosition({
			left: Math.max(padding, Math.min(x, maxLeft)),
			top: Math.max(padding, Math.min(y, maxTop)),
			ready: true,
		});
	}, [menuRef, x, y, padding]);

	return position;
}
