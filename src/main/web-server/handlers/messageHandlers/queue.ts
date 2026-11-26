/**
 * Queue domain WebSocket message handlers.
 *
 * Extracted from WebSocketMessageHandler.ts. Handles: enqueue_command,
 * list_queue, remove_queue_item, steer_queue_item, set_queue_item_paused,
 * merge_queue_item, edit_queue_item, move_queue_item, send_queue_item_now.
 */

import { logger } from '../../../utils/logger';
import { captureException } from '../../../utils/sentry';
import { getDispatchCallbackRegistry } from '../../../dispatch-callbacks';
import {
	armDispatchCallback,
	readAutoRunCallbackRequest,
	wantsDispatchCallback,
} from './dispatchCallbacks';
import { noteDispatchDelegation } from './agentDelegation';
import { LOG_CONTEXT } from './shared';
import { parseMentionRoutingField } from '../../../../shared/crossAgentContext';
import type {
	WebClient,
	WebClientMessage,
	MessageHandlerCallbacks,
	MessageHandlerContext,
} from './types';
import { dispatchSupervision } from './dispatchSupervision';
import { generateUUID } from '../../../../shared/uuid';
import { newTabAdmission } from './tabs';
import * as pianolaStore from '../../../pianola/pianola-store-main';
import {
	normalizeTurnOverrides,
	parseQueuedTurnEdit,
	readTurnAgentText,
	type TurnAgentText,
} from '../../../../shared/maestro-lib/client/types';
import { resolveToDataUrl } from '../../../storage/session-image-store';
import type { QueuedItemSnapshot, QueueSessionSnapshot } from '../../types';

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
	// Queue Held (`dispatch --queue --held`): queue it paused, even on an idle agent.
	const held = message.held === true;
	const images = Array.isArray(message.images)
		? (message.images as unknown[]).filter((v): v is string => typeof v === 'string')
		: undefined;
	// A Federation client's own tab chips for this one message (`TurnInput.overrides`).
	const turnOverrides = normalizeTurnOverrides(message.turnOverrides);

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

	// A Federation client's agent-only text for this turn (a consult's replies ahead, the
	// `@mention` notes behind), read as the headless host reads it: one this host cannot take
	// refuses the send, never a turn that answers without it.
	const agentContext = readTurnAgentText(message.agentContext, 'agentContext');
	if (!agentContext.ok) {
		sendErrorResult(agentContext.error);
		return;
	}
	const agentNotes = readTurnAgentText(message.agentNotes, 'agentNotes');
	if (!agentNotes.ok) {
		sendErrorResult(agentNotes.error);
		return;
	}
	const agentText: TurnAgentText | undefined =
		agentContext.value || agentNotes.value
			? {
					...(agentContext.value ? { agentContext: agentContext.value } : {}),
					...(agentNotes.value ? { agentNotes: agentNotes.value } : {}),
				}
			: undefined;

	const dispatchId = typeof message.dispatchId === 'string' ? message.dispatchId : generateUUID();
	const coverage = dispatchSupervision(ctx, client, sessionId, dispatchId, requestedTabId);
	if (coverage.managed) {
		const routing = parseMentionRoutingField(message.mentionRouting);
		if (coverage.error || !routing.ok || clientInputMode === 'terminal' || agentText) {
			ctx.send(client, {
				type: 'enqueue_command_result',
				success: false,
				sessionId,
				dispatchId,
				admission: coverage.receipt ? { ...coverage.receipt, outcome: 'rejected' } : undefined,
				error:
					coverage.error ??
					(!routing.ok
						? routing.error
						: agentText
							? 'A supervised dispatch cannot carry agent-only text.'
							: 'Managed queue requires a local AI turn'),
				requestId: message.requestId,
			});
			return;
		}
		// A retry without --tab must retain the original binding even after active-tab changes.
		const targetTabId =
			requestedTabId ??
			pianolaStore.readDispatchAdmission(dispatchId)?.targetTabId ??
			ctx.callbacks.getSessionDetail?.(sessionId)?.activeTabId;
		if (!targetTabId) {
			sendErrorResult('DispatchTargetUnavailable');
			return;
		}
		void newTabAdmission(ctx)
			.runQueue(
				client,
				{
					dispatchId,
					targetAgentId: sessionId,
					targetTabId,
					prompt: command,
					background,
					hidden: false,
					held,
					images,
					mentionRouting: routing.routing,
					callbackIntent: {
						notifyOnComplete: message.notifyOnComplete,
						callbackTab: message.callbackTab,
						callbackTimeout: message.callbackTimeout,
						callbackPrompt: message.callbackPrompt,
					},
				},
				(tabId) => {
					const armed = armDispatchCallback(ctx, message, {
						agentId: sessionId,
						tabId,
						prompt: command,
						isNewTab: false,
						pendingAdmissionId: dispatchId,
					});
					if (armed.error) throw new Error(armed.error);
					return armed.callbackId;
				}
			)
			.then(({ receipt, callbackId, durable }) => {
				ctx.send(client, {
					type: 'enqueue_command_result',
					success: durable,
					durable,
					queuedAccepted: durable,
					queued: durable,
					unknown: !durable,
					sessionId,
					tabId: receipt.targetTabId,
					itemId: receipt.queueItemId,
					dispatchId,
					admission: receipt,
					...(callbackId ? { callbackId } : {}),
					...(!durable
						? {
								error:
									'Queue admission unknown; reconcile with the same dispatchId. Do not resend.',
							}
						: {}),
					requestId: message.requestId,
				});
			})
			.catch((error) => {
				ctx.send(client, {
					type: 'enqueue_command_result',
					success: false,
					sessionId,
					tabId: targetTabId,
					itemId: dispatchId,
					dispatchId,
					unknown:
						!/Dispatch(Intent|Caller|Target)Mismatch|CallerRunUnavailable|InvalidDispatchId|Pianola/.test(
							String(error)
						),
					admission: coverage.receipt
						? {
								...coverage.receipt,
								targetTabId,
								queueItemId: dispatchId,
								outcome:
									/Dispatch(Intent|Caller|Target)Mismatch|CallerRunUnavailable|InvalidDispatchId|Pianola/.test(
										String(error)
									)
										? 'rejected'
										: 'unknown',
							}
						: undefined,
					error: error instanceof Error ? error.message : String(error),
					requestId: message.requestId,
				});
			});
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

	// `dispatch --queue --routing`: refuse a routing that is not one rather than
	// queue the prompt on the wording's routing.
	const routingField = parseMentionRoutingField(message.mentionRouting);
	if (!routingField.ok) {
		sendErrorResult(routingField.error);
		return;
	}

	// Same pre-arm rationale as send_command. A queued prompt can sit behind a
	// predecessor turn for minutes; the entry stays `pending` until OUR
	// process spawns, so the predecessor's exit cannot fire it.
	let enqueueCallbackId: string | undefined;
	// An Auto Run task's dispatch is tracked the same way, but only with a tab
	// to correlate on: without one it is handed over untracked, never refused.
	if (wantsDispatchCallback(message) && (requestedTabId || !readAutoRunCallbackRequest(message))) {
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

	const enqueueArgs: Parameters<MessageHandlerCallbacks['enqueueCommand']> = [
		sessionId,
		command ?? '',
		clientInputMode,
		requestedTabId,
		images,
		background,
		held,
		routingField.routing,
	];
	// The overrides ride after the dispatch-callback and admission slots, which this path leaves
	// empty; the agent-only text rides after the overrides.
	if (turnOverrides || agentText) enqueueArgs.push(undefined, undefined, turnOverrides);
	if (agentText) enqueueArgs.push(agentText);

	ctx.callbacks
		.enqueueCommand(...enqueueArgs)
		.then((result) => {
			if (!result.success) cancelArmedCallback();
			ctx.send(client, {
				type: 'enqueue_command_result',
				success: result.success,
				sessionId,
				...(coverage.receipt
					? {
							dispatchId,
							admission: {
								...coverage.receipt,
								targetTabId: result.tabId,
								queueItemId: result.itemId,
								outcome: result.success ? (result.queued ? 'queued' : 'accepted') : 'rejected',
							},
						}
					: {}),
				...(result.success && enqueueCallbackId ? { callbackId: enqueueCallbackId } : {}),
				...(result.tabId ? { tabId: result.tabId } : {}),
				...(result.queued !== undefined ? { queued: result.queued } : {}),
				...(result.queuePosition !== undefined ? { queuePosition: result.queuePosition } : {}),
				...(result.queueLength !== undefined ? { queueLength: result.queueLength } : {}),
				...(result.itemId ? { itemId: result.itemId } : {}),
				...(result.ran ? { ran: true } : {}),
				...(result.error ? { error: result.error } : {}),
				requestId: message.requestId,
			});
			if (result.success && clientInputMode !== 'terminal') {
				noteDispatchDelegation(ctx, message, {
					targetSessionId: sessionId,
					targetTabId: result.tabId ?? requestedTabId,
					prompt: command ?? '',
					queued: result.queued === true,
				});
			}
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
 * A queue snapshot's images for the client that reads it. A Federation client asks for them
 * (`inlineImages`): each store ref becomes the data URL it names, since the client cannot read this
 * machine's store, and a ref whose file is gone is dropped, as a spawn drops it. Any other reader
 * (`maestro-cli queue list`) gets the items without them, as before.
 */
export async function withQueueImages(
	queues: QueueSessionSnapshot[],
	inline: boolean
): Promise<QueueSessionSnapshot[]> {
	return Promise.all(
		queues.map(async (queue) => ({
			...queue,
			items: await withQueueItemImages(queue.items, inline),
		}))
	);
}

/** One agent's queued items with their images for the client (`withQueueImages()`). */
export async function withQueueItemImages(
	items: QueuedItemSnapshot[],
	inline: boolean
): Promise<QueuedItemSnapshot[]> {
	return Promise.all(
		items.map(async ({ images, ...item }) => {
			if (!inline || !images?.length) return item;
			const resolved = await Promise.all(images.map((image) => resolveToDataUrl(image)));
			const inlined = resolved.filter((image): image is string => image !== null);
			return inlined.length > 0 ? { ...item, images: inlined } : item;
		})
	);
}

/**
 * Handle list_queue message - return a snapshot of the renderer's execution
 * queue(s). Used by `maestro-cli queue list` and a Federation client's queue
 * read. When sessionId is omitted, every session with queued items is returned.
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
		.then(async (result) => {
			const queues = await withQueueImages(result.queues, message.inlineImages === true);
			ctx.send(client, {
				type: 'list_queue_result',
				success: result.success,
				queues,
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

/**
 * Handle steer_queue_item message - steer a queued message into the turn running
 * on its tab, through the SAME renderer path the Steer button uses (the renderer
 * owns the queue removal and the later re-queue). Used by `maestro-cli queue steer`.
 */
export function handleSteerQueueItem(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sessionId = typeof message.sessionId === 'string' ? message.sessionId : '';
	const itemId = typeof message.itemId === 'string' ? message.itemId : '';
	if (!sessionId || !itemId) {
		ctx.send(client, {
			type: 'steer_queue_item_result',
			success: false,
			error: 'Missing sessionId or itemId',
			requestId: message.requestId,
		});
		return;
	}
	if (!ctx.callbacks.steerQueueItem) {
		ctx.send(client, {
			type: 'steer_queue_item_result',
			success: false,
			error: 'Steer queue item not configured',
			requestId: message.requestId,
		});
		return;
	}
	ctx.callbacks
		.steerQueueItem(sessionId, itemId)
		.then((result) => {
			ctx.send(client, {
				type: 'steer_queue_item_result',
				success: result.success,
				...(result.result ? { result: result.result } : {}),
				...(result.error ? { error: result.error } : {}),
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			captureException(error instanceof Error ? error : new Error(String(error)), {
				extra: { area: 'web-server', handler: 'steer_queue_item', sessionId, itemId },
			});
			ctx.send(client, {
				type: 'steer_queue_item_result',
				success: false,
				error: `Failed to steer queue item: ${error.message}`,
				requestId: message.requestId,
			});
		});
}

/**
 * Handle set_queue_item_paused message - hold or resume a queued item, the same
 * flag the queued card's Hold / Resume button flips. Used by
 * `maestro-cli queue hold` and `queue resume`.
 */
export function handleSetQueueItemPaused(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sessionId = typeof message.sessionId === 'string' ? message.sessionId : '';
	const itemId = typeof message.itemId === 'string' ? message.itemId : '';
	const reply = (result: { success: boolean; found: boolean; paused?: boolean; error?: string }) =>
		ctx.send(client, {
			type: 'set_queue_item_paused_result',
			...result,
			requestId: message.requestId,
		});
	if (!sessionId || !itemId || typeof message.paused !== 'boolean') {
		reply({ success: false, found: false, error: 'Missing sessionId, itemId, or paused' });
		return;
	}
	if (!ctx.callbacks.setQueueItemPaused) {
		reply({ success: false, found: false, error: 'Set queue item paused not configured' });
		return;
	}
	const paused = message.paused;
	ctx.callbacks
		.setQueueItemPaused(sessionId, itemId, paused)
		.then((result) =>
			reply({
				success: result.success,
				found: result.found,
				...(result.paused !== undefined ? { paused: result.paused } : {}),
				...(result.error ? { error: result.error } : {}),
			})
		)
		.catch((error) => {
			captureException(error instanceof Error ? error : new Error(String(error)), {
				extra: { area: 'web-server', handler: 'set_queue_item_paused', sessionId, itemId },
			});
			reply({
				success: false,
				found: false,
				error: `Failed to set queue item paused: ${error.message}`,
			});
		});
}

/**
 * Handle merge_queue_item message - fold a queued message into the message above
 * it on the same tab, the same thing the queued card's Merge button does. Used
 * by `maestro-cli queue merge`.
 */
export function handleMergeQueueItem(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sessionId = typeof message.sessionId === 'string' ? message.sessionId : '';
	const itemId = typeof message.itemId === 'string' ? message.itemId : '';
	const reply = (result: {
		success: boolean;
		merged: boolean;
		mergedIntoId?: string;
		error?: string;
	}) =>
		ctx.send(client, {
			type: 'merge_queue_item_result',
			...result,
			requestId: message.requestId,
		});
	if (!sessionId || !itemId) {
		reply({ success: false, merged: false, error: 'Missing sessionId or itemId' });
		return;
	}
	if (!ctx.callbacks.mergeQueueItem) {
		reply({ success: false, merged: false, error: 'Merge queue item not configured' });
		return;
	}
	ctx.callbacks
		.mergeQueueItem(sessionId, itemId)
		.then((result) =>
			reply({
				success: result.success,
				merged: result.merged,
				...(result.mergedIntoId ? { mergedIntoId: result.mergedIntoId } : {}),
				...(result.error ? { error: result.error } : {}),
			})
		)
		.catch((error) => {
			captureException(error instanceof Error ? error : new Error(String(error)), {
				extra: { area: 'web-server', handler: 'merge_queue_item', sessionId, itemId },
			});
			reply({
				success: false,
				merged: false,
				error: `Failed to merge queue item: ${error.message}`,
			});
		});
}

/**
 * Handle edit_queue_item message - rewrite a queued message in place, the same
 * thing the queued card's Edit does. Used by `maestro-cli queue edit` and by a
 * client's hosted queued card.
 */
export function handleEditQueueItem(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sessionId = typeof message.sessionId === 'string' ? message.sessionId : '';
	const itemId = typeof message.itemId === 'string' ? message.itemId : '';
	const reply = (result: { success: boolean; found: boolean; error?: string }) =>
		ctx.send(client, { type: 'edit_queue_item_result', ...result, requestId: message.requestId });
	if (!sessionId || !itemId) {
		reply({ success: false, found: false, error: 'Missing sessionId or itemId' });
		return;
	}
	const parsed = parseQueuedTurnEdit(message);
	if ('error' in parsed) {
		reply({ success: false, found: false, error: parsed.error });
		return;
	}
	if (!ctx.callbacks.editQueueItem) {
		reply({ success: false, found: false, error: 'Edit queue item not configured' });
		return;
	}
	ctx.callbacks
		.editQueueItem(sessionId, itemId, parsed.edit)
		.then(reply)
		.catch((error) => {
			captureException(error instanceof Error ? error : new Error(String(error)), {
				extra: { area: 'web-server', handler: 'edit_queue_item', sessionId, itemId },
			});
			reply({
				success: false,
				found: false,
				error: `Failed to edit queue item: ${error.message}`,
			});
		});
}

/**
 * Handle move_queue_item message - move a queued item to another place, the same
 * thing the queued card's drag does. Used by `maestro-cli queue move` and by a
 * client's hosted queued card. With `tabId`, `toIndex` counts that tab's items only.
 */
export function handleMoveQueueItem(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sessionId = typeof message.sessionId === 'string' ? message.sessionId : '';
	const itemId = typeof message.itemId === 'string' ? message.itemId : '';
	const tabId = typeof message.tabId === 'string' && message.tabId ? message.tabId : undefined;
	const toIndex = message.toIndex;
	const reply = (result: { success: boolean; moved: boolean; error?: string }) =>
		ctx.send(client, { type: 'move_queue_item_result', ...result, requestId: message.requestId });
	if (!sessionId || !itemId) {
		reply({ success: false, moved: false, error: 'Missing sessionId or itemId' });
		return;
	}
	if (typeof toIndex !== 'number' || !Number.isInteger(toIndex) || toIndex < 0) {
		reply({ success: false, moved: false, error: 'toIndex must be a whole number, 0 or more' });
		return;
	}
	if (!ctx.callbacks.moveQueueItem) {
		reply({ success: false, moved: false, error: 'Move queue item not configured' });
		return;
	}
	ctx.callbacks
		.moveQueueItem(sessionId, itemId, toIndex, tabId)
		.then(reply)
		.catch((error) => {
			captureException(error instanceof Error ? error : new Error(String(error)), {
				extra: { area: 'web-server', handler: 'move_queue_item', sessionId, itemId },
			});
			reply({
				success: false,
				moved: false,
				error: `Failed to move queue item: ${error.message}`,
			});
		});
}

/**
 * Handle send_queue_item_now message - run a queued item now instead of in its
 * turn, the same thing the queued card's Force Send does. Used by
 * `maestro-cli queue send-now` and by a client's hosted queued card.
 */
export function handleSendQueueItemNow(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sessionId = typeof message.sessionId === 'string' ? message.sessionId : '';
	const itemId = typeof message.itemId === 'string' ? message.itemId : '';
	const reply = (result: { success: boolean; sent: boolean; error?: string }) =>
		ctx.send(client, {
			type: 'send_queue_item_now_result',
			...result,
			requestId: message.requestId,
		});
	if (!sessionId || !itemId) {
		reply({ success: false, sent: false, error: 'Missing sessionId or itemId' });
		return;
	}
	if (!ctx.callbacks.sendQueueItemNow) {
		reply({ success: false, sent: false, error: 'Send queue item now not configured' });
		return;
	}
	ctx.callbacks
		.sendQueueItemNow(sessionId, itemId)
		.then(reply)
		.catch((error) => {
			captureException(error instanceof Error ? error : new Error(String(error)), {
				extra: { area: 'web-server', handler: 'send_queue_item_now', sessionId, itemId },
			});
			reply({
				success: false,
				sent: false,
				error: `Failed to send queue item now: ${error.message}`,
			});
		});
}
