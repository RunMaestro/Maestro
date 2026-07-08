/**
 * Tests for the agents IPC handlers
 *
 * These tests verify the agent detection and configuration management API.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ipcMain } from 'electron';
import {
	registerAgentsHandlers,
	AgentsHandlerDependencies,
} from '../../../../main/ipc/handlers/agents';
import * as agentCapabilities from '../../../../main/agents';

// Mock electron's ipcMain
vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn(),
		removeHandler: vi.fn(),
	},
}));

// Mock agents module (capabilities exports)
vi.mock('../../../../main/agents', async () => {
	const opencodeConfig = await import('../../../../main/agents/opencode-config');
	return {
		getAgentCapabilities: vi.fn(),
		AGENT_DEFINITIONS: [
			{ id: 'claude-code', name: 'Claude Code', binaryName: 'claude', configOptions: [] },
			{ id: 'codex', name: 'Codex', binaryName: 'codex', configOptions: [] },
			{ id: 'opencode', name: 'OpenCode', binaryName: 'opencode', configOptions: [] },
			{ id: 'terminal', name: 'Terminal', binaryName: 'bash', configOptions: [] },
		],
		DEFAULT_CAPABILITIES: {
			supportsResume: false,
			supportsReadOnlyMode: false,
			supportsJsonOutput: false,
			supportsSessionId: false,
			supportsImageInput: false,
			supportsImageInputOnResume: false,
			supportsSlashCommands: false,
			supportsSessionStorage: false,
			supportsCostTracking: false,
			supportsUsageStats: false,
			supportsBatchMode: false,
			requiresPromptToStart: false,
			supportsStreaming: false,
			supportsResultMessages: false,
			supportsModelSelection: false,
			supportsStreamJsonInput: false,
		},
		parseOpenCodeConfig: opencodeConfig.parseOpenCodeConfig,
		extractModelsFromConfig: opencodeConfig.extractModelsFromConfig,
		getOpenCodeConfigPaths: opencodeConfig.getOpenCodeConfigPaths,
		getOpenCodeCommandDirs: opencodeConfig.getOpenCodeCommandDirs,
	};
});

// Mock the logger
vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

// Mock execFileNoThrow
vi.mock('../../../../main/utils/execFile', () => ({
	execFileNoThrow: vi.fn(),
}));

// Mock fs
vi.mock('fs', () => ({
	existsSync: vi.fn(),
	readdirSync: vi.fn(),
	accessSync: vi.fn(),
	constants: { R_OK: 4 },
	promises: {
		readdir: vi.fn(),
		readFile: vi.fn(),
	},
}));

// Mock ssh-command-builder for remote model discovery tests
vi.mock('../../../../main/utils/ssh-command-builder', () => ({
	buildSshCommand: vi.fn().mockResolvedValue({ command: 'ssh', args: ['mock'] }),
	buildSshCommandWithStdin: vi.fn(),
}));

// Mock stripAnsi (pass through by default)
vi.mock('../../../../main/utils/stripAnsi', () => ({
	stripAnsi: vi.fn((str: string) => str),
}));

import { execFileNoThrow } from '../../../../main/utils/execFile';
import { buildSshCommand } from '../../../../main/utils/ssh-command-builder';
import * as fs from 'fs';

describe('agents IPC handlers', () => {
	let handlers: Map<string, Function>;
	let mockAgentDetector: {
		detectAgents: ReturnType<typeof vi.fn>;
		getAgent: ReturnType<typeof vi.fn>;
		clearCache: ReturnType<typeof vi.fn>;
		setCustomPaths: ReturnType<typeof vi.fn>;
		discoverModels: ReturnType<typeof vi.fn>;
	};
	let mockAgentConfigsStore: {
		get: ReturnType<typeof vi.fn>;
		set: ReturnType<typeof vi.fn>;
	};
	let deps: AgentsHandlerDependencies;

	beforeEach(() => {
		// Clear mocks
		vi.clearAllMocks();
		vi.mocked(fs.readdirSync).mockReturnValue([] as any);
		vi.mocked(fs.accessSync).mockImplementation(() => undefined);

		// Create mock agent detector
		mockAgentDetector = {
			detectAgents: vi.fn(),
			getAgent: vi.fn(),
			clearCache: vi.fn(),
			setCustomPaths: vi.fn(),
			discoverModels: vi.fn(),
		};

		// Create mock config store
		mockAgentConfigsStore = {
			get: vi.fn().mockReturnValue({}),
			set: vi.fn(),
		};

		// Create dependencies
		deps = {
			getAgentDetector: () => mockAgentDetector as any,
			agentConfigsStore: mockAgentConfigsStore as any,
		};

		// Capture all registered handlers
		handlers = new Map();
		vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
			handlers.set(channel, handler);
		});

		// Register handlers
		registerAgentsHandlers(deps);
	});

	afterEach(() => {
		handlers.clear();
	});

	describe('registration', () => {
		it('should register all agents handlers', () => {
			const expectedChannels = [
				'agents:detect',
				'agents:refresh',
				'agents:get',
				'agents:getCapabilities',
				'agents:getConfig',
				'agents:setConfig',
				'agents:getConfigValue',
				'agents:setConfigValue',
				'agents:setCustomPath',
				'agents:getCustomPath',
				'agents:getAllCustomPaths',
				'agents:setCustomArgs',
				'agents:getCustomArgs',
				'agents:getAllCustomArgs',
				'agents:setCustomEnvVars',
				'agents:getCustomEnvVars',
				'agents:getAllCustomEnvVars',
				'agents:getModels',
				'agents:getConfigOptions',
				'agents:discoverSlashCommands',
				// Capability snapshot bridge (status pill + reprobe + live events)
				'agents:getSnapshot',
				'agents:getAllSnapshots',
				'agents:reprobe',
				'agents:getMaestroPDetectedPath',
				'agents:getRemoteMaestroPAvailable',
				'agents:getClaudeUsageSnapshots',
				'agents:getClaudeUsageAccountKeys',
				'claude:usage:refresh-all',
				'agents:getCodexUsageSnapshots',
				'agents:getCodexUsageAccountKeys',
				'codex:usage:refresh-all',
			];

			for (const channel of expectedChannels) {
				expect(handlers.has(channel)).toBe(true);
			}
			expect(handlers.size).toBe(expectedChannels.length);
		});
	});

	describe('agents:detect', () => {
		it('should return array of detected agents', async () => {
			const mockAgents = [
				{
					id: 'claude-code',
					name: 'Claude Code',
					binaryName: 'claude',
					command: 'claude',
					args: ['--print'],
					available: true,
					path: '/usr/local/bin/claude',
				},
				{
					id: 'opencode',
					name: 'OpenCode',
					binaryName: 'opencode',
					command: 'opencode',
					args: [],
					available: true,
					path: '/usr/local/bin/opencode',
				},
			];

			mockAgentDetector.detectAgents.mockResolvedValue(mockAgents);

			const handler = handlers.get('agents:detect');
			const result = await handler!({} as any);

			expect(mockAgentDetector.detectAgents).toHaveBeenCalled();
			expect(result).toHaveLength(2);
			expect(result[0].id).toBe('claude-code');
			expect(result[1].id).toBe('opencode');
		});

		it('should return empty array when no agents found', async () => {
			mockAgentDetector.detectAgents.mockResolvedValue([]);

			const handler = handlers.get('agents:detect');
			const result = await handler!({} as any);

			expect(result).toEqual([]);
		});

		it('should include agent id and path for each detected agent', async () => {
			const mockAgents = [
				{
					id: 'claude-code',
					name: 'Claude Code',
					binaryName: 'claude',
					command: 'claude',
					args: [],
					available: true,
					path: '/opt/homebrew/bin/claude',
				},
			];

			mockAgentDetector.detectAgents.mockResolvedValue(mockAgents);

			const handler = handlers.get('agents:detect');
			const result = await handler!({} as any);

			expect(result[0].id).toBe('claude-code');
			expect(result[0].path).toBe('/opt/homebrew/bin/claude');
		});

		it('should strip function properties from agent config before returning', async () => {
			const mockAgents = [
				{
					id: 'claude-code',
					name: 'Claude Code',
					binaryName: 'claude',
					command: 'claude',
					args: [],
					available: true,
					path: '/usr/local/bin/claude',
					// Function properties that should be stripped
					resumeArgs: (sessionId: string) => ['--resume', sessionId],
					modelArgs: (modelId: string) => ['--model', modelId],
					workingDirArgs: (dir: string) => ['-C', dir],
					imageArgs: (path: string) => ['-i', path],
					promptArgs: (prompt: string) => ['-p', prompt],
					configOptions: [
						{
							key: 'test',
							type: 'text',
							label: 'Test',
							description: 'Test option',
							default: '',
							argBuilder: (val: string) => ['--test', val],
						},
					],
				},
			];

			mockAgentDetector.detectAgents.mockResolvedValue(mockAgents);

			const handler = handlers.get('agents:detect');
			const result = await handler!({} as any);

			// Verify function properties are stripped
			expect(result[0].resumeArgs).toBeUndefined();
			expect(result[0].modelArgs).toBeUndefined();
			expect(result[0].workingDirArgs).toBeUndefined();
			expect(result[0].imageArgs).toBeUndefined();
			expect(result[0].promptArgs).toBeUndefined();
			// configOptions should still exist but without argBuilder
			expect(result[0].configOptions[0].argBuilder).toBeUndefined();
			expect(result[0].configOptions[0].key).toBe('test');
		});

		it('strips function properties from agents without an id', async () => {
			mockAgentDetector.detectAgents.mockResolvedValue([
				{
					name: 'Nameless Agent',
					resumeArgs: () => ['--resume'],
				},
			]);

			const handler = handlers.get('agents:detect');
			const result = await handler!({} as any);

			expect(result).toEqual([{ name: 'Nameless Agent' }]);
		});

		it('returns unavailable remote agent definitions when SSH detection has no settings store', async () => {
			const handler = handlers.get('agents:detect');
			const result = await handler!({} as any, 'remote-without-settings-store');

			expect(result).toHaveLength(agentCapabilities.AGENT_DEFINITIONS.length);
			expect(result[0]).toMatchObject({
				available: false,
				error: 'SSH remote configuration not found: remote-without-settings-store',
			});
		});

		describe('SSH remote detection (issue #878)', () => {
			let mockSettingsStore: {
				get: ReturnType<typeof vi.fn>;
				set: ReturnType<typeof vi.fn>;
			};

			beforeEach(() => {
				mockSettingsStore = {
					get: vi.fn().mockReturnValue([
						{
							id: 'remote-1',
							host: 'dev.example.com',
							username: 'dev',
							port: 22,
							enabled: true,
						},
					]),
					set: vi.fn(),
				};

				handlers.clear();
				registerAgentsHandlers({
					...deps,
					settingsStore: mockSettingsStore as any,
				});

				vi.mocked(buildSshCommand).mockResolvedValue({
					command: 'ssh',
					args: ['-o', 'BatchMode=yes', 'dev@dev.example.com', 'mock'],
				});
			});

			it("uses POSIX 'command -v' (not 'which') to probe each agent binary", async () => {
				vi.mocked(execFileNoThrow).mockResolvedValue({
					exitCode: 0,
					stdout: '/home/dev/.local/bin/claude\n',
					stderr: '',
				});

				const handler = handlers.get('agents:detect');
				await handler!({} as any, 'remote-1');

				// The remote detection piggybacks one extra maestro-p launch test
				// (`maestro-p --version`) on top of the per-agent binary probes, so the
				// total is AGENT_DEFINITIONS.length + 1.
				const calls = vi.mocked(buildSshCommand).mock.calls;
				expect(calls.length).toBe(agentCapabilities.AGENT_DEFINITIONS.length + 1);

				// The maestro-p availability check is a LAUNCH test, not a path check:
				// it runs `maestro-p --version` (which loads node + node-pty) rather
				// than `command -v maestro-p`, so a host with no node fails it.
				const maestroPProbe = calls.find(([, o]) => o.command === 'maestro-p');
				expect(maestroPProbe).toBeDefined();
				expect(maestroPProbe![1].args).toEqual(['--version']);

				// Every other (per-agent) probe should invoke 'command -v <binary>',
				// never 'which'. Asserting one such call per AGENT_DEFINITION catches
				// regressions that silently skip agents instead of just dropping to zero.
				const agentProbes = calls.filter(([, o]) => o.command !== 'maestro-p');
				expect(agentProbes.length).toBe(agentCapabilities.AGENT_DEFINITIONS.length);
				for (const [, options] of agentProbes) {
					expect(options.command).toBe('command');
					expect(options.args[0]).toBe('-v');
				}
			});

			it('marks the agent available and records the resolved remote path', async () => {
				vi.mocked(execFileNoThrow).mockResolvedValue({
					exitCode: 0,
					stdout: '/home/dev/.claude/local/claude\n',
					stderr: '',
				});

				const handler = handlers.get('agents:detect');
				const result = await handler!({} as any, 'remote-1');

				const claude = result.find((a: any) => a.id === 'claude-code');
				expect(claude.available).toBe(true);
				expect(claude.path).toBe('/home/dev/.claude/local/claude');
			});

			it('marks the agent unavailable when command -v exits non-zero', async () => {
				vi.mocked(execFileNoThrow).mockResolvedValue({
					exitCode: 1,
					stdout: '',
					stderr: '',
				});

				const handler = handlers.get('agents:detect');
				const result = await handler!({} as any, 'remote-1');

				const claude = result.find((a: any) => a.id === 'claude-code');
				expect(claude.available).toBe(false);
				expect(claude.path).toBeUndefined();
			});

			it('returns unavailable remote agent definitions when the selected remote is missing', async () => {
				mockSettingsStore.get.mockReturnValue([]);

				const handler = handlers.get('agents:detect');
				const result = await handler!({} as any, 'missing-remote');

				expect(result).toHaveLength(agentCapabilities.AGENT_DEFINITIONS.length);
				expect(result[0]).toMatchObject({
					available: false,
					error: 'SSH remote configuration not found: missing-remote',
				});
				expect(buildSshCommand).not.toHaveBeenCalled();
			});

			it('preserves an auth-required snapshot when remote detection finds the binary', async () => {
				const { capabilitySnapshots } = await import('../../../../main/agents/capability-snapshot');
				capabilitySnapshots.__resetForTests();
				capabilitySnapshots.markAuthRequired('claude-code', 'login required', 'remote-1');
				vi.mocked(execFileNoThrow).mockResolvedValue({
					exitCode: 0,
					stdout: '/home/dev/.claude/local/claude\n',
					stderr: '',
				});

				const handler = handlers.get('agents:detect');
				const result = await handler!({} as any, 'remote-1');

				const claude = result.find((a: any) => a.id === 'claude-code');
				expect(claude.available).toBe(true);
				expect(capabilitySnapshots.get('claude-code', 'remote-1')).toMatchObject({
					status: 'auth_required',
					lastError: 'login required',
				});

				capabilitySnapshots.__resetForTests();
			});

			it('marks remote agents failed on in-band SSH connection stderr', async () => {
				vi.mocked(execFileNoThrow).mockResolvedValue({
					exitCode: 255,
					stdout: '',
					stderr: 'Connection refused\nextra detail',
				});

				const handler = handlers.get('agents:detect');
				const result = await handler!({} as any, 'remote-1');

				const claude = result.find((a: any) => a.id === 'claude-code');
				expect(claude.available).toBe(false);
				expect(claude.error).toBe('Connection refused');
			});

			it('classifies all supported SSH connection stderr variants during detection', async () => {
				const stderrByAgent = [
					'Connection timed out\nsecondary detail',
					'No route to host\nsecondary detail',
					'Could not resolve hostname dev.example.com\nsecondary detail',
					'Permission denied (publickey).\nsecondary detail',
				];
				vi.mocked(execFileNoThrow).mockImplementation(async () => {
					const stderr = stderrByAgent.shift() ?? '';
					return { exitCode: stderr ? 255 : 0, stdout: '', stderr };
				});

				const handler = handlers.get('agents:detect');
				const result = await handler!({} as any, 'remote-1');

				expect(result.map((agent: any) => agent.error)).toEqual([
					'Connection timed out',
					'No route to host',
					'Could not resolve hostname dev.example.com',
					'Permission denied (publickey).',
				]);
			});

			it('leaves non-connection SSH failures as unavailable without a connection error', async () => {
				vi.mocked(execFileNoThrow).mockResolvedValue({
					exitCode: 2,
					stdout: '',
					stderr: 'remote shell returned 2',
				});

				const handler = handlers.get('agents:detect');
				const result = await handler!({} as any, 'remote-1');

				expect(result[0]).toMatchObject({ available: false, error: undefined });
			});

			it('does not rewrite an unchanged ok snapshot during remote detection', async () => {
				const { capabilitySnapshots } = await import('../../../../main/agents/capability-snapshot');
				capabilitySnapshots.__resetForTests();
				capabilitySnapshots.markOk(
					'claude-code',
					{ path: '/home/dev/.claude/local/claude' },
					'remote-1'
				);
				vi.mocked(execFileNoThrow).mockResolvedValue({
					exitCode: 0,
					stdout: '/home/dev/.claude/local/claude\n',
					stderr: '',
				});

				const handler = handlers.get('agents:detect');
				await handler!({} as any, 'remote-1');

				expect(capabilitySnapshots.get('claude-code', 'remote-1')).toMatchObject({
					status: 'ok',
					path: '/home/dev/.claude/local/claude',
				});
				capabilitySnapshots.__resetForTests();
			});

			it('returns failed remote agents when the SSH command builder throws', async () => {
				vi.mocked(buildSshCommand).mockRejectedValue(new Error('bad ssh config'));

				const handler = handlers.get('agents:detect');
				const result = await handler!({} as any, 'remote-1');

				const claude = result.find((a: any) => a.id === 'claude-code');
				expect(claude.available).toBe(false);
				expect(claude.error).toBe('Failed to connect: bad ssh config');
			});

			it('stringifies non-Error SSH command builder failures during detection', async () => {
				vi.mocked(buildSshCommand).mockRejectedValue('bad ssh string');

				const handler = handlers.get('agents:detect');
				const result = await handler!({} as any, 'remote-1');

				expect(result[0]).toMatchObject({
					available: false,
					error: 'Failed to connect: bad ssh string',
				});
			});

			it('marks a remote agent failed when SSH detection times out', async () => {
				vi.useFakeTimers();
				try {
					vi.mocked(execFileNoThrow)
						.mockImplementationOnce(() => new Promise(() => {}) as any)
						.mockResolvedValue({
							exitCode: 1,
							stdout: '',
							stderr: '',
						});

					const handler = handlers.get('agents:detect');
					const pending = handler!({} as any, 'remote-1');

					await vi.advanceTimersByTimeAsync(10000);
					const result = await pending;

					const claude = result.find((a: any) => a.id === 'claude-code');
					expect(claude.available).toBe(false);
					expect(claude.error).toBe('Failed to connect: SSH connection timed out after 10s');
				} finally {
					vi.useRealTimers();
				}
			});
		});
	});

	describe('agents:get', () => {
		it('should return specific agent config by id', async () => {
			const mockAgent = {
				id: 'claude-code',
				name: 'Claude Code',
				binaryName: 'claude',
				command: 'claude',
				args: ['--print'],
				available: true,
				path: '/usr/local/bin/claude',
				version: '1.0.0',
			};

			mockAgentDetector.getAgent.mockResolvedValue(mockAgent);

			const handler = handlers.get('agents:get');
			const result = await handler!({} as any, 'claude-code');

			expect(mockAgentDetector.getAgent).toHaveBeenCalledWith('claude-code');
			expect(result.id).toBe('claude-code');
			expect(result.name).toBe('Claude Code');
			expect(result.path).toBe('/usr/local/bin/claude');
		});

		it('should return null for unknown agent id', async () => {
			mockAgentDetector.getAgent.mockResolvedValue(null);

			const handler = handlers.get('agents:get');
			const result = await handler!({} as any, 'unknown-agent');

			expect(mockAgentDetector.getAgent).toHaveBeenCalledWith('unknown-agent');
			expect(result).toBeNull();
		});

		it('should strip function properties from returned agent', async () => {
			const mockAgent = {
				id: 'claude-code',
				name: 'Claude Code',
				resumeArgs: (id: string) => ['--resume', id],
			};

			mockAgentDetector.getAgent.mockResolvedValue(mockAgent);

			const handler = handlers.get('agents:get');
			const result = await handler!({} as any, 'claude-code');

			expect(result.resumeArgs).toBeUndefined();
			expect(result.id).toBe('claude-code');
		});

		it('strips returned local agents without an id', async () => {
			mockAgentDetector.getAgent.mockResolvedValue({ name: 'Nameless Agent' });

			const handler = handlers.get('agents:get');
			const result = await handler!({} as any, 'nameless');

			expect(result).toEqual({ name: 'Nameless Agent' });
		});

		describe('SSH remote get', () => {
			let mockSettingsStore: {
				get: ReturnType<typeof vi.fn>;
				set: ReturnType<typeof vi.fn>;
			};

			beforeEach(() => {
				mockSettingsStore = {
					get: vi.fn().mockReturnValue([]),
					set: vi.fn(),
				};

				handlers.clear();
				registerAgentsHandlers({
					...deps,
					settingsStore: mockSettingsStore as any,
				});
			});

			it('returns a remote agent as available when command -v finds its binary', async () => {
				mockSettingsStore.get.mockReturnValue([
					{ id: 'remote-get', host: 'dev.example.com', user: 'dev', enabled: true },
				]);
				vi.mocked(buildSshCommand).mockResolvedValue({
					command: 'ssh',
					args: ['dev@dev.example.com', 'command -v claude'],
				});
				vi.mocked(execFileNoThrow).mockResolvedValue({
					exitCode: 0,
					stdout: '/usr/local/bin/claude\n',
					stderr: '',
				});

				const handler = handlers.get('agents:get');
				const result = await handler!({} as any, 'claude-code', 'remote-get');

				expect(buildSshCommand).toHaveBeenCalledWith(
					expect.objectContaining({ id: 'remote-get', host: 'dev.example.com' }),
					expect.objectContaining({ command: 'command', args: ['-v', 'claude'] })
				);
				expect(result).toMatchObject({
					id: 'claude-code',
					available: true,
					path: '/usr/local/bin/claude',
				});
				expect(mockAgentDetector.getAgent).not.toHaveBeenCalled();
			});

			it('preserves an auth-required remote snapshot when a binary is available', async () => {
				const { capabilitySnapshots } = await import('../../../../main/agents/capability-snapshot');
				capabilitySnapshots.__resetForTests();
				capabilitySnapshots.markAuthRequired('claude-code', 'login required', 'remote-auth');
				mockSettingsStore.get.mockReturnValue([
					{ id: 'remote-auth', host: 'dev.example.com', user: 'dev', enabled: true },
				]);
				vi.mocked(buildSshCommand).mockResolvedValue({
					command: 'ssh',
					args: ['dev@dev.example.com', 'command -v claude'],
				});
				vi.mocked(execFileNoThrow).mockResolvedValue({
					exitCode: 0,
					stdout: '/usr/local/bin/claude\n',
					stderr: '',
				});

				const handler = handlers.get('agents:get');
				const result = await handler!({} as any, 'claude-code', 'remote-auth');

				expect(result.available).toBe(true);
				expect(capabilitySnapshots.get('claude-code', 'remote-auth')).toMatchObject({
					status: 'auth_required',
					lastError: 'login required',
				});
				capabilitySnapshots.__resetForTests();
			});

			it('checks terminal remotely without writing capability snapshots', async () => {
				mockSettingsStore.get.mockReturnValue([
					{ id: 'remote-terminal', host: 'dev.example.com', user: 'dev', enabled: true },
				]);
				vi.mocked(buildSshCommand).mockResolvedValue({
					command: 'ssh',
					args: ['dev@dev.example.com', 'command -v bash'],
				});
				vi.mocked(execFileNoThrow).mockResolvedValue({
					exitCode: 0,
					stdout: '/bin/bash\n',
					stderr: '',
				});

				const handler = handlers.get('agents:get');
				const result = await handler!({} as any, 'terminal', 'remote-terminal');

				expect(result).toMatchObject({ id: 'terminal', available: true, path: '/bin/bash' });
			});

			it('returns an unavailable remote agent definition when the selected remote is missing', async () => {
				mockSettingsStore.get.mockReturnValue([]);

				const handler = handlers.get('agents:get');
				const result = await handler!({} as any, 'opencode', 'missing-remote');

				expect(result).toMatchObject({
					id: 'opencode',
					available: false,
					error: 'SSH remote configuration not found: missing-remote',
				});
				expect(buildSshCommand).not.toHaveBeenCalled();
			});

			it('throws when a missing selected remote is requested for an unknown agent', async () => {
				mockSettingsStore.get.mockReturnValue([]);

				const handler = handlers.get('agents:get');
				await expect(handler!({} as any, 'unknown-agent', 'missing-remote')).rejects.toThrow(
					'Unknown agent: unknown-agent'
				);
			});

			it('throws when an existing selected remote is requested for an unknown agent', async () => {
				mockSettingsStore.get.mockReturnValue([
					{ id: 'remote-known', host: 'dev.example.com', enabled: true },
				]);

				const handler = handlers.get('agents:get');
				await expect(handler!({} as any, 'unknown-agent', 'remote-known')).rejects.toThrow(
					'Unknown agent: unknown-agent'
				);
				expect(buildSshCommand).not.toHaveBeenCalled();
			});

			it('returns the first SSH connection error line from stderr', async () => {
				mockSettingsStore.get.mockReturnValue([
					{ id: 'remote-denied', host: 'dev.example.com', user: 'dev', enabled: true },
				]);
				vi.mocked(buildSshCommand).mockResolvedValue({
					command: 'ssh',
					args: ['dev@dev.example.com', 'command -v claude'],
				});
				vi.mocked(execFileNoThrow).mockResolvedValue({
					exitCode: 255,
					stdout: '',
					stderr: 'Permission denied (publickey).\nsecondary detail',
				});

				const handler = handlers.get('agents:get');
				const result = await handler!({} as any, 'claude-code', 'remote-denied');

				expect(result).toMatchObject({
					id: 'claude-code',
					available: false,
					error: 'Permission denied (publickey).',
				});
			});

			it('returns not-installed status when a remote binary is not found without connection errors', async () => {
				mockSettingsStore.get.mockReturnValue([
					{ id: 'remote-not-installed', host: 'dev.example.com', user: 'dev', enabled: true },
				]);
				vi.mocked(buildSshCommand).mockResolvedValue({
					command: 'ssh',
					args: ['dev@dev.example.com', 'command -v claude'],
				});
				vi.mocked(execFileNoThrow).mockResolvedValue({
					exitCode: 1,
					stdout: '',
					stderr: '',
				});

				const handler = handlers.get('agents:get');
				const result = await handler!({} as any, 'claude-code', 'remote-not-installed');

				expect(result).toMatchObject({
					id: 'claude-code',
					available: false,
					path: undefined,
					error: undefined,
				});
			});

			it('returns a failed remote agent when the SSH probe throws', async () => {
				mockSettingsStore.get.mockReturnValue([
					{ id: 'remote-throws', host: 'dev.example.com', user: 'dev', enabled: true },
				]);
				vi.mocked(buildSshCommand).mockRejectedValue(new Error('SSH config invalid'));

				const handler = handlers.get('agents:get');
				const result = await handler!({} as any, 'claude-code', 'remote-throws');

				expect(result).toMatchObject({
					id: 'claude-code',
					available: false,
					error: 'Failed to connect: SSH config invalid',
				});
			});

			it('stringifies non-Error SSH probe failures for remote agent get', async () => {
				mockSettingsStore.get.mockReturnValue([
					{ id: 'remote-string-failure', host: 'dev.example.com', user: 'dev', enabled: true },
				]);
				vi.mocked(buildSshCommand).mockRejectedValue('string ssh failure');

				const handler = handlers.get('agents:get');
				const result = await handler!({} as any, 'claude-code', 'remote-string-failure');

				expect(result).toMatchObject({
					id: 'claude-code',
					available: false,
					error: 'Failed to connect: string ssh failure',
				});
			});

			it('returns a failed terminal remote agent without touching capability snapshots', async () => {
				mockSettingsStore.get.mockReturnValue([
					{ id: 'remote-terminal-fail', host: 'dev.example.com', user: 'dev', enabled: true },
				]);
				vi.mocked(buildSshCommand).mockRejectedValue(new Error('terminal ssh failure'));

				const handler = handlers.get('agents:get');
				const result = await handler!({} as any, 'terminal', 'remote-terminal-fail');

				expect(result).toMatchObject({
					id: 'terminal',
					available: false,
					error: 'Failed to connect: terminal ssh failure',
				});
			});

			it('returns a failed remote agent when the SSH probe times out', async () => {
				vi.useFakeTimers();
				try {
					mockSettingsStore.get.mockReturnValue([
						{ id: 'remote-timeout', host: 'dev.example.com', user: 'dev', enabled: true },
					]);
					vi.mocked(buildSshCommand).mockResolvedValue({
						command: 'ssh',
						args: ['dev@dev.example.com', 'command -v claude'],
					});
					vi.mocked(execFileNoThrow).mockImplementation(() => new Promise(() => {}) as any);

					const handler = handlers.get('agents:get');
					const pending = handler!({} as any, 'claude-code', 'remote-timeout');

					await vi.advanceTimersByTimeAsync(10000);
					const result = await pending;

					expect(result).toMatchObject({
						id: 'claude-code',
						available: false,
						error: 'Failed to connect: SSH connection timed out after 10s',
					});
				} finally {
					vi.useRealTimers();
				}
			});
		});
	});

	describe('agents:getCapabilities', () => {
		it('should return capabilities for known agent', async () => {
			const mockCapabilities = {
				supportsResume: true,
				supportsReadOnlyMode: true,
				supportsJsonOutput: true,
				supportsSessionId: true,
				supportsImageInput: true,
				supportsImageInputOnResume: true,
				supportsSlashCommands: true,
				supportsSessionStorage: true,
				supportsCostTracking: true,
				supportsUsageStats: true,
				supportsBatchMode: true,
				requiresPromptToStart: false,
				supportsStreaming: true,
				supportsResultMessages: true,
				supportsModelSelection: false,
				supportsStreamJsonInput: true,
				supportsThinkingDisplay: false,
				supportsContextMerge: false,
				supportsContextExport: false,
				supportsWizard: false,
				supportsGroupChatModeration: false,
				usesJsonLineOutput: false,
				usesCombinedContextWindow: false,
				supportsAppendSystemPrompt: false,
				supportsProjectMemory: false,
			};

			vi.mocked(agentCapabilities.getAgentCapabilities).mockReturnValue(mockCapabilities);

			const handler = handlers.get('agents:getCapabilities');
			const result = await handler!({} as any, 'claude-code');

			expect(agentCapabilities.getAgentCapabilities).toHaveBeenCalledWith('claude-code');
			expect(result).toEqual(mockCapabilities);
		});

		it('should return default capabilities for unknown agent', async () => {
			const defaultCaps = {
				supportsResume: false,
				supportsReadOnlyMode: false,
				supportsJsonOutput: false,
				supportsSessionId: false,
				supportsImageInput: false,
				supportsImageInputOnResume: false,
				supportsSlashCommands: false,
				supportsSessionStorage: false,
				supportsCostTracking: false,
				supportsUsageStats: false,
				supportsBatchMode: false,
				requiresPromptToStart: false,
				supportsStreaming: false,
				supportsResultMessages: false,
				supportsModelSelection: false,
				supportsStreamJsonInput: false,
				supportsThinkingDisplay: false,
				supportsContextMerge: false,
				supportsContextExport: false,
				supportsWizard: false,
				supportsGroupChatModeration: false,
				usesJsonLineOutput: false,
				usesCombinedContextWindow: false,
				supportsAppendSystemPrompt: false,
				supportsProjectMemory: false,
			};

			vi.mocked(agentCapabilities.getAgentCapabilities).mockReturnValue(defaultCaps);

			const handler = handlers.get('agents:getCapabilities');
			const result = await handler!({} as any, 'unknown-agent');

			expect(result.supportsResume).toBe(false);
			expect(result.supportsJsonOutput).toBe(false);
		});

		it('should include all expected capability fields', async () => {
			const mockCapabilities = {
				supportsResume: true,
				supportsReadOnlyMode: true,
				supportsJsonOutput: true,
				supportsSessionId: true,
				supportsImageInput: true,
				supportsImageInputOnResume: false,
				supportsSlashCommands: true,
				supportsSessionStorage: true,
				supportsCostTracking: true,
				supportsUsageStats: true,
				supportsBatchMode: true,
				requiresPromptToStart: false,
				supportsStreaming: true,
				supportsResultMessages: true,
				supportsModelSelection: true,
				supportsStreamJsonInput: true,
				supportsThinkingDisplay: false,
				supportsContextMerge: false,
				supportsContextExport: false,
				supportsWizard: false,
				supportsGroupChatModeration: false,
				usesJsonLineOutput: false,
				usesCombinedContextWindow: false,
				supportsAppendSystemPrompt: false,
				supportsProjectMemory: false,
			};

			vi.mocked(agentCapabilities.getAgentCapabilities).mockReturnValue(mockCapabilities);

			const handler = handlers.get('agents:getCapabilities');
			const result = await handler!({} as any, 'opencode');

			expect(result).toHaveProperty('supportsResume');
			expect(result).toHaveProperty('supportsReadOnlyMode');
			expect(result).toHaveProperty('supportsJsonOutput');
			expect(result).toHaveProperty('supportsSessionId');
			expect(result).toHaveProperty('supportsImageInput');
			expect(result).toHaveProperty('supportsImageInputOnResume');
			expect(result).toHaveProperty('supportsSlashCommands');
			expect(result).toHaveProperty('supportsSessionStorage');
			expect(result).toHaveProperty('supportsCostTracking');
			expect(result).toHaveProperty('supportsUsageStats');
			expect(result).toHaveProperty('supportsBatchMode');
			expect(result).toHaveProperty('requiresPromptToStart');
			expect(result).toHaveProperty('supportsStreaming');
			expect(result).toHaveProperty('supportsResultMessages');
			expect(result).toHaveProperty('supportsModelSelection');
			expect(result).toHaveProperty('supportsStreamJsonInput');
		});
	});

	describe('agents:getConfigOptions', () => {
		it('delegates dynamic config option discovery to the agent detector', async () => {
			(mockAgentDetector as any).discoverConfigOptions = vi
				.fn()
				.mockResolvedValue(['model-a', 'model-b']);

			const handler = handlers.get('agents:getConfigOptions');
			const result = await handler!({} as any, 'opencode', 'model', true);

			expect((mockAgentDetector as any).discoverConfigOptions).toHaveBeenCalledWith(
				'opencode',
				'model',
				true
			);
			expect(result).toEqual(['model-a', 'model-b']);
		});

		it('defaults dynamic config option discovery to non-forced refresh', async () => {
			(mockAgentDetector as any).discoverConfigOptions = vi.fn().mockResolvedValue(['model-a']);

			const handler = handlers.get('agents:getConfigOptions');
			const result = await handler!({} as any, 'opencode', 'model');

			expect((mockAgentDetector as any).discoverConfigOptions).toHaveBeenCalledWith(
				'opencode',
				'model',
				false
			);
			expect(result).toEqual(['model-a']);
		});
	});

	describe('agents:refresh', () => {
		it('should clear cache and return updated agent list', async () => {
			const mockAgents = [
				{ id: 'claude-code', name: 'Claude Code', available: true, path: '/bin/claude' },
			];

			mockAgentDetector.detectAgents.mockResolvedValue(mockAgents);

			const handler = handlers.get('agents:refresh');
			const result = await handler!({} as any);

			expect(mockAgentDetector.clearCache).toHaveBeenCalled();
			expect(mockAgentDetector.detectAgents).toHaveBeenCalled();
			expect(result.agents).toHaveLength(1);
			expect(result.debugInfo).toBeNull();
		});

		it('should return detailed debug info when specific agent requested', async () => {
			const mockAgents = [
				{ id: 'claude-code', name: 'Claude Code', available: false, binaryName: 'claude' },
			];

			mockAgentDetector.detectAgents.mockResolvedValue(mockAgents);
			vi.mocked(execFileNoThrow).mockResolvedValue({
				stdout: '',
				stderr: 'claude: not found',
				exitCode: 1,
			});

			const handler = handlers.get('agents:refresh');
			const result = await handler!({} as any, 'claude-code');

			expect(mockAgentDetector.clearCache).toHaveBeenCalled();
			expect(result.debugInfo).not.toBeNull();
			expect(result.debugInfo.agentId).toBe('claude-code');
			expect(result.debugInfo.available).toBe(false);
			expect(result.debugInfo.error).toContain('failed');
		});

		it('should return debug info without error for available agent', async () => {
			const mockAgents = [
				{
					id: 'claude-code',
					name: 'Claude Code',
					available: true,
					path: '/bin/claude',
					binaryName: 'claude',
				},
			];

			mockAgentDetector.detectAgents.mockResolvedValue(mockAgents);

			const handler = handlers.get('agents:refresh');
			const result = await handler!({} as any, 'claude-code');

			expect(result.debugInfo).not.toBeNull();
			expect(result.debugInfo.agentId).toBe('claude-code');
			expect(result.debugInfo.available).toBe(true);
			expect(result.debugInfo.path).toBe('/bin/claude');
			expect(result.debugInfo.error).toBeNull();
		});

		it('uses safe refresh debug defaults when env and agent metadata are missing', async () => {
			const originalPath = process.env.PATH;
			const originalHome = process.env.HOME;
			delete process.env.PATH;
			delete process.env.HOME;
			try {
				mockAgentDetector.detectAgents.mockResolvedValue([]);
				vi.mocked(execFileNoThrow).mockResolvedValue({
					stdout: '/usr/local/bin/ghost-agent\n',
					stderr: '',
					exitCode: 0,
				});

				const handler = handlers.get('agents:refresh');
				const result = await handler!({} as any, 'ghost-agent');

				expect(result.debugInfo).toMatchObject({
					agentId: 'ghost-agent',
					available: false,
					path: null,
					binaryName: 'ghost-agent',
					envPath: '',
					homeDir: '',
					error: null,
				});
				expect(execFileNoThrow).toHaveBeenCalledWith(expect.any(String), ['ghost-agent']);
			} finally {
				if (originalPath === undefined) {
					delete process.env.PATH;
				} else {
					process.env.PATH = originalPath;
				}
				if (originalHome === undefined) {
					delete process.env.HOME;
				} else {
					process.env.HOME = originalHome;
				}
			}
		});

		it('uses the binary-not-found refresh fallback when which exits without stderr', async () => {
			mockAgentDetector.detectAgents.mockResolvedValue([]);
			vi.mocked(execFileNoThrow).mockResolvedValue({
				stdout: '',
				stderr: '',
				exitCode: 1,
			});

			const handler = handlers.get('agents:refresh');
			const result = await handler!({} as any, 'ghost-agent');

			expect(result.debugInfo.error).toContain('Binary not found in PATH');
			expect(execFileNoThrow).toHaveBeenCalledWith(expect.any(String), ['ghost-agent']);
		});
	});

	describe('agents:getConfig', () => {
		it('should return configuration for agent', async () => {
			const mockConfigs = {
				'claude-code': { customPath: '/custom/path', model: 'gpt-4' },
			};

			mockAgentConfigsStore.get.mockReturnValue(mockConfigs);

			const handler = handlers.get('agents:getConfig');
			const result = await handler!({} as any, 'claude-code');

			expect(mockAgentConfigsStore.get).toHaveBeenCalledWith('configs', {});
			expect(result).toEqual({ customPath: '/custom/path', model: 'gpt-4' });
		});

		it('should return empty object for agent without config', async () => {
			mockAgentConfigsStore.get.mockReturnValue({});

			const handler = handlers.get('agents:getConfig');
			const result = await handler!({} as any, 'unknown-agent');

			expect(result).toEqual({});
		});

		it('merges config option defaults with stored agent config', async () => {
			const opencodeDef = agentCapabilities.AGENT_DEFINITIONS.find(
				(a) => a.id === 'opencode'
			) as any;
			const originalOptions = opencodeDef.configOptions;
			opencodeDef.configOptions = [
				{ key: 'model', default: 'opencode/gpt-5-nano' },
				{ key: 'emptyDefault' },
			];
			mockAgentConfigsStore.get.mockReturnValue({
				opencode: { theme: 'dark' },
			});

			const handler = handlers.get('agents:getConfig');
			const result = await handler!({} as any, 'opencode');

			expect(result).toEqual({ model: 'opencode/gpt-5-nano', theme: 'dark' });
			opencodeDef.configOptions = originalOptions;
		});
	});

	describe('agents:setConfig', () => {
		it('should set configuration for agent', async () => {
			mockAgentConfigsStore.get.mockReturnValue({});

			const handler = handlers.get('agents:setConfig');
			const result = await handler!({} as any, 'claude-code', { model: 'gpt-4', theme: 'dark' });

			expect(mockAgentConfigsStore.set).toHaveBeenCalledWith('configs', {
				'claude-code': { model: 'gpt-4', theme: 'dark' },
			});
			expect(result).toBe(true);
		});

		it('should merge with existing configs for other agents', async () => {
			mockAgentConfigsStore.get.mockReturnValue({
				opencode: { model: 'ollama/qwen3' },
			});

			const handler = handlers.get('agents:setConfig');
			await handler!({} as any, 'claude-code', { customPath: '/custom' });

			expect(mockAgentConfigsStore.set).toHaveBeenCalledWith('configs', {
				opencode: { model: 'ollama/qwen3' },
				'claude-code': { customPath: '/custom' },
			});
		});
	});

	describe('agents:getConfigValue', () => {
		it('should return specific config value for agent', async () => {
			mockAgentConfigsStore.get.mockReturnValue({
				'claude-code': { customPath: '/custom/path', model: 'gpt-4' },
			});

			const handler = handlers.get('agents:getConfigValue');
			const result = await handler!({} as any, 'claude-code', 'customPath');

			expect(result).toBe('/custom/path');
		});

		it('should return undefined for non-existent config key', async () => {
			mockAgentConfigsStore.get.mockReturnValue({
				'claude-code': { customPath: '/custom/path' },
			});

			const handler = handlers.get('agents:getConfigValue');
			const result = await handler!({} as any, 'claude-code', 'nonExistent');

			expect(result).toBeUndefined();
		});

		it('should return undefined for agent without config', async () => {
			mockAgentConfigsStore.get.mockReturnValue({});

			const handler = handlers.get('agents:getConfigValue');
			const result = await handler!({} as any, 'unknown-agent', 'model');

			expect(result).toBeUndefined();
		});

		it('falls back to an agent config option default when no stored value exists', async () => {
			const opencodeDef = agentCapabilities.AGENT_DEFINITIONS.find(
				(a) => a.id === 'opencode'
			) as any;
			const originalOptions = opencodeDef.configOptions;
			opencodeDef.configOptions = [{ key: 'model', default: 'opencode/gpt-5-nano' }];
			mockAgentConfigsStore.get.mockReturnValue({ opencode: {} });

			const handler = handlers.get('agents:getConfigValue');
			const result = await handler!({} as any, 'opencode', 'model');

			expect(result).toBe('opencode/gpt-5-nano');
			opencodeDef.configOptions = originalOptions;
		});
	});

	describe('agents:setConfigValue', () => {
		it('should set specific config value for agent', async () => {
			mockAgentConfigsStore.get.mockReturnValue({
				'claude-code': { existing: 'value' },
			});

			const handler = handlers.get('agents:setConfigValue');
			const result = await handler!({} as any, 'claude-code', 'newKey', 'newValue');

			expect(mockAgentConfigsStore.set).toHaveBeenCalledWith('configs', {
				'claude-code': { existing: 'value', newKey: 'newValue' },
			});
			expect(result).toBe(true);
		});

		it('should create agent config if it does not exist', async () => {
			mockAgentConfigsStore.get.mockReturnValue({});

			const handler = handlers.get('agents:setConfigValue');
			await handler!({} as any, 'new-agent', 'key', 'value');

			expect(mockAgentConfigsStore.set).toHaveBeenCalledWith('configs', {
				'new-agent': { key: 'value' },
			});
		});
	});

	describe('agents:setCustomPath', () => {
		it('should set custom path for agent', async () => {
			mockAgentConfigsStore.get.mockReturnValue({});

			const handler = handlers.get('agents:setCustomPath');
			const result = await handler!({} as any, 'claude-code', '/custom/bin/claude');

			expect(mockAgentConfigsStore.set).toHaveBeenCalledWith('configs', {
				'claude-code': { customPath: '/custom/bin/claude' },
			});
			expect(mockAgentDetector.setCustomPaths).toHaveBeenCalledWith({
				'claude-code': '/custom/bin/claude',
			});
			expect(result).toBe(true);
		});

		it('should clear custom path when null is passed', async () => {
			mockAgentConfigsStore.get.mockReturnValue({
				'claude-code': { customPath: '/old/path', otherConfig: 'value' },
			});

			const handler = handlers.get('agents:setCustomPath');
			const result = await handler!({} as any, 'claude-code', null);

			expect(mockAgentConfigsStore.set).toHaveBeenCalledWith('configs', {
				'claude-code': { otherConfig: 'value' },
			});
			expect(mockAgentDetector.setCustomPaths).toHaveBeenCalledWith({});
			expect(result).toBe(true);
		});

		it('should update agent detector with all custom paths', async () => {
			mockAgentConfigsStore.get.mockReturnValue({
				opencode: { customPath: '/custom/opencode' },
			});

			const handler = handlers.get('agents:setCustomPath');
			await handler!({} as any, 'claude-code', '/custom/claude');

			expect(mockAgentDetector.setCustomPaths).toHaveBeenCalledWith({
				opencode: '/custom/opencode',
				'claude-code': '/custom/claude',
			});
		});
	});

	describe('agents:getCustomPath', () => {
		it('should return custom path for agent', async () => {
			mockAgentConfigsStore.get.mockReturnValue({
				'claude-code': { customPath: '/custom/bin/claude' },
			});

			const handler = handlers.get('agents:getCustomPath');
			const result = await handler!({} as any, 'claude-code');

			expect(result).toBe('/custom/bin/claude');
		});

		it('should return null when no custom path set', async () => {
			mockAgentConfigsStore.get.mockReturnValue({});

			const handler = handlers.get('agents:getCustomPath');
			const result = await handler!({} as any, 'claude-code');

			expect(result).toBeNull();
		});

		it('should return null for agent without config', async () => {
			mockAgentConfigsStore.get.mockReturnValue({
				opencode: { customPath: '/custom/opencode' },
			});

			const handler = handlers.get('agents:getCustomPath');
			const result = await handler!({} as any, 'unknown-agent');

			expect(result).toBeNull();
		});
	});

	describe('agents:getAllCustomPaths', () => {
		it('should return all custom paths', async () => {
			mockAgentConfigsStore.get.mockReturnValue({
				'claude-code': { customPath: '/custom/claude' },
				opencode: { customPath: '/custom/opencode' },
				codex: { model: 'gpt-4' }, // No customPath
			});

			const handler = handlers.get('agents:getAllCustomPaths');
			const result = await handler!({} as any);

			expect(result).toEqual({
				'claude-code': '/custom/claude',
				opencode: '/custom/opencode',
			});
		});

		it('should return empty object when no custom paths set', async () => {
			mockAgentConfigsStore.get.mockReturnValue({});

			const handler = handlers.get('agents:getAllCustomPaths');
			const result = await handler!({} as any);

			expect(result).toEqual({});
		});
	});

	describe('agents:setCustomArgs', () => {
		it('should set custom args for agent', async () => {
			mockAgentConfigsStore.get.mockReturnValue({});

			const handler = handlers.get('agents:setCustomArgs');
			const result = await handler!({} as any, 'claude-code', '--verbose --debug');

			expect(mockAgentConfigsStore.set).toHaveBeenCalledWith('configs', {
				'claude-code': { customArgs: '--verbose --debug' },
			});
			expect(result).toBe(true);
		});

		it('should clear custom args when null or empty string passed', async () => {
			mockAgentConfigsStore.get.mockReturnValue({
				'claude-code': { customArgs: '--old-args', otherConfig: 'value' },
			});

			const handler = handlers.get('agents:setCustomArgs');
			await handler!({} as any, 'claude-code', null);

			expect(mockAgentConfigsStore.set).toHaveBeenCalledWith('configs', {
				'claude-code': { otherConfig: 'value' },
			});
		});

		it('should trim whitespace from custom args', async () => {
			mockAgentConfigsStore.get.mockReturnValue({});

			const handler = handlers.get('agents:setCustomArgs');
			await handler!({} as any, 'claude-code', '  --verbose  ');

			expect(mockAgentConfigsStore.set).toHaveBeenCalledWith('configs', {
				'claude-code': { customArgs: '--verbose' },
			});
		});
	});

	describe('agents:getCustomArgs', () => {
		it('should return custom args for agent', async () => {
			mockAgentConfigsStore.get.mockReturnValue({
				'claude-code': { customArgs: '--verbose --debug' },
			});

			const handler = handlers.get('agents:getCustomArgs');
			const result = await handler!({} as any, 'claude-code');

			expect(result).toBe('--verbose --debug');
		});

		it('should return null when no custom args set', async () => {
			mockAgentConfigsStore.get.mockReturnValue({});

			const handler = handlers.get('agents:getCustomArgs');
			const result = await handler!({} as any, 'claude-code');

			expect(result).toBeNull();
		});
	});

	describe('agents:getAllCustomArgs', () => {
		it('should return all custom args', async () => {
			mockAgentConfigsStore.get.mockReturnValue({
				'claude-code': { customArgs: '--verbose' },
				opencode: { customArgs: '--debug' },
				codex: { model: 'gpt-4' }, // No customArgs
			});

			const handler = handlers.get('agents:getAllCustomArgs');
			const result = await handler!({} as any);

			expect(result).toEqual({
				'claude-code': '--verbose',
				opencode: '--debug',
			});
		});

		it('should return empty object when no custom args set', async () => {
			mockAgentConfigsStore.get.mockReturnValue({});

			const handler = handlers.get('agents:getAllCustomArgs');
			const result = await handler!({} as any);

			expect(result).toEqual({});
		});
	});

	describe('agents:setCustomEnvVars', () => {
		it('should set custom env vars for agent', async () => {
			mockAgentConfigsStore.get.mockReturnValue({});

			const handler = handlers.get('agents:setCustomEnvVars');
			const result = await handler!({} as any, 'claude-code', { API_KEY: 'secret', DEBUG: 'true' });

			expect(mockAgentConfigsStore.set).toHaveBeenCalledWith('configs', {
				'claude-code': { customEnvVars: { API_KEY: 'secret', DEBUG: 'true' } },
			});
			expect(result).toBe(true);
		});

		it('should clear custom env vars when null passed', async () => {
			mockAgentConfigsStore.get.mockReturnValue({
				'claude-code': { customEnvVars: { OLD: 'value' }, otherConfig: 'value' },
			});

			const handler = handlers.get('agents:setCustomEnvVars');
			await handler!({} as any, 'claude-code', null);

			expect(mockAgentConfigsStore.set).toHaveBeenCalledWith('configs', {
				'claude-code': { otherConfig: 'value' },
			});
		});

		it('should clear custom env vars when empty object passed', async () => {
			mockAgentConfigsStore.get.mockReturnValue({
				'claude-code': { customEnvVars: { OLD: 'value' }, otherConfig: 'value' },
			});

			const handler = handlers.get('agents:setCustomEnvVars');
			await handler!({} as any, 'claude-code', {});

			expect(mockAgentConfigsStore.set).toHaveBeenCalledWith('configs', {
				'claude-code': { otherConfig: 'value' },
			});
		});
	});

	describe('agents:getCustomEnvVars', () => {
		it('should return custom env vars for agent', async () => {
			mockAgentConfigsStore.get.mockReturnValue({
				'claude-code': { customEnvVars: { API_KEY: 'secret' } },
			});

			const handler = handlers.get('agents:getCustomEnvVars');
			const result = await handler!({} as any, 'claude-code');

			expect(result).toEqual({ API_KEY: 'secret' });
		});

		it('should return null when no custom env vars set', async () => {
			mockAgentConfigsStore.get.mockReturnValue({});

			const handler = handlers.get('agents:getCustomEnvVars');
			const result = await handler!({} as any, 'claude-code');

			expect(result).toBeNull();
		});
	});

	describe('agents:getAllCustomEnvVars', () => {
		it('should return all custom env vars', async () => {
			mockAgentConfigsStore.get.mockReturnValue({
				'claude-code': { customEnvVars: { KEY1: 'val1' } },
				opencode: { customEnvVars: { KEY2: 'val2' } },
				codex: { model: 'gpt-4' }, // No customEnvVars
			});

			const handler = handlers.get('agents:getAllCustomEnvVars');
			const result = await handler!({} as any);

			expect(result).toEqual({
				'claude-code': { KEY1: 'val1' },
				opencode: { KEY2: 'val2' },
			});
		});

		it('should return empty object when no custom env vars set', async () => {
			mockAgentConfigsStore.get.mockReturnValue({});

			const handler = handlers.get('agents:getAllCustomEnvVars');
			const result = await handler!({} as any);

			expect(result).toEqual({});
		});
	});

	describe('agents:getModels', () => {
		it('should return models for agent', async () => {
			const mockModels = ['opencode/gpt-5-nano', 'ollama/qwen3:8b', 'anthropic/claude-sonnet'];

			mockAgentDetector.discoverModels.mockResolvedValue(mockModels);

			const handler = handlers.get('agents:getModels');
			const result = await handler!({} as any, 'opencode');

			expect(mockAgentDetector.discoverModels).toHaveBeenCalledWith('opencode', false);
			expect(result).toEqual(mockModels);
		});

		it('should pass forceRefresh flag to detector', async () => {
			mockAgentDetector.discoverModels.mockResolvedValue([]);

			const handler = handlers.get('agents:getModels');
			await handler!({} as any, 'opencode', true);

			expect(mockAgentDetector.discoverModels).toHaveBeenCalledWith('opencode', true);
		});

		it('should return empty array when agent does not support model selection', async () => {
			mockAgentDetector.discoverModels.mockResolvedValue([]);

			const handler = handlers.get('agents:getModels');
			const result = await handler!({} as any, 'claude-code');

			expect(result).toEqual([]);
		});

		describe('SSH remote model discovery', () => {
			let mockSettingsStore: {
				get: ReturnType<typeof vi.fn>;
				set: ReturnType<typeof vi.fn>;
			};

			beforeEach(() => {
				mockSettingsStore = {
					get: vi.fn().mockReturnValue([]),
					set: vi.fn(),
				};

				// Re-register handlers with settingsStore
				handlers.clear();
				registerAgentsHandlers({
					...deps,
					settingsStore: mockSettingsStore as any,
				});
			});

			it('should discover models on SSH remote when sshRemoteId is provided', async () => {
				mockSettingsStore.get.mockReturnValue([
					{
						id: 'remote-1',
						host: 'dev.example.com',
						user: 'dev',
						enabled: true,
					},
				]);

				vi.mocked(buildSshCommand).mockResolvedValue({
					command: 'ssh',
					args: ['-o', 'BatchMode=yes', 'dev@dev.example.com', 'opencode models'],
				});

				vi.mocked(execFileNoThrow).mockResolvedValue({
					exitCode: 0,
					stdout: 'opencode/gpt-5-nano\nollama/qwen3:8b\n',
					stderr: '',
				});

				const handler = handlers.get('agents:getModels');
				const result = await handler!({} as any, 'opencode', false, 'remote-1');

				expect(buildSshCommand).toHaveBeenCalledWith(
					expect.objectContaining({ id: 'remote-1', host: 'dev.example.com' }),
					expect.objectContaining({ command: 'opencode', args: ['models'] })
				);
				expect(result).toEqual(['opencode/gpt-5-nano', 'ollama/qwen3:8b']);
				expect(mockAgentDetector.discoverModels).not.toHaveBeenCalled();
			});

			it('defaults remote model discovery to non-forced and skips config discovery for non-OpenCode agents', async () => {
				mockSettingsStore.get.mockReturnValue([
					{ id: 'remote-codex-models', host: 'dev.example.com', enabled: true },
				]);
				vi.mocked(buildSshCommand).mockResolvedValue({
					command: 'ssh',
					args: ['dev@dev.example.com', 'codex models'],
				});
				vi.mocked(execFileNoThrow).mockResolvedValue({
					exitCode: 0,
					stdout: 'codex/model\ncodex/model\n',
					stderr: '',
				});

				const handler = handlers.get('agents:getModels');
				const result = await handler!({} as any, 'codex', undefined, 'remote-codex-models');

				expect(buildSshCommand).toHaveBeenCalledTimes(1);
				expect(result).toEqual(['codex/model']);
				expect(mockAgentDetector.discoverModels).not.toHaveBeenCalled();
			});

			it('merges CLI models with remote OpenCode config models and removes duplicates', async () => {
				mockSettingsStore.get.mockReturnValue([
					{
						id: 'remote-configs',
						host: 'dev.example.com',
						user: 'dev',
						enabled: true,
						remoteEnv: { OPENCODE_CONFIG: '/remote/opencode.json' },
					},
				]);

				vi.mocked(buildSshCommand)
					.mockResolvedValueOnce({
						command: 'ssh',
						args: ['dev@dev.example.com', 'opencode models'],
					})
					.mockResolvedValueOnce({
						command: 'ssh',
						args: ['dev@dev.example.com', 'read opencode configs'],
					});

				vi.mocked(execFileNoThrow)
					.mockResolvedValueOnce({
						exitCode: 0,
						stdout: 'opencode/gpt-5-nano\nollama/qwen3:8b\n',
						stderr: '',
					})
					.mockResolvedValueOnce({
						exitCode: 0,
						stdout: [
							'___OPENCODE_CONFIG_START___',
							JSON.stringify({
								model: 'opencode/gpt-5-nano',
								provider: {
									anthropic: { models: { 'claude-sonnet': {} } },
									ollama: { models: { 'qwen3:8b': {} } },
								},
							}),
							'___OPENCODE_CONFIG_END___',
						].join('\n'),
						stderr: '',
					});

				const handler = handlers.get('agents:getModels');
				const result = await handler!({} as any, 'opencode', true, 'remote-configs');

				expect(buildSshCommand).toHaveBeenNthCalledWith(
					1,
					expect.objectContaining({ id: 'remote-configs', host: 'dev.example.com' }),
					expect.objectContaining({ command: 'opencode', args: ['models'] })
				);
				expect(buildSshCommand).toHaveBeenNthCalledWith(
					2,
					expect.objectContaining({ id: 'remote-configs', host: 'dev.example.com' }),
					expect.objectContaining({
						command: 'sh',
						env: { OPENCODE_CONFIG: '/remote/opencode.json' },
					})
				);
				expect(result).toEqual([
					'opencode/gpt-5-nano',
					'ollama/qwen3:8b',
					'anthropic/claude-sonnet',
				]);
				expect(mockAgentDetector.discoverModels).not.toHaveBeenCalled();
			});

			it('parses a remote OpenCode config block without an end marker', async () => {
				mockSettingsStore.get.mockReturnValue([
					{ id: 'remote-config-no-end', host: 'dev.example.com', enabled: true },
				]);
				vi.mocked(buildSshCommand)
					.mockResolvedValueOnce({
						command: 'ssh',
						args: ['dev@dev.example.com', 'opencode models'],
					})
					.mockResolvedValueOnce({
						command: 'ssh',
						args: ['dev@dev.example.com', 'read opencode configs'],
					});
				vi.mocked(execFileNoThrow)
					.mockResolvedValueOnce({
						exitCode: 0,
						stdout: 'opencode/gpt-5-nano\n',
						stderr: '',
					})
					.mockResolvedValueOnce({
						exitCode: 0,
						stdout: [
							'___OPENCODE_CONFIG_START___',
							JSON.stringify({
								model: 'opencode/gpt-5-nano',
								provider: { anthropic: { models: { 'claude-sonnet': {} } } },
							}),
						].join('\n'),
						stderr: '',
					});

				const handler = handlers.get('agents:getModels');
				const result = await handler!({} as any, 'opencode', true, 'remote-config-no-end');

				expect(result).toEqual(['opencode/gpt-5-nano', 'anthropic/claude-sonnet']);
			});

			it('deduplicates model ids repeated across remote OpenCode config blocks', async () => {
				mockSettingsStore.get.mockReturnValue([
					{ id: 'remote-config-duplicates', host: 'dev.example.com', enabled: true },
				]);
				vi.mocked(buildSshCommand)
					.mockResolvedValueOnce({
						command: 'ssh',
						args: ['dev@dev.example.com', 'opencode models'],
					})
					.mockResolvedValueOnce({
						command: 'ssh',
						args: ['dev@dev.example.com', 'read opencode configs'],
					});
				vi.mocked(execFileNoThrow)
					.mockResolvedValueOnce({
						exitCode: 0,
						stdout: '',
						stderr: '',
					})
					.mockResolvedValueOnce({
						exitCode: 0,
						stdout: [
							'___OPENCODE_CONFIG_START___',
							JSON.stringify({ model: 'duplicate/model' }),
							'___OPENCODE_CONFIG_END___',
							'___OPENCODE_CONFIG_START___',
							JSON.stringify({ model: 'duplicate/model' }),
							'___OPENCODE_CONFIG_END___',
						].join('\n'),
						stderr: '',
					});

				const handler = handlers.get('agents:getModels');
				const result = await handler!({} as any, 'opencode', true, 'remote-config-duplicates');

				expect(result).toEqual(['duplicate/model']);
			});

			it('returns empty remote models for unknown agents without opening SSH', async () => {
				mockSettingsStore.get.mockReturnValue([
					{ id: 'remote-unknown', host: 'dev.example.com', enabled: true },
				]);

				const handler = handlers.get('agents:getModels');
				const result = await handler!({} as any, 'unknown-agent', true, 'remote-unknown');

				expect(result).toEqual([]);
				expect(buildSshCommand).not.toHaveBeenCalled();
				expect(mockAgentDetector.discoverModels).not.toHaveBeenCalled();
			});

			it('returns empty remote models when the remote models command fails', async () => {
				mockSettingsStore.get.mockReturnValue([
					{ id: 'remote-failure', host: 'dev.example.com', enabled: true },
				]);

				vi.mocked(buildSshCommand).mockResolvedValue({
					command: 'ssh',
					args: ['dev@dev.example.com', 'opencode models'],
				});
				vi.mocked(execFileNoThrow).mockResolvedValue({
					exitCode: 2,
					stdout: '',
					stderr: 'opencode not available',
				});

				const handler = handlers.get('agents:getModels');
				const result = await handler!({} as any, 'opencode', true, 'remote-failure');

				expect(result).toEqual([]);
				expect(buildSshCommand).toHaveBeenCalledTimes(1);
				expect(mockAgentDetector.discoverModels).not.toHaveBeenCalled();
			});

			it('uses cached remote models on repeated non-forced discovery', async () => {
				mockSettingsStore.get.mockReturnValue([
					{ id: 'remote-cache', host: 'dev.example.com', enabled: true },
				]);
				vi.mocked(buildSshCommand).mockResolvedValue({
					command: 'ssh',
					args: ['dev@dev.example.com', 'opencode models'],
				});
				vi.mocked(execFileNoThrow)
					.mockResolvedValueOnce({
						exitCode: 0,
						stdout: 'cached/model\n',
						stderr: '',
					})
					.mockResolvedValueOnce({
						exitCode: 0,
						stdout: '',
						stderr: '',
					});

				const handler = handlers.get('agents:getModels');
				const first = await handler!({} as any, 'opencode', false, 'remote-cache');
				const second = await handler!({} as any, 'opencode', false, 'remote-cache');

				expect(first).toEqual(['cached/model']);
				expect(second).toEqual(['cached/model']);
				expect(buildSshCommand).toHaveBeenCalledTimes(2);
			});

			it('ignores empty and malformed remote OpenCode config blocks', async () => {
				mockSettingsStore.get.mockReturnValue([
					{ id: 'remote-empty-configs', host: 'dev.example.com', enabled: true },
				]);
				vi.mocked(buildSshCommand)
					.mockResolvedValueOnce({
						command: 'ssh',
						args: ['dev@dev.example.com', 'opencode models'],
					})
					.mockResolvedValueOnce({
						command: 'ssh',
						args: ['dev@dev.example.com', 'read configs'],
					});
				vi.mocked(execFileNoThrow)
					.mockResolvedValueOnce({
						exitCode: 0,
						stdout: '',
						stderr: '',
					})
					.mockResolvedValueOnce({
						exitCode: 0,
						stdout: [
							'___OPENCODE_CONFIG_START___',
							'___OPENCODE_CONFIG_END___',
							'___OPENCODE_CONFIG_START___',
							'{ not json',
							'___OPENCODE_CONFIG_END___',
						].join('\n'),
						stderr: '',
					});

				const handler = handlers.get('agents:getModels');
				const result = await handler!({} as any, 'opencode', true, 'remote-empty-configs');

				expect(result).toEqual([]);
			});

			it('keeps CLI models when remote OpenCode config reading fails', async () => {
				mockSettingsStore.get.mockReturnValue([
					{ id: 'remote-config-error', host: 'dev.example.com', enabled: true },
				]);
				vi.mocked(buildSshCommand)
					.mockResolvedValueOnce({
						command: 'ssh',
						args: ['dev@dev.example.com', 'opencode models'],
					})
					.mockRejectedValueOnce(new Error('config ssh failed'));
				vi.mocked(execFileNoThrow).mockResolvedValueOnce({
					exitCode: 0,
					stdout: 'cli/model\n',
					stderr: '',
				});

				const handler = handlers.get('agents:getModels');
				const result = await handler!({} as any, 'opencode', true, 'remote-config-error');

				expect(result).toEqual(['cli/model']);
			});

			it('keeps CLI models when remote OpenCode config reading times out', async () => {
				vi.useFakeTimers();
				try {
					mockSettingsStore.get.mockReturnValue([
						{ id: 'remote-config-timeout', host: 'dev.example.com', enabled: true },
					]);
					vi.mocked(buildSshCommand)
						.mockResolvedValueOnce({
							command: 'ssh',
							args: ['dev@dev.example.com', 'opencode models'],
						})
						.mockResolvedValueOnce({
							command: 'ssh',
							args: ['dev@dev.example.com', 'read configs'],
						});
					vi.mocked(execFileNoThrow)
						.mockResolvedValueOnce({
							exitCode: 0,
							stdout: 'cli/model\n',
							stderr: '',
						})
						.mockImplementationOnce(() => new Promise(() => {}) as any);

					const handler = handlers.get('agents:getModels');
					const pending = handler!({} as any, 'opencode', true, 'remote-config-timeout');

					await vi.advanceTimersByTimeAsync(10000);
					const result = await pending;

					expect(result).toEqual(['cli/model']);
				} finally {
					vi.useRealTimers();
				}
			});

			it('returns empty remote models when model discovery times out', async () => {
				vi.useFakeTimers();
				try {
					mockSettingsStore.get.mockReturnValue([
						{ id: 'remote-model-timeout', host: 'dev.example.com', enabled: true },
					]);
					vi.mocked(buildSshCommand).mockResolvedValue({
						command: 'ssh',
						args: ['dev@dev.example.com', 'opencode models'],
					});
					vi.mocked(execFileNoThrow).mockImplementation(() => new Promise(() => {}) as any);

					const handler = handlers.get('agents:getModels');
					const pending = handler!({} as any, 'opencode', true, 'remote-model-timeout');

					await vi.advanceTimersByTimeAsync(10000);
					const result = await pending;

					expect(result).toEqual([]);
				} finally {
					vi.useRealTimers();
				}
			});

			it('rethrows unexpected remote model discovery errors', async () => {
				mockSettingsStore.get.mockReturnValue([
					{ id: 'remote-model-error', host: 'dev.example.com', enabled: true },
				]);
				vi.mocked(buildSshCommand).mockRejectedValue(new Error('ssh builder exploded'));

				const handler = handlers.get('agents:getModels');
				await expect(handler!({} as any, 'opencode', true, 'remote-model-error')).rejects.toThrow(
					'ssh builder exploded'
				);
			});

			it('should throw when SSH remote not found', async () => {
				mockSettingsStore.get.mockReturnValue([
					{ id: 'remote-1', host: 'dev.example.com', enabled: true },
				]);

				const handler = handlers.get('agents:getModels');
				await expect(handler!({} as any, 'opencode', false, 'nonexistent-remote')).rejects.toThrow(
					'SSH remote not found: nonexistent-remote'
				);
				expect(buildSshCommand).not.toHaveBeenCalled();
				expect(mockAgentDetector.discoverModels).not.toHaveBeenCalled();
			});

			it('should fall through to local discovery when no sshRemoteId', async () => {
				const mockModels = ['model-a', 'model-b'];
				mockAgentDetector.discoverModels.mockResolvedValue(mockModels);

				const handler = handlers.get('agents:getModels');
				const result = await handler!({} as any, 'opencode', false);

				expect(mockAgentDetector.discoverModels).toHaveBeenCalledWith('opencode', false);
				expect(result).toEqual(mockModels);
				expect(buildSshCommand).not.toHaveBeenCalled();
			});
		});
	});

	describe('agents:discoverSlashCommands', () => {
		it('should return slash commands for Claude Code', async () => {
			const mockAgent = {
				id: 'claude-code',
				available: true,
				path: '/usr/bin/claude',
				command: 'claude',
			};

			mockAgentDetector.getAgent.mockResolvedValue(mockAgent);

			const initMessage = JSON.stringify({
				type: 'system',
				subtype: 'init',
				slash_commands: ['/help', '/compact', '/clear'],
			});

			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(execFileNoThrow).mockResolvedValue({
				stdout: initMessage + '\n',
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('agents:discoverSlashCommands');
			const result = await handler!({} as any, 'claude-code', '/test/project');

			expect(mockAgentDetector.getAgent).toHaveBeenCalledWith('claude-code');
			expect(execFileNoThrow).toHaveBeenCalledWith(
				'/usr/bin/claude',
				[
					'--print',
					'--verbose',
					'--output-format',
					'stream-json',
					'--dangerously-skip-permissions',
					'--',
					'/help',
				],
				'/test/project'
			);
			expect(result).toEqual([{ name: '/help' }, { name: '/compact' }, { name: '/clear' }]);
		});

		it('enriches Claude skill commands with descriptions from SKILL.md frontmatter', async () => {
			const mockAgent = {
				id: 'claude-code',
				available: true,
				path: '/usr/bin/claude',
				command: 'claude',
			};
			mockAgentDetector.getAgent.mockResolvedValue(mockAgent);

			const initMessage = JSON.stringify({
				type: 'system',
				subtype: 'init',
				slash_commands: ['/Research', '/help'],
			});

			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(execFileNoThrow).mockResolvedValue({
				stdout: initMessage + '\n',
				stderr: '',
				exitCode: 0,
			});

			// Project-level skill directory lists Research; user-level has nothing.
			vi.mocked(fs.promises.readdir).mockImplementation(async (dir: any) => {
				if (String(dir) === '/test/project/.claude/skills') {
					return [{ name: 'Research', isDirectory: () => true }] as any;
				}
				const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
				throw enoent;
			});
			vi.mocked(fs.promises.readFile).mockImplementation(async (filePath: any) => {
				const p = String(filePath);
				// Canonical uppercase SKILL.md is what Claude Code actually writes.
				if (p === '/test/project/.claude/skills/Research/SKILL.md') {
					return '---\nname: Research\ndescription: Deep literature review\n---\n\nBody';
				}
				const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
				throw enoent;
			});

			const handler = handlers.get('agents:discoverSlashCommands');
			const result = await handler!({} as any, 'claude-code', '/test/project');

			expect(result).toEqual([
				{ name: '/Research', description: 'Deep literature review' },
				{ name: '/help' }, // built-in, no skill file → no description
			]);
		});

		it('ignores a "description:" line that appears in the body (not the frontmatter)', async () => {
			const mockAgent = {
				id: 'claude-code',
				available: true,
				path: '/usr/bin/claude',
				command: 'claude',
			};
			mockAgentDetector.getAgent.mockResolvedValue(mockAgent);

			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(execFileNoThrow).mockResolvedValue({
				stdout:
					JSON.stringify({
						type: 'system',
						subtype: 'init',
						slash_commands: ['/Research'],
					}) + '\n',
				stderr: '',
				exitCode: 0,
			});

			vi.mocked(fs.promises.readdir).mockImplementation(async (dir: any) => {
				if (String(dir) === '/test/project/.claude/skills') {
					return [{ name: 'Research', isDirectory: () => true }] as any;
				}
				const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
				throw enoent;
			});
			vi.mocked(fs.promises.readFile).mockImplementation(async (filePath: any) => {
				const p = String(filePath);
				// Frontmatter has no description; body contains a misleading
				// "description:" line that must NOT be picked up.
				if (p === '/test/project/.claude/skills/Research/SKILL.md') {
					return '---\nname: Research\n---\n\nSee description: this is body text.';
				}
				const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
				throw enoent;
			});

			const handler = handlers.get('agents:discoverSlashCommands');
			const result = await handler!({} as any, 'claude-code', '/test/project');

			expect(result).toEqual([{ name: '/Research' }]);
		});

		it('falls back to lowercase skill.md and skips malformed skill frontmatter', async () => {
			const mockAgent = {
				id: 'claude-code',
				available: true,
				path: '/usr/bin/claude',
				command: 'claude',
			};
			mockAgentDetector.getAgent.mockResolvedValue(mockAgent);

			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(execFileNoThrow).mockResolvedValue({
				stdout:
					JSON.stringify({
						type: 'system',
						subtype: 'init',
						slash_commands: ['/Research', '/Plan'],
					}) + '\n',
				stderr: '',
				exitCode: 0,
			});

			vi.mocked(fs.promises.readdir).mockImplementation(async (dir: any) => {
				if (String(dir) === '/test/project/.claude/skills') {
					return [
						{ name: 'Research', isDirectory: () => true },
						{ name: 'notes.txt', isDirectory: () => false },
					] as any;
				}
				if (String(dir).endsWith('/.claude/skills')) {
					return [{ name: 'Plan', isDirectory: () => true }] as any;
				}
				throw Object.assign(new Error('ENOTDIR'), { code: 'ENOTDIR' });
			});
			vi.mocked(fs.promises.readFile).mockImplementation(async (filePath: any) => {
				const p = String(filePath);
				if (p === '/test/project/.claude/skills/Research/SKILL.md') {
					throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
				}
				if (p === '/test/project/.claude/skills/Research/skill.md') {
					return '---\nname: Research\ndescription: "Lowercase fallback"\n---\nBody';
				}
				if (p.endsWith('/.claude/skills/Plan/SKILL.md')) {
					return 'description: body-only description is ignored';
				}
				throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
			});

			const handler = handlers.get('agents:discoverSlashCommands');
			const result = await handler!({} as any, 'claude-code', '/test/project');

			expect(result).toEqual([
				{ name: '/Research', description: 'Lowercase fallback' },
				{ name: '/Plan' },
			]);
		});

		it('ignores duplicate user-level skills and malformed frontmatter without a closing marker', async () => {
			mockAgentDetector.getAgent.mockResolvedValue({
				id: 'claude-code',
				available: true,
				path: '/usr/bin/claude',
				command: 'claude',
			});
			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(execFileNoThrow).mockResolvedValue({
				stdout:
					JSON.stringify({
						type: 'system',
						subtype: 'init',
						slash_commands: ['/Research', '/Plan'],
					}) + '\n',
				stderr: '',
				exitCode: 0,
			});
			vi.mocked(fs.promises.readdir).mockImplementation(async (dir: any) => {
				if (String(dir) === '/test/project/.claude/skills') {
					return [{ name: 'Research', isDirectory: () => true }] as any;
				}
				return [
					{ name: 'Research', isDirectory: () => true },
					{ name: 'Plan', isDirectory: () => true },
				] as any;
			});
			vi.mocked(fs.promises.readFile).mockImplementation(async (filePath: any) => {
				const p = String(filePath);
				if (p === '/test/project/.claude/skills/Research/SKILL.md') {
					return '---\ndescription: Project wins\n---\nBody';
				}
				if (p.endsWith('/.claude/skills/Plan/SKILL.md')) {
					return '---\ndescription: no closing marker';
				}
				throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
			});

			const handler = handlers.get('agents:discoverSlashCommands');
			const result = await handler!({} as any, 'claude-code', '/test/project');

			expect(result).toEqual([
				{ name: '/Research', description: 'Project wins' },
				{ name: '/Plan' },
			]);
		});

		it('falls back to names-only when skill enrichment fails, preserving slash commands', async () => {
			const mockAgent = {
				id: 'claude-code',
				available: true,
				path: '/usr/bin/claude',
				command: 'claude',
			};
			mockAgentDetector.getAgent.mockResolvedValue(mockAgent);

			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(execFileNoThrow).mockResolvedValue({
				stdout:
					JSON.stringify({ type: 'system', subtype: 'init', slash_commands: ['/x', '/y'] }) + '\n',
				stderr: '',
				exitCode: 0,
			});

			// An unexpected failure on the skills dir (e.g. EACCES) should
			// NOT tear down the slash-command list — enrichment is
			// best-effort. The error is still captured by Sentry inside
			// discoverSlashCommands; the list itself survives.
			vi.mocked(fs.promises.readdir).mockImplementation(async () => {
				throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
			});

			const handler = handlers.get('agents:discoverSlashCommands');
			const result = await handler!({} as any, 'claude-code', '/test/project');
			expect(result).toEqual([{ name: '/x' }, { name: '/y' }]);
		});

		it('falls back to names-only when reading a skill file fails unexpectedly', async () => {
			mockAgentDetector.getAgent.mockResolvedValue({
				id: 'claude-code',
				available: true,
				path: '/usr/bin/claude',
				command: 'claude',
			});
			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(execFileNoThrow).mockResolvedValue({
				stdout:
					JSON.stringify({ type: 'system', subtype: 'init', slash_commands: ['/Research'] }) + '\n',
				stderr: '',
				exitCode: 0,
			});
			vi.mocked(fs.promises.readdir).mockResolvedValue([
				{ name: 'Research', isDirectory: () => true },
			] as any);
			vi.mocked(fs.promises.readFile).mockRejectedValue(
				Object.assign(new Error('permission denied'), { code: 'EACCES' })
			);

			const handler = handlers.get('agents:discoverSlashCommands');
			const result = await handler!({} as any, 'claude-code', '/test/project');

			expect(result).toEqual([{ name: '/Research' }]);
		});

		it('should use custom path if provided', async () => {
			const mockAgent = {
				id: 'claude-code',
				available: true,
				path: '/usr/bin/claude',
				command: 'claude',
			};

			mockAgentDetector.getAgent.mockResolvedValue(mockAgent);

			const initMessage = JSON.stringify({
				type: 'system',
				subtype: 'init',
				slash_commands: ['/help'],
			});

			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(execFileNoThrow).mockResolvedValue({
				stdout: initMessage + '\n',
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('agents:discoverSlashCommands');
			await handler!({} as any, 'claude-code', '/test', '/custom/claude');

			expect(execFileNoThrow).toHaveBeenCalledWith('/custom/claude', expect.any(Array), '/test');
		});

		it('falls back to agent.command and preserves slash command names without a leading slash', async () => {
			mockAgentDetector.getAgent.mockResolvedValue({
				id: 'claude-code',
				available: true,
				command: '/usr/bin/claude',
			});
			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(execFileNoThrow).mockResolvedValue({
				stdout:
					JSON.stringify({
						type: 'system',
						subtype: 'init',
						slash_commands: ['help'],
					}) + '\n',
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('agents:discoverSlashCommands');
			const result = await handler!({} as any, 'claude-code', '/test');

			expect(execFileNoThrow).toHaveBeenCalledWith('/usr/bin/claude', expect.any(Array), '/test');
			expect(result).toEqual([{ name: 'help' }]);
		});

		it('should return null for unsupported agents', async () => {
			const mockAgent = {
				id: 'codex',
				available: true,
				path: '/usr/bin/codex',
			};

			mockAgentDetector.getAgent.mockResolvedValue(mockAgent);

			const handler = handlers.get('agents:discoverSlashCommands');
			const result = await handler!({} as any, 'codex', '/test');

			expect(result).toBeNull();
			expect(execFileNoThrow).not.toHaveBeenCalled();
		});

		it('returns Copilot CLI built-in slash commands without spawning the CLI', async () => {
			mockAgentDetector.getAgent.mockResolvedValue({
				id: 'copilot-cli',
				available: true,
				path: '/usr/bin/copilot',
			});

			const handler = handlers.get('agents:discoverSlashCommands');
			const result = await handler!({} as any, 'copilot-cli', '/test');

			expect(result).toEqual(
				expect.arrayContaining([
					{ name: 'help', description: '' },
					{ name: 'model', description: '' },
					{ name: 'review', description: '' },
				])
			);
			expect(execFileNoThrow).not.toHaveBeenCalled();
		});

		it('should return empty array when no custom commands exist for opencode', async () => {
			const mockAgent = {
				id: 'opencode',
				available: true,
				path: '/usr/bin/opencode',
			};

			mockAgentDetector.getAgent.mockResolvedValue(mockAgent);

			// All disk reads return ENOENT (no custom commands)
			const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
			vi.mocked(fs.promises.readdir).mockRejectedValue(enoent);
			vi.mocked(fs.promises.readFile).mockRejectedValue(enoent);

			const handler = handlers.get('agents:discoverSlashCommands');
			const result = await handler!({} as any, 'opencode', '/test');

			// No built-in commands — only custom .md commands are discoverable
			expect(result).toEqual([]);
			expect(execFileNoThrow).not.toHaveBeenCalled();
		});

		it('should discover opencode commands from project .opencode/commands/*.md with prompt content', async () => {
			const mockAgent = {
				id: 'opencode',
				available: true,
				path: '/usr/bin/opencode',
			};

			mockAgentDetector.getAgent.mockResolvedValue(mockAgent);

			const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
			// Project commands dir has custom .md files
			vi.mocked(fs.promises.readdir).mockImplementation(async (dir) => {
				if (String(dir).includes('/test/.opencode/commands')) {
					return ['deploy.md', 'lint.md', 'README.txt'] as any;
				}
				throw enoent;
			});
			vi.mocked(fs.promises.readFile).mockImplementation(async (filePath) => {
				const p = String(filePath);
				if (p.endsWith('deploy.md')) return 'Deploy the application to production';
				if (p.endsWith('lint.md')) return 'Run linting on the codebase';
				throw enoent;
			});

			const handler = handlers.get('agents:discoverSlashCommands');
			const result = await handler!({} as any, 'opencode', '/test');

			const names = result.map((c: any) => c.name);
			expect(names).toContain('deploy');
			expect(names).toContain('lint');
			// Non-.md files should be ignored
			expect(names).not.toContain('README.txt');
			// Custom commands should have prompt content
			const deployCmd = result.find((c: any) => c.name === 'deploy');
			expect(deployCmd.prompt).toBe('Deploy the application to production');
		});

		it('keeps project OpenCode commands over duplicate globals and skips vanished files', async () => {
			const mockAgent = {
				id: 'opencode',
				available: true,
				path: '/usr/bin/opencode',
			};
			mockAgentDetector.getAgent.mockResolvedValue(mockAgent);

			const homeDir = require('os').homedir();
			const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
			vi.mocked(fs.promises.readdir).mockImplementation(async (dir) => {
				const p = String(dir);
				if (p === '/test/.opencode/commands') {
					return ['deploy.md', 'gone.md'] as any;
				}
				if (p === `${homeDir}/.opencode/commands`) {
					return ['deploy.md', 'global.md'] as any;
				}
				throw enoent;
			});
			vi.mocked(fs.promises.readFile).mockImplementation(async (filePath) => {
				const p = String(filePath);
				if (p === '/test/.opencode/commands/deploy.md') {
					return '---\ndescription: missing closing marker';
				}
				if (p === '/test/.opencode/commands/gone.md') {
					throw enoent;
				}
				if (p === `${homeDir}/.opencode/commands/global.md`) {
					return '';
				}
				throw enoent;
			});

			const handler = handlers.get('agents:discoverSlashCommands');
			const result = await handler!({} as any, 'opencode', '/test');

			expect(result).toEqual([
				{ name: 'deploy', prompt: '---\ndescription: missing closing marker' },
				{ name: 'global', prompt: undefined },
			]);
		});

		it('rethrows non-missing OpenCode command file read errors', async () => {
			mockAgentDetector.getAgent.mockResolvedValue({
				id: 'opencode',
				available: true,
				path: '/usr/bin/opencode',
			});
			vi.mocked(fs.promises.readdir).mockImplementation(async (dir) => {
				if (String(dir) === '/test/.opencode/commands') {
					return ['deploy.md'] as any;
				}
				throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
			});
			vi.mocked(fs.promises.readFile).mockRejectedValue(
				Object.assign(new Error('permission denied'), { code: 'EACCES' })
			);

			const handler = handlers.get('agents:discoverSlashCommands');
			await expect(handler!({} as any, 'opencode', '/test')).rejects.toThrow('permission denied');
		});

		it('should discover opencode commands from ~/.opencode/commands/ (home directory)', async () => {
			const mockAgent = {
				id: 'opencode',
				available: true,
				path: '/usr/bin/opencode',
			};

			mockAgentDetector.getAgent.mockResolvedValue(mockAgent);

			const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
			const homeDir = require('os').homedir();
			vi.mocked(fs.promises.readdir).mockImplementation(async (dir) => {
				if (String(dir) === `${homeDir}/.opencode/commands`) {
					return ['octest.md'] as any;
				}
				throw enoent;
			});
			vi.mocked(fs.promises.readFile).mockImplementation(async (filePath) => {
				const p = String(filePath);
				if (p.endsWith('octest.md')) return 'Report your status.';
				throw enoent;
			});

			const handler = handlers.get('agents:discoverSlashCommands');
			const result = await handler!({} as any, 'opencode', '/test');

			const names = result.map((c: any) => c.name);
			expect(names).toContain('octest');
			const octest = result.find((c: any) => c.name === 'octest');
			expect(octest.prompt).toBe('Report your status.');
		});

		it('should strip YAML frontmatter from command .md files', async () => {
			const mockAgent = {
				id: 'opencode',
				available: true,
				path: '/usr/bin/opencode',
			};

			mockAgentDetector.getAgent.mockResolvedValue(mockAgent);

			const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
			vi.mocked(fs.promises.readdir).mockImplementation(async (dir) => {
				if (String(dir).includes('/test/.opencode/commands')) {
					return ['deploy.md'] as any;
				}
				throw enoent;
			});
			vi.mocked(fs.promises.readFile).mockImplementation(async (filePath) => {
				const p = String(filePath);
				if (p.endsWith('deploy.md'))
					return '---\ndescription: Deploy cmd\nagent: build\n---\n\nDeploy the app.';
				throw enoent;
			});

			const handler = handlers.get('agents:discoverSlashCommands');
			const result = await handler!({} as any, 'opencode', '/test');

			const deployCmd = result.find((c: any) => c.name === 'deploy');
			expect(deployCmd.prompt).toBe('Deploy the app.');
		});

		it('should discover opencode commands from opencode.json config', async () => {
			const mockAgent = {
				id: 'opencode',
				available: true,
				path: '/usr/bin/opencode',
			};

			mockAgentDetector.getAgent.mockResolvedValue(mockAgent);

			const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
			vi.mocked(fs.promises.readdir).mockRejectedValue(enoent);
			vi.mocked(fs.promises.readFile).mockImplementation(async (filePath) => {
				if (String(filePath).includes('/test/opencode.json')) {
					return JSON.stringify({ command: { 'my-cmd': { prompt: 'Do the thing' } } });
				}
				throw enoent;
			});

			const handler = handlers.get('agents:discoverSlashCommands');
			const result = await handler!({} as any, 'opencode', '/test');

			const names = result.map((c: any) => c.name);
			expect(names).toContain('my-cmd');
			// Config commands should have prompt content
			const myCmd = result.find((c: any) => c.name === 'my-cmd');
			expect(myCmd.prompt).toBe('Do the thing');
		});

		it('keeps local OpenCode config commands without prompts as names-only commands', async () => {
			mockAgentDetector.getAgent.mockResolvedValue({
				id: 'opencode',
				available: true,
				path: '/usr/bin/opencode',
			});
			const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
			vi.mocked(fs.promises.readdir).mockRejectedValue(enoent);
			vi.mocked(fs.promises.readFile).mockImplementation(async (filePath) => {
				if (String(filePath).includes('/test/opencode.json')) {
					return JSON.stringify({ command: { empty: {} } });
				}
				throw enoent;
			});

			const handler = handlers.get('agents:discoverSlashCommands');
			const result = await handler!({} as any, 'opencode', '/test');

			expect(result).toEqual([{ name: 'empty', prompt: undefined }]);
		});

		it('keeps file-based OpenCode commands over duplicate config commands', async () => {
			mockAgentDetector.getAgent.mockResolvedValue({
				id: 'opencode',
				available: true,
				path: '/usr/bin/opencode',
			});
			const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
			vi.mocked(fs.promises.readdir).mockImplementation(async (dir) => {
				if (String(dir) === '/test/.opencode/commands') {
					return ['deploy.md'] as any;
				}
				throw enoent;
			});
			vi.mocked(fs.promises.readFile).mockImplementation(async (filePath) => {
				const p = String(filePath);
				if (p === '/test/.opencode/commands/deploy.md') {
					return 'File prompt';
				}
				if (p === '/test/opencode.json') {
					return JSON.stringify({
						command: {
							deploy: 'Config duplicate',
							ship: 'Config-only prompt',
						},
					});
				}
				throw enoent;
			});

			const handler = handlers.get('agents:discoverSlashCommands');
			const result = await handler!({} as any, 'opencode', '/test');

			expect(result).toEqual([
				{ name: 'deploy', prompt: 'File prompt' },
				{ name: 'ship', prompt: 'Config-only prompt' },
			]);
		});

		it('should ignore array values in opencode.json command property', async () => {
			const mockAgent = {
				id: 'opencode',
				available: true,
				path: '/usr/bin/opencode',
			};

			mockAgentDetector.getAgent.mockResolvedValue(mockAgent);

			const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
			vi.mocked(fs.promises.readdir).mockRejectedValue(enoent);
			vi.mocked(fs.promises.readFile).mockImplementation(async (filePath) => {
				if (String(filePath).includes('/test/opencode.json')) {
					return JSON.stringify({ command: ['not', 'an', 'object'] });
				}
				throw enoent;
			});

			const handler = handlers.get('agents:discoverSlashCommands');
			const result = await handler!({} as any, 'opencode', '/test');

			// Array config ignored, no built-ins — result should be empty
			expect(result).toEqual([]);
		});

		it('should gracefully handle malformed opencode.json and return empty array', async () => {
			const mockAgent = {
				id: 'opencode',
				available: true,
				path: '/usr/bin/opencode',
			};

			mockAgentDetector.getAgent.mockResolvedValue(mockAgent);

			const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
			vi.mocked(fs.promises.readdir).mockRejectedValue(enoent);
			vi.mocked(fs.promises.readFile).mockImplementation(async (filePath) => {
				if (String(filePath).includes('/test/opencode.json')) {
					return '{ invalid json, }';
				}
				throw enoent;
			});

			const handler = handlers.get('agents:discoverSlashCommands');
			const result = await handler!({} as any, 'opencode', '/test');

			// Malformed JSON skipped gracefully, no built-ins — empty result
			expect(result).toEqual([]);
		});

		it('rethrows non-missing OpenCode config read errors', async () => {
			mockAgentDetector.getAgent.mockResolvedValue({
				id: 'opencode',
				available: true,
				path: '/usr/bin/opencode',
			});
			vi.mocked(fs.promises.readdir).mockRejectedValue(
				Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
			);
			vi.mocked(fs.promises.readFile).mockRejectedValue(
				Object.assign(new Error('permission denied'), { code: 'EACCES' })
			);

			const handler = handlers.get('agents:discoverSlashCommands');
			await expect(handler!({} as any, 'opencode', '/test')).rejects.toThrow('permission denied');
		});

		it('should honor OPENCODE_CONFIG env var for config discovery', async () => {
			const mockAgent = {
				id: 'opencode',
				available: true,
				path: '/usr/bin/opencode',
			};

			mockAgentDetector.getAgent.mockResolvedValue(mockAgent);

			const originalEnv = process.env.OPENCODE_CONFIG;
			process.env.OPENCODE_CONFIG = '/custom/path/opencode.json';

			const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
			vi.mocked(fs.promises.readdir).mockRejectedValue(enoent);
			vi.mocked(fs.promises.readFile).mockImplementation(async (filePath) => {
				if (String(filePath) === '/custom/path/opencode.json') {
					return JSON.stringify({ command: { 'env-cmd': { prompt: 'From env config' } } });
				}
				throw enoent;
			});

			const handler = handlers.get('agents:discoverSlashCommands');
			const result = await handler!({} as any, 'opencode', '/test');

			const envCmd = result.find((c: any) => c.name === 'env-cmd');
			expect(envCmd).toBeDefined();
			expect(envCmd.prompt).toBe('From env config');

			// Restore env
			if (originalEnv === undefined) {
				delete process.env.OPENCODE_CONFIG;
			} else {
				process.env.OPENCODE_CONFIG = originalEnv;
			}
		});

		describe('SSH remote OpenCode slash command discovery', () => {
			let mockSettingsStore: {
				get: ReturnType<typeof vi.fn>;
				set: ReturnType<typeof vi.fn>;
			};

			beforeEach(() => {
				mockSettingsStore = {
					get: vi.fn().mockReturnValue([]),
					set: vi.fn(),
				};

				handlers.clear();
				registerAgentsHandlers({
					...deps,
					settingsStore: mockSettingsStore as any,
				});
			});

			it('discovers remote OpenCode commands from markdown files and config blocks', async () => {
				mockSettingsStore.get.mockReturnValue([
					{
						id: 'remote-slash',
						host: 'dev.example.com',
						user: 'dev',
						enabled: true,
						remoteEnv: { XDG_CONFIG_HOME: '/remote/config' },
					},
				]);

				vi.mocked(buildSshCommand).mockResolvedValue({
					command: 'ssh',
					args: ['dev@dev.example.com', 'read commands'],
				});
				vi.mocked(execFileNoThrow).mockResolvedValue({
					exitCode: 0,
					stdout: [
						'___CMD_FILE_START___ deploy.md',
						'---',
						'description: Deploy command',
						'---',
						'Run deploy',
						'___CMD_FILE_END___',
						'___CMD_FILE_START___ review.md',
						'Review code',
						'___CMD_FILE_END___',
						'___OPENCODE_CONFIG_START___',
						JSON.stringify({
							command: {
								deploy: { prompt: 'Config duplicate should lose to file command' },
								sync: 'Sync workspace',
								fix: { prompt: 'Fix the current failure' },
								empty: {},
							},
						}),
						'___OPENCODE_CONFIG_END___',
					].join('\n'),
					stderr: '',
				});

				const handler = handlers.get('agents:discoverSlashCommands');
				const result = await handler!({} as any, 'opencode', '/repo', undefined, 'remote-slash');

				expect(buildSshCommand).toHaveBeenCalledWith(
					expect.objectContaining({ id: 'remote-slash', host: 'dev.example.com' }),
					expect.objectContaining({ command: 'sh', env: { XDG_CONFIG_HOME: '/remote/config' } })
				);
				expect(result).toEqual([
					{ name: 'deploy', prompt: 'Run deploy' },
					{ name: 'review', prompt: 'Review code' },
					{ name: 'sync', prompt: 'Sync workspace' },
					{ name: 'fix', prompt: 'Fix the current failure' },
					{ name: 'empty', prompt: undefined },
				]);
			});

			it('keeps first remote markdown command and handles empty prompts and unterminated frontmatter', async () => {
				mockSettingsStore.get.mockReturnValue([
					{ id: 'remote-duplicates', host: 'dev.example.com', enabled: true },
				]);
				vi.mocked(buildSshCommand).mockResolvedValue({
					command: 'ssh',
					args: ['dev@dev.example.com', 'read commands'],
				});
				vi.mocked(execFileNoThrow).mockResolvedValue({
					exitCode: 0,
					stdout: [
						'___CMD_FILE_START___ deploy.md',
						'---',
						'description: no closing marker',
						'___CMD_FILE_END___',
						'___CMD_FILE_START___ deploy.md',
						'Duplicate should lose',
						'___CMD_FILE_END___',
						'___CMD_FILE_START___ empty.md',
						'',
						'___CMD_FILE_END___',
					].join('\n'),
					stderr: '',
				});

				const handler = handlers.get('agents:discoverSlashCommands');
				const result = await handler!(
					{} as any,
					'opencode',
					'/repo',
					undefined,
					'remote-duplicates'
				);

				expect(result).toEqual([
					{ name: 'deploy', prompt: '---\ndescription: no closing marker' },
					{ name: 'empty', prompt: undefined },
				]);
			});

			it('parses a remote OpenCode command config block without an end marker', async () => {
				mockSettingsStore.get.mockReturnValue([
					{ id: 'remote-config-command-no-end', host: 'dev.example.com', enabled: true },
				]);
				vi.mocked(buildSshCommand).mockResolvedValue({
					command: 'ssh',
					args: ['dev@dev.example.com', 'read commands'],
				});
				vi.mocked(execFileNoThrow).mockResolvedValue({
					exitCode: 0,
					stdout: [
						'___OPENCODE_CONFIG_START___',
						JSON.stringify({ command: { sync: 'Sync workspace' } }),
					].join('\n'),
					stderr: '',
				});

				const handler = handlers.get('agents:discoverSlashCommands');
				const result = await handler!(
					{} as any,
					'opencode',
					'/repo',
					undefined,
					'remote-config-command-no-end'
				);

				expect(result).toEqual([{ name: 'sync', prompt: 'Sync workspace' }]);
			});

			it('parses partial remote slash command stdout even when SSH exits non-zero', async () => {
				mockSettingsStore.get.mockReturnValue([
					{ id: 'remote-partial', host: 'dev.example.com', enabled: true },
				]);

				vi.mocked(buildSshCommand).mockResolvedValue({
					command: 'ssh',
					args: ['dev@dev.example.com', 'read commands'],
				});
				vi.mocked(execFileNoThrow).mockResolvedValue({
					exitCode: 1,
					stdout: [
						'___CMD_FILE_START___ partial.md',
						'Use whatever was readable',
						'___CMD_FILE_END___',
					].join('\n'),
					stderr: 'permission denied for one config',
				});

				const handler = handlers.get('agents:discoverSlashCommands');
				const result = await handler!({} as any, 'opencode', '/repo', undefined, 'remote-partial');

				expect(result).toEqual([{ name: 'partial', prompt: 'Use whatever was readable' }]);
			});

			it('returns an empty remote command list when SSH fails without stdout', async () => {
				mockSettingsStore.get.mockReturnValue([
					{ id: 'remote-empty', host: 'dev.example.com', enabled: true },
				]);

				vi.mocked(buildSshCommand).mockResolvedValue({
					command: 'ssh',
					args: ['dev@dev.example.com', 'read commands'],
				});
				vi.mocked(execFileNoThrow).mockResolvedValue({
					exitCode: 255,
					stdout: '',
					stderr: 'connection refused',
				});

				const handler = handlers.get('agents:discoverSlashCommands');
				const result = await handler!({} as any, 'opencode', '/repo', undefined, 'remote-empty');

				expect(result).toEqual([]);
			});

			it('ignores empty and malformed remote OpenCode config command blocks', async () => {
				mockSettingsStore.get.mockReturnValue([
					{ id: 'remote-malformed-config', host: 'dev.example.com', enabled: true },
				]);
				vi.mocked(buildSshCommand).mockResolvedValue({
					command: 'ssh',
					args: ['dev@dev.example.com', 'read commands'],
				});
				vi.mocked(execFileNoThrow).mockResolvedValue({
					exitCode: 0,
					stdout: [
						'___OPENCODE_CONFIG_START___',
						'___OPENCODE_CONFIG_END___',
						'___OPENCODE_CONFIG_START___',
						'{ not json',
						'___OPENCODE_CONFIG_END___',
						'___OPENCODE_CONFIG_START___',
						JSON.stringify({ command: ['not', 'an', 'object'] }),
						'___OPENCODE_CONFIG_END___',
					].join('\n'),
					stderr: '',
				});

				const handler = handlers.get('agents:discoverSlashCommands');
				const result = await handler!(
					{} as any,
					'opencode',
					'/repo',
					undefined,
					'remote-malformed-config'
				);

				expect(result).toEqual([]);
			});

			it('returns an empty remote command list when command discovery throws', async () => {
				mockSettingsStore.get.mockReturnValue([
					{ id: 'remote-throws', host: 'dev.example.com', enabled: true },
				]);
				vi.mocked(buildSshCommand).mockRejectedValue(new Error('ssh builder failed'));

				const handler = handlers.get('agents:discoverSlashCommands');
				const result = await handler!({} as any, 'opencode', '/repo', undefined, 'remote-throws');

				expect(result).toEqual([]);
			});

			it('returns an empty remote command list when command discovery times out', async () => {
				vi.useFakeTimers();
				try {
					mockSettingsStore.get.mockReturnValue([
						{ id: 'remote-slash-timeout', host: 'dev.example.com', enabled: true },
					]);
					vi.mocked(buildSshCommand).mockResolvedValue({
						command: 'ssh',
						args: ['dev@dev.example.com', 'read commands'],
					});
					vi.mocked(execFileNoThrow).mockImplementation(() => new Promise(() => {}) as any);

					const handler = handlers.get('agents:discoverSlashCommands');
					const pending = handler!(
						{} as any,
						'opencode',
						'/repo',
						undefined,
						'remote-slash-timeout'
					);

					await vi.advanceTimersByTimeAsync(10000);
					const result = await pending;

					expect(result).toEqual([]);
				} finally {
					vi.useRealTimers();
				}
			});

			it('returns null when a requested remote for OpenCode slash commands is missing', async () => {
				mockSettingsStore.get.mockReturnValue([]);

				const handler = handlers.get('agents:discoverSlashCommands');
				const result = await handler!({} as any, 'opencode', '/repo', undefined, 'missing-remote');

				expect(result).toBeNull();
				expect(buildSshCommand).not.toHaveBeenCalled();
				expect(execFileNoThrow).not.toHaveBeenCalled();
			});
		});

		it('should rethrow non-ENOENT errors for opencode discovery', async () => {
			const mockAgent = {
				id: 'opencode',
				available: true,
				path: '/usr/bin/opencode',
			};

			mockAgentDetector.getAgent.mockResolvedValue(mockAgent);

			// Permission error (not ENOENT)
			const permError = Object.assign(new Error('EACCES'), { code: 'EACCES' });
			vi.mocked(fs.promises.readdir).mockRejectedValue(permError);
			vi.mocked(fs.promises.readFile).mockRejectedValue(
				Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
			);

			const handler = handlers.get('agents:discoverSlashCommands');
			await expect(handler!({} as any, 'opencode', '/test')).rejects.toThrow('EACCES');
		});

		it('should return null when agent is not available', async () => {
			mockAgentDetector.getAgent.mockResolvedValue({ id: 'claude-code', available: false });

			const handler = handlers.get('agents:discoverSlashCommands');
			const result = await handler!({} as any, 'claude-code', '/test');

			expect(result).toBeNull();
		});

		it('should return null when command fails', async () => {
			const mockAgent = {
				id: 'claude-code',
				available: true,
				path: '/usr/bin/claude',
			};

			mockAgentDetector.getAgent.mockResolvedValue(mockAgent);
			vi.mocked(execFileNoThrow).mockResolvedValue({
				stdout: '',
				stderr: 'Error',
				exitCode: 1,
			});

			const handler = handlers.get('agents:discoverSlashCommands');
			const result = await handler!({} as any, 'claude-code', '/test');

			expect(result).toBeNull();
		});

		it('should return null when no init message found in output', async () => {
			const mockAgent = {
				id: 'claude-code',
				available: true,
				path: '/usr/bin/claude',
			};

			mockAgentDetector.getAgent.mockResolvedValue(mockAgent);
			vi.mocked(execFileNoThrow).mockResolvedValue({
				stdout: 'some non-json output\n',
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('agents:discoverSlashCommands');
			const result = await handler!({} as any, 'claude-code', '/test');

			expect(result).toBeNull();
		});

		it('returns null when the Claude command path is missing', async () => {
			mockAgentDetector.getAgent.mockResolvedValue({
				id: 'claude-code',
				available: true,
				path: '/missing/claude',
			});
			vi.mocked(fs.existsSync).mockReturnValue(false);

			const handler = handlers.get('agents:discoverSlashCommands');
			const result = await handler!({} as any, 'claude-code', '/test');

			expect(result).toBeNull();
			expect(execFileNoThrow).not.toHaveBeenCalled();
		});

		it('returns null when Claude slash command discovery throws', async () => {
			mockAgentDetector.getAgent.mockResolvedValue({
				id: 'claude-code',
				available: true,
				path: '/usr/bin/claude',
			});
			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(execFileNoThrow).mockRejectedValue(new Error('spawn failed'));

			const handler = handlers.get('agents:discoverSlashCommands');
			const result = await handler!({} as any, 'claude-code', '/test');

			expect(result).toBeNull();
		});
	});

	describe('error handling', () => {
		it('should throw error when agent detector is not available', async () => {
			// Create deps with null agent detector
			const nullDeps: AgentsHandlerDependencies = {
				getAgentDetector: () => null,
				agentConfigsStore: mockAgentConfigsStore as any,
			};

			// Re-register handlers with null detector
			handlers.clear();
			registerAgentsHandlers(nullDeps);

			const handler = handlers.get('agents:detect');

			await expect(handler!({} as any)).rejects.toThrow('Agent detector');
		});
	});

	describe('agents:getClaudeUsageSnapshots', () => {
		it('returns the full snapshot map from claudeUsageStore', async () => {
			const claudeUsageStore = await import('../../../../main/stores/claudeUsageStore');
			const getAllSpy = vi.spyOn(claudeUsageStore, 'getAllSnapshots').mockReturnValue({
				'/Users/me/.claude': {
					sampledAt: '2026-05-15T00:00:00.000Z',
					configDirKey: '/Users/me/.claude',
					session: { percent: 42, resetsAt: '2026-05-15T05:00:00.000Z' },
					weekAllModels: { percent: 7, resetsAt: '2026-05-22T00:00:00.000Z' },
					weekSonnetOnly: { percent: 3, resetsAt: '2026-05-22T00:00:00.000Z' },
				},
			});

			const handler = handlers.get('agents:getClaudeUsageSnapshots')!;
			const result = await handler({} as any);

			expect(getAllSpy).toHaveBeenCalled();
			expect(result).toHaveProperty('/Users/me/.claude');
			expect(result['/Users/me/.claude'].session.percent).toBe(42);
			getAllSpy.mockRestore();
		});

		it('returns an empty object when no snapshots are cached', async () => {
			const claudeUsageStore = await import('../../../../main/stores/claudeUsageStore');
			const getAllSpy = vi.spyOn(claudeUsageStore, 'getAllSnapshots').mockReturnValue({});

			const handler = handlers.get('agents:getClaudeUsageSnapshots')!;
			const result = await handler({} as any);

			expect(result).toEqual({});
			getAllSpy.mockRestore();
		});
	});

	describe('capability and usage bridge handlers', () => {
		it('returns a single capability snapshot and the full snapshot map', async () => {
			const { capabilitySnapshots } = await import('../../../../main/agents/capability-snapshot');
			capabilitySnapshots.__resetForTests();
			capabilitySnapshots.markOk('claude-code', { path: '/usr/bin/claude' }, 'remote-1');

			const getSnapshot = handlers.get('agents:getSnapshot')!;
			const getAllSnapshots = handlers.get('agents:getAllSnapshots')!;

			const snapshot = await getSnapshot({} as any, 'claude-code', 'remote-1');
			const allSnapshots = await getAllSnapshots({} as any);

			expect(snapshot).toMatchObject({ status: 'ok', path: '/usr/bin/claude' });
			expect(Object.values(allSnapshots)).toEqual([
				expect.objectContaining({ status: 'ok', path: '/usr/bin/claude' }),
			]);

			capabilitySnapshots.__resetForTests();
		});

		it('returns null when a capability snapshot is missing', async () => {
			const { capabilitySnapshots } = await import('../../../../main/agents/capability-snapshot');
			capabilitySnapshots.__resetForTests();

			const handler = handlers.get('agents:getSnapshot')!;
			const result = await handler({} as any, 'claude-code', 'missing-remote');

			expect(result).toBeNull();
		});

		it('returns the auto-detected maestro-p binary path', async () => {
			const claudeUsageStartup = await import('../../../../main/agents/claude-usage-startup');
			const pathSpy = vi
				.spyOn(claudeUsageStartup, 'getMaestroPBinPath')
				.mockReturnValue('/usr/local/bin/maestro-p');

			const handler = handlers.get('agents:getMaestroPDetectedPath')!;
			const result = await handler({} as any);

			expect(result).toBe('/usr/local/bin/maestro-p');
			pathSpy.mockRestore();
		});

		it('checks remote maestro-p availability through force and cached probe paths', async () => {
			const probeModule = await import('../../../../main/agents/probeRemoteMaestroP');
			const probeSpy = vi.spyOn(probeModule, 'probeRemoteMaestroP').mockResolvedValue(true);
			const ensureSpy = vi
				.spyOn(probeModule, 'ensureRemoteMaestroPProbed')
				.mockResolvedValue(false);
			const settingsStore = {
				get: vi
					.fn()
					.mockReturnValue([{ id: 'remote-maestro-p', host: 'dev.example.com', enabled: true }]),
				set: vi.fn(),
			};

			handlers.clear();
			registerAgentsHandlers({
				...deps,
				settingsStore: settingsStore as any,
			});

			const handler = handlers.get('agents:getRemoteMaestroPAvailable')!;

			await expect(handler({} as any)).resolves.toBeNull();
			await expect(handler({} as any, 'missing-remote')).resolves.toBeNull();
			await expect(handler({} as any, 'remote-maestro-p', true)).resolves.toBe(true);
			await expect(handler({} as any, 'remote-maestro-p', false)).resolves.toBe(false);

			expect(probeSpy).toHaveBeenCalledWith(expect.objectContaining({ id: 'remote-maestro-p' }));
			expect(ensureSpy).toHaveBeenCalledWith(expect.objectContaining({ id: 'remote-maestro-p' }));

			probeSpy.mockRestore();
			ensureSpy.mockRestore();
		});

		it('returns null when remote maestro-p force and cached probes are indeterminate', async () => {
			const probeModule = await import('../../../../main/agents/probeRemoteMaestroP');
			const probeSpy = vi.spyOn(probeModule, 'probeRemoteMaestroP').mockResolvedValue(undefined);
			const ensureSpy = vi
				.spyOn(probeModule, 'ensureRemoteMaestroPProbed')
				.mockResolvedValue(undefined);
			const settingsStore = {
				get: vi
					.fn()
					.mockReturnValue([
						{ id: 'remote-maestro-p-unknown', host: 'dev.example.com', enabled: true },
					]),
				set: vi.fn(),
			};

			handlers.clear();
			registerAgentsHandlers({
				...deps,
				settingsStore: settingsStore as any,
			});

			const handler = handlers.get('agents:getRemoteMaestroPAvailable')!;

			await expect(handler({} as any, 'remote-maestro-p-unknown', true)).resolves.toBeNull();
			await expect(handler({} as any, 'remote-maestro-p-unknown', false)).resolves.toBeNull();

			probeSpy.mockRestore();
			ensureSpy.mockRestore();
		});

		it('reprobes local agents through detector cache clearing', async () => {
			const { capabilitySnapshots } = await import('../../../../main/agents/capability-snapshot');
			capabilitySnapshots.__resetForTests();
			(mockAgentDetector as any).clearModelCache = vi.fn();
			mockAgentDetector.detectAgents.mockResolvedValue([]);

			const handler = handlers.get('agents:reprobe')!;
			const result = await handler({} as any, 'claude-code');

			expect(mockAgentDetector.clearCache).toHaveBeenCalled();
			expect((mockAgentDetector as any).clearModelCache).toHaveBeenCalledWith('claude-code');
			expect(mockAgentDetector.detectAgents).toHaveBeenCalled();
			expect(result).toMatchObject({ status: 'probing' });

			capabilitySnapshots.__resetForTests();
		});

		it('returns null when reprobe cannot find a snapshot for an unknown local agent', async () => {
			const { capabilitySnapshots } = await import('../../../../main/agents/capability-snapshot');
			capabilitySnapshots.__resetForTests();
			(mockAgentDetector as any).clearModelCache = vi.fn();
			mockAgentDetector.detectAgents.mockResolvedValue([]);
			const getSpy = vi.spyOn(capabilitySnapshots, 'get').mockReturnValue(undefined);

			const handler = handlers.get('agents:reprobe')!;
			const result = await handler({} as any, 'unknown-agent');

			expect(result).toBeNull();
			getSpy.mockRestore();
			capabilitySnapshots.__resetForTests();
		});

		it('returns null for terminal reprobe and records missing remote reprobe failures', async () => {
			const { capabilitySnapshots } = await import('../../../../main/agents/capability-snapshot');
			capabilitySnapshots.__resetForTests();
			const settingsStore = { get: vi.fn().mockReturnValue([]), set: vi.fn() };
			handlers.clear();
			registerAgentsHandlers({
				...deps,
				settingsStore: settingsStore as any,
			});

			const handler = handlers.get('agents:reprobe')!;

			await expect(handler({} as any, 'terminal')).resolves.toBeNull();
			const result = await handler({} as any, 'claude-code', 'missing-remote');

			expect(result).toMatchObject({
				status: 'failed',
				lastError: 'SSH remote not found: missing-remote',
			});

			capabilitySnapshots.__resetForTests();
		});

		it('returns null when missing-remote reprobe cannot read back the failure snapshot', async () => {
			const { capabilitySnapshots } = await import('../../../../main/agents/capability-snapshot');
			capabilitySnapshots.__resetForTests();
			const settingsStore = { get: vi.fn().mockReturnValue([]), set: vi.fn() };
			handlers.clear();
			registerAgentsHandlers({
				...deps,
				settingsStore: settingsStore as any,
			});
			const getSpy = vi.spyOn(capabilitySnapshots, 'get').mockReturnValue(undefined);

			const handler = handlers.get('agents:reprobe')!;
			const result = await handler({} as any, 'claude-code', 'missing-remote');

			expect(result).toBeNull();
			getSpy.mockRestore();
			capabilitySnapshots.__resetForTests();
		});

		it('returns null when remote reprobe cannot find a snapshot for an unknown agent', async () => {
			const { capabilitySnapshots } = await import('../../../../main/agents/capability-snapshot');
			capabilitySnapshots.__resetForTests();
			const settingsStore = {
				get: vi
					.fn()
					.mockReturnValue([
						{ id: 'remote-unknown-reprobe', host: 'dev.example.com', enabled: true },
					]),
				set: vi.fn(),
			};
			handlers.clear();
			registerAgentsHandlers({
				...deps,
				settingsStore: settingsStore as any,
			});
			vi.mocked(buildSshCommand).mockResolvedValue({
				command: 'ssh',
				args: ['dev.example.com', 'command -v agent'],
			});
			vi.mocked(execFileNoThrow).mockResolvedValue({
				exitCode: 1,
				stdout: '',
				stderr: '',
			});
			const getSpy = vi.spyOn(capabilitySnapshots, 'get').mockReturnValue(undefined);

			const handler = handlers.get('agents:reprobe')!;
			const result = await handler({} as any, 'unknown-agent', 'remote-unknown-reprobe');

			expect(result).toBeNull();
			getSpy.mockRestore();
			capabilitySnapshots.__resetForTests();
		});

		it('reprobes a configured remote and returns the requested remote snapshot', async () => {
			const { capabilitySnapshots } = await import('../../../../main/agents/capability-snapshot');
			capabilitySnapshots.__resetForTests();
			const settingsStore = {
				get: vi
					.fn()
					.mockReturnValue([{ id: 'remote-reprobe', host: 'dev.example.com', enabled: true }]),
				set: vi.fn(),
			};
			handlers.clear();
			registerAgentsHandlers({
				...deps,
				settingsStore: settingsStore as any,
			});
			vi.mocked(buildSshCommand).mockResolvedValue({
				command: 'ssh',
				args: ['dev.example.com', 'command -v agent'],
			});
			vi.mocked(execFileNoThrow).mockResolvedValue({
				exitCode: 1,
				stdout: '',
				stderr: '',
			});

			const handler = handlers.get('agents:reprobe')!;
			const result = await handler({} as any, 'claude-code', 'remote-reprobe');

			expect(result).toMatchObject({ status: 'not_installed' });
			expect(buildSshCommand).toHaveBeenCalled();

			capabilitySnapshots.__resetForTests();
		});

		it('returns Claude and Codex usage account keys from discovered homes', async () => {
			const claudeUsageStartup = await import('../../../../main/agents/claude-usage-startup');
			const codexUsageStartup = await import('../../../../main/agents/codex-usage-startup');
			const claudeSpy = vi
				.spyOn(claudeUsageStartup, 'discoverClaudeConfigDirs')
				.mockResolvedValue(['/tmp/claude-a', '/tmp/claude-b']);
			const codexSpy = vi
				.spyOn(codexUsageStartup, 'discoverCodexHomes')
				.mockResolvedValue(['/tmp/codex-a']);

			const getClaudeKeys = handlers.get('agents:getClaudeUsageAccountKeys')!;
			const getCodexKeys = handlers.get('agents:getCodexUsageAccountKeys')!;

			await expect(getClaudeKeys({} as any)).resolves.toEqual(['/tmp/claude-a', '/tmp/claude-b']);
			await expect(getCodexKeys({} as any)).resolves.toEqual(['/tmp/codex-a']);

			claudeSpy.mockRestore();
			codexSpy.mockRestore();
		});

		it('returns the cached Codex usage snapshot map', async () => {
			const codexUsageStore = await import('../../../../main/stores/codexUsageStore');
			const getAllSpy = vi.spyOn(codexUsageStore, 'getAllCodexUsageSnapshots').mockReturnValue({
				'/Users/me/.codex': {
					sampledAt: '2026-05-15T00:00:00.000Z',
					codexHomeKey: '/Users/me/.codex',
					authState: 'authenticated',
					session: { percent: 64, resetsAt: '2026-05-15T05:00:00.000Z' },
				},
			});

			const handler = handlers.get('agents:getCodexUsageSnapshots')!;
			const result = await handler({} as any);

			expect(result['/Users/me/.codex'].session?.percent).toBe(64);
			getAllSpy.mockRestore();
		});
	});

	describe('claude:usage:refresh-all', () => {
		it('delegates to runStartupUsageSampling and returns the snapshot count', async () => {
			const claudeUsageStartup = await import('../../../../main/agents/claude-usage-startup');
			const claudeUsageStore = await import('../../../../main/stores/claudeUsageStore');

			const runSpy = vi
				.spyOn(claudeUsageStartup, 'runStartupUsageSampling')
				.mockResolvedValue(undefined);
			const getAllSpy = vi.spyOn(claudeUsageStore, 'getAllSnapshots').mockReturnValue({
				'/Users/me/.claude': {
					sampledAt: '2026-05-15T00:00:00.000Z',
					configDirKey: '/Users/me/.claude',
					session: { percent: 50, resetsAt: '2026-05-15T05:00:00.000Z' },
					weekAllModels: { percent: 7, resetsAt: '2026-05-22T00:00:00.000Z' },
					weekSonnetOnly: { percent: 3, resetsAt: '2026-05-22T00:00:00.000Z' },
				},
				'/Users/me/.claude-gmail': {
					sampledAt: '2026-05-15T00:00:00.000Z',
					configDirKey: '/Users/me/.claude-gmail',
					session: { percent: 20, resetsAt: '2026-05-15T05:00:00.000Z' },
					weekAllModels: { percent: 5, resetsAt: '2026-05-22T00:00:00.000Z' },
					weekSonnetOnly: { percent: 1, resetsAt: '2026-05-22T00:00:00.000Z' },
				},
			});

			// Re-register with the full dep set so the handler can delegate.
			handlers.clear();
			vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
				handlers.set(channel, handler);
			});
			registerAgentsHandlers({
				getAgentDetector: () => mockAgentDetector as any,
				agentConfigsStore: mockAgentConfigsStore as any,
				settingsStore: { get: vi.fn(), set: vi.fn() } as any,
				sessionsStore: { get: vi.fn(), set: vi.fn() } as any,
			});

			const handler = handlers.get('claude:usage:refresh-all')!;
			const result = await handler({} as any);

			expect(runSpy).toHaveBeenCalledTimes(1);
			// Manual refresh must opt into the aggressive sampling path — startup
			// mode would skip when no maestro-p session exists.
			expect(runSpy).toHaveBeenCalledWith(expect.objectContaining({ mode: 'manual' }));
			expect(result).toEqual({ refreshed: 2 });

			runSpy.mockRestore();
			getAllSpy.mockRestore();
		});

		it('returns refreshed: 0 without throwing when sessionsStore is missing', async () => {
			const claudeUsageStartup = await import('../../../../main/agents/claude-usage-startup');
			const runSpy = vi
				.spyOn(claudeUsageStartup, 'runStartupUsageSampling')
				.mockResolvedValue(undefined);

			// The default beforeEach() wires deps WITHOUT sessionsStore/settingsStore,
			// so the registered handler should fall back to the no-op path.
			const handler = handlers.get('claude:usage:refresh-all')!;
			const result = await handler({} as any);

			expect(runSpy).not.toHaveBeenCalled();
			expect(result).toEqual({ refreshed: 0 });

			runSpy.mockRestore();
		});
	});

	describe('codex:usage:refresh-all', () => {
		it('delegates to runCodexUsageSampling and returns the snapshot count', async () => {
			const codexUsageStartup = await import('../../../../main/agents/codex-usage-startup');
			const codexUsageStore = await import('../../../../main/stores/codexUsageStore');

			const runSpy = vi
				.spyOn(codexUsageStartup, 'runCodexUsageSampling')
				.mockResolvedValue(undefined);
			const getAllSpy = vi.spyOn(codexUsageStore, 'getAllCodexUsageSnapshots').mockReturnValue({
				'/Users/me/.codex': {
					sampledAt: '2026-05-15T00:00:00.000Z',
					codexHomeKey: '/Users/me/.codex',
					authState: 'authenticated',
					session: { percent: 50, resetsAt: '2026-05-15T05:00:00.000Z' },
				},
			});

			handlers.clear();
			vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
				handlers.set(channel, handler);
			});
			registerAgentsHandlers({
				getAgentDetector: () => mockAgentDetector as any,
				agentConfigsStore: mockAgentConfigsStore as any,
				sessionsStore: { get: vi.fn(), set: vi.fn() } as any,
			});

			const handler = handlers.get('codex:usage:refresh-all')!;
			const result = await handler({} as any);

			expect(runSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionsStore: expect.any(Object),
					agentConfigsStore: mockAgentConfigsStore,
					agentDetector: mockAgentDetector,
				})
			);
			expect(result).toEqual({ refreshed: 1 });

			runSpy.mockRestore();
			getAllSpy.mockRestore();
		});

		it('returns refreshed: 0 without throwing when sessionsStore is missing', async () => {
			const codexUsageStartup = await import('../../../../main/agents/codex-usage-startup');
			const runSpy = vi
				.spyOn(codexUsageStartup, 'runCodexUsageSampling')
				.mockResolvedValue(undefined);

			const handler = handlers.get('codex:usage:refresh-all')!;
			const result = await handler({} as any);

			expect(runSpy).not.toHaveBeenCalled();
			expect(result).toEqual({ refreshed: 0 });

			runSpy.mockRestore();
		});
	});
});
