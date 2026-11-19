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
 * With `task.plan` the statement runs behind `EXPLAIN QUERY PLAN`
 * (`sqliteStatementToRun()`): the rows are its plan and none of its own rows
 * are read. Every layer above still applies, to the statement as written
 * (layer 2) and to the EXPLAIN (layers 1, 3, 4: SQLite marks the plan of a
 * write as not read-only, so it is refused like the write).
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
 * An export (`exportSqliteQueryTask()`, Query mode's Export) runs the same
 * statement behind the same layers and writes EVERY row to a file as CSV or
 * JSON Lines (`createTabularRowEncoder()`, shared with the Parquet export),
 * whole: no cell is cut, an INTEGER keeps every digit, a BLOB is written as
 * lowercase hex. The rows go from SQLite to the file inside this process, so
 * an export of millions of rows never crosses IPC or sits in memory.
 *
 * Nothing here, or reachable from here, may import `electron`.
 */

import { closeSync, fstatSync, openSync, writeSync } from 'fs';
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
	sqliteStatementToRun,
} from '../../shared/sqlite/query';
import type {
	SqliteParameterValues,
	SqliteQueryExported,
	SqliteQueryResult,
	SqliteResultColumn,
} from '../../shared/sqlite/types';
import { sqliteSyntaxErrorOffset } from '../../shared/sqlite/queryError';
import { createTabularRowEncoder, type TabularExportFormat } from '../../shared/tabularExport';
import { sqliteCellFromValue, sqliteExportValue } from './sqlite-cell';
import { openReadOnlySqliteConnection } from './sqlite-connection';

/** What one run's thread is handed. Bounds are already checked by the caller. */
export interface SqliteQueryTask {
	filePath: string;
	sql: string;
	offset: number;
	limit: number;
	/** Values for the statement's parameters, keyed by label. */
	params?: SqliteParameterValues;
	/** Run the statement's `EXPLAIN QUERY PLAN` instead of the statement. */
	plan?: boolean;
}

/** What one export's process is handed. The caller picks `destPath` (a temporary file) and renames it. */
export interface SqliteQueryExportTask {
	filePath: string;
	sql: string;
	params?: SqliteParameterValues;
	destPath: string;
	format: TabularExportFormat;
}

/** An export's statement sets a value and returns no rows, so there is nothing to write. */
export const SQLITE_EXPORT_NO_ROWS_MESSAGE =
	'This statement returns no rows, so there is nothing to export.';

/** Rows of encoded text gathered before one write to the file. */
const EXPORT_CHUNK_CHARS = 256 * 1024;

/** better-sqlite3's wording when the text holds a second statement. */
const MULTIPLE_STATEMENTS = /more than one statement/i;

/** A refusal raised before SQLite ran anything, so callers can tell it from a SQLite error. */
export const SQLITE_QUERY_REFUSED = 'SQLITE_QUERY_REFUSED';

function refuse(message: string): Error {
	return Object.assign(new Error(message), { code: SQLITE_QUERY_REFUSED });
}

/** SQLite's words when a text has a syntax error in it so far, rather than ending early. */
const SYNTAX_FAILURE = /syntax error|unrecognized token/;

/**
 * Whether the text before some point holds no syntax error yet: it prepares,
 * ends too soon (`incomplete input`), holds nothing, or fails for a reason
 * other than syntax (a missing table). A prepare runs nothing, and this
 * connection is the run's alone.
 */
function parsesSoFar(db: Database.Database, prefix: string): boolean {
	try {
		db.prepare(prefix);
		return true;
	} catch (error) {
		return !(error instanceof Error && SYNTAX_FAILURE.test(error.message));
	}
}

/**
 * Prepare the statement a run runs (`sqliteStatementToRun()`). A second
 * statement in the text is refused; a syntax error is rethrown with
 * `offset`, where in `sql` (the text as written) SQLite stopped, found by
 * asking SQLite itself (`sqliteSyntaxErrorOffset()`), since the driver does
 * not report it and the token it names may appear more than once.
 */
