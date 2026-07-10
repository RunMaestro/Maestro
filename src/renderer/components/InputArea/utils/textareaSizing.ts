export const EXTERNAL_TEXTAREA_MAX_HEIGHT = 112;
export const KEYSTROKE_TEXTAREA_MAX_HEIGHT = 176;

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

export function shouldScrollTextareaToEnd(
	selectionEnd: number,
	previousValueLength: number,
	nextValueLength: number
): boolean {
	const caretWasAtEnd = selectionEnd >= previousValueLength;
	const bulkInsert = nextValueLength - previousValueLength > 1;
	return caretWasAtEnd || bulkInsert;
}
