/**
 * Multi-Window Usage CRUD Operations
 *
 * Records aggregate-safe local telemetry for multi-window usage.
 */

import type Database from 'better-sqlite3';
import type { MultiWindowEvent, StatsTimeRange } from '../../shared/stats-types';
import { generateId, getTimeRangeStart, LOG_CONTEXT, StatementCache } from './utils';
import { logger } from '../utils/logger';

const stmtCache = new StatementCache();

const INSERT_SQL = `
  INSERT INTO multi_window_events (
    id,
    event_type,
    timestamp,
    window_count,
    secondary_window_count,
    session_count
  )
  VALUES (?, ?, ?, ?, ?, ?)
`;

export interface MultiWindowUsageStats {
	hasUsedMultipleWindows: boolean;
	averageWindowCount: number;
	maxWindowCount: number;
	totalWindowCreatedEvents: number;
	totalWindowClosedEvents: number;
	totalSessionMovedEvents: number;
}

export function recordMultiWindowEvent(
	db: Database.Database,
	event: Omit<MultiWindowEvent, 'id' | 'timestamp'>
): string {
	const id = generateId();
	const stmt = stmtCache.get(db, INSERT_SQL);

	stmt.run(
		id,
		event.eventType,
		Date.now(),
		event.windowCount,
		event.secondaryWindowCount,
		event.sessionCount
	);

	logger.debug(`Recorded multi-window event ${id}`, LOG_CONTEXT, {
		eventType: event.eventType,
		windowCount: event.windowCount,
	});
	return id;
}

export function getMultiWindowUsageStats(
	db: Database.Database,
	range: StatsTimeRange
): MultiWindowUsageStats {
	const startTime = getTimeRangeStart(range);
	const totals = db
		.prepare(
			`
      SELECT
        COUNT(*) as total_events,
        COALESCE(AVG(window_count), 0) as average_window_count,
        COALESCE(MAX(window_count), 0) as max_window_count,
        COALESCE(MAX(CASE WHEN window_count > 1 THEN 1 ELSE 0 END), 0) as has_multiple_windows
      FROM multi_window_events
      WHERE timestamp >= ?
    `
		)
		.get(startTime) as {
		total_events: number;
		average_window_count: number;
		max_window_count: number;
		has_multiple_windows: number;
	};

	const byTypeRows = db
		.prepare(
			`
      SELECT event_type, COUNT(*) as count
      FROM multi_window_events
      WHERE timestamp >= ?
      GROUP BY event_type
    `
		)
		.all(startTime) as Array<{ event_type: MultiWindowEvent['eventType']; count: number }>;

	const byType: Record<MultiWindowEvent['eventType'], number> = {
		window_created: 0,
		window_closed: 0,
		session_moved: 0,
	};
	for (const row of byTypeRows) {
		byType[row.event_type] = row.count;
	}

	return {
		hasUsedMultipleWindows: totals.has_multiple_windows === 1,
		averageWindowCount:
			totals.total_events > 0 ? Math.round(totals.average_window_count * 100) / 100 : 0,
		maxWindowCount: totals.max_window_count,
		totalWindowCreatedEvents: byType.window_created,
		totalWindowClosedEvents: byType.window_closed,
		totalSessionMovedEvents: byType.session_moved,
	};
}

export function clearMultiWindowEventCache(): void {
	stmtCache.clear();
}
