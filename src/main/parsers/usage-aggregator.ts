/**
 * Usage Statistics Aggregator
 *
 * Utility functions for aggregating token usage statistics from AI agents.
 * This module is separate from process-manager to avoid circular dependencies
 * and allow parsers to use it without importing node-pty dependencies.
 *
 * SYNC: Context calculation utilities are re-exported from shared/contextUsage.ts.
 * See that file for the canonical formula and all locations that must stay in sync.
 * This module provides the re-exports for the main process.
 */

// Re-export context utilities from shared module
// SYNC: See shared/contextUsage.ts for the canonical calculation
export {
	DEFAULT_CONTEXT_WINDOWS,
	COMBINED_CONTEXT_AGENTS,
	calculateContextTokens,
	estimateContextUsage,
} from '../../shared/contextUsage';

/**
 * Model statistics from Claude Code modelUsage response
 */
export interface ModelStats {
	inputTokens?: number;
	outputTokens?: number;
	cacheReadInputTokens?: number;
	cacheCreationInputTokens?: number;
	contextWindow?: number;
}

/**
 * Usage statistics extracted from model usage data
 */
export interface UsageStats {
	inputTokens: number;
	outputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	totalCostUsd: number;
	contextWindow: number;
	/**
	 * Reasoning/thinking tokens (separate from outputTokens)
	 * Some models like OpenAI o3/o4-mini report reasoning tokens separately.
	 * These are already included in outputTokens but tracked separately for UI display.
	 */
	reasoningTokens?: number;
}

/**
 * Aggregate token counts from modelUsage for accurate context tracking.
 * modelUsage contains per-model breakdown with actual context tokens (including cache hits).
 * Falls back to top-level usage if modelUsage isn't available.
 *
 * @param modelUsage - Per-model statistics object from Claude Code response
 * @param usage - Top-level usage object (fallback)
 * @param totalCostUsd - Total cost from response
 * @returns Aggregated usage statistics
 */
export function aggregateModelUsage(
	modelUsage: Record<string, ModelStats> | undefined,
	usage: {
		input_tokens?: number;
		output_tokens?: number;
		cache_read_input_tokens?: number;
		cache_creation_input_tokens?: number;
	} = {},
	totalCostUsd: number = 0
): UsageStats {
	// Use MAX across models for context-related tokens, not SUM.
	// When Claude Code uses multiple models (e.g., Haiku + Sonnet) in one turn,
	// each model reads approximately the same conversation context from cache.
	// Summing would double-count: Haiku reads 100k + Sonnet reads 100k = 200k (wrong!)
	// MAX gives the actual context size: max(100k, 100k) = 100k (correct!)
	let maxInputTokens = 0;
	let maxOutputTokens = 0;
	let maxCacheReadTokens = 0;
	let maxCacheCreationTokens = 0;
	let contextWindow = 200000; // Default for Claude

	if (modelUsage) {
		for (const modelStats of Object.values(modelUsage)) {
			maxInputTokens = Math.max(maxInputTokens, modelStats.inputTokens || 0);
			maxOutputTokens = Math.max(maxOutputTokens, modelStats.outputTokens || 0);
			maxCacheReadTokens = Math.max(maxCacheReadTokens, modelStats.cacheReadInputTokens || 0);
			maxCacheCreationTokens = Math.max(
				maxCacheCreationTokens,
				modelStats.cacheCreationInputTokens || 0
			);
			// Use the highest context window from any model
			// This ensures we track the maximum context limit across multi-model turns
			if (modelStats.contextWindow && modelStats.contextWindow > contextWindow) {
				contextWindow = modelStats.contextWindow;
			}
		}
	}

	// Fall back to top-level usage if modelUsage isn't available
	// This handles older CLI versions or different output formats
	if (maxInputTokens === 0 && maxOutputTokens === 0) {
		maxInputTokens = usage.input_tokens || 0;
		maxOutputTokens = usage.output_tokens || 0;
		maxCacheReadTokens = usage.cache_read_input_tokens || 0;
		maxCacheCreationTokens = usage.cache_creation_input_tokens || 0;
	}

	return {
		inputTokens: maxInputTokens,
		outputTokens: maxOutputTokens,
		cacheReadInputTokens: maxCacheReadTokens,
		cacheCreationInputTokens: maxCacheCreationTokens,
		totalCostUsd,
		contextWindow,
	};
}
