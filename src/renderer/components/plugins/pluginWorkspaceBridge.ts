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
		}: {
			panel: CanonicalInteractivePanelContribution;
			webview: InteractivePanelWebviewElement;
		}): (() => void) => bindPanel(api, panel, webview),
	};
	return Object.freeze(binder);
}

function bindPanel(
	api: PluginWorkspacesApi,
	panel: CanonicalInteractivePanelContribution,
	webview: InteractivePanelWebviewElement
): () => void {
	let active = true;
	let instanceId: string | null = null;
	const webviewWithContents = webview as InteractivePanelWebviewElement & {
		getWebContentsId?: () => number;
	};
	const mount = async (): Promise<void> => {
		const guestWebContentsId = webviewWithContents.getWebContentsId?.();
		if (!active || !Number.isSafeInteger(guestWebContentsId) || (guestWebContentsId ?? 0) < 1)
			return;
		const snapshot = await api.getSnapshot();
		if (!active) return;
		const workspace = snapshot.workspaces.find(
			(candidate) =>
				candidate.ownerPluginId === panel.ownerPluginId && candidate.panelLocalId === panel.localId
		);
		if (!workspace) return;
		const mounted = await api.mountPanel({
			ownerPluginId: workspace.ownerPluginId,
			workspaceLocalId: workspace.workspaceLocalId,
			generation: workspace.generation,
			guestWebContentsId: guestWebContentsId!,
		});
		if (!active) {
			await api.unmountPanel({ instanceId: mounted.instanceId });
			return;
		}
		instanceId = mounted.instanceId;
	};
	const onDomReady = (): void => {
		void mount();
	};
	webview.addEventListener('dom-ready', onDomReady);
	return (): void => {
		active = false;
		webview.removeEventListener('dom-ready', onDomReady);
		if (instanceId) void api.unmountPanel({ instanceId });
	};
}
