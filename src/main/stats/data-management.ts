/**
 * Data Management Operations
 *
 * Handles data cleanup with transactional safety. Export lives in
 * `usage-export.ts`.
 */

import type Database from 'better-sqlite3';
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
 * All deletes run within a single transaction for atomicity - either all tables
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
	error?: string;
} {
	if (olderThanDays <= 0) {
		return {
			success: false,
			deletedQueryEvents: 0,
			deletedAutoRunSessions: 0,
			deletedAutoRunTasks: 0,
			deletedSessionLifecycle: 0,
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
		});

		runCleanup();

		const totalDeleted = deletedEvents + deletedSessions + deletedTasks + deletedLifecycle;
		logger.info(
			`Cleared ${totalDeleted} old stats records (${deletedEvents} query events, ${deletedSessions} auto-run sessions, ${deletedTasks} auto-run tasks, ${deletedLifecycle} session lifecycle)`,
			LOG_CONTEXT
		);

		return {
			success: true,
			deletedQueryEvents: deletedEvents,
			deletedAutoRunSessions: deletedSessions,
			deletedAutoRunTasks: deletedTasks,
			deletedSessionLifecycle: deletedLifecycle,
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
			error: errorMessage,
		};
	}
}
