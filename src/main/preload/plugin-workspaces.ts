import { ipcRenderer } from 'electron';
import type {
	PluginWorkspaceMountPanelInput,
	PluginWorkspaceMountPanelResult,
	PluginWorkspaceRevealOrSelectInput,
	PluginWorkspaceRevealOrSelectResult,
	PluginWorkspacesApi,
	PluginWorkspacesSnapshotDto,
	PluginWorkspaceUnmountPanelInput,
} from '../../shared/plugins/plugin-workspace-bridge';

const SNAPSHOT_CHANGED_CHANNEL = 'plugin-workspaces:changed';

/** Creates the frozen, generic workspace-only main renderer bridge. */
export function createPluginWorkspacesApi(): PluginWorkspacesApi {
	const api: PluginWorkspacesApi = {
		getSnapshot: (): Promise<PluginWorkspacesSnapshotDto> =>
			ipcRenderer.invoke('plugin-workspaces:get-snapshot'),
		subscribe: (listener: (snapshot: PluginWorkspacesSnapshotDto) => void): (() => void) => {
			const wrapped = (
				_event: Electron.IpcRendererEvent,
				snapshot: PluginWorkspacesSnapshotDto
			): void => {
				listener(snapshot);
			};
			ipcRenderer.on(SNAPSHOT_CHANGED_CHANNEL, wrapped);
			return (): void => {
				ipcRenderer.removeListener(SNAPSHOT_CHANGED_CHANNEL, wrapped);
			};
		},
		revealOrSelect: (
			input: PluginWorkspaceRevealOrSelectInput
		): Promise<PluginWorkspaceRevealOrSelectResult | null> =>
			ipcRenderer.invoke('plugin-workspaces:reveal-or-select', input),
		mountPanel: (input: PluginWorkspaceMountPanelInput): Promise<PluginWorkspaceMountPanelResult> =>
			ipcRenderer.invoke('plugin-workspaces:mount-panel', input),
		unmountPanel: (input: PluginWorkspaceUnmountPanelInput): Promise<void> =>
			ipcRenderer.invoke('plugin-workspaces:unmount-panel', input),
	};
	return Object.freeze(api);
}
