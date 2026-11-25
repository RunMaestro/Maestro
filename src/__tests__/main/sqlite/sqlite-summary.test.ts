import { beforeEach, describe, expect, it, vi } from 'vitest';

// better-sqlite3's native binary is built for Electron's ABI and does not load
// under vitest, so the connection is a fake that answers the header pragmas
// the summary reads, the way SQLite would.
const state = vi.hoisted(() => ({
	pragmas: {} as Record<string, unknown>,
	asked: [] as Array<{ source: string; options: unknown }>,
}));

vi.mock('../../../main/sqlite/sqlite-database', () => ({
	getSqliteDatabase: (handle: string) => {
		if (handle !== 'h1') throw new Error('SQLite database handle is no longer open.');
		return {
			db: {
				pragma(source: string, options?: unknown) {
					state.asked.push({ source, options });
					if (!(source in state.pragmas)) throw new Error(`Unexpected pragma: ${source}`);
					return state.pragmas[source];
				},
				prepare(sql: string) {
					if (sql !== 'SELECT sqlite_version()') throw new Error(`Unexpected SQL: ${sql}`);
					return { pluck: () => ({ get: () => '3.53.2' }) };
				},
			},
		};
	},
}));

import { readSqliteDatabaseSummary } from '../../../main/sqlite/sqlite-summary';

describe('readSqliteDatabaseSummary', () => {
	beforeEach(() => {
		state.asked = [];
		state.pragmas = {
			page_size: 4096,
			page_count: 195,
			freelist_count: 49,
			encoding: 'UTF-8',
			journal_mode: 'WAL',
			user_version: 7,
			application_id: 1598903374,
		};
	});

	it('reads every header fact of an open database', () => {
		expect(readSqliteDatabaseSummary('h1')).toEqual({
			pageSize: 4096,
			pageCount: 195,
			freelistCount: 49,
			encoding: 'UTF-8',
			journalMode: 'wal',
			userVersion: 7,
			applicationId: 1598903374,
			sqliteVersion: '3.53.2',
		});
	});

	it('only ever asks the query form of each pragma, never an assignment', () => {
		readSqliteDatabaseSummary('h1');
		expect(state.asked.every(({ source }) => !source.includes('='))).toBe(true);
		expect(state.asked.every(({ options }) => (options as { simple?: boolean }).simple)).toBe(true);
	});

	it('lower-cases the journal mode, so a rollback mode reads as SQLite names it', () => {
		state.pragmas.journal_mode = 'DELETE';
		expect(readSqliteDatabaseSummary('h1').journalMode).toBe('delete');
	});

	it('keeps a negative application_id as SQLite stores it (a signed 32-bit value)', () => {
		state.pragmas.application_id = -1;
		expect(readSqliteDatabaseSummary('h1').applicationId).toBe(-1);
	});

	it('throws for a handle that is no longer open', () => {
		expect(() => readSqliteDatabaseSummary('gone')).toThrow('no longer open');
	});
});
