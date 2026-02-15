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

// ============================================================================
// Helpers
// ============================================================================

function createMockTab(overrides: Partial<AITab> = {}): AITab {
	return {
		id: 'tab-1',
		agentSessionId: null,
		name: null,
		starred: false,
		logs: [],
		inputValue: '',
		stagedImages: [],
		createdAt: 1700000000000,
		state: 'idle' as const,
		saveToHistory: true,
		...overrides,
	};
}

function createMockSession(overrides: Partial<Session> = {}): Session {
	const baseTab = createMockTab();
	return {
		id: 'session-1',
		name: 'Test Session',
		toolType: 'claude-code',
		state: 'idle',
		cwd: '/test/project',
		fullPath: '/test/project',
		projectRoot: '/test/project',
		aiLogs: [],
		shellLogs: [],
		workLog: [],
		contextUsage: 0,
		inputMode: 'ai',
		aiPid: 0,
		terminalPid: 0,
		port: 0,
		isLive: false,
		changedFiles: [],
		isGitRepo: true,
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		aiTabs: overrides.aiTabs ?? [baseTab],
		activeTabId: overrides.activeTabId ?? baseTab.id,
		closedTabHistory: [],
		executionQueue: [],
		activeTimeMs: 0,
		filePreviewTabs: [],
		activeFileTabId: null,
		unifiedTabOrder: [{ type: 'ai' as const, id: baseTab.id }],
		unifiedClosedTabHistory: [],
		...overrides,
	} as Session;
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
		updateGlobalStatsRef: { current: null },
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
		it('transitions AI session from busy to idle on process exit', async () => {
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

			// Simulate exit event — AI format
			await onExitHandler?.('sess-1-ai-tab-1');

			// Allow async operations to complete
			await new Promise((r) => setTimeout(r, 50));

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			expect(updated?.state).toBe('idle');
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
	});
});
