/**
 * The single definition of how an Auto Run session, its tasks, and its failures become rows.
 *
 * The Usage Dashboard's Auto Run panels read `auto_run_sessions` and `auto_run_tasks`;
 * `auto_run_failures` records each stall, task error, and halt of a run. The desktop writes them through `StatsDB` (`src/main/stats/auto-run.ts`); the headless runtime
 * writes the same rows through its own connection. Both bind through this module, so a run
 * counted by one reads the same to the dashboard as a run counted by the other.
 */

import {
	isAutoRunFailureKind,
	normalizeAutoRunKind,
	normalizeAutoRunLaunchSource,
	type AutoRunFailure,
	type AutoRunSession,
	type AutoRunTask,
} from '../../stats-types';
import { normalizePath } from './utils';

export const INSERT_AUTO_RUN_SESSION_SQL = `
  INSERT INTO auto_run_sessions (id, session_id, agent_type, document_path, start_time, duration, tasks_total, tasks_completed, project_path, kind, playbook_id, playbook_local_id, playbook_version, launch_source)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

export const INSERT_AUTO_RUN_TASK_SQL = `
  INSERT INTO auto_run_tasks (id, auto_run_session_id, session_id, agent_type, task_index, task_content, start_time, duration, success)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

export const INSERT_AUTO_RUN_FAILURE_SQL = `
  INSERT INTO auto_run_failures (id, auto_run_session_id, document_filename, task_index, kind, agent_type, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
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
	'kind',
	'playbook_id',
	'playbook_local_id',
	'playbook_version',
	'launch_source',
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
		// Kind is fixed at start; the value arrives over IPC, so coerce it.
		normalizeAutoRunKind(session.kind),
		textOrNull(session.playbookId),
		textOrNull(session.playbookLocalId),
		textOrNull(session.playbookVersion),
		// The column has a CHECK; an unknown source is stored as "not said", not refused.
		normalizeAutoRunLaunchSource(session.launchSource),
	];
}

/**
 * Bind values for `INSERT_AUTO_RUN_FAILURE_SQL`, or null when the entry is not a
 * failure this build can store (an unknown kind, which the column's CHECK would
 * refuse). The entry arrives over IPC, so each field is checked.
 */
export function bindAutoRunFailure(
	id: string,
	failure: Omit<AutoRunFailure, 'id'>
): Array<string | number | null> | null {
	if (!isAutoRunFailureKind(failure.kind)) return null;
	return [
		id,
		failure.autoRunSessionId,
		textOrNull(failure.documentFilename),
		Number.isInteger(failure.taskIndex) ? (failure.taskIndex as number) : null,
		failure.kind,
		failure.agentType,
		Number.isFinite(failure.createdAt) ? failure.createdAt : Date.now(),
	];
}

/** A non-empty string, or null. */
function textOrNull(value: unknown): string | null {
	return typeof value === 'string' && value.length > 0 ? value : null;
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
