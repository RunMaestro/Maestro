/**
 * SQLite Row Edit
 *
 * The writes the table view makes to a user's database, one row at a time:
 * a cell, as a parameterised single-row `UPDATE` keyed on the row's identity,
 * a new row as an `INSERT`, and a row removed as a `DELETE` keyed the same
 * way.
 *
 *   UPDATE "t" SET "c" = ? WHERE "rowid" = ? RETURNING "rowid"
 *   UPDATE "t" SET "c" = ? WHERE "a" = ? AND "b" = ? RETURNING "a", "b"
 *   INSERT INTO "t" ("c") VALUES (?) RETURNING "rowid", typeof("c"), "c"
 *   DELETE FROM "t" WHERE "rowid" = ? RETURNING "rowid"
 *
 * An insert keeps the cell edit's rules: values bound by the same rule, each
 * given value read back from `RETURNING` and rolled back when the affinity
 * converted it, the new row read back by its key (a key holding NULL rolls
 * back). A delete removes exactly one row or nothing. Both report
 * `otherChanges`, the rows the database's triggers and foreign-key actions
 * (`ON DELETE CASCADE`, `SET NULL`) changed beside their own, counted with
 * `total_changes()`, so a cascade is never silent. The writable connection
 * enforces foreign keys (sqlite-connection.ts), so a constraint fails with
 * SQLite's words.
 *
 * The rules it keeps (see the invariants in sqlite-editing.ts and
 * sqlite-identity.ts):
 *
 *   - **Gated, backed up.** It writes through `beginSqliteWrite()`, which
 *     passes the tab's editing grant, re-checks that the file can still be
 *     written, and takes this session's backup before the first change.
 *     Everything after that runs synchronously on the writable connection,
 *     before any further `await`, so a grant cannot end halfway through.
 *   - **Identity from main.** Editability is resolved here, never taken from
 *     the renderer: first on the read-only connection, so an edit that is
 *     refused anyway (a view, a virtual table, a table with no way to name a
 *     row, a generated column, a key that does not fit) takes no backup, then
 *     again on the writable connection, which is what the write trusts.
 *   - **Values bound, names quoted.** The new value binds as TEXT, a number,
 *     or NULL (`sqliteParameterBindValue()`); the key binds typed and whole
 *     (`sqliteRowKeyCondition()`), never from a cut cell. A whole number binds
 *     as an INTEGER (better-sqlite3 binds a JS number as a REAL, which a
 *     column with no affinity would keep as `7.0`).
 *   - **Stored as given, or not at all.** The column's affinity may convert
 *     the value on the way in (src/shared/sqlite/affinity.ts): the text
 *     `'007'` into an INTEGER column becomes 7, a number into a TEXT column
 *     becomes text. `RETURNING` reports the column as the `UPDATE` stored it,
 *     and a value that changed rolls back with the reason; so does a number
 *     SQLite cannot hold as written. A value the rowid column cannot take is
 *     refused by name before the backup, not with SQLite's bare "datatype
 *     mismatch".
 *   - **Exactly one row.** The `UPDATE` runs in a transaction, and anything
 *     other than one changed row rolls it back: a row deleted or re-keyed
 *     since it was read changes nothing, and is reported.
 *   - **Never over a change it did not see.** An `UPDATE` or `DELETE` given
 *     the row's version (the one its page showed, sqlite-row-version.ts)
 *     checks it in the same `WHERE` as the key, so a row another tab, another
 *     program, or a trigger changed since the read matches nothing: the write
 *     changes nothing and says the row changed (`sqliteStaleRowMessage()`),
 *     where it would otherwise have overwritten that change. Each result
 *     carries the row's new version, for the next edit to send.
 *   - **The row comes back as stored.** `RETURNING` gives the row's key
 *     after the change, which differs from the old one when the edit wrote a
 *     key column (an `INTEGER PRIMARY KEY` IS the rowid), and the row is read
 *     back by that key, as a window would show it, so the viewer patches its
 *     page in place and keeps naming the row correctly. A change that would
 *     leave the row's key holding NULL is rolled back, since no later edit
 *     could name it.
 *   - **Undoable exactly, or said not to be.** Each write captures its own
 *     inverse inside its transaction and returns it as `undo`
 *     (`SqliteUndoStep`): the cell's old value read whole just before the
 *     `UPDATE`, the inserted row's key and version, every value of the
 *     deleted row (from the `DELETE`'s `RETURNING`, whole) with its rowid.
 *     `undoSqliteEdit()` applies a step through the SAME update, insert, or
 *     delete path (`writeCell()`, `writeRow()`, `removeRow()`), so the gate,
 *     the backup, the version check, and the readback hold for an undo too;
 *     a value put back must be stored exactly as it was. A write whose
 *     triggers or foreign-key actions changed other rows (`otherChanges`)
 *     returns no step, since its own row alone cannot be put back honestly.
 *     Main keeps no undo state: the step travels with the result, so the
 *     viewer and the CLI undo the same way.
 *   - **Logged.** Once its transaction has run, each write (an undo too) is
 *     recorded in the database's statement log (`loggedWrite()`, over
 *     sqlite-statement-log.ts): the single-row statement as a person would
 *     type it, values written in, and what it changed or why it failed. A
 *     write refused before its transaction (no grant, a table that cannot be
 *     edited, the backup) never reached the file and is not logged.
 *
 * SQLite's own failures (a constraint, a STRICT type) reach the caller with
 * SQLite's message. A busy database (another process held the lock past the
 * busy timeout) is the one exception: SQLite's bare "database is locked" is
 * restated as another process having the file open and nothing changed
 * (`reportSqliteBusy()` in sqlite-connection.ts), whichever step it hit: the
 * backup, opening the writable connection, or the statement itself.
 */

