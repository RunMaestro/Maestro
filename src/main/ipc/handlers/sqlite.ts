/**
 * SQLite IPC Handlers
 *
 * The renderer's view of a SQLite database goes through these calls. As with
 * parquet, no database bytes cross IPC: `open` returns a summary and a handle,
 * the summary and integrity calls return header facts and a verdict, the
 * table-list, schema, and column-catalog calls return names, numbers, and
 * schema text,
 * the row calls return one bounded window of cells, a query run returns one
 * window of a read-only statement's result, an export writes a statement's
 * whole result to a file in a child process, the history calls read and
 * forget what ran against the file, a BLOB save writes the
 * value to disk here rather than shipping it, and the read-only
 * connection stays in this process (see src/main/sqlite/sqlite-database.ts).
 */

import { ipcMain } from 'electron';

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
	SqliteQueryExported,
	SqliteQueryExportRequest,
	SqliteQueryHistory,
	SqliteQueryRequest,
	SqliteQueryResult,
	SqliteRowCount,
	SqliteRowsPage,
	SqliteRowsRequest,
} from '../../../shared/sqlite/types';
import { saveSqliteBlob } from '../../sqlite/sqlite-blob';
import { countSqliteRows } from '../../sqlite/sqlite-count';
import { closeSqliteDatabase, openSqliteDatabase } from '../../sqlite/sqlite-database';
import { checkSqliteIntegrity } from '../../sqlite/sqlite-integrity';
import { listSqliteObjects, readSqliteObjectStats } from '../../sqlite/sqlite-objects';
import { cancelSqliteQuery, exportSqliteQuery, runSqliteQuery } from '../../sqlite/sqlite-query';
import {
	forgetSqliteQueryHistory,
	readSqliteQueryHistory,
} from '../../sqlite/sqlite-query-history';
import { readSqliteRows } from '../../sqlite/sqlite-rows';
import { readSqliteColumnCatalog, readSqliteObjectSchema } from '../../sqlite/sqlite-schema';
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

	// The integrity flag. Reads every page, so it runs in a child process with
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

	// The SQL editor's completion catalog: every table's and view's column
	// names. Schema metadata only, one pragma per object.
	ipcMain.handle(
		'sqlite:readColumns',
		async (_event, handle: string): Promise<SqliteColumnCatalog> => readSqliteColumnCatalog(handle)
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

	// Query mode's Run: one read-only statement, in a child process with its
	// own connection, so a runaway query can time out or be killed. One
	// window of the result comes back; the next re-runs it at an offset.
	ipcMain.handle(
		'sqlite:runQuery',
		async (_event, request: SqliteQueryRequest): Promise<SqliteQueryResult> =>
			runSqliteQuery(request)
	);

	// Query mode's Stop: terminate the run (or export) going under this id.
	ipcMain.handle(
		'sqlite:cancelQuery',
		async (_event, queryId: string): Promise<boolean> => cancelSqliteQuery(queryId)
	);

	// Query mode's Export: the statement's whole result written to a file as
	// CSV or JSON Lines, in a child process; only what was written comes back.
	ipcMain.handle(
		'sqlite:exportQuery',
		async (_event, request: SqliteQueryExportRequest): Promise<SqliteQueryExported> =>
			exportSqliteQuery(request)
	);

	// Query mode's History rail: what ran against this file, newest first.
	ipcMain.handle(
		'sqlite:readQueryHistory',
		async (_event, handle: string): Promise<SqliteQueryHistory> => readSqliteQueryHistory(handle)
	);

	// Forget one history entry, or the whole history with a null id. Answers
	// with the history left.
	ipcMain.handle(
		'sqlite:forgetQueryHistory',
		async (_event, handle: string, entryId: string | null): Promise<SqliteQueryHistory> =>
			forgetSqliteQueryHistory(handle, entryId ?? null)
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
