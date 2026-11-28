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
 * An explicit transaction (`openSqliteTransactionTask()`, Query mode's Begin
 * transaction) is the one task that outlives a request: its child holds
 * `BEGIN IMMEDIATE` on a writable connection and runs statement after
 * statement in it, reads included, until Commit or Roll back. It shares the
 * write run's body (`runPrepared()`, `changesSince()`), so a statement counts
 * the same inside a transaction as alone.
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
import { SQLITE_TRANSACTION_GONE_MESSAGE } from '../../shared/sqlite/transaction';
import {
	SQLITE_NOT_READ_ONLY_MESSAGE,
	SQLITE_ONE_STATEMENT_MESSAGE,
	SQLITE_QUERY_MAX_LIMIT,
	SQLITE_WRITE_RERUN_MESSAGE,
	isSqliteUntransactedStatement,
	isSqliteWriteStatement,
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
	SqliteQueryWrite,
	SqliteResultColumn,
	SqliteSchemaChange,
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
		// A statement that is not a reader is a PRAGMA that sets a value on
		// this connection, which closes below.
		const output = runPrepared(statement, args, task.offset, limit);
		return {
			...base,
			...output,
			returnsRows: statement.reader,
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

/**
 * Rows the statement just run changed itself, and rows its triggers and
 * foreign-key actions changed beside them, from `total_changes()` taken just
 * before it. `changes()` keeps the last INSERT, UPDATE, or DELETE's count
 * through any later statement that is not one (a CREATE, a SELECT), so on a
 * connection that ran other statements first (an open transaction) it is
 * capped at what this statement moved in total.
 */
function changesSince(
	db: Database.Database,
	before: number
): Pick<SqliteQueryWrite, 'changes' | 'otherChanges'> {
	const { changes, total } = changeCounts(db);
	const moved = Math.max(0, total - before);
	const own = Math.min(changes, moved);
	return { changes: own, otherChanges: moved - own };
}

/**
 * Run a prepared statement once: a reader's window of rows at `offset`
 * (its columns, the rows, whether more follow), or, for a statement that
 * returns none, just run.
 */
function runPrepared(
	statement: Database.Statement,
	args: readonly unknown[],
	offset: number,
	limit: number
): Pick<SqliteQueryResult, 'columns' | 'rows' | 'hasMore'> {
	if (!statement.reader) {
		statement.run(...args);
		return { columns: [], rows: [], hasMore: false };
	}
	const columns: SqliteResultColumn[] = statement
		.columns()
		.map((column) => ({ name: column.name, declaredType: column.type }));
	statement.raw(true).safeIntegers(true);
	return { columns, ...readWindow(statement, args, offset, limit) };
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
 * a schema change), rows its triggers and foreign-key actions changed
 * (`total_changes()` beyond that), counted on this connection, which is the
 * run's alone, and the schema objects it created, dropped, or altered
 * (`sqlite_schema` read before and after it, inside its transaction), so the
 * viewer knows to read its object list again. SQLite's own errors (a
 * constraint, a missing table) pass through verbatim.
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
			const schemaBefore = readSchemaEntries(db);
			const output = runPrepared(statement, binding.args, 0, limit);
			const { changes, otherChanges } = changesSince(db, before);
			const schemaChanges = sqliteSchemaChanges(schemaBefore, readSchemaEntries(db));
			const base = {
				statement: keyword,
				...output,
				offset: 0,
				returnsRows: statement.reader,
			};
			if (dryRun) {
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
				write: { changes, otherChanges, schemaChanges },
			};
		} catch (error) {
			if (transaction && db.inTransaction) db.exec('ROLLBACK');
			throw error;
		}
	} finally {
		db.close();
	}
}

/** What an explicit transaction's child is handed when it starts. */
export interface SqliteTransactionTask {
	/** The file to open writable, from `beginSqliteWorkerWrite()` (gate and backup passed). */
	target: SqliteWriteTarget;
}

/** One statement run inside the open transaction. Bounds are already checked by the caller. */
export interface SqliteTransactionRunTask {
	sql: string;
	offset: number;
	limit: number;
	params?: SqliteParameterValues;
	plan?: boolean;
}

/** One request to an open transaction's child. */
export type SqliteTransactionOp =
	| { op: 'run'; task: SqliteTransactionRunTask }
	| { op: 'commit' }
	| { op: 'rollback' };

/** What the transaction holds so far, sent with every reply. */
export interface SqliteTransactionTotals {
	statements: number;
	changes: number;
	otherChanges: number;
	schemaChanges: SqliteSchemaChange[];
}

/** The child's answer to one request: a run's result and counts, or the totals an end left. */
export interface SqliteTransactionReply {
	totals: SqliteTransactionTotals;
	/** For a run: one window of its result (main adds `inTransaction`). */
	result?: SqliteQueryResult;
	/** For a run: SQLite says it changes the database. */
	writes?: boolean;
	/** For a run: rows it changed itself, and beside it. */
	changes?: number;
	otherChanges?: number;
	/** For a run that writes: schema objects this statement alone created, dropped, or altered (the statement log's entry). */
	schemaChanges?: SqliteSchemaChange[];
}

/**
 * A conversation with one SQLite child process that outlives one request
 * (see `startSqliteWorkerSession()`): it answers each request in turn until
 * it is `closed`, then the child exits.
 */
export interface SqliteWorkerSessionHost<Op, R> {
	/** Answer one request. A throw is the reply's error; `closed` may have turned true either way. */
	handle(op: Op): R;
	/** The session is over: no further request is answered. */
	readonly closed: boolean;
	/** End it now with no reply: its parent went away or stopped it. Never throws. */
	abort(): void;
}

