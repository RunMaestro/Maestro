/**
 * Type definitions for the stats tracking system
 *
 * These types are shared between main process (stats/) and renderer (dashboard).
 */

import type {
	ProxyProviderClassReading,
	TokenProxyRequestMode,
	TokenProxySkipReason,
} from './local-models/token-proxy';
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
	 * The model source this turn launched on (`RunOnSourceTarget`): the
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
	/**
	 * Sum of the reported charges, or null when no query in the range carried a
	 * figure (every charge unknown). Never a fabricated 0.
	 */
	costUsd: number | null;
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

// ---------------------------------------------------------------------------
// Token proxy telemetry: what a request's row says, and how sure each number is
// ---------------------------------------------------------------------------

/**
 * How a figure about the token proxy was obtained. The kind decides what the
 * figure may be added to: nothing of another kind. None of them is a dollar
 * saving.
 *
 * - `measured`: counted by Maestro on a request (requests, blocks, bytes, time
 *   held), or reported by the provider in its answer.
 * - `estimate`: characters divided by 4, on text the proxy read. It is not a
 *   count a provider billed.
 * - `opportunity`: what a preview showed could be removed, when nothing was
 *   removed. Observation only.
 *
 * A stored row holds `measured` and `estimate` numbers (`originalTokens` and
 * `sentTokens` are the estimates). It never holds an opportunity.
 */
export const PROXY_EVIDENCE_KINDS = ['measured', 'estimate', 'opportunity'] as const;
export type ProxyEvidenceKind = (typeof PROXY_EVIDENCE_KINDS)[number];

/**
 * Why a figure has no value. A figure with no value is unknown, which is not
 * zero: zero is a count that was made and found nothing.
 *
 * - `not-recorded`: the row was written before the fact was tracked.
 * - `not-read`: the proxy never read the body (passthrough, or forwarded unread).
 * - `not-observed`: it happened where Maestro cannot see, or the answer did not say.
 * - `insufficient-samples`: too few samples to report a distribution.
 * - `on-demand-only`: computed only when a user asks, for one tab. No range holds it.
 * - `identity-unavailable`: needs a tab, native session, subagent or window the proxy cannot name.
 * - `not-evaluated`: no counterfactual, quality check or dollar basis exists.
 */
export const PROXY_UNKNOWN_REASONS = [
	'not-recorded',
	'not-read',
	'not-observed',
	'insufficient-samples',
	'on-demand-only',
	'identity-unavailable',
	'not-evaluated',
] as const;
export type ProxyUnknownReason = (typeof PROXY_UNKNOWN_REASONS)[number];

/** What a figure counts. */
export type ProxyFigureUnit = 'requests' | 'blocks' | 'bytes' | 'tokens' | 'ms';

/** How much of the traffic a figure speaks for. */
export type ProxyCoverage =
	/** `counted` requests supplied the value, out of the `of` requests in the range that could have. */
	| { scope: 'range'; counted: number; of: number }
	/** Everything since the app started (`since`, epoch ms, when known). Not a time range. */
	| { scope: 'process-lifetime'; since?: number };

/**
 * One number, with how it was obtained, what it counts and how much traffic it
 * covers; or the reason it is unknown. The value is wrapped on purpose: figures
 * of different kinds cannot be added with `+`, and `addProxyFigures()` refuses
 * to. Build one with `proxyFigure()` or `unknownProxyFigure()`.
 */
export type ProxyFigure<K extends ProxyEvidenceKind = ProxyEvidenceKind> = {
	kind: K;
	unit: ProxyFigureUnit;
} & ({ value: number; coverage: ProxyCoverage } | { value: null; unknown: ProxyUnknownReason });

/**
 * The mode a request was carried as: the policy the proxy applied to it. The
 * stored `ProxyRequest.mode` cannot say it, because that column records only
 * whether the body was read and shortened, which `compress` and
 * `compress-early` both do. It is the proxy's own `TokenProxyRequestMode`, so a
 * mode added there reaches the row's type with it (a type-only import: the
 * proxy contract imports its types from this file as well).
 */
export type ProxyEffectiveMode = TokenProxyRequestMode;