import { sqliteRowidValueProblem, sqliteStoredValueProblem } from '../../shared/sqlite/affinity';
import type { SqliteBindValue } from '../../shared/sqlite/filter';
import { sqliteParameterBindValue } from '../../shared/sqlite/query';
import { sqliteColumnAffinity, sqliteStaleRowMessage } from '../../shared/sqlite/schema';
import { quoteSqliteIdentifier } from '../../shared/sqlite/sql';
import {
	sqliteRowWriteStatement,
	type SqliteLogValue,
	type SqliteRowWrite,
} from '../../shared/sqlite/statementLog';
import type {
	SqliteAffinity,
	SqliteBackup,
	SqliteCellUpdateRequest,
	SqliteCellUpdateResult,
	SqliteCellValue,
	SqliteKeyValue,
	SqliteObjectSummary,
	SqliteParameterValue,
	SqliteReadOnlyColumn,
	SqliteResultColumn,
	SqliteRowDeleteRequest,
	SqliteRowDeleteResult,
	SqliteRowIdentity,
	SqliteRowInsertRequest,
	SqliteRowInsertResult,
	SqliteRowKey,
	SqliteStatementLogKind,
	SqliteUndoRequest,
	SqliteUndoResult,
	SqliteUndoStep,
} from '../../shared/sqlite/types';
import type Database from 'better-sqlite3';

import { sqliteKeyValue } from './sqlite-cell';
import { describeSqliteBusy, reportSqliteBusy } from './sqlite-connection';
import { beginSqliteWrite, requireSqliteEditing, type SqliteWriteSession } from './sqlite-editing';
import {
	resolveSqliteEditability,
	sqliteKeyBindValue,
	sqliteRowKeyColumns,
	sqliteRowKeyCondition,
	type SqliteRowKeyCondition,
} from './sqlite-identity';
import { findSqliteObject, readSqliteObjectSummaries } from './sqlite-objects';
import { sqliteRowVersionExpression, sqliteRowVersionParam } from './sqlite-row-version';
import { sqliteRowSelectList, sqliteSelectedRow } from './sqlite-rows';
import {
	logSqliteStatement,
	sqliteLoggedBackup,
	sqliteLoggedChanges,
	sqliteLoggedFailure,
} from './sqlite-statement-log';

function requireText(value: unknown, label: string, what = 'A cell edit'): string {
	if (typeof value !== 'string' || value === '') {
		throw new Error(`${what} needs the ${label}.`);
	}
	return value;
}

/** A table a write may change, checked: found, editable, and its columns. */
interface SqliteEditableTable {
	object: SqliteObjectSummary;
	/** The table's name, quoted. */
	source: string;
	/** `SELECT *`'s columns, as the window reader reads them. */
	columns: SqliteResultColumn[];
	identity: SqliteRowIdentity;
	/** Columns no write may set (generated ones), with the reason. */
	readOnlyColumns: SqliteReadOnlyColumn[];
}

/**
 * The table `name` on this connection, if a write may change its rows.
 * Throws the reason otherwise: no such table, or a view, virtual table,
 * internal table, or table with no way to name a row. Metadata reads only.
 */
function findEditableTable(db: Database.Database, name: string): SqliteEditableTable {
	// A view is found too, so it is refused with its reason, not "no table".
	const objects = readSqliteObjectSummaries(db);
	const object =
		findSqliteObject(objects, name, 'table') ?? findSqliteObject(objects, name, 'view');
	if (!object) throw new Error(`No table is named ${name}.`);
	const editability = resolveSqliteEditability(db, object);
	if (!editability.editable) throw new Error(editability.reason);
	const source = quoteSqliteIdentifier(object.name);
	const columns = db
		.prepare(`SELECT * FROM ${source}`)
		.columns()
		.map((entry) => ({ name: entry.name, declaredType: entry.type }));
	return {
		object,
		source,
		columns,
		identity: editability.identity,
		readOnlyColumns: editability.readOnlyColumns,
	};
}

/**
 * A column a write sets, checked: it exists and is not generated. Returns its
 * affinity, which converts the value on the way in. Throws the reason.
 */
function writableColumnAffinity(table: SqliteEditableTable, column: string): SqliteAffinity {
	const generated = table.readOnlyColumns.find((entry) => entry.name === column);
	if (generated) throw new Error(generated.reason);
	const found = table.columns.find((entry) => entry.name === column);
	if (!found) throw new Error(`${table.object.name} has no column named ${column}.`);
	return sqliteColumnAffinity(found.declaredType ?? '', table.object.strict === true);
}

