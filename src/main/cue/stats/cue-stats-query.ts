/**
 * Cue Stats Aggregation Query
 *
 * Builds the single payload consumed by the renderer-side Cue Dashboard.
 * Joins `cue_events` (with the Phase 01 lineage columns) to per-session token
 * totals from the token accessor, then rolls up by pipeline, agent,
 * subscription, chain, and time-bucket.
 *
 * Token attribution: each event is credited with the token totals of the
 * provider session it produced (`cue_events.provider_session_id`), resolved via
 * `getSessionTokenSummaries`. Each Cue run spawns a fresh agent process, so one
 * event maps to exactly one provider session - no double-counting. Events with
 * no recorded provider session id (command/shell runs, or rows written before
 * provider-id capture landed) contribute zeros.
 *
 * Also the read side of the Cue/History split: `getCueHistoryEntries()` serves
 * Cue runs to the History panel straight from this table, so a chatty fleet no
 * longer evicts the user's own turns out of the per-agent JSONL file, and
 * `getCueHistoryBuckets()` / `getCueHistoryFingerprint()` serve the same runs
 * to the activity graph as counts rather than rows.
 */

import {
	getCueEventBucketCounts,
	getCueEventGroupCounts,
	getCueEventHistoryStamp,
	getCueEventsForHistory,
	getRecentCueEvents,
} from '../cue-db';
import type { CueEventRecord } from '../cue-db';
import { getTimeRangeStart } from '../../stats/utils';
import { computePercentiles } from '../../../shared/percentiles';
import { getAgentDisplayName } from '../../../shared/agentMetadata';
import { buildCueRunSummary, parseSubscriptionName } from '../../../shared/cue/cue-summary';
import type { CueEventType } from '../../../shared/cue/contracts';
import type { CueHistoryGroup, HistoryEntry } from '../../../shared/types';
import {
	getAgentTypesForSessions,
	getSessionTokenSummaries,
	type SessionTokenSummary,
} from './cue-token-accessor';
import type {
	CueChain,
	CueChainNode,
	CueHourBucket,
	CueStatsAggregation,
	CueStatsByGroup,
	CueStatsTimeRange,
	CueStatsTotals,
	CueTimeBucket,
	CueTriggerTypeOption,
} from '../../../shared/cue-stats-types';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const UNATTRIBUTED_PIPELINE_KEY = '__unattributed__';
const UNATTRIBUTED_PIPELINE_LABEL = 'Unattributed';
const UNKNOWN_AGENT_KEY = '__unknown__';
const UNKNOWN_AGENT_LABEL = 'Unknown';
const PARTIAL_CHAIN_LABEL = '<partial chain>';

/**
 * Statuses that mean the run reached a terminal failure mode. `running` is
 * intentionally excluded - in-flight events count as occurrences only.
 */
const FAILURE_STATUSES = new Set(['failed', 'timeout', 'stopped']);
const SUCCESS_STATUSES = new Set(['completed']);

interface MutableTotals {
	occurrences: number;
	successCount: number;
	failureCount: number;
	totalDurationMs: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheReadTokens: number;
	totalCacheCreationTokens: number;
	costSum: number;
	costObserved: boolean;
}

function emptyMutableTotals(): MutableTotals {
	return {
		occurrences: 0,
		successCount: 0,
		failureCount: 0,
		totalDurationMs: 0,
		totalInputTokens: 0,
		totalOutputTokens: 0,
		totalCacheReadTokens: 0,
		totalCacheCreationTokens: 0,
		costSum: 0,
		costObserved: false,
	};
}

function freezeTotals(t: MutableTotals): CueStatsTotals {
	return {
		occurrences: t.occurrences,
		successCount: t.successCount,
		failureCount: t.failureCount,
		totalDurationMs: t.totalDurationMs,
		totalInputTokens: t.totalInputTokens,
		totalOutputTokens: t.totalOutputTokens,
		totalCacheReadTokens: t.totalCacheReadTokens,
		totalCacheCreationTokens: t.totalCacheCreationTokens,
		totalCostUsd: t.costObserved ? t.costSum : null,
	};
}

