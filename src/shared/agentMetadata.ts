/**
 * Agent Metadata - Shared display names and classification sets.
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

/**
 * How a provider's CLI is re-authenticated.
 *
 * `binary` + `args` form the shell command Maestro runs in the reauthentication
 * terminal. Some providers have no login subcommand and only expose the flow as
 * a slash command inside their TUI - those set `followUp`, which the UI shows as
 * "then type /auth" instead of pretending a one-liner exists.
 */
export interface AgentLoginCommand {
	/** Binary to run. Replaced by the agent's custom path when one is configured. */
	binary: string;
	/** Arguments appended after the binary. Empty when the bare binary is the flow. */
	args: string;
	/** Slash command the user must type once the TUI is up, when `args` can't do it. */
	followUp?: string;
}

/**
 * Re-authentication command per agent. `null` means the agent has no login flow
 * of its own (the Terminal agent is a plain shell).
 *
 * Keyed by AgentId so adding a new agent forces a decision here.
 */
const AGENT_LOGIN_COMMANDS: Record<AgentId, AgentLoginCommand | null> = {
	terminal: null,
	'claude-code': { binary: 'claude', args: '/login' },
	codex: { binary: 'codex', args: 'login' },
	'gemini-cli': { binary: 'gemini', args: '', followUp: '/auth' },
	'qwen3-coder': { binary: 'qwen3-coder', args: '', followUp: '/auth' },
	opencode: { binary: 'opencode', args: 'auth login' },
	'factory-droid': { binary: 'droid', args: '', followUp: '/login' },
	'copilot-cli': { binary: 'copilot', args: 'login' },
};

/**
 * Get the re-authentication command for an agent, or null when the agent has
 * none (unknown ids included - we never guess a command to run in a shell).
 *
 * @param agentId - The agent to authenticate.
 * @param customPath - The agent's configured binary path, when the user set one.
 *   Substituted for the default binary name so a non-PATH install still works.
 */
export function getAgentLoginCommand(
	agentId: AgentId | string,
	customPath?: string
): AgentLoginCommand | null {
	if (!Object.prototype.hasOwnProperty.call(AGENT_LOGIN_COMMANDS, agentId)) return null;
	const entry = AGENT_LOGIN_COMMANDS[agentId as AgentId];
	if (!entry) return null;
	const binary = customPath?.trim() || entry.binary;
	return binary === entry.binary ? entry : { ...entry, binary };
}

/**
 * Render an {@link AgentLoginCommand} as the single line typed into a shell.
 * Quotes a custom binary path so a directory with spaces still runs.
 */
export function formatAgentLoginCommand(login: AgentLoginCommand): string {
	const binary = /[\s"']/.test(login.binary) ? `"${login.binary}"` : login.binary;
	return login.args ? `${binary} ${login.args}` : binary;
}