/**
 * Tool-result blocks set aside before any cached verdict was looked up, by why.
 * Each goes out whole.
 */
export interface ProxyVetoCounts {
	/** The tool result reports that it failed. */
	failed: number;
	/** The result is the output of an original-recovery command. */
	recovery: number;
	/**
	 * The result is the output of the retrieval tool: text the model asked for.
	 * A later request that sends it again in its history counts it again here, so
	 * this is the count of retrieved text carried forward, not of retrievals.
	 */
	retrieval: number;
}

/**
 * What compress mode did with the tool-result text of one request, in blocks (a
 * block is one text part of a tool result). Present only where the proxy read
 * the body and the compressor returned. Absent is unknown, never zero.
 *
 * Two sums describe the blocks:
 *
 *   recognized = protected + vetoed.* + candidates
 *   candidates = belowThreshold + storeFailed + kept + (the request's) blocksCompressed
 *
 * The first is how the producer derives the number of blocks it recognized. No
 * independent total is stored, so nothing checks it. `proxyBlockCountsProblem()`
 * checks the second sum, and that `cacheHits` and `modelFailed` do not exceed the
 * blocks decided (`kept + blocksCompressed`). The blocks shortened are the
 * request's `blocksCompressed`, so they are not repeated here. Counts only: no
 * tool name, command, path or text.
 */
export interface ProxyBlockCounts {
	/**
	 * Left out because the result is recent or carries the cache breakpoint.
	 * `compress-early` lifts both rules, so it is 0 there.
	 */
	protected: number;
	vetoed: ProxyVetoCounts;
	/** Blocks the proxy could look a verdict up for. */
	candidates: number;
	/** Candidates under the size threshold, left alone without being hashed. */
	belowThreshold: number;
	/** Candidates evaluated and sent as they were. */
	kept: number;
	/** Candidates left alone because the cache could not be read or written. */
	storeFailed: number;
	/**
	 * Blocks whose model summary was tried in this request and failed. They still
	 * got a verdict from the heuristics, so they are also kept or shortened.
	 */
	modelFailed: number;
}

/** The classes of tokens a provider's answer can name, in the order a row stores them. */
export const PROXY_PROVIDER_USAGE_CLASSES = ['input', 'cacheRead', 'cacheWrite', 'output'] as const;
export type ProxyProviderUsageClass = (typeof PROXY_PROVIDER_USAGE_CLASSES)[number];

/**
 * How one class of a provider's usage got its number. The number alone cannot
 * say, because a class the answer did not name is stored as 0.
 *
 * - `reported`: the answer named it. A zero it named is a real zero.
 * - `derived`: computed from reported classes under the provider's own
 *   accounting. OpenAI's uncached input is its prompt total minus its cached
 *   tokens, so it needs both.
 * - `not-applicable`: the provider has no such class, so 0 is true by
 *   definition (OpenAI reports no cache writes).
 * - `unreported`: the answer did not name it and it cannot be derived. The
 *   stored number is a default 0 and says nothing.
 */
export type ProxyProviderClassStatus = 'reported' | 'derived' | 'not-applicable' | 'unreported';

