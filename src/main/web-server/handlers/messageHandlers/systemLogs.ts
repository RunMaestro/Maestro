/**
 * System Log Viewer WebSocket message handlers.
 *
 * Handles: system_logs, system_logs_clear. The CLI's route (`maestro-cli logs`)
 * to `readSystemLogs()` and `clearSystemLogs()`, the same reads and the same
 * clear the System Log Viewer performs.
 */

import { clearSystemLogs, readSystemLogs } from '../../../system-logs';
import { parseSystemLogsQuery } from '../../../../shared/logSources';
import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';

export async function handleSystemLogs(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
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
	clearSystemLogs();
	ctx.send(client, {
		type: 'system_logs_clear_result',
		success: true,
		requestId: message.requestId,
	});
}
