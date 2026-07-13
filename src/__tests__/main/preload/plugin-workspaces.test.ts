import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke, listeners, removeListener } = vi.hoisted(() => ({
	invoke: vi.fn(),
	listeners: new Map<string, (event: unknown, payload: unknown) => void>(),
	removeListener: vi.fn(),
}));

vi.mock('electron', () => ({
	ipcRenderer: {
		invoke,
		on: vi.fn((channel: string, listener: (event: unknown, payload: unknown) => void) => {
			listeners.set(channel, listener);
		}),
		removeListener,
	},
}));

import { createPluginWorkspacesApi } from '../../../main/preload/plugin-workspaces';

const snapshot = {
	connection: 'ready' as const,
	workspaces: [
		{
			ownerPluginId: 'com.maestro.omp',
			workspaceLocalId: 'omp',
			generation: '1',
			projectionRevision: 7,
			status: { state: 'degraded' as const, label: 'Syncing OMP' },
			badge: 4,
			sessions: [],
		},
	],
	selection: null,
};

describe('plugin workspace preload bridge', () => {
	beforeEach(() => {
		invoke.mockReset();
		removeListener.mockReset();
		listeners.clear();
	});

	it('exposes only frozen typed renderer operations and preserves the projection verbatim', async () => {
		invoke.mockResolvedValueOnce(snapshot);
		const api = createPluginWorkspacesApi();

		expect(Object.isFrozen(api)).toBe(true);
		expect(Object.keys(api).sort()).toEqual([
			'getSnapshot',
			'mountPanel',
			'panelRequest',
			'panelSubscribe',
			'panelUnsubscribe',
			'panelUnsubscribeAll',
			'revealOrSelect',
			'subscribe',
			'unmountPanel',
		]);
		await expect(api.getSnapshot()).resolves.toBe(snapshot);
		expect(invoke).toHaveBeenLastCalledWith('plugin-workspaces:get-snapshot');

		const listener = vi.fn();
		const unsubscribe = api.subscribe(listener);
		listeners.get('plugin-workspaces:changed')?.({}, snapshot);
		expect(listener).toHaveBeenCalledWith(snapshot);
		unsubscribe();
		expect(removeListener).toHaveBeenCalledOnce();
	});

	it('forwards reveal and panel lifecycle only through fixed IPC channels', async () => {
		const api = createPluginWorkspacesApi();
		const reveal = { snapshotToken: 'opaque-token-000000000000' };
		const mount = {
			ownerPluginId: 'com.maestro.omp',
			workspaceLocalId: 'omp',
			generation: '1',
			guestWebContentsId: 42,
		};

		await api.revealOrSelect(reveal);
		await api.mountPanel(mount);
		await api.unmountPanel({ instanceId: 'panel-instance' });

		expect(invoke).toHaveBeenNthCalledWith(1, 'plugin-workspaces:reveal-or-select', reveal);
		expect(invoke).toHaveBeenNthCalledWith(2, 'plugin-workspaces:mount-panel', mount);
		expect(invoke).toHaveBeenNthCalledWith(3, 'plugin-workspaces:unmount-panel', {
			instanceId: 'panel-instance',
		});
	});

	it('forwards guest panel transport through fixed named ingress operations', async () => {
		const api = createPluginWorkspacesApi();
		const request = {
			guestWebContentsId: 42,
			instanceId: 'panel-instance',
			requestId: 1,
			kind: 'ping',
			payload: { state: 'ready' },
		};
		const subscription = {
			guestWebContentsId: 42,
			instanceId: 'panel-instance',
			kind: 'status',
		};
		const instance = { guestWebContentsId: 42, instanceId: 'panel-instance' };

		await api.panelRequest(request);
		await api.panelSubscribe(subscription);
		await api.panelUnsubscribe(subscription);
		await api.panelUnsubscribeAll(instance);

		expect(invoke).toHaveBeenNthCalledWith(1, 'plugin-workspaces:panel-request', request);
		expect(invoke).toHaveBeenNthCalledWith(2, 'plugin-workspaces:panel-subscribe', subscription);
		expect(invoke).toHaveBeenNthCalledWith(3, 'plugin-workspaces:panel-unsubscribe', subscription);
		expect(invoke).toHaveBeenNthCalledWith(4, 'plugin-workspaces:panel-unsubscribe-all', instance);
	});
});
