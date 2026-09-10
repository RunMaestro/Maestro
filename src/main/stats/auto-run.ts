/**
 * Auto Run CRUD Operations
 *
 * Handles insertion, updating, and retrieval of Auto Run sessions and tasks.
 */

import type Database from 'better-sqlite3';
import {
	normalizeAutoRunKind,
	type AutoRunSession,
	type AutoRunTask,
	type StatsTimeRange,
} from '../../shared/stats-types';
import { generateId, getTimeRangeStart, normalizePath, LOG_CONTEXT } from './utils';
import {
	mapAutoRunSessionRow,
	mapAutoRunTaskRow,
	type AutoRunSessionRow,
	type AutoRunTaskRow,
} from './row-mappers';
import { StatementCache } from './utils';
import { logger } from '../utils/logger';

const stmtCache = new StatementCache();

// ============================================================================
// Auto Run Sessions
// ============================================================================

const INSERT_SESSION_SQL = `
  INSERT INTO auto_run_sessions (id, session_id, agent_type, document_path, start_time, duration, tasks_total, tasks_completed, project_path, kind)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

/**
 * Insert a new Auto Run session
 */
export function insertAutoRunSession(
	db: Database.Database,
	session: Omit<AutoRunSession, 'id'>
): string {
	const id = generateId();
	const stmt = stmtCache.get(db, INSERT_SESSION_SQL);

	stmt.run(
		id,
		session.sessionId,
		session.agentType,
		normalizePath(session.documentPath),
		session.startTime,
		session.duration,
		session.tasksTotal ?? null,
		session.tasksCompleted ?? null,
		normalizePath(session.projectPath),
		// Kind is fixed at start; the value arrives over IPC, so coerce it.
		normalizeAutoRunKind(session.kind)
	);

	logger.debug(`Inserted Auto Run session ${id}`, LOG_CONTEXT);
	return id;
}

/**
 * Update an existing Auto Run session (e.g., when it completes)
 */
export function updateAutoRunSession(
	db: Database.Database,
	id: string,
	updates: Partial<AutoRunSession>
): boolean {
	const setClauses: string[] = [];
	const params: (string | number | null)[] = [];

	if (updates.duration !== undefined) {
		setClauses.push('duration = ?');
		params.push(updates.duration);
	}
	if (updates.tasksTotal !== undefined) {
		setClauses.push('tasks_total = ?');
		params.push(updates.tasksTotal ?? null);
	}
	if (updates.tasksCompleted !== undefined) {
		setClauses.push('tasks_completed = ?');
		params.push(updates.tasksCompleted ?? null);
	}
	if (updates.documentPath !== undefined) {
		setClauses.push('document_path = ?');
		params.push(normalizePath(updates.documentPath));
	}

	if (setClauses.length === 0) {
		return false;
	}

	params.push(id);
	const sql = `UPDATE auto_run_sessions SET ${setClauses.join(', ')} WHERE id = ?`;
	const stmt = db.prepare(sql);
	const result = stmt.run(...params);

	logger.debug(`Updated Auto Run session ${id}`, LOG_CONTEXT);
	return result.changes > 0;
}

/**
 * Get Auto Run sessions within a time range
 */
export function getAutoRunSessions(db: Database.Database, range: StatsTimeRange): AutoRunSession[] {
	const startTime = getTimeRangeStart(range);
	const stmt = stmtCache.get(
		db,
		`
      SELECT * FROM auto_run_sessions
      WHERE start_time >= ?
      ORDER BY start_time DESC
    `
	);

	const rows = stmt.all(startTime) as AutoRunSessionRow[];
	return rows.map(mapAutoRunSessionRow);
}

// ============================================================================
// Auto Run Tasks
// ============================================================================

const INSERT_TASK_SQL = `
  INSERT INTO auto_run_tasks (id, auto_run_session_id, session_id, agent_type, task_index, task_content, start_time, duration, success)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

/**
 * Insert a new Auto Run task
 */
export function insertAutoRunTask(db: Database.Database, task: Omit<AutoRunTask, 'id'>): string {
	const id = generateId();
	const stmt = stmtCache.get(db, INSERT_TASK_SQL);

	stmt.run(
		id,
		task.autoRunSessionId,
		task.sessionId,
		task.agentType,
		task.taskIndex,
		task.taskContent ?? null,
		task.startTime,
		task.duration,
		task.success ? 1 : 0
	);

	logger.debug(`Inserted Auto Run task ${id}`, LOG_CONTEXT);
	return id;
}

/**
 * Get all tasks for a specific Auto Run session
 */
export function getAutoRunTasks(db: Database.Database, autoRunSessionId: string): AutoRunTask[] {
	const stmt = stmtCache.get(
		db,
		`
      SELECT * FROM auto_run_tasks
      WHERE auto_run_session_id = ?
      ORDER BY task_index ASC
    `
	);

	const rows = stmt.all(autoRunSessionId) as AutoRunTaskRow[];
	return rows.map(mapAutoRunTaskRow);
}

/**
 * Clear the statement cache (call when database is closed)
 */
export function clearAutoRunCache(): void {
	stmtCache.clear();
}
