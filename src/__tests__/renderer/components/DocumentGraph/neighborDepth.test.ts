/**
 * The Document Graph's neighbor-depth ladder, behind the `D` shortcut.
 *
 * The rule worth pinning is that `0` means "All" and is therefore the WIDEST
 * view, so it sits at the TOP of the cycle rather than where its numeric value
 * would put it. Sorting these numerically instead would make D read as
 * narrowing the graph on the wrap.
 */

import { describe, expect, it } from 'vitest';
import {
	formatNeighborDepth,
	NEIGHBOR_DEPTH_ALL,
	NEIGHBOR_DEPTH_MAX,
	nextNeighborDepth,
} from '../../../../renderer/components/DocumentGraph/neighborDepth';

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
