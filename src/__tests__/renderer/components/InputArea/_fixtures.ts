import type { MutableRefObject } from 'react';
import { createMockSession as baseCreateMockSession } from '../../../helpers/mockSession';
import { mockTheme } from '../../../helpers/mockTheme';
import type { Session } from '../../../../renderer/types';

export const inputAreaTheme = mockTheme;

export function createInputAreaSession(overrides: Partial<Session> = {}): Session {
	return baseCreateMockSession({
		id: 'session-1',
		name: 'MySession',
		cwd: '/Users/test/project',
		fullPath: '/Users/test/project',
		projectRoot: '/Users/test/project',
		shellCwd: '/Users/test/project',
		shellCommandHistory: [],
		aiCommandHistory: [],
		aiTabs: [
			{
				id: 'tab-1',
				logs: [],
				agentSessionId: null,
				lastActivityAt: 0,
				scrollTop: 0,
				busyStartTime: null,
				statusMessage: null,
				contextUsage: null,
				isStarred: false,
				name: null,
				readOnlyMode: false,
				draftInput: '',
				saveToHistory: false,
			} as any,
		],
		activeTabId: 'tab-1',
		...overrides,
	});
}

export function createItemRefs<T extends HTMLElement>(length = 0): MutableRefObject<(T | null)[]> {
	return { current: Array.from({ length }, () => null) };
}
