/**
 * Tests for readLogicalLine - reconstructing a full logical line from an
 * xterm-style buffer, including soft-wrapped continuations. This is what powers
 * the terminal right-click "copy the line under the cursor" fallback that works
 * even when a mouse-mode TUI has eaten the drag-selection.
 */

import { describe, it, expect } from 'vitest';
import {
	readLogicalLine,
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
