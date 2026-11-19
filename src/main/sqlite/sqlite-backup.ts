/**
 * SQLite Backup Before First Write
 *
 * Cheap insurance for the viewer's write path. The first time the app is about
 * to change a database in a session, it first copies the whole file beside
 * itself with `VACUUM INTO` (sqlite-backup-task.ts, run in the SQLite child
 * process so a large copy never holds the main process):
 *
 *   /work/app.db  ->  /work/app.maestro-backup-20261119-030405.db
 *
 * Rules every write path relies on (`beginSqliteWrite()` in
 * sqlite-editing.ts is the one caller):
 *
 *   - ONCE PER FILE PER SESSION. Keyed by the file's device and inode, not by
 *     handle or tab: two tabs, a reopen, an idle-reaped handle, or the same
 *     file through a symlink all share one backup. A file replaced on disk is
 *     a new file and gets its own. Nothing persists, so the next app run
 *     backs up again before its first write.
 *   - NO BACKUP, NO WRITE. A failed backup rejects the write that asked for
 *     it, saying nothing was written, and is not remembered: the next write
 *     tries again.
 *   - CONCURRENT FIRST WRITES SHARE ONE BACKUP. Only the call that started it
 *     reports `created: true`, so the backup is announced once.
 *   - NEVER A PARTIAL FILE UNDER THE BACKUP'S NAME. The copy is written to a
 *     `.part` file, proven to open, and renamed; a failure, a timeout, or the
 *     database closing mid-copy removes the part.
 */

import { promises as fs } from 'fs';
import path from 'path';

import { fileTimestampSlug } from '../../shared/formatters';
import { getFileExtension } from '../../shared/fileCategories';
import { isSqliteCandidateFile } from '../../shared/sqlite/preview';
import type { SqliteBackup } from '../../shared/sqlite/types';
import { logger } from '../utils/logger';
import type { OpenSqliteDatabase } from './sqlite-database';
import { startSqliteWorkerTask } from './sqlite-worker-runner';

/** How long a backup may take. A multi-gigabyte copy on a slow disk takes minutes. */
export const SQLITE_BACKUP_TIMEOUT_MS = 10 * 60 * 1000;

/** The marker in every backup's file name. */
export const SQLITE_BACKUP_NAME_MARKER = 'maestro-backup';

/** How many numbered names to try when a backup's name is taken. */
const MAX_NAME_ATTEMPTS = 100;

/** This session's backups, by file identity. A rejected one is removed. */
const sessionBackups = new Map<string, Promise<SqliteBackup>>();

/**
 * The backup's path for `filePath` taken at `createdAt`: beside the file,
 * stamped to the second, keeping a SQLite extension so the viewer opens the
 * backup like any database. `attempt` 2, 3, ... number a name already taken.
 *
 *   app.db         -> app.maestro-backup-20261119-030405.db
 *   History        -> History.maestro-backup-20261119-030405.db
 *   app.db (taken) -> app.maestro-backup-20261119-030405-2.db
 */
export function sqliteBackupPath(filePath: string, createdAt: number, attempt = 1): string {
	const folder = path.dirname(filePath);
	const base = path.basename(filePath);
	const stamp = `${SQLITE_BACKUP_NAME_MARKER}-${fileTimestampSlug(createdAt)}${attempt > 1 ? `-${attempt}` : ''}`;
	if (isSqliteCandidateFile(filePath)) {
		// The original extension, in its original case.
		const extLength = getFileExtension(filePath).length;
		const stem = base.slice(0, base.length - extLength - 1);
		return path.join(folder, `${stem}.${stamp}${base.slice(base.length - extLength - 1)}`);
	}
	return path.join(folder, `${base}.${stamp}.db`);
}

/** The in-progress copy's path. Beside the backup, so the rename never crosses a file system. */
export function sqliteBackupPartPath(backupPath: string): string {
	return `${backupPath}.part`;
}

/** The error a write sees when its backup could not be taken. */
export function sqliteBackupFailedMessage(filePath: string, detail: string): string {
	return `Could not back up ${filePath} before the first change, so nothing was written. ${detail}`;
}

async function pathTaken(candidate: string): Promise<boolean> {
	try {
		await fs.lstat(candidate);
		return true;
	} catch (error) {
		if ((error as { code?: unknown }).code === 'ENOENT') return false;
		throw error;
	}
}

/** The first backup name, and its part, that nothing holds yet. */
async function freeBackupPath(filePath: string, createdAt: number): Promise<string> {
	for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt++) {
		const candidate = sqliteBackupPath(filePath, createdAt, attempt);
		if (!(await pathTaken(candidate)) && !(await pathTaken(sqliteBackupPartPath(candidate)))) {
			return candidate;
		}
	}
	throw new Error(`Every backup name for this second is taken beside ${filePath}.`);
}

async function removePart(partPath: string): Promise<void> {
	// A killed child may still hold the file for a moment (Windows refuses to
	// delete an open file), so let rm retry before giving up on it.
	await fs.rm(partPath, { force: true, maxRetries: 5, retryDelay: 100 }).catch((cleanup) =>
		logger.warn(`Could not remove the partial backup ${partPath}`, 'SqliteBackup', {
			error: cleanup instanceof Error ? cleanup.message : String(cleanup),
		})
	);
}

async function takeSqliteBackup(database: OpenSqliteDatabase): Promise<SqliteBackup> {
	const filePath = database.displayPath;
	const createdAt = Date.now();
	let partPath: string | null = null;
	try {
		const backupPath = await freeBackupPath(filePath, createdAt);
		partPath = sqliteBackupPartPath(backupPath);
		const { result } = startSqliteWorkerTask(
			database,
			{ kind: 'backup', task: { filePath, destPath: partPath } },
			{
				closedMessage: 'The database was closed during the backup.',
				timeoutMs: SQLITE_BACKUP_TIMEOUT_MS,
				timeoutMessage: 'The backup took longer than 10 minutes and was stopped.',
				label: 'The backup',
			}
		);
		const { bytes } = await result;
		await fs.rename(partPath, backupPath);
		partPath = null;
		logger.info(`Backed up ${filePath} to ${backupPath} before the first write`, 'SqliteBackup', {
			bytes,
		});
		return { path: backupPath, bytes, createdAt };
	} catch (error) {
		if (partPath) await removePart(partPath);
		const detail = error instanceof Error ? error.message : String(error);
		const code = (error as { code?: unknown } | null)?.code;
		throw Object.assign(
			new Error(sqliteBackupFailedMessage(filePath, detail)),
			typeof code === 'string' ? { code } : {}
		);
	}
}

/**
 * This session's backup of `database`, taking it first if there is none.
 * `created` is true only for the call that took it. Rejects, with
 * `sqliteBackupFailedMessage()`, when the copy could not be made.
 */
export async function ensureSqliteBackup(
	database: OpenSqliteDatabase
): Promise<{ backup: SqliteBackup; created: boolean }> {
	const key = `${database.dev}:${database.ino}`;
	const existing = sessionBackups.get(key);
	if (existing) return { backup: await existing, created: false };

	const taking = takeSqliteBackup(database);
	sessionBackups.set(key, taking);
	try {
		return { backup: await taking, created: true };
	} catch (error) {
		if (sessionBackups.get(key) === taking) sessionBackups.delete(key);
		throw error;
	}
}

/** Test seam: forget this session's backups, as an app restart would. */
export function forgetSqliteBackups(): void {
	sessionBackups.clear();
}
