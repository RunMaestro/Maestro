/**
 * @file sqlite.test.ts
 * @description Tests for `maestro-cli sqlite tables`: it sends the resolved path
 * on `sqlite_list_objects`, prints the rail's groups with row counts and sizes,
 * hides internal objects unless `--internal`, and reports failures with exit 1.
 * Also `maestro-cli sqlite schema`: columns, foreign keys, index keys, and the
 * CREATE SQL, over `sqlite_read_schema`. And `maestro-cli sqlite rows`: one
 * LIMIT/OFFSET window, sorted in SQLite, over `sqlite_read_rows`. And
 * `maestro-cli sqlite count`: the settled row count, over `sqlite_count_rows`.
 * And `maestro-cli sqlite blob`: one BLOB cell written to `--output` by the
 * app, over `sqlite_save_blob`. And `maestro-cli sqlite info`: the header facts
 * and, with `--check`, the integrity verdict, over `sqlite_read_summary`.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import * as path from 'path';

vi.mock('../../../cli/services/maestro-client', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/maestro-client')>()),
	withMaestroClient: vi.fn(),
}));

import {
	sqliteBlob,
	sqliteCount,
	sqliteInfo,
	sqliteRows,
	sqliteSchema,
	sqliteTables,
} from '../../../cli/commands/sqlite';
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

const USERS_SCHEMA = {
	name: 'orders',
	kind: 'table',
	tableName: 'orders',
	sql: 'CREATE TABLE orders (\n  id INTEGER PRIMARY KEY,\n  uid INTEGER REFERENCES users\n)',
	columns: [
		{
			name: 'id',
			declaredType: 'INTEGER',
			affinity: 'INTEGER',
			notNull: false,
			defaultValue: null,
			primaryKeyPosition: 1,
			references: [],
		},
		{
			name: 'uid',
			declaredType: 'INTEGER',
			affinity: 'INTEGER',
			notNull: true,
			defaultValue: '0',
			primaryKeyPosition: 0,
			references: [{ table: 'users', column: null }],
		},
	],
	foreignKeys: [
		{ table: 'users', from: ['uid'], to: [null], onUpdate: 'NO ACTION', onDelete: 'CASCADE' },
	],
};

function respondSchema(schema: Record<string, unknown> = USERS_SCHEMA) {
	return mockReply({
		type: 'sqlite_schema_result',
		success: true,
		database: { handle: 'h1', displayPath: DB, fileBytes: 4096 },
		schema,
	});
}

describe('sqlite schema', () => {
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

	it('sends the resolved path, the name, and a kind only when given', async () => {
		const sent = respondSchema();
		await sqliteSchema(DB, 'orders', {});
		expect(sent[0]).toEqual({
			type: 'sqlite_read_schema',
			path: DB,
			name: 'orders',
			responseType: 'sqlite_schema_result',
		});

		const again = respondSchema();
		await sqliteSchema(DB, 'orders', { kind: 'trigger' });
		expect(again[0]).toMatchObject({ kind: 'trigger' });
	});

	it('prints columns with affinity, PK, default, references, then FKs and the SQL', async () => {
		respondSchema();
		await sqliteSchema(DB, 'orders', {});
		const out = logged();
		expect(out).toContain(`orders (table) in ${DB}`);
		expect(out).toContain('Columns (2)');
		expect(out).toMatch(/NAME\s+TYPE\s+AFFINITY\s+PK\s+DEFAULT\s+REFERENCES\s+CONSTRAINTS/);
		expect(out).toMatch(/id\s+INTEGER\s+INTEGER\s+1/);
		expect(out).toMatch(/uid\s+INTEGER\s+INTEGER\s+0\s+users \(primary key\)\s+not null/);
		expect(out).toContain('Foreign keys (1)');
		expect(out).toContain('(uid) -> users (primary key) ON DELETE CASCADE');
		expect(out).toContain('  CREATE TABLE orders (');
		expect(out).toContain('    uid INTEGER REFERENCES users');
	});

	it('prints an index as key columns and explains a missing CREATE statement', async () => {
		respondSchema({
			name: 'sqlite_autoindex_users_1',
			kind: 'index',
			tableName: 'users',
			sql: null,
			columns: [],
			foreignKeys: [],
			index: {
				columns: [
					{ name: 'email', descending: false, collation: 'BINARY' },
					{ name: null, descending: true, collation: 'NOCASE' },
				],
				unique: true,
				partial: false,
				origin: 'unique',
			},
		});
		await sqliteSchema(DB, 'sqlite_autoindex_users_1', {});
		const out = logged();
		expect(out).toContain('on users');
		expect(out).toContain('Key columns (2): unique, from UNIQUE constraint');
		expect(out).toMatch(/email\s+ASC\s+BINARY/);
		expect(out).toMatch(/<expression>\s+DESC\s+NOCASE/);
		expect(out).toContain('no CREATE statement of its own');
	});

	it('prints the schema merged with the path under --json', async () => {
		respondSchema();
		await sqliteSchema(DB, 'orders', { json: true });
		const json = JSON.parse(String(logSpy.mock.calls[0][0]));
		expect(json).toMatchObject({ success: true, path: DB, name: 'orders', kind: 'table' });
		expect(json.columns[1].references).toEqual([{ table: 'users', column: null }]);
	});

	it('refuses an unknown --kind without contacting the app', async () => {
		await expect(sqliteSchema(DB, 'orders', { kind: 'column' })).rejects.toThrow('__exit__');
		expect(errorSpy.mock.calls.join('\n')).toContain('--kind must be one of');
		expect(withMaestroClient).not.toHaveBeenCalled();
	});

	it('exits 1 with the app error when the object is missing', async () => {
		mockReply({
			type: 'sqlite_schema_result',
			success: false,
			error: 'No table, view, index, or trigger is named nope.',
		});
		await expect(sqliteSchema(DB, 'nope', {})).rejects.toThrow('__exit__');
		expect(errorSpy.mock.calls.join('\n')).toContain('is named nope');
		expect(process.exit).toHaveBeenCalledWith(1);
	});
});

function respondRows(page: Record<string, unknown> = {}) {
	return mockReply({
		type: 'sqlite_rows_result',
		success: true,
		database: { handle: 'h1', displayPath: DB, fileBytes: 4096 },
		page: {
			name: 'users',
			columns: [
				{ name: 'id', declaredType: 'INTEGER' },
				{ name: 'email', declaredType: 'TEXT' },
				{ name: 'avatar', declaredType: 'BLOB' },
			],
			rows: [
				[1, 'ada@example.com', null],
				[2, '', { kind: 'blob', head: 'ffd8', bytes: 2048 }],
				[{ kind: 'integer', text: '9007199254740993' }, 'line one\nline two', null],
			],
			offset: 0,
			hasMore: true,
			orderedBy: ['rowid'],
			elapsedMs: 2,
			filtered: false,
			...page,
		},
	});
}

describe('sqlite rows', () => {
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

	it('sends the resolved path, the window, and no sort or filter by default', async () => {
		const sent = respondRows();
		await sqliteRows(DB, 'users', {});
		expect(sent[0]).toEqual({
			type: 'sqlite_read_rows',
			path: DB,
			name: 'users',
			offset: 0,
			limit: 50,
			sort: null,
			filter: null,
			responseType: 'sqlite_rows_result',
		});
	});

	it('sends --offset, --limit, --sort, and --desc', async () => {
		const sent = respondRows();
		await sqliteRows(DB, 'users', { offset: '100', limit: '20', sort: 'email', desc: true });
		expect(sent[0]).toMatchObject({
			offset: 100,
			limit: 20,
			sort: { column: 'email', direction: 'desc' },
		});
	});

	it('sends --filter as written, for the app to compile', async () => {
		const sent = respondRows({ filtered: true });
		await sqliteRows(DB, 'users', { filter: 'email ~ example and id > 1' });
		expect(sent[0]).toMatchObject({ filter: 'email ~ example and id > 1' });
		expect(logged()).toContain('Matching rows 1-3; more follow (--offset 3).');
	});

	it('says when a filter matches nothing', async () => {
		respondRows({ rows: [], hasMore: false, filtered: true });
		await sqliteRows(DB, 'users', { filter: 'id = 999' });
		expect(logged()).toContain('No matching rows.');
	});

	it('exits 1 and points at the span when the filter does not parse', async () => {
		respondRows({
			rows: [],
			hasMore: false,
			filterProblem: {
				message: 'No column "emial". Did you mean "email"?',
				start: 0,
				end: 5,
				suggestion: 'email',
			},
		});
		await expect(sqliteRows(DB, 'users', { filter: 'emial ~ ada' })).rejects.toThrow('__exit__');
		const errors = errorSpy.mock.calls.join('\n');
		expect(errors).toContain('Filter problem: No column "emial". Did you mean "email"?');
		expect(errors).toContain('  emial ~ ada\n  ^^^^^');
		expect(process.exit).toHaveBeenCalledWith(1);
	});

	it('reports a filter problem as JSON under --json', async () => {
		const filterProblem = { message: 'Unterminated string', start: 8, end: 12 };
		respondRows({ rows: [], hasMore: false, filterProblem });
		await expect(sqliteRows(DB, 'users', { filter: 'email = "ada', json: true })).rejects.toThrow(
			'__exit__'
		);
		const json = JSON.parse(String(logSpy.mock.calls[0][0]));
		expect(json).toEqual({
			success: false,
			error: 'Unterminated string',
			path: DB,
			filterProblem,
		});
	});

	it('prints the window as a table with NULL, BLOB sizes, and exact big integers', async () => {
		respondRows();
		await sqliteRows(DB, 'users', {});
		const out = logged();
		expect(out).toContain(`users in ${DB}`);
		expect(out).toMatch(/id\s+email\s+avatar/);
		expect(out).toMatch(/1\s+ada@example\.com\s+NULL/);
		expect(out).toContain('BLOB 2.0 KB');
		expect(out).toContain('9007199254740993');
		// A cell stays on one line of the table.
		expect(out).toContain('line one line two');
		expect(out).toContain('Rows 1-3; more follow (--offset 3).');
		expect(out).toContain('Ordered by rowid.');
	});

	it('says when nothing orders the rows, and when a window is past the end', async () => {
		respondRows({ rows: [], hasMore: false, orderedBy: [], offset: 500 });
		await sqliteRows(DB, 'active_users', { offset: '500' });
		const out = logged();
		expect(out).toContain('No rows past offset 500.');
		expect(out).toContain('Not ordered: rows come back in the order SQLite scans them.');
	});

	it('prints the page merged with the path under --json', async () => {
		respondRows();
		await sqliteRows(DB, 'users', { json: true });
		const json = JSON.parse(String(logSpy.mock.calls[0][0]));
		expect(json).toMatchObject({ success: true, path: DB, name: 'users', hasMore: true });
		expect(json.rows[1][2]).toEqual({ kind: 'blob', head: 'ffd8', bytes: 2048 });
	});

	it('refuses a bad --limit and a --desc with no --sort without contacting the app', async () => {
		await expect(sqliteRows(DB, 'users', { limit: '-3' })).rejects.toThrow('__exit__');
		expect(errorSpy.mock.calls.join('\n')).toContain('--limit must be a non-negative whole number');
		await expect(sqliteRows(DB, 'users', { desc: true })).rejects.toThrow('__exit__');
		expect(errorSpy.mock.calls.join('\n')).toContain('--desc needs --sort <column>');
		expect(withMaestroClient).not.toHaveBeenCalled();
	});

	it('exits 1 with the app error when the sort column is unknown', async () => {
		mockReply({
			type: 'sqlite_rows_result',
			success: false,
			error: 'users has no column named zzz.',
		});
		await expect(sqliteRows(DB, 'users', { sort: 'zzz' })).rejects.toThrow('__exit__');
		expect(errorSpy.mock.calls.join('\n')).toContain('no column named zzz');
		expect(process.exit).toHaveBeenCalledWith(1);
	});
});

describe('sqlite count', () => {
	let logSpy: MockInstance;
	let errorSpy: MockInstance;
	const logged = () => logSpy.mock.calls.map((call) => call.join(' ')).join('\n');

	function respondCount(
		count: Record<string, unknown> = {},
		overrides: Record<string, unknown> = {}
	) {
		return mockReply({
			type: 'sqlite_count_result',
			success: true,
			database: { handle: 'h1', displayPath: DB, fileBytes: 2_000_000 },
			count: {
				name: 'users',
				matched: 1_204_331,
				complete: true,
				cursor: null,
				filtered: false,
				elapsedMs: 840,
				...count,
			},
			...overrides,
		});
	}

	beforeEach(() => {
		vi.clearAllMocks();
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
	});

	it('sends the resolved path and no filter by default', async () => {
		const sent = respondCount();
		await sqliteCount(DB, 'users', {});
		expect(sent[0]).toEqual({
			type: 'sqlite_count_rows',
			path: DB,
			name: 'users',
			filter: null,
			responseType: 'sqlite_count_result',
		});
		expect(logged()).toBe(`users in ${DB}: 1,204,331 rows (840 ms).`);
	});

	it('sends --filter as written and says the count is of matches', async () => {
		const sent = respondCount({ matched: 12, filtered: true });
		await sqliteCount(DB, 'users', { filter: 'status = active' });
		expect(sent[0]).toMatchObject({ filter: 'status = active' });
		expect(logged()).toContain(': 12 matching rows');
	});

	it('marks a count that did not settle as a lower bound', async () => {
		respondCount({ matched: 40_000, complete: false });
		await sqliteCount(DB, 'users', {});
		expect(logged()).toContain(': 40,000+ rows');
	});

	it('prints the count as JSON under --json', async () => {
		respondCount();
		await sqliteCount(DB, 'users', { json: true });
		expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toMatchObject({
			success: true,
			path: DB,
			name: 'users',
			matched: 1_204_331,
			complete: true,
		});
	});

	it('exits 1 and points at the span when the filter does not parse', async () => {
		respondCount({
			matched: 0,
			complete: false,
			filterProblem: { message: 'No column "stauts"', start: 0, end: 6 },
		});
		await expect(sqliteCount(DB, 'users', { filter: 'stauts = x' })).rejects.toThrow('__exit__');
		const errors = errorSpy.mock.calls.join('\n');
		expect(errors).toContain('Filter problem: No column "stauts"');
		expect(errors).toContain('  stauts = x\n  ^^^^^^');
		expect(process.exit).toHaveBeenCalledWith(1);
	});

	it("exits 1 with the app's error", async () => {
		mockReply({
			type: 'sqlite_count_result',
			success: false,
			error: 'No table or view is named gone.',
		});
		await expect(sqliteCount(DB, 'gone', {})).rejects.toThrow('__exit__');
		expect(errorSpy.mock.calls.join('\n')).toContain('No table or view is named gone.');
		expect(process.exit).toHaveBeenCalledWith(1);
	});
});

describe('sqlite blob', () => {
	let logSpy: MockInstance;
	let errorSpy: MockInstance;
	const logged = () => logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
	const OUT = path.resolve('/tmp/logo.png');

	function respondBlob(
		saved: Record<string, unknown> = {},
		overrides: Record<string, unknown> = {}
	) {
		return mockReply({
			type: 'sqlite_blob_result',
			success: true,
			database: { handle: 'h1', displayPath: DB, fileBytes: 2_000_000 },
			saved: { path: OUT, bytes: 2048, rowid: '7', ...saved },
			...overrides,
		});
	}

	beforeEach(() => {
		vi.clearAllMocks();
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
	});

	it('sends the resolved paths and the rowid, and says what it wrote', async () => {
		const sent = respondBlob();
		await sqliteBlob(DB, 'media', 'data', { rowid: '7', output: OUT });
		expect(sent[0]).toEqual({
			type: 'sqlite_save_blob',
			path: DB,
			name: 'media',
			column: 'data',
			rowid: '7',
			offset: null,
			sort: null,
			filter: null,
			destPath: OUT,
			responseType: 'sqlite_blob_result',
		});
		expect(logged()).toBe(`Saved data of media (rowid 7) to ${OUT}: 2.0 KB (2048 bytes).`);
	});

	it('places a row by --offset with the same --sort and --filter as sqlite rows', async () => {
		const sent = respondBlob({ rowid: null });
		await sqliteBlob(DB, 'thumbs', 'img', {
			offset: '4',
			sort: 'img',
			desc: true,
			filter: 'img is not null',
			output: OUT,
		});
		expect(sent[0]).toMatchObject({
			rowid: null,
			offset: 4,
			sort: { column: 'img', direction: 'desc' },
			filter: 'img is not null',
		});
		expect(logged()).toContain('(row 5)');
	});

	it('prints what was written as JSON under --json', async () => {
		respondBlob();
		await sqliteBlob(DB, 'media', 'data', { rowid: '7', output: OUT, json: true });
		expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toEqual({
			success: true,
			path: DB,
			output: OUT,
			bytes: 2048,
			rowid: '7',
		});
	});

	it.each([
		[{ output: OUT }, 'exactly one of --rowid <id> or --offset <n>'],
		[{ rowid: '7', offset: '1', output: OUT }, 'exactly one of --rowid <id> or --offset <n>'],
		[{ rowid: '7; DROP', output: OUT }, '--rowid must be a whole number'],
		[{ rowid: '7', sort: 'img', output: OUT }, 'a --rowid needs neither'],
		[{ offset: '0', desc: true, output: OUT }, '--desc needs --sort <column>'],
		[{ offset: '-2', output: OUT }, '--offset must be a non-negative whole number'],
		[{ rowid: '7' }, '--output <file> is required'],
	])('refuses %o before asking the app', async (options, message) => {
		const sent = respondBlob();
		await expect(sqliteBlob(DB, 'media', 'data', options)).rejects.toThrow('__exit__');
		expect(errorSpy.mock.calls.join('\n')).toContain(message);
		expect(sent).toEqual([]);
	});

	it("exits 1 with the app's error", async () => {
		mockReply({
			type: 'sqlite_blob_result',
			success: false,
			error: 'data holds NULL in rowid 7, not a BLOB.',
		});
		await expect(sqliteBlob(DB, 'media', 'data', { rowid: '7', output: OUT })).rejects.toThrow(
			'__exit__'
		);
		expect(errorSpy.mock.calls.join('\n')).toContain('data holds NULL in rowid 7, not a BLOB.');
		expect(process.exit).toHaveBeenCalledWith(1);
	});
});

const SUMMARY = {
	pageSize: 4096,
	pageCount: 195,
	freelistCount: 49,
	encoding: 'UTF-8',
	journalMode: 'wal',
	userVersion: 7,
	applicationId: 1598903374,
	sqliteVersion: '3.53.2',
};

function respondSummary(overrides: Record<string, unknown> = {}) {
	return mockReply({
		type: 'sqlite_summary_result',
		success: true,
		database: { handle: 'h1', displayPath: DB, fileBytes: 798_720 },
		summary: SUMMARY,
		integrity: null,
		...overrides,
	});
}

describe('sqlite info', () => {
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

	it('sends the resolved path on sqlite_read_summary, with no check by default', async () => {
		const sent = respondSummary();
		await sqliteInfo(DB, {});
		expect(sent[0]).toEqual({
			type: 'sqlite_read_summary',
			path: DB,
			responseType: 'sqlite_summary_result',
		});
	});

	it('prints each header fact, the library version, and that integrity was not checked', async () => {
		respondSummary();
		await sqliteInfo(DB, {});
		const out = logged();
		expect(out).toMatch(/Pages\s+195 x 4\.0 KB/);
		expect(out).toMatch(/Free\s+196\.0 KB/);
		expect(out).toMatch(/Encoding\s+UTF-8/);
		expect(out).toMatch(/Journal\s+WAL/);
		expect(out).toMatch(/user_version\s+7/);
		expect(out).toMatch(/application_id\s+0x5F4D544E/);
		expect(out).toMatch(/SQLite\s+3\.53\.2/);
		expect(out).toContain('not checked (pass --check quick)');
	});

	it('passes --check through and prints a sound verdict', async () => {
		const sent = respondSummary({
			integrity: { mode: 'full', ok: true, problems: [], truncated: false, elapsedMs: 4 },
		});
		await sqliteInfo(DB, { check: 'full' });
		expect(sent[0]).toMatchObject({ integrity: 'full' });
		expect(logged()).toMatch(/Integrity\s+ok \(full check, 4 ms\)/);
		expect(process.exit).not.toHaveBeenCalled();
	});

	it('lists the problems and exits 1 when the check finds any', async () => {
		respondSummary({
			integrity: {
				mode: 'quick',
				ok: false,
				problems: ['wrong # of entries in index tv'],
				truncated: true,
				elapsedMs: 2,
			},
		});
		await expect(sqliteInfo(DB, { check: 'quick' })).rejects.toThrow('__exit__');
		const out = logged();
		expect(out).toContain('1+ problems (quick check, 2 ms)');
		expect(out).toContain('  wrong # of entries in index tv');
		expect(out).toContain('(more problems not listed)');
		expect(process.exit).toHaveBeenCalledWith(1);
	});

	it('prints the summary and verdict under --json, still exiting 1 on problems', async () => {
		const verdict = { mode: 'quick', ok: false, problems: ['bad'], truncated: false, elapsedMs: 2 };
		respondSummary({ integrity: verdict });
		await expect(sqliteInfo(DB, { check: 'quick', json: true })).rejects.toThrow('__exit__');
		const json = JSON.parse(String(logSpy.mock.calls[0][0]));
		expect(json).toEqual({
			success: true,
			path: DB,
			fileBytes: 798_720,
			...SUMMARY,
			integrity: verdict,
		});
	});

	it('refuses an unknown --check mode before asking the app', async () => {
		await expect(sqliteInfo(DB, { check: 'deep' })).rejects.toThrow('__exit__');
		expect(errorSpy.mock.calls.join('\n')).toContain('--check must be quick or full');
		expect(withMaestroClient).not.toHaveBeenCalled();
	});

	it('exits 1 with the app error when the database cannot be read', async () => {
		mockReply({ type: 'sqlite_summary_result', success: false, error: 'Not a SQLite database: x' });
		await expect(sqliteInfo(DB, {})).rejects.toThrow('__exit__');
		expect(errorSpy.mock.calls.join('\n')).toContain('Not a SQLite database: x');
	});
});
