import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it, vi } from 'vitest';

// Only the error helpers and the write target's file check are under test
// here; opening a connection has its own tests (sqlite-database.test.ts). The
// native driver never loads.
vi.mock('better-sqlite3', () => ({ default: vi.fn() }));

import Database from 'better-sqlite3';

import {
	SQLITE_BUSY_TIMEOUT_MS,
	describeSqliteBusy,
	describeSqliteOpenFailure,
	openWritableSqliteTarget,
	reportSqliteBusy,
	sqliteBusyMessage,
	sqliteFileReplacedMessage,
} from '../../../main/sqlite/sqlite-connection';

function sqliteError(code: string, message = 'database is locked'): Error {
	return Object.assign(new Error(message), { code });
}

describe('sqliteBusyMessage', () => {
	it('says another process has the database open, and what did not happen', () => {
		expect(sqliteBusyMessage('write')).toBe(
			`Another process has this database open and kept it locked past the ${SQLITE_BUSY_TIMEOUT_MS / 1000} s wait, so nothing was changed. Try again once that process finishes, or close it.`
		);
		expect(sqliteBusyMessage('read')).toContain('so it could not be read just now');
		expect(sqliteBusyMessage('backup')).toContain(
			'so it could not be backed up before the first change and nothing was written'
		);
		expect(sqliteBusyMessage('open', '/data/app.db')).toMatch(
			/^Another process has \/data\/app\.db open .* so it could not be opened\./
		);
	});
});

describe('describeSqliteBusy', () => {
	it('restates SQLITE_BUSY and its extended codes, keeping the code', () => {
		for (const code of ['SQLITE_BUSY', 'SQLITE_BUSY_SNAPSHOT', 'SQLITE_BUSY_RECOVERY']) {
			const described = describeSqliteBusy(sqliteError(code), 'write');
			expect(described).toBeInstanceOf(Error);
			expect((described as Error).message).toBe(sqliteBusyMessage('write'));
			expect((described as { code?: string }).code).toBe(code);
		}
	});

	it('returns every other failure untouched, SQLite words and all', () => {
		const constraint = sqliteError('SQLITE_CONSTRAINT_UNIQUE', 'UNIQUE constraint failed: t.a');
		expect(describeSqliteBusy(constraint, 'write')).toBe(constraint);
		// A conflict inside one connection is not another process.
		const locked = sqliteError('SQLITE_LOCKED', 'database table is locked');
		expect(describeSqliteBusy(locked, 'write')).toBe(locked);
		const plain = new Error('database is locked');
		expect(describeSqliteBusy(plain, 'read')).toBe(plain);
		expect(describeSqliteBusy('text', 'read')).toBe('text');
	});

	it('leaves an error it already restated alone, so the inner step names itself', () => {
		const backup = describeSqliteBusy(sqliteError('SQLITE_BUSY'), 'backup');
		expect(describeSqliteBusy(backup, 'write')).toBe(backup);
	});
});

describe('reportSqliteBusy', () => {
	it('restates a busy failure thrown synchronously', () => {
		expect(() =>
			reportSqliteBusy('read', () => {
				throw sqliteError('SQLITE_BUSY');
			})
		).toThrow(sqliteBusyMessage('read'));
	});

	it('restates a busy rejection', async () => {
		await expect(
			reportSqliteBusy('write', () => Promise.reject(sqliteError('SQLITE_BUSY')))
		).rejects.toThrow(sqliteBusyMessage('write'));
	});

	it('passes a result, and any other failure, through', async () => {
		expect(reportSqliteBusy('read', () => 7)).toBe(7);
		await expect(reportSqliteBusy('read', () => Promise.resolve('rows'))).resolves.toBe('rows');
		const other = sqliteError('SQLITE_ERROR', 'no such table: t');
		await expect(reportSqliteBusy('read', () => Promise.reject(other))).rejects.toBe(other);
	});
});

describe('describeSqliteOpenFailure', () => {
	it('names the file when another process kept it busy at open', () => {
		const failure = describeSqliteOpenFailure(sqliteError('SQLITE_BUSY_RECOVERY'), '/data/app.db');
		expect(failure.message).toBe(sqliteBusyMessage('open', '/data/app.db'));
		expect((failure as { code?: string }).code).toBe('SQLITE_BUSY_RECOVERY');
	});
});

describe('openWritableSqliteTarget', () => {
	it('refuses a path that names another file than the one opened, before opening anything', async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-sqlite-target-'));
		try {
			const file = path.join(dir, 'app.db');
			await fs.writeFile(file, 'x');
			const stat = await fs.stat(file);
			vi.mocked(Database).mockClear();

			expect(() =>
				openWritableSqliteTarget({ filePath: file, dev: stat.dev, ino: stat.ino + 1 })
			).toThrow(sqliteFileReplacedMessage(file));
			expect(Database).not.toHaveBeenCalled();
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it('opens the file it names writable, with every guard', async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-sqlite-target-'));
		try {
			const file = path.join(dir, 'app.db');
			await fs.writeFile(file, 'x');
			const stat = await fs.stat(file);
			const pragmas: string[] = [];
			vi.mocked(Database).mockClear();
			vi.mocked(Database).mockImplementation(function () {
				return {
					pragma: (source: string) => pragmas.push(source),
					function: vi.fn(),
					close: vi.fn(),
				};
			} as unknown as typeof Database);

			openWritableSqliteTarget({ filePath: file, dev: stat.dev, ino: stat.ino });
			expect(Database).toHaveBeenCalledWith(file, {
				readonly: false,
				fileMustExist: true,
				timeout: SQLITE_BUSY_TIMEOUT_MS,
			});
			expect(pragmas).toEqual(
				expect.arrayContaining(['trusted_schema = OFF', 'foreign_keys = ON'])
			);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
