import { useEffect, useState } from 'react';
import type {
	PluginWorkspaceExternalSessionDto,
	PluginWorkspacesSnapshotDto,
} from '../../../shared/plugins/plugin-workspace-bridge';

export type PluginExternalSessionProjection = PluginWorkspaceExternalSessionDto;
export type PluginWorkspaceProjection = PluginWorkspacesSnapshotDto;

/** Typed frozen preload source injected by App; no renderer component accesses globals or IPC. */
export interface PluginWorkspaceProjectionSource {
	getSnapshot(): Promise<PluginWorkspaceProjection>;
	subscribe(listener: (snapshot: PluginWorkspaceProjection) => void): () => void;
	reveal(target: { snapshotToken: string }): Promise<void>;
}

export interface PluginWorkspaceProjectionState {
	phase: 'loading' | 'ready' | 'error';
	snapshot: PluginWorkspaceProjection | null;
	error: string | null;
}

const initialState: PluginWorkspaceProjectionState = {
	phase: 'loading',
	snapshot: null,
	error: null,
};

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : 'Plugin workspace transport is unavailable.';
}

/** Loads and streams only the typed host projection, cleaning up its exact subscription. */
export function usePluginWorkspaceProjection(
	source: PluginWorkspaceProjectionSource
): PluginWorkspaceProjectionState {
	const [state, setState] = useState<PluginWorkspaceProjectionState>(initialState);
	useEffect(() => {
		let active = true;
		void source
			.getSnapshot()
			.then((snapshot) => {
				if (active) setState({ phase: 'ready', snapshot, error: null });
			})
			.catch((error: unknown) => {
				if (active) setState({ phase: 'error', snapshot: null, error: messageOf(error) });
			});
		const unsubscribe = source.subscribe((snapshot) => {
			if (active) setState({ phase: 'ready', snapshot, error: null });
		});
		return () => {
			active = false;
			unsubscribe();
		};
	}, [source]);
	return state;
}
