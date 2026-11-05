/**
 * Usage totalling - maestro-lib Part Two.
 *
 * Summing a turn's usage events into one total, shared by the CLI spawner and
 * Cue's process lifecycle. Pairs with `UsageAccumulator`, which normalizes a
 * cumulative reporter's events to deltas BEFORE they are summed here.
 *
 * Token counts and cost are totals, but the context-window fields and the
 * `absoluteUsage` occupancy snapshot are METADATA about the latest state of the
 * conversation, so they are carried forward rather than summed: a later event
 * that omits them must not erase the last snapshot a provider reported.
 */

import type { ParsedEvent } from '../parsers/agent-output-parser';
import { canonicalJson } from '../../canonicalJson';
import type { UsageAccounting, UsageBreakdown, UsageCost, UsageStats } from '../../types';

/** The non-summing half of a `UsageStats`: the window and occupancy snapshot. */
type UsageMetadata = Pick<
	UsageStats,
	'contextWindow' | 'contextWindowResolved' | 'contextWindowModel' | 'absoluteUsage'
>;

/** Convert a parser's usage event into the shared `UsageStats` shape. */
export function parsedUsageToStats(usage: NonNullable<ParsedEvent['usage']>): UsageStats {
	const accounting: UsageAccounting = structuredClone(
		usage.accounting ?? {
			source: 'runtime-stream',
			scope: 'response',
			reporting: 'delta',
			cacheReadCounting: 'unknown',
			cacheCreationCounting: 'unknown',
			completeness: 'unknown',
			childInclusion: 'unknown',
			childCompleteness: 'unknown',
			cost: Number.isFinite(usage.costUsd)
				? { status: 'partial', costUsd: usage.costUsd! }
				: { status: 'unknown' },
		}
	);
	const tokenCount = (value: number | undefined) =>
		Number.isFinite(value) && value! >= 0 ? value! : 0;
	const invalidTokens = [
		usage.inputTokens,
		usage.outputTokens,
		usage.cacheReadTokens,
		usage.cacheCreationTokens,
		usage.reasoningTokens,
	].some((value) => value !== undefined && (!Number.isFinite(value) || value < 0));
	let inputTokens = tokenCount(usage.inputTokens);
	if (accounting.cacheReadCounting === 'inside-input')
		inputTokens -= tokenCount(usage.cacheReadTokens);
	if (accounting.cacheCreationCounting === 'inside-input')
		inputTokens -= tokenCount(usage.cacheCreationTokens);
	if (inputTokens < 0 || invalidTokens) {
		accounting.completeness = 'partial';
		accounting.cost = { status: 'unknown', reason: 'Inconsistent cache buckets' };
	}
	if (accounting.cacheReadCounting === 'inside-input')
		accounting.cacheReadCounting = 'beside-input';
	if (accounting.cacheCreationCounting === 'inside-input')
		accounting.cacheCreationCounting = 'beside-input';
	if (usage.model && accounting.scope === 'response' && !accounting.models) {
		accounting.models = [
			{
				model: usage.model,
				inputTokens: Math.max(0, inputTokens),
				outputTokens: tokenCount(usage.outputTokens),
				cacheReadInputTokens: tokenCount(usage.cacheReadTokens),
				cacheCreationInputTokens: tokenCount(usage.cacheCreationTokens),
				reasoningTokens: tokenCount(usage.reasoningTokens),
				completeness: accounting.completeness,
				cost: structuredClone(accounting.cost),
			},
		];
	}
	return {
		accounting,
		inputTokens: Math.max(0, inputTokens),
		outputTokens: tokenCount(usage.outputTokens),
		cacheReadInputTokens: tokenCount(usage.cacheReadTokens),
		cacheCreationInputTokens: tokenCount(usage.cacheCreationTokens),
		totalCostUsd: usageCostUsd(accounting.cost) ?? 0,
		contextWindow: usage.contextWindow || 0,
		reasoningTokens: tokenCount(usage.reasoningTokens),
		// Same rule as StdoutHandler.buildUsageStats: parsers seed `contextWindow`
		// with fallbacks, so only the provider-reported flag makes it authoritative.
		...(usage.contextWindowReported && (usage.contextWindow || 0) > 0
			? { contextWindowResolved: true }
			: {}),
		...(usage.model ? { contextWindowModel: usage.model } : {}),
		...(usage.absoluteUsage ? { absoluteUsage: { ...usage.absoluteUsage } } : {}),
	};
}

