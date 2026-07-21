/**
 * Shared Agent Constants
 *
 * Constants that are used across both main and renderer processes.
 * Centralizes agent-specific metadata to avoid duplication.
 */

import type { AgentId } from './agentIds';
import type { AgentCapabilitiesSnapshot } from './agentCapabilities';

/**
 * Default context window sizes for different agents.
 * Used as fallback when the agent doesn't report its context window size.
 * Not all agents have a known default - agents without an entry here
 * should configure contextWindow via their configOptions in definitions.ts.
 */
export const DEFAULT_CONTEXT_WINDOWS: Partial<Record<AgentId, number>> = {
	'claude-code': 200000, // Claude 3.5 Sonnet/Claude 4 default context
	codex: 200000, // OpenAI o3/o4-mini context window
	opencode: 128000, // OpenCode (depends on model, 128k is conservative default)
	'factory-droid': 200000, // Factory Droid (varies by model, defaults to Claude Opus)
	hermes: 200000, // Conservative fallback until runtime-specific reporting lands
	pi: 200000, // Conservative fallback until runtime-specific reporting lands
	'copilot-cli': 200000, // Copilot-CLI (varies by model, defaults to Claude Sonnet)
	'qwen3-coder': 262144, // Qwen3-Coder native 256K context window
	omp: 200000, // Oh My Pi (fallback until runtime-specific reporting lands)
	grok: 500000, // Grok CLI (grok-4.5 default, per ~/.grok/models_cache.json)
	terminal: 0, // Terminal has no context window
};

/**
 * Fallback context window size when an agent has no entry in DEFAULT_CONTEXT_WINDOWS
 * and hasn't reported its own value.  Matches Claude's default (200k tokens).
 */
export const FALLBACK_CONTEXT_WINDOW = 200000;

/**
 * Context-window threshold (tokens) at/above which Auto Run defaults to
 * fresh-context-per-document instead of fresh-context-per-task. Windows this
 * large (Claude 1M, etc.) can comfortably hold a whole document's worth of
 * tasks in one shared context, so the agent walks the document in a single
 * invocation; smaller windows reset per task to avoid context exhaustion.
 */
export const PER_DOCUMENT_CONTEXT_THRESHOLD = 1_000_000;

/**
 * Tokens for Anthropic's 1M extended-context beta, selected via the `[1m]`
 * model suffix (e.g. `opus[1m]`, `claude-opus-4-7[1m]`).
 */
export const EXTENDED_1M_CONTEXT_WINDOW = 1_000_000;

/**
 * Detect the context window implied by a model identifier. Anthropic exposes a
 * 1M extended-context beta through a `[1m]` suffix; the agent only reports that
 * larger window via usage stats after its first turn, so detecting it from the
 * selected model lets callers size the window correctly before any usage lands.
 * Returns the implied window in tokens, or null when the model carries no marker.
 */
export function getModelContextWindowOverride(model: string | null | undefined): number | null {
	return model && /\[1m\]/i.test(model) ? EXTENDED_1M_CONTEXT_WINDOW : null;
}

/**
 * Whether Adaptive Mode (a.k.a. maestro-p / automatic Claude token-source
 * management, persisted as `enableMaestroP`) is enabled by default for newly
 * created agents of the given type. This is the single source of truth for the
 * "default on for new agents" rule; the one-shot migration in
 * `src/main/stores/migrations/` keeps existing agents aligned with it.
 *
 * Currently OFF for every agent: new Claude Code agents default to the API
 * token source (`claude --print`). TUI/Dynamic remain available but are now
 * opt-in per agent - the maestro-p TUI path has been a recurring source of
 * trouble, so we no longer flip anyone onto it automatically. Kept as a
 * function so re-enabling a default later is a one-line change.
 */
export function isAdaptiveModeDefaultOn(_agentId: string): boolean {
	return false;
}

/**
 * Agent Resilience (auto-retry on availability / token-exhaustion errors) is ON
 * by default for every agent. The persisted flags (`retryOnAvailabilityErrors`,
 * `retryOnTokenExhaustion`) are optional, so `undefined` - the state for every
 * pre-existing agent and any newly created one that didn't touch the toggle -
 * reads as enabled. Only an explicit `false` opts out. This read-time default
 * means no storage migration is needed.
 */
export function resilienceEnabled(configured: boolean | undefined): boolean {
	return configured !== false;
}

/**
 * Agents that use combined input+output context windows.
 * OpenAI models (Codex, o3, o4-mini) have a single context window that includes
 * both input and output tokens, unlike Claude which has separate limits.
 *
 * Copilot CLI also lives here: even when its underlying model is Claude Sonnet,
 * Copilot's own usage reporting (`session.shutdown.modelMetrics.<model>.usage`)
 * normalizes `inputTokens` as a CUMULATIVE figure that already includes cached
 * input, with `cacheReadTokens` reported as a subset for display only. Treating
 * Copilot as Claude-style would double-count the cached portion every time the
 * gauge is computed. We surface `currentTokens` (the live context-window state
 * Copilot reports) as `inputTokens`; the combined formula then yields a
 * reasonable approximation without re-adding the cache subset.
 *
 * NOTE: This is kept as a static set for cross-process use (shared/).
 * The canonical flag is `usesCombinedContextWindow` in AgentCapabilities.
 */
export const COMBINED_CONTEXT_AGENTS: ReadonlySet<AgentId> = new Set<AgentId>([
	'codex',
	'copilot-cli',
]);

/**
 * Resolve the context window size for an agent, preferring a runtime
 * capability snapshot when available and falling back to the static
 * `DEFAULT_CONTEXT_WINDOWS` table (and finally `FALLBACK_CONTEXT_WINDOW`).
 *
 * Use this anywhere the previous hard-coded `DEFAULT_CONTEXT_WINDOWS[agentId]`
 * pattern appears so context-window changes shipped by an agent vendor flow
 * into Maestro automatically once a snapshot has captured them.
 *
 * Caller migration of existing readers is deferred to a follow-up PR - this
 * helper coexists with the old constant readers and is safe to land first.
 */
export function getContextWindowForAgent(
	agentId: AgentId | string,
	snapshot?: AgentCapabilitiesSnapshot
): number {
	if (typeof snapshot?.contextWindow === 'number' && snapshot.contextWindow > 0) {
		return snapshot.contextWindow;
	}
	const fromTable = DEFAULT_CONTEXT_WINDOWS[agentId as AgentId];
	if (typeof fromTable === 'number') {
		return fromTable;
	}
	return FALLBACK_CONTEXT_WINDOW;
}
