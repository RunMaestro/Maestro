/**
 * What a group chat or consult turn decides before its process exists (`prepareGroupChatSpawn`):
 * the Claude token source, the SSH wrap, the Windows shell, and the turn clock, over the real
 * realizers and fake host collaborators.
 */
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { STEERING_SOCKET_ENV_VAR } from '../../../chatSteering';
import { resolveClaudeSpawnModeCore } from '../../launch/interactive-mode';
import { POSIX_PROMPT_ARGV_MAX_BYTES } from '../../launch/prompt-delivery';
import type { SshRemoteSettingsStore } from '../../launch/ssh-remote-resolver';
import { getAgentDefinition } from '../../providers/definitions';
import type { AgentConfig } from '../../providers/definitions';
import { getAgentCapabilities } from '../../providers/capabilities';
import { prepareGroupChatSpawn, type GroupChatSpawnDeps } from '../spawn';
import type { GroupChatSpawn } from '../types';

// Keep the real SSH wrapper/builder without running local binary discovery.
vi.mock('../../launch/ssh-path', () => ({ resolveSshPath: async () => 'ssh' }));

const claude = (): AgentConfig =>
	({
		...getAgentDefinition('claude-code')!,
		available: true,
		path: '/usr/local/bin/claude',
		capabilities: getAgentCapabilities('claude-code'),
	}) as AgentConfig;

const spawnOf = (overrides: Partial<GroupChatSpawn> = {}): GroupChatSpawn => ({
	processId: 'group-chat-p1',
	providerId: 'claude-code',
	agent: claude(),
	args: ['--print', '--', 'the prompt'],
	cwd: '/work',
	prompt: 'the prompt',
	...overrides,
});

const apiDecision = { mode: 'api', reason: 'auto', maestroPBinPath: null } as const;

function depsOf(overrides: Partial<GroupChatSpawnDeps> = {}): GroupChatSpawnDeps {
	return {
		sshStore: null,
		resolveClaudeSpawnMode: () => ({ ...apiDecision }),
		windowsSpawnConfig: () => ({
			shell: undefined,
			runInShell: false,
			sendPromptViaStdin: false,
			sendPromptViaStdinRaw: false,
		}),
		beginTurn: vi.fn(),
		...overrides,
	};
}

const remote = {
	id: 'r1',
	name: 'Box',
	host: 'box.local',
	port: 22,
	username: 'me',
	privateKeyPath: '~/.ssh/id_ed25519',
	enabled: true,
	useSshConfig: false,
};
const storeOf = (remotes: unknown[]): SshRemoteSettingsStore =>
	({ getSshRemotes: () => remotes }) as unknown as SshRemoteSettingsStore;

