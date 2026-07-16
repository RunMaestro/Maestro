/**
 * Pricing utilities for AI agent cost calculations.
 *
 * Thin main-process re-export of the shared, model-aware pricing in
 * `src/shared/modelPricing.ts`. Kept as a stable import surface for existing
 * call sites; new code should prefer `calculateModelCost` / `computeClaudeUsageCost`
 * so cost reflects the model that was actually used.
 */

export type { PricingConfig, TokenCounts } from '../../shared/modelPricing';
export {
	calculateModelCost,
	computeClaudeUsageCost,
	resolveModelPricing,
	MODEL_PRICING,
	DEFAULT_MODEL_PRICING,
	type ClaudeUsageBreakdown,
} from '../../shared/modelPricing';
