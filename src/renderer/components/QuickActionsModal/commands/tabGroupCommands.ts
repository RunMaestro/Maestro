import type { Session, Shortcut } from '../../../types';
import type { QuickAction } from '../types';
import { useModalStore } from '../../../stores/modalStore';
import { updateSessionWith } from '../../../stores/sessionStore';
import { requestBreakApartTabGroup, requestCloseTabGroup } from '../../../services/tabGroupConfirm';
import { breakApartGroup, collectLeafTabRefs } from '../../../utils/panelLayout';

interface BuildTabGroupCommandsArgs {
	activeSession: Session | undefined;
	setQuickActionOpen: (open: boolean) => void;
	/** Live user binding for Rename Tab Group (unbound by default) */
	renameTabGroupShortcut?: Shortcut;
	/** Close every tab in a group; omitted where closing tabs is not wired */
	onCloseTabGroup?: (groupId: string) => void;
}

/**
 * Commands scoped to the tiled tab group the user is currently under. Only
 * emitted when `activeSession.activeGroupId` resolves to a real group (the
 * group is taking over the main panel), mirroring the actions available from
 * the group chip's hover overlay:
 *   - Rename Tab Group: opens the shared rename-tab modal seeded with the group
 *     id; commit is routed to the group-rename action in handleRenameTab.
 *   - Break Apart Tab Group: gated behind the same confirm dialog the chip uses,
 *     then promotes every pane back to the tab bar as standalone tabs.
 *   - Close Tab Group: gated behind the same confirm dialog the chip uses, then
 *     closes every tab in the group.
 */
export function buildTabGroupCommands({
	activeSession,
	setQuickActionOpen,
	renameTabGroupShortcut,
	onCloseTabGroup,
}: BuildTabGroupCommandsArgs): QuickAction[] {
	const commands: QuickAction[] = [];
	const groupId = activeSession?.activeGroupId;
	if (!activeSession || !groupId) return commands;
	const group = activeSession.tabGroups?.find((g) => g.id === groupId);
	if (!group) return commands;

	commands.push({
		id: 'renameTabGroup',
		label: 'Rename Tab Group',
		subtext: `Rename "${group.name}"`,
		shortcut: renameTabGroupShortcut,
		action: () => {
			// Reuse the shared rename-tab modal, seeded with the group id. On commit,
			// handleRenameTab detects the group id and routes to the group-rename action.
			useModalStore.getState().openModal('renameTab', {
				tabId: group.id,
				initialName: group.name,
			});
			setQuickActionOpen(false);
		},
	});

	commands.push({
		id: 'breakApartTabGroup',
		label: 'Break Apart Tab Group',
		subtext: 'Return its panes to the tab bar as individual tabs',
		action: () => {
			requestBreakApartTabGroup(group, () =>
				updateSessionWith(activeSession.id, (s) => breakApartGroup(s, group.id))
			);
			setQuickActionOpen(false);
		},
	});

	if (onCloseTabGroup) {
		const memberCount = collectLeafTabRefs(group.layout).length;
		commands.push({
			id: 'closeTabGroup',
			label: 'Close Tab Group',
			subtext: `Close "${group.name}" and the ${memberCount === 1 ? '1 tab' : `${memberCount} tabs`} in it`,
			action: () => {
				requestCloseTabGroup(group, memberCount, () => onCloseTabGroup(group.id));
				setQuickActionOpen(false);
			},
		});
	}

	return commands;
}
