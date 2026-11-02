/**
 * @file tab.test.ts
 * @description Tests for the tab CLI command group
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: vi.fn(),
	CommandTimeoutError: class CommandTimeoutError extends Error {},
	UnsupportedCommandError: class UnsupportedCommandError extends Error {},
}));
vi.mock('../../../cli/services/storage', () => ({
	resolveAgentId: vi.fn((id: string) => id),
	readActiveAgentId: vi.fn(() => null),
	getSessionById: vi.fn(),
	readHarnessTierDefaults: vi.fn(() => ({})),
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
	tabClosed,
	tabReopen,
	tabCompact,
	tabMerge,
	tabTransfer,
} from '../../../cli/commands/tab';
import { withMaestroClient, CommandTimeoutError } from '../../../cli/services/maestro-client';
import {
	resolveAgentId,
	readActiveAgentId,
	getSessionById,
	readHarnessTierDefaults,
} from '../../../cli/services/storage';
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
		vi.mocked(getSessionById).mockReturnValue(undefined);
		vi.mocked(readHarnessTierDefaults).mockReturnValue({});
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

	describe('tab new placement', () => {
		// `tab new --prompt` and `dispatch --new-tab` send the SAME
		// new_ai_tab_with_prompt message and disagree about the default: tab new
		// has always focused, dispatch has always been background. That is why the
		// default is keyed by verb rather than by message, and it is what these
		// assertions pin down.
		it('stays foreground by default, on both message shapes', async () => {
			const getNoPrompt = mockTab({ success: true, tabId: 'tab-new' });
			await tabNew({ agent: 'agent-1' });
			expect(getNoPrompt().background).toBe(false);

			const getWithPrompt = mockTab({ success: true, tabId: 'tab-new' });
			await tabNew({ agent: 'agent-1', prompt: 'hello' });
			expect(getWithPrompt().type).toBe('new_ai_tab_with_prompt');
			expect(getWithPrompt().background).toBe(false);
		});

		it('puts background:true on the wire for --background', async () => {
			const getPayload = mockTab({ success: true, tabId: 'tab-new' });
			await tabNew({ agent: 'agent-1', background: true });
			expect(getPayload().background).toBe(true);
			expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('background'));
		});

		it('lets --focus name the default explicitly', async () => {
			const getPayload = mockTab({ success: true, tabId: 'tab-new' });
			await tabNew({ agent: 'agent-1', background: true, focus: true });
			expect(getPayload().background).toBe(false);
		});
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

	it('tab model auto stores the word for an agent Auto can act on', async () => {
		vi.mocked(getSessionById).mockReturnValue({ id: 'agent-1', toolType: 'claude-code' } as never);
		const getModel = mockTab({ success: true });
		// Any spelling is the same choice, and it is stored as the word.
		await tabModel('tab-cccc', 'Auto', {});
		expect(getSessionById).not.toHaveBeenCalled();
		expect(getModel().configPatch).toEqual({ tabId: 'tab-cccc', customModel: 'auto' });
	});

	it('tab model auto is refused, by name, where it would change nothing', async () => {
		// No effort ladder and no tier mapped: the composer does not offer Auto here.
		vi.mocked(getSessionById).mockReturnValue({ id: 'agent-1', toolType: 'opencode' } as never);
		const getModel = mockTab({ success: false, error: 'Auto would change nothing for this agent' });
		await expect(tabModel('tab-cccc', 'auto', {})).rejects.toThrow('__exit__');
		expect(formatError).toHaveBeenCalledWith(
			expect.stringContaining('Auto would change nothing for this agent')
		);
		expect(getModel().configPatch).toEqual({ tabId: 'tab-cccc', customModel: 'auto' });
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('tab model auto is allowed once a tier of the agent is mapped', async () => {
		vi.mocked(getSessionById).mockReturnValue({
			id: 'agent-1',
			toolType: 'opencode',
			tierTargets: { medium: { type: 'provider-model', model: 'big-pickle' } },
		} as never);
		const getModel = mockTab({ success: true });
		await tabModel('tab-cccc', 'auto', {});
		expect(getModel().configPatch).toEqual({ tabId: 'tab-cccc', customModel: 'auto' });
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

	describe('closed tabs', () => {
		const CLOSED = [
			{ index: 0, type: 'ai', label: 'Refactor', tabId: 'tab-old1', closedAt: Date.now() - 60_000 },
			{
				index: 1,
				type: 'file',
				label: 'notes.md',
				tabId: 'file-9',
				closedAt: Date.now() - 120_000,
				tiled: true,
			},
		];

		it("tab closed lists the agent's stack, newest first", async () => {
			const getPayload = mockTab({ success: true, closedTabs: CLOSED });
			await tabClosed({ agent: 'agent-1' });
			expect(getPayload()).toEqual({
				type: 'closed_tab_command',
				action: 'list',
				sessionId: 'agent-1',
			});
			const printed = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
			expect(printed).toContain('Refactor');
			expect(printed).toContain('tab-old1');
			expect(printed).toContain('file, tiled');
		});

		it('tab closed --json prints the stack as data', async () => {
			mockTab({ success: true, closedTabs: CLOSED });
			await tabClosed({ agent: 'agent-1', json: true });
			const printed = JSON.parse(consoleSpy.mock.calls.at(-1)?.[0] as string);
			expect(printed).toEqual({ success: true, sessionId: 'agent-1', closedTabs: CLOSED });
		});

		it('tab closed on an empty stack says so and exits cleanly', async () => {
			mockTab({ success: true, closedTabs: [] });
			await tabClosed({ agent: 'agent-1' });
			expect(processExitSpy).not.toHaveBeenCalled();
			expect(consoleSpy).toHaveBeenCalledWith('No closed tabs for agent-1');
		});

		it("tab closed falls back to the desktop's selected agent", async () => {
			vi.mocked(readActiveAgentId).mockReturnValue('agent-2');
			const getPayload = mockTab({ success: true, closedTabs: [] });
			await tabClosed({});
			expect(getPayload().sessionId).toBe('agent-2');
		});

		it('tab closed fails loudly with no --agent and no selected agent', async () => {
			mockTab({ success: true, closedTabs: [] });
			await expect(tabClosed({})).rejects.toThrow('__exit__');
			expect(formatError).toHaveBeenCalledWith(expect.stringContaining('No active agent'));
		});

		it('tab reopen with no target restores the newest entry and focuses it', async () => {
			const getPayload = mockTab({
				success: true,
				tabId: 'tab-new1',
				tabType: 'ai',
				reopened: CLOSED[0],
				content: 'loaded',
			});
			await tabReopen({ agent: 'agent-1' });
			expect(getPayload()).toEqual({
				type: 'closed_tab_command',
				action: 'reopen',
				sessionId: 'agent-1',
				background: false,
			});
			expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Reopened "Refactor"'));
			expect(consoleSpy).toHaveBeenCalledWith('  Tab: tab-new1');
		});

		it('tab reopen --index sends the position as a number', async () => {
			const getPayload = mockTab({ success: true, tabId: 'file-9', reopened: CLOSED[1] });
			await tabReopen({ agent: 'agent-1', index: '1' });
			expect(getPayload().index).toBe(1);
			expect(getPayload()).not.toHaveProperty('tabId');
		});

		it('tab reopen --tab sends the original tab id', async () => {
			const getPayload = mockTab({ success: true, tabId: 'tab-new1', reopened: CLOSED[0] });
			await tabReopen({ agent: 'agent-1', tab: 'tab-old' });
			expect(getPayload().tabId).toBe('tab-old');
			expect(getPayload()).not.toHaveProperty('index');
		});

		it('tab reopen --background puts background on the wire', async () => {
			const getPayload = mockTab({ success: true, tabId: 'tab-new1', reopened: CLOSED[0] });
			await tabReopen({ agent: 'agent-1', background: true });
			expect(getPayload().background).toBe(true);
		});

		it('tab reopen --json reports the restored tab id', async () => {
			mockTab({
				success: true,
				tabId: 'tab-new1',
				tabType: 'ai',
				reopened: CLOSED[0],
				content: 'pending',
			});
			await tabReopen({ agent: 'agent-1', json: true });
			const printed = JSON.parse(consoleSpy.mock.calls.at(-1)?.[0] as string);
			expect(printed).toMatchObject({
				success: true,
				sessionId: 'agent-1',
				tabId: 'tab-new1',
				tabType: 'ai',
				wasDuplicate: false,
				content: 'pending',
				background: false,
			});
			expect(printed.reopened.tabId).toBe('tab-old1');
		});

		it("tab reopen on an empty stack exits non-zero with the desktop's message", async () => {
			mockTab({ success: false, error: 'No closed tabs to reopen for agent-1' });
			await expect(tabReopen({ agent: 'agent-1', json: true })).rejects.toThrow('__exit__');
			expect(processExitSpy).toHaveBeenCalledWith(1);
			const printed = JSON.parse(consoleSpy.mock.calls.at(-1)?.[0] as string);
			expect(printed).toEqual({ success: false, error: 'No closed tabs to reopen for agent-1' });
		});

		it('tab reopen refuses --index and --tab together before contacting the app', async () => {
			mockTab({ success: true });
			await expect(tabReopen({ agent: 'agent-1', index: '0', tab: 'tab-old' })).rejects.toThrow(
				'__exit__'
			);
			expect(withMaestroClient).not.toHaveBeenCalled();
		});

		it.each(['-1', '1.5', 'two', ''])('tab reopen refuses --index %j', async (index) => {
			mockTab({ success: true });
			await expect(tabReopen({ agent: 'agent-1', index })).rejects.toThrow('__exit__');
			expect(withMaestroClient).not.toHaveBeenCalled();
		});
	});

	describe('tab compact / merge / transfer', () => {
		/** Capture every command the verb sends with its timeout, answering the op with `result`. */
		function mockContextOp(result: unknown) {
			const sent: Array<{
				payload: Record<string, unknown>;
				responseType: string;
				timeoutMs?: number;
			}> = [];
			vi.mocked(withMaestroClient).mockImplementation(async (action) =>
				action({
					sendCommand: vi
						.fn()
						.mockImplementation(
							(payload: Record<string, unknown>, responseType: string, timeoutMs?: number) => {
								if (payload.type === 'list_desktop_sessions') {
									return Promise.resolve({ sessions: SESSIONS });
								}
								sent.push({ payload, responseType, timeoutMs });
								return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
							}
						),
				} as never)
			);
			return sent;
		}
		const lastJson = () => JSON.parse(consoleSpy.mock.calls.at(-1)?.[0] as string);

		it('tab compact defaults to the active tab of -a and prints the new tab id', async () => {
			const sent = mockContextOp({ success: true, newTabId: 'tab-new', reductionPercent: 64 });
			await tabCompact(undefined, { agent: 'agent-2' });

			expect(sent).toHaveLength(1);
			expect(sent[0].payload).toEqual({
				type: 'summarize_context',
				sessionId: 'agent-2',
				tabId: 'tab-bbbb',
			});
			expect(sent[0].responseType).toBe('summarize_context_result');
			// A compaction is a summarization turn: minutes, not the default 10 s.
			expect(sent[0].timeoutMs).toBeGreaterThan(10 * 60_000);
			expect(consoleSpy).toHaveBeenCalledWith('  Tab: tab-new');
		});

		it('tab compact --background --json resolves an explicit tab prefix', async () => {
			const sent = mockContextOp({ success: true, newTabId: 'tab-new', reductionPercent: 64 });
			await tabCompact('tab-cc', { background: true, json: true });

			expect(sent[0].payload).toEqual({
				type: 'summarize_context',
				sessionId: 'agent-1',
				tabId: 'tab-cccc',
				background: true,
			});
			expect(lastJson()).toEqual({
				success: true,
				agentId: 'agent-1',
				tabId: 'tab-cccc',
				newTabId: 'tab-new',
				reductionPercent: 64,
				background: true,
			});
		});

		it('tab compact refuses a tab that belongs to another agent than -a', async () => {
			const sent = mockContextOp({ success: true });
			await expect(tabCompact('tab-bbbb', { agent: 'agent-1' })).rejects.toThrow('__exit__');
			expect(sent).toHaveLength(0);
		});

		it("tab compact reports the desktop's refusal and exits 1", async () => {
			mockContextOp({ success: false, error: 'Context too small' });
			await expect(tabCompact(undefined, { agent: 'agent-1', json: true })).rejects.toThrow(
				'__exit__'
			);
			expect(processExitSpy).toHaveBeenCalledWith(1);
			expect(lastJson()).toEqual({ success: false, error: 'Context too small' });
		});

		it('tab compact reports a timeout apart from a failure (exit 5)', async () => {
			mockContextOp(new CommandTimeoutError('summarize_context_result'));
			await expect(tabCompact(undefined, { agent: 'agent-1', json: true })).rejects.toThrow(
				'__exit__'
			);
			expect(processExitSpy).toHaveBeenCalledWith(5);
			expect(lastJson()).toMatchObject({ success: false, timedOut: true });
			expect(lastJson().error).toContain('may still be running');
		});

		it("treats main's timedOut answer as a timeout too", async () => {
			mockContextOp({ success: false, timedOut: true, error: 'still summarizing' });
			await expect(tabCompact(undefined, { agent: 'agent-1' })).rejects.toThrow('__exit__');
			expect(processExitSpy).toHaveBeenCalledWith(5);
		});

		it('tab merge sends both tabs and reports the receiving tab', async () => {
			const sent = mockContextOp({ success: true, targetTabId: 'tab-bbbb' });
			await tabMerge('tab-dddd', { into: 'agent-2', targetTab: 'tab-bbbb', json: true });

			expect(sent[0].payload).toEqual({
				type: 'merge_context',
				sourceSessionId: 'agent-1',
				targetSessionId: 'agent-2',
				tabId: 'tab-dddd',
				targetTabId: 'tab-bbbb',
			});
			expect(lastJson()).toEqual({
				success: true,
				agentId: 'agent-1',
				tabId: 'tab-dddd',
				targetAgentId: 'agent-2',
				targetTabId: 'tab-bbbb',
				staged: false,
				background: false,
			});
		});

		it('tab merge --background says when the context waits for the tab to be opened', async () => {
			const sent = mockContextOp({ success: true, targetTabId: 'tab-bbbb', staged: true });
			await tabMerge(undefined, { agent: 'agent-1', into: 'agent-2', background: true });

			expect(sent[0].payload).toMatchObject({ tabId: 'tab-aaaa', background: true });
			expect(sent[0].payload).not.toHaveProperty('targetTabId');
			expect(consoleSpy).toHaveBeenCalledWith('  The context sends when that tab is next opened.');
		});

		it('tab merge refuses a --target-tab that is not in the --into agent', async () => {
			const sent = mockContextOp({ success: true });
			await expect(
				tabMerge('tab-aaaa', { into: 'agent-2', targetTab: 'tab-cccc' })
			).rejects.toThrow('__exit__');
			expect(sent).toHaveLength(0);
		});

		it('tab transfer opens a tab in the target and prints its id', async () => {
			const sent = mockContextOp({ success: true, newTabId: 'tab-moved', queued: true });
			await tabTransfer('tab-aaaa', { to: 'agent-2', focus: true, json: true });

			expect(sent[0].payload).toEqual({
				type: 'transfer_context',
				sourceSessionId: 'agent-1',
				targetSessionId: 'agent-2',
				tabId: 'tab-aaaa',
			});
			expect(sent[0].responseType).toBe('transfer_context_result');
			expect(lastJson()).toEqual({
				success: true,
				agentId: 'agent-1',
				tabId: 'tab-aaaa',
				targetAgentId: 'agent-2',
				newTabId: 'tab-moved',
				queued: true,
				background: false,
			});
		});

		it('tab transfer refuses the source agent as the target before sending', async () => {
			const sent = mockContextOp({ success: true });
			await expect(tabTransfer('tab-aaaa', { to: 'agent-1' })).rejects.toThrow('__exit__');
			expect(sent).toHaveLength(0);
		});

		it("tab transfer reports the desktop's failure", async () => {
			mockContextOp({ success: false, error: 'Agent agent-2 is a terminal and has no AI tabs' });
			await expect(tabTransfer('tab-aaaa', { to: 'agent-2', json: true })).rejects.toThrow(
				'__exit__'
			);
			expect(lastJson()).toEqual({
				success: false,
				error: 'Agent agent-2 is a terminal and has no AI tabs',
			});
		});
	});
});
