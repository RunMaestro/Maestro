/**
 * Answers group chat requests that arrive over the WebSocket bridge
 * (maestro-cli `group-chat`, the web/mobile client).
 *
 * Main relays these to the renderer rather than acting on its own because the
 * renderer's group chat store is what the Left Bar draws: a chat created behind
 * its back would not appear until the next restart.
 *
 * None of this moves the user's view. A chat started remotely lands in the
 * Left Bar like any other room; it is never opened or focused.
 */

import type { GroupChatState } from '../../shared/group-chat-types';
import { mentionMatches } from '../../shared/group-chat-types';
import {
	type RemoteGroupChatState,
	toRemoteGroupChatState,
	withParticipantMentions,
} from '../../shared/groupChatRemote';
import { useGroupChatStore } from '../stores/groupChatStore';
import { useSessionStore } from '../stores/sessionStore';
import { useBatchStore } from '../stores/batchStore';
import { getAutoRunSessionsForGroupChat } from '../utils/groupChatAutoRunRegistry';

export interface RemoteStartGroupChatOptions {
	moderatorAgentId?: string;
	message?: string;
}

function chatState(chatId: string): GroupChatState {
	return useGroupChatStore.getState().groupChatStates.get(chatId) ?? 'idle';
}

function setChatState(chatId: string, state: GroupChatState): void {
	const { setGroupChatStates, activeGroupChatId, setGroupChatState } = useGroupChatStore.getState();
	setGroupChatStates((prev) => {
		const next = new Map(prev);
		next.set(chatId, state);
		return next;
	});
	if (activeGroupChatId === chatId) setGroupChatState(state);
}

export async function listRemoteGroupChats(): Promise<RemoteGroupChatState[]> {
	const chats = await window.maestro.groupChat.list();
	return chats.map((chat) => toRemoteGroupChatState(chat, chatState(chat.id)));
}

export async function getRemoteGroupChatState(
	chatId: string
): Promise<RemoteGroupChatState | null> {
	const chat = await window.maestro.groupChat.load(chatId);
	if (!chat) return null;
	const messages = await window.maestro.groupChat.getMessages(chatId);
	return toRemoteGroupChatState(chat, chatState(chatId), messages);
}

/**
 * Create a group chat and hand the moderator its opening message.
 *
 * Participants join the way they do when a user types `@name`: the opening
 * message mentions each one and the router adds them with their full agent
 * config (SSH remote, custom args, env). That only works when each name picks
 * out exactly one agent, so an ambiguous name is refused up front rather than
 * letting the router quietly pick the first match.
 */
export async function startRemoteGroupChat(
	topic: string,
	participantIds: string[],
	options: RemoteStartGroupChatOptions = {}
): Promise<{ chatId?: string; error?: string }> {
	const sessions = useSessionStore.getState().sessions;
	const participants = [];
	for (const id of participantIds) {
		const session = sessions.find((s) => s.id === id);
		if (!session) return { error: `Unknown agent: ${id}` };
		if (session.toolType === 'terminal') {
			return { error: `"${session.name}" is a terminal agent and cannot join a group chat` };
		}
		const namesakes = sessions.filter(
			(s) => s.toolType !== 'terminal' && mentionMatches(session.name, s.name)
		);
		if (namesakes.length > 1) {
			return {
				error: `${namesakes.length} agents answer to @${session.name}; rename one so the mention is unambiguous`,
			};
		}
		participants.push(session);
	}
	if (participants.length === 0) return { error: 'At least 1 participant is required' };

	const moderatorAgentId = options.moderatorAgentId ?? participants[0].toolType;
	let chat;
	try {
		chat = await window.maestro.groupChat.create(topic, moderatorAgentId);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { error: message.replace(/^Error invoking remote method '[^']+': /, '') };
	}
	useGroupChatStore.getState().setGroupChats((prev) => [chat, ...prev]);

	const opening = withParticipantMentions(
		options.message ?? topic,
		participants.map((p) => p.name)
	);
	setChatState(chat.id, 'moderator-thinking');
	try {
		await window.maestro.groupChat.sendToModerator(chat.id, opening);
	} catch (err) {
		setChatState(chat.id, 'idle');
		const message = err instanceof Error ? err.message : String(err);
		return { chatId: chat.id, error: `Chat created, but the opening message failed: ${message}` };
	}
	return { chatId: chat.id };
}

/**
 * Send a message into a chat. Refuses (returns false) while the chat is busy:
 * the desktop's own queue only serves the room on screen, and a remote caller
 * can simply retry once the chat reports idle.
 */
export async function sendRemoteGroupChatMessage(
	chatId: string,
	message: string
): Promise<boolean> {
	const chat = await window.maestro.groupChat.load(chatId);
	if (!chat || chatState(chatId) !== 'idle') return false;
	setChatState(chatId, 'moderator-thinking');
	try {
		await window.maestro.groupChat.sendToModerator(chatId, message);
		return true;
	} catch {
		setChatState(chatId, 'idle');
		return false;
	}
}

/**
 * Stop everything a group chat has running: its moderator and participant
 * processes, plus any Auto Run batches it started inside participants' own
 * agents (those are not group-chat processes, so main's stopAll misses them).
 */
export async function stopGroupChatWork(chatId: string): Promise<void> {
	for (const sessionId of getAutoRunSessionsForGroupChat(chatId)) {
		useBatchStore.getState().dispatchBatch({ type: 'COMPLETE_BATCH', sessionId });
	}
	await window.maestro.groupChat.stopAll(chatId);
}
