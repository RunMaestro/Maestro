/**
 * mentionPatterns - single source of truth for detecting `@file` and `@@agent`
 * mentions inside raw input text.
 *
 * Both the live AI-input highlight overlay (InputArea) and the rendered
 * transcript remark plugin (remarkMentionChips) tokenize with the SAME function
 * here, so the two surfaces can never disagree about what counts as a mention.
 * The `@@agent` pattern is also the source `crossAgentContext`'s dispatch
 * scanner imports, so "what the picker inserts", "what dispatch routes", and
 * "what renders as a chip" all trace back to one definition.
 *
 * Kept dependency-free (shared/) so it imports cleanly from the main, renderer,
 * and cli tsconfigs.
 */

/**
 * A mention is exactly two `@` followed by one or more name characters.
 * Case-insensitive class to match `normalizeMentionName` output (which preserves
 * case, e.g. `@@Review-Bot`); downstream matching folds to lowercase.
 */
export const AGENT_MENTION_PATTERN_SOURCE = '@@[A-Za-z0-9-]+';

/** A `\w`-equivalent char immediately before a mention marks a mid-word hit. */
const WORD_CHAR = /[A-Za-z0-9_]/;

/**
 * Left-to-right scanner. The `@@agent` alternative is tried first so a `@@name`
 * is never misread as a `@file` beginning with a stray `@`. The single-`@`
 * alternative captures a path-ish body (letters/digits plus `_ . / -`) which
 * must still clear {@link isFileMentionBody} before it is treated as a file.
 */
const MENTION_SCAN_SOURCE = `${AGENT_MENTION_PATTERN_SOURCE}|@[A-Za-z0-9_./-]+`;

/** Sentence-ending punctuation trimmed off the tail of a `@file` match. */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}>'"]+$/;

/**
 * One tokenized run of the input. Segments concatenate (via their `value`)
 * back to the exact original string, so the overlay can render them positionally
 * without drifting from the underlying textarea text.
 */
export type MentionSegment =
	| { kind: 'text'; value: string }
	| { kind: 'file'; value: string; path: string; extension: string }
	| { kind: 'agent'; value: string; name: string };

/** Extract the lowercase extension (without the dot) from a path, or ''. */
function fileExtension(path: string): string {
	const base = path.slice(path.lastIndexOf('/') + 1);
	const dot = base.lastIndexOf('.');
	return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/**
 * A `@file` body only chips when it actually looks like a path: it either
 * contains a slash (`@src/main`) or ends in a dotted extension (`@notes.md`).
 * Bare words (`@todo`) stay plain text.
 */
export function isFileMentionBody(path: string): boolean {
	return path.includes('/') || /\.[A-Za-z0-9]+$/.test(path);
}

/**
 * Tokenize `text` into an ordered list of text / file / agent segments.
 *
 * Guarantees:
 * - Concatenating every segment's `value` reproduces `text` exactly.
 * - Mid-word (`foo@@bar`, `a@x/y`) and `@@@`-run candidates are left as plain
 *   text, matching {@link parseAgentMentions} so the overlay agrees with the
 *   picker and the dispatch scanner.
 */
export function tokenizeMentions(text: string): MentionSegment[] {
	const segments: MentionSegment[] = [];
	if (!text) return segments;

	// Fresh RegExp so the shared `lastIndex` never leaks between calls.
	const scanner = new RegExp(MENTION_SCAN_SOURCE, 'g');
	let cursor = 0;
	let match: RegExpExecArray | null;

	const flushTextTo = (end: number): void => {
		if (end > cursor) segments.push({ kind: 'text', value: text.slice(cursor, end) });
	};

	while ((match = scanner.exec(text)) !== null) {
		const raw = match[0];
		const start = match.index;
		const prevChar = start > 0 ? text[start - 1] : '';

		// Mid-word / `@`-run guard: a preceding word char or `@` glues this to
		// another token, so it is not a standalone mention. Leave it as text;
		// it is swept into the next text run because `cursor` is not advanced.
		if (prevChar && (prevChar === '@' || WORD_CHAR.test(prevChar))) {
			continue;
		}

		if (raw.startsWith('@@')) {
			flushTextTo(start);
			segments.push({ kind: 'agent', value: raw, name: raw.slice(2) });
			cursor = start + raw.length;
			continue;
		}

		// Single-`@` file candidate. Trailing sentence punctuation is trimmed and
		// spills back into the following text run.
		const trimmed = raw.replace(TRAILING_PUNCTUATION, '');
		const path = trimmed.slice(1);
		if (!isFileMentionBody(path)) {
			continue; // not path-like -> plain text
		}
		flushTextTo(start);
		segments.push({ kind: 'file', value: trimmed, path, extension: fileExtension(path) });
		cursor = start + trimmed.length;
	}

	flushTextTo(text.length);
	return segments;
}
