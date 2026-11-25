import { beforeEach, describe, expect, it, vi } from 'vitest';

// better-sqlite3's native binary is built for Electron's ABI and does not load
// under vitest, so the connection is a fake that answers the statements
// sqlite-rows.ts prepares, and records the window query and its bindings. The
// object list comes from a mocked readSqliteObjectSummaries; findSqliteObject
// stays real, so a name resolves the way the reader resolves it.
interface FakeTable {
	columns: Array<{ name: string; type: string | null }>;
	/** Primary-key column names in key order, for pragma_table_info. */
	primaryKey?: string[];
	/** Rows as value/length pairs, the shape the window query returns. */
	rows: unknown[][];
	/** Each row's rowid; the fake numbers rows from 1 when this is absent. */
	rowids?: bigint[];
	/** Each row's whole key values, appended when the window selects key columns. */
	keys?: unknown[][];
	/** Thrown by prepare, as SQLite does for a broken view. */
	error?: Error;
}

const state = vi.hoisted(() => ({
	tables: {} as Record<string, FakeTable>,
	objects: [] as Array<Record<string, unknown>>,
	windowSql: [] as string[],
	windowArgs: [] as unknown[][],
	flags: [] as string[],
	/** Editability per object name; absent means the default read-only answer. */
	editability: {} as Record<string, unknown>,
}));

function quoted(name: string) {
	return `"${name.replace(/"/g, '""')}"`;
}

function tableFor(sql: string): FakeTable {
	const match = Object.keys(state.tables).find((name) => sql.includes(`FROM ${quoted(name)}`));
	if (!match) throw new Error(`Unexpected SQL in test: ${sql}`);
	return state.tables[match];
}

function fakeDb() {
	return {
		prepare(sql: string) {
			if (sql.startsWith("SELECT name FROM pragma_table_info(?, 'main') WHERE pk > 0")) {
				return {
					all: (name: string) =>
						(state.tables[name]?.primaryKey ?? []).map((column) => ({ name: column })),
				};
			}
			const table = tableFor(sql);
			if (table.error) throw table.error;
			if (sql.startsWith('SELECT * FROM ')) {
				return { columns: () => table.columns };
			}
			state.windowSql.push(sql);
			const statement = {
				raw(flag: boolean) {
					if (flag) state.flags.push('raw');
					return statement;
				},
				safeIntegers(flag: boolean) {
					if (flag) state.flags.push('safeIntegers');
					return statement;
				},
				// Filter bindings (if any) come first, then LIMIT and OFFSET. A
				// window that selects a rowid alias first gets it ahead of the pairs.
				all(...args: unknown[]) {
					state.windowArgs.push(args);
					const [limit, offset] = args.slice(-2) as [number, number];
					// An editable table's window selects each row's version last.
					const withVersion = sql.includes('maestro_row_version(');
					const rows = table.rows
						.slice(offset, offset + limit)
						.map((row, index) => (table.keys ? [...row, ...table.keys[offset + index]] : row))
						.map((row, index) => (withVersion ? [...row, `version-${offset + index + 1}`] : row));
					if (!/^SELECT "(rowid|_rowid_|oid)", /.test(sql)) return rows;
					return rows.map((row, index) => [
						table.rowids?.[offset + index] ?? BigInt(offset + index + 1),
						...row,
					]);
				},
			};
			return statement;
		},
	};
}

vi.mock('../../../main/sqlite/sqlite-database', () => ({
	getSqliteDatabase: (handle: string) => {
		if (handle !== 'h1') throw new Error('SQLite database handle is no longer open.');
		return { db: fakeDb(), info: { handle, displayPath: '/data/app.db', fileBytes: 1024 } };
	},
}));

vi.mock('../../../main/sqlite/sqlite-objects', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../main/sqlite/sqlite-objects')>()),
	readSqliteObjectSummaries: () => state.objects,
}));

