import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	getErrorTitleForType,
	type BatchedUpdater,
	type UseAgentListenersDeps,
	loadAgentListenersPrompts,
	useAgentListeners,
} from '../../renderer/hooks/agent/useAgentListeners';
import { useGroupChatStore } from '../../renderer/stores/groupChatStore';
import { useModalStore } from '../../renderer/stores/modalStore';
import { useNotificationStore } from '../../renderer/stores/notificationStore';
import { useSessionStore } from '../../renderer/stores/sessionStore';
import { gitService } from '../../renderer/services/git';
import type { AgentError, AITab, QueuedItem, Session, UsageStats } from '../../renderer/types';

type ListenerCallback = (...args: any[]) => any;

const listeners: Record<string, ListenerCallback | undefined> = {};
const unsubscribeFns = {
	data: vi.fn(),
	exit: vi.fn(),
	sessionId: vi.fn(),
	slashCommands: vi.fn(),
	stderr: vi.fn(),
	commandExit: vi.fn(),
	usage: vi.fn(),
	agentError: vi.fn(),
	thinkingChunk: vi.fn(),
	sshRemote: vi.fn(),
	toolExecution: vi.fn(),
};

function createTab(overrides: Partial<AITab> = {}): AITab {
	return {
		id: 'tab-1',
		agentSessionId: null,
		name: null,
		starred: false,
		logs: [],
		inputValue: '',
		stagedImages: [],
		createdAt: 1700000000000,
		state: 'idle',
		saveToHistory: true,
		...overrides,
	};
}

function createSession(overrides: Partial<Session> = {}): Session {
	const tab = createTab();
	return {
		id: 'session-1',
		name: 'Integration Project',
		toolType: 'claude-code',
		state: 'idle',
		cwd: '/repo/integration-project',
		fullPath: '/repo/integration-project',
		projectRoot: '/repo/integration-project',
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
		isGitRepo: false,
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		aiTabs: overrides.aiTabs ?? [tab],
		activeTabId: overrides.activeTabId ?? tab.id,
		closedTabHistory: [],
		executionQueue: [],
		activeTimeMs: 0,
		filePreviewTabs: [],
		activeFileTabId: null,
		unifiedTabOrder: [{ type: 'ai', id: tab.id }],
		unifiedClosedTabHistory: [],
		...overrides,
	} as Session;
}

function createBatchedUpdater(): BatchedUpdater {
	return {
		appendLog: vi.fn(),
		markDelivered: vi.fn(),
		markUnread: vi.fn(),
		updateUsage: vi.fn(),
		updateContextUsage: vi.fn(),
		updateCycleBytes: vi.fn(),
		updateCycleTokens: vi.fn(),
		flushNow: vi.fn(),
	};
}

