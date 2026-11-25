/**
 * Tests for shared string utility functions
 *
 * @file src/shared/stringUtils.ts
 */

import { describe, it, expect } from 'vitest';
import {
	revealHiddenCharacters,
	safeDecodeURIComponent,
	stripAnsiCodes,
} from '../../shared/stringUtils';

describe('stripAnsiCodes', () => {
	it('should return empty string for empty input', () => {
		expect(stripAnsiCodes('')).toBe('');
	});

	it('should return text unchanged when no ANSI codes present', () => {
		expect(stripAnsiCodes('Hello, World!')).toBe('Hello, World!');
		expect(stripAnsiCodes('No escape codes here')).toBe('No escape codes here');
	});

	it('should strip basic color codes', () => {
		// Red text
		expect(stripAnsiCodes('\x1b[31mRed text\x1b[0m')).toBe('Red text');
		// Green text
		expect(stripAnsiCodes('\x1b[32mGreen text\x1b[0m')).toBe('Green text');
		// Blue text
		expect(stripAnsiCodes('\x1b[34mBlue text\x1b[0m')).toBe('Blue text');
	});

	it('should strip reset codes', () => {
		expect(stripAnsiCodes('\x1b[0mReset')).toBe('Reset');
		expect(stripAnsiCodes('Text\x1b[0m')).toBe('Text');
	});

	it('should strip bold and other style codes', () => {
		// Bold
		expect(stripAnsiCodes('\x1b[1mBold\x1b[0m')).toBe('Bold');
		// Italic
		expect(stripAnsiCodes('\x1b[3mItalic\x1b[0m')).toBe('Italic');
		// Underline
		expect(stripAnsiCodes('\x1b[4mUnderline\x1b[0m')).toBe('Underline');
	});

	it('should strip combined style and color codes', () => {
		// Bold + Red
		expect(stripAnsiCodes('\x1b[1;31mBold Red\x1b[0m')).toBe('Bold Red');
		// Bold + Green + Underline
		expect(stripAnsiCodes('\x1b[1;32;4mStyled\x1b[0m')).toBe('Styled');
	});

	it('should strip multiple codes in sequence', () => {
		const input = '\x1b[32mGreen\x1b[0m and \x1b[34mBlue\x1b[0m text';
		expect(stripAnsiCodes(input)).toBe('Green and Blue text');
	});

	it('should strip codes at various positions', () => {
		// Code at start
		expect(stripAnsiCodes('\x1b[31mStart')).toBe('Start');
		// Code at end
		expect(stripAnsiCodes('End\x1b[0m')).toBe('End');
		// Code in middle
		expect(stripAnsiCodes('Before\x1b[31mAfter')).toBe('BeforeAfter');
	});

	it('should strip 256-color codes', () => {
		// Foreground 256 color
		expect(stripAnsiCodes('\x1b[38;5;196mRed 256\x1b[0m')).toBe('Red 256');
		// Background 256 color
		expect(stripAnsiCodes('\x1b[48;5;21mBg Blue\x1b[0m')).toBe('Bg Blue');
	});

	it('should strip RGB/true color codes', () => {
		// RGB foreground
		expect(stripAnsiCodes('\x1b[38;2;255;0;0mRGB Red\x1b[0m')).toBe('RGB Red');
		// RGB background
		expect(stripAnsiCodes('\x1b[48;2;0;0;255mRGB Bg\x1b[0m')).toBe('RGB Bg');
	});

	it('should strip cursor movement codes', () => {
		// Cursor up
		expect(stripAnsiCodes('\x1b[2AUp')).toBe('Up');
		// Cursor down
		expect(stripAnsiCodes('\x1b[3BDown')).toBe('Down');
		// Cursor forward
		expect(stripAnsiCodes('\x1b[4CForward')).toBe('Forward');
		// Cursor back
		expect(stripAnsiCodes('\x1b[5DBack')).toBe('Back');
	});

	it('should strip erase codes', () => {
		// Erase line
		expect(stripAnsiCodes('\x1b[2KLine')).toBe('Line');
		// Erase screen
		expect(stripAnsiCodes('\x1b[2JScreen')).toBe('Screen');
	});

	it('should handle real terminal output scenarios', () => {
		// npm/yarn style progress
		const npmOutput = '\x1b[32m✓\x1b[0m Package installed successfully';
		expect(stripAnsiCodes(npmOutput)).toBe('✓ Package installed successfully');

		// Git diff style
		const gitDiff = '\x1b[32m+added line\x1b[0m\n\x1b[31m-removed line\x1b[0m';
		expect(stripAnsiCodes(gitDiff)).toBe('+added line\n-removed line');

		// Error message with color
		const error = '\x1b[31mError:\x1b[0m Something went wrong';
		expect(stripAnsiCodes(error)).toBe('Error: Something went wrong');
	});

	it('should preserve newlines and whitespace', () => {
		const input = '\x1b[32mLine 1\x1b[0m\n\x1b[32mLine 2\x1b[0m\n  Indented';
		expect(stripAnsiCodes(input)).toBe('Line 1\nLine 2\n  Indented');
	});

	it('should handle empty escape sequences', () => {
		// Just ESC[ with immediate command (edge case)
		expect(stripAnsiCodes('\x1b[mText')).toBe('Text');
	});

	it('should strip DEC private mode and keypad control sequences', () => {
		const input = '\x1b[?1h\x1b=\x1b[?2004hRemote ready\x1b[?2004l\x1b>';
		expect(stripAnsiCodes(input)).toBe('Remote ready');
	});

	it('should preserve unicode characters', () => {
		expect(stripAnsiCodes('\x1b[32m🚀 Rocket\x1b[0m')).toBe('🚀 Rocket');
		expect(stripAnsiCodes('\x1b[31m日本語\x1b[0m')).toBe('日本語');
	});

	it('should handle consecutive escape sequences', () => {
		expect(stripAnsiCodes('\x1b[0m\x1b[1m\x1b[32mText')).toBe('Text');
		expect(stripAnsiCodes('\x1b[31m\x1b[32m\x1b[34mBlue')).toBe('Blue');
	});

	// iTerm2/SSH shell integration sequence tests
	describe('iTerm2 shell integration sequences', () => {
		it('should strip bare ]1337; sequences chained together (SSH output)', () => {
			// Real example from SSH connections - sequences without ESC prefix, chained together
			const input =
				']1337;RemoteHost=pedram@PedTome.local]1337;CurrentDir=/Users/pedram]1337;ShellIntegrationVersion=13;shell=zsh/opt/homebrew/bin/codex';
			expect(stripAnsiCodes(input)).toBe('/opt/homebrew/bin/codex');
		});

		it('should strip ]1337; sequences with ESC prefix and BEL terminator', () => {
			const input = '\x1b]1337;RemoteHost=user@host\x07/usr/bin/claude';
			expect(stripAnsiCodes(input)).toBe('/usr/bin/claude');
		});

		it('should strip ]1337;CurrentDir sequences with BEL terminator', () => {
			const input = ']1337;CurrentDir=/home/user\x07/usr/local/bin/codex';
			expect(stripAnsiCodes(input)).toBe('/usr/local/bin/codex');
		});

		it('should strip multiple chained sequences with different keys', () => {
			const input =
				']1337;RemoteHost=user@host]1337;CurrentDir=/home/user]1337;ShellIntegrationVersion=13;shell=bash/path/to/binary';
			expect(stripAnsiCodes(input)).toBe('/path/to/binary');
		});

		it('should strip sequences mixed with ANSI color codes', () => {
			const input = '\x1b[32m\x1b]1337;CurrentDir=/home\x07\x1b[0m/usr/bin/test';
			expect(stripAnsiCodes(input)).toBe('/usr/bin/test');
		});

		it('should handle standalone iTerm2 sequences', () => {
			// Sequence followed by nothing
			const input = ']1337;RemoteHost=user@host';
			expect(stripAnsiCodes(input)).toBe('');
		});

		it('should strip sequences with only terminators', () => {
			const input = '\x1b]1337;RemoteHost=user@host\x07\x1b]1337;CurrentDir=/home\x07';
			expect(stripAnsiCodes(input)).toBe('');
		});

		it('should handle VSCode shell integration sequences (]133;)', () => {
			const input = ']133;A\x07prompt\x1b]133;B\x07output';
			expect(stripAnsiCodes(input)).toBe('promptoutput');
		});

		it('should handle current directory sequences (]7;)', () => {
			const input = ']7;file:///home/user/project\x07content';
			expect(stripAnsiCodes(input)).toBe('content');
		});

		it('should handle sequences on multiple lines', () => {
			const input =
				'\x1b]1337;CurrentDir=/home\x07/usr/bin/codex\n\x1b]1337;CurrentDir=/home\x07/usr/bin/claude';
			expect(stripAnsiCodes(input)).toBe('/usr/bin/codex\n/usr/bin/claude');
		});

		it('should strip BEL character alone', () => {
			expect(stripAnsiCodes('Text\x07More')).toBe('TextMore');
		});

		it('should handle real SSH session init output', () => {
			// Simulates what appears when SSH shell integration emits sequences at session start
			const input =
				']1337;RemoteHost=pedram@PedTome.local]1337;CurrentDir=/Users/pedram]1337;ShellIntegrationVersion=13;shell=zsh{"type":"system","subtype":"init"}';
			expect(stripAnsiCodes(input)).toBe('{"type":"system","subtype":"init"}');
		});
	});

	describe('safeDecodeURIComponent', () => {
		it('decodes well-formed percent escapes', () => {
			expect(safeDecodeURIComponent('my%20file.ts')).toBe('my file.ts');
			expect(safeDecodeURIComponent('%E4%B8%AD%E6%96%87.md')).toBe('\u4e2d\u6587.md');
		});

		it('returns the raw string for malformed escapes instead of throwing', () => {
			// decodeURIComponent throws URIError on each of these. A stray '%' is
			// ordinary prose ("100% done"), so markdown link targets hit it. MAESTRO-XS
			expect(safeDecodeURIComponent('100% done.md')).toBe('100% done.md');
			expect(safeDecodeURIComponent('%')).toBe('%');
			expect(safeDecodeURIComponent('%ZZ')).toBe('%ZZ');
			expect(safeDecodeURIComponent('%E0%A4%A')).toBe('%E0%A4%A');
		});

		it('leaves strings with no escapes untouched', () => {
			expect(safeDecodeURIComponent('plain.md')).toBe('plain.md');
			expect(safeDecodeURIComponent('')).toBe('');
		});

		it('terminates (guards against a self-recursive implementation)', () => {
			// A previous copy of this helper called itself instead of
			// decodeURIComponent, blowing the stack and silently returning the
			// undecoded input via its own catch.
			expect(safeDecodeURIComponent('a%20b')).toBe('a b');
		});
	});
});

