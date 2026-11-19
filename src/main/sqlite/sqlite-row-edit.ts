/**
 * SQLite Cell Edit
 *
 * The first write the viewer makes to a user's database: one cell of one row,
 * as a parameterised single-row `UPDATE` keyed on the row's identity.
 *
 *   UPDATE "t" SET "c" = ? WHERE "rowid" = ? RETURNING "rowid"
 *   UPDATE "t" SET "c" = ? WHERE "a" = ? AND "b" = ? RETURNING "a", "b"
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
import { sqliteParameterBindValue } from '../../shared/sqlite/query';
import { sqliteColumnAffinity } from '../../shared/sqlite/schema';
import { quoteSqliteIdentifier } from '../../shared/sqlite/sql';
import type {
	SqliteAffinity,
	SqliteCellUpdateRequest,
	SqliteCellUpdateResult,
	SqliteObjectSummary,
	SqliteParameterValue,
	SqliteResultColumn,
	SqliteRowIdentity,
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
import { sqliteRowSelectList, sqliteSelectedRow } from './sqlite-rows';

function requireText(value: unknown, label: string): string {
	if (typeof value !== 'string' || value === '') {
		throw new Error(`A cell edit needs the ${label}.`);
	}
	return value;
}

/** Everything an edit needs to know about its table, checked. */
interface SqliteCellEditPlan {
	object: SqliteObjectSummary;
	/** The table's name, quoted. */
	source: string;
	/** `SELECT *`'s columns, as the window reader reads them. */
	columns: SqliteResultColumn[];
	identity: SqliteRowIdentity;
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
	// A view is found too, so it is refused with its reason, not "no table".
	const objects = readSqliteObjectSummaries(db);
	const object =
		findSqliteObject(objects, name, 'table') ?? findSqliteObject(objects, name, 'view');
	if (!object) throw new Error(`No table is named ${name}.`);
	const editability = resolveSqliteEditability(db, object);
	if (!editability.editable) throw new Error(editability.reason);
	const generated = editability.readOnlyColumns.find((entry) => entry.name === column);
	if (generated) throw new Error(generated.reason);

	const source = quoteSqliteIdentifier(object.name);
	const columns = db
		.prepare(`SELECT * FROM ${source}`)
		.columns()
		.map((entry) => ({ name: entry.name, declaredType: entry.type }));
	const edited = columns.find((entry) => entry.name === column);
	if (!edited) throw new Error(`${object.name} has no column named ${column}.`);
	const { identity } = editability;
	if (identity.kind === 'rowid' && identity.rowidColumn === column) {
		const problem = sqliteRowidValueProblem(column, value);
		if (problem) throw new Error(`${problem} Nothing was changed.`);
	}
	const affinity = sqliteColumnAffinity(edited.declaredType ?? '', object.strict === true);
	const condition = sqliteRowKeyCondition(identity, row, object.name);
	return { object, source, columns, identity, affinity, condition };
}

/**
 * Change one cell of one row. Rejects, with nothing written, when editing is
 * not enabled for the tab, the backup fails, the table cannot be edited, the
 * column is generated or missing, the key does not name a row, the value
 * does not bind, or SQLite refuses the change (its message, verbatim).
 */
export async function updateSqliteCell(
	request: SqliteCellUpdateRequest
): Promise<SqliteCellUpdateResult> {
	const name = requireText(request?.name, 'table name');
	const column = requireText(request?.column, 'column name');
	const bound = sqliteParameterBindValue(column, request.value);
	if ('problem' in bound) throw new Error(bound.problem);
	// better-sqlite3 binds every JS number as a REAL; a whole number typed as
	// one binds as an INTEGER, so a column with no affinity keeps 7, not 7.0.
	const given =
		typeof bound.value === 'number' && /^[+-]?\d+$/.test(request.value.text.trim())
			? BigInt(bound.value)
			: bound.value;

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
	const { object, source, columns, identity, affinity, condition } = planCellEdit(
		db,
		name,
		column,
		request.row,
		request.value
	);

	const keyColumns = sqliteRowKeyColumns(identity);
	const quotedColumn = quoteSqliteIdentifier(column);
	// The key, then the edited value as stored, so a converted value is seen.
	const update = db
		.prepare(
			`UPDATE ${source} SET ${quotedColumn} = ? WHERE ${condition.where} ` +
				`RETURNING ${keyColumns.map(quoteSqliteIdentifier).join(', ')}, ` +
				`typeof(${quotedColumn}), ${quotedColumn}`
		)
		.raw(true)
		.safeIntegers(true);

	const started = performance.now();
	const row = db.transaction(() => {
		const changed = update.all(given, ...condition.params) as unknown[][];
		if (changed.length === 0) {
			throw new Error(
				`${object.name} has no row with ${condition.label}: it was deleted or its key changed since it was read. Nothing was changed; reload the table.`
			);
		}
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

		const key: SqliteRowKey =
			identity.kind === 'rowid'
				? { kind: 'rowid', rowid: String(changed[0][0]) }
				: {
						kind: 'primary-key',
						values: Object.fromEntries(
							identity.columns.map((keyColumn, index) => [
								keyColumn,
								sqliteKeyValue(changed[0][index]),
							])
						),
					};
		let after: SqliteRowKeyCondition;
		try {
			after = sqliteRowKeyCondition(identity, key, object.name);
		} catch (error) {
			throw new Error(
				`Setting ${column} this way would leave the row with no key to name it by, so nothing was changed. ${error instanceof Error ? error.message : String(error)}`
			);
		}
		const raw = db
			.prepare(
				`SELECT ${sqliteRowSelectList(columns, null, [])} FROM ${source} WHERE ${after.where}`
			)
			.raw(true)
			.safeIntegers(true)
			.get(...after.params) as unknown[] | undefined;
		if (!raw) {
			throw new Error(
				`${object.name} has no row with ${after.label} after the change (a trigger may have removed it), so nothing was changed.`
			);
		}
		return { key, cells: sqliteSelectedRow(raw, columns.length, null, []).cells };
	})();
	const elapsedMs = Math.round(performance.now() - started);

	return {
		name: object.name,
		column,
		columns,
		row: row.cells,
		key: row.key,
		...(session.backupCreated ? { backup: session.backup } : {}),
		elapsedMs,
	};
}
