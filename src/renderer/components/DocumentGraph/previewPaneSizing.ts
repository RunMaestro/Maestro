/**
 * Sizing rules for the Document Graph's in-graph markdown preview pane.
 *
 * The pane is dragged by its left edge and its width is remembered
 * (`usePersistedPanelWidth`), so two bounds exist and they are not the same
 * thing: the STORED bounds below decide what may be written to disk, while the
 * live clamp folds in the current graph container - a width that was legal on a
 * maximized window must not swallow the whole canvas after the modal is
 * resized down.
 */

/** localStorage key for the width the user dragged the preview pane to. */
export const PREVIEW_WIDTH_STORAGE_KEY = 'documentGraph.previewWidth';

/** Narrowest pane where the header (nav, title, Open, close) still fits. */
export const PREVIEW_MIN_WIDTH = 320;

/** Widest the pane may be stored at, before the live container clamp. */
export const PREVIEW_MAX_WIDTH = 1400;

/** Width used until the user drags the pane. */
export const PREVIEW_DEFAULT_WIDTH = 560;

/** Graph left of the pane that a drag may never eat into. */
export const PREVIEW_GRAPH_RESERVE = 200;

/**
 * The widest the preview may be right now, given the graph container it floats
 * over. A container of 0 means "not measured yet" (the ResizeObserver has not
 * reported), where falling back to the stored max is right - the first paint
 * should honor the remembered width rather than snap to the minimum and jump.
 */
export function previewMaxWidthForContainer(containerWidth: number): number {
	if (!(containerWidth > 0)) return PREVIEW_MAX_WIDTH;
	return Math.max(
		PREVIEW_MIN_WIDTH,
		Math.min(PREVIEW_MAX_WIDTH, containerWidth - PREVIEW_GRAPH_RESERVE)
	);
}
