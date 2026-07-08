import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { RefObject } from 'react';
import { useAgentSessionManagement } from '../../renderer/hooks';
import type { Session, AITab, LogEntry, UsageStats } from '../../renderer/types';
import type { RightPanelHandle } from '../../renderer/components/RightPanel';
import { FALLBACK_CONTEXT_WINDOW } from '../../shared/agentConstants';

type MaestroHistoryApi = typeof window.maestro.history;

type MaestroAgentSessionsApi = typeof window.maestro.agentSessions;

type MaestroClaudeApi = typeof window.maestro.claude;

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

describe('useAgentSessionManagement', () => {
	const originalMaestro = { ...window.maestro };

	const createRightPanelRef = (): RefObject<RightPanelHandle | null> =>
		({ current: { refreshHistoryPanel: vi.fn() } }) as RefObject<RightPanelHandle | null>;

	beforeEach(() => {
		vi.clearAllMocks();

		window.maestro = {
			...window.maestro,
			history: {
				add: vi.fn().mockResolvedValue(true),
				getAll: vi.fn().mockResolvedValue([]),
				clear: vi.fn().mockResolvedValue(true),
				delete: vi.fn().mockResolvedValue(true),
				update: vi.fn().mockResolvedValue(true),
				getFilePath: vi.fn().mockResolvedValue(null),
				listSessions: vi.fn().mockResolvedValue([]),
				onExternalChange: vi.fn().mockReturnValue(() => {}),
				reload: vi.fn().mockResolvedValue(true),
			} satisfies MaestroHistoryApi,
			agentSessions: {
				...window.maestro.agentSessions,
				read: vi.fn().mockResolvedValue({ messages: [], total: 0, hasMore: false }),
			} satisfies MaestroAgentSessionsApi,
			claude: {
				...window.maestro.claude,
				getSessionOrigins: vi.fn().mockResolvedValue({}),
			} satisfies MaestroClaudeApi,
		};
	});

	afterEach(() => {
		Object.assign(window.maestro, originalMaestro);
	});

	it('adds history entries using active session metadata', async () => {
		const activeSession = createMockSession({
			contextUsage: 42,
			aiTabs: [createMockTab({ id: 'tab-2', name: 'Active Tab' })],
			activeTabId: 'tab-2',
		});

		const rightPanelRef = createRightPanelRef();
		const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1700000000123);

		const { result } = renderHook(() =>
			useAgentSessionManagement({
				activeSession,
				setSessions: vi.fn(),
				setActiveAgentSessionId: vi.fn(),
				setAgentSessionsOpen: vi.fn(),
				rightPanelRef,
				defaultSaveToHistory: true,
			})
		);

		await act(async () => {
			await result.current.addHistoryEntry({
				type: 'USER',
				summary: 'Summary',
				fullResponse: 'Full response',
				agentSessionId: 'agent-1',
			});
		});

		const historyAdd = vi.mocked(window.maestro.history.add);

		expect(historyAdd).toHaveBeenCalledOnce();
		const payload = historyAdd.mock.calls[0][0];

		expect(payload).toMatchObject({
			type: 'USER',
			summary: 'Summary',
			fullResponse: 'Full response',
			agentSessionId: 'agent-1',
			sessionId: activeSession.id,
			sessionName: 'Active Tab',
			projectPath: activeSession.cwd,
			contextUsage: 42,
			timestamp: 1700000000123,
		});
		expect(payload.id).toEqual(expect.any(String));
		expect(Object.prototype.hasOwnProperty.call(payload, 'contextUsage')).toBe(true);
		expect(rightPanelRef.current?.refreshHistoryPanel).toHaveBeenCalledOnce();

		nowSpy.mockRestore();
	});

	it('avoids cross-session context usage when overriding session info', async () => {
		const activeSession = createMockSession({
			contextUsage: 99,
			aiTabs: [createMockTab({ id: 'tab-3', name: 'Active Tab' })],
			activeTabId: 'tab-3',
		});

		const rightPanelRef = createRightPanelRef();

		const { result } = renderHook(() =>
			useAgentSessionManagement({
				activeSession,
				setSessions: vi.fn(),
				setActiveAgentSessionId: vi.fn(),
				setAgentSessionsOpen: vi.fn(),
				rightPanelRef,
				defaultSaveToHistory: false,
			})
		);

		await act(async () => {
			await result.current.addHistoryEntry({
				type: 'AUTO',
				summary: 'Background summary',
				sessionId: 'session-override',
				projectPath: '/override/project',
				sessionName: 'Background Session',
			});
		});

		const payload = vi.mocked(window.maestro.history.add).mock.calls[0][0];

		expect(payload).toMatchObject({
			type: 'AUTO',
			summary: 'Background summary',
			sessionId: 'session-override',
			projectPath: '/override/project',
			sessionName: 'Background Session',
		});
		expect(Object.prototype.hasOwnProperty.call(payload, 'contextUsage')).toBe(false);
	});

	it('adds active-session history without a tab name when the active tab is missing', async () => {
		const activeSession = createMockSession({
			activeTabId: 'missing-tab',
			contextUsage: 12,
		});

		const { result } = renderHook(() =>
			useAgentSessionManagement({
				activeSession,
				setSessions: vi.fn(),
				setActiveAgentSessionId: vi.fn(),
				setAgentSessionsOpen: vi.fn(),
				rightPanelRef: createRightPanelRef(),
				defaultSaveToHistory: true,
			})
		);

		await act(async () => {
			await result.current.addHistoryEntry({ type: 'USER', summary: 'Missing tab' });
		});

		const payload = vi.mocked(window.maestro.history.add).mock.calls[0][0];

		expect(payload.sessionId).toBe(activeSession.id);
		expect(payload.projectPath).toBe(activeSession.cwd);
		expect(payload.sessionName).toBeUndefined();
		expect(payload.contextUsage).toBe(12);
	});

	it('does not add history or jump to a browser session without an active session', async () => {
		const setActiveAgentSessionId = vi.fn();
		const setAgentSessionsOpen = vi.fn();

		const { result } = renderHook(() =>
			useAgentSessionManagement({
				activeSession: null,
				setSessions: vi.fn(),
				setActiveAgentSessionId,
				setAgentSessionsOpen,
				rightPanelRef: createRightPanelRef(),
				defaultSaveToHistory: true,
			})
		);

		await act(async () => {
			await result.current.addHistoryEntry({ type: 'USER', summary: 'No session' });
		});
		act(() => {
			result.current.handleJumpToAgentSession('agent-missing');
		});

		expect(window.maestro.history.add).not.toHaveBeenCalled();
		expect(setActiveAgentSessionId).not.toHaveBeenCalled();
		expect(setAgentSessionsOpen).not.toHaveBeenCalled();
	});

	it('opens the agent sessions browser at the selected agent session', () => {
		const setActiveAgentSessionId = vi.fn();
		const setAgentSessionsOpen = vi.fn();

		const { result } = renderHook(() =>
			useAgentSessionManagement({
				activeSession: createMockSession(),
				setSessions: vi.fn(),
				setActiveAgentSessionId,
				setAgentSessionsOpen,
				rightPanelRef: createRightPanelRef(),
				defaultSaveToHistory: true,
			})
		);

		act(() => {
			result.current.handleJumpToAgentSession('agent-123');
		});

		expect(setActiveAgentSessionId).toHaveBeenCalledWith('agent-123');
		expect(setAgentSessionsOpen).toHaveBeenCalledWith(true);
	});

	it('switches to an existing tab when resuming a known agent session', async () => {
		const existingTab = createMockTab({
			id: 'tab-existing',
			agentSessionId: 'agent-123',
			logs: [
				{
					id: 'loaded-message',
					timestamp: 1,
					source: 'assistant',
					text: 'Already loaded',
				},
			],
		});
		const activeSession = createMockSession({
			aiTabs: [createMockTab({ id: 'tab-1' }), existingTab],
			activeTabId: 'tab-1',
			projectRoot: '/test/project',
		});
		const setSessions = vi.fn();
		const setActiveAgentSessionId = vi.fn();

		const { result } = renderHook(() =>
			useAgentSessionManagement({
				activeSession,
				setSessions,
				setActiveAgentSessionId,
				setAgentSessionsOpen: vi.fn(),
				rightPanelRef: createRightPanelRef(),
				defaultSaveToHistory: true,
			})
		);

		await act(async () => {
			await result.current.handleResumeSession('agent-123');
		});

		expect(window.maestro.agentSessions.read).not.toHaveBeenCalled();
		expect(setSessions).toHaveBeenCalledOnce();
		expect(setActiveAgentSessionId).toHaveBeenCalledWith('agent-123');

		const updateFn = setSessions.mock.calls[0][0];
		const [updatedSession] = updateFn([activeSession]);
		const unrelatedSession = createMockSession({ id: 'session-other', name: 'Other' });

		expect(updatedSession.activeTabId).toBe('tab-existing');
		expect(updatedSession.activeFileTabId).toBeNull();
		expect(updatedSession.inputMode).toBe('ai');
		expect(updateFn([unrelatedSession])).toEqual([unrelatedSession]);
	});

	it('clears activeFileTabId when resuming an existing tab from file preview', async () => {
		const existingTab = createMockTab({
			id: 'tab-existing',
			agentSessionId: 'agent-123',
			logs: [
				{
					id: 'loaded-message',
					timestamp: 1,
					source: 'assistant',
					text: 'Already loaded',
				},
			],
		});
		const activeSession = createMockSession({
			aiTabs: [createMockTab({ id: 'tab-1' }), existingTab],
			activeTabId: 'tab-1',
			activeFileTabId: 'file-tab-1',
			projectRoot: '/test/project',
		});
		const setSessions = vi.fn();

		const { result } = renderHook(() =>
			useAgentSessionManagement({
				activeSession,
				setSessions,
				setActiveAgentSessionId: vi.fn(),
				setAgentSessionsOpen: vi.fn(),
				rightPanelRef: createRightPanelRef(),
				defaultSaveToHistory: true,
			})
		);

		await act(async () => {
			await result.current.handleResumeSession('agent-123');
		});

		const updateFn = setSessions.mock.calls[0][0];
		const [updatedSession] = updateFn([activeSession]);

		expect(updatedSession.activeTabId).toBe('tab-existing');
		expect(updatedSession.activeFileTabId).toBeNull();
		expect(updatedSession.inputMode).toBe('ai');
	});

	it('clears activeFileTabId when resuming a new agent session from file preview', async () => {
		const activeSession = createMockSession({
			activeFileTabId: 'file-tab-1',
			projectRoot: '/test/project',
		});
		const setSessions = vi.fn();

		window.maestro.agentSessions.read = vi.fn().mockResolvedValue({
			messages: [
				{ type: 'user', content: 'Hello', timestamp: '2024-01-01T00:00:00.000Z', uuid: 'msg-1' },
			],
			total: 1,
			hasMore: false,
		});

		const { result } = renderHook(() =>
			useAgentSessionManagement({
				activeSession,
				setSessions,
				setActiveAgentSessionId: vi.fn(),
				setAgentSessionsOpen: vi.fn(),
				rightPanelRef: createRightPanelRef(),
				defaultSaveToHistory: true,
			})
		);

		await act(async () => {
			await result.current.handleResumeSession('agent-new');
		});

		const updateFn = setSessions.mock.calls[0][0];
		const [updatedSession] = updateFn([activeSession]);

		expect(updatedSession.activeFileTabId).toBeNull();
		expect(updatedSession.inputMode).toBe('ai');
	});

	it('does not resume a saved session when the active session has no project root', async () => {
		const activeSession = createMockSession({ projectRoot: undefined });
		const setSessions = vi.fn();
		const setActiveAgentSessionId = vi.fn();

		const { result } = renderHook(() =>
			useAgentSessionManagement({
				activeSession,
				setSessions,
				setActiveAgentSessionId,
				setAgentSessionsOpen: vi.fn(),
				rightPanelRef: createRightPanelRef(),
				defaultSaveToHistory: true,
			})
		);

		await act(async () => {
			await result.current.handleResumeSession('agent-no-root');
		});

		expect(window.maestro.agentSessions.read).not.toHaveBeenCalled();
		expect(setSessions).not.toHaveBeenCalled();
		expect(setActiveAgentSessionId).not.toHaveBeenCalled();
	});

	it('loads messages and metadata when resuming a new agent session', async () => {
		const activeSession = createMockSession({
			projectRoot: '/test/project',
		});
		const setSessions = vi.fn();
		const setActiveAgentSessionId = vi.fn();

		const messages = [
			{ type: 'user', content: 'Hello', timestamp: '2024-01-01T00:00:00.000Z', uuid: 'msg-1' },
			{
				type: 'assistant',
				content: 'Hi there',
				timestamp: '2024-01-01T00:00:01.000Z',
				uuid: 'msg-2',
			},
		];

		window.maestro.agentSessions.read = vi.fn().mockResolvedValue({
			messages,
			total: messages.length,
			hasMore: false,
		});

		window.maestro.claude.getSessionOrigins = vi.fn().mockResolvedValue({
			'agent-456': { sessionName: 'Loaded Session', starred: true },
		});

		const { result } = renderHook(() =>
			useAgentSessionManagement({
				activeSession,
				setSessions,
				setActiveAgentSessionId,
				setAgentSessionsOpen: vi.fn(),
				rightPanelRef: createRightPanelRef(),
				defaultSaveToHistory: true,
			})
		);

		await act(async () => {
			await result.current.handleResumeSession('agent-456');
		});

		expect(window.maestro.agentSessions.read).toHaveBeenCalledWith(
			'claude-code',
			'/test/project',
			'agent-456',
			{ offset: 0, limit: 500 },
			undefined
		);
		expect(window.maestro.claude.getSessionOrigins).toHaveBeenCalledOnce();
		expect(setActiveAgentSessionId).toHaveBeenCalledWith('agent-456');

		const updateFn = setSessions.mock.calls[0][0];
		const [updatedSession] = updateFn([activeSession]);
		const resumedTab = updatedSession.aiTabs.find((tab) => tab.agentSessionId === 'agent-456');

		expect(resumedTab).toBeTruthy();
		expect(resumedTab?.name).toBe('Loaded Session');
		expect(resumedTab?.starred).toBe(true);
		expect(resumedTab?.logs).toEqual<LogEntry[]>([
			{
				id: 'msg-1',
				timestamp: new Date('2024-01-01T00:00:00.000Z').getTime(),
				source: 'user',
				text: 'Hello',
			},
			{
				id: 'msg-2',
				timestamp: new Date('2024-01-01T00:00:01.000Z').getTime(),
				source: 'stdout',
				text: 'Hi there',
			},
		]);
		expect(updatedSession.activeFileTabId).toBeNull();
		expect(updatedSession.inputMode).toBe('ai');
	});

	it('uses Claude defaults and message fallbacks for sessions without a tool type', async () => {
		const activeSession = createMockSession({
			projectRoot: '/test/project',
			toolType: undefined,
		});
		const setSessions = vi.fn();

		window.maestro.agentSessions.read = vi.fn().mockResolvedValue({
			messages: [
				{
					type: 'assistant',
					content: 'Restored output',
					timestamp: '2024-01-01T00:00:00.000Z',
					uuid: '',
				},
			],
			total: 1,
			hasMore: false,
		});

		const { result } = renderHook(() =>
			useAgentSessionManagement({
				activeSession,
				setSessions,
				setActiveAgentSessionId: vi.fn(),
				setAgentSessionsOpen: vi.fn(),
				rightPanelRef: createRightPanelRef(),
				defaultSaveToHistory: true,
			})
		);

		await act(async () => {
			await result.current.handleResumeSession('agent-defaults');
		});

		expect(window.maestro.agentSessions.read).toHaveBeenCalledWith(
			'claude-code',
			'/test/project',
			'agent-defaults',
			{ offset: 0, limit: 500 },
			undefined
		);

		const updateFn = setSessions.mock.calls[0][0];
		const [updatedSession] = updateFn([activeSession]);
		const resumedTab = updatedSession.aiTabs.find((tab) => tab.agentSessionId === 'agent-defaults');

		expect(resumedTab?.logs).toEqual([
			expect.objectContaining({
				id: expect.any(String),
				source: 'stdout',
				text: 'Restored output',
			}),
		]);
	});

	it('rebuilds usage stats from stored context usage when resuming Claude sessions', async () => {
		const activeSession = createMockSession({ projectRoot: '/test/project' });
		const setSessions = vi.fn();
		const usageStats: UsageStats = {
			inputTokens: 10,
			outputTokens: 7,
			cacheReadInputTokens: 3,
			cacheCreationInputTokens: 2,
			totalCostUsd: 0.42,
			contextWindow: 2000,
			reasoningTokens: 5,
		};

		window.maestro.claude.getSessionOrigins = vi.fn().mockResolvedValue({
			'agent-context': {
				sessionName: 'Context Session',
				starred: true,
				contextUsage: 25,
			},
		});
		window.maestro.agentSessions.read = vi.fn().mockResolvedValue({
			messages: [
				{
					type: 'assistant',
					content: 'Context restored',
					timestamp: '2024-01-01T00:00:00.000Z',
					uuid: 'msg-context',
				},
			],
			total: 1,
			hasMore: false,
		});

		const { result } = renderHook(() =>
			useAgentSessionManagement({
				activeSession,
				setSessions,
				setActiveAgentSessionId: vi.fn(),
				setAgentSessionsOpen: vi.fn(),
				rightPanelRef: createRightPanelRef(),
				defaultSaveToHistory: false,
			})
		);

		await act(async () => {
			await result.current.handleResumeSession(
				'agent-context',
				undefined,
				undefined,
				undefined,
				usageStats
			);
		});

		const updateFn = setSessions.mock.calls[0][0];
		const [updatedSession] = updateFn([activeSession]);
		const resumedTab = updatedSession.aiTabs.find((tab) => tab.agentSessionId === 'agent-context');

		expect(resumedTab?.name).toBe('Context Session');
		expect(resumedTab?.starred).toBe(true);
		expect(resumedTab?.usageStats).toEqual({
			inputTokens: 500,
			outputTokens: 7,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			totalCostUsd: 0.42,
			contextWindow: 2000,
			reasoningTokens: 5,
		});
	});

	it('rebuilds stored context usage with fallback usage stats when no stats are provided', async () => {
		const activeSession = createMockSession({ projectRoot: '/test/project' });
		const setSessions = vi.fn();

		window.maestro.claude.getSessionOrigins = vi.fn().mockResolvedValue({
			'agent-context-fallback': {
				contextUsage: 10,
			},
		});
		window.maestro.agentSessions.read = vi.fn().mockResolvedValue({
			messages: [
				{
					type: 'assistant',
					content: 'Context fallback restored',
					timestamp: '2024-01-01T00:00:00.000Z',
					uuid: 'msg-context-fallback',
				},
			],
			total: 1,
			hasMore: false,
		});

		const { result } = renderHook(() =>
			useAgentSessionManagement({
				activeSession,
				setSessions,
				setActiveAgentSessionId: vi.fn(),
				setAgentSessionsOpen: vi.fn(),
				rightPanelRef: createRightPanelRef(),
				defaultSaveToHistory: true,
			})
		);

		await act(async () => {
			await result.current.handleResumeSession('agent-context-fallback');
		});

		const updateFn = setSessions.mock.calls[0][0];
		const [updatedSession] = updateFn([activeSession]);
		const resumedTab = updatedSession.aiTabs.find(
			(tab) => tab.agentSessionId === 'agent-context-fallback'
		);

		expect(resumedTab?.usageStats).toEqual({
			inputTokens: Math.round((10 * FALLBACK_CONTEXT_WINDOW) / 100),
			outputTokens: 0,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			totalCostUsd: 0,
			contextWindow: FALLBACK_CONTEXT_WINDOW,
			reasoningTokens: undefined,
		});
	});

	it('skips message fetch when messages are already provided', async () => {
		const activeSession = createMockSession({ projectRoot: '/test/project' });
		const setSessions = vi.fn();

		const { result } = renderHook(() =>
			useAgentSessionManagement({
				activeSession,
				setSessions,
				setActiveAgentSessionId: vi.fn(),
				setAgentSessionsOpen: vi.fn(),
				rightPanelRef: createRightPanelRef(),
				defaultSaveToHistory: true,
			})
		);

		const providedMessages: LogEntry[] = [
			{
				id: 'msg-3',
				timestamp: 1700000000200,
				source: 'stdout',
				text: 'Loaded',
			},
		];

		await act(async () => {
			await result.current.handleResumeSession(
				'agent-789',
				providedMessages,
				'Named Session',
				false
			);
		});

		// Origin lookup is still called to get contextUsage for context window persistence
		expect(window.maestro.claude.getSessionOrigins).toHaveBeenCalled();
		// But message fetch should be skipped since messages were provided
		expect(window.maestro.agentSessions.read).not.toHaveBeenCalled();
	});

	it('keeps provided session name and starred state ahead of origin metadata', async () => {
		const activeSession = createMockSession({ projectRoot: '/test/project' });
		const setSessions = vi.fn();

		window.maestro.claude.getSessionOrigins = vi.fn().mockResolvedValue({
			'agent-provided': { sessionName: 'Origin Name', starred: true },
		});

		const { result } = renderHook(() =>
			useAgentSessionManagement({
				activeSession,
				setSessions,
				setActiveAgentSessionId: vi.fn(),
				setAgentSessionsOpen: vi.fn(),
				rightPanelRef: createRightPanelRef(),
				defaultSaveToHistory: true,
			})
		);

		await act(async () => {
			await result.current.handleResumeSession(
				'agent-provided',
				[{ id: 'msg-1', timestamp: 1700000000000, source: 'stdout', text: 'Loaded' }],
				'Provided Name',
				false
			);
		});

		const updateFn = setSessions.mock.calls[0][0];
		const [updatedSession] = updateFn([activeSession]);
		const resumedTab = updatedSession.aiTabs.find((tab) => tab.agentSessionId === 'agent-provided');

		expect(resumedTab?.name).toBe('Provided Name');
		expect(resumedTab?.starred).toBe(false);
	});

	it('leaves unrelated sessions unchanged inside the resume state updater', async () => {
		const activeSession = createMockSession({ projectRoot: '/test/project' });
		const unrelatedSession = createMockSession({ id: 'session-other', name: 'Other' });
		const setSessions = vi.fn();

		const { result } = renderHook(() =>
			useAgentSessionManagement({
				activeSession,
				setSessions,
				setActiveAgentSessionId: vi.fn(),
				setAgentSessionsOpen: vi.fn(),
				rightPanelRef: createRightPanelRef(),
				defaultSaveToHistory: true,
			})
		);

		await act(async () => {
			await result.current.handleResumeSession('agent-new', [
				{ id: 'msg-1', timestamp: 1700000000000, source: 'stdout', text: 'Loaded' },
			]);
		});

		const updateFn = setSessions.mock.calls[0][0];

		expect(updateFn([unrelatedSession])).toEqual([unrelatedSession]);
	});

	it('logs metadata lookup failures and still resumes with provided messages', async () => {
		const activeSession = createMockSession({ projectRoot: '/test/project' });
		const setSessions = vi.fn();
		window.maestro.claude.getSessionOrigins = vi
			.fn()
			.mockRejectedValue(new Error('origin read failed'));

		const { result } = renderHook(() =>
			useAgentSessionManagement({
				activeSession,
				setSessions,
				setActiveAgentSessionId: vi.fn(),
				setAgentSessionsOpen: vi.fn(),
				rightPanelRef: createRightPanelRef(),
				defaultSaveToHistory: true,
			})
		);

		await act(async () => {
			await result.current.handleResumeSession('agent-warn', [
				{ id: 'msg-1', timestamp: 1700000000000, source: 'stdout', text: 'Loaded' },
			]);
		});

		expect(window.maestro.logger.log).toHaveBeenCalledWith(
			'warn',
			'[handleResumeSession] Failed to lookup session metadata:',
			undefined,
			expect.any(Error)
		);
		expect(setSessions).toHaveBeenCalledOnce();
	});

	it('logs read failures without switching the active agent session', async () => {
		const activeSession = createMockSession({ projectRoot: '/test/project' });
		const setSessions = vi.fn();
		const setActiveAgentSessionId = vi.fn();
		window.maestro.agentSessions.read = vi.fn().mockRejectedValue(new Error('read failed'));

		const { result } = renderHook(() =>
			useAgentSessionManagement({
				activeSession,
				setSessions,
				setActiveAgentSessionId,
				setAgentSessionsOpen: vi.fn(),
				rightPanelRef: createRightPanelRef(),
				defaultSaveToHistory: true,
			})
		);

		await act(async () => {
			await result.current.handleResumeSession('agent-read-fails');
		});

		expect(window.maestro.logger.log).toHaveBeenCalledWith(
			'error',
			'Failed to resume session:',
			undefined,
			expect.any(Error)
		);
		expect(setSessions).not.toHaveBeenCalled();
		expect(setActiveAgentSessionId).not.toHaveBeenCalled();
	});
});
