/**
 * Preload API for SQLite previews
 *
 * Exposes window.maestro.sqlite: open a database read-only, list its schema
 * objects, measure their row counts and sizes, close the handle.
 */

import { ipcRenderer } from 'electron';
import type {
	SqliteDatabaseInfo,
	SqliteObjectList,
	SqliteObjectStats,
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

		/** Release the read-only connection. */
		close: (handle: string): Promise<void> => ipcRenderer.invoke('sqlite:close', handle),
	};
}
