/**
 * Tests for agents preload API
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock electron ipcRenderer
const mockInvoke = vi.fn();

vi.mock('electron', () => ({
	ipcRenderer: {
		invoke: (...args: unknown[]) => mockInvoke(...args),
	},
}));

import { createAgentsApi } from '../../../main/preload/agents';

describe('Agents Preload API', () => {
	let api: ReturnType<typeof createAgentsApi>;

	beforeEach(() => {
		vi.clearAllMocks();
		api = createAgentsApi();
	});

	describe('detect', () => {
		it('should invoke agents:detect', async () => {
			const mockAgents = [
				{
					id: 'claude-code',
					name: 'Claude Code',
					command: 'claude',
					available: true,
					path: '/usr/local/bin/claude',
				},
			];
			mockInvoke.mockResolvedValue(mockAgents);

			const result = await api.detect();

			expect(mockInvoke).toHaveBeenCalledWith('agents:detect', undefined);
			expect(result).toEqual(mockAgents);
		});

		it('should invoke agents:detect with SSH remote', async () => {
			mockInvoke.mockResolvedValue([]);

			await api.detect('remote-1');

			expect(mockInvoke).toHaveBeenCalledWith('agents:detect', 'remote-1');
		});
	});

	describe('refresh', () => {
		it('should invoke agents:refresh without parameters', async () => {
			const mockResult = { agents: [], debugInfo: {} };
			mockInvoke.mockResolvedValue(mockResult);

			const result = await api.refresh();

			expect(mockInvoke).toHaveBeenCalledWith('agents:refresh', undefined, undefined);
			expect(result).toEqual(mockResult);
		});

		it('should invoke agents:refresh with agentId', async () => {
			mockInvoke.mockResolvedValue({ agents: [], debugInfo: {} });

			await api.refresh('claude-code');

			expect(mockInvoke).toHaveBeenCalledWith('agents:refresh', 'claude-code', undefined);
		});

		it('should invoke agents:refresh with SSH remote', async () => {
			mockInvoke.mockResolvedValue({ agents: [], debugInfo: {} });

			await api.refresh(undefined, 'remote-1');

			expect(mockInvoke).toHaveBeenCalledWith('agents:refresh', undefined, 'remote-1');
		});
	});

	describe('get', () => {
		it('should invoke agents:get with agentId', async () => {
			const mockAgent = {
				id: 'claude-code',
				name: 'Claude Code',
				command: 'claude',
				available: true,
			};
			mockInvoke.mockResolvedValue(mockAgent);

			const result = await api.get('claude-code');

			expect(mockInvoke).toHaveBeenCalledWith('agents:get', 'claude-code');
			expect(result).toEqual(mockAgent);
		});

		it('should return null for non-existent agent', async () => {
			mockInvoke.mockResolvedValue(null);

			const result = await api.get('nonexistent');

			expect(result).toBeNull();
		});
	});

	describe('getCapabilities', () => {
		it('should invoke agents:getCapabilities with agentId', async () => {
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
				supportsModelSelection: false,
				supportsStreamJsonInput: true,
			};
			mockInvoke.mockResolvedValue(mockCapabilities);

			const result = await api.getCapabilities('claude-code');

			expect(mockInvoke).toHaveBeenCalledWith('agents:getCapabilities', 'claude-code');
			expect(result).toEqual(mockCapabilities);
		});
	});

	describe('getConfig', () => {
		it('should invoke agents:getConfig with agentId', async () => {
			const mockConfig = { theme: 'dark', autoSave: true };
			mockInvoke.mockResolvedValue(mockConfig);

			const result = await api.getConfig('claude-code');

			expect(mockInvoke).toHaveBeenCalledWith('agents:getConfig', 'claude-code');
			expect(result).toEqual(mockConfig);
		});
	});

	describe('setConfig', () => {
		it('should invoke agents:setConfig with agentId and config', async () => {
			mockInvoke.mockResolvedValue(true);

			const result = await api.setConfig('claude-code', { theme: 'light' });

			expect(mockInvoke).toHaveBeenCalledWith('agents:setConfig', 'claude-code', {
				theme: 'light',
			});
			expect(result).toBe(true);
		});
	});

	describe('getConfigValue', () => {
		it('should invoke agents:getConfigValue with agentId and key', async () => {
			mockInvoke.mockResolvedValue('dark');

			const result = await api.getConfigValue('claude-code', 'theme');

			expect(mockInvoke).toHaveBeenCalledWith('agents:getConfigValue', 'claude-code', 'theme');
			expect(result).toBe('dark');
		});
	});

	describe('setConfigValue', () => {
		it('should invoke agents:setConfigValue with agentId, key, and value', async () => {
			mockInvoke.mockResolvedValue(true);

			const result = await api.setConfigValue('claude-code', 'theme', 'light');

			expect(mockInvoke).toHaveBeenCalledWith(
				'agents:setConfigValue',
				'claude-code',
				'theme',
				'light'
			);
			expect(result).toBe(true);
		});
	});

	describe('setCustomPath', () => {
		it('should invoke agents:setCustomPath with agentId and customPath', async () => {
			mockInvoke.mockResolvedValue(true);

			const result = await api.setCustomPath('claude-code', '/custom/path/claude');

			expect(mockInvoke).toHaveBeenCalledWith(
				'agents:setCustomPath',
				'claude-code',
				'/custom/path/claude'
			);
			expect(result).toBe(true);
		});

		it('should invoke agents:setCustomPath with null to clear', async () => {
			mockInvoke.mockResolvedValue(true);

			await api.setCustomPath('claude-code', null);

			expect(mockInvoke).toHaveBeenCalledWith('agents:setCustomPath', 'claude-code', null);
		});
	});

	describe('getCustomPath', () => {
		it('should invoke agents:getCustomPath with agentId', async () => {
			mockInvoke.mockResolvedValue('/custom/path/claude');

			const result = await api.getCustomPath('claude-code');

			expect(mockInvoke).toHaveBeenCalledWith('agents:getCustomPath', 'claude-code');
			expect(result).toBe('/custom/path/claude');
		});

		it('should return null when no custom path', async () => {
			mockInvoke.mockResolvedValue(null);

			const result = await api.getCustomPath('claude-code');

			expect(result).toBeNull();
		});
	});

	describe('getAllCustomPaths', () => {
		it('should invoke agents:getAllCustomPaths', async () => {
			const mockPaths = {
				'claude-code': '/custom/claude',
				codex: '/custom/codex',
			};
			mockInvoke.mockResolvedValue(mockPaths);

			const result = await api.getAllCustomPaths();

			expect(mockInvoke).toHaveBeenCalledWith('agents:getAllCustomPaths');
			expect(result).toEqual(mockPaths);
		});
	});

	describe('setCustomArgs', () => {
		it('should invoke agents:setCustomArgs', async () => {
			mockInvoke.mockResolvedValue(true);

			const result = await api.setCustomArgs('claude-code', '--verbose --debug');

			expect(mockInvoke).toHaveBeenCalledWith(
				'agents:setCustomArgs',
				'claude-code',
				'--verbose --debug'
			);
			expect(result).toBe(true);
		});
	});

	describe('getCustomArgs', () => {
		it('should invoke agents:getCustomArgs', async () => {
			mockInvoke.mockResolvedValue('--verbose');

			const result = await api.getCustomArgs('claude-code');

			expect(mockInvoke).toHaveBeenCalledWith('agents:getCustomArgs', 'claude-code');
			expect(result).toBe('--verbose');
		});
	});

	describe('getAllCustomArgs', () => {
		it('should invoke agents:getAllCustomArgs', async () => {
			const mockArgs = { 'claude-code': '--verbose' };
			mockInvoke.mockResolvedValue(mockArgs);

			const result = await api.getAllCustomArgs();

			expect(mockInvoke).toHaveBeenCalledWith('agents:getAllCustomArgs');
			expect(result).toEqual(mockArgs);
		});
	});

	describe('setCustomEnvVars', () => {
		it('should invoke agents:setCustomEnvVars', async () => {
			mockInvoke.mockResolvedValue(true);

			const envVars = { CLAUDE_API_KEY: 'test-key' };
			const result = await api.setCustomEnvVars('claude-code', envVars);

			expect(mockInvoke).toHaveBeenCalledWith('agents:setCustomEnvVars', 'claude-code', envVars);
			expect(result).toBe(true);
		});
	});

	describe('getCustomEnvVars', () => {
		it('should invoke agents:getCustomEnvVars', async () => {
			const envVars = { CLAUDE_API_KEY: 'test-key' };
			mockInvoke.mockResolvedValue(envVars);

			const result = await api.getCustomEnvVars('claude-code');

			expect(mockInvoke).toHaveBeenCalledWith('agents:getCustomEnvVars', 'claude-code');
			expect(result).toEqual(envVars);
		});
	});

	describe('getAllCustomEnvVars', () => {
		it('should invoke agents:getAllCustomEnvVars', async () => {
			const allEnvVars = {
				'claude-code': { CLAUDE_API_KEY: 'key1' },
				codex: { OPENAI_API_KEY: 'key2' },
			};
			mockInvoke.mockResolvedValue(allEnvVars);

			const result = await api.getAllCustomEnvVars();

			expect(mockInvoke).toHaveBeenCalledWith('agents:getAllCustomEnvVars');
			expect(result).toEqual(allEnvVars);
		});
	});

	describe('getModels', () => {
		it('should invoke agents:getModels with agentId', async () => {
			const models = ['gpt-4', 'gpt-3.5-turbo'];
			mockInvoke.mockResolvedValue(models);

			const result = await api.getModels('opencode');

			expect(mockInvoke).toHaveBeenCalledWith('agents:getModels', 'opencode', undefined);
			expect(result).toEqual(models);
		});

		it('should invoke agents:getModels with forceRefresh', async () => {
			mockInvoke.mockResolvedValue([]);

			await api.getModels('opencode', true);

			expect(mockInvoke).toHaveBeenCalledWith('agents:getModels', 'opencode', true);
		});
	});

	describe('discoverSlashCommands', () => {
		it('should invoke agents:discoverSlashCommands', async () => {
			const commands = ['compact', 'help', 'review'];
			mockInvoke.mockResolvedValue(commands);

			const result = await api.discoverSlashCommands('claude-code', '/home/user/project');

			expect(mockInvoke).toHaveBeenCalledWith(
				'agents:discoverSlashCommands',
				'claude-code',
				'/home/user/project',
				undefined
			);
			expect(result).toEqual(commands);
		});

		it('should invoke agents:discoverSlashCommands with customPath', async () => {
			mockInvoke.mockResolvedValue(['help']);

			await api.discoverSlashCommands('claude-code', '/home/user/project', '/custom/claude');

			expect(mockInvoke).toHaveBeenCalledWith(
				'agents:discoverSlashCommands',
				'claude-code',
				'/home/user/project',
				'/custom/claude'
			);
		});

		it('should return null when discovery fails', async () => {
			mockInvoke.mockResolvedValue(null);

			const result = await api.discoverSlashCommands('unknown-agent', '/home/user/project');

			expect(result).toBeNull();
		});
	});
});
