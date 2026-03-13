/**
 * App-level constants extracted from App.tsx
 * These are Claude Code tool-related constants used for output parsing and command handling
 */

/**
 * Known Claude Code tool names - used to detect concatenated tool name patterns
 * that shouldn't appear in thinking content
 */
export const KNOWN_TOOL_NAMES = [
	// Core Claude Code tools
	'Task',
	'TaskOutput',
	'Bash',
	'Glob',
	'Grep',
	'Read',
	'Edit',
	'Write',
	'NotebookEdit',
	'WebFetch',
	'TodoWrite',
	'WebSearch',
	'KillShell',
	'AskUserQuestion',
	'Skill',
	'EnterPlanMode',
	'ExitPlanMode',
	'LSP',
];

/**
 * Check if a string looks like concatenated tool names (e.g., "TaskGrepGrepReadReadRead")
 * This can happen if malformed content is emitted as thinking chunks
 */
export function isLikelyConcatenatedToolNames(text: string): boolean {
	// Pattern: 3+ tool names concatenated without spaces
	let matchCount = 0;
	let remaining = text.trim();

	// Also handle MCP tools with pattern mcp__<provider>__<tool>
	const mcpPattern = /^mcp__[a-zA-Z0-9_]+__[a-zA-Z0-9_]+/;

	while (remaining.length > 0) {
		let foundMatch = false;

		// Check for MCP tool pattern first
		const mcpMatch = remaining.match(mcpPattern);
		if (mcpMatch) {
			matchCount++;
			remaining = remaining.substring(mcpMatch[0].length);
			foundMatch = true;
		} else {
			// Check for known tool names
			for (const toolName of KNOWN_TOOL_NAMES) {
				if (remaining.startsWith(toolName)) {
					matchCount++;
					remaining = remaining.substring(toolName.length);
					foundMatch = true;
					break;
				}
			}
		}

		if (!foundMatch) {
			// Found non-tool-name content, this is probably real text
			return false;
		}
	}

	// If we matched 3+ consecutive tool names with no other content, it's likely malformed
	return matchCount >= 3;
}

/**
 * Built-in Claude Code slash commands with their descriptions
 */
export const CLAUDE_BUILTIN_COMMANDS: Record<string, string> = {
	compact: 'Summarize conversation to reduce context usage',
	context: 'Show current context window usage',
	cost: 'Show session cost and token usage',
	init: 'Initialize CLAUDE.md with codebase info',
	'pr-comments': 'Address PR review comments',
	'release-notes': 'Generate release notes from changes',
	todos: 'Find and list TODO comments in codebase',
	review: 'Review code changes',
	'security-review': 'Review code for security issues',
	plan: 'Create an implementation plan',
};

/**
 * Built-in OpenCode slash commands with their descriptions
 */
export const OPENCODE_BUILTIN_COMMANDS: Record<string, string> = {
	init: 'Create or update AGENTS.md for the project',
	review: 'Review changes (commit, branch, or PR)',
	undo: 'Revert changes made by OpenCode',
	redo: 'Restore previously undone changes',
	share: 'Create a shareable link to the conversation',
	help: 'List available commands',
	models: 'Switch models interactively',
};

/**
 * Agent-specific built-in command maps, keyed by agent ID
 */
const AGENT_BUILTIN_COMMANDS: Record<string, Record<string, string>> = {
	'claude-code': CLAUDE_BUILTIN_COMMANDS,
	opencode: OPENCODE_BUILTIN_COMMANDS,
};

/**
 * Get description for agent slash commands.
 * Checks all known agent built-in command maps, then falls back to generic description.
 */
export function getSlashCommandDescription(cmd: string, agentId?: string): string {
	// Remove leading slash if present
	const cmdName = cmd.startsWith('/') ? cmd.slice(1) : cmd;

	// If a specific agent is provided, check that agent's commands first
	if (agentId && AGENT_BUILTIN_COMMANDS[agentId]?.[cmdName]) {
		return AGENT_BUILTIN_COMMANDS[agentId][cmdName];
	}

	// Check all agent command maps only when no specific agent was requested
	if (!agentId) {
		for (const commands of Object.values(AGENT_BUILTIN_COMMANDS)) {
			if (commands[cmdName]) {
				return commands[cmdName];
			}
		}
	}

	// For plugin commands (e.g., "plugin-name:command"), use the full name as description hint
	if (cmdName.includes(':')) {
		const [plugin, command] = cmdName.split(':');
		return `${command} (${plugin})`;
	}

	// Generic description for unknown commands
	return 'Agent command';
}
