/**
 * SQLite Query Runs
 *
 * Query mode's Run: one read-only statement a person wrote, run against an
 * open database, one window of its result back. The statement runs in a
 * child process with a connection of its own (sqlite-query-task.ts holds the
 * four read-only layers), because SQL a person writes can run for ever and
 * better-sqlite3 cannot interrupt it. On the main process that would freeze
 * every window; in a child it costs a wait, and the child is killed when:
 *
 *   - it passes `SQLITE_QUERY_TIMEOUT_MS`;
 *   - the caller stops it (`cancelSqliteQuery()`: the Stop button), or starts
 *     a newer run under the same `queryId` (Run pressed again);
 *   - its database is released (the tab closed, the idle reaper).
 *
 * Shared by the `sqlite:runQuery` IPC handler and the `sqlite_run_query` WS
 * handler (`maestro-cli sqlite query`), so both answer with the same rows.
 *
 * With the tab's editing grant (`request.editToken`; the CLI's
 * `--enable-editing`), the read-only assertion is lifted for that run, and
 * only then: a statement SQLite says would change the database goes through
 * the editing unlock's write gate and backup (`beginSqliteWorkerWrite()`)
 * and runs once in the child on a writable connection, in a transaction of
 * its own (`runWithEditing()`). Everything else still runs read-only.
 *
 * A run of the first window is recorded in the database's query history
 * (sqlite-query-history.ts) before it answers, so the History rail read
 * right after it already lists it, whoever ran it. Recording never fails a
 * run.
 *
 * `exportSqliteQuery()` (Query mode's Export, `maestro-cli sqlite query
 * --output`) runs the statement the same way and writes every row to a file
 * in the child, through a temporary file renamed into place once the last
 * row is written, so a stopped or failed export never leaves half a file
 * where the person asked for one.
 */

import { randomUUID } from 'crypto';
import { mkdirSync, promises as fs } from 'fs';
import path from 'path';

import {
	SQLITE_EXPORT_STOPPED_MESSAGE,
	SQLITE_EXPORT_TIMEOUT_MS,
	SQLITE_QUERY_PAGE_ROWS,
	SQLITE_QUERY_MAX_LIMIT,
	SQLITE_QUERY_STOPPED_MESSAGE,
	SQLITE_QUERY_TIMEOUT_MS,
	SQLITE_WRITE_CLOSED_MESSAGE,
	SQLITE_WRITE_LOCKED_MESSAGE,
	SQLITE_WRITE_RERUN_MESSAGE,
	SQLITE_WRITE_STOPPED_MESSAGE,
	isSqliteWriteStatement,
	sqliteEditingQueryRefusal,
	sqliteExportTimeoutMessage,
	sqliteQueryBinding,
	sqliteQueryTimeoutMessage,
	sqliteStatementToRun,
	sqliteWriteTimeoutMessage,
} from '../../shared/sqlite/query';
import type { SqliteQueryHistoryRun } from '../../shared/sqlite/history';
import type {
	SqliteQueryExported,
	SqliteQueryExportRequest,
	SqliteQueryRequest,
	SqliteQueryResult,
} from '../../shared/sqlite/types';
import { isTabularExportFormat, tabularExportFormatForPath } from '../../shared/tabularExport';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';
import { reportSqliteBusy } from './sqlite-connection';
import { getSqliteDatabase, type OpenSqliteDatabase } from './sqlite-database';
import {
	beginSqliteWorkerWrite,
	onSqliteEditingRevoked,
	requireSqliteEditing,
	type SqliteWorkerWriteSession,
} from './sqlite-editing';
import { getSqliteQueryHistory } from './sqlite-query-history';
import { SQLITE_QUERY_REFUSED, type SqliteQueryTask } from './sqlite-query-task';
import { windowBound } from './sqlite-rows';
import { startSqliteWorkerTask, type SqliteWorkerRun } from './sqlite-worker-runner';

/**
 * Runs and exports that can be stopped by id. `stop` rejects the caller in
 * the run's own words; a write still waiting on its backup only marks itself
 * stopped, and never starts.
 */
