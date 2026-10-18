/**
 * The process a piped turn starts, decided before it exists (`planPipeSpawn`).
 *
 * The desktop's `ChildProcessSpawner` does not call it; its own suite pins the desktop's copy of
 * these rules. These pin the plan itself, with real provider definitions and no process.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SSH_STDIN_REMOTE_SHELL } from '../control/ssh-remote-signal';
import { getAgentDefinition } from '../providers/definitions';
import {
	argsResumeSession,
	planPipeSpawn,
	removeTempFiles,
	resumeIdFromArgs,
	type PipeSpawnConfig,
} from './pipe-spawn';

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

		it('records the remote agent’s pid in an SSH stdin script, so Stop can reach it there', () => {
			const sshArgs = ['-o', 'BatchMode=yes', 'dev@build', ...SSH_STDIN_REMOTE_SHELL];
			const plan = planPipeSpawn(
				base({
					sessionId: 'gc-1',
					toolType: 'claude-code',
					command: 'ssh',
					args: sshArgs,
					sshStdinScript: 'cd /work && exec claude --print',
					promptAlreadyInArgs: true,
				})
			);

			const pidFile = plan.remoteAgent?.pidFile;
			expect(pidFile).toMatch(/^\/tmp\/maestro-agent-[0-9a-f-]+\.pid$/);
			expect(plan.remoteAgent).toEqual({
				sshCommand: 'ssh',
				sshArgs,
				pidFile,
				sessionId: 'gc-1',
			});
			expect(plan.spec.stdin).toContain(pidFile);
			expect(plan.spec.stdin?.endsWith('\ncd /work && exec claude --print')).toBe(true);
		});

		it('records nothing for an SSH command that does not end in the stdin shell', () => {
			const plan = planPipeSpawn(
				base({
					command: 'ssh',
					args: ['host', '/bin/bash'],
					sshStdinScript: 'cd /work && exec opencode',
					promptAlreadyInArgs: true,
				})
			);

			expect(plan.remoteAgent).toBeUndefined();
			expect(plan.spec.stdin).toBe('cd /work && exec opencode');
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
			expect(plan.tempFiles).toEqual(['/tmp/img-0.png', '/tmp/img-1.png']);
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

	describe('a prompt file (OMP on a Windows host)', () => {
		const omp = (overrides: Partial<PipeSpawnConfig> = {}) =>
			base({
				toolType: 'omp',
				command: 'C:\\tools\\omp.exe',
				args: ['-p', '--mode', 'json', '--resume', 'saved-session'],
				prompt: 'Private playbook "quoted" & %PATH% 日本語\n'.repeat(500),
				...overrides,
			});
		let made: string[] = [];
		afterEach(() => {
			for (const file of made) fs.rmSync(file, { force: true });
			made = [];
		});

		it('moves the prompt off the command line into an owner-only attachment the caller removes', () => {
			platform.windows = true;
			const config = omp();

			const plan = planPipeSpawn(config);
			made = plan.tempFiles;

			const attachment = plan.args.at(-1)!;
			expect(attachment.startsWith('@')).toBe(true);
			const file = attachment.slice(1);
			// The `--` before the prompt goes with it: OMP would read `@file` after it as text.
			expect(plan.args).toEqual(['-p', '--mode', 'json', '--resume', 'saved-session', attachment]);
			expect(path.dirname(file)).toBe(os.tmpdir());
			expect(plan.tempFiles).toEqual([file]);
			expect(fs.readFileSync(file, 'utf8')).toBe(config.prompt);
			if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
			expect(plan.spec.stdin).toBeUndefined();
		});

		it('keeps the prompt on the command line off Windows, and over SSH', () => {
			const local = planPipeSpawn(omp());
			expect(local.tempFiles).toEqual([]);
			expect(local.args.at(-1)).toBe(omp().prompt);

			platform.windows = true;
			const remote = planPipeSpawn(
				omp({ sshStdinScript: 'exec omp', promptAlreadyInArgs: true, args: ['host'] })
			);
			expect(remote.tempFiles).toEqual([]);
		});
	});

	describe('resume arguments', () => {
		it('tells a resuming turn, and names the session it resumes', () => {
			expect(argsResumeSession(['--print', '--resume', 'abc'])).toBe(true);
			expect(argsResumeSession(['run', '--session', 'abc'])).toBe(true);
			expect(argsResumeSession(['--print'])).toBe(false);
			expect(resumeIdFromArgs(['--print', '--resume', 'abc'])).toBe('abc');
			expect(resumeIdFromArgs(['--resume=def'])).toBe('def');
			expect(resumeIdFromArgs(['--resume'])).toBeUndefined();
			expect(resumeIdFromArgs(['run', '--session', 'abc'])).toBeUndefined();
		});
	});

	describe('removeTempFiles', () => {
		it('removes each file and passes over one that is already gone', async () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-pipe-spawn-'));
			const file = path.join(dir, 'prompt.txt');
			fs.writeFileSync(file, 'x');

			removeTempFiles([path.join(dir, 'gone.txt'), file]);

			await vi.waitFor(() => expect(fs.existsSync(file)).toBe(false));
			fs.rmSync(dir, { recursive: true, force: true });
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
