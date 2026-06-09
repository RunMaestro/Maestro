import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useSessionNavigation } from '../../renderer/hooks/session/useSessionNavigation';
import type { UseSessionNavigationDeps } from '../../renderer/hooks/session/useSessionNavigation';
import type { NavHistoryEntry } from '../../renderer/hooks/session/useNavigationHistory';
import type { Session } from '../../renderer/types';

function makeSession(overrides: Partial<Session> & { id: string; name: string }): Session {
	return {
		id: overrides.id,
		name: overrides.name,
		aiTabs: overrides.aiTabs ?? [],
		activeTabId: overrides.activeTabId,
	} as Session;
}

function renderNavigationHook({
	sessions,
	backEntry = null,
	forwardEntry = null,
	onNavigateToGroupChat,
}: {
	sessions: Session[];
	backEntry?: NavHistoryEntry | null;
	forwardEntry?: NavHistoryEntry | null;
	onNavigateToGroupChat?: UseSessionNavigationDeps['onNavigateToGroupChat'];
}) {
	let currentSessions = sessions;
	const cyclePositionRef = { current: 7 };
	const setActiveSessionId = vi.fn();
	const setSessions = vi.fn((updater: React.SetStateAction<Session[]>) => {
		currentSessions = typeof updater === 'function' ? updater(currentSessions) : updater;
	});
	const deps: UseSessionNavigationDeps = {
		navigateBack: vi.fn(() => backEntry),
		navigateForward: vi.fn(() => forwardEntry),
		setActiveSessionId,
		setSessions,
		cyclePositionRef,
		onNavigateToGroupChat,
	};

	const hook = renderHook(() => useSessionNavigation(sessions, deps));

	return {
		...hook,
		deps,
		getSessions: () => currentSessions,
		cyclePositionRef,
		setActiveSessionId,
		setSessions,
	};
}

describe('useSessionNavigation', () => {
	it('does nothing when back and forward history have no entries', () => {
		const rendered = renderNavigationHook({
			sessions: [makeSession({ id: 'session-1', name: 'Session 1' })],
		});

		act(() => {
			rendered.result.current.handleNavBack();
			rendered.result.current.handleNavForward();
		});

		expect(rendered.deps.navigateBack).toHaveBeenCalledTimes(1);
		expect(rendered.deps.navigateForward).toHaveBeenCalledTimes(1);
		expect(rendered.setActiveSessionId).not.toHaveBeenCalled();
		expect(rendered.setSessions).not.toHaveBeenCalled();
		expect(rendered.cyclePositionRef.current).toBe(7);
	});

	it('navigates back to an existing session and resets cycle position', () => {
		const rendered = renderNavigationHook({
			sessions: [
				makeSession({ id: 'session-1', name: 'Session 1' }),
				makeSession({ id: 'session-2', name: 'Session 2' }),
			],
			backEntry: { sessionId: 'session-2' },
		});

		act(() => {
			rendered.result.current.handleNavBack();
		});

		expect(rendered.setActiveSessionId).toHaveBeenCalledWith('session-2');
		expect(rendered.cyclePositionRef.current).toBe(-1);
		expect(rendered.setSessions).not.toHaveBeenCalled();
	});

	it('navigates forward to an existing session tab when the tab exists', () => {
		const rendered = renderNavigationHook({
			sessions: [
				makeSession({
					id: 'session-1',
					name: 'Session 1',
					aiTabs: [{ id: 'tab-a' }, { id: 'tab-b' }] as Session['aiTabs'],
					activeTabId: 'tab-a',
				}),
				makeSession({ id: 'session-2', name: 'Session 2' }),
			],
			forwardEntry: { sessionId: 'session-1', tabId: 'tab-b' },
		});

		act(() => {
			rendered.result.current.handleNavForward();
		});

		expect(rendered.setActiveSessionId).toHaveBeenCalledWith('session-1');
		expect(rendered.cyclePositionRef.current).toBe(-1);
		expect(rendered.getSessions()).toMatchObject([
			{ id: 'session-1', activeTabId: 'tab-b' },
			{ id: 'session-2' },
		]);
	});

	it('leaves the active tab unchanged when the history tab is not present', () => {
		const rendered = renderNavigationHook({
			sessions: [
				makeSession({
					id: 'session-1',
					name: 'Session 1',
					aiTabs: [{ id: 'tab-a' }] as Session['aiTabs'],
					activeTabId: 'tab-a',
				}),
			],
			backEntry: { sessionId: 'session-1', tabId: 'missing-tab' },
		});

		act(() => {
			rendered.result.current.handleNavBack();
		});

		expect(rendered.setActiveSessionId).toHaveBeenCalledWith('session-1');
		expect(rendered.getSessions()).toEqual([
			expect.objectContaining({ id: 'session-1', activeTabId: 'tab-a' }),
		]);
	});

	it('handles tab history for a session without an aiTabs array', () => {
		const session = {
			id: 'session-without-tabs',
			name: 'Session Without Tabs',
		} as Session;
		const rendered = renderNavigationHook({
			sessions: [session],
			forwardEntry: { sessionId: session.id, tabId: 'tab-a' },
		});

		act(() => {
			rendered.result.current.handleNavForward();
		});

		expect(rendered.setActiveSessionId).toHaveBeenCalledWith(session.id);
		expect(rendered.getSessions()).toEqual([session]);
	});

	it('ignores history entries without a session or group chat id', () => {
		const rendered = renderNavigationHook({
			sessions: [makeSession({ id: 'session-1', name: 'Session 1' })],
			backEntry: { tabId: 'tab-only' },
		});

		act(() => {
			rendered.result.current.handleNavBack();
		});

		expect(rendered.setActiveSessionId).not.toHaveBeenCalled();
		expect(rendered.setSessions).not.toHaveBeenCalled();
		expect(rendered.cyclePositionRef.current).toBe(7);
	});

	it('ignores session history entries when the session was deleted', () => {
		const rendered = renderNavigationHook({
			sessions: [makeSession({ id: 'session-1', name: 'Session 1' })],
			forwardEntry: { sessionId: 'deleted-session' },
		});

		act(() => {
			rendered.result.current.handleNavForward();
		});

		expect(rendered.setActiveSessionId).not.toHaveBeenCalled();
		expect(rendered.setSessions).not.toHaveBeenCalled();
		expect(rendered.cyclePositionRef.current).toBe(7);
	});

	it('navigates to group chats through the provided callback', () => {
		const onNavigateToGroupChat = vi.fn().mockResolvedValue(undefined);
		const rendered = renderNavigationHook({
			sessions: [makeSession({ id: 'session-1', name: 'Session 1' })],
			backEntry: { groupChatId: 'group-chat-1' },
			onNavigateToGroupChat,
		});

		act(() => {
			rendered.result.current.handleNavBack();
		});

		expect(onNavigateToGroupChat).toHaveBeenCalledWith('group-chat-1');
		expect(rendered.setActiveSessionId).not.toHaveBeenCalled();
		expect(rendered.setSessions).not.toHaveBeenCalled();
		expect(rendered.cyclePositionRef.current).toBe(7);
	});

	it('allows group chat history entries when no callback was provided', () => {
		const rendered = renderNavigationHook({
			sessions: [makeSession({ id: 'session-1', name: 'Session 1' })],
			forwardEntry: { groupChatId: 'group-chat-1' },
		});

		act(() => {
			rendered.result.current.handleNavForward();
		});

		expect(rendered.setActiveSessionId).not.toHaveBeenCalled();
		expect(rendered.setSessions).not.toHaveBeenCalled();
		expect(rendered.cyclePositionRef.current).toBe(7);
	});
});
