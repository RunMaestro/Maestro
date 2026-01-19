/**
 * Tests for terminal filter utilities
 * @file src/__tests__/main/utils/terminalFilter.test.ts
 */

import { describe, it, expect } from 'vitest';
import {
	stripControlSequences,
	stripAllAnsiCodes,
	isCommandEcho,
	extractCommand,
} from '../../../main/utils/terminalFilter';

describe('terminalFilter', () => {
	describe('stripControlSequences', () => {
		describe('OSC (Operating System Command) sequences', () => {
			it('should remove window title sequences (ESC ] ... BEL)', () => {
				const input = '\x1b]0;Terminal Title\x07Some content';
				const result = stripControlSequences(input);
				expect(result).toBe('Some content');
			});

			it('should remove window title sequences with ST terminator (ESC ] ... ESC \\)', () => {
				const input = '\x1b]0;Terminal Title\x1b\\Some content';
				const result = stripControlSequences(input);
				expect(result).toBe('Some content');
			});

			it('should remove hyperlink OSC sequences', () => {
				const input = '\x1b]8;;http://example.com\x07Click here\x1b]8;;\x07';
				const result = stripControlSequences(input);
				expect(result).toBe('Click here');
			});

			it('should remove numbered OSC sequences', () => {
				const input = '\x1b]1;icon-name\x07text\x1b]2;title\x07more';
				const result = stripControlSequences(input);
				expect(result).toBe('textmore');
			});
		});

		describe('CSI (Control Sequence Introducer) sequences', () => {
			it('should remove cursor up (A)', () => {
				const input = 'text\x1b[1Amore';
				const result = stripControlSequences(input);
				expect(result).toBe('textmore');
			});

			it('should remove cursor down (B)', () => {
				const input = 'text\x1b[1Bmore';
				const result = stripControlSequences(input);
				expect(result).toBe('textmore');
			});

			it('should remove cursor forward (C)', () => {
				const input = 'text\x1b[5Cmore';
				const result = stripControlSequences(input);
				expect(result).toBe('textmore');
			});

			it('should remove cursor back (D)', () => {
				const input = 'text\x1b[3Dmore';
				const result = stripControlSequences(input);
				expect(result).toBe('textmore');
			});

			it('should remove cursor position (H)', () => {
				const input = 'text\x1b[10;20Hmore';
				const result = stripControlSequences(input);
				expect(result).toBe('textmore');
			});

			it('should remove cursor position (f)', () => {
				const input = 'text\x1b[5;10fmore';
				const result = stripControlSequences(input);
				expect(result).toBe('textmore');
			});

			it('should remove erase in display (J)', () => {
				const input = 'text\x1b[2Jmore';
				const result = stripControlSequences(input);
				expect(result).toBe('textmore');
			});

			it('should remove erase in line (K)', () => {
				const input = 'text\x1b[0Kmore';
				const result = stripControlSequences(input);
				expect(result).toBe('textmore');
			});

			it('should remove scroll up (S)', () => {
				const input = 'text\x1b[3Smore';
				const result = stripControlSequences(input);
				expect(result).toBe('textmore');
			});

			it('should remove scroll down (T)', () => {
				const input = 'text\x1b[2Tmore';
				const result = stripControlSequences(input);
				expect(result).toBe('textmore');
			});

			it('should remove DECSET/DECRST sequences (h and l) without ?', () => {
				// The regex only matches CSI sequences without ? prefix
				// ?25h (show cursor) and ?25l (hide cursor) are not matched
				const input = '\x1b[25hvisible\x1b[25l';
				const result = stripControlSequences(input);
				expect(result).toBe('visible');
			});

			it('should preserve DECSET/DECRST private mode sequences with ?', () => {
				// The current implementation does NOT remove private mode sequences (with ?)
				// This is intentional to preserve certain terminal features
				const input = '\x1b[?25hvisible\x1b[?25l';
				const result = stripControlSequences(input);
				expect(result).toBe('\x1b[?25hvisible\x1b[?25l');
			});

			it('should remove soft cursor sequences (p)', () => {
				const input = 'text\x1b[0pmore';
				const result = stripControlSequences(input);
				expect(result).toBe('textmore');
			});

			it('should NOT remove SGR color codes (m)', () => {
				const input = '\x1b[32mGreen Text\x1b[0m';
				const result = stripControlSequences(input);
				expect(result).toBe('\x1b[32mGreen Text\x1b[0m');
			});

			it('should preserve complex SGR sequences', () => {
				const input = '\x1b[1;4;32mBold Underline Green\x1b[0m';
				const result = stripControlSequences(input);
				expect(result).toBe('\x1b[1;4;32mBold Underline Green\x1b[0m');
			});
		});

		describe('shell integration markers', () => {
			it('should remove VSCode shell integration (ESC ] 133 ; ...)', () => {
				const input = '\x1b]133;A\x07prompt\x1b]133;B\x07\x1b]133;C\x07output\x1b]133;D;0\x07';
				const result = stripControlSequences(input);
				expect(result).toBe('promptoutput');
			});

			it('should remove iTerm2 shell integration (ESC ] 1337 ; ...)', () => {
				const input = '\x1b]1337;SetUserVar=foo=bar\x07content';
				const result = stripControlSequences(input);
				expect(result).toBe('content');
			});

			it('should remove current working directory (ESC ] 7 ; ...)', () => {
				const input = '\x1b]7;file:///Users/test\x07pwd';
				const result = stripControlSequences(input);
				expect(result).toBe('pwd');
			});

			it('should remove bare ]1337; sequences chained together (SSH output)', () => {
				// Real example from SSH connections - sequences without ESC prefix, chained together
				const input =
					']1337;RemoteHost=pedram@PedTome.local]1337;CurrentDir=/Users/pedram]1337;ShellIntegrationVersion=13;shell=zsh/opt/homebrew/bin/codex';
				const result = stripControlSequences(input);
				expect(result).toBe('/opt/homebrew/bin/codex');
			});

			it('should remove bare ]1337; sequences with BEL terminator', () => {
				const input = ']1337;CurrentDir=/home/user\x07/usr/local/bin/codex';
				const result = stripControlSequences(input);
				expect(result).toBe('/usr/local/bin/codex');
			});

			it('should handle real SSH session init output', () => {
				// Simulates what appears when SSH shell integration emits sequences at session start
				const input =
					']1337;RemoteHost=pedram@PedTome.local]1337;CurrentDir=/Users/pedram]1337;ShellIntegrationVersion=13;shell=zsh{"type":"system","subtype":"init"}';
				const result = stripControlSequences(input);
				expect(result).toBe('{"type":"system","subtype":"init"}');
			});

			it('should remove bare ]133; sequences (VSCode)', () => {
				const input = ']133;A\x07prompt]133;B\x07output';
				const result = stripControlSequences(input);
				expect(result).toBe('promptoutput');
			});

			it('should remove bare ]7; sequences', () => {
				const input = ']7;file:///home/user/project\x07content';
				const result = stripControlSequences(input);
				expect(result).toBe('content');
			});
		});

		describe('other escape sequences', () => {
			it('should remove soft hyphen', () => {
				const input = 'hyphen\u00ADated';
				const result = stripControlSequences(input);
				expect(result).toBe('hyphenated');
			});

			it('should convert CRLF to LF', () => {
				const input = 'line1\r\nline2\r\n';
				const result = stripControlSequences(input);
				expect(result).toBe('line1\nline2\n');
			});

			it('should remove character set sequences', () => {
				const input = '\x1b(B\x1b)0text';
				const result = stripControlSequences(input);
				expect(result).toBe('text');
			});

			it('should remove BEL character', () => {
				const input = 'alert\x07text';
				const result = stripControlSequences(input);
				expect(result).toBe('alerttext');
			});

			it('should remove control characters (0x00-0x1F except newline, tab, escape)', () => {
				const input = 'text\x00\x01\x02\x03more';
				const result = stripControlSequences(input);
				expect(result).toBe('textmore');
			});

			it('should preserve newlines', () => {
				const input = 'line1\nline2';
				const result = stripControlSequences(input);
				expect(result).toBe('line1\nline2');
			});

			it('should preserve tabs', () => {
				const input = 'col1\tcol2';
				const result = stripControlSequences(input);
				expect(result).toBe('col1\tcol2');
			});
		});

		describe('terminal mode filtering (isTerminal = true)', () => {
			describe('shell prompt patterns', () => {
				it('should remove [user:~/path] format prompts', () => {
					const input = '[pedram:~/Projects]\n[pedram:~/Projects]$ ls\nfile1.txt';
					const result = stripControlSequences(input, undefined, true);
					expect(result).toBe('file1.txt');
				});

				it('should remove user@host:~$ format prompts', () => {
					const input = 'pedram@macbook:~$\nsome output';
					const result = stripControlSequences(input, undefined, true);
					expect(result).toBe('some output');
				});

				it('should remove user@host:~# format prompts (root)', () => {
					const input = 'root@server:~#\nsome output';
					const result = stripControlSequences(input, undefined, true);
					expect(result).toBe('some output');
				});

				it('should remove user@host:~% format prompts (zsh)', () => {
					const input = 'user@host:~%\nsome output';
					const result = stripControlSequences(input, undefined, true);
					expect(result).toBe('some output');
				});

				it('should remove user@host:~> format prompts (PowerShell)', () => {
					const input = 'user@host:~>\nsome output';
					const result = stripControlSequences(input, undefined, true);
					expect(result).toBe('some output');
				});

				it('should remove ~/path $ format prompts', () => {
					const input = '~/Projects $\noutput';
					const result = stripControlSequences(input, undefined, true);
					expect(result).toBe('output');
				});

				it('should remove /absolute/path $ format prompts', () => {
					const input = '/home/user $\noutput';
					const result = stripControlSequences(input, undefined, true);
					expect(result).toBe('output');
				});

				it('should remove standalone git branch indicators', () => {
					const input = '(main)\n(master)\n(feature/test)\nactual output';
					const result = stripControlSequences(input, undefined, true);
					expect(result).toBe('actual output');
				});

				it('should remove standalone prompt characters', () => {
					const input = '$\n#\n%\n>\nactual output';
					const result = stripControlSequences(input, undefined, true);
					expect(result).toBe('actual output');
				});

				it('should remove [user:~/path] (branch) $ format prompts', () => {
					const input = '[pedram:~/Projects] (main) $\nactual output';
					const result = stripControlSequences(input, undefined, true);
					expect(result).toBe('actual output');
				});

				it('should handle prompts with dots and hyphens in names', () => {
					const input = 'user-name.test@host-name.local:~$\noutput';
					const result = stripControlSequences(input, undefined, true);
					expect(result).toBe('output');
				});
			});

			describe('command echo filtering', () => {
				it('should remove exact command echoes', () => {
					const input = 'ls -la\nfile1.txt\nfile2.txt';
					const result = stripControlSequences(input, 'ls -la', true);
					expect(result).toBe('file1.txt\nfile2.txt');
				});

				it('should not remove partial matches', () => {
					const input = 'ls -la something\nfile1.txt';
					const result = stripControlSequences(input, 'ls -la', true);
					expect(result).toBe('ls -la something\nfile1.txt');
				});

				it('should handle command echo with leading whitespace', () => {
					const input = '  ls  \nfile1.txt';
					const result = stripControlSequences(input, 'ls', true);
					expect(result).toBe('file1.txt');
				});
			});

			describe('git branch cleanup', () => {
				it('should remove git branch indicators from content lines', () => {
					const input = 'output (main) text';
					const result = stripControlSequences(input, undefined, true);
					expect(result).toBe('output text');
				});

				it('should remove trailing prompt characters from content', () => {
					// The regex removes trailing $ but keeps preceding space
					// The line is 'some text $' -> regex replaces '$ ' with '' -> 'some text '
					// (trailing space remains because cleanedLine.trim() is only checked for empty)
					const input = 'some text $\nmore text';
					const result = stripControlSequences(input, undefined, true);
					expect(result).toBe('some text \nmore text');
				});
			});

			describe('empty line handling', () => {
				it('should skip empty lines', () => {
					const input = '\n\n\nactual output\n\n';
					const result = stripControlSequences(input, undefined, true);
					expect(result).toBe('actual output');
				});

				it('should skip lines that become empty after cleaning', () => {
					const input = ' (main) $\nactual output';
					const result = stripControlSequences(input, undefined, true);
					expect(result).toBe('actual output');
				});
			});
		});

		describe('non-terminal mode (isTerminal = false, default)', () => {
			it('should not filter prompts when isTerminal is false', () => {
				const input = 'user@host:~$ ls\nfile1.txt';
				const result = stripControlSequences(input, 'ls', false);
				expect(result).toBe('user@host:~$ ls\nfile1.txt');
			});

			it('should not filter prompts when isTerminal is not provided', () => {
				const input = 'user@host:~$ ls\nfile1.txt';
				const result = stripControlSequences(input);
				expect(result).toBe('user@host:~$ ls\nfile1.txt');
			});
		});

		describe('complex scenarios', () => {
			it('should handle mixed control sequences and content', () => {
				const input = '\x1b]0;Title\x07\x1b[2J\x1b[H\x1b[32mGreen text\x1b[0m\x07more content';
				const result = stripControlSequences(input);
				expect(result).toBe('\x1b[32mGreen text\x1b[0mmore content');
			});

			it('should handle multiple shell integration markers', () => {
				const input =
					'\x1b]133;A\x07\x1b]7;file:///path\x07prompt\x1b]133;B\x07\x1b]1337;Foo=bar\x07output';
				const result = stripControlSequences(input);
				expect(result).toBe('promptoutput');
			});

			it('should handle empty input', () => {
				const result = stripControlSequences('');
				expect(result).toBe('');
			});

			it('should handle input with only control sequences', () => {
				const input = '\x1b[2J\x1b[H\x1b]0;Title\x07';
				const result = stripControlSequences(input);
				expect(result).toBe('');
			});
		});
	});

	describe('stripAllAnsiCodes', () => {
		describe('SGR (Select Graphic Rendition) color/style codes', () => {
			it('should remove basic foreground color codes', () => {
				const input = '\x1b[32mGreen text\x1b[0m';
				const result = stripAllAnsiCodes(input);
				expect(result).toBe('Green text');
			});

			it('should remove background color codes', () => {
				const input = '\x1b[41mRed background\x1b[0m';
				const result = stripAllAnsiCodes(input);
				expect(result).toBe('Red background');
			});

			it('should remove bold/underline/etc style codes', () => {
				const input = '\x1b[1mBold\x1b[4mUnderline\x1b[0m';
				const result = stripAllAnsiCodes(input);
				expect(result).toBe('BoldUnderline');
			});

			it('should remove complex SGR sequences with multiple parameters', () => {
				const input = '\x1b[1;4;31;42mStyled\x1b[0m';
				const result = stripAllAnsiCodes(input);
				expect(result).toBe('Styled');
			});

			it('should remove 256-color codes', () => {
				const input = '\x1b[38;5;196mRed 256\x1b[0m';
				const result = stripAllAnsiCodes(input);
				expect(result).toBe('Red 256');
			});

			it('should remove true color (24-bit) codes', () => {
				const input = '\x1b[38;2;255;128;0mOrange\x1b[0m';
				const result = stripAllAnsiCodes(input);
				expect(result).toBe('Orange');
			});
		});

		describe('CSI (Control Sequence Introducer) sequences', () => {
			it('should remove cursor movement codes', () => {
				const input = 'text\x1b[1Aup\x1b[2Bdown\x1b[3Cforward\x1b[4Dback';
				const result = stripAllAnsiCodes(input);
				expect(result).toBe('textupdownforwardback');
			});

			it('should remove cursor positioning (H and f)', () => {
				const input = '\x1b[10;20Hpositioned\x1b[5;10ftext';
				const result = stripAllAnsiCodes(input);
				expect(result).toBe('positionedtext');
			});

			it('should remove erase sequences (J and K)', () => {
				const input = '\x1b[2Jcleared\x1b[0Kline';
				const result = stripAllAnsiCodes(input);
				expect(result).toBe('clearedline');
			});

			it('should remove scroll sequences (S and T)', () => {
				const input = '\x1b[3Sscroll\x1b[2Tup';
				const result = stripAllAnsiCodes(input);
				expect(result).toBe('scrollup');
			});

			it('should remove save/restore cursor sequences', () => {
				const input = '\x1b[ssaved\x1b[urestored';
				const result = stripAllAnsiCodes(input);
				expect(result).toBe('savedrestored');
			});
		});

		describe('OSC (Operating System Command) sequences', () => {
			it('should remove window title sequences with BEL terminator', () => {
				const input = '\x1b]0;Window Title\x07content';
				const result = stripAllAnsiCodes(input);
				expect(result).toBe('content');
			});

			it('should remove window title sequences with ST terminator', () => {
				const input = '\x1b]0;Window Title\x1b\\content';
				const result = stripAllAnsiCodes(input);
				expect(result).toBe('content');
			});

			it('should remove hyperlink sequences', () => {
				const input = '\x1b]8;;https://example.com\x07Link Text\x1b]8;;\x07';
				const result = stripAllAnsiCodes(input);
				expect(result).toBe('Link Text');
			});

			it('should remove shell integration markers (133)', () => {
				const input = '\x1b]133;A\x07prompt\x1b]133;B\x07output\x1b]133;D;0\x07';
				const result = stripAllAnsiCodes(input);
				expect(result).toBe('promptoutput');
			});

			it('should remove iTerm2 sequences (1337)', () => {
				const input = '\x1b]1337;SetUserVar=foo=bar\x07content';
				const result = stripAllAnsiCodes(input);
				expect(result).toBe('content');
			});
		});

		describe('character set selection', () => {
			it('should remove character set sequences ESC ( A/B/0/1/2', () => {
				const input = '\x1b(B\x1b)0\x1b(A\x1b)1\x1b(2text';
				const result = stripAllAnsiCodes(input);
				expect(result).toBe('text');
			});
		});

		describe('control characters', () => {
			it('should remove BEL character', () => {
				const input = 'alert\x07text';
				const result = stripAllAnsiCodes(input);
				expect(result).toBe('alerttext');
			});

			it('should remove NUL and other control characters', () => {
				const input = 'text\x00\x01\x02\x03\x04more';
				const result = stripAllAnsiCodes(input);
				expect(result).toBe('textmore');
			});

			it('should remove form feed and vertical tab', () => {
				const input = 'text\x0B\x0Cmore';
				const result = stripAllAnsiCodes(input);
				expect(result).toBe('textmore');
			});

			it('should preserve newlines (0x0A)', () => {
				const input = 'line1\nline2';
				const result = stripAllAnsiCodes(input);
				expect(result).toBe('line1\nline2');
			});

			it('should preserve tabs (0x09)', () => {
				const input = 'col1\tcol2';
				const result = stripAllAnsiCodes(input);
				expect(result).toBe('col1\tcol2');
			});

			it('should preserve carriage returns (0x0D)', () => {
				const input = 'overwrite\rtext';
				const result = stripAllAnsiCodes(input);
				expect(result).toBe('overwrite\rtext');
			});
		});

		describe('real-world AI agent stderr scenarios', () => {
			it('should handle stderr with progress spinner and colors', () => {
				const input = '\x1b[33m⠋\x1b[0m Loading...\x1b[K\x1b[1A\x1b[33m⠙\x1b[0m Loading...';
				const result = stripAllAnsiCodes(input);
				expect(result).toBe('⠋ Loading...⠙ Loading...');
			});

			it('should handle error messages with bold red formatting', () => {
				const input = '\x1b[1;31mError:\x1b[0m Something went wrong';
				const result = stripAllAnsiCodes(input);
				expect(result).toBe('Error: Something went wrong');
			});

			it('should handle multi-line stderr with mixed codes', () => {
				const input = '\x1b[31mERROR\x1b[0m on line 42\n\x1b[33mWARNING\x1b[0m deprecated';
				const result = stripAllAnsiCodes(input);
				expect(result).toBe('ERROR on line 42\nWARNING deprecated');
			});

			it('should handle Claude Code style output', () => {
				const input = '\x1b]133;A\x07\x1b[1m● Claude\x1b[0m is thinking\x1b]133;D;0\x07';
				const result = stripAllAnsiCodes(input);
				expect(result).toBe('● Claude is thinking');
			});
		});

		describe('edge cases', () => {
			it('should handle empty string', () => {
				expect(stripAllAnsiCodes('')).toBe('');
			});

			it('should handle string with only escape codes', () => {
				const input = '\x1b[32m\x1b[0m\x1b[1A\x1b]0;Title\x07';
				const result = stripAllAnsiCodes(input);
				expect(result).toBe('');
			});

			it('should handle plain text with no escape codes', () => {
				const input = 'Hello, World!';
				const result = stripAllAnsiCodes(input);
				expect(result).toBe('Hello, World!');
			});

			it('should handle incomplete escape sequences gracefully', () => {
				// An incomplete ESC [ followed by letters is treated as a CSI sequence
				// The regex \x1b\[[\d;]*[A-Za-z] matches ESC [ i since 'i' is a letter
				// So 'ncomplete' remains after the partial sequence is consumed
				const input = 'text\x1b[incomplete';
				const result = stripAllAnsiCodes(input);
				// ESC [ i is matched and removed, leaving 'textncomplete'
				expect(result).toBe('textncomplete');
			});

			it('should handle multiple consecutive color codes', () => {
				const input = '\x1b[0m\x1b[1m\x1b[32m\x1b[44mtext\x1b[0m\x1b[0m';
				const result = stripAllAnsiCodes(input);
				expect(result).toBe('text');
			});
		});
	});

	describe('isCommandEcho', () => {
		it('should return false when lastCommand is not provided', () => {
			expect(isCommandEcho('ls')).toBe(false);
		});

		it('should return false when lastCommand is empty', () => {
			expect(isCommandEcho('ls', '')).toBe(false);
		});

		it('should return true for exact match', () => {
			expect(isCommandEcho('ls -la', 'ls -la')).toBe(true);
		});

		it('should return true for match with leading whitespace in line', () => {
			expect(isCommandEcho('  ls -la  ', 'ls -la')).toBe(true);
		});

		it('should return true for match with leading whitespace in command', () => {
			expect(isCommandEcho('ls -la', '  ls -la  ')).toBe(true);
		});

		it('should return true when line ends with the command', () => {
			expect(isCommandEcho('$ ls -la', 'ls -la')).toBe(true);
		});

		it('should return true when line has prompt prefix and ends with command', () => {
			expect(isCommandEcho('[user:~/path]$ ls -la', 'ls -la')).toBe(true);
		});

		it('should return false for partial match that does not end with command', () => {
			expect(isCommandEcho('ls -la --all', 'ls -la')).toBe(false);
		});

		it('should return false for completely different line', () => {
			expect(isCommandEcho('file1.txt', 'ls -la')).toBe(false);
		});

		it('should handle multi-word commands', () => {
			expect(isCommandEcho('git commit -m "message"', 'git commit -m "message"')).toBe(true);
		});

		it('should handle commands with special characters', () => {
			expect(isCommandEcho('echo "hello world"', 'echo "hello world"')).toBe(true);
		});
	});

	describe('extractCommand', () => {
		it('should return trimmed input when no prompt present', () => {
			expect(extractCommand('ls -la')).toBe('ls -la');
		});

		it('should remove $ prompt prefix', () => {
			expect(extractCommand('$ ls -la')).toBe('ls -la');
		});

		it('should remove # prompt prefix', () => {
			expect(extractCommand('# ls -la')).toBe('ls -la');
		});

		it('should remove % prompt prefix', () => {
			expect(extractCommand('% ls -la')).toBe('ls -la');
		});

		it('should remove > prompt prefix', () => {
			expect(extractCommand('> ls -la')).toBe('ls -la');
		});

		it('should remove user@host:~$ prompt prefix', () => {
			expect(extractCommand('user@host:~$ ls -la')).toBe('ls -la');
		});

		it('should remove [user:~/path]$ prompt prefix', () => {
			expect(extractCommand('[pedram:~/Projects]$ npm install')).toBe('npm install');
		});

		it('should handle extra whitespace after prompt', () => {
			expect(extractCommand('$   ls -la')).toBe('ls -la');
		});

		it('should handle complex prompt patterns', () => {
			expect(extractCommand('user@host:/var/log# tail -f syslog')).toBe('tail -f syslog');
		});

		it('should return empty string for empty input', () => {
			expect(extractCommand('')).toBe('');
		});

		it('should return empty string for just prompt', () => {
			expect(extractCommand('$  ')).toBe('');
		});

		it('should handle multiple prompt characters (takes first)', () => {
			expect(extractCommand('$ echo "$ hello"')).toBe('echo "$ hello"');
		});
	});
});