/**
 * A value as a write binds it, or throws why it cannot bind. A whole number
 * binds as an INTEGER: better-sqlite3 binds every JS number as a REAL, which
 * a column with no affinity would keep as `7.0`.
 */
function sqliteWriteBindValue(label: string, value: SqliteParameterValue): SqliteBindValue {
	const bound = sqliteParameterBindValue(label, value);
	if ('problem' in bound) throw new Error(bound.problem);
	return typeof bound.value === 'number' && /^[+-]?\d+$/.test(value.text.trim())
		? BigInt(bound.value)
		: bound.value;
}

/** A row's key as a statement's `RETURNING` gave it (key columns first, in order). */
function returnedRowKey(identity: SqliteRowIdentity, returned: unknown[]): SqliteRowKey {
	return identity.kind === 'rowid'
		? { kind: 'rowid', rowid: String(returned[0]) }
		: {
				kind: 'primary-key',
				values: Object.fromEntries(
					identity.columns.map((keyColumn, index) => [keyColumn, sqliteKeyValue(returned[index])])
				),
			};
}

/**
 * One row of the table, read by key the way a window reads it (cells cut as
 * a page cuts them) with its version, or undefined when no row has that key.
 */
function readRowByKey(
	db: Database.Database,
	table: SqliteEditableTable,
	condition: SqliteRowKeyCondition
): { cells: SqliteCellValue[]; version: string } | undefined {
	const raw = db
		.prepare(
			`SELECT ${sqliteRowSelectList(table.columns, null, [], true)} FROM ${table.source} WHERE ${condition.where}`
		)
		.raw(true)
		.safeIntegers(true)
		.get(...condition.params) as unknown[] | undefined;
	if (!raw) return undefined;
	const row = sqliteSelectedRow(raw, table.columns.length, null, [], true);
	return { cells: row.cells, version: row.version ?? '' };
}

/**
 * The `WHERE` a write to one existing row runs with: its key, and when the
 * caller sent the version its page showed, that version too, so the check
 * and the write are one statement and a row changed since the read matches
 * nothing (sqlite-row-version.ts).
 */
function rowWriteCondition(
	table: SqliteEditableTable,
	condition: SqliteRowKeyCondition,
	version: string | null
): { where: string; params: unknown[] } {
	if (version === null) return { where: condition.where, params: condition.params };
	const expression = sqliteRowVersionExpression(table.columns.map((entry) => entry.name));
	return {
		where: `${condition.where} AND ${expression} = ?`,
		params: [...condition.params, version],
	};
}

/**
 * Why a write to one existing row matched none: the row is gone (deleted or
 * re-keyed), or, when the write checked a version, it is there but changed.
 * Read inside the write's transaction, so it sees what the write saw.
 */
function staleRowError(
	db: Database.Database,
	table: SqliteEditableTable,
	condition: SqliteRowKeyCondition,
	version: string | null,
	nothing: 'changed' | 'deleted'
): Error {
	const stillThere =
		version !== null &&
		db
			.prepare(`SELECT 1 FROM ${table.source} WHERE ${condition.where}`)
			.get(...condition.params) !== undefined;
	return new Error(
		sqliteStaleRowMessage(
			stillThere ? 'changed' : 'gone',
			table.object.name,
			condition.label,
			nothing
		)
	);
}

/**
 * Rows the connection has changed since it opened, triggers and foreign-key
 * actions included (`total_changes()`), so a write can tell how many rows it
 * changed beside its own.
 */
function totalChanges(db: Database.Database): number {
	return Number(db.prepare('SELECT total_changes()').pluck().get());
}

/** A value as a write binds it: a typed parameter, or a stored value put back whole. */
type SqliteWriteValue = SqliteBindValue | Buffer;

/**
 * One value a write stores, ready to bind: the value a person gave (an edit,
 * an insert) or the value a row held before (an undo). It says how the rowid
 * column's check reads it, and whether the value as stored is the one meant.
 */
interface SqliteValueWrite {
	column: string;
	/** The value as the rowid column's check reads it. */
	asParameter: SqliteParameterValue;
	given: SqliteWriteValue;
	/** The value as the statement log writes it in (a restored BLOB stays a BLOB). */
	logged: SqliteLogValue;
	/**
	 * Why the value as stored (`typeof` and the value, from `RETURNING`) is not
	 * the one meant, or null when it is.
	 */
	storedProblem: (affinity: SqliteAffinity, storedType: unknown, stored: unknown) => string | null;
}

/**
 * A value a person gave, bound by its type (`sqliteWriteBindValue()`). A
 * value the column's affinity converted is refused (`sqliteStoredValueProblem()`).
 */
function givenValueWrite(
	column: string,
	value: SqliteParameterValue,
	nothing: 'changed' | 'inserted'
): SqliteValueWrite {
	const given = sqliteWriteBindValue(column, value);
	return {
		column,
		asParameter: value,
		given,
		logged: value,
		storedProblem: (affinity, storedType, stored) => {
			const problem = sqliteStoredValueProblem(column, affinity, given, storedType, stored);
			return problem && nothing === 'inserted'
				? problem.replace('Nothing was changed', 'Nothing was inserted')
				: problem;
		},
	};
}

