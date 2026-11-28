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
 *   - `backup`: `VACUUM INTO` a copy beside the file, taken before the app
 *     first writes to it (sqlite-backup-task.ts).
 *
 * And one SESSION kind, a child that answers request after request until it
 * is done (`startSqliteWorkerSession()`, `serveSqliteWorkerSession()`):
 *
 *   - `transaction`: Query mode's explicit transaction, `BEGIN IMMEDIATE`
 *     held open across statements until Commit or Roll back
 *     (`openSqliteTransactionTask()` in sqlite-query-task.ts).
 *
 * Nothing here, or reachable from here, may import `electron`.
 */

import type {
	SqliteIntegrityResult,
	SqliteQueryExported,
	SqliteQueryResult,
} from '../../shared/sqlite/types';
import {
	runSqliteBackupTask,
	type SqliteBackupTask,
	type SqliteBackupTaskResult,
} from './sqlite-backup-task';
import { runSqliteIntegrityCheck, type SqliteIntegrityTask } from './sqlite-integrity-task';
import {
	exportSqliteQueryTask,
	openSqliteTransactionTask,
	runSqliteQueryTask,
	type SqliteQueryExportTask,
	type SqliteQueryTask,
	type SqliteTransactionOp,
	type SqliteTransactionReply,
	type SqliteTransactionTask,
	type SqliteTransactionTotals,
	type SqliteWorkerSessionHost,
} from './sqlite-query-task';

/** Each kind's task and result. */
export interface SqliteWorkerTasks {
	integrity: { task: SqliteIntegrityTask; result: SqliteIntegrityResult };
	query: { task: SqliteQueryTask; result: SqliteQueryResult };
	export: { task: SqliteQueryExportTask; result: SqliteQueryExported };
	backup: { task: SqliteBackupTask; result: SqliteBackupTaskResult };
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
	| { ok: false; error: SqliteWorkerErrorData };

/**
 * A failure as the reply carries it: its message, SQLite's code when it has
 * one, and, for a Query-mode syntax error, where in the statement SQLite
 * stopped (see `prepareOne()` in sqlite-query-task.ts).
 */
export interface SqliteWorkerErrorData {
	message: string;
	code?: string;
	offset?: number;
}

const RUNNERS: {
	[K in SqliteWorkerKind]: (task: SqliteWorkerTasks[K]['task']) => SqliteWorkerTasks[K]['result'];
} = {
	integrity: runSqliteIntegrityCheck,
	query: runSqliteQueryTask,
	export: exportSqliteQueryTask,
	backup: runSqliteBackupTask,
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

/** An error as the reply carries it: its message, SQLite's code, and a syntax error's offset. */
export function sqliteWorkerFailure(error: unknown): SqliteWorkerReply<never> {
	const { code, offset } = (error ?? {}) as { code?: unknown; offset?: unknown };
	return {
		ok: false,
		error: {
			message: error instanceof Error ? error.message : String(error),
			...(typeof code === 'string' ? { code } : {}),
			...(typeof offset === 'number' ? { offset } : {}),
		},
	};
}

/** The reply's error as a thrown one again, code and offset kept, on the main side. */
export function sqliteWorkerError(error: SqliteWorkerErrorData): Error {
	return Object.assign(
		new Error(error.message),
		error.code ? { code: error.code } : {},
		typeof error.offset === 'number' ? { offset: error.offset } : {}
	);
}

/** Each session kind's task, what opening it answers, one request, and its reply. */
export interface SqliteWorkerSessions {
	transaction: {
		task: SqliteTransactionTask;
		opened: SqliteTransactionTotals;
		op: SqliteTransactionOp;
		result: SqliteTransactionReply;
	};
}

export type SqliteWorkerSessionKind = keyof SqliteWorkerSessions;

/** What a session's child is started with: the first IPC message. */
export interface SqliteWorkerSessionData<
	K extends SqliteWorkerSessionKind = SqliteWorkerSessionKind,
> {
	session: K;
	task: SqliteWorkerSessions[K]['task'];
}

/** A session's reply to its opening or to one request: the reply, and whether the session is over. */
export type SqliteWorkerSessionReply<R = unknown> = SqliteWorkerReply<R> & { closed: boolean };

/** A session, opened where it is called: what opening answered, and the host for its requests. */
export interface SqliteWorkerSessionOpened<K extends SqliteWorkerSessionKind> {
	opened: SqliteWorkerSessions[K]['opened'];
	host: SqliteWorkerSessionHost<SqliteWorkerSessions[K]['op'], SqliteWorkerSessions[K]['result']>;
}

const SESSION_OPENERS: {
	[K in SqliteWorkerSessionKind]: (
		task: SqliteWorkerSessions[K]['task']
	) => SqliteWorkerSessionOpened<K>;
} = {
	transaction: openSqliteTransactionTask,
};

/** Whether a child's first message opens a session rather than running one task. */
export function isSqliteWorkerSessionData(data: unknown): data is SqliteWorkerSessionData {
	return typeof (data as { session?: unknown } | null)?.session === 'string';
}

/** Open one session where it is called. The child process calls this; so does the inline fallback. */
export function openSqliteWorkerSession<K extends SqliteWorkerSessionKind>(
	data: SqliteWorkerSessionData<K>
): SqliteWorkerSessionOpened<K> {
	return SESSION_OPENERS[data.session](data.task) as SqliteWorkerSessionOpened<K>;
}

/** Answer one request on an open session, as its reply. */
export function answerSqliteWorkerSession<Op, R>(
	host: SqliteWorkerSessionHost<Op, R>,
	op: Op
): SqliteWorkerSessionReply<R> {
	try {
		const result = host.handle(op);
		return { ok: true, result, closed: host.closed };
	} catch (error) {
		return { ...sqliteWorkerFailure(error), closed: host.closed };
	}
}
