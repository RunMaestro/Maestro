/**
 * Tests for src/shared/aiCommand.ts
 *
 * AI command mode pastes whatever comes back into a shell, so the two things
 * covered here are the two that decide whether that paste is safe: the prompt
 * has to describe the machine the command will actually land on, and the
 * extractor has to strip everything that is not the command.
 */

import { describe, expect, test } from 'vitest';
import {
	AI_COMMAND_HISTORY_LIMIT,
	buildAiCommandPrompt,
	collectRecentCommands,
	describePlatform,
	extractCommandLine,
	formatRecentCommands,
	type CommandCardLike,
} from '../../shared/aiCommand';

describe('describePlatform', () => {
	test('names the common platforms in human terms', () => {
		expect(describePlatform('darwin', '24.0.0')).toBe('macOS (darwin 24.0.0)');
		expect(describePlatform('win32')).toBe('Windows (win32)');
		expect(describePlatform('linux')).toBe('Linux (linux)');
	});

	test('passes an unknown platform through rather than guessing', () => {
		expect(describePlatform('freebsd')).toBe('freebsd (freebsd)');
	});
});

describe('buildAiCommandPrompt', () => {
	const template =
		'OS: {{OS}}\nShell: {{SHELL}}\nCwd: {{CWD}}\nGit: {{IS_GIT_REPO}}\n{{REMOTE_LINE}}\nRequest: {{USER_REQUEST}}';

	test('fills every slot from the host description', () => {
		const prompt = buildAiCommandPrompt(
			template,
			{ platform: 'darwin', release: '24.0.0', shell: '/bin/zsh', cwd: '/repo', isGitRepo: true },
			'list big files'
		);

		expect(prompt).toContain('OS: macOS (darwin 24.0.0)');
		expect(prompt).toContain('Shell: /bin/zsh');
		expect(prompt).toContain('Cwd: /repo');
		expect(prompt).toContain('Git: yes');
		expect(prompt).toContain('Request: list big files');
	});

	test('names the SSH remote so the model knows the command leaves this machine', () => {
		const prompt = buildAiCommandPrompt(
			template,
			{ platform: 'linux', shell: 'sh', cwd: '/srv', remoteName: 'build-box' },
			'restart the service'
		);

		expect(prompt).toContain('build-box');
	});

	test('leaves the remote line empty when the agent runs locally', () => {
		const prompt = buildAiCommandPrompt(
			template,
			{ platform: 'linux', shell: 'sh', cwd: '/srv' },
			'restart the service'
		);

		expect(prompt).not.toContain('SSH remote');
		expect(prompt).toContain('Git: no');
	});

	test('substitutes the recent-command history', () => {
		const prompt = buildAiCommandPrompt(
			'{{RECENT_COMMANDS}}\nRequest: {{USER_REQUEST}}',
			{ platform: 'darwin', shell: '/bin/zsh', cwd: '/repo' },
			'actually just the count',
			[{ command: "find . -newermt '2 days ago' -type f" }]
		);

		expect(prompt).toContain("find . -newermt '2 days ago' -type f");
		expect(prompt).toContain('Request: actually just the count');
	});

	test('leaves no empty history heading when nothing has run yet', () => {
		// A heading with no entries under it tells the model there IS history and
		// it is empty, which is a different (and wrong) claim.
		const prompt = buildAiCommandPrompt(
			'{{RECENT_COMMANDS}}|end',
			{ platform: 'darwin', shell: '/bin/zsh', cwd: '/repo' },
			'list files'
		);

		expect(prompt).toBe('|end');
	});

	test('a previously-run command cannot move where the request lands', () => {
		// History is substituted BEFORE the request, so a command line echoing a
		// template token is data, not a slot.
		const prompt = buildAiCommandPrompt(
			'{{RECENT_COMMANDS}}\nRequest: {{USER_REQUEST}}',
			{ platform: 'darwin', shell: '/bin/zsh', cwd: '/repo' },
			'the real request',
			[{ command: 'echo {{USER_REQUEST}}' }]
		);

		expect(prompt).toContain('- echo {{USER_REQUEST}}');
		expect(prompt).toContain('Request: the real request');
		expect(prompt).not.toContain('echo the real request');
	});

	test('leaves an unrecognised token verbatim instead of blanking it', () => {
		// A typo in an edited prompt should be visible, not silently swallowed.
		const prompt = buildAiCommandPrompt(
			'{{CWD}} {{NOT_A_TOKEN}}',
			{ platform: 'darwin', shell: '/bin/zsh', cwd: '/repo' },
			'list files'
		);

		expect(prompt).toBe('/repo {{NOT_A_TOKEN}}');
	});

	test('the request cannot rewrite the environment block above it', () => {
		// The request is substituted last, so a request that happens to contain a
		// template token is data, not a slot.
		const prompt = buildAiCommandPrompt(
			template,
			{ platform: 'darwin', shell: '/bin/zsh', cwd: '/repo' },
			'echo {{CWD}}'
		);

		expect(prompt).toContain('Request: echo {{CWD}}');
		expect(prompt).toContain('Cwd: /repo');
	});
});

