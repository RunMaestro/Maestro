/**
 * SQLite Database Handles
 *
 * The main-process side of the SQLite viewer: one read-only connection per
 * open database, addressed by an opaque handle, closed by an idle reaper when
 * no tab has used it for a while (see `createIdleHandleRegistry`).
 *
 * A `.db` inside a project is often someone's live application database, so
 * every connection here is opened the one safe way, by
 * `openReadOnlySqliteConnection()` (sqlite-connection.ts): read-only, never
 * created, `trusted_schema = OFF`, a short busy timeout.
 *
 * The connection lives here, never in the renderer, so no database bytes cross
 * IPC: later calls send a handle and get back the rows they display.
 */

import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';

import type Database from 'better-sqlite3';

import { SQLITE_REGEXP_FUNCTION, sqliteRegexpTest } from '../../shared/sqlite/filter';
import type { SqliteDatabaseInfo } from '../../shared/sqlite/types';
import { createIdleHandleRegistry } from '../utils/idle-handle-registry';
import { openReadOnlySqliteConnection } from './sqlite-connection';
import { isSqliteDatabaseFile } from './sqlite-detect';

export { SQLITE_BUSY_TIMEOUT_MS } from './sqlite-connection';

/** Connections idle longer than this are closed, releasing the descriptor and any read lock. */
const HANDLE_IDLE_MS = 15 * 60 * 1000;

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
	/**
	 * Run when the connection is released (closed or reaped), before it
	 * closes. Work that outlives a call (an integrity check on a worker
	 * thread) registers its own stop here, so a closed tab stops it too.
	 */
	releaseHooks: Set<() => void>;
}

const openDatabases = createIdleHandleRegistry<OpenSqliteDatabase>({
	idleMs: HANDLE_IDLE_MS,
	release: (database) => {
		for (const hook of database.releaseHooks) hook();
		database.releaseHooks.clear();
		database.db.close();
	},
});

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

	const db = openReadOnlySqliteConnection(filePath);
	// The table view's regex filter (`name ~ /^acme/`) calls this; SQLite has
	// no REGEXP of its own. Deterministic, so SQLite may evaluate it once per
	// distinct input. Registering a function writes nothing to the file.
	db.function(SQLITE_REGEXP_FUNCTION, { deterministic: true }, sqliteRegexpTest);

	const id = randomUUID();
	const info: SqliteDatabaseInfo = {
		handle: id,
		displayPath: filePath,
		fileBytes: stat.size,
	};
	openDatabases.add(id, {
		id,
		displayPath: filePath,
		db,
		info,
		dev: stat.dev,
		ino: stat.ino,
		releaseHooks: new Set(),
	});
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
