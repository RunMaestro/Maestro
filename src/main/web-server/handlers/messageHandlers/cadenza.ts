/**
 * Cadenza domain WebSocket message handlers.
 *
 * Extracted from WebSocketMessageHandler.ts. Handles: cadenza.
 */

import {
	CADENZA_OPS,
	CADENZA_VIEW_TYPES,
	CADENZA_COLORS,
	type CadenzaPayload,
	type CadenzaOp,
	type CadenzaViewType,
	type CadenzaColor,
} from '../../../../shared/cadenza-types';
import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';

/**
 * Handle cadenza - open/update/close a small agent-driven cadenza view.
 * Validates the op/id/viewType/color, then hands a typed payload to the
 * renderer via the cadenzaView callback (the `remote:cadenza` channel).
 */
export function handleCadenza(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const op = typeof message.op === 'string' ? (message.op as CadenzaOp) : undefined;
	const id = typeof message.id === 'string' ? message.id : '';

	const sendResult = (success: boolean, error?: string) => {
		ctx.send(client, {
			type: 'cadenza_result',
			success,
			error,
			requestId: message.requestId,
		});
	};

	if (!op || !CADENZA_OPS.includes(op)) {
		sendResult(false, `Invalid or missing op. Must be one of: ${CADENZA_OPS.join(', ')}`);
		return;
	}
	if (!id) {
		sendResult(false, 'Missing cadenza id');
		return;
	}

	let viewType: CadenzaViewType | undefined;
	const rawViewType = typeof message.viewType === 'string' ? message.viewType : undefined;
	if (rawViewType !== undefined) {
		if (!CADENZA_VIEW_TYPES.includes(rawViewType as CadenzaViewType)) {
			sendResult(
				false,
				`Invalid viewType: ${rawViewType}. Must be one of: ${CADENZA_VIEW_TYPES.join(', ')}`
			);
			return;
		}
		viewType = rawViewType as CadenzaViewType;
	}
	if (op === 'open' && !viewType) {
		sendResult(false, `op 'open' requires a viewType (${CADENZA_VIEW_TYPES.join(' | ')})`);
		return;
	}

	let color: CadenzaColor | undefined;
	const rawColor = typeof message.color === 'string' ? message.color : undefined;
	if (rawColor !== undefined) {
		if (!CADENZA_COLORS.includes(rawColor as CadenzaColor)) {
			sendResult(false, `Invalid color: ${rawColor}. Must be one of: ${CADENZA_COLORS.join(', ')}`);
			return;
		}
		color = rawColor as CadenzaColor;
	}

	// Decision buttons: keep only well-formed { label, value } string pairs.
	const options = Array.isArray(message.options)
		? (message.options as unknown[]).filter(
				(o): o is { label: string; value: string } =>
					!!o &&
					typeof o === 'object' &&
					typeof (o as { label?: unknown }).label === 'string' &&
					typeof (o as { value?: unknown }).value === 'string'
			)
		: undefined;

	const payload: CadenzaPayload = {
		op,
		id,
		viewType,
		title: typeof message.title === 'string' ? message.title : undefined,
		body: typeof message.body === 'string' ? message.body : undefined,
		path: typeof message.path === 'string' ? message.path : undefined,
		options: options && options.length > 0 ? options : undefined,
		color,
		sessionId: typeof message.sessionId === 'string' ? message.sessionId : undefined,
	};

	if (!ctx.callbacks.cadenzaView) {
		sendResult(false, 'Cadenza views not configured');
		return;
	}

	ctx.callbacks
		.cadenzaView(payload)
		.then((success) => sendResult(success, success ? undefined : 'Failed to update cadenza view'))
		.catch((error) => sendResult(false, `Failed to update cadenza view: ${error.message}`));
}
