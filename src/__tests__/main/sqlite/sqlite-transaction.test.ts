/**
 * Tests for Query mode's explicit transaction (src/main/sqlite/sqlite-transaction.ts):
 * Begin holds `BEGIN IMMEDIATE` open, statements run inside it through
 * `runSqliteQuery({ transactionId })`, and Commit, Roll back, Lock, idle,
 * Stop, and SQLite itself end it, each said in its own words.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// better-sqlite3's native binary is built for Electron's ABI and does not load
// under vitest, so the driver is a fake that plays SQLite's transaction rules:
// each statement's text picks its behaviour from `driver.script`. Under vitest
// no compiled worker sits beside the runner, so the session runs inline: these
// tests drive the same `openSqliteTransactionTask()` the child runs.
interface ScriptedStatement {
	readonly?: boolean;
	reader?: boolean;
	rows?: unknown[][];
	/** Rows the statement changes itself, and rows its triggers change beside them. */
	changes?: number;
	other?: number;
	/** The schema after it runs, when it changes it. */
	schemaAfter?: Array<{ type: string; name: string; sql: string | null }>;
	error?: Error;
	/** With `error`: SQLite rolled the whole transaction back. */
	endsTransaction?: boolean;
}

const driver = vi.hoisted(() => ({
	script: {} as Record<string, ScriptedStatement>,
	connections: [] as Array<{ execs: string[]; closed: boolean; options: Record<string, unknown> }>,
	schema: [] as Array<{ type: string; name: string; sql: string | null }>,
	commitError: null as Error | null,
	/** With `commitError`: SQLite ended the transaction when it refused the Commit. */
	commitEnds: false,
}));

vi.mock('better-sqlite3', () => {
	class FakeDatabase {
		inTransaction = false;
		record: (typeof driver.connections)[number];
		lastChanges = 0;
		totalChanges = 0;
		constructor(_filePath: string, options: Record<string, unknown>) {
			this.record = { execs: [], closed: false, options };
			driver.connections.push(this.record);
		}
		pragma() {
			return 1;
		}
		function() {
			return this;
		}
		exec(sql: string) {
			this.record.execs.push(sql);
			if (sql.startsWith('BEGIN')) this.inTransaction = true;
			if (sql === 'COMMIT') {
				if (driver.commitError) {
					if (driver.commitEnds) this.inTransaction = false;
					throw driver.commitError;
				}
				this.inTransaction = false;
			}
			if (sql === 'ROLLBACK') this.inTransaction = false;
		}
		prepare(sql: string) {
			if (sql === 'SELECT changes(), total_changes()') {
				return { raw: () => ({ get: () => [this.lastChanges, this.totalChanges] }) };
			}
			if (sql === 'SELECT type, name, sql FROM main.sqlite_master') {
				return { all: () => driver.schema };
			}
			const scripted = driver.script[sql];
			if (!scripted) throw new Error(`no such table: ${sql}`);
			const apply = () => {
				if (scripted.error) {
					if (scripted.endsTransaction) this.inTransaction = false;
					throw scripted.error;
				}
				if (scripted.changes !== undefined) {
					this.lastChanges = scripted.changes;
					this.totalChanges += scripted.changes + (scripted.other ?? 0);
				}
				if (scripted.schemaAfter) driver.schema = scripted.schemaAfter;
			};
			const statement = {
				readonly: scripted.readonly ?? false,
				reader: scripted.reader ?? false,
				columns: () => [{ name: 'id', type: 'INTEGER' }],
				raw: () => statement,
				safeIntegers: () => statement,
				iterate: () => {
					apply();
					return (scripted.rows ?? [])[Symbol.iterator]();
				},
				run: () => {
					apply();
					return { changes: scripted.changes ?? 0 };
				},
			};
			return statement;
		}
		close() {
			this.record.closed = true;
			this.inTransaction = false;
		}
	}
	return { default: FakeDatabase };
});

const releaseHooks = vi.hoisted(() => new Set<() => void>());
const database = vi.hoisted(() => ({
	displayPath: '/data/app.db',
	releaseHooks,
	// The handle's read-only connection, asked whether a non-transaction run writes.
	db: { prepare: () => ({ readonly: true }) },
}));
vi.mock('../../../main/sqlite/sqlite-database', () => ({
	getSqliteDatabase: (handle: string) => {
		if (handle !== 'h1') throw new Error('SQLite database handle is no longer open.');
		return database;
	},
}));