interface EventContribution {
	durationMs: number | null;
	tokens: SessionTokenSummary | null;
	isSuccess: boolean;
	isFailure: boolean;
}

function classifyStatus(status: string): { isSuccess: boolean; isFailure: boolean } {
	return {
		isSuccess: SUCCESS_STATUSES.has(status),
		isFailure: FAILURE_STATUSES.has(status),
	};
}

/**
 * Token totals for an event, looked up by the run's provider session id (the
 * key the on-disk session files use). Events with no recorded provider session
 * id - command/shell runs, or rows written before provider-id capture landed -
 * contribute no tokens.
 */
function tokensForEvent(
	event: CueEventRecord,
	tokensByProvider: Map<string, SessionTokenSummary>
): SessionTokenSummary | null {
	if (!event.providerSessionId) return null;
	return tokensByProvider.get(event.providerSessionId) ?? null;
}

function computeDuration(event: CueEventRecord): number | null {
	if (event.completedAt == null) return null;
	const dur = event.completedAt - event.createdAt;
	return dur >= 0 ? dur : null;
}

function applyEvent(target: MutableTotals, contrib: EventContribution): void {
	target.occurrences += 1;
	if (contrib.isSuccess) target.successCount += 1;
	if (contrib.isFailure) target.failureCount += 1;
	if (contrib.durationMs != null) target.totalDurationMs += contrib.durationMs;
	if (contrib.tokens) {
		target.totalInputTokens += contrib.tokens.inputTokens;
		target.totalOutputTokens += contrib.tokens.outputTokens;
		target.totalCacheReadTokens += contrib.tokens.cacheReadTokens;
		target.totalCacheCreationTokens += contrib.tokens.cacheCreationTokens;
		if (contrib.tokens.costUsd != null) {
			target.costSum += contrib.tokens.costUsd;
			target.costObserved = true;
		}
	}
}

/**
 * Align `ms` to the start of its hour (1h buckets) or day (1d buckets) in the
 * current process's local timezone, matching the convention used elsewhere in
 * the stats dashboard.
 */
function bucketStartFor(ms: number, bucketSizeMs: number): number {
	const d = new Date(ms);
	if (bucketSizeMs === DAY_MS) {
		d.setHours(0, 0, 0, 0);
	} else {
		d.setMinutes(0, 0, 0);
	}
	return d.getTime();
}

function bucketSizeFor(timeRange: CueStatsTimeRange): number {
	return timeRange === 'day' || timeRange === 'week' ? HOUR_MS : DAY_MS;
}

/**
 * Resolve an event to a `{ key, label }` describing its pipeline group.
 *
 * Order of resolution:
 *   1. The persisted `pipelineId` column on the row (Phase 01 lineage).
 *   2. A live `subscriptionName → pipelineName` lookup from the running cue
 *      engine - covers events that were recorded before lineage tracking was
 *      enabled, OR before `pipeline_name` was added to the project's cue
 *      config. Without this fallback, every old event lands in "Unattributed"
 *      even when the user has a fully-defined pipeline graph.
 *   3. The synthetic "Unattributed" bucket as a last resort.
 */
function pipelineGroupKey(
	event: CueEventRecord,
	subscriptionToPipeline?: Map<string, string>
): { key: string; label: string } {
	if (event.pipelineId) return { key: event.pipelineId, label: event.pipelineId };
	const fallback = subscriptionToPipeline?.get(event.subscriptionName);
	if (fallback) return { key: fallback, label: fallback };
	return { key: UNATTRIBUTED_PIPELINE_KEY, label: UNATTRIBUTED_PIPELINE_LABEL };
}

function agentGroupKey(agentType: string | null): { key: string; label: string } {
	if (!agentType) return { key: UNKNOWN_AGENT_KEY, label: UNKNOWN_AGENT_LABEL };
	return { key: agentType, label: getAgentDisplayName(agentType) };
}

/**
 * Friendly labels for the dotted `event.type` strings persisted on
 * `cue_events`. Unknown types fall through with the raw key - a defensive
 * default so a future trigger introduced upstream is still visible (just
 * unstyled) instead of silently bucketed as "Unknown".
 */
