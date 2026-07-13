import type {
	PluginWorkspaceMountPanelInput,
	PluginWorkspaceMountPanelResult,
	PluginWorkspaceRevealOrSelectInput,
	PluginWorkspaceRevealOrSelectResult,
	PluginWorkspacesSnapshotDto,
} from '../../shared/plugins/plugin-workspace-bridge';
import type { SnapshotToken } from '../../shared/plugins/workspace-foundation';
import {
	type InteractivePanelDescriptor,
	type InteractivePanelGuestSender,
	type InteractivePanelMountHandle,
	type PluginPanelResourceStageInput,
	type PluginPanelResourceRef,
	PluginInteractivePanelHost,
} from './plugin-interactive-panel-host';
import {
	type PluginWorkspaceRegistry,
	type WorkspaceProjection,
	type WorkspaceProjectionChange,
} from './plugin-workspace-registry';

const SNAPSHOT_CHANGED_CHANNEL = 'plugin-workspaces:changed';

interface TrustedWebContents {
	send(channel: string, payload: unknown): void;
}

interface TrustedMainWindow {
	readonly webContents: TrustedWebContents;
	isDestroyed(): boolean;
	on(event: 'closed', listener: () => void): void;
	removeListener(event: 'closed', listener: () => void): void;
}

interface GuestWebContents extends InteractivePanelGuestSender {
	isDestroyed(): boolean;
	getType?(): string;
	readonly hostWebContents?: TrustedWebContents | null;
	once?(event: 'destroyed', listener: () => void): void;
}

interface PluginWorkspaceIpcMain {
	handle(
		channel: string,
		handler: (event: { readonly sender: unknown }, input?: unknown) => Promise<unknown>
	): void;
	removeHandler(channel: string): void;
}

interface ActivePanelMount {
	readonly ownerPluginId: string;
	readonly workspaceLocalId: string;
	readonly generation: bigint;
	readonly handle: InteractivePanelMountHandle;
}

/** Dependencies supplied by the production bootstrap after trusted services exist. */
export interface PluginWorkspaceIpcRegistrationOptions {
	readonly ipcMain: PluginWorkspaceIpcMain;
	readonly getMainWindow: () => TrustedMainWindow | null;
	readonly registry: PluginWorkspaceRegistry;
	readonly panelHost: PluginInteractivePanelHost;
	readonly getGuestWebContents: (id: number) => GuestWebContents | null;
	/** Resolves an owner-bound descriptor from trusted main-process runtime state only. */
	readonly getPanelDescriptor: (
		projection: WorkspaceProjection
	) => InteractivePanelDescriptor | null;
}

/** Dispose registration and all guest panel bindings before the next bootstrap. */
export interface PluginWorkspaceIpcRegistration {
	dispose(): void;
}

/**
 * Registers the generic plugin-workspace IPC boundary. Every operation requires
 * the current main renderer; guest panels receive only the closed panel protocol.
 */
