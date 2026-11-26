/**
 * Token-Usage Accessor
 *
 * Builds the Cost & Tokens dashboard payload from each agent's own on-disk
 * session storage (the ground truth), not the stats SQLite DB. Flow:
 *
 * 1. Enumerate the distinct (agentType, projectPath) pairs Maestro has tracked,
 *    from the stats `session_lifecycle` table (skipping remote sessions).
 *    Agents whose conversations are on another computer (SSH and hosted) are
 *    counted there instead (`remote-breakdowns.ts`) and merged in.
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
import { AGENT_CAPABILITIES } from '../../agents/capabilities';
import { getProviderAccountDirs } from '../../agents/provider-account-dirs';
import { getLiveSessions } from '../../stores/getters';
import { isInitialized as storesInitialized } from '../../stores/instances';
import { getPeerMirrorService } from '../../federation';
import { withStatsIndexing } from '../stats-indexing';
import { logger } from '../../utils/logger';
import { captureException } from '../../utils/sentry';
import {
	DEFAULT_ACCOUNT_KEY,
	type ModelTokenUsage,
	type SessionTokenBreakdown,
	type TokenCoverage,
	type TokenUsageAggregate,
	type TokenUsageExclusions,
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
import {
	summarizeTokenSpeed,
	tokenGranularityFor,
	tokenSliceStart,
	tokenSliceStarts,
	type TokenSpeedSource,
} from '../../../shared/tokenSpeed';
import type { AgentRecord } from '../../../shared/maestro-lib/store/records';
import { getTokenUsageCache, type TokenUsageCache } from './token-usage-cache';
import {
	COVERAGE_BY_AGENT,
	collectProjectBreakdowns,
	createSessionListGate,
	projectTokenUsage,
	toBreakdown,
} from './project-breakdowns';
import type {
	ProjectTokenUsage,
	ProjectTokenUsageProject,
} from '../../../shared/projectTokenUsage';
import {
	collectRemoteBreakdowns,
	remoteProjectPairKey,
	remoteTokenAgentsOf,
	type RemoteBreakdowns,
	type RemoteTokenAgent,
	type RemoteTokenUsageRequest,
} from './remote-breakdowns';

const LOG_CONTEXT = '[TokenUsageAccessor]';

/** How long collected breakdowns stay fresh in memory before a re-collect. */
const MEMO_TTL_MS = 30_000;

/** What one collection pass read, plus what it had to skip. */
interface Collection {
	breakdowns: SessionTokenBreakdown[];
	excluded: TokenUsageExclusions;
}

/** What the local scan read, plus the remote lifecycle pairs it left to the remote count. */
interface LocalCollection extends Collection {
	remotePairs: Set<string>;
}

interface MemoEntry extends LocalCollection {
	computedAt: number;
}

/**
 * The local collection, not the aggregate: collection is the expensive step
 * and is query-independent, while aggregating is pure in-memory math over the
 * same array. Memoizing here means flipping the dashboard's time range or
 * granularity re-buckets what we already have instead of re-walking storage.
 */
let memo: MemoEntry | null = null;
/** Shared by concurrent callers so a double mount can't run two collections. */
let inflight: Promise<LocalCollection> | null = null;

/** The last count of the agents on another computer, and which targets it asked about. */
interface RemoteEntry {
	computedAt: number;
	/** {@link remoteTargetKey} of every agent it asked about. */
	targets: Set<string>;
	result: RemoteBreakdowns;
}

/**
 * What one remote agent's count is of: the agent, where its conversations are, and which
 * provider. A count of an agent whose working directory or remote changed is not its count now.
 */
function remoteTargetKey(agent: RemoteTokenAgent): string {
	return canonicalJson([agent.id, agent.remoteId, agent.provider, agent.projectPath]);
}

/**
 * The remote count is kept apart from the local one: a host can take up to
 * `REMOTE_TOKEN_USAGE_TIMEOUT_MS` to answer, and the local totals never wait on
 * it. A read serves the last remote result at once and refreshes it in the
 * background; the dashboard reads again when the refresh lands.
 */
