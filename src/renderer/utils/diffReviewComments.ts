/**
 * Diff review comments (issue #1475): comments a user pins to one or more
 * lines of the Git Diff viewer, collected into one review, and handed back to
 * the agent as a single prompt.
 *
 * Everything here is pure, so the selection rules and the exact prompt the
 * agent receives can be pinned by tests. The `path:lines` reference and the
 * fenced block come from `quoteSelection.ts`, the same shape the File Preview
 * editor's Quote in Message / Send to Agent hand over.
 */
import { getChangeKey } from 'react-diff-view';
import type { ChangeData, HunkData } from 'react-diff-view';
import { formatFileLineReference, formatFileSelection } from './quoteSelection';
import type { ParsedFileDiff } from './gitDiffParser';

/**
 * Which version of the file a line number refers to. A removed line only has a
 * number in the OLD file, so the prompt has to say which one it means or the
 * agent goes looking for the wrong line.
 */
export type DiffSide = 'old' | 'new';

/** One line of a file's diff, in the order a unified diff reads. */
export interface DiffReviewRow {
	hunkIndex: number;
	/** Position of the change inside its hunk. */
	indexInHunk: number;
	change: ChangeData;
	/** react-diff-view change key (`I12`, `D7`, `N40`). */
	key: string;
}

/** Where a comment sits, independent of what it says. */
export interface DiffCommentAnchor {
	/** The diff file the comment is drawn in: its file tab (`diffFileKey`). */
	file: string;
	/**
	 * The path the line numbers refer to, which is what the agent is told. The
	 * same as `file` except for an old-side comment on a renamed file, whose
	 * numbers belong to the file's previous name.
	 */
	path: string;
	side: DiffSide;
	/** 1-based, inclusive, in the file version named by `side`. */
	startLine: number;
	endLine: number;
	/** Change keys the comment covers, in diff order. The last one anchors the comment row. */
	changeKeys: string[];
	/**
	 * The text of each covered line, parallel to `changeKeys`. A later diff
	 * whose lines no longer match makes the comment outdated (`findOutdatedComments`).
	 */
	lineContents: string[];
	/** The hunk the lines belong to, as unified diff text, captured when the comment was made. */
	context: string;
}

export interface DiffComment extends DiffCommentAnchor {
	id: string;
	/** The reviewer's comment. Markdown allowed. */
	body: string;
}

/** A hunk longer than this is trimmed to the selection plus padding. */
export const HUNK_CONTEXT_FULL_LIMIT = 40;
/** Lines kept on each side of the selection when a hunk is trimmed. */
export const HUNK_CONTEXT_PADDING = 5;

/** The file tab a diff file is shown under: its old path once deleted, else its new path. */
export function diffFileKey(
	file: Pick<ParsedFileDiff, 'oldPath' | 'newPath' | 'isDeletedFile'>
): string {
	return file.isDeletedFile ? file.oldPath : file.newPath;
}

/** Every hunk of one diff file, in display order. */
export function diffFileHunks(file: Pick<ParsedFileDiff, 'parsedDiff'>): HunkData[] {
	return file.parsedDiff.flatMap((entry) => entry.hunks);
}

/** Every change of every hunk, flattened in display order. */
export function buildReviewRows(hunks: readonly HunkData[]): DiffReviewRow[] {
	const rows: DiffReviewRow[] = [];
	hunks.forEach((hunk, hunkIndex) => {
		hunk.changes.forEach((change, indexInHunk) => {
			rows.push({ hunkIndex, indexInHunk, change, key: getChangeKey(change) });
		});
	});
	return rows;
}

/**
 * A comment covers lines of ONE hunk. Extending a selection past the edge of
 * the hunk it started in stops at that edge: a range spanning two hunks would
 * name lines the diff does not show.
 */
export function clampToAnchorHunk(
	rows: readonly DiffReviewRow[],
	anchor: number,
	focus: number
): number {
	const anchorRow = rows[anchor];
	if (!anchorRow) return focus;
	let index = Math.max(0, Math.min(rows.length - 1, focus));
	const step = index > anchor ? -1 : 1;
	while (index !== anchor && rows[index].hunkIndex !== anchorRow.hunkIndex) index += step;
	return index;
}

function oldLineOf(change: ChangeData): number | null {
	if (change.type === 'delete') return change.lineNumber;
	if (change.type === 'normal') return change.oldLineNumber;
	return null;
}

function newLineOf(change: ChangeData): number | null {
	if (change.type === 'insert') return change.lineNumber;
	if (change.type === 'normal') return change.newLineNumber;
	return null;
}

