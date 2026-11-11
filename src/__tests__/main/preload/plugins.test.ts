import { describe, it, expect, vi } from 'vitest';

const ipcRenderer = vi.hoisted(() => ({
	invoke: vi.fn(),
	on: vi.fn(),
	removeListener: vi.fn(),
}));
vi.mock('electron', () => ({ ipcRenderer }));
import { createPluginsApi } from '../../../main/preload/plugins';

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
