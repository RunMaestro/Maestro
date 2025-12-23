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
  'claude-code': 200000,  // Claude 3.5 Sonnet/Claude 4 default context
  'claude': 200000,       // Legacy Claude
  'codex': 200000,        // OpenAI o3/o4-mini context window
  'opencode': 128000,     // OpenCode (depends on model, 128k is conservative default)
  'aider': 128000,        // Aider (varies by model, 128k is conservative default)
  'terminal': 0,          // Terminal has no context window
};

/**
 * Estimate context usage percentage when the agent doesn't provide it directly.
 * Uses agent-specific default context window sizes for accurate estimation.
 *
 * @param stats - The usage statistics containing token counts
 * @param agentId - The agent identifier for agent-specific context window size
 * @returns Estimated context usage percentage (0-100), or null if cannot be estimated
 */
export function estimateContextUsage(
  stats: Pick<UsageStats, 'inputTokens' | 'outputTokens' | 'cacheReadInputTokens' | 'cacheCreationInputTokens' | 'contextWindow'>,
  agentId?: ToolType
): number | null {
  // If context window is provided and valid, use it
  if (stats.contextWindow && stats.contextWindow > 0) {
    const totalTokens = stats.inputTokens + stats.outputTokens;
    return Math.min(100, Math.round((totalTokens / stats.contextWindow) * 100));
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

  // Calculate context usage using total tokens (input + output)
  const totalTokens = stats.inputTokens + stats.outputTokens;
  if (totalTokens <= 0) {
    return 0;
  }

  return Math.min(100, Math.round((totalTokens / defaultContextWindow) * 100));
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
  let aggregatedInputTokens = 0;
  let aggregatedOutputTokens = 0;
  let aggregatedCacheReadTokens = 0;
  let aggregatedCacheCreationTokens = 0;
  let contextWindow = 200000; // Default for Claude

  if (modelUsage) {
    for (const modelStats of Object.values(modelUsage)) {
      aggregatedInputTokens += modelStats.inputTokens || 0;
      aggregatedOutputTokens += modelStats.outputTokens || 0;
      aggregatedCacheReadTokens += modelStats.cacheReadInputTokens || 0;
      aggregatedCacheCreationTokens += modelStats.cacheCreationInputTokens || 0;
      // Use the highest context window from any model
      if (modelStats.contextWindow && modelStats.contextWindow > contextWindow) {
        contextWindow = modelStats.contextWindow;
      }
    }
  }

  // Fall back to top-level usage if modelUsage isn't available
  // This handles older CLI versions or different output formats
  if (aggregatedInputTokens === 0 && aggregatedOutputTokens === 0) {
    aggregatedInputTokens = usage.input_tokens || 0;
    aggregatedOutputTokens = usage.output_tokens || 0;
    aggregatedCacheReadTokens = usage.cache_read_input_tokens || 0;
    aggregatedCacheCreationTokens = usage.cache_creation_input_tokens || 0;
  }

  return {
    inputTokens: aggregatedInputTokens,
    outputTokens: aggregatedOutputTokens,
    cacheReadInputTokens: aggregatedCacheReadTokens,
    cacheCreationInputTokens: aggregatedCacheCreationTokens,
    totalCostUsd,
    contextWindow,
  };
}