/** The status of every class of one answer's usage. */
export type ProxyProviderReportedness = Record<ProxyProviderUsageClass, ProxyProviderClassStatus>;

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
	/**
	 * Whether the proxy read and shortened the body. Both compress modes are
	 * stored as `compress`, so this cannot tell them apart: see `effectiveMode`.
	 */
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
	/**
	 * Time the proxy held the request to read and shorten it, measured. Absent
	 * means the proxy did not read the body, or the row predates the measure:
	 * unknown, and left out of any mean or percentile.
	 */
	addedLatencyMs?: number;
	/** Tool results sent shortened in this request, cached ones included. */
	blocksCompressed: number;
	/**
	 * Verdicts that came from Maestro's compression cache: no compressor ran for
	 * them. This is verdict reuse. It is not provider prompt-cache usage, which
	 * is `providerCacheReadTokens`.
	 */
	cacheHits: number;
	/** Compressed blocks per compressor. Absent when nothing was compressed. */
	compressorCounts?: Record<string, number>;
	/** Blocks shortened for the first time in this request. */
	newBlocks?: ProxyCompressedBlock[];
	/**
	 * Why the body was forwarded unread in `compress` mode, when it was. One of
	 * `TOKEN_PROXY_SKIP_REASONS` for a row this build wrote. The column stays
	 * open text, so a value from another build reads as an unrecognized reason.
	 */
	skipReason?: string;
	/**
	 * The mode the request was carried as. Absent on a row recorded before this
	 * field existed: unknown, and never inferred from the agent's current setting
	 * or from `mode`. When present, `passthrough` goes with `mode: 'passthrough'`
	 * and either compress mode goes with `mode: 'compress'`.
	 */
	effectiveMode?: ProxyEffectiveMode;
	/**
	 * What compress mode did with each block of tool-result text. Absent when the
	 * proxy did not read the body, and on a row that predates it.
	 */
	blockCounts?: ProxyBlockCounts;
	/**
	 * The Local Models target a background request was sent to in place of the
	 * provider, as `<source id>:<model>`. Absent for a request that went to the
	 * provider. A routed request whose target failed keeps it, with the failure
	 * in `outcome`.
	 */
	routedTo?: string;
	/**
	 * What the provider counted for the request, from the `usage` in its answer
	 * (migration v21). Absent when the answer named none or could not be read,
	 * and for a request a background target answered. When present, the four
	 * numbers are written together, and a class the answer did not name is 0: only
	 * `providerUsageReportedness` says which numbers the provider gave.
	 */
	providerInputTokens?: number;
	providerCacheReadTokens?: number;
	providerCacheWriteTokens?: number;
	providerOutputTokens?: number;
	/**
	 * How each provider count above got its number. Absent on a row written before
	 * this was tracked: its numbers are normalized values of unknown provenance (a
	 * class the answer never named reads as 0), and no class is claimed as
	 * reported. Read a class through `proxyProviderClassReading()`, never from the
	 * number alone.
	 */
	providerUsageReportedness?: ProxyProviderReportedness;
}

/**
 * The provider's own counts, summed over the requests whose answer named them.
 * Unlike the proxy's estimates these cover passthrough requests too.
 */
export interface ProxyProviderUsageTotals {
	/** Requests whose answer named a usage. */
	requests: number;
	inputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	outputTokens: number;
}

/** What the proxy carried, summed. */
export interface ProxyRequestTotals {
	requests: number;
	/**
	 * Requests that carry token estimates: the rows with `originalTokens`. That is
	 * every request the proxy read, a late fallback included (the compressor
	 * returned and a later step failed, so the row keeps equal estimates and no
	 * reduction). An estimate is not evidence that shortening was applied, and this
	 * is not block-count coverage: see `effectiveness.blocks.coverage`.
	 */
	compressRequests: number;
	/** Tokens of those requests as they arrived, and as they were sent. */
	originalTokens: number;
	sentTokens: number;
	tokensSaved: number;
	/**
	 * Mean time the requests that carry a processing time were held. A request
	 * with none is left out of both the sum and the count. It is 0 when no request
	 * has one: `effectiveness.latency` tells that apart from a mean of zero.
	 */
	avgAddedLatencyMs: number;
	/**
	 * Requests that carry a processing time: the sample `avgAddedLatencyMs` is the
	 * mean of. 0 means the mean is not a measurement, where the mean alone reads
	 * the same as a measured 0 ms. Present for the total, each agent and each mode,
	 * so a group's mean is read against its own sample; the range-wide view is
	 * `effectiveness.latency`. Absent from an older desktop: the mean's coverage is
	 * then unknown.
	 */
	timedRequests?: number;
	/** What the provider counted, where its answer said. */
	provider: ProxyProviderUsageTotals;
}

/** {@link ProxyRequestTotals} for one agent. `agentId` is null for unattributed requests. */
export interface ProxyAgentTotals extends ProxyRequestTotals {
	agentId: string | null;
}

/**
 * {@link ProxyRequestTotals} for the requests carried under one effective mode.
 * The token counts are estimates, as everywhere in the totals.
 */
