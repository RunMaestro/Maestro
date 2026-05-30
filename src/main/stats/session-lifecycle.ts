/**
 * Session Lifecycle CRUD Operations
 *
 * Tracks when sessions are created (launched) and closed,
 * enabling session duration and lifecycle analytics.
 */

import type Database from 'better-sqlite3';
import type { SessionLifecycleEvent, StatsTimeRange } from '../../shared/stats-types';
import { generateId, getTimeRangeStart, normalizePath, LOG_CONTEXT } from './utils';
import { mapSessionLifecycleRow, type SessionLifecycleRow } from './row-mappers';
import { StatementCache } from './utils';
import { logger } from '../utils/logger';

const stmtCache = new StatementCache();

const INSERT_SQL = `
  INSERT INTO session_lifecycle (id, session_id, agent_type, project_path, created_at, is_remote, is_worktree)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`;

/**
 * Record a session being created (launched)
 */
export function recordSessionCreated(
	db: Database.Database,
	event: Omit<SessionLifecycleEvent, 'id' | 'closedAt' | 'duration'>
): string {
	const id = generateId();
	const stmt = stmtCache.get(db, INSERT_SQL);

	stmt.run(
		id,
		event.sessionId,
		event.agentType,
		normalizePath(event.projectPath),
		event.createdAt,
		event.isRemote !== undefined ? (event.isRemote ? 1 : 0) : null,
		event.isWorktree !== undefined ? (event.isWorktree ? 1 : 0) : null
	);

	logger.debug(`Recorded session created: ${event.sessionId}`, LOG_CONTEXT);
	return id;
}

/**
 * Record a session being closed
 */
export function recordSessionClosed(
	db: Database.Database,
	sessionId: string,
	closedAt: number
): boolean {
	// Get the session's created_at time to calculate duration
	const session = db
		.prepare('SELECT created_at FROM session_lifecycle WHERE session_id = ?')
		.get(sessionId) as { created_at: number } | undefined;

	if (!session) {
		logger.debug(`Session not found for closure: ${sessionId}`, LOG_CONTEXT);
		return false;
	}

	const duration = closedAt - session.created_at;

	const stmt = stmtCache.get(
		db,
		`
      UPDATE session_lifecycle
      SET closed_at = ?, duration = ?
      WHERE session_id = ?
    `
	);

	const result = stmt.run(closedAt, duration, sessionId);
	logger.debug(`Recorded session closed: ${sessionId}, duration: ${duration}ms`, LOG_CONTEXT);
	return result.changes > 0;
}

/**
 * Get session lifecycle events within a time range
 */
export function getSessionLifecycleEvents(
	db: Database.Database,
	range: StatsTimeRange
): SessionLifecycleEvent[] {
	const startTime = getTimeRangeStart(range);
	const stmt = stmtCache.get(
		db,
		`
      SELECT * FROM session_lifecycle
      WHERE created_at >= ?
      ORDER BY created_at DESC
    `
	);

	const rows = stmt.all(startTime) as SessionLifecycleRow[];
	return rows.map(mapSessionLifecycleRow);
}

/**
 * Clear the statement cache (call when database is closed)
 */
export function clearSessionLifecycleCache(): void {
	stmtCache.clear();
}
