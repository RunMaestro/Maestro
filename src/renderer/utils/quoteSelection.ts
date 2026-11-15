/**
 * Quoting transcript text into the composer (issue #1663).
 *
 * The user selects a passage of an agent reply, right-clicks, and picks
 * "Quote in Message". The passage lands in the composer as a Markdown block
 * quote with the caret on a fresh line beneath it, so the comment they type
 * next is visibly attached to that passage. Repeating it appends another
 * quote below whatever is already written, which is how one message pairs
 * several passages with a comment each.
 */

/**
 * Render text as a Markdown block quote: every line gets a `> ` prefix, blank
 * lines inside the selection become a bare `>` so the quote does not split in
 * two. Leading and trailing blank lines are dropped (a drag-select routinely
 * picks up the newline after a paragraph), and CRLF is normalized.
 */
export function formatMarkdownQuote(text: string): string {
	const lines = text.replace(/\r\n?/g, '\n').split('\n');
	while (lines.length > 0 && lines[0].trim() === '') lines.shift();
	while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
	return lines.map((line) => (line.trim() === '' ? '>' : `> ${line.trimEnd()}`)).join('\n');
}

/**
 * Append a quote of `selection` to an existing draft, keeping what the user
 * already typed. The quote is separated from prior text by one blank line
 * (without that, Markdown folds the quote into the previous paragraph), and is
 * followed by a blank line so the text typed after it is NOT absorbed into the
 * quote by lazy continuation. Returns the draft unchanged for an empty
 * selection.
 */
export function appendQuoteToDraft(draft: string, selection: string): string {
	const quote = formatMarkdownQuote(selection);
	if (!quote) return draft;
	const trimmed = draft.replace(/\s+$/, '');
	const prefix = trimmed ? `${trimmed}\n\n` : '';
	return `${prefix}${quote}\n\n`;
}

/**
 * Append a Markdown block (a fenced passage, a Design Mode element) to a draft
 * as-is, with the same spacing rules as {@link appendQuoteToDraft}: one blank
 * line before it, one after it so the caret lands on a fresh line. Returns the
 * draft unchanged for a blank block.
 */
export function appendBlockToDraft(draft: string, block: string): string {
	const body = block.replace(/\r\n?/g, '\n').replace(/^\n+|\s+$/g, '');
	if (!body) return draft;
	const trimmed = draft.replace(/\s+$/, '');
	const prefix = trimmed ? `${trimmed}\n\n` : '';
	return `${prefix}${body}\n\n`;
}

/**
 * A Markdown code fence that `body` cannot close early: one backtick longer
 * than the longest backtick run inside it, and never shorter than three.
 */
export function markdownFenceFor(body: string): string {
	const longestRun = Math.max(0, ...(body.match(/`+/g) ?? []).map((run) => run.length));
	return '`'.repeat(Math.max(3, longestRun + 1));
}

/** A passage of a file, as the File Preview editor hands it to an agent. */
export interface FileSelectionReference {
	/** Project-relative path when the file sits under the agent's folder, else absolute. */
	path: string;
	/** 1-based, inclusive. */
	startLine: number;
	endLine: number;
	text: string;
	/** Code fence info string (`ts`, `python`). Blank or `text` writes a bare fence. */
	language?: string;
}

/** `src/app.ts:12` for one line, `src/app.ts:12-30` for a span. */
export function formatFileLineReference(
	path: string,
	startLine: number,
	endLine: number = startLine
): string {
	return endLine > startLine ? `${path}:${startLine}-${endLine}` : `${path}:${startLine}`;
}

/**
 * A file passage as Markdown an agent can act on: the `path:lines` reference
 * on its own line, then the text in a code fence. The fence is one backtick
 * longer than any backtick run inside the text, so a passage that itself
 * contains a fenced block cannot close it early.
 */
export function formatFileSelection(selection: FileSelectionReference): string {
	const body = selection.text.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
	const fence = markdownFenceFor(body);
	const info = selection.language && selection.language !== 'text' ? selection.language : '';
	const ref = formatFileLineReference(selection.path, selection.startLine, selection.endLine);
	return `\`${ref}\`\n${fence}${info}\n${body}\n${fence}`;
}
