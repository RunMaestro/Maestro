/**
 * Fence-aware scanning primitives for Auto Run documents.
 *
 * These live in `shared/` because BOTH Auto Run engines have to read a document
 * the same way: the desktop engine (`src/renderer/hooks/batch/`) and the CLI
 * engine (`src/cli/services/batch-processor.ts`, which cannot import from the
 * renderer). A playbook that paused at a different task depending on how it was
 * launched would be a genuinely confusing bug, so the walk and the task regexes
 * are defined once, here.
 *
 * The fence bookkeeping is the reason this is a shared function rather than an
 * inlined loop: every scanner (task counting, HITL gates, model hints,
 * human-step detection) must skip fenced code blocks, or a playbook that
 * DOCUMENTS the marker syntax triggers it. Hand-rolled copies of that logic
 * drift apart on the details - closing-fence length, tilde fences, CRLF.
 */

/** An unchecked markdown checkbox: `- [ ] task` (also `*` or `+`). */
export const UNCHECKED_TASK_REGEX = /^[\s]*[-*+]\s*\[\s*\]\s*.+$/;

/** A checked markdown checkbox: `- [x] task` (also `X`, `✓`, `✔`). */
export const CHECKED_TASK_COUNT_REGEX = /^[\s]*[-*+]\s*\[[xX✓✔]\]\s*.+$/;

/** Global form used to rewrite checked boxes back to unchecked (reset-on-completion). */
export const CHECKED_TASK_REGEX = /^(\s*[-*+]\s*)\[[xX✓✔]\]/gm;

interface MarkdownFenceState {
	character: '`' | '~' | null;
	length: number;
}

function isOutsideFence(line: string, state: MarkdownFenceState): boolean {
	const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
	if (!match) return state.character === null;

	const token = match[1];
	const character = token[0] as '`' | '~';
	const info = match[2];

	if (state.character === null) {
		if (character === '`' && info.includes('`')) return true;
		state.character = character;
		state.length = token.length;
		return false;
	}

	if (character === state.character && token.length >= state.length && /^[ \t]*$/.test(info)) {
		state.character = null;
		state.length = 0;
	}

	return false;
}

/**
 * Walk markdown content line by line, skipping fenced code blocks so example
 * snippets inside a playbook never register as real tasks or markers.
 *
 * Return `false` from `visit` to stop early.
 */
export function forEachMarkdownLine(
	content: string,
	visit: (line: string, index: number) => boolean | void
): void {
	const lines = content.replace(/\r\n?/g, '\n').split('\n');
	const fence: MarkdownFenceState = { character: null, length: 0 };

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!isOutsideFence(line, fence)) continue;

		if (visit(line, i) === false) return;
	}
}

export interface MarkdownTaskCounts {
	checked: number;
	unchecked: number;
	total: number;
}

/**
 * Count markdown checkbox tasks while ignoring fenced code blocks.
 *
 * Lives here rather than in the desktop engine's `batchUtils` because the CLI
 * engine needs the same counts to detect a stalled document, and a stall
 * heuristic that counted tasks differently from the desktop would trip at a
 * different time on the same playbook.
 */
export function countMarkdownTasks(content: string): MarkdownTaskCounts {
	let checked = 0;
	let unchecked = 0;

	forEachMarkdownLine(content, (line) => {
		if (CHECKED_TASK_COUNT_REGEX.test(line)) {
			checked++;
		} else if (UNCHECKED_TASK_REGEX.test(line)) {
			unchecked++;
		}
	});

	return { checked, unchecked, total: checked + unchecked };
}

/** Extract unchecked task text while ignoring fenced examples. */
export function extractUncheckedMarkdownTasks(content: string): string[] {
	const tasks: string[] = [];

	forEachMarkdownLine(content, (line) => {
		if (!UNCHECKED_TASK_REGEX.test(line)) return;
		tasks.push(line.replace(/^\s*[-*+]\s*\[\s*\]\s*/, '').trim());
	});

	return tasks;
}

/** Reset checked tasks outside fences while preserving original line endings. */
export function uncheckAllMarkdownTasks(content: string): string {
	const parts = content.split(/(\r\n|\r|\n)/);
	const fence: MarkdownFenceState = { character: null, length: 0 };

	for (let i = 0; i < parts.length; i += 2) {
		if (!isOutsideFence(parts[i], fence)) continue;
		parts[i] = parts[i].replace(CHECKED_TASK_REGEX, '$1[ ]');
	}

	return parts.join('');
}
