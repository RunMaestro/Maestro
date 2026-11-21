// Source: src/__tests__/renderer/components/DocumentGraph/neighborDepth.test.ts
// Source: src/__tests__/renderer/components/DocumentGraph/viewportResize.test.ts
import { describe, expect, it } from 'vitest';
import {
	formatNeighborDepth,
	NEIGHBOR_DEPTH_ALL,
	NEIGHBOR_DEPTH_MAX,
	nextNeighborDepth,
} from '../../../../renderer/components/DocumentGraph/neighborDepth';
import { transformAfterResize } from '../../../../renderer/components/DocumentGraph/viewportResize';
describe('neighborDepth', () => {
	describe('nextNeighborDepth', () => {
		it('widens one level per step', () => {
			expect(nextNeighborDepth(1)).toBe(2);
			expect(nextNeighborDepth(2)).toBe(3);
			expect(nextNeighborDepth(NEIGHBOR_DEPTH_MAX - 1)).toBe(NEIGHBOR_DEPTH_MAX);
		});

		it('treats All as the widest rung, not the narrowest', () => {
			expect(nextNeighborDepth(NEIGHBOR_DEPTH_MAX)).toBe(NEIGHBOR_DEPTH_ALL);
			expect(nextNeighborDepth(NEIGHBOR_DEPTH_ALL)).toBe(1);
		});

		it('completes a full cycle back to where it started', () => {
			let depth = 1;
			const seen: number[] = [depth];
			for (let i = 0; i < NEIGHBOR_DEPTH_MAX; i++) {
				depth = nextNeighborDepth(depth);
				seen.push(depth);
			}
			expect(seen).toEqual([1, 2, 3, 4, 5, NEIGHBOR_DEPTH_ALL]);
			expect(nextNeighborDepth(depth)).toBe(1);
		});

		it('recovers from an out-of-range or non-numeric depth', () => {
			expect(nextNeighborDepth(-3)).toBe(1);
			expect(nextNeighborDepth(99)).toBe(NEIGHBOR_DEPTH_ALL);
			expect(nextNeighborDepth(Number.NaN)).toBe(1);
			expect(nextNeighborDepth(2.6)).toBe(3);
		});
	});

	describe('formatNeighborDepth', () => {
		it('names the sentinel rather than printing 0', () => {
			expect(formatNeighborDepth(NEIGHBOR_DEPTH_ALL)).toBe('All');
			expect(formatNeighborDepth(3)).toBe('3');
		});
	});
});
describe('viewportResize', () => {
	describe('transformAfterResize', () => {
		const size = { width: 1000, height: 800 };

		it('returns the current transform when the size did not change', () => {
			const current = { zoom: 2, panX: 10, panY: 20 };
			expect(transformAfterResize(current, null, size, { ...size })).toBe(current);
		});

		it('re-fits a view the user has not moved since the last fit', () => {
			const fit = { zoom: 0.5, panX: 100, panY: 50 };
			expect(transformAfterResize(fit, fit, size, { width: 1000, height: 764 })).toBe('refit');
		});

		it('keeps the zoom of a view the user moved, and holds the viewport center', () => {
			// Selecting a node shows the info bar, which shrinks the canvas height.
			const fit = { zoom: 0.5, panX: 100, panY: 50 };
			const zoomedIn = { zoom: 2.5, panX: -300, panY: -200 };
			const next = transformAfterResize(zoomedIn, fit, size, { width: 1000, height: 764 });
			expect(next).toEqual({ zoom: 2.5, panX: -300, panY: -218 });
		});

		it('treats an equal-valued but different transform object as moved', () => {
			const fit = { zoom: 1, panX: 0, panY: 0 };
			const next = transformAfterResize({ ...fit }, fit, size, { width: 1200, height: 800 });
			expect(next).toEqual({ zoom: 1, panX: 100, panY: 0 });
		});
	});
});
