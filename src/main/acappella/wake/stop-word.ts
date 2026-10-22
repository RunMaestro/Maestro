/**
 * The stop word: the way to shut a voice assistant up.
 *
 * It runs on the SAME always-local detector as the wake word, and that placement
 * is the whole design. The stop word has to be heard while text-to-speech is
 * mid-sentence and while a cloud speech stream is open, which rules out waiting
 * for a transcript to come back from a remote engine: the answer would arrive
 * after the thing it was meant to stop had finished. A local classifier on the
 * raw microphone frames is the only place this can live.
 *
 * **The stop word is not barge-in, and the two must never converge.**
 *
 *   - Barge-in means "stop talking, I am still here". Speech is cancelled, the
 *     floor stays open, the session goes `speaking -> interrupted -> listening`,
 *     and the event is `barge-in`.
 *   - The stop word means "we are done". Speech is cancelled, playback is
 *     flushed, the microphone is closed, the session returns to `idle`, and the
 *     event is `stop-word`.
 *
 * They are separate modules, separate events, separate settings, and separate
 * HUD feedback for one reason: every assistant that folded them together became
 * one you cannot get rid of. Interrupting the machine is the most common thing a
 * person does in a conversation, and it must not be the gesture that hangs up.
 *
 * Two phrases, always. The configurable one is whatever the user chose, and
 * "nevermind" is always armed alongside it, because the moment you need the stop
 * word is the moment you will not remember which words you assigned to it.
 */

import type { AudioHostCommand } from '../../../shared/acappella/audio-host';
import type { InterruptSource } from '../../../shared/acappella/protocol';
import type { VoiceSessionState } from '../../../shared/acappella/session-state';
import {
	DEFAULT_STOP_PHRASE,
	FALLBACK_STOP_PHRASE,
} from '../../../shared/acappella/voice-controls';
import { logger } from '../../utils/logger';
import { captureException } from '../../utils/sentry';
import { DEFAULT_WAKE_SENSITIVITY, type WakeDetection, type WakePhrase } from './wake-detector';

const LOG_CONTEXT = 'ACappella';

export {
	DEFAULT_STOP_PHRASE,
	FALLBACK_STOP_PHRASE,
} from '../../../shared/acappella/voice-controls';

/** Stop phrase ids carry a prefix so a detection can be routed without a lookup. */
export const STOP_PHRASE_PREFIX = 'stop:';

export const PRIMARY_STOP_PHRASE_ID = `${STOP_PHRASE_PREFIX}primary`;
export const FALLBACK_STOP_PHRASE_ID = `${STOP_PHRASE_PREFIX}nevermind`;

/** True when a detection came from a stop phrase rather than a wake phrase. */
export function isStopPhraseId(id: string): boolean {
	return id.startsWith(STOP_PHRASE_PREFIX);
}

export interface StopWordConfig {
	/** The user's phrase. Blank falls back to {@link DEFAULT_STOP_PHRASE}. */
	phrase?: string;
	/** 0 to 1, higher is easier to trigger. */
	sensitivity?: number;
	/** False disarms the configurable phrase. "nevermind" stays armed regardless. */
	enabled?: boolean;
}

/**
 * The stop phrases, as the detector wants them.
 *
 * Their `scope` is the Conductor because a stop phrase does not open anything
 * and the field has to hold something; nothing reads it, and
 * {@link StopWordController.handleDetection} routes on the id.
 */
export function stopWordPhrases(config: StopWordConfig = {}): WakePhrase[] {
	const sensitivity = config.sensitivity ?? DEFAULT_WAKE_SENSITIVITY;
	return [
		{
			id: PRIMARY_STOP_PHRASE_ID,
			phrase: config.phrase?.trim() || DEFAULT_STOP_PHRASE,
			scope: { kind: 'conductor' },
			sensitivity,
			enabled: config.enabled !== false,
		},
		{
			id: FALLBACK_STOP_PHRASE_ID,
			phrase: FALLBACK_STOP_PHRASE,
			scope: { kind: 'conductor' },
			sensitivity,
		},
	];
}

/**
 * Which phrases the local detector should be listening for right now.
 *
 * Idle means wake phrases; anything else means stop phrases. Arming both at once
 * would let a wake phrase spoken mid-answer open a second session on top of the
 * one already running, and arming neither would make one of the two features
 * silently unavailable in half the states the session can be in.
 */
