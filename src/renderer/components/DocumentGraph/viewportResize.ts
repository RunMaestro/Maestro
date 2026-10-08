/**
 * What the Document Graph canvas does to its view when the canvas changes size.
 *
 * The canvas resizes for reasons that have nothing to do with the graph: the
 * selected-node info bar appears above it on every click, the window resizes,
 * the real container size replaces the placeholder on open. Re-framing the
 * whole graph on each of those discarded the user's zoom every time they
 * clicked a node.
 *
 * The rule: a view the user has not touched since the last fit stays fitted
 * (re-fit to the new size). A view the user zoomed or panned keeps its zoom,
 * and the pan shifts by half the size change so the point at the viewport
 * center stays at the center.
 */

/** Zoom and pan of the graph canvas. */
export interface ViewTransform {
	zoom: number;
	panX: number;
	panY: number;
}

export interface ViewportSize {
	width: number;
	height: number;
}

/**
 * The transform to use after a resize, or `'refit'` when the view is still the
 * one the last fit produced. `lastFit` is compared by identity: any zoom or pan
 * replaces the transform object, so identity means "untouched since the fit".
 * Returns `current` itself when the size did not change.
 */
export function transformAfterResize(
	current: ViewTransform,
	lastFit: ViewTransform | null,
	prevSize: ViewportSize,
	nextSize: ViewportSize
): ViewTransform | 'refit' {
	if (prevSize.width === nextSize.width && prevSize.height === nextSize.height) return current;
	if (current === lastFit) return 'refit';
	return {
		zoom: current.zoom,
		panX: current.panX + (nextSize.width - prevSize.width) / 2,
		panY: current.panY + (nextSize.height - prevSize.height) / 2,
	};
}
