/**
 * Preload API for SQLite previews
 *
 * Exposes window.maestro.sqlite: open a database read-only, read its summary,
 * check its integrity, list its schema
 * objects, measure their row counts and sizes, read one object's structure,
 * read every table's column names for SQL completion,
 * read a window of a table's rows, count its rows, save a BLOB to a file,
 * close the handle.
 */

import { ipcRenderer } from 'electron';
import type {
	SqliteBlobRequest,
	SqliteBlobSaved,
	SqliteColumnCatalog,
	SqliteCountRequest,
	SqliteDatabaseInfo,
	SqliteDatabaseSummary,
	SqliteIntegrityMode,
	SqliteIntegrityResult,
	SqliteObjectKind,
	SqliteObjectList,
	SqliteObjectSchema,
	SqliteObjectStats,
	SqliteRowCount,
	SqliteRowsPage,
	SqliteRowsRequest,
} from '../../shared/sqlite/types';

export function createSqliteApi() {
	return {
		/**
		 * Open a local SQLite database read-only. Returns a handle used by every
		 * subsequent call. Rejects with a readable message for a file that is not
		 * SQLite, is encrypted, or is damaged.
		 */
		open: (filePath: string): Promise<SqliteDatabaseInfo> =>
			ipcRenderer.invoke('sqlite:open', filePath),

		/**
		 * Database-wide facts from the header: page size and count, free pages,
		 * encoding, journal mode, user_version, application_id.
		 */
		readSummary: (handle: string): Promise<SqliteDatabaseSummary> =>
			ipcRenderer.invoke('sqlite:readSummary', handle),

		/**
		 * Run `PRAGMA quick_check` (`quick`) or `PRAGMA integrity_check`
		 * (`full`) on a worker thread. Resolves with the verdict; rejects when
		 * the check could not run or the database closed first.
		 */
		checkIntegrity: (handle: string, mode: SqliteIntegrityMode): Promise<SqliteIntegrityResult> =>
			ipcRenderer.invoke('sqlite:checkIntegrity', handle, mode),

		/** Every table, view, index, and trigger in the main schema. */
		listObjects: (handle: string): Promise<SqliteObjectList> =>
			ipcRenderer.invoke('sqlite:listObjects', handle),

		/**
		 * Row counts and on-disk sizes for the named objects. Answers for a
		 * prefix of `names` (at least one) within a time budget: ask again with
		 * the rest until every name has come back.
		 */
		readObjectStats: (handle: string, names: string[]): Promise<SqliteObjectStats[]> =>
			ipcRenderer.invoke('sqlite:readObjectStats', handle, names),

		/**
		 * One object's columns (type, affinity, nullability, default, primary
		 * key, foreign-key targets), index key columns, and CREATE SQL. `kind`
		 * picks between a trigger and a table that share a name.
		 */
		readSchema: (
			handle: string,
			name: string,
			kind?: SqliteObjectKind
		): Promise<SqliteObjectSchema> => ipcRenderer.invoke('sqlite:readSchema', handle, name, kind),

		/**
		 * Every table's and view's column names, for the SQL editor's
		 * schema-aware completion. An object whose columns cannot be read is
		 * listed with none.
		 */
		readColumns: (handle: string): Promise<SqliteColumnCatalog> =>
			ipcRenderer.invoke('sqlite:readColumns', handle),

		/**
		 * One window of a table's or view's rows (`LIMIT`/`OFFSET`), sorted in
		 * SQLite when `sort` is set. `hasMore` says whether another page exists.
		 */
		readRows: (request: SqliteRowsRequest): Promise<SqliteRowsPage> =>
			ipcRenderer.invoke('sqlite:readRows', request),

		/**
		 * Count the rows a filter matches, a time budget at a time. While
		 * `complete` is false the count is a lower bound: ask again with the
		 * returned `cursor` to continue it.
		 */
		countRows: (request: SqliteCountRequest): Promise<SqliteRowCount> =>
			ipcRenderer.invoke('sqlite:countRows', request),

		/**
		 * Write one BLOB cell to `destPath`, whole. The row is named by its rowid
		 * (from `readRows`) or its position; rejects when the stored value no
		 * longer matches `expected`.
		 */
		saveBlob: (request: SqliteBlobRequest): Promise<SqliteBlobSaved> =>
			ipcRenderer.invoke('sqlite:saveBlob', request),

		/** Release the read-only connection. */
		close: (handle: string): Promise<void> => ipcRenderer.invoke('sqlite:close', handle),
	};
}
