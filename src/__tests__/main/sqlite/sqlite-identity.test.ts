import { beforeEach, describe, expect, it, vi } from 'vitest';

// better-sqlite3's native binary is built for Electron's ABI and does not load
// under vitest, so the connection is a fake that answers the statements
// sqlite-identity.ts prepares: the table's xinfo columns, its index list, and
// a virtual table's CREATE text. The object list (for a shadow table's owner)
// comes from a mocked readSqliteObjectSummaries.
interface FakeTable {
	xinfo: Array<{ name: string; notnull?: number; pk?: number; hidden?: number }> | Error;
	/** Index origins from pragma_index_list: 'c', 'u', or 'pk'. */
	indexOrigins?: string[];
	sql?: string;
}

const state = vi.hoisted(() => ({
	tables: {} as Record<string, FakeTable>,
	objects: [] as unknown[],
	prepared: [] as string[],
}));

function fakeDb() {
	return {
		prepare(sql: string) {
			state.prepared.push(sql);
			if (sql === 'SELECT name, "notnull", pk, hidden FROM pragma_table_xinfo(?, ?) ORDER BY cid') {
				return {
					all: (name: string, schema: string) => {
						expect(schema).toBe('main');
						const { xinfo } = state.tables[name];
						if (xinfo instanceof Error) throw xinfo;
						return xinfo.map((column) => ({ notnull: 0, pk: 0, hidden: 0, ...column }));
					},
				};
			}
			if (sql === 'SELECT origin FROM pragma_index_list(?, ?)') {
				return {
					all: (name: string) =>
						(state.tables[name].indexOrigins ?? []).map((origin) => ({ origin })),
				};
			}
			if (sql === "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?") {
				return {
					get: (name: string) => {
						const table = state.tables[name];
						return table?.sql !== undefined ? { sql: table.sql } : undefined;
					},
				};
			}
			throw new Error(`Unexpected SQL in test: ${sql}`);
		},
	};
}

vi.mock('../../../main/sqlite/sqlite-objects', () => ({
	readSqliteObjectSummaries: () => state.objects,
}));

import type Database from 'better-sqlite3';

import {
	reachableRowidAlias,
	resolveSqliteEditability,
} from '../../../main/sqlite/sqlite-identity';
import type { SqliteObjectSummary } from '../../../shared/sqlite/types';

function table(name: string, extra: Partial<SqliteObjectSummary> = {}): SqliteObjectSummary {
	return {
		name,
		kind: 'table',
		tableName: name,
		internal: false,
		countable: true,
		hasStorage: true,
		tableType: 'table',
		withoutRowid: false,
		strict: false,
		...extra,
	};
}

function resolve(object: SqliteObjectSummary) {
	return resolveSqliteEditability(fakeDb() as unknown as Database.Database, object);
}

beforeEach(() => {
	state.prepared = [];
	state.objects = [];
	state.tables = {};
});

describe('reachableRowidAlias', () => {
	it('prefers rowid, then _rowid_, then oid, case-insensitively', () => {
		expect(reachableRowidAlias(table('t'), [{ name: 'a' }])).toBe('rowid');
		expect(reachableRowidAlias(table('t'), [{ name: 'ROWID' }])).toBe('_rowid_');
		expect(reachableRowidAlias(table('t'), [{ name: 'rowid' }, { name: '_rowid_' }])).toBe('oid');
		expect(
			reachableRowidAlias(table('t'), [{ name: 'rowid' }, { name: '_rowid_' }, { name: 'Oid' }])
		).toBeNull();
	});

	it('has none for a view, a virtual table, or a WITHOUT ROWID table', () => {
		expect(reachableRowidAlias({ ...table('v'), kind: 'view' }, [])).toBeNull();
		expect(reachableRowidAlias(table('f', { tableType: 'virtual' }), [])).toBeNull();
		expect(reachableRowidAlias(table('w', { withoutRowid: true }), [])).toBeNull();
	});
});

