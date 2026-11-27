/**
 * One stretch of untrusted text, made safe to show on one line.
 *
 * A user's message, a tool's output and a model's reply can all hold text that
 * must not act on a terminal or on a reader: an escape sequence, a bidirectional
 * override, a key. The digest and the context signals both quote such text, so
 * they share this one reading of "safe to show" instead of each keeping a copy.
 *
 * Pure: no Electron, React, IPC, clock or file access.
 */

import { truncateAtWordBoundary } from './formatters';
import { redactSecrets } from './redactSecrets';
import { stripControlCharacters } from './stringUtils';

/** Longest stretch of one message or output that is read at all. */
export const EXCERPT_SCAN_CHARS = 20_000;

/**
 * Text safe to show on one line: control characters removed (an escape or a
 * bidirectional override in a pasted line or a model's reply must not act on a
 * terminal or reorder what a reader sees), secret-shaped spans redacted, each
 * line break shown as ⏎, cut at a word. Spacing inside a line is NOT touched: a
 * path with two spaces or a quoted argument is the user's or the command's own.
 * Tool and agent text (`data`) also loses backticks, so nothing it holds can
 * close the code span a preview wraps it in.
 */
export function safeExcerpt(
	text: string,
	limit: number,
	data: boolean
): { text: string; truncated?: true } {
	let shown = redactSecrets(stripControlCharacters(text.slice(0, EXCERPT_SCAN_CHARS)).trim())
		.text.replace(/[ \t]*\n+\s*/g, ' ⏎ ')
		.trim();
	if (data) shown = shown.replace(/`/g, "'");
	return shown.length > limit
		? { text: truncateAtWordBoundary(shown, limit), truncated: true }
		: { text: shown };
}
