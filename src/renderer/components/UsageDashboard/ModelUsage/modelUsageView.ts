/**
 * modelUsageView - what the Models tab derives from a `ModelUsage` record.
 *
 * The record itself is built once, in the main process (`getModelUsage()`), and
 * is the same one `maestro-cli stats models` prints. Nothing here reads a
 * database or re-counts a row: these are the tab's own shapes over that record
 * (the headline numbers, the sort orders, the bar scale, the slice colors),
 * kept as pure functions so they are tested without rendering anything.
 */

import { formatDurationDecimal } from '../../../../shared/duration';
import {
	modelUsageOnDeviceShare,
	modelUsageSourceLatency,
	type ModelUsage,
	type ModelUsageAgent,
	type ModelUsageDecisionCounts,
	type ModelUsageSource,
	type ModelUsageTask,
} from '../../../../shared/local-models/model-usage';
import { SYSTEM_ONE_LEDGER_OUTCOME_LABELS } from '../../../../shared/local-models/system-one-ledger';
import { TIER_LEVELS, type ModelTier } from '../../../../shared/tierLevels';
import {
	COLORBLIND_AGENT_PALETTE,
	COLORBLIND_STATUS_COLORS,
} from '../../../constants/colorblindPalettes';
import type { Theme } from '../../../types';
import type { DonutSlice } from '../../widgets';

/** The sources the tab is about: every one that is not a provider's own cloud. */
export function otherModelSources(sources: readonly ModelUsageSource[]): ModelUsageSource[] {
	return sources.filter((source) => source.kind !== 'provider');
}

/** The numbers the four summary cards and the footer line state. */
export interface ModelUsageSummary {
	/** Requests on a source that is not a provider's own cloud. */
	requests: number;
	/** Requests on every source, the providers' own cloud included. */
	allRequests: number;
	/** Sources that are not a provider's own cloud. */
	sourceCount: number;
	/** Failed runs and failed routed requests on those sources. */
	errors: number;
	/** Tokens those sources read and wrote. */
	tokensIn: number;
	tokensOut: number;
	/** Share of every request that ran on this machine, 0 to 1. */
	onDeviceShare: number;
	onDeviceRequests: number;
	onDeviceTokens: number;
	decisions: number;
	/** Decisions an engine answered. */
	answered: number;
	costUsd: number;
}

export function summarizeModelUsage(usage: ModelUsage): ModelUsageSummary {
	const others = otherModelSources(usage.sources);
	const sum = (pick: (source: ModelUsageSource) => number) =>
		others.reduce((total, source) => total + pick(source), 0);
	return {
		requests: usage.totals.otherModelRequests,
		allRequests: usage.totals.requests,
		sourceCount: others.length,
		errors: sum((source) => source.errors),
		tokensIn: sum((source) => source.tokensIn),
		tokensOut: sum((source) => source.tokensOut),
		onDeviceShare: modelUsageOnDeviceShare(usage.totals),
		onDeviceRequests: usage.totals.onDeviceRequests,
		onDeviceTokens: usage.totals.onDeviceTokens,
		decisions: usage.systemOne.decisions,
		answered: usage.systemOne.outcomes.ok,
		costUsd: usage.systemOne.costUsd,
	};
}

/** `61%`. A share of nothing is a dash, not 0%: nothing ran, so nothing was "not local". */
export function formatShare(share: number, of: number): string {
	return of > 0 ? `${Math.round(share * 100)}%` : '-';
}

/**
 * A latency as the tab prints it: `4ms`, `240ms`, `1.2s`, `1.5m`. One unit and
 * one decimal, because the column holds values four orders of magnitude apart
 * (an embedding lookup and a whole agent turn) and has to stay scannable.
 */
export function formatLatency(ms: number): string {
	return formatDurationDecimal(Math.round(ms));
}

/** Where a source's model is, as the Location column says it. */
export type SourceLocationTone = 'local' | 'remote' | 'unknown';