/**
 * Combine the metadata of a running total with a newer step's.
 *
 * The context window is a property of the model, so the largest value wins, as
 * it always has. Its resolved flag and model describe THAT window, so they travel
 * with whichever side supplied it rather than being mixed: a resolved 128k window
 * followed by a larger unresolved fallback must not come out as a "resolved"
 * fallback. On a tie, and for the occupancy snapshot, the latest value a
 * provider actually reported wins, so an event without one keeps the last.
 */
function carryUsageMetadata(
	current: UsageMetadata | undefined,
	next: UsageMetadata
): UsageMetadata {
	const currentWindow = current?.contextWindow || 0;
	const nextWindow = next.contextWindow || 0;

	let contextWindowResolved: boolean | undefined;
	let contextWindowModel: string | undefined;
	if (currentWindow > nextWindow) {
		contextWindowResolved = current?.contextWindowResolved;
		contextWindowModel = current?.contextWindowModel;
	} else if (nextWindow > currentWindow) {
		contextWindowResolved = next.contextWindowResolved;
		contextWindowModel = next.contextWindowModel;
	} else {
		contextWindowResolved = next.contextWindowResolved ?? current?.contextWindowResolved;
		contextWindowModel = next.contextWindowModel ?? current?.contextWindowModel;
	}
	const absoluteUsage = next.absoluteUsage ?? current?.absoluteUsage;

	return {
		contextWindow: Math.max(currentWindow, nextWindow),
		...(contextWindowResolved !== undefined ? { contextWindowResolved } : {}),
		...(contextWindowModel !== undefined ? { contextWindowModel } : {}),
		...(absoluteUsage ? { absoluteUsage: { ...absoluteUsage } } : {}),
	};
}

/**
 * Add one usage step to a running total. Token counts and cost sum; the context
 * window and occupancy metadata carry forward (see `carryUsageMetadata`).
 */
export function mergeUsageStats(
	current: UsageStats | undefined,
	next: {
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens?: number;
		cacheCreationTokens?: number;
		costUsd?: number;
		contextWindow?: number;
		reasoningTokens?: number;
		contextWindowResolved?: boolean;
		contextWindowModel?: string;
		absoluteUsage?: UsageStats['absoluteUsage'];
		accounting?: UsageAccounting;
	}
): UsageStats {
	const accounting = mergeUsageAccounting(current?.accounting, next.accounting, !!current);
	const merged: UsageStats = {
		...(accounting ? { accounting } : {}),
		inputTokens: (current?.inputTokens || 0) + (next.inputTokens || 0),
		outputTokens: (current?.outputTokens || 0) + (next.outputTokens || 0),
		cacheReadInputTokens: (current?.cacheReadInputTokens || 0) + (next.cacheReadTokens || 0),
		cacheCreationInputTokens:
			(current?.cacheCreationInputTokens || 0) + (next.cacheCreationTokens || 0),
		totalCostUsd: (current?.totalCostUsd || 0) + (next.costUsd || 0),
		reasoningTokens: (current?.reasoningTokens || 0) + (next.reasoningTokens || 0),
		...carryUsageMetadata(current, {
			contextWindow: next.contextWindow || 0,
			contextWindowResolved: next.contextWindowResolved,
			contextWindowModel: next.contextWindowModel,
			absoluteUsage: next.absoluteUsage,
		}),
	};

	if (accounting && next.accounting && (!current || current.accounting))
		merged.totalCostUsd = usageCostUsd(accounting.cost) ?? 0;

	if (!next.reasoningTokens && !current?.reasoningTokens) {
		delete merged.reasoningTokens;
	}

	return merged;
}

/** Sum a `UsageStats` step into a running total. */
export function addUsageStats(current: UsageStats | undefined, step: UsageStats): UsageStats {
	return mergeUsageStats(current, {
		inputTokens: step.inputTokens,
		outputTokens: step.outputTokens,
		cacheReadTokens: step.cacheReadInputTokens,
		cacheCreationTokens: step.cacheCreationInputTokens,
		costUsd: step.totalCostUsd,
		contextWindow: step.contextWindow,
		reasoningTokens: step.reasoningTokens,
		contextWindowResolved: step.contextWindowResolved,
		contextWindowModel: step.contextWindowModel,
		absoluteUsage: step.absoluteUsage,
		accounting: step.accounting,
	});
}