function diffMarker(change: ChangeData): string {
	if (change.type === 'insert') return '+';
	if (change.type === 'delete') return '-';
	return ' ';
}

/**
 * The hunk as unified diff text: its `@@` header, then every line with its
 * marker. A long hunk keeps only the selection and `HUNK_CONTEXT_PADDING` lines
 * around it, with `...` where lines were dropped, so one comment on a 500-line
 * new file does not paste the whole file into the prompt.
 */
export function formatHunkContext(hunk: HunkData, startIndex: number, endIndex: number): string {
	const { changes } = hunk;
	let from = 0;
	let to = changes.length - 1;
	if (changes.length > HUNK_CONTEXT_FULL_LIMIT) {
		from = Math.max(0, startIndex - HUNK_CONTEXT_PADDING);
		to = Math.min(changes.length - 1, endIndex + HUNK_CONTEXT_PADDING);
	}
	const lines = [hunk.content];
	if (from > 0) lines.push('...');
	for (let i = from; i <= to; i++) lines.push(`${diffMarker(changes[i])}${changes[i].content}`);
	if (to < changes.length - 1) lines.push('...');
	return lines.join('\n');
}

/**
 * Resolve the rows between `anchor` and `focus` (either order, same hunk) to
 * the file, side and line span a comment is pinned to.
 *
 * Lines are numbered in the NEW file whenever the selection has any line there
 * (added or unchanged). A selection of removed lines only exists in the old
 * file. `clickedSide` is the split-view column the user selected in: picking an
 * unchanged line in the left column means the old numbering.
 */
export function anchorForSelection({
	file,
	oldFile = file,
	hunks,
	rows,
	anchor,
	focus,
	clickedSide,
}: {
	/** The diff file's tab key (`diffFileKey`). */
	file: string;
	/** Its previous path, when it was renamed. Old-side numbers refer to it. */
	oldFile?: string;
	hunks: readonly HunkData[];
	rows: readonly DiffReviewRow[];
	anchor: number;
	focus: number;
	clickedSide?: DiffSide;
}): DiffCommentAnchor | null {
	const first = Math.min(anchor, focus);
	const last = Math.max(anchor, focus);
	const startRow = rows[first];
	const endRow = rows[last];
	if (!startRow || !endRow || startRow.hunkIndex !== endRow.hunkIndex) return null;
	const hunk = hunks[startRow.hunkIndex];
	if (!hunk) return null;

	const selected = rows.slice(first, last + 1);
	const newLines = selected.map((r) => newLineOf(r.change)).filter((n): n is number => n !== null);
	const oldLines = selected.map((r) => oldLineOf(r.change)).filter((n): n is number => n !== null);
	const side: DiffSide =
		(clickedSide === 'old' && oldLines.length > 0) || newLines.length === 0 ? 'old' : 'new';
	const lines = side === 'old' ? oldLines : newLines;

	return {
		file,
		path: side === 'old' ? oldFile : file,
		side,
		startLine: Math.min(...lines),
		endLine: Math.max(...lines),
		changeKeys: selected.map((r) => r.key),
		lineContents: selected.map((r) => r.change.content),
		context: formatHunkContext(hunk, startRow.indexInHunk, endRow.indexInHunk),
	};
}

/**
 * Resolve a `path:start-end` a caller typed (`maestro-cli diff-review add`) to
 * the same anchor a selection in the viewer makes, against the diff as it is
 * now. `side` says which version the numbers are in: `old` for removed lines.
 *
 * Both ends must be lines the diff shows, in one hunk, because that is what the
 * viewer lets a user select.
 */
