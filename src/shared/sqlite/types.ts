/**
 * SQLite Preview Types
 *
 * The wire contract between the main-process SQLite engine (src/main/sqlite/)
 * and the renderer's SQLite viewer.
 *
 * As with parquet (src/shared/parquet/types.ts), bytes never cross IPC: the
 * database stays behind a read-only connection in the main process, and the
 * renderer addresses it by the opaque `handle` it got back from opening it.
 */

/** What opening a database returns. Later calls name the database by `handle`. */
export interface SqliteDatabaseInfo {
	/** Opaque id of the main-process connection. */
	handle: string;
	/** Path as the user knows it. */
	displayPath: string;
	/** Size of the main database file at open, excluding any `-wal` sidecar. */
	fileBytes: number;
}

/** The four kinds of schema object the table-list rail shows, in rail order. */
export type SqliteObjectKind = 'table' | 'view' | 'index' | 'trigger';

/**
 * What kind of table a `table` object is, as `PRAGMA table_list` reports it.
 * `virtual` tables are backed by a module (FTS5, R*Tree) and have no b-tree of
 * their own; `shadow` tables are the hidden storage such a module keeps.
 */
export type SqliteTableType = 'table' | 'virtual' | 'shadow';

/** One entry in `sqlite_master`, as the table-list rail needs it. */
export interface SqliteObjectSummary {
	name: string;
	kind: SqliteObjectKind;
	/**
	 * The table an index or trigger belongs to. For a table or view, its own
	 * name (that is what `sqlite_master.tbl_name` holds).
	 */
	tableName: string;
	/** Set for `kind: 'table'` only. */
	tableType?: SqliteTableType;
	/** A `WITHOUT ROWID` table: rows have no `rowid`, only their primary key. */
	withoutRowid?: boolean;
	/** A `STRICT` table: declared types are enforced rather than advisory. */
	strict?: boolean;
	/**
	 * Created by SQLite or by a virtual-table module, not by the schema's
	 * author: `sqlite_sequence`, `sqlite_stat1`, `sqlite_autoindex_*`, and FTS
	 * shadow tables. The rail hides these unless asked.
	 */
	internal: boolean;
	/** Whether a row count means anything: every table, including virtual ones. */
	countable: boolean;
	/** Whether the object owns pages on disk (a b-tree), so it has a size. */
	hasStorage: boolean;
}

/** The objects in a database's main schema. */
export interface SqliteObjectList {
	objects: SqliteObjectSummary[];
	/**
	 * Whether on-disk sizes can be measured. False when the SQLite build lacks
	 * the `dbstat` table, or when the database is too large to walk on the main
	 * process; `sizeNote` says which.
	 */
	sizesAvailable: boolean;
	sizeNote?: string;
}

/** Row count and on-disk size of one object, measured on request. */
export interface SqliteObjectStats {
	name: string;
	/** Rows counted, or null when the object has no rows or the count failed. */
	rowCount: number | null;
	/**
	 * The count stopped at the cap, so `rowCount` is a lower bound and renders
	 * as `100,000+`. Counting is capped because better-sqlite3 is synchronous:
	 * an exact `COUNT(*)` over a huge table would freeze the main process.
	 */
	rowCountCapped: boolean;
	/** Bytes of pages the object's b-tree occupies, or null when not measured. */
	sizeBytes: number | null;
	/** Why the count or the size failed, verbatim from SQLite. */
	error?: string;
}

/**
 * A column's type affinity: the storage class SQLite prefers for its values.
 * Affinity is a preference, not a constraint, unless the table is `STRICT`:
 * an `INTEGER` column in an ordinary table will still store `'banana'`.
 */
export type SqliteAffinity = 'INTEGER' | 'REAL' | 'NUMERIC' | 'TEXT' | 'BLOB';

/** Where one foreign-key column points. */
export interface SqliteForeignKeyTarget {
	table: string;
	/** The parent column, or null when the key names the parent's primary key. */
	column: string | null;
}

/** One column of a table or view, from `PRAGMA table_xinfo`. */
export interface SqliteColumnSchema {
	name: string;
	/** The type as written in the `CREATE` statement; empty when none was given. */
	declaredType: string;
	/** The affinity SQLite derives from `declaredType`. */
	affinity: SqliteAffinity;
	notNull: boolean;
	/** The default as SQL text (`'draft'`, `0`, `CURRENT_TIMESTAMP`), or null. */
	defaultValue: string | null;
	/** 1-based position in the primary key, or 0 when not part of it. */
	primaryKeyPosition: number;
	/** A generated column, and whether its value is stored or computed on read. */
	generated?: 'virtual' | 'stored';
	/** A virtual table's hidden column (FTS5's table-named column, `rank`). */
	hidden?: boolean;
	/** Foreign keys this column takes part in, in declaration order. */
	references: SqliteForeignKeyTarget[];
}

