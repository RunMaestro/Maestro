import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { RefObject } from 'react';
import { useAgentSessionManagement } from '../../../renderer/hooks';
import type { Session, AITab, LogEntry } from '../../../renderer/types';
import type { RightPanelHandle } from '../../../renderer/components/RightPanel';

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
				list: vi.fn().mockResolvedValue([]),
				getOrigins: vi.fn().mockResolvedValue({}),
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

	it('switches to an existing tab when resuming a known agent session', async () => {
		const existingTab = createMockTab({ id: 'tab-existing', agentSessionId: 'agent-123' });
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

		expect(updatedSession.activeTabId).toBe('tab-existing');
		expect(updatedSession.activeFileTabId).toBeNull();
		expect(updatedSession.inputMode).toBe('ai');
	});

	it('clears activeFileTabId when resuming an existing tab from file preview', async () => {
		const existingTab = createMockTab({ id: 'tab-existing', agentSessionId: 'agent-123' });
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
			{ offset: 0, limit: 100 },
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

	it('resolves canonical OpenClaw session IDs before reading resumed session', async () => {
		const activeSession = createMockSession({
			toolType: 'openclaw',
			projectRoot: '/test/project',
		});
		const setSessions = vi.fn();
		const setActiveAgentSessionId = vi.fn();

		window.maestro.agentSessions.list = vi
			.fn()
			.mockResolvedValue([{ sessionId: 'main:abc-123', lastUpdated: '2024-01-01T00:00:00.000Z' }]);
		window.maestro.agentSessions.read = vi.fn().mockResolvedValue({
			messages: [
				{
					type: 'assistant',
					content: 'Welcome back',
					timestamp: '2024-01-01T00:00:00.000Z',
					uuid: 'msg-1',
				},
			],
			total: 1,
			hasMore: false,
		});
		window.maestro.agentSessions.getOrigins = vi.fn().mockResolvedValue({
			'main:abc-123': { sessionName: 'Saved Main Session', starred: false },
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
			await result.current.handleResumeSession('abc-123');
		});

		expect(window.maestro.agentSessions.list).toHaveBeenCalledOnce();
		expect(window.maestro.agentSessions.read).toHaveBeenCalledWith(
			'openclaw',
			'/test/project',
			'main:abc-123',
			{ offset: 0, limit: 100 },
			undefined
		);
		expect(setActiveAgentSessionId).toHaveBeenCalledWith('main:abc-123');

		const updateFn = setSessions.mock.calls[0][0];
		const [updatedSession] = updateFn([activeSession]);
		const resumedTab = updatedSession.aiTabs.find((tab) => tab.agentSessionId === 'main:abc-123');
		expect(resumedTab).toBeTruthy();
	});

	it('uses remote OpenClaw session storage context when resuming over SSH', async () => {
		const activeSession = createMockSession({
			toolType: 'openclaw',
			projectRoot: '/local/project',
			sshRemoteId: 'ssh-remote-1',
			remoteCwd: '/remote/project',
			sessionSshRemoteConfig: {
				enabled: true,
				remoteId: 'ssh-remote-1',
				workingDirOverride: '/remote/fallback',
			},
		});
		const setSessions = vi.fn();
		const setActiveAgentSessionId = vi.fn();

		window.maestro.agentSessions.list = vi
			.fn()
			.mockResolvedValue([{ sessionId: 'main:remote-abc' }]);
		window.maestro.agentSessions.read = vi.fn().mockResolvedValue({
			messages: [
				{
					type: 'assistant',
					content: 'Remote welcome back',
					timestamp: '2024-01-01T00:00:00.000Z',
					uuid: 'msg-remote-1',
				},
			],
			total: 1,
			hasMore: false,
		});
		window.maestro.agentSessions.getOrigins = vi
			.fn()
			.mockResolvedValueOnce({})
			.mockResolvedValueOnce({
				'main:remote-abc': { sessionName: 'Remote Session', starred: true },
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
			await result.current.handleResumeSession('remote-abc');
		});

		expect(window.maestro.agentSessions.list).toHaveBeenCalledWith(
			'openclaw',
			'/remote/project',
			'ssh-remote-1'
		);
		expect(window.maestro.agentSessions.read).toHaveBeenCalledWith(
			'openclaw',
			'/remote/project',
			'main:remote-abc',
			{ offset: 0, limit: 100 },
			'ssh-remote-1'
		);
		expect(window.maestro.agentSessions.getOrigins).toHaveBeenNthCalledWith(
			1,
			'openclaw',
			'/remote/project'
		);
		expect(window.maestro.agentSessions.getOrigins).toHaveBeenNthCalledWith(
			2,
			'openclaw',
			'/local/project'
		);
		expect(setActiveAgentSessionId).toHaveBeenCalledWith('main:remote-abc');

		const updateFn = setSessions.mock.calls[0][0];
		const [updatedSession] = updateFn([activeSession]);
		const resumedTab = updatedSession.aiTabs.find(
			(tab) => tab.agentSessionId === 'main:remote-abc'
		);

		expect(resumedTab?.name).toBe('Remote Session');
		expect(resumedTab?.starred).toBe(true);
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
});
