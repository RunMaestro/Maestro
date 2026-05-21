/**
 * Stats Aggregation Queries
 *
 * Decomposes the monolithic getAggregatedStats into focused sub-query functions,
 * each independently testable and readable.
 */

import type Database from 'better-sqlite3';
import type { StatsTimeRange, StatsAggregation } from '../../shared/stats-types';
import {
	percentilesFromSorted,
	emptyPercentiles,
	type DurationPercentiles,
} from '../../shared/percentiles';
import { PERFORMANCE_THRESHOLDS } from '../../shared/performance-metrics';
import { getTimeRangeStart, perfMetrics, LOG_CONTEXT } from './utils';
import { countImageAnnotationsSince } from './image-annotations';
import { getMultiWindowUsageStats } from './multi-window';
import { logger } from '../utils/logger';

// ============================================================================
// Sub-query Functions
// ============================================================================

function queryTotals(
	db: Database.Database,
	startTime: number
): { count: number; total_duration: number } {
	const perfStart = perfMetrics.start();
	const result = db
		.prepare(
			`
      SELECT COUNT(*) as count, COALESCE(SUM(duration), 0) as total_duration
      FROM query_events
      WHERE start_time >= ?
    `
		)
		.get(startTime) as { count: number; total_duration: number };
	perfMetrics.end(perfStart, 'getAggregatedStats:totals');
	return result;
}

function queryByAgent(
	db: Database.Database,
	startTime: number
): Record<string, { count: number; duration: number }> {
	const perfStart = perfMetrics.start();
	const rows = db
		.prepare(
			`
      SELECT agent_type, COUNT(*) as count, SUM(duration) as duration
      FROM query_events
      WHERE start_time >= ?
      GROUP BY agent_type
    `
		)
		.all(startTime) as Array<{ agent_type: string; count: number; duration: number }>;

	const result: Record<string, { count: number; duration: number }> = {};
	for (const row of rows) {
		result[row.agent_type] = { count: row.count, duration: row.duration };
	}
	perfMetrics.end(perfStart, 'getAggregatedStats:byAgent', { agentCount: rows.length });
	return result;
}

function queryBySource(db: Database.Database, startTime: number): { user: number; auto: number } {
	const perfStart = perfMetrics.start();
	const rows = db
		.prepare(
			`
      SELECT source, COUNT(*) as count
      FROM query_events
      WHERE start_time >= ?
      GROUP BY source
    `
		)
		.all(startTime) as Array<{ source: 'user' | 'auto'; count: number }>;

	const result = { user: 0, auto: 0 };
	for (const row of rows) {
		result[row.source] = row.count;
	}
	perfMetrics.end(perfStart, 'getAggregatedStats:bySource');
	return result;
}

function queryByWorktreeStatus(
	db: Database.Database,
	startTime: number
): {
	worktreeQueries: number;
	parentQueries: number;
	byWorktreeStatus: {
		worktree: { count: number; duration: number };
		parent: { count: number; duration: number };
	};
} {
	const perfStart = perfMetrics.start();
	const rows = db
		.prepare(
			`
      SELECT COALESCE(is_worktree, 0) as is_worktree,
             COUNT(*) as count,
             COALESCE(SUM(duration), 0) as duration
      FROM query_events
      WHERE start_time >= ?
      GROUP BY COALESCE(is_worktree, 0)
    `
		)
		.all(startTime) as Array<{ is_worktree: number; count: number; duration: number }>;

	const byWorktreeStatus = {
		worktree: { count: 0, duration: 0 },
		parent: { count: 0, duration: 0 },
	};
	for (const row of rows) {
		if (row.is_worktree === 1) {
			byWorktreeStatus.worktree.count += row.count;
			byWorktreeStatus.worktree.duration += row.duration;
		} else {
			// Treat NULL (legacy data) and 0 as parent
			byWorktreeStatus.parent.count += row.count;
			byWorktreeStatus.parent.duration += row.duration;
		}
	}
	perfMetrics.end(perfStart, 'getAggregatedStats:byWorktreeStatus');
	return {
		worktreeQueries: byWorktreeStatus.worktree.count,
		parentQueries: byWorktreeStatus.parent.count,
		byWorktreeStatus,
	};
}

