import type { Group } from '../../../types';
import type { QuickAction } from '../types';
import { getModalActions } from '../../../stores/modalStore';
import {
	delegationGroupLabel,
	delegationScopeGroups,
} from '../../DelegationGraph/DelegationGraphPlacement';

interface BuildDelegationGraphCommandsArgs {
	setQuickActionOpen: (open: boolean) => void;
	/** Ships unbound, so this is a chord only once the user binds one. */
	openDelegationGraphShortcut?: QuickAction['shortcut'];
	/** Every group gets a command that opens the graph on it. */
	groups?: readonly Pick<Group, 'id' | 'name' | 'emoji'>[];
}

/** The id of the palette command that opens the graph on one group. */
export function delegationGraphGroupCommandId(groupId: string): string {
	return `openDelegationGraph:${groupId}`;
}

/**
 * The palette's ways into the Delegation Graph: the fleet's peer relationships,
 * drawn. The first command opens on every agent, the same as the menu item and
 * the hotkey. Then one command per group opens on that group, the same as
 * "Delegation Graph" in the group's right-click menu. The chord belongs to the
 * first command only.
 */
export function buildDelegationGraphCommands({
	setQuickActionOpen,
	openDelegationGraphShortcut,
	groups = [],
}: BuildDelegationGraphCommandsArgs): QuickAction[] {
	const open = (groupId?: string) => {
		setQuickActionOpen(false);
		getModalActions().openDelegationGraph(groupId);
	};
	return [
		{
			id: 'openDelegationGraph',
			label: 'Delegation Graph',
			subtext: 'See which agent can consult or delegate to which',
			shortcut: openDelegationGraphShortcut,
			action: () => open(),
		},
		...delegationScopeGroups(groups).map((group) => ({
			id: delegationGraphGroupCommandId(group.id),
			label: `Delegation Graph: ${delegationGroupLabel(group)}`,
			subtext: 'Open the graph on this group and the agents it reaches',
			action: () => open(group.id),
		})),
	];
}
