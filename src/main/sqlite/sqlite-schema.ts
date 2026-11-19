/**
 * SQLite Schema Inspection
 *
 * What the viewer's content pane shows for the selected object: a table's or
 * view's columns (declared type, affinity, nullability, default, primary key
 * position, foreign-key targets), an index's key columns, and the original
 * `CREATE` statement from `sqlite_master`. Also the SQL editor's completion
 * catalog: every table's and view's column names in one read.
 *
 * Everything here reads schema metadata only (`sqlite_master` and the
 * `pragma_*` table-valued functions), never a row of user data, so it is
 * instant on any database and needs no time budget. The object's name is
 * always a BOUND parameter to the pragma function, so no identifier is
 * spliced into SQL text.
 */

import type Database from 'better-sqlite3';

import { sqliteColumnAffinity } from '../../shared/sqlite/schema';
import type {
	SqliteCatalogColumn,
	SqliteCatalogObject,
	SqliteColumnCatalog,
	SqliteColumnSchema,
	SqliteForeignKey,
	SqliteForeignKeyTarget,
	SqliteIndexOrigin,
	SqliteObjectKind,
	SqliteObjectSchema,
} from '../../shared/sqlite/types';
import { getSqliteDatabase } from './sqlite-database';
import { resolveSqliteEditability } from './sqlite-identity';
import { findSqliteObject, readSqliteObjectSummaries } from './sqlite-objects';

interface TableXinfoRow {
	cid: number;
	name: string;
	type: string;
	notnull: number;
	dflt_value: string | null;
	pk: number;
	/** 0 ordinary, 1 hidden (virtual table), 2 generated VIRTUAL, 3 generated STORED. */
	hidden: number;
}

interface ForeignKeyRow {
	id: number;
	seq: number;
	table: string;
	from: string;
	to: string | null;
	on_update: string;
	on_delete: string;
}

interface IndexXinfoRow {
	seqno: number;
	/** -1 for the rowid, -2 for an expression. */
	cid: number;
	name: string | null;
	desc: number;
	coll: string;
	/** 1 for a key column, 0 for the auxiliary columns SQLite appends. */
	key: number;
}

interface IndexListRow {
	name: string;
	unique: number;
	origin: string;
	partial: number;
}

const INDEX_ORIGINS: Record<string, SqliteIndexOrigin> = {
	c: 'create-index',
	u: 'unique',
	pk: 'primary-key',
};

/**
 * A table's foreign keys in declaration order. SQLite numbers them from the
 * LAST declared (id 0) backwards, so they are reversed here.
 */
function readForeignKeys(db: Database.Database, table: string): SqliteForeignKey[] {
	const rows = db
		.prepare('SELECT * FROM pragma_foreign_key_list(?, ?) ORDER BY id, seq')
		.all(table, 'main') as ForeignKeyRow[];
	const byId = new Map<number, SqliteForeignKey>();
	for (const row of rows) {
		let key = byId.get(row.id);
		if (!key) {
			key = {
				table: row.table,
				from: [],
				to: [],
				onUpdate: row.on_update,
				onDelete: row.on_delete,
			};
			byId.set(row.id, key);
		}
		key.from.push(row.from);
		key.to.push(row.to);
	}
	return [...byId.entries()].sort(([a], [b]) => b - a).map(([, key]) => key);
}

/** Columns of a table or view, each with the foreign keys it takes part in. */
function readColumns(
	db: Database.Database,
	name: string,
	strict: boolean,
	foreignKeys: readonly SqliteForeignKey[]
): SqliteColumnSchema[] {
	// Column names are case-insensitive in SQLite, and a FOREIGN KEY clause may
	// spell one differently from its definition.
	const references = new Map<string, SqliteForeignKeyTarget[]>();
	for (const key of foreignKeys) {
		key.from.forEach((column, position) => {
			const folded = column.toLowerCase();
			const list = references.get(folded) ?? [];
			list.push({ table: key.table, column: key.to[position] });
			references.set(folded, list);
		});
	}

	const rows = db
		.prepare('SELECT * FROM pragma_table_xinfo(?, ?) ORDER BY cid')
		.all(name, 'main') as TableXinfoRow[];
	return rows.map((row) => {
		const column: SqliteColumnSchema = {
			name: row.name,
			declaredType: row.type,
			affinity: sqliteColumnAffinity(row.type, strict),
			notNull: row.notnull === 1,
			defaultValue: row.dflt_value,
			primaryKeyPosition: row.pk,
			references: references.get(row.name.toLowerCase()) ?? [],
		};
		if (row.hidden === 1) column.hidden = true;
		if (row.hidden === 2) column.generated = 'virtual';
		if (row.hidden === 3) column.generated = 'stored';
		return column;
	});
}