describe('extractCommandLine', () => {
	test('returns a bare line untouched', () => {
		expect(extractCommandLine('git status')).toBe('git status');
	});

	test('unwraps a fenced block', () => {
		expect(extractCommandLine('```bash\ndu -sh * | sort -rh\n```')).toBe('du -sh * | sort -rh');
	});

	test('prefers the fenced command over the prose around it', () => {
		const raw = "Here's the command you want:\n\n```\nls -la\n```\n\nHope that helps!";
		expect(extractCommandLine(raw)).toBe('ls -la');
	});

	test('strips a shell prompt marker', () => {
		expect(extractCommandLine('$ npm test')).toBe('npm test');
		expect(extractCommandLine('% npm test')).toBe('npm test');
	});

	test('strips wrapping inline backticks', () => {
		expect(extractCommandLine('`git log --oneline`')).toBe('git log --oneline');
	});

	test('skips a lead-in line and takes the command under it', () => {
		expect(extractCommandLine('The command:\ngit fetch --all')).toBe('git fetch --all');
	});

	test('keeps a chained command whole', () => {
		expect(extractCommandLine('npm ci && npm run build')).toBe('npm ci && npm run build');
	});

	test('returns null when there is nothing usable', () => {
		// Better a reported failure than proposing an empty run.
		expect(extractCommandLine('')).toBeNull();
		expect(extractCommandLine('   \n\n  ')).toBeNull();
		expect(extractCommandLine('```\n\n```')).toBeNull();
	});
});

describe('collectRecentCommands', () => {
	function card(command: string, extra: Partial<CommandCardLike['shellCommand']> = {}) {
		return {
			shellCommand: { command, status: 'finished' as const, exitCode: 0, ...extra },
		} satisfies CommandCardLike;
	}

	test('returns commands oldest first, so the last one is the most recent', () => {
		const logs = [card('ls'), card('pwd'), card('git status')];

		expect(collectRecentCommands(logs).map((e) => e.command)).toEqual(['ls', 'pwd', 'git status']);
	});

	test('ignores transcript entries that are not command cards', () => {
		const logs = [{}, card('ls'), { shellCommand: undefined }, card('pwd')];

		expect(collectRecentCommands(logs).map((e) => e.command)).toEqual(['ls', 'pwd']);
	});

	test('keeps the NEWEST commands when over the limit', () => {
		// The cap has to drop from the front. Dropping from the back would discard
		// exactly the command a follow-up is refining.
		const logs = Array.from({ length: 12 }, (_, i) => card(`cmd-${i}`));

		const collected = collectRecentCommands(logs, 3);

		expect(collected.map((e) => e.command)).toEqual(['cmd-9', 'cmd-10', 'cmd-11']);
	});

	test('collapses consecutive repeats but keeps a later re-run', () => {
		const logs = [card('npm test'), card('npm test'), card('ls'), card('npm test')];

		expect(collectRecentCommands(logs).map((e) => e.command)).toEqual([
			'npm test',
			'ls',
			'npm test',
		]);
	});

	test('carries the exit code and status through', () => {
		const logs = [
			card('false', { exitCode: 1 }),
			{ shellCommand: { command: 'sleep 99', status: 'running' as const } },
		];

		expect(collectRecentCommands(logs)).toEqual([
			{ command: 'false', exitCode: 1, status: 'finished' },
			// A running command has no exit code yet, and none is invented.
			{ command: 'sleep 99', status: 'running' },
		]);
	});

	test('defaults to the shared limit and tolerates an empty transcript', () => {
		const logs = Array.from({ length: 40 }, (_, i) => card(`cmd-${i}`));

		expect(collectRecentCommands(logs)).toHaveLength(AI_COMMAND_HISTORY_LIMIT);
		expect(collectRecentCommands([])).toEqual([]);
		expect(collectRecentCommands(logs, 0)).toEqual([]);
	});
});

describe('formatRecentCommands', () => {
	test('renders nothing at all when there is no history', () => {
		// An empty heading would tell the model there IS history and it is empty.
		expect(formatRecentCommands([])).toBe('');
	});

	test('lists the commands and says which end is most recent', () => {
		const block = formatRecentCommands([{ command: 'ls' }, { command: 'pwd' }]);

		expect(block).toContain('## Recent commands');
		expect(block).toContain('- ls');
		expect(block).toContain('- pwd');
		expect(block).toMatch(/LAST one is the most recent/i);
		expect(block.indexOf('- ls')).toBeLessThan(block.indexOf('- pwd'));
	});

	test('labels a failure rather than hiding it', () => {
		// "that didn't work, try something else" needs the failure to be visible,
		// or the model proposes the same broken command again.
		const block = formatRecentCommands([{ command: 'grep -P x .', exitCode: 2 }]);

		expect(block).toContain('failed, exit 2');
	});

	test('does not label a successful command', () => {
		// Noise. Every command that worked would carry the same suffix.
		const block = formatRecentCommands([{ command: 'ls', exitCode: 0, status: 'finished' }]);

		expect(block).toContain('- ls');
		expect(block).not.toContain('exit 0');
	});

	test('marks running and cancelled commands', () => {
		expect(formatRecentCommands([{ command: 'tail -f log', status: 'running' }])).toContain(
			'still running'
		);
		expect(formatRecentCommands([{ command: 'npm ci', status: 'cancelled' }])).toContain(
			'stopped by the user'
		);
	});

	test('truncates an enormous command line', () => {
		const block = formatRecentCommands([{ command: 'echo ' + 'x'.repeat(2000) }]);

		expect(block).toContain('...');
		expect(block.length).toBeLessThan(700);
	});
});
