const WINDOWS_RESERVED_FILENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const MAX_FILENAME_LENGTH = 255;
const INVALID_WINDOWS_FILENAME_CHARACTER = /[<>:"|?*\x00-\x1f\x7f]/g;

/**
 * Produces a cross-platform filename from untrusted display text.
 *
 * Separators become dashes to preserve readable word boundaries. Other Windows-invalid
 * characters become the Unicode replacement character so callers do not silently merge
 * distinct filenames. The result is a filename only, never a path.
 */
export function sanitizeFilename(filename: string): string {
	const sanitized = Array.from(
		filename
			.replace(/[\\/]/g, '-')
			.replace(/\.\./g, '')
			.replace(INVALID_WINDOWS_FILENAME_CHARACTER, '�')
			.trim()
			.replace(/^\.+/, '')
			.replace(/[. ]+$/, '')
	)
		.slice(0, MAX_FILENAME_LENGTH)
		.join('');

	return sanitized && !WINDOWS_RESERVED_FILENAME.test(sanitized) ? sanitized : 'document';
}