const TRIGGER_TYPE_LABELS: Record<string, string> = {
	'app.startup': 'App Startup',
	'time.heartbeat': 'Heartbeat',
	'time.scheduled': 'Scheduled',
	'file.changed': 'File Change',
	'agent.completed': 'Agent Completion',
	'github.pull_request': 'GitHub PR',
	'github.issue': 'GitHub Issue',
	'task.pending': 'Task Pending',
	'cli.trigger': 'CLI Trigger',
	'time.once': 'One-Time',
	'github.label': 'GitHub Label',
	'webhook.received': 'Webhook',
};

function triggerTypeGroupKey(eventType: string): { key: string; label: string } {
	const label = TRIGGER_TYPE_LABELS[eventType] ?? eventType;
	return { key: eventType, label };
}

/**
 * Count every trigger type in the window, ignoring the exclusion filter. This
 * is the universe the renderer's filter row draws from - a trigger that has
 * been filtered out still needs a chip, and a count on that chip, or the user
 * has no way to bring it back.
 */
function buildTriggerTypeOptions(events: CueEventRecord[]): CueTriggerTypeOption[] {
	const counts = new Map<string, number>();
	for (const event of events) {
		counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
	}
	const options: CueTriggerTypeOption[] = Array.from(counts.entries()).map(
		([key, occurrences]) => ({
			...triggerTypeGroupKey(key),
			occurrences,
		})
	);
	options.sort((a, b) => {
		if (b.occurrences !== a.occurrences) return b.occurrences - a.occurrences;
		return a.label.localeCompare(b.label);
	});
	return options;
}

interface GroupAccumulator {
	key: string;
	label: string;
	totals: MutableTotals;
	/**
	 * Sort hint for the "Unattributed"/"Unknown" buckets - they sort last
	 * regardless of label.
	 */
	sortLast: boolean;
}

function freezeGroups(groups: Map<string, GroupAccumulator>): CueStatsByGroup[] {
	const arr = Array.from(groups.values());
	arr.sort((a, b) => {
		if (a.sortLast !== b.sortLast) return a.sortLast ? 1 : -1;
		// Highest occurrences first within each tier.
		if (b.totals.occurrences !== a.totals.occurrences) {
			return b.totals.occurrences - a.totals.occurrences;
		}
		return a.label.localeCompare(b.label);
	});
	return arr.map((g) => ({
		key: g.key,
		label: g.label,
		totals: freezeTotals(g.totals),
	}));
}

function ensureGroup(
	groups: Map<string, GroupAccumulator>,
	key: string,
	label: string,
	sortLast: boolean
): GroupAccumulator {
	let g = groups.get(key);
	if (!g) {
		g = { key, label, totals: emptyMutableTotals(), sortLast };
		groups.set(key, g);
	}
	return g;
}

function buildTimeSeries(
	events: CueEventRecord[],
	tokensByProvider: Map<string, SessionTokenSummary>,
	bucketSizeMs: number
): CueTimeBucket[] {
	const buckets = new Map<number, CueTimeBucket>();
	for (const event of events) {
		const bucketStartMs = bucketStartFor(event.createdAt, bucketSizeMs);
		let bucket = buckets.get(bucketStartMs);
		if (!bucket) {
			bucket = {
				bucketStartMs,
				occurrences: 0,
				successCount: 0,
				failureCount: 0,
				inputTokens: 0,
				outputTokens: 0,
			};
			buckets.set(bucketStartMs, bucket);
		}
		bucket.occurrences += 1;
		const { isSuccess, isFailure } = classifyStatus(event.status);
		if (isSuccess) bucket.successCount += 1;
		if (isFailure) bucket.failureCount += 1;
		const tokens = tokensForEvent(event, tokensByProvider);
		if (tokens) {
			bucket.inputTokens += tokens.inputTokens;
			bucket.outputTokens += tokens.outputTokens;
		}
	}
	return Array.from(buckets.values()).sort((a, b) => a.bucketStartMs - b.bucketStartMs);
}