function createDeps(overrides: Partial<UseAgentListenersDeps> = {}): UseAgentListenersDeps {
	return {
		batchedUpdater: createBatchedUpdater(),
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

function installProcessBridge() {
	const processBridge = {
		onData: vi.fn((handler: ListenerCallback) => {
			listeners.data = handler;
			return unsubscribeFns.data;
		}),
		onExit: vi.fn((handler: ListenerCallback) => {
			listeners.exit = handler;
			return unsubscribeFns.exit;
		}),
		onSessionId: vi.fn((handler: ListenerCallback) => {
			listeners.sessionId = handler;
			return unsubscribeFns.sessionId;
		}),
		onSlashCommands: vi.fn((handler: ListenerCallback) => {
			listeners.slashCommands = handler;
			return unsubscribeFns.slashCommands;
		}),
		onStderr: vi.fn((handler: ListenerCallback) => {
			listeners.stderr = handler;
			return unsubscribeFns.stderr;
		}),
		onCommandExit: vi.fn((handler: ListenerCallback) => {
			listeners.commandExit = handler;
			return unsubscribeFns.commandExit;
		}),
		onUsage: vi.fn((handler: ListenerCallback) => {
			listeners.usage = handler;
			return unsubscribeFns.usage;
		}),
		onAgentError: vi.fn((handler: ListenerCallback) => {
			listeners.agentError = handler;
			return unsubscribeFns.agentError;
		}),
		onThinkingChunk: vi.fn((handler: ListenerCallback) => {
			listeners.thinkingChunk = handler;
			return unsubscribeFns.thinkingChunk;
		}),
		onSshRemote: vi.fn((handler: ListenerCallback) => {
			listeners.sshRemote = handler;
			return unsubscribeFns.sshRemote;
		}),
		onToolExecution: vi.fn((handler: ListenerCallback) => {
			listeners.toolExecution = handler;
			return unsubscribeFns.toolExecution;
		}),
		getActiveProcesses: vi.fn().mockResolvedValue([]),
	};

	(window.maestro as any).process = processBridge;
	(window.maestro as any).agentError = {
		clearError: vi.fn().mockResolvedValue(undefined),
	};
	window.maestro.agentSessions.registerSessionOrigin = vi.fn().mockResolvedValue(undefined);
	window.maestro.stats.recordQuery = vi.fn().mockResolvedValue(undefined);
	window.maestro.logger.log = vi.fn();
	(window.maestro as any).prompts = {
		get: vi.fn().mockResolvedValue({
			success: true,
			content: 'Write a concise synopsis of the completed work.',
		}),
	};
	window.maestro.git.isRepo = vi.fn().mockResolvedValue(true);
	window.maestro.git.branches = vi.fn().mockResolvedValue({ branches: ['main', 'feature'] });
	(window.maestro.git as any).tags = vi.fn().mockResolvedValue({ tags: ['v1.0.0'] });

	return processBridge;
}

function installAnimationFrame() {
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

async function flushMicrotasks() {
	await Promise.resolve();
	await Promise.resolve();
}

describe('useAgentListeners integration', () => {
	beforeEach(async () => {
		vi.useRealTimers();
		vi.clearAllMocks();
		for (const key of Object.keys(listeners)) {
			listeners[key] = undefined;
		}

		useSessionStore.setState({
			sessions: [],
			groups: [{ id: 'group-1', name: 'Integration Group', collapsed: false }],
			activeSessionId: '',
			initialLoadComplete: true,
			removedWorktreePaths: new Set(),
		});
		useModalStore.getState().closeAll();
		useNotificationStore.getState().clearToasts();
		useGroupChatStore.setState({
			groupChatError: null,
			groupChatMessages: [],
			groupChatState: 'idle',
			groupChatStates: new Map(),
		});

		installProcessBridge();
		await loadAgentListenersPrompts(true);
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('registers process listeners and removes them on unmount', () => {
		const processBridge = (window.maestro as any).process;
		const deps = createDeps();

		const { unmount, rerender } = renderHook(() => useAgentListeners(deps));
		rerender();
		unmount();

		expect(processBridge.onData).toHaveBeenCalledTimes(1);
		expect(processBridge.onExit).toHaveBeenCalledTimes(1);
		expect(processBridge.onAgentError).toHaveBeenCalledTimes(1);
		expect(processBridge.onToolExecution).toHaveBeenCalledTimes(1);
		expect(unsubscribeFns.data).toHaveBeenCalledTimes(1);
		expect(unsubscribeFns.exit).toHaveBeenCalledTimes(1);
		expect(unsubscribeFns.toolExecution).toHaveBeenCalledTimes(1);
		expect(getErrorTitleForType('permission_denied')).toBe('Permission Denied');
		expect(getErrorTitleForType('auth_expired')).toBe('Authentication Required');
		expect(getErrorTitleForType('token_exhaustion')).toBe('Context Limit Reached');
		expect(getErrorTitleForType('rate_limited')).toBe('Rate Limit Exceeded');
		expect(getErrorTitleForType('agent_crashed')).toBe('Agent Error');
		expect(getErrorTitleForType('session_not_found')).toBe('Session Not Found');
		expect(getErrorTitleForType('unknown_type' as any)).toBe('Error');
	});

	it('routes stdout, stderr, usage, session-id, slash-command, and command-exit events through real stores', async () => {
		const deps = createDeps();
		const session = createSession({
			id: 'session-1',
			state: 'busy',
			contextUsage: 60,
			aiTabs: [
				createTab({ id: 'tab-active', state: 'idle' }),
				createTab({
					id: 'tab-work',
					state: 'busy',
					agentSessionId: 'stale-provider-session',
					awaitingSessionId: false,
					isAtBottom: false,
				}),
			],
			activeTabId: 'tab-active',
			shellLogs: [{ id: 'cmd', timestamp: 1, source: 'user', text: 'npm test' }],
		});
		useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

		renderHook(() => useAgentListeners(deps));

		await act(async () => {
			listeners.data?.('session-1-ai-tab-work', 'assistant output');
			listeners.data?.('session-1', 'terminal output');
			listeners.stderr?.('session-1-ai-tab-work', 'agent stderr');
			listeners.stderr?.('session-1', 'terminal stderr');
			listeners.usage?.('session-1-ai-tab-work', {
				inputTokens: 100,
				outputTokens: 50,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
				totalCostUsd: 0.001,
				contextWindow: 200000,
			} satisfies UsageStats);
			listeners.sessionId?.('session-1-ai-tab-work', 'new-provider-session');
			listeners.slashCommands?.('session-1-ai', ['help', '/status']);
			listeners.commandExit?.('session-1', 2);
			await flushMicrotasks();
		});

		const updated = useSessionStore.getState().sessions[0];
		const workTab = updated.aiTabs.find((tab) => tab.id === 'tab-work');
		expect(deps.batchedUpdater.appendLog).toHaveBeenCalledWith(
			'session-1',
			'tab-work',
			true,
			'assistant output'
		);
		expect(deps.batchedUpdater.appendLog).toHaveBeenCalledWith(
			'session-1',
			null,
			false,
			'terminal output'
		);
		expect(deps.batchedUpdater.appendLog).toHaveBeenCalledWith(
			'session-1',
			'tab-work',
			true,
			'agent stderr',
			true
		);
		expect(deps.batchedUpdater.markUnread).toHaveBeenCalledWith('session-1', 'tab-work', true);
		expect(deps.batchedUpdater.updateUsage).toHaveBeenCalledWith(
			'session-1',
			'tab-work',
			expect.objectContaining({ outputTokens: 50 })
		);
		expect(deps.batchedUpdater.updateCycleTokens).toHaveBeenCalledWith('session-1', 50);
		expect(deps.batchedUpdater.updateContextUsage).toHaveBeenCalledWith('session-1', 0);
		expect(workTab?.agentSessionId).toBe('stale-provider-session');
		expect(workTab?.awaitingSessionId).toBe(false);
		expect(workTab?.usageStats).toBeUndefined();
		expect(workTab?.logs.at(-1)?.text).toBeUndefined();
		expect(updated.agentCommands?.map((command) => command.command)).toEqual(['/help', '/status']);
		expect(updated.shellLogs.at(-1)?.text).toBe('Command exited with code 2');
		expect(window.maestro.agentSessions.registerSessionOrigin).toHaveBeenCalledWith(
			'/repo/integration-project',
			'new-provider-session',
			'user'
		);
	});

	it('routes provider session ids through awaiting tabs and session-level fallbacks', async () => {
		const deps = createDeps();
		const awaitingTab = createTab({ id: 'tab-awaiting', awaitingSessionId: true });
		const idleTab = createTab({ id: 'tab-idle', name: 'New Session' });
		const session = createSession({
			id: 'session-await',
			toolType: 'codex',
			aiTabs: [idleTab, awaitingTab],
			activeTabId: 'tab-idle',
		});
		const emptySession = createSession({
			id: 'session-empty',
			toolType: 'codex',
			aiTabs: [],
			activeTabId: undefined,
		});
		useSessionStore.setState({
			sessions: [session, emptySession, createSession({ id: 'other-session' })],
			activeSessionId: 'session-await',
		});
		vi.mocked(window.maestro.agentSessions.registerSessionOrigin).mockRejectedValueOnce(
			new Error('origin failed')
		);

		renderHook(() => useAgentListeners(deps));

		await act(async () => {
			await listeners.sessionId?.('session-await-batch-1', 'ignored-provider-session');
			await listeners.sessionId?.('missing-session-ai', 'missing-provider-session');
			await listeners.sessionId?.('session-await-ai', 'await-provider-session');
			await listeners.sessionId?.('session-empty-ai', 'empty-provider-session');
			await flushMicrotasks();
		});

		const [updatedSession, updatedEmptySession, updatedOtherSession] =
			useSessionStore.getState().sessions;
		expect(updatedSession.agentSessionId).toBe('await-provider-session');
		expect(updatedSession.aiTabs.find((tab) => tab.id === 'tab-awaiting')).toMatchObject({
			agentSessionId: 'await-provider-session',
			awaitingSessionId: false,
		});
		expect(updatedEmptySession.agentSessionId).toBe('empty-provider-session');
		expect(updatedOtherSession.agentSessionId).toBeUndefined();
		expect(window.maestro.agentSessions.registerSessionOrigin).toHaveBeenCalledTimes(2);
		expect(window.maestro.logger.log).toHaveBeenCalledWith(
			'error',
			'[onSessionId] No target tab found - session has no aiTabs, storing at session level only',
			undefined,
			undefined
		);
		expect(window.maestro.logger.log).toHaveBeenCalledWith(
			'error',
			'[onSessionId] Failed to register session origin:',
			undefined,
			expect.any(Error)
		);
	});

	it('handles guard data paths, recovered agent errors, and terminal git refresh exits', async () => {
		const deps = createDeps();
		const processBridge = (window.maestro as any).process;
		const error: AgentError = {
			type: 'agent_crashed',
			message: 'Provider crashed',
			recoverable: true,
			agentId: 'claude-code',
			sessionId: 'provider-session',
			timestamp: 1700000000000,
		};
		const session = createSession({
			id: 'session-guard',
			state: 'error',
			agentError: error,
			agentErrorTabId: 'tab-1',
			agentErrorPaused: true,
			isGitRepo: true,
			shellLogs: [{ id: 'cmd', timestamp: 1, source: 'user', text: 'git fetch origin' }],
			aiTabs: [createTab({ id: 'tab-1', agentError: error })],
			activeTabId: 'tab-1',
		});
		useSessionStore.setState({
			sessions: [session, createSession({ id: 'other-session' })],
			activeSessionId: 'session-guard',
		});
		vi.mocked(window.maestro.agentError.clearError).mockRejectedValueOnce(
			new Error('clear failed')
		);

		renderHook(() => useAgentListeners(deps));

		await act(async () => {
			listeners.data?.('session-guard-terminal', 'terminal data ignored by onData');
			listeners.data?.('session-guard-batch-1', 'batch data ignored by onData');
			listeners.data?.('session-guard', '   ');
			listeners.data?.('session-guard-ai-tab-1', 'recovered output');
			await flushMicrotasks();
		});

		let updated = useSessionStore.getState().sessions[0];
		expect(deps.batchedUpdater.appendLog).toHaveBeenCalledTimes(1);
		expect(updated.agentError).toBeUndefined();
		expect(updated.agentErrorPaused).toBe(false);
		expect(updated.aiTabs[0].agentError).toBeUndefined();
		expect(window.maestro.logger.log).toHaveBeenCalledWith(
			'error',
			'Failed to clear agent error on successful data:',
			undefined,
			expect.any(Error)
		);

		useSessionStore.setState({
			sessions: [createSession({ id: 'emptySession', aiTabs: [], activeTabId: undefined })],
			activeSessionId: 'emptySession',
		});
		useSessionStore.setState({ sessions: [updated], activeSessionId: 'session-guard' });
		processBridge.getActiveProcesses.mockResolvedValueOnce([
			{ sessionId: 'session-guard-ai-tab-1' },
		]);

		await act(async () => {
			await listeners.exit?.('session-guard-ai-tab-1', 0);
		});

		expect(window.maestro.logger.log).toHaveBeenCalledWith(
			'warn',
			'[onExit] Process still running despite exit event, ignoring:',
			undefined,
			expect.objectContaining({ sessionId: 'session-guard-ai-tab-1' })
		);

		processBridge.getActiveProcesses.mockResolvedValueOnce([]);
		await act(async () => {
			await listeners.exit?.('session-guard-terminal', 0);
			await flushMicrotasks();
		});

		updated = useSessionStore.getState().sessions[0];
		expect(updated.shellLogs.at(-1)?.text).toBe('Terminal process exited with code 0');
		expect(window.maestro.git.branches).toHaveBeenCalledWith(
			'/repo/integration-project',
			undefined
		);
		expect((window.maestro.git as any).tags).toHaveBeenCalledWith(
			'/repo/integration-project',
			undefined
		);
		expect(updated.gitBranches).toEqual(['main', 'feature']);
		expect(updated.gitTags).toEqual(['v1.0.0']);
	});

	it('hands off queued execution items when an AI tab exits', async () => {
		vi.useFakeTimers();
		const processQueuedItem = vi.fn().mockResolvedValue(undefined);
		const deps = createDeps({
			processQueuedItemRef: { current: processQueuedItem },
		});
		const queuedItem: QueuedItem = {
			id: 'queued-1',
			timestamp: 1700000000000,
			tabId: 'tab-queued',
			type: 'message',
			text: 'Run queued work',
			images: ['image-data'],
		};
		const session = createSession({
			id: 'session-queue',
			state: 'busy',
			busySource: 'ai',
			executionQueue: [queuedItem],
			aiTabs: [
				createTab({ id: 'tab-finished', state: 'busy', thinkingStartTime: 1700000000000 }),
				createTab({ id: 'tab-queued', state: 'idle' }),
				createTab({ id: 'tab-spectator', state: 'idle' }),
			],
			activeTabId: 'tab-finished',
		});
		useSessionStore.setState({ sessions: [session], activeSessionId: 'session-queue' });

		renderHook(() => useAgentListeners(deps));

		await act(async () => {
			await listeners.exit?.('session-queue-ai-tab-finished', 0);
			vi.runOnlyPendingTimers();
			await flushMicrotasks();
		});

		const updated = useSessionStore.getState().sessions[0];
		const finishedTab = updated.aiTabs.find((tab) => tab.id === 'tab-finished');
		const queuedTab = updated.aiTabs.find((tab) => tab.id === 'tab-queued');
		const spectatorTab = updated.aiTabs.find((tab) => tab.id === 'tab-spectator');
		expect(updated).toMatchObject({
			state: 'busy',
			busySource: 'ai',
			executionQueue: [],
			currentCycleTokens: 0,
			currentCycleBytes: 0,
		});
		expect(finishedTab?.state).toBe('idle');
		expect(queuedTab).toMatchObject({ state: 'busy' });
		expect(spectatorTab).toMatchObject({ state: 'idle', logs: [] });
		expect(queuedTab?.logs.at(-1)).toMatchObject({
			source: 'user',
			text: 'Run queued work',
			images: ['image-data'],
		});
		expect(processQueuedItem).toHaveBeenCalledWith('session-queue', queuedItem);
	});

	it('handles agent errors across session, Auto Run, and group-chat workflows', () => {
		const pauseBatchOnError = vi.fn();
		const addHistoryEntry = vi.fn();
		const deps = createDeps({
			addHistoryEntryRef: { current: addHistoryEntry },
			getBatchStateRef: {
				current: () =>
					({
						isRunning: true,
						errorPaused: false,
						currentDocumentIndex: 1,
						documents: ['intro.md', 'implementation.md'],
					}) as any,
			},
			pauseBatchOnErrorRef: { current: pauseBatchOnError },
		});
		const error: AgentError = {
			type: 'network_error',
			message: 'Network unavailable',
			recoverable: true,
			agentId: 'claude-code',
			sessionId: 'provider-session',
			timestamp: 1700000000000,
		};
		const session = createSession({
			id: 'session-1',
			state: 'busy',
			aiTabs: [createTab({ id: 'tab-1' })],
			activeTabId: 'tab-1',
		});
		useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });
		useGroupChatStore.setState({
			groupChatState: 'working',
			groupChatStates: new Map([['12345678-1234-1234-1234-123456789012', 'working']]),
		});

		renderHook(() => useAgentListeners(deps));

		act(() => {
			listeners.agentError?.('session-1-ai-tab-1', error);
			listeners.agentError?.(
				'group-chat-12345678-1234-1234-1234-123456789012-moderator-1700000000000',
				{ ...error, message: 'Moderator failed' }
			);
		});

		const updated = useSessionStore.getState().sessions[0];
		expect(updated.state).toBe('error');
		expect(updated.agentError).toEqual(error);
		expect(updated.agentErrorPaused).toBe(true);
		expect(updated.aiTabs[0].logs.at(-1)).toEqual(
			expect.objectContaining({ source: 'error', text: 'Network unavailable' })
		);
		expect(useModalStore.getState().isOpen('agentError')).toBe(true);
		expect(pauseBatchOnError).toHaveBeenCalledWith(
			'session-1',
			error,
			1,
			'Processing implementation.md'
		);
		expect(addHistoryEntry).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'AUTO',
				summary: 'Auto Run error: Connection Error (implementation.md)',
				fullResponse: expect.stringContaining('- Check your internet connection and try again'),
			})
		);
		expect(useNotificationStore.getState().toasts.at(-1)).toEqual(
			expect.objectContaining({ type: 'error', title: 'Auto Run: Connection Error' })
		);
		expect(useGroupChatStore.getState().groupChatError).toEqual(
			expect.objectContaining({ participantName: 'Moderator' })
		);
		expect(useGroupChatStore.getState().groupChatState).toBe('idle');
	});

	it('finalizes AI exits, records stats, and writes synopsis history through callback refs', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-03-04T05:06:07Z'));
		const addHistoryEntry = vi.fn().mockResolvedValue(undefined);
		const refreshHistoryPanel = vi.fn();
		const spawnBackgroundSynopsis = vi.fn().mockResolvedValue({
			success: true,
			response:
				'**Summary:** Implemented listener integration coverage.\n**Details:** Exercised exit, stats, and synopsis callbacks.',
			usageStats: {
				inputTokens: 10,
				outputTokens: 5,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
				totalCostUsd: 0.0001,
				contextWindow: 200000,
			},
		});
		const deps = createDeps({
			addHistoryEntryRef: { current: addHistoryEntry },
			spawnBackgroundSynopsisRef: { current: spawnBackgroundSynopsis },
			rightPanelRef: { current: { refreshHistoryPanel } as any },
			getBatchStateRef: { current: () => ({ isRunning: false }) as any },
		});
		const session = createSession({
			id: 'session-1',
			groupId: 'group-1',
			state: 'busy',
			busySource: 'ai',
			thinkingStartTime: Date.now() - 5000,
			agentSessionId: 'provider-session',
			usageStats: {
				inputTokens: 100,
				outputTokens: 20,
				cacheReadInputTokens: 5,
				cacheCreationInputTokens: 2,
				totalCostUsd: 0.002,
				contextWindow: 200000,
			},
			aiTabs: [
				createTab({
					id: 'tab-1',
					state: 'busy',
					agentSessionId: 'provider-session',
					saveToHistory: true,
					thinkingStartTime: Date.now() - 5000,
					logs: [
						{ id: 'user', timestamp: 1, source: 'user', text: 'Add integration tests' },
						{
							id: 'ai',
							timestamp: 2,
							source: 'stdout',
							text: 'Implemented the listener suite successfully.',
						},
					],
				}),
			],
			activeTabId: 'tab-1',
		});
		useSessionStore.setState({ sessions: [session], activeSessionId: 'other-session' });

		renderHook(() => useAgentListeners(deps));

		await act(async () => {
			await listeners.exit?.('session-1-ai-tab-1', 0);
			await flushMicrotasks();
			vi.runOnlyPendingTimers();
			await flushMicrotasks();
		});

		const updated = useSessionStore.getState().sessions[0];
		expect(updated.state).toBe('idle');
		expect(updated.busySource).toBeUndefined();
		expect(updated.aiTabs[0].state).toBe('idle');
		expect(window.maestro.stats.recordQuery).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: 'session-1',
				agentType: 'claude-code',
				source: 'user',
				tabId: 'tab-1',
			})
		);
		expect(window.maestro.logger.log).toHaveBeenCalledWith(
			'info',
			'Agent process completed',
			'App',
			expect.objectContaining({ agentSessionId: 'provider-session' })
		);
		expect(spawnBackgroundSynopsis).toHaveBeenCalledWith(
			'session-1',
			'/repo/integration-project',
			'provider-session',
			expect.stringContaining('synopsis'),
			'claude-code',
			expect.objectContaining({ customPath: undefined })
		);
		expect(addHistoryEntry).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'USER',
				summary: 'Implemented listener integration coverage.',
				agentSessionId: 'provider-session',
				sessionId: 'session-1',
			})
		);
		expect(refreshHistoryPanel).toHaveBeenCalledTimes(1);
	});

	it('processes thinking chunks, tool events, and SSH remote metadata into the session store', async () => {
		const restoreAnimationFrame = installAnimationFrame();
		const deps = createDeps();
		const session = createSession({
			id: 'session-1',
			cwd: '/repo/integration-project',
			sessionSshRemoteConfig: {
				enabled: true,
				remoteId: 'remote-1',
				workingDirOverride: '/remote/repo',
			},
			aiTabs: [createTab({ id: 'tab-1', showThinking: 'on' as any })],
			activeTabId: 'tab-1',
			isGitRepo: false,
		});
		useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

		try {
			renderHook(() => useAgentListeners(deps));

			await act(async () => {
				listeners.thinkingChunk?.('session-1-ai-tab-1', 'Thinking ');
				listeners.thinkingChunk?.('session-1-ai-tab-1', 'hard.');
				vi.runOnlyPendingTimers();
				listeners.toolExecution?.('session-1-ai-tab-1', {
					toolName: 'Read',
					state: { status: 'completed' },
					timestamp: Date.now(),
				});
				listeners.sshRemote?.('session-1-ai-tab-1', {
					id: 'remote-1',
					name: 'Remote Dev',
					host: 'dev.example.test',
				});
				await flushMicrotasks();
			});

			const updated = useSessionStore.getState().sessions[0];
			expect(updated.sshRemote).toEqual({
				id: 'remote-1',
				name: 'Remote Dev',
				host: 'dev.example.test',
			});
			expect(updated.isGitRepo).toBe(true);
			expect(updated.gitBranches).toEqual(['main', 'feature']);
			expect(updated.gitTags).toEqual(['v1.0.0']);
			expect(updated.aiTabs[0].logs).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ source: 'thinking', text: 'Thinking hard.' }),
					expect.objectContaining({
						source: 'tool',
						text: 'Read',
						metadata: { toolState: { status: 'completed' } },
					}),
				])
			);
		} finally {
			restoreAnimationFrame();
		}
	});

	it('handles thinking chunk guard paths, malformed chunks, and SSH remote id variants', async () => {
		const restoreAnimationFrame = installAnimationFrame();
		const deps = createDeps();
		const thinkingLog = {
			id: 'thinking-1',
			timestamp: 1700000000000,
			source: 'thinking' as const,
			text: 'TaskGrep',
		};
		const session = createSession({
			id: 'session-1',
			sshRemote: { id: 'remote-1', name: 'Remote Dev', host: 'dev.example.test' },
			sshRemoteId: 'remote-1',
			isGitRepo: true,
			aiTabs: [
				createTab({ id: 'tab-1', showThinking: 'on' as any, logs: [thinkingLog] }),
				createTab({ id: 'tab-2', showThinking: 'off' as any }),
			],
			activeTabId: 'tab-1',
		});
		const terminalSession = createSession({
			id: 'session-2',
			sshRemote: { id: 'remote-2', name: 'Terminal Remote', host: 'term.example.test' },
			sshRemoteId: 'remote-2',
			aiTabs: [createTab({ id: 'tab-a' })],
			activeTabId: 'tab-a',
		});
		useSessionStore.setState({
			sessions: [session, terminalSession],
			activeSessionId: 'session-1',
		});

		try {
			renderHook(() => useAgentListeners(deps));

			await act(async () => {
				listeners.thinkingChunk?.('plain-session', 'ignored');
				listeners.thinkingChunk?.('session-1-ai-missing', 'missing target');
				listeners.thinkingChunk?.('session-1-ai-tab-2', 'hidden thinking');
				vi.runOnlyPendingTimers();
				await flushMicrotasks();
			});

			let [updatedSession, updatedTerminalSession] = useSessionStore.getState().sessions;
			expect(updatedSession.aiTabs[0].logs).toEqual([thinkingLog]);
			expect(updatedSession.aiTabs[1].logs).toEqual([]);

			await act(async () => {
				listeners.thinkingChunk?.('session-1-ai-tab-1', 'Read');
				vi.runOnlyPendingTimers();
				await flushMicrotasks();
			});

			updatedSession = useSessionStore.getState().sessions[0];
			expect(updatedSession.aiTabs[0].logs.at(-1)).toEqual(
				expect.objectContaining({ source: 'thinking', text: 'Read' })
			);

			await act(async () => {
				listeners.thinkingChunk?.('session-1-ai-tab-1', 'TaskGrepRead');
				vi.runOnlyPendingTimers();
				listeners.toolExecution?.('plain-session', {
					toolName: 'Ignored',
					state: { status: 'running' },
					timestamp: Date.now(),
				});
				listeners.toolExecution?.('session-1-ai-missing', {
					toolName: 'Missing',
					state: { status: 'running' },
					timestamp: Date.now(),
				});
				listeners.toolExecution?.('session-1-ai-tab-2', {
					toolName: 'Hidden',
					state: { status: 'completed' },
					timestamp: Date.now(),
				});
				listeners.sshRemote?.('session-1-ai', {
					id: 'remote-1',
					name: 'Remote Dev',
					host: 'dev.example.test',
				});
				listeners.sshRemote?.('session-2-terminal', null);
				listeners.sshRemote?.('unknown-session', {
					id: 'remote-3',
					name: 'Unknown Remote',
					host: 'unknown.example.test',
				});
				await flushMicrotasks();
			});

			[updatedSession, updatedTerminalSession] = useSessionStore.getState().sessions;
			expect(updatedSession.aiTabs[0].logs).toHaveLength(1);
			expect(updatedSession.aiTabs[0].logs[0].text).toBe('Read');
			expect(updatedSession.aiTabs[1].logs).toEqual([]);
			expect(updatedSession.sshRemoteId).toBe('remote-1');
			expect(updatedTerminalSession.sshRemote).toBeUndefined();
			expect(updatedTerminalSession.sshRemoteId).toBeUndefined();
			expect(window.maestro.git.isRepo).not.toHaveBeenCalled();
			expect(window.maestro.logger.log).toHaveBeenCalledWith(
				'warn',
				'[App] Detected malformed thinking content, replacing instead of appending',
				undefined,
				undefined
			);
			expect(window.maestro.logger.log).toHaveBeenCalledWith(
				'warn',
				'[App] Skipping malformed thinking chunk (concatenated tool names):',
				undefined,
				'TaskGrepRead'
			);
		} finally {
			restoreAnimationFrame();
		}
	});

	it('covers exit parser fallbacks, active-process verification errors, and error-state AI exits', async () => {
		const deps = createDeps();
		const processBridge = (window.maestro as any).process;
		const agentError: AgentError = {
			type: 'agent_crashed',
			message: 'Agent crashed before exit',
			recoverable: true,
			agentId: 'claude-code',
			sessionId: 'provider-error',
			timestamp: 1700000000000,
		};
		const erroredSession = createSession({
			id: 'session-error',
			state: 'error',
			busySource: 'ai',
			agentError,
			aiTabs: [
				createTab({ id: 'tab-a', state: 'busy', agentError }),
				createTab({ id: 'tab-b', state: 'busy' }),
			],
			activeTabId: 'tab-a',
		});
		const rawTerminalSession = createSession({
			id: 'raw-session',
			state: 'busy',
			busySource: 'terminal',
			shellLogs: [{ id: 'cmd', timestamp: 1, source: 'user', text: 'echo hello' }],
		});
		useSessionStore.setState({
			sessions: [createSession({ id: 'other-session' }), erroredSession, rawTerminalSession],
			activeSessionId: 'session-error',
		});
		processBridge.getActiveProcesses.mockRejectedValueOnce(new Error('process lookup failed'));

		renderHook(() => useAgentListeners(deps));

		await act(async () => {
			await listeners.exit?.('session-error-ai-tab-a', 1);
			await listeners.exit?.('ignored-batch-1', 0);
			await listeners.exit?.('raw-session', 0);
			await flushMicrotasks();
		});

		const [, updatedErrorSession, updatedRawSession] = useSessionStore.getState().sessions;
		expect(window.maestro.logger.log).toHaveBeenCalledWith(
			'error',
			'[onExit] Failed to verify process status:',
			undefined,
			expect.any(Error)
		);
		expect(updatedErrorSession).toMatchObject({
			state: 'error',
			busySource: undefined,
			thinkingStartTime: undefined,
		});
		expect(updatedErrorSession.aiTabs.map((tab) => tab.state)).toEqual(['idle', 'busy']);
		expect(updatedRawSession.state).toBe('idle');
		expect(updatedRawSession.shellLogs.at(-1)?.text).toBe('Terminal process exited with code 0');
	});

	it('handles stats failure, synopsis no-op/failure/rejection, command, stderr, and usage fallbacks', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-03-04T05:06:07Z'));
		const addHistoryEntry = vi.fn();
		const spawnBackgroundSynopsis = vi
			.fn()
			.mockResolvedValueOnce({
				success: true,
				response: 'NOTHING_TO_REPORT',
			})
			.mockResolvedValueOnce({
				success: false,
				response: '',
			})
			.mockRejectedValueOnce(new Error('synopsis rejected'));
		const deps = createDeps({
			addHistoryEntryRef: { current: addHistoryEntry },
			spawnBackgroundSynopsisRef: { current: spawnBackgroundSynopsis },
			getBatchStateRef: { current: () => ({ isRunning: true }) as any },
			contextWarningYellowThreshold: 75,
		});
		const makeSynopsisSession = (id: string, lastSynopsisTime?: number) =>
			createSession({
				id,
				state: 'busy',
				busySource: 'ai',
				contextUsage: 40,
				agentSessionId: `${id}-provider`,
				thinkingStartTime: Date.now() - 2000,
				aiTabs: [
					createTab({
						id: 'tab-1',
						state: 'busy',
						agentSessionId: `${id}-provider`,
						saveToHistory: true,
						lastSynopsisTime,
						thinkingStartTime: Date.now() - 2000,
						logs: [
							{ id: `${id}-user`, timestamp: 1, source: 'user', text: 'Summarize this work' },
							{
								id: `${id}-ai`,
								timestamp: 2,
								source: 'stdout',
								text: 'A meaningful assistant response was produced.',
							},
						],
					}),
				],
				activeTabId: 'tab-1',
			});
		useSessionStore.setState({
			sessions: [
				createSession({ id: 'other-session' }),
				makeSynopsisSession('session-noop', Date.now() - 60_000),
				makeSynopsisSession('session-failed'),
				makeSynopsisSession('session-rejected'),
				createSession({
					id: 'session-command',
					state: 'busy',
					busySource: 'terminal',
					aiTabs: [createTab({ id: 'tab-busy', state: 'busy' })],
				}),
				createSession({
					id: 'session-usage',
					contextUsage: 50,
					toolType: 'terminal',
				}),
			],
			activeSessionId: 'session-command',
		});
		vi.mocked(window.maestro.stats.recordQuery).mockRejectedValue(new Error('stats failed'));

		renderHook(() => useAgentListeners(deps));

		await act(async () => {
			listeners.slashCommands?.('missing-session-ai', ['ignored']);
			listeners.stderr?.('session-command', '   ');
			listeners.stderr?.('session-command-batch-1', 'batch stderr');
			listeners.commandExit?.('missing-command-session', 0);
			listeners.commandExit?.('session-command', 0);
			listeners.usage?.('session-usage-ai-tab-1', {
				inputTokens: 0,
				outputTokens: 100,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
				totalCostUsd: 0,
				contextWindow: 0,
			} satisfies UsageStats);
			await listeners.exit?.('session-noop-ai-tab-1', 0);
			await listeners.exit?.('session-failed-ai-tab-1', 0);
			await listeners.exit?.('session-rejected-ai-tab-1', 0);
			await flushMicrotasks();
			vi.runOnlyPendingTimers();
			await flushMicrotasks();
		});

		const sessions = useSessionStore.getState().sessions;
		const commandSession = sessions.find((session) => session.id === 'session-command')!;
		expect(commandSession.state).toBe('busy');
		expect(commandSession.busySource).toBe('ai');
		expect(deps.batchedUpdater.appendLog).not.toHaveBeenCalledWith(
			'session-command',
			null,
			false,
			'batch stderr',
			true
		);
		expect(deps.batchedUpdater.updateContextUsage).toHaveBeenCalledWith('session-usage', 50);
		expect(spawnBackgroundSynopsis).toHaveBeenCalledTimes(3);
		expect(spawnBackgroundSynopsis.mock.calls[0][3]).toContain('Only synopsize work done since');
		expect(addHistoryEntry).not.toHaveBeenCalled();
		expect(window.maestro.logger.log).toHaveBeenCalledWith(
			'warn',
			'[onProcessExit] Failed to record query stats:',
			undefined,
			expect.any(Error)
		);
		expect(window.maestro.logger.log).toHaveBeenCalledWith(
			'warn',
			'[onProcessExit] Synopsis generation failed - no history entry created',
			undefined,
			expect.objectContaining({ sessionId: 'session-failed' })
		);
		expect(window.maestro.logger.log).toHaveBeenCalledWith(
			'error',
			'[onProcessExit] Synopsis failed:',
			undefined,
			expect.any(Error)
		);
	});

	it('covers session-not-found and synopsis agent-error suppression paths', () => {
		const deps = createDeps();
		const sessionNotFound: AgentError = {
			type: 'session_not_found',
			message: 'Provider session was gone',
			recoverable: false,
			agentId: 'claude-code',
			sessionId: 'missing-provider',
			timestamp: 1700000000000,
		};
		const session = createSession({
			id: 'session-not-found',
			state: 'busy',
			aiTabs: [createTab({ id: 'tab-1' })],
			activeTabId: 'tab-1',
		});
		useSessionStore.setState({ sessions: [createSession({ id: 'other-session' }), session] });
		useGroupChatStore.setState({
			groupChatState: 'working',
			groupChatStates: new Map([['12345678-1234-1234-1234-123456789012', 'working']]),
		});

		renderHook(() => useAgentListeners(deps));

		act(() => {
			listeners.agentError?.(
				'group-chat-12345678-1234-1234-1234-123456789012-participant-Alice-1700000000000',
				sessionNotFound
			);
			listeners.agentError?.('session-not-found-synopsis-1', {
				...sessionNotFound,
				type: 'network_error',
			});
			listeners.agentError?.('session-not-found-ai-tab-1', sessionNotFound);
		});

		const updatedSession = useSessionStore
			.getState()
			.sessions.find((item) => item.id === 'session-not-found')!;
		expect(useGroupChatStore.getState().groupChatError).toBeNull();
		expect(updatedSession.state).toBe('busy');
		expect(updatedSession.aiTabs[0].logs.at(-1)).toEqual(
			expect.objectContaining({
				source: 'system',
				text: 'Provider session was gone',
				agentError: undefined,
			})
		);
		expect(updatedSession.agentError).toBeUndefined();
		expect(useModalStore.getState().isOpen('agentError')).toBe(false);
	});

	it('appends thinking chunks, cancels pending frames on cleanup, and handles SSH git refresh errors', async () => {
		const restoreAnimationFrame = installAnimationFrame();
		const deps = createDeps();
		const thinkingLog = {
			id: 'thinking-existing',
			timestamp: 1700000000000,
			source: 'thinking' as const,
			text: 'Thinking ',
		};
		useSessionStore.setState({
			sessions: [
				createSession({
					id: 'other-session',
					aiTabs: [createTab({ id: 'other-tab', showThinking: 'on' as any })],
					activeTabId: 'other-tab',
				}),
				createSession({
					id: 'session-ssh-error',
					cwd: '/remote/default',
					sessionSshRemoteConfig: {
						enabled: true,
						remoteId: 'remote-1',
						workingDirOverride: '/remote/override',
					},
					isGitRepo: false,
					aiTabs: [
						createTab({
							id: 'tab-1',
							showThinking: 'on' as any,
							logs: [thinkingLog],
						}),
					],
					activeTabId: 'tab-1',
				}),
			],
			activeSessionId: 'session-ssh-error',
		});
		vi.mocked(window.maestro.git.branches).mockRejectedValueOnce(new Error('branch fetch failed'));

		try {
			const { unmount } = renderHook(() => useAgentListeners(deps));

			await act(async () => {
				listeners.thinkingChunk?.('session-ssh-error-ai-tab-1', 'more.');
				listeners.thinkingChunk?.('other-session-ai-other-tab', 'elsewhere');
				vi.runOnlyPendingTimers();
				await flushMicrotasks();
			});
			expect(useSessionStore.getState().sessions[0].aiTabs[0].logs.at(-1)?.text).toBe('elsewhere');
			expect(useSessionStore.getState().sessions[1].aiTabs[0].logs.at(-1)?.text).toBe(
				'Thinking more.'
			);

			await act(async () => {
				listeners.sshRemote?.('session-ssh-error-ai-tab-1', {
					id: 'remote-1',
					name: 'Remote Dev',
					host: 'dev.example.test',
				});
				await flushMicrotasks();
			});
			expect(window.maestro.git.isRepo).toHaveBeenCalledWith('/remote/override', 'remote-1');
			expect(window.maestro.logger.log).toHaveBeenCalledWith(
				'error',
				'Git branches error:',
				undefined,
				expect.any(Error)
			);

			act(() => {
				listeners.thinkingChunk?.('session-ssh-error-ai-tab-1', 'pending cleanup');
				unmount();
			});
			expect(globalThis.cancelAnimationFrame).toHaveBeenCalled();
		} finally {
			restoreAnimationFrame();
		}
	});

	it('handles late thinking frames and SSH git refresh race/error paths', async () => {
		const deps = createDeps();
		const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
		const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
		let rafCallback: FrameRequestCallback | undefined;
		globalThis.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
			rafCallback = callback;
			return 77;
		});
		globalThis.cancelAnimationFrame = vi.fn();

		useSessionStore.setState({
			sessions: [
				createSession({
					id: 'session-race',
					cwd: '/remote/race',
					isGitRepo: false,
					aiTabs: [createTab({ id: 'tab-1', showThinking: 'on' as any })],
					activeTabId: 'tab-1',
				}),
				createSession({
					id: 'session-throw',
					cwd: '/remote/throw',
					isGitRepo: false,
					aiTabs: [createTab({ id: 'tab-2', showThinking: 'on' as any })],
					activeTabId: 'tab-2',
				}),
			],
			activeSessionId: 'session-race',
		});

		vi.spyOn(gitService, 'isRepo')
			.mockImplementationOnce(async () => {
				useSessionStore.setState((state) => ({
					sessions: state.sessions.map((session) =>
						session.id === 'session-race' ? { ...session, isGitRepo: true } : session
					),
				}));
				return true;
			})
			.mockResolvedValueOnce(false);
		vi.spyOn(gitService, 'getBranches').mockResolvedValue(['race-branch']);
		vi.spyOn(gitService, 'getTags').mockResolvedValue(['race-tag']);

		try {
			const { unmount } = renderHook(() => useAgentListeners(deps));

			await act(async () => {
				listeners.sshRemote?.('session-race-ai-tab-1', {
					id: 'remote-race',
					name: 'Remote Race',
					host: 'race.example.test',
				});
				await flushMicrotasks();
				await flushMicrotasks();
			});

			const racedSession = useSessionStore
				.getState()
				.sessions.find((session) => session.id === 'session-race');
			expect(racedSession).toMatchObject({
				isGitRepo: true,
				sshRemote: {
					id: 'remote-race',
					name: 'Remote Race',
					host: 'race.example.test',
				},
			});
			expect(racedSession?.gitBranches).toBeUndefined();
			expect(racedSession?.gitTags).toBeUndefined();

			await act(async () => {
				listeners.sshRemote?.('session-throw-ai-tab-2', {
					id: 'remote-throw',
					name: 'Remote Throw',
					host: 'throw.example.test',
				});
				await flushMicrotasks();
			});
			expect(gitService.isRepo).toHaveBeenCalledWith('/remote/throw', 'remote-throw');
			expect(gitService.getBranches).toHaveBeenCalledTimes(1);
			expect(gitService.getTags).toHaveBeenCalledTimes(1);

			act(() => {
				listeners.thinkingChunk?.('session-race-ai-tab-1', 'pending cleanup');
				unmount();
				rafCallback?.(0);
			});
			expect(globalThis.cancelAnimationFrame).toHaveBeenCalledWith(77);
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

	it('covers remaining AI-exit state branches for specific tabs, missing queue targets, and synopsis skips', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-03-04T05:06:07Z'));
		const addHistoryEntry = vi.fn();
		const spawnBackgroundSynopsis = vi.fn().mockResolvedValue({
			success: true,
			response:
				'**Summary:** Stored a focused synopsis.\n**Details:** Updated the target tab only.',
		});
		const deps = createDeps({
			addHistoryEntryRef: { current: addHistoryEntry },
			spawnBackgroundSynopsisRef: { current: spawnBackgroundSynopsis },
		});
		const error: AgentError = {
			type: 'agent_crashed',
			message: 'Specific tab crashed',
			recoverable: true,
			agentId: 'claude-code',
			sessionId: 'provider-error',
			timestamp: 1700000000000,
		};
		const queuedItem: QueuedItem = {
			id: 'missing-target',
			timestamp: 1700000000000,
			tabId: 'missing-tab',
			type: 'message',
			text: 'queued message without target',
		};
		const specificErrorSession = createSession({
			id: 'session-specific-error',
			state: 'error',
			busySource: 'ai',
			agentError: error,
			aiTabs: [
				createTab({ id: 'tab-a', state: 'busy', agentError: error }),
				createTab({ id: 'tab-b', state: 'busy' }),
			],
			activeTabId: 'tab-a',
		});
		const missingTargetSession = createSession({
			id: 'session-missing-target',
			state: 'busy',
			busySource: 'ai',
			executionQueue: [queuedItem],
			aiTabs: [],
			activeTabId: undefined,
		});
		const noTabExitSession = createSession({
			id: 'session-no-tab',
			state: 'busy',
			busySource: 'ai',
			aiTabs: [
				createTab({ id: 'tab-a', state: 'busy' }),
				createTab({ id: 'tab-b', state: 'idle' }),
			],
			activeTabId: 'tab-a',
		});
		const synopsisSession = createSession({
			id: 'session-synopsis-skip',
			state: 'busy',
			busySource: 'ai',
			agentSessionId: 'provider-synopsis',
			aiTabs: [
				createTab({
					id: 'tab-a',
					state: 'busy',
					agentSessionId: 'provider-synopsis',
					saveToHistory: true,
					logs: [
						{ id: 'user', timestamp: 1, source: 'user', text: 'Capture synopsis' },
						{ id: 'ai', timestamp: 2, source: 'stdout', text: 'Useful response.' },
					],
				}),
				createTab({ id: 'tab-b', state: 'idle' }),
			],
			activeTabId: 'tab-a',
		});
		useSessionStore.setState({
			sessions: [
				createSession({ id: 'other-session' }),
				specificErrorSession,
				missingTargetSession,
				noTabExitSession,
				synopsisSession,
			],
			activeSessionId: 'session-specific-error',
		});

		renderHook(() => useAgentListeners(deps));

		await act(async () => {
			await listeners.exit?.('session-specific-error-ai-tab-a', 1);
			await listeners.exit?.('session-missing-target-ai-tab-missing', 0);
			await listeners.exit?.('session-no-tab-ai', 0);
			await listeners.exit?.('session-synopsis-skip-ai-tab-a', 0);
			await flushMicrotasks();
			vi.runOnlyPendingTimers();
			await flushMicrotasks();
		});

		const sessions = useSessionStore.getState().sessions;
		const updatedError = sessions.find((session) => session.id === 'session-specific-error')!;
		const updatedMissingTarget = sessions.find(
			(session) => session.id === 'session-missing-target'
		)!;
		const updatedNoTab = sessions.find((session) => session.id === 'session-no-tab')!;
		const updatedSynopsis = sessions.find((session) => session.id === 'session-synopsis-skip')!;

		expect(updatedError.aiTabs.map((tab) => tab.state)).toEqual(['idle', 'busy']);
		expect(updatedMissingTarget).toMatchObject({
			state: 'busy',
			busySource: 'ai',
			executionQueue: [],
			currentCycleTokens: 0,
			currentCycleBytes: 0,
		});
		expect(updatedNoTab.aiTabs.map((tab) => tab.state)).toEqual(['busy', 'idle']);
		expect(addHistoryEntry).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: 'session-synopsis-skip',
				summary: 'Stored a focused synopsis.',
			})
		);
		expect(updatedSynopsis.aiTabs[0].lastSynopsisTime).toBeDefined();
		expect(updatedSynopsis.aiTabs[1].lastSynopsisTime).toBeUndefined();
	});

	it('covers listener fallback branches for missing targets, usage estimates, group-chat participants, and terminal exits', async () => {
		const pauseBatchOnError = vi.fn();
		const deps = createDeps({
			getBatchStateRef: {
				current: () =>
					({
						isRunning: true,
						errorPaused: true,
						currentDocumentIndex: 0,
						documents: [],
					}) as any,
			},
			pauseBatchOnErrorRef: { current: pauseBatchOnError },
		});
		const providerError: AgentError = {
			type: 'network_error',
			message: 'Participant connection failed',
			recoverable: true,
			agentId: 'claude-code',
			sessionId: 'provider-participant',
			timestamp: 1700000000000,
		};
		const pausedErrorSession = createSession({
			id: 'session-error-paused',
			state: 'busy',
			aiTabs: [createTab({ id: 'tab-present' })],
			activeTabId: 'tab-present',
		});
		const dataErrorSession = createSession({
			id: 'session-data',
			state: 'error',
			agentError: providerError,
			agentErrorPaused: true,
			aiTabs: [
				createTab({ id: 'tab-active', agentError: providerError }),
				createTab({ id: 'tab-sibling', agentError: providerError }),
			],
			activeTabId: 'tab-active',
		});
		const terminalBusySession = createSession({
			id: 'session-terminal-busy',
			state: 'busy',
			busySource: 'ai',
			isGitRepo: true,
			shellLogs: [{ id: 'cmd', timestamp: 1, source: 'user', text: 'npm test' }],
			aiTabs: [createTab({ id: 'tab-busy', state: 'busy' })],
			activeTabId: 'tab-busy',
		});
		const terminalNoCommandSession = createSession({
			id: 'session-empty-shell',
			state: 'busy',
			busySource: 'terminal',
			isGitRepo: true,
			shellLogs: [],
			aiTabs: [],
			activeTabId: undefined,
		});
		const usageZeroSession = createSession({
			id: 'session-usage-zero',
			contextUsage: 0,
			toolType: 'terminal',
		});
		const usageWindowSession = createSession({
			id: 'session-usage-window',
			contextUsage: 40,
			toolType: 'terminal',
		});
		const toolSession = createSession({
			id: 'session-tool',
			aiTabs: [
				createTab({ id: 'tab-tool', showThinking: 'on' as any }),
				createTab({ id: 'tab-other', showThinking: 'on' as any }),
			],
			activeTabId: 'tab-tool',
		});
		const sshFalseSession = createSession({
			id: 'session-ssh-false',
			cwd: '/repo/ssh-false',
			isGitRepo: false,
			aiTabs: [createTab({ id: 'tab-ssh' })],
			activeTabId: 'tab-ssh',
		});
		useSessionStore.setState({
			sessions: [
				dataErrorSession,
				pausedErrorSession,
				terminalBusySession,
				terminalNoCommandSession,
				usageZeroSession,
				usageWindowSession,
				toolSession,
				sshFalseSession,
			],
			activeSessionId: 'session-data',
		});
		vi.spyOn(gitService, 'isRepo').mockResolvedValueOnce(false);

		renderHook(() => useAgentListeners(deps));

		await act(async () => {
			listeners.data?.('missing-session-ai', 'orphan output');
			listeners.data?.('missing-session-ai-tab-x', 'orphan output with tab');
			listeners.data?.('session-data-ai-missing-tab', 'recovered output');
			listeners.usage?.('session-usage-zero-ai-tab-1', {
				inputTokens: 0,
				outputTokens: 10,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
				totalCostUsd: 0,
				contextWindow: 0,
			} satisfies UsageStats);
			listeners.usage?.('session-usage-window-ai-tab-1', {
				inputTokens: 0,
				outputTokens: 10,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
				totalCostUsd: 0,
				contextWindow: 4000,
			} satisfies UsageStats);
			listeners.usage?.('missing-usage-ai-tab-1', {
				inputTokens: 0,
				outputTokens: 10,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
				totalCostUsd: 0,
				contextWindow: 0,
			} satisfies UsageStats);
			listeners.agentError?.(
				'group-chat-12345678-1234-1234-1234-123456789012-participant-Bob-1700000000000',
				providerError
			);
			listeners.agentError?.(
				'group-chat-12345678-1234-1234-1234-123456789012-moderator-1700000000000',
				{
					...providerError,
					type: 'session_not_found',
					message: 'Moderator session was gone',
				}
			);
			listeners.agentError?.('session-error-paused-ai-missing-tab', providerError);
			listeners.toolExecution?.('session-tool-ai-tab-tool', {
				toolName: 'Edit',
				state: { status: 'running' },
				timestamp: 1700000000000,
			});
			await listeners.exit?.('session-terminal-busy-terminal', 0);
			await listeners.exit?.('session-empty-shell-terminal', 0);
			listeners.sshRemote?.('session-ssh-false-ai-tab-ssh', {
				id: 'remote-false',
				name: 'False Remote',
				host: 'false.example.test',
			});
			await flushMicrotasks();
		});

		const sessions = useSessionStore.getState().sessions;
		const updatedDataSession = sessions.find((session) => session.id === 'session-data')!;
		const updatedBusyTerminal = sessions.find((session) => session.id === 'session-terminal-busy')!;
		const updatedEmptyTerminal = sessions.find((session) => session.id === 'session-empty-shell')!;
		const updatedToolSession = sessions.find((session) => session.id === 'session-tool')!;
		expect(updatedDataSession.agentError).toBeUndefined();
		expect(updatedDataSession.aiTabs[0].agentError).toBe(providerError);
		expect(deps.batchedUpdater.markUnread).not.toHaveBeenCalledWith(
			'session-data',
			'missing-tab',
			expect.any(Boolean)
		);
		expect(deps.batchedUpdater.updateContextUsage).toHaveBeenCalledWith(
			'session-usage-window',
			expect.any(Number)
		);
		expect(useGroupChatStore.getState().groupChatError).toEqual(
			expect.objectContaining({ participantName: 'participant-Bob' })
		);
		expect(useGroupChatStore.getState().groupChatMessages.at(-1)?.content).toContain(
			'participant-Bob error'
		);
		expect(pauseBatchOnError).not.toHaveBeenCalled();
		expect(updatedBusyTerminal).toMatchObject({ state: 'busy', busySource: 'ai' });
		expect(updatedEmptyTerminal).toMatchObject({ state: 'idle', busySource: undefined });
		expect(window.maestro.git.branches).not.toHaveBeenCalled();
		expect(gitService.isRepo).toHaveBeenCalledWith('/repo/ssh-false', 'remote-false');
		expect(updatedToolSession.aiTabs[0].logs.at(-1)).toEqual(
			expect.objectContaining({ source: 'tool', text: 'Edit' })
		);
		expect(updatedToolSession.aiTabs[1].logs).toEqual([]);
	});

	it('covers AI-exit fallback branches for missing sessions, command queues, and synopsis metadata', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-03-04T05:06:07Z'));
		const processQueuedItem = vi.fn().mockResolvedValue(undefined);
		const addHistoryEntry = vi.fn();
		const spawnBackgroundSynopsis = vi
			.fn()
			.mockResolvedValueOnce({
				success: true,
				response:
					'**Summary:** Captured fallback synopsis.\n**Details:** Exercised fallback metadata branches.',
				usageStats: {
					inputTokens: 1,
					outputTokens: 1,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
					totalCostUsd: 0,
					contextWindow: 200000,
				},
			})
			.mockResolvedValueOnce({
				success: true,
				response: '',
			});
		const deps = createDeps({
			processQueuedItemRef: { current: processQueuedItem },
			addHistoryEntryRef: { current: addHistoryEntry },
			spawnBackgroundSynopsisRef: { current: spawnBackgroundSynopsis },
			getBatchStateRef: { current: () => ({ isRunning: false }) as any },
		});
		const agentError: AgentError = {
			type: 'agent_crashed',
			message: 'Queued error should not continue',
			recoverable: true,
			agentId: 'claude-code',
			sessionId: 'provider-error',
			timestamp: 1700000000000,
		};
		const commandQueueItem: QueuedItem = {
			id: 'command-queue',
			timestamp: 1700000000000,
			tabId: 'tab-command',
			type: 'command',
			command: '/commit',
		};
		const errorQueueSession = createSession({
			id: 'session-error-queue',
			state: 'error',
			busySource: 'ai',
			agentError,
			executionQueue: [commandQueueItem],
			aiTabs: [createTab({ id: 'tab-error', state: 'busy', agentError })],
			activeTabId: 'tab-error',
		});
		const commandQueueSession = createSession({
			id: 'session-command-queue',
			state: 'busy',
			busySource: 'ai',
			executionQueue: [commandQueueItem],
			aiTabs: [
				createTab({ id: 'tab-finished', state: 'busy' }),
				createTab({ id: 'tab-command', state: 'idle' }),
			],
			activeTabId: 'tab-finished',
		});
		const emptyExitSession = createSession({
			id: 'session-empty-exit',
			state: 'busy',
			busySource: 'ai',
			aiTabs: [],
			activeTabId: undefined,
		});
		const longPrompt = `Please summarize ${'important project context '.repeat(12)}`;
		const longResponse = `Long response ${'with detailed implementation notes '.repeat(25)}`;
		const synopsisFallbackSession = createSession({
			id: 'session-synopsis-fallback',
			name: '' as any,
			cwd: '/repo/fallback-project',
			state: 'busy',
			busySource: 'ai',
			agentSessionId: 'session-level-provider',
			pendingAICommandForSynopsis: 'Run fallback synopsis',
			thinkingStartTime: Date.now() - 3000,
			aiTabs: [
				createTab({
					id: 'tab-fallback',
					state: 'busy',
					agentSessionId: null,
					saveToHistory: false,
					name: null,
					logs: [
						{ id: 'user-long', timestamp: 1, source: 'user', text: longPrompt },
						{ id: 'missing-text', timestamp: 2, source: 'stdout' } as any,
						{ id: 'ai-long', timestamp: 3, source: 'stdout', text: longResponse },
					],
				}),
			],
			activeTabId: 'tab-fallback',
		});
		const emptySynopsisSession = createSession({
			id: 'session-empty-synopsis',
			state: 'busy',
			busySource: 'ai',
			agentSessionId: 'empty-provider',
			aiTabs: [
				createTab({
					id: 'tab-empty-synopsis',
					state: 'busy',
					agentSessionId: 'empty-provider',
					saveToHistory: true,
					logs: [
						{ id: 'empty-user', timestamp: 1, source: 'user', text: 'Try empty synopsis' },
						{ id: 'empty-ai', timestamp: 2, source: 'stdout', text: 'Finished.' },
					],
				}),
			],
			activeTabId: 'tab-empty-synopsis',
		});
		useSessionStore.setState({
			sessions: [
				errorQueueSession,
				commandQueueSession,
				emptyExitSession,
				synopsisFallbackSession,
				emptySynopsisSession,
			],
			activeSessionId: 'other-session',
		});

		renderHook(() => useAgentListeners(deps));

		await act(async () => {
			await listeners.exit?.('missing-exit-ai-tab-x', 0);
			await listeners.exit?.('session-error-queue-ai-tab-error', 1);
			await listeners.exit?.('session-command-queue-ai-tab-finished', 0);
			await listeners.exit?.('session-empty-exit-ai-tab-missing', 0);
			await listeners.exit?.('session-synopsis-fallback-ai-tab-fallback', 0);
			await listeners.exit?.('session-empty-synopsis-ai-tab-empty-synopsis', 0);
			await flushMicrotasks();
			vi.runOnlyPendingTimers();
			await flushMicrotasks();
			await flushMicrotasks();
		});

		const sessions = useSessionStore.getState().sessions;
		const updatedErrorQueue = sessions.find((session) => session.id === 'session-error-queue')!;
		const updatedCommandQueue = sessions.find((session) => session.id === 'session-command-queue')!;
		const updatedEmptyExit = sessions.find((session) => session.id === 'session-empty-exit')!;
		expect(updatedErrorQueue.executionQueue).toEqual([commandQueueItem]);
		expect(updatedCommandQueue).toMatchObject({
			state: 'busy',
			busySource: 'ai',
			executionQueue: [],
		});
		expect(updatedCommandQueue.aiTabs.find((tab) => tab.id === 'tab-command')).toMatchObject({
			state: 'busy',
			logs: [],
		});
		expect(updatedEmptyExit).toMatchObject({ state: 'idle', busySource: undefined });
		expect(processQueuedItem).toHaveBeenCalledWith('session-command-queue', commandQueueItem);
		expect(spawnBackgroundSynopsis).toHaveBeenCalledWith(
			'session-synopsis-fallback',
			'/repo/fallback-project',
			'session-level-provider',
			expect.stringContaining('synopsis'),
			'claude-code',
			expect.objectContaining({ customPath: undefined })
		);
		expect(addHistoryEntry).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: 'session-synopsis-fallback',
				agentSessionId: 'session-level-provider',
				summary: 'Captured fallback synopsis.',
			})
		);
		expect(window.maestro.logger.log).toHaveBeenCalledWith(
			'info',
			'Agent process completed',
			'App',
			expect.objectContaining({
				project: 'fallback-project',
				prompt: expect.stringMatching(/\.\.\.$/),
				response: expect.stringMatching(/\.\.\.$/),
			})
		);
	});

	it('covers branch-only state fallbacks for exits, session ids, batch errors, usage, and thinking logs', async () => {
		const restoreAnimationFrame = installAnimationFrame();
		vi.setSystemTime(new Date('2026-03-04T05:06:07Z'));
		const pauseBatchOnError = vi.fn();
		const addHistoryEntry = vi.fn();
		const deps = createDeps({
			addHistoryEntryRef: { current: addHistoryEntry },
			getBatchStateRef: {
				current: (sessionId: string) =>
					({
						isRunning: sessionId === 'session-batch-empty',
						errorPaused: false,
						currentDocumentIndex: 0,
						documents: [],
					}) as any,
			},
			pauseBatchOnErrorRef: { current: pauseBatchOnError },
		});
		const agentError: AgentError = {
			type: 'agent_crashed',
			message: 'Branch fallback failed',
			recoverable: true,
			agentId: 'claude-code',
			sessionId: 'provider-branch',
			timestamp: 1700000000000,
		};
		const normalStillBusySession = createSession({
			id: 'session-still-busy',
			state: 'busy',
			busySource: 'ai',
			thinkingStartTime: Date.now() - 1000,
			aiTabs: [
				createTab({ id: 'tab-done', state: 'busy' }),
				createTab({ id: 'tab-other-busy', state: 'busy' }),
			],
			activeTabId: 'tab-done',
		});
		const errorLegacySession = createSession({
			id: 'session-error-legacy',
			state: 'error',
			agentError,
			aiTabs: [
				createTab({ id: 'tab-busy', state: 'busy' }),
				createTab({ id: 'tab-idle', state: 'idle' }),
			],
			activeTabId: 'tab-busy',
		});
		const errorEmptySession = createSession({
			id: 'session-error-empty',
			state: 'error',
			agentError,
			aiTabs: [],
			activeTabId: undefined,
		});
		const shortSummarySession = createSession({
			id: 'session-short-summary',
			name: '' as any,
			cwd: '',
			state: 'busy',
			busySource: 'ai',
			aiTabs: [
				createTab({
					id: 'tab-short',
					state: 'busy',
					logs: [
						{ id: 'user-short', timestamp: 1, source: 'user', text: 'Short task' },
						{ id: 'ai-short', timestamp: 2, source: 'stdout', text: 'ok' },
					],
				}),
			],
			activeTabId: 'tab-short',
		});
		const noPunctuationSession = createSession({
			id: 'session-no-punctuation',
			name: '' as any,
			cwd: '/repo/no-punctuation',
			state: 'busy',
			busySource: 'ai',
			aiTabs: [
				createTab({
					id: 'tab-text',
					state: 'busy',
					logs: [
						{ id: 'user-text', timestamp: 1, source: 'user', text: 'Summarize output' },
						{
							id: 'ai-text',
							timestamp: 2,
							source: 'stdout',
							text: `meaningful response ${'with enough detail to exceed the compact summary threshold '.repeat(3)}.`,
						},
					],
				}),
			],
			activeTabId: 'tab-text',
		});
		const refreshSession = createSession({
			id: 'session-refresh',
			isGitRepo: true,
			shellLogs: [{ id: 'cmd', timestamp: 1, source: 'user', text: 'git branch --show-current' }],
			aiTabs: [],
			activeTabId: undefined,
		});
		const commandIdleSession = createSession({
			id: 'session-command-idle',
			state: 'busy',
			busySource: 'terminal',
			aiTabs: [createTab({ id: 'tab-idle', state: 'idle' })],
			activeTabId: 'tab-idle',
		});
		const usageFallbackSession = createSession({
			id: 'session-usage-window-fallback',
			contextUsage: 40,
			toolType: undefined as any,
		});
		const usageHugeWindowSession = createSession({
			id: 'session-usage-huge-window',
			contextUsage: 40,
			toolType: 'terminal',
		});
		const usageNoToolSession = createSession({
			id: 'session-usage-no-tool',
			contextUsage: 40,
			toolType: undefined as any,
		});
		const usageUnknownToolSession = createSession({
			id: 'session-usage-unknown-tool',
			contextUsage: 40,
			toolType: 'unknown-agent' as any,
		});
		const namedSession = createSession({
			id: 'session-name',
			aiTabs: [createTab({ id: 'tab-named', name: 'Kept Name' })],
			activeTabId: 'tab-named',
		});
		const twoTabErrorSession = createSession({
			id: 'session-two-tab-error',
			state: 'busy',
			aiTabs: [createTab({ id: 'tab-target' }), createTab({ id: 'tab-sibling' })],
			activeTabId: 'tab-target',
		});
		const batchEmptySession = createSession({
			id: 'session-batch-empty',
			state: 'busy',
			aiTabs: [createTab({ id: 'tab-batch' })],
			activeTabId: 'tab-batch',
		});
		const noTabErrorSession = createSession({
			id: 'session-no-tab-error',
			state: 'busy',
			aiTabs: [],
			activeTabId: undefined,
		});
		const thinkingMapSession = createSession({
			id: 'session-thinking-map',
			aiTabs: [
				createTab({
					id: 'tab-think',
					showThinking: 'on' as any,
					logs: [
						{
							id: 'existing-thinking',
							timestamp: 1,
							source: 'thinking',
							text: 'Existing ',
						},
					],
				}),
				createTab({ id: 'tab-new-thinking', showThinking: 'on' as any }),
				createTab({ id: 'tab-other', showThinking: 'on' as any }),
			],
			activeTabId: 'tab-think',
		});
		useSessionStore.setState({
			sessions: [
				normalStillBusySession,
				errorLegacySession,
				errorEmptySession,
				shortSummarySession,
				noPunctuationSession,
				refreshSession,
				commandIdleSession,
				usageFallbackSession,
				usageHugeWindowSession,
				usageNoToolSession,
				usageUnknownToolSession,
				namedSession,
				twoTabErrorSession,
				batchEmptySession,
				noTabErrorSession,
				thinkingMapSession,
				createSession({ id: 'other-session' }),
			],
			activeSessionId: 'other-session',
		});
		vi.spyOn(gitService, 'getBranches').mockResolvedValue(['refreshed-branch']);
		vi.spyOn(gitService, 'getTags').mockResolvedValue(['refreshed-tag']);

		try {
			renderHook(() => useAgentListeners(deps));

			await act(async () => {
				await listeners.exit?.('session-still-busy-ai-tab-done', 0);
				await listeners.exit?.('session-error-legacy-ai-tab-busy', 1);
				await listeners.exit?.('session-error-empty-ai', 1);
				await listeners.exit?.('session-short-summary-ai-tab-short', 0);
				await listeners.exit?.('session-no-punctuation-ai-tab-text', 0);
				await listeners.exit?.('session-refresh-terminal', 0);
				listeners.commandExit?.('session-command-idle', 0);
				listeners.usage?.('session-usage-window-fallback-ai-tab-1', {
					inputTokens: 0,
					outputTokens: 10,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
					totalCostUsd: 0,
					contextWindow: 4000,
				} satisfies UsageStats);
				listeners.usage?.('session-usage-huge-window-ai-tab-1', {
					inputTokens: 1000,
					outputTokens: 1000,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
					totalCostUsd: 0,
					contextWindow: 100,
				} satisfies UsageStats);
				listeners.usage?.('session-usage-no-tool-ai-tab-1', {
					inputTokens: 0,
					outputTokens: 10,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
					totalCostUsd: 0,
					contextWindow: 0,
				} satisfies UsageStats);
				listeners.usage?.('session-usage-unknown-tool-ai-tab-1', {
					inputTokens: 0,
					outputTokens: 10,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
					totalCostUsd: 0,
					contextWindow: 0,
				} satisfies UsageStats);
				await listeners.sessionId?.('session-name-ai-tab-named', 'provider-named');
				listeners.agentError?.('session-two-tab-error-ai-tab-target', agentError);
				listeners.agentError?.('session-batch-empty-ai-tab-batch', {
					...agentError,
					type: 'auth_expired',
					message: 'Auth expired',
				});
				listeners.agentError?.('session-batch-empty-ai-tab-batch', {
					...agentError,
					type: 'token_exhaustion',
					message: 'Token limit',
				});
				listeners.agentError?.('session-batch-empty-ai-tab-batch', {
					...agentError,
					type: 'rate_limited',
					message: 'Rate limited',
				});
				listeners.agentError?.('session-batch-empty-ai-tab-batch', agentError);
				(deps.addHistoryEntryRef as any).current = null;
				listeners.agentError?.('session-batch-empty-ai-tab-batch', agentError);
				listeners.agentError?.('session-no-tab-error-ai', agentError);
				listeners.thinkingChunk?.('session-thinking-map-ai-tab-think', 'branch thinking');
				listeners.thinkingChunk?.(
					'session-thinking-map-ai-tab-new-thinking',
					'fresh branch thinking'
				);
				vi.runOnlyPendingTimers();
				await flushMicrotasks();
				await flushMicrotasks();
			});

			const sessions = useSessionStore.getState().sessions;
			const updatedStillBusy = sessions.find((session) => session.id === 'session-still-busy')!;
			const updatedErrorLegacy = sessions.find((session) => session.id === 'session-error-legacy')!;
			const updatedErrorEmpty = sessions.find((session) => session.id === 'session-error-empty')!;
			const updatedRefresh = sessions.find((session) => session.id === 'session-refresh')!;
			const updatedCommandIdle = sessions.find((session) => session.id === 'session-command-idle')!;
			const updatedNamed = sessions.find((session) => session.id === 'session-name')!;
			const updatedThinking = sessions.find((session) => session.id === 'session-thinking-map')!;
			expect(updatedStillBusy).toMatchObject({ state: 'busy', busySource: 'ai' });
			expect(updatedStillBusy.aiTabs.map((tab) => tab.state)).toEqual(['idle', 'busy']);
			expect(updatedErrorLegacy.aiTabs.map((tab) => tab.state)).toEqual(['idle', 'idle']);
			expect(updatedErrorEmpty.aiTabs).toEqual([]);
			expect(updatedRefresh).toMatchObject({
				gitBranches: ['refreshed-branch'],
				gitTags: ['refreshed-tag'],
			});
			expect(updatedCommandIdle).toMatchObject({ state: 'idle', busySource: undefined });
			expect(updatedNamed.aiTabs[0]).toMatchObject({
				agentSessionId: 'provider-named',
				name: 'Kept Name',
			});
			expect(deps.batchedUpdater.updateContextUsage).toHaveBeenCalledWith(
				'session-usage-window-fallback',
				expect.any(Number)
			);
			expect(pauseBatchOnError).toHaveBeenCalledWith(
				'session-batch-empty',
				expect.objectContaining({ type: 'auth_expired' }),
				0,
				undefined
			);
			expect(addHistoryEntry).toHaveBeenCalledWith(
				expect.objectContaining({
					summary: 'Auto Run error: Authentication Required',
					fullResponse: expect.stringContaining('Re-authenticate with the provider'),
				})
			);
			expect(addHistoryEntry).toHaveBeenCalledWith(
				expect.objectContaining({
					summary: 'Auto Run error: Context Limit Reached',
					fullResponse: expect.stringContaining('Start a new session'),
				})
			);
			expect(addHistoryEntry).toHaveBeenCalledWith(
				expect.objectContaining({
					summary: 'Auto Run error: Rate Limit Exceeded',
					fullResponse: expect.stringContaining('Wait a few minutes'),
				})
			);
			expect(addHistoryEntry).toHaveBeenCalledWith(
				expect.objectContaining({
					summary: 'Auto Run error: Agent Error',
					fullResponse: expect.stringContaining('Review the error message'),
				})
			);
			expect(updatedThinking.aiTabs[0].logs.at(-1)).toEqual(
				expect.objectContaining({ source: 'thinking', text: 'Existing branch thinking' })
			);
			expect(updatedThinking.aiTabs[1].logs.at(-1)).toEqual(
				expect.objectContaining({ source: 'thinking', text: 'fresh branch thinking' })
			);
			expect(updatedThinking.aiTabs[2].logs).toEqual([]);
		} finally {
			restoreAnimationFrame();
		}
	});
});
