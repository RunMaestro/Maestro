/**
 * Stats Aggregation Queries
 *
 * Builds the Usage Dashboard's `StatsAggregation` for one time range from a
 * handful of grouped passes over `query_events`, then rolls each pass up in JS:
 *
 *   1. bounds        - first query ever, first prompt ever
 *   2. activity cube - per (day, hour, provider, source, remote, worktree)
 *   3. per agent     - per (agent, day, source), with tokens and last query
 *   4. percentiles   - nearest-rank durations picked in SQL (window functions)
 *   5. Auto Run task percentiles, prompt timestamps, streak days, annotations
 *
 * The result is memoized per range and reused until the database changes (any
 * write on this connection, or a commit from another one) or the local day
 * rolls over, so a reopened dashboard, an export and a CLI read in the same
 * minute cost one aggregation instead of three.
 */

import type Database from 'better-sqlite3';
import type {
	StatsTimeRange,
	StatsAggregation,
	SessionTokenTotals,
} from '../../shared/stats-types';
import { percentilesFromSorted, type DurationPercentiles } from '../../shared/percentiles';
import { PERFORMANCE_THRESHOLDS } from '../../shared/performance-metrics';
import {
	computePromptCadence,
	localDayStartMs,
	promptWindowStart,
	type PromptCadence,
} from '../../shared/promptCadence';
import { addLocalDays, toLocalYmd } from '../../shared/localDay';
import { fillDaySeries } from '../../shared/daySeries';
import { getTimeRangeStart, perfMetrics, LOG_CONTEXT, StatementCache } from './utils';
import { countImageAnnotationsSince } from './image-annotations';
import { logger } from '../utils/logger';

// ============================================================================
// Statement cache and memo
// ============================================================================

const stmtCache = new StatementCache();
/** The connection the cached statements and memo belong to. */
let cachedDb: Database.Database | null = null;

interface AggregationMemo {
	/** Database state + local day the results were computed against. */
	key: string;
	byRange: Map<StatsTimeRange, StatsAggregation>;
	/** Range-independent: streak over all history. */
	streak?: StatsAggregation['streak'];
}

let memo: AggregationMemo | null = null;

function stmt(db: Database.Database, sql: string): Database.Statement {
	if (cachedDb !== db) {
		// A new connection (startup, corruption recovery, tests): statements and
		// results computed against the old one are meaningless now.
		stmtCache.clear();
		memo = null;
		cachedDb = db;
	}
	return stmtCache.get(db, sql);
}

/**
 * Drop cached statements and memoized results. Called when the database is
 * closed; results also invalidate on their own when the data changes.
 */
export function clearAggregationCache(): void {
	stmtCache.clear();
	memo = null;
	cachedDb = null;
}

/**
 * What the memo is valid for. `total_changes()` moves on every INSERT, UPDATE
 * or DELETE made through this connection (the query buffer flush, Auto Run
 * writes, everything); `data_version` moves when another connection commits
 * (a repair script). The day is part of the key because every range is
 * calendar-aligned to today.
 */
function memoKey(db: Database.Database, now: number): string {
	const changes = (stmt(db, 'SELECT total_changes() AS n').get() as { n: number } | undefined)?.n;
	const dataVersion = db.pragma('data_version', { simple: true });
	return `${String(changes)}:${String(dataVersion)}:${toLocalYmd(now)}`;
}

// ============================================================================
// SQL fragments
// ============================================================================

const LOCAL_DAY = `date(start_time / 1000, 'unixepoch', 'localtime')`;
const LOCAL_HOUR = `CAST(strftime('%H', start_time / 1000, 'unixepoch', 'localtime') AS INTEGER)`;

/** The percentiles `percentilesFromSorted` reads, besides min (rank 0) and max (rank n-1). */
const PERCENTILE_POINTS = [50, 75, 90, 95, 99] as const;

/**
 * SQL predicate: `rank` (0-based) is one of the indices `percentilesFromSorted`
 * reads from an ascending list of `n` values. Mirrors `percentileOfSorted`:
 * `min(n - 1, floor(p / 100 * n))`. Same doubles on both sides (`p / 100` is
 * correctly rounded in JS and written out as the literal here), so SQL and JS
 * always pick the same rank.
 */
