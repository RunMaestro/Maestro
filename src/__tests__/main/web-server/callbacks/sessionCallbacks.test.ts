import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerSessionCallbacks } from '../../../../main/web-server/callbacks/sessionCallbacks';

type HistoryCallback = (
	tabId: string,
	options?: { sinceMs?: number; tail?: number }
) => { tabId: string; agentId: string; messages: { content: string }[] } | null;

function setup(sessions: unknown[]) {
	let historyCallback: HistoryCallback | undefined;
	const server = new Proxy(
		{},
		{
			get: (_target, prop: string) =>
				prop === 'setGetSessionHistoryCallback'
					? (callback: HistoryCallback) => {
							historyCallback = callback;
						}
					: () => {},
		}
	);
	const store = (value: unknown) => ({ get: vi.fn(() => value) });

	registerSessionCallbacks(
		server as never,
		{
			sessionsStore: store(sessions),
			groupsStore: store([]),
			getProcessManager: () => null,
		} as never
	);

	return historyCallback!;
}

const log = (text: string) => ({ id: text, source: 'user', text, timestamp: 1_000 });

describe('session history callback', () => {
	it('returns the history of an open tab', () => {
		const getHistory = setup([{ id: 'agent-1', aiTabs: [{ id: 'tab-1', logs: [log('hello')] }] }]);

		expect(getHistory('tab-1')?.messages.map((m) => m.content)).toEqual(['hello']);
	});

	it('finds a snoozed tab instead of reporting it missing', () => {
		const getHistory = setup([
			{
				id: 'agent-1',
				aiTabs: [],
				snoozedTabs: [{ type: 'ai', tab: { id: 'tab-parked', logs: [log('parked')] } }],
			},
		]);

		const result = getHistory('tab-parked');
		expect(result?.agentId).toBe('agent-1');
		expect(result?.messages.map((m) => m.content)).toEqual(['parked']);
	});

	it('finds an AI tab inside a snoozed group', () => {
		const getHistory = setup([
			{
				id: 'agent-1',
				aiTabs: [],
				snoozedTabs: [
					{
						type: 'group',
						members: [{ type: 'ai', tab: { id: 'tab-grouped', logs: [log('grouped')] } }],
					},
				],
			},
		]);

		expect(getHistory('tab-grouped')?.messages.map((m) => m.content)).toEqual(['grouped']);
	});

	it('returns null for a tab that exists nowhere', () => {
		const getHistory = setup([{ id: 'agent-1', aiTabs: [] }]);

		expect(getHistory('tab-gone')).toBeNull();
	});
	it('reports the tab owner separately from the default and captured turn', () => {
		const getHistory = setup([
			{
				id: 'agent',
				toolType: 'claude-code',
				customModel: 'opus',
				aiTabs: [
					{
						id: 'tab',
						agentSessionId: 'codex-native',
						tabProvider: 'codex',
						turnProvider: 'claude-code',
						customModel: 'auto',
						logs: [],
					},
				],
			},
		]);
		expect(getHistory('tab')).toMatchObject({
			agentSessionId: 'codex-native',
			provider: 'codex',
			agentProvider: 'claude-code',
			tabProvider: 'codex',
			turnProvider: 'claude-code',
			effectiveModel: 'auto',
		});
	});
});

