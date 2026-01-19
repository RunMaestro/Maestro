/**
 * Tests for shared string utility functions
 *
 * @file src/shared/stringUtils.ts
 */

import { describe, it, expect } from 'vitest';
import { stripAnsiCodes } from '../../shared/stringUtils';

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
});
