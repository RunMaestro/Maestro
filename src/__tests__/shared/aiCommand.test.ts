/**
 * Tests for src/shared/aiCommand.ts
 *
 * AI command mode pastes whatever comes back into a shell, so the two things
 * covered here are the two that decide whether that paste is safe: the prompt
 * has to describe the machine the command will actually land on, and the
 * extractor has to strip everything that is not the command.
 */

import { describe, expect, test } from 'vitest';
import { buildAiCommandPrompt, describePlatform, extractCommandLine } from '../../shared/aiCommand';

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
