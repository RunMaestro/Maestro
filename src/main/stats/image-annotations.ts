/**
 * Image Annotation Stats Operations
 *
 * Records each time the user saves an image from the Image Annotator and
 * counts annotations within a time range for the Usage Dashboard.
 */

import type Database from 'better-sqlite3';
import type { StatsTimeRange } from '../../shared/stats-types';
import { generateId, getTimeRangeStart, LOG_CONTEXT, StatementCache } from './utils';
import { logger } from '../utils/logger';

const stmtCache = new StatementCache();

const INSERT_SQL = `
  INSERT INTO image_annotations (id, created_at)
  VALUES (?, ?)
`;

const COUNT_SQL = `
  SELECT COUNT(*) as count
  FROM image_annotations
  WHERE created_at >= ?
`;

/**
 * Record an image annotation save event. Returns the generated id.
 */
export function insertImageAnnotation(db: Database.Database, createdAt: number): string {
	const id = generateId();
	const stmt = stmtCache.get(db, INSERT_SQL);
	stmt.run(id, createdAt);
	logger.debug(`Inserted image annotation ${id}`, LOG_CONTEXT);
	return id;
}

/**
 * Count image annotations recorded inside a time range.
 */
export function countImageAnnotations(db: Database.Database, range: StatsTimeRange): number {
	const startTime = getTimeRangeStart(range);
	const stmt = stmtCache.get(db, COUNT_SQL);
	const row = stmt.get(startTime) as { count: number } | undefined;
	return row?.count ?? 0;
}

/**
 * Count image annotations recorded at or after a given timestamp. Used by the
 * aggregation orchestrator, which already resolved its own start time.
 */
export function countImageAnnotationsSince(db: Database.Database, startTime: number): number {
	const stmt = stmtCache.get(db, COUNT_SQL);
	const row = stmt.get(startTime) as { count: number } | undefined;
	return row?.count ?? 0;
}

/**
 * Clear the statement cache (call when database is closed).
 */
export function clearImageAnnotationCache(): void {
	stmtCache.clear();
}
