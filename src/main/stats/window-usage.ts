/**
 * Window Usage Snapshot CRUD operations
 *
 * Records multi-window telemetry snapshots to understand how many windows are
 * open concurrently and how often users rely on secondary windows.
 */

import type Database from 'better-sqlite3';
import type { StatsTimeRange, WindowUsageSnapshot } from '../../shared/stats-types';
import { generateId, getTimeRangeStart, LOG_CONTEXT, StatementCache } from './utils';
import { logger } from '../utils/logger';
import { mapWindowUsageRow, type WindowUsageRow } from './row-mappers';

const stmtCache = new StatementCache();

const INSERT_SQL = `
  INSERT INTO window_usage_events (id, recorded_at, window_count, session_count, is_multi_window)
  VALUES (?, ?, ?, ?, ?)
`;

const SELECT_SQL = `
  SELECT * FROM window_usage_events
  WHERE recorded_at >= ?
  ORDER BY recorded_at DESC
`;

/**
 * Record a new window usage snapshot.
 */
export function insertWindowUsageSnapshot(
	db: Database.Database,
	snapshot: Omit<WindowUsageSnapshot, 'id'>
): string {
	const id = generateId();
	const stmt = stmtCache.get(db, INSERT_SQL);
	stmt.run(
		id,
		snapshot.recordedAt,
		snapshot.windowCount,
		snapshot.sessionCount,
		snapshot.isMultiWindow ? 1 : 0
	);
	logger.debug('Inserted window usage snapshot', LOG_CONTEXT, {
		id,
		windowCount: snapshot.windowCount,
		sessionCount: snapshot.sessionCount,
	});
	return id;
}

/**
 * Retrieve window usage snapshots within a time range.
 */
export function getWindowUsageSnapshots(
	db: Database.Database,
	range: StatsTimeRange
): WindowUsageSnapshot[] {
	const startTime = getTimeRangeStart(range);
	const stmt = stmtCache.get(db, SELECT_SQL);
	const rows = stmt.all(startTime) as WindowUsageRow[];
	return rows.map(mapWindowUsageRow);
}

/**
 * Clear statement cache when the DB closes.
 */
export function clearWindowUsageCache(): void {
	stmtCache.clear();
}
