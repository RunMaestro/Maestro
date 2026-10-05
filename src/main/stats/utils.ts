/**
 * Stats Database Utilities
 *
 * Shared helper functions and constants used across the stats module.
 */

import type Database from 'better-sqlite3';
import { logger } from '../utils/logger';
import { PerformanceMetrics } from '../../shared/performance-metrics';
import type { StatsTimeRange } from '../../shared/stats-types';

export const LOG_CONTEXT = '[StatsDB]';

/**
 * Performance metrics logger for StatsDB operations.
 *
 * Disabled by default - enable via setPerformanceLoggingEnabled(true).
 * Logs at debug level through the main process logger.
 */
export const perfMetrics = new PerformanceMetrics(
	'StatsDB',
	(message, context) => logger.debug(message, context ?? LOG_CONTEXT),
	false // Disabled by default - enable for debugging
);

// Defined in the library so the headless runtime writes ids and paths the same way.
export { generateId, normalizePath } from '../../shared/maestro-lib/stats/utils';

/**
 * Convert a Unix timestamp (ms) to a YYYY-MM-DD bucket using the local
 * timezone. Shared by every per-day rolled-up counter (shortcut usage,
 * multi-window usage) so the bucket boundary is identical across them.
 */
export function toLocalYmd(timestamp: number): string {
	const d = new Date(timestamp);
	const yyyy = d.getFullYear();
	const mm = String(d.getMonth() + 1).padStart(2, '0');
	const dd = String(d.getDate()).padStart(2, '0');
	return `${yyyy}-${mm}-${dd}`;
}

/**
 * Convert a StatsTimeRange to its YYYY-MM-DD lower bound for the daily-bucket
 * tables. The all-time range resolves to '0000-01-01' so the SELECT picks up
 * every row.
 */
export function rangeStartYmd(range: StatsTimeRange): string {
	if (range === 'all') {
		return '0000-01-01';
	}
	return toLocalYmd(getTimeRangeStart(range));
}

/** Minimal view of the settings store the stats gate needs. */
export interface StatsSettingsStore {
	get: (key: string) => unknown;
}

/**
 * Whether usage-statistics collection is enabled. This is the single
 * telemetry/analytics gate for every stats writer (IPC handlers and the
 * main-process multi-window telemetry): nothing is recorded when the user has
 * turned `statsCollectionEnabled` off. Defaults to enabled when the setting is
 * unset or no store is provided.
 */
export function isStatsCollectionEnabled(settingsStore?: StatsSettingsStore): boolean {
	if (!settingsStore) return true; // Default to enabled if no settings store
	// Default to true if not explicitly set to false
	return settingsStore.get('statsCollectionEnabled') !== false;
}

/**
 * Get timestamp for start of time range
 */
export function getTimeRangeStart(range: StatsTimeRange): number {
	const now = Date.now();
	const day = 24 * 60 * 60 * 1000;

	switch (range) {
		case 'day':
			return now - day;
		case 'week':
			return now - 7 * day;
		case 'month':
			return now - 30 * day;
		case 'quarter':
			return now - 90 * day;
		case 'year':
			return now - 365 * day;
		case 'all':
			return 0;
		default:
			// Exhaustive check - should never reach here
			return 0;
	}
}

/**
 * Cache for prepared SQL statements.
 *
 * Eliminates repeated `db.prepare()` overhead for frequently executed queries.
 * Each cache instance should be cleared when the database connection is closed.
 */
export class StatementCache {
	private cache = new Map<string, Database.Statement>();

	get(db: Database.Database, sql: string): Database.Statement {
		let stmt = this.cache.get(sql);
		if (!stmt) {
			stmt = db.prepare(sql);
			this.cache.set(sql, stmt);
		}
		return stmt;
	}

	clear(): void {
		this.cache.clear();
	}
}
