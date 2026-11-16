/**
 * Paste classification shared by the composers. A text paste is never
 * rewritten: it lands verbatim through the native paste, because dictation
 * tools (Scribe's append_trailing_space) add a trailing space on purpose. Only
 * an image paste is intercepted, and each composer decides what to do with it.
 */

/** Whether a paste carries an image. */
export function clipboardHasImage(data: DataTransfer): boolean {
	return Array.from(data.items).some((item) => item.type.startsWith('image/'));
}
