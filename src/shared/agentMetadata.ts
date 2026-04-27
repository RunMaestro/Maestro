/**
 * Agent Metadata — Shared display names and classification sets.
 *
 * This module provides UI-facing metadata that is safe to import from both
 * the main process and the renderer (via shared/).  All agent display names
 * live here so that adding a new agent requires exactly one update.
 */

import type { AgentId } from './agentIds';

/**
 * Human-readable display names for every agent.
 * Keyed by AgentId so TypeScript enforces completeness when a new ID is added.
 *
 * @internal Use getAgentDisplayName() instead of importing directly.
 */
export const AGENT_DISPLAY_NAMES: Record<AgentId, string> = {
	terminal: 'Terminal',
	'claude-code': 'Claude Code',
	codex: 'Codex',
	'gemini-cli': 'Gemini CLI',
	'qwen3-coder': 'Qwen3 Coder',
	opencode: 'OpenCode',
	'factory-droid': 'Factory Droid',
	'copilot-cli': 'Copilot-CLI',
};

/**
 * Get the human-readable display name for an agent.
 * Returns the raw id string as fallback for unknown agents.
 */
export function getAgentDisplayName(agentId: AgentId | string): string {
	if (Object.prototype.hasOwnProperty.call(AGENT_DISPLAY_NAMES, agentId)) {
		return AGENT_DISPLAY_NAMES[agentId as AgentId];
	}
	return agentId;
}

/**
 * Agents that use "plan mode" rather than true read-only mode.
 * Claude Code uses --permission-mode plan, OpenCode uses --agent plan.
 * These agents can still read files but the CLI calls it "plan mode".
 * Other agents (Codex, Factory Droid) have true read-only enforcement.
 */
const PLAN_MODE_AGENTS: ReadonlySet<AgentId> = new Set<AgentId>(['claude-code', 'opencode']);

/**
 * Get the UI label for the read-only mode pill based on the agent.
 * Returns "Plan Mode" for agents that use plan mode (Claude Code, OpenCode),
 * "Read-Only" for agents with true read-only enforcement.
 */
export function getReadOnlyModeLabel(agentId: AgentId | string): string {
	return PLAN_MODE_AGENTS.has(agentId as AgentId) ? 'Plan-Mode' : 'Read-Only';
}

/**
 * Get the tooltip text for the read-only mode toggle based on the agent.
 */
export function getReadOnlyModeTooltip(agentId: AgentId | string): string {
	return PLAN_MODE_AGENTS.has(agentId as AgentId)
		? 'Toggle plan mode (agent will plan but not modify files)'
		: "Toggle Read-Only mode (agent won't modify files)";
}

/**
 * Agents currently in beta/experimental status.
 * Used to render "(Beta)" badges throughout the UI.
 *
 * @internal Use isBetaAgent() instead of importing directly.
 */
export const BETA_AGENTS: ReadonlySet<AgentId> = new Set<AgentId>([
	'opencode',
	'factory-droid',
	'copilot-cli',
]);

/**
 * Check whether an agent is in beta status.
 */
export function isBetaAgent(agentId: AgentId | string): boolean {
	return BETA_AGENTS.has(agentId as AgentId);
}
