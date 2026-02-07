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
	reorderTerminalTabs,
	reopenTerminalTab,
	setActiveTerminalTab,
	renameTerminalTab,
	getTerminalSessionId,
	getTerminalTabDisplayName,
	hasRunningTerminalProcess,
	parseTerminalSessionId,
	updateTerminalTabCwd,
	updateTerminalTabState,
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

	describe('renameTerminalTab', () => {
		it('updates the matching tab name when renamed', () => {
			const tab1 = createMockTerminalTab({ id: 'tab-1', name: null });
			const tab2 = createMockTerminalTab({ id: 'tab-2', name: 'Build' });
			const session = createMockSession({
				terminalTabs: [tab1, tab2],
				activeTerminalTabId: 'tab-1',
			});

			const renamed = renameTerminalTab(session, 'tab-1', 'Deploy');

			expect(renamed).not.toBe(session);
			expect(renamed.terminalTabs[0].name).toBe('Deploy');
			expect(renamed.terminalTabs[1]).toBe(tab2);
		});

		it('normalizes blank names to null', () => {
			const tab = createMockTerminalTab({ id: 'tab-1', name: 'Named Tab' });
			const session = createMockSession({ terminalTabs: [tab], activeTerminalTabId: tab.id });

			const renamed = renameTerminalTab(session, tab.id, '   ');

			expect(renamed.terminalTabs[0].name).toBeNull();
		});

		it('returns the original session when tab is missing', () => {
			const tab = createMockTerminalTab({ id: 'tab-1', name: null });
			const session = createMockSession({ terminalTabs: [tab], activeTerminalTabId: tab.id });

			expect(renameTerminalTab(session, 'tab-999', 'Anything')).toBe(session);
		});

		it('returns the original session when name does not change', () => {
			const tab = createMockTerminalTab({ id: 'tab-1', name: 'Build' });
			const session = createMockSession({ terminalTabs: [tab], activeTerminalTabId: tab.id });

			expect(renameTerminalTab(session, 'tab-1', 'Build')).toBe(session);
		});
	});

	describe('reorderTerminalTabs', () => {
		it('reorders terminal tabs when both indices are valid', () => {
			const tab1 = createMockTerminalTab({ id: 'tab-1' });
			const tab2 = createMockTerminalTab({ id: 'tab-2' });
			const tab3 = createMockTerminalTab({ id: 'tab-3' });
			const session = createMockSession({
				terminalTabs: [tab1, tab2, tab3],
				activeTerminalTabId: 'tab-1',
			});

			const reordered = reorderTerminalTabs(session, 0, 2);

			expect(reordered).not.toBe(session);
			expect(reordered.terminalTabs.map((tab) => tab.id)).toEqual(['tab-2', 'tab-3', 'tab-1']);
			expect(reordered.activeTerminalTabId).toBe('tab-1');
		});

		it('returns original session when indices are unchanged', () => {
			const tab1 = createMockTerminalTab({ id: 'tab-1' });
			const tab2 = createMockTerminalTab({ id: 'tab-2' });
			const session = createMockSession({
				terminalTabs: [tab1, tab2],
				activeTerminalTabId: 'tab-1',
			});

			expect(reorderTerminalTabs(session, 1, 1)).toBe(session);
		});

		it('returns original session when indices are out of bounds', () => {
			const tab1 = createMockTerminalTab({ id: 'tab-1' });
			const tab2 = createMockTerminalTab({ id: 'tab-2' });
			const session = createMockSession({
				terminalTabs: [tab1, tab2],
				activeTerminalTabId: 'tab-1',
			});

			expect(reorderTerminalTabs(session, -1, 1)).toBe(session);
			expect(reorderTerminalTabs(session, 0, 4)).toBe(session);
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
		describe('updateTerminalTabCwd', () => {
			it('updates cwd for the matching tab only', () => {
				const tab1 = createMockTerminalTab({ id: 'tab-1', cwd: '/project' });
				const tab2 = createMockTerminalTab({ id: 'tab-2', cwd: '/tmp' });
				const session = createMockSession({
					terminalTabs: [tab1, tab2],
					activeTerminalTabId: 'tab-1',
				});

				const updated = updateTerminalTabCwd(session, 'tab-2', '/workspace');

				expect(updated).not.toBe(session);
				expect(updated.terminalTabs[0]).toBe(tab1);
				expect(updated.terminalTabs[1]).toMatchObject({
					id: 'tab-2',
					cwd: '/workspace',
				});
			});

			it('returns original session when no cwd changes occur', () => {
				const tab = createMockTerminalTab({ id: 'tab-1', cwd: '/project' });
				const session = createMockSession({
					terminalTabs: [tab],
					activeTerminalTabId: 'tab-1',
				});

				expect(updateTerminalTabCwd(session, 'tab-1', '/project')).toBe(session);
				expect(updateTerminalTabCwd(session, 'missing-tab', '/elsewhere')).toBe(session);
			});
		});

		describe('updateTerminalTabState', () => {
			it('updates tab state and preserves exit code for exited tabs', () => {
				const tab1 = createMockTerminalTab({ id: 'tab-1', state: 'busy' });
				const tab2 = createMockTerminalTab({ id: 'tab-2', state: 'idle' });
				const session = createMockSession({
					terminalTabs: [tab1, tab2],
					activeTerminalTabId: 'tab-1',
				});

				const updated = updateTerminalTabState(session, 'tab-2', 'exited', 130);

				expect(updated).not.toBe(session);
				expect(updated.terminalTabs[0]).toBe(tab1);
				expect(updated.terminalTabs[1]).toMatchObject({
					id: 'tab-2',
					state: 'exited',
					exitCode: 130,
				});
			});

			it('clears exitCode when transitioning out of exited state', () => {
				const tab = createMockTerminalTab({ id: 'tab-1', state: 'exited', exitCode: 1 });
				const session = createMockSession({
					terminalTabs: [tab],
					activeTerminalTabId: 'tab-1',
				});

				const updated = updateTerminalTabState(session, 'tab-1', 'idle');

				expect(updated.terminalTabs[0]).toMatchObject({ id: 'tab-1', state: 'idle' });
				expect(updated.terminalTabs[0].exitCode).toBeUndefined();
			});

			it('returns original session when no tab changes', () => {
				const tab = createMockTerminalTab({ id: 'tab-1', state: 'idle' });
				const session = createMockSession({
					terminalTabs: [tab],
					activeTerminalTabId: 'tab-1',
				});

				expect(updateTerminalTabState(session, 'tab-1', 'idle')).toBe(session);
				expect(updateTerminalTabState(session, 'missing-tab', 'busy')).toBe(session);
			});
		});

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

	describe('reopenTerminalTab', () => {
		it('returns null when there is no closed terminal tab history', () => {
			const session = createMockSession({
				terminalTabs: [createMockTerminalTab({ id: 'tab-1' })],
				activeTerminalTabId: 'tab-1',
				closedTerminalTabHistory: [],
			});

			expect(reopenTerminalTab(session)).toBeNull();
		});

		it('reopens the most recently closed tab at its original position', () => {
			vi.spyOn(Date, 'now').mockReturnValue(80001);
			const tab1 = createMockTerminalTab({ id: 'tab-1' });
			const tab3 = createMockTerminalTab({ id: 'tab-3' });
			const closedTab = createMockTerminalTab({
				id: 'closed-tab',
				name: 'Infra',
				shellType: 'bash',
				cwd: '/tmp/work',
				pid: 999,
				state: 'exited',
				exitCode: 137,
				createdAt: 123,
			});

			const session = createMockSession({
				terminalTabs: [tab1, tab3],
				activeTerminalTabId: 'tab-1',
				closedTerminalTabHistory: [
					{
						tab: closedTab,
						index: 1,
						closedAt: 70000,
					},
				],
			});

			const result = reopenTerminalTab(session);

			expect(result).not.toBeNull();
			expect(result?.session.terminalTabs.map((tab) => tab.id)).toEqual([
				'tab-1',
				'mock-terminal-tab-id',
				'tab-3',
			]);
			expect(result?.session.activeTerminalTabId).toBe('mock-terminal-tab-id');
			expect(result?.session.closedTerminalTabHistory).toEqual([]);
			expect(result?.reopenedTab).toEqual({
				...closedTab,
				id: 'mock-terminal-tab-id',
				pid: 0,
				state: 'idle',
				exitCode: undefined,
				createdAt: 80001,
			});
		});

		it('appends reopened tab when the original index is out of bounds', () => {
			vi.spyOn(Date, 'now').mockReturnValue(80002);
			const tab1 = createMockTerminalTab({ id: 'tab-1' });
			const closedTab = createMockTerminalTab({ id: 'closed-tab' });
			const session = createMockSession({
				terminalTabs: [tab1],
				activeTerminalTabId: 'tab-1',
				closedTerminalTabHistory: [
					{
						tab: closedTab,
						index: 99,
						closedAt: 70000,
					},
				],
			});

			const result = reopenTerminalTab(session);

			expect(result?.session.terminalTabs.map((tab) => tab.id)).toEqual([
				'tab-1',
				'mock-terminal-tab-id',
			]);
		});
	});

	it('exports the expected closed terminal tab history limit', () => {
		expect(MAX_CLOSED_TERMINAL_TABS).toBe(10);
	});
});
