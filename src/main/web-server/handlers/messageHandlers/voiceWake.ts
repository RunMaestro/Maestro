/**
 * Wake phrase enrollment over the WebSocket bridge.
 *
 * Handles: voice_wake_enrollment. This is `maestro-cli voice wake`'s route to
 * `runWakeEnrollmentRequest()`, the same function the `acappella:wake-enrollment`
 * IPC channel calls, so a recording started from a terminal and one started
 * from Settings > Voice Controls are the same recording, on the same
 * microphone, under the same rules about who may borrow it.
 *
 * A refusal (a voice session holds the microphone, there are too few
 * recordings to train from, voice is switched off) is a successful round trip
 * with the reason in `reply`; only a thrown error is a failed one.
 */

import { runWakeEnrollmentRequest } from '../../../acappella/wake/wake-enrollment-service';
import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';

/** The message type `maestro-cli voice wake` sends. */
export const VOICE_WAKE_ENROLLMENT_MESSAGE = 'voice_wake_enrollment';

export async function handleVoiceWakeEnrollment(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	const type = `${VOICE_WAKE_ENROLLMENT_MESSAGE}_result`;
	try {
		const reply = await runWakeEnrollmentRequest(message.request);
		ctx.send(client, { type, success: true, reply, requestId: message.requestId });
	} catch (error) {
		const errMsg = error instanceof Error ? error.message : String(error);
		ctx.send(client, { type, success: false, error: errMsg, requestId: message.requestId });
	}
}
