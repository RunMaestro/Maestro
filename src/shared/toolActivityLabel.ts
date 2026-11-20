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
 * `write_to_file`, Grok `run_terminal_command`/`search_replace`, Antigravity
 * `run_command`/`view_file` with PascalCase keys, MCP `mcp__server__tool`), so
 * matching is done on a normalized
 * name and every unknown tool still gets a usable "Used <name>" line rather than
 * being dropped.
 */

import { truncateCommand, truncatePath } from './formatters';
import type { CommandCall } from './literalCommand';
import { shellEscape } from './maestro-lib/launch/shell-escape';

/** A tool call rendered as one short, human-readable line. */
export interface ToolActivityLabel {
	/** Past/present-tense verb phrase, e.g. `Read`, `Ran`, `Edited`. */
	verb: string;
	/** What it acted on: a path, command, pattern, or URL. May be empty. */
	target: string;
	/**
	 * Whether `target` is a LITERAL the user could paste into a shell or an
	 * editor (a path, a command, a glob, a regex, a URL) rather than prose we
	 * wrote about the call ("Verifying the harness (3/7)", "create issue").
	 *
	 * The activity feed renders a literal target as inline code - the same chip
	 * markdown backticks get - so a command reads as a command. Running prose
	 * through that treatment instead dresses an English sentence up as something
	 * you could run, which is why this is decided HERE, next to the code that
	 * knows which of the two it just built, and not guessed at by the renderer.
	 */
	targetIsCode: boolean;
}

/** Max characters of `target` shown on the single line. */
const MAX_TARGET_LENGTH = 72;

// The verbs the callers below key off. `describeToolActivity` is the one place
// that decides what a provider's tool name means, so "is this a shell call" and
// "did this edit a file" are answered from the verb it chose, never from a second
// copy of its tool-name lists.
const VERB_RAN = 'Ran';
const VERB_WROTE = 'Wrote';
const VERB_EDITED = 'Edited';
const VERB_EDITED_NOTEBOOK = 'Edited notebook';
const VERB_TASK_LIST = 'Updated the task list';
const VERB_READ = 'Read';
const VERB_SEARCHED = 'Searched for';
const VERB_FOUND_FILES = 'Looked for files matching';
const VERB_LISTED = 'Listed';
const VERB_FETCHED = 'Fetched';
const VERB_SEARCHED_WEB = 'Searched the web for';
const VERB_CHECKED_OUTPUT = 'Checked background output';
const VERB_ASKED = 'Asked you a question';
const VERB_PLANNED = 'Presented a plan';
const FILE_EDIT_VERBS: ReadonlySet<string> = new Set([
	VERB_WROTE,
	VERB_EDITED,
	VERB_EDITED_NOTEBOOK,
]);

/**
 * Normalize a provider tool name for matching: lowercase and strip separators so
 * `write_to_file`, `writeToFile`, and `WriteToFile` all collapse to one key.
 * Exported for the other places that must recognize a tool across providers.
 */
export function normalizeToolName(toolName: string): string {
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
 * An argv array: at least one element, every element a string. `Array.from`
 * fills the holes of a sparse array first, so a hole is not a string.
 */
function isArgv(value: unknown): value is string[] {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		Array.from(value).every((item) => typeof item === 'string')
	);
}

/**
 * Coerce a command value to a string. Codex and OpenCode deliver `command` as an
 * argv array (`['npm', 'test']`); Claude Code sends a single string.
 */
function commandString(value: unknown): string | undefined {
	if (typeof value === 'string' && value.trim()) return value.trim();
	if (isArgv(value)) return value.join(' ');
	return undefined;
}

/**
 * Summarize a TodoWrite/update_plan payload as "<current task> (done/total)".
 * Mirrors the in-chat summary so the two surfaces agree on wording.
 */
function todoSummary(value: unknown): string | undefined {
	if (!Array.isArray(value)) return undefined;
	// A provider's malformed step (null, a string) is skipped, not a crash.
	const todos = value.filter((t) => t && typeof t === 'object') as Array<{
		content?: string;
		status?: string;
		activeForm?: string;
		step?: string;
	}>;
	if (todos.length === 0) return undefined;
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
	return { verb: `Called ${server}`, target: tool.replace(/_/g, ' '), targetIsCode: false };
}

/**
 * A tool input as its field record, plus the raw string for providers that send
 * the payload itself (a patch body, a command) instead of an object. The raw
 * string stands in for whatever key the object form would have used.
 */