function buildChains(
	events: CueEventRecord[],
	tokensByProvider: Map<string, SessionTokenSummary>,
	agentTypeBySession: Map<string, string | null>
): CueChain[] {
	const byRoot = new Map<string, CueEventRecord[]>();
	for (const event of events) {
		if (!event.chainRootId) continue;
		let bucket = byRoot.get(event.chainRootId);
		if (!bucket) {
			bucket = [];
			byRoot.set(event.chainRootId, bucket);
		}
		bucket.push(event);
	}

	const chains: CueChain[] = [];
	for (const [rootId, chainEvents] of byRoot.entries()) {
		const sorted = [...chainEvents].sort((a, b) => a.createdAt - b.createdAt);
		const rootEvent = sorted.find((e) => e.id === rootId) ?? null;

		const nodes: CueChainNode[] = [];
		const totals = emptyMutableTotals();

		if (!rootEvent) {
			// Synthetic placeholder so consumers always have a root anchor.
			nodes.push({
				eventId: rootId,
				parentEventId: null,
				subscriptionName: PARTIAL_CHAIN_LABEL,
				pipelineId: null,
				agentType: null,
				status: 'unknown',
				startedAtMs: sorted[0]?.createdAt ?? 0,
				durationMs: null,
				inputTokens: 0,
				outputTokens: 0,
				costUsd: null,
			});
		}

		for (const event of sorted) {
			const tokens = tokensForEvent(event, tokensByProvider);
			const agentType = agentTypeBySession.get(event.sessionId) ?? null;
			const { isSuccess, isFailure } = classifyStatus(event.status);
			const durationMs = computeDuration(event);

			nodes.push({
				eventId: event.id,
				parentEventId: event.parentEventId ?? null,
				subscriptionName: event.subscriptionName,
				pipelineId: event.pipelineId ?? null,
				agentType,
				status: event.status,
				startedAtMs: event.createdAt,
				durationMs,
				inputTokens: tokens?.inputTokens ?? 0,
				outputTokens: tokens?.outputTokens ?? 0,
				costUsd: tokens?.costUsd ?? null,
			});

			applyEvent(totals, { durationMs, tokens, isSuccess, isFailure });
		}

		chains.push({
			rootId,
			rootSubscriptionName: rootEvent ? rootEvent.subscriptionName : PARTIAL_CHAIN_LABEL,
			nodes,
			totals: freezeTotals(totals),
		});
	}

	chains.sort((a, b) => {
		const aStart = a.nodes[0]?.startedAtMs ?? 0;
		const bStart = b.nodes[0]?.startedAtMs ?? 0;
		return bStart - aStart;
	});
	return chains;
}

/**
 * Bucket events into a 24-entry hour-of-day distribution using the host's
 * local timezone (matches how the rest of the stats dashboard treats day
 * boundaries). Always returns 24 entries - hours with zero occurrences
 * keep their slot so the renderer can draw a continuous 24-bar strip.
 */
function buildHourOfDay(events: CueEventRecord[]): CueHourBucket[] {
	const buckets: CueHourBucket[] = Array.from({ length: 24 }, (_, hour) => ({
		hour,
		occurrences: 0,
		successCount: 0,
		failureCount: 0,
	}));
	for (const event of events) {
		const hour = new Date(event.createdAt).getHours();
		const bucket = buckets[hour];
		if (!bucket) continue;
		bucket.occurrences += 1;
		const { isSuccess, isFailure } = classifyStatus(event.status);
		if (isSuccess) bucket.successCount += 1;
		if (isFailure) bucket.failureCount += 1;
	}
	return buckets;
}

function buildCoverageWarnings(summaries: Map<string, SessionTokenSummary>): string[] {
	const partial = new Set<string>();
	const unsupported = new Set<string>();
	for (const summary of summaries.values()) {
		if (summary.coverage === 'partial') partial.add(summary.agentType);
		else if (summary.coverage === 'unsupported') unsupported.add(summary.agentType);
	}
	const warnings: string[] = [];
	for (const agent of partial) {
		warnings.push(`${getAgentDisplayName(agent)} sessions report partial token coverage`);
	}
	for (const agent of unsupported) {
		warnings.push(`${getAgentDisplayName(agent)} sessions have no token data`);
	}
	return warnings.sort();
}

