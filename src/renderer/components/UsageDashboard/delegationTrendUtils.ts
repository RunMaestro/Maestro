/**
 * Pure helpers behind the delegation trend chart.
 *
 * The main process returns only days that had activity, in either stats system.
 * Rendering that list directly would compress gaps and lie about momentum - a
 * two-week silence would look like two adjacent bars - so the series is
 * densified across the calendar first, then grouped into wider buckets when a
 * long range would otherwise draw more bars than the chart has pixels for.
 */

import type { DelegationDay, DelegationSlice } from '../../../shared/delegation';

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

/** Parse a local YYYY-MM-DD into a local-midnight Date. */
export function parseYmd(value: string): Date | null {
	const parts = value.split('-').map(Number);
	if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
	return new Date(parts[0], parts[1] - 1, parts[2]);
}

/** Format a local Date as YYYY-MM-DD. Never `toISOString`, which shifts to UTC. */
export function toYmd(date: Date): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
		date.getDate()
	).padStart(2, '0')}`;
}

/**
 * Densify a sparse per-day series and group it down to at most `maxBars` bars.
 *
 * Grouping is by a fixed number of consecutive days rather than by calendar
 * week: the buckets stay equal width, which is what makes neighbouring bars
 * comparable, and a partial week at either end can't render as a dip that never
 * happened.
 */
export function buildDelegationSeries(
	days: DelegationDay[],
	options: BuildDelegationSeriesOptions = {}
): DelegationBucket[] {
	const maxBars = Math.max(1, options.maxBars ?? 120);
	if (days.length === 0) return [];

	const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
	const first = parseYmd(sorted[0].date);
	const lastDate = options.throughDate ?? sorted[sorted.length - 1].date;
	const last = parseYmd(lastDate);
	if (!first || !last || last < first) return [];

	const byDate = new Map(sorted.map((day) => [day.date, day]));

	const dense: DelegationBucket[] = [];
	for (const cursor = new Date(first); cursor <= last; cursor.setDate(cursor.getDate() + 1)) {
		const ymd = toYmd(cursor);
		const bucket = emptyBucket(ymd);
		const day = byDate.get(ymd);
		if (day) {
			addInto(bucket.interactive, day.interactive);
			addInto(bucket.autoRun, day.autoRun);
			addInto(bucket.cue, day.cue);
		}
		dense.push(bucket);
	}

	if (dense.length <= maxBars) return dense;

	const groupSize = Math.ceil(dense.length / maxBars);
	const grouped: DelegationBucket[] = [];
	for (let i = 0; i < dense.length; i += groupSize) {
		const slice = dense.slice(i, i + groupSize);
		const bucket = emptyBucket(slice[0].date);
		bucket.endDate = slice[slice.length - 1].date;
		bucket.days = slice.length;
		for (const day of slice) {
			addInto(bucket.interactive, day.interactive);
			addInto(bucket.autoRun, day.autoRun);
			addInto(bucket.cue, day.cue);
		}
		grouped.push(bucket);
	}
	return grouped;
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
