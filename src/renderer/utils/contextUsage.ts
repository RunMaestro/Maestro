/**
 * Context Usage Estimation Utilities
 *
 * Provides fallback estimation for context window usage when agents
 * don't report their context window size directly.
 */

import type { ToolType } from '../types';
import { COMBINED_CONTEXT_AGENTS, getContextWindowForAgent } from '../../shared/agentConstants';
import { useAgentStore } from '../stores/agentStore';

// Re-export for consumers that import from this module. The local import
// was dropped on migration to `getContextWindowForAgent` - the re-export
// resolves directly from the source module without needing a binding.
export { DEFAULT_CONTEXT_WINDOWS } from '../../shared/agentConstants';

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
 * Calculate total input tokens for display on a single history entry or tab header.
 *
 * Agents partition their input-token accounting differently:
 *
 * - **Claude models** report `inputTokens` as the UNCACHED input delta only.
 *   `cacheReadInputTokens` and `cacheCreationInputTokens` are tracked separately
 *   and must be ADDED back to reflect the full size of the input that the model
 *   actually processed. On a resumed session almost all input lands in
 *   `cacheReadInputTokens`, leaving `inputTokens` at single-digit values that
 *   look absurd to users (see issue #844).
 *
 * - **OpenAI/Codex models** report `inputTokens` inclusive of cached input.
 *   `cacheReadInputTokens` is reported separately for display only and must
 *   NOT be double-counted (see codex-output-parser.ts).
 *
 * Use this for per-entry / per-tab "input tokens" displays. For the context
 * window percentage gauge, use `calculateContextTokens` / `calculateContextDisplay`
 * - those also add `outputTokens` for OpenAI-style combined-limit models.
 *
 * @param stats - The usage statistics containing token counts
 * @param agentId - The agent identifier; defaults to the Claude formula
 * @returns Total input tokens to show the user
 */
export function calculateDisplayInputTokens(
	stats: {
		inputTokens?: number;
		cacheReadInputTokens?: number;
		cacheCreationInputTokens?: number;
	},
	agentId?: ToolType | string
): number {
	// OpenAI/Codex: inputTokens already includes cached input, do not add cache fields.
	if (agentId && COMBINED_CONTEXT_AGENTS.has(agentId as ToolType)) {
		return stats.inputTokens || 0;
	}

	// Claude (and unknown agents, as a safe default): inputTokens is uncached only,
	// add the cache partitions to reflect the real input size.
	return (
		(stats.inputTokens || 0) +
		(stats.cacheReadInputTokens || 0) +
		(stats.cacheCreationInputTokens || 0)
	);
}

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
	agentId?: ToolType | string,
	/**
	 * SSH remote UUID when the session is running against a remote host.
	 * Lets the snapshot lookup pick the per-remote `agentId:remoteId`
	 * key - otherwise SSH sessions fall back to the local snapshot and
	 * then the static table, which can be wrong when remote models differ.
	 */
	sshRemoteId?: string
): number | null {
	// Calculate total context using agent-specific semantics
	const totalContextTokens = calculateContextTokens(stats, agentId);

	// Determine effective context window: runtime-reported stats win, then
	// the agent's persisted capability snapshot for this environment
	// (local OR specific remote), then the static table.
	const effectiveContextWindow =
		stats.contextWindow && stats.contextWindow > 0
			? stats.contextWindow
			: agentId && agentId !== 'terminal'
				? getContextWindowForAgent(
						agentId,
						useAgentStore.getState().getCapabilitySnapshot(agentId, sshRemoteId)
					)
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
 * Result of a context display calculation.
 * Contains everything needed to render a context gauge in any UI component.
 */
export interface ContextDisplayResult {
	/** Context tokens to display (capped to window when accumulated) */
	tokens: number;
	/** Context usage percentage (0-100) */
	percentage: number;
	/** Effective context window size used for the calculation */
	contextWindow: number;
	/**
	 * True when the result is computed from real usage data; false when the
	 * function had to fall back (overflow with no trustworthy fallback %, or
	 * missing window size). Callers should hold their previous good values
	 * when this is false instead of displaying the fallback as if it were a
	 * real measurement (see issue #762).
	 */
	trustworthy: boolean;
}

/**
 * Calculate context tokens and percentage for display, handling accumulated-token overflow.
 *
 * This is the single source of truth for context gauge rendering. When raw token counts
 * exceed the context window (accumulated multi-tool turns), falls back to the preserved
 * contextUsage percentage to derive a sane token count.
 *
 * @param usageStats - Token counts from the agent
 * @param contextWindow - Effective context window size (0 = unknown)
 * @param agentId - Agent type for agent-specific calculation
 * @param fallbackPercentage - Preserved contextUsage % to use when tokens overflow
 * @returns Display-ready tokens, percentage, and window size, plus a `trustworthy` flag
 */
export function calculateContextDisplay(
	usageStats: {
		inputTokens?: number;
		outputTokens?: number;
		cacheReadInputTokens?: number;
		cacheCreationInputTokens?: number;
	},
	contextWindow: number,
	agentId?: ToolType | string,
	fallbackPercentage?: number | null
): ContextDisplayResult {
	if (!contextWindow || contextWindow <= 0) {
		return { tokens: 0, percentage: 0, contextWindow: 0, trustworthy: false };
	}

	const raw = calculateContextTokens(usageStats, agentId);

	let tokens = raw;
	const trustworthy = true;
	if (raw > contextWindow) {
		if (
			fallbackPercentage != null &&
			Number.isFinite(fallbackPercentage) &&
			fallbackPercentage > 0
		) {
			// Accumulated multi-tool turn: derive tokens from preserved percentage.
			//
			// The guard is `> 0`, not `>= 0`: a zero fallback is the ABSENCE of a
			// prior measurement, not a measurement of zero. Accepting it computed
			// `tokens = round(0/100 * window) = 0` and returned `trustworthy: true`,
			// which latched the gauge (and the Context Details popover) at 0% for the
			// whole life of any session whose first turn already overflowed the
			// window (finding Q1).
			//
			// Accepted edge case: a session whose stored contextUsage legitimately
			// rounded to 0 (real usage under 0.5%) now produces an untrustworthy
			// overflow frame, so callers hold their previous values - which are also
			// zero - and the rendered result is identical. Nothing is lost.
			const boundedFallback = Math.min(100, fallbackPercentage);
			tokens = Math.round((boundedFallback / 100) * contextWindow);
		} else {
			// No trustworthy fallback. Return zeros and flag the result as untrustworthy
			// so the caller can hold its previous values (issue #762: previously this
			// branch displayed `contextWindow` itself, surfacing the capacity as if it
			// were the used-token count).
			return { tokens: 0, percentage: 0, contextWindow, trustworthy: false };
		}
	}

	// NOT clamped to 100 (finding R1, Decision 2). A `Math.min(100, ...)` here
	// laundered a genuine over-limit measurement into a flat, indistinguishable
	// `100%` on the header pill and the Context Window popover, which is the same
	// symptom the Context Timeline had. The header now reports whatever it
	// actually measured, matching `computeOverLimitDisplay`'s `truePercentage`
	// for the same tokens/window pair.
	//
	// The two paths above keep their own bounds and are deliberately unchanged:
	// the untrustworthy-zeros branch (#762) still returns zeros, and the
	// accumulated-turn fallback is still bounded by `Math.min(100, ...)` at the
	// FALLBACK, because a stored `contextUsage` is 0-100 by construction and a
	// percentage recovered from it is not an over-limit measurement. So today
	// this expression only exceeds 100 if a caller supplies a numerator above
	// its own window directly; it is the laundering that is removed, not a new
	// number that is invented.
	const percentage = tokens <= 0 ? 0 : Math.round((tokens / contextWindow) * 100);

	return { tokens, percentage, contextWindow, trustworthy };
}

/**
 * Result of an over-limit display calculation.
 *
 * The finding-R1 invariant: the label, the bar width and the color of a context
 * row must ALL derive from this one return value, so they cannot disagree.
 */
export interface OverLimitDisplayResult {
	/**
	 * The UNCLAMPED usage percentage of this measurement against its OWN window.
	 * An over-limit point reads e.g. `147`. 0 when the window is unknown.
	 */
	truePercentage: number;
	/**
	 * How much of the rendered track this point fills, 0-1. Measured against
	 * `scaleMax` (the shared per-panel headroom scale) when one is supplied,
	 * otherwise against the point's own window.
	 */
	fillFraction: number;
	/** True when this measurement exceeds its own context window. */
	overLimit: boolean;
}

/**
 * Compute the display math for one context measurement, including the
 * over-limit case (finding R1).
 *
 * Before this helper, an over-limit point was rendered as a full-width bar
 * labelled `100%` or `~`, so the panel stopped conveying information exactly
 * when the context story got interesting. `truePercentage` is deliberately
 * NOT clamped: showing `147%` is the numeric floor of the fix.
 *
 * The per-panel headroom scale (Decision 3) is expressed through `scaleMax`:
 * callers pass `max(window, observedPeakTokens)` across the rendered points so
 * over-limit bars extend proportionally past the 100% tick, which sits at
 * `window / scaleMax`. Only the SCALE maximum is shared - `truePercentage` uses
 * each point's own `contextWindow`, so a mid-session window change cannot
 * retroactively distort older rows.
 *
 * @param contextTokens - Tokens measured for this point
 * @param contextWindow - The window this point was measured against (0 = unknown)
 * @param scaleMax - Optional shared track maximum; defaults to `contextWindow`
 * @returns True percentage, fill fraction (0-1) and the over-limit flag
 */
export function computeOverLimitDisplay(
	contextTokens: number,
	contextWindow: number,
	scaleMax?: number
): OverLimitDisplayResult {
	if (!contextWindow || contextWindow <= 0 || !Number.isFinite(contextWindow)) {
		return { truePercentage: 0, fillFraction: 0, overLimit: false };
	}

	const tokens = Number.isFinite(contextTokens) && contextTokens > 0 ? contextTokens : 0;
	const truePercentage = Math.round((tokens / contextWindow) * 100);
	const overLimit = tokens > contextWindow;

	// A scaleMax below the window would push in-window points past the track,
	// so an unusable value falls back to the window itself.
	const effectiveScale =
		scaleMax != null && Number.isFinite(scaleMax) && scaleMax > 0 ? scaleMax : contextWindow;
	const fillFraction = Math.min(1, Math.max(0, tokens / effectiveScale));

	return { truePercentage, fillFraction, overLimit };
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
 * so that estimates never trigger compact warnings - only real measurements can.
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
