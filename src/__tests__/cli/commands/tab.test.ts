/**
 * @file tab.test.ts
 * @description Tests for the tab CLI command group
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', () => ({ withMaestroClient: vi.fn() }));
vi.mock('../../../cli/services/storage', () => ({
	resolveAgentId: vi.fn((id: string) => id),
}));
vi.mock('../../../cli/output/formatter', () => ({
	formatError: vi.fn((msg) => `Error: ${msg}`),
	formatSuccess: vi.fn((msg) => `Success: ${msg}`),
}));

import {
	tabNew,
	tabClose,
	tabRename,
	tabStar,
	tabMove,
	tabUnread,
	tabSaveToHistory,
} from '../../../cli/commands/tab';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { resolveAgentId } from '../../../cli/services/storage';
import { formatError } from '../../../cli/output/formatter';

// agent-1 owns three tabs in tab-bar order so reordering has something to move
// against; agent-2's single tab guards against cross-agent index leakage.
const SESSIONS = [
	{ tabId: 'tab-aaaa', agentId: 'agent-1' },
	{ tabId: 'tab-cccc', agentId: 'agent-1' },
	{ tabId: 'tab-dddd', agentId: 'agent-1' },
	{ tabId: 'tab-bbbb', agentId: 'agent-2' },
];

/**
 * Mock that answers list_desktop_sessions with SESSIONS and captures any other
 * command payload. Works across the two separate connections tab verbs open
 * (resolve owner, then send the command).
 */
function mockTab(result: Record<string, unknown>) {
	let captured: Record<string, unknown> = {};
	vi.mocked(withMaestroClient).mockImplementation(async (action) =>
		action({
			sendCommand: vi.fn().mockImplementation((payload: Record<string, unknown>) => {
				if (payload.type === 'list_desktop_sessions') {
					return Promise.resolve({ sessions: SESSIONS });
				}
				captured = payload;
				return Promise.resolve(result);
			}),
		} as never)
	);
	return () => captured;
}

describe('tab commands', () => {
	let consoleSpy: MockInstance;
	let processExitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(resolveAgentId).mockImplementation((id: string) => id);
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
	});

	it('tab new (no prompt) sends new_tab and prints the tab id', async () => {
		const getPayload = mockTab({ success: true, tabId: 'tab-new' });
		await tabNew({ agent: 'agent-1' });
		const p = getPayload();
		expect(p.type).toBe('new_tab');
		expect(p.sessionId).toBe('agent-1');
		expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('tab-new'));
	});

	it('tab new --prompt sends new_ai_tab_with_prompt', async () => {
		const getPayload = mockTab({ success: true, tabId: 't' });
		await tabNew({ agent: 'agent-1', prompt: 'hello' });
		const p = getPayload();
		expect(p.type).toBe('new_ai_tab_with_prompt');
		expect(p.prompt).toBe('hello');
	});

	it('tab close resolves the owning agent from the tab id', async () => {
		const getPayload = mockTab({ success: true });
		await tabClose('tab-bbbb', {});
		const p = getPayload();
		expect(p.type).toBe('close_tab');
		expect(p.sessionId).toBe('agent-2');
		expect(p.tabId).toBe('tab-bbbb');
	});

	it('tab close accepts a unique prefix', async () => {
		const getPayload = mockTab({ success: true });
		await tabClose('tab-aa', {});
		expect(getPayload().tabId).toBe('tab-aaaa');
	});

	it('tab close fails on an unknown tab id', async () => {
		mockTab({ success: true });
		await expect(tabClose('does-not-exist', {})).rejects.toThrow('__exit__');
		expect(formatError).toHaveBeenCalledWith(expect.stringContaining('Tab not found'));
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('tab rename sends newName', async () => {
		const getPayload = mockTab({ success: true });
		await tabRename('tab-aaaa', 'Docs', {});
		const p = getPayload();
		expect(p.type).toBe('rename_tab');
		expect(p.newName).toBe('Docs');
	});

	it('tab star sends starred:true; unstar sends false', async () => {
		const getStar = mockTab({ success: true });
		await tabStar('tab-aaaa', true, {});
		expect(getStar().starred).toBe(true);

		const getUnstar = mockTab({ success: true });
		await tabStar('tab-aaaa', false, {});
		expect(getUnstar().starred).toBe(false);
	});

	it('tab move derives fromIndex from live tab order, scoped to the owning agent', async () => {
		const getPayload = mockTab({ success: true });
		await tabMove('tab-dddd', '0', {});
		const p = getPayload();
		expect(p.type).toBe('reorder_tab');
		expect(p.sessionId).toBe('agent-1');
		// agent-2's tab sits after agent-1's in the flat list; it must not shift
		// the index that agent-1's own tab bar sees.
		expect(p.fromIndex).toBe(2);
		expect(p.toIndex).toBe(0);
	});

	it('tab move accepts "first" and "last"', async () => {
		const getFirst = mockTab({ success: true });
		await tabMove('tab-dddd', 'first', {});
		expect(getFirst().toIndex).toBe(0);

		const getLast = mockTab({ success: true });
		await tabMove('tab-aaaa', 'last', {});
		expect(getLast().toIndex).toBe(2);
	});

	it('tab move clamps an out-of-range index to the last position', async () => {
		const getPayload = mockTab({ success: true });
		await tabMove('tab-aaaa', '99', {});
		expect(getPayload().toIndex).toBe(2);
	});

	it('tab move is a no-op when the tab is already at the target position', async () => {
		const getPayload = mockTab({ success: true });
		await tabMove('tab-aaaa', '0', {});
		// No reorder_tab message is sent, so nothing is captured.
		expect(getPayload()).toEqual({});
		expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('already at position 0'));
	});

	it('tab move rejects a non-numeric position', async () => {
		mockTab({ success: true });
		await expect(tabMove('tab-aaaa', 'middle', {})).rejects.toThrow('__exit__');
		expect(formatError).toHaveBeenCalledWith(expect.stringContaining('Invalid position'));
	});

	it('tab unread/read ride the allowlisted, flushed config path with a tabId', async () => {
		const getUnread = mockTab({ success: true });
		await tabUnread('tab-aaaa', true, {});
		const p = getUnread();
		expect(p.type).toBe('update_session_config');
		expect(p.sessionId).toBe('agent-1');
		expect(p.configPatch).toEqual({ tabId: 'tab-aaaa', hasUnread: true });

		const getRead = mockTab({ success: true });
		await tabUnread('tab-aaaa', false, {});
		expect(getRead().configPatch).toEqual({ tabId: 'tab-aaaa', hasUnread: false });
	});

	it('tab save-to-history sends an explicit boolean', async () => {
		const getOff = mockTab({ success: true });
		await tabSaveToHistory('tab-bbbb', false, {});
		const p = getOff();
		expect(p.sessionId).toBe('agent-2');
		expect(p.configPatch).toEqual({ tabId: 'tab-bbbb', saveToHistory: false });
	});

	it('tab flag verbs fail on an unknown tab id before contacting the desktop', async () => {
		mockTab({ success: true });
		await expect(tabUnread('nope', true, {})).rejects.toThrow('__exit__');
		expect(formatError).toHaveBeenCalledWith(expect.stringContaining('Tab not found'));
	});
});
