import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STATS_DB_VERSION } from '../../../shared/stats-types';

const loggerMocks = vi.hoisted(() => ({
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: loggerMocks,
}));

import { getCurrentVersion, getTargetVersion, runMigrations } from '../../../main/stats/migrations';

type FakeStatement = {
	sql: string;
	run: ReturnType<typeof vi.fn>;
	get: ReturnType<typeof vi.fn>;
	all: ReturnType<typeof vi.fn>;
};

type FakeDbOptions = {
	userVersion?: number;
	pragmaRows?: Array<{ user_version?: number }>;
	throwOnRunSql?: (sql: string) => boolean;
	throwValue?: unknown;
};

function createFakeDb(options: FakeDbOptions = {}) {
	let currentVersion = options.userVersion ?? 1;
	const statements: FakeStatement[] = [];

	const rawDb = {
		prepare: vi.fn((sql: string) => {
			const statement: FakeStatement = {
				sql,
				run: vi.fn(() => {
					if (options.throwOnRunSql?.(sql)) {
						throw options.throwValue;
					}
					return { changes: 1 };
				}),
				get: vi.fn(),
				all: vi.fn(() => []),
			};
			statements.push(statement);
			return statement;
		}),
		pragma: vi.fn((sql: string) => {
			if (sql === 'user_version') {
				return options.pragmaRows ?? [{ user_version: currentVersion }];
			}
			if (sql.startsWith('user_version = ')) {
				currentVersion = Number(sql.replace('user_version = ', ''));
			}
			return undefined;
		}),
		transaction: vi.fn((fn: () => void) => () => fn()),
	};

	return {
		db: rawDb as unknown as Database.Database,
		rawDb,
		statements,
		getVersion: () => currentVersion,
	};
}

function findFailedMigrationStatement(statements: FakeStatement[]): FakeStatement {
	const statement = statements.find(
		(entry) =>
			entry.sql.includes('INSERT OR REPLACE INTO _migrations') && entry.sql.includes("'failed'")
	);
	if (!statement) {
		throw new Error('Failed migration insert statement was not prepared');
	}
	return statement;
}

describe('stats migrations', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('records failed migration metadata before rethrowing Error failures', () => {
		const migrationError = new Error('duplicate column');
		const { db, statements } = createFakeDb({
			userVersion: 1,
			throwOnRunSql: (sql) => sql.includes('ALTER TABLE query_events'),
			throwValue: migrationError,
		});

		expect(() => runMigrations(db)).toThrow(migrationError);

		const failedInsert = findFailedMigrationStatement(statements);
		expect(failedInsert.run).toHaveBeenCalledWith(
			2,
			expect.stringContaining('is_remote'),
			expect.any(Number),
			'duplicate column'
		);
		expect(loggerMocks.error).toHaveBeenCalledWith(
			'Migration v2 failed: duplicate column',
			'[StatsDB]'
		);
	});

	it('records stringified failure metadata for non-Error migration failures', () => {
		const { db, statements } = createFakeDb({
			userVersion: 1,
			throwOnRunSql: (sql) => sql.includes('ALTER TABLE query_events'),
			throwValue: 'sqlite locked',
		});

		let thrown: unknown;
		try {
			runMigrations(db);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBe('sqlite locked');
		const failedInsert = findFailedMigrationStatement(statements);
		expect(failedInsert.run).toHaveBeenCalledWith(
			2,
			expect.stringContaining('is_remote'),
			expect.any(Number),
			'sqlite locked'
		);
		expect(loggerMocks.error).toHaveBeenCalledWith(
			'Migration v2 failed: sqlite locked',
			'[StatsDB]'
		);
	});

	it('treats a missing user_version row as a fresh database', () => {
		const { db, rawDb, getVersion } = createFakeDb({ pragmaRows: [] });

		runMigrations(db);

		expect(getVersion()).toBe(4);
		expect(rawDb.pragma).toHaveBeenCalledWith('user_version = 4');
	});

	it('returns 0 when the user_version pragma has no row', () => {
		const { db } = createFakeDb({ pragmaRows: [] });

		expect(getCurrentVersion(db)).toBe(0);
	});

	it('reports the latest available migration version', () => {
		expect(getTargetVersion()).toBe(STATS_DB_VERSION);
	});
});
