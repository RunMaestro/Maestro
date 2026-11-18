/**
 * Usage Dashboard reads shared by the IPC handlers (the dashboard) and the
 * WebSocket bridge (`maestro-cli stats-*`).
 *
 * One implementation per figure: the dashboard and the CLI call the same
 * function here, so a number the user reads in a panel and the number an agent
 * reads from the CLI cannot disagree. Pure shaping lives in
 * `src/shared/usageDashboardReads.ts`; this module only gathers the rows.
 */

import { getStatsDB } from './singleton';
import { getTimeRangeStart } from './utils';
import { getCueRunTotals, getCueRunTotalsByDay } from '../cue/cue-db';
import { getCueStatsAggregation } from '../cue/stats/cue-stats-query';
import { getGroupsStore, getSessionsStore } from '../stores/getters';
import {
	forgetSnapshots as forgetClaudeUsageSnapshots,
	getRetainedSnapshots as getRetainedClaudeUsageSnapshots,
	SNAPSHOT_TTL_MS as CLAUDE_SNAPSHOT_TTL_MS,
} from '../stores/claudeUsageStore';
import {
	CODEX_USAGE_SNAPSHOT_TTL_MS,
	forgetCodexUsageSnapshots,
	getRetainedCodexUsageSnapshots,
	type CodexUsageSnapshot,
} from '../stores/codexUsageStore';
import { dropSnapshotsForMissingAccounts } from '../stores/quotaAccountsStore';
import type { UsageSnapshot } from '../agents/claude-mode-selector';
import type { StatsTimeRange } from '../../shared/stats-types';
import type { CueStatsAggregation } from '../../shared/cue-stats-types';
import {
	delegationPercent,
	type DelegationDay,
	type DelegationTotals,
} from '../../shared/delegation';
import {
	buildAgentCountTimeline,
	buildAgentLifespans,
	type LiveAgentRecord,
} from '../../shared/agentCountTimeline';
import { resolveEncoreFeatures } from '../../shared/encoreFeatureDefaults';
import {
	buildUsageActivityStats,
	fillDelegationDays,
	type AgentCountStats,
	type DelegationStats,
	type PlanUsageAccount,
	type PlanUsageReport,
	type UsageActivityStats,
} from '../../shared/usageDashboardReads';

/** The settings store slice these reads need. */
export interface UsageReadSettings {
	get: (key: string) => unknown;
}

// ============================================================================
// Delegation
// ============================================================================

/**
 * Interactive vs autonomous (Auto Run + Cue) split for the delegation
 * surfaces. This is the ONE place the two stats systems are joined: turn rows
 * live in the stats DB, Cue runs in the Cue DB, and neither knows the other
 * exists. Doing the merge here rather than in the renderer means the Overview
 * ratio card, the delegation score, the Activity trend chart, and
 * `maestro-cli stats-delegation` cannot disagree about what counts as
 * delegated.
 *
 * Ungated on purpose: Cue history is real work whether or not the Cue tab is
 * currently switched on, and `getCueRunTotals` already resolves to zero when
 * the Cue DB was never initialized.
 */
export function getDelegationTotals(range: StatsTimeRange = 'all'): DelegationTotals {
	const querySources = getStatsDB().getQuerySourceTotals(range);
	return {
		interactive: querySources.interactive,
		autoRun: querySources.autoRun,
		cue: getCueRunTotals(getTimeRangeStart(range)),
	};
}

/**
 * The same split bucketed by local-time day, for the Activity trend chart.
 * Days with no activity in either system are omitted; the renderer zero-fills
 * so the axis stays calendar-true.
 */
