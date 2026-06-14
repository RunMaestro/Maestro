/**
 * Tests for read-only SQL access to the stats database.
 *
 * better-sqlite3 is a native module compiled for Electron's Node ABI and cannot
 * load under the vitest runtime (see aggregations.test.ts for the same note), so
 * we mock it. That means the driver-level layers (readonly connection,
 * stmt.readonly) are exercised in the Electron e2e environment, not here.
 *
 * What we CAN prove here, and what matters most, is that the pure-JS guard layer
 * rejects every non-read-only statement BEFORE a database connection is ever
 * opened - the mock Database constructor throws if reached, so any test where a
 * disallowed query "passes" would fail loudly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the stats singleton so getDbPath() returns a stable fake path.
vi.mock('../../../main/stats/singleton', () => ({
	getStatsDB: () => ({ getDbPath: () => '/tmp/does-not-matter-stats.db' }),
}));

// Mock better-sqlite3. The constructor records that it was reached; tests assert
// it is NOT reached for guard-rejected queries.
const dbConstructed = vi.fn();
vi.mock('better-sqlite3', () => ({
	default: class MockDatabase {
		constructor(...args: unknown[]) {
			dbConstructed(...args);
		}
		prepare() {
			// A query that gets this far would need real SQLite to be meaningful;
			// guard-layer tests never reach here.
			throw new Error('prepare() reached - guard did not reject');
		}
		close() {}
	},
}));

import { runReadonlyStatsQuery } from '../../../main/stats/readonly-query';

describe('runReadonlyStatsQuery guard layer', () => {
	beforeEach(() => {
		dbConstructed.mockClear();
	});

	it('rejects empty SQL before opening the database', () => {
		expect(() => runReadonlyStatsQuery('   ')).toThrow(/empty/i);
		expect(dbConstructed).not.toHaveBeenCalled();
	});

	const disallowed: Array<[string, string]> = [
		['UPDATE', 'UPDATE query_events SET duration = 0'],
		['DELETE', 'DELETE FROM query_events'],
		['INSERT', "INSERT INTO query_events VALUES ('x','y',1)"],
		['DROP', 'DROP TABLE query_events'],
		['ALTER', 'ALTER TABLE query_events ADD COLUMN x INTEGER'],
		['CREATE', 'CREATE TABLE evil (x)'],
		['ATTACH', "ATTACH DATABASE '/tmp/evil.db' AS evil"],
		['DETACH', 'DETACH DATABASE evil'],
		['REPLACE', "REPLACE INTO query_events VALUES ('x','y',1)"],
		['VACUUM', 'VACUUM'],
		['comment-hidden write', '-- innocent\nDROP TABLE query_events'],
		['block-comment-hidden write', '/* hi */ DELETE FROM query_events'],
	];

	for (const [label, sql] of disallowed) {
		it(`rejects ${label} before opening the database`, () => {
			expect(() => runReadonlyStatsQuery(sql)).toThrow(/read-only/i);
			expect(dbConstructed).not.toHaveBeenCalled();
		});
	}

	it('lets multi-statement past the keyword guard but blocks it at prepare()', () => {
		// "SELECT 1; DROP..." starts with SELECT, so the keyword allowlist admits
		// it; the second statement is rejected one layer deeper by prepare()
		// (single-statement only) against the harmless readonly connection.
		expect(() => runReadonlyStatsQuery('SELECT 1; DROP TABLE query_events')).toThrow(
			/prepare\(\) reached/
		);
		// Real better-sqlite3 throws inside prepare() on multi-statement input;
		// here the mock proves the keyword guard let it through to that layer.
		expect(dbConstructed).toHaveBeenCalled();
	});

	const allowedKeywords: Array<[string, string]> = [
		['SELECT', 'SELECT * FROM query_events'],
		['WITH (CTE)', 'WITH t AS (SELECT 1 AS n) SELECT n FROM t'],
		['PRAGMA', 'PRAGMA table_info(query_events)'],
		['EXPLAIN', 'EXPLAIN SELECT * FROM query_events'],
		['VALUES', 'VALUES (1), (2)'],
	];

	for (const [label, sql] of allowedKeywords) {
		it(`lets ${label} through the guard to the database layer`, () => {
			// These pass the guard, so they DO reach new Database() (our mock),
			// whose prepare() then throws - proving the guard allowed them through.
			expect(() => runReadonlyStatsQuery(sql)).toThrow(/prepare\(\) reached/);
			expect(dbConstructed).toHaveBeenCalledWith('/tmp/does-not-matter-stats.db', {
				readonly: true,
				fileMustExist: true,
			});
		});
	}
});
