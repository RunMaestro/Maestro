/**
 * @file groupChatRemote.ts
 * @description Wire shapes and pure helpers for driving a group chat from outside
 * the desktop window (maestro-cli and the web/mobile client, over the WebSocket
 * bridge). The renderer answers these requests; main only relays them.
 */

import {
	type GroupChat,
	type GroupChatMessage,
	type GroupChatState,
	extractAllMentions,
	mentionMatches,
	normalizeMentionName,
} from './group-chat-types';

/** One transcript line as the bridge reports it. */
export interface RemoteGroupChatMessage {
	id: string;
	participantId: string;
	participantName: string;
	content: string;
	timestamp: number;
	role: 'user' | 'assistant';
}

/** A group chat as the bridge reports it. `topic` is the chat's name. */
export interface RemoteGroupChatState {
	id: string;
	topic: string;
	participants: Array<{ sessionId: string; name: string; toolType: string }>;
	messages: RemoteGroupChatMessage[];
	/** True while the moderator or any participant is working. */
	isActive: boolean;
	/** The live turn state; absent from builds that predate it. */
	state?: GroupChatState;
	moderatorAgentId?: string;
	archived?: boolean;
	currentTurn?: string;
}

export function toRemoteGroupChatState(
	chat: GroupChat,
	state: GroupChatState,
	messages: GroupChatMessage[] = []
): RemoteGroupChatState {
	return {
		id: chat.id,
		topic: chat.name,
		participants: chat.participants.map((p) => ({
			sessionId: p.sessionId,
			name: p.name,
			toolType: p.agentId,
		})),
		messages: messages.map((m, index) => ({
			id: `${m.timestamp}-${index}`,
			participantId: m.from,
			participantName: m.from,
			content: m.content,
			timestamp: Date.parse(m.timestamp) || 0,
			role: m.from === 'user' ? 'user' : 'assistant',
		})),
		isActive: state !== 'idle',
		state,
		moderatorAgentId: chat.moderatorAgentId,
		archived: chat.archived,
	};
}

/**
 * Build the opening message for a remotely started chat: every participant
 * the body does not already @mention is mentioned up front, because a mention
 * is what makes the router add an agent (with its SSH, custom args and env)
 * to the chat.
 */
export function withParticipantMentions(body: string, participantNames: string[]): string {
	const mentioned = extractAllMentions(body);
	const missing = participantNames.filter(
		(name) => !mentioned.some((m) => mentionMatches(m, name))
	);
	if (missing.length === 0) return body;
	const prefix = missing.map((name) => `@${normalizeMentionName(name)}`).join(' ');
	return `${prefix}\n\n${body}`;
}