export function getDelegationByDay(range: StatsTimeRange = 'all'): DelegationDay[] {
	const byDate = new Map<string, DelegationDay>();
	const dayFor = (date: string): DelegationDay => {
		let day = byDate.get(date);
		if (!day) {
			day = {
				date,
				interactive: { count: 0, durationMs: 0 },
				autoRun: { count: 0, durationMs: 0 },
				cue: { count: 0, durationMs: 0 },
			};
			byDate.set(date, day);
		}
		return day;
	};

	for (const row of getStatsDB().getQuerySourceByDay(range)) {
		const day = dayFor(row.date);
		day.interactive = row.interactive;
		day.autoRun = row.autoRun;
	}
	for (const row of getCueRunTotalsByDay(getTimeRangeStart(range))) {
		dayFor(row.date).cue = { count: row.count, durationMs: row.durationMs };
	}

	return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

/** Totals, the delegated share, and the gap-filled trend in one payload. */
export function getDelegationStats(
	range: StatsTimeRange,
	now: number = Date.now()
): DelegationStats {
	const totals = getDelegationTotals(range);
	const { window, byDay } = fillDelegationDays(getDelegationByDay(range), range, now);
	return { range, window, totals, percent: delegationPercent(totals), byDay };
}

// ============================================================================
// Cue tab
// ============================================================================

/**
 * Whether the dashboard shows Cue data: BOTH `encoreFeatures.usageStats` and
 * `encoreFeatures.maestroCue` on (each defaults on unless the user turned it
 * off). Same rule as the Cue stats IPC handler.
 */
export function isUsageDashboardCueEnabled(settingsStore: UsageReadSettings): boolean {
	const ef = resolveEncoreFeatures(settingsStore.get('encoreFeatures'));
	return ef.usageStats && ef.maestroCue;
}

/**
 * The Cue tab's statistics for a range, or null when Cue stats are off. The
 * dashboard's IPC handler additionally passes a `subscriptionName -> pipeline`
 * map from the live Cue engine; callers that have one pass it through.
 */
export async function getUsageDashboardCueStats(
	range: StatsTimeRange,
	settingsStore: UsageReadSettings,
	options: { excludeTriggerTypes?: string[]; subscriptionToPipeline?: Map<string, string> } = {}
): Promise<CueStatsAggregation | null> {
	if (!isUsageDashboardCueEnabled(settingsStore)) return null;
	return getCueStatsAggregation(range, options);
}

// ============================================================================
// Activity: Auto Run, wizard, resilience, shortcuts
// ============================================================================

/** Daily counts and totals for the Auto Run, wizard, resilience and shortcut panels. */
export function getUsageActivityStats(
	range: StatsTimeRange,
	now: number = Date.now()
): UsageActivityStats {
	const db = getStatsDB();
	return buildUsageActivityStats({
		range,
		autoRunSessions: db.getAutoRunSessions(range),
		wizardRuns: db.getWizardRuns(range),
		resilienceEvents: db.getResilienceEvents(range),
		shortcutUsageByDay: db.getShortcutUsageByDay(range),
		shortcutTotal: db.getShortcutUsageTotal(range),
		shortcutUsageByShortcut: db.getShortcutUsageByShortcut(range),
		autoRunTurnsByHour: db.getAutoRunTurnsByHour(range),
		now,
	});
}

// ============================================================================
// Agents Over Time
// ============================================================================

/** The agents main persists for the Left Bar, as the agent-count timeline reads them. */
function readLiveAgents(): LiveAgentRecord[] {
	const sessions = getSessionsStore().get('sessions', []) as Array<Record<string, unknown>>;
	return sessions
		.filter((s) => typeof s.id === 'string' && typeof s.toolType === 'string')
		.map((s) => ({
			id: s.id as string,
			toolType: s.toolType as string,
			createdAt: typeof s.createdAt === 'number' ? s.createdAt : undefined,
		}));
}

/**
 * Daily agent count for a range, built by the same shared module the Agent
 * Overview chart uses, from the live agent list plus every `session_lifecycle`
 * row (the only record of a deleted agent).
 */
export function getAgentCountStats(
	range: StatsTimeRange,
	now: number = Date.now()
): AgentCountStats {
	const liveAgents = readLiveAgents();
	const spans = buildAgentLifespans(liveAgents, getStatsDB().getSessionLifecycleEvents('all'));
	const timeline = buildAgentCountTimeline(spans, range, now);
	return {
		range,
		liveAgents: liveAgents.filter((agent) => agent.toolType !== 'terminal').length,
		...timeline,
	};
}

// ============================================================================
// Agent and group names (export enrichment)
// ============================================================================

export interface UsageAgentRecord {
	id: string;
	name: string;
	toolType: string;
	groupId?: string;
}

export interface UsageGroupRecord {
	id: string;
	name: string;
}

/** Live agents and groups, for labelling rows that carry only an agent id. */
export function readAgentDirectory(): { agents: UsageAgentRecord[]; groups: UsageGroupRecord[] } {
	const sessions = getSessionsStore().get('sessions', []) as Array<Record<string, unknown>>;
	// Hand-edited or legacy store files can hold partial rows, so read defensively.
	const groups = getGroupsStore().get('groups', []) as unknown as Array<Record<string, unknown>>;
	return {
		agents: sessions
			.filter((s) => typeof s.id === 'string')
			.map((s) => ({
				id: s.id as string,
				name: typeof s.name === 'string' ? s.name : '',
				toolType: typeof s.toolType === 'string' ? s.toolType : '',
				groupId: typeof s.groupId === 'string' ? s.groupId : undefined,
			})),
		groups: groups
			.filter((g) => typeof g.id === 'string')
			.map((g) => ({ id: g.id as string, name: typeof g.name === 'string' ? g.name : '' })),
	};
}

// ============================================================================
// Plan usage (Anthropic Usage / OpenAI Usage tabs)
// ============================================================================

/**
 * Every retained Claude plan snapshot keyed by canonical `CLAUDE_CONFIG_DIR`,
 * expired ones included so a row keeps its last known bars (the tab badges them
 * stale). A snapshot whose config dir was deleted is forgotten here.
 */
export function getClaudePlanSnapshots(): Promise<Record<string, UsageSnapshot>> {
	return dropSnapshotsForMissingAccounts(
		getRetainedClaudeUsageSnapshots(),
		forgetClaudeUsageSnapshots
	);
}

/** The Codex equivalent of {@link getClaudePlanSnapshots}, keyed by canonical `CODEX_HOME`. */
export function getCodexPlanSnapshots(): Promise<Record<string, CodexUsageSnapshot>> {
	return dropSnapshotsForMissingAccounts(
		getRetainedCodexUsageSnapshots(),
		forgetCodexUsageSnapshots
	);
}

function isStale(sampledAt: string, ttlMs: number, now: number): boolean {
	const ms = Date.parse(sampledAt);
	return !Number.isFinite(ms) || now - ms > ttlMs;
}

export function claudePlanAccount(snapshot: UsageSnapshot, now: number): PlanUsageAccount {
	const windows: PlanUsageAccount['windows'] = [];
	if (snapshot.session) windows.push({ name: 'Session window', ...snapshot.session });
	windows.push({ name: 'Week (all models)', ...snapshot.weekAllModels });
	windows.push({
		name: `Week (${snapshot.weekSonnetOnly.label ?? 'Sonnet only'})`,
		percent: snapshot.weekSonnetOnly.percent,
		resetsAt: snapshot.weekSonnetOnly.resetsAt,
	});
	return {
		provider: 'claude-code',
		accountKey: snapshot.configDirKey,
		email: snapshot.accountEmail,
		organization: snapshot.organizationName,
		authState: snapshot.authState,
		sampledAt: snapshot.sampledAt,
		stale: isStale(snapshot.sampledAt, CLAUDE_SNAPSHOT_TTL_MS, now),
		windows,
	};
}

export function codexPlanAccount(snapshot: CodexUsageSnapshot, now: number): PlanUsageAccount {
	const windows: PlanUsageAccount['windows'] = [];
	if (snapshot.session) {
		windows.push({
			name: 'Session',
			percent: snapshot.session.percent,
			resetsAt: snapshot.session.resetsAt,
		});
	}
	if (snapshot.weekly) {
		windows.push({
			name: 'Weekly',
			percent: snapshot.weekly.percent,
			resetsAt: snapshot.weekly.resetsAt,
		});
	}
	for (const limit of snapshot.additionalLimits ?? []) {
		windows.push({ name: limit.name, percent: limit.percent, resetsAt: limit.resetsAt });
	}
	return {
		provider: 'codex',
		accountKey: snapshot.codexHomeKey,
		email: snapshot.email,
		plan: snapshot.planType,
		authState: snapshot.authState,
		sampledAt: snapshot.sampledAt,
		stale: isStale(snapshot.sampledAt, CODEX_USAGE_SNAPSHOT_TTL_MS, now),
		windows,
		resetCreditsAvailable: snapshot.resetCredits?.available,
		error: snapshot.error,
	};
}

/**
 * The cached plan usage both quota tabs draw, one row per account. Reads the
 * snapshots main already holds; it never re-samples (that is the tabs' Refresh,
 * a separate write).
 */
export async function getPlanUsageReport(now: number = Date.now()): Promise<PlanUsageReport> {
	const [claude, codex] = await Promise.all([getClaudePlanSnapshots(), getCodexPlanSnapshots()]);
	const byKey = (a: PlanUsageAccount, b: PlanUsageAccount) =>
		a.accountKey.localeCompare(b.accountKey);
	return {
		claude: Object.values(claude)
			.map((s) => claudePlanAccount(s, now))
			.sort(byKey),
		codex: Object.values(codex)
			.map((s) => codexPlanAccount(s, now))
			.sort(byKey),
	};
}