// The editing gate (sqlite-editing.test.ts covers it): 'tok' is live, Begin
// passes the write gate with a backup, the hold is recorded, and the grant's
// end hook is kept so a test can Lock.
const editing = vi.hoisted(() => ({
	backupCreated: true,
	writes: 0,
	held: [] as string[],
	released: 0,
	revoked: [] as Array<(reason: 'locked' | 'closed') => void>,
}));
vi.mock('../../../main/sqlite/sqlite-editing', () => {
	const gate = (_handle: string, token: unknown) => {
		if (token !== 'tok') {
			throw new Error('Editing is not enabled for this database. Turn on "Enable editing" first.');
		}
		return database;
	};
	return {
		requireSqliteEditing: gate,
		beginSqliteWorkerWrite: async (handle: string, token: unknown) => {
			gate(handle, token);
			editing.writes++;
			return {
				database,
				backup: { path: '/data/app.maestro-backup-1.db', bytes: 4096, createdAt: 1 },
				backupCreated: editing.backupCreated,
				target: { filePath: '/data/app.db', dev: 1, ino: 2 },
			};
		},
		beginSqliteWorkerTrial: async () => {
			throw new Error('a dry run never reaches the trial inside a transaction');
		},
		holdSqliteTransaction: (handle: string, token: unknown) => {
			gate(handle, token);
			editing.held.push(handle);
			return () => {
				editing.released++;
			};
		},
		onSqliteEditingRevoked: (
			handle: string,
			token: unknown,
			hook: (reason: 'locked' | 'closed') => void
		) => {
			gate(handle, token);
			editing.revoked.push(hook);
			return () => {
				editing.revoked = editing.revoked.filter((entry) => entry !== hook);
			};
		},
	};
});

// The child opens its write target by path; the device and inode check is
// sqlite-connection.test.ts's to prove.
vi.mock('../../../main/sqlite/sqlite-connection', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../main/sqlite/sqlite-connection')>();
	return {
		...actual,
		openWritableSqliteTarget: (target: { filePath: string }) =>
			actual.openWritableSqliteConnection(target.filePath),
	};
});

