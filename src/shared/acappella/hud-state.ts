/**
 * What the voice HUD is showing, reduced from the nine-state session machine to
 * the five things a person can actually read at a glance.
 *
 * The session machine is the truth (`session-state.ts`), but it is engineering
 * truth: `transcribing`, `routing`, and `dispatching` are three different pieces
 * of work and exactly one thing to a user, which is "it is thinking". A HUD that
 * flickered through three labels in half a second would read as a glitch rather
 * than as progress.
 *
 * Kept in `shared/` and kept pure so the desktop HUD, the accessibility
 * announcer, and the phone client in Phase 11 all reduce the same way. Two
 * clients that disagreed about whether `interrupted` means "listening" would
 * disagree about whether the microphone is open, which is the one question this
 * widget exists to answer.
 */

import type { VoiceSessionState } from './session-state';

/**
 * The five readable states.
 *
 *   - `idle-armed`  nothing is being captured; the wake word may still be armed.
 *   - `listening`   the floor is open and audio is being consumed.
 *   - `thinking`    the utterance is being transcribed, routed, or worked on.
 *   - `speaking`    a reply is coming out of the speakers.
 *   - `error`       a classified failure the user has to read.
 */
export type VoiceHudVisualState = 'idle-armed' | 'listening' | 'thinking' | 'speaking' | 'error';

const STATE_MAP: Record<VoiceSessionState, VoiceHudVisualState> = {
	idle: 'idle-armed',
	arming: 'idle-armed',
	listening: 'listening',
	transcribing: 'thinking',
	routing: 'thinking',
	dispatching: 'thinking',
	speaking: 'speaking',
	// Barge-in KEEPS the floor, so the honest thing to show is that Maestro is
	// listening again. Giving it a state of its own would flash a fourth
	// appearance for the few milliseconds between the interruption and the floor
	// coming back, which reads as a stutter at exactly the moment the user is
	// checking whether their interruption worked.
	interrupted: 'listening',
	error: 'error',
};

export function voiceHudVisualState(state: VoiceSessionState): VoiceHudVisualState {
	return STATE_MAP[state];
}

/** Short label, spoken English. Also the accessible name of the indicator. */
export const VOICE_HUD_STATE_LABELS: Record<VoiceHudVisualState, string> = {
	'idle-armed': 'Idle',
	listening: 'Listening',
	thinking: 'Thinking',
	speaking: 'Speaking',
	error: 'Error',
};

/**
 * One sentence saying what is happening, for the live region and the tooltip.
 *
 * Written for someone who cannot see the animation, which is the case this
 * exists for: "Listening" alone does not say whether the microphone is open, and
 * that is the whole content of the indicator for a sighted user.
 */
export const VOICE_HUD_STATE_DESCRIPTIONS: Record<VoiceHudVisualState, string> = {
	'idle-armed': 'Not listening. The microphone is closed.',
	listening: 'Listening. The microphone is open.',
	thinking: 'Working on what you said.',
	speaking: 'Speaking a reply.',
	error: 'Something went wrong with the voice session.',
};

/**
 * True when this state means audio is being captured RIGHT NOW.
 *
 * The one predicate that must never be wrong: it decides whether the UI claims a
 * hot microphone, and a widget that says it is listening while the floor is shut
 * (or the reverse) is worse than no widget.
 */
export function voiceHudIsHotMic(state: VoiceHudVisualState): boolean {
	return state === 'listening';
}
