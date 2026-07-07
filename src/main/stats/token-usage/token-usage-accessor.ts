/**
 * Token-Usage Accessor
 *
 * Builds the Cost & Tokens dashboard payload from each agent's own on-disk
 * session storage (the ground truth), not the stats SQLite DB. Flow:
 *
 * 1. Enumerate the distinct (agentType, projectPath) pairs Maestro has tracked,
 *    from the stats `session_lifecycle` table (skipping remote sessions).
 * 2. `listSessions(projectPath)` per pair - now carrying a per-model `byModel`
 *    split - and turn each into a {@link SessionTokenBreakdown}, served from the
 *    per-session {@link TokenUsageCache} when the fingerprint is unchanged.
 * 3. Aggregate into totals + by-agent / by-model / by-project / timeline series.
 *
 * A short in-memory TTL collapses repeated opens within one sitting; the IPC
 * layer adds stale-while-revalidate so the UI never blocks on a cold parse.
 * Cost math reuses `modelPricing` via the per-model split; each bucket already
 * carries whether its cost was provider-reported or rate-table estimated.
 */

import { getStatsDB } from '../singleton';
import { getSessionStorage } from '../../agents';
import type { AgentSessionInfo } from '../../agents/session-storage';
import { logger } from '../../utils/logger';
import { captureException } from '../../utils/sentry';
import type {
	ModelTokenUsage,
	SessionTokenBreakdown,
	TokenCoverage,
	TokenUsageAggregate,
	TokenUsageGroup,
	TokenUsageQuery,
	TokenUsageTimeBucket,
	TokenUsageTotals,
	TokenTimelineGranularity,
} from '../../../shared/tokenUsage';
import { getAgentDisplayName } from '../../../shared/agentMetadata';
import { normalizeModelId } from '../../../shared/modelPricing';
import {
	getTokenUsageCache,
	sessionFingerprint,
	tokenCacheKey,
	type TokenUsageCache,
} from './token-usage-cache';

const LOG_CONTEXT = '[TokenUsageAccessor]';

/**
 * Per-agent base coverage, matching the Cue accessor's classification so both
 * dashboards label partial data identically. Agents absent here are reported as
 * `unsupported`.
 */
const COVERAGE_BY_AGENT: Record<string, TokenCoverage> = {
	'claude-code': 'full',
	opencode: 'full',
	'factory-droid': 'full',
	codex: 'partial',
	'copilot-cli': 'partial',
};

/** How long a computed aggregate stays fresh in memory before a recompute. */
const MEMO_TTL_MS = 30_000;

interface MemoEntry {
	key: string;
	computedAt: number;
	aggregate: TokenUsageAggregate;
}

let memo: MemoEntry | null = null;

/** Reset the in-memory memo (call on external stats changes / tests). */
export function invalidateTokenUsageMemo(): void {
	memo = null;
}

// ---------------------------------------------------------------------------
// Enumeration
// ---------------------------------------------------------------------------

/**
 * Distinct (agentType -> set of projectPaths) Maestro has tracked locally.
 * Remote sessions are skipped (their transcripts live on the remote host).
 */