/**
 * Take a later usage report as the whole total, for a provider whose last event
 * already carries the turn's totals (Claude Code's `result`). Token counts and
 * cost come from `next` alone; the metadata carries forward exactly as in
 * `mergeUsageStats`, so a trailing event without an occupancy snapshot does not
 * erase the one the turn's last call reported.
 */
export function replaceUsageStats(
	current: UsageStats | undefined,
	next: UsageStats,
	/** Provisional snapshots cannot revoke an already observed cost lower bound. */
	preserveLowerBounds = false
): UsageStats {
	const {
		contextWindowResolved: _resolved,
		contextWindowModel: _model,
		absoluteUsage: _absolute,
		...totals
	} = next;
	const replaced = { ...totals, ...carryUsageMetadata(current, next) };
	if (next.accounting) {
		replaced.accounting = structuredClone(next.accounting);
		if (usageCostUsd(next.accounting.cost) === undefined && current?.accounting) {
			replaced.accounting.cost = mergeUsageCost(current.accounting.cost, next.accounting.cost);
			replaced.totalCostUsd = usageCostUsd(replaced.accounting.cost) ?? 0;
		}
		if (
			(preserveLowerBounds || next.accounting.cost.status === 'partial') &&
			current?.accounting &&
			usageCostIsLower(next.accounting.cost, current.accounting.cost)
		) {
			replaced.accounting.cost = mergeUsageCost(current.accounting.cost, { status: 'unknown' });
			replaced.totalCostUsd = usageCostUsd(replaced.accounting.cost) ?? 0;
		}
		for (const previous of current?.accounting?.models ?? []) {
			const models = (replaced.accounting.models ??= []);
			const model = models.find((entry) => entry.model === previous.model);
			if (!model) {
				models.push({
					...structuredClone(previous),
					completeness: 'partial',
					cost: mergeUsageCost(previous.cost, { status: 'unknown' }),
				});
				continue;
			}
			if (usageCostUsd(model.cost) === undefined)
				model.cost = mergeUsageCost(previous.cost, model.cost);
			else if (
				(preserveLowerBounds || model.cost.status === 'partial') &&
				usageCostIsLower(model.cost, previous.cost)
			)
				model.cost = mergeUsageCost(previous.cost, { status: 'unknown' });
			for (const key of [
				'inputTokens',
				'outputTokens',
				'cacheReadInputTokens',
				'cacheCreationInputTokens',
				'reasoningTokens',
				'callCount',
				'mainAgentRounds',
			] as const) {
				if (model[key] === undefined && previous[key] !== undefined) {
					model[key] = previous[key];
					model.completeness = 'partial';
				}
			}
		}
		if (!next.accounting.children && current?.accounting?.children) {
			replaced.accounting.children = structuredClone(current.accounting.children);
		}
	}
	return replaced;
}

/**
 * Difference between two explicitly related, normalized scope snapshots. The
 * caller proves identity/ownership; this helper never invents a zero baseline.
 * Raw model/child observations remain available on the caller's scope reports.
 */
