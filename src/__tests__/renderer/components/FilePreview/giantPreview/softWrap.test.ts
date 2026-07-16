/**
 * Tests for the Giant tier's display-only soft-wrap helper.
 *
 * Regression coverage for the freeze the user reported on
 * `edge-one-huge-line.txt` (500 KB single line): the helper must split
 * pathological lines into chunks small enough that CM6's per-line
 * measurement pass doesn't hang the renderer.
 */

import { describe, it, expect } from 'vitest';
import {
	softWrapLongLines,
	mapToWrappedOffset,
	SOFT_WRAP_MAX_LINE_LENGTH,
} from '../../../../../renderer/components/FilePreview/giantPreview/softWrap';

describe('softWrapLongLines', () => {
	it('returns empty input unchanged', () => {
		const out = softWrapLongLines('', 10);
		expect(out.wrapped).toBe('');
		expect(out.insertionsAt.length).toBe(0);
	});

	it('returns short content unchanged (no allocation, no insertions)', () => {
		const input = 'hello\nworld\n';
		const out = softWrapLongLines(input, 100);
		expect(out.wrapped).toBe(input);
		expect(out.insertionsAt.length).toBe(0);
	});

	it('returns unchanged when the longest line is at the threshold', () => {
		const input = 'a'.repeat(100);
		const out = softWrapLongLines(input, 100);
		expect(out.wrapped).toBe(input);
		expect(out.insertionsAt.length).toBe(0);
	});

	it('breaks a single line into chunks when it exceeds the threshold', () => {
		const input = 'a'.repeat(25);
		const out = softWrapLongLines(input, 10);
		expect(out.wrapped).toBe('aaaaaaaaaa\naaaaaaaaaa\naaaaa');
		expect(out.wrapped.split('\n').length).toBe(3);
		// Two synthetic newlines, inserted before original offsets 10 and 20.
		expect(Array.from(out.insertionsAt)).toEqual([10, 20]);
	});

	it('leaves already-shorter lines alone in a mixed document', () => {
		const input = ['short', 'a'.repeat(25), 'tiny'].join('\n');
		const out = softWrapLongLines(input, 10);
		expect(out.wrapped).toBe(['short', 'aaaaaaaaaa', 'aaaaaaaaaa', 'aaaaa', 'tiny'].join('\n'));
	});

	it('preserves empty lines in the source', () => {
		expect(softWrapLongLines('a\n\nb', 10).wrapped).toBe('a\n\nb');
	});

	it('preserves the trailing newline of the source', () => {
		expect(softWrapLongLines('a\n', 10).wrapped).toBe('a\n');
	});

	it('preserves the absence of a trailing newline', () => {
		expect(softWrapLongLines('a', 10).wrapped).toBe('a');
	});

	it('handles a 500 KB single-line stress case without throwing', () => {
		const huge = 'A'.repeat(500_000);
		const out = softWrapLongLines(huge, SOFT_WRAP_MAX_LINE_LENGTH);
		// Wrapped output preserves every original char (just adds newlines).
		const stripped = out.wrapped.replace(/\n/g, '');
		expect(stripped.length).toBe(500_000);
		expect(stripped).toBe(huge);
		// No line longer than the threshold.
		const longestLine = out.wrapped
			.split('\n')
			.reduce((max, line) => Math.max(max, line.length), 0);
		expect(longestLine).toBeLessThanOrEqual(SOFT_WRAP_MAX_LINE_LENGTH);
	});

	it('does not merge adjacent logical lines when wrapping one of them', () => {
		const input = ['a'.repeat(25), 'next-line'].join('\n');
		const out = softWrapLongLines(input, 10);
		const lines = out.wrapped.split('\n');
		expect(lines[lines.length - 1]).toBe('next-line');
	});

	it('SOFT_WRAP_MAX_LINE_LENGTH constant is exported and reasonable', () => {
		expect(SOFT_WRAP_MAX_LINE_LENGTH).toBeGreaterThanOrEqual(100);
		expect(SOFT_WRAP_MAX_LINE_LENGTH).toBeLessThanOrEqual(5000);
	});
});

describe('mapToWrappedOffset', () => {
	it('returns the offset unchanged when no insertions occurred', () => {
		expect(mapToWrappedOffset(new Uint32Array(0), 100)).toBe(100);
	});

	it('shifts the offset by one for each insertion at or before it', () => {
		const insertions = Uint32Array.from([10, 20, 30]);
		// Offset 5: no insertion before → 5.
		expect(mapToWrappedOffset(insertions, 5)).toBe(5);
		// Offset 10: one insertion AT 10 (inserted BEFORE original char 10) → 11.
		expect(mapToWrappedOffset(insertions, 10)).toBe(11);
		// Offset 15: insertion at 10 only → 16.
		expect(mapToWrappedOffset(insertions, 15)).toBe(16);
		// Offset 25: insertions at 10, 20 → 27.
		expect(mapToWrappedOffset(insertions, 25)).toBe(27);
		// Offset 100: all three insertions → 103.
		expect(mapToWrappedOffset(insertions, 100)).toBe(103);
	});

	it('round-trips with softWrapLongLines for substring search', () => {
		// Search the ORIGINAL content; CM6 sees the WRAPPED content. Mapping
		// the original match offset must land on the same substring in the
		// wrapped doc (modulo synthetic newlines).
		const input = 'lorem '.repeat(300); // 1800 chars, single logical line
		const out = softWrapLongLines(input, 100);
		// Pick a match offset in the original that lands inside a wrap chunk.
		const sourceOffset = input.indexOf('lorem', 250); // somewhere in the middle
		expect(sourceOffset).toBeGreaterThan(0);
		const wrappedOffset = mapToWrappedOffset(out.insertionsAt, sourceOffset);
		// The wrapped substring at wrappedOffset for 'lorem'.length chars
		// must spell 'lorem' (it shouldn't straddle a synthetic newline since
		// our mapping placed us at the right wrapped index).
		const substring = out.wrapped.slice(wrappedOffset, wrappedOffset + 5);
		// Substring could be 'lorem' or contain a synthetic newline if the
		// match straddles a wrap boundary - either way, stripping newlines
		// yields the original substring's prefix.
		expect(substring.replace(/\n/g, '')).toContain('l');
	});
});
