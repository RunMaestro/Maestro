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
 * and, with `--check`, the integrity verdict, over `sqlite_read_summary`. And
 * `maestro-cli sqlite query`: one read-only statement's window, over
 * `sqlite_run_query`, and with `--output` its whole result written to a file
 * by the app, over `sqlite_export_query`. And `maestro-cli sqlite history`:
 * the statements run against a database, over `sqlite_query_history`. And
 * `maestro-cli sqlite set`: one cell changed by the app, unlocked for that one
 * call, over `sqlite_update_cell`. And `maestro-cli sqlite insert` / `delete`:
 * one row added or removed the same way, over `sqlite_insert_row` and
 * `sqlite_delete_row`. And `maestro-cli sqlite undo`: the `undo` step a write
 * printed, applied by the app, over `sqlite_undo_edit`. And
 * `maestro-cli sqlite transaction`: several statements in one transaction,
 * committed or rolled back, over `sqlite_run_transaction`.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../../../cli/services/maestro-client', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/maestro-client')>()),
	withMaestroClient: vi.fn(),
}));

import {
	sqliteBlob,
	sqliteCount,
	sqliteDelete,
	sqliteHistory,
	sqliteInfo,
	sqliteLog,
	sqliteInsert,
	sqliteInsertValuesFromFlags,
	sqliteQuery,
	sqliteQueryParamsFromFlags,
	sqliteRows,
	sqliteCellValueFromFlags,
	sqliteRowKeyFromFlags,
	sqliteSchema,
	sqliteSet,
	sqliteTables,
	sqliteTransaction,
	sqliteUndo,
	sqliteUndoStepFromFlag,
} from '../../../cli/commands/sqlite';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { SQLITE_QUERY_PLAN_KIND_HINTS } from '../../../shared/sqlite/plan';
import { SQLITE_NOT_READ_ONLY_MESSAGE } from '../../../shared/sqlite/query';
import { SQLITE_QUERY_WRITE_UNDO_MESSAGE } from '../../../shared/sqlite/undo';

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
	editability: {
		editable: true,
		identity: { kind: 'rowid', alias: 'rowid', rowidColumn: 'id' },
		readOnlyColumns: [],
	},
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
		expect(out).toContain(
			'Editing\n  Editable. An edit names its row by rowid, which is the column id.'
		);
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
		expect(out).not.toContain('Editing');
	});

	it('prints why a table is read-only', async () => {
		respondSchema({
			...USERS_SCHEMA,
			editability: {
				editable: false,
				code: 'no-identity',
				reason: 'orders has no primary key, so an edit cannot name one row.',
			},
		});
		await sqliteSchema(DB, 'orders', {});
		expect(logged()).toContain(
			'Editing\n  Read-only. orders has no primary key, so an edit cannot name one row.'
		);
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

describe('sqlite query', () => {
	let logSpy: MockInstance;
	let errorSpy: MockInstance;
	const logged = () => logSpy.mock.calls.map((call) => call.join(' ')).join('\n');

	const RESULT = {
		statement: 'SELECT',
		columns: [
			{ name: 'id', declaredType: 'INTEGER' },
			{ name: 'email', declaredType: 'TEXT' },
		],
		rows: [
			[1, 'ada@example.com'],
			[2, null],
		],
		offset: 0,
		hasMore: true,
		returnsRows: true,
		elapsedMs: 4,
	};

	function respondQuery(overrides: Record<string, unknown> = {}) {
		return mockReply({
			type: 'sqlite_query_result',
			success: true,
			database: { handle: 'h1', displayPath: DB, fileBytes: 4096 },
			result: { ...RESULT, ...overrides },
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

	it('sends the resolved path, the statement as written, and the first 50 rows', async () => {
		const sent = respondQuery();
		await sqliteQuery(DB, 'SELECT id, email FROM users', {});
		expect(sent[0]).toEqual({
			type: 'sqlite_run_query',
			path: DB,
			sql: 'SELECT id, email FROM users',
			offset: 0,
			limit: 50,
			params: {},
			plan: false,
			responseType: 'sqlite_query_result',
		});
	});

	it('sends --param, --param-number, and --param-null values keyed by the parameter', async () => {
		const sent = respondQuery();
		await sqliteQuery(DB, 'SELECT * FROM users WHERE email = ? AND id > :min OR note IS @note', {
			param: ['?1=a=b@example.com'],
			paramNumber: ['min=10'],
			paramNull: ['@note'],
		});
		expect(sent[0].params).toEqual({
			'?1': { type: 'text', text: 'a=b@example.com' },
			':min': { type: 'number', text: '10' },
			'@note': { type: 'null', text: '' },
		});
	});

	it('refuses a parameter with no value, or a --param-number that is no number, before asking the app', async () => {
		const sent = respondQuery();
		await expect(sqliteQuery(DB, 'SELECT * FROM users WHERE id = :id', {})).rejects.toThrow(
			'__exit__'
		);
		expect(errorSpy.mock.calls.join('\n')).toContain('Give :id a value.');
		await expect(sqliteQuery(DB, 'SELECT :id', { paramNumber: ['id=ten'] })).rejects.toThrow(
			'__exit__'
		);
		expect(errorSpy.mock.calls.join('\n')).toContain(
			':id is set to Number, but "ten" is not a number.'
		);
		expect(sent).toHaveLength(0);
	});

	it('prints the rows as a table, NULL spelled out, with the next offset', async () => {
		respondQuery();
		await sqliteQuery(DB, 'SELECT id, email FROM users', { offset: '0', limit: '2' });
		const out = logged();
		expect(out).toContain(`SELECT on ${DB}`);
		expect(out).toContain('ada@example.com');
		expect(out).toContain('NULL');
		expect(out).toContain('Rows 1-2; more follow (--offset 2).');
		expect(out).toContain('4 ms.');
	});

	it('says when the statement returns no rows by design', async () => {
		respondQuery({
			statement: 'PRAGMA',
			columns: [],
			rows: [],
			hasMore: false,
			returnsRows: false,
		});
		await sqliteQuery(DB, 'PRAGMA trusted_schema = ON', {});
		expect(logged()).toContain('The statement ran and returns no rows.');
	});

	it('prints the reply as JSON under --json', async () => {
		respondQuery();
		await sqliteQuery(DB, 'SELECT 1', { json: true });
		expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toEqual({
			success: true,
			path: DB,
			...RESULT,
		});
	});

	it("exits 1 with the app's refusal", async () => {
		mockReply({
			type: 'sqlite_query_result',
			success: false,
			error: SQLITE_NOT_READ_ONLY_MESSAGE,
		});
		await expect(sqliteQuery(DB, 'WITH x AS (SELECT 1) DELETE FROM users', {})).rejects.toThrow(
			'__exit__'
		);
		expect(errorSpy.mock.calls.join('\n')).toContain(SQLITE_NOT_READ_ONLY_MESSAGE);
		expect(process.exit).toHaveBeenCalledWith(1);
	});

	it('refuses a write by its keyword before asking the app, unless --enable-editing', async () => {
		const sent = respondQuery();
		await expect(sqliteQuery(DB, 'DELETE FROM users', {})).rejects.toThrow('__exit__');
		expect(errorSpy.mock.calls.join('\n')).toContain('DELETE is not a read-only statement.');
		expect(sent).toHaveLength(0);
	});

	it('--enable-editing asks the app to unlock for this run, and prints what the statement changed', async () => {
		const sent = respondQuery({
			statement: 'DELETE',
			columns: [],
			rows: [],
			hasMore: false,
			returnsRows: false,
			write: {
				changes: 3,
				otherChanges: 2,
				schemaChanges: [],
				backup: { path: '/data/app.maestro-backup-1.db', bytes: 8192, createdAt: 1 },
			},
		});
		await sqliteQuery(DB, 'DELETE FROM users WHERE id > 1', { enableEditing: true });
		expect(sent[0]).toMatchObject({
			type: 'sqlite_run_query',
			sql: 'DELETE FROM users WHERE id > 1',
			enableEditing: true,
		});
		const out = logged();
		expect(out).toContain(`DELETE on ${DB}`);
		expect(out).toContain('Changed 3 rows.');
		expect(out).toContain("The database's triggers and foreign-key actions changed 2 other rows.");
		expect(out).toContain(
			`Backed up ${DB} before this first change: /data/app.maestro-backup-1.db`
		);
		expect(out).toContain(SQLITE_QUERY_WRITE_UNDO_MESSAGE);
		expect(out).not.toContain('returns no rows');
	});

	it('--enable-editing says what a schema change created, dropped, or altered', async () => {
		respondQuery({
			statement: 'CREATE',
			columns: [],
			rows: [],
			hasMore: false,
			returnsRows: false,
			write: {
				changes: 0,
				otherChanges: 0,
				schemaChanges: [{ change: 'created', type: 'table', name: 'logs' }],
			},
		});
		await sqliteQuery(DB, 'CREATE TABLE logs(at)', { enableEditing: true });
		const out = logged();
		expect(out).toContain('Created table logs.');
		expect(out).not.toContain('Changed 0 rows');
	});

	it('--enable-editing says RETURNING rows past the window are not read again', async () => {
		respondQuery({
			statement: 'INSERT',
			hasMore: true,
			write: { changes: 9, otherChanges: 0, schemaChanges: [] },
		});
		await sqliteQuery(DB, "INSERT INTO users(email) SELECT 'x' FROM users RETURNING id, email", {
			enableEditing: true,
			limit: '2',
		});
		const out = logged();
		expect(out).toContain('Changed 9 rows.');
		expect(out).toContain('it returned more, not shown');
		expect(out).not.toContain('--offset 2');
	});

	it('--enable-editing still refuses transaction control and --output, before asking the app', async () => {
		const sent = respondQuery();
		await expect(sqliteQuery(DB, 'BEGIN', { enableEditing: true })).rejects.toThrow('__exit__');
		expect(errorSpy.mock.calls.join('\n')).toContain('BEGIN is refused here');
		await expect(
			sqliteQuery(DB, 'SELECT 1', { enableEditing: true, output: '/tmp/out.csv' })
		).rejects.toThrow('__exit__');
		expect(errorSpy.mock.calls.join('\n')).toContain('it does not take --enable-editing');
		expect(sent).toHaveLength(0);
	});

	it('never sends the unlock without --enable-editing', async () => {
		const sent = respondQuery();
		await sqliteQuery(DB, 'SELECT 1', {});
		expect(sent[0]).not.toHaveProperty('enableEditing');
		expect(sent[0]).not.toHaveProperty('dryRun');
	});

	it('--dry-run asks for a dry run and prints what it would change and any rows it would return', async () => {
		const sent = respondQuery({
			statement: 'DELETE',
			columns: [{ name: 'id', declaredType: 'INTEGER' }],
			rows: [[{ kind: 'integer', text: '4' }]],
			hasMore: false,
			returnsRows: true,
			dryRun: {
				kind: 'data',
				verb: 'DELETE',
				target: 'users',
				tried: true,
				untriedReason: null,
				changes: 1,
				otherChanges: 2,
				schemaChanges: [],
			},
		});
		await sqliteQuery(DB, 'DELETE FROM users WHERE id = 4 RETURNING id', {
			enableEditing: true,
			dryRun: true,
		});
		expect(sent[0]).toMatchObject({ type: 'sqlite_run_query', enableEditing: true, dryRun: true });
		const out = logged();
		expect(out).toContain(`Dry run of DELETE on ${DB}`);
		expect(out).toContain(
			'DELETE on users (changes rows) would change 1 row; its triggers and foreign-key actions would change 2 other rows. Tried in a transaction and rolled back: nothing was changed.'
		);
		expect(out).toContain('It would return:');
		expect(out).not.toContain('Changed');
		expect(out).not.toContain(SQLITE_QUERY_WRITE_UNDO_MESSAGE);
	});

	it('--dry-run needs --enable-editing and refuses --plan, --output, and --offset, before asking the app', async () => {
		const sent = respondQuery();
		const cases: Array<[Record<string, unknown>, string]> = [
			[{ dryRun: true }, 'it needs --enable-editing'],
			[{ dryRun: true, enableEditing: true, plan: true }, 'it does not take --plan'],
			[{ dryRun: true, enableEditing: true, output: '/tmp/out.csv' }, 'it does not take --output'],
			[{ dryRun: true, enableEditing: true, offset: '5' }, 'it does not take --offset'],
		];
		for (const [options, message] of cases) {
			await expect(sqliteQuery(DB, 'DELETE FROM users', options)).rejects.toThrow('__exit__');
			expect(errorSpy.mock.calls.join('\n')).toContain(message);
		}
		expect(sent).toHaveLength(0);
	});

	it('points a syntax error at the token SQLite stopped at, with a caret under it', async () => {
		const sql = 'SELECT id\n  FROM users\n WHERE id IN (1, 2,)';
		mockReply({
			type: 'sqlite_query_result',
			success: false,
			error: 'near ")": syntax error',
			errorOffset: sql.lastIndexOf(')'),
		});
		await expect(sqliteQuery(DB, sql, {})).rejects.toThrow('__exit__');
		expect(String(errorSpy.mock.calls[0][0]).split('\n')).toEqual([
			'Error: near ")": syntax error',
			'Line 3, column 20:',
			'   WHERE id IN (1, 2,)',
			'                     ^',
		]);
		expect(process.exit).toHaveBeenCalledWith(1);
	});

	it('names the place in JSON, and finds a missing column by its name', async () => {
		mockReply({
			type: 'sqlite_query_result',
			success: false,
			error: 'no such column: u.emial',
		});
		await expect(sqliteQuery(DB, 'SELECT u.emial FROM users u', { json: true })).rejects.toThrow(
			'__exit__'
		);
		expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toEqual({
			success: false,
			error: 'no such column: u.emial',
			location: { from: 7, to: 14, line: 1, column: 8 },
		});
	});

	it('prints an error that names no place as it is', async () => {
		mockReply({
			type: 'sqlite_query_result',
			success: false,
			error: 'integer overflow',
		});
		await expect(sqliteQuery(DB, 'SELECT abs(-9223372036854775808)', {})).rejects.toThrow(
			'__exit__'
		);
		expect(errorSpy.mock.calls.map((call) => call.join(' '))).toEqual(['Error: integer overflow']);
	});

	const PLAN_RESULT = {
		statement: 'SELECT',
		plan: true,
		columns: ['id', 'parent', 'notused', 'detail'].map((name) => ({ name, declaredType: null })),
		rows: [
			[4, 0, 0, 'SCAN u'],
			[6, 0, 0, 'SEARCH t USING INTEGER PRIMARY KEY (rowid=?)'],
			[18, 0, 0, 'USE TEMP B-TREE FOR ORDER BY'],
		],
		offset: 0,
		hasMore: false,
		returnsRows: true,
		elapsedMs: 1,
	};

	it('sends --plan with the whole plan asked for, ignoring --offset and --limit', async () => {
		const sent = respondQuery(PLAN_RESULT);
		await sqliteQuery(DB, 'SELECT * FROM t JOIN u ON u.x = t.a ORDER BY y', {
			plan: true,
			offset: '7',
			limit: '5000',
		});
		expect(sent[0]).toMatchObject({ type: 'sqlite_run_query', plan: true, offset: 0, limit: 1000 });
	});

	it('prints a plan as the sqlite3 shell tree, with a line on each costly kind of step', async () => {
		respondQuery(PLAN_RESULT);
		await sqliteQuery(DB, 'SELECT * FROM t JOIN u ON u.x = t.a ORDER BY y', { plan: true });
		const out = logged();
		expect(out).toContain(`Plan of SELECT on ${DB}`);
		expect(out).toContain(
			[
				'QUERY PLAN',
				'|--SCAN u',
				'|--SEARCH t USING INTEGER PRIMARY KEY (rowid=?)',
				'`--USE TEMP B-TREE FOR ORDER BY',
			].join('\n')
		);
		expect(out).toContain(SQLITE_QUERY_PLAN_KIND_HINTS.scan);
		expect(out).toContain(SQLITE_QUERY_PLAN_KIND_HINTS.sort);
		expect(out).not.toContain(SQLITE_QUERY_PLAN_KIND_HINTS.search);
	});

	it('prints a plan as JSON with its steps under --json', async () => {
		respondQuery(PLAN_RESULT);
		await sqliteQuery(DB, 'SELECT 1', { plan: true, json: true });
		const printed = JSON.parse(String(logSpy.mock.calls[0][0]));
		expect(printed).toMatchObject({ success: true, path: DB, plan: true, rows: PLAN_RESULT.rows });
		expect(printed.steps.map((step: { prefix: string; detail: string }) => step.prefix)).toEqual([
			'|--',
			'|--',
			'`--',
		]);
		expect(printed.steps[0]).toMatchObject({ id: 4, parent: 0, kind: 'scan', depth: 0 });
	});

	it('says when a plan has no steps', async () => {
		respondQuery({ ...PLAN_RESULT, statement: 'PRAGMA', rows: [] });
		await sqliteQuery(DB, 'PRAGMA user_version', { plan: true });
		expect(logged()).toContain('SQLite reports no steps for this statement');
	});

	it('refuses a blank statement or a limit past the cap before asking the app', async () => {
		const sent = respondQuery();
		await expect(sqliteQuery(DB, '  ', {})).rejects.toThrow('__exit__');
		await expect(sqliteQuery(DB, 'SELECT 1', { limit: '5000' })).rejects.toThrow('__exit__');
		expect(errorSpy.mock.calls.join('\n')).toContain('--limit must be at most 1000');
		expect(sent).toHaveLength(0);
	});
});

describe('sqliteQueryParamsFromFlags', () => {
	it('matches a name with or without its sigil, and splits only at the first =', () => {
		expect(
			sqliteQueryParamsFromFlags('SELECT ?, ?, :name', {
				param: ['?1=x', '2=y=z'],
				paramNumber: ['name=1.5'],
			})
		).toEqual({
			'?1': { type: 'text', text: 'x' },
			'?2': { type: 'text', text: 'y=z' },
			':name': { type: 'number', text: '1.5' },
		});
		expect(sqliteQueryParamsFromFlags('SELECT ?', { param: ['?1='] })).toEqual({
			'?1': { type: 'text', text: '' },
		});
	});

	it('refuses a name the statement lacks, listing the ones it has', () => {
		expect(() => sqliteQueryParamsFromFlags('SELECT :a, ?', { param: ['b=1'] })).toThrow(
			'--param b: the statement has no such parameter (it has: :a, ?1)'
		);
		expect(() => sqliteQueryParamsFromFlags('SELECT 1', { paramNull: ['x'] })).toThrow(
			'(it has: none)'
		);
	});

	it('refuses a pair with no name, and a parameter given twice', () => {
		expect(() => sqliteQueryParamsFromFlags('SELECT :a', { param: ['=1'] })).toThrow(
			'--param takes name=value (got "=1")'
		);
		expect(() => sqliteQueryParamsFromFlags('SELECT :a', { param: ['nothing'] })).toThrow(
			'takes name=value'
		);
		expect(() =>
			sqliteQueryParamsFromFlags('SELECT :a', { param: ['a=1'], paramNull: [':a'] })
		).toThrow(':a is given more than once');
	});
});

describe('sqlite query --output', () => {
	let logSpy: MockInstance;
	let errorSpy: MockInstance;
	const OUT = path.resolve('/tmp/result.jsonl');
	const EXPORTED = {
		path: OUT,
		format: 'jsonl',
		rows: 1204,
		columns: 2,
		bytes: 52_000,
		elapsedMs: 31,
	};

	function respondExport(overrides: Record<string, unknown> = {}) {
		return mockReply({
			type: 'sqlite_export_result',
			success: true,
			database: { handle: 'h1', displayPath: DB, fileBytes: 4096 },
			exported: EXPORTED,
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

	it('asks the app to write every row to the resolved path, format from its name', async () => {
		const sent = respondExport();
		await sqliteQuery(DB, 'SELECT * FROM users WHERE id > :min', {
			paramNumber: ['min=10'],
			output: '/tmp/result.jsonl',
			limit: '5000',
		});
		expect(sent[0]).toEqual({
			type: 'sqlite_export_query',
			path: DB,
			sql: 'SELECT * FROM users WHERE id > :min',
			params: { ':min': { type: 'number', text: '10' } },
			destPath: OUT,
			format: 'jsonl',
			responseType: 'sqlite_export_result',
		});
		expect(logSpy.mock.calls.join('\n')).toContain(
			`Exported 1204 rows (2 columns) to ${OUT} as JSON Lines`
		);
	});

	it('takes --format over the name', async () => {
		const sent = respondExport();
		await sqliteQuery(DB, 'SELECT 1', { output: '/tmp/result.jsonl', format: 'csv' });
		expect(sent[0]).toMatchObject({ format: 'csv' });
	});

	it('prints what was written under --json', async () => {
		respondExport();
		await sqliteQuery(DB, 'SELECT 1', { output: '/tmp/result.jsonl', json: true });
		expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toEqual({
			success: true,
			path: DB,
			output: OUT,
			format: 'jsonl',
			rows: 1204,
			columns: 2,
			bytes: 52_000,
			elapsedMs: 31,
		});
	});

	it('refuses --plan, a bad --format, --format alone, and a write before asking the app', async () => {
		const sent = respondExport();
		await expect(sqliteQuery(DB, 'SELECT 1', { output: '/tmp/x.csv', plan: true })).rejects.toThrow(
			'__exit__'
		);
		await expect(
			sqliteQuery(DB, 'SELECT 1', { output: '/tmp/x.csv', format: 'xml' })
		).rejects.toThrow('__exit__');
		await expect(sqliteQuery(DB, 'SELECT 1', { format: 'csv' })).rejects.toThrow('__exit__');
		await expect(sqliteQuery(DB, 'DELETE FROM users', { output: '/tmp/x.csv' })).rejects.toThrow(
			'__exit__'
		);
		const errors = errorSpy.mock.calls.join('\n');
		expect(errors).toContain('does not take --plan');
		expect(errors).toContain('--format must be csv or jsonl');
		expect(errors).toContain('--format needs --output');
		expect(errors).toContain('DELETE is not a read-only statement');
		expect(sent).toHaveLength(0);
	});

	it("exits 1 with the app's error", async () => {
		mockReply({ type: 'sqlite_export_result', success: false, error: 'no such column: nope' });
		await expect(sqliteQuery(DB, 'SELECT nope', { output: '/tmp/x.csv' })).rejects.toThrow(
			'__exit__'
		);
		expect(errorSpy.mock.calls.join('\n')).toContain('no such column: nope');
	});
});

describe('sqlite history', () => {
	let logSpy: MockInstance;
	let errorSpy: MockInstance;
	const logged = () => logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
	const ENTRIES = [
		{
			id: 'abcd1234-0000-4000-8000-000000000001',
			sql: 'SELECT *\nFROM users WHERE id = :id',
			plan: false,
			params: { ':id': { type: 'number', text: '7' } },
			ranAt: Date.now() - 60_000,
			runs: 3,
			outcome: { ok: true, rows: 500, hasMore: true, returnsRows: true, elapsedMs: 4 },
		},
		{
			id: 'ef567890-0000-4000-8000-000000000002',
			sql: 'SELECT nope',
			plan: true,
			params: {},
			ranAt: Date.now() - 120_000,
			runs: 1,
			outcome: { ok: false, error: 'no such column: nope' },
		},
	];

	function respondHistory(entries: unknown[] = ENTRIES, removed?: number) {
		return mockReply({
			type: 'sqlite_history_result',
			success: true,
			database: { handle: 'h1', displayPath: DB, fileBytes: 4096 },
			history: { path: DB, entries },
			...(removed !== undefined ? { removed } : {}),
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

	it('lists the statements newest first, with ids, outcomes, values, and errors', async () => {
		const sent = respondHistory();
		await sqliteHistory(DB, {});
		expect(sent[0]).toEqual({
			type: 'sqlite_query_history',
			path: DB,
			responseType: 'sqlite_history_result',
		});
		const out = logged();
		expect(out).toContain(`Query history of ${DB}: 2 statements, newest first.`);
		expect(out).toMatch(/abcd1234 {2}.* {2}500\+ rows {2}ran 3 times/);
		expect(out).toContain('    SELECT *\n    FROM users WHERE id = :id');
		expect(out).toContain('    :id = "7" (number)');
		expect(out).toMatch(/ef567890 {2}.* {2}failed {2}plan/);
		expect(out).toContain('    no such column: nope');
	});

	it('says when nothing has run', async () => {
		respondHistory([]);
		await sqliteHistory(DB, {});
		expect(logged()).toContain(`No queries have run against ${DB}.`);
	});

	it('forgets one entry by id, and clears the history', async () => {
		let sent = respondHistory(ENTRIES.slice(1), 1);
		await sqliteHistory(DB, { forget: ' abcd1234 ' });
		expect(sent[0]).toMatchObject({ forget: 'abcd1234' });
		expect(logged()).toContain('Forgot 1 statement.');

		sent = respondHistory([], 2);
		await sqliteHistory(DB, { clear: true, json: true });
		expect(sent[0]).toMatchObject({ clear: true });
		expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]))).toEqual({
			success: true,
			path: DB,
			removed: 2,
			entries: [],
		});
	});

	it('refuses --forget with --clear, and an empty --forget, before asking the app', async () => {
		const sent = respondHistory();
		await expect(sqliteHistory(DB, { forget: 'abcd', clear: true })).rejects.toThrow('__exit__');
		await expect(sqliteHistory(DB, { forget: '  ' })).rejects.toThrow('__exit__');
		expect(sent).toHaveLength(0);
	});

	it("exits 1 with the app's error", async () => {
		mockReply({ type: 'sqlite_history_result', success: false, error: 'No history entry zz' });
		await expect(sqliteHistory(DB, { forget: 'zz' })).rejects.toThrow('__exit__');
		expect(errorSpy.mock.calls.join('\n')).toContain('No history entry zz');
	});
});

describe('sqlite log', () => {
	let logSpy: MockInstance;
	let errorSpy: MockInstance;
	const logged = () => logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
	const ok = (changes: number, otherChanges = 0) => ({
		ok: true,
		changes,
		otherChanges,
		schemaChanges: [],
	});
	const ENTRIES = [
		{
			id: 'r1',
			kind: 'rollback',
			sql: 'ROLLBACK',
			params: {},
			table: null,
			transactionId: 'tx000001-0000',
			at: Date.now() - 10_000,
			outcome: ok(2),
			note: 'Rolled back. Nothing it held was kept (1 statement: 2 rows changed).',
		},
		{
			id: 'q1',
			kind: 'query',
			sql: 'DELETE FROM logs WHERE id > :id',
			params: { ':id': { type: 'number', text: '3' } },
			table: null,
			transactionId: 'tx000001-0000',
			at: Date.now() - 20_000,
			outcome: ok(2),
		},
		{
			id: 'c1',
			kind: 'cell',
			sql: "UPDATE users SET email = 'a@b.c' WHERE rowid = 7",
			params: {},
			table: 'users',
			transactionId: null,
			at: Date.now() - 60_000,
			outcome: ok(1, 2),
			backupPath: '/data/app.maestro-backup-1.db',
		},
		{
			id: 'f1',
			kind: 'insert',
			sql: 'INSERT INTO users (id) VALUES (1)',
			params: {},
			table: 'users',
			transactionId: null,
			at: Date.now() - 120_000,
			outcome: { ok: false, error: 'UNIQUE constraint failed: users.id' },
		},
	];

	function respondLog(entries: unknown[] = ENTRIES, removed?: number) {
		return mockReply({
			type: 'sqlite_log_result',
			success: true,
			database: { handle: 'h1', displayPath: DB, fileBytes: 4096 },
			log: { path: DB, entries },
			...(removed !== undefined ? { removed } : {}),
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

	it('lists every write newest first: what it did, where it stands, its statement', async () => {
		const sent = respondLog();
		await sqliteLog(DB, {});
		expect(sent[0]).toEqual({
			type: 'sqlite_statement_log',
			path: DB,
			responseType: 'sqlite_log_result',
		});
		const out = logged();
		expect(out).toContain(`Statement log of ${DB}: 4 writes, newest first.`);
		expect(out).toMatch(/ {2}rollback {2}rolled back {2}transaction tx000001/);
		expect(out).toContain('    Rolled back. Nothing it held was kept');
		// A write inside the rolled-back transaction is in the log, not the file.
		expect(out).toMatch(/query {2}changed 2 rows {2}\(rolled back, not in the file\)/);
		expect(out).toContain('    :id = "3" (number)');
		expect(out).toMatch(/cell edit {2}changed 1 row \(\+2 by triggers\)/);
		expect(out).toContain("    UPDATE users SET email = 'a@b.c' WHERE rowid = 7");
		expect(out).toContain('    Backed the file up first to /data/app.maestro-backup-1.db');
		expect(out).toMatch(/insert {2}failed/);
		expect(out).toContain('    UNIQUE constraint failed: users.id');
	});

	it('shows the newest --limit writes, and says there are more', async () => {
		respondLog();
		await sqliteLog(DB, { limit: '1' });
		const out = logged();
		expect(out).toContain('4 writes, newest first (the newest 1; --limit shows more).');
		expect(out).not.toContain('UPDATE users');
	});

	it('says when nothing is logged, and clears the log', async () => {
		respondLog([]);
		await sqliteLog(DB, {});
		expect(logged()).toContain(`No writes to ${DB} are logged.`);

		const sent = respondLog([], 4);
		await sqliteLog(DB, { clear: true, json: true });
		expect(sent[0]).toMatchObject({ clear: true });
		expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]))).toEqual({
			success: true,
			path: DB,
			removed: 4,
			total: 0,
			entries: [],
		});
	});

	it('prints the entries whole as JSON, cut to --limit', async () => {
		respondLog();
		await sqliteLog(DB, { json: true, limit: '2' });
		expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]))).toEqual({
			success: true,
			path: DB,
			total: 4,
			entries: ENTRIES.slice(0, 2),
		});
	});

	it('refuses a bad --limit before asking the app, and exits 1 on the app error', async () => {
		const sent = respondLog();
		await expect(sqliteLog(DB, { limit: 'many' })).rejects.toThrow('__exit__');
		expect(sent).toHaveLength(0);

		mockReply({ type: 'sqlite_log_result', success: false, error: 'not open' });
		await expect(sqliteLog(DB, {})).rejects.toThrow('__exit__');
		expect(errorSpy.mock.calls.join('\n')).toContain('not open');
	});
});

describe('sqliteRowKeyFromFlags', () => {
	it('names a row by rowid', () => {
		expect(sqliteRowKeyFromFlags({ rowid: '-12' })).toEqual({ kind: 'rowid', rowid: '-12' });
	});

	it('names a row by its primary key, TEXT or numbers per flag', () => {
		expect(
			sqliteRowKeyFromFlags({
				key: ['name=o=brien', 'note='],
				keyNumber: ['org=3', 'score=1.5', 'big=9007199254740993'],
			})
		).toEqual({
			kind: 'primary-key',
			values: {
				name: { type: 'text', text: 'o=brien' },
				note: { type: 'text', text: '' },
				org: { type: 'integer', text: '3' },
				score: { type: 'real', text: '1.5' },
				big: { type: 'integer', text: '9007199254740993' },
			},
		});
	});

	it.each([
		[{}, 'Name the row with --rowid <id>, or with --key column=value'],
		[{ rowid: '1', key: ['a=1'] }, 'Name the row with --rowid <id>, or with --key column=value'],
		[{ rowid: '1 OR 1=1' }, '--rowid must be a whole number'],
		[{ key: ['=1'] }, '--key takes column=value'],
		[{ key: ['a'] }, '--key takes column=value'],
		[{ key: ['a=1'], keyNumber: ['a=1'] }, 'Key column a is given more than once'],
		[{ keyNumber: ['a=one'] }, '--key-number a: "one" is not a number'],
	])('refuses %o', (options, message) => {
		expect(() => sqliteRowKeyFromFlags(options)).toThrow(message);
	});
});

describe('sqliteCellValueFromFlags', () => {
	it('takes exactly one value flag', () => {
		expect(sqliteCellValueFromFlags({ value: '' })).toEqual({ type: 'text', text: '' });
		expect(sqliteCellValueFromFlags({ valueNumber: '42' })).toEqual({ type: 'number', text: '42' });
		expect(sqliteCellValueFromFlags({ null: true })).toEqual({ type: 'null', text: '' });
		expect(() => sqliteCellValueFromFlags({})).toThrow(
			'Give the new value with exactly one of --value, --value-number, or --null'
		);
		expect(() => sqliteCellValueFromFlags({ value: 'a', null: true })).toThrow('exactly one');
	});
});

describe('sqlite set', () => {
	let logSpy: MockInstance;
	let errorSpy: MockInstance;
	const logged = () => logSpy.mock.calls.map((call) => call.join(' ')).join('\n');

	function respondSet(
		result: Record<string, unknown> = {},
		overrides: Record<string, unknown> = {}
	) {
		return mockReply({
			type: 'sqlite_update_result',
			success: true,
			database: { handle: 'h1', displayPath: DB, fileBytes: 4096 },
			result: {
				name: 'users',
				column: 'email',
				columns: [
					{ name: 'id', declaredType: 'INTEGER' },
					{ name: 'email', declaredType: 'TEXT' },
				],
				row: [7, 'a@b.c'],
				key: { kind: 'rowid', rowid: '7' },
				version: 'AfterAfterAfterAfter_1',
				elapsedMs: 2,
				...result,
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

	it('sends the row, the value, and the per-call unlock, and says what changed', async () => {
		const sent = respondSet();
		await sqliteSet(DB, 'users', 'email', { rowid: '7', value: 'a@b.c', enableEditing: true });
		expect(sent[0]).toEqual({
			type: 'sqlite_update_cell',
			path: DB,
			name: 'users',
			column: 'email',
			row: { kind: 'rowid', rowid: '7' },
			value: { type: 'text', text: 'a@b.c' },
			enableEditing: true,
			responseType: 'sqlite_update_result',
		});
		expect(logged()).toBe('Set email of users (rowid 7) to a@b.c.');
	});

	it('says where the backup went on the first change, and names a key row by its key', async () => {
		respondSet({
			key: {
				kind: 'primary-key',
				values: { org: { type: 'integer', text: '3' }, name: { type: 'text', text: 'ada' } },
			},
			backup: { path: '/data/app.maestro-backup-x.db', bytes: 2048, createdAt: 1 },
		});
		await sqliteSet(DB, 'users', 'email', {
			key: ['name=ada'],
			keyNumber: ['org=3'],
			value: 'a@b.c',
			enableEditing: true,
		});
		expect(logged()).toBe(
			[
				'Set email of users (org = 3, name = ada) to a@b.c.',
				`Backed up ${DB} before this first change: /data/app.maestro-backup-x.db (2.0 KB).`,
			].join('\n')
		);
	});

	it('prints the row and its key as JSON under --json', async () => {
		respondSet();
		await sqliteSet(DB, 'users', 'email', {
			rowid: '7',
			null: true,
			enableEditing: true,
			json: true,
		});
		expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toEqual({
			success: true,
			path: DB,
			name: 'users',
			column: 'email',
			columns: ['id', 'email'],
			row: [7, 'a@b.c'],
			key: { kind: 'rowid', rowid: '7' },
			version: 'AfterAfterAfterAfter_1',
			backup: null,
			elapsedMs: 2,
		});
	});

	it('sends --if-version for the edit to check, and only when given', async () => {
		const sent = respondSet();
		await sqliteSet(DB, 'users', 'email', {
			rowid: '7',
			value: 'a@b.c',
			ifVersion: 'SeenSeenSeenSeenSeen-2',
			enableEditing: true,
		});
		expect(sent[0]).toMatchObject({
			type: 'sqlite_update_cell',
			version: 'SeenSeenSeenSeenSeen-2',
		});
	});

	it.each([
		[{ rowid: '7', value: 'x' }, 'Pass --enable-editing to unlock editing for this one call'],
		[{ value: 'x', enableEditing: true }, 'Name the row with --rowid <id>'],
		[{ rowid: '7', enableEditing: true }, 'exactly one of --value, --value-number, or --null'],
	])('refuses %o before asking the app', async (options, message) => {
		const sent = respondSet();
		await expect(sqliteSet(DB, 'users', 'email', options)).rejects.toThrow('__exit__');
		expect(errorSpy.mock.calls.join('\n')).toContain(message);
		expect(sent).toEqual([]);
	});

	it("exits 1 with SQLite's refusal", async () => {
		mockReply({
			type: 'sqlite_update_result',
			success: false,
			error: 'NOT NULL constraint failed: users.email',
		});
		await expect(
			sqliteSet(DB, 'users', 'email', { rowid: '7', null: true, enableEditing: true })
		).rejects.toThrow('__exit__');
		expect(errorSpy.mock.calls.join('\n')).toContain('NOT NULL constraint failed: users.email');
		expect(process.exit).toHaveBeenCalledWith(1);
	});
});

describe('sqliteInsertValuesFromFlags', () => {
	it('keys each value by its column, typed by its flag, split at the first =', () => {
		expect(
			sqliteInsertValuesFromFlags({
				value: ['email=a=b@c', 'note='],
				valueNumber: ['age=42'],
				null: ['nick'],
			})
		).toEqual({
			email: { type: 'text', text: 'a=b@c' },
			note: { type: 'text', text: '' },
			age: { type: 'number', text: '42' },
			nick: { type: 'null', text: '' },
		});
		expect(sqliteInsertValuesFromFlags({})).toEqual({});
	});

	it.each([
		[{ value: ['email'] }, '--value takes column=value (got "email")'],
		[{ valueNumber: ['=4'] }, '--value-number takes column=value (got "=4")'],
		[{ value: ['a=1'], null: ['a'] }, 'Column a is given more than once'],
		[{ null: [''] }, '--null takes a column name'],
	])('refuses %o', (options, message) => {
		expect(() => sqliteInsertValuesFromFlags(options)).toThrow(message);
	});
});

describe('sqlite insert and delete', () => {
	let logSpy: MockInstance;
	let errorSpy: MockInstance;
	const logged = () => logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
	const database = { handle: 'h1', displayPath: DB, fileBytes: 4096 };

	beforeEach(() => {
		vi.clearAllMocks();
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
	});

	it('sends the values and the per-call unlock, and prints the row as stored', async () => {
		const sent = mockReply({
			type: 'sqlite_insert_result',
			success: true,
			database,
			result: {
				name: 'users',
				columns: [
					{ name: 'id', declaredType: 'INTEGER' },
					{ name: 'email', declaredType: 'TEXT' },
				],
				row: [8, 'a@b.c'],
				key: { kind: 'rowid', rowid: '8' },
				otherChanges: 1,
				backup: { path: '/data/app.maestro-backup-x.db', bytes: 2048, createdAt: 1 },
				elapsedMs: 2,
			},
		});
		await sqliteInsert(DB, 'users', { value: ['email=a@b.c'], enableEditing: true });
		expect(sent[0]).toEqual({
			type: 'sqlite_insert_row',
			path: DB,
			name: 'users',
			values: { email: { type: 'text', text: 'a@b.c' } },
			enableEditing: true,
			responseType: 'sqlite_insert_result',
		});
		const text = logged();
		expect(text).toContain('Inserted a row into users (rowid 8):');
		expect(text).toContain('a@b.c');
		expect(text).toContain("The database's triggers and foreign-key actions changed 1 other row.");
		expect(text).toContain(
			`Backed up ${DB} before this first change: /data/app.maestro-backup-x.db (2.0 KB).`
		);
	});

	it('prints the inserted row as JSON under --json', async () => {
		mockReply({
			type: 'sqlite_insert_result',
			success: true,
			database,
			result: {
				name: 'users',
				columns: [{ name: 'id', declaredType: 'INTEGER' }],
				row: [9],
				key: { kind: 'rowid', rowid: '9' },
				version: 'AfterAfterAfterAfter_1',
				otherChanges: 0,
				elapsedMs: 1,
			},
		});
		await sqliteInsert(DB, 'users', { enableEditing: true, json: true });
		expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toEqual({
			success: true,
			path: DB,
			name: 'users',
			columns: ['id'],
			row: [9],
			key: { kind: 'rowid', rowid: '9' },
			version: 'AfterAfterAfterAfter_1',
			otherChanges: 0,
			backup: null,
			elapsedMs: 1,
		});
	});

	it("exits 1 with SQLite's constraint failure", async () => {
		mockReply({
			type: 'sqlite_insert_result',
			success: false,
			error: 'UNIQUE constraint failed: users.email',
		});
		await expect(
			sqliteInsert(DB, 'users', { value: ['email=a@b.c'], enableEditing: true })
		).rejects.toThrow('__exit__');
		expect(errorSpy.mock.calls.join('\n')).toContain('UNIQUE constraint failed: users.email');
		expect(process.exit).toHaveBeenCalledWith(1);
	});

	it.each([
		[{ value: ['a=1'] }, 'Pass --enable-editing to unlock editing for this one call'],
		[{ value: ['a'], enableEditing: true }, '--value takes column=value'],
	])('refuses insert %o before asking the app', async (options, message) => {
		const sent = mockReply({ type: 'sqlite_insert_result', success: true });
		await expect(sqliteInsert(DB, 'users', options)).rejects.toThrow('__exit__');
		expect(errorSpy.mock.calls.join('\n')).toContain(message);
		expect(sent).toEqual([]);
	});

	it('sends the row key and the per-call unlock, and says what went with it', async () => {
		const sent = mockReply({
			type: 'sqlite_delete_result',
			success: true,
			database,
			result: {
				name: 'users',
				key: { kind: 'rowid', rowid: '7' },
				otherChanges: 3,
				elapsedMs: 1,
			},
		});
		await sqliteDelete(DB, 'users', { rowid: '7', enableEditing: true });
		expect(sent[0]).toEqual({
			type: 'sqlite_delete_row',
			path: DB,
			name: 'users',
			row: { kind: 'rowid', rowid: '7' },
			enableEditing: true,
			responseType: 'sqlite_delete_result',
		});
		expect(logged()).toBe(
			[
				'Deleted the row with rowid 7 from users.',
				"The database's triggers and foreign-key actions changed 3 other rows.",
			].join('\n')
		);
	});

	it('sends --if-version for the delete to check', async () => {
		const sent = mockReply({
			type: 'sqlite_delete_result',
			success: true,
			database,
			result: { name: 'users', key: { kind: 'rowid', rowid: '7' }, otherChanges: 0, elapsedMs: 1 },
		});
		await sqliteDelete(DB, 'users', {
			rowid: '7',
			ifVersion: 'SeenSeenSeenSeenSeen-2',
			enableEditing: true,
		});
		expect(sent[0]).toMatchObject({ type: 'sqlite_delete_row', version: 'SeenSeenSeenSeenSeen-2' });
	});

	it('prints the deleted key as JSON under --json', async () => {
		mockReply({
			type: 'sqlite_delete_result',
			success: true,
			database,
			result: {
				name: 'members',
				key: { kind: 'primary-key', values: { org: { type: 'integer', text: '3' } } },
				otherChanges: 0,
				elapsedMs: 1,
			},
		});
		await sqliteDelete(DB, 'members', { keyNumber: ['org=3'], enableEditing: true, json: true });
		expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toEqual({
			success: true,
			path: DB,
			name: 'members',
			key: { kind: 'primary-key', values: { org: { type: 'integer', text: '3' } } },
			otherChanges: 0,
			backup: null,
			elapsedMs: 1,
		});
	});

	it.each([
		[{ rowid: '7' }, 'Pass --enable-editing to unlock editing for this one call'],
		[{ enableEditing: true }, 'Name the row with --rowid <id>'],
		[{ rowid: 'x', enableEditing: true }, '--rowid must be a whole number'],
	])('refuses delete %o before asking the app', async (options, message) => {
		const sent = mockReply({ type: 'sqlite_delete_result', success: true });
		await expect(sqliteDelete(DB, 'users', options)).rejects.toThrow('__exit__');
		expect(errorSpy.mock.calls.join('\n')).toContain(message);
		expect(sent).toEqual([]);
	});

	it("exits 1 with SQLite's FOREIGN KEY refusal", async () => {
		mockReply({
			type: 'sqlite_delete_result',
			success: false,
			error: 'FOREIGN KEY constraint failed',
		});
		await expect(sqliteDelete(DB, 'users', { rowid: '7', enableEditing: true })).rejects.toThrow(
			'__exit__'
		);
		expect(errorSpy.mock.calls.join('\n')).toContain('FOREIGN KEY constraint failed');
	});
});

describe('sqlite undo', () => {
	let logSpy: MockInstance;
	let errorSpy: MockInstance;
	const logged = () => logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
	const database = { handle: 'h1', displayPath: DB, fileBytes: 4096 };
	const step = {
		kind: 'restore-cell',
		name: 'users',
		column: 'email',
		row: { kind: 'rowid', rowid: '7' },
		version: 'AfterAfterAfterAfter_1',
		value: { type: 'text', text: 'old@example.com' },
	};

	beforeEach(() => {
		vi.clearAllMocks();
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
	});

	it('sends the step and the per-call unlock, and says what it undid', async () => {
		const sent = mockReply({
			type: 'sqlite_undo_result',
			success: true,
			database,
			result: {
				name: 'users',
				kind: 'restore-cell',
				key: { kind: 'rowid', rowid: '7' },
				otherChanges: 0,
				elapsedMs: 2,
			},
		});
		await sqliteUndo(DB, { step: JSON.stringify(step), enableEditing: true });
		expect(sent[0]).toEqual({
			type: 'sqlite_undo_edit',
			path: DB,
			step,
			enableEditing: true,
			responseType: 'sqlite_undo_result',
		});
		expect(logged()).toBe('Undid the edit of email in users (2 ms): rowid 7.');
	});

	it('prints the result as JSON under --json', async () => {
		mockReply({
			type: 'sqlite_undo_result',
			success: true,
			database,
			result: {
				name: 'users',
				kind: 'remove-row',
				key: { kind: 'rowid', rowid: '12' },
				otherChanges: 0,
				elapsedMs: 1,
			},
		});
		await sqliteUndo(DB, { step: JSON.stringify(step), enableEditing: true, json: true });
		expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toEqual({
			success: true,
			path: DB,
			name: 'users',
			kind: 'remove-row',
			key: { kind: 'rowid', rowid: '12' },
			otherChanges: 0,
			backup: null,
			elapsedMs: 1,
		});
	});

	it.each([
		[{ step: JSON.stringify(step) }, 'Pass --enable-editing to unlock editing for this one call'],
		[{ enableEditing: true }, 'Give the undo step with --step'],
		[{ step: '{nope', enableEditing: true }, '--step is not JSON'],
		[{ step: '[1]', enableEditing: true }, '--step must be a JSON object'],
	])('refuses undo %o before asking the app', async (options, message) => {
		const sent = mockReply({ type: 'sqlite_undo_result', success: true });
		await expect(sqliteUndo(DB, options)).rejects.toThrow('__exit__');
		expect(errorSpy.mock.calls.join('\n')).toContain(message);
		expect(sent).toEqual([]);
	});

	it('exits 1 with the reason the app refused the undo', async () => {
		mockReply({
			type: 'sqlite_undo_result',
			success: false,
			error: 'The row of users with rowid 7 changed since it was read',
		});
		await expect(
			sqliteUndo(DB, { step: JSON.stringify(step), enableEditing: true })
		).rejects.toThrow('__exit__');
		expect(errorSpy.mock.calls.join('\n')).toContain('changed since it was read');
	});

	it('reads the step from @file', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-undo-'));
		try {
			const file = path.join(dir, 'step.json');
			fs.writeFileSync(file, JSON.stringify(step));
			expect(sqliteUndoStepFromFlag(`@${file}`)).toEqual(step);
			expect(() => sqliteUndoStepFromFlag(`@${path.join(dir, 'missing.json')}`)).toThrow(
				'Could not read the undo step from'
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('prints the undo step after a write, or why there is none', async () => {
		mockReply({
			type: 'sqlite_delete_result',
			success: true,
			database,
			result: {
				name: 'users',
				key: { kind: 'rowid', rowid: '7' },
				otherChanges: 0,
				undo: { kind: 'restore-row', name: 'users', rowid: '7', values: {} },
				elapsedMs: 1,
			},
		});
		await sqliteDelete(DB, 'users', { rowid: '7', enableEditing: true });
		expect(logged()).toContain(
			'Undo step (give it to sqlite undo --step): {"kind":"restore-row","name":"users","rowid":"7","values":{}}'
		);

		logSpy.mockClear();
		mockReply({
			type: 'sqlite_delete_result',
			success: true,
			database,
			result: {
				name: 'users',
				key: { kind: 'rowid', rowid: '7' },
				otherChanges: 2,
				undo: null,
				elapsedMs: 1,
			},
		});
		await sqliteDelete(DB, 'users', { rowid: '7', enableEditing: true, json: true });
		expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toMatchObject({ undo: null });

		logSpy.mockClear();
		await sqliteDelete(DB, 'users', { rowid: '7', enableEditing: true });
		expect(logged()).toContain('The last change cannot be undone here');
	});
});

describe('sqlite transaction', () => {
	let logSpy: MockInstance;
	let errorSpy: MockInstance;
	const logged = () => logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
	const database = { handle: 'h1', displayPath: DB, fileBytes: 4096 };
	const state = (overrides: Record<string, unknown> = {}) => ({
		transactionId: 'x1',
		startedAt: 1,
		expiresAt: 2,
		statements: 0,
		changes: 0,
		otherChanges: 0,
		schemaChanges: [],
		...overrides,
	});
	const update = {
		statement: 'UPDATE',
		columns: [],
		rows: [],
		offset: 0,
		hasMore: false,
		returnsRows: false,
		elapsedMs: 1,
		inTransaction: {
			writes: true,
			changes: 3,
			otherChanges: 1,
			transaction: state({ statements: 1, changes: 3, otherChanges: 1 }),
		},
	};
	const select = {
		statement: 'SELECT',
		columns: [{ name: 'age', declaredType: 'INTEGER' }],
		rows: [[41], [42]],
		offset: 0,
		hasMore: false,
		returnsRows: true,
		elapsedMs: 1,
		inTransaction: {
			writes: false,
			changes: 0,
			otherChanges: 0,
			transaction: state({ statements: 2, changes: 3, otherChanges: 1 }),
		},
	};
	const statements = ['UPDATE users SET age = age + 1', 'SELECT age FROM users'];

	beforeEach(() => {
		vi.clearAllMocks();
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
	});

	it('sends the statements, the end, and the per-call unlock, and prints each outcome', async () => {
		const sent = mockReply({
			type: 'sqlite_transaction_result',
			success: true,
			database,
			result: {
				begun: state({
					backup: { path: '/data/app.maestro-backup-1.db', bytes: 4096, createdAt: 1 },
				}),
				steps: [update, select],
				failed: null,
				end: {
					transactionId: 'x1',
					outcome: 'committed',
					reason: 'Committed 2 statements: 3 rows changed. These changes are now in the file.',
					transaction: state({ statements: 2, changes: 3 }),
					endedAt: 3,
				},
			},
		});
		await sqliteTransaction(DB, statements, { commit: true, enableEditing: true });
		expect(sent[0]).toEqual({
			type: 'sqlite_run_transaction',
			path: DB,
			statements,
			end: 'commit',
			limit: 50,
			enableEditing: true,
			responseType: 'sqlite_transaction_result',
		});
		const out = logged();
		expect(out).toContain(`Transaction on ${DB}`);
		expect(out).toContain(
			'1. UPDATE changed 3 rows, and 1 other row by triggers and foreign-key actions. Held so far: 1 statement: 3 rows changed, and 1 other row by triggers and foreign-key actions.'
		);
		expect(out).toContain('2. SELECT returned 2 rows.');
		expect(out).toContain(
			'Committed 2 statements: 3 rows changed. These changes are now in the file.'
		);
		expect(out).toContain('Backed up');
	});

	it('exits 1 naming the statement that failed, pointed at its token', async () => {
		mockReply({
			type: 'sqlite_transaction_result',
			success: true,
			database,
			result: {
				begun: state(),
				steps: [update],
				failed: { index: 1, error: 'no such table: userz' },
				end: {
					transactionId: 'x1',
					outcome: 'rolled-back',
					reason: 'Rolled back. Nothing it held was kept (1 statement: 3 rows changed).',
					transaction: state({ statements: 1, changes: 3 }),
					endedAt: 3,
				},
			},
		});
		await expect(
			sqliteTransaction(DB, ['UPDATE users SET age = age + 1', 'SELECT age FROM userz'], {
				commit: true,
				enableEditing: true,
			})
		).rejects.toThrow('__exit__');
		const out = errorSpy.mock.calls.join('\n');
		expect(out).toContain('Statement 2 failed: no such table: userz');
		expect(out).toContain('Line 1, column 17:');
		expect(out).toContain('Rolled back. Nothing it held was kept');
	});

	it('prints the whole result as JSON under --json, success false when anything failed', async () => {
		const result = {
			begun: state(),
			steps: [],
			failed: { index: null, error: 'FOREIGN KEY constraint failed' },
			end: {
				transactionId: 'x1',
				outcome: 'rolled-back',
				reason: 'Rolled back.',
				transaction: state(),
				endedAt: 3,
			},
		};
		mockReply({ type: 'sqlite_transaction_result', success: true, database, result });
		await expect(
			sqliteTransaction(DB, statements, { commit: true, enableEditing: true, json: true })
		).rejects.toThrow('__exit__');
		expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toEqual({
			success: false,
			path: DB,
			...result,
		});
	});

	it.each([
		[{ commit: true }, statements, 'Pass --enable-editing to unlock editing for this one call'],
		[{ enableEditing: true }, statements, 'Say how the transaction ends'],
		[
			{ enableEditing: true, commit: true, rollback: true },
			statements,
			'Say how the transaction ends',
		],
		[{ enableEditing: true, rollback: true }, ['UPDATE t SET a = 1', ' '], 'Give each statement'],
		[{ enableEditing: true, rollback: true }, ['BEGIN'], 'BEGIN is refused here'],
		[
			{ enableEditing: true, rollback: true },
			['ATTACH ? AS other'],
			'ATTACH opens or closes another database file',
		],
		[
			{ enableEditing: true, rollback: true, limit: '5000' },
			statements,
			'--limit must be at most 1000',
		],
	])('refuses %o before asking the app', async (options, given, message) => {
		const sent = mockReply({ type: 'sqlite_transaction_result', success: true });
		await expect(sqliteTransaction(DB, given, options)).rejects.toThrow('__exit__');
		expect(errorSpy.mock.calls.join('\n')).toContain(message);
		expect(sent).toEqual([]);
	});
});
