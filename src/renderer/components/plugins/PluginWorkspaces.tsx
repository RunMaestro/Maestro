import { X } from 'lucide-react';
import type { Theme } from '../../types';
import { usePluginContributions } from '../../hooks/usePluginContributions';
import {
	closePluginWorkspace,
	getPluginWorkspaceDestinations,
	usePluginWorkspaceRoute,
} from './pluginWorkspaceNavigation';
import {
	PluginInteractivePanelFrame,
	type InteractivePanelHostBinder,
} from './PluginInteractivePanelFrame';

interface PluginWorkspacesProps {
	theme: Theme;
	binder?: InteractivePanelHostBinder;
}

/** Main-workspace host for the selected capability-gated plugin workspace. */
export function PluginWorkspaces({ theme, binder }: PluginWorkspacesProps) {
	const contributions = usePluginContributions();
	const route = usePluginWorkspaceRoute();
	if (!binder || !route) return null;

	const workspace = getPluginWorkspaceDestinations(
		contributions.workspaces,
		contributions.interactivePanels
	).find(
		(candidate) =>
			candidate.ownerPluginId === route.ownerPluginId && candidate.localId === route.workspaceLocalId
	);
	if (!workspace) return null;
	const panel = contributions.interactivePanels.find(
		(candidate) =>
			candidate.ownerPluginId === workspace.ownerPluginId && candidate.localId === workspace.panelLocalId
	);
	if (!panel) return null;

	return (
		<section
			className="flex min-w-0 flex-1 flex-col overflow-hidden"
			aria-label={`${workspace.title} workspace`}
			style={{ backgroundColor: theme.colors.bgMain, color: theme.colors.textMain }}
		>
			<header
				className="flex shrink-0 items-center justify-between border-b px-3 py-2"
				style={{ borderColor: theme.colors.border }}
			>
				<span className="text-sm font-medium">{workspace.title}</span>
				<button
					type="button"
					onClick={closePluginWorkspace}
					aria-label={`Close ${workspace.title}`}
					className="rounded p-1 hover:bg-white/10"
				>
					<X size={16} aria-hidden />
				</button>
			</header>
			<div className="min-h-0 flex-1">
				<PluginInteractivePanelFrame theme={theme} panel={panel} binder={binder} />
			</div>
		</section>
	);
}
