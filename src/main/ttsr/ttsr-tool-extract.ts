/**
 * Pull edit/write snapshots out of a normalized {@link ParsedEvent}.
 *
 * TTSR's tool-source matching needs both the target path (for the glob gate)
 * and the *content being written* (for regex and, later, ast-grep). The
 * existing `extractFilePathFromToolExecution` in `wakatime-manager.ts` answers
 * only the path half, does not distinguish edit from write (TTSR scopes them
 * separately), and drags in an `electron` import - so this is a genuinely
 * different extraction, not a duplicate of it.
 *
 * Per Gate A, content availability differs by agent: claude-code / opencode /
 * copilot-cli surface the full written text, codex surfaces only a patch (so
 * the extractor recovers the added lines), and factory-droid / grok emit no
 * tool events at all.
 */

import type { ParsedEvent } from '../parsers/agent-output-parser';

/** One in-flight file mutation observed on the tool stream. */
export interface TtsrEditSnapshot {
	/** Matches the TTSR scope vocabulary. */
	source: 'tool:edit' | 'tool:write';
	toolName: string;
	/** Absolute or project-relative path, when the tool reported one. */
	filePath?: string;
	/** The text being written: full content, replacement string, or patch additions. */
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

function classifyTool(toolName: string): TtsrEditSnapshot['source'] | null {
	const key = toolName.toLowerCase();
	if (WRITE_TOOLS.has(key)) return 'tool:write';
	if (EDIT_TOOLS.has(key)) return 'tool:edit';
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
function snapshotFromInput(toolName: string, rawInput: unknown): TtsrEditSnapshot | null {
	const source = classifyTool(toolName);
	if (!source) return null;

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
 * Every edit/write snapshot carried by a parsed event. Covers both event
 * shapes the parsers produce: `toolUseBlocks` (claude-code, copilot-cli) and
 * `toolName` + `toolState.input` (opencode, codex).
 */
export function extractEditSnapshots(event: ParsedEvent): TtsrEditSnapshot[] {
	const snapshots: TtsrEditSnapshot[] = [];

	for (const block of event.toolUseBlocks ?? []) {
		const snapshot = snapshotFromInput(block.name, block.input);
		if (snapshot) snapshots.push(snapshot);
	}

	if (event.toolName) {
		const state = asRecord(event.toolState);
		const snapshot = snapshotFromInput(event.toolName, state ? state.input : undefined);
		if (snapshot) snapshots.push(snapshot);
	}

	return snapshots;
}
