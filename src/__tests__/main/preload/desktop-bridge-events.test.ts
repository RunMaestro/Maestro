// Source: src/__tests__/main/preload/federation.test.ts
// Source: src/__tests__/main/preload/tabs.test.ts
// Source: src/__tests__/main/preload/plugins.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFederationApi } from '../../../main/preload/federation';
import { createTabsApi } from '../../../main/preload/tabs';
import { createPluginsApi } from '../../../main/preload/plugins';
const ipcRenderer = vi.hoisted(() => ({
	invoke: vi.fn(),
	on: vi.fn(),
	removeListener: vi.fn(),
	send: vi.fn(),
}));
vi.mock('electron', () => ({ ipcRenderer }));
beforeEach(() => {
	for (const mock of Object.values(ipcRenderer)) mock.mockReset();
});
describe('federation', () => {
	const mockInvoke = ipcRenderer.invoke;

	describe('Federation Preload API', () => {
		let api: ReturnType<typeof createFederationApi>;

		beforeEach(() => {
			vi.clearAllMocks();
			mockInvoke.mockResolvedValue(undefined);
			api = createFederationApi();
		});

		it('exposes the History verbs beside the mirror reads', () => {
			expect(Object.keys(api)).toEqual(
				expect.arrayContaining(['historyPage', 'historyGraph', 'historyOffset', 'transcript'])
			);
		});

		it('pages a mirrored agent History with its query, or an empty one', async () => {
			const page = { entries: [], hasMore: false, total: 0, limit: 20, offset: 0 };
			mockInvoke.mockResolvedValueOnce(page);
			const query = { lookbackHours: 24, types: ['USER' as const], hostKey: 'laptop' };
			await expect(api.historyPage('build', 'a1', query)).resolves.toBe(page);
			expect(mockInvoke).toHaveBeenCalledWith('federation:historyPage', 'build', 'a1', query);
			await api.historyPage('build', 'a1');
			expect(mockInvoke).toHaveBeenLastCalledWith('federation:historyPage', 'build', 'a1', {});
		});

		it('reads the graph with the bucket count and lookback in order', async () => {
			await api.historyGraph('build', 'a1', 24, null);
			expect(mockInvoke).toHaveBeenCalledWith('federation:historyGraph', 'build', 'a1', 24, null);
		});

		it('reads the offset with the timestamp, lookback, and types in order', async () => {
			mockInvoke.mockResolvedValueOnce(4);
			await expect(api.historyOffset('build', 'a1', 1234, 48, ['AUTO'])).resolves.toBe(4);
			expect(mockInvoke).toHaveBeenCalledWith('federation:historyOffset', 'build', 'a1', 1234, 48, [
				'AUTO',
			]);
		});
	});
});
describe('tabs', () => {
	const mockSend = ipcRenderer.send;

	describe('Tabs Preload API', () => {
		beforeEach(() => {
			vi.clearAllMocks();
		});

		it('notifies main that an AI tab closed, fire-and-forget', () => {
			const api = createTabsApi();

			const result = api.notifyAiTabClosed('agent-1', 'tab-7');

			expect(mockSend).toHaveBeenCalledWith('tabs:aiTabClosed', 'agent-1', 'tab-7');
			// send() is one-way: nothing to await, nothing to unwrap.
			expect(result).toBeUndefined();
		});
	});
});
describe('plugins', () => {
	describe('plugin source operations', () => {
		it('forwards the archive path and chosen installed plugin id on update', async () => {
			await createPluginsApi().update('/releases/relay.tgz', 'sh.maestro.relay');
			expect(ipcRenderer.invoke).toHaveBeenLastCalledWith(
				'plugins:update',
				'/releases/relay.tgz',
				'sh.maestro.relay'
			);
		});

		it('retains update callers that infer the installed id from the source', async () => {
			await createPluginsApi().update('/releases/plugin');
			expect(ipcRenderer.invoke).toHaveBeenLastCalledWith(
				'plugins:update',
				'/releases/plugin',
				undefined
			);
		});
	});

	describe('plugin contribution change notifications', () => {
		it('forwards live panel IDs without exposing the registry and removes the listener', () => {
			const callback = vi.fn();
			const unsubscribe = createPluginsApi().onChanged(callback);
			const [channel, listener] = ipcRenderer.on.mock.calls.at(-1)!;
			expect(channel).toBe('plugins:changed');
			listener({}, { records: [{ source: '/private/plugin' }] }, ['p/config']);
			expect(callback).toHaveBeenLastCalledWith(['p/config']);
			listener({}, { records: [] }, []);
			expect(callback).toHaveBeenLastCalledWith([]);
			listener({}, { records: [] });
			expect(callback).toHaveBeenLastCalledWith(undefined);
			unsubscribe();
			expect(ipcRenderer.removeListener).toHaveBeenCalledWith(channel, listener);
		});
	});
});
