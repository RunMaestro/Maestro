/**
 * tooltipGeometry
 *
 * Generic, presentational viewport-clamping math for cursor-anchored tooltips.
 * Extracted from the Usage Dashboard's `chartUtils` so the shared `ChartTooltip`
 * primitive can live in the widget library without reaching back into
 * `UsageDashboard/`. Pure: reads only `window.innerWidth/Height` and returns
 * top-left coordinates the caller can drop straight into `style.left`/`style.top`.
 */

/**
 * Clamp an absolute tooltip position so its bounding rect stays inside the
 * viewport. Pass `transform` to describe which corner of the tooltip the
 * anchor point represents - the function returns top-left coordinates the
 * caller can drop directly into `style.left` / `style.top` (and stop using
 * a CSS transform).
 *
 * **Why:** anchoring a tooltip at the right edge of a chart with
 * `transform: translate(-50%, -100%)` lets the tooltip extend off-screen.
 * `clampTooltipToViewport` keeps the rect inside the viewport.
 */
export function clampTooltipToViewport(args: {
	anchorX: number;
	anchorY: number;
	width: number;
	height: number;
	transform?: 'top-center' | 'bottom-center' | 'top-left' | 'left-center';
	margin?: number;
}): { left: number; top: number } {
	const { anchorX, anchorY, width, height, transform = 'top-left', margin = 8 } = args;

	let left: number;
	let top: number;
	switch (transform) {
		case 'top-center':
			left = anchorX - width / 2;
			top = anchorY - height;
			break;
		case 'bottom-center':
			left = anchorX - width / 2;
			top = anchorY;
			break;
		case 'left-center':
			left = anchorX;
			top = anchorY - height / 2;
			break;
		case 'top-left':
		default:
			left = anchorX;
			top = anchorY;
			break;
	}

	const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 0;
	const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 0;

	if (viewportWidth > 0) {
		left = Math.max(margin, Math.min(left, viewportWidth - width - margin));
	}
	if (viewportHeight > 0) {
		top = Math.max(margin, Math.min(top, viewportHeight - height - margin));
	}

	return { left, top };
}
