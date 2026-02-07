import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	MAX_CLOSED_TERMINAL_TABS,
	closeTerminalTab,
	createClosedTerminalTab,
	createInitialTerminalTabState,
	createTerminalTab,
	ensureTerminalTabStructure,
	getActiveTerminalTab,
	getActiveTerminalTabCount,
	setActiveTerminalTab,
	getTerminalSessionId,
	getTerminalTabDisplayName,
	hasRunningTerminalProcess,
	parseTerminalSessionId,
} from '../../../renderer/utils/terminalTabHelpers';
import type { Session, TerminalTab } from '../../../renderer/types';

vi.mock('../../../renderer/utils/ids', () => ({
	generateId: vi.fn(() => 'mock-terminal-tab-id'),
}));

function createMockTerminalTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
	return {
		id: 'tab-1',
		name: null,
		shellType: 'zsh',
		pid: 123,
		cwd: '/project',
		createdAt: 100,
		state: 'idle',
		...overrides,
	};
}

function createMockSession(overrides: Partial<Session> = {}): Session {
	return {
		terminalTabs: [],
		activeTerminalTabId: '',
		...overrides,
	} as Session;
}

describe('terminalTabHelpers', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('getActiveTerminalTab', () => {
		it('returns the active terminal tab when found', () => {
			const tab1 = createMockTerminalTab({ id: 'tab-1' });
			const tab2 = createMockTerminalTab({ id: 'tab-2' });
			const session = createMockSession({
				terminalTabs: [tab1, tab2],
				activeTerminalTabId: 'tab-2',
			});

			expect(getActiveTerminalTab(session)).toBe(tab2);
		});

		it('returns undefined when no active tab matches', () => {
			const tab1 = createMockTerminalTab({ id: 'tab-1' });
			const session = createMockSession({ terminalTabs: [tab1], activeTerminalTabId: 'missing' });

			expect(getActiveTerminalTab(session)).toBeUndefined();
		});
	});

	describe('setActiveTerminalTab', () => {
		it('updates activeTerminalTabId when selecting a different tab', () => {
			const session = createMockSession({ activeTerminalTabId: 'tab-1' });

			expect(setActiveTerminalTab(session, 'tab-2')).toEqual({
				...session,
				activeTerminalTabId: 'tab-2',
			});
		});

		it('returns the original session when selecting the already active tab', () => {
			const session = createMockSession({ activeTerminalTabId: 'tab-1' });

			expect(setActiveTerminalTab(session, 'tab-1')).toBe(session);
		});
	});

	describe('createTerminalTab', () => {
		it('creates a terminal tab with defaults', () => {
			vi.spyOn(Date, 'now').mockReturnValue(12345);

			expect(createTerminalTab()).toEqual({
				id: 'mock-terminal-tab-id',
				name: null,
				shellType: 'zsh',
				pid: 0,
				cwd: '',
				createdAt: 12345,
				state: 'idle',
			});
		});

		it('creates a terminal tab with custom values', () => {
			vi.spyOn(Date, 'now').mockReturnValue(67890);

			expect(createTerminalTab('bash', '/tmp', 'Build Shell')).toEqual({
				id: 'mock-terminal-tab-id',
				name: 'Build Shell',
				shellType: 'bash',
				pid: 0,
				cwd: '/tmp',
				createdAt: 67890,
				state: 'idle',
			});
		});

		it('creates a numbered terminal tab when name is null', () => {
			vi.spyOn(Date, 'now').mockReturnValue(98765);

			expect(createTerminalTab('fish', '/workspace', null)).toEqual({
				id: 'mock-terminal-tab-id',
				name: null,
				shellType: 'fish',
				pid: 0,
				cwd: '/workspace',
				createdAt: 98765,
				state: 'idle',
			});
		});
	});

	describe('createInitialTerminalTabState', () => {
		it('builds terminal tab session state from shell and cwd', () => {
			vi.spyOn(Date, 'now').mockReturnValue(24680);

			expect(createInitialTerminalTabState('bash', '/worktrees/feature-a')).toEqual({
				terminalTabs: [
					{
						id: 'mock-terminal-tab-id',
						name: null,
						shellType: 'bash',
						pid: 0,
						cwd: '/worktrees/feature-a',
						createdAt: 24680,
						state: 'idle',
					},
				],
				activeTerminalTabId: 'mock-terminal-tab-id',
				closedTerminalTabHistory: [],
			});
		});
	});

	describe('ensureTerminalTabStructure', () => {
		it('migrates sessions that are missing terminal tabs', () => {
			vi.spyOn(Date, 'now').mockReturnValue(43210);
			const legacySession = createMockSession({
				id: 'session-legacy',
				cwd: '/legacy/project',
				terminalTabs: undefined as unknown as TerminalTab[],
				activeTerminalTabId: '',
				closedTerminalTabHistory: undefined as unknown as Session['closedTerminalTabHistory'],
			});

			const result = ensureTerminalTabStructure(legacySession, 'bash');

			expect(result.didMigrateTerminalTabs).toBe(true);
			expect(result.session.terminalTabs).toEqual([
				{
					id: 'mock-terminal-tab-id',
					name: null,
					shellType: 'bash',
					pid: 0,
					cwd: '/legacy/project',
					createdAt: 43210,
					state: 'idle',
				},
			]);
			expect(result.session.activeTerminalTabId).toBe('mock-terminal-tab-id');
			expect(result.session.closedTerminalTabHistory).toEqual([]);
		});

		it('initializes closed terminal tab history when missing', () => {
			const tab = createMockTerminalTab({ id: 'tab-1' });
			const session = createMockSession({
				terminalTabs: [tab],
				activeTerminalTabId: tab.id,
				closedTerminalTabHistory: undefined as unknown as Session['closedTerminalTabHistory'],
			});

			const result = ensureTerminalTabStructure(session, 'zsh');

			expect(result.didMigrateTerminalTabs).toBe(false);
			expect(result.session.terminalTabs).toBe(session.terminalTabs);
			expect(result.session.closedTerminalTabHistory).toEqual([]);
		});

		it('returns unchanged session when terminal tab structure is already valid', () => {
			const tab = createMockTerminalTab({ id: 'tab-stable' });
			const session = createMockSession({
				terminalTabs: [tab],
				activeTerminalTabId: tab.id,
				closedTerminalTabHistory: [],
			});

			const result = ensureTerminalTabStructure(session, 'zsh');

			expect(result.didMigrateTerminalTabs).toBe(false);
			expect(result.session).toBe(session);
		});
	});

	describe('getTerminalTabDisplayName', () => {
		it('prefers custom tab names', () => {
			const tab = createMockTerminalTab({ name: 'Deploy Shell' });
			expect(getTerminalTabDisplayName(tab, 1)).toBe('Deploy Shell');
		});

		it('falls back to Terminal N naming', () => {
			const tab = createMockTerminalTab({ name: null });
			expect(getTerminalTabDisplayName(tab, 2)).toBe('Terminal 3');
		});
	});

	describe('terminal session id helpers', () => {
		it('builds terminal session IDs', () => {
			expect(getTerminalSessionId('session-123', 'tab-abc')).toBe('session-123-terminal-tab-abc');
		});

		it('parses valid terminal session IDs', () => {
			expect(parseTerminalSessionId('session-123-terminal-tab-abc')).toEqual({
				sessionId: 'session-123',
				tabId: 'tab-abc',
			});
		});

		it('returns null for invalid terminal session IDs', () => {
			expect(parseTerminalSessionId('session-123-ai-tab-abc')).toBeNull();
		});
	});

	describe('terminal tab state helpers', () => {
		it('detects when any terminal tab is busy', () => {
			const session = createMockSession({
				terminalTabs: [
					createMockTerminalTab({ state: 'idle' }),
					createMockTerminalTab({ id: 'tab-2', state: 'busy' }),
				],
			});

			expect(hasRunningTerminalProcess(session)).toBe(true);
		});

		it('returns false when no terminal tabs are busy', () => {
			const session = createMockSession({
				terminalTabs: [
					createMockTerminalTab({ state: 'idle' }),
					createMockTerminalTab({ id: 'tab-2', state: 'exited' }),
				],
			});

			expect(hasRunningTerminalProcess(session)).toBe(false);
		});

		it('counts non-exited terminal tabs', () => {
			const session = createMockSession({
				terminalTabs: [
					createMockTerminalTab({ state: 'idle' }),
					createMockTerminalTab({ id: 'tab-2', state: 'busy' }),
					createMockTerminalTab({ id: 'tab-3', state: 'exited' }),
				],
			});

			expect(getActiveTerminalTabCount(session)).toBe(2);
		});
	});

	describe('createClosedTerminalTab', () => {
		it('creates a closed terminal tab entry with runtime state reset', () => {
			vi.spyOn(Date, 'now').mockReturnValue(54321);
			const tab = createMockTerminalTab({ pid: 888, state: 'busy', exitCode: 1 });

			expect(createClosedTerminalTab(tab, 4)).toEqual({
				tab: {
					...tab,
					pid: 0,
					state: 'idle',
				},
				index: 4,
				closedAt: 54321,
			});
		});
	});

	describe('closeTerminalTab', () => {
		it('closes a non-active tab and preserves active selection', () => {
			vi.spyOn(Date, 'now').mockReturnValue(60001);
			const tab1 = createMockTerminalTab({ id: 'tab-1' });
			const tab2 = createMockTerminalTab({ id: 'tab-2' });
			const tab3 = createMockTerminalTab({ id: 'tab-3' });
			const session = createMockSession({
				terminalTabs: [tab1, tab2, tab3],
				activeTerminalTabId: 'tab-1',
				closedTerminalTabHistory: [],
			});

			const result = closeTerminalTab(session, 'tab-2');

			expect(result).not.toBeNull();
			expect(result?.session.terminalTabs.map((tab) => tab.id)).toEqual(['tab-1', 'tab-3']);
			expect(result?.session.activeTerminalTabId).toBe('tab-1');
			expect(result?.session.closedTerminalTabHistory).toEqual([
				{
					tab: { ...tab2, pid: 0, state: 'idle' },
					index: 1,
					closedAt: 60001,
				},
			]);
		});

		it('selects adjacent tab when closing the active tab', () => {
			const tab1 = createMockTerminalTab({ id: 'tab-1' });
			const tab2 = createMockTerminalTab({ id: 'tab-2' });
			const tab3 = createMockTerminalTab({ id: 'tab-3' });
			const session = createMockSession({
				terminalTabs: [tab1, tab2, tab3],
				activeTerminalTabId: 'tab-2',
				closedTerminalTabHistory: [],
			});

			const result = closeTerminalTab(session, 'tab-2');

			expect(result?.session.terminalTabs.map((tab) => tab.id)).toEqual(['tab-1', 'tab-3']);
			expect(result?.session.activeTerminalTabId).toBe('tab-3');
		});

		it('returns null when trying to close the only tab', () => {
			const tab1 = createMockTerminalTab({ id: 'tab-1' });
			const session = createMockSession({
				terminalTabs: [tab1],
				activeTerminalTabId: 'tab-1',
				closedTerminalTabHistory: [],
			});

			expect(closeTerminalTab(session, 'tab-1')).toBeNull();
		});

		it('returns null when tab does not exist', () => {
			const tab1 = createMockTerminalTab({ id: 'tab-1' });
			const tab2 = createMockTerminalTab({ id: 'tab-2' });
			const session = createMockSession({
				terminalTabs: [tab1, tab2],
				activeTerminalTabId: 'tab-1',
				closedTerminalTabHistory: [],
			});

			expect(closeTerminalTab(session, 'missing-tab')).toBeNull();
		});

		it('caps closed terminal tab history at MAX_CLOSED_TERMINAL_TABS', () => {
			vi.spyOn(Date, 'now').mockReturnValue(70001);
			const tab1 = createMockTerminalTab({ id: 'tab-1' });
			const tab2 = createMockTerminalTab({ id: 'tab-2' });
			const history = Array.from({ length: MAX_CLOSED_TERMINAL_TABS }, (_, index) => ({
				tab: createMockTerminalTab({ id: `closed-${index}` }),
				index,
				closedAt: index,
			}));
			const session = createMockSession({
				terminalTabs: [tab1, tab2],
				activeTerminalTabId: 'tab-1',
				closedTerminalTabHistory: history,
			});

			const result = closeTerminalTab(session, 'tab-2');

			expect(result?.session.closedTerminalTabHistory).toHaveLength(MAX_CLOSED_TERMINAL_TABS);
			expect(result?.session.closedTerminalTabHistory[0]).toMatchObject({
				index: 1,
				closedAt: 70001,
			});
		});
	});

	it('exports the expected closed terminal tab history limit', () => {
		expect(MAX_CLOSED_TERMINAL_TABS).toBe(10);
	});
});
