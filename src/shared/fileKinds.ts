/**
 * What kind of thing a file path names, by extension alone.
 *
 * Extension-only on purpose: the surfaces that ask are menus and command
 * builders that hold a path and nothing else. A caller that also has the text
 * in hand (the File Preview, the token proxy's read analyzer) adds the content
 * sniff, `isBinaryContent`, on top of this.
 *
 * Lives in `shared/` because the same questions are asked from the Files panel,
 * the command palette, and the preview toolbar, and a second copy of the
 * extension list is how those three start disagreeing about the same file.
 */

import { isImageFile } from './gitUtils';
import { isMediaFile } from './mediaTypes';
import { isParquetFile } from './parquet/preview';

/** Known binary file extensions (module-scope Set for O(1) lookup) */
const BINARY_EXTENSIONS = new Set([
	// macOS/iOS specific
	'icns',
	'car',
	'actool',
	// Design files
	'psd',
	'ai',
	'sketch',
	'fig',
	'xd',
	// Compiled/object files
	'o',
	'a',
	'so',
	'dylib',
	'dll',
	'class',
	'pyc',
	'pyo',
	'wasm',
	// Database files
	'db',
	'sqlite',
	'sqlite3',
	// Fonts
	'ttf',
	'otf',
	'woff',
	'woff2',
	'eot',
	// Archives
	'zip',
	'tar',
	'gz',
	'7z',
	'rar',
	'bz2',
	'xz',
	'tgz',
	// Other binary
	'exe',
	'bin',
	'dat',
	'pak',
]);

/** Check if file extension indicates a known binary format */
export const isBinaryExtension = (filename: string): boolean => {
	const ext = filename.split('.').pop()?.toLowerCase();
	return BINARY_EXTENSIONS.has(ext || '');
};

/** How much of a text the binary sniff reads. A NUL byte is searched for past it. */
const BINARY_SNIFF_CHARS = 8192;

/**
 * Check if text content appears to be binary: a NUL anywhere, or more than 10%
 * non-printable characters (C0 controls other than tab, LF, VT, FF and CR, plus
 * DEL and the C1 controls) in the first {@link BINARY_SNIFF_CHARS}. The companion of
 * {@link isBinaryExtension} for a caller that holds the text itself.
 */
export const isBinaryContent = (content: string): boolean => {
	if (content.includes('\0')) return true;

	const sample = content.slice(0, BINARY_SNIFF_CHARS);
	if (sample.length === 0) return false;

	let nonPrintableCount = 0;
	for (let i = 0; i < sample.length; i++) {
		const code = sample.charCodeAt(i);
		if (code < 9 || (code > 13 && code < 32) || (code >= 127 && code < 160)) {
			nonPrintableCount++;
		}
	}

	return nonPrintableCount / sample.length > 0.1;
};

/**
 * Can a voice session be held ABOUT this file?
 *
 * Only where there is text to read. An image, a video, or a compiled binary
 * gives the agent nothing to discuss, so the three "Talk with Document"
 * entry points (preview toolbar, Files panel menu, command palette) all hide
 * rather than opening a conversation whose first act is a failed read.
 *
 * SVG counts as an image here, matching what the preview does with it: the
 * user is looking at a picture, not at markup.
 *
 * Parquet is asked about separately rather than through `isBinaryExtension`:
 * the extensions are deliberately absent from that set so the columnar viewer
 * keeps its grid (see `shared/parquet/preview.ts`), but a parquet file still
 * reaches the renderer as a marker string rather than as text, so there is
 * nothing for an agent to read out of it.
 */
export function isTalkableDocumentPath(pathOrName: string): boolean {
	if (!pathOrName) return false;
	return (
		!isImageFile(pathOrName) &&
		!isMediaFile(pathOrName) &&
		!isParquetFile(pathOrName) &&
		!isBinaryExtension(pathOrName)
	);
}
