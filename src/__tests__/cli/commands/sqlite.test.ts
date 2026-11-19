/**
 * @file sqlite.test.ts
 * @description Tests for `maestro-cli sqlite tables`: it sends the resolved path
 * on `sqlite_list_objects`, prints the rail's groups with row counts and sizes,
 * hides internal objects unless `--internal`, and reports failures with exit 1.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import * as path from 'path';

vi.mock('../../../cli/services/maestro-client', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/maestro-client')>()),
	withMaestroClient: vi.fn(),
}));

import { sqliteTables } from '../../../cli/commands/sqlite';
import { withMaestroClient } from '../../../cli/services/maestro-client';

const DB = path.resolve('/data/app.db');

function mockReply(reply: Record<string, unknown>) {
	const sent: Record<string, unknown>[] = [];
	vi.mocked(withMaestroClient).mockImplementation(async (action) =>
		action({
			sendCommand: vi.fn().mockImplementation((payload: Record<string, unknown>, rt: string) => {
				sent.push({ ...payload, responseType: rt });
				return Promise.resolve(reply);
			}),
		} as never)
	);
	return sent;
}

const OBJECTS = [
	{
		name: 'users',
		kind: 'table',
		tableName: 'users',
		internal: false,
		countable: true,
		hasStorage: true,
		tableType: 'table',
	},
	{
		name: 'users_email',
		kind: 'index',
		tableName: 'users',
		internal: false,
		countable: false,
		hasStorage: true,
	},
	{
		name: 'events',
		kind: 'table',
		tableName: 'events',
		internal: false,
		countable: true,
		hasStorage: true,
		tableType: 'table',
		withoutRowid: true,
	},
	{
		name: 'sqlite_sequence',
		kind: 'table',
		tableName: 'sqlite_sequence',
		internal: true,
		countable: true,
		hasStorage: true,
		tableType: 'table',
	},
];

const STATS = [
	{ name: 'users', rowCount: 1204, rowCountCapped: false, sizeBytes: 8192 },
	{ name: 'users_email', rowCount: null, rowCountCapped: false, sizeBytes: 4096 },
	{ name: 'events', rowCount: 100000, rowCountCapped: true, sizeBytes: 1048576 },
	{ name: 'sqlite_sequence', rowCount: 1, rowCountCapped: false, sizeBytes: 4096 },
];

function respond(overrides: Record<string, unknown> = {}) {
	return mockReply({
		type: 'sqlite_objects_result',
		success: true,
		database: { handle: 'h1', displayPath: DB, fileBytes: 2_000_000 },
		list: { objects: OBJECTS, sizesAvailable: true },
		stats: STATS,
		...overrides,
	});
}

describe('sqlite tables', () => {
	let logSpy: MockInstance;
	let errorSpy: MockInstance;
	const logged = () => logSpy.mock.calls.map((call) => call.join(' ')).join('\n');

	beforeEach(() => {
		vi.clearAllMocks();
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
	});

	it('sends the resolved path on sqlite_list_objects', async () => {
		const sent = respond();
		await sqliteTables(DB, {});
		expect(sent[0]).toMatchObject({
			type: 'sqlite_list_objects',
			path: DB,
			responseType: 'sqlite_objects_result',
		});
	});

	it('prints each group with row counts and sizes, capped counts as lower bounds', async () => {
		respond();
		await sqliteTables(DB, {});
		const out = logged();
		expect(out).toContain('Tables (2)');
		expect(out).toContain('Indexes (1)');
		expect(out).toMatch(/users\s+1,204\s+8\.0 KB/);
		expect(out).toContain('100,000+');
		expect(out).toContain('without rowid');
		expect(out).toContain('on users');
		expect(out).not.toContain('Views');
	});

	it('hides internal objects unless --internal, and says how many it hid', async () => {
		respond();
		await sqliteTables(DB, {});
		expect(logged()).not.toMatch(/^\s+sqlite_sequence/m);
		expect(logged()).toContain('1 internal object(s) hidden');

		logSpy.mockClear();
		respond();
		await sqliteTables(DB, { internal: true });
		expect(logged()).toMatch(/^\s+sqlite_sequence/m);
	});

	it('prints the objects merged with their stats under --json', async () => {
		respond();
		await sqliteTables(DB, { json: true });
		const json = JSON.parse(String(logSpy.mock.calls[0][0]));
		expect(json).toMatchObject({ success: true, path: DB, sizesAvailable: true });
		expect(json.objects.map((entry: { name: string }) => entry.name)).toEqual([
			'events',
			'users',
			'users_email',
		]);
		expect(json.objects[0]).toMatchObject({ rowCount: 100000, rowCountCapped: true });
	});

	it('exits 1 with the app error when the database cannot be read', async () => {
		mockReply({ type: 'sqlite_objects_result', success: false, error: 'Not a SQLite database: x' });
		await expect(sqliteTables(DB, {})).rejects.toThrow('__exit__');
		expect(errorSpy.mock.calls.join('\n')).toContain('Not a SQLite database: x');
		expect(process.exit).toHaveBeenCalledWith(1);
	});
});
