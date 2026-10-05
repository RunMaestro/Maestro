import { useCallback, useEffect, useState } from 'react';
import {
	emptyGroupChat,
	mergeGroupChatLines,
	reduceGroupChat,
	type GroupChatEvent,
	type GroupChatRecord,
	type MaestroClient,
} from '../../shared/maestro-lib';

/** A chat as events have built it, with what a screen needs to know about how current it is. */
export interface LiveGroupChat {
	chat: GroupChatRecord;
	/** The `at` of the newest event folded in. 0 before any. */
	eventAt: number;
	/** Events were missed: the chat must be read again before it can be trusted. */
	stale: boolean;
}

/**
 * Lay a chat read from the host over what events already built. The read is a
 * snapshot taken at `readAt`; an event stamped after that is newer than the
 * snapshot's state, so the live state and roster win. Lines are a union either
 * way, because a line seen twice is one line.
 */
export function seedLiveChat(
	existing: LiveGroupChat | undefined,
	snapshot: GroupChatRecord,
	readAt: number
): LiveGroupChat {
	if (!existing) return { chat: snapshot, eventAt: 0, stale: false };
	const newer = existing.eventAt > readAt;
	return {
		chat: {
			...snapshot,
			lines: mergeGroupChatLines(snapshot.lines, existing.chat.lines),
			...(newer
				? {
						state: existing.chat.state,
						working: existing.chat.working,
						participants:
							existing.chat.participants.length > 0
								? existing.chat.participants
								: snapshot.participants,
					}
				: {}),
		},
		eventAt: existing.eventAt,
		stale: false,
	};
}

export function applyLiveEvent(
	existing: LiveGroupChat | undefined,
	chatId: string,
	event: GroupChatEvent
): LiveGroupChat {
	const held = existing ?? { chat: emptyGroupChat(chatId), eventAt: 0, stale: false };
	if (event.kind === 'gap') return { ...held, stale: true };
	return { chat: reduceGroupChat(held.chat, event), eventAt: event.at, stale: held.stale };
}

export interface GroupChatLiveStore {
	live: Readonly<Record<string, LiveGroupChat>>;
	/** Fold a chat read from the host into the live one. `readAt` is when the read began. */
	seed(chat: GroupChatRecord, readAt: number): void;
	/** Forget a chat: it was deleted. */
	drop(chatId: string): void;
}

/**
 * The group chats on the host, by id, folded as their events arrive. It listens
 * for every chat for as long as the App is up, not only while a screen is open,
 * so a chat opened halfway through a round already holds the lines that landed.
 * A chat is whole only after `seed`: until then it holds events alone.
 */
export function useGroupChats(client: MaestroClient | undefined): GroupChatLiveStore {
	const [live, setLive] = useState<Readonly<Record<string, LiveGroupChat>>>({});

	useEffect(() => {
		if (!client) return;
		return client.events.subscribe(
			(event) => {
				if (event.type !== 'groupChat') return;
				setLive((current) => ({
					...current,
					[event.chatId]: applyLiveEvent(current[event.chatId], event.chatId, event.event),
				}));
			},
			{ types: ['groupChat'] }
		);
	}, [client]);

	const seed = useCallback((chat: GroupChatRecord, readAt: number) => {
		setLive((current) => ({ ...current, [chat.id]: seedLiveChat(current[chat.id], chat, readAt) }));
	}, []);

	const drop = useCallback((chatId: string) => {
		setLive((current) => {
			if (!(chatId in current)) return current;
			const { [chatId]: _gone, ...rest } = current;
			return rest;
		});
	}, []);

	return { live, seed, drop };
}
