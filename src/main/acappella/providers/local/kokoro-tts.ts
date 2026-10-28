/**
 * Local text-to-speech on Kokoro, through ONNX Runtime.
 *
 * **Per sentence, and cancellable between sentences.** One inference run per
 * sentence means the first words are audible while the rest of the reply is still
 * being made, and `cancel()` has something small to interrupt. Barge-in that has
 * to wait out a whole synthesised paragraph does not feel like barge-in.
 *
 * **`cancel()` cuts the run, it does not wait for it.** The generator checks the
 * run token before every yield and after every await, so a cancelled run stops
 * delivering audio immediately even though the ONNX call it was inside has to
 * finish - ONNX Runtime has no mid-inference abort. The user hears silence at the
 * moment they interrupted, which is the property that matters; one orphaned
 * tensor is cheaper than a voice that talks over its interruption.
 *
 * ## The phoneme front end
 *
 * Kokoro takes PHONEME ids, not characters. Turning English text into phonemes
 * is a grapheme-to-phoneme step, and it is a real dependency, not a lookup
 * table: `kokoro/front-end.ts` runs espeak-ng (the `phonemizer` package, plain
 * JavaScript) through the text rules the voice was trained with, then maps the
 * result onto the ids in the model's own `tokenizer.json`. `phonemize` stays an
 * injectable seam for tests. If the front end cannot load, the provider
 * reports itself unavailable through the same classified path as a missing
 * model. It does NOT approximate: a character-level fallback would synthesise
 * confident nonsense, and a voice reading nonsense aloud is a worse failure
 * than a voice that says nothing and explains why.
 *
 * ## Long sentences
 *
 * The model takes at most 510 ids per run, and a sentence is not a safe unit:
 * 240 characters of digits phonemize to over a thousand. A long sequence is cut
 * at punctuation (`splitTokenRuns`), each run is synthesised with the style row
 * for ITS length, and the audio is joined, so a long sentence is slower, never
 * a failed inference. A sentence with nothing speakable in it (only characters
 * the vocabulary lacks) yields no audio instead of a run of two pad tokens.
 */

import { KOKORO_82M_ID } from '../../../../shared/local-models/model-catalog';
import { modelsSettingsLocation } from '../../../../shared/local-models/settings-location';
import { KOKORO_TTS_PROVIDER_ID } from '../../../../shared/acappella/provider-catalog';
import { VoiceProviderError } from '../../../../shared/acappella/provider-errors';
import type {
	TtsChunk,
	TtsProvider,
	TtsSpeakOptions,
} from '../../../../shared/acappella/providers';
import { splitIntoSpokenSentences } from '../../../../shared/acappella/sentences';
import { modelFilePath } from '../../../local-models/model-store';
import { float32ToInt16 } from '../pcm';
import { createKokoroFrontEnd } from './kokoro/front-end';
import { splitTokenRuns, type KokoroVocab } from './kokoro/tokens';
import { loadVoiceRuntime } from './runtime';

/** Catalog files this provider loads. */
const MODEL_FILE = 'onnx/model.onnx';
const TOKENIZER_FILE = 'tokenizer.json';

/**
 * The bundled voice. Kokoro voice packs are one file each, and only this one is
 * in the catalog, so it is the only id that can resolve without another download.
 */
const BUNDLED_VOICE = {
	id: 'af_heart',
	name: 'Heart (American English)',
	file: 'voices/af_heart.bin',
};

/** Kokoro outputs 24 kHz audio, whatever the capture path runs at. */
const KOKORO_SAMPLE_RATE = 24_000;

/**
 * A voice pack is a table of style vectors, one row per token count, each 256
 * floats wide. The row is picked by the length of the phoneme sequence.
 */
const STYLE_VECTOR_WIDTH = 256;

/** Kokoro's own bounds. Outside these the model produces artefacts, not speech. */
const MIN_SPEED = 0.5;
const MAX_SPEED = 2;

/** Turns text into the phoneme ids Kokoro's vocabulary uses. */
export type Phonemizer = (text: string) => Promise<number[]> | number[];

/** The ONNX Runtime surface this provider uses, structurally. */
interface OnnxTensor {
	data: Float32Array | BigInt64Array;
	dims: readonly number[];
}

interface OnnxSession {
	run(feeds: Record<string, OnnxTensor>): Promise<Record<string, OnnxTensor>>;
	release?(): Promise<void>;
}

interface OnnxModule {
	InferenceSession: {
		create(path: string, options?: Record<string, unknown>): Promise<OnnxSession>;
	};
	Tensor: new (
		type: string,
		data: Float32Array | BigInt64Array,
		dims: readonly number[]
	) => OnnxTensor;
}

