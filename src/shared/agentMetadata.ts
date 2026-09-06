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
	antigravity: 'Antigravity CLI',
	'qwen3-coder': 'Qwen3 Coder',
	opencode: 'OpenCode',
	'factory-droid': 'Factory Droid',
	hermes: 'Hermes',
	pi: 'Pi',
	'copilot-cli': 'Copilot-CLI',
	omp: 'Oh My Pi',
	grok: 'Grok CLI',
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
 * Get the UI label for a permission mode pill.
 * For readonly mode, delegates to getReadOnlyModeLabel() when an agentId is
 * given so agents that use plan-mode terminology (e.g. Claude Code's
 * "Plan-Mode") keep it instead of the generic "Read Only" label.
 */
export function getPermissionModeLabel(
	mode: 'full' | 'standard' | 'readonly',
	agentId?: AgentId | string
): string {
	switch (mode) {
		case 'full':
			return 'Full Access';
		case 'standard':
			return 'Standard';
		case 'readonly':
			return agentId ? getReadOnlyModeLabel(agentId) : 'Read Only';
	}
}

/**
 * Get the tooltip text for a permission mode button.
 * For readonly mode, delegates to getReadOnlyModeTooltip() when an agentId is
 * given so agents that use plan-mode terminology (e.g. Claude Code) keep their
 * plan-mode-specific tooltip.
 */
export function getPermissionModeTooltip(
	mode: 'full' | 'standard' | 'readonly',
	agentId?: AgentId | string
): string {
	switch (mode) {
		case 'full':
			return 'Full Access: All permission prompts bypassed. Agent can read, write, and execute without confirmation. Ask-back questions (AskUserQuestion) are not surfaced in this mode.';
		case 'standard':
			return 'Standard: Agent uses default permission model. Tool approvals and ask-back questions (AskUserQuestion) appear as in-app prompts. File edits and commands may be silently denied if not pre-approved.';
		case 'readonly':
			return agentId
				? getReadOnlyModeTooltip(agentId)
				: 'Read Only: Agent runs in plan/exploration mode only. No file writes or command execution.';
	}
}

/**
 * Resolve a tab's effective permission mode from its stored fields.
 *
 * A tab whose `permissionMode` was never explicitly set is treated as full
 * access (falling back to `readonly` only when the legacy `readOnlyMode` boolean
 * is set). This is the SINGLE source of truth for "what does an unset
 * permissionMode mean" - both the toolbar pill (display) and the spawn path
 * (which flags get passed) must call this so they can never drift apart. When
 * they did drift, an unset tab rendered "Full Access" yet spawned in standard
 * mode, so the agent's tool calls were silently denied.
 */
export function resolveTabPermissionMode(
	tab?: { permissionMode?: 'full' | 'standard' | 'readonly'; readOnlyMode?: boolean } | null
): 'full' | 'standard' | 'readonly' {
	return tab?.permissionMode ?? (tab?.readOnlyMode ? 'readonly' : 'full');
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
	'hermes',
	'pi',
	'copilot-cli',
	'qwen3-coder',
	'omp',
	'grok',
	'antigravity',
]);

/**
 * Check whether an agent is in beta status.
 */
export function isBetaAgent(agentId: AgentId | string): boolean {
	return BETA_AGENTS.has(agentId as AgentId);
}

/**
 * Presentation metadata for the provider pickers.
 */
export interface AgentPickerMeta {
	/** One-line pitch rendered under the provider name. */
	description: string;
	/** Provider brand color, used for the tile logo and the selection ring. */
	brandColor: string;
}

/**
 * Which providers a user may pick, in the order every picker renders them.
 *
 * This is the SINGLE source of truth behind all three provider pickers: the New
 * Agent modal's list, the New Agent Wizard's tile strip, and the Group Chat
 * moderator dropdown. They used to keep their own hand-written arrays, which is
 * how Grok and Qwen3 Coder shipped selectable in the New Agent modal yet absent
 * from the wizard and un-pickable as a moderator for months.
 *
 * `null` means the agent is never offered to the user: `terminal` is internal
 * plumbing, and `gemini-cli` is retained only for type and back-compat reasons
 * (superseded by Antigravity).
 *
 * The record is keyed by AgentId, so adding an id to AGENT_IDS does not compile
 * until a decision is made here. Key order is NOT picker order - PICKABLE_AGENT_IDS
 * sorts by display name, so a new entry can go anywhere in this record and still
 * land in the right place in every picker.
 */
