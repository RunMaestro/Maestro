/**
 * The Codex assistant-directive grammar, ported from OpenAI's
 * `codex-rs/tui/src/assistant_directives.rs`.
 *
 * Codex writes structured annotations straight into its assistant markdown, so
 * what arrives in a transcript is prose with machine-readable spans embedded in
 * it. A suggested next action looks like this on the wire:
 *
 *     - :codex-followup[Design the schema]{prompt="Design the canonical schema."}
 *
 * Maestro renders that verbatim today, which is the bug this module starts to
 * close. The emitting convention is fixed by the first-party Codex plugin
 * skills bundled on disk (`skills/documents/SKILL.md`), so the grammar is a
 * wire format: it is decided by the producer and Maestro only gets to read it.
 *
 * Nothing here renders. This is the parser alone - one directive at the head of
 * a string (`parseCodexDirective`) and every KNOWN directive in a whole string
 * with its offsets (`findCodexDirectives`).
 *
 * Two rules run through the whole file, and both exist to stop the parser from
 * eating text that was never a directive:
 *
 * 1. **A failed parse returns `null`, never a partial directive.** A caller
 *    replaces exactly `raw` and leaves the rest of the line alone, so a parser
 *    that guessed at a boundary would silently delete the user's prose.
 * 2. **A directive is single-line.** A newline inside a label, inside a quoted
 *    value, or where a separator is expected fails the parse. Without that, an
 *    unterminated quote in one message swallows every line after it.
 */

/** How a backslash behaves inside a quoted value (and inside a `[Label]`). */
export type CodexQuoteEscaping = 'literal' | 'backslash';

/**
 * How far the scanner may read before giving up on a candidate.
 *
 * The budget bounds a pathological input: `::a{k="` followed by a megabyte of
 * text is an unterminated quote, and without a cap the scanner reads the whole
 * megabyte to discover that. No real directive comes close to 8 KiB, so a
 * candidate that runs past it is malformed by definition.
 */
export const DEFAULT_CODEX_DIRECTIVE_BUDGET = 8192;

export interface ParseCodexDirectiveOptions {
	/**
	 * Quote-escaping mode. `'backslash'` (the default, matching what the
	 * bundled skills emit) decodes `\"` inside a double-quoted value to `"`
	 * and `\\` to `\`; every other `\x` pair is kept verbatim, so `\n` stays
	 * two characters rather than becoming a newline. `'literal'` gives a
	 * backslash no special meaning at all, so the first matching quote ends
	 * the value.
	 */
	escaping?: CodexQuoteEscaping;
	/**
	 * Characters the scanner may inspect before returning `null`. Defaults to
	 * {@link DEFAULT_CODEX_DIRECTIVE_BUDGET}. Counted in UTF-16 code units,
	 * which equals bytes for the ASCII a directive is built from.
	 */
	budget?: number;
}

export interface CodexDirective {
	/** Directive name, e.g. `codex-followup`. Never includes the colons. */
	name: string;
	/** The `[Label]` when one is present, already unescaped. */
	label?: string;
	/** Attribute values, already unquoted and unescaped. */
	attributes: Record<string, string>;
	/**
	 * The exact matched source text, from the first colon through the closing
	 * `}` and no further. A caller replaces exactly this and leaves the rest of
	 * the line intact.
	 */
	raw: string;
}

const COLON = 0x3a;
const LEFT_BRACKET = 0x5b;
const RIGHT_BRACKET = 0x5d;
const LEFT_BRACE = 0x7b;
const RIGHT_BRACE = 0x7d;
const EQUALS = 0x3d;
const BACKSLASH = 0x5c;
const DOUBLE_QUOTE = 0x22;
const SINGLE_QUOTE = 0x27;
const SPACE = 0x20;
const TAB = 0x09;
const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;

const MAX_COLONS = 3;

