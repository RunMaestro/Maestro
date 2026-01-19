/**
 * Tests for sessionHelpers.ts - Session creation utilities for cross-agent context transfer
 *
 * Functions tested:
 * - buildSpawnConfigForAgent
 * - createSessionForAgent
 * - agentSupportsContextTransfer
 * - getAgentInfo
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	buildSpawnConfigForAgent,
	createSessionForAgent,
	agentSupportsContextTransfer,
	getAgentInfo,
	getSessionSshRemoteId,
	isSessionRemote,
	type SessionSshInfo,
} from '../../../renderer/utils/sessionHelpers';
import type { AgentConfig, AgentCapabilities } from '../../../renderer/types';

// Mock the generateId function to return predictable IDs
vi.mock('../../../renderer/utils/ids', () => ({
	generateId: vi.fn(() => 'mock-generated-id'),
}));

// Create a mock for window.maestro
const mockAgentsApi = {
	get: vi.fn(),
	getCapabilities: vi.fn(),
};

// Store original window.maestro
const originalMaestro = (global as any).window?.maestro;

describe('sessionHelpers', () => {
	beforeEach(() => {
		vi.clearAllMocks();

		// Setup window.maestro mock
		(global as any).window = {
			maestro: {
				agents: mockAgentsApi,
			},
		};
	});

	afterEach(() => {
		// Restore original window.maestro if it existed
		if (originalMaestro) {
			(global as any).window = { maestro: originalMaestro };
		} else {
			delete (global as any).window;
		}
	});

	// Helper to create a mock AgentConfig
	function createMockAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
		return {
			id: 'claude-code',
			name: 'Claude Code',
			command: 'claude',
			args: ['--print', '--verbose'],
			available: true,
			path: '/usr/local/bin/claude',
			capabilities: {
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
				supportsStreaming: true,
				supportsResultMessages: true,
				supportsModelSelection: false,
				supportsStreamJsonInput: true,
				supportsContextMerge: true,
				supportsContextExport: true,
			} as AgentCapabilities,
			...overrides,
		};
	}

	describe('buildSpawnConfigForAgent', () => {
		it('returns null when agent is not found', async () => {
			mockAgentsApi.get.mockResolvedValue(null);

			const result = await buildSpawnConfigForAgent({
				sessionId: 'test-session',
				toolType: 'unknown-agent' as any,
				cwd: '/test/path',
			});

			expect(result).toBeNull();
			expect(mockAgentsApi.get).toHaveBeenCalledWith('unknown-agent');
		});

		it('returns null when agent is not available', async () => {
			mockAgentsApi.get.mockResolvedValue(createMockAgentConfig({ available: false }));

			const result = await buildSpawnConfigForAgent({
				sessionId: 'test-session',
				toolType: 'claude-code',
				cwd: '/test/path',
			});

			expect(result).toBeNull();
		});

		it('builds spawn config with agent path when available', async () => {
			const agentConfig = createMockAgentConfig({
				path: '/custom/path/to/claude',
			});
			mockAgentsApi.get.mockResolvedValue(agentConfig);

			const result = await buildSpawnConfigForAgent({
				sessionId: 'test-session',
				toolType: 'claude-code',
				cwd: '/test/path',
				prompt: 'Hello, world!',
			});

			expect(result).not.toBeNull();
			expect(result!.command).toBe('/custom/path/to/claude');
			expect(result!.sessionId).toBe('test-session');
			expect(result!.toolType).toBe('claude-code');
			expect(result!.cwd).toBe('/test/path');
			expect(result!.prompt).toBe('Hello, world!');
			expect(result!.args).toEqual(['--print', '--verbose']);
		});

		it('uses agent command when path is not available', async () => {
			const agentConfig = createMockAgentConfig({
				path: undefined,
				command: 'claude',
			});
			mockAgentsApi.get.mockResolvedValue(agentConfig);

			const result = await buildSpawnConfigForAgent({
				sessionId: 'test-session',
				toolType: 'claude-code',
				cwd: '/test/path',
			});

			expect(result).not.toBeNull();
			expect(result!.command).toBe('claude');
		});

		it('includes optional spawn options when provided', async () => {
			mockAgentsApi.get.mockResolvedValue(createMockAgentConfig());

			const result = await buildSpawnConfigForAgent({
				sessionId: 'test-session',
				toolType: 'claude-code',
				cwd: '/test/path',
				prompt: 'Test prompt',
				agentSessionId: 'agent-session-123',
				readOnlyMode: true,
				modelId: 'custom-model',
				yoloMode: true,
			});

			expect(result).not.toBeNull();
			expect(result!.agentSessionId).toBe('agent-session-123');
			expect(result!.readOnlyMode).toBe(true);
			expect(result!.modelId).toBe('custom-model');
			expect(result!.yoloMode).toBe(true);
		});

		it('includes per-session custom overrides when provided', async () => {
			mockAgentsApi.get.mockResolvedValue(createMockAgentConfig());

			const customEnvVars = { CUSTOM_VAR: 'value' };

			const result = await buildSpawnConfigForAgent({
				sessionId: 'test-session',
				toolType: 'claude-code',
				cwd: '/test/path',
				sessionCustomPath: '/custom/path',
				sessionCustomArgs: '--custom-arg',
				sessionCustomEnvVars: customEnvVars,
				sessionCustomModel: 'custom-model',
				sessionCustomContextWindow: 128000,
			});

			expect(result).not.toBeNull();
			expect(result!.sessionCustomPath).toBe('/custom/path');
			expect(result!.sessionCustomArgs).toBe('--custom-arg');
			expect(result!.sessionCustomEnvVars).toEqual(customEnvVars);
			expect(result!.sessionCustomModel).toBe('custom-model');
			expect(result!.sessionCustomContextWindow).toBe(128000);
		});

		it('handles agents with empty args array', async () => {
			mockAgentsApi.get.mockResolvedValue(createMockAgentConfig({ args: undefined }));

			const result = await buildSpawnConfigForAgent({
				sessionId: 'test-session',
				toolType: 'claude-code',
				cwd: '/test/path',
			});

			expect(result).not.toBeNull();
			expect(result!.args).toEqual([]);
		});
	});

	describe('createSessionForAgent', () => {
		it('returns null when agent is not found', async () => {
			mockAgentsApi.get.mockResolvedValue(null);

			const result = await createSessionForAgent({
				agentType: 'unknown-agent' as any,
				projectRoot: '/test/path',
				name: 'Test Session',
				initialContext: 'Hello, world!',
			});

			expect(result).toBeNull();
		});

		it('returns null when agent is not available', async () => {
			mockAgentsApi.get.mockResolvedValue(createMockAgentConfig({ available: false }));

			const result = await createSessionForAgent({
				agentType: 'claude-code',
				projectRoot: '/test/path',
				name: 'Test Session',
				initialContext: 'Hello, world!',
			});

			expect(result).toBeNull();
		});

		it('creates session with correct structure', async () => {
			mockAgentsApi.get.mockResolvedValue(createMockAgentConfig());

			const result = await createSessionForAgent({
				agentType: 'claude-code',
				projectRoot: '/test/project',
				name: 'Transfer → Claude Code',
				initialContext: 'Context from previous session',
			});

			expect(result).not.toBeNull();
			expect(result!.session).toBeDefined();
			expect(result!.tabId).toBeDefined();
			expect(result!.spawnConfig).toBeDefined();

			// Verify session structure
			const session = result!.session;
			expect(session.name).toBe('Transfer → Claude Code');
			expect(session.toolType).toBe('claude-code');
			expect(session.projectRoot).toBe('/test/project');
			expect(session.cwd).toBe('/test/project');
			expect(session.state).toBe('idle');
			expect(session.aiTabs).toHaveLength(1);
		});

		it('sets initial context as prompt in spawn config', async () => {
			mockAgentsApi.get.mockResolvedValue(createMockAgentConfig());

			const initialContext = 'This is the transferred context from another agent.';

			const result = await createSessionForAgent({
				agentType: 'claude-code',
				projectRoot: '/test/project',
				name: 'Test Session',
				initialContext,
			});

			expect(result).not.toBeNull();
			expect(result!.spawnConfig.prompt).toBe(initialContext);
		});

		it('includes group ID when provided', async () => {
			mockAgentsApi.get.mockResolvedValue(createMockAgentConfig());

			const result = await createSessionForAgent({
				agentType: 'claude-code',
				projectRoot: '/test/project',
				name: 'Test Session',
				initialContext: 'Context',
				groupId: 'group-123',
			});

			expect(result).not.toBeNull();
			expect(result!.session.groupId).toBe('group-123');
		});

		it('respects saveToHistory option', async () => {
			mockAgentsApi.get.mockResolvedValue(createMockAgentConfig());

			const result = await createSessionForAgent({
				agentType: 'claude-code',
				projectRoot: '/test/project',
				name: 'Test Session',
				initialContext: 'Context',
				saveToHistory: false,
			});

			expect(result).not.toBeNull();
			// The saveToHistory flag is passed to the tab
			const activeTab = result!.session.aiTabs[0];
			expect(activeTab.saveToHistory).toBe(false);
		});

		it('creates spawn config with readOnlyMode false by default', async () => {
			mockAgentsApi.get.mockResolvedValue(createMockAgentConfig());

			const result = await createSessionForAgent({
				agentType: 'claude-code',
				projectRoot: '/test/project',
				name: 'Test Session',
				initialContext: 'Context',
			});

			expect(result).not.toBeNull();
			expect(result!.spawnConfig.readOnlyMode).toBe(false);
		});

		it('creates session with empty merged logs (context sent as prompt)', async () => {
			mockAgentsApi.get.mockResolvedValue(createMockAgentConfig());

			const result = await createSessionForAgent({
				agentType: 'claude-code',
				projectRoot: '/test/project',
				name: 'Test Session',
				initialContext: 'Large context here',
			});

			expect(result).not.toBeNull();
			// Logs should be empty - context is sent as the initial prompt
			const activeTab = result!.session.aiTabs[0];
			expect(activeTab.logs).toHaveLength(0);
		});
	});

	describe('agentSupportsContextTransfer', () => {
		it('returns true when agent supports context merge', async () => {
			mockAgentsApi.getCapabilities.mockResolvedValue({
				supportsContextMerge: true,
			} as AgentCapabilities);

			const result = await agentSupportsContextTransfer('claude-code');

			expect(result).toBe(true);
			expect(mockAgentsApi.getCapabilities).toHaveBeenCalledWith('claude-code');
		});

		it('returns false when agent does not support context merge', async () => {
			mockAgentsApi.getCapabilities.mockResolvedValue({
				supportsContextMerge: false,
			} as AgentCapabilities);

			const result = await agentSupportsContextTransfer('terminal' as any);

			expect(result).toBe(false);
		});

		it('returns false when capabilities is null', async () => {
			mockAgentsApi.getCapabilities.mockResolvedValue(null);

			const result = await agentSupportsContextTransfer('unknown' as any);

			expect(result).toBe(false);
		});

		it('returns false when supportsContextMerge is undefined', async () => {
			mockAgentsApi.getCapabilities.mockResolvedValue({} as AgentCapabilities);

			const result = await agentSupportsContextTransfer('claude-code');

			expect(result).toBe(false);
		});
	});

	describe('getAgentInfo', () => {
		it('returns agent info when agent exists', async () => {
			const agentConfig = createMockAgentConfig({
				name: 'Claude Code',
				available: true,
			});
			mockAgentsApi.get.mockResolvedValue(agentConfig);

			const result = await getAgentInfo('claude-code');

			expect(result).not.toBeNull();
			expect(result!.name).toBe('Claude Code');
			expect(result!.available).toBe(true);
			expect(result!.capabilities).toBeDefined();
		});

		it('returns null when agent is not found', async () => {
			mockAgentsApi.get.mockResolvedValue(null);

			const result = await getAgentInfo('unknown' as any);

			expect(result).toBeNull();
		});

		it('returns correct availability status', async () => {
			mockAgentsApi.get.mockResolvedValue(createMockAgentConfig({ available: false }));

			const result = await getAgentInfo('claude-code');

			expect(result).not.toBeNull();
			expect(result!.available).toBe(false);
		});
	});

	describe('integration scenarios', () => {
		it('handles OpenCode agent correctly', async () => {
			const openCodeConfig = createMockAgentConfig({
				id: 'opencode',
				name: 'OpenCode',
				command: 'opencode',
				path: '/usr/local/bin/opencode',
				args: [],
				capabilities: {
					supportsResume: true,
					supportsReadOnlyMode: true,
					supportsJsonOutput: true,
					supportsSessionId: true,
					supportsImageInput: true,
					supportsImageInputOnResume: true,
					supportsSlashCommands: false,
					supportsSessionStorage: true,
					supportsCostTracking: true,
					supportsUsageStats: true,
					supportsBatchMode: true,
					supportsStreaming: true,
					supportsResultMessages: true,
					supportsModelSelection: true,
					supportsStreamJsonInput: false,
					supportsContextMerge: true,
					supportsContextExport: true,
				} as AgentCapabilities,
			});
			mockAgentsApi.get.mockResolvedValue(openCodeConfig);

			const result = await createSessionForAgent({
				agentType: 'opencode' as any,
				projectRoot: '/test/project',
				name: 'Transfer → OpenCode',
				initialContext: 'Context from Claude Code',
			});

			expect(result).not.toBeNull();
			expect(result!.session.toolType).toBe('opencode');
			expect(result!.spawnConfig.command).toBe('/usr/local/bin/opencode');
		});

		it('handles Codex agent correctly', async () => {
			const codexConfig = createMockAgentConfig({
				id: 'codex',
				name: 'Codex',
				command: 'codex',
				path: '/usr/local/bin/codex',
				args: [],
				capabilities: {
					supportsResume: true,
					supportsReadOnlyMode: true,
					supportsJsonOutput: true,
					supportsSessionId: true,
					supportsImageInput: true,
					supportsImageInputOnResume: false,
					supportsSlashCommands: false,
					supportsSessionStorage: true,
					supportsCostTracking: false,
					supportsUsageStats: true,
					supportsBatchMode: true,
					supportsStreaming: true,
					supportsResultMessages: false,
					supportsModelSelection: true,
					supportsStreamJsonInput: false,
					supportsContextMerge: true,
					supportsContextExport: true,
				} as AgentCapabilities,
			});
			mockAgentsApi.get.mockResolvedValue(codexConfig);

			const result = await createSessionForAgent({
				agentType: 'codex' as any,
				projectRoot: '/test/project',
				name: 'Transfer → Codex',
				initialContext: 'Context from Claude Code',
			});

			expect(result).not.toBeNull();
			expect(result!.session.toolType).toBe('codex');
			expect(result!.spawnConfig.command).toBe('/usr/local/bin/codex');
		});
	});

	describe('getSessionSshRemoteId', () => {
		it('returns undefined for null session', () => {
			expect(getSessionSshRemoteId(null)).toBeUndefined();
		});

		it('returns undefined for undefined session', () => {
			expect(getSessionSshRemoteId(undefined)).toBeUndefined();
		});

		it('returns undefined for local session (no SSH config)', () => {
			const session: SessionSshInfo = {};
			expect(getSessionSshRemoteId(session)).toBeUndefined();
		});

		it('returns sshRemoteId when set (AI agent has spawned)', () => {
			const session: SessionSshInfo = {
				sshRemoteId: 'my-remote-server',
			};
			expect(getSessionSshRemoteId(session)).toBe('my-remote-server');
		});

		it('returns sessionSshRemoteConfig.remoteId when sshRemoteId is not set (terminal-only SSH)', () => {
			// This is the critical case that was previously broken!
			// sshRemoteId is only set AFTER the AI agent spawns.
			// For terminal-only SSH sessions, we must fall back to sessionSshRemoteConfig.remoteId
			const session: SessionSshInfo = {
				sshRemoteId: undefined, // Not set because AI agent hasn't spawned
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'my-ssh-config-id',
				},
			};
			expect(getSessionSshRemoteId(session)).toBe('my-ssh-config-id');
		});

		it('prefers sshRemoteId over sessionSshRemoteConfig.remoteId when both are set', () => {
			// Once AI agent spawns, sshRemoteId should take precedence
			const session: SessionSshInfo = {
				sshRemoteId: 'spawned-remote-id',
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'config-remote-id',
				},
			};
			expect(getSessionSshRemoteId(session)).toBe('spawned-remote-id');
		});

		it('returns undefined when sessionSshRemoteConfig.remoteId is null', () => {
			const session: SessionSshInfo = {
				sessionSshRemoteConfig: {
					enabled: false,
					remoteId: null,
				},
			};
			expect(getSessionSshRemoteId(session)).toBeUndefined();
		});

		it('handles empty string sshRemoteId by falling back to config', () => {
			// Empty string is falsy, should fall back
			const session: SessionSshInfo = {
				sshRemoteId: '',
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'fallback-id',
				},
			};
			expect(getSessionSshRemoteId(session)).toBe('fallback-id');
		});
	});

	describe('isSessionRemote', () => {
		it('returns false for null session', () => {
			expect(isSessionRemote(null)).toBe(false);
		});

		it('returns false for undefined session', () => {
			expect(isSessionRemote(undefined)).toBe(false);
		});

		it('returns false for local session (no SSH config)', () => {
			const session: SessionSshInfo = {};
			expect(isSessionRemote(session)).toBe(false);
		});

		it('returns true when sshRemoteId is set', () => {
			const session: SessionSshInfo = {
				sshRemoteId: 'my-remote',
			};
			expect(isSessionRemote(session)).toBe(true);
		});

		it('returns true when sessionSshRemoteConfig.enabled is true (terminal-only SSH)', () => {
			// This is the critical case - sessionSshRemoteConfig.enabled indicates
			// user intent even before AI agent spawns
			const session: SessionSshInfo = {
				sshRemoteId: undefined,
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'my-remote',
				},
			};
			expect(isSessionRemote(session)).toBe(true);
		});

		it('returns false when sessionSshRemoteConfig.enabled is false', () => {
			const session: SessionSshInfo = {
				sessionSshRemoteConfig: {
					enabled: false,
					remoteId: null,
				},
			};
			expect(isSessionRemote(session)).toBe(false);
		});

		it('returns true when both sshRemoteId and sessionSshRemoteConfig are set', () => {
			const session: SessionSshInfo = {
				sshRemoteId: 'active-remote',
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'config-remote',
				},
			};
			expect(isSessionRemote(session)).toBe(true);
		});
	});

	describe('SSH Remote ID fallback regression prevention', () => {
		/**
		 * This test documents the exact bug pattern that must be avoided.
		 *
		 * WRONG pattern (causes SSH graph/file operations to fail):
		 *   const sshId = session.sshRemoteId;
		 *
		 * CORRECT pattern:
		 *   const sshId = getSessionSshRemoteId(session);
		 *
		 * The bug occurs because sshRemoteId is only populated AFTER the AI agent
		 * spawns via the onSshRemote callback. For terminal-only SSH sessions or
		 * before AI spawn, sshRemoteId is undefined even though the session is remote.
		 */
		it('demonstrates why direct sshRemoteId access fails for pre-spawn SSH sessions', () => {
			// Simulate a session that has SSH configured but AI hasn't spawned yet
			const preSpawnSession: SessionSshInfo = {
				sshRemoteId: undefined, // NOT YET SET - AI hasn't spawned
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'rssidian-server', // User configured this in SSH settings
				},
			};

			// WRONG: Direct access returns undefined, causing local file operations to be attempted
			const wrongSshId = preSpawnSession.sshRemoteId;
			expect(wrongSshId).toBeUndefined(); // This would cause SSH operations to fail!

			// CORRECT: Use the helper function which handles the fallback
			const correctSshId = getSessionSshRemoteId(preSpawnSession);
			expect(correctSshId).toBe('rssidian-server'); // This works correctly!
		});

		it('demonstrates the bug with isRemote check', () => {
			const preSpawnSession: SessionSshInfo = {
				sshRemoteId: undefined,
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'remote-host',
				},
			};

			// WRONG: Direct check returns false
			const wrongIsRemote = !!preSpawnSession.sshRemoteId;
			expect(wrongIsRemote).toBe(false); // Wrong! This IS a remote session

			// CORRECT: Use the helper function
			const correctIsRemote = isSessionRemote(preSpawnSession);
			expect(correctIsRemote).toBe(true); // Correct!
		});
	});
});