function percentileRankPredicate(rank: string, n: string): string {
	const ranks = [
		'0',
		`${n} - 1`,
		...PERCENTILE_POINTS.map((p) => `MIN(${n} - 1, CAST(${p / 100} * ${n} AS INTEGER))`),
	];
	return `${rank} IN (${ranks.join(', ')})`;
}

/**
 * A distribution from the handful of ranked values SQL returned. The array is
 * sparse on purpose: it is `n` long with only the ranks `percentilesFromSorted`
 * reads filled in, so the canonical helper does the picking and nothing here
 * re-derives its index rule.
 */
function percentilesFromRanks(n: number, ranked: Map<number, number>): DurationPercentiles {
	const sparse = new Array<number>(n);
	for (const [rank, value] of ranked) sparse[rank] = value;
	return percentilesFromSorted(sparse);
}

// ============================================================================
// Pass 1: bounds
// ============================================================================

interface Bounds {
	/** First query of any kind. */
	firstQueryAt: number | null;
	/** First interactive (non Auto Run) query: where the prompt cadence can start. */
	firstPromptAt: number | null;
}

const BOUNDS_SQL = `
  SELECT MIN(start_time) AS first_query,
         (SELECT MIN(start_time) FROM query_events WHERE source != 'auto') AS first_prompt
  FROM query_events
`;

function queryBounds(db: Database.Database): Bounds {
	const row = stmt(db, BOUNDS_SQL).get() as
		| { first_query: number | null; first_prompt: number | null }
		| undefined;
	return {
		firstQueryAt: row?.first_query ?? null,
		firstPromptAt: row?.first_prompt ?? null,
	};
}

// ============================================================================
// Pass 2: activity cube
// ============================================================================

interface CubeRow {
	date: string;
	hour: number;
	agent_type: string;
	source: string;
	remote: number;
	worktree: number;
	count: number;
	duration: number;
}

/**
 * Positional GROUP BY: the `remote` / `worktree` aliases fold NULL (legacy
 * rows written before the flag existed) into 0, and grouping by position keeps
 * those folded values from being confused with the raw columns.
 */
const CUBE_SQL = `
  SELECT ${LOCAL_DAY} AS date,
         ${LOCAL_HOUR} AS hour,
         agent_type,
         source,
         CASE WHEN is_remote = 1 THEN 1 ELSE 0 END AS remote,
         CASE WHEN is_worktree = 1 THEN 1 ELSE 0 END AS worktree,
         COUNT(*) AS count,
         COALESCE(SUM(duration), 0) AS duration
  FROM query_events
  WHERE start_time >= ?
  GROUP BY 1, 2, 3, 4, 5, 6
`;

type Slice = { count: number; duration: number };
type DaySlice = { date: string } & Slice;

type CubeRollup = Pick<
	StatsAggregation,
	| 'byAgent'
	| 'bySource'
	| 'byLocation'
	| 'byHour'
	| 'byDayHour'
	| 'byAgentByDay'
	| 'byAgentWorktree'
	| 'worktreeQueries'
	| 'parentQueries'
> & {
	totalQueries: number;
	totalDuration: number;
	/** Sparse, ascending: days with at least one query. */
	activeDays: DaySlice[];
};

function addTo(slice: Slice, row: Slice): void {
	slice.count += row.count;
	slice.duration += row.duration;
}

function bucket<K>(map: Map<K, Slice>, key: K): Slice {
	let slice = map.get(key);
	if (!slice) {
		slice = { count: 0, duration: 0 };
		map.set(key, slice);
	}
	return slice;
}

