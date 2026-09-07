/**
 * Local speech-to-text on Whisper, running on ONNX Runtime.
 *
 * **Chunked, not truly streaming.** Whisper transcribes a buffer, not a stream:
 * there is no incremental decoder to feed. The standard way to get live text out
 * of it, and the one used here, is to re-transcribe the utterance so far on a
 * cadence and publish the result as a partial. Words near the start stop changing
 * between passes (that is what "stabilise" means here) while the tail keeps being
 * revised, which is exactly what a partial transcript is supposed to look like.
 * The final pass runs on endpointing and is the only one whose text is dispatched.
 *
 * **One decode at a time, always.** A pass takes longer than the interval on a
 * slow machine, so a second pass starting while the first is running would queue
 * decodes until the process fell over. Partials are SKIPPED while busy rather
 * than queued: a partial that arrives late is worthless, and the next pass will
 * cover the same audio anyway. The final WAITS for a partial in flight instead of
 * racing it: two greedy loops on the same decoder session hand each other's
 * key/value caches back, and ONNX Runtime reports that as a reshape failure deep
 * inside the graph - which is how a live session died on its first endpoint.
 *
 * **Silence is not decoded.** The capture path feeds every frame while the floor
 * is open and marks each one with its voice-activity verdict. Until the detector
 * has heard speech, this provider keeps only a second of context and runs no
 * pass at all: Whisper fed a quiet room every 900 ms burns a core and invents
 * "(keyboard clacking)" and "[ Silence ]" with total confidence. Anything that
 * still comes back looking like one of those is dropped rather than published,
 * because a bracketed sound effect dispatched to an agent is a prompt nobody
 * said. A caller that gives no verdict (the harness, the tests) is trusted, and
 * every frame counts as speech.
 *
 * **Nothing loads until a session starts.** The graphs are opened on `start()`
 * through `native-loader.ts` and freed on `stop()`. Two hundred megabytes of
 * model resident for the life of an app whose voice feature is off is exactly
 * the cost the lazy loader exists to avoid, and the failure to load reaches the
 * user through the capability gate rather than as a dlopen string.
 *
 * The inference itself lives in `whisper/engine.ts`. This file owns the STREAMING
 * policy - cadence, stability, endpointing, what is published and when - and that
 * split is deliberate: the engine is a pure function of audio, so it can be tested
 * against reference transcripts without a session, a clock, or a microphone.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ACAPPELLA_AUDIO_SAMPLE_RATE } from '../../../../shared/acappella/audio-host';
import { WHISPER_BASE_EN_ID } from '../../../../shared/acappella/model-catalog';
import { LOCAL_STT_PROVIDER_ID } from '../../../../shared/acappella/provider-catalog';
import { VoiceProviderError } from '../../../../shared/acappella/provider-errors';
import type {
	SttCallbacks,
	SttFeedHint,
	SttProvider,
} from '../../../../shared/acappella/providers';
import { estimateSpokenDurationMs } from '../../../../shared/acappella/sentences';
import { logger } from '../../../utils/logger';
import { modelFilePath } from '../../models/model-store';
import { loadLocalRuntime } from './runtime';
import { PcmBuffer } from '../pcm';
import { WhisperEngine, WHISPER_MAX_SAMPLES, type OnnxModule } from './whisper/engine';

const LOG_CONTEXT = 'ACappella';

/**
 * The catalog files this provider loads, by their path inside the model dir.
 *
 * Named here rather than inlined so the set a decode needs and the set the
 * catalog downloads can be compared at a glance when either changes.
 */
const ENCODER_FILE = 'onnx/encoder_model.onnx';
const DECODER_FILE = 'onnx/decoder_model_merged_q4.onnx';
const TOKENIZER_FILE = 'tokenizer.json';

/**
 * Audio accumulated between partial passes. Under half a second the re-decode
 * costs more than the extra word is worth; over about a second and a half the
 * transcript visibly lags the speaker.
 */
const DEFAULT_PARTIAL_INTERVAL_MS = 900;

/** Rising across the passes of one utterance, the way a hypothesis firms up. */
const FIRST_PARTIAL_STABILITY = 0.3;
const PARTIAL_STABILITY_STEP = 0.15;
const MAX_PARTIAL_STABILITY = 0.9;

/**
 * A greedy local decode reports no confidence. 0.95 rather than 1 says "a
 * recogniser produced this" without claiming certainty the model never expressed.
 */
const LOCAL_FINAL_CONFIDENCE = 0.95;

/**
 * Audio kept ahead of the first speech frame. Enough for the detector's
 * enter-hysteresis and the onset of the first word, not enough to carry a quiet
 * minute into the decode.
 */
const PRE_SPEECH_KEEP_MS = 1000;

/**
 * Speech the detector must have confirmed before a pass is worth running.
 * Below this the utterance is a cough, and Whisper's answer to a cough is a
 * confident sentence nobody said.
 */
const MIN_SPEECH_MS_FOR_DECODE = 200;

