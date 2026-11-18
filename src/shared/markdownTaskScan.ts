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

const UNCHECKED_TASK_PARTS = /^(\s*[-*+]\s*)\[\s*\](\s*)(.+)$/;
// Same markers as CHECKED_TASK_COUNT_REGEX above (x, X, U+2713, U+2714).
const CHECKED_TASK_PARTS = /^(\s*[-*+]\s*)\[[xX\u2713\u2714]\](\s*)(.*)$/;

export interface FailedTurnCheckboxRestore {
	/** The document with the boxes this turn ticked unticked again. */
	content: string;
	/** Boxes put back to unchecked. */
	restored: number;
	/** Boxes ticked during the turn that no task at dispatch could be matched to. */
	unmatched: number;
}

/**
 * Untick the boxes a FAILED or cancelled turn ticked before it ended.
 *
 * A Grok turn can tick a box and then end on a rate limit, an auth refusal, a
 * stop or a watchdog kill; the tick is the agent's preamble, not a finished
 * task. Only the boxes that were unchecked at dispatch and are checked now are
 * touched: everything else in `after` (the agent's notes, edits the operator
 * made during the turn) stays as it is. A checked line matches its dispatch
 * task exactly or by prefix, since agents append a note when they tick a box.
 *
 * Shared because both Auto Run engines call it on a failed Grok task turn: the
 * desktop engine (`useDocumentProcessor`) and the shared task/document engine
 * (`maestro-lib/autorun/run-playbook.ts`, behind `maestro-cli playbook`, the
 * library runtime and `maestro-cli host`).
 */
export function restoreTasksCheckedByFailedTurn(
	before: string,
	after: string
): FailedTurnCheckboxRestore {
	const take = (pool: Map<string, number>, body: string): boolean => {
		const left = pool.get(body) ?? 0;
		if (left <= 0) return false;
		pool.set(body, left - 1);
		return true;
	};
	const add = (pool: Map<string, number>, body: string) =>
		pool.set(body, (pool.get(body) ?? 0) + 1);
	const longestPrefixKey = (pool: Map<string, number>, body: string): string | undefined => {
		let best: string | undefined;
		for (const [key, left] of pool) {
			if (left > 0 && body.startsWith(key) && (best === undefined || key.length > best.length)) {
				best = key;
			}
		}
		return best;
	};

	const uncheckedAtDispatch = new Map<string, number>();
	const checkedAtDispatch = new Map<string, number>();
	forEachMarkdownLine(before, (line) => {
		const unchecked = UNCHECKED_TASK_PARTS.exec(line);
		if (unchecked) add(uncheckedAtDispatch, unchecked[3].trim());
		const checked = CHECKED_TASK_PARTS.exec(line);
		if (checked) add(checkedAtDispatch, checked[3].trim());
	});

	// Pass 1: lines checked at dispatch and still identical are not this turn's.
	const ticked: Array<{ index: number; prefix: string; gap: string; rest: string }> = [];
	forEachMarkdownLine(after, (line, index) => {
		const checked = CHECKED_TASK_PARTS.exec(line);
		if (!checked) return;
		if (take(checkedAtDispatch, checked[3].trim())) return;
		ticked.push({ index, prefix: checked[1], gap: checked[2], rest: checked[3] });
	});

	const lines = after.replace(/\r\n?/g, '\n').split('\n');
	let restored = 0;
	let unmatched = 0;
	for (const entry of ticked) {
		const body = entry.rest.trim();
		let isTurnTick = take(uncheckedAtDispatch, body);
		if (!isTurnTick) {
			// An already-checked line the agent annotated is not a new tick.
			const annotatedKey = longestPrefixKey(checkedAtDispatch, body);
			if (annotatedKey !== undefined) {
				take(checkedAtDispatch, annotatedKey);
				continue;
			}
			const key = longestPrefixKey(uncheckedAtDispatch, body);
			isTurnTick = key !== undefined && take(uncheckedAtDispatch, key);
		}
		if (isTurnTick) {
			lines[entry.index] = `${entry.prefix}[ ]${entry.gap}${entry.rest}`;
			restored++;
		} else {
			unmatched++;
		}
	}

	if (restored === 0) return { content: after, restored, unmatched };
	const newline = after.includes('\r\n') ? '\r\n' : '\n';
	return { content: lines.join(newline), restored, unmatched };
}
