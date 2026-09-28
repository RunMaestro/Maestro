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
import { getProviderAccountDirs } from '../../agents/provider-account-dirs';
import { logger } from '../../utils/logger';
import { captureException } from '../../utils/sentry';
import {
	DEFAULT_ACCOUNT_KEY,
	type ModelTokenUsage,
	type SessionTokenBreakdown,
	type TokenCoverage,
	type TokenUsageAggregate,
	type TokenUsageGroup,
	type TokenUsageQuery,
	type TokenSeries,
	type TokenUsageTimeBucket,
	type TokenUsageTotals,
	type TokenTimelineGranularity,
} from '../../../shared/tokenUsage';
import { getAgentDisplayName } from '../../../shared/agentMetadata';
import { providerProfileKey, providerProfileLabel } from '../../../shared/providerProfiles';
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

/** How long collected breakdowns stay fresh in memory before a re-collect. */
const MEMO_TTL_MS = 30_000;

interface MemoEntry {
	computedAt: number;
	breakdowns: SessionTokenBreakdown[];
}

/**
 * The collected breakdowns, not the aggregate: collection is the expensive step
 * and is query-independent, while aggregating is pure in-memory math over the
 * same array. Memoizing here means flipping the dashboard's time range or
 * granularity re-buckets what we already have instead of re-walking storage.
 */
let memo: MemoEntry | null = null;
/** Shared by concurrent callers so a double mount can't run two collections. */
let inflight: Promise<SessionTokenBreakdown[]> | null = null;

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
function toBreakdown(
	agentType: string,
	info: AgentSessionInfo,
	accountKey: string = DEFAULT_ACCOUNT_KEY
): SessionTokenBreakdown {
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
		accountKey,
		timestampMs,
		origin: info.origin,
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

		// Users routinely run one provider under several accounts, each a separate
		// config dir with its own transcript tree. Reading only the default root
		// would undercount them, so fan out across every discovered account dir.
		// A provider with no account-selecting env var yields no dirs and gets a
		// single default pass, filed under DEFAULT_ACCOUNT_KEY.
		const accountDirs = await getProviderAccountDirs(agentType);
		const accounts: Array<string | undefined> = accountDirs.length ? accountDirs : [undefined];

		for (const projectPath of projects) {
			for (const accountDir of accounts) {
				const accountKey = accountDir ?? DEFAULT_ACCOUNT_KEY;
				let sessions: AgentSessionInfo[];
				try {
					sessions = await storage.listSessions(projectPath, undefined, accountDir);
				} catch (error) {
					void captureException(error);
					continue;
				}
				for (const info of sessions) {
					// Key by account too: the same sessionId can't collide across
					// accounts, but this keeps cache entries unambiguous.
					const key = tokenCacheKey(`${agentType}@${accountKey}`, info.sessionId);
					liveKeys.add(key);
					const fingerprint = sessionFingerprint(info.modifiedAt, info.sizeBytes);
					let breakdown = cache.get(key, fingerprint);
					if (!breakdown) {
						breakdown = toBreakdown(agentType, info, accountKey);
						cache.set(key, fingerprint, breakdown);
					}
					breakdowns.push(breakdown);
				}
			}
		}
	}

	cache.prune(liveKeys);
	return breakdowns;
}

/**
 * Group key and label for one session's account, via the canonical provider
 * profile helpers.
 *
 * Keyed by provider AND account because a bare account key collides: every
 * provider with no account split reports the same literal
 * {@link DEFAULT_ACCOUNT_KEY}, which used to merge Codex, OpenCode, Copilot and
 * Factory Droid into a single unlabelled "Default" row whose cost was the sum of
 * four different vendors. Labeling through the same helpers the Agents tab
 * filter and the quota badges use means those surfaces cannot disagree about
 * what an account is called.
 */
