import { describe, expect, it } from 'vitest';
import type { Session } from '../../../renderer/types';
import {
	getThinkingItemsForSessions,
	getWindowActiveSession,
	getWindowScopedIds,
	getWindowSessions,
} from '../../../renderer/utils/windowSessionScope';

function createSession(id: string, overrides: Partial<Session> = {}): Session {
	return {
		id,
		name: id,
		createdAt: new Date('2026-05-20T00:00:00.000Z'),
		workingDirectory: '/tmp',
		projectRoot: '/tmp',
		status: 'idle',
		state: 'idle',
		busySource: undefined,
		logs: [],
		queue: [],
		agents: [],
		scheduledTasks: [],
		aiTabs: [],
		activeTabId: '',
		activeFileTabId: null,
		filePreviewTabs: [],
		unifiedTabOrder: [],
		inputMode: 'ai',
		agentId: 'claude-code',
		...overrides,
	} as Session;
}

describe('windowSessionScope', () => {
	const sessions = [
		createSession('session-1'),
		createSession('session-2'),
		createSession('session-3'),
	];

	it('returns all sessions before window state is initialized', () => {
		expect(getWindowSessions(sessions, null, ['session-1'])).toEqual(sessions);
	});

	it('returns only sessions owned by the current window', () => {
		expect(getWindowSessions(sessions, 'window-1', ['session-1', 'session-3'])).toEqual([
			sessions[0],
			sessions[2],
		]);
	});

	it('keeps the store active session when it belongs to this window', () => {
		const activeSession = getWindowActiveSession({
			sessions,
			windowSessions: [sessions[0], sessions[2]],
			windowId: 'window-1',
			windowSessionIds: ['session-1', 'session-3'],
			storeActiveSession: sessions[2],
			windowActiveSessionId: 'session-1',
		});

		expect(activeSession).toBe(sessions[2]);
	});

	it('uses the window active session when the store active session belongs elsewhere', () => {
		const activeSession = getWindowActiveSession({
			sessions,
			windowSessions: [sessions[0], sessions[2]],
			windowId: 'window-1',
			windowSessionIds: ['session-1', 'session-3'],
			storeActiveSession: sessions[1],
			windowActiveSessionId: 'session-3',
		});

		expect(activeSession).toBe(sessions[2]);
	});

	it('falls back to the first window session when no active session belongs to this window', () => {
		const activeSession = getWindowActiveSession({
			sessions,
			windowSessions: [sessions[0], sessions[2]],
			windowId: 'window-1',
			windowSessionIds: ['session-1', 'session-3'],
			storeActiveSession: sessions[1],
			windowActiveSessionId: 'session-2',
		});

		expect(activeSession).toBe(sessions[0]);
	});

	it('builds thinking items only from the sessions passed by the caller', () => {
		const visibleBusySession = createSession('visible', {
			id: 'visible',
			state: 'busy',
			busySource: 'ai',
			aiTabs: [
				{
					id: 'visible-tab',
					state: 'busy',
					name: null,
					agentSessionId: 'agent-session-visible',
				},
			] as Session['aiTabs'],
		});
		const hiddenBusySession = createSession('hidden', {
			id: 'hidden',
			state: 'busy',
			busySource: 'ai',
			aiTabs: [
				{
					id: 'hidden-tab',
					state: 'busy',
					name: null,
					agentSessionId: 'agent-session-hidden',
				},
			] as Session['aiTabs'],
		});

		const items = getThinkingItemsForSessions([visibleBusySession]);

		expect(items).toHaveLength(1);
		expect(items[0].session.id).toBe('visible');
		expect(items[0].tab?.id).toBe('visible-tab');
		expect(items.some((item) => item.session.id === hiddenBusySession.id)).toBe(false);
	});

	it('keeps active batch session ids scoped to the current desktop window', () => {
		expect(getWindowScopedIds(['visible', 'hidden'], 'window-1', ['visible'])).toEqual(['visible']);
	});

	it('does not scope ids before window state is initialized', () => {
		expect(getWindowScopedIds(['visible', 'hidden'], null, [])).toEqual(['visible', 'hidden']);
	});
});
