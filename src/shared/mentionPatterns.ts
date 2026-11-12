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
 * Disambiguation is by SHAPE, with the agent/group roster as the tie-breaker:
 *   - A body that names a KNOWN agent/group always wins as an agent mention,
 *     even when its shape is path-like (an agent named `RunMaestro.ai` must not
 *     be misread as the file `RunMaestro.ai`). The roster is authoritative.
 *   - Otherwise, a path-like body (`@src/main`, `@notes.md`) is a file mention.
 *   - Otherwise, a bare word (`@codex`, `@review-bot`) is an agent/group mention,
 *     but only when it names a KNOWN agent/group (see `knownMentionNames` below);
 *     an unknown bare `@word` stays plain text, exactly like a bare `@todo` is not
 *     treated as a file.
 *
 * Kept dependency-free (shared/) so it imports cleanly from the main, renderer,
 * and cli tsconfigs.
 */

/**
 * Emoji aren't a single code point: a base pictograph can be followed by a
 * zero-width joiner (U+200D, e.g. 🧑‍💻) or the emoji variation selector
 * (U+FE0F). Both count as name characters so an agent named with an emoji
 * (`☁ Substrate` -> the `@☁-Substrate` token) tokenizes whole rather than
 * dying at the first non-ASCII byte.
 */
const EMOJI_JOIN = '\\u200d\\ufe0f';

/**
 * A name character: any script's letter/number/combining-mark, any emoji
 * pictograph (plus the joiners above), and the hyphen `normalizeMentionName`
 * produces from spaces. Unicode-aware on purpose - agent names can be emoji,
 * accented, or CJK (`@☁-Substrate`, `@café-Bot`, `@日本語-agent`), not just
 * `[A-Za-z0-9-]`. Keep `-` LAST so it stays a literal, not a range bound.
 */
const NAME_CHAR = `\\p{L}\\p{N}\\p{M}\\p{Extended_Pictographic}${EMOJI_JOIN}-`;

/**
 * A mention-body character: {@link NAME_CHAR} plus the path punctuation
 * (`_ . /`) a file body carries, so `@src/app.ts` is captured whole before the
 * file/agent split classifies it. `-` stays LAST (literal, not a range).
 */
const BODY_CHAR = `\\p{L}\\p{N}\\p{M}\\p{Extended_Pictographic}${EMOJI_JOIN}_./-`;

/**
 * The bare-word shape of a single-`@` agent/group mention: one `@` followed by
 * name characters. Case-insensitive to match `normalizeMentionName` output
 * (which preserves case, e.g. `@Review-Bot`); downstream matching folds to
 * lowercase.
 *
 * REQUIRES the `u` flag when compiled (it uses `\p{...}` Unicode property
 * escapes). NOTE: this pattern only describes the SHAPE. A `@word` becomes an
 * actual agent mention when it also names a known agent/group - the roster
 * check lives with the callers (`tokenizeMentions`, the dispatch resolver).
 */
export const AGENT_MENTION_PATTERN_SOURCE = `@[${NAME_CHAR}]+`;

// The three regexes below include the emoji joiners (ZWJ/VS16) as INDIVIDUALLY
// allowed body code points; the surrounding `+` quantifier reassembles a
// multi-code-point emoji. `no-misleading-character-class` assumes a class
// element is meant to be one grapheme and flags the joiners - not our intent
// here (a code-point allow-set), so it's disabled per site.
/** A bare agent/group name: the entire body is name characters (no `/`, `.`, `_`). */
// eslint-disable-next-line no-misleading-character-class
const AGENT_NAME_RE = new RegExp(`^[${NAME_CHAR}]+$`, 'u');

/**
 * Quote characters that, sitting immediately before an `@`, deliberately escape
 * the mention: `"@codex"`, `'@codex'`, and `` `@codex` `` are the user opting OUT
 * of a lookup (quote/backtick the name so it stays literal text, not a chip or a
 * dispatch target). Straight and curly single/double quotes plus the backtick.
 */
