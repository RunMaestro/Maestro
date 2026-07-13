import { ipcRenderer } from 'electron';
import type { WorkspaceContextChange } from '../../shared/plugins/workspace-foundation';

/** Public, renderer-safe projection of a workspace context transition. */
export type OmpWorkspaceContextChange = WorkspaceContextChange;

/**
 * Typed, narrow renderer adapter consumed by the OMP workspace integration.
 * It is receive-only: selection and snapshot publication stay in the trusted
 * main-process plugin runtime, and no plugin or arbitrary IPC address is
 * exposed to renderer code.
 */
export interface OmpWorkspaceApi {
	onContextChanged(callback: (change: OmpWorkspaceContextChange) => void): () => void;
}

export function createOmpWorkspaceApi(): OmpWorkspaceApi {
	return {
		onContextChanged: (callback) => {
			const listener = (_event: unknown, change: unknown): void => {
				if (!isWorkspaceContextChange(change)) return;
				callback(change);
			};
			ipcRenderer.on('plugins:workspace-context', listener);
			return () => ipcRenderer.removeListener('plugins:workspace-context', listener);
		},
	};
}

function isWorkspaceContextChange(value: unknown): value is OmpWorkspaceContextChange {
	if (typeof value !== 'object' || value === null) return false;
	const change = value as Record<string, unknown>;
	if (typeof change.ownerPluginId !== 'string' || typeof change.workspaceLocalId !== 'string') {
		return false;
	}
	return (
		(change.kind === 'external-session-selected' && typeof change.snapshotToken === 'string') ||
		change.kind === 'selection-cleared'
	);
}
