export const EXTERNAL_TEXTAREA_MAX_HEIGHT = 112;
export const KEYSTROKE_TEXTAREA_MAX_HEIGHT = 176;

export function resizeTextareaToContent(textarea: HTMLTextAreaElement, maxHeight: number): void {
	textarea.style.height = 'auto';
	textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
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
