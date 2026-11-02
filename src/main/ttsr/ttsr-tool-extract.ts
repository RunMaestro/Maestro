/**
 * Pull matchable snapshots out of a normalized {@link ParsedEvent}: what an
 * edit/write tool is about to write, and what a shell tool is about to run.
 *
 * TTSR's tool-source matching needs both the target path (for the glob gate)
 * and the *content* (for regex and, for file writes, ast-grep). The existing
 * `extractFilePathFromToolExecution` in `wakatime-manager.ts` answers only the
 * path half, does not distinguish edit from write (TTSR scopes them
 * separately), and drags in an `electron` import - so this is a genuinely
 * different extraction, not a duplicate of it.
 *
 * Per Gate A, availability differs by agent: claude-code / opencode /
 * copilot-cli surface the full written text, codex surfaces only a patch (so
 * the extractor recovers the added lines), and factory-droid / grok emit no
 * tool events at all. Shell commands come through as `Bash` (claude-code),
 * `shell` (codex), or `bash` (opencode) with the command in the tool input.
 */

import { posix } from 'path';
import { TTSR_CONFIG_PATH, TTSR_RULES_DIR } from '../../shared/maestro-paths';
import { normalizeRootRelativePath } from '../../shared/pathContainment';
import type { ParsedEvent } from '../parsers/agent-output-parser';

/**
 * Whether a path is TTSR's own configuration, which is never matched against.
 *
 * A rule file necessarily contains the very text its rule looks for: writing
 * `.maestro/rules/no-console-log.md` means writing "console.log" into a file,
 * which a `tool:write` rule with no `globs` would happily fire on. TTSR would
 * then interrupt the agent for authoring the rule that told it not to do the
 * thing - and since editing rules is exactly how a user asks an agent to set
 * TTSR up, that is not a corner case but the main authoring path.
 *
 * Accepts absolute or project-relative paths, either separator. The check is
 * anchored, not a substring test: a NESTED `.maestro/rules/` (a fixture, a
 * vendored repo, a sub-project like `fixtures/.maestro/rules/example.md`) is
 * ordinary project content whose edits must stay visible to the matcher -
 * suppressing it would both hide real violations and hand the agent a
 * directory name that mutes every tool rule. A project-relative path counts
 * only when it starts at the root; an absolute path only when it resolves
 * inside THIS project's own config (which needs `projectRoot` - without it, an
 * absolute path is never treated as TTSR config).
 */
export function isTtsrConfigPath(filePath: string | undefined, projectRoot?: string): boolean {
	if (!filePath) return false;
	let relative = filePath.replace(/\\/g, '/');
	if (posix.isAbsolute(relative) || /^[A-Za-z]:/.test(relative)) {
		if (!projectRoot) return false;
		const rootPath = projectRoot.replace(/\\/g, '/');
		// Drive-relative roots cannot authorize absolute targets. Unknown Windows
		// namespaces remain visible rather than guessing their current drive/share.
		if (!posix.isAbsolute(rootPath) && !/^[A-Za-z]:\//.test(rootPath)) return false;
		if (rootPath.startsWith('//') || relative.startsWith('//')) return false;
		if (normalizeRootRelativePath(rootPath.replace(/^(?:[A-Za-z]:)?\//, '')) === null) return false;
		const root = posix.normalize(rootPath).replace(/\/+$/, '');
		if (!relative.startsWith(`${root}/`)) return false;
		relative = relative.slice(root.length + 1);
	}
	const normalized = normalizeRootRelativePath(relative);
	return (
		normalized !== null &&
		(normalized.startsWith(`${TTSR_RULES_DIR}/`) || normalized === TTSR_CONFIG_PATH)
	);
}

/** `> path`, `>> path`, `2> path`, quoted or not - the heredoc case included. */
const TTSR_CONFIG_REDIRECT = />>?\s*(?:"([^"]+)"|'([^']+)'|([^\s'"|;&<>]+))(?=$|[\s|;&<>])/g;