const running = new Map<string, { stop: () => void }>();

/** Stop whatever runs under `queryId`, in its own words. */
function stopRunning(queryId: string): boolean {
	const entry = running.get(queryId);
	if (!entry) return false;
	running.delete(queryId);
	entry.stop();
	return true;
}

/** A refusal raised in main before anything ran: never recorded in the history. */
function refused(message: string): Error {
	return Object.assign(new Error(message), { code: SQLITE_QUERY_REFUSED });
}

/** Record one run in the history. A history that cannot be written is reported, never thrown. */
async function recordRun(databasePath: string, run: SqliteQueryHistoryRun): Promise<void> {
	try {
		await getSqliteQueryHistory().record(databasePath, run);
	} catch (error) {
		logger.warn('Could not record a query in the history', 'SqliteQuery', {
			error: error instanceof Error ? error.message : String(error),
		});
		void captureException(error, { context: 'sqlite-query-history:record' });
	}
}

/**
 * `result`, once its run is in the history: a success with its first
 * window's numbers, a failure with its message. A refusal never ran and is
 * not recorded.
 */
function recordedRun(
	databasePath: string,
	request: SqliteQueryRequest,
	result: Promise<SqliteQueryResult>
): Promise<SqliteQueryResult> {
	const base = {
		sql: request.sql,
		plan: request.plan === true,
		params: request.params ?? {},
		ranAt: Date.now(),
	};
	return result.then(
		async (value) => {
			await recordRun(databasePath, {
				...base,
				outcome: {
					ok: true,
					rows: value.rows.length,
					hasMore: value.hasMore,
					returnsRows: value.returnsRows,
					elapsedMs: value.elapsedMs,
					...(value.write ? { changes: value.write.changes } : {}),
				},
			});
			return value;
		},
		async (error: unknown) => {
			if ((error as { code?: unknown } | null)?.code !== SQLITE_QUERY_REFUSED) {
				const message = error instanceof Error ? error.message : String(error);
				await recordRun(databasePath, { ...base, outcome: { ok: false, error: message } });
			}
			throw error;
		}
	);
}

/** Track `run` under `queryId` until it settles, so `cancelSqliteQuery()` can stop it. */
function tracked<R>(
	queryId: string | null,
	run: SqliteWorkerRun<R>,
	stoppedMessage: string
): Promise<R> {
	if (!queryId) return run.result;
	const entry = { stop: () => run.stop(stoppedMessage) };
	running.set(queryId, entry);
	return run.result.finally(() => {
		if (running.get(queryId) === entry) running.delete(queryId);
	});
}

function checkParams(params: unknown): Error | null {
	return params != null && (typeof params !== 'object' || Array.isArray(params))
		? new Error('SQLite query params must be an object keyed by parameter.')
		: null;
}

/**
 * Run one read-only statement and return the window of its result at
 * `offset`, its parameters bound from `request.params` (or, with
 * `request.plan`, the statement's `EXPLAIN QUERY PLAN`). Rejects with a
 * refusal for a statement that is not read-only or a parameter with no
 * usable value, with SQLite's own message for one that fails, and with
 * `SQLITE_QUERY_STOPPED_MESSAGE` or the timeout message for one stopped.
 * With a live `request.editToken`, a statement that changes the database
 * runs too, once, and its result carries `write` (see `runWithEditing()`).
 */
export function runSqliteQuery(request: SqliteQueryRequest): Promise<SqliteQueryResult> {
	if (typeof request.sql !== 'string') {
		return Promise.reject(new Error('SQLite query sql must be a string.'));
	}
	const paramsError = checkParams(request.params);
	if (paramsError) return Promise.reject(paramsError);
	if (request.plan != null && typeof request.plan !== 'boolean') {
		return Promise.reject(new Error('SQLite query plan must be true or false.'));
	}
	const database = getSqliteDatabase(request.handle);
	const offset = windowBound(request.offset ?? 0, 'offset');
	const limit = Math.min(
		windowBound(request.limit ?? SQLITE_QUERY_PAGE_ROWS, 'limit'),
		SQLITE_QUERY_MAX_LIMIT
	);

	const queryId = request.queryId ?? null;
	if (queryId) stopRunning(queryId);

	const task: SqliteQueryTask = {
		filePath: database.displayPath,
		sql: request.sql,
		offset,
		limit,
		params: request.params ?? undefined,
		plan: request.plan === true,
	};
	// Restated before the history records it, so the rail says the same.
	const result =
		request.editToken == null
			? reportSqliteBusy('read', () => startReadRun(database, task, queryId))
			: runWithEditing(database, request, task, queryId);
	return offset === 0 ? recordedRun(database.displayPath, request, result) : result;
}

