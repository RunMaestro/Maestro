/**
 * A Cappella voice session state machine.
 *
 * The transition table below is the ONLY place transition legality is defined.
 * An illegal transition throws rather than smearing state, because a voice UI
 * that is silently in two states at once is unfixable in the field: the user
 * hears nothing and there is no screen to read.
 *
 * See docs/architecture/acappella/system-overview.md for the diagram.
 */

export type VoiceSessionState =
	| 'idle'
	| 'arming'
	| 'listening'
	| 'transcribing'
	| 'routing'
	| 'dispatching'
	| 'speaking'
	| 'interrupted'
	| 'error';

export const VOICE_SESSION_STATES: readonly VoiceSessionState[] = [
	'idle',
	'arming',
	'listening',
	'transcribing',
	'routing',
	'dispatching',
	'speaking',
	'interrupted',
	'error',
] as const;

/**
 * Legal transitions, keyed by source state.
 *
 * Two rules explain most of the table:
 *   - Every non-idle state may go to `idle`, because the stop word ends a
 *     session from wherever it is. Barge-in does NOT appear here as a path to
 *     idle: it goes `speaking -> interrupted -> listening` and keeps the floor.
 *   - Every state that runs a provider may go to `error`, because a classified
 *     provider failure is a state, not an exception.
 */
export const VOICE_STATE_TRANSITIONS: Record<VoiceSessionState, readonly VoiceSessionState[]> = {
	idle: ['arming'],
	arming: ['listening', 'idle', 'error'],
	listening: ['transcribing', 'idle', 'error'],
	/** Back to `listening` when the utterance was empty and there is nothing to route. */
	transcribing: ['routing', 'listening', 'idle', 'error'],
	routing: ['dispatching', 'idle', 'error'],
	/** Back to `listening` when the dispatch produced no reply worth speaking. */
	dispatching: ['speaking', 'listening', 'idle', 'error'],
	speaking: ['interrupted', 'listening', 'idle', 'error'],
	/** Barge-in retains the floor, so the only forward path is back to listening. */
	interrupted: ['listening', 'idle', 'error'],
	error: ['idle'],
};

/** States in which a session holds resources (providers, the audio floor, or both). */
export function isVoiceSessionActive(state: VoiceSessionState): boolean {
	return state !== 'idle' && state !== 'error';
}

export function canTransitionVoiceState(from: VoiceSessionState, to: VoiceSessionState): boolean {
	return VOICE_STATE_TRANSITIONS[from].includes(to);
}

/** Thrown by `assertVoiceStateTransition`. Carries both states so Sentry gets the edge. */
export class InvalidVoiceStateTransitionError extends Error {
	constructor(
		public readonly from: VoiceSessionState,
		public readonly to: VoiceSessionState
	) {
		super(`Illegal voice session transition: ${from} -> ${to}`);
		this.name = 'InvalidVoiceStateTransitionError';
	}
}

/** Throws `InvalidVoiceStateTransitionError` unless the edge is in the table. */
export function assertVoiceStateTransition(from: VoiceSessionState, to: VoiceSessionState): void {
	if (!canTransitionVoiceState(from, to)) {
		throw new InvalidVoiceStateTransitionError(from, to);
	}
}
