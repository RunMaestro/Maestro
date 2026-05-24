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
import { useNotificationStore } from '../../../renderer/stores/notificationStore';
import { gitService } from '../../../renderer/services/git';
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
		rightPanelRef: { current: null },
		processQueuedItemRef: { current: null },
		contextWarningYellowThreshold: 80,
		...overrides,
	};
}

function installMockAnimationFrame() {
	vi.useFakeTimers();
	const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
	const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;

	globalThis.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
		return setTimeout(() => callback(0), 0) as unknown as number;
	});
	globalThis.cancelAnimationFrame = vi.fn((id: number) => {
		clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
	});

	return () => {
		if (originalRequestAnimationFrame) {
			globalThis.requestAnimationFrame = originalRequestAnimationFrame;
		} else {
			delete (globalThis as Partial<typeof globalThis>).requestAnimationFrame;
		}
		if (originalCancelAnimationFrame) {
			globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
		} else {
			delete (globalThis as Partial<typeof globalThis>).cancelAnimationFrame;
		}
		vi.useRealTimers();
	};
}

function flushAsyncWork() {
	return new Promise((resolve) => setTimeout(resolve, 0));
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
	useNotificationStore.getState().clearToasts();

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

		it('routes legacy AI data without an explicit tab id to the write-mode tab', () => {
			const deps = createMockDeps();
			const session = createMockSession({
				id: 'sess-1',
				state: 'busy',
				aiTabs: [
					createMockTab({ id: 'tab-1', state: 'idle' }),
					createMockTab({ id: 'tab-2', state: 'busy' }),
				],
				activeTabId: 'tab-1',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			onDataHandler?.('sess-1-ai', 'Legacy output');

			expect(deps.batchedUpdater.appendLog).toHaveBeenCalledWith(
				'sess-1',
				'tab-2',
				true,
				'Legacy output'
			);
			expect(deps.batchedUpdater.markDelivered).toHaveBeenCalledWith('sess-1', 'tab-2');
		});

		it('logs and ignores legacy AI data when no target tab can be found', () => {
			const deps = createMockDeps();
			const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
			const session = createMockSession({
				id: 'sess-1',
				aiTabs: [],
				activeTabId: 'missing-tab',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			onDataHandler?.('sess-1-ai', 'orphaned output');

			expect(consoleErrorSpy).toHaveBeenCalledWith(
				'[onData] No target tab found - session has no aiTabs, this should not happen'
			);
			expect(deps.batchedUpdater.appendLog).not.toHaveBeenCalled();
		});

		it('logs and ignores legacy AI data when the session is missing', () => {
			const deps = createMockDeps();
			const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
			useSessionStore.setState({
				sessions: [],
				activeSessionId: '',
			});

			renderHook(() => useAgentListeners(deps));

			onDataHandler?.('missing-ai', 'orphaned output');

			expect(consoleErrorSpy).toHaveBeenCalledWith(
				'[onData] No target tab found - session has no aiTabs, this should not happen'
			);
			expect(deps.batchedUpdater.appendLog).not.toHaveBeenCalled();
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

		it('returns early for batch process output', () => {
			const deps = createMockDeps();
			renderHook(() => useAgentListeners(deps));

			onDataHandler?.('sess-1-batch-123', 'batch output');

			expect(deps.batchedUpdater.appendLog).not.toHaveBeenCalled();
			expect(deps.batchedUpdater.markDelivered).not.toHaveBeenCalled();
		});

		it('appends explicit AI tab data when the session is missing but skips unread lookup', () => {
			const deps = createMockDeps();
			useSessionStore.setState({
				sessions: [],
				activeSessionId: '',
			});

			renderHook(() => useAgentListeners(deps));

			onDataHandler?.('sess-1-ai-tab-1', 'late output');

			expect(deps.batchedUpdater.appendLog).toHaveBeenCalledWith(
				'sess-1',
				'tab-1',
				true,
				'late output'
			);
			expect(deps.batchedUpdater.markDelivered).toHaveBeenCalledWith('sess-1', 'tab-1');
			expect(deps.batchedUpdater.markUnread).not.toHaveBeenCalled();
		});

		it('appends explicit AI tab data when the target tab is missing but skips unread marking', () => {
			const deps = createMockDeps();
			const session = createMockSession({
				id: 'sess-1',
				aiTabs: [createMockTab({ id: 'tab-2' })],
				activeTabId: 'tab-2',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			onDataHandler?.('sess-1-ai-tab-1', 'late output');

			expect(deps.batchedUpdater.appendLog).toHaveBeenCalledWith(
				'sess-1',
				'tab-1',
				true,
				'late output'
			);
			expect(deps.batchedUpdater.markDelivered).toHaveBeenCalledWith('sess-1', 'tab-1');
			expect(deps.batchedUpdater.markUnread).not.toHaveBeenCalled();
		});

		it('clears paused agent error state and marks inactive output as unread on successful AI data', () => {
			const deps = createMockDeps();
			const otherSession = createMockSession({ id: 'other-session' });
			const agentError: AgentError = {
				type: 'auth_expired',
				message: 'Authentication required',
				recoverable: true,
				agentId: 'claude-code',
				sessionId: 'agent-session-1',
				timestamp: Date.now(),
			};
			const session = createMockSession({
				id: 'sess-1',
				state: 'error',
				agentError,
				agentErrorTabId: 'tab-1',
				agentErrorPaused: true,
				aiTabs: [
					createMockTab({
						id: 'tab-1',
						agentError,
						isAtBottom: false,
					}),
					createMockTab({
						id: 'tab-2',
						agentError,
					}),
				],
				activeTabId: 'tab-1',
			});
			useSessionStore.setState({
				sessions: [otherSession, session],
				activeSessionId: 'other-session',
			});

			renderHook(() => useAgentListeners(deps));

			onDataHandler?.('sess-1-ai-tab-1', 'Recovered output');

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			expect(updated?.agentError).toBeUndefined();
			expect(updated?.agentErrorTabId).toBeUndefined();
			expect(updated?.agentErrorPaused).toBe(false);
			expect(updated?.state).toBe('busy');
			expect(updated?.aiTabs[0].agentError).toBeUndefined();
			expect(updated?.aiTabs[1].agentError).toBe(agentError);
			expect(window.maestro.agentError.clearError).toHaveBeenCalledWith('sess-1');
			expect(deps.batchedUpdater.markUnread).toHaveBeenCalledWith('sess-1', 'tab-1', true);
			expect(useSessionStore.getState().sessions.find((s) => s.id === 'other-session')).toBe(
				otherSession
			);
		});

		it('logs clear-error failures after successful AI data resumes a paused session', async () => {
			const deps = createMockDeps();
			const clearError = new Error('clear failed');
			vi.mocked(window.maestro.agentError.clearError).mockRejectedValueOnce(clearError);
			const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
			const agentError: AgentError = {
				type: 'network_error',
				message: 'Network failed',
				recoverable: true,
				agentId: 'claude-code',
				sessionId: 'agent-session-1',
				timestamp: Date.now(),
			};
			const session = createMockSession({
				id: 'sess-1',
				state: 'error',
				agentError,
				agentErrorTabId: 'tab-1',
				agentErrorPaused: true,
				aiTabs: [createMockTab({ id: 'tab-1', agentError })],
				activeTabId: 'tab-1',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			onDataHandler?.('sess-1-ai-tab-1', 'Recovered output');
			await flushAsyncWork();

			expect(consoleErrorSpy).toHaveBeenCalledWith(
				'Failed to clear agent error on successful data:',
				clearError
			);
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

		it('skips batch stderr and appends non-AI stderr to shell logs', () => {
			const deps = createMockDeps();
			renderHook(() => useAgentListeners(deps));

			onStderrHandler?.('sess-1-batch-123', 'ignored batch stderr');
			onStderrHandler?.('sess-1', 'terminal stderr');

			expect(deps.batchedUpdater.appendLog).toHaveBeenCalledTimes(1);
			expect(deps.batchedUpdater.appendLog).toHaveBeenCalledWith(
				'sess-1',
				null,
				false,
				'terminal stderr',
				true
			);
		});
	});

	// ========================================================================
	// onCommandExit handler
	// ========================================================================

	describe('onCommandExit', () => {
		it('transitions session to idle when no AI tabs busy', () => {
			const deps = createMockDeps();
			const otherSession = createMockSession({ id: 'other-session', state: 'idle' });
			const session = createMockSession({
				id: 'sess-1',
				state: 'busy',
				busySource: 'terminal',
			});
			useSessionStore.setState({
				sessions: [otherSession, session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			onCommandExitHandler?.('sess-1', 0);

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			expect(updated?.state).toBe('idle');
			expect(useSessionStore.getState().sessions.find((s) => s.id === 'other-session')).toBe(
				otherSession
			);
		});

		it('keeps command sessions busy when an AI tab is still running', () => {
			const deps = createMockDeps();
			const session = createMockSession({
				id: 'sess-1',
				state: 'busy',
				busySource: 'terminal',
				aiTabs: [createMockTab({ id: 'tab-1', state: 'busy' })],
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			onCommandExitHandler?.('sess-1', 0);

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			expect(updated?.state).toBe('busy');
			expect(updated?.busySource).toBe('ai');
			expect(updated?.shellLogs).toEqual([]);
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
			const otherSession = createMockSession({ id: 'other-session' });
			const session = createMockSession({ id: 'sess-1' });
			useSessionStore.setState({
				sessions: [otherSession, session],
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
			expect(useSessionStore.getState().sessions.find((s) => s.id === 'other-session')).toBe(
				otherSession
			);
		});
	});

	// ========================================================================
	// onSessionId handler
	// ========================================================================

	describe('onSessionId', () => {
		it('sets agentSessionId on the target tab', () => {
			const deps = createMockDeps();
			const otherSession = createMockSession({ id: 'other-session' });
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
				sessions: [otherSession, session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			onSessionIdHandler?.('sess-1-ai-tab-1', 'agent-session-abc');

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			const updatedTab = updated?.aiTabs.find((t) => t.id === 'tab-1');
			expect(updatedTab?.agentSessionId).toBe('agent-session-abc');
			expect(useSessionStore.getState().sessions.find((s) => s.id === 'other-session')).toBe(
				otherSession
			);
		});

		it('preserves non-default tab names when capturing provider session IDs', () => {
			const deps = createMockDeps();
			const namedTab = createMockTab({
				id: 'tab-1',
				name: 'Review plan',
				agentSessionId: null,
				awaitingSessionId: true,
			});
			const session = createMockSession({
				id: 'sess-1',
				aiTabs: [namedTab],
				activeTabId: 'tab-1',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			onSessionIdHandler?.('sess-1-ai-tab-1', 'agent-session-abc');

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			expect(updated?.aiTabs[0]).toEqual(
				expect.objectContaining({
					agentSessionId: 'agent-session-abc',
					awaitingSessionId: false,
					name: 'Review plan',
				})
			);
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

			onSessionIdHandler?.('sess-1-batch-0', 'agent-session-abc');

			expect(window.maestro.agentSessions.registerSessionOrigin).not.toHaveBeenCalled();
		});

		it('logs register-session-origin failures', async () => {
			const deps = createMockDeps();
			const registerError = new Error('origin failed');
			vi.mocked(window.maestro.agentSessions.registerSessionOrigin).mockRejectedValueOnce(
				registerError
			);
			const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
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
			await flushAsyncWork();

			expect(consoleErrorSpy).toHaveBeenCalledWith(
				'[onSessionId] Failed to register session origin:',
				registerError
			);
		});

		it('uses an awaiting tab for legacy AI session IDs and clears default tab names', () => {
			const deps = createMockDeps();
			const activeTab = createMockTab({
				id: 'tab-1',
				name: 'Active Tab',
				awaitingSessionId: false,
			});
			const awaitingTab = createMockTab({
				id: 'tab-2',
				name: 'New Session',
				awaitingSessionId: true,
			});
			const session = createMockSession({
				id: 'sess-1',
				aiTabs: [activeTab, awaitingTab],
				activeTabId: 'tab-1',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			onSessionIdHandler?.('sess-1-ai', 'agent-session-legacy');

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			const updatedActiveTab = updated?.aiTabs.find((tab) => tab.id === 'tab-1');
			const updatedAwaitingTab = updated?.aiTabs.find((tab) => tab.id === 'tab-2');
			expect(updatedActiveTab?.agentSessionId).toBeNull();
			expect(updatedAwaitingTab?.agentSessionId).toBe('agent-session-legacy');
			expect(updatedAwaitingTab?.awaitingSessionId).toBe(false);
			expect(updatedAwaitingTab?.name).toBeNull();
			expect(updated?.agentSessionId).toBe('agent-session-legacy');
		});

		it('accepts a new provider session ID and records a resume failure when resume returns a different ID', () => {
			const deps = createMockDeps();
			const tab = createMockTab({
				id: 'tab-1',
				agentSessionId: 'existing-agent-session',
				name: 'Pinned Tab',
			});
			const session = createMockSession({
				id: 'sess-1',
				aiTabs: [tab],
				activeTabId: 'tab-1',
				agentSessionId: 'existing-agent-session',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			onSessionIdHandler?.('sess-1-ai-tab-1', 'new-agent-session');

			const updatedSession = useSessionStore.getState().sessions[0];
			expect(updatedSession).not.toBe(session);
			expect(updatedSession.agentSessionId).toBe('new-agent-session');
			expect(updatedSession.aiTabs[0]).toEqual(
				expect.objectContaining({
					agentSessionId: 'new-agent-session',
					awaitingSessionId: false,
					name: 'Pinned Tab',
				})
			);
			expect(updatedSession.aiTabs[0].logs.at(-1)).toEqual(
				expect.objectContaining({
					source: 'system',
					text: expect.stringContaining('Session resume failed'),
				})
			);
			expect(window.maestro.agentSessions.registerSessionOrigin).toHaveBeenCalledWith(
				'/test/project',
				'new-agent-session',
				'user'
			);
		});

		it('stores provider session ID at session level when no tab can be targeted', () => {
			const deps = createMockDeps();
			const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
			const session = createMockSession({
				id: 'sess-1',
				aiTabs: [],
				activeTabId: null,
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			onSessionIdHandler?.('sess-1-ai', 'session-level-id');

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			expect(updated?.agentSessionId).toBe('session-level-id');
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				'[onSessionId] No target tab found - session has no aiTabs, storing at session level only'
			);
		});

		it('does not register session origin when the owning session is missing', () => {
			const deps = createMockDeps();
			renderHook(() => useAgentListeners(deps));

			onSessionIdHandler?.('missing-session-ai-tab-1', 'agent-session-abc');

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
			const siblingTab = createMockTab({
				id: 'tab-2',
				agentSessionId: 'sibling-session-id',
				awaitingSessionId: false,
			});
			const session = createMockSession({
				id: 'sess-1',
				aiTabs: [tab, siblingTab],
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
			const updatedSiblingTab = updated?.aiTabs.find((t) => t.id === 'tab-2');

			// Should accept the new session ID (not keep the stale one)
			expect(updatedTab?.agentSessionId).toBe('new-session-id');
			expect(updatedSiblingTab?.agentSessionId).toBe('sibling-session-id');
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
			const otherSession = createMockSession({ id: 'other-session', state: 'idle' });
			const tab = createMockTab({ id: 'tab-1' });
			const session = createMockSession({
				id: 'sess-1',
				state: 'busy',
				aiTabs: [tab],
				activeTabId: 'tab-1',
			});
			useSessionStore.setState({
				sessions: [otherSession, session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			onAgentErrorHandler?.('sess-1-ai-tab-1', baseError);

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			expect(updated?.agentError).toEqual(baseError);
			expect(updated?.agentErrorTabId).toBe('tab-1');
			expect(updated?.state).toBe('error');
			expect(updated?.agentErrorPaused).toBe(true);
			expect(useSessionStore.getState().sessions.find((s) => s.id === 'other-session')).toBe(
				otherSession
			);
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

		it('records session_not_found as a system log without pausing the session', () => {
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

			onAgentErrorHandler?.('sess-1-ai-tab-1', {
				...baseError,
				type: 'session_not_found',
				message: 'Provider session disappeared',
			});

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			expect(updated?.state).toBe('busy');
			expect(updated?.agentError).toBeUndefined();
			expect(updated?.agentErrorPaused).toBeUndefined();
			expect(updated?.aiTabs[0].agentError).toBeUndefined();
			expect(updated?.aiTabs[0].logs).toEqual([
				expect.objectContaining({
					source: 'system',
					text: 'Provider session disappeared',
					agentError: undefined,
				}),
			]);
		});

		it('appends error log entry to the target tab', () => {
			const deps = createMockDeps();
			const tab = createMockTab({ id: 'tab-1', logs: [] });
			const untouchedTab = createMockTab({ id: 'tab-2', logs: [] });
			const session = createMockSession({
				id: 'sess-1',
				state: 'busy',
				aiTabs: [tab, untouchedTab],
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
			expect(updated?.aiTabs.find((t) => t.id === 'tab-2')).toBe(untouchedTab);
		});

		it('appends legacy AI errors to the active tab when no tab id is present', () => {
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

			onAgentErrorHandler?.('sess-1-ai', baseError);

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			expect(updated?.agentErrorTabId).toBe('tab-1');
			expect(updated?.aiTabs[0].logs).toEqual([
				expect.objectContaining({
					source: 'error',
					text: baseError.message,
				}),
			]);
		});

		it('stores session error state without a tab log when the explicit tab is missing', () => {
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

			onAgentErrorHandler?.('sess-1-ai-missing-tab', baseError);

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			expect(updated).toEqual(
				expect.objectContaining({
					state: 'error',
					agentError: expect.objectContaining({ message: baseError.message }),
					agentErrorTabId: undefined,
				})
			);
			expect(updated?.aiTabs[0].logs).toEqual([]);
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

		it('adds Auto Run error history when a running batch pauses on agent error', () => {
			const pauseBatchOnError = vi.fn();
			const addHistoryEntry = vi.fn();
			const deps = createMockDeps({
				getBatchStateRef: {
					current: () =>
						({
							isRunning: true,
							errorPaused: false,
							currentDocumentIndex: 0,
							documents: ['doc1.md'],
						}) as any,
				},
				pauseBatchOnErrorRef: { current: pauseBatchOnError },
				addHistoryEntryRef: { current: addHistoryEntry },
			});
			const tab = createMockTab({ id: 'tab-1' });
			const session = createMockSession({
				id: 'sess-1',
				state: 'busy',
				aiTabs: [tab],
				activeTabId: 'tab-1',
				cwd: '/repo/project',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			onAgentErrorHandler?.('sess-1-ai-tab-1', {
				...baseError,
				type: 'network_error',
				message: 'Network unavailable',
			});

			expect(addHistoryEntry).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'AUTO',
					summary: 'Auto Run error: Connection Error (doc1.md)',
					projectPath: '/repo/project',
					sessionId: 'sess-1',
					success: false,
					fullResponse: expect.stringContaining('- Check your internet connection and try again'),
				})
			);
		});

		it('pauses Auto Run without history when no history callback is registered', () => {
			const pauseBatchOnError = vi.fn();
			const deps = createMockDeps({
				getBatchStateRef: {
					current: () =>
						({
							isRunning: true,
							errorPaused: false,
							currentDocumentIndex: 0,
							documents: ['doc.md'],
						}) as any,
				},
				pauseBatchOnErrorRef: { current: pauseBatchOnError },
				addHistoryEntryRef: { current: null },
			});
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

			onAgentErrorHandler?.('sess-1-ai-tab-1', baseError);

			expect(pauseBatchOnError).toHaveBeenCalledWith(
				'sess-1',
				expect.objectContaining({ message: baseError.message }),
				0,
				'Processing doc.md'
			);
			expect(deps.addHistoryEntryRef.current).toBeNull();
		});

		it('adds Auto Run token exhaustion history without a current document', () => {
			const pauseBatchOnError = vi.fn();
			const addHistoryEntry = vi.fn();
			const deps = createMockDeps({
				getBatchStateRef: {
					current: () =>
						({
							isRunning: true,
							errorPaused: false,
							currentDocumentIndex: 0,
							documents: [],
						}) as any,
				},
				pauseBatchOnErrorRef: { current: pauseBatchOnError },
				addHistoryEntryRef: { current: addHistoryEntry },
			});
			const session = createMockSession({
				id: 'sess-1',
				state: 'busy',
				aiTabs: [createMockTab({ id: 'tab-1' })],
				activeTabId: 'tab-1',
				cwd: '/repo/project',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			onAgentErrorHandler?.('sess-1-ai-tab-1', {
				...baseError,
				type: 'token_exhaustion',
				message: 'Context exhausted',
			});

			expect(pauseBatchOnError).toHaveBeenCalledWith(
				'sess-1',
				expect.objectContaining({ type: 'token_exhaustion' }),
				0,
				undefined
			);
			expect(addHistoryEntry).toHaveBeenCalledWith(
				expect.objectContaining({
					summary: 'Auto Run error: Context Limit Reached',
					fullResponse: expect.stringContaining(
						'- Start a new session to reset the context window'
					),
				})
			);
			expect(addHistoryEntry).toHaveBeenCalledWith(
				expect.objectContaining({
					fullResponse: expect.not.stringContaining('- Document:'),
				})
			);
		});

		it.each([
			['auth_expired', '- Re-authenticate with the provider'],
			['rate_limited', '- Wait a few minutes before retrying'],
			['agent_crashed', '- Review the error message and take appropriate action'],
		] as const)('adds Auto Run remediation history for %s', (type, expectedAdvice) => {
			const addHistoryEntry = vi.fn();
			const deps = createMockDeps({
				getBatchStateRef: {
					current: () =>
						({
							isRunning: true,
							errorPaused: false,
							currentDocumentIndex: 0,
							documents: ['doc.md'],
						}) as any,
				},
				pauseBatchOnErrorRef: { current: vi.fn() },
				addHistoryEntryRef: { current: addHistoryEntry },
			});
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

			onAgentErrorHandler?.('sess-1-ai-tab-1', {
				...baseError,
				type,
				message: `${type} happened`,
			});

			expect(addHistoryEntry).toHaveBeenCalledWith(
				expect.objectContaining({
					fullResponse: expect.stringContaining(expectedAdvice),
				})
			);
		});

		it('does not pause an already error-paused batch again', () => {
			const pauseBatchOnError = vi.fn();
			const deps = createMockDeps({
				getBatchStateRef: {
					current: () =>
						({
							isRunning: true,
							errorPaused: true,
							currentDocumentIndex: 0,
							documents: ['doc1.md'],
						}) as any,
				},
				pauseBatchOnErrorRef: { current: pauseBatchOnError },
			});
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

			onAgentErrorHandler?.('sess-1-ai-tab-1', baseError);

			expect(pauseBatchOnError).not.toHaveBeenCalled();
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

		it('labels moderator group chat errors in stored state and messages', () => {
			useGroupChatStore.setState({
				groupChatError: null,
				groupChatMessages: [],
				groupChatState: 'working',
				groupChatStates: new Map([['12345678-1234-1234-1234-123456789012', 'working']]),
			});

			const deps = createMockDeps();
			renderHook(() => useAgentListeners(deps));

			onAgentErrorHandler?.(
				'group-chat-12345678-1234-1234-1234-123456789012-moderator-1700000000000',
				baseError
			);

			const groupChatState = useGroupChatStore.getState();
			expect(groupChatState.groupChatError).toEqual(
				expect.objectContaining({
					groupChatId: '12345678-1234-1234-1234-123456789012',
					participantName: 'Moderator',
				})
			);
			expect(groupChatState.groupChatMessages.at(-1)).toEqual(
				expect.objectContaining({
					from: 'system',
					content: expect.stringContaining('Moderator error:'),
				})
			);
			expect(groupChatState.groupChatState).toBe('idle');
			expect(groupChatState.groupChatStates.get('12345678-1234-1234-1234-123456789012')).toBe(
				'idle'
			);
		});

		it('suppresses group chat session_not_found errors for exit recovery', () => {
			useGroupChatStore.setState({
				groupChatError: null,
				groupChatMessages: [],
				groupChatState: 'working',
				groupChatStates: new Map([['12345678-1234-1234-1234-123456789012', 'working']]),
			});
			const deps = createMockDeps();
			renderHook(() => useAgentListeners(deps));

			onAgentErrorHandler?.(
				'group-chat-12345678-1234-1234-1234-123456789012-moderator-1700000000000',
				{
					...baseError,
					type: 'session_not_found',
				}
			);

			const groupChatState = useGroupChatStore.getState();
			expect(groupChatState.groupChatError).toBeNull();
			expect(groupChatState.groupChatMessages).toEqual([]);
			expect(groupChatState.groupChatState).toBe('working');
			expect(groupChatState.groupChatStates.get('12345678-1234-1234-1234-123456789012')).toBe(
				'working'
			);
		});

		it('suppresses participant group chat session_not_found errors for exit recovery', () => {
			useGroupChatStore.setState({
				groupChatError: null,
				groupChatMessages: [],
				groupChatState: 'working',
				groupChatStates: new Map([['12345678-1234-1234-1234-123456789012', 'working']]),
			});
			const deps = createMockDeps();
			renderHook(() => useAgentListeners(deps));

			onAgentErrorHandler?.(
				'group-chat-12345678-1234-1234-1234-123456789012-claude-1700000000000',
				{
					...baseError,
					type: 'session_not_found',
				}
			);

			const groupChatState = useGroupChatStore.getState();
			expect(groupChatState.groupChatError).toBeNull();
			expect(groupChatState.groupChatMessages).toEqual([]);
			expect(groupChatState.groupChatState).toBe('working');
			expect(groupChatState.groupChatStates.get('12345678-1234-1234-1234-123456789012')).toBe(
				'working'
			);
		});

		it('ignores synopsis process errors', () => {
			const deps = createMockDeps();
			const session = createMockSession({
				id: 'sess-1',
				state: 'busy',
				aiTabs: [createMockTab({ id: 'tab-1', logs: [] })],
				activeTabId: 'tab-1',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			onAgentErrorHandler?.('sess-1-synopsis-1700000000000', baseError);

			expect(useSessionStore.getState().sessions[0]).toBe(session);
			expect(useModalStore.getState().isOpen('agentError')).toBe(false);
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
			expect(deps.batchedUpdater.updateUsage).toHaveBeenCalledWith('sess-1', null, usage);
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

		it('falls back to accumulated context growth when raw token totals exceed the window', () => {
			const deps = createMockDeps();
			const tab = createMockTab({ id: 'tab-1' });
			const session = createMockSession({
				id: 'sess-1',
				toolType: 'claude-code',
				contextUsage: 70,
				aiTabs: [tab],
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			onUsageHandler?.('sess-1-ai-tab-1', {
				inputTokens: 500,
				outputTokens: 50,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
				totalCostUsd: 0.001,
				contextWindow: 100,
			});

			expect(deps.batchedUpdater.updateContextUsage).toHaveBeenCalledWith('sess-1', 73);
		});

		it('does not estimate accumulated context growth without prior usage', () => {
			const deps = createMockDeps();
			const session = createMockSession({
				id: 'sess-1',
				toolType: 'claude-code',
				contextUsage: 0,
				aiTabs: [createMockTab({ id: 'tab-1' })],
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			onUsageHandler?.('sess-1-ai-tab-1', {
				inputTokens: 500,
				outputTokens: 50,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
				totalCostUsd: 0.001,
				contextWindow: 100,
			});

			expect(deps.batchedUpdater.updateContextUsage).not.toHaveBeenCalled();
			expect(deps.batchedUpdater.updateCycleTokens).toHaveBeenCalledWith('sess-1', 50);
		});

		it('uses the default context window when accumulated usage exceeds the default window', () => {
			const deps = createMockDeps();
			const session = createMockSession({
				id: 'sess-1',
				toolType: 'claude-code',
				contextUsage: 70,
				aiTabs: [createMockTab({ id: 'tab-1' })],
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			onUsageHandler?.('sess-1-ai-tab-1', {
				inputTokens: 300_000,
				outputTokens: 50,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
				totalCostUsd: 0.001,
				contextWindow: 0,
			});

			expect(deps.batchedUpdater.updateContextUsage).toHaveBeenCalledWith('sess-1', 71);
		});

		it('skips accumulated context fallback when usage arrives for a missing session', () => {
			const deps = createMockDeps();
			renderHook(() => useAgentListeners(deps));

			onUsageHandler?.('missing-session-ai-tab-1', {
				inputTokens: 500,
				outputTokens: 50,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
				totalCostUsd: 0.001,
				contextWindow: 100,
			});

			expect(deps.batchedUpdater.updateUsage).toHaveBeenCalledWith(
				'missing-session',
				'tab-1',
				expect.objectContaining({ inputTokens: 500 })
			);
			expect(deps.batchedUpdater.updateContextUsage).not.toHaveBeenCalled();
		});

		it('keeps current context usage when no agent type can provide a fallback window', () => {
			const deps = createMockDeps();
			const session = createMockSession({
				id: 'sess-1',
				toolType: undefined as any,
				contextUsage: 70,
				aiTabs: [createMockTab({ id: 'tab-1' })],
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			onUsageHandler?.('sess-1-ai-tab-1', {
				inputTokens: 500,
				outputTokens: 50,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
				totalCostUsd: 0.001,
				contextWindow: 0,
			});

			expect(deps.batchedUpdater.updateContextUsage).toHaveBeenCalledWith('sess-1', 70);
		});

		it('keeps current context usage when the agent type has no default window', () => {
			const deps = createMockDeps();
			const session = createMockSession({
				id: 'sess-1',
				toolType: 'unknown-agent' as any,
				contextUsage: 70,
				aiTabs: [createMockTab({ id: 'tab-1' })],
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			onUsageHandler?.('sess-1-ai-tab-1', {
				inputTokens: 500,
				outputTokens: 50,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
				totalCostUsd: 0.001,
				contextWindow: 0,
			});

			expect(deps.batchedUpdater.updateContextUsage).toHaveBeenCalledWith('sess-1', 70);
		});
	});

	// ========================================================================
	// onThinkingChunk handler
	// ========================================================================

	describe('onThinkingChunk', () => {
		it('buffers multiple chunks into a single thinking log on the next animation frame', () => {
			const restoreAnimationFrame = installMockAnimationFrame();
			try {
				const deps = createMockDeps();
				const tab = createMockTab({
					id: 'tab-1',
					showThinking: 'on',
					logs: [],
				});
				const otherTab = createMockTab({
					id: 'tab-2',
					showThinking: 'on',
					logs: [],
				});
				const session = createMockSession({
					id: 'sess-1',
					aiTabs: [tab, otherTab],
					activeTabId: 'tab-1',
				});
				useSessionStore.setState({
					sessions: [session],
					activeSessionId: 'sess-1',
				});

				renderHook(() => useAgentListeners(deps));

				onThinkingChunkHandler?.('sess-1-ai-tab-1', 'thinking ');
				onThinkingChunkHandler?.('sess-1-ai-tab-1', 'chunk');
				expect(globalThis.requestAnimationFrame).toHaveBeenCalledTimes(1);

				vi.runOnlyPendingTimers();

				const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
				expect(updated?.aiTabs[0].logs).toEqual([
					expect.objectContaining({
						source: 'thinking',
						text: 'thinking chunk',
					}),
				]);
				expect(updated?.aiTabs[1]).toBe(otherTab);
			} finally {
				restoreAnimationFrame();
			}
		});

		it('appends buffered thinking content to an existing thinking log', () => {
			const restoreAnimationFrame = installMockAnimationFrame();
			try {
				const deps = createMockDeps();
				const tab = createMockTab({
					id: 'tab-1',
					showThinking: 'on',
					logs: [
						{
							id: 'thinking-1',
							timestamp: 1700000000000,
							source: 'thinking',
							text: 'existing ',
						},
					],
				});
				const otherTab = createMockTab({ id: 'tab-2', showThinking: 'on', logs: [] });
				const session = createMockSession({
					id: 'sess-1',
					aiTabs: [tab, otherTab],
					activeTabId: 'tab-1',
				});
				useSessionStore.setState({
					sessions: [session],
					activeSessionId: 'sess-1',
				});

				renderHook(() => useAgentListeners(deps));

				onThinkingChunkHandler?.('sess-1-ai-tab-1', 'addition');
				vi.runOnlyPendingTimers();

				const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
				expect(updated?.aiTabs[0].logs).toEqual([
					expect.objectContaining({
						id: 'thinking-1',
						source: 'thinking',
						text: 'existing addition',
					}),
				]);
				expect(updated?.aiTabs[1]).toBe(otherTab);
			} finally {
				restoreAnimationFrame();
			}
		});

		it('ignores thinking chunks for sessions that are no longer present', () => {
			const restoreAnimationFrame = installMockAnimationFrame();
			try {
				const deps = createMockDeps();
				const session = createMockSession({
					id: 'sess-1',
					aiTabs: [createMockTab({ id: 'tab-1', showThinking: 'on', logs: [] })],
					activeTabId: 'tab-1',
				});
				useSessionStore.setState({
					sessions: [session],
					activeSessionId: 'sess-1',
				});

				renderHook(() => useAgentListeners(deps));

				onThinkingChunkHandler?.('missing-session-ai-tab-1', 'orphaned chunk');
				vi.runOnlyPendingTimers();

				expect(useSessionStore.getState().sessions[0]).toBe(session);
			} finally {
				restoreAnimationFrame();
			}
		});

		it('skips unrelated buffered chunks and missing target tabs while applying valid thinking', () => {
			const restoreAnimationFrame = installMockAnimationFrame();
			try {
				const deps = createMockDeps();
				const session = createMockSession({
					id: 'sess-1',
					aiTabs: [createMockTab({ id: 'tab-1', showThinking: 'on', logs: [] })],
					activeTabId: 'tab-1',
				});
				useSessionStore.setState({
					sessions: [session],
					activeSessionId: 'sess-1',
				});

				renderHook(() => useAgentListeners(deps));

				onThinkingChunkHandler?.('other-session-ai-tab-1', 'other chunk');
				onThinkingChunkHandler?.('sess-1-ai-missing-tab', 'missing tab chunk');
				onThinkingChunkHandler?.('sess-1-ai-tab-1', 'visible thinking');
				vi.runOnlyPendingTimers();

				const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
				expect(updated?.aiTabs[0].logs).toEqual([
					expect.objectContaining({
						source: 'thinking',
						text: 'visible thinking',
					}),
				]);
			} finally {
				restoreAnimationFrame();
			}
		});

		it('drops malformed thinking chunks and replaces malformed combined thinking content', () => {
			const restoreAnimationFrame = installMockAnimationFrame();
			try {
				const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
				const deps = createMockDeps();
				const malformedTab = createMockTab({
					id: 'tab-1',
					showThinking: 'on',
					logs: [],
				});
				const replacingTab = createMockTab({
					id: 'tab-2',
					showThinking: 'on',
					logs: [
						{
							id: 'thinking-1',
							timestamp: 1700000000000,
							source: 'thinking',
							text: 'Task',
						},
					],
				});
				const session = createMockSession({
					id: 'sess-1',
					aiTabs: [malformedTab, replacingTab],
					activeTabId: 'tab-1',
				});
				useSessionStore.setState({
					sessions: [session],
					activeSessionId: 'sess-1',
				});

				renderHook(() => useAgentListeners(deps));

				onThinkingChunkHandler?.('sess-1-ai-tab-1', 'TaskGrepRead');
				vi.runOnlyPendingTimers();

				let updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
				expect(updated?.aiTabs.find((tab) => tab.id === 'tab-1')?.logs).toEqual([]);
				expect(consoleWarnSpy).toHaveBeenCalledWith(
					'[App] Skipping malformed thinking chunk (concatenated tool names):',
					'TaskGrepRead'
				);

				onThinkingChunkHandler?.('sess-1-ai-tab-2', 'GrepRead');
				vi.runOnlyPendingTimers();

				updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
				expect(updated?.aiTabs.find((tab) => tab.id === 'tab-2')?.logs).toEqual([
					expect.objectContaining({
						id: 'thinking-1',
						source: 'thinking',
						text: 'GrepRead',
					}),
				]);
				expect(consoleWarnSpy).toHaveBeenCalledWith(
					'[App] Detected malformed thinking content, replacing instead of appending'
				);
			} finally {
				restoreAnimationFrame();
			}
		});

		it('ignores malformed IDs and tabs with thinking hidden', () => {
			const restoreAnimationFrame = installMockAnimationFrame();
			try {
				const deps = createMockDeps();
				const tab = createMockTab({
					id: 'tab-1',
					showThinking: 'off',
					logs: [],
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

				onThinkingChunkHandler?.('sess-1-terminal', 'ignored');
				expect(globalThis.requestAnimationFrame).not.toHaveBeenCalled();

				onThinkingChunkHandler?.('sess-1-ai-tab-1', 'hidden');
				vi.runOnlyPendingTimers();

				const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
				expect(updated?.aiTabs[0].logs).toEqual([]);
			} finally {
				restoreAnimationFrame();
			}
		});

		it('cancels pending thinking chunk animation frame on unmount', () => {
			const restoreAnimationFrame = installMockAnimationFrame();
			try {
				const deps = createMockDeps();
				const tab = createMockTab({
					id: 'tab-1',
					showThinking: 'on',
					logs: [],
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

				const { unmount } = renderHook(() => useAgentListeners(deps));

				onThinkingChunkHandler?.('sess-1-ai-tab-1', 'pending');
				expect(globalThis.requestAnimationFrame).toHaveBeenCalledTimes(1);

				unmount();

				expect(globalThis.cancelAnimationFrame).toHaveBeenCalledTimes(1);
			} finally {
				restoreAnimationFrame();
			}
		});

		it('ignores stale thinking animation frame callbacks after cleanup clears the buffer', () => {
			const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
			const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
			let capturedCallback: FrameRequestCallback | undefined;
			globalThis.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
				capturedCallback = callback;
				return 123;
			});
			globalThis.cancelAnimationFrame = vi.fn();

			try {
				const deps = createMockDeps();
				const session = createMockSession({
					id: 'sess-1',
					aiTabs: [createMockTab({ id: 'tab-1', showThinking: 'on', logs: [] })],
					activeTabId: 'tab-1',
				});
				useSessionStore.setState({
					sessions: [session],
					activeSessionId: 'sess-1',
				});

				const { unmount } = renderHook(() => useAgentListeners(deps));

				onThinkingChunkHandler?.('sess-1-ai-tab-1', 'pending');
				unmount();
				capturedCallback?.(0);

				expect(useSessionStore.getState().sessions[0].aiTabs[0].logs).toEqual([]);
				expect(globalThis.cancelAnimationFrame).toHaveBeenCalledWith(123);
			} finally {
				if (originalRequestAnimationFrame) {
					globalThis.requestAnimationFrame = originalRequestAnimationFrame;
				} else {
					delete (globalThis as Partial<typeof globalThis>).requestAnimationFrame;
				}
				if (originalCancelAnimationFrame) {
					globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
				} else {
					delete (globalThis as Partial<typeof globalThis>).cancelAnimationFrame;
				}
			}
		});
	});

	// ========================================================================
	// onToolExecution handler
	// ========================================================================

	describe('onToolExecution', () => {
		it('appends tool execution logs when thinking output is visible', () => {
			const deps = createMockDeps();
			const otherSession = createMockSession({ id: 'other-session' });
			const tab = createMockTab({
				id: 'tab-1',
				showThinking: 'on',
				logs: [],
			});
			const untouchedTab = createMockTab({
				id: 'tab-2',
				showThinking: 'on',
				logs: [],
			});
			const session = createMockSession({
				id: 'sess-1',
				aiTabs: [tab, untouchedTab],
				activeTabId: 'tab-1',
			});
			useSessionStore.setState({
				sessions: [otherSession, session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			onToolExecutionHandler?.('sess-1-ai-tab-1', {
				toolName: 'Read',
				state: { path: '/tmp/file.ts' },
				timestamp: 1700000000123,
			});

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			expect(updated?.aiTabs[0].logs).toEqual([
				expect.objectContaining({
					source: 'tool',
					text: 'Read',
					timestamp: 1700000000123,
					metadata: {
						toolState: { path: '/tmp/file.ts' },
					},
				}),
			]);
			expect(updated?.aiTabs[1]).toBe(untouchedTab);
			expect(useSessionStore.getState().sessions.find((s) => s.id === 'other-session')).toBe(
				otherSession
			);
		});

		it('ignores malformed IDs and tabs with thinking output hidden', () => {
			const deps = createMockDeps();
			const tab = createMockTab({
				id: 'tab-1',
				showThinking: 'off',
				logs: [],
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

			onToolExecutionHandler?.('sess-1-terminal', {
				toolName: 'Ignored',
				timestamp: 1700000000123,
			});
			onToolExecutionHandler?.('sess-1-ai-tab-1', {
				toolName: 'Hidden',
				timestamp: 1700000000124,
			});

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			expect(updated?.aiTabs[0].logs).toEqual([]);
		});
	});

	// ========================================================================
	// onSshRemote handler
	// ========================================================================

	describe('onSshRemote', () => {
		it('updates session SSH remote info', () => {
			const deps = createMockDeps();
			const otherSession = createMockSession({ id: 'other-session' });
			const session = createMockSession({ id: 'sess-1' });
			useSessionStore.setState({
				sessions: [otherSession, session],
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
			expect(useSessionStore.getState().sessions.find((s) => s.id === 'other-session')).toBe(
				otherSession
			);
		});

		it('updates SSH remote info for plain session IDs', () => {
			const deps = createMockDeps();
			const session = createMockSession({ id: 'sess-1' });
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			onSshRemoteHandler?.('sess-1', {
				id: 'remote-plain',
				name: 'Plain Server',
				host: 'plain.example.com',
			});

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			expect(updated?.sshRemote).toEqual({
				id: 'remote-plain',
				name: 'Plain Server',
				host: 'plain.example.com',
			});
			expect(updated?.sshRemoteId).toBe('remote-plain');
		});

		it('clears SSH remote info from terminal-suffixed session IDs', () => {
			const deps = createMockDeps();
			const session = createMockSession({
				id: 'sess-1',
				sshRemote: {
					id: 'remote-1',
					name: 'My Server',
					host: 'example.com',
				},
				sshRemoteId: 'remote-1',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			onSshRemoteHandler?.('sess-1-terminal', null);

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			expect(updated?.sshRemote).toBeUndefined();
			expect(updated?.sshRemoteId).toBeUndefined();
		});

		it('preserves session identity when the SSH remote ID is unchanged', () => {
			const deps = createMockDeps();
			const sshRemote = {
				id: 'remote-1',
				name: 'My Server',
				host: 'example.com',
			};
			const session = createMockSession({
				id: 'sess-1',
				sshRemote,
				sshRemoteId: 'remote-1',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			onSshRemoteHandler?.('sess-1-ai-tab-1', {
				id: 'remote-1',
				name: 'Updated Name',
				host: 'updated.example.com',
			});

			expect(useSessionStore.getState().sessions[0]).toBe(session);
		});

		it('detects a remote git repo and caches branches and tags for new SSH remotes', async () => {
			const isRepoSpy = vi.spyOn(gitService, 'isRepo').mockResolvedValue(true);
			const getBranchesSpy = vi
				.spyOn(gitService, 'getBranches')
				.mockResolvedValue(['main', 'feature/test']);
			const getTagsSpy = vi.spyOn(gitService, 'getTags').mockResolvedValue(['v1.0.0']);
			const deps = createMockDeps();
			const otherSession = createMockSession({ id: 'other-session', isGitRepo: false });
			const session = createMockSession({
				id: 'sess-1',
				isGitRepo: false,
				cwd: '/local/project',
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'remote-1',
					workingDirOverride: '/remote/project',
				},
			});
			useSessionStore.setState({
				sessions: [otherSession, session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			onSshRemoteHandler?.('sess-1-ai', {
				id: 'remote-1',
				name: 'Build Server',
				host: 'build.example.com',
			});
			await flushAsyncWork();

			expect(isRepoSpy).toHaveBeenCalledWith('/remote/project', 'remote-1');
			expect(getBranchesSpy).toHaveBeenCalledWith('/remote/project', 'remote-1');
			expect(getTagsSpy).toHaveBeenCalledWith('/remote/project', 'remote-1');
			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			expect(updated).toEqual(
				expect.objectContaining({
					isGitRepo: true,
					gitBranches: ['main', 'feature/test'],
					gitTags: ['v1.0.0'],
					gitRefsCacheTime: expect.any(Number),
				})
			);
			expect(useSessionStore.getState().sessions.find((s) => s.id === 'other-session')).toBe(
				otherSession
			);
		});

		it('does not load git refs when a new SSH remote is not a git repo', async () => {
			const isRepoSpy = vi.spyOn(gitService, 'isRepo').mockResolvedValue(false);
			const getBranchesSpy = vi.spyOn(gitService, 'getBranches');
			const getTagsSpy = vi.spyOn(gitService, 'getTags');
			const deps = createMockDeps();
			const session = createMockSession({
				id: 'sess-1',
				isGitRepo: false,
				cwd: '/local/project',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			onSshRemoteHandler?.('sess-1-ai', {
				id: 'remote-1',
				name: 'Build Server',
				host: 'build.example.com',
			});
			await flushAsyncWork();

			expect(isRepoSpy).toHaveBeenCalledWith('/local/project', 'remote-1');
			expect(getBranchesSpy).not.toHaveBeenCalled();
			expect(getTagsSpy).not.toHaveBeenCalled();
			expect(useSessionStore.getState().sessions[0]).toEqual(
				expect.objectContaining({
					isGitRepo: false,
					sshRemoteId: 'remote-1',
				})
			);
		});

		it('does not overwrite git refs when repo status changes before SSH detection resolves', async () => {
			let resolveIsRepo: (value: boolean) => void = () => {};
			vi.spyOn(gitService, 'isRepo').mockImplementation(
				() =>
					new Promise<boolean>((resolve) => {
						resolveIsRepo = resolve;
					})
			);
			const getBranchesSpy = vi.spyOn(gitService, 'getBranches').mockResolvedValue(['main']);
			const getTagsSpy = vi.spyOn(gitService, 'getTags').mockResolvedValue(['v1.0.0']);
			const deps = createMockDeps();
			const session = createMockSession({
				id: 'sess-1',
				isGitRepo: false,
				cwd: '/local/project',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			onSshRemoteHandler?.('sess-1-ai', {
				id: 'remote-1',
				name: 'Build Server',
				host: 'build.example.com',
			});

			useSessionStore.setState((state) => ({
				sessions: state.sessions.map((s) =>
					s.id === 'sess-1' ? { ...s, isGitRepo: true, gitBranches: ['existing'] } : s
				),
			}));
			resolveIsRepo(true);
			await flushAsyncWork();

			expect(getBranchesSpy).toHaveBeenCalledWith('/local/project', 'remote-1');
			expect(getTagsSpy).toHaveBeenCalledWith('/local/project', 'remote-1');
			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			expect(updated).toEqual(
				expect.objectContaining({ isGitRepo: true, gitBranches: ['existing'] })
			);
			expect(updated?.gitTags).toBeUndefined();
		});

		it('logs SSH git detection failures without marking the session as a repo', async () => {
			const error = new Error('ssh offline');
			vi.spyOn(gitService, 'isRepo').mockRejectedValue(error);
			const getBranchesSpy = vi.spyOn(gitService, 'getBranches');
			const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
			const deps = createMockDeps();
			const session = createMockSession({
				id: 'sess-1',
				isGitRepo: false,
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			onSshRemoteHandler?.('sess-1-ai', {
				id: 'remote-1',
				name: 'Build Server',
				host: 'build.example.com',
			});
			await flushAsyncWork();

			expect(getBranchesSpy).not.toHaveBeenCalled();
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				'[SSH] Failed to check git repo status for sess-1:',
				error
			);
			expect(useSessionStore.getState().sessions[0].isGitRepo).toBe(false);
		});
	});

	// ========================================================================
	// onExit handler (basic tests — full behavior is very complex)
	// ========================================================================

	describe('onExit', () => {
		it('returns early for batch process exits', async () => {
			const deps = createMockDeps();
			vi.spyOn(console, 'log').mockImplementation(() => undefined);
			renderHook(() => useAgentListeners(deps));

			await onExitHandler?.('sess-1-batch-123', 0);

			expect(mockProcess.getActiveProcesses).not.toHaveBeenCalled();
			expect(deps.addToastRef.current).not.toHaveBeenCalled();
			expect(useSessionStore.getState().sessions).toEqual([]);
		});

		it('ignores AI exit events while the process is still reported active', async () => {
			const deps = createMockDeps();
			const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
			mockProcess.getActiveProcesses.mockResolvedValueOnce([{ sessionId: 'sess-1-ai-tab-1' }]);
			const session = createMockSession({
				id: 'sess-1',
				state: 'busy',
				busySource: 'ai',
				aiTabs: [createMockTab({ id: 'tab-1', state: 'busy' })],
				activeTabId: 'tab-1',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			await onExitHandler?.('sess-1-ai-tab-1', 0);

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			expect(updated?.state).toBe('busy');
			expect(updated?.aiTabs[0].state).toBe('busy');
			expect(consoleWarnSpy).toHaveBeenCalledWith(
				'[onExit] Process still running despite exit event, ignoring:',
				expect.objectContaining({
					sessionId: 'sess-1-ai-tab-1',
					activeProcesses: ['sess-1-ai-tab-1'],
				})
			);
		});

		it('continues AI exit handling when active process verification fails', async () => {
			const deps = createMockDeps();
			const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
			mockProcess.getActiveProcesses.mockRejectedValueOnce(new Error('process list failed'));
			const session = createMockSession({
				id: 'sess-1',
				state: 'busy',
				busySource: 'ai',
				aiTabs: [createMockTab({ id: 'tab-1', state: 'busy' })],
				activeTabId: 'tab-1',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			await onExitHandler?.('sess-1-ai-tab-1', 0);

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			expect(updated?.state).toBe('idle');
			expect(updated?.aiTabs[0].state).toBe('idle');
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				'[onExit] Failed to verify process status:',
				expect.any(Error)
			);
		});

		it('ignores AI process exits when the owning session no longer exists', async () => {
			const deps = createMockDeps();
			renderHook(() => useAgentListeners(deps));
			await flushAsyncWork();
			vi.clearAllMocks();
			useSessionStore.setState({ sessions: [], activeSessionId: '' });

			await onExitHandler?.('missing-session-ai-tab-1', 0);
			await flushAsyncWork();

			expect(useSessionStore.getState().sessions).toEqual([]);
			expect(window.maestro.stats.recordQuery).not.toHaveBeenCalled();
			expect(window.maestro.logger.log).not.toHaveBeenCalled();
			expect(deps.addToastRef.current).not.toHaveBeenCalled();
		});

		it('does not process queued AI work while the session is already paused for an agent error', async () => {
			const processQueuedItem = vi.fn();
			const deps = createMockDeps({
				processQueuedItemRef: { current: processQueuedItem },
			});
			const agentError: AgentError = {
				type: 'auth_expired',
				message: 'Authentication required',
				recoverable: true,
				agentId: 'claude-code',
				sessionId: 'agent-session-1',
				timestamp: Date.now(),
			};
			const queueItem = {
				id: 'queue-1',
				tabId: 'tab-1',
				type: 'message' as const,
				text: 'queued prompt',
				timestamp: 1700000000000,
			};
			const untouchedTab = createMockTab({ id: 'tab-2', state: 'idle' });
			const session = createMockSession({
				id: 'sess-1',
				state: 'error',
				busySource: 'ai',
				agentError,
				aiTabs: [untouchedTab],
				activeTabId: 'tab-2',
				executionQueue: [queueItem],
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			await onExitHandler?.('sess-1-ai-tab-1', 0);
			await flushAsyncWork();

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			expect(updated).toEqual(
				expect.objectContaining({
					state: 'error',
					agentError,
					executionQueue: [queueItem],
				})
			);
			expect(updated?.aiTabs[0]).toBe(untouchedTab);
			expect(processQueuedItem).not.toHaveBeenCalled();
		});

		it('preserves errored sessions with no AI tabs on process exit', async () => {
			const deps = createMockDeps();
			const agentError: AgentError = {
				type: 'network_error',
				message: 'Network failed',
				recoverable: true,
				agentId: 'claude-code',
				sessionId: 'agent-session-1',
				timestamp: Date.now(),
			};
			const session = createMockSession({
				id: 'sess-1',
				state: 'error',
				busySource: 'ai',
				agentError,
				aiTabs: [],
				activeTabId: 'missing-tab',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			await onExitHandler?.('sess-1-ai-tab-1', 0);

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			expect(updated).toEqual(
				expect.objectContaining({
					state: 'error',
					busySource: undefined,
					thinkingStartTime: undefined,
					aiTabs: [],
				})
			);
		});

		it('preserves session error state while clearing busy AI tab state on exit', async () => {
			const deps = createMockDeps();
			const agentError: AgentError = {
				type: 'auth_expired',
				message: 'Authentication required',
				recoverable: true,
				agentId: 'claude-code',
				sessionId: 'agent-session-1',
				timestamp: Date.now(),
			};
			const session = createMockSession({
				id: 'sess-1',
				state: 'error',
				busySource: 'ai',
				agentError,
				thinkingStartTime: 1700000000000,
				aiTabs: [
					createMockTab({
						id: 'tab-1',
						state: 'busy',
						thinkingStartTime: 1700000000000,
					}),
				],
				activeTabId: 'tab-1',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			await onExitHandler?.('sess-1-ai-tab-1', 0);

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			expect(updated?.state).toBe('error');
			expect(updated?.busySource).toBeUndefined();
			expect(updated?.thinkingStartTime).toBeUndefined();
			expect(updated?.agentError).toBe(agentError);
			expect(updated?.aiTabs[0].state).toBe('idle');
			expect(updated?.aiTabs[0].thinkingStartTime).toBeUndefined();
		});

		it('preserves error state while clearing all busy tabs on legacy AI exit', async () => {
			const deps = createMockDeps();
			const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
			const agentError: AgentError = {
				type: 'network_error',
				message: 'Network failed',
				recoverable: true,
				agentId: 'claude-code',
				sessionId: 'agent-session-1',
				timestamp: Date.now(),
			};
			const session = createMockSession({
				id: 'sess-1',
				state: 'error',
				busySource: 'ai',
				agentError,
				thinkingStartTime: 1700000000000,
				aiTabs: [
					createMockTab({
						id: 'tab-1',
						state: 'busy',
						thinkingStartTime: 1700000000000,
					}),
					createMockTab({ id: 'tab-2', state: 'idle' }),
				],
				activeTabId: 'tab-1',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			await onExitHandler?.('sess-1-ai', 0);

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			expect(updated?.state).toBe('error');
			expect(updated?.busySource).toBeUndefined();
			expect(updated?.thinkingStartTime).toBeUndefined();
			expect(updated?.agentError).toBe(agentError);
			expect(updated?.aiTabs).toEqual([
				expect.objectContaining({ id: 'tab-1', state: 'idle', thinkingStartTime: undefined }),
				expect.objectContaining({ id: 'tab-2', state: 'idle' }),
			]);
			expect(consoleLogSpy).toHaveBeenCalledWith(
				'[onExit] Process exit event received:',
				expect.objectContaining({ rawSessionId: 'sess-1-ai' })
			);
		});

		it('clears all busy tabs on successful legacy AI exit', async () => {
			const deps = createMockDeps();
			vi.spyOn(console, 'log').mockImplementation(() => undefined);
			const session = createMockSession({
				id: 'sess-1',
				state: 'busy',
				busySource: 'ai',
				thinkingStartTime: 1700000000000,
				aiTabs: [
					createMockTab({
						id: 'tab-1',
						state: 'busy',
						thinkingStartTime: 1700000000000,
					}),
					createMockTab({
						id: 'tab-2',
						state: 'busy',
						thinkingStartTime: 1700000000000,
					}),
				],
				activeTabId: 'tab-1',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			await onExitHandler?.('sess-1-ai', 0);

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			expect(updated?.state).toBe('idle');
			expect(updated?.busySource).toBeUndefined();
			expect(updated?.thinkingStartTime).toBeUndefined();
			expect(updated?.aiTabs).toEqual([
				expect.objectContaining({ id: 'tab-1', state: 'idle', thinkingStartTime: undefined }),
				expect.objectContaining({ id: 'tab-2', state: 'idle', thinkingStartTime: undefined }),
			]);
		});

		it('keeps AI sessions busy when a different AI tab is still running', async () => {
			const deps = createMockDeps();
			vi.spyOn(console, 'log').mockImplementation(() => undefined);
			const sessionThinkingStart = 1700000000000;
			const stillBusyStart = 1700000000100;
			const session = createMockSession({
				id: 'sess-1',
				state: 'busy',
				busySource: 'ai',
				thinkingStartTime: sessionThinkingStart,
				aiTabs: [
					createMockTab({
						id: 'tab-1',
						state: 'busy',
						thinkingStartTime: 1700000000200,
					}),
					createMockTab({
						id: 'tab-2',
						state: 'busy',
						thinkingStartTime: stillBusyStart,
					}),
				],
				activeTabId: 'tab-1',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			await onExitHandler?.('sess-1-ai-tab-1', 0);

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			expect(updated?.state).toBe('busy');
			expect(updated?.busySource).toBe('ai');
			expect(updated?.thinkingStartTime).toBe(sessionThinkingStart);
			expect(updated?.aiTabs).toEqual([
				expect.objectContaining({ id: 'tab-1', state: 'idle', thinkingStartTime: undefined }),
				expect.objectContaining({ id: 'tab-2', state: 'busy', thinkingStartTime: stillBusyStart }),
			]);
		});

		it('idles successful legacy AI exits when there are no AI tabs', async () => {
			const deps = createMockDeps();
			const session = createMockSession({
				id: 'sess-1',
				state: 'busy',
				busySource: 'ai',
				aiTabs: [],
				activeTabId: 'missing-tab',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			await onExitHandler?.('sess-1-ai', 0);

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			expect(updated).toEqual(
				expect.objectContaining({
					state: 'idle',
					busySource: undefined,
					thinkingStartTime: undefined,
					aiTabs: [],
				})
			);
		});

		it('leaves idle AI tabs unchanged on legacy AI exit', async () => {
			const deps = createMockDeps();
			const idleTab = createMockTab({ id: 'tab-1', state: 'idle' });
			const session = createMockSession({
				id: 'sess-1',
				state: 'busy',
				busySource: 'ai',
				aiTabs: [idleTab],
				activeTabId: 'tab-1',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			await onExitHandler?.('sess-1-ai', 0);

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			expect(updated?.state).toBe('idle');
			expect(updated?.busySource).toBeUndefined();
			expect(updated?.aiTabs[0]).toBe(idleTab);
		});

		it('clears busy state for error sessions without an attached agent error', async () => {
			const deps = createMockDeps();
			const tab = createMockTab({
				id: 'tab-1',
				state: 'busy',
				thinkingStartTime: 1700000000000,
			});
			const session = createMockSession({
				id: 'sess-1',
				state: 'error',
				busySource: 'ai',
				agentError: undefined,
				aiTabs: [tab],
				activeTabId: 'tab-1',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			await onExitHandler?.('sess-1-ai-tab-1', 0);

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			expect(updated?.state).toBe('idle');
			expect(updated?.busySource).toBeUndefined();
			expect(updated?.aiTabs[0].state).toBe('idle');
		});

		it('starts the next queued message and appends its user log after AI exit', async () => {
			const processQueuedItem = vi.fn().mockResolvedValue(undefined);
			const deps = createMockDeps({
				processQueuedItemRef: { current: processQueuedItem },
			});
			const queueItem = {
				id: 'queue-1',
				tabId: 'tab-2',
				type: 'message' as const,
				text: 'queued prompt',
				images: ['image-data'],
				timestamp: 1700000000000,
			};
			const session = createMockSession({
				id: 'sess-1',
				state: 'busy',
				busySource: 'ai',
				aiTabs: [
					createMockTab({ id: 'tab-1', state: 'busy' }),
					createMockTab({ id: 'tab-2', state: 'idle', logs: [] }),
					createMockTab({ id: 'tab-3', state: 'idle', logs: [] }),
				],
				activeTabId: 'tab-1',
				executionQueue: [queueItem],
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			await onExitHandler?.('sess-1-ai-tab-1', 0);
			await new Promise((resolve) => setTimeout(resolve, 0));

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			expect(updated?.state).toBe('busy');
			expect(updated?.busySource).toBe('ai');
			expect(updated?.executionQueue).toEqual([]);
			expect(updated?.aiTabs.find((tab) => tab.id === 'tab-1')?.state).toBe('idle');
			const queuedTab = updated?.aiTabs.find((tab) => tab.id === 'tab-2');
			expect(queuedTab?.state).toBe('busy');
			expect(queuedTab?.logs).toEqual([
				expect.objectContaining({
					source: 'user',
					text: 'queued prompt',
					images: ['image-data'],
				}),
			]);
			expect(updated?.aiTabs.find((tab) => tab.id === 'tab-3')).toEqual(
				expect.objectContaining({ state: 'idle', logs: [] })
			);
			expect(processQueuedItem).toHaveBeenCalledWith('sess-1', queueItem);
		});

		it('continues queued processing when the queued target tab is missing', async () => {
			const processQueuedItem = vi.fn().mockResolvedValue(undefined);
			const deps = createMockDeps({
				processQueuedItemRef: { current: processQueuedItem },
			});
			const otherSession = createMockSession({ id: 'other-session' });
			const queueItem = {
				id: 'queue-missing-tab',
				tabId: 'missing-tab',
				type: 'message' as const,
				text: 'queued prompt without target tab',
				timestamp: 1700000000000,
			};
			const session = createMockSession({
				id: 'sess-1',
				state: 'busy',
				busySource: 'ai',
				aiTabs: [],
				activeTabId: 'missing-tab',
				executionQueue: [queueItem],
			});
			useSessionStore.setState({
				sessions: [otherSession, session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			await onExitHandler?.('sess-1-ai-tab-1', 0);
			await flushAsyncWork();

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			expect(updated).toEqual(
				expect.objectContaining({
					state: 'busy',
					busySource: 'ai',
					executionQueue: [],
					aiTabs: [],
					currentCycleTokens: 0,
					currentCycleBytes: 0,
				})
			);
			expect(processQueuedItem).toHaveBeenCalledWith('sess-1', queueItem);
			expect(useSessionStore.getState().sessions.find((s) => s.id === 'other-session')).toBe(
				otherSession
			);
		});

		it('records query stats for completed AI processes with timing data', async () => {
			const deps = createMockDeps({
				getBatchStateRef: { current: vi.fn().mockReturnValue({ isRunning: true }) },
			});
			const session = createMockSession({
				id: 'sess-1',
				name: 'Project Session',
				groupId: 'group-1',
				state: 'busy',
				busySource: 'ai',
				toolType: 'codex',
				cwd: '/repo/project',
				usageStats: {
					inputTokens: 100,
					outputTokens: 25,
					cacheReadInputTokens: 5,
					cacheCreationInputTokens: 0,
					totalCostUsd: 0.01,
				},
				aiTabs: [
					createMockTab({
						id: 'tab-1',
						name: 'Implementation',
						state: 'busy',
						thinkingStartTime: Date.now() - 1000,
						agentSessionId: 'agent-session-1',
						logs: [
							{ id: 'user-1', timestamp: 1, source: 'user', text: 'Implement feature' },
							{ id: 'ai-1', timestamp: 2, source: 'ai', text: 'Implemented feature.' },
						],
					}),
				],
				activeTabId: 'tab-1',
			});
			useSessionStore.setState({
				sessions: [session],
				groups: [{ id: 'group-1', name: 'Coverage Group', emoji: 'G', collapsed: false }],
				activeSessionId: 'other-session',
			});

			renderHook(() => useAgentListeners(deps));

			await onExitHandler?.('sess-1-ai-tab-1', 0);

			expect(window.maestro.stats.recordQuery).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionId: 'sess-1',
					agentType: 'codex',
					source: 'auto',
					projectPath: '/repo/project',
					tabId: 'tab-1',
					isRemote: false,
				})
			);
		});

		it('logs truncated completion metadata and fallback summaries for inactive AI tabs', async () => {
			const deps = createMockDeps();
			const longPrompt = `Review ${'branch coverage '.repeat(20)}`;
			const longResponse = `${'coverage detail '.repeat(45)}done.`;
			const session = createMockSession({
				id: 'sess-1',
				name: '',
				cwd: '',
				state: 'busy',
				busySource: 'ai',
				toolType: 'codex',
				aiTabs: [
					createMockTab({
						id: 'tab-1',
						state: 'busy',
						thinkingStartTime: Date.now() - 1000,
						agentSessionId: 'agent-session-1',
						logs: [
							{ id: 'user-1', timestamp: 1, source: 'user', text: longPrompt },
							{ id: 'system-1', timestamp: 1, source: 'system', text: undefined as any },
							{ id: 'ai-1', timestamp: 2, source: 'ai', text: longResponse },
						],
					}),
				],
				activeTabId: 'tab-1',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'other-session',
			});

			renderHook(() => useAgentListeners(deps));

			await onExitHandler?.('sess-1-ai-tab-1', 0);
			await flushAsyncWork();

			expect(window.maestro.logger.log).toHaveBeenCalledWith(
				'info',
				'Agent process completed',
				'App',
				expect.objectContaining({
					project: 'Unknown',
					prompt: expect.stringMatching(/^\S[\s\S]{199}\.\.\.$/),
					response: expect.stringMatching(/^\S[\s\S]{499}\.\.\.$/),
				})
			);
			expect(useNotificationStore.getState().toasts.at(-1)).toEqual(
				expect.objectContaining({
					title: `${longPrompt.substring(0, 47)}...`,
					message: `${longResponse.trim().substring(0, 120)}...`,
					project: 'Unknown',
				})
			);
		});

		it('uses a bounded fallback summary when AI output has no sentence punctuation', async () => {
			const deps = createMockDeps();
			const responseWithoutSentence = 'completed branch coverage work '.repeat(12);
			const session = createMockSession({
				id: 'sess-1',
				state: 'busy',
				busySource: 'ai',
				toolType: 'codex',
				aiTabs: [
					createMockTab({
						id: 'tab-1',
						state: 'busy',
						thinkingStartTime: Date.now() - 1000,
						agentSessionId: 'agent-session-1',
						logs: [
							{ id: 'user-1', timestamp: 1, source: 'user', text: 'Summarize without punctuation' },
							{ id: 'ai-1', timestamp: 2, source: 'ai', text: responseWithoutSentence },
						],
					}),
				],
				activeTabId: 'tab-1',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'other-session',
			});

			renderHook(() => useAgentListeners(deps));

			await onExitHandler?.('sess-1-ai-tab-1', 0);
			await flushAsyncWork();

			expect(useNotificationStore.getState().toasts.at(-1)).toEqual(
				expect.objectContaining({
					message: responseWithoutSentence.trim().substring(0, 120),
				})
			);
		});

		it('logs query stats recording failures after AI exit', async () => {
			const error = new Error('stats db unavailable');
			const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
			window.maestro.stats.recordQuery.mockRejectedValueOnce(error);
			const deps = createMockDeps();
			const session = createMockSession({
				id: 'sess-1',
				state: 'busy',
				busySource: 'ai',
				toolType: 'codex',
				cwd: '/repo/project',
				aiTabs: [
					createMockTab({
						id: 'tab-1',
						state: 'busy',
						thinkingStartTime: Date.now() - 1000,
						logs: [
							{ id: 'user-1', timestamp: 1, source: 'user', text: 'Run stats' },
							{ id: 'ai-1', timestamp: 2, source: 'ai', text: 'Done.' },
						],
					}),
				],
				activeTabId: 'tab-1',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'other-session',
			});

			renderHook(() => useAgentListeners(deps));

			await onExitHandler?.('sess-1-ai-tab-1', 0);
			await flushAsyncWork();

			expect(consoleWarnSpy).toHaveBeenCalledWith(
				'[onProcessExit] Failed to record query stats:',
				error
			);
		});

		it('creates a history synopsis entry for completed saved AI tabs', async () => {
			const spawnBackgroundSynopsis = vi.fn().mockResolvedValue({
				success: true,
				response:
					'**Summary:** Added listener coverage for synopsis branches.\n\n**Details:** Verified the background synopsis handoff and history refresh behavior.',
				usageStats: {
					inputTokens: 10,
					outputTokens: 5,
					totalTokens: 15,
					totalCostUsd: 0.01,
				},
			});
			const addHistoryEntry = vi.fn().mockResolvedValue(undefined);
			const refreshHistoryPanel = vi.fn();
			const deps = createMockDeps({
				spawnBackgroundSynopsisRef: { current: spawnBackgroundSynopsis },
				addHistoryEntryRef: { current: addHistoryEntry },
				rightPanelRef: { current: { refreshHistoryPanel } as any },
			});
			const previousSynopsisTime = Date.now() - 60_000;
			const otherSession = createMockSession({ id: 'other-session' });
			const untouchedTab = createMockTab({
				id: 'tab-2',
				name: 'Untouched Tab',
				lastSynopsisTime: 1234,
			});
			const session = createMockSession({
				id: 'sess-1',
				name: 'Coverage Project',
				toolType: 'codex',
				cwd: '/repo/project',
				state: 'busy',
				busySource: 'ai',
				customModel: 'gpt-5',
				aiTabs: [
					createMockTab({
						id: 'tab-1',
						name: 'Coverage Tab',
						state: 'busy',
						thinkingStartTime: Date.now() - 1200,
						agentSessionId: 'agent-session-1',
						saveToHistory: true,
						lastSynopsisTime: previousSynopsisTime,
						logs: [
							{ id: 'user-1', timestamp: 1, source: 'user', text: 'Save this work' },
							{
								id: 'ai-1',
								timestamp: 2,
								source: 'ai',
								text: 'Implemented the requested coverage branch.',
							},
						],
					}),
					untouchedTab,
				],
				activeTabId: 'tab-1',
			});
			useSessionStore.setState({
				sessions: [otherSession, session],
				activeSessionId: 'other-session',
			});

			renderHook(() => useAgentListeners(deps));

			await onExitHandler?.('sess-1-ai-tab-1', 0);
			await flushAsyncWork();

			expect(spawnBackgroundSynopsis).toHaveBeenCalledWith(
				'sess-1',
				'/repo/project',
				'agent-session-1',
				expect.stringContaining('Only synopsize work done since the last synopsis'),
				'codex',
				expect.objectContaining({ customModel: 'gpt-5' })
			);
			expect(addHistoryEntry).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'USER',
					summary: 'Added listener coverage for synopsis branches.',
					fullResponse:
						'Added listener coverage for synopsis branches.\n\nVerified the background synopsis handoff and history refresh behavior.',
					agentSessionId: 'agent-session-1',
					sessionId: 'sess-1',
					projectPath: '/repo/project',
					sessionName: 'Coverage Tab',
					usageStats: expect.objectContaining({ totalTokens: 15 }),
					elapsedTimeMs: expect.any(Number),
				})
			);
			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1')!;
			expect(updated.aiTabs[0].lastSynopsisTime).toEqual(expect.any(Number));
			expect(updated.aiTabs[0].lastSynopsisTime).not.toBe(previousSynopsisTime);
			expect(updated.aiTabs[1]).toBe(untouchedTab);
			expect(useSessionStore.getState().sessions.find((s) => s.id === 'other-session')).toBe(
				otherSession
			);
			expect(refreshHistoryPanel).toHaveBeenCalled();
		});

		it('creates a synopsis entry without refreshing history when the right panel is absent', async () => {
			const spawnBackgroundSynopsis = vi.fn().mockResolvedValue({
				success: true,
				response:
					'**Summary:** Captured a concise synopsis.\n\n**Details:** Stored without a panel refresh.',
			});
			const addHistoryEntry = vi.fn().mockResolvedValue(undefined);
			const deps = createMockDeps({
				spawnBackgroundSynopsisRef: { current: spawnBackgroundSynopsis },
				addHistoryEntryRef: { current: addHistoryEntry },
				rightPanelRef: { current: null },
			});
			const session = createMockSession({
				id: 'sess-1',
				state: 'busy',
				busySource: 'ai',
				aiTabs: [
					createMockTab({
						id: 'tab-1',
						state: 'busy',
						agentSessionId: 'agent-session-1',
						saveToHistory: true,
						logs: [
							{ id: 'user-1', timestamp: 1, source: 'user', text: 'Save this work' },
							{ id: 'ai-1', timestamp: 2, source: 'ai', text: 'Finished.' },
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

			await onExitHandler?.('sess-1-ai-tab-1', 0);
			await flushAsyncWork();

			expect(addHistoryEntry).toHaveBeenCalledWith(
				expect.objectContaining({
					summary: 'Captured a concise synopsis.',
					fullResponse: 'Captured a concise synopsis.\n\nStored without a panel refresh.',
				})
			);
		});

		it('uses the session provider id for synopsis when the completed tab has no provider id', async () => {
			const spawnBackgroundSynopsis = vi.fn().mockResolvedValue({
				success: true,
				response:
					'**Summary:** Saved via session provider id.\n\n**Details:** Used the session fallback.',
			});
			const addHistoryEntry = vi.fn().mockResolvedValue(undefined);
			const deps = createMockDeps({
				spawnBackgroundSynopsisRef: { current: spawnBackgroundSynopsis },
				addHistoryEntryRef: { current: addHistoryEntry },
			});
			const session = createMockSession({
				id: 'sess-1',
				state: 'busy',
				busySource: 'ai',
				agentSessionId: 'session-level-agent-id',
				pendingAICommandForSynopsis: 'Run saved prompt',
				aiTabs: [
					createMockTab({
						id: 'tab-1',
						state: 'busy',
						agentSessionId: null,
						saveToHistory: false,
						logs: [
							{ id: 'user-1', timestamp: 1, source: 'user', text: 'Run saved prompt' },
							{ id: 'ai-1', timestamp: 2, source: 'ai', text: 'Finished.' },
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

			await onExitHandler?.('sess-1-ai-tab-1', 0);
			await flushAsyncWork();

			expect(spawnBackgroundSynopsis).toHaveBeenCalledWith(
				'sess-1',
				'/test/project',
				'session-level-agent-id',
				expect.any(String),
				'claude-code',
				expect.any(Object)
			);
			expect(addHistoryEntry).toHaveBeenCalledWith(
				expect.objectContaining({ agentSessionId: 'session-level-agent-id' })
			);
		});

		it('skips synopsis when completed tabs are not marked for history', async () => {
			const spawnBackgroundSynopsis = vi.fn();
			const deps = createMockDeps({
				spawnBackgroundSynopsisRef: { current: spawnBackgroundSynopsis },
				addHistoryEntryRef: { current: vi.fn() },
			});
			const session = createMockSession({
				id: 'sess-1',
				state: 'busy',
				busySource: 'ai',
				agentSessionId: 'session-level-agent-id',
				pendingAICommandForSynopsis: undefined,
				aiTabs: [
					createMockTab({
						id: 'tab-1',
						state: 'busy',
						agentSessionId: null,
						saveToHistory: false,
						logs: [
							{ id: 'user-1', timestamp: 1, source: 'user', text: 'Do not save' },
							{ id: 'ai-1', timestamp: 2, source: 'ai', text: 'Finished.' },
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

			await onExitHandler?.('sess-1-ai-tab-1', 0);
			await flushAsyncWork();

			expect(spawnBackgroundSynopsis).not.toHaveBeenCalled();
		});

		it('skips history creation when synopsis returns nothing to report', async () => {
			const spawnBackgroundSynopsis = vi.fn().mockResolvedValue({
				success: true,
				response: 'NOTHING_TO_REPORT',
			});
			const addHistoryEntry = vi.fn();
			const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
			const deps = createMockDeps({
				spawnBackgroundSynopsisRef: { current: spawnBackgroundSynopsis },
				addHistoryEntryRef: { current: addHistoryEntry },
			});
			const session = createMockSession({
				id: 'sess-1',
				state: 'busy',
				busySource: 'ai',
				aiTabs: [
					createMockTab({
						id: 'tab-1',
						state: 'busy',
						agentSessionId: 'agent-session-1',
						saveToHistory: true,
						logs: [
							{ id: 'user-1', timestamp: 1, source: 'user', text: 'Save this work' },
							{ id: 'ai-1', timestamp: 2, source: 'ai', text: 'No material changes.' },
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

			await onExitHandler?.('sess-1-ai-tab-1', 0);
			await flushAsyncWork();

			expect(addHistoryEntry).not.toHaveBeenCalled();
			expect(useSessionStore.getState().sessions[0].aiTabs[0].lastSynopsisTime).toBeUndefined();
			expect(consoleLogSpy).toHaveBeenCalledWith(
				'[onProcessExit] Synopsis returned NOTHING_TO_REPORT - skipping history entry',
				expect.objectContaining({
					sessionId: 'sess-1',
					agentSessionId: 'agent-session-1',
				})
			);
		});

		it('logs failed synopsis generation without creating history', async () => {
			const spawnBackgroundSynopsis = vi.fn().mockResolvedValue({
				success: false,
				response: '',
			});
			const addHistoryEntry = vi.fn();
			const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
			const deps = createMockDeps({
				spawnBackgroundSynopsisRef: { current: spawnBackgroundSynopsis },
				addHistoryEntryRef: { current: addHistoryEntry },
			});
			const session = createMockSession({
				id: 'sess-1',
				state: 'busy',
				busySource: 'ai',
				aiTabs: [
					createMockTab({
						id: 'tab-1',
						state: 'busy',
						agentSessionId: 'agent-session-1',
						saveToHistory: true,
						logs: [
							{ id: 'user-1', timestamp: 1, source: 'user', text: 'Save this work' },
							{ id: 'ai-1', timestamp: 2, source: 'ai', text: 'Finished.' },
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

			await onExitHandler?.('sess-1-ai-tab-1', 0);
			await flushAsyncWork();

			expect(addHistoryEntry).not.toHaveBeenCalled();
			expect(consoleWarnSpy).toHaveBeenCalledWith(
				'[onProcessExit] Synopsis generation failed - no history entry created',
				expect.objectContaining({
					sessionId: 'sess-1',
					agentSessionId: 'agent-session-1',
					hasResponse: false,
				})
			);
		});

		it('skips synopsis history when generation succeeds without a response', async () => {
			const spawnBackgroundSynopsis = vi.fn().mockResolvedValue({
				success: true,
				response: '',
			});
			const addHistoryEntry = vi.fn();
			const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
			const deps = createMockDeps({
				spawnBackgroundSynopsisRef: { current: spawnBackgroundSynopsis },
				addHistoryEntryRef: { current: addHistoryEntry },
			});
			const session = createMockSession({
				id: 'sess-1',
				state: 'busy',
				busySource: 'ai',
				aiTabs: [
					createMockTab({
						id: 'tab-1',
						state: 'busy',
						agentSessionId: 'agent-session-1',
						saveToHistory: true,
						logs: [
							{ id: 'user-1', timestamp: 1, source: 'user', text: 'Save this work' },
							{ id: 'ai-1', timestamp: 2, source: 'ai', text: 'Finished.' },
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

			await onExitHandler?.('sess-1-ai-tab-1', 0);
			await flushAsyncWork();

			expect(addHistoryEntry).not.toHaveBeenCalled();
			expect(consoleWarnSpy).not.toHaveBeenCalledWith(
				'[onProcessExit] Synopsis generation failed - no history entry created',
				expect.anything()
			);
		});

		it('logs rejected synopsis generation without creating history', async () => {
			const error = new Error('synopsis process failed');
			const spawnBackgroundSynopsis = vi.fn().mockRejectedValue(error);
			const addHistoryEntry = vi.fn();
			const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
			const deps = createMockDeps({
				spawnBackgroundSynopsisRef: { current: spawnBackgroundSynopsis },
				addHistoryEntryRef: { current: addHistoryEntry },
			});
			const session = createMockSession({
				id: 'sess-1',
				state: 'busy',
				busySource: 'ai',
				aiTabs: [
					createMockTab({
						id: 'tab-1',
						state: 'busy',
						agentSessionId: 'agent-session-1',
						saveToHistory: true,
						logs: [
							{ id: 'user-1', timestamp: 1, source: 'user', text: 'Save this work' },
							{ id: 'ai-1', timestamp: 2, source: 'ai', text: 'Finished.' },
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

			await onExitHandler?.('sess-1-ai-tab-1', 0);
			await flushAsyncWork();

			expect(addHistoryEntry).not.toHaveBeenCalled();
			expect(consoleErrorSpy).toHaveBeenCalledWith('[onProcessExit] Synopsis failed:', error);
		});

		it('refreshes git refs after terminal git commands with the session SSH remote', async () => {
			const getBranchesSpy = vi
				.spyOn(gitService, 'getBranches')
				.mockResolvedValue(['main', 'feature/ref-refresh']);
			const getTagsSpy = vi.spyOn(gitService, 'getTags').mockResolvedValue(['v2.0.0']);
			const deps = createMockDeps();
			const otherSession = createMockSession({ id: 'other-session' });
			const session = createMockSession({
				id: 'sess-1',
				cwd: '/repo/project',
				state: 'busy',
				busySource: 'terminal',
				isGitRepo: true,
				sshRemoteId: 'remote-1',
				shellLogs: [
					{
						id: 'cmd-1',
						timestamp: 1,
						source: 'user',
						text: 'git fetch origin',
					},
				],
			});
			useSessionStore.setState({
				sessions: [otherSession, session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			await onExitHandler?.('sess-1-terminal', 0);
			await flushAsyncWork();

			expect(getBranchesSpy).toHaveBeenCalledWith('/repo/project', 'remote-1');
			expect(getTagsSpy).toHaveBeenCalledWith('/repo/project', 'remote-1');
			const refreshed = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			expect(refreshed?.gitBranches).toEqual(['main', 'feature/ref-refresh']);
			expect(refreshed?.gitTags).toEqual(['v2.0.0']);
			expect(refreshed?.gitRefsCacheTime).toEqual(expect.any(Number));
			expect(useSessionStore.getState().sessions.find((s) => s.id === 'other-session')).toBe(
				otherSession
			);
		});

		it('refreshes git refs with session SSH remote config when no remote id is set', async () => {
			const getBranchesSpy = vi.spyOn(gitService, 'getBranches').mockResolvedValue(['main']);
			const getTagsSpy = vi.spyOn(gitService, 'getTags').mockResolvedValue(['v3.0.0']);
			const deps = createMockDeps();
			const session = createMockSession({
				id: 'sess-1',
				cwd: '/repo/project',
				state: 'busy',
				busySource: 'terminal',
				isGitRepo: true,
				sshRemoteId: undefined,
				sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-config-1' } as any,
				shellLogs: [
					{
						id: 'cmd-1',
						timestamp: 1,
						source: 'user',
						text: 'git branch --all',
					},
				],
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			await onExitHandler?.('sess-1-terminal', 0);
			await flushAsyncWork();

			expect(getBranchesSpy).toHaveBeenCalledWith('/repo/project', 'remote-config-1');
			expect(getTagsSpy).toHaveBeenCalledWith('/repo/project', 'remote-config-1');
		});

		it('refreshes local git refs with an undefined remote id when no SSH remote is configured', async () => {
			const getBranchesSpy = vi.spyOn(gitService, 'getBranches').mockResolvedValue(['main']);
			const getTagsSpy = vi.spyOn(gitService, 'getTags').mockResolvedValue(['v1.0.0']);
			const deps = createMockDeps();
			const session = createMockSession({
				id: 'sess-1',
				cwd: '/repo/project',
				state: 'busy',
				busySource: 'terminal',
				isGitRepo: true,
				sshRemoteId: undefined,
				sessionSshRemoteConfig: undefined,
				shellLogs: [
					{
						id: 'cmd-1',
						timestamp: 1,
						source: 'user',
						text: 'git tag --list',
					},
				],
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			await onExitHandler?.('sess-1-terminal', 0);
			await flushAsyncWork();

			expect(getBranchesSpy).toHaveBeenCalledWith('/repo/project', undefined);
			expect(getTagsSpy).toHaveBeenCalledWith('/repo/project', undefined);
		});

		it('does not refresh git refs after non-git terminal commands', async () => {
			const getBranchesSpy = vi.spyOn(gitService, 'getBranches');
			const getTagsSpy = vi.spyOn(gitService, 'getTags');
			const deps = createMockDeps();
			const session = createMockSession({
				id: 'sess-1',
				state: 'busy',
				busySource: 'terminal',
				isGitRepo: true,
				shellLogs: [
					{
						id: 'cmd-1',
						timestamp: 1,
						source: 'user',
						text: 'npm test',
					},
				],
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			await onExitHandler?.('sess-1-terminal', 0);
			await flushAsyncWork();

			expect(getBranchesSpy).not.toHaveBeenCalled();
			expect(getTagsSpy).not.toHaveBeenCalled();
			expect(useSessionStore.getState().sessions[0].gitRefsCacheTime).toBeUndefined();
		});

		it('does not refresh git refs for terminal commands in non-git sessions', async () => {
			const getBranchesSpy = vi.spyOn(gitService, 'getBranches');
			const getTagsSpy = vi.spyOn(gitService, 'getTags');
			const deps = createMockDeps();
			const session = createMockSession({
				id: 'sess-1',
				state: 'busy',
				busySource: 'terminal',
				isGitRepo: false,
				shellLogs: [
					{
						id: 'cmd-1',
						timestamp: 1,
						source: 'user',
						text: 'git fetch origin',
					},
				],
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			await onExitHandler?.('sess-1-terminal', 0);
			await flushAsyncWork();

			expect(getBranchesSpy).not.toHaveBeenCalled();
			expect(getTagsSpy).not.toHaveBeenCalled();
		});

		it('keeps terminal sessions busy when an AI tab is still busy', async () => {
			const deps = createMockDeps();
			const session = createMockSession({
				id: 'sess-1',
				state: 'busy',
				busySource: 'ai',
				aiTabs: [createMockTab({ id: 'tab-1', state: 'busy' })],
				shellLogs: [],
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-1',
			});

			renderHook(() => useAgentListeners(deps));

			await onExitHandler?.('sess-1-terminal', 1);

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			expect(updated?.state).toBe('busy');
			expect(updated?.busySource).toBe('ai');
			expect(updated?.shellLogs.at(-1)).toEqual(
				expect.objectContaining({
					source: 'system',
					text: 'Terminal process exited with code 1',
				})
			);
		});

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
