/**
 * Throughput Gauge domain WebSocket message handler.
 *
 * Handles `throughput_gauge_command` - the CLI half of the gauge
 * (`maestro-cli throughput-gauge`): show, hide, toggle, change a setting, reset
 * the peak, or read the live status. Nothing is decided here: the gauge's
 * rates, peak, and visibility live in the primary window's renderer, so this
 * validates the request and forwards it. Validation matters at this hop: a bad
 * `set` patch is refused before it can reach the persisted settings.
 */

import { logger } from '../../../utils/logger';
import { captureException } from '../../../utils/sentry';
import { parseThroughputGaugeCommandRequest } from '../../../../shared/throughputGaugeCommands';
import { LOG_CONTEXT } from './shared';
import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';

export function handleThroughputGaugeCommand(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sendResult = (payload: Record<string, unknown>) => {
		ctx.send(client, {
			type: 'throughput_gauge_command_result',
			...payload,
			requestId: message.requestId,
		});
	};

	const parsed = parseThroughputGaugeCommandRequest(message as Record<string, unknown>);
	if (!parsed.ok) {
		sendResult({ success: false, error: parsed.error });
		return;
	}
	const request = parsed.request;

	logger.info(
		`[Web] Received throughput_gauge_command: action=${request.action}${request.patch ? `, patch=${JSON.stringify(request.patch)}` : ''}`,
		LOG_CONTEXT
	);

	if (!ctx.callbacks.throughputGaugeCommand) {
		sendResult({ success: false, error: 'Throughput Gauge commands are not configured' });
		return;
	}

	ctx.callbacks
		.throughputGaugeCommand(request)
		.then((result) => sendResult({ ...result }))
		.catch((error) => {
			// The renderer round trip resolves every expected failure (timeout, no
			// answer, a malformed reply) to a result, so a rejection is a defect.
			void captureException(error, {
				area: 'web-server',
				handler: 'throughput_gauge_command',
				action: request.action,
			});
			const detail = error instanceof Error ? error.message : String(error);
			sendResult({ success: false, error: `Throughput Gauge ${request.action} failed: ${detail}` });
		});
}
