/**
 * Moderator-only view for a group chat.
 *
 * A room's transcript carries two conversations at once: the one the user is
 * having with the moderator, and the back-and-forth the moderator runs with the
 * participant agents on the user's behalf. Most of the time only the first one
 * is being read, and the delegations and agent replies bury it.
 *
 * The moderator-only view hides the second conversation in BOTH places it shows
 * up - the message list and the right panel's activity history - so the two can
 * never disagree about what "the chat" is. Nothing is deleted or stopped: this
 * is a display filter over data that is still logged in full, and flipping back
 * to the team view restores every message.
 */

import type { GroupChatHistoryEntry, GroupChatMessage } from './group-chat-types';

/** How the moderator names itself in history entries and participant cards. */
export const MODERATOR_PARTICIPANT_NAME = 'Moderator';

/** The two ways a room can be read. */
export type GroupChatViewMode = 'team' | 'moderator';

/**
 * Message senders that belong to the user <-> moderator conversation.
 *
 * `system` earns its place here: those lines are notices addressed to the user
 * (a timeout, a queued handoff), not agent chatter, and dropping them would
 * leave a stalled room looking simply idle. Everything else - a participant's
 * own reply, or a `moderator->{name}` delegation - is team traffic.
 */
const DIRECT_SENDERS: ReadonlySet<string> = new Set(['user', 'moderator', 'system']);

/** Whether a message is part of the user <-> moderator conversation. */
export function isDirectModeratorMessage(message: GroupChatMessage): boolean {
	return DIRECT_SENDERS.has(message.from);
}

/** The history entries a given view mode shows. Returns the input array unchanged in team mode. */
export function filterGroupChatHistory(
	entries: GroupChatHistoryEntry[],
	moderatorOnly: boolean
): GroupChatHistoryEntry[] {
	if (!moderatorOnly) return entries;
	return entries.filter((entry) => entry.participantName === MODERATOR_PARTICIPANT_NAME);
}