function queryByLocation(
	db: Database.Database,
	startTime: number
): { local: number; remote: number } {
	const perfStart = perfMetrics.start();
	const rows = db
		.prepare(
			`
      SELECT is_remote, COUNT(*) as count
      FROM query_events
      WHERE start_time >= ?
      GROUP BY is_remote
    `
		)
		.all(startTime) as Array<{ is_remote: number | null; count: number }>;

	const result = { local: 0, remote: 0 };
	for (const row of rows) {
		if (row.is_remote === 1) {
			result.remote = row.count;
		} else {
			// Treat NULL (legacy data) and 0 as local
			result.local += row.count;
		}
	}
	perfMetrics.end(perfStart, 'getAggregatedStats:byLocation');
	return result;
}

function queryByDay(
	db: Database.Database,
	startTime: number
): Array<{ date: string; count: number; duration: number }> {
	const perfStart = perfMetrics.start();
	const rows = db
		.prepare(
			`
      SELECT date(start_time / 1000, 'unixepoch', 'localtime') as date,
             COUNT(*) as count,
             SUM(duration) as duration
      FROM query_events
      WHERE start_time >= ?
      GROUP BY date(start_time / 1000, 'unixepoch', 'localtime')
      ORDER BY date ASC
    `
		)
		.all(startTime) as Array<{ date: string; count: number; duration: number }>;
	perfMetrics.end(perfStart, 'getAggregatedStats:byDay', { dayCount: rows.length });
	return rows;
}

function queryByAgentByDay(
	db: Database.Database,
	startTime: number
): Record<string, Array<{ date: string; count: number; duration: number }>> {
	const perfStart = perfMetrics.start();
	const rows = db
		.prepare(
			`
      SELECT agent_type,
             date(start_time / 1000, 'unixepoch', 'localtime') as date,
             COUNT(*) as count,
             SUM(duration) as duration
      FROM query_events
      WHERE start_time >= ?
      GROUP BY agent_type, date(start_time / 1000, 'unixepoch', 'localtime')
      ORDER BY agent_type, date ASC
    `
		)
		.all(startTime) as Array<{
		agent_type: string;
		date: string;
		count: number;
		duration: number;
	}>;

	const result: Record<string, Array<{ date: string; count: number; duration: number }>> = {};
	for (const row of rows) {
		if (!result[row.agent_type]) {
			result[row.agent_type] = [];
		}
		result[row.agent_type].push({ date: row.date, count: row.count, duration: row.duration });
	}
	perfMetrics.end(perfStart, 'getAggregatedStats:byAgentByDay');
	return result;
}

function queryByHour(
	db: Database.Database,
	startTime: number
): Array<{ hour: number; count: number; duration: number }> {
	const perfStart = perfMetrics.start();
	const rows = db
		.prepare(
			`
      SELECT CAST(strftime('%H', start_time / 1000, 'unixepoch', 'localtime') AS INTEGER) as hour,
             COUNT(*) as count,
             SUM(duration) as duration
      FROM query_events
      WHERE start_time >= ?
      GROUP BY hour
      ORDER BY hour ASC
    `
		)
		.all(startTime) as Array<{ hour: number; count: number; duration: number }>;
	perfMetrics.end(perfStart, 'getAggregatedStats:byHour');
	return rows;
}