/** One `FOREIGN KEY` (or `REFERENCES` clause), possibly over several columns. */
export interface SqliteForeignKey {
	/** The parent table. */
	table: string;
	/** Child columns, in key order. */
	from: string[];
	/** Parent columns, aligned with `from`; null entries mean the parent's primary key. */
	to: Array<string | null>;
	/** `NO ACTION`, `CASCADE`, `SET NULL`, `SET DEFAULT`, `RESTRICT`. */
	onUpdate: string;
	onDelete: string;
}

/** One key column of an index, from `PRAGMA index_xinfo`. */
export interface SqliteIndexColumnSchema {
	/** The indexed column, or null for an expression (`lower(email)`). */
	name: string | null;
	descending: boolean;
	collation: string;
}

/** How an index came to exist, as `PRAGMA index_list` reports it. */
export type SqliteIndexOrigin = 'create-index' | 'unique' | 'primary-key';

/** The structure of one schema object, read on demand for the content pane. */
export interface SqliteObjectSchema {
	name: string;
	kind: SqliteObjectKind;
	/** The table an index or trigger belongs to; the object's own name otherwise. */
	tableName: string;
	/**
	 * The original `CREATE` statement from `sqlite_master`, verbatim. Null for an
	 * index SQLite made itself to back a `UNIQUE` or `PRIMARY KEY` constraint.
	 */
	sql: string | null;
	/** Columns of a table or view, in declaration order. Empty for an index or trigger. */
	columns: SqliteColumnSchema[];
	/** A table's foreign keys. Empty for anything else. */
	foreignKeys: SqliteForeignKey[];
	/** Set for `kind: 'index'`: the key columns in index order. */
	index?: {
		columns: SqliteIndexColumnSchema[];
		unique: boolean;
		/** Has a `WHERE` clause, so it covers only some rows. */
		partial: boolean;
		origin: SqliteIndexOrigin;
	};
	/**
	 * Why the columns could not be read, verbatim from SQLite: a virtual table
	 * whose module this build lacks, or a view over a table that is gone. The
	 * `CREATE` SQL is still returned.
	 */
	error?: string;
}

/** A server-side sort for the table view: one column, one direction. */
export interface SqliteSortSpec {
	column: string;
	direction: 'asc' | 'desc';
}

/** One window of a table's or view's rows, asked for by the table view. */
export interface SqliteRowsRequest {
	handle: string;
	/** The table or view to read. */
	name: string;
	/** Rows to skip (`OFFSET`). */
	offset: number;
	/** Rows to return (`LIMIT`), clamped to `SQLITE_ROWS_MAX_LIMIT` by the reader. */
	limit: number;
	/** `ORDER BY` this column, or null for the table's own order. */
	sort?: SqliteSortSpec | null;
}

/** A result column, as the statement reports it. */
export interface SqliteResultColumn {
	name: string;
	/**
	 * The declared type of the table column behind it, or null for an
	 * expression (a view's `count(*)`).
	 */
	declaredType: string | null;
}

/**
 * One cell of a row window.
 *
 * Small values travel as themselves. Three kinds do not, because shipping them
 * whole would either lose information or move megabytes per page:
 *
 *  - `integer`: an INTEGER outside JavaScript's safe range, as decimal text,
 *    so `9007199254740993` is not silently rounded.
 *  - `text`: a TEXT value longer than `SQLITE_CELL_TEXT_LIMIT` characters,
 *    cut to that many, with its full length.
 *  - `blob`: a BLOB, as its first `SQLITE_CELL_BLOB_HEAD_BYTES` bytes in hex,
 *    with its full size.
 */
export type SqliteCellValue =
	| null
	| number
	| string
	| { kind: 'integer'; text: string }
	| { kind: 'text'; head: string; length: number }
	| { kind: 'blob'; head: string; bytes: number };

/** What `readSqliteRows()` returns: the requested window and whether more follow. */
export interface SqliteRowsPage {
	name: string;
	columns: SqliteResultColumn[];
	/** Cells in `columns` order. */
	rows: SqliteCellValue[][];
	/** The offset the window starts at. */
	offset: number;
	/** At least one row exists past this window. */
	hasMore: boolean;
	/**
	 * What makes the order stable from page to page: the sort column (if any)
	 * then `rowid` or the primary key. Empty when nothing does, as for a view
	 * with no sort, whose rows come back in whatever order SQLite scans them.
	 */
	orderedBy: string[];
	/** Time SQLite spent on the window, in milliseconds. */
	elapsedMs: number;
}
