import { beforeEach, describe, expect, it, vi } from 'vitest';

// better-sqlite3's native binary is built for Electron's ABI and does not load
// under vitest, so the connection is a fake that answers the two chunk
// statements sqlite-count.ts prepares (a rowid walk and an offset walk) the
// way SQLite would, over rows held here. A filter is the one the tests use,
// `status = <value>`, applied to each row's `status`. The object list comes
// from a mocked readSqliteObjectSummaries; the resolver in sqlite-rows.ts and
// the filter compiler stay real, so the count binds names as the reader does.
interface FakeRow {
	rowid: bigint;
	status: string | null;
}

interface FakeTable {
	columns: Array<{ name: string; type: string | null }>;
	rows: FakeRow[];
	error?: Error;
}

const state = vi.hoisted(() => ({
	tables: {} as Record<string, FakeTable>,
	objects: [] as Array<Record<string, unknown>>,
	chunkSql: [] as string[],
	chunkArgs: [] as unknown[][],
	safeIntegers: 0,
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
			const table = tableFor(sql);
			if (table.error) throw table.error;
			if (sql.startsWith('SELECT * FROM ')) return { columns: () => table.columns };
			state.chunkSql.push(sql);
			const statement = {
				safeIntegers(flag: boolean) {
					if (flag) state.safeIntegers++;
					return statement;
				},
				get(...args: unknown[]) {
					state.chunkArgs.push(args);
					const filtered = sql.includes('CASE WHEN');
					const wanted = filtered ? args[0] : undefined;
					const matches = (row: FakeRow) => (filtered ? row.status === wanted : true);
					if (sql.includes('max(maestro_count_key)')) {
						const limit = args[args.length - 1] as number;
						const after = sql.includes(' > ?') ? (args[args.length - 2] as bigint) : null;
						const chunk = [...table.rows]
							.sort((a, b) => (a.rowid < b.rowid ? -1 : 1))
							.filter((row) => after === null || row.rowid > after)
							.slice(0, limit);
						return {
							scanned: BigInt(chunk.length),
							matched: BigInt(chunk.filter(matches).length),
							last: chunk.length > 0 ? chunk[chunk.length - 1].rowid : null,
						};
					}
					const [limit, offset] = args.slice(-2) as [number, number];
					const chunk = table.rows.slice(offset, offset + limit);
					return {
						scanned: BigInt(chunk.length),
						matched: BigInt(chunk.filter(matches).length),
					};
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

import {
	SQLITE_COUNT_CHUNK_ROWS,
	countAllSqliteRows,
	countSqliteRows,
} from '../../../main/sqlite/sqlite-count';

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

function rows(count: number, status: (index: number) => string | null = () => 'idle'): FakeRow[] {
	return Array.from({ length: count }, (_, index) => ({
		rowid: BigInt(index + 1),
		status: status(index),
	}));
}

const COLUMNS = [
	{ name: 'id', type: 'INTEGER' },
	{ name: 'status', type: 'TEXT' },
];

/** Rows in the big table: two full chunks and a partial third. */
const BIG = SQLITE_COUNT_CHUNK_ROWS * 2 + 7;

beforeEach(() => {
	state.chunkSql = [];
	state.chunkArgs = [];
	state.safeIntegers = 0;
	state.tables = {
		big: { columns: COLUMNS, rows: rows(BIG, (index) => (index % 4 === 0 ? 'active' : 'idle')) },
		small: { columns: COLUMNS, rows: rows(3) },
		empty: { columns: COLUMNS, rows: [] },
		gappy: {
			columns: COLUMNS,
			rows: [
				{ rowid: -5n, status: 'a' },
				{ rowid: 9007199254740993n, status: 'b' },
			],
		},
		shadowed: {
			columns: [
				{ name: 'rowid', type: 'TEXT' },
				{ name: 'status', type: 'TEXT' },
			],
			rows: rows(4),
		},
		pairs: { columns: COLUMNS, rows: rows(5) },
		active_view: { columns: COLUMNS, rows: rows(SQLITE_COUNT_CHUNK_ROWS + 1) },
		broken: { columns: [], rows: [], error: new Error('no such table: main.gone') },
	};
	state.objects = [
		summary('big', 'table'),
		summary('small', 'table'),
		summary('empty', 'table'),
		summary('gappy', 'table'),
		summary('shadowed', 'table'),
		summary('pairs', 'table', { withoutRowid: true }),
		summary('active_view', 'view'),
		summary('broken', 'view'),
	];
});

describe('countSqliteRows', () => {
	it('settles a small table in one call', () => {
		const count = countSqliteRows({ handle: 'h1', name: 'small' });
		expect(count).toEqual({
			name: 'small',
			matched: 3,
			complete: true,
			cursor: null,
			filtered: false,
			elapsedMs: expect.any(Number),
		});
		expect(state.chunkSql).toHaveLength(1);
		expect(state.safeIntegers).toBe(1);
	});

	it('converges a chunk at a time when the budget is spent, never shrinking', () => {
		const first = countSqliteRows({ handle: 'h1', name: 'big' }, 0);
		expect(first).toMatchObject({ matched: SQLITE_COUNT_CHUNK_ROWS, complete: false });
		expect(first.cursor).toEqual({
			matched: SQLITE_COUNT_CHUNK_ROWS,
			scanned: SQLITE_COUNT_CHUNK_ROWS,
			afterRowid: String(SQLITE_COUNT_CHUNK_ROWS),
		});

		const second = countSqliteRows({ handle: 'h1', name: 'big', cursor: first.cursor }, 0);
		expect(second.matched).toBe(SQLITE_COUNT_CHUNK_ROWS * 2);
		expect(second.complete).toBe(false);

		const third = countSqliteRows({ handle: 'h1', name: 'big', cursor: second.cursor }, 0);
		expect(third).toMatchObject({ matched: BIG, complete: true, cursor: null });
	});

	it('walks a rowid table by rowid, resuming after the last one', () => {
		const first = countSqliteRows({ handle: 'h1', name: 'big' }, 0);
		countSqliteRows({ handle: 'h1', name: 'big', cursor: first.cursor }, 0);

		expect(state.chunkSql[0]).not.toContain(' > ?');
		expect(state.chunkSql[0]).toContain('ORDER BY "rowid" LIMIT ?');
		expect(state.chunkSql[1]).toContain('WHERE "rowid" > ?');
		// The resume point is bound as a BigInt, never spliced into the SQL.
		expect(state.chunkArgs[1]).toEqual([BigInt(SQLITE_COUNT_CHUNK_ROWS), SQLITE_COUNT_CHUNK_ROWS]);
		expect(state.chunkSql[1]).not.toContain(String(SQLITE_COUNT_CHUNK_ROWS));
	});

	it('keeps rowids past 2^53 exact in the cursor', () => {
		state.tables.gappy.rows = Array.from({ length: SQLITE_COUNT_CHUNK_ROWS }, (_, index) => ({
			rowid: 9007199254740993n + BigInt(index) * 2n,
			status: 'x',
		}));
		const first = countSqliteRows({ handle: 'h1', name: 'gappy' }, 0);
		expect(first.complete).toBe(false);
		expect(first.cursor?.afterRowid).toBe(
			(9007199254740993n + BigInt(SQLITE_COUNT_CHUNK_ROWS - 1) * 2n).toString()
		);
		const done = countSqliteRows({ handle: 'h1', name: 'gappy', cursor: first.cursor }, 0);
		expect(done).toMatchObject({ matched: SQLITE_COUNT_CHUNK_ROWS, complete: true });
	});

	it('counts negative and huge rowids', () => {
		expect(countSqliteRows({ handle: 'h1', name: 'gappy' })).toMatchObject({
			matched: 2,
			complete: true,
		});
	});

	it('bounds a chunk by rows walked, counting matches inside it', () => {
		const count = countSqliteRows({ handle: 'h1', name: 'big', filter: 'status = active' }, 0);
		// One chunk walked, a quarter of it matched: a selective filter still
		// advances instead of scanning the whole table for its matches.
		expect(count).toMatchObject({
			matched: SQLITE_COUNT_CHUNK_ROWS / 4,
			complete: false,
			filtered: true,
		});
		expect(count.cursor?.scanned).toBe(SQLITE_COUNT_CHUNK_ROWS);
		expect(state.chunkSql[0]).toContain('CASE WHEN ("status" = ?) THEN 1 ELSE 0 END');
		expect(state.chunkArgs[0]).toEqual(['active', SQLITE_COUNT_CHUNK_ROWS]);
	});

	it('binds filter values ahead of the resume rowid', () => {
		const first = countSqliteRows({ handle: 'h1', name: 'big', filter: 'status = active' }, 0);
		countSqliteRows(
			{ handle: 'h1', name: 'big', filter: 'status = active', cursor: first.cursor },
			0
		);
		expect(state.chunkArgs[1]).toEqual([
			'active',
			BigInt(SQLITE_COUNT_CHUNK_ROWS),
			SQLITE_COUNT_CHUNK_ROWS,
		]);
	});

	it('uses a rowid alias a real column does not hide', () => {
		expect(countSqliteRows({ handle: 'h1', name: 'shadowed' }).matched).toBe(4);
		expect(state.chunkSql[0]).toContain('SELECT "_rowid_" AS maestro_count_key');
	});

	it('walks a view by OFFSET', () => {
		const first = countSqliteRows({ handle: 'h1', name: 'active_view' }, 0);
		expect(first.cursor).toEqual({
			matched: SQLITE_COUNT_CHUNK_ROWS,
			scanned: SQLITE_COUNT_CHUNK_ROWS,
			afterRowid: null,
		});
		const done = countSqliteRows({ handle: 'h1', name: 'active_view', cursor: first.cursor }, 0);
		expect(done).toMatchObject({ matched: SQLITE_COUNT_CHUNK_ROWS + 1, complete: true });
		expect(state.chunkSql[1]).toContain('LIMIT ? OFFSET ?');
		expect(state.chunkSql[1]).not.toContain('rowid');
		expect(state.chunkArgs[1]).toEqual([SQLITE_COUNT_CHUNK_ROWS, SQLITE_COUNT_CHUNK_ROWS]);
	});

	it('walks a WITHOUT ROWID table by OFFSET', () => {
		expect(countSqliteRows({ handle: 'h1', name: 'pairs' }).matched).toBe(5);
		expect(state.chunkSql[0]).toContain('LIMIT ? OFFSET ?');
	});

	it('settles an empty table at zero', () => {
		expect(countSqliteRows({ handle: 'h1', name: 'empty' })).toMatchObject({
			matched: 0,
			complete: true,
			cursor: null,
		});
	});

	it('reports a filter problem without counting', () => {
		const count = countSqliteRows({ handle: 'h1', name: 'big', filter: 'nope = 1' });
		expect(count.filterProblem?.message).toMatch(/nope/);
		expect(count).toMatchObject({ matched: 0, complete: false, cursor: null, filtered: false });
		expect(state.chunkSql).toHaveLength(0);
	});

	it.each([
		{ matched: -1, scanned: 0, afterRowid: null },
		{ matched: 0, scanned: 1.5, afterRowid: null },
		{ matched: 0, scanned: 0, afterRowid: '1 OR 1=1' },
		{ matched: 0, scanned: 0, afterRowid: 7 },
	])('refuses a malformed cursor %o', (cursor) => {
		expect(() => countSqliteRows({ handle: 'h1', name: 'big', cursor: cursor as never })).toThrow(
			'SQLite count cursor is malformed.'
		);
	});

	it('throws for an unknown name, a broken view, and a closed handle', () => {
		expect(() => countSqliteRows({ handle: 'h1', name: 'missing' })).toThrow(
			'No table or view is named missing.'
		);
		expect(() => countSqliteRows({ handle: 'h1', name: 'broken' })).toThrow(
			'no such table: main.gone'
		);
		expect(() => countSqliteRows({ handle: 'gone', name: 'big' })).toThrow(
			'SQLite database handle is no longer open.'
		);
	});
});

describe('countAllSqliteRows', () => {
	it('counts to the end and sums the time spent', async () => {
		const count = await countAllSqliteRows({
			handle: 'h1',
			name: 'big',
			filter: 'status = active',
		});
		expect(count).toMatchObject({
			matched: Math.ceil(BIG / 4),
			complete: true,
			cursor: null,
			filtered: true,
		});
	});

	it('returns a filter problem as is', async () => {
		const count = await countAllSqliteRows({ handle: 'h1', name: 'big', filter: 'status =' });
		expect(count.filterProblem).toBeDefined();
		expect(count.complete).toBe(false);
	});
});