const history = vi.hoisted(() => ({ record: vi.fn(async (..._args: unknown[]) => undefined) }));
vi.mock('../../../main/sqlite/sqlite-query-history', () => ({
	getSqliteQueryHistory: () => history,
}));
vi.mock('../../../main/utils/logger', () => ({
	logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));

import { cancelSqliteQuery, runSqliteQuery } from '../../../main/sqlite/sqlite-query';
import {
	beginSqliteTransaction,
	endSqliteTransaction,
	hasOpenSqliteTransaction,
	readSqliteTransaction,
} from '../../../main/sqlite/sqlite-transaction';
import { SQLITE_QUERY_REFUSED } from '../../../main/sqlite/sqlite-query-task';
import { SQLITE_DRY_RUN_IN_TRANSACTION_MESSAGE } from '../../../shared/sqlite/dryRun';
import { SQLITE_WRITE_RERUN_MESSAGE, sqliteTransactionRefusal } from '../../../shared/sqlite/query';
import {
	SQLITE_TRANSACTION_ALREADY_OPEN_MESSAGE,
	SQLITE_TRANSACTION_GONE_MESSAGE,
	SQLITE_TRANSACTION_IDLE_MS,
	SQLITE_TRANSACTION_STOPPED_MESSAGE,
} from '../../../shared/sqlite/transaction';

const grant = { handle: 'h1', editToken: 'tok' };

/** Let the inline session's queued work run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** End whatever transaction a test left open, so the next starts clean. */
async function rollBackOpen(): Promise<void> {
	const open = readSqliteTransaction(grant).transaction;
	if (open) {
		await endSqliteTransaction({
			...grant,
			transactionId: open.transactionId,
			action: 'rollback',
		});
	}
}

beforeEach(() => {
	driver.script = {
		'UPDATE users SET age = age + 1': { changes: 3, other: 2 },
		'SELECT id FROM users': { readonly: true, reader: true, rows: [[1n], [2n]] },
		// No `changes`: like SQLite, a CREATE leaves changes() at the last INSERT/UPDATE/DELETE's count.
		'CREATE INDEX users_age ON users(age)': {
			schemaAfter: [
				{ type: 'table', name: 'users', sql: 'CREATE TABLE users(id, age)' },
				{ type: 'index', name: 'users_age', sql: 'CREATE INDEX users_age ON users(age)' },
			],
		},
		'INSERT INTO users(id) VALUES (1)': {
			error: Object.assign(new Error('UNIQUE constraint failed: users.id'), {
				code: 'SQLITE_CONSTRAINT_PRIMARYKEY',
			}),
		},
		'INSERT OR ROLLBACK INTO users(id) VALUES (1)': {
			error: Object.assign(new Error('UNIQUE constraint failed: users.id'), {
				code: 'SQLITE_CONSTRAINT_PRIMARYKEY',
			}),
			endsTransaction: true,
		},
		'DELETE FROM users RETURNING id': { reader: true, rows: [[1n], [2n]], changes: 2 },
	};
	driver.connections = [];
	driver.schema = [{ type: 'table', name: 'users', sql: 'CREATE TABLE users(id, age)' }];
	driver.commitError = null;
	driver.commitEnds = false;
	editing.backupCreated = true;
	editing.writes = 0;
	editing.held = [];
	editing.released = 0;
	editing.revoked = [];
	history.record.mockClear();
	releaseHooks.clear();
});

afterEach(async () => {
	vi.useRealTimers();
	await rollBackOpen();
});

describe('beginSqliteTransaction', () => {
	it('passes the write gate with the backup, holds the lock, and opens BEGIN IMMEDIATE', async () => {
		const begun = await beginSqliteTransaction(grant);
		expect(begun).toMatchObject({
			statements: 0,
			changes: 0,
			otherChanges: 0,
			schemaChanges: [],
			backup: { path: '/data/app.maestro-backup-1.db' },
		});
		expect(begun.expiresAt - begun.startedAt).toBe(SQLITE_TRANSACTION_IDLE_MS);
		expect(editing.writes).toBe(1);
		expect(editing.held).toEqual(['h1']);
		expect(driver.connections).toHaveLength(1);
		expect(driver.connections[0].options).toMatchObject({ fileMustExist: true });
		expect(driver.connections[0].execs).toEqual(['BEGIN IMMEDIATE']);
		expect(readSqliteTransaction(grant).transaction?.transactionId).toBe(begun.transactionId);
	});

	it('leaves the backup out once the session already has one', async () => {
		editing.backupCreated = false;
		expect((await beginSqliteTransaction(grant)).backup).toBeUndefined();
	});

	it('refuses a second transaction in the same tab, and a tab without a grant', async () => {
		await beginSqliteTransaction(grant);
		await expect(beginSqliteTransaction(grant)).rejects.toThrow(
			SQLITE_TRANSACTION_ALREADY_OPEN_MESSAGE
		);
		await expect(beginSqliteTransaction({ handle: 'h1', editToken: 'nope' })).rejects.toThrow(
			'Editing is not enabled'
		);
	});
});

describe('runSqliteQuery in a transaction', () => {
	it('runs writes and reads on the transaction connection and keeps a running total', async () => {
		const { transactionId } = await beginSqliteTransaction(grant);

		const update = await runSqliteQuery({
			...grant,
			sql: 'UPDATE users SET age = age + 1',
			transactionId,
		});
		expect(update).toMatchObject({
			statement: 'UPDATE',
			returnsRows: false,
			inTransaction: {
				writes: true,
				changes: 3,
				otherChanges: 2,
				transaction: { transactionId, statements: 1, changes: 3, otherChanges: 2 },
			},
		});
		expect(update.write).toBeUndefined();

		const index = await runSqliteQuery({
			...grant,
			sql: 'CREATE INDEX users_age ON users(age)',
			transactionId,
		});
		// changes() still holds the UPDATE's 3: a schema statement counts none of its own.
		expect(index.inTransaction).toMatchObject({
			writes: true,
			changes: 0,
			otherChanges: 0,
			transaction: {
				statements: 2,
				changes: 3,
				schemaChanges: [{ change: 'created', type: 'index', name: 'users_age' }],
			},
		});

		const read = await runSqliteQuery({ ...grant, sql: 'SELECT id FROM users', transactionId });
		expect(read).toMatchObject({
			rows: [[1], [2]],
			returnsRows: true,
			inTransaction: { writes: false, changes: 0, transaction: { statements: 3 } },
		});

		// One connection for all of it, the transaction's own, still open.
		expect(driver.connections).toHaveLength(1);
		expect(driver.connections[0].closed).toBe(false);
		// Each statement is in the history like any run, a write with its rows changed.
		expect(history.record).toHaveBeenCalledWith(
			'/data/app.db',
			expect.objectContaining({
				sql: 'UPDATE users SET age = age + 1',
				outcome: expect.objectContaining({ ok: true, changes: 3 }),
			})
		);
	});

	it('refuses what cannot run in it before anything runs', async () => {
		const { transactionId } = await beginSqliteTransaction(grant);
		const refusedWith = async (request: Parameters<typeof runSqliteQuery>[0], message: string) => {
			const failure = await runSqliteQuery(request).catch((error: unknown) => error);
			expect(failure).toMatchObject({ message, code: SQLITE_QUERY_REFUSED });
		};
		await refusedWith({ ...grant, sql: 'BEGIN', transactionId }, sqliteTransactionRefusal('BEGIN'));
		await refusedWith(
			{ ...grant, sql: 'UPDATE users SET age = age + 1', transactionId, dryRun: true },
			SQLITE_DRY_RUN_IN_TRANSACTION_MESSAGE
		);
		await refusedWith(
			{ ...grant, sql: 'DELETE FROM users RETURNING id', transactionId, offset: 500 },
			SQLITE_WRITE_RERUN_MESSAGE
		);
		await refusedWith(
			{ ...grant, sql: 'SELECT id FROM users', transactionId: 'someone-else' },
			SQLITE_TRANSACTION_GONE_MESSAGE
		);
		await refusedWith(
			{ handle: 'h1', sql: 'SELECT id FROM users', transactionId },
			'Editing is not enabled for this database. Turn on "Enable editing" first.'
		);
		// Nothing ran, so none of it is in the history, and the transaction holds nothing.
		expect(history.record).not.toHaveBeenCalled();
		expect(readSqliteTransaction(grant).transaction).toMatchObject({ statements: 0 });
	});

	it('keeps the transaction open when SQLite undoes only the failed statement', async () => {
		const { transactionId } = await beginSqliteTransaction(grant);
		await runSqliteQuery({ ...grant, sql: 'UPDATE users SET age = age + 1', transactionId });
		await expect(
			runSqliteQuery({ ...grant, sql: 'INSERT INTO users(id) VALUES (1)', transactionId })
		).rejects.toThrow(/^UNIQUE constraint failed: users\.id$/);
		expect(readSqliteTransaction(grant).transaction).toMatchObject({
			transactionId,
			statements: 1,
			changes: 3,
		});
	});

	it('says so when SQLite rolled the whole transaction back with the failure', async () => {
		const { transactionId } = await beginSqliteTransaction(grant);
		await runSqliteQuery({ ...grant, sql: 'UPDATE users SET age = age + 1', transactionId });
		await expect(
			runSqliteQuery({
				...grant,
				sql: 'INSERT OR ROLLBACK INTO users(id) VALUES (1)',
				transactionId,
			})
		).rejects.toThrow(
			/^UNIQUE constraint failed: users\.id SQLite rolled the whole transaction back when the statement failed\./
		);
		const status = readSqliteTransaction(grant);
		expect(status.transaction).toBeNull();
		expect(status.lastEnd).toMatchObject({
			transactionId,
			outcome: 'rolled-back',
			transaction: { statements: 1, changes: 3 },
		});
		expect(editing.released).toBe(1);
		expect(driver.connections[0].closed).toBe(true);
		// A later run names a transaction that is gone, and says how it ended.
		await expect(
			runSqliteQuery({ ...grant, sql: 'SELECT id FROM users', transactionId })
		).rejects.toThrow(`${SQLITE_TRANSACTION_GONE_MESSAGE} SQLite rolled the whole transaction`);
	});

	it('rolls the whole transaction back when a statement in it is stopped', async () => {
		const { transactionId } = await beginSqliteTransaction(grant);
		const run = runSqliteQuery({
			...grant,
			sql: 'SELECT id FROM users',
			transactionId,
			queryId: 'q1',
		});
		expect(cancelSqliteQuery('q1')).toBe(true);
		await expect(run).rejects.toThrow(SQLITE_TRANSACTION_STOPPED_MESSAGE);
		expect(hasOpenSqliteTransaction('tok')).toBe(false);
		expect(readSqliteTransaction(grant).lastEnd?.reason).toMatch(
			/^Rolled back because a statement in it was stopped\./
		);
		// Closing the connection rolls back: nothing is committed.
		expect(driver.connections[0].execs).not.toContain('COMMIT');
		expect(driver.connections[0].closed).toBe(true);
	});
});

describe('endSqliteTransaction', () => {
	it('commits, releases the lock, and says what reached the file', async () => {
		const { transactionId } = await beginSqliteTransaction(grant);
		await runSqliteQuery({ ...grant, sql: 'UPDATE users SET age = age + 1', transactionId });
		const end = await endSqliteTransaction({ ...grant, transactionId, action: 'commit' });
		expect(end).toMatchObject({
			transactionId,
			outcome: 'committed',
			reason:
				'Committed 1 statement: 3 rows changed, and 2 other rows by triggers and foreign-key actions. These changes are now in the file.',
			transaction: { statements: 1, changes: 3, otherChanges: 2 },
		});
		expect(driver.connections[0].execs).toEqual(['BEGIN IMMEDIATE', 'COMMIT']);
		expect(driver.connections[0].closed).toBe(true);
		expect(editing.released).toBe(1);
		expect(editing.revoked).toHaveLength(0);
		expect(readSqliteTransaction(grant)).toEqual({ transaction: null, lastEnd: end });
	});

	it('rolls back on Roll back', async () => {
		const { transactionId } = await beginSqliteTransaction(grant);
		await runSqliteQuery({ ...grant, sql: 'UPDATE users SET age = age + 1', transactionId });
		const end = await endSqliteTransaction({ ...grant, transactionId, action: 'rollback' });
		expect(end.outcome).toBe('rolled-back');
		expect(end.reason).toBe(
			'Rolled back. Nothing it held was kept (1 statement: 3 rows changed, and 2 other rows by triggers and foreign-key actions).'
		);
		expect(driver.connections[0].execs).toEqual(['BEGIN IMMEDIATE', 'ROLLBACK']);
	});

	it('keeps the transaction open when SQLite refuses the Commit but keeps it', async () => {
		const { transactionId } = await beginSqliteTransaction(grant);
		driver.commitError = Object.assign(new Error('FOREIGN KEY constraint failed'), {
			code: 'SQLITE_CONSTRAINT_FOREIGNKEY',
		});
		await expect(
			endSqliteTransaction({ ...grant, transactionId, action: 'commit' })
		).rejects.toThrow('FOREIGN KEY constraint failed');
		expect(readSqliteTransaction(grant).transaction?.transactionId).toBe(transactionId);

		driver.commitError = null;
		await expect(
			endSqliteTransaction({ ...grant, transactionId, action: 'rollback' })
		).resolves.toMatchObject({ outcome: 'rolled-back' });
	});

	it('refuses an id that is not the open transaction, and a bad action', async () => {
		const { transactionId } = await beginSqliteTransaction(grant);
		await expect(
			endSqliteTransaction({ ...grant, transactionId: 'stale', action: 'commit' })
		).rejects.toThrow(SQLITE_TRANSACTION_GONE_MESSAGE);
		await expect(
			endSqliteTransaction({
				...grant,
				transactionId,
				action: 'save' as unknown as 'commit',
			})
		).rejects.toThrow('A transaction ends with "commit" or "rollback".');
		expect(hasOpenSqliteTransaction('tok')).toBe(true);
	});
});

describe('a transaction ending on its own', () => {
	it('rolls back when its tab locks', async () => {
		const { transactionId } = await beginSqliteTransaction(grant);
		for (const hook of [...editing.revoked]) hook('locked');
		await settle();
		expect(hasOpenSqliteTransaction('tok')).toBe(false);
		expect(driver.connections[0].execs).toEqual(['BEGIN IMMEDIATE', 'ROLLBACK']);
		expect(readSqliteTransaction(grant).lastEnd).toMatchObject({
			transactionId,
			outcome: 'rolled-back',
			reason: expect.stringMatching(/^Rolled back because editing was locked\./),
		});
	});

	it('rolls back after sitting idle, and a statement restarts the clock', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
		const begun = await beginSqliteTransaction(grant);
		await vi.advanceTimersByTimeAsync(SQLITE_TRANSACTION_IDLE_MS - 1_000);
		const read = await runSqliteQuery({
			...grant,
			sql: 'SELECT id FROM users',
			transactionId: begun.transactionId,
		});
		expect(read.inTransaction?.transaction.expiresAt).toBeGreaterThan(begun.expiresAt);
		await vi.advanceTimersByTimeAsync(SQLITE_TRANSACTION_IDLE_MS - 1_000);
		expect(hasOpenSqliteTransaction('tok')).toBe(true);

		await vi.advanceTimersByTimeAsync(2_000);
		expect(hasOpenSqliteTransaction('tok')).toBe(false);
		expect(readSqliteTransaction(grant).lastEnd?.reason).toMatch(
			/^Rolled back after 10 minutes with no statement, Commit, or Roll back\./
		);
	});

	it('is killed when its database is released', async () => {
		await beginSqliteTransaction(grant);
		for (const hook of [...releaseHooks]) hook();
		expect(hasOpenSqliteTransaction('tok')).toBe(false);
		expect(driver.connections[0].closed).toBe(true);
		expect(editing.released).toBe(1);
	});
});
