import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// better-sqlite3's native binary is built for Electron's ABI and does not load
// under vitest, so the connection is a fake that answers the few statements
// sqlite-objects.ts prepares. Each test describes the database it wants.
interface FakeSchema {
	master: Array<{ type: string; name: string; tbl_name: string; sql: string | null }>;
	tableList?: Array<{ schema: string; name: string; type: string; wr: number; strict: number }>;
	/** Make `PRAGMA table_list` fail, as on an older SQLite. */
	tableListFails?: boolean;
	/** Rows per table; a name mapped to an Error makes its count throw. */
	rows: Record<string, number | Error>;
	/** Bytes per b-tree; a name mapped to an Error makes its size read throw. */
	bytes: Record<string, number | Error>;
	/** No dbstat table in this build. */
	noDbstat?: boolean;
}

const state = vi.hoisted(() => ({
	schema: null as FakeSchema | null,
	fileBytes: 1024,
	prepared: [] as string[],
}));

function fakeDb() {
	const schema = state.schema!;
	return {
		prepare(sql: string) {
			state.prepared.push(sql);
			if (sql.startsWith('SELECT type, name, tbl_name, sql FROM sqlite_master')) {
				return { all: () => schema.master };
			}
			if (sql === 'PRAGMA main.table_list') {
				return {
					all: () => {
						if (schema.tableListFails) throw new Error('near "table_list": syntax error');
						return schema.tableList ?? [];
					},
				};
			}
			if (sql === 'SELECT 1 FROM dbstat LIMIT 0') {
				return {
					all: () => {
						if (schema.noDbstat) throw new Error('no such table: dbstat');
						return [];
					},
				};
			}
			const count =
				/^SELECT COUNT\(\*\) AS n FROM \(SELECT 1 FROM "((?:[^"]|"")*)" LIMIT \?\)$/.exec(sql);
			if (count) {
				const name = count[1].replace(/""/g, '"');
				return {
					get: (limit: number) => {
						const rows = schema.rows[name];
						if (rows instanceof Error) throw rows;
						return { n: Math.min(rows ?? 0, limit) };
					},
				};
			}
			if (sql.startsWith('SELECT SUM(pgsize) AS bytes FROM dbstat')) {
				return {
					get: (name: string) => {
						const bytes = schema.bytes[name];
						if (bytes instanceof Error) throw bytes;
						return { bytes: bytes ?? null };
					},
				};
			}
			throw new Error(`Unexpected SQL in test: ${sql}`);
		},
	};
}

vi.mock('../../../main/sqlite/sqlite-database', () => ({
	getSqliteDatabase: (handle: string) => {
		if (handle !== 'h1') throw new Error('SQLite database handle is no longer open.');
		return {
			db: fakeDb(),
			info: { handle, displayPath: '/data/app.db', fileBytes: state.fileBytes },
		};
	},
}));

import {
	findSqliteObject,
	SQLITE_ROW_COUNT_CAP,
	SQLITE_SIZE_SCAN_MAX_BYTES,
	listSqliteObjects,
	readAllSqliteObjectStats,
	readSqliteObjectStats,
} from '../../../main/sqlite/sqlite-objects';

const APP_SCHEMA: FakeSchema = {
	master: [
		{
			type: 'table',
			name: 'users',
			tbl_name: 'users',
			sql: 'CREATE TABLE users(id INTEGER PRIMARY KEY, email TEXT)',
		},
		{
			type: 'index',
			name: 'users_email',
			tbl_name: 'users',
			sql: 'CREATE INDEX users_email ON users(email)',
		},
		{ type: 'index', name: 'sqlite_autoindex_kv_1', tbl_name: 'kv', sql: null },
		{
			type: 'table',
			name: 'kv',
			tbl_name: 'kv',
			sql: 'CREATE TABLE kv(k TEXT PRIMARY KEY, v) WITHOUT ROWID',
		},
		{
			type: 'view',
			name: 'active_users',
			tbl_name: 'active_users',
			sql: 'CREATE VIEW active_users AS SELECT 1',
		},
		{
			type: 'trigger',
			name: 'users_audit',
			tbl_name: 'users',
			sql: 'CREATE TRIGGER users_audit ...',
		},
		{
			type: 'table',
			name: 'docs',
			tbl_name: 'docs',
			sql: 'CREATE VIRTUAL TABLE docs USING fts5(body)',
		},
		{
			type: 'table',
			name: 'docs_data',
			tbl_name: 'docs_data',
			sql: 'CREATE TABLE docs_data(id, block)',
		},
		{
			type: 'table',
			name: 'sqlite_sequence',
			tbl_name: 'sqlite_sequence',
			sql: 'CREATE TABLE sqlite_sequence(name,seq)',
		},
	],
	tableList: [
		{ schema: 'main', name: 'users', type: 'table', wr: 0, strict: 1 },
		{ schema: 'main', name: 'kv', type: 'table', wr: 1, strict: 0 },
		{ schema: 'main', name: 'active_users', type: 'view', wr: 0, strict: 0 },
		{ schema: 'main', name: 'docs', type: 'virtual', wr: 0, strict: 0 },
		{ schema: 'main', name: 'docs_data', type: 'shadow', wr: 0, strict: 0 },
		{ schema: 'main', name: 'sqlite_sequence', type: 'table', wr: 0, strict: 0 },
	],
	rows: { users: 42, kv: 3, docs: 7, docs_data: 2, sqlite_sequence: 1 },
	bytes: {
		users: 8192,
		users_email: 4096,
		sqlite_autoindex_kv_1: 4096,
		kv: 4096,
		docs_data: 4096,
		sqlite_sequence: 4096,
	},
};