function enumerateAgentProjects(): Map<string, Set<string>> {
	const byAgent = new Map<string, Set<string>>();
	const db = getStatsDB();
	if (!db.isReady()) return byAgent;

	let events;
	try {
		events = db.getSessionLifecycleEvents('all');
	} catch (error) {
		void captureException(error);
		return byAgent;
	}

	for (const ev of events) {
		if (ev.isRemote) continue;
		if (!ev.projectPath) continue;
		if (!getSessionStorage(ev.agentType)) continue;
		let set = byAgent.get(ev.agentType);
		if (!set) {
			set = new Set<string>();
			byAgent.set(ev.agentType, set);
		}
		set.add(ev.projectPath);
	}
	return byAgent;
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/** Sum a per-model split into the four token totals. */
function sumModels(byModel: ModelTokenUsage[]): {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	costUsd: number;
	costEstimated: boolean;
} {
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheReadTokens = 0;
	let cacheCreationTokens = 0;
	let costUsd = 0;
	let costEstimated = false;
	for (const m of byModel) {
		inputTokens += m.inputTokens;
		outputTokens += m.outputTokens;
		cacheReadTokens += m.cacheReadTokens;
		cacheCreationTokens += m.cacheCreationTokens;
		costUsd += m.costUsd;
		if (m.costEstimated) costEstimated = true;
	}
	return {
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheCreationTokens,
		costUsd,
		costEstimated,
	};
}

/**
 * Turn one `AgentSessionInfo` into a {@link SessionTokenBreakdown}. When the
 * storage supplied a per-model split we trust it (and its per-model cost);
 * otherwise we fall back to a single unknown-model bucket built from the session
 * totals, pricing it from the rate table so cost is never silently dropped.
 */
function toBreakdown(agentType: string, info: AgentSessionInfo): SessionTokenBreakdown {
	const coverage: TokenCoverage = COVERAGE_BY_AGENT[agentType] ?? 'unsupported';
	const timestampMs = Date.parse(info.modifiedAt || info.timestamp) || 0;

	let byModel: ModelTokenUsage[];
	if (info.byModel && info.byModel.length > 0) {
		byModel = info.byModel;
	} else if (
		info.inputTokens ||
		info.outputTokens ||
		info.cacheReadTokens ||
		info.cacheCreationTokens
	) {
		// No model split available: one bucket, cost from the session's own figure
		// when the agent reports it, else rate-table estimated at aggregate time.
		const hasReportedCost = typeof info.costUsd === 'number';
		byModel = [
			{
				model: '',
				inputTokens: info.inputTokens,
				outputTokens: info.outputTokens,
				cacheReadTokens: info.cacheReadTokens,
				cacheCreationTokens: info.cacheCreationTokens,
				costUsd: hasReportedCost ? (info.costUsd as number) : 0,
				costEstimated: !hasReportedCost,
			},
		];
	} else {
		byModel = [];
	}

	const totals = sumModels(byModel);
	return {
		sessionId: info.sessionId,
		agentType,
		projectPath: info.projectPath,
		timestampMs,
		byModel,
		inputTokens: totals.inputTokens,
		outputTokens: totals.outputTokens,
		cacheReadTokens: totals.cacheReadTokens,
		cacheCreationTokens: totals.cacheCreationTokens,
		costUsd: totals.costUsd,
		costEstimated: totals.costEstimated,
		coverage,
	};
}

/**
 * Collect one breakdown per known session, using the cache for unchanged ones.
 * Live keys are tracked so the cache can prune sessions deleted on disk.
 */
async function collectBreakdowns(cache: TokenUsageCache): Promise<SessionTokenBreakdown[]> {
	const byAgent = enumerateAgentProjects();
	const breakdowns: SessionTokenBreakdown[] = [];
	const liveKeys = new Set<string>();

	for (const [agentType, projects] of byAgent) {
		const storage = getSessionStorage(agentType);
		if (!storage) continue;
		for (const projectPath of projects) {
			let sessions: AgentSessionInfo[];
			try {
				sessions = await storage.listSessions(projectPath);
			} catch (error) {
				void captureException(error);
				continue;
			}
			for (const info of sessions) {
				const key = tokenCacheKey(agentType, info.sessionId);
				liveKeys.add(key);
				const fingerprint = sessionFingerprint(info.modifiedAt, info.sizeBytes);
				let breakdown = cache.get(key, fingerprint);
				if (!breakdown) {
					breakdown = toBreakdown(agentType, info);
					cache.set(key, fingerprint, breakdown);
				}
				breakdowns.push(breakdown);
			}
		}
	}

	cache.prune(liveKeys);
	return breakdowns;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

function emptyTotals(): TokenUsageTotals {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheCreationTokens: 0,
		costUsd: 0,
		costEstimated: false,
		sessionCount: 0,
	};
}

/** Add a per-model bucket into a running totals object (session count added separately). */
function addModelToTotals(t: TokenUsageTotals, m: ModelTokenUsage): void {
	t.inputTokens += m.inputTokens;
	t.outputTokens += m.outputTokens;
	t.cacheReadTokens += m.cacheReadTokens;
	t.cacheCreationTokens += m.cacheCreationTokens;
	t.costUsd += m.costUsd;
	if (m.costEstimated && m.costUsd > 0) t.costEstimated = true;
}

/** Round a timestamp down to the start of its day/week/month (local time). */
function bucketStart(ms: number, granularity: TokenTimelineGranularity): number {
	const d = new Date(ms);
	d.setHours(0, 0, 0, 0);
	if (granularity === 'week') {
		// Week starts Monday.
		const day = (d.getDay() + 6) % 7;
		d.setDate(d.getDate() - day);
	} else if (granularity === 'month') {
		d.setDate(1);
	}
	return d.getTime();
}

function toGroups(map: Map<string, { total: TokenUsageTotals; label: string }>): TokenUsageGroup[] {
	const groups: TokenUsageGroup[] = [];
	for (const [key, { total, label }] of map) {
		groups.push({ key, label, ...total });
	}
	// Highest spend first, tokens as tiebreak.
	groups.sort(
		(a, b) =>
			b.costUsd - a.costUsd || b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens)
	);
	return groups;
}

