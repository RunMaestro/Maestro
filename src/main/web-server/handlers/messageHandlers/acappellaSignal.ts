/**
 * WebRTC signaling over the existing authenticated WebSocket.
 *
 * One message type, `acappella_signal`, whose `payload` is a
 * `SignalingClientMessage`. It rides `/$TOKEN/ws` rather than a port of its own
 * so a paired device inherits the token check, the client registry, and the
 * connection lifecycle that already exist - see
 * `docs/architecture/acappella/decisions/adr-001-webrtc-transport.md`.
 *
 * Everything about who may say what lives in
 * `src/main/acappella/transport/signaling.ts`. This file is the adapter: it
 * finds the transport, gives it a way to write back to this socket, and hands
 * over the payload.
 */

import { getACappellaTransport } from '../../../acappella';
import type { SignalingServerMessage } from '../../../acappella/transport/signaling';
import { ACAPPELLA_SIGNAL_MESSAGE } from '../../../acappella/transport/signaling';
import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';

export { ACAPPELLA_SIGNAL_MESSAGE };

/**
 * Handle one signaling frame.
 *
 * Registration is lazy and idempotent: a browser client that never speaks A
 * Cappella should not cost a signaling session, and a device that does gets one
 * on its first message.
 */
export function handleACappellaSignal(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const transport = getACappellaTransport();
	if (!transport) {
		// A stated refusal rather than silence: a phone that gets no answer cannot
		// tell "the feature is off" from "the network ate it", and only one of those
		// is worth retrying.
		ctx.send(client, {
			type: ACAPPELLA_SIGNAL_MESSAGE,
			payload: {
				op: 'error',
				code: 'not-authenticated',
				message: 'A Cappella is not running on this desktop. Turn it on in Encore Features.',
			},
		});
		return;
	}

	transport.registerClient({
		clientId: client.id,
		send: (payload: SignalingServerMessage) =>
			ctx.send(client, { type: ACAPPELLA_SIGNAL_MESSAGE, payload }),
	});
	void transport.handleSignalMessage(client.id, (message as { payload?: unknown }).payload);
}

/** A socket went away. Tears down its peer and any floor it was holding. */
export function handleACappellaSignalDisconnect(clientId: string): void {
	getACappellaTransport()?.handleClientDisconnect(clientId);
}
