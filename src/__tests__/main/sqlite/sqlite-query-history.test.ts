import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../main/utils/logger', () => ({
	logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const userData = vi.hoisted(() => ({ dir: '' }));
vi.mock('../../../main/utils/app-user-data', () => ({ getAppUserDataDir: () => userData.dir }));

vi.mock('../../../main/sqlite/sqlite-database', () => ({
	getSqliteDatabase: (handle: string) => {
		if (handle !== 'h1') throw new Error('SQLite database handle is no longer open.');
		return { displayPath: '/data/app.db' };
	},
}));

import {
	SQLITE_QUERY_HISTORY_FILE,
	createSqliteQueryHistoryFile,
	forgetSqliteQueryHistory,
	getSqliteQueryHistory,
	readSqliteQueryHistory,
} from '../../../main/sqlite/sqlite-query-history';
import { logger } from '../../../main/utils/logger';
import type { SqliteQueryHistoryRun } from '../../../shared/sqlite/history';

const ok = { ok: true as const, rows: 1, hasMore: false, returnsRows: true, elapsedMs: 1 };

function run(sql: string, ranAt = 1): SqliteQueryHistoryRun {
	return { sql, plan: false, params: {}, ranAt, outcome: ok };
}

let dir: string;
let file: string;

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-sqlite-history-'));
	file = path.join(dir, 'nested', SQLITE_QUERY_HISTORY_FILE);
	vi.clearAllMocks();
});

afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

describe('createSqliteQueryHistoryFile', () => {
	it('reads an empty history when no file exists yet', async () => {
		const history = createSqliteQueryHistoryFile(() => file);
		await expect(history.read('/data/app.db')).resolves.toEqual([]);
	});

	it('records runs newest first, per database, and keeps them on disk', async () => {
		const history = createSqliteQueryHistoryFile(() => file);
		await history.record('/data/app.db', run('SELECT 1', 1));
		await history.record('/data/app.db', run('SELECT 2', 2));
		await history.record('/data/other.db', run('SELECT 3', 3));

		const reopened = createSqliteQueryHistoryFile(() => file);
		expect((await reopened.read('/data/app.db')).map((entry) => entry.sql)).toEqual([
			'SELECT 2',
			'SELECT 1',
		]);
		expect((await reopened.read('/data/other.db')).map((entry) => entry.sql)).toEqual(['SELECT 3']);
	});

	it('serializes concurrent records so none is lost', async () => {
		const history = createSqliteQueryHistoryFile(() => file);
		await Promise.all(
			Array.from({ length: 10 }, (_, index) =>
				history.record('/data/app.db', run(`SELECT ${index}`))
			)
		);
		expect(await history.read('/data/app.db')).toHaveLength(10);
	});

	it('records nothing for an empty statement', async () => {
		const history = createSqliteQueryHistoryFile(() => file);
		await history.record('/data/app.db', run('   '));
		await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('forgets one entry, or every entry, and drops an emptied database', async () => {
		const history = createSqliteQueryHistoryFile(() => file);
		await history.record('/data/app.db', run('SELECT 1'));
		await history.record('/data/app.db', run('SELECT 2'));
		const [newest] = await history.read('/data/app.db');

		await expect(history.forget('/data/app.db', newest.id)).resolves.toBe(1);
		expect((await history.read('/data/app.db')).map((entry) => entry.sql)).toEqual(['SELECT 1']);
		await expect(history.forget('/data/app.db', 'no-such-id')).resolves.toBe(0);
		await expect(history.forget('/data/app.db', null)).resolves.toBe(1);
		await expect(history.forget('/data/never.db', null)).resolves.toBe(0);
		expect(JSON.parse(await fs.readFile(file, 'utf8')).files).toEqual({});
	});

	it('moves a file that is not JSON aside instead of overwriting it', async () => {
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, '{ torn');
		const history = createSqliteQueryHistoryFile(() => file);
		await expect(history.read('/data/app.db')).resolves.toEqual([]);
		const names = await fs.readdir(path.dirname(file));
		expect(names.some((name) => /\.corrupt-.*\.json$/.test(name))).toBe(true);
		expect(logger.warn).toHaveBeenCalled();

		await history.record('/data/app.db', run('SELECT 1'));
		expect(await history.read('/data/app.db')).toHaveLength(1);
	});

	it('hands back copies, so a caller cannot change the history in memory', async () => {
		const history = createSqliteQueryHistoryFile(() => file);
		await history.record('/data/app.db', run('SELECT 1'));
		(await history.read('/data/app.db')).pop();
		expect(await history.read('/data/app.db')).toHaveLength(1);
	});
});

describe('the app history, by handle', () => {
	beforeEach(() => {
		userData.dir = dir;
	});

	it('reads and forgets the history of an open database', async () => {
		await getSqliteQueryHistory().record('/data/app.db', run('SELECT 1'));
		const history = await readSqliteQueryHistory('h1');
		expect(history.path).toBe('/data/app.db');
		expect(history.entries.map((entry) => entry.sql)).toEqual(['SELECT 1']);
		await expect(fs.stat(path.join(dir, SQLITE_QUERY_HISTORY_FILE))).resolves.toBeTruthy();

		await expect(forgetSqliteQueryHistory('h1', null)).resolves.toEqual({
			path: '/data/app.db',
			entries: [],
		});
	});

	it('refuses a closed handle and an id that is not a string', async () => {
		await expect(readSqliteQueryHistory('gone')).rejects.toThrow(/no longer open/);
		await expect(forgetSqliteQueryHistory('h1', 7 as unknown as string)).rejects.toThrow(
			/must be a string/
		);
	});
});