export function registerPluginWorkspaceIpc(
	options: PluginWorkspaceIpcRegistrationOptions
): PluginWorkspaceIpcRegistration {
	const panelMounts = new Map<string, ActivePanelMount>();
	let disposed = false;

	const requireTrustedRenderer = (event: { readonly sender: unknown }): TrustedMainWindow => {
		const mainWindow = options.getMainWindow();
		if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
			throw new Error('UntrustedPluginWorkspaceRequester');
		}
		return mainWindow;
	};

	const getSnapshot = (): PluginWorkspacesSnapshotDto =>
		createSnapshot(options.registry.listProjections());

	const relayPanelMessage = (
		event: { readonly sender: unknown },
		input: unknown,
		channel:
			| 'maestro:panel-request'
			| 'maestro:panel-subscribe'
			| 'maestro:panel-unsubscribe'
			| 'maestro:panel-unsubscribe-all'
	): void => {
		const mainWindow = requireTrustedRenderer(event);
		const relay = parsePanelRelay(input, channel);
		if (!relay) throw new Error('InvalidPluginWorkspacePanelIngress');
		const guest = options.getGuestWebContents(relay.guestWebContentsId);
		if (!isTrustedGuest(guest, mainWindow.webContents))
			throw new Error('InvalidPluginWorkspaceGuest');
		options.panelHost.receive(guest, channel, relay.payload);
	};

	const stagePanelResource = (
		event: { readonly sender: unknown },
		input: unknown
	): PluginPanelResourceRef => {
		const mainWindow = requireTrustedRenderer(event);
		const relay = parsePanelResourceRelay(input);
		if (!relay) throw new Error('InvalidPluginWorkspacePanelResourceIngress');
		const guest = options.getGuestWebContents(relay.guestWebContentsId);
		if (!isTrustedGuest(guest, mainWindow.webContents))
			throw new Error('InvalidPluginWorkspaceGuest');
		return options.panelHost.stageResource(guest, relay.payload);
	};

	const unmount = (instanceId: string): void => {
		const mount = panelMounts.get(instanceId);
		if (!mount) return;
		panelMounts.delete(instanceId);
		mount.handle.dispose();
	};

	const unmountWorkspace = (ownerPluginId: string, workspaceLocalId: string): void => {
		for (const [instanceId, mount] of panelMounts) {
			if (mount.ownerPluginId === ownerPluginId && mount.workspaceLocalId === workspaceLocalId) {
				unmount(instanceId);
			}
		}
	};

	const broadcastSnapshot = (change: WorkspaceProjectionChange): void => {
		if (change.projection === null) {
			unmountWorkspace(change.ownerPluginId, change.workspaceLocalId);
		} else {
			for (const [instanceId, mount] of panelMounts) {
				if (
					mount.ownerPluginId === change.ownerPluginId &&
					mount.workspaceLocalId === change.workspaceLocalId &&
					mount.generation !== change.projection.generation
				) {
					unmount(instanceId);
				}
			}
		}
		const mainWindow = options.getMainWindow();
		if (!mainWindow || mainWindow.isDestroyed()) return;
		mainWindow.webContents.send(SNAPSHOT_CHANGED_CHANNEL, getSnapshot());
	};

	const stopProjectionSubscription = options.registry.onDidChangeProjection(broadcastSnapshot);

	const onWindowClosed = (): void => dispose();
	const currentMainWindow = options.getMainWindow();
	currentMainWindow?.on('closed', onWindowClosed);

	options.ipcMain.handle('plugin-workspaces:get-snapshot', async (event) => {
		requireTrustedRenderer(event);
		return getSnapshot();
	});

	options.ipcMain.handle('plugin-workspaces:reveal-or-select', async (event, input) => {
		requireTrustedRenderer(event);
		if (!isRevealOrSelectInput(input)) return null;
		const resolution = options.registry.selectBySnapshotToken(input.snapshotToken as SnapshotToken);
		if (resolution.kind !== 'resolved') return null;
		return Object.freeze({
			ownerPluginId: resolution.ownerPluginId,
			workspaceLocalId: resolution.workspaceLocalId,
			snapshotToken: resolution.externalSession.snapshotToken,
		} satisfies PluginWorkspaceRevealOrSelectResult);
	});

	options.ipcMain.handle('plugin-workspaces:mount-panel', async (event, input) => {
		const mainWindow = requireTrustedRenderer(event);
		const mountInput = parseMountPanelInput(input);
		if (!mountInput) throw new Error('InvalidPluginWorkspaceMount');
		const projection = options.registry
			.listProjections()
			.find(
				(candidate) =>
					candidate.ownerPluginId === mountInput.ownerPluginId &&
					candidate.workspaceLocalId === mountInput.workspaceLocalId
			);
		if (!projection) throw new Error('UnknownPluginWorkspace');
		if (projection.generation.toString(10) !== mountInput.generation) {
			throw new Error('StalePluginWorkspaceGeneration');
		}
		const guest = options.getGuestWebContents(mountInput.guestWebContentsId);
		if (!isTrustedGuest(guest, mainWindow.webContents))
			throw new Error('InvalidPluginWorkspaceGuest');
		const descriptor = options.getPanelDescriptor(projection);
		if (!descriptor) throw new Error('UnavailablePluginWorkspacePanel');

		const handle = options.panelHost.mount({
			ownerPluginId: projection.ownerPluginId,
			workspaceLocalId: projection.workspaceLocalId,
			panelLocalId: projection.panel.localId,
			generation: projection.generation,
			descriptor,
			sender: { send: (channel, payload): void => guest.send(channel, payload) },
		});
		panelMounts.set(handle.instanceId, {
			ownerPluginId: projection.ownerPluginId,
			workspaceLocalId: projection.workspaceLocalId,
			generation: projection.generation,
			handle,
		});
		guest.once?.('destroyed', () => unmount(handle.instanceId));
		return Object.freeze({
			instanceId: handle.instanceId,
		} satisfies PluginWorkspaceMountPanelResult);
	});

	options.ipcMain.handle('plugin-workspaces:unmount-panel', async (event, input) => {
		requireTrustedRenderer(event);
		if (!isRecord(input) || typeof input.instanceId !== 'string') return;
		unmount(input.instanceId);
	});

	options.ipcMain.handle('plugin-workspaces:panel-request', async (event, input) => {
		relayPanelMessage(event, input, 'maestro:panel-request');
	});

	options.ipcMain.handle('plugin-workspaces:panel-stage-resource', async (event, input) => {
		return stagePanelResource(event, input);
	});

	options.ipcMain.handle('plugin-workspaces:panel-subscribe', async (event, input) => {
		relayPanelMessage(event, input, 'maestro:panel-subscribe');
	});

	options.ipcMain.handle('plugin-workspaces:panel-unsubscribe', async (event, input) => {
		relayPanelMessage(event, input, 'maestro:panel-unsubscribe');
	});

	options.ipcMain.handle('plugin-workspaces:panel-unsubscribe-all', async (event, input) => {
		relayPanelMessage(event, input, 'maestro:panel-unsubscribe-all');
	});

	const dispose = (): void => {
		if (disposed) return;
		disposed = true;
		stopProjectionSubscription();
		currentMainWindow?.removeListener('closed', onWindowClosed);
		for (const instanceId of [...panelMounts.keys()]) unmount(instanceId);
		for (const channel of [
			'plugin-workspaces:get-snapshot',
			'plugin-workspaces:reveal-or-select',
			'plugin-workspaces:mount-panel',
			'plugin-workspaces:unmount-panel',
			'plugin-workspaces:panel-request',
			'plugin-workspaces:panel-stage-resource',
			'plugin-workspaces:panel-subscribe',
			'plugin-workspaces:panel-unsubscribe',
			'plugin-workspaces:panel-unsubscribe-all',
		]) {
			options.ipcMain.removeHandler(channel);
		}
	};

	return Object.freeze({ dispose });
}

