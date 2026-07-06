export const EXTERNAL_TEXTAREA_MAX_HEIGHT = 112;
export const KEYSTROKE_TEXTAREA_MAX_HEIGHT = 176;

export function resizeTextareaToContent(textarea: HTMLTextAreaElement, maxHeight: number): void {
	textarea.style.height = 'auto';
	textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
}

/**
 * Keep the caret visible after a keystroke resize. resizeTextareaToContent sets
 * height:'auto' first, which resets the textarea's scrollTop, so once the box hits
 * its max height and scrolls internally the freshly typed text at the end would
 * otherwise fall out of view. Snap the scroll to the bottom when the caret sits at
 * the end of the content (the continuous-typing case); leave it untouched for
 * mid-text edits so the viewport does not jump.
 */
export function scrollTextareaToCaretEnd(textarea: HTMLTextAreaElement): void {
	if (textarea.selectionEnd >= textarea.value.length) {
		textarea.scrollTop = textarea.scrollHeight;
	}
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
