import { describe, expect, it } from 'vitest';
import type { Session } from '../../../renderer/types';
import {
	getWindowActiveSession,
	getWindowSessions,
} from '../../../renderer/utils/windowSessionScope';

function createSession(id: string): Session {
	return {
		id,
		name: id,
		createdAt: new Date('2026-05-20T00:00:00.000Z'),
		workingDirectory: '/tmp',
		projectRoot: '/tmp',
		status: 'idle',
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
});