export function subtractUsageStats(next: UsageStats, baseline: UsageStats): UsageStats | undefined {
	const current = next.accounting,
		before = baseline.accounting;
	if (!current || !before) return undefined;
	for (const key of ['cacheReadCounting', 'cacheCreationCounting'] as const) {
		if (current[key] !== before[key] || current[key] !== 'beside-input') return undefined;
	}
	const result = structuredClone(next);
	const difference = (a: number | undefined, b: number | undefined) =>
		a !== undefined &&
		b !== undefined &&
		Number.isFinite(a) &&
		Number.isFinite(b) &&
		b >= 0 &&
		a >= b
			? a - b
			: undefined;
	for (const key of [
		'inputTokens',
		'outputTokens',
		'cacheReadInputTokens',
		'cacheCreationInputTokens',
	] as const) {
		const delta = difference(next[key], baseline[key]);
		if (delta === undefined) return undefined;
		result[key] = delta;
	}
	if (next.reasoningTokens !== undefined && baseline.reasoningTokens !== undefined) {
		const delta = difference(next.reasoningTokens, baseline.reasoningTokens);
		if (delta === undefined) return undefined;
		result.reasoningTokens = delta;
	} else delete result.reasoningTokens;
	const subtractCost = (now: UsageCost, prior: UsageCost): UsageCost => {
		// A partial ledger minus all prior spend is a conservative lower bound.
		if ((now.status === 'exact' || now.status === 'partial') && prior.status === 'exact') {
			const a = costTicks(now),
				b = costTicks(prior);
			if (
				a !== undefined &&
				b !== undefined &&
				/^\d+$/.test(a) &&
				/^\d+$/.test(b) &&
				BigInt(a) >= BigInt(b)
			) {
				const ticks = (BigInt(a) - BigInt(b)).toString();
				return { status: now.status, costUsdTicks: ticks, costUsd: Number(ticks) / 1e10 };
			}
		}
		if (
			now.status === 'estimated' &&
			prior.status === 'estimated' &&
			now.model === prior.model &&
			now.pricingRevision === prior.pricingRevision &&
			Number.isFinite(now.costUsd) &&
			Number.isFinite(prior.costUsd) &&
			prior.costUsd >= 0 &&
			now.costUsd >= prior.costUsd
		) {
			return {
				...now,
				costUsd: now.costUsd - prior.costUsd,
				completeness:
					now.completeness === 'complete' && prior.completeness === 'complete'
						? 'complete'
						: 'partial',
			};
		}
		return { status: 'unknown', reason: 'Snapshot cost difference is not established' };
	};
	const accounting = result.accounting!;
	accounting.cost = subtractCost(current.cost, before.cost);
	accounting.completeness =
		current.completeness === 'complete' && before.completeness === 'complete'
			? 'complete'
			: 'partial';
	if (current.estimatedCost && before.estimatedCost) {
		const estimate = subtractCost(current.estimatedCost, before.estimatedCost);
		if (estimate.status === 'estimated') accounting.estimatedCost = estimate;
		else delete accounting.estimatedCost;
	} else delete accounting.estimatedCost;
	for (const key of ['callCount', 'mainAgentRounds'] as const) {
		const delta = difference(current[key], before[key]);
		if (delta !== undefined) accounting[key] = delta;
		else delete accounting[key];
	}
	// Only a complete, empty model ledger with zero totals proves new-model zero.
	const emptyModels =
		before.completeness === 'complete' &&
		before.models?.length === 0 &&
		[
			baseline.inputTokens,
			baseline.outputTokens,
			baseline.cacheReadInputTokens,
			baseline.cacheCreationInputTokens,
		].every((value) => value === 0);
	const zeroModel: UsageBreakdown | undefined = emptyModels
		? {
				inputTokens: 0,
				outputTokens: 0,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
				reasoningTokens: 0,
				callCount: before.callCount === 0 ? 0 : undefined,
				mainAgentRounds: before.mainAgentRounds === 0 ? 0 : undefined,
				completeness: 'complete',
				cost:
					before.cost.status === 'exact' && costTicks(before.cost) === '0'
						? before.cost
						: { status: 'unknown' },
			}
		: undefined;
	accounting.models = current.models?.map((model) => {
		const prior = before.models?.find((entry) => entry.model === model.model) ?? zeroModel;
		const delta: UsageBreakdown & { model: string } = {
			model: model.model,
			cost: subtractCost(model.cost, prior?.cost ?? { status: 'unknown' }),
			completeness:
				model.completeness === 'complete' && prior?.completeness === 'complete'
					? 'complete'
					: 'partial',
		};
		for (const key of [
			'inputTokens',
			'outputTokens',
			'cacheReadInputTokens',
			'cacheCreationInputTokens',
			'reasoningTokens',
			'callCount',
			'mainAgentRounds',
		] as const) {
			const value = difference(model[key], prior?.[key]);
			if (value !== undefined) delta[key] = value;
			else if (model[key] !== undefined) delta.completeness = 'partial';
		}
		return delta;
	});
	// A child's running total is not this scope's delta. Keep it only in raw reports.
	delete accounting.children;
	result.totalCostUsd = usageCostUsd(accounting.cost) ?? 0;
	return result;
}

