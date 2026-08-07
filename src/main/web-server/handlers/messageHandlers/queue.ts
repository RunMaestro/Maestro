/**
 * Queue domain WebSocket message handlers.
 *
 * Extracted from WebSocketMessageHandler.ts. Handles: enqueue_command,
 * list_queue, remove_queue_item.
 */

import { logger } from '../../../utils/logger';
import { captureException } from '../../../utils/sentry';
import { getDispatchCallbackRegistry } from '../../../dispatch-callbacks';
import { armDispatchCallback } from './dispatchCallbacks';
import { LOG_CONTEXT } from './shared';
import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';

/**
 * Handle enqueue_command message - hand a CLI prompt to the renderer's
 * authoritative execution queue. When the target session is busy the prompt
 * is appended to `session.executionQueue` (FIFO); when idle it is dispatched
 * immediately through the same path as a plain send. Used by
 * `maestro-cli dispatch --queue`. Unlike `send_command`, this never rejects a
 * busy target: waiting in line is the whole point of the mode.
 */
export function handleEnqueueCommand(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sessionId = typeof message.sessionId === 'string' ? message.sessionId : '';
	const command = typeof message.command === 'string' ? message.command : '';
	const clientInputMode = message.inputMode as 'ai' | 'terminal' | undefined;
	const requestedTabId = typeof message.tabId === 'string' ? message.tabId : undefined;
	const background = message.background === true;
	const images = Array.isArray(message.images)
		? (message.images as unknown[]).filter((v): v is string => typeof v === 'string')
		: undefined;

	logger.info(
		`[Web] Received enqueue_command: session=${sessionId}, tab=${requestedTabId ?? 'active'}, commandLen=${command.length}, images=${images?.length ?? 0}`,
		LOG_CONTEXT
	);

	const sendErrorResult = (error: string) => {
		ctx.send(client, {
			type: 'enqueue_command_result',
			success: false,
			error,
			sessionId,
			requestId: message.requestId,
		});
	};

	const hasImages = !!images && images.length > 0;
	if (!sessionId || (!command && !hasImages)) {
		sendErrorResult('Missing sessionId or command');
		return;
	}

	if (!ctx.callbacks.getSessionDetail?.(sessionId)) {
		sendErrorResult('Session not found');
		return;
	}

	if (!ctx.callbacks.enqueueCommand) {
		sendErrorResult('Enqueue not configured');
		return;
	}

	// Same pre-arm rationale as send_command. A queued prompt can sit behind a
	// predecessor turn for minutes; the entry stays `pending` until OUR
	// process spawns, so the predecessor's exit cannot fire it.
	let enqueueCallbackId: string | undefined;
	if (typeof message.notifyOnComplete === 'string' && message.notifyOnComplete) {
		if (!requestedTabId) {
			sendErrorResult('--notify-on-complete requires an explicit target tab');
			return;
		}
		const armed = armDispatchCallback(ctx, message, {
			agentId: sessionId,
			tabId: requestedTabId,
			prompt: command ?? '',
			isNewTab: false,
		});
		if (armed.error) {
			sendErrorResult(armed.error);
			return;
		}
		enqueueCallbackId = armed.callbackId;
	}
	const cancelArmedCallback = () => {
		if (enqueueCallbackId) getDispatchCallbackRegistry()?.cancel(enqueueCallbackId);
	};

	ctx.callbacks
		.enqueueCommand(sessionId, command ?? '', clientInputMode, requestedTabId, images, background)
		.then((result) => {
			if (!result.success) cancelArmedCallback();
			ctx.send(client, {
				type: 'enqueue_command_result',
				success: result.success,
				sessionId,
				...(result.success && enqueueCallbackId ? { callbackId: enqueueCallbackId } : {}),
				...(result.tabId ? { tabId: result.tabId } : {}),
				...(result.queued !== undefined ? { queued: result.queued } : {}),
				...(result.queuePosition !== undefined ? { queuePosition: result.queuePosition } : {}),
				...(result.queueLength !== undefined ? { queueLength: result.queueLength } : {}),
				...(result.itemId ? { itemId: result.itemId } : {}),
				...(result.error ? { error: result.error } : {}),
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			cancelArmedCallback();
			captureException(error instanceof Error ? error : new Error(String(error)), {
				extra: { area: 'web-server', handler: 'enqueue_command', sessionId },
			});
			sendErrorResult(`Failed to enqueue command: ${error.message}`);
		});
}

/**
 * Handle list_queue message - return a snapshot of the renderer's execution
 * queue(s). Used by `maestro-cli queue list`. When sessionId is omitted, every
 * session with queued items is returned.
 */
export function handleListQueue(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sessionId = typeof message.sessionId === 'string' ? message.sessionId : undefined;
	if (!ctx.callbacks.listQueue) {
		ctx.send(client, {
			type: 'list_queue_result',
			success: false,
			queues: [],
			error: 'List queue not configured',
			requestId: message.requestId,
		});
		return;
	}
	ctx.callbacks
		.listQueue(sessionId)
		.then((result) => {
			ctx.send(client, {
				type: 'list_queue_result',
				success: result.success,
				queues: result.queues,
				...(result.error ? { error: result.error } : {}),
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			captureException(error instanceof Error ? error : new Error(String(error)), {
				extra: { area: 'web-server', handler: 'list_queue', sessionId },
			});
			ctx.send(client, {
				type: 'list_queue_result',
				success: false,
				queues: [],
				error: `Failed to list queue: ${error.message}`,
				requestId: message.requestId,
			});
		});
}

/**
 * Handle remove_queue_item message - drop a queued item by id from the
 * renderer's execution queue. Used by `maestro-cli queue remove`.
 */
export function handleRemoveQueueItem(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sessionId = typeof message.sessionId === 'string' ? message.sessionId : '';
	const itemId = typeof message.itemId === 'string' ? message.itemId : '';
	if (!sessionId || !itemId) {
		ctx.send(client, {
			type: 'remove_queue_item_result',
			success: false,
			removed: false,
			error: 'Missing sessionId or itemId',
			requestId: message.requestId,
		});
		return;
	}
	if (!ctx.callbacks.removeQueueItem) {
		ctx.send(client, {
			type: 'remove_queue_item_result',
			success: false,
			removed: false,
			error: 'Remove queue item not configured',
			requestId: message.requestId,
		});
		return;
	}
	ctx.callbacks
		.removeQueueItem(sessionId, itemId)
		.then((result) => {
			ctx.send(client, {
				type: 'remove_queue_item_result',
				success: result.success,
				removed: result.removed,
				...(result.error ? { error: result.error } : {}),
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			captureException(error instanceof Error ? error : new Error(String(error)), {
				extra: { area: 'web-server', handler: 'remove_queue_item', sessionId, itemId },
			});
			ctx.send(client, {
				type: 'remove_queue_item_result',
				success: false,
				removed: false,
				error: `Failed to remove queue item: ${error.message}`,
				requestId: message.requestId,
			});
		});
}