function createSnapshot(projections: readonly WorkspaceProjection[]): PluginWorkspacesSnapshotDto {
	const workspaces = projections.map((projection) =>
		Object.freeze({
			ownerPluginId: projection.ownerPluginId,
			workspaceLocalId: projection.workspaceLocalId,
			panelLocalId: projection.panel.localId,
			generation: projection.generation.toString(10),
			projectionRevision: projection.projectionRevision,
			status: Object.freeze({ state: projection.status.state, label: projection.status.label }),
			badge: projection.badge,
			sessions: Object.freeze(
				projection.externalSessions.map((session) =>
					Object.freeze({
						externalSessionId: session.externalSessionId,
						title: session.title,
						status: session.status,
						unread: session.unread,
						pendingApproval: session.pendingApproval,
						updatedAt: session.updatedAt,
						snapshotToken: session.snapshotToken,
					})
				)
			),
		})
	);
	const selected = projections.find(
		(projection) => projection.selectedContext !== null
	)?.selectedContext;
	return Object.freeze({
		connection: 'ready',
		workspaces: Object.freeze(workspaces),
		selection: selected
			? Object.freeze({
					ownerPluginId: selected.ownerPluginId,
					workspaceLocalId: selected.workspaceLocalId,
					snapshotToken: selected.snapshotToken,
				})
			: null,
	});
}

