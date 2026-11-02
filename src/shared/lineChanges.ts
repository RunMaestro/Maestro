/**
 * Line-level change counts between two versions of a text file: how many
 * lines a save added and removed, the `+12/-3` a diff stat shows.
 *
 * Counts only. Callers that need the hunks themselves use `diff` directly
 * (see `src/renderer/utils/gitDiffParser.ts`).
 */

import { diffLines } from 'diff';

export interface LineChangeCounts {
	linesAdded: number;
	linesRemoved: number;
}

/**
 * Budget for the exact diff. A save of a huge file with scattered edits can
 * make Myers diff slow; past this the counts fall back to the changed span.
 */
const LINE_DIFF_TIMEOUT_MS = 50;

function splitLines(text: string): string[] {
	if (text === '') return [];
	const lines = text.split(/\r?\n/);
	// A trailing newline ends the last line; it does not start an empty one.
	if (lines[lines.length - 1] === '') lines.pop();
	return lines;
}

/**
 * Upper-bound counts: every line between the common prefix and the common
 * suffix counts as changed. Exact for one contiguous edit.
 */
function countChangedSpan(before: string, after: string): LineChangeCounts {
	const oldLines = splitLines(before);
	const newLines = splitLines(after);
	let start = 0;
	while (
		start < oldLines.length &&
		start < newLines.length &&
		oldLines[start] === newLines[start]
	) {
		start++;
	}
	let oldEnd = oldLines.length;
	let newEnd = newLines.length;
	while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
		oldEnd--;
		newEnd--;
	}
	return { linesAdded: newEnd - start, linesRemoved: oldEnd - start };
}

/**
 * Lines added and removed going from `before` to `after`. A changed line
 * counts as one removed and one added. A missing newline at the end of the
 * file is not a change.
 */
export function countLineChanges(before: string, after: string): LineChangeCounts {
	if (before === after) return { linesAdded: 0, linesRemoved: 0 };
	const changes = diffLines(before, after, {
		ignoreNewlineAtEof: true,
		timeout: LINE_DIFF_TIMEOUT_MS,
	});
	if (!changes) return countChangedSpan(before, after);
	let linesAdded = 0;
	let linesRemoved = 0;
	for (const change of changes) {
		if (change.added) linesAdded += change.count;
		else if (change.removed) linesRemoved += change.count;
	}
	return { linesAdded, linesRemoved };
}
