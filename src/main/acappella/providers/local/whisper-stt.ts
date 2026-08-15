/**
 * Local speech-to-text on whisper.cpp.
 *
 * **Chunked, not truly streaming.** whisper.cpp transcribes a buffer, not a
 * stream: there is no incremental decoder to feed. The standard way to get live
 * text out of it, and the one used here, is to re-transcribe the utterance so far
 * on a cadence and publish the result as a partial. Words near the start stop
 * changing between passes (that is what "stabilise" means here) while the tail
 * keeps being revised, which is exactly what a partial transcript is supposed to
 * look like. The final pass runs on endpointing and is the only one whose text is
 * dispatched.
 *
 * **One decode at a time.** A pass takes longer than the interval on a slow
 * machine, so a second pass starting while the first is running would queue
 * decodes until the process fell over. Partials are SKIPPED while busy rather
 * than queued: a partial that arrives late is worthless, and the next pass will
 * cover the same audio anyway.
 *
 * **Nothing loads until a session starts.** The model is opened on `start()`
 * through `native-loader.ts` and freed on `stop()`. A 148 MB model resident for
 * the life of an app whose voice feature is off is exactly the cost the lazy
 * loader exists to avoid, and the failure to load reaches the user through the
 * capability gate rather than as a dlopen string.
 */

import { ACAPPELLA_AUDIO_SAMPLE_RATE } from '../../../../shared/acappella/audio-host';
import { WHISPER_BASE_EN_ID } from '../../../../shared/acappella/model-catalog';
import { LOCAL_STT_PROVIDER_ID } from '../../../../shared/acappella/provider-catalog';
import { VoiceProviderError } from '../../../../shared/acappella/provider-errors';
import type { SttCallbacks, SttProvider } from '../../../../shared/acappella/providers';
import { estimateSpokenDurationMs } from '../../../../shared/acappella/sentences';
import { modelFilePath } from '../../models/model-store';
import { loadLocalRuntime } from './runtime';
import { PcmBuffer } from '../pcm';

/** The catalog file this provider loads. */
const MODEL_FILE = 'ggml-base.en.bin';

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
 * whisper.cpp is a local decode with no confidence to report. 0.95 rather than 1
 * says "a recogniser produced this" without claiming certainty the model never
 * expressed.
 */
const LOCAL_FINAL_CONFIDENCE = 0.95;

/** The `smart-whisper` surface this provider uses, structurally. */
interface WhisperSegment {
	text: string;
}

interface WhisperTask {
	result: Promise<WhisperSegment[]>;
}

interface WhisperInstance {
	transcribe(
		pcm: Float32Array,
		params?: Record<string, unknown>
	): Promise<WhisperTask> | WhisperTask;
	free(): Promise<void> | void;
}

interface WhisperModule {
	Whisper: new (modelPath: string, options?: Record<string, unknown>) => WhisperInstance;
}

export interface WhisperSttOptions {
	partialIntervalMs?: number;
	/** Absolute path override. Defaults to the installed catalog model. */
	modelPath?: string;
	/** Whether to ask whisper.cpp for GPU offload. */
	gpu?: boolean;
	/** Injected in tests; production goes through `native-loader.ts`. */
	loadRuntime?: typeof loadLocalRuntime;
}

export class WhisperSttProvider implements SttProvider {
	readonly id = LOCAL_STT_PROVIDER_ID;
	readonly label = 'Whisper (local)';
	readonly tier = 'local' as const;
	readonly sampleRate = ACAPPELLA_AUDIO_SAMPLE_RATE;
	readonly acceptsAudio = true;

	private readonly partialIntervalMs: number;
	private readonly modelPathOverride?: string;
	private readonly gpu: boolean;
	private readonly loadRuntime: typeof loadLocalRuntime;

	private callbacks: SttCallbacks | null = null;
	private whisper: WhisperInstance | null = null;
	private buffer = new PcmBuffer();

