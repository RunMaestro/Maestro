/**
 * Message-pin WebSocket message handler.
 *
 * Handles `message_pin_command` - the CLI half of message pins (`maestro-cli
 * tab pins ...`). Pins live on the tab in the renderer that owns the agent, so
 * this validates the request and forwards it to that window.
 */

import { logger } from '../../../utils/logger';
import { parseMessagePinCommandRequest } from '../../../../shared/messagePinCommands';
import { LOG_CONTEXT } from './shared';
import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';

export function handleMessagePinCommand(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sendResult = (payload: Record<string, unknown>) => {
		ctx.send(client, {
			type: 'message_pin_command_result',
			...payload,
			requestId: message.requestId,
		});
	};

	const parsed = parseMessagePinCommandRequest(message as Record<string, unknown>);
	if (!parsed.ok) {
		sendResult({ success: false, error: parsed.error });
		return;
	}
	const request = parsed.request;

	logger.info(
		`[Web] Received message_pin_command: action=${request.action}, session=${request.sessionId}, tab=${request.tabId}`,
		LOG_CONTEXT
	);

	if (!ctx.callbacks.getSessionDetail?.(request.sessionId)) {
		sendResult({ success: false, error: `Session not found: ${request.sessionId}` });
		return;
	}

	if (!ctx.callbacks.messagePinCommand) {
		sendResult({ success: false, error: 'Message pins are not configured' });
		return;
	}

	ctx.callbacks
		.messagePinCommand(request)
		.then((result) => sendResult({ ...result }))
		.catch((error) => {
			const detail = error instanceof Error ? error.message : String(error);
			sendResult({ success: false, error: `Pin ${request.action} failed: ${detail}` });
		});
}
