/**
 * Multi-Window Usage Stats Operations
 *
 * Tracks aggregate multi-window usage per local-time day: how many secondary
 * windows were opened and the peak number of windows open at once. The main
 * process UPSERTs on each window open; the Usage Dashboard (or CSV export) can
 * SUM/MAX across a time range.
 *
 * Aggregate counters only - no agent ids, session contents, or window ids are
 * ever stored, just a date and two integers.
 */

import type Database from 'better-sqlite3';
import type { MultiWindowUsage, StatsTimeRange } from '../../shared/stats-types';
import { LOG_CONTEXT, StatementCache, rangeStartYmd, toLocalYmd } from './utils';
import { logger } from '../utils/logger';

const stmtCache = new StatementCache();

// On a fresh day the row is inserted with the open's concurrent count as the
// peak; on a repeat open the same day, `windows_opened` increments and
// `peak_concurrent` rises to the running max (it never decreases, since the
// concurrent count is only sampled when a window opens - i.e. when it rises).
const UPSERT_SQL = `
  INSERT INTO multi_window_usage_daily (date, windows_opened, peak_concurrent)
  VALUES (?, 1, ?)
  ON CONFLICT(date) DO UPDATE SET
    windows_opened = windows_opened + 1,
    peak_concurrent = MAX(peak_concurrent, excluded.peak_concurrent)
`;

const SELECT_AGGREGATE_SQL = `
  SELECT
    COALESCE(SUM(windows_opened), 0) AS windowsOpened,
    COALESCE(MAX(peak_concurrent), 0) AS peakConcurrent
  FROM multi_window_usage_daily
  WHERE date >= ?
`;

/**
 * Record that a (secondary) window was opened at `openedAt`, with
 * `concurrentWindowCount` windows now open in total. Increments the day's
 * windows-opened counter and raises its peak-concurrent high-water mark.
 *
 * Returns the YYYY-MM-DD bucket that was updated. Bucketing happens in JS rather
 * than SQL so the date string is unambiguous to callers and tests.
 */
export function recordWindowOpened(
	db: Database.Database,
	openedAt: number,
	concurrentWindowCount: number
): string {
	const date = toLocalYmd(openedAt);
	const stmt = stmtCache.get(db, UPSERT_SQL);
	stmt.run(date, concurrentWindowCount);
	return date;
}

/**
 * Aggregate multi-window usage within a time range: total secondary windows
 * opened and the peak concurrent window count. Returns zeros when there is no
 * activity in the range.
 */
export function getMultiWindowUsage(
	db: Database.Database,
	range: StatsTimeRange
): MultiWindowUsage {
	const startDate = rangeStartYmd(range);
	const stmt = stmtCache.get(db, SELECT_AGGREGATE_SQL);
	const row = stmt.get(startDate) as { windowsOpened: number; peakConcurrent: number } | undefined;
	return {
		windowsOpened: row?.windowsOpened ?? 0,
		peakConcurrent: row?.peakConcurrent ?? 0,
	};
}

/**
 * Clear the statement cache (call when database is closed).
 */
export function clearMultiWindowUsageCache(): void {
	stmtCache.clear();
	logger.debug('Cleared multi-window usage statement cache', LOG_CONTEXT);
}
