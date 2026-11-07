/**
 * The streaming policy every local speech-to-text engine shares.
 *
 * Whisper and Parakeet are different models with the same shape at this seam:
 * each transcribes a BUFFER, not a stream. The policy that turns a buffer engine
 * into live text is identical for both, so it lives here once and each provider
 * names only its catalog model and its limits. Two copies of this file would
 * drift on exactly the parts that were expensive to get right.
 *
 * **The engine is the core's, and it is shared.** The inference lives in
 * `src/main/local-models/stt/`, and a session takes a LEASE on the loaded model
 * from the Local Models speech-to-text pool (`speech-to-text.ts`) rather than
 * building its own. The transcription wake word and a dictated clip lease the
 * same model, so one copy of the encoder serves all three.
 *
 * **Chunked, not truly streaming.** The utterance so far is re-transcribed on a
 * cadence and published as a partial. Words near the start stop changing between
 * passes (that is what "stabilise" means here) while the tail keeps being
 * revised, which is exactly what a partial transcript is supposed to look like.
 * The final pass runs on endpointing and is the only one whose text is dispatched.
 *
 * **One decode at a time, always.** A pass takes longer than the interval on a
 * slow machine, so a second pass starting while the first is running would queue
 * decodes until the process fell over. Partials are SKIPPED while busy rather
 * than queued: a partial that arrives late is worthless, and the next pass will
 * cover the same audio anyway. The final WAITS for a partial in flight instead of
 * racing it: two greedy loops on the same decoder session hand each other's
 * recurrent state back, and ONNX Runtime reports that as a reshape failure deep
 * inside the graph - which is how a live session died on its first endpoint.
 * The pool holds the same rule across consumers: every decode on a model runs
 * through one queue, whoever asked for it.
 *
 * **Silence is not decoded.** The capture path feeds every frame while the floor
 * is open and marks each one with its voice-activity verdict. Until the detector
 * has heard speech, the provider keeps only a second of context and runs no pass
 * at all: a recogniser fed a quiet room every 900 ms burns a core and, in
 * Whisper's case, invents "(keyboard clacking)" and "[ Silence ]" with total
 * confidence. Anything that still comes back looking like one of those is
 * dropped rather than published, because a bracketed sound effect dispatched to
 * an agent is a prompt nobody said. A caller that gives no verdict (the harness,
 * the tests) is trusted, and every frame counts as speech.
 *
 * **Nothing loads until a session starts.** The lease is taken on `start()` and
 * given back on `stop()`; the pool frees the graphs once no consumer has held
 * the model for a few minutes. Hundreds of megabytes of model resident for the
 * life of an app whose voice feature is off is exactly the cost the lazy loader
 * exists to avoid, and the failure to load reaches the user through the
 * capability gate rather than as a dlopen string.
 */

import { ACAPPELLA_AUDIO_SAMPLE_RATE } from '../../../../shared/acappella/audio-host';
import { VoiceProviderError } from '../../../../shared/acappella/provider-errors';
import type {
	SttCallbacks,
	SttFeedHint,
	SttProvider,
} from '../../../../shared/acappella/providers';
import { estimateSpokenDurationMs } from '../../../../shared/acappella/sentences';
import { normalizeSpeechVocabulary } from '../../../../shared/acappella/speech-vocabulary';
import { isLocalModelError } from '../../../local-models/errors';
import type { OnnxModule } from '../../../local-models/runtime/onnx-types';
import { getSpeechToTextPool, type SpeechToTextPool } from '../../../local-models/speech-to-text';
import type {
	SpeechToTextEngine,
	SpeechToTextDecodeOptions,
} from '../../../local-models/stt/engines';
import { sanitizeTranscript } from '../../../local-models/stt/transcript';
import { logger } from '../../../utils/logger';
import { PcmBuffer } from '../pcm';
import { loadVoiceRuntime, voiceErrorFromLocalModel } from './runtime';

// The rule for what a recogniser's raw text may become is the core's, shared
// with dictation. Re-exported so existing importers keep their one import site.
export { sanitizeTranscript };

const LOG_CONTEXT = 'ACappella';

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
 * Below this the utterance is a cough, and a recogniser's answer to a cough is a
 * confident sentence nobody said.
 */
const MIN_SPEECH_MS_FOR_DECODE = 200;

/** What a local engine provides: open, close, and transcribe one buffer. */
export type LocalSttEngine = SpeechToTextEngine;

export interface ChunkedLocalSttOptions {
	partialIntervalMs?: number;
	/** A fixed source per live session, resolved from the core Dictation setting. */
	resolveSource?: () => Promise<{ modelId: string; language: string }>;
	/** Injected in tests. Production shares the app-wide pool. */
	pool?: SpeechToTextPool;
	/**
	 * Injected in tests, so the streaming policy can be exercised without ONNX.
	 * A provider given its own engine loads and frees it itself and never
	 * touches the pool.
	 */
	engine?: LocalSttEngine;
	/** The runtime loader for an injected {@link engine}. */
	loadRuntime?: typeof loadVoiceRuntime;
}

/** The recogniser a session is holding: transcribe, and give it back. */
interface HeldRecogniser {
	transcribe(audio: Float32Array, options?: SpeechToTextDecodeOptions): Promise<string>;
	release(): Promise<void>;
}

