// Source: src/__tests__/main/preload/journey.test.ts
// Source: src/__tests__/main/preload/parquet.test.ts
// Source: src/__tests__/main/preload/promptLinks.test.ts
// Source: src/__tests__/main/preload/webLogin.test.ts
// Source: src/__tests__/main/preload/agentRun.test.ts
// Source: src/__tests__/main/preload/agents.test.ts
// Source: src/__tests__/main/preload/attachments.test.ts
// Source: src/__tests__/main/preload/commands.test.ts
import { describe as describeSourceSuite } from 'vitest';
import { beforeEach } from 'vitest';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { vi } from 'vitest';
import { createJourneyApi } from '../../../main/preload/journey';
import { createParquetApi } from '../../../main/preload/parquet';
import { createPromptLinksApi } from '../../../main/preload/promptLinks';
import { createWebLoginApi } from '../../../main/preload/webLogin';
import { createAgentRunApi } from '../../../main/preload/agentRun';
import { createAgentsApi } from '../../../main/preload/agents';
import type { AgentDiscoveryRequest } from '../../../shared/types';
import type { AgentDiscoveryResult } from '../../../shared/types';
import type { GrokCommandDiscoveryResult } from '../../../main/agents/grok-skills';
import { createAttachmentsApi } from '../../../main/preload/attachments';
import { createSpeckitApi } from '../../../main/preload/commands';
import { createOpenspecApi } from '../../../main/preload/commands';
const { mockInvoke } = vi.hoisted(() => ({
	mockInvoke: vi.fn(),
}));

beforeEach(() => {
	mockInvoke.mockReset();
});

