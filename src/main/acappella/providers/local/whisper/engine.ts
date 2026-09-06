/**
 * Whisper inference on ONNX Runtime.
 *
 * **Why ONNX and not whisper.cpp.** The local tier used to reach for
 * `smart-whisper`, which publishes no prebuilt binary on any platform and runs
 * `node-gyp` at install time. That made local speech-to-text the one slot that
 * could never ship: there was nothing to download, so shipping it meant either
 * putting a C++ toolchain in front of every user or building, signing, and
 * hosting four platform binaries ourselves. Whisper also has official ONNX
 * exports, and ONNX Runtime is ALREADY a downloadable runtime here because
 * text-to-speech and the wake word need it. Moving speech-to-text onto it means
 * the hardest slot rides a runtime that is already fetched, already verified,
 * and already signed, and one whole native runtime disappears from the build.
 *
 * **The shape of a decode.** Encoder once per pass over the 30 s mel window,
 * then a greedy token-at-a-time loop over the merged decoder. `logits` is
 * argmaxed rather than sampled: this is a command being dictated, and the
 * user's own words are the target, so there is no creativity to want here.
 *
 * **The one non-obvious invariant, and it is the whole file.** The merged
 * decoder computes CROSS-ATTENTION key/value ONCE, on the pass where
 * `use_cache_branch` is false. Every later pass returns a length-1 PLACEHOLDER
 * in `present.*.encoder.*`. Feeding that placeholder back as the next pass's
 * `past_key_values.*.encoder.*` silently throws away the 1500-frame audio cache,
 * and the decoder - now attending to nothing - free-runs into a fluent repeating
 * phrase. It reads exactly like a broken model, which is why the guard is
 * spelled out at its only call site rather than left to a reader to infer.
 */

import { VoiceProviderError } from '../../../../../shared/acappella/provider-errors';
import {
	WhisperMelExtractor,
	WHISPER_N_FRAMES,
	WHISPER_N_MELS,
	WHISPER_N_SAMPLES,
	WHISPER_SAMPLE_RATE,
} from './mel';
import {
	WHISPER_EN_SPECIAL_TOKENS,
	WhisperTokenizer,
	type WhisperSpecialTokens,
} from './tokenizer';

/**
 * The ONNX Runtime surface this uses, structurally.
 *
 * Declared rather than imported: `onnxruntime-node` is a downloaded runtime, so
 * a static import would make it a build dependency and defeat the whole reason
 * it is fetched on demand.
 */
export interface OnnxTensor {
	readonly dims: readonly number[];
	readonly data: Float32Array | BigInt64Array | Uint8Array;
}

export interface OnnxSession {
	readonly inputNames: readonly string[];
	readonly outputNames: readonly string[];
	run(feeds: Record<string, OnnxTensor>): Promise<Record<string, OnnxTensor>>;
	release?(): Promise<void>;
}

export interface OnnxModule {
	InferenceSession: { create(path: string): Promise<OnnxSession> };
	Tensor: new (
		type: 'float32' | 'int64' | 'bool',
		data: Float32Array | BigInt64Array | Uint8Array,
		dims: readonly number[]
	) => OnnxTensor;
}

/**
 * Model geometry, read from the checkpoint's `config.json`.
 *
 * Present so a larger checkpoint is a catalog change rather than a code change.
 * The defaults describe `whisper-base.en`.
 */
export interface WhisperGeometry {
	readonly layers: number;
	readonly heads: number;
	readonly headDim: number;
}

export const WHISPER_BASE_GEOMETRY: WhisperGeometry = Object.freeze({
	layers: 6,
	heads: 8,
	headDim: 64,
});

export interface WhisperEngineOptions {
	readonly encoderPath: string;
	readonly decoderPath: string;
	readonly tokenizerJson: string;
	readonly geometry?: WhisperGeometry;
	readonly specialTokens?: WhisperSpecialTokens;
	/** Safety stop for the greedy loop. Whisper's own limit is 448. */
	readonly maxTokens?: number;
	/** Named for the error messages a failure surfaces as. */
	readonly providerId: string;
}

/**
 * Hard ceiling on generated tokens.
 *
 * Whisper's decoder positional embedding runs out at 448, and a runaway loop
 * without a ceiling would spin until the model happened to emit an end token.
 */
const DEFAULT_MAX_TOKENS = 448;