function querySessionStats(
	db: Database.Database,
	startTime: number
): {
	totalSessions: number;
	sessionsByAgent: Record<string, number>;
	sessionsByDay: Array<{ date: string; count: number }>;
	avgSessionDuration: number;
} {
	const perfStart = perfMetrics.start();

	// Total unique sessions with queries
	const sessionTotals = db
		.prepare(
			`
      SELECT COUNT(DISTINCT session_id) as count
      FROM query_events
      WHERE start_time >= ?
    `
		)
		.get(startTime) as { count: number };

	// Average session duration from lifecycle table
	const avgResult = db
		.prepare(
			`
      SELECT COALESCE(AVG(duration), 0) as avg_duration
      FROM session_lifecycle
      WHERE created_at >= ? AND duration IS NOT NULL
    `
		)
		.get(startTime) as { avg_duration: number };

	// Sessions by agent type
	const byAgentRows = db
		.prepare(
			`
      SELECT agent_type, COUNT(*) as count
      FROM session_lifecycle
      WHERE created_at >= ?
      GROUP BY agent_type
    `
		)
		.all(startTime) as Array<{ agent_type: string; count: number }>;

	const sessionsByAgent: Record<string, number> = {};
	for (const row of byAgentRows) {
		sessionsByAgent[row.agent_type] = row.count;
	}

	// Sessions by day
	const byDayRows = db
		.prepare(
			`
      SELECT date(created_at / 1000, 'unixepoch', 'localtime') as date,
             COUNT(*) as count
      FROM session_lifecycle
      WHERE created_at >= ?
      GROUP BY date(created_at / 1000, 'unixepoch', 'localtime')
      ORDER BY date ASC
    `
		)
		.all(startTime) as Array<{ date: string; count: number }>;

	perfMetrics.end(perfStart, 'getAggregatedStats:sessions', {
		sessionCount: sessionTotals.count,
	});

	return {
		totalSessions: sessionTotals.count,
		sessionsByAgent,
		sessionsByDay: byDayRows,
		avgSessionDuration: Math.round(avgResult.avg_duration),
	};
}

function queryBySessionByDay(
	db: Database.Database,
	startTime: number
): Record<string, Array<{ date: string; count: number; duration: number }>> {
	const perfStart = perfMetrics.start();
	const rows = db
		.prepare(
			`
      SELECT session_id,
             date(start_time / 1000, 'unixepoch', 'localtime') as date,
             COUNT(*) as count,
             SUM(duration) as duration
      FROM query_events
      WHERE start_time >= ?
      GROUP BY session_id, date(start_time / 1000, 'unixepoch', 'localtime')
      ORDER BY session_id, date ASC
    `
		)
		.all(startTime) as Array<{
		session_id: string;
		date: string;
		count: number;
		duration: number;
	}>;

	const result: Record<string, Array<{ date: string; count: number; duration: number }>> = {};
	for (const row of rows) {
		if (!result[row.session_id]) {
			result[row.session_id] = [];
		}
		result[row.session_id].push({ date: row.date, count: row.count, duration: row.duration });
	}
	perfMetrics.end(perfStart, 'getAggregatedStats:bySessionByDay');
	return result;
}

function queryBySessionSource(
	db: Database.Database,
	startTime: number
): Record<string, { user: number; auto: number }> {
	const perfStart = perfMetrics.start();
	const rows = db
		.prepare(
			`
      SELECT session_id, source, COUNT(*) as count
      FROM query_events
      WHERE start_time >= ?
      GROUP BY session_id, source
    `
		)
		.all(startTime) as Array<{
		session_id: string;
		source: 'user' | 'auto';
		count: number;
	}>;

	const result: Record<string, { user: number; auto: number }> = {};
	for (const row of rows) {
		if (!result[row.session_id]) {
			result[row.session_id] = { user: 0, auto: 0 };
		}
		result[row.session_id][row.source] = row.count;
	}
	perfMetrics.end(perfStart, 'getAggregatedStats:bySessionSource');
	return result;
}

/**
 * Query duration distribution overall and per agent type.
 *
 * SQLite (better-sqlite3) has no `PERCENTILE_CONT`, so we pull the `duration`
 * column sorted ascending and slice in JS. One ordered scan feeds both the
 * overall distribution and every per-agent distribution (rows arrive grouped by
 * agent because the sort is `agent_type, duration`), so each group's slice is
 * already sorted.
 */
