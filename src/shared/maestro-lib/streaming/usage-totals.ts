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
import type { UsageStats } from '../../types';

/** The non-summing half of a `UsageStats`: the window and occupancy snapshot. */
type UsageMetadata = Pick<
	UsageStats,
	'contextWindow' | 'contextWindowResolved' | 'contextWindowModel' | 'absoluteUsage'
>;

/** Convert a parser's usage event into the shared `UsageStats` shape. */
export function parsedUsageToStats(usage: NonNullable<ParsedEvent['usage']>): UsageStats {
	return {
		inputTokens: usage.inputTokens || 0,
		outputTokens: usage.outputTokens || 0,
		cacheReadInputTokens: usage.cacheReadTokens || 0,
		cacheCreationInputTokens: usage.cacheCreationTokens || 0,
		totalCostUsd: usage.costUsd || 0,
		contextWindow: usage.contextWindow || 0,
		reasoningTokens: usage.reasoningTokens || 0,
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
	}
): UsageStats {
	const merged: UsageStats = {
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
	});
}

/**
 * Take a later usage report as the whole total, for a provider whose last event
 * already carries the turn's totals (Claude Code's `result`). Token counts and
 * cost come from `next` alone; the metadata carries forward exactly as in
 * `mergeUsageStats`, so a trailing event without an occupancy snapshot does not
 * erase the one the turn's last call reported.
 */
export function replaceUsageStats(current: UsageStats | undefined, next: UsageStats): UsageStats {
	const {
		contextWindowResolved: _resolved,
		contextWindowModel: _model,
		absoluteUsage: _absolute,
		...totals
	} = next;
	return { ...totals, ...carryUsageMetadata(current, next) };
}
