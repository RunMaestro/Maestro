/**
 * Tests for the tail-truncation helper behind `maestro-cli read-terminal`.
 *
 * The truncation runs in the renderer, before the buffer crosses IPC, so these
 * cover the boundary that decides how much of a `tail -f` tab reaches an agent's
 * context.
 */

import { describe, it, expect } from 'vitest';
import {
	tailLines,
	MAX_TERMINAL_READ_LINES,
} from '../../../../renderer/hooks/terminal/useRemoteTerminalBufferResponder';

const buffer = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');

describe('tailLines', () => {
	it('returns the buffer untouched when it is shorter than the tail', () => {
		const out = tailLines(buffer(10), 50);
		expect(out.content).toBe(buffer(10));
		expect(out.totalLines).toBe(10);
	});

	it('keeps the LAST n lines, not the first', () => {
		const out = tailLines(buffer(100), 3);
		// A head-truncating implementation would return "line 1..line 3" here and
		// hand back the start of a log when the caller asked for its end.
		expect(out.content).toBe('line 98\nline 99\nline 100');
	});

	it('reports the pre-truncation total so a partial read is detectable', () => {
		const out = tailLines(buffer(4000), 200);
		expect(out.content.split('\n')).toHaveLength(200);
		expect(out.totalLines).toBe(4000);
	});

	it('is exact at the boundary', () => {
		const out = tailLines(buffer(200), 200);
		expect(out.content).toBe(buffer(200));
		expect(out.totalLines).toBe(200);
	});

	it('caps an unbounded request at MAX_TERMINAL_READ_LINES', () => {
		// The cap is the whole point: without it a huge scrollback would be shipped
		// across IPC and blow the calling agent's context.
		const out = tailLines(buffer(MAX_TERMINAL_READ_LINES + 500));
		expect(out.content.split('\n')).toHaveLength(MAX_TERMINAL_READ_LINES);
		expect(out.totalLines).toBe(MAX_TERMINAL_READ_LINES + 500);
	});

	it('caps a caller asking for more than the maximum', () => {
		const out = tailLines(buffer(MAX_TERMINAL_READ_LINES + 500), 999_999);
		expect(out.content.split('\n')).toHaveLength(MAX_TERMINAL_READ_LINES);
	});

	it('handles an empty buffer', () => {
		const out = tailLines('', 100);
		expect(out.content).toBe('');
		expect(out.totalLines).toBe(1);
	});
});
