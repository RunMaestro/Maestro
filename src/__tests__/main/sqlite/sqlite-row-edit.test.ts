import { beforeEach, describe, expect, it, vi } from 'vitest';

// better-sqlite3's native binary is built for Electron's ABI and does not load
// under vitest, so both connections are fakes that answer the statements
// sqlite-row-edit.ts prepares: `SELECT *` for the columns, the UPDATE,
// INSERT, or DELETE with its RETURNING, `total_changes()`, the read of a
// cell's old value before an UPDATE, and the read-back. The editing gate and the backup have their own
// tests (sqlite-editing.test.ts, sqlite-backup.test.ts), so they are mocks
// here; the identity's key condition and the row reader's select list stay real.
interface FakeConnection {
	prepared: string[];
	/** Arguments each UPDATE ran with. */
	updates: unknown[][];
	/** Arguments each read-back ran with. */
	reads: unknown[][];
	/** Arguments each read of a cell's old value (before an UPDATE) ran with. */
	befores: unknown[][];
	/** Arguments each "is the row still there" probe ran with. */
	probes: unknown[][];
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
	/** The row the read-back finds (value/length pairs), or none; its version is appended. */
	readBack: undefined as unknown[] | undefined,
	/** What the read of the edited cell's old value finds (one column), or none. */
	before: undefined as unknown[] | undefined,
	/** Whether a stale write's probe still finds a row by its key. */
	stillThere: false,
	/** What each `SELECT total_changes()` answers, in order (0 when run out). */
	totalChanges: [] as number[],
	backupCreated: false,
	locked: false,
	beginCalls: 0,
	/** What `beginSqliteWrite()` rejects with (the backup or the writable open failing), if anything. */
	beginError: null as unknown,
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
			if (sql === 'SELECT total_changes()') {
				return { pluck: () => ({ get: () => state.totalChanges.shift() ?? 0 }) };
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
					// The old value of the one column an UPDATE is about to change.
					if (/^SELECT "(?:[^"]|"")*" FROM /.test(sql)) {
						connection.befores.push(args);
						return state.before;
					}
					if (sql.startsWith('SELECT 1 FROM ')) {
						connection.probes.push(args);
						return state.stillThere ? [1] : undefined;
					}
					connection.reads.push(args);
					// The read-back selects the row's version last.
					return state.readBack ? [...state.readBack, VERSION_AFTER] : undefined;
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
		if (state.beginError) throw state.beginError;
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

import { describeSqliteBusy } from '../../../main/sqlite/sqlite-connection';
import {
	deleteSqliteRow,
	insertSqliteRow,
	undoSqliteEdit,
	updateSqliteCell,
} from '../../../main/sqlite/sqlite-row-edit';
import type {
	SqliteCellUpdateRequest,
	SqliteRowDeleteRequest,
	SqliteRowInsertRequest,
	SqliteUndoStep,
} from '../../../shared/sqlite/types';

/** The version the fake read-back reports for the row after a write. */
const VERSION_AFTER = 'AfterAfterAfterAfter_1';
/** A version a page carried, as a request sends it back. */
const VERSION_SEEN = 'SeenSeenSeenSeenSeen-2';
/** The version check a write on `users` adds, over its three columns. */
const USERS_VERSION_CHECK = 'maestro_row_version("id", "email", "domain") = ?';

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
	return {
		prepared: [],
		updates: [],
		reads: [],
		befores: [],
		probes: [],
		committed: 0,
		rolledBack: 0,
	};
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
	state.before = ['old@example.com'];
	state.totalChanges = [];
	state.stillThere = false;
	state.backupCreated = false;
	state.locked = false;
	state.beginCalls = 0;
	state.beginError = null;
	state.connections = { readOnly: connection(), writable: connection() };
});

