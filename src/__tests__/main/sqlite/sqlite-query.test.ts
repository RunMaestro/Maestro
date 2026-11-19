import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// better-sqlite3's native binary is built for Electron's ABI and does not load
// under vitest, so the driver is a fake that records how the run's own
// connection was opened and answers the one statement with rows set here.
// Under vitest no compiled worker sits beside sqlite-worker-runner.ts, so the
// run happens inline: these tests drive the same task the worker thread runs.
const driver = vi.hoisted(() => ({
	instances: [] as Array<{
		path: string;
		options: Record<string, unknown>;
		pragmas: string[];
		functions: string[];
		prepared: string[];
		closed: boolean;
	}>,
	statement: {
		readonly: true,
		reader: true,
		columns: [] as Array<{ name: string; type: string | null }>,
		rows: [] as unknown[][],
		prepareError: null as Error | null,
	},
	flags: [] as string[],
	/** Rows the iterator handed out, so a test sees SQLite stop early. */
	produced: 0,
	iteratorClosed: false,
	ran: 0,
	/** Arguments the statement was last bound with (iterate or run). */
	boundArgs: null as unknown[] | null,
	/** A per-text prepare failure, to play SQLite's parser for a syntax error. */
	prepareFails: null as ((sql: string) => Error | null) | null,
}));

vi.mock('better-sqlite3', () => {
	class FakeDatabase {
		record: (typeof driver.instances)[number];
		constructor(filePath: string, options: Record<string, unknown>) {
			this.record = {
				path: filePath,
				options,
				pragmas: [],
				functions: [],
				prepared: [],
				closed: false,
			};
			driver.instances.push(this.record);
		}
		pragma(source: string) {
			this.record.pragmas.push(source);
			return 1;
		}
		function(name: string) {
			this.record.functions.push(name);
		}
		prepare(sql: string) {
			this.record.prepared.push(sql);
			if (driver.statement.prepareError) throw driver.statement.prepareError;
			const failure = driver.prepareFails?.(sql);
			if (failure) throw failure;
			const statement = {
				readonly: driver.statement.readonly,
				reader: driver.statement.reader,
				columns: () => driver.statement.columns,
				raw(flag: boolean) {
					if (flag) driver.flags.push('raw');
					return statement;
				},
				safeIntegers(flag: boolean) {
					if (flag) driver.flags.push('safeIntegers');
					return statement;
				},
				iterate(...args: unknown[]) {
					driver.boundArgs = args;
					const rows = driver.statement.rows;
					let index = 0;
					const iterator: IterableIterator<unknown[]> = {
						next: () => {
							if (index >= rows.length) return { done: true, value: undefined };
							driver.produced++;
							return { done: false, value: rows[index++] };
						},
						return: () => {
							driver.iteratorClosed = true;
							return { done: true, value: undefined };
						},
						[Symbol.iterator]: () => iterator,
					};
					return iterator;
				},
				run: (...args: unknown[]) => {
					driver.boundArgs = args;
					driver.ran++;
					return { changes: 0 };
				},
			};
			return statement;
		}
		close() {
			this.record.closed = true;
		}
	}
	return { default: FakeDatabase };
});

const releaseHooks = vi.hoisted(() => new Set<() => void>());
vi.mock('../../../main/sqlite/sqlite-database', () => ({
	getSqliteDatabase: (handle: string) => {
		if (handle !== 'h1') throw new Error('SQLite database handle is no longer open.');
		return { displayPath: '/data/app.db', releaseHooks };
	},
}));

