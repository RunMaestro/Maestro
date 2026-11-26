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
import type { UsageAccounting, UsageBreakdown } from './types';
import type { TokenSpeedBucket, TokenSpeedGranularity, TokenSpeedSummary } from './tokenSpeed';
import type { StatsTimeRange } from './stats-types';
import { getTimeRangeStart } from './statsTimeRange';

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

/** Account key for agents with no multi-account concept (everything but Claude today). */
export const DEFAULT_ACCOUNT_KEY = 'default';

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
	 * Legacy normalized id, or the raw id when canonical accounting is available.
	 * Empty string when the transcript carried no model id.
	 */
	model: string;
	/** Native identity, before pricing aliases or normalization. */
	rawModel?: string;
	/** Canonical detail; numeric fields below are compatibility projections. */
	accounting?: UsageBreakdown;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	/**
	 * Numeric projection of accounting.cost when present (zero if unavailable).
	 * Legacy providers retain reported or rate-table amounts; consult accounting
	 * before interpreting a numeric zero as measured free usage.
	 */
	costUsd: number;
	/** True when `costUsd` was estimated from the rate table, not provider-reported. */
	costEstimated: boolean;
}

/**
 * Token fields are ADDITIVE across providers: `inputTokens` is fresh
 * (uncached) input only, and `cacheReadTokens` / `cacheCreationTokens` are
 * separate, so `input + output + cacheRead + cacheCreation` is every token a
 * session moved, once. Claude reports usage that way already. Codex counts its
 * cached tokens INSIDE `input_tokens`; the token-usage accessor subtracts them
 * before a Codex session reaches any of these shapes (its cost is computed
 * from the raw Codex counts first, so pricing is unaffected).
 *
 * One session's token consumption, split by model. Produced by the token-usage
 * accessor from a single on-disk transcript and cached per source-file
 * fingerprint. Native lifetime totals are authoritative; `byModel` may be partial.
 */
export interface SessionTokenBreakdown {
	/** Provider session id (e.g. Claude's `session_id`) the totals were read from. */
	sessionId: string;
	agentType: string;
	projectPath: string;
	/**
	 * Which provider account produced this session. For Claude this is the
	 * canonical `CLAUDE_CONFIG_DIR` path (users run several Max accounts from
	 * separate `~/.claude*` homes, and each writes its own transcript tree).
	 * Agents without a multi-account concept use {@link DEFAULT_ACCOUNT_KEY}.
	 */
	accountKey: string;
	/** Latest activity timestamp (ms since epoch); drives time bucketing. 0 if unknown. */
	timestampMs: number;
	/**
	 * How the session was started, when the storage records it. Feeds the Source
	 * Distribution chart's token mode; sessions with no recorded origin are left
	 * out of that split rather than guessed at.
	 */
	origin?: 'user' | 'auto' | 'relay';
	byModel: ModelTokenUsage[];
	/** Native lifetime evidence, including model/child detail already in the totals. */
	accounting?: UsageAccounting;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	/** Compatibility projection; canonical cost evidence takes precedence. */
	costUsd: number;
	/** True when any contributing model bucket was rate-table estimated. */
	costEstimated: boolean;
	coverage: TokenCoverage;
	/** Per-call throughput buckets, when the agent's transcript times its calls. */
	speed?: TokenSpeedBucket[];
}

/** Rolled-up token + cost totals over an arbitrary set of sessions/models. */
export interface TokenUsageTotals {
	/** Aggregate evidence without claiming a single native session as its source. */
	accounting?: Pick<UsageAccounting, 'completeness' | 'cost'>;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	/** Compatibility projection; canonical cost evidence takes precedence. */
	costUsd: number;
	/** True when any part of `costUsd` was rate-table estimated. */
	costEstimated: boolean;
	sessionCount: number;
}

/** A named group of totals (one agent, one model, or one project). */
export interface TokenUsageGroup extends TokenUsageTotals {
	/** Stable key: agent, legacy model, provider/raw-model tuple, account or project. */
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
	/**
	 * Per-provider-account totals - for Claude, one entry per Max account
	 * (`CLAUDE_CONFIG_DIR`). Single `default` entry for single-account agents.
	 */
	byAccount: TokenUsageGroup[];
	timeline: TokenUsageTimeBucket[];
	/**
	 * Token counts bucketed to match `StatsAggregation`'s shapes, so the existing
	 * dashboard charts can add a Tokens metric mode.
	 */
	series: TokenSeries;
	/**
	 * Tokens per second, measured per API call. Bucketed by the hour each call
	 * finished, so unlike the session totals above it is NOT attributed to a
	 * session's last activity.
	 */
	speed: TokenSpeedSummary;
	coverageByAgent: Record<string, TokenCoverage>;
	/**
	 * What the totals leave out: agent types Maestro has run that have no
	 * readable transcript storage, and the agents whose conversations are on
	 * another computer that could not be read this time. The Tokens tab states
	 * both, so a total is never read as covering every agent.
	 */
	excluded: TokenUsageExclusions;
	/** Slice size of `timeline` (and of `speed.timeline`, which uses the same). */
	granularity: TokenTimelineGranularity;
	/**
	 * The window `timeline` spans (ms since epoch): the query's `sinceMs`, or for
	 * All Time the earliest activity seen, through now. `timeline` has one entry
	 * per slice of it, idle slices included.
	 */
	windowStartMs: number;
	windowEndMs: number;
	/** When the aggregate was computed (ms since epoch). */
	generatedAtMs: number;
}