describe('updateSqliteCell', () => {
	it('runs one parameterised UPDATE keyed on the rowid and returns the row as stored', async () => {
		const result = await updateSqliteCell(request());
		const writable = state.connections.writable;
		expect(writable.prepared).toContain(
			'UPDATE "users" SET "email" = ? WHERE "rowid" = ? RETURNING "rowid", typeof("email"), "email"'
		);
		// The old value is read whole first, in the same transaction, for the undo.
		expect(writable.prepared).toContain('SELECT "email" FROM "users" WHERE "rowid" = ?');
		expect(writable.befores).toEqual([[7n]]);
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
			version: VERSION_AFTER,
			otherChanges: 0,
			undo: {
				kind: 'restore-cell',
				name: 'users',
				column: 'email',
				row: { kind: 'rowid', rowid: '7' },
				version: VERSION_AFTER,
				value: { type: 'text', text: 'old@example.com' },
			},
			elapsedMs: expect.any(Number),
		});
		expect(result.backup).toBeUndefined();
		// Nothing was written on the read-only connection; it only checked.
		expect(state.connections.readOnly.updates).toEqual([]);
	});

	it('keeps the old value whole and typed for the undo, a BLOB and a big INTEGER included', async () => {
		state.before = [Buffer.from([0, 255])];
		const blob = await updateSqliteCell(request());
		expect(blob.undo).toMatchObject({ value: { type: 'blob', text: '00ff' } });
		state.before = [9007199254740993n];
		const big = await updateSqliteCell(request());
		expect(big.undo).toMatchObject({ value: { type: 'integer', text: '9007199254740993' } });
		state.before = [null];
		const nulled = await updateSqliteCell(request());
		expect(nulled.undo).toMatchObject({ value: null });
	});

	it('offers no undo when its triggers or foreign-key actions changed other rows', async () => {
		state.totalChanges = [3, 5];
		const result = await updateSqliteCell(request());
		expect(result.otherChanges).toBe(1);
		expect(result.undo).toBeNull();
	});

	it('runs no UPDATE when the read of the old value finds no row', async () => {
		state.before = undefined;
		await expect(updateSqliteCell(request())).rejects.toThrow(
			'users has no row with rowid 7: it was deleted or its key changed since it was read.'
		);
		expect(state.connections.writable.updates).toEqual([]);
		expect(state.connections.writable.rolledBack).toBe(1);
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
			'users has no row with rowid 7: it was deleted or its key changed since it was read. Nothing was changed. Reload the table to see it as it is now.'
		);
		expect(state.connections.writable.rolledBack).toBe(1);
		expect(state.connections.writable.committed).toBe(0);
		// With no version sent there is nothing to tell apart: no probe.
		expect(state.connections.writable.probes).toEqual([]);
	});

	it('checks the version its page showed in the same WHERE as the key', async () => {
		const result = await updateSqliteCell(request({ version: VERSION_SEEN }));
		const writable = state.connections.writable;
		expect(writable.prepared).toContain(
			`UPDATE "users" SET "email" = ? WHERE "rowid" = ? AND ${USERS_VERSION_CHECK} RETURNING "rowid", typeof("email"), "email"`
		);
		expect(writable.updates).toEqual([['new@example.com', 7n, VERSION_SEEN]]);
		// The read-back reports the version after the change, for the next edit.
		expect(
			writable.prepared.some(
				(sql) =>
					sql.startsWith('SELECT ') &&
					sql.includes(`maestro_row_version("id", "email", "domain") FROM "users"`)
			)
		).toBe(true);
		expect(result.version).toBe(VERSION_AFTER);
	});

	it('changes nothing, and says the row changed, when it no longer has the version', async () => {
		state.returning = [];
		state.stillThere = true;
		await expect(updateSqliteCell(request({ version: VERSION_SEEN }))).rejects.toThrow(
			'The row of users with rowid 7 changed since it was read: another tab, another program, or a trigger wrote to it. Nothing was changed. Reload the table to see it as it is now.'
		);
		const writable = state.connections.writable;
		expect(writable.probes).toEqual([[7n]]);
		expect(writable.rolledBack).toBe(1);
		expect(writable.committed).toBe(0);
	});

	it('says the row is gone, not changed, when no row has the key any more', async () => {
		state.returning = [];
		state.stillThere = false;
		await expect(updateSqliteCell(request({ version: VERSION_SEEN }))).rejects.toThrow(
			'users has no row with rowid 7: it was deleted or its key changed since it was read.'
		);
	});

	it('refuses a version that is not one, before the backup', async () => {
		await expect(updateSqliteCell(request({ version: 'nope' }))).rejects.toThrow(
			'is not a row version'
		);
		expect(state.beginCalls).toBe(0);
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

	it('says another process has the database open when SQLite reports it busy', async () => {
		state.returning = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
		const failure = updateSqliteCell(request());
		await expect(failure).rejects.toThrow(
			'Another process has this database open and kept it locked past the 1 s wait, so nothing was changed.'
		);
		await expect(failure).rejects.toMatchObject({ code: 'SQLITE_BUSY' });
		expect(state.connections.writable.committed).toBe(0);
	});

	it('says the same when the writable connection could not open for the lock', async () => {
		state.beginError = Object.assign(new Error('Another process has /data/app.db open'), {
			code: 'SQLITE_BUSY',
		});
		await expect(updateSqliteCell(request())).rejects.toThrow(
			'Another process has this database open and kept it locked past the 1 s wait, so nothing was changed.'
		);
		expect(state.connections.writable.updates).toEqual([]);
	});

	it("keeps the backup's words when the backup was the step the lock refused", async () => {
		state.beginError = describeSqliteBusy(
			Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }),
			'backup'
		);
		await expect(updateSqliteCell(request())).rejects.toThrow(
			'so it could not be backed up before the first change and nothing was written.'
		);
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

function insertRequest(extra: Partial<SqliteRowInsertRequest> = {}): SqliteRowInsertRequest {
	return {
		handle: 'h1',
		editToken: 'token',
		name: 'users',
		values: { email: { type: 'text', text: 'new@example.com' } },
		...extra,
	};
}

function deleteRequest(extra: Partial<SqliteRowDeleteRequest> = {}): SqliteRowDeleteRequest {
	return {
		handle: 'h1',
		editToken: 'token',
		name: 'users',
		row: { kind: 'rowid', rowid: '7' },
		...extra,
	};
}

describe('insertSqliteRow', () => {
	it('runs one parameterised INSERT and returns the row as stored, read back by its new key', async () => {
		state.returning = [[12n, 'text', 'new@example.com']];
		state.readBack = [12n, null, 'new@example.com', 15n, 'example.com', 11n];
		state.totalChanges = [4, 5];
		const result = await insertSqliteRow(insertRequest());
		const writable = state.connections.writable;
		expect(writable.prepared).toContain(
			'INSERT INTO "users" ("email") VALUES (?) RETURNING "rowid", typeof("email"), "email"'
		);
		expect(writable.updates).toEqual([['new@example.com']]);
		expect(writable.reads).toEqual([[12n]]);
		expect(writable.committed).toBe(1);
		expect(result).toEqual({
			name: 'users',
			columns: [
				{ name: 'id', declaredType: 'INTEGER' },
				{ name: 'email', declaredType: 'TEXT' },
				{ name: 'domain', declaredType: 'TEXT' },
			],
			row: [12, 'new@example.com', 'example.com'],
			key: { kind: 'rowid', rowid: '12' },
			version: VERSION_AFTER,
			otherChanges: 0,
			undo: {
				kind: 'remove-row',
				name: 'users',
				row: { kind: 'rowid', rowid: '12' },
				version: VERSION_AFTER,
			},
			elapsedMs: expect.any(Number),
		});
		// Nothing was written on the read-only connection; it only checked.
		expect(state.connections.readOnly.updates).toEqual([]);
	});

	it('leaves every column to its DEFAULT when no value is given', async () => {
		state.returning = [[13n]];
		state.readBack = [13n, null, null, null, null, null];
		const result = await insertSqliteRow(insertRequest({ values: {} }));
		expect(state.connections.writable.prepared).toContain(
			'INSERT INTO "users" DEFAULT VALUES RETURNING "rowid"'
		);
		expect(state.connections.writable.updates).toEqual([[]]);
		expect(result.key).toEqual({ kind: 'rowid', rowid: '13' });
	});

	it('takes NULL in the rowid column as "assign the next rowid", and binds whole numbers as INTEGERs', async () => {
		state.returning = (args) => [[21n, 'integer', 21n, storedType(args[1]), args[1]]];
		state.readBack = [21n, null, null, null, null, null];
		state.columns = [
			{ name: 'id', type: 'INTEGER' },
			{ name: 'score', type: null },
		];
		await insertSqliteRow(
			insertRequest({
				values: { id: { type: 'null', text: '' }, score: { type: 'number', text: '5' } },
			})
		);
		expect(state.connections.writable.updates).toEqual([[null, 5n]]);
	});

	it('counts the rows its triggers and foreign-key actions changed beside it', async () => {
		state.returning = [[12n, 'text', 'new@example.com']];
		state.readBack = [12n, null, 'new@example.com', 15n, 'example.com', 11n];
		state.totalChanges = [10, 13];
		const result = await insertSqliteRow(insertRequest());
		expect(result.otherChanges).toBe(2);
		// Removing the row alone would not take back what the triggers did.
		expect(result.undo).toBeNull();
	});

	it('announces the backup only on the write that took it', async () => {
		state.returning = [[12n, 'text', 'new@example.com']];
		state.readBack = [12n, null, 'new@example.com', 15n, 'example.com', 11n];
		state.backupCreated = true;
		const result = await insertSqliteRow(insertRequest());
		expect(result.backup?.path).toBe('/data/app.maestro-backup-x.db');
	});

	it('names the new row by its whole primary key', async () => {
		state.columns = [
			{ name: 'org', type: 'INTEGER' },
			{ name: 'name', type: 'TEXT' },
		];
		state.returning = [[3n, 'ada', 'integer', 3n, 'text', 'ada']];
		state.readBack = [3n, null, 'ada', 3n];
		const result = await insertSqliteRow(
			insertRequest({
				name: 'members',
				values: { org: { type: 'number', text: '3' }, name: { type: 'text', text: 'ada' } },
			})
		);
		expect(state.connections.writable.prepared).toContain(
			'INSERT INTO "members" ("org", "name") VALUES (?, ?) RETURNING "org", "name", typeof("org"), "org", typeof("name"), "name"'
		);
		expect(result.key).toEqual({
			kind: 'primary-key',
			values: { org: { type: 'integer', text: '3' }, name: { type: 'text', text: 'ada' } },
		});
	});

	it('rolls back a new row whose primary key holds NULL, which no later edit could name', async () => {
		state.columns = [
			{ name: 'org', type: 'INTEGER' },
			{ name: 'name', type: 'TEXT' },
		];
		state.returning = [[null, 'ada', 'text', 'ada']];
		await expect(
			insertSqliteRow(
				insertRequest({ name: 'members', values: { name: { type: 'text', text: 'ada' } } })
			)
		).rejects.toThrow('The new row would have no key to name it by, so nothing was inserted');
		expect(state.connections.writable.rolledBack).toBe(1);
	});

	it('rolls back a value the column affinity converted', async () => {
		state.columns = [
			{ name: 'id', type: 'INTEGER' },
			{ name: 'zip', type: 'INT' },
		];
		state.returning = [[12n, 'integer', 7n]];
		await expect(
			insertSqliteRow(insertRequest({ values: { zip: { type: 'text', text: '007' } } }))
		).rejects.toThrow(
			"zip has INTEGER affinity, so SQLite would store the text '007' as the integer 7. Nothing was inserted; to store a number, give it as a number."
		);
		expect(state.connections.writable.rolledBack).toBe(1);
		expect(state.connections.writable.reads).toEqual([]);
	});

	it('says so when a trigger dropped the row with RAISE(IGNORE)', async () => {
		state.returning = [];
		await expect(insertSqliteRow(insertRequest())).rejects.toThrow(
			'A trigger on users dropped the new row (RAISE(IGNORE)), so nothing was inserted.'
		);
		expect(state.connections.writable.rolledBack).toBe(1);
	});

	it("passes SQLite's constraint failure through verbatim, with nothing committed", async () => {
		state.returning = new Error('NOT NULL constraint failed: users.email');
		await expect(insertSqliteRow(insertRequest())).rejects.toThrow(
			'NOT NULL constraint failed: users.email'
		);
		expect(state.connections.writable.committed).toBe(0);
	});

	it('says another process has the database open when SQLite reports it busy', async () => {
		state.returning = Object.assign(new Error('database is locked'), {
			code: 'SQLITE_BUSY_SNAPSHOT',
		});
		await expect(insertSqliteRow(insertRequest())).rejects.toThrow(
			'Another process has this database open'
		);
		expect(state.connections.writable.committed).toBe(0);
	});

	it('refuses before the backup what it would refuse anyway', async () => {
		await expect(insertSqliteRow(insertRequest({ name: 'active' }))).rejects.toThrow(
			'active is a view.'
		);
		await expect(
			insertSqliteRow(insertRequest({ values: { domain: { type: 'text', text: 'x' } } }))
		).rejects.toThrow('domain is a generated column.');
		await expect(
			insertSqliteRow(insertRequest({ values: { nope: { type: 'text', text: 'x' } } }))
		).rejects.toThrow('users has no column named nope.');
		await expect(
			insertSqliteRow(insertRequest({ values: { id: { type: 'number', text: '2.5' } } }))
		).rejects.toThrow('2.5 is not one. Nothing was inserted.');
		await expect(
			insertSqliteRow(insertRequest({ values: { email: { type: 'number', text: 'abc' } } }))
		).rejects.toThrow('email is set to Number, but "abc" is not a number.');
		await expect(
			insertSqliteRow(insertRequest({ values: [] as unknown as Record<string, never> }))
		).rejects.toThrow('An insert takes its values as an object keyed by column name.');
		await expect(insertSqliteRow(insertRequest({ name: '' }))).rejects.toThrow(
			'An insert needs the table name.'
		);
		expect(state.beginCalls).toBe(0);
		expect(state.connections.writable.prepared).toEqual([]);
	});

	it('refuses a tab that does not hold the unlock', async () => {
		state.locked = true;
		await expect(insertSqliteRow(insertRequest())).rejects.toThrow('Editing is not enabled.');
		expect(state.beginCalls).toBe(0);
	});
});

describe('deleteSqliteRow', () => {
	it('runs one parameterised DELETE keyed on the rowid, returning the row whole for the undo', async () => {
		state.returning = [[7n, 7n, 'a@b.c']];
		state.totalChanges = [2, 3];
		const result = await deleteSqliteRow(deleteRequest());
		const writable = state.connections.writable;
		// Every column an insert can set comes back whole; the generated one does not.
		expect(writable.prepared).toContain(
			'DELETE FROM "users" WHERE "rowid" = ? RETURNING "rowid", "id", "email"'
		);
		expect(writable.updates).toEqual([[7n]]);
		expect(writable.committed).toBe(1);
		expect(result).toEqual({
			name: 'users',
			key: { kind: 'rowid', rowid: '7' },
			otherChanges: 0,
			undo: {
				kind: 'restore-row',
				name: 'users',
				rowid: '7',
				values: { id: { type: 'integer', text: '7' }, email: { type: 'text', text: 'a@b.c' } },
			},
			elapsedMs: expect.any(Number),
		});
		expect(state.connections.readOnly.updates).toEqual([]);
	});

	it('counts the rows ON DELETE CASCADE and triggers removed beside it', async () => {
		state.returning = [[7n]];
		state.totalChanges = [5, 10];
		const result = await deleteSqliteRow(deleteRequest());
		expect(result.otherChanges).toBe(4);
		// The cascaded rows are gone too: putting this one back would not restore them.
		expect(result.undo).toBeNull();
	});

	it('names a row by every primary-key column', async () => {
		state.columns = [
			{ name: 'org', type: 'INTEGER' },
			{ name: 'name', type: 'TEXT' },
		];
		state.returning = [[3n, 'ada', 3n, 'ada']];
		const result = await deleteSqliteRow(
			deleteRequest({
				name: 'members',
				row: {
					kind: 'primary-key',
					values: { name: { type: 'text', text: 'ada' }, org: { type: 'integer', text: '3' } },
				},
			})
		);
		expect(state.connections.writable.prepared).toContain(
			'DELETE FROM "members" WHERE "org" = ? AND "name" = ? RETURNING "org", "name", "org", "name"'
		);
		expect(state.connections.writable.updates).toEqual([[3n, 'ada']]);
		expect(result.key).toEqual({
			kind: 'primary-key',
			values: { org: { type: 'integer', text: '3' }, name: { type: 'text', text: 'ada' } },
		});
	});

	it('rolls back, and says so, when no row has the key any more', async () => {
		state.returning = [];
		await expect(deleteSqliteRow(deleteRequest())).rejects.toThrow(
			'users has no row with rowid 7: it was deleted or its key changed since it was read. Nothing was deleted. Reload the table to see it as it is now.'
		);
		expect(state.connections.writable.rolledBack).toBe(1);
	});

	it('checks the version its page showed in the same WHERE as the key', async () => {
		state.returning = [[7n]];
		await deleteSqliteRow(deleteRequest({ version: VERSION_SEEN }));
		const writable = state.connections.writable;
		expect(writable.prepared).toContain(
			`DELETE FROM "users" WHERE "rowid" = ? AND ${USERS_VERSION_CHECK} RETURNING "rowid", "id", "email"`
		);
		expect(writable.updates).toEqual([[7n, VERSION_SEEN]]);
		expect(writable.committed).toBe(1);
	});

	it('deletes nothing, and says the row changed, when it no longer has the version', async () => {
		state.returning = [];
		state.stillThere = true;
		await expect(deleteSqliteRow(deleteRequest({ version: VERSION_SEEN }))).rejects.toThrow(
			'The row of users with rowid 7 changed since it was read: another tab, another program, or a trigger wrote to it. Nothing was deleted. Reload the table to see it as it is now.'
		);
		expect(state.connections.writable.probes).toEqual([[7n]]);
		expect(state.connections.writable.rolledBack).toBe(1);
	});

	it('rolls back a delete that matched more than one row', async () => {
		state.returning = [[7n], [8n]];
		await expect(deleteSqliteRow(deleteRequest())).rejects.toThrow(
			'matched 2 rows of users, so nothing was deleted'
		);
		expect(state.connections.writable.rolledBack).toBe(1);
	});

	it("passes SQLite's FOREIGN KEY refusal through verbatim, with nothing committed", async () => {
		state.returning = new Error('FOREIGN KEY constraint failed');
		await expect(deleteSqliteRow(deleteRequest())).rejects.toThrow('FOREIGN KEY constraint failed');
		expect(state.connections.writable.committed).toBe(0);
	});

	it('says another process has the database open when SQLite reports it busy', async () => {
		state.returning = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
		await expect(deleteSqliteRow(deleteRequest())).rejects.toThrow(
			'Another process has this database open and kept it locked past the 1 s wait, so nothing was changed.'
		);
		expect(state.connections.writable.committed).toBe(0);
	});

	it('announces the backup only on the write that took it', async () => {
		state.returning = [[7n]];
		state.backupCreated = true;
		const result = await deleteSqliteRow(deleteRequest());
		expect(result.backup?.bytes).toBe(4096);
	});

	it('refuses before the backup what it would refuse anyway', async () => {
		await expect(deleteSqliteRow(deleteRequest({ name: 'active' }))).rejects.toThrow(
			'active is a view.'
		);
		await expect(
			deleteSqliteRow(deleteRequest({ row: { kind: 'rowid', rowid: '7 OR 1=1' } }))
		).rejects.toThrow('Not a rowid');
		await expect(
			deleteSqliteRow(
				deleteRequest({
					name: 'members',
					row: { kind: 'primary-key', values: { org: null, name: { type: 'text', text: 'a' } } },
				})
			)
		).rejects.toThrow("This row's primary key holds NULL in org");
		await expect(deleteSqliteRow(deleteRequest({ name: '' }))).rejects.toThrow(
			'A delete needs the table name.'
		);
		expect(state.beginCalls).toBe(0);
		expect(state.connections.writable.prepared).toEqual([]);
	});

	it('refuses a tab that does not hold the unlock', async () => {
		state.locked = true;
		await expect(deleteSqliteRow(deleteRequest({ editToken: 'forged' }))).rejects.toThrow(
			'Editing is not enabled.'
		);
		expect(state.beginCalls).toBe(0);
	});
});

function undoRequest(step: SqliteUndoStep, editToken = 'token') {
	return { handle: 'h1', editToken, step };
}

describe('undoSqliteEdit', () => {
	const restoreEmail: SqliteUndoStep = {
		kind: 'restore-cell',
		name: 'users',
		column: 'email',
		row: { kind: 'rowid', rowid: '7' },
		version: VERSION_SEEN,
		value: { type: 'text', text: 'old@example.com' },
	};

	it('puts a cell back through the UPDATE path, checking the version the edit left', async () => {
		const result = await undoSqliteEdit(undoRequest(restoreEmail));
		const writable = state.connections.writable;
		expect(writable.prepared).toContain(
			`UPDATE "users" SET "email" = ? WHERE "rowid" = ? AND ${USERS_VERSION_CHECK} RETURNING "rowid", typeof("email"), "email"`
		);
		expect(writable.updates).toEqual([['old@example.com', 7n, VERSION_SEEN]]);
		expect(writable.committed).toBe(1);
		expect(result).toEqual({
			name: 'users',
			kind: 'restore-cell',
			key: { kind: 'rowid', rowid: '7' },
			otherChanges: 0,
			elapsedMs: expect.any(Number),
		});
	});

	it('binds the old value in its own storage class, whole', async () => {
		state.returning = (args) => [[args[0], 'integer', args[0]]];
		await undoSqliteEdit(
			undoRequest({
				...restoreEmail,
				column: 'id',
				value: { type: 'integer', text: '9007199254740993' },
			})
		);
		state.returning = (args) => [[7n, 'blob', args[0]]];
		await undoSqliteEdit(undoRequest({ ...restoreEmail, value: { type: 'blob', text: '00ff' } }));
		const [first, second] = state.connections.writable.updates.map((args) => args[0]);
		expect(first).toBe(9007199254740993n);
		expect(Buffer.isBuffer(second) && (second as Buffer).toString('hex')).toBe('00ff');
	});

	it('refuses, changing nothing, when the column would not store the old value as it was', async () => {
		state.returning = [[7n, 'integer', 5n]];
		await expect(
			undoSqliteEdit(undoRequest({ ...restoreEmail, value: { type: 'text', text: '5' } }))
		).rejects.toThrow('email would not hold its old value as it was');
		expect(state.connections.writable.rolledBack).toBe(1);
	});

	it('refuses an undo over a change made since the edit, like a stale edit', async () => {
		// The version the edit left no longer matches: neither read finds the row.
		state.before = undefined;
		state.stillThere = true;
		await expect(undoSqliteEdit(undoRequest(restoreEmail))).rejects.toThrow(
			'The row of users with rowid 7 changed since it was read'
		);
		expect(state.connections.writable.updates).toEqual([]);
	});

	it('removes an inserted row through the DELETE path, checking its version', async () => {
		state.returning = [[12n, 12n, 'new@example.com']];
		const result = await undoSqliteEdit(
			undoRequest({
				kind: 'remove-row',
				name: 'users',
				row: { kind: 'rowid', rowid: '12' },
				version: VERSION_SEEN,
			})
		);
		const writable = state.connections.writable;
		expect(writable.prepared).toContain(
			`DELETE FROM "users" WHERE "rowid" = ? AND ${USERS_VERSION_CHECK} RETURNING "rowid", "id", "email"`
		);
		expect(writable.updates).toEqual([[12n, VERSION_SEEN]]);
		expect(result).toMatchObject({ kind: 'remove-row', key: { kind: 'rowid', rowid: '12' } });
	});

	it('puts a deleted row back whole through the INSERT path, its INTEGER PRIMARY KEY included', async () => {
		state.returning = [[7n, 'integer', 7n, 'text', 'a@b.c']];
		state.readBack = [7n, null, 'a@b.c', 5n, 'b.c', 3n];
		const result = await undoSqliteEdit(
			undoRequest({
				kind: 'restore-row',
				name: 'users',
				rowid: '7',
				values: { id: { type: 'integer', text: '7' }, email: { type: 'text', text: 'a@b.c' } },
			})
		);
		const writable = state.connections.writable;
		// The rowid IS the id column, so it is not set a second time through the alias.
		expect(writable.prepared).toContain(
			'INSERT INTO "users" ("id", "email") VALUES (?, ?) RETURNING "rowid", typeof("id"), "id", typeof("email"), "email"'
		);
		expect(writable.updates).toEqual([[7n, 'a@b.c']]);
		expect(result).toMatchObject({ kind: 'restore-row', key: { kind: 'rowid', rowid: '7' } });
	});

	it('keeps the old rowid of a table with no INTEGER PRIMARY KEY, and a BLOB whole', async () => {
		state.objects = [...state.objects, summary('logs')];
		state.editability.logs = {
			editable: true,
			identity: { kind: 'rowid', alias: 'rowid', rowidColumn: null },
			readOnlyColumns: [],
		};
		state.columns = [
			{ name: 'msg', type: 'TEXT' },
			{ name: 'data', type: 'BLOB' },
		];
		const bytes = Buffer.from('00ff', 'hex');
		state.returning = [[42n, 'text', 'hi', 'blob', bytes]];
		state.readBack = ['hi', 2n, bytes, 2n];
		await undoSqliteEdit(
			undoRequest({
				kind: 'restore-row',
				name: 'logs',
				rowid: '42',
				values: { msg: { type: 'text', text: 'hi' }, data: { type: 'blob', text: '00ff' } },
			})
		);
		const writable = state.connections.writable;
		expect(writable.prepared).toContain(
			'INSERT INTO "logs" ("rowid", "msg", "data") VALUES (?, ?, ?) RETURNING "rowid", typeof("msg"), "msg", typeof("data"), "data"'
		);
		expect(writable.updates).toEqual([[42n, 'hi', bytes]]);
	});

	it("passes SQLite's UNIQUE refusal through when the row's key was taken since", async () => {
		state.returning = new Error('UNIQUE constraint failed: users.id');
		await expect(
			undoSqliteEdit(
				undoRequest({
					kind: 'restore-row',
					name: 'users',
					rowid: '7',
					values: { id: { type: 'integer', text: '7' } },
				})
			)
		).rejects.toThrow('UNIQUE constraint failed: users.id');
		expect(state.connections.writable.committed).toBe(0);
	});

	it('refuses a malformed step before the backup', async () => {
		await expect(
			undoSqliteEdit(undoRequest({ ...restoreEmail, value: { type: 'blob', text: 'zz' } }))
		).rejects.toThrow("The undo step's value for email is not a stored value.");
		await expect(
			undoSqliteEdit(undoRequest({ ...restoreEmail, version: undefined as unknown as string }))
		).rejects.toThrow("An undo step needs the row's version after the write it undoes.");
		await expect(
			undoSqliteEdit(undoRequest({ ...restoreEmail, kind: 'redo' } as unknown as SqliteUndoStep))
		).rejects.toThrow('"redo" is not an undo step');
		await expect(
			undoSqliteEdit(undoRequest({ kind: 'restore-row', name: 'users', rowid: 'x', values: {} }))
		).rejects.toThrow('"x" is not a rowid.');
		await expect(undoSqliteEdit({ handle: 'h1', editToken: 'token' } as never)).rejects.toThrow(
			'An undo needs the step its write returned.'
		);
		expect(state.beginCalls).toBe(0);
	});

	it('refuses a tab that does not hold the unlock', async () => {
		state.locked = true;
		await expect(undoSqliteEdit(undoRequest(restoreEmail, 'forged'))).rejects.toThrow(
			'Editing is not enabled.'
		);
		expect(state.beginCalls).toBe(0);
	});
});
