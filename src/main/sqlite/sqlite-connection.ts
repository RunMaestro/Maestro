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

import { isSqliteBusyError } from '../../shared/sqliteErrors';
import { registerSqliteRowVersion } from './sqlite-row-version';

/**
 * How long a statement waits on a lock another process holds before failing
 * with `SQLITE_BUSY`. Long enough to ride out a writer's commit, short enough
 * that a stuck writer costs the main process a beat rather than a freeze.
 */
export const SQLITE_BUSY_TIMEOUT_MS = 1000;

/** What was being done when SQLite reported the database busy. */
export type SqliteBusyAction = 'open' | 'read' | 'write' | 'backup';

/**
 * The sentence a person sees when another process kept the database busy past
 * `SQLITE_BUSY_TIMEOUT_MS`, in place of SQLite's bare "database is locked".
 * Names the cause (another process), what did or did not happen, and what to
 * do. `subject` names the file where no tab shows it (an open).
 */
export function sqliteBusyMessage(action: SqliteBusyAction, subject = 'this database'): string {
	const busy = `Another process has ${subject} open and kept it locked past the ${SQLITE_BUSY_TIMEOUT_MS / 1000} s wait`;
	switch (action) {
		case 'open':
			return `${busy}, so it could not be opened. Try again once that process finishes writing.`;
		case 'read':
			return `${busy}, so it could not be read just now. Try again in a moment.`;
		case 'backup':
			return `${busy}, so it could not be backed up before the first change and nothing was written. Try again once that process finishes, or close it.`;
		case 'write':
			return `${busy}, so nothing was changed. Try again once that process finishes, or close it.`;
	}
}

/** Marks an error `describeSqliteBusy()` already restated, so an outer layer keeps the inner words. */
const BUSY_DESCRIBED = Symbol('sqliteBusyDescribed');

/**
 * `error` restated with `sqliteBusyMessage(action)` when it is SQLite
 * reporting the database busy (`isSqliteBusyError()`); any other error comes
 * back untouched, so SQLite's own words for a constraint or a syntax error
 * still reach the reader. SQLite's code stays on `code`. An error already
 * restated is returned as is: a write whose backup was refused says so.
 */
export function describeSqliteBusy(error: unknown, action: SqliteBusyAction): unknown {
	if (!isSqliteBusyError(error) || (error as { [BUSY_DESCRIBED]?: true })[BUSY_DESCRIBED]) {
		return error;
	}
	return Object.assign(new Error(sqliteBusyMessage(action)), {
		code: (error as { code: string }).code,
		[BUSY_DESCRIBED]: true as const,
	});
}

/**
 * Run `work`, restating a busy failure for `action` (`describeSqliteBusy()`),
 * whether `work` throws or returns a promise that rejects. Every read and
 * write of a user's database goes through this, so the viewer, the CLI, and
 * any later caller say the same thing.
 */
export function reportSqliteBusy<T>(action: SqliteBusyAction, work: () => T): T {
	let result: T;
	try {
		result = work();
	} catch (error) {
		throw describeSqliteBusy(error, action);
	}
	if (result instanceof Promise) {
		return result.catch((error: unknown) => {
			throw describeSqliteBusy(error, action);
		}) as T;
	}
	return result;
}

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
		case 'SQLITE_LOCKED':
			message = sqliteBusyMessage('open', filePath);
			break;
		case 'SQLITE_CANTOPEN':
			message = `Could not open ${filePath}: ${detail}`;
			break;
		default:
			if (isSqliteBusyError(error)) {
				message = sqliteBusyMessage('open', filePath);
			} else if (typeof code === 'string' && code.startsWith('SQLITE_CORRUPT')) {
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
 * (never created, `trusted_schema = OFF`, the short busy timeout), and with
 * `foreign_keys = ON`, so writes keep the constraints the schema declares.
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
		// SQLite leaves foreign keys off per connection. A write enforces the
		// ones the schema declares, as the apps that own these files do, so a
		// delete that would orphan a child fails with SQLite's words and a
		// declared cascade is counted, never skipped (sqlite-row-edit.ts).
		if (!readonly) db.pragma('foreign_keys = ON');
		// Every edit checks the row version its page carried, in its own
		// statement (sqlite-row-version.ts). The read-only handle registers it
		// beside the filter's REGEXP (sqlite-database.ts).
		if (!readonly) registerSqliteRowVersion(db);
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