function queryActivityCube(db: Database.Database, startTime: number): CubeRollup {
	const perfStart = perfMetrics.start();
	const rows = stmt(db, CUBE_SQL).all(startTime) as CubeRow[];

	let totalQueries = 0;
	let totalDuration = 0;
	const bySource = { user: 0, auto: 0 };
	const byLocation = { local: 0, remote: 0 };
	const byAgent: Record<string, Slice> = {};
	const byAgentWorktree: StatsAggregation['byAgentWorktree'] = {};
	const byDay = new Map<string, Slice>();
	const byHour = new Map<number, Slice>();
	const byDayHour = new Map<string, { date: string; hour: number } & Slice>();
	const byAgentDay = new Map<string, Map<string, Slice>>();
	let worktreeQueries = 0;
	let parentQueries = 0;

	for (const row of rows) {
		totalQueries += row.count;
		totalDuration += row.duration;
		if (row.source === 'auto') bySource.auto += row.count;
		else bySource.user += row.count;
		if (row.remote === 1) byLocation.remote += row.count;
		else byLocation.local += row.count;
		if (row.worktree === 1) worktreeQueries += row.count;
		else parentQueries += row.count;

		addTo((byAgent[row.agent_type] ??= { count: 0, duration: 0 }), row);
		const split = (byAgentWorktree[row.agent_type] ??= {
			worktree: { count: 0, duration: 0 },
			parent: { count: 0, duration: 0 },
		});
		addTo(row.worktree === 1 ? split.worktree : split.parent, row);

		addTo(bucket(byDay, row.date), row);
		addTo(bucket(byHour, row.hour), row);
		const cellKey = `${row.date}|${row.hour}`;
		let cell = byDayHour.get(cellKey);
		if (!cell) {
			cell = { date: row.date, hour: row.hour, count: 0, duration: 0 };
			byDayHour.set(cellKey, cell);
		}
		addTo(cell, row);
		let agentDays = byAgentDay.get(row.agent_type);
		if (!agentDays) {
			agentDays = new Map();
			byAgentDay.set(row.agent_type, agentDays);
		}
		addTo(bucket(agentDays, row.date), row);
	}

	const byAgentByDay: StatsAggregation['byAgentByDay'] = {};
	for (const agent of [...byAgentDay.keys()].sort()) {
		byAgentByDay[agent] = [...byAgentDay.get(agent)!.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([date, slice]) => ({ date, ...slice }));
	}

	const result: CubeRollup = {
		totalQueries,
		totalDuration,
		byAgent,
		bySource,
		byLocation,
		byHour: [...byHour.entries()]
			.sort(([a], [b]) => a - b)
			.map(([hour, slice]) => ({ hour, ...slice })),
		byDayHour: [...byDayHour.values()].sort(
			(a, b) => a.date.localeCompare(b.date) || a.hour - b.hour
		),
		byAgentByDay,
		byAgentWorktree,
		worktreeQueries,
		parentQueries,
		activeDays: [...byDay.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([date, slice]) => ({ date, ...slice })),
	};
	perfMetrics.end(perfStart, 'getAggregatedStats:activityCube', { groupCount: rows.length });
	return result;
}

// ============================================================================
// Pass 3: per agent
// ============================================================================

interface AgentRow {
	session_id: string;
	date: string;
	source: string;
	count: number;
	duration: number;
	last_query: number;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_creation_tokens: number;
	cost_usd: number;
	priced_queries: number;
}

/**
 * COALESCE inside the token SUMs so a mix of NULL and real rows totals the
 * real ones instead of returning NULL for the whole group. `priced_queries`
 * counts rows that reported ANY usage, which is how the dashboard can say
 * "cost covers 40 of 900 queries" rather than implying the total is complete:
 * every row written before migration v9 reports nothing.
 */
const PER_AGENT_SQL = `
  SELECT session_id,
         ${LOCAL_DAY} AS date,
         source,
         COUNT(*) AS count,
         COALESCE(SUM(duration), 0) AS duration,
         MAX(start_time) AS last_query,
         SUM(COALESCE(input_tokens, 0)) AS input_tokens,
         SUM(COALESCE(output_tokens, 0)) AS output_tokens,
         SUM(COALESCE(cache_read_tokens, 0)) AS cache_read_tokens,
         SUM(COALESCE(cache_creation_tokens, 0)) AS cache_creation_tokens,
         SUM(COALESCE(cost_usd, 0)) AS cost_usd,
         SUM(
           CASE WHEN input_tokens IS NOT NULL
                  OR output_tokens IS NOT NULL
                  OR cache_read_tokens IS NOT NULL
                  OR cache_creation_tokens IS NOT NULL
                  OR cost_usd IS NOT NULL
                THEN 1 ELSE 0 END
         ) AS priced_queries
  FROM query_events
  WHERE start_time >= ?
  GROUP BY 1, 2, 3
`;