describe('resolveSqliteEditability', () => {
	it('names a row by rowid, and marks the INTEGER PRIMARY KEY that is the rowid', () => {
		state.tables.users = { xinfo: [{ name: 'id', pk: 1 }, { name: 'email' }] };
		expect(resolve(table('users'))).toEqual({
			editable: true,
			identity: { kind: 'rowid', alias: 'rowid', rowidColumn: 'id' },
			readOnlyColumns: [],
		});
	});

	it('has no rowid column when the primary key has its own index', () => {
		state.tables.tags = { xinfo: [{ name: 'tag', pk: 1 }], indexOrigins: ['pk'] };
		expect(resolve(table('tags'))).toMatchObject({
			identity: { kind: 'rowid', alias: 'rowid', rowidColumn: null },
		});
		state.tables.pairs = {
			xinfo: [
				{ name: 'a', pk: 1 },
				{ name: 'b', pk: 2 },
			],
		};
		expect(resolve(table('pairs'))).toMatchObject({
			identity: { kind: 'rowid', rowidColumn: null },
		});
	});

	it('uses the first rowid name a real column does not take', () => {
		state.tables.log = { xinfo: [{ name: 'rowid' }, { name: 'msg' }] };
		expect(resolve(table('log'))).toMatchObject({
			identity: { kind: 'rowid', alias: '_rowid_' },
		});
	});

	it('falls back to the primary key when columns hide every rowid name', () => {
		state.tables.odd = {
			xinfo: [
				{ name: 'rowid' },
				{ name: '_rowid_' },
				{ name: 'oid' },
				{ name: 'b', pk: 2, notnull: 1 },
				{ name: 'a', pk: 1 },
			],
			indexOrigins: ['pk'],
		};
		expect(resolve(table('odd'))).toEqual({
			editable: true,
			identity: { kind: 'primary-key', columns: ['a', 'b'], keyMayBeNull: true },
			readOnlyColumns: [],
		});
	});

	it('says a rowid table key cannot hold NULL when every key column is NOT NULL', () => {
		state.tables.odd = {
			xinfo: [
				{ name: 'rowid' },
				{ name: '_rowid_' },
				{ name: 'oid' },
				{ name: 'code', pk: 1, notnull: 1 },
			],
			indexOrigins: ['pk'],
		};
		expect(resolve(table('odd'))).toMatchObject({
			identity: { kind: 'primary-key', columns: ['code'], keyMayBeNull: false },
		});
	});

	it('knows an INTEGER PRIMARY KEY behind hidden rowid names is never NULL', () => {
		state.tables.odd = {
			xinfo: [{ name: 'rowid' }, { name: '_rowid_' }, { name: 'oid' }, { name: 'id', pk: 1 }],
		};
		expect(resolve(table('odd'))).toMatchObject({
			identity: { kind: 'primary-key', columns: ['id'], keyMayBeNull: false },
		});
	});

	it('names a WITHOUT ROWID row by its primary key, in key order', () => {
		state.tables.kv = {
			xinfo: [{ name: 'v' }, { name: 'ns', pk: 2 }, { name: 'k', pk: 1 }],
			indexOrigins: ['pk'],
		};
		expect(resolve(table('kv', { withoutRowid: true }))).toEqual({
			editable: true,
			identity: { kind: 'primary-key', columns: ['k', 'ns'], keyMayBeNull: false },
			readOnlyColumns: [],
		});
	});

	it('is read-only, with the reason, when no row can be named', () => {
		state.tables.odd = { xinfo: [{ name: 'rowid' }, { name: '_rowid_' }, { name: 'oid' }] };
		const result = resolve(table('odd'));
		expect(result).toMatchObject({ editable: false, code: 'no-identity' });
		expect(result.editable === false && result.reason).toContain('no primary key');
	});

	it('keeps generated columns out of an edit, but not their rows', () => {
		state.tables.people = {
			xinfo: [{ name: 'first' }, { name: 'full', hidden: 3 }, { name: 'len', hidden: 2 }],
		};
		const result = resolve(table('people'));
		expect(result.editable).toBe(true);
		expect(result.editable && result.readOnlyColumns.map((column) => column.name)).toEqual([
			'full',
			'len',
		]);
		expect(result.editable && result.readOnlyColumns[0].reason).toContain('generated column');
	});

	it('refuses a view without reading its columns', () => {
		const result = resolve({ ...table('active'), kind: 'view', tableType: undefined });
		expect(result).toMatchObject({ editable: false, code: 'view' });
		expect(result.editable === false && result.reason).toContain('active is a view');
		expect(state.prepared).toEqual([]);
	});

	it('refuses a virtual table and names its module', () => {
		state.tables.docs = { xinfo: [], sql: 'CREATE VIRTUAL TABLE docs USING fts5(body)' };
		const result = resolve(table('docs', { tableType: 'virtual', hasStorage: false }));
		expect(result).toMatchObject({ editable: false, code: 'virtual-table' });
		expect(result.editable === false && result.reason).toContain('(module fts5)');
	});

	it('refuses a shadow table and names the virtual table that owns it', () => {
		state.objects = [
			table('docs', { tableType: 'virtual' }),
			table('docs_x', { tableType: 'virtual' }),
			table('docs_x_data', { tableType: 'shadow', internal: true }),
		];
		const result = resolve(table('docs_x_data', { tableType: 'shadow', internal: true }));
		expect(result).toMatchObject({ editable: false, code: 'shadow-table' });
		expect(result.editable === false && result.reason).toContain('the virtual table docs_x.');
	});

	it("refuses SQLite's own tables", () => {
		const result = resolve(table('sqlite_sequence', { internal: true }));
		expect(result).toMatchObject({ editable: false, code: 'internal-table' });
		expect(state.prepared).toEqual([]);
	});

	it("turns a column read failure into the reason, with SQLite's words", () => {
		state.tables.gone = { xinfo: new Error('no such module: vec0') };
		const result = resolve(table('gone'));
		expect(result).toMatchObject({ editable: false, code: 'unreadable' });
		expect(result.editable === false && result.reason).toContain('no such module: vec0');
	});

	it('binds every name instead of splicing it into SQL', () => {
		state.tables['a"b'] = { xinfo: [{ name: 'x' }] };
		resolve(table('a"b'));
		expect(state.prepared.some((sql) => sql.includes('a"b'))).toBe(false);
	});
});