/** An index's key columns and how it came to exist. */
function readIndex(
	db: Database.Database,
	name: string,
	table: string
): NonNullable<SqliteObjectSchema['index']> {
	const columns = (
		db
			.prepare('SELECT * FROM pragma_index_xinfo(?, ?) ORDER BY seqno')
			.all(name, 'main') as IndexXinfoRow[]
	)
		.filter((row) => row.key === 1)
		.map((row) => ({
			name: row.cid === -2 ? null : row.name,
			descending: row.desc === 1,
			collation: row.coll,
		}));
	const listed = (
		db.prepare('SELECT * FROM pragma_index_list(?, ?)').all(table, 'main') as IndexListRow[]
	).find((row) => row.name === name);
	return {
		columns,
		unique: listed?.unique === 1,
		partial: listed?.partial === 1,
		origin: INDEX_ORIGINS[listed?.origin ?? 'c'] ?? 'create-index',
	};
}

/**
 * The schema table itself. `sqlite_master` holds no row for itself, so it is
 * added by hand: it is the table people query most when exploring a file.
 */
const SCHEMA_TABLE = 'sqlite_master';

/**
 * Every table's and view's column names, for the SQL editor's completion.
 * One `pragma_table_xinfo` per object, name bound, so this stays schema
 * metadata only and instant on any size of database.
 *
 * An object whose columns cannot be read (a virtual table whose module this
 * build lacks, a view over a dropped table) is still listed, with no columns:
 * its name completes, and one broken view never empties the whole catalog.
 */
export function readSqliteColumnCatalog(handle: string): SqliteColumnCatalog {
	const { db } = getSqliteDatabase(handle);
	const columnsOf = db.prepare('SELECT name, type FROM pragma_table_xinfo(?, ?) ORDER BY cid');
	const readColumnNames = (name: string): SqliteCatalogColumn[] => {
		try {
			return (columnsOf.all(name, 'main') as Array<{ name: string; type: string }>).map((row) => ({
				name: row.name,
				declaredType: row.type,
			}));
		} catch {
			// Expected for the cases above; the name alone is still worth completing.
			return [];
		}
	};

	const objects: SqliteCatalogObject[] = readSqliteObjectSummaries(db)
		.filter((object) => object.kind === 'table' || object.kind === 'view')
		.map((object) => ({
			name: object.name,
			kind: object.kind as 'table' | 'view',
			internal: object.internal,
			columns: readColumnNames(object.name),
		}));
	objects.push({
		name: SCHEMA_TABLE,
		kind: 'table',
		internal: true,
		columns: readColumnNames(SCHEMA_TABLE),
	});
	return { objects };
}

/**
 * Read the structure of one schema object, and for a table or view whether
 * its rows can be edited (sqlite-identity.ts). Throws when no object has that
 * name; a failure to read the columns themselves (a virtual-table module this
 * build lacks, a view over a dropped table) is reported on `error` instead, so
 * the `CREATE` SQL still reaches the reader.
 *
 * `kind` picks between objects that share a name, which a trigger and a table
 * may; without it, the first in rail order wins.
 */
export function readSqliteObjectSchema(
	handle: string,
	name: string,
	kind?: SqliteObjectKind
): SqliteObjectSchema {
	const { db } = getSqliteDatabase(handle);
	const object = findSqliteObject(readSqliteObjectSummaries(db), name, kind);
	if (!object) {
		throw new Error(`No ${kind ?? 'table, view, index, or trigger'} is named ${name}.`);
	}
	const master = db
		.prepare('SELECT sql FROM sqlite_master WHERE name = ? AND type = ?')
		.get(name, object.kind) as { sql: string | null } | undefined;

	const schema: SqliteObjectSchema = {
		name,
		kind: object.kind,
		tableName: object.tableName,
		sql: master?.sql ?? null,
		columns: [],
		foreignKeys: [],
	};
	try {
		if (object.kind === 'table' || object.kind === 'view') {
			const foreignKeys = object.kind === 'table' ? readForeignKeys(db, name) : [];
			schema.columns = readColumns(db, name, object.strict === true, foreignKeys);
			schema.foreignKeys = foreignKeys;
		} else if (object.kind === 'index') {
			schema.index = readIndex(db, name, object.tableName);
		}
	} catch (error) {
		// Expected for a virtual table whose module is not in this build, or a
		// view whose source table was dropped. The SQL still explains the object.
		schema.error = error instanceof Error ? error.message : String(error);
	}
	if (object.kind === 'table' || object.kind === 'view') {
		// Outside the try: it never throws, and a table whose columns cannot be
		// read still deserves the reason it is read-only.
		schema.editability = resolveSqliteEditability(db, object);
	}
	return schema;
}