// The history file lives in the app's data directory; here it is a recorder.
const history = vi.hoisted(() => ({ record: vi.fn(async (..._args: unknown[]) => undefined) }));
vi.mock('../../../main/sqlite/sqlite-query-history', () => ({
	getSqliteQueryHistory: () => history,
}));
vi.mock('../../../main/utils/logger', () => ({
	logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import {
	cancelSqliteQuery,
	exportSqliteQuery,
	runSqliteQuery,
} from '../../../main/sqlite/sqlite-query';
import { SQLITE_EXPORT_NO_ROWS_MESSAGE } from '../../../main/sqlite/sqlite-query-task';
import { SQLITE_QUERY_REFUSED } from '../../../main/sqlite/sqlite-query-task';
import { SQLITE_BUSY_TIMEOUT_MS } from '../../../main/sqlite/sqlite-connection';
import { SQLITE_CELL_TEXT_LIMIT } from '../../../shared/sqlite/cells';
import { SQLITE_REGEXP_FUNCTION } from '../../../shared/sqlite/filter';
import {
	SQLITE_NOT_READ_ONLY_MESSAGE,
	SQLITE_ONE_STATEMENT_MESSAGE,
	SQLITE_PLAN_OF_EXPLAIN_MESSAGE,
	SQLITE_QUERY_STOPPED_MESSAGE,
	SQLITE_EXPORT_STOPPED_MESSAGE,
} from '../../../shared/sqlite/query';

function numbered(count: number): unknown[][] {
	return Array.from({ length: count }, (_, index) => [BigInt(index + 1)]);
}

describe('runSqliteQuery', () => {
	beforeEach(() => {
		driver.instances = [];
		driver.statement = {
			readonly: true,
			reader: true,
			columns: [{ name: 'id', type: 'INTEGER' }],
			rows: numbered(3),
			prepareError: null,
		};
		driver.flags = [];
		driver.produced = 0;
		driver.iteratorClosed = false;
		driver.ran = 0;
		driver.boundArgs = null;
		driver.prepareFails = null;
		releaseHooks.clear();
		history.record.mockClear();
		history.record.mockImplementation(async () => undefined);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('runs on a read-only connection of its own, then closes it', async () => {
		const result = await runSqliteQuery({ handle: 'h1', sql: '  SELECT id FROM users  ' });
		expect(result).toMatchObject({
			statement: 'SELECT',
			columns: [{ name: 'id', declaredType: 'INTEGER' }],
			rows: [[1], [2], [3]],
			offset: 0,
			hasMore: false,
			returnsRows: true,
		});

		expect(driver.instances).toHaveLength(1);
		const [connection] = driver.instances;
		expect(connection.path).toBe('/data/app.db');
		expect(connection.options).toEqual({
			readonly: true,
			fileMustExist: true,
			timeout: SQLITE_BUSY_TIMEOUT_MS,
		});
		expect(connection.pragmas).toContain('trusted_schema = OFF');
		expect(connection.functions).toEqual([SQLITE_REGEXP_FUNCTION]);
		expect(connection.prepared).toEqual(['SELECT id FROM users']);
		expect(driver.flags).toEqual(['raw', 'safeIntegers']);
		expect(connection.closed).toBe(true);
		// A finished run leaves nothing on the handle's release hooks.
		expect(releaseHooks.size).toBe(0);
	});

	it('returns the window at an offset and stops SQLite one row past it', async () => {
		driver.statement.rows = numbered(10);
		const result = await runSqliteQuery({
			handle: 'h1',
			sql: 'SELECT id FROM t',
			offset: 2,
			limit: 2,
		});
		expect(result.rows).toEqual([[3], [4]]);
		expect(result.offset).toBe(2);
		expect(result.hasMore).toBe(true);
		// Two skipped, two kept, one peeked: the other five were never produced.
		expect(driver.produced).toBe(5);
		expect(driver.iteratorClosed).toBe(true);
	});

	it('cuts values the way a table window does', async () => {
		driver.statement.columns = [
			{ name: 'big', type: null },
			{ name: 'body', type: 'TEXT' },
			{ name: 'data', type: 'BLOB' },
		];
		driver.statement.rows = [
			[BigInt('9007199254740993'), 'z'.repeat(SQLITE_CELL_TEXT_LIMIT + 1), Buffer.from([1, 2])],
		];
		const result = await runSqliteQuery({ handle: 'h1', sql: 'SELECT * FROM t' });
		expect(result.columns[0]).toEqual({ name: 'big', declaredType: null });
		expect(result.rows[0]).toEqual([
			{ kind: 'integer', text: '9007199254740993' },
			{
				kind: 'text',
				head: 'z'.repeat(SQLITE_CELL_TEXT_LIMIT),
				length: SQLITE_CELL_TEXT_LIMIT + 1,
			},
			{ kind: 'blob', head: '0102', bytes: 2 },
		]);
	});

	it('refuses a write by its keyword without opening a connection', async () => {
		await expect(runSqliteQuery({ handle: 'h1', sql: 'DELETE FROM users' })).rejects.toMatchObject({
			message: expect.stringMatching(/^DELETE is not a read-only statement/),
			code: SQLITE_QUERY_REFUSED,
		});
		await expect(runSqliteQuery({ handle: 'h1', sql: "ATTACH 'x.db' AS x" })).rejects.toThrow(
			/opens or closes another database file/
		);
		expect(driver.instances).toHaveLength(0);
	});

	it('refuses a write behind a read keyword when the driver says it is not read-only', async () => {
		driver.statement.readonly = false;
		await expect(
			runSqliteQuery({ handle: 'h1', sql: 'WITH x AS (SELECT 1) DELETE FROM users' })
		).rejects.toMatchObject({ message: SQLITE_NOT_READ_ONLY_MESSAGE, code: SQLITE_QUERY_REFUSED });
		expect(driver.ran).toBe(0);
		expect(driver.instances[0].closed).toBe(true);
	});

	it('refuses a second statement in plain words', async () => {
		driver.statement.prepareError = new RangeError(
			'The supplied SQL string contains more than one statement'
		);
		await expect(
			runSqliteQuery({ handle: 'h1', sql: 'SELECT 1; DELETE FROM users' })
		).rejects.toThrow(SQLITE_ONE_STATEMENT_MESSAGE);
		expect(driver.instances[0].closed).toBe(true);
	});

	it("passes SQLite's own error through verbatim", async () => {
		driver.statement.prepareError = Object.assign(new Error('no such table: userz'), {
			code: 'SQLITE_ERROR',
		});
		const failure = await runSqliteQuery({ handle: 'h1', sql: 'SELECT * FROM userz' }).catch(
			(error: unknown) => error
		);
		expect(failure).toMatchObject({ message: 'no such table: userz', code: 'SQLITE_ERROR' });
		// Not a syntax error, so SQLite is not asked where it stopped.
		expect(failure).not.toHaveProperty('offset');
		expect(driver.instances[0].prepared).toEqual(['SELECT * FROM userz']);
	});

	it('finds where a syntax error stopped by asking SQLite about the text before each candidate', async () => {
		// Three `=`; SQLite stops at the third. Text before it parses so far
		// (it only ends too soon); text running past it holds the error.
		const sql = 'SELECT * FROM t WHERE a = 1 AND b = = 2';
		const errorAt = sql.lastIndexOf('=');
		driver.prepareFails = (text) =>
			text.length > errorAt
				? Object.assign(new Error('near "=": syntax error'), { code: 'SQLITE_ERROR' })
				: new Error('incomplete input');
		const failure = await runSqliteQuery({ handle: 'h1', sql }).catch((error: unknown) => error);
		expect(failure).toMatchObject({
			message: 'near "=": syntax error',
			code: 'SQLITE_ERROR',
			offset: errorAt,
		});
		const [connection] = driver.instances;
		// The statement, then a bisection over the candidates: never one prepare each.
		expect(connection.prepared[0]).toBe(sql);
		expect(connection.prepared.length).toBeLessThanOrEqual(3);
		expect(connection.closed).toBe(true);
	});

	it('places a plan run syntax error in the statement as written, not in the EXPLAIN', async () => {
		const sql = '  SELECT a, FROM t';
		driver.prepareFails = (text) =>
			text.includes('FROM') ? new Error('near "FROM": syntax error') : null;
		await expect(runSqliteQuery({ handle: 'h1', sql, plan: true })).rejects.toMatchObject({
			message: 'near "FROM": syntax error',
			offset: sql.indexOf('FROM'),
		});
		expect(driver.instances[0].prepared[0]).toBe('EXPLAIN QUERY PLAN SELECT a, FROM t');
	});

	it('runs a statement that returns no rows on its own connection, and says so', async () => {
		driver.statement.reader = false;
		const result = await runSqliteQuery({ handle: 'h1', sql: 'PRAGMA trusted_schema = ON' });
		expect(result).toMatchObject({
			statement: 'PRAGMA',
			columns: [],
			rows: [],
			hasMore: false,
			returnsRows: false,
		});
		expect(driver.ran).toBe(1);
		expect(driver.instances[0].closed).toBe(true);
	});

	it('binds parameter values through the driver, never into the text', async () => {
		const sql = 'SELECT * FROM users WHERE id = ? OR name = :name';
		await runSqliteQuery({
			handle: 'h1',
			sql,
			params: {
				'?1': { type: 'number', text: '9007199254740993' },
				':name': { type: 'text', text: "o'brien" },
			},
		});
		expect(driver.instances[0].prepared).toEqual([sql]);
		expect(driver.boundArgs?.[0]).toEqual([9007199254740993n]);
		expect({ ...(driver.boundArgs?.[1] as object) }).toEqual({ name: "o'brien" });
	});

	it('binds the same values again for a later window', async () => {
		const params = { ':n': { type: 'null' as const, text: '' } };
		driver.statement.rows = numbered(4);
		await runSqliteQuery({ handle: 'h1', sql: 'SELECT :n', params, offset: 2, limit: 1 });
		expect({ ...(driver.boundArgs?.[0] as object) }).toEqual({ n: null });
	});

	it('binds values to a statement that returns no rows too', async () => {
		driver.statement.reader = false;
		await runSqliteQuery({
			handle: 'h1',
			sql: 'PRAGMA cache_size = :size',
			params: { ':size': { type: 'number', text: '10' } },
		});
		expect(driver.ran).toBe(1);
		expect({ ...(driver.boundArgs?.[0] as object) }).toEqual({ size: 10 });
	});

	it('refuses a parameter with no usable value without opening a connection', async () => {
		await expect(
			runSqliteQuery({ handle: 'h1', sql: 'SELECT * FROM t WHERE id = :id' })
		).rejects.toMatchObject({ message: 'Give :id a value.', code: SQLITE_QUERY_REFUSED });
		await expect(
			runSqliteQuery({
				handle: 'h1',
				sql: 'SELECT ?',
				params: { '?1': { type: 'number', text: 'ten' } },
			})
		).rejects.toMatchObject({ code: SQLITE_QUERY_REFUSED });
		expect(driver.instances).toHaveLength(0);
	});

	it("runs a plan as the statement's EXPLAIN QUERY PLAN, binding the statement's parameters", async () => {
		driver.statement.columns = [
			{ name: 'id', type: null },
			{ name: 'parent', type: null },
			{ name: 'notused', type: null },
			{ name: 'detail', type: null },
		];
		driver.statement.rows = [[BigInt(2), BigInt(0), BigInt(0), 'SEARCH t USING INDEX tb (b=?)']];
		const result = await runSqliteQuery({
			handle: 'h1',
			sql: '  SELECT * FROM t WHERE b = :b  ',
			params: { ':b': { type: 'text', text: 'x' } },
			plan: true,
		});
		expect(driver.instances[0].prepared).toEqual([
			'EXPLAIN QUERY PLAN SELECT * FROM t WHERE b = :b',
		]);
		expect({ ...(driver.boundArgs?.[0] as object) }).toEqual({ b: 'x' });
		expect(result).toMatchObject({
			statement: 'SELECT',
			plan: true,
			rows: [[2, 0, 0, 'SEARCH t USING INDEX tb (b=?)']],
		});
		expect(driver.instances[0].closed).toBe(true);
	});

	it('leaves the plan flag off a plain run', async () => {
		const result = await runSqliteQuery({ handle: 'h1', sql: 'SELECT 1', plan: false });
		expect(result.plan).toBeUndefined();
		expect(driver.instances[0].prepared).toEqual(['SELECT 1']);
	});

	it('refuses to plan a write or an EXPLAIN without opening a connection', async () => {
		await expect(
			runSqliteQuery({ handle: 'h1', sql: 'DELETE FROM users', plan: true })
		).rejects.toMatchObject({ code: SQLITE_QUERY_REFUSED });
		await expect(
			runSqliteQuery({ handle: 'h1', sql: 'EXPLAIN SELECT 1', plan: true })
		).rejects.toMatchObject({
			message: SQLITE_PLAN_OF_EXPLAIN_MESSAGE,
			code: SQLITE_QUERY_REFUSED,
		});
		expect(driver.instances).toHaveLength(0);
	});

	it('refuses the plan of a write behind a read keyword when the driver says so', async () => {
		driver.statement.readonly = false;
		await expect(
			runSqliteQuery({ handle: 'h1', sql: 'WITH x AS (SELECT 1) DELETE FROM users', plan: true })
		).rejects.toMatchObject({ message: SQLITE_NOT_READ_ONLY_MESSAGE });
	});

	it('rejects a plan flag that is not a boolean', async () => {
		await expect(
			runSqliteQuery({ handle: 'h1', sql: 'SELECT 1', plan: 'yes' as unknown as boolean })
		).rejects.toThrow('SQLite query plan must be true or false.');
	});

	it('rejects params that are not an object keyed by parameter', async () => {
		await expect(
			runSqliteQuery({
				handle: 'h1',
				sql: 'SELECT ?',
				params: ['x'] as unknown as Record<string, never>,
			})
		).rejects.toThrow('SQLite query params must be an object keyed by parameter.');
	});

	it('clamps the limit and refuses a bad window or a closed handle', async () => {
		driver.statement.rows = numbered(1200);
		const result = await runSqliteQuery({ handle: 'h1', sql: 'SELECT 1', limit: 5000 });
		expect(result.rows).toHaveLength(1000);
		expect(result.hasMore).toBe(true);

		expect(() => runSqliteQuery({ handle: 'h1', sql: 'SELECT 1', offset: -1 })).toThrow(
			'non-negative'
		);
		expect(() => runSqliteQuery({ handle: 'gone', sql: 'SELECT 1' })).toThrow('no longer open');
	});

	it('stops a run by id, and only once', async () => {
		const run = runSqliteQuery({ handle: 'h1', sql: 'SELECT 1', queryId: 'q1' });
		expect(cancelSqliteQuery('q1')).toBe(true);
		await expect(run).rejects.toThrow(SQLITE_QUERY_STOPPED_MESSAGE);
		expect(cancelSqliteQuery('q1')).toBe(false);
		expect(releaseHooks.size).toBe(0);
	});

	it('stops the older run when a newer one starts under the same id', async () => {
		const first = runSqliteQuery({ handle: 'h1', sql: 'SELECT 1', queryId: 'q1' });
		const second = runSqliteQuery({ handle: 'h1', sql: 'SELECT 2', queryId: 'q1' });
		await expect(first).rejects.toThrow(SQLITE_QUERY_STOPPED_MESSAGE);
		await expect(second).resolves.toMatchObject({ statement: 'SELECT' });
		expect(cancelSqliteQuery('q1')).toBe(false);
	});

	it('stops when its database is released', async () => {
		const run = runSqliteQuery({ handle: 'h1', sql: 'SELECT 1' });
		expect(releaseHooks.size).toBe(1);
		for (const hook of [...releaseHooks]) hook();
		await expect(run).rejects.toThrow(/database was closed/);
	});

	it('clears its timeout once the run settles', async () => {
		vi.useFakeTimers();
		const run = runSqliteQuery({ handle: 'h1', sql: 'SELECT 1' });
		expect(vi.getTimerCount()).toBe(1);
		await run;
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe('runSqliteQuery history', () => {
	beforeEach(() => {
		driver.instances = [];
		driver.statement = {
			readonly: true,
			reader: true,
			columns: [{ name: 'id', type: 'INTEGER' }],
			rows: numbered(3),
			prepareError: null,
		};
		releaseHooks.clear();
		history.record.mockClear();
		history.record.mockImplementation(async () => undefined);
	});

	it("records a first window's run with its values and numbers, before it answers", async () => {
		let recordedBeforeAnswer = false;
		const result = await runSqliteQuery({
			handle: 'h1',
			sql: 'SELECT id FROM t WHERE id > :min',
			params: { ':min': { type: 'number', text: '0' } },
			limit: 2,
		}).then((value) => {
			recordedBeforeAnswer = history.record.mock.calls.length === 1;
			return value;
		});
		expect(result.rows).toHaveLength(2);
		expect(recordedBeforeAnswer).toBe(true);
		expect(history.record).toHaveBeenCalledWith('/data/app.db', {
			sql: 'SELECT id FROM t WHERE id > :min',
			plan: false,
			params: { ':min': { type: 'number', text: '0' } },
			ranAt: expect.any(Number),
			outcome: {
				ok: true,
				rows: 2,
				hasMore: true,
				returnsRows: true,
				elapsedMs: expect.any(Number),
			},
		});
	});

	it('records a plan as a plan', async () => {
		await runSqliteQuery({ handle: 'h1', sql: 'SELECT 1', plan: true });
		expect(history.record.mock.calls[0][1]).toMatchObject({ plan: true });
	});

	it('does not record a later window', async () => {
		await runSqliteQuery({ handle: 'h1', sql: 'SELECT id FROM t', offset: 1 });
		expect(history.record).not.toHaveBeenCalled();
	});

	it('records a failure with its message, and not a refusal', async () => {
		driver.statement.prepareError = new Error('no such table: nope');
		await expect(runSqliteQuery({ handle: 'h1', sql: 'SELECT * FROM nope' })).rejects.toThrow(
			'no such table'
		);
		expect(history.record.mock.calls[0][1]).toMatchObject({
			outcome: { ok: false, error: 'no such table: nope' },
		});

		history.record.mockClear();
		await expect(runSqliteQuery({ handle: 'h1', sql: 'DELETE FROM t' })).rejects.toThrow();
		expect(history.record).not.toHaveBeenCalled();
	});

	it('still answers when the history cannot be written', async () => {
		history.record.mockImplementation(async () => {
			throw new Error('disk full');
		});
		await expect(runSqliteQuery({ handle: 'h1', sql: 'SELECT 1' })).resolves.toMatchObject({
			statement: 'SELECT',
		});
	});
});

describe('exportSqliteQuery', () => {
	let dir: string;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-sqlite-export-'));
		driver.instances = [];
		driver.statement = {
			readonly: true,
			reader: true,
			columns: [
				{ name: 'id', type: 'INTEGER' },
				{ name: 'note', type: 'TEXT' },
				{ name: 'data', type: 'BLOB' },
			],
			rows: [
				[BigInt('9007199254740993'), 'a, "b"', Buffer.from([0, 255])],
				[BigInt(2), 'z'.repeat(SQLITE_CELL_TEXT_LIMIT + 5), null],
			],
			prepareError: null,
		};
		driver.flags = [];
		driver.boundArgs = null;
		driver.prepareFails = null;
		releaseHooks.clear();
		history.record.mockClear();
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it('writes every row whole as CSV, through a temporary file, on its own connection', async () => {
		const destPath = path.join(dir, 'nested', 'out.csv');
		const exported = await exportSqliteQuery({ handle: 'h1', sql: 'SELECT * FROM t', destPath });
		expect(exported).toMatchObject({ path: destPath, format: 'csv', rows: 2, columns: 3 });

		const text = await fs.readFile(destPath, 'utf8');
		const long = 'z'.repeat(SQLITE_CELL_TEXT_LIMIT + 5);
		expect(text).toBe(`id,note,data\n9007199254740993,"a, ""b""",00ff\n2,${long},\n`);
		expect(exported.bytes).toBe(Buffer.byteLength(text));
		expect(await fs.readdir(path.dirname(destPath))).toEqual(['out.csv']);
		expect(driver.instances[0].options).toMatchObject({ readonly: true });
		expect(driver.instances[0].closed).toBe(true);
		expect(driver.flags).toContain('safeIntegers');
		// An export is the statement already run: it is not a new history entry.
		expect(history.record).not.toHaveBeenCalled();
	});

	it('writes JSON Lines for a .jsonl destination, binding the parameters', async () => {
		const destPath = path.join(dir, 'out.jsonl');
		await exportSqliteQuery({
			handle: 'h1',
			sql: 'SELECT * FROM t WHERE id > :min',
			params: { ':min': { type: 'number', text: '0' } },
			destPath,
		});
		expect({ ...(driver.boundArgs?.[0] as object) }).toEqual({ min: 0 });
		const lines = (await fs.readFile(destPath, 'utf8')).trim().split('\n');
		expect(lines[0]).toBe('{"id":9007199254740993,"note":"a, \\"b\\"","data":"00ff"}');
		expect(JSON.parse(lines[1])).toMatchObject({ id: 2, data: null });
	});

	it('replaces an existing file only once the export succeeds, and leaves nothing on failure', async () => {
		const destPath = path.join(dir, 'kept.csv');
		await fs.writeFile(destPath, 'OLD');
		driver.statement.prepareError = new Error('no such column: nope');
		await expect(
			exportSqliteQuery({ handle: 'h1', sql: 'SELECT nope FROM t', destPath })
		).rejects.toThrow('no such column');
		expect(await fs.readFile(destPath, 'utf8')).toBe('OLD');
		expect(await fs.readdir(dir)).toEqual(['kept.csv']);
	});

	it('refuses a write and a statement that returns no rows', async () => {
		const destPath = path.join(dir, 'out.csv');
		await expect(
			exportSqliteQuery({ handle: 'h1', sql: 'DELETE FROM t', destPath })
		).rejects.toThrow(/read-only/);
		expect(driver.instances).toHaveLength(0);

		driver.statement.reader = false;
		await expect(
			exportSqliteQuery({ handle: 'h1', sql: 'PRAGMA trusted_schema = ON', destPath })
		).rejects.toThrow(SQLITE_EXPORT_NO_ROWS_MESSAGE);
		expect(await fs.readdir(dir)).toEqual([]);
	});

	it('rejects a relative destination, an unknown format, bad params, and a closed handle', async () => {
		await expect(
			exportSqliteQuery({ handle: 'h1', sql: 'SELECT 1', destPath: 'out.csv' })
		).rejects.toThrow(/absolute path/);
		await expect(
			exportSqliteQuery({
				handle: 'h1',
				sql: 'SELECT 1',
				destPath: path.join(dir, 'x'),
				format: 'xml' as never,
			})
		).rejects.toThrow(/"csv" or "jsonl"/);
		await expect(
			exportSqliteQuery({
				handle: 'h1',
				sql: 'SELECT 1',
				destPath: path.join(dir, 'x'),
				params: [] as never,
			})
		).rejects.toThrow(/object keyed by parameter/);
		await expect(
			exportSqliteQuery({ handle: 'gone', sql: 'SELECT 1', destPath: path.join(dir, 'x') })
		).rejects.toThrow('no longer open');
	});

	it('stops an export by id in its own words, leaving no file', async () => {
		const exported = exportSqliteQuery({
			handle: 'h1',
			sql: 'SELECT * FROM t',
			destPath: path.join(dir, 'stopped.csv'),
			queryId: 'e1',
		});
		expect(cancelSqliteQuery('e1')).toBe(true);
		await expect(exported).rejects.toThrow(SQLITE_EXPORT_STOPPED_MESSAGE);
		expect(cancelSqliteQuery('e1')).toBe(false);
		await expect(fs.stat(path.join(dir, 'stopped.csv'))).rejects.toMatchObject({
			code: 'ENOENT',
		});
	});
});
