import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useAgentExecution } from '../../../renderer/hooks';
import type { Session, AITab, UsageStats, QueuedItem } from '../../../renderer/types';
import { createMockAITab } from '../../helpers/mockTab';
import { createMockSession as baseCreateMockSession } from '../../helpers/mockSession';

const createMockTab = (overrides: Partial<AITab> = {}): AITab =>
	createMockAITab({
		createdAt: 1700000000000,
		saveToHistory: true,
		...overrides,
	});

// Thin wrapper: pre-populates an AI tab so agent execution has a tab
// target for spawned processes.
const createMockSession = (overrides: Partial<Session> = {}): Session => {
	const baseTab = createMockTab();
	return baseCreateMockSession({
		isGitRepo: true,
		aiTabs: [baseTab],
		activeTabId: baseTab.id,
		...overrides,
	});
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
			prompts: {
				...window.maestro.prompts,
				get: vi.fn().mockResolvedValue({
					success: true,
					content: 'Maestro System Context: {{AGENT_NAME}}',
				}),
			},
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
			onExitHandler?.(targetSessionId, 0);
		});

		const resultData = await spawnPromise;

		expect(resultData).toEqual({
			success: true,
			response: 'Hello world',
			agentSessionId: 'agent-session-123',
			contextUsage: 0,
			usageStats: {
				...baseUsage,
				inputTokens: 3,
				outputTokens: 5,
				totalCostUsd: 0.03,
				reasoningTokens: undefined,
			},
		});

		expect(setSessions).toHaveBeenCalledOnce();
		const updateFn = setSessions.mock.calls[0][0];
		const [updatedSession] = updateFn([session]);

		expect(updatedSession.state).toBe('idle');
		expect(updatedSession.aiTabs[0].state).toBe('idle');
	});

	it('includes appendSystemPrompt in batch spawns', async () => {
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

		const spawnPromise = result.current.spawnAgentForSession(session.id, 'Batch task');

		await waitFor(() => {
			expect(mockProcess.spawn).toHaveBeenCalledTimes(1);
		});

		const spawnConfig = mockProcess.spawn.mock.calls[0][0];
		expect(spawnConfig.appendSystemPrompt).toBeDefined();
		expect(typeof spawnConfig.appendSystemPrompt).toBe('string');
		expect(window.maestro.prompts.get).toHaveBeenCalledWith('maestro-system-prompt');

		// Clean up
		const targetSessionId = spawnConfig.sessionId as string;
		act(() => {
			onExitHandler?.(targetSessionId);
		});
		await spawnPromise;
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
			contextUsage: 0,
			usageStats: {
				...baseUsage,
				inputTokens: 5,
				outputTokens: 3,
				totalCostUsd: 0.05,
				reasoningTokens: undefined,
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
