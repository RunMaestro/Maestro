/**
 * Data Management Operations
 *
 * Handles data cleanup (with transactional safety) and CSV export
 * (with proper escaping and complete field coverage).
 */

import type Database from 'better-sqlite3';
import type { StatsTimeRange } from '../../shared/stats-types';
import { getQueryEvents } from './query-events';
import { LOG_CONTEXT } from './utils';
import { logger } from '../utils/logger';

// ============================================================================
// Data Cleanup
// ============================================================================

/**
 * Clear old data from the database.
 *
 * Deletes query_events, auto_run_sessions, auto_run_tasks, and session_lifecycle
 * records that are older than the specified number of days.
 *
 * All deletes run within a single transaction for atomicity — either all tables
 * are cleaned or none are.
 *
 * @param olderThanDays - Delete records older than this many days
 */
export function clearOldData(
	db: Database.Database,
	olderThanDays: number
): {
	success: boolean;
	deletedQueryEvents: number;
	deletedAutoRunSessions: number;
	deletedAutoRunTasks: number;
	deletedSessionLifecycle: number;
	deletedWindowUsageEvents: number;
	error?: string;
} {
	if (olderThanDays <= 0) {
		return {
			success: false,
			deletedQueryEvents: 0,
			deletedAutoRunSessions: 0,
			deletedAutoRunTasks: 0,
			deletedSessionLifecycle: 0,
			deletedWindowUsageEvents: 0,
			error: 'olderThanDays must be greater than 0',
		};
	}

	try {
		const cutoffTime = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;

		logger.info(
			`Clearing stats data older than ${olderThanDays} days (before ${new Date(cutoffTime).toISOString()})`,
			LOG_CONTEXT
		);

		let deletedEvents = 0;
		let deletedSessions = 0;
		let deletedTasks = 0;
		let deletedLifecycle = 0;
		let deletedWindowUsage = 0;

		// Wrap all deletes in a transaction for atomicity
		const runCleanup = db.transaction(() => {
			// Delete auto_run_tasks for sessions being deleted (cascade)
			const tasksResult = db
				.prepare(
					'DELETE FROM auto_run_tasks WHERE auto_run_session_id IN (SELECT id FROM auto_run_sessions WHERE start_time < ?)'
				)
				.run(cutoffTime);
			deletedTasks = tasksResult.changes;

			// Delete auto_run_sessions
			const sessionsResult = db
				.prepare('DELETE FROM auto_run_sessions WHERE start_time < ?')
				.run(cutoffTime);
			deletedSessions = sessionsResult.changes;

			// Delete query_events
			const eventsResult = db
				.prepare('DELETE FROM query_events WHERE start_time < ?')
				.run(cutoffTime);
			deletedEvents = eventsResult.changes;

			// Delete session_lifecycle
			const lifecycleResult = db
				.prepare('DELETE FROM session_lifecycle WHERE created_at < ?')
				.run(cutoffTime);
			deletedLifecycle = lifecycleResult.changes;

			// Delete window_usage_events
			const windowUsageResult = db
				.prepare('DELETE FROM window_usage_events WHERE recorded_at < ?')
				.run(cutoffTime);
			deletedWindowUsage = windowUsageResult.changes;
		});

		runCleanup();

		const totalDeleted =
			deletedEvents + deletedSessions + deletedTasks + deletedLifecycle + deletedWindowUsage;
		logger.info(
			`Cleared ${totalDeleted} old stats records (${deletedEvents} query events, ${deletedSessions} auto-run sessions, ${deletedTasks} auto-run tasks, ${deletedLifecycle} session lifecycle, ${deletedWindowUsage} window usage snapshots)`,
			LOG_CONTEXT
		);

		return {
			success: true,
			deletedQueryEvents: deletedEvents,
			deletedAutoRunSessions: deletedSessions,
			deletedAutoRunTasks: deletedTasks,
			deletedSessionLifecycle: deletedLifecycle,
			deletedWindowUsageEvents: deletedWindowUsage,
		};
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		logger.error(`Failed to clear old stats data: ${errorMessage}`, LOG_CONTEXT);
		return {
			success: false,
			deletedQueryEvents: 0,
			deletedAutoRunSessions: 0,
			deletedAutoRunTasks: 0,
			deletedSessionLifecycle: 0,
			deletedWindowUsageEvents: 0,
			error: errorMessage,
		};
	}
}

// ============================================================================
// CSV Export
// ============================================================================

/**
 * Escape a value for CSV output.
 *
 * Wraps the value in double quotes and escapes any embedded double quotes
 * by doubling them (RFC 4180 compliant).
 */
function csvEscape(value: string): string {
	return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Export query events to CSV format.
 *
 * Includes all fields (including isRemote added in migration v2)
 * with proper CSV escaping for values containing quotes, commas, or newlines.
 */
export function exportToCsv(db: Database.Database, range: StatsTimeRange): string {
	const events = getQueryEvents(db, range);

	const headers = [
		'id',
		'sessionId',
		'agentType',
		'source',
		'startTime',
		'duration',
		'projectPath',
		'tabId',
		'isRemote',
	];

	const rows = events.map((e) => [
		csvEscape(e.id),
		csvEscape(e.sessionId),
		csvEscape(e.agentType),
		csvEscape(e.source),
		csvEscape(new Date(e.startTime).toISOString()),
		csvEscape(e.duration.toString()),
		csvEscape(e.projectPath ?? ''),
		csvEscape(e.tabId ?? ''),
		csvEscape(e.isRemote !== undefined ? String(e.isRemote) : ''),
	]);

	return [headers.join(','), ...rows.map((row) => row.join(','))].join('\n');
}
