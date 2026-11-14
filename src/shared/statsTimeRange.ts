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

/** Timestamp (ms) where `range` starts; `0` for all time. */
export function getTimeRangeStart(range: StatsTimeRange, now: number = Date.now()): number {
	switch (range) {
		case 'day':
			// "Today" is the local calendar day, not a rolling 24 hours.
			return startOfLocalDay(now);
		case 'week':
			return now - 7 * DAY_MS;
		case 'month':
			return now - 30 * DAY_MS;
		case 'quarter':
			return now - 90 * DAY_MS;
		case 'year':
			return now - 365 * DAY_MS;
		case 'all':
			return 0;
		default:
			// Exhaustive check - should never reach here
			return 0;
	}
}
