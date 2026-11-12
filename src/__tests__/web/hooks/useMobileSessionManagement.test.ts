/**
 * Tests for useMobileSessionManagement hook
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
	useMobileSessionManagement,
	type UseMobileSessionManagementDeps,
} from '../../../web/hooks/useMobileSessionManagement';
import type { Session } from '../../../web/hooks/useSessions';

const baseDeps: UseMobileSessionManagementDeps = {
	savedActiveSessionId: null,
	savedActiveTabId: null,
	isOffline: true,
	sendRef: { current: null },
	triggerHaptic: vi.fn(),
	hapticTapPattern: 10,
};

describe('useMobileSessionManagement', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('selects a session and syncs active tab', () => {
		const sendSpy = vi.fn();
		const { result } = renderHook(() =>
			useMobileSessionManagement({
				...baseDeps,
				sendRef: { current: sendSpy },
			})
		);

		const session: Session = {
			id: 'session-1',
			name: 'Session 1',
			toolType: 'claude-code',
			state: 'idle',
			inputMode: 'ai',
			cwd: '/tmp',
			aiTabs: [],
			activeTabId: 'tab-1',
		} as Session;

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

	it('keeps a confirmed remote tab rename through sync and reconnect reload', () => {
		const sendSpy = vi.fn();
		const tab = {
			id: 'tab-1',
			agentSessionId: 'agent-session-1',
			name: null,
			starred: false,
			inputValue: '',
			createdAt: 1700000000000,
			state: 'idle',
		};
		const session = {
			id: 'session-1',
			name: 'Session 1',
			toolType: 'claude-code',
			state: 'idle',
			inputMode: 'ai',
			cwd: '/tmp',
			aiTabs: [tab],
			activeTabId: 'tab-1',
		} as Session;
		const { result } = renderHook(() =>
			useMobileSessionManagement({
				...baseDeps,
				savedActiveSessionId: 'session-1',
				savedActiveTabId: 'tab-1',
				sendRef: { current: sendSpy },
			})
		);

		act(() => {
			result.current.setSessions([session]);
		});
		act(() => {
			result.current.handleRenameTab('tab-1', 'Client Plan');
		});
		act(() => {
			result.current.sessionsHandlers.onRenameTabResult('session-1', 'tab-1', true, 'Client Plan');
		});

		expect(sendSpy).toHaveBeenCalledWith({
			type: 'rename_tab',
			sessionId: 'session-1',
			tabId: 'tab-1',
			newName: 'Client Plan',
		});
		expect(result.current.sessions[0].aiTabs?.[0].name).toBe('Client Plan');

		const syncedTabs = [{ ...tab, name: 'Client Plan' }];
		act(() => {
			result.current.sessionsHandlers.onTabsChanged('session-1', syncedTabs, 'tab-1');
		});
		expect(result.current.sessions[0].aiTabs?.[0].name).toBe('Client Plan');

		act(() => {
			result.current.sessionsHandlers.onSessionsUpdate([{ ...session, aiTabs: syncedTabs }]);
		});
		expect(result.current.sessions[0].aiTabs?.[0].name).toBe('Client Plan');
	});

	it('does not leave a false tab name when remote rename fails', () => {
		const session = {
			id: 'session-1',
			name: 'Session 1',
			toolType: 'claude-code',
			state: 'idle',
			inputMode: 'ai',
			cwd: '/tmp',
			aiTabs: [
				{
					id: 'tab-1',
					agentSessionId: 'agent-session-1',
					name: 'Old Name',
					starred: false,
					inputValue: '',
					createdAt: 1700000000000,
					state: 'idle',
				},
			],
			activeTabId: 'tab-1',
		} as Session;
		const { result } = renderHook(() =>
			useMobileSessionManagement({
				...baseDeps,
				savedActiveSessionId: 'session-1',
				savedActiveTabId: 'tab-1',
			})
		);

		act(() => {
			result.current.setSessions([session]);
		});
		act(() => {
			result.current.sessionsHandlers.onRenameTabResult(
				'session-1',
				'tab-1',
				false,
				'False Name',
				'disk full'
			);
		});

		expect(result.current.sessions[0].aiTabs?.[0].name).toBe('Old Name');
	});
});