	/** Audio duration at the last partial pass, so the cadence is in AUDIO time. */
	private lastPartialAtMs = 0;
	private partialsInUtterance = 0;
	private decoding = false;

	constructor(options: WhisperSttOptions = {}) {
		this.partialIntervalMs = Math.max(0, options.partialIntervalMs ?? DEFAULT_PARTIAL_INTERVAL_MS);
		this.modelPathOverride = options.modelPath;
		this.gpu = options.gpu ?? true;
		this.loadRuntime = options.loadRuntime ?? loadLocalRuntime;
	}

	async start(callbacks: SttCallbacks): Promise<void> {
		const module = await this.loadRuntime<WhisperModule>('whisper', this.id);
		const modelPath = this.modelPathOverride ?? modelFilePath(WHISPER_BASE_EN_ID, MODEL_FILE);

		try {
			this.whisper = new module.Whisper(modelPath, { gpu: this.gpu });
		} catch (error) {
			// The runtime loaded and the model did not. Distinct from a runtime
			// failure, and its recovery is the model page rather than a bug report.
			throw new VoiceProviderError(
				'The Whisper model could not be opened. Re-verify it in Settings > Plugins > A Cappella > Models.',
				{ kind: 'unavailable', providerId: this.id, cause: error }
			);
		}

		this.callbacks = callbacks;
		this.resetUtterance();
	}

	feed(pcm: Int16Array): void {
		if (!this.callbacks) return;
		this.buffer.push(pcm);

		if (this.partialIntervalMs <= 0 || this.decoding) return;
		if (this.buffer.durationMs - this.lastPartialAtMs < this.partialIntervalMs) return;

		this.lastPartialAtMs = this.buffer.durationMs;
		// Not awaited: `feed` runs 50 times a second on the frame path and must stay
		// synchronous. A rejected pass is reported through the callbacks.
		void this.decode('partial');
	}

	/** Endpoint: decode everything buffered and publish it as the transcript. */
	async flush(): Promise<void> {
		if (!this.callbacks) return;
		if (this.buffer.length === 0) return;
		await this.decode('final');
	}

	async stop(): Promise<void> {
		this.callbacks = null;
		this.buffer.clear();

		const whisper = this.whisper;
		this.whisper = null;
		try {
			await whisper?.free();
		} catch {
			// A model that will not close cleanly must not wedge session teardown.
			// The process is about to drop the handle either way.
		}
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

	private async decode(kind: 'partial' | 'final'): Promise<void> {
		const whisper = this.whisper;
		const callbacks = this.callbacks;
		if (!whisper || !callbacks) return;

		const samples = this.buffer.toFloat32();
		const durationMs = this.buffer.durationMs;
		if (samples.length === 0) return;

		this.decoding = true;
		try {
			const task = await whisper.transcribe(samples, {
				language: 'en',
				// Suppresses whisper.cpp's "[BLANK_AUDIO]" style annotations, which are
				// not words and would be routed as if they were.
				suppress_non_speech_tokens: true,
			});
			const segments = await task.result;
			// The session may have ended, or the utterance been superseded, while the
			// decode ran. Publishing now would put an old transcript on a new turn.
			if (this.callbacks !== callbacks) return;

			const text = segments
				.map((segment) => segment.text)
				.join(' ')
				.replace(/\s+/g, ' ')
				.trim();

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
			// A decode failure is classified rather than thrown: it arrives from a
			// frame callback with no caller, and the session has a path for a named
			// provider failure but not for a rejected promise from nowhere.
			callbacks.onError(
				new VoiceProviderError(
					`Whisper could not transcribe this utterance: ${(error as Error).message}`,
					{ kind: 'unavailable', providerId: this.id, cause: error }
				)
			);
		} finally {
			this.decoding = false;
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
	}
}

/** Sugar matching the rest of A Cappella's factories. */
export function createWhisperSttProvider(options: WhisperSttOptions = {}): WhisperSttProvider {
	return new WhisperSttProvider(options);
}
