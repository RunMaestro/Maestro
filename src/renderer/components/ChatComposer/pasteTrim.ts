/**
 * Paste trimming shared by the AI composer and the Group Chat composer: a
 * plain-text paste loses its surrounding whitespace, so copying a line out of
 * a terminal or an editor does not drag a trailing newline into the draft.
 */

import type React from 'react';

/** Whether a paste carries an image. An image paste is never trimmed. */
export function clipboardHasImage(data: DataTransfer): boolean {
	return Array.from(data.items).some((item) => item.type.startsWith('image/'));
}

/**
 * Trim a plain-text paste into a textarea. When trimming changes the text, the
 * native paste is cancelled, the trimmed text replaces the selection in
 * `currentValue`, `setValue` receives the result (the caller persists it as it
 * would any edit), and the caret lands after the pasted text. Returns true in
 * that case; false leaves the native paste to run as is.
 *
 * Call it only for a paste without an image (`clipboardHasImage`).
 */
export function applyTrimmedTextPaste(
	e: React.ClipboardEvent,
	currentValue: string,
	setValue: (next: string) => void
): boolean {
	const text = e.clipboardData.getData('text/plain');
	if (!text) return false;
	const trimmedText = text.trim();
	if (trimmedText === text) return false;
	e.preventDefault();
	const target = e.target as HTMLTextAreaElement;
	const start = target.selectionStart ?? 0;
	const end = target.selectionEnd ?? 0;
	setValue(currentValue.slice(0, start) + trimmedText + currentValue.slice(end));
	requestAnimationFrame(() => {
		target.selectionStart = target.selectionEnd = start + trimmedText.length;
	});
	return true;
}
