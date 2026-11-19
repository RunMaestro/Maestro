/**
 * SQLite Row Identity and Editability
 *
 * An edit changes ONE row, so it must name that row in a way SQLite cannot
 * read as any other. `resolveSqliteEditability()` decides, per table, how:
 *
 *   1. **rowid.** Every ordinary table has one, unique and never NULL. A
 *      statement reaches it as `rowid`, `_rowid_`, or `oid`, unless a real
 *      column takes the name; the first name still free wins.
 *   2. **Primary key.** A `WITHOUT ROWID` table has no rowid, and an ordinary
 *      table whose columns take all three names has none reachable; both fall
 *      back to the primary key. In an ordinary table the key may hold NULL
 *      (a SQLite quirk kept for compatibility), and a NULL never compares
 *      equal, so such a row cannot be named; `keyMayBeNull` says so.
 *   3. **Read-only, with the reason.** A view has no rows of its own, a
 *      virtual table's rows belong to its module, a shadow table is another
 *      table's storage, SQLite keeps its `sqlite_*` tables itself, and a table
 *      with neither a reachable rowid nor a primary key has no way to name a
 *      row. Each says which, in a sentence the viewer and the CLI show as is.
 *
 * A generated column is never written, though its row can be.
 *
 * A write turns the identity and the row's key (`SqliteRowKey`, sent by the
 * viewer or the CLI) into its `WHERE` with `sqliteRowKeyCondition()`: every
 * value bound, every name quoted, and a key that does not fit the identity
 * (the wrong kind, a missing or extra key column, a NULL, a malformed value)
 * refused before anything runs.
 *
 * Everything here reads schema metadata only (`sqlite_master` and pragma
 * functions, names bound), so it is instant on any database. The renderer
 * gets the result to draw; a write resolves it again in main and never trusts
 * the renderer's copy.
 */

import type Database from 'better-sqlite3';

import { quoteSqliteIdentifier } from '../../shared/sqlite/sql';
import type {
	SqliteEditability,
	SqliteKeyValue,
	SqliteObjectSummary,
	SqliteReadOnlyColumn,
	SqliteResultColumn,
	SqliteRowIdentity,
	SqliteRowKey,
} from '../../shared/sqlite/types';
import { readSqliteObjectSummaries } from './sqlite-objects';

/** A rowid as the wire carries it: decimal text, signed, up to 64 bits. */
export const SQLITE_ROWID_TEXT = /^-?\d{1,19}$/;

/** The names SQLite answers to for a rowid, in the order we prefer them. */
const ROWID_ALIASES = ['rowid', '_rowid_', 'oid'] as const;

/**
 * The rowid alias a statement over this object can use, or null when it has
 * none: views, virtual tables, and `WITHOUT ROWID` tables have no rowid, and a
 * real column named `rowid` hides that alias, so the first name still free
 * wins. A table whose columns take all three names has no reachable rowid.
 * Shared by the row reader, the row counter, and the BLOB reader, so every
 * statement names a row the same way.
 */
export function reachableRowidAlias(
	object: SqliteObjectSummary,
	columns: readonly Pick<SqliteResultColumn, 'name'>[]
): string | null {
	if (object.kind !== 'table' || object.tableType === 'virtual' || object.withoutRowid) {
		return null;
	}
	const taken = new Set(columns.map((column) => column.name.toLowerCase()));
	return ROWID_ALIASES.find((candidate) => !taken.has(candidate)) ?? null;
}

interface TableXinfoRow {
	name: string;
	notnull: number;
	pk: number;
	/** 0 ordinary, 1 hidden (virtual table), 2 generated VIRTUAL, 3 generated STORED. */
	hidden: number;
}

function readOnly(
	code: Extract<SqliteEditability, { editable: false }>['code'],
	reason: string
): SqliteEditability {
	return { editable: false, code, reason };
}

