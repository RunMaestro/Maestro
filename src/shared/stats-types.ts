/**
 * Type definitions for the stats tracking system
 *
 * These types are shared between main process (stats/) and renderer (dashboard).
 */

import type { DurationPercentiles } from './percentiles';
import type { ModelTier } from './tierLevels';
import type { PromptCadence } from './promptCadence';

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
	 * Web Login account that sent the turn (username). Absent for turns typed at
	 * the desktop, which is every turn when Web Login is off.
	 */
	userName?: string;
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
	/**
	 * The Run on source this turn launched on (`RunOnSourceTarget`): the
	 * endpoint's id (`maestro-server` for the Maestro model server) and the model
	 * name that source serves. Set together. Both absent for a turn on the
	 * provider's own model, and for rows recorded before the columns existed.
	 */
	runOnEndpoint?: string;
	runOnModel?: string;
	/**
	 * The tier the Auto router chose for this turn. Absent when the turn was not
	 * sent on Auto, and when no router decided. It is the router's answer, not
	 * always the launch: a session kept on its model while its cache is warm
	 * records the tier and still runs where `runOnEndpoint` says.
	 */
	routedTier?: ModelTier;
}

/**
 * Which Auto Run engine produced a run.
 *
 * - `goal-driven`: free-text goal pursuit (`useGoalRunner`).
 * - `spec-driven`: the classic document/checkbox run (`useBatchRunner`).
 *
 * The kind is stamped by the runner at start, never inferred from the
 * document path. Rows written before the column existed read as
 * `spec-driven`, since goal runs did not exist for most of that history.
 */
export type AutoRunKind = 'goal-driven' | 'spec-driven';

/**
 * Coerce an untrusted or legacy value into an `AutoRunKind`. Anything other
 * than the literal `'goal-driven'` (null, undefined, a typo, a kind from a
 * newer build) counts as `spec-driven`, so an unlabeled row is never dropped
 * from a total.
 */