function queryDurationPercentiles(
	db: Database.Database,
	startTime: number
): {
	overall: DurationPercentiles;
	byAgent: Record<string, DurationPercentiles>;
} {
	const perfStart = perfMetrics.start();
	const rows = db
		.prepare(
			`
      SELECT agent_type, duration
      FROM query_events
      WHERE start_time >= ?
      ORDER BY duration ASC
    `
		)
		.all(startTime) as Array<{ agent_type: string; duration: number }>;

	// Overall: rows are globally sorted by duration already.
	const overall = percentilesFromSorted(rows.map((r) => r.duration));

	// Per agent: collect each agent's durations preserving ascending order.
	const perAgentSorted: Record<string, number[]> = {};
	for (const row of rows) {
		(perAgentSorted[row.agent_type] ??= []).push(row.duration);
	}
	const byAgent: Record<string, DurationPercentiles> = {};
	for (const [agent, durations] of Object.entries(perAgentSorted)) {
		byAgent[agent] = percentilesFromSorted(durations);
	}

	perfMetrics.end(perfStart, 'getAggregatedStats:durationPercentiles', {
		sampleCount: rows.length,
	});
	return { overall, byAgent };
}

/**
 * Auto Run task duration distribution (per individual task, which is the
 * closest analog to a single "run" and yields far more samples than the
 * batch-level `auto_run_sessions`).
 */
function queryAutoRunTaskPercentiles(
	db: Database.Database,
	startTime: number
): DurationPercentiles {
	const perfStart = perfMetrics.start();
	const rows = db
		.prepare(
			`
      SELECT duration
      FROM auto_run_tasks
      WHERE start_time >= ?
      ORDER BY duration ASC
    `
		)
		.all(startTime) as Array<{ duration: number }>;
	perfMetrics.end(perfStart, 'getAggregatedStats:autoRunTaskPercentiles', {
		sampleCount: rows.length,
	});
	return rows.length > 0 ? percentilesFromSorted(rows.map((r) => r.duration)) : emptyPercentiles();
}

// ============================================================================
// Orchestrator
// ============================================================================

/**
 * Get aggregated statistics for a time range.
 *
 * Composes results from focused sub-query functions for readability
 * and independent testability.
 */
export function getAggregatedStats(db: Database.Database, range: StatsTimeRange): StatsAggregation {
	const perfStart = perfMetrics.start();
	const startTime = getTimeRangeStart(range);

	const totals = queryTotals(db, startTime);
	const byAgent = queryByAgent(db, startTime);
	const bySource = queryBySource(db, startTime);
	const byLocation = queryByLocation(db, startTime);
	const byDay = queryByDay(db, startTime);
	const byAgentByDay = queryByAgentByDay(db, startTime);
	const byHour = queryByHour(db, startTime);
	const sessionStats = querySessionStats(db, startTime);
	const bySessionByDay = queryBySessionByDay(db, startTime);
	const bySessionSource = queryBySessionSource(db, startTime);
	const worktreeStatus = queryByWorktreeStatus(db, startTime);
	const durationPercentiles = queryDurationPercentiles(db, startTime);
	const autoRunTaskDurationPercentiles = queryAutoRunTaskPercentiles(db, startTime);
	const imageAnnotations = countImageAnnotationsSince(db, startTime);
	const multiWindowUsage = getMultiWindowUsageStats(db, range);

	const totalDuration = perfMetrics.end(perfStart, 'getAggregatedStats:total', {
		range,
		totalQueries: totals.count,
	});

	// Log warning if the aggregation is slow
	if (totalDuration > PERFORMANCE_THRESHOLDS.DASHBOARD_LOAD) {
		logger.warn(
			`getAggregatedStats took ${totalDuration.toFixed(0)}ms (threshold: ${PERFORMANCE_THRESHOLDS.DASHBOARD_LOAD}ms)`,
			LOG_CONTEXT,
			{ range, totalQueries: totals.count }
		);
	}

	return {
		totalQueries: totals.count,
		totalDuration: totals.total_duration,
		avgDuration: totals.count > 0 ? Math.round(totals.total_duration / totals.count) : 0,
		queryDurationPercentiles: durationPercentiles.overall,
		queryDurationPercentilesByAgent: durationPercentiles.byAgent,
		autoRunTaskDurationPercentiles,
		byAgent,
		bySource,
		byDay,
		byLocation,
		byHour,
		...sessionStats,
		byAgentByDay,
		bySessionByDay,
		bySessionSource,
		worktreeQueries: worktreeStatus.worktreeQueries,
		parentQueries: worktreeStatus.parentQueries,
		byWorktreeStatus: worktreeStatus.byWorktreeStatus,
		imageAnnotations,
		multiWindowUsage,
	};
}
