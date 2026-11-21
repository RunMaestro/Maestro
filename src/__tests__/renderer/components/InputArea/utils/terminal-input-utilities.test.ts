// Source: src/__tests__/renderer/components/InputArea/utils/terminalPath.test.ts
// Source: src/__tests__/renderer/utils/shellCommandInput.test.ts
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { formatTerminalCwd } from '../../../../../renderer/components/InputArea/utils/terminalPath';
import { createInputAreaSession } from '../_fixtures';
import { test } from 'vitest';
import { commandFromShellFence } from '../../../../../renderer/utils/shellCommandInput';
import { detectCommandModeEntry } from '../../../../../renderer/utils/shellCommandInput';
import { isRunnableShellLanguage } from '../../../../../renderer/utils/shellCommandInput';
import { isAiCommandMode } from '../../../../../renderer/utils/shellCommandInput';
import { isShellCommandMode } from '../../../../../renderer/utils/shellCommandInput';
import { nextComposerCommandMode } from '../../../../../renderer/utils/shellCommandInput';
import { normalizeComposerCommandMode } from '../../../../../renderer/utils/shellCommandInput';
import { previousComposerCommandMode } from '../../../../../renderer/utils/shellCommandInput';
import { stripShellCommandEscape } from '../../../../../renderer/utils/shellCommandInput';
describe('terminalPath', () => {
	describe('InputArea terminalPath util', () => {
		it('formats local user paths with tilde', () => {
			const session = createInputAreaSession({
				inputMode: 'terminal',
				shellCwd: '/Users/test/project/src',
			});

			expect(formatTerminalCwd(session)).toBe('~/project/src');
		});

		it('formats linux home paths with tilde', () => {
			const session = createInputAreaSession({
				inputMode: 'terminal',
				shellCwd: '/home/saif/app',
			});

			expect(formatTerminalCwd(session)).toBe('~/app');
		});

		it('prefixes SSH remote names and prefers remote cwd', () => {
			const session = createInputAreaSession({
				inputMode: 'terminal',
				sshRemoteId: 'remote-1',
				sshRemote: { name: 'prod' } as any,
				remoteCwd: '/home/ubuntu/repo',
			});

			expect(formatTerminalCwd(session)).toBe('PROD:~/repo');
		});

		it('falls back to configured SSH working directory', () => {
			const session = createInputAreaSession({
				inputMode: 'terminal',
				sessionSshRemoteConfig: {
					enabled: true,
					workingDirOverride: '/srv/app',
				} as any,
			});

			expect(formatTerminalCwd(session)).toBe('/srv/app');
		});
	});
});
describe('shellCommandInput', () => {
	describe('detectCommandModeEntry', () => {
		test('enters on a bang typed into an empty composer, consuming the bang', () => {
			expect(detectCommandModeEntry('', '!')).toBe('');
		});

		test('keeps whatever followed the bang in a paste', () => {
			expect(detectCommandModeEntry('', '!git status')).toBe('git status');
		});

		test('treats a whitespace-only composer as empty', () => {
			expect(detectCommandModeEntry('   ', '!ls')).toBe('ls');
			expect(detectCommandModeEntry('\n', '!ls')).toBe('ls');
		});

		test('preserves leading whitespace around the consumed bang', () => {
			expect(detectCommandModeEntry('', '  !ls')).toBe('  ls');
		});

		test('does not enter when the composer already had a message', () => {
			// Caret moved to the start of an in-progress message and `!` typed: that
			// must stay a message, not silently become a shell command.
			expect(detectCommandModeEntry('deploy the site', '!deploy the site')).toBeNull();
		});

		test('does not enter on a bang that is not leading', () => {
			expect(detectCommandModeEntry('', 'do it now!')).toBeNull();
		});

		test('does not enter for ordinary text', () => {
			expect(detectCommandModeEntry('', 'fix the login bug')).toBeNull();
			expect(detectCommandModeEntry('', '')).toBeNull();
		});

		test('does not enter for the escape form', () => {
			// `\!` is how you send a literal leading bang to the agent.
			expect(detectCommandModeEntry('', '\\!important')).toBeNull();
		});
	});

	describe('stripShellCommandEscape', () => {
		test('unwraps a leading escaped bang', () => {
			expect(stripShellCommandEscape('\\!important message')).toBe('!important message');
		});

		test('preserves leading whitespace while unwrapping', () => {
			expect(stripShellCommandEscape('  \\!hey')).toBe('  !hey');
		});

		test('leaves ordinary messages untouched', () => {
			expect(stripShellCommandEscape('fix the login bug')).toBe('fix the login bug');
		});

		test('only strips the leading escape, not later ones', () => {
			expect(stripShellCommandEscape('\\!a and \\!b')).toBe('!a and \\!b');
		});

		test('leaves a non-leading backslash-bang untouched', () => {
			expect(stripShellCommandEscape('echo \\!x')).toBe('echo \\!x');
		});
	});

	describe('the bang ladder', () => {
		test('climbs agent -> shell -> ai and stops there', () => {
			expect(nextComposerCommandMode('off')).toBe('shell');
			expect(nextComposerCommandMode('shell')).toBe('ai');
			// No rung above AI command mode, so the bang stays in the request text.
			expect(nextComposerCommandMode('ai')).toBeNull();
		});

		test('descends ai -> shell -> agent and floors at agent', () => {
			expect(previousComposerCommandMode('ai')).toBe('shell');
			expect(previousComposerCommandMode('shell')).toBe('off');
			expect(previousComposerCommandMode('off')).toBe('off');
		});

		test('only the shell rung reports as a shell command line', () => {
			expect(isShellCommandMode('shell')).toBe(true);
			expect(isShellCommandMode('ai')).toBe(false);
			expect(isAiCommandMode('ai')).toBe(true);
			expect(isAiCommandMode('shell')).toBe(false);
		});
	});

	describe('normalizeComposerCommandMode', () => {
		test('reads the legacy boolean encoding as the shell rung', () => {
			// Tabs written before AI command mode existed stored `true` for what is
			// now 'shell'. Those drafts must still route to the shell after an update.
			expect(normalizeComposerCommandMode(true)).toBe('shell');
			expect(normalizeComposerCommandMode(false)).toBe('off');
		});

		test('passes through the current encoding', () => {
			expect(normalizeComposerCommandMode('shell')).toBe('shell');
			expect(normalizeComposerCommandMode('ai')).toBe('ai');
			expect(normalizeComposerCommandMode('off')).toBe('off');
		});

		test('falls back to ordinary chat for anything unrecognised', () => {
			// A corrupt value must land the user in chat, never in a shell.
			expect(normalizeComposerCommandMode(undefined)).toBe('off');
			expect(normalizeComposerCommandMode(null)).toBe('off');
			expect(normalizeComposerCommandMode('bogus')).toBe('off');
			expect(normalizeComposerCommandMode(1)).toBe('off');
		});
	});

	describe('isRunnableShellLanguage', () => {
		test('accepts the shell tags agents write and their Shiki canonical ids', () => {
			for (const lang of ['bash', 'sh', 'shell', 'zsh', 'console', 'shellscript', 'shellsession']) {
				expect(isRunnableShellLanguage(lang)).toBe(true);
			}
		});

		test('is case-insensitive', () => {
			expect(isRunnableShellLanguage('Bash')).toBe(true);
		});

		test('rejects other languages and other shell dialects', () => {
			for (const lang of ['python', 'text', 'fish', 'powershell', '', null, undefined]) {
				expect(isRunnableShellLanguage(lang)).toBe(false);
			}
		});
	});

	describe('commandFromShellFence', () => {
		test('runs an ordinary fence as written, line continuations included', () => {
			const code = 'cd ~/dl && curl -L -o out.mp4 \\\n  "https://example.com/a.mp4"';
			expect(commandFromShellFence(`\n${code}\n`)).toBe(code);
		});

		test('runs only the prompt lines of a session transcript, prompt stripped', () => {
			const code = '$ npm test\n> vitest run\n 12 passed\n$ git status';
			expect(commandFromShellFence(code)).toBe('npm test\ngit status');
		});

		test('does not mistake a variable for a prompt', () => {
			expect(commandFromShellFence('$HOME/bin/tool --flag')).toBe('$HOME/bin/tool --flag');
		});

		test('returns an empty string for a blank fence', () => {
			expect(commandFromShellFence('  \n ')).toBe('');
		});
	});
});
