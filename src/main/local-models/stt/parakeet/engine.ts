/**
 * Parakeet TDT inference on ONNX Runtime.
 *
 * NVIDIA's Parakeet TDT 0.6B v2, exported to ONNX by `istupakov/onnx-asr`. It
 * is the local recogniser because it gets the things dictated commands live on
 * right where Whisper Base does not: agent names, casing, and punctuation, at a
 * fraction of the latency (a 4.5 s utterance decodes in about 150 ms on an M-
 * series CPU). It is also a transducer, so it has no free-running decoder to
 * hallucinate a sentence out of a quiet room.
 *
 * **Three graphs, in order.**
 *
 *   1. `nemo128.onnx` turns raw 16 kHz samples into the 128-bin log-mel features
 *      NeMo trained on (pre-emphasis, windowing, per-feature normalisation). It
 *      ships with the model precisely so this file does not have to re-derive
 *      NeMo's front end in TypeScript and get one constant subtly wrong.
 *   2. The encoder runs once per pass and yields one 1024-wide vector per 80 ms
 *      frame (8x subsampling of the 10 ms feature hop).
 *   3. The decoder-joint graph runs the prediction network and the joiner in one
 *      call, per frame, carrying a two-layer LSTM state.
 *
 * **Token-and-Duration Transducer.** Each joint call returns the vocabulary
 * logits AND a distribution over how many encoder frames to skip next. Greedy
 * decoding takes the argmax of both: a non-blank token is emitted (and only then
 * does the LSTM state advance), and the duration moves the frame pointer. A zero
 * duration means "stay on this frame and emit again", capped so a degenerate
 * frame cannot loop forever. This mirrors `onnx-asr`'s reference loop exactly.
 */

import { LocalModelError } from '../../errors';
import { runtimeSetupLocation } from '../../runtime/runtime-consumers';
import type { OnnxModule, OnnxSession, OnnxTensor } from '../../runtime/onnx-types';

/** Sample rate the preprocessor graph was exported for. */
export const PARAKEET_SAMPLE_RATE = 16000;

/**
 * Longest buffer one pass accepts. The encoder handles far more, but every
 * partial re-decodes the whole utterance and attention cost grows with its
 * square, so a minute is where a live preview stops being worth its CPU.
 */
export const PARAKEET_MAX_SAMPLES = 60 * PARAKEET_SAMPLE_RATE;

/**
 * Prediction-network geometry: a two-layer LSTM, 640 wide. Fixed by the
 * checkpoint, and visible in the graph's `input_states_*` shape `[2, B, 640]`.
 */
const PRED_LAYERS = 2;
const PRED_HIDDEN = 640;

/**
 * Tokens one frame may emit before the pointer is forced forward. The
 * reference implementation's default; a real frame emits one or two.
 */
const DEFAULT_MAX_TOKENS_PER_STEP = 10;

/** The SentencePiece word-boundary marker. */
const WORD_BOUNDARY = '▁';
const BLANK_TOKEN = '<blk>';

export interface ParakeetEngineOptions {
	readonly preprocessorPath: string;
	readonly encoderPath: string;
	readonly decoderJointPath: string;
	/** Contents of `vocab.txt`: one `<token> <id>` per line, blank last. */
	readonly vocabText: string;
	readonly maxTokensPerStep?: number;
	/** Who is asking, so a classified failure can name its consumer. */
	readonly consumerId: string;
}

/** Parse `vocab.txt` into an id-indexed token table. */
export function parseParakeetVocab(text: string): { tokens: string[]; blank: number } {
	const tokens: string[] = [];
	for (const line of text.split('\n')) {
		const trimmed = line.replace(/\r$/, '');
		if (!trimmed) continue;
		// Split on the LAST space: the id is always the final field.
		const at = trimmed.lastIndexOf(' ');
		if (at <= 0) continue;
		const id = Number(trimmed.slice(at + 1));
		if (!Number.isInteger(id) || id < 0) continue;
		tokens[id] = trimmed.slice(0, at);
	}
	const blank = tokens.indexOf(BLANK_TOKEN);
	if (blank < 0) throw new Error('Parakeet vocabulary has no <blk> token');
	return { tokens, blank };
}

/** Join SentencePiece pieces into text. */
export function detokenizeParakeet(pieces: readonly string[]): string {
	return pieces.join('').split(WORD_BOUNDARY).join(' ').replace(/\s+/g, ' ').trim();
}

export class ParakeetEngine {
	private readonly maxTokensPerStep: number;

	private preprocessor: OnnxSession | null = null;
	private encoder: OnnxSession | null = null;
	private decoderJoint: OnnxSession | null = null;
	private vocab: { tokens: string[]; blank: number } | null = null;
	private tensorFactory: OnnxModule['Tensor'] | null = null;

	constructor(private readonly options: ParakeetEngineOptions) {
		this.maxTokensPerStep = options.maxTokensPerStep ?? DEFAULT_MAX_TOKENS_PER_STEP;
	}

	get ready(): boolean {
		return this.preprocessor !== null && this.encoder !== null && this.decoderJoint !== null;
	}

