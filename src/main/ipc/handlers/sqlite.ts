/**
 * SQLite IPC Handlers
 *
 * The renderer's view of a SQLite database goes through these calls. As with
 * parquet, no database bytes cross IPC: `open` returns a summary and a handle,
 * the summary and integrity calls return header facts and a verdict, the
 * table-list and schema calls return names, numbers, and schema text,
 * the row calls return one bounded window of cells, a BLOB save writes the
 * value to disk here rather than shipping it, and the read-only
 * connection stays in this process (see src/main/sqlite/sqlite-database.ts).
 */

import { ipcMain } from 'electron';

import type {
	SqliteBlobRequest,
	SqliteBlobSaved,
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
} from '../../../shared/sqlite/types';
import { saveSqliteBlob } from '../../sqlite/sqlite-blob';
import { countSqliteRows } from '../../sqlite/sqlite-count';
import { closeSqliteDatabase, openSqliteDatabase } from '../../sqlite/sqlite-database';
import { checkSqliteIntegrity } from '../../sqlite/sqlite-integrity';
import { listSqliteObjects, readSqliteObjectStats } from '../../sqlite/sqlite-objects';
import { readSqliteRows } from '../../sqlite/sqlite-rows';
import { readSqliteObjectSchema } from '../../sqlite/sqlite-schema';
import { readSqliteDatabaseSummary } from '../../sqlite/sqlite-summary';

export function registerSqliteHandlers(): void {
	// Open a local database read-only. Reuses the connection already open on
	// the same file, so two tabs on one database share a descriptor.
	ipcMain.handle(
		'sqlite:open',
		async (_event, filePath: string): Promise<SqliteDatabaseInfo> => openSqliteDatabase(filePath)
	);

	// The summary strip: page size and count, encoding, journal mode,
	// user_version, application_id. Header pragmas only, so instant.
	ipcMain.handle(
		'sqlite:readSummary',
		async (_event, handle: string): Promise<SqliteDatabaseSummary> =>
			readSqliteDatabaseSummary(handle)
	);

	// The integrity flag. Reads every page, so it runs on a worker thread with
	// its own read-only connection; this call only waits for the verdict.
	ipcMain.handle(
		'sqlite:checkIntegrity',
		async (_event, handle: string, mode: SqliteIntegrityMode): Promise<SqliteIntegrityResult> =>
			checkSqliteIntegrity(handle, mode === 'full' ? 'full' : 'quick')
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

	// The table view's converging row count: rows walked against a time
	// budget, with a cursor the renderer hands back to continue. The count
	// grows call by call until `complete`, so main is never held for a table.
	ipcMain.handle(
		'sqlite:countRows',
		async (_event, request: SqliteCountRequest): Promise<SqliteRowCount> => countSqliteRows(request)
	);

	// Save one BLOB cell to a file, whole. The value is read and written in
	// this process; only the path and the byte count come back.
	ipcMain.handle(
		'sqlite:saveBlob',
		async (_event, request: SqliteBlobRequest): Promise<SqliteBlobSaved> => saveSqliteBlob(request)
	);

	// Release the connection. Called when the tab closes; idle handles are
	// also reaped, so a missed close leaks nothing permanent.
	ipcMain.handle(
		'sqlite:close',
		async (_event, handle: string): Promise<void> => closeSqliteDatabase(handle)
	);
}
