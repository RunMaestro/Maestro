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
			aiTabs: [createMockTab({ id: 'tab-1', state: 'busy' }), createMockTab({ id: 'tab-2' })],
			activeTabId: 'tab-1',
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
			onDataHandler?.('other-session', 'Ignored ');
			onSessionIdHandler?.('other-session', 'ignored-agent-session');
			onUsageHandler?.('other-session', {
				...baseUsage,
				inputTokens: 99,
				outputTokens: 99,
				totalCostUsd: 9.99,
			});
			onExitHandler?.('other-session');
			onDataHandler?.(targetSessionId, 'Hello ');
			onDataHandler?.(targetSessionId, 'world');
			onSessionIdHandler?.(targetSessionId, 'agent-session-123');
			onUsageHandler?.(targetSessionId, { ...baseUsage, reasoningTokens: 1 });
			onUsageHandler?.(targetSessionId, {
				...baseUsage,
				inputTokens: 2,
				outputTokens: 3,
				totalCostUsd: 0.02,
				reasoningTokens: 2,
			});
			onUsageHandler?.(targetSessionId, {
				...baseUsage,
				inputTokens: 0,
				outputTokens: 0,
				totalCostUsd: 0,
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
				reasoningTokens: 3,
			},
		});

		expect(setSessions).toHaveBeenCalledOnce();
		const updateFn = setSessions.mock.calls[0][0];
		const otherSession = createMockSession({ id: 'other-session' });
		const [preservedSession, updatedSession] = updateFn([otherSession, session]);

		expect(preservedSession).toBe(otherSession);
		expect(updatedSession.state).toBe('idle');
		expect(updatedSession.aiTabs[0].state).toBe('idle');
		expect(updatedSession.aiTabs[1].state).toBe('idle');
	});

	it('returns false when the requested session or active session is missing', async () => {
		const sessionsRef = { current: [] };

		const { result } = renderHook(() =>
			useAgentExecution({
				activeSession: null,
				sessionsRef,
				setSessions: vi.fn(),
				processQueuedItemRef: { current: null },
				setFlashNotification: vi.fn(),
				setSuccessFlashNotification: vi.fn(),
			})
		);

		await expect(result.current.spawnAgentForSession('missing-session', 'Prompt')).resolves.toEqual(
			{
				success: false,
			}
		);
		await expect(result.current.spawnAgentWithPrompt('Prompt')).resolves.toEqual({
			success: false,
		});
		expect(mockProcess.spawn).not.toHaveBeenCalled();
	});

	it('returns false and logs when batch agent lookup fails', async () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		const session = createMockSession({ toolType: 'codex' });
		const sessionsRef = { current: [session] };

		vi.mocked(window.maestro.agents.get).mockResolvedValueOnce(null);

		const { result } = renderHook(() =>
			useAgentExecution({
				activeSession: session,
				sessionsRef,
				setSessions: vi.fn(),
				processQueuedItemRef: { current: null },
				setFlashNotification: vi.fn(),
				setSuccessFlashNotification: vi.fn(),
			})
		);

		await expect(result.current.spawnAgentForSession(session.id, 'Prompt')).resolves.toEqual({
			success: false,
		});
		expect(consoleError).toHaveBeenCalledWith(
			'[spawnAgentForSession] Agent not found for toolType: codex'
		);

		const lookupError = new Error('lookup failed');
		vi.mocked(window.maestro.agents.get).mockRejectedValueOnce(lookupError);
		await expect(result.current.spawnAgentForSession(session.id, 'Prompt')).resolves.toEqual({
			success: false,
		});
		expect(consoleError).toHaveBeenCalledWith('Error spawning agent:', lookupError);
		expect(mockProcess.spawn).not.toHaveBeenCalled();

		consoleError.mockRestore();
	});

	it('cleans up listeners and returns false when batch process spawn fails', async () => {
		const cleanupData = vi.fn();
		const cleanupSessionId = vi.fn();
		const cleanupUsage = vi.fn();
		const cleanupExit = vi.fn();
		const session = createMockSession();
		const sessionsRef = { current: [session] };

		mockProcess.onData.mockImplementation((handler: (sid: string, data: string) => void) => {
			onDataHandler = handler;
			return cleanupData;
		});
		mockProcess.onSessionId.mockImplementation(
			(handler: (sid: string, sessionId: string) => void) => {
				onSessionIdHandler = handler;
				return cleanupSessionId;
			}
		);
		mockProcess.onUsage.mockImplementation((handler: (sid: string, usage: UsageStats) => void) => {
			onUsageHandler = handler;
			return cleanupUsage;
		});
		mockProcess.onExit.mockImplementation((handler: (sid: string) => void) => {
			onExitHandler = handler;
			return cleanupExit;
		});
		mockProcess.spawn.mockRejectedValueOnce(new Error('spawn failed'));

		const { result } = renderHook(() =>
			useAgentExecution({
				activeSession: session,
				sessionsRef,
				setSessions: vi.fn(),
				processQueuedItemRef: { current: null },
				setFlashNotification: vi.fn(),
				setSuccessFlashNotification: vi.fn(),
			})
		);

		await expect(result.current.spawnAgentForSession(session.id, 'Prompt')).resolves.toEqual({
			success: false,
		});
		expect(cleanupData).toHaveBeenCalledOnce();
		expect(cleanupSessionId).toHaveBeenCalledOnce();
		expect(cleanupUsage).toHaveBeenCalledOnce();
		expect(cleanupExit).toHaveBeenCalledOnce();
	});

	it('logs stats recording failures without failing batch completion', async () => {
		const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const statsError = new Error('stats down');
		vi.mocked(window.maestro.stats.recordQuery).mockRejectedValueOnce(statsError);
		const session = createMockSession();
		const sessionsRef = { current: [session] };

		const { result } = renderHook(() =>
			useAgentExecution({
				activeSession: session,
				sessionsRef,
				setSessions: vi.fn(),
				processQueuedItemRef: { current: null },
				setFlashNotification: vi.fn(),
				setSuccessFlashNotification: vi.fn(),
			})
		);

		const spawnPromise = result.current.spawnAgentForSession(session.id, 'Prompt');

		await waitFor(() => {
			expect(mockProcess.spawn).toHaveBeenCalledTimes(1);
		});
		const targetSessionId = mockProcess.spawn.mock.calls[0][0].sessionId as string;

		act(() => {
			onExitHandler?.(targetSessionId);
		});

		await expect(spawnPromise).resolves.toMatchObject({ success: true });
		await waitFor(() => {
			expect(consoleWarn).toHaveBeenCalledWith(
				'[spawnAgentForSession] Failed to record query stats:',
				statsError
			);
		});

		consoleWarn.mockRestore();
	});

	it('spawnAgentWithPrompt delegates to the active session', async () => {
		const session = createMockSession();
		const sessionsRef = { current: [session] };
		vi.mocked(window.maestro.agents.get).mockResolvedValueOnce({
			id: 'claude-code',
			command: 'claude-code',
		});

		const { result } = renderHook(() =>
			useAgentExecution({
				activeSession: session,
				sessionsRef,
				setSessions: vi.fn(),
				processQueuedItemRef: { current: null },
				setFlashNotification: vi.fn(),
				setSuccessFlashNotification: vi.fn(),
			})
		);

		const spawnPromise = result.current.spawnAgentWithPrompt('Prompt from slash command');

		await waitFor(() => {
			expect(mockProcess.spawn).toHaveBeenCalledTimes(1);
		});
		expect(mockProcess.spawn.mock.calls[0][0]).toMatchObject({
			cwd: session.cwd,
			args: [],
			prompt: 'Prompt from slash command',
		});

		const targetSessionId = mockProcess.spawn.mock.calls[0][0].sessionId as string;
		act(() => {
			onExitHandler?.(targetSessionId);
		});

		await expect(spawnPromise).resolves.toMatchObject({ success: true });
	});

	it('uses raw stdin prompt delivery for local Windows batch runs when stream-json input is unsupported', async () => {
		const originalPlatform = (window as any).maestro?.platform;
		(window as any).maestro = { ...((window as any).maestro || {}), platform: 'win32' };
		const session = createMockSession({ toolType: 'codex' });
		const sessionsRef = { current: [session] };
		const setSessions = vi.fn();
		const processQueuedItemRef = { current: null };

		vi.mocked(window.maestro.agents.get).mockResolvedValueOnce({
			id: 'codex',
			command: 'codex',
			args: ['exec', '--json'],
			capabilities: { supportsStreamJsonInput: false },
		});

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
		expect(spawnConfig.sendPromptViaStdin).toBe(false);
		expect(spawnConfig.sendPromptViaStdinRaw).toBe(true);

		const targetSessionId = spawnConfig.sessionId as string;
		act(() => {
			onExitHandler?.(targetSessionId);
		});
		await spawnPromise;
		(window as any).maestro.platform = originalPlatform;
	});

	it('does not enable local stdin flags for SSH batch runs', async () => {
		const platformSpy = vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('Win32');
		const session = createMockSession({
			toolType: 'codex',
			sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
		});
		const sessionsRef = { current: [session] };
		const setSessions = vi.fn();
		const processQueuedItemRef = { current: null };

		vi.mocked(window.maestro.agents.get).mockResolvedValueOnce({
			id: 'codex',
			command: 'codex',
			args: ['exec', '--json'],
			capabilities: { supportsStreamJsonInput: false },
		});

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
		expect(spawnConfig.sendPromptViaStdin).toBe(false);
		expect(spawnConfig.sendPromptViaStdinRaw).toBe(false);

		const targetSessionId = spawnConfig.sessionId as string;
		act(() => {
			onExitHandler?.(targetSessionId);
		});
		await spawnPromise;
		platformSpy.mockRestore();
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
			aiTabs: [
				createMockTab({ id: 'tab-1' }),
				createMockTab({
					id: 'tab-2',
					logs: [{ id: 'existing', timestamp: 1700000000050, source: 'ai', text: 'Existing' }],
				}),
			],
			activeTabId: 'tab-1',
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
		expect(updatedSession.aiTabs[1].logs).toEqual([
			{ id: 'existing', timestamp: 1700000000050, source: 'ai', text: 'Existing' },
		]);
		expect(processQueuedItemRef.current).toHaveBeenCalledWith(session.id, queuedItem);
	});

	it('queues command items without adding a user message log', async () => {
		const queuedItem: QueuedItem = {
			id: 'queued-command',
			timestamp: 1700000000150,
			tabId: 'tab-1',
			type: 'command',
			command: '/commit',
			commandArgs: 'message',
		};
		const session = createMockSession({
			executionQueue: [queuedItem],
		});
		const sessionsRef = { current: [session] };
		const setSessions = vi.fn();

		const { result } = renderHook(() =>
			useAgentExecution({
				activeSession: session,
				sessionsRef,
				setSessions,
				processQueuedItemRef: { current: null },
				setFlashNotification: vi.fn(),
				setSuccessFlashNotification: vi.fn(),
			})
		);

		const spawnPromise = result.current.spawnAgentForSession(session.id, 'Prompt', '/worktree');

		await waitFor(() => {
			expect(mockProcess.spawn).toHaveBeenCalledTimes(1);
		});
		const targetSessionId = mockProcess.spawn.mock.calls[0][0].sessionId as string;

		act(() => {
			onExitHandler?.(targetSessionId);
		});

		await expect(spawnPromise).resolves.toMatchObject({ success: true });
		const updateFn = setSessions.mock.calls[0][0];
		const [updatedSession] = updateFn([session]);

		expect(updatedSession.aiTabs[0].logs).toEqual([]);
		expect(updatedSession.executionQueue).toEqual([]);
	});

	it('keeps the session busy when a queued item has no target tab fallback', async () => {
		const queuedItem: QueuedItem = {
			id: 'queued-missing-tab',
			timestamp: 1700000000200,
			tabId: 'missing-tab',
			type: 'message',
			text: 'Queued message without target',
		};
		const session = createMockSession({
			aiTabs: [],
			activeTabId: '',
			executionQueue: [queuedItem],
		});
		const sessionsRef = { current: [session] };
		const setSessions = vi.fn();

		const { result } = renderHook(() =>
			useAgentExecution({
				activeSession: session,
				sessionsRef,
				setSessions,
				processQueuedItemRef: { current: null },
				setFlashNotification: vi.fn(),
				setSuccessFlashNotification: vi.fn(),
			})
		);

		const spawnPromise = result.current.spawnAgentForSession(session.id, 'Prompt', '/worktree');

		await waitFor(() => {
			expect(mockProcess.spawn).toHaveBeenCalledTimes(1);
		});
		const targetSessionId = mockProcess.spawn.mock.calls[0][0].sessionId as string;

		act(() => {
			onExitHandler?.(targetSessionId);
		});

		await expect(spawnPromise).resolves.toMatchObject({ success: true });
		const updateFn = setSessions.mock.calls[0][0];
		const [updatedSession] = updateFn([session]);

		expect(updatedSession).toMatchObject({
			state: 'busy',
			busySource: 'ai',
			executionQueue: [],
			currentCycleTokens: 0,
			currentCycleBytes: 0,
			pendingAICommandForSynopsis: undefined,
		});
		expect(updatedSession.aiTabs).toEqual([]);
	});

	it('sets an empty-tab session idle when a batch run exits with no queued work', async () => {
		const session = createMockSession({
			state: 'busy',
			aiTabs: [],
			activeTabId: '',
			executionQueue: [],
		});
		const sessionsRef = { current: [session] };
		const setSessions = vi.fn();

		const { result } = renderHook(() =>
			useAgentExecution({
				activeSession: session,
				sessionsRef,
				setSessions,
				processQueuedItemRef: { current: null },
				setFlashNotification: vi.fn(),
				setSuccessFlashNotification: vi.fn(),
			})
		);

		const spawnPromise = result.current.spawnAgentForSession(session.id, 'Prompt');

		await waitFor(() => {
			expect(mockProcess.spawn).toHaveBeenCalledTimes(1);
		});
		const targetSessionId = mockProcess.spawn.mock.calls[0][0].sessionId as string;

		act(() => {
			onExitHandler?.(targetSessionId);
		});

		await expect(spawnPromise).resolves.toMatchObject({ success: true });
		const updateFn = setSessions.mock.calls[0][0];
		const [updatedSession] = updateFn([session]);

		expect(updatedSession).toMatchObject({
			state: 'idle',
			busySource: undefined,
			thinkingStartTime: undefined,
			pendingAICommandForSynopsis: undefined,
			aiTabs: [],
		});
	});

	it('waits for queued manual work to drain before resolving a non-worktree batch run', async () => {
		const queuedItem: QueuedItem = {
			id: 'queued-drain',
			timestamp: 1700000000300,
			tabId: 'tab-1',
			type: 'message',
			text: 'Queued message',
		};
		const busySession = createMockSession({
			state: 'busy',
			executionQueue: [queuedItem],
		});
		const sessionsRef = { current: [busySession] };
		const processQueuedItem = vi.fn().mockResolvedValue(undefined);

		const { result } = renderHook(() =>
			useAgentExecution({
				activeSession: busySession,
				sessionsRef,
				setSessions: vi.fn(),
				processQueuedItemRef: { current: processQueuedItem },
				setFlashNotification: vi.fn(),
				setSuccessFlashNotification: vi.fn(),
			})
		);

		const spawnPromise = result.current.spawnAgentForSession(busySession.id, 'Prompt');
		let resolved = false;
		spawnPromise.then(() => {
			resolved = true;
		});

		await waitFor(() => {
			expect(mockProcess.spawn).toHaveBeenCalledTimes(1);
		});
		const targetSessionId = mockProcess.spawn.mock.calls[0][0].sessionId as string;

		vi.useFakeTimers();
		act(() => {
			onExitHandler?.(targetSessionId);
		});

		await act(async () => {
			vi.advanceTimersByTime(50);
		});
		expect(resolved).toBe(false);

		sessionsRef.current = [{ ...busySession, state: 'idle' }];

		await act(async () => {
			vi.advanceTimersByTime(100);
		});

		await expect(spawnPromise).resolves.toMatchObject({ success: true });
		expect(processQueuedItem).toHaveBeenCalledWith(busySession.id, queuedItem);
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
			onDataHandler?.('other-session', 'Ignored summary');
			onSessionIdHandler?.('other-session', 'ignored-agent-session');
			onUsageHandler?.('other-session', {
				...baseUsage,
				inputTokens: 99,
				outputTokens: 99,
				totalCostUsd: 9.99,
			});
			onExitHandler?.('other-session');
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

	it('spawns background synopsis with main-session SSH config and session overrides', async () => {
		const sshConfig = {
			enabled: true,
			remoteId: 'remote-1',
			workingDirOverride: '/remote/project',
		};
		const session = createMockSession({
			sessionSshRemoteConfig: sshConfig,
		});
		const sessionsRef = { current: [session] };

		vi.mocked(window.maestro.agents.get).mockResolvedValueOnce({
			id: 'codex',
			command: 'codex',
			args: ['exec'],
			capabilities: { supportsStreamJsonInput: false },
		});

		const { result } = renderHook(() =>
			useAgentExecution({
				activeSession: session,
				sessionsRef,
				setSessions: vi.fn(),
				processQueuedItemRef: { current: null },
				setFlashNotification: vi.fn(),
				setSuccessFlashNotification: vi.fn(),
			})
		);

		const spawnPromise = result.current.spawnBackgroundSynopsis(
			session.id,
			'/remote/project',
			'resume-456',
			'Summarize remotely',
			'codex',
			{
				customPath: '/custom/codex',
				customArgs: '--dangerously-bypass-approvals-and-sandbox',
				customEnvVars: { FOO: 'bar' },
				customModel: 'gpt-test',
				customContextWindow: 12345,
			}
		);

		await waitFor(() => {
			expect(mockProcess.spawn).toHaveBeenCalledTimes(1);
		});

		const spawnConfig = mockProcess.spawn.mock.calls[0][0];
		expect(spawnConfig).toMatchObject({
			toolType: 'codex',
			cwd: '/remote/project',
			command: '/custom/codex',
			agentSessionId: 'resume-456',
			sessionCustomPath: '/custom/codex',
			sessionCustomArgs: '--dangerously-bypass-approvals-and-sandbox',
			sessionCustomEnvVars: { FOO: 'bar' },
			sessionCustomModel: 'gpt-test',
			sessionCustomContextWindow: 12345,
			sessionSshRemoteConfig: sshConfig,
			sendPromptViaStdin: false,
			sendPromptViaStdinRaw: false,
		});

		const targetSessionId = spawnConfig.sessionId as string;
		act(() => {
			onExitHandler?.(targetSessionId);
		});

		await expect(spawnPromise).resolves.toMatchObject({ success: true });
	});

	it('prefers synopsis session SSH config over main-session fallback config', async () => {
		const mainSshConfig = {
			enabled: true,
			remoteId: 'main-remote',
			workingDirOverride: '/main/project',
		};
		const overrideSshConfig = {
			enabled: true,
			remoteId: 'override-remote',
			workingDirOverride: '/override/project',
		};
		const session = createMockSession({
			sessionSshRemoteConfig: mainSshConfig,
		});
		const sessionsRef = { current: [session] };

		vi.mocked(window.maestro.agents.get).mockResolvedValueOnce({
			id: 'codex',
			command: 'codex',
			capabilities: { supportsStreamJsonInput: false },
		});

		const { result } = renderHook(() =>
			useAgentExecution({
				activeSession: session,
				sessionsRef,
				setSessions: vi.fn(),
				processQueuedItemRef: { current: null },
				setFlashNotification: vi.fn(),
				setSuccessFlashNotification: vi.fn(),
			})
		);

		const spawnPromise = result.current.spawnBackgroundSynopsis(
			session.id,
			'/override/project',
			'resume-789',
			'Summarize remotely',
			'codex',
			{
				sessionSshRemoteConfig: overrideSshConfig,
			}
		);

		await waitFor(() => {
			expect(mockProcess.spawn).toHaveBeenCalledTimes(1);
		});

		const spawnConfig = mockProcess.spawn.mock.calls[0][0];
		expect(spawnConfig).toMatchObject({
			args: [],
			sessionSshRemoteConfig: overrideSshConfig,
			sendPromptViaStdin: false,
			sendPromptViaStdinRaw: false,
		});

		act(() => {
			onExitHandler?.(spawnConfig.sessionId);
		});

		await expect(spawnPromise).resolves.toMatchObject({ success: true });
	});

	it('returns false and logs when background synopsis agent lookup fails', async () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		const session = createMockSession({ toolType: 'codex' });
		const sessionsRef = { current: [session] };

		vi.mocked(window.maestro.agents.get).mockResolvedValueOnce(null);

		const { result } = renderHook(() =>
			useAgentExecution({
				activeSession: session,
				sessionsRef,
				setSessions: vi.fn(),
				processQueuedItemRef: { current: null },
				setFlashNotification: vi.fn(),
				setSuccessFlashNotification: vi.fn(),
			})
		);

		await expect(
			result.current.spawnBackgroundSynopsis(
				session.id,
				session.cwd,
				'resume-123',
				'Summarize session',
				'codex'
			)
		).resolves.toEqual({ success: false });
		expect(consoleError).toHaveBeenCalledWith(
			'[spawnBackgroundSynopsis] Agent not found for toolType: codex'
		);

		const lookupError = new Error('synopsis lookup failed');
		vi.mocked(window.maestro.agents.get).mockRejectedValueOnce(lookupError);
		await expect(
			result.current.spawnBackgroundSynopsis(
				session.id,
				session.cwd,
				'resume-123',
				'Summarize session',
				'codex'
			)
		).resolves.toEqual({ success: false });
		expect(consoleError).toHaveBeenCalledWith('Error spawning background synopsis:', lookupError);
		expect(mockProcess.spawn).not.toHaveBeenCalled();

		consoleError.mockRestore();
	});

	it('cleans up listeners and tracking when background synopsis spawn fails', async () => {
		const cleanupData = vi.fn();
		const cleanupSessionId = vi.fn();
		const cleanupUsage = vi.fn();
		const cleanupExit = vi.fn();
		const mockKill = vi.fn().mockResolvedValue(true);
		window.maestro.process.kill = mockKill;
		const session = createMockSession();
		const sessionsRef = { current: [session] };

		mockProcess.onData.mockImplementation((handler: (sid: string, data: string) => void) => {
			onDataHandler = handler;
			return cleanupData;
		});
		mockProcess.onSessionId.mockImplementation(
			(handler: (sid: string, sessionId: string) => void) => {
				onSessionIdHandler = handler;
				return cleanupSessionId;
			}
		);
		mockProcess.onUsage.mockImplementation((handler: (sid: string, usage: UsageStats) => void) => {
			onUsageHandler = handler;
			return cleanupUsage;
		});
		mockProcess.onExit.mockImplementation((handler: (sid: string) => void) => {
			onExitHandler = handler;
			return cleanupExit;
		});
		mockProcess.spawn.mockRejectedValueOnce(new Error('synopsis spawn failed'));

		const { result } = renderHook(() =>
			useAgentExecution({
				activeSession: session,
				sessionsRef,
				setSessions: vi.fn(),
				processQueuedItemRef: { current: null },
				setFlashNotification: vi.fn(),
				setSuccessFlashNotification: vi.fn(),
			})
		);

		await expect(
			result.current.spawnBackgroundSynopsis(
				session.id,
				session.cwd,
				'resume-123',
				'Summarize session',
				'claude-code'
			)
		).resolves.toEqual({ success: false });

		expect(cleanupData).toHaveBeenCalledOnce();
		expect(cleanupSessionId).toHaveBeenCalledOnce();
		expect(cleanupUsage).toHaveBeenCalledOnce();
		expect(cleanupExit).toHaveBeenCalledOnce();

		await act(async () => {
			await result.current.cancelPendingSynopsis(session.id);
		});
		expect(mockKill).not.toHaveBeenCalled();
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

	it('cancels pending synopsis sessions when cancelPendingSynopsis is called', async () => {
		const mockKill = vi.fn().mockResolvedValue(true);
		window.maestro.process.kill = mockKill;

		const session = createMockSession();
		const sessionsRef = { current: [session] };
		const setSessions = vi.fn();

		const { result } = renderHook(() =>
			useAgentExecution({
				activeSession: session,
				sessionsRef,
				setSessions,
				processQueuedItemRef: { current: null },
				setFlashNotification: vi.fn(),
				setSuccessFlashNotification: vi.fn(),
			})
		);

		// Spawn a synopsis session (don't wait for it to complete)
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

		// Cancel the pending synopsis
		await act(async () => {
			await result.current.cancelPendingSynopsis(session.id);
		});

		// Should have called kill on the synopsis session
		expect(mockKill).toHaveBeenCalledTimes(1);
		expect(mockKill.mock.calls[0][0]).toMatch(new RegExp(`^${session.id}-synopsis-\\d+$`));

		// Clean up: trigger exit so the promise resolves
		const spawnConfig = mockProcess.spawn.mock.calls[0][0];
		const targetSessionId = spawnConfig.sessionId as string;
		act(() => {
			onExitHandler?.(targetSessionId);
		});

		await spawnPromise;
	});

	it('tracks and cancels multiple pending synopsis sessions for one maestro session', async () => {
		const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
		const mockKill = vi.fn().mockResolvedValue(true);
		window.maestro.process.kill = mockKill;

		const session = createMockSession();
		const sessionsRef = { current: [session] };
		const exitHandlers: Array<(sid: string) => void> = [];
		mockProcess.onExit.mockImplementation((handler: (sid: string) => void) => {
			exitHandlers.push(handler);
			return () => {};
		});

		const { result } = renderHook(() =>
			useAgentExecution({
				activeSession: session,
				sessionsRef,
				setSessions: vi.fn(),
				processQueuedItemRef: { current: null },
				setFlashNotification: vi.fn(),
				setSuccessFlashNotification: vi.fn(),
			})
		);

		const firstSpawn = result.current.spawnBackgroundSynopsis(
			session.id,
			session.cwd,
			'resume-1',
			'Summarize one',
			'claude-code'
		);
		await waitFor(() => {
			expect(mockProcess.spawn).toHaveBeenCalledTimes(1);
		});
		const firstSessionId = mockProcess.spawn.mock.calls[0][0].sessionId as string;

		const secondSpawn = result.current.spawnBackgroundSynopsis(
			session.id,
			session.cwd,
			'resume-2',
			'Summarize two',
			'claude-code'
		);
		await waitFor(() => {
			expect(mockProcess.spawn).toHaveBeenCalledTimes(2);
		});
		const secondSessionId = mockProcess.spawn.mock.calls[1][0].sessionId as string;

		await act(async () => {
			await result.current.cancelPendingSynopsis(session.id);
		});

		expect(mockKill).toHaveBeenCalledWith(firstSessionId);
		expect(mockKill).toHaveBeenCalledWith(secondSessionId);

		act(() => {
			for (const handler of exitHandlers) {
				handler(firstSessionId);
				handler(secondSessionId);
			}
		});

		await Promise.all([firstSpawn, secondSpawn]);
		consoleLog.mockRestore();
	});

	it('logs and clears tracking when synopsis cancellation kill fails', async () => {
		const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
		const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const killError = new Error('already exited');
		const mockKill = vi.fn().mockRejectedValue(killError);
		window.maestro.process.kill = mockKill;

		const session = createMockSession();
		const sessionsRef = { current: [session] };

		const { result } = renderHook(() =>
			useAgentExecution({
				activeSession: session,
				sessionsRef,
				setSessions: vi.fn(),
				processQueuedItemRef: { current: null },
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
		const targetSessionId = mockProcess.spawn.mock.calls[0][0].sessionId as string;

		await act(async () => {
			await result.current.cancelPendingSynopsis(session.id);
		});

		expect(mockKill).toHaveBeenCalledWith(targetSessionId);
		expect(consoleWarn).toHaveBeenCalledWith(
			'[cancelPendingSynopsis] Failed to kill synopsis session:',
			targetSessionId,
			killError
		);

		await act(async () => {
			await result.current.cancelPendingSynopsis(session.id);
		});
		expect(mockKill).toHaveBeenCalledTimes(1);

		act(() => {
			onExitHandler?.(targetSessionId);
		});
		await spawnPromise;

		consoleLog.mockRestore();
		consoleWarn.mockRestore();
	});

	it('does nothing when cancelPendingSynopsis is called with no pending synopses', async () => {
		const mockKill = vi.fn().mockResolvedValue(true);
		window.maestro.process.kill = mockKill;

		const session = createMockSession();
		const sessionsRef = { current: [session] };

		const { result } = renderHook(() =>
			useAgentExecution({
				activeSession: session,
				sessionsRef,
				setSessions: vi.fn(),
				processQueuedItemRef: { current: null },
				setFlashNotification: vi.fn(),
				setSuccessFlashNotification: vi.fn(),
			})
		);

		// Cancel with no pending synopses
		await act(async () => {
			await result.current.cancelPendingSynopsis(session.id);
		});

		// Should not have called kill
		expect(mockKill).not.toHaveBeenCalled();
	});
});