type AgentRollup = Pick<
	StatsAggregation,
	'totalSessions' | 'bySessionByDay' | 'bySessionSource' | 'bySessionLastQuery' | 'bySessionTokens'
>;

function queryPerAgent(db: Database.Database, startTime: number): AgentRollup {
	const perfStart = perfMetrics.start();
	const rows = stmt(db, PER_AGENT_SQL).all(startTime) as AgentRow[];

	const days = new Map<string, Map<string, Slice>>();
	const bySessionSource: StatsAggregation['bySessionSource'] = {};
	const bySessionLastQuery: StatsAggregation['bySessionLastQuery'] = {};
	const tokens = new Map<string, SessionTokenTotals>();

	for (const row of rows) {
		const id = row.session_id;
		let agentDays = days.get(id);
		if (!agentDays) {
			agentDays = new Map();
			days.set(id, agentDays);
		}
		addTo(bucket(agentDays, row.date), row);

		const split = (bySessionSource[id] ??= { user: 0, auto: 0 });
		if (row.source === 'auto') split.auto += row.count;
		else split.user += row.count;

		bySessionLastQuery[id] = Math.max(bySessionLastQuery[id] ?? 0, row.last_query);

		const total = tokens.get(id) ?? {
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
			costUsd: 0,
			pricedQueries: 0,
		};
		total.inputTokens += row.input_tokens;
		total.outputTokens += row.output_tokens;
		total.cacheReadTokens += row.cache_read_tokens;
		total.cacheCreationTokens += row.cache_creation_tokens;
		total.costUsd += row.cost_usd;
		total.pricedQueries += row.priced_queries;
		tokens.set(id, total);
	}

	const bySessionByDay: StatsAggregation['bySessionByDay'] = {};
	for (const id of [...days.keys()].sort()) {
		bySessionByDay[id] = [...days.get(id)!.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([date, slice]) => ({ date, ...slice }));
	}

	// Agents that never reported usage are omitted entirely, so consumers can
	// tell "no data" from "zero" without inspecting the numbers.
	const bySessionTokens: StatsAggregation['bySessionTokens'] = {};
	for (const [id, total] of tokens) {
		if (total.pricedQueries > 0) bySessionTokens[id] = total;
	}

	perfMetrics.end(perfStart, 'getAggregatedStats:perAgent', { agentCount: days.size });
	return {
		totalSessions: days.size,
		bySessionByDay,
		bySessionSource,
		bySessionLastQuery,
		bySessionTokens,
	};
}

// ============================================================================
// Pass 4: duration percentiles
// ============================================================================

/**
 * SQLite has no PERCENTILE_CONT, so the ranks are numbered with window
 * functions and only the rows at a percentile rank come back: a few dozen rows
 * whatever the range, instead of every duration in it.
 */
const QUERY_PERCENTILES_SQL = `
  WITH ranked AS (
    SELECT agent_type,
           duration,
           ROW_NUMBER() OVER (ORDER BY duration) - 1 AS overall_rank,
           COUNT(*) OVER () AS overall_n,
           ROW_NUMBER() OVER (PARTITION BY agent_type ORDER BY duration) - 1 AS agent_rank,
           COUNT(*) OVER (PARTITION BY agent_type) AS agent_n
    FROM query_events
    WHERE start_time >= ?
  )
  SELECT agent_type, duration, overall_rank, overall_n, agent_rank, agent_n
  FROM ranked
  WHERE ${percentileRankPredicate('overall_rank', 'overall_n')}
     OR ${percentileRankPredicate('agent_rank', 'agent_n')}
`;

