/**
 * Tab Windows domain WebSocket message handler.
 *
 * Handles `tab_window_command` - the CLI half of Tab Windows (`maestro-cli tab
 * pop-out`, `tab dock`, `tab windows`, TW-12). Nothing is decided here: the
 * callback resolves the owning agent, answers `list` from the window registry,
 * and forwards `pop-out` / `dock` to the agent's owner window, so this
 * validates the request and forwards it.
 */

import { logger } from '../../../utils/logger';
import { parseTabWindowCommandRequest } from '../../../../shared/tabWindowCommands';
import { LOG_CONTEXT } from './shared';
import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';

export function handleTabWindowCommand(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sendResult = (payload: Record<string, unknown>) => {
		ctx.send(client, {
			type: 'tab_window_command_result',
			...payload,
			requestId: message.requestId,
		});
	};

	const parsed = parseTabWindowCommandRequest(message as Record<string, unknown>);
	if (!parsed.ok) {
		sendResult({ success: false, error: parsed.error });
		return;
	}
	const request = parsed.request;

	logger.info(
		`[Web] Received tab_window_command: action=${request.action}, session=${request.sessionId ?? '-'}, tab=${request.tabId ?? '-'}`,
		LOG_CONTEXT
	);

	if (!ctx.callbacks.tabWindowCommand) {
		sendResult({ success: false, error: 'Tab windows are not configured' });
		return;
	}

	ctx.callbacks
		.tabWindowCommand(request)
		.then((result) => sendResult({ ...result }))
		.catch((error) => {
			const detail = error instanceof Error ? error.message : String(error);
			sendResult({ success: false, error: `Tab ${request.action} failed: ${detail}` });
		});
}