export interface WhisperSttOptions {
	partialIntervalMs?: number;
	/** Directory override for the model files. Defaults to the installed catalog model. */
	modelDir?: string;
	/** Injected in tests; production goes through `native-loader.ts`. */
	loadRuntime?: typeof loadLocalRuntime;
	/** Injected in tests, so the streaming policy can be exercised without ONNX. */
	engine?: WhisperEngineLike;
}

/** What this provider needs of {@link WhisperEngine}, so a test can stand in for it. */
export interface WhisperEngineLike {
	load(module: OnnxModule): Promise<void>;
	unload(): Promise<void>;
	transcribe(audio: Float32Array): Promise<string>;
}

export class WhisperSttProvider implements SttProvider {
	readonly id = LOCAL_STT_PROVIDER_ID;
	readonly label = 'Whisper (local)';
	readonly tier = 'local' as const;
	readonly sampleRate = ACAPPELLA_AUDIO_SAMPLE_RATE;
	readonly acceptsAudio = true;

	private readonly partialIntervalMs: number;
	private readonly modelDirOverride?: string;
	private readonly loadRuntime: typeof loadLocalRuntime;
	private readonly injectedEngine?: WhisperEngineLike;

	private callbacks: SttCallbacks | null = null;
	private engine: WhisperEngineLike | null = null;
	private buffer = new PcmBuffer();

	/** Audio duration at the last partial pass, so the cadence is in AUDIO time. */
	private lastPartialAtMs = 0;
	private partialsInUtterance = 0;
	/** The pass in flight, so a final can wait for a partial rather than race it. */
	private inFlight: Promise<void> | null = null;
	/**
	 * Whether any caller has ever passed a voice-activity verdict. Once one has,
	 * silence is left undecoded; until then every frame is trusted as speech.
	 */
	private hinted = false;
	/** Detector-confirmed speech in the current utterance. */
	private speechMs = 0;

	constructor(options: WhisperSttOptions = {}) {
		this.partialIntervalMs = Math.max(0, options.partialIntervalMs ?? DEFAULT_PARTIAL_INTERVAL_MS);
		this.modelDirOverride = options.modelDir;
		this.loadRuntime = options.loadRuntime ?? loadLocalRuntime;
		this.injectedEngine = options.engine;
	}

	async start(callbacks: SttCallbacks): Promise<void> {
		// ONNX Runtime, not a whisper-specific runtime: text-to-speech and the wake
		// word already fetch it, so local speech-to-text costs no extra download.
		const module = await this.loadRuntime<OnnxModule>('onnx', this.id);

		const engine =
			this.injectedEngine ??
			new WhisperEngine({
				encoderPath: this.modelFile(ENCODER_FILE),
				decoderPath: this.modelFile(DECODER_FILE),
				tokenizerJson: await readFile(this.modelFile(TOKENIZER_FILE), 'utf8'),
				providerId: this.id,
			});

		await engine.load(module);
		this.engine = engine;
		this.callbacks = callbacks;
		this.resetUtterance();
	}

	/** Absolute path of one catalog file, honouring a test's directory override. */
	private modelFile(relative: string): string {
		return this.modelDirOverride
			? join(this.modelDirOverride, relative)
			: modelFilePath(WHISPER_BASE_EN_ID, relative);
	}

	feed(pcm: Int16Array, hint?: SttFeedHint): void {
		if (!this.callbacks) return;
		this.buffer.push(pcm);

		if (hint) {
			this.hinted = true;
			if (hint.speech) this.speechMs += (pcm.length / this.sampleRate) * 1000;
		}

		// Nothing said yet: hold a little context for the first word and do no work.
		if (this.hinted && this.speechMs === 0) {
			this.buffer.keepLast((PRE_SPEECH_KEEP_MS / 1000) * this.sampleRate);
			return;
		}

		if (this.partialIntervalMs <= 0 || this.inFlight) return;
		if (this.hinted && this.speechMs < MIN_SPEECH_MS_FOR_DECODE) return;
		if (this.buffer.durationMs - this.lastPartialAtMs < this.partialIntervalMs) return;

		this.lastPartialAtMs = this.buffer.durationMs;
		// Not awaited: `feed` runs 50 times a second on the frame path and must stay
		// synchronous. A rejected pass is reported through the callbacks.
		void this.decode('partial');
	}

	/** Endpoint: decode everything buffered and publish it as the transcript. */
	async flush(): Promise<void> {
		if (!this.callbacks) return;
		// A partial still running holds the decoder's caches. Wait for it rather
		// than starting a second loop over the same session.
		await this.inFlight?.catch(() => undefined);
		if (!this.callbacks) return;
		if (this.buffer.length === 0) return;

		if (this.hinted && this.speechMs < MIN_SPEECH_MS_FOR_DECODE) {
			// The detector endpointed on something it never called speech for long
			// enough to matter. Decoding it would publish a hallucination as a final.
			this.buffer.clear();
			this.resetUtterance();
			return;
		}
		await this.decode('final');
	}

