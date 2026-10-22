/**
 * The token proxy's heuristic compressors: pure functions from a tool result's
 * text to a shorter text.
 *
 * Each one is deterministic. The same input gives the same output in every
 * process and on every machine, with no clock, no randomness and no model, so
 * a tool result compresses to the same bytes on every turn and the provider's
 * cached prefix survives.
 *
 * Which compressor a text gets is decided by what the text IS, in this order:
 *
 *   1. **JSON** ({@link compressJson}): a text that is one JSON object or
 *      array is minified, its long arrays are sampled (head, tail, and a count
 *      of what was left out), and its long string values get the two line
 *      compressors below. The result is still JSON. The line compressors are
 *      never run over the whole document: minified JSON is one line, and
 *      truncating that line would cut the structure in half.
 *   2. **Logs** ({@link compressLogs}): anything else has its terminal escapes
 *      stripped, its carriage-return overwrites collapsed, and its repeated
 *      lines (and repeated blocks of lines) folded into one copy and a count.
 *   3. **Long lines** ({@link truncateLongLines}): then every line past
 *      {@link LONG_LINE_MAX_CHARS} is cut, with a count of what was cut.
 *
 * Everything a compressor leaves out is named in the text it returns, in a
 * `[maestro: ...]` note, so the model reading it knows something is missing
 * and how much.
 *
 * Numbers and strings inside JSON are copied as the text they were, never
 * parsed and re-printed: an identifier past 2^53 survives.
 */

import { processCarriageReturns, stripAnsiCodes } from '../../../shared/stringUtils';
import { parseJsonSpans, stringValue, type JsonSpan } from './json-spans';

export type HeuristicCompressorId = 'json' | 'logs' | 'long-lines';

export interface HeuristicCompression {
	/** The text after compression. Equal to the input when nothing applied. */
	text: string;
	/** The compressors that changed something, in the order they ran. */
	applied: HeuristicCompressorId[];
}

/** An array longer than this is sampled. */
export const JSON_ARRAY_MAX_ITEMS = 20;
/** Items kept from the start of a sampled array. */
export const JSON_ARRAY_HEAD_ITEMS = 10;
/** Items kept from the end of a sampled array. */
export const JSON_ARRAY_TAIL_ITEMS = 5;
/**
 * A long array is only sampled when what would be left out is at least this
 * many characters of source. Twenty-one small integers are not worth a note.
 */
export const JSON_ARRAY_MIN_OMITTED_CHARS = 256;

/** A line longer than this is cut. */
export const LONG_LINE_MAX_CHARS = 1000;
/** What is kept of a line that is cut. */
export const LONG_LINE_KEEP_CHARS = 800;

/** The longest run of lines that is checked for repeating as a block. */
export const REPEAT_BLOCK_MAX_LINES = 8;

function arrayNote(omitted: number, total: number): string {
	return `[maestro: ${omitted} of ${total} items omitted]`;
}

function repeatNote(period: number, repeats: number): string {
	const what = period === 1 ? 'previous line' : `previous ${period} lines`;
	return `[maestro: ${what} repeated ${repeats} more ${repeats === 1 ? 'time' : 'times'}]`;
}

function lineNote(cut: number): string {
	return ` [maestro: ${cut} more characters on this line]`;
}

/** The compressor for a text of any kind: JSON when it is JSON, lines otherwise. */
export function compressWithHeuristics(text: string): HeuristicCompression {
	return compressJson(text) ?? compressPlainText(text);
}

/** The two line compressors, in order. */
function compressPlainText(text: string): HeuristicCompression {
	const applied: HeuristicCompressorId[] = [];
	const folded = compressLogs(text);
	if (folded !== text) applied.push('logs');
	const cut = truncateLongLines(folded);
	if (cut !== folded) applied.push('long-lines');
	return { text: cut, applied };
}

/**
 * Minify a JSON document, sample its long arrays and compress its long string
 * values. `null` when the text is not one JSON object or array, so the caller
 * treats it as lines instead.
 */
export function compressJson(text: string): HeuristicCompression | null {
	const source = text.trim();
	if (source[0] !== '{' && source[0] !== '[') return null;
	try {
		JSON.parse(source);
	} catch (error) {
		// Not JSON (or nested deeper than the engine reads): a text of lines.
		if (error instanceof SyntaxError || error instanceof RangeError) return null;
		throw error;
	}
	const root = parseJsonSpans(source);
	if (!root) return null;

	const nested = new Set<HeuristicCompressorId>();
	const compressed = renderJson(source, root, nested);
	if (compressed === text) return { text, applied: [] };
	const applied: HeuristicCompressorId[] = ['json'];
	if (nested.has('logs')) applied.push('logs');
	if (nested.has('long-lines')) applied.push('long-lines');
	return { text: compressed, applied };
}

