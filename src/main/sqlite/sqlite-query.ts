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
 */

import {
	SQLITE_QUERY_PAGE_ROWS,
	SQLITE_QUERY_MAX_LIMIT,
	SQLITE_QUERY_STOPPED_MESSAGE,
	SQLITE_QUERY_TIMEOUT_MS,
	sqliteQueryTimeoutMessage,
} from '../../shared/sqlite/query';
import type { SqliteQueryRequest, SqliteQueryResult } from '../../shared/sqlite/types';
import { getSqliteDatabase } from './sqlite-database';
import { windowBound } from './sqlite-rows';
import { startSqliteWorkerTask, type SqliteWorkerRun } from './sqlite-worker-runner';

/** Runs that can be stopped by id. */
const running = new Map<string, SqliteWorkerRun<SqliteQueryResult>>();

/**
 * Run one read-only statement and return the window of its result at
 * `offset`, its parameters bound from `request.params`. Rejects with a
 * refusal for a statement that is not read-only or a parameter with no
 * usable value, with SQLite's own message for one that fails, and with
 * `SQLITE_QUERY_STOPPED_MESSAGE` or the timeout message for one stopped.
 */
export function runSqliteQuery(request: SqliteQueryRequest): Promise<SqliteQueryResult> {
	if (typeof request.sql !== 'string') {
		return Promise.reject(new Error('SQLite query sql must be a string.'));
	}
	if (
		request.params != null &&
		(typeof request.params !== 'object' || Array.isArray(request.params))
	) {
		return Promise.reject(new Error('SQLite query params must be an object keyed by parameter.'));
	}
	const database = getSqliteDatabase(request.handle);
	const offset = windowBound(request.offset ?? 0, 'offset');
	const limit = Math.min(
		windowBound(request.limit ?? SQLITE_QUERY_PAGE_ROWS, 'limit'),
		SQLITE_QUERY_MAX_LIMIT
	);

	const queryId = request.queryId ?? null;
	if (queryId) running.get(queryId)?.stop(SQLITE_QUERY_STOPPED_MESSAGE);

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
			},
		},
		{
			closedMessage: `${SQLITE_QUERY_STOPPED_MESSAGE} The database was closed.`,
			timeoutMs: SQLITE_QUERY_TIMEOUT_MS,
			timeoutMessage: sqliteQueryTimeoutMessage(),
			label: 'The query',
		}
	);
	if (!queryId) return run.result;
	running.set(queryId, run);
	return run.result.finally(() => {
		if (running.get(queryId) === run) running.delete(queryId);
	});
}

/** Stop the run going under `queryId`. Returns whether one was running. */
export function cancelSqliteQuery(queryId: string): boolean {
	const run = running.get(queryId);
	if (!run) return false;
	run.stop(SQLITE_QUERY_STOPPED_MESSAGE);
	running.delete(queryId);
	return true;
}