	async stop(): Promise<void> {
		this.callbacks = null;
		this.buffer.clear();
		this.resetUtterance();

		const engine = this.engine;
		this.engine = null;
		// The session may still be inside a pass. Let it finish before the graphs
		// go away underneath it; its result is dropped because `callbacks` is gone.
		await this.inFlight?.catch(() => undefined);
		await engine?.unload();
	}

	/**
	 * The text-in seam, so the dev harness and a client that did its own
	 * transcription land on the same callbacks with no decode at all.
	 */
	injectUtterance(text: string): void {
		this.buffer.clear();
		this.resetUtterance();
		const utterance = text.trim();
		this.callbacks?.onFinal(utterance, 1, utterance ? estimateSpokenDurationMs(utterance) : 0);
	}

	// -- Internals -----------------------------------------------------------

	private decode(kind: 'partial' | 'final'): Promise<void> {
		const pass = this.runDecode(kind).finally(() => {
			if (this.inFlight === pass) this.inFlight = null;
		});
		this.inFlight = pass;
		return pass;
	}

	private async runDecode(kind: 'partial' | 'final'): Promise<void> {
		const engine = this.engine;
		const callbacks = this.callbacks;
		if (!engine || !callbacks) return;

		const samples = this.buffer.toFloat32();
		const durationMs = this.buffer.durationMs;
		if (samples.length === 0) return;

		try {
			// One encoder pass covers a fixed 30 s window, so a longer utterance is
			// transcribed from its TAIL rather than silently truncated at the front.
			// Someone who has been speaking for a minute cares about what they just
			// said, and the alternative - chunking and stitching - would publish a
			// partial that disagrees with the one before it on words already spoken.
			const windowed =
				samples.length > WHISPER_MAX_SAMPLES
					? samples.subarray(samples.length - WHISPER_MAX_SAMPLES)
					: samples;
			const text = sanitizeTranscript(await engine.transcribe(windowed));
			// The session may have ended, or the utterance been superseded, while the
			// decode ran. Publishing now would put an old transcript on a new turn.
			if (this.callbacks !== callbacks) return;

			if (kind === 'final') {
				this.buffer.clear();
				this.resetUtterance();
				if (text) callbacks.onFinal(text, LOCAL_FINAL_CONFIDENCE, durationMs);
				return;
			}

			if (!text) return;
			this.partialsInUtterance += 1;
			callbacks.onPartial(text, this.partialStability());
		} catch (error) {
			if (kind === 'partial') {
				// A partial is a preview. Losing one costs nothing the next pass will not
				// cover, whereas announcing it would park the session in `error` over
				// text nobody was waiting for.
				logger.warn(`Whisper dropped a partial pass: ${(error as Error).message}`, LOG_CONTEXT);
				return;
			}
			// A final failure is classified rather than thrown: it arrives from a
			// frame callback with no caller, and the session has a path for a named
			// provider failure but not for a rejected promise from nowhere.
			callbacks.onError(
				error instanceof VoiceProviderError
					? error
					: new VoiceProviderError(
							`Whisper could not transcribe this utterance: ${(error as Error).message}`,
							{ kind: 'unavailable', providerId: this.id, cause: error }
						)
			);
		}
	}

	private partialStability(): number {
		return Math.min(
			MAX_PARTIAL_STABILITY,
			FIRST_PARTIAL_STABILITY + PARTIAL_STABILITY_STEP * (this.partialsInUtterance - 1)
		);
	}

	private resetUtterance(): void {
		this.lastPartialAtMs = 0;
		this.partialsInUtterance = 0;
		this.speechMs = 0;
	}
}

// ---------------------------------------------------------------------------

/**
 * Phrases Whisper produces for audio with no speech in it. Matched whole, after
 * the bracketed tags are stripped: "you" alone is the model's favourite word for
 * silence, and nobody dictates it to an agent as a complete request.
 */
const NON_SPEECH_PHRASES =
	/^(?:you|thank you\.?|thanks for watching\.?|thank you for watching\.?|bye\.?|\.+)$/i;

/**
 * Drop what a recogniser invents for a quiet room.
 *
 * Whisper narrates silence as sound effects - "[ Silence ]", "(keyboard
 * clacking)", "[BLANK_AUDIO]", "♪" - and a partial that shows them is a
 * transcript of nothing, while a final that dispatches them is a prompt nobody
 * said. Tags are removed wherever they sit, so "(sighs) run the tests" keeps its
 * request; a transcript that was nothing but tags becomes empty.
 */
export function sanitizeTranscript(raw: string): string {
	const text = raw.replace(/\s+/g, ' ').trim();
	if (!text) return '';
	const stripped = text
		.replace(/[[(][^\])]*[\])]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	if (!stripped) return '';
	if (NON_SPEECH_PHRASES.test(stripped)) return '';
	// No letter or digit anywhere: punctuation and music notes are not words.
	if (!/[\p{L}\p{N}]/u.test(stripped)) return '';
	return stripped;
}
