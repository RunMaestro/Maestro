/**
 * Tests for useAgentListeners hook - IPC process event listener orchestration
 *
 * Tests listener registration/cleanup, the getErrorTitleForType helper,
 * and key handler behaviors for onData, onExit, onCommandExit, onAgentError,
 * onSlashCommands, onStderr, onSessionId, onUsage, and onSshRemote.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
	useAgentListeners,
	getErrorTitleForType,
	type BatchedUpdater,
	type UseAgentListenersDeps,
} from '../../../renderer/hooks/agent/useAgentListeners';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useModalStore } from '../../../renderer/stores/modalStore';
import { useGroupChatStore } from '../../../renderer/stores/groupChatStore';
import type { Session, AITab, AgentError } from '../../../renderer/types';
import { createMockAITab } from '../../helpers/mockTab';
import { createMockSession as baseCreateMockSession } from '../../helpers/mockSession';

// ============================================================================
// Helpers
// ============================================================================

function createMockTab(overrides: Partial<AITab> = {}): AITab {
	return createMockAITab({
		createdAt: 1700000000000,
		saveToHistory: true,
		...overrides,
	});
}

// Thin wrapper: pre-populates a base AI tab so agent listeners have a
// target tab for streaming events.
function createMockSession(overrides: Partial<Session> = {}): Session {
	const baseTab = createMockTab();
	return baseCreateMockSession({
		isGitRepo: true,
		aiTabs: [baseTab],
		activeTabId: baseTab.id,
		unifiedTabOrder: [{ type: 'ai' as const, id: baseTab.id }],
		...overrides,
	});
}

// ============================================================================
// Mock IPC handlers — capture registered listeners
// ============================================================================

type ListenerCallback = (...args: any[]) => any;

let onDataHandler: ListenerCallback | undefined;
let onExitHandler: ListenerCallback | undefined;
let onSessionIdHandler: ListenerCallback | undefined;
let onSlashCommandsHandler: ListenerCallback | undefined;
let onStderrHandler: ListenerCallback | undefined;
let onCommandExitHandler: ListenerCallback | undefined;
let onUsageHandler: ListenerCallback | undefined;
let onAgentErrorHandler: ListenerCallback | undefined;
let onThinkingChunkHandler: ListenerCallback | undefined;
let onSshRemoteHandler: ListenerCallback | undefined;
let onToolExecutionHandler: ListenerCallback | undefined;

const mockUnsubscribeData = vi.fn();
const mockUnsubscribeExit = vi.fn();
const mockUnsubscribeSessionId = vi.fn();
const mockUnsubscribeSlashCommands = vi.fn();
const mockUnsubscribeStderr = vi.fn();
const mockUnsubscribeCommandExit = vi.fn();
const mockUnsubscribeUsage = vi.fn();
const mockUnsubscribeAgentError = vi.fn();
const mockUnsubscribeThinkingChunk = vi.fn();
const mockUnsubscribeSshRemote = vi.fn();
const mockUnsubscribeToolExecution = vi.fn();

const mockProcess = {
	onData: vi.fn((handler: ListenerCallback) => {
		onDataHandler = handler;
		return mockUnsubscribeData;
	}),
	onExit: vi.fn((handler: ListenerCallback) => {
		onExitHandler = handler;
		return mockUnsubscribeExit;
	}),
	onSessionId: vi.fn((handler: ListenerCallback) => {
		onSessionIdHandler = handler;
		return mockUnsubscribeSessionId;
	}),
	onSlashCommands: vi.fn((handler: ListenerCallback) => {
		onSlashCommandsHandler = handler;
		return mockUnsubscribeSlashCommands;
	}),
	onStderr: vi.fn((handler: ListenerCallback) => {
		onStderrHandler = handler;
		return mockUnsubscribeStderr;
	}),
	onCommandExit: vi.fn((handler: ListenerCallback) => {
		onCommandExitHandler = handler;
		return mockUnsubscribeCommandExit;
	}),
	onUsage: vi.fn((handler: ListenerCallback) => {
		onUsageHandler = handler;
		return mockUnsubscribeUsage;
	}),
	onAgentError: vi.fn((handler: ListenerCallback) => {
		onAgentErrorHandler = handler;
		return mockUnsubscribeAgentError;
	}),
	onThinkingChunk: vi.fn((handler: ListenerCallback) => {
		onThinkingChunkHandler = handler;
		return mockUnsubscribeThinkingChunk;
	}),
	onSshRemote: vi.fn((handler: ListenerCallback) => {
		onSshRemoteHandler = handler;
		return mockUnsubscribeSshRemote;
	}),
	onToolExecution: vi.fn((handler: ListenerCallback) => {
		onToolExecutionHandler = handler;
		return mockUnsubscribeToolExecution;
	}),
	getActiveProcesses: vi.fn().mockResolvedValue([]),
	spawn: vi.fn(),
	kill: vi.fn(),
	interrupt: vi.fn(),
};

// ============================================================================
// Mock deps factory
// ============================================================================

function createMockBatchedUpdater(): BatchedUpdater {
	return {
		appendLog: vi.fn(),
		markDelivered: vi.fn(),
		markUnread: vi.fn(),
		updateUsage: vi.fn(),
		updateContextUsage: vi.fn(),
		updateCycleBytes: vi.fn(),
		updateCycleTokens: vi.fn(),
	};
}

function createMockDeps(overrides: Partial<UseAgentListenersDeps> = {}): UseAgentListenersDeps {
	return {
		batchedUpdater: createMockBatchedUpdater(),
		addToastRef: { current: vi.fn() },
		addHistoryEntryRef: { current: vi.fn() },
		spawnBackgroundSynopsisRef: { current: null },
		getBatchStateRef: { current: null },
		pauseBatchOnErrorRef: { current: null },
		rightPanelRef: { current: null },
		processQueuedItemRef: { current: null },
		contextWarningYellowThreshold: 80,
		...overrides,
	};
}

// ============================================================================
// Setup
// ============================================================================

beforeEach(() => {
	vi.clearAllMocks();

	// Reset captured handlers
	onDataHandler = undefined;
	onExitHandler = undefined;
	onSessionIdHandler = undefined;
	onSlashCommandsHandler = undefined;
	onStderrHandler = undefined;
	onCommandExitHandler = undefined;
	onUsageHandler = undefined;
	onAgentErrorHandler = undefined;
	onThinkingChunkHandler = undefined;
	onSshRemoteHandler = undefined;
	onToolExecutionHandler = undefined;

	// Reset stores
	useSessionStore.setState({
		sessions: [],
		groups: [],
		activeSessionId: '',
		initialLoadComplete: false,
		removedWorktreePaths: new Set(),
	});
	useModalStore.getState().closeAll();

	// Mock window.maestro
	(window as any).maestro = {
		...((window as any).maestro || {}),
		process: mockProcess,
		agentError: {
			clearError: vi.fn().mockResolvedValue(undefined),
		},
		agentSessions: {
			registerSessionOrigin: vi.fn().mockResolvedValue(undefined),
		},
		stats: {
			recordQuery: vi.fn().mockResolvedValue(undefined),
		},
		logger: {
			log: vi.fn(),
		},
		agents: {
			detect: vi.fn().mockResolvedValue([]),
			get: vi.fn().mockResolvedValue(null),
		},
	};
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

// ============================================================================
// getErrorTitleForType
// ============================================================================

describe('getErrorTitleForType', () => {
	it.each([
		['auth_expired', 'Authentication Required'],
		['token_exhaustion', 'Context Limit Reached'],
		['rate_limited', 'Rate Limit Exceeded'],
		['network_error', 'Connection Error'],
		['agent_crashed', 'Agent Error'],
		['permission_denied', 'Permission Denied'],
		['session_not_found', 'Session Not Found'],
	] as const)('maps %s to "%s"', (type, expected) => {
		expect(getErrorTitleForType(type)).toBe(expected);
	});

	it('returns "Error" for unknown types', () => {
		expect(getErrorTitleForType('unknown_type' as any)).toBe('Error');
	});
});

// ============================================================================
// Listener Registration & Cleanup
// ============================================================================

describe('useAgentListeners', () => {
	describe('listener registration', () => {
		it('registers all 11 IPC listeners on mount', () => {
			const deps = createMockDeps();
			renderHook(() => useAgentListeners(deps));

			expect(mockProcess.onData).toHaveBeenCalledTimes(1);
			expect(mockProcess.onExit).toHaveBeenCalledTimes(1);
			expect(mockProcess.onSessionId).toHaveBeenCalledTimes(1);
			expect(mockProcess.onSlashCommands).toHaveBeenCalledTimes(1);
			expect(mockProcess.onStderr).toHaveBeenCalledTimes(1);
			expect(mockProcess.onCommandExit).toHaveBeenCalledTimes(1);
			expect(mockProcess.onUsage).toHaveBeenCalledTimes(1);
			expect(mockProcess.onAgentError).toHaveBeenCalledTimes(1);
			expect(mockProcess.onThinkingChunk).toHaveBeenCalledTimes(1);
			expect(mockProcess.onSshRemote).toHaveBeenCalledTimes(1);
			expect(mockProcess.onToolExecution).toHaveBeenCalledTimes(1);
		});

		it('unsubscribes all 11 listeners on unmount', () => {
			const deps = createMockDeps();
			const { unmount } = renderHook(() => useAgentListeners(deps));

			unmount();

			expect(mockUnsubscribeData).toHaveBeenCalledTimes(1);
			expect(mockUnsubscribeExit).toHaveBeenCalledTimes(1);
			expect(mockUnsubscribeSessionId).toHaveBeenCalledTimes(1);
			expect(mockUnsubscribeSlashCommands).toHaveBeenCalledTimes(1);
			expect(mockUnsubscribeStderr).toHaveBeenCalledTimes(1);
			expect(mockUnsubscribeCommandExit).toHaveBeenCalledTimes(1);
			expect(mockUnsubscribeUsage).toHaveBeenCalledTimes(1);
			expect(mockUnsubscribeAgentError).toHaveBeenCalledTimes(1);
			expect(mockUnsubscribeThinkingChunk).toHaveBeenCalledTimes(1);
			expect(mockUnsubscribeSshRemote).toHaveBeenCalledTimes(1);
			expect(mockUnsubscribeToolExecution).toHaveBeenCalledTimes(1);
		});

		it('does not register listeners twice on re-render', () => {
			const deps = createMockDeps();
			const { rerender } = renderHook(() => useAgentListeners(deps));

			rerender();
			rerender();

			// Still only 1 call each (effect has [] deps)
			expect(mockProcess.onData).toHaveBeenCalledTimes(1);
			expect(mockProcess.onExit).toHaveBeenCalledTimes(1);
		});
	});

	// ========================================================================
	// onData handler
	// ========================================================================

	describe('onData', () => {
		it('appends AI data to the correct tab via batchedUpdater', () => {
			const deps = createMockDeps();
			const session = createMockSession({
				id: 'sess-1',
				state: 'busy',
				aiTabs: [createMockTab({ id: 'tab-1' })],
				activeTabId: 'tab-1',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			// Simulate AI data event: sessionId format is "{sessionId}-ai-{tabId}"
			onDataHandler?.('sess-1-ai-tab-1', 'Hello world');

			expect(deps.batchedUpdater.appendLog).toHaveBeenCalledWith(
				'sess-1',
				'tab-1',
				true,
				'Hello world'
			);
			expect(deps.batchedUpdater.markDelivered).toHaveBeenCalledWith('sess-1', 'tab-1');
		});

		it('skips empty stdout for non-AI data', () => {
			const deps = createMockDeps();
			renderHook(() => useAgentListeners(deps));

			// Terminal data with empty content
			onDataHandler?.('sess-1', '');

			expect(deps.batchedUpdater.appendLog).not.toHaveBeenCalled();
		});

		it('appends terminal data to shell log (isAi=false)', () => {
			const deps = createMockDeps();
			const session = createMockSession({ id: 'sess-1' });
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			onDataHandler?.('sess-1', 'ls output');

			expect(deps.batchedUpdater.appendLog).toHaveBeenCalledWith(
				'sess-1',
				null,
				false,
				'ls output'
			);
		});

		it('returns early for -terminal suffixed sessions', () => {
			const deps = createMockDeps();
			renderHook(() => useAgentListeners(deps));

			onDataHandler?.('sess-1-terminal', 'data');

			expect(deps.batchedUpdater.appendLog).not.toHaveBeenCalled();
		});

		it('tracks cycle bytes for AI data', () => {
			const deps = createMockDeps();
			const session = createMockSession({
				id: 'sess-1',
				state: 'busy',
				aiTabs: [createMockTab({ id: 'tab-1' })],
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			onDataHandler?.('sess-1-ai-tab-1', 'Hello');

			expect(deps.batchedUpdater.updateCycleBytes).toHaveBeenCalledWith(
				'sess-1',
				expect.any(Number)
			);
		});

		it('removes a recovered agent error log when successful data resumes', () => {
			const deps = createMockDeps();
			const recoveredError: AgentError = {
				type: 'permission_denied',
				message: 'Permission denied. Check file and directory permissions.',
				recoverable: false,
				agentId: 'copilot-cli',
				timestamp: 1700000000000,
			};
			const session = createMockSession({
				id: 'sess-1',
				state: 'error',
				toolType: 'copilot-cli',
				agentError: recoveredError,
				agentErrorTabId: 'tab-1',
				agentErrorPaused: true,
				aiTabs: [
					createMockTab({
						id: 'tab-1',
						agentError: recoveredError,
						logs: [
							{
								id: 'log-error',
								timestamp: recoveredError.timestamp,
								source: 'error',
								text: recoveredError.message,
								agentError: recoveredError,
							},
						],
					}),
				],
				activeTabId: 'tab-1',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			onDataHandler?.('sess-1-ai-tab-1', 'Final answer');

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			expect(updated?.agentError).toBeUndefined();
			expect(updated?.agentErrorTabId).toBeUndefined();
			expect(updated?.agentErrorPaused).toBe(false);
			expect(updated?.state).toBe('busy');
			expect(updated?.aiTabs[0]?.agentError).toBeUndefined();
			expect(updated?.aiTabs[0]?.logs).toEqual([]);
			expect(window.maestro.agentError.clearError).toHaveBeenCalledWith('sess-1');
		});
	});

	// ========================================================================
	// onStderr handler
	// ========================================================================

	describe('onStderr', () => {
		it('appends stderr data with isStderr flag', () => {
			const deps = createMockDeps();
			const session = createMockSession({
				id: 'sess-1',
				aiTabs: [createMockTab({ id: 'tab-1' })],
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			onStderrHandler?.('sess-1-ai-tab-1', 'error output');

			expect(deps.batchedUpdater.appendLog).toHaveBeenCalledWith(
				'sess-1',
				'tab-1',
				true,
				'error output',
				true
			);
		});

		it('skips empty stderr', () => {
			const deps = createMockDeps();
			renderHook(() => useAgentListeners(deps));

			onStderrHandler?.('sess-1-ai-tab-1', '');

			expect(deps.batchedUpdater.appendLog).not.toHaveBeenCalled();
		});
	});

	// ========================================================================
	// onCommandExit handler
	// ========================================================================

	describe('onCommandExit', () => {
		it('transitions session to idle when no AI tabs busy', () => {
			const deps = createMockDeps();
			const session = createMockSession({
				id: 'sess-1',
				state: 'busy',
				busySource: 'terminal',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			onCommandExitHandler?.('sess-1', 0);

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			expect(updated?.state).toBe('idle');
		});

		it('adds system log entry for non-zero exit code', () => {
			const deps = createMockDeps();
			const session = createMockSession({
				id: 'sess-1',
				state: 'busy',
				busySource: 'terminal',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			onCommandExitHandler?.('sess-1', 1);

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			// System log should be appended to shellLogs for non-zero exit
			const exitLog = updated?.shellLogs?.find(
				(log: any) => log.source === 'system' && log.text?.includes('exited with code 1')
			);
			expect(exitLog).toBeDefined();
			expect(exitLog?.source).toBe('system');
		});
	});

	// ========================================================================
	// onSlashCommands handler
	// ========================================================================

	describe('onSlashCommands', () => {
		it('updates session agentCommands with normalized commands', () => {
			const deps = createMockDeps();
			const session = createMockSession({ id: 'sess-1' });
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			// Commands sent from agent may or may not have `/` prefix
			onSlashCommandsHandler?.('sess-1-ai', ['help', '/status', 'clear']);

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			expect(updated?.agentCommands).toBeDefined();
			expect(updated!.agentCommands!.length).toBe(3);
			// All should have `/` prefix
			expect(updated!.agentCommands![0].command).toBe('/help');
			expect(updated!.agentCommands![1].command).toBe('/status');
			expect(updated!.agentCommands![2].command).toBe('/clear');
		});
	});

	// ========================================================================
	// onSessionId handler
	// ========================================================================

	describe('onSessionId', () => {
		it('sets agentSessionId on the target tab', () => {
			const deps = createMockDeps();
			const tab = createMockTab({
				id: 'tab-1',
				agentSessionId: null,
				awaitingSessionId: true,
			});
			const session = createMockSession({
				id: 'sess-1',
				aiTabs: [tab],
				activeTabId: 'tab-1',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			onSessionIdHandler?.('sess-1-ai-tab-1', 'agent-session-abc');

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			const updatedTab = updated?.aiTabs.find((t) => t.id === 'tab-1');
			expect(updatedTab?.agentSessionId).toBe('agent-session-abc');
		});

		it('registers session origin via IPC', () => {
			const deps = createMockDeps();
			const tab = createMockTab({
				id: 'tab-1',
				agentSessionId: null,
				awaitingSessionId: true,
			});
			const session = createMockSession({
				id: 'sess-1',
				aiTabs: [tab],
				activeTabId: 'tab-1',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			onSessionIdHandler?.('sess-1-ai-tab-1', 'agent-session-abc');

			expect(window.maestro.agentSessions.registerSessionOrigin).toHaveBeenCalledWith(
				'/test/project',
				'agent-session-abc',
				'user'
			);
		});

		it('returns early for batch sessions', () => {
			const deps = createMockDeps();
			renderHook(() => useAgentListeners(deps));

			onSessionIdHandler?.('sess-1-batch-0-ai', 'agent-session-abc');

			expect(window.maestro.agentSessions.registerSessionOrigin).not.toHaveBeenCalled();
		});

		it('detects resume failure when agent returns a different session ID', () => {
			const deps = createMockDeps();
			const tab = createMockTab({
				id: 'tab-1',
				agentSessionId: 'old-session-id',
				awaitingSessionId: false,
				usageStats: {
					inputTokens: 100,
					outputTokens: 50,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
					totalCostUsd: 0.001,
					contextWindow: 200000,
				},
			});
			const session = createMockSession({
				id: 'sess-1',
				aiTabs: [tab],
				activeTabId: 'tab-1',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			// Agent returns a DIFFERENT session ID → resume failed
			onSessionIdHandler?.('sess-1-ai-tab-1', 'new-session-id');

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			const updatedTab = updated?.aiTabs.find((t) => t.id === 'tab-1');

			// Should accept the new session ID (not keep the stale one)
			expect(updatedTab?.agentSessionId).toBe('new-session-id');
			// Should clear usage stats
			expect(updatedTab?.usageStats).toBeUndefined();
			// Should add a system log entry about resume failure
			const resumeLog = updatedTab?.logs.find((l) => l.text.includes('Session resume failed'));
			expect(resumeLog).toBeDefined();
			// Should reset context usage
			expect(deps.batchedUpdater.updateContextUsage).toHaveBeenCalledWith('sess-1', 0);
		});

		it('does not warn on resume success (same session ID returned)', () => {
			const deps = createMockDeps();
			const tab = createMockTab({
				id: 'tab-1',
				agentSessionId: 'same-session-id',
				awaitingSessionId: false,
			});
			const session = createMockSession({
				id: 'sess-1',
				aiTabs: [tab],
				activeTabId: 'tab-1',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			// Agent returns the SAME session ID → resume succeeded
			onSessionIdHandler?.('sess-1-ai-tab-1', 'same-session-id');

			// Should NOT reset context usage
			expect(deps.batchedUpdater.updateContextUsage).not.toHaveBeenCalled();
			// Session ID should remain unchanged
			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			const updatedTab = updated?.aiTabs.find((t) => t.id === 'tab-1');
			expect(updatedTab?.agentSessionId).toBe('same-session-id');
			// Should NOT add a resume-failure log entry
			const hasResumeFailureLog = !!updatedTab?.logs.some((l) =>
				l.text.includes('Session resume failed')
			);
			expect(hasResumeFailureLog).toBe(false);
		});

		it('preserves context gauge when resume succeeds', () => {
			const deps = createMockDeps();
			const tab = createMockTab({
				id: 'tab-1',
				agentSessionId: 'existing-session',
				awaitingSessionId: false,
			});
			const session = createMockSession({
				id: 'sess-1',
				aiTabs: [tab],
				activeTabId: 'tab-1',
				contextUsage: 48,
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			// Same session ID → resume succeeded
			onSessionIdHandler?.('sess-1-ai-tab-1', 'existing-session');

			// Context usage should NOT be reset
			expect(deps.batchedUpdater.updateContextUsage).not.toHaveBeenCalled();
			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			expect(updated?.contextUsage).toBe(48);
		});

		it('stores session ID at session level when tab was closed (not on another tab)', () => {
			const deps = createMockDeps();
			// Tab B exists but Tab A (from the process session ID) was closed
			const tabB = createMockTab({
				id: 'tab-b',
				agentSessionId: null,
				awaitingSessionId: false,
			});
			const session = createMockSession({
				id: 'sess-1',
				aiTabs: [tabB],
				activeTabId: 'tab-b',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			// Process reports back with tab-a's ID, but tab-a no longer exists
			onSessionIdHandler?.('sess-1-ai-tab-a', 'orphan-session-id');

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			// Session-level agentSessionId should be set
			expect(updated?.agentSessionId).toBe('orphan-session-id');
			// Tab B should NOT have been assigned the orphaned session ID
			const updatedTabB = updated?.aiTabs.find((t) => t.id === 'tab-b');
			expect(updatedTabB?.agentSessionId).toBeNull();
		});

		it('does not cross-bind when closed tab had awaitingSessionId and another tab also awaits', () => {
			const deps = createMockDeps();
			// Tab B is awaiting its own session ID — must not receive Tab A's
			const tabB = createMockTab({
				id: 'tab-b',
				agentSessionId: null,
				awaitingSessionId: true,
			});
			const session = createMockSession({
				id: 'sess-1',
				aiTabs: [tabB],
				activeTabId: 'tab-b',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			// Tab A was closed, its process reports back with explicit tab ID
			onSessionIdHandler?.('sess-1-ai-tab-a', 'tab-a-session');

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			// Tab B must keep awaiting ITS OWN session ID
			const updatedTabB = updated?.aiTabs.find((t) => t.id === 'tab-b');
			expect(updatedTabB?.agentSessionId).toBeNull();
			expect(updatedTabB?.awaitingSessionId).toBe(true);
			// Session level gets the orphaned ID
			expect(updated?.agentSessionId).toBe('tab-a-session');
		});

		it('still binds correctly to existing tab when tab ID matches', () => {
			const deps = createMockDeps();
			// Tab A exists and is awaiting — should receive its session ID normally
			const tabA = createMockTab({
				id: 'tab-a',
				agentSessionId: null,
				awaitingSessionId: true,
			});
			const tabB = createMockTab({
				id: 'tab-b',
				agentSessionId: null,
			});
			const session = createMockSession({
				id: 'sess-1',
				aiTabs: [tabA, tabB],
				activeTabId: 'tab-a',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			onSessionIdHandler?.('sess-1-ai-tab-a', 'correct-session');

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			const updatedTabA = updated?.aiTabs.find((t) => t.id === 'tab-a');
			expect(updatedTabA?.agentSessionId).toBe('correct-session');
			expect(updatedTabA?.awaitingSessionId).toBe(false);
			// Tab B untouched
			const updatedTabB = updated?.aiTabs.find((t) => t.id === 'tab-b');
			expect(updatedTabB?.agentSessionId).toBeNull();
		});

		it('handles forced-parallel session ID for closed tab without cross-binding', () => {
			const deps = createMockDeps();
			const tabB = createMockTab({
				id: 'tab-b',
				agentSessionId: null,
			});
			const session = createMockSession({
				id: 'sess-1',
				aiTabs: [tabB],
				activeTabId: 'tab-b',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			// Forced-parallel process from closed tab-a reports session ID
			// The -fp-{timestamp} suffix is stripped by REGEX_AI_TAB, leaving tabId = 'tab-a'
			onSessionIdHandler?.('sess-1-ai-tab-a-fp-1712611230000', 'fp-session');

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			// Tab B must NOT be contaminated
			const updatedTabB = updated?.aiTabs.find((t) => t.id === 'tab-b');
			expect(updatedTabB?.agentSessionId).toBeNull();
			// Session level gets the ID
			expect(updated?.agentSessionId).toBe('fp-session');
		});
	});

	// ========================================================================
	// onAgentError handler
	// ========================================================================

	describe('onAgentError', () => {
		const baseError: AgentError = {
			type: 'auth_expired',
			message: 'Authentication required',
			recoverable: true,
			agentId: 'claude-code',
			timestamp: 1700000000000,
		};

		it('sets error state on the session', () => {
			const deps = createMockDeps();
			const tab = createMockTab({ id: 'tab-1' });
			const session = createMockSession({
				id: 'sess-1',
				state: 'busy',
				aiTabs: [tab],
				activeTabId: 'tab-1',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			onAgentErrorHandler?.('sess-1-ai-tab-1', baseError);

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			expect(updated?.agentError).toEqual(baseError);
			expect(updated?.agentErrorTabId).toBe('tab-1');
			expect(updated?.state).toBe('error');
			expect(updated?.agentErrorPaused).toBe(true);
		});

		it('opens the agent error modal', () => {
			const deps = createMockDeps();
			const tab = createMockTab({ id: 'tab-1' });
			const session = createMockSession({
				id: 'sess-1',
				state: 'busy',
				aiTabs: [tab],
				activeTabId: 'tab-1',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			onAgentErrorHandler?.('sess-1-ai-tab-1', baseError);

			// Check that the agentError modal was opened
			const agentErrorOpen = useModalStore.getState().isOpen('agentError');
			expect(agentErrorOpen).toBe(true);
			const data = useModalStore.getState().getData('agentError');
			expect(data?.sessionId).toBe('sess-1');
		});

		it('does not open modal for session_not_found errors', () => {
			const deps = createMockDeps();
			const tab = createMockTab({ id: 'tab-1' });
			const session = createMockSession({
				id: 'sess-1',
				state: 'busy',
				aiTabs: [tab],
				activeTabId: 'tab-1',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			onAgentErrorHandler?.('sess-1-ai-tab-1', {
				...baseError,
				type: 'session_not_found',
			});

			const agentErrorOpen = useModalStore.getState().isOpen('agentError');
			expect(agentErrorOpen).toBe(false);
		});

		it('clears agentSessionId on session_not_found so next spawn starts fresh', () => {
			const deps = createMockDeps();
			const tab = createMockTab({ id: 'tab-1', agentSessionId: 'stale-session-id' });
			const session = createMockSession({
				id: 'sess-1',
				state: 'busy',
				aiTabs: [tab],
				activeTabId: 'tab-1',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			onAgentErrorHandler?.('sess-1-ai-tab-1', {
				...baseError,
				type: 'session_not_found',
			});

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			const updatedTab = updated?.aiTabs.find((t) => t.id === 'tab-1');
			expect(updatedTab?.agentSessionId).toBeNull();
		});

		it('appends error log entry to the target tab', () => {
			const deps = createMockDeps();
			const tab = createMockTab({ id: 'tab-1', logs: [] });
			const session = createMockSession({
				id: 'sess-1',
				state: 'busy',
				aiTabs: [tab],
				activeTabId: 'tab-1',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			onAgentErrorHandler?.('sess-1-ai-tab-1', baseError);

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			const updatedTab = updated?.aiTabs.find((t) => t.id === 'tab-1');
			const errorLog = updatedTab?.logs?.find(
				(l: any) => l.source === 'error' || l.text?.includes('Authentication')
			);
			expect(errorLog).toBeDefined();
		});

		it('pauses batch on error when batch is running', () => {
			const pauseBatchOnError = vi.fn();
			const deps = createMockDeps({
				getBatchStateRef: {
					current: () =>
						({
							isRunning: true,
							errorPaused: false,
							currentDocumentIndex: 2,
							documents: ['doc1.md', 'doc2.md', 'doc3.md'],
						}) as any,
				},
				pauseBatchOnErrorRef: { current: pauseBatchOnError },
			});
			const tab = createMockTab({ id: 'tab-1' });
			const session = createMockSession({
				id: 'sess-1',
				state: 'busy',
				aiTabs: [tab],
				activeTabId: 'tab-1',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			onAgentErrorHandler?.('sess-1-ai-tab-1', baseError);

			expect(pauseBatchOnError).toHaveBeenCalledWith('sess-1', baseError, 2, 'Processing doc3.md');
		});

		it('delegates group chat errors to groupChatStore', () => {
			useGroupChatStore.setState({ groupChatError: null });

			const deps = createMockDeps();
			const session = createMockSession({
				id: 'sess-1',
				state: 'busy',
				aiTabs: [createMockTab({ id: 'tab-1' })],
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			// Group chat session format: group-chat-{uuid}-{participantName}-{timestamp}
			const groupChatSessionId =
				'group-chat-12345678-1234-1234-1234-123456789012-claude-1700000000000';
			onAgentErrorHandler?.(groupChatSessionId, baseError);

			// Should set error in groupChatStore directly
			expect(useGroupChatStore.getState().groupChatError).not.toBeNull();
		});
	});

	// ========================================================================
	// onUsage handler
	// ========================================================================

	describe('onUsage', () => {
		it('updates usage stats via batchedUpdater', () => {
			const deps = createMockDeps();
			const tab = createMockTab({ id: 'tab-1' });
			const session = createMockSession({
				id: 'sess-1',
				aiTabs: [tab],
				activeTabId: 'tab-1',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			const usage = {
				inputTokens: 100,
				outputTokens: 50,
				cacheReadInputTokens: 10,
				cacheCreationInputTokens: 5,
				totalCostUsd: 0.001,
				contextWindow: 200000,
			};

			onUsageHandler?.('sess-1-ai-tab-1', usage);

			expect(deps.batchedUpdater.updateUsage).toHaveBeenCalledWith('sess-1', 'tab-1', usage);
		});

		it('updates cycle tokens for output tokens', () => {
			const deps = createMockDeps();
			const tab = createMockTab({ id: 'tab-1' });
			const session = createMockSession({
				id: 'sess-1',
				aiTabs: [tab],
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			onUsageHandler?.('sess-1-ai-tab-1', {
				inputTokens: 100,
				outputTokens: 50,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
				totalCostUsd: 0.001,
				contextWindow: 200000,
			});

			expect(deps.batchedUpdater.updateCycleTokens).toHaveBeenCalledWith('sess-1', 50);
		});
	});

	// ========================================================================
	// onThinkingChunk handler
	// ========================================================================

	describe('onThinkingChunk', () => {
		it('removes hidden progress once visible output arrives', () => {
			const deps = createMockDeps();
			const session = createMockSession({
				id: 'sess-1',
				state: 'busy',
				aiTabs: [
					createMockTab({
						id: 'tab-1',
						showThinking: 'off',
						logs: [
							{
								id: 'hidden-progress:tab-1',
								timestamp: 1700000000000,
								source: 'system',
								text: 'Thinking through the next step...',
							},
						],
					}),
				],
				activeTabId: 'tab-1',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			onDataHandler?.('sess-1-ai-tab-1', 'Visible response');

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			expect(updated?.aiTabs[0]?.logs).toEqual([]);
		});
	});

	// ========================================================================
	// onToolExecution handler
	// ========================================================================

	describe('onToolExecution', () => {
		it('does not emit tool logs when thinking is hidden', () => {
			const deps = createMockDeps();
			const session = createMockSession({
				id: 'sess-1',
				aiTabs: [createMockTab({ id: 'tab-1', showThinking: 'off' })],
				activeTabId: 'tab-1',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			onToolExecutionHandler?.('sess-1-ai-tab-1', {
				toolName: 'view',
				state: { status: 'running', input: { path: 'src/renderer/App.tsx' } },
				timestamp: 1700000000000,
			});

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			expect(updated?.aiTabs[0]?.logs).toEqual([]);
		});

		// Copilot-CLI emits paired `tool.execution_start` and `tool.execution_complete`
		// events. Without correlation, each appended a separate LogEntry — the second
		// rendered as an empty bubble because the complete event omits `input`.
		// With toolCallId, both events collapse into a single bubble that gains
		// `output`/status while preserving `input`.
		it('merges running and completed events for the same toolCallId into a single log entry', () => {
			const deps = createMockDeps();
			const session = createMockSession({
				id: 'sess-1',
				aiTabs: [createMockTab({ id: 'tab-1', showThinking: 'on' })],
				activeTabId: 'tab-1',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			onToolExecutionHandler?.('sess-1-ai-tab-1', {
				toolName: 'bash',
				state: { status: 'running', input: { command: 'ls -la' } },
				timestamp: 1700000000000,
				toolCallId: 'call_abc',
			});

			onToolExecutionHandler?.('sess-1-ai-tab-1', {
				toolName: 'bash',
				state: { status: 'completed', output: 'total 0' },
				timestamp: 1700000000500,
				toolCallId: 'call_abc',
			});

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			const logs = updated?.aiTabs[0]?.logs ?? [];
			expect(logs).toHaveLength(1);
			expect(logs[0]).toMatchObject({
				id: 'tool-call_abc',
				source: 'tool',
				text: 'bash',
				metadata: {
					toolState: {
						status: 'completed',
						input: { command: 'ls -la' },
						output: 'total 0',
					},
				},
			});
		});

		// Codex (and other agents that do not emit a per-call correlation id)
		// rely on the toolName fallback: the completion event is merged into
		// the most recent still-running entry of the same tool.
		it('merges completion into the last running entry of the same toolName when no toolCallId is provided', () => {
			const deps = createMockDeps();
			const session = createMockSession({
				id: 'sess-1',
				aiTabs: [createMockTab({ id: 'tab-1', showThinking: 'on' })],
				activeTabId: 'tab-1',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			onToolExecutionHandler?.('sess-1-ai-tab-1', {
				toolName: 'bash',
				state: { status: 'running', input: { command: 'ls' } },
				timestamp: 1700000000000,
			});

			onToolExecutionHandler?.('sess-1-ai-tab-1', {
				toolName: 'bash',
				state: { status: 'completed', output: 'a b c' },
				timestamp: 1700000000500,
			});

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			const logs = updated?.aiTabs[0]?.logs ?? [];
			expect(logs).toHaveLength(1);
			expect(logs[0]?.metadata?.toolState).toEqual({
				status: 'completed',
				input: { command: 'ls' },
				output: 'a b c',
			});
		});

		it('only merges into running entries — does not retro-update an already-completed entry', () => {
			const deps = createMockDeps();
			const session = createMockSession({
				id: 'sess-1',
				aiTabs: [createMockTab({ id: 'tab-1', showThinking: 'on' })],
				activeTabId: 'tab-1',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			// First call completes cleanly via the fallback.
			onToolExecutionHandler?.('sess-1-ai-tab-1', {
				toolName: 'bash',
				state: { status: 'running', input: { command: 'ls' } },
				timestamp: 1700000000000,
			});
			onToolExecutionHandler?.('sess-1-ai-tab-1', {
				toolName: 'bash',
				state: { status: 'completed', output: '...' },
				timestamp: 1700000000500,
			});

			// A second isolated completion event with no running predecessor
			// should still produce its own (admittedly empty) bubble rather
			// than overwriting the prior, already-finalized one.
			onToolExecutionHandler?.('sess-1-ai-tab-1', {
				toolName: 'bash',
				state: { status: 'completed' },
				timestamp: 1700000000900,
			});

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			expect(updated?.aiTabs[0]?.logs).toHaveLength(2);
		});

		it('keeps two log entries for distinct toolCallIds', () => {
			const deps = createMockDeps();
			const session = createMockSession({
				id: 'sess-1',
				aiTabs: [createMockTab({ id: 'tab-1', showThinking: 'on' })],
				activeTabId: 'tab-1',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			onToolExecutionHandler?.('sess-1-ai-tab-1', {
				toolName: 'bash',
				state: { status: 'running', input: { command: 'pwd' } },
				timestamp: 1700000000000,
				toolCallId: 'call_a',
			});

			onToolExecutionHandler?.('sess-1-ai-tab-1', {
				toolName: 'bash',
				state: { status: 'running', input: { command: 'whoami' } },
				timestamp: 1700000000100,
				toolCallId: 'call_b',
			});

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			const logs = updated?.aiTabs[0]?.logs ?? [];
			expect(logs.map((l) => l.id)).toEqual(['tool-call_a', 'tool-call_b']);
		});
	});

	// ========================================================================
	// onSshRemote handler
	// ========================================================================

	describe('onSshRemote', () => {
		it('updates session SSH remote info', () => {
			const deps = createMockDeps();
			const session = createMockSession({ id: 'sess-1' });
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			onSshRemoteHandler?.('sess-1-ai', {
				id: 'remote-1',
				name: 'My Server',
				host: 'example.com',
			});

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			expect(updated?.sshRemote).toEqual({
				id: 'remote-1',
				name: 'My Server',
				host: 'example.com',
			});
			expect(updated?.sshRemoteId).toBe('remote-1');
		});
	});

	// ========================================================================
	// onExit handler (basic tests — full behavior is very complex)
	// ========================================================================

	describe('onExit', () => {
		it('transitions AI session from busy to idle on process exit and preserves agentSessionId for resume', async () => {
			const deps = createMockDeps();
			const tab = createMockTab({ id: 'tab-1', agentSessionId: 'old-session-id' });
			const session = createMockSession({
				id: 'sess-1',
				state: 'busy',
				busySource: 'ai',
				aiTabs: [tab],
				activeTabId: 'tab-1',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			// Simulate exit event — AI format
			await onExitHandler?.('sess-1-ai-tab-1');

			// Allow async operations to complete
			await new Promise((r) => setTimeout(r, 50));

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			expect(updated?.state).toBe('idle');
			// agentSessionId is preserved on normal exit so the next message can
			// resume the conversation. Stale IDs are cleared by onAgentError when
			// session_not_found is detected.
			const updatedTab = updated?.aiTabs.find((t) => t.id === 'tab-1');
			expect(updatedTab?.agentSessionId).toBe('old-session-id');
		});

		it('clears hidden progress logs on AI exit', async () => {
			const deps = createMockDeps();
			const tab = createMockTab({
				id: 'tab-1',
				showThinking: 'off',
				logs: [
					{
						id: 'hidden-progress:tab-1',
						timestamp: 1700000000000,
						source: 'system',
						text: 'Reading src/renderer/App.tsx',
					},
				],
			});
			const session = createMockSession({
				id: 'sess-1',
				state: 'busy',
				busySource: 'ai',
				aiTabs: [tab],
				activeTabId: 'tab-1',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			await onExitHandler?.('sess-1-ai-tab-1');
			await new Promise((r) => setTimeout(r, 50));

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			expect(updated?.aiTabs[0]?.logs).toEqual([]);
		});

		// ThinkingMode contract — exit-time clearing.
		// `'on'` is temporary: thinking/tool entries are scratch state for the
		// active turn and must disappear when the agent process exits.
		// `'sticky'` is pinned and opts out so users can review reasoning.
		// See `ThinkingMode` in src/shared/types.ts and the matching inline
		// clearing point in src/renderer/hooks/session/useBatchedSessionUpdates.ts.
		it("clears thinking and tool logs on AI exit when showThinking is 'on'", async () => {
			const deps = createMockDeps();
			const tab = createMockTab({
				id: 'tab-1',
				showThinking: 'on',
				logs: [
					{
						id: 'log-thinking-1',
						timestamp: 1700000000001,
						source: 'thinking',
						text: 'reasoning about the request...',
					},
					{
						id: 'log-tool-1',
						timestamp: 1700000000002,
						source: 'tool',
						text: 'bash: ls -la',
					},
					{
						id: 'log-stdout-1',
						timestamp: 1700000000003,
						source: 'stdout',
						text: 'final answer',
					},
				],
			});
			const session = createMockSession({
				id: 'sess-1',
				state: 'busy',
				busySource: 'ai',
				aiTabs: [tab],
				activeTabId: 'tab-1',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			await onExitHandler?.('sess-1-ai-tab-1');
			await new Promise((r) => setTimeout(r, 50));

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			const remaining = updated?.aiTabs[0]?.logs ?? [];
			expect(remaining.map((l) => l.source)).toEqual(['stdout']);
			expect(updated?.aiTabs[0]?.state).toBe('idle');
			expect(updated?.aiTabs[0]?.thinkingStartTime).toBeUndefined();
		});

		it("preserves thinking and tool logs on AI exit when showThinking is 'sticky'", async () => {
			const deps = createMockDeps();
			const tab = createMockTab({
				id: 'tab-1',
				showThinking: 'sticky',
				logs: [
					{
						id: 'log-thinking-1',
						timestamp: 1700000000001,
						source: 'thinking',
						text: 'reasoning about the request...',
					},
					{
						id: 'log-tool-1',
						timestamp: 1700000000002,
						source: 'tool',
						text: 'bash: ls -la',
					},
					{
						id: 'log-stdout-1',
						timestamp: 1700000000003,
						source: 'stdout',
						text: 'final answer',
					},
				],
			});
			const session = createMockSession({
				id: 'sess-1',
				state: 'busy',
				busySource: 'ai',
				aiTabs: [tab],
				activeTabId: 'tab-1',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			await onExitHandler?.('sess-1-ai-tab-1');
			await new Promise((r) => setTimeout(r, 50));

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			const remaining = updated?.aiTabs[0]?.logs ?? [];
			expect(remaining.map((l) => l.source)).toEqual(['thinking', 'tool', 'stdout']);
			expect(updated?.aiTabs[0]?.state).toBe('idle');
		});

		it("clears thinking/tool logs on AI exit in error path when showThinking is 'on'", async () => {
			const deps = createMockDeps();
			const tab = createMockTab({
				id: 'tab-1',
				showThinking: 'on',
				logs: [
					{
						id: 'log-thinking-1',
						timestamp: 1700000000001,
						source: 'thinking',
						text: 'reasoning...',
					},
					{
						id: 'log-tool-1',
						timestamp: 1700000000002,
						source: 'tool',
						text: 'tool call',
					},
				],
			});
			const agentError: AgentError = {
				type: 'rate_limited',
				message: 'rate limited',
				timestamp: 1700000000004,
				recoverable: true,
				agentId: 'claude-code',
			};
			const session = createMockSession({
				id: 'sess-1',
				state: 'error',
				agentError,
				busySource: 'ai',
				aiTabs: [tab],
				activeTabId: 'tab-1',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			await onExitHandler?.('sess-1-ai-tab-1');
			await new Promise((r) => setTimeout(r, 50));

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			expect(updated?.aiTabs[0]?.logs ?? []).toEqual([]);
		});

		it("clears thinking/tool logs on the just-exited tab in queue-waiting branch when showThinking is 'on'", async () => {
			const processQueuedItem = vi.fn().mockResolvedValue(undefined);
			const deps = createMockDeps({
				processQueuedItemRef: { current: processQueuedItem },
			});
			const tabA = createMockTab({
				id: 'tab-a',
				state: 'busy',
				agentSessionId: 'sess-a',
				showThinking: 'on',
				logs: [
					{
						id: 'log-thinking-a',
						timestamp: 1700000000001,
						source: 'thinking',
						text: 'reasoning A',
					},
					{
						id: 'log-tool-a',
						timestamp: 1700000000002,
						source: 'tool',
						text: 'tool A',
					},
				],
			});
			const tabB = createMockTab({ id: 'tab-b', state: 'busy', agentSessionId: 'sess-b' });
			const queueItem = {
				id: 'q1',
				tabId: 'tab-c',
				type: 'message' as const,
				text: 'queued write',
				timestamp: Date.now(),
			};
			const session = createMockSession({
				id: 'sess-1',
				state: 'busy',
				busySource: 'ai',
				aiTabs: [tabA, tabB],
				activeTabId: 'tab-a',
				executionQueue: [queueItem],
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			await onExitHandler?.('sess-1-ai-tab-a');
			await new Promise((r) => setTimeout(r, 50));

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			const updatedTabA = updated?.aiTabs.find((t) => t.id === 'tab-a');
			// Tab A exited and was marked idle; thinking/tool logs are gone.
			expect(updatedTabA?.state).toBe('idle');
			expect(updatedTabA?.logs ?? []).toEqual([]);
			// Queue is NOT drained because tab-b is still busy.
			expect(processQueuedItem).not.toHaveBeenCalled();
		});

		it('processes execution queue on exit', async () => {
			const processQueuedItem = vi.fn().mockResolvedValue(undefined);
			const deps = createMockDeps({
				processQueuedItemRef: { current: processQueuedItem },
			});
			const tab = createMockTab({ id: 'tab-1' });
			const queueItem = {
				prompt: 'do something',
				timestamp: Date.now(),
			};
			const session = createMockSession({
				id: 'sess-1',
				state: 'busy',
				busySource: 'ai',
				aiTabs: [tab],
				activeTabId: 'tab-1',
				executionQueue: [queueItem],
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			await onExitHandler?.('sess-1-ai-tab-1');

			// Allow async operations to complete
			await new Promise((r) => setTimeout(r, 50));

			expect(processQueuedItem).toHaveBeenCalledWith('sess-1', queueItem);
		});

		it('does NOT dequeue write-mode item when another tab is still busy', async () => {
			const processQueuedItem = vi.fn().mockResolvedValue(undefined);
			const deps = createMockDeps({
				processQueuedItemRef: { current: processQueuedItem },
			});
			const tabA = createMockTab({ id: 'tab-a', state: 'busy', agentSessionId: 'sess-a' });
			const tabB = createMockTab({ id: 'tab-b', state: 'busy', agentSessionId: 'sess-b' });
			const queueItem = {
				id: 'q1',
				tabId: 'tab-c',
				type: 'message' as const,
				text: 'queued write',
				timestamp: Date.now(),
			};
			const session = createMockSession({
				id: 'sess-1',
				state: 'busy',
				busySource: 'ai',
				aiTabs: [tabA, tabB],
				activeTabId: 'tab-a',
				executionQueue: [queueItem],
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			// Tab A exits, but Tab B is still busy — queued write must NOT run
			await onExitHandler?.('sess-1-ai-tab-a');
			await new Promise((r) => setTimeout(r, 50));

			expect(processQueuedItem).not.toHaveBeenCalled();
			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			// Session stays busy because tab-b is still running
			expect(updated?.state).toBe('busy');
			// Queue is NOT drained
			expect(updated?.executionQueue).toHaveLength(1);
			// Tab A was marked idle
			const updatedTabA = updated?.aiTabs.find((t) => t.id === 'tab-a');
			expect(updatedTabA?.state).toBe('idle');
			// Tab B still busy
			const updatedTabB = updated?.aiTabs.find((t) => t.id === 'tab-b');
			expect(updatedTabB?.state).toBe('busy');
		});

		it('dequeues forceParallel item even when another tab is busy', async () => {
			const processQueuedItem = vi.fn().mockResolvedValue(undefined);
			const deps = createMockDeps({
				processQueuedItemRef: { current: processQueuedItem },
			});
			const tabA = createMockTab({ id: 'tab-a', state: 'busy', agentSessionId: 'sess-a' });
			const tabB = createMockTab({ id: 'tab-b', state: 'busy', agentSessionId: 'sess-b' });
			const queueItem = {
				id: 'q1',
				tabId: 'tab-c',
				type: 'message' as const,
				text: 'forced parallel',
				timestamp: Date.now(),
				forceParallel: true,
			};
			const session = createMockSession({
				id: 'sess-1',
				state: 'busy',
				busySource: 'ai',
				aiTabs: [tabA, tabB],
				activeTabId: 'tab-a',
				executionQueue: [queueItem],
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			await onExitHandler?.('sess-1-ai-tab-a');
			await new Promise((r) => setTimeout(r, 50));

			expect(processQueuedItem).toHaveBeenCalledWith('sess-1', queueItem);
		});

		it('dequeues readOnly item even when another tab is busy', async () => {
			const processQueuedItem = vi.fn().mockResolvedValue(undefined);
			const deps = createMockDeps({
				processQueuedItemRef: { current: processQueuedItem },
			});
			const tabA = createMockTab({ id: 'tab-a', state: 'busy', agentSessionId: 'sess-a' });
			const tabB = createMockTab({ id: 'tab-b', state: 'busy', agentSessionId: 'sess-b' });
			const queueItem = {
				id: 'q1',
				tabId: 'tab-c',
				type: 'message' as const,
				text: 'read only query',
				timestamp: Date.now(),
				readOnlyMode: true,
			};
			const session = createMockSession({
				id: 'sess-1',
				state: 'busy',
				busySource: 'ai',
				aiTabs: [tabA, tabB],
				activeTabId: 'tab-a',
				executionQueue: [queueItem],
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			await onExitHandler?.('sess-1-ai-tab-a');
			await new Promise((r) => setTimeout(r, 50));

			expect(processQueuedItem).toHaveBeenCalledWith('sess-1', queueItem);
		});

		it('dequeues write-mode item once ALL other tabs finish', async () => {
			const processQueuedItem = vi.fn().mockResolvedValue(undefined);
			const deps = createMockDeps({
				processQueuedItemRef: { current: processQueuedItem },
			});
			const tabA = createMockTab({ id: 'tab-a', state: 'busy', agentSessionId: 'sess-a' });
			const tabB = createMockTab({ id: 'tab-b', state: 'busy', agentSessionId: 'sess-b' });
			const queueItem = {
				id: 'q1',
				tabId: 'tab-c',
				type: 'message' as const,
				text: 'queued write',
				timestamp: Date.now(),
			};
			const session = createMockSession({
				id: 'sess-1',
				state: 'busy',
				busySource: 'ai',
				aiTabs: [tabA, tabB],
				activeTabId: 'tab-a',
				executionQueue: [queueItem],
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			// Tab A exits — tab B still busy, so queue stays
			await onExitHandler?.('sess-1-ai-tab-a');
			await new Promise((r) => setTimeout(r, 50));
			expect(processQueuedItem).not.toHaveBeenCalled();

			// Now tab B also exits — no more busy tabs, queue should drain
			// Update store to reflect tab-a is now idle (from the first exit)
			const midState = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			expect(midState?.aiTabs.find((t) => t.id === 'tab-a')?.state).toBe('idle');

			await onExitHandler?.('sess-1-ai-tab-b');
			await new Promise((r) => setTimeout(r, 50));

			expect(processQueuedItem).toHaveBeenCalledWith('sess-1', queueItem);
		});

		it('handles terminal exit with non-zero exit code', async () => {
			const deps = createMockDeps();
			const session = createMockSession({
				id: 'sess-1',
				state: 'busy',
				busySource: 'terminal',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			// Terminal exit format — just sessionId (no -ai suffix)
			await onExitHandler?.('sess-1');

			await new Promise((r) => setTimeout(r, 50));

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			expect(updated?.state).toBe('idle');
		});

		it('transitions session to idle when exiting process tab was already closed', async () => {
			const deps = createMockDeps();
			// Tab B is the only remaining tab — Tab A was closed while its process ran
			const tabB = createMockTab({ id: 'tab-b', state: 'idle', agentSessionId: null });
			const session = createMockSession({
				id: 'sess-1',
				state: 'idle', // Already set to idle by closeTab cleanup
				busySource: undefined,
				aiTabs: [tabB],
				activeTabId: 'tab-b',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			// Tab A's process exits — tab-a no longer in aiTabs
			await onExitHandler?.('sess-1-ai-tab-a');
			await new Promise((r) => setTimeout(r, 50));

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			// Session stays idle (was already idle from closeTab fix)
			expect(updated?.state).toBe('idle');
			// Tab B must remain untouched
			const updatedTabB = updated?.aiTabs.find((t) => t.id === 'tab-b');
			expect(updatedTabB?.state).toBe('idle');
			expect(updatedTabB?.agentSessionId).toBeNull();
		});

		it('keeps other busy tabs running when closed tab process exits', async () => {
			const deps = createMockDeps();
			// Tab B is actively working on its own task
			const tabB = createMockTab({ id: 'tab-b', state: 'busy', agentSessionId: 'tab-b-session' });
			const session = createMockSession({
				id: 'sess-1',
				state: 'busy',
				busySource: 'ai',
				aiTabs: [tabB],
				activeTabId: 'tab-b',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			// Tab A's orphaned process exits — should not affect Tab B
			await onExitHandler?.('sess-1-ai-tab-a');
			await new Promise((r) => setTimeout(r, 50));

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			// Session stays busy because Tab B is still working
			expect(updated?.state).toBe('busy');
			const updatedTabB = updated?.aiTabs.find((t) => t.id === 'tab-b');
			expect(updatedTabB?.state).toBe('busy');
			expect(updatedTabB?.agentSessionId).toBe('tab-b-session');
		});
	});

	// ========================================================================
	// Regression: no TTS / audioFeedback code (removed in ff58abe14)
	// ========================================================================

	describe('regression: no TTS speak code in onExit', () => {
		it('does not reference useSettingsStore in the module source', async () => {
			const fs = await import('fs');
			const path = await import('path');
			const sourceFile = path.resolve(
				__dirname,
				'../../../renderer/hooks/agent/useAgentListeners.ts'
			);
			const source = fs.readFileSync(sourceFile, 'utf-8');
			expect(source).not.toContain('useSettingsStore');
			expect(source).not.toContain('audioFeedback');
			expect(source).not.toContain('notification.speak');
		});

		it('does not call window.maestro.notification.speak on process exit', async () => {
			const speakMock = vi.fn().mockResolvedValue(undefined);
			(window as any).maestro.notification = {
				...((window as any).maestro.notification || {}),
				speak: speakMock,
			};

			const deps = createMockDeps();
			const tab = createMockTab({ id: 'tab-1' });
			const session = createMockSession({
				id: 'sess-1',
				state: 'busy',
				busySource: 'ai',
				aiTabs: [tab],
				activeTabId: 'tab-1',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			await onExitHandler?.('sess-1-ai-tab-1');
			await new Promise((r) => setTimeout(r, 100));

			expect(speakMock).not.toHaveBeenCalled();
		});
	});
});
