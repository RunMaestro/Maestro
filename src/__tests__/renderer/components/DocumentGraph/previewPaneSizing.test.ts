/**
 * Sizing rules for the Document Graph's in-graph preview pane.
 *
 * The live clamp is separate from the stored bounds on purpose: a width that
 * was legal on a maximized window must not swallow the canvas after the modal
 * is resized down, and an unmeasured container must not snap the pane to its
 * minimum on the first paint.
 */

import { describe, expect, it } from 'vitest';
import {
	previewMaxWidthForContainer,
	PREVIEW_DEFAULT_WIDTH,
	PREVIEW_GRAPH_RESERVE,
	PREVIEW_MAX_WIDTH,
	PREVIEW_MIN_WIDTH,
} from '../../../../renderer/components/DocumentGraph/previewPaneSizing';

describe('previewPaneSizing', () => {
	it('keeps the default between the stored bounds', () => {
		expect(PREVIEW_DEFAULT_WIDTH).toBeGreaterThanOrEqual(PREVIEW_MIN_WIDTH);
		expect(PREVIEW_DEFAULT_WIDTH).toBeLessThanOrEqual(PREVIEW_MAX_WIDTH);
	});

	it('reserves a strip of graph beside the pane', () => {
		expect(previewMaxWidthForContainer(1000)).toBe(1000 - PREVIEW_GRAPH_RESERVE);
	});

	it('never returns less than the minimum, however narrow the container', () => {
		expect(previewMaxWidthForContainer(240)).toBe(PREVIEW_MIN_WIDTH);
		expect(previewMaxWidthForContainer(1)).toBe(PREVIEW_MIN_WIDTH);
	});

	it('caps at the stored maximum on a very wide container', () => {
		expect(previewMaxWidthForContainer(6000)).toBe(PREVIEW_MAX_WIDTH);
	});

	it('falls back to the stored maximum before the container is measured', () => {
		// A 0 width means the ResizeObserver has not reported yet. Clamping to the
		// minimum here would paint the remembered width narrow and then jump.
		expect(previewMaxWidthForContainer(0)).toBe(PREVIEW_MAX_WIDTH);
		expect(previewMaxWidthForContainer(Number.NaN)).toBe(PREVIEW_MAX_WIDTH);
	});
});
