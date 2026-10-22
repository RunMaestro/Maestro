/**
 * Auto Run steering WebSocket message handler.
 *
 * Handles `auto_run_steering_command` - the CLI half of the Thought Stream's
 * Steer Auto Run bar (`maestro-cli steer-auto-run`). One message carrying an
 * `action` rather than three, for the reason `snooze.ts` gives: the verbs differ
 * only in which fields they carry.
 *
 * Nothing is decided here. Steering notes are renderer state, held by the client
 * whose run loop will read them, so this validates the request and forwards it.
 * Validation still matters at this hop: an over-long note is refused rather than
 * cut to fit, because the caller cannot see a truncation the way someone typing
 * into the panel can.
 */

import { logger } from '../../../utils/logger';
import { parseSteeringCommandRequest } from '../../../../shared/autoRunSteeringCommands';
import { LOG_CONTEXT } from './shared';
import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';

export function handleAutoRunSteeringCommand(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sendResult = (payload: Record<string, unknown>) => {
		ctx.send(client, {
			type: 'auto_run_steering_command_result',
			...payload,
			requestId: message.requestId,
		});
	};

	const parsed = parseSteeringCommandRequest(message as Record<string, unknown>);
	if (!parsed.ok) {
		sendResult({ success: false, error: parsed.error });
		return;
	}
	const request = parsed.request;

	// The note text is the operator's instruction to an agent; it stays out of
	// the log, which names only what was asked for.
	logger.info(
		`[Web] Received auto_run_steering_command: action=${request.action}, session=${request.sessionId}`,
		LOG_CONTEXT
	);

	// Reject an unknown agent here rather than letting the renderer answer
	// "nothing is running" for a request that was never addressable.
	if (!ctx.callbacks.getSessionDetail?.(request.sessionId)) {
		sendResult({ success: false, error: `Session not found: ${request.sessionId}` });
		return;
	}

	if (!ctx.callbacks.autoRunSteeringCommand) {
		sendResult({ success: false, error: 'Auto Run steering is not configured' });
		return;
	}

	ctx.callbacks
		.autoRunSteeringCommand(request)
		.then((result) => sendResult({ ...result }))
		.catch((error) => {
			const detail = error instanceof Error ? error.message : String(error);
			sendResult({ success: false, error: `Steering ${request.action} failed: ${detail}` });
		});
}
