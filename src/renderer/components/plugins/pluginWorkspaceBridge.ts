import type { CanonicalInteractivePanelContribution } from '../../../shared/plugins/contributions';
import type {
	PluginWorkspacesApi,
	PluginWorkspacesSnapshotDto,
} from '../../../shared/plugins/plugin-workspace-bridge';
import type {
	InteractivePanelHostBinder,
	InteractivePanelWebviewElement,
} from './PluginInteractivePanelFrame';
import type { PluginWorkspaceProjectionSource } from './pluginWorkspaceProjection';

interface PanelIpcMessageEvent extends Event {
	readonly channel?: string;
	readonly args?: unknown[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Adapts the frozen trusted preload API to the renderer workspace projection contract. */
export function createPluginWorkspaceProjectionSource(
	api: PluginWorkspacesApi
): PluginWorkspaceProjectionSource {
	const source: PluginWorkspaceProjectionSource = {
		getSnapshot: (): Promise<PluginWorkspacesSnapshotDto> => api.getSnapshot(),
		subscribe: (listener: (snapshot: PluginWorkspacesSnapshotDto) => void): (() => void) =>
			api.subscribe(listener),
		reveal: async ({ snapshotToken }: { snapshotToken: string }): Promise<void> => {
			await api.revealOrSelect({ snapshotToken });
		},
	};
	return Object.freeze(source);
}

/** Binds a host-owned webview to a panel only after its generic workspace projection is current. */
export function createInteractivePanelHostBinder(
	api: PluginWorkspacesApi
): InteractivePanelHostBinder {
	const binder: InteractivePanelHostBinder = {
		bind: ({
			panel,
			webview,
			onFailure,
		}: {
			panel: CanonicalInteractivePanelContribution;
			webview: InteractivePanelWebviewElement;
			onFailure?: (error: unknown) => void;
		}): (() => void) => bindPanel(api, panel, webview, onFailure),
	};
	return Object.freeze(binder);
}

function bindPanel(
	api: PluginWorkspacesApi,
	panel: CanonicalInteractivePanelContribution,
	webview: InteractivePanelWebviewElement,
	onFailure?: (error: unknown) => void
): () => void {
	let active = true;
	let instanceId: string | null = null;
	let mountInFlight = false;
	const webviewWithContents = webview as InteractivePanelWebviewElement & {
		getWebContentsId?: () => number;
	};
	const unmountSilently = (currentInstanceId: string): void => {
		void api.unmountPanel({ instanceId: currentInstanceId }).catch(() => undefined);
	};
	const reportFailure = (error: unknown): void => {
		if (active) onFailure?.(error);
	};
	const mount = async (reportUnavailable: boolean): Promise<void> => {
		if (!active || instanceId !== null || mountInFlight) return;
		const guestWebContentsId = webviewWithContents.getWebContentsId?.();
		if (
			typeof guestWebContentsId !== 'number' ||
			!Number.isSafeInteger(guestWebContentsId) ||
			guestWebContentsId < 1
		) {
			if (reportUnavailable) reportFailure(new Error('Panel guest is unavailable.'));
			return;
		}
		mountInFlight = true;
		let mountedInstanceId: string | null = null;
		try {
			const snapshot = await api.getSnapshot();
			if (!active) return;
			const workspace = snapshot.workspaces.find(
				(candidate) =>
					candidate.ownerPluginId === panel.ownerPluginId &&
					candidate.panelLocalId === panel.localId
			);
			if (!workspace) throw new Error('Panel workspace is unavailable.');
			const mounted = await api.mountPanel({
				ownerPluginId: workspace.ownerPluginId,
				workspaceLocalId: workspace.workspaceLocalId,
				generation: workspace.generation,
				guestWebContentsId,
			});
			mountedInstanceId = mounted.instanceId;
			if (!active) {
				unmountSilently(mounted.instanceId);
				return;
			}
			// Must happen before activation: INIT can synchronously flush guest IPC.
			instanceId = mounted.instanceId;
			await api.activatePanel({
				guestWebContentsId,
				instanceId: mounted.instanceId,
				generation: workspace.generation,
			});
			if (!active && instanceId === mounted.instanceId) {
				instanceId = null;
				unmountSilently(mounted.instanceId);
			}
		} catch (error) {
			if (mountedInstanceId !== null && instanceId === mountedInstanceId) {
				instanceId = null;
				unmountSilently(mountedInstanceId);
			}
			reportFailure(error);
		} finally {
			mountInFlight = false;
		}
	};
	const onIpcMessage = (event: Event): void => {
		if (!active || instanceId === null) return;
		const message = event as PanelIpcMessageEvent;
		const payload = message.args?.[0];
		if (!isRecord(payload) || payload.instanceId !== instanceId) return;
		const guestWebContentsId = webviewWithContents.getWebContentsId?.();
		if (
			typeof guestWebContentsId !== 'number' ||
			!Number.isSafeInteger(guestWebContentsId) ||
			guestWebContentsId < 1
		)
			return;
		if (
			message.channel === 'maestro:panel-stage-resource' &&
			Number.isSafeInteger(payload.stageId) &&
			typeof payload.name === 'string' &&
			typeof payload.mediaType === 'string' &&
			payload.bytes instanceof Uint8Array
		) {
			void api
				.panelStageResource({
					guestWebContentsId,
					instanceId,
					name: payload.name,
					mediaType: payload.mediaType,
					bytes: payload.bytes,
				})
				.then((resource) => {
					if (active && instanceId !== null) {
						webview.send('maestro:panel-resource-staged', {
							instanceId,
							stageId: payload.stageId,
							resource,
						});
					}
				})
				.catch(reportFailure);
			return;
		}
		if (
			message.channel === 'maestro:panel-request' &&
			Number.isSafeInteger(payload.requestId) &&
			typeof payload.kind === 'string'
		) {
			void api
				.panelRequest({
					guestWebContentsId,
					instanceId,
					requestId: payload.requestId as number,
					kind: payload.kind,
					payload: payload.payload,
				})
				.catch(reportFailure);
			return;
		}
		if (
			(message.channel === 'maestro:panel-subscribe' ||
				message.channel === 'maestro:panel-unsubscribe') &&
			typeof payload.kind === 'string'
		) {
			const input = { guestWebContentsId, instanceId, kind: payload.kind };
			void (
				message.channel === 'maestro:panel-subscribe'
					? api.panelSubscribe(input)
					: api.panelUnsubscribe(input)
			).catch(reportFailure);
			return;
		}
		if (message.channel === 'maestro:panel-unsubscribe-all') {
			void api.panelUnsubscribeAll({ guestWebContentsId, instanceId }).catch(reportFailure);
		}
	};
	const onDomReady = (): void => {
		void mount(true);
	};
	webview.addEventListener('ipc-message', onIpcMessage);
	webview.addEventListener('dom-ready', onDomReady);
	void mount(false);
	return (): void => {
		active = false;
		webview.removeEventListener('dom-ready', onDomReady);
		webview.removeEventListener('ipc-message', onIpcMessage);
		const mountedInstanceId = instanceId;
		instanceId = null;
		if (mountedInstanceId) unmountSilently(mountedInstanceId);
	};
}
