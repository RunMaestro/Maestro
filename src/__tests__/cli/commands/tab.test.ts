/**
 * @file tab.test.ts
 * @description Tests for the tab CLI command group
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', () => ({ withMaestroClient: vi.fn() }));
vi.mock('../../../cli/services/storage', () => ({
	resolveAgentId: vi.fn((id: string) => id),
	readActiveAgentId: vi.fn(() => null),
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
	tabThinking,
	tabReadOnly,
	tabModel,
	tabEffort,
	tabEnterToSend,
	tabShow,
} from '../../../cli/commands/tab';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { resolveAgentId, readActiveAgentId } from '../../../cli/services/storage';
import { formatError } from '../../../cli/output/formatter';

// agent-1 owns three tabs in tab-bar order so reordering has something to move
// against; agent-2's single tab guards against cross-agent index leakage.
function entry(tabId: string, agentId: string, over: Record<string, unknown> = {}) {
	return {
		tabId,
		sessionId: tabId,
		agentId,
		agentName: agentId,
		toolType: 'claude-code',
		name: null,
		agentSessionId: null,
		state: 'idle' as const,
		createdAt: 0,
		starred: false,
		active: false,
		hasUnread: false,
		saveToHistory: true,
		readOnly: false,
		thinking: 'off' as const,
		model: null,
		effort: null,
		enterToSend: null,
		...over,
	};
}

const SESSIONS = [
	entry('tab-aaaa', 'agent-1', { active: true, thinking: 'on' }),
	entry('tab-cccc', 'agent-1'),
	entry('tab-dddd', 'agent-1'),
	entry('tab-bbbb', 'agent-2', { active: true, model: 'opus', effort: 'high' }),
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
		vi.mocked(readActiveAgentId).mockReturnValue(null);
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

	it('tab thinking sets an explicit mode', async () => {
		const getPayload = mockTab({ success: true });
		await tabThinking('tab-cccc', 'sticky', {});
		expect(getPayload().configPatch).toEqual({ tabId: 'tab-cccc', showThinking: 'sticky' });
	});

	it("tab thinking cycle advances from the tab's live mode, not from off", async () => {
		// tab-aaaa is already on 'on', so one cycle must land on 'sticky'.
		const getPayload = mockTab({ success: true });
		await tabThinking('tab-aaaa', 'cycle', {});
		expect(getPayload().configPatch).toEqual({ tabId: 'tab-aaaa', showThinking: 'sticky' });
	});

	it('tab read-only, model, effort and enter-to-send write their own field', async () => {
		const getReadOnly = mockTab({ success: true });
		await tabReadOnly('tab-cccc', true, {});
		expect(getReadOnly().configPatch).toEqual({ tabId: 'tab-cccc', readOnlyMode: true });

		const getModel = mockTab({ success: true });
		await tabModel('tab-cccc', 'opus', {});
		expect(getModel().configPatch).toEqual({ tabId: 'tab-cccc', customModel: 'opus' });

		const getEffort = mockTab({ success: true });
		await tabEffort('tab-cccc', 'high', {});
		expect(getEffort().configPatch).toEqual({ tabId: 'tab-cccc', customEffort: 'high' });

		const getEnter = mockTab({ success: true });
		await tabEnterToSend('tab-cccc', false, {});
		expect(getEnter().configPatch).toEqual({ tabId: 'tab-cccc', enterToSend: false });
	});

	it('clearing an override sends null so the renderer drops the field', async () => {
		const getModel = mockTab({ success: true });
		await tabModel('tab-bbbb', null, {});
		expect(getModel().configPatch).toEqual({ tabId: 'tab-bbbb', customModel: null });

		const getEnter = mockTab({ success: true });
		await tabEnterToSend('tab-bbbb', null, {});
		expect(getEnter().configPatch).toEqual({ tabId: 'tab-bbbb', enterToSend: null });
	});

	it('"active" targets the agent named by --agent', async () => {
		const getPayload = mockTab({ success: true });
		await tabThinking('active', 'off', { agent: 'agent-2' });
		const p = getPayload();
		expect(p.sessionId).toBe('agent-2');
		expect(p.configPatch).toEqual({ tabId: 'tab-bbbb', showThinking: 'off' });
	});

	it('"active" falls back to the desktop\'s focused agent', async () => {
		vi.mocked(readActiveAgentId).mockReturnValue('agent-1');
		const getPayload = mockTab({ success: true });
		await tabReadOnly('active', true, {});
		expect(getPayload().configPatch).toEqual({ tabId: 'tab-aaaa', readOnlyMode: true });
	});

	it('"active" fails loudly when no agent is focused and none was named', async () => {
		mockTab({ success: true });
		await expect(tabShow('active', {})).rejects.toThrow('__exit__');
		expect(formatError).toHaveBeenCalledWith(expect.stringContaining('No active agent'));
	});

	it('tab show --json returns the whole entry without writing anything', async () => {
		const getPayload = mockTab({ success: true });
		await tabShow('tab-bbbb', { json: true });
		// No mutation was sent: the list call is the only traffic.
		expect(getPayload()).toEqual({});
		const printed = JSON.parse(consoleSpy.mock.calls.at(-1)?.[0] as string);
		expect(printed.tab.tabId).toBe('tab-bbbb');
		expect(printed.tab.model).toBe('opus');
	});
});
