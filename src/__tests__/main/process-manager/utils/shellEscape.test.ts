import { describe, it, expect } from 'vitest';
import {
	escapeCmdArg,
	escapePowerShellArg,
	escapeCmdArgs,
	escapePowerShellArgs,
	isPowerShellShell,
	escapeArgsForShell,
	getWindowsShellForAgentExecution,
	escapePowerShellPromptContent,
} from '../../../../main/process-manager/utils/shellEscape';

describe('shellEscape', () => {
	describe('escapeCmdArg', () => {
		it('should not escape simple arguments', () => {
			expect(escapeCmdArg('hello')).toBe('hello');
			expect(escapeCmdArg('world123')).toBe('world123');
			expect(escapeCmdArg('file.txt')).toBe('file.txt');
		});

		it('should escape arguments with spaces', () => {
			expect(escapeCmdArg('hello world')).toBe('"hello world"');
			expect(escapeCmdArg('path with spaces')).toBe('"path with spaces"');
		});

		it('should escape arguments with special characters', () => {
			expect(escapeCmdArg('foo&bar')).toBe('"foo&bar"');
			expect(escapeCmdArg('foo|bar')).toBe('"foo|bar"');
			expect(escapeCmdArg('foo<bar')).toBe('"foo<bar"');
			expect(escapeCmdArg('foo>bar')).toBe('"foo>bar"');
		});

		it('should escape double quotes by doubling them', () => {
			expect(escapeCmdArg('say "hello"')).toBe('"say ""hello"""');
		});

		it('should escape carets by doubling them', () => {
			expect(escapeCmdArg('foo^bar')).toBe('"foo^^bar"');
		});

		it('should escape arguments with newlines', () => {
			expect(escapeCmdArg('line1\nline2')).toBe('"line1\nline2"');
			expect(escapeCmdArg('line1\r\nline2')).toBe('"line1\r\nline2"');
		});

		it('should escape long arguments', () => {
			const longArg = 'a'.repeat(150);
			expect(escapeCmdArg(longArg)).toBe(`"${longArg}"`);
		});
	});

	describe('escapePowerShellArg', () => {
		it('should not escape simple arguments', () => {
			expect(escapePowerShellArg('hello')).toBe('hello');
			expect(escapePowerShellArg('world123')).toBe('world123');
			expect(escapePowerShellArg('file.txt')).toBe('file.txt');
		});

		it('should escape arguments with spaces', () => {
			expect(escapePowerShellArg('hello world')).toBe("'hello world'");
		});

		it('should escape arguments with special characters', () => {
			expect(escapePowerShellArg('foo&bar')).toBe("'foo&bar'");
			expect(escapePowerShellArg('foo$bar')).toBe("'foo$bar'");
			expect(escapePowerShellArg('foo`bar')).toBe("'foo`bar'");
		});

		it('should escape single quotes by doubling them', () => {
			expect(escapePowerShellArg("it's")).toBe("'it''s'");
			expect(escapePowerShellArg("say 'hello'")).toBe("'say ''hello'''");
		});

		it('should escape arguments with PowerShell-specific characters', () => {
			expect(escapePowerShellArg('foo@bar')).toBe("'foo@bar'");
			expect(escapePowerShellArg('foo{bar}')).toBe("'foo{bar}'");
			expect(escapePowerShellArg('foo[bar]')).toBe("'foo[bar]'");
		});

		it('should escape long arguments', () => {
			const longArg = 'a'.repeat(150);
			expect(escapePowerShellArg(longArg)).toBe(`'${longArg}'`);
		});
	});

	describe('escapeCmdArgs', () => {
		it('should escape multiple arguments', () => {
			const result = escapeCmdArgs(['simple', 'with space', 'say "hi"']);
			expect(result).toEqual(['simple', '"with space"', '"say ""hi"""']);
		});
	});

	describe('escapePowerShellArgs', () => {
		it('should escape multiple arguments', () => {
			const result = escapePowerShellArgs(['simple', 'with space', "it's"]);
			expect(result).toEqual(['simple', "'with space'", "'it''s'"]);
		});
	});

	describe('isPowerShellShell', () => {
		it('should detect Windows PowerShell', () => {
			expect(isPowerShellShell('powershell.exe')).toBe(true);
			expect(
				isPowerShellShell('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
			).toBe(true);
			expect(isPowerShellShell('PowerShell.exe')).toBe(true);
		});

		it('should detect PowerShell Core (pwsh)', () => {
			expect(isPowerShellShell('pwsh')).toBe(true);
			expect(isPowerShellShell('pwsh.exe')).toBe(true);
			expect(isPowerShellShell('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe(true);
		});

		it('should not detect cmd.exe as PowerShell', () => {
			expect(isPowerShellShell('cmd.exe')).toBe(false);
			expect(isPowerShellShell('C:\\Windows\\System32\\cmd.exe')).toBe(false);
		});

		it('should handle undefined and empty strings', () => {
			expect(isPowerShellShell(undefined)).toBe(false);
			expect(isPowerShellShell('')).toBe(false);
		});
	});

	describe('escapeArgsForShell', () => {
		it('should use PowerShell escaping for PowerShell shells', () => {
			const result = escapeArgsForShell(['with space', "it's"], 'powershell.exe');
			expect(result).toEqual(["'with space'", "'it''s'"]);
		});

		it('should use cmd.exe escaping for cmd.exe shells', () => {
			const result = escapeArgsForShell(['with space', 'say "hi"'], 'cmd.exe');
			expect(result).toEqual(['"with space"', '"say ""hi"""']);
		});

		it('should default to cmd.exe escaping when no shell specified', () => {
			const result = escapeArgsForShell(['with space', 'say "hi"']);
			expect(result).toEqual(['"with space"', '"say ""hi"""']);
		});
	});

	describe('getWindowsShellForAgentExecution', () => {
		it('should prefer custom shell path when provided', () => {
			const result = getWindowsShellForAgentExecution({
				customShellPath: 'C:\\Custom\\MyShell.exe',
			});
			expect(result.shell).toBe('C:\\Custom\\MyShell.exe');
			expect(result.useShell).toBe(true);
			expect(result.source).toBe('custom');
		});

		it('should trim custom shell path', () => {
			const result = getWindowsShellForAgentExecution({
				customShellPath: '  C:\\Custom\\MyShell.exe  ',
			});
			expect(result.shell).toBe('C:\\Custom\\MyShell.exe');
			expect(result.source).toBe('custom');
		});

		it('should use current shell when provided and not cmd.exe', () => {
			const result = getWindowsShellForAgentExecution({
				currentShell: 'pwsh.exe',
			});
			expect(result.shell).toBe('pwsh.exe');
			expect(result.useShell).toBe(true);
			expect(result.source).toBe('current');
		});

		it('should skip cmd.exe as current shell and fall back to PowerShell', () => {
			const result = getWindowsShellForAgentExecution({
				currentShell: 'cmd.exe',
			});
			expect(result.shell).toContain('powershell');
			expect(result.useShell).toBe(true);
			expect(result.source).toBe('powershell-default');
		});

		it('should skip CMD.EXE (case insensitive) and fall back to PowerShell', () => {
			const result = getWindowsShellForAgentExecution({
				currentShell: 'C:\\Windows\\System32\\CMD.EXE',
			});
			expect(result.shell).toContain('powershell');
			expect(result.source).toBe('powershell-default');
		});

		it('should default to PowerShell when no options provided', () => {
			const result = getWindowsShellForAgentExecution();
			expect(result.shell).toContain('powershell');
			expect(result.useShell).toBe(true);
			expect(result.source).toBe('powershell-default');
		});

		it('should default to PowerShell when empty options provided', () => {
			const result = getWindowsShellForAgentExecution({});
			expect(result.shell).toContain('powershell');
			expect(result.source).toBe('powershell-default');
		});

		it('should ignore empty custom shell path', () => {
			const result = getWindowsShellForAgentExecution({
				customShellPath: '',
				currentShell: 'bash.exe',
			});
			expect(result.shell).toBe('bash.exe');
			expect(result.source).toBe('current');
		});

		it('should ignore whitespace-only custom shell path', () => {
			const result = getWindowsShellForAgentExecution({
				customShellPath: '   ',
				currentShell: 'bash.exe',
			});
			expect(result.shell).toBe('bash.exe');
			expect(result.source).toBe('current');
		});

		it('should prefer custom shell path over current shell', () => {
			const result = getWindowsShellForAgentExecution({
				customShellPath: 'C:\\Custom\\Shell.exe',
				currentShell: 'bash.exe',
			});
			expect(result.shell).toBe('C:\\Custom\\Shell.exe');
			expect(result.source).toBe('custom');
		});

		it('should use PSHOME environment variable when available', () => {
			// Save original PSHOME
			const originalPshome = process.env.PSHOME;

			try {
				process.env.PSHOME = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0';
				const result = getWindowsShellForAgentExecution({});
				expect(result.shell).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
				expect(result.source).toBe('powershell-default');
			} finally {
				// Restore original PSHOME
				if (originalPshome === undefined) {
					delete process.env.PSHOME;
				} else {
					process.env.PSHOME = originalPshome;
				}
			}
		});
	});

	describe('escapePowerShellPromptContent', () => {
		it('should not escape normal text', () => {
			expect(escapePowerShellPromptContent('Hello world')).toBe('Hello world');
			expect(escapePowerShellPromptContent('This is a regular sentence.')).toBe(
				'This is a regular sentence.'
			);
		});

		it('should escape lines starting with hyphen (dash)', () => {
			const input = 'Please do:\n- Run tests\n- Check logs';
			const expected = 'Please do:\n# - Run tests\n# - Check logs';
			expect(escapePowerShellPromptContent(input)).toBe(expected);
		});

		it('should escape lines starting with @ (array/splatting)', () => {
			const input = 'Array:\n@items\n@(1,2,3)';
			const expected = 'Array:\n# @items\n# @(1,2,3)';
			expect(escapePowerShellPromptContent(input)).toBe(expected);
		});

		it('should escape lines starting with $ (variable)', () => {
			const input = 'Variable:\n$var = "value"\n$x = 5';
			const expected = 'Variable:\n# $var = "value"\n# $x = 5';
			expect(escapePowerShellPromptContent(input)).toBe(expected);
		});

		it('should escape lines starting with + (plus operator)', () => {
			const input = 'Calculation:\n+ 2 + 2';
			const expected = 'Calculation:\n# + 2 + 2';
			expect(escapePowerShellPromptContent(input)).toBe(expected);
		});

		it('should escape lines starting with & (call operator)', () => {
			const input = 'Commands:\n& command.exe';
			const expected = 'Commands:\n# & command.exe';
			expect(escapePowerShellPromptContent(input)).toBe(expected);
		});

		it('should escape lines starting with | (pipe)', () => {
			const input = 'Pipeline:\n| Where-Object';
			const expected = 'Pipeline:\n# | Where-Object';
			expect(escapePowerShellPromptContent(input)).toBe(expected);
		});

		it('should escape lines starting with < > (redirection)', () => {
			const input = 'Redirect:\n< input.txt\n> output.txt';
			const expected = 'Redirect:\n# < input.txt\n# > output.txt';
			expect(escapePowerShellPromptContent(input)).toBe(expected);
		});

		it('should escape lines starting with brackets', () => {
			const input = 'Arrays:\n(1, 2, 3)\n[array]';
			const expected = 'Arrays:\n# (1, 2, 3)\n# [array]';
			expect(escapePowerShellPromptContent(input)).toBe(expected);
		});

		it('should handle leading whitespace before operator', () => {
			const input = 'Items:\n  - First item\n\t- Second item';
			const expected = 'Items:\n  # - First item\n\t# - Second item';
			expect(escapePowerShellPromptContent(input)).toBe(expected);
		});

		it('should escape markdown-style bullet lists', () => {
			const input = `Please follow these steps:
- Clone the repository
- Install dependencies
- Run the tests

Do not:
- Delete files
- Change config`;
			const expected = `Please follow these steps:
# - Clone the repository
# - Install dependencies
# - Run the tests

Do not:
# - Delete files
# - Change config`;
			expect(escapePowerShellPromptContent(input)).toBe(expected);
		});

		it('should handle mixed content with operators and normal text', () => {
			const input = 'Normal text\n- List item\nMore normal text\n$variable\nEnd';
			const expected = 'Normal text\n# - List item\nMore normal text\n# $variable\nEnd';
			expect(escapePowerShellPromptContent(input)).toBe(expected);
		});

		it('should escape lines starting with ! (history expansion)', () => {
			const input = 'History:\n! command';
			const expected = 'History:\n# ! command';
			expect(escapePowerShellPromptContent(input)).toBe(expected);
		});

		it('should escape lines starting with % (modulo/percent)', () => {
			const input = 'Percent:\n% 50';
			const expected = 'Percent:\n# % 50';
			expect(escapePowerShellPromptContent(input)).toBe(expected);
		});

		it('should escape lines starting with ^ (caret)', () => {
			const input = 'Caret:\n^ symbol';
			const expected = 'Caret:\n# ^ symbol';
			expect(escapePowerShellPromptContent(input)).toBe(expected);
		});

		it('should escape lines starting with backtick', () => {
			const input = 'Backtick:\n` escaping';
			const expected = 'Backtick:\n# ` escaping';
			expect(escapePowerShellPromptContent(input)).toBe(expected);
		});

		it('should escape lines starting with ; (statement separator)', () => {
			const input = 'Statements:\n; statement';
			const expected = 'Statements:\n# ; statement';
			expect(escapePowerShellPromptContent(input)).toBe(expected);
		});

		it('should escape lines starting with space followed by operator', () => {
			const input = 'Items:\n - Item one';
			const expected = 'Items:\n # - Item one';
			expect(escapePowerShellPromptContent(input)).toBe(expected);
		});

		it('should preserve empty lines', () => {
			const input = 'Line one\n\nLine two';
			const expected = 'Line one\n\nLine two';
			expect(escapePowerShellPromptContent(input)).toBe(expected);
		});

		it('should handle single-line input with special character', () => {
			expect(escapePowerShellPromptContent('- Single dash line')).toBe('# - Single dash line');
		});

		it('should handle complex group chat moderator response', () => {
			const input = `Here's what I need from you:
- Run the test suite
- Check the logs
- Report any errors

Please prioritize:
1. First, run tests
2. Then check logs
3. Finally report

Use these options:
- --verbose
- --debug
- --force`;
			const expected = `Here's what I need from you:
# - Run the test suite
# - Check the logs
# - Report any errors

Please prioritize:
1. First, run tests
2. Then check logs
3. Finally report

Use these options:
# - --verbose
# - --debug
# - --force`;
			expect(escapePowerShellPromptContent(input)).toBe(expected);
		});
	});
});
