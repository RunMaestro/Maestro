import { describe, it, expect } from 'vitest';

import { formatDurationHuman } from '../../../shared/duration';
import {
	SQLITE_INTEGRITY_PROBLEM_CAP,
	formatSqliteApplicationId,
	formatSqliteIntegrity,
	formatSqliteJournalMode,
	parseSqliteIntegrityRows,
	sqliteIntegrityPragma,
	sqliteSummaryFacts,
} from '../../../shared/sqlite/summary';
import type { SqliteDatabaseSummary, SqliteIntegrityResult } from '../../../shared/sqlite/types';

function summary(overrides: Partial<SqliteDatabaseSummary> = {}): SqliteDatabaseSummary {
	return {
		pageSize: 4096,
		pageCount: 195,
		freelistCount: 0,
		encoding: 'UTF-8',
		journalMode: 'delete',
		userVersion: 0,
		applicationId: 0,
		sqliteVersion: '3.53.2',
		...overrides,
	};
}

function result(overrides: Partial<SqliteIntegrityResult> = {}): SqliteIntegrityResult {
	return { mode: 'quick', ok: true, problems: [], truncated: false, elapsedMs: 12, ...overrides };
}

describe('sqliteIntegrityPragma', () => {
	it('names the pragma for each mode, capped', () => {
		expect(sqliteIntegrityPragma('quick')).toBe(`quick_check(${SQLITE_INTEGRITY_PROBLEM_CAP})`);
		expect(sqliteIntegrityPragma('full')).toBe(`integrity_check(${SQLITE_INTEGRITY_PROBLEM_CAP})`);
	});
});

describe('parseSqliteIntegrityRows', () => {
	it('reads a single ok as a sound file', () => {
		expect(parseSqliteIntegrityRows(['ok'])).toEqual({ ok: true, problems: [], truncated: false });
	});

	it('lists each other row as a problem', () => {
		expect(parseSqliteIntegrityRows(['row 3 missing from index tv', 'wrong # of entries'])).toEqual(
			{
				ok: false,
				problems: ['row 3 missing from index tv', 'wrong # of entries'],
				truncated: false,
			}
		);
	});

	it('marks a reply that fills the cap as truncated', () => {
		const rows = Array.from({ length: SQLITE_INTEGRITY_PROBLEM_CAP }, (_, i) => `problem ${i}`);
		expect(parseSqliteIntegrityRows(rows).truncated).toBe(true);
	});

	it('never reports an empty reply as sound', () => {
		expect(parseSqliteIntegrityRows([])).toMatchObject({ ok: false });
	});
});

describe('formatSqliteApplicationId', () => {
	it('prints eight upper-case hex digits', () => {
		expect(formatSqliteApplicationId(1598903374)).toBe('0x5F4D544E');
		expect(formatSqliteApplicationId(1)).toBe('0x00000001');
	});

	it('reads a negative (signed) id as its unsigned bit pattern', () => {
		expect(formatSqliteApplicationId(-1)).toBe('0xFFFFFFFF');
	});
});

describe('formatSqliteJournalMode', () => {
	it('capitalises WAL and leaves the rollback modes as SQLite names them', () => {
		expect(formatSqliteJournalMode('wal')).toBe('WAL');
		expect(formatSqliteJournalMode('delete')).toBe('delete');
	});
});

describe('sqliteSummaryFacts', () => {
	it('shows pages, encoding, and journal for an ordinary file', () => {
		const facts = sqliteSummaryFacts(summary());
		expect(facts.map((fact) => fact.key)).toEqual(['pages', 'encoding', 'journal']);
		expect(facts[0].value).toBe('195 x 4.0 KB');
		expect(facts[1].value).toBe('UTF-8');
		expect(facts[2].value).toBe('delete');
	});

	it('adds the free list, user_version, and application_id when set', () => {
		const facts = sqliteSummaryFacts(
			summary({ freelistCount: 49, userVersion: 7, applicationId: 1598903374, journalMode: 'wal' })
		);
		expect(facts.map((fact) => [fact.key, fact.value])).toEqual([
			['pages', '195 x 4.0 KB'],
			['freelist', '196.0 KB'],
			['encoding', 'UTF-8'],
			['journal', 'WAL'],
			['user-version', '7'],
			['application-id', '0x5F4D544E'],
		]);
		expect(facts.find((fact) => fact.key === 'journal')?.title).toContain('-wal');
	});

	it('gives every fact a tooltip naming its pragma', () => {
		const facts = sqliteSummaryFacts(
			summary({ freelistCount: 1, userVersion: 1, applicationId: 1 })
		);
		for (const fact of facts) expect(fact.title).toMatch(/\([a-z_, ]+\)/);
	});
});

describe('formatSqliteIntegrity', () => {
	it('reads a sound file with its mode and time', () => {
		expect(formatSqliteIntegrity(result())).toBe('ok (quick check, 12 ms)');
	});

	it('switches to a humanized duration from a second up', () => {
		expect(formatSqliteIntegrity(result({ mode: 'full', elapsedMs: 2500 }))).toBe(
			`ok (full check, ${formatDurationHuman(2500)})`
		);
	});

	it('counts problems, singular and plural, with + when truncated', () => {
		expect(formatSqliteIntegrity(result({ ok: false, problems: ['a'] }))).toBe(
			'1 problem (quick check, 12 ms)'
		);
		expect(formatSqliteIntegrity(result({ ok: false, problems: ['a', 'b'] }))).toBe(
			'2 problems (quick check, 12 ms)'
		);
		expect(formatSqliteIntegrity(result({ ok: false, problems: ['a'], truncated: true }))).toBe(
			'1+ problems (quick check, 12 ms)'
		);
	});
});
