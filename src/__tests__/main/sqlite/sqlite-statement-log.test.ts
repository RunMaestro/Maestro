import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../main/utils/logger', () => ({
	logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));

const userData = vi.hoisted(() => ({ dir: '' }));
vi.mock('../../../main/utils/app-user-data', () => ({ getAppUserDataDir: () => userData.dir }));

vi.mock('../../../main/sqlite/sqlite-database', () => ({
	getSqliteDatabase: (handle: string) => {
		if (handle !== 'h1') throw new Error('SQLite database handle is no longer open.');
		return { displayPath: '/data/app.db' };
	},
}));

import {
	SQLITE_STATEMENT_LOG_FILE,
	clearSqliteStatementLog,
	createSqliteStatementLogFile,
	getSqliteStatementLog,
	logSqliteStatement,
	onSqliteStatementLogged,
	readSqliteStatementLog,
	sqliteLoggedBackup,
	sqliteLoggedChanges,
	sqliteLoggedFailure,
} from '../../../main/sqlite/sqlite-statement-log';
import { logger } from '../../../main/utils/logger';
import { captureException } from '../../../main/utils/sentry';
import type { SqliteStatementLogRecord } from '../../../shared/sqlite/statementLog';

function write(sql: string, at = 1): SqliteStatementLogRecord {
	return {
		kind: 'query',
		sql,
		params: {},
		table: null,
		transactionId: null,
		at,
		outcome: sqliteLoggedChanges(1, 0),
	};
}

let dir: string;
let file: string;

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-sqlite-log-'));
	file = path.join(dir, 'nested', SQLITE_STATEMENT_LOG_FILE);
	vi.clearAllMocks();
});

afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

describe('createSqliteStatementLogFile', () => {
	it('reads an empty log when no file exists yet', async () => {
		const log = createSqliteStatementLogFile(() => file);
		await expect(log.read('/data/app.db')).resolves.toEqual([]);
	});

	it('records every write newest first, never merging a repeat, per database, on disk', async () => {
		const log = createSqliteStatementLogFile(() => file);
		await log.record('/data/app.db', write('DELETE FROM t', 1));
		await log.record('/data/app.db', write('DELETE FROM t', 2));
		await log.record('/data/other.db', write('UPDATE u SET a = 1', 3));

		const reopened = createSqliteStatementLogFile(() => file);
		const entries = await reopened.read('/data/app.db');
		expect(entries.map((entry) => entry.at)).toEqual([2, 1]);
		expect(new Set(entries.map((entry) => entry.id)).size).toBe(2);
		expect((await reopened.read('/data/other.db')).map((entry) => entry.sql)).toEqual([
			'UPDATE u SET a = 1',
		]);
	});

	it('resolves the entry as kept, with its id', async () => {
		const log = createSqliteStatementLogFile(() => file);
		const kept = await log.record('/data/app.db', write('  DELETE FROM t  '));
		expect(kept.id).toEqual(expect.any(String));
		expect(kept.sql).toBe('DELETE FROM t');
	});

	it('serializes concurrent records so none is lost', async () => {
		const log = createSqliteStatementLogFile(() => file);
		await Promise.all(
			Array.from({ length: 10 }, (_, index) =>
				log.record('/data/app.db', write(`DELETE FROM t WHERE id = ${index}`))
			)
		);
		expect(await log.read('/data/app.db')).toHaveLength(10);
	});

	it('clears one database, dropping it from the file', async () => {
		const log = createSqliteStatementLogFile(() => file);
		await log.record('/data/app.db', write('DELETE FROM t'));
		await log.record('/data/app.db', write('DELETE FROM u'));
		await expect(log.clear('/data/app.db')).resolves.toBe(2);
		await expect(log.clear('/data/never.db')).resolves.toBe(0);
		expect(JSON.parse(await fs.readFile(file, 'utf8')).files).toEqual({});
	});

	it('moves a file that is not JSON aside instead of overwriting it', async () => {
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, '{ torn');
		const log = createSqliteStatementLogFile(() => file);
		await expect(log.read('/data/app.db')).resolves.toEqual([]);
		const names = await fs.readdir(path.dirname(file));
		expect(names.some((name) => /\.corrupt-.*\.json$/.test(name))).toBe(true);
		expect(logger.warn).toHaveBeenCalled();
	});
});

