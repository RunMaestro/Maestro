/**
 * JSON values located in their source text.
 *
 * `JSON.parse` followed by `JSON.stringify` is not the identity on bytes: it
 * drops whitespace, re-escapes strings, moves integer-like keys to the front of
 * an object, and rounds any integer past 2^53. The token proxy may change a
 * request only inside the tool results it compresses, so it cannot round-trip
 * the body through a parsed value. It locates each value instead
 * ({@link parseJsonSpans}), decodes only the strings it reads, and writes new
 * text over the exact spans it replaces ({@link spliceSpans}). Every other
 * byte is the byte the client sent.
 *
 * The scanner checks structure (brackets, separators, literals, the number
 * grammar) and finds where each string ends. It does NOT validate the inside
 * of a string: a caller that reads one decodes it with {@link stringValue},
 * which does, and a caller that must know a text is valid JSON asks
 * `JSON.parse` first.
 *
 * Pure: no I/O, no state.
 */

/** A JSON value and where it sits in the text (`end` is exclusive). */
export type JsonSpan =
	| { kind: 'object'; start: number; end: number; members: JsonMember[] }
	| { kind: 'array'; start: number; end: number; items: JsonSpan[] }
	| { kind: 'string'; start: number; end: number }
	/** A number, `true`, `false` or `null`. */
	| { kind: 'scalar'; start: number; end: number };

export interface JsonMember {
	/** The decoded key. */
	key: string;
	/** The key's string literal, quotes included. */
	keyStart: number;
	keyEnd: number;
	value: JsonSpan;
}

/**
 * Nesting past this is refused (`null`), so a hostile or broken text cannot
 * overflow the stack. A model request nests a few dozen levels at most.
 */
export const MAX_JSON_SPAN_DEPTH = 256;

/** One JSON number or literal, anchored where the scan stands. */
const SCALAR_PATTERN = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y;

const QUOTE = 34;
const BACKSLASH = 92;

/** Raised and caught inside this module only: the text is not JSON this scanner reads. */
class JsonSpanSyntaxError extends Error {}

function skipWhitespace(text: string, from: number): number {
	let at = from;
	for (;;) {
		const code = text.charCodeAt(at);
		if (code === 32 || code === 10 || code === 13 || code === 9) at++;
		else return at;
	}
}

/** The index after the closing quote of the string literal that opens at `start`. */
function stringEnd(text: string, start: number): number {
	let at = start + 1;
	for (;;) {
		at = text.indexOf('"', at);
		if (at === -1) throw new JsonSpanSyntaxError();
		// A quote is the closing one when an even number of backslashes precede
		// it. The walk stops at the opening quote at the latest.
		let before = at - 1;
		while (text.charCodeAt(before) === BACKSLASH) before--;
		if ((at - 1 - before) % 2 === 0) return at + 1;
		at++;
	}
}

function decodeKey(text: string, start: number, end: number): string {
	const literal = text.slice(start, end);
	if (!literal.includes('\\')) return literal.slice(1, -1);
	try {
		return JSON.parse(literal) as string;
	} catch {
		throw new JsonSpanSyntaxError();
	}
}

function scanValue(text: string, from: number, depth: number): JsonSpan {
	if (depth > MAX_JSON_SPAN_DEPTH) throw new JsonSpanSyntaxError();
	const start = skipWhitespace(text, from);
	const first = text[start];

	if (first === '"') return { kind: 'string', start, end: stringEnd(text, start) };

	if (first === '{') {
		const members: JsonMember[] = [];
		let at = skipWhitespace(text, start + 1);
		if (text[at] === '}') return { kind: 'object', start, end: at + 1, members };
		for (;;) {
			at = skipWhitespace(text, at);
			if (text.charCodeAt(at) !== QUOTE) throw new JsonSpanSyntaxError();
			const keyStart = at;
			const keyEnd = stringEnd(text, at);
			at = skipWhitespace(text, keyEnd);
			if (text[at] !== ':') throw new JsonSpanSyntaxError();
			const value = scanValue(text, at + 1, depth + 1);
			members.push({ key: decodeKey(text, keyStart, keyEnd), keyStart, keyEnd, value });
			at = skipWhitespace(text, value.end);
			if (text[at] === '}') return { kind: 'object', start, end: at + 1, members };
			if (text[at] !== ',') throw new JsonSpanSyntaxError();
			at++;
		}
	}

	if (first === '[') {
		const items: JsonSpan[] = [];
		let at = skipWhitespace(text, start + 1);
		if (text[at] === ']') return { kind: 'array', start, end: at + 1, items };
		for (;;) {
			const item = scanValue(text, at, depth + 1);
			items.push(item);
			at = skipWhitespace(text, item.end);
			if (text[at] === ']') return { kind: 'array', start, end: at + 1, items };
			if (text[at] !== ',') throw new JsonSpanSyntaxError();
			at++;
		}
	}

	SCALAR_PATTERN.lastIndex = start;
	const scalar = SCALAR_PATTERN.exec(text);
	if (!scalar) throw new JsonSpanSyntaxError();
	return { kind: 'scalar', start, end: start + scalar[0].length };
}

/**
 * Locate every value of a JSON text, or `null` when the text is not one JSON
 * value this scanner can read (malformed, or nested past
 * {@link MAX_JSON_SPAN_DEPTH}).
 */
export function parseJsonSpans(text: string): JsonSpan | null {
	try {
		const root = scanValue(text, 0, 0);
		return skipWhitespace(text, root.end) === text.length ? root : null;
	} catch (error) {
		if (error instanceof JsonSpanSyntaxError) return null;
		throw error;
	}
}

/** The value of `key` in an object span. The last one wins, as in `JSON.parse`. */
export function memberOf(span: JsonSpan | undefined, key: string): JsonSpan | undefined {
	if (span?.kind !== 'object') return undefined;
	for (let i = span.members.length - 1; i >= 0; i--) {
		if (span.members[i].key === key) return span.members[i].value;
	}
	return undefined;
}

/** The decoded value of a string span; `undefined` for any other span or a bad literal. */
export function stringValue(text: string, span: JsonSpan | undefined): string | undefined {
	if (span?.kind !== 'string') return undefined;
	const literal = text.slice(span.start, span.end);
	// No escape and no control character: the content is the literal's inside.
	if (!/[\\\u0000-\u001f]/.test(literal)) return literal.slice(1, -1);
	try {
		return JSON.parse(literal) as string;
	} catch {
		return undefined;
	}
}

/** Whether a span is the literal `null`. */
export function isNullSpan(text: string, span: JsonSpan): boolean {
	return span.kind === 'scalar' && text.startsWith('null', span.start);
}

export interface SpanEdit {
	start: number;
	end: number;
	/** The text written over `[start, end)`. */
	text: string;
}

/**
 * Write each edit over its span and leave everything else as it was. Edits
 * must not overlap; they may come in any order.
 */
export function spliceSpans(text: string, edits: readonly SpanEdit[]): string {
	if (edits.length === 0) return text;
	const ordered = [...edits].sort((a, b) => a.start - b.start);
	const parts: string[] = [];
	let at = 0;
	for (const edit of ordered) {
		parts.push(text.slice(at, edit.start), edit.text);
		at = edit.end;
	}
	parts.push(text.slice(at));
	return parts.join('');
}
