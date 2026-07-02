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
	getActiveTerminalTab,
	getTerminalTabDisplayName,
	hasRunningTerminalProcess,
	getTerminalSessionId,
	parseTerminalSessionId,
	addTerminalTab,
	closeTerminalTab,
	selectTerminalTab,
	restartTerminalTab,
	updateTerminalTabState,
	updateTerminalTabPid,
	updateTerminalTabCwd,
	renameTerminalTab,
	setTerminalTabStartupCommand,
	reorderTerminalTabs,
} from '../../../renderer/utils/terminalTabHelpers';
import type { Session, TerminalTab } from '../../../renderer/types';
import { createMockSession } from '../../helpers/mockSession';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';

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
	// Several tests here assert insert-after-active placement; the setting defaults
	// to 'end', so opt into 'after-current' for the duration of this block.
	beforeEach(() => {
		useSettingsStore.setState({ newTabPlacement: 'after-current' });
	});

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

	it('leaves any active tiled group (clears activeGroupId)', () => {
		// Regression: a new standalone terminal must exit the group, otherwise the
		// group stays active and a tiled browser overlay bleeds over the terminal view.
		const session = createMockSession({
			activeGroupId: 'g1',
			tabGroups: [
				{
					id: 'g1',
					name: 'Group',
					createdAt: 0,
					focusedPaneId: 'l1',
					layout: {
						kind: 'split',
						id: 's1',
						direction: 'row',
						sizes: [1],
						children: [{ kind: 'leaf', id: 'l1', tab: { type: 'browser', id: 'b1' } }],
					},
				},
			] as never,
		});
		const updated = addTerminalTab(session, createMockTerminalTab({ id: 'new-tab' }));
		expect(updated.activeGroupId).toBeNull();
	});

	it('adds a terminal ref to unifiedTabOrder', () => {
		const session = createMockSession();
		const tab = createMockTerminalTab({ id: 'new-tab' });
		const updated = addTerminalTab(session, tab);
		expect(updated.unifiedTabOrder).toContainEqual({ type: 'terminal', id: 'new-tab' });
	});

	it('mints a coworkingId starting at 1 and increments the session counter', () => {
		const session = createMockSession();
		const tab = createMockTerminalTab({ id: 'new-tab' });
		const updated = addTerminalTab(session, tab);
		expect(updated.terminalTabs![0].coworkingId).toBe(1);
		expect(updated.nextCoworkingId).toBe(2);
	});

	it('clamps nextCoworkingId against existing ids even when the counter is set but stale', () => {
		// Persisted counter is 3, but an existing tab already carries id=10. Without the
		// Math.max clamp we'd hand out term:3 — a duplicate of nothing yet, but the next
		// few adds would collide with the existing 10. The clamp must jump past it.
		const existingTab = createMockTerminalTab({ id: 'old', coworkingId: 10 });
		const session = createMockSession({
			terminalTabs: [existingTab],
			activeTerminalTabId: 'old',
			unifiedTabOrder: [{ type: 'terminal', id: 'old' }],
			nextCoworkingId: 3,
		});
		const updated = addTerminalTab(session, createMockTerminalTab({ id: 'new' }));
		const newTab = updated.terminalTabs!.find((t) => t.id === 'new');
		expect(newTab?.coworkingId).toBe(11);
		expect(updated.nextCoworkingId).toBe(12);
	});

	it('falls back to max(existing coworkingId)+1 when nextCoworkingId is missing (legacy migration)', () => {
		// Simulates a session deserialized from disk before nextCoworkingId existed:
		// the existing tab already carries coworkingId=7, so a fresh add must mint 8 — not 1.
		const existingTab = createMockTerminalTab({ id: 'old', coworkingId: 7 });
		const session = createMockSession({
			terminalTabs: [existingTab],
			activeTerminalTabId: 'old',
			unifiedTabOrder: [{ type: 'terminal', id: 'old' }],
			// nextCoworkingId intentionally omitted to mimic legacy persisted state
		});
		const updated = addTerminalTab(session, createMockTerminalTab({ id: 'new' }));
		const newTab = updated.terminalTabs!.find((t) => t.id === 'new');
		expect(newTab?.coworkingId).toBe(8);
		expect(updated.nextCoworkingId).toBe(9);
	});

	it('coworkingId is monotonic and never reused after close', () => {
		let session = createMockSession();
		session = addTerminalTab(session, createMockTerminalTab({ id: 'a' })); // id=1
		session = addTerminalTab(session, createMockTerminalTab({ id: 'b' })); // id=2
		session = addTerminalTab(session, createMockTerminalTab({ id: 'c' })); // id=3
		// Drop the middle tab manually (closeTerminalTab path tested elsewhere) and add another.
		session = {
			...session,
			terminalTabs: session.terminalTabs!.filter((t) => t.id !== 'b'),
		};
		session = addTerminalTab(session, createMockTerminalTab({ id: 'd' })); // must be id=4, not 2
		const ids = session.terminalTabs!.map((t) => t.coworkingId);
		expect(ids).toContain(1);
		expect(ids).toContain(3);
		expect(ids).toContain(4);
		expect(ids).not.toContain(2);
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

	it('inserts the new terminal directly to the right of the active terminal tab', () => {
		const term1 = createMockTerminalTab({ id: 'term-1' });
		const term2 = createMockTerminalTab({ id: 'term-2' });
		const session = createMockSession({
			terminalTabs: [term1, term2],
			activeTerminalTabId: 'term-1',
			inputMode: 'terminal',
			unifiedTabOrder: [
				{ type: 'terminal', id: 'term-1' },
				{ type: 'terminal', id: 'term-2' },
			],
		});
		const newTab = createMockTerminalTab({ id: 'new-tab' });

		const updated = addTerminalTab(session, newTab);

		expect(updated.unifiedTabOrder).toEqual([
			{ type: 'terminal', id: 'term-1' },
			{ type: 'terminal', id: 'new-tab' },
			{ type: 'terminal', id: 'term-2' },
		]);
	});

	it('inserts the new terminal directly to the right of the active AI tab', () => {
		const session = createMockSession({
			aiTabs: [
				{
					id: 'ai-1',
					agentSessionId: null,
					name: null,
					starred: false,
					logs: [],
					inputValue: '',
					stagedImages: [],
					createdAt: 0,
					state: 'idle',
				},
				{
					id: 'ai-2',
					agentSessionId: null,
					name: null,
					starred: false,
					logs: [],
					inputValue: '',
					stagedImages: [],
					createdAt: 0,
					state: 'idle',
				},
			],
			activeTabId: 'ai-1',
			unifiedTabOrder: [
				{ type: 'ai', id: 'ai-1' },
				{ type: 'ai', id: 'ai-2' },
			],
		});
		const newTab = createMockTerminalTab({ id: 'new-term' });

		const updated = addTerminalTab(session, newTab);

		expect(updated.unifiedTabOrder).toEqual([
			{ type: 'ai', id: 'ai-1' },
			{ type: 'terminal', id: 'new-term' },
			{ type: 'ai', id: 'ai-2' },
		]);
	});

	it('appends when active tab is missing from unifiedTabOrder', () => {
		const session = createMockSession({
			activeTabId: 'ai-missing',
			unifiedTabOrder: [{ type: 'ai', id: 'ai-other' }],
		});
		const newTab = createMockTerminalTab({ id: 'new-term' });

		const updated = addTerminalTab(session, newTab);

		expect(updated.unifiedTabOrder).toEqual([
			{ type: 'ai', id: 'ai-other' },
			{ type: 'terminal', id: 'new-term' },
		]);
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

	it('allows closing the last terminal tab and switches inputMode to ai', () => {
		const tab = createMockTerminalTab({ id: 'only-tab' });
		const session = createMockSession({
			terminalTabs: [tab],
			activeTerminalTabId: 'only-tab',
			inputMode: 'terminal',
			unifiedTabOrder: [{ type: 'terminal' as const, id: 'only-tab' }],
		});
		const updated = closeTerminalTab(session, 'only-tab');
		expect(updated.terminalTabs).toHaveLength(0);
		expect(updated.activeTerminalTabId).toBeNull();
		expect(updated.inputMode).toBe('ai');
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

	it('falls back to a file tab to the left in unifiedTabOrder', () => {
		const fileTab = {
			id: 'file-1',
			path: '/foo.ts',
			name: 'foo',
			extension: '.ts',
			content: '',
			scrollTop: 0,
			searchQuery: '',
			editMode: false,
			editContent: undefined,
			createdAt: 1000,
			lastModified: 1000,
		};
		const termTab = createMockTerminalTab({ id: 'term-1' });
		const session = createMockSession({
			filePreviewTabs: [fileTab],
			activeFileTabId: null,
			terminalTabs: [termTab],
			activeTerminalTabId: 'term-1',
			inputMode: 'terminal',
			unifiedTabOrder: [
				{ type: 'file', id: 'file-1' },
				{ type: 'terminal', id: 'term-1' },
			],
		});
		const updated = closeTerminalTab(session, 'term-1');
		expect(updated.activeFileTabId).toBe('file-1');
		expect(updated.activeTerminalTabId).toBeNull();
		expect(updated.inputMode).toBe('ai');
	});

	it('falls back to an AI tab to the left in unifiedTabOrder', () => {
		const termTab = createMockTerminalTab({ id: 'term-1' });
		const session = createMockSession({
			aiTabs: [{ id: 'ai-1' } as any],
			activeTabId: 'ai-1',
			terminalTabs: [termTab],
			activeTerminalTabId: 'term-1',
			inputMode: 'terminal',
			unifiedTabOrder: [
				{ type: 'ai', id: 'ai-1' },
				{ type: 'terminal', id: 'term-1' },
			],
		});
		const updated = closeTerminalTab(session, 'term-1');
		expect(updated.activeTabId).toBe('ai-1');
		expect(updated.activeTerminalTabId).toBeNull();
		expect(updated.activeFileTabId).toBeNull();
		expect(updated.inputMode).toBe('ai');
	});

	it('falls back to the right neighbor when closing the leftmost tab', () => {
		const termTab = createMockTerminalTab({ id: 'term-1' });
		const fileTab = {
			id: 'file-1',
			path: '/foo.ts',
			name: 'foo',
			extension: '.ts',
			content: '',
			scrollTop: 0,
			searchQuery: '',
			editMode: false,
			editContent: undefined,
			createdAt: 1000,
			lastModified: 1000,
		};
		const session = createMockSession({
			filePreviewTabs: [fileTab],
			terminalTabs: [termTab],
			activeTerminalTabId: 'term-1',
			inputMode: 'terminal',
			unifiedTabOrder: [
				{ type: 'terminal', id: 'term-1' },
				{ type: 'file', id: 'file-1' },
			],
		});
		const updated = closeTerminalTab(session, 'term-1');
		// term-1 is at index 0; fallbackIndex = max(0, 0-1) = 0, which maps to file-1 after removal
		expect(updated.activeFileTabId).toBe('file-1');
		expect(updated.activeTerminalTabId).toBeNull();
		expect(updated.inputMode).toBe('ai');
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

describe('restartTerminalTab', () => {
	it('resets an exited tab to a spawnable state', () => {
		const tab = createMockTerminalTab({
			id: 'tab-1',
			pid: 4242,
			state: 'exited',
			exitCode: 255,
		});
		const session = createMockSession({ terminalTabs: [tab], activeTerminalTabId: null });
		const updated = restartTerminalTab(session, 'tab-1');
		expect(updated.terminalTabs![0].pid).toBe(0);
		expect(updated.terminalTabs![0].state).toBe('idle');
		expect(updated.terminalTabs![0].exitCode).toBeUndefined();
	});

	it('preserves the startup command so the restart re-runs it', () => {
		const tab = createMockTerminalTab({
			id: 'tab-1',
			pid: 99,
			state: 'exited',
			startupCommand: 'ssh prod',
		});
		const session = createMockSession({ terminalTabs: [tab] });
		const updated = restartTerminalTab(session, 'tab-1');
		expect(updated.terminalTabs![0].startupCommand).toBe('ssh prod');
	});

	it('selects the restarted tab and clears other active tab kinds', () => {
		const tab = createMockTerminalTab({ id: 'tab-1', state: 'exited' });
		const session = createMockSession({
			terminalTabs: [tab],
			activeTerminalTabId: null,
			activeFileTabId: 'file-tab-1',
			activeBrowserTabId: 'browser-tab-1',
		});
		const updated = restartTerminalTab(session, 'tab-1');
		expect(updated.activeTerminalTabId).toBe('tab-1');
		expect(updated.activeFileTabId).toBeNull();
		expect(updated.activeBrowserTabId).toBeNull();
	});

	it('returns original session when tab not found', () => {
		const session = createMockSession({ terminalTabs: [] });
		const updated = restartTerminalTab(session, 'nonexistent');
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

	it('clears exitCode when not provided (stale value reset)', () => {
		const tab = createMockTerminalTab({ id: 'tab-1', state: 'exited', exitCode: 130 });
		const session = createMockSession({ terminalTabs: [tab] });
		// Transitioning back to idle without an exitCode should clear the stale code
		const updated = updateTerminalTabState(session, 'tab-1', 'idle');
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

describe('setTerminalTabStartupCommand', () => {
	it('sets command and cwd on the matching tab', () => {
		const tab = createMockTerminalTab({ id: 'tab-1' });
		const session = createMockSession({ terminalTabs: [tab] });
		const updated = setTerminalTabStartupCommand(session, 'tab-1', 'npm run dev', '/proj');
		expect(updated.terminalTabs![0].startupCommand).toBe('npm run dev');
		expect(updated.terminalTabs![0].startupCommandCwd).toBe('/proj');
	});

	it('trims whitespace from command and cwd', () => {
		const tab = createMockTerminalTab({ id: 'tab-1' });
		const session = createMockSession({ terminalTabs: [tab] });
		const updated = setTerminalTabStartupCommand(session, 'tab-1', '  npm test  ', '  /a  ');
		expect(updated.terminalTabs![0].startupCommand).toBe('npm test');
		expect(updated.terminalTabs![0].startupCommandCwd).toBe('/a');
	});

	it('clears the configuration when command is empty', () => {
		const tab = createMockTerminalTab({
			id: 'tab-1',
			startupCommand: 'old',
			startupCommandCwd: '/x',
		});
		const session = createMockSession({ terminalTabs: [tab] });
		const updated = setTerminalTabStartupCommand(session, 'tab-1', '', '');
		expect(updated.terminalTabs![0].startupCommand).toBeUndefined();
		expect(updated.terminalTabs![0].startupCommandCwd).toBeUndefined();
	});

	it('clears only the cwd override when cwd is empty but command is set', () => {
		const tab = createMockTerminalTab({
			id: 'tab-1',
			startupCommand: 'old',
			startupCommandCwd: '/old',
		});
		const session = createMockSession({ terminalTabs: [tab] });
		const updated = setTerminalTabStartupCommand(session, 'tab-1', 'new', '');
		expect(updated.terminalTabs![0].startupCommand).toBe('new');
		expect(updated.terminalTabs![0].startupCommandCwd).toBeUndefined();
	});

	it('returns original session when tab not found', () => {
		const session = createMockSession({ terminalTabs: [] });
		const updated = setTerminalTabStartupCommand(session, 'nonexistent', 'cmd', '');
		expect(updated).toBe(session);
	});
});

describe('getActiveTerminalTab', () => {
	it('returns the active tab when it exists', () => {
		const tab1 = createMockTerminalTab({ id: 'tab-1' });
		const tab2 = createMockTerminalTab({ id: 'tab-2' });
		const session = createMockSession({
			terminalTabs: [tab1, tab2],
			activeTerminalTabId: 'tab-2',
		});
		expect(getActiveTerminalTab(session)).toBe(tab2);
	});

	it('returns undefined when activeTerminalTabId is null', () => {
		const tab = createMockTerminalTab({ id: 'tab-1' });
		const session = createMockSession({
			terminalTabs: [tab],
			activeTerminalTabId: null,
		});
		expect(getActiveTerminalTab(session)).toBeUndefined();
	});

	it('returns undefined when terminalTabs is empty', () => {
		const session = createMockSession({ terminalTabs: [], activeTerminalTabId: 'tab-1' });
		expect(getActiveTerminalTab(session)).toBeUndefined();
	});

	it('returns undefined when activeTerminalTabId does not match any tab', () => {
		const tab = createMockTerminalTab({ id: 'tab-1' });
		const session = createMockSession({
			terminalTabs: [tab],
			activeTerminalTabId: 'nonexistent',
		});
		expect(getActiveTerminalTab(session)).toBeUndefined();
	});
});

describe('hasRunningTerminalProcess', () => {
	it('returns false when there are no terminal tabs', () => {
		const session = createMockSession({ terminalTabs: [] });
		expect(hasRunningTerminalProcess(session)).toBe(false);
	});

	it('returns false when all tabs are idle', () => {
		const session = createMockSession({
			terminalTabs: [
				createMockTerminalTab({ id: 'tab-1', state: 'idle' }),
				createMockTerminalTab({ id: 'tab-2', state: 'idle' }),
			],
		});
		expect(hasRunningTerminalProcess(session)).toBe(false);
	});

	it('returns true when at least one tab is busy', () => {
		const session = createMockSession({
			terminalTabs: [
				createMockTerminalTab({ id: 'tab-1', state: 'idle' }),
				createMockTerminalTab({ id: 'tab-2', state: 'busy' }),
			],
		});
		expect(hasRunningTerminalProcess(session)).toBe(true);
	});

	it('returns false when tabs are exited (not running)', () => {
		const session = createMockSession({
			terminalTabs: [createMockTerminalTab({ id: 'tab-1', state: 'exited' })],
		});
		expect(hasRunningTerminalProcess(session)).toBe(false);
	});
});

describe('updateTerminalTabCwd', () => {
	it('updates the cwd of the matching tab', () => {
		const tab = createMockTerminalTab({ id: 'tab-1', cwd: '/old' });
		const session = createMockSession({ terminalTabs: [tab] });
		const updated = updateTerminalTabCwd(session, 'tab-1', '/new/path');
		expect(updated.terminalTabs![0].cwd).toBe('/new/path');
	});

	it('does not mutate other tabs', () => {
		const tab1 = createMockTerminalTab({ id: 'tab-1', cwd: '/project' });
		const tab2 = createMockTerminalTab({ id: 'tab-2', cwd: '/home' });
		const session = createMockSession({ terminalTabs: [tab1, tab2] });
		const updated = updateTerminalTabCwd(session, 'tab-1', '/new');
		expect(updated.terminalTabs![1].cwd).toBe('/home');
	});

	it('returns a session with no tab cwd changed when tab not found', () => {
		const tab = createMockTerminalTab({ id: 'tab-1', cwd: '/project' });
		const session = createMockSession({ terminalTabs: [tab] });
		const updated = updateTerminalTabCwd(session, 'nonexistent', '/new');
		expect(updated.terminalTabs![0].cwd).toBe('/project');
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
