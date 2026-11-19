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
 *
 * SQLite's own failures (a constraint, a STRICT type, a busy database) reach
 * the caller with SQLite's message.
 */

import { sqliteRowidValueProblem, sqliteStoredValueProblem } from '../../shared/sqlite/affinity';
import type { SqliteBindValue } from '../../shared/sqlite/filter';
import { sqliteParameterBindValue } from '../../shared/sqlite/query';
import { sqliteColumnAffinity, sqliteStaleRowMessage } from '../../shared/sqlite/schema';
import { quoteSqliteIdentifier } from '../../shared/sqlite/sql';
import type {
	SqliteAffinity,
	SqliteCellUpdateRequest,
	SqliteCellUpdateResult,
	SqliteCellValue,
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
} from '../../shared/sqlite/types';
import type Database from 'better-sqlite3';

import { sqliteKeyValue } from './sqlite-cell';
import { beginSqliteWrite, requireSqliteEditing } from './sqlite-editing';
import {
	resolveSqliteEditability,
	sqliteRowKeyColumns,
	sqliteRowKeyCondition,
	type SqliteRowKeyCondition,
} from './sqlite-identity';
import { findSqliteObject, readSqliteObjectSummaries } from './sqlite-objects';
import { sqliteRowVersionExpression, sqliteRowVersionParam } from './sqlite-row-version';
import { sqliteRowSelectList, sqliteSelectedRow } from './sqlite-rows';

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

/**
 * Change one cell of one row. Rejects, with nothing written, when editing is
 * not enabled for the tab, the backup fails, the table cannot be edited, the
 * column is generated or missing, the key does not name a row, the row
 * changed since the `version` the caller sent, the value does not bind, or
 * SQLite refuses the change (its message, verbatim).
 */
