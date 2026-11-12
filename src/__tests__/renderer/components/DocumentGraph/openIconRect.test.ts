/**
 * Where the open-file icon sits inside a document node.
 *
 * The renderer and the click hit test both call `openIconRect`, and that is the
 * whole point of the helper: when the two computed the rectangle separately the
 * clickable box sat a pixel above the drawn glyph, and turning previews off
 * would have moved the drawn icon to the middle of the pill while leaving the
 * hit box pinned to where a header band used to be. These tests pin the
 * geometry both callers share.
 */

import { describe, it, expect } from 'vitest';
import { openIconRect } from '../../../../renderer/components/DocumentGraph/mindMapCanvas';
import { NODE_HEADER_HEIGHT } from '../../../../renderer/components/DocumentGraph/mindMapLayouts';

/** A node is positioned by its CENTER, so the box runs from x - w/2 to x + w/2. */
const card = { x: 200, y: 300, width: 240, height: 120 };
const pill = { x: 200, y: 300, width: 240, height: NODE_HEADER_HEIGHT };

describe('openIconRect', () => {
	it('sits inside the node, hard against its right edge', () => {
		const rect = openIconRect(card, 100);
		const right = card.x + card.width / 2;

		expect(rect.x).toBeGreaterThan(card.x);
		expect(rect.x + rect.size).toBeLessThan(right);
	});

	it('centres the icon in the header band on a full card', () => {
		const rect = openIconRect(card, 100);
		const top = card.y - card.height / 2;

		// Equal gap above and below within the header strip - not the whole node,
		// which would drop the icon into the preview text.
		const gapAbove = rect.y - top;
		const gapBelow = top + NODE_HEADER_HEIGHT - (rect.y + rect.size);
		expect(gapAbove).toBeCloseTo(gapBelow);
		expect(rect.y + rect.size).toBeLessThanOrEqual(top + NODE_HEADER_HEIGHT);
	});

	it('centres the icon in the whole node once previews are off', () => {
		// The pill has no header strip to sit in: the title band IS the node.
		const rect = openIconRect(pill, 0);
		const top = pill.y - pill.height / 2;

		const gapAbove = rect.y - top;
		const gapBelow = top + pill.height - (rect.y + rect.size);
		expect(gapAbove).toBeCloseTo(gapBelow);
	});

	it('never runs past the bottom of a node shorter than a header band', () => {
		// Defensive: a layout that produced a stubby node must not draw the icon
		// outside it, which would leave a hit box floating over the canvas.
		const stub = { x: 0, y: 0, width: 200, height: 20 };
		const rect = openIconRect(stub, 100);

		expect(rect.y).toBeGreaterThanOrEqual(stub.y - stub.height / 2);
		expect(rect.y + rect.size).toBeLessThanOrEqual(stub.y + stub.height / 2);
	});

	it('gives the same rectangle for every "off" spelling', () => {
		// `isPreviewOff` treats anything at or below 0 as off, so the hit test and
		// the renderer must agree on a stored value of -1 as much as on 0.
		expect(openIconRect(pill, 0)).toEqual(openIconRect(pill, -1));
	});
});
