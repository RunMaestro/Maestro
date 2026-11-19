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

import type { ParquetFilterProblem } from '../parquet/types';
import type { TabularExportFormat } from '../tabularExport';

/**
 * Filter text that did not parse or bind, with the span to underline. The
 * table view's filter speaks the Parquet viewer's language
 * (src/shared/sqlite/filter.ts), so the problem has the same shape.
 */
export type SqliteFilterProblem = ParquetFilterProblem;

/** What opening a database returns. Later calls name the database by `handle`. */
export interface SqliteDatabaseInfo {
	/** Opaque id of the main-process connection. */
	handle: string;
	/** Path as the user knows it. */
	displayPath: string;
	/** Size of the main database file at open, excluding any `-wal` sidecar. */
	fileBytes: number;
}

/**
 * One tab's permission to write to an open database: what "Enable editing"
 * returns (src/main/sqlite/sqlite-editing.ts). Every write sends `editToken`
 * back. It dies when the tab locks again or closes, or the handle is released;
 * other tabs on the same file never share it.
 */
export interface SqliteEditingGrant {
	handle: string;
	/** Opaque. */
	editToken: string;
}

/**
 * The copy of a database taken before the app first wrote to it this session
 * (src/main/sqlite/sqlite-backup.ts): a `VACUUM INTO` snapshot beside the
 * file. Every write result that made the backup carries it, so the viewer can
 * say where it went.
 */
