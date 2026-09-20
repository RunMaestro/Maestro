/**
 * agentNavigation - the shared "take me to that agent" path.
 *
 * Jumping to an agent is never just `setActiveSessionId`. The Document Graph is
 * a full-screen overlay that would sit on top of the agent, an active group
 * chat keeps rendering instead of the agent, the main window may be parked on a
 * terminal / file / browser tab, and the agent itself may be hidden inside a
 * collapsed group or a collapsed bookmarks section. Every caller that forgot
 * one of those steps produced a jump that looked like it did nothing.
 *
 * The reveal half of this used to live inline in QuickActionsModal; it is here
 * so the Usage Dashboard's agent detail view and the command palette land the
 * user in the same place.
 *
 * Everything self-sources from the stores, so this is callable from any
 * component without threading callbacks down through modal trees.
 */

import type { Session } from '../types';
import { useSessionStore } from '../stores/sessionStore';
import { useUIStore } from '../stores/uiStore';
import { useFileExplorerStore } from '../stores/fileExplorerStore';
import { useGroupChatStore } from '../stores/groupChatStore';
import { useModalStore } from '../stores/modalStore';
import { aiTabFocusFields } from '../utils/tabFocusFields';

/**
 * Make sure a jumped-to agent is actually visible in the Left Bar, without
 * expanding more than we have to.
 *
 * - Not bookmarked: expand the parent group if collapsed.
 * - Bookmarked: prefer whichever section the agent is already visible in. If
 *   neither bookmarks nor the parent group is open, expand bookmarks (the
 *   pinned bookmark row is the lighter-weight reveal of the two).
 */
export function revealAgentInSidebar(session: Session): void {
	const { groups, setGroups } = useSessionStore.getState();

	if (!session.bookmarked) {
		if (session.groupId) {
			setGroups((prev) =>
				prev.map((g) => (g.id === session.groupId && g.collapsed ? { ...g, collapsed: false } : g))
			);
		}
		return;
	}

	const groupOpen = session.groupId
		? !groups.find((g) => g.id === session.groupId)?.collapsed
		: false;
	const { bookmarksCollapsed, setBookmarksCollapsed } = useUIStore.getState();
	if (bookmarksCollapsed && !groupOpen) {
		setBookmarksCollapsed(false);
	}
}

export interface JumpToAgentOptions {
	/** AI tab to land on. Ignored when the agent no longer has that tab. */
	tabId?: string;
}

/**
 * Bring an agent on screen: dismiss whatever is covering it, select it, force
 * the AI view, and reveal it in the Left Bar.
 *
 * @returns `false` when the agent no longer exists, so the caller can say so
 * instead of leaving the user on an unchanged screen.
 */
export function jumpToAgent(sessionId: string, options: JumpToAgentOptions = {}): boolean {
	const { sessions, setActiveSessionId, setSessions } = useSessionStore.getState();
	const session = sessions.find((s) => s.id === sessionId);
	if (!session) return false;

	const fileExplorer = useFileExplorerStore.getState();
	if (fileExplorer.isGraphViewOpen) {
		fileExplorer.closeGraphView();
	}
	// A group chat renders instead of the agent's transcript, so selecting the
	// agent without dismissing it lands on the chat.
	useGroupChatStore.getState().setActiveGroupChatId(null);

	setActiveSessionId(sessionId);

	// Narrow viewports: the left drawer is an overlay over the very agent this
	// jump is meant to show, so it gets out of the way. No-op when it is a
	// permanent column.
	useUIStore.getState().closeLeftSidebarForNavigation();

	// Clear file / terminal / browser active-tab state so the jump shows the AI
	// terminal even when the agent was last viewed on another tab type.
	setSessions((prev) =>
		prev.map((s) => {
			if (s.id !== sessionId) return s;
			const targetTabId =
				options.tabId && s.aiTabs?.some((t) => t.id === options.tabId) ? options.tabId : undefined;
			return { ...s, ...aiTabFocusFields(targetTabId) };
		})
	);

	revealAgentInSidebar(session);
	return true;
}

/** Open the Edit Agent modal for an agent (the per-agent settings pane). */
export function openAgentSettings(session: Session): void {
	useModalStore.getState().openModal('editAgent', { session });
}
