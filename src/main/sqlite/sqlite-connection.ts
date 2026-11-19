/**
 * The one way a SQLite connection is opened on a user's database.
 *
 * Shared by the viewer's long-lived handles (sqlite-database.ts) and the
 * SQLite child process (sqlite-worker.ts: integrity checks and Query-mode
 * runs), so a second connection on the same file is exactly as safe as the
 * first:
 *
 *   - `readonly: true`: writes fail at the driver, whatever SQL reaches it.
 *     The one exception is the editing unlock's writable connection
 *     (`openWritableSqliteConnection()`), which keeps every other guard.
 *   - `fileMustExist: true`: opening a path that vanished never creates an
 *     empty database in its place.
 *   - `trusted_schema = OFF`: a hostile file cannot route schema-embedded SQL
 *     (views, triggers, defaults) through functions with side effects.
 *   - A short busy timeout. better-sqlite3 is synchronous, so a writer holding
 *     the lock would otherwise freeze the process for the 5 s default.
 *
 * Nothing here may import `electron`: the SQLite child process loads this
 * module.
 */

import Database from 'better-sqlite3';

/**
 * How long a statement waits on a lock another process holds before failing
 * with `SQLITE_BUSY`. Long enough to ride out a writer's commit, short enough
 * that a stuck writer costs the main process a beat rather than a freeze.
 */
export const SQLITE_BUSY_TIMEOUT_MS = 1000;

/**
 * Turn a driver failure into a message a person can act on. SQLite's result
 * code stays on `code`, so callers that classify errors (for example
 * `isSqliteCorruptionError()`) still can.
 */
export function describeSqliteOpenFailure(error: unknown, filePath: string): Error {
	const code = (error as { code?: unknown } | null)?.code;
	const detail = error instanceof Error ? error.message : String(error);
	let message: string;
	switch (code) {
		case 'SQLITE_NOTADB':
			message = `${filePath} is not a readable SQLite database. It may be encrypted (SQLCipher) or damaged.`;
			break;
		case 'SQLITE_BUSY':
		case 'SQLITE_LOCKED':
			message = `Another process has ${filePath} locked. Try again once it finishes writing.`;
			break;
		case 'SQLITE_CANTOPEN':
			message = `Could not open ${filePath}: ${detail}`;
			break;
		default:
			if (typeof code === 'string' && code.startsWith('SQLITE_CORRUPT')) {
				message = `${filePath} is damaged: ${detail}`;
			} else {
				// Not SQLite's verdict on the file (a native addon that failed to
				// load, a permission error): pass it through untouched.
				return error instanceof Error ? error : new Error(detail);
			}
	}
	return Object.assign(new Error(message), { code });
}

/**
 * Open `filePath` read-only and prove it is a readable database. Throws the
 * described failure (see `describeSqliteOpenFailure`), never a half-open
 * connection.
 */
export function openReadOnlySqliteConnection(filePath: string): Database.Database {
	return openSqliteConnection(filePath, true);
}

/**
 * Open `filePath` for WRITING, with every other guard the read-only open has
 * (never created, `trusted_schema = OFF`, the short busy timeout).
 *
 * Only the editing unlock opens one (`openSqliteWriteConnection()` in
 * sqlite-editing.ts), after the write gate and the backup. Nothing else may
 * call this: every other connection on a user's database is read-only.
 */
export function openWritableSqliteConnection(filePath: string): Database.Database {
	return openSqliteConnection(filePath, false);
}

function openSqliteConnection(filePath: string, readonly: boolean): Database.Database {
	let db: Database.Database;
	try {
		db = new Database(filePath, {
			readonly,
			fileMustExist: true,
			timeout: SQLITE_BUSY_TIMEOUT_MS,
		});
	} catch (error) {
		throw describeSqliteOpenFailure(error, filePath);
	}

	try {
		db.pragma('trusted_schema = OFF');
		// SQLite reads page 1 lazily, so an encrypted or damaged file opens
		// "successfully". Reading the schema cookie forces that read here, where
		// the failure can name the file, instead of on the first query.
		db.pragma('schema_version', { simple: true });
	} catch (error) {
		db.close();
		throw describeSqliteOpenFailure(error, filePath);
	}
	return db;
}