/** Whether two whole stored values are the same value of the same storage class. */
function sameKeyValue(left: SqliteKeyValue, right: SqliteKeyValue): boolean {
	if (left === null || right === null) return left === right;
	return left.type === right.type && left.text === right.text;
}

/**
 * A value a row held before, as an undo puts it back: bound whole in its own
 * storage class (`sqliteKeyBindValue()`), and refused unless it is stored
 * exactly as it was, which fails only when the table changed in between.
 */
function restoredValueWrite(column: string, value: SqliteKeyValue): SqliteValueWrite {
	let given: SqliteWriteValue;
	try {
		given = sqliteKeyBindValue(value, column);
	} catch {
		throw new Error(`The undo step's value for ${column} is not a stored value.`);
	}
	return {
		column,
		// Only the rowid column's check reads this, and a rowid is never a BLOB.
		asParameter:
			value === null
				? { type: 'null', text: '' }
				: value.type === 'integer' || value.type === 'real'
					? { type: 'number', text: value.text }
					: { type: 'text', text: value.text },
		given,
		logged: value,
		storedProblem: (_affinity, _storedType, stored) =>
			sameKeyValue(sqliteKeyValue(stored), value)
				? null
				: `${column} would not hold its old value as it was (the table may have changed since the write), so nothing was undone.`,
	};
}

/** The backup a write took, on its result only when this write took it. */
function backupField(session: SqliteWriteSession): { backup?: SqliteBackup } {
	return session.backupCreated ? { backup: session.backup } : {};
}

/**
 * Run a write's transaction, synchronously and at once (the grant is live
 * until the caller's next await), and record it in the database's statement
 * log once it has reached the file: the single-row statement and what it did,
 * or why it failed. A busy failure is restated (`describeSqliteBusy()`)
 * before it is logged and thrown, so the log and the caller say the same.
 */
async function loggedWrite<T>(
	session: SqliteWriteSession,
	kind: SqliteStatementLogKind,
	statement: SqliteRowWrite,
	run: () => T,
	changed: (done: T) => number
): Promise<{ done: T; elapsedMs: number }> {
	const started = performance.now();
	const record = {
		kind,
		table: statement.table,
		sql: sqliteRowWriteStatement(statement),
		params: {},
		transactionId: null,
		...sqliteLoggedBackup(session.backupCreated ? session.backup : undefined),
	};
	let done: T;
	try {
		done = run();
	} catch (error) {
		const described = describeSqliteBusy(error, 'write');
		await logSqliteStatement(session.database.displayPath, {
			...record,
			at: Date.now(),
			outcome: sqliteLoggedFailure(described),
		});
		throw described;
	}
	const elapsedMs = Math.round(performance.now() - started);
	await logSqliteStatement(session.database.displayPath, {
		...record,
		at: Date.now(),
		outcome: sqliteLoggedChanges(1, changed(done)),
	});
	return { done, elapsedMs };
}

/** Everything an edit needs to know about its table, checked. */
interface SqliteCellEditPlan extends SqliteEditableTable {
	/** The edited column's affinity, which converts the value on the way in. */
	affinity: SqliteAffinity;
	/** The edited row's `WHERE`. */
	condition: SqliteRowKeyCondition;
}

/**
 * Check an edit against one connection: the table exists and can be edited,
 * the column exists and is not generated, the value fits the rowid column
 * when that is the one edited, and the key fits the table's identity. Throws
 * the reason otherwise. Metadata reads only.
 */
function planCellEdit(
	db: Database.Database,
	name: string,
	column: string,
	row: SqliteRowKey,
	value: SqliteParameterValue
): SqliteCellEditPlan {
	const table = findEditableTable(db, name);
	const affinity = writableColumnAffinity(table, column);
	const { identity } = table;
	if (identity.kind === 'rowid' && identity.rowidColumn === column) {
		const problem = sqliteRowidValueProblem(column, value);
		if (problem) throw new Error(`${problem} Nothing was changed.`);
	}
	const condition = sqliteRowKeyCondition(identity, row, table.object.name);
	return { ...table, affinity, condition };
}

/** What one cell write did, for an edit's result or an undo's. */
interface SqliteCellWriteDone {
	plan: SqliteCellEditPlan;
	key: SqliteRowKey;
	cells: SqliteCellValue[];
	version: string;
	/** The value the cell held before, whole. */
	before: SqliteKeyValue;
	otherChanges: number;
	backup?: SqliteBackup;
	elapsedMs: number;
}

/**
 * The one UPDATE path: set one cell of the row `row` names to `write`'s
 * value, checking `version` in the same `WHERE` when given. A cell edit and
 * the undo of one both run it.
 */
