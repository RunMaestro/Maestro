/**
 * The single definition of how an Auto Run session and its tasks become rows.
 *
 * The Usage Dashboard's Auto Run panels read `auto_run_sessions` and `auto_run_tasks`. The
 * desktop writes them through `StatsDB` (`src/main/stats/auto-run.ts`); the headless runtime
 * writes the same rows through its own connection. Both bind through this module, so a run
 * counted by one reads the same to the dashboard as a run counted by the other.
 */

import type { AutoRunSession, AutoRunTask } from '../../stats-types';
import { normalizePath } from './utils';

export const INSERT_AUTO_RUN_SESSION_SQL = `
  INSERT INTO auto_run_sessions (id, session_id, agent_type, document_path, start_time, duration, tasks_total, tasks_completed, project_path)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

export const INSERT_AUTO_RUN_TASK_SQL = `
  INSERT INTO auto_run_tasks (id, auto_run_session_id, session_id, agent_type, task_index, task_content, start_time, duration, success)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

/** Closing a run: its duration and how many tasks it finished. */
export const UPDATE_AUTO_RUN_END_SQL =
	'UPDATE auto_run_sessions SET duration = ?, tasks_completed = ? WHERE id = ?';

/** The columns each insert needs to find on disk, so an older file is skipped rather than half written. */
export const AUTO_RUN_SESSION_COLUMNS = [
	'id',
	'session_id',
	'agent_type',
	'document_path',
	'start_time',
	'duration',
	'tasks_total',
	'tasks_completed',
	'project_path',
] as const;

export const AUTO_RUN_TASK_COLUMNS = [
	'id',
	'auto_run_session_id',
	'session_id',
	'agent_type',
	'task_index',
	'task_content',
	'start_time',
	'duration',
	'success',
] as const;

/** Bind values for `INSERT_AUTO_RUN_SESSION_SQL`. Undefined becomes NULL. */
export function bindAutoRunSession(
	id: string,
	session: Omit<AutoRunSession, 'id'>
): Array<string | number | null> {
	return [
		id,
		session.sessionId,
		session.agentType,
		normalizePath(session.documentPath),
		session.startTime,
		session.duration,
		session.tasksTotal ?? null,
		session.tasksCompleted ?? null,
		normalizePath(session.projectPath),
	];
}

/** Bind values for `INSERT_AUTO_RUN_TASK_SQL`. */
export function bindAutoRunTask(
	id: string,
	task: Omit<AutoRunTask, 'id'>
): Array<string | number | null> {
	return [
		id,
		task.autoRunSessionId,
		task.sessionId,
		task.agentType,
		task.taskIndex,
		task.taskContent ?? null,
		task.startTime,
		task.duration,
		task.success ? 1 : 0,
	];
}