function byName(list: ReturnType<typeof listSqliteObjects>, name: string) {
	const found = list.objects.find((entry) => entry.name === name);
	if (!found) throw new Error(`missing ${name}`);
	return found;
}

describe('listSqliteObjects', () => {
	beforeEach(() => {
		state.schema = structuredClone(APP_SCHEMA);
		state.fileBytes = 1024;
		state.prepared = [];
	});

	it('lists tables, views, indexes, and triggers with their owning table', () => {
		const list = listSqliteObjects('h1');
		expect(list.objects.map((entry) => entry.name).sort()).toEqual(
			APP_SCHEMA.master.map((row) => row.name).sort()
		);
		expect(byName(list, 'users_email')).toMatchObject({ kind: 'index', tableName: 'users' });
		expect(byName(list, 'users_audit')).toMatchObject({
			kind: 'trigger',
			tableName: 'users',
			countable: false,
			hasStorage: false,
		});
		expect(byName(list, 'active_users')).toMatchObject({
			kind: 'view',
			countable: false,
			hasStorage: false,
		});
	});

	it('reads table flavours from PRAGMA table_list', () => {
		const list = listSqliteObjects('h1');
		expect(byName(list, 'users')).toMatchObject({
			tableType: 'table',
			strict: true,
			withoutRowid: false,
		});
		expect(byName(list, 'kv')).toMatchObject({ withoutRowid: true });
		// A virtual table is counted through its module but owns no b-tree.
		expect(byName(list, 'docs')).toMatchObject({
			tableType: 'virtual',
			countable: true,
			hasStorage: false,
			internal: false,
		});
	});

	it('marks objects SQLite or a module made as internal', () => {
		const list = listSqliteObjects('h1');
		expect(byName(list, 'sqlite_sequence').internal).toBe(true);
		expect(byName(list, 'sqlite_autoindex_kv_1').internal).toBe(true);
		expect(byName(list, 'docs_data')).toMatchObject({ internal: true, tableType: 'shadow' });
		expect(byName(list, 'users').internal).toBe(false);
	});

	it('falls back to the CREATE text when PRAGMA table_list fails', () => {
		state.schema!.tableListFails = true;
		const list = listSqliteObjects('h1');
		expect(byName(list, 'docs')).toMatchObject({ tableType: 'virtual', hasStorage: false });
		expect(byName(list, 'kv')).toMatchObject({ withoutRowid: true });
		expect(byName(list, 'users')).toMatchObject({ tableType: 'table', withoutRowid: false });
	});

	it('reports sizes available when dbstat exists and the file is small enough', () => {
		expect(listSqliteObjects('h1')).toMatchObject({ sizesAvailable: true });
	});

	it('says why sizes are unavailable without dbstat', () => {
		state.schema!.noDbstat = true;
		const list = listSqliteObjects('h1');
		expect(list.sizesAvailable).toBe(false);
		expect(list.sizeNote).toMatch(/dbstat/);
	});

	it('does not size a database too large to walk', () => {
		state.fileBytes = SQLITE_SIZE_SCAN_MAX_BYTES + 1;
		const list = listSqliteObjects('h1');
		expect(list.sizesAvailable).toBe(false);
		expect(list.sizeNote).toMatch(/too large|this large/);
	});

	it('fails loudly on a handle that is no longer open', () => {
		expect(() => listSqliteObjects('gone')).toThrow(/no longer open/);
	});
});