/**
 * Optional resolver hooks for {@link getCueStatsAggregation}. Currently the
 * caller may supply a `subscriptionName → pipelineName` map drawn from the
 * live cue engine; the query uses it to attribute legacy / untagged events
 * to their actual pipeline instead of dropping them in "Unattributed".
 */
export interface CueStatsAggregationOptions {
	subscriptionToPipeline?: Map<string, string>;
	/**
	 * Raw `cue_events.type` values to drop before aggregating. Every rollup in
	 * the payload except `triggerTypeOptions` honors this, so hiding a
	 * high-volume trigger (a heartbeat firing every minute) rescales the whole
	 * tab instead of just its own bar.
	 */
	excludeTriggerTypes?: string[];
}

/**
 * Compute the full Cue stats payload for the given time range.
 *
 * Reads `cue_events` for the window, resolves token summaries per unique
 * session via the Phase 02 accessor, then assembles totals + per-pipeline +
 * per-agent + per-subscription rollups, the chain forest, and the time
 * series. Caller (the IPC handler) is responsible for gating on Encore flags.
 */
export async function getCueStatsAggregation(
	timeRange: CueStatsTimeRange,
	options: CueStatsAggregationOptions = {}
): Promise<CueStatsAggregation> {
	const windowEndMs = Date.now();
	const windowStartMs = getTimeRangeStart(timeRange);
	const bucketSizeMs = bucketSizeFor(timeRange);

	const allEvents = getRecentCueEvents(windowStartMs);
	const excluded = new Set(options.excludeTriggerTypes ?? []);
	// Options are counted from the unfiltered set - see buildTriggerTypeOptions.
	const triggerTypeOptions = buildTriggerTypeOptions(allEvents);
	const events =
		excluded.size === 0 ? allEvents : allEvents.filter((event) => !excluded.has(event.type));

	// Token attribution joins on the provider session id each run produced
	// (the key the on-disk session files use); agent-type labelling joins on
	// the Maestro agent id (what `session_lifecycle` stores, available even for
	// runs that never recorded a provider session id).
	const tokenLookups = events
		.filter((e) => e.providerSessionId)
		.map((e) => ({ maestroSessionId: e.sessionId, providerSessionId: e.providerSessionId! }));
	const tokensByProvider = await getSessionTokenSummaries(tokenLookups, {
		sinceMs: windowStartMs,
	});

	const uniqueSessionIds = Array.from(new Set(events.map((e) => e.sessionId)));
	const agentTypeByLifecycle = getAgentTypesForSessions(uniqueSessionIds);
	const agentTypeBySession = new Map<string, string | null>();
	for (const sid of uniqueSessionIds) {
		agentTypeBySession.set(sid, agentTypeByLifecycle.get(sid) ?? null);
	}

	const totals = emptyMutableTotals();
	const byPipeline = new Map<string, GroupAccumulator>();
	const byAgent = new Map<string, GroupAccumulator>();
	const bySubscription = new Map<string, GroupAccumulator>();
	const byTriggerType = new Map<string, GroupAccumulator>();

	// Per-run durations for the percentile distribution. Only completed runs have
	// a duration; in-flight events contribute nothing here.
	const runDurations: number[] = [];

	for (const event of events) {
		const { isSuccess, isFailure } = classifyStatus(event.status);
		const durationMs = computeDuration(event);
		if (durationMs != null) runDurations.push(durationMs);
		const tokens = tokensForEvent(event, tokensByProvider);
		const contrib: EventContribution = { durationMs, tokens, isSuccess, isFailure };

		applyEvent(totals, contrib);

		const pipeline = pipelineGroupKey(event, options.subscriptionToPipeline);
		// `sortLast` flags the synthetic "Unattributed" bucket so it always
		// renders below real pipelines, regardless of resolution path.
		const isUnattributed = pipeline.key === UNATTRIBUTED_PIPELINE_KEY;
		applyEvent(
			ensureGroup(byPipeline, pipeline.key, pipeline.label, isUnattributed).totals,
			contrib
		);

		const agentType = agentTypeBySession.get(event.sessionId) ?? null;
		const agentGroup = agentGroupKey(agentType);
		applyEvent(ensureGroup(byAgent, agentGroup.key, agentGroup.label, !agentType).totals, contrib);

		applyEvent(
			ensureGroup(bySubscription, event.subscriptionName, event.subscriptionName, false).totals,
			contrib
		);

		const trigger = triggerTypeGroupKey(event.type);
		applyEvent(ensureGroup(byTriggerType, trigger.key, trigger.label, false).totals, contrib);
	}

	const chains = buildChains(events, tokensByProvider, agentTypeBySession);
	const timeSeries = buildTimeSeries(events, tokensByProvider, bucketSizeMs);
	const byHourOfDay = buildHourOfDay(events);
	const coverageWarnings = buildCoverageWarnings(tokensByProvider);

	return {
		timeRange,
		windowStartMs,
		windowEndMs,
		totals: freezeTotals(totals),
		durationPercentiles: computePercentiles(runDurations),
		byPipeline: freezeGroups(byPipeline),
		byAgent: freezeGroups(byAgent),
		bySubscription: freezeGroups(bySubscription),
		byTriggerType: freezeGroups(byTriggerType),
		triggerTypeOptions,
		excludedTriggerTypes: Array.from(excluded),
		byHourOfDay,
		chains,
		timeSeries,
		bucketSizeMs,
		coverageWarnings,
	};
}