vi.mock('electron', () => ({
	ipcRenderer: {
		invoke: (...args: unknown[]) => mockInvoke(...args),
	},
}));
describeSourceSuite('journey', () => {
	describe('Journey Preload API', () => {
		let api: ReturnType<typeof createJourneyApi>;

		beforeEach(() => {
			vi.clearAllMocks();
			mockInvoke.mockResolvedValue(undefined);
			api = createJourneyApi();
		});

		it('exposes exactly append, read, and getPath', () => {
			expect(Object.keys(api).sort()).toEqual(['append', 'getPath', 'read']);
		});

		it('appends one entry', async () => {
			const entry = { ts: 1, agentId: 'a1', kind: 'file.open' as const, target: '/p/a.ts' };
			mockInvoke.mockResolvedValueOnce(true);
			await expect(api.append(entry)).resolves.toBe(true);
			expect(mockInvoke).toHaveBeenCalledWith('journey:append', entry);
		});

		it('reads with the agent id and options in order', async () => {
			mockInvoke.mockResolvedValueOnce([]);
			await expect(api.read('a1', { tail: 10, kinds: ['file.save'] })).resolves.toEqual([]);
			expect(mockInvoke).toHaveBeenCalledWith('journey:read', 'a1', {
				tail: 10,
				kinds: ['file.save'],
			});
		});

		it('maps getPath to journey:path', async () => {
			mockInvoke.mockResolvedValueOnce('/data/journey/a1.jsonl');
			await expect(api.getPath('a1')).resolves.toBe('/data/journey/a1.jsonl');
			expect(mockInvoke).toHaveBeenCalledWith('journey:path', 'a1');
		});
	});
});
describeSourceSuite('parquet', () => {
	describe('Parquet Preload API', () => {
		let api: ReturnType<typeof createParquetApi>;

		beforeEach(() => {
			vi.clearAllMocks();
			api = createParquetApi();
		});

		it('opens a local file', async () => {
			mockInvoke.mockResolvedValue({ handle: 'h1' });
			await api.open('/data/events.parquet');
			expect(mockInvoke).toHaveBeenCalledWith('parquet:open', '/data/events.parquet', undefined);
		});

		it('forwards the SSH remote id so remote files resolve on the right host', async () => {
			mockInvoke.mockResolvedValue({ handle: 'h1' });
			await api.open('/data/events.parquet', 'remote-7');
			expect(mockInvoke).toHaveBeenCalledWith('parquet:open', '/data/events.parquet', 'remote-7');
		});

		it('sends a query as a single request object', async () => {
			mockInvoke.mockResolvedValue({ rows: [] });
			const request = { handle: 'h1', filter: 'a = 1', offset: 0, limit: 100 };
			await api.query(request);
			expect(mockInvoke).toHaveBeenCalledWith('parquet:query', request);
		});

		it('exports the match set', async () => {
			mockInvoke.mockResolvedValue({ path: '/tmp/out.csv', rows: 3, truncated: false });
			const options = {
				handle: 'h1',
				filter: '',
				destPath: '/tmp/out.csv',
				format: 'csv' as const,
			};
			const result = await api.export(options);
			expect(mockInvoke).toHaveBeenCalledWith('parquet:export', options);
			expect(result.rows).toBe(3);
		});

		it('closes a handle', async () => {
			mockInvoke.mockResolvedValue(undefined);
			await api.close('h1');
			expect(mockInvoke).toHaveBeenCalledWith('parquet:close', 'h1');
		});
	});
});
describeSourceSuite('promptLinks', () => {
	describe('Prompt Links Preload API', () => {
		let api: ReturnType<typeof createPromptLinksApi>;

		beforeEach(() => {
			vi.clearAllMocks();
			mockInvoke.mockResolvedValue(undefined);
			api = createPromptLinksApi();
		});

		it('exposes exactly the four verbs', () => {
			expect(Object.keys(api).sort()).toEqual(['create', 'list', 'rendererReady', 'revoke']);
		});

		it('maps each verb to its channel with its arguments', async () => {
			const input = { agentId: 'a', prompt: 'p' };
			await api.list();
			await api.create(input);
			await api.revoke('l1');
			await api.rendererReady();
			expect(mockInvoke.mock.calls).toEqual([
				['promptLinks:list'],
				['promptLinks:create', input],
				['promptLinks:revoke', 'l1'],
				['promptLinks:rendererReady'],
			]);
		});
	});
});
describeSourceSuite('webLogin', () => {
	describe('Web Login Preload API', () => {
		let api: ReturnType<typeof createWebLoginApi>;

		beforeEach(() => {
			vi.clearAllMocks();
			mockInvoke.mockResolvedValue(undefined);
			api = createWebLoginApi();
		});

		it('exposes exactly the six account verbs', () => {
			expect(Object.keys(api).sort()).toEqual([
				'createUser',
				'deleteUser',
				'listUsers',
				'setDisabled',
				'setDisplayName',
				'setPassword',
			]);
		});

		it('lists accounts', async () => {
			mockInvoke.mockResolvedValueOnce([{ id: 'u1' }]);
			await expect(api.listUsers()).resolves.toEqual([{ id: 'u1' }]);
			expect(mockInvoke).toHaveBeenCalledWith('webLogin:listUsers');
		});

		it('passes the create input through as one object', async () => {
			const input = { username: 'ada', password: 'hunter2hunter2', displayName: 'Ada' };
			await api.createUser(input);
			expect(mockInvoke).toHaveBeenCalledWith('webLogin:createUser', input);
		});

		it('passes id + value through in order', async () => {
			await api.setPassword('u1', 'nextpassword');
			expect(mockInvoke).toHaveBeenCalledWith('webLogin:setPassword', 'u1', 'nextpassword');

			await api.setDisplayName('u1', 'Ada L');
			expect(mockInvoke).toHaveBeenCalledWith('webLogin:setDisplayName', 'u1', 'Ada L');

			await api.setDisabled('u1', true);
			expect(mockInvoke).toHaveBeenCalledWith('webLogin:setDisabled', 'u1', true);

			await api.deleteUser('u1');
			expect(mockInvoke).toHaveBeenCalledWith('webLogin:deleteUser', 'u1');
		});
	});
});
describeSourceSuite('agentRun', () => {
	describe('AgentRun Preload API', () => {
		beforeEach(() => {
			vi.clearAllMocks();
		});

		it('lists agent runs through IPC with filters', async () => {
			mockInvoke.mockResolvedValue({ success: true, runs: [] });
			const api = createAgentRunApi();

			const result = await api.list({ status: 'running', campaign: 'campaign-1', limit: 5 });

			expect(mockInvoke).toHaveBeenCalledWith('agentRun:list', {
				status: 'running',
				campaign: 'campaign-1',
				limit: 5,
			});
			expect(result).toEqual({ success: true, runs: [] });
		});

		it('records one run through IPC', async () => {
			mockInvoke.mockResolvedValue({ success: true, run: { id: 'run-1' } });
			const api = createAgentRunApi();

			const result = await api.record({ id: 'run-1' } as never);

			expect(mockInvoke).toHaveBeenCalledWith('agentRun:record', { id: 'run-1' });
			expect(result).toEqual({ success: true, run: { id: 'run-1' } });
		});

		it('shows one run through IPC', async () => {
			mockInvoke.mockResolvedValue({ success: false, error: 'Run not found: run-1' });
			const api = createAgentRunApi();

			const result = await api.show('run-1');

			expect(mockInvoke).toHaveBeenCalledWith('agentRun:show', 'run-1');
			expect(result).toEqual({ success: false, error: 'Run not found: run-1' });
		});

		it('reads run events through IPC', async () => {
			mockInvoke.mockResolvedValue({ success: true, events: [] });
			const api = createAgentRunApi();

			const result = await api.events('run-1');

			expect(mockInvoke).toHaveBeenCalledWith('agentRun:events', 'run-1');
			expect(result).toEqual({ success: true, events: [] });
		});

		it('appends one run event through IPC', async () => {
			mockInvoke.mockResolvedValue({ success: true, event: { id: 'event-1' } });
			const api = createAgentRunApi();

			const result = await api.appendEvent({ id: 'event-1' } as never);

			expect(mockInvoke).toHaveBeenCalledWith('agentRun:event', { id: 'event-1' });
			expect(result).toEqual({ success: true, event: { id: 'event-1' } });
		});

		it('lists campaigns through nested IPC API with filters', async () => {
			mockInvoke.mockResolvedValue({ success: true, campaigns: [] });
			const api = createAgentRunApi();

			const result = await api.campaigns.list({ status: 'needs_review', limit: 10 });

			expect(mockInvoke).toHaveBeenCalledWith('campaign:list', {
				status: 'needs_review',
				limit: 10,
			});
			expect(result).toEqual({ success: true, campaigns: [] });
		});

		it('records one campaign through nested IPC API', async () => {
			mockInvoke.mockResolvedValue({ success: true, campaign: { id: 'campaign-1' } });
			const api = createAgentRunApi();

			const result = await api.campaigns.record({ id: 'campaign-1' } as never);

			expect(mockInvoke).toHaveBeenCalledWith('campaign:record', { id: 'campaign-1' });
			expect(result).toEqual({ success: true, campaign: { id: 'campaign-1' } });
		});

		it('shows one campaign through nested IPC API', async () => {
			mockInvoke.mockResolvedValue({ success: true, campaign: { id: 'campaign-1' } });
			const api = createAgentRunApi();

			const result = await api.campaigns.show('campaign-1');

			expect(mockInvoke).toHaveBeenCalledWith('campaign:show', 'campaign-1');
			expect(result).toEqual({ success: true, campaign: { id: 'campaign-1' } });
		});
	});
});
describeSourceSuite('agents', () => {
	// Mock electron ipcRenderer

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

				expect(mockInvoke).toHaveBeenCalledWith(
					'agents:getModels',
					'opencode',
					undefined,
					undefined
				);
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
			])(
				'forwards the typed $kind request and complete native result unchanged',
				async (context) => {
					const request: AgentDiscoveryRequest = {
						providerId: 'grok',
						forceRefresh: true,
						context,
					};
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

					const result: GrokCommandDiscoveryResult | null =
						await api.discoverSlashCommands(request);

					expect(mockInvoke.mock.calls).toEqual([
						['agents:discoverSlashCommands', expected.request],
					]);
					expect(result).toBe(response);
					expect(result).toEqual(expected.response);
				}
			);

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
				const response: GrokCommandDiscoveryResult = {
					status: 'unavailable',
					commands: [],
					reason,
				};
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
				const commands = [
					{ name: 'check', prompt: 'Check $ARGUMENTS', description: 'Check files' },
				];
				mockInvoke.mockResolvedValue(commands);

				expect(
					await api.discoverSlashCommands('codex', '/project', '/custom/codex', 'remote-a')
				).toBe(commands);
				expect(
					await api.discoverSlashCommands(
						'codex',
						'/project',
						'/custom/codex',
						'remote-a',
						undefined
					)
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
});
describeSourceSuite('attachments', () => {
	// Mock electron ipcRenderer

	describe('Attachments Preload API', () => {
		let api: ReturnType<typeof createAttachmentsApi>;

		beforeEach(() => {
			vi.clearAllMocks();
			api = createAttachmentsApi();
		});

		describe('save', () => {
			it('should invoke attachments:save with sessionId, base64Data, and filename', async () => {
				mockInvoke.mockResolvedValue({
					success: true,
					path: '/path/to/file',
					filename: 'image.png',
				});

				const result = await api.save('session-123', 'base64data', 'image.png');

				expect(mockInvoke).toHaveBeenCalledWith(
					'attachments:save',
					'session-123',
					'base64data',
					'image.png'
				);
				expect(result.success).toBe(true);
				expect(result.path).toBe('/path/to/file');
				expect(result.filename).toBe('image.png');
			});

			it('should handle errors', async () => {
				mockInvoke.mockResolvedValue({ success: false, error: 'Save failed' });

				const result = await api.save('session-123', 'base64data', 'image.png');

				expect(result.success).toBe(false);
				expect(result.error).toBe('Save failed');
			});
		});

		describe('load', () => {
			it('should invoke attachments:load with sessionId and filename', async () => {
				mockInvoke.mockResolvedValue({
					success: true,
					dataUrl: 'data:image/png;base64,abc123',
				});

				const result = await api.load('session-123', 'image.png');

				expect(mockInvoke).toHaveBeenCalledWith('attachments:load', 'session-123', 'image.png');
				expect(result.success).toBe(true);
				expect(result.dataUrl).toBe('data:image/png;base64,abc123');
			});

			it('should handle missing files', async () => {
				mockInvoke.mockResolvedValue({ success: false, error: 'File not found' });

				const result = await api.load('session-123', 'nonexistent.png');

				expect(result.success).toBe(false);
				expect(result.error).toBe('File not found');
			});
		});

		describe('delete', () => {
			it('should invoke attachments:delete with sessionId and filename', async () => {
				mockInvoke.mockResolvedValue({ success: true });

				const result = await api.delete('session-123', 'image.png');

				expect(mockInvoke).toHaveBeenCalledWith('attachments:delete', 'session-123', 'image.png');
				expect(result.success).toBe(true);
			});
		});

		describe('list', () => {
			it('should invoke attachments:list with sessionId', async () => {
				mockInvoke.mockResolvedValue({
					success: true,
					files: ['image1.png', 'image2.jpg'],
				});

				const result = await api.list('session-123');

				expect(mockInvoke).toHaveBeenCalledWith('attachments:list', 'session-123');
				expect(result.success).toBe(true);
				expect(result.files).toEqual(['image1.png', 'image2.jpg']);
			});

			it('should return empty array when no files exist', async () => {
				mockInvoke.mockResolvedValue({ success: true, files: [] });

				const result = await api.list('session-123');

				expect(result.files).toEqual([]);
			});
		});

		describe('getPath', () => {
			it('should invoke attachments:getPath with sessionId', async () => {
				mockInvoke.mockResolvedValue({
					success: true,
					path: '/home/user/.maestro/attachments/session-123',
				});

				const result = await api.getPath('session-123');

				expect(mockInvoke).toHaveBeenCalledWith('attachments:getPath', 'session-123');
				expect(result.success).toBe(true);
				expect(result.path).toBe('/home/user/.maestro/attachments/session-123');
			});
		});
	});
});
describeSourceSuite('commands', () => {
	// Mock electron ipcRenderer

	describe('Commands Preload API', () => {
		beforeEach(() => {
			vi.clearAllMocks();
		});

		describe('createSpeckitApi', () => {
			let api: ReturnType<typeof createSpeckitApi>;

			beforeEach(() => {
				api = createSpeckitApi();
			});

			describe('getMetadata', () => {
				it('should invoke speckit:getMetadata', async () => {
					const metadata = {
						success: true,
						metadata: {
							lastRefreshed: '2024-01-01',
							commitSha: 'abc123',
							sourceVersion: '1.0.0',
							sourceUrl: 'https://github.com/example/speckit',
						},
					};
					mockInvoke.mockResolvedValue(metadata);

					const result = await api.getMetadata();

					expect(mockInvoke).toHaveBeenCalledWith('speckit:getMetadata');
					expect(result).toEqual(metadata);
				});
			});

			describe('getPrompts', () => {
				it('should invoke speckit:getPrompts', async () => {
					const response = {
						success: true,
						commands: [
							{
								id: 'cmd-1',
								command: '/test',
								description: 'Test command',
								prompt: 'Test prompt',
								isCustom: false,
								isModified: false,
							},
						],
					};
					mockInvoke.mockResolvedValue(response);

					const result = await api.getPrompts();

					expect(mockInvoke).toHaveBeenCalledWith('speckit:getPrompts');
					expect(result).toEqual(response);
				});
			});

			describe('getCommand', () => {
				it('should invoke speckit:getCommand', async () => {
					const response = {
						success: true,
						command: {
							id: 'cmd-1',
							command: '/test',
							description: 'Test command',
							prompt: 'Test prompt',
							isCustom: false,
							isModified: false,
						},
					};
					mockInvoke.mockResolvedValue(response);

					const result = await api.getCommand('/test');

					expect(mockInvoke).toHaveBeenCalledWith('speckit:getCommand', '/test');
					expect(result).toEqual(response);
				});

				it('should handle command not found', async () => {
					mockInvoke.mockResolvedValue({ success: true, command: null });

					const result = await api.getCommand('/nonexistent');

					expect(result.command).toBeNull();
				});
			});

			describe('savePrompt', () => {
				it('should invoke speckit:savePrompt', async () => {
					mockInvoke.mockResolvedValue({ success: true });

					const result = await api.savePrompt('cmd-1', 'Updated prompt content');

					expect(mockInvoke).toHaveBeenCalledWith(
						'speckit:savePrompt',
						'cmd-1',
						'Updated prompt content'
					);
					expect(result.success).toBe(true);
				});

				it('should handle save error', async () => {
					mockInvoke.mockResolvedValue({ success: false, error: 'Failed to save' });

					const result = await api.savePrompt('cmd-1', 'content');

					expect(result.success).toBe(false);
					expect(result.error).toBe('Failed to save');
				});
			});

			describe('resetPrompt', () => {
				it('should invoke speckit:resetPrompt', async () => {
					mockInvoke.mockResolvedValue({ success: true, prompt: 'Original prompt' });

					const result = await api.resetPrompt('cmd-1');

					expect(mockInvoke).toHaveBeenCalledWith('speckit:resetPrompt', 'cmd-1');
					expect(result.success).toBe(true);
					expect(result.prompt).toBe('Original prompt');
				});
			});

			describe('refresh', () => {
				it('should invoke speckit:refresh', async () => {
					const metadata = {
						success: true,
						metadata: {
							lastRefreshed: '2024-01-02',
							commitSha: 'def456',
							sourceVersion: '1.0.1',
							sourceUrl: 'https://github.com/example/speckit',
						},
					};
					mockInvoke.mockResolvedValue(metadata);

					const result = await api.refresh();

					expect(mockInvoke).toHaveBeenCalledWith('speckit:refresh');
					expect(result).toEqual(metadata);
				});
			});
		});

		describe('createOpenspecApi', () => {
			let api: ReturnType<typeof createOpenspecApi>;

			beforeEach(() => {
				api = createOpenspecApi();
			});

			describe('getMetadata', () => {
				it('should invoke openspec:getMetadata', async () => {
					const metadata = {
						success: true,
						metadata: {
							lastRefreshed: '2024-01-01',
							commitSha: 'abc123',
							sourceVersion: '1.0.0',
							sourceUrl: 'https://github.com/example/openspec',
						},
					};
					mockInvoke.mockResolvedValue(metadata);

					const result = await api.getMetadata();

					expect(mockInvoke).toHaveBeenCalledWith('openspec:getMetadata');
					expect(result).toEqual(metadata);
				});
			});

			describe('getPrompts', () => {
				it('should invoke openspec:getPrompts', async () => {
					const response = {
						success: true,
						commands: [
							{
								id: 'spec-1',
								command: '/spec',
								description: 'Spec command',
								prompt: 'Spec prompt',
								isCustom: false,
								isModified: false,
							},
						],
					};
					mockInvoke.mockResolvedValue(response);

					const result = await api.getPrompts();

					expect(mockInvoke).toHaveBeenCalledWith('openspec:getPrompts');
					expect(result).toEqual(response);
				});
			});

			describe('getCommand', () => {
				it('should invoke openspec:getCommand', async () => {
					const response = {
						success: true,
						command: {
							id: 'spec-1',
							command: '/spec',
							description: 'Spec command',
							prompt: 'Spec prompt',
							isCustom: false,
							isModified: false,
						},
					};
					mockInvoke.mockResolvedValue(response);

					const result = await api.getCommand('/spec');

					expect(mockInvoke).toHaveBeenCalledWith('openspec:getCommand', '/spec');
					expect(result).toEqual(response);
				});
			});

			describe('savePrompt', () => {
				it('should invoke openspec:savePrompt', async () => {
					mockInvoke.mockResolvedValue({ success: true });

					const result = await api.savePrompt('spec-1', 'Updated spec prompt');

					expect(mockInvoke).toHaveBeenCalledWith(
						'openspec:savePrompt',
						'spec-1',
						'Updated spec prompt'
					);
					expect(result.success).toBe(true);
				});
			});

			describe('resetPrompt', () => {
				it('should invoke openspec:resetPrompt', async () => {
					mockInvoke.mockResolvedValue({ success: true, prompt: 'Original spec prompt' });

					const result = await api.resetPrompt('spec-1');

					expect(mockInvoke).toHaveBeenCalledWith('openspec:resetPrompt', 'spec-1');
					expect(result.success).toBe(true);
					expect(result.prompt).toBe('Original spec prompt');
				});
			});

			describe('refresh', () => {
				it('should invoke openspec:refresh', async () => {
					const metadata = {
						success: true,
						metadata: {
							lastRefreshed: '2024-01-02',
							commitSha: 'xyz789',
							sourceVersion: '2.0.0',
							sourceUrl: 'https://github.com/example/openspec',
						},
					};
					mockInvoke.mockResolvedValue(metadata);

					const result = await api.refresh();

					expect(mockInvoke).toHaveBeenCalledWith('openspec:refresh');
					expect(result).toEqual(metadata);
				});
			});
		});
	});
});