function splitToolInput(input: unknown): {
	record: Record<string, unknown>;
	rawInput: string | undefined;
} {
	return {
		record:
			input && typeof input === 'object' && !Array.isArray(input)
				? (input as Record<string, unknown>)
				: {},
		rawInput: typeof input === 'string' ? input.trim() : undefined,
	};
}

/** What a tool input holds under any provider's spelling of "the command". */
function commandValue(record: Record<string, unknown>): unknown {
	return record.command ?? record.cmd ?? record.script ?? record.CommandLine;
}

/** The command a tool input carries, in any provider's spelling, untruncated. */
function inputCommand(
	record: Record<string, unknown>,
	rawInput: string | undefined
): string | undefined {
	return commandString(commandValue(record)) ?? rawInput;
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
	const { record, rawInput } = splitToolInput(input);

	const filePath = firstString(record, [
		'file_path',
		'filePath',
		'notebook_path',
		'notebookPath',
		'path',
		'file',
		'target_file',
		// Antigravity spells its parameters in PascalCase.
		'AbsolutePath',
		'TargetFile',
		'DirectoryPath',
		'SearchPath',
		'SearchDirectory',
	]);
	const command = inputCommand(record, rawInput);
	const pattern = firstString(record, ['pattern', 'regex', 'query', 'search', 'Query', 'Pattern']);
	const url = firstString(record, ['url', 'uri', 'Url']);

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
			return { verb: VERB_READ, target: shorten(filePath, true), targetIsCode: true };

		case 'write':
		case 'writefile':
		case 'writetofile':
		case 'createfile':
		case 'create':
			return { verb: VERB_WROTE, target: shorten(filePath, true), targetIsCode: true };

		case 'edit':
		case 'multiedit':
		case 'strreplace':
		case 'strreplaceeditor':
		case 'strreplacebasededittool':
		case 'applypatch':
		case 'patch':
		case 'editfile':
		case 'searchreplace':
		case 'replacefilecontent':
		case 'multireplacefilecontent':
			// Codex sends apply_patch as one raw diff string with no path field;
			// fall back to the patch body so the line is not left bare.
			return {
				verb: VERB_EDITED,
				target: shorten(filePath ?? rawInput, !!filePath),
				targetIsCode: true,
			};

		case 'notebookedit':
			return { verb: VERB_EDITED_NOTEBOOK, target: shorten(filePath, true), targetIsCode: true };

		case 'bash':
		case 'shell':
		case 'sh':
		case 'execcommand':
		case 'localshell':
		case 'runcommand':
		case 'terminal':
		case 'runterminalcmd':
		case 'runterminalcommand':
			return { verb: VERB_RAN, target: shorten(command, false), targetIsCode: true };

		case 'bashoutput':
			return { verb: VERB_CHECKED_OUTPUT, target: '', targetIsCode: false };

		case 'killshell':
		case 'killbash':
			return { verb: 'Stopped a background command', target: '', targetIsCode: false };

		case 'grep':
		case 'search':
		case 'ripgrep':
		case 'searchfiles':
		case 'grepsearch':
			return { verb: VERB_SEARCHED, target: shorten(pattern, false), targetIsCode: true };

		case 'glob':
		case 'find':
		case 'fileglob':
		case 'globfilesearch':
		case 'findbyname':
			return {
				verb: VERB_FOUND_FILES,
				target: shorten(pattern, false),
				targetIsCode: true,
			};

		case 'ls':
		case 'list':
		case 'listdirectory':
		case 'listdir':
			return { verb: VERB_LISTED, target: shorten(filePath, true), targetIsCode: true };

		case 'webfetch':
		case 'fetch':
			return { verb: VERB_FETCHED, target: shorten(url, false), targetIsCode: true };

		case 'websearch':
			return { verb: VERB_SEARCHED_WEB, target: shorten(pattern, false), targetIsCode: false };

		case 'task':
		case 'agent':
		case 'dispatchagent':
			return {
				verb: 'Delegated to a subagent',
				target: shorten(firstString(record, ['description', 'prompt', 'subagent_type']), false),
				targetIsCode: false,
			};

		case 'todowrite':
		case 'updateplan':
		case 'todoread':
			return {
				verb: VERB_TASK_LIST,
				target: shorten(todoSummary(record.todos ?? record.plan ?? record.steps), false),
				targetIsCode: false,
			};

		case 'askuserquestion':
			return { verb: VERB_ASKED, target: '', targetIsCode: false };

		case 'exitplanmode':
			return { verb: VERB_PLANNED, target: '', targetIsCode: false };

		default: {
			// Unknown tool: still emit a line. Prefer whichever recognizable field
			// the payload carried so the user sees more than a bare tool name.
			const fallback = filePath ?? command ?? pattern ?? url;
			return {
				verb: `Used ${name || 'a tool'}`,
				target: shorten(fallback, fallback === filePath),
				// Whatever the fallback found is a path, command, pattern, or URL.
				targetIsCode: true,
			};
		}
	}
}

