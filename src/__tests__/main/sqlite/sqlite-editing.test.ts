/**
 * Tests for the SQLite editing unlock: grants are per tab, enforced by
 * `requireSqliteEditing()`, refused for a file that cannot be written, and
 * gone once the handle is released.
 */

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// better-sqlite3's native binary is built for Electron's ABI and does not load
// under vitest. The unlock never touches the database, so a bare fake is
// enough; the files are real because the checks read file metadata. The fake
// records each connection, and its `VACUUM INTO` (the backup before the first
// write) copies the file's bytes.
const driver = vi.hoisted(() => ({
	connections: [] as Array<{ path: string; readonly: boolean; closed: boolean }>,
}));

vi.mock('better-sqlite3', async () => {
	const { copyFileSync } = await import('fs');
	class FakeDatabase {
		record: (typeof driver.connections)[number];
		constructor(filePath: string, options: { readonly?: boolean }) {
			this.record = { path: filePath, readonly: options.readonly === true, closed: false };
			driver.connections.push(this.record);
		}
		pragma() {
			return 1;
		}
		function() {
			return this;
		}
		prepare() {
			return { run: (dest: string) => copyFileSync(this.record.path, dest) };
		}
		close() {
			this.record.closed = true;
		}
	}
	return { default: FakeDatabase };
});

import {
	closeAllSqliteDatabases,
	closeSqliteDatabase,
	getSqliteDatabase,
	openSqliteDatabase,
} from '../../../main/sqlite/sqlite-database';
import { forgetSqliteBackups, SQLITE_BACKUP_NAME_MARKER } from '../../../main/sqlite/sqlite-backup';
import {
	SQLITE_EDITING_LOCKED_MESSAGE,
	beginSqliteWorkerWrite,
	beginSqliteWrite,
	disableSqliteEditing,
	enableSqliteEditing,
	hasSqliteWriteConnection,
	onSqliteEditingRevoked,
	requireSqliteEditing,
	sqliteEditingGrantCount,
	sqliteEditingRefusal,
} from '../../../main/sqlite/sqlite-editing';

const MAGIC = Buffer.from('SQLite format 3\0', 'latin1');
let dir: string;

async function writeFixture(name: string, folder = dir): Promise<string> {
	const file = path.join(folder, name);
	await fs.writeFile(file, Buffer.concat([MAGIC, Buffer.alloc(4080)]));
	return file;
}

beforeAll(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-sqlite-editing-'));
});

