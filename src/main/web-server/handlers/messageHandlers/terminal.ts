/**
 * Terminal domain WebSocket message handlers.
 *
 * Extracted from WebSocketMessageHandler.ts. Handles: terminal_write, terminal_resize.
 */

import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';

/**
 * Handle terminal_write - write raw data to the terminal PTY
 */
export function handleTerminalWrite(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sessionId = message.sessionId;
	const data = message.data as string | undefined;
	if (!sessionId || typeof data !== 'string') {
		ctx.send(client, {
			type: 'terminal_write_result',
			success: false,
			error: 'Missing sessionId or data',
		});
		return;
	}
	if (client.subscribedSessionId !== sessionId) {
		ctx.send(client, {
			type: 'terminal_write_result',
			success: false,
			error: 'Not subscribed to this session',
		});
		return;
	}
	if (!ctx.callbacks.writeToTerminal) {
		ctx.send(client, {
			type: 'terminal_write_result',
			success: false,
			error: 'writeToTerminal not available',
		});
		return;
	}
	const success = ctx.callbacks.writeToTerminal(sessionId, data);
	ctx.send(client, { type: 'terminal_write_result', success, sessionId });
}

/**
 * Handle terminal_resize - resize the terminal PTY
 */
export function handleTerminalResize(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sessionId = message.sessionId;
	const cols = message.cols as number | undefined;
	const rows = message.rows as number | undefined;
	if (!sessionId || typeof cols !== 'number' || typeof rows !== 'number') {
		ctx.send(client, {
			type: 'terminal_resize_result',
			success: false,
			error: 'Missing sessionId, cols, or rows',
		});
		return;
	}
	if (client.subscribedSessionId !== sessionId) {
		ctx.send(client, {
			type: 'terminal_resize_result',
			success: false,
			error: 'Not subscribed to this session',
		});
		return;
	}
	if (!ctx.callbacks.resizeTerminal) {
		ctx.send(client, {
			type: 'terminal_resize_result',
			success: false,
			error: 'resizeTerminal not available',
		});
		return;
	}
	const success = ctx.callbacks.resizeTerminal(sessionId, cols, rows);
	ctx.send(client, { type: 'terminal_resize_result', success, sessionId });
}
