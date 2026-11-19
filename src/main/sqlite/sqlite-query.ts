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
	sqliteExportTimeoutMessage,
	sqliteQueryTimeoutMessage,
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
import { getSqliteDatabase } from './sqlite-database';
import { getSqliteQueryHistory } from './sqlite-query-history';
import { SQLITE_QUERY_REFUSED } from './sqlite-query-task';
import { windowBound } from './sqlite-rows';
import { startSqliteWorkerTask, type SqliteWorkerRun } from './sqlite-worker-runner';

/** Runs and exports that can be stopped by id, with the words a stop rejects them with. */
const running = new Map<string, { run: SqliteWorkerRun<unknown>; stoppedMessage: string }>();

/** Stop whatever runs under `queryId`, in its own words. */
function stopRunning(queryId: string): boolean {
	const entry = running.get(queryId);
	if (!entry) return false;
	running.delete(queryId);
	entry.run.stop(entry.stoppedMessage);
	return true;
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
	running.set(queryId, { run, stoppedMessage });
	return run.result.finally(() => {
		if (running.get(queryId)?.run === run) running.delete(queryId);
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

	const run = startSqliteWorkerTask(
		database,
		{
			kind: 'query',
			task: {
				filePath: database.displayPath,
				sql: request.sql,
				offset,
				limit,
				params: request.params ?? undefined,
				plan: request.plan === true,
			},
		},
		{
			closedMessage: `${SQLITE_QUERY_STOPPED_MESSAGE} The database was closed.`,
			timeoutMs: SQLITE_QUERY_TIMEOUT_MS,
			timeoutMessage: sqliteQueryTimeoutMessage(),
			label: 'The query',
		}
	);
	// Restated before the history records it, so the rail says the same.
	const result = reportSqliteBusy('read', () =>
		tracked(queryId, run, SQLITE_QUERY_STOPPED_MESSAGE)
	);
	return offset === 0 ? recordedRun(database.displayPath, request, result) : result;
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