export function armedPhrases(
	state: VoiceSessionState,
	phrases: { wake: readonly WakePhrase[]; stop: readonly WakePhrase[] }
): WakePhrase[] {
	const sessionIsCold = state === 'idle' || state === 'error';
	return sessionIsCold ? [...phrases.wake] : [...phrases.stop];
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

/**
 * The slice of `VoiceSessionService` the stop word drives.
 *
 * `hardStop` and nothing else. Notably absent: `interrupt`. The stop word must
 * not be able to reach barge-in even by accident, which is what makes "these two
 * behaviours can never drift into each other" a property of the code.
 */
export interface StopWordSession {
	getState(): VoiceSessionState;
	/** Emits `stop-word`, cancels speech, stops the recogniser, returns to `idle`. */
	hardStop(source?: InterruptSource, phrase?: string): Promise<void>;
}

/** What actually happened, for the HUD and the tests. */
export interface StopWordEventInfo {
	phrase: string;
	phraseId: string;
	/** The state the session was in when the phrase landed. */
	from: VoiceSessionState;
	score: number;
	at: number;
}

export interface StopWordControllerOptions {
	session: StopWordSession;
	/**
	 * Pushes a command to the hidden audio host. Used for exactly two things:
	 * discarding queued speech and closing the microphone.
	 */
	sendCommand?: (command: AudioHostCommand) => void;
	/** The user's stop phrase settings, read per detection so a change takes effect live. */
	getConfig?: () => StopWordConfig;
	/**
	 * The session went cold and the detector should go back to wake-word-only.
	 *
	 * A seam rather than a direct call because the detector's phrase list is owned
	 * by the wiring layer, and a controller that reached into it would be able to
	 * arm a wake phrase mid-session.
	 */
	onWakeWordOnly?: () => void;
	/** The stop word fired. Distinct from any barge-in seam, deliberately. */
	onStopWord?: (info: StopWordEventInfo) => void;
	/** Something the caller could not have awaited went wrong. Already reported. */
	onError?: (error: Error) => void;
}

export class StopWordController {
	private readonly options: StopWordControllerOptions;
	/** Serialises stops, so two phrases inside one window cannot race two teardowns. */
	private queue: Promise<void> = Promise.resolve();

	constructor(options: StopWordControllerOptions) {
		this.options = options;
	}

	/** The phrases to arm while a session is running. */
	phrases(): WakePhrase[] {
		return stopWordPhrases(this.options.getConfig?.() ?? {});
	}

	/**
	 * Route one detection from the local detector.
	 *
	 * @returns true when this was a stop phrase and was acted on, so the caller
	 *          knows not to treat it as a wake.
	 */
	handleDetection(detection: WakeDetection): boolean {
		if (!isStopPhraseId(detection.phraseId)) return false;

		const from = this.options.session.getState();
		if (from === 'idle') {
			// Nothing to stop. Not an error: "nevermind" said into a quiet room is a
			// perfectly ordinary thing for a person to do.
			logger.debug('Stop phrase heard with no session running', LOG_CONTEXT);
			return true;
		}

		void this.enqueue(() => this.stop(detection, from));
		return true;
	}

	/** Resolves once every queued stop has run. Tests and shutdown paths use it. */
	whenSettled(): Promise<void> {
		return this.queue;
	}

	// -- Internals -----------------------------------------------------------

	/**
	 * Go cold, in the order that keeps the room quiet.
	 *
	 * Playback is flushed FIRST. `hardStop` cancels the speech run, but chunks
	 * already handed to the audio host are queued in the renderer and would keep
	 * playing for as long as that queue is deep - which is the exact experience
	 * the stop word exists to end.
	 */
	private async stop(detection: WakeDetection, from: VoiceSessionState): Promise<void> {
		// Re-checked here, not only at the door: both stop phrases can clear on the
		// same window, and the second one arrives at the front of the queue after
		// the first has already taken the session down. Stopping an idle session
		// again would close a microphone somebody else may have just opened.
		if (this.options.session.getState() === 'idle') return;

		logger.info(`Stop word '${detection.phrase}' from ${from}`, LOG_CONTEXT);
		this.send({ kind: 'flush' });

		try {
			await this.options.session.hardStop('voice', detection.phrase);
		} catch (error) {
			this.report(error as Error, 'acappella.stopWord.hardStop');
		}

		// The microphone closes after the session is down, so a frame in flight
		// cannot arrive at a recogniser that has already been stopped.
		this.send({ kind: 'stop-capture' });

		this.notifyStopWord({
			phrase: detection.phrase,
			phraseId: detection.phraseId,
			from,
			score: detection.score,
			at: detection.at,
		});

		try {
			this.options.onWakeWordOnly?.();
		} catch (error) {
			this.report(error as Error, 'acappella.stopWord.onWakeWordOnly');
		}
	}

	private notifyStopWord(info: StopWordEventInfo): void {
		try {
			this.options.onStopWord?.(info);
		} catch (error) {
			this.report(error as Error, 'acappella.stopWord.onStopWord');
		}
	}

	private send(command: AudioHostCommand): void {
		try {
			this.options.sendCommand?.(command);
		} catch (error) {
			// A destroyed audio host must not stop the session from ending: the
			// session going idle is the part the user asked for.
			this.report(error as Error, 'acappella.stopWord.sendCommand');
		}
	}

	private enqueue(action: () => Promise<void>): Promise<void> {
		const next = this.queue.then(action).catch((error: Error) => {
			this.report(error, 'acappella.stopWord');
		});
		this.queue = next;
		return next;
	}

	private report(error: Error, context: string): void {
		logger.error(`Stop word failure (${context}): ${error.message}`, LOG_CONTEXT);
		void captureException(error, { context });
		this.options.onError?.(error);
	}
}

/** Sugar, matching the rest of A Cappella's factories. */
export function createStopWordController(options: StopWordControllerOptions): StopWordController {
	return new StopWordController(options);
}
