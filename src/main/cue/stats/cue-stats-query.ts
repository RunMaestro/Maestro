/**
 * Cue Stats Aggregation Query
 *
 * Builds the single payload consumed by the renderer-side Cue Dashboard.
 * Joins `cue_events` (with the Phase 01 lineage columns) to per-session token
 * totals from the Phase 02 token accessor, then rolls up by pipeline, agent,
 * subscription, chain, and time-bucket.
 *
 * Token attribution: each event is credited with its session's full token
 * totals from `getSessionTokenSummaries` (Phase 02 "credit-the-whole-session"
 * model). Multiple events from the same session therefore each carry the same
 * token numbers — the totals across events reflect this. Sessions with no
 * resolvable token data contribute zeros.
 */

import { getRecentCueEvents } from '../cue-db';
import type { CueEventRecord } from '../cue-db';
import { getTimeRangeStart } from '../../stats/utils';
import { getAgentDisplayName } from '../../../shared/agentMetadata';
import { getSessionTokenSummaries, type SessionTokenSummary } from './cue-token-accessor';
import type {
	CueChain,
	CueChainNode,
	CueHourBucket,
	CueStatsAggregation,
	CueStatsByGroup,
	CueStatsTimeRange,
	CueStatsTotals,
	CueTimeBucket,
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
 * intentionally excluded — in-flight events count as occurrences only.
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
 *      engine — covers events that were recorded before lineage tracking was
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
 * `cue_events`. Unknown types fall through with the raw key — a defensive
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
};

function triggerTypeGroupKey(eventType: string): { key: string; label: string } {
	const label = TRIGGER_TYPE_LABELS[eventType] ?? eventType;
	return { key: eventType, label };
}

interface GroupAccumulator {
	key: string;
	label: string;
	totals: MutableTotals;
	/**
	 * Sort hint for the "Unattributed"/"Unknown" buckets — they sort last
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
	tokensBySession: Map<string, SessionTokenSummary>,
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
		const tokens = tokensBySession.get(event.sessionId);
		if (tokens) {
			bucket.inputTokens += tokens.inputTokens;
			bucket.outputTokens += tokens.outputTokens;
		}
	}
	return Array.from(buckets.values()).sort((a, b) => a.bucketStartMs - b.bucketStartMs);
}

function buildChains(
	events: CueEventRecord[],
	tokensBySession: Map<string, SessionTokenSummary>,
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
			const tokens = tokensBySession.get(event.sessionId) ?? null;
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
 * boundaries). Always returns 24 entries — hours with zero occurrences
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

	const events = getRecentCueEvents(windowStartMs);

	const uniqueSessionIds = Array.from(new Set(events.map((e) => e.sessionId)));
	const tokensBySession = await getSessionTokenSummaries(uniqueSessionIds, {
		sinceMs: windowStartMs,
	});

	const agentTypeBySession = new Map<string, string | null>();
	for (const sid of uniqueSessionIds) {
		const summary = tokensBySession.get(sid);
		agentTypeBySession.set(sid, summary?.agentType ?? null);
	}

	const totals = emptyMutableTotals();
	const byPipeline = new Map<string, GroupAccumulator>();
	const byAgent = new Map<string, GroupAccumulator>();
	const bySubscription = new Map<string, GroupAccumulator>();
	const byTriggerType = new Map<string, GroupAccumulator>();

	for (const event of events) {
		const { isSuccess, isFailure } = classifyStatus(event.status);
		const durationMs = computeDuration(event);
		const tokens = tokensBySession.get(event.sessionId) ?? null;
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

	const chains = buildChains(events, tokensBySession, agentTypeBySession);
	const timeSeries = buildTimeSeries(events, tokensBySession, bucketSizeMs);
	const byHourOfDay = buildHourOfDay(events);
	const coverageWarnings = buildCoverageWarnings(tokensBySession);

	return {
		timeRange,
		windowStartMs,
		windowEndMs,
		totals: freezeTotals(totals),
		byPipeline: freezeGroups(byPipeline),
		byAgent: freezeGroups(byAgent),
		bySubscription: freezeGroups(bySubscription),
		byTriggerType: freezeGroups(byTriggerType),
		byHourOfDay,
		chains,
		timeSeries,
		bucketSizeMs,
		coverageWarnings,
	};
}
