/**
 * Replacing a selection in a plain string: the one edit every "put this text
 * where the caret is" feature performs (tab insert, paste rewrite, dictation).
 *
 * Kept free of DOM and editor types so a textarea host, a CodeMirror host and a
 * test can all share it.
 */

export interface TextEditResult {
	content: string;
	cursorPosition: number;
}

/** Replace [start, end) of `content` with `insertText`, caret after the insert. */
export function insertTextAtSelection(
	content: string,
	start: number,
	end: number,
	insertText: string
): TextEditResult {
	return {
		content: content.substring(0, start) + insertText + content.substring(end),
		cursorPosition: start + insertText.length,
	};
}