/** Numeric display projection only; exact decimal ticks stay on the accounting fact. */
export function usageCostUsd(cost: UsageCost): number | undefined {
	if (cost.status === 'unknown') return undefined;
	if ('costUsdTicks' in cost && cost.costUsdTicks !== undefined)
		return Number(cost.costUsdTicks) / 1e10;
	return cost.costUsd;
}

/** Convert an explicit USD decimal only when it is exactly representable in ticks. */
function costTicks(cost: UsageCost): string | undefined {
	if ('costUsdTicks' in cost && cost.costUsdTicks !== undefined) return cost.costUsdTicks;
	if (
		cost.status === 'unknown' ||
		cost.costUsd === undefined ||
		!Number.isFinite(cost.costUsd) ||
		cost.costUsd < 0
	)
		return undefined;
	const [coefficient, exponent = '0'] = String(cost.costUsd).split('e');
	const [whole, fraction = ''] = coefficient.split('.');
	const scale = 10 + Number(exponent) - fraction.length;
	const digits = BigInt(whole + fraction);
	if (scale >= 0) return (digits * 10n ** BigInt(scale)).toString();
	const divisor = 10n ** BigInt(-scale);
	return digits % divisor === 0n ? (digits / divisor).toString() : undefined;
}

/** Compare reported amounts without projecting exact tick strings through Number. */
export function usageCostIsLower(next: UsageCost, previous: UsageCost): boolean {
	if (
		next.status === 'unknown' ||
		next.status === 'estimated' ||
		previous.status === 'unknown' ||
		previous.status === 'estimated'
	)
		return false;
	const a = costTicks(next),
		b = costTicks(previous);
	if (a !== undefined && b !== undefined && /^\d+$/.test(a) && /^\d+$/.test(b))
		return BigInt(a) < BigInt(b);
	if (next.costUsdTicks !== undefined || previous.costUsdTicks !== undefined) return false;
	return (
		next.costUsd !== undefined &&
		previous.costUsd !== undefined &&
		Number.isFinite(next.costUsd) &&
		Number.isFinite(previous.costUsd) &&
		next.costUsd >= 0 &&
		previous.costUsd >= 0 &&
		next.costUsd < previous.costUsd
	);
}

/** Combine independent costs. Missing evidence cannot make a complete/free total. */
export function mergeUsageCost(left: UsageCost, right: UsageCost): UsageCost {
	const a = usageCostUsd(left),
		b = usageCostUsd(right);
	const hasTicks = 'costUsdTicks' in left || 'costUsdTicks' in right;
	const ticksA = hasTicks ? costTicks(left) : undefined;
	const ticksB = hasTicks ? costTicks(right) : undefined;
	const costUsdTicks =
		ticksA !== undefined && ticksB !== undefined
			? (BigInt(ticksA) + BigInt(ticksB)).toString()
			: undefined;
	if (left.status === 'estimated' || right.status === 'estimated') {
		if (
			left.status === 'estimated' &&
			right.status === 'estimated' &&
			left.model === right.model &&
			left.pricingRevision === right.pricingRevision
		) {
			return {
				...right,
				costUsd: left.costUsd + right.costUsd,
				completeness:
					left.completeness === 'complete' && right.completeness === 'complete'
						? 'complete'
						: 'partial',
			};
		}
		// Keep reported partial amounts separate from any estimate.
		const reported = left.status === 'estimated' ? right : left;
		return mergeUsageCost(reported.status === 'estimated' ? { status: 'unknown' } : reported, {
			status: 'unknown',
		});
	}
	if (a === undefined && b === undefined) {
		if (left.status === 'partial') return { ...left };
		if (right.status === 'partial') return { ...right };
		return { status: 'unknown' };
	}
	if (a !== undefined && b !== undefined && (ticksA === undefined) !== (ticksB === undefined)) {
		const ticks = (ticksA ?? ticksB)!;
		return {
			status: 'partial',
			costUsdTicks: ticks,
			costUsd: Number(ticks) / 1e10,
			reason: 'Only the tick-representable subtotal is retained',
		};
	}
	const amount = {
		costUsd: (a ?? 0) + (b ?? 0),
		...(costUsdTicks !== undefined
			? { costUsdTicks }
			: a === undefined && ticksB !== undefined
				? { costUsdTicks: ticksB }
				: b === undefined && ticksA !== undefined
					? { costUsdTicks: ticksA }
					: {}),
	};
	return left.status === 'exact' && right.status === 'exact'
		? { status: 'exact', ...amount }
		: { status: 'partial', ...amount };
}

