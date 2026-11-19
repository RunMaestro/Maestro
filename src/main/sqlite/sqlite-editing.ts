/**
 * SQLite Editing Unlock
 *
 * The safety model of the SQLite viewer's write path. A `.db` inside a project
 * is often someone's live application database, so the viewer is read-only
 * until a person deliberately turns editing on, and the switch is per tab:
 * another tab on the same file stays read-only.
 *
 * The switch is enforced HERE, not in the renderer. Enabling editing hands
 * the tab an opaque `editToken`; every write the viewer will ever make sends
 * it back, and `requireSqliteEditing()` refuses a write whose token is not
 * live. A token dies when the tab locks again (`disableSqliteEditing()`), when
 * its handle is released (the tab closed or the idle reaper closed the
 * connection), and on app quit. Nothing persists, so a reload starts locked.
 *
 * Several tabs on one file share one handle (see sqlite-database.ts), which is
 * why the grant is a token per tab rather than a flag on the handle.
 *
 * Enabling checks, without touching the database, that a write could
 * succeed at all: the path still names the file the handle opened, the file
 * is writable, and so is its folder (SQLite writes its journal, or the WAL
 * and shared-memory files, beside the database). A refusal says which.
 *
 * Every write starts with `beginSqliteWrite()`, the ONLY way to a writable
 * connection. In order, it: passes the gate, re-checks that the file can
 * still be written, takes this session's backup of the file if there is none
 * yet (sqlite-backup.ts: no backup, no write), and hands back the handle's
 * writable connection, opened on the first write beside the read-only one and
 * closed when no tab holds a grant any more or the handle is released.
 *
 * The CLI has no tab. Its write verbs take a per-call unlock flag that
 * enables editing for that one call and disables it after, through these
 * same functions.
 */

import { randomUUID } from 'crypto';
import { promises as fs, statSync } from 'fs';
import path from 'path';

import type Database from 'better-sqlite3';

import type { SqliteBackup, SqliteEditingGrant } from '../../shared/sqlite/types';
import { ensureSqliteBackup } from './sqlite-backup';
import { openWritableSqliteConnection } from './sqlite-connection';
import { getSqliteDatabase, type OpenSqliteDatabase } from './sqlite-database';

/** Why a write was refused: this tab never turned editing on, or turned it off. */
export const SQLITE_EDITING_LOCKED_MESSAGE =
	'Editing is not enabled for this database. Turn on "Enable editing" first.';

/** Live edit tokens per open handle. An entry is dropped when its handle is released. */
const grantsByHandle = new Map<string, Set<string>>();

/**
 * The writable connection per open handle, opened by the first write. Closed
 * when the handle's last grant is revoked and when the handle is released.
 */
const writeConnections = new Map<string, Database.Database>();

function closeWriteConnection(handle: string): void {
	const db = writeConnections.get(handle);
	if (!db) return;
	writeConnections.delete(handle);
	db.close();
}

function replacedMessage(filePath: string): string {
	return `${filePath} was replaced since it was opened. Reopen the file to edit it.`;
}

function errorCode(error: unknown): string | undefined {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === 'string' ? code : undefined;
}

/**
 * Why a write to this open database could not succeed, or null when it can.
 * Reads file metadata only; the database itself is not touched.
 */
export async function sqliteEditingRefusal(database: OpenSqliteDatabase): Promise<string | null> {
	const filePath = database.displayPath;

	let stat;
	try {
		stat = await fs.stat(filePath);
	} catch (error) {
		if (errorCode(error) === 'ENOENT') return `${filePath} no longer exists.`;
		throw error;
	}
	if (stat.dev !== database.dev || stat.ino !== database.ino) {
		return replacedMessage(filePath);
	}

	try {
		await fs.access(filePath, fs.constants.W_OK);
	} catch (error) {
		const code = errorCode(error);
		if (code === 'EROFS') return `${filePath} is on a read-only file system.`;
		if (code === 'EACCES' || code === 'EPERM') {
			return `You do not have permission to write ${filePath}.`;
		}
		throw error;
	}

	const folder = path.dirname(filePath);
	try {
		await fs.access(folder, fs.constants.W_OK);
	} catch (error) {
		const code = errorCode(error);
		if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
			return `SQLite writes its journal beside the database, and ${folder} is not writable.`;
		}
		throw error;
	}
	return null;
}

/**
 * Turn editing on for one tab. Resolves the tab's grant; rejects with the
 * reason when the file cannot be written, or when the handle is not open.
 */