describe('logSqliteStatement', () => {
	beforeEach(async () => {
		userData.dir = dir;
		// The app log is one store for the whole run: start each test from an empty one.
		await getSqliteStatementLog().clear('/data/app.db');
	});

	it('records in the app log and announces the database to listeners', async () => {
		const heard: string[] = [];
		const stop = onSqliteStatementLogged((databasePath) => heard.push(databasePath));
		await logSqliteStatement('/data/app.db', write('DELETE FROM t'));
		stop();
		await logSqliteStatement('/data/app.db', write('DELETE FROM u'));

		expect(heard).toEqual(['/data/app.db']);
		expect((await getSqliteStatementLog().read('/data/app.db')).map((e) => e.sql)).toEqual([
			'DELETE FROM u',
			'DELETE FROM t',
		]);
	});

	it('never throws: a log it cannot write is reported, and nothing is announced', async () => {
		// A FILE where the data directory should be: the store cannot be written.
		const blocked = path.join(dir, 'blocked');
		await fs.writeFile(blocked, 'not a directory');
		userData.dir = blocked;
		const heard = vi.fn();
		const stop = onSqliteStatementLogged(heard);
		await expect(logSqliteStatement('/data/app.db', write('DELETE FROM t'))).resolves.toBe(
			undefined
		);
		stop();
		expect(heard).not.toHaveBeenCalled();
		expect(logger.warn).toHaveBeenCalled();
		expect(captureException).toHaveBeenCalled();
	});

	it('a listener that throws does not stop the others', async () => {
		const heard = vi.fn();
		const stopBad = onSqliteStatementLogged(() => {
			throw new Error('boom');
		});
		const stopGood = onSqliteStatementLogged(heard);
		await logSqliteStatement('/data/app.db', write('DELETE FROM t'));
		stopBad();
		stopGood();
		expect(heard).toHaveBeenCalledWith('/data/app.db');
		expect(logger.warn).toHaveBeenCalled();
		expect(captureException).not.toHaveBeenCalled();
	});
});

describe('the app log, by handle', () => {
	beforeEach(async () => {
		userData.dir = dir;
		// The app log is one store for the whole run: start each test from an empty one.
		await getSqliteStatementLog().clear('/data/app.db');
	});

	it('reads and clears the log of an open database, announcing the clear', async () => {
		await logSqliteStatement('/data/app.db', write('DELETE FROM t'));
		const log = await readSqliteStatementLog('h1');
		expect(log.path).toBe('/data/app.db');
		expect(log.entries.map((entry) => entry.sql)).toEqual(['DELETE FROM t']);

		const heard = vi.fn();
		const stop = onSqliteStatementLogged(heard);
		await expect(clearSqliteStatementLog('h1')).resolves.toEqual({
			path: '/data/app.db',
			entries: [],
		});
		// A second clear removes nothing, so it announces nothing.
		await clearSqliteStatementLog('h1');
		stop();
		expect(heard).toHaveBeenCalledTimes(1);
	});

	it('refuses a closed handle', async () => {
		await expect(readSqliteStatementLog('gone')).rejects.toThrow(/no longer open/);
		await expect(clearSqliteStatementLog('gone')).rejects.toThrow(/no longer open/);
	});
});

describe('record helpers', () => {
	it('builds outcomes and the backup field', () => {
		expect(sqliteLoggedChanges(3, 1)).toEqual({
			ok: true,
			changes: 3,
			otherChanges: 1,
			schemaChanges: [],
		});
		expect(sqliteLoggedFailure(new Error('UNIQUE constraint failed: t.id'))).toEqual({
			ok: false,
			error: 'UNIQUE constraint failed: t.id',
		});
		expect(sqliteLoggedBackup(undefined)).toEqual({});
		expect(sqliteLoggedBackup({ path: '/data/app.bak.db', bytes: 1, createdAt: 1 })).toEqual({
			backupPath: '/data/app.bak.db',
		});
	});
});
