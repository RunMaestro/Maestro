import { useSyncExternalStore } from 'react';
import type {
	CanonicalInteractivePanelContribution,
	CanonicalWorkspaceContribution,
} from '../../../shared/plugins/contributions';

export interface PluginWorkspaceRoute {
	ownerPluginId: string;
	workspaceLocalId: string;
}

export const initialPluginWorkspaceRoute: PluginWorkspaceRoute | null = null;

export type PluginWorkspaceRouteAction =
	| { type: 'open'; ownerPluginId: string; workspaceLocalId: string }
	| { type: 'close' };

let activeRoute: PluginWorkspaceRoute | null = initialPluginWorkspaceRoute;
const routeListeners = new Set<() => void>();

function emitRoute(): void {
	for (const listener of routeListeners) listener();
}

export function openPluginWorkspace(route: PluginWorkspaceRoute): void {
	activeRoute = route;
	emitRoute();
}

export function closePluginWorkspace(): void {
	activeRoute = null;
	emitRoute();
}

export function usePluginWorkspaceRoute(): PluginWorkspaceRoute | null {
	return useSyncExternalStore(
		(listener) => {
			routeListeners.add(listener);
			return () => routeListeners.delete(listener);
		},
		() => activeRoute,
		() => initialPluginWorkspaceRoute
	);
}

/**
 * A workspace is host-renderable only when the capability-gated contribution
 * includes the closed interactive panel paired to that exact workspace owner.
 */
export function getPluginWorkspaceDestinations(
	workspaces: readonly CanonicalWorkspaceContribution[],
	panels: readonly CanonicalInteractivePanelContribution[]
): CanonicalWorkspaceContribution[] {
	return workspaces.filter((workspace) =>
		panels.some(
			(panel) =>
				panel.ownerPluginId === workspace.ownerPluginId && panel.localId === workspace.panelLocalId
		)
	);
}

export function reducePluginWorkspaceRoute(
	_route: PluginWorkspaceRoute | null,
	action: PluginWorkspaceRouteAction
): PluginWorkspaceRoute | null {
	switch (action.type) {
		case 'open':
			return { ownerPluginId: action.ownerPluginId, workspaceLocalId: action.workspaceLocalId };
		case 'close':
			return null;
	}
}