/** Where a long token sequence may be cut. See `splitTokenRuns`. */
type TokenBoundaries = Pick<KokoroVocab, 'punctuation' | 'space'>;

const NO_BOUNDARIES: TokenBoundaries = { punctuation: new Set(), space: undefined };

export interface KokoroTtsOptions {
	/**
	 * Injected in tests. Production builds the real front end from the model's
	 * installed `tokenizer.json` (`createKokoroFrontEnd`).
	 */
	phonemize?: Phonemizer;
	/** Where to cut a long sequence, when `phonemize` is injected. Defaults to nowhere. */
	boundaries?: TokenBoundaries;
	modelPath?: string;
	tokenizerPath?: string;
	voicePackPath?: string;
	/** Injected in tests; production goes through `native-loader.ts`. */
	loadRuntime?: typeof loadVoiceRuntime;
	/** Injected in tests. Production reads the installed voice pack from disk. */
	readVoicePack?: (path: string) => Promise<Float32Array>;
}

export class KokoroTtsProvider implements TtsProvider {
	readonly id = KOKORO_TTS_PROVIDER_ID;
	readonly label = 'Kokoro (local neural voice)';
	readonly tier = 'local' as const;

	private phonemize?: Phonemizer;
	private boundaries: TokenBoundaries;
	private readonly modelPathOverride?: string;
	private readonly tokenizerPathOverride?: string;
	private readonly voicePackPathOverride?: string;
	private readonly loadRuntime: typeof loadVoiceRuntime;
	private readonly readVoicePack: (path: string) => Promise<Float32Array>;

	/** Bumped by `cancel()` and by every new run, so a stale iterator returns. */
	private run = 0;
	private session: OnnxSession | null = null;
	private tensorFactory: OnnxModule['Tensor'] | null = null;
	private voicePack: Float32Array | null = null;
	/** In-flight load, so two sentences racing do not each open the model. */
	private loading: Promise<void> | null = null;

	constructor(options: KokoroTtsOptions = {}) {
		this.phonemize = options.phonemize;
		this.boundaries = options.boundaries ?? NO_BOUNDARIES;
		this.modelPathOverride = options.modelPath;
		this.tokenizerPathOverride = options.tokenizerPath;
		this.voicePackPathOverride = options.voicePackPath;
		this.loadRuntime = options.loadRuntime ?? loadVoiceRuntime;
		this.readVoicePack = options.readVoicePack ?? readVoicePackFromDisk;
	}

	/** The voices this install can actually speak with, for the picker. */
	listVoices(): Array<{ id: string; name: string }> {
		return [{ id: BUNDLED_VOICE.id, name: BUNDLED_VOICE.name }];
	}

	speak(text: string, options: TtsSpeakOptions): AsyncIterable<TtsChunk> {
		// The run is claimed here, not in the generator body: a generator does not
		// start until its first `next()`, and a second `speak()` must supersede the
		// first immediately.
		return this.stream(splitIntoSpokenSentences(text), ++this.run, options);
	}

	cancel(): void {
		this.run += 1;
	}

	/** Release the session. Called when the pipeline is torn down or swapped. */
	async dispose(): Promise<void> {
		this.cancel();
		const session = this.session;
		this.session = null;
		this.voicePack = null;
		this.loading = null;
		try {
			await session?.release?.();
		} catch {
			// A session that will not close must not wedge a provider swap.
		}
	}

	// -- Internals -----------------------------------------------------------

	private async *stream(
		sentences: string[],
		run: number,
		options: TtsSpeakOptions
	): AsyncGenerator<TtsChunk> {
		if (sentences.length === 0) return;
		await this.ensureLoaded();
		if (this.run !== run) return;

		for (let index = 0; index < sentences.length; index++) {
			if (this.run !== run) return;

			const audio = await this.synthesize(sentences[index], options.rate, run);
			// Re-checked after the inference: a barge-in during synthesis must not
			// deliver the sentence it interrupted.
			if (this.run !== run) return;
			// Nothing speakable in it (a line of emoji, say). Not an error.
			if (!audio) continue;

			yield {
				utteranceId: options.utteranceId,
				index,
				text: sentences[index],
				format: 'pcm16',
				audio,
				sampleRate: KOKORO_SAMPLE_RATE,
			};
		}
	}

	private async ensureLoaded(): Promise<void> {
		if (this.session) return;
		this.loading ??= this.load();
		try {
			await this.loading;
		} finally {
			this.loading = null;
		}
	}

