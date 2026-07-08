import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	useMobileSessionManagement,
	type UseMobileSessionManagementDeps,
} from '../../web/hooks/useMobileSessionManagement';
import type { Session } from '../../web/hooks/useSessions';
import type { AITabData, AutoRunState, CustomCommand } from '../../web/hooks/useWebSocket';
import { webLogger } from '../../web/utils/logger';

function installConfig(sessionId: string | null = null, tabId: string | null = null) {
	window.history.replaceState({}, '', '/token-1');
	window.__MAESTRO_CONFIG__ = {
		securityToken: 'token-1',
		sessionId,
		tabId,
		apiBase: '/token-1/api',
		wsUrl: '/token-1/ws',
	};
}

function deps(
	overrides: Partial<UseMobileSessionManagementDeps> = {}
): UseMobileSessionManagementDeps {
	return {
		savedActiveSessionId: null,
		savedActiveTabId: null,
		isOffline: true,
		sendRef: { current: null },
		triggerHaptic: vi.fn(),
		hapticTapPattern: 10,
		...overrides,
	};
}

function tab(overrides: Partial<AITabData> = {}): AITabData {
	return {
		id: 'tab-1',
		agentSessionId: null,
		name: 'Main',
		starred: false,
		inputValue: '',
		createdAt: 1,
		state: 'idle',
		...overrides,
	};
}

function session(overrides: Partial<Session> = {}): Session {
	return {
		id: 'session-1',
		name: 'Session 1',
		toolType: 'claude-code',
		state: 'idle',
		inputMode: 'ai',
		cwd: '/workspace',
		aiTabs: [tab()],
		activeTabId: 'tab-1',
		bookmarked: false,
		...overrides,
	};
}