export class WhisperEngine {
	private readonly mel = new WhisperMelExtractor();
	private readonly geometry: WhisperGeometry;
	private readonly special: WhisperSpecialTokens;
	private readonly maxTokens: number;

	private encoder: OnnxSession | null = null;
	private decoder: OnnxSession | null = null;
	private tokenizer: WhisperTokenizer | null = null;
	private tensorFactory: OnnxModule['Tensor'] | null = null;

	constructor(private readonly options: WhisperEngineOptions) {
		this.geometry = options.geometry ?? WHISPER_BASE_GEOMETRY;
		this.special = options.specialTokens ?? WHISPER_EN_SPECIAL_TOKENS;
		this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
	}

	get ready(): boolean {
		return this.encoder !== null && this.decoder !== null && this.tokenizer !== null;
	}

	/**
	 * Open both graphs and the vocabulary.
	 *
	 * Failures are classified as `unavailable` rather than thrown raw: the
	 * recovery for every one of them is the Models page, not a bug report.
	 */
	async load(module: OnnxModule): Promise<void> {
		try {
			this.tokenizer = WhisperTokenizer.fromJson(this.options.tokenizerJson);
			// Sequential rather than Promise.all: both graphs are large, and loading
			// them at once doubles peak memory on the machines least able to spare it.
			this.encoder = await module.InferenceSession.create(this.options.encoderPath);
			this.decoder = await module.InferenceSession.create(this.options.decoderPath);
			this.tensorFactory = module.Tensor;
		} catch (error) {
			await this.unload();
			throw new VoiceProviderError(
				'The Whisper model could not be opened. Re-verify it in Settings > Extensions > A Cappella > Models.',
				{ kind: 'unavailable', providerId: this.options.providerId, cause: error }
			);
		}
	}

	/** Release both sessions. Safe to call when nothing is loaded. */
	async unload(): Promise<void> {
		const sessions = [this.encoder, this.decoder];
		this.encoder = null;
		this.decoder = null;
		this.tokenizer = null;
		this.tensorFactory = null;
		for (const session of sessions) {
			try {
				await session?.release?.();
			} catch {
				// A graph that will not close must not wedge session teardown; the
				// process is about to drop the handle either way.
			}
		}
	}

	/**
	 * Transcribe up to 30 seconds of 16 kHz mono audio.
	 *
	 * Returns trimmed text, empty when the model produced nothing.
	 */
	async transcribe(audio: Float32Array): Promise<string> {
		const encoder = this.encoder;
		const decoder = this.decoder;
		const tokenizer = this.tokenizer;
		const Tensor = this.tensorFactory;
		if (!encoder || !decoder || !tokenizer || !Tensor) {
			throw new VoiceProviderError('Whisper was asked to transcribe before it loaded.', {
				kind: 'unavailable',
				providerId: this.options.providerId,
			});
		}
		if (audio.length === 0) return '';

		const features = this.mel.extract(audio);
		const encoded = await encoder.run({
			input_features: new Tensor('float32', features, [1, WHISPER_N_MELS, WHISPER_N_FRAMES]),
		});
		const hidden = encoded[encoder.outputNames[0]];

		const { layers, heads, headDim } = this.geometry;
		const emptyCache = (): OnnxTensor =>
			new Tensor('float32', new Float32Array(0), [1, heads, 0, headDim]);

		const past: Record<string, OnnxTensor> = {};
		for (let layer = 0; layer < layers; layer++) {
			past[`past_key_values.${layer}.decoder.key`] = emptyCache();
			past[`past_key_values.${layer}.decoder.value`] = emptyCache();
			past[`past_key_values.${layer}.encoder.key`] = emptyCache();
			past[`past_key_values.${layer}.encoder.value`] = emptyCache();
		}

		// Priming sequence. `noTimestamps` is what makes the model emit plain words
		// instead of interleaved `<|0.00|>` segment markers.
		const prompt = [this.special.startOfTranscript, this.special.noTimestamps];
		const generated: number[] = [];
		let usingCache = false;

		// Two guards on top of the positional ceiling, both for the same failure:
		// a decoder that has nothing to attend to (silence, noise, a cough)
		// free-runs into a fluent loop and pays a decoder step for every token of
		// it. English runs at a few tokens a second, so a budget proportional to
		// the audio bounds the damage, and a tail that has repeated itself is
		// stopped the moment it is recognisable as a loop.
		const seconds = audio.length / WHISPER_SAMPLE_RATE;
		const budget = Math.min(
			this.maxTokens,
			TOKEN_BUDGET_FLOOR + Math.ceil(seconds) * TOKENS_PER_SECOND_BUDGET
		);

		for (let step = 0; step < budget; step++) {
			// First pass feeds the whole prompt; later passes feed only the newest
			// token, because everything before it is already in the cache.
			const inputIds = usingCache ? [generated[generated.length - 1]] : [...prompt, ...generated];

			const outputs = await decoder.run({
				input_ids: new Tensor('int64', BigInt64Array.from(inputIds.map((id) => BigInt(id))), [
					1,
					inputIds.length,
				]),
				encoder_hidden_states: hidden,
				use_cache_branch: new Tensor('bool', Uint8Array.from([usingCache ? 1 : 0]), [1]),
				...past,
			});

			const next = argmaxLastPosition(outputs.logits);
			if (next === this.special.endOfText) break;
			generated.push(next);
			if (hasRepeatingTail(generated)) {
				// Keep one copy of the phrase: the first time round it may have been
				// real, and the transcript filter upstream decides whether it was.
				generated.length -= repeatingPeriod(generated) * (REPEATS_TO_STOP - 1);
				break;
			}

			for (let layer = 0; layer < layers; layer++) {
				past[`past_key_values.${layer}.decoder.key`] = outputs[`present.${layer}.decoder.key`];
				past[`past_key_values.${layer}.decoder.value`] = outputs[`present.${layer}.decoder.value`];
				// Cross-attention KV only exists on the first pass. See the file header:
				// copying the later placeholder back is what makes a healthy model
				// produce a confident, repeating, completely invented sentence.
				if (!usingCache) {
					past[`past_key_values.${layer}.encoder.key`] = outputs[`present.${layer}.encoder.key`];
					past[`past_key_values.${layer}.encoder.value`] =
						outputs[`present.${layer}.encoder.value`];
				}
			}
			usingCache = true;
		}

		return tokenizer.decode(generated).replace(/\s+/g, ' ').trim();
	}
}

