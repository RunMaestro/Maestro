/**
 * Tests for agentStore - Agent lifecycle orchestration store
 *
 * Tests agent detection caching, error recovery actions, and agent lifecycle
 * (kill, interrupt). The store orchestrates sessionStore mutations + IPC calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
	useAgentStore,
	selectAvailableAgents,
	selectAgentsDetected,
	getAgentState,
	getAgentActions,
} from '../../../renderer/stores/agentStore';
import type { ProcessQueuedItemDeps } from '../../../renderer/stores/agentStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import type { Session, AgentConfig, QueuedItem } from '../../../renderer/types';

// ============================================================================
// Helpers
// ============================================================================

function createMockSession(overrides: Partial<Session> = {}): Session {
	const defaultTab = {
		id: 'default-tab',
		agentSessionId: null,
		name: null,
		starred: false,
		logs: [],
		inputValue: '',
		stagedImages: [],
		createdAt: Date.now(),
		state: 'idle' as const,
	};
	return {
		id: overrides.id ?? `session-${Math.random().toString(36).slice(2, 8)}`,
		name: overrides.name ?? 'Test Session',
		toolType: overrides.toolType ?? 'claude-code',
		state: overrides.state ?? 'idle',
		cwd: '/test',
		fullPath: '/test',
		projectRoot: '/test',
		aiLogs: [],
		shellLogs: [],
		workLog: [],
		contextUsage: 0,
		inputMode: overrides.inputMode ?? 'ai',
		aiPid: 0,
		terminalPid: 0,
		port: 0,
		isLive: false,
		changedFiles: [],
		isGitRepo: false,
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		executionQueue: [],
		activeTimeMs: 0,
		aiTabs: overrides.aiTabs ?? [defaultTab],
		activeTabId: overrides.activeTabId ?? defaultTab.id,
		closedTabHistory: [],
		filePreviewTabs: [],
		activeFileTabId: null,
		unifiedTabOrder: [{ type: 'ai' as const, id: defaultTab.id }],
		unifiedClosedTabHistory: [],
		...overrides,
	} as Session;
}

function createMockAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		id: overrides.id ?? 'claude-code',
		name: overrides.name ?? 'Claude Code',
		available: overrides.available ?? true,
		command: overrides.command ?? 'claude',
		...overrides,
	} as AgentConfig;
}

// ============================================================================
// Setup
// ============================================================================

// Mock window.maestro (add to existing window, don't replace it)
const mockSpawn = vi.fn().mockResolvedValue({ pid: 123, success: true });
const mockKill = vi.fn().mockResolvedValue(true);
const mockInterrupt = vi.fn().mockResolvedValue(true);
const mockDetect = vi.fn().mockResolvedValue([]);
const mockGetAgent = vi.fn().mockResolvedValue(null);
const mockClearError = vi.fn().mockResolvedValue(undefined);

(window as any).maestro = {
	process: {
		spawn: mockSpawn,
		kill: mockKill,
		interrupt: mockInterrupt,
	},
	agents: {
		detect: mockDetect,
		get: mockGetAgent,
	},
	agentError: {
		clearError: mockClearError,
	},
};

// Mock gitService
vi.mock('../../../renderer/services/git', () => ({
	gitService: {
		getStatus: vi.fn().mockResolvedValue({ branch: 'main', files: [] }),
	},
}));

// Mock prompts
vi.mock('../../../prompts', () => ({
	maestroSystemPrompt: 'Mock system prompt for {{CWD}}',
	autorunSynopsisPrompt: '',
	imageOnlyDefaultPrompt: 'Describe this image',
}));

// Mock substituteTemplateVariables — pass through the template as-is for simplicity
vi.mock('../../../renderer/utils/templateVariables', () => ({
	substituteTemplateVariables: vi.fn((template: string) => template),
}));

function resetStores() {
	useAgentStore.setState({
		availableAgents: [],
		agentsDetected: false,
	});
	useSessionStore.setState({
		sessions: [],
		groups: [],
		activeSessionId: '',
		sessionsLoaded: false,
		initialLoadComplete: false,
		removedWorktreePaths: new Set(),
		cyclePosition: -1,
	});
}

beforeEach(() => {
	resetStores();
	vi.clearAllMocks();
});

// ============================================================================
// Tests
// ============================================================================

describe('agentStore', () => {
	describe('initial state', () => {
		it('has empty available agents and agentsDetected false', () => {
			const state = useAgentStore.getState();
			expect(state.availableAgents).toEqual([]);
			expect(state.agentsDetected).toBe(false);
		});
	});

	describe('agent detection cache', () => {
		it('refreshAgents populates availableAgents from IPC', async () => {
			const agents = [
				createMockAgentConfig({ id: 'claude-code', name: 'Claude Code' }),
				createMockAgentConfig({ id: 'codex', name: 'Codex' }),
			];
			mockDetect.mockResolvedValueOnce(agents);

			await useAgentStore.getState().refreshAgents();

			expect(mockDetect).toHaveBeenCalledWith(undefined);
			expect(useAgentStore.getState().availableAgents).toEqual(agents);
			expect(useAgentStore.getState().agentsDetected).toBe(true);
		});

		it('refreshAgents passes sshRemoteId to IPC', async () => {
			mockDetect.mockResolvedValueOnce([]);

			await useAgentStore.getState().refreshAgents('remote-1');

			expect(mockDetect).toHaveBeenCalledWith('remote-1');
		});

		it('refreshAgents overwrites previous agents', async () => {
			const oldAgents = [createMockAgentConfig({ id: 'old-agent' })];
			const newAgents = [createMockAgentConfig({ id: 'new-agent' })];

			mockDetect.mockResolvedValueOnce(oldAgents);
			await useAgentStore.getState().refreshAgents();
			expect(useAgentStore.getState().availableAgents).toEqual(oldAgents);

			mockDetect.mockResolvedValueOnce(newAgents);
			await useAgentStore.getState().refreshAgents();
			expect(useAgentStore.getState().availableAgents).toEqual(newAgents);
			expect(useAgentStore.getState().availableAgents).not.toContainEqual(
				expect.objectContaining({ id: 'old-agent' })
			);
		});

		it('refreshAgents handles IPC rejection gracefully', async () => {
			mockDetect.mockRejectedValueOnce(new Error('IPC failed'));

			await expect(useAgentStore.getState().refreshAgents()).rejects.toThrow('IPC failed');

			// State unchanged on failure
			expect(useAgentStore.getState().availableAgents).toEqual([]);
			expect(useAgentStore.getState().agentsDetected).toBe(false);
		});

		it('refreshAgents with empty result sets agentsDetected true', async () => {
			mockDetect.mockResolvedValueOnce([]);

			await useAgentStore.getState().refreshAgents();

			expect(useAgentStore.getState().availableAgents).toEqual([]);
			expect(useAgentStore.getState().agentsDetected).toBe(true);
		});

		it('getAgentConfig returns cached agent by ID', () => {
			const agents = [
				createMockAgentConfig({ id: 'claude-code' }),
				createMockAgentConfig({ id: 'codex' }),
			];
			useAgentStore.setState({ availableAgents: agents, agentsDetected: true });

			expect(useAgentStore.getState().getAgentConfig('claude-code')?.id).toBe('claude-code');
			expect(useAgentStore.getState().getAgentConfig('codex')?.id).toBe('codex');
		});

		it('getAgentConfig returns undefined for unknown agent', () => {
			expect(useAgentStore.getState().getAgentConfig('nonexistent')).toBeUndefined();
		});

		it('getAgentConfig returns undefined when cache is empty', () => {
			expect(useAgentStore.getState().getAgentConfig('claude-code')).toBeUndefined();
		});

		it('getAgentConfig reflects newly refreshed agents', async () => {
			expect(useAgentStore.getState().getAgentConfig('claude-code')).toBeUndefined();

			const agents = [createMockAgentConfig({ id: 'claude-code', name: 'Claude' })];
			mockDetect.mockResolvedValueOnce(agents);
			await useAgentStore.getState().refreshAgents();

			const config = useAgentStore.getState().getAgentConfig('claude-code');
			expect(config).toBeDefined();
			expect(config?.name).toBe('Claude');
		});
	});

	describe('clearAgentError', () => {
		it('clears session-level error fields and sets state to idle', () => {
			const session = createMockSession({
				id: 'session-1',
				state: 'error',
				agentError: { type: 'agent_crashed', message: 'crash' } as any,
				agentErrorTabId: 'tab-1',
				agentErrorPaused: true,
			});

			useSessionStore.getState().setSessions([session]);

			useAgentStore.getState().clearAgentError('session-1');

			const updated = useSessionStore.getState().sessions[0];
			expect(updated.state).toBe('idle');
			expect(updated.agentError).toBeUndefined();
			expect(updated.agentErrorTabId).toBeUndefined();
			expect(updated.agentErrorPaused).toBe(false);
		});

		it('clears tab-level agentError when tabId is provided', () => {
			const session = createMockSession({
				id: 'session-1',
				state: 'error',
				aiTabs: [
					{
						id: 'tab-1',
						agentSessionId: null,
						name: null,
						starred: false,
						logs: [],
						inputValue: '',
						stagedImages: [],
						createdAt: Date.now(),
						state: 'idle',
						agentError: { type: 'auth_expired', message: 'expired' } as any,
					},
				],
				activeTabId: 'tab-1',
			});

			useSessionStore.getState().setSessions([session]);

			useAgentStore.getState().clearAgentError('session-1', 'tab-1');

			const updated = useSessionStore.getState().sessions[0];
			expect(updated.aiTabs[0].agentError).toBeUndefined();
		});

		it('uses agentErrorTabId as default when tabId not provided', () => {
			const session = createMockSession({
				id: 'session-1',
				state: 'error',
				agentErrorTabId: 'tab-1',
				aiTabs: [
					{
						id: 'tab-1',
						agentSessionId: null,
						name: null,
						starred: false,
						logs: [],
						inputValue: '',
						stagedImages: [],
						createdAt: Date.now(),
						state: 'idle',
						agentError: { type: 'network_error', message: 'timeout' } as any,
					},
				],
				activeTabId: 'tab-1',
			});

			useSessionStore.getState().setSessions([session]);

			// No tabId arg — should use session's agentErrorTabId
			useAgentStore.getState().clearAgentError('session-1');

			const updated = useSessionStore.getState().sessions[0];
			expect(updated.aiTabs[0].agentError).toBeUndefined();
		});

		it('calls window.maestro.agentError.clearError IPC', () => {
			const session = createMockSession({ id: 'session-1', state: 'error' });
			useSessionStore.getState().setSessions([session]);

			useAgentStore.getState().clearAgentError('session-1');

			expect(mockClearError).toHaveBeenCalledWith('session-1');
		});

		it('does not affect other sessions', () => {
			const session1 = createMockSession({ id: 'session-1', state: 'error' });
			const session2 = createMockSession({ id: 'session-2', state: 'busy' });

			useSessionStore.getState().setSessions([session1, session2]);

			useAgentStore.getState().clearAgentError('session-1');

			const sessions = useSessionStore.getState().sessions;
			expect(sessions[0].state).toBe('idle');
			expect(sessions[1].state).toBe('busy'); // Unchanged
		});

		it('no-ops on nonexistent session but still calls IPC', () => {
			const session = createMockSession({ id: 'session-1', state: 'error' });
			useSessionStore.getState().setSessions([session]);

			useAgentStore.getState().clearAgentError('nonexistent');

			// Session-1 untouched
			expect(useSessionStore.getState().sessions[0].state).toBe('error');
			// IPC still called (fire-and-forget)
			expect(mockClearError).toHaveBeenCalledWith('nonexistent');
		});

		it('leaves aiTabs untouched when no agentErrorTabId and no tabId', () => {
			const session = createMockSession({
				id: 'session-1',
				state: 'error',
				agentErrorTabId: undefined,
				aiTabs: [
					{
						id: 'tab-1',
						agentSessionId: null,
						name: 'Tab 1',
						starred: false,
						logs: [{ type: 'user', content: 'test' }],
						inputValue: 'some input',
						stagedImages: [],
						createdAt: Date.now(),
						state: 'idle',
					},
				],
				activeTabId: 'tab-1',
			});

			useSessionStore.getState().setSessions([session]);

			useAgentStore.getState().clearAgentError('session-1');

			const updated = useSessionStore.getState().sessions[0];
			expect(updated.state).toBe('idle');
			// Tab data preserved
			expect(updated.aiTabs[0].name).toBe('Tab 1');
			expect(updated.aiTabs[0].inputValue).toBe('some input');
		});

		it('only clears error on target tab in multi-tab session', () => {
			const session = createMockSession({
				id: 'session-1',
				state: 'error',
				agentErrorTabId: 'tab-2',
				aiTabs: [
					{
						id: 'tab-1',
						agentSessionId: null,
						name: null,
						starred: false,
						logs: [],
						inputValue: '',
						stagedImages: [],
						createdAt: Date.now(),
						state: 'idle',
						agentError: { type: 'rate_limited', message: 'limit' } as any,
					},
					{
						id: 'tab-2',
						agentSessionId: null,
						name: null,
						starred: false,
						logs: [],
						inputValue: '',
						stagedImages: [],
						createdAt: Date.now(),
						state: 'idle',
						agentError: { type: 'agent_crashed', message: 'crash' } as any,
					},
				],
				activeTabId: 'tab-2',
			});

			useSessionStore.getState().setSessions([session]);

			// Clear error on tab-2 (via agentErrorTabId default)
			useAgentStore.getState().clearAgentError('session-1');

			const updated = useSessionStore.getState().sessions[0];
			// tab-1 error untouched
			expect(updated.aiTabs[0].agentError).toBeDefined();
			// tab-2 error cleared
			expect(updated.aiTabs[1].agentError).toBeUndefined();
		});

		it('handles IPC clearError rejection without throwing', () => {
			mockClearError.mockRejectedValueOnce(new Error('IPC down'));
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

			const session = createMockSession({ id: 'session-1', state: 'error' });
			useSessionStore.getState().setSessions([session]);

			// Should not throw
			useAgentStore.getState().clearAgentError('session-1');

			// Session still cleared
			expect(useSessionStore.getState().sessions[0].state).toBe('idle');

			consoleSpy.mockRestore();
		});

		it('is idempotent on already-idle session', () => {
			const session = createMockSession({
				id: 'session-1',
				state: 'idle',
				agentError: undefined,
			});

			useSessionStore.getState().setSessions([session]);

			useAgentStore.getState().clearAgentError('session-1');

			const updated = useSessionStore.getState().sessions[0];
			expect(updated.state).toBe('idle');
			expect(updated.agentError).toBeUndefined();
		});
	});

	describe('startNewSessionAfterError', () => {
		it('clears error and creates a new tab', () => {
			const session = createMockSession({
				id: 'session-1',
				state: 'error',
				agentError: { type: 'agent_crashed', message: 'crash' } as any,
			});

			useSessionStore.getState().setSessions([session]);

			useAgentStore.getState().startNewSessionAfterError('session-1');

			const updated = useSessionStore.getState().sessions[0];
			expect(updated.state).toBe('idle');
			expect(updated.agentError).toBeUndefined();
			// A new tab should have been created
			expect(updated.aiTabs.length).toBeGreaterThanOrEqual(2);
		});

		it('passes options to createTab', () => {
			const session = createMockSession({
				id: 'session-1',
				state: 'error',
			});

			useSessionStore.getState().setSessions([session]);

			useAgentStore.getState().startNewSessionAfterError('session-1', {
				saveToHistory: true,
				showThinking: 'on',
			});

			const updated = useSessionStore.getState().sessions[0];
			// The new tab should have the options applied
			const newTab = updated.aiTabs[updated.aiTabs.length - 1];
			expect(newTab.saveToHistory).toBe(true);
			expect(newTab.showThinking).toBe('on');
		});

		it('does nothing if session not found', () => {
			useAgentStore.getState().startNewSessionAfterError('nonexistent');
			// No crash
			expect(mockClearError).not.toHaveBeenCalled();
		});

		it('new tab becomes the active tab', () => {
			const session = createMockSession({
				id: 'session-1',
				state: 'error',
				activeTabId: 'default-tab',
			});

			useSessionStore.getState().setSessions([session]);

			useAgentStore.getState().startNewSessionAfterError('session-1');

			const updated = useSessionStore.getState().sessions[0];
			const newTab = updated.aiTabs[updated.aiTabs.length - 1];
			expect(updated.activeTabId).toBe(newTab.id);
		});

		it('calls IPC clearError via clearAgentError delegation', () => {
			const session = createMockSession({
				id: 'session-1',
				state: 'error',
			});

			useSessionStore.getState().setSessions([session]);

			useAgentStore.getState().startNewSessionAfterError('session-1');

			expect(mockClearError).toHaveBeenCalledWith('session-1');
		});

		it('works with default options (no options argument)', () => {
			const session = createMockSession({
				id: 'session-1',
				state: 'error',
			});

			useSessionStore.getState().setSessions([session]);

			useAgentStore.getState().startNewSessionAfterError('session-1');

			const updated = useSessionStore.getState().sessions[0];
			expect(updated.aiTabs.length).toBeGreaterThanOrEqual(2);
			expect(updated.state).toBe('idle');
		});

		it('preserves existing tabs when adding new tab', () => {
			const session = createMockSession({
				id: 'session-1',
				state: 'error',
				aiTabs: [
					{
						id: 'existing-tab',
						agentSessionId: 'conv-123',
						name: 'Important Work',
						starred: true,
						logs: [{ type: 'user', content: 'hello' }],
						inputValue: '',
						stagedImages: [],
						createdAt: Date.now(),
						state: 'idle',
					},
				],
				activeTabId: 'existing-tab',
			});

			useSessionStore.getState().setSessions([session]);

			useAgentStore.getState().startNewSessionAfterError('session-1');

			const updated = useSessionStore.getState().sessions[0];
			expect(updated.aiTabs.length).toBe(2);
			// Existing tab preserved
			expect(updated.aiTabs[0].id).toBe('existing-tab');
			expect(updated.aiTabs[0].name).toBe('Important Work');
			expect(updated.aiTabs[0].starred).toBe(true);
		});
	});

	describe('retryAfterError', () => {
		it('clears error state (delegates to clearAgentError)', () => {
			const session = createMockSession({
				id: 'session-1',
				state: 'error',
				agentError: { type: 'rate_limited', message: 'rate limit' } as any,
			});

			useSessionStore.getState().setSessions([session]);

			useAgentStore.getState().retryAfterError('session-1');

			const updated = useSessionStore.getState().sessions[0];
			expect(updated.state).toBe('idle');
			expect(updated.agentError).toBeUndefined();
		});

		it('calls IPC clearError via delegation', () => {
			const session = createMockSession({ id: 'session-1', state: 'error' });
			useSessionStore.getState().setSessions([session]);

			useAgentStore.getState().retryAfterError('session-1');

			expect(mockClearError).toHaveBeenCalledWith('session-1');
		});

		it('clears agentErrorPaused flag', () => {
			const session = createMockSession({
				id: 'session-1',
				state: 'error',
				agentErrorPaused: true,
			});

			useSessionStore.getState().setSessions([session]);

			useAgentStore.getState().retryAfterError('session-1');

			expect(useSessionStore.getState().sessions[0].agentErrorPaused).toBe(false);
		});

		it('does not create new tabs (unlike startNewSessionAfterError)', () => {
			const session = createMockSession({
				id: 'session-1',
				state: 'error',
			});

			useSessionStore.getState().setSessions([session]);

			useAgentStore.getState().retryAfterError('session-1');

			expect(useSessionStore.getState().sessions[0].aiTabs.length).toBe(1);
		});
	});

	describe('restartAgentAfterError', () => {
		it('clears error and kills the AI process', async () => {
			const session = createMockSession({
				id: 'session-1',
				state: 'error',
				agentError: { type: 'agent_crashed', message: 'crash' } as any,
			});

			useSessionStore.getState().setSessions([session]);

			await useAgentStore.getState().restartAgentAfterError('session-1');

			// Error cleared
			const updated = useSessionStore.getState().sessions[0];
			expect(updated.state).toBe('idle');
			expect(updated.agentError).toBeUndefined();

			// Process killed
			expect(mockKill).toHaveBeenCalledWith('session-1-ai');
		});

		it('does nothing if session not found', async () => {
			await useAgentStore.getState().restartAgentAfterError('nonexistent');
			expect(mockKill).not.toHaveBeenCalled();
		});

		it('handles kill failure gracefully', async () => {
			mockKill.mockRejectedValueOnce(new Error('Process not found'));

			const session = createMockSession({
				id: 'session-1',
				state: 'error',
			});

			useSessionStore.getState().setSessions([session]);

			// Should not throw
			await useAgentStore.getState().restartAgentAfterError('session-1');

			// Error still cleared
			const updated = useSessionStore.getState().sessions[0];
			expect(updated.state).toBe('idle');
		});

		it('clears error before killing process (state is idle during kill)', async () => {
			let stateAtKillTime: string | undefined;
			mockKill.mockImplementationOnce(async () => {
				stateAtKillTime = useSessionStore.getState().sessions[0]?.state;
			});

			const session = createMockSession({
				id: 'session-1',
				state: 'error',
			});
			useSessionStore.getState().setSessions([session]);

			await useAgentStore.getState().restartAgentAfterError('session-1');

			// Error was cleared BEFORE kill was called
			expect(stateAtKillTime).toBe('idle');
		});

		it('calls IPC clearError and process kill', async () => {
			const session = createMockSession({
				id: 'session-1',
				state: 'error',
			});
			useSessionStore.getState().setSessions([session]);

			await useAgentStore.getState().restartAgentAfterError('session-1');

			expect(mockClearError).toHaveBeenCalledWith('session-1');
			expect(mockKill).toHaveBeenCalledWith('session-1-ai');
		});

		it('does not create new tabs', async () => {
			const session = createMockSession({
				id: 'session-1',
				state: 'error',
			});
			useSessionStore.getState().setSessions([session]);

			await useAgentStore.getState().restartAgentAfterError('session-1');

			expect(useSessionStore.getState().sessions[0].aiTabs.length).toBe(1);
		});
	});

	describe('authenticateAfterError', () => {
		it('clears error, sets active session, and switches to terminal mode', () => {
			const session = createMockSession({
				id: 'session-1',
				state: 'error',
				inputMode: 'ai',
				agentError: { type: 'auth_expired', message: 'auth expired' } as any,
			});

			useSessionStore.getState().setSessions([session]);

			useAgentStore.getState().authenticateAfterError('session-1');

			const updated = useSessionStore.getState().sessions[0];
			expect(updated.state).toBe('idle');
			expect(updated.inputMode).toBe('terminal');
			expect(updated.agentError).toBeUndefined();
			expect(useSessionStore.getState().activeSessionId).toBe('session-1');
		});

		it('does nothing if session not found', () => {
			useAgentStore.getState().authenticateAfterError('nonexistent');
			// No crash, no IPC calls
			expect(mockClearError).not.toHaveBeenCalled();
		});

		it('is idempotent when session is already in terminal mode', () => {
			const session = createMockSession({
				id: 'session-1',
				state: 'error',
				inputMode: 'terminal',
			});

			useSessionStore.getState().setSessions([session]);

			useAgentStore.getState().authenticateAfterError('session-1');

			const updated = useSessionStore.getState().sessions[0];
			expect(updated.state).toBe('idle');
			expect(updated.inputMode).toBe('terminal');
		});

		it('switches active session even if it was already active', () => {
			const session = createMockSession({
				id: 'session-1',
				state: 'error',
				inputMode: 'ai',
			});

			useSessionStore.getState().setSessions([session]);
			useSessionStore.getState().setActiveSessionId('session-1');

			useAgentStore.getState().authenticateAfterError('session-1');

			expect(useSessionStore.getState().activeSessionId).toBe('session-1');
			expect(useSessionStore.getState().sessions[0].inputMode).toBe('terminal');
		});

		it('calls IPC clearError via delegation', () => {
			const session = createMockSession({ id: 'session-1', state: 'error' });
			useSessionStore.getState().setSessions([session]);

			useAgentStore.getState().authenticateAfterError('session-1');

			expect(mockClearError).toHaveBeenCalledWith('session-1');
		});

		it('does not create new tabs or modify existing tabs', () => {
			const session = createMockSession({
				id: 'session-1',
				state: 'error',
				aiTabs: [
					{
						id: 'tab-1',
						agentSessionId: 'conv-1',
						name: 'My Work',
						starred: false,
						logs: [{ type: 'user', content: 'hello' }],
						inputValue: 'pending input',
						stagedImages: [],
						createdAt: Date.now(),
						state: 'idle',
					},
				],
				activeTabId: 'tab-1',
			});

			useSessionStore.getState().setSessions([session]);

			useAgentStore.getState().authenticateAfterError('session-1');

			const updated = useSessionStore.getState().sessions[0];
			expect(updated.aiTabs.length).toBe(1);
			expect(updated.aiTabs[0].name).toBe('My Work');
			expect(updated.aiTabs[0].inputValue).toBe('pending input');
		});
	});

	describe('killAgent', () => {
		it('kills agent with default -ai suffix', async () => {
			await useAgentStore.getState().killAgent('session-1');
			expect(mockKill).toHaveBeenCalledWith('session-1-ai');
		});

		it('kills agent with custom suffix', async () => {
			await useAgentStore.getState().killAgent('session-1', 'terminal');
			expect(mockKill).toHaveBeenCalledWith('session-1-terminal');
		});

		it('handles kill failure gracefully', async () => {
			mockKill.mockRejectedValueOnce(new Error('Process not found'));

			// Should not throw
			await useAgentStore.getState().killAgent('session-1');
		});

		it('does not modify sessionStore state', async () => {
			const session = createMockSession({ id: 'session-1', state: 'busy' });
			useSessionStore.getState().setSessions([session]);

			await useAgentStore.getState().killAgent('session-1');

			// killAgent is a low-level action — state management is caller's responsibility
			expect(useSessionStore.getState().sessions[0].state).toBe('busy');
		});

		it('constructs correct target with various suffixes', async () => {
			await useAgentStore.getState().killAgent('session-abc', 'ai');
			expect(mockKill).toHaveBeenCalledWith('session-abc-ai');

			mockKill.mockClear();

			await useAgentStore.getState().killAgent('session-abc', 'background');
			expect(mockKill).toHaveBeenCalledWith('session-abc-background');
		});
	});

	describe('interruptAgent', () => {
		it('sends interrupt signal via IPC', async () => {
			await useAgentStore.getState().interruptAgent('session-1');
			expect(mockInterrupt).toHaveBeenCalledWith('session-1');
		});

		it('handles interrupt failure gracefully', async () => {
			mockInterrupt.mockRejectedValueOnce(new Error('Process not found'));

			// Should not throw
			await useAgentStore.getState().interruptAgent('session-1');
		});
	});

	describe('selectors', () => {
		it('selectAvailableAgents returns the agents list', () => {
			const agents = [createMockAgentConfig({ id: 'claude-code' })];
			useAgentStore.setState({ availableAgents: agents });

			expect(selectAvailableAgents(useAgentStore.getState())).toEqual(agents);
		});

		it('selectAgentsDetected returns detection status', () => {
			expect(selectAgentsDetected(useAgentStore.getState())).toBe(false);

			useAgentStore.setState({ agentsDetected: true });

			expect(selectAgentsDetected(useAgentStore.getState())).toBe(true);
		});
	});

	describe('non-React access', () => {
		it('getAgentState returns current snapshot', () => {
			const agents = [createMockAgentConfig()];
			useAgentStore.setState({ availableAgents: agents, agentsDetected: true });

			const state = getAgentState();
			expect(state.availableAgents).toEqual(agents);
			expect(state.agentsDetected).toBe(true);
		});

		it('getAgentState reflects latest mutations', () => {
			expect(getAgentState().agentsDetected).toBe(false);

			useAgentStore.setState({ agentsDetected: true });

			expect(getAgentState().agentsDetected).toBe(true);
		});

		it('getAgentActions returns all 10 action functions', () => {
			const actions = getAgentActions();

			expect(typeof actions.refreshAgents).toBe('function');
			expect(typeof actions.getAgentConfig).toBe('function');
			expect(typeof actions.processQueuedItem).toBe('function');
			expect(typeof actions.clearAgentError).toBe('function');
			expect(typeof actions.startNewSessionAfterError).toBe('function');
			expect(typeof actions.retryAfterError).toBe('function');
			expect(typeof actions.restartAgentAfterError).toBe('function');
			expect(typeof actions.authenticateAfterError).toBe('function');
			expect(typeof actions.killAgent).toBe('function');
			expect(typeof actions.interruptAgent).toBe('function');

			// Verify exactly 10 actions (no extras, no missing)
			expect(Object.keys(actions)).toHaveLength(10);
		});

		it('getAgentActions clearAgentError works end-to-end', () => {
			const session = createMockSession({
				id: 'session-1',
				state: 'error',
				agentError: { type: 'agent_crashed', message: 'crash' } as any,
			});
			useSessionStore.getState().setSessions([session]);

			const { clearAgentError } = getAgentActions();
			clearAgentError('session-1');

			expect(useSessionStore.getState().sessions[0].state).toBe('idle');
			expect(mockClearError).toHaveBeenCalledWith('session-1');
		});

		it('getAgentActions killAgent works end-to-end', async () => {
			const { killAgent } = getAgentActions();
			await killAgent('session-1', 'terminal');

			expect(mockKill).toHaveBeenCalledWith('session-1-terminal');
		});
	});

	describe('React hook integration', () => {
		it('useAgentStore with selector re-renders on agent detection', async () => {
			const { result } = renderHook(() => useAgentStore(selectAgentsDetected));

			expect(result.current).toBe(false);

			const agents = [createMockAgentConfig()];
			mockDetect.mockResolvedValueOnce(agents);

			await act(async () => {
				await useAgentStore.getState().refreshAgents();
			});

			expect(result.current).toBe(true);
		});

		it('useAgentStore with availableAgents selector updates on refresh', async () => {
			const { result } = renderHook(() => useAgentStore(selectAvailableAgents));

			expect(result.current).toEqual([]);

			const agents = [createMockAgentConfig({ id: 'claude-code' })];
			mockDetect.mockResolvedValueOnce(agents);

			await act(async () => {
				await useAgentStore.getState().refreshAgents();
			});

			expect(result.current).toHaveLength(1);
			expect(result.current[0].id).toBe('claude-code');
		});
	});

	describe('action stability', () => {
		it('all action references are stable across state changes', () => {
			const before = useAgentStore.getState();

			// Mutate state
			useAgentStore.setState({
				agentsDetected: true,
				availableAgents: [createMockAgentConfig()],
			});

			const after = useAgentStore.getState();

			// All 10 actions must be referentially stable
			expect(before.refreshAgents).toBe(after.refreshAgents);
			expect(before.getAgentConfig).toBe(after.getAgentConfig);
			expect(before.processQueuedItem).toBe(after.processQueuedItem);
			expect(before.clearAgentError).toBe(after.clearAgentError);
			expect(before.startNewSessionAfterError).toBe(after.startNewSessionAfterError);
			expect(before.retryAfterError).toBe(after.retryAfterError);
			expect(before.restartAgentAfterError).toBe(after.restartAgentAfterError);
			expect(before.authenticateAfterError).toBe(after.authenticateAfterError);
			expect(before.killAgent).toBe(after.killAgent);
			expect(before.interruptAgent).toBe(after.interruptAgent);
		});
	});

	describe('complex scenarios', () => {
		it('error recovery across multiple sessions only affects target', () => {
			const sessions = [
				createMockSession({
					id: 'session-1',
					state: 'error',
					agentError: { type: 'agent_crashed', message: 'crash' } as any,
				}),
				createMockSession({
					id: 'session-2',
					state: 'error',
					agentError: { type: 'auth_expired', message: 'auth' } as any,
				}),
				createMockSession({ id: 'session-3', state: 'busy' }),
			];

			useSessionStore.getState().setSessions(sessions);

			useAgentStore.getState().clearAgentError('session-1');

			const updated = useSessionStore.getState().sessions;
			expect(updated[0].state).toBe('idle');
			expect(updated[0].agentError).toBeUndefined();
			expect(updated[1].state).toBe('error'); // Untouched
			expect(updated[1].agentError).toBeDefined();
			expect(updated[2].state).toBe('busy'); // Untouched
		});

		it('sequential error recovery: clear then start new session', () => {
			const session = createMockSession({
				id: 'session-1',
				state: 'error',
				agentError: { type: 'agent_crashed', message: 'crash' } as any,
			});

			useSessionStore.getState().setSessions([session]);

			// First clear, then start new session (simulates user flow)
			useAgentStore.getState().startNewSessionAfterError('session-1');

			const updated = useSessionStore.getState().sessions[0];
			expect(updated.state).toBe('idle');
			expect(updated.aiTabs.length).toBeGreaterThanOrEqual(2);
		});

		it('authenticate switches active session to target', () => {
			const sessions = [
				createMockSession({ id: 'session-1', state: 'idle' }),
				createMockSession({
					id: 'session-2',
					state: 'error',
					agentError: { type: 'auth_expired', message: 'auth' } as any,
				}),
			];

			useSessionStore.getState().setSessions(sessions);
			useSessionStore.getState().setActiveSessionId('session-1');

			useAgentStore.getState().authenticateAfterError('session-2');

			// Active session switched to session-2
			expect(useSessionStore.getState().activeSessionId).toBe('session-2');
			// session-2 is now in terminal mode
			expect(useSessionStore.getState().sessions[1].inputMode).toBe('terminal');
		});

		it('double clear is idempotent', () => {
			const session = createMockSession({
				id: 'session-1',
				state: 'error',
				agentError: { type: 'agent_crashed', message: 'crash' } as any,
			});
			useSessionStore.getState().setSessions([session]);

			useAgentStore.getState().clearAgentError('session-1');
			useAgentStore.getState().clearAgentError('session-1');

			const updated = useSessionStore.getState().sessions[0];
			expect(updated.state).toBe('idle');
			expect(mockClearError).toHaveBeenCalledTimes(2);
		});

		it('concurrent recovery on different sessions', () => {
			const sessions = [
				createMockSession({
					id: 'session-1',
					state: 'error',
					agentError: { type: 'agent_crashed', message: 'crash' } as any,
				}),
				createMockSession({
					id: 'session-2',
					state: 'error',
					agentError: { type: 'auth_expired', message: 'auth' } as any,
					inputMode: 'ai',
				}),
			];

			useSessionStore.getState().setSessions(sessions);

			// Different recovery actions on different sessions simultaneously
			useAgentStore.getState().retryAfterError('session-1');
			useAgentStore.getState().authenticateAfterError('session-2');

			const updated = useSessionStore.getState().sessions;
			expect(updated[0].state).toBe('idle');
			expect(updated[0].agentError).toBeUndefined();
			expect(updated[1].state).toBe('idle');
			expect(updated[1].inputMode).toBe('terminal');
		});

		it('recovery after restart then new session', async () => {
			const session = createMockSession({
				id: 'session-1',
				state: 'error',
				agentError: { type: 'agent_crashed', message: 'crash' } as any,
			});
			useSessionStore.getState().setSessions([session]);

			// User restarts, then immediately starts new session
			await useAgentStore.getState().restartAgentAfterError('session-1');
			useAgentStore.getState().startNewSessionAfterError('session-1');

			const updated = useSessionStore.getState().sessions[0];
			expect(updated.state).toBe('idle');
			expect(updated.aiTabs.length).toBeGreaterThanOrEqual(2);
			expect(mockKill).toHaveBeenCalledWith('session-1-ai');
		});
	});

	describe('store reset', () => {
		it('resetStores clears agentStore state completely', async () => {
			// Populate the store
			const agents = [createMockAgentConfig({ id: 'claude-code' })];
			mockDetect.mockResolvedValueOnce(agents);
			await useAgentStore.getState().refreshAgents();

			expect(useAgentStore.getState().availableAgents).toHaveLength(1);
			expect(useAgentStore.getState().agentsDetected).toBe(true);

			// Reset
			resetStores();

			expect(useAgentStore.getState().availableAgents).toEqual([]);
			expect(useAgentStore.getState().agentsDetected).toBe(false);
		});

		it('agentStore actions work correctly after reset', () => {
			// Use the store
			const session = createMockSession({ id: 'session-1', state: 'error' });
			useSessionStore.getState().setSessions([session]);
			useAgentStore.getState().clearAgentError('session-1');

			// Reset
			resetStores();

			// Set up again and use
			const newSession = createMockSession({ id: 'session-2', state: 'error' });
			useSessionStore.getState().setSessions([newSession]);
			useAgentStore.getState().clearAgentError('session-2');

			expect(useSessionStore.getState().sessions[0].state).toBe('idle');
		});
	});

	describe('interruptAgent edge cases', () => {
		it('does not modify sessionStore state', async () => {
			const session = createMockSession({ id: 'session-1', state: 'busy' });
			useSessionStore.getState().setSessions([session]);

			await useAgentStore.getState().interruptAgent('session-1');

			// interruptAgent is low-level — doesn't change session state
			expect(useSessionStore.getState().sessions[0].state).toBe('busy');
		});

		it('sends interrupt to correct session ID', async () => {
			await useAgentStore.getState().interruptAgent('session-abc-123');

			expect(mockInterrupt).toHaveBeenCalledWith('session-abc-123');
		});
	});

	describe('processQueuedItem', () => {
		const mockAgent: AgentConfig = {
			id: 'claude-code',
			name: 'Claude Code',
			available: true,
			command: 'claude',
			args: ['--json'],
		} as AgentConfig;

		const defaultDeps: ProcessQueuedItemDeps = {
			conductorProfile: 'Test conductor profile',
			customAICommands: [],
			speckitCommands: [],
			openspecCommands: [],
		};

		function createQueuedItem(overrides: Partial<QueuedItem> = {}): QueuedItem {
			return {
				id: 'item-1',
				timestamp: Date.now(),
				tabId: 'default-tab',
				type: 'message',
				text: 'Hello agent',
				...overrides,
			};
		}

		beforeEach(() => {
			mockGetAgent.mockResolvedValue(mockAgent);
		});

		it('spawns agent with queued message text', async () => {
			const session = createMockSession({
				id: 'session-1',
				toolType: 'claude-code',
				aiTabs: [
					{
						id: 'tab-1',
						agentSessionId: 'existing-conv-id',
						name: null,
						starred: false,
						logs: [],
						inputValue: '',
						stagedImages: [],
						createdAt: Date.now(),
						state: 'idle',
					},
				],
				activeTabId: 'tab-1',
			});
			useSessionStore.getState().setSessions([session]);

			const item = createQueuedItem({ tabId: 'tab-1', text: 'Build the feature' });

			await useAgentStore.getState().processQueuedItem('session-1', item, defaultDeps);

			expect(mockSpawn).toHaveBeenCalledTimes(1);
			expect(mockSpawn).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionId: 'session-1-ai-tab-1',
					toolType: 'claude-code',
					prompt: 'Build the feature',
					cwd: '/test',
					agentSessionId: 'existing-conv-id',
				})
			);
		});

		it('prepends system prompt for new sessions (no agentSessionId)', async () => {
			const session = createMockSession({
				id: 'session-1',
				toolType: 'claude-code',
				aiTabs: [
					{
						id: 'tab-1',
						agentSessionId: null, // NEW session — no conversation ID
						name: null,
						starred: false,
						logs: [],
						inputValue: '',
						stagedImages: [],
						createdAt: Date.now(),
						state: 'idle',
					},
				],
				activeTabId: 'tab-1',
			});
			useSessionStore.getState().setSessions([session]);

			const item = createQueuedItem({ tabId: 'tab-1', text: 'Hello' });

			await useAgentStore.getState().processQueuedItem('session-1', item, defaultDeps);

			// System prompt should be prepended for new sessions
			const spawnCall = mockSpawn.mock.calls[0][0];
			expect(spawnCall.prompt).toContain('Mock system prompt');
			expect(spawnCall.prompt).toContain('Hello');
			expect(spawnCall.prompt).toContain('# User Request');
		});

		it('does NOT prepend system prompt for existing sessions', async () => {
			const session = createMockSession({
				id: 'session-1',
				toolType: 'claude-code',
				aiTabs: [
					{
						id: 'tab-1',
						agentSessionId: 'existing-conv', // Existing conversation
						name: null,
						starred: false,
						logs: [],
						inputValue: '',
						stagedImages: [],
						createdAt: Date.now(),
						state: 'idle',
					},
				],
				activeTabId: 'tab-1',
			});
			useSessionStore.getState().setSessions([session]);

			const item = createQueuedItem({ tabId: 'tab-1', text: 'Follow up question' });

			await useAgentStore.getState().processQueuedItem('session-1', item, defaultDeps);

			const spawnCall = mockSpawn.mock.calls[0][0];
			expect(spawnCall.prompt).toBe('Follow up question');
			expect(spawnCall.prompt).not.toContain('Mock system prompt');
		});

		it('filters YOLO flags when read-only mode is active', async () => {
			const agentWithYolo = {
				...mockAgent,
				args: ['--json', '--dangerously-skip-permissions', '--other-flag'],
			};
			mockGetAgent.mockResolvedValueOnce(agentWithYolo);

			const session = createMockSession({
				id: 'session-1',
				aiTabs: [
					{
						id: 'tab-1',
						agentSessionId: 'conv-1',
						name: null,
						starred: false,
						logs: [],
						inputValue: '',
						stagedImages: [],
						createdAt: Date.now(),
						state: 'idle',
						readOnlyMode: true,
					},
				],
				activeTabId: 'tab-1',
			});
			useSessionStore.getState().setSessions([session]);

			const item = createQueuedItem({ tabId: 'tab-1', text: 'Read only query' });

			await useAgentStore.getState().processQueuedItem('session-1', item, defaultDeps);

			const spawnCall = mockSpawn.mock.calls[0][0];
			expect(spawnCall.args).toContain('--json');
			expect(spawnCall.args).toContain('--other-flag');
			expect(spawnCall.args).not.toContain('--dangerously-skip-permissions');
			expect(spawnCall.readOnlyMode).toBe(true);
		});

		it('processes slash command and spawns agent', async () => {
			const session = createMockSession({
				id: 'session-1',
				aiTabs: [
					{
						id: 'tab-1',
						agentSessionId: 'conv-1',
						name: null,
						starred: false,
						logs: [],
						inputValue: '',
						stagedImages: [],
						createdAt: Date.now(),
						state: 'idle',
					},
				],
				activeTabId: 'tab-1',
			});
			useSessionStore.getState().setSessions([session]);

			const deps: ProcessQueuedItemDeps = {
				...defaultDeps,
				customAICommands: [
					{
						id: 'cmd-1',
						command: '/commit',
						description: 'Commit changes',
						prompt: 'Please commit all changes with a descriptive message',
					},
				],
			};

			const item = createQueuedItem({
				tabId: 'tab-1',
				type: 'command',
				command: '/commit',
				text: undefined,
			});

			await useAgentStore.getState().processQueuedItem('session-1', item, deps);

			expect(mockSpawn).toHaveBeenCalledTimes(1);
			expect(mockSpawn).toHaveBeenCalledWith(
				expect.objectContaining({
					prompt: expect.stringContaining('commit all changes'),
				})
			);

			// Should add user log entry
			const updated = useSessionStore.getState().sessions[0];
			expect(updated.aiTabs[0].logs).toHaveLength(1);
			expect(updated.aiTabs[0].logs[0].source).toBe('user');
			expect(updated.aiTabs[0].logs[0].aiCommand?.command).toBe('/commit');
		});

		it('substitutes $ARGUMENTS in command prompt', async () => {
			const session = createMockSession({
				id: 'session-1',
				aiTabs: [
					{
						id: 'tab-1',
						agentSessionId: 'conv-1',
						name: null,
						starred: false,
						logs: [],
						inputValue: '',
						stagedImages: [],
						createdAt: Date.now(),
						state: 'idle',
					},
				],
				activeTabId: 'tab-1',
			});
			useSessionStore.getState().setSessions([session]);

			const deps: ProcessQueuedItemDeps = {
				...defaultDeps,
				speckitCommands: [
					{
						id: 'sk-1',
						command: '/speckit.plan',
						description: 'Plan feature',
						prompt: 'Create a plan for: $ARGUMENTS',
						isCustom: false,
						isModified: false,
					},
				],
			};

			const item = createQueuedItem({
				tabId: 'tab-1',
				type: 'command',
				command: '/speckit.plan',
				commandArgs: 'user authentication flow',
				text: undefined,
			});

			await useAgentStore.getState().processQueuedItem('session-1', item, deps);

			const spawnCall = mockSpawn.mock.calls[0][0];
			expect(spawnCall.prompt).toContain('Create a plan for: user authentication flow');
		});

		it('appends arguments to prompt when no $ARGUMENTS placeholder exists', async () => {
			const session = createMockSession({
				id: 'session-1',
				aiTabs: [
					{
						id: 'tab-1',
						agentSessionId: 'conv-1',
						name: null,
						starred: false,
						logs: [],
						inputValue: '',
						stagedImages: [],
						createdAt: Date.now(),
						state: 'idle',
					},
				],
				activeTabId: 'tab-1',
			});
			useSessionStore.getState().setSessions([session]);

			const deps: ProcessQueuedItemDeps = {
				...defaultDeps,
				customAICommands: [
					{
						id: 'cmd-commit',
						command: '/commit',
						description: 'Commit changes',
						prompt: 'Please commit all changes with a descriptive message',
					},
				],
			};

			const item = createQueuedItem({
				tabId: 'tab-1',
				type: 'command',
				command: '/commit',
				commandArgs: 'fix the login bug',
				text: undefined,
			});

			await useAgentStore.getState().processQueuedItem('session-1', item, deps);

			const spawnCall = mockSpawn.mock.calls[0][0];
			// Args should be appended after the prompt since no $ARGUMENTS placeholder
			expect(spawnCall.prompt).toContain('Please commit all changes with a descriptive message');
			expect(spawnCall.prompt).toContain('fix the login bug');
		});

		it('adds error log and resets to idle for unknown command', async () => {
			const session = createMockSession({
				id: 'session-1',
				state: 'busy',
				aiTabs: [
					{
						id: 'tab-1',
						agentSessionId: null,
						name: null,
						starred: false,
						logs: [],
						inputValue: '',
						stagedImages: [],
						createdAt: Date.now(),
						state: 'busy',
					},
				],
				activeTabId: 'tab-1',
			});
			useSessionStore.getState().setSessions([session]);

			const item = createQueuedItem({
				tabId: 'tab-1',
				type: 'command',
				command: '/nonexistent',
				text: undefined,
			});

			await useAgentStore.getState().processQueuedItem('session-1', item, defaultDeps);

			// Should NOT have spawned
			expect(mockSpawn).not.toHaveBeenCalled();

			// Should have added error log to active tab
			const updated = useSessionStore.getState().sessions[0];
			expect(updated.state).toBe('idle');
			expect(updated.busySource).toBeUndefined();
			expect(updated.aiTabs[0].logs).toHaveLength(1);
			expect(updated.aiTabs[0].logs[0].source).toBe('system');
			expect(updated.aiTabs[0].logs[0].text).toContain('Unknown command: /nonexistent');
		});

		it('handles spawn error gracefully', async () => {
			mockSpawn.mockRejectedValueOnce(new Error('Spawn failed'));
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

			const session = createMockSession({
				id: 'session-1',
				state: 'busy',
				aiTabs: [
					{
						id: 'tab-1',
						agentSessionId: null,
						name: null,
						starred: false,
						logs: [],
						inputValue: '',
						stagedImages: [],
						createdAt: Date.now(),
						state: 'busy',
					},
				],
				activeTabId: 'tab-1',
			});
			useSessionStore.getState().setSessions([session]);

			const item = createQueuedItem({ tabId: 'tab-1', text: 'Will fail' });

			await useAgentStore.getState().processQueuedItem('session-1', item, defaultDeps);

			// Should have reset to idle
			const updated = useSessionStore.getState().sessions[0];
			expect(updated.state).toBe('idle');
			expect(updated.busySource).toBeUndefined();

			consoleSpy.mockRestore();
		});

		it('does nothing for nonexistent session', async () => {
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

			const item = createQueuedItem({ text: 'Hello' });

			await useAgentStore.getState().processQueuedItem('nonexistent', item, defaultDeps);

			expect(mockSpawn).not.toHaveBeenCalled();
			expect(consoleSpy).toHaveBeenCalledWith(
				expect.stringContaining('[processQueuedItem] Session not found'),
				'nonexistent'
			);

			consoleSpy.mockRestore();
		});

		it('passes session custom config to spawn', async () => {
			const session = createMockSession({
				id: 'session-1',
				toolType: 'claude-code',
				customPath: '/custom/claude',
				customArgs: ['--custom-flag'],
				customEnvVars: { MY_VAR: 'value' },
				customModel: 'claude-opus',
				customContextWindow: 200000,
				aiTabs: [
					{
						id: 'tab-1',
						agentSessionId: 'conv-1',
						name: null,
						starred: false,
						logs: [],
						inputValue: '',
						stagedImages: [],
						createdAt: Date.now(),
						state: 'idle',
					},
				],
				activeTabId: 'tab-1',
			});
			useSessionStore.getState().setSessions([session]);

			const item = createQueuedItem({ tabId: 'tab-1', text: 'Hello' });

			await useAgentStore.getState().processQueuedItem('session-1', item, defaultDeps);

			expect(mockSpawn).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionCustomPath: '/custom/claude',
					sessionCustomArgs: ['--custom-flag'],
					sessionCustomEnvVars: { MY_VAR: 'value' },
					sessionCustomModel: 'claude-opus',
					sessionCustomContextWindow: 200000,
				})
			);
		});

		it('tracks pendingAICommandForSynopsis for command items', async () => {
			const session = createMockSession({
				id: 'session-1',
				aiTabs: [
					{
						id: 'tab-1',
						agentSessionId: 'conv-1',
						name: null,
						starred: false,
						logs: [],
						inputValue: '',
						stagedImages: [],
						createdAt: Date.now(),
						state: 'idle',
					},
				],
				activeTabId: 'tab-1',
			});
			useSessionStore.getState().setSessions([session]);

			const deps: ProcessQueuedItemDeps = {
				...defaultDeps,
				customAICommands: [
					{
						id: 'cmd-1',
						command: '/review',
						description: 'Code review',
						prompt: 'Review the code changes',
					},
				],
			};

			const item = createQueuedItem({
				tabId: 'tab-1',
				type: 'command',
				command: '/review',
				text: undefined,
			});

			await useAgentStore.getState().processQueuedItem('session-1', item, deps);

			const updated = useSessionStore.getState().sessions[0];
			expect(updated.pendingAICommandForSynopsis).toBe('/review');
		});

		it('aborts without spawning when target tab was deleted after queueing', async () => {
			const session = createMockSession({
				id: 'session-1',
				aiTabs: [],
				activeTabId: '',
			});
			useSessionStore.getState().setSessions([session]);

			const item = createQueuedItem({ tabId: 'nonexistent-tab', text: 'Hello' });
			const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

			await useAgentStore.getState().processQueuedItem('session-1', item, defaultDeps);

			expect(mockSpawn).not.toHaveBeenCalled();
			expect(consoleSpy).toHaveBeenCalledWith(
				expect.stringContaining('Target tab was deleted after queueing'),
				expect.objectContaining({ sessionId: 'session-1', itemTabId: 'nonexistent-tab' })
			);

			// Session should be reset to idle
			const updated = useSessionStore.getState().sessions[0];
			expect(updated.state).toBe('idle');
			expect(updated.busySource).toBeUndefined();

			consoleSpy.mockRestore();
		});

		it('aborts without spawning when session has no aiTabs and no tabId', async () => {
			const session = createMockSession({
				id: 'session-1',
				aiTabs: [],
				activeTabId: '',
			});
			useSessionStore.getState().setSessions([session]);

			const item = createQueuedItem({ tabId: '', text: 'Hello' });
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

			await useAgentStore.getState().processQueuedItem('session-1', item, defaultDeps);

			expect(mockSpawn).not.toHaveBeenCalled();
			expect(consoleSpy).toHaveBeenCalledWith(
				expect.stringContaining('No target tab found'),
				expect.objectContaining({ sessionId: 'session-1', itemTabId: '' })
			);

			consoleSpy.mockRestore();
		});

		it('passes images to spawn for message with images', async () => {
			const session = createMockSession({
				id: 'session-1',
				aiTabs: [
					{
						id: 'tab-1',
						agentSessionId: 'conv-1',
						name: null,
						starred: false,
						logs: [],
						inputValue: '',
						stagedImages: [],
						createdAt: Date.now(),
						state: 'idle',
					},
				],
				activeTabId: 'tab-1',
			});
			useSessionStore.getState().setSessions([session]);

			const item = createQueuedItem({
				tabId: 'tab-1',
				text: 'Describe this image',
				images: ['base64encodedimage'],
			});

			await useAgentStore.getState().processQueuedItem('session-1', item, defaultDeps);

			expect(mockSpawn).toHaveBeenCalledWith(
				expect.objectContaining({
					images: ['base64encodedimage'],
					prompt: 'Describe this image',
				})
			);
		});
	});
});