const MENTION_QUOTE_ESCAPE = `"'\`‘’“”`;

/**
 * A char that, sitting immediately before an `@`, glues the `@…` to a preceding
 * token so it is NOT a standalone mention. Covers name chars (any script /
 * emoji), another `@` (`@@x`), the path/URL separators a mention body can itself
 * contain (`_ . / -`), and the {@link MENTION_QUOTE_ESCAPE} quotes a user wraps a
 * name in to escape it. This is what keeps `foo@bar`, `email@host`, a URL segment
 * like `https://host/@codex`, and a quoted `"@codex"` from being read as a
 * mention - a mention must begin at a real boundary (start of text, whitespace,
 * or non-path punctuation). `@` leads so the trailing `-` of BODY_CHAR stays a
 * literal.
 */
// eslint-disable-next-line no-misleading-character-class
const MENTION_PREV_BLOCK = new RegExp(`[@${MENTION_QUOTE_ESCAPE}${BODY_CHAR}]`, 'u');

/**
 * The quote characters that, placed immediately AFTER the `@`, delimit a mention
 * body so it may contain spaces: `@"Meetings/MEET-07-13 - Notes.md"`. Whitespace
 * is not a {@link BODY_CHAR}, so an unquoted mention still ends at the first
 * space - quoting is the ONLY way to carry a path with spaces, and it is what
 * every insertion site emits (see {@link formatFileMention}).
 *
 * Note the position: a quote BEFORE the `@` escapes the mention
 * ({@link MENTION_QUOTE_ESCAPE}, `"@codex"` stays literal text); a quote AFTER
 * it delimits the body. Different characters, different sides, no ambiguity.
 */
export type MentionQuote = '"' | "'";

/**
 * The quoted-body alternatives. A newline never appears inside a mention, so it
 * terminates an unclosed quote rather than swallowing the rest of the message.
 */
const QUOTED_MENTION_SOURCE = `@"[^"\\n]+"|@'[^'\\n]+'`;

/**
 * The scan alternatives cover both mention kinds: a leading `@` plus either a
 * quoted body or a path-ish bare body. Quoted comes FIRST so `@"a b.md"` is
 * captured whole instead of the bare alternative stopping at the space.
 * Classification (file vs. agent vs. plain text) happens per match in
 * {@link scanMentionSpans}. The bare body class is a superset of
 * {@link AGENT_MENTION_PATTERN_SOURCE} so a bare name is captured whole before
 * being classified. Compiled with the `u` flag (see {@link scanMentionSpans}).
 */
const MENTION_SCAN_SOURCE = `${QUOTED_MENTION_SOURCE}|@[${BODY_CHAR}]+`;

/** Sentence-ending punctuation trimmed off the tail of a BARE match. */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}>'"]+$/;

/**
 * The opening mention quote of `text` (a mention body, or the picker's raw
 * filter - i.e. whatever follows the `@`), or null when it is unquoted.
 */
export function mentionQuoteChar(text: string): MentionQuote | null {
	const first = text[0];
	return first === '"' || first === "'" ? first : null;
}

/**
 * Build the raw `@…` token for a file/directory path, quoting it when the path
 * carries whitespace. Single source of truth for every insertion site (the `@`
 * picker, the Files-panel drag-drop, the prompt composer), so what gets inserted
 * always scans back out as one mention.
 */
export function formatFileMention(path: string): string {
	if (!/\s/.test(path)) return `@${path}`;
	// Prefer `"`; fall back to `'` when the filename itself carries a double
	// quote. A path holding BOTH quote characters cannot be delimited, so it goes
	// in bare rather than as a token that scans back as something else.
	const quote: MentionQuote = path.includes('"') ? "'" : '"';
	if (path.includes(quote)) return `@${path}`;
	return `@${quote}${path}${quote}`;
}