/** A name (and an attribute key) must start with an ASCII letter. */
function isNameStart(code: number): boolean {
	return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

/** Subsequent name characters add digits, `_` and `-`. */
function isNameChar(code: number): boolean {
	return isNameStart(code) || (code >= 0x30 && code <= 0x39) || code === 0x5f || code === 0x2d;
}

/** Only a space or a tab separates two attributes. A newline never does. */
function isAttributeSpace(code: number): boolean {
	return code === SPACE || code === TAB;
}

/** A bare (unquoted) value ends at the first of these. */
function isBareValueEnd(code: number): boolean {
	return (
		code === SPACE ||
		code === TAB ||
		code === RIGHT_BRACE ||
		code === LINE_FEED ||
		code === CARRIAGE_RETURN
	);
}

interface DelimitedRead {
	value: string;
	/** Index just past the closing delimiter. */
	next: number;
}

/**
 * Read a delimited run - a quoted value, or the body of a `[Label]` - ending at
 * the first unescaped `close` character.
 *
 * A label is read exactly like a quoted value whose delimiter happens to be
 * `]`, so one function serves both and the escaping mode cannot mean different
 * things in the two places. Only the closing delimiter and a backslash are
 * escapable; `\x` for anything else keeps both characters, which is what stops
 * a Windows path in a `cwd=` attribute from being mangled.
 *
 * Returns `null` on a newline or on running out of input (or budget), because
 * both mean the run was never terminated.
 */
function readDelimited(
	source: string,
	start: number,
	limit: number,
	close: number,
	escaping: CodexQuoteEscaping
): DelimitedRead | null {
	let value = '';
	let i = start;
	while (i < limit) {
		const code = source.charCodeAt(i);
		if (code === LINE_FEED || code === CARRIAGE_RETURN) return null;
		if (code === close) return { value, next: i + 1 };
		if (escaping === 'backslash' && code === BACKSLASH && i + 1 < limit) {
			const escaped = source.charCodeAt(i + 1);
			if (escaped === close || escaped === BACKSLASH) {
				value += source[i + 1];
				i += 2;
				continue;
			}
		}
		value += source[i];
		i += 1;
	}
	return null;
}

interface DirectiveAt {
	directive: CodexDirective;
	/** Index just past the closing `}`. */
	end: number;
}

/**
 * Parse one directive starting at `offset`.
 *
 * Taking an offset rather than a pre-sliced string is what keeps a whole-string
 * scan linear: `findCodexDirectives` tries a candidate at every colon, and
 * slicing the remainder at each one would copy the message once per colon.
 */
function parseDirectiveAt(
	source: string,
	offset: number,
	options: ParseCodexDirectiveOptions
): DirectiveAt | null {
	const escaping = options.escaping ?? 'backslash';
	const budget = options.budget ?? DEFAULT_CODEX_DIRECTIVE_BUDGET;
	if (!(budget > 0)) return null;

	// Everything below reads through `limit`, so the budget needs no further
	// checks: running past it is indistinguishable from running out of input,
	// and both mean the same thing here (no directive).
	const limit = Math.min(source.length, offset + budget);
	let i = offset;

	let colons = 0;
	while (i < limit && source.charCodeAt(i) === COLON) {
		colons += 1;
		i += 1;
	}
	// A run of four or more is prose (`::::`), not a directive. A run cut short
	// by the budget still fails below, since the next character is a colon and
	// a colon cannot start a name.
	if (colons === 0 || colons > MAX_COLONS) return null;

	const nameStart = i;
	if (i >= limit || !isNameStart(source.charCodeAt(i))) return null;
	i += 1;
	while (i < limit && isNameChar(source.charCodeAt(i))) i += 1;
	const name = source.slice(nameStart, i);

	let label: string | undefined;
	if (i < limit && source.charCodeAt(i) === LEFT_BRACKET) {
		const read = readDelimited(source, i + 1, limit, RIGHT_BRACKET, escaping);
		if (!read) return null;
		label = read.value;
		i = read.next;
	}

	// The brace has to be flush against the name (or the label). That single
	// rule is what keeps `::git-create-pr prose` out of the grammar.
	if (i >= limit || source.charCodeAt(i) !== LEFT_BRACE) return null;
	i += 1;

	const attributes: Record<string, string> = {};
	// After a value, the next character must be a separator or the closing
	// brace. Accepting `{a="x"b="y"}` would mean guessing where one attribute
	// ended, and a wrong guess eats text.
	let needsSeparator = false;

	for (;;) {
		let sawSeparator = false;
		while (i < limit && isAttributeSpace(source.charCodeAt(i))) {
			i += 1;
			sawSeparator = true;
		}
		if (i >= limit) return null;

		const code = source.charCodeAt(i);
		if (code === RIGHT_BRACE) {
			i += 1;
			break;
		}
		if (needsSeparator && !sawSeparator) return null;

		const keyStart = i;
		if (!isNameStart(code)) return null;
		i += 1;
		while (i < limit && isNameChar(source.charCodeAt(i))) i += 1;
		const key = source.slice(keyStart, i);

		// No whitespace is allowed around `=`: a space there would be
		// ambiguous against a bare value.
		if (i >= limit || source.charCodeAt(i) !== EQUALS) return null;
		i += 1;
		if (i >= limit) return null;

		let value: string;
		const valueCode = source.charCodeAt(i);
		if (valueCode === DOUBLE_QUOTE || valueCode === SINGLE_QUOTE) {
			const read = readDelimited(source, i + 1, limit, valueCode, escaping);
			if (!read) return null;
			value = read.value;
			i = read.next;
		} else {
			const valueStart = i;
			while (i < limit && !isBareValueEnd(source.charCodeAt(i))) i += 1;
			// An empty bare value (`{k=}` or `{k= }`) is malformed, not an
			// attribute set to the empty string. Write `k=""` for that.
			if (i === valueStart) return null;
			value = source.slice(valueStart, i);
		}

		// `hasOwnProperty`, not `in`: `constructor` and `toString` are legal
		// keys under this charset and would look like duplicates otherwise.
		// (`__proto__` cannot reach here - a key must start with a letter.)
		if (Object.prototype.hasOwnProperty.call(attributes, key)) return null;
		attributes[key] = value;
		needsSeparator = true;
	}

	const directive: CodexDirective = { name, attributes, raw: source.slice(offset, i) };
	if (label !== undefined) directive.label = label;
	return { directive, end: i };
}

/**
 * Parse ONE directive from the START of `source`, or return `null`.
 *
 * This is the grammar alone - it does not consult the allowlist, so it happily
 * parses `::before{color=red}`. Use {@link findCodexDirectives} for anything
 * that touches real assistant prose.
 */
export function parseCodexDirective(
	source: string,
	options: ParseCodexDirectiveOptions = {}
): CodexDirective | null {
	return parseDirectiveAt(source, 0, options)?.directive ?? null;
}
