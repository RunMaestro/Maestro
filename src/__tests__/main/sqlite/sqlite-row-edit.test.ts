import { beforeEach, describe, expect, it, vi } from 'vitest';

// better-sqlite3's native binary is built for Electron's ABI and does not load
// under vitest, so both connections are fakes that answer the statements
// sqlite-row-edit.ts prepares: `SELECT *` for the columns, the UPDATE with its
// RETURNING, and the read-back. The editing gate and the backup have their own
// tests (sqlite-editing.test.ts, sqlite-backup.test.ts), so they are mocks
// here; the identity's key condition and the row reader's select list stay real.
interface FakeConnection {
	prepared: string[];
	/** Arguments each UPDATE ran with. */
	updates: unknown[][];
	/** Arguments each read-back ran with. */
	reads: unknown[][];
	committed: number;
	rolledBack: number;
}

const state = vi.hoisted(() => ({
	objects: [] as unknown[],
	editability: {} as Record<string, unknown>,
	columns: [] as Array<{ name: string; type: string | null }>,
	/**
	 * What the UPDATE's RETURNING gives (the key, then `typeof(column)` and the
	 * column as stored), the error SQLite raises, or a function of the UPDATE's
	 * arguments.
	 */
	returning: [] as unknown[][] | Error | ((args: unknown[]) => unknown[][]),
	/** The row the read-back finds (value/length pairs), or none. */
	readBack: undefined as unknown[] | undefined,
	backupCreated: false,
	locked: false,
	beginCalls: 0,
	connections: {} as Record<'readOnly' | 'writable', FakeConnection>,
}));

function fakeDb(which: 'readOnly' | 'writable') {
	const connection = state.connections[which];
	const db = {
		prepare(sql: string) {
			connection.prepared.push(sql);
			if (sql.startsWith('SELECT * FROM ')) {
				return { columns: () => state.columns };
			}
			const statement = {
				raw: () => statement,
				safeIntegers: () => statement,
				all(...args: unknown[]) {
					connection.updates.push(args);
					if (state.returning instanceof Error) throw state.returning;
					if (typeof state.returning === 'function') return state.returning(args);
					return state.returning;
				},
				get(...args: unknown[]) {
					connection.reads.push(args);
					return state.readBack;
				},
			};
			return statement;
		},
		transaction(fn: () => unknown) {
			return () => {
				try {
					const result = fn();
					connection.committed++;
					return result;
				} catch (error) {
					connection.rolledBack++;
					throw error;
				}
			};
		},
	};
	return db;
}

vi.mock('../../../main/sqlite/sqlite-editing', () => ({
	requireSqliteEditing: (handle: string, editToken: unknown) => {
		if (state.locked || editToken !== 'token') throw new Error('Editing is not enabled.');
		return { db: fakeDb('readOnly'), displayPath: '/data/app.db', handle };
	},
	beginSqliteWrite: async () => {
		state.beginCalls++;
		return {
			database: { displayPath: '/data/app.db' },
			db: fakeDb('writable'),
			backup: { path: '/data/app.maestro-backup-x.db', bytes: 4096, createdAt: 1 },
			backupCreated: state.backupCreated,
		};
	},
}));

vi.mock('../../../main/sqlite/sqlite-objects', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../main/sqlite/sqlite-objects')>()),
	readSqliteObjectSummaries: () => state.objects,
}));

vi.mock('../../../main/sqlite/sqlite-identity', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../main/sqlite/sqlite-identity')>()),
	resolveSqliteEditability: (_db: unknown, object: { name: string }) =>
		state.editability[object.name],
}));

import { updateSqliteCell } from '../../../main/sqlite/sqlite-row-edit';
import type { SqliteCellUpdateRequest } from '../../../shared/sqlite/types';

function summary(name: string, kind: 'table' | 'view' = 'table') {
	return {
		name,
		kind,
		tableName: name,
		internal: false,
		countable: kind === 'table',
		hasStorage: kind === 'table',
		...(kind === 'table' ? { tableType: 'table', withoutRowid: false, strict: false } : {}),
	};
}

/** SQLite's `typeof()` of a bound value, as a column with no affinity stores it. */
function storedType(value: unknown): string {
	if (value === null) return 'null';
	if (typeof value === 'bigint') return 'integer';
	if (typeof value === 'number') return 'real';
	return 'text';
}

