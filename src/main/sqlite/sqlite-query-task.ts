/**
 * The body of one Query-mode run: open the file on a connection of its own,
 * prove the statement is read-only, and read one window of its result. With
 * the tab's editing unlock on, a statement that changes the database runs
 * instead through `runSqliteWriteTask()`, once main has passed the write gate
 * and taken the backup; the read-only layers below hold for every other run.
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
 *      SQLite calls them read-only, but they open other files. With editing
 *      on, the editing rules apply instead (`sqliteEditingQueryRefusal()`),
 *      which still refuse ATTACH and DETACH.
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

import {
	classifySqliteStatement,
	sqliteDryRunTried,
	sqliteDryRunUntransactedMessage,
	sqliteSchemaChanges,
	type SqliteSchemaEntry,
} from '../../shared/sqlite/dryRun';
import { SQLITE_REGEXP_FUNCTION, sqliteRegexpTest } from '../../shared/sqlite/filter';
import {
	SQLITE_NOT_READ_ONLY_MESSAGE,
	SQLITE_ONE_STATEMENT_MESSAGE,
	SQLITE_QUERY_MAX_LIMIT,
	SQLITE_WRITE_RERUN_MESSAGE,
	isSqliteUntransactedStatement,
	sqliteEditingQueryRefusal,
	sqliteLeadingKeyword,
	sqliteQueryBinding,
	sqliteQueryRefusal,
	sqliteStatementToRun,
	type SqliteRunOptions,
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
import {
	openReadOnlySqliteConnection,
	openWritableSqliteTarget,
	type SqliteWriteTarget,
} from './sqlite-connection';

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
	/**
	 * The tab's editing unlock is on and main sent this run down the read
	 * path: judge the text by the editing rules (`sqliteQueryRefusal()`), and
	 * let an EXPLAIN of a write through (it explains, never runs, and the
	 * connection is read-only anyway).
	 */
	editing?: boolean;
	/**
	 * Main passed the write gate and took the backup for this run
	 * (`beginSqliteWorkerWrite()`): run the statement on a writable
	 * connection to this file, once, in a transaction of its own. See
	 * `runSqliteWriteTask()`.
	 */
	writeTarget?: SqliteWriteTarget;
	/**
	 * With `writeTarget`: a dry run. Main passed the write gate WITHOUT the
	 * backup (`beginSqliteWorkerTrial()`), because this run never commits:
	 * `runSqliteWriteTask()` always rolls it back.
	 */
	dryRun?: boolean;
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
	options: SqliteRunOptions
): { db: Database.Database; statement: Database.Statement; args: readonly unknown[] } {
	const refusal = sqliteQueryRefusal(task.sql, options);
	if (refusal) throw refuse(refusal);
	const binding = sqliteQueryBinding(task.sql, task.params);
	if (binding.problem !== null) throw refuse(binding.problem);

	const plan = options.plan === true;
	// With editing on, an EXPLAIN of a write may show: it never runs the write.
	const explains = plan || sqliteLeadingKeyword(task.sql) === 'EXPLAIN';
	const db = openReadOnlySqliteConnection(task.filePath);
	try {
		// The table view's filter speaks REGEXP through this; a query may too.
		db.function(SQLITE_REGEXP_FUNCTION, { deterministic: true }, sqliteRegexpTest);
		const statement = prepareOne(db, task.sql, { plan });
		if (!statement.readonly && !(options.editing && explains)) {
			throw refuse(SQLITE_NOT_READ_ONLY_MESSAGE);
		}
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
	if (task.writeTarget) return runSqliteWriteTask(task, task.writeTarget);
	const options = { plan: task.plan === true, editing: task.editing === true };
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

/** `changes()` and `total_changes()` on this connection, as plain numbers. */
function changeCounts(db: Database.Database): { changes: number; total: number } {
	const [changes, total] = db.prepare('SELECT changes(), total_changes()').raw().get() as [
		number,
		number,
	];
	return { changes: Number(changes), total: Number(total) };
}

/** Every object in the file's schema, as a dry run compares it before and after its trial. */
function readSchemaEntries(db: Database.Database): SqliteSchemaEntry[] {
	return db.prepare('SELECT type, name, sql FROM main.sqlite_master').all() as SqliteSchemaEntry[];
}

/**
 * Run one statement that changes the database, with the editing unlock's
 * write gate and backup already passed in main (`beginSqliteWorkerWrite()`):
 *
 *   - Refused by text as main refuses it (`sqliteEditingQueryRefusal()`:
 *     ATTACH, DETACH, VACUUM INTO, transaction control), and for any window
 *     past the first: a later window would re-run the statement and make the
 *     change twice (`SQLITE_WRITE_RERUN_MESSAGE`).
 *   - Opened through `openWritableSqliteTarget()`, which refuses a path that
 *     names another file now, with every guard of the handle's writable
 *     connection (`trusted_schema = OFF`, `foreign_keys = ON`, the busy wait).
 *   - One statement per `prepare()`, its parameters bound by the driver.
 *   - Run ONCE, in `BEGIN IMMEDIATE` ... `COMMIT` (the write lock taken up
 *     front, so a busy file waits and then fails before anything changes),
 *     rolled back on any error. VACUUM and PRAGMA run bare
 *     (`SQLITE_UNTRANSACTED_KEYWORDS`). A child killed mid-statement (Stop,
 *     the timeout, Lock) leaves a transaction SQLite rolls back on the next
 *     open.
 *   - A statement that returns rows (`RETURNING`, a PRAGMA's answer) returns
 *     its first `limit` of them; SQLite makes every change on the first step,
 *     so stopping early never stops the write.
 *
 * The result carries `write`: rows the statement changed (`changes()`, 0 for
 * a schema change) and rows its triggers and foreign-key actions changed
 * (`total_changes()` beyond that), counted on this connection, which is the
 * run's alone. SQLite's own errors (a constraint, a missing table) pass
 * through verbatim.
 *
 * With `task.dryRun` (main passed the gate without the backup,
 * `beginSqliteWorkerTrial()`), the same run is a TRIAL: a statement SQLite
 * runs outside any transaction is refused, the schema is read before and
 * after the statement inside the transaction, and the transaction is ALWAYS
 * rolled back, success or failure. The result carries `dryRun` (the
 * statement's kind, the counts, the schema changes) instead of `write`. A
 * deferred foreign key the statement breaks is not seen: SQLite checks those
 * only at COMMIT, which a trial never reaches.
 */
export function runSqliteWriteTask(
	task: SqliteQueryTask,
	target: SqliteWriteTarget
): SqliteQueryResult {
	// Main never sends a plan here: an EXPLAIN reads, so it runs read-only.
	const refusal = task.plan ? SQLITE_NOT_READ_ONLY_MESSAGE : sqliteEditingQueryRefusal(task.sql);
	if (refusal) throw refuse(refusal);
	if (task.offset !== 0) throw refuse(SQLITE_WRITE_RERUN_MESSAGE);
	const binding = sqliteQueryBinding(task.sql, task.params);
	if (binding.problem !== null) throw refuse(binding.problem);
	const limit = Math.min(task.limit, SQLITE_QUERY_MAX_LIMIT);
	const keyword = sqliteLeadingKeyword(task.sql);
	const dryRun = task.dryRun === true;
	const transaction = !isSqliteUntransactedStatement(task.sql);
	// Nothing to roll back: main says so without starting a trial; this is the backstop.
	if (dryRun && !transaction) throw refuse(sqliteDryRunUntransactedMessage(keyword));

	const db = openWritableSqliteTarget(target);
	try {
		db.function(SQLITE_REGEXP_FUNCTION, { deterministic: true }, sqliteRegexpTest);
		const statement = prepareOne(db, task.sql, { plan: false });
		const before = changeCounts(db).total;
		const started = performance.now();
		if (transaction) db.exec('BEGIN IMMEDIATE');
		try {
			const schemaBefore = dryRun ? readSchemaEntries(db) : [];
			let columns: SqliteResultColumn[] = [];
			let window: { rows: SqliteQueryResult['rows']; hasMore: boolean } = {
				rows: [],
				hasMore: false,
			};
			if (statement.reader) {
				columns = statement
					.columns()
					.map((column) => ({ name: column.name, declaredType: column.type }));
				statement.raw(true).safeIntegers(true);
				window = readWindow(statement, binding.args, 0, limit);
			} else {
				statement.run(...binding.args);
			}
			const { changes, total } = changeCounts(db);
			const otherChanges = Math.max(0, total - before - changes);
			const base = {
				statement: keyword,
				columns,
				rows: window.rows,
				offset: 0,
				hasMore: window.hasMore,
				returnsRows: statement.reader,
			};
			if (dryRun) {
				const schemaChanges = sqliteSchemaChanges(schemaBefore, readSchemaEntries(db));
				db.exec('ROLLBACK');
				return {
					...base,
					elapsedMs: Math.round(performance.now() - started),
					// This path runs only what main found SQLite would write.
					dryRun: sqliteDryRunTried(classifySqliteStatement(task.sql, true), {
						changes,
						otherChanges,
						schemaChanges,
					}),
				};
			}
			if (transaction) db.exec('COMMIT');
			return {
				...base,
				elapsedMs: Math.round(performance.now() - started),
				write: { changes, otherChanges },
			};
		} catch (error) {
			if (transaction && db.inTransaction) db.exec('ROLLBACK');
			throw error;
		}
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
