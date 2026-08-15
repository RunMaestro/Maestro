/**
 * Echo speech-to-text: a development provider that hears audio and says how much
 * of it was speech.
 *
 * It transcribes nothing. What it does is close the loop that no other provider
 * can close until Phase 05 lands Whisper and OpenAI: PCM goes in, speech segments
 * come out, and every downstream stage - partial transcripts, routing, dispatch,
 * a spoken reply, barge-in - runs against a real microphone rather than against
 * typed text. Without it the whole audio path from Phase 02 is unexercised code
 * until a model download lands.
 *
 * **Why it runs its own detector.** The pipeline already has a VAD, and it
 * already forwards its endpoint as a `flush()`. Echo could lean on that, and then
 * it would only work when fed by that one caller. A recogniser owns its own
 * segmentation - that is most of what a streaming recogniser IS - so this one
 * does too, and a test can drive it with generated tone frames and no pipeline at
 * all. The cost is one extra pass over 320 samples per frame.
 *
 * **Placeholder text, not fake words.** The transcript says `Echo utterance 2:
 * 1.4s of speech` rather than an invented sentence. Inventing plausible words
 * would make a demo that reads as a real recogniser failing, and the first person
 * to see one would file the bug that the model is terrible. The measured duration
 * is genuinely useful, too: it is the fastest way to see that a room's noise
 * floor is opening the mic on the fan.
 *
 * Registered as a development-only provider (see `provider-registry.ts`), so a
 * packaged build cannot resolve it even if the setting names it.
 */

import { ACAPPELLA_AUDIO_SAMPLE_RATE } from '../../../shared/acappella/audio-host';
import type { SttCallbacks, SttProvider } from '../../../shared/acappella/providers';
import { estimateSpokenDurationMs } from '../../../shared/acappella/sentences';
import { VoiceActivityDetector, type VadConfig } from '../audio/vad';

/** The id the registry and the settings key use. Shared so the two cannot drift. */
export const ECHO_STT_PROVIDER_ID = 'echo-stt';

/**
 * Audio time between partials inside one segment. A real streaming recogniser
 * revises its hypothesis a few times a second; less often than that and the HUD
 * looks frozen mid-utterance, more often and it is jitter nobody reads.
 */
const DEFAULT_PARTIAL_INTERVAL_MS = 400;

/**
 * Simulated decoder latency between the endpoint and the final transcript. Real
 * recognisers all have some; a pipeline demonstrated with none would hide every
 * ordering bug that only shows up when the final lands late.
 */
const DEFAULT_FINAL_DELAY_MS = 250;

/** Rising across the partials of one segment, the way a real hypothesis firms up. */
const FIRST_PARTIAL_STABILITY = 0.3;
const PARTIAL_STABILITY_STEP = 0.15;
const MAX_PARTIAL_STABILITY = 0.9;

/**
 * What the placeholder claims. Not 1: this provider is a stand-in for a
 * recogniser, and a client that dims low-confidence transcripts should have
 * something to dim.
 */
const ECHO_FINAL_CONFIDENCE = 0.9;

/** Typed text is not a guess, so the text-in seam reports no doubt. */
const INJECTED_FINAL_CONFIDENCE = 1;

export interface EchoSttOptions {
	/** Detector overrides. The defaults are the pipeline's. */
	vad?: Partial<VadConfig>;
	/** Audio time between partials within a segment. */
	partialIntervalMs?: number;
	/** Simulated decoder latency before the final. Tests pass 0 to stay synchronous. */
	finalDelayMs?: number;
}

export class EchoSttProvider implements SttProvider {
	readonly id = ECHO_STT_PROVIDER_ID;
	readonly label = 'Echo (development)';
	/** Mock tier: no model, no network, nothing to install. */
	readonly tier = 'mock' as const;
	readonly sampleRate = ACAPPELLA_AUDIO_SAMPLE_RATE;
	readonly acceptsAudio = true;

	private readonly vad: VoiceActivityDetector;
	private readonly partialIntervalMs: number;
	private readonly finalDelayMs: number;
	private readonly timers = new Set<ReturnType<typeof setTimeout>>();

	private callbacks: SttCallbacks | null = null;
	/** Detector time the open segment started, or null when the floor is closed. */
	private segmentStartedAtMs: number | null = null;
	/** Segments completed this run, so a transcript can be told from the one before it. */
	private segmentIndex = 0;
	private partialsInSegment = 0;
	private lastPartialAtMs = 0;

	constructor(options: EchoSttOptions = {}) {
		this.vad = new VoiceActivityDetector(options.vad);
		this.partialIntervalMs = Math.max(0, options.partialIntervalMs ?? DEFAULT_PARTIAL_INTERVAL_MS);
		this.finalDelayMs = Math.max(0, options.finalDelayMs ?? DEFAULT_FINAL_DELAY_MS);
	}

	async start(callbacks: SttCallbacks): Promise<void> {
		this.callbacks = callbacks;
		this.resetRun();
	}

