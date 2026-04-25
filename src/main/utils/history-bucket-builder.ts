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

export interface BucketAggregateResult {
	buckets: CachedGraphBucket[];
	earliestTimestamp: number;
	latestTimestamp: number;
	totalCount: number;
	autoCount: number;
	userCount: number;
	cueCount: number;
}

/**
 * Aggregate entries into a fixed-count bucket array.
 *
 * If `entries` is empty, returns a zero-filled bucket array with timestamps
 * defaulted to "now" so the renderer can still render an empty graph.
 */
export function buildBucketAggregate(
	entries: HistoryEntry[],
	bucketCount: number
): BucketAggregateResult {
	const safeBucketCount = Math.max(1, bucketCount | 0);

	if (entries.length === 0) {
		const now = Date.now();
		return {
			buckets: Array.from({ length: safeBucketCount }, () => ({ auto: 0, user: 0, cue: 0 })),
			earliestTimestamp: now,
			latestTimestamp: now,
			totalCount: 0,
			autoCount: 0,
			userCount: 0,
			cueCount: 0,
		};
	}

	let earliest = Infinity;
	let latest = -Infinity;
	let autoCount = 0;
	let userCount = 0;
	let cueCount = 0;

	for (const entry of entries) {
		if (entry.timestamp < earliest) earliest = entry.timestamp;
		if (entry.timestamp > latest) latest = entry.timestamp;
		if (entry.type === 'AUTO') autoCount++;
		else if (entry.type === 'USER') userCount++;
		else if (entry.type === 'CUE') cueCount++;
	}

	// Pad zero-width ranges (single entry, or multiple entries at the same
	// instant) so msPerBucket stays positive.
	const span = Math.max(latest - earliest, 1);
	const msPerBucket = span / safeBucketCount;

	const buckets: CachedGraphBucket[] = Array.from({ length: safeBucketCount }, () => ({
		auto: 0,
		user: 0,
		cue: 0,
	}));

	for (const entry of entries) {
		const offset = entry.timestamp - earliest;
		const idx = Math.min(safeBucketCount - 1, Math.max(0, Math.floor(offset / msPerBucket)));
		const bucket = buckets[idx];
		if (entry.type === 'AUTO') bucket.auto++;
		else if (entry.type === 'USER') bucket.user++;
		else if (entry.type === 'CUE') bucket.cue++;
	}

	return {
		buckets,
		earliestTimestamp: earliest,
		latestTimestamp: latest,
		totalCount: entries.length,
		autoCount,
		userCount,
		cueCount,
	};
}