	private async load(): Promise<void> {
		if (!this.phonemize) {
			try {
				const frontEnd = await createKokoroFrontEnd({
					tokenizerPath: this.tokenizerPathOverride ?? modelFilePath(KOKORO_82M_ID, TOKENIZER_FILE),
				});
				this.phonemize = frontEnd.phonemize;
				this.boundaries = frontEnd.vocab;
			} catch (error) {
				throw new VoiceProviderError(
					`The Kokoro voice could not load its phoneme front end. Re-verify the model in ${modelsSettingsLocation('library')}, or switch Text-to-Speech to the system voice.`,
					{ kind: 'unavailable', providerId: this.id, cause: error }
				);
			}
		}

		const module = await this.loadRuntime<OnnxModule>('onnx', this.id);
		const modelPath = this.modelPathOverride ?? modelFilePath(KOKORO_82M_ID, MODEL_FILE);
		const voicePath =
			this.voicePackPathOverride ?? modelFilePath(KOKORO_82M_ID, BUNDLED_VOICE.file);

		try {
			this.session = await module.InferenceSession.create(modelPath);
			this.tensorFactory = module.Tensor;
			this.voicePack = await this.readVoicePack(voicePath);
		} catch (error) {
			this.session = null;
			throw new VoiceProviderError(
				`The Kokoro voice could not be opened. Re-verify it in ${modelsSettingsLocation('library')}.`,
				{ kind: 'unavailable', providerId: this.id, cause: error }
			);
		}
	}

	/**
	 * One sentence to PCM, or null when it has nothing speakable in it or the run
	 * was cancelled part way through a long one.
	 */
	private async synthesize(
		sentence: string,
		rate: number | undefined,
		run: number
	): Promise<Uint8Array | null> {
		const session = this.session;
		const Tensor = this.tensorFactory;
		const voicePack = this.voicePack;
		if (!session || !Tensor || !voicePack || !this.phonemize) {
			throw new VoiceProviderError('The local voice is not loaded.', {
				kind: 'unavailable',
				providerId: this.id,
			});
		}

		const tokens = await this.phonemize(sentence);
		if (tokens.length === 0) return null;
		const speed = Math.min(MAX_SPEED, Math.max(MIN_SPEED, rate && rate > 0 ? rate : 1));

		const pieces: Float32Array[] = [];
		for (const piece of splitTokenRuns(tokens, this.boundaries)) {
			// A long sentence is several inferences; a barge-in stops between them.
			if (this.run !== run) return null;
			const outputs = await session.run({
				// The leading and trailing zero are Kokoro's sequence boundary tokens.
				// Without them the first phoneme is clipped and the last is held.
				input_ids: new Tensor('int64', BigInt64Array.from([0n, ...piece.map(BigInt), 0n]), [
					1,
					piece.length + 2,
				]),
				// The style row is picked by the length of THIS run, not the sentence.
				style: new Tensor('float32', styleVectorFor(voicePack, piece.length), [
					1,
					STYLE_VECTOR_WIDTH,
				]),
				speed: new Tensor('float32', Float32Array.from([speed]), [1]),
			});

			const waveform = Object.values(outputs)[0]?.data;
			if (!(waveform instanceof Float32Array)) {
				throw new VoiceProviderError('The local voice produced no audio for that sentence.', {
					kind: 'unavailable',
					providerId: this.id,
				});
			}
			pieces.push(waveform);
		}

		const pcm = float32ToInt16(pieces.length === 1 ? pieces[0] : concatFloat32(pieces));
		return new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
	}
}

function concatFloat32(pieces: readonly Float32Array[]): Float32Array {
	const out = new Float32Array(pieces.reduce((total, piece) => total + piece.length, 0));
	let offset = 0;
	for (const piece of pieces) {
		out.set(piece, offset);
		offset += piece.length;
	}
	return out;
}

// ---------------------------------------------------------------------------

/**
 * The style row for a phoneme sequence of this length.
 *
 * Clamped rather than trusted: a sentence longer than the pack has rows for would
 * read past the end of the buffer and produce a vector of whatever followed it in
 * memory, which comes out as a burst of noise at full volume in someone's
 * headphones.
 */
export function styleVectorFor(pack: Float32Array, tokenCount: number): Float32Array {
	const rows = Math.max(1, Math.floor(pack.length / STYLE_VECTOR_WIDTH));
	const row = Math.min(rows - 1, Math.max(0, tokenCount));
	const offset = row * STYLE_VECTOR_WIDTH;
	return pack.slice(offset, offset + STYLE_VECTOR_WIDTH);
}

/** Read a Kokoro voice pack: a flat little-endian float32 table. */
async function readVoicePackFromDisk(path: string): Promise<Float32Array> {
	const { readFile } = await import('fs/promises');
	const buffer = await readFile(path);
	return new Float32Array(
		buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
	);
}
