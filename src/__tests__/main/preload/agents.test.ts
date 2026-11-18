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
import type { AgentDiscoveryRequest, AgentDiscoveryResult } from '../../../shared/types';
import type { GrokCommandDiscoveryResult } from '../../../main/agents/grok-skills';

describe('Agents Preload API', () => {
	let api: ReturnType<typeof createAgentsApi>;

	beforeEach(() => {
		vi.clearAllMocks();
		api = createAgentsApi();
	});

	it('uses the single translation IPC contract and returns refusal unchanged', async () => {
		const request = { agentId: 'agent', destination: 'codex' as const, action: 'apply' as const };
		const refusal = { success: false, error: 'Native resume is unverified' };
		mockInvoke.mockResolvedValue(refusal);
		expect(await api.translateProvider(request)).toEqual(refusal);
		expect(mockInvoke).toHaveBeenCalledWith('agents:translateProvider', request);
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

			expect(mockInvoke).toHaveBeenCalledWith('agents:get', 'claude-code', undefined);
			expect(result).toEqual(mockAgent);
		});

		it('should return null for non-existent agent', async () => {
			mockInvoke.mockResolvedValue(null);

			const result = await api.get('nonexistent');

			expect(result).toBeNull();
		});

		it('should invoke agents:get with SSH remote ID', async () => {
			mockInvoke.mockResolvedValue({ id: 'claude-code', available: true });

			await api.get('claude-code', 'remote-1');

			expect(mockInvoke).toHaveBeenCalledWith('agents:get', 'claude-code', 'remote-1');
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

	describe('getAllCapabilities', () => {
		it('should invoke agents:getAllCapabilities with no arguments', async () => {
			const mockAll = {
				'claude-code': { supportsBatchMode: true },
				opencode: { supportsBatchMode: true },
				terminal: { supportsBatchMode: false },
			};
			mockInvoke.mockResolvedValue(mockAll);

			const result = await api.getAllCapabilities();

			expect(mockInvoke).toHaveBeenCalledWith('agents:getAllCapabilities');
			expect(result).toEqual(mockAll);
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

			expect(mockInvoke).toHaveBeenCalledWith('agents:getModels', 'opencode', undefined, undefined);
			expect(result).toEqual(models);
		});

		it('should invoke agents:getModels with forceRefresh', async () => {
			mockInvoke.mockResolvedValue([]);

			await api.getModels('opencode', true);

			expect(mockInvoke).toHaveBeenCalledWith('agents:getModels', 'opencode', true, undefined);
		});
	});

	describe.each(['getModels', 'getConfigOptions'] as const)('%s selected discovery', (method) => {
		it.each<AgentDiscoveryRequest['context']>([
			{ kind: 'agent', sessionId: 'selected-agent', model: 'manual-model', effort: 'high' },
			{
				kind: 'draft',
				cwd: '/remote/workspace',
				customPath: '/custom bin/grok',
				customEnvVars: { GROK_HOME: '/account-a', GROK_AUTH: '', XAI_API_KEY: 'synthetic-key' },
				sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-a' },
				sshRemoteId: 'remote-a',
			},
			{ kind: 'provider-settings', cwd: '/workspace', customEnvVars: {}, model: '', effort: '' },
		])('forwards the complete $kind selection without positional defaults', async (context) => {
			const request: AgentDiscoveryRequest = { providerId: 'grok', forceRefresh: true, context };
			const response: AgentDiscoveryResult =
				context.kind === 'provider-settings'
					? { status: 'unavailable', options: [], reason: 'managed-unqualified' }
					: {
							status: context.kind === 'agent' ? 'discovered' : 'configured-fallback',
							options: ['manual-model'],
							configuredValue: 'manual-model',
							...(context.kind === 'draft' ? { reason: 'remote-unqualified' as const } : {}),
						};
			mockInvoke.mockResolvedValue(response);
			const result =
				method === 'getModels'
					? await api.getModels(request)
					: await api.getConfigOptions(request, 'reasoningEffort');
			expect(mockInvoke.mock.calls).toEqual([
				method === 'getModels'
					? ['agents:getModels', request]
					: ['agents:getConfigOptions', request, 'reasoningEffort'],
			]);
			expect(result).toBe(response);
			expect(JSON.stringify(result)).not.toContain('synthetic-key');
		});

		it('propagates IPC rejection without retrying legacy host discovery', async () => {
			const request: AgentDiscoveryRequest = {
				providerId: 'grok',
				context: { kind: 'agent', sessionId: 'missing' },
			};
			const error = new Error('Selected discovery context required');
			mockInvoke.mockRejectedValueOnce(error);
			const pending =
				method === 'getModels'
					? api.getModels(request)
					: api.getConfigOptions(request, 'reasoningEffort');
			await expect(pending).rejects.toBe(error);
			expect(mockInvoke).toHaveBeenCalledTimes(1);
		});
	});

	it('preserves legacy model SSH and config option positional signatures', async () => {
		const options = ['configured-option'];
		mockInvoke.mockResolvedValue(options);
		expect(await api.getModels('opencode', true, 'remote-legacy')).toBe(options);
		expect(await api.getConfigOptions('codex', 'reasoningEffort', true)).toBe(options);
		expect(mockInvoke.mock.calls).toEqual([
			['agents:getModels', 'opencode', true, 'remote-legacy'],
			['agents:getConfigOptions', 'codex', 'reasoningEffort', true],
		]);
	});

	describe('discoverSlashCommands', () => {
		it.each<AgentDiscoveryRequest['context']>([
			{ kind: 'agent', sessionId: 'selected-agent', model: 'manual-model', effort: 'high' },
			{
				kind: 'draft',
				cwd: '/remote/workspace',
				customPath: '/custom bin/grok',
				customEnvVars: { GROK_HOME: '/account-b', GROK_AUTH: '' },
				sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-b' },
				sshRemoteId: 'remote-b',
				model: 'draft-model',
				effort: 'low',
			},
			{ kind: 'provider-settings', cwd: '/workspace', customEnvVars: {}, model: '', effort: '' },
		])('forwards the typed $kind request and complete native result unchanged', async (context) => {
			const request: AgentDiscoveryRequest = { providerId: 'grok', forceRefresh: true, context };
			// Synthetic IPC response only; the host owns validation and availability.
			const response: GrokCommandDiscoveryResult = {
				status: 'discovered',
				commands: [
					{ name: 'review', description: 'Review changes', kind: 'native-command' },
					{
						name: 'repo:check',
						description: 'Check the selected project',
						kind: 'skill',
						scope: 'repo',
						argumentHint: '<target> [--verbose]',
					},
					{ name: 'user:check', description: 'User skill', kind: 'skill', scope: 'user' },
					{ name: 'plugin:check', description: 'Plugin skill', kind: 'skill', scope: 'plugin' },
					{ name: 'workflow:check', description: 'Workflow', kind: 'workflow' },
				],
				binding: {
					route: 'grok-acp',
					sessionId: 'native-session',
					processGeneration: 'process-2',
					configGeneration: 'config-3',
					catalogRevision: 4,
					agentVersion: '1.0.0-fixture',
					observedAt: 1_800_000_000_000,
				},
			};
			const expected = structuredClone({ request, response });
			mockInvoke.mockResolvedValueOnce(response);

			const result: GrokCommandDiscoveryResult | null = await api.discoverSlashCommands(request);

			expect(mockInvoke.mock.calls).toEqual([['agents:discoverSlashCommands', expected.request]]);
			expect(result).toBe(response);
			expect(result).toEqual(expected.response);
		});

		it.each<NonNullable<GrokCommandDiscoveryResult['reason']>>([
			'missing-context',
			'remote-unqualified',
			'managed-unqualified',
			'executable-unavailable',
			'observation-unavailable',
			'invalid-catalog',
			'canceled',
		])('preserves the host refusal reason %s without legacy fallback', async (reason) => {
			const request: AgentDiscoveryRequest = {
				providerId: 'grok',
				context: { kind: 'agent', sessionId: 'selected-agent' },
			};
			const response: GrokCommandDiscoveryResult = { status: 'unavailable', commands: [], reason };
			mockInvoke.mockResolvedValueOnce(response);

			const result = await api.discoverSlashCommands(request);
			expect(result).toBe(response);
			expect(result).toEqual({ status: 'unavailable', commands: [], reason });
			expect(mockInvoke.mock.calls).toEqual([['agents:discoverSlashCommands', request]]);
		});

		it('preserves an authoritative empty catalog and its binding', async () => {
			const request: AgentDiscoveryRequest = {
				providerId: 'grok',
				context: { kind: 'agent', sessionId: 'selected-agent' },
			};
			const response: GrokCommandDiscoveryResult = {
				status: 'discovered',
				commands: [],
				binding: {
					route: 'grok-acp',
					sessionId: 'empty-native-session',
					processGeneration: 'process-5',
					configGeneration: 'config-6',
					catalogRevision: 0,
					agentVersion: '1.0.0-fixture',
					observedAt: 1_800_000_000_001,
				},
			};
			const expected = structuredClone(response);
			mockInvoke.mockResolvedValueOnce(response);

			const result = await api.discoverSlashCommands(request);
			expect(result).toBe(response);
			expect(result).toEqual(expected);
			expect(mockInvoke.mock.calls).toEqual([['agents:discoverSlashCommands', request]]);
		});

		it.each(['claude-code', 'codex'])(
			'preserves null for a non-Grok %s object request',
			async (providerId) => {
				const request: AgentDiscoveryRequest = {
					providerId,
					context: { kind: 'agent', sessionId: 'selected-agent' },
				};
				mockInvoke.mockResolvedValueOnce(null);

				expect(await api.discoverSlashCommands(request)).toBeNull();
				expect(mockInvoke.mock.calls).toEqual([['agents:discoverSlashCommands', request]]);
			}
		);

		it('propagates IPC rejection once without retrying positional discovery', async () => {
			const request: AgentDiscoveryRequest = {
				providerId: 'grok',
				context: { kind: 'agent', sessionId: 'missing-agent' },
			};
			const error = new Error('Selected discovery context required');
			mockInvoke.mockRejectedValueOnce(error);

			await expect(api.discoverSlashCommands(request)).rejects.toBe(error);
			expect(mockInvoke.mock.calls).toEqual([['agents:discoverSlashCommands', request]]);
		});

		it('distinguishes omitted and undefined positional env from explicit empty env', async () => {
			const commands = [{ name: 'check', prompt: 'Check $ARGUMENTS', description: 'Check files' }];
			mockInvoke.mockResolvedValue(commands);

			expect(
				await api.discoverSlashCommands('codex', '/project', '/custom/codex', 'remote-a')
			).toBe(commands);
			expect(
				await api.discoverSlashCommands('codex', '/project', '/custom/codex', 'remote-a', undefined)
			).toBe(commands);
			expect(
				await api.discoverSlashCommands('codex', '/project', '/custom/codex', 'remote-a', {})
			).toBe(commands);
			expect(mockInvoke.mock.calls).toEqual([
				['agents:discoverSlashCommands', 'codex', '/project', '/custom/codex', 'remote-a'],
				['agents:discoverSlashCommands', 'codex', '/project', '/custom/codex', 'remote-a'],
				['agents:discoverSlashCommands', 'codex', '/project', '/custom/codex', 'remote-a', {}],
			]);
		});

		it('preserves legacy Grok null with positional custom path, remote and account env', async () => {
			const env = { GROK_HOME: '/account-b' };
			mockInvoke.mockResolvedValueOnce(null);

			expect(
				await api.discoverSlashCommands('grok', '/project', '/custom/grok', 'remote-b', env)
			).toBeNull();
			expect(mockInvoke.mock.calls).toEqual([
				['agents:discoverSlashCommands', 'grok', '/project', '/custom/grok', 'remote-b', env],
			]);
		});

		it('passes the Codex session environment to discovery', async () => {
			mockInvoke.mockResolvedValue([]);
			await api.discoverSlashCommands('codex', '/project', undefined, undefined, {
				CODEX_HOME: '/profile',
			});
			expect(mockInvoke).toHaveBeenCalledWith(
				'agents:discoverSlashCommands',
				'codex',
				'/project',
				undefined,
				undefined,
				{ CODEX_HOME: '/profile' }
			);
		});

		it('should invoke agents:discoverSlashCommands', async () => {
			const commands = ['compact', 'help', 'review'];
			mockInvoke.mockResolvedValue(commands);

			const result = await api.discoverSlashCommands('claude-code', '/home/user/project');

			expect(mockInvoke).toHaveBeenCalledWith(
				'agents:discoverSlashCommands',
				'claude-code',
				'/home/user/project',
				undefined,
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
				'/custom/claude',
				undefined
			);
		});

		it('should invoke agents:discoverSlashCommands with sshRemoteId', async () => {
			mockInvoke.mockResolvedValue(['review']);

			await api.discoverSlashCommands('opencode', '/home/user/project', undefined, 'remote-1');

			expect(mockInvoke).toHaveBeenCalledWith(
				'agents:discoverSlashCommands',
				'opencode',
				'/home/user/project',
				undefined,
				'remote-1'
			);
		});

		it('should return null when discovery fails', async () => {
			mockInvoke.mockResolvedValue(null);

			const result = await api.discoverSlashCommands('unknown-agent', '/home/user/project');

			expect(result).toBeNull();
		});
	});

	describe('usage quota APIs', () => {
		it('should invoke agents:getClaudeUsageAccountKeys', async () => {
			const keys = ['/Users/me/.claude-work'];
			mockInvoke.mockResolvedValue(keys);

			const result = await api.getClaudeUsageAccountKeys();

			expect(mockInvoke).toHaveBeenCalledWith('agents:getClaudeUsageAccountKeys');
			expect(result).toEqual(keys);
		});

		it('should invoke agents:getCodexUsageAccountKeys', async () => {
			const keys = ['/Users/me/.codex-work'];
			mockInvoke.mockResolvedValue(keys);

			const result = await api.getCodexUsageAccountKeys();

			expect(mockInvoke).toHaveBeenCalledWith('agents:getCodexUsageAccountKeys');
			expect(result).toEqual(keys);
		});

		it('should invoke agents:getKnownAuthDirs', async () => {
			const dirs = {
				claudeConfigDirs: ['/Users/me/.claude-work'],
				codexHomes: ['/Users/me/.codex-work'],
			};
			mockInvoke.mockResolvedValue(dirs);

			const result = await api.getKnownAuthDirs();

			expect(mockInvoke).toHaveBeenCalledWith('agents:getKnownAuthDirs');
			expect(result).toEqual(dirs);
		});

		it('should invoke agents:getKnownEnvVarKeys', async () => {
			const envVarKeys = {
				byProvider: { 'claude-code': ['CLAUDE_CONFIG_DIR'] },
				global: ['HTTPS_PROXY'],
			};
			mockInvoke.mockResolvedValue(envVarKeys);

			const result = await api.getKnownEnvVarKeys();

			expect(mockInvoke).toHaveBeenCalledWith('agents:getKnownEnvVarKeys');
			expect(result).toEqual(envVarKeys);
		});
	});
});
