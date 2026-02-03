/**
 * Context Usage Estimation Utilities
 *
 * Provides fallback estimation for context window usage when agents
 * don't report their context window size directly.
 */

import type { ToolType } from '../types';

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

/** Minimum growth percentage per accumulated turn */
const MIN_GROWTH_PERCENT = 1;
/** Maximum growth percentage per accumulated turn */
const MAX_GROWTH_PERCENT = 3;
/**
 * Minimum fraction of context window to use when estimating previous token count.
 * Prevents inflated call-count estimates when currentUsage is very low (e.g., 1%).
 */
const MIN_PREV_CONTEXT_FRACTION = 0.05;

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
	stats: {
		inputTokens?: number;
		outputTokens?: number;
		cacheReadInputTokens?: number;
		cacheCreationInputTokens?: number;
	},
	agentId?: ToolType | string
): number {
	// OpenAI models have combined input+output context limits
	if (agentId && COMBINED_CONTEXT_AGENTS.has(agentId as ToolType)) {
		return (
			(stats.inputTokens || 0) + (stats.cacheCreationInputTokens || 0) + (stats.outputTokens || 0)
		);
	}

	// Claude models: total input = uncached + cache-hit + newly-cached
	// Output tokens don't consume the input context window
	return (
		(stats.inputTokens || 0) +
		(stats.cacheReadInputTokens || 0) +
		(stats.cacheCreationInputTokens || 0)
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
	stats: {
		inputTokens?: number;
		outputTokens?: number;
		cacheReadInputTokens?: number;
		cacheCreationInputTokens?: number;
		contextWindow?: number;
	},
	agentId?: ToolType | string
): number | null {
	// Calculate total context using agent-specific semantics
	const totalContextTokens = calculateContextTokens(stats, agentId);

	// Determine effective context window
	const effectiveContextWindow =
		stats.contextWindow && stats.contextWindow > 0
			? stats.contextWindow
			: agentId && agentId !== 'terminal'
				? DEFAULT_CONTEXT_WINDOWS[agentId as ToolType] || 0
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
 * Estimate context growth during accumulated (multi-tool) turns.
 *
 * When estimateContextUsage returns null (accumulated values), the percentage
 * would freeze at the last valid value. This function provides a conservative
 * growth estimate so the gauge keeps moving during tool-heavy turns.
 *
 * Approach: de-accumulate output tokens by dividing by the estimated number
 * of internal API calls (derived from cacheRead / previousContext), then
 * compute what percentage of the window that single-turn output represents.
 * Growth is bounded to 1-3% per turn.
 *
 * IMPORTANT: The caller must cap the result below the compact warning threshold
 * so that estimates never trigger compact warnings — only real measurements can.
 *
 * @param currentUsage - Current context usage percentage (0-100)
 * @param outputTokens - Output tokens from this turn (accumulated across internal calls)
 * @param cacheReadTokens - Cache read tokens (accumulated, used to estimate call count)
 * @param contextWindow - Effective context window size
 * @returns Estimated new context usage percentage
 */
export function estimateAccumulatedGrowth(
	currentUsage: number,
	outputTokens: number,
	cacheReadTokens: number,
	contextWindow: number
): number {
	if (currentUsage <= 0 || contextWindow <= 0) {
		return currentUsage;
	}

	// Estimate how many internal API calls occurred in this turn.
	// Use a minimum token floor to avoid inflated call-count estimates at low usage.
	const minTokens = Math.round(contextWindow * MIN_PREV_CONTEXT_FRACTION);
	const prevTokens = Math.max(minTokens, Math.round((currentUsage / 100) * contextWindow));
	const estCalls = Math.max(1, Math.round((cacheReadTokens || 0) / prevTokens));

	// De-accumulate: estimate single-call output growth
	const singleTurnGrowth = Math.round(outputTokens / estCalls);
	const growthPercent = Math.round((singleTurnGrowth / contextWindow) * 100);

	// Bound growth per turn (conservative to avoid overshooting)
	const boundedGrowth = Math.max(MIN_GROWTH_PERCENT, Math.min(growthPercent, MAX_GROWTH_PERCENT));

	return currentUsage + boundedGrowth;
}
