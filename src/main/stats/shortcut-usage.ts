/**
 * Shortcut Usage Stats Operations
 *
 * Tracks the count of keyboard shortcut firings per local-time day for the
 * Usage Dashboard. The renderer increments via UPSERT every time a shortcut
 * fires, and the dashboard queries an ascending date series for charting.
 */

import type Database from 'better-sqlite3';
import type { ShortcutUsageDay, StatsTimeRange } from '../../shared/stats-types';
import { LOG_CONTEXT, StatementCache, rangeStartYmd, toLocalYmd } from './utils';
import { logger } from '../utils/logger';

const stmtCache = new StatementCache();

const UPSERT_SQL = `
  INSERT INTO shortcut_usage_daily (date, count)
  VALUES (?, 1)
  ON CONFLICT(date) DO UPDATE SET count = count + 1
`;

const SELECT_RANGE_SQL = `
  SELECT date, count
  FROM shortcut_usage_daily
  WHERE date >= ?
  ORDER BY date ASC
`;

const SELECT_TOTAL_SQL = `
  SELECT COALESCE(SUM(count), 0) as total
  FROM shortcut_usage_daily
  WHERE date >= ?
`;

/**
 * Increment the daily counter for the date containing `firedAt`.
 *
 * Returns the YYYY-MM-DD bucket that was incremented. Bucketing happens in
 * JS rather than SQL so the date string is unambiguous to callers and tests.
 */
export function incrementShortcutUsage(db: Database.Database, firedAt: number): string {
	const date = toLocalYmd(firedAt);
	const stmt = stmtCache.get(db, UPSERT_SQL);
	stmt.run(date);
	return date;
}

/**
 * Fetch per-day shortcut usage counts within a time range, ascending.
 * Days with no activity are NOT included - the renderer zero-fills.
 */
export function getShortcutUsageByDay(
	db: Database.Database,
	range: StatsTimeRange
): ShortcutUsageDay[] {
	const startDate = rangeStartYmd(range);
	const stmt = stmtCache.get(db, SELECT_RANGE_SQL);
	const rows = stmt.all(startDate) as Array<{ date: string; count: number }>;
	return rows.map((row) => ({ date: row.date, count: row.count }));
}

/**
 * Total shortcut firings within a time range. Used for the summary card.
 */
export function getShortcutUsageTotal(db: Database.Database, range: StatsTimeRange): number {
	const startDate = rangeStartYmd(range);
	const stmt = stmtCache.get(db, SELECT_TOTAL_SQL);
	const row = stmt.get(startDate) as { total: number } | undefined;
	return row?.total ?? 0;
}

/**
 * Clear the statement cache (call when database is closed).
 */
export function clearShortcutUsageCache(): void {
	stmtCache.clear();
	logger.debug('Cleared shortcut usage statement cache', LOG_CONTEXT);
}
