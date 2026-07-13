import { describe, expect, it, vi } from 'vitest';

const { listeners, removeListener } = vi.hoisted(() => ({
	listeners: new Map<string, (event: unknown, payload: unknown) => void>(),
	removeListener: vi.fn(),
}));
vi.mock('electron', () => ({
	ipcRenderer: {
		on: vi.fn((channel: string, listener: (event: unknown, payload: unknown) => void) =>
			listeners.set(channel, listener)
		),
		removeListener,
	},
}));

import { createOmpWorkspaceApi } from '../../../main/preload/ompWorkspace';

describe('OmpWorkspaceApi', () => {
	it('forwards only validated workspace-context transitions and removes its exact listener', () => {
		const callback = vi.fn();
		const api = createOmpWorkspaceApi();
		const dispose = api.onContextChanged(callback);
		const listener = listeners.get('plugins:workspace-context');
		if (!listener) throw new Error('workspace listener missing');

		listener(
			{},
			{
				kind: 'external-session-selected',
				ownerPluginId: 'com.maestro.omp',
				workspaceLocalId: 'omp',
				snapshotToken: 'opaque',
			}
		);
		listener(
			{},
			{
				kind: 'external-session-selected',
				ownerPluginId: 1,
				workspaceLocalId: 'omp',
				snapshotToken: 'opaque',
			}
		);
		listener({}, { kind: 'unexpected', ownerPluginId: 'com.maestro.omp', workspaceLocalId: 'omp' });

		expect(callback).toHaveBeenCalledTimes(1);
		expect(callback).toHaveBeenCalledWith(
			expect.objectContaining({ kind: 'external-session-selected' })
		);
		dispose();
		expect(removeListener).toHaveBeenCalledWith('plugins:workspace-context', listener);
	});
});
