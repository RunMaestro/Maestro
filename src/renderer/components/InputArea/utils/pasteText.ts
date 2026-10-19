import type React from 'react';

/**
 * Paste plain text at the caret with its surrounding whitespace trimmed, when
 * trimming changes it (a copied line drags its newline along). Returns true
 * when it pasted; false leaves the paste to the textarea.
 *
 * Shared by every AI composer (the app window's and a tab window's).
 */
export function pasteTrimmedText(
	e: React.ClipboardEvent,
	setInputValue: (value: string) => void
): boolean {
	const text = e.clipboardData.getData('text/plain');
	if (!text) return false;
	const trimmedText = text.trim();
	if (trimmedText === text) return false;
	e.preventDefault();
	const target = e.target as HTMLTextAreaElement;
	const start = target.selectionStart ?? 0;
	const end = target.selectionEnd ?? 0;
	const currentValue = target.value;
	setInputValue(currentValue.slice(0, start) + trimmedText + currentValue.slice(end));
	requestAnimationFrame(() => {
		target.selectionStart = target.selectionEnd = start + trimmedText.length;
	});
	return true;
}
