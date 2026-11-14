/**
 * What the voice HUD is showing, reduced from the nine-state session machine to
 * the six things a person can actually read at a glance.
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

import type {
	DispatchEvent,
	MicState,
	RosterAgent,
	VoiceOrigin,
	VoiceScope,
	VoiceWindowId,
	VoiceSendState,
} from './protocol';
import type { VoiceProviderSubstitution } from './providers';
import type { RouteDecision } from './route-decision';
import type { VoiceSessionState } from './session-state';

/**
 * The six readable states.
 *
 *   - `idle-armed`  nothing is being captured; the wake word may still be armed.
 *   - `paused`      the session is live and waiting, with the microphone gated
 *                   shut: hands-free switched off, or push-to-talk with the
 *                   button up.
 *   - `listening`   the floor is open and audio is being consumed.
 *   - `thinking`    the utterance is being transcribed, routed, or worked on.
 *   - `speaking`    a reply is coming out of the speakers.
 *   - `error`       a classified failure the user has to read.
 */
export type VoiceHudVisualState =
	| 'idle-armed'
	| 'paused'
	| 'listening'
	| 'thinking'
	| 'speaking'
	| 'error';

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

/**
 * @param paused Whether the microphone is gated shut (`listen-gate`). It only
 *               changes the answer where the session would otherwise read as
 *               listening: a paused session that is thinking or speaking is
 *               still doing exactly that.
 */
export function voiceHudVisualState(state: VoiceSessionState, paused = false): VoiceHudVisualState {
	const visual = STATE_MAP[state];
	return paused && visual === 'listening' ? 'paused' : visual;
}