export interface TokenUsageExclusions {
	/** Agent types with recorded activity but no transcript storage to read. */
	unsupportedAgents: string[];
	/**
	 * Distinct remote agent type + project pairs from the activity record that
	 * belong to no stored agent (an agent since removed), so nothing can ask the
	 * computer they ran on.
	 */
	remoteProjects: number;
	/**
	 * Names of the agents whose conversations are on another computer that could
	 * not be read this time (no host there, an older host, a provider the host
	 * cannot read, or no answer in time). Every other such agent is counted.
	 */
	notCountedAgents: string[];
	/**
	 * Names of the agents whose conversations are on another computer that have
	 * not been counted yet: their computer is being asked now, and the totals
	 * leave them out until it answers.
	 */
	pendingAgents?: string[];
	/**
	 * True while the count of the agents on another computer is being refreshed
	 * in the background. A reader that wants those numbers reads again with
	 * `waitForRemote` (the dashboard does, and fills them in when they land).
	 */
	remoteRefreshing?: boolean;
	/**
	 * Agents whose totals are counted but short: some of their conversations
	 * have transcripts too large or unreadable (here or on another computer), and
	 * `conversations` says how many are left out.
	 */
	partialAgents?: Array<{ name: string; conversations: number }>;
	/**
	 * Agents (or folders, when no agent works there now) of this machine whose conversations could
	 * not be listed at all (an account or folder that failed to read): left out of the totals.
	 */
	unreadAgents?: string[];
}

/**
 * Token counts bucketed the same ways `StatsAggregation` buckets queries and
 * duration, so the dashboard charts can offer a "Tokens" metric mode alongside
 * their existing Queries/Time (or Count/Duration) toggles without each chart
 * re-deriving its own grouping.
 *
 * Fidelity note: a session's tokens are attributed to its LAST-ACTIVITY
 * timestamp, because that is the one timestamp the per-session transcript parse
 * yields. Sessions that span several days therefore land wholly on their final
 * day/hour. Most sessions are short, so day-level series are close to exact;
 * `byHour` is the coarsest of these and should be read as "when sessions
 * finished", not "when every token was spent".
 */
export interface TokenSeries {
	/** Total tokens keyed by local `YYYY-MM-DD`. */
	byDay: Record<string, number>;
	/** Total tokens keyed by local hour-of-day (`'0'`-`'23'`). */
	byHour: Record<string, number>;
	/** Tokens per agent type, then per local `YYYY-MM-DD`. */
	byAgentByDay: Record<string, Record<string, number>>;
	/**
	 * Tokens per PROVIDER session id, then per local `YYYY-MM-DD`. The renderer
	 * joins these onto Maestro agents via each agent's tab `agentSessionId`s,
	 * since only the renderer knows that mapping.
	 */
	bySessionByDay: Record<string, Record<string, number>>;
	/** Tokens split by how the session was started (sessions with no origin are excluded). */
	bySource: { user: number; auto: number };
}

/**
 * Bucket granularity for the timeline series. The same type (and the same
 * span rule, `tokenGranularityFor`) as the speed timeline, so the two charts
 * on the Tokens tab always slice time alike.
 */
export type TokenTimelineGranularity = TokenSpeedGranularity;

/** Request options for a token-usage aggregate. */
export interface TokenUsageQuery {
	/** Inclusive lower bound on session activity (ms since epoch). Omit for all-time. */
	sinceMs?: number;
	/** Inclusive upper bound on session activity (ms since epoch). Omit for now. */
	untilMs?: number;
	/**
	 * Timeline bucket granularity. Omitted, it is picked from the window's span
	 * (`tokenGranularityFor`), which is what the dashboard does.
	 */
	granularity?: TokenTimelineGranularity;
}

/**
 * The token-usage query for a dashboard time range. One definition so the
 * Tokens tab, the Overview speed cards, the chart Tokens modes, and
 * `maestro-cli stats-tokens` all read the same window. The window is
 * calendar-aligned (`getTimeRangeStart`), and the granularity is left to the
 * accessor so All Time is sliced by the history it actually has.
 */
export function tokenUsageQueryForRange(
	range: StatsTimeRange,
	nowMs: number = Date.now()
): TokenUsageQuery {
	if (range === 'all') return {};
	return { sinceMs: getTimeRangeStart(range, nowMs) };
}