/**
 * Begin an explicit transaction (Query mode's Begin transaction) on the file
 * main passed the write gate and took the backup for, and keep it open:
 * `BEGIN IMMEDIATE` takes the write lock up front, so a busy file waits and
 * then fails before anything is held. The schema is read at the start, so
 * every reply can say what the transaction created, dropped, or altered.
 *
 * Each `run` is one statement, read or write, on this connection, inside the
 * transaction, by the same text rules as a write run
 * (`sqliteEditingQueryRefusal()`: ATTACH, DETACH, VACUUM INTO, and typed
 * transaction control stay refused), its parameters bound by the driver, one
 * statement per `prepare()`. A write runs once (a later window is refused,
 * `SQLITE_WRITE_RERUN_MESSAGE`); a read's later window reads inside the
 * transaction again. A statement SQLite refuses (a constraint) is undone on
 * its own and the transaction stays open, unless SQLite rolled the whole
 * transaction back (`INSERT OR ROLLBACK`, a trigger's `RAISE(ROLLBACK)`, a
 * full disk), which closes the session.
 *
 * `commit` ends it with `COMMIT`; when that fails (a deferred foreign key, a
 * busy file) and SQLite kept the transaction, it stays open for another try
 * or a Roll back. `rollback` ends it with `ROLLBACK`. Closing the connection
 * (`abort()`, or the child killed) rolls back too: SQLite never commits a
 * transaction nobody committed.
 */
export function openSqliteTransactionTask(task: SqliteTransactionTask): {
	opened: SqliteTransactionTotals;
	host: SqliteWorkerSessionHost<SqliteTransactionOp, SqliteTransactionReply>;
} {
	const db = openWritableSqliteTarget(task.target);
	let closed = false;
	const totals: SqliteTransactionTotals = {
		statements: 0,
		changes: 0,
		otherChanges: 0,
		schemaChanges: [],
	};
	// Closing the connection rolls back whatever it still holds.
	const finish = () => {
		if (closed) return;
		closed = true;
		db.close();
	};
	let schemaAtBegin: SqliteSchemaEntry[];
	try {
		db.function(SQLITE_REGEXP_FUNCTION, { deterministic: true }, sqliteRegexpTest);
		db.exec('BEGIN IMMEDIATE');
		schemaAtBegin = readSchemaEntries(db);
	} catch (error) {
		finish();
		throw error;
	}
	const snapshot = (): SqliteTransactionTotals => ({
		...totals,
		schemaChanges: [...totals.schemaChanges],
	});

	const run = (runTask: SqliteTransactionRunTask): SqliteTransactionReply => {
		const plan = runTask.plan === true;
		const refusal = sqliteEditingQueryRefusal(runTask.sql, { plan });
		if (refusal) throw refuse(refusal);
		const binding = sqliteQueryBinding(runTask.sql, runTask.params);
		if (binding.problem !== null) throw refuse(binding.problem);
		const statement = prepareOne(db, runTask.sql, { plan });
		const writes = !plan && isSqliteWriteStatement(runTask.sql, statement.readonly);
		if (writes && runTask.offset !== 0) throw refuse(SQLITE_WRITE_RERUN_MESSAGE);
		const limit = Math.min(runTask.limit, SQLITE_QUERY_MAX_LIMIT);
		const before = changeCounts(db).total;
		const schemaBefore = writes ? readSchemaEntries(db) : null;
		const started = performance.now();
		let output: Pick<SqliteQueryResult, 'columns' | 'rows' | 'hasMore'>;
		try {
			output = runPrepared(statement, binding.args, runTask.offset, limit);
		} catch (error) {
			// SQLite undid this statement alone, or the whole transaction.
			if (!db.inTransaction) finish();
			throw error;
		}
		const elapsedMs = Math.round(performance.now() - started);
		const { changes, otherChanges } = writes ? changesSince(db, before) : NO_CHANGES;
		totals.statements += 1;
		totals.changes += changes;
		totals.otherChanges += otherChanges;
		const schemaAfter = writes ? readSchemaEntries(db) : null;
		if (schemaAfter) totals.schemaChanges = sqliteSchemaChanges(schemaAtBegin, schemaAfter);
		return {
			totals: snapshot(),
			result: {
				statement: sqliteLeadingKeyword(runTask.sql),
				...(plan ? { plan: true } : {}),
				...output,
				offset: runTask.offset,
				returnsRows: statement.reader,
				elapsedMs,
			},
			writes,
			changes,
			otherChanges,
			...(schemaBefore && schemaAfter
				? { schemaChanges: sqliteSchemaChanges(schemaBefore, schemaAfter) }
				: {}),
		};
	};

	return {
		opened: snapshot(),
		host: {
			get closed() {
				return closed;
			},
			handle(op) {
				if (closed) throw refuse(SQLITE_TRANSACTION_GONE_MESSAGE);
				if (op.op === 'run') return run(op.task);
				if (op.op === 'commit') {
					try {
						db.exec('COMMIT');
					} catch (error) {
						// A deferred foreign key or a busy file: SQLite keeps the transaction.
						if (!db.inTransaction) finish();
						throw error;
					}
					finish();
					return { totals: snapshot() };
				}
				try {
					if (db.inTransaction) db.exec('ROLLBACK');
				} finally {
					finish();
				}
				return { totals: snapshot() };
			},
			abort: finish,
		},
	};
}

const NO_CHANGES = { changes: 0, otherChanges: 0 } as const;

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
