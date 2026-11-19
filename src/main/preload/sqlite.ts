/**
 * Preload API for SQLite previews
 *
 * Exposes window.maestro.sqlite: open a database read-only, read its summary,
 * check its integrity, list its schema
 * objects, measure their row counts and sizes, read one object's structure,
 * read every table's column names for SQL completion,
 * read a window of a table's rows, count its rows, run a read-only statement
 * (and stop it), export a statement's result to a file, read and forget the
 * file's query history, save a BLOB to a file, turn this tab's editing on
 * and off, change one cell, insert or delete one row, close the handle.
 */

import { ipcRenderer } from 'electron';
import type {
	SqliteBlobRequest,
	SqliteBlobSaved,
	SqliteCellUpdateRequest,
	SqliteCellUpdateResult,
	SqliteColumnCatalog,
	SqliteCountRequest,
	SqliteDatabaseInfo,
	SqliteDatabaseSummary,
	SqliteEditingGrant,
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
	SqliteRowDeleteRequest,
	SqliteRowDeleteResult,
	SqliteRowInsertRequest,
	SqliteRowInsertResult,
	SqliteRowsPage,
	SqliteRowsRequest,
	SqliteTransactionEnd,
	SqliteTransactionEndRequest,
	SqliteTransactionRequest,
	SqliteTransactionState,
	SqliteTransactionStatus,
	SqliteUndoRequest,
	SqliteUndoResult,
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
		 * (`full`) in a child process. Resolves with the verdict; rejects when
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
		 * Run one read-only statement (SELECT, WITH, VALUES, EXPLAIN, read
		 * PRAGMA) and return a window of its result. Rejects with a refusal for
		 * anything that would write, with SQLite's message for a failure, and
		 * when the run is stopped or times out. With the tab's live
		 * `editToken`, a statement that changes the database runs too, once,
		 * behind the write gate and the backup; its result carries `write`.
		 */
		runQuery: (request: SqliteQueryRequest): Promise<SqliteQueryResult> =>
			ipcRenderer.invoke('sqlite:runQuery', request),

		/** Stop the run or export started under `queryId`. Resolves whether one was running. */
		cancelQuery: (queryId: string): Promise<boolean> =>
			ipcRenderer.invoke('sqlite:cancelQuery', queryId),

		/**
		 * Write every row of one read-only statement to `destPath` as CSV or
		 * JSON Lines, whole, in a child process. Rejects as `runQuery` does,
		 * and for a statement that returns no rows; a failed export leaves no
		 * file behind.
		 */
		exportQuery: (request: SqliteQueryExportRequest): Promise<SqliteQueryExported> =>
			ipcRenderer.invoke('sqlite:exportQuery', request),

		/** The statements run against this database, newest first. */
		readQueryHistory: (handle: string): Promise<SqliteQueryHistory> =>
			ipcRenderer.invoke('sqlite:readQueryHistory', handle),

		/** Forget one history entry, or all of them with `entryId` null. Resolves the history left. */
		forgetQueryHistory: (handle: string, entryId: string | null): Promise<SqliteQueryHistory> =>
			ipcRenderer.invoke('sqlite:forgetQueryHistory', handle, entryId),

		/**
		 * Write one BLOB cell to `destPath`, whole. The row is named by its rowid
		 * (from `readRows`) or its position; rejects when the stored value no
		 * longer matches `expected`.
		 */
		saveBlob: (request: SqliteBlobRequest): Promise<SqliteBlobSaved> =>
			ipcRenderer.invoke('sqlite:saveBlob', request),

		/**
		 * Turn editing on for this tab. Resolves the tab's grant; rejects with
		 * the reason when the file cannot be written.
		 */
		enableEditing: (handle: string): Promise<SqliteEditingGrant> =>
			ipcRenderer.invoke('sqlite:enableEditing', handle),

		/** Turn this tab's editing off again. Resolves whether a live grant was revoked. */
		disableEditing: (handle: string, editToken: string): Promise<boolean> =>
			ipcRenderer.invoke('sqlite:disableEditing', handle, editToken),

		/**
		 * Change one cell: a single-row UPDATE keyed on the row's rowid or
		 * primary key. Needs this tab's editing token; resolves the row as
		 * stored after the change and its key (new when a key column changed).
		 * Rejects with SQLite's message when it refuses the value.
		 */
		updateCell: (request: SqliteCellUpdateRequest): Promise<SqliteCellUpdateResult> =>
			ipcRenderer.invoke('sqlite:updateCell', request),

		/**
		 * Add one row: a single-row INSERT, columns left out taking their
		 * DEFAULT. Needs this tab's editing token; resolves the row as stored
		 * and its key. Rejects with SQLite's message when a constraint fails.
		 */
		insertRow: (request: SqliteRowInsertRequest): Promise<SqliteRowInsertResult> =>
			ipcRenderer.invoke('sqlite:insertRow', request),

		/**
		 * Remove one row: a single-row DELETE keyed on its rowid or primary key.
		 * Needs this tab's editing token; resolves the key removed and how many
		 * rows foreign-key actions and triggers changed beside it.
		 */
		deleteRow: (request: SqliteRowDeleteRequest): Promise<SqliteRowDeleteResult> =>
			ipcRenderer.invoke('sqlite:deleteRow', request),

		/**
		 * Take back one write: the `undo` step its result returned, applied as
		 * one single-row write. Needs this tab's editing token; rejects, with
		 * nothing written, when the row changed since the write.
		 */
		undoEdit: (request: SqliteUndoRequest): Promise<SqliteUndoResult> =>
			ipcRenderer.invoke('sqlite:undoEdit', request),

		/**
		 * Begin an explicit transaction for this tab (needs its editing token):
		 * the write gate and backup, then `BEGIN IMMEDIATE` held open. Run
		 * statements in it with `runQuery({ transactionId })`. Resolves its state,
		 * with `backup` when Begin took the session's backup.
		 */
		beginTransaction: (request: SqliteTransactionRequest): Promise<SqliteTransactionState> =>
			ipcRenderer.invoke('sqlite:beginTransaction', request),

		/** This tab's open transaction, if any, and how its last one ended. */
		readTransaction: (request: SqliteTransactionRequest): Promise<SqliteTransactionStatus> =>
			ipcRenderer.invoke('sqlite:readTransaction', request),

		/**
		 * Commit or roll back this tab's open transaction. Resolves how it ended;
		 * a Commit SQLite refuses rejects with its words, the transaction kept.
		 */
		endTransaction: (request: SqliteTransactionEndRequest): Promise<SqliteTransactionEnd> =>
			ipcRenderer.invoke('sqlite:endTransaction', request),

		/** Release the read-only connection. */
		close: (handle: string): Promise<void> => ipcRenderer.invoke('sqlite:close', handle),
	};
}
