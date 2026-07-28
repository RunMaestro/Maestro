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
 * otherwise fall out of view. Snap the scroll to the bottom only in the guaranteed
 * post-insertion case: the caret parked at the very END of the value. There the
 * caret is on the last visual row by definition, so scrollHeight always reveals it.
 *
 * We deliberately do NOT snap for a caret merely sitting on the final LOGICAL line
 * (e.g. before trailing characters). A long final logical line can soft-wrap across
 * several visual rows, so a caret near its start belongs to an EARLIER row; snapping
 * to scrollHeight would scroll that row out of view. Those mid-line edits fall back
 * to the scrollTop resizeTextareaToContent already restored, which keeps the
 * pre-edit viewport intact. See issue #1169.
 */
export function scrollTextareaToCaretEnd(textarea: HTMLTextAreaElement): void {
	if (textarea.selectionEnd === textarea.value.length) {
		textarea.scrollTop = textarea.scrollHeight;
	}
}
