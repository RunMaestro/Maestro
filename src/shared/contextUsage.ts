/**
 * Context Usage Estimation Utilities
 *
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║                    CONTEXT CALCULATION SYNCHRONIZATION                        ║
 * ╠══════════════════════════════════════════════════════════════════════════════╣
 * ║ This is the SINGLE SOURCE OF TRUTH for context window calculations.          ║
 * ║                                                                               ║
 * ║ ALL context calculations in the codebase MUST use these functions:            ║
 * ║   - calculateContextTokens()  - Calculate total context tokens                ║
 * ║   - estimateContextUsage()    - Estimate context usage percentage             ║
 * ║                                                                               ║
 * ║ LOCATIONS THAT USE THESE (keep in sync when modifying):                       ║
 * ║   1. src/renderer/App.tsx (line ~2768) - UI context % display                 ║
 * ║   2. src/renderer/utils/contextUsage.ts - Re-exports for renderer             ║
 * ║   3. src/renderer/utils/contextExtractor.ts - Token estimation                ║
 * ║   4. src/renderer/components/MainPanel.tsx - Tab context display              ║
 * ║   5. src/renderer/components/TabSwitcherModal.tsx - Tab switcher              ║
 * ║   6. src/renderer/components/HistoryDetailModal.tsx - History view            ║
 * ║   7. src/renderer/services/contextSummarizer.ts - Compaction eligibility      ║
 * ║   8. src/main/parsers/usage-aggregator.ts - Re-exports for main process       ║
 * ║   9. src/main/process-listeners/usage-listener.ts - Usage event handling      ║
 * ║  10. src/web/mobile/App.tsx - Mobile UI                                       ║
 * ║  11. src/web/mobile/SessionStatusBanner.tsx - Mobile status                   ║
 * ║                                                                               ║
 * ║ PROVIDER-SPECIFIC FORMULAS:                                                   ║
 * ║                                                                               ║
 * ║   Claude-style (separate input/output limits):                                ║
 * ║     total = inputTokens + cacheReadInputTokens + cacheCreationInputTokens     ║
 * ║     Agents: claude-code, factory-droid, opencode                              ║
 * ║     (OpenCode and Factory Droid can use various models, but they report       ║
 * ║      cache tokens in Claude-style format regardless of backend)               ║
 * ║                                                                               ║
 * ║   OpenAI-style (combined input+output limit):                                 ║
 * ║     total = inputTokens + outputTokens                                        ║
 * ║     Agents: codex                                                             ║
 * ║     (COMBINED_CONTEXT_AGENTS set determines which agents use this)            ║
 * ║                                                                               ║
 * ║ KNOWN ISSUES (as of 2026-01-31):                                              ║
 * ║   - Claude Code usage can be cumulative; normalized to per-turn in StdoutHandler ║
 * ║   - Values fluctuate based on which model (Haiku vs Sonnet) handles turn      ║
 * ║   - This causes UI to show inconsistent context % across turns                ║
 * ║   - Compaction check may fail when UI shows high but stored value is low      ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 *
 * @see https://platform.claude.com/docs/en/build-with-claude/prompt-caching
 * @see https://code.claude.com/docs/en/statusline#context-window-usage
 */

import type { ToolType } from './types';

/**
 * Default context window sizes for different agents.
 * Used as fallback when the agent doesn't report its context window size.
 *
 * SYNC: When adding a new agent, also update:
 *   - COMBINED_CONTEXT_AGENTS if it uses combined input+output limits
 *   - calculateContextTokens() if it has a unique formula
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
 *
 * SYNC: When adding a new agent with combined context limits, add it here
 * and update calculateContextTokens() to handle it.
 */
export const COMBINED_CONTEXT_AGENTS: Set<ToolType | string> = new Set(['codex']);

/**
 * Minimal usage stats interface for context calculation.
 * All fields are optional to support different sources (web, renderer, main).
 */
export interface ContextUsageStats {
	inputTokens?: number;
	outputTokens?: number;
	cacheReadInputTokens?: number;
	cacheCreationInputTokens?: number;
	contextWindow?: number;
}

/**
 * Calculate total context tokens based on agent-specific semantics.
 *
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║ THIS IS THE CANONICAL CONTEXT CALCULATION FUNCTION                            ║
 * ║ All UI displays, compaction checks, and usage tracking MUST use this.         ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 *
 * Per Anthropic documentation, the context calculation formula is:
 *   total_context = input_tokens + cache_read_input_tokens + cache_creation_input_tokens
 *
 * Where:
 * - input_tokens: New uncached tokens AFTER the last cache breakpoint
 * - cache_read_input_tokens: Tokens retrieved from cache (entire cached prefix)
 * - cache_creation_input_tokens: Tokens being written to cache for the first time
 *
 * For OpenAI models (Codex), context = input + output (combined limit)
 *
 * @param stats - The usage statistics containing token counts
 * @param agentId - The agent identifier for agent-specific calculation
 * @returns Total context tokens used for this turn
 *
 * @see https://platform.claude.com/docs/en/build-with-claude/prompt-caching
 */
export function calculateContextTokens(
	stats: ContextUsageStats,
	agentId?: ToolType | string
): number {
	// Per Anthropic docs: total_context = input + cacheRead + cacheCreation
	// All three components occupy context window space.
	const baseTokens =
		(stats.inputTokens || 0) +
		(stats.cacheReadInputTokens || 0) +
		(stats.cacheCreationInputTokens || 0);

	// OpenAI models have combined input+output context limits
	if (agentId && COMBINED_CONTEXT_AGENTS.has(agentId)) {
		return baseTokens + (stats.outputTokens || 0);
	}

	// Claude models: output tokens don't consume context window
	return baseTokens;
}

/**
 * Estimate context usage percentage when the agent doesn't provide it directly.
 * Uses agent-specific default context window sizes for accurate estimation.
 *
 * Context calculation varies by agent:
 * - Claude models: inputTokens + cacheReadInputTokens + cacheCreationInputTokens
 *   (per Anthropic docs, all three occupy context window space)
 * - OpenAI models (Codex): inputTokens + outputTokens
 *   (combined context window includes both input and output)
 *
 * @param stats - The usage statistics containing token counts
 * @param agentId - The agent identifier for agent-specific context window size
 * @returns Estimated context usage percentage (0-100), or null if cannot be estimated
 */
export function estimateContextUsage(
	stats: ContextUsageStats,
	agentId?: ToolType | string
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
	const defaultContextWindow = DEFAULT_CONTEXT_WINDOWS[agentId as ToolType];
	if (!defaultContextWindow || defaultContextWindow <= 0) {
		return null;
	}

	if (totalContextTokens <= 0) {
		return 0;
	}

	return Math.min(100, Math.round((totalContextTokens / defaultContextWindow) * 100));
}
