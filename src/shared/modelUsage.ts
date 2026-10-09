/**
 * Per-model token/cost accumulation for the Cost & Tokens dashboard.
 *
 * Each agent's session storage already iterates its transcript to sum token
 * totals; three of them (claude, opencode, copilot) know the model id behind
 * every usage record and the other two lock a single model per session. This
 * accumulator lets every storage fold that per-model data into a uniform
 * {@link ModelTokenUsage}[] with one small helper, instead of each reinventing
 * the map + cost logic.
 *
 * Cost policy (approach: trust provider numbers, estimate only when forced):
 * - When a provider reports a real cost (opencode's per-message `cost`), pass it
 *   to {@link ModelUsageAccumulator.add} - the bucket is marked `costEstimated:
 *   false`.
 * - When no cost is reported (codex, copilot, factory, and claude which is itself
 *   rate-table priced), omit it - the bucket's cost is computed from
 *   `modelPricing` and marked `costEstimated: true`.
 *
 * No Electron imports, so the CLI can bundle this alongside `modelPricing`.
 */

import {
	calculateModelCost,
	normalizeModelId,
	type ModelCost,
	type TokenCounts,
} from './modelPricing';
import type { ModelTokenUsage } from './tokenUsage';

interface ModelBucket {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	/** Sum of provider-reported cost. Only meaningful when `hasReportedCost`. */
	reportedCostUsd: number;
	/** True once any contribution to this model carried a provider-reported cost. */
	hasReportedCost: boolean;
}

function emptyBucket(): ModelBucket {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheCreationTokens: 0,
		reportedCostUsd: 0,
		hasReportedCost: false,
	};
}

/**
 * Accumulates token counts (and optional provider-reported cost) per normalized
 * model id, then finalizes to a {@link ModelTokenUsage}[] with cost either
 * summed from the reported figures or estimated from the rate table.
 */
export class ModelUsageAccumulator {
	private readonly buckets = new Map<string, ModelBucket>();

	/**
	 * Add one usage record for `rawModel`. Pass `reportedCostUsd` only when the
	 * provider emits a real cost for this record; omit it to have the cost
	 * estimated from the rate table at finalize time.
	 */
	add(rawModel: string | undefined | null, tokens: TokenCounts, reportedCostUsd?: number): void {
		const model = normalizeModelId(rawModel ?? '');
		let bucket = this.buckets.get(model);
		if (!bucket) {
			bucket = emptyBucket();
			this.buckets.set(model, bucket);
		}
		bucket.inputTokens += tokens.inputTokens || 0;
		bucket.outputTokens += tokens.outputTokens || 0;
		bucket.cacheReadTokens += tokens.cacheReadTokens ?? 0;
		bucket.cacheCreationTokens += tokens.cacheCreationTokens ?? 0;
		if (typeof reportedCostUsd === 'number' && Number.isFinite(reportedCostUsd)) {
			bucket.reportedCostUsd += reportedCostUsd;
			bucket.hasReportedCost = true;
		}
	}

	/** Whether any usage has been recorded. */
	get isEmpty(): boolean {
		return this.buckets.size === 0;
	}

	/** Collapse to the dashboard shape, computing estimated cost where none was reported. */
	finalize(): ModelTokenUsage[] {
		const result: ModelTokenUsage[] = [];
		for (const [model, bucket] of this.buckets) {
			const tokens: TokenCounts = {
				inputTokens: bucket.inputTokens,
				outputTokens: bucket.outputTokens,
				cacheReadTokens: bucket.cacheReadTokens,
				cacheCreationTokens: bucket.cacheCreationTokens,
			};
			const costEstimated = !bucket.hasReportedCost;
			result.push({
				model,
				inputTokens: bucket.inputTokens,
				outputTokens: bucket.outputTokens,
				cacheReadTokens: bucket.cacheReadTokens,
				cacheCreationTokens: bucket.cacheCreationTokens,
				costUsd: costEstimated
					? calculateModelCost(tokens, model || undefined)
					: bucket.reportedCostUsd,
				costEstimated,
			});
		}
		return result;
	}
}

/**
 * Map the rate-table `byModel` split from `computeClaudeUsageCost` straight to
 * {@link ModelTokenUsage}[]. Claude's cost is itself rate-table priced, so every
 * bucket is flagged `costEstimated: true`.
 */
export function claudeModelUsage(byModel: ModelCost[]): ModelTokenUsage[] {
	return byModel.map((m) => ({
		model: normalizeModelId(m.model),
		inputTokens: m.inputTokens,
		outputTokens: m.outputTokens,
		cacheReadTokens: m.cacheReadTokens,
		cacheCreationTokens: m.cacheCreationTokens,
		costUsd: m.costUsd,
		costEstimated: true,
	}));
}
