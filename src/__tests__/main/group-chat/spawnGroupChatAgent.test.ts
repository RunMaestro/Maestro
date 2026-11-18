/**
 * @file spawnGroupChatAgent.test.ts
 * @description Verifies the Group Chat spawn helper forwards `maxWaitSeconds`
 * into maestro-p's `--max-wait`. Without this the interactive (TUI) path falls
 * back to maestro-p's 300s idle default and silently kills a still-working
 * moderator/participant whose JSONL output stalls past 300s, even though the
 * router would wait the full supervising timeout. Regression guard for that.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Keep applyClaudeSpawnDecision + buildRemoteInteractiveSpawn REAL (they own the
// actual `--max-wait` arg injection, which is what we want to assert lands in
// the spawn). Only stub resolveClaudeSpawnMode so it deterministically resolves
// to the local interactive (maestro-p) path without needing a real binary or a
// usage snapshot.
const mockResolve = vi.fn();
vi.mock('../../../main/agents/resolveClaudeSpawnMode', async () => {
	const actual = await vi.importActual<
		typeof import('../../../main/agents/resolveClaudeSpawnMode')
	>('../../../main/agents/resolveClaudeSpawnMode');
	return {
		...actual,
		resolveClaudeSpawnMode: (...args: unknown[]) => mockResolve(...args),
	};
});

// SSH: stub the wrapper so we can hand back either a resolved remote or the
// silent local-fallback shape it produces when the remote can't be found.
const mockWrapSpawnWithSsh = vi.fn();
vi.mock('../../../shared/maestro-lib/launch/ssh-spawn-wrapper', async () => {
	const actual = await vi.importActual<
		typeof import('../../../shared/maestro-lib/launch/ssh-spawn-wrapper')
	>('../../../shared/maestro-lib/launch/ssh-spawn-wrapper');
	return {
		...actual,
		wrapSpawnWithSsh: (...args: unknown[]) => mockWrapSpawnWithSsh(...args),
	};
});
vi.mock('../../../main/agents/probeRemoteMaestroP', () => ({
	ensureRemoteMaestroPProbed: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../shared/maestro-lib/launch/ssh-remote-resolver', () => ({
	getSshRemoteConfig: vi.fn(() => ({ config: null, source: 'session' })),
}));

// Pin the non-Windows branch so the system-prompt flag is passed inline on
// every CI host (the Windows temp-file branch is covered by the delivery tests).
vi.mock('../../../shared/platformDetection', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../shared/platformDetection')>();
	return { ...actual, isWindows: () => false };
});

vi.mock('../../../shared/maestro-lib/launch/ssh-path', () => ({
	resolveSshPath: async () => 'ssh',
}));

import * as os from 'os';
import * as path from 'node:path';
import { getAgentDefinition } from '../../../shared/maestro-lib/providers/definitions';
import { getAgentCapabilities } from '../../../shared/maestro-lib/providers/capabilities';
import { buildAgentArgs } from '../../../shared/maestro-lib/launch/agent-args';
import { ensureRemoteMaestroPProbed } from '../../../main/agents/probeRemoteMaestroP';
import { getSshRemoteConfig } from '../../../shared/maestro-lib/launch/ssh-remote-resolver';
import { logger } from '../../../shared/maestro-lib/host';
import type { SpawnGroupChatAgentConfig } from '../../../main/group-chat/spawnGroupChatAgent';
import { spawnGroupChatAgent } from '../../../main/group-chat/spawnGroupChatAgent';
import { embedSystemPromptInPrompt } from '../../../shared/embeddedSystemPrompt';
import type { AgentConfig } from '../../../main/agents/definitions';
import type { IProcessManager } from '../../../main/group-chat/group-chat-moderator';
import type { ProcessConfig } from '../../../main/process-manager/types';

function makeAgent(): AgentConfig {
	return {
		id: 'claude-code',
		command: 'claude',
		interactiveCommand: 'claude',
		interactiveModeArgs: ['--dangerously-skip-permissions'],
	} as unknown as AgentConfig;
}

describe('spawnGroupChatAgent', () => {
	let processManager: IProcessManager;
	let spawnSpy: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.clearAllMocks();
		spawnSpy = vi.fn().mockReturnValue({ pid: 4242, success: true });
		processManager = {
			spawn: spawnSpy,
			write: vi.fn().mockReturnValue(true),
			kill: vi.fn().mockReturnValue(true),
		} as unknown as IProcessManager;
	});

	it('forwards maxWaitSeconds as --max-wait on the interactive maestro-p spawn', async () => {
		// Decision: local interactive, with a resolved maestro-p script path.
		mockResolve.mockReturnValue({
			mode: 'interactive',
			reason: 'auto',
			maestroPBinPath: '/bundled/maestro-p.js',
			claudeRealBinPath: '/usr/local/bin/claude',
		});

		await spawnGroupChatAgent({
			sessionId: 'sess-1',
			agentId: 'claude-code',
			agent: makeAgent(),
			command: '/usr/local/bin/claude',
			args: ['--print', '--', 'hello'],
			cwd: '/tmp/work',
			tokenMode: 'interactive',
			maxWaitSeconds: 600,
			processManager,
			debugLabel: 'participant: Test',
		});

		expect(spawnSpy).toHaveBeenCalledTimes(1);
		const spawned = spawnSpy.mock.calls[0][0] as { command: string; args: string[] };
		// process.execPath drives the maestro-p script under ELECTRON_RUN_AS_NODE.
		expect(spawned.command).toBe(process.execPath);
		// --max-wait must land after the script but before the batch args/prompt.
		const i = spawned.args.indexOf('--max-wait');
		expect(i).toBeGreaterThan(-1);
		expect(spawned.args[i + 1]).toBe('600');
		expect(spawned.args.indexOf('--max-wait')).toBeLessThan(spawned.args.indexOf('--'));
	});

	it('omits --max-wait when maxWaitSeconds is not provided', async () => {
		mockResolve.mockReturnValue({
			mode: 'interactive',
			reason: 'auto',
			maestroPBinPath: '/bundled/maestro-p.js',
			claudeRealBinPath: '/usr/local/bin/claude',
		});

		await spawnGroupChatAgent({
			sessionId: 'sess-2',
			agentId: 'claude-code',
			agent: makeAgent(),
			command: '/usr/local/bin/claude',
			args: ['--print', '--', 'hello'],
			cwd: '/tmp/work',
			tokenMode: 'interactive',
			processManager,
		});

		const spawned = spawnSpy.mock.calls[0][0] as { args: string[] };
		expect(spawned.args).not.toContain('--max-wait');
	});

	// #1872: the router opts in only when the participant runs in its own agent cwd.
	it.each([
		[true, '1'],
		[undefined, undefined],
	])(
		'acceptWorkspaceTrust=%s sets MAESTRO_P_ACCEPT_WORKSPACE_TRUST=%s on the maestro-p spawn',
		async (acceptWorkspaceTrust, expected) => {
			mockResolve.mockReturnValue({
				mode: 'interactive',
				reason: 'auto',
				maestroPBinPath: '/bundled/maestro-p.js',
				claudeRealBinPath: '/usr/local/bin/claude',
			});

			await spawnGroupChatAgent({
				sessionId: 'sess-trust',
				agentId: 'claude-code',
				agent: makeAgent(),
				command: '/usr/local/bin/claude',
				args: ['--print', '--', 'hello'],
				cwd: '/tmp/work',
				tokenMode: 'interactive',
				acceptWorkspaceTrust,
				processManager,
			});

			const spawned = spawnSpy.mock.calls[0][0] as { customEnvVars?: Record<string, string> };
			expect(spawned.customEnvVars?.MAESTRO_P_ACCEPT_WORKSPACE_TRUST).toBe(expected);
		}
	);

	it('does not inject --max-wait on the API path (no maestro-p)', async () => {
		mockResolve.mockReturnValue({ mode: 'api', reason: 'auto', maestroPBinPath: null });

		await spawnGroupChatAgent({
			sessionId: 'sess-3',
			agentId: 'claude-code',
			agent: makeAgent(),
			command: '/usr/local/bin/claude',
			args: ['--print', '--', 'hello'],
			cwd: '/tmp/work',
			tokenMode: 'api',
			maxWaitSeconds: 600,
			processManager,
		});

		const spawned = spawnSpy.mock.calls[0][0] as { command: string; args: string[] };
		expect(spawned.command).toBe('/usr/local/bin/claude');
		expect(spawned.args).not.toContain('--max-wait');
	});

	describe('SSH remote resolution', () => {
		const sshRemoteConfig = { enabled: true, remoteId: 'jennifer-box' };
		const sshStore = {} as never;

		beforeEach(() => {
			mockResolve.mockReturnValue({ mode: 'api', reason: 'auto', maestroPBinPath: null });
		});

		it('fails loudly instead of silently spawning locally when the remote cannot be resolved', async () => {
			// The shape wrapSpawnWithSsh returns on its local-fallback path: the
			// original command, unchanged, with no remote recorded.
			mockWrapSpawnWithSsh.mockResolvedValue({
				command: '/usr/local/bin/claude',
				args: ['--print', '--', 'hello'],
				cwd: '/remote/only/path',
				prompt: 'hello',
				customEnvVars: undefined,
				sshRemoteUsed: null,
			});

			await expect(
				spawnGroupChatAgent({
					sessionId: 'sess-ssh-1',
					agentId: 'claude-code',
					agent: makeAgent(),
					command: '/usr/local/bin/claude',
					args: ['--print', '--', 'hello'],
					cwd: '/remote/only/path',
					prompt: 'hello',
					sshRemoteConfig,
					sshStore,
					processManager,
				})
			).rejects.toThrow(/jennifer-box/);

			// The whole point: nothing ran on this machine.
			expect(spawnSpy).not.toHaveBeenCalled();
		});

		it('spawns normally when the remote resolves', async () => {
			mockWrapSpawnWithSsh.mockResolvedValue({
				command: 'ssh',
				args: ['user@host', 'claude --print'],
				cwd: '/Users/local/home',
				prompt: undefined,
				customEnvVars: undefined,
				sshRemoteUsed: { id: 'jennifer-box', name: 'Jennifer', host: 'host' },
			});

			await spawnGroupChatAgent({
				sessionId: 'sess-ssh-2',
				agentId: 'claude-code',
				agent: makeAgent(),
				command: '/usr/local/bin/claude',
				args: ['--print', '--', 'hello'],
				cwd: '/remote/only/path',
				prompt: 'hello',
				sshRemoteConfig,
				sshStore,
				processManager,
			});

			expect(spawnSpy).toHaveBeenCalledTimes(1);
			const spawned = spawnSpy.mock.calls[0][0] as { command: string };
			expect(spawned.command).toBe('ssh');
		});
	});

	describe('appendSystemPrompt', () => {
		const apiDecision = { mode: 'api', reason: 'auto' };
		const agentWith = (supportsAppendSystemPrompt: boolean) =>
			({
				...makeAgent(),
				capabilities: { supportsAppendSystemPrompt },
			}) as unknown as AgentConfig;

		it('passes the native flag for agents that support it', async () => {
			mockResolve.mockReturnValue(apiDecision);
			await spawnGroupChatAgent({
				sessionId: 's',
				agentId: 'claude-code',
				agent: agentWith(true),
				args: ['--print'],
				cwd: '/tmp/work',
				prompt: 'hello',
				appendSystemPrompt: 'SYS',
				processManager,
			});
			const spawned = spawnSpy.mock.calls[0][0] as { args: string[]; prompt: string };
			expect(spawned.args).toEqual(['--print', '--append-system-prompt', 'SYS']);
			expect(spawned.prompt).toBe('hello');
		});

		it('re-sends the native flag on resume', async () => {
			mockResolve.mockReturnValue(apiDecision);
			await spawnGroupChatAgent({
				sessionId: 's',
				agentId: 'claude-code',
				agent: agentWith(true),
				args: ['--print'],
				cwd: '/tmp/work',
				prompt: 'hello',
				appendSystemPrompt: 'SYS',
				isResume: true,
				processManager,
			});
			const spawned = spawnSpy.mock.calls[0][0] as { args: string[] };
			expect(spawned.args).toContain('--append-system-prompt');
		});

		it('embeds into the prompt for agents without the flag, and not on resume', async () => {
			mockResolve.mockReturnValue(apiDecision);
			const base = {
				sessionId: 's',
				agentId: 'codex',
				agent: agentWith(false),
				args: ['exec'],
				cwd: '/tmp/work',
				prompt: 'hello',
				appendSystemPrompt: 'SYS',
				processManager,
			};

			await spawnGroupChatAgent(base);
			expect((spawnSpy.mock.calls[0][0] as { prompt: string }).prompt).toBe(
				embedSystemPromptInPrompt('SYS', 'hello')
			);

			await spawnGroupChatAgent({ ...base, isResume: true });
			expect((spawnSpy.mock.calls[1][0] as { prompt: string }).prompt).toBe('hello');
		});

		it('hands the embedded prompt to the SSH wrapper', async () => {
			mockResolve.mockReturnValue(apiDecision);
			mockWrapSpawnWithSsh.mockResolvedValue({
				command: 'ssh',
				args: ['host'],
				cwd: '/remote',
				prompt: undefined,
				customEnvVars: undefined,
				sshRemoteUsed: { id: 'r1', name: 'R', host: 'h' },
			});
			await spawnGroupChatAgent({
				sessionId: 's',
				agentId: 'codex',
				agent: agentWith(false),
				args: ['exec'],
				cwd: '/tmp/work',
				prompt: 'hello',
				appendSystemPrompt: 'SYS',
				sshRemoteConfig: { enabled: true, remoteId: 'r1' },
				sshStore: { getSshRemotes: () => [] } as any,
				processManager,
			});
			const wrapConfig = mockWrapSpawnWithSsh.mock.calls[0][0] as { prompt: string };
			expect(wrapConfig.prompt).toBe(embedSystemPromptInPrompt('SYS', 'hello'));
		});
	});

	describe('private prompt-file handoff', () => {
		const roomId = '11111111-2222-4333-8444-555555555555';
		const providerSession = '019aa4fe-0000-7000-8000-000000000002';
		const remote = {
			id: 'r1',
			name: 'Box',
			host: 'box.invalid',
			port: 22,
			username: 'me',
			privateKeyPath: '',
			enabled: true,
			useSshConfig: false,
		};
		const remotePath = path.posix.join(
			'/tmp',
			'maestro-prompt-11111111-2222-4333-8444-555555555555.json'
		);
		let base: SpawnGroupChatAgentConfig;
		beforeEach(async () => {
			for (const level of ['debug', 'info', 'warn', 'error'] as const)
				vi.spyOn(logger, level).mockImplementation(() => {});
			mockResolve.mockReturnValue({ mode: 'api', reason: 'auto' });
			vi.mocked(getSshRemoteConfig).mockReturnValue({ config: remote, source: 'session' });
			const actual = await vi.importActual<
				typeof import('../../../shared/maestro-lib/launch/ssh-spawn-wrapper')
			>('../../../shared/maestro-lib/launch/ssh-spawn-wrapper');
			mockWrapSpawnWithSsh.mockImplementation(actual.wrapSpawnWithSsh);
			spawnSpy.mockReturnValue({ pid: 4343, success: true });
			base = {
				sessionId: `group-chat-${roomId}-participant-Alpha-1700000000000`,
				agentId: 'grok',
				agent: {
					...getAgentDefinition('grok')!,
					available: true,
					capabilities: { ...getAgentCapabilities('grok') },
					// Candidate declaration only; this does not activate the provider.
					promptFile: {
						format: 'acp-json',
						exclusivePromptFlags: ['-p', '--single', '--prompt-file'],
					},
					promptFileArgs: (file) => ['--prompt-file', file],
				},
				command: path.resolve('local tools', 'grok'),
				remoteCommand: path.posix.join('/opt', 'remote tools', 'grok'),
				args: ['--model', 'selected-model'],
				cwd: path.resolve('work'),
				prompt: 'private 雪\n$(keep) `literal`',
				appendSystemPrompt: 'private system',
				customEnvVars: { GROK_HOME: path.resolve('account') },
				// This artifact fixture has no read-only args; the boolean proves no enforcement.
				readOnlyMode: true,
				processManager,
			};
		});
		afterEach(() => {
			vi.mocked(getSshRemoteConfig).mockReturnValue({ config: null, source: 'session' });
			mockWrapSpawnWithSsh.mockReset();
			vi.restoreAllMocks();
		});
		describe.each([false, true])('SSH=%s', (ssh) => {
			it.each([
				['composed', 'private 雪\n$(keep) `literal`', false],
				['empty', '', false],
				['sole system', '', false],
				['resumed', 'private 🧪\n'.repeat(4_000), true],
				['empty resumed', '', true],
			] as const)('hands off %s bytes once through the spawn', async (label, prompt, resumed) => {
				const config = { ...base, prompt, isResume: false };
				if (label === 'empty' || label === 'empty resumed') config.appendSystemPrompt = undefined;
				if (resumed) {
					config.sessionId = 'cross-agent-request';
					config.args = [...base.args, '--resume', providerSession];
				}
				if (ssh) {
					config.cwd = path.posix.join('/remote', 'team work');
					config.customEnvVars = { GROK_HOME: '/remote/account' };
					config.sshRemoteConfig = { enabled: true, remoteId: remote.id };
					config.sshStore = { getSshRemotes: () => [remote] };
					config.promptFileDestination = {
						owner: 'remote',
						path: remotePath,
						sshRemoteId: remote.id,
					};
				}
				expect(await spawnGroupChatAgent(config)).toEqual({ pid: 4343, success: true });
				expect(spawnSpy).toHaveBeenCalledTimes(1);
				const spawned = spawnSpy.mock.calls[0][0] as ProcessConfig;
				const artifact = spawned.promptArtifact!;
				const text =
					resumed || !config.appendSystemPrompt
						? prompt
						: prompt
							? embedSystemPromptInPrompt(config.appendSystemPrompt, prompt)
							: config.appendSystemPrompt;
				expect(artifact.content).toBe(
					JSON.stringify({ type: 'acp', content: [{ type: 'text', text }] })
				);
				expect(artifact).toMatchObject({
					owner: ssh ? 'remote' : 'local',
					mode: 0o600,
					flag: 'wx',
					encoding: 'utf8',
					cleanup: 'turn',
				});
				expect(spawned).toMatchObject({
					toolType: 'grok',
					prompt: undefined,
					sendPromptViaStdin: false,
					sendPromptViaStdinRaw: false,
				});
				expect(spawned.agentSessionId).toBe(resumed ? providerSession : undefined);
				if (ssh) {
					const wrapped = mockWrapSpawnWithSsh.mock.calls[0][0];
					const prepared = await mockWrapSpawnWithSsh.mock.results[0].value;
					expect(mockWrapSpawnWithSsh).toHaveBeenCalledTimes(1);
					expect(wrapped).toMatchObject({
						args: [...config.args, '--prompt-file', artifact.path],
						cwd: config.cwd,
						agentBinaryName: config.remoteCommand,
						prompt: undefined,
						promptArtifact: artifact,
						customEnvVars: config.customEnvVars,
					});
					expect(spawned).toMatchObject({
						command: 'ssh',
						args: prepared.args,
						sshStdinScript: prepared.sshStdinScript,
						sshRemoteId: remote.id,
						cwd: os.homedir(),
					});
					expect(artifact.path).toBe(remotePath);
					expect(spawned.sshStdinScript).toContain(
						Buffer.from(artifact.content).toString('base64')
					);
					expect(spawned.sshStdinScript).toContain(
						"'/opt/remote tools/grok' '--model' 'selected-model'"
					);
					expect(spawned.sshStdinScript).toContain("cd '/remote/team work' || exit 1");
					expect(spawned.sshStdinScript).toContain("export GROK_HOME='/remote/account'");
					expect(spawned.sshStdinScript!.includes(`'--resume' '${providerSession}'`)).toBe(resumed);
					expect(spawned.sshStdinScript).not.toContain(config.command);
					expect(spawned.args.join(' ')).not.toContain(artifact.path);
				} else {
					expect(mockWrapSpawnWithSsh).not.toHaveBeenCalled();
					expect(path.isAbsolute(artifact.path)).toBe(true);
					expect(spawned).toMatchObject({
						command: config.command,
						cwd: config.cwd,
						customEnvVars: config.customEnvVars,
						args: [...config.args, '--prompt-file', artifact.path],
					});
				}
				const diagnostics = JSON.stringify([
					spawned.sshRemoteCommand,
					vi.mocked(logger.debug).mock.calls,
					vi.mocked(logger.info).mock.calls,
					vi.mocked(logger.warn).mock.calls,
				]);
				for (const value of ['private system', 'private 雪', 'private 🧪', artifact.path])
					expect(diagnostics).not.toContain(value);
			});
		});
		it('retains the selected capability snapshot while remote preparation is deferred', async () => {
			const selectedCapabilities = { ...base.agent.capabilities };
			let entered!: () => void;
			let release!: () => void;
			const probing = new Promise<void>((resolve) => {
				entered = resolve;
			});
			const gate = new Promise<undefined>((resolve) => {
				release = () => resolve(undefined);
			});
			vi.mocked(ensureRemoteMaestroPProbed).mockImplementationOnce(() => {
				entered();
				return gate;
			});
			const pending = spawnGroupChatAgent({
				...base,
				sshRemoteConfig: { enabled: true, remoteId: remote.id },
				sshStore: { getSshRemotes: () => [remote] },
			});
			await probing;
			base.agent.capabilities.supportsAppendSystemPrompt =
				!selectedCapabilities.supportsAppendSystemPrompt;
			base.agent.capabilities.supportsReadOnlyMode = !selectedCapabilities.supportsReadOnlyMode;
			release();
			expect(await pending).toEqual({ pid: 4343, success: true });
			expect(mockResolve).toHaveBeenCalledOnce();
			const captured = mockResolve.mock.calls[0][0].agent;
			expect(captured.capabilities).toEqual(selectedCapabilities);
			expect(captured.capabilities).not.toBe(base.agent.capabilities);
			expect(getAgentCapabilities('grok')).toEqual(selectedCapabilities);
			expect(spawnSpy).toHaveBeenCalledOnce();
		});

		it.each(['ordered', 'image-only', 'unadmitted'])(
			'preserves %s image content and the system envelope across caller mutation',
			async (kind) => {
				const image = { type: 'image' as const, mimeType: 'image/png', data: 'AQID' };
				const blocks =
					kind === 'image-only'
						? [image]
						: [
								{ type: 'text' as const, text: 'before 雪' },
								image,
								{ type: 'text' as const, text: '\tafter 🧪 ' },
							];
				const support = {
					mimeTypes: ['image/png'],
					maxCount: 1,
					maxBytesPerImage: 3,
					maxTotalBytes: 3,
				};
				const pending = spawnGroupChatAgent({
					...base,
					prompt: undefined,
					promptBlocks: blocks,
					hasImages: true,
					embeddedImageSupport: kind === 'unadmitted' ? undefined : support,
				});
				image.data = 'BAUG';
				support.mimeTypes.length = 0;
				base.customEnvVars!.GROK_HOME = 'mutated';
				base.agent.promptFile!.format = 'text';
				if (kind === 'unadmitted') {
					await expect(pending).rejects.toThrow('Prompt-file group chat preparation unavailable.');
					expect(spawnSpy).not.toHaveBeenCalled();
					return;
				}
				await pending;
				const spawned = spawnSpy.mock.calls[0][0] as ProcessConfig;
				const originalImage = { ...image, data: 'AQID' };
				expect(JSON.parse(spawned.promptArtifact!.content)).toEqual({
					type: 'acp',
					content:
						kind === 'image-only'
							? [{ type: 'text', text: 'private system' }, originalImage]
							: [
									{ type: 'text', text: embedSystemPromptInPrompt('private system', 'before 雪') },
									originalImage,
									{ type: 'text', text: '\tafter 🧪 ' },
								],
				});
				expect(spawned.customEnvVars!.GROK_HOME).toBe(path.resolve('account'));
				expect(spawnSpy).toHaveBeenCalledTimes(1);
			}
		);
		it.each([
			[
				'duplicate sources',
				{ promptBlocks: [{ type: 'text', text: 'private block' }] },
				'Supply either prompt text or ordered content blocks, not both.',
			],
			[
				'resume contradiction',
				{ args: ['--resume', providerSession], agentSessionId: 'other' },
				'Prompt-file resume identity does not match its launch arguments.',
			],
			[
				'missing resume ID',
				{ args: ['--resume'] },
				'Prompt-file resume requires an explicit provider session identity.',
			],
			[
				'conflicting argv',
				{ args: ['--single=private-argv'] },
				'Prompt-file group chat preparation unavailable.',
			],
			[
				'wrong owner',
				{ promptFileDestination: { owner: 'remote', path: remotePath, sshRemoteId: 'r1' } },
				'Prompt-file group chat preparation unavailable.',
			],
		] satisfies [string, Partial<SpawnGroupChatAgentConfig>, string][])(
			'refuses %s without a spawn, retry or private diagnostics',
			async (_label, overrides, message) => {
				await expect(spawnGroupChatAgent({ ...base, ...overrides })).rejects.toThrow(
					new Error(message)
				);
				expect(spawnSpy).not.toHaveBeenCalled();
				expect(mockWrapSpawnWithSsh).not.toHaveBeenCalled();
				const logs = JSON.stringify([
					vi.mocked(logger.debug).mock.calls,
					vi.mocked(logger.warn).mock.calls,
					vi.mocked(logger.error).mock.calls,
				]);
				for (const value of ['private', remotePath, 'other']) expect(logs).not.toContain(value);
			}
		);

		it('sanitizes an SSH preparation failure and never falls back to a local process', async () => {
			mockWrapSpawnWithSsh.mockRejectedValueOnce(new Error(`private content at ${remotePath}`));
			await expect(
				spawnGroupChatAgent({
					...base,
					sshRemoteConfig: { enabled: true, remoteId: remote.id },
					sshStore: { getSshRemotes: () => [remote] },
				})
			).rejects.toThrow(/^Prompt-file group chat preparation unavailable\.$/);
			expect(spawnSpy).not.toHaveBeenCalled();
			expect(mockWrapSpawnWithSsh).toHaveBeenCalledTimes(1);
		});
	});

	// The real Grok definition in each room role.
	describe('Grok room roles', () => {
		const ROOM = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
		const grok = (): AgentConfig => ({
			...getAgentDefinition('grok')!,
			available: true,
			capabilities: { ...getAgentCapabilities('grok') },
		});
		const readOnly = ['--permission-mode', 'plan', '--deny', 'Bash(*)'];
		beforeEach(() => {
			mockResolve.mockReturnValue({ mode: 'api', reason: 'auto' });
			spawnSpy.mockReturnValue({ pid: 5151, success: true });
		});

		it.each([
			['moderator', `group-chat-${ROOM}-moderator-1700000000001`, true, undefined],
			['synthesis', `group-chat-${ROOM}-moderator-1700000000002`, true, 'grok-moderator-sess'],
			['participant', `group-chat-${ROOM}-participant-Alpha-1700000000003`, false, undefined],
			[
				'continuation',
				`group-chat-${ROOM}-participant-Alpha-1700000000004`,
				false,
				'grok-alpha-sess',
			],
		] as const)(
			'%s turn keeps its own identity and one prompt delivery',
			async (_role, sessionId, readOnlyMode, resumeId) => {
				const agent = grok();
				const args = buildAgentArgs(agent, {
					baseArgs: agent.args,
					prompt: 'route @Alpha',
					readOnlyMode,
					...(resumeId ? { agentSessionId: resumeId } : {}),
				});
				const result = await spawnGroupChatAgent({
					sessionId,
					agentId: 'grok',
					agent,
					args,
					cwd: os.tmpdir(),
					prompt: 'route @Alpha',
					appendSystemPrompt: 'room rules',
					customEnvVars: { GROK_HOME: path.resolve('grok-account') },
					agentConfigValues: { contextWindow: 131072 },
					readOnlyMode,
					processManager,
				});
				expect(result).toEqual({ pid: 5151, success: true });
				expect(spawnSpy).toHaveBeenCalledOnce();
				const spawned = spawnSpy.mock.calls[0][0] as ProcessConfig;
				expect(spawned).toMatchObject({
					sessionId,
					toolType: 'grok',
					contextWindow: 131072,
					prompt: undefined,
				});
				// Usage and the resumed provider session are read against this identity.
				expect(spawned.agentSessionId).toBe(resumeId);
				expect(spawned.args.includes('--resume')).toBe(!!resumeId);
				expect(spawned.customEnvVars!.GROK_HOME).toBe(path.resolve('grok-account'));
				const at = spawned.args.indexOf('--permission-mode');
				expect(at >= 0 ? spawned.args.slice(at, at + 4) : []).toEqual(readOnlyMode ? readOnly : []);
				if (readOnlyMode) expect(spawned.args).not.toContain('--always-approve');
				// The system prompt is embedded once, and not again on a resumed turn.
				const blocks = JSON.parse(spawned.promptArtifact!.content).content;
				expect(blocks).toEqual([
					{
						type: 'text',
						text: resumeId
							? 'route @Alpha'
							: embedSystemPromptInPrompt('room rules', 'route @Alpha'),
					},
				]);
			}
		);
	});
});
