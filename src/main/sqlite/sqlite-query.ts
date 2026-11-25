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
 * A dry run (`request.dryRun`, editing only) changes nothing: a read is
 * classified and not run, VACUUM and a writing PRAGMA are classified and not
 * tried (SQLite runs them outside any transaction), and any other write is
 * tried once in the child through `beginSqliteWorkerTrial()` (the gate and
 * file check, no backup) and rolled back (`runDryRun()`). Not recorded in
 * the history: nothing ran against the file.
 *
 * With `request.transactionId` (editing only), the statement runs inside the
 * tab's open explicit transaction instead, read or write, on that
 * transaction's connection (`runInSqliteTransaction()` in
 * sqlite-transaction.ts): nothing it changes is committed until Commit, and
 * stopping it rolls the whole transaction back.
 *
 * A write that reached the file (not a dry run, not one refused or stopped
 * before its child started) is recorded in the database's statement log
 * (sqlite-statement-log.ts) before it answers, done or failed; a write in an
 * explicit transaction is logged by sqlite-transaction.ts.
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
	SQLITE_DRY_RUN_READ_MESSAGE,
	classifySqliteStatement,
	sqliteDryRunNotTried,
	sqliteDryRunRefusal,
	sqliteDryRunUntransactedMessage,
} from '../../shared/sqlite/dryRun';
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
	isSqliteUntransactedStatement,
	isSqliteWriteStatement,
	sqliteEditingQueryRefusal,
	sqliteExportTimeoutMessage,
	sqliteLeadingKeyword,
	sqliteQueryBinding,
	sqliteQueryTimeoutMessage,
	sqliteStatementToRun,
	sqliteWriteTimeoutMessage,
} from '../../shared/sqlite/query';
import {
	sqliteStatementParameterValues,
	type SqliteQueryHistoryRun,
} from '../../shared/sqlite/history';
import { SQLITE_TRANSACTION_STOPPED_MESSAGE } from '../../shared/sqlite/transaction';
import type {
	SqliteQueryExported,
	SqliteQueryExportRequest,
	SqliteQueryRequest,
	SqliteQueryResult,
	SqliteQueryWrite,
	SqliteStatementLogOutcome,
} from '../../shared/sqlite/types';
import { isTabularExportFormat, tabularExportFormatForPath } from '../../shared/tabularExport';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';
import { describeSqliteBusy, reportSqliteBusy } from './sqlite-connection';
import { getSqliteDatabase, type OpenSqliteDatabase } from './sqlite-database';
import {
	beginSqliteWorkerTrial,
	beginSqliteWorkerWrite,
	onSqliteEditingRevoked,
	requireSqliteEditing,
} from './sqlite-editing';
import type { SqliteWriteTarget } from './sqlite-connection';
import { getSqliteQueryHistory } from './sqlite-query-history';
import {
	logSqliteStatement,
	sqliteLoggedBackup,
	sqliteLoggedChanges,
	sqliteLoggedFailure,
} from './sqlite-statement-log';
import { runInSqliteTransaction } from './sqlite-transaction';
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
					...(value.inTransaction?.writes ? { changes: value.inTransaction.changes } : {}),
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
	run: Pick<SqliteWorkerRun<R>, 'result' | 'stop'>,
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
 * runs too, once, and its result carries `write` (see `runWithEditing()`);
 * with `request.dryRun` as well, nothing is changed and the result carries
 * `dryRun` instead.
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
	if (request.dryRun != null && typeof request.dryRun !== 'boolean') {
		return Promise.reject(new Error('SQLite query dryRun must be true or false.'));
	}
	if (request.transactionId != null && typeof request.transactionId !== 'string') {
		return Promise.reject(new Error('SQLite query transactionId must be a string.'));
	}
	const dryRun = request.dryRun === true;
	const inTransaction = request.transactionId != null;
	if (dryRun) {
		const refusal = sqliteDryRunRefusal({
			editing: request.editToken != null,
			plan: request.plan === true,
			transaction: inTransaction,
		});
		if (refusal) return Promise.reject(refused(refusal));
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
	const result = inTransaction
		? tracked(
				queryId,
				runInSqliteTransaction(request, {
					sql: task.sql,
					offset,
					limit,
					params: task.params,
					plan: task.plan,
				}),
				// Never seen: a stopped statement rejects in the transaction's own words.
				SQLITE_TRANSACTION_STOPPED_MESSAGE
			)
		: request.editToken == null
			? reportSqliteBusy('read', () => startReadRun(database, task, queryId))
			: runWithEditing(database, request, task, queryId);
	// A dry run changed nothing, so the history does not record it.
	return offset === 0 && !dryRun ? recordedRun(database.displayPath, request, result) : result;
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
 * it. Null for a statement that does not prepare (a syntax error, a missing
 * table, two statements): it goes down the read path, whose child prepares
 * it again and reports SQLite's own error with where it points; that is
 * expected, not swallowed.
 */
function statementWrites(database: OpenSqliteDatabase, sql: string): boolean | null {
	let readonly: boolean;
	try {
		readonly = database.db.prepare(sqliteStatementToRun(sql)).readonly;
	} catch {
		return null;
	}
	return isSqliteWriteStatement(sql, readonly);
}

/** A dry run that ran nothing: an empty result carrying what the statement is and why. */
function untriedDryRun(sql: string, writes: boolean, reason: string): SqliteQueryResult {
	return {
		statement: sqliteLeadingKeyword(sql),
		columns: [],
		rows: [],
		offset: 0,
		hasMore: false,
		returnsRows: false,
		elapsedMs: 0,
		dryRun: sqliteDryRunNotTried(classifySqliteStatement(sql, writes), reason),
	};
}

/**
 * A run from a tab with editing on: the read-only assertion lifted, and only
 * for a live grant. The grant is checked first (a stale token is refused as
 * a write is), then the text by the editing rules. A statement that would not
 * change the database (and every plan) runs read-only as usual, with no
 * backup. One that would is a write: refused past the first window (a later
 * window re-runs it), then `beginSqliteWorkerWrite()` passes the gate and
 * takes the backup, and the child runs it once on a writable connection in a
 * transaction of its own (`runSqliteWriteTask()`, through `runInWriteChild()`).
 *
 * With `request.dryRun`, nothing is changed: a read is classified and not
 * run, a statement SQLite runs outside any transaction (VACUUM, a writing
 * PRAGMA) is classified and not tried, and any other write passes
 * `beginSqliteWorkerTrial()` (the gate and file check, no backup) and is
 * tried in the child and rolled back. One that does not prepare still goes
 * down the read path, so the child reports SQLite's error and where it points.
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
	const dryRun = request.dryRun === true;
	const writes = task.plan ? false : statementWrites(database, task.sql);
	// A dry run of a read changes nothing, so it is not run at all.
	if (dryRun && writes === false) {
		return untriedDryRun(task.sql, false, SQLITE_DRY_RUN_READ_MESSAGE);
	}
	if (writes !== true) {
		// With a dry run, only a statement that does not prepare: the child says why.
		return reportSqliteBusy('read', () =>
			startReadRun(database, { ...task, editing: true }, queryId)
		);
	}
	if (task.offset !== 0) throw refused(SQLITE_WRITE_RERUN_MESSAGE);
	// Settled before the backup, so a parameter with no value costs no copy.
	const binding = sqliteQueryBinding(task.sql, task.params);
	if (binding.problem !== null) throw refused(binding.problem);
	if (dryRun) {
		// SQLite runs these outside any transaction: there is nothing to roll back.
		if (isSqliteUntransactedStatement(task.sql)) {
			return untriedDryRun(
				task.sql,
				true,
				sqliteDryRunUntransactedMessage(sqliteLeadingKeyword(task.sql))
			);
		}
		return runInWriteChild(database, request, task, queryId, async () => ({
			target: (await beginSqliteWorkerTrial(handle, editToken)).target,
		}));
	}

	return runInWriteChild(database, request, task, queryId, async () => {
		const session = await beginSqliteWorkerWrite(handle, editToken);
		return { target: session.target, backup: session.backupCreated ? session.backup : undefined };
	});
}

/**
 * Run `task` once in the SQLite child on the file `open()` hands back after
 * passing its gate: a write (`beginSqliteWorkerWrite()`, with the backup) or
 * a dry run's trial (`beginSqliteWorkerTrial()`). Lock stops it; so do Stop,
 * a newer run under `queryId` (even while the gate is still being passed,
 * when it never starts), the timeout, and closing the database. A busy file
 * is reported in the write's words.
 */
function runInWriteChild(
	database: OpenSqliteDatabase,
	request: SqliteQueryRequest,
	task: SqliteQueryTask,
	queryId: string | null,
	open: () => Promise<{ target: SqliteWriteTarget; backup?: SqliteQueryWrite['backup'] }>
): Promise<SqliteQueryResult> {
	const { handle, editToken } = request;
	const dryRun = request.dryRun === true;
	return reportSqliteBusy('write', async () => {
		let stopped = false;
		const pending = { stop: () => (stopped = true) };
		if (queryId) running.set(queryId, pending);
		let opened: { target: SqliteWriteTarget; backup?: SqliteQueryWrite['backup'] };
		try {
			opened = await open();
		} finally {
			if (queryId && running.get(queryId) === pending) running.delete(queryId);
		}
		if (stopped) throw new Error(SQLITE_WRITE_STOPPED_MESSAGE);

		// No await from the gate to here: the grant is still live.
		const run = startSqliteWorkerTask(
			database,
			{
				kind: 'query',
				task: { ...task, writeTarget: opened.target, ...(dryRun ? { dryRun: true } : {}) },
			},
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
		// From here the statement reaches the file: a write is logged, done or failed.
		const logWrite = (outcome: SqliteStatementLogOutcome) =>
			logSqliteStatement(database.displayPath, {
				kind: 'query',
				sql: task.sql,
				params: sqliteStatementParameterValues(task.sql, task.params),
				table: null,
				transactionId: null,
				at: Date.now(),
				outcome,
				...sqliteLoggedBackup(opened.backup),
			});
		try {
			const result = await tracked(queryId, run, SQLITE_WRITE_STOPPED_MESSAGE);
			if (dryRun) return result;
			const write = result.write ?? { changes: 0, otherChanges: 0, schemaChanges: [] };
			await logWrite(sqliteLoggedChanges(write.changes, write.otherChanges, write.schemaChanges));
			return { ...result, write: opened.backup ? { ...write, backup: opened.backup } : write };
		} catch (error) {
			// A dry run changed nothing, and a refusal never ran: neither is logged.
			const refusedRun = (error as { code?: unknown } | null)?.code === SQLITE_QUERY_REFUSED;
			if (!dryRun && !refusedRun) {
				await logWrite(sqliteLoggedFailure(describeSqliteBusy(error, 'write')));
			}
			throw error;
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
