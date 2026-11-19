/**
 * Tests for the backup taken before the first write: once per file per
 * session, beside the file, never a partial file under the backup's name, and
 * a failed backup is not remembered.
 */

import { readFileSync, writeFileSync } from 'fs';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// better-sqlite3's native binary is built for Electron's ABI and does not load
// under vitest. The fake's `VACUUM INTO` copies the source's bytes to the
// bound path, which is what the real one produces for these purposes. Under
// vitest no compiled child entry exists, so the backup task runs inline.
const driver = vi.hoisted(() => ({
	opens: [] as Array<{ path: string; options: Record<string, unknown> }>,
	vacuums: [] as Array<{ source: string; dest: string }>,
	/** Error the VACUUM throws instead of copying, if any. */
	vacuumError: null as Error | null,
	/** Paths whose open fails its schema read (a copy that is no database). */
	unreadable: new Set<string>(),
}));

vi.mock('better-sqlite3', () => {
	class FakeDatabase {
		constructor(
			private readonly filePath: string,
			options: Record<string, unknown>
		) {
			driver.opens.push({ path: filePath, options });
		}
		pragma(source: string) {
			if (source === 'schema_version' && driver.unreadable.has(this.filePath)) {
				throw Object.assign(new Error('file is not a database'), { code: 'SQLITE_NOTADB' });
			}
			return 1;
		}
		prepare(sql: string) {
			return {
				run: (dest: string) => {
					if (sql !== 'VACUUM INTO ?') throw new Error(`Unexpected SQL: ${sql}`);
					if (driver.vacuumError) {
						// SQLite leaves what it wrote so far behind.
						writeFileSync(dest, 'partial');
						throw driver.vacuumError;
					}
					driver.vacuums.push({ source: this.filePath, dest });
					writeFileSync(dest, readFileSync(this.filePath));
				},
			};
		}
		close() {}
	}
	return { default: FakeDatabase };
});

import {
	SQLITE_BACKUP_NAME_MARKER,
	ensureSqliteBackup,
	forgetSqliteBackups,
	sqliteBackupPath,
} from '../../../main/sqlite/sqlite-backup';
import type { OpenSqliteDatabase } from '../../../main/sqlite/sqlite-database';
import { fileTimestampSlug } from '../../../shared/formatters';

const MAGIC = Buffer.from('SQLite format 3\0', 'latin1');
let dir: string;

/** A database file and the open-handle record the backup is handed. */
async function fixture(name: string): Promise<OpenSqliteDatabase> {
	const file = path.join(dir, name);
	await fs.writeFile(file, Buffer.concat([MAGIC, Buffer.from(name)]));
	const stat = await fs.stat(file);
	return {
		id: `handle-${name}`,
		displayPath: file,
		dev: stat.dev,
		ino: stat.ino,
		releaseHooks: new Set(),
	} as unknown as OpenSqliteDatabase;
}

async function backupsIn(folder: string): Promise<string[]> {
	return (await fs.readdir(folder)).filter((name) => name.includes(SQLITE_BACKUP_NAME_MARKER));
}

beforeAll(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-sqlite-backup-'));
});

afterAll(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
	driver.opens.length = 0;
	driver.vacuums.length = 0;
	driver.vacuumError = null;
	driver.unreadable.clear();
});

afterEach(() => {
	forgetSqliteBackups();
	vi.useRealTimers();
});

describe('sqliteBackupPath', () => {
	const at = new Date(2026, 10, 19, 3, 4, 5).getTime();
	const slug = fileTimestampSlug(at);

	it('stamps the name before a SQLite extension, keeping its case', () => {
		expect(sqliteBackupPath('/work/app.db', at)).toBe(
			path.join('/work', `app.maestro-backup-${slug}.db`)
		);
		expect(sqliteBackupPath('/work/Data.SQLite3', at)).toBe(
			path.join('/work', `Data.maestro-backup-${slug}.SQLite3`)
		);
	});

	it('appends .db when the name has no SQLite extension, so the viewer opens the copy', () => {
		expect(sqliteBackupPath('/work/History', at)).toBe(
			path.join('/work', `History.maestro-backup-${slug}.db`)
		);
		expect(sqliteBackupPath('/work/store.data', at)).toBe(
			path.join('/work', `store.data.maestro-backup-${slug}.db`)
		);
	});

	it('numbers a second attempt', () => {
		expect(sqliteBackupPath('/work/app.db', at, 2)).toBe(
			path.join('/work', `app.maestro-backup-${slug}-2.db`)
		);
	});
});

