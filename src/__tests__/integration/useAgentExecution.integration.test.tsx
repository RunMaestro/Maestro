import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAgentExecution } from '../../renderer/hooks/agent/useAgentExecution';
import type { AITab, QueuedItem, Session, UsageStats } from '../../renderer/types';
import { logger } from '../../renderer/utils/logger';

const createTab = (overrides: Partial<AITab> = {}): AITab => ({
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

const createSession = (overrides: Partial<Session> = {}): Session => {
	const tab = createTab();

	return {
		id: 'session-1',
		name: 'Integration Session',
		toolType: 'claude-code',
		state: 'idle',
		cwd: '/workspace/project',
		fullPath: '/workspace/project',
		projectRoot: '/workspace/project',
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
		aiTabs: [tab],
		activeTabId: tab.id,
		closedTabHistory: [],
		executionQueue: [],
		activeTimeMs: 0,
		...overrides,
	};
};

const usage = (overrides: Partial<UsageStats> = {}): UsageStats => ({
	inputTokens: 1,
	outputTokens: 2,
	cacheReadInputTokens: 3,
	cacheCreationInputTokens: 4,
	totalCostUsd: 0.01,
	contextWindow: 200000,
	...overrides,
});

function createSessionState(initialSessions: Session[]) {
	const sessionsRef = { current: initialSessions };
	const setSessions = vi.fn((updater: React.SetStateAction<Session[]>) => {
		sessionsRef.current = typeof updater === 'function' ? updater(sessionsRef.current) : updater;
	});

	return { sessionsRef, setSessions };
}

function createProcessBridge() {
	const dataHandlers: Array<(sid: string, data: string) => void> = [];
	const sessionIdHandlers: Array<(sid: string, sessionId: string) => void> = [];
	const usageHandlers: Array<(sid: string, usageStats: UsageStats) => void> = [];
	const exitHandlers: Array<(sid: string, code: number | null | undefined) => void> = [];

	const register = <T,>(handlers: T[]) =>
		vi.fn((handler: T) => {
			handlers.push(handler);
			return () => {
				const index = handlers.indexOf(handler);
				if (index >= 0) handlers.splice(index, 1);
			};
		});

	const bridge = {
		spawn: vi.fn().mockResolvedValue(undefined),
		kill: vi.fn().mockResolvedValue(true),
		onData: register(dataHandlers),
		onSessionId: register(sessionIdHandlers),
		onUsage: register(usageHandlers),
		onExit: register(exitHandlers),
		emitData: (sid: string, data: string) => dataHandlers.forEach((handler) => handler(sid, data)),
		emitSessionId: (sid: string, sessionId: string) =>
			sessionIdHandlers.forEach((handler) => handler(sid, sessionId)),
		emitUsage: (sid: string, usageStats: UsageStats) =>
			usageHandlers.forEach((handler) => handler(sid, usageStats)),
		emitExit: (sid: string, code: number | null | undefined = 0) =>
			exitHandlers.forEach((handler) => handler(sid, code)),
		handlerCounts: () => ({
			data: dataHandlers.length,
			sessionId: sessionIdHandlers.length,
			usage: usageHandlers.length,
			exit: exitHandlers.length,
		}),
	};

	return bridge;
}

describe('useAgentExecution integration', () => {
	const originalMaestro = { ...window.maestro };
	let processBridge: ReturnType<typeof createProcessBridge>;
	let recordQuery: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.clearAllMocks();
		processBridge = createProcessBridge();
		recordQuery = vi.fn().mockResolvedValue(undefined);

		Object.assign(window.maestro, {
			agents: {
				...window.maestro.agents,
				get: vi.fn().mockResolvedValue({
					id: 'claude-code',
					command: 'claude-code',
					path: '/usr/local/bin/claude-code',
					args: ['--print'],
					capabilities: { supportsStreamJsonInput: true },
				}),
			},
			process: {
				...window.maestro.process,
				spawn: processBridge.spawn,
				kill: processBridge.kill,
				onData: processBridge.onData,
				onSessionId: processBridge.onSessionId,
				onUsage: processBridge.onUsage,
				onExit: processBridge.onExit,
			},
			stats: {
				...window.maestro.stats,
				recordQuery,
			},
		});
	});

	afterEach(() => {
		vi.useRealTimers();
		Object.assign(window.maestro, originalMaestro);
	});

	it('spawns a batch agent, accumulates output and usage, records stats, and idles busy tabs', async () => {
		const session = createSession({
			state: 'busy',
			aiTabs: [
				createTab({ id: 'tab-1', state: 'busy' }),
				createTab({ id: 'tab-2', state: 'busy' }),
			],
			activeTabId: 'tab-1',
			sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
		});
		const otherSession = createSession({ id: 'other-session', name: 'Other Session' });
		const { sessionsRef, setSessions } = createSessionState([otherSession, session]);

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

		const spawnPromise = result.current.spawnAgentForSession(
			session.id,
			'Batch prompt',
			'/worktree'
		);
		await waitFor(() => expect(processBridge.spawn).toHaveBeenCalledOnce());

		const spawnConfig = processBridge.spawn.mock.calls[0][0];
		const targetSessionId = spawnConfig.sessionId as string;
		expect(spawnConfig).toMatchObject({
			toolType: 'claude-code',
			cwd: '/worktree',
			command: '/usr/local/bin/claude-code',
			args: ['--print'],
			prompt: 'Batch prompt',
			readOnlyMode: false,
			sessionSshRemoteConfig: session.sessionSshRemoteConfig,
			sendPromptViaStdin: false,
			sendPromptViaStdinRaw: false,
		});

		act(() => {
			processBridge.emitData('other-session', 'ignored');
			processBridge.emitUsage('other-session', usage({ inputTokens: 99 }));
			processBridge.emitExit('other-session');
			processBridge.emitData(targetSessionId, 'Hello ');
			processBridge.emitData(targetSessionId, 'world');
			processBridge.emitSessionId(targetSessionId, 'agent-session-1');
			processBridge.emitUsage(targetSessionId, usage({ reasoningTokens: 1 }));
			processBridge.emitUsage(
				targetSessionId,
				usage({ inputTokens: 2, outputTokens: 3, totalCostUsd: 0.02, reasoningTokens: 2 })
			);
			processBridge.emitExit(targetSessionId);
		});

		await expect(spawnPromise).resolves.toEqual({
			success: true,
			response: 'Hello world',
			agentSessionId: 'agent-session-1',
			contextUsage: 0,
			error: undefined,
			errorKind: undefined,
			usageStats: {
				...usage(),
				inputTokens: 3,
				outputTokens: 5,
				cacheReadInputTokens: 6,
				cacheCreationInputTokens: 8,
				totalCostUsd: 0.03,
				reasoningTokens: 3,
			},
		});
		await waitFor(() => expect(recordQuery).toHaveBeenCalledOnce());
		expect(recordQuery.mock.calls[0][0]).toMatchObject({
			sessionId: session.id,
			agentType: 'claude-code',
			source: 'auto',
			projectPath: '/worktree',
			tabId: 'tab-1',
			isRemote: true,
		});
		expect(sessionsRef.current[0]).toBe(otherSession);
		expect(sessionsRef.current[1].state).toBe('idle');
		expect(sessionsRef.current[1].aiTabs.map((tab) => tab.state)).toEqual(['idle', 'idle']);
		expect(processBridge.handlerCounts()).toEqual({ data: 0, sessionId: 0, usage: 0, exit: 0 });
	});

	it('handles missing sessions, agent lookup failures, and spawn failures', async () => {
		const loggerError = vi.spyOn(logger, 'error').mockImplementation(() => {});
		const session = createSession({ toolType: 'codex' });
		const { sessionsRef, setSessions } = createSessionState([session]);

		const { result } = renderHook(() =>
			useAgentExecution({
				activeSession: null,
				sessionsRef,
				setSessions,
				processQueuedItemRef: { current: null },
				setFlashNotification: vi.fn(),
				setSuccessFlashNotification: vi.fn(),
			})
		);

		await expect(result.current.spawnAgentForSession('missing', 'Prompt')).resolves.toEqual({
			success: false,
		});
		await expect(result.current.spawnAgentWithPrompt('Prompt')).resolves.toEqual({
			success: false,
		});

		vi.mocked(window.maestro.agents.get).mockResolvedValueOnce(null);
		await expect(result.current.spawnAgentForSession(session.id, 'Prompt')).resolves.toEqual({
			success: false,
		});
		expect(loggerError).toHaveBeenCalledWith(
			'[spawnAgentForSession] Agent not found for toolType: codex'
		);

		const lookupError = new Error('lookup failed');
		vi.mocked(window.maestro.agents.get).mockRejectedValueOnce(lookupError);
		await expect(result.current.spawnAgentForSession(session.id, 'Prompt')).resolves.toEqual({
			success: false,
			error: 'lookup failed',
		});
		expect(loggerError).toHaveBeenCalledWith('Error spawning agent:', undefined, lookupError);

		processBridge.spawn.mockRejectedValueOnce(new Error('spawn failed'));
		await expect(result.current.spawnAgentForSession(session.id, 'Prompt')).resolves.toEqual({
			success: false,
			error: 'spawn failed',
			errorKind: 'spawn-failed',
		});
		expect(processBridge.handlerCounts()).toEqual({ data: 0, sessionId: 0, usage: 0, exit: 0 });

		loggerError.mockRestore();
	});

	it('processes queued work and waits for non-worktree queues to drain', async () => {
		const queuedMessage: QueuedItem = {
			id: 'queued-message',
			timestamp: 1700000000100,
			tabId: 'tab-2',
			type: 'message',
			text: 'Queued user message',
			images: ['image.png'],
		};
		const session = createSession({
			state: 'busy',
			aiTabs: [createTab({ id: 'tab-1' }), createTab({ id: 'tab-2' })],
			activeTabId: 'tab-1',
			executionQueue: [queuedMessage],
		});
		const { sessionsRef, setSessions } = createSessionState([session]);
		const processQueuedItem = vi.fn().mockResolvedValue(undefined);

		const { result } = renderHook(() =>
			useAgentExecution({
				activeSession: session,
				sessionsRef,
				setSessions,
				processQueuedItemRef: { current: processQueuedItem },
				setFlashNotification: vi.fn(),
				setSuccessFlashNotification: vi.fn(),
			})
		);

		const spawnPromise = result.current.spawnAgentForSession(session.id, 'Prompt');
		await waitFor(() => expect(processBridge.spawn).toHaveBeenCalledOnce());

		act(() => {
			processBridge.emitExit(processBridge.spawn.mock.calls[0][0].sessionId);
		});

		await expect(spawnPromise).resolves.toMatchObject({ success: true });
		await waitFor(() => expect(processQueuedItem).toHaveBeenCalledWith(session.id, queuedMessage));
		expect(sessionsRef.current[0]).toMatchObject({
			state: 'busy',
			busySource: 'ai',
			activeTabId: 'tab-2',
			executionQueue: [],
			currentCycleTokens: 0,
			currentCycleBytes: 0,
			pendingAICommandForSynopsis: undefined,
		});
		expect(sessionsRef.current[0].aiTabs[1].logs[0]).toMatchObject({
			source: 'user',
			text: 'Queued user message',
			images: ['image.png'],
		});
	});

	it('uses fallback queue state when no target tab exists', async () => {
		const queuedCommand: QueuedItem = {
			id: 'queued-command',
			timestamp: 1700000000200,
			tabId: 'missing-tab',
			type: 'command',
			command: '/commit',
		};
		const session = createSession({
			state: 'busy',
			aiTabs: [],
			activeTabId: '',
			executionQueue: [queuedCommand],
		});
		const { sessionsRef, setSessions } = createSessionState([session]);

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
		await waitFor(() => expect(processBridge.spawn).toHaveBeenCalledOnce());

		act(() => {
			processBridge.emitExit(processBridge.spawn.mock.calls[0][0].sessionId);
		});

		await expect(spawnPromise).resolves.toMatchObject({ success: true });
		expect(sessionsRef.current[0]).toMatchObject({
			state: 'busy',
			busySource: 'ai',
			aiTabs: [],
			activeTabId: '',
			executionQueue: [],
			currentCycleTokens: 0,
			currentCycleBytes: 0,
			pendingAICommandForSynopsis: undefined,
		});
	});

	it('retries queue-drain polling and delegates active-session prompts', async () => {
		const queuedItem: QueuedItem = {
			id: 'queued-drain',
			timestamp: 1700000000300,
			tabId: 'tab-1',
			type: 'message',
			text: 'Queued drain message',
		};
		const session = createSession({
			state: 'busy',
			executionQueue: [queuedItem],
		});
		const sessionsRef = { current: [session] };
		const setSessions = vi.fn();

		const { result } = renderHook(() =>
			useAgentExecution({
				activeSession: session,
				sessionsRef,
				setSessions,
				processQueuedItemRef: { current: vi.fn().mockResolvedValue(undefined) },
				setFlashNotification: vi.fn(),
				setSuccessFlashNotification: vi.fn(),
			})
		);

		const spawnPromise = result.current.spawnAgentForSession(session.id, 'Drain prompt');
		let resolved = false;
		spawnPromise.then(() => {
			resolved = true;
		});
		await waitFor(() => expect(processBridge.spawn).toHaveBeenCalledOnce());

		act(() => {
			processBridge.emitExit(processBridge.spawn.mock.calls[0][0].sessionId);
		});
		await new Promise((resolve) => setTimeout(resolve, 80));
		expect(resolved).toBe(false);

		sessionsRef.current = [{ ...session, state: 'idle', executionQueue: [] }];
		await expect(spawnPromise).resolves.toMatchObject({ success: true });

		processBridge.spawn.mockClear();
		const promptPromise = result.current.spawnAgentWithPrompt('Prompt through active session');
		await waitFor(() => expect(processBridge.spawn).toHaveBeenCalledOnce());
		expect(processBridge.spawn.mock.calls[0][0]).toMatchObject({
			prompt: 'Prompt through active session',
			cwd: session.cwd,
		});

		act(() => {
			processBridge.emitExit(processBridge.spawn.mock.calls[0][0].sessionId);
		});
		await expect(promptPromise).resolves.toMatchObject({ success: true });
	});

	it('logs stats recording failures without failing batch completion', async () => {
		const loggerWarn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
		const statsError = new Error('stats unavailable');
		recordQuery.mockRejectedValueOnce(statsError);
		const session = createSession();
		const { sessionsRef, setSessions } = createSessionState([session]);

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
		await waitFor(() => expect(processBridge.spawn).toHaveBeenCalledOnce());

		act(() => {
			processBridge.emitExit(processBridge.spawn.mock.calls[0][0].sessionId);
		});

		await expect(spawnPromise).resolves.toMatchObject({ success: true });
		await waitFor(() =>
			expect(loggerWarn).toHaveBeenCalledWith(
				'[spawnAgentForSession] Failed to record query stats:',
				undefined,
				statsError
			)
		);
		loggerWarn.mockRestore();
	});

	it('spawns background synopsis sessions with resume IDs, config fallback, and overrides', async () => {
		const mainSshConfig = {
			enabled: true,
			remoteId: 'main-remote',
			workingDirOverride: '/remote/project',
		};
		const overrideSshConfig = {
			enabled: true,
			remoteId: 'override-remote',
			workingDirOverride: '/override/project',
		};
		const session = createSession({ sessionSshRemoteConfig: mainSshConfig });
		const { sessionsRef, setSessions } = createSessionState([session]);

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

		const firstSpawn = result.current.spawnBackgroundSynopsis(
			session.id,
			'/remote/project',
			'resume-1',
			'Summarize one'
		);
		await waitFor(() => expect(processBridge.spawn).toHaveBeenCalledOnce());
		const firstConfig = processBridge.spawn.mock.calls[0][0];
		expect(firstConfig).toMatchObject({
			sessionId: expect.stringMatching(/^session-1-synopsis-/),
			agentSessionId: 'resume-1',
			sessionSshRemoteConfig: mainSshConfig,
			sendPromptViaStdin: false,
			sendPromptViaStdinRaw: false,
		});

		act(() => {
			processBridge.emitData(firstConfig.sessionId, 'Summary');
			processBridge.emitSessionId(firstConfig.sessionId, 'agent-session-2');
			processBridge.emitUsage(firstConfig.sessionId, usage({ inputTokens: 4 }));
			processBridge.emitExit(firstConfig.sessionId);
		});
		await expect(firstSpawn).resolves.toMatchObject({
			success: true,
			response: 'Summary',
			agentSessionId: 'agent-session-2',
		});

		vi.mocked(window.maestro.agents.get).mockResolvedValueOnce({
			id: 'codex',
			command: 'codex',
			args: [],
			capabilities: { supportsStreamJsonInput: false },
		});
		const secondSpawn = result.current.spawnBackgroundSynopsis(
			session.id,
			'/override/project',
			'resume-2',
			'Summarize two',
			'codex',
			{
				customPath: '/custom/codex',
				customArgs: '--json',
				customEnvVars: { FOO: 'bar' },
				customModel: 'gpt-test',
				customContextWindow: 12345,
				sessionSshRemoteConfig: overrideSshConfig,
			}
		);
		await waitFor(() => expect(processBridge.spawn).toHaveBeenCalledTimes(2));
		const secondConfig = processBridge.spawn.mock.calls[1][0];
		expect(secondConfig).toMatchObject({
			toolType: 'codex',
			cwd: '/override/project',
			command: '/custom/codex',
			agentSessionId: 'resume-2',
			sessionCustomPath: '/custom/codex',
			sessionCustomArgs: '--json',
			sessionCustomEnvVars: { FOO: 'bar' },
			sessionCustomModel: 'gpt-test',
			sessionCustomContextWindow: 12345,
			sessionSshRemoteConfig: overrideSshConfig,
			sendPromptViaStdin: false,
			sendPromptViaStdinRaw: false,
		});

		act(() => {
			processBridge.emitExit(secondConfig.sessionId);
		});
		await expect(secondSpawn).resolves.toMatchObject({ success: true });
	});

	it('handles background synopsis errors and cancellation cleanup', async () => {
		const loggerError = vi.spyOn(logger, 'error').mockImplementation(() => {});
		const loggerWarn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
		const session = createSession();
		const { sessionsRef, setSessions } = createSessionState([session]);

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

		vi.mocked(window.maestro.agents.get).mockResolvedValueOnce(null);
		await expect(
			result.current.spawnBackgroundSynopsis(session.id, session.cwd, 'resume-missing', 'Prompt')
		).resolves.toEqual({ success: false });
		expect(loggerError).toHaveBeenCalledWith(
			'[spawnBackgroundSynopsis] Agent not found for toolType: claude-code'
		);

		const lookupError = new Error('synopsis lookup failed');
		vi.mocked(window.maestro.agents.get).mockRejectedValueOnce(lookupError);
		await expect(
			result.current.spawnBackgroundSynopsis(session.id, session.cwd, 'resume-error', 'Prompt')
		).resolves.toEqual({ success: false });
		expect(loggerError).toHaveBeenCalledWith(
			'Error spawning background synopsis:',
			undefined,
			lookupError
		);

		processBridge.spawn.mockRejectedValueOnce(new Error('synopsis spawn failed'));
		await expect(
			result.current.spawnBackgroundSynopsis(session.id, session.cwd, 'resume-spawn', 'Prompt')
		).resolves.toEqual({ success: false });
		expect(processBridge.handlerCounts()).toEqual({ data: 0, sessionId: 0, usage: 0, exit: 0 });

		processBridge.spawn.mockResolvedValue(undefined);
		const pendingSpawn = result.current.spawnBackgroundSynopsis(
			session.id,
			session.cwd,
			'resume-cancel',
			'Prompt'
		);
		await waitFor(() => expect(processBridge.spawn).toHaveBeenCalled());
		const targetSessionId = processBridge.spawn.mock.calls.at(-1)![0].sessionId as string;

		await act(async () => {
			await result.current.cancelPendingSynopsis(session.id);
		});
		expect(processBridge.kill).toHaveBeenCalledWith(targetSessionId);

		processBridge.kill.mockRejectedValueOnce(new Error('already exited'));
		const failedCancelSpawn = result.current.spawnBackgroundSynopsis(
			session.id,
			session.cwd,
			'resume-failed-cancel',
			'Prompt'
		);
		await waitFor(() => expect(processBridge.spawn).toHaveBeenCalledTimes(3));
		const failedCancelSessionId = processBridge.spawn.mock.calls.at(-1)![0].sessionId as string;

		await act(async () => {
			await result.current.cancelPendingSynopsis(session.id);
			await result.current.cancelPendingSynopsis('missing-session');
		});
		expect(loggerWarn).toHaveBeenCalledWith(
			'[cancelPendingSynopsis] Failed to kill synopsis session:',
			undefined,
			[failedCancelSessionId, expect.any(Error)]
		);

		act(() => {
			processBridge.emitExit(targetSessionId);
			processBridge.emitExit(failedCancelSessionId);
		});
		await Promise.all([pendingSpawn, failedCancelSpawn]);

		loggerError.mockRestore();
		loggerWarn.mockRestore();
	});

	it('auto-dismisses flash notifications and keeps refs current', () => {
		vi.useFakeTimers();
		const session = createSession();
		const { sessionsRef, setSessions } = createSessionState([session]);
		const setFlashNotification = vi.fn();
		const setSuccessFlashNotification = vi.fn();

		const { result } = renderHook(() =>
			useAgentExecution({
				activeSession: session,
				sessionsRef,
				setSessions,
				processQueuedItemRef: { current: null },
				setFlashNotification,
				setSuccessFlashNotification,
			})
		);

		expect(result.current.spawnAgentWithPromptRef.current).toBe(
			result.current.spawnAgentWithPrompt
		);
		expect(result.current.spawnBackgroundSynopsisRef.current).toBe(
			result.current.spawnBackgroundSynopsis
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
