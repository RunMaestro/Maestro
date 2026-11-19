import { describe, expect, it } from 'vitest';

import {
	SQLITE_QUERY_HISTORY_ERROR_CHARS,
	SQLITE_QUERY_HISTORY_MAX_ENTRIES,
	SQLITE_QUERY_HISTORY_MAX_FILES,
	SQLITE_QUERY_HISTORY_MAX_SQL_CHARS,
	addSqliteQueryHistoryRun,
	emptySqliteQueryHistoryStore,
	formatSqliteQueryHistoryOutcome,
	isRecordableSqliteQuery,
	parseSqliteQueryHistoryStore,
	pruneSqliteQueryHistoryStore,
	sqliteQueryHistoryLine,
	type SqliteQueryHistoryRun,
	type SqliteQueryHistoryStore,
} from '../../../shared/sqlite/history';
import type { SqliteQueryHistoryEntry } from '../../../shared/sqlite/types';

const ok = { ok: true as const, rows: 3, hasMore: false, returnsRows: true, elapsedMs: 2 };

function run(sql: string, overrides: Partial<SqliteQueryHistoryRun> = {}): SqliteQueryHistoryRun {
	return { sql, plan: false, params: {}, ranAt: 1, outcome: ok, ...overrides };
}

function ids() {
	let next = 0;
	return () => `id-${++next}`;
}

describe('addSqliteQueryHistoryRun', () => {
	it('puts a new statement at the top, trimmed', () => {
		const entries = addSqliteQueryHistoryRun([], run('  SELECT 1\n'), ids());
		expect(entries).toEqual([
			{ id: 'id-1', sql: 'SELECT 1', plan: false, params: {}, ranAt: 1, runs: 1, outcome: ok },
		]);
	});

	it('moves a statement run again to the top, counting the run and keeping its id', () => {
		const newId = ids();
		let entries = addSqliteQueryHistoryRun([], run('SELECT 1'), newId);
		entries = addSqliteQueryHistoryRun(entries, run('SELECT 2', { ranAt: 2 }), newId);
		entries = addSqliteQueryHistoryRun(
			entries,
			run('SELECT 1', { ranAt: 3, outcome: { ok: false, error: 'boom' } }),
			newId
		);
		expect(entries.map((entry) => [entry.id, entry.sql, entry.runs, entry.ranAt])).toEqual([
			['id-1', 'SELECT 1', 2, 3],
			['id-2', 'SELECT 2', 1, 2],
		]);
		expect(entries[0].outcome).toEqual({ ok: false, error: 'boom' });
	});

	it('keeps a plan of a statement apart from its rows', () => {
		const newId = ids();
		let entries = addSqliteQueryHistoryRun([], run('SELECT 1'), newId);
		entries = addSqliteQueryHistoryRun(entries, run('SELECT 1', { plan: true }), newId);
		expect(entries.map((entry) => entry.plan)).toEqual([true, false]);
	});

	it("keeps only the values of the statement's own parameters", () => {
		const [entry] = addSqliteQueryHistoryRun(
			[],
			run('SELECT * FROM t WHERE id = :id', {
				params: { ':id': { type: 'number', text: '7' }, ':gone': { type: 'text', text: 'x' } },
			}),
			ids()
		);
		expect(entry.params).toEqual({ ':id': { type: 'number', text: '7' } });
	});

	it('cuts a long error', () => {
		const [entry] = addSqliteQueryHistoryRun(
			[],
			run('SELECT 1', { outcome: { ok: false, error: 'x'.repeat(2_000) } }),
			ids()
		);
		expect(entry.outcome.ok).toBe(false);
		if (!entry.outcome.ok) {
			expect(entry.outcome.error).toHaveLength(SQLITE_QUERY_HISTORY_ERROR_CHARS);
			expect(entry.outcome.error.endsWith('...')).toBe(true);
		}
	});

	it('keeps the newest statements only', () => {
		const newId = ids();
		let entries: SqliteQueryHistoryEntry[] = [];
		for (let index = 0; index <= SQLITE_QUERY_HISTORY_MAX_ENTRIES; index++) {
			entries = addSqliteQueryHistoryRun(entries, run(`SELECT ${index}`), newId);
		}
		expect(entries).toHaveLength(SQLITE_QUERY_HISTORY_MAX_ENTRIES);
		expect(entries[0].sql).toBe(`SELECT ${SQLITE_QUERY_HISTORY_MAX_ENTRIES}`);
		expect(entries.some((entry) => entry.sql === 'SELECT 0')).toBe(false);
	});
});