/** A RETURNING that stores the bound value as given, under this key. */
function storedAsGiven(...key: unknown[]) {
	return (args: unknown[]) => [[...key, storedType(args[0]), args[0]]];
}

function connection(): FakeConnection {
	return { prepared: [], updates: [], reads: [], committed: 0, rolledBack: 0 };
}

function request(extra: Partial<SqliteCellUpdateRequest> = {}): SqliteCellUpdateRequest {
	return {
		handle: 'h1',
		editToken: 'token',
		name: 'users',
		column: 'email',
		row: { kind: 'rowid', rowid: '7' },
		value: { type: 'text', text: 'new@example.com' },
		...extra,
	};
}

beforeEach(() => {
	state.objects = [summary('users'), summary('members'), summary('active', 'view')];
	state.editability = {
		users: {
			editable: true,
			identity: { kind: 'rowid', alias: 'rowid', rowidColumn: 'id' },
			readOnlyColumns: [{ name: 'domain', reason: 'domain is a generated column.' }],
		},
		members: {
			editable: true,
			identity: { kind: 'primary-key', columns: ['org', 'name'], keyMayBeNull: true },
			readOnlyColumns: [],
		},
		active: { editable: false, code: 'view', reason: 'active is a view.' },
	};
	state.columns = [
		{ name: 'id', type: 'INTEGER' },
		{ name: 'email', type: 'TEXT' },
		{ name: 'domain', type: 'TEXT' },
	];
	state.returning = storedAsGiven(7n);
	state.readBack = [7n, null, 'new@example.com', 15n, 'example.com', 11n];
	state.backupCreated = false;
	state.locked = false;
	state.beginCalls = 0;
	state.connections = { readOnly: connection(), writable: connection() };
});

