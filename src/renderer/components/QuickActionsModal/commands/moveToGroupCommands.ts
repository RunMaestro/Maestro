import type { Group } from '../../../types';
import type { QuickAction, QuickActionMode } from '../types';

interface BuildMoveToGroupCommandsArgs {
	initialMode: QuickActionMode;
	groups: Group[];
	handleMoveToGroup: (groupId: string) => void;
	handleCreateGroup: () => void;
	setMode: (mode: QuickActionMode) => void;
	resetSelectionToFirst: () => void;
}

export function buildMoveToGroupCommands({
	initialMode,
	groups,
	handleMoveToGroup,
	handleCreateGroup,
	setMode,
	resetSelectionToFirst,
}: BuildMoveToGroupCommandsArgs): QuickAction[] {
	return [
		...(initialMode === 'main'
			? [
					{
						id: 'back',
						label: '← Back to main menu',
						action: () => {
							setMode('main');
							resetSelectionToFirst();
						},
					},
				]
			: []),
		{ id: 'no-group', label: '📁 No Group (Ungrouped)', action: () => handleMoveToGroup('') },
		...groups.map((group) => ({
			id: `group-${group.id}`,
			label: `${group.emoji} ${group.name}`,
			action: () => handleMoveToGroup(group.id),
		})),
		{ id: 'create-new', label: '+ Create New Group', action: handleCreateGroup },
	];
}
