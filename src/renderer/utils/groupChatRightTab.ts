/**
 * The group chat Right Bar's tab (Participants / History), in one place.
 *
 * Two surfaces set it - the tab strip the user clicks and the Cmd+Shift+[ /
 * Cmd+Shift+] chord - and the value is BOTH live state and a per-chat setting
 * (`groupChatRightTab:<id>`), which is what `handleOpenGroupChat` reads back
 * when the chat is reopened. A caller that sets the store without persisting
 * leaves the panel snapping back to the other tab on the next visit, so the
 * store write and the settings write travel together rather than being
 * re-typed per surface.
 */

import { useGroupChatStore, type GroupChatRightTab } from '../stores/groupChatStore';

/** Set the active group chat's Right Bar tab and remember it for that chat. */
export function applyGroupChatRightTab(tab: GroupChatRightTab): void {
	const { setGroupChatRightTab, activeGroupChatId } = useGroupChatStore.getState();
	setGroupChatRightTab(tab);
	if (activeGroupChatId) {
		window.maestro.settings.set(`groupChatRightTab:${activeGroupChatId}`, tab);
	}
}

/**
 * Flip to the other tab. There are exactly two, so "previous" and "next" are
 * the same move - the chord reads as "show me the other panel" in both
 * directions rather than dead in one of them.
 */
export function toggleGroupChatRightTab(): GroupChatRightTab {
	const next: GroupChatRightTab =
		useGroupChatStore.getState().groupChatRightTab === 'participants' ? 'history' : 'participants';
	applyGroupChatRightTab(next);
	return next;
}