async function writeCell(
	handle: string,
	editToken: string,
	name: string,
	row: SqliteRowKey,
	version: string | null,
	write: SqliteValueWrite,
	kind: 'cell' | 'undo'
): Promise<SqliteCellWriteDone> {
	const { column, given } = write;

	// Refuse what would be refused anyway before the backup is taken.
	planCellEdit(requireSqliteEditing(handle, editToken).db, name, column, row, write.asParameter);

	const session = await beginSqliteWrite(handle, editToken);
	// From here to the return, nothing awaits: the grant is live for all of it.
	const { db } = session;
	const plan = planCellEdit(db, name, column, row, write.asParameter);
	const { object, source, identity, affinity, condition } = plan;

	const keyColumns = sqliteRowKeyColumns(identity);
	const quotedColumn = quoteSqliteIdentifier(column);
	const target = rowWriteCondition(plan, condition, version);
	// The value before, whole, so the edit can be undone exactly.
	const readBefore = db
		.prepare(`SELECT ${quotedColumn} FROM ${source} WHERE ${target.where}`)
		.raw(true)
		.safeIntegers(true);
	// The key, then the edited value as stored, so a converted value is seen.
	const update = db
		.prepare(
			`UPDATE ${source} SET ${quotedColumn} = ? WHERE ${target.where} ` +
				`RETURNING ${keyColumns.map(quoteSqliteIdentifier).join(', ')}, ` +
				`typeof(${quotedColumn}), ${quotedColumn}`
		)
		.raw(true)
		.safeIntegers(true);

	const { done, elapsedMs } = await loggedWrite(
		session,
		kind,
		{ kind: 'cell', table: object.name, column, row, value: write.logged },
		() =>
			db.transaction(() => {
				const changesBefore = totalChanges(db);
				const old = readBefore.get(...target.params) as unknown[] | undefined;
				if (!old) throw staleRowError(db, plan, condition, version, 'changed');
				const changed = update.all(given, ...target.params) as unknown[][];
				if (changed.length === 0) throw staleRowError(db, plan, condition, version, 'changed');
				if (changed.length > 1) {
					// The key is unique, so this cannot happen; refuse rather than trust it.
					throw new Error(
						`${condition.label} matched ${changed.length} rows of ${object.name}, so nothing was changed.`
					);
				}
				const storedProblem = write.storedProblem(
					affinity,
					changed[0][keyColumns.length],
					changed[0][keyColumns.length + 1]
				);
				if (storedProblem) throw new Error(storedProblem);

				const key = returnedRowKey(identity, changed[0]);
				let after: SqliteRowKeyCondition;
				try {
					after = sqliteRowKeyCondition(identity, key, object.name);
				} catch (error) {
					throw new Error(
						`Setting ${column} this way would leave the row with no key to name it by, so nothing was changed. ${error instanceof Error ? error.message : String(error)}`
					);
				}
				const read = readRowByKey(db, plan, after);
				if (!read) {
					throw new Error(
						`${object.name} has no row with ${after.label} after the change (a trigger may have removed it), so nothing was changed.`
					);
				}
				return {
					key,
					...read,
					before: sqliteKeyValue(old[0]),
					otherChanges: Math.max(0, totalChanges(db) - changesBefore - 1),
				};
			})(),
		(edited) => edited.otherChanges
	);

	return {
		plan,
		key: done.key,
		cells: done.cells,
		version: done.version,
		before: done.before,
		otherChanges: done.otherChanges,
		...backupField(session),
		elapsedMs,
	};
}

/**
 * Change one cell of one row. Rejects, with nothing written, when editing is
 * not enabled for the tab, the backup fails, the table cannot be edited, the
 * column is generated or missing, the key does not name a row, the row
 * changed since the `version` the caller sent, the value does not bind, or
 * SQLite refuses the change (its message, verbatim). The result carries the
 * step that puts the old value back (`undo`), unless the database's triggers
 * or foreign-key actions changed other rows too.
 */
export function updateSqliteCell(
	request: SqliteCellUpdateRequest
): Promise<SqliteCellUpdateResult> {
	return reportSqliteBusy('write', () => updateCell(request));
}

/** `updateSqliteCell()`'s work; a busy database is restated by the caller. */
async function updateCell(request: SqliteCellUpdateRequest): Promise<SqliteCellUpdateResult> {
	const name = requireText(request?.name, 'table name');
	const column = requireText(request?.column, 'column name');
	const write = givenValueWrite(column, request.value, 'changed');
	const version = sqliteRowVersionParam(request.version);

	const done = await writeCell(
		request.handle,
		request.editToken,
		name,
		request.row,
		version,
		write,
		'cell'
	);
	const { object, columns } = done.plan;
	return {
		name: object.name,
		column,
		columns,
		row: done.cells,
		key: done.key,
		version: done.version,
		otherChanges: done.otherChanges,
		undo:
			done.otherChanges === 0
				? {
						kind: 'restore-cell',
						name: object.name,
						column,
						row: done.key,
						version: done.version,
						value: done.before,
					}
				: null,
		...(done.backup ? { backup: done.backup } : {}),
		elapsedMs: done.elapsedMs,
	};
}

/** One column an insert sets, checked and bound. */
interface SqliteInsertEntry extends SqliteValueWrite {
	affinity: SqliteAffinity;
}