/** Longest audio one pass accepts, so callers can window before they call. */
export const WHISPER_MAX_SAMPLES = WHISPER_N_SAMPLES;

/**
 * Tokens allowed regardless of audio length, then per second of it.
 *
 * Dictated English decodes to three or four tokens a second; the budget is
 * roughly three times that, so a fast talker is never cut and a loop over two
 * seconds of noise stops after a few dozen steps rather than 448.
 */
const TOKEN_BUDGET_FLOOR = 24;
const TOKENS_PER_SECOND_BUDGET = 12;

/** Longest phrase the loop detector looks for, in tokens. */
const MAX_REPEAT_PERIOD = 8;
/** Identical consecutive copies before the tail counts as a loop. */
const REPEATS_TO_STOP = 3;
/** Under this many tokens nothing is called a loop: "very very very" is English. */
const MIN_TAIL_FOR_LOOP = 8;

/** The period of the loop at the end of `tokens`, or 0 when there is none. */
function repeatingPeriod(tokens: readonly number[]): number {
	if (tokens.length < MIN_TAIL_FOR_LOOP) return 0;
	for (let period = 1; period <= MAX_REPEAT_PERIOD; period++) {
		const span = period * REPEATS_TO_STOP;
		if (tokens.length < span) break;
		let repeating = true;
		for (let i = tokens.length - span; i < tokens.length - period && repeating; i++) {
			if (tokens[i] !== tokens[i + period]) repeating = false;
		}
		if (repeating) return period;
	}
	return 0;
}

function hasRepeatingTail(tokens: readonly number[]): boolean {
	return repeatingPeriod(tokens) > 0;
}

/**
 * Greedy pick over the final position's logits.
 *
 * Only the LAST position matters even when several were fed: the earlier rows
 * are predictions for tokens that are already known.
 */
function argmaxLastPosition(logits: OnnxTensor | undefined): number {
	if (!logits) throw new Error('Whisper decoder returned no logits');
	const [, positions, vocab] = logits.dims;
	const data = logits.data as Float32Array;
	const offset = (positions - 1) * vocab;
	let best = 0;
	let bestValue = -Infinity;
	for (let i = 0; i < vocab; i++) {
		const value = data[offset + i];
		if (value > bestValue) {
			bestValue = value;
			best = i;
		}
	}
	return best;
}
