/**
 * Helpers for the per-agent {@link UsageStats} that accumulates live during a
 * run and persists to `maestro-sessions.json`. This is the in-hand, per-Maestro-
 * agent token/cost number the dashboard surfaces (agent cards, agent detail,
 * overview summary) read - distinct from the transcript-derived Cost & Tokens
 * accessor, which is the full-history, per-account/model ground truth.
 *
 * Centralized so every surface sums the same four token buckets and resolves
 * cost the same way (provider-reported `totalCostUsd` when present, rate-table
 * estimate otherwise). No Electron imports.
 */

import type { UsageStats } from './types';
import { calculateModelCost } from './modelPricing';

/** Sum of the four token buckets (input + output + cache read + cache creation). */
export function sumUsageTokens(usage?: UsageStats | null): number {
	if (!usage) return 0;
	return (
		(usage.inputTokens || 0) +
		(usage.outputTokens || 0) +
		(usage.cacheReadInputTokens || 0) +
		(usage.cacheCreationInputTokens || 0)
	);
}

/** True when a usage record carries any tokens at all. */
export function hasUsage(usage?: UsageStats | null): boolean {
	return sumUsageTokens(usage) > 0;
}

/**
 * Resolve a usage record's cost: the provider-reported `totalCostUsd` when it's
 * present and non-zero, otherwise a rate-table estimate for `model`. Returns
 * `{ costUsd, estimated }` so callers can flag estimates in the UI.
 */
export function resolveUsageCost(
	usage?: UsageStats | null,
	model?: string | null
): { costUsd: number; estimated: boolean } {
	if (!usage) return { costUsd: 0, estimated: false };
	if (typeof usage.totalCostUsd === 'number' && usage.totalCostUsd > 0) {
		return { costUsd: usage.totalCostUsd, estimated: false };
	}
	const costUsd = calculateModelCost(
		{
			inputTokens: usage.inputTokens || 0,
			outputTokens: usage.outputTokens || 0,
			cacheReadTokens: usage.cacheReadInputTokens || 0,
			cacheCreationTokens: usage.cacheCreationInputTokens || 0,
		},
		model
	);
	return { costUsd, estimated: costUsd > 0 };
}

/** Aggregate token/cost totals across many usage records. */
export interface UsageAggregate {
	inputTokens: number;
	outputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	totalTokens: number;
	costUsd: number;
	/** True when any part of `costUsd` was rate-table estimated. */
	costEstimated: boolean;
	/** Number of records that carried usage. */
	count: number;
}

function emptyAggregate(): UsageAggregate {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadInputTokens: 0,
		cacheCreationInputTokens: 0,
		totalTokens: 0,
		costUsd: 0,
		costEstimated: false,
		count: 0,
	};
}

/**
 * Sum usage across a set of `{ usageStats, model }` records (e.g. the loaded
 * sessions). Records without usage are skipped; cost is resolved per record so a
 * mix of reported and estimated costs is handled correctly.
 */
export function aggregateUsage(
	records: ReadonlyArray<{ usageStats?: UsageStats | null; model?: string | null }>
): UsageAggregate {
	const agg = emptyAggregate();
	for (const { usageStats, model } of records) {
		if (!hasUsage(usageStats)) continue;
		const u = usageStats as UsageStats;
		agg.inputTokens += u.inputTokens || 0;
		agg.outputTokens += u.outputTokens || 0;
		agg.cacheReadInputTokens += u.cacheReadInputTokens || 0;
		agg.cacheCreationInputTokens += u.cacheCreationInputTokens || 0;
		const { costUsd, estimated } = resolveUsageCost(u, model);
		agg.costUsd += costUsd;
		if (estimated && costUsd > 0) agg.costEstimated = true;
		agg.count++;
	}
	agg.totalTokens =
		agg.inputTokens + agg.outputTokens + agg.cacheReadInputTokens + agg.cacheCreationInputTokens;
	return agg;
}