describe('safeDecodeURIComponent', () => {
	it('should decode well-formed percent encoding', () => {
		expect(safeDecodeURIComponent('my%20file.md')).toBe('my file.md');
		expect(safeDecodeURIComponent('%2Fa%2Fb.md')).toBe('/a/b.md');
		expect(safeDecodeURIComponent('caf%C3%A9')).toBe('café');
	});

	it('should return the original value for malformed percent encoding', () => {
		expect(safeDecodeURIComponent('100%')).toBe('100%');
		expect(safeDecodeURIComponent('%')).toBe('%');
		expect(safeDecodeURIComponent('%zz')).toBe('%zz');
		expect(safeDecodeURIComponent('%E0%A4%A')).toBe('%E0%A4%A');
		expect(safeDecodeURIComponent('C:\\temp\\50%off')).toBe('C:\\temp\\50%off');
	});

	it('should pass through strings with nothing to decode', () => {
		expect(safeDecodeURIComponent('')).toBe('');
		expect(safeDecodeURIComponent('plain-text')).toBe('plain-text');
	});

	// Only URIError means "this was not valid encoding". Anything else is a real
	// fault and must reach Sentry rather than be silently returned as the input.
	it('rethrows a non-URIError so it is not silently swallowed', () => {
		const boom = new RangeError('unexpected');
		const spy = vi.spyOn(globalThis, 'decodeURIComponent').mockImplementation(() => {
			throw boom;
		});
		try {
			expect(() => safeDecodeURIComponent('anything')).toThrow(boom);
		} finally {
			spy.mockRestore();
		}
	});
});