describe('prepareGroupChatSpawn', () => {
	describe('a local turn', () => {
		it('runs the agent’s own command with its arguments, and starts the turn clock once', async () => {
			const deps = depsOf();
			const prepared = await prepareGroupChatSpawn(spawnOf(), deps);

			expect(prepared).toMatchObject({
				processId: 'group-chat-p1',
				providerId: 'claude-code',
				command: '/usr/local/bin/claude',
				args: ['--print', '--', 'the prompt'],
				cwd: '/work',
				prompt: 'the prompt',
				readOnlyMode: false,
			});
			expect(deps.beginTurn).toHaveBeenCalledExactlyOnceWith('group-chat-p1');
		});

		it('prefers an explicit command over the agent’s, and carries the read-only flag', async () => {
			const prepared = await prepareGroupChatSpawn(
				spawnOf({ command: '/custom/claude', readOnlyMode: true }),
				depsOf()
			);
			expect(prepared.command).toBe('/custom/claude');
			expect(prepared.readOnlyMode).toBe(true);
		});

		it('resolves the context window from the provider’s config values', async () => {
			const prepared = await prepareGroupChatSpawn(
				spawnOf({ agentConfigValues: { contextWindow: 123_456 } }),
				depsOf()
			);
			expect(prepared.contextWindow).toBe(123_456);
		});

		it('passes the Windows shell and stdin choices through for the agent’s provider', async () => {
			const windowsSpawnConfig = vi.fn().mockReturnValue({
				shell: 'powershell.exe',
				runInShell: true,
				sendPromptViaStdin: true,
				sendPromptViaStdinRaw: false,
			});
			const prepared = await prepareGroupChatSpawn(spawnOf(), depsOf({ windowsSpawnConfig }));

			expect(windowsSpawnConfig).toHaveBeenCalledWith('claude-code', undefined);
			expect(prepared).toMatchObject({
				shell: 'powershell.exe',
				runInShell: true,
				sendPromptViaStdin: true,
				sendPromptViaStdinRaw: false,
			});
		});

		// MAESTRO-16C/16P/RM/VR: off Windows the Windows config is a no-op, so a synthesis or
		// consult whose prompt carried a long history went into argv and the spawn died with E2BIG.
		it('sends a prompt too long for the command line over stdin, for an agent that reads it', async () => {
			const long = 'x'.repeat(POSIX_PROMPT_ARGV_MAX_BYTES + 1);
			const prepared = await prepareGroupChatSpawn(spawnOf({ prompt: long }), depsOf());

			expect(prepared.prompt).toBe(long);
			expect(prepared.sendPromptViaStdinRaw).toBe(true);
			expect(prepared.sendPromptViaStdin).toBe(false);
		});

		it('keeps a normal prompt on the command line', async () => {
			const prepared = await prepareGroupChatSpawn(spawnOf(), depsOf());
			expect(prepared.sendPromptViaStdinRaw).toBe(false);
		});

		it('keeps an over-long prompt in argv for an agent that cannot read stdin', async () => {
			const omp = {
				...getAgentDefinition('omp')!,
				available: true,
				capabilities: getAgentCapabilities('omp'),
			} as AgentConfig;
			const prepared = await prepareGroupChatSpawn(
				spawnOf({
					providerId: 'omp',
					agent: omp,
					prompt: 'x'.repeat(POSIX_PROMPT_ARGV_MAX_BYTES + 1),
				}),
				depsOf()
			);
			expect(prepared.sendPromptViaStdinRaw).toBe(false);
		});
	});

	describe('the Claude token source', () => {
		it('asks for the agent’s mode, defaulting to the API, and the SSH state', async () => {
			const resolveClaudeSpawnMode = vi.fn().mockReturnValue({ ...apiDecision });
			await prepareGroupChatSpawn(spawnOf(), depsOf({ resolveClaudeSpawnMode }));
			await prepareGroupChatSpawn(
				spawnOf({ tokenMode: 'interactive' }),
				depsOf({ resolveClaudeSpawnMode })
			);

			expect(resolveClaudeSpawnMode.mock.calls[0][0]).toMatchObject({
				tokenMode: 'api',
				sshEnabled: false,
				command: '/usr/local/bin/claude',
			});
			expect(resolveClaudeSpawnMode.mock.calls[1][0]).toMatchObject({ tokenMode: 'interactive' });
		});

		it('runs maestro-p for the interactive mode, with the real binary named and an idle budget', async () => {
			const prepared = await prepareGroupChatSpawn(
				spawnOf({ tokenMode: 'interactive', maxWaitSeconds: 600 }),
				depsOf({
					resolveClaudeSpawnMode: (input) =>
						resolveClaudeSpawnModeCore(input, {
							getMaestroPBinPath: () => '/app/maestro-p.js',
							isMaestroPBinaryPath: (p) => !!p && p.includes('maestro-p'),
							resolveConfigDirKey: () => 'default',
							getUsageSnapshot: () => null,
							fileExists: () => true,
							getRemoteMaestroPAvailable: () => undefined,
							selectMode: () => ({ mode: 'interactive', reason: 'auto' }),
						}),
				})
			);

			expect(prepared.command).toBe(process.execPath);
			expect(prepared.args[0]).toBe('/app/maestro-p.js');
			expect(prepared.args).toEqual(expect.arrayContaining(['--max-wait', '600', '--print']));
			expect(prepared.customEnvVars).toMatchObject({ MAESTRO_CLAUDE_BIN: '/usr/local/bin/claude' });
		});

		it('passes the workspace-trust opt-in to maestro-p only when the turn asks for it (#1872)', async () => {
			const interactiveDeps = depsOf({
				resolveClaudeSpawnMode: (input) =>
					resolveClaudeSpawnModeCore(input, {
						getMaestroPBinPath: () => '/app/maestro-p.js',
						isMaestroPBinaryPath: (p) => !!p && p.includes('maestro-p'),
						resolveConfigDirKey: () => 'default',
						getUsageSnapshot: () => null,
						fileExists: () => true,
						getRemoteMaestroPAvailable: () => undefined,
						selectMode: () => ({ mode: 'interactive', reason: 'auto' }),
					}),
			});

			const trusted = await prepareGroupChatSpawn(
				spawnOf({ tokenMode: 'interactive', acceptWorkspaceTrust: true }),
				interactiveDeps
			);
			const untrusted = await prepareGroupChatSpawn(
				spawnOf({ tokenMode: 'interactive' }),
				interactiveDeps
			);

			expect(trusted.customEnvVars?.MAESTRO_P_ACCEPT_WORKSPACE_TRUST).toBe('1');
			expect(untrusted.customEnvVars?.MAESTRO_P_ACCEPT_WORKSPACE_TRUST).toBeUndefined();
		});
	});

	describe('the steering socket', () => {
		/** Resolves maestro-p (local interactive) whatever the SSH state, as a local decision would. */
		const localInteractive: GroupChatSpawnDeps['resolveClaudeSpawnMode'] = (input) =>
			resolveClaudeSpawnModeCore(
				{ ...input, sshEnabled: false, sshRemoteId: undefined },
				{
					getMaestroPBinPath: () => '/app/maestro-p.js',
					isMaestroPBinaryPath: (p) => !!p && p.includes('maestro-p'),
					resolveConfigDirKey: () => 'default',
					getUsageSnapshot: () => null,
					fileExists: () => true,
					getRemoteMaestroPAvailable: () => undefined,
					selectMode: () => ({ mode: 'interactive', reason: 'auto' }),
				}
			);

		it('opens one for a local maestro-p turn, keyed by the turn’s process id', async () => {
			const steeringSocketPath = vi.fn((processId: string) => `/tmp/steer-${processId}.sock`);
			const prepared = await prepareGroupChatSpawn(
				spawnOf({ tokenMode: 'interactive' }),
				depsOf({ resolveClaudeSpawnMode: localInteractive, steeringSocketPath })
			);

			expect(prepared.args[0]).toBe('/app/maestro-p.js');
			expect(steeringSocketPath).toHaveBeenCalledExactlyOnceWith('group-chat-p1');
			expect(prepared.customEnvVars).toMatchObject({
				[STEERING_SOCKET_ENV_VAR]: '/tmp/steer-group-chat-p1.sock',
				MAESTRO_CLAUDE_BIN: '/usr/local/bin/claude',
			});
		});

		it('opens none when the host cannot steer', async () => {
			const prepared = await prepareGroupChatSpawn(
				spawnOf({ tokenMode: 'interactive' }),
				depsOf({ resolveClaudeSpawnMode: localInteractive })
			);

			expect(prepared.args[0]).toBe('/app/maestro-p.js');
			expect(prepared.customEnvVars ?? {}).not.toHaveProperty(STEERING_SOCKET_ENV_VAR);
		});

		it('opens none for a turn that runs `claude --print`', async () => {
			const steeringSocketPath = vi.fn(() => '/tmp/steer.sock');
			const prepared = await prepareGroupChatSpawn(spawnOf(), depsOf({ steeringSocketPath }));

			expect(steeringSocketPath).not.toHaveBeenCalled();
			expect(prepared.customEnvVars ?? {}).not.toHaveProperty(STEERING_SOCKET_ENV_VAR);
		});

		it('opens none over SSH, since the socket is local', async () => {
			const steeringSocketPath = vi.fn(() => '/tmp/steer.sock');
			const prepared = await prepareGroupChatSpawn(
				spawnOf({ tokenMode: 'interactive', sshRemoteConfig: { enabled: true, remoteId: 'r1' } }),
				depsOf({
					sshStore: storeOf([remote]),
					resolveClaudeSpawnMode: localInteractive,
					steeringSocketPath,
				})
			);

			expect(steeringSocketPath).not.toHaveBeenCalled();
			expect(JSON.stringify(prepared)).not.toContain(STEERING_SOCKET_ENV_VAR);
		});
	});

	describe('an SSH remote', () => {
		const ssh = { enabled: true, remoteId: 'r1' };

		it('wraps the command so the agent runs on the remote, with its script on stdin', async () => {
			const prepared = await prepareGroupChatSpawn(
				spawnOf({ sshRemoteConfig: ssh }),
				depsOf({ sshStore: storeOf([remote]) })
			);

			expect(prepared.command).toMatch(/ssh(\.exe)?$/i);
			expect(prepared.sshStdinScript ?? prepared.sshRemoteCommand).toBeTruthy();
			// Nothing about the local binary survives into the process that is started.
			expect(prepared.command).not.toBe('/usr/local/bin/claude');
		});

		it('warms the remote maestro-p probe before it decides', async () => {
			const probeRemoteMaestroP = vi.fn().mockResolvedValue(undefined);
			const resolveClaudeSpawnMode = vi.fn().mockImplementation(() => {
				expect(probeRemoteMaestroP).toHaveBeenCalledTimes(1);
				return { ...apiDecision };
			});
			await prepareGroupChatSpawn(
				spawnOf({ sshRemoteConfig: ssh }),
				depsOf({ sshStore: storeOf([remote]), probeRemoteMaestroP, resolveClaudeSpawnMode })
			);

			expect(probeRemoteMaestroP).toHaveBeenCalledWith(expect.objectContaining({ id: 'r1' }));
		});

		it('fails loudly when the host has no SSH store, and never runs locally', async () => {
			await expect(
				prepareGroupChatSpawn(
					spawnOf({ sshRemoteConfig: ssh, debugLabel: 'participant: Alice' }),
					depsOf({ sshStore: null })
				)
			).rejects.toThrow(/sshStore is not available for participant: Alice/);
		});

		it('fails loudly when the remote the agent names is gone, instead of running against its directory here', async () => {
			await expect(
				prepareGroupChatSpawn(spawnOf({ sshRemoteConfig: ssh }), depsOf({ sshStore: storeOf([]) }))
			).rejects.toThrow(/SSH/);
		});

		it('does not start the turn clock for a launch that was refused', async () => {
			const deps = depsOf({ sshStore: storeOf([]) });
			await expect(
				prepareGroupChatSpawn(spawnOf({ sshRemoteConfig: ssh }), deps)
			).rejects.toThrow();
			expect(deps.beginTurn).not.toHaveBeenCalled();
		});
	});

	describe('private prompt ownership across an awaited SSH probe', () => {
		// Synthetic declaration only; the production Grok registry remains inactive.
		const grok: AgentConfig = {
			...getAgentDefinition('grok')!,
			available: true,
			path: path.resolve('local-grok'),
			capabilities: getAgentCapabilities('grok'),
			promptFile: {
				format: 'acp-json',
				exclusivePromptFlags: ['-p', '--single', '--prompt-json', '--prompt-file'],
			},
			promptFileArgs: (file) => ['--prompt-file', file],
		};
		const remoteCommand = path.posix.join('/opt', 'team tools', 'grok');
		const destination = {
			owner: 'remote' as const,
			sshRemoteId: remote.id,
			path: path.posix.join('/tmp', 'maestro-prompt-11111111-2222-4333-8444-555555555555.json'),
		};

		describe.each([false, true])('file preparation over SSH=%s', (ssh) => {
			describe.each([false, true])('resume=%s', (isResume) => {
				it.each([
					['short', '  private 雪\n'],
					['long', 'private 🧪\n'.repeat(1_000)],
					['empty', ''],
				])('delivers %s text only through its owned artifact', async (_label, prompt) => {
					const command = path.resolve('team tools', 'grok');
					const cwd = ssh ? path.posix.join('/remote', 'team work') : path.resolve('team work');
					const customEnvVars = { GROK_HOME: ssh ? '/remote/account' : path.resolve('account') };
					const sessionId = '019aa4fe-0000-7000-8000-000000000002';
					const args = ['--model', 'selected-model', ...(isResume ? ['--resume', sessionId] : [])];
					const promptArgs = vi.fn((text: string) => ['-p', text]);
					const deps = depsOf({
						sshStore: storeOf([{ ...remote, privateKeyPath: '' }]),
						windowsSpawnConfig: () => ({
							shell: undefined,
							runInShell: false,
							sendPromptViaStdin: true,
							sendPromptViaStdinRaw: true,
						}),
					});
					const prepared = await prepareGroupChatSpawn(
						{
							...spawnOf({
								providerId: 'grok',
								agent: { ...grok, promptArgs },
								command,
								args,
								cwd,
								customEnvVars,
								prompt,
								isResume,
								sshRemoteConfig: ssh ? { enabled: true, remoteId: remote.id } : undefined,
							}),
							promptFileDestination: ssh ? destination : undefined,
						},
						deps
					);
					const artifact = prepared.promptDelivery!.artifact;
					expect(artifact.content).toBe(
						JSON.stringify({ type: 'acp', content: [{ type: 'text', text: prompt }] })
					);
					expect(artifact).toMatchObject({
						owner: ssh ? 'remote' : 'local',
						encoding: 'utf8',
						mode: 0o600,
						flag: 'wx',
						cleanup: 'turn',
					});
					expect(prepared).toMatchObject({
						prompt: undefined,
						sendPromptViaStdin: false,
						sendPromptViaStdinRaw: false,
					});
					expect(promptArgs).not.toHaveBeenCalled();
					expect(deps.beginTurn).toHaveBeenCalledExactlyOnceWith('group-chat-p1');
					if (ssh) {
						expect(artifact).toMatchObject(destination);
						expect(prepared.command).toBe('ssh');
						expect(prepared.args).toContain('me@box.local');
						expect(prepared.promptArtifactPath).toBe(destination.path);
						const script = prepared.sshStdinScript!;
						expect(script).toContain(Buffer.from(artifact.content, 'utf8').toString('base64'));
						expect(script).toContain("cd '/remote/team work' || exit 1");
						expect(script).toContain("export GROK_HOME='/remote/account'");
						expect(script).toContain("'grok' '--model' 'selected-model'");
						expect(script.includes(`'--resume' '${sessionId}'`)).toBe(isResume);
						expect(script).toContain(`'--prompt-file' '${artifact.path}' </dev/null 8>&- 9>&-`);
						expect(script).not.toContain(command);
						expect(prepared.args.join(' ')).not.toContain(artifact.path);
					} else {
						expect(path.isAbsolute(artifact.path)).toBe(true);
						expect(artifact.path).toMatch(/maestro-prompt-[\da-f-]+\.json$/);
						expect(artifact.sshRemoteId).toBeUndefined();
						expect(prepared).toMatchObject({
							command,
							cwd,
							customEnvVars,
							args: [...args, '--prompt-file', artifact.path],
						});
						expect(prepared.sshStdinScript).toBeUndefined();
						expect(prepared.promptArtifactPath).toBeUndefined();
					}
				});
			});
		});

		it.each([false, true])(
			'forwards ordered local images only with admission=%s',
			async (admitted) => {
				const deps = depsOf();
				const promptBlocks = [
					{ type: 'text' as const, text: 'system\n before 雪' },
					{ type: 'image' as const, mimeType: 'image/png', data: 'AQID' },
					{ type: 'text' as const, text: '\tafter 🧪 ' },
				];
				const pending = prepareGroupChatSpawn(
					{
						...spawnOf({ providerId: 'grok', agent: grok, args: [], prompt: undefined }),
						promptBlocks,
						hasImages: true,
						embeddedImageSupport: admitted
							? { mimeTypes: ['image/png'], maxCount: 1, maxBytesPerImage: 3, maxTotalBytes: 3 }
							: undefined,
					},
					deps
				);
				if (!admitted) {
					await expect(pending).rejects.toThrow(
						'Embedded images require explicit support and bounded image limits.'
					);
					expect(deps.beginTurn).not.toHaveBeenCalled();
					return;
				}
				const prepared = await pending;
				expect(JSON.parse(prepared.promptDelivery!.artifact.content)).toEqual({
					type: 'acp',
					content: promptBlocks,
				});
				expect(prepared.prompt).toBeUndefined();
				expect(prepared.args).toEqual(['--prompt-file', prepared.promptDelivery!.artifact.path]);
				expect(deps.beginTurn).toHaveBeenCalledTimes(1);
			}
		);

		describe.each([false, true])('resume=%s', (isResume) => {
			it.each(['store replacement', 'store mutation', 'probe mutation', 'caller mutation'])(
				'keeps the original host, private bytes and cleanup ownership after %s',
				async (mutation) => {
					const selected = {
						...remote,
						privateKeyPath: '',
						sshOptions: { ProxyJump: 'original-bastion', ConnectTimeout: '17' },
						remoteEnv: { REMOTE_ACCOUNT: 'original-account' },
					};
					const remotes = [selected];
					const gate = Promise.withResolvers<void>();
					const probeRemoteMaestroP = vi.fn<NonNullable<GroupChatSpawnDeps['probeRemoteMaestroP']>>(
						() => gate.promise
					);
					const resolveClaudeSpawnMode = vi.fn().mockReturnValue({ ...apiDecision });
					const deps = depsOf({
						sshStore: storeOf(remotes),
						probeRemoteMaestroP,
						resolveClaudeSpawnMode,
					});
					const sessionId = '019aa4fe-0000-7000-8000-000000000001';
					const args = ['--model', 'original-model', ...(isResume ? ['--resume', sessionId] : [])];
					const request: Parameters<typeof prepareGroupChatSpawn>[0] = {
						...spawnOf({
							providerId: 'grok',
							agent: grok,
							args,
							prompt: undefined,
							isResume,
							cwd: path.posix.join('/remote', 'original work'),
							sshRemoteConfig: { enabled: true, remoteId: remote.id },
							customEnvVars: { GROK_HOME: '/remote/selected-account' },
						}),
						remoteCommand,
						promptBlocks: [
							{ type: 'text', text: '  before 雪\n' },
							{ type: 'image', mimeType: 'image/png', data: 'AQID' },
							{ type: 'text', text: '\t after 🧪  ' },
						],
						hasImages: true,
						embeddedImageSupport: {
							mimeTypes: ['image/png'],
							maxCount: 1,
							maxBytesPerImage: 3,
							maxTotalBytes: 3,
						},
						promptFileDestination: destination,
					};
					const pending = prepareGroupChatSpawn(request, deps);
					// This observable boundary proves the mutation occurs during the probe await.
					expect(probeRemoteMaestroP).toHaveBeenCalledExactlyOnceWith(selected);
					expect(resolveClaudeSpawnMode).not.toHaveBeenCalled();
					expect(deps.beginTurn).not.toHaveBeenCalled();

					if (mutation === 'store replacement') {
						remotes[0] = {
							...selected,
							host: 'replacement.invalid',
							username: 'replacement-user',
							port: 2200,
							sshOptions: { ProxyJump: 'replacement-bastion', ConnectTimeout: '99' },
							remoteEnv: { REMOTE_ACCOUNT: 'replacement-account' },
						};
					} else if (mutation === 'caller mutation') {
						request.sshRemoteConfig!.enabled = false;
						request.sshRemoteConfig!.remoteId = 'replacement-id';
						request.customEnvVars!.GROK_HOME = '/replacement/account';
						request.args.splice(0, request.args.length, '--model', 'replacement-model');
						request.remoteCommand = '/replacement/grok';
						request.cwd = '/replacement/work';
					} else {
						const target =
							mutation === 'probe mutation' ? probeRemoteMaestroP.mock.calls[0][0] : selected;
						target.host = 'replacement.invalid';
						target.username = 'replacement-user';
						target.port = 2200;
						target.sshOptions!.ProxyJump = 'replacement-bastion';
						target.sshOptions!.ConnectTimeout = '99';
						target.remoteEnv!.REMOTE_ACCOUNT = 'replacement-account';
					}
					gate.resolve();
					const prepared = await pending;
					expect(prepared.command).toBe('ssh');
					expect(prepared.args).toEqual(
						expect.arrayContaining([
							'me@box.local',
							'-p',
							'22',
							'ProxyJump=original-bastion',
							'ConnectTimeout=17',
						])
					);
					expect(prepared.args.slice(-4)).toEqual(['/bin/bash', '--norc', '--noprofile', '-s']);
					expect(prepared.promptDelivery?.artifact).toMatchObject({
						...destination,
						mode: 0o600,
						flag: 'wx',
						cleanup: 'turn',
					});
					const artifact = prepared.promptDelivery!.artifact;
					expect(JSON.parse(artifact.content)).toEqual({
						type: 'acp',
						content: request.promptBlocks,
					});
					const script = prepared.sshStdinScript!;
					const payload = script.match(
						/<<'MAESTRO_PROMPT_EOF'[^\n]*\n([A-Za-z0-9+/=]+)\nMAESTRO_PROMPT_EOF/
					);
					expect(payload).not.toBeNull();
					expect(Buffer.from(payload![1], 'base64')).toEqual(Buffer.from(artifact.content, 'utf8'));
					expect(script).toContain("export REMOTE_ACCOUNT='original-account'");
					expect(script).toContain("export GROK_HOME='/remote/selected-account'");
					expect(script).toContain("cd '/remote/original work' || exit 1");
					expect(script).toContain(`'${remoteCommand}' '--model' 'original-model'`);
					expect(script.includes(`'--resume' '${sessionId}'`)).toBe(isResume);
					expect(script).toContain(`'--prompt-file' '${artifact.path}' </dev/null 8>&- 9>&-`);
					// These are the inputs handed to the existing PID/stop owner, not a native cleanup run.
					expect(prepared.promptArtifactPath).toBe(artifact.path);
					expect(script).toContain(
						`[ "\${_maestro_prompt_path-}" = '${prepared.promptArtifactPath}' ]`
					);
					expect(script).toContain('[ "$_maestro_prompt_path" -ef /proc/$$/fd/9 ]');
					expect(script).toContain('trap _maestro_prompt_cleanup EXIT');
					expect(prepared).toMatchObject({
						prompt: undefined,
						customEnvVars: undefined,
						sendPromptViaStdin: false,
						sendPromptViaStdinRaw: false,
						sshRemoteCommand: `'${remoteCommand}' [private prompt file]`,
					});
					expect(prepared.args.join(' ')).not.toContain(artifact.path);
					expect(prepared.sshRemoteCommand).not.toContain(artifact.content);
					expect([...prepared.args, script].join('\n')).not.toContain('replacement');
					expect(script).not.toContain(grok.path);
					expect(deps.beginTurn).toHaveBeenCalledExactlyOnceWith(request.processId);
				}
			);
		});

		it.each(['probe', 'wrapper'])(
			'uses fixed private diagnostics when the %s refuses',
			async (stage) => {
				const gate = Promise.withResolvers<void>();
				const privateFailure = new Error(`private-body ${destination.path}`);
				const probeRemoteMaestroP = vi.fn(() => gate.promise);
				const resolveClaudeSpawnMode = vi.fn().mockReturnValue({ ...apiDecision });
				const windowsSpawnConfig = vi.fn().mockReturnValue({});
				const deps = depsOf({
					sshStore: storeOf([{ ...remote, privateKeyPath: '' }]),
					probeRemoteMaestroP,
					resolveClaudeSpawnMode,
					windowsSpawnConfig,
				});
				const pending = prepareGroupChatSpawn(
					{
						...spawnOf({
							providerId: 'grok',
							agent: grok,
							args: [],
							prompt: 'private-body',
							sshRemoteConfig: { enabled: true, remoteId: remote.id },
							customEnvVars: stage === 'wrapper' ? { _maestro_reserved: 'private-body' } : {},
						}),
						promptFileDestination: destination,
					},
					deps
				).catch((error: unknown) => error);
				expect(probeRemoteMaestroP).toHaveBeenCalledTimes(1);
				if (stage === 'probe') gate.reject(privateFailure);
				else gate.resolve();
				const error = await pending;
				expect(error).toBeInstanceOf(Error);
				expect(error).toHaveProperty('message', 'Remote prompt preparation unavailable.');
				expect(error).not.toHaveProperty('cause');
				expect(error).not.toBe(privateFailure);
				expect(resolveClaudeSpawnMode).toHaveBeenCalledTimes(stage === 'probe' ? 0 : 1);
				expect(windowsSpawnConfig).not.toHaveBeenCalled();
				expect(deps.beginTurn).not.toHaveBeenCalled();
			}
		);

		it.each(['missing store', 'missing remote', 'disabled remote'])(
			'refuses an initially unresolved file target (%s) before probing or starting a turn',
			async (state) => {
				const probeRemoteMaestroP = vi.fn().mockResolvedValue(undefined);
				const deps = depsOf({
					sshStore:
						state === 'missing store'
							? null
							: storeOf(state === 'missing remote' ? [] : [{ ...remote, enabled: false }]),
					probeRemoteMaestroP,
				});
				await expect(
					prepareGroupChatSpawn(
						{
							...spawnOf({
								providerId: 'grok',
								agent: grok,
								args: [],
								prompt: 'private-body',
								sshRemoteConfig: { enabled: true, remoteId: remote.id },
							}),
							promptFileDestination: destination,
						},
						deps
					)
				).rejects.toThrow('could not be resolved');
				expect(probeRemoteMaestroP).not.toHaveBeenCalled();
				expect(deps.beginTurn).not.toHaveBeenCalled();
			}
		);

		it('preserves the original probe error for ordinary Claude turns', async () => {
			const gate = Promise.withResolvers<void>();
			const failure = new Error('legacy probe failure');
			const probeRemoteMaestroP = vi.fn(() => gate.promise);
			const deps = depsOf({ sshStore: storeOf([remote]), probeRemoteMaestroP });
			const pending = prepareGroupChatSpawn(
				spawnOf({ sshRemoteConfig: { enabled: true, remoteId: remote.id } }),
				deps
			);
			const rejected = expect(pending).rejects.toBe(failure);
			expect(probeRemoteMaestroP).toHaveBeenCalledTimes(1);
			gate.reject(failure);
			await rejected;
			expect(deps.beginTurn).not.toHaveBeenCalled();
		});
	});
});
