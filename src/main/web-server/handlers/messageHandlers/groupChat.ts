/**
 * Group Chat domain WebSocket message handlers.
 *
 * Extracted from WebSocketMessageHandler.ts. Handles: get_group_chats,
 * start_group_chat, get_group_chat_state, send_group_chat_message, stop_group_chat.
 */

import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';

/**
 * Handle get_group_chats message - return list of all group chats
 */
export function handleGetGroupChats(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	if (!ctx.callbacks.getGroupChats) {
		ctx.sendError(client, 'Group chats not configured');
		return;
	}

	ctx.callbacks
		.getGroupChats()
		.then((chats) => {
			ctx.send(client, {
				type: 'group_chats_list',
				chats,
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			ctx.sendError(client, `Failed to get group chats: ${error.message}`);
		});
}

/**
 * Handle start_group_chat message - start a new group chat
 */
export function handleStartGroupChat(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const topic = message.topic as string;
	const participantIds = message.participantIds as string[];

	if (!topic || typeof topic !== 'string') {
		ctx.sendError(client, 'Missing or invalid topic');
		return;
	}

	if (!participantIds || !Array.isArray(participantIds) || participantIds.length < 2) {
		ctx.sendError(client, 'At least 2 participants are required');
		return;
	}

	if (!ctx.callbacks.startGroupChat) {
		ctx.sendError(client, 'Group chat not configured');
		return;
	}

	ctx.callbacks
		.startGroupChat(topic, participantIds)
		.then((result) => {
			ctx.send(client, {
				type: 'start_group_chat_result',
				success: !!result,
				chatId: result?.chatId,
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			ctx.sendError(client, `Failed to start group chat: ${error.message}`);
		});
}

/**
 * Handle get_group_chat_state message - get state of a specific group chat
 */
export function handleGetGroupChatState(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const chatId = message.chatId as string;

	if (!chatId) {
		ctx.sendError(client, 'Missing chatId');
		return;
	}

	if (!ctx.callbacks.getGroupChatState) {
		ctx.sendError(client, 'Group chat not configured');
		return;
	}

	ctx.callbacks
		.getGroupChatState(chatId)
		.then((state) => {
			ctx.send(client, {
				type: 'group_chat_state',
				chatId,
				state,
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			ctx.sendError(client, `Failed to get group chat state: ${error.message}`);
		});
}

/**
 * Handle send_group_chat_message message - send a message to a group chat
 */
export function handleSendGroupChatMessage(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const chatId = message.chatId as string;
	const chatMessage = message.message as string;

	if (!chatId) {
		ctx.sendError(client, 'Missing chatId');
		return;
	}

	if (!chatMessage || typeof chatMessage !== 'string') {
		ctx.sendError(client, 'Missing or invalid message');
		return;
	}

	if (!ctx.callbacks.sendGroupChatMessage) {
		ctx.sendError(client, 'Group chat not configured');
		return;
	}

	ctx.callbacks
		.sendGroupChatMessage(chatId, chatMessage)
		.then((success) => {
			ctx.send(client, {
				type: 'send_group_chat_message_result',
				success,
				chatId,
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			ctx.sendError(client, `Failed to send group chat message: ${error.message}`);
		});
}

/**
 * Handle stop_group_chat message - stop an active group chat
 */
export function handleStopGroupChat(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const chatId = message.chatId as string;

	if (!chatId) {
		ctx.sendError(client, 'Missing chatId');
		return;
	}

	if (!ctx.callbacks.stopGroupChat) {
		ctx.sendError(client, 'Group chat not configured');
		return;
	}

	ctx.callbacks
		.stopGroupChat(chatId)
		.then((success) => {
			ctx.send(client, {
				type: 'stop_group_chat_result',
				success,
				chatId,
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			ctx.sendError(client, `Failed to stop group chat: ${error.message}`);
		});
}
