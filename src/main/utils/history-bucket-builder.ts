/**
 * History Bucket Builder
 *
 * Computes activity-graph buckets over a flat set of history entries spanning
 * the entries' full time range (earliest → latest). Output feeds the
 * activity-graph cache and ultimately the renderer's `<ActivityGraph>`.
 *
 * Two sources, not one: USER and AUTO entries come from the agent's JSONL
 * history file, while Cue runs are counted in `cue_events` and handed in
 * pre-bucketed via `options.cueCounts`.
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
	agentCount: number;
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
	 * actual `[earliest, latest]` - i.e. "all time".
	 */
	lookbackMs?: number | null;
	/**
	 * The "right edge" of the window. Defaults to `Date.now()`. Tests pass
	 * a fixed value to keep results deterministic.
	 */
	endTime?: number;
	/**
	 * Cue runs counted straight out of `cue_events`, since they are no longer
	 * written to the JSONL file the `entries` come from. See
	 * {@link CueBucketSource} for how they fold into the CUE series.
	 */
	cueCounts?: CueBucketSource[];
}

/**
 * A pre-counted slice of Cue activity - one minute of runs, from
 * `getCueHistoryBuckets()` in `src/main/cue/stats/cue-stats-query.ts`.
 *
 * Counts rather than rows because the graph only ever needs a bar height, and
 * an all-time graph would otherwise pull every run's stored output through
 * memory to increment a counter.
 */
export interface CueBucketSource {
	/** Start of the slice, unix ms. Bucketed like any entry timestamp. */
	timestamp: number;
	count: number;
}

/**
 * Aggregate entries into a fixed-count bucket array.
 *
 * - With no `lookbackMs`: buckets span the entries' full time range (the
 *   "all-encompassing" / "All time" view).
 * - With `lookbackMs`: buckets span `[endTime - lookbackMs, endTime]` and
 *   entries outside that window are excluded - the renderer's lookback
 *   selector hits this path.
 *
 * If nothing falls in range, returns a zero-filled bucket array with the
 * window's endpoints as timestamps so the renderer can render an empty graph.
 *
 * ## How the CUE series is counted
 *
 * Cue runs arrive from two places: `options.cueCounts`, read from `cue_events`,
 * and any CUE entries still sitting in the JSONL file from before those writes
 * were removed. Per bucket the series takes the LARGER of the two rather than
 * their sum, because in every bucket the two stores describe the same runs, not
 * different ones:
 *
 * - Before the cutover both writers saw each run, and the database set is a
 *   subset of the JSONL set (older rows predate the `output_excerpt` column, so
 *   only the failures among them pass the filter). Summing would double-count.
 * - After the cutover only the database has rows, so the max IS the database's
 *   count.
 * - Once Cue retention prunes a run, only the JSONL entry is left, so the max
 *   is the JSONL count.
 *
 * Two known imprecisions, both bounded to a single bar and accepted rather than
 * paying for row-level dedupe (which would mean loading every run's text):
 * the one bucket containing the cutover instant undercounts by whatever it held
 * before the cutover, and a run that starts in one bucket and finishes in the
 * next can be counted in both, since the database stamps dispatch time and the
 * JSONL entry stamped completion.
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
	const cueSource = (options.cueCounts ?? []).filter((c) => c.count > 0 && inRange(c.timestamp));

	if (filtered.length === 0 && cueSource.length === 0) {
		const fallbackEnd = endTime;
		const fallbackStart = windowStart ?? endTime;
		return {
			buckets: Array.from({ length: safeBucketCount }, () => ({
				auto: 0,
				user: 0,
				cue: 0,
				agent: 0,
			})),
			earliestTimestamp: fallbackStart,
			latestTimestamp: fallbackEnd,
			totalCount: 0,
			autoCount: 0,
			userCount: 0,
			cueCount: 0,
			agentCount: 0,
			hostCounts: {},
		};
	}

	let earliest = Infinity;
	let latest = -Infinity;
	let autoCount = 0;
	let userCount = 0;
	let cueCount = 0;
	let agentCount = 0;
	const hostCounts: Record<string, number> = {};

	for (const entry of filtered) {
		if (entry.timestamp < earliest) earliest = entry.timestamp;
		if (entry.timestamp > latest) latest = entry.timestamp;
		if (entry.type === 'AUTO') autoCount++;
		else if (entry.type === 'USER') userCount++;
		else if (entry.type === 'CUE') cueCount++;
		else if (entry.type === 'AGENT') agentCount++;
		const hostKey = entry.hostname || LOCAL_HOST_AGG_KEY;
		hostCounts[hostKey] = (hostCounts[hostKey] ?? 0) + 1;
	}

	// Database-sourced Cue runs widen the range like any other activity -
	// otherwise an agent whose only recent work was Cue would graph an
	// all-time window that ends before its newest bar.
	for (const slice of cueSource) {
		if (slice.timestamp < earliest) earliest = slice.timestamp;
		if (slice.timestamp > latest) latest = slice.timestamp;
	}

	// For windowed mode the range is fixed by the lookback, not the
	// observed entries - keeps the axis labels stable as entries arrive
	// or get filtered out.
	const rangeStart = windowStart ?? earliest;
	const rangeEnd = windowStart !== null ? endTime : latest;
	const span = Math.max(rangeEnd - rangeStart, 1);
	const msPerBucket = span / safeBucketCount;

	const buckets: CachedGraphBucket[] = Array.from({ length: safeBucketCount }, () => ({
		auto: 0,
		user: 0,
		cue: 0,
		agent: 0,
	}));

	const bucketIndexFor = (timestamp: number): number =>
		Math.min(safeBucketCount - 1, Math.max(0, Math.floor((timestamp - rangeStart) / msPerBucket)));

	for (const entry of filtered) {
		const bucket = buckets[bucketIndexFor(entry.timestamp)];
		if (entry.type === 'AUTO') bucket.auto++;
		else if (entry.type === 'USER') bucket.user++;
		else if (entry.type === 'CUE') bucket.cue++;
		else if (entry.type === 'AGENT') bucket.agent++;
	}

	// Fold in the database's Cue counts, taking the larger of the two stores
	// per bucket rather than their sum - see the note on this function.
	let cueDelta = 0;
	if (cueSource.length > 0) {
		const fromDb = new Array<number>(safeBucketCount).fill(0);
		for (const slice of cueSource) {
			fromDb[bucketIndexFor(slice.timestamp)] += slice.count;
		}
		for (let i = 0; i < safeBucketCount; i++) {
			const merged = Math.max(buckets[i].cue, fromDb[i]);
			cueDelta += merged - buckets[i].cue;
			buckets[i].cue = merged;
		}
	}
	if (cueDelta > 0) {
		cueCount += cueDelta;
		// Cue rows carry no hostname, so they belong to the local bucket - the
		// host picker's counts come from here.
		hostCounts[LOCAL_HOST_AGG_KEY] = (hostCounts[LOCAL_HOST_AGG_KEY] ?? 0) + cueDelta;
	}

	return {
		buckets,
		earliestTimestamp: rangeStart,
		latestTimestamp: rangeEnd,
		totalCount: filtered.length + cueDelta,
		autoCount,
		userCount,
		cueCount,
		agentCount,
		hostCounts,
	};
}