/** Short label, spoken English. Also the accessible name of the indicator. */
export const VOICE_HUD_STATE_LABELS: Record<VoiceHudVisualState, string> = {
	'idle-armed': 'Idle',
	paused: 'Paused',
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
	paused: 'Paused. The session is open and the microphone is closed.',
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

/** Who said a line in the HUD transcript. `system` is the session narrating itself. */
export type VoiceFeedKind = 'you' | 'assistant' | 'system';

/**
 * Where a turn was dispatched, carried on the feed line that narrates it.
 *
 * On the entry rather than looked up later because the transcript renders a
 * CLICKABLE chip from it ("Backend / Auth Refactor (new tab)"), and the agent or
 * tab it names may have been closed by the time anyone reads the line. Keeping
 * the address with the line is what lets the chip stay honest: it can say where
 * the turn went even when that place is gone.
 */
export interface VoiceFeedRoute {
	groupChatId?: string;
	agentSessionId: string;
	agentName: string;
	tabId: string;
	tabName?: string;
	action: DispatchEvent['action'];
}

export interface VoiceFeedEntry {
	/** `${sessionId}:${seq}` - stable, and unique even across a session restart. */
	id: string;
	kind: VoiceFeedKind;
	text: string;
	ts: number;
	/** Set only on the line narrating a dispatch. */
	route?: VoiceFeedRoute;
}

/** One speech run, so the HUD can show "2 of 4" and where it was cut off. */
export interface VoiceSpeechRun {
	utteranceId: string;
	/**
	 * How many sentences the run knew about at `speak-start`.
	 *
	 * A LOWER BOUND while {@link streaming} is true, per the protocol: the
	 * scheduler starts speaking sentence one while the agent is still writing the
	 * rest, so the delivered index runs past this. Anything rendering a total has
	 * to say so rather than print it as fact.
	 */
	sentenceCount: number;
	/** True while more sentences are still being written. */
	streaming: boolean;
	sentences: string[];
	/** Null while the run is live. */
	endedReason: 'complete' | 'cancelled' | 'error' | null;
}

export interface VoiceProviderIds {
	stt: string;
	tts: string;
	brain: string;
}

export interface VoiceSessionProjection {
	sessionId: string | null;
	state: VoiceSessionState;
	scope: VoiceScope | null;
	/**
	 * Which microphone is holding the session.
	 *
	 * `local` unless a paired device took the floor, in which case the HUD says
	 * which one. A Mac at home showing a listening indicator over its own shut
	 * microphone is describing something that is not happening in the room, and
	 * this is the field that stops it.
	 */
	origin: VoiceOrigin;
	/**
	 * The window whose HUD owns this session, or null for none.
	 *
	 * Mirrored in EVERY window, because every window receives the whole event
	 * stream (see the multi-window invariant in `main/utils/safe-send.ts`) and
	 * each one decides for itself whether to draw a surface. `useOwnsVoiceSession`
	 * is that decision; nothing else should compare this field by hand.
	 */
	windowId: VoiceWindowId;
	/** Last `seq` applied. */
	seq: number;
	/** True once a `seq` gap was seen. Sticky for the life of the session. */
	lostEvents: boolean;
	providerIds: VoiceProviderIds | null;
	/**
	 * Whether the live recogniser consumes microphone audio.
	 *
	 * Null until the session reports its providers. False is the case worth having
	 * a field for: the text-in mock tier opens no capture device, so the floor is
	 * genuinely open and nothing can ever be heard - a state that otherwise renders
	 * as an ordinary "Listening" and sent a user through six rebuilds looking for a
	 * broken microphone that was never opened.
	 */
	sttHearsAudio: boolean | null;
	/** Roles running on the mock tier against the user's wishes. Never hidden. */
	substitutions: VoiceProviderSubstitution[];
	/** Live STT hypothesis. Cleared when the utterance settles. */
	partialTranscript: string;
	/**
	 * Set while a finished sentence is held before dispatch (hold-until-send, or
	 * the settle window). `settlesAt` is epoch ms; the HUD counts down to it and
	 * says how to send now, so a held request never reads as a dead session.
	 */
	sendState: VoiceSendState;
	heldUtterance: { settlesAt: number; sendPhrases: string[] } | null;
	/** The last settled utterance. */
	utterance: string | null;
	decision: RouteDecision | null;
	/**
	 * What the last dispatch actually did. Kept whole rather than reduced,
	 * because it is also the address a reply comes back on
	 * (`agentSessionId` + `tabId`).
	 */
	lastDispatch: DispatchEvent | null;
	speech: VoiceSpeechRun | null;
	/**
	 * Latest downsampled input level, 0 to 1. Updated ~20 times a second, so
	 * anything that reads it should subscribe to it ALONE - see the note on
	 * `selectVoiceAudioLevel`.
	 */
	audioLevel: number;
	/** Whether the detector considered the last meter window to be speech. */
	speechDetected: boolean;
	/** The microphone as the session sees it. Null until the host reports. */
	mic: MicState | null;
	error: { code: string; message: string; recoverable: boolean } | null;
	roster: RosterAgent[];
	feed: VoiceFeedEntry[];
	/** The user closed the HUD. Cleared when a new session starts. */
	dismissed: boolean;
	/**
	 * The microphone is gated shut while the session stays alive (`listen-gate`):
	 * hands-free switched off, or push-to-talk with the button up.
	 *
	 * Its own field rather than a session state, because the session really is
	 * still `listening` - it can answer, speak, and be re-bound. What changed is
	 * the device, and `voiceHudVisualState(state, listenPaused)` is how every
	 * surface turns the pair into one honest answer about the microphone.
	 */
	listenPaused: boolean;
	/**
	 * A session has been live since the HUD was last closed.
	 *
	 * What keeps the HUD on screen after its session ends. Only Escape (the close
	 * control) takes the HUD away: a session that timed out, or was switched off
	 * from the talk button, leaves the surface where it was, showing that the
	 * microphone is closed and one click from open again. Derived from the
	 * session here, never set by a component, so a window that reloaded
	 * mid-session agrees with one that watched it start.
	 */
	surfaced: boolean;
}
