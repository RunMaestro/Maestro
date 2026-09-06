/**
 * Type definitions for the stats tracking system
 *
 * These types are shared between main process (stats/) and renderer (dashboard).
 */

import type { DurationPercentiles } from './percentiles';

/**
 * A single AI query event - represents one user/auto message -> AI response cycle
 */
export interface QueryEvent {
	id: string;
	sessionId: string;
	agentType: string;
	source: 'user' | 'auto';
	startTime: number;
	duration: number;
	projectPath?: string;
	tabId?: string;
	/** Whether this query was executed on a remote SSH session */
	isRemote?: boolean;
	/** Whether this query came from a worktree session (child of a parent agent) */
	isWorktree?: boolean;
	/**
	 * Per-turn token and cost usage, when the provider reported any.
	 *
	 * These are DELTAS for the single turn this row represents, not the running
	 * session totals - `Session.usageStats` accumulates for the life of the
	 * agent, so writing that value here would multiply-count every turn. The
	 * renderer drains a per-turn ledger (`turnUsageLedger`) at exit and passes
	 * the difference.
	 *
	 * All of them are absent for rows recorded before the columns existed, and
	 * for providers that report no usage at all - which is why the aggregation
	 * counts priced queries separately rather than assuming zero means free.
	 */
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheCreationTokens?: number;
	/** Cost in USD for this turn, when the provider reports one. */
	costUsd?: number;
}

/**
 * An Auto Run session - a complete batch processing run of a document
 */
export interface AutoRunSession {
	id: string;
	sessionId: string;
	agentType: string;
	documentPath?: string;
	startTime: number;
	duration: number;
	tasksTotal?: number;
	tasksCompleted?: number;
	projectPath?: string;
}

/**
 * A single task within an Auto Run session
 */
export interface AutoRunTask {
	id: string;
	autoRunSessionId: string;
	sessionId: string;
	agentType: string;
	taskIndex: number;
	taskContent?: string;
	startTime: number;
	duration: number;
	success: boolean;
}

/**
 * Session lifecycle event - tracks when sessions are created and closed
 */
export interface SessionLifecycleEvent {
	id: string;
	sessionId: string;
	agentType: string;
	projectPath?: string;
	createdAt: number;
	closedAt?: number;
	/** Duration in ms (computed from closedAt - createdAt when session is closed) */
	duration?: number;
	/** Whether this was a remote SSH session */
	isRemote?: boolean;
	/** Whether this session is a worktree (child of a parent agent) */
	isWorktree?: boolean;
}

/**
 * Time range for querying stats
 */
export type StatsTimeRange = 'day' | 'week' | 'month' | 'quarter' | 'year' | 'all';

/**
 * Aggregated stats for dashboard display
 */
export interface StatsAggregation {
	totalQueries: number;
	totalDuration: number;
	avgDuration: number;
	/** Query duration distribution (p50/p75/p90/p95/p99/max) across all queries. */
	queryDurationPercentiles: DurationPercentiles;
	/** Per-agent query duration distribution, keyed by agent type. */
	queryDurationPercentilesByAgent: Record<string, DurationPercentiles>;
	/** Auto Run task duration distribution (per-task, not per-session). */
	autoRunTaskDurationPercentiles: DurationPercentiles;
	byAgent: Record<string, { count: number; duration: number }>;
	bySource: { user: number; auto: number };
	byDay: Array<{ date: string; count: number; duration: number }>;
	/** Breakdown by session location (local vs SSH remote) */
	byLocation: { local: number; remote: number };
	/** Breakdown by hour of day (0-23) for peak hours chart */
	byHour: Array<{ hour: number; count: number; duration: number }>;
	/** Total unique sessions launched in the time period */
	totalSessions: number;
	/** Sessions by agent type */
	sessionsByAgent: Record<string, number>;
	/** Sessions launched per day */
	sessionsByDay: Array<{ date: string; count: number }>;
	/** Average session duration in ms (for closed sessions) */
	avgSessionDuration: number;
	/** Queries and duration by provider per day (for provider comparison) */
	byAgentByDay: Record<string, Array<{ date: string; count: number; duration: number }>>;
	/** Queries and duration by Maestro session per day (for agent usage chart) */
	bySessionByDay: Record<string, Array<{ date: string; count: number; duration: number }>>;
	/** User vs auto query counts per Maestro session (for per-card auto% on the dashboard) */
	bySessionSource: Record<string, { user: number; auto: number }>;
	/**
	 * Epoch ms of the most recent query per Maestro session, scoped to the
	 * selected range. Day-bucketed `bySessionByDay` can only order agents to the
	 * nearest calendar day, so the "Recent" sort reads this instead.
	 */
	bySessionLastQuery: Record<string, number>;
	/**
	 * Token and cost totals per Maestro session, for agent and group cost
	 * rollups. `pricedQueries` is how many of that session's rows actually
	 * carried usage data: rows written before the token columns landed report
	 * none, so a session can show a large query count against a small priced
	 * count, and the UI must not present the total as if it covered every turn.
	 */
	bySessionTokens: Record<string, SessionTokenTotals>;
	/** Count of queries originating from worktree (child) agents */
	worktreeQueries: number;
	/** Count of queries originating from parent (non-worktree) agents */
	parentQueries: number;
	/** Detailed worktree breakdown including duration totals (for activity split bar) */
	byWorktreeStatus: {
		worktree: { count: number; duration: number };
		parent: { count: number; duration: number };
	};
	/** Number of image annotations saved in the time range */
	imageAnnotations: number;
}

/**
 * Token and cost totals for one Maestro session within a time range.
 */
export interface SessionTokenTotals {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	costUsd: number;
	/** Number of queries in the range that reported any token usage. */
	pricedQueries: number;
}

/**
 * Filters for querying stats
 */
export interface StatsFilters {
	agentType?: string;
	source?: 'user' | 'auto';
	projectPath?: string;
	sessionId?: string;
}

/**
 * One day of shortcut usage. `date` is the local-time YYYY-MM-DD bucket; `count`
 * is the total number of shortcuts fired that day across the whole app.
 */
export interface ShortcutUsageDay {
	date: string;
	count: number;
}

/**
 * Aggregate multi-window usage over a time range. `windowsOpened` is the number
 * of secondary windows spawned (the multi-window action - the always-present
 * primary window is not counted); `peakConcurrent` is the maximum number of
 * windows open simultaneously (counting the primary), so a value below 2 means
 * the user never ran more than one window. Aggregate counters only - no agent or
 * window identifiers are stored.
 */
export interface MultiWindowUsage {
	windowsOpened: number;
	peakConcurrent: number;
}

/**
 * An Agent Resilience outage, recorded once when it RESOLVES (never while
 * counting down). One row per outage, not per retry attempt - the question the
 * dashboard answers is "how often did Maestro carry my work across a wall",
 * and an outage that took 3 retries is still one carried outage.
 */
export interface ResilienceEvent {
	id: string;
	/** Maestro agent (Session.id) the outage happened on. */
	sessionId: string;
	/** Provider id ('claude-code', 'codex', ...). */
	agentType: string;
	/** What we were waiting out. */
	strategy: 'availability' | 'token-exhaustion';
	/** 'recovered' = the auto-resend went through; 'stopped' = the user gave up or moved on. */
	outcome: 'recovered' | 'stopped';
	/** Epoch ms of the first failure. */
	startedAt: number;
	/** Epoch ms the outage resolved. */
	resolvedAt: number;
	/** Auto-retries dispatched during the outage. */
	retries: number;
}

/**
 * Database schema version for migrations
 */
export const STATS_DB_VERSION = 9;
