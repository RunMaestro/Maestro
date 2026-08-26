/**
 * toolActivityLabel - turn a raw agent tool call into ONE short line of plain
 * English ("Read src/App.tsx", "Ran npm test", "Edited themes.ts").
 *
 * This is deliberately NOT `summarizeToolInput`
 * (`components/TerminalOutput/utils/toolSummaries.ts`). That helper builds the
 * verbose in-chat tool cell: every input key dumped as `key=value`, full
 * untruncated command text, plus a separate output preview. It is the right
 * thing for the chat transcript and the wrong thing for a live activity feed,
 * where the whole point is that a user glancing at the panel can tell at a
 * glance whether the agent is making progress or spinning in a loop.
 *
 * Tool names vary per provider (Claude Code `Read`/`Bash`/`Edit`, OpenCode
 * lowercase `read`/`bash`, Codex `shell`/`apply_patch`/`update_plan`, Copilot
 * `write_to_file`, MCP `mcp__server__tool`), so matching is done on a normalized
 * name and every unknown tool still gets a usable "Used <name>" line rather than
 * being dropped.
 */

import { truncateCommand, truncatePath } from '../../shared/formatters';

/** A tool call rendered as one short, human-readable line. */
export interface ToolActivityLabel {
	/** Past/present-tense verb phrase, e.g. `Read`, `Ran`, `Edited`. */
	verb: string;
	/** What it acted on: a path, command, pattern, or URL. May be empty. */
	target: string;
}

/** Max characters of `target` shown on the single line. */
const MAX_TARGET_LENGTH = 72;

/**
 * Normalize a provider tool name for matching: lowercase and strip separators so
 * `write_to_file`, `writeToFile`, and `WriteToFile` all collapse to one key.
 */
function normalizeToolName(toolName: string): string {
	return toolName.toLowerCase().replace(/[-_\s]/g, '');
}

/** First string-valued key present on the input record, else undefined. */
function firstString(input: Record<string, unknown>, keys: string[]): string | undefined {
	for (const key of keys) {
		const value = input[key];
		if (typeof value === 'string' && value.trim()) return value.trim();
	}
	return undefined;
}

/**
 * Coerce a command value to a string. Codex and OpenCode deliver `command` as an
 * argv array (`['npm', 'test']`); Claude Code sends a single string.
 */
function commandString(value: unknown): string | undefined {
	if (typeof value === 'string' && value.trim()) return value.trim();
	if (Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string')) {
		return value.join(' ');
	}
	return undefined;
}

/**
 * Summarize a TodoWrite/update_plan payload as "<current task> (done/total)".
 * Mirrors the in-chat summary so the two surfaces agree on wording.
 */
function todoSummary(value: unknown): string | undefined {
	if (!Array.isArray(value) || value.length === 0) return undefined;
	const todos = value as Array<{
		content?: string;
		status?: string;
		activeForm?: string;
		step?: string;
	}>;
	const completed = todos.filter((t) => t.status === 'completed').length;
	const current = todos.find((t) => t.status === 'in_progress');
	const label =
		current?.activeForm || current?.content || current?.step || todos[0]?.content || todos[0]?.step;
	if (!label) return `${todos.length} tasks`;
	return `${label} (${completed}/${todos.length})`;
}

/**
 * `mcp__linear__create_issue` -> `linear: create issue`. MCP tool names are
 * server-namespaced and unreadable raw, but the two segments are meaningful.
 */
function mcpLabel(toolName: string): ToolActivityLabel | null {
	const match = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(toolName);
	if (!match) return null;
	const [, server, tool] = match;
	return { verb: `Called ${server}`, target: tool.replace(/_/g, ' ') };
}

/**
 * Describe a tool call as a single plain-language line.
 *
 * @param toolName - Raw provider tool name (e.g. `Bash`, `apply_patch`).
 * @param input - The tool's input payload. Some providers (Codex `apply_patch`,
 *   Copilot) send a raw string instead of an object; both are handled.
 */
