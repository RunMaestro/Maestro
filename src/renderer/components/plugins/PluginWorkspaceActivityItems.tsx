import { Bot, Sparkles, Workflow } from 'lucide-react';
import type { Theme } from '../../types';
import { usePluginContributions } from '../../hooks/usePluginContributions';
import type { InteractivePanelHostBinder } from './PluginInteractivePanelFrame';
import {
	getPluginWorkspaceDestinations,
	openPluginWorkspace,
	usePluginWorkspaceRoute,
} from './pluginWorkspaceNavigation';
import {
	type PluginWorkspaceProjectionSource,
	usePluginWorkspaceProjection,
} from './pluginWorkspaceProjection';

interface PluginWorkspaceActivityItemsProps {
	theme: Theme;
	binder?: InteractivePanelHostBinder;
	source?: PluginWorkspaceProjectionSource;
}

const ICONS = { bot: Bot, sparkles: Sparkles, workflow: Workflow } as const;

/** Capability-gated activity-bar destinations for closed plugin workspaces. */
export function PluginWorkspaceActivityItems({ theme, binder, source }: PluginWorkspaceActivityItemsProps) {
	if (!binder || !source) return null;
	return <PluginWorkspaceActivityItemsWithProjection theme={theme} source={source} />;
}

function PluginWorkspaceActivityItemsWithProjection({
	theme,
	source,
}: Pick<PluginWorkspaceActivityItemsProps, 'theme'> & { source: PluginWorkspaceProjectionSource }) {
	const contributions = usePluginContributions();
	const route = usePluginWorkspaceRoute();
	const projection = usePluginWorkspaceProjection(source);
	const workspaces = getPluginWorkspaceDestinations(
		contributions.workspaces,
		contributions.interactivePanels
	);
	if (workspaces.length === 0) return null;

	return (
		<div className="flex flex-col items-center gap-2" data-plugin-workspace-activity-items>
			{workspaces.map((workspace) => {
				const Icon = ICONS[workspace.icon];
				const active = route?.ownerPluginId === workspace.ownerPluginId && route.workspaceLocalId === workspace.localId;
				const projectedWorkspace = projection.snapshot?.workspaces.find(
					(candidate) => candidate.ownerPluginId === workspace.ownerPluginId && candidate.workspaceLocalId === workspace.localId
				);
				const unread = Math.min(99, projectedWorkspace?.sessions.reduce((total, session) => total + Math.max(0, session.unread), 0) ?? 0);
				const pendingApproval = projectedWorkspace?.sessions.some((session) => session.pendingApproval) ?? false;
				return (
					<button
						key={workspace.canonicalContributionId}
						type="button"
						onClick={() => openPluginWorkspace({ ownerPluginId: workspace.ownerPluginId, workspaceLocalId: workspace.localId })}
						aria-label={`Open ${workspace.title}${pendingApproval ? ', approval required' : ''}${unread > 0 ? `, ${unread} unread` : ''}`}
						aria-current={active ? 'page' : undefined}
						className="relative rounded p-2 hover:bg-white/10"
						style={{ color: active || pendingApproval ? theme.colors.accent : theme.colors.textDim }}
						title={workspace.title}
					>
						<Icon size={18} aria-hidden />
						{unread > 0 && <span className="absolute -right-1 -top-1 rounded-full px-1 text-[10px]" style={{ backgroundColor: theme.colors.accent, color: theme.colors.bgMain }}>{unread === 99 ? '99+' : unread}</span>}
					</button>
				);
			})}
		</div>
	);
}