export const AGENT_PICKER_META: Record<AgentId, AgentPickerMeta | null> = {
	antigravity: { description: "Google's agentic coding CLI", brandColor: '#4285F4' },
	'claude-code': { description: "Anthropic's AI coding assistant", brandColor: '#D97757' },
	codex: { description: "OpenAI's AI coding assistant", brandColor: '#10A37F' },
	'copilot-cli': { description: "GitHub's AI coding assistant", brandColor: '#24292F' },
	'factory-droid': { description: "Factory's AI coding assistant", brandColor: '#3B82F6' },
	grok: { description: "xAI's AI coding assistant", brandColor: '#B4B8C0' },
	hermes: { description: "Nous Research's AI coding assistant", brandColor: '#2323FF' },
	omp: { description: 'Multi-model coding agent', brandColor: '#9B4DFF' },
	opencode: { description: 'Open-source AI coding assistant', brandColor: '#F97316' },
	pi: { description: 'Your own agent harness', brandColor: '#E4E4E7' },
	'qwen3-coder': { description: "Alibaba's AI coding assistant", brandColor: '#615CED' },
	terminal: null,
	'gemini-cli': null,
};

/**
 * Every agent a user may pick as a provider, in picker order: alphabetical by
 * display name, so the user scans one predictable list everywhere. Derived from
 * AGENT_PICKER_META so the two can never disagree.
 *
 * Sorting is done here rather than trusted to the record's key order, which is
 * easy to get wrong when a provider is added and impossible to notice in review.
 */
export const PICKABLE_AGENT_IDS: readonly AgentId[] = (Object.keys(AGENT_PICKER_META) as AgentId[])
	.filter((id) => AGENT_PICKER_META[id] !== null)
	.sort((a, b) => getAgentDisplayName(a).localeCompare(getAgentDisplayName(b)));

/**
 * Which provider a picker should land on when it has to choose for the user.
 *
 * Display order is alphabetical, but "first in the list" is a bad default: it
 * would hand a fresh Group Chat to whichever beta provider happens to sort
 * first. This is the preference order instead - the first entry the user
 * actually has installed wins, and anything absent here falls back to the
 * alphabetical order.
 */
export const AGENT_AUTOSELECT_ORDER: readonly AgentId[] = [
	'claude-code',
	'codex',
	'antigravity',
	'opencode',
	'factory-droid',
	'copilot-cli',
];

/**
 * Picker metadata for an agent, or null when it is never offered (unknown ids
 * included, so a stale persisted toolType can't crash a picker).
 */
export function getAgentPickerMeta(agentId: AgentId | string): AgentPickerMeta | null {
	if (!Object.prototype.hasOwnProperty.call(AGENT_PICKER_META, agentId)) return null;
	return AGENT_PICKER_META[agentId as AgentId];
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
	// Antigravity has no login subcommand: headless runs reuse the credentials
	// cached by one interactive sign-in, so the bare TUI is the whole flow.
	antigravity: { binary: 'agy', args: '' },
	grok: { binary: 'grok', args: 'login' },
	hermes: null,
	pi: null,
	omp: null,
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
 * Command-line dialect of the shell the login is typed into.
 *
 * Only quoting differs, but the difference is not cosmetic: PowerShell parses a
 * line that STARTS with a quoted string as an expression and simply echoes it,
 * so a quoted path runs nothing at all.
 */
export type LoginShellSyntax = 'posix' | 'powershell' | 'cmd';

/**
 * Render an {@link AgentLoginCommand} as the single line typed into a shell.
 *
 * Quotes a binary path containing spaces - the common case on Windows, where
 * agents install under `C:\Program Files\...` - and, for PowerShell, prefixes
 * the call operator `&`. Without it PowerShell treats `"C:\...\claude.exe"` as
 * a string literal, prints it, and the user watches a login that never starts.
 *
 * @param syntax - Dialect of the target shell. Defaults to `posix`, which is
 *   correct for macOS, Linux, Git Bash, and WSL.
 */
export function formatAgentLoginCommand(
	login: AgentLoginCommand,
	syntax: LoginShellSyntax = 'posix'
): string {
	const needsQuoting = /[\s"']/.test(login.binary);
	const binary = needsQuoting ? `"${login.binary}"` : login.binary;
	// cmd.exe executes a quoted path directly, so only PowerShell needs help.
	const prefix = syntax === 'powershell' && needsQuoting ? '& ' : '';
	return login.args ? `${prefix}${binary} ${login.args}` : `${prefix}${binary}`;
}

/**
 * Map a Maestro shell id to the dialect its command line is written in.
 *
 * Shell ids come from `shellDetector`: on Windows `powershell`, `pwsh`, `cmd`,
 * `bash` (Git Bash), and `wsl`; elsewhere the usual Unix shells. Off Windows
 * every shell is posix, so the platform is checked first.
 */
export function loginShellSyntaxFor(shellId: string, isWindows: boolean): LoginShellSyntax {
	if (!isWindows) return 'posix';
	const shell = shellId.trim().toLowerCase();
	// Git Bash and WSL run a posix shell even though the host is Windows.
	if (shell === 'bash' || shell === 'sh' || shell === 'wsl') return 'posix';
	if (shell === 'cmd') return 'cmd';
	// Windows defaults to PowerShell, so an unset or unknown shell lands here.
	return 'powershell';
}
