/**
 * The body of the backup taken before the first write: copy the database
 * with `VACUUM INTO` on a read-only connection of its own, then prove the copy
 * opens as a database.
 *
 * Runs in the SQLite child process (sqlite-worker.ts). `VACUUM INTO` reads
 * every page and cannot be interrupted, which on the main process would hold
 * every IPC call for as long as the file takes to copy.
 *
 * Why `VACUUM INTO` and not a file copy: it reads through SQLite, inside one
 * read transaction, so the copy is a consistent snapshot even while another
 * process writes, and it includes committed pages still in a `-wal` file,
 * which a byte copy of the main file would miss. It runs on a READ-ONLY
 * connection (proven on the driver), so taking the backup cannot change the
 * original. The output is an ordinary rollback-journal database.
 *
 * Nothing here, or reachable from here, may import `electron`.
 */

import { statSync } from 'fs';

import type Database from 'better-sqlite3';

import { describeSqliteOpenFailure, openReadOnlySqliteConnection } from './sqlite-connection';

/** What the child is handed. */
export interface SqliteBackupTask {
	/** The database to copy. */
	filePath: string;
	/** Where the copy goes. Must not exist yet: SQLite refuses to overwrite one. */
	destPath: string;
}

/** What the child answers. */
export interface SqliteBackupTaskResult {
	/** Size of the copy. */
	bytes: number;
}

export function runSqliteBackupTask(task: SqliteBackupTask): SqliteBackupTaskResult {
	const source: Database.Database = openReadOnlySqliteConnection(task.filePath);
	try {
		// Bound, never spliced: the path is a value, not SQL.
		source.prepare('VACUUM INTO ?').run(task.destPath);
	} catch (error) {
		// CANTOPEN here is the copy's file, not the database.
		if ((error as { code?: unknown } | null)?.code === 'SQLITE_CANTOPEN') {
			throw Object.assign(
				new Error(`Could not create the backup file (${(error as Error).message}).`),
				{ code: 'SQLITE_CANTOPEN' }
			);
		}
		throw describeSqliteOpenFailure(error, task.filePath);
	} finally {
		source.close();
	}

	// A copy that does not open is no backup. Opening reads its header and
	// schema (see openReadOnlySqliteConnection), which is cheap; a full
	// integrity check would read the whole copy a second time.
	openReadOnlySqliteConnection(task.destPath).close();
	return { bytes: statSync(task.destPath).size };
}
