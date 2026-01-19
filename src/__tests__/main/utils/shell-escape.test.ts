import { describe, it, expect } from 'vitest';
import { shellEscape, shellEscapeArgs, buildShellCommand } from '../../../main/utils/shell-escape';

describe('shell-escape', () => {
	describe('shellEscape', () => {
		it('handles empty string', () => {
			expect(shellEscape('')).toBe("''");
		});

		it('wraps simple strings in single quotes', () => {
			expect(shellEscape('hello')).toBe("'hello'");
			expect(shellEscape('hello world')).toBe("'hello world'");
		});

		it('escapes single quotes within strings', () => {
			expect(shellEscape("it's")).toBe("'it'\\''s'");
			expect(shellEscape("don't")).toBe("'don'\\''t'");
			expect(shellEscape("'quoted'")).toBe("''\\''quoted'\\'''");
		});

		it('prevents variable expansion', () => {
			expect(shellEscape('$HOME')).toBe("'$HOME'");
			expect(shellEscape('${PATH}')).toBe("'${PATH}'");
		});

		it('prevents command substitution', () => {
			expect(shellEscape('$(whoami)')).toBe("'$(whoami)'");
			expect(shellEscape('`uname`')).toBe("'`uname`'");
		});

		it('handles special shell characters', () => {
			expect(shellEscape('foo; rm -rf /')).toBe("'foo; rm -rf /'");
			expect(shellEscape('foo | bar')).toBe("'foo | bar'");
			expect(shellEscape('foo && bar')).toBe("'foo && bar'");
			expect(shellEscape('foo > /dev/null')).toBe("'foo > /dev/null'");
			expect(shellEscape('$(cat /etc/passwd)')).toBe("'$(cat /etc/passwd)'");
		});

		it('handles newlines and tabs', () => {
			expect(shellEscape('line1\nline2')).toBe("'line1\nline2'");
			expect(shellEscape('col1\tcol2')).toBe("'col1\tcol2'");
		});

		it('handles unicode characters', () => {
			expect(shellEscape('hello')).toBe("'hello'");
			expect(shellEscape('')).toBe("''");
		});
	});

	describe('shellEscapeArgs', () => {
		it('escapes an array of arguments', () => {
			const result = shellEscapeArgs(['hello', 'world', "it's"]);
			expect(result).toEqual(["'hello'", "'world'", "'it'\\''s'"]);
		});

		it('handles empty array', () => {
			expect(shellEscapeArgs([])).toEqual([]);
		});
	});

	describe('buildShellCommand', () => {
		it('builds a command with escaped arguments', () => {
			const result = buildShellCommand('echo', ['hello', 'world']);
			expect(result).toBe("echo 'hello' 'world'");
		});

		it('handles empty arguments', () => {
			const result = buildShellCommand('ls', []);
			expect(result).toBe('ls');
		});

		it('escapes dangerous arguments', () => {
			const result = buildShellCommand('echo', ['hello; rm -rf /']);
			expect(result).toBe("echo 'hello; rm -rf /'");
		});

		it('handles complex command with multiple arguments', () => {
			const result = buildShellCommand('git', ['commit', '-m', "fix: it's working"]);
			expect(result).toBe("git 'commit' '-m' 'fix: it'\\''s working'");
		});
	});
});
