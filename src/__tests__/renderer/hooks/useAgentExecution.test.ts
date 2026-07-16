import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useAgentExecution } from '../../../renderer/hooks';
import type { Session, AITab, UsageStats, QueuedItem } from '../../../renderer/types';
import { createMockAITab } from '../../helpers/mockTab';
import { createMockSession as baseCreateMockSession } from '../../helpers/mockSession';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { dismissCenterFlash, useCenterFlashStore } from '../../../renderer/stores/centerFlashStore';

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
				activeSessionId: session.id,
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
				activeSessionId: session.id,
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

	it('spawns Auto Run batches with full-access permissionMode', async () => {
		// Auto Run runs unattended in --print mode and must have the same
		// permission level as an interactive "Full Access" tab. Without an
		// explicit permissionMode: 'full', agents whose bypass is gated on full
		// access (e.g. Claude Code) fall back to the default permission model,
		// can't get non-interactive tool approvals, and deadlock the run.
		const session = createMockSession({
			state: 'busy',
			aiTabs: [createMockTab({ state: 'busy' })],
		});
		const sessionsRef = { current: [session] };
		const setSessions = vi.fn();
		const processQueuedItemRef = { current: null };

		const { result } = renderHook(() =>
			useAgentExecution({
				activeSessionId: session.id,
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
		expect(spawnConfig.permissionMode).toBe('full');
		expect(spawnConfig.readOnlyMode).toBe(false);

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
				activeSessionId: session.id,
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
				activeSessionId: session.id,
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
				activeSessionId: session.id,
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
				activeSessionId: session.id,
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

	it('delegates replacement and dismissal to the shared flash timer owner', () => {
		vi.useFakeTimers();
		dismissCenterFlash();
		const session = createMockSession();
		const sessionsRef = { current: [session] };

		const { result } = renderHook(() =>
			useAgentExecution({
				activeSessionId: session.id,
				sessionsRef,
				setSessions: vi.fn(),
				processQueuedItemRef: { current: null },
			})
		);

		act(() => {
			result.current.showFlashNotification('Saved');
		});
		expect(useCenterFlashStore.getState().active).toMatchObject({
			message: 'Saved',
			color: 'yellow',
			duration: 2000,
		});

		act(() => {
			result.current.showSuccessFlash('Done');
			vi.advanceTimersByTime(1999);
		});
		expect(useCenterFlashStore.getState().active?.message).toBe('Done');

		act(() => {
			vi.advanceTimersByTime(1);
		});
		expect(useCenterFlashStore.getState().active).toBeNull();
	});

	it('cancels pending synopsis sessions when cancelPendingSynopsis is called', async () => {
		const mockKill = vi.fn().mockResolvedValue(true);
		window.maestro.process.kill = mockKill;

		const session = createMockSession();
		const sessionsRef = { current: [session] };
		const setSessions = vi.fn();

		const { result } = renderHook(() =>
			useAgentExecution({
				activeSessionId: session.id,
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

		const cancellation = await spawnPromise;
		expect(cancellation).toMatchObject({ success: false, errorKind: 'cancelled' });
	});

	it('cancels each synopsis owner once and disposes every listener once', async () => {
		const mockKill = vi.fn().mockResolvedValue(true);
		const unsubscribers = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
		window.maestro.process.kill = mockKill;
		mockProcess.onData.mockReturnValueOnce(unsubscribers[0]);
		mockProcess.onSessionId.mockReturnValueOnce(unsubscribers[1]);
		mockProcess.onUsage.mockReturnValueOnce(unsubscribers[2]);
		mockProcess.onExit.mockReturnValueOnce(unsubscribers[3]);
		const session = createMockSession();
		const { result } = renderHook(() =>
			useAgentExecution({
				activeSession: session,
				sessionsRef: { current: [session] },
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
			'Summarize session'
		);
		await waitFor(() => expect(mockProcess.spawn).toHaveBeenCalledOnce());
		await act(async () => {
			await result.current.cancelPendingSynopsis(session.id);
			await result.current.cancelPendingSynopsis(session.id);
		});

		expect(mockKill).toHaveBeenCalledOnce();
		for (const unsubscribe of unsubscribers) expect(unsubscribe).toHaveBeenCalledOnce();
		await expect(spawnPromise).resolves.toMatchObject({ success: false, errorKind: 'cancelled' });
	});

	it('kills and settles active batch work on unmount without applying a stale exit state', async () => {
		const mockKill = vi.fn().mockResolvedValue(true);
		const unsubscribers = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
		window.maestro.process.kill = mockKill;
		mockProcess.onData.mockReturnValueOnce(unsubscribers[0]);
		mockProcess.onSessionId.mockReturnValueOnce(unsubscribers[1]);
		mockProcess.onUsage.mockReturnValueOnce(unsubscribers[2]);
		mockProcess.onExit.mockReturnValueOnce(unsubscribers[3]);
		const session = createMockSession({ state: 'busy' });
		const setSessions = vi.fn();
		const { result, unmount } = renderHook(() =>
			useAgentExecution({
				activeSession: session,
				sessionsRef: { current: [session] },
				setSessions,
				processQueuedItemRef: { current: null },
				setFlashNotification: vi.fn(),
				setSuccessFlashNotification: vi.fn(),
			})
		);

		const spawnPromise = result.current.spawnAgentForSession(session.id, 'Work');
		await waitFor(() => expect(mockProcess.spawn).toHaveBeenCalledOnce());
		unmount();
		expect(mockKill).toHaveBeenCalledOnce();

		for (const unsubscribe of unsubscribers) expect(unsubscribe).toHaveBeenCalledOnce();
		await expect(spawnPromise).resolves.toMatchObject({ success: false, errorKind: 'cancelled' });
		expect(setSessions).not.toHaveBeenCalled();
	});

	it('does nothing when cancelPendingSynopsis is called with no pending synopses', async () => {
		const mockKill = vi.fn().mockResolvedValue(true);
		window.maestro.process.kill = mockKill;

		const session = createMockSession();
		const sessionsRef = { current: [session] };

		const { result } = renderHook(() =>
			useAgentExecution({
				activeSessionId: session.id,
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

	// ========================================================================
	// Auto Run batch watchdog (inactivity + absolute max-duration)
	// ========================================================================
	//
	// Regression for the multi-document Auto Run hang: a stuck-but-chatty agent
	// keeps emitting output (resetting the silence timer) but never finishes, so
	// the silence-based inactivity watchdog never fires and the per-document loop
	// (which only advances once processTask resolves) hangs forever. The
	// absolute max-duration cap resolves the task regardless of output so the
	// batch loop can terminate the document and move on.
	describe('batch watchdog', () => {
		function renderForWatchdog(session: Session) {
			return renderHook(() =>
				useAgentExecution({
					activeSessionId: session.id,
					sessionsRef: { current: [session] },
					setSessions: vi.fn(),
					processQueuedItemRef: { current: null },
					setFlashNotification: vi.fn(),
					setSuccessFlashNotification: vi.fn(),
				})
			);
		}

		it('force-kills a chatty-but-stuck task once the absolute max-duration cap is exceeded, even while output keeps arriving', async () => {
			vi.useFakeTimers();
			const mockKill = vi.fn().mockResolvedValue(true);
			window.maestro.process.kill = mockKill;
			// Inactivity is generous; cap is short. Output keeps flowing so the
			// silence watchdog can NEVER fire, only the absolute cap can.
			useSettingsStore.setState({
				autoRunInactivityTimeoutMin: 10,
				autoRunMaxTaskDurationMin: 1,
			} as any);

			const session = createMockSession({ state: 'busy' });
			const { result } = renderForWatchdog(session);

			const spawnPromise = result.current.spawnAgentForSession(
				session.id,
				'Batch task',
				undefined,
				{
					isAutoRun: true,
				}
			);

			// Flush the async spawn setup so the process spawns and the watchdog
			// interval is registered under fake timers.
			await act(async () => {
				await vi.advanceTimersByTimeAsync(0);
			});
			expect(mockProcess.spawn).toHaveBeenCalledTimes(1);
			const targetSessionId = mockProcess.spawn.mock.calls[0][0].sessionId as string;

			// Emit output at 30s, keeps the silence timer well under the 10-min
			// inactivity threshold for the rest of the run.
			await act(async () => {
				await vi.advanceTimersByTimeAsync(30 * 1000);
				onDataHandler?.(targetSessionId, 'still working...');
			});
			expect(mockKill).not.toHaveBeenCalled();

			// Cross the 1-minute absolute cap.
			await act(async () => {
				await vi.advanceTimersByTimeAsync(45 * 1000);
			});

			const res = await spawnPromise;
			expect(mockKill).toHaveBeenCalledWith(targetSessionId);
			expect(res.success).toBe(false);
			expect(res.errorKind).toBe('watchdog-timeout');
		});

		it('still force-kills on silence via the inactivity watchdog when no max-duration cap is set', async () => {
			vi.useFakeTimers();
			const mockKill = vi.fn().mockResolvedValue(true);
			window.maestro.process.kill = mockKill;
			useSettingsStore.setState({
				autoRunInactivityTimeoutMin: 1,
				autoRunMaxTaskDurationMin: 0, // unlimited (absolute cap disabled)
			} as any);

			const session = createMockSession({ state: 'busy' });
			const { result } = renderForWatchdog(session);

			const spawnPromise = result.current.spawnAgentForSession(
				session.id,
				'Batch task',
				undefined,
				{
					isAutoRun: true,
				}
			);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(0);
			});
			const targetSessionId = mockProcess.spawn.mock.calls[0][0].sessionId as string;

			// No output at all → silence crosses the 1-minute inactivity threshold.
			await act(async () => {
				await vi.advanceTimersByTimeAsync(75 * 1000);
			});

			const res = await spawnPromise;
			expect(mockKill).toHaveBeenCalledWith(targetSessionId);
			expect(res.errorKind).toBe('watchdog-stalled');
		});

		it('never starts a watchdog when both inactivity and max-duration are unlimited (0)', async () => {
			vi.useFakeTimers();
			const mockKill = vi.fn().mockResolvedValue(true);
			window.maestro.process.kill = mockKill;
			useSettingsStore.setState({
				autoRunInactivityTimeoutMin: 0,
				autoRunMaxTaskDurationMin: 0,
			} as any);

			const session = createMockSession({ state: 'busy' });
			const { result } = renderForWatchdog(session);

			const spawnPromise = result.current.spawnAgentForSession(
				session.id,
				'Batch task',
				undefined,
				{
					isAutoRun: true,
				}
			);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(0);
			});
			const targetSessionId = mockProcess.spawn.mock.calls[0][0].sessionId as string;

			// Advance well past any plausible cap; nothing should kill the task.
			await act(async () => {
				await vi.advanceTimersByTimeAsync(13 * 60 * 60 * 1000);
			});
			expect(mockKill).not.toHaveBeenCalled();

			// Clean up: exit so the promise resolves.
			act(() => {
				onExitHandler?.(targetSessionId);
			});
			await spawnPromise;
		});
	});
});
