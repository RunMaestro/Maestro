/**
 * Type definitions for the Cue stats aggregation system.
 *
 * Shared between the main process aggregation query (src/main/cue/stats/)
 * and the renderer dashboard component that consumes the IPC payload.
 */

export type CueStatsTimeRange = 'day' | 'week' | 'month' | 'quarter' | 'year' | 'all';

export interface CueStatsTotals {
	occurrences: number;
	successCount: number;
	failureCount: number;
	totalDurationMs: number;
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

export interface CueTimeBucket {
	bucketStartMs: number;
	occurrences: number;
	successCount: number;
	failureCount: number;
	inputTokens: number;
	outputTokens: number;
}

export interface CueStatsAggregation {
	timeRange: CueStatsTimeRange;
	windowStartMs: number;
	windowEndMs: number;
	totals: CueStatsTotals;
	byPipeline: CueStatsByGroup[];
	byAgent: CueStatsByGroup[];
	bySubscription: CueStatsByGroup[];
	chains: CueChain[];
	timeSeries: CueTimeBucket[];
	/** 3600000 for day/week, 86400000 for month+ */
	bucketSizeMs: number;
	/** e.g. "factory-droid sessions have no token data" */
	coverageWarnings: string[];
}
