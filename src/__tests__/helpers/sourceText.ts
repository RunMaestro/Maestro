/**
 * Read a repository file (source, prompt, doc) as text with LF line endings.
 *
 * The Windows CI leg checks the tree out with CRLF endings, so a test that
 * reads a file and matches `\n` (an `indexOf('\n\t}')`, a regex anchored on a
 * newline, a `split('\n')` length) finds nothing there and fails while the
 * Linux and macOS legs pass. Read through this instead of a bare
 * `readFileSync(file, 'utf8')` whenever the test looks at line structure.
 */

import { readFileSync } from 'node:fs';

/** `text` with every CRLF (and any lone CR) turned into LF. */
export function toLf(text: string): string {
	return text.replace(/\r\n?/g, '\n');
}

/** The UTF-8 contents of `file`, with LF line endings on every OS. */
export function readTextLf(file: string): string {
	return toLf(readFileSync(file, 'utf8'));
}
