/**
 * Confirmation dialogs for the two group actions that end a tiled tab group.
 *
 * Both open the shared modal-store `confirm` dialog, whose confirm button takes
 * focus on open, so Enter confirms and Escape cancels. Every surface that offers
 * one of these (the group chip's menu, the command palette, a pane's menu) goes
 * through here so the copy and the destructive styling cannot drift apart.
 */
import type { TabGroup } from '../types';
import { useModalStore } from '../stores/modalStore';

/**
 * Ask before dissolving a group into standalone tabs. Nothing is closed, so the
 * dialog is not styled destructive.
 */
export function requestBreakApartTabGroup(
	group: Pick<TabGroup, 'name'>,
	onConfirm: () => void
): void {
	useModalStore.getState().openModal('confirm', {
		title: 'Break apart group?',
		message: `Break apart "${group.name}"? Its panes return to the tab bar as individual tabs. The tabs are not closed, and you can tile them again later.`,
		destructive: false,
		onConfirm,
	});
}

/**
 * Ask before closing every tab in a group. Destructive: running terminals stop
 * and unsent drafts in the group's panes are lost.
 */
export function requestCloseTabGroup(
	group: Pick<TabGroup, 'name'>,
	memberCount: number,
	onConfirm: () => void
): void {
	const tabs = memberCount === 1 ? '1 tab' : `${memberCount} tabs`;
	useModalStore.getState().openModal('confirm', {
		title: 'Close group?',
		message: `Close "${group.name}" and the ${tabs} in it? Running terminals stop and unsent drafts are lost.`,
		destructive: true,
		onConfirm,
	});
}
