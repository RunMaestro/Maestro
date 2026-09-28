/**
 * Group Chat domain WebSocket message handlers.
 *
 * Extracted from WebSocketMessageHandler.ts. Handles: get_group_chats,
 * start_group_chat, get_group_chat_state, send_group_chat_message, stop_group_chat.
 */

import type { StartGroupChatOptions } from '../../types';
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
			ctx.sendError(client, `Failed to get group chats: ${error.message}`, {
				requestId: message.requestId,
			});
		});
}

/**
 * Handle start_group_chat message - start a new group chat.
 *
 * Validation errors carry the requestId so a CLI caller gets the reason
 * instead of waiting out its command timeout.
 */
export function handleStartGroupChat(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const topic = message.topic as string;
	const participantIds = message.participantIds as string[];
	const reply = { requestId: message.requestId };

	if (!topic || typeof topic !== 'string') {
		ctx.sendError(client, 'Missing or invalid topic', reply);
		return;
	}

	if (
		!Array.isArray(participantIds) ||
		participantIds.length === 0 ||
		participantIds.some((id) => typeof id !== 'string' || !id)
	) {
		ctx.sendError(client, 'At least 1 participant is required', reply);
		return;
	}

	const options: StartGroupChatOptions = {};
	if (typeof message.moderatorAgentId === 'string' && message.moderatorAgentId) {
		options.moderatorAgentId = message.moderatorAgentId;
	}
	if (typeof message.message === 'string' && message.message.trim()) {
		options.message = message.message;
	}

	if (!ctx.callbacks.startGroupChat) {
		ctx.sendError(client, 'Group chat not configured', reply);
		return;
	}

	ctx.callbacks
		.startGroupChat(topic, participantIds, options)
		.then((result) => {
			ctx.send(client, {
				type: 'start_group_chat_result',
				success: !!result?.chatId && !result.error,
				chatId: result?.chatId,
				error: result ? result.error : 'The desktop app did not answer',
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			ctx.sendError(client, `Failed to start group chat: ${error.message}`, reply);
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
		ctx.sendError(client, 'Missing chatId', { requestId: message.requestId });
		return;
	}

	if (!ctx.callbacks.getGroupChatState) {
		ctx.sendError(client, 'Group chat not configured', { requestId: message.requestId });
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
			ctx.sendError(client, `Failed to get group chat state: ${error.message}`, {
				requestId: message.requestId,
			});
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
		ctx.sendError(client, 'Missing chatId', { requestId: message.requestId });
		return;
	}

	if (!chatMessage || typeof chatMessage !== 'string') {
		ctx.sendError(client, 'Missing or invalid message', { requestId: message.requestId });
		return;
	}

	if (!ctx.callbacks.sendGroupChatMessage) {
		ctx.sendError(client, 'Group chat not configured', { requestId: message.requestId });
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
			ctx.sendError(client, `Failed to send group chat message: ${error.message}`, {
				requestId: message.requestId,
			});
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
		ctx.sendError(client, 'Missing chatId', { requestId: message.requestId });
		return;
	}

	if (!ctx.callbacks.stopGroupChat) {
		ctx.sendError(client, 'Group chat not configured', { requestId: message.requestId });
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
			ctx.sendError(client, `Failed to stop group chat: ${error.message}`, {
				requestId: message.requestId,
			});
		});
}
