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

/**
 * Generate a unique ID for database entries.
 *
 * Uses timestamp-random format (e.g., `1712345-abc123`) rather than UUID
 * because the stats DB treats this format as a load-bearing invariant
 * (primary keys, foreign keys, and backward compatibility with existing
 * data rely on it). Do not replace with generateUUID().
 */
export function generateId(): string {
	return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
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
 * Normalize file paths to use forward slashes consistently across platforms.
 *
 * This ensures that paths stored in the database use a consistent format
 * regardless of the operating system, enabling cross-platform data portability
 * and consistent filtering by project path.
 *
 * - Converts Windows-style backslashes to forward slashes
 * - Preserves UNC paths (\\server\share -> //server/share)
 * - Handles null/undefined by returning null
 *
 * @param filePath - The file path to normalize (may be Windows or Unix style)
 * @returns The normalized path with forward slashes, or null if input is null/undefined
 */
export function normalizePath(filePath: string | null | undefined): string | null {
	if (filePath == null) {
		return null;
	}
	// Replace all backslashes with forward slashes
	return filePath.replace(/\\/g, '/');
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
