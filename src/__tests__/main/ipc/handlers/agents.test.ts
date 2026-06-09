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
vi.mock('../../../../main/agents', () => ({
	getAgentCapabilities: vi.fn(),
	AGENT_DEFINITIONS: [
		{ id: 'claude-code', name: 'Claude Code', binaryName: 'claude', configOptions: [] },
		{
			id: 'codex',
			name: 'Codex',
			binaryName: 'codex',
			configOptions: [{ key: 'model', default: 'gpt-5-codex' }, { key: 'approvalMode' }],
		},
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
}));

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
import { logger } from '../../../../main/utils/logger';
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

	function registerWithSshRemotes(remotes: any[]) {
		const settingsStore = {
			get: vi.fn((key: string, defaultValue?: unknown) => {
				if (key === 'sshRemotes') return remotes;
				return defaultValue;
			}),
			set: vi.fn(),
		};

		handlers.clear();
		registerAgentsHandlers({
			...deps,
			settingsStore: settingsStore as any,
		});

		return settingsStore;
	}

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
				'agents:discoverSlashCommands',
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

		it('should return unavailable agents when SSH remote config is missing', async () => {
			registerWithSshRemotes([]);
			vi.mocked(agentCapabilities.getAgentCapabilities).mockImplementation((id) => ({ id }) as any);

			const handler = handlers.get('agents:detect');
			const result = await handler!({} as any, 'missing-remote');

			expect(result).toHaveLength(4);
			expect(result.every((agent: any) => agent.available === false)).toBe(true);
			expect(result[0]).toMatchObject({
				id: 'claude-code',
				path: undefined,
				error: 'SSH remote configuration not found: missing-remote',
			});
			expect(buildSshCommand).not.toHaveBeenCalled();
			expect(mockAgentDetector.detectAgents).not.toHaveBeenCalled();
		});

		it('should return unavailable remote agents when no settings store is registered', async () => {
			vi.mocked(agentCapabilities.getAgentCapabilities).mockImplementation((id) => ({ id }) as any);

			const handler = handlers.get('agents:detect');
			const result = await handler!({} as any, 'missing-store-remote');

			expect(result).toHaveLength(4);
			expect(result.every((agent: any) => agent.available === false)).toBe(true);
			expect(result[0]).toMatchObject({
				id: 'claude-code',
				error: 'SSH remote configuration not found: missing-store-remote',
			});
			expect(logger.warn).toHaveBeenCalledWith(
				'[AgentDetector] Settings store not available for SSH remote lookup',
				'[AgentDetector]'
			);
			expect(buildSshCommand).not.toHaveBeenCalled();
			expect(mockAgentDetector.detectAgents).not.toHaveBeenCalled();
		});

		it('should detect remote agents and preserve per-agent SSH failures', async () => {
			registerWithSshRemotes([
				{
					id: 'remote-1',
					host: 'dev.example.com',
					username: 'dev',
					enabled: false,
				},
			]);
			vi.mocked(agentCapabilities.getAgentCapabilities).mockImplementation((id) => ({ id }) as any);
			vi.mocked(buildSshCommand).mockResolvedValue({ command: 'ssh', args: ['mock'] });
			vi.mocked(execFileNoThrow)
				.mockResolvedValueOnce({
					exitCode: 0,
					stdout: '/usr/bin/claude\n',
					stderr: '',
				})
				.mockResolvedValueOnce({
					exitCode: 1,
					stdout: '',
					stderr: '',
				})
				.mockResolvedValueOnce({
					exitCode: 255,
					stdout: '',
					stderr: 'Permission denied\nextra details',
				})
				.mockRejectedValueOnce(new Error('SSH command failed'));

			const handler = handlers.get('agents:detect');
			const result = await handler!({} as any, 'remote-1');

			expect(result).toHaveLength(4);
			expect(result[0]).toMatchObject({
				id: 'claude-code',
				available: true,
				path: '/usr/bin/claude',
				capabilities: { id: 'claude-code' },
			});
			expect(result[1]).toMatchObject({
				id: 'codex',
				available: false,
				path: undefined,
			});
			expect(result[2]).toMatchObject({
				id: 'opencode',
				available: false,
				error: 'Permission denied',
			});
			expect(result[3]).toMatchObject({
				id: 'terminal',
				available: false,
				error: 'Failed to connect: SSH command failed',
			});
			expect(buildSshCommand).toHaveBeenCalledWith(
				expect.objectContaining({ id: 'remote-1', host: 'dev.example.com' }),
				{ command: 'which', args: ['claude'] }
			);
			expect(mockAgentDetector.detectAgents).not.toHaveBeenCalled();
		});

		it('should summarize remote detection failures when SSH setup throws non-Error values', async () => {
			registerWithSshRemotes([
				{
					id: 'remote-string-error',
					host: 'offline.example.com',
					username: 'dev',
				},
			]);
			vi.mocked(agentCapabilities.getAgentCapabilities).mockImplementation((id) => ({ id }) as any);
			vi.mocked(buildSshCommand).mockRejectedValue('network offline');

			const handler = handlers.get('agents:detect');
			const result = await handler!({} as any, 'remote-string-error');

			expect(result).toHaveLength(4);
			expect(result.every((agent: any) => agent.available === false)).toBe(true);
			expect(result[0]).toMatchObject({
				id: 'claude-code',
				error: 'Failed to connect: network offline',
			});
			expect(logger.error).toHaveBeenCalledWith(
				'Failed to connect to SSH remote offline.example.com: network offline',
				'[AgentDetector]'
			);
		});

		it('should not treat remote command failures as successful SSH connectivity', async () => {
			registerWithSshRemotes([
				{
					id: 'remote-command-failure',
					host: 'dev.example.com',
					username: 'dev',
				},
			]);
			vi.mocked(agentCapabilities.getAgentCapabilities).mockImplementation((id) => ({ id }) as any);
			vi.mocked(buildSshCommand).mockResolvedValue({ command: 'ssh', args: ['mock'] });
			vi.mocked(execFileNoThrow).mockResolvedValue({
				exitCode: 2,
				stdout: '',
				stderr: 'which failed unexpectedly',
			});

			const handler = handlers.get('agents:detect');
			const result = await handler!({} as any, 'remote-command-failure');

			expect(result).toHaveLength(4);
			expect(result.every((agent: any) => agent.available === false)).toBe(true);
			expect(result.every((agent: any) => agent.error === undefined)).toBe(true);
			expect(logger.error).not.toHaveBeenCalled();
		});

		it('should mark remote agents unavailable when SSH detection times out', async () => {
			registerWithSshRemotes([
				{
					id: 'remote-detect-timeout',
					host: 'slow.example.com',
					username: 'dev',
				},
			]);
			vi.mocked(agentCapabilities.getAgentCapabilities).mockImplementation((id) => ({ id }) as any);
			vi.mocked(buildSshCommand).mockResolvedValue({ command: 'ssh', args: ['mock'] });
			vi.mocked(execFileNoThrow).mockReturnValue(new Promise(() => {}) as any);

			vi.useFakeTimers();
			try {
				const handler = handlers.get('agents:detect');
				const resultPromise = handler!({} as any, 'remote-detect-timeout');

				await vi.advanceTimersByTimeAsync(40000);
				const result = await resultPromise;

				expect(result).toHaveLength(4);
				expect(result.every((agent: any) => agent.available === false)).toBe(true);
				expect(result[0]).toMatchObject({
					error: 'Failed to connect: SSH connection timed out after 10s',
				});
				expect(execFileNoThrow).toHaveBeenCalledTimes(4);
			} finally {
				vi.useRealTimers();
			}
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

		it('should return an unavailable agent when SSH remote config is missing', async () => {
			registerWithSshRemotes([]);
			vi.mocked(agentCapabilities.getAgentCapabilities).mockReturnValue({
				supportsResume: false,
			} as any);

			const handler = handlers.get('agents:get');
			const result = await handler!({} as any, 'codex', 'missing-remote');

			expect(result).toMatchObject({
				id: 'codex',
				available: false,
				path: undefined,
				error: 'SSH remote configuration not found: missing-remote',
			});
			expect(buildSshCommand).not.toHaveBeenCalled();
			expect(mockAgentDetector.getAgent).not.toHaveBeenCalled();
		});

		it('should throw for an unknown agent when the SSH remote config is missing', async () => {
			registerWithSshRemotes([]);

			const handler = handlers.get('agents:get');
			await expect(handler!({} as any, 'unknown-agent', 'missing-remote')).rejects.toThrow(
				'Unknown agent: unknown-agent'
			);

			expect(buildSshCommand).not.toHaveBeenCalled();
			expect(mockAgentDetector.getAgent).not.toHaveBeenCalled();
		});

		it('should detect a specific agent over SSH', async () => {
			registerWithSshRemotes([
				{
					id: 'remote-1',
					host: 'dev.example.com',
					username: 'dev',
					enabled: false,
				},
			]);
			vi.mocked(agentCapabilities.getAgentCapabilities).mockReturnValue({
				supportsResume: true,
			} as any);
			vi.mocked(buildSshCommand).mockResolvedValue({
				command: 'ssh',
				args: ['dev@dev.example.com', 'which codex'],
			});
			vi.mocked(execFileNoThrow).mockResolvedValue({
				exitCode: 0,
				stdout: '/opt/bin/codex\n',
				stderr: '',
			});

			const handler = handlers.get('agents:get');
			const result = await handler!({} as any, 'codex', 'remote-1');

			expect(result).toMatchObject({
				id: 'codex',
				available: true,
				path: '/opt/bin/codex',
				capabilities: { supportsResume: true },
			});
			expect(buildSshCommand).toHaveBeenCalledWith(
				expect.objectContaining({ id: 'remote-1', host: 'dev.example.com' }),
				{ command: 'which', args: ['codex'] }
			);
			expect(mockAgentDetector.getAgent).not.toHaveBeenCalled();
		});

		it('should throw for an unknown agent before running remote SSH detection', async () => {
			registerWithSshRemotes([
				{
					id: 'remote-1',
					host: 'dev.example.com',
					username: 'dev',
				},
			]);

			const handler = handlers.get('agents:get');
			await expect(handler!({} as any, 'unknown-agent', 'remote-1')).rejects.toThrow(
				'Unknown agent: unknown-agent'
			);

			expect(buildSshCommand).not.toHaveBeenCalled();
			expect(execFileNoThrow).not.toHaveBeenCalled();
			expect(mockAgentDetector.getAgent).not.toHaveBeenCalled();
		});

		it.each([
			'Connection refused',
			'Connection timed out',
			'No route to host',
			'Could not resolve hostname',
			'Permission denied',
		])('should surface SSH connection stderr for a specific agent: %s', async (stderr) => {
			const remoteId = `remote-${stderr.toLowerCase().replaceAll(' ', '-')}`;
			registerWithSshRemotes([
				{
					id: remoteId,
					host: 'dev.example.com',
					username: 'dev',
				},
			]);
			vi.mocked(agentCapabilities.getAgentCapabilities).mockReturnValue({
				supportsResume: true,
			} as any);
			vi.mocked(buildSshCommand).mockResolvedValue({
				command: 'ssh',
				args: ['dev@dev.example.com', 'which codex'],
			});
			vi.mocked(execFileNoThrow).mockResolvedValue({
				exitCode: 255,
				stdout: '',
				stderr: `${stderr}\nextra details`,
			});

			const handler = handlers.get('agents:get');
			const result = await handler!({} as any, 'codex', remoteId);

			expect(result).toMatchObject({
				id: 'codex',
				available: false,
				path: undefined,
				error: stderr,
			});
			expect(logger.warn).toHaveBeenCalledWith(
				`SSH connection error for dev.example.com: ${stderr}`,
				'[AgentDetector]'
			);
		});

		it('should return an unavailable specific agent when SSH command fails', async () => {
			registerWithSshRemotes([
				{
					id: 'remote-1',
					host: 'dev.example.com',
					username: 'dev',
				},
			]);
			vi.mocked(agentCapabilities.getAgentCapabilities).mockReturnValue({
				supportsResume: true,
			} as any);
			vi.mocked(buildSshCommand).mockRejectedValue(new Error('SSH config invalid'));

			const handler = handlers.get('agents:get');
			const result = await handler!({} as any, 'codex', 'remote-1');

			expect(result).toMatchObject({
				id: 'codex',
				available: false,
				error: 'Failed to connect: SSH config invalid',
			});
			expect(execFileNoThrow).not.toHaveBeenCalled();
		});

		it('should stringify non-Error SSH failures for a specific remote agent', async () => {
			registerWithSshRemotes([
				{
					id: 'remote-string-failure',
					host: 'dev.example.com',
					username: 'dev',
				},
			]);
			vi.mocked(agentCapabilities.getAgentCapabilities).mockReturnValue({
				supportsResume: true,
			} as any);
			vi.mocked(buildSshCommand).mockRejectedValue('ssh refused');

			const handler = handlers.get('agents:get');
			const result = await handler!({} as any, 'codex', 'remote-string-failure');

			expect(result).toMatchObject({
				id: 'codex',
				available: false,
				error: 'Failed to connect: ssh refused',
			});
		});

		it('should return an unavailable specific agent when SSH detection times out', async () => {
			registerWithSshRemotes([
				{
					id: 'remote-get-timeout',
					host: 'slow.example.com',
					username: 'dev',
				},
			]);
			vi.mocked(agentCapabilities.getAgentCapabilities).mockReturnValue({
				supportsResume: true,
			} as any);
			vi.mocked(buildSshCommand).mockResolvedValue({
				command: 'ssh',
				args: ['dev@slow.example.com', 'which codex'],
			});
			vi.mocked(execFileNoThrow).mockReturnValue(new Promise(() => {}) as any);

			vi.useFakeTimers();
			try {
				const handler = handlers.get('agents:get');
				const resultPromise = handler!({} as any, 'codex', 'remote-get-timeout');

				await vi.advanceTimersByTimeAsync(10000);
				const result = await resultPromise;

				expect(result).toMatchObject({
					id: 'codex',
					available: false,
					error: 'Failed to connect: SSH connection timed out after 10s',
				});
			} finally {
				vi.useRealTimers();
			}
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

		it('should use fallback debug info when the requested agent is absent', async () => {
			const originalPath = process.env.PATH;
			const originalHome = process.env.HOME;
			delete process.env.PATH;
			delete process.env.HOME;

			mockAgentDetector.detectAgents.mockResolvedValue([]);
			vi.mocked(execFileNoThrow).mockResolvedValue({
				stdout: '',
				stderr: '',
				exitCode: 1,
			});

			try {
				const handler = handlers.get('agents:refresh');
				const result = await handler!({} as any, 'missing-agent');

				expect(result.debugInfo).toMatchObject({
					agentId: 'missing-agent',
					available: false,
					path: null,
					binaryName: 'missing-agent',
					envPath: '',
					homeDir: '',
				});
				expect(result.debugInfo.error).toContain('Binary not found in PATH');
				expect(execFileNoThrow).toHaveBeenCalledWith(expect.any(String), ['missing-agent']);
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

		it('should leave debug error empty when a manual lookup succeeds for an unavailable agent', async () => {
			mockAgentDetector.detectAgents.mockResolvedValue([
				{ id: 'codex', name: 'Codex', available: false, binaryName: 'codex' },
			]);
			vi.mocked(execFileNoThrow).mockResolvedValue({
				stdout: '/usr/local/bin/codex\n',
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('agents:refresh');
			const result = await handler!({} as any, 'codex');

			expect(result.debugInfo).toMatchObject({
				agentId: 'codex',
				available: false,
				binaryName: 'codex',
				error: null,
			});
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

		it('should merge agent config defaults with stored values', async () => {
			mockAgentConfigsStore.get.mockReturnValue({
				codex: { model: 'gpt-5.1-codex', sandboxMode: 'workspace-write' },
			});

			const handler = handlers.get('agents:getConfig');
			const result = await handler!({} as any, 'codex');

			expect(result).toEqual({
				model: 'gpt-5.1-codex',
				sandboxMode: 'workspace-write',
			});
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

		it('should fall back to default agent config values when a key is not stored', async () => {
			mockAgentConfigsStore.get.mockReturnValue({
				codex: {},
			});

			const handler = handlers.get('agents:getConfigValue');
			const result = await handler!({} as any, 'codex', 'model');

			expect(result).toBe('gpt-5-codex');
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

			it('should reuse cached remote models when forceRefresh is false', async () => {
				mockSettingsStore.get.mockReturnValue([
					{
						id: 'remote-cache-edge',
						host: 'cache.example.com',
						username: 'dev',
					},
				]);
				vi.mocked(buildSshCommand).mockResolvedValue({
					command: 'ssh',
					args: ['dev@cache.example.com', 'opencode models'],
				});
				vi.mocked(execFileNoThrow).mockResolvedValue({
					exitCode: 0,
					stdout: 'model-a\nmodel-b\n',
					stderr: '',
				});

				const handler = handlers.get('agents:getModels');
				const first = await handler!({} as any, 'opencode', true, 'remote-cache-edge');
				const second = await handler!({} as any, 'opencode', false, 'remote-cache-edge');

				expect(first).toEqual(['model-a', 'model-b']);
				expect(second).toEqual(['model-a', 'model-b']);
				expect(buildSshCommand).toHaveBeenCalledTimes(1);
				expect(execFileNoThrow).toHaveBeenCalledTimes(1);
			});

			it('should return empty remote models for unknown agents', async () => {
				mockSettingsStore.get.mockReturnValue([
					{
						id: 'remote-unknown-agent',
						host: 'dev.example.com',
						username: 'dev',
					},
				]);

				const handler = handlers.get('agents:getModels');
				const result = await handler!({} as any, 'unknown-agent', false, 'remote-unknown-agent');

				expect(result).toEqual([]);
				expect(buildSshCommand).not.toHaveBeenCalled();
				expect(execFileNoThrow).not.toHaveBeenCalled();
			});

			it('should return empty remote models when the remote command exits non-zero', async () => {
				mockSettingsStore.get.mockReturnValue([
					{
						id: 'remote-nonzero',
						host: 'dev.example.com',
						username: 'dev',
					},
				]);
				vi.mocked(buildSshCommand).mockResolvedValue({
					command: 'ssh',
					args: ['dev@dev.example.com', 'opencode models'],
				});
				vi.mocked(execFileNoThrow).mockResolvedValue({
					exitCode: 2,
					stdout: '',
					stderr: 'models unavailable',
				});

				const handler = handlers.get('agents:getModels');
				const result = await handler!({} as any, 'opencode', false, 'remote-nonzero');

				expect(result).toEqual([]);
			});

			it('should return empty remote models when model discovery times out', async () => {
				mockSettingsStore.get.mockReturnValue([
					{
						id: 'remote-timeout',
						host: 'slow.example.com',
						username: 'dev',
					},
				]);
				vi.mocked(buildSshCommand).mockRejectedValue(
					new Error('SSH model discovery timed out after 10s')
				);

				const handler = handlers.get('agents:getModels');
				const result = await handler!({} as any, 'opencode', false, 'remote-timeout');

				expect(result).toEqual([]);
			});

			it('should time out pending SSH model discovery and default forceRefresh to false', async () => {
				mockSettingsStore.get.mockReturnValue([
					{
						id: 'remote-model-race-timeout',
						host: 'slow-models.example.com',
						username: 'dev',
					},
				]);
				vi.mocked(buildSshCommand).mockResolvedValue({
					command: 'ssh',
					args: ['dev@slow-models.example.com', 'opencode models'],
				});
				vi.mocked(execFileNoThrow).mockReturnValue(new Promise(() => {}) as any);

				vi.useFakeTimers();
				try {
					const handler = handlers.get('agents:getModels');
					const resultPromise = handler!(
						{} as any,
						'opencode',
						undefined,
						'remote-model-race-timeout'
					);

					await vi.advanceTimersByTimeAsync(10000);
					const result = await resultPromise;

					expect(result).toEqual([]);
					expect(buildSshCommand).toHaveBeenCalledWith(
						expect.objectContaining({ id: 'remote-model-race-timeout' }),
						expect.objectContaining({ command: 'opencode', args: ['models'] })
					);
				} finally {
					vi.useRealTimers();
				}
			});

			it('should throw unexpected remote model discovery errors', async () => {
				mockSettingsStore.get.mockReturnValue([
					{
						id: 'remote-error',
						host: 'broken.example.com',
						username: 'dev',
					},
				]);
				vi.mocked(buildSshCommand).mockRejectedValue(new Error('SSH config invalid'));

				const handler = handlers.get('agents:getModels');
				await expect(handler!({} as any, 'opencode', false, 'remote-error')).rejects.toThrow(
					'SSH config invalid'
				);
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
			expect(result).toEqual(['/help', '/compact', '/clear']);
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

		it('should fall back to the agent command when no custom or detected path exists', async () => {
			const mockAgent = {
				id: 'claude-code',
				available: true,
				command: 'claude',
			};

			mockAgentDetector.getAgent.mockResolvedValue(mockAgent);
			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(execFileNoThrow).mockResolvedValue({
				stdout:
					JSON.stringify({
						type: 'system',
						subtype: 'init',
						slash_commands: ['/help'],
					}) + '\n',
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('agents:discoverSlashCommands');
			const result = await handler!({} as any, 'claude-code', '/test');

			expect(result).toEqual(['/help']);
			expect(fs.existsSync).toHaveBeenCalledWith('claude');
			expect(execFileNoThrow).toHaveBeenCalledWith('claude', expect.any(Array), '/test');
		});

		it('should return null for non-Claude Code agents', async () => {
			const mockAgent = {
				id: 'opencode',
				available: true,
				path: '/usr/bin/opencode',
			};

			mockAgentDetector.getAgent.mockResolvedValue(mockAgent);

			const handler = handlers.get('agents:discoverSlashCommands');
			const result = await handler!({} as any, 'opencode', '/test');

			expect(result).toBeNull();
			expect(execFileNoThrow).not.toHaveBeenCalled();
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
			vi.mocked(fs.existsSync).mockReturnValue(true);
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
			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(execFileNoThrow).mockResolvedValue({
				stdout: 'some non-json output\n',
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('agents:discoverSlashCommands');
			const result = await handler!({} as any, 'claude-code', '/test');

			expect(result).toBeNull();
		});

		it('should return null when the command path does not exist', async () => {
			const mockAgent = {
				id: 'claude-code',
				available: true,
				path: '/missing/claude',
			};

			mockAgentDetector.getAgent.mockResolvedValue(mockAgent);
			vi.mocked(fs.existsSync).mockReturnValue(false);

			const handler = handlers.get('agents:discoverSlashCommands');
			const result = await handler!({} as any, 'claude-code', '/test');

			expect(result).toBeNull();
			expect(execFileNoThrow).not.toHaveBeenCalled();
		});

		it('should return null when slash command discovery throws unexpectedly', async () => {
			const mockAgent = {
				id: 'claude-code',
				available: true,
				path: '/usr/bin/claude',
			};

			mockAgentDetector.getAgent.mockResolvedValue(mockAgent);
			vi.mocked(fs.existsSync).mockImplementation(() => {
				throw new Error('stat failed');
			});

			const handler = handlers.get('agents:discoverSlashCommands');
			const result = await handler!({} as any, 'claude-code', '/test');

			expect(result).toBeNull();
			expect(execFileNoThrow).not.toHaveBeenCalled();
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
});
