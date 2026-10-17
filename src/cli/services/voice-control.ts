// The bridge round trip every `maestro-cli voice` verb makes (all but `voice
// wake`, which has its own message).
//
// A verb sends one `VoiceControlRequest` and reads the result of that action.
// The app answers a refusal it gave on purpose (voice is switched off, a turn
// is in flight, no device has that id) as a reply with a reason; that reason is
// printed and the verb exits non-zero, so a script can tell "done" from "not
// done, and why".

import {
	VOICE_CONTROL_MESSAGE,
	type VoiceControlAction,
	type VoiceControlReply,
	type VoiceControlRequest,
	type VoiceControlResults,
} from '../../shared/acappella/voice-control';
import { withMaestroClient } from './maestro-client';
import { failCommand, sendBridgeCommand } from './session-command';

/** Enough for a state read, a start, or a provider swap. */
export const VOICE_REQUEST_TIMEOUT_MS = 30_000;

interface VoiceBridgeResponse<A extends VoiceControlAction> {
	success: boolean;
	error?: string;
	reply?: VoiceControlReply<A>;
}

/** Send one request and return the action's result, or exit with why it did not happen. */
export async function sendVoiceControl<A extends VoiceControlAction>(
	request: Extract<VoiceControlRequest, { action: A }>,
	json: boolean | undefined,
	timeoutMs = VOICE_REQUEST_TIMEOUT_MS
): Promise<VoiceControlResults[A]> {
	const response = await sendBridgeCommand<VoiceBridgeResponse<A>>(
		{ type: VOICE_CONTROL_MESSAGE, request },
		`${VOICE_CONTROL_MESSAGE}_result`,
		json,
		timeoutMs
	);
	const reply = response.reply;
	if (!reply) failCommand('The desktop app sent no reply.', json);
	if (!reply.ok) failCommand(reply.reason, json);
	return reply.result;
}

/** What {@link tryVoiceControl} found: the result, the app's refusal, or no app to ask. */
export type VoiceControlAttempt<A extends VoiceControlAction> =
	| { kind: 'done'; result: VoiceControlResults[A] }
	| { kind: 'refused'; reason: string }
	| { kind: 'unreachable'; reason: string };

/**
 * Send one request and report what happened without exiting.
 *
 * For a verb whose write already succeeded in the settings file and now asks
 * the running app to pick it up: Maestro being closed is not a failure of that
 * verb, so it must be able to say "saved, applies at the next start".
 */
export async function tryVoiceControl<A extends VoiceControlAction>(
	request: Extract<VoiceControlRequest, { action: A }>,
	timeoutMs = VOICE_REQUEST_TIMEOUT_MS
): Promise<VoiceControlAttempt<A>> {
	let response: VoiceBridgeResponse<A>;
	try {
		response = await withMaestroClient((client) =>
			client.sendCommand<VoiceBridgeResponse<A>>(
				{ type: VOICE_CONTROL_MESSAGE, request },
				`${VOICE_CONTROL_MESSAGE}_result`,
				timeoutMs
			)
		);
	} catch (error) {
		return { kind: 'unreachable', reason: error instanceof Error ? error.message : String(error) };
	}
	if (!response.success || !response.reply) {
		return { kind: 'unreachable', reason: response.error || 'The desktop app sent no reply.' };
	}
	return response.reply.ok
		? { kind: 'done', result: response.reply.result }
		: { kind: 'refused', reason: response.reply.reason };
}
