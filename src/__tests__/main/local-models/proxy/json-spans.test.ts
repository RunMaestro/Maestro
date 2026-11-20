/**
 * @file json-spans.test.ts
 *
 * The span scanner under the token proxy's compressor: it must find exactly
 * where each value sits, so a replacement lands on one string literal and
 * every other byte of a request survives.
 */

import { describe, it, expect } from 'vitest';
import {
	isNullSpan,
	MAX_JSON_SPAN_DEPTH,
	memberOf,
	parseJsonSpans,
	spliceSpans,
	stringValue,
	type JsonSpan,
} from '../../../../main/local-models/proxy/json-spans';

function raw(text: string, span: JsonSpan | undefined): string | undefined {
	return span ? text.slice(span.start, span.end) : undefined;
}

describe('parseJsonSpans', () => {
	it('locates every value by its exact source text', () => {
		const text = ' { "a" : [ 1 , "two" , null ] ,\n\t"b":{"c":true} } ';
		const root = parseJsonSpans(text);
		expect(root?.kind).toBe('object');
		expect(raw(text, root ?? undefined)).toBe(text.trim());

		const a = memberOf(root ?? undefined, 'a');
		expect(a?.kind).toBe('array');
		expect(raw(text, a)).toBe('[ 1 , "two" , null ]');
		if (a?.kind !== 'array') throw new Error('expected an array');
		expect(a.items.map((item) => [item.kind, raw(text, item)])).toEqual([
			['scalar', '1'],
			['string', '"two"'],
			['scalar', 'null'],
		]);
		expect(raw(text, memberOf(memberOf(root ?? undefined, 'b'), 'c'))).toBe('true');
	});

	it('keeps a number as the text it was, however large', () => {
		const text = '{"id":12345678901234567890,"ratio":-1.50e+10}';
		const root = parseJsonSpans(text) ?? undefined;
		expect(raw(text, memberOf(root, 'id'))).toBe('12345678901234567890');
		expect(raw(text, memberOf(root, 'ratio'))).toBe('-1.50e+10');
	});

	it('finds the end of a string past escaped quotes and backslashes', () => {
		const text = String.raw`["say \"hi\"","ends in a backslash \\","\\\"",""]`;
		const root = parseJsonSpans(text);
		if (root?.kind !== 'array') throw new Error('expected an array');
		expect(root.items.map((item) => stringValue(text, item))).toEqual([
			'say "hi"',
			'ends in a backslash \\',
			'\\"',
			'',
		]);
	});

	it('decodes an escaped key, and the last of a repeated key wins', () => {
		const text = String.raw`{"k\u0065y":1,"dup":"first","dup":"second"}`;
		const root = parseJsonSpans(text) ?? undefined;
		expect(raw(text, memberOf(root, 'key'))).toBe('1');
		expect(stringValue(text, memberOf(root, 'dup'))).toBe('second');
		expect(memberOf(root, 'absent')).toBeUndefined();
	});

	it('reads empty containers and a bare scalar', () => {
		expect(parseJsonSpans('{}')).toEqual({ kind: 'object', start: 0, end: 2, members: [] });
		expect(parseJsonSpans('[ ]')).toEqual({ kind: 'array', start: 0, end: 3, items: [] });
		expect(parseJsonSpans(' 42 ')).toEqual({ kind: 'scalar', start: 1, end: 3 });
	});

	it.each([
		['a trailing comma', '[1,2,]'],
		['an unterminated string', '{"a":"b'],
		['an unterminated object', '{"a":1'],
		['a missing colon', '{"a" 1}'],
		['an unquoted key', '{a:1}'],
		['text after the value', '{"a":1} x'],
		['a word that is not a literal', '[nul]'],
		['an empty text', ''],
		['a single quoted string', "['a']"],
	])('refuses %s', (_name, text) => {
		expect(parseJsonSpans(text)).toBeNull();
	});

	it('refuses nesting past the depth limit instead of overflowing', () => {
		const deep = '['.repeat(MAX_JSON_SPAN_DEPTH + 5) + ']'.repeat(MAX_JSON_SPAN_DEPTH + 5);
		expect(parseJsonSpans(deep)).toBeNull();
		const fine = '['.repeat(50) + ']'.repeat(50);
		expect(parseJsonSpans(fine)?.kind).toBe('array');
	});
});

describe('stringValue', () => {
	it('decodes escapes and returns undefined for anything that is not a string', () => {
		const text = String.raw`{"s":"line\nbreak \u00e9","n":5}`;
		const root = parseJsonSpans(text) ?? undefined;
		expect(stringValue(text, memberOf(root, 's'))).toBe('line\nbreak \u00e9');
		expect(stringValue(text, memberOf(root, 'n'))).toBeUndefined();
		expect(stringValue(text, undefined)).toBeUndefined();
	});

	it('returns undefined for a literal JSON would reject', () => {
		// A raw newline inside a string is not valid JSON; the scanner finds the
		// literal, and the decode is what refuses it.
		const text = '["a\nb"]';
		const root = parseJsonSpans(text);
		if (root?.kind !== 'array') throw new Error('expected an array');
		expect(stringValue(text, root.items[0])).toBeUndefined();
	});
});

describe('isNullSpan', () => {
	it('tells null from every other scalar', () => {
		const text = '[null,0,false]';
		const root = parseJsonSpans(text);
		if (root?.kind !== 'array') throw new Error('expected an array');
		expect(root.items.map((item) => isNullSpan(text, item))).toEqual([true, false, false]);
	});
});

describe('spliceSpans', () => {
	it('writes each edit over its span and leaves every other byte', () => {
		const text = '{ "a" : "one" ,  "b":"two","n":12345678901234567890 }';
		const root = parseJsonSpans(text) ?? undefined;
		const a = memberOf(root, 'a');
		const b = memberOf(root, 'b');
		if (!a || !b) throw new Error('expected both members');
		// Given out of order on purpose.
		const out = spliceSpans(text, [
			{ start: b.start, end: b.end, text: '"TWO!"' },
			{ start: a.start, end: a.end, text: '"1"' },
		]);
		expect(out).toBe('{ "a" : "1" ,  "b":"TWO!","n":12345678901234567890 }');
	});

	it('returns the same string when there is nothing to write', () => {
		const text = '{"a":1}';
		expect(spliceSpans(text, [])).toBe(text);
	});
});