export function describeToolActivity(toolName: string, input: unknown): ToolActivityLabel {
	const name = (toolName || '').trim();
	const record: Record<string, unknown> =
		input && typeof input === 'object' && !Array.isArray(input)
			? (input as Record<string, unknown>)
			: {};
	// A raw-string input is the payload itself (a patch body, a command), so it
	// stands in for whatever key the object form would have used.
	const rawInput = typeof input === 'string' ? input.trim() : undefined;

	const filePath = firstString(record, [
		'file_path',
		'filePath',
		'notebook_path',
		'notebookPath',
		'path',
		'file',
		'target_file',
	]);
	const command = commandString(record.command ?? record.cmd ?? record.script) ?? rawInput;
	const pattern = firstString(record, ['pattern', 'regex', 'query', 'search']);
	const url = firstString(record, ['url', 'uri']);

	const shorten = (value: string | undefined, isPath: boolean): string => {
		if (!value) return '';
		return isPath
			? truncatePath(value, MAX_TARGET_LENGTH)
			: truncateCommand(value, MAX_TARGET_LENGTH);
	};

	const mcp = mcpLabel(name);
	if (mcp) return mcp;

	switch (normalizeToolName(name)) {
		case 'read':
		case 'view':
		case 'readfile':
		case 'viewfile':
		case 'catfile':
			return { verb: 'Read', target: shorten(filePath, true) };

		case 'write':
		case 'writefile':
		case 'writetofile':
		case 'createfile':
		case 'create':
			return { verb: 'Wrote', target: shorten(filePath, true) };

		case 'edit':
		case 'multiedit':
		case 'strreplace':
		case 'strreplaceeditor':
		case 'strreplacebasededittool':
		case 'applypatch':
		case 'patch':
		case 'editfile':
			// Codex sends apply_patch as one raw diff string with no path field;
			// fall back to the patch body so the line is not left bare.
			return { verb: 'Edited', target: shorten(filePath ?? rawInput, !!filePath) };

		case 'notebookedit':
			return { verb: 'Edited notebook', target: shorten(filePath, true) };

		case 'bash':
		case 'shell':
		case 'sh':
		case 'execcommand':
		case 'localshell':
		case 'runcommand':
		case 'terminal':
		case 'runterminalcmd':
			return { verb: 'Ran', target: shorten(command, false) };

		case 'bashoutput':
			return { verb: 'Checked background output', target: '' };

		case 'killshell':
		case 'killbash':
			return { verb: 'Stopped a background command', target: '' };

		case 'grep':
		case 'search':
		case 'ripgrep':
		case 'searchfiles':
		case 'grepsearch':
			return { verb: 'Searched for', target: shorten(pattern, false) };

		case 'glob':
		case 'find':
		case 'fileglob':
		case 'globfilesearch':
			return { verb: 'Looked for files matching', target: shorten(pattern, false) };

		case 'ls':
		case 'list':
		case 'listdirectory':
		case 'listdir':
			return { verb: 'Listed', target: shorten(filePath, true) };

		case 'webfetch':
		case 'fetch':
			return { verb: 'Fetched', target: shorten(url, false) };

		case 'websearch':
			return { verb: 'Searched the web for', target: shorten(pattern, false) };

		case 'task':
		case 'agent':
		case 'dispatchagent':
			return {
				verb: 'Delegated to a subagent',
				target: shorten(firstString(record, ['description', 'prompt', 'subagent_type']), false),
			};

		case 'todowrite':
		case 'updateplan':
		case 'todoread':
			return {
				verb: 'Updated the task list',
				target: shorten(todoSummary(record.todos ?? record.plan ?? record.steps), false),
			};

		case 'askuserquestion':
			return { verb: 'Asked you a question', target: '' };

		case 'exitplanmode':
			return { verb: 'Presented a plan', target: '' };

		default: {
			// Unknown tool: still emit a line. Prefer whichever recognizable field
			// the payload carried so the user sees more than a bare tool name.
			const fallback = filePath ?? command ?? pattern ?? url;
			return {
				verb: `Used ${name || 'a tool'}`,
				target: shorten(fallback, fallback === filePath),
			};
		}
	}
}
