import { logger } from './logger';

/**
 * Calculate element position for spotlight
 * Supports multiple selectors separated by commas - combines their bounding boxes
 */
export function getElementRect(selector: string | null): DOMRect | null {
	if (!selector) return null;

	// Support multiple selectors separated by commas
	const selectors = selector.split(',').map((s) => s.trim());
	const rects: DOMRect[] = [];

	for (const sel of selectors) {
		const element = document.querySelector(sel);
		if (element) {
			rects.push(element.getBoundingClientRect());
		}
	}

	if (rects.length === 0) {
		logger.warn(`[Tour] No elements found for selector(s): ${selector}`);
		return null;
	}

	// If single element, return its rect directly
	if (rects.length === 1) {
		return rects[0];
	}

	// Combine multiple rects into one bounding box
	const minX = Math.min(...rects.map((r) => r.x));
	const minY = Math.min(...rects.map((r) => r.y));
	const maxX = Math.max(...rects.map((r) => r.x + r.width));
	const maxY = Math.max(...rects.map((r) => r.y + r.height));

	// Create a synthetic DOMRect-like object
	return {
		x: minX,
		y: minY,
		width: maxX - minX,
		height: maxY - minY,
		top: minY,
		left: minX,
		bottom: maxY,
		right: maxX,
		toJSON: () => ({ x: minX, y: minY, width: maxX - minX, height: maxY - minY }),
	} as DOMRect;
}

/**
 * Calculate the clip-path for the spotlight effect
 * Creates a "cutout" in the dark overlay where the spotlight element is
 */
export function getSpotlightClipPath(
	rect: Pick<DOMRect, 'x' | 'y' | 'width' | 'height'> | null | undefined,
	options: { padding?: number; borderRadius?: number } = {}
): string {
	if (!rect) {
		// No spotlight - full dark overlay
		return 'none';
	}

	const { x, y, width, height } = rect;
	const padding = options.padding || 8;

	// Calculate spotlight bounds with padding
	const spotX = x - padding;
	const spotY = y - padding;
	const spotW = width + padding * 2;
	const spotH = height + padding * 2;
	const borderRadius = options.borderRadius || 8;

	// Use an inset path that covers everything except the spotlight area
	// We use a polygon with a "hole" created by going around the viewport,
	// then around the spotlight area in reverse
	return `polygon(
    0% 0%,
    0% 100%,
    ${spotX}px 100%,
    ${spotX}px ${spotY + borderRadius}px,
    ${spotX + borderRadius}px ${spotY}px,
    ${spotX + spotW - borderRadius}px ${spotY}px,
    ${spotX + spotW}px ${spotY + borderRadius}px,
    ${spotX + spotW}px ${spotY + spotH - borderRadius}px,
    ${spotX + spotW - borderRadius}px ${spotY + spotH}px,
    ${spotX + borderRadius}px ${spotY + spotH}px,
    ${spotX}px ${spotY + spotH - borderRadius}px,
    ${spotX}px 100%,
    100% 100%,
    100% 0%
  )`;
}
