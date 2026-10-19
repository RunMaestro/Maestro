import { describe, expect, it } from 'vitest';
import {
	TERMINAL_HANDOFF_MAX_CHARS,
	buildTerminalReplay,
	capTerminalHandoff,
} from '../../shared/terminalReplay';

describe('buildTerminalReplay', () => {
	it('joins the buffer lines with CRLF so each starts at column 0', () => {
		expect(buildTerminalReplay('one\ntwo\n$ ')).toBe('one\r\ntwo\r\n$ ');
	});

	it('continues the last line with the raw tail, escape codes included', () => {
		expect(buildTerminalReplay('$', [' ls\r\n', '\x1b[1mfile\x1b[0m'])).toBe(
			'$ ls\r\n\x1b[1mfile\x1b[0m'
		);
	});

	it('is the tail alone for an empty buffer', () => {
		expect(buildTerminalReplay('', ['a', 'b'])).toBe('ab');
		expect(buildTerminalReplay('')).toBe('');
	});

	it('keeps the newest text past the cap', () => {
		const replay = buildTerminalReplay('x'.repeat(TERMINAL_HANDOFF_MAX_CHARS), ['END']);
		expect(replay.length).toBe(TERMINAL_HANDOFF_MAX_CHARS);
		expect(replay.endsWith('END')).toBe(true);
	});
});

describe('capTerminalHandoff', () => {
	it('returns short text unchanged', () => {
		expect(capTerminalHandoff('abc')).toBe('abc');
	});
});
