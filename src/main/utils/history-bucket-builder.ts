/**
 * History Bucket Builder
 *
 * Computes activity-graph buckets over a flat set of history entries spanning
 * the entries' full time range (earliest → latest). Output feeds the
 * activity-graph cache and ultimately the renderer's `<ActivityGraph>`.
 *
 * The output is "all-encompassing" by design: the time window covers every
 * entry in `entries`, not a configurable lookback. The renderer's lookback
 * selector only filters the entry list, never the graph.
 */

import type { HistoryEntry } from '../../shared/types';
import type { CachedGraphBucket } from './history-bucket-cache';

/** Synthetic key for entries that have no `hostname` field (i.e. local). */
export const LOCAL_HOST_AGG_KEY = '__local__';

export interface BucketAggregateResult {
	buckets: CachedGraphBucket[];
	earliestTimestamp: number;
	latestTimestamp: number;
	totalCount: number;
	autoCount: number;
	userCount: number;
	cueCount: number;
	/**
	 * Per-host entry counts within the same window the buckets cover. Key
	 * is the entry's `hostname`, or `LOCAL_HOST_AGG_KEY` for entries with no
	 * hostname. Always present; for sources with only local entries the map
	 * has a single `{ [LOCAL_HOST_AGG_KEY]: totalCount }` entry.
	 */
	hostCounts: Record<string, number>;
}

export interface BucketAggregateOptions {
	/**
	 * Lookback window in milliseconds. When provided, the bucket range
	 * spans `[end - lookbackMs, end]` and entries outside the window are
	 * dropped. When omitted (or `null`), the range spans the entries'
	 * actual `[earliest, latest]` — i.e. "all time".
	 */
	lookbackMs?: number | null;
	/**
	 * The "right edge" of the window. Defaults to `Date.now()`. Tests pass
	 * a fixed value to keep results deterministic.
	 */
	endTime?: number;
}

/**
 * Aggregate entries into a fixed-count bucket array.
 *
 * - With no `lookbackMs`: buckets span the entries' full time range (the
 *   "all-encompassing" / "All time" view).
 * - With `lookbackMs`: buckets span `[endTime - lookbackMs, endTime]` and
 *   entries outside that window are excluded — the renderer's lookback
 *   selector hits this path.
 *
 * If no entries fall in range, returns a zero-filled bucket array with the
 * window's endpoints as timestamps so the renderer can render an empty graph.
 */
export function buildBucketAggregate(
	entries: HistoryEntry[],
	bucketCount: number,
	options: BucketAggregateOptions = {}
): BucketAggregateResult {
	const safeBucketCount = Math.max(1, bucketCount | 0);
	const endTime = options.endTime ?? Date.now();
	const lookbackMs = options.lookbackMs ?? null;
	const windowStart = lookbackMs !== null ? endTime - lookbackMs : null;

	const inRange = (ts: number): boolean => {
		if (windowStart === null) return true;
		return ts >= windowStart && ts <= endTime;
	};

	const filtered = windowStart === null ? entries : entries.filter((e) => inRange(e.timestamp));

	if (filtered.length === 0) {
		const fallbackEnd = endTime;
		const fallbackStart = windowStart ?? endTime;
		return {
			buckets: Array.from({ length: safeBucketCount }, () => ({ auto: 0, user: 0, cue: 0 })),
			earliestTimestamp: fallbackStart,
			latestTimestamp: fallbackEnd,
			totalCount: 0,
			autoCount: 0,
			userCount: 0,
			cueCount: 0,
			hostCounts: {},
		};
	}

	let earliest = Infinity;
	let latest = -Infinity;
	let autoCount = 0;
	let userCount = 0;
	let cueCount = 0;
	const hostCounts: Record<string, number> = {};

	for (const entry of filtered) {
		if (entry.timestamp < earliest) earliest = entry.timestamp;
		if (entry.timestamp > latest) latest = entry.timestamp;
		if (entry.type === 'AUTO') autoCount++;
		else if (entry.type === 'USER') userCount++;
		else if (entry.type === 'CUE') cueCount++;
		const hostKey = entry.hostname || LOCAL_HOST_AGG_KEY;
		hostCounts[hostKey] = (hostCounts[hostKey] ?? 0) + 1;
	}

	// For windowed mode the range is fixed by the lookback, not the
	// observed entries — keeps the axis labels stable as entries arrive
	// or get filtered out.
	const rangeStart = windowStart ?? earliest;
	const rangeEnd = windowStart !== null ? endTime : latest;
	const span = Math.max(rangeEnd - rangeStart, 1);
	const msPerBucket = span / safeBucketCount;

	const buckets: CachedGraphBucket[] = Array.from({ length: safeBucketCount }, () => ({
		auto: 0,
		user: 0,
		cue: 0,
	}));

	for (const entry of filtered) {
		const offset = entry.timestamp - rangeStart;
		const idx = Math.min(safeBucketCount - 1, Math.max(0, Math.floor(offset / msPerBucket)));
		const bucket = buckets[idx];
		if (entry.type === 'AUTO') bucket.auto++;
		else if (entry.type === 'USER') bucket.user++;
		else if (entry.type === 'CUE') bucket.cue++;
	}

	return {
		buckets,
		earliestTimestamp: rangeStart,
		latestTimestamp: rangeEnd,
		totalCount: filtered.length,
		autoCount,
		userCount,
		cueCount,
		hostCounts,
	};
}