// Grok's native id arrives on `end` and belongs to one tab; every read names the
// tab's own id (or none yet), never the agent-level sibling id.
describe('Grok agents through the session callbacks', () => {
	function setupAll(sessions: unknown[]) {
		const registered: Record<string, (...args: never[]) => unknown> = {};
		const server = new Proxy(
			{},
			{
				get: (_target, prop: string) => (callback: (...args: never[]) => unknown) => {
					registered[prop] = callback;
				},
			}
		);
		const store = (value: unknown) => ({ get: vi.fn(() => value) });
		registerSessionCallbacks(
			server as never,
			{
				sessionsStore: store(sessions),
				groupsStore: store([]),
				getProcessManager: () => null,
			} as never
		);
		return registered as Record<string, (...args: unknown[]) => any>;
	}

	// Tab B reported last, so the agent-level field names tab B's conversation.
	const grokAgent = () => ({
		id: 'grok-agent',
		name: 'Grok',
		toolType: 'grok',
		state: 'idle',
		inputMode: 'ai',
		cwd: '/home/user/project',
		agentSessionId: 'grok-native-b',
		activeTabId: 'tab-a',
		aiTabs: [
			{
				id: 'tab-a',
				agentSessionId: 'grok-native-a',
				state: 'idle',
				customModel: 'grok-code-fast-1',
				customEffort: 'high',
				logs: [
					{
						id: 'u1',
						source: 'user',
						text: 'look',
						timestamp: 1_000,
						images: ['data:image/png;base64,Z3Jvaw=='],
					},
					{ id: 'a1', source: 'stdout', text: 'done', timestamp: 2_000 },
				],
			},
			{ id: 'tab-b', agentSessionId: 'grok-native-b', state: 'idle', logs: [] },
			// Fresh tab: its end-only id has not arrived.
			{ id: 'tab-fresh', state: 'busy', logs: [] },
		],
	});

	it("lists the Grok agent under its stable id with each tab's own native id, null before end", () => {
		const [entry] = setupAll([grokAgent()]).setGetSessionsCallback();
		expect(entry.toolType).toBe('grok');
		expect(entry.aiTabs.map((t: any) => [t.id, t.agentSessionId])).toEqual([
			['tab-a', 'grok-native-a'],
			['tab-b', 'grok-native-b'],
			['tab-fresh', null],
		]);
		expect(entry.lastResponse).toMatchObject({ text: 'done', source: 'stdout' });
	});

	it('flattens Grok tabs for the CLI with provider, native id, model and effort from the tab', () => {
		const entries = setupAll([grokAgent()]).setListDesktopSessionsCallback().sessions;
		expect(
			entries.map((e: any) => [e.tabId, e.toolType, e.agentSessionId, e.model, e.effort, e.state])
		).toEqual([
			['tab-a', 'grok', 'grok-native-a', 'grok-code-fast-1', 'high', 'idle'],
			['tab-b', 'grok', 'grok-native-b', null, null, 'idle'],
			['tab-fresh', 'grok', null, null, null, 'busy'],
		]);
	});

	it("answers a Grok tab history with that tab's id, never the agent-level sibling id", () => {
		const getHistory = setupAll([grokAgent()]).setGetSessionHistoryCallback;
		expect(getHistory('tab-a')).toMatchObject({
			agentId: 'grok-agent',
			agentSessionId: 'grok-native-a',
			projectPath: '/home/user/project',
		});
		expect(getHistory('tab-fresh').agentSessionId).toBeNull();
	});

	it('details each Grok tab with its own native id and its images, and a missing tab with none', () => {
		const detail = setupAll([grokAgent()]).setGetSessionDetailCallback;
		const a = detail('grok-agent', 'tab-a');
		expect(a).toMatchObject({
			toolType: 'grok',
			activeTabId: 'tab-a',
			agentSessionId: 'grok-native-a',
		});
		expect(a.aiLogs[0].images).toEqual(['data:image/png;base64,Z3Jvaw==']);
		expect(detail('grok-agent').agentSessionId).toBe('grok-native-a');
		expect(detail('grok-agent', 'tab-b').agentSessionId).toBe('grok-native-b');
		const fresh = detail('grok-agent', 'tab-fresh');
		expect(fresh.agentSessionId).toBeUndefined();
		expect(fresh.aiLogs).toEqual([]);
		const missing = detail('grok-agent', 'tab-gone');
		expect(missing.agentSessionId).toBeUndefined();
		expect(missing.aiLogs).toEqual([]);
		expect(detail('not-an-agent')).toBeNull();
	});
});
