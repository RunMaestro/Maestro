const READ_ONLY_CLAUDE_TOOLS: ReadonlySet<string> = new Set([
	'Read',
	'Glob',
	'Grep',
	'LS',
	'LSP',
	'WebFetch',
	'WebSearch',
	'NotebookRead',
	'TodoRead',
	'TaskList',
	'TaskGet',
	'ListMcpResources',
	'ReadMcpResource',
	'ReadMcpResourceDirTool',
	'ReadMcpResourceTool',
]);

/** Conservative allowlist for SDK plan/read-only mode; unknown and MCP tools stay denied. */
export function isClaudeReadOnlyTool(toolName: string): boolean {
	return READ_ONLY_CLAUDE_TOOLS.has(toolName);
}
