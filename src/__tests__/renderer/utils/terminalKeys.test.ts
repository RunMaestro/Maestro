/**
 * Tests for terminalKeys.ts - the shared PTY escape sequences and the
 * sticky-Ctrl control-code mapping used by the terminal touch key bar.
 */

import { describe, it, expect } from 'vitest';
import { TERMINAL_KEY_SEQUENCES, toControlChar } from '../../../renderer/utils/terminalKeys';

describe('TERMINAL_KEY_SEQUENCES', () => {
	it('maps each key bar button to the raw PTY byte sequence a hardware key would send', () => {
		expect(TERMINAL_KEY_SEQUENCES.esc).toBe('\x1b');
		expect(TERMINAL_KEY_SEQUENCES.tab).toBe('\t');
		expect(TERMINAL_KEY_SEQUENCES.enter).toBe('\r');
		expect(TERMINAL_KEY_SEQUENCES.up).toBe('\x1b[A');
		expect(TERMINAL_KEY_SEQUENCES.down).toBe('\x1b[B');
		expect(TERMINAL_KEY_SEQUENCES.left).toBe('\x1b[D');
		expect(TERMINAL_KEY_SEQUENCES.right).toBe('\x1b[C');
	});
});

describe('toControlChar', () => {
	it('folds lowercase letters onto their Ctrl code (\\x01-\\x1a)', () => {
		expect(toControlChar('a')).toBe('\x01');
		expect(toControlChar('c')).toBe('\x03'); // Ctrl-C
		expect(toControlChar('d')).toBe('\x04'); // Ctrl-D
		expect(toControlChar('z')).toBe('\x1a');
	});

	it('treats uppercase letters identically to lowercase', () => {
		expect(toControlChar('C')).toBe('\x03');
		expect(toControlChar('Z')).toBe('\x1a');
	});

	it('maps the classic control symbols @ [ \\ ] ^ _', () => {
		expect(toControlChar('@')).toBe('\x00'); // Ctrl-@ = NUL
		expect(toControlChar('[')).toBe('\x1b'); // Ctrl-[ = ESC
		expect(toControlChar('\\')).toBe('\x1c');
		expect(toControlChar(']')).toBe('\x1d');
		expect(toControlChar('^')).toBe('\x1e');
		expect(toControlChar('_')).toBe('\x1f'); // Ctrl-_
	});

	it('maps ? to DEL and space to NUL', () => {
		expect(toControlChar('?')).toBe('\x7f');
		expect(toControlChar(' ')).toBe('\x00');
	});

	it('passes through digits and other single chars with no control code', () => {
		expect(toControlChar('1')).toBe('1');
		expect(toControlChar('!')).toBe('!');
	});

	it('leaves multi-byte input untouched (paste / IME / escape sequences)', () => {
		expect(toControlChar('hello')).toBe('hello');
		expect(toControlChar('\x1b[A')).toBe('\x1b[A');
		expect(toControlChar('')).toBe('');
	});
});
