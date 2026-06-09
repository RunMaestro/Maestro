/**
 * Tests for useMobileSessionManagement hook
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { webLogger } from '../../../web/utils/logger';
import {
	useMobileSessionManagement,
	type UseMobileSessionManagementDeps,
} from '../../../web/hooks/useMobileSessionManagement';
import type { Session } from '../../../web/hooks/useSessions';

vi.mock('../../../web/utils/logger', () => ({
	webLogger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

vi.mock('../../../web/utils/config', () => ({
	buildApiUrl: (endpoint: string) => `http://localhost:3000${endpoint}`,
	getMaestroConfig: () => ({
		sessionId: null,
		tabId: null,
		token: 'test-token',
		serverUrl: 'http://localhost:3000',
	}),
	updateUrlForSessionTab: vi.fn(),
}));

const baseDeps: UseMobileSessionManagementDeps = {
	savedActiveSessionId: null,
	savedActiveTabId: null,
	isOffline: true,
	sendRef: { current: null },
	triggerHaptic: vi.fn(),
	hapticTapPattern: 10,
};

const createSession = (overrides: Partial<Session> = {}): Session =>
	({
		id: 'session-1',
		name: 'Session 1',
		toolType: 'claude-code',
		state: 'idle',
		inputMode: 'ai',
		cwd: '/tmp',
		aiTabs: [],
		activeTabId: 'tab-1',
		...overrides,
	}) as Session;

describe('useMobileSessionManagement', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it('selects a session and syncs active tab', () => {
		const sendSpy = vi.fn();
		const { result } = renderHook(() =>
			useMobileSessionManagement({
				...baseDeps,
				sendRef: { current: sendSpy },
			})
		);

		const session = createSession();

		act(() => {
			result.current.setSessions([session]);
		});

		act(() => {
			result.current.handleSelectSession('session-1');
		});

		expect(result.current.activeSessionId).toBe('session-1');
		expect(result.current.activeTabId).toBe('tab-1');
		expect(sendSpy).toHaveBeenCalledWith({
			type: 'select_session',
			sessionId: 'session-1',
			tabId: 'tab-1',
		});
	});

	it('selects a session without an active tab', () => {
		const sendSpy = vi.fn();
		const { result } = renderHook(() =>
			useMobileSessionManagement({
				...baseDeps,
				sendRef: { current: sendSpy },
			})
		);

		act(() => {
			result.current.setSessions([createSession({ activeTabId: undefined as unknown as string })]);
		});

		act(() => {
			result.current.handleSelectSession('session-1');
		});

		expect(result.current.activeSessionId).toBe('session-1');
		expect(result.current.activeTabId).toBeNull();
		expect(sendSpy).toHaveBeenCalledWith({
			type: 'select_session',
			sessionId: 'session-1',
			tabId: undefined,
		});
	});

	it('clears activeTabId when the active session is removed', () => {
		const { result } = renderHook(() =>
			useMobileSessionManagement({
				...baseDeps,
				savedActiveSessionId: 'session-1',
				savedActiveTabId: 'tab-1',
			})
		);

		act(() => {
			result.current.sessionsHandlers.onSessionRemoved('session-1');
		});

		expect(result.current.activeSessionId).toBeNull();
		expect(result.current.activeTabId).toBeNull();
	});

	it('adds output logs for the active session and tab', async () => {
		const { result } = renderHook(() =>
			useMobileSessionManagement({
				...baseDeps,
				savedActiveSessionId: 'session-1',
				savedActiveTabId: 'tab-1',
			})
		);

		// Refs should be initialized immediately with saved values (no race condition)
		expect(result.current.activeSessionIdRef.current).toBe('session-1');

		act(() => {
			result.current.sessionsHandlers.onSessionOutput('session-1', 'hello', 'ai', 'tab-1');
		});

		expect(result.current.sessionLogs.aiLogs).toHaveLength(1);
		expect(result.current.sessionLogs.aiLogs[0].text).toBe('hello');
	});

	it('fetches active session logs when online', async () => {
		const fetchSpy = vi.fn().mockResolvedValue({
			ok: true,
			json: vi.fn().mockResolvedValue({
				session: {
					aiLogs: [{ id: 'ai-1', timestamp: 1, text: 'ai log', source: 'stdout' }],
					shellLogs: [{ id: 'sh-1', timestamp: 2, text: 'shell log', source: 'stdout' }],
				},
			}),
		});
		vi.stubGlobal('fetch', fetchSpy);

		const { result } = renderHook(() =>
			useMobileSessionManagement({
				...baseDeps,
				isOffline: false,
				savedActiveSessionId: 'session-1',
				savedActiveTabId: 'tab-1',
			})
		);

		await waitFor(() => {
			expect(result.current.sessionLogs.aiLogs).toHaveLength(1);
		});

		expect(fetchSpy).toHaveBeenCalledWith('http://localhost:3000/session/session-1?tabId=tab-1');
		expect(result.current.sessionLogs).toEqual({
			aiLogs: [{ id: 'ai-1', timestamp: 1, text: 'ai log', source: 'stdout' }],
			shellLogs: [{ id: 'sh-1', timestamp: 2, text: 'shell log', source: 'stdout' }],
		});
		expect(result.current.isLoadingLogs).toBe(false);
	});

	it('handles empty and non-ok session log responses', async () => {
		const fetchSpy = vi
			.fn()
			.mockResolvedValueOnce({
				ok: true,
				json: vi.fn().mockResolvedValue({ session: {} }),
			})
			.mockResolvedValueOnce({
				ok: false,
				json: vi.fn(),
			});
		vi.stubGlobal('fetch', fetchSpy);

		const { result } = renderHook(() =>
			useMobileSessionManagement({
				...baseDeps,
				isOffline: false,
				savedActiveSessionId: 'session-1',
				savedActiveTabId: null,
			})
		);

		await waitFor(() => {
			expect(webLogger.debug).toHaveBeenCalledWith(
				'Fetched session logs:',
				'Mobile',
				expect.objectContaining({
					aiLogs: 0,
					shellLogs: 0,
					requestedTabId: null,
				})
			);
		});
		expect(result.current.sessionLogs).toEqual({ aiLogs: [], shellLogs: [] });
		expect(fetchSpy).toHaveBeenCalledWith('http://localhost:3000/session/session-1');

		act(() => {
			result.current.setActiveTabId('tab-2');
		});

		await waitFor(() => {
			expect(fetchSpy).toHaveBeenCalledTimes(2);
		});
		expect(result.current.sessionLogs).toEqual({ aiLogs: [], shellLogs: [] });
	});

	it('logs fetch failures and clears loading state', async () => {
		const error = new Error('network down');
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(error));

		const { result } = renderHook(() =>
			useMobileSessionManagement({
				...baseDeps,
				isOffline: false,
				savedActiveSessionId: 'session-1',
			})
		);

		await waitFor(() => {
			expect(webLogger.error).toHaveBeenCalledWith('Failed to fetch session logs', 'Mobile', error);
		});
		expect(result.current.isLoadingLogs).toBe(false);
		expect(result.current.sessionLogs).toEqual({ aiLogs: [], shellLogs: [] });
	});

	it('selects tabs and syncs local active tab state', () => {
		const sendSpy = vi.fn();
		const hapticSpy = vi.fn();
		const { result } = renderHook(() =>
			useMobileSessionManagement({
				...baseDeps,
				savedActiveSessionId: 'session-1',
				savedActiveTabId: 'tab-1',
				sendRef: { current: sendSpy },
				triggerHaptic: hapticSpy,
			})
		);
		act(() => {
			result.current.setSessions([createSession({ activeTabId: 'tab-1' })]);
		});

		act(() => {
			result.current.handleSelectTab('tab-2');
		});

		expect(sendSpy).toHaveBeenCalledWith({
			type: 'select_tab',
			sessionId: 'session-1',
			tabId: 'tab-2',
		});
		expect(hapticSpy).toHaveBeenCalledWith(10);
		expect(result.current.activeTabId).toBe('tab-2');
		expect(result.current.sessions[0].activeTabId).toBe('tab-2');
	});

	it('keeps tab selection as a no-op with no active session', () => {
		const sendSpy = vi.fn();
		const hapticSpy = vi.fn();
		const { result } = renderHook(() =>
			useMobileSessionManagement({
				...baseDeps,
				sendRef: { current: sendSpy },
				triggerHaptic: hapticSpy,
			})
		);

		act(() => {
			result.current.handleSelectTab('tab-2');
		});

		expect(sendSpy).not.toHaveBeenCalled();
		expect(hapticSpy).not.toHaveBeenCalled();
		expect(result.current.activeTabId).toBeNull();
	});

	it('selects tabs while preserving inactive sessions', () => {
		const { result } = renderHook(() =>
			useMobileSessionManagement({
				...baseDeps,
				savedActiveSessionId: 'session-1',
				savedActiveTabId: 'tab-1',
			})
		);
		const inactiveSession = createSession({ id: 'session-2', activeTabId: 'tab-3' });
		const activeSession = createSession({ id: 'session-1', activeTabId: 'tab-1' });

		act(() => {
			result.current.setSessions([inactiveSession, activeSession]);
			result.current.handleSelectTab('tab-2');
		});

		const [stillInactive, updatedActive] = result.current.sessions;
		expect(stillInactive).toBe(inactiveSession);
		expect(updatedActive.activeTabId).toBe('tab-2');
	});

	it('adds local user input to the requested log channel', () => {
		const { result } = renderHook(() =>
			useMobileSessionManagement({
				...baseDeps,
				savedActiveSessionId: 'session-1',
			})
		);

		act(() => {
			result.current.addUserLogEntry('ls -la', 'terminal');
			result.current.addUserLogEntry('summarize', 'ai');
		});

		expect(result.current.sessionLogs.shellLogs).toHaveLength(1);
		expect(result.current.sessionLogs.shellLogs[0]).toMatchObject({
			text: 'ls -la',
			source: 'user',
		});
		expect(result.current.sessionLogs.aiLogs).toHaveLength(1);
		expect(result.current.sessionLogs.aiLogs[0]).toMatchObject({
			text: 'summarize',
			source: 'user',
		});
	});

	it('sends tab commands and applies optimistic tab and bookmark updates', () => {
		const sendSpy = vi.fn();
		const hapticSpy = vi.fn();
		const { result } = renderHook(() =>
			useMobileSessionManagement({
				...baseDeps,
				savedActiveSessionId: 'session-1',
				savedActiveTabId: 'tab-1',
				sendRef: { current: sendSpy },
				triggerHaptic: hapticSpy,
			})
		);
		const inactiveSession = createSession({
			id: 'session-2',
			name: 'Session 2',
			activeTabId: 'tab-3',
			bookmarked: false,
			aiTabs: [
				{
					id: 'tab-3',
					agentSessionId: null,
					name: 'Gamma',
					starred: false,
					inputValue: '',
					createdAt: 3,
					state: 'idle',
				},
			],
		});
		const activeSession = createSession({
			aiTabs: [
				{
					id: 'tab-1',
					agentSessionId: null,
					name: 'Alpha',
					starred: false,
					inputValue: '',
					createdAt: 1,
					state: 'idle',
				},
				{
					id: 'tab-2',
					agentSessionId: null,
					name: 'Beta',
					starred: false,
					inputValue: '',
					createdAt: 2,
					state: 'idle',
				},
			],
			bookmarked: false,
		});

		act(() => {
			result.current.setSessions([inactiveSession, activeSession]);
		});

		act(() => {
			result.current.handleRenameTab('tab-1', 'Renamed');
			result.current.handleStarTab('tab-1', true);
			result.current.handleReorderTab(0, 1);
			result.current.handleToggleBookmark('session-1');
			result.current.handleNewTab();
			result.current.handleCloseTab('tab-2');
		});

		expect(sendSpy).toHaveBeenCalledWith({
			type: 'rename_tab',
			sessionId: 'session-1',
			tabId: 'tab-1',
			newName: 'Renamed',
		});
		expect(sendSpy).toHaveBeenCalledWith({
			type: 'star_tab',
			sessionId: 'session-1',
			tabId: 'tab-1',
			starred: true,
		});
		expect(sendSpy).toHaveBeenCalledWith({
			type: 'reorder_tab',
			sessionId: 'session-1',
			fromIndex: 0,
			toIndex: 1,
		});
		expect(sendSpy).toHaveBeenCalledWith({
			type: 'toggle_bookmark',
			sessionId: 'session-1',
		});
		expect(sendSpy).toHaveBeenCalledWith({ type: 'new_tab', sessionId: 'session-1' });
		expect(sendSpy).toHaveBeenCalledWith({
			type: 'close_tab',
			sessionId: 'session-1',
			tabId: 'tab-2',
		});
		expect(hapticSpy).toHaveBeenCalledTimes(2);

		const [stillInactive, updatedActive] = result.current.sessions;
		expect(stillInactive).toBe(inactiveSession);
		expect(updatedActive.bookmarked).toBe(true);
		expect(updatedActive.aiTabs?.map((tab) => tab.id)).toEqual(['tab-2', 'tab-1']);
		expect(updatedActive.aiTabs?.find((tab) => tab.id === 'tab-1')?.starred).toBe(true);
	});

	it('keeps inactive command handlers as no-ops when there is no active session', () => {
		const sendSpy = vi.fn();
		const hapticSpy = vi.fn();
		const { result } = renderHook(() =>
			useMobileSessionManagement({
				...baseDeps,
				sendRef: { current: sendSpy },
				triggerHaptic: hapticSpy,
			})
		);

		act(() => {
			result.current.handleRenameTab('tab-1', 'Ignored');
			result.current.handleStarTab('tab-1', true);
			result.current.handleReorderTab(0, 1);
			result.current.handleNewTab();
			result.current.handleCloseTab('tab-1');
		});

		expect(sendSpy).not.toHaveBeenCalled();
		expect(hapticSpy).not.toHaveBeenCalled();
		expect(result.current.sessions).toEqual([]);
	});

	it('leaves tab order unchanged when the active session has no AI tab list', () => {
		const sendSpy = vi.fn();
		const { result } = renderHook(() =>
			useMobileSessionManagement({
				...baseDeps,
				savedActiveSessionId: 'session-1',
				sendRef: { current: sendSpy },
			})
		);
		const sessionWithoutTabs = createSession({ aiTabs: undefined });
		act(() => {
			result.current.setSessions([sessionWithoutTabs]);
			result.current.handleReorderTab(0, 1);
		});

		expect(sendSpy).toHaveBeenCalledWith({
			type: 'reorder_tab',
			sessionId: 'session-1',
			fromIndex: 0,
			toIndex: 1,
		});
		expect(result.current.sessions[0]).toBe(sessionWithoutTabs);
	});

	it('auto-selects the first session and later syncs the active tab from desktop updates', () => {
		const { result } = renderHook(() => useMobileSessionManagement(baseDeps));

		act(() => {
			result.current.sessionsHandlers.onSessionsUpdate([
				createSession({ id: 'session-1', activeTabId: 'tab-1', state: 'idle' }),
				createSession({ id: 'session-2', activeTabId: 'tab-2', state: 'busy' }),
			]);
		});

		expect(result.current.activeSessionId).toBe('session-1');
		expect(result.current.activeTabId).toBe('tab-1');

		act(() => {
			result.current.sessionsHandlers.onSessionsUpdate([
				createSession({ id: 'session-1', activeTabId: 'tab-3', state: 'busy' }),
				createSession({ id: 'session-2', activeTabId: 'tab-2', state: 'idle' }),
			]);
		});

		expect(result.current.activeSessionId).toBe('session-1');
		expect(result.current.activeTabId).toBe('tab-3');
	});

	it('handles empty session updates and first-session updates without an active tab', () => {
		const { result } = renderHook(() => useMobileSessionManagement(baseDeps));

		act(() => {
			result.current.sessionsHandlers.onSessionsUpdate([]);
		});

		expect(result.current.activeSessionId).toBeNull();
		expect(result.current.activeTabId).toBeNull();

		act(() => {
			result.current.sessionsHandlers.onSessionsUpdate([
				createSession({ activeTabId: undefined as unknown as string }),
			]);
		});

		expect(result.current.activeSessionId).toBe('session-1');
		expect(result.current.activeTabId).toBeNull();
	});

	it('keeps active tab stable when updates omit the active session, then clears missing tab IDs', () => {
		const { result } = renderHook(() =>
			useMobileSessionManagement({
				...baseDeps,
				savedActiveSessionId: 'session-1',
				savedActiveTabId: 'tab-1',
			})
		);

		act(() => {
			result.current.sessionsHandlers.onSessionsUpdate([
				createSession({ id: 'session-2', activeTabId: 'tab-2', state: 'idle' }),
			]);
		});

		expect(result.current.activeSessionId).toBe('session-1');
		expect(result.current.activeTabId).toBe('tab-1');

		act(() => {
			result.current.sessionsHandlers.onSessionsUpdate([
				createSession({
					id: 'session-1',
					activeTabId: undefined as unknown as string,
					state: 'idle',
				}),
			]);
		});

		expect(result.current.activeTabId).toBeNull();
	});

	it('reports websocket connection and error events through the web logger', () => {
		const { result } = renderHook(() => useMobileSessionManagement(baseDeps));

		act(() => {
			result.current.sessionsHandlers.onConnectionChange('connected');
			result.current.sessionsHandlers.onError('socket failed');
		});

		expect(webLogger.debug).toHaveBeenCalledWith('Connection state: connected', 'Mobile');
		expect(webLogger.error).toHaveBeenCalledWith('WebSocket error: socket failed', 'Mobile');
	});

	it('updates session lifecycle events and dispatches response and server callbacks', () => {
		const onResponseComplete = vi.fn();
		const onThemeUpdate = vi.fn();
		const onCustomCommands = vi.fn();
		const onAutoRunStateChange = vi.fn();
		const { result } = renderHook(() =>
			useMobileSessionManagement({
				...baseDeps,
				savedActiveSessionId: 'session-1',
				onResponseComplete,
				onThemeUpdate,
				onCustomCommands,
				onAutoRunStateChange,
			})
		);
		const busySession = createSession({ state: 'busy' });
		const addedSession = createSession({ id: 'session-2', state: 'busy' });

		act(() => {
			result.current.sessionsHandlers.onSessionsUpdate([busySession]);
			result.current.sessionsHandlers.onSessionStateChange('session-1', 'idle', {
				lastResponse: {
					text: 'done',
					timestamp: 123,
					source: 'stdout',
					fullLength: 4,
				},
			} as Partial<Session>);
			result.current.sessionsHandlers.onSessionAdded(addedSession);
			result.current.sessionsHandlers.onSessionAdded(addedSession);
			result.current.sessionsHandlers.onActiveSessionChanged('session-2');
			result.current.sessionsHandlers.onSessionExit('session-2', 0);
			result.current.sessionsHandlers.onThemeUpdate({ name: 'Dark', mode: 'dark' } as any);
			result.current.sessionsHandlers.onCustomCommands([{ name: 'build' }] as any);
			result.current.sessionsHandlers.onAutoRunStateChange('session-2', {
				isRunning: true,
				totalTasks: 2,
				completedTasks: 1,
				currentTaskIndex: 1,
			});
			result.current.sessionsHandlers.onAutoRunStateChange('session-2', null);
		});

		expect(onResponseComplete).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'session-1', state: 'idle' }),
			expect.objectContaining({ text: 'done' })
		);
		expect(result.current.sessions.map((session) => session.id)).toEqual([
			'session-1',
			'session-2',
		]);
		expect(result.current.sessions.find((session) => session.id === 'session-2')?.state).toBe(
			'idle'
		);
		expect(result.current.activeSessionId).toBe('session-2');
		expect(result.current.activeTabId).toBeNull();
		expect(onThemeUpdate).toHaveBeenCalledWith({ name: 'Dark', mode: 'dark' });
		expect(onCustomCommands).toHaveBeenCalledWith([{ name: 'build' }]);
		expect(onAutoRunStateChange).toHaveBeenCalledWith(
			'session-2',
			expect.objectContaining({ isRunning: true })
		);
		expect(onAutoRunStateChange).toHaveBeenCalledWith('session-2', null);
	});

	it('updates inactive session state and skips completion callback when completed session is missing', () => {
		const onResponseComplete = vi.fn();
		const { result } = renderHook(() =>
			useMobileSessionManagement({
				...baseDeps,
				onResponseComplete,
			})
		);

		act(() => {
			result.current.sessionsHandlers.onSessionsUpdate([
				createSession({ id: 'session-1', state: 'idle' }),
				createSession({ id: 'session-2', state: 'busy' }),
			]);
			result.current.sessionsHandlers.onSessionStateChange('session-2', 'busy');
		});

		expect(result.current.sessions.find((session) => session.id === 'session-1')?.state).toBe(
			'idle'
		);
		expect(result.current.sessions.find((session) => session.id === 'session-2')?.state).toBe(
			'busy'
		);

		act(() => {
			result.current.sessionsHandlers.onSessionsUpdate([]);
			result.current.sessionsHandlers.onSessionStateChange('session-2', 'idle');
		});

		expect(onResponseComplete).not.toHaveBeenCalled();
	});

	it('uses the updated session response when completion data omits one', () => {
		const onResponseComplete = vi.fn();
		const fallbackResponse = {
			text: 'fallback done',
			timestamp: 456,
			source: 'stdout',
		};
		const { result } = renderHook(() =>
			useMobileSessionManagement({
				...baseDeps,
				onResponseComplete,
			})
		);

		act(() => {
			result.current.sessionsHandlers.onSessionsUpdate([
				createSession({
					state: 'busy',
					lastResponse: fallbackResponse,
				} as Partial<Session>),
			]);
			result.current.sessionsHandlers.onSessionStateChange('session-1', 'idle');
		});

		expect(onResponseComplete).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'session-1', state: 'idle' }),
			fallbackResponse
		);
	});

	it('does not clear active selection when removing an inactive session', () => {
		const { result } = renderHook(() =>
			useMobileSessionManagement({
				...baseDeps,
				savedActiveSessionId: 'session-1',
				savedActiveTabId: 'tab-1',
			})
		);

		act(() => {
			result.current.setSessions([
				createSession({ id: 'session-1' }),
				createSession({ id: 'session-2' }),
			]);
			result.current.sessionsHandlers.onSessionRemoved('session-2');
		});

		expect(result.current.activeSessionId).toBe('session-1');
		expect(result.current.activeTabId).toBe('tab-1');
		expect(result.current.sessions.map((session) => session.id)).toEqual(['session-1']);
	});

	it('adds desktop user input only for the active session', () => {
		const { result } = renderHook(() =>
			useMobileSessionManagement({
				...baseDeps,
				savedActiveSessionId: 'session-1',
			})
		);

		act(() => {
			result.current.sessionsHandlers.onUserInput('session-2', 'ignored', 'ai');
			result.current.sessionsHandlers.onUserInput('session-1', 'prompt text', 'ai');
			result.current.sessionsHandlers.onUserInput('session-1', 'pwd', 'terminal');
		});

		expect(result.current.sessionLogs.aiLogs).toHaveLength(1);
		expect(result.current.sessionLogs.aiLogs[0]).toMatchObject({
			text: 'prompt text',
			source: 'user',
		});
		expect(result.current.sessionLogs.shellLogs).toHaveLength(1);
		expect(result.current.sessionLogs.shellLogs[0]).toMatchObject({
			text: 'pwd',
			source: 'user',
		});
	});

	it('syncs tab changes only when they belong to the active session', () => {
		const { result } = renderHook(() =>
			useMobileSessionManagement({
				...baseDeps,
				savedActiveSessionId: 'session-1',
				savedActiveTabId: 'tab-1',
			})
		);
		const nextTabs = [
			{
				id: 'tab-2',
				agentSessionId: null,
				name: 'Next',
				starred: false,
				inputValue: '',
				createdAt: 10,
				state: 'idle',
			},
		] as const;

		act(() => {
			result.current.setSessions([createSession(), createSession({ id: 'session-2' })]);
			result.current.sessionsHandlers.onTabsChanged('session-2', nextTabs as any, 'tab-ignored');
		});

		expect(result.current.activeTabId).toBe('tab-1');
		expect(result.current.sessions.find((session) => session.id === 'session-2')?.activeTabId).toBe(
			'tab-ignored'
		);

		act(() => {
			result.current.sessionsHandlers.onTabsChanged('session-1', nextTabs as any, 'tab-2');
		});

		expect(result.current.activeTabId).toBe('tab-2');
		expect(result.current.sessions.find((session) => session.id === 'session-1')?.aiTabs).toEqual(
			nextTabs
		);
	});

	it('ignores streamed output for inactive sessions', () => {
		const { result } = renderHook(() =>
			useMobileSessionManagement({
				...baseDeps,
				savedActiveSessionId: 'session-1',
			})
		);

		act(() => {
			result.current.sessionsHandlers.onSessionOutput('session-2', 'ignored', 'terminal');
		});

		expect(result.current.sessionLogs.shellLogs).toEqual([]);
		expect(webLogger.debug).toHaveBeenCalledWith('Skipping output - not active session', 'Mobile', {
			sessionId: 'session-2',
			activeSessionId: 'session-1',
		});
	});

	it('records empty active output chunks as new terminal log entries', () => {
		const { result } = renderHook(() =>
			useMobileSessionManagement({
				...baseDeps,
				savedActiveSessionId: 'session-1',
			})
		);

		act(() => {
			result.current.sessionsHandlers.onSessionOutput('session-1', '', 'terminal');
		});

		expect(result.current.sessionLogs.shellLogs).toHaveLength(1);
		expect(result.current.sessionLogs.shellLogs[0]).toMatchObject({
			text: '',
			source: 'stdout',
		});
		expect(webLogger.debug).toHaveBeenCalledWith(
			'Session output detail',
			'Mobile',
			expect.objectContaining({ dataLen: 0 })
		);
	});

	it('filters AI output for inactive tabs and appends nearby streaming chunks', () => {
		const dateSpy = vi.spyOn(Date, 'now').mockReturnValue(1000);
		const { result } = renderHook(() =>
			useMobileSessionManagement({
				...baseDeps,
				savedActiveSessionId: 'session-1',
				savedActiveTabId: 'tab-1',
			})
		);

		act(() => {
			result.current.sessionsHandlers.onSessionOutput('session-1', 'ignored', 'ai', 'tab-2');
		});

		expect(result.current.sessionLogs.aiLogs).toEqual([]);
		expect(webLogger.debug).toHaveBeenCalledWith('Skipping output - not active tab', 'Mobile', {
			sessionId: 'session-1',
			outputTabId: 'tab-2',
			activeTabId: 'tab-1',
		});

		act(() => {
			result.current.sessionsHandlers.onSessionOutput('session-1', 'first ', 'ai', 'tab-1');
			result.current.sessionsHandlers.onSessionOutput('session-1', 'second', 'ai', 'tab-1');
		});

		expect(result.current.sessionLogs.aiLogs).toHaveLength(1);
		expect(result.current.sessionLogs.aiLogs[0]).toMatchObject({
			source: 'stdout',
			text: 'first second',
			timestamp: 1000,
		});
		expect(dateSpy).toHaveBeenCalled();
	});
});
