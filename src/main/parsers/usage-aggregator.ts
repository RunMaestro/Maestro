/**
 * Usage Statistics Aggregator
 *
 * Utility functions for aggregating token usage statistics from AI agents.
 * This module is separate from process-manager to avoid circular dependencies
 * and allow parsers to use it without importing node-pty dependencies.
 */

import type { ToolType } from '../../shared/types';

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
	/**
	 * Model name extracted from modelUsage keys (e.g. "claude-sonnet-4-5-20250929").
	 * Used by VIBES to populate the environment entry's model_name field.
	 */
	modelName?: string;
}

/**
 * Default context window sizes for different agents.
 * Used as fallback when the agent doesn't report its context window size.
 */
export const DEFAULT_CONTEXT_WINDOWS: Record<ToolType, number> = {
	'claude-code': 200000, // Claude 3.5 Sonnet/Claude 4 default context
	codex: 200000, // OpenAI o3/o4-mini context window
	opencode: 128000, // OpenCode (depends on model, 128k is conservative default)
	'factory-droid': 200000, // Factory Droid (varies by model, defaults to Claude Opus)
	terminal: 0, // Terminal has no context window
};

/**
 * Agents that use combined input+output context windows.
 * OpenAI models (Codex, o3, o4-mini) have a single context window that includes
 * both input and output tokens, unlike Claude which has separate limits.
 */
const COMBINED_CONTEXT_AGENTS: Set<ToolType> = new Set(['codex']);

/**
 * Calculate total context tokens based on agent-specific semantics.
 *
 * For a single Anthropic API call, the total input context is the sum of:
 *   inputTokens + cacheReadInputTokens + cacheCreationInputTokens
 * These three fields partition the input into uncached, cache-hit, and newly-cached segments.
 *
 * CAVEAT: When Claude Code performs multi-tool turns (many internal API calls),
 * the reported values may be accumulated across all internal calls within the turn.
 * In that case the total can exceed the context window. Callers should check for
 * this and skip the update (see estimateContextUsage).
 *
 * Claude models: Context = input + cacheRead + cacheCreation
 * OpenAI models: Context = input + output (combined limit)
 *
 * @param stats - The usage statistics containing token counts
 * @param agentId - The agent identifier for agent-specific calculation
 * @returns Total context tokens used
 */
export function calculateContextTokens(
	stats: Pick<
		UsageStats,
		'inputTokens' | 'outputTokens' | 'cacheReadInputTokens' | 'cacheCreationInputTokens'
	>,
	agentId?: ToolType
): number {
	// OpenAI models have combined input+output context limits
	if (agentId && COMBINED_CONTEXT_AGENTS.has(agentId)) {
		return stats.inputTokens + (stats.cacheCreationInputTokens || 0) + stats.outputTokens;
	}

	// Claude models: total input = uncached + cache-hit + newly-cached
	// Output tokens don't consume the input context window
	return (
		stats.inputTokens + (stats.cacheReadInputTokens || 0) + (stats.cacheCreationInputTokens || 0)
	);
}

/**
 * Estimate context usage percentage when the agent doesn't provide it directly.
 * Uses agent-specific default context window sizes for accurate estimation.
 *
 * Context calculation varies by agent:
 * - Claude models: inputTokens + cacheReadInputTokens + cacheCreationInputTokens
 * - OpenAI models (Codex): inputTokens + outputTokens (combined limit)
 *
 * Returns null when the calculated total exceeds the context window, which indicates
 * accumulated values from multi-tool turns (many internal API calls within one turn).
 * A single API call's total input can never exceed the context window, so values
 * above it are definitely accumulated. Callers should preserve the previous valid
 * percentage when this returns null.
 *
 * @param stats - The usage statistics containing token counts
 * @param agentId - The agent identifier for agent-specific context window size
 * @returns Estimated context usage percentage (0-100), or null if cannot be estimated
 */
export function estimateContextUsage(
	stats: Pick<
		UsageStats,
		| 'inputTokens'
		| 'outputTokens'
		| 'cacheReadInputTokens'
		| 'cacheCreationInputTokens'
		| 'contextWindow'
	>,
	agentId?: ToolType
): number | null {
	// Calculate total context using agent-specific semantics
	const totalContextTokens = calculateContextTokens(stats, agentId);

	// Determine effective context window
	const effectiveContextWindow =
		stats.contextWindow && stats.contextWindow > 0
			? stats.contextWindow
			: agentId && agentId !== 'terminal'
				? DEFAULT_CONTEXT_WINDOWS[agentId] || 0
				: 0;

	if (!effectiveContextWindow || effectiveContextWindow <= 0) {
		return null;
	}

	// If total exceeds context window, the values are accumulated across multiple
	// internal API calls within a complex turn (tool use chains). A single API call's
	// total input cannot exceed the context window. Return null to signal callers
	// should keep the previous valid percentage.
	if (totalContextTokens > effectiveContextWindow) {
		return null;
	}

	if (totalContextTokens <= 0) {
		return 0;
	}

	return Math.round((totalContextTokens / effectiveContextWindow) * 100);
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
	let modelName: string | undefined;

	if (modelUsage) {
		// Track the model with the most output tokens as the "primary" model
		let maxModelOutputTokens = 0;
		for (const [name, modelStats] of Object.entries(modelUsage)) {
			maxInputTokens = Math.max(maxInputTokens, modelStats.inputTokens || 0);
			maxOutputTokens = Math.max(maxOutputTokens, modelStats.outputTokens || 0);
			maxCacheReadTokens = Math.max(maxCacheReadTokens, modelStats.cacheReadInputTokens || 0);
			maxCacheCreationTokens = Math.max(
				maxCacheCreationTokens,
				modelStats.cacheCreationInputTokens || 0
			);
			// Use the highest context window from any model
			if (modelStats.contextWindow && modelStats.contextWindow > contextWindow) {
				contextWindow = modelStats.contextWindow;
			}
			// Pick the model with the most output tokens as the primary model name
			const outTokens = modelStats.outputTokens || 0;
			if (outTokens > maxModelOutputTokens || !modelName) {
				maxModelOutputTokens = outTokens;
				modelName = name;
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
		modelName,
	};
}
