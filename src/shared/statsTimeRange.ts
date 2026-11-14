/**
 * Where a Usage Dashboard time range starts.
 *
 * One definition for the stats database (which filters rows with it) and the
 * renderer (which draws day axes from it), so a chart's first day is the same
 * boundary the query that fed it used.
 *
 * Pure and electron-free so the main process, the renderer, and the CLI share it.
 */

import type { StatsTimeRange } from './stats-types';
import { addLocalDays, parseLocalYmd, startOfLocalDay, toLocalYmd } from './localDay';

/**
 * How many calendar days each bounded range covers, today included. The one
 * table every range reads.
 */
export const STATS_RANGE_DAYS: Readonly<Record<Exclude<StatsTimeRange, 'all'>, number>> = {
	day: 1,
	week: 7,
	month: 30,
	quarter: 90,
	year: 365,
};

/**
 * Timestamp (ms) where `range` starts; `0` for all time.
 *
 * Calendar-aligned: local midnight N-1 days before today, so "Last 7 days" is
 * exactly seven whole local days (today included) and every per-day chart's
 * first bucket is a full day. A rolling `now - N*24h` start made the first
 * bucket a partial day and gave a week eight buckets.
 */
export function getTimeRangeStart(range: StatsTimeRange, now: number = Date.now()): number {
	if (range === 'all') return 0;
	const days = STATS_RANGE_DAYS[range];
	// Unknown range from an untyped caller (an old IPC payload): all time.
	if (days === undefined) return 0;
	const today = toLocalYmd(now);
	return parseLocalYmd(addLocalDays(today, -(days - 1)))?.getTime() ?? startOfLocalDay(now);
}

/** The local calendar days a payload covers: the range's first day through today. */
export interface UsageReadWindow {
	startYmd: string;
	endYmd: string;
}

/**
 * The window for `range` ending today. A bounded range starts on its own first
 * day; All Time starts on the earliest day the data knows about (`earliestYmd`),
 * or today when there is none.
 */
export function usageReadWindow(
	range: StatsTimeRange,
	earliestYmd: string | null,
	now: number = Date.now()
): UsageReadWindow {
	const endYmd = toLocalYmd(now);
	if (range !== 'all') return { startYmd: toLocalYmd(getTimeRangeStart(range, now)), endYmd };
	const startYmd = earliestYmd && earliestYmd < endYmd ? earliestYmd : endYmd;
	return { startYmd, endYmd };
}
