/**
 * Tests for the account usage stats module: window upsert branching,
 * throttle event marshaling, dynamic query building, and row mapping.
 *
 * Note: better-sqlite3 is a native module compiled for Electron's Node
 * version, so (matching the other stats suites) these tests drive the module
 * against a mocked db handle and verify SQL selection + parameter marshaling
 * rather than real SQLite behavior.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import {
	upsertAccountUsageWindow,
	getAccountUsageInWindow,
	insertThrottleEvent,
	getThrottleEvents,
	getAccountDailyUsage,
	getAccountMonthlyUsage,
	getAccountWindowHistory,
	clearAccountUsageCache,
} from '../../../main/stats/account-usage';

// Per-SQL statement mocks so each prepared statement can be asserted separately
const statements = new Map<
	string,
	{ run: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn>; all: ReturnType<typeof vi.fn> }
>();

function statementFor(sql: string) {
	if (!statements.has(sql)) {
		statements.set(sql, {
			run: vi.fn(() => ({ changes: 1 })),
			get: vi.fn(() => undefined),
			all: vi.fn(() => []),
		});
	}
	return statements.get(sql)!;
}

const mockDb = {
	prepare: vi.fn((sql: string) => statementFor(sql)),
} as unknown as Database.Database;

function findStatement(fragment: string) {
	for (const [sql, stmt] of statements) {
		if (sql.includes(fragment)) return stmt;
	}
	return undefined;
}

const TOKENS = {
	inputTokens: 100,
	outputTokens: 50,
	cacheReadTokens: 10,
	cacheCreationTokens: 5,
	costUsd: 0.02,
};

describe('stats/account-usage', () => {
	beforeEach(() => {
		statements.clear();
		vi.clearAllMocks();
		clearAccountUsageCache();
	});

	describe('upsertAccountUsageWindow', () => {
		it('inserts a new row when no window exists', () => {
			upsertAccountUsageWindow(mockDb, 'acct-1', 1000, 2000, TOKENS);

			const insert = findStatement('INSERT INTO account_usage_windows');
			expect(insert?.run).toHaveBeenCalledWith(
				expect.any(String), // generated id
				'acct-1',
				1000,
				2000,
				100,
				50,
				10,
				5,
				0.02,
				expect.any(Number) // created_at
			);
		});

		it('accumulates into the existing row when the window exists', () => {
			// Make the existence check return a row
			upsertAccountUsageWindow(mockDb, 'acct-1', 1000, 2000, TOKENS);
			const check = findStatement('SELECT id, input_tokens');
			check!.get.mockReturnValue({ id: 'win-1' });

			upsertAccountUsageWindow(mockDb, 'acct-1', 1000, 2000, TOKENS);

			const update = findStatement('UPDATE account_usage_windows');
			expect(update?.run).toHaveBeenCalledWith(100, 50, 10, 5, 0.02, 'win-1');
		});
	});

	it('getAccountUsageInWindow queries by account and window bounds', () => {
		getAccountUsageInWindow(mockDb, 'acct-1', 1000, 2000);

		const stmt = findStatement('FROM account_usage_windows');
		expect(stmt?.get).toHaveBeenCalledWith('acct-1', 1000, 2000);
	});

	describe('insertThrottleEvent', () => {
		it('marshals all fields and returns the generated id', () => {
			const id = insertThrottleEvent(mockDb, 'acct-1', 's1', 'rate_limited', 5000, 1000, 2000);

			expect(id).toBeTruthy();
			const insert = findStatement('INSERT INTO account_throttle_events');
			expect(insert?.run).toHaveBeenCalledWith(
				id,
				'acct-1',
				's1',
				expect.any(Number),
				'rate_limited',
				5000,
				1000,
				2000
			);
		});

		it('nulls optional window bounds and session', () => {
			insertThrottleEvent(mockDb, 'acct-1', null, 'auth_expired', 0);

			const insert = findStatement('INSERT INTO account_throttle_events');
			expect(insert?.run).toHaveBeenCalledWith(
				expect.any(String),
				'acct-1',
				null,
				expect.any(Number),
				'auth_expired',
				0,
				null,
				null
			);
		});
	});

	describe('getThrottleEvents', () => {
		it('builds an unfiltered query by default and maps snake_case rows', () => {
			const rowStmt = statementFor(
				'SELECT * FROM account_throttle_events WHERE 1=1 ORDER BY timestamp DESC'
			);
			rowStmt.all.mockReturnValue([
				{
					id: 't1',
					account_id: 'acct-1',
					session_id: 's1',
					timestamp: 123,
					reason: 'rate_limited',
					tokens_at_throttle: 42,
				},
			]);

			const events = getThrottleEvents(mockDb);

			expect(events).toEqual([
				{
					id: 't1',
					accountId: 'acct-1',
					sessionId: 's1',
					timestamp: 123,
					reason: 'rate_limited',
					tokensAtThrottle: 42,
				},
			]);
		});

		it('appends account and since filters with bound params', () => {
			getThrottleEvents(mockDb, 'acct-1', 999);

			const stmt = findStatement('AND account_id = ? AND timestamp >= ?');
			expect(stmt?.all).toHaveBeenCalledWith('acct-1', 999);
		});
	});

	it('getAccountDailyUsage binds account and time range', () => {
		getAccountDailyUsage(mockDb, 'acct-1', 100, 200);

		const stmt = findStatement("date(start_time / 1000, 'unixepoch', 'localtime')");
		expect(stmt?.all).toHaveBeenCalledWith('acct-1', 100, 200);
	});

	it('getAccountMonthlyUsage binds account and time range', () => {
		getAccountMonthlyUsage(mockDb, 'acct-1', 100, 200);

		const stmt = findStatement("strftime('%Y-%m'");
		expect(stmt?.all).toHaveBeenCalledWith('acct-1', 100, 200);
	});

	it('getAccountWindowHistory returns rows in chronological order', () => {
		const stmt = statementFor('window-history-placeholder');
		// getAccountWindowHistory uses db.prepare directly (not the cache)
		(mockDb.prepare as ReturnType<typeof vi.fn>).mockReturnValueOnce({
			...stmt,
			all: vi.fn(() => [
				{ windowStart: 3000, windowEnd: 4000, inputTokens: 2 },
				{ windowStart: 1000, windowEnd: 2000, inputTokens: 1 },
			]),
		});

		const history = getAccountWindowHistory(mockDb, 'acct-1', 2);

		// DESC from SQL, reversed to chronological
		expect(history.map((h) => h.windowStart)).toEqual([1000, 3000]);
	});
});
