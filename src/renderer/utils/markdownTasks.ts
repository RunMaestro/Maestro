/**
 * Source-level edits to GFM task lists.
 *
 * Every preview that lets the reader tick a box - the file preview, the Auto Run
 * panel - rewrites the document through here, so a click means the same thing on
 * all of them and there is one regex to keep honest.
 */

/**
 * A GFM task list marker at the start of a line: indent, bullet or ordered
 * marker, then `[ ]` / `[x]` / `[X]`. Split into groups so a toggle can swap
 * the state character without disturbing the author's spacing or bullet style.
 */
const TASK_MARKER_REGEX = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\])/;

export interface TaskToggleResult {
	/** Full document with the one task line rewritten. */
	content: string;
	/** The task's state AFTER the toggle. */
	checked: boolean;
}

/**
 * Flip the GFM task checkbox on 1-based `line`, returning the rewritten
 * document. Returns null when that line holds no task marker, so a caller can
 * treat a stale line number as a no-op instead of corrupting the file.
 *
 * Only the state character is rewritten - indentation, bullet style, and the
 * task text are preserved byte for byte, and splitting on `\n` alone leaves a
 * CRLF file's `\r` attached to its line so line endings round-trip unchanged.
 */
export const toggleTaskCheckboxAtLine = (
	content: string,
	line: number
): TaskToggleResult | null => {
	if (!Number.isInteger(line) || line < 1) return null;
	const lines = content.split('\n');
	const target = lines[line - 1];
	if (target === undefined) return null;

	const match = TASK_MARKER_REGEX.exec(target);
	if (!match) return null;

	const wasChecked = match[2] !== ' ';
	lines[line - 1] = match[1] + (wasChecked ? ' ' : 'x') + match[3] + target.slice(match[0].length);

	return { content: lines.join('\n'), checked: !wasChecked };
};
