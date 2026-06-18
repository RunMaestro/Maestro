/**
 * Pricing utilities for AI agent cost calculations.
 *
 * Thin main-process re-export of the shared, model-aware pricing in
 * `src/shared/modelPricing.ts`. Kept as a stable import surface for existing
 * call sites; new code should prefer `calculateModelCost` / `computeClaudeUsageCost`
 * so cost reflects the model that was actually used.
 */

import {
	calculateWithPricing,
	DEFAULT_MODEL_PRICING,
	type PricingConfig,
	type TokenCounts,
} from '../../shared/modelPricing';

export type { PricingConfig, TokenCounts } from '../../shared/modelPricing';
export {
	calculateModelCost,
	computeClaudeUsageCost,
	resolveModelPricing,
	MODEL_PRICING,
	DEFAULT_MODEL_PRICING,
	type ClaudeUsageBreakdown,
} from '../../shared/modelPricing';

/**
 * Calculate cost for an AI session based on token counts and pricing config.
 *
 * Defaults to the flat Sonnet-tier pricing. When the model is known, prefer
 * `calculateModelCost(tokens, modelId)` for per-model accuracy.
 *
 * @example
 * ```typescript
 * const cost = calculateCost({
 *   inputTokens: 1000,
 *   outputTokens: 500,
 *   cacheReadTokens: 200,
 *   cacheCreationTokens: 100
 * });
 * ```
 */
export function calculateCost(
	tokens: TokenCounts,
	pricing: PricingConfig = DEFAULT_MODEL_PRICING
): number {
	return calculateWithPricing(tokens, pricing);
}

/**
 * Calculate cost using individual token parameters (legacy interface).
 *
 * @deprecated Use calculateModelCost() with a model ID, or calculateCost() with a
 * TokenCounts object.
 */
export function calculateClaudeCost(
	inputTokens: number,
	outputTokens: number,
	cacheReadTokens: number,
	cacheCreationTokens: number
): number {
	return calculateWithPricing({
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheCreationTokens,
	});
}
