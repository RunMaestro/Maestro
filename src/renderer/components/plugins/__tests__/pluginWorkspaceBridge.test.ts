import { describe, expect, it, vi } from 'vitest';
import {
	createInteractivePanelHostBinder,
	createPluginWorkspaceProjectionSource,
} from '../pluginWorkspaceBridge';
import type {
	PluginWorkspacesApi,
	PluginWorkspacesSnapshotDto,
} from '../../../../shared/plugins/plugin-workspace-bridge';
import type { CanonicalInteractivePanelContribution } from '../../../../shared/plugins/contributions';

const snapshot: PluginWorkspacesSnapshotDto = {
	connection: 'ready',
	selection: null,
	workspaces: [
		{
			ownerPluginId: 'com.maestro.omp',
			workspaceLocalId: 'omp',
			panelLocalId: 'main-panel',
			generation: '2',
			projectionRevision: 3,
			status: { state: 'ready', label: 'Ready' },
			badge: null,
			sessions: [],
		},
	],
};

function api(): PluginWorkspacesApi {
	return {
		getSnapshot: vi.fn(async () => snapshot),
		subscribe: vi.fn(() => vi.fn()),
		revealOrSelect: vi.fn(async () => null),
		mountPanel: vi.fn(async () => ({ instanceId: 'panel-instance' })),
		unmountPanel: vi.fn(async () => undefined),
		panelRequest: vi.fn(async () => undefined),
		panelSubscribe: vi.fn(async () => undefined),
		panelUnsubscribe: vi.fn(async () => undefined),
		panelUnsubscribeAll: vi.fn(async () => undefined),
	};
}

