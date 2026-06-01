/**
 * Percentile / distribution helpers for duration stats.
 *
 * Canonical home for the "p50 / p75 / p90 / p95 / p99 / max" breakdown surfaced
 * across the Usage Dashboard (agent query times, Auto Run task times, Cue run
 * times). Before this existed the logic was inlined per-component; import from
 * here instead of re-rolling `sorted[floor(p * len)]`.
 *
 * Shared between main process (stats aggregation) and renderer (dashboard).
 */

/**
 * Duration distribution across a set of runs. All duration fields are in the
 * same unit as the input values (milliseconds throughout the stats system).
 */
export interface DurationPercentiles {
	/** Number of samples the distribution was computed from. */
	count: number;
	min: number;
	/** Median. */
	p50: number;
	p75: number;
	p90: number;
	p95: number;
	p99: number;
	max: number;
}

/**
 * Nearest-rank percentile of a pre-sorted (ascending) numeric array. Returns 0
 * for an empty array. `p` is in `[0, 100]`.
 */
export function percentileOfSorted(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
	return sorted[idx];
}

/** Empty distribution sentinel (all zeros, count 0). */
export function emptyPercentiles(): DurationPercentiles {
	return { count: 0, min: 0, p50: 0, p75: 0, p90: 0, p95: 0, p99: 0, max: 0 };
}

/**
 * Compute the duration distribution from an unsorted array of values. Copies
 * before sorting so the caller's array is left untouched.
 */
export function computePercentiles(values: number[]): DurationPercentiles {
	if (values.length === 0) return emptyPercentiles();
	const sorted = [...values].sort((a, b) => a - b);
	return percentilesFromSorted(sorted);
}

/**
 * Same as {@link computePercentiles} but for an array already sorted ascending.
 * Lets callers that group large datasets sort once and slice, instead of
 * re-sorting per group.
 */
export function percentilesFromSorted(sorted: number[]): DurationPercentiles {
	if (sorted.length === 0) return emptyPercentiles();
	return {
		count: sorted.length,
		min: sorted[0],
		p50: percentileOfSorted(sorted, 50),
		p75: percentileOfSorted(sorted, 75),
		p90: percentileOfSorted(sorted, 90),
		p95: percentileOfSorted(sorted, 95),
		p99: percentileOfSorted(sorted, 99),
		max: sorted[sorted.length - 1],
	};
}
