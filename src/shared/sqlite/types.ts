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
