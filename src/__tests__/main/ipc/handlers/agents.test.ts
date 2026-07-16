/**
 * Tests for the agents IPC handlers
 *
 * These tests verify the agent detection and configuration management API.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import { ipcMain } from 'electron';
import {
	registerAgentsHandlers,
	AgentsHandlerDependencies,
} from '../../../../main/ipc/handlers/agents';
import * as agentCapabilities from '../../../../main/agents';
import { isPluginActive } from '../../../../main/plugins/plugin-manager-singleton';

// Mock electron's ipcMain
vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn(),
		removeHandler: vi.fn(),
	},
}));

vi.mock('../../../../main/plugins/plugin-manager-singleton', () => ({
	isPluginActive: vi.fn(() => true),
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
			{ id: 'omp', name: 'Oh My Pi', binaryName: 'omp', configOptions: [] },
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
	let handlers: Map<string, (...args: never[]) => unknown>;
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
		vi.mocked(isPluginActive).mockReturnValue(true);
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
				'agents:getKnownAuthDirs',
				'agents:getLimitResetAt',
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

	describe('agents:getKnownAuthDirs', () => {
		it('returns canonical local auth paths from agent and session env vars', async () => {
			mockAgentConfigsStore.get.mockImplementation((key: string, fallback?: unknown) => {
				if (key !== 'configs') return fallback;
				return {
					'claude-code': {
						customEnvVars: { CLAUDE_CONFIG_DIR: '/Users/me/.claude-agent' },
					},
					codex: {
						customEnvVars: { CODEX_HOME: '/Users/me/.codex-agent' },
					},
				};
			});
			const sessionsStore = {
				get: vi.fn().mockReturnValue([
					{
						toolType: 'claude-code',
						cwd: '/Users/me/project',
						customEnvVars: {
							CLAUDE_CONFIG_DIR: '/Users/me/work/../.claude-session',
						},
					},
					{
						toolType: 'codex',
						cwd: '/Users/me/project',
						customEnvVars: { CODEX_HOME: '/Users/me/.codex-session' },
					},
					{
						toolType: 'claude-code',
						cwd: 'ssh://host/project',
						sshRemoteId: 'remote-1',
						customEnvVars: { CLAUDE_CONFIG_DIR: '/remote/.claude' },
					},
					{
						toolType: 'codex',
						cwd: '/Users/me/project',
						sessionSshRemoteConfig: { enabled: true },
						customEnvVars: { CODEX_HOME: '/remote/.codex' },
					},
				]),
			};
			// The handler accepts electron-store's full Store shape, but reads only get().
			registerAgentsHandlers({
				...deps,
				sessionsStore: sessionsStore as unknown as NonNullable<
					AgentsHandlerDependencies['sessionsStore']
				>,
			});

			const handler = handlers.get('agents:getKnownAuthDirs');
			expect(handler).toBeDefined();
			const result = await handler?.({});

			expect(result).toEqual({
				claudeConfigDirs: [
					path.resolve('/Users/me/.claude-agent'),
					path.resolve('/Users/me/.claude-session'),
				],
				codexHomes: [
					path.resolve('/Users/me/.codex-agent'),
					path.resolve('/Users/me/.codex-session'),
				],
			});
		});

		it('excludes sessions whose migrated SSH enabled value explicitly enables SSH', async () => {
			mockAgentConfigsStore.get.mockReturnValue({
				'claude-code': {
					customEnvVars: { CLAUDE_CONFIG_DIR: '/Users/me/.claude-agent' },
				},
				codex: {
					customEnvVars: { CODEX_HOME: '/Users/me/.codex-agent' },
				},
			});
			const sessionsStore = {
				get: vi.fn().mockReturnValue([
					{
						toolType: 'claude-code',
						cwd: '/Users/me/project',
						sessionSshRemoteConfig: { enabled: 'true' },
						customEnvVars: { CLAUDE_CONFIG_DIR: '/remote/.claude-migrated' },
					},
					{
						toolType: 'claude-code',
						cwd: '/Users/me/project',
						sessionSshRemoteConfig: { enabled: 'TRUE' },
						customEnvVars: { CLAUDE_CONFIG_DIR: '/remote/.claude-uppercase' },
					},
					{
						toolType: 'codex',
						cwd: '/Users/me/project',
						sessionSshRemoteConfig: { enabled: 1 },
						customEnvVars: { CODEX_HOME: '/remote/.codex-migrated' },
					},
				]),
			};
			registerAgentsHandlers({
				...deps,
				sessionsStore: sessionsStore as unknown as NonNullable<
					AgentsHandlerDependencies['sessionsStore']
				>,
			});

			const handler = handlers.get('agents:getKnownAuthDirs');
			const result = await handler?.({});

			expect(result).toEqual({
				claudeConfigDirs: [path.resolve('/Users/me/.claude-agent')],
				codexHomes: [path.resolve('/Users/me/.codex-agent')],
			});
		});

		it('includes session auth paths when a migrated SSH enabled value explicitly disables SSH', async () => {
			mockAgentConfigsStore.get.mockReturnValue({
				'claude-code': {
					customEnvVars: { CLAUDE_CONFIG_DIR: '/Users/me/.claude-agent' },
				},
			});
			const sessionsStore = {
				get: vi.fn().mockReturnValue([
					{
						toolType: 'claude-code',
						cwd: '/Users/me/project',
						sessionSshRemoteConfig: { enabled: 'false' },
						customEnvVars: { CLAUDE_CONFIG_DIR: '/Users/me/.claude-migrated' },
					},
				]),
			};
			registerAgentsHandlers({
				...deps,
				sessionsStore: sessionsStore as unknown as NonNullable<
					AgentsHandlerDependencies['sessionsStore']
				>,
			});

			const handler = handlers.get('agents:getKnownAuthDirs');
			const result = await handler?.({});

			expect(result).toEqual({
				claudeConfigDirs: [
					path.resolve('/Users/me/.claude-agent'),
					path.resolve('/Users/me/.claude-migrated'),
				],
				codexHomes: [],
			});
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

		it('hides Oh My Pi when its signed provider plugin is inactive', async () => {
			vi.mocked(isPluginActive).mockReturnValue(false);
			mockAgentDetector.detectAgents.mockResolvedValue([
				{
					id: 'omp',
					name: 'Oh My Pi',
					binaryName: 'omp',
					command: 'omp',
					args: [],
					available: true,
					path: '/usr/local/bin/omp',
				},
				{
					id: 'claude-code',
					name: 'Claude Code',
					binaryName: 'claude',
					command: 'claude',
					args: [],
					available: true,
					path: '/usr/local/bin/claude',
				},
			]);

			const handler = handlers.get('agents:detect') as unknown as () => Promise<
				Array<{ id: string }>
			>;
			const result = await handler();

			expect(result.map((agent) => agent.id)).toEqual(['claude-code']);
		});

		it('should return empty array when no agents found', async () => {
			mockAgentDetector.detectAgents.mockResolvedValue([]);

			const handler = handlers.get('agents:detect');
			const result = await handler!({} as any);

			expect(result).toEqual([]);
		});

		it('should strip every arg-builder function so the payload survives IPC', async () => {
			// A definition carries arg builders (including ones added after this test was
			// written). Leaving even one behind makes the whole response fail to structured
			// clone, which strands the agent pickers on "Loading agents..." forever.
			mockAgentDetector.detectAgents.mockResolvedValue([
				{
					id: 'claude-code',
					name: 'Claude Code',
					binaryName: 'claude',
					available: true,
					resumeArgs: (id: string) => ['--resume', id],
					additionalDirArgs: (dirs: unknown[]) => dirs.map(() => '--add-dir'),
					configOptions: [{ id: 'model', argBuilder: (v: string) => ['--model', v] }],
				},
			]);

			const handler = handlers.get('agents:detect');
			const result = await handler!({} as any);

			expect(() => structuredClone(result)).not.toThrow();
			expect(result[0].id).toBe('claude-code');
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

			it('should discover omp models over SSH via models --json', async () => {
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
					args: ['-o', 'BatchMode=yes', 'dev@dev.example.com', 'omp models --json'],
				});

				vi.mocked(execFileNoThrow).mockResolvedValue({
					exitCode: 0,
					stdout: JSON.stringify({
						models: [
							{ id: 'claude-opus-4-8', selector: 'anthropic/claude-opus-4-8' },
							{ id: 'gpt-5.2', selector: 'openai-codex/gpt-5.2' },
						],
					}),
					stderr: '',
				});

				const handler = handlers.get('agents:getModels');
				const result = await handler!({} as any, 'omp', false, 'remote-1');

				expect(buildSshCommand).toHaveBeenCalledWith(
					expect.objectContaining({ id: 'remote-1', host: 'dev.example.com' }),
					expect.objectContaining({ command: 'omp', args: ['models', '--json'] })
				);
				expect(result).toEqual(['anthropic/claude-opus-4-8', 'openai-codex/gpt-5.2']);
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
				if (String(dir).replace(/\\/g, '/') === '/test/project/.claude/skills') {
					return [{ name: 'Research', isDirectory: () => true }] as any;
				}
				const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
				throw enoent;
			});
			vi.mocked(fs.promises.readFile).mockImplementation(async (filePath: any) => {
				const p = String(filePath).replace(/\\/g, '/');
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
				if (String(dir).replace(/\\/g, '/').includes('/test/.opencode/commands')) {
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
				if (
					String(dir).replace(/\\/g, '/') ===
					`${String(homeDir).replace(/\\/g, '/')}/.opencode/commands`
				) {
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
				if (String(dir).replace(/\\/g, '/').includes('/test/.opencode/commands')) {
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
				if (String(filePath).replace(/\\/g, '/').includes('/test/opencode.json')) {
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
});