describe('revealHiddenCharacters', () => {
	// Built from code points: a typed escape of a printable character can reach
	// disk as the character itself, and the point here is which bytes are in.
	const ch = (codePoint: number) => String.fromCodePoint(codePoint);
	const mark = (hex: string) => `${ch(0x27e8)}U+${hex}${ch(0x27e9)}`;
	/** Anything the helper must never leave in its output, besides tab and LF. */
	const HIDDEN = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;
	const leftovers = (text: string) => text.replace(/[\t\n]/g, '').match(HIDDEN);

	it('leaves ordinary code alone, tabs and line breaks included', () => {
		const code = 'function f() {\n\treturn document.title;\n}\n';
		expect(revealHiddenCharacters(code)).toEqual({ text: code, hiddenCount: 0 });
		expect(revealHiddenCharacters('')).toEqual({ text: '', hiddenCount: 0 });
	});

	it('shows a Windows line ending as one plain line break', () => {
		expect(revealHiddenCharacters('a();\r\nb();')).toEqual({ text: 'a();\nb();', hiddenCount: 0 });
	});

	it('marks a lone CR and breaks the line there, as JavaScript does', () => {
		// A `//` comment ends at the CR, so `steal()` runs. In a text block the CR
		// reads as a space and the call looks like part of the comment.
		const { text, hiddenCount } = revealHiddenCharacters('// read the title\rsteal();');
		expect(text).toBe(`// read the title${mark('000D')}\nsteal();`);
		expect(hiddenCount).toBe(1);
	});

	it('marks the line and paragraph separators and breaks the line after each', () => {
		const { text, hiddenCount } = revealHiddenCharacters(`a${ch(0x2028)}b${ch(0x2029)}c`);
		expect(text).toBe(`a${mark('2028')}\nb${mark('2029')}\nc`);
		expect(hiddenCount).toBe(2);
	});

	it('marks bidi controls so they cannot reorder what the reader sees', () => {
		const embeddingsAndIsolates = [
			0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
		];
		const directionMarks = [0x200e, 0x200f, 0x061c];
		const all = [...embeddingsAndIsolates, ...directionMarks];
		const source = `/* ok ${all.map(ch).join('')} */ run();`;
		const { text, hiddenCount } = revealHiddenCharacters(source);
		expect(hiddenCount).toBe(all.length);
		expect(text).toBe(
			`/* ok ${all.map((cp) => mark(cp.toString(16).toUpperCase().padStart(4, '0'))).join('')} */ run();`
		);
		expect(leftovers(text)).toBeNull();
	});

	it('marks zero-width characters, the byte order mark, and the soft hyphen', () => {
		const { text, hiddenCount } = revealHiddenCharacters(
			`${ch(0xfeff)}a${ch(0x200b)}b${ch(0x200c)}c${ch(0x200d)}d${ch(0x2060)}e${ch(0x00ad)}f`
		);
		expect(text).toBe(
			`${mark('FEFF')}a${mark('200B')}b${mark('200C')}c${mark('200D')}d${mark('2060')}e${mark('00AD')}f`
		);
		expect(hiddenCount).toBe(6);
	});

	it('marks a Hangul filler, a blank-looking but legal JavaScript identifier', () => {
		const { text, hiddenCount } = revealHiddenCharacters(
			`const { a,${ch(0x3164)} } = q; run(${ch(0x3164)});`
		);
		expect(text).toBe(`const { a,${mark('3164')} } = q; run(${mark('3164')});`);
		expect(hiddenCount).toBe(2);
	});

	it('marks controls, a tag character as one code point, and a lone surrogate', () => {
		const source = `${ch(0x00)}${ch(0x1b)}${ch(0x7f)}${ch(0x85)}${ch(0xe0041)}${String.fromCharCode(0xd800)}`;
		const { text, hiddenCount } = revealHiddenCharacters(source);
		expect(text).toBe(
			`${mark('0000')}${mark('001B')}${mark('007F')}${mark('0085')}${mark('E0041')}${mark('D800')}`
		);
		expect(hiddenCount).toBe(6);
	});

	it('keeps visible characters, including non-ASCII ones and plain spaces', () => {
		const visible = `caf${ch(0xe9)} ${ch(0x65e5)}${ch(0x672c)} ${ch(0x1f600)}${ch(0xa0)}x`;
		expect(revealHiddenCharacters(visible)).toEqual({ text: visible, hiddenCount: 0 });
	});
});
