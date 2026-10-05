/**
 * What a group chat or consult turn decides before its process exists (`prepareGroupChatSpawn`):
 * the Claude token source, the SSH wrap, the Windows shell, and the turn clock, over the real
 * realizers and fake host collaborators.
 */
import { describe, expect, it, vi } from 'vitest';

import { resolveClaudeSpawnModeCore } from '../../launch/interactive-mode';
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
	});

	describe('an SSH remote', () => {
		const ssh = { enabled: true, remoteId: 'r1' };

		it('wraps the command so the agent runs on the remote, with its script on stdin', async () => {
			const prepared = await prepareGroupChatSpawn(
				spawnOf({ sshRemoteConfig: ssh }),
				depsOf({ sshStore: storeOf([remote]) })
			);

			expect(prepared.command).toMatch(/ssh$/);
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
