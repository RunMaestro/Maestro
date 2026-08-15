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
 * Silence that closes a listening session on its own. Long enough to survive
 * someone thinking about how to phrase a request, short enough that a mic left
 * open in an empty room goes cold before anyone forgets it is there.
 */
export const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

/** Below this an ordinary pause would hang up on the user. */
export const MIN_IDLE_TIMEOUT_MS = 5_000;

/** A half hour open microphone is already a bug; this is the ceiling on it. */
export const MAX_IDLE_TIMEOUT_MS = 30 * 60_000;