function queryDurationPercentiles(
	db: Database.Database,
	startTime: number
): { overall: DurationPercentiles; byAgent: Record<string, DurationPercentiles> } {
	const perfStart = perfMetrics.start();
	const rows = stmt(db, QUERY_PERCENTILES_SQL).all(startTime) as Array<{
		agent_type: string;
		duration: number;
		overall_rank: number;
		overall_n: number;
		agent_rank: number;
		agent_n: number;
	}>;

	const overallRanks = new Map<number, number>();
	let overallN = 0;
	const agents = new Map<string, { n: number; ranks: Map<number, number> }>();
	for (const row of rows) {
		overallN = row.overall_n;
		overallRanks.set(row.overall_rank, row.duration);
		let agent = agents.get(row.agent_type);
		if (!agent) {
			agent = { n: row.agent_n, ranks: new Map() };
			agents.set(row.agent_type, agent);
		}
		agent.ranks.set(row.agent_rank, row.duration);
	}

	const byAgent: Record<string, DurationPercentiles> = {};
	for (const [agentType, agent] of agents) {
		byAgent[agentType] = percentilesFromRanks(agent.n, agent.ranks);
	}
	perfMetrics.end(perfStart, 'getAggregatedStats:durationPercentiles', { sampleCount: overallN });
	return { overall: percentilesFromRanks(overallN, overallRanks), byAgent };
}

/**
 * Auto Run task duration distribution (per individual task, which is the
 * closest analog to a single "run" and yields far more samples than the
 * batch-level `auto_run_sessions`).
 */
const TASK_PERCENTILES_SQL = `
  WITH ranked AS (
    SELECT duration,
           ROW_NUMBER() OVER (ORDER BY duration) - 1 AS task_rank,
           COUNT(*) OVER () AS task_n
    FROM auto_run_tasks
    WHERE start_time >= ?
  )
  SELECT duration, task_rank, task_n
  FROM ranked
  WHERE ${percentileRankPredicate('task_rank', 'task_n')}
`;

function queryAutoRunTaskPercentiles(
	db: Database.Database,
	startTime: number
): DurationPercentiles {
	const perfStart = perfMetrics.start();
	const rows = stmt(db, TASK_PERCENTILES_SQL).all(startTime) as Array<{
		duration: number;
		task_rank: number;
		task_n: number;
	}>;
	const ranks = new Map<number, number>();
	for (const row of rows) ranks.set(row.task_rank, row.duration);
	const n = rows[0]?.task_n ?? 0;
	perfMetrics.end(perfStart, 'getAggregatedStats:autoRunTaskPercentiles', { sampleCount: n });
	return percentilesFromRanks(n, ranks);
}

// ============================================================================
// Pass 5: prompt cadence
// ============================================================================

/**
 * Interactive turns only (`source != 'auto'`, the same split as
 * `delegation.ts`). Raw timestamps, one column, because the cadence measures
 * the gaps between consecutive prompts, which no day bucket can give.
 */
const PROMPT_TIMES_SQL = `
  SELECT start_time
  FROM query_events
  WHERE source != 'auto' AND start_time >= ?
`;

function queryPromptCadence(
	db: Database.Database,
	range: StatsTimeRange,
	firstPromptAt: number | null,
	now: number
): PromptCadence {
	const perfStart = perfMetrics.start();
	const windowStart = promptWindowStart(range, firstPromptAt, now);
	const timestamps = windowStart
		? (
				stmt(db, PROMPT_TIMES_SQL).all(localDayStartMs(windowStart)) as Array<{
					start_time: number;
				}>
			).map((row) => row.start_time)
		: [];
	const cadence = computePromptCadence({ timestamps, windowStart, now });
	perfMetrics.end(perfStart, 'getAggregatedStats:promptCadence', { promptCount: cadence.total });
	return cadence;
}

// ============================================================================
// Streak (all history)
// ============================================================================

const ACTIVE_DAYS_SQL = `
  SELECT DISTINCT ${LOCAL_DAY} AS date
  FROM query_events
  ORDER BY date ASC
`;

/**
 * Consecutive active days in an ascending, de-duplicated list of local
 * `YYYY-MM-DD` keys. `current` ends today, or yesterday when today has no
 * activity yet (a streak is not broken until a whole day passes without use).
 */
export function computeDayStreak(
	activeDays: readonly string[],
	today: string
): StatsAggregation['streak'] {
	let longest = 0;
	let run = 0;
	let previous: string | null = null;
	for (const day of activeDays) {
		run = previous !== null && addLocalDays(previous, 1) === day ? run + 1 : 1;
		longest = Math.max(longest, run);
		previous = day;
	}

	const active = new Set(activeDays);
	let cursor = active.has(today) ? today : addLocalDays(today, -1);
	let current = 0;
	while (active.has(cursor)) {
		current++;
		cursor = addLocalDays(cursor, -1);
	}
	return { current, longest };
}