/** The module a virtual table runs on (`fts5`, `rtree`), from its `CREATE` text. */
function virtualTableModule(db: Database.Database, name: string): string | null {
	const row = db
		.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
		.get(name) as { sql: string | null } | undefined;
	const match = /\bUSING\s+["'`[]?([A-Za-z_][\w]*)/i.exec(row?.sql ?? '');
	return match ? match[1] : null;
}

/**
 * The virtual table a shadow table belongs to. SQLite names a shadow table
 * `<virtual table>_<suffix>`, so the longest virtual-table name that prefixes
 * it is the owner.
 */
function shadowTableOwner(db: Database.Database, name: string): string | null {
	const owners = readSqliteObjectSummaries(db)
		.filter((object) => object.kind === 'table' && object.tableType === 'virtual')
		.map((object) => object.name)
		.filter((owner) => name.toLowerCase().startsWith(`${owner.toLowerCase()}_`))
		.sort((a, b) => b.length - a.length);
	return owners[0] ?? null;
}

/** Why an object with no rows to edit of its own is read-only, or null when it has rows. */
function objectRefusal(
	db: Database.Database,
	object: SqliteObjectSummary
): SqliteEditability | null {
	const { name } = object;
	if (object.kind === 'view') {
		return readOnly(
			'view',
			`${name} is a view: it has no rows of its own, and an edit cannot tell which table it should change.`
		);
	}
	if (object.kind !== 'table') {
		// Callers ask only about tables and views; an index or trigger has no
		// rows to name.
		return readOnly(
			'no-identity',
			`${name} is ${object.kind === 'index' ? 'an index' : 'a trigger'}, not a table.`
		);
	}
	if (object.tableType === 'virtual') {
		const module = virtualTableModule(db, name);
		return readOnly(
			'virtual-table',
			`${name} is a virtual table${module ? ` (module ${module})` : ''}: its rows belong to the module, which has its own rules for changes.`
		);
	}
	if (object.tableType === 'shadow') {
		const owner = shadowTableOwner(db, name);
		return readOnly(
			'shadow-table',
			`${name} is a shadow table: it holds the storage of ${owner ? `the virtual table ${owner}` : 'a virtual table'}. Change the data through that table.`
		);
	}
	if (name.toLowerCase().startsWith('sqlite_')) {
		return readOnly(
			'internal-table',
			`${name} is an internal table: SQLite keeps it up to date itself, and a change by hand can break it.`
		);
	}
	return null;
}

/** Generated columns: their rows can change, they cannot. */
function generatedColumns(columns: readonly TableXinfoRow[]): SqliteReadOnlyColumn[] {
	return columns
		.filter((column) => column.hidden === 2 || column.hidden === 3)
		.map((column) => ({
			name: column.name,
			reason: `${column.name} is a generated column: SQLite calculates its value from other columns.`,
		}));
}

/**
 * Whether the rows of a table or view can be edited, and if so how an edit
 * names its row. Never throws for a table SQLite cannot describe: the
 * failure becomes the read-only reason.
 */
export function resolveSqliteEditability(
	db: Database.Database,
	object: SqliteObjectSummary
): SqliteEditability {
	const refusal = objectRefusal(db, object);
	if (refusal) return refusal;
	const { name } = object;

	let columns: TableXinfoRow[];
	let keyIndexed: boolean;
	try {
		columns = db
			// `notnull` is a keyword (the NOTNULL operator), so it is quoted.
			.prepare('SELECT name, "notnull", pk, hidden FROM pragma_table_xinfo(?, ?) ORDER BY cid')
			.all(name, 'main') as TableXinfoRow[];
		// A rowid table's primary key gets its own index unless it IS the rowid
		// (`INTEGER PRIMARY KEY`), so an index of origin `pk` means the key can
		// hold NULL and is not the rowid.
		keyIndexed = (
			db.prepare('SELECT origin FROM pragma_index_list(?, ?)').all(name, 'main') as Array<{
				origin: string;
			}>
		).some((index) => index.origin === 'pk');
	} catch (error) {
		return readOnly(
			'unreadable',
			`The columns of ${name} cannot be read, so no row can be named: ${error instanceof Error ? error.message : String(error)}`
		);
	}

	const readOnlyColumns = generatedColumns(columns);
	const keyColumns = columns.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk);
	const rowidColumn =
		!object.withoutRowid && keyColumns.length === 1 && !keyIndexed ? keyColumns[0].name : null;

	const alias = reachableRowidAlias(object, columns);
	if (alias) {
		return { editable: true, identity: { kind: 'rowid', alias, rowidColumn }, readOnlyColumns };
	}
	if (keyColumns.length > 0) {
		return {
			editable: true,
			identity: {
				kind: 'primary-key',
				columns: keyColumns.map((column) => column.name),
				keyMayBeNull:
					!object.withoutRowid &&
					rowidColumn === null &&
					keyColumns.some((column) => column.notnull !== 1),
			},
			readOnlyColumns,
		};
	}
	return readOnly(
		'no-identity',
		`${name} has columns named rowid, _rowid_, and oid that hide its rowid, and no primary key, so an edit cannot name one row.`
	);
}

/**
 * The columns a statement reads to name a row by this identity, in order:
 * the rowid alias, or every primary-key column in key order.
 */
export function sqliteRowKeyColumns(identity: SqliteRowIdentity): string[] {
	return identity.kind === 'rowid' ? [identity.alias] : [...identity.columns];
}