/**
 * Strip the mention quoting off a raw picker filter (or mention body) to get the
 * text to SEARCH with: `"Meetings/MEET - Notes` -> `Meetings/MEET - Notes`. The
 * filter is stored raw (quote included) because acceptance splices over it by
 * length; only the fuzzy-search callers want it bare.
 */
export function stripMentionQuotes(text: string): string {
	const quote = mentionQuoteChar(text);
	if (!quote) return text;
	const inner = text.slice(1);
	return inner.endsWith(quote) ? inner.slice(0, -1) : inner;
}

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
	/** The matched text including the leading `@` (and both quotes when quoted). */
	value: string;
	/** The mention body: `value` without the leading `@` and without any quotes. */
	body: string;
	/** Path-like (`@src/x`, `@a.md`) -> renders as a file mention. */
	isFile: boolean;
	/** Bare name (`@codex`) -> a candidate agent/group mention pending roster check. */
	isName: boolean;
}

/**
 * Scan `text` left-to-right for `@…` mentions and classify each by shape.
 *
 * @param knownMentionNames - lowercased set of mentionable agent/group names. A
 *   body that matches one is classified as an agent (`isName`, not `isFile`)
 *   regardless of its shape, so an agent whose name carries a dot or slash
 *   (`@RunMaestro.ai`) isn't misread as a file. Omit it and classification is
 *   purely by shape (files win), which is what file-only callers want.
 *
 * Guarantees:
 * - Mid-word (`foo@bar`, `email@host`) and `@`-run (`@@x`) candidates are
 *   dropped, so the overlay, the picker, and the dispatch scanner agree on what
 *   counts as a standalone mention.
 * - The roster wins the file/agent split: a body that names a known agent/group
 *   is an agent mention even when path-like. Absent the roster, a path-like body
 *   (`/` or a dotted extension) is a file.
 */
export function scanMentionSpans(
	text: string,
	knownMentionNames?: ReadonlySet<string>
): MentionSpan[] {
	const spans: MentionSpan[] = [];
	if (!text) return spans;

	// Fresh RegExp so the shared `lastIndex` never leaks between calls. The `u`
	// flag is required for the `\p{...}` classes and makes the scan iterate by
	// code point, so astral emoji in a name are matched whole.
	// eslint-disable-next-line no-misleading-character-class
	const scanner = new RegExp(MENTION_SCAN_SOURCE, 'gu');
	let match: RegExpExecArray | null;

	while ((match = scanner.exec(text)) !== null) {
		const start = match.index;
		const prevChar = start > 0 ? text[start - 1] : '';

		// Boundary guard: a preceding word/path char or `@` glues this to another
		// token (mid-word `foo@bar`, a URL segment `host/@codex`, an `@@x` run), so
		// it is not a standalone mention.
		if (prevChar && MENTION_PREV_BLOCK.test(prevChar)) {
			continue;
		}

		// A quoted mention (`@"a b.md"`) is delimited, so its bounds are exact: the
		// closing quote is part of the token and nothing is trimmed off it (the
		// trailing-punctuation trim would eat that very quote). The body is the text
		// BETWEEN the quotes, so `path`/roster lookups never see the delimiters.
		const quote = mentionQuoteChar(match[0].slice(1));
		const value = quote ? match[0] : match[0].replace(TRAILING_PUNCTUATION, '');
		const body = quote ? value.slice(2, -1) : value.slice(1);
		if (!body) continue;

		// The roster is authoritative: a body that names a known agent/group is an
		// agent mention even when its shape is path-like, so an agent named with a
		// dot or slash (`@RunMaestro.ai`) isn't dropped as a file.
		const isKnownName = knownMentionNames?.has(body.toLowerCase()) ?? false;

		spans.push({
			start,
			end: start + value.length,
			value,
			body,
			isFile: !isKnownName && isFileMentionBody(body),
			isName: isKnownName || AGENT_NAME_RE.test(body),
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

	for (const span of scanMentionSpans(text, knownMentionNames)) {
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