	/**
	 * One 20 ms frame. Segmentation, partials, and the final all come out of here:
	 * synchronous, allocation-free beyond the detector's own measurement, and safe
	 * to call 50 times a second.
	 */
	feed(pcm: Int16Array): void {
		if (!this.callbacks) return;

		const result = this.vad.process(pcm);

		if (result.event?.type === 'speech-start') {
			this.segmentStartedAtMs = result.event.atMs;
			this.partialsInSegment = 0;
			this.lastPartialAtMs = result.event.atMs;
			return;
		}

		if (result.event?.type === 'speech-end') {
			// The detector's own duration excludes the endpoint silence, which is what
			// a transcript should report: the user spoke for 1.4 s, not 2.1 s.
			this.completeSegment(result.event.durationMs);
			return;
		}

		if (this.segmentStartedAtMs === null) return;
		if (this.partialIntervalMs <= 0) return;
		if (result.elapsedMs - this.lastPartialAtMs < this.partialIntervalMs) return;

		this.lastPartialAtMs = result.elapsedMs;
		this.partialsInSegment += 1;
		const elapsed = result.elapsedMs - this.segmentStartedAtMs;
		this.emit((callbacks) =>
			callbacks.onPartial(partialText(this.segmentIndex + 1, elapsed), this.partialStability())
		);
	}

	/**
	 * Endpoint now.
	 *
	 * Two callers, and both mean the same thing: the pipeline forwarding its own
	 * VAD's `speech-end`, and floor control releasing a push-to-talk key. Silence
	 * produces nothing - a flush with no open segment is not an empty transcript,
	 * it is no transcript.
	 */
	async flush(): Promise<void> {
		if (this.segmentStartedAtMs === null) return;
		const durationMs = this.vad.elapsedMs - this.segmentStartedAtMs;
		// The detector is still holding the floor open, and its own `speech-end` is
		// coming. Reset so that endpoint cannot report the same audio a second time,
		// and so whatever is said next opens a segment of its own rather than
		// waiting out the pause that the user already declared over.
		this.vad.reset();
		this.completeSegment(durationMs);
	}

	async stop(): Promise<void> {
		this.clearTimers();
		this.callbacks = null;
		this.resetRun();
	}

	/**
	 * The text-in seam: the Phase 01 dev harness, and any client that typed
	 * instead of spoke.
	 *
	 * It lands as a synthetic FINAL transcript with no partials in front of it,
	 * because there is no hypothesis to revise - the text was already settled when
	 * it arrived. Anything pending from the microphone is dropped first: a typed
	 * utterance supersedes whatever was being spoken over it.
	 */
	injectUtterance(text: string): void {
		this.clearTimers();
		this.segmentStartedAtMs = null;
		this.vad.reset();

		const utterance = text.trim();
		this.emit((callbacks) =>
			callbacks.onFinal(
				utterance,
				INJECTED_FINAL_CONFIDENCE,
				utterance ? estimateSpokenDurationMs(utterance) : 0
			)
		);
	}

	// -- Internals -----------------------------------------------------------

	/** Close the open segment and schedule its final transcript. */
	private completeSegment(durationMs: number): void {
		this.segmentStartedAtMs = null;
		this.partialsInSegment = 0;
		const index = ++this.segmentIndex;
		const text = segmentText(index, Math.max(0, durationMs));

		if (this.finalDelayMs <= 0) {
			this.emit((callbacks) => callbacks.onFinal(text, ECHO_FINAL_CONFIDENCE, durationMs));
			return;
		}

		const timer = setTimeout(() => {
			this.timers.delete(timer);
			this.emit((callbacks) => callbacks.onFinal(text, ECHO_FINAL_CONFIDENCE, durationMs));
		}, this.finalDelayMs);
		this.timers.add(timer);
	}

	private partialStability(): number {
		return Math.min(
			MAX_PARTIAL_STABILITY,
			FIRST_PARTIAL_STABILITY + PARTIAL_STABILITY_STEP * (this.partialsInSegment - 1)
		);
	}

	/** A scheduled final can outlive `stop()`, so every emission re-checks the run. */
	private emit(emit: (callbacks: SttCallbacks) => void): void {
		if (!this.callbacks) return;
		emit(this.callbacks);
	}

	private resetRun(): void {
		this.vad.reset();
		this.segmentStartedAtMs = null;
		this.segmentIndex = 0;
		this.partialsInSegment = 0;
		this.lastPartialAtMs = 0;
	}

	private clearTimers(): void {
		for (const timer of this.timers) clearTimeout(timer);
		this.timers.clear();
	}
}

/** Sugar matching the rest of A Cappella's factories. */
export function createEchoSttProvider(options: EchoSttOptions = {}): EchoSttProvider {
	return new EchoSttProvider(options);
}

// ---------------------------------------------------------------------------

function seconds(durationMs: number): string {
	return (durationMs / 1000).toFixed(1);
}

/** Growing, and visibly unfinished, so nobody mistakes a partial for a result. */
function partialText(index: number, elapsedMs: number): string {
	return `Echo utterance ${index}: ${seconds(elapsedMs)}s...`;
}

function segmentText(index: number, durationMs: number): string {
	return `Echo utterance ${index}: ${seconds(durationMs)}s of speech.`;
}
