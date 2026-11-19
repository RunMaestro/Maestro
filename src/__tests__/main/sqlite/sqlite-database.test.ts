import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// better-sqlite3's native binary is built for Electron's ABI and does not load
// under vitest, so the driver is a fake that records how it was opened. The
// files themselves are real: the header sniff in front of the open reads disk.
const driver = vi.hoisted(() => ({
	instances: [] as Array<{
		path: string;
		options: Record<string, unknown>;
		pragmas: string[];
		functions: Array<{ name: string; options: Record<string, unknown>; fn: unknown }>;
		closed: boolean;
	}>,
	/** Error the next `pragma('schema_version')` throws, if any. */
	schemaReadError: null as Error | null,
	/** Error the next constructor call throws, if any. */
	constructorError: null as Error | null,
}));

vi.mock('better-sqlite3', () => {
	class FakeDatabase {
		record: (typeof driver.instances)[number];
		constructor(filePath: string, options: Record<string, unknown>) {
			if (driver.constructorError) {
				const error = driver.constructorError;
				driver.constructorError = null;
				throw error;
			}
			this.record = { path: filePath, options, pragmas: [], functions: [], closed: false };
			driver.instances.push(this.record);
		}
		pragma(source: string) {
			this.record.pragmas.push(source);
			if (source === 'schema_version' && driver.schemaReadError) {
				const error = driver.schemaReadError;
				driver.schemaReadError = null;
				throw error;
			}
			return 1;
		}
		function(name: string, options: Record<string, unknown>, fn: unknown) {
			this.record.functions.push({ name, options, fn });
			return this;
		}
		close() {
			this.record.closed = true;
		}
	}
	return { default: FakeDatabase };
});

import { SQLITE_REGEXP_FUNCTION, sqliteRegexpTest } from '../../../shared/sqlite/filter';
import { openWritableSqliteConnection } from '../../../main/sqlite/sqlite-connection';
import { SQLITE_ROW_VERSION_FUNCTION } from '../../../main/sqlite/sqlite-row-version';
import {
	SQLITE_BUSY_TIMEOUT_MS,
	closeAllSqliteDatabases,
	closeSqliteDatabase,
	getSqliteDatabase,
	openSqliteDatabase,
	openSqliteDatabaseCount,
} from '../../../main/sqlite/sqlite-database';

const MAGIC = Buffer.from('SQLite format 3\0', 'latin1');
let dir: string;

async function writeFixture(name: string, bytes = Buffer.concat([MAGIC, Buffer.alloc(4080)])) {
	const file = path.join(dir, name);
	await fs.writeFile(file, bytes);
	return file;
}

function sqliteError(code: string, message: string): Error {
	return Object.assign(new Error(message), { code });
}

beforeAll(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-sqlite-database-'));
});

afterAll(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
	driver.instances.length = 0;
	driver.schemaReadError = null;
	driver.constructorError = null;
});

afterEach(async () => {
	await closeAllSqliteDatabases();
});

