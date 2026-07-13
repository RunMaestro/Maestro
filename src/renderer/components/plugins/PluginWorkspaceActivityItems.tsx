import { Bot, Sparkles, Workflow } from 'lucide-react';
import type { Theme } from '../../types';
import { usePluginContributions } from '../../hooks/usePluginContributions';
import type { InteractivePanelHostBinder } from './PluginInteractivePanelFrame';
import {
	getPluginWorkspaceDestinations,
	openPluginWorkspace,
	usePluginWorkspaceRoute,
} from './pluginWorkspaceNavigation';

interface PluginWorkspaceActivityItemsProps {
	theme: Theme;
	binder?: InteractivePanelHostBinder;
}

const ICONS = { bot: Bot, sparkles: Sparkles, workflow: Workflow } as const;

/** Capability-gated activity-bar destinations for closed plugin workspaces. */
export function PluginWorkspaceActivityItems({ theme, binder }: PluginWorkspaceActivityItemsProps) {
	const contributions = usePluginContributions();
	const route = usePluginWorkspaceRoute();
	if (!binder) return null;

	const workspaces = getPluginWorkspaceDestinations(
		contributions.workspaces,
		contributions.interactivePanels
	);
	if (workspaces.length === 0) return null;

	return (
		<div className="flex flex-col items-center gap-2" data-plugin-workspace-activity-items>
			{workspaces.map((workspace) => {
				const Icon = ICONS[workspace.icon];
				const active =
					route?.ownerPluginId === workspace.ownerPluginId &&
					route.workspaceLocalId === workspace.localId;
				return (
					<button
						key={workspace.canonicalContributionId}
						type="button"
						onClick={() =>
							openPluginWorkspace({
								ownerPluginId: workspace.ownerPluginId,
								workspaceLocalId: workspace.localId,
							})
						}
						aria-label={`Open ${workspace.title}`}
						aria-current={active ? 'page' : undefined}
						className="rounded p-2 hover:bg-white/10"
						style={{ color: active ? theme.colors.accent : theme.colors.textDim }}
						title={workspace.title}
					>
						<Icon size={18} aria-hidden />
					</button>
				);
			})}
		</div>
	);
}