/** Where a shell call says to run, in the spellings providers use. */
const CWD_KEYS = [
	'workdir',
	'workDir',
	'cwd',
	'Cwd',
	'directory',
	'working_directory',
	'workingDirectory',
];
/** The variables a shell call says to add, in the spellings providers use. */
const ENV_KEYS = ['env', 'environment'];
/** An argument a shell reads back as itself, so it needs no quotes to be shown. */
const PLAIN_ARGUMENT = /^[\w@%+=:,./-]+$/;

const displayArgument = (argument: string): string =>
	PLAIN_ARGUMENT.test(argument) ? argument : shellEscape(argument);

/** The variables a call names: an object whose values are strings, numbers or booleans. */
function inputEnv(record: Record<string, unknown>): Record<string, string> | undefined {
	for (const key of ENV_KEYS) {
		const value = record[key];
		if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
		const entries = Object.entries(value).flatMap(([name, item]) =>
			typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean'
				? [[name, String(item)] as const]
				: []
		);
		if (entries.length) return Object.fromEntries(entries);
	}
	return undefined;
}

/**
 * The full shell command a tool call carries, in any provider's spelling, and
 * what it asked to run it with; undefined when the call is not a shell call.
 *
 * `describeToolActivity` shows the same command shortened to one line; a caller
 * that compares or classifies commands needs the whole call. Codex sends an
 * argv array, Claude Code a string. An argv array is returned as `argv`, whose
 * elements are the arguments, and `text` shows them with any element that holds
 * a space or a quote quoted, so `['a', 'b c']` and `['a', 'b', 'c']` read
 * differently. A list that is not an argv array (a blank program, an element
 * that is not a string) names no command and is never re-read as a line.
 * `cwd` and `env` are what the call said, and only that: an absent one is
 * unknown, not the directory or environment of the previous call.
 */
export function describeToolCommand(toolName: string, input: unknown): CommandCall | undefined {
	if (describeToolActivity(toolName, input).verb !== VERB_RAN) return undefined;
	const { record, rawInput } = splitToolInput(input);
	const value = commandValue(record);
	const argv = isArgv(value) ? value : undefined;
	if (Array.isArray(value) && !argv?.[0].trim()) return undefined;
	const text = argv ? argv.map(displayArgument).join(' ') : (commandString(value) ?? rawInput);
	if (!text) return undefined;
	const cwd = firstString(record, CWD_KEYS);
	const env = inputEnv(record);
	return { text, ...(argv ? { argv } : {}), ...(cwd ? { cwd } : {}), ...(env ? { env } : {}) };
}

/** One step of a task list a provider keeps (TodoWrite, update_plan). */
export interface ToolTaskItem {
	label: string;
	status: 'completed' | 'in_progress' | 'pending';
}

/**
 * The steps of a task-list call (Claude Code `TodoWrite`, Codex `update_plan`),
 * or undefined when the call is not one. Both providers send the WHOLE list on
 * every call, so the newest call is the current list and an empty array means
 * the list was cleared. A step with no readable label is skipped; any status
 * other than completed or in progress reads as pending.
 */
export function describeToolTaskList(toolName: string, input: unknown): ToolTaskItem[] | undefined {
	if (describeToolActivity(toolName, input).verb !== VERB_TASK_LIST) return undefined;
	const { record } = splitToolInput(input);
	const steps = record.todos ?? record.plan ?? record.steps;
	if (!Array.isArray(steps)) return undefined;
	const items: ToolTaskItem[] = [];
	for (const step of steps) {
		if (!step || typeof step !== 'object') continue;
		const { content, step: planStep, activeForm, status } = step as Record<string, unknown>;
		const label = [content, planStep, activeForm].find(
			(value): value is string => typeof value === 'string' && value.trim() !== ''
		);
		if (!label) continue;
		items.push({
			label: label.trim(),
			status: status === 'completed' || status === 'in_progress' ? status : 'pending',
		});
	}
	return items;
}

/** Whether a tool call writes or edits a file (Edit, Write, apply_patch, NotebookEdit, ...). */
export function describesFileEdit(toolName: string, input: unknown): boolean {
	return FILE_EDIT_VERBS.has(describeToolActivity(toolName, input).verb);
}

