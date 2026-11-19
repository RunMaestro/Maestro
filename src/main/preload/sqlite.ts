/**
 * Preload API for SQLite previews
 *
 * Exposes window.maestro.sqlite: open a database read-only, list its schema
 * objects, measure their row counts and sizes, read one object's structure,
 * read a window of a table's rows, close the handle.
 */

import { ipcRenderer } from 'electron';
import type {
	SqliteDatabaseInfo,
	SqliteObjectKind,
	SqliteObjectList,
	SqliteObjectSchema,
	SqliteObjectStats,
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
		 * One window of a table's or view's rows (`LIMIT`/`OFFSET`), sorted in
		 * SQLite when `sort` is set. `hasMore` says whether another page exists.
		 */
		readRows: (request: SqliteRowsRequest): Promise<SqliteRowsPage> =>
			ipcRenderer.invoke('sqlite:readRows', request),

		/** Release the read-only connection. */
		close: (handle: string): Promise<void> => ipcRenderer.invoke('sqlite:close', handle),
	};
}
