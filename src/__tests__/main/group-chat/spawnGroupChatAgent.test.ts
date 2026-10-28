/**
 * @file spawnGroupChatAgent.test.ts
 * @description Verifies the Group Chat spawn helper forwards `maxWaitSeconds`
 * into maestro-p's `--max-wait`. Without this the interactive (TUI) path falls
 * back to maestro-p's 300s idle default and silently kills a still-working
 * moderator/participant whose JSONL output stalls past 300s, even though the
 * router would wait the full supervising timeout. Regression guard for that.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

// The agent's Local Models gateway: stubbed so these tests say what the helper
// does with the answer, not how the answer is reached (service.test.ts).
const mockApplyGateway = vi.fn();
vi.mock('../../../main/local-models/proxy/service', () => ({
	applyAgentGatewayToSpawn: (...args: unknown[]) => mockApplyGateway(...args),
}));

// The agent's Run on target: stubbed the same way (run-on.test.ts covers how the
// answer is reached). By default the agent has none, so the spawn is unchanged.
const mockApplyRunOn = vi.fn();
const mockStoredRunOn = vi.fn();
const mockLogRunOn = vi.fn();
vi.mock('../../../main/local-models/run-on', () => ({
	applyAgentRunOnToSpawn: (...args: unknown[]) => mockApplyRunOn(...args),
	storedAgentRunOn: (...args: unknown[]) => mockStoredRunOn(...args),
	logRunOnLaunch: (...args: unknown[]) => mockLogRunOn(...args),
}));

// Pin the non-Windows branch so the system-prompt flag is passed inline on
// every CI host (the Windows temp-file branch is covered by the delivery tests).
vi.mock('../../../shared/platformDetection', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../shared/platformDetection')>();
	return { ...actual, isWindows: () => false };
});

import { spawnGroupChatAgent } from '../../../main/group-chat/spawnGroupChatAgent';
import { embedSystemPromptInPrompt } from '../../../shared/embeddedSystemPrompt';
import type { AgentConfig } from '../../../main/agents/definitions';
import type { IProcessManager } from '../../../main/group-chat/group-chat-moderator';

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
		mockStoredRunOn.mockReturnValue(undefined);
		mockApplyRunOn.mockImplementation(
			async (input: { args: string[]; customEnvVars?: Record<string, string> }) => ({
				ok: true,
				args: input.args,
				customEnvVars: input.customEnvVars,
				runOn: null,
			})
		);
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
	describe("the agent's Local Models gateway", () => {
		beforeEach(() => {
			mockResolve.mockReturnValue({ mode: 'api', reason: 'auto' });
		});

		it("is not looked up for a process that is nobody's agent", async () => {
			await spawnGroupChatAgent({
				sessionId: 'sess-mod',
				agentId: 'claude-code',
				agent: makeAgent(),
				args: ['--print'],
				cwd: '/tmp/work',
				processManager,
				debugLabel: 'moderator',
			});

			expect(mockApplyGateway).not.toHaveBeenCalled();
			expect(spawnSpy).toHaveBeenCalledTimes(1);
		});

		it('spawns with the arguments and env the gateway gives back', async () => {
			mockApplyGateway.mockResolvedValue({
				ok: true,
				args: ['-c', 'openai_base_url="https://gw.example.com"', 'exec'],
				customEnvVars: { FOO: '1', OPENAI_BASE_URL: 'https://gw.example.com' },
				gateway: { envVar: 'OPENAI_BASE_URL', url: 'https://gw.example.com' },
			});

			await spawnGroupChatAgent({
				sessionId: 'sess-p',
				agentId: 'codex',
				agent: { id: 'codex', command: 'codex' } as unknown as AgentConfig,
				args: ['exec'],
				cwd: '/tmp/work',
				customEnvVars: { FOO: '1' },
				maestroAgentId: 'agent-7',
				processManager,
			});

			expect(mockApplyGateway).toHaveBeenCalledWith({
				agentId: 'agent-7',
				toolType: 'codex',
				args: ['exec'],
				customEnvVars: { FOO: '1' },
				remote: null,
			});
			const spawned = spawnSpy.mock.calls[0][0] as {
				args: string[];
				customEnvVars: Record<string, string>;
			};
			expect(spawned.args).toEqual(['-c', 'openai_base_url="https://gw.example.com"', 'exec']);
			expect(spawned.customEnvVars).toEqual({
				FOO: '1',
				OPENAI_BASE_URL: 'https://gw.example.com',
			});
		});

		it('refuses the turn rather than connect direct when the gateway cannot be used', async () => {
			mockApplyGateway.mockResolvedValue({ ok: false, error: 'The turn was not sent.' });

			await expect(
				spawnGroupChatAgent({
					sessionId: 'sess-p',
					agentId: 'claude-code',
					agent: makeAgent(),
					args: ['--print'],
					cwd: '/tmp/work',
					maestroAgentId: 'agent-7',
					processManager,
				})
			).rejects.toThrow('The turn was not sent.');
			expect(spawnSpy).not.toHaveBeenCalled();
		});
	});

	describe("the agent's Run on target", () => {
		const QWEN = { type: 'source', endpointId: 'ep-ollama', model: 'qwen3:latest' };
		const applied = {
			model: 'qwen3:latest',
			contextTokens: 40_960,
			args: [],
			envVarNames: ['ANTHROPIC_BASE_URL'],
			userOverrides: [],
			clearedEnvVars: ['ANTHROPIC_API_KEY'],
		};

		beforeEach(() => {
			mockResolve.mockReturnValue({ mode: 'api', reason: 'auto' });
		});

		it("is not looked up for a process that is nobody's agent", async () => {
			await spawnGroupChatAgent({
				sessionId: 'sess-mod',
				agentId: 'claude-code',
				agent: makeAgent(),
				args: ['--print'],
				cwd: '/tmp/work',
				processManager,
				debugLabel: 'moderator',
			});

			expect(mockApplyRunOn).not.toHaveBeenCalled();
			expect(mockStoredRunOn).not.toHaveBeenCalled();
		});

		it('spawns with the arguments and env the target gives back, and skips the gateway', async () => {
			const agent = makeAgent();
			mockStoredRunOn.mockReturnValue(QWEN);
			mockApplyRunOn.mockResolvedValue({
				ok: true,
				args: ['--print', '--model', 'qwen3:latest'],
				customEnvVars: { FOO: '1', ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434' },
				runOn: applied,
			});

			await spawnGroupChatAgent({
				sessionId: 'sess-p',
				agentId: 'claude-code',
				agent,
				args: ['--print', '--model', 'opus'],
				cwd: '/tmp/work',
				customEnvVars: { FOO: '1' },
				maestroAgentId: 'agent-7',
				processManager,
			});

			expect(mockApplyRunOn).toHaveBeenCalledWith({
				agentId: 'agent-7',
				toolType: 'claude-code',
				agent,
				args: ['--print', '--model', 'opus'],
				customEnvVars: { FOO: '1' },
				remote: null,
			});
			// A Run on target takes the gateway's place: it is not even asked.
			expect(mockApplyGateway).not.toHaveBeenCalled();
			const spawned = spawnSpy.mock.calls[0][0] as {
				args: string[];
				customEnvVars: Record<string, string>;
			};
			expect(spawned.args).toEqual(['--print', '--model', 'qwen3:latest']);
			expect(spawned.customEnvVars).toEqual({
				FOO: '1',
				ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434',
			});
			expect(mockLogRunOn).toHaveBeenCalledWith(
				'[GroupChat:Spawn]',
				{ sessionId: 'sess-p', toolType: 'claude-code' },
				applied
			);
		});

		it('falls through to the gateway for an agent with no target', async () => {
			mockApplyGateway.mockResolvedValue({
				ok: true,
				args: ['--print'],
				customEnvVars: undefined,
				gateway: null,
			});

			await spawnGroupChatAgent({
				sessionId: 'sess-p',
				agentId: 'claude-code',
				agent: makeAgent(),
				args: ['--print'],
				cwd: '/tmp/work',
				maestroAgentId: 'agent-7',
				processManager,
			});

			expect(mockApplyRunOn).toHaveBeenCalledTimes(1);
			expect(mockApplyGateway).toHaveBeenCalledTimes(1);
			expect(mockLogRunOn).not.toHaveBeenCalled();
		});

		it('keeps the turn on claude --print whatever token source the agent selected', async () => {
			mockStoredRunOn.mockReturnValue(QWEN);
			mockApplyRunOn.mockResolvedValue({
				ok: true,
				args: ['--print', '--model', 'qwen3:latest'],
				customEnvVars: {},
				runOn: applied,
			});

			await spawnGroupChatAgent({
				sessionId: 'sess-p',
				agentId: 'claude-code',
				agent: makeAgent(),
				args: ['--print'],
				cwd: '/tmp/work',
				maestroAgentId: 'agent-7',
				tokenMode: 'interactive',
				processManager,
			});

			expect(mockStoredRunOn).toHaveBeenCalledWith('agent-7');
			expect(mockResolve).toHaveBeenCalledWith(expect.objectContaining({ tokenMode: 'api' }));
		});

		it('leaves the token source alone for an agent with no target', async () => {
			mockApplyGateway.mockResolvedValue({
				ok: true,
				args: ['--print'],
				customEnvVars: undefined,
				gateway: null,
			});

			await spawnGroupChatAgent({
				sessionId: 'sess-p',
				agentId: 'claude-code',
				agent: makeAgent(),
				args: ['--print'],
				cwd: '/tmp/work',
				maestroAgentId: 'agent-7',
				tokenMode: 'interactive',
				processManager,
			});

			expect(mockResolve).toHaveBeenCalledWith(
				expect.objectContaining({ tokenMode: 'interactive' })
			);
		});

		it("refuses the turn rather than run it on the provider's model when the target cannot run", async () => {
			mockApplyRunOn.mockResolvedValue({
				ok: false,
				error: 'This agent is set to run on qwen3:latest on Ollama, but the source did not answer.',
			});

			await expect(
				spawnGroupChatAgent({
					sessionId: 'sess-p',
					agentId: 'claude-code',
					agent: makeAgent(),
					args: ['--print'],
					cwd: '/tmp/work',
					maestroAgentId: 'agent-7',
					processManager,
				})
			).rejects.toThrow('set to run on qwen3:latest on Ollama');
			expect(mockApplyGateway).not.toHaveBeenCalled();
			expect(spawnSpy).not.toHaveBeenCalled();
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
});
