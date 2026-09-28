/**
 * Delegation queries - the `query_events` half of the interactive vs
 * autonomous split.
 *
 * `bySource` in the main aggregation counts turns but not their duration, and
 * the dashboard used to estimate the per-source time by prorating the global
 * total by turn count. That understates delegation badly: an Auto Run turn runs
 * far longer than a typed one, so a day that was mostly unattended reported as
 * mostly interactive. These queries sum the real durations instead.
 *
 * The Cue half lives in `cue-db.ts`; the IPC handler merges the two.
 */

import type Database from 'better-sqlite3';
import type { StatsTimeRange } from '../../shared/stats-types';
import type { DelegationSlice } from '../../shared/delegation';
import { getTimeRangeStart, perfMetrics } from './utils';

/** Interactive and Auto Run turn counts + real summed durations for a window. */
export interface QuerySourceTotals {
	interactive: DelegationSlice;
	autoRun: DelegationSlice;
}

/** One local-time day of the interactive / Auto Run split. */
export interface QuerySourceDay {
	date: string;
	interactive: DelegationSlice;
	autoRun: DelegationSlice;
}

function emptySlices(): QuerySourceTotals {
	return {
		interactive: { count: 0, durationMs: 0 },
		autoRun: { count: 0, durationMs: 0 },
	};
}

/**
 * Turn counts and summed durations grouped by source, for the given range.
 *
 * `range` defaults to every retained row, which is what the lifetime
 * delegation score is computed from.
 */
export function getQuerySourceTotals(
	db: Database.Database,
	range: StatsTimeRange = 'all'
): QuerySourceTotals {
	const perfStart = perfMetrics.start();
	const startTime = getTimeRangeStart(range);
	const rows = db
		.prepare(
			`
      SELECT source,
             COUNT(*) as count,
             COALESCE(SUM(duration), 0) as duration
      FROM query_events
      WHERE start_time >= ?
      GROUP BY source
    `
		)
		.all(startTime) as Array<{ source: string; count: number; duration: number }>;

	const totals = emptySlices();
	for (const row of rows) {
		// Anything that isn't the literal 'auto' is a turn a human waited on.
		// Rows are written by our own recorder, so this only guards against a
		// value from a future build, which should read as interactive rather
		// than silently inflating the delegated share.
		const slice = row.source === 'auto' ? totals.autoRun : totals.interactive;
		slice.count += row.count;
		slice.durationMs += row.duration;
	}
	perfMetrics.end(perfStart, 'delegation:querySourceTotals');
	return totals;
}

/**
 * Per-local-day interactive / Auto Run split for the given range. Days with no
 * queries are omitted; the renderer zero-fills so the axis stays calendar-true.
 */
export function getQuerySourceByDay(
	db: Database.Database,
	range: StatsTimeRange = 'all'
): QuerySourceDay[] {
	const perfStart = perfMetrics.start();
	const startTime = getTimeRangeStart(range);
	const rows = db
		.prepare(
			`
      SELECT date(start_time / 1000, 'unixepoch', 'localtime') as date,
             source,
             COUNT(*) as count,
             COALESCE(SUM(duration), 0) as duration
      FROM query_events
      WHERE start_time >= ?
      GROUP BY date(start_time / 1000, 'unixepoch', 'localtime'), source
      ORDER BY date ASC
    `
		)
		.all(startTime) as Array<{ date: string; source: string; count: number; duration: number }>;

	const byDate = new Map<string, QuerySourceDay>();
	for (const row of rows) {
		let day = byDate.get(row.date);
		if (!day) {
			day = { date: row.date, ...emptySlices() };
			byDate.set(row.date, day);
		}
		const slice = row.source === 'auto' ? day.autoRun : day.interactive;
		slice.count += row.count;
		slice.durationMs += row.duration;
	}

	perfMetrics.end(perfStart, 'delegation:querySourceByDay', { dayCount: byDate.size });
	return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}
