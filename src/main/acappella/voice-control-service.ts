/**
 * The one entry point `maestro-cli voice` reaches.
 *
 * Every voice action a person takes in the HUD or in Settings > Voice is a
 * function the A Cappella IPC layer already owns: it holds the session service,
 * the audio bridge, the provider pipeline and the microphone, and none of that
 * can be reached from anywhere else. So the handlers are BUILT there, from the
 * same functions the `acappella:*` channels call, and registered here, the
 * arrangement wake phrase enrollment has (`wake-enrollment-service.ts`).
 *
 * What this module owns is the part every transport must agree on: reading a
 * request off the wire, the Encore gate, and turning a refusal into a reason.
 */

import {
	parseVoiceControlRequest,
	voiceControlActionNeedsVoice,
	type VoiceControlAction,
	type VoiceControlReply,
	type VoiceControlRequest,
	type VoiceControlResults,
} from '../../shared/acappella/voice-control';

/** One function per action, each the body of a button somewhere in the UI. */
export type VoiceControlHandlers = {
	[A in VoiceControlAction]: (
		request: Extract<VoiceControlRequest, { action: A }>
	) => Promise<VoiceControlResults[A]>;
};

/**
 * A refusal the app gives on purpose: a turn is in flight, a session holds the
 * microphone, a device id is unknown. Thrown by a handler, answered as
 * `ok: false` with the sentence. Anything else a handler throws is a bug and
 * stays an error.
 */
export class VoiceControlRefusal extends Error {
	constructor(reason: string) {
		super(reason);
		this.name = 'VoiceControlRefusal';
	}
}

/** What a caller is told when voice is switched off and the action needs it. */
export const VOICE_DISABLED_REASON =
	'A Cappella is switched off. Turn it on with "maestro-cli encore enable aCappella", or in Settings > Plugins.';

/** The live handlers and whether voice is switched on, set by whoever owns the session. */
let registered: { handlers: VoiceControlHandlers; isVoiceEnabled: () => boolean } | null = null;

/**
 * Make a set of handlers the one {@link runVoiceControlRequest} answers with.
 *
 * @returns Unregister, for teardown.
 */
export function registerVoiceControlService(
	handlers: VoiceControlHandlers,
	isVoiceEnabled: () => boolean
): () => void {
	const entry = { handlers, isVoiceEnabled };
	registered = entry;
	return () => {
		if (registered === entry) registered = null;
	};
}

/**
 * Run one voice request, whoever sent it.
 *
 * Never throws for something the caller can act on: a malformed request, voice
 * being switched off, and a refusal a handler raised are all `ok: false` with
 * the sentence to show.
 */
export async function runVoiceControlRequest(raw: unknown): Promise<VoiceControlReply> {
	const request = parseVoiceControlRequest(raw);
	if (!request) return { ok: false, reason: 'Unknown voice request.' };
	if (!registered) return { ok: false, reason: 'Voice is not available in this build.' };
	const { handlers, isVoiceEnabled } = registered;
	if (voiceControlActionNeedsVoice(request.action) && !isVoiceEnabled()) {
		return { ok: false, reason: VOICE_DISABLED_REASON };
	}

	try {
		// One handler per action, each typed against its own request. The table
		// is indexed by the request's own action, which the compiler cannot
		// follow across a union, hence the cast.
		const handler = handlers[request.action] as (
			request: VoiceControlRequest
		) => Promise<VoiceControlResults[VoiceControlAction]>;
		return { ok: true, result: await handler(request) };
	} catch (error) {
		if (error instanceof VoiceControlRefusal) return { ok: false, reason: error.message };
		throw error;
	}
}
