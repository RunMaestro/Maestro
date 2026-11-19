/**
 * Pure helpers over a schema object's structure, shared by the main-process
 * schema reader, the viewer's schema pane, and `maestro-cli sqlite schema`, so
 * affinity is derived once and references, defaults, and editability read the
 * same everywhere.
 */

import type {
	SqliteAffinity,
	SqliteColumnSchema,
	SqliteEditability,
	SqliteForeignKey,
	SqliteIndexColumnSchema,
	SqliteIndexOrigin,
	SqliteObjectSchema,
	SqliteReadOnlyCode,
} from './types';

/**
 * The affinity SQLite gives a column with this declared type, by the five
 * rules of https://www.sqlite.org/datatype3.html#determination_of_column_affinity,
 * applied in order on the uppercased type:
 *
 *   1. contains `INT`                   -> INTEGER
 *   2. contains `CHAR`, `CLOB`, `TEXT`  -> TEXT
 *   3. contains `BLOB`, or no type      -> BLOB
 *   4. contains `REAL`, `FLOA`, `DOUB`  -> REAL
 *   5. anything else                    -> NUMERIC
 *
 * The rules match substrings, so `POINT` is INTEGER and `STRING` is NUMERIC;
 * that is SQLite's behaviour, not a bug here. In a `STRICT` table an `ANY`
 * column converts nothing, which is BLOB affinity; in an ordinary table `ANY`
 * falls to rule 5 like any other unknown word.
 */
export function sqliteColumnAffinity(declaredType: string, strict = false): SqliteAffinity {
	const type = declaredType.toUpperCase();
	if (type.includes('INT')) return 'INTEGER';
	if (type.includes('CHAR') || type.includes('CLOB') || type.includes('TEXT')) return 'TEXT';
	if (type.includes('BLOB') || type.trim() === '') return 'BLOB';
	if (type.includes('REAL') || type.includes('FLOA') || type.includes('DOUB')) return 'REAL';
	if (strict && type.trim() === 'ANY') return 'BLOB';
	return 'NUMERIC';
}

/** `orders.id`, or `orders (primary key)` when the key names no parent column. */
export function formatSqliteReference(target: { table: string; column: string | null }): string {
	return target.column === null
		? `${target.table} (primary key)`
		: `${target.table}.${target.column}`;
}

/** Every reference a column makes, comma-separated, or an empty string. */
export function formatSqliteColumnReferences(column: SqliteColumnSchema): string {
	return column.references.map(formatSqliteReference).join(', ');
}

/** A whole foreign key: `(a, b) -> parent(x, y) ON DELETE CASCADE`. */
export function formatSqliteForeignKey(key: SqliteForeignKey): string {
	const to = key.to.some((column) => column === null)
		? `${key.table} (primary key)`
		: `${key.table}(${key.to.join(', ')})`;
	const actions = [
		key.onUpdate !== 'NO ACTION' ? `ON UPDATE ${key.onUpdate}` : null,
		key.onDelete !== 'NO ACTION' ? `ON DELETE ${key.onDelete}` : null,
	].filter((action): action is string => action !== null);
	return [`(${key.from.join(', ')}) -> ${to}`, ...actions].join(' ');
}

/** Short tags for a column's constraints: `not null`, `generated (stored)`, `hidden`. */
export function sqliteColumnTags(column: SqliteColumnSchema): string[] {
	const tags: string[] = [];
	if (column.notNull) tags.push('not null');
	if (column.generated) tags.push(`generated (${column.generated})`);
	if (column.hidden) tags.push('hidden');
	return tags;
}

/** What made an index, as a reader would say it. */
export const SQLITE_INDEX_ORIGIN_LABELS: Record<SqliteIndexOrigin, string> = {
	'create-index': 'CREATE INDEX',
	unique: 'UNIQUE constraint',
	'primary-key': 'PRIMARY KEY constraint',
};

/** An index key column: its name, or `<expression>` for an indexed expression. */
export function formatSqliteIndexColumn(column: SqliteIndexColumnSchema): string {
	return column.name ?? '<expression>';
}

/**
 * Why an object has no `CREATE` statement, or null when it has one. Only an
 * index SQLite built itself for a constraint lacks one.
 */
export function sqliteMissingSqlNote(
	schema: Pick<SqliteObjectSchema, 'sql' | 'kind'>
): string | null {
	if (schema.sql !== null) return null;
	return schema.kind === 'index'
		? "SQLite created this index to enforce a UNIQUE or PRIMARY KEY constraint, so it has no CREATE statement of its own. The constraint is in the table's CREATE TABLE."
		: 'SQLite stores no CREATE statement for this object.';
}

/** Why an object is read-only, in two or three words (the table view's footer). */
export const SQLITE_READ_ONLY_LABELS: Record<SqliteReadOnlyCode, string> = {
	view: 'view',
	'virtual-table': 'virtual table',
	'shadow-table': 'shadow table',
	'internal-table': 'internal table',
	'no-identity': 'no row identity',
	unreadable: 'columns unreadable',
};

/** Short: `rows keyed by rowid`, `rows keyed by primary key`, or `read-only: view`. */
export function sqliteEditabilityLabel(editability: SqliteEditability): string {
	if (!editability.editable) return `read-only: ${SQLITE_READ_ONLY_LABELS[editability.code]}`;
	return editability.identity.kind === 'rowid'
		? 'rows keyed by rowid'
		: 'rows keyed by primary key';
}

/**
 * In full: how an edit names a row and which columns it may not write, or the
 * whole reason the object is read-only.
 */
export function formatSqliteEditability(editability: SqliteEditability): string {
	if (!editability.editable) return `Read-only. ${editability.reason}`;
	const { identity, readOnlyColumns } = editability;
	const sentences =
		identity.kind === 'rowid'
			? [
					identity.rowidColumn
						? `Editable. An edit names its row by rowid, which is the column ${identity.rowidColumn}.`
						: 'Editable. An edit names its row by rowid.',
				]
			: [
					`Editable. An edit names its row by the primary key (${identity.columns.join(', ')}).`,
					...(identity.keyMayBeNull ? ['A row whose key holds NULL cannot be edited.'] : []),
				];
	if (readOnlyColumns.length > 0) {
		sentences.push(
			`Generated columns cannot be edited: ${readOnlyColumns.map((column) => column.name).join(', ')}.`
		);
	}
	return sentences.join(' ');
}

/**
 * Why a CLI write is refused without its per-call unlock (`--enable-editing`),
 * the CLI's counterpart of a tab's "Enable editing". Shared by the CLI and the
 * app's WebSocket handler, which refuses the message too.
 */
export const SQLITE_CLI_UNLOCK_REQUIRED_MESSAGE =
	'This changes the database. Pass --enable-editing to unlock editing for this one call.';
