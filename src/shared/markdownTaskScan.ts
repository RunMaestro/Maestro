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
