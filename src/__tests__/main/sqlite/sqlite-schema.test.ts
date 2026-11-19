import { beforeEach, describe, expect, it, vi } from 'vitest';

// better-sqlite3's native binary is built for Electron's ABI and does not load
// under vitest, so the connection is a fake that answers the statements
// sqlite-schema.ts prepares. The object list itself comes from a mocked
// readSqliteObjectSummaries, so this file tests only the schema reader.
interface FakeDb {
	sql: Record<string, string | null>;
	xinfo: Record<string, unknown[] | Error>;
	foreignKeys: Record<string, unknown[]>;
	indexXinfo: Record<string, unknown[]>;
	indexList: Record<string, unknown[]>;
}

const state = vi.hoisted(() => ({
	db: null as FakeDb | null,
	objects: [] as Array<Record<string, unknown>>,
	prepared: [] as string[],
}));

function fakeDb() {
	const db = state.db!;
	return {
		prepare(sql: string) {
			state.prepared.push(sql);
			if (sql === 'SELECT sql FROM sqlite_master WHERE name = ? AND type = ?') {
				return {
					get: (name: string) => (name in db.sql ? { sql: db.sql[name] } : undefined),
				};
			}
			if (sql.startsWith('SELECT * FROM pragma_table_xinfo(?, ?)')) {
				return {
					all: (name: string, schema: string) => {
						expect(schema).toBe('main');
						const rows = db.xinfo[name];
						if (rows instanceof Error) throw rows;
						return rows ?? [];
					},
				};
			}
			if (sql.startsWith('SELECT * FROM pragma_foreign_key_list(?, ?)')) {
				return { all: (name: string) => db.foreignKeys[name] ?? [] };
			}
			if (sql.startsWith('SELECT * FROM pragma_index_xinfo(?, ?)')) {
				return { all: (name: string) => db.indexXinfo[name] ?? [] };
			}
			if (sql.startsWith('SELECT * FROM pragma_index_list(?, ?)')) {
				return { all: (name: string) => db.indexList[name] ?? [] };
			}
			throw new Error(`Unexpected SQL in test: ${sql}`);
		},
	};
}

vi.mock('../../../main/sqlite/sqlite-database', () => ({
	getSqliteDatabase: (handle: string) => {
		if (handle !== 'h1') throw new Error('SQLite database handle is no longer open.');
		return { db: fakeDb(), info: { handle, displayPath: '/data/app.db', fileBytes: 1024 } };
	},
}));

vi.mock('../../../main/sqlite/sqlite-objects', () => ({
	readSqliteObjectSummaries: () => state.objects,
}));

import { readSqliteObjectSchema } from '../../../main/sqlite/sqlite-schema';

function xinfo(
	cid: number,
	name: string,
	type: string,
	extra: Partial<{ notnull: number; dflt_value: string | null; pk: number; hidden: number }> = {}
) {
	return { cid, name, type, notnull: 0, dflt_value: null, pk: 0, hidden: 0, ...extra };
}

function fk(
	id: number,
	seq: number,
	table: string,
	from: string,
	to: string | null,
	actions: Partial<{ on_update: string; on_delete: string }> = {}
) {
	return {
		id,
		seq,
		table,
		from,
		to,
		on_update: 'NO ACTION',
		on_delete: 'NO ACTION',
		match: 'NONE',
		...actions,
	};
}

