import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { RefObject } from 'react';
import { useAgentSessionManagement } from '../../../renderer/hooks';
import type { Session, AITab, LogEntry } from '../../../renderer/types';
import { createMockSession as baseCreateMockSession } from '../../helpers/mockSession';
import type { RightPanelHandle } from '../../../renderer/components/RightPanel';
import { createMockAITab } from '../../helpers/mockTab';

type MaestroHistoryApi = typeof window.maestro.history;

type MaestroAgentSessionsApi = typeof window.maestro.agentSessions;

type MaestroClaudeApi = typeof window.maestro.claude;

const createMockTab = (overrides: Partial<AITab> = {}): AITab =>
	createMockAITab({
		createdAt: 1700000000000,
		saveToHistory: true,
		...overrides,
	});

// Thin wrapper: pre-populates an AI tab so the hook has session state to
// write history entries against.
const createMockSession = (overrides: Partial<Session> = {}): Session => {
	const baseTab = createMockTab();
	return baseCreateMockSession({
		isGitRepo: true,
		aiTabs: [baseTab],
		activeTabId: baseTab.id,
		...overrides,
	});
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

	it('uses entry contextUsage as fallback for cross-session history entries', async () => {
		const activeSession = createMockSession({
			contextUsage: 99,
			aiTabs: [createMockTab({ id: 'tab-4', name: 'Active Tab' })],
			activeTabId: 'tab-4',
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
				summary: 'Background task with context',
				sessionId: 'session-override',
				projectPath: '/override/project',
				sessionName: 'Background Session',
				contextUsage: 75, // From the spawned agent's last usage event
			});
		});

		const payload = vi.mocked(window.maestro.history.add).mock.calls[0][0];

		// Should use entry's contextUsage (75), not active session's (99)
		expect(payload.contextUsage).toBe(75);
	});

	it('switches to an existing tab when resuming a known agent session', async () => {
		const existingTab = createMockTab({
			id: 'tab-existing',
			agentSessionId: 'agent-123',
			logs: [{ id: 'log-1', timestamp: Date.now(), source: 'user', text: 'hello' }],
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

		expect(updatedSession.activeTabId).toBe('tab-existing');
		expect(updatedSession.activeFileTabId).toBeNull();
		expect(updatedSession.inputMode).toBe('ai');
	});

	it('clears activeFileTabId when resuming an existing tab from file preview', async () => {
		const existingTab = createMockTab({
			id: 'tab-existing',
			agentSessionId: 'agent-123',
			logs: [{ id: 'log-1', timestamp: Date.now(), source: 'user', text: 'hello' }],
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

	it('reloads messages from disk when existing tab has empty logs', async () => {
		const existingTab = createMockTab({
			id: 'tab-existing',
			agentSessionId: 'agent-123',
			logs: [], // Empty logs — should trigger reload from disk
		});
		const activeSession = createMockSession({
			aiTabs: [createMockTab({ id: 'tab-1' }), existingTab],
			activeTabId: 'tab-1',
			projectRoot: '/test/project',
		});
		const setSessions = vi.fn();
		const setActiveAgentSessionId = vi.fn();

		window.maestro.agentSessions.read = vi.fn().mockResolvedValue({
			messages: [
				{
					type: 'user',
					content: 'Hello from disk',
					timestamp: '2024-01-01T00:00:00.000Z',
					uuid: 'msg-1',
				},
				{
					type: 'assistant',
					content: 'Hi there',
					timestamp: '2024-01-01T00:00:01.000Z',
					uuid: 'msg-2',
				},
			],
			total: 2,
			hasMore: false,
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
			await result.current.handleResumeSession('agent-123');
		});

		// Should have loaded messages from disk since existing tab had empty logs
		expect(window.maestro.agentSessions.read).toHaveBeenCalled();
		expect(setSessions).toHaveBeenCalledOnce();
		expect(setActiveAgentSessionId).toHaveBeenCalledWith('agent-123');

		const updateFn = setSessions.mock.calls[0][0];
		const [updatedSession] = updateFn([activeSession]);

		// Should repopulate the existing tab, not create a new one
		expect(updatedSession.activeTabId).toBe('tab-existing');
		const reloadedTab = updatedSession.aiTabs.find((t: { id: string }) => t.id === 'tab-existing');
		expect(reloadedTab.logs).toHaveLength(2);
		expect(reloadedTab.logs[0].text).toBe('Hello from disk');
		expect(reloadedTab.logs[1].text).toBe('Hi there');
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
			{ offset: 0, limit: 500 }
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

	it('preserves text content from messages that include tool use', async () => {
		const activeSession = createMockSession({
			projectRoot: '/test/project',
		});
		const setSessions = vi.fn();
		const setActiveAgentSessionId = vi.fn();

		const messages = [
			{
				type: 'user',
				content: 'Read file.ts',
				timestamp: '2024-01-01T00:00:00.000Z',
				uuid: 'msg-1',
			},
			{
				type: 'assistant',
				content: 'Let me read that file',
				timestamp: '2024-01-01T00:00:01.000Z',
				uuid: 'msg-2',
				toolUse: [{ type: 'tool_use', name: 'Read', input: { path: 'file.ts' } }],
			},
			{
				type: 'assistant',
				content: 'Here is the content',
				timestamp: '2024-01-01T00:00:02.000Z',
				uuid: 'msg-3',
			},
		];

		window.maestro.agentSessions.read = vi.fn().mockResolvedValue({
			messages,
			total: messages.length,
			hasMore: false,
		});

		window.maestro.claude.getSessionOrigins = vi.fn().mockResolvedValue({});

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
			await result.current.handleResumeSession('agent-tool');
		});

		const updateFn = setSessions.mock.calls[0][0];
		const [updatedSession] = updateFn([activeSession]);
		const resumedTab = updatedSession.aiTabs.find(
			(tab: AITab) => tab.agentSessionId === 'agent-tool'
		);

		// All 3 messages should be preserved - including the one with toolUse
		expect(resumedTab?.logs).toHaveLength(3);
		expect(resumedTab?.logs[0].text).toBe('Read file.ts');
		expect(resumedTab?.logs[1].text).toBe('Let me read that file');
		expect(resumedTab?.logs[2].text).toBe('Here is the content');
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

	it('filters out tool-use-only messages with empty text content', async () => {
		const activeSession = createMockSession({
			projectRoot: '/test/project',
		});
		const setSessions = vi.fn();
		const setActiveAgentSessionId = vi.fn();

		const messages = [
			{
				type: 'user',
				content: 'Read file.ts',
				timestamp: '2024-01-01T00:00:00.000Z',
				uuid: 'msg-1',
			},
			{
				type: 'assistant',
				content: '',
				timestamp: '2024-01-01T00:00:01.000Z',
				uuid: 'msg-2',
				toolUse: [{ type: 'tool_use', name: 'Read', input: { path: 'file.ts' } }],
			},
			{
				type: 'assistant',
				content: 'Here is the content',
				timestamp: '2024-01-01T00:00:02.000Z',
				uuid: 'msg-3',
			},
		];

		window.maestro.agentSessions.read = vi.fn().mockResolvedValue({
			messages,
			total: messages.length,
			hasMore: false,
		});
		window.maestro.claude.getSessionOrigins = vi.fn().mockResolvedValue({});

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
			await result.current.handleResumeSession('agent-filter');
		});

		const updateFn = setSessions.mock.calls[0][0];
		const [updatedSession] = updateFn([activeSession]);
		const resumedTab = updatedSession.aiTabs.find(
			(tab: AITab) => tab.agentSessionId === 'agent-filter'
		);

		// Tool-use-only message (msg-2) should be filtered out
		expect(resumedTab?.logs).toHaveLength(2);
		expect(resumedTab?.logs[0].text).toBe('Read file.ts');
		expect(resumedTab?.logs[1].text).toBe('Here is the content');
	});

	it('shows flash notification when session file is not found', async () => {
		const activeSession = createMockSession({
			projectRoot: '/test/project',
		});
		const setSessions = vi.fn();
		const showFlash = vi.fn();

		window.maestro.agentSessions.read = vi
			.fn()
			.mockRejectedValue(new Error('ENOENT: no such file or directory'));
		window.maestro.claude.getSessionOrigins = vi.fn().mockResolvedValue({});

		const { result } = renderHook(() =>
			useAgentSessionManagement({
				activeSession,
				setSessions,
				setActiveAgentSessionId: vi.fn(),
				setAgentSessionsOpen: vi.fn(),
				rightPanelRef: createRightPanelRef(),
				defaultSaveToHistory: true,
				showFlash,
			})
		);

		await act(async () => {
			await result.current.handleResumeSession('nonexistent-session');
		});

		expect(showFlash).toHaveBeenCalledWith('Session file not found on disk');
		expect(setSessions).not.toHaveBeenCalled();
	});

	it('shows flash notification when all messages are empty', async () => {
		const activeSession = createMockSession({
			projectRoot: '/test/project',
		});
		const setSessions = vi.fn();
		const showFlash = vi.fn();

		// All messages have empty content (tool-use only)
		const messages = [
			{
				type: 'assistant',
				content: '',
				timestamp: '2024-01-01T00:00:01.000Z',
				uuid: 'msg-1',
				toolUse: [{ type: 'tool_use', name: 'Read', input: {} }],
			},
			{
				type: 'assistant',
				content: '   ',
				timestamp: '2024-01-01T00:00:02.000Z',
				uuid: 'msg-2',
				toolUse: [{ type: 'tool_use', name: 'Write', input: {} }],
			},
		];

		window.maestro.agentSessions.read = vi.fn().mockResolvedValue({
			messages,
			total: messages.length,
			hasMore: false,
		});
		window.maestro.claude.getSessionOrigins = vi.fn().mockResolvedValue({});

		const { result } = renderHook(() =>
			useAgentSessionManagement({
				activeSession,
				setSessions,
				setActiveAgentSessionId: vi.fn(),
				setAgentSessionsOpen: vi.fn(),
				rightPanelRef: createRightPanelRef(),
				defaultSaveToHistory: true,
				showFlash,
			})
		);

		await act(async () => {
			await result.current.handleResumeSession('empty-session');
		});

		expect(showFlash).toHaveBeenCalledWith('Session has no displayable messages');
		expect(setSessions).not.toHaveBeenCalled();
	});
});
