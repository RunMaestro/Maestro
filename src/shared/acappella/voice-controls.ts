/**
 * The numbers and phrases the voice controls ship with.
 *
 * Pure data, shared because both processes need the same answer: main clamps
 * against these when it reads the settings blob, and the Settings panel draws
 * its sliders from them. A default the panel and the detector disagreed about is
 * a wake word that fires at a sensitivity the slider says it does not have.
 *
 * The main-process modules that own each behaviour re-export these rather than
 * redeclaring them, so there is one place to change a default and no chance of
 * two files drifting to different values.
 */

/** The phrase a fresh install listens for. */
export const DEFAULT_WAKE_PHRASE = 'hey maestro';

/**
 * How eagerly a phrase fires, 0 to 1. Higher means easier: the score has to
 * clear `1 - sensitivity`. Half way is openWakeWord's own usable middle.
 */
export const DEFAULT_WAKE_SENSITIVITY = 0.5;

/** The floor on a threshold, so a slider pinned to "most sensitive" is not a hair trigger. */
export const MIN_WAKE_THRESHOLD = 0.05;

/**
 * One utterance clears the threshold over several consecutive scoring windows.
 * Anything under about a second and a half fires twice on one "hey maestro".
 */
export const DEFAULT_WAKE_DEBOUNCE_MS = 1500;

/** What a fresh install stops on. */
export const DEFAULT_STOP_PHRASE = 'maestro stop';

/**
 * The second stop phrase, always armed and not user-editable.
 *
 * A stop word you have to remember is not a stop word. This one is the same in
 * every install, so it is the answer to "how do I make it be quiet" for someone
 * who has never opened the settings.
 */
export const FALLBACK_STOP_PHRASE = 'nevermind';

/**
 * Below this a hotkey press is a tap. 300 ms is comfortably longer than a
 * deliberate tap and comfortably shorter than the pause before anyone starts a
 * sentence.
 */
export const DEFAULT_HOLD_THRESHOLD_MS = 300;

/** Under this every hold would read as a tap on a slow keyboard. */
export const MIN_HOLD_THRESHOLD_MS = 100;

/** Over this the user is holding a key wondering whether the app noticed. */
export const MAX_HOLD_THRESHOLD_MS = 2000;

/**
 * Pull a stored threshold into the usable band. Clamped, never rejected.
 *
 * Shared because two surfaces classify a press against it: the global hotkey in
 * main, and the HUD's talk button in the renderer. A button that decided "hold"
 * at a different number than the key would be two push-to-talk gestures wearing
 * one name.
 */
export function resolveHoldThresholdMs(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_HOLD_THRESHOLD_MS;
	return Math.min(MAX_HOLD_THRESHOLD_MS, Math.max(MIN_HOLD_THRESHOLD_MS, Math.round(value)));
}

/**
 * Silence that closes a listening session on its own. Long enough to survive
 * someone thinking about how to phrase a request, short enough that a mic left
 * open in an empty room goes cold before anyone forgets it is there.
 */
export const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

/** Below this an ordinary pause would hang up on the user. */
export const MIN_IDLE_TIMEOUT_MS = 5_000;

/** A half hour open microphone is already a bug; this is the ceiling on it. */
export const MAX_IDLE_TIMEOUT_MS = 30 * 60_000;

/**
 * Speaking rate, as a multiple of the provider's natural pace.
 *
 * The window is deliberately narrow. Every TTS engine degrades outside roughly
 * this range - a local vocoder at 2x is a chipmunk and at 0.5x it slurs - and a
 * slider that can produce unintelligible speech is a slider that will produce
 * unintelligible speech.
 */
export const DEFAULT_TTS_RATE = 1;
export const MIN_TTS_RATE = 0.7;
export const MAX_TTS_RATE = 1.4;
export const TTS_RATE_STEP = 0.05;

/**
 * Output volume, 0 to 1, applied to the assistant's voice only.
 *
 * Its own control rather than "use the system volume" because this is the one
 * sound the app makes that a user may want quieter than everything else: the
 * assistant talks over a room the user is also working in.
 */
export const DEFAULT_TTS_VOLUME = 1;
/**
 * The floor is above zero on purpose. Zero is mute, mute is a button with its
 * own state and its own indicator, and a volume slider dragged to the end that
 * silently becomes a mute is how someone ends up with a session that appears to
 * be speaking and makes no sound.
 */
export const MIN_TTS_VOLUME = 0.1;
export const MAX_TTS_VOLUME = 1;
export const TTS_VOLUME_STEP = 0.05;

/** Clamp a stored rate into the shipped window. Anything unusable reads as default. */
export function clampTtsRate(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_TTS_RATE;
	return Math.min(MAX_TTS_RATE, Math.max(MIN_TTS_RATE, value));
}

/** Clamp a stored volume the same way. */
export function clampTtsVolume(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_TTS_VOLUME;
	return Math.min(MAX_TTS_VOLUME, Math.max(MIN_TTS_VOLUME, value));
}
