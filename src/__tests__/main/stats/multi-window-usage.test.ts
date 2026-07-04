/**
 * Tests for multi-window usage stats operations.
 *
 * Like the other stats-ops suites, better-sqlite3's native module is not loaded
 * here; these tests pass a hand-rolled fake DB that captures the prepared SQL and
 * the run/get arguments, verifying the bucketing, UPSERT shape, and aggregate
 * mapping without the real database engine.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import {
	recordWindowOpened,
	getMultiWindowUsage,
	clearMultiWindowUsageCache,
} from '../../../main/stats/multi-window-usage';

interface RunCall {
	sql: string;
	params: unknown[];
}
interface GetCall {
	sql: string;
	params: unknown[];
}

/** A fake better-sqlite3 DB capturing prepared SQL + statement calls. */
function makeFakeDb(getResult?: unknown) {
	const runCalls: RunCall[] = [];
	const getCalls: GetCall[] = [];
	const db = {
		prepare: vi.fn((sql: string) => ({
			run: vi.fn((...params: unknown[]) => {
				runCalls.push({ sql, params });
				return { changes: 1 };
			}),
			get: vi.fn((...params: unknown[]) => {
				getCalls.push({ sql, params });
				return getResult;
			}),
		})),
	};
	return { db: db as unknown as Database.Database, runCalls, getCalls };
}

describe('multi-window-usage stats ops', () => {
	beforeEach(() => {
		// The module-level statement cache holds prepared statements keyed by SQL;
		// clear it so each test gets a fresh statement bound to its own fake DB.
		clearMultiWindowUsageCache();
	});

	describe('recordWindowOpened', () => {
		it('buckets the timestamp into a local YYYY-MM-DD date and UPSERTs (date, count)', () => {
			const { db, runCalls } = makeFakeDb();
			// Construct via local-time fields so the bucket is timezone-independent.
			const openedAt = new Date(2026, 5, 23, 10, 30, 0).getTime();

			const date = recordWindowOpened(db, openedAt, 3);

			expect(date).toBe('2026-06-23');
			expect(runCalls).toHaveLength(1);
			expect(runCalls[0].params).toEqual(['2026-06-23', 3]);
		});

		it('issues an UPSERT that increments the count and raises the peak high-water mark', () => {
			const { db, runCalls } = makeFakeDb();
			recordWindowOpened(db, new Date(2026, 0, 1, 0, 0, 0).getTime(), 2);

			const sql = runCalls[0].sql;
			expect(sql).toContain('INSERT INTO multi_window_usage_daily');
			expect(sql).toContain('ON CONFLICT(date) DO UPDATE');
			expect(sql).toContain('windows_opened = windows_opened + 1');
			expect(sql).toContain('peak_concurrent = MAX(peak_concurrent, excluded.peak_concurrent)');
		});

		it('passes the supplied concurrent window count through as the peak candidate', () => {
			const { db, runCalls } = makeFakeDb();
			recordWindowOpened(db, new Date(2026, 5, 23).getTime(), 5);
			expect(runCalls[0].params[1]).toBe(5);
		});
	});

	describe('getMultiWindowUsage', () => {
		it('maps the aggregate row to { windowsOpened, peakConcurrent }', () => {
			const { db, getCalls } = makeFakeDb({ windowsOpened: 12, peakConcurrent: 4 });

			const result = getMultiWindowUsage(db, 'week');

			expect(result).toEqual({ windowsOpened: 12, peakConcurrent: 4 });
			expect(getCalls).toHaveLength(1);
			expect(getCalls[0].sql).toContain('SUM(windows_opened)');
			expect(getCalls[0].sql).toContain('MAX(peak_concurrent)');
		});

		it('returns zeros when there is no activity in the range (undefined row)', () => {
			const { db } = makeFakeDb(undefined);
			expect(getMultiWindowUsage(db, 'month')).toEqual({ windowsOpened: 0, peakConcurrent: 0 });
		});

		it("queries with the all-time lower bound '0000-01-01' for range 'all'", () => {
			const { db, getCalls } = makeFakeDb({ windowsOpened: 1, peakConcurrent: 2 });
			getMultiWindowUsage(db, 'all');
			expect(getCalls[0].params).toEqual(['0000-01-01']);
		});
	});
});
