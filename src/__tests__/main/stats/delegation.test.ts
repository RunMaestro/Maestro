/**
 * Tests for the query_events half of the delegation split.
 *
 * better-sqlite3 is a native module built for Electron, so these drive the row
 * folding with a stub statement rather than a real database. That is where the
 * risk actually lives: the SQL groups by source, and the folding decides what
 * an unrecognized source counts as and how two rows for one day are merged.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';

vi.mock('electron', () => ({
	app: {
		getPath: vi.fn((name: string) =>
			name === 'userData' ? path.join(os.tmpdir(), 'maestro-test-delegation') : os.tmpdir()
		),
	},
}));

import { getQuerySourceTotals, getQuerySourceByDay } from '../../../main/stats/delegation';

type Row = Record<string, unknown>;

/** Minimal stand-in for the better-sqlite3 handle these functions use. */
function fakeDb(rows: Row[]) {
	const all = vi.fn(() => rows);
	return {
		db: { prepare: vi.fn(() => ({ all })) } as unknown as Parameters<
			typeof getQuerySourceTotals
		>[0],
		all,
	};
}

describe('getQuerySourceTotals', () => {
	beforeEach(() => vi.clearAllMocks());

	it('splits turns and real summed durations by source', () => {
		const { db } = fakeDb([
			{ source: 'user', count: 12, duration: 60_000 },
			{ source: 'auto', count: 3, duration: 900_000 },
		]);
		expect(getQuerySourceTotals(db)).toEqual({
			interactive: { count: 12, durationMs: 60_000 },
			autoRun: { count: 3, durationMs: 900_000 },
		});
	});

	it('counts an unrecognized source as interactive, never as delegated', () => {
		// A value from a future build must not silently inflate the score the
		// milestone track persists.
		const { db } = fakeDb([{ source: 'something-new', count: 5, duration: 5000 }]);
		expect(getQuerySourceTotals(db)).toEqual({
			interactive: { count: 5, durationMs: 5000 },
			autoRun: { count: 0, durationMs: 0 },
		});
	});

	it('reports zeroes when the window has no rows', () => {
		const { db } = fakeDb([]);
		expect(getQuerySourceTotals(db)).toEqual({
			interactive: { count: 0, durationMs: 0 },
			autoRun: { count: 0, durationMs: 0 },
		});
	});

	it('defaults to every retained row', () => {
		const { db, all } = fakeDb([]);
		getQuerySourceTotals(db);
		expect(all).toHaveBeenCalledWith(0);
	});
});

describe('getQuerySourceByDay', () => {
	beforeEach(() => vi.clearAllMocks());

	it('merges both sources into one row per day, ascending', () => {
		const { db } = fakeDb([
			{ date: '2026-01-02', source: 'auto', count: 1, duration: 500 },
			{ date: '2026-01-01', source: 'user', count: 2, duration: 200 },
			{ date: '2026-01-01', source: 'auto', count: 1, duration: 800 },
		]);
		expect(getQuerySourceByDay(db)).toEqual([
			{
				date: '2026-01-01',
				interactive: { count: 2, durationMs: 200 },
				autoRun: { count: 1, durationMs: 800 },
			},
			{
				date: '2026-01-02',
				interactive: { count: 0, durationMs: 0 },
				autoRun: { count: 1, durationMs: 500 },
			},
		]);
	});

	it('returns an empty series when nothing was recorded', () => {
		const { db } = fakeDb([]);
		expect(getQuerySourceByDay(db)).toEqual([]);
	});
});
