/**
 * Tests for shared/canonicalJson.ts.
 *
 * The text this produces gets hashed and compared, so what matters is that it
 * never moves: the same value gives the same text whatever order its keys were
 * added in, and a value JSON cannot hold is refused instead of being changed
 * on the way out.
 */

import { describe, it, expect } from 'vitest';
import { canonicalJson } from '../../shared/canonicalJson';

describe('canonicalJson', () => {
	describe('key order', () => {
		it('gives the same text whatever order the keys were added in', () => {
			const forward = { alpha: 1, beta: 2, gamma: 3 };
			const backward = { gamma: 3, beta: 2, alpha: 1 };

			expect(canonicalJson(forward)).toBe('{"alpha":1,"beta":2,"gamma":3}');
			expect(canonicalJson(backward)).toBe(canonicalJson(forward));
		});

		it('sorts the keys of nested objects, and of objects inside arrays', () => {
			const value = {
				outer: { zebra: 1, apple: { yak: true, bee: null } },
				list: [{ two: 2, one: 1 }, [{ d: 4, c: 3 }]],
			};

			expect(canonicalJson(value)).toBe(
				'{"list":[{"one":1,"two":2},[{"c":3,"d":4}]],"outer":{"apple":{"bee":null,"yak":true},"zebra":1}}'
			);
		});

		it('sorts by code unit, not by number and not by letter case', () => {
			// An engine lists the keys of this object as 9, 10, b, B. Sorted as
			// text, "10" comes before "9" and every capital before every small
			// letter.
			const value = { b: 1, 10: 'ten', B: 2, 9: 'nine' };

			expect(canonicalJson(value)).toBe('{"10":"ten","9":"nine","B":2,"b":1}');
		});

		it('sorts the RFC 8785 test keys into the order that document gives', () => {
			// Keys are built from their code points, so the file shows exactly
			// which characters they are.
			const value = {
				[String.fromCodePoint(0x20ac)]: 'Euro Sign',
				[String.fromCodePoint(0x000d)]: 'Carriage Return',
				[String.fromCodePoint(0xfb33)]: 'Hebrew Letter Dalet With Dagesh',
				[String.fromCodePoint(0x0031)]: 'One',
				[String.fromCodePoint(0x1f600)]: 'Emoji: Grinning Face',
				[String.fromCodePoint(0x0080)]: 'Control',
				[String.fromCodePoint(0x00f6)]: 'Latin Small Letter O With Diaeresis',
			};

			// Read the order from the text. Parsing it back would move "1" to the
			// front, because an engine lists integer-like keys first.
			const order = [...canonicalJson(value).matchAll(/:"([^"]+)"/g)].map((match) => match[1]);

			// The emoji is the surrogate pair D83D DE00, and D83D is below FB33.
			// Sorted by code point it would come last.
			expect(order).toEqual([
				'Carriage Return',
				'One',
				'Control',
				'Latin Small Letter O With Diaeresis',
				'Euro Sign',
				'Emoji: Grinning Face',
				'Hebrew Letter Dalet With Dagesh',
			]);
		});
	});

	describe('values', () => {
		it('keeps array elements in the order given', () => {
			expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
			expect(canonicalJson({ list: ['b', 'a'] })).toBe('{"list":["b","a"]}');
		});

		it('writes primitives the way JSON.stringify does', () => {
			expect(canonicalJson(null)).toBe('null');
			expect(canonicalJson(true)).toBe('true');
			expect(canonicalJson(false)).toBe('false');
			expect(canonicalJson(0)).toBe('0');
			expect(canonicalJson(-0)).toBe('0');
			expect(canonicalJson(-1.5)).toBe('-1.5');
			expect(canonicalJson(1e21)).toBe('1e+21');
			expect(canonicalJson('')).toBe('""');
			expect(canonicalJson('a "quoted" line\n')).toBe('"a \\"quoted\\" line\\n"');
			expect(canonicalJson({})).toBe('{}');
			expect(canonicalJson([])).toBe('[]');
		});

		it('writes no whitespace', () => {
			expect(canonicalJson({ a: [1, { b: 'c d' }], e: null })).toBe(
				'{"a":[1,{"b":"c d"}],"e":null}'
			);
		});

		it('gives the canonical text of the RFC 8785 sample', () => {
			// The value that document's sample input parses to. The numbers go
			// through JSON.parse because the point of the sample is that 1E30 and
			// 4.50 come out normalized. The string is built from parts: a euro
			// sign, "$", U+000F, a line feed, "A'B", a quote, two backslashes, a
			// quote, and a slash.
			const value = {
				numbers: JSON.parse(
					'[333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001]'
				) as number[],
				string: `${String.fromCodePoint(0x20ac)}$${String.fromCodePoint(0x000f)}\nA'B"\\\\"/`,
				literals: [null, true, false],
			};

			expect(canonicalJson(value)).toBe(
				String.raw`{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\u000f\nA'B\"\\\\\"/"}`
			);
		});

		it('leaves out a member whose value is undefined', () => {
			expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
			expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
			expect(canonicalJson({ outer: { gone: undefined } })).toBe('{"outer":{}}');
			expect(canonicalJson([{ gone: undefined, kept: 0 }])).toBe('[{"kept":0}]');
		});

		it('keeps a member whose value is null', () => {
			expect(canonicalJson({ a: null })).toBe('{"a":null}');
		});

		it('writes a lone surrogate as an escape', () => {
			const text = canonicalJson({ key: 'bad \ud800 half' });

			expect(text).toBe('{"key":"bad \\ud800 half"}');
			// The text holds no lone surrogate, so encoding it as UTF-8 loses nothing.
			expect(new TextDecoder().decode(new TextEncoder().encode(text))).toBe(text);
		});

		it('accepts an object with no prototype', () => {
			const value: Record<string, unknown> = Object.create(null);
			value.b = 2;
			value.a = 1;

			expect(canonicalJson(value)).toBe('{"a":1,"b":2}');
		});

		it('writes an object that appears in two places both times', () => {
			const shared = { n: 1 };

			expect(canonicalJson({ first: shared, second: shared, list: [shared, shared] })).toBe(
				'{"first":{"n":1},"list":[{"n":1},{"n":1}],"second":{"n":1}}'
			);
		});

		it('keeps a "__proto__" key that came from parsed JSON', () => {
			const value: unknown = JSON.parse('{"b":1,"__proto__":{"x":1},"a":2}');

			expect(canonicalJson(value)).toBe('{"__proto__":{"x":1},"a":2,"b":1}');
		});
	});

	describe('round trip', () => {
		const value = {
			text: 'line one\nline "two" \\ € 😀',
			numbers: [0, -1, 1.5, 1e-7, 1e21, Number.MAX_SAFE_INTEGER, 0.1 + 0.2],
			nested: { z: [true, false, null], a: { deep: [] } },
			10: 'ten',
			9: 'nine',
		};

		it('is valid JSON that reads back as the value it was given', () => {
			expect(JSON.parse(canonicalJson(value))).toEqual(value);
		});

		it('gives the same text again after being parsed', () => {
			const text = canonicalJson(value);

			expect(canonicalJson(JSON.parse(text))).toBe(text);
		});

		it('gives the same text for a value that was written in another key order', () => {
			// What a reader sees after a writer used plain JSON.stringify.
			const reread: unknown = JSON.parse(JSON.stringify(value));

			expect(canonicalJson(reread)).toBe(canonicalJson(value));
		});
	});

	describe('what it refuses', () => {
		it.each([
			['NaN', NaN],
			['Infinity', Infinity],
			['-Infinity', -Infinity],
		])('a non-finite number: %s', (name, bad) => {
			expect(() => canonicalJson(bad)).toThrow(TypeError);
			expect(() => canonicalJson(bad)).toThrow(`non-finite number ${name}`);
			expect(() => canonicalJson({ deep: { cost: bad } })).toThrow(TypeError);
			expect(() => canonicalJson([1, [bad]])).toThrow(TypeError);
		});

		it('undefined anywhere but an object member', () => {
			expect(() => canonicalJson(undefined)).toThrow('cannot serialize undefined');
			expect(() => canonicalJson([1, undefined])).toThrow('cannot serialize undefined');
		});

		it('the hole of a sparse array', () => {
			const sparse: unknown[] = [1, 2, 3];
			delete sparse[1];

			expect(() => canonicalJson(sparse)).toThrow('cannot serialize undefined');
		});

		it.each([
			['a bigint', 10n, 'a bigint'],
			['a function', () => 1, 'a function'],
			['a symbol', Symbol('s'), 'a symbol'],
		])('%s', (_name, bad, what) => {
			expect(() => canonicalJson(bad)).toThrow(`cannot serialize ${what}`);
			// As an object member too. JSON.stringify would leave it out without a
			// word.
			expect(() => canonicalJson({ member: bad })).toThrow(`cannot serialize ${what}`);
		});

		it.each([
			['a Date', new Date(0), 'Date'],
			['a Map', new Map([['a', 1]]), 'Map'],
			['a Set', new Set([1]), 'Set'],
			['a typed array', new Uint8Array([1, 2]), 'Uint8Array'],
			['an Error', new Error('boom'), 'Error'],
		])('%s', (_name, bad, constructorName) => {
			expect(() => canonicalJson(bad)).toThrow(`an instance of ${constructorName}`);
			expect(() => canonicalJson({ member: bad })).toThrow(TypeError);
		});

		it('a class instance, named by its class and never by what it holds', () => {
			class Credential {
				token = 'hunter2';
			}

			let message = '';
			try {
				canonicalJson({ login: new Credential() });
			} catch (error) {
				message = (error as Error).message;
			}

			expect(message).toBe('canonicalJson cannot serialize an instance of Credential');
			expect(message).not.toContain('hunter2');
		});

		it('a circular reference', () => {
			const circle: Record<string, unknown> = { name: 'loop' };
			circle.self = circle;
			const throughArray: Record<string, unknown> = {};
			throughArray.list = [{ back: throughArray }];

			expect(() => canonicalJson(circle)).toThrow('a circular reference');
			expect(() => canonicalJson(throughArray)).toThrow('a circular reference');
		});
	});
});
