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
import { startOfLocalDay } from './localDay';

const DAY_MS = 24 * 60 * 60 * 1000;

/** How many days each bounded range covers. The one table every range reads. */
export const STATS_RANGE_DAYS: Readonly<Record<Exclude<StatsTimeRange, 'all'>, number>> = {
	day: 1,
	week: 7,
	month: 30,
	quarter: 90,
	year: 365,
};

/** Timestamp (ms) where `range` starts; `0` for all time. */
export function getTimeRangeStart(range: StatsTimeRange, now: number = Date.now()): number {
	if (range === 'all') return 0;
	// "Today" is the local calendar day, not a rolling 24 hours.
	if (range === 'day') return startOfLocalDay(now);
	const days = STATS_RANGE_DAYS[range];
	// Unknown range from an untyped caller (an old IPC payload): all time.
	return days === undefined ? 0 : now - days * DAY_MS;
}
