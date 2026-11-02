/**
 * Closed-tab WebSocket message handler.
 *
 * Handles `closed_tab_command` - the CLI half of Cmd+Shift+T (`maestro-cli
 * tab closed` and `tab reopen`). The live stack is the renderer's, so this
 * validates the request and forwards it to the window that owns the agent.
 */

import { logger } from '../../../utils/logger';
import { parseClosedTabCommandRequest } from '../../../../shared/closedTabCommands';
import { LOG_CONTEXT } from './shared';
import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';

export function handleClosedTabCommand(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sendResult = (payload: Record<string, unknown>) => {
		ctx.send(client, {
			type: 'closed_tab_command_result',
			...payload,
			requestId: message.requestId,
		});
	};

	const parsed = parseClosedTabCommandRequest(message as Record<string, unknown>);
	if (!parsed.ok) {
		sendResult({ success: false, error: parsed.error });
		return;
	}
	const request = parsed.request;

	logger.info(
		`[Web] Received closed_tab_command: action=${request.action}, session=${request.sessionId}, index=${request.index ?? '-'}, tab=${request.tabId ?? '-'}`,
		LOG_CONTEXT
	);

	if (!ctx.callbacks.getSessionDetail?.(request.sessionId)) {
		sendResult({ success: false, error: `Session not found: ${request.sessionId}` });
		return;
	}

	if (!ctx.callbacks.closedTabCommand) {
		sendResult({ success: false, error: 'Reopening closed tabs is not configured' });
		return;
	}

	ctx.callbacks
		.closedTabCommand(request)
		.then((result) => sendResult({ ...result }))
		.catch((error) => {
			const detail = error instanceof Error ? error.message : String(error);
			sendResult({ success: false, error: `Closed-tab ${request.action} failed: ${detail}` });
		});
}
