/**
 * Tests for terminalTabHelpers.ts — pure functions for managing TerminalTab state.
 *
 * Functions tested:
 * - createTerminalTab
 * - getTerminalTabDisplayName
 * - getTerminalSessionId / parseTerminalSessionId (inverse pair)
 * - addTerminalTab
 * - closeTerminalTab
 * - selectTerminalTab
 * - updateTerminalTabState
 * - updateTerminalTabPid
 * - renameTerminalTab
 * - reorderTerminalTabs
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	createTerminalTab,
	getTerminalTabDisplayName,
	getTerminalSessionId,
	parseTerminalSessionId,
	addTerminalTab,
	closeTerminalTab,
	selectTerminalTab,
	updateTerminalTabState,
	updateTerminalTabPid,
	renameTerminalTab,
	reorderTerminalTabs,
} from '../../../renderer/utils/terminalTabHelpers';
import type { Session, TerminalTab } from '../../../renderer/types';

// Mock generateId for predictable test IDs
vi.mock('../../../renderer/utils/ids', () => ({
	generateId: vi.fn(() => 'mock-id'),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createMockTerminalTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
	return {
		id: 'tab-1',
		name: null,
		shellType: 'zsh',
		pid: 0,
		cwd: '/test',
		createdAt: 1000,
		state: 'idle',
		...overrides,
	};
}

function createMockSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'session-1',
		name: 'Test Session',
		toolType: 'claude-code',
		state: 'idle',
		cwd: '/test',
		fullPath: '/test',
		projectRoot: '/test',
		aiLogs: [],
		shellLogs: [],
		workLog: [],
		contextUsage: 0,
		inputMode: 'ai',
		aiPid: 0,
		terminalPid: 0,
		port: 0,
		isLive: false,
		changedFiles: [],
		isGitRepo: false,
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		executionQueue: [],
		activeTimeMs: 0,
		aiTabs: [],
		activeTabId: '',
		closedTabHistory: [],
		filePreviewTabs: [],
		activeFileTabId: null,
		unifiedTabOrder: [],
		unifiedClosedTabHistory: [],
		terminalTabs: [],
		activeTerminalTabId: null,
		...overrides,
	} as Session;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('createTerminalTab', () => {
	it('returns a tab with valid defaults', () => {
		const tab = createTerminalTab();
		expect(tab.id).toBe('mock-id');
		expect(tab.name).toBeNull();
		expect(tab.shellType).toBe('zsh');
		expect(tab.pid).toBe(0);
		expect(tab.cwd).toBe('');
		expect(tab.state).toBe('idle');
		expect(typeof tab.createdAt).toBe('number');
	});

	it('accepts custom shellType and cwd', () => {
		const tab = createTerminalTab('bash', '/home/user');
		expect(tab.shellType).toBe('bash');
		expect(tab.cwd).toBe('/home/user');
	});

	it('accepts a custom name', () => {
		const tab = createTerminalTab('zsh', '/home', 'Dev Server');
		expect(tab.name).toBe('Dev Server');
	});

	it('stores null when name is explicitly null', () => {
		const tab = createTerminalTab('zsh', '', null);
		expect(tab.name).toBeNull();
	});
});

describe('getTerminalTabDisplayName', () => {
	it('returns the custom name when set', () => {
		const tab = createMockTerminalTab({ name: 'My Server' });
		expect(getTerminalTabDisplayName(tab, 0)).toBe('My Server');
	});

	it('returns "Terminal N" using 1-based index when name is null', () => {
		const tab = createMockTerminalTab({ name: null });
		expect(getTerminalTabDisplayName(tab, 0)).toBe('Terminal 1');
		expect(getTerminalTabDisplayName(tab, 2)).toBe('Terminal 3');
	});

	it('returns "Terminal 1" for the first tab', () => {
		const tab = createMockTerminalTab();
		expect(getTerminalTabDisplayName(tab, 0)).toBe('Terminal 1');
	});
});

describe('getTerminalSessionId / parseTerminalSessionId', () => {
	it('getTerminalSessionId produces the expected format', () => {
		const id = getTerminalSessionId('sess-abc', 'tab-xyz');
		expect(id).toBe('sess-abc-terminal-tab-xyz');
	});

	it('parseTerminalSessionId is the inverse of getTerminalSessionId', () => {
		const composite = getTerminalSessionId('sess-abc', 'tab-xyz');
		const parsed = parseTerminalSessionId(composite);
		expect(parsed).toEqual({ sessionId: 'sess-abc', tabId: 'tab-xyz' });
	});

	it('parseTerminalSessionId returns null for non-matching string', () => {
		expect(parseTerminalSessionId('sess-abc-ai-tab-xyz')).toBeNull();
		expect(parseTerminalSessionId('no-separator-here')).toBeNull();
	});

	it('parseTerminalSessionId returns null when sessionId or tabId is empty', () => {
		expect(parseTerminalSessionId('-terminal-tab-xyz')).toBeNull();
		expect(parseTerminalSessionId('sess-abc-terminal-')).toBeNull();
	});
});

describe('addTerminalTab', () => {
	it('appends the tab to terminalTabs', () => {
		const session = createMockSession();
		const tab = createMockTerminalTab({ id: 'new-tab' });
		const updated = addTerminalTab(session, tab);
		expect(updated.terminalTabs).toHaveLength(1);
		expect(updated.terminalTabs![0].id).toBe('new-tab');
	});

	it('makes the new tab the active terminal tab', () => {
		const session = createMockSession();
		const tab = createMockTerminalTab({ id: 'new-tab' });
		const updated = addTerminalTab(session, tab);
		expect(updated.activeTerminalTabId).toBe('new-tab');
	});

	it('adds a terminal ref to unifiedTabOrder', () => {
		const session = createMockSession();
		const tab = createMockTerminalTab({ id: 'new-tab' });
		const updated = addTerminalTab(session, tab);
		expect(updated.unifiedTabOrder).toContainEqual({ type: 'terminal', id: 'new-tab' });
	});

	it('preserves existing tabs', () => {
		const existingTab = createMockTerminalTab({ id: 'existing' });
		const session = createMockSession({
			terminalTabs: [existingTab],
			activeTerminalTabId: 'existing',
			unifiedTabOrder: [{ type: 'terminal', id: 'existing' }],
		});
		const newTab = createMockTerminalTab({ id: 'new-tab' });
		const updated = addTerminalTab(session, newTab);
		expect(updated.terminalTabs).toHaveLength(2);
		expect(updated.unifiedTabOrder).toHaveLength(2);
	});
});

describe('closeTerminalTab', () => {
	it('removes the tab from terminalTabs', () => {
		const tab1 = createMockTerminalTab({ id: 'tab-1' });
		const tab2 = createMockTerminalTab({ id: 'tab-2' });
		const session = createMockSession({
			terminalTabs: [tab1, tab2],
			activeTerminalTabId: 'tab-1',
			unifiedTabOrder: [
				{ type: 'terminal', id: 'tab-1' },
				{ type: 'terminal', id: 'tab-2' },
			],
		});
		const updated = closeTerminalTab(session, 'tab-2');
		expect(updated.terminalTabs!.map((t) => t.id)).toEqual(['tab-1']);
	});

	it('prevents closing the last terminal tab', () => {
		const tab = createMockTerminalTab({ id: 'only-tab' });
		const session = createMockSession({
			terminalTabs: [tab],
			activeTerminalTabId: 'only-tab',
		});
		const updated = closeTerminalTab(session, 'only-tab');
		expect(updated).toBe(session); // unchanged reference
		expect(updated.terminalTabs).toHaveLength(1);
	});

	it('selects the adjacent tab when closing the active tab', () => {
		const tab1 = createMockTerminalTab({ id: 'tab-1' });
		const tab2 = createMockTerminalTab({ id: 'tab-2' });
		const tab3 = createMockTerminalTab({ id: 'tab-3' });
		const session = createMockSession({
			terminalTabs: [tab1, tab2, tab3],
			activeTerminalTabId: 'tab-2',
			unifiedTabOrder: [
				{ type: 'terminal', id: 'tab-1' },
				{ type: 'terminal', id: 'tab-2' },
				{ type: 'terminal', id: 'tab-3' },
			],
		});
		const updated = closeTerminalTab(session, 'tab-2');
		// Should select tab-1 (left neighbor, index 0 after removal)
		expect(updated.activeTerminalTabId).toBe('tab-1');
	});

	it('adds the closed tab to unifiedClosedTabHistory', () => {
		const tab1 = createMockTerminalTab({ id: 'tab-1' });
		const tab2 = createMockTerminalTab({ id: 'tab-2' });
		const session = createMockSession({
			terminalTabs: [tab1, tab2],
			activeTerminalTabId: 'tab-1',
			unifiedTabOrder: [
				{ type: 'terminal', id: 'tab-1' },
				{ type: 'terminal', id: 'tab-2' },
			],
		});
		const updated = closeTerminalTab(session, 'tab-2');
		expect(updated.unifiedClosedTabHistory).toHaveLength(1);
		expect(updated.unifiedClosedTabHistory![0].type).toBe('terminal');
	});

	it('removes the closed tab from unifiedTabOrder', () => {
		const tab1 = createMockTerminalTab({ id: 'tab-1' });
		const tab2 = createMockTerminalTab({ id: 'tab-2' });
		const session = createMockSession({
			terminalTabs: [tab1, tab2],
			activeTerminalTabId: 'tab-1',
			unifiedTabOrder: [
				{ type: 'terminal', id: 'tab-1' },
				{ type: 'terminal', id: 'tab-2' },
			],
		});
		const updated = closeTerminalTab(session, 'tab-2');
		expect(updated.unifiedTabOrder!.find((r) => r.id === 'tab-2')).toBeUndefined();
	});
});

describe('selectTerminalTab', () => {
	it('sets the activeTerminalTabId', () => {
		const tab1 = createMockTerminalTab({ id: 'tab-1' });
		const tab2 = createMockTerminalTab({ id: 'tab-2' });
		const session = createMockSession({
			terminalTabs: [tab1, tab2],
			activeTerminalTabId: 'tab-1',
		});
		const updated = selectTerminalTab(session, 'tab-2');
		expect(updated.activeTerminalTabId).toBe('tab-2');
	});

	it('clears activeFileTabId', () => {
		const tab = createMockTerminalTab({ id: 'tab-1' });
		const session = createMockSession({
			terminalTabs: [tab],
			activeTerminalTabId: null,
			activeFileTabId: 'file-tab-1',
		});
		const updated = selectTerminalTab(session, 'tab-1');
		expect(updated.activeFileTabId).toBeNull();
	});

	it('returns original session when tab not found', () => {
		const session = createMockSession({ terminalTabs: [] });
		const updated = selectTerminalTab(session, 'nonexistent');
		expect(updated).toBe(session);
	});
});

describe('updateTerminalTabState', () => {
	it('updates the state of the matching tab', () => {
		const tab = createMockTerminalTab({ id: 'tab-1', state: 'idle' });
		const session = createMockSession({ terminalTabs: [tab] });
		const updated = updateTerminalTabState(session, 'tab-1', 'busy');
		expect(updated.terminalTabs![0].state).toBe('busy');
	});

	it('sets exitCode when transitioning to exited', () => {
		const tab = createMockTerminalTab({ id: 'tab-1', state: 'busy' });
		const session = createMockSession({ terminalTabs: [tab] });
		const updated = updateTerminalTabState(session, 'tab-1', 'exited', 130);
		expect(updated.terminalTabs![0].state).toBe('exited');
		expect(updated.terminalTabs![0].exitCode).toBe(130);
	});

	it('does not set exitCode when not provided', () => {
		const tab = createMockTerminalTab({ id: 'tab-1', state: 'idle' });
		const session = createMockSession({ terminalTabs: [tab] });
		const updated = updateTerminalTabState(session, 'tab-1', 'busy');
		expect(updated.terminalTabs![0].exitCode).toBeUndefined();
	});

	it('does not mutate other tabs', () => {
		const tab1 = createMockTerminalTab({ id: 'tab-1', state: 'idle' });
		const tab2 = createMockTerminalTab({ id: 'tab-2', state: 'idle' });
		const session = createMockSession({ terminalTabs: [tab1, tab2] });
		const updated = updateTerminalTabState(session, 'tab-1', 'busy');
		expect(updated.terminalTabs![1].state).toBe('idle');
	});
});

describe('updateTerminalTabPid', () => {
	it('updates the pid of the matching tab', () => {
		const tab = createMockTerminalTab({ id: 'tab-1', pid: 0 });
		const session = createMockSession({ terminalTabs: [tab] });
		const updated = updateTerminalTabPid(session, 'tab-1', 12345);
		expect(updated.terminalTabs![0].pid).toBe(12345);
	});
});

describe('renameTerminalTab', () => {
	it('updates the name of the matching tab', () => {
		const tab = createMockTerminalTab({ id: 'tab-1', name: null });
		const session = createMockSession({ terminalTabs: [tab] });
		const updated = renameTerminalTab(session, 'tab-1', 'Custom Name');
		expect(updated.terminalTabs![0].name).toBe('Custom Name');
	});

	it('converts empty string name to null (restores default display)', () => {
		const tab = createMockTerminalTab({ id: 'tab-1', name: 'Old Name' });
		const session = createMockSession({ terminalTabs: [tab] });
		const updated = renameTerminalTab(session, 'tab-1', '');
		expect(updated.terminalTabs![0].name).toBeNull();
	});

	it('returns original session when tab not found', () => {
		const session = createMockSession({ terminalTabs: [] });
		const updated = renameTerminalTab(session, 'nonexistent', 'Name');
		expect(updated).toBe(session);
	});
});

describe('reorderTerminalTabs', () => {
	it('moves a tab from one index to another', () => {
		const tab1 = createMockTerminalTab({ id: 'tab-1' });
		const tab2 = createMockTerminalTab({ id: 'tab-2' });
		const tab3 = createMockTerminalTab({ id: 'tab-3' });
		const session = createMockSession({ terminalTabs: [tab1, tab2, tab3] });
		const updated = reorderTerminalTabs(session, 0, 2);
		expect(updated.terminalTabs!.map((t) => t.id)).toEqual(['tab-2', 'tab-3', 'tab-1']);
	});

	it('returns original session for out-of-bounds indices', () => {
		const tab = createMockTerminalTab({ id: 'tab-1' });
		const session = createMockSession({ terminalTabs: [tab] });
		expect(reorderTerminalTabs(session, 0, 5)).toBe(session);
		expect(reorderTerminalTabs(session, -1, 0)).toBe(session);
	});

	it('returns original session when fromIndex equals toIndex', () => {
		const tab = createMockTerminalTab({ id: 'tab-1' });
		const session = createMockSession({ terminalTabs: [tab] });
		expect(reorderTerminalTabs(session, 0, 0)).toBe(session);
	});
});
