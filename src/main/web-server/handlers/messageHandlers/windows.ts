/**
 * Windows domain WebSocket message handler.
 *
 * Handles `window_command` - the CLI half of the multi-window UI (`maestro-cli
 * window`): list the open windows, or move an agent or a whole group between
 * them. Nothing is decided here: window ownership moves are orchestrated by the
 * primary window's WindowContext, so this validates the request and forwards it.
 */

import { logger } from '../../../utils/logger';
import { parseWindowCommandRequest } from '../../../../shared/windowCommands';
import { LOG_CONTEXT } from './shared';
import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';

export function handleWindowCommand(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sendResult = (payload: Record<string, unknown>) => {
		ctx.send(client, { type: 'window_command_result', ...payload, requestId: message.requestId });
	};

	const parsed = parseWindowCommandRequest(message as Record<string, unknown>);
	if (!parsed.ok) {
		sendResult({ success: false, error: parsed.error });
		return;
	}
	const request = parsed.request;

	logger.info(
		`[Web] Received window_command: action=${request.action}, target=${request.targetId ?? '-'}, to=${request.to ?? '-'}`,
		LOG_CONTEXT
	);

	if (!ctx.callbacks.windowCommand) {
		sendResult({ success: false, error: 'Window commands are not configured' });
		return;
	}

	ctx.callbacks
		.windowCommand(request)
		.then((result) => sendResult({ ...result }))
		.catch((error) => {
			const detail = error instanceof Error ? error.message : String(error);
			sendResult({ success: false, error: `Window ${request.action} failed: ${detail}` });
		});
}