describe('isRecordableSqliteQuery', () => {
	it('refuses empty text and text too long to keep', () => {
		expect(isRecordableSqliteQuery('SELECT 1')).toBe(true);
		expect(isRecordableSqliteQuery('   ')).toBe(false);
		expect(isRecordableSqliteQuery('x'.repeat(SQLITE_QUERY_HISTORY_MAX_SQL_CHARS + 1))).toBe(false);
	});
});

describe('pruneSqliteQueryHistoryStore', () => {
	it('keeps the databases used most recently', () => {
		const store: SqliteQueryHistoryStore = { version: 1, files: {} };
		for (let index = 0; index <= SQLITE_QUERY_HISTORY_MAX_FILES; index++) {
			store.files[`/db/${index}.db`] = { usedAt: index, entries: [] };
		}
		const pruned = pruneSqliteQueryHistoryStore(store);
		expect(Object.keys(pruned.files)).toHaveLength(SQLITE_QUERY_HISTORY_MAX_FILES);
		expect(pruned.files['/db/0.db']).toBeUndefined();
		expect(pruned.files[`/db/${SQLITE_QUERY_HISTORY_MAX_FILES}.db`]).toBeDefined();
	});

	it('returns a small store as it is', () => {
		const store = emptySqliteQueryHistoryStore();
		expect(pruneSqliteQueryHistoryStore(store)).toBe(store);
	});
});

describe('parseSqliteQueryHistoryStore', () => {
	const good: SqliteQueryHistoryEntry = {
		id: 'a',
		sql: 'SELECT :x',
		plan: false,
		params: { ':x': { type: 'text', text: 'hi' } },
		ranAt: 5,
		runs: 1,
		outcome: ok,
	};

	it('reads a store back as it was written', () => {
		const store = { version: 1, files: { '/db/app.db': { usedAt: 5, entries: [good] } } };
		expect(parseSqliteQueryHistoryStore(JSON.parse(JSON.stringify(store)))).toEqual(store);
	});

	it('drops a bad entry and keeps the rest', () => {
		const parsed = parseSqliteQueryHistoryStore({
			files: {
				'/db/app.db': {
					usedAt: 5,
					entries: [good, { id: 'b' }, { ...good, id: 'c', outcome: { ok: 'maybe' } }],
				},
			},
		});
		expect(parsed.files['/db/app.db'].entries.map((entry) => entry.id)).toEqual(['a']);
	});

	it('drops parameter labels that are not labels, such as __proto__', () => {
		const parsed = parseSqliteQueryHistoryStore(
			JSON.parse(
				JSON.stringify({
					files: { '/db/app.db': { usedAt: 5, entries: [{ ...good, params: {} }] } },
				}).replace('"params":{}', '"params":{"__proto__":{"type":"text","text":"x"}}')
			)
		);
		expect(parsed.files['/db/app.db']).toBeUndefined();
	});

	it('reads anything that is not a store as an empty one', () => {
		expect(parseSqliteQueryHistoryStore(null)).toEqual(emptySqliteQueryHistoryStore());
		expect(parseSqliteQueryHistoryStore([1, 2])).toEqual(emptySqliteQueryHistoryStore());
		expect(parseSqliteQueryHistoryStore({ files: 'no' })).toEqual(emptySqliteQueryHistoryStore());
	});

	it('takes a missing usedAt from the newest entry', () => {
		const parsed = parseSqliteQueryHistoryStore({ files: { '/db/app.db': { entries: [good] } } });
		expect(parsed.files['/db/app.db'].usedAt).toBe(5);
	});
});

describe('formatSqliteQueryHistoryOutcome', () => {
	it('says how a run ended in a few words', () => {
		expect(formatSqliteQueryHistoryOutcome(ok)).toBe('3 rows');
		expect(formatSqliteQueryHistoryOutcome({ ...ok, rows: 1 })).toBe('1 row');
		expect(formatSqliteQueryHistoryOutcome({ ...ok, rows: 500, hasMore: true })).toBe('500+ rows');
		expect(formatSqliteQueryHistoryOutcome({ ...ok, rows: 0 })).toBe('no rows');
		expect(formatSqliteQueryHistoryOutcome({ ...ok, rows: 0, returnsRows: false })).toBe(
			'returns no rows'
		);
		expect(formatSqliteQueryHistoryOutcome({ ok: false, error: 'boom' })).toBe('failed');
	});
});

describe('sqliteQueryHistoryLine', () => {
	it('collapses a statement onto one line', () => {
		expect(sqliteQueryHistoryLine('  SELECT *\n\tFROM t\n  WHERE id = 1 ')).toBe(
			'SELECT * FROM t WHERE id = 1'
		);
	});
});