/** One run on a read-only connection in the child process: every run without editing, and reads with it. */
function startReadRun(
	database: OpenSqliteDatabase,
	task: SqliteQueryTask,
	queryId: string | null
): Promise<SqliteQueryResult> {
	const run = startSqliteWorkerTask(
		database,
		{ kind: 'query', task },
		{
			closedMessage: `${SQLITE_QUERY_STOPPED_MESSAGE} The database was closed.`,
			timeoutMs: SQLITE_QUERY_TIMEOUT_MS,
			timeoutMessage: sqliteQueryTimeoutMessage(),
			label: 'The query',
		}
	);
	return tracked(queryId, run, SQLITE_QUERY_STOPPED_MESSAGE);
}

/**
 * Whether SQLite would change the database running `sql`
 * (`isSqliteWriteStatement()` over `stmt.readonly`), asked of the handle's
 * READ-ONLY connection: a prepare compiles the statement and runs none of
 * it. A statement that does not prepare (a syntax error, a missing table,
 * two statements) goes down the read path, whose child prepares it again
 * and reports SQLite's own error with where it points; that is expected,
 * not swallowed.
 */
function statementWrites(database: OpenSqliteDatabase, sql: string): boolean {
	let readonly: boolean;
	try {
		readonly = database.db.prepare(sqliteStatementToRun(sql)).readonly;
	} catch {
		return false;
	}
	return isSqliteWriteStatement(sql, readonly);
}

/**
 * A run from a tab with editing on: the read-only assertion lifted, and only
 * for a live grant. The grant is checked first (a stale token is refused as
 * a write is), then the text by the editing rules. A statement that would not
 * change the database (and every plan) runs read-only as usual, with no
 * backup. One that would is a write: refused past the first window (a later
 * window re-runs it), then `beginSqliteWorkerWrite()` passes the gate and
 * takes the backup, and the child runs it once on a writable connection in a
 * transaction of its own (`runSqliteWriteTask()`). Lock stops it; so do Stop,
 * a newer run under `queryId` (even while the backup is still being taken,
 * when it never starts), the timeout, and closing the database.
 */
async function runWithEditing(
	database: OpenSqliteDatabase,
	request: SqliteQueryRequest,
	task: SqliteQueryTask,
	queryId: string | null
): Promise<SqliteQueryResult> {
	const { handle, editToken } = request;
	try {
		requireSqliteEditing(handle, editToken);
	} catch (error) {
		// Nothing ran, so the history does not record it.
		throw refused(error instanceof Error ? error.message : String(error));
	}
	const refusal = sqliteEditingQueryRefusal(task.sql, { plan: task.plan });
	if (refusal) throw refused(refusal);
	if (task.plan || !statementWrites(database, task.sql)) {
		return reportSqliteBusy('read', () =>
			startReadRun(database, { ...task, editing: true }, queryId)
		);
	}
	if (task.offset !== 0) throw refused(SQLITE_WRITE_RERUN_MESSAGE);
	// Settled before the backup, so a parameter with no value costs no copy.
	const binding = sqliteQueryBinding(task.sql, task.params);
	if (binding.problem !== null) throw refused(binding.problem);

	return reportSqliteBusy('write', async () => {
		let stopped = false;
		const pending = { stop: () => (stopped = true) };
		if (queryId) running.set(queryId, pending);
		let session: SqliteWorkerWriteSession;
		try {
			session = await beginSqliteWorkerWrite(handle, editToken);
		} finally {
			if (queryId && running.get(queryId) === pending) running.delete(queryId);
		}
		if (stopped) throw new Error(SQLITE_WRITE_STOPPED_MESSAGE);

		// No await from the gate to here: the grant is still live.
		const run = startSqliteWorkerTask(
			database,
			{ kind: 'query', task: { ...task, writeTarget: session.target } },
			{
				closedMessage: SQLITE_WRITE_CLOSED_MESSAGE,
				timeoutMs: SQLITE_QUERY_TIMEOUT_MS,
				timeoutMessage: sqliteWriteTimeoutMessage(),
				label: 'The statement',
			}
		);
		const unhook = onSqliteEditingRevoked(handle, editToken, (reason) =>
			run.stop(reason === 'closed' ? SQLITE_WRITE_CLOSED_MESSAGE : SQLITE_WRITE_LOCKED_MESSAGE)
		);
		try {
			const result = await tracked(queryId, run, SQLITE_WRITE_STOPPED_MESSAGE);
			const write = result.write ?? { changes: 0, otherChanges: 0 };
			return {
				...result,
				write: session.backupCreated ? { ...write, backup: session.backup } : write,
			};
		} finally {
			unhook();
		}
	});
}