beforeEach(() => {
	state.prepared = [];
	state.objects = [
		{ name: 'users', kind: 'table', tableName: 'users', tableType: 'table' },
		{ name: 'orders', kind: 'table', tableName: 'orders', tableType: 'table' },
		{ name: 'kv', kind: 'table', tableName: 'kv', tableType: 'table', strict: true },
		{ name: 'orders_note', kind: 'index', tableName: 'orders' },
		{ name: 'sqlite_autoindex_users_1', kind: 'index', tableName: 'users', internal: true },
		{ name: 'v1', kind: 'view', tableName: 'v1' },
		{ name: 'broken', kind: 'view', tableName: 'broken' },
		{ name: 'audit', kind: 'trigger', tableName: 'users' },
		{ name: 'orders', kind: 'trigger', tableName: 'orders' },
	];
	state.db = {
		sql: {
			users: 'CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE)',
			orders: 'CREATE TABLE orders (...)',
			kv: 'CREATE TABLE kv (k TEXT, v ANY) STRICT',
			orders_note: 'CREATE INDEX orders_note ON orders(note DESC, lower(note))',
			sqlite_autoindex_users_1: null,
			v1: 'CREATE VIEW v1 AS SELECT id FROM users',
			broken: 'CREATE VIEW broken AS SELECT a FROM gone',
			audit: 'CREATE TRIGGER audit AFTER INSERT ON users BEGIN SELECT 1; END',
		},
		xinfo: {
			users: [
				xinfo(0, 'id', 'INTEGER', { pk: 1 }),
				xinfo(1, 'email', 'TEXT', { notnull: 1 }),
				xinfo(2, 'name', 'VARCHAR(80)', { dflt_value: "'anon'" }),
				xinfo(3, 'bio', ''),
				xinfo(4, 'full', 'TEXT', { hidden: 3 }),
				xinfo(5, 'twice', 'INT', { hidden: 2 }),
			],
			orders: [
				xinfo(0, 'id', 'INTEGER', { pk: 1, notnull: 1 }),
				xinfo(1, 'uid', 'INTEGER'),
				xinfo(2, 'A', 'INT', { pk: 2 }),
				xinfo(3, 'b', 'INT'),
			],
			kv: [xinfo(0, 'k', 'TEXT'), xinfo(1, 'v', 'ANY')],
			v1: [xinfo(0, 'id', 'INTEGER')],
			broken: new Error('no such table: main.gone'),
		},
		foreignKeys: {
			// SQLite numbers keys from the LAST declared: id 1 was declared first.
			orders: [
				fk(0, 0, 'pairs', 'a', 'x', { on_update: 'SET NULL' }),
				fk(0, 1, 'pairs', 'b', 'y', { on_update: 'SET NULL' }),
				fk(1, 0, 'users', 'uid', null, { on_delete: 'CASCADE' }),
			],
		},
		indexXinfo: {
			orders_note: [
				{ seqno: 0, cid: 4, name: 'note', desc: 1, coll: 'BINARY', key: 1 },
				{ seqno: 1, cid: -2, name: null, desc: 0, coll: 'NOCASE', key: 1 },
				{ seqno: 2, cid: 0, name: 'id', desc: 0, coll: 'BINARY', key: 0 },
			],
			sqlite_autoindex_users_1: [
				{ seqno: 0, cid: 1, name: 'email', desc: 0, coll: 'BINARY', key: 1 },
				{ seqno: 1, cid: -1, name: null, desc: 0, coll: 'BINARY', key: 0 },
			],
		},
		indexList: {
			orders: [{ seq: 0, name: 'orders_note', unique: 0, origin: 'c', partial: 1 }],
			users: [{ seq: 0, name: 'sqlite_autoindex_users_1', unique: 1, origin: 'u', partial: 0 }],
		},
	};
});

