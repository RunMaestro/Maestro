/**
 * Shared Agent Constants
 *
 * Constants that are used across both main and renderer processes.
 * Centralizes agent-specific metadata to avoid duplication.
 */

import type { AgentId } from './agentIds';

/**
 * Default context window sizes for different agents.
 * Used as fallback when the agent doesn't report its context window size.
 * Not all agents have a known default — agents without an entry here
 * should configure contextWindow via their configOptions in definitions.ts.
 */
export const DEFAULT_CONTEXT_WINDOWS: Partial<Record<AgentId, number>> = {
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
export const COMBINED_CONTEXT_AGENTS: ReadonlySet<AgentId> = new Set<AgentId>(['codex']);
