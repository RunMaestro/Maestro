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
 * The CLI has no tab. Its write verbs take a per-call unlock flag that
 * enables editing for that one call and disables it after, through these
 * same functions.
 */

import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';

import type { SqliteEditingGrant } from '../../shared/sqlite/types';
import { getSqliteDatabase, type OpenSqliteDatabase } from './sqlite-database';

/** Why a write was refused: this tab never turned editing on, or turned it off. */
export const SQLITE_EDITING_LOCKED_MESSAGE =
	'Editing is not enabled for this database. Turn on "Enable editing" first.';

/** Live edit tokens per open handle. An entry is dropped when its handle is released. */
const grantsByHandle = new Map<string, Set<string>>();

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
		return `${filePath} was replaced since it was opened. Reopen the file to edit it.`;
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
		database.releaseHooks.add(() => grantsByHandle.delete(handle));
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
	return grantsByHandle.get(handle)?.delete(editToken) ?? false;
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

/** Test seam: how many tabs have editing on for this handle. 0 for a closed handle. */
export function sqliteEditingGrantCount(handle: string): number {
	return grantsByHandle.get(handle)?.size ?? 0;
}