describe('ensureSqliteBackup', () => {
	it('copies the file beside itself with VACUUM INTO on a read-only connection', async () => {
		const database = await fixture('first.db');
		const { backup, created } = await ensureSqliteBackup(database);

		expect(created).toBe(true);
		expect(path.dirname(backup.path)).toBe(dir);
		expect(backup.path).toContain(`first.${SQLITE_BACKUP_NAME_MARKER}-`);
		expect(await fs.readFile(backup.path)).toEqual(await fs.readFile(database.displayPath));
		expect(backup.bytes).toBe((await fs.stat(backup.path)).size);
		expect(backup.createdAt).toBeGreaterThan(0);

		// The copy was written to a part file, then renamed; none is left.
		expect(driver.vacuums).toEqual([{ source: database.displayPath, dest: `${backup.path}.part` }]);
		expect(await fs.readdir(dir)).not.toContain(`${path.basename(backup.path)}.part`);
		const sourceOpen = driver.opens.find((open) => open.path === database.displayPath);
		expect(sourceOpen?.options).toMatchObject({ readonly: true, fileMustExist: true });
		// The copy is proven to open before it counts.
		expect(driver.opens.some((open) => open.path === `${backup.path}.part`)).toBe(true);
	});

	it('backs a file up once per session, whichever handle asks', async () => {
		const database = await fixture('once.db');
		const first = await ensureSqliteBackup(database);
		const second = await ensureSqliteBackup(database);
		// Another tab's handle on the same file: same device and inode.
		const otherHandle = { ...database, id: 'another-handle', releaseHooks: new Set() };
		const third = await ensureSqliteBackup(otherHandle as unknown as OpenSqliteDatabase);

		expect(second).toEqual({ backup: first.backup, created: false });
		expect(third).toEqual({ backup: first.backup, created: false });
		expect(driver.vacuums).toHaveLength(1);
	});

	it('shares one backup between concurrent first writes, announced once', async () => {
		const database = await fixture('concurrent.db');
		const results = await Promise.all([
			ensureSqliteBackup(database),
			ensureSqliteBackup(database),
			ensureSqliteBackup(database),
		]);

		expect(driver.vacuums).toHaveLength(1);
		expect(results.filter((result) => result.created)).toHaveLength(1);
		expect(new Set(results.map((result) => result.backup.path)).size).toBe(1);
	});

	it('backs up again after a restart (the session forgets)', async () => {
		const database = await fixture('restart.db');
		await ensureSqliteBackup(database);
		forgetSqliteBackups();
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(Date.now() + 2000);
		const again = await ensureSqliteBackup(database);

		expect(again.created).toBe(true);
		expect(driver.vacuums).toHaveLength(2);
		expect(await backupsIn(dir)).toEqual(
			expect.arrayContaining([path.basename(again.backup.path)])
		);
	});

	it('numbers the name when this second already has a backup beside the file', async () => {
		const database = await fixture('taken.db');
		const at = new Date(2026, 0, 2, 3, 4, 5).getTime();
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(at);
		await fs.writeFile(sqliteBackupPath(database.displayPath, at), 'somebody else');

		const { backup } = await ensureSqliteBackup(database);
		expect(backup.path).toBe(sqliteBackupPath(database.displayPath, at, 2));
		expect(await fs.readFile(sqliteBackupPath(database.displayPath, at), 'utf8')).toBe(
			'somebody else'
		);
	});

	it('fails the write when the copy fails, removes the part, and tries again next time', async () => {
		const folder = await fs.mkdtemp(path.join(dir, 'full-'));
		const file = path.join(folder, 'full.db');
		await fs.writeFile(file, Buffer.concat([MAGIC, Buffer.from('full')]));
		const stat = await fs.stat(file);
		const database = {
			id: 'h',
			displayPath: file,
			dev: stat.dev,
			ino: stat.ino,
			releaseHooks: new Set(),
		} as unknown as OpenSqliteDatabase;

		driver.vacuumError = Object.assign(new Error('database or disk is full'), {
			code: 'SQLITE_FULL',
		});
		const failure = await ensureSqliteBackup(database).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toBe(
			`Could not back up ${file} before the first change, so nothing was written. database or disk is full`
		);
		expect((failure as { code?: string }).code).toBe('SQLITE_FULL');
		expect(await fs.readdir(folder)).toEqual(['full.db']);

		driver.vacuumError = null;
		const retried = await ensureSqliteBackup(database);
		expect(retried.created).toBe(true);
		expect(await backupsIn(folder)).toEqual([path.basename(retried.backup.path)]);
	});

	it('refuses a copy that does not open as a database', async () => {
		const folder = await fs.mkdtemp(path.join(dir, 'unreadable-'));
		const file = path.join(folder, 'bad-copy.db');
		await fs.writeFile(file, Buffer.concat([MAGIC, Buffer.from('x')]));
		const stat = await fs.stat(file);
		const database = {
			id: 'h',
			displayPath: file,
			dev: stat.dev,
			ino: stat.ino,
			releaseHooks: new Set(),
		} as unknown as OpenSqliteDatabase;
		const at = Date.now();
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(at);
		driver.unreadable.add(`${sqliteBackupPath(file, at)}.part`);

		await expect(ensureSqliteBackup(database)).rejects.toThrow(
			/^Could not back up .* so nothing was written\. .*not a readable SQLite database/
		);
		expect(await fs.readdir(folder)).toEqual(['bad-copy.db']);
	});

	it('names the copy, not the database, when the backup file cannot be created', async () => {
		const database = await fixture('cantopen.db');
		driver.vacuumError = Object.assign(new Error('unable to open database: /x'), {
			code: 'SQLITE_CANTOPEN',
		});
		await expect(ensureSqliteBackup(database)).rejects.toThrow(
			'nothing was written. Could not create the backup file (unable to open database: /x).'
		);
	});
});