/**
 * Agent metadata that lives on the Session, not on the `cue_events` row. The
 * DB knows which agent ran a Cue job but not where that agent points or what
 * it is called today, so the caller supplies both.
 */
export interface CueHistoryQuery {
	/** Maestro agent id (`cue_events.session_id`). */
	sessionId: string;
	/** Inclusive lower bound on `created_at`, in ms. Unbounded when omitted. */
	since?: number;
	/** Exclusive upper bound on `created_at`, in ms. Unbounded when omitted. */
	until?: number;
	/** Row cap, newest first. */
	limit?: number;
	/** Agent display name, for the row's trigger/agent label. */
	sessionName?: string;
	/** Agent project root, used as the entry's `projectPath`. */
	projectPath?: string;
}

/**
 * Cue runs for one agent, shaped as {@link HistoryEntry} so the History read
 * path can merge them with the JSONL entries without a second row renderer.
 *
 * The filtering rule and the field mapping both mirror what the removed JSONL
 * writer used to put in the agent's history file, so a row reads identically
 * now that it is served from SQLite:
 *
 * - `summary` is the stored excerpt, falling back to the trigger-label summary
 *   for a run kept because it FAILED silently (the excerpt is NULL there by
 *   definition).
 * - `cueTriggerName` is the subscription name, matching the JSONL writer.
 *   `trigger_name` holds the raw watcher/poller label, which for file and
 *   GitHub triggers is not what the panel labelled the row with.
 * - A row still marked `running` is painted as a failure, the same rule the
 *   Cue activity log applies when it rehydrates (`recordToRunResult()` in
 *   cue-engine.ts): the overwhelming majority are runs orphaned by a crash,
 *   and a third behavior here would only make the two views disagree.
 */
export function getCueHistoryEntries(query: CueHistoryQuery): HistoryEntry[] {
	const events = getCueEventsForHistory({
		sessionId: query.sessionId,
		since: query.since,
		until: query.until,
		limit: query.limit,
	});
	return events.map((event) => cueEventToHistoryEntry(event, query));
}

function cueEventToHistoryEntry(event: CueEventRecord, query: CueHistoryQuery): HistoryEntry {
	const payload = parseEventPayload(event.payload);
	const excerpt = event.outputExcerpt?.trim() ? event.outputExcerpt : null;
	const sourceSession = payload.sourceSession;

	return {
		id: event.id,
		type: 'CUE',
		timestamp: event.createdAt,
		summary:
			excerpt ??
			buildCueRunSummary({
				subscriptionName: event.subscriptionName,
				sessionName: query.sessionName ?? event.sessionId,
				event: {
					id: event.id,
					type: event.type as CueEventType,
					timestamp: new Date(event.createdAt).toISOString(),
					triggerName: event.triggerName,
					payload,
				},
			}),
		fullResponse: event.fullOutput ?? undefined,
		projectPath: query.projectPath ?? '',
		sessionId: event.sessionId,
		sessionName: query.sessionName,
		success: event.status === 'completed',
		elapsedTimeMs:
			event.completedAt != null ? Math.max(0, event.completedAt - event.createdAt) : undefined,
		cueTriggerName: event.subscriptionName,
		cueEventType: event.type,
		cueSourceSession: sourceSession != null ? String(sourceSession) : undefined,
	};
}