const INTEGER_TEXT = /^-?\d+$/;
const HEX_TEXT = /^(?:[0-9a-f]{2})*$/i;

/**
 * A key value as the driver binds it, so it compares equal to exactly the
 * stored value: an INTEGER as a BigInt, a REAL as a double, TEXT as a
 * string, a BLOB as bytes. Throws on a malformed value; returns null for NULL.
 */
export function sqliteKeyBindValue(
	value: SqliteKeyValue | undefined,
	column: string
): bigint | number | string | Buffer | null {
	if (value === null) return null;
	const malformed = () => new Error(`The key value given for ${column} is not a stored value.`);
	if (!value || typeof value !== 'object' || typeof value.text !== 'string') throw malformed();
	switch (value.type) {
		case 'integer':
			if (!INTEGER_TEXT.test(value.text)) throw malformed();
			return BigInt(value.text);
		case 'real': {
			const number = Number(value.text);
			if (value.text.trim() === '' || Number.isNaN(number)) throw malformed();
			return number;
		}
		case 'text':
			return value.text;
		case 'blob':
			if (!HEX_TEXT.test(value.text)) throw malformed();
			return Buffer.from(value.text, 'hex');
		default:
			throw malformed();
	}
}

/** A key value as a person reads it in a message: `42`, `'abc'`, `x'00ff'`, `NULL`. */
function keyValueLabel(value: SqliteKeyValue): string {
	if (value === null) return 'NULL';
	const text = value.text.length > 40 ? `${value.text.slice(0, 40)}…` : value.text;
	if (value.type === 'text') return `'${text}'`;
	if (value.type === 'blob') return `x'${text}'`;
	return text;
}

/** A row's `WHERE`, its bound values, and how a message names the row. */
export interface SqliteRowKeyCondition {
	/** `"rowid" = ?`, or `"a" = ? AND "b" = ?` in key order. */
	where: string;
	params: Array<bigint | number | string | Buffer>;
	/** `rowid 42`, or `primary key (a = 1, b = 'x')`. */
	label: string;
}

/**
 * The `WHERE` that names exactly one row of a table by its identity. Throws,
 * before anything runs, when `key` is not that identity's kind, leaves out a
 * key column or names one the key does not have, holds a malformed value, or
 * holds a NULL: NULL never compares equal, so such a row cannot be named.
 */
export function sqliteRowKeyCondition(
	identity: SqliteRowIdentity,
	key: SqliteRowKey | null | undefined,
	objectName: string
): SqliteRowKeyCondition {
	if (identity.kind === 'rowid') {
		if (key?.kind !== 'rowid') {
			throw new Error(`${objectName} names its rows by rowid; give the row's rowid.`);
		}
		const rowid = String(key.rowid);
		if (!SQLITE_ROWID_TEXT.test(rowid)) throw new Error(`Not a rowid: ${rowid}`);
		return {
			where: `${quoteSqliteIdentifier(identity.alias)} = ?`,
			params: [BigInt(rowid)],
			label: `rowid ${rowid}`,
		};
	}

	const keyNames = identity.columns.join(', ');
	if (key?.kind !== 'primary-key' || !key.values || typeof key.values !== 'object') {
		throw new Error(
			`${objectName} names its rows by its primary key (${keyNames}); give a value for each key column.`
		);
	}
	const given = Object.keys(key.values);
	const extra = given.filter((name) => !identity.columns.includes(name));
	const missing = identity.columns.filter(
		(name) => !Object.prototype.hasOwnProperty.call(key.values, name)
	);
	if (extra.length > 0 || missing.length > 0) {
		const problems = [
			missing.length > 0 ? `no value for ${missing.join(', ')}` : '',
			extra.length > 0 ? `${extra.join(', ')} ${extra.length === 1 ? 'is' : 'are'} not in it` : '',
		].filter(Boolean);
		throw new Error(`The primary key of ${objectName} is (${keyNames}): ${problems.join('; ')}.`);
	}

	const terms: string[] = [];
	const params: SqliteRowKeyCondition['params'] = [];
	const labels: string[] = [];
	for (const column of identity.columns) {
		const value = key.values[column];
		const bound = sqliteKeyBindValue(value, column);
		if (bound === null) {
			throw new Error(
				`This row's primary key holds NULL in ${column}, and NULL never equals anything, so the row cannot be named for a change.`
			);
		}
		terms.push(`${quoteSqliteIdentifier(column)} = ?`);
		params.push(bound);
		labels.push(`${column} = ${keyValueLabel(value)}`);
	}
	return { where: terms.join(' AND '), params, label: `primary key (${labels.join(', ')})` };
}