export async function enableSqliteEditing(handle: string): Promise<SqliteEditingGrant> {
	const database = getSqliteDatabase(handle);
	const refusal = await sqliteEditingRefusal(database);
	if (refusal) throw new Error(refusal);
	// The handle may have been released while the checks ran. A grant on a
	// connection that no longer exists would never be revoked by its release.
	if (getSqliteDatabase(handle) !== database) {
		throw new Error('SQLite database handle is no longer open. Reopen the file to continue.');
	}

	let grants = grantsByHandle.get(handle);
	if (!grants) {
		grants = new Set();
		grantsByHandle.set(handle, grants);
		database.releaseHooks.add(() => {
			grantsByHandle.delete(handle);
			closeWriteConnection(handle);
		});
	}
	const editToken = randomUUID();
	grants.add(editToken);
	return { handle, editToken };
}

/**
 * Turn editing off for the tab holding `editToken`. Safe to call more than
 * once and after the handle closed. Resolves whether a live grant was revoked.
 */
export function disableSqliteEditing(handle: string, editToken: string): boolean {
	const grants = grantsByHandle.get(handle);
	const revoked = grants?.delete(editToken) ?? false;
	// No tab may write any more: drop the writable connection with the grant.
	if (grants?.size === 0) closeWriteConnection(handle);
	return revoked;
}

/**
 * The gate every write passes: the open database, when `editToken` is a live
 * grant on `handle`. Throws `SQLITE_EDITING_LOCKED_MESSAGE` otherwise, and the
 * usual "no longer open" error for a released handle.
 */
export function requireSqliteEditing(handle: string, editToken: unknown): OpenSqliteDatabase {
	const database = getSqliteDatabase(handle);
	if (typeof editToken !== 'string' || !grantsByHandle.get(handle)?.has(editToken)) {
		throw new Error(SQLITE_EDITING_LOCKED_MESSAGE);
	}
	return database;
}

/** A write in progress: everything `beginSqliteWrite()` hands its caller. */
export interface SqliteWriteSession {
	database: OpenSqliteDatabase;
	/** The handle's writable connection. Use it before the next `await`: a grant can end at any await. */
	db: Database.Database;
	/** This session's backup of the file. */
	backup: SqliteBackup;
	/** True only for the write that took `backup`, so it is announced once. */
	backupCreated: boolean;
}

/**
 * The handle's writable connection, opened on first use. Gated again here, so
 * a tab that locked, or a handle that closed, during the backup cannot get one.
 */
function openSqliteWriteConnection(handle: string, editToken: unknown): Database.Database {
	const database = requireSqliteEditing(handle, editToken);
	const open = writeConnections.get(handle);
	if (open) return open;
	// A connection opens a PATH. If the path now names another file, opening
	// it would write to a file nobody unlocked or backed up.
	const stat = statSync(database.displayPath);
	if (stat.dev !== database.dev || stat.ino !== database.ino) {
		throw new Error(replacedMessage(database.displayPath));
	}
	const db = openWritableSqliteConnection(database.displayPath);
	writeConnections.set(handle, db);
	return db;
}

/**
 * Start a write: the one way to a writable connection on a user's database.
 * Every write path, IPC, WebSocket, or CLI, begins here.
 *
 *   1. `requireSqliteEditing()`: this tab's grant is live.
 *   2. `sqliteEditingRefusal()`: the file is still the one opened, and still
 *      writable (both can change after the unlock).
 *   3. `ensureSqliteBackup()`: the first write to this file this session waits
 *      for a `VACUUM INTO` copy beside it; when the copy fails, so does the
 *      write, and nothing is written.
 *   4. The writable connection, gated again.
 */
export async function beginSqliteWrite(
	handle: string,
	editToken: unknown
): Promise<SqliteWriteSession> {
	const database = requireSqliteEditing(handle, editToken);
	const refusal = await sqliteEditingRefusal(database);
	if (refusal) throw new Error(refusal);
	const { backup, created } = await ensureSqliteBackup(database);
	const db = openSqliteWriteConnection(handle, editToken);
	return { database, db, backup, backupCreated: created };
}

/** Test seam: whether the handle's writable connection is open. */
export function hasSqliteWriteConnection(handle: string): boolean {
	return writeConnections.has(handle);
}

/** Test seam: how many tabs have editing on for this handle. 0 for a closed handle. */
export function sqliteEditingGrantCount(handle: string): number {
	return grantsByHandle.get(handle)?.size ?? 0;
}
