import { agentCommandScope } from '../../../renderer/utils/agentCommands';
/**
 * Tests for agentStore - Agent lifecycle orchestration store
 *
 * Tests agent detection caching, error recovery actions, and agent lifecycle
 * (kill, interrupt). The store orchestrates sessionStore mutations + IPC calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger } from '../../../renderer/utils/logger';
import { renderHook, act } from '@testing-library/react';
import { useAgentStore } from '../../../renderer/stores/agentStore';
import type { ProcessQueuedItemDeps } from '../../../renderer/stores/agentStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import type { Session, AgentConfig, QueuedItem } from '../../../renderer/types';
import { createMockSession as baseCreateMockSession } from '../../helpers/mockSession';
import { dispatchCrossAgentMentionsForMessage } from '../../../renderer/services/crossAgentMentions';
import { resetStores } from '../../helpers';
import { requestTabAutoNameForMessage } from '../../../renderer/services/tabAutoNaming';
import { resetAutoTurnForTests } from '../../../renderer/services/autoTurn';
import { markTabRunningQueuedItem } from '../../../renderer/utils/tabHelpers';

// ============================================================================
// Helpers
// ============================================================================

// Thin wrapper: pre-populates an AI tab so store actions can operate on a
// non-empty tabs array. Delegates to the shared factory for all other fields.
// Note: uses cwd '/test' (not '/test/project') because agentStore spawn
// assertions check against this literal value.
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
	return baseCreateMockSession({
		cwd: '/test',
		fullPath: '/test',
		projectRoot: '/test',
		aiTabs: [defaultTab],
		activeTabId: defaultTab.id,
		unifiedTabOrder: [{ type: 'ai' as const, id: defaultTab.id }],
		...overrides,
	} as Partial<Session>);
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
// Model routing is off unless a test says otherwise, as it is in the app.
const ROUTER_OFF = { skipped: 'off', detail: 'Model routing is off.', latencyMs: 0 };
const mockRouteTurn = vi.fn().mockResolvedValue(ROUTER_OFF);

(window as any).maestro = {
	process: {
		spawn: mockSpawn,
		kill: mockKill,
		interrupt: mockInterrupt,
	},
	localModels: {
		routeTurn: mockRouteTurn,
	},
	agents: {
		detect: mockDetect,
		get: mockGetAgent,
	},
	agentError: {
		clearError: mockClearError,
	},
	prompts: {
		get: vi.fn((id: string) => {
			const prompts: Record<string, string> = {
				'maestro-system-prompt': 'Mock system prompt for {{CWD}}',
				'autorun-synopsis': '',
				'image-only-default': 'Describe this image',
				'commit-command': '',
			};
			if (id in prompts) {
				return Promise.resolve({ success: true, content: prompts[id] });
			}
			return Promise.resolve({ success: false, error: `Unknown prompt: ${id}` });
		}),
	},
};

// Mock gitService
vi.mock('../../../renderer/services/git', () => ({
	gitService: {
		getStatus: vi.fn().mockResolvedValue({ branch: 'main', files: [] }),
	},
}));

// Prompt content is now loaded via window.maestro.prompts.get() and cached at module level.
// The window.maestro.prompts mock is set up below in the window.maestro block.

// Mock substituteTemplateVariables - pass through the template as-is for simplicity
vi.mock('../../../renderer/utils/templateVariables', () => ({
	substituteTemplateVariables: vi.fn((template: string) => template),
}));

// Mock the cross-agent consult so the deferred-mention dispatch is observable
// without standing up the whole @mention resolution + IPC pipeline.
vi.mock('../../../renderer/services/crossAgentMentions', () => ({
	dispatchCrossAgentMentionsForMessage: vi.fn(),
	withMentionTurnNotes: (prompt: string) => prompt,
}));

// Tab auto-naming is fire-and-forget and covered in services/tabAutoNaming.test.ts;
// here we only assert which queued items the drain hands to it (issue #1531).
vi.mock('../../../renderer/services/tabAutoNaming', () => ({
	requestTabAutoNameForMessage: vi.fn(),
}));

beforeEach(() => {
	resetStores(useAgentStore, useSessionStore);
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

			// Agent list unchanged on failure...
			expect(useAgentStore.getState().availableAgents).toEqual([]);
			// ...but detection is marked done so the pickers fall out of "Loading agents..."
			// instead of spinning forever.
			expect(useAgentStore.getState().agentsDetected).toBe(true);
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
		it('keeps another provider tab paused when clearing one recovered tab', () => {
			const error = { type: 'auth_expired', agentId: 'codex', message: 'expired' } as any;
			const session = createMockSession({
				id: 'session-1',
				state: 'error',
				agentError: error,
				agentErrorTabId: 'codex-tab',
				agentErrorPaused: true,
			});
			session.aiTabs = [
				{
					...session.aiTabs[0],
					id: 'claude-tab',
					agentError: { ...error, agentId: 'claude-code' },
				},
				{ ...session.aiTabs[0], id: 'codex-tab', agentError: error },
			];
			useSessionStore.getState().setSessions([session]);
			useAgentStore.getState().clearAgentError(session.id, 'claude-tab');
			const updated = useSessionStore.getState().sessions[0];
			expect(updated.aiTabs[0].agentError).toBeUndefined();
			expect(updated.agentError).toBe(error);
			expect(updated.agentErrorTabId).toBe('codex-tab');
			expect(updated.agentErrorPaused).toBe(true);
			expect(updated.state).toBe('error');
			expect(window.maestro.agentError.clearError).not.toHaveBeenCalled();
		});

		it('retains the remaining failed tab after the aggregate error is recovered', () => {
			const error = { type: 'auth_expired', agentId: 'codex', message: 'expired' } as any;
			const session = createMockSession({
				id: 'session-1',
				state: 'error',
				agentError: error,
				agentErrorTabId: 'codex-tab',
				agentErrorPaused: true,
			});
			session.aiTabs = [
				{
					...session.aiTabs[0],
					id: 'claude-tab',
					agentError: { ...error, agentId: 'claude-code' },
				},
				{ ...session.aiTabs[0], id: 'codex-tab', agentError: error },
			];
			useSessionStore.getState().setSessions([session]);
			useAgentStore.getState().clearAgentError(session.id, 'codex-tab');
			const updated = useSessionStore.getState().sessions[0];
			expect(updated.aiTabs[1].agentError).toBeUndefined();
			expect(updated.agentError?.agentId).toBe('claude-code');
			expect(updated.agentErrorTabId).toBe('claude-tab');
			expect(updated.agentErrorPaused).toBe(true);
			expect(updated.state).toBe('error');
			expect(window.maestro.agentError.clearError).not.toHaveBeenCalled();
		});

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

			// No tabId arg - should use session's agentErrorTabId
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
			const consoleSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});

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

		// Turns run per tab, so the bare `-ai` id matched nothing and a hung turn
		// survived the restart. Only the tab that failed is restarted.
		it('kills the process of the tab that failed', async () => {
			const session = createMockSession({
				id: 'session-1',
				state: 'error',
				agentError: { type: 'agent_crashed', message: 'crash' } as any,
				agentErrorTabId: 'tab-7',
			});
			useSessionStore.getState().setSessions([session]);

			await useAgentStore.getState().restartAgentAfterError('session-1');

			expect(mockKill).toHaveBeenCalledWith('session-1-ai-tab-7');
			expect(mockKill).toHaveBeenCalledTimes(1);
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
		it('clears error and selects the agent without touching its input mode', () => {
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
			// The login now happens in the re-authentication modal, so the agent must
			// stay in AI mode - a forced terminal switch left the user in a shell they
			// never asked for once the modal closed.
			expect(updated.inputMode).toBe('ai');
			expect(updated.agentError).toBeUndefined();
			expect(useSessionStore.getState().activeSessionId).toBe('session-1');
		});

		it('does nothing if session not found', () => {
			useAgentStore.getState().authenticateAfterError('nonexistent');
			// No crash, no IPC calls
			expect(mockClearError).not.toHaveBeenCalled();
		});

		it('leaves a session that is already in terminal mode alone', () => {
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
			expect(useSessionStore.getState().sessions[0].inputMode).toBe('ai');
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

		it('leaves the open file tab alone', () => {
			const session = createMockSession({
				id: 'session-1',
				state: 'error',
				inputMode: 'ai',
				activeFileTabId: 'file-tab-1',
			});

			useSessionStore.getState().setSessions([session]);

			useAgentStore.getState().authenticateAfterError('session-1');

			// The old flow forced the agent into terminal mode, which orphaned the
			// file preview and made this clear necessary. The re-authentication modal
			// owns the login now, so the user's view must survive it intact.
			const updated = useSessionStore.getState().sessions[0];
			expect(updated.inputMode).toBe('ai');
			expect(updated.activeFileTabId).toBe('file-tab-1');
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

			// killAgent is a low-level action - state management is caller's responsibility
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

	describe('store state access', () => {
		it('availableAgents reflects setState updates', () => {
			const agents = [createMockAgentConfig({ id: 'claude-code' })];
			useAgentStore.setState({ availableAgents: agents });

			expect(useAgentStore.getState().availableAgents).toEqual(agents);
		});

		it('agentsDetected reflects setState updates', () => {
			expect(useAgentStore.getState().agentsDetected).toBe(false);

			useAgentStore.setState({ agentsDetected: true });

			expect(useAgentStore.getState().agentsDetected).toBe(true);
		});
	});

	describe('non-React access', () => {
		it('getState returns current snapshot', () => {
			const agents = [createMockAgentConfig()];
			useAgentStore.setState({ availableAgents: agents, agentsDetected: true });

			const state = useAgentStore.getState();
			expect(state.availableAgents).toEqual(agents);
			expect(state.agentsDetected).toBe(true);
		});

		it('getState reflects latest mutations', () => {
			expect(useAgentStore.getState().agentsDetected).toBe(false);

			useAgentStore.setState({ agentsDetected: true });

			expect(useAgentStore.getState().agentsDetected).toBe(true);
		});

		it('getState exposes all 10 action functions', () => {
			const state = useAgentStore.getState();

			expect(typeof state.refreshAgents).toBe('function');
			expect(typeof state.getAgentConfig).toBe('function');
			expect(typeof state.processQueuedItem).toBe('function');
			expect(typeof state.clearAgentError).toBe('function');
			expect(typeof state.startNewSessionAfterError).toBe('function');
			expect(typeof state.retryAfterError).toBe('function');
			expect(typeof state.restartAgentAfterError).toBe('function');
			expect(typeof state.authenticateAfterError).toBe('function');
			expect(typeof state.killAgent).toBe('function');
			expect(typeof state.interruptAgent).toBe('function');
		});

		it('clearAgentError works end-to-end', () => {
			const session = createMockSession({
				id: 'session-1',
				state: 'error',
				agentError: { type: 'agent_crashed', message: 'crash' } as any,
			});
			useSessionStore.getState().setSessions([session]);

			useAgentStore.getState().clearAgentError('session-1');

			expect(useSessionStore.getState().sessions[0].state).toBe('idle');
			expect(mockClearError).toHaveBeenCalledWith('session-1');
		});

		it('killAgent works end-to-end', async () => {
			await useAgentStore.getState().killAgent('session-1', 'terminal');

			expect(mockKill).toHaveBeenCalledWith('session-1-terminal');
		});
	});

	describe('React hook integration', () => {
		it('useAgentStore with selector re-renders on agent detection', async () => {
			const { result } = renderHook(() => useAgentStore((s) => s.agentsDetected));

			expect(result.current).toBe(false);

			const agents = [createMockAgentConfig()];
			mockDetect.mockResolvedValueOnce(agents);

			await act(async () => {
				await useAgentStore.getState().refreshAgents();
			});

			expect(result.current).toBe(true);
		});

		it('useAgentStore with availableAgents selector updates on refresh', async () => {
			const { result } = renderHook(() => useAgentStore((s) => s.availableAgents));

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
			// The login happens in the re-authentication modal, so the agent stays in AI mode
			expect(useSessionStore.getState().sessions[1].inputMode).toBe('ai');
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
			expect(updated[1].inputMode).toBe('ai');
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
			resetStores(useAgentStore, useSessionStore);

			expect(useAgentStore.getState().availableAgents).toEqual([]);
			expect(useAgentStore.getState().agentsDetected).toBe(false);
		});

		it('agentStore actions work correctly after reset', () => {
			// Use the store
			const session = createMockSession({ id: 'session-1', state: 'error' });
			useSessionStore.getState().setSessions([session]);
			useAgentStore.getState().clearAgentError('session-1');

			// Reset
			resetStores(useAgentStore, useSessionStore);

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

			// interruptAgent is low-level - doesn't change session state
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

		it('holds a pending translation message with its exact settings and a review toast', async () => {
			const { useNotificationStore } = await import('../../../renderer/stores/notificationStore');
			useNotificationStore.setState({ toasts: [] });
			const session = createMockSession({ id: 'session-1', toolType: 'codex' });
			session.aiTabs[0].providerSessions = { 'claude-code': { agentSessionId: 'source' } };
			session.aiTabs[0].state = 'busy';
			useSessionStore.setState({ sessions: [session] });
			window.maestro.process.getActiveProcesses = vi.fn().mockResolvedValue([]);
			window.maestro.sessions = {
				...window.maestro.sessions,
				setMany: vi.fn().mockResolvedValue(undefined),
			};
			window.maestro.agents.translateProvider = vi.fn().mockResolvedValue({
				success: true,
				plan: {
					status: 'ready',
					source: { provider: 'claude-code', version: '2.1.296' },
					destination: { provider: 'codex', version: '0.162.1' },
					limitations: [
						{ code: 'new-warning', severity: 'warning', message: 'Review this change' },
					],
				},
			});
			const settings = { provider: 'codex' as const, model: 'frozen', effort: 'high' };
			const item: QueuedItem = {
				id: 'held',
				tabId: 'default-tab',
				type: 'message',
				text: 'Do not lose this message',
				timestamp: 1,
				turnSettings: settings,
			};
			expect(await useAgentStore.getState().processQueuedItem('session-1', item, defaultDeps)).toBe(
				false
			);
			const updated = useSessionStore.getState().sessions[0];
			expect(updated.executionQueue).toEqual([{ ...item, paused: true }]);
			expect(updated.executionQueue[0].turnSettings).toBe(settings);
			expect(updated.aiTabs[0].agentSessionId).toBeNull();
			expect(updated.aiTabs[0].state).toBe('idle');
			expect(mockSpawn).not.toHaveBeenCalled();
			expect(useNotificationStore.getState().toasts.at(-1)?.clickAction).toEqual({
				kind: 'review-translation',
				sessionId: 'session-1',
				tabId: 'default-tab',
				provider: 'codex',
			});
		});

		it('keeps a busy source alive and requeues the captured send until it settles', async () => {
			const session = createMockSession({ id: 'session-1', toolType: 'codex' });
			session.aiTabs[0].providerSessions = { 'claude-code': { agentSessionId: 'source' } };
			session.aiTabs[0].state = 'busy';
			useSessionStore.setState({ sessions: [session] });
			window.maestro.process.getActiveProcesses = vi
				.fn()
				.mockResolvedValue([{ sessionId: 'session-1-ai-default-tab' }]);
			const translate = vi.fn();
			window.maestro.agents.translateProvider = translate;
			const item = createQueuedItem({
				turnSettings: { provider: 'codex', model: 'frozen', effort: 'high' },
			});
			expect(await useAgentStore.getState().processQueuedItem(session.id, item, defaultDeps)).toBe(
				false
			);
			const updated = useSessionStore.getState().sessions[0];
			expect(updated.executionQueue).toEqual([item]);
			expect(updated.aiTabs[0].state).toBe('busy');
			expect(translate).not.toHaveBeenCalled();
			expect(mockKill).not.toHaveBeenCalled();
			expect(mockSpawn).not.toHaveBeenCalled();
		});

		it('drains a captured provider slot without reselecting a pinned tab', async () => {
			const session = createMockSession({
				id: 'session-1',
				toolType: 'claude-code',
				customPath: '/bin/claude',
			});
			const tab = session.aiTabs[0];
			tab.tabProvider = 'codex';
			tab.agentSessionId = 'codex-live';
			tab.providerSessions = { 'claude-code': { agentSessionId: 'claude-parked' } };
			useSessionStore.setState({ sessions: [session] });
			const item = createQueuedItem({
				tabId: tab.id,
				turnSettings: {
					provider: 'claude-code',
					model: 'opus',
					effort: 'high',
					runOn: { type: 'provider' },
				},
			});
			await useAgentStore.getState().processQueuedItem(session.id, item, defaultDeps);
			expect(mockSpawn).toHaveBeenCalledWith(
				expect.objectContaining({
					toolType: 'claude-code',
					agentSessionId: 'claude-parked',
					sessionCustomPath: '/bin/claude',
					sessionCustomModel: 'opus',
					runOnOverride: { type: 'provider' },
				})
			);
			expect(useSessionStore.getState().sessions[0].aiTabs[0]).toMatchObject({
				tabProvider: 'codex',
				agentSessionId: 'codex-live',
				turnProvider: 'claude-code',
			});
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

		// An item another agent's `maestro-cli dispatch` queued carries the place in
		// the consult chain its turn takes; the drain has to hand it to the spawn.
		it('hands the spawn the consult chain a queued item carries, and none otherwise', async () => {
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

			await useAgentStore.getState().processQueuedItem(
				'session-1',
				createQueuedItem({
					tabId: 'tab-1',
					text: 'Take this over',
					consultChain: { chainId: 'chain-a', depth: 2 },
				}),
				defaultDeps
			);
			await useAgentStore
				.getState()
				.processQueuedItem(
					'session-1',
					createQueuedItem({ id: 'item-2', tabId: 'tab-1', text: 'Carry on' }),
					defaultDeps
				);

			expect(mockSpawn.mock.calls[0][0].consultChain).toEqual({ chainId: 'chain-a', depth: 2 });
			expect(mockSpawn.mock.calls[1][0]).not.toHaveProperty('consultChain');
		});

		describe('New Session Message', () => {
			function seedTab(agentSessionId: string | null) {
				const session = createMockSession({
					id: 'session-1',
					toolType: 'claude-code',
					newSessionMessage: 'Always check linting',
					aiTabs: [
						{
							id: 'tab-1',
							agentSessionId,
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
			}

			it('prefixes a queued message that opens the tab (no provider session yet)', async () => {
				seedTab(null);

				await useAgentStore
					.getState()
					.processQueuedItem(
						'session-1',
						createQueuedItem({ tabId: 'tab-1', text: 'Build the feature' }),
						defaultDeps
					);

				expect(mockSpawn).toHaveBeenCalledWith(
					expect.objectContaining({
						prompt: 'Always check linting\n\n---\n\nBuild the feature',
					})
				);
			});

			it('leaves a message queued behind an existing conversation alone', async () => {
				seedTab('existing-conv-id');

				await useAgentStore
					.getState()
					.processQueuedItem(
						'session-1',
						createQueuedItem({ tabId: 'tab-1', text: 'Build the feature' }),
						defaultDeps
					);

				expect(mockSpawn).toHaveBeenCalledWith(
					expect.objectContaining({ prompt: 'Build the feature' })
				);
			});

			it('prefixes a slash command that opens the tab, and keeps it out of the transcript', async () => {
				seedTab(null);

				await useAgentStore.getState().processQueuedItem(
					'session-1',
					createQueuedItem({
						tabId: 'tab-1',
						type: 'command',
						command: '/commit',
						text: undefined,
					}),
					{
						...defaultDeps,
						customAICommands: [
							{
								id: 'cmd-1',
								command: '/commit',
								description: 'Commit changes',
								prompt: 'Please commit all changes',
							},
						],
					}
				);

				expect(mockSpawn).toHaveBeenCalledWith(
					expect.objectContaining({
						prompt: expect.stringMatching(
							/^Always check linting\n\n---\n\n[\s\S]*commit all changes/
						),
					})
				);

				const [userEntry] = useSessionStore.getState().sessions[0].aiTabs[0].logs;
				expect(userEntry.text).not.toContain('Always check linting');
			});
		});

		describe('tab auto-naming (issue #1531)', () => {
			const seedUnnamedTab = () => {
				useSessionStore.getState().setSessions([
					createMockSession({
						id: 'session-1',
						toolType: 'claude-code',
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
							},
						],
						activeTabId: 'tab-1',
					}),
				]);
			};

			it('names the target tab from a queued message (dispatch --queue never passes the composer)', async () => {
				seedUnnamedTab();
				await useAgentStore
					.getState()
					.processQueuedItem(
						'session-1',
						createQueuedItem({ tabId: 'tab-1', text: 'Build the feature' }),
						defaultDeps
					);

				expect(requestTabAutoNameForMessage).toHaveBeenCalledTimes(1);
				expect(requestTabAutoNameForMessage).toHaveBeenCalledWith(
					expect.objectContaining({ id: 'session-1' }),
					'tab-1',
					'Build the feature',
					'queue'
				);
			});

			it('names the tab of a leading-mention item, which consults without spawning', async () => {
				seedUnnamedTab();
				await useAgentStore.getState().processQueuedItem(
					'session-1',
					createQueuedItem({
						tabId: 'tab-1',
						text: '@Backend review the schema',
						crossAgentMention: true,
						crossAgentOnly: true,
					}),
					defaultDeps
				);

				expect(mockSpawn).not.toHaveBeenCalled();
				expect(requestTabAutoNameForMessage).toHaveBeenCalledWith(
					expect.objectContaining({ id: 'session-1' }),
					'tab-1',
					'@Backend review the schema',
					'queue'
				);
			});

			it('does not name a tab from a queued slash command', async () => {
				seedUnnamedTab();
				await useAgentStore
					.getState()
					.processQueuedItem(
						'session-1',
						createQueuedItem({ tabId: 'tab-1', type: 'command', text: undefined, command: '/x' }),
						defaultDeps
					);

				expect(requestTabAutoNameForMessage).not.toHaveBeenCalled();
			});

			it("does not name a tab from a released consult hold (Maestro's own note)", async () => {
				seedUnnamedTab();
				await useAgentStore.getState().processQueuedItem(
					'session-1',
					createQueuedItem({
						tabId: 'tab-1',
						text: 'Backend replied. Finish your answer with what came back.',
						agentContext: 'Backend said: looks good',
					}),
					defaultDeps
				);

				expect(mockSpawn).toHaveBeenCalledTimes(1);
				expect(requestTabAutoNameForMessage).not.toHaveBeenCalled();
			});
		});

		// A queued message that @mentions another agent must consult that agent HERE,
		// as the message becomes this agent's turn - not when the user typed it into
		// a queue that was several messages deep.
		it('fires the deferred cross-agent consult when the item carries one', async () => {
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

			const item = createQueuedItem({
				tabId: 'tab-1',
				text: 'now ask @Backend to review',
				crossAgentMention: true,
			});

			await useAgentStore.getState().processQueuedItem('session-1', item, defaultDeps);

			expect(dispatchCrossAgentMentionsForMessage).toHaveBeenCalledTimes(1);
			expect(dispatchCrossAgentMentionsForMessage).toHaveBeenCalledWith(
				'now ask @Backend to review',
				expect.objectContaining({ id: 'session-1' }),
				'tab-1',
				undefined,
				// The user queued it, so the mention is in no consult chain.
				undefined,
				undefined
			);
			// The local turn still runs: a trailing mention does not suppress it.
			expect(mockSpawn).toHaveBeenCalledTimes(1);
		});

		// An item another agent's `maestro-cli dispatch` queued is in that agent's
		// consult chain, and so is a mention inside it: main spends from the chain.
		it('hands the consult chain and picked routing to queued mentions', async () => {
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

			const item = createQueuedItem({
				tabId: 'tab-1',
				text: 'now ask @Backend to review',
				crossAgentMention: true,
				consultChain: { chainId: 'chain-a', depth: 1 },
				mentionRouting: 'parallel',
			});

			await useAgentStore.getState().processQueuedItem('session-1', item, defaultDeps);

			expect(dispatchCrossAgentMentionsForMessage).toHaveBeenCalledWith(
				'now ask @Backend to review',
				expect.objectContaining({ id: 'session-1' }),
				'tab-1',
				undefined,
				{ chainId: 'chain-a', depth: 1 },
				'parallel'
			);
		});

		// A mention-only item (the message was addressed at the other agent) fires
		// the consult and nothing else - there is no local turn to run.
		it('consults and stops for a crossAgentOnly item, releasing the agent', async () => {
			const session = createMockSession({
				id: 'session-1',
				toolType: 'claude-code',
				state: 'busy',
				busySource: 'ai',
				thinkingStartTime: 1,
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
						state: 'busy',
					},
				],
				activeTabId: 'tab-1',
			});
			useSessionStore.getState().setSessions([session]);

			const item = createQueuedItem({
				tabId: 'tab-1',
				text: '@rc pull in the latest changes',
				crossAgentMention: true,
				crossAgentOnly: true,
			});

			await useAgentStore.getState().processQueuedItem('session-1', item, defaultDeps);

			expect(dispatchCrossAgentMentionsForMessage).toHaveBeenCalledTimes(1);
			// No local turn: the source agent was never asked to answer this.
			expect(mockSpawn).not.toHaveBeenCalled();

			// The dequeue marked the tab busy and nothing else will close it out, so
			// this path has to release it or the agent hangs on a turn that never ran.
			const updated = useSessionStore.getState().sessions[0];
			expect(updated.aiTabs[0].state).toBe('idle');
			expect(updated.state).toBe('idle');
			expect(updated.busySource).toBeUndefined();
		});

		it('does not consult anyone for an item without a pending mention', async () => {
			// Queued items from Auto Run, Cue, and the CLI never planned a consult.
			// An `@` in their text must not turn into one at dispatch time.
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

			const item = createQueuedItem({ tabId: 'tab-1', text: 'email ops@example.com' });

			await useAgentStore.getState().processQueuedItem('session-1', item, defaultDeps);

			expect(dispatchCrossAgentMentionsForMessage).not.toHaveBeenCalled();
		});

		it('prepends and clears the tab pendingMergedContext (session recovery sent while queued)', async () => {
			const session = createMockSession({
				id: 'session-1',
				toolType: 'claude-code',
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
						pendingMergedContext: '# Prior Conversation',
					},
				],
				activeTabId: 'tab-1',
			});
			useSessionStore.getState().setSessions([session]);

			const item = createQueuedItem({ tabId: 'tab-1', text: 'Please do and deploy' });

			await useAgentStore.getState().processQueuedItem('session-1', item, defaultDeps);

			expect(mockSpawn).toHaveBeenCalledWith(
				expect.objectContaining({
					prompt: '# Prior Conversation\n\n---\n\nPlease do and deploy',
				})
			);
			const tab = useSessionStore.getState().sessions[0].aiTabs[0];
			expect(tab.pendingMergedContext).toBeUndefined();
		});

		it('prepends system prompt for new sessions (no agentSessionId)', async () => {
			const session = createMockSession({
				id: 'session-1',
				toolType: 'claude-code',
				aiTabs: [
					{
						id: 'tab-1',
						agentSessionId: null, // NEW session - no conversation ID
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

			// System prompt should be passed separately for new sessions
			const spawnCall = mockSpawn.mock.calls[0][0];
			expect(spawnCall.appendSystemPrompt).toContain('Mock system prompt');
			expect(spawnCall.prompt).toBe('Hello');
			expect(spawnCall.prompt).not.toContain('# User Request');
		});

		it('still passes system prompt for existing sessions (Claude Code does not persist --append-system-prompt across resume)', async () => {
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
			expect(spawnCall.appendSystemPrompt).toContain('Mock system prompt');
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

		it('sends permissionMode "readonly" when queued item forces read-only despite tab permissionMode "full"', async () => {
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
						permissionMode: 'full',
					},
				],
				activeTabId: 'tab-1',
			});
			useSessionStore.getState().setSessions([session]);

			const item = createQueuedItem({
				tabId: 'tab-1',
				text: 'Read only query',
				readOnlyMode: true,
			});

			await useAgentStore.getState().processQueuedItem('session-1', item, defaultDeps);

			const spawnCall = mockSpawn.mock.calls[0][0];
			expect(spawnCall.readOnlyMode).toBe(true);
			expect(spawnCall.permissionMode).toBe('readonly');
		});

		it('sends permissionMode "full" for a queued item on a tab with no permissionMode set', async () => {
			// Regression for the queued-spawn drift (Greptile P1): a fresh tab resolves
			// to Full Access in the toolbar, so its queued non-interactive spawn must
			// also pass permissionMode: 'full' - otherwise buildAgentArgs withholds
			// Claude Code's --dangerously-skip-permissions and the queued work deadlocks
			// on denied tools.
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
				text: 'Do the thing',
				readOnlyMode: false,
			});

			await useAgentStore.getState().processQueuedItem('session-1', item, defaultDeps);

			const spawnCall = mockSpawn.mock.calls[0][0];
			expect(spawnCall.readOnlyMode).toBe(false);
			expect(spawnCall.permissionMode).toBe('full');
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
			expect(updated.aiTabs[0].logs[0].source).toBe('error');
			expect(updated.aiTabs[0].logs[0].text).toContain('Unknown command: /nonexistent');
		});

		it('targets the queued item tab, not whatever tab is currently active, for unknown command errors', async () => {
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
					{
						id: 'tab-2',
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
				// Active tab is tab-2, but the queued item belongs to tab-1
				activeTabId: 'tab-2',
			});
			useSessionStore.getState().setSessions([session]);

			const item = createQueuedItem({
				tabId: 'tab-1',
				type: 'command',
				command: '/nonexistent',
				text: undefined,
			});

			await useAgentStore.getState().processQueuedItem('session-1', item, defaultDeps);

			const updated = useSessionStore.getState().sessions[0];
			const tab1 = updated.aiTabs.find((t) => t.id === 'tab-1')!;
			const tab2 = updated.aiTabs.find((t) => t.id === 'tab-2')!;

			expect(tab1.logs).toHaveLength(1);
			expect(tab1.logs[0].text).toContain('Unknown command: /nonexistent');
			expect(tab2.logs).toHaveLength(0);
		});

		it.each([
			{
				toolType: 'claude-code' as const,
				command: '/implement',
				prompt: 'Implement the approved plan now.',
			},
			{
				toolType: 'codex' as const,
				command: '/plugin:code-review',
				prompt: '$plugin:code-review\n\nUse the skill at "/skills/code-review/SKILL.md".',
			},
		])(
			'resolves and dispatches $command via session.agentCommands with trailing arguments',
			async ({ toolType, command, prompt }) => {
				const session = createMockSession({
					id: 'session-1',
					toolType,
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
					agentCommands: [
						{
							command,
							description: 'Implement the plan',
							prompt,
						},
					],
				});
				session.agentCommandsScope = agentCommandScope(session, session.aiTabs[0]);
				useSessionStore.getState().setSessions([session]);

				const item = createQueuedItem({
					tabId: 'tab-1',
					type: 'command',
					command,
					commandArgs: 'Focus on the current branch.',
					text: undefined,
				});

				await useAgentStore.getState().processQueuedItem('session-1', item, defaultDeps);

				expect(mockSpawn).toHaveBeenCalledTimes(1);
				expect(mockSpawn).toHaveBeenCalledWith(
					expect.objectContaining({
						prompt: expect.stringContaining(`${prompt}\n\nFocus on the current branch.`),
					})
				);

				const updated = useSessionStore.getState().sessions[0];
				expect(updated.aiTabs[0].logs).toHaveLength(1);
				expect(updated.aiTabs[0].logs[0].source).toBe('user');
				expect(updated.aiTabs[0].logs[0].aiCommand?.command).toBe(command);
			}
		);

		it('handles spawn error gracefully', async () => {
			mockSpawn.mockRejectedValueOnce(new Error('Spawn failed'));
			const consoleSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});

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

			// The failure is recorded AND rethrown: callers wrap this in a `.catch()`
			// that re-queues the prompt, and swallowing it dropped the user's message.
			await expect(
				useAgentStore.getState().processQueuedItem('session-1', item, defaultDeps)
			).rejects.toThrow('Spawn failed');

			// Should still have reset to idle on the way out
			const updated = useSessionStore.getState().sessions[0];
			expect(updated.state).toBe('idle');
			expect(updated.busySource).toBeUndefined();

			consoleSpy.mockRestore();
		});

		it('targets the queued item tab, not whatever tab is currently active, when spawn throws', async () => {
			mockSpawn.mockRejectedValueOnce(new Error('Spawn failed'));
			const consoleSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});

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
					{
						id: 'tab-2',
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
				// Active tab is tab-2, but the queued item belongs to tab-1
				activeTabId: 'tab-2',
			});
			useSessionStore.getState().setSessions([session]);

			const item = createQueuedItem({ tabId: 'tab-1', text: 'Will fail' });

			await expect(
				useAgentStore.getState().processQueuedItem('session-1', item, defaultDeps)
			).rejects.toThrow('Spawn failed');

			const updated = useSessionStore.getState().sessions[0];
			const tab1 = updated.aiTabs.find((t) => t.id === 'tab-1')!;
			const tab2 = updated.aiTabs.find((t) => t.id === 'tab-2')!;

			expect(tab1.logs).toHaveLength(1);
			expect(tab1.logs[0].text).toContain('Failed to send queued');
			expect(tab1.logs[0].source).toBe('error');
			expect(tab2.logs).toHaveLength(0);

			consoleSpy.mockRestore();
		});

		it('logs a diagnostic instead of silently dropping the error when the resolved tab no longer exists in aiTabs', async () => {
			mockSpawn.mockRejectedValueOnce(new Error('Spawn failed'));
			const consoleSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});

			// tab-1 was closed while it had queued work, so it now lives in
			// orphanedThinkingTabs (not aiTabs) - it's still a valid spawn target,
			// but the catch block's error log has nowhere in aiTabs to land.
			const session = createMockSession({
				id: 'session-1',
				state: 'busy',
				aiTabs: [
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
					},
				],
				orphanedThinkingTabs: [
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
				activeTabId: 'tab-2',
			});
			useSessionStore.getState().setSessions([session]);

			const item = createQueuedItem({ tabId: 'tab-1', text: 'Will fail' });

			await expect(
				useAgentStore.getState().processQueuedItem('session-1', item, defaultDeps)
			).rejects.toThrow('Spawn failed');

			expect(consoleSpy).toHaveBeenCalledWith(
				'[processQueuedItem error] Target tab not found - error log dropped',
				undefined,
				{ sessionId: 'session-1', resolvedTabId: 'tab-1' }
			);

			const updated = useSessionStore.getState().sessions[0];
			const tab2 = updated.aiTabs.find((t) => t.id === 'tab-2')!;
			expect(tab2.logs).toHaveLength(0);

			consoleSpy.mockRestore();
		});

		it('does nothing for nonexistent session', async () => {
			const consoleSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});

			const item = createQueuedItem({ text: 'Hello' });

			await useAgentStore.getState().processQueuedItem('nonexistent', item, defaultDeps);

			expect(mockSpawn).not.toHaveBeenCalled();
			expect(consoleSpy).toHaveBeenCalledWith(
				expect.stringContaining('[processQueuedItem] Session not found'),
				undefined,
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

		it('prefers tab-level customModel/customEffort over session values', async () => {
			const session = createMockSession({
				id: 'session-1',
				toolType: 'claude-code',
				customModel: 'session-model',
				customEffort: 'session-effort',
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
						customModel: 'tab-model',
						customEffort: 'tab-effort',
					},
				],
				activeTabId: 'tab-1',
			});
			useSessionStore.getState().setSessions([session]);

			const item = createQueuedItem({ tabId: 'tab-1', text: 'Hello' });

			await useAgentStore.getState().processQueuedItem('session-1', item, defaultDeps);

			expect(mockSpawn).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionCustomModel: 'tab-model',
					sessionCustomEffort: 'tab-effort',
				})
			);
		});

		it('falls back to session customModel/customEffort when tab override is unset', async () => {
			const session = createMockSession({
				id: 'session-1',
				toolType: 'claude-code',
				customModel: 'session-model',
				customEffort: 'session-effort',
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
					sessionCustomModel: 'session-model',
					sessionCustomEffort: 'session-effort',
				})
			);
		});

		// Queuing IS the send: the item carries the model/effort the user had
		// selected when they hit Enter, and the spawn must honour that no matter
		// how many times they switched models before the queue drained.
		it('spawns a queued item under the settings frozen when it was queued', async () => {
			const session = createMockSession({
				id: 'session-1',
				toolType: 'claude-code',
				customModel: 'session-model',
				customEffort: 'session-effort',
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
						customModel: 'tab-model',
						customEffort: 'tab-effort',
					},
				],
				activeTabId: 'tab-1',
			});
			useSessionStore.getState().setSessions([session]);

			const item = createQueuedItem({
				tabId: 'tab-1',
				text: 'Hello',
				turnSettings: { model: 'queued-model', effort: 'queued-effort' },
			});

			await useAgentStore.getState().processQueuedItem('session-1', item, defaultDeps);

			expect(mockSpawn).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionCustomModel: 'queued-model',
					sessionCustomEffort: 'queued-effort',
				})
			);
		});

		// An empty capture is a real choice ("the agent default was in force"),
		// not a missing one - so it must NOT inherit what the user picked after.
		it('keeps an item queued on the agent default off the live overrides', async () => {
			const session = createMockSession({
				id: 'session-1',
				toolType: 'claude-code',
				customModel: 'session-model',
				customEffort: 'session-effort',
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
						customModel: 'tab-model',
						customEffort: 'tab-effort',
					},
				],
				activeTabId: 'tab-1',
			});
			useSessionStore.getState().setSessions([session]);

			const item = createQueuedItem({ tabId: 'tab-1', text: 'Hello', turnSettings: {} });

			await useAgentStore.getState().processQueuedItem('session-1', item, defaultDeps);

			expect(mockSpawn).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionCustomModel: undefined,
					sessionCustomEffort: undefined,
				})
			);
		});

		// A turn on the Auto model: the tab takes it with a stamp, and the
		// dispatch asks the router and launches on what it answers.
		describe('an item on the Auto model', () => {
			const ROUTED = {
				tier: 'medium',
				effort: 'low',
				engine: { id: 'embedding-router', label: 'Embedding router', calibrated: false },
				latencyMs: 20,
			};
			const STAMP = {
				tier: 'medium',
				effort: 'low',
				engine: 'Embedding router',
				calibrated: false,
			};

			/** Seed an agent, and mark its tab as running `item` the way every dispatch path does. */
			function seedRunning(item: QueuedItem, overrides: Partial<Session> = {}): void {
				const session = createMockSession({
					id: 'session-1',
					toolType: 'claude-code',
					customModel: 'auto',
					customEffort: 'high',
					...overrides,
				});
				const tabId = session.aiTabs[0].id;
				useSessionStore.getState().setSessions([
					{
						...session,
						aiTabs: session.aiTabs.map((tab) =>
							tab.id === tabId ? markTabRunningQueuedItem(tab, item, session) : tab
						),
					},
				]);
			}
			const liveTab = () => useSessionStore.getState().sessions[0].aiTabs[0];

			beforeEach(() => {
				resetAutoTurnForTests();
				mockSpawn.mockClear();
				mockRouteTurn.mockReset();
				mockRouteTurn.mockResolvedValue(ROUTED);
			});

			afterEach(() => {
				mockRouteTurn.mockReset();
				mockRouteTurn.mockResolvedValue(ROUTER_OFF);
			});

			it('asks the router about the message and launches on its tier and effort', async () => {
				const item = createQueuedItem({
					text: 'Rename the helper',
					turnSettings: { model: 'auto', effort: 'high' },
				});
				seedRunning(item);
				expect(liveTab().turnAuto).toEqual({ status: 'pending' });

				await useAgentStore.getState().processQueuedItem('session-1', item, defaultDeps);

				expect(mockRouteTurn).toHaveBeenCalledTimes(1);
				expect(mockRouteTurn.mock.calls[0][0]).toMatchObject({
					prompt: 'Rename the helper',
					agentId: 'session-1',
					tabId: 'default-tab',
				});
				const spawned = mockSpawn.mock.calls[0][0];
				expect(spawned.sessionCustomModel).toBe('sonnet');
				expect(spawned.sessionCustomEffort).toBe('low');
				expect(spawned.runOnOverride).toEqual({ type: 'provider' });
				expect(liveTab()).toMatchObject({
					turnModel: 'sonnet',
					turnEffort: 'low',
					turnAuto: { status: 'routed', route: STAMP },
				});
			});

			it('never hands the harness the word auto, whatever the router says', async () => {
				mockRouteTurn.mockResolvedValue(ROUTER_OFF);
				const item = createQueuedItem({ turnSettings: { model: 'auto', effort: 'high' } });
				seedRunning(item);

				await useAgentStore.getState().processQueuedItem('session-1', item, defaultDeps);

				const spawned = mockSpawn.mock.calls[0][0];
				expect(spawned.sessionCustomModel).toBeUndefined();
				expect(spawned.sessionCustomEffort).toBe('high');
				expect(liveTab().turnAuto?.status).toBe('router-off');
			});

			it('routed when it was queued: the drain asks nothing', async () => {
				const item = createQueuedItem({
					turnSettings: { model: 'auto', effort: 'high', route: STAMP },
				});
				seedRunning(item);
				expect(liveTab().turnAuto?.status).toBe('routed');

				await useAgentStore.getState().processQueuedItem('session-1', item, defaultDeps);

				expect(mockRouteTurn).not.toHaveBeenCalled();
				expect(mockSpawn.mock.calls[0][0]).toMatchObject({
					sessionCustomModel: 'sonnet',
					sessionCustomEffort: 'low',
				});
			});

			it('stays on Auto when the agent has moved to a named model since it was queued', async () => {
				const item = createQueuedItem({ turnSettings: { model: 'auto' } });
				seedRunning(item, { customModel: 'opus' });

				await useAgentStore.getState().processQueuedItem('session-1', item, defaultDeps);

				expect(mockRouteTurn).toHaveBeenCalledTimes(1);
				expect(mockSpawn.mock.calls[0][0].sessionCustomModel).toBe('sonnet');
			});

			it('an item queued on a named model is not routed by an agent now set to Auto', async () => {
				const item = createQueuedItem({ turnSettings: { model: 'haiku', effort: 'low' } });
				seedRunning(item);

				await useAgentStore.getState().processQueuedItem('session-1', item, defaultDeps);

				expect(mockRouteTurn).not.toHaveBeenCalled();
				expect(mockSpawn.mock.calls[0][0]).toMatchObject({
					sessionCustomModel: 'haiku',
					sessionCustomEffort: 'low',
				});
				expect(liveTab().turnAuto).toBeUndefined();
			});

			it('launches a tier the agent maps to a source on that source', async () => {
				const local = { type: 'source' as const, endpointId: 'ep-ollama', model: 'qwen3:latest' };
				const item = createQueuedItem({ turnSettings: { model: 'auto' } });
				seedRunning(item, { tierTargets: { medium: local } });

				await useAgentStore.getState().processQueuedItem('session-1', item, defaultDeps);

				expect(mockSpawn.mock.calls[0][0]).toMatchObject({
					sessionCustomModel: 'qwen3:latest',
					runOnOverride: local,
				});
			});

			it('does not launch when the tier names a target that cannot be used: the item is held', async () => {
				const item = createQueuedItem({ turnSettings: { model: 'auto' } });
				seedRunning(item, {
					toolType: 'factory-droid',
					tierTargets: { medium: { type: 'source', endpointId: 'ep-x', model: 'qwen3' } },
				});
				mockGetAgent.mockResolvedValue({ ...mockAgent, id: 'factory-droid' });

				await expect(
					useAgentStore.getState().processQueuedItem('session-1', item, defaultDeps)
				).rejects.toThrow(/This agent's "medium" tier target/);

				expect(mockSpawn).not.toHaveBeenCalled();
				const session = useSessionStore.getState().sessions[0];
				expect(session.executionQueue.map((queued) => queued.id)).toContain(item.id);
				expect(session.executionQueue.find((queued) => queued.id === item.id)?.paused).toBe(true);
			});

			it('routes a command on the prompt it expands to', async () => {
				const item = createQueuedItem({
					type: 'command',
					text: undefined,
					command: '/review',
					commandArgs: 'the auth module',
					turnSettings: { model: 'auto' },
				});
				seedRunning(item);

				await useAgentStore.getState().processQueuedItem('session-1', item, {
					...defaultDeps,
					customAICommands: [
						{ id: 'c1', command: '/review', description: 'Review', prompt: 'Review $ARGUMENTS' },
					] as any,
				});

				expect(mockRouteTurn).toHaveBeenCalledTimes(1);
				expect(mockRouteTurn.mock.calls[0][0].prompt).toBe('Review the auth module');
				expect(mockSpawn.mock.calls[0][0].sessionCustomModel).toBe('sonnet');
			});
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
			const consoleSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

			await useAgentStore.getState().processQueuedItem('session-1', item, defaultDeps);

			expect(mockSpawn).not.toHaveBeenCalled();
			expect(consoleSpy).toHaveBeenCalledWith(
				expect.stringContaining('Target tab was deleted after queueing'),
				undefined,
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
			const consoleSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});

			await useAgentStore.getState().processQueuedItem('session-1', item, defaultDeps);

			expect(mockSpawn).not.toHaveBeenCalled();
			expect(consoleSpy).toHaveBeenCalledWith(
				expect.stringContaining('No target tab found'),
				undefined,
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