// Editability has its own tests (sqlite-identity.test.ts); here it only has
// to reach the page. reachableRowidAlias stays real.
vi.mock('../../../main/sqlite/sqlite-identity', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../main/sqlite/sqlite-identity')>()),
	resolveSqliteEditability: (_db: unknown, object: { name: string }) =>
		state.editability[object.name] ?? {
			editable: false,
			code: 'no-identity',
			reason: `resolved for ${object.name}`,
		},
}));

import { SQLITE_ROWS_MAX_LIMIT, readSqliteRows } from '../../../main/sqlite/sqlite-rows';
import { SQLITE_CELL_BLOB_HEAD_BYTES, SQLITE_CELL_TEXT_LIMIT } from '../../../shared/sqlite/cells';

function summary(name: string, kind: string, extra: Record<string, unknown> = {}) {
	return {
		name,
		kind,
		tableName: name,
		internal: false,
		countable: kind === 'table',
		hasStorage: kind === 'table',
		...(kind === 'table' ? { tableType: 'table', withoutRowid: false, strict: false } : {}),
		...extra,
	};
}

/** One row of `count` simple values: value/length pairs with no length. */
function pairs(...values: unknown[]): unknown[] {
	return values.flatMap((value) => [value, typeof value === 'string' ? value.length : null]);
}

beforeEach(() => {
	state.editability = {};
	state.windowSql = [];
	state.windowArgs = [];
	state.flags = [];
	state.tables = {
		users: {
			columns: [
				{ name: 'id', type: 'INTEGER' },
				{ name: 'name', type: 'TEXT' },
			],
			rows: Array.from({ length: 5 }, (_, index) => pairs(BigInt(index + 1), `user${index + 1}`)),
		},
		pairs: {
			columns: [
				{ name: 'a', type: 'TEXT' },
				{ name: 'b', type: 'INTEGER' },
			],
			primaryKey: ['a', 'b'],
			rows: [pairs('x', 1n)],
		},
		shadowed: {
			columns: [
				{ name: 'rowid', type: 'TEXT' },
				{ name: 'OID', type: 'TEXT' },
			],
			rows: [],
		},
		active: {
			columns: [
				{ name: 'id', type: 'INTEGER' },
				{ name: 'n', type: null },
			],
			rows: [pairs(1n, 3n)],
		},
		docs: { columns: [{ name: 'body', type: '' }], rows: [] },
		broken: { columns: [], rows: [], error: new Error('no such table: main.gone') },
		held: {
			columns: [{ name: 'id', type: 'INTEGER' }],
			rows: [],
			error: Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }),
		},
		'we"ird': { columns: [{ name: 'c"ol', type: 'TEXT' }], rows: [] },
	};
	state.objects = [
		summary('users', 'table'),
		summary('users', 'trigger'),
		summary('pairs', 'table', { withoutRowid: true }),
		summary('shadowed', 'table'),
		summary('active', 'view'),
		summary('docs', 'table', { tableType: 'virtual' }),
		summary('broken', 'view'),
		summary('held', 'table'),
		summary('we"ird', 'table'),
		summary('users_name', 'index'),
	];
});

