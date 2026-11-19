/**
 * The body of one Query-mode run: open the file on a connection of its own,
 * prove the statement is read-only, and read one window of its result.
 *
 * Runs in the SQLite child process (sqlite-worker.ts), which main kills on a
 * timeout or a Stop, because SQL a person writes can run for ever (an
 * unbounded `WITH RECURSIVE`) and better-sqlite3 cannot interrupt a
 * statement. Read-only by construction, on four independent layers:
 *
 *   1. The connection is opened by `openReadOnlySqliteConnection()`, exactly
 *      as the viewer's is: `readonly`, never created, `trusted_schema = OFF`.
 *      A write fails at the driver whatever reaches it.
 *   2. The leading keyword must be SELECT, WITH, PRAGMA, EXPLAIN, or VALUES
 *      (`sqliteReadOnlyRefusal()`), which is what refuses ATTACH and DETACH:
 *      SQLite calls them read-only, but they open other files.
 *   3. `prepare()` takes one statement, so `SELECT 1; DELETE ...` never runs.
 *   4. `stmt.readonly` must be true, which catches a write behind a read
 *      keyword (`WITH x AS (...) DELETE ...`, `PRAGMA user_version = 2`).
 *
 * Parameters (`?`, `:id`) are bound by the driver from `task.params`
 * (`sqliteQueryBinding()`); a value is never spliced into the text, and a
 * parameter with no usable value is refused before the file is opened.
 *
 * The connection is the run's alone and is closed when the run ends, so a
 * PRAGMA that sets a connection-only value (`PRAGMA trusted_schema = ON`)
 * dies with it and never reaches the viewer's own connection.
 *
 * A window past the first re-runs the statement and skips the rows before
 * it, rather than holding the statement open between calls: an open read
 * would hold a lock on someone's live database for as long as the grid sat
 * there.
 *
 * Nothing here, or reachable from here, may import `electron`.
 */

import { performance } from 'perf_hooks';

import type Database from 'better-sqlite3';

import { SQLITE_REGEXP_FUNCTION, sqliteRegexpTest } from '../../shared/sqlite/filter';
import {
	SQLITE_NOT_READ_ONLY_MESSAGE,
	SQLITE_ONE_STATEMENT_MESSAGE,
	SQLITE_QUERY_MAX_LIMIT,
	sqliteLeadingKeyword,
	sqliteQueryBinding,
	sqliteReadOnlyRefusal,
} from '../../shared/sqlite/query';
import type {
	SqliteParameterValues,
	SqliteQueryResult,
	SqliteResultColumn,
} from '../../shared/sqlite/types';
import { sqliteCellFromValue } from './sqlite-cell';
import { openReadOnlySqliteConnection } from './sqlite-connection';

/** What one run's thread is handed. Bounds are already checked by the caller. */
export interface SqliteQueryTask {
	filePath: string;
	sql: string;
	offset: number;
	limit: number;
	/** Values for the statement's parameters, keyed by label. */
	params?: SqliteParameterValues;
}

/** better-sqlite3's wording when the text holds a second statement. */
const MULTIPLE_STATEMENTS = /more than one statement/i;

/** A refusal raised before SQLite ran anything, so callers can tell it from a SQLite error. */
export const SQLITE_QUERY_REFUSED = 'SQLITE_QUERY_REFUSED';

function refuse(message: string): Error {
	return Object.assign(new Error(message), { code: SQLITE_QUERY_REFUSED });
}

function prepareOne(db: Database.Database, sql: string): Database.Statement {
	try {
		return db.prepare(sql);
	} catch (error) {
		if (error instanceof Error && MULTIPLE_STATEMENTS.test(error.message)) {
			throw refuse(SQLITE_ONE_STATEMENT_MESSAGE);
		}
		throw error;
	}
}

/**
 * Run one read-only statement and return the window of its result at
 * `offset`. Throws a refusal (`code: SQLITE_QUERY_REFUSED`) for a statement
 * that is not read-only, and SQLite's own error, verbatim, for one that fails.
 */
export function runSqliteQueryTask(task: SqliteQueryTask): SqliteQueryResult {
	const refusal = sqliteReadOnlyRefusal(task.sql);
	if (refusal) throw refuse(refusal);
	const binding = sqliteQueryBinding(task.sql, task.params);
	if (binding.problem !== null) throw refuse(binding.problem);
	const limit = Math.min(task.limit, SQLITE_QUERY_MAX_LIMIT);

	const db = openReadOnlySqliteConnection(task.filePath);
	try {
		// The table view's filter speaks REGEXP through this; a query may too.
		db.function(SQLITE_REGEXP_FUNCTION, { deterministic: true }, sqliteRegexpTest);
		const statement = prepareOne(db, task.sql.trim());
		if (!statement.readonly) throw refuse(SQLITE_NOT_READ_ONLY_MESSAGE);

		const base = {
			statement: sqliteLeadingKeyword(task.sql),
			offset: task.offset,
		};
		const started = performance.now();
		if (!statement.reader) {
			// A PRAGMA that sets a value on this connection, which closes below.
			statement.run(...binding.args);
			return {
				...base,
				columns: [],
				rows: [],
				hasMore: false,
				returnsRows: false,
				elapsedMs: Math.round(performance.now() - started),
			};
		}

		const columns: SqliteResultColumn[] = statement
			.columns()
			.map((column) => ({ name: column.name, declaredType: column.type }));
		statement.raw(true).safeIntegers(true);
		const { rows, hasMore } = readWindow(statement, binding.args, task.offset, limit);
		return {
			...base,
			columns,
			rows,
			hasMore,
			returnsRows: true,
			elapsedMs: Math.round(performance.now() - started),
		};
	} finally {
		db.close();
	}
}

/**
 * Skip `offset` result rows, keep `limit`, and look one past them to learn
 * whether more follow. The iterator is closed as soon as that is known, so
 * SQLite stops producing rows nobody will see.
 */
function readWindow(
	statement: Database.Statement,
	args: readonly unknown[],
	offset: number,
	limit: number
) {
	const rows: SqliteQueryResult['rows'] = [];
	let position = 0;
	let hasMore = false;
	const iterator = statement.iterate(...args) as IterableIterator<unknown[]>;
	try {
		for (const row of iterator) {
			if (position++ < offset) continue;
			if (rows.length === limit) {
				hasMore = true;
				break;
			}
			rows.push(row.map(sqliteCellFromValue));
		}
	} finally {
		iterator.return?.();
	}
	return { rows, hasMore };
}