/** Build the dashboard aggregate from raw breakdowns, honoring the query window. */
function aggregate(all: SessionTokenBreakdown[], query: TokenUsageQuery): TokenUsageAggregate {
	const granularity: TokenTimelineGranularity = query.granularity ?? 'day';
	const sinceMs = query.sinceMs ?? -Infinity;
	const untilMs = query.untilMs ?? Infinity;

	const totals = emptyTotals();
	const byAgent = new Map<string, { total: TokenUsageTotals; label: string }>();
	const byModel = new Map<string, { total: TokenUsageTotals; label: string }>();
	const byProject = new Map<string, { total: TokenUsageTotals; label: string }>();
	const timeline = new Map<number, TokenUsageTimeBucket>();
	const coverageByAgent: Record<string, TokenCoverage> = {};

	const bump = (
		map: Map<string, { total: TokenUsageTotals; label: string }>,
		key: string,
		label: string,
		m: ModelTokenUsage
	) => {
		let entry = map.get(key);
		if (!entry) {
			entry = { total: emptyTotals(), label };
			map.set(key, entry);
		}
		addModelToTotals(entry.total, m);
	};

	for (const s of all) {
		if (s.timestampMs < sinceMs || s.timestampMs > untilMs) continue;
		if (s.byModel.length === 0) continue;

		totals.sessionCount++;
		byAgentSessionCount(byAgent, s);
		byProjectSessionCount(byProject, s);

		const bStart = bucketStart(s.timestampMs || Date.now(), granularity);
		let tb = timeline.get(bStart);
		if (!tb) {
			tb = { startMs: bStart, ...emptyTotals() };
			timeline.set(bStart, tb);
		}
		tb.sessionCount++;

		coverageByAgent[s.agentType] = COVERAGE_BY_AGENT[s.agentType] ?? 'unsupported';

		for (const m of s.byModel) {
			addModelToTotals(totals, m);
			bump(byAgent, s.agentType, getAgentDisplayName(s.agentType), m);
			bump(byModel, m.model || 'unknown', modelLabel(m.model), m);
			bump(byProject, s.projectPath, projectLabel(s.projectPath), m);
			addModelToTotals(tb, m);
		}
	}

	const timelineArr = Array.from(timeline.values()).sort((a, b) => a.startMs - b.startMs);

	return {
		totals,
		byAgent: toGroups(byAgent),
		byModel: toGroups(byModel),
		byProject: toGroups(byProject),
		timeline: timelineArr,
		coverageByAgent,
		generatedAtMs: Date.now(),
	};
}

/** Increment the per-agent group's session count once per session (not per model). */
function byAgentSessionCount(
	map: Map<string, { total: TokenUsageTotals; label: string }>,
	s: SessionTokenBreakdown
): void {
	let entry = map.get(s.agentType);
	if (!entry) {
		entry = { total: emptyTotals(), label: getAgentDisplayName(s.agentType) };
		map.set(s.agentType, entry);
	}
	entry.total.sessionCount++;
}

/** Increment the per-project group's session count once per session. */
function byProjectSessionCount(
	map: Map<string, { total: TokenUsageTotals; label: string }>,
	s: SessionTokenBreakdown
): void {
	let entry = map.get(s.projectPath);
	if (!entry) {
		entry = { total: emptyTotals(), label: projectLabel(s.projectPath) };
		map.set(s.projectPath, entry);
	}
	entry.total.sessionCount++;
}

/** Human label for a model bucket. */
function modelLabel(model: string): string {
	if (!model) return 'Unknown model';
	return normalizeModelId(model);
}

/** Human label for a project path (basename, keeping the full path as the key). */
function projectLabel(projectPath: string): string {
	if (!projectPath) return 'Unknown project';
	const parts = projectPath.split(/[\\/]/).filter(Boolean);
	return parts[parts.length - 1] || projectPath;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

function memoKey(query: TokenUsageQuery): string {
	return `${query.sinceMs ?? ''}:${query.untilMs ?? ''}:${query.granularity ?? 'day'}`;
}

/**
 * Compute the token-usage aggregate for a query. Served from the in-memory memo
 * within {@link MEMO_TTL_MS}; otherwise recomputes from storage (using the
 * persisted per-session cache to avoid re-deriving unchanged sessions).
 *
 * @param force - bypass the memo (e.g. an explicit refresh).
 */
export async function getTokenUsageAggregate(
	query: TokenUsageQuery = {},
	force = false
): Promise<TokenUsageAggregate> {
	const key = memoKey(query);
	if (!force && memo && memo.key === key && Date.now() - memo.computedAt < MEMO_TTL_MS) {
		return memo.aggregate;
	}

	const cache = getTokenUsageCache();
	await cache.load();
	const breakdowns = await collectBreakdowns(cache);
	await cache.persist();

	const result = aggregate(breakdowns, query);
	memo = { key, computedAt: Date.now(), aggregate: result };
	logger.debug(
		`Computed token usage: ${result.totals.sessionCount} sessions, $${result.totals.costUsd.toFixed(2)}`,
		LOG_CONTEXT
	);
	return result;
}

/** Test seam: expose internals for unit tests. */
export const _internal = {
	toBreakdown,
	aggregate,
	enumerateAgentProjects,
	bucketStart,
	COVERAGE_BY_AGENT,
};
