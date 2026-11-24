/**
 * Voice control over the WebSocket bridge.
 *
 * Handles: voice_control. This is `maestro-cli voice`'s route to
 * `runVoiceControlRequest()`, whose handlers are the bodies of the Voice HUD's
 * and the Voice settings' buttons, so a session started from a terminal and one
 * started from the header pill are the same session.
 *
 * A refusal (voice is switched off, a turn is in flight, no device has that
 * id) is a successful round trip with the reason in `reply`; only a thrown
 * error is a failed one.
 */

import { runVoiceControlRequest } from '../../../acappella/voice-control-service';
import { VOICE_CONTROL_MESSAGE } from '../../../../shared/acappella/voice-control';
import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';

export { VOICE_CONTROL_MESSAGE };

export async function handleVoiceControl(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	const type = `${VOICE_CONTROL_MESSAGE}_result`;
	// A voice credential is a secret a browser on the bridge has no business
	// writing or probing. `maestro-cli` proves itself with the CLI secret.
	if (!client.cli) {
		ctx.send(client, {
			type,
			success: false,
			error: 'Voice control is only available to maestro-cli',
			requestId: message.requestId,
		});
		return;
	}
	try {
		const reply = await runVoiceControlRequest(message.request);
		ctx.send(client, { type, success: true, reply, requestId: message.requestId });
	} catch (error) {
		const errMsg = error instanceof Error ? error.message : String(error);
		ctx.send(client, { type, success: false, error: errMsg, requestId: message.requestId });
	}
}
