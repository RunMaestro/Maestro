import { describe, expect, it, vi } from 'vitest';
import { registerSessionCallbacks } from '../../../../main/web-server/callbacks/sessionCallbacks';
import { trackHeadlessAgentActivity } from '../../../../main/utils/headless-agent-activity';
import type { WebServer } from '../../../../main/web-server/WebServer';

vi.mock('../../../../shared/cli-activity', () => ({
	getSessionIdsBusyWithCli: () => new Set(),
	isSessionBusyWithCli: () => false,
}));
vi.mock('../../../../main/storage/session-image-store', () => ({ isImageRef: () => false }));

describe('live agent status with headless work', () => {
	it('aggregates Desktop and parallel Relay processes without assigning them to a desktop tab', () => {
		const callbacks: Record<string, (...args: unknown[]) => unknown> = {};
		const server = new Proxy(
			{},
			{
				get: (_target, name: string) => (callback: (...args: unknown[]) => unknown) => {
					callbacks[name] = callback;
				},
			}
		);
		const desktop = new Set<string>();
		const stored = [
			{
				id: 'target',
				state: 'idle',
				activeTabId: 'desktop',
				aiTabs: [{ id: 'desktop', state: 'idle', origin: 'relay' }],
			},
			{ id: 'other', state: 'idle', aiTabs: [] },
		];
		const get = vi.fn(() => stored);
		registerSessionCallbacks(server as WebServer, {
			sessionsStore: { get } as never,
			groupsStore: { get: () => [] } as never,
			getProcessManager: () =>
				({ get: (id: string) => (desktop.has(id) ? {} : undefined) }) as never,
		});
		const read = () => callbacks.setGetSessionsCallback() as Array<{ state: string }>;
		const readTabs = () => callbacks.setListDesktopSessionsCallback() as Array<{ state: string }>;
		expect(read().map((s) => s.state)).toEqual(['idle', 'idle']);
		const first = trackHeadlessAgentActivity('target');
		const second = trackHeadlessAgentActivity('target');
		try {
			expect(read().map((s) => s.state)).toEqual(['busy', 'idle']);
			expect(readTabs()).toHaveLength(1);
			expect(readTabs()[0].state).toBe('idle'); // headless is not the user's active desktop turn
			first();
			first();
			expect(read()[0].state).toBe('busy');
			desktop.add('target-ai-desktop');
			second();
			expect(read()[0].state).toBe('busy');
			desktop.clear();
			expect(read()[0].state).toBe('idle');
			expect(stored[0].state).toBe('idle');
			expect(stored[0].activeTabId).toBe('desktop');
		} finally {
			first();
			second();
		}
	});
});
