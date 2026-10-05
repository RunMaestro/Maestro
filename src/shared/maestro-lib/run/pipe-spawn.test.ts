/**
 * The process a piped turn starts, decided before it exists (`planPipeSpawn`).
 *
 * The desktop's `ChildProcessSpawner` has its own suite over the same function (its 46 cases run
 * through it); these pin the plan itself, with real provider definitions and no process.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getAgentDefinition } from '../providers/definitions';
import { planPipeSpawn, type PipeSpawnConfig } from './pipe-spawn';

const platform = vi.hoisted(() => ({ windows: false }));
vi.mock('../../platformDetection', () => ({
	isWindows: () => platform.windows,
	isMacOS: () => false,
	isLinux: () => !platform.windows,
}));

const base = (overrides: Partial<PipeSpawnConfig> = {}): PipeSpawnConfig => ({
	sessionId: 's1',
	toolType: 'opencode',
	cwd: '/work',
	command: '/bin/agent',
	args: ['run', '--format', 'json'],
	hasOutputParser: true,
	...overrides,
});

describe('planPipeSpawn', () => {
	beforeEach(() => {
		platform.windows = false;
	});
	afterEach(() => {
		platform.windows = false;
	});

	describe('where the prompt travels', () => {
		it('puts a batch prompt on the command line after `--`, and closes stdin', () => {
			const plan = planPipeSpawn(base({ prompt: 'hello' }));

			expect(plan.args).toEqual(['run', '--format', 'json', '--', 'hello']);
			expect(plan.spec).toMatchObject({
				command: '/bin/agent',
				args: ['run', '--format', 'json', '--', 'hello'],
				cwd: '/work',
				shell: false,
			});
			expect(plan.spec.stdin).toBeUndefined();
			expect(plan.isBatchMode).toBe(true);
			expect(plan.keepStdinOpen).toBe(false);
		});

		it('uses the provider’s own prompt flag and separator rules', () => {
			const flag = planPipeSpawn(base({ prompt: 'hi', promptArgs: (p) => ['-p', p] }));
			expect(flag.spec.args.slice(-2)).toEqual(['-p', 'hi']);

			const bare = planPipeSpawn(base({ prompt: 'hi', noPromptSeparator: true }));
			expect(bare.spec.args.slice(-2)).toEqual(['json', 'hi']);
		});

		it('sends a stream-json message over stdin when the arguments ask for it, and keeps the prompt off argv', () => {
			const plan = planPipeSpawn(
				base({
					toolType: 'claude-code',
					args: ['--print', '--output-format', 'stream-json', '--input-format', 'stream-json'],
					prompt: 'summarize',
				})
			);

			expect(plan.spec.args).not.toContain('summarize');
			const message = JSON.parse(plan.spec.stdin ?? '{}');
			expect(message).toMatchObject({
				type: 'user',
				message: { role: 'user', content: [{ type: 'text', text: 'summarize' }] },
			});
			expect(plan.spec.stdin?.endsWith('\n')).toBe(true);
			expect(plan.keepStdinOpen).toBe(false);
		});

		it('sends the prompt as raw text, and adds the provider’s stdin flags, when told', () => {
			const hermes = getAgentDefinition('hermes')!;
			const plan = planPipeSpawn(
				base({
					toolType: 'hermes',
					command: 'hermes',
					args: [...hermes.batchModePrefix!, ...hermes.batchModeArgs!],
					prompt: 'long prompt',
					sendPromptViaStdinRaw: true,
				})
			);

			expect(plan.spec.stdin).toBe('long prompt');
			expect(plan.spec.args).not.toContain('long prompt');
			expect(plan.spec.args.slice(-hermes.stdinPromptArgs!.length)).toEqual(hermes.stdinPromptArgs);
		});

		it('sends an SSH script as the whole of stdin, with no local prompt flags', () => {
			const plan = planPipeSpawn(
				base({
					toolType: 'claude-code',
					command: 'ssh',
					args: ['host', '/bin/bash'],
					prompt: 'ignored locally',
					sendPromptViaStdinRaw: true,
					sshStdinScript: 'cd /work && claude --print',
					promptAlreadyInArgs: true,
				})
			);

			expect(plan.spec.stdin).toBe('cd /work && claude --print');
			expect(plan.spec.args).toEqual(['host', '/bin/bash']);
			expect(plan.isStreamJsonMode).toBe(true);
		});

		it('leaves stdin open for an interactive process with nothing to say', () => {
			const plan = planPipeSpawn(base());

			expect(plan.isBatchMode).toBe(false);
			expect(plan.keepStdinOpen).toBe(true);
			expect(plan.spec.stdin).toBeUndefined();
		});
	});

	describe('what the turn is', () => {
		it('reads a stream of JSON from the provider’s flags or its parser, not from the prompt', () => {
			expect(
				planPipeSpawn(base({ prompt: 'Explain --json', hasOutputParser: false, args: ['run'] }))
					.isStreamJsonMode
			).toBe(false);
			expect(
				planPipeSpawn(base({ hasOutputParser: false, args: ['run', '--json'] })).isStreamJsonMode
			).toBe(true);
			expect(
				planPipeSpawn(base({ hasOutputParser: false, args: ['--output-format=stream-json'] }))
					.isStreamJsonMode
			).toBe(true);
			expect(planPipeSpawn(base({ hasOutputParser: true, args: ['run'] })).isStreamJsonMode).toBe(
				true
			);
		});

		it('says when the arguments resume a provider session', () => {
			expect(planPipeSpawn(base({ args: ['--resume', 'abc'] })).isResuming).toBe(true);
			expect(planPipeSpawn(base({ args: ['--resume=abc'] })).isResuming).toBe(true);
			expect(planPipeSpawn(base({ args: ['run', '--session', 'abc'] })).isResuming).toBe(true);
			expect(planPipeSpawn(base()).isResuming).toBe(false);
		});

		it('builds the environment from the agent’s own variables over the global ones', () => {
			const plan = planPipeSpawn(
				base({
					customEnvVars: { FROM_AGENT: 'agent', SHARED: 'agent' },
					shellEnvVars: { FROM_GLOBAL: 'global', SHARED: 'global' },
				})
			);

			expect(plan.spec.env.FROM_AGENT).toBe('agent');
			expect(plan.spec.env.FROM_GLOBAL).toBe('global');
			expect(plan.spec.env.SHARED).toBe('agent');
		});
	});

	describe('images', () => {
		const png = 'data:image/png;base64,AAAA';

		it('rides a stream-json provider’s stdin and adds the input format', () => {
			const plan = planPipeSpawn(
				base({ toolType: 'claude-code', args: ['--print'], prompt: 'look', images: [png] })
			);

			expect(plan.spec.args).toEqual(['--print', '--input-format', 'stream-json']);
			const content = JSON.parse(plan.spec.stdin ?? '{}').message.content;
			expect(content[0]).toMatchObject({ type: 'image', source: { data: 'AAAA' } });
			expect(content[1]).toEqual({ type: 'text', text: 'look' });
			expect(plan.isStreamJsonMode).toBe(true);
		});

		it('writes a file-based provider’s images to temp files through the host', () => {
			const saved: Array<[string, number]> = [];
			const plan = planPipeSpawn(
				base({
					toolType: 'codex',
					args: ['exec'],
					prompt: 'look',
					images: [png, png],
					imageArgs: (file) => ['-i', file],
				}),
				{
					saveImageToTempFile: (dataUrl, index) => {
						saved.push([dataUrl, index]);
						return `/tmp/img-${index}.png`;
					},
				}
			);

			expect(saved).toEqual([
				[png, 0],
				[png, 1],
			]);
			expect(plan.tempImageFiles).toEqual(['/tmp/img-0.png', '/tmp/img-1.png']);
			expect(plan.spec.args).toEqual(
				expect.arrayContaining(['-i', '/tmp/img-0.png', '/tmp/img-1.png'])
			);
		});

		it('refuses a file-based provider when the host gave no way to write the file', () => {
			expect(() =>
				planPipeSpawn(
					base({
						toolType: 'codex',
						prompt: 'look',
						images: [png],
						imageArgs: (file) => ['-i', file],
					})
				)
			).toThrow(/no image writer/);
		});
	});

	describe('the Windows shell', () => {
		beforeEach(() => {
			platform.windows = true;
		});

		it('runs a bare .exe through the shell so PATH resolves it, and quotes a path with spaces', () => {
			const bare = planPipeSpawn(base({ command: 'agent.exe', prompt: 'hi' }));
			expect(bare.spec.shell).toBe(true);

			const spaced = planPipeSpawn(
				base({ command: 'C:\\Program Files\\agent\\agent.exe', runInShell: true, prompt: 'hi' })
			);
			expect(spaced.spec.shell).toBe(true);
			expect(spaced.spec.command).toBe('"C:\\Program Files\\agent\\agent.exe"');
		});

		it('escapes the arguments for the named shell and leaves its own quoting to it', () => {
			const plan = planPipeSpawn(
				base({
					command: 'C:\\Program Files\\agent.exe',
					runInShell: true,
					shell: 'powershell.exe',
					args: ['run'],
					prompt: 'say "hi" & bye',
				})
			);

			expect(plan.spec.shell).toBe('powershell.exe');
			// An explicit shell carries its own quoting rules: the command is not wrapped.
			expect(plan.spec.command).toBe('C:\\Program Files\\agent.exe');
			// The record keeps what was asked; the process gets what the shell can read.
			expect(plan.args).toEqual(['run', '--', 'say "hi" & bye']);
			expect(plan.spec.args).not.toEqual(plan.args);
		});

		it('does nothing special off Windows', () => {
			platform.windows = false;
			const plan = planPipeSpawn(base({ command: 'agent.exe', prompt: 'hi' }));
			expect(plan.spec.shell).toBe(false);
			expect(plan.spec.args).toEqual(plan.args);
		});
	});
});
