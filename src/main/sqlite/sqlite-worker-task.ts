/**
 * The work the SQLite child process (sqlite-worker.ts) can do, by kind.
 *
 * Each kind opens the file on a read-only connection of its own and runs
 * something better-sqlite3 cannot interrupt, which on the main process would
 * hold every IPC call until it finished:
 *
 *   - `integrity`: `PRAGMA quick_check` / `integrity_check`, which read every
 *     page (sqlite-integrity-task.ts).
 *   - `query`: one statement a person wrote in Query mode, which may run for
 *     ever (sqlite-query-task.ts).
 *   - `export`: the same statement, every row written to a file as CSV or
 *     JSON Lines (Query mode's Export, also sqlite-query-task.ts).
 *
 * Nothing here, or reachable from here, may import `electron`.
 */

import type {
	SqliteIntegrityResult,
	SqliteQueryExported,
	SqliteQueryResult,
} from '../../shared/sqlite/types';
import { runSqliteIntegrityCheck, type SqliteIntegrityTask } from './sqlite-integrity-task';
import {
	exportSqliteQueryTask,
	runSqliteQueryTask,
	type SqliteQueryExportTask,
	type SqliteQueryTask,
} from './sqlite-query-task';

/** Each kind's task and result. */
export interface SqliteWorkerTasks {
	integrity: { task: SqliteIntegrityTask; result: SqliteIntegrityResult };
	query: { task: SqliteQueryTask; result: SqliteQueryResult };
	export: { task: SqliteQueryExportTask; result: SqliteQueryExported };
}

export type SqliteWorkerKind = keyof SqliteWorkerTasks;

/** What the thread is started with, as `workerData`. */
export interface SqliteWorkerData<K extends SqliteWorkerKind = SqliteWorkerKind> {
	kind: K;
	task: SqliteWorkerTasks[K]['task'];
}

/** The thread's one reply: the result, or the error that kept it from one. */
export type SqliteWorkerReply<R = unknown> =
	| { ok: true; result: R }
	| { ok: false; error: { message: string; code?: string } };

const RUNNERS: {
	[K in SqliteWorkerKind]: (task: SqliteWorkerTasks[K]['task']) => SqliteWorkerTasks[K]['result'];
} = {
	integrity: runSqliteIntegrityCheck,
	query: runSqliteQueryTask,
	export: exportSqliteQueryTask,
};

/** Run one task where it is called. The child process calls this; so does the inline fallback. */
export function runSqliteWorkerTask<K extends SqliteWorkerKind>(
	data: SqliteWorkerData<K>
): SqliteWorkerTasks[K]['result'] {
	const run = RUNNERS[data.kind] as (
		task: SqliteWorkerTasks[K]['task']
	) => SqliteWorkerTasks[K]['result'];
	return run(data.task);
}

/** An error as the reply carries it: its message, and SQLite's code when it has one. */
export function sqliteWorkerFailure(error: unknown): SqliteWorkerReply<never> {
	const code = (error as { code?: unknown } | null)?.code;
	return {
		ok: false,
		error: {
			message: error instanceof Error ? error.message : String(error),
			...(typeof code === 'string' ? { code } : {}),
		},
	};
}

/** The reply's error as a thrown one again, code kept, on the main side. */
export function sqliteWorkerError(error: { message: string; code?: string }): Error {
	return Object.assign(new Error(error.message), error.code ? { code: error.code } : {});
}