export function normalizeAutoRunKind(value: unknown): AutoRunKind {
	return value === 'goal-driven' ? 'goal-driven' : 'spec-driven';
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
	/** Which engine ran it. Optional on the wire; stored as `spec-driven` when absent. */
	kind?: AutoRunKind;
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

/** Every range, shortest first. What a range flag or a bridge message is checked against. */
export const STATS_TIME_RANGES: readonly StatsTimeRange[] = [
	'day',
	'week',
	'month',
	'quarter',
	'year',
	'all',
];

export function isStatsTimeRange(value: unknown): value is StatsTimeRange {
	return (STATS_TIME_RANGES as readonly unknown[]).includes(value);
}

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
	/**
	 * How often the user prompts agents: interactive turns only, per calendar
	 * day, hour and weekday. Unlike every other field here the window is
	 * calendar-aligned (N local days including today), not rolling.
	 */
	prompts: PromptCadence;
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
 * One conversation with the Auto Run wizard, from the moment it opens to the
 * moment it closes.
 *
 * Unlike `resilience_events` (recorded once, at resolution), a wizard run is
 * UPSERTED at every milestone - opened, each exchange, documents written,
 * closed - because the payoff milestone (documents generated) and the close
 * are separated by however long the user spends reading the result. Recording
 * only at close would lose an entire run's output to a quit, so a run that is
 * never closed still leaves an accurate row with `outcome: 'in-progress'`.
 *
 * `endedAt` is therefore "last activity", not "closed": `endedAt - startedAt`
 * is always the time actually spent talking to the wizard.
 */
export interface WizardRun {
	id: string;
	/** Maestro agent (Session.id) the wizard ran on. `'onboarding'` for the first-run wizard. */
	sessionId: string;
	/** Provider id ('claude-code', 'codex', ...). */
	agentType: string;
	/** Which wizard: the inline `/wizard` command or the first-run onboarding wizard. */
	surface: 'inline' | 'onboarding';
	/** 'new' = writing fresh Auto Run docs; 'iterate' = revising existing ones. */
	mode: 'new' | 'iterate';
	/** 'generated' = documents were written; 'abandoned' = closed with nothing; 'in-progress' = never closed. */
	outcome: 'in-progress' | 'generated' | 'abandoned';
	/** Epoch ms the wizard opened. */
	startedAt: number;
	/** Epoch ms of the last recorded activity in the run. */
	endedAt: number;
	/** User messages sent to the wizard during the conversation. */
	exchanges: number;
	/** Auto Run documents the run produced. */
	documents: number;
	/** Task checkboxes across those documents. */
	tasks: number;
	/**
	 * Time actually spent in the wizard: agent turns in full, gaps waiting on the
	 * user capped (see `src/renderer/services/wizardStats.ts`). Use this, never
	 * `endedAt - startedAt`, which counts a tab left open for days. Absent on
	 * rows recorded before it was measured.
	 */
	activeMs?: number;
	/** Working directory the run targeted, when known. */
	projectPath?: string;
}

/**
 * Where a recorded run's model was:
 *
 *   - `local`      - a catalog model, in-process on this machine;
 *   - `server`     - a catalog model on the Maestro model server;
 *   - `endpoint`   - a model on a user-run endpoint (Ollama, LM Studio, a cloud API);
 *   - `system-one` - a System One engine reached over the Jev API (Jev, OpenJev).
 */
export const LOCAL_MODEL_RUN_SOURCE_TYPES = ['local', 'endpoint', 'server', 'system-one'] as const;

export type LocalModelRunSourceType = (typeof LOCAL_MODEL_RUN_SOURCE_TYPES)[number];

/**
 * One run that reached a model other than a provider's own: the task router
 * called a local model, the Maestro model server or an endpoint for a task (see
 * `src/main/local-models/task-router.ts`), or a System One request was sent to
 * a remote engine (see `src/main/local-models/system-one/decisions.ts`). A task
 * that was off, or handed back to its Utility Agent path, is not a run.
 */
export interface LocalModelRun {
	id: string;
	/**
	 * The task id from `LOCAL_MODEL_TASKS` ('tab-naming', 'cue-gate', ...), or
	 * `agent:<verb>` for a System One request an agent sent through `maestro-cli s1`.
	 */
	taskId: string;
	sourceType: LocalModelRunSourceType;
	/**
	 * The catalog model id (`local`, `server`), the server's model name
	 * (`endpoint`), or the model the engine says answered (`system-one`; the
	 * engine's id when it gave no answer and so named none).
	 */
	modelId: string;
	/**
	 * The saved endpoint's id for `endpoint`, and the engine's id (`jev-cloud`,
	 * `openjev`) for `system-one`. Absent for `local` and `server`.
	 */
	endpointId?: string;
	/** The agent the run was for, when its caller knew one. */
	agentId?: string;
	/** Epoch ms the run started. */
	startedAt: number;
	/** Duration with machine sleep removed. Includes a cold model load. */
	durationMs: number;
	/** 'cancelled' is a caller abort, not a fault. */
	outcome: 'ok' | 'error' | 'cancelled';
	/** The classified failure (`model-not-installed`, `network`, ...). Absent on success. */
	errorCode?: string;
	tokensIn?: number;
	tokensOut?: number;
}

/** One block the token proxy shortened for the first time in a request. */
export interface ProxyCompressedBlock {
	/** SHA-256 of the original text: the key of the content-addressed cache. */
	hash: string;
	originalTokens: number;
	compressedTokens: number;
	/** The compressors that contributed ('json', 'logs', 'long-lines', 'model'). */
	compressors: string[];
}

/**
 * One model request the Maestro token proxy carried (see
 * `src/main/local-models/proxy/`). Only requests that hold a message list are
 * recorded; token counting, model lists and the like are not.
 */
export interface ProxyRequest {
	id: string;
	/** The agent the base URL named. Absent for a request that named none. */
	agentId?: string;
	/** The route prefix ('anthropic', 'openai', 'chatgpt'). */
	route: string;
	/** The API the request spoke ('anthropic-messages', ...). */
	kind: string;
	mode: 'passthrough' | 'compress';
	/** Epoch ms the request arrived. */
	startedAt: number;
	durationMs: number;
	/** The status sent to the client, or 0 when none was. */
	status: number;
	/** 'completed', 'client-aborted' or 'upstream-failed'. */
	outcome: string;
	/** Body bytes received from the agent. */
	requestBytes: number;
	/** Body bytes sent on. Differs from `requestBytes` when compressed or routed. */
	sentBytes: number;
	responseBytes: number;
	/**
	 * Tokens of the body as it arrived and as it was sent, both estimated as
	 * characters / 4. Present only when the proxy read the body (`compress`
	 * mode): a passthrough request is counted in bytes alone.
	 */
	originalTokens?: number;
	sentTokens?: number;
	/** Time the proxy held the request to read and shorten it. `compress` only. */
	addedLatencyMs?: number;
	/** Tool results sent shortened in this request, cached ones included. */
	blocksCompressed: number;
	/** Verdicts that came from the cache: no compressor ran for them. */
	cacheHits: number;
	/** Compressed blocks per compressor. Absent when nothing was compressed. */
	compressorCounts?: Record<string, number>;
	/** Blocks shortened for the first time in this request. */
	newBlocks?: ProxyCompressedBlock[];
	/** Why the body was forwarded unread in `compress` mode, when it was. */
	skipReason?: string;
	/**
	 * The Local Models target a background request was sent to in place of the
	 * provider, as `<source id>:<model>`. Absent for a request that went to the
	 * provider. A routed request whose target failed keeps it, with the failure
	 * in `outcome`.
	 */
	routedTo?: string;
}

/** What the proxy carried, summed. */
export interface ProxyRequestTotals {
	requests: number;
	/** Requests whose body the proxy read (`compress` mode, not skipped). */
	compressRequests: number;
	/** Tokens of those requests as they arrived, and as they were sent. */
	originalTokens: number;
	sentTokens: number;
	tokensSaved: number;
	/** Mean time those requests were held. 0 when there were none. */
	avgAddedLatencyMs: number;
}

/** {@link ProxyRequestTotals} for one agent. `agentId` is null for unattributed requests. */
export interface ProxyAgentTotals extends ProxyRequestTotals {
	agentId: string | null;
}

export interface ProxyRequestUsage {
	range: StatsTimeRange;
	totals: ProxyRequestTotals;
	/** Most requests first. */
	byAgent: ProxyAgentTotals[];
}

/** One row of the "Recent compressions" list. */
export interface ProxyCompressionEntry extends ProxyCompressedBlock {
	agentId: string | null;
	/** When the request that first shortened the block arrived. */
	at: number;
}

/**
 * File format for a Usage Dashboard export. `json` is one file holding every
 * table plus the dashboard aggregation; `csv` is a zip with one CSV per table.
 */
export type UsageExportFormat = 'json' | 'csv';

/** What a finished Usage Dashboard export reports back to the renderer. */
export interface UsageExportResult {
	/** Absolute path the export was written to. */
	path: string;
	format: UsageExportFormat;
	/** Rows written per table, keyed by table name. */
	rowCounts: Record<string, number>;
	/** Plain-language notes on data the export could not include in full. */
	notes: string[];
}

/**
 * Database schema version for migrations
 */
export const STATS_DB_VERSION = 20;