/**
 * Cue runs for one agent, collapsed to one {@link CueHistoryGroup} per
 * pipeline-level trigger. The grouped variant of {@link getCueHistoryEntries}:
 * same window, same noise filter, same row shape for the run it surfaces.
 *
 * Why this exists: a high-frequency trigger produces hundreds of near-identical
 * History rows (1,382 for `Pedsidian-Command-Bus` in one week on this machine),
 * and scrolling past the same sentence that many times is what made the panel
 * unreadable. One row per trigger restores it, with the runs one expand away.
 *
 * Grouping is two-stage by design. SQL does the expensive half - thousands of
 * rows down to one per `(pipeline_id, subscription_name)` pair, over the
 * indexed filter columns. This function does the cheap half: folding the
 * `<base>-chain-N` / `<base>-fanin` steps of one pipeline onto their shared
 * pipeline label, using `parseSubscriptionName()` - the canonical owner of that
 * stripping rule, and the same one `buildCueRunSummary()` labels rows with. A
 * SQL re-implementation of its regex would be a second copy free to drift.
 *
 * (The task brief named `triggerGroupKey()` for this. That helper keys a live
 * `CueSubscription` OBJECT by its trigger CONFIG - event type, schedule, watch
 * globs - none of which `cue_events` stores, and it performs no name-suffix
 * stripping at all, so it cannot collapse chain steps. `parseSubscriptionName()`
 * is the helper that implements the rule the brief describes.)
 *
 * `limit` caps GROUPS, not runs: every run in the window is counted before the
 * cap applies, so a group's count never lies about how much it is hiding.
 * Newest last-run first, matching the ungrouped order.
 */
export function getCueHistoryGroups(query: CueHistoryQuery): CueHistoryGroup[] {
	const rows = getCueEventGroupCounts({
		sessionId: query.sessionId,
		since: query.since,
		until: query.until,
	});

	const groups = new Map<string, CueHistoryGroup>();
	for (const row of rows) {
		const label = cueHistoryGroupLabel(row.pipelineId, row.subscriptionName);
		const existing = groups.get(label);
		if (!existing) {
			groups.set(label, {
				key: label,
				label,
				runCount: row.runCount,
				failureCount: row.failureCount,
				lastRunAtMs: row.latest.createdAt,
				latestEntry: cueEventToHistoryEntry(row.latest, query),
			});
			continue;
		}
		existing.runCount += row.runCount;
		existing.failureCount += row.failureCount;
		// Two chain steps of one pipeline: the group's preview body and time
		// come from whichever step ran most recently.
		if (row.latest.createdAt > existing.lastRunAtMs) {
			existing.lastRunAtMs = row.latest.createdAt;
			existing.latestEntry = cueEventToHistoryEntry(row.latest, query);
		}
	}

	const ordered = Array.from(groups.values()).sort((a, b) => b.lastRunAtMs - a.lastRunAtMs);
	return query.limit !== undefined ? ordered.slice(0, query.limit) : ordered;
}

/**
 * Pipeline-level label for a group of runs: the recorded pipeline name when
 * the runs carry lineage, else the subscription name with its `-chain-N` /
 * `-fanin` suffix stripped. Falls back to the raw name for the degenerate case
 * where stripping leaves nothing (a subscription literally named `-fanin`),
 * because an empty label would silently merge unrelated triggers.
 */
function cueHistoryGroupLabel(pipelineId: string | null, subscriptionName: string): string {
	const pipeline = pipelineId?.trim();
	if (pipeline) return pipeline;
	const base = parseSubscriptionName(subscriptionName).base.trim();
	return base || subscriptionName;
}