function parseMountPanelInput(input: unknown): PluginWorkspaceMountPanelInput | null {
	if (
		!isRecord(input) ||
		typeof input.ownerPluginId !== 'string' ||
		typeof input.workspaceLocalId !== 'string' ||
		typeof input.generation !== 'string' ||
		!Number.isSafeInteger(input.guestWebContentsId) ||
		(input.guestWebContentsId as number) < 1
	) {
		return null;
	}
	return input as unknown as PluginWorkspaceMountPanelInput;
}

function isRevealOrSelectInput(input: unknown): input is PluginWorkspaceRevealOrSelectInput {
	return isRecord(input) && typeof input.snapshotToken === 'string';
}

function isTrustedGuest(
	guest: GuestWebContents | null,
	mainContents: TrustedWebContents
): guest is GuestWebContents {
	return (
		guest !== null &&
		!guest.isDestroyed() &&
		guest.getType?.() === 'webview' &&
		guest.hostWebContents === mainContents
	);
}

interface PanelRelay {
	readonly guestWebContentsId: number;
	readonly payload: Readonly<Record<string, unknown>>;
}

function parsePanelRelay(
	input: unknown,
	channel:
		| 'maestro:panel-request'
		| 'maestro:panel-subscribe'
		| 'maestro:panel-unsubscribe'
		| 'maestro:panel-unsubscribe-all'
): PanelRelay | null {
	if (!isRecord(input)) return null;
	const guestWebContentsId = ownValue(input, 'guestWebContentsId');
	const instanceId = ownValue(input, 'instanceId');
	if (
		!Number.isSafeInteger(guestWebContentsId) ||
		(guestWebContentsId as number) < 1 ||
		typeof instanceId !== 'string' ||
		instanceId.length < 16 ||
		instanceId.length > 128
	)
		return null;
	if (channel === 'maestro:panel-unsubscribe-all') {
		return Object.freeze({
			guestWebContentsId: guestWebContentsId as number,
			payload: Object.freeze({ instanceId }),
		});
	}
	const kind = ownValue(input, 'kind');
	if (typeof kind !== 'string' || kind.length === 0 || kind.length > 256) return null;
	if (channel === 'maestro:panel-request') {
		const requestId = ownValue(input, 'requestId');
		if (!Number.isSafeInteger(requestId) || (requestId as number) < 1) return null;
		return Object.freeze({
			guestWebContentsId: guestWebContentsId as number,
			payload: Object.freeze({
				instanceId,
				requestId,
				kind,
				payload: ownValue(input, 'payload'),
			}),
		});
	}

	return Object.freeze({
		guestWebContentsId: guestWebContentsId as number,
		payload: Object.freeze({ instanceId, kind }),
	});
}

interface PanelResourceRelay {
	readonly guestWebContentsId: number;
	readonly payload: PluginPanelResourceStageInput;
}

function parsePanelResourceRelay(input: unknown): PanelResourceRelay | null {
	if (!isRecord(input)) return null;
	const guestWebContentsId = ownValue(input, 'guestWebContentsId');
	const instanceId = ownValue(input, 'instanceId');
	const name = ownValue(input, 'name');
	const mediaType = ownValue(input, 'mediaType');
	const bytes = ownValue(input, 'bytes');
	if (
		!Number.isSafeInteger(guestWebContentsId) ||
		(guestWebContentsId as number) < 1 ||
		typeof instanceId !== 'string' ||
		instanceId.length < 16 ||
		instanceId.length > 128 ||
		typeof name !== 'string' ||
		typeof mediaType !== 'string' ||
		!(bytes instanceof Uint8Array)
	)
		return null;
	return Object.freeze({
		guestWebContentsId: guestWebContentsId as number,
		payload: Object.freeze({ instanceId, name, mediaType, bytes }),
	});
}

function ownValue(record: Record<string, unknown>, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(record, key);
	return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
