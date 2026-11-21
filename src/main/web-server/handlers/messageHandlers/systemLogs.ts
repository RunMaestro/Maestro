/**
 * System log WebSocket message handlers.
 *
 * The CLI side of the System Log Viewer: `system_logs_read` is its list (the
 * same in-memory buffer the viewer reads through `logger:getLogs`, with its
 * level, context, and count filters) and `system_logs_clear` is its Clear
 * button. Both call the main-process logger the viewer's IPC handlers call.
 *
 * CLI only. Log entries carry paths, prompts, and error detail; the web
 * interface has the viewer itself and no reason to pull the raw buffer.
 */

import { logger } from '../../../utils/logger';
import { LOG_LEVEL_PRIORITY, type MainLogLevel } from '../../../../shared/logger-types';
import { LOG_CONTEXT } from './shared';
import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';

function isLogLevel(value: unknown): value is MainLogLevel {
	return (
		typeof value === 'string' && Object.prototype.hasOwnProperty.call(LOG_LEVEL_PRIORITY, value)
	);
}

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

/**
 * Handle system_logs_read - the viewer's list. `level` is a floor (warn means
 * warn and error), `since` drops entries older than that epoch-ms instant, and
 * `limit` keeps the newest N after the other filters.
 */
export function handleSystemLogsRead(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const resultType = 'system_logs_read_result';
	if (refuseNonCli(ctx, client, message, resultType)) return;

	if (message.level !== undefined && !isLogLevel(message.level)) {
		ctx.send(client, {
			type: resultType,
			success: false,
			error: `Unknown log level: ${String(message.level)}. Use one of: ${Object.keys(LOG_LEVEL_PRIORITY).join(', ')}`,
			requestId: message.requestId,
		});
		return;
	}

	const since = typeof message.since === 'number' ? message.since : undefined;
	const limit =
		typeof message.limit === 'number' && message.limit > 0 ? Math.floor(message.limit) : undefined;
	let entries = logger.getLogs({
		level: message.level as MainLogLevel | undefined,
		context: typeof message.context === 'string' ? message.context : undefined,
	});
	if (since !== undefined) entries = entries.filter((entry) => entry.timestamp >= since);
	if (limit !== undefined) entries = entries.slice(-limit);

	ctx.send(client, {
		type: resultType,
		success: true,
		entries,
		requestId: message.requestId,
	});
}

/** Handle system_logs_clear - the viewer's Clear button. */
export function handleSystemLogsClear(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const resultType = 'system_logs_clear_result';
	if (refuseNonCli(ctx, client, message, resultType)) return;
	logger.clearLogs();
	ctx.send(client, { type: resultType, success: true, requestId: message.requestId });
}
