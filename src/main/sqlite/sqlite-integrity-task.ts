/**
 * The body of a SQLite integrity check: open the file on a connection of its
 * own and run `PRAGMA quick_check` or `PRAGMA integrity_check`.
 *
 * Runs in the SQLite child process (sqlite-worker.ts). Both pragmas read
 * every page of the file and cannot be interrupted, which on the main process
 * would hold every IPC call for as long as the file takes to read. The
 * connection is opened exactly as the viewer's is (sqlite-connection.ts), so
 * the check is just as read-only.
 *
 * Nothing here, or reachable from here, may import `electron`.
 */

import { performance } from 'perf_hooks';

import type Database from 'better-sqlite3';

import { isSqliteCorruptionError } from '../../shared/sqliteErrors';
import { parseSqliteIntegrityRows, sqliteIntegrityPragma } from '../../shared/sqlite/summary';
import type { SqliteIntegrityMode, SqliteIntegrityResult } from '../../shared/sqlite/types';
import { describeSqliteOpenFailure, openReadOnlySqliteConnection } from './sqlite-connection';

/** What the check's thread is handed. */
export interface SqliteIntegrityTask {
	filePath: string;
	mode: SqliteIntegrityMode;
}

/**
 * Check one database. A file damaged badly enough that SQLite throws rather
 * than reports (`SQLITE_CORRUPT`, `SQLITE_NOTADB`) is a failed check, not a
 * failed call: the throw IS the verdict. Any other error (a lock, a missing
 * file) rejects, since it says nothing about the file's integrity.
 */
export function runSqliteIntegrityCheck(task: SqliteIntegrityTask): SqliteIntegrityResult {
	const started = performance.now();
	const elapsedMs = () => Math.round(performance.now() - started);
	let db: Database.Database | null = null;
	try {
		db = openReadOnlySqliteConnection(task.filePath);
		const rows = db.pragma(sqliteIntegrityPragma(task.mode)) as Array<Record<string, unknown>>;
		// Each row is a single column named after the pragma.
		const values = rows.map((row) => Object.values(row)[0]);
		return { mode: task.mode, ...parseSqliteIntegrityRows(values), elapsedMs: elapsedMs() };
	} catch (error) {
		if (isSqliteCorruptionError(error)) {
			const described = describeSqliteOpenFailure(error, task.filePath);
			return {
				mode: task.mode,
				ok: false,
				problems: [described.message],
				truncated: false,
				elapsedMs: elapsedMs(),
			};
		}
		throw error;
	} finally {
		db?.close();
	}
}