export function sourceLocation(source: Pick<ModelUsageSource, 'onDevice'>): {
	label: string;
	tone: SourceLocationTone;
	title: string;
} {
	if (source.onDevice === true) {
		return { label: 'This machine', tone: 'local', title: 'The model ran on this computer.' };
	}
	if (source.onDevice === false) {
		return { label: 'Remote', tone: 'remote', title: 'The work left this computer.' };
	}
	return {
		label: 'Unknown',
		tone: 'unknown',
		title:
			'This source is no longer saved, so where it ran is not known. It is not counted as on this machine.',
	};
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

export type SourceSortKey =
	| 'source'
	| 'requests'
	| 'tokensIn'
	| 'tokensOut'
	| 'errors'
	| 'p50'
	| 'p95';

export type TaskSortKey = 'task' | 'runs' | 'errors' | 'tokens' | 'p50' | 'p95';

/** A name column sorts A to Z first; every other column is a magnitude, biggest first. */
export function defaultSortDirection(key: SourceSortKey | TaskSortKey): 'asc' | 'desc' {
	return key === 'source' || key === 'task' ? 'asc' : 'desc';
}

function sortRows<T>(
	rows: readonly T[],
	value: (row: T) => number | string,
	label: (row: T) => string,
	descending: boolean
): T[] {
	return [...rows].sort((a, b) => {
		const left = value(a);
		const right = value(b);
		const diff =
			typeof left === 'string' || typeof right === 'string'
				? String(left).localeCompare(String(right))
				: left - right;
		// Ties fall back to the name, ascending in both directions, so equal
		// rows do not swap places when the direction flips.
		return (descending ? -diff : diff) || label(a).localeCompare(label(b));
	});
}

function sourceSortValue(source: ModelUsageSource, key: SourceSortKey): number | string {
	switch (key) {
		case 'source':
			return source.label;
		case 'requests':
			return source.requests;
		case 'tokensIn':
			return source.tokensIn;
		case 'tokensOut':
			return source.tokensOut;
		case 'errors':
			return source.errors;
		case 'p50':
			return modelUsageSourceLatency(source)?.distribution.p50 ?? 0;
		case 'p95':
			return modelUsageSourceLatency(source)?.distribution.p95 ?? 0;
	}
}

export function sortModelSources(
	sources: readonly ModelUsageSource[],
	key: SourceSortKey,
	descending: boolean
): ModelUsageSource[] {
	return sortRows(
		sources,
		(source) => sourceSortValue(source, key),
		(source) => source.label,
		descending
	);
}

function taskSortValue(task: ModelUsageTask, key: TaskSortKey): number | string {
	switch (key) {
		case 'task':
			return task.label;
		case 'runs':
			return task.runs;
		case 'errors':
			return task.errors;
		case 'tokens':
			return task.tokensIn + task.tokensOut;
		case 'p50':
			return task.latency.p50;
		case 'p95':
			return task.latency.p95;
	}
}

export function sortModelTasks(
	tasks: readonly ModelUsageTask[],
	key: TaskSortKey,
	descending: boolean
): ModelUsageTask[] {
	return sortRows(
		tasks,
		(task) => taskSortValue(task, key),
		(task) => task.label,
		descending
	);
}

// ---------------------------------------------------------------------------
// Latency bars
// ---------------------------------------------------------------------------

/** One source on a latency chart. */
export interface LatencyBarRow {
	key: string;
	label: string;
	p50: number;
	p95: number;
	/** How many samples the two figures were read from. */
	count: number;
}

/**
 * The sources a latency chart draws for one unit, fastest median first.
 *
 * `request` reads `latency` (one answered model call) and `turn` reads
 * `turnDuration` (one whole agent turn). A source can be on both charts: a
 * model server that named tabs and also ran an agent's turns has both.
 */
export function latencyBarRows(
	sources: readonly ModelUsageSource[],
	unit: 'request' | 'turn'
): LatencyBarRow[] {
	return sources
		.map((source) => ({
			source,
			distribution: unit === 'request' ? source.latency : source.turnDuration,
		}))
		.filter(({ distribution }) => distribution.count > 0)
		.map(({ source, distribution }) => ({
			key: source.key,
			label: source.label,
			p50: distribution.p50,
			p95: distribution.p95,
			count: distribution.count,
		}))
		.sort((a, b) => a.p50 - b.p50 || a.label.localeCompare(b.label));
}

/** The shortest bar a latency chart draws, so a 1 ms source is still a visible mark. */
const LATENCY_BAR_MIN_PERCENT = 2;

/**
 * How far along the track a duration reaches, 0 to 100, on a log scale from
 * 1 ms to `maxMs`.
 *
 * Log, not linear: one chart holds a 4 ms embedding lookup and a 4 s judge. On
 * a linear track the first is a hairline and every fast source reads the same,
 * which hides exactly the difference between sources the chart is for.
 */
export function latencyBarPercent(ms: number, maxMs: number): number {
	const top = Math.log10(Math.max(maxMs, 10));
	const at = Math.log10(Math.max(ms, 1));
	return Math.min(100, Math.max(LATENCY_BAR_MIN_PERCENT, (at / top) * 100));
}

// ---------------------------------------------------------------------------
// Run on agents
// ---------------------------------------------------------------------------

/** The agents that launched turns on a Run on source: the ones the tiles draw. */
export function runOnAgents(agents: readonly ModelUsageAgent[]): ModelUsageAgent[] {
	return agents.filter((agent) => agent.turns > 0);
}

/** An agent's name, or what to call one that no longer exists. */
export function modelUsageAgentName(agent: {
	agentId: string | null;
	name: string | null;
}): string {
	if (agent.agentId === null) return 'No agent (started outside the app)';
	return agent.name ?? `Removed agent ${agent.agentId.slice(0, 8)}`;
}

/** `qwen3-coder on Ollama`, with `+2 more` when the agent ran on several targets. */
export function describeAgentTargets(agent: Pick<ModelUsageAgent, 'targets'>): string {
	const [first, ...rest] = agent.targets;
	if (!first) return '';
	const head = `${first.model} on ${first.sourceLabel}`;
	return rest.length > 0 ? `${head} +${rest.length} more` : head;
}

// ---------------------------------------------------------------------------
// System One
// ---------------------------------------------------------------------------

/**
 * The outcome split as donut slices. The five outcomes partition the decisions,
 * so the slices sum to the total. `timeouts` is not a slice: it cuts across the
 * failed outcomes and would count those decisions twice.
 */
export function systemOneOutcomeSlices(
	counts: ModelUsageDecisionCounts,
	theme: Theme,
	colorBlindMode: boolean
): DonutSlice[] {
	const status = colorBlindMode ? COLORBLIND_STATUS_COLORS : theme.colors;
	return [
		{
			label: SYSTEM_ONE_LEDGER_OUTCOME_LABELS.ok,
			value: counts.outcomes.ok,
			color: status.success,
		},
		{
			label: SYSTEM_ONE_LEDGER_OUTCOME_LABELS['failed-open'],
			value: counts.outcomes['failed-open'],
			color: status.warning,
		},
		{
			label: SYSTEM_ONE_LEDGER_OUTCOME_LABELS['failed-closed'],
			value: counts.outcomes['failed-closed'],
			color: status.error,
		},
		{
			label: SYSTEM_ONE_LEDGER_OUTCOME_LABELS.unavailable,
			value: counts.outcomes.unavailable,
			color: theme.colors.textDim,
		},
		{
			label: SYSTEM_ONE_LEDGER_OUTCOME_LABELS.cancelled,
			value: counts.outcomes.cancelled,
			color: theme.colors.border,
		},
	];
}

const TIER_LABELS: Readonly<Record<ModelTier, string>> = Object.freeze({
	low: 'Low',
	medium: 'Medium',
	high: 'High',
});

/** How many turns Auto's router sent to each tier, as donut slices, low first. */
export function routedTierSlices(
	tiers: Readonly<Record<ModelTier, number>>,
	theme: Theme,
	colorBlindMode: boolean
): DonutSlice[] {
	const colors: Record<ModelTier, string> = colorBlindMode
		? {
				low: COLORBLIND_AGENT_PALETTE[0],
				medium: COLORBLIND_AGENT_PALETTE[1],
				high: COLORBLIND_AGENT_PALETTE[2],
			}
		: { low: theme.colors.success, medium: theme.colors.warning, high: theme.colors.accent };
	return TIER_LEVELS.map((tier) => ({
		label: TIER_LABELS[tier],
		value: tiers[tier],
		color: colors[tier],
	}));
}

/** Turns Auto's router decided, over the three tiers. */
export function routedTurnCount(tiers: Readonly<Record<ModelTier, number>>): number {
	return TIER_LEVELS.reduce((total, tier) => total + tiers[tier], 0);
}
