/**
 * Token-usage shapes for the Cost & Tokens dashboard.
 *
 * These sit in `shared/` so the Electron main process (which reads each agent's
 * on-disk session transcripts and does the aggregation) and the renderer (which
 * renders the charts) speak the same vocabulary. No Electron imports here.
 *
 * Ground truth is each agent's own session storage, not the stats SQLite DB:
 * every storage already parses its transcript into per-session token totals, and
 * three of the five (claude, opencode, copilot) additionally know the model id
 * behind every usage record. The types below carry that per-model split all the
 * way to the UI. Cost math reuses `modelPricing.ts` (provider-reported cost when
 * present, rate-table estimate otherwise - flagged via `costEstimated`).
 */

import type { TokenCounts } from './modelPricing';

/**
 * Per-agent token coverage, mirroring the Cue accessor's classification so both
 * surfaces label partial data the same way.
 *
 * - `full` - all four token fields populated; cost present when the agent tracks
 *   it (claude-code, opencode), estimated from the rate table otherwise.
 * - `partial` - a structural gap: codex reports no cache-creation split and no
 *   cost; copilot-cli only emits tokens at `session.shutdown` (in-flight sessions
 *   read as zero).
 * - `unsupported` - agent has no readable on-disk token data.
 */
export type TokenCoverage = 'full' | 'partial' | 'unsupported';

/**
 * Token + cost totals for a single model within a session (or rolled up across
 * many sessions in an aggregate). The four token fields are structurally
 * compatible with {@link TokenCounts}, so this can be passed straight to
 * `calculateModelCost`.
 */
export interface ModelTokenUsage extends Required<
	Pick<TokenCounts, 'inputTokens' | 'outputTokens'>
> {
	/**
	 * Normalized model id (via `normalizeModelId`), e.g. `claude-opus-4-8`. Empty
	 * string when the transcript carried no model id (rare fallback bucket).
	 */
	model: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	/**
	 * USD cost for this model's tokens. Provider-reported when the agent tracks
	 * cost; otherwise computed from the `modelPricing` rate table.
	 */
	costUsd: number;
	/** True when `costUsd` was estimated from the rate table, not provider-reported. */
	costEstimated: boolean;
}

/**
 * One session's token consumption, split by model. Produced by the token-usage
 * accessor from a single on-disk transcript and cached per source-file
 * fingerprint. Session totals are the sum across `byModel`.
 */
export interface SessionTokenBreakdown {
	/** Provider session id (e.g. Claude's `session_id`) the totals were read from. */
	sessionId: string;
	agentType: string;
	projectPath: string;
	/** Latest activity timestamp (ms since epoch); drives time bucketing. 0 if unknown. */
	timestampMs: number;
	byModel: ModelTokenUsage[];
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	costUsd: number;
	/** True when any contributing model bucket was rate-table estimated. */
	costEstimated: boolean;
	coverage: TokenCoverage;
}

/** Rolled-up token + cost totals over an arbitrary set of sessions/models. */
export interface TokenUsageTotals {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	costUsd: number;
	/** True when any part of `costUsd` was rate-table estimated. */
	costEstimated: boolean;
	sessionCount: number;
}

/** A named group of totals (one agent, one model, or one project). */
export interface TokenUsageGroup extends TokenUsageTotals {
	/** Stable grouping key: agent id, normalized model id, or project path. */
	key: string;
	/** Human-facing label for the group. */
	label: string;
}

/** Totals within one time slice of the timeline. */
export interface TokenUsageTimeBucket extends TokenUsageTotals {
	/** Bucket start, ms since epoch. */
	startMs: number;
}

/**
 * The full dashboard payload: grand totals plus breakdowns by agent, model, and
 * project, a timeline, and the per-agent coverage map so the UI can flag which
 * groups carry partial (or estimated) data.
 */
export interface TokenUsageAggregate {
	totals: TokenUsageTotals;
	byAgent: TokenUsageGroup[];
	byModel: TokenUsageGroup[];
	byProject: TokenUsageGroup[];
	timeline: TokenUsageTimeBucket[];
	coverageByAgent: Record<string, TokenCoverage>;
	/** When the aggregate was computed (ms since epoch). */
	generatedAtMs: number;
}

/** Bucket granularity for the timeline series. */
export type TokenTimelineGranularity = 'day' | 'week' | 'month';

/** Request options for a token-usage aggregate. */
export interface TokenUsageQuery {
	/** Inclusive lower bound on session activity (ms since epoch). Omit for all-time. */
	sinceMs?: number;
	/** Inclusive upper bound on session activity (ms since epoch). Omit for now. */
	untilMs?: number;
	/** Timeline bucket granularity. Defaults to `day`. */
	granularity?: TokenTimelineGranularity;
}
