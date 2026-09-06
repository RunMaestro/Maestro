/**
 * footerSummary
 *
 * Every Usage Dashboard tab answers a different question, so the footer's
 * center slot carries a one-line readout of whatever that tab is actually
 * looking at: how many agents survived the filters, how many Cue runs failed,
 * how close the tightest plan window is to its wall.
 *
 * All of the copy lives here, as pure functions over already-computed numbers,
 * for two reasons:
 *
 *   1. Consistency. Eleven tabs writing their own footer string inline would
 *      drift in separator, pluralization, and tone within a release.
 *   2. Ownership. A tab's numbers live wherever that tab's data lives - some in
 *      the dashboard modal (`StatsAggregation`), some inside a panel that
 *      fetches for itself (Cue, Auto Run, Shortcuts, plan quotas). The rule is
 *      "whoever owns the data writes the summary", and these builders are what
 *      both sides call so the two paths cannot disagree about phrasing.
 *
 * Returning `null` means "this tab has nothing worth saying right now" (still
 * loading, empty range); the footer then renders no center slot at all rather
 * than a row of zeroes.
 */

import type { Session, UsageDashboardViewMode } from '../../types';
import type { StatsAggregation } from '../../../shared/stats-types';
import { formatCost, formatNumber, formatRelativeTime } from '../../../shared/formatters';
import { countActiveAgents } from '../../../shared/statsActiveAgents';
import { formatHour, formatShortDate } from './SummaryCards';

/**
 * Tabs the footer can describe.
 *
 * `'tokens'` is deliberately included even though this branch has no Tokens
 * tab: the split dashboard on `rc` does, and carrying the case here means the
 * port is a copy rather than a rewrite. An unreachable case costs nothing; a
 * missing one costs the next person the whole module.
 */
export type FooterSummaryTab = UsageDashboardViewMode | 'tokens';

/** Separator between facts. Middle dot, matching the rest of the dashboard. */
const SEP = ' · ';

/** Join the parts that survived, or `null` when nothing did. */
function join(parts: Array<string | null | undefined | false>): string | null {
	const kept = parts.filter((part): part is string => typeof part === 'string' && part.length > 0);
	return kept.length > 0 ? kept.join(SEP) : null;
}

/** `1 agent` / `84 agents`, with thousands compacted by `formatNumber`. */
function count(n: number, singular: string, plural = `${singular}s`): string {
	return `${formatNumber(n)} ${n === 1 ? singular : plural}`;
}

/** Non-terminal sessions. Terminals are not agents anywhere in the dashboard. */
function agentsOf(sessions: readonly Session[]): Session[] {
	return sessions.filter((s) => s.toolType !== 'terminal');
}

/**
 * Overview: the three numbers that frame everything else on the tab - how much
 * was asked, by how many agents, over how many days that actually saw work.
 */
export function buildOverviewSummary(
	data: StatsAggregation,
	sessions?: readonly Session[]
): string | null {
	if (data.totalQueries === 0) return null;
	const activeDays = data.byDay.filter((d) => d.count > 0).length;
	const agentCount = sessions ? agentsOf(sessions).length : null;
	return join([
		count(data.totalQueries, 'query', 'queries'),
		agentCount !== null ? count(agentCount, 'agent') : null,
		activeDays > 0 ? count(activeDays, 'active day') : null,
	]);
}

/**
 * Agent Overview: the shape of the fleet. Provider spread answers "how much am
 * I actually multi-model?", and the active count is the only number on that
 * tab that moves with the range picker.
 */
export function buildAgentOverviewSummary(
	sessions: readonly Session[],
	data: StatsAggregation
): string | null {
	const agents = agentsOf(sessions);
	if (agents.length === 0) return null;
	const providers = new Set(agents.map((s) => s.toolType)).size;
	const worktrees = agents.filter((s) => !!s.parentSessionId).length;
	return join([
		count(agents.length, 'agent'),
		count(providers, 'provider'),
		`${formatNumber(countActiveAgents(agents, data.bySessionByDay))} active`,
		worktrees > 0 ? count(worktrees, 'worktree') : null,
	]);
}

/**
 * Agents: how many cards the filters left on screen. The bare total is the
 * honest reading when nothing is filtered - "84 of 84" invites the user to
 * hunt for a filter they never set.
 */
export function buildAgentsSummary(visible: number, total: number): string | null {
	if (total === 0) return null;
	if (visible === total) return count(total, 'agent');
	return `${formatNumber(visible)} of ${count(total, 'agent')}`;
}

/**
 * Groups: how many groups survived the filter, plus how much of the fleet is
 * still unfiled. Unfiled agents are the actionable half - they are the ones
 * missing from every group rollup on the tab.
 */
export function buildGroupsSummary(
	visibleGroups: number,
	totalGroups: number,
	unfiledAgents: number
): string | null {
	if (totalGroups === 0) return null;
	const groupPart =
		visibleGroups === totalGroups
			? count(totalGroups, 'group')
			: `${formatNumber(visibleGroups)} of ${count(totalGroups, 'group')}`;
	return join([groupPart, unfiledAgents > 0 ? `${count(unfiledAgents, 'agent')} unfiled` : null]);
}

/**
 * Tokens: spend, plus the coverage caveat that makes it readable. Rows written
 * before the token columns existed report no usage at all, so a total drawn
 * from a fraction of the turns must say which fraction - otherwise the number
 * looks like it covers everything and quietly understates the real spend.
 */
