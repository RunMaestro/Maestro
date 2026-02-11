import { describe, it, expect } from 'vitest';
import type { Session } from '../../types';
import { getNextWindowSessionCycle } from '../windowSessionOrdering';

const createMockSession = (overrides: Partial<Session> = {}): Session => ({
	id: `session-${Math.random()}`,
	name: 'Session',
	toolType: 'claude-code',
	state: 'idle',
	cwd: '/tmp',
	projectRoot: '/tmp',
	fullPath: '/tmp',
	aiLogs: [],
	shellLogs: [],
	workLog: [],
	contextUsage: 0,
	usageStats: undefined,
	inputMode: 'ai',
	aiPid: 0,
	terminalPid: 0,
	port: 0,
	isLive: false,
	changedFiles: [],
	isGitRepo: false,
	executionQueue: [],
	aiTabs: [{ id: 'tab-1', name: 'Main', logs: [] }],
	activeTabId: 'tab-1',
	closedTabHistory: [],
	filePreviewTabs: [],
	activeFileTabId: null,
	unifiedTabOrder: [],
	unifiedClosedTabHistory: [],
	fileTree: [],
	fileExplorerExpanded: [],
	fileExplorerScrollPos: 0,
	activeTimeMs: 0,
	...overrides,
});

describe('getNextWindowSessionCycle', () => {
	it('advances to the next session in the window order', () => {
		const s1 = createMockSession({ id: 's1' });
		const s2 = createMockSession({ id: 's2' });
		const result = getNextWindowSessionCycle([s1, s2], ['s1', 's2'], 's1', 'next');

		expect(result).toEqual({ sessionId: 's2', index: 1 });
	});

	it('wraps around to the first session when cycling forward past the end', () => {
		const s1 = createMockSession({ id: 's1' });
		const s2 = createMockSession({ id: 's2' });
		const result = getNextWindowSessionCycle([s1, s2], ['s1', 's2'], 's2', 'next');

		expect(result).toEqual({ sessionId: 's1', index: 0 });
	});

	it('wraps around to the last session when cycling backward from the start', () => {
		const s1 = createMockSession({ id: 's1' });
		const s2 = createMockSession({ id: 's2' });
		const result = getNextWindowSessionCycle([s1, s2], ['s1', 's2'], 's1', 'prev');

		expect(result).toEqual({ sessionId: 's2', index: 1 });
	});

	it('falls back to the first or last session when the active session is missing', () => {
		const s1 = createMockSession({ id: 's1' });
		const s2 = createMockSession({ id: 's2' });

		const forward = getNextWindowSessionCycle([s1, s2], ['s1', 's2'], null, 'next');
		const backward = getNextWindowSessionCycle([s1, s2], ['s1', 's2'], null, 'prev');

		expect(forward).toEqual({ sessionId: 's1', index: 0 });
		expect(backward).toEqual({ sessionId: 's2', index: 1 });
	});

	it('returns null when no valid sessions are assigned to the window', () => {
		const s1 = createMockSession({ id: 's1' });
		const result = getNextWindowSessionCycle([s1], ['missing'], 's1', 'next');

		expect(result).toBeNull();
	});
});
