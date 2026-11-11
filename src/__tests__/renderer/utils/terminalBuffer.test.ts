/**
 * Tests for readLogicalLine - reconstructing a full logical line from an
 * xterm-style buffer, including soft-wrapped continuations. This is what powers
 * the terminal right-click "copy the line under the cursor" fallback that works
 * even when a mouse-mode TUI has eaten the drag-selection.
 */

import { describe, it, expect } from 'vitest';
import {
	findLogicalLineMatches,
	readLogicalLine,
	readLogicalLineRows,
	type ReadableBuffer,
	type ReadableBufferLine,
} from '../../../renderer/utils/terminalBuffer';

/**
 * Build a buffer from row specs. `text` is the raw row content; `wrapped` marks
 * the row as a soft-wrap continuation of the previous one. translateToString
 * pads to a fixed width when trimRight is false, mirroring xterm's behavior so
 * the trimEnd path is exercised.
 */
function makeBuffer(rows: Array<{ text: string; wrapped?: boolean }>, width = 10): ReadableBuffer {
	const lines: ReadableBufferLine[] = rows.map((r) => ({
		isWrapped: !!r.wrapped,
		translateToString: (trimRight?: boolean) =>
			trimRight ? r.text.replace(/\s+$/, '') : r.text.padEnd(width, ' '),
	}));
	return {
		getLine: (y: number) => lines[y],
	};
}

describe('readLogicalLine', () => {
	it('returns a single unwrapped line, trimming trailing padding', () => {
		const buf = makeBuffer([{ text: 'hello' }]);
		expect(readLogicalLine(buf, 0)).toBe('hello');
	});

	it('reconstructs a line that soft-wraps across multiple rows', () => {
		const buf = makeBuffer([
			{ text: 'https://ex' },
			{ text: 'ample.com/', wrapped: true },
			{ text: 'path', wrapped: true },
		]);
		expect(readLogicalLine(buf, 0)).toBe('https://example.com/path');
	});

	it('walks back to the start when the clicked row is a wrapped continuation', () => {
		const buf = makeBuffer([
			{ text: 'https://ex' },
			{ text: 'ample.com/', wrapped: true },
			{ text: 'path', wrapped: true },
		]);
		// Clicking the middle or last visual row still yields the whole URL.
		expect(readLogicalLine(buf, 1)).toBe('https://example.com/path');
		expect(readLogicalLine(buf, 2)).toBe('https://example.com/path');
	});

	it('does not bleed into the next logical line', () => {
		const buf = makeBuffer([
			{ text: 'first' },
			{ text: 'second' }, // not wrapped - a separate logical line
		]);
		expect(readLogicalLine(buf, 0)).toBe('first');
		expect(readLogicalLine(buf, 1)).toBe('second');
	});

	it('stops at the previous non-wrapped boundary when walking back', () => {
		const buf = makeBuffer([
			{ text: 'intro' },
			{ text: 'long-line-' },
			{ text: 'continued', wrapped: true },
		]);
		expect(readLogicalLine(buf, 2)).toBe('long-line-continued');
	});

	it('returns empty string for a missing row', () => {
		const buf = makeBuffer([{ text: 'only' }]);
		expect(readLogicalLine(buf, 5)).toBe('');
	});

	it('returns empty string for a negative row', () => {
		const buf = makeBuffer([{ text: 'only' }]);
		expect(readLogicalLine(buf, -1)).toBe('');
	});
});

describe('readLogicalLineRows', () => {
	it('returns the untrimmed rows of the wrap group and its first row', () => {
		const buf = makeBuffer([
			{ text: 'intro' },
			{ text: 'https://ex' },
			{ text: 'ample.com', wrapped: true },
		]);
		expect(readLogicalLineRows(buf, 2)).toEqual({
			firstRow: 1,
			rows: ['https://ex', 'ample.com '],
		});
	});

	it('bounds the walk in each direction', () => {
		const buf = makeBuffer([
			{ text: 'aaaaaaaaaa' },
			{ text: 'bbbbbbbbbb', wrapped: true },
			{ text: 'cccccccccc', wrapped: true },
			{ text: 'dddddddddd', wrapped: true },
			{ text: 'eeeeeeeeee', wrapped: true },
		]);
		expect(readLogicalLineRows(buf, 2, 1)).toEqual({
			firstRow: 1,
			rows: ['bbbbbbbbbb', 'cccccccccc', 'dddddddddd'],
		});
	});

	it('returns null for a missing or negative row', () => {
		const buf = makeBuffer([{ text: 'only' }]);
		expect(readLogicalLineRows(buf, 3)).toBeNull();
		expect(readLogicalLineRows(buf, -1)).toBeNull();
	});
});

describe('findLogicalLineMatches', () => {
	const URL = /https?:\/\/[^\s]+/g;

	// "  https://example.com/a/very/long/path" soft-wrapped at 10 columns
	const wrappedUrl = () =>
		makeBuffer([
			{ text: 'Open this:' },
			{ text: '  https://' },
			{ text: 'example.co', wrapped: true },
			{ text: 'm/a/b?x=1', wrapped: true },
			{ text: 'next line' },
		]);

	it('matches a soft-wrapped URL as one link spanning rows', () => {
		expect(findLogicalLineMatches(wrappedUrl(), 1, URL)).toEqual([
			{
				text: 'https://example.com/a/b?x=1',
				start: { row: 1, col: 2 },
				end: { row: 3, col: 8 },
			},
		]);
	});

	it('returns the same whole link when hovering a continuation row', () => {
		const fromFirst = findLogicalLineMatches(wrappedUrl(), 1, URL);
		expect(findLogicalLineMatches(wrappedUrl(), 2, URL)).toEqual(fromFirst);
		expect(findLogicalLineMatches(wrappedUrl(), 3, URL)).toEqual(fromFirst);
	});

	it('does not join across a hard line break', () => {
		expect(findLogicalLineMatches(wrappedUrl(), 0, URL)).toEqual([]);
		expect(findLogicalLineMatches(wrappedUrl(), 4, URL)).toEqual([]);
	});

	it('only returns matches that cover the hovered row', () => {
		const buf = makeBuffer(
			[
				{ text: 'http://a.b x' },
				{ text: 'y  http://c.', wrapped: true },
				{ text: 'd', wrapped: true },
			],
			12
		);
		// Row 0 holds only the first link; rows 1 and 2 hold only the second.
		expect(findLogicalLineMatches(buf, 0, URL).map((m) => m.text)).toEqual(['http://a.b']);
		expect(findLogicalLineMatches(buf, 2, URL).map((m) => m.text)).toEqual(['http://c.d']);
	});

	it('accepts a pattern without the global flag', () => {
		const buf = makeBuffer([{ text: 'http://a.b http://c.d' }], 24);
		expect(findLogicalLineMatches(buf, 0, /http:\/\/\S+/).map((m) => m.text)).toEqual([
			'http://a.b',
			'http://c.d',
		]);
	});
});
