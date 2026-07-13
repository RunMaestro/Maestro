import { useEffect } from 'react';
import { openPluginWorkspace } from './pluginWorkspaceNavigation';
import {
	type PluginWorkspaceProjectionSource,
	usePluginWorkspaceProjection,
} from './pluginWorkspaceProjection';

interface PluginWorkspaceSelectionSyncProps {
	source: PluginWorkspaceProjectionSource;
}

/** Activates the generic workspace route from a host-owned opaque selection context. */
export function PluginWorkspaceSelectionSync({ source }: PluginWorkspaceSelectionSyncProps) {
	const projection = usePluginWorkspaceProjection(source);
	const selection = projection.snapshot?.selection;
	useEffect(() => {
		if (!selection) return;
		openPluginWorkspace({
			ownerPluginId: selection.ownerPluginId,
			workspaceLocalId: selection.workspaceLocalId,
		});
	}, [selection]);
	return null;
}