/**
 * Check an insert against one connection: the table exists and can be
 * edited, every column given exists and is not generated, and the rowid
 * column's value is a whole number (a NULL there is fine: SQLite assigns the
 * next rowid). A row an undo restores keeps its old rowid: when the table has
 * no `INTEGER PRIMARY KEY` holding it, `rowid` is set through the alias.
 * Throws the reason otherwise. Metadata reads only.
 */
function planInsert(
	db: Database.Database,
	name: string,
	fields: SqliteValueWrite[],
	rowid: string | null
): SqliteEditableTable & {
	entries: SqliteInsertEntry[];
	keepRowid: { alias: string; given: SqliteWriteValue } | null;
} {
	const table = findEditableTable(db, name);
	const { identity } = table;
	const entries = fields.map((field): SqliteInsertEntry => {
		const affinity = writableColumnAffinity(table, field.column);
		if (
			identity.kind === 'rowid' &&
			identity.rowidColumn === field.column &&
			field.asParameter.type !== 'null'
		) {
			const problem = sqliteRowidValueProblem(field.column, field.asParameter);
			if (problem) throw new Error(`${problem} Nothing was inserted.`);
		}
		return { ...field, affinity };
	});
	let keepRowid: { alias: string; given: SqliteWriteValue } | null = null;
	if (rowid !== null && identity.kind === 'rowid' && identity.rowidColumn === null) {
		try {
			keepRowid = {
				alias: identity.alias,
				given: sqliteKeyBindValue({ type: 'integer', text: rowid }, 'rowid'),
			};
		} catch {
			throw new Error(`"${rowid}" is not a rowid.`);
		}
	}
	return { ...table, entries, keepRowid };
}

/** What one insert did, for an insert's result or an undo's. */
interface SqliteRowWriteDone {
	table: SqliteEditableTable;
	key: SqliteRowKey;
	cells: SqliteCellValue[];
	version: string;
	otherChanges: number;
	backup?: SqliteBackup;
	elapsedMs: number;
}

/**
 * The one INSERT path: add one row with `fields` (the other columns take
 * their DEFAULT), and `rowid` when an undo restores a deleted row. An insert
 * and the undo of a delete both run it.
 */
async function writeRow(
	handle: string,
	editToken: string,
	name: string,
	fields: SqliteValueWrite[],
	rowid: string | null,
	kind: 'insert' | 'undo'
): Promise<SqliteRowWriteDone> {
	// Refuse what would be refused anyway before the backup is taken.
	planInsert(requireSqliteEditing(handle, editToken).db, name, fields, rowid);

	const session = await beginSqliteWrite(handle, editToken);
	// From here to the return, nothing awaits: the grant is live for all of it.
	const { db } = session;
	const plan = planInsert(db, name, fields, rowid);
	const { object, source, identity, entries, keepRowid } = plan;

	const keyColumns = sqliteRowKeyColumns(identity);
	// The key, then each given value as stored, so a converted value is seen.
	const returning = [
		...keyColumns.map(quoteSqliteIdentifier),
		...entries.flatMap(({ column }) => {
			const quoted = quoteSqliteIdentifier(column);
			return [`typeof(${quoted})`, quoted];
		}),
	].join(', ');
	const targets = [...(keepRowid ? [keepRowid.alias] : []), ...entries.map(({ column }) => column)];
	const insert = db
		.prepare(
			targets.length === 0
				? `INSERT INTO ${source} DEFAULT VALUES RETURNING ${returning}`
				: `INSERT INTO ${source} (${targets.map(quoteSqliteIdentifier).join(', ')}) ` +
						`VALUES (${targets.map(() => '?').join(', ')}) RETURNING ${returning}`
		)
		.raw(true)
		.safeIntegers(true);
	const params = [...(keepRowid ? [keepRowid.given] : []), ...entries.map(({ given }) => given)];

	const { done: added, elapsedMs } = await loggedWrite(
		session,
		kind,
		{
			kind: 'insert',
			table: object.name,
			values: Object.fromEntries(entries.map((entry) => [entry.column, entry.logged])),
			rowid: keepRowid ? rowid : null,
		},
		() =>
			db.transaction(() => {
				const before = totalChanges(db);
				const returned = insert.all(...params) as unknown[][];
				if (returned.length !== 1) {
					// INSERT adds one row or fails; none means a trigger's RAISE(IGNORE).
					throw new Error(
						returned.length === 0
							? `A trigger on ${object.name} dropped the new row (RAISE(IGNORE)), so nothing was inserted.`
							: `An insert into ${object.name} returned ${returned.length} rows, so nothing was inserted.`
					);
				}
				const [first] = returned;
				entries.forEach((entry, index) => {
					const at = keyColumns.length + index * 2;
					const problem = entry.storedProblem(entry.affinity, first[at], first[at + 1]);
					if (problem) throw new Error(problem);
				});

				const key = returnedRowKey(identity, first);
				let condition: SqliteRowKeyCondition;
				try {
					condition = sqliteRowKeyCondition(identity, key, object.name);
				} catch (error) {
					throw new Error(
						`The new row would have no key to name it by, so nothing was inserted; give every key column a value. ${error instanceof Error ? error.message : String(error)}`
					);
				}
				const read = readRowByKey(db, plan, condition);
				if (!read) {
					throw new Error(
						`${object.name} has no row with ${condition.label} after the insert (a trigger may have removed it), so nothing was inserted.`
					);
				}
				return { key, ...read, otherChanges: Math.max(0, totalChanges(db) - before - 1) };
			})(),
		(inserted) => inserted.otherChanges
	);

	return {
		table: plan,
		key: added.key,
		cells: added.cells,
		version: added.version,
		otherChanges: added.otherChanges,
		...backupField(session),
		elapsedMs,
	};
}

