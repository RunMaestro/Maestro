/**
 * Shared "is this group chat running?" predicate.
 *
 * A room is running when its moderator is thinking OR any participant is
 * working. The catch is that those two facts live in two different places: the
 * ACTIVE room's live state is in `groupChatState` / `participantStates`, while
 * every other room is mirrored into `groupChatStates` /
 * `allGroupChatParticipantStates`. A caller that consults only one pair gets
 * the wrong answer for half the list, so the pair-picking lives here rather
 * than being re-derived at each surface (Left Bar list, wand indicator,
 * agent jumper).
 */

import type { GroupChatState } from '../../shared/group-chat-types';

export type ParticipantState = 'idle' | 'working';

/** The slice of group chat state needed to answer "is this room running?". */
export interface GroupChatBusySnapshot {
	activeGroupChatId?: string | null;
	groupChatState?: GroupChatState;
	participantStates?: Map<string, ParticipantState>;
	groupChatStates?: Map<string, GroupChatState>;
	allGroupChatParticipantStates?: Map<string, Map<string, ParticipantState>>;
}

export interface GroupChatRunState {
	/** Moderator state for this room, resolved from the right source. */
	moderatorState: GroupChatState;
	/** Names of participants currently working in this room. */
	workingParticipants: string[];
	/** Moderator thinking or at least one participant working. */
	isBusy: boolean;
}

export function getGroupChatRunState(
	chatId: string,
	snapshot: GroupChatBusySnapshot
): GroupChatRunState {
	const isActive = snapshot.activeGroupChatId === chatId;
	const moderatorState = isActive
		? (snapshot.groupChatState ?? 'idle')
		: (snapshot.groupChatStates?.get(chatId) ?? 'idle');
	const participantStates = isActive
		? snapshot.participantStates
		: snapshot.allGroupChatParticipantStates?.get(chatId);

	const workingParticipants: string[] = [];
	if (participantStates) {
		for (const [name, state] of participantStates) {
			if (state === 'working') workingParticipants.push(name);
		}
	}

	return {
		moderatorState,
		workingParticipants,
		isBusy: moderatorState !== 'idle' || workingParticipants.length > 0,
	};
}

export function isGroupChatBusy(chatId: string, snapshot: GroupChatBusySnapshot): boolean {
	return getGroupChatRunState(chatId, snapshot).isBusy;
}

/**
 * Busy room ids, restricted to rooms the caller still knows about. The
 * all-chats maps can outlive a deleted room, so we intersect with the live
 * list rather than trusting the map keys.
 */
export function getBusyGroupChatIds(
	chats: readonly { id: string }[],
	snapshot: GroupChatBusySnapshot
): string[] {
	return chats.filter((chat) => isGroupChatBusy(chat.id, snapshot)).map((chat) => chat.id);
}

/** One-line status for a running room, e.g. "Moderator thinking - Atlas working". */
export function describeGroupChatRunState(run: GroupChatRunState): string {
	const parts: string[] = [];
	if (run.moderatorState === 'moderator-thinking') parts.push('Moderator thinking');
	if (run.workingParticipants.length > 0) {
		parts.push(
			run.workingParticipants.length <= 2
				? `${run.workingParticipants.join(', ')} working`
				: `${run.workingParticipants.length} agents working`
		);
	}
	// 'agent-working' with no participant map entry yet (the moderator has
	// dispatched but the per-agent state hasn't landed) still deserves a label.
	if (parts.length === 0 && run.isBusy) parts.push('Working');
	return parts.join(' · ');
}
