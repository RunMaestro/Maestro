/**
 * Tests for the shared window-bounds geometry helpers.
 *
 * `isPointInWindowBounds` is the single containment rule used on BOTH sides of
 * the Phase 3 tab drag bridge: the main-process window hit-test
 * (`WindowRegistry.findWindowAtPoint`) and the renderer's drag-exit detection
 * (`useTabDragOut`). The edge semantics asserted here (left/top inclusive,
 * right/bottom exclusive) are what keeps two adjacent windows from both
 * claiming a shared border pixel, so they are pinned down explicitly.
 */

import { describe, it, expect } from 'vitest';
import {
	isPointInWindowBounds,
	isPointOutsideWindowBounds,
	type WindowBounds,
} from '../../shared/window-types';

const BOUNDS: WindowBounds = { x: 100, y: 100, width: 800, height: 600 };

describe('isPointInWindowBounds', () => {
	it('returns true for a point well inside the rectangle', () => {
		expect(isPointInWindowBounds({ x: 500, y: 400 }, BOUNDS)).toBe(true);
	});

	it('treats the left and top edges as inclusive', () => {
		// Top-left corner is the first pixel inside.
		expect(isPointInWindowBounds({ x: 100, y: 100 }, BOUNDS)).toBe(true);
		expect(isPointInWindowBounds({ x: 100, y: 400 }, BOUNDS)).toBe(true);
		expect(isPointInWindowBounds({ x: 500, y: 100 }, BOUNDS)).toBe(true);
	});

	it('treats the right and bottom edges as exclusive', () => {
		// x === x + width and y === y + height land just OUTSIDE the rectangle.
		expect(isPointInWindowBounds({ x: 900, y: 400 }, BOUNDS)).toBe(false);
		expect(isPointInWindowBounds({ x: 500, y: 700 }, BOUNDS)).toBe(false);
		expect(isPointInWindowBounds({ x: 900, y: 700 }, BOUNDS)).toBe(false);
	});

	it('returns false when the point is outside on any single axis', () => {
		expect(isPointInWindowBounds({ x: 99, y: 400 }, BOUNDS)).toBe(false); // left
		expect(isPointInWindowBounds({ x: 500, y: 99 }, BOUNDS)).toBe(false); // above
		expect(isPointInWindowBounds({ x: 901, y: 400 }, BOUNDS)).toBe(false); // right
		expect(isPointInWindowBounds({ x: 500, y: 701 }, BOUNDS)).toBe(false); // below
	});

	it('handles a window anchored at the origin', () => {
		const atOrigin: WindowBounds = { x: 0, y: 0, width: 100, height: 100 };
		expect(isPointInWindowBounds({ x: 0, y: 0 }, atOrigin)).toBe(true);
		expect(isPointInWindowBounds({ x: 100, y: 100 }, atOrigin)).toBe(false);
	});
});

describe('isPointOutsideWindowBounds', () => {
	it('is the exact negation of isPointInWindowBounds', () => {
		const samples = [
			{ x: 500, y: 400 }, // inside
			{ x: 100, y: 100 }, // inclusive corner
			{ x: 900, y: 700 }, // exclusive corner
			{ x: -50, y: 400 }, // far left
			{ x: 5000, y: 5000 }, // far outside
		];
		for (const point of samples) {
			expect(isPointOutsideWindowBounds(point, BOUNDS)).toBe(!isPointInWindowBounds(point, BOUNDS));
		}
	});
});
