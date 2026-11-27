/**
 * Shortcut Usage Stats Operations
 *
 * Tracks keyboard shortcut firings per local-time day for the Usage Dashboard,
 * in two tables written together:
 * - `shortcut_usage_daily`: the day's total, every firing.
 * - `shortcut_usage_by_id` (v14): the day's count per shortcut id, for firings
 *   that name the shortcut. Older rows predate it, so its totals can be lower
 *   than the daily table's for the same range.
 */

import type Database from 'better-sqlite3';
import type {
	ShortcutUsageByShortcut,
	ShortcutUsageDay,
	StatsTimeRange,
} from '../../shared/stats-types';
import { LOG_CONTEXT, StatementCache, rangeStartYmd, toLocalYmd } from './utils';
import { logger } from '../utils/logger';

const stmtCache = new StatementCache();

const UPSERT_SQL = `
  INSERT INTO shortcut_usage_daily (date, count)
  VALUES (?, 1)
  ON CONFLICT(date) DO UPDATE SET count = count + 1
`;

const UPSERT_BY_ID_SQL = `
  INSERT INTO shortcut_usage_by_id (date, shortcut_id, count)
  VALUES (?, ?, 1)
  ON CONFLICT(date, shortcut_id) DO UPDATE SET count = count + 1
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

const SELECT_BY_SHORTCUT_SQL = `
  SELECT shortcut_id, SUM(count) as count
  FROM shortcut_usage_by_id
  WHERE date >= ?
  GROUP BY shortcut_id
  ORDER BY count DESC, shortcut_id ASC
`;

/**
 * Increment the daily counter for the date containing `firedAt`, and the
 * per-shortcut counter when `shortcutId` is given.
 *
 * Returns the YYYY-MM-DD bucket that was incremented. Bucketing happens in
 * JS rather than SQL so the date string is unambiguous to callers and tests.
 */
export function incrementShortcutUsage(
	db: Database.Database,
	firedAt: number,
	shortcutId?: string
): string {
	const date = toLocalYmd(firedAt);
	const id = typeof shortcutId === 'string' ? shortcutId.trim() : '';
	db.transaction(() => {
		stmtCache.get(db, UPSERT_SQL).run(date);
		if (id) stmtCache.get(db, UPSERT_BY_ID_SQL).run(date, id);
	})();
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
 * Firings per shortcut id within a time range, most used first. Only firings
 * recorded since v14 carry an id.
 */
export function getShortcutUsageByShortcut(
	db: Database.Database,
	range: StatsTimeRange
): ShortcutUsageByShortcut[] {
	const startDate = rangeStartYmd(range);
	const rows = stmtCache.get(db, SELECT_BY_SHORTCUT_SQL).all(startDate) as Array<{
		shortcut_id: string;
		count: number;
	}>;
	return rows.map((row) => ({ shortcutId: row.shortcut_id, count: row.count }));
}

/**
 * Clear the statement cache (call when database is closed).
 */
export function clearShortcutUsageCache(): void {
	stmtCache.clear();
	logger.debug('Cleared shortcut usage statement cache', LOG_CONTEXT);
}