export function anchorForLines(
	files: readonly ParsedFileDiff[],
	path: string,
	side: DiffSide,
	startLine: number,
	endLine: number
): { ok: true; anchor: DiffCommentAnchor } | { ok: false; error: string } {
	const file = files.find((f) => (side === 'old' ? f.oldPath : f.newPath) === path && !f.isBinary);
	if (!file) {
		const other = side === 'old' ? 'new' : 'old';
		const onOtherSide = files.some((f) => (side === 'old' ? f.newPath : f.oldPath) === path);
		return {
			ok: false,
			error: onOtherSide
				? `${path} is only in the ${other} version of the diff; pass --side ${other}`
				: `${path} is not in the diff`,
		};
	}
	const hunks = diffFileHunks(file);
	const rows = buildReviewRows(hunks);
	const lineOf = side === 'old' ? oldLineOf : newLineOf;
	const indexOfLine = (line: number) => rows.findIndex((r) => lineOf(r.change) === line);
	const lo = Math.min(startLine, endLine);
	const hi = Math.max(startLine, endLine);
	const first = indexOfLine(lo);
	const last = indexOfLine(hi);
	const ref = formatFileLineReference(path, lo, hi);
	if (first < 0 || last < 0) {
		return { ok: false, error: `${ref} (${side} version) is not shown in the diff` };
	}
	if (rows[first].hunkIndex !== rows[last].hunkIndex) {
		return { ok: false, error: `${ref} spans two hunks; comment on each separately` };
	}
	const anchor = anchorForSelection({
		file: diffFileKey(file),
		oldFile: file.oldPath,
		hunks,
		rows,
		anchor: first,
		focus: last,
		clickedSide: side,
	});
	return anchor ? { ok: true, anchor } : { ok: false, error: `${ref} could not be resolved` };
}

/**
 * Comments whose lines are no longer in the diff as they were when the comment
 * was written: the file left the diff, or a covered line moved or changed.
 *
 * An outdated comment is kept (the user wrote it) but never sent: its
 * `path:lines` would point the agent at the wrong code.
 */
export function findOutdatedComments(
	comments: readonly DiffComment[],
	files: readonly ParsedFileDiff[]
): Set<string> {
	const outdated = new Set<string>();
	if (comments.length === 0) return outdated;
	const contentByFile = new Map<string, Map<string, string>>();
	for (const file of files) {
		const byKey = new Map<string, string>();
		for (const row of buildReviewRows(diffFileHunks(file))) byKey.set(row.key, row.change.content);
		contentByFile.set(diffFileKey(file), byKey);
	}
	for (const comment of comments) {
		const byKey = contentByFile.get(comment.file);
		const current =
			!!byKey && comment.changeKeys.every((key, i) => byKey.get(key) === comment.lineContents[i]);
		if (!current) outdated.add(comment.id);
	}
	return outdated;
}

/** `src/app.ts:12-14`, plus a note when the numbers refer to the old file. */
export function formatCommentLocation(anchor: DiffCommentAnchor): string {
	const ref = formatFileLineReference(anchor.path, anchor.startLine, anchor.endLine);
	return anchor.side === 'old' ? `${ref} (previous version)` : ref;
}

function compareComments(a: DiffComment, b: DiffComment): number {
	if (a.path !== b.path) return a.path < b.path ? -1 : 1;
	if (a.startLine !== b.startLine) return a.startLine - b.startLine;
	// Old-side lines first at the same number, matching how a diff reads.
	if (a.side !== b.side) return a.side === 'old' ? -1 : 1;
	return 0;
}

/**
 * Format a review into the single prompt sent to the agent.
 *
 * Every comment names its `path:lines` and quotes the hunk it was left on, so
 * the agent can find the code without guessing even after the file has moved
 * on. Comments with an empty body are skipped. Returns `''` when nothing is
 * left to send.
 *
 * `repoDir` names the directory the diff was taken in, for when it is not the
 * agent's working directory (an agent whose terminal moved to another repo):
 * the paths are relative, and without it the agent would edit matching files
 * in the wrong repository.
 */
export function formatDiffReviewPrompt(
	comments: readonly DiffComment[],
	options: { repoDir?: string } = {}
): string {
	const usable = comments.filter((c) => c.body.trim().length > 0).sort(compareComments);
	if (usable.length === 0) return '';

	const count = usable.length === 1 ? '1 comment' : `${usable.length} comments`;
	const out: string[] = [
		`I reviewed your changes in the git diff and left ${count} pinned to specific lines. Please address each one.`,
		'',
		'Each comment names the file and lines it is about, then quotes the diff hunk it was left on. Line numbers refer to the current version of the file, except where a comment says they refer to the previous version (the lines were removed).',
	];
	if (options.repoDir) {
		out.push(
			'',
			`These changes are in \`${options.repoDir}\`, which is not your working directory. The file paths are as \`git diff\` printed them there; make the changes in that repository.`
		);
	}

	usable.forEach((comment, index) => {
		out.push('', `## Comment ${index + 1} of ${usable.length}`, '');
		out.push(
			formatFileSelection({
				path: comment.path,
				startLine: comment.startLine,
				endLine: comment.endLine,
				text: comment.context,
				language: 'diff',
			})
		);
		if (comment.side === 'old') {
			out.push('', 'These line numbers refer to the previous version of the file.');
		}
		out.push('', comment.body.trim());
	});

	return out.join('\n');
}