describe('plugin workspace renderer adapters', () => {
	it('keeps owner identity out of opaque session selection requests', async () => {
		const bridge = api();
		const source = createPluginWorkspaceProjectionSource(bridge);

		await source.reveal({ snapshotToken: 'opaque-token-000000000000' });
		expect(bridge.revealOrSelect).toHaveBeenCalledWith({
			snapshotToken: 'opaque-token-000000000000',
		});
	});

	it('binds a panel guest only after resolving its trusted workspace projection and unmounts it on cleanup', async () => {
		const bridge = api();
		const binder = createInteractivePanelHostBinder(bridge);
		const listeners = new Map<string, () => void>();
		const webview = {
			addEventListener: vi.fn((event: string, listener: () => void) =>
				listeners.set(event, listener)
			),
			removeEventListener: vi.fn(),
			getWebContentsId: () => 42,
		};

		const unbind = binder.bind({
			panel: {
				ownerPluginId: 'com.maestro.omp',
				localId: 'main-panel',
				canonicalContributionId: 'com.maestro.omp/main-panel',
				title: 'OMP',
				entry: 'panel.html',
			} as unknown as CanonicalInteractivePanelContribution,
			webview: webview as never,
		});
		listeners.get('dom-ready')?.();
		await Promise.resolve();
		await Promise.resolve();

		expect(bridge.mountPanel).toHaveBeenCalledWith({
			ownerPluginId: 'com.maestro.omp',
			workspaceLocalId: 'omp',
			generation: '2',
			guestWebContentsId: 42,
		});
		unbind();
		expect(bridge.unmountPanel).toHaveBeenCalledWith({ instanceId: 'panel-instance' });
	});

	it('relays only closed guest panel messages through their named sender-bound operations', async () => {
		const bridge = api();
		const binder = createInteractivePanelHostBinder(bridge);
		const listeners = new Map<string, (event: Event) => void>();
		const webview = {
			addEventListener: vi.fn((event: string, listener: (event: Event) => void) =>
				listeners.set(event, listener)
			),
			removeEventListener: vi.fn(),
			getWebContentsId: () => 42,
		};

		binder.bind({
			panel: {
				ownerPluginId: 'com.maestro.omp',
				localId: 'main-panel',
				canonicalContributionId: 'com.maestro.omp/main-panel',
				title: 'OMP',
				entry: 'panel.html',
			} as unknown as CanonicalInteractivePanelContribution,
			webview: webview as never,
		});
		listeners.get('dom-ready')?.(new Event('dom-ready'));
		await Promise.resolve();
		await Promise.resolve();
		listeners.get('ipc-message')?.({
			channel: 'maestro:panel-request',
			args: [
				{
					instanceId: 'panel-instance',
					requestId: 1,
					kind: 'ping',
					payload: { state: 'ready' },
				},
			],
		} as unknown as Event);
		await Promise.resolve();

		expect(bridge.panelRequest).toHaveBeenCalledWith({
			guestWebContentsId: 42,
			instanceId: 'panel-instance',
			requestId: 1,
			kind: 'ping',
			payload: { state: 'ready' },
		});
	});

	it('reports a rejected snapshot to the current binding without an unhandled rejection', async () => {
		const bridge = api();
		bridge.getSnapshot = vi.fn(async () => {
			throw new Error('projection transport unavailable');
		});
		const binder = createInteractivePanelHostBinder(bridge);
		const listeners = new Map<string, () => void>();
		const onFailure = vi.fn();
		const webview = {
			addEventListener: vi.fn((event: string, listener: () => void) =>
				listeners.set(event, listener)
			),
			removeEventListener: vi.fn(),
			getWebContentsId: () => 42,
		};

		binder.bind({
			panel: {
				ownerPluginId: 'com.maestro.omp',
				localId: 'main-panel',
				canonicalContributionId: 'com.maestro.omp/main-panel',
				title: 'OMP',
				entry: 'panel.html',
			} as unknown as CanonicalInteractivePanelContribution,
			webview: webview as never,
			onFailure,
		});
		listeners.get('dom-ready')?.();
		await Promise.resolve();
		await Promise.resolve();

		expect(onFailure).toHaveBeenCalledWith(expect.any(Error));
		expect(bridge.mountPanel).not.toHaveBeenCalled();
	});

	it('reports a rejected panel mount to the current binding', async () => {
		const bridge = api();
		bridge.mountPanel = vi.fn(async () => {
			throw new Error('mount transport unavailable');
		});
		const binder = createInteractivePanelHostBinder(bridge);
		const listeners = new Map<string, () => void>();
		const onFailure = vi.fn();
		const webview = {
			addEventListener: vi.fn((event: string, listener: () => void) =>
				listeners.set(event, listener)
			),
			removeEventListener: vi.fn(),
			getWebContentsId: () => 42,
		};

		binder.bind({
			panel: {
				ownerPluginId: 'com.maestro.omp',
				localId: 'main-panel',
				canonicalContributionId: 'com.maestro.omp/main-panel',
				title: 'OMP',
				entry: 'panel.html',
			} as unknown as CanonicalInteractivePanelContribution,
			webview: webview as never,
			onFailure,
		});
		listeners.get('dom-ready')?.();
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		expect(onFailure).toHaveBeenCalledWith(expect.any(Error));
	});

	it('revokes a stale binding when a fresh retry mounts first', async () => {
		const bridge = api();
		let resolveFirstMount: ((value: { instanceId: string }) => void) | undefined;
		const firstMount = new Promise<{ instanceId: string }>((resolve) => {
			resolveFirstMount = resolve;
		});
		bridge.mountPanel = vi
			.fn<PluginWorkspacesApi['mountPanel']>()
			.mockReturnValueOnce(firstMount)
			.mockResolvedValueOnce({ instanceId: 'fresh-panel-instance' });
		const binder = createInteractivePanelHostBinder(bridge);
		const firstListeners = new Map<string, () => void>();
		const secondListeners = new Map<string, () => void>();
		const panel = {
			ownerPluginId: 'com.maestro.omp',
			localId: 'main-panel',
			canonicalContributionId: 'com.maestro.omp/main-panel',
			title: 'OMP',
			entry: 'panel.html',
		} as unknown as CanonicalInteractivePanelContribution;
		const firstUnbind = binder.bind({
			panel,
			webview: {
				addEventListener: vi.fn((event: string, listener: () => void) =>
					firstListeners.set(event, listener)
				),
				removeEventListener: vi.fn(),
				getWebContentsId: () => 41,
			} as never,
		});
		firstListeners.get('dom-ready')?.();
		await Promise.resolve();
		await Promise.resolve();
		firstUnbind();

		const secondUnbind = binder.bind({
			panel,
			webview: {
				addEventListener: vi.fn((event: string, listener: () => void) =>
					secondListeners.set(event, listener)
				),
				removeEventListener: vi.fn(),
				getWebContentsId: () => 42,
			} as never,
		});
		secondListeners.get('dom-ready')?.();
		await Promise.resolve();
		await Promise.resolve();
		resolveFirstMount?.({ instanceId: 'stale-panel-instance' });
		await Promise.resolve();
		await Promise.resolve();

		expect(bridge.unmountPanel).toHaveBeenCalledWith({ instanceId: 'stale-panel-instance' });
		secondUnbind();
		expect(bridge.unmountPanel).toHaveBeenCalledWith({ instanceId: 'fresh-panel-instance' });
	});
});
