import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// better-sqlite3's native binary is built for Electron's ABI and does not load
// under vitest, so the connection is a fake that answers the statements
// sqlite-blob.ts prepares and records the BLOB query and its bindings. The
// object list comes from a mocked readSqliteObjectSummaries; the row source,
// the order, and the filter compiler stay real.
interface FakeTable {
	columns: Array<{ name: string; type: string | null }>;
	primaryKey?: string[];
	/** The row the BLOB query returns: [typeof, value, rowid?]. */
	row?: unknown[];
}

const state = vi.hoisted(() => ({
	tables: {} as Record<string, FakeTable>,
	objects: [] as Array<Record<string, unknown>>,
	sql: [] as string[],
	args: [] as unknown[][],
}));

function quoted(name: string) {
	return `"${name.replace(/"/g, '""')}"`;
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
			const name = Object.keys(state.tables).find((key) => sql.includes(`FROM ${quoted(key)}`));
			if (!name) throw new Error(`Unexpected SQL in test: ${sql}`);
			const table = state.tables[name];
			if (sql.startsWith('SELECT * FROM ')) return { columns: () => table.columns };
			state.sql.push(sql);
			const statement = {
				raw: () => statement,
				safeIntegers: () => statement,
				get(...args: unknown[]) {
					state.args.push(args);
					return table.row;
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

import { readSqliteBlob, saveSqliteBlob } from '../../../main/sqlite/sqlite-blob';

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

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), 'sqlite-blob-'));
	state.sql = [];
	state.args = [];
	state.tables = {
		media: {
			columns: [
				{ name: 'id', type: 'INTEGER' },
				{ name: 'data', type: 'BLOB' },
				{ name: 'note', type: 'TEXT' },
			],
			row: ['blob', PNG, 7n],
		},
		pairs: {
			columns: [
				{ name: 'k', type: 'TEXT' },
				{ name: 'v', type: 'BLOB' },
			],
			primaryKey: ['k'],
			row: ['blob', PNG],
		},
		thumbs: { columns: [{ name: 'img', type: null }], row: ['blob', PNG] },
	};
	state.objects = [
		summary('media', 'table'),
		summary('pairs', 'table', { withoutRowid: true }),
		summary('thumbs', 'view'),
	];
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe('readSqliteBlob', () => {
	it('reads the row by its rowid, bound as a BigInt, ignoring sort and filter', () => {
		const value = readSqliteBlob({
			handle: 'h1',
			name: 'media',
			column: 'data',
			rowid: '9007199254740993',
			sort: { column: 'note', direction: 'desc' },
			filter: 'this does not parse (',
		});
		expect(state.sql).toEqual([
			'SELECT typeof("data"), "data", "rowid" FROM "media" WHERE "rowid" = ?',
		]);
		expect(state.args).toEqual([[9007199254740993n]]);
		expect(value.bytes.equals(PNG)).toBe(true);
		expect(value.rowid).toBe('7');
	});

	it('reads a row with no rowid by its position, in the order and filter the window used', () => {
		readSqliteBlob({
			handle: 'h1',
			name: 'pairs',
			column: 'v',
			offset: 4,
			sort: { column: 'v', direction: 'desc' },
			filter: 'k ^= img',
		});
		expect(state.sql[0]).toMatch(/^SELECT typeof\("v"\), "v" FROM "pairs" WHERE .*"k".* LIKE \? /);
		expect(state.sql[0]).toMatch(/ ORDER BY "v" DESC, "k" LIMIT 1 OFFSET \?$/);
		expect(state.args[0]).toEqual(['img%', 4]);
	});

	it('reads a view by its scan position when nothing orders it', () => {
		const value = readSqliteBlob({ handle: 'h1', name: 'thumbs', column: 'img', offset: 0 });
		expect(state.sql[0]).toBe('SELECT typeof("img"), "img" FROM "thumbs" LIMIT 1 OFFSET ?');
		expect(value.rowid).toBeNull();
	});

	it('accepts a value that matches what the cell showed', () => {
		expect(() =>
			readSqliteBlob({
				handle: 'h1',
				name: 'media',
				column: 'data',
				rowid: '7',
				expected: { bytes: PNG.length, head: PNG.toString('hex').toUpperCase() },
			})
		).not.toThrow();
	});

	it('refuses a value whose size or head no longer matches the cell', () => {
		for (const expected of [
			{ bytes: PNG.length + 1, head: PNG.toString('hex') },
			{ bytes: PNG.length, head: 'ffd8ffe0' },
		]) {
			expect(() =>
				readSqliteBlob({ handle: 'h1', name: 'pairs', column: 'v', offset: 0, expected })
			).toThrow('v in row 1 changed since it was read. Reload the table and try again.');
		}
	});

	it('refuses a value that is not a BLOB, naming what it holds', () => {
		state.tables.media.row = ['null', null, 7n];
		expect(() =>
			readSqliteBlob({ handle: 'h1', name: 'media', column: 'data', rowid: '7' })
		).toThrow('data holds NULL in rowid 7, not a BLOB.');
		state.tables.media.row = ['text', 'hello', 7n];
		expect(() =>
			readSqliteBlob({ handle: 'h1', name: 'media', column: 'data', rowid: '7' })
		).toThrow('data holds a TEXT value in rowid 7, not a BLOB.');
	});

	it('says the row may have changed when it is gone', () => {
		state.tables.media.row = undefined;
		expect(() =>
			readSqliteBlob({ handle: 'h1', name: 'media', column: 'data', offset: 9 })
		).toThrow('media has no row 10; it may have changed since it was read.');
	});

	it('refuses a column the object does not have, before reading', () => {
		expect(() =>
			readSqliteBlob({ handle: 'h1', name: 'media', column: 'data"; DROP TABLE media', rowid: '1' })
		).toThrow('media has no column named data"; DROP TABLE media.');
		expect(state.sql).toEqual([]);
	});

	it('refuses a rowid for an object that has none, and text that is not a rowid', () => {
		expect(() => readSqliteBlob({ handle: 'h1', name: 'pairs', column: 'v', rowid: '1' })).toThrow(
			'pairs has no rowid; name the row by its position.'
		);
		expect(() =>
			readSqliteBlob({ handle: 'h1', name: 'media', column: 'data', rowid: '1 OR 1=1' })
		).toThrow('Not a rowid: 1 OR 1=1');
		expect(state.sql).toEqual([]);
	});

	it('needs a rowid or a position, and a filter that parses for a position', () => {
		expect(() => readSqliteBlob({ handle: 'h1', name: 'media', column: 'data' })).toThrow(
			'Name the row by its rowid or its position (offset).'
		);
		expect(() =>
			readSqliteBlob({ handle: 'h1', name: 'media', column: 'data', offset: 0, filter: 'nmae = x' })
		).toThrow('Filter problem: No column "nmae".');
		expect(() =>
			readSqliteBlob({ handle: 'h1', name: 'media', column: 'data', offset: -1 })
		).toThrow('offset must be a non-negative number');
	});
});

describe('saveSqliteBlob', () => {
	it('writes the whole value, creating parent folders, and reports what it wrote', async () => {
		const destPath = path.join(dir, 'nested', 'logo.png');
		const saved = await saveSqliteBlob({
			handle: 'h1',
			name: 'media',
			column: 'data',
			rowid: '7',
			destPath,
		});
		expect(saved).toEqual({ path: destPath, bytes: PNG.length, rowid: '7' });
		expect(readFileSync(destPath).equals(PNG)).toBe(true);
	});

	it('refuses a relative destination before reading anything', async () => {
		await expect(
			saveSqliteBlob({ handle: 'h1', name: 'media', column: 'data', rowid: '7', destPath: 'x.bin' })
		).rejects.toThrow('destPath must be an absolute path, got: x.bin');
		expect(state.sql).toEqual([]);
	});

	it('writes nothing when the value no longer matches', async () => {
		const destPath = path.join(dir, 'stale.bin');
		await expect(
			saveSqliteBlob({
				handle: 'h1',
				name: 'media',
				column: 'data',
				rowid: '7',
				expected: { bytes: 1, head: '00' },
				destPath,
			})
		).rejects.toThrow('changed since it was read');
		expect(() => readFileSync(destPath)).toThrow();
	});
});