describe('readSqliteObjectStats', () => {
	beforeEach(() => {
		state.schema = structuredClone(APP_SCHEMA);
		state.fileBytes = 1024;
		state.prepared = [];
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('counts rows and sizes b-trees', () => {
		const [users, index, view, virtualTable] = readSqliteObjectStats(
			'h1',
			['users', 'users_email', 'active_users', 'docs'],
			Number.POSITIVE_INFINITY
		);
		expect(users).toEqual({ name: 'users', rowCount: 42, rowCountCapped: false, sizeBytes: 8192 });
		expect(index).toEqual({
			name: 'users_email',
			rowCount: null,
			rowCountCapped: false,
			sizeBytes: 4096,
		});
		expect(view).toEqual({
			name: 'active_users',
			rowCount: null,
			rowCountCapped: false,
			sizeBytes: null,
		});
		expect(virtualTable).toEqual({
			name: 'docs',
			rowCount: 7,
			rowCountCapped: false,
			sizeBytes: null,
		});
	});

	it('stops counting at the cap and reports a lower bound', () => {
		state.schema!.rows.users = SQLITE_ROW_COUNT_CAP * 5;
		const [users] = readSqliteObjectStats('h1', ['users']);
		expect(users).toMatchObject({ rowCount: SQLITE_ROW_COUNT_CAP, rowCountCapped: true });
	});

	it('reports an exact count that lands on the cap as exact', () => {
		state.schema!.rows.users = SQLITE_ROW_COUNT_CAP;
		const [users] = readSqliteObjectStats('h1', ['users']);
		expect(users).toMatchObject({ rowCount: SQLITE_ROW_COUNT_CAP, rowCountCapped: false });
	});

	it('quotes the table name it counts', () => {
		state.schema!.master.push({
			type: 'table',
			name: 'odd "name"',
			tbl_name: 'odd "name"',
			sql: 'CREATE TABLE "odd ""name"""(a)',
		});
		state.schema!.rows['odd "name"'] = 5;
		const [odd] = readSqliteObjectStats('h1', ['odd "name"']);
		expect(odd.rowCount).toBe(5);
		expect(state.prepared).toContain(
			'SELECT COUNT(*) AS n FROM (SELECT 1 FROM "odd ""name""" LIMIT ?)'
		);
	});

	it('reports a failure on the object instead of failing the batch', () => {
		state.schema!.rows.docs = new Error('no such module: fts5');
		const [docs, users] = readSqliteObjectStats('h1', ['docs', 'users'], Number.POSITIVE_INFINITY);
		expect(docs).toMatchObject({ rowCount: null, error: 'no such module: fts5' });
		expect(users).toMatchObject({ rowCount: 42 });
	});

	it('says another process has the database open when a count finds it busy', () => {
		state.schema!.rows.docs = Object.assign(new Error('database is locked'), {
			code: 'SQLITE_BUSY',
		});
		const [docs] = readSqliteObjectStats('h1', ['docs'], Number.POSITIVE_INFINITY);
		expect(docs.error).toMatch(/^Another process has this database open .* could not be read/);
	});

	it('answers a name that is not in the schema with an error, never running SQL on it', () => {
		const [missing] = readSqliteObjectStats('h1', ['nope']);
		expect(missing).toMatchObject({ name: 'nope', rowCount: null, sizeBytes: null });
		expect(missing.error).toMatch(/nope/);
		expect(state.prepared.some((sql) => sql.includes('"nope"'))).toBe(false);
	});

	it('skips sizes when they are unavailable', () => {
		state.schema!.noDbstat = true;
		const [users] = readSqliteObjectStats('h1', ['users']);
		expect(users).toMatchObject({ rowCount: 42, sizeBytes: null });
		expect(users.error).toBeUndefined();
	});

	it('returns a prefix once the budget runs out, but always at least one', () => {
		let now = 0;
		vi.spyOn(Date, 'now').mockImplementation(() => {
			now += 100;
			return now;
		});
		const batch = readSqliteObjectStats('h1', ['users', 'kv', 'docs'], 50);
		expect(batch.map((entry) => entry.name)).toEqual(['users']);
	});
});

describe('readAllSqliteObjectStats', () => {
	beforeEach(() => {
		state.schema = structuredClone(APP_SCHEMA);
		state.fileBytes = 1024;
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('keeps asking until every name has an answer, in order', async () => {
		let now = 0;
		vi.spyOn(Date, 'now').mockImplementation(() => {
			now += 100;
			return now;
		});
		const all = await readAllSqliteObjectStats('h1', ['users', 'kv', 'docs']);
		expect(all.map((entry) => entry.name)).toEqual(['users', 'kv', 'docs']);
		expect(all.map((entry) => entry.rowCount)).toEqual([42, 3, 7]);
	});
});

describe('findSqliteObject', () => {
	const objects = [
		{ name: 'audit', kind: 'trigger' },
		{ name: 'audit', kind: 'table' },
		{ name: 'users', kind: 'table' },
	].map((entry) => ({
		...entry,
		tableName: entry.name,
		internal: false,
		countable: entry.kind === 'table',
		hasStorage: entry.kind === 'table',
	})) as Parameters<typeof findSqliteObject>[0];

	it('picks the object of the asked kind when a trigger shares a table name', () => {
		expect(findSqliteObject(objects, 'audit', 'trigger')?.kind).toBe('trigger');
		expect(findSqliteObject(objects, 'audit', 'table')?.kind).toBe('table');
	});

	it('falls back to rail order without a kind', () => {
		expect(findSqliteObject(objects, 'audit')?.kind).toBe('table');
	});

	it('answers undefined for an unknown name or a kind the name does not have', () => {
		expect(findSqliteObject(objects, 'nope')).toBeUndefined();
		expect(findSqliteObject(objects, 'users', 'view')).toBeUndefined();
	});
});