function mergeUsageAccounting(
	left: UsageAccounting | undefined,
	right: UsageAccounting | undefined,
	hasLeft: boolean
): UsageAccounting | undefined {
	if (!left && !right) return undefined;
	if (!hasLeft) return structuredClone(right);
	const result = structuredClone((right ?? left)!);
	result.cost = mergeUsageCost(
		left?.cost ?? { status: 'unknown' },
		right?.cost ?? { status: 'unknown' }
	);
	result.completeness =
		left?.completeness === 'complete' && right?.completeness === 'complete'
			? 'complete'
			: 'partial';
	result.childCompleteness =
		left?.childCompleteness === 'complete' && right?.childCompleteness === 'complete'
			? 'complete'
			: 'unknown';
	result.final = left?.final === true && right?.final === true;
	if (left?.source !== right?.source) result.source = 'runtime-stream';
	for (const key of [
		'scopeId',
		'route',
		'providerSessionId',
		'processGeneration',
		'turnId',
		'requestId',
		'responseId',
	] as const) {
		if (left?.[key] !== right?.[key]) delete result[key];
	}
	const leftEstimate =
		left?.estimatedCost ?? (left?.cost.status === 'estimated' ? left.cost : undefined);
	const rightEstimate =
		right?.estimatedCost ?? (right?.cost.status === 'estimated' ? right.cost : undefined);
	if (leftEstimate || rightEstimate) {
		const estimate =
			leftEstimate && rightEstimate
				? mergeUsageCost(leftEstimate, rightEstimate)
				: { ...(leftEstimate ?? rightEstimate)!, completeness: 'partial' as const };
		if (estimate.status === 'estimated') result.estimatedCost = estimate;
		else delete result.estimatedCost;
	}
	for (const key of ['cacheReadCounting', 'cacheCreationCounting', 'childInclusion'] as const) {
		if (left?.[key] !== right?.[key]) result[key] = 'unknown';
	}
	for (const key of ['callCount', 'mainAgentRounds'] as const) {
		if (left?.[key] !== undefined && right?.[key] !== undefined)
			result[key] = left[key]! + right[key]!;
		else delete result[key];
	}
	const models = new Map<string, UsageBreakdown & { model: string }>();
	for (const entry of [...(left?.models ?? []), ...(right?.models ?? [])]) {
		const previous = models.get(entry.model);
		const merged = structuredClone(entry);
		if (previous) {
			for (const key of [
				'inputTokens',
				'outputTokens',
				'cacheReadInputTokens',
				'cacheCreationInputTokens',
				'reasoningTokens',
				'callCount',
				'mainAgentRounds',
			] as const) {
				if (previous[key] !== undefined && entry[key] !== undefined)
					merged[key] = previous[key]! + entry[key]!;
				else delete merged[key];
			}
			merged.cost = mergeUsageCost(previous.cost, entry.cost);
			merged.completeness =
				previous.completeness === 'complete' && entry.completeness === 'complete'
					? 'complete'
					: 'partial';
		}
		models.set(entry.model, merged);
	}
	if (models.size) result.models = [...models.values()];
	// Stable child IDs describe snapshots, including running -> completed.
	// Anonymous children stay distinct. Neither is additional parent spend.
	if (left?.children || right?.children) {
		const children = new Map<string, NonNullable<UsageAccounting['children']>[number]>();
		for (const child of [...(left?.children ?? []), ...(right?.children ?? [])]) {
			const key =
				child.providerSessionId || child.parentToolUseId
					? canonicalJson([child.providerSessionId ?? null, child.parentToolUseId ?? null])
					: `anonymous:${children.size}`;
			children.set(key, structuredClone(child));
		}
		result.children = [...children.values()];
	}
	return result;
}