function prepareOne(
	db: Database.Database,
	sql: string,
	options: { plan: boolean }
): Database.Statement {
	try {
		return db.prepare(sqliteStatementToRun(sql, options));
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		if (MULTIPLE_STATEMENTS.test(error.message)) throw refuse(SQLITE_ONE_STATEMENT_MESSAGE);
		const offset = sqliteSyntaxErrorOffset(sql, error.message, (prefix) => parsesSoFar(db, prefix));
		throw offset === null ? error : Object.assign(error, { offset });
	}
}

/**
 * Every read-only layer, then the statement prepared on a connection of its
 * own: refuse a statement that is not read-only or a parameter with no
 * usable value (before the file is opened), open the file read-only,
 * prepare one statement, and refuse it unless the driver calls it
 * read-only. The caller closes `db`; on a throw it is already closed.
 */
function prepareReadOnlyRun(
	task: { filePath: string; sql: string; params?: SqliteParameterValues },
	options: { plan: boolean }
): { db: Database.Database; statement: Database.Statement; args: readonly unknown[] } {
	const refusal = sqliteReadOnlyRefusal(task.sql, options);
	if (refusal) throw refuse(refusal);
	const binding = sqliteQueryBinding(task.sql, task.params);
	if (binding.problem !== null) throw refuse(binding.problem);

	const db = openReadOnlySqliteConnection(task.filePath);
	try {
		// The table view's filter speaks REGEXP through this; a query may too.
		db.function(SQLITE_REGEXP_FUNCTION, { deterministic: true }, sqliteRegexpTest);
		const statement = prepareOne(db, task.sql, options);
		if (!statement.readonly) throw refuse(SQLITE_NOT_READ_ONLY_MESSAGE);
		return { db, statement, args: binding.args };
	} catch (error) {
		db.close();
		throw error;
	}
}

/**
 * Run one read-only statement and return the window of its result at
 * `offset`. Throws a refusal (`code: SQLITE_QUERY_REFUSED`) for a statement
 * that is not read-only, and SQLite's own error, verbatim, for one that fails
 * (a syntax error with the `offset` it points at; see `prepareOne()`).
 */
export function runSqliteQueryTask(task: SqliteQueryTask): SqliteQueryResult {
	const options = { plan: task.plan === true };
	const limit = Math.min(task.limit, SQLITE_QUERY_MAX_LIMIT);
	const { db, statement, args } = prepareReadOnlyRun(task, options);
	try {
		const base = {
			statement: sqliteLeadingKeyword(task.sql),
			...(options.plan ? { plan: true } : {}),
			offset: task.offset,
		};
		const started = performance.now();
		if (!statement.reader) {
			// A PRAGMA that sets a value on this connection, which closes below.
			statement.run(...args);
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
		const { rows, hasMore } = readWindow(statement, args, task.offset, limit);
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
 * Run one read-only statement and write all of its rows to `task.destPath`
 * (replacing what is there), whole. Throws the same refusals and SQLite
 * errors a run does, and `SQLITE_EXPORT_NO_ROWS_MESSAGE` for a statement
 * that returns no rows by design. A failed export may leave a partial file:
 * the caller writes to a temporary path and removes it.
 */
export function exportSqliteQueryTask(task: SqliteQueryExportTask): SqliteQueryExported {
	const { db, statement, args } = prepareReadOnlyRun(task, { plan: false });
	try {
		if (!statement.reader) throw refuse(SQLITE_EXPORT_NO_ROWS_MESSAGE);
		const columns = statement.columns().map((column) => column.name);
		const encoder = createTabularRowEncoder(task.format, columns);
		statement.raw(true).safeIntegers(true);

		const started = performance.now();
		const fd = openSync(task.destPath, 'w');
		try {
			let pending = encoder.header;
			let rows = 0;
			for (const row of statement.iterate(...args) as IterableIterator<unknown[]>) {
				pending += encoder.row(row.map(sqliteExportValue));
				rows++;
				if (pending.length >= EXPORT_CHUNK_CHARS) {
					writeSync(fd, pending);
					pending = '';
				}
			}
			if (pending) writeSync(fd, pending);
			return {
				path: task.destPath,
				format: task.format,
				rows,
				columns: columns.length,
				bytes: fstatSync(fd).size,
				elapsedMs: Math.round(performance.now() - started),
			};
		} finally {
			closeSync(fd);
		}
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
