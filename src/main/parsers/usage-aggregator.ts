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
}

/**
 * Default context window sizes for different agents.
 * Used as fallback when the agent doesn't report its context window size.
 */
export const DEFAULT_CONTEXT_WINDOWS: Record<ToolType, number> = {
	'claude-code': 200000, // Claude 3.5 Sonnet/Claude 4 default context
	claude: 200000, // Legacy Claude
	codex: 200000, // OpenAI o3/o4-mini context window
	opencode: 128000, // OpenCode (depends on model, 128k is conservative default)
	aider: 128000, // Aider (varies by model, 128k is conservative default)
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
 * Claude models: Context = input + cacheCreation + cacheRead (output excluded)
 * OpenAI models: Context = input + output + cacheRead (combined limit)
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
	const baseTokens =
		stats.inputTokens + (stats.cacheCreationInputTokens || 0) + (stats.cacheReadInputTokens || 0);

	// OpenAI models have combined input+output context limits
	if (agentId && COMBINED_CONTEXT_AGENTS.has(agentId)) {
		return baseTokens + stats.outputTokens;
	}

	// Claude models: output tokens don't consume context window
	return baseTokens;
}

/**
 * Estimate context usage percentage when the agent doesn't provide it directly.
 * Uses agent-specific default context window sizes for accurate estimation.
 *
 * IMPORTANT: Context calculation varies by agent:
 * - Claude models: inputTokens + cacheCreationInputTokens + cacheReadInputTokens
 *   (output tokens are separate from context window)
 * - OpenAI models (Codex): inputTokens + outputTokens + cacheReadInputTokens
 *   (combined context window includes both input and output)
 *
 * The cacheReadInputTokens are critical because they represent the full
 * conversation context being sent, even though they're served from cache
 * for billing purposes.
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

	// If context window is provided and valid, use it
	if (stats.contextWindow && stats.contextWindow > 0) {
		return Math.min(100, Math.round((totalContextTokens / stats.contextWindow) * 100));
	}

	// If no agent specified or terminal, cannot estimate
	if (!agentId || agentId === 'terminal') {
		return null;
	}

	// Use agent-specific default context window
	const defaultContextWindow = DEFAULT_CONTEXT_WINDOWS[agentId];
	if (!defaultContextWindow || defaultContextWindow <= 0) {
		return null;
	}

	if (totalContextTokens <= 0) {
		return 0;
	}

	return Math.min(100, Math.round((totalContextTokens / defaultContextWindow) * 100));
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
