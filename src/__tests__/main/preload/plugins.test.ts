import { describe, it, expect, vi } from 'vitest';

const ipcRenderer = vi.hoisted(() => ({
	on: vi.fn(),
	removeListener: vi.fn(),
}));
vi.mock('electron', () => ({ ipcRenderer }));
import { createPluginsApi } from '../../../main/preload/plugins';

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
