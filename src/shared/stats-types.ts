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
	/** Account ID for per-account usage tracking */
	accountId?: string;
	/** Input tokens consumed by this query */
	inputTokens?: number;
	/** Output tokens produced by this query */
	outputTokens?: number;
	/** Cache read tokens for this query */
	cacheReadTokens?: number;
	/** Cache creation tokens for this query */
	cacheCreationTokens?: number;
	/** Estimated cost in USD for this query */
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
 * Database schema version for migrations
 */
export const STATS_DB_VERSION = 9;
