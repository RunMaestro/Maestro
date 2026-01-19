import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useAgentExecution } from '../../../renderer/hooks';
import type { Session, AITab, UsageStats, QueuedItem } from '../../../renderer/types';

const createMockTab = (overrides: Partial<AITab> = {}): AITab => ({
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
});

const createMockSession = (overrides: Partial<Session> = {}): Session => {
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
		aiTabs: [baseTab],
		activeTabId: baseTab.id,
		closedTabHistory: [],
		executionQueue: [],
		activeTimeMs: 0,
		...overrides,
	};
};

const baseUsage: UsageStats = {
	inputTokens: 1,
	outputTokens: 2,
	cacheReadInputTokens: 0,
	cacheCreationInputTokens: 0,
	totalCostUsd: 0.01,
	contextWindow: 200000,
};

describe('useAgentExecution', () => {
	const originalMaestro = { ...window.maestro };
	const mockProcess = {
		...window.maestro.process,
		spawn: vi.fn(),
		onData: vi.fn(),
		onSessionId: vi.fn(),
		onUsage: vi.fn(),
		onExit: vi.fn(),
	};

	let onDataHandler: ((sid: string, data: string) => void) | undefined;
	let onSessionIdHandler: ((sid: string, sessionId: string) => void) | undefined;
	let onUsageHandler: ((sid: string, usage: UsageStats) => void) | undefined;
	let onExitHandler: ((sid: string) => void) | undefined;

	beforeEach(() => {
		vi.clearAllMocks();

		onDataHandler = undefined;
		onSessionIdHandler = undefined;
		onUsageHandler = undefined;
		onExitHandler = undefined;

		mockProcess.spawn.mockResolvedValue(undefined);
		mockProcess.onData.mockImplementation((handler: (sid: string, data: string) => void) => {
			onDataHandler = handler;
			return () => {};
		});
		mockProcess.onSessionId.mockImplementation(
			(handler: (sid: string, sessionId: string) => void) => {
				onSessionIdHandler = handler;
				return () => {};
			}
		);
		mockProcess.onUsage.mockImplementation((handler: (sid: string, usage: UsageStats) => void) => {
			onUsageHandler = handler;
			return () => {};
		});
		mockProcess.onExit.mockImplementation((handler: (sid: string) => void) => {
			onExitHandler = handler;
			return () => {};
		});

		window.maestro = {
			...window.maestro,
			agents: {
				...window.maestro.agents,
				get: vi.fn().mockResolvedValue({
					id: 'claude-code',
					command: 'claude-code',
					args: ['--print'],
				}),
			},
			process: mockProcess,
		};
	});

	afterEach(() => {
		vi.useRealTimers();
		Object.assign(window.maestro, originalMaestro);
	});

	it('spawns a batch agent and returns aggregated results', async () => {
		const session = createMockSession({
			state: 'busy',
			aiTabs: [createMockTab({ state: 'busy' })],
		});
		const sessionsRef = { current: [session] };
		const setSessions = vi.fn();
		const processQueuedItemRef = { current: null };

		const { result } = renderHook(() =>
			useAgentExecution({
				activeSession: session,
				sessionsRef,
				setSessions,
				processQueuedItemRef,
				setFlashNotification: vi.fn(),
				setSuccessFlashNotification: vi.fn(),
			})
		);

		const spawnPromise = result.current.spawnAgentForSession(session.id, 'Test prompt');

		await waitFor(() => {
			expect(mockProcess.spawn).toHaveBeenCalledTimes(1);
		});

		const spawnConfig = mockProcess.spawn.mock.calls[0][0];
		const targetSessionId = spawnConfig.sessionId as string;

		act(() => {
			onDataHandler?.(targetSessionId, 'Hello ');
			onDataHandler?.(targetSessionId, 'world');
			onSessionIdHandler?.(targetSessionId, 'agent-session-123');
			onUsageHandler?.(targetSessionId, baseUsage);
			onUsageHandler?.(targetSessionId, {
				...baseUsage,
				inputTokens: 2,
				outputTokens: 3,
				totalCostUsd: 0.02,
			});
			onExitHandler?.(targetSessionId);
		});

		const resultData = await spawnPromise;

		expect(resultData).toEqual({
			success: true,
			response: 'Hello world',
			agentSessionId: 'agent-session-123',
			usageStats: {
				...baseUsage,
				inputTokens: 3,
				outputTokens: 5,
				totalCostUsd: 0.03,
			},
		});

		expect(setSessions).toHaveBeenCalledOnce();
		const updateFn = setSessions.mock.calls[0][0];
		const [updatedSession] = updateFn([session]);

		expect(updatedSession.state).toBe('idle');
		expect(updatedSession.aiTabs[0].state).toBe('idle');
	});

	it('queues the next item and logs queued messages', async () => {
		const queuedItem: QueuedItem = {
			id: 'queued-1',
			timestamp: 1700000000100,
			tabId: 'tab-1',
			type: 'message',
			text: 'Queued message',
		};
		const session = createMockSession({
			executionQueue: [queuedItem],
		});
		const sessionsRef = { current: [session] };
		const setSessions = vi.fn();
		const processQueuedItemRef = { current: vi.fn().mockResolvedValue(undefined) };

		const { result } = renderHook(() =>
			useAgentExecution({
				activeSession: session,
				sessionsRef,
				setSessions,
				processQueuedItemRef,
				setFlashNotification: vi.fn(),
				setSuccessFlashNotification: vi.fn(),
			})
		);

		const spawnPromise = result.current.spawnAgentForSession(
			session.id,
			'Next prompt',
			'/worktree'
		);

		await waitFor(() => {
			expect(mockProcess.spawn).toHaveBeenCalledTimes(1);
		});

		const spawnConfig = mockProcess.spawn.mock.calls[0][0];
		const targetSessionId = spawnConfig.sessionId as string;

		vi.useFakeTimers();
		act(() => {
			onExitHandler?.(targetSessionId);
		});

		await spawnPromise;
		vi.runAllTimers();

		const updateFn = setSessions.mock.calls[0][0];
		const [updatedSession] = updateFn([session]);

		expect(updatedSession.state).toBe('busy');
		expect(updatedSession.executionQueue).toHaveLength(0);
		expect(updatedSession.aiTabs[0].logs[0].text).toBe('Queued message');
		expect(processQueuedItemRef.current).toHaveBeenCalledWith(session.id, queuedItem);
	});

	it('spawns a background synopsis session with resume ID', async () => {
		const session = createMockSession();
		const sessionsRef = { current: [session] };
		const setSessions = vi.fn();
		const processQueuedItemRef = { current: null };

		const { result } = renderHook(() =>
			useAgentExecution({
				activeSession: session,
				sessionsRef,
				setSessions,
				processQueuedItemRef,
				setFlashNotification: vi.fn(),
				setSuccessFlashNotification: vi.fn(),
			})
		);

		const spawnPromise = result.current.spawnBackgroundSynopsis(
			session.id,
			session.cwd,
			'resume-123',
			'Summarize session',
			'claude-code'
		);

		await waitFor(() => {
			expect(mockProcess.spawn).toHaveBeenCalledTimes(1);
		});
		await waitFor(() => {
			expect(mockProcess.onData).toHaveBeenCalledTimes(1);
		});

		const spawnConfig = mockProcess.spawn.mock.calls[0][0];
		const targetSessionId = spawnConfig.sessionId as string;

		act(() => {
			onDataHandler?.(targetSessionId, 'Summary');
			onSessionIdHandler?.(targetSessionId, 'agent-session-999');
			onUsageHandler?.(targetSessionId, baseUsage);
			onUsageHandler?.(targetSessionId, {
				...baseUsage,
				inputTokens: 4,
				outputTokens: 1,
				totalCostUsd: 0.04,
			});
			onExitHandler?.(targetSessionId);
		});

		const resultData = await spawnPromise;

		expect(spawnConfig.agentSessionId).toBe('resume-123');
		expect(resultData).toEqual({
			success: true,
			response: 'Summary',
			agentSessionId: 'agent-session-999',
			usageStats: {
				...baseUsage,
				inputTokens: 5,
				outputTokens: 3,
				totalCostUsd: 0.05,
			},
		});
	});

	it('auto-dismisses flash notifications', () => {
		vi.useFakeTimers();
		const session = createMockSession();
		const sessionsRef = { current: [session] };
		const setFlashNotification = vi.fn();
		const setSuccessFlashNotification = vi.fn();

		const { result } = renderHook(() =>
			useAgentExecution({
				activeSession: session,
				sessionsRef,
				setSessions: vi.fn(),
				processQueuedItemRef: { current: null },
				setFlashNotification,
				setSuccessFlashNotification,
			})
		);

		act(() => {
			result.current.showFlashNotification('Saved');
			result.current.showSuccessFlash('Done');
		});

		expect(setFlashNotification).toHaveBeenCalledWith('Saved');
		expect(setSuccessFlashNotification).toHaveBeenCalledWith('Done');

		act(() => {
			vi.advanceTimersByTime(2000);
		});

		expect(setFlashNotification).toHaveBeenCalledWith(null);
		expect(setSuccessFlashNotification).toHaveBeenCalledWith(null);
	});
});
