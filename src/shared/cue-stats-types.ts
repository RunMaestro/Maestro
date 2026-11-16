/**
 * Type definitions for the Cue stats aggregation system.
 *
 * Shared between the main process aggregation query (src/main/cue/stats/)
 * and the renderer dashboard component that consumes the IPC payload.
 */

import type { DurationPercentiles } from './percentiles';

export type CueStatsTimeRange = 'day' | 'week' | 'month' | 'quarter' | 'year' | 'all';

/** How many runs `CueStatsAggregation.slowestRuns` carries at most. */
export const CUE_SLOWEST_RUNS_LIMIT = 50;

export interface CueStatsTotals {
	/** Every run in the window, whatever its status. */
	occurrences: number;
	successCount: number;
	failureCount: number;
	/**
	 * Summed run time of COMPLETED runs only. A failed, timed-out or stopped
	 * run's `completed_at` can be the moment the next engine started (a crash
	 * swept it), so its span is not run time. Average with `timedRunCount`.
	 */
	totalDurationMs: number;
	/** Runs that contributed to `totalDurationMs` (completed runs with an end time). */
	timedRunCount: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheReadTokens: number;
	totalCacheCreationTokens: number;
	/** null when no agent in the window reported cost */
	totalCostUsd: number | null;
}

export interface CueStatsByGroup {
	/** pipeline name OR agent type OR subscription name */
	key: string;
	/** human-readable */
	label: string;
	totals: CueStatsTotals;
}

/**
 * One selectable entry in the Cue tab's trigger-type filter row.
 *
 * Counted over the FULL window, before `excludedTriggerTypes` is applied: the
 * filter row is the only way back once a trigger is hidden, so it has to keep
 * listing (and counting) the triggers the rest of the payload no longer sees.
 */
export interface CueTriggerTypeOption {
	/** Raw `cue_events.type`, e.g. `time.heartbeat`. */
	key: string;
	label: string;
	occurrences: number;
}

export interface CueChainNode {
	eventId: string;
	parentEventId: string | null;
	subscriptionName: string;
	pipelineId: string | null;
	agentType: string | null;
	status: string;
	startedAtMs: number;
	durationMs: number | null;
	inputTokens: number;
	outputTokens: number;
	costUsd: number | null;
}

export interface CueChain {
	rootId: string;
	rootSubscriptionName: string;
	/** includes the root */
	nodes: CueChainNode[];
	totals: CueStatsTotals;
}

/**
 * One finished run ranked by duration, for the Slowest Runs table. Covers every
 * terminal status (a run that timed out after 20 minutes is slow too), except
 * runs settled by the engine-start sweep, whose span is downtime.
 */
export interface CueSlowRun {
	eventId: string;
	subscriptionName: string;
	pipelineId: string | null;
	/** Provider id of the agent that ran it ('claude-code', ...), null when unknown. */
	agentType: string | null;
	/** 'completed' | 'failed' | 'timeout' | 'stopped' */
	status: string;
	startedAtMs: number;
	durationMs: number;
	/** Input + output tokens, 0 when the run produced none or none were attributed. */
	tokens: number;
}

/** The three Cue figures the Overview's source chart needs, without the full rollup. */
export interface CueStatsSourceTotals {
	occurrences: number;
	/** Run time of completed runs (see `CueStatsTotals.totalDurationMs`). */
	totalDurationMs: number;
	/** Input + output tokens. */
	tokens: number;
}

/**
 * One time bucket. The series is zero-filled: every bucket from the window's
 * first bucket (the first run's, for `all`) through the current one is present.
 */
export interface CueTimeBucket {
	bucketStartMs: number;
	occurrences: number;
	successCount: number;
	failureCount: number;
	inputTokens: number;
	outputTokens: number;
}

/**
 * One bucket of the 24-hour time-of-day distribution. `hour` is a local-timezone
 * hour in `[0, 23]`. Buckets with zero occurrences are still included so the
 * chart can render a continuous 24-bar strip without gap-filling on the
 * renderer side.
 */
export interface CueHourBucket {
	hour: number;
	occurrences: number;
	successCount: number;
	failureCount: number;
}

export interface CueStatsAggregation {
	timeRange: CueStatsTimeRange;
	windowStartMs: number;
	windowEndMs: number;
	totals: CueStatsTotals;
	/**
	 * Run duration distribution (p50/p75/p90/p95/p99/max) across every run
	 * with status `completed` in the window. Durations come from
	 * `completed_at - created_at`; failed, timed-out, stopped and in-flight
	 * runs are excluded, so `count` equals `totals.timedRunCount`.
	 */
	durationPercentiles: DurationPercentiles;
	/** Up to `CUE_SLOWEST_RUNS_LIMIT` finished runs, slowest first. */
	slowestRuns: CueSlowRun[];
	byPipeline: CueStatsByGroup[];
	/** Keyed by PROVIDER id (agent type), not by agent: label it "provider". */
	byAgent: CueStatsByGroup[];
	bySubscription: CueStatsByGroup[];
	/** Distribution by event trigger type (e.g. `file.changed`, `time.scheduled`). */
	byTriggerType: CueStatsByGroup[];
	/**
	 * Every trigger type seen in the window with its UNFILTERED occurrence
	 * count. Drives the filter row; unlike every other field here it ignores
	 * `excludedTriggerTypes`.
	 */
	triggerTypeOptions: CueTriggerTypeOption[];
	/**
	 * Trigger types the caller asked to drop, echoed back so the renderer can
	 * tell a stale response from a fresh one after toggling a chip.
	 */
	excludedTriggerTypes: string[];
	/** Always 24 entries, hour 0..23 in local time. */
	byHourOfDay: CueHourBucket[];
	chains: CueChain[];
	timeSeries: CueTimeBucket[];
	/** 3600000 for day/week, 86400000 for month+ */
	bucketSizeMs: number;
	/** e.g. "factory-droid sessions have no token data" */
	coverageWarnings: string[];
}