/**
 * What kind of thing a tool call does, answered from the verb the feed chose:
 *
 *  - `file-read`: reads one file.
 *  - `search`: looks through files or a directory without changing them.
 *  - `live-read`: reads something that changes on its own (a background command's
 *    output, a web page), so asking again is how one waits, not a repeat.
 *  - `file-edit`: writes or edits a file.
 *  - `shell`: runs a command; what it does is the command's business.
 *  - `plan`: keeps a task list or talks to the user. It touches no file.
 *  - `other`: a subagent, an MCP tool, a tool Maestro has no name for, stopping a
 *    background command. Its effect cannot be read from its name.
 */
export type ToolKind =
	| 'file-read'
	| 'search'
	| 'live-read'
	| 'file-edit'
	| 'shell'
	| 'plan'
	| 'other';

const TOOL_KIND_BY_VERB: ReadonlyMap<string, ToolKind> = new Map([
	[VERB_READ, 'file-read'],
	[VERB_SEARCHED, 'search'],
	[VERB_FOUND_FILES, 'search'],
	[VERB_LISTED, 'search'],
	[VERB_CHECKED_OUTPUT, 'live-read'],
	[VERB_FETCHED, 'live-read'],
	[VERB_SEARCHED_WEB, 'live-read'],
	[VERB_WROTE, 'file-edit'],
	[VERB_EDITED, 'file-edit'],
	[VERB_EDITED_NOTEBOOK, 'file-edit'],
	[VERB_RAN, 'shell'],
	[VERB_TASK_LIST, 'plan'],
	[VERB_ASKED, 'plan'],
	[VERB_PLANNED, 'plan'],
]);

export function describeToolKind(toolName: string, input: unknown): ToolKind {
	return TOOL_KIND_BY_VERB.get(describeToolActivity(toolName, input).verb) ?? 'other';
}

/**
 * How a tool call ended, as the activity feed renders it. `running` is also
 * what we show when a provider sends no status at all - an unfinished call is
 * the honest reading of "we saw it start and never saw it end".
 *
 * Lives here rather than in the store because it is decided from the same raw
 * provider payload `describeToolActivity` reads, and the two must be derived
 * together: a row's glyph and its text describe one event.
 */
export type ToolActivityStatus = 'running' | 'completed' | 'failed';

/** The tool lifecycle payload, as providers deliver it over IPC. */
interface ToolActivityState {
	status?: unknown;
	/** Codex `command_execution` carries the shell's exit code here. */
	exitCode?: unknown;
	exit_code?: unknown;
	/** Claude/Pi/Oh My Pi spell the same outcome as a boolean. */
	isError?: unknown;
	is_error?: unknown;
}

/** A finished-and-fine wording, in the spellings providers actually send. */
const COMPLETED_STATUSES = new Set(['completed', 'complete', 'success', 'succeeded', 'done']);
/** A finished-and-broken wording. */
const FAILED_STATUSES = new Set(['failed', 'failure', 'error', 'errored', 'cancelled', 'canceled']);

/** The first numeric exit code the payload carries, in either spelling. */
function exitCodeOf(state: ToolActivityState): number | undefined {
	for (const value of [state.exitCode, state.exit_code]) {
		if (typeof value === 'number' && Number.isFinite(value)) return value;
	}
	return undefined;
}

/**
 * Decide how a tool call ended from its raw provider payload.
 *
 * The provider's `status` word is NOT enough on its own. Codex reports a shell
 * command that exited non-zero as `status: 'completed'` and puts the failure in
 * `exit_code` (see `transformItemCompleted` in `codex-output-parser.ts`), so a
 * feed that trusted the word alone drew a check mark next to a failed build.
 * That is precisely the row an operator is scanning for: the whole reason to
 * watch an Auto Run is to catch it grinding on something that is not working.
 *
 * So the failure signals win over the status word, in this order:
 *  1. a non-zero exit code, or an `isError` flag;
 *  2. an explicitly failed status word;
 *  3. an explicitly completed status word, or a zero exit code from a provider
 *     that sent no word at all;
 *  4. otherwise still running - the reading that cannot mislead, because it
 *     resolves itself the moment a completion arrives.
 */
export function describeToolActivityStatus(state: unknown): ToolActivityStatus {
	const record: ToolActivityState =
		state && typeof state === 'object' ? (state as ToolActivityState) : {};

	const exitCode = exitCodeOf(record);
	if (exitCode !== undefined && exitCode !== 0) return 'failed';
	if (record.isError === true || record.is_error === true) return 'failed';

	const status = typeof record.status === 'string' ? record.status.trim().toLowerCase() : '';
	if (FAILED_STATUSES.has(status)) return 'failed';
	if (COMPLETED_STATUSES.has(status)) return 'completed';
	if (exitCode === 0) return 'completed';
	return 'running';
}
