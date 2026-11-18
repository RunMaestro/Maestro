/**
 * The process a piped turn starts, decided before it exists (`planPipeSpawn`).
 *
 * The desktop's `ChildProcessSpawner` does not call it; its own suite pins the desktop's copy of
 * these rules. These pin the plan itself, with real provider definitions and no process.
 */
import * as fs from 'fs';
import * as childProcess from 'child_process';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createScratchDir } from '../../../__tests__/shared/maestro-lib/run/fakeAgent';
import { buildAgentLaunchPlan, type AgentLaunchInput } from '../launch/launch-plan';
import type { AcpPromptBlock } from '../launch/image-refs';
import * as definitions from '../providers/definitions';
import { SSH_STDIN_REMOTE_SHELL } from '../control/ssh-remote-signal';
import * as remoteSignal from '../control/ssh-remote-signal';
import { guardTurn } from '../control/turn-guard';
import { logger } from '../host';
import { startTurn, type TurnHandle, type TurnExit } from './start-turn';
import { getAgentDefinition } from '../providers/definitions';
import {
	argsResumeSession,
	planPipeSpawn,
	removeTempFiles,
	resumeIdFromArgs,
	type PipeSpawnConfig,
} from './pipe-spawn';

vi.mock('child_process', async (original) => ({
	...(await original<typeof childProcess>()),
}));
vi.mock('../control/ssh-remote-signal', async (original) => ({
	...(await original<typeof remoteSignal>()),
}));
vi.mock('fs', async (importOriginal) => ({ ...(await importOriginal<typeof fs>()) }));
vi.mock('../providers/definitions', async (importOriginal) => ({
	...(await importOriginal<typeof definitions>()),
}));

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

	describe('explicit prompt-file handoff', () => {
		let scratch: ReturnType<typeof createScratchDir>;
		let input: AgentLaunchInput;
		let delivery: NonNullable<PipeSpawnConfig['promptDelivery']>;
		const saveImageToTempFile = vi.fn(() => 'unexpected-image.png');
		const imagePromptBuilder = vi.fn(() => 'unexpected image prefix');
		const imageArgs = vi.fn(() => ['--unexpected-image']);
		const promptArgs = vi.fn(() => ['--unexpected-prompt']);
		const blocks: AcpPromptBlock[] = [
			{ type: 'text', text: '' },
			{ type: 'image', data: 'AQID', mimeType: 'image/png' },
			{ type: 'text', text: '  Compare "these"\r\n日本語 😀\n' },
			{ type: 'image', data: 'BAUG', mimeType: 'image/jpeg' },
		];
		const support = {
			mimeTypes: ['image/png', 'image/jpeg'],
			maxCount: 2,
			maxBytesPerImage: 3,
			maxTotalBytes: 6,
		};

		beforeEach(() => {
			vi.clearAllMocks();
			scratch = createScratchDir('maestro-pipe-artifact');
			vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
				throw new Error('Planning must not write prompt or image files.');
			});
			const lookup = definitions.getAgentDefinition;
			// Opt in only this fixture; the real Grok declaration stays inactive.
			const agent = {
				...lookup('grok')!,
				promptFile: { format: 'acp-json' as const, exclusivePromptFlags: ['-p', '--prompt-file'] },
				promptFileArgs: (file: string) => ['--prompt-file', file],
			};
			vi.spyOn(definitions, 'getAgentDefinition').mockImplementation((id) =>
				id === 'grok' ? agent : lookup(id)
			);
			input = {
				surface: 'desktop',
				agent,
				command: process.execPath,
				cwd: scratch.dir,
				args: ['--output-format', 'streaming-json'],
				promptFileDestination: { path: path.join(scratch.dir, 'prompt.json'), owner: 'local' },
				sessionCustomEnvVars: {},
				globalShellEnvVars: {},
			};
			const prepared = buildAgentLaunchPlan({ ...input, prompt: '' });
			if (!prepared.ok || prepared.plan.prompt.via !== 'file')
				throw new Error('Expected file plan');
			delivery = prepared.plan.prompt;
		});

		afterEach(() => {
			vi.restoreAllMocks();
			scratch.cleanup();
		});

		it.each([
			{ windows: false, resume: false },
			{ windows: false, resume: true },
			{ windows: true, resume: false },
			{ windows: true, resume: true },
		])(
			'passes ordered admitted images to the sink (Windows=$windows, resume=$resume)',
			({ windows, resume }) => {
				platform.windows = windows;
				const prepared = buildAgentLaunchPlan({
					...input,
					isWindowsHost: windows,
					hasImages: true,
					args: [...input.args, ...(resume ? ['--resume', 'saved-session'] : [])],
					promptBlocks: blocks,
					embeddedImageSupport: support,
				});
				if (!prepared.ok || prepared.plan.prompt.via !== 'file')
					throw new Error('Expected file plan');
				const launch = prepared.plan;
				const plan = planPipeSpawn(
					base({
						toolType: 'grok',
						command: launch.command,
						cwd: launch.cwd,
						args: launch.args,
						promptDelivery: prepared.plan.prompt,
						prompt: 'must not travel separately',
						images: ['data:image/png;base64,AQID', 'data:image/jpeg;base64,BAUG'],
						imageArgs,
						imagePromptBuilder,
						promptArgs,
						sendPromptViaStdin: true,
						sendPromptViaStdinRaw: true,
					}),
					{ saveImageToTempFile }
				);

				expect(plan.spec.promptArtifact).toEqual({
					path: input.promptFileDestination!.path,
					owner: 'local',
					content: JSON.stringify({ type: 'acp', content: blocks }),
					encoding: 'utf8',
					mode: 0o600,
					flag: 'wx',
					cleanup: 'turn',
				});
				expect(plan.spec.promptArtifact).not.toBe(prepared.plan.prompt.artifact);
				expect(plan.args).toEqual(launch.args);
				expect(plan.args.filter((arg) => arg === '--prompt-file')).toHaveLength(1);
				expect(plan.spec.args).toEqual(launch.args);
				expect(plan.spec.args.join(' ')).not.toContain('must not travel separately');
				expect(plan.spec.args.join(' ')).not.toContain('AQID');
				expect(plan.spec.stdin).toBeUndefined();
				expect(plan.tempFiles).toEqual([]);
				expect(plan.isBatchMode).toBe(true);
				expect(plan.keepStdinOpen).toBe(false);
				expect(plan.isResuming).toBe(resume);
				expect(saveImageToTempFile).not.toHaveBeenCalled();
				expect(imagePromptBuilder).not.toHaveBeenCalled();
				expect(imageArgs).not.toHaveBeenCalled();
				expect(promptArgs).not.toHaveBeenCalled();
				expect(fs.writeFileSync).not.toHaveBeenCalled();
				expect(fs.readdirSync(scratch.dir)).toEqual([]);
			}
		);

		it('keeps an empty file prompt in batch mode without writing or opening stdin', () => {
			const plan = planPipeSpawn(
				base({
					toolType: 'grok',
					args: [...input.args, ...delivery.args],
					prompt: '',
					promptDelivery: delivery,
				})
			);
			expect(plan.spec.promptArtifact?.content).toBe(
				'{"type":"acp","content":[{"type":"text","text":""}]}'
			);
			expect(plan.spec.stdin).toBeUndefined();
			expect(plan.isBatchMode).toBe(true);
			expect(plan.keepStdinOpen).toBe(false);
			expect(plan.tempFiles).toEqual([]);
			expect(fs.writeFileSync).not.toHaveBeenCalled();
		});

		it.each([
			{ label: 'missing', admitted: undefined },
			{ label: 'invalid', admitted: { ...support, maxCount: 0 } },
		])('refuses $label image admission before any pipe handoff', ({ admitted }) => {
			const prepared = buildAgentLaunchPlan({
				...input,
				hasImages: true,
				promptBlocks: blocks,
				embeddedImageSupport: admitted,
			});
			expect(prepared).toEqual({
				ok: false,
				reason: 'prompt-delivery-refused',
				error: 'Embedded images require explicit support and bounded image limits.',
			});
			// A caller cannot recover the refused plan by handing raw inputs to the pipe.
			expect(() =>
				planPipeSpawn(
					base({
						toolType: 'grok',
						args: input.args,
						prompt: 'must not fall back',
						images: ['data:image/png;base64,AQID'],
						imageArgs,
						imagePromptBuilder,
						sendPromptViaStdinRaw: true,
					}),
					{ saveImageToTempFile }
				)
			).toThrow('Explicit prompt-file delivery must be planned before pipe spawning.');
			expect(saveImageToTempFile).not.toHaveBeenCalled();
			expect(fs.writeFileSync).not.toHaveBeenCalled();
			expect(fs.readdirSync(scratch.dir)).toEqual([]);
		});

		it.each([
			{ label: 'empty', prompt: '' },
			{ label: 'text', prompt: 'must not fall back' },
			{ label: 'image-only', images: ['data:image/png;base64,AQID'] },
		])(
			'refuses an unplanned $label turn despite legacy stdin and argv options',
			({ label: _label, ...turn }) => {
				expect(() =>
					planPipeSpawn(
						base({
							toolType: 'grok',
							args: input.args,
							...turn,
							promptArgs,
							imageArgs,
							imagePromptBuilder,
							sendPromptViaStdin: true,
							sendPromptViaStdinRaw: true,
						}),
						{ saveImageToTempFile }
					)
				).toThrow('Explicit prompt-file delivery must be planned before pipe spawning.');
				expect(saveImageToTempFile).not.toHaveBeenCalled();
				expect(promptArgs).not.toHaveBeenCalled();
				expect(fs.writeFileSync).not.toHaveBeenCalled();
			}
		);

		it.each(['missing', 'changed', 'not-at-tail', 'empty'] as const)(
			'refuses %s file arguments without producing an alternate prompt source',
			(kind) => {
				const args = [...input.args, ...delivery.args];
				if (kind === 'missing') args.pop();
				if (kind === 'changed') args[args.length - 1] = path.join(scratch.dir, 'other.json');
				if (kind === 'not-at-tail') args.push('--verbose');
				if (kind === 'empty') delivery = { ...delivery, args: [] };
				expect(() =>
					planPipeSpawn(
						base({
							toolType: 'grok',
							args,
							promptDelivery: delivery,
							prompt: 'must not fall back',
							sendPromptViaStdinRaw: true,
						})
					)
				).toThrow('Prompt-file arguments must match the final launch plan.');
				expect(fs.writeFileSync).not.toHaveBeenCalled();
			}
		);

		describe('sink and remote stop ownership', () => {
			let child: childProcess.ChildProcess;
			let current: TurnHandle | undefined;
			beforeEach(() => {
				current = undefined;
				child = Object.assign(new EventEmitter(), {
					pid: 4242,
					exitCode: null,
					signalCode: null,
					kill: vi.fn(() => true),
					stdin: new PassThrough(),
					stdout: new PassThrough(),
					stderr: new PassThrough(),
				}) as unknown as childProcess.ChildProcess;
				vi.spyOn(childProcess, 'spawn').mockReturnValue(child);
				vi.spyOn(remoteSignal, 'signalRemoteAgent').mockReturnValue(true);
				for (const level of ['debug', 'info', 'warn'] as const)
					vi.spyOn(logger, level).mockImplementation(() => {});
			});
			afterEach(async () => {
				child.emit('close', 0, null);
				await current?.done;
				child.stdin?.destroy();
				child.stdout?.destroy();
				child.stderr?.destroy();
			});

			it.each(['', 'Private Unicode 雪\n"quoted" & $HOME\r\n'.repeat(1000)])(
				'materializes the local pipe artifact once at the shared sink (%#)',
				async (prompt) => {
					const prepared = buildAgentLaunchPlan({ ...input, prompt });
					if (!prepared.ok || prepared.plan.prompt.via !== 'file')
						throw new Error('Expected file plan');
					const plan = planPipeSpawn(
						base({
							toolType: 'grok',
							command: input.command,
							cwd: scratch.dir,
							args: prepared.plan.args,
							promptDelivery: prepared.plan.prompt,
						})
					);
					expect(fs.writeFileSync).not.toHaveBeenCalled();
					vi.mocked(fs.writeFileSync).mockRestore();
					const write = vi.spyOn(fs, 'writeFileSync');
					const open = vi.spyOn(fs, 'openSync');
					const file = prepared.plan.prompt.artifact.path;
					current = startTurn(plan.spec, {}, { stopGraceMs: 200 });
					expect(open).toHaveBeenCalledExactlyOnceWith(file, 'wx', 0o600);
					expect(write).toHaveBeenCalledTimes(1);
					expect(fs.readFileSync(file, 'utf8')).toBe(
						JSON.stringify({ type: 'acp', content: [{ type: 'text', text: prompt }] })
					);
					expect(childProcess.spawn).toHaveBeenCalledTimes(1);
					expect((child.stdin as PassThrough).read()).toBeNull();
					child.emit('exit', 0, null);
					expect(fs.existsSync(file)).toBe(true);
					child.emit('close', 0, null);
					await current.done;
					expect(fs.existsSync(file)).toBe(false);
					expect(plan.tempFiles).toEqual([]);
					expect(remoteSignal.signalRemoteAgent).not.toHaveBeenCalled();
					const diagnostics = JSON.stringify([
						vi.mocked(logger.debug).mock.calls,
						vi.mocked(logger.info).mock.calls,
						vi.mocked(logger.warn).mock.calls,
					]);
					expect(diagnostics).not.toContain(file);
					expect(diagnostics).not.toContain('Private Unicode');
				}
			);

			it.each(['', 'private-remote-content 雪'])(
				'binds remote cleanup to one PID and the existing stop guard (%#)',
				(prompt) => {
					const artifactPath = '/tmp/private-remote-prompt.json';
					const sshArgs = ['-o', 'BatchMode=yes', 'dev@build', ...SSH_STDIN_REMOTE_SHELL];
					const script = 'exec /remote/custom-grok --prompt-file ' + artifactPath;
					const plan = planPipeSpawn(
						base({
							toolType: 'grok',
							command: 'ssh',
							args: sshArgs,
							sshStdinScript: script,
							promptArtifactPath: artifactPath,
							prompt,
							images: ['data:image/png;base64,AQID'],
							imageArgs,
							imagePromptBuilder,
							promptArgs,
							sendPromptViaStdin: true,
							sendPromptViaStdinRaw: true,
						}),
						{ saveImageToTempFile }
					);
					expect(plan.remoteAgent).toEqual({
						sshCommand: 'ssh',
						sshArgs,
						sessionId: 's1',
						promptArtifactPath: artifactPath,
						pidFile: expect.stringMatching(/^\/tmp\/maestro-prompt-owner-[0-9a-f-]{36}\.pid$/),
					});
					expect(plan.spec.stdin?.match(/readonly _maestro_prompt_pid_file=/g)).toHaveLength(1);
					expect(plan.spec.stdin).not.toContain('maestro-agent-');
					expect(plan.spec.stdin).toContain(script);
					expect(plan.spec.stdin).not.toContain('private-remote-content');
					expect(plan.spec.promptArtifact).toBeUndefined();
					expect(plan.args).toEqual(sshArgs);
					expect(plan.isBatchMode).toBe(true);
					expect(plan.keepStdinOpen).toBe(false);
					expect(plan.tempFiles).toEqual([]);
					const terminate = vi.fn();
					const stops = guardTurn(
						{
							child,
							done: new Promise<TurnExit>(() => {}),
							interrupt: vi.fn(),
							terminate,
							terminateNow: vi.fn(),
						},
						{ sessionId: 's1', graceMs: 200, remote: plan.remoteAgent }
					);
					stops.terminate();
					expect(remoteSignal.signalRemoteAgent).toHaveBeenCalledExactlyOnceWith(
						plan.remoteAgent,
						'terminate'
					);
					expect(terminate).toHaveBeenCalledTimes(1);
					expect(fs.writeFileSync).not.toHaveBeenCalled();
					expect(saveImageToTempFile).not.toHaveBeenCalled();
					expect(imageArgs).not.toHaveBeenCalled();
					expect(imagePromptBuilder).not.toHaveBeenCalled();
					expect(promptArgs).not.toHaveBeenCalled();
					expect(childProcess.spawn).not.toHaveBeenCalled();
					const diagnostics = JSON.stringify([
						vi.mocked(logger.debug).mock.calls,
						vi.mocked(logger.info).mock.calls,
						vi.mocked(logger.warn).mock.calls,
					]);
					expect(diagnostics).not.toContain(artifactPath);
					expect(diagnostics).not.toContain('private-remote-content');
				}
			);

			it.each(['missing-script', 'local-plan', 'wrong-shell'] as const)(
				'refuses %s remote preparation before the sink without private diagnostics',
				(kind) => {
					const launch = () => {
						const plan = planPipeSpawn(
							base({
								toolType: 'grok',
								command: 'ssh',
								args:
									kind === 'wrong-shell'
										? ['dev@build', 'bash']
										: ['dev@build', ...SSH_STDIN_REMOTE_SHELL],
								sshStdinScript: kind === 'missing-script' ? undefined : 'private-script-content',
								promptArtifactPath: '/tmp/private-refused-prompt.json',
								promptDelivery: kind === 'local-plan' ? delivery : undefined,
							})
						);
						current = startTurn(plan.spec, {}, { stopGraceMs: 200 });
					};
					expect(launch).toThrow(
						new Error(
							kind === 'wrong-shell'
								? 'Remote prompt preparation unavailable.'
								: 'Prompt-file delivery does not match its host plan.'
						)
					);
					expect(childProcess.spawn).not.toHaveBeenCalled();
					expect(fs.writeFileSync).not.toHaveBeenCalled();
					expect(remoteSignal.signalRemoteAgent).not.toHaveBeenCalled();
					expect(fs.readdirSync(scratch.dir)).toEqual([]);
					const diagnostics = JSON.stringify([
						vi.mocked(logger.debug).mock.calls,
						vi.mocked(logger.info).mock.calls,
						vi.mocked(logger.warn).mock.calls,
					]);
					expect(diagnostics).not.toContain('private-script-content');
					expect(diagnostics).not.toContain('/tmp/private-refused-prompt.json');
				}
			);
		});

		it.each(['remote-owner', 'ssh-script'] as const)(
			'refuses local materialization for %s',
			(kind) => {
				if (kind === 'remote-owner') delivery.artifact.owner = 'remote';
				expect(() =>
					planPipeSpawn(
						base({
							toolType: 'grok',
							args: [...input.args, ...delivery.args],
							promptDelivery: delivery,
							sshStdinScript: kind === 'ssh-script' ? 'exec grok' : undefined,
						})
					)
				).toThrow('Remote prompt files must be prepared by the selected SSH transport.');
				expect(fs.writeFileSync).not.toHaveBeenCalled();
			}
		);
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
