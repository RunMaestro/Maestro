/**
 * SQLite IPC Handlers
 *
 * The renderer's view of a SQLite database goes through these calls. As with
 * parquet, no database bytes cross IPC: `open` returns a summary and a handle,
 * the table-list and schema calls return names, numbers, and schema text,
 * the row calls return one bounded window of cells, and the read-only
 * connection stays in this process (see src/main/sqlite/sqlite-database.ts).
 */

import { ipcMain } from 'electron';

import type {
	SqliteDatabaseInfo,
	SqliteObjectKind,
	SqliteObjectList,
	SqliteObjectSchema,
	SqliteObjectStats,
	SqliteRowsPage,
	SqliteRowsRequest,
} from '../../../shared/sqlite/types';
import { closeSqliteDatabase, openSqliteDatabase } from '../../sqlite/sqlite-database';
import { listSqliteObjects, readSqliteObjectStats } from '../../sqlite/sqlite-objects';
import { readSqliteRows } from '../../sqlite/sqlite-rows';
import { readSqliteObjectSchema } from '../../sqlite/sqlite-schema';

export function registerSqliteHandlers(): void {
	// Open a local database read-only. Reuses the connection already open on
	// the same file, so two tabs on one database share a descriptor.
	ipcMain.handle(
		'sqlite:open',
		async (_event, filePath: string): Promise<SqliteDatabaseInfo> => openSqliteDatabase(filePath)
	);

	// The table-list rail: every table, view, index, and trigger. Reads only
	// sqlite_master, so it is instant whatever the database's size.
	ipcMain.handle(
		'sqlite:listObjects',
		async (_event, handle: string): Promise<SqliteObjectList> => listSqliteObjects(handle)
	);

	// Row counts and sizes for the named objects, measured against a time
	// budget. The reply covers a prefix of `names`; the renderer asks again for
	// the rest, so the main process is never held for a whole database.
	ipcMain.handle(
		'sqlite:readObjectStats',
		async (_event, handle: string, names: string[]): Promise<SqliteObjectStats[]> =>
			readSqliteObjectStats(handle, names)
	);

	// One object's structure for the content pane: columns with type,
	// affinity, nullability, default, primary key and foreign-key targets, an
	// index's key columns, and the original CREATE SQL. Schema metadata only.
	ipcMain.handle(
		'sqlite:readSchema',
		async (
			_event,
			handle: string,
			name: string,
			kind?: SqliteObjectKind
		): Promise<SqliteObjectSchema> => readSqliteObjectSchema(handle, name, kind)
	);

	// One window of a table's or view's rows for the table view: LIMIT/OFFSET
	// paged, optionally sorted by one column in SQLite. Long TEXT and BLOB
	// values arrive cut to a head plus their length.
	ipcMain.handle(
		'sqlite:readRows',
		async (_event, request: SqliteRowsRequest): Promise<SqliteRowsPage> => readSqliteRows(request)
	);

	// Release the connection. Called when the tab closes; idle handles are
	// also reaped, so a missed close leaks nothing permanent.
	ipcMain.handle(
		'sqlite:close',
		async (_event, handle: string): Promise<void> => closeSqliteDatabase(handle)
	);
}
