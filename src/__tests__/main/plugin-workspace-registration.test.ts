import { describe, expect, it, vi } from 'vitest';
import { PluginInteractivePanelHost } from '../../main/plugins/plugin-interactive-panel-host';
import { registerPluginWorkspaceIpc } from '../../main/plugins/plugin-workspace-registration';

const OWNER = 'com.maestro.omp';
const WORKSPACE = 'omp';
const TOKEN = 'opaque-token-000000000000';

interface IpcHandlers {
	readonly get: (
		channel: string
	) => (event: { sender: unknown }, input?: unknown) => Promise<unknown>;
}

function projection(revision = 4): Record<string, unknown> {
	return {
		ownerPluginId: OWNER,
		workspaceLocalId: WORKSPACE,
		generation: 2n,
		projectionRevision: revision,
		workspace: { localId: WORKSPACE },
		panel: { localId: 'main-panel' },
		status: { state: 'degraded', label: 'Syncing OMP' },
		badge: 7,
		externalSessions: [
			{
				externalSessionId: 'session-1',
				title: 'OMP session',
				status: 'waiting_for_approval',
				unread: 3,
				pendingApproval: true,
				updatedAt: 42,
				snapshotToken: TOKEN,
			},
		],
		selectedSnapshotToken: null,
		selectedContext: null,
	};
}

function harness() {
	const handlers = new Map<
		string,
		(event: { sender: unknown }, input?: unknown) => Promise<unknown>
	>();
	const ipcMain = {
		handle: vi.fn(
			(
				channel: string,
				handler: (event: { sender: unknown }, input?: unknown) => Promise<unknown>
			) => {
				handlers.set(channel, handler);
			}
		),
		removeHandler: vi.fn(),
	};
	const sent: unknown[] = [];
	const mainContents = {
		send: vi.fn((channel: string, payload: unknown) => sent.push({ channel, payload })),
	};
	const windowListeners = new Map<string, () => void>();
	const mainWindow = {
		webContents: mainContents,
		isDestroyed: () => false,
		on: vi.fn((event: string, listener: () => void) => windowListeners.set(event, listener)),
		removeListener: vi.fn(),
	};
	const unsubscribe = vi.fn();
	let projectionListener: ((change: Record<string, unknown>) => void) | null = null;
	const registry = {
		listProjections: vi.fn(() => [projection()]),
		onDidChangeProjection: vi.fn((listener: (change: Record<string, unknown>) => void) => {
			projectionListener = listener;
			return unsubscribe;
		}),
		selectBySnapshotToken: vi.fn(() => ({
			kind: 'resolved',
			ownerPluginId: OWNER,
			workspaceLocalId: WORKSPACE,
			externalSession: { snapshotToken: TOKEN },
		})),
	};
	const guest = {
		isDestroyed: () => false,
		getType: () => 'webview',
		hostWebContents: mainContents,
		send: vi.fn(),
	};
	const otherGuest = { ...guest, send: vi.fn() };
	const panelDispose = vi.fn();
	const panelActivate = vi.fn(() => true);
	const panelHost = {
		mount: vi.fn(() => ({
			instanceId: 'panel-instance-0001',
			activate: panelActivate,
			dispose: panelDispose,
		})),
		receive: vi.fn(),
		stageResource: vi.fn(() => ({
			ref: 'opaque-resource-ref',
			name: 'image.png',
			mediaType: 'image/png',
			size: 3,
			sha256: 'a'.repeat(64),
		})),
		unmount: vi.fn(),
	};
	const registration = registerPluginWorkspaceIpc({
		ipcMain,
		getMainWindow: () => mainWindow,
		registry: registry as never,
		panelHost: panelHost as unknown as PluginInteractivePanelHost,
		getGuestWebContents: (id) => (id === 42 ? guest : id === 43 ? otherGuest : null),
		getPanelDescriptor: () => ({
			requestSchemas: {},
			eventSchemas: {},
			resultSchemas: {},
			errorSchemas: {},
		}),
	});
	return {
		handlers: handlers as unknown as IpcHandlers,
		mainContents,
		registry,
		guest,
		panelHost,
		panelDispose,
		panelActivate,
		registration,
		sent,
		unsubscribe,
		windowListeners,
		getProjectionListener: () => projectionListener,
	};
}