afterAll(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

afterEach(async () => {
	await closeAllSqliteDatabases();
	forgetSqliteBackups();
	driver.connections.length = 0;
});

/** The backups beside `file`. */
async function backupsOf(file: string): Promise<string[]> {
	const stem = path.basename(file, path.extname(file));
	return (await fs.readdir(path.dirname(file))).filter((name) =>
		name.startsWith(`${stem}.${SQLITE_BACKUP_NAME_MARKER}-`)
	);
}

/** Open writable connections on `file`. */
function writableConnections(file: string) {
	return driver.connections.filter((c) => c.path === file && !c.readonly && !c.closed);
}

describe('enableSqliteEditing', () => {
	it('hands each tab its own token, and only a live token passes the gate', async () => {
		const { handle } = await openSqliteDatabase(await writeFixture('grant.db'));
		const first = await enableSqliteEditing(handle);
		const second = await enableSqliteEditing(handle);

		expect(first.handle).toBe(handle);
		expect(first.editToken).not.toBe(second.editToken);
		expect(sqliteEditingGrantCount(handle)).toBe(2);
		expect(requireSqliteEditing(handle, first.editToken)).toBe(getSqliteDatabase(handle));

		// Locking one tab leaves the other tab's grant alone.
		expect(disableSqliteEditing(handle, first.editToken)).toBe(true);
		expect(() => requireSqliteEditing(handle, first.editToken)).toThrow(
			SQLITE_EDITING_LOCKED_MESSAGE
		);
		expect(requireSqliteEditing(handle, second.editToken)).toBe(getSqliteDatabase(handle));
		expect(sqliteEditingGrantCount(handle)).toBe(1);
	});

	it('refuses a write from a tab that never enabled editing', async () => {
		const { handle } = await openSqliteDatabase(await writeFixture('locked.db'));
		expect(() => requireSqliteEditing(handle, undefined)).toThrow(SQLITE_EDITING_LOCKED_MESSAGE);
		expect(() => requireSqliteEditing(handle, 'made-up')).toThrow(SQLITE_EDITING_LOCKED_MESSAGE);
	});

	it('does not accept a token granted on another database', async () => {
		const a = await openSqliteDatabase(await writeFixture('a.db'));
		const b = await openSqliteDatabase(await writeFixture('b.db'));
		const grant = await enableSqliteEditing(a.handle);
		expect(() => requireSqliteEditing(b.handle, grant.editToken)).toThrow(
			SQLITE_EDITING_LOCKED_MESSAGE
		);
	});

	it('drops every grant when the handle is released, and a reopen starts locked', async () => {
		const file = await writeFixture('released.db');
		const { handle } = await openSqliteDatabase(file);
		const grant = await enableSqliteEditing(handle);

		await closeSqliteDatabase(handle);
		expect(sqliteEditingGrantCount(handle)).toBe(0);
		expect(() => requireSqliteEditing(handle, grant.editToken)).toThrow(/no longer open/);
		// Disabling after the close is harmless.
		expect(disableSqliteEditing(handle, grant.editToken)).toBe(false);

		const reopened = await openSqliteDatabase(file);
		expect(() => requireSqliteEditing(reopened.handle, grant.editToken)).toThrow(
			SQLITE_EDITING_LOCKED_MESSAGE
		);
	});

	it('rejects an unknown handle', async () => {
		await expect(enableSqliteEditing('nope')).rejects.toThrow(/no longer open/);
	});

	it('refuses a file that cannot be written, granting nothing', async () => {
		const file = await writeFixture('readonly-file.db');
		const { handle } = await openSqliteDatabase(file);
		await fs.chmod(file, 0o444);
		try {
			await expect(enableSqliteEditing(handle)).rejects.toThrow(
				`You do not have permission to write ${file}.`
			);
			expect(sqliteEditingGrantCount(handle)).toBe(0);
		} finally {
			await fs.chmod(file, 0o644);
		}
	});

	// A folder's write bit means nothing to Windows.
	it.skipIf(process.platform === 'win32')(
		'refuses a database whose folder cannot take a journal',
		async () => {
			const folder = await fs.mkdtemp(path.join(dir, 'readonly-folder-'));
			const file = await writeFixture('journal.db', folder);
			const { handle } = await openSqliteDatabase(file);
			await fs.chmod(folder, 0o555);
			try {
				await expect(enableSqliteEditing(handle)).rejects.toThrow(
					`SQLite writes its journal beside the database, and ${folder} is not writable.`
				);
			} finally {
				await fs.chmod(folder, 0o755);
			}
		}
	);
});

describe('sqliteEditingRefusal', () => {
	it('allows a writable file in a writable folder', async () => {
		const { handle } = await openSqliteDatabase(await writeFixture('writable.db'));
		await expect(sqliteEditingRefusal(getSqliteDatabase(handle))).resolves.toBeNull();
	});

	it('refuses a file that was deleted since it was opened', async () => {
		const file = await writeFixture('deleted.db');
		const { handle } = await openSqliteDatabase(file);
		const database = getSqliteDatabase(handle);
		await fs.rm(file);
		await expect(sqliteEditingRefusal(database)).resolves.toBe(`${file} no longer exists.`);
	});

	it('refuses a path that now names a different file', async () => {
		const file = await writeFixture('swapped.db');
		const { handle } = await openSqliteDatabase(file);
		const database = getSqliteDatabase(handle);
		// Write the replacement beside it and rename over, so it gets a new inode.
		await fs.rename(await writeFixture('swapped.db.tmp'), file);
		await expect(sqliteEditingRefusal(database)).resolves.toBe(
			`${file} was replaced since it was opened. Reopen the file to edit it.`
		);
	});
});

describe('beginSqliteWrite', () => {
	it('refuses a tab without a grant, before any backup or writable connection', async () => {
		const file = await writeFixture('write-locked.db');
		const { handle } = await openSqliteDatabase(file);

		await expect(beginSqliteWrite(handle, undefined)).rejects.toThrow(
			SQLITE_EDITING_LOCKED_MESSAGE
		);
		expect(await backupsOf(file)).toEqual([]);
		expect(hasSqliteWriteConnection(handle)).toBe(false);
	});

	it('backs the file up before the first write, then hands back one writable connection', async () => {
		const file = await writeFixture('write-first.db');
		const { handle } = await openSqliteDatabase(file);
		const grant = await enableSqliteEditing(handle);
		// Enabling alone writes nothing and opens nothing writable.
		expect(await backupsOf(file)).toEqual([]);
		expect(writableConnections(file)).toHaveLength(0);

		const first = await beginSqliteWrite(handle, grant.editToken);
		expect(first.backupCreated).toBe(true);
		expect(await backupsOf(file)).toEqual([path.basename(first.backup.path)]);
		expect(first.database).toBe(getSqliteDatabase(handle));
		expect(writableConnections(file)).toHaveLength(1);

		const second = await beginSqliteWrite(handle, grant.editToken);
		expect(second.backupCreated).toBe(false);
		expect(second.backup).toEqual(first.backup);
		expect(second.db).toBe(first.db);
		expect(await backupsOf(file)).toHaveLength(1);
	});

	it('closes the writable connection when the last tab locks, not before', async () => {
		const file = await writeFixture('write-lock.db');
		const { handle } = await openSqliteDatabase(file);
		const a = await enableSqliteEditing(handle);
		const b = await enableSqliteEditing(handle);
		await beginSqliteWrite(handle, a.editToken);

		disableSqliteEditing(handle, a.editToken);
		expect(hasSqliteWriteConnection(handle)).toBe(true);
		disableSqliteEditing(handle, b.editToken);
		expect(hasSqliteWriteConnection(handle)).toBe(false);
		expect(writableConnections(file)).toHaveLength(0);
	});

	it('closes the writable connection when the handle is released', async () => {
		const file = await writeFixture('write-release.db');
		const { handle } = await openSqliteDatabase(file);
		const grant = await enableSqliteEditing(handle);
		await beginSqliteWrite(handle, grant.editToken);

		await closeSqliteDatabase(handle);
		expect(hasSqliteWriteConnection(handle)).toBe(false);
		expect(writableConnections(file)).toHaveLength(0);
	});

	it('refuses a file replaced since the unlock, backing nothing up', async () => {
		const file = await writeFixture('write-swapped.db');
		const { handle } = await openSqliteDatabase(file);
		const grant = await enableSqliteEditing(handle);
		await fs.rename(await writeFixture('write-swapped.db.tmp'), file);

		await expect(beginSqliteWrite(handle, grant.editToken)).rejects.toThrow(
			`${file} was replaced since it was opened. Reopen the file to edit it.`
		);
		expect(await backupsOf(file)).toEqual([]);
		expect(writableConnections(file)).toHaveLength(0);
	});

	it('gives no writable connection to a tab that locked while the backup ran', async () => {
		const file = await writeFixture('write-lock-midway.db');
		const { handle } = await openSqliteDatabase(file);
		const grant = await enableSqliteEditing(handle);

		const write = beginSqliteWrite(handle, grant.editToken);
		disableSqliteEditing(handle, grant.editToken);
		await expect(write).rejects.toThrow(SQLITE_EDITING_LOCKED_MESSAGE);
		expect(writableConnections(file)).toHaveLength(0);
	});
});

describe('beginSqliteWorkerWrite', () => {
	it('passes the same gate and backup, then hands back the file instead of a connection', async () => {
		const file = await writeFixture('worker-first.db');
		const { handle } = await openSqliteDatabase(file);
		await expect(beginSqliteWorkerWrite(handle, 'made-up')).rejects.toThrow(
			SQLITE_EDITING_LOCKED_MESSAGE
		);
		expect(await backupsOf(file)).toEqual([]);

		const grant = await enableSqliteEditing(handle);
		const first = await beginSqliteWorkerWrite(handle, grant.editToken);
		const stat = await fs.stat(file);
		expect(first.target).toEqual({ filePath: file, dev: stat.dev, ino: stat.ino });
		expect(first.backupCreated).toBe(true);
		expect(await backupsOf(file)).toEqual([path.basename(first.backup.path)]);
		// The child opens the file itself: main opens nothing writable.
		expect(writableConnections(file)).toHaveLength(0);
		expect(hasSqliteWriteConnection(handle)).toBe(false);

		// One backup per session, whichever way the writes go.
		const cell = await beginSqliteWrite(handle, grant.editToken);
		expect(cell.backupCreated).toBe(false);
		expect(cell.backup).toEqual(first.backup);
	});

	it('refuses a tab that locked while the backup ran', async () => {
		const file = await writeFixture('worker-lock-midway.db');
		const { handle } = await openSqliteDatabase(file);
		const grant = await enableSqliteEditing(handle);
		const write = beginSqliteWorkerWrite(handle, grant.editToken);
		disableSqliteEditing(handle, grant.editToken);
		await expect(write).rejects.toThrow(SQLITE_EDITING_LOCKED_MESSAGE);
	});

	it('refuses a file replaced since the unlock', async () => {
		const file = await writeFixture('worker-swapped.db');
		const { handle } = await openSqliteDatabase(file);
		const grant = await enableSqliteEditing(handle);
		await fs.rename(await writeFixture('worker-swapped.db.tmp'), file);
		await expect(beginSqliteWorkerWrite(handle, grant.editToken)).rejects.toThrow(
			`${file} was replaced since it was opened. Reopen the file to edit it.`
		);
	});
});

describe('onSqliteEditingRevoked', () => {
	it('runs once when that tab locks, not when another tab does', async () => {
		const file = await writeFixture('revoke-lock.db');
		const { handle } = await openSqliteDatabase(file);
		const a = await enableSqliteEditing(handle);
		const b = await enableSqliteEditing(handle);
		const hook = vi.fn();
		onSqliteEditingRevoked(handle, a.editToken, hook);

		disableSqliteEditing(handle, b.editToken);
		expect(hook).not.toHaveBeenCalled();
		disableSqliteEditing(handle, a.editToken);
		expect(hook).toHaveBeenCalledTimes(1);
		expect(hook).toHaveBeenCalledWith('locked');
		disableSqliteEditing(handle, a.editToken);
		expect(hook).toHaveBeenCalledTimes(1);
	});

	it('runs with "closed" when the handle is released', async () => {
		const file = await writeFixture('revoke-release.db');
		const { handle } = await openSqliteDatabase(file);
		const grant = await enableSqliteEditing(handle);
		const hook = vi.fn();
		onSqliteEditingRevoked(handle, grant.editToken, hook);
		await closeSqliteDatabase(handle);
		expect(hook).toHaveBeenCalledWith('closed');
	});

	it('does not run once unregistered, and refuses a token that is not live', async () => {
		const file = await writeFixture('revoke-unhook.db');
		const { handle } = await openSqliteDatabase(file);
		const grant = await enableSqliteEditing(handle);
		const hook = vi.fn();
		const unhook = onSqliteEditingRevoked(handle, grant.editToken, hook);
		unhook();
		disableSqliteEditing(handle, grant.editToken);
		expect(hook).not.toHaveBeenCalled();

		expect(() => onSqliteEditingRevoked(handle, grant.editToken, hook)).toThrow(
			SQLITE_EDITING_LOCKED_MESSAGE
		);
	});
});
