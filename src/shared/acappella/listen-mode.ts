/**
 * How the HUD's talk button holds the microphone, and how long a finished
 * sentence waits before it is sent.
 *
 *   - **Hands-free.** One click opens the microphone and it stays open. A
 *     request goes when you say a send phrase, or after the wait.
 *   - **Push-to-talk.** The microphone is open exactly while the button is held.
 *     Letting go IS the send, so neither the wait nor a send phrase is needed.
 *
 * Both are the same session. What differs is the gate in front of the
 * microphone (`VoiceSessionService.setListening`) and what ends a thought, so
 * switching between them never ends a conversation.
 *
 * Pure and shared: the HUD draws the picker from these, and main clamps what the
 * picker sends against the same numbers.
 */

import { formatDurationDecimal, humanizeDuration } from '../duration';
import { MAX_SEND_HOLD_MS, MIN_TURN_SETTLE_MS } from './voice-controls';

export type VoiceListenMode = 'hands-free' | 'push-to-talk';

export const VOICE_LISTEN_MODES: readonly VoiceListenMode[] = ['hands-free', 'push-to-talk'];

/** Holding a button for a whole request is a choice, not something to impose. */
export const DEFAULT_VOICE_LISTEN_MODE: VoiceListenMode = 'hands-free';

/** Anything unrecognised reads as the default. */
export function asVoiceListenMode(value: unknown): VoiceListenMode {
	return value === 'push-to-talk' ? 'push-to-talk' : DEFAULT_VOICE_LISTEN_MODE;
}

/** The other mode. Two today, written as a cycle so a third does not need a new caller. */
export function nextVoiceListenMode(mode: VoiceListenMode): VoiceListenMode {
	const index = VOICE_LISTEN_MODES.indexOf(mode);
	return VOICE_LISTEN_MODES[(index + 1) % VOICE_LISTEN_MODES.length];
}

export const VOICE_LISTEN_MODE_LABELS: Record<VoiceListenMode, string> = {
	'hands-free': 'Hands-free',
	'push-to-talk': 'Push-to-talk',
};

// ---------------------------------------------------------------------------
// The send wait
// ---------------------------------------------------------------------------

/**
 * The stops on the HUD's wait slider, without opening Settings.
 *
 * They span both of the stored timers on purpose: the short end is the settle
 * window's territory (`turnSettleMs`) and the long end is hold-until-send's
 * (`sendHoldMs`). A person switching the wait mid-conversation is choosing how
 * long a pause they are allowed, and does not care which setting owns the number.
 *
 * A ladder rather than a linear range because the useful waits are not evenly
 * spaced: one second apart matters at the short end and thirty seconds apart is
 * fine at the long one. A linear track from 1 s to 2 min would give the whole
 * 1-to-5 s range a few pixels.
 */
export const SEND_WAIT_STOPS_MS: readonly number[] = [
	1000, 2000, 3000, 5000, 10_000, 15_000, 20_000, 30_000, 45_000, 60_000, 90_000, 120_000,
];

/** Zero is meaningful: send each sentence the moment it endpoints. */
export const MIN_SEND_WAIT_MS = MIN_TURN_SETTLE_MS;

/** The same ceiling hold-until-send has, for the same reason. */
export const MAX_SEND_WAIT_MS = MAX_SEND_HOLD_MS;

/**
 * Read a wait the HUD asked for.
 *
 * Null means "no override, use the stored default", and it is what anything
 * malformed reads as: an override is a timer in front of every dispatch, so a
 * bad value must fall back to the setting rather than become one.
 */
export function clampSendWaitOverrideMs(value: unknown): number | null {
	if (typeof value !== 'number' || !Number.isFinite(value)) return null;
	return Math.min(MAX_SEND_WAIT_MS, Math.max(MIN_SEND_WAIT_MS, Math.round(value)));
}

/** The stored timers that decide the default wait. */
export interface SendWaitSettings {
	holdUntilSend?: boolean;
	sendHoldMs?: number;
	turnSettleMs?: number;
}

/**
 * The wait Settings asks for.
 *
 * Hold mode swaps the short "did they stop talking" guess for a long backstop,
 * because in that mode the send phrase is how a request finishes.
 */
export function defaultSendWaitMs(settings: SendWaitSettings): number {
	return (settings.holdUntilSend ? settings.sendHoldMs : settings.turnSettleMs) ?? 0;
}

/** What the HUD shows for the wait in force, and how it got there. */
export interface VoiceSendWait {
	/** The wait in force right now, in ms. */
	waitMs: number;
	/** What Settings asks for, shown as the "Default" option. */
	defaultMs: number;
	/** True when the HUD picked {@link waitMs} rather than Settings. */
	overridden: boolean;
	/** What sends a request before the wait runs out. Empty when phrases are off. */
	sendPhrases: string[];
}

/** Join a stored default and a HUD override into what is in force. */
export function resolveSendWait(
	settings: SendWaitSettings & { sendPhrases?: readonly string[] },
	overrideMs: number | null,
	fallbackPhrases: readonly string[]
): VoiceSendWait {
	const defaultMs = defaultSendWaitMs(settings);
	return {
		waitMs: overrideMs ?? defaultMs,
		defaultMs,
		overridden: overrideMs !== null,
		sendPhrases: [...(settings.sendPhrases ?? fallbackPhrases)],
	};
}

/**
 * The slider's ladder for one conversation: the shipped stops, plus the stored
 * default and the wait in force when either falls between two of them.
 *
 * Both are added so the thumb is always exactly ON the wait it shows. The
 * default settle window is 900 ms, which is no shipped stop, and an override
 * can arrive from outside the slider. A thumb snapped to the nearest stop would
 * read "1s" for a wait that is not one second.
 */
export function sendWaitStops(sendWait: Pick<VoiceSendWait, 'waitMs' | 'defaultMs'>): number[] {
	return [...new Set([...SEND_WAIT_STOPS_MS, sendWait.defaultMs, sendWait.waitMs])].sort(
		(a, b) => a - b
	);
}

/**
 * What a stop means as an override: the stored default's own stop is "no
 * override" (null), every other stop is its number.
 *
 * The default stop follows the setting. Sending its number instead would pin
 * today's default, and the wait would stop tracking Settings from then on.
 */
export function sendWaitOverrideForStop(
	stopMs: number,
	sendWait: Pick<VoiceSendWait, 'defaultMs'>
): number | null {
	return stopMs === sendWait.defaultMs ? null : stopMs;
}

/**
 * A wait as a short label: `900ms`, `1.5s`, `2s`, `30s`, and `instant` for zero.
 *
 * Whole seconds drop the decimal because the stops are whole seconds, and
 * "2.0s" beside "5.0s" reads as a measurement rather than as a choice.
 */
export function formatSendWait(ms: number): string {
	if (ms <= 0) return 'instant';
	if (ms < 1000 || ms % 1000 !== 0) return formatDurationDecimal(ms);
	return humanizeDuration(ms);
}