let remoteMemo: RemoteEntry | null = null;
let remoteInflight: Promise<RemoteEntry> | null = null;
/** Bumped on invalidation, so a refresh started before it neither is joined nor fills the memo. */
let remoteGeneration = 0;

/** Reset the in-memory memo (call on external stats changes / tests). */
export function invalidateTokenUsageMemo(): void {
	memo = null;
	remoteMemo = null;
	remoteInflight = null;
	remoteGeneration++;
}

// ---------------------------------------------------------------------------
// Enumeration
// ---------------------------------------------------------------------------

/** No exclusions: the default for callers (tests) that build breakdowns directly. */
function noExclusions(): TokenUsageExclusions {
	return {
		unsupportedAgents: [],
		remoteProjects: 0,
		notCountedAgents: [],
		pendingAgents: [],
		remoteRefreshing: false,
		partialAgents: [],
	};
}

/**
 * Distinct (agentType -> set of projectPaths) Maestro has tracked locally.
 * Remote sessions are left to the remote's own count (their transcripts live
 * there) and returned as `remotePairs`; agent types with no transcript storage
 * are counted into `excluded` so the dashboard can say what its totals leave out.
 */
function enumerateAgentProjects(): {
	byAgent: Map<string, Set<string>>;
	excluded: TokenUsageExclusions;
	/** `agentType|projectPath` of every remote lifecycle row. */
	remotePairs: Set<string>;
} {
	const byAgent = new Map<string, Set<string>>();
	const excluded = noExclusions();
	const remote = new Set<string>();
	const db = getStatsDB();
	if (!db.isReady()) return { byAgent, excluded, remotePairs: remote };

	let events;
	try {
		events = db.getSessionLifecycleEvents('all');
	} catch (error) {
		void captureException(error);
		return { byAgent, excluded, remotePairs: remote };
	}

	const unsupported = new Set<string>();
	for (const ev of events) {
		if (!ev.projectPath) continue;
		if (ev.isRemote) {
			remote.add(remoteProjectPairKey(ev.agentType, ev.projectPath));
			continue;
		}
		if (!getSessionStorage(ev.agentType)) {
			// The terminal is not an agent with a model behind it; leaving it
			// out is not a gap in the totals.
			if (ev.agentType !== 'terminal') unsupported.add(ev.agentType);
			continue;
		}
		let set = byAgent.get(ev.agentType);
		if (!set) {
			set = new Set<string>();
			byAgent.set(ev.agentType, set);
		}
		set.add(ev.projectPath);
	}
	excluded.remoteProjects = remote.size;
	excluded.unsupportedAgents = [...unsupported].sort();
	return { byAgent, excluded, remotePairs: remote };
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/**
 * The agents whose conversations are on another computer, from the stored agents. Empty before
 * the stores exist (tests, a very early call).
 */
function readRemoteTokenAgents(): RemoteTokenAgent[] {
	if (!storesInitialized()) return [];
	try {
		return remoteTokenAgentsOf(getLiveSessions() as AgentRecord[]);
	} catch (error) {
		void captureException(error, { operation: 'tokenUsage:readRemoteAgents' });
		return [];
	}
}

/** Ask a remote's host, over the peer mirror's connection, for its projects' usage. */
const requestRemoteTokenUsage: RemoteTokenUsageRequest = async (remoteId, projects, timeoutMs) =>
	(await getPeerMirrorService()?.projectTokenUsage(remoteId, projects, timeoutMs)) ?? undefined;

/**
 * The usage of `agents` (whose conversations are on another computer), counted on that computer.
 * Shows on the stats indexing surface while a remote is slow to answer.
 */
async function collectRemoteAgentBreakdowns(
	agents: readonly RemoteTokenAgent[]
): Promise<RemoteBreakdowns> {
	if (agents.length === 0) return { breakdowns: [], notCounted: [], pairs: new Set(), partial: [] };
	return withStatsIndexing(
		{ id: 'remote-token-usage', label: 'Token usage on other computers', reason: 'index' },
		async (progress) => {
			progress.addWork(new Set(agents.map((agent) => agent.remoteId)).size, 0);
			return collectRemoteBreakdowns(agents, requestRemoteTokenUsage, {
				onRemoteDone: () => progress.advance(1, 0),
				onError: (error) => void captureException(error, { operation: 'tokenUsage:remote' }),
			});
		}
	);
}

/**
 * Count `agents` on their computers, once at a time: a second caller joins the
 * refresh in flight. Never rejects: a failure leaves every agent "not counted".
 */
function refreshRemote(agents: readonly RemoteTokenAgent[]): Promise<RemoteEntry> {
	if (remoteInflight) return remoteInflight;
	const targets = new Set(agents.map(remoteTargetKey));
	const generation = remoteGeneration;
	const pending = (async (): Promise<RemoteEntry> => {
		let result: RemoteBreakdowns;
		try {
			result = await collectRemoteAgentBreakdowns(agents);
		} catch (error) {
			void captureException(error, { operation: 'tokenUsage:remoteRefresh' });
			result = {
				breakdowns: [],
				notCounted: [...agents],
				pairs: new Set(
					agents.map((agent) => remoteProjectPairKey(agent.provider, agent.projectPath))
				),
				partial: [],
			};
		}
		const entry = { computedAt: Date.now(), targets, result };
		if (generation === remoteGeneration) remoteMemo = entry;
		return entry;
	})();
	remoteInflight = pending;
	void pending.finally(() => {
		if (remoteInflight === pending) remoteInflight = null;
	});
	return pending;
}

/** Whether `entry` asked about exactly the targets of `agents`. */
function askedAbout(entry: RemoteEntry, agents: readonly RemoteTokenAgent[]): boolean {
	return (
		entry.targets.size === agents.length &&
		agents.every((agent) => entry.targets.has(remoteTargetKey(agent)))
	);
}

/** The remote count a read uses, and whether a newer one is still being read. */
interface RemoteRead {
	agents: RemoteTokenAgent[];
	entry: RemoteEntry | null;
	refreshing: boolean;
}

/**
 * The remote count for a read. A fresh one is served as it is. Otherwise a
 * refresh starts in the background and the last result (if any) is served at
 * once, unless the caller waits for the refresh (`maestro-cli stats-tokens`,
 * an export: a script wants the whole number).
 */
async function loadRemote(force: boolean, waitForRemote: boolean): Promise<RemoteRead> {
	const agents = readRemoteTokenAgents();
	if (agents.length === 0) return { agents, entry: null, refreshing: false };
	if (
		!force &&
		remoteMemo &&
		Date.now() - remoteMemo.computedAt < MEMO_TTL_MS &&
		askedAbout(remoteMemo, agents)
	) {
		return { agents, entry: remoteMemo, refreshing: false };
	}
	const refresh = refreshRemote(agents);
	if (waitForRemote) {
		// A refresh already running may be for an older set of agents: then ask again, for these.
		let entry = await refresh;
		if (!askedAbout(entry, agents)) entry = await refreshRemote(agents);
		return { agents, entry, refreshing: !askedAbout(entry, agents) };
	}
	return { agents, entry: remoteMemo, refreshing: true };
}

/**
 * The local collection with the remote count laid over it. An agent the remote
 * result did not ask about yet is named as still being read, not as not counted.
 */
function withRemote(local: LocalCollection, remote: RemoteRead): Collection {
	const result = remote.entry?.result;
	const asked = remote.entry?.targets ?? new Set<string>();
	const current = new Set(remote.agents.map(remoteTargetKey));
	const pending = remote.agents.filter((agent) => !asked.has(remoteTargetKey(agent)));
	const pairs = new Set(result?.pairs ?? []);
	for (const agent of pending) pairs.add(remoteProjectPairKey(agent.provider, agent.projectPath));
	// A count served while it refreshes may hold projects no current agent asks about any more (an
	// agent removed or moved): leave those out, and keep a project another agent still asks about.
	const wanted = new Set(
		remote.agents.map((agent) => remoteProjectPairKey(agent.provider, agent.projectPath))
	);
	const remoteBreakdowns = (result?.breakdowns ?? []).filter((breakdown) =>
		wanted.has(remoteProjectPairKey(breakdown.agentType, breakdown.projectPath))
	);
	return {
		breakdowns: remoteBreakdowns.length
			? [...local.breakdowns, ...remoteBreakdowns]
			: local.breakdowns,
		excluded: {
			...local.excluded,
			// A remote pair of a stored agent is now counted, named below, or being
			// read; what is left belongs to agents that no longer exist here.
			remoteProjects: [...local.remotePairs].filter((pair) => !pairs.has(pair)).length,
			notCountedAgents: (result?.notCounted ?? [])
				.filter((agent) => current.has(remoteTargetKey(agent)))
				.map((agent) => agent.name),
			pendingAgents: pending.map((agent) => agent.name),
			remoteRefreshing: remote.refreshing,
			partialAgents: [
				...(local.excluded.partialAgents ?? []),
				...(result?.partial ?? [])
					.filter(({ agent }) => current.has(remoteTargetKey(agent)))
					.map(({ agent, skippedFiles }) => ({ name: agent.name, conversations: skippedFiles })),
			],
		},
	};
}

/**
 * Collect one breakdown per known local session, using the cache for unchanged
 * ones. Live keys are tracked so the cache can prune sessions deleted on disk.
 * The conversations of agents on another computer are counted there
 * (`loadRemote`), never here.
 */
async function collectBreakdowns(cache: TokenUsageCache): Promise<LocalCollection> {
	const { byAgent, excluded, remotePairs } = enumerateAgentProjects();
	const local = await collectProjectBreakdowns(byAgent, {
		storageFor: getSessionStorage,
		accountDirsFor: (agentType) => getProviderAccountDirs(agentType),
		cache,
		onError: (error) => void captureException(error),
	});
	cache.prune(local.liveKeys);
	excluded.partialAgents = localPartialAgents(local.skippedProjects);
	return { breakdowns: local.breakdowns, excluded, remotePairs };
}

/**
 * The local projects a storage read only in part (transcripts too large or unreadable), named the way
 * an agent on another computer is: by the agents working there, else by the folder.
 */
function localPartialAgents(
	skippedProjects: ReadonlyMap<string, number>
): Array<{ name: string; conversations: number }> {
	if (skippedProjects.size === 0) return [];
	let records: AgentRecord[] = [];
	if (storesInitialized()) {
		try {
			records = getLiveSessions() as AgentRecord[];
		} catch (error) {
			void captureException(error, { operation: 'tokenUsage:readLocalAgents' });
		}
	}
	const remoteIds = new Set(remoteTokenAgentsOf(records).map((agent) => agent.id));
	const partial: Array<{ name: string; conversations: number }> = [];
	for (const [key, conversations] of skippedProjects) {
		const [agentType, projectPath] = key.split('\u0000');
		const names = records
			.filter(
				(record) =>
					!remoteIds.has(record.id) &&
					record.toolType === agentType &&
					(record.cwd === projectPath || record.projectRoot === projectPath)
			)
			.map((record) => (typeof record.name === 'string' && record.name ? record.name : record.id));
		partial.push({
			name: names.length > 0 ? [...new Set(names)].join(', ') : projectLabel(projectPath),
			conversations,
		});
	}
	return partial;
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

/** Round a timestamp down to the start of its hour/day/week/month (local time). */
function bucketStart(ms: number, granularity: TokenTimelineGranularity): number {
	return tokenSliceStart(ms, granularity);
}

/**
 * The window a query covers, and the granularity its timelines use. An open
 * start (All Time) begins at the earliest activity in the data - a session's
 * last activity or a timed call, whichever is older - so the timeline spans the
 * history that exists rather than the epoch.
 */
function resolveWindow(
	all: SessionTokenBreakdown[],
	query: TokenUsageQuery,
	nowMs: number
): { startMs: number; endMs: number; granularity: TokenTimelineGranularity } {
	const endMs = query.untilMs ?? nowMs;
	let startMs = query.sinceMs;
	if (startMs === undefined) {
		let earliest = Infinity;
		for (const s of all) {
			if (s.byModel.length > 0 && s.timestampMs > 0 && s.timestampMs < earliest) {
				earliest = s.timestampMs;
			}
			for (const b of s.speed ?? []) {
				if (b.startMs < earliest) earliest = b.startMs;
			}
		}
		startMs = Number.isFinite(earliest) ? Math.min(earliest, endMs) : endMs;
	}
	const granularity = query.granularity ?? tokenGranularityFor(Math.max(0, endMs - startMs));
	return { startMs, endMs, granularity };
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
function aggregate(
	all: SessionTokenBreakdown[],
	query: TokenUsageQuery,
	excluded: TokenUsageExclusions = noExclusions(),
	nowMs: number = Date.now(),
	streamSpeed: readonly TokenSpeedSource[] = []
): TokenUsageAggregate {
	const window = resolveWindow(all, query, nowMs);
	const granularity = window.granularity;
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
	const coverageByAgent = keyedRecord<TokenCoverage>();

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

	// Dense over the window: an idle slice is an explicit zero bar, so a quiet
	// week keeps its width on the axis instead of vanishing between its neighbours.
	// An open window with no dated activity has no start to fill from; leave it
	// empty. A session with no usable timestamp counts in the totals but never
	// lands on the timeline, so it does not start one either.
	const fillTimeline = query.sinceMs !== undefined || timeline.size > 0;
	for (const start of fillTimeline
		? tokenSliceStarts(window.startMs, window.endMs, granularity)
		: []) {
		if (!timeline.has(start)) timeline.set(start, { startMs: start, ...emptyTotals() });
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
		speed: buildSpeed(all, query, window, streamSpeed),
		coverageByAgent,
		excluded,
		granularity,
		windowStartMs: window.startMs,
		windowEndMs: window.endMs,
		generatedAtMs: nowMs,
	};
}

/** Local `YYYY-MM-DD` for a timestamp, matching the format `StatsAggregation.byDay` uses. */
function localDayKey(ms: number): string {
	const d = new Date(ms);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
		d.getDate()
	).padStart(2, '0')}`;
}

/**
 * An empty record with no prototype. The series are keyed by strings a remote host supplies (a
 * conversation id), and a plain object indexed by `__proto__` reaches `Object.prototype`; with no
 * prototype every key is only ever an own property.
 */
function keyedRecord<T>(): Record<string, T> {
	return Object.create(null) as Record<string, T>;
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
		byDay: keyedRecord(),
		byHour: keyedRecord(),
		byAgentByDay: keyedRecord(),
		bySessionByDay: keyedRecord(),
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
				agentDays = keyedRecord();
				series.byAgentByDay[s.agentType] = agentDays;
			}
			bump(agentDays, day, tokens);

			if (!ambiguous.has(s.sessionId)) {
				let sessionDays = series.bySessionByDay[s.sessionId];
				if (!sessionDays) {
					sessionDays = keyedRecord();
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
function buildSpeed(
	all: SessionTokenBreakdown[],
	query: TokenUsageQuery,
	window: { startMs: number; endMs: number; granularity: TokenTimelineGranularity },
	streamSpeed: readonly TokenSpeedSource[] = []
) {
	const sinceMs = query.sinceMs ?? -Infinity;
	const sources: TokenSpeedSource[] = [];
	for (const s of all) {
		if (!s.speed || s.speed.length === 0) continue;
		if (s.timestampMs > 0 && s.timestampMs < sinceMs) continue;
		sources.push({ agentType: s.agentType, buckets: s.speed });
	}
	// Calls timed off the live stream (providers with no timed transcript, and
	// transcript providers on an SSH host). They never overlap the transcript
	// buckets above: the stream sampler skips agents whose transcript it can read.
	sources.push(...streamSpeed);
	return summarizeTokenSpeed(sources, {
		measurableAgents: measurableTokenSpeedAgents(),
		sinceMs: query.sinceMs,
		untilMs: query.untilMs,
		// Same slices as the consumption timeline, so the two charts line up.
		granularity: window.granularity,
		windowStartMs: window.startMs,
		nowMs: window.endMs,
		agentLabel: getAgentDisplayName,
		modelKey: (model) => (model ? normalizeModelId(model) : 'unknown'),
		modelLabel: (key) => (key === 'unknown' ? modelLabel('') : key),
	});
}

/** Provider ids whose capabilities say their token speed can be measured. */
function measurableTokenSpeedAgents(): string[] {
	return Object.entries(AGENT_CAPABILITIES)
		.filter(([, caps]) => caps.tokenSpeedMeasurement !== 'none')
		.map(([agentId]) => agentId)
		.sort();
}

/**
 * The stream-timed speed buckets for a window, or none when the stats database
 * is unavailable (the transcript figures still stand on their own).
 */
function loadStreamSpeed(query: TokenUsageQuery): TokenSpeedSource[] {
	const db = getStatsDB();
	if (!db.isReady()) return [];
	try {
		return db.getTokenSpeedSources(query.sinceMs);
	} catch (error) {
		void captureException(error, { operation: 'loadStreamSpeed' });
		return [];
	}
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
 * Collected local breakdowns for every known session, served from the memo when
 * it is still fresh. Concurrent callers share one collection.
 */
async function loadLocal(force: boolean): Promise<LocalCollection> {
	if (!force && memo && Date.now() - memo.computedAt < MEMO_TTL_MS) {
		return memo;
	}
	if (inflight) return inflight;

	inflight = (async () => {
		const cache = getTokenUsageCache();
		await cache.load();
		const collection = await collectBreakdowns(cache);
		await cache.persist();
		memo = { computedAt: Date.now(), ...collection };
		return collection;
	})();
	try {
		return await inflight;
	} finally {
		inflight = null;
	}
}

/** Every breakdown a read counts: the local scan, with the remote count laid over it. */
async function loadBreakdowns(force: boolean, waitForRemote: boolean): Promise<Collection> {
	const [local, remote] = await Promise.all([loadLocal(force), loadRemote(force, waitForRemote)]);
	return withRemote(local, remote);
}

/** How a read treats the agents whose conversations are on another computer. */
export interface TokenUsageReadOptions {
	/**
	 * Wait for their count instead of serving the last one and refreshing it in
	 * the background. For a script (`maestro-cli stats-tokens`, an export) that
	 * wants the whole number; the dashboard never waits.
	 */
	waitForRemote?: boolean;
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
	force = false,
	options: TokenUsageReadOptions = {}
): Promise<TokenUsageAggregate> {
	const { breakdowns, excluded } = await loadBreakdowns(force, options.waitForRemote === true);
	// Read fresh on every call, outside the memo: stream samples land live.
	const result = aggregate(breakdowns, query, excluded, Date.now(), loadStreamSpeed(query));
	logger.debug(
		`Computed token usage: ${result.totals.sessionCount} sessions, $${result.totals.costUsd.toFixed(2)}`,
		LOG_CONTEXT
	);
	return result;
}

/** Joins and limits the session listings this machine runs for its Federation peers. */
const peerListGate = createSessionListGate();

/**
 * The usage of `projects` on this machine, for a Federation peer that asked
 * (`get_project_token_usage`): the same storages and account dirs this
 * machine's own dashboard reads.
 */
export function getProjectTokenUsage(
	projects: readonly ProjectTokenUsageProject[]
): Promise<ProjectTokenUsage> {
	return projectTokenUsage(projects, {
		storageFor: getSessionStorage,
		gate: peerListGate,
		accountDirsFor: (agentType) => getProviderAccountDirs(agentType),
		onError: (error) => void captureException(error, { operation: 'tokenUsage:peerProjects' }),
	});
}

/** Test seam: expose internals for unit tests. */
export const _internal = {
	toBreakdown,
	aggregate,
	enumerateAgentProjects,
	accountGroup,
	bucketStart,
	resolveWindow,
	buildSeries,
	buildSpeed,
	localDayKey,
	COVERAGE_BY_AGENT,
};
