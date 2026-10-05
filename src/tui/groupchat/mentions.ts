/**
 * The `@` picker over a group chat's message box (GC-5): address a participant by name.
 *
 * The engine already gives an addressed participant its due: a user message that `@mentions`
 * participants requires a handoff to each (B6), and one that mentions another agent adds it (B7).
 * What was missing is the box that lets a person say so without typing a name from memory. It is
 * the same picker as the tab composer's, over the same library rules (where a mention starts, how
 * rows rank, what accepting one inserts), fed a different roster: the chat's participants first,
 * then the agents the moderator could add.
 */

import {
	buildAgentMentionSuggestions,
	getMentionNameForContext,
	mentionableAgentsOf,
	mentionMatches,
	type AgentMentionSuggestion,
	type AgentRecord,
	type GroupChatRecord,
} from '../../shared/maestro-lib';
import type { ComposerState } from '../composer/draft';
import { resolveMentionPicker, type MentionPicker, type MentionUi } from '../composer/mentions';

/** What the picker header says: a message here addresses the room, not a consult. */
export const CHAT_MENTION_HINT = 'Address a participant, or add an agent';

/**
 * Every row the picker offers in `chat`: its participants, then the agents that are not in it yet
 * (a terminal is never one). A participant is named as it joined, which may no longer be its
 * agent's name, so the rows for participants are built from the chat and not the roster.
 */
export function chatMentionItems(
	chat: GroupChatRecord,
	agents: readonly AgentRecord[]
): AgentMentionSuggestion[] {
	const candidates = buildAgentMentionSuggestions(
		mentionableAgentsOf(agents),
		undefined,
		undefined
	);
	const peerNames = [
		...chat.participants.map((participant) => participant.name),
		...candidates
			.filter((row) => !isParticipant(chat, row.displayText))
			.map((row) => row.displayText),
	];

	const participants: AgentMentionSuggestion[] = chat.participants.map((participant) => ({
		value: `@${getMentionNameForContext(participant.name, peerNames)} `,
		displayText: participant.name,
		kind: 'agent',
		toolType: participant.provider,
		score: 0,
	}));
	const others = candidates.filter((row) => !isParticipant(chat, row.displayText));
	return [...participants, ...others];
}

function isParticipant(chat: GroupChatRecord, name: string): boolean {
	return chat.participants.some((participant) => mentionMatches(participant.name, name));
}

/** The open picker for the chat's draft, or undefined when the caret is not in an `@name`. */
export function resolveChatMentionPicker(
	draft: ComposerState,
	chat: GroupChatRecord,
	agents: readonly AgentRecord[],
	ui: MentionUi
): MentionPicker | undefined {
	// Most drafts carry no `@`: skip building the roster for them.
	if (!draft.text.includes('@')) return undefined;
	return resolveMentionPicker(draft, chatMentionItems(chat, agents), ui);
}
