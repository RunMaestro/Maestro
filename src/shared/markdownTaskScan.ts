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
	let inFencedCode = false;
	let fenceChar: '`' | '~' | null = null;
	let openFenceLength = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const fenceMatch = line.trimStart().match(/^([`~]{3,})/);
		if (fenceMatch) {
			const currentFenceChar = fenceMatch[1][0] as '`' | '~';
			if (!inFencedCode) {
				inFencedCode = true;
				fenceChar = currentFenceChar;
				openFenceLength = fenceMatch[1].length;
				continue;
			}
			if (fenceChar === currentFenceChar && fenceMatch[1].length >= openFenceLength) {
				inFencedCode = false;
				fenceChar = null;
				openFenceLength = 0;
				continue;
			}
		}

		if (inFencedCode) continue;

		if (visit(line, i) === false) return;
	}
}

/** The checkbox at the start of an unchecked task line, with its list marker. */
const UNCHECKED_TASK_PREFIX_REGEX = /^[\s]*[-*+]\s*\[\s*\]\s*/;

/** An ATX heading: where a task's own lines stop. */
const HEADING_REGEX = /^\s{0,3}#{1,6}\s/;

/** An HTML comment, markers included. A task's text is what a person wrote for the agent. */
const HTML_COMMENT_REGEX = /<!--[^]*?-->/g;

/**
 * The text of the next unchecked tasks, in document order: each task's line
 * without its checkbox, plus the lines under it up to the next task (checked or
 * not) or heading. HTML comments are dropped, so a `MAESTRO:MODEL` marker or a
 * gate is never part of what a task says.
 *
 * It is what model routing reads for an Auto Run task. The dispatch prompt is
 * the playbook's instructions followed by the whole document, the same words
 * for every task, so routing it would judge the boilerplate and not the work.
 * `limit` is how many tasks the dispatch covers: one in task mode, the size of
 * the segment in document mode.
 */
export function nextUncheckedTaskTexts(content: string, limit = 1): string[] {
	const tasks: string[][] = [];
	let current: string[] | null = null;

	forEachMarkdownLine(content, (line) => {
		const unchecked = UNCHECKED_TASK_REGEX.test(line);
		if (unchecked || CHECKED_TASK_COUNT_REGEX.test(line) || HEADING_REGEX.test(line)) {
			current = null;
			if (!unchecked) return;
			if (tasks.length >= limit) return false;
			current = [line.replace(UNCHECKED_TASK_PREFIX_REGEX, '')];
			tasks.push(current);
			return;
		}
		current?.push(line);
	});

	return tasks
		.map((lines) =>
			lines
				.join('\n')
				.replace(HTML_COMMENT_REGEX, '')
				// A comment that ended a line leaves the space that was before it.
				.replace(/[ \t]+$/gm, '')
				.trim()
		)
		.filter((text) => text !== '');
}

/**
 * What model routing reads for one Auto Run dispatch: the tasks the dispatch
 * will work, in order. `taskCount` is how many that is (one in task mode, the
 * segment under one setting in document mode; absent means every task left).
 * Empty when the document has no unchecked task.
 */
export function autoRunRoutingPrompt(content: string, taskCount?: number): string {
	return nextUncheckedTaskTexts(content, taskCount ?? Number.POSITIVE_INFINITY).join('\n\n');
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
