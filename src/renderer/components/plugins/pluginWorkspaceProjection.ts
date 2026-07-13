import { useEffect, useState } from 'react';

export type PluginExternalSessionStatus =
	| 'starting'
	| 'idle'
	| 'working'
	| 'waiting_for_input'
	| 'waiting_for_approval'
	| 'retrying'
	| 'completed'
	| 'aborted'
	| 'failed'
	| 'offline';

export interface PluginExternalSessionProjection {
	externalSessionId: string;
	title: string;
	status: PluginExternalSessionStatus;
	unread: number;
	pendingApproval: boolean;
	updatedAt: number;
	/** Opaque host-issued capability, passed only to reveal. */
	snapshotToken: string;
}

export interface PluginWorkspaceProjection {
	connection: 'ready' | 'offline' | 'error';
	error?: string;
	workspaces: readonly {
		ownerPluginId: string;
		workspaceLocalId: string;
		sessions: readonly PluginExternalSessionProjection[];
	}[];
	selection: {
		ownerPluginId: string;
		workspaceLocalId: string;
		snapshotToken: string;
	} | null;
}

/** Typed frozen preload source injected by App; no renderer component accesses globals or IPC. */
export interface PluginWorkspaceProjectionSource {
	getSnapshot(): Promise<PluginWorkspaceProjection>;
	subscribe(listener: (snapshot: PluginWorkspaceProjection) => void): () => void;
	select(target: { ownerPluginId: string; workspaceLocalId: string }): Promise<void>;
	reveal(target: { ownerPluginId: string; workspaceLocalId: string; snapshotToken: string }): Promise<void>;
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
