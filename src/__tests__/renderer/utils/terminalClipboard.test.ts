/**
 * Tests for parseOsc52 - the wire format a program in a PTY uses to ask the
 * terminal to copy text. This is what makes "press c to copy" work in a TUI
 * running inside a Maestro terminal, local or over SSH.
 */

import { describe, it, expect } from 'vitest';
import { OSC52_MAX_TEXT_BYTES, parseOsc52 } from '../../../renderer/utils/terminalClipboard';

/** Base64 of a string's UTF-8 bytes, which is what a program actually sends. */
function encode(text: string): string {
	return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

describe('parseOsc52', () => {
	it('decodes a clipboard write', () => {
		expect(parseOsc52(`c;${encode('hello')}`)).toEqual({ kind: 'write', text: 'hello' });
	});

	it('treats every selection target as the system clipboard', () => {
		const payload = encode('primary');
		expect(parseOsc52(`p;${payload}`)).toEqual({ kind: 'write', text: 'primary' });
		expect(parseOsc52(`;${payload}`)).toEqual({ kind: 'write', text: 'primary' });
		expect(parseOsc52(`pc;${payload}`)).toEqual({ kind: 'write', text: 'primary' });
	});

	it('decodes the payload as UTF-8 rather than one char per byte', () => {
		const text = 'naïve café ✓ 日本語';
		expect(parseOsc52(`c;${encode(text)}`)).toEqual({ kind: 'write', text });
	});

	it('keeps a long URL whole', () => {
		const url = `https://claude.com/cai/oauth/authorize?code=true&state=${'x'.repeat(400)}`;
		expect(parseOsc52(`c;${encode(url)}`)).toEqual({ kind: 'write', text: url });
	});

	it('accepts a payload sent without base64 padding', () => {
		expect(parseOsc52('c;aGVsbG8')).toEqual({ kind: 'write', text: 'hello' });
	});

	it('reports a clipboard query so the caller can refuse it', () => {
		expect(parseOsc52('c;?')).toEqual({ kind: 'query' });
	});

	it('ignores a request to clear the clipboard', () => {
		expect(parseOsc52('c;')).toEqual({ kind: 'ignore' });
	});

	it('ignores a body with no payload separator', () => {
		expect(parseOsc52('c')).toEqual({ kind: 'ignore' });
		expect(parseOsc52('')).toEqual({ kind: 'ignore' });
	});

	it('ignores a payload that is not base64', () => {
		expect(parseOsc52('c;not base64!!')).toEqual({ kind: 'ignore' });
	});

	it('ignores a payload over the size cap without decoding it', () => {
		const oversized = 'A'.repeat(Math.ceil(OSC52_MAX_TEXT_BYTES / 3) * 4 + 4);
		expect(parseOsc52(`c;${oversized}`)).toEqual({ kind: 'ignore' });
	});
});