/**
 * Whether a shell command clearly writes to TTSR's own configuration.
 *
 * The `filePath` guard above cannot see this case: a `tool:bash` snapshot has no
 * target file, only the command line, so an agent authoring a rule through the
 * shell (`cat > .maestro/rules/no-force-push.md <<EOF ... git push --force ...
 * EOF`) would trip every `tool:bash` rule whose condition appears in the rule
 * body it is writing. Agent-driven authoring is the primary flow (see
 * `src/prompts/ttsr-rule-authoring.md`), so that is the common case, not a
 * corner one.
 *
 * Deliberately conservative: only isolated literal writes whose destinations
 * all belong to this project's config qualify. Unsupported shell/interpreter
 * syntax stays matchable; only quoted heredocs can hide literal rule bodies. A command that merely reads the rules dir (`grep -r
 * '--force' .maestro/rules`) still matches, because reading is not authoring and
 * suppressing it would open a hole an agent could hide real work behind.
 */
export function isTtsrConfigWriteCommand(command: string, projectRoot?: string): boolean {
	const normalized = command.replace(/\\/g, '/');
	// Cheap prefilter: the overwhelming majority of commands mention neither path.
	if (!normalized.includes(`${TTSR_RULES_DIR}/`) && !normalized.includes(TTSR_CONFIG_PATH)) {
		return false;
	}
	// Exempt only isolated writes. A config path in one segment cannot hide
	// a real command in another, a substitution, or an interpreter's script.
	// JavaScript whitespace includes characters that shells keep inside words.
	if (/[^\S \t\n]|\0/u.test(command)) return false;
	let candidate = command.trim();
	const lines = candidate.split('\n');
	if (lines.length > 1) {
		const heredoc = /<<(['"])([A-Za-z_][A-Za-z0-9_]*)\1\s*$/.exec(lines[0]);
		if (!heredoc) return false;
		const end = lines.findIndex((line, index) => index > 0 && line === heredoc[2]);
		if (end < 0 || lines.slice(end + 1).some((line) => line.trim())) return false;
		candidate = lines[0].slice(0, heredoc.index).trim();
	}
	// Backslash escaping differs across shells and can change quote boundaries.
	// Keep those commands matchable; structured file paths still accept both separators.
	if (/[\\\x00-\x08\x0b-\x1f\x7f]/.test(candidate)) return false;
	// Quoted separators are data; substitutions in double quotes still execute.
	let unsafe = false;
	const quotes: Array<{ start: number; end: number }> = [];
	const syntax = candidate.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, (quoted, start: number) => {
		const end = start + quoted.length;
		quotes.push({ start, end });
		// Adjacent fragments form one shell word. Classify complete literals only.
		if (
			(start > 0 && !/[\s|<>]/.test(candidate[start - 1])) ||
			(end < candidate.length && !/[\s|<>]/.test(candidate[end]))
		)
			unsafe = true;
		if (quoted.startsWith('"') && /[$`]/.test(quoted)) unsafe = true;
		return 'literal';
	});
	if (unsafe || /[;&\n\r$`(){}'"<>#*?\[\]~^!]/.test(syntax.replace(/>>?/g, ''))) return false;
	if (
		syntax.includes('|') &&
		!/^(?:echo|printf)(?=[\s|]|$)[^|]*\|\s*tee(?=\s|$)[^|]*$/.test(syntax)
	)
		return false;
	if (!/^(?:echo|printf|cat|cp|mv|touch|mkdir|ln|tee)(?=[\s>|]|$)/.test(syntax)) return false;
	const pipe = [...candidate.matchAll(/\|/g)].find(
		(match) => !quotes.some(({ start, end }) => match.index >= start && match.index < end)
	);
	const tokens = [...candidate.matchAll(/"([^"]*)"|'([^']*)'|([^\s'"|;&<>]+)/g)].map((match) => ({
		start: match.index,
		value: match[1] ?? match[2] ?? match[3],
	}));
	// Options can be quoted or follow redirects. Retain all leading-dash printf
	// operands rather than confusing variable assignment with literal output.
	if (
		tokens[0]?.value === 'printf' &&
		tokens
			.slice(1)
			.some(({ start, value }) => (!pipe || start < pipe.index) && value.startsWith('-'))
	)
		return false;
	const redirects = [...candidate.matchAll(TTSR_CONFIG_REDIRECT)].filter(
		(match) => !quotes.some(({ start, end }) => match.index >= start && match.index < end)
	);
	if (redirects.length > 0) {
		// A pipeline can write through tee as well as its redirects. Keep it
		// matchable rather than treating redirect targets as its only writes.
		if (syntax.includes('|')) return false;
		return (
			/^(?:echo|printf|cat)(?=[\s>]|$)/.test(syntax) &&
			redirects.every((match) => isTtsrConfigPath(match[1] ?? match[2] ?? match[3], projectRoot))
		);
	}
	// Only simple literal operands qualify. Ambiguous shell spellings remain
	// matchable; an authoring exemption must not hide another write or move.
	const words = tokens.filter(({ start }) => !pipe || start > pipe.index).map(({ value }) => value);
	const verb = words.shift();
	if (verb === 'tee' && words[0] === '-a') words.shift();
	if (verb === 'cp' && words.length === 2) {
		return !words[0].startsWith('-') && isTtsrConfigPath(words[1], projectRoot);
	}
	if ((verb === 'mv' || verb === 'ln') && words.length !== 2) return false;
	return (
		['tee', 'touch', 'mkdir', 'mv', 'ln'].includes(verb ?? '') &&
		words.length > 0 &&
		words.every((word) => isTtsrConfigPath(word, projectRoot))
	);
}

/** One in-flight tool action observed on the stream. */
export interface TtsrToolSnapshot {
	/** Matches the TTSR scope vocabulary. */
	source: 'tool:edit' | 'tool:write' | 'tool:bash';
	toolName: string;
	/**
	 * Absolute or project-relative path, when the tool reported one. Never set
	 * for `tool:bash` - a command has no single target file.
	 */
	filePath?: string;
	/**
	 * The matchable text: full file content, replacement string, patch additions,
	 * or - for `tool:bash` - the command line itself.
	 */
	content: string;
}

/** Tools that create/replace a whole file. */
const WRITE_TOOLS = new Set(['write', 'write_file', 'write_to_file', 'create_file', 'create']);

/** Tools that mutate part of a file. */
const EDIT_TOOLS = new Set([
	'edit',
	'multiedit',
	'notebookedit',
	'str_replace_editor',
	'str_replace_based_edit_tool',
	'apply_patch',
	'patch',
	'edit_file',
	'update_file',
]);

/**
 * Tools that run a shell command. Names span every supported agent: `Bash`
 * (claude-code), `shell` (codex), `bash` (opencode), and the `run_*` spellings
 * copilot-cli and others use.
 */
const SHELL_TOOLS = new Set([
	'bash',
	'shell',
	'sh',
	'exec',
	'execute',
	'command',
	'run_command',
	'run_terminal_cmd',
	'execute_command',
	'terminal',
	'local_shell',
]);

function classifyTool(toolName: string): TtsrToolSnapshot['source'] | null {
	const key = toolName.toLowerCase();
	if (WRITE_TOOLS.has(key)) return 'tool:write';
	if (EDIT_TOOLS.has(key)) return 'tool:edit';
	if (SHELL_TOOLS.has(key)) return 'tool:bash';
	return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function firstString(input: Record<string, unknown>, keys: string[]): string | undefined {
	for (const key of keys) {
		const value = input[key];
		if (typeof value === 'string' && value.length > 0) return value;
	}
	return undefined;
}

const PATH_KEYS = ['file_path', 'filePath', 'path', 'filename', 'file', 'target_file'];
const CONTENT_KEYS = ['content', 'contents', 'new_string', 'new_str', 'text', 'source'];
const COMMAND_KEYS = ['command', 'cmd', 'script', 'commandLine', 'command_line'];

/**
 * The command a shell tool call will run, as one matchable line.
 *
 * Providers disagree on the shape: a plain string (claude-code, codex), an argv
 * array (some `local_shell` payloads), or the whole input as a bare string.
 * An argv array is joined with spaces so a rule can match the command as it
 * would be typed.
 */
function extractCommand(rawInput: unknown): string | undefined {
	if (typeof rawInput === 'string') return rawInput.trim() || undefined;

	const input = asRecord(rawInput);
	if (!input) return Array.isArray(rawInput) ? joinArgv(rawInput) : undefined;

	for (const key of COMMAND_KEYS) {
		const value = input[key];
		if (typeof value === 'string' && value.trim()) return value.trim();
		if (Array.isArray(value)) {
			const joined = joinArgv(value);
			if (joined) return joined;
		}
	}
	return undefined;
}

function joinArgv(argv: unknown[]): string | undefined {
	const parts = argv.filter((entry): entry is string => typeof entry === 'string');
	return parts.length > 0 ? parts.join(' ') : undefined;
}

/**
 * Recover the added lines from a unified/apply_patch diff so codex's
 * patch-only tool surface still yields matchable content (Gate A "partial").
 */
export function extractPatchAdditions(patch: string): string {
	const added: string[] = [];
	for (const line of patch.split('\n')) {
		if (line.startsWith('+++') || line.startsWith('+++ ')) continue;
		if (line.startsWith('+')) added.push(line.slice(1));
	}
	return added.join('\n');
}

/** Recover the target path from an apply_patch header, when present. */
export function extractPatchPath(patch: string): string | undefined {
	const match = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/m.exec(patch);
	if (match) return match[1].trim();
	const unified = /^\+\+\+ (?:b\/)?(.+)$/m.exec(patch);
	return unified ? unified[1].trim() : undefined;
}

function looksLikePatch(value: string): boolean {
	return value.includes('*** Begin Patch') || /^@@ /m.test(value) || /^--- /m.test(value);
}

/** Build a snapshot from one tool invocation's input payload. */
function snapshotFromInput(toolName: string, rawInput: unknown): TtsrToolSnapshot | null {
	const source = classifyTool(toolName);
	if (!source) return null;

	// A shell call carries a command, not file content, and has no target path.
	if (source === 'tool:bash') {
		const command = extractCommand(rawInput);
		return command ? { source, toolName, content: command } : null;
	}

	// codex's apply_patch delivers the raw patch text rather than a JSON object.
	if (typeof rawInput === 'string') {
		if (!looksLikePatch(rawInput)) return null;
		return {
			source,
			toolName,
			filePath: extractPatchPath(rawInput),
			content: extractPatchAdditions(rawInput),
		};
	}

	const input = asRecord(rawInput);
	if (!input) return null;

	const filePath = firstString(input, PATH_KEYS);
	const patch = firstString(input, ['patch', 'diff', 'input']);
	if (patch && looksLikePatch(patch)) {
		return {
			source,
			toolName,
			filePath: filePath ?? extractPatchPath(patch),
			content: extractPatchAdditions(patch),
		};
	}

	const parts: string[] = [];
	const direct = firstString(input, CONTENT_KEYS);
	if (direct) parts.push(direct);

	// MultiEdit-style batched replacements.
	const edits = input.edits;
	if (Array.isArray(edits)) {
		for (const entry of edits) {
			const edit = asRecord(entry);
			if (!edit) continue;
			const value = firstString(edit, CONTENT_KEYS);
			if (value) parts.push(value);
		}
	}

	if (parts.length === 0) return null;
	return { source, toolName, filePath, content: parts.join('\n') };
}

/**
 * Every tool snapshot carried by a parsed event. Covers both event shapes the
 * parsers produce: `toolUseBlocks` (claude-code, copilot-cli) and `toolName` +
 * `toolState.input` (opencode, codex).
 *
 * Writes to TTSR's own config are dropped here, at the single choke point, so
 * neither regex nor ast-grep ever sees a rule file - by target path for
 * edit/write snapshots ({@link isTtsrConfigPath}) and by command text for shell
 * ones ({@link isTtsrConfigWriteCommand}), which carry no path at all.
 *
 * Residual limitation: this guards the act of writing the rule, not talk about
 * it. An agent that quotes a rule's condition in prose ("I will add a rule
 * banning `git push --force`") still trips a `text`-scoped rule matching that
 * phrase, and no choke point can fix it - the prose stream carries no signal
 * distinguishing a violation from a description of one. Rules meant for the
 * authoring flow should be scoped to tool sources rather than to prose.
 */
export function extractToolSnapshots(event: ParsedEvent, projectRoot?: string): TtsrToolSnapshot[] {
	const snapshots: TtsrToolSnapshot[] = [];

	const add = (snapshot: TtsrToolSnapshot | null): void => {
		if (!snapshot) return;
		if (isTtsrConfigPath(snapshot.filePath, projectRoot)) return;
		if (snapshot.source === 'tool:bash' && isTtsrConfigWriteCommand(snapshot.content, projectRoot))
			return;
		snapshots.push(snapshot);
	};

	for (const block of event.toolUseBlocks ?? []) {
		add(snapshotFromInput(block.name, block.input));
	}

	if (event.toolName) {
		const state = asRecord(event.toolState);
		add(snapshotFromInput(event.toolName, state ? state.input : undefined));
	}

	return snapshots;
}
