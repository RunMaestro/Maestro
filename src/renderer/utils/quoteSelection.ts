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
