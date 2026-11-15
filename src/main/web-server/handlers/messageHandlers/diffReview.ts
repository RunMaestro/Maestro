/**
 * Git Diff review WebSocket message handler.
 *
 * Handles `diff_review_command` - the CLI half of the Git Diff viewer's review
 * comments (`maestro-cli diff-review`). Nothing is decided here: the pending
 * comments live in the renderer's `diffReviewStore`, so this validates the
 * request and forwards it.
 */

import { logger } from '../../../utils/logger';
import { parseDiffReviewCommandRequest } from '../../../../shared/diffReviewCommands';
import { LOG_CONTEXT } from './shared';
import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';

export function handleDiffReviewCommand(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sendResult = (payload: Record<string, unknown>) => {
		ctx.send(client, {
			type: 'diff_review_command_result',
			...payload,
			requestId: message.requestId,
		});
	};

	const parsed = parseDiffReviewCommandRequest(message as Record<string, unknown>);
	if (!parsed.ok) {
		sendResult({ success: false, error: parsed.error });
		return;
	}
	const request = parsed.request;

	logger.info(
		`[Web] Received diff_review_command: action=${request.action}, session=${request.sessionId}`,
		LOG_CONTEXT
	);

	if (!ctx.callbacks.getSessionDetail?.(request.sessionId)) {
		sendResult({ success: false, error: `Session not found: ${request.sessionId}` });
		return;
	}

	if (!ctx.callbacks.diffReviewCommand) {
		sendResult({ success: false, error: 'Diff review is not configured' });
		return;
	}

	ctx.callbacks
		.diffReviewCommand(request)
		.then((result) => sendResult({ ...result }))
		.catch((error) => {
			const detail = error instanceof Error ? error.message : String(error);
			sendResult({ success: false, error: `Diff review ${request.action} failed: ${detail}` });
		});
}
