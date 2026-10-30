/**
 * What a group chat or consult turn decides before its process exists (`prepareGroupChatSpawn`):
 * the Claude token source, the SSH wrap, the Windows shell, and the turn clock, over the real
 * realizers and fake host collaborators.
 */
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
});
