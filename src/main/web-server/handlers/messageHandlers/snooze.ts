/**
 * Snooze domain WebSocket message handler.
 *
 * Handles `snooze_command` - the CLI half of the snooze UI (`maestro-cli
 * snooze`). One message carrying an `action` rather than six, because the six
 * verbs differ only in which id they name and six parallel callbacks would be
 * six chances to drift from the click path each mirrors.
 *
 * Nothing is decided here: snooze state lives authoritatively in the renderer's
 * session store, so this validates the request and forwards it. Validation
 * still matters at this hop - a `snooze` with no `wakeAt` would park a tab with
 * a wake instant that never comes due, and the tab would simply be gone.
 */

import { logger } from '../../../utils/logger';
import { parseSnoozeCommandRequest } from '../../../../shared/snoozeCommands';
import { LOG_CONTEXT } from './shared';
import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';

export function handleSnoozeCommand(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sendResult = (payload: Record<string, unknown>) => {
		ctx.send(client, { type: 'snooze_command_result', ...payload, requestId: message.requestId });
	};

	const parsed = parseSnoozeCommandRequest(message as Record<string, unknown>);
	if (!parsed.ok) {
		sendResult({ success: false, error: parsed.error });
		return;
	}
	const request = parsed.request;

	logger.info(
		`[Web] Received snooze_command: action=${request.action}, session=${request.sessionId ?? 'all'}, target=${request.targetId ?? '-'}`,
		LOG_CONTEXT
	);

	// A write names its agent, so reject an unknown one here rather than letting
	// the renderer answer "not found" for a request that was never addressable.
	if (request.sessionId && !ctx.callbacks.getSessionDetail?.(request.sessionId)) {
		sendResult({ success: false, error: `Session not found: ${request.sessionId}` });
		return;
	}

	if (!ctx.callbacks.snoozeCommand) {
		sendResult({ success: false, error: 'Snooze is not configured' });
		return;
	}

	ctx.callbacks
		.snoozeCommand(request)
		.then((result) => sendResult({ ...result }))
		.catch((error) => {
			const detail = error instanceof Error ? error.message : String(error);
			sendResult({ success: false, error: `Snooze ${request.action} failed: ${detail}` });
		});
}