describe('readSqliteObjectSchema', () => {
	it('reads a table: declared type, affinity, nullability, default, PK, generated', () => {
		const schema = readSqliteObjectSchema('h1', 'users');
		expect(schema).toMatchObject({
			name: 'users',
			kind: 'table',
			tableName: 'users',
			sql: 'CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE)',
			foreignKeys: [],
		});
		expect(schema.error).toBeUndefined();
		expect(schema.columns).toEqual([
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
				name: 'email',
				declaredType: 'TEXT',
				affinity: 'TEXT',
				notNull: true,
				defaultValue: null,
				primaryKeyPosition: 0,
				references: [],
			},
			expect.objectContaining({ name: 'name', affinity: 'TEXT', defaultValue: "'anon'" }),
			expect.objectContaining({ name: 'bio', declaredType: '', affinity: 'BLOB' }),
			expect.objectContaining({ name: 'full', generated: 'stored' }),
			expect.objectContaining({ name: 'twice', generated: 'virtual', affinity: 'INTEGER' }),
		]);
	});

	it('binds the name to the pragma functions rather than splicing it into SQL', () => {
		readSqliteObjectSchema('h1', 'users');
		expect(state.prepared.some((sql) => sql.includes('users'))).toBe(false);
	});

	it('groups composite foreign keys, in declaration order, onto their columns', () => {
		const schema = readSqliteObjectSchema('h1', 'orders', 'table');
		expect(schema.foreignKeys).toEqual([
			{ table: 'users', from: ['uid'], to: [null], onUpdate: 'NO ACTION', onDelete: 'CASCADE' },
			{
				table: 'pairs',
				from: ['a', 'b'],
				to: ['x', 'y'],
				onUpdate: 'SET NULL',
				onDelete: 'NO ACTION',
			},
		]);
		const byName = Object.fromEntries(schema.columns.map((column) => [column.name, column]));
		expect(byName.uid.references).toEqual([{ table: 'users', column: null }]);
		// The FOREIGN KEY clause said `a`; the column is defined as `A`.
		expect(byName.A.references).toEqual([{ table: 'pairs', column: 'x' }]);
		expect(byName.A.primaryKeyPosition).toBe(2);
		expect(byName.b.references).toEqual([{ table: 'pairs', column: 'y' }]);
		expect(byName.id.references).toEqual([]);
	});

	it('derives STRICT affinity for ANY', () => {
		const schema = readSqliteObjectSchema('h1', 'kv');
		expect(schema.columns.map((column) => column.affinity)).toEqual(['TEXT', 'BLOB']);
	});

	it('reads a view without asking for foreign keys', () => {
		const schema = readSqliteObjectSchema('h1', 'v1');
		expect(schema.columns.map((column) => column.name)).toEqual(['id']);
		expect(state.prepared.some((sql) => sql.includes('foreign_key_list'))).toBe(false);
	});

	it('reads an index: key columns only, expressions unnamed, origin and flags', () => {
		const schema = readSqliteObjectSchema('h1', 'orders_note');
		expect(schema.columns).toEqual([]);
		expect(schema.index).toEqual({
			columns: [
				{ name: 'note', descending: true, collation: 'BINARY' },
				{ name: null, descending: false, collation: 'NOCASE' },
			],
			unique: false,
			partial: true,
			origin: 'create-index',
		});
	});

	it('reads a constraint autoindex, which has no CREATE statement', () => {
		const schema = readSqliteObjectSchema('h1', 'sqlite_autoindex_users_1');
		expect(schema.sql).toBeNull();
		expect(schema.index).toMatchObject({
			columns: [{ name: 'email' }],
			unique: true,
			origin: 'unique',
		});
	});

	it('returns only the SQL for a trigger', () => {
		const schema = readSqliteObjectSchema('h1', 'audit');
		expect(schema).toMatchObject({ kind: 'trigger', tableName: 'users', columns: [] });
		expect(schema.sql).toContain('CREATE TRIGGER audit');
		expect(schema.index).toBeUndefined();
	});

	it('picks between a trigger and a table that share a name', () => {
		expect(readSqliteObjectSchema('h1', 'orders').kind).toBe('table');
		state.db!.sql.orders = 'CREATE TRIGGER orders AFTER DELETE ON orders BEGIN SELECT 1; END';
		expect(readSqliteObjectSchema('h1', 'orders', 'trigger')).toMatchObject({
			kind: 'trigger',
			columns: [],
		});
	});

	it('keeps the SQL and reports why the columns could not be read', () => {
		const schema = readSqliteObjectSchema('h1', 'broken');
		expect(schema.sql).toBe('CREATE VIEW broken AS SELECT a FROM gone');
		expect(schema.columns).toEqual([]);
		expect(schema.error).toBe('no such table: main.gone');
	});

	it('throws for a name not in the schema, or a kind it does not have', () => {
		expect(() => readSqliteObjectSchema('h1', 'missing')).toThrow(
			'No table, view, index, or trigger is named missing.'
		);
		expect(() => readSqliteObjectSchema('h1', 'users', 'view')).toThrow('No view is named users.');
	});

	it('propagates a closed handle', () => {
		expect(() => readSqliteObjectSchema('gone', 'users')).toThrow('no longer open');
	});
});