function renderJson(source: string, span: JsonSpan, nested: Set<HeuristicCompressorId>): string {
	switch (span.kind) {
		case 'scalar':
			return source.slice(span.start, span.end);
		case 'string':
			return renderJsonString(source, span, nested);
		case 'object':
			return `{${span.members
				.map(
					(member) =>
						`${source.slice(member.keyStart, member.keyEnd)}:${renderJson(source, member.value, nested)}`
				)
				.join(',')}}`;
		case 'array': {
			const items = sampledItems(span.items);
			if (items === span.items) {
				return `[${items.map((item) => renderJson(source, item, nested)).join(',')}]`;
			}
			const head = items.slice(0, JSON_ARRAY_HEAD_ITEMS);
			const tail = items.slice(JSON_ARRAY_HEAD_ITEMS);
			const omitted = span.items.length - items.length;
			return `[${[
				...head.map((item) => renderJson(source, item, nested)),
				JSON.stringify(arrayNote(omitted, span.items.length)),
				...tail.map((item) => renderJson(source, item, nested)),
			].join(',')}]`;
		}
	}
}

/** The items an array keeps: all of them (the same array), or its head and tail. */
function sampledItems(items: JsonSpan[]): JsonSpan[] {
	if (items.length <= JSON_ARRAY_MAX_ITEMS) return items;
	const firstOmitted = items[JSON_ARRAY_HEAD_ITEMS];
	const lastOmitted = items[items.length - JSON_ARRAY_TAIL_ITEMS - 1];
	if (lastOmitted.end - firstOmitted.start < JSON_ARRAY_MIN_OMITTED_CHARS) return items;
	return [
		...items.slice(0, JSON_ARRAY_HEAD_ITEMS),
		...items.slice(items.length - JSON_ARRAY_TAIL_ITEMS),
	];
}

/**
 * A string value as it was, unless it is long: a shell result is often a JSON
 * object whose one large field is the output, and that field is a text of
 * lines like any other.
 */
function renderJsonString(
	source: string,
	span: JsonSpan,
	nested: Set<HeuristicCompressorId>
): string {
	const literal = source.slice(span.start, span.end);
	if (literal.length - 2 <= LONG_LINE_MAX_CHARS) return literal;
	const decoded = stringValue(source, span);
	if (decoded === undefined) return literal;
	const compressed = compressPlainText(decoded);
	if (compressed.applied.length === 0) return literal;
	for (const id of compressed.applied) nested.add(id);
	return JSON.stringify(compressed.text);
}

/**
 * Strip terminal escapes, collapse carriage-return overwrites (a progress bar
 * becomes its last frame), and fold repeated lines and blocks into one copy
 * and a count.
 */
export function compressLogs(text: string): string {
	let cleaned = text;
	// Only a text that carries an escape or a bell is handed to the stripper:
	// it also removes bare shell-integration sequences, which plain text could
	// resemble.
	if (cleaned.includes('\x1b') || cleaned.includes('\x07')) cleaned = stripAnsiCodes(cleaned);
	if (cleaned.includes('\r')) cleaned = processCarriageReturns(cleaned);
	const lines = cleaned.split('\n');
	const folded = foldRepeatedLines(lines);
	return folded === lines ? cleaned : folded.join('\n');
}

/** The lines with every repeat folded, or the same array when none was. */
function foldRepeatedLines(lines: string[]): string[] {
	const out: string[] = [];
	let folded = false;
	let at = 0;
	while (at < lines.length) {
		const repeat = repeatAt(lines, at);
		if (!repeat) {
			out.push(lines[at++]);
			continue;
		}
		for (let offset = 0; offset < repeat.period; offset++) out.push(lines[at + offset]);
		out.push(repeatNote(repeat.period, repeat.repeats));
		at += repeat.period * (repeat.repeats + 1);
		folded = true;
	}
	return folded ? out : lines;
}

/**
 * The repeat that starts at `at`: the shortest block (1 to
 * {@link REPEAT_BLOCK_MAX_LINES} lines) that is followed by copies of itself,
 * when folding those copies removes more text than the note adds.
 */
function repeatAt(lines: string[], at: number): { period: number; repeats: number } | null {
	for (let period = 1; period <= REPEAT_BLOCK_MAX_LINES; period++) {
		if (at + 2 * period > lines.length) break;
		let repeats = 0;
		while (sameBlock(lines, at, at + (repeats + 1) * period, period)) repeats++;
		if (repeats === 0) continue;
		let blockChars = period;
		for (let offset = 0; offset < period; offset++) blockChars += lines[at + offset].length;
		if (repeats * blockChars > repeatNote(period, repeats).length + 1) return { period, repeats };
	}
	return null;
}

function sameBlock(lines: string[], a: number, b: number, period: number): boolean {
	if (b + period > lines.length) return false;
	for (let offset = 0; offset < period; offset++) {
		if (lines[a + offset] !== lines[b + offset]) return false;
	}
	return true;
}

/** Cut every line past {@link LONG_LINE_MAX_CHARS}, saying how much was cut. */
export function truncateLongLines(text: string): string {
	if (text.length <= LONG_LINE_MAX_CHARS) return text;
	let changed = false;
	const lines = text.split('\n').map((line) => {
		if (line.length <= LONG_LINE_MAX_CHARS) return line;
		changed = true;
		// Never between the halves of a surrogate pair.
		const last = line.charCodeAt(LONG_LINE_KEEP_CHARS - 1);
		const keep = last >= 0xd800 && last <= 0xdbff ? LONG_LINE_KEEP_CHARS - 1 : LONG_LINE_KEEP_CHARS;
		return `${line.slice(0, keep)}${lineNote(line.length - keep)}`;
	});
	return changed ? lines.join('\n') : text;
}
