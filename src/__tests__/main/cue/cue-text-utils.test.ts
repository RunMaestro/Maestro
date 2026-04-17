/**
 * Tests for UTF-8-safe slicing helpers used throughout the Cue engine to
 * avoid splitting surrogate pairs when truncating subscription outputs.
 */

import { describe, it, expect } from 'vitest';
import { sliceHeadByChars, sliceTailByChars } from '../../../main/cue/cue-text-utils';

// A supplementary-plane code point (U+1F600 😀) encodes as the surrogate pair
// D83D DE00 — two UTF-16 code units. A naive `.slice()` that lands between
// them produces a lone surrogate that downstream consumers see as garbage.
const EMOJI = '😀'; // 2 code units
const TREE = '🌳'; // 2 code units
const HEART = '❤'; // 1 code unit

describe('sliceTailByChars', () => {
	it('returns the full string when shorter than max', () => {
		expect(sliceTailByChars('hello', 10)).toBe('hello');
	});

	it('returns the full string when exactly equal to max', () => {
		expect(sliceTailByChars('hello', 5)).toBe('hello');
	});

	it('returns empty string for maxChars <= 0', () => {
		expect(sliceTailByChars('hello', 0)).toBe('');
		expect(sliceTailByChars('hello', -1)).toBe('');
	});

	it('returns empty string for empty input', () => {
		expect(sliceTailByChars('', 5)).toBe('');
	});

	it('returns the last N ASCII chars when plain text', () => {
		expect(sliceTailByChars('abcdefghij', 3)).toBe('hij');
	});

	it('does not split a surrogate pair at the start of the slice', () => {
		// "ab" + "😀" → len 4 (a=1, b=1, 😀=2). slice(-3) would start at index 1,
		// landing on the b; slice(-2) lands on the high surrogate of 😀; slice(-1)
		// lands on the low surrogate and must shift forward to return just "".
		const input = 'ab' + EMOJI;
		const low = sliceTailByChars(input, 1);
		// The tail was a lone low surrogate; helper must strip it rather than
		// emit a broken half-emoji.
		expect(low).not.toMatch(/[\uDC00-\uDFFF]/);
	});

	it('includes the full emoji when the slice boundary lands exactly on the high surrogate', () => {
		// slice(-2) on "ab😀" lands on 😀's high surrogate — the whole emoji
		// fits, so the helper should return it intact.
		const input = 'ab' + EMOJI;
		expect(sliceTailByChars(input, 2)).toBe(EMOJI);
	});

	it('preserves adjacent emojis when they both fit', () => {
		const input = 'xx' + EMOJI + TREE; // 2 + 2 + 2 = 6 units
		expect(sliceTailByChars(input, 4)).toBe(EMOJI + TREE);
	});

	it('handles BMP characters (single code units) unchanged', () => {
		const input = 'x' + HEART + 'y'; // each is 1 unit
		expect(sliceTailByChars(input, 2)).toBe(HEART + 'y');
	});

	it('handles a string of only emoji', () => {
		const input = EMOJI + EMOJI + EMOJI;
		const result = sliceTailByChars(input, 3);
		// Must not start with a lone low surrogate
		expect(result).not.toMatch(/^[\uDC00-\uDFFF]/);
	});
});

describe('sliceHeadByChars', () => {
	it('returns the full string when shorter than max', () => {
		expect(sliceHeadByChars('hello', 10)).toBe('hello');
	});

	it('returns empty string for maxChars <= 0', () => {
		expect(sliceHeadByChars('hello', 0)).toBe('');
		expect(sliceHeadByChars('hello', -1)).toBe('');
	});

	it('returns empty string for empty input', () => {
		expect(sliceHeadByChars('', 5)).toBe('');
	});

	it('returns the first N ASCII chars', () => {
		expect(sliceHeadByChars('abcdefghij', 3)).toBe('abc');
	});

	it('does not split a surrogate pair at the end of the slice', () => {
		// "a" + "😀" + "b" → boundaries at 1,3,4. slice(0,2) lands between the
		// high and low surrogates — helper must step back to "a".
		const input = 'a' + EMOJI + 'b';
		const result = sliceHeadByChars(input, 2);
		expect(result).toBe('a');
		expect(result).not.toMatch(/[\uD800-\uDBFF]$/);
	});

	it('includes the full emoji when it just fits', () => {
		const input = 'a' + EMOJI + 'b';
		expect(sliceHeadByChars(input, 3)).toBe('a' + EMOJI);
	});

	it('handles a string of only emoji', () => {
		const input = EMOJI + EMOJI + EMOJI;
		const result = sliceHeadByChars(input, 3);
		// Must not end with a lone high surrogate
		expect(result).not.toMatch(/[\uD800-\uDBFF]$/);
	});

	it('handles BMP characters (single code units) unchanged', () => {
		const input = HEART + HEART + HEART;
		expect(sliceHeadByChars(input, 2)).toBe(HEART + HEART);
	});
});
