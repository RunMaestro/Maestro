/**
 * mentionPatterns - single source of truth for detecting `@file` and `@agent`
 * mentions inside raw input text.
 *
 * Both the live AI-input highlight overlay (InputArea) and the rendered
 * transcript remark plugin (remarkMentionChips) tokenize with the SAME function
 * here, so the two surfaces can never disagree about what counts as a mention.
 * The dispatch scanner in `crossAgentContext` scans through the same
 * {@link scanMentionSpans} helper, so "what the picker inserts", "what dispatch
 * routes", and "what renders as a chip" all trace back to one definition.
 *
 * Disambiguation is by SHAPE, so a single `@` covers both kinds:
 *   - A path-like body (`@src/main`, `@notes.md`) is a file mention.
 *   - A bare word (`@codex`, `@review-bot`) is an agent/group mention, but only
 *     when it names a KNOWN agent/group (see `knownMentionNames` below); an
 *     unknown bare `@word` stays plain text, exactly like a bare `@todo` is not
 *     treated as a file.
 *
 * Kept dependency-free (shared/) so it imports cleanly from the main, renderer,
 * and cli tsconfigs.
 */

/**
 * The bare-word shape of a single-`@` agent/group mention: one `@` followed by
 * name characters (letters, digits, hyphen). Case-insensitive to match
 * `normalizeMentionName` output (which preserves case, e.g. `@Review-Bot`);
 * downstream matching folds to lowercase.
 *
 * NOTE: this pattern only describes the SHAPE. A `@word` becomes an actual agent
 * mention when it also names a known agent/group - the roster check lives with
 * the callers (`tokenizeMentions`, the dispatch resolver).
 */
export const AGENT_MENTION_PATTERN_SOURCE = '@[A-Za-z0-9-]+';

/** A bare agent/group name: the entire body is name characters (no `/`, `.`, `_`). */
const AGENT_NAME_RE = /^[A-Za-z0-9-]+$/;

/** A `\w`-equivalent char immediately before a mention marks a mid-word hit. */
const WORD_CHAR = /[A-Za-z0-9_]/;

/**
 * A single scan alternative covers both mention kinds: a leading `@` plus a
 * path-ish body. Classification (file vs. agent vs. plain text) happens per
 * match in {@link scanMentionSpans}. The body class is a superset of
 * {@link AGENT_MENTION_PATTERN_SOURCE} so a bare name is captured whole before
 * being classified.
 */
const MENTION_SCAN_SOURCE = '@[A-Za-z0-9_./-]+';

/** Sentence-ending punctuation trimmed off the tail of a match. */
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
 * Bare words (`@todo`) are never files.
 */
export function isFileMentionBody(path: string): boolean {
	return path.includes('/') || /\.[A-Za-z0-9]+$/.test(path);
}

/**
 * A single `@…` candidate found in raw text, already classified by SHAPE (but
 * NOT yet resolved against the agent roster). Slice bounds are against the
 * original text with any trailing sentence punctuation trimmed off, so
 * `text.slice(start, end) === value`.
 */
export interface MentionSpan {
	/** Index of the leading `@`. */
	start: number;
	/** Exclusive end index (one past the last kept character). */
	end: number;
	/** The matched text including the leading `@`, trailing punctuation trimmed. */
	value: string;
	/** `value` without the leading `@`. */
	body: string;
	/** Path-like (`@src/x`, `@a.md`) -> renders as a file mention. */
	isFile: boolean;
	/** Bare name (`@codex`) -> a candidate agent/group mention pending roster check. */
	isName: boolean;
}

/**
 * Scan `text` left-to-right for `@…` mentions and classify each by shape.
 *
 * Guarantees:
 * - Mid-word (`foo@bar`, `email@host`) and `@`-run (`@@x`) candidates are
 *   dropped, so the overlay, the picker, and the dispatch scanner agree on what
 *   counts as a standalone mention.
 * - Files always win the file/agent split: an agent name never contains `/` or
 *   `.`, so a path-like body can never be misread as an agent.
 */
export function scanMentionSpans(text: string): MentionSpan[] {
	const spans: MentionSpan[] = [];
	if (!text) return spans;

	// Fresh RegExp so the shared `lastIndex` never leaks between calls.
	const scanner = new RegExp(MENTION_SCAN_SOURCE, 'g');
	let match: RegExpExecArray | null;

	while ((match = scanner.exec(text)) !== null) {
		const start = match.index;
		const prevChar = start > 0 ? text[start - 1] : '';

		// Mid-word / `@`-run guard: a preceding word char or `@` glues this to
		// another token, so it is not a standalone mention.
		if (prevChar && (prevChar === '@' || WORD_CHAR.test(prevChar))) {
			continue;
		}

		// Trailing sentence punctuation is trimmed and spills into the next text run.
		const value = match[0].replace(TRAILING_PUNCTUATION, '');
		const body = value.slice(1);
		if (!body) continue;

		spans.push({
			start,
			end: start + value.length,
			value,
			body,
			isFile: isFileMentionBody(body),
			isName: AGENT_NAME_RE.test(body),
		});
	}

	return spans;
}

/**
 * Tokenize `text` into an ordered list of text / file / agent segments.
 *
 * @param knownMentionNames - lowercased set of mentionable agent/group names. A
 *   bare `@word` only becomes an `agent` segment when it is in this set;
 *   everything else stays plain text. Omit it (main/cli callers that only care
 *   about files) and no bare word is ever treated as an agent.
 *
 * Guarantees:
 * - Concatenating every segment's `value` reproduces `text` exactly.
 * - Path-like `@bodies` chip as files; bare `@words` chip as agents only when
 *   known; unknown bare words are left as plain text.
 */
export function tokenizeMentions(
	text: string,
	knownMentionNames?: ReadonlySet<string>
): MentionSegment[] {
	const segments: MentionSegment[] = [];
	if (!text) return segments;

	let cursor = 0;
	const flushTextTo = (end: number): void => {
		if (end > cursor) segments.push({ kind: 'text', value: text.slice(cursor, end) });
	};

	for (const span of scanMentionSpans(text)) {
		if (span.isFile) {
			flushTextTo(span.start);
			segments.push({
				kind: 'file',
				value: span.value,
				path: span.body,
				extension: fileExtension(span.body),
			});
			cursor = span.end;
			continue;
		}

		// Bare word -> agent, but only when it names a known agent/group. An
		// unknown `@word` is left as text (cursor not advanced), so it is swept
		// into the next text run.
		if (span.isName && knownMentionNames?.has(span.body.toLowerCase())) {
			flushTextTo(span.start);
			segments.push({ kind: 'agent', value: span.value, name: span.body });
			cursor = span.end;
		}
	}

	flushTextTo(text.length);
	return segments;
}
