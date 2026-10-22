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
});