describe('plugin workspace main registration', () => {
	it('rejects a non-main-window renderer and projects exact registry status and badge', async () => {
		const h = harness();
		const getSnapshot = h.handlers.get('plugin-workspaces:get-snapshot');

		await expect(getSnapshot({ sender: {} })).rejects.toThrow('UntrustedPluginWorkspaceRequester');
		await expect(getSnapshot({ sender: h.mainContents })).resolves.toMatchObject({
			workspaces: [
				{
					projectionRevision: 4,
					status: { state: 'degraded', label: 'Syncing OMP' },
					badge: 7,
				},
			],
		});
	});

	it('selects only a current opaque token and rejects stale generation or a non-guest panel target', async () => {
		const h = harness();
		const reveal = h.handlers.get('plugin-workspaces:reveal-or-select');
		const mount = h.handlers.get('plugin-workspaces:mount-panel');

		await expect(reveal({ sender: h.mainContents }, { snapshotToken: TOKEN })).resolves.toEqual({
			ownerPluginId: OWNER,
			workspaceLocalId: WORKSPACE,
			snapshotToken: TOKEN,
		});
		expect(h.registry.selectBySnapshotToken).toHaveBeenCalledWith(TOKEN);
		await expect(
			mount(
				{ sender: h.mainContents },
				{
					ownerPluginId: OWNER,
					workspaceLocalId: WORKSPACE,
					generation: '1',
					guestWebContentsId: 42,
				}
			)
		).rejects.toThrow('StalePluginWorkspaceGeneration');
		await expect(
			mount(
				{ sender: h.mainContents },
				{
					ownerPluginId: OWNER,
					workspaceLocalId: WORKSPACE,
					generation: '2',
					guestWebContentsId: 9,
				}
			)
		).rejects.toThrow('InvalidPluginWorkspaceGuest');
	});

	it('activates only the currently mounted trusted guest with its exact generation', async () => {
		const h = harness();
		const mount = h.handlers.get('plugin-workspaces:mount-panel');
		const activate = h.handlers.get('plugin-workspaces:activate-panel');
		await mount(
			{ sender: h.mainContents },
			{ ownerPluginId: OWNER, workspaceLocalId: WORKSPACE, generation: '2', guestWebContentsId: 42 }
		);

		await expect(
			activate(
				{ sender: {} },
				{ guestWebContentsId: 42, instanceId: 'panel-instance-0001', generation: '2' }
			)
		).rejects.toThrow('UntrustedPluginWorkspaceRequester');
		await expect(
			activate(
				{ sender: h.mainContents },
				{ guestWebContentsId: 9, instanceId: 'panel-instance-0001', generation: '2' }
			)
		).rejects.toThrow('InvalidPluginWorkspaceGuest');
		await expect(
			activate(
				{ sender: h.mainContents },
				{ guestWebContentsId: 43, instanceId: 'panel-instance-0001', generation: '2' }
			)
		).rejects.toThrow('UnavailablePluginWorkspacePanelActivation');
		await expect(
			activate(
				{ sender: h.mainContents },
				{ guestWebContentsId: 42, instanceId: 'other-panel-instance-0001', generation: '2' }
			)
		).rejects.toThrow('UnavailablePluginWorkspacePanelActivation');
		await expect(
			activate(
				{ sender: h.mainContents },
				{ guestWebContentsId: 42, instanceId: 'panel-instance-0001', generation: '1' }
			)
		).rejects.toThrow('StalePluginWorkspaceGeneration');

		await expect(
			activate(
				{ sender: h.mainContents },
				{ guestWebContentsId: 42, instanceId: 'panel-instance-0001', generation: '2' }
			)
		).resolves.toBeUndefined();
		expect(h.panelActivate).toHaveBeenCalledOnce();
	});

	it('refuses activation after its projection is revoked', async () => {
		const h = harness();
		const mount = h.handlers.get('plugin-workspaces:mount-panel');
		const activate = h.handlers.get('plugin-workspaces:activate-panel');
		await mount(
			{ sender: h.mainContents },
			{ ownerPluginId: OWNER, workspaceLocalId: WORKSPACE, generation: '2', guestWebContentsId: 42 }
		);
		h.getProjectionListener()?.({
			ownerPluginId: OWNER,
			workspaceLocalId: WORKSPACE,
			projectionRevision: 5,
			projection: null,
		});

		await expect(
			activate(
				{ sender: h.mainContents },
				{ guestWebContentsId: 42, instanceId: 'panel-instance-0001', generation: '2' }
			)
		).rejects.toThrow('UnavailablePluginWorkspacePanelActivation');
		expect(h.panelActivate).not.toHaveBeenCalled();
	});

	it('cleans registry and panel subscriptions on window destruction', () => {
		const h = harness();
		const mount = h.handlers.get('plugin-workspaces:mount-panel');
		void mount(
			{ sender: h.mainContents },
			{ ownerPluginId: OWNER, workspaceLocalId: WORKSPACE, generation: '2', guestWebContentsId: 42 }
		);

		h.windowListeners.get('closed')?.();
		expect(h.unsubscribe).toHaveBeenCalledOnce();
		expect(h.panelDispose).toHaveBeenCalledOnce();
	});

	it('unmounts a guest on registry revocation and broadcasts the fresh revision snapshot', async () => {
		const h = harness();
		const mount = h.handlers.get('plugin-workspaces:mount-panel');
		await mount(
			{ sender: h.mainContents },
			{ ownerPluginId: OWNER, workspaceLocalId: WORKSPACE, generation: '2', guestWebContentsId: 42 }
		);
		h.registry.listProjections.mockReturnValue([projection(9)]);

		h.getProjectionListener()?.({
			ownerPluginId: OWNER,
			workspaceLocalId: WORKSPACE,
			projectionRevision: 10,
			projection: null,
		});

		expect(h.panelDispose).toHaveBeenCalledOnce();
		expect(h.sent).toContainEqual({
			channel: 'plugin-workspaces:changed',
			payload: expect.objectContaining({
				workspaces: [expect.objectContaining({ projectionRevision: 9 })],
			}),
		});
	});

	it('forwards only named panel ingress from the trusted renderer with the exact guest sender', async () => {
		const h = harness();
		await h.handlers.get('plugin-workspaces:mount-panel')(
			{ sender: h.mainContents },
			{ ownerPluginId: OWNER, workspaceLocalId: WORKSPACE, generation: '2', guestWebContentsId: 42 }
		);
		const request = h.handlers.get('plugin-workspaces:panel-request');
		const subscribe = h.handlers.get('plugin-workspaces:panel-subscribe');
		const panelRequest = {
			guestWebContentsId: 42,
			instanceId: 'panel-instance-0001',
			requestId: 1,
			kind: 'ping',
			payload: { state: 'ready' },
		};

		await request({ sender: h.mainContents }, panelRequest);
		await subscribe(
			{ sender: h.mainContents },
			{
				guestWebContentsId: 42,
				instanceId: 'panel-instance-0001',
				kind: 'status',
			}
		);

		expect(h.panelHost.receive).toHaveBeenNthCalledWith(
			1,
			h.guest,
			'maestro:panel-request',
			expect.objectContaining({ instanceId: 'panel-instance-0001', requestId: 1, kind: 'ping' })
		);
		expect(h.panelHost.receive).toHaveBeenNthCalledWith(
			2,
			h.guest,
			'maestro:panel-subscribe',
			expect.objectContaining({ instanceId: 'panel-instance-0001', kind: 'status' })
		);
		await expect(request({ sender: {} }, panelRequest)).rejects.toThrow(
			'UntrustedPluginWorkspaceRequester'
		);
	});

	it('forwards staged binary bytes only from the mounted trusted guest', async () => {
		const h = harness();
		await h.handlers.get('plugin-workspaces:mount-panel')(
			{ sender: h.mainContents },
			{ ownerPluginId: OWNER, workspaceLocalId: WORKSPACE, generation: '2', guestWebContentsId: 42 }
		);
		const stage = h.handlers.get('plugin-workspaces:panel-stage-resource');
		const input = {
			guestWebContentsId: 42,
			instanceId: 'panel-instance-0001',
			name: 'image.png',
			mediaType: 'image/png',
			bytes: new Uint8Array([1, 2, 3]),
		};
		await expect(stage({ sender: h.mainContents }, input)).resolves.toEqual({
			ref: 'opaque-resource-ref',
			name: 'image.png',
			mediaType: 'image/png',
			size: 3,
			sha256: 'a'.repeat(64),
		});
		expect(h.panelHost.stageResource).toHaveBeenCalledWith(
			h.guest,
			expect.objectContaining({
				instanceId: 'panel-instance-0001',
				bytes: new Uint8Array([1, 2, 3]),
			})
		);
		await expect(stage({ sender: {} }, input)).rejects.toThrow('UntrustedPluginWorkspaceRequester');
	});
});
