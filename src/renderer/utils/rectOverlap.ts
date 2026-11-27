/**
 * Rect overlap checks for overlays that share a strip with other controls.
 *
 * The transcript message footer centers read-only pills (model, effort, mode)
 * on the same row as hover-revealed action buttons. On a wide bubble they sit
 * apart; on a narrow one they paint over each other. Measuring on hover lets
 * the readout yield only when it actually collides, instead of on every hover.
 */

export interface RectLike {
	left: number;
	right: number;
	top: number;
	bottom: number;
}

/**
 * True when two rects share a region of positive area. Edges that only touch
 * do not count, and an empty rect (zero width or height, e.g. an unrendered
 * element) never overlaps anything.
 */
export function rectsOverlap(a: RectLike, b: RectLike): boolean {
	if (a.right <= a.left || a.bottom <= a.top) return false;
	if (b.right <= b.left || b.bottom <= b.top) return false;
	return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/** True when `element` overlaps any of `others` on screen. */
export function elementOverlapsAny(element: Element, others: Iterable<Element>): boolean {
	const rect = element.getBoundingClientRect();
	for (const other of others) {
		if (other !== element && rectsOverlap(rect, other.getBoundingClientRect())) return true;
	}
	return false;
}
