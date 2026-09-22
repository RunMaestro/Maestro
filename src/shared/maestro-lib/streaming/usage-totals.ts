/**
 * Usage totalling - maestro-lib Part Two.
 *
 * Summing a turn's usage events into one total, shared by the CLI spawner and
 * Cue's process lifecycle. Pairs with `UsageAccumulator`, which normalizes a
 * cumulative reporter's events to deltas BEFORE they are summed here.
 */

import type { ParsedEvent } from '../parsers/agent-output-parser';
import type { UsageStats } from '../../types';

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
	};
}

/**
 * Add one usage step to a running total. Token counts and cost sum; the context
 * window is a property of the model, so the largest value wins rather than
 * accumulating.
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
	}
): UsageStats {
	const merged: UsageStats = {
		inputTokens: (current?.inputTokens || 0) + (next.inputTokens || 0),
		outputTokens: (current?.outputTokens || 0) + (next.outputTokens || 0),
		cacheReadInputTokens: (current?.cacheReadInputTokens || 0) + (next.cacheReadTokens || 0),
		cacheCreationInputTokens:
			(current?.cacheCreationInputTokens || 0) + (next.cacheCreationTokens || 0),
		totalCostUsd: (current?.totalCostUsd || 0) + (next.costUsd || 0),
		contextWindow: Math.max(current?.contextWindow || 0, next.contextWindow || 0),
		reasoningTokens: (current?.reasoningTokens || 0) + (next.reasoningTokens || 0),
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
	});
}
