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

import { TTSR_CONFIG_PATH, TTSR_RULES_DIR } from '../../shared/maestro-paths';
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
 * Accepts absolute or project-relative paths, either separator.
 */
export function isTtsrConfigPath(filePath: string | undefined): boolean {
	if (!filePath) return false;
	const normalized = filePath.replace(/\\/g, '/');
	return normalized.includes(`${TTSR_RULES_DIR}/`) || normalized.endsWith(TTSR_CONFIG_PATH);
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
 * neither regex nor ast-grep ever sees a rule file (see {@link isTtsrConfigPath}).
 */
export function extractToolSnapshots(event: ParsedEvent): TtsrToolSnapshot[] {
	const snapshots: TtsrToolSnapshot[] = [];

	const add = (snapshot: TtsrToolSnapshot | null): void => {
		if (snapshot && !isTtsrConfigPath(snapshot.filePath)) snapshots.push(snapshot);
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
