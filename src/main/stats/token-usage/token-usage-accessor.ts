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
import { canonicalJson } from '../../../shared/canonicalJson';
import type { UsageCost } from '../../../shared/types';
import { mergeUsageCost, usageCostUsd } from '../../../shared/maestro-lib/streaming/usage-totals';
import { summarizeTokenSpeed, type TokenSpeedSource } from '../../../shared/tokenSpeed';
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
	grok: 'full',
	codex: 'partial',
	'copilot-cli': 'partial',
	// No cost and no model id on disk: tokens only.
	antigravity: 'partial',
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
 * native accounting exists, lifetime totals remain authoritative even when model
 * detail is partial. Legacy providers retain their existing model projections.
 */
function toBreakdown(
	agentType: string,
	info: AgentSessionInfo,
	accountKey: string = DEFAULT_ACCOUNT_KEY
): SessionTokenBreakdown {
	const coverage: TokenCoverage =
		agentType === 'grok' &&
		(info.accounting?.completeness !== 'complete' || info.accounting.cost.status !== 'exact')
			? 'partial'
			: (COVERAGE_BY_AGENT[agentType] ?? 'unsupported');
	const timestampMs = Date.parse(info.modifiedAt || info.timestamp) || 0;

	let byModel: ModelTokenUsage[];
	if (info.accounting?.models?.length) {
		byModel = info.accounting.models.map((detail) => ({
			model: detail.model,
			rawModel: detail.model,
			accounting: structuredClone(detail),
			inputTokens: detail.inputTokens ?? 0,
			outputTokens: detail.outputTokens ?? 0,
			cacheReadTokens: detail.cacheReadInputTokens ?? 0,
			cacheCreationTokens: detail.cacheCreationInputTokens ?? 0,
			costUsd: usageCostUsd(detail.cost) ?? 0,
			costEstimated: detail.cost.status === 'estimated',
		}));
	} else if (info.accounting) {
		// No model attribution: retain the lifetime amount in an unknown bucket.
		byModel = [
			{
				model: '',
				inputTokens: info.inputTokens,
				outputTokens: info.outputTokens,
				cacheReadTokens: info.cacheReadTokens,
				cacheCreationTokens: info.cacheCreationTokens,
				costUsd: usageCostUsd(info.accounting.cost) ?? 0,
				costEstimated: info.accounting.cost.status === 'estimated',
				accounting: {
					completeness: info.accounting.completeness,
					cost: structuredClone(info.accounting.cost),
				},
			},
		];
	} else if (info.byModel && info.byModel.length > 0) {
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

	const totals = info.accounting
		? {
				inputTokens: info.inputTokens,
				outputTokens: info.outputTokens,
				cacheReadTokens: info.cacheReadTokens,
				cacheCreationTokens: info.cacheCreationTokens,
				costUsd: usageCostUsd(info.accounting.cost) ?? 0,
				costEstimated: info.accounting.cost.status === 'estimated',
			}
		: sumModels(byModel);
	return {
		sessionId: info.sessionId,
		agentType,
		projectPath: info.projectPath,
		accountKey,
		timestampMs,
		origin: info.origin,
		byModel,
		...(info.accounting
			? {
					accounting: {
						...structuredClone(info.accounting),
						scopeId:
							info.accounting.scopeId ??
							canonicalJson([agentType, accountKey, info.projectPath, info.sessionId]),
					},
				}
			: {}),
		inputTokens: totals.inputTokens,
		outputTokens: totals.outputTokens,
		cacheReadTokens: totals.cacheReadTokens,
		cacheCreationTokens: totals.cacheCreationTokens,
		costUsd: totals.costUsd,
		costEstimated: totals.costEstimated,
		coverage,
		...(info.speed && info.speed.length > 0 ? { speed: info.speed } : {}),
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
					// Grok IDs are scoped to account/cwd, and aliased project queries
					// can return the same native directory more than once.
					const key = tokenCacheKey(
						agentType === 'grok'
							? canonicalJson([agentType, accountKey, info.projectPath])
							: `${agentType}@${accountKey}`,
						info.sessionId
					);
					if (agentType === 'grok' && liveKeys.has(key)) continue;
					liveKeys.add(key);
					const fingerprint = sessionFingerprint(info.modifiedAt, info.sizeBytes);
					// A Grok usage.json update need not change the transcript size or
					// summary timestamp. Storage already sampled all native files;
					// never replace that observation with a stale single-file cache.
					let breakdown = agentType === 'grok' ? undefined : cache.get(key, fingerprint);
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

/**
 * A legacy provider-reported amount, which carries no completeness proof. Summed
 * float amounts (0.1 + 0.2) are not tick-representable, and the canonical merge
 * keeps only the tick-representable subtotal beside exact Grok ticks, so such an
 * amount used to vanish from a mixed total. Round it to the 10^-10 USD tick, far
 * below display precision; an amount past the safe-integer range stays decimal.
 */
function legacyReportedCost(costUsd: number): UsageCost {
	const ticks = Math.round(costUsd * 1e10);
	return Number.isSafeInteger(ticks)
		? { status: 'partial', costUsd: ticks / 1e10, costUsdTicks: String(ticks) }
		: { status: 'partial', costUsd };
}

/** Add independent session totals or model detail, preserving cost evidence. */
function addUsageToTotals(
	t: TokenUsageTotals,
	m: Omit<ModelTokenUsage, 'model'>,
	accountingByTotals: Map<TokenUsageTotals, NonNullable<TokenUsageTotals['accounting']>>
): void {
	// Track each legacy contribution before canonical evidence arrives, so mixed
	// reported/estimated subtotals do not depend on provider enumeration order.
	const previous = accountingByTotals.get(t);
	const next = m.accounting ?? {
		completeness: 'unknown' as const,
		cost:
			m.costUsd > 0 && !m.costEstimated
				? legacyReportedCost(m.costUsd)
				: { status: 'unknown' as const },
	};
	const accounting: NonNullable<TokenUsageTotals['accounting']> = {
		completeness:
			!previous || previous.completeness === next.completeness ? next.completeness : 'partial',
		cost: previous ? mergeUsageCost(previous.cost, next.cost) : structuredClone(next.cost),
	};
	accountingByTotals.set(t, accounting);
	// Legacy-only displays keep their historical numeric/estimate contract.
	if (t.accounting || m.accounting) t.accounting = accounting;
	t.inputTokens += m.inputTokens;
	t.outputTokens += m.outputTokens;
	t.cacheReadTokens += m.cacheReadTokens;
	t.cacheCreationTokens += m.cacheCreationTokens;
	t.costUsd = t.accounting ? (usageCostUsd(t.accounting.cost) ?? 0) : t.costUsd + m.costUsd;
	t.costEstimated = t.accounting
		? t.accounting.cost.status === 'estimated'
		: t.costEstimated || (m.costEstimated && m.costUsd > 0);
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
	const accountingByTotals = new Map<
		TokenUsageTotals,
		NonNullable<TokenUsageTotals['accounting']>
	>();
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
		if (s.byModel.length > 0 || s.agentType === 'grok') {
			const previous = coverageByAgent[s.agentType];
			coverageByAgent[s.agentType] =
				previous === 'unsupported' || s.coverage === 'unsupported'
					? 'unsupported'
					: previous === 'partial' || s.coverage === 'partial'
						? 'partial'
						: 'full';
		}
		if (s.byModel.length === 0 && !s.accounting) continue;

		// Native lifetime totals are independent of model/child attribution; legacy
		// model contributions retain their separate reported/estimated amounts.
		const contributions = s.accounting ? [s] : s.byModel;
		const account = accountGroup(s.agentType, s.accountKey);
		for (const total of [
			totals,
			group(byAgent, s.agentType, getAgentDisplayName(s.agentType)).total,
			group(byProject, s.projectPath, projectLabel(s.projectPath)).total,
			group(byAccount, account.key, account.label).total,
		]) {
			for (const contribution of contributions)
				addUsageToTotals(total, contribution, accountingByTotals);
			total.sessionCount++;
		}

		let tb: TokenUsageTimeBucket | undefined;
		if (s.timestampMs > 0) {
			const bStart = bucketStart(s.timestampMs, granularity);
			tb = timeline.get(bStart);
			if (!tb) {
				tb = { startMs: bStart, ...emptyTotals() };
				timeline.set(bStart, tb);
			}
			for (const contribution of contributions)
				addUsageToTotals(tb, contribution, accountingByTotals);
			tb.sessionCount++;
		}

		const seenModels = new Set<string>();
		for (const m of s.byModel) {
			const key =
				m.rawModel !== undefined ? canonicalJson([s.agentType, m.rawModel]) : m.model || 'unknown';
			const total = group(byModel, key, m.rawModel || modelLabel(m.model)).total;
			addUsageToTotals(total, m, accountingByTotals);
			if (!seenModels.has(key)) total.sessionCount++;
			seenModels.add(key);
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
		speed: buildSpeed(all, query),
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

	// This legacy series is keyed by native ID alone. Do not credit another
	// account/provider's tokens to a tab when its native ID collides.
	const owners = new Map<string, string>();
	const ambiguous = new Set<string>();
	for (const s of all) {
		const owner = canonicalJson([s.agentType, s.accountKey, s.projectPath]);
		if (owners.has(s.sessionId) && owners.get(s.sessionId) !== owner) ambiguous.add(s.sessionId);
		owners.set(s.sessionId, owner);
	}

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

			if (!ambiguous.has(s.sessionId)) {
				let sessionDays = series.bySessionByDay[s.sessionId];
				if (!sessionDays) {
					sessionDays = {};
					series.bySessionByDay[s.sessionId] = sessionDays;
				}
				bump(sessionDays, day, tokens);
			}
		}

		if (s.origin === 'user' || s.origin === 'auto') {
			series.bySource[s.origin] += tokens;
		}
	}

	return series;
}

/**
 * Token speed for the window. Filtered per BUCKET (the hour a call finished),
 * not per session: a session is skipped only when its last activity predates
 * the window, since then none of its calls can fall inside it.
 */
function buildSpeed(all: SessionTokenBreakdown[], query: TokenUsageQuery) {
	const sinceMs = query.sinceMs ?? -Infinity;
	const sources: TokenSpeedSource[] = [];
	for (const s of all) {
		if (!s.speed || s.speed.length === 0) continue;
		if (s.timestampMs > 0 && s.timestampMs < sinceMs) continue;
		sources.push({ agentType: s.agentType, buckets: s.speed });
	}
	return summarizeTokenSpeed(sources, {
		sinceMs: query.sinceMs,
		untilMs: query.untilMs,
		agentLabel: getAgentDisplayName,
		modelKey: (model) => (model ? normalizeModelId(model) : 'unknown'),
		modelLabel: (key) => (key === 'unknown' ? modelLabel('') : key),
	});
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
	buildSpeed,
	localDayKey,
	COVERAGE_BY_AGENT,
};