describe('openSqliteDatabase', () => {
	it('opens read-only, never creating the file, with a short busy timeout', async () => {
		const file = await writeFixture('app.db');
		const info = await openSqliteDatabase(file);

		expect(info).toEqual({ handle: expect.any(String), displayPath: file, fileBytes: 4096 });
		expect(driver.instances).toHaveLength(1);
		expect(driver.instances[0].path).toBe(file);
		expect(driver.instances[0].options).toEqual({
			readonly: true,
			fileMustExist: true,
			timeout: SQLITE_BUSY_TIMEOUT_MS,
		});
	});

	it('turns off trusted_schema and reads page 1 before handing the handle out', async () => {
		const file = await writeFixture('trusted.db');
		await openSqliteDatabase(file);
		expect(driver.instances[0].pragmas).toEqual(['trusted_schema = OFF', 'schema_version']);
	});

	it('enforces foreign keys on a writable connection only', async () => {
		const file = await writeFixture('writable.db');
		openWritableSqliteConnection(file);
		expect(driver.instances[0].options).toMatchObject({ readonly: false, fileMustExist: true });
		expect(driver.instances[0].pragmas).toEqual([
			'trusted_schema = OFF',
			'foreign_keys = ON',
			'schema_version',
		]); // A write checks the row version its page carried.
		expect(driver.instances[0].functions.map((entry) => entry.name)).toEqual([
			SQLITE_ROW_VERSION_FUNCTION,
		]);
	});

	it("registers the table filter's regex function and the row version an edit checks", async () => {
		const file = await writeFixture('regexp.db');
		await openSqliteDatabase(file);
		expect(driver.instances[0].functions).toEqual([
			{ name: SQLITE_REGEXP_FUNCTION, options: { deterministic: true }, fn: sqliteRegexpTest },
			{
				name: SQLITE_ROW_VERSION_FUNCTION,
				options: { varargs: true, deterministic: true, directOnly: true, safeIntegers: true },
				fn: expect.any(Function),
			},
		]);
	});

	it('reuses the open connection for the same file', async () => {
		const file = await writeFixture('shared.sqlite');
		const first = await openSqliteDatabase(file);
		const second = await openSqliteDatabase(file);
		expect(second.handle).toBe(first.handle);
		expect(driver.instances).toHaveLength(1);
		expect(openSqliteDatabaseCount()).toBe(1);
	});

	it('opens a fresh connection when the path now names a different file', async () => {
		const file = await writeFixture('replaced.db');
		const first = await openSqliteDatabase(file);
		// Write the replacement beside it and rename over, so it gets a new inode.
		const replacement = await writeFixture('replaced.db.tmp');
		await fs.rename(replacement, file);
		const second = await openSqliteDatabase(file);
		expect(second.handle).not.toBe(first.handle);
		expect(driver.instances).toHaveLength(2);
	});

	it('refuses a .db that is not SQLite without opening it', async () => {
		const file = await writeFixture('berkeley.db', Buffer.from('not sqlite at all, just bytes'));
		await expect(openSqliteDatabase(file)).rejects.toThrow('Not a SQLite database');
		expect(driver.instances).toHaveLength(0);
	});

	it('refuses a missing file', async () => {
		await expect(openSqliteDatabase(path.join(dir, 'gone.db'))).rejects.toMatchObject({
			code: 'ENOENT',
		});
		expect(driver.instances).toHaveLength(0);
	});

	it('names an encrypted or damaged file and closes the connection it opened', async () => {
		const file = await writeFixture('cipher.db');
		driver.schemaReadError = sqliteError('SQLITE_NOTADB', 'file is not a database');
		await expect(openSqliteDatabase(file)).rejects.toMatchObject({
			code: 'SQLITE_NOTADB',
			message: expect.stringContaining('may be encrypted'),
		});
		expect(driver.instances[0].closed).toBe(true);
		expect(openSqliteDatabaseCount()).toBe(0);
	});

	it('reports a lock held by another process plainly', async () => {
		const file = await writeFixture('busy.db');
		driver.schemaReadError = sqliteError('SQLITE_BUSY', 'database is locked');
		await expect(openSqliteDatabase(file)).rejects.toThrow('Another process has');
	});

	it('passes a failure that is not about the file through untouched', async () => {
		const file = await writeFixture('addon.db');
		const addonError = sqliteError('ERR_DLOPEN_FAILED', 'NODE_MODULE_VERSION mismatch');
		driver.constructorError = addonError;
		await expect(openSqliteDatabase(file)).rejects.toBe(addonError);
	});
});

describe('handles', () => {
	it('looks up an open handle and refuses a closed one', async () => {
		const file = await writeFixture('lookup.db');
		const { handle } = await openSqliteDatabase(file);
		expect(getSqliteDatabase(handle).displayPath).toBe(file);

		await closeSqliteDatabase(handle);
		expect(driver.instances[0].closed).toBe(true);
		expect(() => getSqliteDatabase(handle)).toThrow('no longer open');
		await expect(closeSqliteDatabase(handle)).resolves.toBeUndefined();
	});

	it('runs release hooks before closing, so work tied to the handle stops with it', async () => {
		const file = await writeFixture('hooks.db');
		const { handle } = await openSqliteDatabase(file);
		const order: string[] = [];
		getSqliteDatabase(handle).releaseHooks.add(() =>
			order.push(driver.instances[0].closed ? 'after close' : 'before close')
		);

		await closeSqliteDatabase(handle);
		expect(order).toEqual(['before close']);
		expect(driver.instances[0].closed).toBe(true);
	});

	it('closeAll closes every connection', async () => {
		await openSqliteDatabase(await writeFixture('one.db'));
		await openSqliteDatabase(await writeFixture('two.db'));
		await closeAllSqliteDatabases();
		expect(driver.instances.every((instance) => instance.closed)).toBe(true);
		expect(openSqliteDatabaseCount()).toBe(0);
	});
});