function accountGroup(agentType: string, accountKey: string): { key: string; label: string } {
	const resolved = accountKey === DEFAULT_ACCOUNT_KEY ? null : accountKey;
	return {
		key: providerProfileKey(agentType, resolved),
		label: providerProfileLabel(agentType, resolved),
	};
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
	const byAccount = new Map<string, { total: TokenUsageTotals; label: string }>();
	const timeline = new Map<number, TokenUsageTimeBucket>();
	const coverageByAgent: Record<string, TokenCoverage> = {};

	/** Get-or-create a group entry, so callers can bump tokens or session count. */
	const group = (
		map: Map<string, { total: TokenUsageTotals; label: string }>,
		key: string,
		label: string
	) => {
		let entry = map.get(key);
		if (!entry) {
			entry = { total: emptyTotals(), label };
			map.set(key, entry);
		}
		return entry;
	};

	for (const s of all) {
		if (s.timestampMs < sinceMs || s.timestampMs > untilMs) continue;
		if (s.byModel.length === 0) continue;

		// Session counts are bumped once per session; token/cost per model below.
		totals.sessionCount++;
		group(byAgent, s.agentType, getAgentDisplayName(s.agentType)).total.sessionCount++;
		group(byProject, s.projectPath, projectLabel(s.projectPath)).total.sessionCount++;
		const account = accountGroup(s.agentType, s.accountKey);
		group(byAccount, account.key, account.label).total.sessionCount++;

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
			addModelToTotals(group(byAgent, s.agentType, getAgentDisplayName(s.agentType)).total, m);
			addModelToTotals(group(byModel, m.model || 'unknown', modelLabel(m.model)).total, m);
			addModelToTotals(group(byProject, s.projectPath, projectLabel(s.projectPath)).total, m);
			addModelToTotals(group(byAccount, account.key, account.label).total, m);
			addModelToTotals(tb, m);
		}
	}

	const timelineArr = Array.from(timeline.values()).sort((a, b) => a.startMs - b.startMs);

	return {
		totals,
		byAgent: toGroups(byAgent),
		byModel: toGroups(byModel),
		byProject: toGroups(byProject),
		byAccount: toGroups(byAccount),
		timeline: timelineArr,
		series: buildSeries(all, sinceMs, untilMs),
		coverageByAgent,
		generatedAtMs: Date.now(),
	};
}

/** Local `YYYY-MM-DD` for a timestamp, matching the format `StatsAggregation.byDay` uses. */
function localDayKey(ms: number): string {
	const d = new Date(ms);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
		d.getDate()
	).padStart(2, '0')}`;
}

/** Add `n` into `map[key]`, creating the entry when absent. */
function bump(map: Record<string, number>, key: string, n: number): void {
	map[key] = (map[key] ?? 0) + n;
}

/**
 * Bucket session tokens into the shapes the existing dashboard charts already
 * consume for queries/duration, so each can offer a Tokens metric mode.
 *
 * See {@link TokenSeries} for the last-activity attribution caveat.
 */
function buildSeries(all: SessionTokenBreakdown[], sinceMs: number, untilMs: number): TokenSeries {
	const series: TokenSeries = {
		byDay: {},
		byHour: {},
		byAgentByDay: {},
		bySessionByDay: {},
		bySource: { user: 0, auto: 0 },
	};

	for (const s of all) {
		if (s.timestampMs < sinceMs || s.timestampMs > untilMs) continue;
		const tokens = s.inputTokens + s.outputTokens + s.cacheReadTokens + s.cacheCreationTokens;
		if (tokens <= 0) continue;

		// A session with no usable timestamp can still contribute to the
		// non-temporal splits, but must not pollute a specific day/hour.
		if (s.timestampMs > 0) {
			const day = localDayKey(s.timestampMs);
			bump(series.byDay, day, tokens);
			bump(series.byHour, String(new Date(s.timestampMs).getHours()), tokens);

			let agentDays = series.byAgentByDay[s.agentType];
			if (!agentDays) {
				agentDays = {};
				series.byAgentByDay[s.agentType] = agentDays;
			}
			bump(agentDays, day, tokens);

			let sessionDays = series.bySessionByDay[s.sessionId];
			if (!sessionDays) {
				sessionDays = {};
				series.bySessionByDay[s.sessionId] = sessionDays;
			}
			bump(sessionDays, day, tokens);
		}

		if (s.origin === 'user' || s.origin === 'auto') {
			series.bySource[s.origin] += tokens;
		}
	}

	return series;
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

/**
 * Collected breakdowns for every known session, served from the memo when it is
 * still fresh. Concurrent callers share one collection.
 */
async function loadBreakdowns(force: boolean): Promise<SessionTokenBreakdown[]> {
	if (!force && memo && Date.now() - memo.computedAt < MEMO_TTL_MS) {
		return memo.breakdowns;
	}
	if (inflight) return inflight;

	inflight = (async () => {
		const cache = getTokenUsageCache();
		await cache.load();
		const breakdowns = await collectBreakdowns(cache);
		await cache.persist();
		memo = { computedAt: Date.now(), breakdowns };
		return breakdowns;
	})();
	try {
		return await inflight;
	} finally {
		inflight = null;
	}
}

/**
 * Compute the token-usage aggregate for a query. The underlying collection is
 * served from the in-memory memo within {@link MEMO_TTL_MS}, and each agent's
 * storage serves unchanged transcripts from its own on-disk parse cache, so a
 * recompute costs only what changed since the last one.
 *
 * @param force - bypass the memo (e.g. an explicit refresh).
 */
export async function getTokenUsageAggregate(
	query: TokenUsageQuery = {},
	force = false
): Promise<TokenUsageAggregate> {
	const breakdowns = await loadBreakdowns(force);
	const result = aggregate(breakdowns, query);
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
	accountGroup,
	bucketStart,
	buildSeries,
	localDayKey,
	COVERAGE_BY_AGENT,
};
