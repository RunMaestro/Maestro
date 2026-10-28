/**
 * Barge-in, finished end to end.
 *
 * The audio pipeline already decides WHEN (`audio/audio-pipeline.ts`: duck on a
 * candidate frame, fire on a confirmed `speech-start`). This file owns WHAT
 * HAPPENS NEXT, in an order that matters, because the four things that have to
 * be torn down live in four different places and three of them are invisible to
 * the user:
 *
 *   1. **Duck**, within about 20 ms. The only step the user can hear, so it goes
 *      first. Everything after it is bookkeeping done into a quiet room.
 *   2. **Flush the playback queue.** Audio already handed to the host is a
 *      sentence the user has decided not to listen to.
 *   3. **Cancel the in-flight synthesis.** A provider mid-sentence will keep
 *      billing and keep emitting chunks otherwise.
 *   4. **Cancel the translator stream.** The rewrite behind the synthesis is a
 *      second in-flight model call, and it is the one people forget: cancelling
 *      TTS alone leaves a Brain writing sentences for a turn that is over.
 *
 * Then the floor reopens with the pre-roll included, which is what captures the
 * first word of the interruption rather than the second.
 *
 * Two invariants worth stating out loud:
 *
 *   - **What was HEARD is not what was QUEUED.** The conversation memory records
 *     only the sentences that reached the speaker. A model told it already said
 *     something the user never heard will refer back to it, and the user will
 *     have no idea what it means.
 *   - **Barge-in keeps the floor; the stop word goes cold.** They are different
 *     verbs and this file never ends a session. Conflating them makes talking
 *     over the assistant hang up on it, which is the single most annoying failure
 *     a voice interface has. The stop word lives in `wake/stop-word.ts`.
 */

import type { InterruptSource } from '../../../shared/acappella/protocol';
import type { SpeechRunResult } from './speech-scheduler';

/** The teardown, in the order it must happen. Reported for the suite and for tracing. */
export type BargeInStep = 'duck' | 'flush' | 'cancel-speech' | 'cancel-translation' | 'listening';

export interface BargeInOutcome {
	source: InterruptSource;
	utteranceId: string | null;
	/** Sentences the user actually heard. */
	spoken: string[];
	/** Sentences that were queued or mid-synthesis and never reached them. */
	unspoken: string[];
	/** Steps performed, in order. */
	steps: BargeInStep[];
	at: number;
}

export interface BargeInControllerOptions {
	/** Drop playback gain. Called first, with the fast ramp. */
	duck: (gain: number, rampMs: number) => void;
	/** Discard audio already queued in the host. */
	flushPlayback: () => void;
	/** Cut the speech run off mid-sentence. Returns what was heard against what was not. */
	cancelSpeech: () => SpeechRunResult | null;
	/** Abort the translator stream feeding the run. */
	cancelTranslation: () => void;
	/** Reopen the floor. The pre-roll is drained by the audio pipeline on the way in. */
	toListening: (outcome: BargeInOutcome) => void;
	/** Remember what was actually heard, for the conversation memory. */
	rememberSpoken?: (sentences: string[]) => void;
	/** Gain playback is ducked to. */
	duckGain?: number;
	/** Ramp for the duck. Fast enough to feel instant, slow enough not to click. */
	duckRampMs?: number;
	/** Dead time after speech starts during which a barge-in is refused. */
	guardMs?: number;
	now?: () => number;
}

/** Quiet, not silent: the user should still be able to tell it was speaking. */
const DEFAULT_DUCK_GAIN = 0.15;

/** About 20 ms. Below the threshold where a gain change reads as a step. */
const DEFAULT_DUCK_RAMP_MS = 20;

/**
 * The self-interrupt guard.
 *
 * Echo cancellation is good, not perfect, and the first moments of playback are
 * when it is worst: the canceller has no reference signal for a sentence that has
 * only just started. Without a guard the assistant's own first syllable trips the
 * detector and it interrupts itself, which looks exactly like a crash. 250 ms is
 * long enough to cover the AEC's convergence and short enough that a user
 * genuinely talking over the first word is still heard - they will still be
 * talking when it expires.
 */
const DEFAULT_GUARD_MS = 250;

export class BargeInController {
	private readonly options: BargeInControllerOptions;
	private readonly duckGain: number;
	private readonly duckRampMs: number;
	private readonly guardMs: number;
	private readonly now: () => number;

	/** When the current speech run started, or null when nothing is speaking. */
	private speechStartedAt: number | null = null;

	constructor(options: BargeInControllerOptions) {
		this.options = options;
		this.duckGain = clamp01(options.duckGain ?? DEFAULT_DUCK_GAIN);
		this.duckRampMs = Math.max(0, options.duckRampMs ?? DEFAULT_DUCK_RAMP_MS);
		this.guardMs = Math.max(0, options.guardMs ?? DEFAULT_GUARD_MS);
		this.now = options.now ?? Date.now;
	}

	/** The assistant started speaking. Opens the guard window. */
	noteSpeechStarted(): void {
		this.speechStartedAt = this.now();
	}

	/** The assistant stopped speaking. There is no floor left to barge into. */
	noteSpeechEnded(): void {
		this.speechStartedAt = null;
	}

	/**
	 * False while the guard window is open, or when nothing is speaking.
	 *
	 * The guard applies to VOICE only. A button press carries no ambiguity about
	 * who pressed it, so refusing one because the assistant started talking 80 ms
	 * ago would be a dead control rather than a protection.
	 */
	canInterrupt(source: InterruptSource = 'voice'): boolean {
		if (this.speechStartedAt === null) return false;
		if (source !== 'voice') return true;
		return this.now() - this.speechStartedAt >= this.guardMs;
	}

	/**
	 * Take the floor back.
	 *
	 * @returns `null` when there was nothing to interrupt or the guard window is
	 *          still open, so a self-interrupt is a no-op rather than an error.
	 */
	trigger(source: InterruptSource = 'voice'): BargeInOutcome | null {
		if (!this.canInterrupt(source)) return null;

		const steps: BargeInStep[] = [];

		// Heard first, because it is the only step the user perceives.
		this.options.duck(this.duckGain, this.duckRampMs);
		steps.push('duck');

		this.options.flushPlayback();
		steps.push('flush');

		const result = this.options.cancelSpeech();
		steps.push('cancel-speech');

		// The rewrite behind the synthesis. Cancelling TTS alone leaves a Brain
		// writing sentences for a turn that is already over.
		this.options.cancelTranslation();
		steps.push('cancel-translation');

		const outcome: BargeInOutcome = {
			source,
			utteranceId: result?.utteranceId ?? null,
			spoken: result?.spoken ?? [],
			unspoken: result?.unspoken ?? [],
			steps,
			at: this.now(),
		};

		// Only what reached the speaker. The queued half never happened.
		if (outcome.spoken.length > 0) this.options.rememberSpoken?.(outcome.spoken);

		this.speechStartedAt = null;
		// Pushed before the callback runs, so a listener reading `outcome.steps`
		// sees the same list the caller gets back rather than one step short.
		steps.push('listening');
		this.options.toListening(outcome);

		return outcome;
	}
}

export function createBargeInController(options: BargeInControllerOptions): BargeInController {
	return new BargeInController(options);
}

function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return value < 0 ? 0 : value > 1 ? 1 : value;
}
