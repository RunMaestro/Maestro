/**
 * File review comments: comments a user pins to one line, or a span of lines,
 * of a file open in the File Preview, collected into one review, and handed to
 * the agent as a single prompt. The Git Diff review's twin for a file that has
 * no diff (a doc, a plan, code the agent has not touched yet).
 *
 * Everything here is pure, so the anchoring rules and the exact prompt the
 * agent receives can be pinned by tests. The prompt has the same shape as the
 * diff review's (`reviewPrompt.ts`): each comment names its `path:lines`,
 * quotes the lines it was left on, then says what to change.
 */
import { formatFileLineReference } from './quoteSelection';
import { formatCommentCount, formatReviewPrompt } from './reviewPrompt';

/** Where a comment sits, independent of what it says. */
export interface FileCommentAnchor {
	/**
	 * The path the agent is told: project-relative when the file sits under the
	 * agent's working directory, else absolute.
	 */
	path: string;
	/** 1-based, inclusive. */
	startLine: number;
	endLine: number;
	/**
	 * The text of each covered line, when the comment was made. Quoted in the
	 * prompt, and compared against the file as it is now: a mismatch makes the
	 * comment outdated (`findOutdatedFileComments`).
	 */
	lineContents: string[];
	/** Code fence info string for the quote (`ts`, `markdown`). */
	language?: string;
}

export interface FileComment extends FileCommentAnchor {
	id: string;
	/** The reviewer's comment. Markdown allowed. */
	body: string;
}

/** The lines of `content`, without their line endings. */
export function splitFileLines(content: string): string[] {
	return content.split(/\r?\n/);
}

/**
 * Pin a comment to lines `startLine`-`endLine` of `content` (either order).
 * Null when a line is outside the file.
 */
export function anchorForFileLines({
	content,
	path,
	startLine,
	endLine = startLine,
	language,
}: {
	content: string | readonly string[];
	path: string;
	startLine: number;
	endLine?: number;
	language?: string;
}): FileCommentAnchor | null {
	const lines = typeof content === 'string' ? splitFileLines(content) : content;
	const lo = Math.min(startLine, endLine);
	const hi = Math.max(startLine, endLine);
	if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < 1 || hi > lines.length) return null;
	return { path, startLine: lo, endLine: hi, lineContents: lines.slice(lo - 1, hi), language };
}

/**
 * Comments whose lines no longer read as they did when the comment was
 * written: an edit above them moved them, or the lines themselves changed.
 *
 * An outdated comment is kept (the user wrote it) but never sent: its
 * `path:lines` would point the agent at the wrong text.
 */
export function findOutdatedFileComments(
	comments: readonly FileComment[],
	content: string
): Set<string> {
	const outdated = new Set<string>();
	if (comments.length === 0) return outdated;
	const lines = splitFileLines(content);
	for (const comment of comments) {
		const current = lines.slice(comment.startLine - 1, comment.endLine);
		const same =
			current.length === comment.lineContents.length &&
			current.every((line, i) => line === comment.lineContents[i]);
		if (!same) outdated.add(comment.id);
	}
	return outdated;
}

/** The menu item that opens a comment box: `Comment on Line 12` / `Comment on Lines 12-14`. */
export function formatCommentOnLinesLabel(startLine: number, endLine: number = startLine): string {
	return endLine > startLine
		? `Comment on Lines ${startLine}-${endLine}`
		: `Comment on Line ${startLine}`;
}

/** `docs/plan.md:12-14`. */
export function formatFileCommentLocation(anchor: FileCommentAnchor): string {
	return formatFileLineReference(anchor.path, anchor.startLine, anchor.endLine);
}

/**
 * Format a review into the single prompt sent to the agent.
 *
 * Comments are written top to bottom, so the agent works down the file the
 * way the reviewer read it. Comments with an empty body are skipped. Returns
 * `''` when nothing is left to send.
 */
export function formatFileReviewPrompt(comments: readonly FileComment[]): string {
	const usable = comments
		.filter((c) => c.body.trim().length > 0)
		.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
	if (usable.length === 0) return '';

	const paths = [...new Set(usable.map((c) => c.path))];
	const subject = paths.length === 1 ? `\`${paths[0]}\`` : `${paths.length} files`;
	return formatReviewPrompt(
		[
			`I reviewed ${subject} and left ${formatCommentCount(usable.length)} pinned to specific lines. Please address each one.`,
			'Each comment names the file and lines it is about, then quotes those lines as they read when I commented.',
		],
		usable.map((comment) => ({
			selection: {
				path: comment.path,
				startLine: comment.startLine,
				endLine: comment.endLine,
				text: comment.lineContents.join('\n'),
				language: comment.language,
			},
			body: comment.body,
		}))
	);
}