function queryStreak(
	db: Database.Database,
	range: StatsTimeRange,
	cube: CubeRollup,
	today: string
): StatsAggregation['streak'] {
	// All Time already has every active day in the cube; any shorter range
	// would cut a streak at its window edge, so it reads the whole table.
	const days =
		range === 'all'
			? cube.activeDays.map((d) => d.date)
			: (stmt(db, ACTIVE_DAYS_SQL).all() as Array<{ date: string }>).map((row) => row.date);
	return computeDayStreak(days, today);
}

// ============================================================================
// Orchestrator
// ============================================================================

function computeAggregatedStats(
	db: Database.Database,
	range: StatsTimeRange,
	now: number,
	cachedStreak: StatsAggregation['streak'] | undefined
): StatsAggregation {
	const startTime = getTimeRangeStart(range, now);
	const today = toLocalYmd(now);

	const bounds = queryBounds(db);
	const cube = queryActivityCube(db, startTime);
	const agents = queryPerAgent(db, startTime);
	const durationPercentiles = queryDurationPercentiles(db, startTime);
	const autoRunTaskDurationPercentiles = queryAutoRunTaskPercentiles(db, startTime);
	const imageAnnotations = countImageAnnotationsSince(db, startTime);
	const prompts = queryPromptCadence(db, range, bounds.firstPromptAt, now);
	const streak = cachedStreak ?? queryStreak(db, range, cube, today);

	// All Time opens on the day of the first query; a bounded range on its
	// calendar start. Never after today, whatever a skewed clock wrote.
	const rangeStartYmd =
		range === 'all'
			? bounds.firstQueryAt !== null
				? toLocalYmd(bounds.firstQueryAt)
				: today
			: toLocalYmd(startTime);
	const window = { startYmd: rangeStartYmd < today ? rangeStartYmd : today, endYmd: today };

	return {
		totalQueries: cube.totalQueries,
		totalDuration: cube.totalDuration,
		avgDuration: cube.totalQueries > 0 ? Math.round(cube.totalDuration / cube.totalQueries) : 0,
		queryDurationPercentiles: durationPercentiles.overall,
		queryDurationPercentilesByAgent: durationPercentiles.byAgent,
		autoRunTaskDurationPercentiles,
		byAgent: cube.byAgent,
		bySource: cube.bySource,
		byDay: fillDaySeries(cube.activeDays, window.startYmd, window.endYmd, (date) => ({
			date,
			count: 0,
			duration: 0,
		})),
		byDayHour: cube.byDayHour,
		window,
		earliestQueryAt: bounds.firstQueryAt,
		streak,
		byLocation: cube.byLocation,
		byHour: cube.byHour,
		...agents,
		byAgentByDay: cube.byAgentByDay,
		worktreeQueries: cube.worktreeQueries,
		parentQueries: cube.parentQueries,
		byAgentWorktree: cube.byAgentWorktree,
		imageAnnotations,
		prompts,
	};
}

/**
 * Get aggregated statistics for a time range, served from the memo when the
 * database has not changed since the last call for that range today.
 */
export function getAggregatedStats(
	db: Database.Database,
	range: StatsTimeRange,
	now: number = Date.now()
): StatsAggregation {
	const key = memoKey(db, now);
	if (memo?.key !== key) {
		memo = { key, byRange: new Map() };
	}
	const cached = memo.byRange.get(range);
	if (cached) return cached;

	const perfStart = perfMetrics.start();
	const result = computeAggregatedStats(db, range, now, memo.streak);
	memo.streak = result.streak;
	memo.byRange.set(range, result);

	const totalDuration = perfMetrics.end(perfStart, 'getAggregatedStats:total', {
		range,
		totalQueries: result.totalQueries,
	});
	if (totalDuration > PERFORMANCE_THRESHOLDS.DASHBOARD_LOAD) {
		logger.warn(
			`getAggregatedStats took ${totalDuration.toFixed(0)}ms (threshold: ${PERFORMANCE_THRESHOLDS.DASHBOARD_LOAD}ms)`,
			LOG_CONTEXT,
			{ range, totalQueries: result.totalQueries }
		);
	}
	return result;
}