describe('useMobileSessionManagement integration', () => {
	beforeEach(() => {
		installConfig();
		webLogger.setEnabled(false);
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		webLogger.reset();
		delete window.__MAESTRO_CONFIG__;
	});

	it('initializes from injected config and fetches active-tab logs from the real API URL builder', async () => {
		installConfig('session-url', 'tab-url');
		const fetchSpy = vi.fn().mockResolvedValue({
			ok: true,
			json: vi.fn().mockResolvedValue({
				session: {
					activeTabId: 'tab-url',
					aiLogs: [{ id: 'ai-1', timestamp: 1, text: 'ai log', source: 'stdout' }],
					shellLogs: [{ id: 'sh-1', timestamp: 2, text: 'shell log', source: 'stdout' }],
				},
			}),
		});
		vi.stubGlobal('fetch', fetchSpy);

		const { result } = renderHook(() =>
			useMobileSessionManagement(
				deps({
					isOffline: false,
					savedActiveSessionId: 'saved-session',
					savedActiveTabId: 'saved-tab',
				})
			)
		);

		await waitFor(() => expect(result.current.sessionLogs.aiLogs).toHaveLength(1));

		expect(result.current.activeSessionId).toBe('session-url');
		expect(result.current.activeTabId).toBe('tab-url');
		expect(fetchSpy).toHaveBeenCalledWith(
			'http://localhost:3000/token-1/api/session/session-url?tabId=tab-url',
			expect.objectContaining({ signal: expect.any(Object) })
		);
		expect(result.current.sessionLogs.shellLogs[0].text).toBe('shell log');
		expect(window.location.pathname).toBe('/token-1/session/session-url');
		expect(window.location.search).toBe('?tabId=tab-url');
	});

	it('selects sessions and tabs while sending desktop commands and optimistic updates', () => {
		const sendSpy = vi.fn();
		const hapticSpy = vi.fn();
		const inactive = session({
			id: 'session-2',
			name: 'Session 2',
			activeTabId: 'tab-3',
			aiTabs: [tab({ id: 'tab-3', name: 'Gamma' })],
		});
		const active = session({
			id: 'session-1',
			activeTabId: 'tab-1',
			aiTabs: [tab({ id: 'tab-1', name: 'Alpha' }), tab({ id: 'tab-2', name: 'Beta' })],
		});
		const { result } = renderHook(() =>
			useMobileSessionManagement(
				deps({
					sendRef: { current: sendSpy },
					triggerHaptic: hapticSpy,
				})
			)
		);

		act(() => {
			result.current.setSessions([inactive, active]);
		});
		act(() => {
			result.current.handleSelectSession('session-1');
		});
		act(() => {
			result.current.handleSelectTab('tab-2');
			result.current.handleRenameTab('tab-2', 'Renamed');
			result.current.handleStarTab('tab-2', true);
			result.current.handleReorderTab(0, 1);
			result.current.handleToggleBookmark('session-1');
			result.current.handleNewTab();
			result.current.handleCloseTab('tab-1');
		});

		expect(sendSpy).toHaveBeenCalledWith({
			type: 'select_session',
			sessionId: 'session-1',
			tabId: 'tab-1',
		});
		expect(sendSpy).toHaveBeenCalledWith({
			type: 'select_tab',
			sessionId: 'session-1',
			tabId: 'tab-2',
		});
		expect(sendSpy).toHaveBeenCalledWith({
			type: 'rename_tab',
			sessionId: 'session-1',
			tabId: 'tab-2',
			newName: 'Renamed',
		});
		expect(sendSpy).toHaveBeenCalledWith({
			type: 'star_tab',
			sessionId: 'session-1',
			tabId: 'tab-2',
			starred: true,
		});
		expect(sendSpy).toHaveBeenCalledWith({
			type: 'reorder_tab',
			sessionId: 'session-1',
			fromIndex: 0,
			toIndex: 1,
		});
		expect(sendSpy).toHaveBeenCalledWith({ type: 'toggle_bookmark', sessionId: 'session-1' });
		expect(sendSpy).toHaveBeenCalledWith({ type: 'new_tab', sessionId: 'session-1' });
		expect(sendSpy).toHaveBeenCalledWith({
			type: 'close_tab',
			sessionId: 'session-1',
			tabId: 'tab-1',
		});
		expect(hapticSpy).toHaveBeenCalledTimes(4);
		expect(result.current.activeSession?.id).toBe('session-1');
		expect(result.current.activeTabId).toBe('tab-2');
		expect(result.current.sessions[0]).toBe(inactive);
		expect(result.current.sessions[1].bookmarked).toBe(true);
		expect(result.current.sessions[1].aiTabs?.map((item) => item.id)).toEqual(['tab-2', 'tab-1']);
		expect(result.current.sessions[1].aiTabs?.find((item) => item.id === 'tab-2')?.starred).toBe(
			true
		);
	});

	it('applies websocket lifecycle updates and dispatches server callback bridges', () => {
		const onResponseComplete = vi.fn();
		const onThemeUpdate = vi.fn();
		const onBionifyReadingModeUpdate = vi.fn();
		const onCustomCommands = vi.fn();
		const onAutoRunStateChange = vi.fn();
		const busy = session({ state: 'busy' });
		const added = session({ id: 'session-2', state: 'busy', activeTabId: 'tab-2' });
		const commands: CustomCommand[] = [
			{ id: 'cmd-1', command: '/build', description: 'Build', prompt: 'Build it' },
		];
		const autoRun: AutoRunState = {
			isRunning: true,
			totalTasks: 4,
			completedTasks: 2,
			currentTaskIndex: 2,
		};
		const { result } = renderHook(() =>
			useMobileSessionManagement(
				deps({
					onResponseComplete,
					onThemeUpdate,
					onBionifyReadingModeUpdate,
					onCustomCommands,
					onAutoRunStateChange,
				})
			)
		);

		act(() => {
			result.current.sessionsHandlers.onSessionsUpdate([busy]);
			result.current.sessionsHandlers.onSessionStateChange('session-1', 'idle', {
				lastResponse: { text: 'done', timestamp: 3, source: 'stdout', fullLength: 4 },
			} as Partial<Session>);
			result.current.sessionsHandlers.onSessionAdded(added);
			result.current.sessionsHandlers.onSessionAdded(added);
			result.current.sessionsHandlers.onActiveSessionChanged('session-2');
			result.current.sessionsHandlers.onSessionExit('session-2', 0);
			result.current.sessionsHandlers.onThemeUpdate({ name: 'Dark', mode: 'dark' } as any);
			result.current.sessionsHandlers.onBionifyReadingModeUpdate(true);
			result.current.sessionsHandlers.onCustomCommands(commands);
			result.current.sessionsHandlers.onAutoRunStateChange('session-2', autoRun);
			result.current.sessionsHandlers.onAutoRunStateChange('session-2', null);
			result.current.sessionsHandlers.onSessionRemoved('session-1');
			result.current.sessionsHandlers.onSessionRemoved('session-2');
		});

		expect(onResponseComplete).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'session-1', state: 'idle' }),
			expect.objectContaining({ text: 'done' })
		);
		expect(onThemeUpdate).toHaveBeenCalledWith({ name: 'Dark', mode: 'dark' });
		expect(onBionifyReadingModeUpdate).toHaveBeenCalledWith(true);
		expect(onCustomCommands).toHaveBeenCalledWith(commands);
		expect(onAutoRunStateChange).toHaveBeenCalledWith('session-2', autoRun);
		expect(onAutoRunStateChange).toHaveBeenCalledWith('session-2', null);
		expect(result.current.sessions).toEqual([]);
		expect(result.current.activeSessionId).toBeNull();
		expect(result.current.activeTabId).toBeNull();
	});

	it('filters and appends active output, desktop input, and local user log entries', () => {
		const dateSpy = vi.spyOn(Date, 'now').mockReturnValue(1000);
		const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.25);
		const { result } = renderHook(() =>
			useMobileSessionManagement(
				deps({
					savedActiveSessionId: 'session-1',
					savedActiveTabId: 'tab-1',
				})
			)
		);

		act(() => {
			result.current.sessionsHandlers.onSessionOutput('session-2', 'ignored', 'terminal');
			result.current.sessionsHandlers.onSessionOutput('session-1', 'ignored', 'ai', 'tab-2');
			result.current.sessionsHandlers.onSessionOutput('session-1', 'first ', 'ai', 'tab-1');
			result.current.sessionsHandlers.onSessionOutput('session-1', 'second', 'ai', 'tab-1');
			result.current.sessionsHandlers.onSessionOutput('session-1', '', 'terminal');
			result.current.sessionsHandlers.onUserInput('session-2', 'ignored', 'ai');
			result.current.sessionsHandlers.onUserInput('session-1', 'prompt text', 'ai');
			result.current.sessionsHandlers.onUserInput('session-1', 'pwd', 'terminal');
			result.current.addUserLogEntry('local prompt', 'ai');
			result.current.addUserLogEntry('ls -la', 'terminal');
		});

		expect(result.current.sessionLogs.aiLogs).toHaveLength(3);
		expect(result.current.sessionLogs.aiLogs[0]).toMatchObject({
			source: 'stdout',
			text: 'first second',
			timestamp: 1000,
		});
		expect(result.current.sessionLogs.aiLogs[1]).toMatchObject({
			source: 'user',
			text: 'prompt text',
		});
		expect(result.current.sessionLogs.aiLogs[2]).toMatchObject({
			source: 'user',
			text: 'local prompt',
		});
		expect(result.current.sessionLogs.shellLogs.map((entry) => entry.text)).toEqual([
			'',
			'pwd',
			'ls -la',
		]);
		expect(dateSpy).toHaveBeenCalled();
		expect(randomSpy).toHaveBeenCalled();
	});

	it('handles empty, non-ok, and rejected log fetches without retaining stale loading state', async () => {
		const fetchSpy = vi
			.fn()
			.mockResolvedValueOnce({
				ok: true,
				json: vi.fn().mockResolvedValue({ session: {} }),
			})
			.mockResolvedValueOnce({ ok: false, json: vi.fn() })
			.mockRejectedValueOnce(new Error('network down'));
		vi.stubGlobal('fetch', fetchSpy);
		const { result } = renderHook(() =>
			useMobileSessionManagement(
				deps({
					isOffline: false,
					savedActiveSessionId: 'session-1',
				})
			)
		);

		await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
		expect(result.current.sessionLogs).toEqual({ aiLogs: [], shellLogs: [] });

		act(() => {
			result.current.setActiveTabId('tab-2');
		});
		await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
		expect(result.current.sessionLogs).toEqual({ aiLogs: [], shellLogs: [] });

		act(() => {
			result.current.setActiveTabId('tab-3');
		});
		await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(3));
		await waitFor(() => expect(result.current.isLoadingLogs).toBe(false));
		expect(fetchSpy).toHaveBeenLastCalledWith(
			'http://localhost:3000/token-1/api/session/session-1?tabId=tab-3',
			expect.objectContaining({ signal: expect.any(Object) })
		);
	});

	it('ignores tab commands without an active session and still exposes websocket diagnostics', () => {
		const sendSpy = vi.fn();
		const hapticSpy = vi.fn();
		const { result } = renderHook(() =>
			useMobileSessionManagement(
				deps({
					sendRef: { current: sendSpy },
					triggerHaptic: hapticSpy,
				})
			)
		);

		act(() => {
			result.current.handleSelectTab('tab-1');
			result.current.handleNewTab();
			result.current.handleCloseTab('tab-1');
			result.current.handleRenameTab('tab-1', 'Renamed');
			result.current.handleStarTab('tab-1', true);
			result.current.handleReorderTab(0, 1);
			result.current.sessionsHandlers.onConnectionChange('connected' as any);
			result.current.sessionsHandlers.onError('socket failed');
		});

		expect(sendSpy).not.toHaveBeenCalled();
		expect(hapticSpy).not.toHaveBeenCalled();
		expect(result.current.activeSessionId).toBeNull();
		expect(result.current.activeTabId).toBeNull();
	});

	it('syncs active tabs from session snapshots and desktop tab-change events', () => {
		const updatedTabs = [
			tab({ id: 'tab-fresh', name: 'Fresh' }),
			tab({ id: 'tab-next', name: 'Next' }),
		];
		const { result } = renderHook(() =>
			useMobileSessionManagement(
				deps({
					savedActiveSessionId: 'session-1',
					savedActiveTabId: 'tab-old',
				})
			)
		);

		act(() => {
			result.current.sessionsHandlers.onSessionsUpdate([
				session({
					activeTabId: 'tab-current',
					aiTabs: [tab({ id: 'tab-current', name: 'Current' })],
				}),
			]);
		});

		expect(result.current.activeTabId).toBe('tab-current');

		act(() => {
			result.current.sessionsHandlers.onTabsChanged('session-1', updatedTabs, 'tab-next');
		});

		expect(result.current.activeTabId).toBe('tab-next');
		expect(result.current.sessions[0].activeTabId).toBe('tab-next');
		expect(result.current.sessions[0].aiTabs).toEqual(updatedTabs);
	});
});
