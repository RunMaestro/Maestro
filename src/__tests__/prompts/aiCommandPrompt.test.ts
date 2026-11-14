/**
 * Integrity checks for src/prompts/ai-command.md.
 *
 * This prompt is unusual among the core prompts: its examples are shell command
 * lines, and shell syntax collides head-on with Markdown. Running the file
 * through Prettier once already rewrote `--include='*.ts'` into
 * `--include='_.ts'` and `du -sh *` into `du -sh \*`, because the formatter read
 * the glob asterisks as emphasis markers. Nothing type-checks a prompt, and the
 * damage is invisible in review - it just quietly teaches the model broken
 * syntax, which then gets pasted into a real shell.
 *
 * The fix is that every example lives inside a fenced code block. These tests
 * are the tripwire for anyone who moves one back out.
 */

import { describe, expect, test } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { AI_COMMAND_REPLY_SCHEMA, buildAiCommandPrompt } from '../../shared/aiCommand';

const PROMPT_PATH = path.join(__dirname, '../../prompts/ai-command.md');
const prompt = readFileSync(PROMPT_PATH, 'utf-8');

describe('ai-command.md', () => {
	test('keeps glob asterisks literal in its examples', () => {
		expect(prompt).toContain("--include='*.ts'");
		expect(prompt).toContain('du -sh * | sort -rh');
		// The two shapes Prettier produced when it treated a glob as emphasis.
		expect(prompt).not.toContain("--include='_.ts'");
		expect(prompt).not.toContain('\\*');
	});

	test('declares every token the builder substitutes', () => {
		// A prompt missing a slot silently drops that context: the model would be
		// asked for a command with no idea which OS or shell it runs on.
		for (const token of [
			'{{OS}}',
			'{{SHELL}}',
			'{{CWD}}',
			'{{IS_GIT_REPO}}',
			'{{REMOTE_LINE}}',
			'{{RECENT_COMMANDS}}',
			'{{USER_REQUEST}}',
		]) {
			expect(prompt).toContain(token);
		}
	});

	test('leaves no token unfilled once built', () => {
		const built = buildAiCommandPrompt(
			prompt,
			{ platform: 'darwin', release: '24.0.0', shell: '/bin/zsh', cwd: '/repo', isGitRepo: true },
			'count the files changed today',
			[{ command: "find . -newermt '2 days ago' -type f", exitCode: 0, status: 'finished' }]
		);

		expect(built).not.toMatch(/\{\{[A-Z_]+\}\}/);
		expect(built).toContain('macOS');
		expect(built).toContain("find . -newermt '2 days ago' -type f");
		expect(built).toContain('count the files changed today');
	});

	test('teaches the model to read the Asked line with its command', () => {
		// The history block emits "Asked:" / "Ran:" pairs; the prompt has to say
		// what they mean, or the labels are just unexplained noise.
		expect(prompt).toContain('Asked:');
		expect(prompt).toContain('Ran:');
		expect(prompt).toMatch(/Asked" line/i);
	});

	test('forbids commands that wait for typed input', () => {
		// Command mode has no stdin: a sudo password or [y/N] prompt hangs the
		// command until the user cancels it, so the prompt must steer the model
		// to non-interactive forms and to a comment when none exists.
		expect(prompt).toMatch(/cannot receive keyboard input/);
		expect(prompt).toContain('sudo -n');
		expect(prompt).toContain('# run in a terminal tab:');
	});

	test('still reads as one-command-only instructions', () => {
		// The whole contract with the caller: exactly one line comes back, and it
		// is pasted straight into a shell.
		expect(prompt).toMatch(/ONE shell command line/);
		expect(prompt).toMatch(/Emit ONE line/);
	});
});

/**
 * src/prompts/ai-command-local.md is the same job condensed for a small model
 * (a Local Models source), so it carries the same shell examples and the same
 * Prettier hazard.
 */
describe('ai-command-local.md', () => {
	const localPrompt = readFileSync(
		path.join(__dirname, '../../prompts/ai-command-local.md'),
		'utf-8'
	);

	test('keeps glob asterisks literal in its examples', () => {
		expect(localPrompt).toContain("--include='*.ts'");
		expect(localPrompt).toContain('du -sh * | sort -rh');
		expect(localPrompt).not.toContain("--include='_.ts'");
		expect(localPrompt).not.toContain('\\*');
	});

	test('declares every token the builder substitutes and leaves none unfilled', () => {
		for (const token of [
			'{{OS}}',
			'{{SHELL}}',
			'{{CWD}}',
			'{{IS_GIT_REPO}}',
			'{{REMOTE_LINE}}',
			'{{RECENT_COMMANDS}}',
			'{{USER_REQUEST}}',
		]) {
			expect(localPrompt).toContain(token);
		}

		const built = buildAiCommandPrompt(
			localPrompt,
			{ platform: 'darwin', release: '24.0.0', shell: '/bin/zsh', cwd: '/repo', isGitRepo: true },
			'count the files changed today',
			[{ command: "find . -newermt '2 days ago' -type f", exitCode: 0, status: 'finished' }]
		);
		expect(built).not.toMatch(/\{\{[A-Z_]+\}\}/);
		expect(built).toContain('count the files changed today');
	});

	test('asks for the JSON fields the reply schema names', () => {
		for (const field of Object.keys(
			AI_COMMAND_REPLY_SCHEMA.properties as Record<string, unknown>
		)) {
			expect(localPrompt).toContain(`"${field}"`);
		}
	});

	test('stays short enough for a small context window', () => {
		// The agent prompt runs to several KB. A local model reads a few thousand
		// tokens in total, and the history and request still have to fit.
		expect(localPrompt.length).toBeLessThan(prompt.length / 2);
	});
});