	/**
	 * Open the three graphs and the vocabulary.
	 *
	 * Failures are classified (a `LocalModelError`) rather than thrown raw: the
	 * recovery for every one of them is the Models page, not a bug report.
	 */
	async load(module: OnnxModule): Promise<void> {
		try {
			this.vocab = parseParakeetVocab(this.options.vocabText);
			// Sequential rather than Promise.all: the encoder is the bulk of the
			// download, and loading graphs at once raises peak memory for nothing.
			this.preprocessor = await module.InferenceSession.create(this.options.preprocessorPath);
			this.encoder = await module.InferenceSession.create(this.options.encoderPath);
			this.decoderJoint = await module.InferenceSession.create(this.options.decoderJointPath);
			this.tensorFactory = module.Tensor;
		} catch (error) {
			await this.unload();
			throw new LocalModelError('The Parakeet model could not be opened.', {
				code: 'generation-failed',
				recovery: `Verify or re-download it in ${runtimeSetupLocation('onnx')}.`,
				consumerId: this.options.consumerId,
				cause: error,
			});
		}
	}

	/** Release every session. Safe to call when nothing is loaded. */
	async unload(): Promise<void> {
		const sessions = [this.preprocessor, this.encoder, this.decoderJoint];
		this.preprocessor = null;
		this.encoder = null;
		this.decoderJoint = null;
		this.vocab = null;
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

	/** Transcribe 16 kHz mono audio. Returns trimmed text, empty for nothing. */
	async transcribe(audio: Float32Array): Promise<string> {
		const preprocessor = this.preprocessor;
		const encoder = this.encoder;
		const decoderJoint = this.decoderJoint;
		const vocab = this.vocab;
		const Tensor = this.tensorFactory;
		if (!preprocessor || !encoder || !decoderJoint || !vocab || !Tensor) {
			throw new LocalModelError('Parakeet was asked to transcribe before it loaded.', {
				code: 'generation-failed',
				recovery: 'Try again.',
				consumerId: this.options.consumerId,
			});
		}
		if (audio.length === 0) return '';

		const features = await preprocessor.run({
			waveforms: new Tensor('float32', audio, [1, audio.length]),
			waveforms_lens: new Tensor('int64', BigInt64Array.from([BigInt(audio.length)]), [1]),
		});
		const encoded = await encoder.run({
			audio_signal: requireOutput(features, 'features'),
			length: requireOutput(features, 'features_lens'),
		});

		// `[1, D, T]`, channel-major: frame `t` is every D-th value from offset `t`.
		const encoderOut = requireOutput(encoded, 'outputs');
		const [, width, frames] = encoderOut.dims;
		const encoderData = encoderOut.data as Float32Array;
		const validFrames = Math.min(
			frames,
			Number((requireOutput(encoded, 'encoded_lengths').data as BigInt64Array)[0])
		);

		const { tokens, blank } = vocab;
		const vocabSize = tokens.length;
		const zeroState = (): OnnxTensor =>
			new Tensor('float32', new Float32Array(PRED_LAYERS * PRED_HIDDEN), [
				PRED_LAYERS,
				1,
				PRED_HIDDEN,
			]);
		let state1 = zeroState();
		let state2 = zeroState();

		const emitted: number[] = [];
		const frame = new Float32Array(width);
		const targetLength = new Tensor('int32', Int32Array.from([1]), [1]);
		let t = 0;
		let emittedOnFrame = 0;

		while (t < validFrames) {
			for (let d = 0; d < width; d++) frame[d] = encoderData[d * frames + t];

			const out = await decoderJoint.run({
				encoder_outputs: new Tensor('float32', frame, [1, width, 1]),
				targets: new Tensor(
					'int32',
					Int32Array.from([emitted.length ? emitted[emitted.length - 1] : blank]),
					[1, 1]
				),
				target_length: targetLength,
				input_states_1: state1,
				input_states_2: state2,
			});

			const logits = requireOutput(out, 'outputs').data as Float32Array;
			const token = argmax(logits, 0, vocabSize);
			// Everything past the vocabulary is the duration head; its index IS the
			// number of frames to advance (this checkpoint's durations are 0..4).
			const step = argmax(logits, vocabSize, logits.length) - vocabSize;

			if (token !== blank) {
				// The prediction network only advances on an emitted token.
				state1 = requireOutput(out, 'output_states_1');
				state2 = requireOutput(out, 'output_states_2');
				emitted.push(token);
				emittedOnFrame += 1;
			}

			if (step > 0) {
				t += step;
				emittedOnFrame = 0;
			} else if (token === blank || emittedOnFrame >= this.maxTokensPerStep) {
				t += 1;
				emittedOnFrame = 0;
			}
		}

		return detokenizeParakeet(emitted.map((id) => tokens[id] ?? ''));
	}
}

function requireOutput(outputs: Record<string, OnnxTensor>, name: string): OnnxTensor {
	const tensor = outputs[name];
	if (!tensor) throw new Error(`Parakeet graph returned no '${name}'`);
	return tensor;
}

/** Index of the largest value in `data[from, to)`. */
function argmax(data: Float32Array, from: number, to: number): number {
	let best = from;
	let bestValue = -Infinity;
	for (let i = from; i < to; i++) {
		if (data[i] > bestValue) {
			bestValue = data[i];
			best = i;
		}
	}
	return best;
}
