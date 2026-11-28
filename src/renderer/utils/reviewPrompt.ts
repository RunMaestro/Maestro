/**
 * The prompt a review becomes: an introduction, then one section per comment
 * naming its `path:lines`, quoting the text it was left on in a fence, and
 * giving the reviewer's words.
 *
 * Shared by the Git Diff review (the quote is the diff hunk) and the File
 * Preview review (the quote is the commented lines), so an agent reads both in
 * the same shape. The `path:lines` reference and the fence come from
 * `formatFileSelection`, the same passage Quote in Message hands over.
 */
import { formatFileSelection, type FileSelectionReference } from './quoteSelection';

/** One comment of a review, ready to be written into the prompt. */
export interface ReviewPromptComment {
	/** Where it is and what it quotes. */
	selection: FileSelectionReference;
	/** Sentences that go between the quote and the comment (e.g. which file version). */
	notes?: readonly string[];
	/** The reviewer's comment. */
	body: string;
}

/**
 * Join `intro` paragraphs and one `## Comment N of M` section per comment.
 * Returns `''` when there are no comments.
 */
export function formatReviewPrompt(
	intro: readonly string[],
	comments: readonly ReviewPromptComment[]
): string {
	if (comments.length === 0) return '';
	const out: string[] = [];
	intro.forEach((paragraph, index) => {
		if (index > 0) out.push('');
		out.push(paragraph);
	});
	comments.forEach((comment, index) => {
		out.push('', `## Comment ${index + 1} of ${comments.length}`, '');
		out.push(formatFileSelection(comment.selection));
		for (const note of comment.notes ?? []) out.push('', note);
		out.push('', comment.body.trim());
	});
	return out.join('\n');
}

/** `1 comment` / `3 comments`. */
export function formatCommentCount(count: number): string {
	return count === 1 ? '1 comment' : `${count} comments`;
}
