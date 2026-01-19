import { describe, it, expect } from 'vitest';
import { stripAnsi } from '../../../main/utils/stripAnsi';

describe('stripAnsi', () => {
	it('returns plain text unchanged', () => {
		expect(stripAnsi('hello world')).toBe('hello world');
		expect(stripAnsi('/opt/homebrew/bin/codex')).toBe('/opt/homebrew/bin/codex');
	});

	it('strips standard ANSI color codes', () => {
		expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
		expect(stripAnsi('\x1b[1;32mbold green\x1b[0m')).toBe('bold green');
	});

	it('strips iTerm2 shell integration OSC sequences - real world example', () => {
		// Real-world example from SSH with interactive shell
		// The sequences are: ]1337;RemoteHost=..., ]1337;CurrentDir=..., ]1337;ShellIntegrationVersion=...;shell=zsh
		// followed immediately by the actual path
		const input =
			']1337;RemoteHost=pedram@PedTome.local]1337;CurrentDir=/Users/pedram]1337;ShellIntegrationVersion=13;shell=zsh/opt/homebrew/bin/codex';
		expect(stripAnsi(input)).toBe('/opt/homebrew/bin/codex');
	});

	it('strips OSC sequences with ESC prefix and BEL terminator', () => {
		const input = '\x1b]1337;RemoteHost=user@host\x07/usr/bin/claude';
		expect(stripAnsi(input)).toBe('/usr/bin/claude');
	});

	it('strips bare OSC sequences terminated with BEL', () => {
		const input = ']1337;CurrentDir=/home/user\x07/usr/local/bin/codex';
		expect(stripAnsi(input)).toBe('/usr/local/bin/codex');
	});

	it('handles multiple consecutive OSC sequences', () => {
		// Three consecutive sequences followed by a path
		// Note: CurrentDir value ends at ] not at /, so /home/user is the value
		const input =
			']1337;RemoteHost=user@host]1337;CurrentDir=/home/user]1337;ShellIntegrationVersion=13;shell=bash/path/to/binary';
		expect(stripAnsi(input)).toBe('/path/to/binary');
	});

	it('handles mixed ANSI and OSC sequences with ESC prefix', () => {
		const input = '\x1b[32m\x1b]1337;CurrentDir=/home\x07\x1b[0m/usr/bin/test';
		expect(stripAnsi(input)).toBe('/usr/bin/test');
	});

	it('handles empty string', () => {
		expect(stripAnsi('')).toBe('');
	});

	it('handles string with only escape sequences', () => {
		// Two sequences with no actual content at the end
		const input = '\x1b]1337;RemoteHost=user@host\x07\x1b]1337;CurrentDir=/home\x07';
		expect(stripAnsi(input)).toBe('');
	});

	it('preserves newlines in output', () => {
		// Multiple lines with clean paths
		const input = '/usr/bin/codex\n/usr/bin/claude';
		expect(stripAnsi(input)).toBe('/usr/bin/codex\n/usr/bin/claude');
	});

	it('handles sequences before each line in multiline output', () => {
		// Each line has its own OSC prefix
		const input =
			'\x1b]1337;CurrentDir=/home\x07/usr/bin/codex\n\x1b]1337;CurrentDir=/home\x07/usr/bin/claude';
		expect(stripAnsi(input)).toBe('/usr/bin/codex\n/usr/bin/claude');
	});
});