/**
 * Add one row to a table. Columns left out of `values` take their DEFAULT.
 * Rejects, with nothing written, when editing is not enabled for the tab, the
 * backup fails, the table cannot be edited, a column is generated or
 * missing, a value does not bind or would be stored converted, the new row's
 * key would hold NULL (no edit could name it), or SQLite refuses the row: a
 * NOT NULL, UNIQUE, CHECK, or FOREIGN KEY constraint, in SQLite's own words.
 * The result carries the step that removes the row again (`undo`), unless the
 * database's triggers or foreign-key actions changed other rows too.
 */
export function insertSqliteRow(request: SqliteRowInsertRequest): Promise<SqliteRowInsertResult> {
	return reportSqliteBusy('write', () => insertRow(request));
}

/** `insertSqliteRow()`'s work; a busy database is restated by the caller. */
async function insertRow(request: SqliteRowInsertRequest): Promise<SqliteRowInsertResult> {
	const name = requireText(request?.name, 'table name', 'An insert');
	const values = request.values ?? {};
	if (typeof values !== 'object' || Array.isArray(values)) {
		throw new Error('An insert takes its values as an object keyed by column name.');
	}
	const fields = Object.entries(values).map(([column, value]) =>
		givenValueWrite(column, value, 'inserted')
	);

	const done = await writeRow(request.handle, request.editToken, name, fields, null, 'insert');
	const { object, columns } = done.table;
	return {
		name: object.name,
		columns,
		row: done.cells,
		key: done.key,
		version: done.version,
		otherChanges: done.otherChanges,
		undo:
			done.otherChanges === 0
				? { kind: 'remove-row', name: object.name, row: done.key, version: done.version }
				: null,
		...(done.backup ? { backup: done.backup } : {}),
		elapsedMs: done.elapsedMs,
	};
}

/** What one delete did, for a delete's result or an undo's. */
interface SqliteRowRemoveDone {
	table: SqliteEditableTable;
	key: SqliteRowKey;
	/** The row's rowid, decimal text, when the table names rows by it. */
	rowid: string | null;
	/** Every column the row had that an insert can set (generated ones excepted), whole. */
	values: Record<string, SqliteKeyValue>;
	otherChanges: number;
	backup?: SqliteBackup;
	elapsedMs: number;
}

/**
 * The one DELETE path: remove the row `row` names, checking `version` in the
 * same `WHERE` when given, and hand back every value it held so the row can
 * be put back whole. A delete and the undo of an insert both run it.
 */
async function removeRow(
	handle: string,
	editToken: string,
	name: string,
	row: SqliteRowKey,
	version: string | null,
	kind: 'delete' | 'undo'
): Promise<SqliteRowRemoveDone> {
	const plan = (db: Database.Database) => {
		const table = findEditableTable(db, name);
		return { ...table, condition: sqliteRowKeyCondition(table.identity, row, name) };
	};

	// Refuse what would be refused anyway before the backup is taken.
	plan(requireSqliteEditing(handle, editToken).db);

	const session = await beginSqliteWrite(handle, editToken);
	// From here to the return, nothing awaits: the grant is live for all of it.
	const { db } = session;
	const table = plan(db);
	const { object, source, identity, condition, columns, readOnlyColumns } = table;
	const keyColumns = sqliteRowKeyColumns(identity);
	// Generated columns are computed again when the row is put back.
	const restorable = columns
		.map((entry) => entry.name)
		.filter((column) => !readOnlyColumns.some((entry) => entry.name === column));
	const target = rowWriteCondition(table, condition, version);
	const remove = db
		.prepare(
			`DELETE FROM ${source} WHERE ${target.where} ` +
				`RETURNING ${[...keyColumns, ...restorable].map(quoteSqliteIdentifier).join(', ')}`
		)
		.raw(true)
		.safeIntegers(true);

	const { done: removed, elapsedMs } = await loggedWrite(
		session,
		kind,
		{ kind: 'delete', table: object.name, row },
		() =>
			db.transaction(() => {
				const before = totalChanges(db);
				const deleted = remove.all(...target.params) as unknown[][];
				if (deleted.length === 0) throw staleRowError(db, table, condition, version, 'deleted');
				if (deleted.length > 1) {
					// The key is unique, so this cannot happen; refuse rather than trust it.
					throw new Error(
						`${condition.label} matched ${deleted.length} rows of ${object.name}, so nothing was deleted.`
					);
				}
				const [first] = deleted;
				return {
					key: returnedRowKey(identity, first),
					values: Object.fromEntries(
						restorable.map((column, index) => [
							column,
							sqliteKeyValue(first[keyColumns.length + index]),
						])
					),
					otherChanges: Math.max(0, totalChanges(db) - before - 1),
				};
			})(),
		(deleted) => deleted.otherChanges
	);

	return {
		table,
		key: removed.key,
		rowid: removed.key.kind === 'rowid' ? removed.key.rowid : null,
		values: removed.values,
		otherChanges: removed.otherChanges,
		...backupField(session),
		elapsedMs,
	};
}

