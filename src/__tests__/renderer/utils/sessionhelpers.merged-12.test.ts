// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/renderer/utils/sessionHelpers.test.ts
// Source: src/__tests__/renderer/utils/sessionValidation.test.ts
// Source: src/__tests__/renderer/utils/shortcutMatch.test.ts
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
import {
	validateNewSession,
	SessionValidationResult,
} from '../../../renderer/utils/sessionValidation';
import type { Session, ToolType } from '../../../renderer/types';
import { createMockSession } from '../../helpers/mockSession';
import {
	eventMatchesShortcutKeys,
	type ShortcutKeyEvent,
} from '../../../renderer/utils/shortcutMatch';
// Mock the generateId function to return predictable IDs
vi.mock('../../../renderer/utils/ids', () => ({
	generateId: vi.fn(() => 'mock-generated-id'),
}));
// Source: src/__tests__/renderer/utils/sessionHelpers.test.ts
describe('', () => {
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
					prompts: {
						get: vi.fn().mockResolvedValue({
							success: true,
							content: 'Maestro System Context: {{AGENT_NAME}}',
						}),
					},
					history: {
						getFilePath: vi.fn().mockResolvedValue(null),
					},
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
});
// Source: src/__tests__/renderer/utils/sessionValidation.test.ts
describe('', () => {
	describe('sessionValidation', () => {
		describe('validateNewSession', () => {
			describe('name uniqueness', () => {
				it('returns valid when no sessions exist', () => {
					const result = validateNewSession('New Session', '/path/to/project', 'claude-code', []);
					expect(result.valid).toBe(true);
					expect(result.error).toBeUndefined();
					expect(result.errorField).toBeUndefined();
				});
				it('returns valid when name is unique', () => {
					const existingSessions = [createMockSession({ name: 'Existing Session' })];
					const result = validateNewSession(
						'New Session',
						'/path/to/project',
						'claude-code',
						existingSessions
					);
					expect(result.valid).toBe(true);
				});
				it('returns error when name already exists (exact match)', () => {
					const existingSessions = [createMockSession({ name: 'My Project' })];
					const result = validateNewSession(
						'My Project',
						'/different/path',
						'claude-code',
						existingSessions
					);
					expect(result.valid).toBe(false);
					expect(result.errorField).toBe('name');
					expect(result.error).toContain('My Project');
					expect(result.error).toContain('already exists');
				});
				it('returns error when name matches case-insensitively', () => {
					const existingSessions = [createMockSession({ name: 'My Project' })];
					const result = validateNewSession(
						'my project',
						'/different/path',
						'claude-code',
						existingSessions
					);
					expect(result.valid).toBe(false);
					expect(result.errorField).toBe('name');
				});
				it('returns error when name matches with different casing (uppercase)', () => {
					const existingSessions = [createMockSession({ name: 'my project' })];
					const result = validateNewSession(
						'MY PROJECT',
						'/different/path',
						'claude-code',
						existingSessions
					);
					expect(result.valid).toBe(false);
					expect(result.errorField).toBe('name');
				});
				it('handles names with leading/trailing whitespace in comparison', () => {
					const existingSessions = [createMockSession({ name: 'My Project' })];
					// Note: The validation function expects trimmed input from the caller
					// This tests that exact matches work correctly
					const result = validateNewSession(
						'My Project',
						'/different/path',
						'claude-code',
						existingSessions
					);
					expect(result.valid).toBe(false);
				});
				it('allows similar but different names', () => {
					const existingSessions = [createMockSession({ name: 'My Project' })];
					const result = validateNewSession(
						'My Project 2',
						'/different/path',
						'claude-code',
						existingSessions
					);
					expect(result.valid).toBe(true);
				});
			});
			describe('directory warnings (user can acknowledge and proceed)', () => {
				it('returns valid when directory is unique', () => {
					const existingSessions = [createMockSession({ projectRoot: '/Users/test/project-a' })];
					const result = validateNewSession(
						'New Session',
						'/Users/test/project-b',
						'claude-code',
						existingSessions
					);
					expect(result.valid).toBe(true);
					expect(result.warning).toBeUndefined();
				});
				it('returns warning when directory already exists for same provider', () => {
					const existingSessions = [
						createMockSession({
							name: 'Existing Agent',
							projectRoot: '/Users/test/project',
							toolType: 'claude-code',
						}),
					];
					const result = validateNewSession(
						'New Session',
						'/Users/test/project',
						'claude-code',
						existingSessions
					);
					// Warning, not error - user can proceed after acknowledgment
					expect(result.valid).toBe(true);
					expect(result.warning).toBeDefined();
					expect(result.warningField).toBe('directory');
					expect(result.warning).toContain('Existing Agent');
					expect(result.warning).toContain('clobber');
					expect(result.conflictingAgents).toEqual(['Existing Agent']);
				});
				it('returns warning when directory already exists for different provider', () => {
					const existingSessions = [
						createMockSession({
							name: 'Claude Agent',
							projectRoot: '/Users/test/project',
							toolType: 'claude-code',
						}),
					];
					// Different provider (factory-droid) also gets a warning now
					const result = validateNewSession(
						'Factory Droid Agent',
						'/Users/test/project',
						'factory-droid',
						existingSessions
					);
					expect(result.valid).toBe(true);
					expect(result.warning).toBeDefined();
					expect(result.warningField).toBe('directory');
					expect(result.conflictingAgents).toEqual(['Claude Agent']);
				});
				it('handles directory comparison case-insensitively', () => {
					const existingSessions = [
						createMockSession({
							name: 'Existing',
							projectRoot: '/Users/Test/Project',
							toolType: 'claude-code',
						}),
					];
					const result = validateNewSession(
						'New Session',
						'/users/test/project',
						'claude-code',
						existingSessions
					);
					expect(result.valid).toBe(true);
					expect(result.warning).toBeDefined();
					expect(result.warningField).toBe('directory');
				});
				it('normalizes trailing slashes in directory comparison', () => {
					const existingSessions = [
						createMockSession({
							name: 'Existing',
							projectRoot: '/Users/test/project/',
							toolType: 'claude-code',
						}),
					];
					const result = validateNewSession(
						'New Session',
						'/Users/test/project',
						'claude-code',
						existingSessions
					);
					expect(result.valid).toBe(true);
					expect(result.warning).toBeDefined();
					expect(result.warningField).toBe('directory');
				});
				it('normalizes multiple trailing slashes', () => {
					const existingSessions = [
						createMockSession({
							name: 'Existing',
							projectRoot: '/Users/test/project///',
							toolType: 'claude-code',
						}),
					];
					const result = validateNewSession(
						'New Session',
						'/Users/test/project',
						'claude-code',
						existingSessions
					);
					expect(result.valid).toBe(true);
					expect(result.warning).toBeDefined();
					expect(result.warningField).toBe('directory');
				});
				it('uses cwd as fallback when projectRoot is not set', () => {
					const existingSessions = [
						createMockSession({
							name: 'Existing',
							cwd: '/Users/test/project',
							projectRoot: undefined as unknown as string,
							toolType: 'claude-code',
						}),
					];
					const result = validateNewSession(
						'New Session',
						'/Users/test/project',
						'claude-code',
						existingSessions
					);
					expect(result.valid).toBe(true);
					expect(result.warning).toBeDefined();
					expect(result.warningField).toBe('directory');
				});
				it('lists multiple conflicting agents in warning', () => {
					const existingSessions = [
						createMockSession({
							name: 'Agent 1',
							projectRoot: '/Users/test/project',
							toolType: 'claude-code',
						}),
						createMockSession({
							name: 'Agent 2',
							projectRoot: '/Users/test/project',
							toolType: 'factory-droid',
						}),
					];
					const result = validateNewSession(
						'New Agent',
						'/Users/test/project',
						'codex',
						existingSessions
					);
					expect(result.valid).toBe(true);
					expect(result.warning).toBeDefined();
					expect(result.warning).toContain('Agent 1');
					expect(result.warning).toContain('Agent 2');
					expect(result.conflictingAgents).toEqual(['Agent 1', 'Agent 2']);
				});
			});
			describe('multiple sessions', () => {
				it('validates against all existing sessions', () => {
					const existingSessions = [
						createMockSession({
							name: 'Session 1',
							projectRoot: '/path/one',
							toolType: 'claude-code',
						}),
						createMockSession({
							name: 'Session 2',
							projectRoot: '/path/two',
							toolType: 'claude-code',
						}),
						createMockSession({
							name: 'Session 3',
							projectRoot: '/path/three',
							toolType: 'factory-droid',
						}),
					];
					// Unique name and directory - no warning
					const uniqueResult = validateNewSession(
						'Session 4',
						'/path/four',
						'claude-code',
						existingSessions
					);
					expect(uniqueResult.valid).toBe(true);
					expect(uniqueResult.warning).toBeUndefined();
					// Duplicate name - hard error
					expect(
						validateNewSession('Session 2', '/path/four', 'claude-code', existingSessions).valid
					).toBe(false);
					// Duplicate directory for same provider - warning, still valid
					const sameDirResult = validateNewSession(
						'Session 4',
						'/path/two',
						'claude-code',
						existingSessions
					);
					expect(sameDirResult.valid).toBe(true);
					expect(sameDirResult.warning).toBeDefined();
					// Same directory but different provider - also warning now
					const diffProviderResult = validateNewSession(
						'Session 4',
						'/path/two',
						'factory-droid',
						existingSessions
					);
					expect(diffProviderResult.valid).toBe(true);
					expect(diffProviderResult.warning).toBeDefined();
				});
				it('name check takes priority over directory check', () => {
					const existingSessions = [
						createMockSession({
							name: 'My Agent',
							projectRoot: '/path/one',
							toolType: 'claude-code',
						}),
					];
					// Both name and directory match - should get name error (not warning)
					const result = validateNewSession(
						'My Agent',
						'/path/one',
						'claude-code',
						existingSessions
					);
					expect(result.valid).toBe(false);
					expect(result.errorField).toBe('name');
					expect(result.warning).toBeUndefined(); // Error takes precedence
				});
			});
			describe('warning messages', () => {
				it('includes conflicting agent name in warning', () => {
					const existingSessions = [
						createMockSession({
							name: 'Existing',
							projectRoot: '/path',
							toolType: 'claude-code',
						}),
					];
					const result = validateNewSession('New', '/path', 'claude-code', existingSessions);
					expect(result.warning).toContain('Existing');
				});
				it('warns regardless of provider type', () => {
					const existingSessions = [
						createMockSession({
							name: 'Existing',
							projectRoot: '/path',
							toolType: 'factory-droid',
						}),
					];
					const result = validateNewSession('New', '/path', 'factory-droid', existingSessions);
					expect(result.valid).toBe(true);
					expect(result.warning).toBeDefined();
					expect(result.warning).toContain('Existing');
				});
				it('warns for terminal sessions too', () => {
					const existingSessions = [
						createMockSession({
							name: 'Existing',
							projectRoot: '/path',
							toolType: 'terminal',
						}),
					];
					const result = validateNewSession('New', '/path', 'terminal', existingSessions);
					expect(result.valid).toBe(true);
					expect(result.warning).toBeDefined();
					expect(result.warning).toContain('Existing');
				});
			});
			describe('SSH host awareness', () => {
				it('does not warn when same directory but different SSH hosts', () => {
					const existingSessions = [
						createMockSession({
							name: 'SSH Agent',
							projectRoot: '/home/user/project',
							toolType: 'claude-code',
							sshRemoteId: 'ssh-remote-1',
						}),
					];
					const result = validateNewSession(
						'Local Agent',
						'/home/user/project',
						'claude-code',
						existingSessions,
						'ssh-remote-2'
					);
					expect(result.valid).toBe(true);
					expect(result.warning).toBeUndefined();
				});
				it('does not warn when same directory but one is local and one is SSH', () => {
					const existingSessions = [
						createMockSession({
							name: 'SSH Agent',
							projectRoot: '/Users/test/project',
							toolType: 'claude-code',
							sshRemoteId: 'ssh-remote-1',
						}),
					];
					// New agent is local (no sshRemoteId)
					const result = validateNewSession(
						'Local Agent',
						'/Users/test/project',
						'claude-code',
						existingSessions
					);
					expect(result.valid).toBe(true);
					expect(result.warning).toBeUndefined();
				});
				it('does not warn when local agent exists and new agent is SSH', () => {
					const existingSessions = [
						createMockSession({
							name: 'Local Agent',
							projectRoot: '/Users/test/project',
							toolType: 'claude-code',
						}),
					];
					const result = validateNewSession(
						'SSH Agent',
						'/Users/test/project',
						'claude-code',
						existingSessions,
						'ssh-remote-1'
					);
					expect(result.valid).toBe(true);
					expect(result.warning).toBeUndefined();
				});
				it('warns when same directory and same SSH host', () => {
					const existingSessions = [
						createMockSession({
							name: 'SSH Agent 1',
							projectRoot: '/home/user/project',
							toolType: 'claude-code',
							sshRemoteId: 'ssh-remote-1',
						}),
					];
					const result = validateNewSession(
						'SSH Agent 2',
						'/home/user/project',
						'claude-code',
						existingSessions,
						'ssh-remote-1'
					);
					expect(result.valid).toBe(true);
					expect(result.warning).toBeDefined();
					expect(result.conflictingAgents).toEqual(['SSH Agent 1']);
				});
				it('warns when same directory and both are local', () => {
					const existingSessions = [
						createMockSession({
							name: 'Local Agent 1',
							projectRoot: '/Users/test/project',
							toolType: 'claude-code',
						}),
					];
					const result = validateNewSession(
						'Local Agent 2',
						'/Users/test/project',
						'claude-code',
						existingSessions
					);
					expect(result.valid).toBe(true);
					expect(result.warning).toBeDefined();
					expect(result.conflictingAgents).toEqual(['Local Agent 1']);
				});
				it('resolves SSH remote from sessionSshRemoteConfig (canonical source)', () => {
					const existingSessions = [
						createMockSession({
							name: 'SSH Agent',
							projectRoot: '/home/user/project',
							toolType: 'claude-code',
							sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-remote-1' },
						}),
					];
					// Same SSH remote should warn
					const sameResult = validateNewSession(
						'SSH Agent 2',
						'/home/user/project',
						'claude-code',
						existingSessions,
						'ssh-remote-1'
					);
					expect(sameResult.valid).toBe(true);
					expect(sameResult.warning).toBeDefined();
					expect(sameResult.conflictingAgents).toEqual(['SSH Agent']);
					// Different SSH remote should not warn
					const diffResult = validateNewSession(
						'SSH Agent 3',
						'/home/user/project',
						'claude-code',
						existingSessions,
						'ssh-remote-2'
					);
					expect(diffResult.valid).toBe(true);
					expect(diffResult.warning).toBeUndefined();
					// Local agent should not warn
					const localResult = validateNewSession(
						'Local Agent',
						'/home/user/project',
						'claude-code',
						existingSessions
					);
					expect(localResult.valid).toBe(true);
					expect(localResult.warning).toBeUndefined();
				});
				it('uses sshRemote.id as fallback when sshRemoteId is not set', () => {
					const existingSessions = [
						createMockSession({
							name: 'SSH Agent',
							projectRoot: '/home/user/project',
							toolType: 'claude-code',
							sshRemote: { id: 'ssh-remote-1', name: 'My Server', host: 'server.example.com' },
						}),
					];
					// Same SSH remote should warn
					const result = validateNewSession(
						'SSH Agent 2',
						'/home/user/project',
						'claude-code',
						existingSessions,
						'ssh-remote-1'
					);
					expect(result.valid).toBe(true);
					expect(result.warning).toBeDefined();
					expect(result.conflictingAgents).toEqual(['SSH Agent']);
				});
			});
			describe('edge cases', () => {
				it('handles empty session list', () => {
					const result = validateNewSession('Any Name', '/any/path', 'claude-code', []);
					expect(result.valid).toBe(true);
				});
				it('handles sessions with undefined toolType gracefully', () => {
					const existingSessions = [
						createMockSession({
							name: 'Existing',
							projectRoot: '/path',
							toolType: undefined as unknown as ToolType,
						}),
					];
					// Should not crash, warning because same directory
					const result = validateNewSession('New', '/path', 'claude-code', existingSessions);
					expect(result.valid).toBe(true);
					expect(result.warning).toBeDefined(); // Gets warning for same directory
				});
				it('handles very long paths', () => {
					const longPath = '/Users/test/' + 'a'.repeat(500) + '/project';
					const existingSessions = [
						createMockSession({
							name: 'Existing',
							projectRoot: longPath,
							toolType: 'claude-code',
						}),
					];
					const result = validateNewSession(
						'New Session',
						longPath,
						'claude-code',
						existingSessions
					);
					expect(result.valid).toBe(true);
					expect(result.warning).toBeDefined();
					expect(result.warningField).toBe('directory');
				});
				it('handles paths with special characters', () => {
					const specialPath = '/Users/test/my project (2024)/code-base';
					const existingSessions = [
						createMockSession({
							name: 'Existing',
							projectRoot: specialPath,
							toolType: 'claude-code',
						}),
					];
					const result = validateNewSession(
						'New Session',
						specialPath,
						'claude-code',
						existingSessions
					);
					expect(result.valid).toBe(true);
					expect(result.warning).toBeDefined();
					expect(result.warningField).toBe('directory');
				});
				it('handles unicode in session names', () => {
					const existingSessions = [createMockSession({ name: 'Project café 日本語' })];
					const result = validateNewSession(
						'Project café 日本語',
						'/different/path',
						'claude-code',
						existingSessions
					);
					expect(result.valid).toBe(false);
					expect(result.errorField).toBe('name');
				});
				it('handles emoji in session names', () => {
					const existingSessions = [createMockSession({ name: '🚀 My Project' })];
					const result = validateNewSession(
						'🚀 My Project',
						'/different/path',
						'claude-code',
						existingSessions
					);
					expect(result.valid).toBe(false);
					expect(result.errorField).toBe('name');
				});
			});
			describe('return value contract', () => {
				it('returns SessionValidationResult interface for valid result', () => {
					const result: SessionValidationResult = validateNewSession(
						'Test',
						'/path',
						'claude-code',
						[]
					);
					expect(result).toHaveProperty('valid');
					expect(typeof result.valid).toBe('boolean');
					expect(result.valid).toBe(true);
					expect(result.error).toBeUndefined();
					expect(result.errorField).toBeUndefined();
				});
				it('returns SessionValidationResult interface for invalid result', () => {
					const existingSessions = [createMockSession({ name: 'Test' })];
					const result: SessionValidationResult = validateNewSession(
						'Test',
						'/path',
						'claude-code',
						existingSessions
					);
					expect(result).toHaveProperty('valid');
					expect(result).toHaveProperty('error');
					expect(result).toHaveProperty('errorField');
					expect(typeof result.valid).toBe('boolean');
					expect(typeof result.error).toBe('string');
					expect(result.errorField).toBe('name');
				});
			});
		});
	});
});
// Source: src/__tests__/renderer/utils/shortcutMatch.test.ts
describe('', () => {
	function keyEvent(key: string, overrides: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent {
		return {
			key,
			metaKey: false,
			ctrlKey: false,
			shiftKey: false,
			altKey: false,
			...overrides,
		};
	}
	describe('eventMatchesShortcutKeys', () => {
		it('matches a plain modifier combination', () => {
			expect(eventMatchesShortcutKeys(keyEvent('k', { metaKey: true }), ['Meta', 'k'])).toBe(true);
		});
		it('treats Ctrl as Meta so one binding table serves both platforms', () => {
			expect(eventMatchesShortcutKeys(keyEvent('k', { ctrlKey: true }), ['Meta', 'k'])).toBe(true);
		});
		it('requires modifiers to match exactly, not merely to be present', () => {
			// Cmd+Shift+K must not fire the action bound to Cmd+K.
			expect(
				eventMatchesShortcutKeys(keyEvent('k', { metaKey: true, shiftKey: true }), ['Meta', 'k'])
			).toBe(false);
			expect(eventMatchesShortcutKeys(keyEvent('k'), ['Meta', 'k'])).toBe(false);
		});
		it('accepts the character Shift produces for punctuation', () => {
			// Cmd+Shift+. reports '>' on a US layout; the binding names '.'.
			expect(
				eventMatchesShortcutKeys(keyEvent('>', { metaKey: true, shiftKey: true }), [
					'Meta',
					'Shift',
					'.',
				])
			).toBe(true);
			expect(
				eventMatchesShortcutKeys(keyEvent('{', { metaKey: true, shiftKey: true }), [
					'Meta',
					'Shift',
					'[',
				])
			).toBe(true);
		});
		it('accepts the symbol Shift produces for a number key', () => {
			expect(
				eventMatchesShortcutKeys(keyEvent('!', { metaKey: true, shiftKey: true }), [
					'Meta',
					'Shift',
					'1',
				])
			).toBe(true);
		});
		it('falls back to the physical key when Alt rewrites the character', () => {
			// macOS turns Opt+P into 'π' and Opt+, into '≤'.
			expect(
				eventMatchesShortcutKeys(keyEvent('π', { altKey: true, code: 'KeyP' }), ['Alt', 'p'])
			).toBe(true);
			expect(
				eventMatchesShortcutKeys(keyEvent('≤', { altKey: true, code: 'Comma' }), ['Alt', ','])
			).toBe(true);
		});
		it('matches named keys', () => {
			expect(
				eventMatchesShortcutKeys(keyEvent('Enter', { metaKey: true, shiftKey: true }), [
					'Meta',
					'Shift',
					'Enter',
				])
			).toBe(true);
			expect(
				eventMatchesShortcutKeys(keyEvent('ArrowDown', { metaKey: true }), ['Meta', 'ArrowDown'])
			).toBe(true);
		});
		it('never matches an unassigned action', () => {
			// An empty binding reads as "no modifiers, no main key", so without this
			// guard a bare keypress would fire an action the user left unbound.
			expect(eventMatchesShortcutKeys(keyEvent('a'), [])).toBe(false);
			expect(eventMatchesShortcutKeys(keyEvent('a'), undefined)).toBe(false);
		});
	});
});