export function buildTokensSummary(data: StatsAggregation): string | null {
	const totals = Object.values(data.bySessionTokens ?? {});
	if (totals.length === 0) return null;

	let tokens = 0;
	let cost = 0;
	let priced = 0;
	for (const t of totals) {
		tokens += t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheCreationTokens;
		cost += t.costUsd;
		priced += t.pricedQueries;
	}
	if (tokens === 0 && cost === 0) return null;

	const coverage =
		data.totalQueries > 0 && priced < data.totalQueries
			? `${formatNumber(priced)} of ${formatNumber(data.totalQueries)} turns priced`
			: null;
	return join([count(tokens, 'token'), `~${formatCost(cost)}`, coverage]);
}

/**
 * Activity: when the work happened. Peak hour and best day are the two facts
 * the charts on this tab exist to surface, so the footer states them outright.
 */
export function buildActivitySummary(data: StatsAggregation): string | null {
	if (data.totalQueries === 0) return null;

	let peakHour: { hour: number; count: number } | null = null;
	for (const entry of data.byHour) {
		if (entry.count > 0 && (!peakHour || entry.count > peakHour.count)) peakHour = entry;
	}

	let bestDay: { date: string; count: number } | null = null;
	for (const day of data.byDay) {
		if (day.count > 0 && (!bestDay || day.count > bestDay.count)) bestDay = day;
	}

	const activeDays = data.byDay.filter((d) => d.count > 0).length;
	return join([
		peakHour ? `Peak hour ${formatHour(peakHour.hour)}` : null,
		bestDay ? `busiest ${formatShortDate(bestDay.date)} with ${formatNumber(bestDay.count)}` : null,
		activeDays > 0 ? count(activeDays, 'active day') : null,
	]);
}

/**
 * Auto Run: runs, and how much of what they set out to do actually got done.
 * `attempted` is the checkbox count in the documents, not agent invocations.
 */
export function buildAutoRunSummary(input: {
	runs: number;
	tasksCompleted: number;
	tasksAttempted: number;
}): string | null {
	if (input.runs === 0) return null;
	const { tasksCompleted, tasksAttempted } = input;
	const rate = tasksAttempted > 0 ? Math.round((tasksCompleted / tasksAttempted) * 100) : null;
	return join([
		count(input.runs, 'run'),
		tasksAttempted > 0
			? `${formatNumber(tasksCompleted)} of ${count(tasksAttempted, 'task')} done (${rate}%)`
			: null,
	]);
}

/**
 * Cue: volume and blast radius. Failures lead when there are any - a success
 * percentage buries the four runs that broke inside a comfortable 97%.
 */
export function buildCueSummary(input: {
	runs: number;
	failures: number;
	pipelines: number;
}): string | null {
	if (input.runs === 0) return null;
	const successRate = Math.round(((input.runs - input.failures) / input.runs) * 100);
	return join([
		count(input.runs, 'run'),
		input.pipelines > 0 ? count(input.pipelines, 'pipeline') : null,
		input.failures > 0 ? `${formatNumber(input.failures)} failed` : `${successRate}% success`,
	]);
}

/**
 * Shortcuts: presses in range, and the mastery fraction the whole tab is built
 * around. The denominator is BOUND shortcuts only - an unbound chord cannot be
 * pressed, so counting it would hold the ratio under 100% forever.
 */
export function buildShortcutsSummary(input: {
	presses: number;
	used: number;
	bound: number;
	levelName?: string;
}): string | null {
	if (input.bound === 0 && input.presses === 0) return null;
	return join([
		input.presses > 0 ? count(input.presses, 'press', 'presses') : null,
		input.bound > 0
			? `${formatNumber(input.used)} of ${count(input.bound, 'shortcut')} used`
			: null,
		input.levelName ?? null,
	]);
}

/**
 * Plan quota tabs (Anthropic / OpenAI): how many accounts feed this surface,
 * how many are locked out, and how close the tightest window is to its wall.
 * The peak is across accounts on purpose - one account at 96% is the fact that
 * matters, and an average would hide it behind three idle ones.
 */
export function buildQuotaSummary(input: {
	accounts: number;
	needsLogin: number;
	/** Highest window usage seen across accounts, 0-100. Null when unsampled. */
	peakPercent: number | null;
	/** Epoch ms of the most recent sample, or null when nothing has sampled. */
	sampledAtMs: number | null;
}): string | null {
	if (input.accounts === 0) return null;
	return join([
		count(input.accounts, 'account'),
		input.needsLogin > 0 ? `${formatNumber(input.needsLogin)} needs login` : null,
		input.peakPercent !== null ? `peak window ${Math.round(input.peakPercent)}%` : null,
		input.sampledAtMs !== null ? `sampled ${formatRelativeTime(input.sampledAtMs)}` : null,
	]);
}

/**
 * Summaries for the tabs whose numbers the dashboard modal already holds.
 * Everything else is published by the panel that fetches its own data - see
 * `usePublishFooterSummary`.
 */
export function buildModalOwnedFooterSummary(
	tab: FooterSummaryTab,
	ctx: { data: StatsAggregation | null; sessions: readonly Session[] }
): string | null {
	if (!ctx.data) return null;
	switch (tab) {
		case 'overview':
			return buildOverviewSummary(ctx.data, ctx.sessions);
		case 'agent-overview':
			return buildAgentOverviewSummary(ctx.sessions, ctx.data);
		case 'activity':
			return buildActivitySummary(ctx.data);
		case 'tokens':
			return buildTokensSummary(ctx.data);
		default:
			// Panel-owned: 'agents', 'groups', 'autorun', 'cue', 'shortcuts',
			// 'anthropic-usage', 'codex-usage'.
			return null;
	}
}