/** One collapsed group's window, for {@link getCueHistoryGroupRuns}. */
export interface CueHistoryGroupRunsQuery extends CueHistoryQuery {
	/**
	 * The group to open, as {@link getCueHistoryGroups} keyed it - the pipeline
	 * name, or the subscription name with its chain suffix stripped.
	 */
	groupKey: string;
}

/**
 * The individual runs behind ONE collapsed group - what the History panel's
 * expander shows so a grouped row never hides a run from the user.
 *
 * `limit` caps RUNS here (unlike {@link getCueHistoryGroups}, where it caps
 * groups), and the cap applies newest-first, so expanding a 1,382-run group
 * opens on the runs the user most likely came for.
 *
 * Why the group filter runs in TypeScript rather than SQL: the group key is
 * produced by {@link cueHistoryGroupLabel}, which strips `-chain-N` / `-fanin`
 * with `parseSubscriptionName()`. Reversing that rule into a `WHERE` clause
 * would be a second copy of the regex free to drift from the one the grouped
 * read used, and a filter that disagreed with the rollup would show a group
 * whose expander is missing runs it counted. The cost is bounded by what the
 * UNGROUPED read of the same agent and window already costs, which the panel
 * pays whenever `groupCueEntries` is off.
 */
export function getCueHistoryGroupRuns(query: CueHistoryGroupRunsQuery): HistoryEntry[] {
	const events = getCueEventsForHistory({
		sessionId: query.sessionId,
		since: query.since,
		until: query.until,
	});

	const runs: HistoryEntry[] = [];
	for (const event of events) {
		if (cueHistoryGroupLabel(event.pipelineId ?? null, event.subscriptionName) !== query.groupKey)
			continue;
		runs.push(cueEventToHistoryEntry(event, query));
		if (query.limit !== undefined && runs.length >= query.limit) break;
	}
	return runs;
}

/** Window for {@link getCueHistoryBuckets} / {@link getCueHistoryFingerprint}. */
export interface CueHistoryBucketQuery {
	/**
	 * Maestro agent id (`cue_events.session_id`). Omit for every agent - the
	 * fleet-wide graph Director's Notes draws.
	 */
	sessionId?: string;
	/** Inclusive lower bound on `created_at`, in ms. Unbounded when omitted. */
	since?: number;
	/** Exclusive upper bound on `created_at`, in ms. Unbounded when omitted. */
	until?: number;
}

/**
 * One minute of Cue runs, in the shape the activity-graph aggregator folds in
 * (see `buildBucketAggregate`'s `cueCounts` option).
 */
export interface CueHistoryBucket {
	/** Start of the minute, unix ms. */
	timestamp: number;
	count: number;
}

/**
 * Counts of the Cue runs worth showing, grouped by minute, for the activity
 * graph's CUE series. Scoped to one agent, or to every agent when
 * `query.sessionId` is omitted.
 *
 * The graph draws bars, so it asks the database for numbers rather than
 * reusing {@link getCueHistoryEntries}: an all-time graph would otherwise pull
 * every run's stored output through memory just to increment a counter.
 */
export function getCueHistoryBuckets(query: CueHistoryBucketQuery): CueHistoryBucket[] {
	return getCueEventBucketCounts(query).map((bucket) => ({
		timestamp: bucket.bucketStart,
		count: bucket.count,
	}));
}

/**
 * Fingerprint of one agent's Cue history, for the activity-graph cache. Omit
 * `sessionId` for the fleet-wide fingerprint Director's Notes keys on.
 *
 * That cache invalidates on the history JSONL file's mtime + size, which stops
 * moving for Cue once the runs live only in `cue_events` - so the Cue half of
 * the key has to come from the database or the graph freezes its CUE bars at
 * whatever it first computed.
 */
export function getCueHistoryFingerprint(sessionId?: string): string {
	const stamp = getCueEventHistoryStamp(sessionId);
	return `${stamp.count}-${stamp.maxCreatedAt}-${stamp.maxCompletedAt}`;
}

/** Tolerant payload parse - a corrupt row must not break the History list. */
function parseEventPayload(payload: string | null | undefined): Record<string, unknown> {
	if (!payload) return {};
	try {
		const parsed = JSON.parse(payload);
		return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}
