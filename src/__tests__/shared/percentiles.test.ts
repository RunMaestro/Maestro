import { describe, it, expect } from 'vitest';
import {
	computePercentiles,
	percentilesFromSorted,
	percentileOfSorted,
	emptyPercentiles,
} from '../../shared/percentiles';

describe('percentiles', () => {
	describe('emptyPercentiles', () => {
		it('is all zeros with count 0', () => {
			expect(emptyPercentiles()).toEqual({
				count: 0,
				min: 0,
				p50: 0,
				p75: 0,
				p90: 0,
				p95: 0,
				p99: 0,
				max: 0,
			});
		});
	});

	describe('computePercentiles', () => {
		it('returns the empty distribution for an empty array', () => {
			expect(computePercentiles([])).toEqual(emptyPercentiles());
		});

		it('handles a single value (all percentiles equal it)', () => {
			const d = computePercentiles([42]);
			expect(d).toEqual({
				count: 1,
				min: 42,
				p50: 42,
				p75: 42,
				p90: 42,
				p95: 42,
				p99: 42,
				max: 42,
			});
		});

		it('computes nearest-rank percentiles over 1..100', () => {
			const values = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
			const d = computePercentiles(values);
			expect(d.count).toBe(100);
			expect(d.min).toBe(1);
			expect(d.max).toBe(100);
			// floor((p/100) * 100) index into the sorted 0-based array → value index+1
			expect(d.p50).toBe(51);
			expect(d.p75).toBe(76);
			expect(d.p90).toBe(91);
			expect(d.p95).toBe(96);
			expect(d.p99).toBe(100);
		});

		it('does not mutate the input array', () => {
			const values = [3, 1, 2];
			computePercentiles(values);
			expect(values).toEqual([3, 1, 2]);
		});

		it('sorts unsorted input before computing', () => {
			const unsorted = computePercentiles([100, 1, 50, 25, 75]);
			const sorted = percentilesFromSorted([1, 25, 50, 75, 100]);
			expect(unsorted).toEqual(sorted);
		});
	});

	describe('percentileOfSorted', () => {
		it('returns 0 for an empty array', () => {
			expect(percentileOfSorted([], 95)).toBe(0);
		});

		it('clamps to the last element at p100', () => {
			expect(percentileOfSorted([10, 20, 30], 100)).toBe(30);
		});

		it('returns the first element at p0', () => {
			expect(percentileOfSorted([10, 20, 30], 0)).toBe(10);
		});
	});
});
