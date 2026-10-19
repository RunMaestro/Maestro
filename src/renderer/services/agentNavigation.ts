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
import type { SingleTabRef } from '../../shared/unifiedTabRef';
import { useSessionStore } from '../stores/sessionStore';
import { useUIStore } from '../stores/uiStore';
import { useFileExplorerStore } from '../stores/fileExplorerStore';
import { useGroupChatStore } from '../stores/groupChatStore';
import { useModalStore } from '../stores/modalStore';
import {
	aiTabFocusFields,
	browserTabFocusFields,
	fileTabFocusFields,
	terminalTabFocusFields,
} from '../utils/tabFocusFields';
import { requestSidebarReveal } from '../utils/sidebarReveal';
import { focusTabWindowIfPoppedOut, sessionHasTab } from './tabWindowNavigation';

/**
 * Make sure a jumped-to agent is actually visible in the Left Bar, without
 * expanding more than we have to, and scroll its row into view.
 *
 * - Not bookmarked: expand the parent group if collapsed.
 * - Bookmarked: prefer whichever section the agent is already visible in. If
 *   neither bookmarks nor the parent group is open, expand bookmarks (the
 *   pinned bookmark row is the lighter-weight reveal of the two).
 */
export function revealAgentInSidebar(session: Session): void {
	// Explicit even though the switch itself triggers a reveal: jumping to the
	// agent that is already active changes nothing the Left Bar watches.
	requestSidebarReveal();
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
	/**
	 * Tab of any kind to land on; wins over `tabId`. Ignored when the agent no
	 * longer has that tab.
	 */
	tabRef?: SingleTabRef;
}

/** The focus patch that shows `ref`, or the plain AI view when it is gone. */
function jumpFocusFields(session: Session, ref: SingleTabRef | undefined): Partial<Session> {
	if (!ref || !sessionHasTab(session, ref)) return aiTabFocusFields();
	switch (ref.type) {
		case 'ai':
			return aiTabFocusFields(ref.id);
		case 'file':
			return fileTabFocusFields(ref.id);
		case 'terminal':
			return terminalTabFocusFields(ref.id);
		case 'browser':
			return browserTabFocusFields(ref.id);
	}
}

/**
 * Bring an agent on screen: dismiss whatever is covering it, select it, show
 * the requested tab (else the AI view), and reveal it in the Left Bar. A tab
 * that is popped out into a tab window is shown there instead, and the owner
 * window's view does not move (Tab Windows, D4).
 *
 * @returns `false` when the agent no longer exists, so the caller can say so
 * instead of leaving the user on an unchanged screen.
 */
export function jumpToAgent(sessionId: string, options: JumpToAgentOptions = {}): boolean {
	const { sessions, setActiveSessionId, setSessions } = useSessionStore.getState();
	const session = sessions.find((s) => s.id === sessionId);
	if (!session) return false;

	const targetRef: SingleTabRef | undefined =
		options.tabRef ?? (options.tabId ? { type: 'ai', id: options.tabId } : undefined);
	if (focusTabWindowIfPoppedOut(sessionId, targetRef)) return true;

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

	// The focus helpers clear the other tab types' active state, so the jump
	// shows the requested tab (or the AI view) even when the agent was last
	// viewed on another tab type.
	setSessions((prev) =>
		prev.map((s) => (s.id === sessionId ? { ...s, ...jumpFocusFields(s, targetRef) } : s))
	);

	revealAgentInSidebar(session);
	return true;
}

/** Open the Edit Agent modal for an agent (the per-agent settings pane). */
export function openAgentSettings(session: Session): void {
	useModalStore.getState().openModal('editAgent', { session });
}
