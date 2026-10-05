/**
 * @file groupchat/chat-ops.ts
 * @description The operations a person performs on a whole chat: create it, send into it, stop it,
 * rename it, archive it, delete it.
 *
 * The engine owns ROUNDS (routing, delegation, synthesis); this owns the chat as a thing that
 * exists. Each is the body of a desktop IPC handler (`groupChat:create`, `:delete`, `:archive`,
 * `:rename`, `:stopAll`, `:sendToModerator`) without the desktop's own extras (its Encore gate,
 * its execution queue), so a host with no desktop can offer the same verbs and a chat means the
 * same thing on either.
 *
 * Every one that touches a running round stops the moderator by its full process id and clears the
 * participants, the engine's rule (GD23 a), so nothing keeps working in a room that was told to
 * stop.
 */

import type { GroupChatState, ModeratorConfig } from '../../group-chat-types';
import { logger } from '../host';
import type { GroupChatEngine } from './router';
import type { GroupChatStore } from './storage';
import type { GroupChat, GroupChatEventSink, GroupChatLauncher } from './types';

const LOG_CONTEXT = '[GroupChatOps]';

export interface GroupChatOperationsOptions {
	store: Pick<
		GroupChatStore,
		'createGroupChat' | 'loadGroupChat' | 'updateGroupChat' | 'deleteGroupChat'
	>;
	engine: Pick<
		GroupChatEngine,
		| 'spawnModerator'
		| 'killModerator'
		| 'isModeratorActive'
		| 'clearAllParticipantSessions'
		| 'clearPendingParticipants'
		| 'routeUserMessage'
	>;
	/** How a turn starts. Absent: a message is logged and nothing runs, which a caller words. */
	launcher(): GroupChatLauncher | undefined;
	events: Pick<GroupChatEventSink, 'participantState' | 'stateChange'>;
	/** The room's state as the host tracks it. */
	chatState(chatId: string): GroupChatState;
}

export interface CreateChatInput {
	name: string;
	/** The provider that moderates. */
	moderatorProvider: string;
	moderatorConfig?: ModeratorConfig;
	requireIdleParticipants?: boolean;
}

export interface SendMessageOptions {
	readOnly?: boolean;
	images?: string[];
}

export function createGroupChatOperations(options: GroupChatOperationsOptions) {
	const { store, engine, events } = options;

	/** What stops a process: the runner of the launcher, or nothing when there is none. */
	const control = () => {
		const launcher = options.launcher();
		return launcher
			? { kill: (processId: string) => (launcher.runner.stop(processId), true) }
			: undefined;
	};

	/** Stop the moderator and every participant of `chatId`, and forget what the round was waiting for. */
	async function stopRound(chatId: string): Promise<void> {
		await engine.killModerator(chatId, control());
		await engine.clearAllParticipantSessions(chatId, control());
		// Without this a later message inherits the old pending set and releases the synthesis
		// prematurely when the now-dead processes "respond".
		engine.clearPendingParticipants(chatId);
	}

	/** A chat, with its moderator registered so it is ready for its first message. */
	async function createChat(input: CreateChatInput): Promise<GroupChat> {
		logger.info(`Creating group chat: ${input.name}`, LOG_CONTEXT, {
			moderator: input.moderatorProvider,
		});
		const chat = await store.createGroupChat(
			input.name,
			input.moderatorProvider,
			input.moderatorConfig,
			input.requireIdleParticipants
		);
		// Register the moderator now so the chat is "hot and ready" and shows no pending moderator
		await engine.spawnModerator(chat);
		return (await store.loadGroupChat(chat.id)) ?? chat;
	}

	/** Stop everything a chat has running, then delete it. */
	async function deleteChat(chatId: string): Promise<void> {
		await stopRound(chatId);
		await store.deleteGroupChat(chatId);
	}

	/** Stop everything, and show the room idle with every participant card at rest. */
	async function stopAll(chatId: string): Promise<void> {
		await stopRound(chatId);
		const chat = await store.loadGroupChat(chatId);
		for (const participant of chat?.participants ?? []) {
			events.participantState(chatId, participant.name, 'idle');
		}
		events.stateChange(chatId, 'idle');
	}

	/** Archiving stops the chat's processes: an archived room does not work. */
	async function archiveChat(chatId: string, archived: boolean): Promise<GroupChat> {
		if (archived) await stopRound(chatId);
		return store.updateGroupChat(chatId, { archived });
	}

	function renameChat(chatId: string, name: string): Promise<GroupChat> {
		return store.updateGroupChat(chatId, { name });
	}

	/**
	 * Hand one user message to the moderator. A moderator that is not registered (the chat was
	 * loaded from disk, or its last round ended) is registered first.
	 *
	 * A host that takes a message only when the room is idle checks `chatState` itself: the engine
	 * accepts what it is given, and a stale copy deciding send-versus-queue is how a newer message
	 * overtakes an older one.
	 */
	async function sendUserMessage(
		chatId: string,
		message: string,
		sendOptions: SendMessageOptions = {}
	): Promise<void> {
		if (!engine.isModeratorActive(chatId)) {
			const chat = await store.loadGroupChat(chatId);
			if (!chat) throw new Error(`Group chat not found: ${chatId}`);
			await engine.spawnModerator(chat);
		}
		await engine.routeUserMessage(
			chatId,
			message,
			options.launcher(),
			sendOptions.readOnly,
			sendOptions.images
		);
	}

	return {
		createChat,
		deleteChat,
		stopAll,
		archiveChat,
		renameChat,
		sendUserMessage,
		chatState: options.chatState,
	};
}

export type GroupChatOperations = ReturnType<typeof createGroupChatOperations>;
