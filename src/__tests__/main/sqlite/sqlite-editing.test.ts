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
// enough; the files are real because the checks read file metadata.
vi.mock('better-sqlite3', () => {
	class FakeDatabase {
		pragma() {
			return 1;
		}
		function() {
			return this;
		}
		close() {}
	}
	return { default: FakeDatabase };
});

import {
	closeAllSqliteDatabases,
	closeSqliteDatabase,
	getSqliteDatabase,
	openSqliteDatabase,
} from '../../../main/sqlite/sqlite-database';
import {
	SQLITE_EDITING_LOCKED_MESSAGE,
	disableSqliteEditing,
	enableSqliteEditing,
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
});

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