/**
 * Write every row of one read-only statement to `request.destPath` as CSV or
 * JSON Lines, and resolve what was written. Rejects as a run does (a refusal,
 * SQLite's message, a stop, the timeout), and for a statement that returns no
 * rows. Not recorded in the history: the statement is the one already run.
 */
export async function exportSqliteQuery(
	request: SqliteQueryExportRequest
): Promise<SqliteQueryExported> {
	if (typeof request.sql !== 'string') throw new Error('SQLite query sql must be a string.');
	const paramsError = checkParams(request.params);
	if (paramsError) throw paramsError;
	if (typeof request.destPath !== 'string' || !path.isAbsolute(request.destPath)) {
		throw new Error('An export needs the absolute path of the file to write.');
	}
	if (request.format != null && !isTabularExportFormat(request.format)) {
		throw new Error('An export format must be "csv" or "jsonl".');
	}
	const database = getSqliteDatabase(request.handle);
	const destPath = request.destPath;
	const format = request.format ?? tabularExportFormatForPath(destPath);

	const queryId = request.queryId ?? null;
	if (queryId) stopRunning(queryId);

	// Synchronous, so the export is under `queryId` before this call yields:
	// a Stop sent at once finds it. One directory, so it costs nothing.
	mkdirSync(path.dirname(destPath), { recursive: true });
	// Beside the destination, so the rename never crosses a file system.
	const partPath = `${destPath}.${randomUUID().slice(0, 8)}.part`;
	const run = startSqliteWorkerTask(
		database,
		{
			kind: 'export',
			task: {
				filePath: database.displayPath,
				sql: request.sql,
				params: request.params ?? undefined,
				destPath: partPath,
				format,
			},
		},
		{
			closedMessage: `${SQLITE_EXPORT_STOPPED_MESSAGE} The database was closed.`,
			timeoutMs: SQLITE_EXPORT_TIMEOUT_MS,
			timeoutMessage: sqliteExportTimeoutMessage(),
			label: 'The export',
		}
	);
	try {
		const exported = await reportSqliteBusy('read', () =>
			tracked(queryId, run, SQLITE_EXPORT_STOPPED_MESSAGE)
		);
		await fs.rename(partPath, destPath);
		return { ...exported, path: destPath };
	} catch (error) {
		// A killed child may still hold the file for a moment (Windows refuses
		// to delete an open file), so let rm retry before giving up on it.
		await fs.rm(partPath, { force: true, maxRetries: 5, retryDelay: 100 }).catch((cleanup) =>
			logger.warn(`Could not remove the partial export ${partPath}`, 'SqliteQuery', {
				error: cleanup instanceof Error ? cleanup.message : String(cleanup),
			})
		);
		throw error;
	}
}

/** Stop the run or export going under `queryId`. Returns whether one was running. */
export function cancelSqliteQuery(queryId: string): boolean {
	return stopRunning(queryId);
}