export interface ProxyModeTotals extends ProxyRequestTotals {
	/**
	 * The mode the requests were carried as. Null for requests whose row does not
	 * say: it predates `effective_mode`, or it names a mode this build does not
	 * know. Those rows stay unknown, stored passthrough ones included. A mode is
	 * never inferred from the stored `mode` (a stored `compress` is either compress
	 * mode) or from an agent's setting, which may have changed since.
	 */
	effectiveMode: ProxyEffectiveMode | null;
}

/** Totals for one stored provider-route prefix; unknown future route names stay intact. */
export interface ProxyRouteTotals extends ProxyRequestTotals {
	route: string;
}

/** {@link ProxyCoverage} for a time range: `counted` of the `of` requests supplied a value. */
export type ProxyRangeCoverage = Extract<ProxyCoverage, { scope: 'range' }>;

/**
 * How the requests of a range were handled. Counts of rows, so none is unknown.
 *
 * `read` and `skipped` can overlap: a request that failed after the compressor
 * returned is `skipped` (`failed`), and it keeps the equal token estimates and
 * the time it was held, which is what makes it `read`. They are two views of the
 * same requests, not parts of `carried`: do not add them.
 */
export interface ProxyTraffic {
	/** Every request the proxy carried in the range. */
	carried: number;
	/**
	 * Requests that carry token estimates: the proxy read the body
	 * (`ProxyRequestTotals.compressRequests`). A late fallback is read, and applied
	 * no reduction.
	 */
	read: number;
	/** Requests forwarded without the compressor's result, by any reason (see `skips`). */
	skipped: number;
	/** Requests with at least one block shortened. */
	shortened: number;
	/** Blocks shortened over all requests, each counted once however many algorithms contributed. */
	blocksShortened: number;
}

/**
 * {@link ProxyBlockCounts} summed over the requests that carry them, with the
 * facts of those same requests that the counts must be read against. Every
 * number here covers the counted requests only, so
 * `candidates = belowThreshold + storeFailed + kept + shortened` holds for the
 * sums as it does for each request.
 */
export interface ProxyBlockTotals extends ProxyBlockCounts {
	/** Blocks the same requests shortened (their `blocksCompressed`). */
	shortened: number;
	/**
	 * Verdicts the same requests took from Maestro's compression cache (their
	 * `cacheHits`): no compressor ran for them. This is verdict reuse. It is not
	 * the provider's prompt cache, which is `ProxyProviderCoverage.cacheRead`.
	 */
	verdictReuse: number;
	/** How many of the same requests had at least one candidate block. */
	requestsWithCandidates: number;
}

/** The block counts of a range and how much of it they speak for. */
export interface ProxyBlockReport {
	/**
	 * Requests that carry block counts (`counted`), out of the requests that carry
	 * token estimates (`of`, {@link ProxyTraffic.read}). The two differ for a
	 * request read before counts were recorded, and for a late fallback: its
	 * estimates are equal and it has no counts. Estimate coverage is not count
	 * coverage.
	 */
	coverage: ProxyRangeCoverage;
	/**
	 * Summed over the counted requests only. Null when no request is counted: the
	 * counts are unknown, which is not zero. A request read before counts were
	 * recorded, or forwarded unread, is not counted, and is not a zero in the sums.
	 */
	counts: ProxyBlockTotals | null;
}

/** Requests that were forwarded without the compressor's result, for one reason. */
export interface ProxySkipCount {
	/** A reason in `TOKEN_PROXY_SKIP_REASONS`, or `unrecognized` for a value another build wrote. */
	reason: TokenProxySkipReason | 'unrecognized';
	requests: number;
}

/**
 * Time the proxy held requests to read and shorten them, in ms. Requests with no
 * processing time recorded are unknown and are left out of the distribution. The
 * distribution is withheld below `PROXY_LATENCY_MIN_SAMPLES` timed requests, a
 * display policy that says nothing about how stable a tail is.
 */
export type ProxyLatency = {
	/** Requests with a processing time. */
	timed: number;
	/** Requests the proxy read that carry none. */
	untimed: number;
} & (
	| { distribution: DurationPercentiles }
	| {
			distribution: null;
			/** `insufficient-samples`, `not-read` (nothing was read) or `not-recorded` (no read request is timed). */
			unknown: ProxyUnknownReason;
	  }
);