export interface SqliteBackup {
	/** Absolute path of the backup file. */
	path: string;
	/** Its size on disk. */
	bytes: number;
	/** When it was taken, epoch ms. */
	createdAt: number;
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

/** One column as the SQL editor's completion offers it. */
export interface SqliteCatalogColumn {
	name: string;
	/** The declared type, verbatim; empty when none was given. */
	declaredType: string;
}

/** A table or view whose columns the SQL editor can complete. */
export interface SqliteCatalogObject {
	name: string;
	kind: 'table' | 'view';
	/** `sqlite_*` tables and shadow tables, which completion ranks below user objects. */
	internal: boolean;
	/** Columns in declaration order; empty when they could not be read. */
	columns: SqliteCatalogColumn[];
}

/**
 * Every table's and view's column names, in one read, for the SQL editor's
 * schema-aware completion. Lighter than `SqliteObjectSchema`: no keys, no SQL.
 */
export interface SqliteColumnCatalog {
	objects: SqliteCatalogObject[];
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
	/**
	 * Filter expression in the viewer's filter language, compiled to a
	 * parameterised `WHERE`. Empty or absent means every row.
	 */
	filter?: string | null;
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
	/**
	 * Each row's rowid as decimal text (a rowid may pass 2^53), parallel to
	 * `rows`. Null when the object has no reachable rowid: a view, a virtual
	 * table, a `WITHOUT ROWID` table, or one whose columns shadow every alias.
	 */
	rowids: string[] | null;
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
	/** True when a filter narrowed the rows; `offset` and `hasMore` count matches. */
	filtered: boolean;
	/**
	 * Set when the filter did not parse or bind. Nothing was read: `rows` is
	 * empty and `filtered` is false, so a caller keeps showing what it had.
	 */
	filterProblem?: SqliteFilterProblem;
}

/**
 * Where an unfinished count stopped, handed back verbatim to resume it. The
 * main process keeps no counting state between calls, so the renderer holds
 * this and the walk survives any number of interleaved row reads.
 */
export interface SqliteCountCursor {
	/** Rows that matched so far. */
	matched: number;
	/** Rows walked so far, matching or not. Also the resume `OFFSET` for a source with no rowid. */
	scanned: number;
	/**
	 * The last rowid walked, as decimal text (a rowid may pass 2^53), or null
	 * when the source has no rowid or nothing was walked yet.
	 */
	afterRowid: string | null;
}

/** Count the rows of a table or view that a filter matches, a time budget at a time. */
export interface SqliteCountRequest {
	handle: string;
	/** The table or view to count. */
	name: string;
	/** Filter expression, compiled exactly as `SqliteRowsRequest.filter` is. */
	filter?: string | null;
	/** Resume where the previous call stopped; absent or null starts at the first row. */
	cursor?: SqliteCountCursor | null;
}

/**
 * What `countSqliteRows()` returns: a count that only ever grows until it
 * settles. While `complete` is false, `matched` is a lower bound (shown as
 * `1,204+`) and `cursor` resumes the walk.
 */
export interface SqliteRowCount {
	name: string;
	/** Rows matched so far; the exact count once `complete`. */
	matched: number;
	/** Every row has been walked, so `matched` is exact. */
	complete: boolean;
	/** Pass back to continue; null once complete or on a filter problem. */
	cursor: SqliteCountCursor | null;
	/** True when a filter narrowed the count. */
	filtered: boolean;
	/** Time SQLite spent in this call, in milliseconds. */
	elapsedMs: number;
	/** Set when the filter did not parse or bind. Nothing was counted. */
	filterProblem?: SqliteFilterProblem;
}

/**
 * Save one BLOB cell to a file, whole. The row is named by its rowid when its
 * page carried one, which is exact; otherwise by its position in the window it
 * was read in, which only holds while the data has not changed, so `expected`
 * guards it.
 */
export interface SqliteBlobRequest {
	handle: string;
	/** The table or view the row belongs to. */
	name: string;
	/** The column holding the BLOB. */
	column: string;
	/** The row's rowid from `SqliteRowsPage.rowids`; wins over the position. */
	rowid?: string | null;
	/** Otherwise: the row's position, read with this sort and filter. */
	offset?: number | null;
	sort?: SqliteSortSpec | null;
	filter?: string | null;
	/**
	 * What the cell showed (its size and hex head). The save is refused when
	 * the stored value no longer matches, rather than writing another row's bytes.
	 */
	expected?: { bytes: number; head: string } | null;
	/** Absolute path to write. Parent folders are created; an existing file is replaced. */
	destPath: string;
}

/** What `saveSqliteBlob()` wrote. */
export interface SqliteBlobSaved {
	path: string;
	bytes: number;
	/** The rowid of the row it came from, when the object has one. */
	rowid: string | null;
}

/**
 * Database-wide facts for the viewer's summary strip, read from the file
 * header through pragmas. Every value is a header field, so reading them
 * costs nothing whatever the database's size.
 */
export interface SqliteDatabaseSummary {
	/** Bytes per page (`PRAGMA page_size`). */
	pageSize: number;
	/** Pages in the main file (`PRAGMA page_count`), so `pageSize * pageCount` is its size. */
	pageCount: number;
	/** Unused pages on the free list (`PRAGMA freelist_count`): space a `VACUUM` would return. */
	freelistCount: number;
	/** Text encoding: `UTF-8`, `UTF-16le`, or `UTF-16be`. */
	encoding: string;
	/**
	 * Journal mode as the read-only connection sees it, lower case (`wal`,
	 * `delete`, ...). `wal` is recorded in the file itself; the rollback modes
	 * are per connection, so any of them reads as `delete` here.
	 */
	journalMode: string;
	/** `PRAGMA user_version`: the schema version an application keeps, 0 when unused. */
	userVersion: number;
	/** `PRAGMA application_id`: the file format an application stamped, 0 when unused. */
	applicationId: number;
	/** Version of the SQLite library reading the file (`sqlite_version()`). */
	sqliteVersion: string;
}

/**
 * Which integrity check to run. `quick` (`PRAGMA quick_check`) verifies every
 * page and record in linear time; `full` (`PRAGMA integrity_check`) also
 * checks that every index matches its table and UNIQUE holds, which is slower.
 */
export type SqliteIntegrityMode = 'quick' | 'full';

/** The verdict of one integrity check. */
export interface SqliteIntegrityResult {
	mode: SqliteIntegrityMode;
	/** SQLite answered `ok`: no problem found. */
	ok: boolean;
	/** Each problem SQLite reported, verbatim; empty when `ok`. */
	problems: string[];
	/** More problems exist than `problems` holds (the check stops at a cap). */
	truncated: boolean;
	/** Wall time of the check, in milliseconds. */
	elapsedMs: number;
}

/**
 * Run one read-only statement a person wrote (the viewer's Query mode,
 * `maestro-cli sqlite query`). The statement runs in a child process with a
 * connection of its own, so it can be killed, and a window of its rows
 * comes back; see src/main/sqlite/sqlite-query.ts.
 */
export interface SqliteQueryRequest {
	handle: string;
	/** One statement: SELECT, WITH, VALUES, EXPLAIN, or a read PRAGMA. */
	sql: string;
	/** Result rows to skip before the window starts. Default 0. */
	offset?: number;
	/** Rows to return, clamped to `SQLITE_QUERY_MAX_LIMIT`. Default `SQLITE_QUERY_PAGE_ROWS`. */
	limit?: number;
	/**
	 * Values for the statement's parameters (`?`, `?3`, `:id`), keyed by
	 * `SqliteQueryParameter.label`. Every parameter the statement holds needs
	 * one; extra keys are ignored. Bound by the driver, never spliced into the
	 * text (see `sqliteQueryBinding()` in src/shared/sqlite/query.ts).
	 */
	params?: SqliteParameterValues;
	/**
	 * Run `EXPLAIN QUERY PLAN <sql>` instead, so the rows are the statement's
	 * plan (`id`, `parent`, `notused`, `detail`) and none of its own rows are
	 * read. The statement is still judged read-only as written; one that is
	 * already an EXPLAIN is refused. See `sqliteQueryPlanSteps()`.
	 */
	plan?: boolean;
	/**
	 * Names this run so `cancelQuery` can stop it. A new run under an id still
	 * running stops the older one first.
	 */
	queryId?: string | null;
}

/**
 * How a parameter's text binds: as TEXT, as a number (an integer exactly, a
 * `bigint` past 2^53, or a double), or as NULL (the text is ignored).
 */
export type SqliteParameterType = 'text' | 'number' | 'null';

/** The value a person gave one parameter. */
export interface SqliteParameterValue {
	type: SqliteParameterType;
	text: string;
}

/** Parameter values keyed by `SqliteQueryParameter.label`. */
export type SqliteParameterValues = Record<string, SqliteParameterValue>;

/**
 * One parameter a statement binds, as `sqliteQueryParameters()` finds it in
 * the text. A name used twice (`:id ... :id`) is one parameter.
 */
export interface SqliteQueryParameter {
	/**
	 * What the parameter is called and its value is keyed by: `:id`, `@id`,
	 * `$id`, or `?3` as first written, and `?1`, `?2`, ... by order for a bare
	 * `?`.
	 */
	label: string;
	/** A bare `?`, bound by position rather than by name. */
	anonymous: boolean;
}

/** One window of a statement's result. */
export interface SqliteQueryResult {
	/** The statement's leading keyword, upper case (`SELECT`, `PRAGMA`, ...). */
	statement: string;
	/** The rows are the statement's `EXPLAIN QUERY PLAN`, not its result. */
	plan?: boolean;
	/** Result columns in statement order. Names may repeat (`SELECT a, a`). */
	columns: SqliteResultColumn[];
	/** Cells in `columns` order, cut the way a table window cuts them. */
	rows: SqliteCellValue[][];
	/** The result row the window starts at. */
	offset: number;
	/** At least one result row exists past this window. */
	hasMore: boolean;
	/**
	 * False for a statement that returns no rows by design (a PRAGMA that sets
	 * a connection-only value). It ran on the query's own connection, which is
	 * closed after it, so it changed nothing anyone else sees.
	 */
	returnsRows: boolean;
	/** Time SQLite spent producing the window, in milliseconds. */
	elapsedMs: number;
}

/**
 * Write a statement's WHOLE result to a file as CSV or JSON Lines (Query
 * mode's Export, `maestro-cli sqlite query --output`). The statement runs
 * read-only in a child process, exactly as a Run does, and the rows are
 * written there, whole (no cell is cut), so none of them cross IPC; see
 * `exportSqliteQuery()` in src/main/sqlite/sqlite-query.ts.
 */
export interface SqliteQueryExportRequest {
	handle: string;
	/** One read-only statement, as for `SqliteQueryRequest.sql`. */
	sql: string;
	/** Values for its parameters, as for `SqliteQueryRequest.params`. */
	params?: SqliteParameterValues;
	/** Absolute path of the file to write. A file already there is replaced once the export succeeds. */
	destPath: string;
	/** Default: from `destPath`'s extension (`tabularExportFormatForPath()`). */
	format?: TabularExportFormat;
	/** Names the export so `cancelQuery` can stop it, as for a run. */
	queryId?: string | null;
}

/** What an export wrote. */
export interface SqliteQueryExported {
	/** The file written. */
	path: string;
	format: TabularExportFormat;
	/** Result rows written (the CSV header line not counted). */
	rows: number;
	/** Result columns per row. */
	columns: number;
	/** Size of the file written, in bytes. */
	bytes: number;
	/** Time from the statement's start to the last row written, in milliseconds. */
	elapsedMs: number;
}

/** How a statement in the history last ended. */
export type SqliteQueryHistoryOutcome =
	| {
			ok: true;
			/** Rows in its first window (`SQLITE_QUERY_PAGE_ROWS` at most for a Run). */
			rows: number;
			/** More rows followed that window. */
			hasMore: boolean;
			/** False for a statement that returns no rows by design. */
			returnsRows: boolean;
			elapsedMs: number;
	  }
	| {
			ok: false;
			/** SQLite's message, the timeout, or the stop, cut to a readable length. */
			error: string;
	  };

/**
 * One statement in a database's query history: what ran against the file in
 * Query mode or through `maestro-cli sqlite query`. A statement run again is
 * the same entry, moved to the top, with its latest values and outcome.
 */
export interface SqliteQueryHistoryEntry {
	id: string;
	/** The statement as it ran. */
	sql: string;
	/** It ran as `EXPLAIN QUERY PLAN` (the Plan toggle). */
	plan: boolean;
	/** The parameter values of its latest run, keyed by label. */
	params: SqliteParameterValues;
	/** When it last ran, epoch milliseconds. */
	ranAt: number;
	/** How many times it has run. */
	runs: number;
	outcome: SqliteQueryHistoryOutcome;
}

/** One database's query history, newest first. */
export interface SqliteQueryHistory {
	/** The database's path, which the history is kept under. */
	path: string;
	entries: SqliteQueryHistoryEntry[];
}