describe('readSqliteRows', () => {
	it('reads one window with LIMIT and OFFSET bound, asking for one extra row', () => {
		const page = readSqliteRows({ handle: 'h1', name: 'users', offset: 1, limit: 2 });
		expect(state.windowArgs).toEqual([[3, 1]]);
		expect(state.windowSql[0]).toMatch(/ LIMIT \? OFFSET \?$/);
		expect(page.rows).toEqual([
			[2, 'user2'],
			[3, 'user3'],
		]);
		expect(page.offset).toBe(1);
		expect(page.hasMore).toBe(true);
		expect(page.columns).toEqual([
			{ name: 'id', declaredType: 'INTEGER' },
			{ name: 'name', declaredType: 'TEXT' },
		]);
	});

	it('says no more rows follow when the extra row is absent', () => {
		const page = readSqliteRows({ handle: 'h1', name: 'users', offset: 3, limit: 10 });
		expect(page.rows).toHaveLength(2);
		expect(page.hasMore).toBe(false);
	});

	it('reads raw arrays with safe integers', () => {
		readSqliteRows({ handle: 'h1', name: 'users', offset: 0, limit: 1 });
		expect(state.flags).toEqual(['raw', 'safeIntegers']);
	});

	it('clamps the window to the maximum and floors fractional bounds', () => {
		readSqliteRows({ handle: 'h1', name: 'users', offset: 2.7, limit: 1_000_000 });
		expect(state.windowArgs).toEqual([[SQLITE_ROWS_MAX_LIMIT + 1, 2]]);
	});

	it('refuses a negative or non-numeric bound', () => {
		expect(() => readSqliteRows({ handle: 'h1', name: 'users', offset: -1, limit: 5 })).toThrow(
			'offset must be a non-negative number'
		);
		expect(() =>
			readSqliteRows({ handle: 'h1', name: 'users', offset: 0, limit: '5' as unknown as number })
		).toThrow('limit must be a non-negative number');
	});

	it('orders a rowid table by rowid when unsorted', () => {
		const page = readSqliteRows({ handle: 'h1', name: 'users', offset: 0, limit: 5 });
		expect(state.windowSql[0]).toContain(' ORDER BY "rowid" LIMIT');
		expect(page.orderedBy).toEqual(['rowid']);
	});

	it('sorts in SQLite by the quoted column, then breaks ties by rowid', () => {
		const page = readSqliteRows({
			handle: 'h1',
			name: 'users',
			offset: 0,
			limit: 5,
			sort: { column: 'name', direction: 'desc' },
		});
		expect(state.windowSql[0]).toContain(' ORDER BY "name" DESC, "rowid" LIMIT');
		expect(page.orderedBy).toEqual(['name', 'rowid']);
	});

	it('breaks ties by the primary key of a WITHOUT ROWID table, without repeating the sort column', () => {
		const page = readSqliteRows({
			handle: 'h1',
			name: 'pairs',
			offset: 0,
			limit: 5,
			sort: { column: 'b', direction: 'asc' },
		});
		expect(state.windowSql[0]).toContain(' ORDER BY "b", "a" LIMIT');
		expect(page.orderedBy).toEqual(['b', 'a']);
	});

	it('uses a rowid alias a real column does not shadow', () => {
		const page = readSqliteRows({ handle: 'h1', name: 'shadowed', offset: 0, limit: 5 });
		expect(page.orderedBy).toEqual(['_rowid_']);
	});

	it('leaves a view and a virtual table in scan order when unsorted', () => {
		expect(readSqliteRows({ handle: 'h1', name: 'active', offset: 0, limit: 5 }).orderedBy).toEqual(
			[]
		);
		expect(readSqliteRows({ handle: 'h1', name: 'docs', offset: 0, limit: 5 }).orderedBy).toEqual(
			[]
		);
		expect(state.windowSql.every((sql) => !sql.includes('ORDER BY'))).toBe(true);
	});

	it('reports a view expression column with no declared type', () => {
		const page = readSqliteRows({ handle: 'h1', name: 'active', offset: 0, limit: 5 });
		expect(page.columns[1]).toEqual({ name: 'n', declaredType: null });
		expect(page.rows).toEqual([[1, 3]]);
	});

	it('quotes every identifier, including ones with double quotes in them', () => {
		readSqliteRows({
			handle: 'h1',
			name: 'we"ird',
			offset: 0,
			limit: 5,
			sort: { column: 'c"ol', direction: 'asc' },
		});
		expect(state.windowSql[0]).toContain('FROM "we""ird"');
		expect(state.windowSql[0]).toContain('typeof("c""ol")');
		expect(state.windowSql[0]).toContain('ORDER BY "c""ol", "rowid"');
	});

	it('cuts TEXT and BLOB values in SQL, with no alias an ORDER BY could resolve to', () => {
		readSqliteRows({ handle: 'h1', name: 'users', offset: 0, limit: 5 });
		const sql = state.windowSql[0];
		expect(sql).toContain(`substr("name", 1, ${SQLITE_CELL_TEXT_LIMIT})`);
		expect(sql).toContain(`substr("name", 1, ${SQLITE_CELL_BLOB_HEAD_BYTES})`);
		expect(sql).toContain(`WHEN 'text' THEN length("name")`);
		expect(sql).not.toMatch(/\bAS\b/);
	});

	it('turns values into wire cells: exact big integers, cut text, and blob heads', () => {
		state.tables.users.rows = [
			[9007199254740993n, null, 'x'.repeat(SQLITE_CELL_TEXT_LIMIT), SQLITE_CELL_TEXT_LIMIT + 10],
			[Buffer.from([0xde, 0xad]), 5000n, '', 0n],
			[null, null, 1.5, null],
		];
		const page = readSqliteRows({ handle: 'h1', name: 'users', offset: 0, limit: 5 });
		expect(page.rows[0][0]).toEqual({ kind: 'integer', text: '9007199254740993' });
		expect(page.rows[0][1]).toEqual({
			kind: 'text',
			head: 'x'.repeat(SQLITE_CELL_TEXT_LIMIT),
			length: SQLITE_CELL_TEXT_LIMIT + 10,
		});
		expect(page.rows[1][0]).toEqual({ kind: 'blob', head: 'dead', bytes: 5000 });
		// An empty string is a value, never a NULL.
		expect(page.rows[1][1]).toBe('');
		expect(page.rows[2]).toEqual([null, 1.5]);
	});

	it('keeps a negative big integer exact and narrows a safe one', () => {
		state.tables.users.rows = [[-9007199254740993n, null, -42n, null]];
		const page = readSqliteRows({ handle: 'h1', name: 'users', offset: 0, limit: 5 });
		expect(page.rows[0]).toEqual([{ kind: 'integer', text: '-9007199254740993' }, -42]);
	});

	it('reads the table when a trigger shares its name', () => {
		expect(readSqliteRows({ handle: 'h1', name: 'users', offset: 0, limit: 1 }).name).toBe('users');
	});

	it('refuses a name that is not a table or view', () => {
		expect(() => readSqliteRows({ handle: 'h1', name: 'users_name', offset: 0, limit: 5 })).toThrow(
			'No table or view is named users_name.'
		);
		expect(() => readSqliteRows({ handle: 'h1', name: 'nope', offset: 0, limit: 5 })).toThrow(
			'No table or view is named nope.'
		);
	});

	it('refuses a sort on a column the object does not have, before running the window', () => {
		expect(() =>
			readSqliteRows({
				handle: 'h1',
				name: 'users',
				offset: 0,
				limit: 5,
				sort: { column: 'email; DROP TABLE users', direction: 'asc' },
			})
		).toThrow('users has no column named email; DROP TABLE users.');
		expect(state.windowSql).toEqual([]);
	});

	it('refuses a sort direction other than asc or desc', () => {
		expect(() =>
			readSqliteRows({
				handle: 'h1',
				name: 'users',
				offset: 0,
				limit: 5,
				sort: { column: 'name', direction: 'sideways' as 'asc' },
			})
		).toThrow('Sort direction must be asc or desc.');
	});

	it("passes SQLite's own error through for an object it cannot read", () => {
		expect(() => readSqliteRows({ handle: 'h1', name: 'broken', offset: 0, limit: 5 })).toThrow(
			'no such table: main.gone'
		);
	});

	it('says another process has the database open when SQLite reports it busy', () => {
		expect(() => readSqliteRows({ handle: 'h1', name: 'held', offset: 0, limit: 5 })).toThrow(
			'Another process has this database open and kept it locked past the 1 s wait, so it could not be read just now.'
		);
	});

	it('compiles a filter into a WHERE whose values are bound ahead of LIMIT and OFFSET', () => {
		const page = readSqliteRows({
			handle: 'h1',
			name: 'users',
			offset: 0,
			limit: 2,
			filter: 'id > 2 and name ~ "o\'; DROP TABLE users"',
		});
		const sql = state.windowSql[0];
		expect(sql).toContain(' WHERE ("id" > ? AND ');
		expect(sql).toContain(' ORDER BY "rowid" LIMIT ? OFFSET ?');
		expect(sql).not.toContain('DROP TABLE');
		expect(state.windowArgs[0]).toEqual(['2', "%o'; drop table users%", 3, 0]);
		expect(page.filtered).toBe(true);
		expect(page.filterProblem).toBeUndefined();
	});

	it('treats blank filter text as no filter', () => {
		const page = readSqliteRows({
			handle: 'h1',
			name: 'users',
			offset: 0,
			limit: 2,
			filter: '   ',
		});
		expect(state.windowSql[0]).not.toContain('WHERE');
		expect(page.filtered).toBe(false);
	});

	it('reads nothing and returns the problem when the filter names a missing column', () => {
		const page = readSqliteRows({
			handle: 'h1',
			name: 'users',
			offset: 0,
			limit: 2,
			filter: 'nmae = bob',
		});
		expect(state.windowSql).toEqual([]);
		expect(page.rows).toEqual([]);
		expect(page.filtered).toBe(false);
		expect(page.filterProblem).toMatchObject({
			message: 'No column "nmae". Did you mean "name"?',
			start: 0,
			end: 4,
			suggestion: 'name',
		});
	});

	it('says whether the rows can be edited, also when the filter does not parse', () => {
		const page = readSqliteRows({ handle: 'h1', name: 'users', offset: 0, limit: 2 });
		expect(page.editability).toEqual({
			editable: false,
			code: 'no-identity',
			reason: 'resolved for users',
		});
		const problem = readSqliteRows({
			handle: 'h1',
			name: 'users',
			offset: 0,
			limit: 2,
			filter: 'nmae = bob',
		});
		expect(problem.editability).toMatchObject({ reason: 'resolved for users' });
	});

	it("binds a filter literal by the column's affinity", () => {
		// `n` is a view expression column: no affinity, so a number binds as one.
		readSqliteRows({ handle: 'h1', name: 'active', offset: 0, limit: 5, filter: 'n = 3' });
		expect(state.windowSql[0]).toContain(' WHERE "n" = ? LIMIT');
		expect(state.windowArgs[0]).toEqual([3, 6, 0]);
	});

	it("carries each row's rowid, selected ahead of the cells with no alias", () => {
		const page = readSqliteRows({ handle: 'h1', name: 'users', offset: 1, limit: 2 });
		expect(state.windowSql[0]).toMatch(/^SELECT "rowid", CASE typeof\("id"\)/);
		expect(page.rowids).toEqual(['2', '3']);
		// The rowid does not shift the cells.
		expect(page.rows[0]).toEqual([2, 'user2']);
	});

	it('keeps a rowid past 2^53 exact as decimal text', () => {
		state.tables.users.rowids = [9007199254740993n, -5n];
		const page = readSqliteRows({ handle: 'h1', name: 'users', offset: 0, limit: 2 });
		expect(page.rowids).toEqual(['9007199254740993', '-5']);
	});

	it('selects the rowid by an alias a real column does not shadow', () => {
		readSqliteRows({ handle: 'h1', name: 'shadowed', offset: 0, limit: 5 });
		expect(state.windowSql[0]).toMatch(/^SELECT "_rowid_", /);
	});

	it('has no rowids for a view, a virtual table, or a WITHOUT ROWID table', () => {
		for (const name of ['active', 'docs', 'pairs']) {
			expect(readSqliteRows({ handle: 'h1', name, offset: 0, limit: 5 }).rowids).toBeNull();
		}
		expect(state.windowSql.every((sql) => !/^SELECT "(rowid|_rowid_|oid)"/.test(sql))).toBe(true);
	});

	it('returns empty rowids, not null, with a filter problem on a rowid table', () => {
		const page = readSqliteRows({
			handle: 'h1',
			name: 'users',
			offset: 0,
			limit: 2,
			filter: 'nmae = bob',
		});
		expect(page.rowids).toEqual([]);
	});

	it('has no row keys unless the rows are edited by their primary key', () => {
		expect(readSqliteRows({ handle: 'h1', name: 'users', offset: 0, limit: 2 }).rowKeys).toBeNull();
		state.editability.users = {
			editable: true,
			identity: { kind: 'rowid', alias: 'rowid', rowidColumn: 'id' },
			readOnlyColumns: [],
		};
		expect(readSqliteRows({ handle: 'h1', name: 'users', offset: 0, limit: 2 }).rowKeys).toBeNull();
	});

	it("reads each row's primary key whole, after the cells, for a table edited by it", () => {
		state.editability.pairs = {
			editable: true,
			identity: { kind: 'primary-key', columns: ['a', 'b'], keyMayBeNull: false },
			readOnlyColumns: [],
		};
		// The cell is cut to its head; the key column carries the whole value.
		const long = 'k'.repeat(SQLITE_CELL_TEXT_LIMIT + 10);
		state.tables.pairs.rows = [[long.slice(0, SQLITE_CELL_TEXT_LIMIT), long.length, 1n, null]];
		state.tables.pairs.keys = [[long, 1n]];
		const page = readSqliteRows({ handle: 'h1', name: 'pairs', offset: 0, limit: 5 });
		expect(state.windowSql[0]).toMatch(
			/END, "a", "b", maestro_row_version\("a", "b"\) FROM "pairs"/
		);
		expect(page.rows[0]).toEqual([
			{ kind: 'text', head: long.slice(0, SQLITE_CELL_TEXT_LIMIT), length: long.length },
			1,
		]);
		expect(page.rowKeys).toEqual([
			[
				{ type: 'text', text: long },
				{ type: 'integer', text: '1' },
			],
		]);
		expect(page.rowids).toBeNull();

		const problem = readSqliteRows({
			handle: 'h1',
			name: 'pairs',
			offset: 0,
			limit: 5,
			filter: 'nope = 1',
		});
		expect(problem.rowKeys).toEqual([]);
	});

	it("carries each row's version, over every column, only when the rows can be edited", () => {
		const locked = readSqliteRows({ handle: 'h1', name: 'users', offset: 0, limit: 2 });
		expect(locked.rowVersions).toBeNull();
		expect(state.windowSql[0]).not.toContain('maestro_row_version');

		state.editability.users = {
			editable: true,
			identity: { kind: 'rowid', alias: 'rowid', rowidColumn: 'id' },
			readOnlyColumns: [],
		};
		const page = readSqliteRows({ handle: 'h1', name: 'users', offset: 1, limit: 2 });
		expect(state.windowSql[1]).toMatch(
			/END, maestro_row_version\("id", "name"\) FROM "users" ORDER BY "rowid" LIMIT \? OFFSET \?$/
		);
		expect(page.rowVersions).toEqual(['version-2', 'version-3']);
		// The version does not shift the cells or the rowids.
		expect(page.rows[0]).toEqual([2, 'user2']);
		expect(page.rowids).toEqual(['2', '3']);

		const problem = readSqliteRows({
			handle: 'h1',
			name: 'users',
			offset: 0,
			limit: 2,
			filter: 'nmae = bob',
		});
		expect(problem.rowVersions).toEqual([]);
	});

	it('fails on a handle that is no longer open', () => {
		expect(() => readSqliteRows({ handle: 'gone', name: 'users', offset: 0, limit: 5 })).toThrow(
			'no longer open'
		);
	});
});