/** One algorithm's share of the shortening. */
export interface ProxyAlgorithmCount {
	/** The compressor's id as recorded ('json', 'logs', 'model', ...). Open text: a later build may add one. */
	algorithm: string;
	/** Blocks this algorithm contributed to. */
	blocks: number;
	/** Requests in which it contributed to a block. */
	requests: number;
}

/**
 * Which algorithms shortened the blocks. The counts overlap: a block that two
 * algorithms shortened is listed under both, so the `blocks` of the algorithms
 * add up to more than `uniqueBlocks` whenever that happens. Never add them to
 * get a number of blocks.
 */
export interface ProxyAlgorithmBreakdown {
	/** Blocks shortened in the requests that name their algorithms, each counted once. */
	uniqueBlocks: number;
	/** Most blocks first. */
	algorithms: ProxyAlgorithmCount[];
}

/** One class of the provider's usage over a range. */
export interface ProxyProviderClassTotals {
	/**
	 * Tokens summed over the requests where the class is `reported` or `derived`:
	 * the only ones whose number says something. A default 0 (`unreported`), a
	 * legacy number of unknown provenance and a class the provider does not have
	 * add nothing. Unknown when no request qualifies; its coverage says how many did.
	 */
	tokens: ProxyFigure<'measured'>;
	/**
	 * The range's requests by how the class got its number
	 * ({@link ProxyProviderClassReading}). Each request is in exactly one, so the
	 * six add up to the requests. `legacy` and `absent` are unknown, as is
	 * `unreported`; `not-applicable` is zero by definition and not a measurement.
	 */
	rows: Record<ProxyProviderClassReading, number>;
}

/** What the provider reported, class by class. Provider counts, not Maestro's estimates. */
export type ProxyProviderCoverage = Record<ProxyProviderUsageClass, ProxyProviderClassTotals>;

/** One local calendar day of the range. */
export interface ProxyTrendDay {
	/** `YYYY-MM-DD` in the local time zone, the day boundary every dashboard stat uses. */
	date: string;
	requests: number;
	/** Requests that carry token estimates. */
	compressRequests: number;
	/** Estimates (characters / 4) over those requests. */
	originalTokens: number;
	sentTokens: number;
	blocksShortened: number;
}

/**
 * What the proxy did with the requests of a range, beyond the totals. Built in
 * one place (`getProxyEffectiveness()`), so the Settings Gateway section, the
 * Usage Dashboard and the CLI read the same figures.
 *
 * Three kinds of figure sit here and are never added to one another (see
 * `ProxyEvidenceKind`): counts Maestro made on requests, estimates of tokens
 * (characters / 4) and what the provider reported. An unknown is stated as one
 * (a null, a coverage of zero, an `unknown` reason) and is never written as 0.
 */
export interface ProxyEffectiveness {
	traffic: ProxyTraffic;
	blocks: ProxyBlockReport;
	/** Most requests first. */
	skips: ProxySkipCount[];
	latency: ProxyLatency;
	algorithms: ProxyAlgorithmBreakdown;
	providerClasses: ProxyProviderCoverage;
	/**
	 * By local calendar day, oldest first, for the days that have a request. The
	 * first day of a rolling range (week, month) holds only the requests after the
	 * range started.
	 */
	trend: ProxyTrendDay[];
}

export interface ProxyRequestUsage {
	range: StatsTimeRange;
	totals: ProxyRequestTotals;
	/** Most requests first. */
	byAgent: ProxyAgentTotals[];
	/**
	 * The same totals by effective mode, most requests first; requests whose mode
	 * the row does not state are one group with a null mode. Absent from an older
	 * desktop.
	 */
	byMode?: ProxyModeTotals[];
	/** The same totals by stored provider route, most requests first. Absent from an older desktop. */
	byRoute?: ProxyRouteTotals[];
	/** Absent from an older desktop. */
	effectiveness?: ProxyEffectiveness;
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
export const STATS_DB_VERSION = 22;
