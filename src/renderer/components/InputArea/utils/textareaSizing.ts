export const TEXTAREA_MAX_HEIGHT = 176;

export function resizeTextareaToContent(textarea: HTMLTextAreaElement, maxHeight: number): void {
	// Setting height to 'auto' momentarily removes the overflow and collapses the
	// internal scroll to the top. Capture and restore scrollTop so resizing a
	// scrolled textarea never yanks the view (and the caret) out of sight. Callers
	// that want the caret pinned to the bottom re-scroll after this returns.
	const previousScrollTop = textarea.scrollTop;
	textarea.style.height = 'auto';
	textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
	textarea.scrollTop = previousScrollTop;
}

/**
 * Keep the caret visible after a keystroke resize. resizeTextareaToContent sets
 * height:'auto' first, which resets the textarea's scrollTop, so once the box hits
 * its max height and scrolls internally the freshly typed text at the end would
 * otherwise fall out of view. Snap the scroll to the bottom whenever the caret sits
 * anywhere in the FINAL LOGICAL LINE of the value (the continuous-typing case, plus
 * typing before trailing characters on that line such as an inserted mention or
 * trailing whitespace); leave it untouched for edits on earlier lines so the
 * viewport does not jump. See issue #1169.
 */
export function scrollTextareaToCaretEnd(textarea: HTMLTextAreaElement): void {
	// A value with no newline is entirely one line: lastIndexOf returns -1, so any
	// caret position qualifies.
	if (textarea.selectionEnd > textarea.value.lastIndexOf('\n')) {
		textarea.scrollTop = textarea.scrollHeight;
	}
}