/**
 * Remove one row of a table, named by its rowid or whole primary key.
 * Rejects, with nothing written, when editing is not enabled for the tab, the
 * backup fails, the table cannot be edited, the key does not name exactly
 * one row (deleted or re-keyed since it was read), the row changed since the
 * `version` the caller sent, or SQLite refuses: a
 * FOREIGN KEY constraint a child row holds, in SQLite's own words. Rows the
 * database's foreign-key actions or triggers change as a result are counted
 * in `otherChanges`. The result carries the step that puts the row back
 * (`undo`), unless `otherChanges` is not 0.
 */
export function deleteSqliteRow(request: SqliteRowDeleteRequest): Promise<SqliteRowDeleteResult> {
	return reportSqliteBusy('write', () => deleteRow(request));
}

/** `deleteSqliteRow()`'s work; a busy database is restated by the caller. */
async function deleteRow(request: SqliteRowDeleteRequest): Promise<SqliteRowDeleteResult> {
	const name = requireText(request?.name, 'table name', 'A delete');
	const version = sqliteRowVersionParam(request.version);
	const done = await removeRow(
		request.handle,
		request.editToken,
		name,
		request.row,
		version,
		'delete'
	);
	return {
		name: done.table.object.name,
		key: done.key,
		otherChanges: done.otherChanges,
		undo:
			done.otherChanges === 0
				? {
						kind: 'restore-row',
						name: done.table.object.name,
						rowid: done.rowid,
						values: done.values,
					}
				: null,
		...(done.backup ? { backup: done.backup } : {}),
		elapsedMs: done.elapsedMs,
	};
}

/** The version an undo step must carry: the row's, after the write it undoes. */
function undoStepVersion(version: unknown): string {
	const checked = sqliteRowVersionParam(version);
	if (checked === null) {
		throw new Error("An undo step needs the row's version after the write it undoes.");
	}
	return checked;
}

/**
 * Take back one write: apply the `undo` step its result returned, as one
 * single-row write through the same path, gate, and backup as the write
 * itself. A cell goes back to its old value, an inserted row is deleted, a
 * deleted row is inserted again whole (with its old rowid). Rejects, with
 * nothing written, when editing is not enabled for the tab, the step is
 * malformed, the row changed since the write (another tab, another program,
 * a trigger: refused like a stale edit), the table no longer stores the old
 * value as it was, or SQLite refuses (a UNIQUE constraint when the restored
 * row's key was taken since, in SQLite's own words).
 */
export function undoSqliteEdit(request: SqliteUndoRequest): Promise<SqliteUndoResult> {
	return reportSqliteBusy('write', () => undoEdit(request));
}

/** `undoSqliteEdit()`'s work; a busy database is restated by the caller. */
async function undoEdit(request: SqliteUndoRequest): Promise<SqliteUndoResult> {
	const step = request?.step as SqliteUndoStep | undefined;
	if (!step || typeof step !== 'object') {
		throw new Error('An undo needs the step its write returned.');
	}
	const name = requireText(step.name, 'table name', 'An undo');
	const { handle, editToken } = request;
	const result = (
		done: { key: SqliteRowKey; otherChanges: number; backup?: SqliteBackup; elapsedMs: number },
		table: string
	): SqliteUndoResult => ({
		name: table,
		kind: step.kind,
		key: done.key,
		otherChanges: done.otherChanges,
		...(done.backup ? { backup: done.backup } : {}),
		elapsedMs: done.elapsedMs,
	});

	switch (step.kind) {
		case 'restore-cell': {
			const column = requireText(step.column, 'column name', 'An undo');
			const write = restoredValueWrite(column, step.value);
			const version = undoStepVersion(step.version);
			const done = await writeCell(handle, editToken, name, step.row, version, write, 'undo');
			return result(done, done.plan.object.name);
		}
		case 'remove-row': {
			const version = undoStepVersion(step.version);
			const done = await removeRow(handle, editToken, name, step.row, version, 'undo');
			return result(done, done.table.object.name);
		}
		case 'restore-row': {
			const values = step.values;
			if (!values || typeof values !== 'object' || Array.isArray(values)) {
				throw new Error("An undo step that restores a row needs the row's values by column name.");
			}
			if (step.rowid !== null && typeof step.rowid !== 'string') {
				throw new Error(`"${String(step.rowid)}" is not a rowid.`);
			}
			const fields = Object.entries(values).map(([column, value]) =>
				restoredValueWrite(column, value)
			);
			const done = await writeRow(handle, editToken, name, fields, step.rowid ?? null, 'undo');
			return result(done, done.table.object.name);
		}
		default:
			throw new Error(
				`"${String((step as { kind?: unknown }).kind)}" is not an undo step: it names restore-cell, remove-row, or restore-row.`
			);
	}
}
