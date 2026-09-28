/**
 * Helpers for the AI / group-chat "Find" bar, whose state is scoped per chat
 * window in uiStore (`outputSearchByKey`). The key identifies one chat window
 * so a search opened in one agent/tab/group chat doesn't leak its open flag
 * or term into others.
 *
 * This module imports stores but those stores do not import it, so it stays a
 * leaf and avoids store cycles.
 */
import { useGroupChatStore } from '../stores/groupChatStore';
import { selectActiveSession, useSessionStore } from '../stores/sessionStore';
import { useUIStore } from '../stores/uiStore';

/** Build the per-window key for a given agent + active AI tab. */
export function outputSearchKeyFor(sessionId: string, tabId: string | null | undefined): string {
	return `${sessionId}::${tabId ?? ''}`;
}

/**
 * Build the per-window key for a group chat transcript Find bar.
 * Group chats have no AI tabs, so they cannot reuse `sessionId::tabId`.
 */
export function groupChatOutputSearchKey(groupChatId: string): string {
	return `group-chat::${groupChatId}`;
}

/**
 * Fingerprint for group-chat Find. Message COUNT is not enough: a streaming
 * reply grows `content` in place, so the Find bar must re-scan when any
 * message's text length changes. Query and open are included so a closed bar
 * with a leftover query does not share a revision with an open one.
 */
export function groupChatSearchContentRevision(
	messages: ReadonlyArray<{ content: string }>,
	searchQuery: string,
	searchOpen: boolean
): string {
	return `${messages.length}:${messages.map((m) => m.content.length).join(',')}:${searchQuery}:${searchOpen}`;
}

/**
 * Key for the currently active chat window, or null when none.
 * Prefers the active group chat when one is open (MainPanel is unmounted then).
 */
export function getActiveOutputSearchKey(): string | null {
	const groupChatId = useGroupChatStore.getState().activeGroupChatId;
	if (groupChatId) {
		return groupChatOutputSearchKey(groupChatId);
	}
	const session = selectActiveSession(useSessionStore.getState());
	return session ? outputSearchKeyFor(session.id, session.activeTabId) : null;
}

/** Whether the Find bar is open for the currently active chat window. */
export function isActiveOutputSearchOpen(): boolean {
	const key = getActiveOutputSearchKey();
	if (!key) return false;
	return useUIStore.getState().outputSearchByKey[key]?.open ?? false;
}
