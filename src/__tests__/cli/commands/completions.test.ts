/**
 * Tests for the completions command.
 *
 * The generator reads the live Commander tree, so a verb or flag registered in
 * `src/cli/index.ts` reaches the scripts with no second list to keep. These
 * tests pin that contract with the verbs and flags the peer roster and Group
 * Settings work added, including a negated flag (`--no-group-defaults`).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

vi.mock('../../../cli/output/formatter', () => ({
	formatError: (message: string) => `error: ${message}`,
}));

import { completions } from '../../../cli/commands/completions';

function buildProgram(): Command {
	const program = new Command('maestro-cli');
	program.option('--version');
	program.command('create-agent <name>').option('--group <group-id>').option('--no-group-defaults');
	program
		.command('update-agent <agent-id>')
		.option('--peer <agent:access>')
		.option('--peer-note <agent:text>')
		.option('--remove-peer <agent>')
		.option('--group-peers <r|w|rw|off>')
		.option('--worktree-peers <r|w|rw|off>');
	program.command('group-settings <group-id>').option('--json');
	program
		.command('update-group-settings <group-id>')
		.option('--short-label <text>')
		.option('--clear')
		.option('--publish')
		.option('--yes');
	return program;
}

function emit(shell: string): string {
	const logged: string[] = [];
	const spy = vi.spyOn(console, 'log').mockImplementation((line?: unknown) => {
		logged.push(String(line));
	});
	try {
		completions(buildProgram(), shell);
	} finally {
		spy.mockRestore();
	}
	return logged.join('\n');
}

describe('completions', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it.each(['bash', 'zsh', 'fish'])(
		'lists the group verbs and the flags they take for %s',
		(shell) => {
			const script = emit(shell);

			expect(script).toContain('group-settings');
			expect(script).toContain('update-group-settings');
			for (const flag of ['short-label', 'publish', 'yes']) {
				expect(script).toContain(flag);
			}
		}
	);

	it.each(['bash', 'zsh', 'fish'])('lists the peer flags of update-agent for %s', (shell) => {
		const script = emit(shell);

		for (const flag of ['peer', 'peer-note', 'remove-peer', 'group-peers', 'worktree-peers']) {
			expect(script).toContain(flag);
		}
	});

	it.each(['bash', 'zsh', 'fish'])(
		'lists --group and --no-group-defaults of create-agent for %s',
		(shell) => {
			const script = emit(shell);

			expect(script).toContain('no-group-defaults');
			expect(script).toContain('group');
		}
	);

	it('keeps each command flags on its own command in bash', () => {
		const script = emit('bash');
		const createLine = script.split('\n').find((l) => l.includes('create-agent)')) ?? '';

		expect(createLine).toContain('--no-group-defaults');
		expect(createLine).not.toContain('--peer');
	});

	it('rejects an unsupported shell', () => {
		const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
			throw new Error('exit');
		}) as never);
		const err = vi.spyOn(console, 'error').mockImplementation(() => {});

		expect(() => completions(buildProgram(), 'powershell')).toThrow('exit');
		expect(err).toHaveBeenCalledWith(expect.stringContaining('Unsupported shell'));
		expect(exit).toHaveBeenCalled();
	});
});