describe('updateSqliteCell', () => {
	it('runs one parameterised UPDATE keyed on the rowid and returns the row as stored', async () => {
		const result = await updateSqliteCell(request());
		const writable = state.connections.writable;
		expect(writable.prepared).toContain(
			'UPDATE "users" SET "email" = ? WHERE "rowid" = ? RETURNING "rowid", typeof("email"), "email"'
		);
		expect(writable.updates).toEqual([['new@example.com', 7n]]);
		expect(writable.reads).toEqual([[7n]]);
		expect(writable.committed).toBe(1);
		expect(result).toEqual({
			name: 'users',
			column: 'email',
			columns: [
				{ name: 'id', declaredType: 'INTEGER' },
				{ name: 'email', declaredType: 'TEXT' },
				{ name: 'domain', declaredType: 'TEXT' },
			],
			row: [7, 'new@example.com', 'example.com'],
			key: { kind: 'rowid', rowid: '7' },
			elapsedMs: expect.any(Number),
		});
		expect(result.backup).toBeUndefined();
		// Nothing was written on the read-only connection; it only checked.
		expect(state.connections.readOnly.updates).toEqual([]);
	});

	it('binds a number or NULL as one, never spliced into the SQL', async () => {
		state.returning = (args) => [[args[0] ?? 7n, storedType(args[0]), args[0]]];
		await updateSqliteCell(
			request({ column: 'id', value: { type: 'number', text: '9007199254740993' } })
		);
		await updateSqliteCell(request({ value: { type: 'null', text: 'ignored' } }));
		expect(state.connections.writable.updates.map((args) => args[0])).toEqual([
			9007199254740993n,
			null,
		]);
		expect(
			state.connections.writable.prepared.some((sql) => sql.includes('9007199254740993'))
		).toBe(false);
	});

	it('announces the backup only on the write that took it', async () => {
		state.backupCreated = true;
		const result = await updateSqliteCell(request());
		expect(result.backup).toEqual({
			path: '/data/app.maestro-backup-x.db',
			bytes: 4096,
			createdAt: 1,
		});
	});

	it('re-keys the row when the edit changed the INTEGER PRIMARY KEY that is its rowid', async () => {
		state.returning = [[99n, 'integer', 99n]];
		state.readBack = [99n, null, 'a@b.c', 5n, 'b.c', 3n];
		const result = await updateSqliteCell(
			request({ column: 'id', value: { type: 'number', text: '99' } })
		);
		expect(result.key).toEqual({ kind: 'rowid', rowid: '99' });
		// The row is read back by its NEW rowid.
		expect(state.connections.writable.reads).toEqual([[99n]]);
		expect(result.row[0]).toBe(99);
	});

	it('names a row by every primary-key column and returns its key whole', async () => {
		state.columns = [
			{ name: 'org', type: 'INTEGER' },
			{ name: 'name', type: 'TEXT' },
			{ name: 'role', type: 'TEXT' },
		];
		state.returning = [[3n, 'ada', 'text', 'admin']];
		state.readBack = [3n, null, 'ada', 3n, 'admin', 5n];
		const result = await updateSqliteCell(
			request({
				name: 'members',
				column: 'role',
				row: {
					kind: 'primary-key',
					values: { name: { type: 'text', text: 'ada' }, org: { type: 'integer', text: '3' } },
				},
				value: { type: 'text', text: 'admin' },
			})
		);
		expect(state.connections.writable.prepared).toContain(
			'UPDATE "members" SET "role" = ? WHERE "org" = ? AND "name" = ? RETURNING "org", "name", typeof("role"), "role"'
		);
		expect(state.connections.writable.updates).toEqual([['admin', 3n, 'ada']]);
		expect(result.key).toEqual({
			kind: 'primary-key',
			values: { org: { type: 'integer', text: '3' }, name: { type: 'text', text: 'ada' } },
		});
		expect(result.row).toEqual([3, 'ada', 'admin']);
	});

	it('rolls back, and says so, when no row has the key any more', async () => {
		state.returning = [];
		await expect(updateSqliteCell(request())).rejects.toThrow(
			'users has no row with rowid 7: it was deleted or its key changed since it was read. Nothing was changed; reload the table.'
		);
		expect(state.connections.writable.rolledBack).toBe(1);
		expect(state.connections.writable.committed).toBe(0);
	});

	it('rolls back a change that matched more than one row', async () => {
		state.returning = [[7n], [8n]];
		await expect(updateSqliteCell(request())).rejects.toThrow('matched 2 rows of users');
		expect(state.connections.writable.rolledBack).toBe(1);
	});

	it('rolls back a change that would leave the key holding NULL', async () => {
		state.columns = [
			{ name: 'org', type: 'INTEGER' },
			{ name: 'name', type: 'TEXT' },
		];
		state.returning = [[null, 'ada', 'null', null]];
		await expect(
			updateSqliteCell(
				request({
					name: 'members',
					column: 'org',
					row: {
						kind: 'primary-key',
						values: { org: { type: 'integer', text: '3' }, name: { type: 'text', text: 'ada' } },
					},
					value: { type: 'null', text: '' },
				})
			)
		).rejects.toThrow('would leave the row with no key to name it by, so nothing was changed');
		expect(state.connections.writable.rolledBack).toBe(1);
	});

	it('binds a whole number as an INTEGER, so a column with no affinity keeps it whole', async () => {
		state.returning = storedAsGiven(20n);
		await updateSqliteCell(request({ column: 'id', value: { type: 'number', text: ' 20 ' } }));
		state.returning = storedAsGiven(1000n);
		await updateSqliteCell(request({ column: 'id', value: { type: 'number', text: '1e3' } }));
		state.returning = storedAsGiven(7n);
		await updateSqliteCell(request({ value: { type: 'number', text: '2.5' } }));
		expect(state.connections.writable.updates.map((args) => args[0])).toEqual([20n, 1000, 2.5]);
	});

	it('rolls back text the column affinity would have turned into a number', async () => {
		state.columns = [
			{ name: 'id', type: 'INTEGER' },
			{ name: 'zip', type: 'INT' },
		];
		state.returning = [[7n, 'integer', 7n]];
		await expect(
			updateSqliteCell(request({ column: 'zip', value: { type: 'text', text: '007' } }))
		).rejects.toThrow(
			"zip has INTEGER affinity, so SQLite would store the text '007' as the integer 7. Nothing was changed; to store a number, give it as a number."
		);
		expect(state.connections.writable.rolledBack).toBe(1);
		expect(state.connections.writable.committed).toBe(0);
		// The row was never read back: the change did not stand.
		expect(state.connections.writable.reads).toEqual([]);
	});

	it('rolls back a number a TEXT column would have stored as text', async () => {
		state.returning = [[7n, 'text', '42']];
		await expect(
			updateSqliteCell(request({ value: { type: 'number', text: '42' } }))
		).rejects.toThrow(
			"email has TEXT affinity, so SQLite would store the number 42 as the text '42'. Nothing was changed; to store text, give it as text."
		);
		expect(state.connections.writable.rolledBack).toBe(1);
	});

	it('reads the affinity of a STRICT table from its declared types', async () => {
		state.objects = [{ ...summary('users'), strict: true }];
		state.columns = [
			{ name: 'id', type: 'INTEGER' },
			{ name: 'extra', type: 'ANY' },
		];
		state.returning = [[7n, 'integer', 7n]];
		// ANY in a STRICT table converts nothing (BLOB affinity), and says so.
		await expect(
			updateSqliteCell(request({ column: 'extra', value: { type: 'text', text: '7' } }))
		).rejects.toThrow('extra has BLOB affinity');
	});

	it("passes SQLite's own refusal through verbatim, with nothing committed", async () => {
		state.returning = new Error('UNIQUE constraint failed: users.email');
		await expect(updateSqliteCell(request())).rejects.toThrow(
			'UNIQUE constraint failed: users.email'
		);
		expect(state.connections.writable.committed).toBe(0);
	});

	it('refuses before the backup what it would refuse anyway', async () => {
		await expect(updateSqliteCell(request({ name: 'active' }))).rejects.toThrow(
			'active is a view.'
		);
		await expect(updateSqliteCell(request({ column: 'domain' }))).rejects.toThrow(
			'domain is a generated column.'
		);
		await expect(updateSqliteCell(request({ column: 'nope' }))).rejects.toThrow(
			'users has no column named nope.'
		);
		await expect(updateSqliteCell(request({ name: 'gone' }))).rejects.toThrow(
			'No table is named gone.'
		);
		await expect(
			updateSqliteCell(request({ row: { kind: 'rowid', rowid: '7; DROP TABLE users' } }))
		).rejects.toThrow('Not a rowid');
		await expect(
			updateSqliteCell(
				request({
					name: 'members',
					// A column the fake table has, so the key is what is refused.
					column: 'email',
					row: {
						kind: 'primary-key',
						values: { org: null, name: { type: 'text', text: 'ada' } },
					},
				})
			)
		).rejects.toThrow("This row's primary key holds NULL in org");
		await expect(
			updateSqliteCell(request({ value: { type: 'number', text: 'abc' } }))
		).rejects.toThrow('email is set to Number, but "abc" is not a number.');
		await expect(
			updateSqliteCell(request({ value: { type: 'number', text: '1e400' } }))
		).rejects.toThrow(
			'email is set to Number, but 1e400 is too large for SQLite to store as a number.'
		);
		await expect(
			updateSqliteCell(request({ column: 'id', value: { type: 'number', text: '2.5' } }))
		).rejects.toThrow(
			"id is the table's INTEGER PRIMARY KEY, which is each row's rowid, so it holds only whole numbers; 2.5 is not one. Nothing was changed."
		);
		await expect(
			updateSqliteCell(request({ column: 'id', value: { type: 'null', text: '' } }))
		).rejects.toThrow('never NULL.');
		expect(state.beginCalls).toBe(0);
		expect(state.connections.writable.prepared).toEqual([]);
	});

	it('refuses a tab that does not hold the unlock, before anything else', async () => {
		state.locked = true;
		await expect(updateSqliteCell(request())).rejects.toThrow('Editing is not enabled.');
		await expect(updateSqliteCell(request({ editToken: 'forged' }))).rejects.toThrow(
			'Editing is not enabled.'
		);
		expect(state.beginCalls).toBe(0);
	});

	it('checks the edit again on the writable connection', async () => {
		await updateSqliteCell(request());
		expect(state.connections.readOnly.prepared).toEqual(['SELECT * FROM "users"']);
		expect(state.connections.writable.prepared[0]).toBe('SELECT * FROM "users"');
	});

	it('needs a table and a column name', async () => {
		await expect(updateSqliteCell(request({ name: '' }))).rejects.toThrow(
			'A cell edit needs the table name.'
		);
		await expect(updateSqliteCell(request({ column: '' }))).rejects.toThrow(
			'A cell edit needs the column name.'
		);
	});
});