export abstract class ChunkedLocalSttProvider implements SttProvider {
	abstract readonly id: string;
	abstract readonly label: string;
	readonly tier = 'local' as const;
	readonly sampleRate = ACAPPELLA_AUDIO_SAMPLE_RATE;
	readonly acceptsAudio = true;

	/** The model's name as the user knows it, for failure messages. */
	protected abstract readonly engineName: string;
	/** The catalog model this provider transcribes with. */
	protected abstract readonly modelId: string;
	/**
	 * The longest buffer one pass accepts. A longer utterance is transcribed from
	 * its TAIL rather than truncated at the front: someone who has been speaking
	 * for a minute cares about what they just said, and chunking and stitching
	 * would publish a partial that disagrees with the one before it.
	 */
	protected abstract readonly maxSamples: number;

	private readonly partialIntervalMs: number;
	private readonly pool?: SpeechToTextPool;
	private readonly loadRuntime: typeof loadVoiceRuntime;
	private readonly injectedEngine?: LocalSttEngine;
	private readonly resolveSource?: ChunkedLocalSttOptions['resolveSource'];
	private sharedMaxSamples?: number;

	private callbacks: SttCallbacks | null = null;
	private vocabulary: string[] = [];
	private engine: HeldRecogniser | null = null;
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

	constructor(options: ChunkedLocalSttOptions = {}) {
		this.partialIntervalMs = Math.max(0, options.partialIntervalMs ?? DEFAULT_PARTIAL_INTERVAL_MS);
		this.pool = options.pool;
		this.loadRuntime = options.loadRuntime ?? loadVoiceRuntime;
		this.injectedEngine = options.engine;
		this.resolveSource = options.resolveSource;
	}

	async start(callbacks: SttCallbacks): Promise<void> {
		this.engine = this.injectedEngine
			? await this.openInjected(this.injectedEngine)
			: await this.openShared();
		this.callbacks = callbacks;
		this.resetUtterance();
	}

	setVocabulary(terms: readonly string[]): void {
		this.vocabulary = normalizeSpeechVocabulary(terms);
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
		// A partial still running holds the decoder's state. Wait for it rather
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
		await engine?.release();
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

	/**
	 * Lease the catalog model from the shared pool. A core failure (not
	 * downloaded, runtime will not load, graphs will not open) is restated as
	 * this provider's own, so the session announces the engine the user chose.
	 */
	private async openShared(): Promise<HeldRecogniser> {
		try {
			const source = await this.resolveSource?.();
			const lease = await (this.pool ?? getSpeechToTextPool()).acquire(
				source?.modelId ?? this.modelId,
				this.id
			);
			this.sharedMaxSamples = lease.maxSamples;
			if (!source) return lease;
			return {
				transcribe: (audio, options) =>
					lease.transcribe(audio, { ...options, language: source.language }),
				release: () => lease.release(),
			};
		} catch (error) {
			if (isLocalModelError(error)) throw voiceErrorFromLocalModel(error, this.id);
			throw error;
		}
	}

	/** A test's own engine: loaded here, freed on release, never pooled. */
	private async openInjected(engine: LocalSttEngine): Promise<HeldRecogniser> {
		// ONNX Runtime for every local recogniser: the wake word already fetches it,
		// so local speech-to-text costs no extra runtime download.
		const module = await this.loadRuntime<OnnxModule>('onnx', this.id);
		await engine.load(module);
		return {
			transcribe: (audio, options) => engine.transcribe(audio, options),
			release: () => engine.unload(),
		};
	}

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
			const maxSamples = this.sharedMaxSamples ?? this.maxSamples;
			const windowed =
				samples.length > maxSamples ? samples.subarray(samples.length - maxSamples) : samples;
			const decodeStartedAt = Date.now();
			const raw = await engine.transcribe(windowed, { vocabulary: this.vocabulary });
			const text = sanitizeTranscript(raw);
			if (kind === 'final') {
				// One line per utterance: the decode time is the recogniser's share of
				// the turn's latency, and an empty result after real speech is the
				// difference between "it heard nothing" and "it threw the text away".
				logger.info(
					`${this.engineName} final: ${Math.round(durationMs)} ms of audio decoded in ${Date.now() - decodeStartedAt} ms, ${text.length} chars${raw.trim() && !text ? ' (dropped as non-speech)' : ''}`,
					LOG_CONTEXT
				);
			}
			// The session may have ended, or the utterance been superseded, while the
			// decode ran. Publishing now would put an old transcript on a new turn.
			if (this.callbacks !== callbacks) {
				if (kind === 'final') {
					logger.info(
						`${this.engineName} final discarded: the session ended during the decode`,
						LOG_CONTEXT
					);
				}
				return;
			}

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
				logger.warn(
					`${this.engineName} dropped a partial pass: ${(error as Error).message}`,
					LOG_CONTEXT
				);
				return;
			}
			// A final failure is classified rather than thrown: it arrives from a
			// frame callback with no caller, and the session has a path for a named
			// provider failure but not for a rejected promise from nowhere.
			callbacks.onError(
				error instanceof VoiceProviderError
					? error
					: new VoiceProviderError(
							`${this.engineName} could not transcribe this utterance: ${(error as Error).message}`,
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
