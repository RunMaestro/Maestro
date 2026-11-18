/**
 * Pure helpers behind the delegation trend chart.
 *
 * The main process returns only days that had activity, in either stats system.
 * Rendering that list directly would compress gaps and lie about momentum - a
 * two-week silence would look like two adjacent bars - so the series is
 * densified across the whole selected window (the aggregation's `window`, not
 * just first-to-last active day, so a quiet start or end of the range shows as
 * quiet), then grouped into wider buckets when a long range would otherwise
 * draw more bars than the chart has pixels for.
 */

import type { DelegationDay, DelegationSlice } from '../../../shared/delegation';
import { localDaysBetween } from '../../../shared/daySeries';
import { chunkIntoEqualGroups } from './chartUtils';

/** One drawn bar. `days` is how many calendar days it covers (1 unless grouped). */
export interface DelegationBucket {
	/** Local-time YYYY-MM-DD of the bucket's first day. */
	date: string;
	/** Inclusive last day covered, same as `date` for daily buckets. */
	endDate: string;
	days: number;
	interactive: DelegationSlice;
	autoRun: DelegationSlice;
	cue: DelegationSlice;
}

export interface BuildDelegationSeriesOptions {
	/** Most bars to draw. Wider buckets are used past this. Default 120. */
	maxBars?: number;
	/** Densify from this day (local YYYY-MM-DD). Defaults to the first day with data. */
	fromDate?: string;
	/** Densify through this day (local YYYY-MM-DD). Defaults to the last day with data. */
	throughDate?: string;
}

function emptyBucket(date: string): DelegationBucket {
	return {
		date,
		endDate: date,
		days: 1,
		interactive: { count: 0, durationMs: 0 },
		autoRun: { count: 0, durationMs: 0 },
		cue: { count: 0, durationMs: 0 },
	};
}

function addInto(target: DelegationSlice, source: DelegationSlice): void {
	target.count += source.count;
	target.durationMs += source.durationMs;
}

/**
 * Densify a sparse per-day series and group it down to at most `maxBars` bars
 * (see `chunkIntoEqualGroups` for why groups are equal runs of days).
 */
export function buildDelegationSeries(
	days: DelegationDay[],
	options: BuildDelegationSeriesOptions = {}
): DelegationBucket[] {
	const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
	const firstDate = [options.fromDate, sorted[0]?.date].filter(Boolean).sort()[0];
	const lastDate = [options.throughDate, sorted[sorted.length - 1]?.date]
		.filter(Boolean)
		.sort()
		.pop();
	if (!firstDate || !lastDate || lastDate < firstDate) return [];

	const byDate = new Map(sorted.map((day) => [day.date, day]));

	const dense: DelegationBucket[] = [];
	for (const ymd of localDaysBetween(firstDate, lastDate)) {
		const bucket = emptyBucket(ymd);
		const day = byDate.get(ymd);
		if (day) {
			addInto(bucket.interactive, day.interactive);
			addInto(bucket.autoRun, day.autoRun);
			addInto(bucket.cue, day.cue);
		}
		dense.push(bucket);
	}

	return chunkIntoEqualGroups(dense, options.maxBars ?? 120).map((slice) => {
		if (slice.length === 1) return slice[0];
		const bucket = emptyBucket(slice[0].date);
		bucket.endDate = slice[slice.length - 1].date;
		bucket.days = slice.length;
		for (const day of slice) {
			addInto(bucket.interactive, day.interactive);
			addInto(bucket.autoRun, day.autoRun);
			addInto(bucket.cue, day.cue);
		}
		return bucket;
	});
}

/** Interactive value for a bucket in the chart's current metric. */
export function bucketInteractiveValue(
	bucket: DelegationBucket,
	mode: 'count' | 'duration'
): number {
	return mode === 'count' ? bucket.interactive.count : bucket.interactive.durationMs;
}

/** Auto Run + Cue value for a bucket in the chart's current metric. */
export function bucketDelegatedValue(bucket: DelegationBucket, mode: 'count' | 'duration'): number {
	return mode === 'count'
		? bucket.autoRun.count + bucket.cue.count
		: bucket.autoRun.durationMs + bucket.cue.durationMs;
}

/** Delegated share of a bucket, 0-100. Zero when the bucket is empty. */
export function bucketDelegatedPercent(
	bucket: DelegationBucket,
	mode: 'count' | 'duration'
): number {
	const delegated = bucketDelegatedValue(bucket, mode);
	const total = delegated + bucketInteractiveValue(bucket, mode);
	return total > 0 ? (delegated / total) * 100 : 0;
}