export async function updateSqliteCell(
	request: SqliteCellUpdateRequest
): Promise<SqliteCellUpdateResult> {
	const name = requireText(request?.name, 'table name');
	const column = requireText(request?.column, 'column name');
	const given = sqliteWriteBindValue(column, request.value);
	const version = sqliteRowVersionParam(request.version);

	// Refuse what would be refused anyway before the backup is taken.
	planCellEdit(
		requireSqliteEditing(request.handle, request.editToken).db,
		name,
		column,
		request.row,
		request.value
	);

	const session = await beginSqliteWrite(request.handle, request.editToken);
	// From here to the return, nothing awaits: the grant is live for all of it.
	const { db } = session;
	const plan = planCellEdit(db, name, column, request.row, request.value);
	const { object, source, columns, identity, affinity, condition } = plan;

	const keyColumns = sqliteRowKeyColumns(identity);
	const quotedColumn = quoteSqliteIdentifier(column);
	const target = rowWriteCondition(plan, condition, version);
	// The key, then the edited value as stored, so a converted value is seen.
	const update = db
		.prepare(
			`UPDATE ${source} SET ${quotedColumn} = ? WHERE ${target.where} ` +
				`RETURNING ${keyColumns.map(quoteSqliteIdentifier).join(', ')}, ` +
				`typeof(${quotedColumn}), ${quotedColumn}`
		)
		.raw(true)
		.safeIntegers(true);

	const started = performance.now();
	const row = db.transaction(() => {
		const changed = update.all(given, ...target.params) as unknown[][];
		if (changed.length === 0) throw staleRowError(db, plan, condition, version, 'changed');
		if (changed.length > 1) {
			// The key is unique, so this cannot happen; refuse rather than trust it.
			throw new Error(
				`${condition.label} matched ${changed.length} rows of ${object.name}, so nothing was changed.`
			);
		}
		const storedProblem = sqliteStoredValueProblem(
			column,
			affinity,
			given,
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
		return { key, ...read };
	})();
	const elapsedMs = Math.round(performance.now() - started);

	return {
		name: object.name,
		column,
		columns,
		row: row.cells,
		key: row.key,
		version: row.version,
		...(session.backupCreated ? { backup: session.backup } : {}),
		elapsedMs,
	};
}

/** One column an insert sets, checked and bound. */
interface SqliteInsertEntry {
	column: string;
	affinity: SqliteAffinity;
	given: SqliteBindValue;
}

/**
 * Check an insert against one connection: the table exists and can be
 * edited, every column given exists and is not generated, and every value
 * binds (a NULL in the rowid column is fine: SQLite assigns the next rowid).
 * Throws the reason otherwise. Metadata reads only.
 */
function planInsert(
	db: Database.Database,
	name: string,
	values: Record<string, SqliteParameterValue>
): SqliteEditableTable & { entries: SqliteInsertEntry[] } {
	const table = findEditableTable(db, name);
	const { identity } = table;
	const entries = Object.entries(values).map(([column, value]): SqliteInsertEntry => {
		const affinity = writableColumnAffinity(table, column);
		if (identity.kind === 'rowid' && identity.rowidColumn === column && value?.type !== 'null') {
			const problem = sqliteRowidValueProblem(column, value);
			if (problem) throw new Error(`${problem} Nothing was inserted.`);
		}
		return { column, affinity, given: sqliteWriteBindValue(column, value) };
	});
	return { ...table, entries };
}

/**
 * Add one row to a table. Columns left out of `values` take their DEFAULT.
 * Rejects, with nothing written, when editing is not enabled for the tab, the
 * backup fails, the table cannot be edited, a column is generated or
 * missing, a value does not bind or would be stored converted, the new row's
 * key would hold NULL (no edit could name it), or SQLite refuses the row: a
 * NOT NULL, UNIQUE, CHECK, or FOREIGN KEY constraint, in SQLite's own words.
 */
export async function insertSqliteRow(
	request: SqliteRowInsertRequest
): Promise<SqliteRowInsertResult> {
	const name = requireText(request?.name, 'table name', 'An insert');
	const values = request.values ?? {};
	if (typeof values !== 'object' || Array.isArray(values)) {
		throw new Error('An insert takes its values as an object keyed by column name.');
	}

	// Refuse what would be refused anyway before the backup is taken.
	planInsert(requireSqliteEditing(request.handle, request.editToken).db, name, values);

	const session = await beginSqliteWrite(request.handle, request.editToken);
	// From here to the return, nothing awaits: the grant is live for all of it.
	const { db } = session;
	const plan = planInsert(db, name, values);
	const { object, source, columns, identity, entries } = plan;

	const keyColumns = sqliteRowKeyColumns(identity);
	// The key, then each given value as stored, so a converted value is seen.
	const returning = [
		...keyColumns.map(quoteSqliteIdentifier),
		...entries.flatMap(({ column }) => {
			const quoted = quoteSqliteIdentifier(column);
			return [`typeof(${quoted})`, quoted];
		}),
	].join(', ');
	const insert = db
		.prepare(
			entries.length === 0
				? `INSERT INTO ${source} DEFAULT VALUES RETURNING ${returning}`
				: `INSERT INTO ${source} (${entries.map(({ column }) => quoteSqliteIdentifier(column)).join(', ')}) ` +
						`VALUES (${entries.map(() => '?').join(', ')}) RETURNING ${returning}`
		)
		.raw(true)
		.safeIntegers(true);

	const started = performance.now();
	const added = db.transaction(() => {
		const before = totalChanges(db);
		const returned = insert.all(...entries.map(({ given }) => given)) as unknown[][];
		if (returned.length !== 1) {
			// INSERT adds one row or fails; none means a trigger's RAISE(IGNORE).
			throw new Error(
				returned.length === 0
					? `A trigger on ${object.name} dropped the new row (RAISE(IGNORE)), so nothing was inserted.`
					: `An insert into ${object.name} returned ${returned.length} rows, so nothing was inserted.`
			);
		}
		const [first] = returned;
		entries.forEach(({ column, affinity, given }, index) => {
			const at = keyColumns.length + index * 2;
			const problem = sqliteStoredValueProblem(column, affinity, given, first[at], first[at + 1]);
			if (problem) throw new Error(problem.replace('Nothing was changed', 'Nothing was inserted'));
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
	})();
	const elapsedMs = Math.round(performance.now() - started);

	return {
		name: object.name,
		columns,
		row: added.cells,
		key: added.key,
		version: added.version,
		otherChanges: added.otherChanges,
		...(session.backupCreated ? { backup: session.backup } : {}),
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
 * in `otherChanges`.
 */
export async function deleteSqliteRow(
	request: SqliteRowDeleteRequest
): Promise<SqliteRowDeleteResult> {
	const name = requireText(request?.name, 'table name', 'A delete');
	const version = sqliteRowVersionParam(request.version);
	const plan = (db: Database.Database) => {
		const table = findEditableTable(db, name);
		return { ...table, condition: sqliteRowKeyCondition(table.identity, request.row, name) };
	};

	// Refuse what would be refused anyway before the backup is taken.
	plan(requireSqliteEditing(request.handle, request.editToken).db);

	const session = await beginSqliteWrite(request.handle, request.editToken);
	// From here to the return, nothing awaits: the grant is live for all of it.
	const { db } = session;
	const table = plan(db);
	const { object, source, identity, condition } = table;
	const target = rowWriteCondition(table, condition, version);
	const remove = db
		.prepare(
			`DELETE FROM ${source} WHERE ${target.where} ` +
				`RETURNING ${sqliteRowKeyColumns(identity).map(quoteSqliteIdentifier).join(', ')}`
		)
		.raw(true)
		.safeIntegers(true);

	const started = performance.now();
	const removed = db.transaction(() => {
		const before = totalChanges(db);
		const deleted = remove.all(...target.params) as unknown[][];
		if (deleted.length === 0) throw staleRowError(db, table, condition, version, 'deleted');
		if (deleted.length > 1) {
			// The key is unique, so this cannot happen; refuse rather than trust it.
			throw new Error(
				`${condition.label} matched ${deleted.length} rows of ${object.name}, so nothing was deleted.`
			);
		}
		return {
			key: returnedRowKey(identity, deleted[0]),
			otherChanges: Math.max(0, totalChanges(db) - before - 1),
		};
	})();
	const elapsedMs = Math.round(performance.now() - started);

	return {
		name: object.name,
		key: removed.key,
		otherChanges: removed.otherChanges,
		...(session.backupCreated ? { backup: session.backup } : {}),
		elapsedMs,
	};
}
