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
				iterate() {
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
				run: () => {
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

import { cancelSqliteQuery, runSqliteQuery } from '../../../main/sqlite/sqlite-query';
import { SQLITE_QUERY_REFUSED } from '../../../main/sqlite/sqlite-query-task';
import { SQLITE_BUSY_TIMEOUT_MS } from '../../../main/sqlite/sqlite-connection';
import { SQLITE_CELL_TEXT_LIMIT } from '../../../shared/sqlite/cells';
import { SQLITE_REGEXP_FUNCTION } from '../../../shared/sqlite/filter';
import {
	SQLITE_NOT_READ_ONLY_MESSAGE,
	SQLITE_ONE_STATEMENT_MESSAGE,
	SQLITE_QUERY_STOPPED_MESSAGE,
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
		releaseHooks.clear();
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
		await expect(
			runSqliteQuery({ handle: 'h1', sql: 'SELECT * FROM userz' })
		).rejects.toMatchObject({ message: 'no such table: userz', code: 'SQLITE_ERROR' });
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
