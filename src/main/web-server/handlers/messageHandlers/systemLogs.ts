/**
 * System Log Viewer WebSocket message handlers.
 *
 * Handles: system_logs, system_logs_clear. The CLI's route (`maestro-cli logs`)
 * to `readSystemLogs()` and `clearSystemLogs()`, the same reads and the same
 * clear the System Log Viewer performs.
 *
 * CLI only. Log entries carry paths, prompts, and error detail; the web
 * interface has the viewer itself and no reason to pull the raw buffer.
 */

import { clearSystemLogs, readSystemLogs } from '../../../system-logs';
import { logger } from '../../../utils/logger';
import { parseSystemLogsQuery } from '../../../../shared/logSources';
import { LOG_CONTEXT } from './shared';
import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';

function refuseNonCli(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage,
	resultType: string
): boolean {
	if (client.cli) return false;
	logger.warn(`Refused ${message.type} from non-CLI client ${client.id}`, LOG_CONTEXT);
	ctx.send(client, {
		type: resultType,
		success: false,
		error: 'The system log is available to maestro-cli only',
		requestId: message.requestId,
	});
	return true;
}

export async function handleSystemLogs(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	if (refuseNonCli(ctx, client, message, 'system_logs_result')) return;

	const parsed = parseSystemLogsQuery((message as { query?: unknown }).query);
	if ('error' in parsed) {
		ctx.send(client, {
			type: 'system_logs_result',
			success: false,
			error: parsed.error,
			requestId: message.requestId,
		});
		return;
	}
	try {
		const result = await readSystemLogs(parsed.query);
		ctx.send(client, {
			type: 'system_logs_result',
			success: true,
			result,
			requestId: message.requestId,
		});
	} catch (error) {
		ctx.send(client, {
			type: 'system_logs_result',
			success: false,
			error: `Failed to read the system logs: ${error instanceof Error ? error.message : String(error)}`,
			requestId: message.requestId,
		});
	}
}

export function handleSystemLogsClear(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	if (refuseNonCli(ctx, client, message, 'system_logs_clear_result')) return;

	clearSystemLogs();
	ctx.send(client, {
		type: 'system_logs_clear_result',
		success: true,
		requestId: message.requestId,
	});
}
