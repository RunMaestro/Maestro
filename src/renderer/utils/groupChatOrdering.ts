/**
 * Shared group-chat display ordering.
 *
 * The sidebar (GroupChatList) and keyboard navigation both show non-archived
 * chats sorted either alphabetically or by most-recent activity, per the user's
 * toggle. Centralizing that comparator here keeps "visible order" consistent
 * across the list, arrow-key navigation, and post-delete focus selection.
 */

/** Minimal shape needed to order group chats for display. */
export interface OrderableGroupChat {
	id: string;
	name: string;
	archived?: boolean;
	updatedAt?: number;
	createdAt?: number;
}

export interface OrderGroupChatsOptions {
	/**
	 * Draw archived chats too. Defaults to false, which is what the list does
	 * until the user turns its "show archived" toggle on.
	 *
	 * This has to be an argument rather than the caller pre-filtering, because
	 * the drop used to be unconditional here: a caller that had already decided
	 * archived chats were on screen had them silently removed again on the way
	 * through, and the Cmd+[ / Cmd+] cycle could never reach one.
	 */
	includeArchived?: boolean;
}

/**
 * Order group chats the way the sidebar renders them: archived dropped unless
 * asked for, then alphabetical or most-recent-first per the toggle.
 */
export function orderGroupChatsForDisplay<T extends OrderableGroupChat>(
	groupChats: T[],
	alphabetical: boolean,
	options: OrderGroupChatsOptions = {}
): T[] {
	return groupChats
		.filter((c) => options.includeArchived || !c.archived)
		.sort((a, b) => {
			if (alphabetical) return a.name.localeCompare(b.name);
			return (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0);
		});
}

export interface VisibleGroupChatsOptions {
	sortAlphabetical: boolean;
	/** The list's "show archived" toggle. Archived chats then sort after active ones. */
	showArchived: boolean;
	/** The unread filter: only busy or unread chats, plus the active one. */
	showUnreadAgentsOnly: boolean;
	activeGroupChatId: string | null;
	isChatBusy: (chatId: string) => boolean;
	isChatUnread: (chatId: string) => boolean;
}

/**
 * The group chats the Left Bar draws, in draw order. Shared by `GroupChatList`
 * (which renders them) and the Left Bar's published row order (which Cmd+[ /
 * Cmd+] walks), so the two cannot disagree about which rooms are on screen.
 */
export function selectVisibleGroupChats<T extends OrderableGroupChat>(
	groupChats: readonly T[],
	options: VisibleGroupChatsOptions
): T[] {
	return groupChats
		.filter((c) => options.showArchived || !c.archived)
		.filter((c) => {
			if (!options.showUnreadAgentsOnly) return true;
			if (c.id === options.activeGroupChatId) return true;
			return options.isChatBusy(c.id) || options.isChatUnread(c.id);
		})
		.sort((a, b) => {
			if (options.showArchived && Boolean(a.archived) !== Boolean(b.archived)) {
				return a.archived ? 1 : -1;
			}
			if (options.sortAlphabetical) return a.name.localeCompare(b.name);
			return (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0);
		});
}

/**
 * Pick which group chat should take focus after `deletedId` is removed, so the
 * user stays in the group-chat area while sweeping through and deleting chats:
 * the chat that shifts up into the deleted slot (the "next below"), or the new
 * last chat when the deleted one was at the bottom. Returns null when no chats
 * remain, signaling the caller to fall back to an agent.
 */
export function pickNextGroupChatIdAfterDelete<T extends OrderableGroupChat>(
	deletedId: string,
	groupChats: T[],
	alphabetical: boolean
): string | null {
	const ordered = orderGroupChatsForDisplay(groupChats, alphabetical);
	const deletedIndex = ordered.findIndex((c) => c.id === deletedId);
	if (deletedIndex === -1) return null;
	const remaining = ordered.filter((c) => c.id !== deletedId);
	if (remaining.length === 0) return null;
	return (remaining[deletedIndex] ?? remaining[remaining.length - 1]).id;
}
