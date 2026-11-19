/**
 * SQLite Database Handles
 *
 * The main-process side of the SQLite viewer: one read-only connection per
 * open database, addressed by an opaque handle, closed by an idle reaper when
 * no tab has used it for a while (see `createIdleHandleRegistry`).
 *
 * A `.db` inside a project is often someone's live application database, so
 * every connection here is opened the one safe way:
 *
 *   - `readonly: true`: writes fail at the driver, whatever SQL reaches it.
 *   - `fileMustExist: true`: opening a path that vanished never creates an
 *     empty database in its place.
 *   - `trusted_schema = OFF`: a hostile file cannot route schema-embedded SQL
 *     (views, triggers, defaults) through functions with side effects.
 *   - A short busy timeout. better-sqlite3 is synchronous, so a writer holding
 *     the lock would otherwise freeze the main process for the 5 s default.
 *
 * The connection lives here, never in the renderer, so no database bytes cross
 * IPC: later calls send a handle and get back the rows they display.
 */

import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';

import Database from 'better-sqlite3';

import type { SqliteDatabaseInfo } from '../../shared/sqlite/types';
import { createIdleHandleRegistry } from '../utils/idle-handle-registry';
import { isSqliteDatabaseFile } from './sqlite-detect';

/** Connections idle longer than this are closed, releasing the descriptor and any read lock. */
const HANDLE_IDLE_MS = 15 * 60 * 1000;

/**
 * How long a statement waits on a lock another process holds before failing
 * with `SQLITE_BUSY`. Long enough to ride out a writer's commit, short enough
 * that a stuck writer costs the main process a beat rather than a freeze.
 */
export const SQLITE_BUSY_TIMEOUT_MS = 1000;

/** One open database, shared by every query against it. */
export interface OpenSqliteDatabase {
	id: string;
	/** Path as the user knows it. */
	displayPath: string;
	/** The read-only connection. */
	db: Database.Database;
	info: SqliteDatabaseInfo;
	/**
	 * Device and inode at open. A connection follows the file it opened, so a
	 * path that now names a different file (a rebuilt fixture, a restored
	 * backup) needs a fresh connection; edits to the same file do not.
	 */
	dev: number;
	ino: number;
}

const openDatabases = createIdleHandleRegistry<OpenSqliteDatabase>({
	idleMs: HANDLE_IDLE_MS,
	release: (database) => {
		database.db.close();
	},
});

/**
 * Turn a driver failure into a message a person can act on. SQLite's result
 * code stays on `code`, so callers that classify errors (for example
 * `isSqliteCorruptionError()`) still can.
 */
function describeOpenFailure(error: unknown, filePath: string): Error {
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
			message = `Could not open ${filePath} read-only: ${detail}`;
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
 * Open a local SQLite database read-only and return its summary.
 *
 * Reuses the connection already open on the same file, so several tabs (or a
 * reopen after a reload) share one descriptor. The header is checked first:
 * a `.db` that is not SQLite is refused here exactly as `fs:readFile` refuses
 * to hand it to the viewer.
 */
export async function openSqliteDatabase(filePath: string): Promise<SqliteDatabaseInfo> {
	if (!(await isSqliteDatabaseFile(filePath))) {
		throw new Error(`Not a SQLite database: ${filePath}`);
	}
	const stat = await fs.stat(filePath);
	if (!stat.isFile()) throw new Error(`Not a file: ${filePath}`);

	const alreadyOpen = openDatabases.find(
		(database) =>
			database.displayPath === filePath && database.dev === stat.dev && database.ino === stat.ino
	);
	if (alreadyOpen) return alreadyOpen.info;

	let db: Database.Database;
	try {
		db = new Database(filePath, {
			readonly: true,
			fileMustExist: true,
			timeout: SQLITE_BUSY_TIMEOUT_MS,
		});
	} catch (error) {
		throw describeOpenFailure(error, filePath);
	}

	try {
		db.pragma('trusted_schema = OFF');
		// SQLite reads page 1 lazily, so an encrypted or damaged file opens
		// "successfully". Reading the schema cookie forces that read here, where
		// the failure can name the file, instead of on the viewer's first query.
		db.pragma('schema_version', { simple: true });
	} catch (error) {
		db.close();
		throw describeOpenFailure(error, filePath);
	}

	const id = randomUUID();
	const info: SqliteDatabaseInfo = {
		handle: id,
		displayPath: filePath,
		fileBytes: stat.size,
	};
	openDatabases.add(id, { id, displayPath: filePath, db, info, dev: stat.dev, ino: stat.ino });
	return info;
}

/** Look up an open connection, refreshing its idle timer. */
export function getSqliteDatabase(handle: string): OpenSqliteDatabase {
	const database = openDatabases.get(handle);
	if (!database) {
		throw new Error('SQLite database handle is no longer open. Reopen the file to continue.');
	}
	return database;
}

/** Close a connection. Safe to call more than once. */
export function closeSqliteDatabase(handle: string): Promise<void> {
	return openDatabases.close(handle);
}

/** Close every connection. Called on app quit. */
export function closeAllSqliteDatabases(): Promise<void> {
	return openDatabases.closeAll();
}

/** Test seam: how many connections are currently open. */
export function openSqliteDatabaseCount(): number {
	return openDatabases.size;
}
